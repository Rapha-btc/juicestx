;; Title: dao
;;
;; What this contract does:
;; This is the permission gate for the entire STX Juice protocol.
;; Every privileged action (minting jSTX, moving STX from the vault,
;; updating reward tracking) checks with this contract first.
;;
;; It maintains two whitelists:
;; 1. "authorized" -- smart contracts allowed to call other protocol contracts.
;;    For example, the core contract needs permission to mint jSTX tokens.
;; 2. "admins" -- wallet addresses that can update the authorized/admin lists.
;;    Initially just the deployer, later controlled by governance.
;;
;; How it works:
;; - Other contracts call (contract-call? .dao check-is-authorized) and the DAO
;;   checks if the caller (contract-caller) is in the authorized map.
;; - Admin functions call (contract-call? .dao check-is-admin) and the DAO
;;   checks if the sender (tx-sender) is in the admins map.
;;
;; Inspired by: StackingDAO dao.clar
;; Source: stacking-dao/contracts/dao.clar

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_NOT_ADMIN (err u1001))
(define-constant ERR_NOT_AUTHORIZED (err u1002))
(define-constant ERR_PROTOCOL_NOT_LIVE (err u1003))

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Global kill switch -- admins can freeze all protocol operations
(define-data-var protocol-live bool true)

;; Which contracts are authorized to call privileged functions
(define-map authorized principal bool)

;; Which wallets can administer the protocol
(define-map admins principal bool)

;; ---------------------------------------------------------
;; Authorization checks -- called by other contracts
;; ---------------------------------------------------------

(define-read-only (get-protocol-live)
  (var-get protocol-live)
)

(define-read-only (is-authorized (who principal))
  (default-to false (map-get? authorized who))
)

(define-read-only (is-admin (who principal))
  (default-to false (map-get? admins who))
)

(define-public (check-is-live)
  (ok (asserts! (var-get protocol-live) ERR_PROTOCOL_NOT_LIVE))
)

(define-public (check-is-authorized (who principal))
  (ok (asserts! (is-authorized who) ERR_NOT_AUTHORIZED))
)

(define-public (check-is-admin (who principal))
  (ok (asserts! (is-admin who) ERR_NOT_ADMIN))
)

;; ---------------------------------------------------------
;; Admin functions
;; ---------------------------------------------------------

(define-public (set-protocol-live (enabled bool))
  (begin
    (try! (check-is-admin tx-sender))
    (ok (var-set protocol-live enabled))
  )
)

(define-public (set-authorized (who principal) (active bool))
  (begin
    (try! (check-is-admin tx-sender))
    (ok (map-set authorized who active))
  )
)

(define-public (set-admin (who principal) (active bool))
  (begin
    (try! (check-is-admin tx-sender))
    (ok (map-set admins who active))
  )
)

;; ---------------------------------------------------------
;; Bootstrap
;; ---------------------------------------------------------

(begin
  ;; Deployer is the first admin
  (map-set admins tx-sender true)
  (map-set authorized tx-sender true)

  ;; Authorize protocol contracts
  (map-set authorized .core true)
  (map-set authorized .vault true)
  (map-set authorized .pool true)
  (map-set authorized .helpers true)
  (map-set authorized .commission true)
  (map-set authorized .share true)
  (map-set authorized .share-data true)
  (map-set authorized .jstx-token true)
  (map-set authorized .yield true)
  (map-set authorized .withdraw-nft true)
)
