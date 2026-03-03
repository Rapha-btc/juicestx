;; Title: vault
;;
;; What this contract does:
;; This is the STX vault -- the single contract that holds all deposited STX.
;; Think of it as the protocol's bank account. When users deposit STX, it
;; comes here. When delegates need STX for stacking, they pull from here.
;; When users withdraw, STX is sent from here.
;;
;; It's intentionally simple -- just receive, release, and check balance.
;; All access is gated through the DAO so only authorized contracts can
;; move STX in or out.
;;
;; Inspired by: StackingDAO reserve-v1.clar
;; Source: stacking-dao/contracts/version-1/reserve-v1.clar

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u7001))
(define-constant ERR_INSUFFICIENT_BALANCE (err u7002))

;; ---------------------------------------------------------
;; Public functions (protocol-only)
;; ---------------------------------------------------------

;; Receive STX into the vault. Called by core.clar when a user deposits.
;; The STX is transferred from tx-sender (the user) to this contract.
(define-public (receive (amount uint))
  (begin
    (try! (contract-call? .dao guard-protocol))
    (stx-transfer? amount tx-sender (as-contract tx-sender))
  )
)

;; Release STX from the vault to a recipient. Called by core.clar on
;; user withdrawal, or by delegate contracts pulling STX for stacking.
(define-public (release (amount uint) (recipient principal))
  (begin
    (try! (contract-call? .dao guard-protocol))
    (as-contract (stx-transfer? amount tx-sender recipient))
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

;; How much STX is currently sitting in the vault (not stacked)
(define-read-only (get-idle-balance)
  (stx-get-balance (as-contract tx-sender))
)

;; Total STX managed by the protocol (idle + stacked).
;; For now this just returns idle balance. When pool contracts are active,
;; this should also include STX locked in PoX via delegates.
;; TODO: add stacked-stx tracking when delegate contracts are wired up
(define-read-only (get-total-managed)
  (stx-get-balance (as-contract tx-sender))
)
