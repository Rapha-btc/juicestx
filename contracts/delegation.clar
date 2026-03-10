;; Title: delegation
;;
;; Tracks which stacker each user wants their STX delegated to.
;; Called by core on deposit / withdraw.
;;
;; Two operations:
;;   assign  -- user picks (or changes) stacker on deposit
;;            - pass none to clear preference (protocol allocates via registry)
;;   reduce  -- user withdraws some STX, decrease their delegation
;;
;; Inspired by: StackingDAO data-direct-stacking-v1.clar + direct-helpers-v4.clar
;; Source (data):  stacking-dao/contracts/version-2/data-direct-stacking-v1.clar
;; Source (logic): stacking-dao/contracts/version-3/direct-helpers-v4.clar

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; user -> { stacker, amount } -- which stacker and how much
(define-map user-delegation
  principal
  { stacker: principal, amount: uint }
)

;; stacker -> total STX directed to it by all users
(define-map stacker-total principal uint)

;; global sum of all user-directed STX
(define-data-var total-delegated uint u0)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

(define-read-only (get-user-delegation (user principal))
  (map-get? user-delegation user)
)

(define-read-only (get-stacker-total (stacker principal))
  (default-to u0 (map-get? stacker-total stacker))
)

(define-read-only (get-total-delegated)
  (var-get total-delegated)
)

;; ---------------------------------------------------------
;; Assign delegation on deposit
;; ---------------------------------------------------------

(define-public (assign (user principal) (stacker (optional principal)) (amount uint))
  (let (
    (current (map-get? user-delegation user))
  )
    (try! (contract-call? .dao check-is-authorized contract-caller))

    (if (is-some stacker)

      ;; User chose a stacker
      (begin
        ;; Remove previous delegation if any
        (if (is-some current)
          (let (
            (prev-stacker (get stacker (unwrap-panic current)))
            (prev-amount (get amount (unwrap-panic current)))
          )
            (remove-delegation user prev-stacker prev-amount)
          )
          false
        )

        ;; Add delegation to chosen stacker (prev amount carried forward if switching)
        (let (
          (chosen (unwrap-panic stacker))
          (prev-amount (default-to u0 (get amount current)))
          (new-amount (+ prev-amount amount))
          (stacker-sum (get-stacker-total chosen))
          (global-sum (var-get total-delegated))
        )
          (map-set user-delegation user { stacker: chosen, amount: new-amount })
          (map-set stacker-total chosen (+ stacker-sum new-amount))
          (var-set total-delegated (+ global-sum new-amount))
          (print { action: "assign", user: user, stacker: chosen, amount: new-amount })
          (ok true)
        )
      )

      ;; User passed none -> clear any existing delegation
      (begin
        (if (is-some current)
          (let (
            (prev-stacker (get stacker (unwrap-panic current)))
            (prev-amount (get amount (unwrap-panic current)))
          )
            (remove-delegation user prev-stacker prev-amount)
          )
          false
        )
        (print { action: "clear", user: user })
        (ok true)
      )
    )
  )
)

;; ---------------------------------------------------------
;; Reduce delegation on withdraw
;; ---------------------------------------------------------
;; If amount >= current delegation, clears it entirely.

(define-public (reduce (user principal) (amount uint))
  (let (
    (current (map-get? user-delegation user))
  )
    (try! (contract-call? .dao check-is-authorized contract-caller))

    (if (is-some current)
      (let (
        (cur-stacker (get stacker (unwrap-panic current)))
        (cur-amount (get amount (unwrap-panic current)))
      )
        (if (>= amount cur-amount)
          ;; Full removal
          (begin
            (remove-delegation user cur-stacker cur-amount)
            (print { action: "clear", user: user })
            (ok true)
          )
          ;; Partial reduction
          (let (
            (stacker-sum (get-stacker-total cur-stacker))
            (global-sum (var-get total-delegated))
          )
            (map-set user-delegation user { stacker: cur-stacker, amount: (- cur-amount amount) })
            (map-set stacker-total cur-stacker (- stacker-sum amount))
            (var-set total-delegated (- global-sum amount))
            (print { action: "reduce", user: user, stacker: cur-stacker, reduced-by: amount })
            (ok true)
          )
        )
      )
      ;; No delegation to reduce
      (ok true)
    )
  )
)

;; ---------------------------------------------------------
;; Private helpers
;; ---------------------------------------------------------

(define-private (remove-delegation (user principal) (stacker principal) (amount uint))
  (let (
    (stacker-sum (get-stacker-total stacker))
    (global-sum (var-get total-delegated))
  )
    (map-delete user-delegation user)
    (map-set stacker-total stacker (- stacker-sum amount))
    (var-set total-delegated (- global-sum amount))
    true
  )
)
