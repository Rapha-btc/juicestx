;; title: juice-staker
;; version: 0.1 (scaffold)
;; summary: PoX-5 staker for Juice. Holds the pool's sBTC + paired STX and
;;   registers ONE position, crediting a chosen signer-manager (the signer).
;; description:
;;   Multiple instances are deployed per signer-manager (bond laddering - see
;;   migration-jstx-to-pox5.md). Each instance does EITHER:
;;     - jBTC:  stake-bond  -> register-for-bond, sBTC-custody path
;;     - jSTX:  stake-stx   -> stake, STX-only path
;;   (pox-5 rejects holding both at once: ERR_ALREADY_STAKED.)
;;
;;   "100% sBTC + ~5% STX": the STX pairing for `sats` is set by pox-5, not us:
;;     required = min-ustx-for-sats-amount(sats, bond.stx-value-ratio, bond.min-ustx-ratio)
;;   This contract must already hold both legs before staking; the calls run
;;   under as-contract so tx-sender == this contract (the staker).
;;
;;   !! SCAFFOLD - admin/keeper-driven; treasury funding of the two legs is out
;;   of scope here. Built to compile + test against the WIP pox-5 source.

(use-trait signer-mgr .pox-5.signer-manager-trait)

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

(define-constant ERR_UNAUTHORIZED          (err u300))
(define-constant ERR_INSUFFICIENT_STX_PAIR (err u301))
(define-constant ERR_NO_BOND               (err u302))

;; Who may drive this staker (the signer-manager / keeper / core orchestrator).
(define-data-var admin principal tx-sender)

(define-private (assert-admin)
  (ok (asserts! (is-eq contract-caller (var-get admin)) ERR_UNAUTHORIZED)))

(define-public (set-admin (new-admin principal))
  (begin (try! (assert-admin)) (ok (var-set admin new-admin))))

(define-read-only (get-admin) (var-get admin))

;; -----------------------------------------------------------------------------
;; STX pairing - read the bond's params from pox-5 and compute the minimum STX.
;; This is the "~5%": min-ustx-ratio (bps) x value-of-sats-in-STX.
;; -----------------------------------------------------------------------------

(define-read-only (required-stx-pairing (bond-index uint) (sats uint))
  (match (contract-call? .pox-5 get-protocol-bond bond-index)
    bond (ok (contract-call? .pox-5 min-ustx-for-sats-amount
               sats (get stx-value-ratio bond) (get min-ustx-ratio bond)))
    ERR_NO_BOND))

;; -----------------------------------------------------------------------------
;; jBTC - sBTC-custody bond path
;; This contract must already hold >= sats sBTC and >= amount-ustx STX.
;; -----------------------------------------------------------------------------

(define-public (stake-bond
    (signer-manager <signer-mgr>)
    (bond-index uint)
    (sats uint)
    (amount-ustx uint)
  )
  (begin
    (try! (assert-admin))
    ;; never under-pair the STX leg vs what pox-5 will require
    (asserts! (>= amount-ustx (try! (required-stx-pairing bond-index sats)))
      ERR_INSUFFICIENT_STX_PAIR)
    (as-contract
      (contract-call? .pox-5 register-for-bond
        bond-index signer-manager amount-ustx (err sats) none))))

;; Roll the position into a later bond (typically bond-index + 6). Same call;
;; pox-5 nets the sBTC delta and enforces the L1-unlock rollover window.
(define-public (rollover-bond
    (signer-manager <signer-mgr>)
    (next-bond-index uint)
    (sats uint)
    (amount-ustx uint)
  )
  (stake-bond signer-manager next-bond-index sats amount-ustx))

;; Withdraw `sats` sBTC out of the bond back to this contract (as-contract so
;; pox-5 sends it to this staker, not an EOA).
(define-public (unstake-sbtc (signer-manager <signer-mgr>) (sats uint))
  (begin
    (try! (assert-admin))
    (as-contract (contract-call? .pox-5 unstake-sbtc signer-manager sats))))

;; -----------------------------------------------------------------------------
;; jSTX - STX-only path
;; This contract must already hold >= amount-ustx STX.
;; -----------------------------------------------------------------------------

(define-public (stake-stx
    (signer-manager <signer-mgr>)
    (amount-ustx uint)
    (num-cycles uint)
    (start-burn-ht uint)
  )
  (begin
    (try! (assert-admin))
    (as-contract
      (contract-call? .pox-5 stake signer-manager amount-ustx num-cycles start-burn-ht none))))

;; -----------------------------------------------------------------------------
;; Read-only - this staker's pox-5 state
;; -----------------------------------------------------------------------------

(define-read-only (whoami) (as-contract tx-sender))

(define-read-only (get-membership)
  (contract-call? .pox-5 get-bond-membership (as-contract tx-sender)))

(define-read-only (get-custodied-sbtc)
  (contract-call? .pox-5 get-staker-custodied-sbtc (as-contract tx-sender)))

(define-read-only (get-staker-info)
  (contract-call? .pox-5 get-staker-info (as-contract tx-sender)))
