;; DRAFT: new Juice signer, native STX payouts and fees; one vault batch at a time.
;; Existing staking, OG exemptions, fee delay, shares and tranche accounting retained.
(use-trait signer-mgr 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)
(impl-trait 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)

(define-constant ERR_NOT_RECOVERED (err u116))
(define-constant ERR_SWAP_PENDING (err u115))
(define-constant ERR_NO_PENDING_ADMIN (err u117))

(define-data-var pending-swap (optional { reward-cycle: uint, tranche: uint }) none)
(define-map finalized-tranches { reward-cycle: uint, tranche: uint } bool)

(use-trait swap-vault-interface .juice-swap-vault-trait.swap-vault-trait)

(define-constant SWAP_VAULT_COOLDOWN u4032)
(define-constant ERR_NO_PENDING_SWAP_VAULT (err u118))
(define-constant ERR_INVALID_SWAP_VAULT (err u119))
(define-constant ERR_SWAP_VAULT_BUSY (err u120))

(define-data-var swap-vault principal .juice-pool-swap-vault)
(define-data-var pending-swap-vault (optional principal) none)
(define-data-var pending-swap-vault-height uint u0)
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
(define-constant MAX_FEE_BIPS u500)
(define-constant ADMIN_COOLDOWN u144)

(define-data-var admin  principal tx-sender)
(define-data-var pending-admin (optional principal) none)
(define-data-var pending-admin-height uint u0)
(define-data-var paused bool false)

(define-read-only (get-admin) (var-get admin))
(define-read-only (is-paused) (var-get paused))

(define-private (assert-admin)
  (ok (asserts! (is-eq contract-caller (var-get admin)) ERR_UNAUTHORIZED)))

(define-read-only (get-pending-admin)
  { admin: (var-get pending-admin),
    proposed-at: (var-get pending-admin-height),
    executable-at: (+ (var-get pending-admin-height) ADMIN_COOLDOWN) })

(define-public (propose-admin (new-admin principal))
  (begin
    (try! (assert-admin))
    (var-set pending-admin (some new-admin))
    (var-set pending-admin-height burn-block-height)
    (print { topic: "propose-admin", current: (var-get admin), proposed: new-admin,
      executable-at: (+ burn-block-height ADMIN_COOLDOWN) })
    (ok new-admin)))

(define-public (accept-admin)
  (let ((new-admin (unwrap! (var-get pending-admin) ERR_NO_PENDING_ADMIN)))
    (asserts! (is-eq contract-caller new-admin) ERR_UNAUTHORIZED)
    (asserts! (>= burn-block-height (+ (var-get pending-admin-height) ADMIN_COOLDOWN))
      ERR_COOLDOWN)
    (print { topic: "accept-admin", old-admin: (var-get admin), new-admin: new-admin })
    (var-set admin new-admin)
    (var-set pending-admin none)
    (var-set pending-admin-height u0)
    (ok true)))

(define-public (cancel-admin-proposal)
  (begin
    (try! (assert-admin))
    (print { topic: "cancel-admin-proposal", cancelled: (var-get pending-admin) })
    (var-set pending-admin none)
    (var-set pending-admin-height u0)
    (ok true)))


;; Four-week notice; finish/recover the old batch before switching destinations.
(define-read-only (get-swap-vault)
  (var-get swap-vault)
)

(define-read-only (get-pending-swap-vault)
  {
    vault: (var-get pending-swap-vault),
    proposed-at: (var-get pending-swap-vault-height),
    executable-at: (+ (var-get pending-swap-vault-height) SWAP_VAULT_COOLDOWN),
  }
)

(define-private (assert-active-vault (vault <swap-vault-interface>))
  (ok (asserts! (is-eq (contract-of vault) (var-get swap-vault))
    ERR_INVALID_SWAP_VAULT
  ))
)

;; Donations cannot block rotation; active batches and positions still do.
(define-private (assert-idle-vault (vault <swap-vault-interface>))
  (let ((status (try! (contract-call? vault get-upgrade-status))))
    (asserts! (is-eq (get pool status) current-contract) ERR_INVALID_SWAP_VAULT)
    (asserts! (and
      (is-none (get batch-start status))
      (is-eq (get jing-resting status) u0)
      (is-eq (get jing-parked status) u0)) ERR_SWAP_VAULT_BUSY)
    (ok true)))

(define-public (propose-swap-vault (new-vault <swap-vault-interface>))
  (begin
    (try! (assert-admin))
    (asserts! (not (is-eq (contract-of new-vault) (var-get swap-vault)))
      ERR_INVALID_SWAP_VAULT
    )
    (try! (assert-idle-vault new-vault))
    (var-set pending-swap-vault (some (contract-of new-vault)))
    (var-set pending-swap-vault-height burn-block-height)
    (print {
      topic: "propose-swap-vault",
      current: (var-get swap-vault),
      proposed: (contract-of new-vault),
      executable-at: (+ burn-block-height SWAP_VAULT_COOLDOWN),
    })
    (ok (contract-of new-vault))
  )
)

(define-public (cancel-swap-vault-proposal)
  (begin
    (try! (assert-admin))
    (print {
      topic: "cancel-swap-vault-proposal",
      cancelled: (var-get pending-swap-vault),
    })
    (var-set pending-swap-vault none)
    (var-set pending-swap-vault-height u0)
    (ok true)
  )
)

(define-public (confirm-swap-vault
    (old-vault <swap-vault-interface>)
    (new-vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-admin))
    (let ((proposed (unwrap! (var-get pending-swap-vault) ERR_NO_PENDING_SWAP_VAULT)))
      (try! (assert-active-vault old-vault))
      (asserts! (is-eq (contract-of new-vault) proposed) ERR_INVALID_SWAP_VAULT)
      (asserts!
        (>= burn-block-height
          (+ (var-get pending-swap-vault-height) SWAP_VAULT_COOLDOWN)
        )
        ERR_COOLDOWN
      )
      (asserts! (is-none (var-get pending-swap)) ERR_SWAP_PENDING)
      (try! (assert-idle-vault old-vault))
      (try! (assert-idle-vault new-vault))
      (var-set swap-vault proposed)
      (var-set pending-swap-vault none)
      (var-set pending-swap-vault-height u0)
      (print {
        topic: "confirm-swap-vault",
        old-vault: (contract-of old-vault),
        new-vault: proposed,
      })
      (ok proposed)
    )
  )
)

(define-public (set-paused (p bool))
  (begin
    (try! (assert-admin))
    (var-set paused p)
    (print { topic: "set-paused", paused: p })
    (ok true)))

(define-data-var fee-bips uint u0)
(define-data-var earned-fees uint u0)

(define-map og-stakers principal bool)

(define-read-only (get-fee-bips) (var-get fee-bips))
(define-read-only (get-earned-fees) (var-get earned-fees))

(define-read-only (is-og (staker principal))
  (default-to false (map-get? og-stakers staker)))

(define-read-only (get-effective-fee-bips (staker principal))
  (if (is-og staker) u0 (var-get fee-bips)))

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

(define-public (cancel-fee-bips)
  (begin
    (try! (assert-admin))
    (print { topic: "cancel-fee-bips", cancelled: (var-get pending-fee) })
    (ok (var-set pending-fee none))))

(define-public (set-og (staker principal) (og bool))
  (begin
    (try! (assert-admin))
    (if og (map-set og-stakers staker true) (map-delete og-stakers staker))
    (print { topic: "set-og", staker: staker, og: og })
    (ok og)))

(define-private (do-withdraw-fees (amount uint) (recipient principal))
  (let ((available (var-get earned-fees)))
    (asserts! (<= amount available) ERR_INSUFFICIENT_FEES)
    (try! (as-contract? ((with-stx amount))
      (try! (stx-transfer? amount current-contract recipient))))
    (var-set earned-fees (- available amount))
    (print { topic: "withdraw-fees", amount: amount, recipient: recipient })
    (ok amount)))

(define-public (withdraw-fees (amount uint) (recipient principal))
  (begin (try! (assert-admin)) (do-withdraw-fees amount recipient)))

(define-public (withdraw-all-fees (recipient principal))
  (begin (try! (assert-admin)) (do-withdraw-fees (var-get earned-fees) recipient)))

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
    (let ((result (try! (contract-call? POX5 register-signer signer-manager signer-key))))
      (print { topic: "register-self", signer-manager: (contract-of signer-manager),
        signer-key: signer-key, auth-id: auth-id })
      (ok result))
  )
)

(define-public (pox-claim-rewards
    (bond-periods (list 6 uint))
    (reward-cycle uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (let (
        (trn (get-tranche-count reward-cycle))
        (dist (contract-call? POX5 current-distribution-cycle))
        (last-dist (map-get? last-claim-dist-cycle reward-cycle))
      )
      (asserts! (match last-dist
        l (> dist l)
        true
      )
        ERR_TRANCHE_TOO_SOON
      )
      (let (
          (result (try! (contract-call? POX5 claim-rewards bond-periods reward-cycle)))
          (claimed (get total-rewards result))
        )
        (asserts! (> claimed u0) ERR_NO_NEW_REWARDS)
        (asserts! (is-none (var-get pending-swap)) ERR_SWAP_PENDING)
        (try! (as-contract? ((with-ft SBTC "sbtc-token" claimed))
          (try! (contract-call? vault fund claimed))
        ))
        (var-set pending-swap
          (some {
            reward-cycle: reward-cycle,
            tranche: trn,
          })
        )
        (map-set tranche-count reward-cycle (+ trn u1))
        (map-set last-claim-dist-cycle reward-cycle dist)
        (print {
          topic: "claim-rewards",
          reward-cycle: reward-cycle,
          tranche: trn,
          claimed: claimed,
          dist-cycle: dist,
          fee-bips: (var-get fee-bips),
        })
        (ok result)
      )
    )
  )
)

(define-map stx-pot { reward-cycle: uint, tranche: uint } uint)

(define-map tranche-count uint uint)

(define-map last-claim-dist-cycle uint uint)

(define-read-only (get-last-claim-dist-cycle (reward-cycle uint))
  (map-get? last-claim-dist-cycle reward-cycle))

(define-map stx-paid { reward-cycle: uint, tranche: uint, staker: principal } uint)

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

(define-read-only (get-cycle-total-shares (reward-cycle uint))
  (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-signer-shares-staked-for-cycle
    current-contract reward-cycle none))

(define-read-only (get-tranche-residue (reward-cycle uint) (tranche uint))
  (- (get-stx-pot reward-cycle tranche) (get-tranche-paid reward-cycle tranche)))

(define-read-only (is-tranche-fully-paid (reward-cycle uint) (tranche uint))
  (>= (get-tranche-paid-shares reward-cycle tranche)
      (get-cycle-total-shares reward-cycle)))

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
      (let (
          (gross (/ (* (get-stx-pot reward-cycle tranche) shares) total))
          (fee (if (is-og staker)
                 u0
                 (/ (* gross (var-get fee-bips)) MAX_BIPS)))
        )
        (- gross fee)))
  )
)

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
      (owed (if (is-eq (get total-shares acc) u0)
              u0
              (/ (* (get pot acc) shares) (get total-shares acc))))
      (fee (if (is-og staker) u0 (/ (* owed (get fee acc)) MAX_BIPS)))
      (net (- owed fee))
    )
    (if (or (is-some (map-get? stx-paid
              { reward-cycle: cycle, tranche: trn, staker: staker }))
            (is-eq shares u0))
      acc
      (begin
        (if (> net u0)
          (unwrap-panic (as-contract? ((with-stx net))
            (unwrap-panic (stx-transfer? net current-contract staker))))
          true)
        (if (> fee u0) (var-set earned-fees (+ (var-get earned-fees) fee)) true)
        (map-set stx-paid { reward-cycle: cycle, tranche: trn, staker: staker } net)
        (map-set tranche-paid { reward-cycle: cycle, tranche: trn }
          (+ (get-tranche-paid cycle trn) owed))
        (map-set tranche-paid-shares { reward-cycle: cycle, tranche: trn }
          (+ (get-tranche-paid-shares cycle trn) shares))
        (merge acc { total: (+ (get total acc) net),
                     fees: (+ (get fees acc) fee) })))
  )
)

(define-public (pay-stx-stakers
    (stakers (list 100 principal))
    (reward-cycle uint)
    (tranche uint)
  )
  (begin
    (asserts! (default-to false (map-get? finalized-tranches
      { reward-cycle: reward-cycle, tranche: tranche })) ERR_SWAP_PENDING)
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
)

(define-public (sweep-tranche-dust (reward-cycle uint) (tranche uint))
  (let ((dust (get-tranche-residue reward-cycle tranche)))
    (try! (assert-admin))
    (asserts! (default-to false (map-get? finalized-tranches { reward-cycle: reward-cycle, tranche: tranche })) ERR_SWAP_PENDING)
    (asserts! (is-tranche-fully-paid reward-cycle tranche) ERR_TRANCHE_UNPAID)
    (asserts! (> dust u0) ERR_NO_DUST)
    (try! (as-contract? ((with-stx dust))
      (try! (stx-transfer? dust current-contract (var-get admin)))))
    (map-set tranche-paid { reward-cycle: reward-cycle, tranche: tranche }
      (+ (get-tranche-paid reward-cycle tranche) dust))
    (print { topic: "sweep-tranche-dust", reward-cycle: reward-cycle,
      tranche: tranche, dust: dust })
    (ok dust)
  )
)

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

(define-read-only (get-unclaimed-signer-rewards
    (reward-cycle uint)
    (bond-index (optional uint))
  )
  (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-signer-unclaimed-rewards-for-cycle
    current-contract reward-cycle bond-index))

(define-read-only (get-staker-entitlement
    (staker principal)
    (reward-cycle uint)
    (bond-index (optional uint))
  )
  (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-earned-staker-rewards
    current-contract reward-cycle bond-index staker))

;; Added swap-vault integration and emergency recovery.

(define-public (finalize-swap (vault <swap-vault-interface>))
  (begin
    (try! (assert-active-vault vault))
    (let (
        (batch (unwrap! (var-get pending-swap) ERR_SWAP_PENDING))
        (amount (try! (contract-call? vault finish)))
      )
      (map-set stx-pot batch amount)
      (map-set finalized-tranches batch true)
      (var-set pending-swap none)
      (print {
        topic: "finalize-swap",
        reward-cycle: (get reward-cycle batch),
        tranche: (get tranche batch),
        amount: amount,
      })
      (ok amount)
    )
  )
)

;; Emergency accounting is separate from the normal swap route. STX uses the
;; existing ledger; the remaining sBTC has its own payout, fee and dust ledgers.
(define-map recovered-sbtc-pot { reward-cycle: uint, tranche: uint } uint)
(define-map recovered-sbtc-paid { reward-cycle: uint, tranche: uint, staker: principal } uint)
(define-map recovered-sbtc-tranche-paid { reward-cycle: uint, tranche: uint } uint)
(define-map recovered-sbtc-paid-shares { reward-cycle: uint, tranche: uint } uint)
(define-data-var earned-sbtc-fees uint u0)

(define-read-only (is-recovered-tranche (reward-cycle uint) (tranche uint))
  (is-some (map-get? recovered-sbtc-pot { reward-cycle: reward-cycle, tranche: tranche })))

(define-read-only (get-recovered-sbtc-pot (reward-cycle uint) (tranche uint))
  (default-to u0 (map-get? recovered-sbtc-pot { reward-cycle: reward-cycle, tranche: tranche })))

(define-read-only (get-recovered-sbtc-paid (reward-cycle uint) (tranche uint) (staker principal))
  (map-get? recovered-sbtc-paid { reward-cycle: reward-cycle, tranche: tranche, staker: staker }))

(define-read-only (get-recovered-sbtc-residue (reward-cycle uint) (tranche uint))
  (- (get-recovered-sbtc-pot reward-cycle tranche)
     (default-to u0 (map-get? recovered-sbtc-tranche-paid
       { reward-cycle: reward-cycle, tranche: tranche }))))

(define-read-only (get-recovered-sbtc-paid-shares (reward-cycle uint) (tranche uint))
  (default-to u0 (map-get? recovered-sbtc-paid-shares
    { reward-cycle: reward-cycle, tranche: tranche })))

(define-read-only (is-recovered-tranche-fully-paid (reward-cycle uint) (tranche uint))
  (>= (get-recovered-sbtc-paid-shares reward-cycle tranche)
      (get-cycle-total-shares reward-cycle)))

(define-read-only (get-earned-sbtc-fees) (var-get earned-sbtc-fees))

;; Returning funds and crediting exactly the pending tranche happen atomically.
;; Normal finalize and recovery consume the same pending-swap, preventing reuse.
(define-public (emergency-recover (vault <swap-vault-interface>))
  (begin
    (try! (assert-active-vault vault))
    (begin
      (try! (assert-admin))
      (let (
          (batch (unwrap! (var-get pending-swap) ERR_SWAP_PENDING))
          (recovered (try! (contract-call? vault emergency-recover)))
        )
        (map-set stx-pot batch (get stx recovered))
        (map-set recovered-sbtc-pot batch (get sbtc recovered))
        (map-set finalized-tranches batch true)
        (var-set pending-swap none)
        (print {
          topic: "emergency-recover",
          batch: batch,
          recovered: recovered,
        })
        (ok recovered)
      )
    )
  )
)

(define-private (pay-recovered-sbtc-one
    (staker principal)
    (acc { reward-cycle: uint, tranche: uint, pot: uint, total-shares: uint,
           fee: uint, total: uint, fees: uint }))
  (let ((cycle (get reward-cycle acc))
        (trn (get tranche acc))
        (shares (contract-call? POX5 get-staker-shares-staked-for-cycle
          staker cycle none current-contract))
        (owed (if (is-eq (get total-shares acc) u0) u0
          (/ (* (get pot acc) shares) (get total-shares acc))))
        (fee (if (is-og staker) u0 (/ (* owed (get fee acc)) MAX_BIPS)))
        (net (- owed fee))
        (batch { reward-cycle: cycle, tranche: trn }))
    (if (or (is-eq shares u0) (is-some (map-get? recovered-sbtc-paid
          { reward-cycle: cycle, tranche: trn, staker: staker })))
      acc
      (begin
        (if (> net u0)
          (unwrap-panic (as-contract? ((with-ft SBTC "sbtc-token" net))
            (unwrap-panic (contract-call? SBTC transfer net current-contract staker none))))
          true)
        (var-set earned-sbtc-fees (+ (var-get earned-sbtc-fees) fee))
        (map-set recovered-sbtc-paid { reward-cycle: cycle, tranche: trn, staker: staker } net)
        (map-set recovered-sbtc-tranche-paid batch
          (+ (default-to u0 (map-get? recovered-sbtc-tranche-paid batch)) owed))
        (map-set recovered-sbtc-paid-shares batch
          (+ (default-to u0 (map-get? recovered-sbtc-paid-shares batch)) shares))
        (merge acc { total: (+ (get total acc) net), fees: (+ (get fees acc) fee) })))))

;; Recovered STX uses pay-stx-stakers; this entry point pays only remaining sBTC.
(define-public (pay-recovered-sbtc-stakers
    (stakers (list 100 principal))
    (reward-cycle uint)
    (tranche uint)
  )
  (begin
    (asserts! (is-recovered-tranche reward-cycle tranche) ERR_NOT_RECOVERED)
    (let (
        (result (fold pay-recovered-sbtc-one stakers {
          reward-cycle: reward-cycle,
          tranche: tranche,
          pot: (get-recovered-sbtc-pot reward-cycle tranche),
          total-shares: (get-cycle-total-shares reward-cycle),
          fee: (var-get fee-bips),
          total: u0,
          fees: u0,
        }))
        (totl (get total result))
      )
      (print { topic: "pay-recovered-sbtc-stakers", reward-cycle: reward-cycle, tranche: tranche,
        count: (len stakers), total: totl, fees: (get fees result) })
      (ok totl)
    )
  )
)

;; Native STX dust and fees keep their existing withdrawal entry points.
(define-public (sweep-recovered-sbtc-dust (reward-cycle uint) (tranche uint))
  (let ((batch { reward-cycle: reward-cycle, tranche: tranche })
        (dust (get-recovered-sbtc-residue reward-cycle tranche)))
    (try! (assert-admin))
    (asserts! (is-recovered-tranche reward-cycle tranche) ERR_NOT_RECOVERED)
    (asserts! (is-recovered-tranche-fully-paid reward-cycle tranche) ERR_TRANCHE_UNPAID)
    (asserts! (> dust u0) ERR_NO_DUST)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" dust))
      (try! (contract-call? SBTC transfer dust current-contract (var-get admin) none))))
    (map-set recovered-sbtc-tranche-paid batch
      (+ (default-to u0 (map-get? recovered-sbtc-tranche-paid batch)) dust))
    (print { topic: "sweep-recovered-sbtc-dust", reward-cycle: reward-cycle,
      tranche: tranche, dust: dust })
    (ok dust)))

(define-public (withdraw-sbtc-fees (amount uint) (recipient principal))
  (begin
    (try! (assert-admin))
    (asserts! (<= amount (var-get earned-sbtc-fees)) ERR_INSUFFICIENT_FEES)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? SBTC transfer amount current-contract recipient none))))
    (var-set earned-sbtc-fees (- (var-get earned-sbtc-fees) amount))
    (print { topic: "withdraw-sbtc-fees", amount: amount, recipient: recipient })
    (ok amount)))

(define-public (refloor-vault
    (update (buff 8192))
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (begin
      (try! (assert-admin))
      (contract-call? vault jing-refloor update)
    )
  )
)

;; Bounded vault settings: vault trusts this pool; pool checks its admin.
(define-public (set-vault-window-blocks
    (blocks uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (begin
      (try! (assert-admin))
      (contract-call? vault set-window-blocks blocks)
    )
  )
)

(define-public (set-vault-leeway-bps
    (bps uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (begin
      (try! (assert-admin))
      (contract-call? vault set-leeway-bps bps)
    )
  )
)

(define-public (set-vault-slippage-bps
    (bps uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (begin
      (try! (assert-admin))
      (contract-call? vault set-slippage-bps bps)
    )
  )
)

(define-public (set-vault-max-chunk-sats
    (sats uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (begin
      (try! (assert-admin))
      (contract-call? vault set-max-chunk-sats sats)
    )
  )
)

(define-public (set-vault-dia-band-bps
    (bps uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (begin
      (try! (assert-admin))
      (contract-call? vault set-dia-band-bps bps)
    )
  )
)

(define-public (set-vault-router-cooldown
    (blocks uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (begin
      (try! (assert-admin))
      (contract-call? vault set-router-cooldown blocks)
    )
  )
)

(define-public (jing-take
    (amount uint)
    (update (buff 8192))
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (begin
      (try! (assert-admin))
      (contract-call? vault jing-take amount update)
    )
  )
)

(define-public (router-swap-split
    (amount uint)
    (jing uint)
    (dlmm uint)
    (xyk uint)
    (velar uint)
    (update (buff 8192))
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (begin
      (try! (assert-admin))
      (contract-call? vault router-swap-split amount jing dlmm xyk velar update)
    )
  )
)

(define-read-only (get-pending-swap) (var-get pending-swap))

(define-public (set-vault-no-pyth-slippage-bps
    (bps uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (begin
      (try! (assert-admin))
      (contract-call? vault set-no-pyth-slippage-bps bps)
    )
  )
)

(define-public (router-swap-split-dia
    (amount uint)
    (dlmm uint)
    (xyk uint)
    (velar uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (begin
      (try! (assert-admin))
      (contract-call? vault router-swap-split-dia amount dlmm xyk velar)
    )
  )
)
