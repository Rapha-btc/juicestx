;; Title: Vault Trait
;; Purpose: Interface for the STX vault. Allows core to be upgraded
;;          to use a different vault implementation without redeployment.

(define-trait vault-trait
  (
    (receive (uint) (response bool uint))
    (release (uint principal) (response bool uint))
    (reserve (uint) (response bool uint))
    (unreserve (uint) (response bool uint))
    (get-pending-balance () (response uint uint))
    ;; Raw balance + reserved. Callers that need the shortfall (reserved above
    ;; balance) must have both, because get-pending-balance floors at zero.
    (get-stackable-inputs () (response { balance: uint, reserved: uint } uint))
  )
)
