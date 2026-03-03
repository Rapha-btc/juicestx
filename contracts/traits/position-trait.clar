;; Title: Position Trait
;; Purpose: Interface for DeFi protocol adapters (e.g. Zest lending).
;;          When jSTX is deposited as collateral in an external protocol,
;;          the holder still earns sBTC rewards. This trait lets the share
;;          contract query how much jSTX a wallet has locked in each DeFi
;;          protocol, so rewards are calculated correctly.
;; Inspired by: StackingDAO position-trait.clar

(define-trait position-trait
  (
    ;; Returns how much jSTX the given wallet has deposited in this protocol.
    (get-balance (principal) (response uint uint))
  )
)
