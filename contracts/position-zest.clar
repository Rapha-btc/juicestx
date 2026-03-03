;; Title: position-zest
;;
;; What this contract does:
;; This is a tiny adapter that tells the share contract how much jSTX
;; a user has deposited into Zest Protocol's lending pool.
;;
;; Why it matters:
;; If you deposit jSTX as collateral in Zest to borrow against it,
;; your jSTX leaves your wallet but you should still earn sBTC rewards.
;; The share contract calls this adapter to find out your Zest balance
;; and includes it in the reward calculation.
;;
;; This contract must be registered in share-data's defi-adapters map
;; for the share contract to trust it.
;;
;; Inspired by: StackingDAO position-zest-v2.clar
;; Source: stacking-dao/contracts/version-3/position-zest-v2.clar

(impl-trait .position-trait.position-trait)

;; Returns how much jSTX the given wallet has supplied to Zest
(define-read-only (get-balance (who principal))
  (contract-call? .zest-mock get-supplied-balance who)
)
