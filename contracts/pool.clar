;; Title: pool
;;
;; What this contract does:
;; This is the signer pool operator contract -- the thing that actually talks
;; to PoX-4 to stack STX with a specific signer. Each signer in the STX Juice
;; network deploys their own copy of this contract (or we deploy one for them).
;;
;; What it does each PoX cycle:
;; 1. Takes delegated STX from delegate contracts
;; 2. Calls pox-4.delegate-stack-stx to lock each delegator's STX
;; 3. Calls pox-4.stack-aggregation-commit-indexed to commit the total
;;    to the reward cycle with the signer's key and signature
;;
;; Signer coordination:
;; Each cycle, the operator (signer or our backend) must call
;; register-cycle-auth to register the signer key + signature for that cycle.
;; This is the manual step -- if you miss the prepare window (~100 blocks),
;; this pool misses the cycle and earns no rewards.
;;
;; Multi-signer design:
;; This is ONE pool contract. In a multi-signer setup, each signer has their
;; own deployed copy. The registry tracks which pools are active and how STX
;; is split between them. A single-signer launch just means one pool in the
;; registry.
;;
;; Inspired by: StackingDAO stacking-pool-signer-v1.clar
;; Source: stacking-dao/contracts/version-2/stacking-pool-signer-v1.clar

(impl-trait .stacking-trait.stacking-trait)

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u11001))
(define-constant ERR_MISSING_AUTH (err u11002))
(define-constant ERR_NOT_OPERATOR (err u11003))

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Who controls this pool (the signer operator). They register auth each cycle.
(define-data-var operator principal tx-sender)

;; The Bitcoin address where PoX rewards are sent
(define-data-var btc-address { version: (buff 1), hashbytes: (buff 32) }
  { version: 0x04, hashbytes: 0x0000000000000000000000000000000000000000000000000000000000000000 }
)

;; Per-cycle signer authorization. Must be set by operator before prepare phase.
;; This is the critical manual step -- miss it and the pool misses the cycle.
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
;; prepare phase (last 100 blocks of the cycle).
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

;; ---------------------------------------------------------
;; Stacking trait implementation (called by helpers/strategy)
;; ---------------------------------------------------------

;; Delegate STX from a delegate contract to this pool
(define-public (delegate-stx (amount uint) (stacker principal))
  (begin
    (try! (contract-call? .dao guard-protocol))
    (print { action: "delegate-stx", pool: (as-contract tx-sender), amount: amount, stacker: stacker })
    (ok true)
  )
)

;; Revoke a delegation
(define-public (revoke-delegate-stx (stacker principal))
  (begin
    (try! (contract-call? .dao guard-protocol))
    (print { action: "revoke-delegation", pool: (as-contract tx-sender), stacker: stacker })
    (ok true)
  )
)

;; Return STX from stacking back to the vault
(define-public (return-stx (stacker principal) (amount uint))
  (begin
    (try! (contract-call? .dao guard-protocol))
    (print { action: "return-stx", pool: (as-contract tx-sender), stacker: stacker, amount: amount })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; PoX-4 interaction (called by operator during prepare phase)
;; ---------------------------------------------------------

;; Lock a delegator's STX into PoX stacking
(define-public (lock-delegator
    (stacker principal)
    (amount uint)
    (start-burn-ht uint)
    (lock-period uint)
  )
  (let (
    (pox-addr (var-get btc-address))
  )
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_OPERATOR)
    (as-contract (contract-call? .pox-4-mock delegate-stack-stx stacker amount pox-addr start-burn-ht lock-period))
  )
)

;; Commit the aggregated stake for a cycle with signer authorization
(define-public (finalize-cycle (cycle uint))
  (let (
    (auth (unwrap! (map-get? cycle-auth { cycle: cycle, topic: "agg-commit" }) ERR_MISSING_AUTH))
  )
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_OPERATOR)
    (as-contract (contract-call? .pox-4-mock stack-aggregation-commit-indexed
      (get pox-addr auth)
      cycle
      (some (get signer-sig auth))
      (get signer-key auth)
      (get max-amount auth)
      (get auth-id auth)
    ))
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

(define-read-only (get-cycle-auth (cycle uint) (topic (string-ascii 14)))
  (map-get? cycle-auth { cycle: cycle, topic: topic })
)
