;; Title: Commission Trait
;; Purpose: Interface for fee-splitting strategies. The protocol takes a cut of
;;          sBTC yield before distributing to jSTX holders. By using a trait,
;;          we can swap commission logic (e.g. change fee %, add revenue share)
;;          via DAO governance without touching the yield pipeline.
;; Inspired by: StackingDAO commission-trait-v1.clar

(define-trait commission-trait
  (
    ;; Takes sBTC commission amount, splits it according to strategy.
    ;; Returns the amount that was processed.
    (process (uint) (response bool uint))
  )
)
