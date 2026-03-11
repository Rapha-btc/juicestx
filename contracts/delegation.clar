;; Title: delegation
;;
;; Tracks which stacker each user wants their STX delegated to.
;; Called by core on deposit / withdraw.
;;
;; Operations:
;;   assign  -- user picks (or changes) stacker on deposit
;;              pass none to clear preference (protocol allocates via registry)
;;   reduce  -- reduce or clear delegation (protocol on withdraw, or user self-service)
;;   update  -- keeper corrects stale delegations when user sells jSTX
;;
;; Inspired by: StackingDAO data-direct-stacking-v1.clar + direct-helpers-v4.clar
;; Source (data):  stacking-dao/contracts/version-2/data-direct-stacking-v1.clar
;; Source (logic): stacking-dao/contracts/version-3/direct-helpers-v4.clar

(define-constant ERR_INVALID_STACKER (err u4001))

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; user -> { stacker, amount } -- which stacker and how much
(define-map user-assign
  principal
  { stacker: principal, amount: uint }
)

;; stacker -> total STX directed to it by all users
(define-map stacker-total principal uint)

;; global sum of all user-directed STX
(define-data-var total-assigned uint u0)

(define-read-only (get-user-assign (user principal))
  (map-get? user-assign user)
)

(define-read-only (get-stacker-total (stacker principal))
  (default-to u0 (map-get? stacker-total stacker))
)

(define-read-only (get-total-assigned)
  (var-get total-assigned)
)

 (define-public (assign (user principal) (stacker (optional principal)) (amount uint))
    (let (
      (delegated (map-get? user-assign user))
      (prev-amount (default-to u0 (get amount delegated)))
      (cleared (if (is-some delegated)
        (remove-delegation user (get stacker (unwrap-panic delegated)) prev-amount)
        true
      ))
    )
      (try! (contract-call? .dao check-is-authorized contract-caller))

      (if (is-some stacker)
        (let (
          (new-stacker (unwrap-panic stacker))
          (new-amount (+ prev-amount amount))
          (stacker-sum (get-stacker-total new-stacker))
          (global-sum (var-get total-assigned))
        )
          (asserts! (> (contract-call? .registry get-signer-allocation new-stacker) u0) ERR_INVALID_STACKER)
          (map-set user-assign user { stacker: new-stacker, amount: new-amount })
          (map-set stacker-total new-stacker (+ stacker-sum new-amount))
          (var-set total-assigned (+ global-sum new-amount))
          (print { action: "assign", user: user, stacker: new-stacker, amount: new-amount })
          (ok true)
        )
        (begin
          (print { action: "deposit", user: user, stacker: none, amount: amount })
          (ok true)
        )
      )
    )
  )

(define-public (reduce (user principal) (amount uint))
  (let (
    (delegated (map-get? user-assign user))
  )
    (if (is-eq user tx-sender)
      true
      (try! (contract-call? .dao check-is-authorized contract-caller))
    )

    (if (is-some delegated)
      (let (
        (prev-stacker (get stacker (unwrap-panic delegated)))
        (prev-amount (get amount (unwrap-panic delegated)))
      )
        (if (>= amount prev-amount)
          (begin
            (remove-delegation user prev-stacker prev-amount)
            (print { action: "clear", user: user, stacker: prev-stacker, amount: prev-amount })
            (ok true)
          )
          (let (
            (stacker-sum (get-stacker-total prev-stacker))
            (global-sum (var-get total-assigned))
          )
            (map-set user-assign user { stacker: prev-stacker, amount: (- prev-amount amount) })
            (map-set stacker-total prev-stacker (- stacker-sum amount))
            (var-set total-assigned (- global-sum amount))
            (print { action: "reduce", user: user, stacker: prev-stacker, amount: amount })
            (ok true)
          )
        )
      )
      (begin
          (print { action: "withdraw", user: user, stacker: none, amount: amount })
          (ok true)
      )
    )
  )
)

;; ---------------------------------------------------------
;; Stale delegation cleanup
;; ---------------------------------------------------------
;; If a user sells their jSTX, their delegation entry overstates
;; their actual stake. This checks wallet balance only.
;; A future authorized contract can account for DeFi positions
;; (Zest, etc.) and call reduce directly with the correct excess.
;; Mirrors StackingDAO direct-helpers-v4 update-direct-stacking.

(define-read-only (get-assign-info (user principal))
  (let (
    (delegation (map-get? user-assign user))
    (delegated-stx (default-to u0 (get amount delegation)))
    (jstx-balance (unwrap-panic (contract-call? .jstx-token get-balance user)))
  )
    {
      delegated-stx: delegated-stx,
      jstx-balance: jstx-balance,
      excess: (if (> delegated-stx jstx-balance)
        (- delegated-stx jstx-balance)
        u0
      )
    }
  )
)

(define-public (update (user principal))
  (let (
    (info (get-assign-info user))
    (excess (get excess info))
  )
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (if (> excess u0)
      (reduce user excess)
      (ok true)
    )
  )
)

(define-private (remove-delegation (user principal) (stacker principal) (amount uint))
  (let (
    (stacker-sum (get-stacker-total stacker))
    (global-sum (var-get total-assigned))
  )
    (map-delete user-assign user)
    (map-set stacker-total stacker (- stacker-sum amount))
    (var-set total-assigned (- global-sum amount))
    true
  )
)
