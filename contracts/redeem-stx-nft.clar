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

(impl-trait 'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.nft-trait.nft-trait)
(use-trait commission-trait 'SP3D6PV2ACBPEKYJTCMH7HEN02KP87QSP8KTEH335.commission-trait.commission)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED u4001)
(define-constant ERR_NOT_OWNER u4002)
(define-constant ERR_NOT_FOUND u4003)
(define-constant ERR_LISTED u4004)
(define-constant ERR_NOT_LISTED u4005)
(define-constant ERR_WRONG_COMMISSION u4006)

;; ---------------------------------------------------------
;; NFT definition
;; ---------------------------------------------------------
(define-non-fungible-token redeem-nft uint)

(define-data-var last-id uint u0)
(define-data-var uri-root (string-ascii 210) "https://stxjuice.com/api/withdrawal/")

;; ---------------------------------------------------------
;; Receipt data -- what each NFT represents
;; ---------------------------------------------------------

(define-map receipt-data uint
  {
    ustx: uint,       ;; how much STX this NFT is redeemable for
    unlock-height: uint     ;; block height when STX becomes available
  }
)

;; ---------------------------------------------------------
;; Balance tracking + marketplace
;; ---------------------------------------------------------

(define-map token-count principal uint)
(define-map market uint { price: uint, commission: principal })

(define-read-only (get-balance (account principal))
  (default-to u0 (map-get? token-count account))
)

(define-read-only (get-listing-in-ustx (id uint))
  (map-get? market id)
)

;; ---------------------------------------------------------
;; SIP-009 implementation
;; ---------------------------------------------------------

(define-read-only (get-last-token-id)
  (ok (var-get last-id))
)

(define-read-only (get-token-uri (token-id uint))
  (ok (some (concat (concat (var-get uri-root) "{id}") ".json")))
)

(define-read-only (get-owner (id uint))
  (ok (nft-get-owner? redeem-nft id))
)

(define-public (transfer (id uint) (sender principal) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender sender) (err ERR_NOT_OWNER))
    (asserts! (is-none (map-get? market id)) (err ERR_LISTED))
    (try! (trnsfr id sender recipient))
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Internal transfer helper (updates token-count)
;; ---------------------------------------------------------

(define-private (trnsfr (id uint) (sender principal) (recipient principal))
  (match (nft-transfer? redeem-nft id sender recipient)
    success
      (let (
        (sender-balance (get-balance sender))
        (recipient-balance (get-balance recipient))
      )
        (map-set token-count sender (- sender-balance u1))
        (map-set token-count recipient (+ recipient-balance u1))
        (ok success)
      )
    error (err error)
  )
)

(define-private (is-sender-owner (id uint))
  (let (
    (owner (unwrap! (nft-get-owner? redeem-nft id) false))
  )
    (or (is-eq tx-sender owner) (is-eq contract-caller owner))
  )
)

;; ---------------------------------------------------------
;; Protocol-only: mint and burn withdrawal receipts
;; ---------------------------------------------------------

(define-public (mint (ustx uint) (unlock-height uint) (recipient principal))
  (let (
    (new-id (+ (var-get last-id) u1))
  )
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (try! (nft-mint? redeem-nft new-id recipient))
    (map-set receipt-data new-id {
      ustx: ustx,
      unlock-height: unlock-height
    })
    (map-set token-count recipient (+ (get-balance recipient) u1))
    (var-set last-id new-id)
    (ok new-id)
  )
)

(define-public (burn (id uint))
  (let (
    (owner (unwrap! (nft-get-owner? redeem-nft id) (err ERR_NOT_FOUND)))
  )
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (map-delete receipt-data id)
    (map-delete market id)
    (try! (nft-burn? redeem-nft id owner))
    (map-set token-count owner (- (get-balance owner) u1))
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Read-only: receipt info
;; ---------------------------------------------------------

(define-read-only (get-uri-root)
  (var-get uri-root)
)

(define-read-only (get-receipt (id uint))
  (ok (map-get? receipt-data id))
)

;; ---------------------------------------------------------
;; Admin
;; ---------------------------------------------------------

(define-public (set-uri-root (new-root (string-ascii 210)))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (ok (var-set uri-root new-root))
  )
)

;; ---------------------------------------------------------
;; Marketplace: list / unlist / buy
;; ---------------------------------------------------------

(define-public (list-in-ustx (id uint) (price uint) (comm-trait <commission-trait>))
  (let (
    (listing { price: price, commission: (contract-of comm-trait) })
  )
    (asserts! (is-sender-owner id) (err ERR_NOT_OWNER))
    (map-set market id listing)
    (print (merge listing { a: "list-in-ustx", id: id }))
    (ok true)
  )
)

(define-public (unlist-in-ustx (id uint))
  (begin
    (asserts! (is-sender-owner id) (err ERR_NOT_OWNER))
    (map-delete market id)
    (print { a: "unlist-in-ustx", id: id })
    (ok true)
  )
)

(define-public (buy-in-ustx (id uint) (comm-trait <commission-trait>))
  (let (
    (owner (unwrap! (nft-get-owner? redeem-nft id) (err ERR_NOT_FOUND)))
    (listing (unwrap! (map-get? market id) (err ERR_NOT_LISTED)))
    (price (get price listing))
  )
    (asserts! (is-eq (contract-of comm-trait) (get commission listing)) (err ERR_WRONG_COMMISSION))
    (try! (stx-transfer? price tx-sender owner))
    (try! (contract-call? comm-trait pay id price))
    (try! (trnsfr id owner tx-sender))
    (map-delete market id)
    (print { a: "buy-in-ustx", id: id })
    (ok true)
  )
)
