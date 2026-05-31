;; Title: juice-v0
;;
;; Manual, single-cycle sBTC reward distributor for the STX Juice pool.
;;
;; Standalone tool (no .dao dependency) for the pool admin to distribute a
;; cycle's sBTC rewards pro-rata to stackers, with a full on-chain audit trail.
;;
;; Strictly one cycle at a time: you cannot register a new cycle until the
;; active one has been distributed. The contract holds only the active cycle's
;; working set in data-vars; the permanent per-cycle record is the `distribute`
;; event (which carries every payout), queryable via the events API.
;;
;; Flow:
;;   1. register-stakers  -- admin submits the full {staker, stx} list for a
;;                           cycle. Re-submittable (replaces) until distributed.
;;   2. fund              -- admin sends sBTC into this contract (or transfers
;;                           directly from a wallet). This is the reward pool.
;;   3. distribute        -- admin pays every registered staker their pro-rata
;;                           share (share = balance * staker-stx / total-stx) in
;;                           one atomic pass. Reward = whatever sBTC the contract
;;                           holds. Runs once per cycle.
;;
;; Escape hatch: withdraw -- admin can pull sBTC out at any time (rounding dust,
;; or to recover misrouted funds).
;;
;; Amounts: stx is micro-STX (1 STX = 1,000,000), sBTC in sats. Integer division
;; floors, so a few sats of rounding dust stay in the contract (recover via
;; withdraw). The submitted staker list must be unique -- a principal listed
;; twice would be paid twice. Aggregate multi-delegation principals off-chain.

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

(define-constant ERR_NOT_OWNER (err u20001))
(define-constant ERR_PREVIOUS_NOT_DISTRIBUTED (err u20002))
(define-constant ERR_NO_REWARD (err u20003))
(define-constant ERR_NO_STAKERS (err u20004))
(define-constant ERR_ALREADY_DISTRIBUTED (err u20005))
(define-constant ERR_WRONG_CYCLE (err u20006))
(define-constant ERR_BACK_TO_THE_FUTURE (err u20007))

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Captured at deploy time -- tx-sender in a top-level definition is the deployer.
(define-constant DEPLOYER tx-sender)

;; The pool admin. Set to deployer; rotatable via set-owner.
(define-data-var contract-owner principal DEPLOYER)

;; The cycle currently being worked on (u0 = none yet).
(define-data-var active-cycle uint u0)

;; The active cycle's staker list with each staker's locked STX (micro-STX).
(define-data-var registration (list 200 { staker: principal, stx: uint }) (list))

;; Sum of the active cycle's staker stx -- the pro-rata denominator.
(define-data-var total-stx uint u0)

;; Whether the active cycle has been distributed. Blocks a second distribution
;; and gates starting the next cycle.
(define-data-var distributed bool false)

;; ---------------------------------------------------------
;; Private helpers
;; ---------------------------------------------------------

;; Fold to sum the locked STX across a registration list.
(define-private (sum-stx (entry { staker: principal, stx: uint }) (acc uint))
  (+ acc (get stx entry))
)

;; Fold over the registration to pay out. reward/total are constant; paid and
;; results accumulate. Returns the running tally plus per-staker payout records
;; for a single consolidated event.
(define-private (payout-one
    (entry { staker: principal, stx: uint })
    (acc {
      reward: uint,
      total: uint,
      paid: uint,
      results: (list 200 { staker: principal, stx: uint, sbtc: uint })
    }))
  (let (
    (staker (get staker entry))
    (stx (get stx entry))
    (share (/ (* (get reward acc) stx) (get total acc)))
  )
    ;; Skip a zero share (rounds to 0) -- an sBTC transfer of 0 would error
    ;; and revert the whole distribution.
    (if (> share u0)
      (begin
        ;; Send the share from the contract's sBTC balance. unwrap-panic aborts
        ;; the whole distribution on failure -- payout-one returns a tuple, so
        ;; try!/asserts! can't be used here.
        (unwrap-panic (as-contract? ((with-ft SBTC "sbtc-token" share))
          (unwrap-panic (contract-call? SBTC transfer share current-contract staker none))))
        (merge acc {
          paid: (+ (get paid acc) share),
          results: (unwrap-panic (as-max-len?
            (append (get results acc) { staker: staker, stx: stx, sbtc: share })
            u200))
        })
      )
      acc
    )
  )
)

;; ---------------------------------------------------------
;; Admin: registration
;; ---------------------------------------------------------

;; Submit the full {staker, stx} list for a cycle. Replaces any prior submission
;; for the same (not-yet-distributed) cycle. Starting a different cycle requires
;; the previous one to have been distributed first.
(define-public (register-stakers
    (cycle uint)
    (entries (list 200 { staker: principal, stx: uint })))
  (let ((last-active (var-get active-cycle)))
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_OWNER)
    (asserts! (>= cycle last-active) ERR_BACK_TO_THE_FUTURE)
    (if (is-eq cycle last-active)
      ;; Re-submitting / correcting the current cycle -- only before distribution.
      (asserts! (not (var-get distributed)) ERR_ALREADY_DISTRIBUTED)
      ;; Starting a new cycle -- the previous one must be done.
      (asserts! (or (is-eq last-active u0) (var-get distributed))
        ERR_PREVIOUS_NOT_DISTRIBUTED)
    )
    (let ((total (fold sum-stx entries u0)))
      (var-set active-cycle cycle)
      (var-set registration entries)
      (var-set total-stx total)
      (var-set distributed false)
      (print {
        action: "register-stakers",
        cycle: cycle,
        count: (len entries),
        entries: entries,
        total-stx: total
      })
      (ok total)
    )
  )
)

;; ---------------------------------------------------------
;; Funding
;; ---------------------------------------------------------

;; Convenience: pull sBTC from the caller into this contract (for an audit
;; event). Funds can also be sent directly to the contract from a wallet.
;; Anyone may fund.
(define-public (fund (amount uint))
  (begin
    (try! (contract-call? SBTC transfer amount tx-sender current-contract none))
    (print { action: "fund", from: tx-sender, amount: amount })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Distribution
;; ---------------------------------------------------------

;; Pay every registered staker their pro-rata share of the contract's current
;; sBTC balance, in one atomic pass. If any transfer fails the whole thing
;; reverts. Runs once per cycle.
(define-public (distribute (cycle uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_OWNER)
    (asserts! (is-eq cycle (var-get active-cycle)) ERR_WRONG_CYCLE)
    (asserts! (not (var-get distributed)) ERR_ALREADY_DISTRIBUTED)
    (let (
      (total (var-get total-stx))
      (reward (unwrap-panic (contract-call? SBTC get-balance current-contract)))
    )
      (asserts! (> total u0) ERR_NO_STAKERS)
      (asserts! (> reward u0) ERR_NO_REWARD)
      ;; Mark distributed up front -- single source of truth even if re-entered.
      (var-set distributed true)
      (let (
        (final (fold payout-one (var-get registration)
          { reward: reward, total: total, paid: u0, results: (list) }))
        (out (get paid final))
      )
        (print {
          action: "distribute",
          cycle: cycle,
          reward: reward,
          paid: out,
          dust: (- reward out),
          distributions: (get results final)
        })
        (ok out)
      )
    )
  )
)

;; ---------------------------------------------------------
;; Escape hatch
;; ---------------------------------------------------------

;; Admin can withdraw sBTC from the contract (dust recovery / misroute recovery).
(define-public (withdraw (amount uint))
  (let ((owner (var-get contract-owner)))
    (asserts! (is-eq tx-sender owner) ERR_NOT_OWNER)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? SBTC transfer amount current-contract owner none))))
    (print { action: "withdraw", amount: amount, recipient: owner })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Ownership
;; ---------------------------------------------------------

(define-public (set-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_OWNER)
    (var-set contract-owner new-owner)
    (print { action: "set-owner", new-owner: new-owner })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

(define-read-only (get-owner)
  (var-get contract-owner)
)

(define-read-only (get-sbtc-balance)
  ;; Literal principal (not the SBTC constant) so the analyzer can statically
  ;; prove this cross-contract call is read-only.
  (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance current-contract))
)

(define-read-only (get-active-cycle)
  (var-get active-cycle)
)

(define-read-only (get-registration)
  (var-get registration)
)

(define-read-only (get-total-stx)
  (var-get total-stx)
)

(define-read-only (is-distributed)
  (var-get distributed)
)

;; Pro-rata share for a given stx amount against the active cycle's reward pool
;; (the contract's current sBTC balance). Off-chain you can map this over
;; get-registration to preview every payout before broadcasting distribute.
(define-read-only (get-projected-share (stx uint))
  (let (
    (total (var-get total-stx))
    (reward (get-sbtc-balance))
  )
    (if (> total u0)
      (/ (* reward stx) total)
      u0
    )
  )
)
