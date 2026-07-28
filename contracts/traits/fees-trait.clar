;; Title: Fees Trait
;; Purpose: Interface for fee CALCULATION only. The fees contract knows the
;;          rate; it never moves money. Core routes the funds itself, because
;;          only core knows where they currently sit (user wallet on deposit,
;;          vault on withdrawal) and a trait cannot be handed vault authority
;;          without giving arbitrary code the vault's whole balance.

(define-trait fees-trait
  (
    ;; Takes the total ustx amount and optional sponsor.
    ;; Returns the fee to charge. Must not transfer anything.
    ;; Sponsor can be used for referral tracking or fee splitting.
    (get-fee (uint (optional principal)) (response uint uint))
  )
)
