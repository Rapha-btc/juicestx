;; Title: strategy
;;
;; Calculates how much STX each signer should receive for stacking,
;; blending admin-set signer weights (from registry) with user delegation
;; preferences (from delegation).
;;
;; The core idea: users who pick a stacker via delegation influence allocation.
;; A configurable "dependence" parameter (default 20%) controls how much
;; undirected STX follows user preferences vs admin weights.
;;
;; Per-signer target formula:
;;   target = direct_stx
;;          + (undirected_stx * (1 - dependence) * signer_weight)
;;          + (undirected_stx * dependence * signer_direct_share)
;;
;; Where:
;;   direct_stx         = STX explicitly directed to this signer by users
;;   undirected_stx     = total stackable STX minus all directed STX
;;   dependence         = % of undirected STX allocated by user preferences
;;   signer_weight      = admin-set allocation from registry (basis points)
;;   signer_direct_share = this signer's share of all directed STX
;;
;; This contract is read-only -- it computes targets but does not move STX.
;; An operator or keeper reads these targets and executes the actual PoX
;; delegation via stacker contracts.
;;
;; Inspired by: StackingDAO strategy-v3-pools-v1.clar
;; Source: stacking-dao/contracts/version-2/strategy-v3-pools-v1.clar

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------

(define-constant ERR_UNAUTHORIZED (err u9001))
(define-constant BPS u10000)

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; What % of undirected STX follows user delegation ratios (default 20%)
(define-data-var dependence uint u2000)

;; ---------------------------------------------------------
;; Admin
;; ---------------------------------------------------------

(define-public (set-dependence (value uint))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (asserts! (<= value BPS) ERR_UNAUTHORIZED)
    (ok (var-set dependence value))
  )
)

(define-read-only (get-dependence)
  (var-get dependence)
)

;; ---------------------------------------------------------
;; Core calculation
;; ---------------------------------------------------------

;; Compute stacking target for a single signer.
;; Called via map over the active signers list.
(define-read-only (calculate-signer-target
    (signer principal)
    (total-undirected uint)
    (total-directed uint)
  )
  (let (
    ;; How much STX users explicitly directed to this signer
    (direct-stx (contract-call? .delegation get-stacker-total signer))

    ;; This signer's share of all directed STX (basis points)
    (direct-share (if (is-eq total-directed u0)
      u0
      (/ (* direct-stx BPS) total-directed)
    ))

    ;; Admin-set weight from registry
    (signer-weight (contract-call? .registry get-signer-allocation signer))

    ;; Split undirected STX: (1 - dependence) by weight, dependence by user preference
    (dep (if (is-eq total-directed u0) u0 (var-get dependence)))
    (dep-rest (- BPS dep))

    (weighted-portion (/ (* total-undirected dep-rest) BPS))
    (directed-portion (/ (* total-undirected dep) BPS))

    (from-weight (/ (* weighted-portion signer-weight) BPS))
    (from-directed (/ (* directed-portion direct-share) BPS))
  )
    (+ direct-stx from-weight from-directed)
  )
)

;; ---------------------------------------------------------
;; Aggregate view
;; ---------------------------------------------------------

;; Returns total stackable STX split into directed vs undirected.
(define-read-only (get-stacking-amounts)
  (let (
    (total-in-vault (unwrap-panic (contract-call? .vault get-idle-balance)))
    (total-directed (contract-call? .delegation get-total-delegated))
    (total-undirected (if (> total-in-vault total-directed)
      (- total-in-vault total-directed)
      u0
    ))
  )
    {
      total-in-vault: total-in-vault,
      total-directed: total-directed,
      total-undirected: total-undirected
    }
  )
)

;; Convenience: get the target for a single signer using current state.
(define-read-only (get-signer-target (signer principal))
  (let (
    (amounts (get-stacking-amounts))
  )
    (calculate-signer-target
      signer
      (get total-undirected amounts)
      (get total-directed amounts)
    )
  )
)
