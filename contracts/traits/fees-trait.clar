;; Title: Fees Trait
;; Purpose: Interface for fee collection. The fees contract knows the rate
;;          and handles the transfer internally. Core just calls pay.
;; Inspired by: SP3XXMS38VTAWTVPE5682XSBFXPTH7XCPEBTX8AN2.yin

(define-trait fees-trait
  (
    ;; Takes the total ustx amount and optional sponsor.
    ;; Calculates and collects the fee. Returns the fee amount that was taken.
    ;; Sponsor can be used for referral tracking or fee splitting.
    (pay (uint (optional principal)) (response uint uint))
  )
)
