;; Title: stacker
;;
;; Thin STX + sBTC holding contract. Multiple deployed per signer.
;;
;; What it does:
;; - Holds STX that gets locked into PoX by the pool contract
;; - Holds sBTC that Emily mints when BTC rewards arrive
;; - Delegates to PoX (self-delegation)
;; - Releases sBTC rewards to yield, paying signer fee directly
;;
;; What it interacts with:
;; - vault      ← receives STX from (via allocation), returns excess STX to
;; - pool       ← reads btc-address, signer fee, signer principal via trait
;; - yield      ← called by yield's sweep-stacker to pull sBTC out
;; - dao        ← checks authorization on every protocol call
;; - sBTC       ← transfers sBTC out during release-rewards
;;
;; Architecture:
;; Each signer has ONE pool contract and MULTIPLE stacker contracts.
;; The stacker is thin by design — all signer logic, cycle auth, and PoX
;; operations live in pool.clar. This avoids duplicating complex code
;; across stacker deployments (stacker-1a, stacker-1b, stacker-1c).

(impl-trait .stacker-trait.stacker-trait)
(use-trait vault-trait .vault-trait.vault-trait)
(use-trait pool-trait .pool-trait.pool-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u11001))
(define-constant ERR_INSUFFICIENT_BALANCE (err u11005))
(define-constant ERR_WRONG_POOL (err u11006))
(define-constant PRECISION u10000)

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; The pool contract this stacker belongs to.
;; Pool stores signer, btc-address, fee rate, cycle auth.
(define-data-var pool principal tx-sender)

;; ---------------------------------------------------------
;; Admin
;; ---------------------------------------------------------

(define-public (set-pool (new-pool principal))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (ok (var-set pool new-pool))
  )
)

;; ---------------------------------------------------------
;; PoX-4 delegation (protocol-controlled)
;; ---------------------------------------------------------

;; Authorize stacking this contract's STX via PoX.
;; delegate-to = this contract itself (self-delegating pool operator).
;; pox-addr = read from pool's btc-address.
(define-public (delegate-stx (ustx uint) (pool-contract <pool-trait>))
  (let (
    (btc-addr (try! (contract-call? pool-contract get-btc-address)))
  )
    (asserts! (is-eq (contract-of pool-contract) (var-get pool)) ERR_WRONG_POOL)
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (as-contract? (())
      ;; to-uint: pox-4 returns int errors, our type is uint
      (try! (match (contract-call? 'SP000000000000000000002Q6VF78.pox-4 delegate-stx
        ustx tx-sender none (some btc-addr))
        success (begin
          (print { action: "delegate-stx", stacker: current-contract, ustx: ustx })
          (ok success))
        error (err (to-uint error)))))
  )
)

;; Revoke delegation. Prevents future locks.
;; Locked STX still unlocks at cycle end.
(define-public (revoke-delegate-stx)
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (as-contract? (())
      (try! (match (contract-call? 'SP000000000000000000002Q6VF78.pox-4 revoke-delegate-stx)
        success (begin
          (print { action: "revoke-delegate-stx", stacker: current-contract })
          (ok success))
        error (err (to-uint error)))))
  )
)

;; ---------------------------------------------------------
;; STX transfers (called by allocation)
;; ---------------------------------------------------------

;; Return STX from this stacker back to vault.
;; Called by allocation.return-excess when this stacker has more than its target.
;; Only returns unlocked STX -- locked STX must wait for cycle end.
(define-public (stx-transfer (ustx uint) (vault <vault-trait>))
  (let (
    (unlocked (get unlocked (stx-account current-contract)))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (asserts! (>= unlocked ustx) ERR_INSUFFICIENT_BALANCE)
    (try! (as-contract? ((with-stx ustx))
      (try! (stx-transfer? ustx tx-sender (contract-of vault)))))
    (print { action: "stx-transfer", stacker: current-contract, vault: (contract-of vault), ustx: ustx })
    (ok ustx)
  )
)

;; Return all unlocked STX to vault. Admin emergency function.
(define-public (stx-transfer-all (vault <vault-trait>))
  (let (
    (unlocked (get unlocked (stx-account current-contract)))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (try! (as-contract? ((with-stx unlocked))
      (try! (stx-transfer? unlocked tx-sender (contract-of vault)))))
    (print { action: "stx-transfer-all", stacker: current-contract, vault: (contract-of vault), ustx: unlocked })
    (ok unlocked)
  )
)

;; ---------------------------------------------------------
;; Reward release (called by yield to sweep sBTC)
;; ---------------------------------------------------------

;; Yield calls this to pull sBTC from this stacker.
;; Emily mints sBTC here when BTC arrives at the pool's btc-address.
;; Pays signer fee directly, sends the rest to recipient (yield).
;; Returns net amount sent, fee paid, and signer principal.
(define-public (release-rewards (recipient principal) (pool-contract <pool-trait>))
  (let (
    (balance (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance current-contract)))
    (info (try! (contract-call? pool-contract get-signer-info)))
    (signer-addr (get signer info))
    (fee-rate (get fee info))
    (fee-amount (/ (* balance fee-rate) PRECISION))
    (net-amount (- balance fee-amount))
  )
    (asserts! (is-eq (contract-of pool-contract) (var-get pool)) ERR_WRONG_POOL)
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (asserts! (> balance u0) ERR_INSUFFICIENT_BALANCE)
    ;; Pay signer fee directly
    (if (> fee-amount u0)
      (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" fee-amount))
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer fee-amount tx-sender signer-addr none))))
      true
    )
    ;; Send net rewards to recipient (yield)
    (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" net-amount))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer net-amount tx-sender recipient none))))
    (print { action: "release-rewards", stacker: current-contract, gross: balance, fee: fee-amount, net: net-amount })
    (ok { amount: net-amount, fee: fee-amount, signer: signer-addr })
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

(define-read-only (get-pool)
  (var-get pool)
)

(define-read-only (get-sbtc-balance)
  (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance current-contract)
)

(define-read-only (get-unlocked-balance)
  (get unlocked (stx-account current-contract))
)

(define-read-only (get-locked-balance)
  (get locked (stx-account current-contract))
)
