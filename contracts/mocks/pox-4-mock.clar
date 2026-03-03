;; Title: pox-4-mock
;;
;; What this contract does:
;; Stubs out the PoX-4 stacking functions so we can test pool.clar locally.
;; On mainnet, pool.clar calls SP000000000000000000002Q6VF78.pox-4 directly.
;; In tests, we deploy this mock instead.
;;
;; It doesn't actually lock STX or track cycles -- it just returns (ok ...)
;; so the calling contracts compile and the happy path can be tested.
;;
;; This is a TEST-ONLY contract -- never deployed to mainnet.

;; ---------------------------------------------------------
;; Stubs for functions called by pool.clar
;; ---------------------------------------------------------

;; Called by delegate contracts to authorize a pool to stack on their behalf
(define-public (delegate-stx
    (amount-ustx uint)
    (delegate-to principal)
    (until-burn-ht (optional uint))
    (pox-addr (optional { version: (buff 1), hashbytes: (buff 32) }))
  )
  (ok true)
)

;; Called by pool operator to lock a delegator's STX into stacking
(define-public (delegate-stack-stx
    (stacker principal)
    (amount-ustx uint)
    (pox-addr { version: (buff 1), hashbytes: (buff 32) })
    (start-burn-ht uint)
    (lock-period uint)
  )
  (ok {
    stacker: stacker,
    lock-amount: amount-ustx,
    unlock-burn-height: (+ start-burn-ht u2100)
  })
)

;; Called by pool operator to extend a stacker's lock period
(define-public (delegate-stack-extend
    (stacker principal)
    (pox-addr { version: (buff 1), hashbytes: (buff 32) })
    (extend-count uint)
  )
  (ok {
    stacker: stacker,
    unlock-burn-height: u999999
  })
)

;; Called by pool operator to increase a stacker's locked amount
(define-public (delegate-stack-increase
    (stacker principal)
    (pox-addr { version: (buff 1), hashbytes: (buff 32) })
    (increase-by uint)
  )
  (ok {
    stacker: stacker,
    total-locked: increase-by
  })
)

;; Called by pool operator to commit aggregated stacking for a cycle
(define-public (stack-aggregation-commit-indexed
    (pox-addr { version: (buff 1), hashbytes: (buff 32) })
    (reward-cycle uint)
    (signer-sig (optional (buff 65)))
    (signer-key (buff 33))
    (max-amount uint)
    (auth-id uint)
  )
  (ok u0) ;; returns reward-index
)

;; Called by pool operator to increase an existing aggregation commitment
(define-public (stack-aggregation-increase
    (pox-addr { version: (buff 1), hashbytes: (buff 32) })
    (reward-cycle uint)
    (reward-cycle-index uint)
    (signer-sig (optional (buff 65)))
    (signer-key (buff 33))
    (max-amount uint)
    (auth-id uint)
  )
  (ok true)
)

;; Revoke delegation
(define-public (revoke-delegate-stx)
  (ok true)
)
