;; Title: fees-none
;; No-op fees contract. Always returns 0 fee.
;; Use this when fees are not active. Swap to a real fees contract later.

(impl-trait .fees-trait.fees-trait)

;; define-read-only is valid here: it satisfies impl-trait, and a caller's public
;; function can dispatch into it and still write state afterwards. Verified on
;; stxer sim cbb5fb1249c8359389e06b06f0e4c60c.
(define-read-only (get-fee (ustx uint) (sponsor (optional principal)))
  (ok u0)
)
