;; Title: yield
;;
;; What this contract does:
;; This is the drip scheduler for sBTC rewards. Instead of dumping all
;; rewards into the system at once (which would let someone flash-mint
;; jSTX right before distribution and steal yield), rewards are released
;; gradually across a PoX cycle via ~30 "drips".
;;
;; The flow:
;; 1. sBTC rewards arrive (from signer pool rewards being collected)
;; 2. The commission cut is taken first (per-pool rate from registry)
;; 3. Pool operator gets their share of the commission immediately
;; 4. Remaining commission goes to commission.clar (treasury)
;; 5. Net rewards are stored per-cycle in this contract
;; 6. The drip contract calls drip() every ~70 blocks
;; 7. Each drip() releases a proportional slice to share.distribute-rewards()
;; 8. share.clar updates the global reward index
;;
;; This contract handles sBTC rewards only (no STX reward path).
;;
;; Inspired by: StackingDAO rewards-v5.clar
;; Source: stacking-dao/contracts/version-3/rewards-v5.clar

(use-trait commission-trait .commission-trait.commission-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u9001))
(define-constant ERR_NOTHING_TO_DRIP (err u9002))
(define-constant ERR_ALREADY_FLUSHED (err u9003))
(define-constant BPS u10000)

;; Approximate blocks per PoX cycle (~2100 on mainnet)
(define-constant BLOCKS_PER_CYCLE u2100)
;; How many drips per cycle (one every ~70 blocks)
(define-constant DRIPS_PER_CYCLE u30)

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Per-cycle reward bucket
(define-map reward-bucket uint
  {
    total-sbtc: uint,        ;; total sBTC added for this cycle (after commission)
    distributed-sbtc: uint,  ;; how much has been dripped out so far
    commission-sbtc: uint,   ;; commission portion (for tracking)
    drips-done: uint         ;; how many drips have been executed
  }
)

;; Which cycle we're currently dripping from
(define-data-var active-cycle uint u0)

;; ---------------------------------------------------------
;; Receive rewards from a pool (called by keeper/bot after collecting from signers)
;; ---------------------------------------------------------

;; When sBTC rewards come in from a signer pool, this function:
;; 1. Looks up the pool's commission rate from the registry
;; 2. Calculates the pool operator's cut (if any)
;; 3. Sends pool operator their cut immediately
;; 4. Stores commission for later processing
;; 5. Stores net rewards for drip distribution
(define-public (receive-rewards (pool principal) (sbtc-amount uint) (cycle uint))
  (let (
    ;; Look up this pool's commission rate from the registry
    (fee-rate (contract-call? .registry get-signer-fee pool))
    (commission-amount (/ (* sbtc-amount fee-rate) BPS))
    (net-rewards (- sbtc-amount commission-amount))

    ;; Look up pool operator's cut of the commission
    (owner-cut (contract-call? .registry get-operator-cut pool))
    (owner-amount (/ (* commission-amount (get share owner-cut)) BPS))
    (protocol-commission (- commission-amount owner-amount))

    ;; Get existing cycle data
    (existing (default-to
      { total-sbtc: u0, distributed-sbtc: u0, commission-sbtc: u0, drips-done: u0 }
      (map-get? reward-bucket cycle)
    ))
  )
    (try! (contract-call? .dao guard-protocol))

    ;; Transfer sBTC from caller into this contract
    (try! (contract-call? .sbtc-mock transfer sbtc-amount tx-sender (as-contract tx-sender) none))

    ;; Pay pool operator their cut immediately (if any)
    (if (> owner-amount u0)
      (try! (as-contract (contract-call? .sbtc-mock transfer owner-amount tx-sender (get receiver owner-cut) none)))
      true
    )

    ;; Store net rewards + commission for this cycle
    (map-set reward-bucket cycle {
      total-sbtc: (+ (get total-sbtc existing) net-rewards),
      distributed-sbtc: (get distributed-sbtc existing),
      commission-sbtc: (+ (get commission-sbtc existing) protocol-commission),
      drips-done: (get drips-done existing)
    })

    (print {
      action: "receive-rewards",
      pool: pool,
      cycle: cycle,
      gross: sbtc-amount,
      commission: commission-amount,
      owner-cut: owner-amount,
      net: net-rewards
    })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Drip: release a slice of rewards to jSTX holders
;; ---------------------------------------------------------

;; Called by the drip contract (keeper trigger). Releases one slice of
;; the current cycle's rewards into the share contract.
(define-public (drip (cycle uint))
  (let (
    (bucket (unwrap! (map-get? reward-bucket cycle) ERR_NOTHING_TO_DRIP))
    (total (get total-sbtc bucket))
    (distributed (get distributed-sbtc bucket))
    (remaining (- total distributed))
    (drips-done (get drips-done bucket))
    (drips-left (- DRIPS_PER_CYCLE drips-done))
    ;; Release proportional slice: remaining / drips_left
    ;; On the last drip, this equals the entire remaining amount
    (slice (if (> drips-left u0)
      (/ remaining drips-left)
      u0
    ))
  )
    (try! (contract-call? .dao guard-protocol))
    (asserts! (> slice u0) ERR_NOTHING_TO_DRIP)

    ;; Send slice to the share contract for distribution
    (try! (as-contract (contract-call? .share distribute-rewards slice)))

    ;; Update cycle bucket
    (map-set reward-bucket cycle {
      total-sbtc: total,
      distributed-sbtc: (+ distributed slice),
      commission-sbtc: (get commission-sbtc bucket),
      drips-done: (+ drips-done u1)
    })

    (print { action: "drip", cycle: cycle, slice: slice, drips-done: (+ drips-done u1) })
    (ok slice)
  )
)

;; ---------------------------------------------------------
;; Flush commission: send protocol commission to commission contract
;; ---------------------------------------------------------

(define-public (flush-commission (cycle uint) (commission-contract <commission-trait>))
  (let (
    (bucket (unwrap! (map-get? reward-bucket cycle) ERR_NOTHING_TO_DRIP))
    (commission-amount (get commission-sbtc bucket))
  )
    (try! (contract-call? .dao guard-protocol))
    (asserts! (> commission-amount u0) ERR_NOTHING_TO_DRIP)

    ;; Send to commission contract for splitting
    (try! (as-contract (contract-call? commission-contract process commission-amount)))

    ;; Zero out commission so it can't be flushed twice
    (map-set reward-bucket cycle (merge bucket { commission-sbtc: u0 }))

    (print { action: "flush-commission", cycle: cycle, amount: commission-amount })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

(define-read-only (get-reward-bucket (cycle uint))
  (map-get? reward-bucket cycle)
)

(define-read-only (get-active-cycle)
  (var-get active-cycle)
)
