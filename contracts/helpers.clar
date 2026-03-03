;; Title: helpers
;;
;; What this contract does:
;; This is the multi-signer router. When the protocol needs to deposit STX
;; into stacking or withdraw it, this contract figures out WHICH signer pool
;; to use based on the registry's active signers and allocations.
;;
;; Why it exists:
;; The core contract shouldn't care about which signer pool is active.
;; It just calls helpers.route-to-signer() and this contract:
;; 1. Looks up active signers from the registry
;; 2. Routes STX to the correct pool based on allocation weights
;; 3. Handles the delegate-stx calls via the stacking trait
;;
;; This is what makes multi-signer work without changing the core contract.
;; When we add a new signer, we just update the registry -- helpers
;; automatically routes STX to them.
;;
;; For launch with a single signer, this just passes through to one pool.
;; The abstraction costs nothing but gives us multi-signer for free later.
;;
;; Inspired by: StackingDAO direct-helpers-v4.clar
;; Source: stacking-dao/contracts/version-2/direct-helpers-v4.clar

(use-trait stacking-trait .stacking-trait.stacking-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u13001))
(define-constant ERR_NO_SIGNERS (err u13002))
(define-constant BPS u10000)

;; ---------------------------------------------------------
;; Route deposit to a specific signer pool
;; ---------------------------------------------------------

;; Deposit STX into a specific signer pool. The strategy/keeper calls this
;; after calculating how much each pool should receive.
;; The pool-contract must implement stacking-trait.
(define-public (route-to-signer (pool-contract <stacking-trait>) (amount uint) (stacker principal))
  (begin
    (try! (contract-call? .dao guard-protocol))
    (try! (contract-call? pool-contract delegate-stx amount stacker))
    (print { action: "route-to-signer", pool: (contract-of pool-contract), amount: amount, stacker: stacker })
    (ok true)
  )
)

;; Withdraw STX from a specific signer pool back to the vault.
(define-public (recall-from-signer (pool-contract <stacking-trait>) (stacker principal) (amount uint))
  (begin
    (try! (contract-call? .dao guard-protocol))
    (try! (contract-call? pool-contract return-stx stacker amount))
    (print { action: "recall-from-signer", pool: (contract-of pool-contract), stacker: stacker, amount: amount })
    (ok true)
  )
)

;; Revoke delegation from a specific pool.
(define-public (revoke-from-signer (pool-contract <stacking-trait>) (stacker principal))
  (begin
    (try! (contract-call? .dao guard-protocol))
    (try! (contract-call? pool-contract revoke-delegate-stx stacker))
    (print { action: "revoke-from-signer", pool: (contract-of pool-contract), stacker: stacker })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Read-only: calculate allocation per signer
;; ---------------------------------------------------------

;; Given a total STX amount to stake, calculate how much a specific signer
;; should receive based on its allocation in the registry.
(define-read-only (get-signer-share (signer principal) (total-stx uint))
  (let (
    (weight (contract-call? .registry get-signer-allocation signer))
  )
    (/ (* total-stx weight) BPS)
  )
)
