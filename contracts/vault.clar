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

(impl-trait .vault-trait.vault-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u7001))
(define-constant ERR_INSUFFICIENT_BALANCE (err u7002))

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; STX earmarked for pending withdrawals -- stacker must not touch this
(define-data-var reserved-stx uint u0)

;; ---------------------------------------------------------
;; Public functions (protocol-only)
;; ---------------------------------------------------------

;; Receive STX into the vault. Called by core.clar when a user deposits.
;; The STX is transferred from tx-sender (the user) to this contract.
(define-public (receive (amount uint))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (stx-transfer? amount tx-sender (as-contract tx-sender))
  )
)

;; Release STX from the vault to a recipient. Called by core.clar on
;; user withdrawal, or by delegate contracts pulling STX for stacking.
(define-public (release (amount uint) (recipient principal))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (as-contract (stx-transfer? amount tx-sender recipient))
  )
)

;; Reserve STX for a pending withdrawal. No STX moves, just accounting.
;; Stacker should only take (balance - reserved) for delegation.
(define-public (reserve (amount uint))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (ok (var-set reserved-stx (+ (var-get reserved-stx) amount)))
  )
)

;; Unreserve STX after final withdrawal completes.
(define-public (unreserve (amount uint))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (ok (var-set reserved-stx (- (var-get reserved-stx) amount)))
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

;; How much STX is sitting in the vault but not earmarked for withdrawals
(define-read-only (get-idle-balance)
  (ok (- (stx-get-balance (as-contract tx-sender)) (var-get reserved-stx)))
)

(define-read-only (get-reserved-stx)
  (var-get reserved-stx)
)

;; Total STX managed by the protocol (idle + reserved + stacked).
;; For now this just returns vault balance. When pool contracts are active,
;; this should also include STX locked in PoX via delegates.
;; TODO: add stacked-stx tracking when delegate contracts are wired up
(define-read-only (get-total-managed)
  (stx-get-balance (as-contract tx-sender))
)
