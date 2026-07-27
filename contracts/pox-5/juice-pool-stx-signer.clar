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
(define-constant ERR_CYCLE_UNPAID (err u104))
(define-constant ERR_NO_DUST      (err u105))
(define-constant ERR_CYCLE_NOT_ENDED (err u106))
(define-constant ERR_PAYOUT_STARTED  (err u107))
(define-constant ERR_REWARDS_NOT_COMPUTED (err u108))

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
      num-indexes: num-indexes, amount-ustx: amount-ustx, amount-sats: amount-sats, is-bond: is-bond })
    (ok true)
  )
)

;; -----------------------------------------------------------------------------
;; Signer registration (one-time)
;; -----------------------------------------------------------------------------

;; Requires a prior (contract-call? 'SP000000000000000000002Q6VF78.pox-5 grant-signer-key ...) sent by the
;; signer key's own principal -- 4.0.1 restricts grant-signer-key to the signer
;; itself, so the grant cannot be front-run.
;;
;; pox-5 asserts (is-eq contract-caller signer), and signer is derived as
;; (contract-of signer-manager). So signer-manager MUST be this contract, and
;; this contract must be the direct caller. No as-contract needed.
(define-public (pox-register-signer
    (signer-manager <signer-mgr>)
    (signer-key (buff 33))
  )
  (begin
    (try! (assert-admin))
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
;; PERMISSIONLESS, made safe by the two asserts rather than by an admin. The
;; hazard being closed: claiming twice for one cycle with a payout run in
;; between. The pot would grow after some stakers were already marked paid, so
;; the second tranche would be split among the remainder only -- same shares,
;; bigger slice, and whoever was paid first silently loses out.
;;
;;   1. the cycle must be over
;;   2. pox-5 must have run its FINAL distribution for that cycle
;;   3. no payout may have started, so the pot is final before it is divided
;;
;; (2) is the subtle one. A distribution cycle is HALF a reward cycle, and
;; calculate-rewards credits the cycle containing (start of the current
;; distribution cycle - 1). So cycle N is credited twice: at its midpoint, and
;; again at the START OF CYCLE N+1 -- after N has ended. "The cycle is over" is
;; therefore NOT enough to know the pot is final. The last computation for N
;; lands at burn height (start of N+1) - 1, so that is what we wait for.
;;
;; calculate-rewards is permissionless and must be called each half cycle by
;; someone. If nobody has, this assert fails and the fix is to call it.
;;
;; With both in place a cycle's pot is frozen before the first sat goes out,
;; and nobody has to be trusted to call this in the right order. An absent
;; operator can no longer stall the pool either.
(define-public (pox-claim-rewards
    (bond-periods (list 6 uint))
    (reward-cycle uint)
  )
  (begin
    (asserts! (< reward-cycle (contract-call? POX5 current-pox-reward-cycle))
      ERR_CYCLE_NOT_ENDED)
    (asserts!
      (>= (contract-call? POX5 get-last-reward-compute-height)
          (- (contract-call? POX5 reward-cycle-to-burn-height (+ reward-cycle u1)) u1))
      ERR_REWARDS_NOT_COMPUTED)
    (asserts! (is-eq (get-cycle-paid-shares reward-cycle) u0) ERR_PAYOUT_STARTED)
    (let (
        (current-reward (get-stx-pot reward-cycle))
        (result (try! (contract-call? POX5 claim-rewards bond-periods reward-cycle)))
        (claimed (get total-rewards result))
        (new-pot (+ current-reward claimed))
      )
      (if (> claimed u0)
        (map-set stx-pot reward-cycle new-pot)
        true)
      (print { topic: "claim-rewards", reward-cycle: reward-cycle,
        claimed: claimed, pot: new-pot })
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
;;   PAID is ours. pox-5's get-earned-staker-rewards only decreases when the
;;   staker is settled, so a distributor that treats it as "amount to pay now"
;;   while skipping settlement WILL pay twice. We therefore never read it here;
;;   the stx-paid map is the sole record of what has gone out.
;;
;; Payout is a pure function of (pot, staker shares, signer shares), and each
;; (cycle, staker) can be paid exactly once.

;; sBTC booked for STX-only stakers, per cycle.
(define-map stx-pot uint uint)

;; Marks a (cycle, staker) as paid, and how much.
(define-map stx-paid { reward-cycle: uint, staker: principal } uint)

;; Running totals PER REWARD CYCLE, so dust can be identified without
;; enumerating stakers. cycle-paid-shares is the completeness proof: once it
;; reaches the signer's total shares FOR THAT CYCLE, every staker of that cycle
;; has been paid, and whatever is left of THAT CYCLE'S pot is rounding residue.
;;
;; Note the contract holds ONE commingled sBTC balance across all cycles; only
;; the accounting is per cycle. That is safe because every amount paid or swept
;; is computed from a single cycle's numbers, so cycle N can never reach into
;; cycle N+1's unpaid pot.
(define-map cycle-paid uint uint)
(define-map cycle-paid-shares uint uint)

(define-read-only (get-stx-pot (reward-cycle uint))
  (default-to u0 (map-get? stx-pot reward-cycle)))

(define-read-only (get-stx-paid (reward-cycle uint) (staker principal))
  (map-get? stx-paid { reward-cycle: reward-cycle, staker: staker }))

(define-read-only (get-cycle-paid (reward-cycle uint))
  (default-to u0 (map-get? cycle-paid reward-cycle)))

(define-read-only (get-cycle-paid-shares (reward-cycle uint))
  (default-to u0 (map-get? cycle-paid-shares reward-cycle)))

;; Total shares pox-5 credits to this signer for a cycle. Equals the sum of all
;; staker shares, so it is the target cycle-paid-shares must reach.
(define-read-only (get-cycle-total-shares (reward-cycle uint))
  (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-signer-shares-staked-for-cycle
    current-contract reward-cycle none))

;; Sats left in a cycle's pot. Only pure dust once every staker is paid.
(define-read-only (get-cycle-residue (reward-cycle uint))
  (- (get-stx-pot reward-cycle) (get-cycle-paid reward-cycle)))

;; True when every staker of the cycle has been paid.
(define-read-only (is-cycle-fully-paid (reward-cycle uint))
  (>= (get-cycle-paid-shares reward-cycle) (get-cycle-total-shares reward-cycle)))

;; A staker's cut of a cycle's pot: pot * staker-shares / signer-shares.
;; bond-index is none for the STX-only slice. Returns u0 once paid.
(define-read-only (get-stx-owed (reward-cycle uint) (staker principal))
  (let (
      (signer current-contract)
      (total (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-signer-shares-staked-for-cycle
        signer reward-cycle none))
      (shares (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-staker-shares-staked-for-cycle
        staker reward-cycle none signer))
    )
    (if (or (is-eq total u0)
            (is-some (map-get? stx-paid { reward-cycle: reward-cycle, staker: staker })))
      u0
      (/ (* (get-stx-pot reward-cycle) shares) total))
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
    (acc { reward-cycle: uint, pot: uint, total-shares: uint, total: uint })
  )
  (let (
      (cycle (get reward-cycle acc))
      (shares (contract-call? POX5 get-staker-shares-staked-for-cycle
        staker cycle none current-contract))
      (owed (if (is-eq (get total-shares acc) u0)
              u0
              (/ (* (get pot acc) shares) (get total-shares acc))))
    )
    ;; Skip on ALREADY PAID, not on owed = u0. A staker can hold shares whose
    ;; cut truncates to zero sats; they still have to be counted in
    ;; cycle-paid-shares or the completeness check can never be satisfied and
    ;; the dust is stranded forever. Recording them costs one map write and
    ;; settles their claim at the zero they are actually owed.
    (if (or (is-some (map-get? stx-paid { reward-cycle: cycle, staker: staker }))
            (is-eq shares u0))
      acc
      (begin
        ;; Guarded as-contract: the allowance caps this frame at exactly `owed`
        ;; sats of sBTC, so a bug here cannot drain the pot. Any failure aborts
        ;; the whole batch, which is what we want -- the ledger and the transfers
        ;; must never disagree.
        (if (> owed u0)
          (unwrap-panic (as-contract? ((with-ft SBTC "sbtc-token" owed))
            (unwrap-panic (contract-call? SBTC transfer owed current-contract staker none))))
          true)
        (map-set stx-paid { reward-cycle: cycle, staker: staker } owed)
        (map-set cycle-paid cycle (+ (get-cycle-paid cycle) owed))
        (map-set cycle-paid-shares cycle (+ (get-cycle-paid-shares cycle) shares))
        (merge acc { total: (+ (get total acc) owed) })))
  )
)

;; Pay up to 100 STX-only stakers their cut of a cycle's pot, in one tx.
;; Already-paid stakers are skipped, so re-running with an overlapping list is
;; safe. Permissionless: the split is fixed by pox-5 shares, so anyone may pay
;; the gas to push rewards out.
(define-public (pay-stx-stakers
    (stakers (list 100 principal))
    (reward-cycle uint)
  )
  (let (
      (result (fold pay-one stakers {
        reward-cycle: reward-cycle,
        pot: (get-stx-pot reward-cycle),
        total-shares: (get-cycle-total-shares reward-cycle),
        total: u0,
      }))
      (totl (get total result))
    )
    (print { topic: "pay-stx-stakers", reward-cycle: reward-cycle,
      count: (len stakers), total: totl })
    (ok totl)
  )
)

;; Sweep ONE cycle's leftover sats to the admin. Bounded by that cycle's own
;; residue, never the contract's whole sBTC balance.
;;
;; Safe only once every staker has been paid, which is why cycle-paid-shares
;; exists: pot minus paid is NOT dust while stakers are still owed, it is their
;; money. The assert below is the guard -- shares are compared rather than a
;; staker count because pox-5 exposes no enumerable staker list.
;;
;; >= not = : defensive margin, not a known case. Both share-mutating paths in
;; pox-5 (unstake, stake-update) operate from (current-cycle + 1) onward, so a
;; CLOSED cycle's total is immutable and equality would hold exactly. But
;; cycle-paid-shares is summed across many separate transactions, and if any
;; path ever did decrement a closed cycle, strict equality would strand that
;; cycle's residue permanently -- there is no recovery function. >= costs
;; nothing and can still only be reached by paying every staker.
(define-public (sweep-cycle-dust (reward-cycle uint))
  (let ((dust (get-cycle-residue reward-cycle)))
    (try! (assert-admin))
    (asserts! (is-cycle-fully-paid reward-cycle) ERR_CYCLE_UNPAID)
    (asserts! (> dust u0) ERR_NO_DUST)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" dust))
      (try! (contract-call? SBTC transfer dust current-contract
        (var-get admin) none))))
    (map-set cycle-paid reward-cycle (+ (get-cycle-paid reward-cycle) dust))
    (print { topic: "sweep-cycle-dust", reward-cycle: reward-cycle, dust: dust })
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
