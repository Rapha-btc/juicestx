;; title: juice-pool-stx-signer
;; version: 0.3 (retargeted to shipped pox-5, stacks-core 4.0.1)
;; summary: A plain STX-only PoX-5 staking pool. This contract IS the signer.
;;   Users self-stake against it, it collects the cycle's sBTC rewards, and it
;;   pays them out pro-rata. No jSTX, no jBTC, no bonds, no liquid token.
;; description:
;;   Shape (cycle 141 onward):
;;     - Users call pox-5.stake themselves, passing THIS contract as the
;;       signer-manager. Their STX locks in their own wallet -- the pool never
;;       custodies anything. pox-5 has no delegation, so this is the closest
;;       equivalent to the old juice-pool-v0 and is strictly less trusted.
;;     - validate-stake! is the admission gate: pox-5 calls back into this
;;       contract on every stake, and an err reverts the user's transaction.
;;     - Rewards are sBTC, paid to the SIGNER as one lump, never to stakers
;;       directly. Splitting that lump is this contract's job.
;;
;;   Bonds are out of scope. They do not exist until cycle 142, and the jBTC
;;   bond path lives in juice-signer-manager.clar instead. claim-rewards still
;;   takes a bond-periods argument because pox-5 requires it; pass an empty
;;   list and the bond slice is always zero here.
;;
;;   Written against shipped pox-5 (stacks-core 4.0.1): the trait has exactly
;;   one function (validate-stake!), register-signer gates on contract-caller,
;;   and get-earned no longer exists.
;;
;;   !! validate-stake! is still permissive (admit-all, pausable). Anyone can
;;   point a stake at this signer until that gate is written.

(use-trait signer-mgr 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)
(impl-trait 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)

(define-constant POX5 'SP000000000000000000002Q6VF78.pox-5)
(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

(define-constant ERR_UNAUTHORIZED (err u100))
(define-constant ERR_PAUSED       (err u101))
(define-constant ERR_NOT_POX5     (err u102))
(define-constant ERR_SETTLE_FAILED (err u103))
(define-constant ERR_TRANCHE_UNPAID (err u104))
(define-constant ERR_NO_DUST      (err u105))
(define-constant ERR_NO_NEW_REWARDS (err u109))
(define-constant ERR_INVALID_FEE (err u110))
(define-constant ERR_INSUFFICIENT_FEES (err u111))
(define-constant ERR_TRANCHE_TOO_SOON (err u112))
(define-constant ERR_NO_PENDING_FEE (err u113))
(define-constant ERR_COOLDOWN (err u114))

(define-constant MAX_BIPS u10000)
;; Hard ceiling on what the admin can ever set, checked in propose-fee-bips. The
;; admin is trusted to run the pool, not to be able to take all of it.
(define-constant MAX_FEE_BIPS u2000)

(define-data-var admin  principal tx-sender)
(define-data-var paused bool false)

;; -----------------------------------------------------------------------------
;; Admin
;; -----------------------------------------------------------------------------

(define-read-only (get-admin) (var-get admin))
(define-read-only (is-paused) (var-get paused))

(define-private (assert-admin)
  (ok (asserts! (is-eq contract-caller (var-get admin)) ERR_UNAUTHORIZED)))

(define-public (set-admin (new-admin principal))
  (begin (try! (assert-admin)) (ok (var-set admin new-admin))))

(define-public (set-paused (p bool))
  (begin (try! (assert-admin)) (ok (var-set paused p))))

;; -----------------------------------------------------------------------------
;; Fees
;; -----------------------------------------------------------------------------
;;
;; Standard rate in basis points, taken from each staker's gross cut at payout.
;; OGs are exempt. Both are readable on-chain so a staker can verify their own
;; rate rather than taking our word for it.
;;
;; NOTHING IS SNAPSHOT PER TRANCHE -- both the rate and OG membership are read
;; live at payout. So a fee change, or adding/removing an OG, applies to any
;; tranche not yet paid out, including ones already opened.
;;
;; That is deliberate. Snapshotting would cost a map write per tranche (rate) or
;; per staker per tranche (membership), purely to defend against an operator who
;; already holds the admin key and could pause the pool anyway. The protection
;; that IS worth having is visibility: propose-fee-bips makes a rate change
;; public a day before it can take effect.
;;
;; Fees accumulate as earned-fees and stay in this contract's sBTC balance until
;; withdrawn. They are NOT part of any tranche pot: pay-one books the full gross
;; against the tranche and diverts the fee slice, so pot minus paid stays an
;; honest measure of what is still owed and the dust sweep can never reach fees.

(define-data-var fee-bips uint u0)
(define-data-var earned-fees uint u0)

;; Fee-exempt stakers. Absent = not an OG = pays the standard rate.
(define-map og-stakers principal bool)

(define-read-only (get-fee-bips) (var-get fee-bips))
(define-read-only (get-earned-fees) (var-get earned-fees))

(define-read-only (is-og (staker principal))
  (default-to false (map-get? og-stakers staker)))

;; What a given staker is charged right now.
(define-read-only (get-effective-fee-bips (staker principal))
  (if (is-og staker) u0 (var-get fee-bips)))

;; Fee changes are two-step with a 144-burn-block (~1 day) cooldown. Since the
;; rate is read live at payout, a change would otherwise apply instantly to
;; money already claimed but not yet distributed. The cooldown makes any raise
;; public for a day first, so stakers can react instead of discovering it when
;; their payout lands.
(define-constant FEE_COOLDOWN u144)

(define-data-var pending-fee (optional uint) none)
(define-data-var pending-fee-height uint u0)

(define-read-only (get-pending-fee)
  { fee: (var-get pending-fee),
    proposed-at: (var-get pending-fee-height),
    executable-at: (+ (var-get pending-fee-height) FEE_COOLDOWN) })

(define-public (propose-fee-bips (new-fee uint))
  (begin
    (try! (assert-admin))
    (asserts! (<= new-fee MAX_FEE_BIPS) ERR_INVALID_FEE)
    (var-set pending-fee (some new-fee))
    (var-set pending-fee-height burn-block-height)
    (print { topic: "propose-fee-bips", current: (var-get fee-bips), proposed: new-fee,
      executable-at: (+ burn-block-height FEE_COOLDOWN) })
    (ok new-fee)))

(define-public (confirm-fee-bips)
  (let ((new-fee (unwrap! (var-get pending-fee) ERR_NO_PENDING_FEE)))
    (try! (assert-admin))
    (asserts! (>= burn-block-height (+ (var-get pending-fee-height) FEE_COOLDOWN))
      ERR_COOLDOWN)
    (print { topic: "confirm-fee-bips", old: (var-get fee-bips), new: new-fee })
    (var-set pending-fee none)
    (ok (var-set fee-bips new-fee))))

;; Abandon a proposed change without waiting it out.
(define-public (cancel-fee-bips)
  (begin
    (try! (assert-admin))
    (print { topic: "cancel-fee-bips", cancelled: (var-get pending-fee) })
    (ok (var-set pending-fee none))))

;; Add or remove an OG. Printed so the list is reconstructible from events as
;; well as readable by is-og.
(define-public (set-og (staker principal) (og bool))
  (begin
    (try! (assert-admin))
    (if og (map-set og-stakers staker true) (map-delete og-stakers staker))
    (print { topic: "set-og", staker: staker, og: og })
    (ok og)))

;; Bounded by earned-fees, so this can never reach into stakers' unpaid pots
;; even though both live in one commingled sBTC balance.
(define-private (do-withdraw-fees (amount uint) (recipient principal))
  (let ((available (var-get earned-fees)))
    (asserts! (<= amount available) ERR_INSUFFICIENT_FEES)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? SBTC transfer amount current-contract recipient none))))
    (var-set earned-fees (- available amount))
    (print { topic: "withdraw-fees", amount: amount, recipient: recipient })
    (ok amount)))

(define-public (withdraw-fees (amount uint) (recipient principal))
  (begin (try! (assert-admin)) (do-withdraw-fees amount recipient)))

;; Drain whatever has accrued, without having to read the balance first. Reading
;; earned-fees and then passing it back in races any payout that lands in
;; between: the read would be stale and the withdrawal would leave a remainder,
;; or overshoot and fail. Taking the amount from the var inside the same
;; transaction cannot be stale.
(define-public (withdraw-all-fees (recipient principal))
  (begin (try! (assert-admin)) (do-withdraw-fees (var-get earned-fees) recipient)))

;; -----------------------------------------------------------------------------
;; signer-manager-trait -- the single callback invoked BY pox-5
;; -----------------------------------------------------------------------------

;; Admission gate. pox-5 register-for-bond / stake / stake-update revert if this
;; returns err. pox-5 wraps the call in its own reentrancy guard, so this must
;; not call back into pox-5.
(define-public (validate-stake!
    (staker principal)
    (first-index uint)
    (num-indexes uint)
    (amount-ustx uint)
    (amount-sats uint)
    (is-bond bool)
    (signer-calldata (optional (buff 500)))
  )
  (begin
    (asserts! (is-eq contract-caller POX5) ERR_NOT_POX5)
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (print { topic: "validate-stake", staker: staker, first-index: first-index,
      num-indexes: num-indexes, amount-ustx: amount-ustx, amount-sats: amount-sats, is-bond: is-bond, signer-calldata: signer-calldata })
    (ok true)
  )
)

;; -----------------------------------------------------------------------------
;; Signer registration
;; -----------------------------------------------------------------------------

;; Grant the key to this contract AND register, in one transaction.
;;
;; This exists because grant-signer-key CANNOT be sent by the signer key's own
;; principal, contrary to what the note here used to claim. pox-5 asserts
;; (is-eq contract-caller signer-manager) on the grant, so only THIS contract
;; can make that call -- an EOA cannot, whoever holds the key. Without this
;; function register-signer below can never pass verify-signer-key-grant, and
;; the signer can never be registered at all.
;;
;; signer-sig is a 65-byte secp256k1 signature over
;;   (get-signer-grant-message-hash signer-manager auth-id)
;; produced off-chain by the signer key's PRIVATE key. pox-5 recovers it and
;; requires the recovered pubkey to equal signer-key, so the grant cannot be
;; forged or front-run by anyone who lacks the key.
;;
;; auth-id makes each GRANT single-use: (signer-key, signer-manager, auth-id) is
;; recorded in used-signer-key-grants and a repeat is rejected. That is per
;; grant, not per registration -- this function is NOT one-shot.
;;
;; KEY ROTATION. pox-5's register-signer ends in (map-set signers signer
;; signer-key), a map-set and not a map-insert, and nothing here guards against
;; a second call. So calling register-self again with a NEW signer-key, a fresh
;; auth-id, and a signature from the new key rotates this pool's signer key.
;; That path matters precisely when it is least convenient to discover: pox-5
;; requires contract-caller to be the signer contract, so no EOA can register or
;; rotate on our behalf, and this function is the only route to it.
;;
;; signer-manager MUST be this contract -- pox-5 derives the signer as
;; (contract-of signer-manager) for the registration and compares the grant
;; against it. No as-contract: both calls must see this contract as the direct
;; caller.
(define-public (register-self
    (signer-manager <signer-mgr>)
    (signer-key (buff 33))
    (auth-id uint)
    (signer-sig (buff 65))
  )
  (begin
    (try! (assert-admin))
    (try! (contract-call? POX5 grant-signer-key signer-key current-contract
      auth-id signer-sig))
    (contract-call? POX5 register-signer signer-manager signer-key)
  )
)


;; -----------------------------------------------------------------------------
;; Claim + route rewards
;; -----------------------------------------------------------------------------

;; Pull this signer's sBTC rewards for a cycle and book them as the cycle's
;; distributable pot. NOT wrapped in as-contract: pox-5 pays whoever is
;; contract-caller, so this contract must be the direct caller and the sBTC
;; lands here.
;;
;; Pass an empty bond-periods list. This pool has no bonds, so the bond slice
;; is zero; it is still added to the pot rather than dropped, so a stray sat
;; can never be stranded in the contract.
;;
;; PERMISSIONLESS and callable AS SOON AS REWARDS EXIST -- there is no longer
;; any wait for the cycle to end.
;;
;; The hazard this used to guard: claiming twice for one cycle with a payout run
;; in between. The pot grew after some stakers were marked paid, so the later
;; money was split among the remainder only -- same shares, bigger slice, and
;; whoever was paid first silently lost out. The old fix was to refuse to claim
;; until pox-5 had run its FINAL computation for the cycle (which lands at the
;; START of cycle N+1, since a distribution cycle is half a reward cycle), and
;; to refuse once any payout had begun.
;;
;; That made a cycle's pot provably final, at the cost of paying out only once
;; every ~2 weeks.
;;
;; Tranches get the same guarantee weekly. Each claim writes its own tranche
;; holding exactly the sats it received, and a written tranche is never revisited
;; -- so every tranche is final the moment it exists, and the dilution above
;; cannot occur no matter how many times this is called or when. Both the
;; cycle-ended and rewards-computed asserts are therefore gone: claiming early
;; simply books a smaller first tranche, and the next claim books the rest.
;;
;; calculate-rewards is permissionless and must be called each half cycle by
;; someone before there is anything to claim. If nobody has, claimed is u0 and
;; this returns ERR_NO_NEW_REWARDS; the fix is to call it.
(define-public (pox-claim-rewards
    (bond-periods (list 6 uint))
    (reward-cycle uint)
  )
  (let (
      (trn (get-tranche-count reward-cycle))
      (dist (contract-call? POX5 current-distribution-cycle))
      (last-dist (map-get? last-claim-dist-cycle reward-cycle))
    )
    ;; ONE TRANCHE PER DISTRIBUTION CYCLE. Dropping the old cycle-ended and
    ;; rewards-computed gates is what allows weekly payouts, but it also left
    ;; this callable at any moment by anyone -- and rewards trickle in, so a
    ;; griefer could open dozens of dust tranches. Each tranche costs a full
    ;; payout pass over every staker to reach is-tranche-fully-paid, plus its own
    ;; dust sweep, so that multiplies operating cost for the price of gas.
    ;;
    ;; pox-5 computes rewards once per distribution cycle, so at most one
    ;; tranche per distribution cycle loses nothing: a reward cycle spans two of
    ;; them, which is exactly the two tranches weekly payouts need.
    (asserts! (match last-dist l (> dist l) true) ERR_TRANCHE_TOO_SOON)
    (let (
      (result (try! (contract-call? POX5 claim-rewards bond-periods reward-cycle)))
      (claimed (get total-rewards result))
    )
    ;; Nothing new to book. Do not open an empty tranche -- an empty tranche can
    ;; never satisfy is-tranche-fully-paid without someone folding every staker
    ;; through it for zero sats, so it would be permanent bookkeeping noise.
    (asserts! (> claimed u0) ERR_NO_NEW_REWARDS)
    ;; Open a NEW tranche holding exactly what this claim received. Never add to
    ;; an existing tranche: that is the dilution the old ERR_PAYOUT_STARTED
    ;; guard existed to prevent, and it is now structurally impossible because a
    ;; written tranche is never revisited.
    (map-set stx-pot { reward-cycle: reward-cycle, tranche: trn } claimed)
    (map-set tranche-count reward-cycle (+ trn u1))
    ;; Written only after the claim succeeds, so a failed claim does not burn
    ;; this cycle's slot and block a legitimate retry.
    (map-set last-claim-dist-cycle reward-cycle dist)
    (print { topic: "claim-rewards", reward-cycle: reward-cycle,
      tranche: trn, claimed: claimed, dist-cycle: dist,
      fee-bips: (var-get fee-bips) })
    (ok result)
    )
  )
)

;; -----------------------------------------------------------------------------
;; STX-only distribution
;; -----------------------------------------------------------------------------
;;
;; Accounting split, chosen deliberately (see pox-settle-stakers below):
;;
;;   SHARES come from pox-5. staker-shares-staked-for-cycle is keyed per cycle
;;   and is fixed before the cycle starts, so reading it is safe and always
;;   authoritative. We never duplicate that math.
;;
;;   PAID is ours. Paying a staker does NOT lower pox-5's
;;   get-earned-staker-rewards -- only settling them does. So if we paid off that
;;   number without settling, the same staker would read as still owed and get
;;   paid again. We never read it here. stx-paid is the only record of what has
;;   gone out.
;;
;; Payout is a pure function of (pot, staker shares, signer shares), and each
;; (cycle, staker) can be paid exactly once.

;; TRANCHES -- why the pot is keyed by (cycle, tranche) and not by cycle.
;;
;; pox-5 computes rewards once per DISTRIBUTION cycle, which is exactly half a
;; reward cycle (distribution-cycle-to-burn-height multiplies by
;; pox-reward-cycle-length / 2), i.e. about one week. A reward cycle is
;; therefore credited twice: at its midpoint and again at the start of the next
;; cycle.
;;
;; The old shape had ONE pot per reward cycle and refused to claim until the
;; final computation had landed, because a pot that grows after some stakers are
;; paid dilutes them: same shares, bigger slice, and whoever was paid first
;; silently loses out. That is what ERR_PAYOUT_STARTED guarded.
;;
;; A tranche closes that hazard without waiting. Each claim opens a NEW tranche
;; holding exactly the sats that claim received, and a tranche's pot is final the
;; instant it is written -- a later claim cannot touch it, it opens the next
;; tranche instead. So the "pot must be final before it is divided" invariant is
;; preserved per tranche rather than per cycle, and payouts can go out weekly.
;;
;; The share denominator is unchanged and still read per REWARD cycle: pox-5
;; fixes staker and signer shares before the cycle starts, so both tranches of a
;; cycle divide by the same total. That is what makes this safe -- a tranche is
;; a slice of money, never a slice of shares.

;; sBTC booked for STX-only stakers, per (cycle, tranche).
(define-map stx-pot { reward-cycle: uint, tranche: uint } uint)

;; How many tranches have been opened for a reward cycle. Next claim writes
;; tranche index (get-tranche-count cycle).
(define-map tranche-count uint uint)

;; pox-5 distribution cycle in which this reward cycle's last tranche was
;; opened. Enforces at most one tranche per distribution cycle -- see the note
;; in pox-claim-rewards.
(define-map last-claim-dist-cycle uint uint)

(define-read-only (get-last-claim-dist-cycle (reward-cycle uint))
  (map-get? last-claim-dist-cycle reward-cycle))

;; Marks a (cycle, tranche, staker) as paid, and how much.
(define-map stx-paid { reward-cycle: uint, tranche: uint, staker: principal } uint)

;; Running totals PER REWARD CYCLE, so dust can be identified without
;; enumerating stakers. tranche-paid-shares is the completeness proof: once it
;; reaches the signer's total shares FOR THAT CYCLE, every staker of that cycle
;; has been paid, and whatever is left of THAT CYCLE'S pot is rounding residue.
;;
;; Note the contract holds ONE commingled sBTC balance across all cycles; only
;; the accounting is per cycle. That is safe because every amount paid or swept
;; is computed from a single cycle's numbers, so cycle N can never reach into
;; cycle N+1's unpaid pot.
(define-map tranche-paid { reward-cycle: uint, tranche: uint } uint)
(define-map tranche-paid-shares { reward-cycle: uint, tranche: uint } uint)

(define-read-only (get-tranche-count (reward-cycle uint))
  (default-to u0 (map-get? tranche-count reward-cycle)))

(define-read-only (get-stx-pot (reward-cycle uint) (tranche uint))
  (default-to u0 (map-get? stx-pot { reward-cycle: reward-cycle, tranche: tranche })))

(define-read-only (get-stx-paid (reward-cycle uint) (tranche uint) (staker principal))
  (map-get? stx-paid { reward-cycle: reward-cycle, tranche: tranche, staker: staker }))

(define-read-only (get-tranche-paid (reward-cycle uint) (tranche uint))
  (default-to u0 (map-get? tranche-paid { reward-cycle: reward-cycle, tranche: tranche })))

(define-read-only (get-tranche-paid-shares (reward-cycle uint) (tranche uint))
  (default-to u0 (map-get? tranche-paid-shares { reward-cycle: reward-cycle, tranche: tranche })))

;; Total shares pox-5 credits to this signer for a cycle. Equals the sum of all
;; staker shares, so it is the target tranche-paid-shares must reach.
(define-read-only (get-cycle-total-shares (reward-cycle uint))
  (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-signer-shares-staked-for-cycle
    current-contract reward-cycle none))

;; Sats left in a tranche. Only pure dust once every staker is paid.
(define-read-only (get-tranche-residue (reward-cycle uint) (tranche uint))
  (- (get-stx-pot reward-cycle tranche) (get-tranche-paid reward-cycle tranche)))

;; True when every staker has been paid for this TRANCHE. The denominator is
;; still the cycle's total shares -- shares are per cycle, tranches only split
;; the money -- so each tranche is proved complete independently.
(define-read-only (is-tranche-fully-paid (reward-cycle uint) (tranche uint))
  (>= (get-tranche-paid-shares reward-cycle tranche)
      (get-cycle-total-shares reward-cycle)))

;; A staker's cut of ONE tranche: tranche-pot * staker-shares / signer-shares.
;; bond-index is none for the STX-only slice. Returns u0 once paid.
(define-read-only (get-stx-owed (reward-cycle uint) (tranche uint) (staker principal))
  (let (
      (signer current-contract)
      (total (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-signer-shares-staked-for-cycle
        signer reward-cycle none))
      (shares (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-staker-shares-staked-for-cycle
        staker reward-cycle none signer))
    )
    (if (or (is-eq total u0)
            (is-some (map-get? stx-paid
              { reward-cycle: reward-cycle, tranche: tranche, staker: staker })))
      u0
      ;; NET of fee, so the UI shows what will actually arrive rather than a
      ;; gross figure the staker never receives.
      (let (
          (gross (/ (* (get-stx-pot reward-cycle tranche) shares) total))
          (fee (if (is-og staker)
                 u0
                 (/ (* gross (var-get fee-bips)) MAX_BIPS)))
        )
        (- gross fee)))
  )
)

;; NOTE ON COST: every contract-call? into pox-5 is charged for loading pox-5
;; itself, and pox-5 is ~136 KB of source. That read_length dominates this loop,
;; so the number of CALLS per staker matters far more than the arithmetic.
;;
;; The naive shape read three times per staker: signer-shares and staker-shares
;; inside get-stx-owed, then staker-shares again here. This reads ONCE per
;; staker, with the cycle's total shares and pot hoisted into the accumulator
;; and read a single time for the whole batch. That is N+1 calls instead of 3N.
;;
;; get-stx-owed is kept as the read-only for the UI; it is not used here.
(define-private (pay-one
    (staker principal)
    (acc { reward-cycle: uint, tranche: uint, pot: uint, total-shares: uint,
           fee: uint, total: uint, fees: uint })
  )
  (let (
      (cycle (get reward-cycle acc))
      (trn (get tranche acc))
      (shares (contract-call? POX5 get-staker-shares-staked-for-cycle
        staker cycle none current-contract))
      ;; GROSS: the staker's slice of the tranche, before fee.
      (owed (if (is-eq (get total-shares acc) u0)
              u0
              (/ (* (get pot acc) shares) (get total-shares acc))))
      ;; OGs pay nothing. Everyone else pays the rate frozen for this tranche,
      ;; hoisted into the accumulator so it is read once per batch not per staker.
      (fee (if (is-og staker) u0 (/ (* owed (get fee acc)) MAX_BIPS)))
      ;; NET: what actually leaves for the staker.
      (net (- owed fee))
    )
    ;; Skip on ALREADY PAID, not on owed = u0. A staker can hold shares whose
    ;; cut truncates to zero sats; they still have to be counted in
    ;; tranche-paid-shares or the completeness check can never be satisfied and
    ;; the dust is stranded forever. Recording them costs one map write and
    ;; settles their claim at the zero they are actually owed.
    (if (or (is-some (map-get? stx-paid
              { reward-cycle: cycle, tranche: trn, staker: staker }))
            (is-eq shares u0))
      acc
      (begin
        ;; Guarded as-contract: the allowance caps this frame at exactly `net`
        ;; sats of sBTC, so a bug here cannot drain the pot. Any failure aborts
        ;; the whole batch, which is what we want -- the ledger and the transfers
        ;; must never disagree. The fee slice is never transferred: it simply
        ;; stays in this contract and is booked to earned-fees below.
        (if (> net u0)
          (unwrap-panic (as-contract? ((with-ft SBTC "sbtc-token" net))
            (unwrap-panic (contract-call? SBTC transfer net current-contract staker none))))
          true)
        (if (> fee u0) (var-set earned-fees (+ (var-get earned-fees) fee)) true)
        ;; stx-paid records NET -- what the staker actually received.
        (map-set stx-paid { reward-cycle: cycle, tranche: trn, staker: staker } net)
        ;; tranche-paid records GROSS. It measures what has LEFT THE POT, and the
        ;; fee left the pot too (into earned-fees). Booking net here would leave
        ;; the fee looking like unpaid staker money, and the dust sweep would
        ;; then hand it out a second time.
        (map-set tranche-paid { reward-cycle: cycle, tranche: trn }
          (+ (get-tranche-paid cycle trn) owed))
        (map-set tranche-paid-shares { reward-cycle: cycle, tranche: trn }
          (+ (get-tranche-paid-shares cycle trn) shares))
        (merge acc { total: (+ (get total acc) net),
                     fees: (+ (get fees acc) fee) })))
  )
)

;; Pay up to 100 STX-only stakers their cut of a cycle's pot, in one tx.
;; Already-paid stakers are skipped, so re-running with an overlapping list is
;; safe. Permissionless: the split is fixed by pox-5 shares, so anyone may pay
;; the gas to push rewards out.
(define-public (pay-stx-stakers
    (stakers (list 100 principal))
    (reward-cycle uint)
    (tranche uint)
  )
  (let (
      (result (fold pay-one stakers {
        reward-cycle: reward-cycle,
        tranche: tranche,
        pot: (get-stx-pot reward-cycle tranche),
        total-shares: (get-cycle-total-shares reward-cycle),
        fee: (var-get fee-bips),
        total: u0,
        fees: u0,
      }))
      (totl (get total result))
    )
    (print { topic: "pay-stx-stakers", reward-cycle: reward-cycle, tranche: tranche,
      count: (len stakers), total: totl, fees: (get fees result) })
    (ok totl)
  )
)

;; Sweep ONE cycle's leftover sats to the admin. Bounded by that cycle's own
;; residue, never the contract's whole sBTC balance.
;;
;; Safe only once every staker has been paid, which is why tranche-paid-shares
;; exists: pot minus paid is NOT dust while stakers are still owed, it is their
;; money. The assert below is the guard -- shares are compared rather than a
;; staker count because pox-5 exposes no enumerable staker list.
;;
;; >= not = : defensive margin, not a known case. Both share-mutating paths in
;; pox-5 (unstake, stake-update) operate from (current-cycle + 1) onward, so a
;; CLOSED cycle's total is immutable and equality would hold exactly. But
;; tranche-paid-shares is summed across many separate transactions, and if any
;; path ever did decrement a closed cycle, strict equality would strand that
;; cycle's residue permanently -- there is no recovery function. >= costs
;; nothing and can still only be reached by paying every staker.
(define-public (sweep-tranche-dust (reward-cycle uint) (tranche uint))
  (let ((dust (get-tranche-residue reward-cycle tranche)))
    (try! (assert-admin))
    (asserts! (is-tranche-fully-paid reward-cycle tranche) ERR_TRANCHE_UNPAID)
    (asserts! (> dust u0) ERR_NO_DUST)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" dust))
      (try! (contract-call? SBTC transfer dust current-contract
        (var-get admin) none))))
    (map-set tranche-paid { reward-cycle: reward-cycle, tranche: tranche }
      (+ (get-tranche-paid reward-cycle tranche) dust))
    (print { topic: "sweep-tranche-dust", reward-cycle: reward-cycle,
      tranche: tranche, dust: dust })
    (ok dust)
  )
)

;; -----------------------------------------------------------------------------
;; Per-staker settlement (batched)
;; -----------------------------------------------------------------------------
;;
;; pox-5 keeps a per-staker ledger (staker-unclaimed-rewards-for-cycle and the
;; staker's rewards-per-token snapshot). claim-rewards above moves the WHOLE
;; cycle pot to this contract in one transfer but cannot zero those per-staker
;; rows: that would mean writing one row per staker, and Clarity cannot iterate
;; an unbounded map. Only claim-staker-rewards-for-signer, named per staker,
;; clears them -- and it moves no funds, it is pure bookkeeping.
;;
;; Skipping it is safe for money flow (pox-5 never pays a staker directly, and
;; pox-5 self-settles a staker before any share mutation) but leaves pox-5's
;; public read-onlys reporting paid users as unclaimed. This fold keeps the
;; books honest at one transaction per batch rather than one per staker.
;;
;; Cost is block budget, not transaction count. The list bound below (100) is a
;; starting point, NOT a measured limit -- measure before relying on it.
(define-private (settle-one
    (staker principal)
    (acc { reward-cycle: uint, bond-index: (optional uint), total: uint, failed: bool })
  )
  (match (contract-call? POX5 claim-staker-rewards-for-signer
            staker (get reward-cycle acc) (get bond-index acc))
    ok-info (merge acc { total: (+ (get total acc) (get earned ok-info)) })
    err-code (merge acc { failed: true })
  )
)

;; Settle up to 100 stakers in a single transaction. Direct call,
;; not as-contract: pox-5 keys the settlement on contract-caller, which must be
;; this signer. Returns the total sBTC entitlement settled across the batch.
;;
;; Permissionless on purpose: it moves no funds and only brings pox-5's view
;; forward, so anyone may pay to keep the books current.
(define-public (pox-settle-stakers
    (stakers (list 100 principal))
    (reward-cycle uint)
    (bond-index (optional uint))
  )
  (let (
      (result (fold settle-one stakers
        { reward-cycle: reward-cycle, bond-index: bond-index, total: u0, failed: false }))
      (totl (get total result))
    )
    (asserts! (not (get failed result)) ERR_SETTLE_FAILED)
    (print { topic: "settle-stakers", reward-cycle: reward-cycle,
      bond-index: bond-index, count: (len stakers), total: totl })
    (ok totl)
  )
)

;; -----------------------------------------------------------------------------
;; Read-only
;; -----------------------------------------------------------------------------

;; sBTC this signer has accrued for a cycle and not yet pulled via claim-rewards.
;; bond-index none = the STX-only slice; (some i) = bond period i.
(define-read-only (get-unclaimed-signer-rewards
    (reward-cycle uint)
    (bond-index (optional uint))
  )
  (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-signer-unclaimed-rewards-for-cycle
    current-contract reward-cycle bond-index))

;; What pox-5 currently believes a given staker under this signer is owed.
;; Non-zero after payout means the staker has not been settled -- see the note
;; above pox-settle-stakers.
(define-read-only (get-staker-entitlement
    (staker principal)
    (reward-cycle uint)
    (bond-index (optional uint))
  )
  (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-earned-staker-rewards
    current-contract reward-cycle bond-index staker))
