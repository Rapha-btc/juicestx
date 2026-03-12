;; Title: allocation
;;
;; Computes per-stacker STX targets and executes the allocation by moving
;; STX from vault to stacker contracts.
;;
;; Two responsibilities:
;;   1. Calculate -- blend admin weights (registry) with user delegation
;;      preferences (delegation) to determine each stacker's target.
;;   2. Execute -- move pending STX from vault to stackers according to targets.
;;      An operator calls execute-allocation for each stacker that needs funding.
;;
;; Per-stacker target formula:
;;   target = assigned_stx
;;          + (unassigned_stx * (1 - user_influence) * stacker_weight)
;;          + (unassigned_stx * user_influence * assigned_share)
;;
;; Where:
;;   assigned_stx     = STX explicitly assigned to this stacker by users
;;   unassigned_stx   = total stackable STX minus all assigned STX
;;   user_influence   = % of unassigned STX allocated by user preferences
;;   stacker_weight   = admin-set allocation from registry (basis points)
;;   assigned_share   = this stacker's share of all assigned STX
;;
;; Inspired by:
;;   Calculation: StackingDAO strategy-v3-pools-v1.clar
;;   Source: stacking-dao/contracts/version-2/strategy-v3-pools-v1.clar
;;
;;   Execution: StackingDAO strategy-v3.clar + delegates-handler-v1.clar
;;   Source: stacking-dao/contracts/version-2/strategy-v3.clar
;;   Source: stacking-dao/contracts/version-2/delegates-handler-v1.clar

(use-trait stacker-trait .stacker-trait.stacker-trait)
(use-trait vault-trait .vault-trait.vault-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------

(define-constant ERR_UNAUTHORIZED (err u9001))
(define-constant ERR_NOTHING_TO_ALLOCATE (err u9002))
(define-constant ERR_STACKER_NOT_ACTIVE (err u9003))
(define-constant PRECISION u10000)

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; What % of unassigned STX follows user delegation ratios (default 20%)
(define-data-var user-influence uint u2000)

;; How much STX has been sent to each stacker (running total)
(define-map stacker-allocated principal uint)

;; Sum of all STX sent to all stackers
(define-data-var total-allocated uint u0)

;; ---------------------------------------------------------
;; Admin
;; ---------------------------------------------------------

(define-public (set-user-influence (value uint))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (asserts! (<= value PRECISION) ERR_UNAUTHORIZED)
    (ok (var-set user-influence value))
  )
)

(define-read-only (get-user-influence)
  (var-get user-influence)
)

;; ---------------------------------------------------------
;; Core calculation
;; ---------------------------------------------------------

;; Compute stacking target for a single stacker.
(define-read-only (calculate-stacker-target (stacker principal))
  (let (
    ;; Total stackable = pending in vault + already sent to stackers
    (total-pending (unwrap-panic (contract-call? .vault get-pending-balance)))
    (total-stackable (+ total-pending (var-get total-allocated)))
    (total-assigned (contract-call? .delegation get-total-assigned))
    (total-unassigned (if (> total-stackable total-assigned)
      (- total-stackable total-assigned)
      u0
    ))

    ;; How much STX users explicitly assigned to this stacker
    (assigned-stacker (contract-call? .delegation get-stacker-total stacker))

    ;; This stacker's share of all assigned STX (basis points)
    (assigned-share (if (is-eq total-assigned u0)
      u0
      (/ (* assigned-stacker PRECISION) total-assigned)
    ))

    ;; Admin-set weight for this stacker within its pool
    (stacker-weight (contract-call? .registry get-delegate-allocation stacker))

    ;; Split unassigned STX: (1 - user-influence) by weight, user-influence by user preference
    (admin-rate (- PRECISION (if (is-eq total-assigned u0) u0 (var-get user-influence))))

    (admin-unassigned (/ (* total-unassigned admin-rate) PRECISION))
    (user-unassigned (- total-unassigned admin-unassigned))

    (from-weight (/ (* admin-unassigned stacker-weight) PRECISION))
    (from-assigned (/ (* user-unassigned assigned-share) PRECISION))
  )
    (+ assigned-stacker from-weight from-assigned)
  )
)

;; ---------------------------------------------------------
;; Aggregate view
;; ---------------------------------------------------------

;; Returns total stackable STX split into assigned vs unassigned.
(define-read-only (get-stacking-amounts)
  (let (
    (total-pending (unwrap-panic (contract-call? .vault get-pending-balance)))
    (total-alloc (var-get total-allocated))
    (total-stackable (+ total-pending total-alloc))
    (total-assigned (contract-call? .delegation get-total-assigned))
    (total-unassigned (if (> total-stackable total-assigned)
      (- total-stackable total-assigned)
      u0
    ))
  )
    {
      total-stackable: total-stackable,
      total-allocated: total-alloc,
      total-pending: total-pending,
      total-assigned: total-assigned,
      total-unassigned: total-unassigned
    }
  )
)

;; How much STX has already been sent to a stacker
(define-read-only (get-stacker-allocated (stacker principal))
  (default-to u0 (map-get? stacker-allocated stacker))
)

(define-read-only (get-total-allocated)
  (var-get total-allocated)
)

;; How far a stacker is from its target (positive = needs more, negative = has excess)
(define-read-only (get-stacker-delta (stacker principal))
  (let (
    (target (calculate-stacker-target stacker))
    (allocated (get-stacker-allocated stacker))
  )
    {
      target: target,
      allocated: allocated,
      deficit: (if (> target allocated) (- target allocated) u0),
      excess: (if (> allocated target) (- allocated target) u0)
    }
  )
)

;; ---------------------------------------------------------
;; Execution -- move STX from vault to stacker
;; ---------------------------------------------------------
;; Operator calls this per stacker to fund them up to their target.
;; Vault releases STX to the stacker contract, then stacker can
;; delegate to PoX via its own operator functions.

(define-public (execute-allocation
    (stacker <stacker-trait>)
    (vault <vault-trait>)
  )
  (let (
    (stacker-principal (contract-of stacker))
    (delta (get-stacker-delta stacker-principal))
    (deficit (get deficit delta))
    (allocated (get allocated delta))
    (new-allocated (+ allocated deficit))
  )
    (try! (contract-call? .dao check-is-authorized contract-caller))

    ;; Stacker must be registered
    (asserts! (> (contract-call? .registry get-delegate-allocation stacker-principal) u0) ERR_STACKER_NOT_ACTIVE)

    ;; Must have something to send
    (asserts! (> deficit u0) ERR_NOTHING_TO_ALLOCATE)

    ;; Move STX from vault to stacker contract
    (try! (contract-call? vault release deficit stacker-principal))

    ;; Update allocated tracking
    (map-set stacker-allocated stacker-principal new-allocated)
    (var-set total-allocated (+ (var-get total-allocated) deficit))

    (print { action: "execute-allocation", stacker: stacker-principal, vault: (contract-of vault), amount: deficit, new-total: new-allocated })
    (ok deficit)
  )
)

;; ---------------------------------------------------------
;; Return -- stacker sends excess STX back to vault
;; ---------------------------------------------------------
;; Called when a stacker has more than its target (e.g. after
;; rebalancing, admin weight change, or users switching stackers).

(define-public (return-excess
    (stacker <stacker-trait>)
    (vault <vault-trait>)
  )
  (let (
    (stacker-principal (contract-of stacker))
    (delta (get-stacker-delta stacker-principal))
    (excess (get excess delta))
    (target (get target delta))
  )
    (try! (contract-call? .dao check-is-authorized contract-caller))

    (asserts! (> excess u0) ERR_NOTHING_TO_ALLOCATE)

    ;; Tell stacker to return STX to vault
    (try! (contract-call? stacker stx-transfer excess vault))

    ;; Update allocated tracking
    (map-set stacker-allocated stacker-principal target)
    (var-set total-allocated (- (var-get total-allocated) excess))

    (print { action: "return-excess", stacker: stacker-principal, vault: (contract-of vault), amount: excess, new-total: target })
    (ok excess)
  )
)
