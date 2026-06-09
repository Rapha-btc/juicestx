;; title: juice-signer-manager
;; version: 0.2 (scaffold)
;; summary: Juice's PoX-5 signer. Registers as a signer, implements the pox-5
;;   callbacks, and routes claimed bond rewards into the jBTC reward engine.
;; description:
;;   Role split (see migration-jstx-to-pox5.md):
;;     - SIGNER  (this contract): register-signer, claim-rewards, the
;;       signer-manager-trait callbacks. Many stakers credit one signer.
;;     - STAKER  (juice-staker, multiple per signer): holds sBTC + STX and
;;       calls register-for-bond / stake. Lives in juice-staker.clar.
;;
;;   Reward routing: pox-5 claim-rewards pays the signer ONE sBTC lump covering
;;   both its bonds (jBTC) and STX-only stakes (jSTX), and its return value
;;   carries the split (bond-totals vs stx-rewards.earned). We forward the jBTC
;;   slice to jbtc-yield; the jSTX slice routes to the jSTX-pox5 engine (TODO).
;;
;;   !! SCAFFOLD -- validate-stake! is permissive (admit-all, pausable). The
;;   jSTX reward route and the bond/stx fee split are left as TODOs.

(use-trait signer-mgr .pox-5.signer-manager-trait)
(impl-trait .pox-5.signer-manager-trait)

(define-constant POX5 .pox-5)

(define-constant ERR_UNAUTHORIZED (err u100))
(define-constant ERR_PAUSED       (err u101))
(define-constant ERR_NOT_POX5     (err u102))

(define-data-var admin  principal tx-sender)
(define-data-var paused bool false)

;; -----------------------------------------------------------------------------
;; Admin
;; -----------------------------------------------------------------------------

(define-read-only (get-admin) (var-get admin))
(define-read-only (is-paused) (var-get paused))

(define-private (assert-admin)
  (ok (asserts! (is-eq contract-caller (var-get admin)) ERR_UNAUTHORIZED)))

(define-public (set-admin (new-admin principal))
  (begin (try! (assert-admin)) (ok (var-set admin new-admin))))

(define-public (set-paused (p bool))
  (begin (try! (assert-admin)) (ok (var-set paused p))))

;; -----------------------------------------------------------------------------
;; signer-manager-trait -- callbacks invoked BY pox-5 (contract-caller = pox-5)
;; -----------------------------------------------------------------------------

;; Admission gate. pox-5 register-for-bond / stake revert if this returns err.
(define-public (validate-stake!
    (staker principal)
    (first-index uint)
    (num-indexes uint)
    (amount-ustx uint)
    (amount-sats uint)
    (is-bond bool)
    (signer-calldata (optional (buff 500)))
  )
  (begin
    (asserts! (is-eq contract-caller POX5) ERR_NOT_POX5)
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (print { topic: "validate-stake", staker: staker, first-index: first-index,
      num-indexes: num-indexes, amount-ustx: amount-ustx, amount-sats: amount-sats, is-bond: is-bond })
    (ok true)
  )
)

;; Accounting hook on exit. pox-5 calls this in a match that ignores errors.
(define-public (checkpoint-staker
    (staker principal)
    (first-index uint)
    (num-indexes uint)
    (is-bond bool)
  )
  (begin
    (asserts! (is-eq contract-caller POX5) ERR_NOT_POX5)
    (print { topic: "checkpoint-staker", staker: staker, first-index: first-index,
      num-indexes: num-indexes, is-bond: is-bond })
    (ok true)
  )
)

;; -----------------------------------------------------------------------------
;; Signer registration (one-time)
;; -----------------------------------------------------------------------------

;; Requires a prior (contract-call? .pox-5 grant-signer-key ...) recording the
;; grant. as-contract makes tx-sender == this contract == the signer, satisfying
;; pox-5's (is-eq tx-sender signer).
(define-public (pox-register-signer
    (signer-manager <signer-mgr>)
    (signer-key (buff 33))
  )
  (begin
    (try! (assert-admin))
    (as-contract (contract-call? .pox-5 register-signer signer-manager signer-key))
  )
)

;; -----------------------------------------------------------------------------
;; Claim + route rewards
;; -----------------------------------------------------------------------------

;; Claim the signer's sBTC rewards (bonds + stx-only) from pox-5. NOT wrapped in
;; as-contract: pox-5 keys the payout on contract-caller, so this contract must
;; be the direct caller; the sBTC lands here. We then forward the jBTC slice
;; (bond-totals) into jbtc-yield for vesting/distribution.
(define-public (pox-claim-rewards
    (bond-periods (list 6 uint))
    (reward-cycle uint)
  )
  (begin
    (try! (assert-admin))
    (let (
        (result (try! (contract-call? .pox-5 claim-rewards bond-periods reward-cycle)))
        (bond-sbtc (get bond-totals result))
      )
      ;; forward the jBTC slice to its reward engine
      (if (> bond-sbtc u0)
        (begin
          (try! (as-contract (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer bond-sbtc tx-sender .jbtc-yield none)))
          (try! (contract-call? .jbtc-yield record-rewards bond-sbtc reward-cycle))
          true)
        true)
      ;; TODO: route (get earned (get stx-rewards result)) -> jSTX-pox5 engine
      (ok result)
    )
  )
)

;; -----------------------------------------------------------------------------
;; Read-only
;; -----------------------------------------------------------------------------

(define-read-only (whoami) (as-contract tx-sender))

;; sBTC this signer has earned in a given bond (not yet claimed)
(define-read-only (get-earned-bond (bond-index uint))
  (contract-call? .pox-5 get-earned (as-contract tx-sender) true bond-index))

(define-read-only (get-earned-stx (index uint))
  (contract-call? .pox-5 get-earned (as-contract tx-sender) false index))
