;; Title: share-data
;;
;; What this contract does:
;; This is the data store for the sBTC reward tracking system.
;; It holds ALL the state that the share contract (the math brain) reads
;; and writes. We separate data from logic so the logic contract can be
;; upgraded without migrating data.
;;
;; Key concepts:
;; - "global-index": a counter that increases every time sBTC rewards
;;   are added. Scaled by 1e10 for precision. Represents total rewards
;;   per jSTX since genesis.
;; - "wallet-snapshot": per-wallet record of (a) their index at last
;;   settlement and (b) their jSTX balance at that time. The difference
;;   between global-index and their snapshot tells us unclaimed rewards.
;; - "defi-adapters": external protocols (like Zest) where jSTX can be
;;   deposited as collateral. Holders in DeFi still earn sBTC rewards.
;;
;; Inspired by: StackingDAO ststxbtc-tracking-data.clar
;; Source: stacking-dao/contracts/version-3/ststxbtc-tracking-data.clar

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u3001))

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Global cumulative reward index per jSTX, scaled by 1e10.
;; Increases every time sBTC rewards are distributed to the system.
(define-data-var global-index uint u0)

;; Total jSTX supply tracked here (may differ from ft supply during mint/burn)
(define-data-var tracked-supply uint u0)

;; Per-wallet snapshot: their index value and jSTX balance at last settlement
(define-map wallet-snapshot principal
  {
    index: uint,     ;; snapshot of global-index at last settlement
    balance: uint    ;; jSTX balance at last settlement
  }
)

;; External DeFi protocols that hold jSTX on behalf of users
;; e.g. Zest lending pool -- registered here so share.clar knows to query them
(define-map defi-adapters principal bool)

;; ---------------------------------------------------------
;; Read-only functions
;; ---------------------------------------------------------

(define-read-only (get-global-index)
  (var-get global-index)
)

(define-read-only (get-tracked-supply)
  (var-get tracked-supply)
)

(define-read-only (get-wallet-snapshot (who principal))
  (default-to
    { index: u0, balance: u0 }
    (map-get? wallet-snapshot who)
  )
)

(define-read-only (is-defi-adapter (protocol principal))
  (default-to false (map-get? defi-adapters protocol))
)

;; ---------------------------------------------------------
;; Protocol-only setters (only callable by authorized contracts)
;; ---------------------------------------------------------

(define-public (set-global-index (new-value uint))
  (begin
    (try! (contract-call? .dao guard-protocol))
    (ok (var-set global-index new-value))
  )
)

(define-public (set-tracked-supply (new-value uint))
  (begin
    (try! (contract-call? .dao guard-protocol))
    (ok (var-set tracked-supply new-value))
  )
)

(define-public (set-wallet-snapshot (who principal) (snapshot { index: uint, balance: uint }))
  (begin
    (try! (contract-call? .dao guard-protocol))
    (ok (map-set wallet-snapshot who snapshot))
  )
)

(define-public (set-defi-adapter (protocol principal) (active bool))
  (begin
    (try! (contract-call? .dao guard-admin))
    (ok (map-set defi-adapters protocol active))
  )
)
