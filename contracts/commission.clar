;; Title: commission
;;
;; What this contract does:
;; This is the fee splitter for sBTC rewards. Before sBTC reaches jSTX
;; holders, a commission is taken. This contract decides where that
;; commission goes.
;;
;; The split:
;; - Treasury: the protocol keeps a portion (for operations, development)
;; - The rest could go to governance stakers in the future
;;
;; The commission RATE is not set here -- it's per-pool in the registry.
;; This contract only handles the commission AMOUNT after it's been
;; calculated by the yield contract.
;;
;; By using a trait, governance can deploy a new commission contract with
;; different split logic and swap it in without touching the yield pipeline.
;;
;; Inspired by: StackingDAO commission-btc-v1.clar
;; Source: stacking-dao/contracts/version-3/commission-btc-v1.clar

(impl-trait .commission-trait.commission-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u8001))

;; Treasury address -- receives protocol's share of commission.
;; In production, this would be a multisig or DAO treasury contract.
(define-constant PROTOCOL_TREASURY tx-sender)

;; ---------------------------------------------------------
;; Commission processing
;; ---------------------------------------------------------

;; Takes an sBTC amount (already calculated as the commission portion)
;; and sends it to the treasury.
;;
;; In the future, this could split between treasury + governance stakers.
;; For now, 100% goes to treasury.
(define-public (process (sbtc-amount uint))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (if (> sbtc-amount u0)
      (try! (as-contract (contract-call? .sbtc-mock transfer sbtc-amount tx-sender PROTOCOL_TREASURY none)))
      true
    )
    (print { action: "commission", amount: sbtc-amount, treasury: PROTOCOL_TREASURY })
    (ok true)
  )
)
