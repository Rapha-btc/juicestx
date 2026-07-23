;; Title: jstx-token
;;
;; What this contract does:
;; This is the jSTX fungible token -- the liquid stacking receipt token for
;; STX Juice. When you deposit STX into the protocol, you get jSTX back.
;; Your jSTX represents your share of the stacking pool and entitles you
;; to sBTC rewards proportional to your holdings.
;;
;; Key design: EVERY transfer, mint, and burn triggers a reward refresh
;; in the same transaction, AFTER the balance moves (StackingDAO order).
;; Pending rewards are computed from each wallet's STORED snapshot (their
;; old balance), so the old period is always paid correctly -- and the new
;; snapshot records the post-operation balance they actually hold. Settling
;; before the move (with pre-op reads) would store stale balances: senders
;; would keep earning on tokens they no longer own, and freshly minted
;; tokens would earn nothing until the next touch.
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

(impl-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

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
  (begin
    (asserts! (is-eq tx-sender from) ERR_NOT_AUTHORIZED)
    ;; Move FIRST, then settle with post-transfer balances. Pending is paid
    ;; from each wallet's stored snapshot (old balance), so nothing is lost;
    ;; the fresh snapshot records what they hold NOW. We pass balance +
    ;; supply so yield doesn't call back into this contract (no circular dep).
    (try! (ft-transfer? jstx amount from to))
    (let (
      (supply (ft-get-supply jstx))
    )
      (try! (contract-call? .yield settle-wallet from (ft-get-balance jstx from) supply))
      (try! (contract-call? .yield settle-wallet to (ft-get-balance jstx to) supply))
    )
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

;; Mint jSTX to a recipient (called by core.clar on deposit).
;; Mint first, then settle: pending is paid from the OLD snapshot (pre-mint
;; balance), and the fresh snapshot picks up the post-mint balance + supply
;; so the new tokens start earning immediately.
(define-public (mint (amount uint) (recipient principal))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (try! (ft-mint? jstx amount recipient))
    (try! (contract-call? .yield settle-wallet recipient (ft-get-balance jstx recipient) (ft-get-supply jstx)))
    (print { action: "mint", amount: amount, recipient: recipient })
    (ok true)
  )
)

;; Burn jSTX from an owner (called by core.clar on withdraw).
;; Burn first, then settle: the owner is still paid their pending (snapshot
;; covers the burned tokens through this moment), and the fresh snapshot +
;; tracked supply reflect the post-burn state.
(define-public (burn (amount uint) (owner principal))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (try! (ft-burn? jstx amount owner))
    (try! (contract-call? .yield settle-wallet owner (ft-get-balance jstx owner) (ft-get-supply jstx)))
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
