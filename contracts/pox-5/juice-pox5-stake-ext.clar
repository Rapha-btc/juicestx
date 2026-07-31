;; title: juice-pox5-stake-ext
;; summary: Lets an ALREADY-DEPLOYED fak.fun smart wallet stake on pox-5 with
;;   the Juice signer, without redeploying the wallet.
;; description:
;;   fak.fun wallets v6-v8 shipped with `stack-stx-juice`, which calls pox-4
;;   `delegate-stx`. pox-4 ended at cycle 140, so every one of those wallets is
;;   holding unlocked STX with no way to stake it. A new wallet template only
;;   helps wallets deployed after it, which is nobody who is already stranded.
;;
;;   The wallet's `extension-call` is the way through: a whitelisted contract
;;   implementing extension-trait, invoked under
;;   `(as-contract? ((with-all-assets-unsafe)) (contract-call? extension call payload))`.
;;   as-contract sets tx-sender to the WALLET, and pox-5's `stake` keys off
;;   tx-sender, so the wallet's own STX locks in the wallet. Nothing custodies
;;   anything.
;;
;;   WHAT THIS CANNOT DO. `call` receives a (buff 2048) and nothing else, so no
;;   trait reference can reach it. pox-5 `stake-update` needs the OLD
;;   signer-manager as a trait, which differs per pool, so switching INTO Juice
;;   from another pox-5 pool is impossible through this path and belongs in the
;;   v9 wallet template, where it can be a real parameter. Every action here
;;   therefore names only hardcoded principals: stake with Juice, top up Juice,
;;   leave Juice.
;;
;;   NO as-contract IN HERE. That would rebind tx-sender to this contract and
;;   stake ITS balance instead of the caller's. tx-sender must pass through
;;   untouched, which is the whole mechanism.
;;
;;   ANYONE MAY CALL THIS. There is no caller gate and none is wanted: every
;;   function acts on tx-sender's own position, so an EOA calling directly just
;;   stakes its own STX with Juice. It holds no funds and has no admin. The
;;   trust a wallet owner extends by whitelisting it is bounded by the fact that
;;   the only contract it ever calls is pox-5.

(impl-trait 'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.extension-trait.extension-trait)

(define-constant POX5 'SP000000000000000000002Q6VF78.pox-5)
(define-constant JUICE-SIGNER
  'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.juice-pool-stx-signer)

;; Maximum lock pox-5 accepts. NOT a commitment: `unstake` truncates a staker's
;; shares to current-cycle + 1 whenever it is called, so 96 buys the longest
;; auto-rolling position available rather than locking anyone in for 96 cycles.
;; Matches what the web widget passes, so a wallet and an EOA behave the same.
(define-constant NUM-CYCLES u96)

(define-constant ERR-BAD-PAYLOAD    (err u200))
(define-constant ERR-BAD-ACTION     (err u201))
(define-constant ERR-ZERO-AMOUNT    (err u202))
(define-constant ERR-OTHER-SIGNER   (err u203))
(define-constant ERR-NOT-STAKED     (err u204))

;; The payload the wallet passes through `extension-call`, consensus-encoded.
;; `amount-ustx` is ignored by "unstake".
(define-constant PAYLOAD-SHAPE { action: (string-ascii 12), amount-ustx: uint })

(define-read-only (get-signer) JUICE-SIGNER)
(define-read-only (get-num-cycles) NUM-CYCLES)

;; Who tx-sender is currently staked with, if anyone.
(define-read-only (current-signer (who principal))
  (match (contract-call? POX5 get-staker-info who)
    info (some (get signer info))
    none
  ))

;; Encode a payload off-chain-equivalently, so the front end can be checked
;; against the contract rather than against a comment.
(define-read-only (encode-stake (amount-ustx uint))
  (to-consensus-buff? { action: "stake", amount-ustx: amount-ustx }))

(define-read-only (encode-unstake)
  (to-consensus-buff? { action: "unstake", amount-ustx: u0 }))

(define-public (call (payload (buff 2048)))
  (let ((cmd (unwrap! (from-consensus-buff? PAYLOAD-SHAPE payload) ERR-BAD-PAYLOAD))
        (action (get action cmd)))
    (if (is-eq action "stake")
      (do-stake (get amount-ustx cmd))
      (if (is-eq action "unstake")
        (do-unstake)
        ERR-BAD-ACTION))))

;; Stake, or top up an existing Juice position.
;;
;; The branch is here rather than in the caller because `call` is a single entry
;; point: splitting stake from top-up would mean two extensions and two
;; whitelist ceremonies per wallet, to save one read. pox-5 rejects `stake` with
;; ERR_ALREADY_STAKED once a position exists, so the branch is required, not a
;; convenience.
(define-private (do-stake (amount-ustx uint))
  (begin
    (asserts! (> amount-ustx u0) ERR-ZERO-AMOUNT)
    (match (current-signer tx-sender)
      signer (begin
        ;; Staked elsewhere: stake-update could move them, but it needs the old
        ;; signer-manager as a trait and no trait can cross `call`'s buffer.
        ;; Fail loudly rather than silently doing something else.
        (asserts! (is-eq signer JUICE-SIGNER) ERR-OTHER-SIGNER)
        ;; try!, NOT (err (to-uint ...)): pox-5's errors are already uint --
        ;; ERR_ALREADY_STAKED is (err u19). The pox-4 call sites in the wallet
        ;; template coerce because pox-4 returns INT errors; copying that
        ;; pattern here does not typecheck.
        (try! (contract-call? POX5 stake-update
          JUICE-SIGNER JUICE-SIGNER u0 amount-ustx none))
        (ok true))
      ;; start-burn-ht must fall inside the CURRENT reward cycle so pox-5
      ;; resolves first-reward-cycle to current + 1. burn-block-height always
      ;; does, and unlike a caller-supplied height it cannot be wrong or forged.
      (begin
        (try! (contract-call? POX5 stake
          JUICE-SIGNER amount-ustx NUM-CYCLES burn-block-height none))
        (ok true)))))

;; Leave Juice. pox-5 removes shares from current-cycle + 1, so the cycle in
;; progress still pays out; the STX unlocks when its lock ends.
(define-private (do-unstake)
  (begin
    (asserts! (is-some (current-signer tx-sender)) ERR-NOT-STAKED)
    (try! (contract-call? POX5 unstake JUICE-SIGNER))
    (ok true)))
