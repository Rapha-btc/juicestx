;; Title: pool
;;
;; The signer's single touchpoint. One pool contract per signer.
;;
;; What it does:
;; - Stores signer key + signature each cycle
;; - Manages btc-address (Emily-registered reward address)
;; - Calls PoX-4 on behalf of its stacker contracts (lock, extend, increase, finalize)
;; - Sets the signer's fee rate
;;
;; What it interacts with:
;; - pox-4      → calls delegate-stack-stx, delegate-stack-extend, delegate-stack-increase,
;;                stack-aggregation-commit-indexed
;; - stacker    → calls delegate-stx / revoke-delegate-stx on its stackers
;; - dao        ← checks authorization on protocol calls
;; - signer     (external) — registers cycle auth, sets fee rate, calls lock/extend/finalize
;;
;; Architecture:
;; Each signer has ONE pool contract and MULTIPLE stacker contracts.
;; The signer only interacts with the pool. The pool calls PoX on behalf of stackers.
;; This avoids duplicating complex logic across stacker deployments.

(impl-trait .pool-trait.pool-trait)
(use-trait stacker-trait .stacker-trait.stacker-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u12001))
(define-constant ERR_MISSING_AUTH (err u12002))
(define-constant ERR_NOT_SIGNER (err u12003))
(define-constant ERR_POX_FAILED (err u12004))
(define-constant ERR_FEE_TOO_HIGH (err u12005))
(define-constant MAX_SIGNER_FEE u1000) ;; 10% cap in basis points

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Who controls this pool. They register auth each cycle.
(define-data-var signer principal tx-sender)

;; The Bitcoin address where PoX rewards are sent (registered with Emily).
;; To compute hashbytes for a new stacker:
;; 1. Get the Emily-computed taproot address for this contract's principal
;; 2. Decode the bc1p... address using bech32m to get the 32-byte tweaked pubkey
;; 3. That's your hashbytes. Version is 0x06 (P2TR / taproot).
(define-data-var btc-address { version: (buff 1), hashbytes: (buff 32) }
  { version: 0x06, hashbytes: 0x8f72233e032673f5264b38893275ecc55f5e367a96dc88d5ece5cd83585d8b85 }
)

;; Signer-proposed btc-address change. If no admin veto within 144 blocks,
;; register-cycle-auth auto-applies it.
(define-data-var proposed-btc-address (optional { version: (buff 1), hashbytes: (buff 32) }) none)
(define-data-var proposed-at uint u0)

(define-constant PROPOSAL_DELAY u144)

;; Signer's fee on yield, in basis points (e.g. 500 = 5%).
;; Read by stacker contracts during release-rewards.
(define-data-var signer-fee uint u0)

;; Per-cycle signer authorization. Must be set by signer before prepare phase.
(define-map cycle-auth
  { cycle: uint, type: (string-ascii 14) }
  {
    btc-address: { version: (buff 1), hashbytes: (buff 32) },
    max-amount: uint,
    auth-id: uint,
    signer-key: (buff 33),
    signer-sig: (buff 65)
  }
)

;; ---------------------------------------------------------
;; Signer functions
;; ---------------------------------------------------------

;; Register signer key + signature for a cycle. Must be done before the
;; prepare phase (~100 blocks before cycle end).
;; Auto-applies a pending btc-address proposal if 144 blocks have passed
;; with no admin veto.
(define-public (register-cycle-auth
    (cycle uint)
    (type (string-ascii 14))
    (max-amount uint)
    (auth-id uint)
    (signer-key (buff 33))
    (signer-sig (buff 65))
  )
  (begin
    (asserts! (is-eq tx-sender (var-get signer)) ERR_NOT_SIGNER)
    ;; Auto-apply pending btc-address proposal if matured
    (match (var-get proposed-btc-address)
      proposed (if (>= burn-block-height (+ (var-get proposed-at) PROPOSAL_DELAY))
        (begin
          (var-set btc-address proposed)
          (var-set proposed-btc-address none)
          (var-set proposed-at u0)
          (print { action: "btc-address-applied", address: proposed })
          true
        )
        true
      )
      true
    )
    (ok (map-set cycle-auth
      { cycle: cycle, type: type }
      {
        btc-address: (var-get btc-address),
        max-amount: max-amount,
        auth-id: auth-id,
        signer-key: signer-key,
        signer-sig: signer-sig
      }
    ))
  )
)

(define-public (set-signer (new-signer principal))
  (begin
    (asserts! (is-eq tx-sender (var-get signer)) ERR_NOT_SIGNER)
    (ok (var-set signer new-signer))
  )
)

;; Admin can set btc-address directly — no delay, no 2-step process.
(define-public (set-btc-address (addr { version: (buff 1), hashbytes: (buff 32) }))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (var-set proposed-btc-address none)
    (var-set proposed-at u0)
    (var-set btc-address addr)
    (print { action: "btc-address-set", address: addr })
    (ok true)
  )
)

;; Signer proposes a new btc-address (e.g. when sBTC signer set rotates).
;; Auto-applied after 144 blocks if admin doesn't veto.
(define-public (propose-btc-address (addr { version: (buff 1), hashbytes: (buff 32) }))
  (begin
    (asserts! (is-eq tx-sender (var-get signer)) ERR_NOT_SIGNER)
    (var-set proposed-btc-address (some addr))
    (var-set proposed-at burn-block-height)
    (print { action: "btc-address-proposed", address: addr, matures-at: (+ burn-block-height PROPOSAL_DELAY) })
    (ok true)
  )
)

(define-public (set-signer-fee (rate uint))
  (begin
    (asserts! (is-eq tx-sender (var-get signer)) ERR_NOT_SIGNER)
    (asserts! (<= rate MAX_SIGNER_FEE) ERR_FEE_TOO_HIGH)
    (ok (var-set signer-fee rate))
  )
)

;; ---------------------------------------------------------
;; PoX-4 stacking (called by signer, operates on stacker contracts)
;; ---------------------------------------------------------

;; Initial lock — locks a stacker's unlocked STX into PoX.
(define-public (lock-delegated-stx
    (stacker principal)
    (ustx uint)
    (start-burn-ht uint)
    (lock-period uint)
  )
  (begin
    (asserts! (is-eq tx-sender (var-get signer)) ERR_NOT_SIGNER)
    (as-contract? (())
      ;; to-uint: pox-4 returns int errors, our type is uint
      (try! (match (contract-call? 'SP000000000000000000002Q6VF78.pox-4 delegate-stack-stx
        stacker ustx (var-get btc-address) start-burn-ht lock-period)
        success (ok success)
        error (err (to-uint error)))))
  )
)

;; Extend an existing lock for one more cycle.
(define-public (extend-delegated-stx (stacker principal))
  (begin
    (asserts! (is-eq tx-sender (var-get signer)) ERR_NOT_SIGNER)
    (as-contract? (())
      (try! (match (contract-call? 'SP000000000000000000002Q6VF78.pox-4 delegate-stack-extend
        stacker (var-get btc-address) u1)
        success (ok success)
        error (err (to-uint error)))))
  )
)

;; Increase the locked amount for a stacker already stacking.
(define-public (increase-delegated-stx (stacker principal) (increase-by uint))
  (begin
    (asserts! (is-eq tx-sender (var-get signer)) ERR_NOT_SIGNER)
    (as-contract? (())
      (try! (match (contract-call? 'SP000000000000000000002Q6VF78.pox-4 delegate-stack-increase
        stacker (var-get btc-address) increase-by)
        success (ok success)
        error (err (to-uint error)))))
  )
)

;; Commit the aggregated stake for a cycle with signer authorization.
(define-public (finalize-cycle (cycle uint))
  (let (
    (auth (unwrap! (map-get? cycle-auth { cycle: cycle, type: "agg-commit" }) ERR_MISSING_AUTH))
  )
    (asserts! (is-eq tx-sender (var-get signer)) ERR_NOT_SIGNER)
    (as-contract? (())
      (try! (match (contract-call? 'SP000000000000000000002Q6VF78.pox-4 stack-aggregation-commit-indexed
        (get btc-address auth)
        cycle
        (some (get signer-sig auth))
        (get signer-key auth)
        (get max-amount auth)
        (get auth-id auth))
        success (ok success)
        error (err (to-uint error)))))
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

(define-read-only (get-signer)
  (ok (var-get signer))
)

(define-read-only (get-btc-address)
  (ok (var-get btc-address))
)

(define-read-only (get-proposed-btc-address)
  (var-get proposed-btc-address)
)

(define-read-only (get-proposed-at)
  (var-get proposed-at)
)

(define-read-only (get-signer-fee)
  (ok (var-get signer-fee))
)

(define-read-only (get-signer-info)
  (ok { signer: (var-get signer), fee: (var-get signer-fee) })
)

(define-read-only (get-cycle-auth (cycle uint) (type (string-ascii 14)))
  (map-get? cycle-auth { cycle: cycle, type: type })
)
