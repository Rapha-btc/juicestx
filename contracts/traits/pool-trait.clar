;; Title: Pool Trait
;; Purpose: Interface for pool contracts. Stackers use this to read
;;          their pool's btc-address, signer fee, and signer principal.

(define-trait pool-trait
  (
    (get-btc-address () (response { version: (buff 1), hashbytes: (buff 32) } uint))
    (get-signer-info () (response { signer: principal, fee: uint } uint))
  )
)
