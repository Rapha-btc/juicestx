;; DRAFT based on upstream 1a35b90; new signer with one dedicated two-phase vault.
;; STX-only rewards: no deadline-driven sBTC fallback; unsold rewards await conversion.
;; Retains upstream share mirror, fee snapshots, liability counters and payouts.

(impl-trait 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)
(use-trait signer-manager-trait 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)

(define-constant ERR_NO_CLAIMABLE_REWARDS (err u1001))
(define-constant ERR_UNAUTHORIZED_ADMIN (err u1002))
(define-constant ERR_CALLDATA_NOT_SUPPORTED (err u1003))
(define-constant ERR_INVALID_FEES_BIPS (err u1005))
(define-constant ERR_UNAUTHORIZED_CALLER (err u1006))
(define-constant ERR_INSUFFICIENT_FEES (err u1007))

(define-constant ERR_BONDS_NOT_SUPPORTED (err u1021))
(define-constant ERR_INVALID_LOCK_PERIOD (err u1022))
(define-constant ERR_CYCLE_NOT_CLAIMED (err u1023))
(define-constant ERR_SHARE_MIRROR_MISMATCH (err u1024))
(define-constant ERR_SHARES_ALREADY_PINNED (err u1025))
(define-constant ERR_NO_DUST (err u1033))
(define-constant MAX_FEE_BIPS u500)
(define-constant BIPS_DENOMINATOR u10000)
(define-constant FEE_ACTIVATION_DELAY_CYCLES u2)
(define-constant SWAP_WINDOW_BURN_BLOCKS u432)

(define-constant CYCLE_OFFSETS (list
  u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12 u13 u14 u15 u16 u17 u18 u19 u20
  u21 u22 u23 u24 u25 u26 u27 u28 u29 u30 u31 u32 u33 u34 u35 u36 u37 u38
  u39 u40 u41 u42 u43 u44 u45 u46 u47 u48 u49 u50 u51 u52 u53 u54 u55 u56
  u57 u58 u59 u60 u61 u62 u63 u64 u65 u66 u67 u68 u69 u70 u71 u72 u73 u74
  u75 u76 u77 u78 u79 u80 u81 u82 u83 u84 u85 u86 u87 u88 u89 u90 u91 u92
  u93 u94 u95
))

(define-map admins
  principal
  bool
)

(map-set admins tx-sender true)

(define-data-var fees-bips uint u0)

(define-data-var pending-fees-bips uint u0)
(define-data-var pending-fees-cycle uint u0)
(define-data-var earned-fees uint u0)
(define-map fee-bips-for-cycle
  uint
  uint
)

(define-data-var unswapped-sats uint u0)
(define-data-var unpaid-stx uint u0)

(define-map mirrored-shares
  {
    staker: principal,
    reward-cycle: uint,
  }
  uint
)

(define-map mirrored-total-shares
  uint
  uint
)

(define-map cycle-settlement
  uint
  {
    pot-sats: uint,
    swapped-sats: uint,
    fee-sats: uint,
    stx-out: uint,
    total-shares: uint,
    deadline: uint,
    pinned: bool,
  }
)

(define-constant EMPTY_SETTLEMENT {
  pot-sats: u0,
  swapped-sats: u0,
  fee-sats: u0,
  stx-out: u0,
  total-shares: u0,
  deadline: u0,
  pinned: false,
})

(define-map staker-stx-paid
  {
    staker: principal,
    reward-cycle: uint,
  }
  uint
)

(define-map staker-sbtc-accounted
  {
    staker: principal,
    reward-cycle: uint,
  }
  uint
)

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
    (try! (authorize-pox-5))
    (asserts! (not is-bond) ERR_BONDS_NOT_SUPPORTED)
    (asserts! (is-none signer-calldata) ERR_CALLDATA_NOT_SUPPORTED)
    (fold mirror-stake-for-cycle
      (unwrap! (slice? CYCLE_OFFSETS u0 num-indexes) ERR_INVALID_LOCK_PERIOD) {
      staker: staker,
      first-reward-cycle: first-index,
      shares: amount-ustx,
    })
    (print {
      topic: "validate-stake",
      staker: staker,
      first-reward-cycle: first-index,
      num-cycles: num-indexes,
      shares: amount-ustx,
      amount-sats: amount-sats,
    })
    (ok true)
  )
)

(define-public (claim-rewards (reward-cycle uint))
  (let (
      (result (try! (contract-call? 'SP000000000000000000002Q6VF78.pox-5 claim-rewards (list)
        reward-cycle
      )))
      (earned (get total-rewards result))
      (settlement (get-settlement reward-cycle))
      (first-claim (is-eq (get deadline settlement) u0))
      (deadline (if first-claim
        (+ burn-block-height SWAP_WINDOW_BURN_BLOCKS)
        (get deadline settlement)
      ))
    )
    (var-set unswapped-sats (+ (var-get unswapped-sats) earned))
    (if first-claim
      (map-set fee-bips-for-cycle reward-cycle (get-active-fee-bips))
      true
    )
    (map-set cycle-settlement reward-cycle
      (merge settlement {
        pot-sats: (+ (get pot-sats settlement) earned),
        deadline: deadline,
      })
    )
    (print {
      topic: "claim-rewards",
      reward-cycle: reward-cycle,
      earned: earned,
      pot-sats: (+ (get pot-sats settlement) earned),
      deadline: deadline,
    })
    (ok earned)
  )
)

(define-public (repair-mirror-many
    (stakers (list 100 principal))
    (reward-cycle uint)
  )
  (begin
    (asserts! (not (is-pinned reward-cycle)) ERR_SHARES_ALREADY_PINNED)
    (let (
        (summary (fold fold-repair-mirror stakers {
          reward-cycle: reward-cycle,
          removed: u0,
          added: u0,
        }))
        (total (default-to u0 (map-get? mirrored-total-shares reward-cycle)))
      )
      (map-set mirrored-total-shares reward-cycle
        (+ (- total (get removed summary)) (get added summary))
      )
      (print {
        topic: "repair-mirror",
        reward-cycle: reward-cycle,
        removed: (get removed summary),
        added: (get added summary),
      })
      (ok {
        removed: (get removed summary),
        added: (get added summary),
      })
    )
  )
)

(define-public (pin-shares (reward-cycle uint))
  (let ((settlement (get-settlement reward-cycle)))
    (asserts! (> (get deadline settlement) u0) ERR_CYCLE_NOT_CLAIMED)
    (if (get pinned settlement)
      (ok (get total-shares settlement))
      (let ((local (default-to u0 (map-get? mirrored-total-shares reward-cycle))))
        (asserts!
          (is-eq local
            (contract-call? 'SP000000000000000000002Q6VF78.pox-5
              get-signer-pending-staked-ustx-per-cycle current-contract
              reward-cycle
            ))
          ERR_SHARE_MIRROR_MISMATCH
        )
        (map-set cycle-settlement reward-cycle
          (merge settlement {
            total-shares: local,
            pinned: true,
          })
        )
        (print {
          topic: "pin-shares",
          reward-cycle: reward-cycle,
          total-shares: local,
        })
        (ok local)
      )
    )
  )
)

(define-public (distribute-rewards
    (staker principal)
    (reward-cycle uint)
  )
  (begin
    (try! (pin-shares reward-cycle))
    (let ((due (get-staker-rewards staker reward-cycle)))
      (asserts! (or (> (get stx-due due) u0) (> (get sbtc-gross-due due) u0))
        ERR_NO_CLAIMABLE_REWARDS
      )
      (try! (pay-staker staker reward-cycle due))
      (ok {
        stx: (get stx-due due),
        sbtc: (get sbtc-due due),
      })
    )
  )
)

(define-public (distribute-rewards-many
    (stakers (list 300 principal))
    (reward-cycle uint)
  )
  (begin
    (try! (pin-shares reward-cycle))
    (let (
        (settlement (get-settlement reward-cycle))
        (summary (try! (fold fold-distribute stakers
          (ok {
            reward-cycle: reward-cycle,
            stx-out: (get stx-out settlement),
            unswapped: (get-unswapped-for-cycle reward-cycle),
            total-shares: (get total-shares settlement),
            fee-bips: (get-fee-bips-for-cycle reward-cycle),
            paid-count: u0,
            total-stx: u0,
            total-sbtc: u0,
          })
        )))
      )
      (print {
        topic: "distribute-rewards-many",
        reward-cycle: reward-cycle,
        paid: (get paid-count summary),
        total-stx: (get total-stx summary),
        total-sbtc: (get total-sbtc summary),
      })
      (ok {
        paid: (get paid-count summary),
        total-stx: (get total-stx summary),
        total-sbtc: (get total-sbtc summary),
      })
    )
  )
)

(define-public (update-admin
    (admin principal)
    (enabled bool)
  )
  (begin
    (try! (authorize-admin))
    (asserts! (not (is-eq tx-sender admin)) ERR_UNAUTHORIZED_ADMIN)
    (print {
      topic: "update-admin",
      admin: admin,
      enabled: enabled,
    })
    (ok (map-set admins admin enabled))
  )
)

(define-public (update-fees (new-fees uint))
  (let (
      (active (get-active-fee-bips))
      (cycle (current-cycle))
    )
    (try! (authorize-admin))
    (asserts! (<= new-fees MAX_FEE_BIPS) ERR_INVALID_FEES_BIPS)
    (var-set fees-bips active)
    (if (<= new-fees active)
      (begin
        (var-set fees-bips new-fees)
        (var-set pending-fees-bips new-fees)
        (var-set pending-fees-cycle cycle)
      )
      (begin
        (var-set pending-fees-bips new-fees)
        (var-set pending-fees-cycle (+ cycle FEE_ACTIVATION_DELAY_CYCLES))
      )
    )
    (print {
      topic: "update-fees",
      old-fees: active,
      new-fees: new-fees,
      activation-cycle: (var-get pending-fees-cycle),
    })
    (ok true)
  )
)

(define-public (withdraw-fees
    (amount uint)
    (recipient principal)
  )
  (let ((fees (var-get earned-fees)))
    (try! (authorize-admin))
    (asserts! (<= amount fees) ERR_INSUFFICIENT_FEES)
    (var-set earned-fees (- fees amount))
    (try! (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token"
        amount
      ))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer amount tx-sender recipient none
      ))
    ))
    (print {
      topic: "withdraw-fees",
      amount-sats: amount,
      recipient: recipient,
    })
    (ok amount)
  )
)

(define-public (sweep-sbtc-dust (recipient principal))
  (let (
      (balance (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        get-balance current-contract
      )))
      (reserved (+ (var-get earned-fees) (var-get unswapped-sats)))
      (sweepable (if (>= balance reserved)
        (- balance reserved)
        u0
      ))
    )
    (try! (authorize-admin))
    (asserts! (> sweepable u0) ERR_NO_DUST)
    (try! (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token"
        sweepable
      ))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer sweepable tx-sender recipient none
      ))
    ))
    (print {
      topic: "sweep-sbtc-dust",
      amount-sats: sweepable,
      recipient: recipient,
    })
    (ok sweepable)
  )
)

(define-public (sweep-stx-dust (recipient principal))
  (let (
      (balance (stx-get-balance current-contract))
      (reserved (var-get unpaid-stx))
      (sweepable (if (>= balance reserved)
        (- balance reserved)
        u0
      ))
    )
    (try! (authorize-admin))
    (asserts! (> sweepable u0) ERR_NO_DUST)
    (try! (as-contract? ((with-stx sweepable))
      (try! (stx-transfer? sweepable tx-sender recipient))
    ))
    (print {
      topic: "sweep-stx-dust",
      amount-ustx: sweepable,
      recipient: recipient,
    })
    (ok sweepable)
  )
)

(define-public (register-self
    (signer-manager <signer-manager-trait>)
    (signer-key (buff 33))
    (auth-id uint)
    (signer-sig (buff 65))
  )
  (begin
    (try! (authorize-admin))
    (try! (contract-call? 'SP000000000000000000002Q6VF78.pox-5 grant-signer-key
      signer-key current-contract auth-id signer-sig
    ))
    (contract-call? 'SP000000000000000000002Q6VF78.pox-5 register-signer
      signer-manager signer-key
    )
  )
)

(define-private (authorize-admin)
  (ok (asserts! (and (is-eq contract-caller tx-sender) (is-admin tx-sender))
    ERR_UNAUTHORIZED_ADMIN
  ))
)

(define-private (authorize-pox-5)
  (ok (asserts! (is-eq contract-caller 'SP000000000000000000002Q6VF78.pox-5)
    ERR_UNAUTHORIZED_CALLER
  ))
)

(define-private (mirror-stake-for-cycle
    (offset uint)
    (acc {
      staker: principal,
      first-reward-cycle: uint,
      shares: uint,
    })
  )
  (let ((reward-cycle (+ (get first-reward-cycle acc) offset)))
    (if (is-pinned reward-cycle)
      acc
      (let (
          (staker (get staker acc))
          (shares (get shares acc))
          (previous (default-to u0
            (map-get? mirrored-shares {
              staker: staker,
              reward-cycle: reward-cycle,
            })
          ))
          (total (default-to u0 (map-get? mirrored-total-shares reward-cycle)))
        )
        (map-set mirrored-shares {
          staker: staker,
          reward-cycle: reward-cycle,
        }
          shares
        )
        (map-set mirrored-total-shares reward-cycle (+ (- total previous) shares))
        acc
      )
    )
  )
)

(define-private (fold-repair-mirror
    (staker principal)
    (acc {
      reward-cycle: uint,
      removed: uint,
      added: uint,
    })
  )
  (let (
      (reward-cycle (get reward-cycle acc))
      (truth (contract-call? 'SP000000000000000000002Q6VF78.pox-5
        get-staker-shares-staked-for-cycle staker reward-cycle none
        current-contract
      ))
      (previous (default-to u0
        (map-get? mirrored-shares {
          staker: staker,
          reward-cycle: reward-cycle,
        })
      ))
    )
    (if (is-eq truth previous)
      acc
      (begin
        (map-set mirrored-shares {
          staker: staker,
          reward-cycle: reward-cycle,
        }
          truth
        )
        (if (> previous truth)
          (merge acc { removed: (+ (get removed acc) (- previous truth)) })
          (merge acc { added: (+ (get added acc) (- truth previous)) })
        )
      )
    )
  )
)

(define-private (compute-due
    (staker principal)
    (reward-cycle uint)
    (stx-out uint)
    (unswapped uint)
    (total-shares uint)
    (fee-bips uint)
  )
  (let (
      (shares (default-to u0
        (map-get? mirrored-shares {
          staker: staker,
          reward-cycle: reward-cycle,
        })
      ))
      (stx-paid (default-to u0
        (map-get? staker-stx-paid {
          staker: staker,
          reward-cycle: reward-cycle,
        })
      ))
      (sbtc-accounted (default-to u0
        (map-get? staker-sbtc-accounted {
          staker: staker,
          reward-cycle: reward-cycle,
        })
      ))
      (stx-entitled (if (is-eq total-shares u0)
        u0
        (/ (* stx-out shares) total-shares)
      ))
      (sbtc-entitled (if (is-eq total-shares u0)
        u0
        (/ (* unswapped shares) total-shares)
      ))
      (sbtc-gross-due (if (> sbtc-entitled sbtc-accounted)
        (- sbtc-entitled sbtc-accounted)
        u0
      ))
      (sbtc-fee (/ (* sbtc-gross-due fee-bips) BIPS_DENOMINATOR))
    )
    {
      shares: shares,
      stx-entitled: stx-entitled,
      stx-paid: stx-paid,
      stx-due: (if (> stx-entitled stx-paid)
        (- stx-entitled stx-paid)
        u0
      ),
      sbtc-entitled: sbtc-entitled,
      sbtc-accounted: sbtc-accounted,
      sbtc-gross-due: sbtc-gross-due,
      sbtc-fee: sbtc-fee,
      sbtc-due: (- sbtc-gross-due sbtc-fee),
    }
  )
)

(define-private (pay-staker
    (staker principal)
    (reward-cycle uint)
    (due {
      shares: uint,
      stx-entitled: uint,
      stx-paid: uint,
      stx-due: uint,
      sbtc-entitled: uint,
      sbtc-accounted: uint,
      sbtc-gross-due: uint,
      sbtc-fee: uint,
      sbtc-due: uint,
    })
  )
  (let (
      (stx-due (get stx-due due))
      (sbtc-due (get sbtc-due due))
    )
    (if (> stx-due u0)
      (begin
        (map-set staker-stx-paid {
          staker: staker,
          reward-cycle: reward-cycle,
        }
          (get stx-entitled due)
        )
        (var-set unpaid-stx (- (var-get unpaid-stx) stx-due))
        (try! (as-contract? ((with-stx stx-due))
          (try! (stx-transfer? stx-due tx-sender staker))
        ))
      )
      true
    )
    (if (> (get sbtc-gross-due due) u0)
      (begin
        (map-set staker-sbtc-accounted {
          staker: staker,
          reward-cycle: reward-cycle,
        }
          (get sbtc-entitled due)
        )
        (var-set unswapped-sats
          (- (var-get unswapped-sats) (get sbtc-gross-due due))
        )
        (var-set earned-fees (+ (var-get earned-fees) (get sbtc-fee due)))
        (if (> sbtc-due u0)
          (try! (as-contract?
            ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              "sbtc-token" sbtc-due
            ))
            (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              transfer sbtc-due tx-sender staker none
            ))
          ))
          true
        )
      )
      true
    )
    (print {
      topic: "distribute-rewards",
      staker: staker,
      reward-cycle: reward-cycle,
      stx: stx-due,
      sbtc: sbtc-due,
      sbtc-fee: (get sbtc-fee due),
    })
    (ok true)
  )
)

(define-private (fold-distribute
    (staker principal)
    (acc (response {
      reward-cycle: uint,
      stx-out: uint,
      unswapped: uint,
      total-shares: uint,
      fee-bips: uint,
      paid-count: uint,
      total-stx: uint,
      total-sbtc: uint,
    }
      uint
    ))
  )
  (let (
      (state (try! acc))
      (reward-cycle (get reward-cycle state))
      (due (compute-due staker reward-cycle (get stx-out state) (get unswapped state)
        (get total-shares state) (get fee-bips state)
      ))
    )
    (if (and (is-eq (get stx-due due) u0) (is-eq (get sbtc-gross-due due) u0))
      (ok state)
      (begin
        (try! (pay-staker staker reward-cycle due))
        (ok (merge state {
          paid-count: (+ (get paid-count state) u1),
          total-stx: (+ (get total-stx state) (get stx-due due)),
          total-sbtc: (+ (get total-sbtc state) (get sbtc-due due)),
        }))
      )
    )
  )
)

(define-read-only (is-admin (caller principal))
  (default-to false (map-get? admins caller))
)

(define-read-only (current-cycle)
  (contract-call? 'SP000000000000000000002Q6VF78.pox-5 current-pox-reward-cycle)
)

(define-read-only (get-active-fee-bips)
  (if (>= (current-cycle) (var-get pending-fees-cycle))
    (var-get pending-fees-bips)
    (var-get fees-bips)
  )
)

(define-read-only (get-pending-fees)
  {
    pending-bips: (var-get pending-fees-bips),
    activation-cycle: (var-get pending-fees-cycle),
    active-bips: (get-active-fee-bips),
  }
)

(define-read-only (get-fee-bips-for-cycle (reward-cycle uint))
  (default-to (get-active-fee-bips) (map-get? fee-bips-for-cycle reward-cycle))
)

(define-read-only (get-earned-fees)
  (var-get earned-fees)
)

(define-read-only (get-settlement (reward-cycle uint))
  (default-to EMPTY_SETTLEMENT (map-get? cycle-settlement reward-cycle))
)

(define-read-only (is-pinned (reward-cycle uint))
  (get pinned (get-settlement reward-cycle))
)

(define-read-only (get-swap-status (reward-cycle uint))
  { remaining-sats: (- (get pot-sats (get-settlement reward-cycle))
                      (get swapped-sats (get-settlement reward-cycle))),
    in-vault: (is-eq (var-get vault-cycle) (some reward-cycle)) })

(define-read-only (get-unswapped-for-cycle (reward-cycle uint)) u0)

(define-read-only (check-mirror (reward-cycle uint))
  (let (
      (local (default-to u0 (map-get? mirrored-total-shares reward-cycle)))
      (remote (contract-call? 'SP000000000000000000002Q6VF78.pox-5
        get-signer-pending-staked-ustx-per-cycle current-contract reward-cycle
      ))
    )
    {
      local: local,
      pox-5: remote,
      matches: (is-eq local remote),
    }
  )
)

(define-read-only (get-mirrored-shares
    (staker principal)
    (reward-cycle uint)
  )
  (default-to u0
    (map-get? mirrored-shares {
      staker: staker,
      reward-cycle: reward-cycle,
    })
  )
)

(define-read-only (get-mirrored-total-shares (reward-cycle uint))
  (default-to u0 (map-get? mirrored-total-shares reward-cycle))
)

(define-read-only (get-staker-rewards
    (staker principal)
    (reward-cycle uint)
  )
  (let ((settlement (get-settlement reward-cycle)))
    (compute-due staker reward-cycle (get stx-out settlement)
      (get-unswapped-for-cycle reward-cycle) (get total-shares settlement)
      (get-fee-bips-for-cycle reward-cycle)
    )
  )
)

(define-read-only (get-unswapped-sats)
  (var-get unswapped-sats)
)

(define-read-only (get-unpaid-stx)
  (var-get unpaid-stx)
)

(define-constant SWAP_VAULT .fastpool-swap-vault)
(define-constant ERR_VAULT_BUSY (err u1050))
(define-data-var vault-cycle (optional uint) none)
(define-public (fund-swap-vault (reward-cycle uint))
  (begin
    (asserts! (is-none (var-get vault-cycle)) ERR_VAULT_BUSY)
    (try! (pin-shares reward-cycle))
    (let ((s (get-settlement reward-cycle))
          (gross (- (get pot-sats s) (get swapped-sats s)))
          (fee (/ (* gross (get-fee-bips-for-cycle reward-cycle)) BIPS_DENOMINATOR))
          (net (- gross fee)))
      (asserts! (> net u0) ERR_VAULT_BUSY)
      (try! (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" net))
        (try! (contract-call? SWAP_VAULT fund net))))
      (var-set earned-fees (+ (var-get earned-fees) fee))
      (var-set unswapped-sats (- (var-get unswapped-sats) gross))
      (map-set cycle-settlement reward-cycle (merge s {
        swapped-sats: (+ (get swapped-sats s) gross),
        fee-sats: (+ (get fee-sats s) fee) }))
      (var-set vault-cycle (some reward-cycle))
      (ok net))))

(define-public (finalize-swap-vault)
  (let ((cycle (unwrap! (var-get vault-cycle) ERR_VAULT_BUSY))
        (before (stx-get-balance current-contract))
        (amount (try! (contract-call? SWAP_VAULT finish)))
        (s (get-settlement cycle)))
    (asserts! (is-eq (- (stx-get-balance current-contract) before) amount) ERR_VAULT_BUSY)
    (map-set cycle-settlement cycle (merge s { stx-out: (+ (get stx-out s) amount) }))
    (var-set unpaid-stx (+ (var-get unpaid-stx) amount))
    (var-set vault-cycle none)
    (ok amount)))

(define-public (refloor-vault (update (buff 8192)))
  (begin
    (try! (authorize-admin))
    (contract-call? SWAP_VAULT jing-refloor update)))

(define-read-only (get-vault-cycle) (var-get vault-cycle))

;; Vault configuration may change only between batches.
(define-public (set-vault-window-blocks (blocks uint))
  (begin
    (try! (authorize-admin))
    (contract-call? SWAP_VAULT set-window-blocks blocks)))

(define-public (router-swap-split
    (amount uint) (jing uint) (dlmm uint) (xyk uint) (velar uint)
    (update (buff 8192)))
  (begin
    (try! (authorize-admin))
    (contract-call? SWAP_VAULT router-swap-split amount jing dlmm xyk velar update)))

(define-public (set-vault-no-pyth-slippage-bps (bps uint))
  (begin
    (try! (authorize-admin))
    (contract-call? SWAP_VAULT set-no-pyth-slippage-bps bps)))

(define-public (router-swap-split-dia
    (amount uint) (dlmm uint) (xyk uint) (velar uint))
  (begin
    (try! (authorize-admin))
    (contract-call? SWAP_VAULT router-swap-split-dia amount dlmm xyk velar)))
