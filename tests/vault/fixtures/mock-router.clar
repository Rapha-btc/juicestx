;; Mock swap-router-sbtc-stx-jing-v5 for RV fuzzing of the ccd016 vault.
;; The real router splits a sale across the Jing book, Bitflow DLMM / XYK
;; and Velar; none of those run in simnet. This mock is one venue that
;; buys sBTC at the mock Lazer mid with the STX it holds (the SUT's
;; rv-fund-router wrapper gives it some): it takes `amount` sats, pays
;; sats * mid / 1e10 micro-STX when it can (and that clears min-out), and
;; otherwise takes nothing and reports everything unsold, the way the real
;; router returns what no venue could fill inside the floor. u3002 is the
;; real router's min-out code.
(use-trait ft-trait .sip-010-trait.sip-010-trait)

(define-constant SCALE u10000000000)
;; Test-only fault knobs for the vault's floor checks: refuse every sale
;; (all unsold), or pay `haircut-bps` under the mid.
(define-data-var refuse bool false)
(define-data-var haircut-bps uint u0)
(define-public (set-refuse (b bool)) (ok (var-set refuse b)))
(define-public (set-haircut-bps (b uint)) (ok (var-set haircut-bps b)))
;; Test-only: sell `extra` sats on top of `amount`, as the real router does
;; when the market refunds a sub-min rest plus the unused rebate and the AMM
;; stages re-sell them out of the caller's wallet.
(define-data-var extra uint u0)
(define-public (set-extra (n uint)) (ok (var-set extra n)))

(define-private (sell
    (amount uint)
    (min-out uint)
  )
  (let (
      (mid (contract-call? .mock-lazer-oracle get-mid))
      (out (/ (* (/ (* amount mid) SCALE) (- u10000 (var-get haircut-bps))) u10000))
      (taker tx-sender)
    )
    (if (or (var-get refuse) (is-eq amount u0) (> out (stx-get-balance current-contract)))
      (begin (asserts! (is-eq min-out u0) (err u3002)) (ok { out: u0, unsold: amount }))
      (begin
        (asserts! (>= out min-out) (err u3002))
        (try! (contract-call? .mock-ft transfer amount taker current-contract none))
        (try! (as-contract? ((with-stx out))
          (try! (stx-transfer? out current-contract taker))))
        (ok { out: out, unsold: u0 })))))

;; The real router's Jing leg hands `update` to the v6-3 market, whose `swap`
;; verifies it once and settles on those feeds, charging the oracle fee to the
;; caller once. Mirror that: a supplied update is verified once through the
;; mock oracle.
(define-private (verify (update (optional (buff 8192))))
  (match update
    u (begin
      (try! (contract-call? .mock-lazer-oracle verify-price-feeds u .mock-lazer-oracle none))
      (ok true))
    (ok true)))

(define-public (smart-swap-sbtc-for-stx
    (amount uint)
    (limit-price uint)
    (update (optional (buff 8192)))
    (mid uint)
    (min-stx-out uint)
  )
  (begin
    (try! (verify update))
    (let ((r (try! (sell (+ amount (var-get extra)) min-stx-out))))
      (ok { out: (get out r), unsold: (if (> (get unsold r) u0) amount u0) }))))

(define-public (swap-sbtc-for-stx
    (amount uint)
    (jing-amount uint)
    (limit-price uint)
    (update (optional (buff 8192)))
    (fallback (optional uint))
    (amm-amounts { dlmm: uint, xyk: uint, velar: uint })
    (amm-mins { dlmm: uint, xyk: uint, velar: uint })
    (min-stx-out uint)
  )
  (begin (try! (verify update)) (sell amount min-stx-out)))

;; Router v6 shape (swap-router-sbtc-stx-jing-v6, Zest leg): zest in both AMM
;; tuples plus a trailing zest route. tests/vault/build.py --v2 points the
;; autoswap-v2 split calls here; the mock still sells the whole amount at mid.
(define-public (swap-sbtc-for-stx-v6
    (amount uint)
    (jing-amount uint)
    (limit-price uint)
    (update (optional (buff 8192)))
    (fallback (optional uint))
    (amm-amounts { zest: uint, dlmm: uint, xyk: uint, velar: uint })
    (amm-mins { zest: uint, dlmm: uint, xyk: uint, velar: uint })
    (min-stx-out uint)
    (zest-route { ticks: (list 32 int), price: uint })
  )
  (begin (try! (verify update)) (sell amount min-stx-out)))
