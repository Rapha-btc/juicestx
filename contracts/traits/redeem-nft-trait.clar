;; Title: Withdraw NFT Trait
;; Purpose: Interface for withdrawal receipt NFTs. Allows core to work
;;          with different withdrawal NFT implementations.

(define-trait redeem-nft-trait
  (
    (mint (uint uint principal) (response uint uint))
    (burn (uint) (response bool uint))
    (get-receipt (uint) (response (optional {stx-amount: uint, unlock-height: uint, owner: principal}) uint))
    (get-owner (uint) (response (optional principal) uint))
  )
)
