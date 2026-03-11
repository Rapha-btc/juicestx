;; Title: core
;;
;; What this contract does:
;; This is the main entry point for users of STX Juice.
;; It handles four actions:
;;
;; 1. DEPOSIT: User sends STX -> gets jSTX back
;;    - Fees contract takes its cut from the ustx amount
;;    - Remaining STX goes into the vault
;;    - jSTX is minted to the user for the net amount
;;    - The STX sits idle until the next cycle when it gets delegated to signers
;;
;; 2. WITHDRAW-FREE: Instant withdrawal of unstacked STX
;;    - If STX was deposited this cycle but hasn't been delegated yet,
;;      the user can withdraw it immediately without the NFT flow
;;
;; 3. START-WITHDRAW: User wants their stacked STX back -> gets a withdrawal NFT
;;    - jSTX is reserved (not burned yet -- burned on final withdraw)
;;    - A withdrawal NFT is minted with the unlock height (end of current PoX cycle)
;;    - User must wait until the cycle ends for STX to unlock from stacking
;;
;; 4. WITHDRAW: User redeems their withdrawal NFT -> gets STX back
;;    - Must be past the unlock height
;;    - Burns the withdrawal NFT + reserved jSTX
;;    - Sends STX from vault to user
;;
;; The 1:1 ratio is fixed -- jSTX doesn't rebase. Yield comes as separate sBTC.
;;
;; Dependencies are passed as trait parameters so contracts can be upgraded
;; without redeploying core. Each trait input is verified as DAO-authorized.
;; Fee logic lives entirely in the fees contract -- core only enforces a max cap.
;;
;; Inspired by: StackingDAO stacking-dao-core-btc-v3.clar, SP3XXMS38VTAWTVPE5682XSBFXPTH7XCPEBTX8AN2.yin

(use-trait vault-trait .vault-trait.vault-trait)
(use-trait fees-trait .fees-trait.fees-trait)


;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u10001))
(define-constant ERR_ZERO_AMOUNT (err u10002))
(define-constant ERR_NOT_UNLOCKED (err u10003))
(define-constant ERR_NOT_NFT_OWNER (err u10004))
(define-constant ERR_NO_RECEIPT (err u10005))
(define-constant ERR_STOPPED (err u10006))
(define-constant ERR_FEE_TOO_HIGH (err u10007))
(define-constant ERR_INSUFFICIENT_PENDING (err u10008))
(define-constant ERR_PREPARE_BUFFER_TOO_LOW (err u10009))
(define-constant ERR_BUFFER_OUT_OF_RANGE (err u10010))

(define-constant PRECISION u10000)
(define-constant MAX_BUFFER u2100)

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Per-function freeze -- admin can disable deposits while keeping withdrawals open
(define-data-var deposits-stopped bool false)
(define-data-var withdrawals-stopped bool false)
(define-data-var withdraw-pending-stopped bool false)

;; Max fee cap in basis points (e.g. 500 = 5%). Fees contract can't take more than this.
(define-data-var max-deposit-fee uint u500)
(define-data-var max-withdraw-fee uint u500)

;; Prepare phase length: last 100 blocks of each cycle.
;; Deposits during prepare phase can't be delegated for the upcoming cycle,
;; so they're tracked as idle for the next cycle instead.
(define-data-var prepare-buffer uint u100)

;; Blocks after cycle start before withdrawals can be claimed.
;; Gives the protocol time to return unlocked STX to the vault.
(define-data-var finalize-buffer uint u10)

;; Track how much STX is idle per cycle (deposited but not yet stacked)
;; Resets when strategy delegates STX to signers
(define-map pending-ustx-per-cycle uint uint)

;; ---------------------------------------------------------
;; PoX helpers
;; ---------------------------------------------------------

(define-read-only (get-pending-ustx (cycle uint))
  (default-to u0 (map-get? pending-ustx-per-cycle cycle))
)

;; Which cycle should idle STX be attributed to?
;; If we're past the prepare-phase cutoff, STX won't be delegated
;; until the cycle after next -- so idle belongs to cycle+1.
(define-read-only (get-pending-cycle)
  (let (
    (this-cycle (contract-call? 'SP000000000000000000002Q6VF78.pox-4 current-pox-reward-cycle))
    (next-cycle-start (contract-call? 'SP000000000000000000002Q6VF78.pox-4 reward-cycle-to-burn-height (+ this-cycle u1)))
  )
    (if (< burn-block-height (- next-cycle-start (var-get prepare-buffer)))
      this-cycle
      (+ this-cycle u1)
    )
  )
)

;; Burn height at which withdrawn STX unlocks.
;; Before prepare cutoff: unlocks at start of next cycle
;; After prepare cutoff: unlocks at start of cycle after next
;; Reuses the same cycle boundary computed by get-pending-cycle.
(define-read-only (get-unlock-height)
  (let (
    (this-cycle (contract-call? 'SP000000000000000000002Q6VF78.pox-4 current-pox-reward-cycle))
    (next-cycle-start (contract-call? 'SP000000000000000000002Q6VF78.pox-4 reward-cycle-to-burn-height (+ this-cycle u1)))
    (cycle-length (- next-cycle-start (contract-call? 'SP000000000000000000002Q6VF78.pox-4 reward-cycle-to-burn-height this-cycle)))
    (finalize (var-get finalize-buffer))
  )
    (if (< burn-block-height (- next-cycle-start (var-get prepare-buffer)))
      (+ next-cycle-start finalize)
      (+ next-cycle-start cycle-length finalize)
    )
  )
)

;; ---------------------------------------------------------
;; Deposit: STX -> jSTX
;; ---------------------------------------------------------

;; User deposits STX. Fees contract takes its cut (pass .fees-none for zero fees).
;; Rest goes to vault. jSTX is minted for the net amount.
;; Optional stacker param: pick a signer, or pass none for protocol-allocated split.
(define-public (deposit (ustx uint) (vault <vault-trait>) (stacker (optional principal)) (sponsor (optional principal)) (fees <fees-trait>))
  (let (
    (fee (try! (contract-call? fees pay ustx sponsor)))
    (ustx-net (- ustx fee))
    (cycle (get-pending-cycle))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized (contract-of vault)))
    (try! (contract-call? .dao check-is-authorized (contract-of fees)))
    (if (is-some stacker)
      (try! (contract-call? .dao check-is-authorized (unwrap-panic stacker)))
      true
    )
    (asserts! (not (var-get deposits-stopped)) ERR_STOPPED)
    (asserts! (> ustx u0) ERR_ZERO_AMOUNT)
    (asserts! (<= fee (/ (* ustx (var-get max-deposit-fee)) PRECISION)) ERR_FEE_TOO_HIGH)

    ;; Transfer net STX to vault
    (try! (contract-call? vault receive ustx-net))

    ;; Mint jSTX to user
    (try! (contract-call? .jstx-token mint ustx-net tx-sender))

    ;; Record stacker preference (none = protocol allocates via registry weights)
    (try! (contract-call? .delegation assign tx-sender stacker ustx-net))

    ;; Track pending STX for the correct cycle (accounts for prepare phase cutoff)
    (map-set pending-ustx-per-cycle cycle (+ (get-pending-ustx cycle) ustx-net))

    (print { action: "deposit", user: tx-sender, ustx: ustx, ustx-net: ustx-net, fee: fee, stacker: stacker })
    (ok ustx-net)
  )
)

;; ---------------------------------------------------------
;; Withdraw-idle: instant withdrawal of unstacked STX
;; ---------------------------------------------------------

;; If STX was deposited this cycle but hasn't been delegated yet,
;; the user can withdraw it immediately without the NFT flow.
(define-public (withdraw-pending (ustx uint) (vault <vault-trait>))
  (let (
    (cycle (get-pending-cycle))
    (current-pending (get-pending-ustx cycle))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized (contract-of vault)))
    (asserts! (not (var-get withdraw-pending-stopped)) ERR_STOPPED)
    (asserts! (> ustx u0) ERR_ZERO_AMOUNT)
    (asserts! (>= current-pending ustx) ERR_INSUFFICIENT_PENDING)

    ;; Decrease idle tracking
    (map-set pending-ustx-per-cycle cycle (- current-pending ustx))

    ;; Burn jSTX
    (try! (contract-call? .jstx-token burn ustx tx-sender))

    ;; Reduce stacker preference
    (try! (contract-call? .delegation reduce tx-sender ustx))

    ;; Send STX from vault to user
    (try! (contract-call? vault release ustx tx-sender))

    (print { action: "withdraw-pending", user: tx-sender, ustx: ustx, cycle: cycle })
    (ok ustx)
  )
)

;; ---------------------------------------------------------
;; Start-withdraw: burn jSTX, get withdrawal NFT
;; ---------------------------------------------------------

;; User initiates a withdrawal. jSTX is transferred to this contract (not burned
;; yet -- burned on final withdraw). Total supply stays the same so reward math
;; stays consistent during the waiting period.
(define-public (start-withdraw (ustx uint) (vault <vault-trait>))
  (let (
    (unlock-height (get-unlock-height))
    (nft-id (try! (contract-call? .redeem-nft mint ustx unlock-height tx-sender)))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized (contract-of vault)))
    (asserts! (not (var-get withdrawals-stopped)) ERR_STOPPED)
    (asserts! (> ustx u0) ERR_ZERO_AMOUNT)

    ;; Transfer jSTX from user to this contract (burned on final withdraw)
    (try! (contract-call? .jstx-token transfer ustx tx-sender current-contract none))

    ;; Earmark STX in vault so stacker doesn't touch it
    (try! (contract-call? vault reserve ustx))

    ;; Reduce stacker preference (STX leaving the active pool)
    (try! (contract-call? .delegation reduce tx-sender ustx))

    (print { action: "start-withdraw", user: tx-sender, ustx: ustx, unlock-height: unlock-height, nft-id: nft-id })
    (ok nft-id)
  )
)

;; ---------------------------------------------------------
;; Finalize-withdraw: burn NFT for STX
;; ---------------------------------------------------------

;; User redeems their withdrawal NFT after the unlock height has passed.
;; Burns the NFT + jSTX (held by core since start-withdraw), sends STX to user.
(define-public (finalize-withdraw (nft-id uint) (vault <vault-trait>) (fees <fees-trait>))
  (let (
    (receipt (unwrap! (unwrap-panic (contract-call? .redeem-nft get-receipt nft-id)) ERR_NO_RECEIPT))
    (ustx (get stx-amount receipt))
    (unlock-height (get unlock-height receipt))
    (nft-owner (unwrap! (contract-call? .redeem-nft get-nft-owner nft-id) ERR_NOT_NFT_OWNER))
    (fee (try! (contract-call? fees pay ustx none)))
    (ustx-net (- ustx fee))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized (contract-of vault)))
    (try! (contract-call? .dao check-is-authorized (contract-of fees)))
    (asserts! (not (var-get withdrawals-stopped)) ERR_STOPPED)
    (asserts! (is-eq tx-sender nft-owner) ERR_NOT_NFT_OWNER)
    (asserts! (>= burn-block-height unlock-height) ERR_NOT_UNLOCKED)
    (asserts! (<= fee (/ (* ustx (var-get max-withdraw-fee)) PRECISION)) ERR_FEE_TOO_HIGH)

    ;; Burn the redeem NFT
    (try! (contract-call? .redeem-nft burn nft-id))

    ;; Burn jSTX held by this contract since start-withdraw
    (try! (as-contract? ((with-ft .jstx-token "jstx" ustx))
      (try! (contract-call? .jstx-token burn ustx current-contract))
    ))

    ;; Release earmark and send net STX from vault to user
    (try! (contract-call? vault unreserve ustx))
    (try! (contract-call? vault release ustx-net tx-sender))

    (print { action: "finalize-withdraw", user: tx-sender, nft-id: nft-id, ustx: ustx, ustx-net: ustx-net, fee: fee })
    (ok ustx-net)
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

(define-read-only (get-deposits-stopped)
  (var-get deposits-stopped)
)

(define-read-only (get-withdrawals-stopped)
  (var-get withdrawals-stopped)
)

(define-read-only (get-withdraw-pending-stopped)
  (var-get withdraw-pending-stopped)
)

(define-read-only (get-max-deposit-fee)
  (var-get max-deposit-fee)
)

(define-read-only (get-max-withdraw-fee)
  (var-get max-withdraw-fee)
)

(define-read-only (get-prepare-buffer)
  (var-get prepare-buffer)
)

(define-read-only (get-finalize-buffer)
  (var-get finalize-buffer)
)

;; ---------------------------------------------------------
;; Admin
;; ---------------------------------------------------------

(define-public (set-deposits-stopped (frozen bool))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (ok (var-set deposits-stopped frozen))
  )
)

(define-public (set-withdrawals-stopped (frozen bool))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (ok (var-set withdrawals-stopped frozen))
  )
)

(define-public (set-withdraw-pending-stopped (frozen bool))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (ok (var-set withdraw-pending-stopped frozen))
  )
)

(define-public (set-max-deposit-fee (cap uint))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (ok (var-set max-deposit-fee cap))
  )
)

(define-public (set-max-withdraw-fee (cap uint))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (ok (var-set max-withdraw-fee cap))
  )
)

(define-public (set-prepare-buffer (blocks uint))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (asserts! (and (>= blocks u100) (<= blocks MAX_BUFFER)) ERR_BUFFER_OUT_OF_RANGE)
    (ok (var-set prepare-buffer blocks))
  )
)

(define-public (set-finalize-buffer (blocks uint))
  (begin
    (try! (contract-call? .dao check-is-admin tx-sender))
    (asserts! (<= blocks MAX_BUFFER) ERR_BUFFER_OUT_OF_RANGE)
    (ok (var-set finalize-buffer blocks))
  )
)
