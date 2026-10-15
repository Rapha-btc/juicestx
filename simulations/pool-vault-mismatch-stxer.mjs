// finalize-swap balance check, mainnet fork: a fake vault whose `finish`
// reports a different amount than it sends is refused (u121), both over- and
// under-reporting; an honest report then finalizes. The pool is pointed at the
// fake with an Eval fixture on `swap-vault` (skips the 4,032-block switch, which
// pool-vault-upgrade-stxer covers). Fixture: earned rewards for one cycle.
// Run: node simulations/pool-vault-mismatch-stxer.mjs
import { poolSim, DEP, PID, POX, SBTC, SBTC_WHALE, STX_WHALE, STRANGER, STX, acct, ok } from './_juice-pool-sim.mjs';
import { createRequire } from 'node:module';
const { Cl } = createRequire(import.meta.url)('@stacks/transactions');

const FAKE_NAME = 'juice-fake-vault', FAKE = `${DEP}.${FAKE_NAME}`;
const FAKE_SRC = `(impl-trait '${DEP}.juice-swap-vault-trait-v2.swap-vault-trait)
;; Test double: sends \`send\` uSTX to the pool on finish but reports \`report\`.
(define-data-var send uint u0)
(define-data-var report uint u0)
(define-public (set-finish (s uint) (r uint)) (begin (var-set send s) (ok (var-set report r))))
(define-public (fund (amount uint))
  (begin (try! (contract-call? '${SBTC} transfer amount tx-sender current-contract none)) (ok amount)))
(define-public (finish)
  (let ((pool contract-caller) (s (var-get send)))
    (and (> s u0) (try! (as-contract? ((with-stx s)) (try! (stx-transfer? s current-contract pool)))))
    (ok (var-get report))))
(define-public (emergency-recover) (ok { stx: u0, sbtc: u0 }))
(define-read-only (get-upgrade-status)
  (ok { pool: '${PID}, empty: true, sbtc-balance: u0, stx-balance: u0, batch-start: none, jing-resting: u0, jing-parked: u0 }))
(define-public (jing-refloor (u (buff 8192))) (ok u0))
(define-public (set-window-blocks (v uint)) (ok true))
(define-public (set-leeway-bps (v uint)) (ok true))
(define-public (set-slippage-bps (v uint)) (ok true))
(define-public (set-max-chunk-sats (v uint)) (ok true))
(define-public (set-dia-band-bps (v uint)) (ok true))
(define-public (set-router-cooldown (v uint)) (ok true))
(define-public (set-no-pyth-slippage-bps (v uint)) (ok true))
(define-public (set-pyth-fee-budget (v uint)) (ok true))
(define-public (set-maker-spread-bps (v uint)) (ok true))
(define-public (jing-take (a uint) (u (buff 8192)))
  (ok { notification: "x", payload: { amount: u0, limit-price: u0, out: u0 } }))
(define-public (router-swap-split (a uint) (b uint) (c uint) (d uint) (e uint) (u (buff 8192)))
  (ok { notification: "x", payload: { amount: u0, jing: u0, dlmm: u0, xyk: u0, velar: u0, limit-price: u0, velar-limit: u0, mid: u0, out: u0, unsold: u0 } }))
(define-public (router-swap-split-dia (a uint) (b uint) (c uint) (d uint))
  (ok { notification: "x", payload: { amount: u0, dlmm: u0, xyk: u0, velar: u0, mid: u0, limit-price: u0, price-source: "x", dia-error: none, out: u0, unsold: u0 } }))
`;

const s = await poolSim();
const A = acct('1'), B = acct('2'), FUND = 100000n, R1 = s.cycleNow - 1;
s.deploy(FAKE_NAME, FAKE_SRC);
s.builder.withSender(STX_WHALE).addSTXTransfer({ recipient: FAKE, amount: 50_000_000 });
s.plan.push({ label: 'fund the fake vault 50 STX', kind: 'transfer' }); s.builder.withSender(DEP);
s.ev('fixture: pool points at the fake vault', PID, `(begin (var-set swap-vault '${FAKE}) true)`, 'true');
s.rd('active vault is the fake', '(get-swap-vault)', FAKE);
s.call('fund real PoX sBTC (fork only)', SBTC, 'transfer', [Cl.uint(FUND), Cl.principal(SBTC_WHALE), Cl.principal(POX), Cl.none()], '(ok true)', SBTC_WHALE);
s.fixture(R1, FUND, [[A, 1000n * STX], [B, 3000n * STX]]);
s.raw('the repo vault is no longer accepted (u119)', PID, 'pox-claim-rewards', [Cl.list([]), Cl.uint(R1), Cl.principal(`${DEP}.juice-sbtc-autoswap`)], '(err u119)', STRANGER);
s.raw('claim into the fake vault', PID, 'pox-claim-rewards', [Cl.list([]), Cl.uint(R1), Cl.principal(FAKE)], ok, STRANGER);
const fin = (label, want) => s.raw(label, PID, 'finalize-swap', [Cl.principal(FAKE)], want, STRANGER);
s.call('vault sends 10 STX, reports 11', FAKE, 'set-finish', [Cl.uint(10_000_000), Cl.uint(11_000_000)], '(ok true)', STRANGER);
fin('over-report refused (u121)', '(err u121)');
s.call('vault sends 10 STX, reports 9', FAKE, 'set-finish', [Cl.uint(10_000_000), Cl.uint(9_000_000)], '(ok true)', STRANGER);
fin('under-report refused (u121)', '(err u121)');
s.call('vault sends 0, reports 1', FAKE, 'set-finish', [Cl.uint(0), Cl.uint(1)], '(ok true)', STRANGER);
fin('phantom report refused (u121)', '(err u121)');
s.rd('still pending after the refusals', '(get-pending-swap)', (v) => v.startsWith('(some'));
s.call('vault sends 10 STX, reports 10', FAKE, 'set-finish', [Cl.uint(10_000_000), Cl.uint(10_000_000)], '(ok true)', STRANGER);
fin('honest report finalizes', '(ok u10000000)');
s.rd('pot is exactly what arrived', `(get-stx-pot u${R1} u0)`, 'u10000000');

await s.run('juice-vault-mismatch');
