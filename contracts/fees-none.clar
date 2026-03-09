;; Title: fees-none
;; No-op fees contract. Always returns 0 fee.
;; Use this when fees are not active. Swap to a real fees contract later.

(impl-trait .fees-trait.fees-trait)

(define-public (pay (ustx uint) (sponsor (optional principal)))
  (ok u0)
)
