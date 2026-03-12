;; Title: stacker
;;
;; A thin STX-holding contract that sits between the vault and PoX.
;;
;; What it does:
;; - Holds STX and locks it into PoX stacking
;; - Holds sBTC that Emily mints when BTC rewards arrive at its registered BTC address
;; - Stores its signer's key + signature each cycle
;; - Pays signer fee and releases net rewards when yield sweeps
;;
;; What it interacts with:
;; - vault      ← receives STX from (via allocation), returns excess STX to
;; - pox-4      → calls delegate-stack-stx, delegate-stack-extend, delegate-stack-increase,
;;                stack-aggregation-commit-indexed
;; - yield      ← called by yield's sweep-stacker which triggers release-rewards
;; - dao        ← checks authorization on every protocol call
;; - sBTC       ← transfers sBTC out during release-rewards
;; - signer     (external) — registers cycle auth, sets fee rate, calls lock/extend/finalize
;;
;; Architecture:
;; Each signer has multiple stacker contracts (e.g. stacker-1a, stacker-1b, stacker-1c).
;; Multiple stackers per signer are needed because PoX does not allow decreasing
;; stacked amounts -- only stopping entirely. By splitting STX across multiple
;; stackers, the protocol can stop one to free up STX for withdrawals while the
;; others keep stacking and earning yield.

(impl-trait .stacker-trait.stacker-trait)
(use-trait vault-trait .vault-trait.vault-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u11001))
(define-constant ERR_MISSING_AUTH (err u11002))
(define-constant ERR_NOT_SIGNER (err u11003))
(define-constant ERR_POX_FAILED (err u11004))
(define-constant ERR_INSUFFICIENT_BALANCE (err u11005))
(define-constant ERR_FEE_TOO_HIGH (err u11006))
(define-constant MAX_SIGNER_FEE u1000) ;; 10% cap in basis points
(define-constant PRECISION u10000)

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Who controls this stacker. They register auth each cycle.
(define-data-var signer principal tx-sender)

;; The Bitcoin address where PoX rewards are sent (registered with Emily).
;; To compute hashbytes for a new stacker:
;; 1. Get the Emily-computed taproot address for this contract's principal
;;    e.g. Emily maps DEPLOYER.stacker-1a → bc1p3aezx0sryeel2fjt8zynya0vc404udn6jmwg340vuhxcxkza3wzs9la44a
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
;; Set by signer. Paid directly to signer during release-rewards.
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
;; Stacking trait implementation (called by allocation)
;; ---------------------------------------------------------

;; Return STX from this stacker back to a recipient (vault).
;; Called by allocation.return-excess when this stacker has more than its target.
;; Only returns unlocked STX -- locked STX must wait for cycle end.
(define-public (stx-transfer (ustx uint) (recipient principal))
  (let (
    (unlocked (get unlocked (stx-account current-contract)))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (asserts! (>= unlocked ustx) ERR_INSUFFICIENT_BALANCE)
    (try! (as-contract? ((with-stx ustx))
      (try! (stx-transfer? ustx tx-sender recipient))))
    (print { action: "stx-transfer", stacker: current-contract, recipient: recipient, ustx: ustx })
    (ok true)
  )
)

;; Return all unlocked STX to vault. Admin emergency function.
(define-public (stx-transfer-all (vault <vault-trait>))
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
    (print { action: "stx-transfer-all", stacker: current-contract, ustx: unlocked })
    (ok unlocked)
  )
)

;; ---------------------------------------------------------
;; PoX-4 delegation (protocol-controlled)
;; ---------------------------------------------------------

;; Authorize stacking this contract's STX via PoX.
;; Must be called before lock-delegated-stx can work.
;; delegate-to = this contract itself (self-delegating pool operator).
;; pox-addr = btc-address (Emily-registered, locked in).
(define-public (delegate-stx (ustx uint))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (as-contract? (())
      ;; to-uint: pox-4 returns int errors, our type is uint
      (try! (match (contract-call? 'SP000000000000000000002Q6VF78.pox-4 delegate-stx
        ustx tx-sender none (some (var-get btc-address)))
        success (begin
          (print { action: "delegate-stx", stacker: current-contract, ustx: ustx })
          (ok success))
        error (err (to-uint error)))))
  )
)

;; Revoke delegation. Prevents the signer from re-locking in future cycles.
;; Locked STX still unlocks at cycle end -- this just blocks new locks.
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
;; PoX-4 stacking (called by signer during prepare phase)
;; ---------------------------------------------------------

;; Initial lock — locks unlocked STX into PoX. Fails if already locked.
(define-public (lock-delegated-stx
    (stacker principal)
    (ustx uint)
    (start-burn-ht uint)
    (lock-period uint)
  )
  (begin
    (asserts! (is-eq tx-sender (var-get signer)) ERR_NOT_SIGNER)
    (as-contract? (())
      (try! (match (contract-call? 'SP000000000000000000002Q6VF78.pox-4 delegate-stack-stx
        stacker ustx (var-get btc-address) start-burn-ht lock-period)
        success (ok success)
        error (err (to-uint error)))))
  )
)

;; Extend an existing lock for one more cycle. Used after initial lock.
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
;; Used when allocation sends more STX to this contract.
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
;; Reward release (called by yield to sweep sBTC)
;; ---------------------------------------------------------

;; Yield calls this to pull sBTC from this stacker.
;; Emily mints sBTC here when BTC arrives at btc-address.
;; Pays signer fee directly, sends the rest to recipient (yield).
;; Returns gross amount, fee paid, and net sent.
(define-public (release-rewards (recipient principal))
  (let (
    (balance (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance current-contract)))
    (fee-rate (var-get signer-fee))
    (signer-addr (var-get signer))
    (fee-amount (/ (* balance fee-rate) PRECISION))
    (net-amount (- balance fee-amount))
  )
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
    (if (> net-amount u0)
      (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" net-amount))
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer net-amount tx-sender recipient none))))
      true
    )
    (print { action: "release-rewards", stacker: current-contract, gross: balance, fee: fee-amount, net: net-amount })
    (ok { amount: net-amount, fee: fee-amount, signer: signer-addr })
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

(define-read-only (get-signer)
  (var-get signer)
)

(define-read-only (get-btc-address)
  (var-get btc-address)
)

(define-read-only (get-proposed-btc-address)
  (var-get proposed-btc-address)
)

(define-read-only (get-proposed-at)
  (var-get proposed-at)
)

(define-read-only (get-signer-fee)
  (var-get signer-fee)
)

(define-read-only (get-sbtc-balance)
  (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance current-contract)
)

(define-read-only (get-cycle-auth (cycle uint) (type (string-ascii 14)))
  (map-get? cycle-auth { cycle: cycle, type: type })
)

(define-read-only (get-unlocked-balance)
  (get unlocked (stx-account current-contract))
)

(define-read-only (get-locked-balance)
  (get locked (stx-account current-contract))
)
