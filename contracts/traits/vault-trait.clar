;; Title: Vault Trait
;; Purpose: Interface for the STX vault. Allows core to be upgraded
;;          to use a different vault implementation without redeployment.

(define-trait vault-trait
  (
    (receive (uint) (response bool uint))
    (release (uint principal) (response bool uint))
    (reserve (uint) (response bool uint))
    (unreserve (uint) (response bool uint))
    (get-idle-balance () (response uint uint))
  )
)
