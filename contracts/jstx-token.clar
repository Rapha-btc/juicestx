;; Title: jstx-token
;;
;; What this contract does:
;; This is the jSTX fungible token -- the liquid stacking receipt token for
;; STX Juice. When you deposit STX into the protocol, you get jSTX back.
;; Your jSTX represents your share of the stacking pool and entitles you
;; to sBTC rewards proportional to your holdings.
;;
;; Key design: EVERY transfer, mint, and burn triggers a reward refresh.
;; Before any jSTX moves, the share contract calculates and pays out any
;; pending sBTC rewards to the affected wallets. This ensures no one can
;; game rewards by transferring right before a distribution.
;;
;; jSTX maintains a 1:1 ratio with STX (like stSTXbtc, not like stSTX).
;; The yield comes as separate sBTC payments, not as exchange rate changes.
;;
;; Token details:
;; - Name: "Juiced STX"
;; - Symbol: "jSTX"
;; - Decimals: 6 (same as STX)
;;
;; Inspired by: StackingDAO ststxbtc-token.clar
;; Source: stacking-dao/contracts/version-3/ststxbtc-token.clar

;; Mainnet: (impl-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)
(impl-trait .sip-010-trait.sip-010-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_NOT_PROTOCOL (err u5001))
(define-constant ERR_NOT_AUTHORIZED (err u5002))

;; ---------------------------------------------------------
;; Token definition
;; ---------------------------------------------------------
(define-fungible-token jstx)

;; ---------------------------------------------------------
;; SIP-010 implementation
;; ---------------------------------------------------------

(define-public (transfer (amount uint) (from principal) (to principal) (memo (optional (buff 34))))
  (let (
    (supply (ft-get-supply jstx))
  )
    (asserts! (is-eq tx-sender from) ERR_NOT_AUTHORIZED)
    ;; Refresh rewards for both wallets BEFORE moving tokens.
    ;; We pass each wallet's current balance + total supply so share
    ;; doesn't need to call back to this contract (avoiding circular dep).
    (try! (contract-call? .yield settle-wallet from (ft-get-balance jstx from) supply))
    (try! (contract-call? .yield settle-wallet to (ft-get-balance jstx to) supply))
    (try! (ft-transfer? jstx amount from to))
    (print { action: "transfer", amount: amount, from: from, to: to })
    (ok true)
  )
)

(define-read-only (get-name)
  (ok "Juiced STX")
)

(define-read-only (get-symbol)
  (ok "jSTX")
)

(define-read-only (get-decimals)
  (ok u6)
)

(define-read-only (get-balance (who principal))
  (ok (ft-get-balance jstx who))
)

(define-read-only (get-total-supply)
  (ok (ft-get-supply jstx))
)

(define-read-only (get-token-uri)
  (ok (some u"https://stxjuice.com/api/token/jstx"))
)

;; ---------------------------------------------------------
;; Protocol-only: mint and burn
;; ---------------------------------------------------------

;; Mint jSTX to a recipient (called by core.clar on deposit)
;; Refreshes the recipient's rewards first so their new balance
;; doesn't dilute their pending rewards.
(define-public (mint (amount uint) (recipient principal))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (try! (contract-call? .yield settle-wallet recipient (ft-get-balance jstx recipient) (ft-get-supply jstx)))
    (try! (ft-mint? jstx amount recipient))
    (print { action: "mint", amount: amount, recipient: recipient })
    (ok true)
  )
)

;; Burn jSTX from an owner (called by core.clar on withdraw)
;; Refreshes the owner's rewards first so they get paid before burning.
(define-public (burn (amount uint) (owner principal))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (try! (contract-call? .yield settle-wallet owner (ft-get-balance jstx owner) (ft-get-supply jstx)))
    (try! (ft-burn? jstx amount owner))
    (print { action: "burn", amount: amount, owner: owner })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Public: anyone can claim their own pending sBTC rewards
;; ---------------------------------------------------------

;; This is the public entry point for claiming rewards. It reads the
;; caller's balance and passes it to share.settle-wallet.
(define-public (claim-rewards)
  (contract-call? .yield settle-wallet tx-sender (ft-get-balance jstx tx-sender) (ft-get-supply jstx))
)
