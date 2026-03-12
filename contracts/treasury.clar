;; Title: treasury
;;
;; Protocol treasury for STX fees.
;; Receives STX from vault (e.g. withdraw-pending fees).
;; Admin can withdraw to any address.
;;
;; sBTC commission goes through commission.clar, not here.
;; This contract is only for STX revenue streams.

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u9001))
(define-constant ERR_ZERO_AMOUNT (err u9002))

;; ---------------------------------------------------------
;; Public
;; ---------------------------------------------------------

;; Withdraw STX from treasury. Admin-only.
(define-public (withdraw (amount uint) (recipient principal))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (asserts! (> amount u0) ERR_ZERO_AMOUNT)
    (try! (as-contract (stx-transfer? amount tx-sender recipient)))
    (print { action: "treasury-withdraw", amount: amount, recipient: recipient })
    (ok amount)
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

(define-read-only (get-balance)
  (stx-get-balance (as-contract tx-sender))
)
