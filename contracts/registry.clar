;; Title: registry
;;
;; What this contract does:
;; This is the central directory for all signer pools in STX Juice.
;; It tracks which signers are active, how much STX each should receive
;; (as a percentage), and what commission rate each signer charges.
;;
;; Why multi-signer matters:
;; Even though we start with a single signer (ourselves or Fast Pool),
;; the protocol is designed to scale to multiple institutional signers
;; like StackingDAO does (ALUM Labs, Chorus One, Kiln, etc.).
;; Each signer runs their own pool contract and sets their own
;; PoX reward address and signer key. This registry tracks them all.
;;
;; How it works:
;; - "signers" is the list of active signer pool contract addresses.
;; - Each signer has an "allocation" (basis points out of 10,000) controlling
;;   what share of total STX it receives. All allocations must sum to 10,000.
;; - Each signer has a "fee" (basis points) -- the protocol's commission
;;   on rewards from that signer. Can differ per signer.
;; - Each signer can optionally have an "operator-cut" -- a portion of the
;;   commission that goes directly to the signer operator as revenue share.
;; - Signers also track their delegate contracts (thin STX-holding contracts
;;   that do the actual pox-4 delegation). Each signer can have multiple
;;   delegates so we can rotate/stop one without unlocking all STX.
;;
;; Inspired by: StackingDAO data-pools-v1.clar
;; Source: stacking-dao/contracts/version-2/data-pools-v1.clar

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u2001))
(define-constant ERR_SIGNER_NOT_FOUND (err u2002))
(define-constant BPS u10000) ;; basis points denominator

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Active signer pool contracts (up to 30)
(define-data-var signers (list 30 principal) (list))

;; Default commission rate if a signer doesn't have a custom one (5% = 500 bps)
(define-data-var base-fee uint u500)

;; How much STX each signer should get, in basis points (must sum to 10,000)
;; e.g. signer-A = 5000 (50%), signer-B = 3000 (30%), signer-C = 2000 (20%)
(define-map signer-allocation principal uint)

;; Per-signer commission rate in basis points (overrides base-fee)
;; e.g. our own signer = 500 (5%), fast-pool = 300 (3%)
(define-map signer-fee principal uint)

;; Optional: signer operator gets a cut of the commission
;; share is in basis points of the commission (not of total rewards)
;; e.g. { receiver: SP_ALUM_LABS, share: u2000 } means ALUM gets 20% of the 5% commission
(define-map operator-cut principal { receiver: principal, share: uint })

;; Which delegate contracts belong to each signer (up to 10 per signer)
;; Delegates are thin contracts that hold STX and call pox-4.delegate-stx
(define-map signer-delegates principal (list 10 principal))

;; How STX is split among delegates within a single signer (basis points)
;; e.g. delegate-1 = 5000 (50%), delegate-2 = 3000 (30%), delegate-3 = 2000 (20%)
(define-map delegate-allocation principal uint)

;; ---------------------------------------------------------
;; Read-only functions
;; ---------------------------------------------------------

(define-read-only (get-signers)
  (var-get signers)
)

(define-read-only (get-signer-allocation (signer principal))
  (default-to u0 (map-get? signer-allocation signer))
)

(define-read-only (get-signer-fee (signer principal))
  (default-to (var-get base-fee) (map-get? signer-fee signer))
)

(define-read-only (get-operator-cut (signer principal))
  (default-to { receiver: signer, share: u0 } (map-get? operator-cut signer))
)

(define-read-only (get-signer-delegates (signer principal))
  (default-to (list) (map-get? signer-delegates signer))
)

(define-read-only (get-delegate-allocation (delegate principal))
  (default-to u0 (map-get? delegate-allocation delegate))
)

(define-read-only (get-base-fee)
  (var-get base-fee)
)

;; ---------------------------------------------------------
;; Governor functions (gated by DAO)
;; ---------------------------------------------------------

(define-public (set-signers (new-signers (list 30 principal)))
  (begin
    (try! (contract-call? .dao guard-admin))
    (ok (var-set signers new-signers))
  )
)

(define-public (set-base-fee (rate uint))
  (begin
    (try! (contract-call? .dao guard-admin))
    (ok (var-set base-fee rate))
  )
)

(define-public (set-signer-allocation (signer principal) (alloc uint))
  (begin
    (try! (contract-call? .dao guard-admin))
    (ok (map-set signer-allocation signer alloc))
  )
)

(define-public (set-signer-fee (signer principal) (rate uint))
  (begin
    (try! (contract-call? .dao guard-admin))
    (ok (map-set signer-fee signer rate))
  )
)

(define-public (set-operator-cut (signer principal) (receiver principal) (cut uint))
  (begin
    (try! (contract-call? .dao guard-admin))
    (ok (map-set operator-cut signer { receiver: receiver, share: cut }))
  )
)

(define-public (set-signer-delegates (signer principal) (delegates (list 10 principal)))
  (begin
    (try! (contract-call? .dao guard-admin))
    (ok (map-set signer-delegates signer delegates))
  )
)

(define-public (set-delegate-allocation (delegate principal) (alloc uint))
  (begin
    (try! (contract-call? .dao guard-admin))
    (ok (map-set delegate-allocation delegate alloc))
  )
)
