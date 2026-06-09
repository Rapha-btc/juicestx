;; title: juice-signer-manager
;; version: 0.1 (scaffold)
;; summary: Juice's signer-manager for PoX-5 jBTC pooled sBTC staking.
;; description:
;;   Implements `signer-manager-trait` (the callbacks PoX-5 invokes) and exposes
;;   admin/keeper wrappers around the PoX-5 calls Juice makes. This single
;;   contract plays BOTH roles in the PoX-5 model:
;;     - signer  : its own principal is the signer identity (registered once).
;;     - staker  : it holds the pool's sBTC + paired STX and registers the bond
;;                 under `as-contract`, so PoX-5 sees tx-sender == this contract.
;;
;;   See pox-5-functions-for-juice.md (same folder) for the full walkthrough.
;;
;;   !! SCAFFOLD - provisional against the `pox-wf-integration` source. Funds are
;;   assumed to already sit in this contract (treasury/vault wiring is out of scope
;;   here). validate-stake! is permissive (admit-all, pausable). Do not deploy.

(use-trait signer-mgr .pox-5.signer-manager-trait)
(impl-trait .pox-5.signer-manager-trait)

;; -----------------------------------------------------------------------------
;; Constants & errors
;; -----------------------------------------------------------------------------

(define-constant POX5 .pox-5)

(define-constant ERR_UNAUTHORIZED (err u100))
(define-constant ERR_PAUSED       (err u101))
(define-constant ERR_NOT_POX5     (err u102))

;; -----------------------------------------------------------------------------
;; State
;; -----------------------------------------------------------------------------

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
;; signer-manager-trait - callbacks invoked BY pox-5 (contract-caller = pox-5)
;; -----------------------------------------------------------------------------

;; Admission gate. PoX-5's `register-for-bond` / `stake` revert if this returns err.
;; Scaffold: admit everyone while not paused. Tighten with per-staker caps, KYB,
;; or a whitelist for production.
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
    (print {
      topic: "validate-stake",
      staker: staker,
      first-index: first-index,
      num-indexes: num-indexes,
      amount-ustx: amount-ustx,
      amount-sats: amount-sats,
      is-bond: is-bond,
    })
    (ok true)
  )
)

;; Accounting hook on exit. PoX-5 calls this in a `match` that ignores errors, so
;; it can never block an unstake. Snapshot jBTC share state here in production.
(define-public (checkpoint-staker
    (staker principal)
    (first-index uint)
    (num-indexes uint)
    (is-bond bool)
  )
  (begin
    (asserts! (is-eq contract-caller POX5) ERR_NOT_POX5)
    (print {
      topic: "checkpoint-staker",
      staker: staker,
      first-index: first-index,
      num-indexes: num-indexes,
      is-bond: is-bond,
    })
    (ok true)
  )
)

;; -----------------------------------------------------------------------------
;; PoX-5 wrappers - keeper/admin calls these; we drive pox-5 with the right frame.
;;
;; Each takes `signer-manager` (= this contract, .juice-signer-manager) so the
;; trait reference is forwarded rather than self-referenced. The keeper passes
;; `.juice-signer-manager`.
;; -----------------------------------------------------------------------------

;; One-time: claim a signer-key grant on-chain. Requires a prior
;; `(contract-call? .pox-5 grant-signer-key ...)` (permissionless; takes the
;; signer's 65-byte RSV SIP-018 grant signature) to have recorded the grant.
;; `as-contract` makes tx-sender == this contract == the signer, satisfying
;; pox-5's `(is-eq tx-sender signer)`.
(define-public (pox-register-signer
    (signer-manager <signer-mgr>)
    (signer-key (buff 33))
  )
  (begin
    (try! (assert-admin))
    (as-contract (contract-call? .pox-5 register-signer signer-manager signer-key))
  )
)

;; Stake the pool into a bond via the sBTC-custody (`err`) path. `as-contract`
;; makes tx-sender == this contract, so the contract's sBTC is custodied and its
;; paired STX is locked node-side. This contract must already hold >= `sats` sBTC.
(define-public (pox-register-for-bond
    (signer-manager <signer-mgr>)
    (bond-index uint)
    (amount-ustx uint)
    (sats uint)
  )
  (begin
    (try! (assert-admin))
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (as-contract
      (contract-call? .pox-5 register-for-bond
        bond-index signer-manager amount-ustx (err sats) none))
  )
)

;; Roll the position into a later bond (bond-index + 6). Same call as the initial
;; stake; pox-5 nets the sBTC delta and enforces the L1-unlock rollover window.
(define-public (pox-rollover-into-bond
    (signer-manager <signer-mgr>)
    (next-bond-index uint)
    (amount-ustx uint)
    (sats uint)
  )
  (pox-register-for-bond signer-manager next-bond-index amount-ustx sats))

;; Withdraw `sats` sBTC out of the current bond back to this contract.
;; `as-contract` so pox-5 sends the sBTC to this contract (the staker).
(define-public (pox-unstake-sbtc
    (signer-manager <signer-mgr>)
    (sats uint)
  )
  (begin
    (try! (assert-admin))
    (as-contract (contract-call? .pox-5 unstake-sbtc signer-manager sats))
  )
)

;; Claim accrued sBTC rewards. NOT wrapped in `as-contract`: pox-5 keys rewards on
;; `contract-caller`, so this contract must be the direct caller. The sBTC lands
;; in this contract (= the signer) for redistribution / compounding into jBTC.
(define-public (pox-claim-rewards
    (bond-periods (list 6 uint))
    (reward-cycle uint)
  )
  (begin
    (try! (assert-admin))
    (contract-call? .pox-5 claim-rewards bond-periods reward-cycle)
  )
)

;; -----------------------------------------------------------------------------
;; Read-only convenience pass-throughs (pre-flight)
;; -----------------------------------------------------------------------------

(define-read-only (get-this-contract) (as-contract tx-sender))

(define-read-only (get-earned-rewards (bond-index uint))
  (contract-call? .pox-5 get-earned (as-contract tx-sender) true bond-index))

(define-read-only (get-membership)
  (contract-call? .pox-5 get-bond-membership (as-contract tx-sender)))

(define-read-only (get-custodied-sbtc)
  (contract-call? .pox-5 get-staker-custodied-sbtc (as-contract tx-sender)))

(define-read-only (min-stx-for (bond-index uint) (sats uint))
  (match (contract-call? .pox-5 get-protocol-bond bond-index)
    bond (some (contract-call? .pox-5 min-ustx-for-sats-amount
                 sats (get stx-value-ratio bond) (get min-ustx-ratio bond)))
    none))
