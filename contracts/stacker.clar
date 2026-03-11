;; Title: stacker
;;
;; A delegate contract that holds STX and delegates it to PoX via a signer.
;;
;; Architecture:
;; Each signer has multiple stacker contracts (e.g. stacker-1a, stacker-1b, stacker-1c).
;; All stacker contracts for a signer delegate to the same PoX pool with the same
;; signer key. Multiple delegates per signer are needed because PoX does not allow
;; decreasing stacked amounts -- only stopping entirely. By splitting STX across
;; multiple delegates, the protocol can stop one delegate to free up STX for
;; withdrawals while the others keep stacking and earning yield.
;;
;; STX flow:
;;   vault -> stacker (via allocation.execute-allocation)
;;   stacker -> vault (via allocation.return-excess)
;;
;; PoX flow (operator, each cycle):
;;   1. register-cycle-auth -- signer key + signature for the cycle
;;   2. lock-delegator -- call pox-4.delegate-stack-stx to lock STX
;;   3. finalize-cycle -- call pox-4.stack-aggregation-commit-indexed
;;
;; Inspired by: StackingDAO stacking-delegate-1.clar + delegates-handler-v1.clar
;; Source: stacking-dao/contracts/version-2/stacking-delegate-1.clar
;; Source: stacking-dao/contracts/version-2/delegates-handler-v1.clar

(impl-trait .stacker-trait.stacker-trait)
(use-trait vault-trait .vault-trait.vault-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u11001))
(define-constant ERR_MISSING_AUTH (err u11002))
(define-constant ERR_NOT_OPERATOR (err u11003))
(define-constant ERR_POX_FAILED (err u11004))
(define-constant ERR_INSUFFICIENT_BALANCE (err u11005))

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Who controls this stacker (the signer operator). They register auth each cycle.
(define-data-var operator principal tx-sender)

;; The Bitcoin address where PoX rewards are sent (registered with Emily)
(define-data-var btc-address { version: (buff 1), hashbytes: (buff 32) }
  { version: 0x04, hashbytes: 0x0000000000000000000000000000000000000000000000000000000000000000 }
)

;; Signer's fee on yield, in basis points (e.g. 500 = 5%).
;; Set by the operator. Applied by yield when sweeping rewards.
(define-data-var signer-fee uint u0)

;; Per-cycle signer authorization. Must be set by operator before prepare phase.
(define-map cycle-auth
  { cycle: uint, topic: (string-ascii 14) }
  {
    pox-addr: { version: (buff 1), hashbytes: (buff 32) },
    max-amount: uint,
    auth-id: uint,
    signer-key: (buff 33),
    signer-sig: (buff 65)
  }
)

;; ---------------------------------------------------------
;; Operator functions
;; ---------------------------------------------------------

;; Register signer key + signature for a cycle. Must be done before the
;; prepare phase (~100 blocks before cycle end).
(define-public (register-cycle-auth
    (cycle uint)
    (topic (string-ascii 14))
    (pox-addr { version: (buff 1), hashbytes: (buff 32) })
    (max-amount uint)
    (auth-id uint)
    (signer-key (buff 33))
    (signer-sig (buff 65))
  )
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_OPERATOR)
    (ok (map-set cycle-auth
      { cycle: cycle, topic: topic }
      {
        pox-addr: pox-addr,
        max-amount: max-amount,
        auth-id: auth-id,
        signer-key: signer-key,
        signer-sig: signer-sig
      }
    ))
  )
)

(define-public (set-operator (new-operator principal))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_OPERATOR)
    (ok (var-set operator new-operator))
  )
)

(define-public (set-btc-address (addr { version: (buff 1), hashbytes: (buff 32) }))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_OPERATOR)
    (ok (var-set btc-address addr))
  )
)

(define-public (set-signer-fee (rate uint))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_OPERATOR)
    (ok (var-set signer-fee rate))
  )
)

;; ---------------------------------------------------------
;; Stacking trait implementation (called by allocation)
;; ---------------------------------------------------------

;; Receive STX from vault via allocation.execute-allocation.
;; STX arrives via vault.release before this is called -- this is the
;; accounting acknowledgment that the stacker received funds.
(define-public (delegate-stx (amount uint) (stacker principal))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (print { action: "delegate-stx", stacker: current-contract, amount: amount })
    (ok true)
  )
)

;; Revoke delegation for this stacker
(define-public (revoke-delegate-stx (stacker principal))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (print { action: "revoke-delegate-stx", stacker: current-contract })
    (ok true)
  )
)

;; Return STX from this stacker back to a recipient (vault).
;; Called by allocation.return-excess when this stacker has more than its target.
;; Only returns unlocked STX -- locked STX must wait for cycle end.
(define-public (return-stx (recipient principal) (amount uint))
  (let (
    (unlocked (get unlocked (stx-account current-contract)))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (asserts! (>= unlocked amount) ERR_INSUFFICIENT_BALANCE)
    (try! (as-contract? ((with-stx amount))
      (try! (stx-transfer? amount tx-sender recipient))))
    (print { action: "return-stx", stacker: current-contract, recipient: recipient, amount: amount })
    (ok true)
  )
)

;; Return all unlocked STX to vault. Admin emergency function.
(define-public (return-all (vault <vault-trait>))
  (let (
    (unlocked (get unlocked (stx-account current-contract)))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (if (> unlocked u0)
      (try! (as-contract? ((with-stx unlocked))
        (try! (stx-transfer? unlocked tx-sender (contract-of vault)))))
      true
    )
    (print { action: "return-all", stacker: current-contract, amount: unlocked })
    (ok unlocked)
  )
)

;; ---------------------------------------------------------
;; PoX-4 interaction (called by operator during prepare phase)
;; ---------------------------------------------------------

;; Lock this stacker's STX into PoX stacking
(define-public (lock-delegator
    (stacker principal)
    (amount uint)
    (start-burn-ht uint)
    (lock-period uint)
  )
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_OPERATOR)
    (as-contract? ((with-all-assets-unsafe))
      (try! (match (contract-call? 'SP000000000000000000002Q6VF78.pox-4 delegate-stack-stx
        stacker amount (var-get btc-address) start-burn-ht lock-period)
        success (ok success)
        error (err (to-uint error)))))
  )
)

;; Commit the aggregated stake for a cycle with signer authorization
(define-public (finalize-cycle (cycle uint))
  (let (
    (auth (unwrap! (map-get? cycle-auth { cycle: cycle, topic: "agg-commit" }) ERR_MISSING_AUTH))
  )
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_OPERATOR)
    (as-contract? ((with-all-assets-unsafe))
      (try! (match (contract-call? 'SP000000000000000000002Q6VF78.pox-4 stack-aggregation-commit-indexed
        (get pox-addr auth)
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
;; Reward release (called by yield to sweep sBTC)
;; ---------------------------------------------------------

;; Yield calls this to pull all sBTC from this stacker.
;; Emily mints sBTC here when BTC arrives at btc-address.
;; Returns amount transferred + signer fee rate so yield can
;; split commission without needing registry lookups.
(define-public (release-rewards (recipient principal))
  (let (
    (balance (unwrap-panic (contract-call? .sbtc-mock get-balance current-contract)))
    (fee (var-get signer-fee))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (asserts! (> balance u0) ERR_INSUFFICIENT_BALANCE)
    (try! (as-contract? ((with-all-assets-unsafe))
      (try! (contract-call? .sbtc-mock transfer balance tx-sender recipient none))))
    (print { action: "release-rewards", stacker: current-contract, amount: balance, fee: fee })
    (ok { amount: balance, fee: fee })
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

(define-read-only (get-operator)
  (var-get operator)
)

(define-read-only (get-btc-address)
  (var-get btc-address)
)

(define-read-only (get-signer-fee)
  (var-get signer-fee)
)

(define-read-only (get-sbtc-balance)
  (contract-call? .sbtc-mock get-balance current-contract)
)

(define-read-only (get-cycle-auth (cycle uint) (topic (string-ascii 14)))
  (map-get? cycle-auth { cycle: cycle, topic: topic })
)

(define-read-only (get-unlocked-balance)
  (get unlocked (stx-account current-contract))
)

(define-read-only (get-locked-balance)
  (get locked (stx-account current-contract))
)
