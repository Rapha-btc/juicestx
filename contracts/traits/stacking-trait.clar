;; Title: Stacking Trait
;; Purpose: Interface for pool/signer contracts that interact with PoX-4.
;;          Each signer (e.g. our own, Fast Pool, ALUM Labs) deploys a contract
;;          implementing this trait. The helpers contract routes STX to whichever
;;          pool the registry says is active, without the core contract needing
;;          to know which signer is being used.
;; Inspired by: StackingDAO stacking-pool-trait.clar

(define-trait stacking-trait
  (
    ;; Delegate STX from a delegate contract to this pool for stacking.
    ;; amount: micro-STX to delegate
    ;; stacker: the delegate contract address holding the STX
    (delegate-stx (uint principal) (response bool uint))

    ;; Revoke a previous delegation.
    ;; stacker: the delegate contract to revoke
    (revoke-delegate-stx (principal) (response bool uint))

    ;; Return unlocked STX from stacking back to the vault.
    ;; stacker: the delegate contract
    ;; amount: micro-STX to return
    (return-stx (principal uint) (response bool uint))
  )
)
