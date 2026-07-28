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
    (stx-transfer? amount tx-sender current-contract)
  )
)

;; Release STX from the vault to a recipient. Called by core.clar on
;; user withdrawal, or by delegate contracts pulling STX for stacking.
(define-public (release (amount uint) (recipient principal))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (as-contract? ((with-stx amount))
      (try! (stx-transfer? amount current-contract recipient)))
  )
)

;; Escape hatch: move STX out with NO accounting, for migrations and recovery.
;; Mirrors StackingDAO reserve-v1.get-stx (version-1/reserve-v1.clar:111).
;;
;; NOTE the name is a mover, not a getter -- everything else prefixed get- in
;; this repo is read-only. Kept for parity with the reference implementation.
;;
;; Two deliberate differences from `release`:
;;   - no check-is-live. A hatch that stops working when the protocol is halted
;;     is not a hatch. reserve-v1.get-stx omits its check-is-enabled for the
;;     same reason, unlike its other movers.
;;   - touches no counters. reserved-stx is left alone, so after using this the
;;     vault's accounting is deliberately out of step with its balance.
;;
;; Using this while withdrawals are pending will strand them. Last resort only.
;;
;; SAFETY DEPENDS ON THE AUTHORIZED SET CONTAINING ONLY CONTRACTS.
;; check-is-authorized just tests membership of a principal -> bool map, and that
;; map accepts wallet addresses. StackingDAO's own list still carries the
;; multisig SM1SEBGTH...  that did their original wiring, so on mainnet a key can
;; call reserve-v1.get-stx against ~4M STX today. Keep EOAs out of `authorized`
;; and this is strictly tighter than theirs; add one and it is the whole vault.
(define-public (get-stx (amount uint) (recipient principal))
  (begin
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (as-contract? ((with-stx amount))
      (try! (stx-transfer? amount current-contract recipient)))
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
;; Floors at zero. reserved-stx is pure accounting and routinely exceeds the
;; vault's balance, because the STX backing a pending withdrawal is still locked
;; in a stacker until cycle end. An unguarded subtraction underflows, and in
;; Clarity that ABORTS -- which would brick allocation.return-excess, the only
;; path that brings STX back. Same guard StackingDAO uses in
;; strategy-v4.get-outflow-inflow.
(define-read-only (get-pending-balance)
  (let (
    (balance (stx-get-balance current-contract))
    (reserved (var-get reserved-stx))
  )
    (ok (if (> balance reserved) (- balance reserved) u0))
  )
)

;; Both raw numbers in one call, so the planner can do its own arithmetic.
;; get-pending-balance floors at zero, which hides HOW FAR short the vault is
;; when reserved > balance. allocation needs that magnitude: without it targets
;; stop shrinking, no stacker ever shows excess, and nothing gets pulled back.
;; Mirrors StackingDAO reserve-v1 exposing get-stx-balance and
;; get-stx-for-withdrawals raw, with strategy-v4 doing the subtraction.
(define-read-only (get-stackable-inputs)
  (ok {
    balance: (stx-get-balance current-contract),
    reserved: (var-get reserved-stx)
  })
)

(define-read-only (get-reserved-stx)
  (var-get reserved-stx)
)

;; Total STX in vault only. For protocol-wide total (vault + allocated to stackers),
;; see allocation.get-stacking-amounts.
(define-read-only (get-total-managed)
  (stx-get-balance current-contract)
)
