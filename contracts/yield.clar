;; Title: yield
;;
;; Unified reward + distribution contract for jSTX.
;;
;; Flow:
;; 1. Emily mints sBTC into each stacker contract (BTC address registered with Emily)
;; 2. Keeper calls sweep-stacker for each stacker that has sBTC (once per cycle)
;; 3. Yield pulls sBTC from stacker via release-rewards (stacker reports amount + fee)
;; 4. Commission is split (signer operator cut + protocol treasury)
;; 5. Net rewards accumulate in a per-cycle bucket, vest linearly over VESTING_BLOCKS
;; 6. On any settle (transfer/mint/burn/claim), vested amount is
;;    calculated from block height -- no keeper needed for distribution
;;
;; Anti-flash-mint: rewards vest as a function of time, not discrete
;; keeper-triggered drips. Minting jSTX right before a vest window
;; doesn't help because settle-wallet snapshots your index first.
;;
;; Data layer: share-data.clar (upgradeable logic, persistent state)

(use-trait stacker-trait .stacker-trait.stacker-trait)
(use-trait commission-trait .commission-trait.commission-trait)
(use-trait position-trait .position-trait.position-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u9001))
(define-constant ERR_NOTHING_TO_VEST (err u9002))
(define-constant ERR_ALREADY_FLUSHED (err u9003))
(define-constant ERR_FEE_TOO_HIGH (err u9004))
(define-constant BPS u10000)
(define-constant INDEX_SCALE u10000000000) ;; 1e10 for reward math precision

;; Rewards vest linearly over one PoX cycle (~2100 blocks on mainnet)
(define-constant VESTING_BLOCKS u2100)
(define-constant MAX_PROTOCOL_FEE u1000) ;; 10% cap

;; Protocol fee in basis points, set by admin independently of signer fees.
(define-data-var protocol-fee uint u0)

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Per-cycle reward bucket. All stackers swept in the same cycle
;; accumulate into the same bucket and vest together.
(define-map reward-bucket uint
  {
    total-sbtc: uint,        ;; net sBTC for this cycle (after commission)
    vested-sbtc: uint,       ;; how much has been applied to global-index so far
    commission-sbtc: uint,   ;; protocol commission (flush to treasury)
    start-height: uint       ;; burn-block-height when first sweep of this cycle happened
  }
)

;; Which cycle we're currently vesting from
(define-data-var active-cycle uint u0)

;; Per-stacker yield accounting: how much gross sBTC each stacker
;; has contributed across all cycles (for dashboards / attribution).
(define-map stacker-yield-total principal uint)

;; ---------------------------------------------------------
;; Internal: compute how much of a cycle's rewards have vested
;; ---------------------------------------------------------

(define-read-only (get-vested-amount (cycle uint))
  (match (map-get? reward-bucket cycle)
    bucket
      (let (
        (total (get total-sbtc bucket))
        (start (get start-height bucket))
        (elapsed (- burn-block-height start))
        (vested (if (>= elapsed VESTING_BLOCKS)
          total
          (/ (* total elapsed) VESTING_BLOCKS)
        ))
      )
        vested
      )
    u0
  )
)

;; Apply any newly vested rewards to the global index.
;; Called internally before every settle. If nothing new has vested,
;; this is a no-op (no state change, minimal cost).
(define-private (apply-vested (cycle uint))
  (match (map-get? reward-bucket cycle)
    bucket
      (let (
        (total (get total-sbtc bucket))
        (already-vested (get vested-sbtc bucket))
        (start (get start-height bucket))
        (elapsed (- burn-block-height start))
        (should-be-vested (if (>= elapsed VESTING_BLOCKS)
          total
          (/ (* total elapsed) VESTING_BLOCKS)
        ))
        (new-amount (- should-be-vested already-vested))
        (supply (contract-call? .share-data get-tracked-supply))
        (current-idx (contract-call? .share-data get-global-index))
      )
        (if (and (> new-amount u0) (> supply u0))
          (begin
            ;; Bump global index
            (try! (contract-call? .share-data set-global-index
              (+ current-idx (/ (* new-amount INDEX_SCALE) supply))
            ))
            ;; Record what we've vested
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
;; Sweep rewards from a stacker (called by keeper, once per cycle)
;; ---------------------------------------------------------

;; Keeper triggers this per stacker. Yield pulls sBTC from the stacker
;; via release-rewards. The stacker reports how much sBTC it had and
;; its fee rate. Two independent fees are applied:
;; 1. Signer fee — paid directly to the signer (they set their own rate)
;; 2. Protocol fee — set by admin, stored in bucket for flush-commission
;; Neither party needs the other's permission to set their fee.
;;
;; Multiple stackers swept in the same cycle share one vesting window.
;; The cycle param groups them -- keeper passes the current PoX cycle.
(define-public (sweep-stacker (stacker <stacker-trait>) (cycle uint))
  (let (
    (stacker-principal (contract-of stacker))
    ;; Pull sBTC from stacker -- stacker already paid signer fee, sends net to us
    (reward-data (try! (contract-call? stacker release-rewards current-contract)))
    (net-from-stacker (get amount reward-data))
    (signer-fee-paid (get fee reward-data))

    ;; Protocol fee: applied on what we received, stored for flush
    (protocol-amount (/ (* net-from-stacker (var-get protocol-fee)) BPS))
    (net-rewards (- net-from-stacker protocol-amount))

    ;; Get or create cycle bucket (start-height set on first sweep of cycle)
    (existing (default-to
      { total-sbtc: u0, vested-sbtc: u0, commission-sbtc: u0, start-height: burn-block-height }
      (map-get? reward-bucket cycle)
    ))

    ;; Running total for this stacker (gross = what we got + signer fee)
    (gross (+ net-from-stacker signer-fee-paid))
    (prev-total (default-to u0 (map-get? stacker-yield-total stacker-principal)))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))

    ;; Accumulate net rewards + protocol commission into cycle bucket
    (map-set reward-bucket cycle {
      total-sbtc: (+ (get total-sbtc existing) net-rewards),
      vested-sbtc: (get vested-sbtc existing),
      commission-sbtc: (+ (get commission-sbtc existing) protocol-amount),
      start-height: (get start-height existing)
    })

    ;; Track per-stacker yield attribution (gross, for dashboards)
    (map-set stacker-yield-total stacker-principal (+ prev-total gross))

    ;; Update active cycle
    (var-set active-cycle cycle)

    (print {
      action: "sweep-stacker",
      stacker: stacker-principal,
      cycle: cycle,
      gross: gross,
      signer-fee: signer-fee-paid,
      protocol-fee: protocol-amount,
      net: net-rewards
    })
    (ok net-rewards)
  )
)

;; ---------------------------------------------------------
;; Settle: pay pending sBTC to a jSTX holder
;; ---------------------------------------------------------

;; Called by jstx-token on every transfer/mint/burn/claim.
;; 1. Applies any newly vested rewards to the global index
;; 2. Calculates holder's pending sBTC
;; 3. Transfers sBTC to them
;; 4. Updates their snapshot
(define-public (settle-wallet (who principal) (current-balance uint) (total-supply uint))
  (let (
    (cycle (var-get active-cycle))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))

    ;; Apply any newly vested rewards to global index
    (try! (apply-vested cycle))

    (let (
      (idx (contract-call? .share-data get-global-index))
      (snap (contract-call? .share-data get-wallet-snapshot who))
      (snap-idx (get index snap))
      (snap-balance (get balance snap))
      (pending (if (> snap-balance u0)
        (/ (* snap-balance (- idx snap-idx)) INDEX_SCALE)
        u0
      ))
    )
      ;; Pay out pending sBTC
      (if (> pending u0)
        (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" pending))
          (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer pending tx-sender who none))))
        true
      )
      ;; Update snapshot
      (try! (contract-call? .share-data set-wallet-snapshot who {
        index: idx,
        balance: current-balance
      }))
      ;; Update tracked supply
      (try! (contract-call? .share-data set-tracked-supply total-supply))
      (ok pending)
    )
  )
)

;; Settle a DeFi position (e.g. jSTX deposited in Zest as collateral).
;; Same logic but reads balance from the DeFi adapter.
(define-public (settle-defi-position (who principal) (adapter <position-trait>))
  (let (
    (cycle (var-get active-cycle))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (try! (apply-vested cycle))

    (let (
      (idx (contract-call? .share-data get-global-index))
      (snap (contract-call? .share-data get-wallet-snapshot who))
      (snap-idx (get index snap))
      (defi-balance (unwrap-panic (contract-call? adapter get-balance who)))
      (total-balance (+ (get balance snap) defi-balance))
      (pending (if (> total-balance u0)
        (/ (* total-balance (- idx snap-idx)) INDEX_SCALE)
        u0
      ))
    )
      (asserts! (contract-call? .share-data is-defi-adapter (contract-of adapter)) ERR_UNAUTHORIZED)
      (if (> pending u0)
        (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" pending))
          (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer pending tx-sender who none))))
        true
      )
      (try! (contract-call? .share-data set-wallet-snapshot who {
        index: idx,
        balance: (get balance snap)
      }))
      (ok pending)
    )
  )
)

;; ---------------------------------------------------------
;; Flush commission to treasury
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

(define-read-only (get-reward-bucket (cycle uint))
  (map-get? reward-bucket cycle)
)

(define-read-only (get-active-cycle)
  (var-get active-cycle)
)

(define-read-only (get-stacker-yield (stacker principal))
  (default-to u0 (map-get? stacker-yield-total stacker))
)

(define-read-only (get-protocol-fee)
  (var-get protocol-fee)
)

(define-public (set-protocol-fee (rate uint))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (asserts! (<= rate MAX_PROTOCOL_FEE) ERR_FEE_TOO_HIGH)
    (var-set protocol-fee rate)
    (print { action: "set-protocol-fee", rate: rate })
    (ok true)
  )
)

(define-read-only (get-unclaimed (who principal))
  (let (
    (cycle (var-get active-cycle))
    ;; Calculate what global-index WOULD be after applying vested
    (current-idx (contract-call? .share-data get-global-index))
    (supply (contract-call? .share-data get-tracked-supply))
    (vested-now (get-vested-amount cycle))
    (already-vested (default-to u0
      (match (map-get? reward-bucket cycle)
        bucket (some (get vested-sbtc bucket))
        none
      )
    ))
    (new-amount (- vested-now already-vested))
    (projected-idx (if (and (> new-amount u0) (> supply u0))
      (+ current-idx (/ (* new-amount INDEX_SCALE) supply))
      current-idx
    ))
    (snap (contract-call? .share-data get-wallet-snapshot who))
    (snap-idx (get index snap))
    (snap-balance (get balance snap))
  )
    (if (> snap-balance u0)
      (/ (* snap-balance (- projected-idx snap-idx)) INDEX_SCALE)
      u0
    )
  )
)
