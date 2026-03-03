;; Title: sbtc-mock
;;
;; What this contract does:
;; A minimal sBTC token for local testing. Implements SIP-010 so other
;; contracts can call transfer/get-balance the same way they would with
;; real sBTC on mainnet (SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token).
;;
;; It adds a public `mint` function so tests can give wallets sBTC.
;; On mainnet this contract is replaced by the real sBTC contract.
;;
;; This is a TEST-ONLY contract -- never deployed to mainnet.

(impl-trait .sip-010-trait.sip-010-trait)

(define-fungible-token sbtc)

(define-constant ERR_NOT_AUTHORIZED (err u9001))

;; ---------------------------------------------------------
;; SIP-010 implementation
;; ---------------------------------------------------------

(define-public (transfer (amount uint) (from principal) (to principal) (memo (optional (buff 34))))
  (begin
    (asserts! (is-eq tx-sender from) ERR_NOT_AUTHORIZED)
    (ft-transfer? sbtc amount from to)
  )
)

(define-read-only (get-name)
  (ok "sBTC (Mock)")
)

(define-read-only (get-symbol)
  (ok "sBTC")
)

(define-read-only (get-decimals)
  (ok u8)
)

(define-read-only (get-balance (who principal))
  (ok (ft-get-balance sbtc who))
)

(define-read-only (get-total-supply)
  (ok (ft-get-supply sbtc))
)

(define-read-only (get-token-uri)
  (ok none)
)

;; ---------------------------------------------------------
;; Test helper -- mint sBTC to any address
;; ---------------------------------------------------------

(define-public (mint (amount uint) (recipient principal))
  (ft-mint? sbtc amount recipient)
)
