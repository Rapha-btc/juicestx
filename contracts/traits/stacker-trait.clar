;; Title: Stacking Trait
;; Purpose: Interface for pool/signer contracts that interact with PoX-4.
;;          Each signer (e.g. our own, Fast Pool, ALUM Labs) deploys a contract
;;          implementing this trait. The helpers contract routes STX to whichever
;;          pool the registry says is active, without the core contract needing
;;          to know which signer is being used.
;; Inspired by: StackingDAO stacking-pool-trait.clar

(define-trait stacker-trait
  (
    ;; Transfer unlocked STX from stacker back to a recipient (vault).
    ;; amount: micro-STX to transfer
    ;; recipient: where to send the STX (typically the vault)
    (stx-transfer (uint principal) (response bool uint))

    ;; Release sBTC rewards: pays signer fee directly, sends net to recipient.
    ;; Called by yield.sweep-stacker.
    ;; Returns net amount sent, fee paid to signer, and signer principal.
    ;; recipient: the yield contract address
    (release-rewards (principal) (response { amount: uint, fee: uint, signer: principal } uint))
  )
)
