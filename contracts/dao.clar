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
;; 2. "governors" -- wallet addresses that can update the authorized/governor lists.
;;    Initially just the deployer, later controlled by governance.
;;
;; How it works:
;; - Other contracts call (contract-call? .dao guard-protocol) and the DAO
;;   checks if the caller (contract-caller) is in the authorized map.
;; - Admin functions call (contract-call? .dao guard-admin) and the DAO
;;   checks if the sender (tx-sender) is in the governors map.
;;
;; Inspired by: StackingDAO dao.clar
;; Source: stacking-dao/contracts/dao.clar

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_NOT_GOVERNOR (err u1001))
(define-constant ERR_NOT_AUTHORIZED (err u1002))

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Which contracts are authorized to call privileged functions
(define-map authorized principal bool)

;; Which wallets can govern the protocol
(define-map governors principal bool)

;; Bootstrap: deployer is the first governor
(map-set governors tx-sender true)

;; ---------------------------------------------------------
;; Authorization checks -- called by other contracts
;; ---------------------------------------------------------

(define-read-only (is-authorized (who principal))
  (default-to false (map-get? authorized who))
)

(define-read-only (is-governor (who principal))
  (default-to false (map-get? governors who))
)

(define-public (guard-protocol)
  (ok (asserts! (is-authorized contract-caller) ERR_NOT_AUTHORIZED))
)

(define-public (guard-admin)
  (ok (asserts! (is-governor tx-sender) ERR_NOT_GOVERNOR))
)

;; ---------------------------------------------------------
;; Governor functions
;; ---------------------------------------------------------

(define-public (authorize (who principal) (active bool))
  (begin
    (try! (guard-admin))
    (ok (map-set authorized who active))
  )
)

(define-public (set-governor (who principal) (active bool))
  (begin
    (try! (guard-admin))
    (ok (map-set governors who active))
  )
)
