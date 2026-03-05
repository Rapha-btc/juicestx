;; Title: core
;;
;; What this contract does:
;; This is the main entry point for users of STX Juice.
;; It handles three actions:
;;
;; 1. DEPOSIT: User sends STX -> gets jSTX back (1:1 ratio)
;;    - STX goes into the vault
;;    - jSTX is minted to the user
;;    - The STX sits idle until the next cycle when it gets delegated to signers
;;
;; 2. INIT-WITHDRAW: User wants their STX back -> gets a withdrawal NFT
;;    - jSTX is reserved (not burned yet -- burned on final withdraw)
;;    - A withdrawal NFT is minted with the unlock height (end of current PoX cycle)
;;    - User must wait until the cycle ends for STX to unlock from stacking
;;
;; 3. WITHDRAW: User redeems their withdrawal NFT -> gets STX back
;;    - Must be past the unlock height
;;    - Burns the withdrawal NFT
;;    - Burns the reserved jSTX
;;    - Sends STX from vault to user
;;
;; The 1:1 ratio is fixed -- jSTX doesn't rebase. Yield comes as separate sBTC.
;;
;; Inspired by: StackingDAO stacking-dao-core-btc-v3.clar
;; Source: stacking-dao/contracts/version-3/stacking-dao-core-btc-v3.clar

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_UNAUTHORIZED (err u10001))
(define-constant ERR_ZERO_AMOUNT (err u10002))
(define-constant ERR_NOT_UNLOCKED (err u10003))
(define-constant ERR_NOT_NFT_OWNER (err u10004))
(define-constant ERR_NO_RECEIPT (err u10005))

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Track how much STX is idle (deposited but not yet stacked)
;; vs how much is locked in PoX via delegates
(define-data-var pending-stx uint u0)

;; Track jSTX reserved for pending withdrawals (can't be transferred)
(define-map reserved-jstx principal uint)

;; ---------------------------------------------------------
;; Deposit: STX -> jSTX
;; ---------------------------------------------------------

;; User deposits STX and receives jSTX at 1:1 ratio.
;; The STX goes into the vault and sits idle until the strategy
;; delegates it to signer pools at the next cycle boundary.
(define-public (deposit (amount uint))
  (begin
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (asserts! (> amount u0) ERR_ZERO_AMOUNT)

    ;; Transfer STX from user to vault
    (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))

    ;; Mint jSTX to user (1:1)
    (try! (contract-call? .jstx-token mint amount tx-sender))

    ;; Track idle STX
    (var-set pending-stx (+ (var-get pending-stx) amount))

    (print { action: "deposit", user: tx-sender, amount: amount })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Init-withdraw: reserve jSTX, get withdrawal NFT
;; ---------------------------------------------------------

;; User initiates a withdrawal. Their jSTX is "reserved" (tracked but not
;; burned yet). They receive a withdrawal NFT that becomes redeemable
;; after the current PoX cycle ends.
;;
;; unlock-height should be set to the end of the current PoX cycle.
;; For now, we use a placeholder -- the strategy/keeper will provide this.
(define-public (init-withdraw (amount uint) (unlock-height uint))
  (let (
    (current-reserved (default-to u0 (map-get? reserved-jstx tx-sender)))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (asserts! (> amount u0) ERR_ZERO_AMOUNT)

    ;; Track reserved jSTX for this user
    (map-set reserved-jstx tx-sender (+ current-reserved amount))

    ;; Mint withdrawal NFT
    (try! (contract-call? .withdraw-nft mint amount unlock-height tx-sender))

    (print { action: "init-withdraw", user: tx-sender, amount: amount, unlock-height: unlock-height })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Withdraw: burn NFT for STX
;; ---------------------------------------------------------

;; User redeems their withdrawal NFT after the unlock height has passed.
;; Burns the NFT + jSTX, sends STX from vault to user.
(define-public (withdraw (nft-id uint))
  (let (
    (receipt (unwrap! (contract-call? .withdraw-nft get-receipt nft-id) ERR_NO_RECEIPT))
    (amount (get stx-amount receipt))
    (unlock-height (get unlock-height receipt))
    (nft-owner (unwrap! (unwrap-panic (contract-call? .withdraw-nft get-owner nft-id)) ERR_NOT_NFT_OWNER))
  )
    (try! (contract-call? .dao check-is-live))
    (try! (contract-call? .dao check-is-authorized contract-caller))
    (asserts! (is-eq tx-sender nft-owner) ERR_NOT_NFT_OWNER)
    (asserts! (>= burn-block-height unlock-height) ERR_NOT_UNLOCKED)

    ;; Burn the withdrawal NFT
    (try! (contract-call? .withdraw-nft burn nft-id))

    ;; Burn the reserved jSTX
    (try! (contract-call? .jstx-token burn amount tx-sender))

    ;; Update reserved tracking
    (let (
      (current-reserved (default-to u0 (map-get? reserved-jstx tx-sender)))
    )
      (map-set reserved-jstx tx-sender (- current-reserved amount))
    )

    ;; Send STX from vault to user
    (try! (contract-call? .vault release amount tx-sender))

    (print { action: "withdraw", user: tx-sender, nft-id: nft-id, amount: amount })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

(define-read-only (get-pending-stx)
  (var-get pending-stx)
)

(define-read-only (get-reserved-jstx (who principal))
  (default-to u0 (map-get? reserved-jstx who))
)
