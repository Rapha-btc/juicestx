;; Title: zest-mock
;;
;; What this contract does:
;; A minimal Zest Protocol lending pool mock for testing the position-zest
;; adapter. On mainnet, Zest lets users supply jSTX as collateral to borrow.
;; The position-zest contract queries Zest to find how much jSTX a user has
;; deposited, so the share contract can still distribute sBTC rewards to them.
;;
;; This mock tracks simple supply/withdraw balances per user.
;;
;; This is a TEST-ONLY contract -- never deployed to mainnet.

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Tracks how much each user has supplied
(define-map supplied-balance principal uint)

;; ---------------------------------------------------------
;; Public functions
;; ---------------------------------------------------------

(define-public (supply (amount uint) (who principal))
  (let (
    (current (default-to u0 (map-get? supplied-balance who)))
  )
    (ok (map-set supplied-balance who (+ current amount)))
  )
)

(define-public (withdraw (amount uint) (who principal))
  (let (
    (current (default-to u0 (map-get? supplied-balance who)))
  )
    (ok (map-set supplied-balance who (- current amount)))
  )
)

;; ---------------------------------------------------------
;; Read-only -- called by position-zest.clar
;; ---------------------------------------------------------

(define-read-only (get-supplied-balance (who principal))
  (ok (default-to u0 (map-get? supplied-balance who)))
)
