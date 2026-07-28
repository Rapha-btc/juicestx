;; Title: yield
;;
;; Unified reward + distribution contract for jSTX.
;;
;; Flow:
;; 1. Emily mints sBTC into each stacker contract (BTC address registered with Emily)
;; 2. Keeper calls sweep-stacker for each stacker that has sBTC (once per cycle)
;; 3. Yield pulls sBTC from stacker via release-rewards (stacker reports amount + fee)
;; 4. Commission is split (signer operator cut + protocol treasury)
;; 5. Net rewards accumulate in a per-cycle bucket and vest linearly across
;;    that cycle's own PoX burn window (StackingDAO rewards-v5 style). Past
;;    the window's end the bucket clamps to fully vested, so a cycle's
;;    remainder is ALWAYS reachable -- late applies pay out 100%.
;; 6. On any settle (transfer/mint/burn/claim), vested amount is
;;    calculated from burn height -- no keeper needed for distribution.
;;    sweep-stacker finalizes the previous cycle's bucket before flipping
;;    active-cycle, and apply-cycle lets anyone catch up any bucket, so
;;    no sBTC can strand on cycle rollover.
;;
;; Anti-flash-mint: rewards vest as a function of time, not discrete
;; keeper-triggered drips. Minting jSTX right before a vest window
;; doesn't help because settle-wallet snapshots your index first.
;; Keeper should sweep promptly at cycle start: a late sweep vests the
;; already-elapsed window fraction immediately at the first settle.
;;
;; Data layer: share-data.clar (upgradeable logic, persistent state)

(use-trait stacker-trait .stacker-trait.stacker-trait)
(use-trait pool-trait .pool-trait.pool-trait)
(use-trait commission-trait .commission-trait.commission-trait)
(use-trait position-trait .position-trait.position-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u9001))
(define-constant ERR_NOTHING_TO_FLUSH (err u9003))
(define-constant ERR_FEE_TOO_HIGH (err u9004))
(define-constant ERR_WRONG_CYCLE (err u9005))
(define-constant BPS u10000)
(define-constant INDEX_SCALE u10000000000) ;; 1e10 for reward math precision

(define-constant MAX_PROTOCOL_FEE u1000) ;; 10% cap

;; Both call sites are public fns. A constant target is fine in contract-call?
;; there; it only breaks in define-read-only, where the analyzer cannot resolve
;; the callee statically and so cannot prove the call is read-only.
(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

;; Protocol fee in basis points, set by admin independently of signer fees.
(define-data-var protocol-fee uint u0)

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Per-cycle reward bucket. All stackers swept in the same cycle
;; accumulate into the same bucket and vest together across that cycle's
;; own PoX burn window (not a sweep-time clock) -- so every bucket stays
;; addressable and clamps to fully vested once its window ends.
(define-map reward-bucket uint
  {
    total-sbtc: uint,        ;; net sBTC for this cycle (after commission)
    vested-sbtc: uint,       ;; how much has been applied to global-index so far
    commission-sbtc: uint    ;; protocol commission (flush to treasury)
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

;; Burn height at which a PoX cycle starts. Cycle length is derived from
;; consecutive starts, so this tracks the real PoX calendar.
(define-read-only (get-cycle-start (cycle uint))
  (contract-call? 'SP000000000000000000002Q6VF78.pox-4 reward-cycle-to-burn-height cycle)
)

;; Vested amount for a cycle's bucket, measured against the cycle's OWN
;; burn window [cycle-start, next-cycle-start). Clamps to the full total
;; once the window has ended -- a late apply always reaches 100%, so no
;; remainder can strand (StackingDAO rewards-v5 past-intervals pattern).
(define-read-only (get-vested-amount (cycle uint))
  (match (map-get? reward-bucket cycle)
    bucket
      (let (
        (total (get total-sbtc bucket))
        (start (get-cycle-start cycle))
        (end (get-cycle-start (+ cycle u1)))
        (len (- end start))
      )
        (if (>= burn-block-height end)
          total
          (if (> burn-block-height start)
            (/ (* total (- burn-block-height start)) len)
            u0
          )
        )
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
        (already-vested (get vested-sbtc bucket))
        (should-be-vested (get-vested-amount cycle))
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
;; 1. Signer fee - paid directly to the signer (they set their own rate)
;; 2. Protocol fee - set by admin, stored in bucket for flush-commission
;; Neither party needs the other's permission to set their fee.
;;
;; Multiple stackers swept in the same cycle share one vesting window.
;; The cycle param groups them -- MUST be the current PoX cycle (asserted),
;; so active-cycle can only move forward in step with the PoX calendar.
;; Before flipping, the previous active bucket is finalized: its window has
;; ended, so apply-vested clamps to the full total and nothing strands.
(define-public (sweep-stacker (stacker <stacker-trait>) (pool <pool-trait>) (cycle uint))
  (let (
    (stacker-principal (contract-of stacker))
    ;; Pull sBTC from stacker -- stacker already paid signer fee, sends net to us
    (reward-data (try! (contract-call? stacker release-rewards current-contract pool)))
    (net-from-stacker (get amount reward-data))
    (signer-fee-paid (get fee reward-data))

    ;; Protocol fee: applied on what we received, stored for flush
    (protocol-amount (/ (* net-from-stacker (var-get protocol-fee)) BPS))
    (net-rewards (- net-from-stacker protocol-amount))

    ;; Running total for this stacker (gross = what we got + signer fee)
    (gross (+ net-from-stacker signer-fee-paid))
    (prev-total (default-to u0 (map-get? stacker-yield-total stacker-principal)))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (asserts! (is-eq cycle (contract-call? 'SP000000000000000000002Q6VF78.pox-4 current-pox-reward-cycle)) ERR_WRONG_CYCLE)

    ;; Finalize whatever the previous active bucket still owes the index.
    ;; Same cycle: this is just the regular lazy apply. New cycle: the old
    ;; window has ended, so the clamp pays out its full remainder BEFORE we
    ;; move active-cycle -- no sBTC can strand on rollover.
    (try! (apply-vested (var-get active-cycle)))

    ;; Accumulate net rewards + protocol commission into cycle bucket.
    ;; Read AFTER apply-vested so we never clobber a fresher vested-sbtc.
    (let (
      (existing (default-to
        { total-sbtc: u0, vested-sbtc: u0, commission-sbtc: u0 }
        (map-get? reward-bucket cycle)
      ))
    )
      (map-set reward-bucket cycle {
        total-sbtc: (+ (get total-sbtc existing) net-rewards),
        vested-sbtc: (get vested-sbtc existing),
        commission-sbtc: (+ (get commission-sbtc existing) protocol-amount)
      })
    )

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
;; Catch-up: apply any cycle's vested rewards (permissionless)
;; ---------------------------------------------------------

;; Anyone can push a bucket's newly vested sBTC into the global index --
;; the math is deterministic, so this is safe to leave open (mirrors
;; StackingDAO's per-cycle process-rewards). Main use: recovering a
;; straggler bucket if sweeps ever skip a cycle; past its window end the
;; clamp pays out the full remainder.
(define-public (apply-cycle (cycle uint))
  (begin
    (try! (contract-call? .dao check-is-live))
    (apply-vested cycle)
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
        (try! (as-contract? ((with-ft SBTC "sbtc-token" pending))
          (try! (contract-call? SBTC transfer pending tx-sender who none))))
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
        (try! (as-contract? ((with-ft SBTC "sbtc-token" pending))
          (try! (contract-call? SBTC transfer pending tx-sender who none))))
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
    (bucket (unwrap! (map-get? reward-bucket cycle) ERR_NOTHING_TO_FLUSH))
    (commission-amount (get commission-sbtc bucket))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    ;; Zero also covers the already-flushed case: flushing zeroes the pot.
    (asserts! (> commission-amount u0) ERR_NOTHING_TO_FLUSH)

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
