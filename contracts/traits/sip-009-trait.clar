;; Title: SIP-009 Non-Fungible Token Trait
;; Purpose: Standard NFT interface used by the withdrawal receipt NFT.
;;          When users initiate a withdrawal, they receive an NFT that represents
;;          their claim on STX once the PoX cycle unlocks.
;; Reference: https://github.com/stacksgov/sips/blob/main/sips/sip-009/sip-009-nft-standard.md

(define-trait sip-009-trait
  (
    (get-last-token-id () (response uint uint))
    (get-token-uri (uint) (response (optional (string-ascii 256)) uint))
    (get-owner (uint) (response (optional principal) uint))
    (transfer (uint principal principal) (response bool uint))
  )
)
