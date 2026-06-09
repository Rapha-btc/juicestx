;; Title: jbtc-yield
;;
;; jBTC reward + distribution engine (pox-5). Same vesting/drip + settle design
;; as yield.clar, but FED differently:
;;   pox-4 jSTX: keeper sweep-stacker -> release-rewards pulls sBTC from stackers
;;   pox-5 jBTC: juice-signer-manager claims bond rewards (sBTC) and forwards the
;;               jBTC slice here via record-rewards (sBTC already transferred in)
;;
;; Distribution is unchanged: net rewards accumulate in a per-cycle bucket and
;; vest linearly over VESTING_BLOCKS. On any settle (transfer/mint/burn/claim)
;; the vested amount is applied to the global index -- no keeper for payout.
;; Anti-flash-mint: rewards vest by time, and settle snapshots the wallet first.
;;
;; Data layer: jbtc-share-data.clar (separate index/state from jSTX).
;;
;; !! SCAFFOLD -- built to compile + test against the WIP pox-5 source.

(use-trait commission-trait .commission-trait.commission-trait)
(use-trait position-trait .position-trait.position-trait)


(define-constant ERR_UNAUTHORIZED   (err u9001))
(define-constant ERR_NOTHING_TO_VEST (err u9002))
(define-constant ERR_FEE_TOO_HIGH   (err u9004))
(define-constant BPS u10000)
(define-constant INDEX_SCALE u10000000000) ;; 1e10 reward-math precision

;; Rewards vest linearly over one PoX cycle (~2100 blocks mainnet)
(define-constant VESTING_BLOCKS u2100)
(define-constant MAX_PROTOCOL_FEE u1000) ;; 10% cap

;; Protocol fee in bps, taken on jBTC bond rewards (operator/treasury cut).
(define-data-var protocol-fee uint u0)

;; Per-cycle reward bucket -- all rewards recorded in the same cycle vest together.
(define-map reward-bucket uint
  {
    total-sbtc: uint,      ;; net sBTC for this cycle (after protocol fee)
    vested-sbtc: uint,     ;; how much has been applied to global-index so far
    commission-sbtc: uint, ;; protocol commission (flush to treasury)
    start-height: uint     ;; burn-block-height of the first record in this cycle
  }
)

;; Which cycle we're currently vesting from
(define-data-var active-cycle uint u0)

;; ---------------------------------------------------------
;; Vesting
;; ---------------------------------------------------------

(define-read-only (get-vested-amount (cycle uint))
  (match (map-get? reward-bucket cycle)
    bucket
      (let (
        (total (get total-sbtc bucket))
        (elapsed (- burn-block-height (get start-height bucket)))
      )
        (if (>= elapsed VESTING_BLOCKS) total (/ (* total elapsed) VESTING_BLOCKS))
      )
    u0
  )
)

;; Apply any newly vested rewards to the global index. No-op if nothing new.
(define-private (apply-vested (cycle uint))
  (match (map-get? reward-bucket cycle)
    bucket
      (let (
        (total (get total-sbtc bucket))
        (already-vested (get vested-sbtc bucket))
        (elapsed (- burn-block-height (get start-height bucket)))
        (should-be-vested (if (>= elapsed VESTING_BLOCKS) total (/ (* total elapsed) VESTING_BLOCKS)))
        (new-amount (- should-be-vested already-vested))
        (supply (contract-call? .jbtc-share-data get-tracked-supply))
        (current-idx (contract-call? .jbtc-share-data get-global-index))
      )
        (if (and (> new-amount u0) (> supply u0))
          (begin
            (try! (contract-call? .jbtc-share-data set-global-index
              (+ current-idx (/ (* new-amount INDEX_SCALE) supply))))
            (map-set reward-bucket cycle (merge bucket { vested-sbtc: should-be-vested }))
            (ok true)
          )
          (ok true)
        )
      )
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Feed: record sBTC the signer-manager already forwarded here
;; ---------------------------------------------------------

;; Called by juice-signer-manager after claiming bond rewards from pox-5. The
;; sBTC must already have been transferred into this contract by the caller;
;; this only buckets the amount for vesting and books the protocol fee.
(define-public (record-rewards (amount uint) (cycle uint))
  (let (
    (protocol-amount (/ (* amount (var-get protocol-fee)) BPS))
    (net-rewards (- amount protocol-amount))
    (existing (default-to
      { total-sbtc: u0, vested-sbtc: u0, commission-sbtc: u0, start-height: burn-block-height }
      (map-get? reward-bucket cycle)))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (map-set reward-bucket cycle {
      total-sbtc: (+ (get total-sbtc existing) net-rewards),
      vested-sbtc: (get vested-sbtc existing),
      commission-sbtc: (+ (get commission-sbtc existing) protocol-amount),
      start-height: (get start-height existing)
    })
    (var-set active-cycle cycle)
    (print { action: "record-rewards", cycle: cycle, amount: amount, net: net-rewards, protocol-fee: protocol-amount })
    (ok net-rewards)
  )
)

;; ---------------------------------------------------------
;; Settle: pay pending sBTC to a jBTC holder
;; ---------------------------------------------------------

;; Called by jbtc-token on every transfer/mint/burn/claim.
(define-public (settle-wallet (who principal) (current-balance uint) (total-supply uint))
  (let ((cycle (var-get active-cycle)))
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (try! (apply-vested cycle))
    (let (
      (idx (contract-call? .jbtc-share-data get-global-index))
      (snap (contract-call? .jbtc-share-data get-wallet-snapshot who))
      (snap-idx (get index snap))
      (snap-balance (get balance snap))
      (pending (if (> snap-balance u0) (/ (* snap-balance (- idx snap-idx)) INDEX_SCALE) u0))
    )
      (if (> pending u0)
        (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" pending))
          (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer pending tx-sender who none))))
        true
      )
      (try! (contract-call? .jbtc-share-data set-wallet-snapshot who { index: idx, balance: current-balance }))
      (try! (contract-call? .jbtc-share-data set-tracked-supply total-supply))
      (ok pending)
    )
  )
)

;; Settle a DeFi position holding jBTC (same logic, balance from the adapter).
(define-public (settle-defi-position (who principal) (adapter <position-trait>))
  (let ((cycle (var-get active-cycle)))
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (try! (apply-vested cycle))
    (let (
      (idx (contract-call? .jbtc-share-data get-global-index))
      (snap (contract-call? .jbtc-share-data get-wallet-snapshot who))
      (snap-idx (get index snap))
      (defi-balance (unwrap-panic (contract-call? adapter get-balance who)))
      (total-balance (+ (get balance snap) defi-balance))
      (pending (if (> total-balance u0) (/ (* total-balance (- idx snap-idx)) INDEX_SCALE) u0))
    )
      (asserts! (contract-call? .jbtc-share-data is-defi-adapter (contract-of adapter)) ERR_UNAUTHORIZED)
      (if (> pending u0)
        (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" pending))
          (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer pending tx-sender who none))))
        true
      )
      (try! (contract-call? .jbtc-share-data set-wallet-snapshot who { index: idx, balance: (get balance snap) }))
      (ok pending)
    )
  )
)

;; ---------------------------------------------------------
;; Flush protocol commission to treasury
;; ---------------------------------------------------------

(define-public (flush-commission (cycle uint) (commission-contract <commission-trait>))
  (let (
    (bucket (unwrap! (map-get? reward-bucket cycle) ERR_NOTHING_TO_VEST))
    (commission-amount (get commission-sbtc bucket))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (asserts! (> commission-amount u0) ERR_NOTHING_TO_VEST)
    (try! (as-contract (contract-call? commission-contract process commission-amount)))
    (map-set reward-bucket cycle (merge bucket { commission-sbtc: u0 }))
    (print { action: "flush-commission", cycle: cycle, amount: commission-amount })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

(define-read-only (get-reward-bucket (cycle uint)) (map-get? reward-bucket cycle))
(define-read-only (get-active-cycle) (var-get active-cycle))
(define-read-only (get-protocol-fee) (var-get protocol-fee))

(define-public (set-protocol-fee (rate uint))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (asserts! (<= rate MAX_PROTOCOL_FEE) ERR_FEE_TOO_HIGH)
    (var-set protocol-fee rate)
    (ok true)
  )
)

(define-read-only (get-unclaimed (who principal))
  (let (
    (cycle (var-get active-cycle))
    (current-idx (contract-call? .jbtc-share-data get-global-index))
    (supply (contract-call? .jbtc-share-data get-tracked-supply))
    (vested-now (get-vested-amount cycle))
    (already-vested (default-to u0
      (match (map-get? reward-bucket cycle) bucket (some (get vested-sbtc bucket)) none)))
    (new-amount (- vested-now already-vested))
    (projected-idx (if (and (> new-amount u0) (> supply u0))
      (+ current-idx (/ (* new-amount INDEX_SCALE) supply)) current-idx))
    (snap (contract-call? .jbtc-share-data get-wallet-snapshot who))
    (snap-idx (get index snap))
    (snap-balance (get balance snap))
  )
    (if (> snap-balance u0) (/ (* snap-balance (- projected-idx snap-idx)) INDEX_SCALE) u0)
  )
)
