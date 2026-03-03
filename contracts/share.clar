;; Title: share
;;
;; What this contract does:
;; This is the "math brain" of the sBTC reward system. It calculates how
;; much sBTC each jSTX holder has earned and sends it to them.
;;
;; The algorithm (cumulative reward index):
;; 1. When sBTC rewards arrive, we DON'T loop through every holder.
;;    Instead we add (reward / total-supply) to a global counter called
;;    "global-index". This is O(1) regardless of holder count.
;; 2. Each holder has a snapshot of global-index from their last claim.
;;    Their pending reward = (global - snapshot) * their_balance.
;; 3. On every jSTX transfer/mint/burn, we "settle" the affected wallets:
;;    pay out pending sBTC and update their snapshot.
;;
;; Circular dependency note:
;; share does NOT call jstx-token -- that would create a cycle since
;; jstx-token calls share. Instead, the caller (jstx-token or core)
;; passes the wallet's current balance and total supply as parameters.
;;
;; DeFi integration:
;; If a holder deposits jSTX into Zest (or another DeFi protocol), they
;; still earn rewards. We query the DeFi protocol via the position trait
;; to find their deposited balance and include it in the calculation.
;;
;; Inspired by: StackingDAO ststxbtc-tracking.clar
;; Source: stacking-dao/contracts/version-3/ststxbtc-tracking.clar

(use-trait position-trait .position-trait.position-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u6001))
(define-constant INDEX_SCALE u10000000000) ;; 1e10 -- scaling factor for reward math

;; ---------------------------------------------------------
;; Core reward logic
;; ---------------------------------------------------------

;; Called by the yield contract when new sBTC rewards are ready to distribute.
;; Increases the global-index counter proportionally.
;; If total supply is 0, rewards are lost (shouldn't happen in practice).
(define-public (distribute-rewards (sbtc-amount uint))
  (let (
    (supply (contract-call? .share-data get-tracked-supply))
    (current-idx (contract-call? .share-data get-global-index))
    (new-idx (if (> supply u0)
      (+ current-idx (/ (* sbtc-amount INDEX_SCALE) supply))
      current-idx
    ))
  )
    (try! (contract-call? .dao guard-protocol))
    (try! (contract-call? .share-data set-global-index new-idx))
    (print { action: "distribute-rewards", sbtc-amount: sbtc-amount, new-index: new-idx })
    (ok true)
  )
)

;; Settle a wallet's reward position. This:
;; 1. Calculates their pending sBTC rewards
;; 2. Transfers the sBTC to them
;; 3. Updates their snapshot to the current global-index
;; 4. Updates their tracked balance to their current jSTX balance
;;
;; The caller (jstx-token) passes the wallet's current balance and the
;; total jSTX supply. This avoids a circular dependency -- share never
;; calls back to jstx-token.
(define-public (settle-wallet (who principal) (current-balance uint) (total-supply uint))
  (let (
    (idx (contract-call? .share-data get-global-index))
    (snap (contract-call? .share-data get-wallet-snapshot who))
    (snap-idx (get index snap))
    (snap-balance (get balance snap))
    (pending (if (> snap-balance u0)
      (/ (* snap-balance (- idx snap-idx)) INDEX_SCALE)
      u0
    ))
  )
    (try! (contract-call? .dao guard-protocol))
    ;; Pay out pending sBTC if any
    (if (> pending u0)
      (try! (as-contract (contract-call? .sbtc-mock transfer pending tx-sender who none)))
      true
    )
    ;; Update wallet snapshot with their current balance
    (try! (contract-call? .share-data set-wallet-snapshot who {
      index: idx,
      balance: current-balance
    }))
    ;; Update tracked supply
    (try! (contract-call? .share-data set-tracked-supply total-supply))
    (ok pending)
  )
)

;; Settle a wallet's position in a DeFi protocol (e.g. Zest).
;; Same math as settle-wallet but reads balance from the DeFi contract
;; instead of the jSTX token directly.
(define-public (settle-defi-position (who principal) (adapter <position-trait>))
  (let (
    (idx (contract-call? .share-data get-global-index))
    (snap (contract-call? .share-data get-wallet-snapshot who))
    (snap-idx (get index snap))
    (defi-balance (unwrap-panic (contract-call? adapter get-balance who)))
    (total-balance (+ (get balance snap) defi-balance))
    (pending (if (> total-balance u0)
      (/ (* total-balance (- idx snap-idx)) INDEX_SCALE)
      u0
    ))
  )
    (try! (contract-call? .dao guard-protocol))
    (asserts! (contract-call? .share-data is-defi-adapter (contract-of adapter)) ERR_UNAUTHORIZED)
    ;; Pay out pending sBTC if any
    (if (> pending u0)
      (try! (as-contract (contract-call? .sbtc-mock transfer pending tx-sender who none)))
      true
    )
    ;; Update wallet snapshot (keep wallet balance, DeFi is queried live)
    (try! (contract-call? .share-data set-wallet-snapshot who {
      index: idx,
      balance: (get balance snap)
    }))
    (ok pending)
  )
)

;; ---------------------------------------------------------
;; Read-only: check pending rewards without claiming
;; ---------------------------------------------------------

(define-read-only (get-unclaimed (who principal))
  (let (
    (idx (contract-call? .share-data get-global-index))
    (snap (contract-call? .share-data get-wallet-snapshot who))
    (snap-idx (get index snap))
    (snap-balance (get balance snap))
  )
    (if (> snap-balance u0)
      (/ (* snap-balance (- idx snap-idx)) INDEX_SCALE)
      u0
    )
  )
)
