;; Title: Stacker Trait
;; Purpose: Interface for stacker contracts (thin STX + sBTC holders).
;;          Used by allocation to move STX and by yield to sweep rewards.

(use-trait vault-trait .vault-trait.vault-trait)
(use-trait pool-trait .pool-trait.pool-trait)

(define-trait stacker-trait
  (
    ;; Transfer unlocked STX from stacker back to vault.
    ;; ustx: micro-STX to transfer
    ;; vault: the vault contract to send STX to
    (stx-transfer (uint <vault-trait>) (response uint uint))

    ;; Release sBTC rewards: pays signer fee directly, sends net to recipient.
    ;; Called by yield.sweep-stacker.
    ;; Returns net amount sent, fee paid to signer, and signer principal.
    ;; recipient: the yield contract address
    ;; pool-contract: the pool to read signer/fee from (asserted against stored pool var)
    (release-rewards (principal <pool-trait>) (response { amount: uint, fee: uint, signer: principal } uint))
  )
)
