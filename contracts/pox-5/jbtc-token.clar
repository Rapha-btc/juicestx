;; Title: jbtc-token
;;
;; What this contract does:
;; This is the jBTC fungible token -- the liquid stacking receipt token for
;; STX Juice. When you deposit STX into the protocol, you get jBTC back.
;; Your jBTC represents your share of the stacking pool and entitles you
;; to sBTC rewards proportional to your holdings.
;;
;; Key design: EVERY transfer, mint, and burn triggers a reward refresh.
;; Before any jBTC moves, the share contract calculates and pays out any
;; pending sBTC rewards to the affected wallets. This ensures no one can
;; game rewards by transferring right before a distribution.
;;
;; jBTC maintains a 1:1 ratio with STX (like stSTXbtc, not like stSTX).
;; The yield comes as separate sBTC payments, not as exchange rate changes.
;;
;; Token details:
;; - Name: "Juiced BTC"
;; - Symbol: "jBTC"
;; - Decimals: 6 (same as STX)
;;
;; Inspired by: StackingDAO ststxbtc-token.clar
;; Source: stacking-dao/contracts/version-3/ststxbtc-token.clar

(impl-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_NOT_PROTOCOL (err u5001))
(define-constant ERR_NOT_AUTHORIZED (err u5002))

;; ---------------------------------------------------------
;; Token definition
;; ---------------------------------------------------------
(define-fungible-token jbtc)

;; ---------------------------------------------------------
;; SIP-010 implementation
;; ---------------------------------------------------------

(define-public (transfer (amount uint) (from principal) (to principal) (memo (optional (buff 34))))
  (let (
    (supply (ft-get-supply jbtc))
  )
    (asserts! (is-eq tx-sender from) ERR_NOT_AUTHORIZED)
    ;; Refresh rewards for both wallets BEFORE moving tokens.
    ;; We pass each wallet's current balance + total supply so share
    ;; doesn't need to call back to this contract (avoiding circular dep).
    (try! (contract-call? .jbtc-yield settle-wallet from (ft-get-balance jbtc from) supply))
    (try! (contract-call? .jbtc-yield settle-wallet to (ft-get-balance jbtc to) supply))
    (try! (ft-transfer? jbtc amount from to))
    (print { action: "transfer", amount: amount, from: from, to: to })
    (ok true)
  )
)

(define-read-only (get-name)
  (ok "Juiced BTC")
)

(define-read-only (get-symbol)
  (ok "jBTC")
)

(define-read-only (get-decimals)
  (ok u8)
)

(define-read-only (get-balance (who principal))
  (ok (ft-get-balance jbtc who))
)

(define-read-only (get-total-supply)
  (ok (ft-get-supply jbtc))
)

(define-read-only (get-token-uri)
  (ok (some u"https://stxjuice.com/api/token/jbtc"))
)

;; ---------------------------------------------------------
;; Protocol-only: mint and burn
;; ---------------------------------------------------------

;; Mint jBTC to a recipient (called by core.clar on deposit)
;; Refreshes the recipient's rewards first so their new balance
;; doesn't dilute their pending rewards.
(define-public (mint (amount uint) (recipient principal))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (try! (contract-call? .jbtc-yield settle-wallet recipient (ft-get-balance jbtc recipient) (ft-get-supply jbtc)))
    (try! (ft-mint? jbtc amount recipient))
    (print { action: "mint", amount: amount, recipient: recipient })
    (ok true)
  )
)

;; Burn jBTC from an owner (called by core.clar on withdraw)
;; Refreshes the owner's rewards first so they get paid before burning.
(define-public (burn (amount uint) (owner principal))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (try! (contract-call? .jbtc-yield settle-wallet owner (ft-get-balance jbtc owner) (ft-get-supply jbtc)))
    (try! (ft-burn? jbtc amount owner))
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
  (contract-call? .jbtc-yield settle-wallet tx-sender (ft-get-balance jbtc tx-sender) (ft-get-supply jbtc))
)
