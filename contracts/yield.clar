;; Title: yield
;;
;; Unified reward + distribution contract for jSTX.
;;
;; Flow:
;; 1. Emily mints sBTC into each stacker contract (BTC address registered with Emily)
;; 2. Keeper calls sweep-stacker for each stacker that has sBTC
;; 3. Yield pulls sBTC from stacker via release-rewards (stacker reports amount + fee)
;; 4. Commission is split (signer operator cut + protocol treasury)
;; 5. Net rewards stored with a start-height, vest linearly over VESTING_BLOCKS (~2100 blocks)
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
(define-constant BPS u10000)
(define-constant INDEX_SCALE u10000000000) ;; 1e10 for reward math precision

;; Rewards vest linearly over one PoX cycle (~2100 blocks on mainnet)
(define-constant VESTING_BLOCKS u2100)

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Per-sweep reward bucket. Each sweep batch gets its own vesting window.
(define-map reward-bucket uint
  {
    total-sbtc: uint,        ;; net sBTC for this window (after commission)
    vested-sbtc: uint,       ;; how much has been applied to global-index so far
    commission-sbtc: uint,   ;; protocol commission (flush to treasury)
    start-height: uint       ;; burn-block-height when rewards were deposited
  }
)

;; Monotonic counter for vesting windows
(define-data-var window-id uint u0)

;; Which window we're currently vesting from
(define-data-var active-window uint u0)

;; ---------------------------------------------------------
;; Internal: compute how much of a window's rewards have vested
;; ---------------------------------------------------------

(define-read-only (get-vested-amount (window uint))
  (match (map-get? reward-bucket window)
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
(define-private (apply-vested (window uint))
  (match (map-get? reward-bucket window)
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
            (map-set reward-bucket window (merge bucket { vested-sbtc: should-be-vested }))
            (ok true)
          )
          (ok true)
        )
      )
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Sweep rewards from a stacker (called by keeper)
;; ---------------------------------------------------------

;; Keeper triggers this per stacker. Yield pulls sBTC from the stacker
;; via release-rewards. The stacker reports how much sBTC it had and
;; its fee rate. Yield applies the fee, pays the operator, and stores
;; net rewards in a new vesting window.
;;
;; No cycle parameter -- whatever sBTC is sitting in the stacker gets
;; swept. Rewards vest linearly over VESTING_BLOCKS from this moment.
(define-public (sweep-stacker (stacker <stacker-trait>))
  (let (
    (stacker-principal (contract-of stacker))
    ;; Pull sBTC from stacker -- it transfers to us and returns amount + fee
    (reward-data (try! (contract-call? stacker release-rewards (as-contract tx-sender))))
    (sbtc-amount (get amount reward-data))
    (fee-rate (get fee reward-data))

    ;; Commission math
    (commission-amount (/ (* sbtc-amount fee-rate) BPS))
    (net-rewards (- sbtc-amount commission-amount))

    ;; Operator cut: who receives it and what share of commission
    (owner-cut (contract-call? .registry get-operator-cut stacker-principal))
    (owner-amount (/ (* commission-amount (get share owner-cut)) BPS))
    (protocol-commission (- commission-amount owner-amount))

    ;; New vesting window
    (window (+ (var-get window-id) u1))
    (existing (default-to
      { total-sbtc: u0, vested-sbtc: u0, commission-sbtc: u0, start-height: burn-block-height }
      (map-get? reward-bucket window)
    ))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))

    ;; Pay signer operator their cut immediately
    (if (> owner-amount u0)
      (try! (as-contract (contract-call? .sbtc-mock transfer owner-amount tx-sender (get receiver owner-cut) none)))
      true
    )

    ;; Store net rewards + protocol commission
    (map-set reward-bucket window {
      total-sbtc: (+ (get total-sbtc existing) net-rewards),
      vested-sbtc: (get vested-sbtc existing),
      commission-sbtc: (+ (get commission-sbtc existing) protocol-commission),
      start-height: (get start-height existing)
    })

    ;; Advance window
    (var-set window-id window)
    (var-set active-window window)

    (print {
      action: "sweep-stacker",
      stacker: stacker-principal,
      window: window,
      gross: sbtc-amount,
      signer-fee: fee-rate,
      commission: commission-amount,
      owner-cut: owner-amount,
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
    (cycle (var-get active-window))
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
        (try! (as-contract (contract-call? .sbtc-mock transfer pending tx-sender who none)))
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
    (cycle (var-get active-window))
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
        (try! (as-contract (contract-call? .sbtc-mock transfer pending tx-sender who none)))
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

(define-public (flush-commission (window uint) (commission-contract <commission-trait>))
  (let (
    (bucket (unwrap! (map-get? reward-bucket window) ERR_NOTHING_TO_VEST))
    (commission-amount (get commission-sbtc bucket))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (asserts! (> commission-amount u0) ERR_NOTHING_TO_VEST)

    (try! (as-contract (contract-call? commission-contract process commission-amount)))

    (map-set reward-bucket window (merge bucket { commission-sbtc: u0 }))

    (print { action: "flush-commission", window: window, amount: commission-amount })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

(define-read-only (get-reward-bucket (window uint))
  (map-get? reward-bucket window)
)

(define-read-only (get-active-window)
  (var-get active-window)
)

(define-read-only (get-unclaimed (who principal))
  (let (
    (window (var-get active-window))
    ;; Calculate what global-index WOULD be after applying vested
    (current-idx (contract-call? .share-data get-global-index))
    (supply (contract-call? .share-data get-tracked-supply))
    (vested-now (get-vested-amount window))
    (already-vested (default-to u0
      (match (map-get? reward-bucket window)
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
