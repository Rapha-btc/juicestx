;; Title: redeem-stx-nft
;;
;; What this contract does:
;; When a user wants to withdraw STX from STX Juice, their STX is locked
;; in PoX stacking and can't be returned immediately. So instead of waiting,
;; they get an NFT receipt that represents their claim.
;;
;; The NFT says: "You can redeem X amount of STX after block height Y."
;; Once the PoX cycle ends and STX is unlocked, they burn the NFT to get
;; their STX back.
;;
;; Bonus: the NFT has a built-in marketplace. If someone doesn't want to
;; wait for unlock, they can offer their withdrawal NFT for sale. A buyer
;; pays STX now and gets the right to claim the STX later.
;; This is non-custodial -- the NFT stays in the seller's wallet until bought.
;;
;; Inspired by: StackingDAO ststxbtc-withdraw-nft.clar
;; Source: stacking-dao/contracts/core/ststxbtc-withdraw-nft.clar

;; Mainnet: (impl-trait 'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.nft-trait.nft-trait)
(impl-trait 'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.nft-trait.nft-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u4001))
(define-constant ERR_NOT_OWNER (err u4002))
(define-constant ERR_NOT_FOUND (err u4003))
(define-constant ERR_ALREADY_OFFERED (err u4004))
(define-constant ERR_NOT_OFFERED (err u4005))
(define-constant ERR_WRONG_PRICE (err u4006))

;; ---------------------------------------------------------
;; NFT definition
;; ---------------------------------------------------------
(define-non-fungible-token withdrawal-receipt uint)

(define-data-var mint-counter uint u0)

;; ---------------------------------------------------------
;; Receipt data -- what each NFT represents
;; ---------------------------------------------------------

(define-map receipt-data uint
  {
    stx-amount: uint,       ;; how much STX this NFT is redeemable for
    unlock-height: uint,    ;; block height when STX becomes available
    owner: principal         ;; original owner (for reference, not authority)
  }
)

;; ---------------------------------------------------------
;; Marketplace -- offer/cancel/accept withdrawal NFTs
;; ---------------------------------------------------------

;; NFTs offered for sale: token-id -> price in micro-STX
(define-map offers uint uint)

;; ---------------------------------------------------------
;; SIP-009 implementation
;; ---------------------------------------------------------

(define-read-only (get-last-token-id)
  (ok (var-get mint-counter))
)

(define-read-only (get-token-uri (id uint))
  (ok (some u"https://stxjuice.com/api/withdrawal/{id}"))
)

(define-read-only (get-owner (id uint))
  (ok (nft-get-owner? withdrawal-receipt id))
)

(define-public (transfer (id uint) (from principal) (to principal))
  (begin
    (asserts! (is-eq tx-sender from) ERR_NOT_OWNER)
    (nft-transfer? withdrawal-receipt id from to)
  )
)

;; ---------------------------------------------------------
;; Protocol-only: mint and burn withdrawal receipts
;; ---------------------------------------------------------

(define-public (mint (stx-amount uint) (unlock-height uint) (recipient principal))
  (let (
    (new-id (+ (var-get mint-counter) u1))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (try! (nft-mint? withdrawal-receipt new-id recipient))
    (map-set receipt-data new-id {
      stx-amount: stx-amount,
      unlock-height: unlock-height,
      owner: recipient
    })
    (var-set mint-counter new-id)
    (ok new-id)
  )
)

(define-public (burn (id uint))
  (let (
    (owner (unwrap! (nft-get-owner? withdrawal-receipt id) ERR_NOT_FOUND))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (map-delete receipt-data id)
    (map-delete offers id)
    (nft-burn? withdrawal-receipt id owner)
  )
)

;; ---------------------------------------------------------
;; Read-only: receipt info
;; ---------------------------------------------------------

(define-read-only (get-nft-owner (id uint))
  (nft-get-owner? withdrawal-receipt id)
)

(define-read-only (get-receipt (id uint))
  (ok (map-get? receipt-data id))
)

(define-read-only (get-offer (id uint))
  (map-get? offers id)
)

;; ---------------------------------------------------------
;; Marketplace: offer / cancel / accept
;; ---------------------------------------------------------

;; Offer your withdrawal NFT for sale at a price (in micro-STX)
(define-public (offer-nft (id uint) (price uint))
  (let (
    (owner (unwrap! (nft-get-owner? withdrawal-receipt id) ERR_NOT_FOUND))
  )
    (asserts! (is-eq tx-sender owner) ERR_NOT_OWNER)
    (asserts! (is-none (map-get? offers id)) ERR_ALREADY_OFFERED)
    (ok (map-set offers id price))
  )
)

;; Remove your NFT from sale
(define-public (cancel-offer (id uint))
  (let (
    (owner (unwrap! (nft-get-owner? withdrawal-receipt id) ERR_NOT_FOUND))
  )
    (asserts! (is-eq tx-sender owner) ERR_NOT_OWNER)
    (asserts! (is-some (map-get? offers id)) ERR_NOT_OFFERED)
    (ok (map-delete offers id))
  )
)

;; Buy an offered withdrawal NFT -- pay the seller in STX, receive the NFT
(define-public (accept-offer (id uint) (expected-price uint))
  (let (
    (price (unwrap! (map-get? offers id) ERR_NOT_OFFERED))
    (seller (unwrap! (nft-get-owner? withdrawal-receipt id) ERR_NOT_FOUND))
  )
    (asserts! (is-eq price expected-price) ERR_WRONG_PRICE)
    (try! (stx-transfer? price tx-sender seller))
    (map-delete offers id)
    (nft-transfer? withdrawal-receipt id seller tx-sender)
  )
)
