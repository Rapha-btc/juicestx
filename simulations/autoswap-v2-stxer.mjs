// stxer MAINNET-FORK harness for juice-sbtc-autoswap-v2 (contracts/pox-5) on the
// live markets-sbtc-stx-jing-v6-5 + swap-router-sbtc-stx-jing-v6 (Zest venue).
//
// Router v6 is not on mainnet: it is deployed here as DEP from the exact bytes of
// ~/projects/jing-contracts-v3/contracts/sbtc-stx/swap-router-sbtc-stx-jing-v6.clar
// (JING_SRC overrides), before the vault. Zest pool u3 does not exist on mainnet,
// so the router skips Zest (see jing-contracts-v3 verify-router-sbtc-stx-v6-zest-nopool.mjs):
// split sales pass zest u0 + an empty tick list, and one check proves a Zest
// slice > 0 is unsold and fails the total min-out with u3002.
//
// The vault deploys from the EXACT repo bytes and must conform to
// juice-swap-vault-trait-v2: router-swap-split / router-swap-split-dia keep the
// trait-v2 shapes (zest u0 inside) and the live pool switches to it (real
// propose + confirm) and drives it through its real wrappers (pox-claim-rewards
// -> fund, set-vault-max-chunk-sats, router-swap-split, router-swap-split-dia,
// finalize-swap -> finish, pay-stx-stakers). The Zest leg rides on
// router-swap-split-zest / router-swap-split-dia-zest, callable only with
// contract-caller = the pool's get-admin (DEP on mainnet): the admin calls them
// directly; a stranger and the pool itself get u16000.
//
// FIXTURES (disclosed): the earned PoX reward + one staker are seeded in pox-5
// with one Eval (as pool-vault-upgrade-stxer.mjs; the sBTC is a real transfer
// from a real holder). The pool's 4032-block vault-switch notice is aged with
// one Eval in the pool (stxer cannot advance 4032 blocks without breaking
// Lazer freshness; the notice is proven on v1 by pool-vault-upgrade-stxer.mjs),
// and the vault patience clock by 288 blocks with one Eval in the vault.
// Everything else is a plain tx.
//
// Run: node simulations/autoswap-v2-stxer.mjs
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const JING = process.env.JING_SRC ? resolve(process.env.JING_SRC, '..') : resolve(homedir(), 'projects/jing-contracts-v3');
const req = createRequire(resolve(JING, 'package.json'));
const { uintCV, intCV, bufferCV, stringAsciiCV, listCV, noneCV, deserializeCV, cvToString, ClarityVersion, makeUnsignedContractDeploy, PostConditionMode } = req('@stacks/transactions');
const { SimulationBuilder, submitSimulationSteps, getNonce, setSender, getSimulationResult } = req('stxer');
const { c32address } = req('c32check');
const C = await import(resolve(JING, 'simulations/_yg-loop-common.js'));
const { S, NODE, DEP, P_, check, must, show, call, retry, freshUpd, updCV, prints, sbtcBal, stxBal, setGroup, note } = C;

const MK = `${DEP}.markets-sbtc-stx-jing-v6-5`;
const ROUTER_NAME = 'swap-router-sbtc-stx-jing-v6', ROUTER = `${DEP}.${ROUTER_NAME}`;
const VAULT_NAME = 'juice-sbtc-autoswap-v2', V = `${DEP}.${VAULT_NAME}`;
const PL = `${DEP}.juice-pool-sbtc-signer`, V1 = `${DEP}.juice-sbtc-autoswap`;
const ZPOOL = 'SP2NK9P261ZN3ZG2M1DS68PCJCRDFZVFMPYA6ZEST.clmm-pool-v1';
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const DONOR = 'SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2'; // real sBTC holder (reward stand-in)
const POX = 'SP000000000000000000002Q6VF78.pox-5';
const STRANGER = c32address(22, '5742a46e00000000000000000000000000000c6d');
const KEEPER = DEP;
const FUND = 100_000, CHUNK = 50_000;
const IMPL = '(impl-trait .juice-swap-vault-trait-v2.swap-vault-trait)';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sha512_256 = (s) => createHash('sha512-256').update(s).digest('hex');
const routerSrc = readFileSync(resolve(JING, `contracts/sbtc-stx/${ROUTER_NAME}.clar`), 'utf8');
const vaultSrc = readFileSync(resolve(here, `../contracts/pox-5/${VAULT_NAME}.clar`), 'utf8');
if (vaultSrc.split(IMPL).length !== 2) throw new Error('vault impl-trait line not found exactly once');
const hashes = {
  [ROUTER_NAME]: { sha256: sha256(routerSrc), sha512_256: sha512_256(routerSrc) },
  [VAULT_NAME]: { sha256: sha256(vaultSrc), sha512_256: sha512_256(vaultSrc) },
};
const urls = [];

const str = (hex) => cvToString(deserializeCV(hex));
// eval that never throws: returns the cvToString of the value, or EVAL-ERR
async function evalS(cid, code) {
  const out = await retry(() => submitSimulationSteps(S.sid, { steps: [{ TenureExtend: { cause: 'Extended' } }, { Eval: [DEP, '', cid, code] }] }));
  const r = out.steps[1]?.Eval;
  return r && 'Ok' in r ? str(r.Ok) : `EVAL-ERR ${JSON.stringify(r?.Err ?? out.steps[1]).slice(0, 400)}`;
}
async function ev(label, cid, code, want) {
  const v = await evalS(cid, code);
  check(label, typeof want === 'function' ? want(v) : v === want, v);
  return v;
}
// tx returning the cvToString result (or ENGINE-ERR)
async function tx(label, sender, cid, fn, args, want) {
  const r = await call(sender, cid, fn, args);
  const v = r.vm ? `ENGINE-ERR ${show(r.vm)}` : (r.res === null ? 'none' : cvString(r));
  check(label, typeof want === 'function' ? want(v, r) : v === want, v);
  return { ...r, v };
}
const cvString = (r) => { try { return show(r.res); } catch { return String(r.res); } };
const isOk = (v) => v.startsWith('{"ok"');
const isErr = (n) => (v) => v === `{"err":"u${n}"}`;
async function deploy(name, code, version) {
  const raw = await makeUnsignedContractDeploy({ contractName: name, codeBody: code, clarityVersion: version, nonce: await retry(() => getNonce(S.sid, DEP)), network: 'mainnet', publicKey: '', fee: 0, postConditionMode: PostConditionMode.Allow });
  setSender(raw, DEP);
  const out = await retry(() => submitSimulationSteps(S.sid, { steps: [{ Transaction: raw.serialize() }] }));
  const t = out.steps[0]?.Transaction;
  const okRes = t?.Ok && !t.Ok.vm_error && t.Ok.result && str(t.Ok.result).startsWith('(ok');
  return { ok: !!okRes, detail: JSON.stringify(t?.Ok?.vm_error ?? t?.Err ?? t).slice(0, 600) };
}
async function advance(n, secs = 1) {
  const out = await retry(() => submitSimulationSteps(S.sid, { steps: [{ AdvanceBlocks: { bitcoin_blocks: n, stacks_blocks_per_bitcoin: 1, bitcoin_interval_secs: secs } }] }));
  must(`advance ${n} burn block(s)`, !!out.steps[0]?.AdvanceBlocks?.Ok, JSON.stringify(out.steps[0]).slice(0, 300));
}
// vault call from the live pool's context (contract-caller = pool)
const asPool = (fnAndArgs) => `(contract-call? '${V} ${fnAndArgs})`;
const hexUpd = () => '0x' + S.UPD.hex.replace(/^0x/, '');
const routerPrint = (receiptOrEvents) => {
  const evs = (receiptOrEvents ?? []).map((e) => typeof e === 'string' ? JSON.parse(e) : e);
  for (const e of evs) {
    if (e.contract_event?.contract_identifier !== ROUTER) continue;
    const s = str(e.contract_event.raw_value);
    if (s.includes('smart-swap-sbtc-for-stx') || s.includes('"swap-sbtc-for-stx"')) return s;
  }
  return '';
};

try {
  // ---- first step: harmless read (Zest pool count)
  const b = SimulationBuilder.new({ stacksNodeAPI: NODE });
  b.withSender(DEP).addEvalCode(ZPOOL, '(get-pool-count)');
  S.sid = await retry(() => b.run());
  urls.push(`https://stxer.xyz/simulations/mainnet/${S.sid}`);
  console.log(`View: ${urls[0]}`);
  const r0 = await retry(() => getSimulationResult(S.sid));
  const e0 = r0.steps?.[0]?.Result?.Eval;

  setGroup('preconditions');
  check('Zest clmm-pool-v1 get-pool-count = u2 (pool u3 absent)', e0 && 'Ok' in e0 && str(e0.Ok) === 'u2', JSON.stringify(e0));
  await ev('Zest get-pool u3 = none', ZPOOL, '(get-pool u3)', 'none');
  await ev('market v6-5 live and initialized (cycle > 0)', MK, '(get-current-cycle)', (v) => /^u[1-9]\d*$/.test(v));
  await ev(`router ${ROUTER_NAME} not on mainnet`, MK, `(is-err (contract-hash? '${ROUTER}))`, 'true');
  await ev(`${VAULT_NAME} not on mainnet`, MK, `(is-err (contract-hash? '${V}))`, 'true');
  await ev('live pool active vault is v1', PL, '(get-swap-vault)', V1);

  setGroup('deploy');
  let d = await deploy(ROUTER_NAME, routerSrc, ClarityVersion.Clarity5);
  must(`deploy ${ROUTER_NAME} from exact jing-contracts-v3 bytes (Clarity 5)`, d.ok, d.detail);
  await ev('router hash on fork = sha512/256 of repo bytes', MK, `(contract-hash? '${ROUTER})`, `(ok 0x${hashes[ROUTER_NAME].sha512_256})`);
  await ev('router ZEST_POOL_ID = u3', ROUTER, 'ZEST_POOL_ID', 'u3');
  d = await deploy(VAULT_NAME, vaultSrc, ClarityVersion.Clarity6);
  must(`deploy ${VAULT_NAME} from the exact repo bytes (impl-trait juice-swap-vault-trait-v2 accepted)`, d.ok, d.detail);
  await ev('vault hash on fork = sha512/256 of repo bytes', MK, `(contract-hash? '${V})`, `(ok 0x${hashes[VAULT_NAME].sha512_256})`);
  await ev('get-config: market v6-5, router v6, pool = live pool, maker-spread u1', V, '(get-config)',
    (v) => v.includes(`(market ${MK})`) && v.includes(`(router ${ROUTER})`) && v.includes(`(pool ${PL})`) && v.includes('(maker-spread-bps u1)'));

  setGroup('guards');
  await freshUpd(true);
  await tx('stranger cannot fund', STRANGER, V, 'fund', [uintCV(1)], isErr(16000));
  await tx('stranger cannot router-swap-split', STRANGER, V, 'router-swap-split', [uintCV(1), uintCV(0), uintCV(1), uintCV(0), uintCV(0), updCV()], isErr(16000));
  await tx('stranger cannot router-swap-split-dia', STRANGER, V, 'router-swap-split-dia', [uintCV(1), uintCV(1), uintCV(0), uintCV(0)], isErr(16000));
  await tx('pool admin (DEP) cannot call router-swap-split directly (pool only)', DEP, V, 'router-swap-split', [uintCV(1), uintCV(0), uintCV(1), uintCV(0), uintCV(0), updCV()], isErr(16000));
  await tx('reclaim blocked before a batch', STRANGER, V, 'jing-reclaim', [], isErr(16031));
  await tx('router-swap blocked before a batch', STRANGER, V, 'router-swap', [updCV()], isErr(16031));

  setGroup('upgrade: live pool -> v2 (real propose + confirm, notice clock aged)');
  let r = await tx('live pool rejects v2 as vault before the switch (u119)', DEP, PL, 'finalize-swap', [P_(V)], isErr(119));
  await tx('admin propose-swap-vault(v2)', DEP, PL, 'propose-swap-vault', [P_(V)], (v) => v === `{"ok":"${V}"}`);
  // stxer cannot advance 4032 burn blocks without moving block time >= 4032 s,
  // which would put every Lazer update outside the market's staleness window;
  // the 4032-block notice itself is proven on v1 by pool-vault-upgrade-stxer.mjs.
  await tx('confirm before the notice ends is refused (u114)', DEP, PL, 'confirm-swap-vault', [P_(V1), P_(V)], isErr(114));
  await ev('FIXTURE: proposal height aged 4032 blocks (pool notice clock only)', PL, '(begin (var-set pending-swap-vault-height (- burn-block-height u4032)) true)', 'true');
  await tx('admin confirm-swap-vault(v1, v2) after 4032 blocks', DEP, PL, 'confirm-swap-vault', [P_(V1), P_(V)], (v) => v === `{"ok":"${V}"}`);
  await ev('pool active vault is v2', PL, '(get-swap-vault)', V);
  setGroup('fund via the real pool claim (PoX reward fixture)');
  const cycle = BigInt((await evalS(POX, '(current-pox-reward-cycle)')).slice(1)) - 1n;
  r = await call(DONOR, SBTC, 'transfer', [uintCV(FUND), P_(DONOR), P_(POX), noneCV()]);
  must(`real sBTC holder funds PoX with ${FUND} sats (earned-reward stand-in)`, !r.vm && r.res?.ok === true, show(r.res ?? r.vm));
  const key = `{reward-cycle: u${cycle}, bond-index: none, signer: '${PL}}`;
  await ev('FIXTURE: earned PoX reward and one staker (STRANGER)', POX, `(begin
(map-set signer-shares-staked-for-cycle ${key} u1)
(map-set signer-pending-staked-ustx-per-cycle {signer: '${PL}, cycle: u${cycle}} u1)
(map-set signer-rewards-per-token-settled-for-cycle ${key} (get-rewards-per-token-for-cycle u${cycle} none))
(map-set signer-unclaimed-rewards-for-cycle ${key} u${FUND})
(map-set staker-shares-staked-for-cycle {reward-cycle: u${cycle}, bond-index: none, signer: '${PL}, staker: '${STRANGER}} u1)
(var-set last-accounted-rewards-only (+ (var-get last-accounted-rewards-only) u${FUND}))
(try! (contract-call? '${PL} validate-stake! '${STRANGER} u${cycle} u1 u1 u0 false none))
(ok true))`, '(ok true)');
  await tx('public pool.pox-claim-rewards routes the reward into v2 (real fund)', STRANGER, PL, 'pox-claim-rewards', [listCV([]), uintCV(cycle), P_(V)], (v) => isOk(v) && v.includes(`"total-rewards":"u${FUND}"`));
  await ev('v2 batch clock open', V, '(get-clock)', (v) => v.includes('(window-open true)'));
  await ev('vault holds the reward', V, '(sbtc-balance)', `u${FUND}`);
  await freshUpd(true);
  await tx('router-swap forbidden during patience', STRANGER, V, 'router-swap', [updCV()], isErr(16031));
  r = await tx('stranger jing-place(update) on market v6-5', STRANGER, V, 'jing-place', [updCV()], (v) => isOk(v) && v.includes(`"amount":"u${FUND}"`));
  const pend = await evalS(MK, `(get-token-x-pending-deposit '${V})`);
  check('escrow / order carries spread-bps (some u1)', pend === 'none' || pend.includes('(spread-bps (some u1))'), pend);
  if (pend.startsWith('(some')) {
    await freshUpd(true);
    await tx('keeper settle-token-x-deposit(vault)', KEEPER, MK, 'settle-token-x-deposit', [P_(V), updCV(), P_(SBTC), stringAsciiCV('sbtc-token')], (v) => isOk(v));
  }
  const rest = await ev('vault on the market (resting or parked)', MK,
    `{ dep: (get-token-x-deposit (get-current-cycle) '${V}), parked: (get-token-x-parked '${V}), order: (get-token-x-order '${V}) }`, (v) => v.includes('(spread-bps (some u1))'));
  await ev('vault is not empty while its sBTC is on the market', V, '(is-empty)', 'false');
  await tx('cannot close while the reward is on the market', STRANGER, V, 'close-batch', [], (v) => !isOk(v));

  setGroup('liquidation: router v6, zest skipped');
  await ev('FIXTURE: patience clock aged 288 blocks', V, '(begin (var-set batch-start (some (- burn-block-height u288))) (get-clock))', (v) => v.includes('(window-elapsed true)'));
  const back = await tx('reclaim from market v6-5', STRANGER, V, 'jing-reclaim', [], isOk);
  const bal0 = BigInt((await evalS(V, '(sbtc-balance)')).slice(1));
  check('reclaim returned all but at most the fills', bal0 > 0n && bal0 <= BigInt(FUND), `balance u${bal0}; ${back.v}; rest was ${rest}`);
  await tx(`admin pool.set-vault-max-chunk-sats u${CHUNK} (real wrapper)`, DEP, PL, 'set-vault-max-chunk-sats', [uintCV(CHUNK), P_(V)], '{"ok":true}');
  await freshUpd(true);
  r = await tx('router-swap (stranger): one full chunk through router v6', STRANGER, V, 'router-swap', [updCV()],
    (v) => isOk(v) && v.includes(`"amount":"u${Math.min(CHUNK, Number(bal0))}"`) && v.includes('"unsold":"u0"'));
  let rp = routerPrint(r.receipt?.events);
  check('router v6 print: zest-ok false, zest-in u0', rp.includes('(zest-ok false)') && rp.includes('(zest-in u0)'), rp.slice(0, 600));
  await tx('same-burn-block second router-swap rejected (u16044)', STRANGER, V, 'router-swap', [updCV()], isErr(16044));
  await advance(1);
  await freshUpd(true);
  const left = BigInt((await evalS(V, '(sbtc-balance)')).slice(1));
  must('sBTC left for the split sales', left > 4n, `u${left}`);
  const q = left / 4n, q4 = left - 3n * q;
  const zArgs = (amt, jing, zest, ticks, dlmm) => [uintCV(amt), uintCV(jing), uintCV(zest), listCV(ticks.map((t) => intCV(t))), uintCV(dlmm), uintCV(0), uintCV(0), updCV()];
  const zdArgs = (amt, zest, ticks, dlmm) => [uintCV(amt), uintCV(zest), listCV(ticks.map((t) => intCV(t))), uintCV(dlmm), uintCV(0), uintCV(0)];
  setGroup('zest entries: pool admin only');
  await tx('stranger router-swap-split-zest -> u16000', STRANGER, V, 'router-swap-split-zest', zArgs(q, 0, 0, [], q), isErr(16000));
  await tx('stranger router-swap-split-dia-zest -> u16000', STRANGER, V, 'router-swap-split-dia-zest', zdArgs(q, 0, [], q), isErr(16000));
  await ev('the pool contract itself (contract-caller = pool, not admin) -> u16000', PL, `(contract-call? '${V} router-swap-split-zest u${q} u0 u0 (list) u${q} u0 u0 ${hexUpd()})`, '(err u16000)');
  await ev('pool get-admin is DEP', PL, '(get-admin)', DEP);
  await tx('admin split-zest mismatch counts zest -> u16040', DEP, V, 'router-swap-split-zest', zArgs(q, 0, 1, [], q), isErr(16040));
  await tx('admin split-zest with a Zest slice > 0 while pool u3 is missing -> router u3002', DEP, V, 'router-swap-split-zest', zArgs(q, 0, q / 2n, [-1, -2, -3], q - q / 2n), isErr(3002));
  await tx('admin split-dia-zest with a Zest slice > 0 -> router u3002', DEP, V, 'router-swap-split-dia-zest', zdArgs(q, q / 2n, [-1, -2, -3], q - q / 2n), isErr(3002));
  await ev('the failed attempts left the balance untouched', V, '(sbtc-balance)', `u${left}`);
  let sr = await tx(`admin router-swap-split-zest u${q}: zest u0 + empty ticks, dlmm leg`, DEP, V, 'router-swap-split-zest', zArgs(q, 0, 0, [], q),
    (v) => isOk(v) && v.includes('"notification":"router-swap-split-zest"') && v.includes('"zest":"u0"') && v.includes('"unsold":"u0"'));
  rp = routerPrint(sr.receipt?.events);
  check('router v6 swap print: zest-in u0', rp.includes('(zest-in u0)'), rp.slice(0, 500));
  await ev('split-zest sold exactly its amount', V, '(sbtc-balance)', `u${left - q}`);
  await tx('split shares the cooldown: same-block router-swap rejected', STRANGER, V, 'router-swap', [updCV()], isErr(16044));
  setGroup('trait-v2 splits through the live pool wrappers');
  await advance(1);
  await freshUpd(true);
  await tx('stranger cannot use pool.router-swap-split', STRANGER, PL, 'router-swap-split', [uintCV(q), uintCV(0), uintCV(q), uintCV(0), uintCV(0), updCV(), P_(V)], (v) => !isOk(v));
  await tx(`admin pool.router-swap-split u${q} -> v2 (trait-v2 shape, no zest key)`, DEP, PL, 'router-swap-split', [uintCV(q), uintCV(0), uintCV(q), uintCV(0), uintCV(0), updCV(), P_(V)],
    (v) => isOk(v) && v.includes('"notification":"router-swap-split"') && !v.includes('"zest"') && v.includes('"unsold":"u0"'));
  await advance(1);
  await tx(`admin pool.router-swap-split-dia u${q} -> v2`, DEP, PL, 'router-swap-split-dia', [uintCV(q), uintCV(q), uintCV(0), uintCV(0), P_(V)],
    (v) => isOk(v) && v.includes('"notification":"router-swap-split-dia"') && !v.includes('"zest"') && v.includes('"unsold":"u0"'));
  await advance(1);
  await tx(`admin router-swap-split-dia-zest u${q4}: zest u0 + empty ticks`, DEP, V, 'router-swap-split-dia-zest', zdArgs(q4, 0, [], q4),
    (v) => isOk(v) && v.includes('"notification":"router-swap-split-dia-zest"') && v.includes('"zest":"u0"') && v.includes('"unsold":"u0"'));
  await ev('vault drained', V, '(is-empty)', 'true');
  await ev('clock ready to finish', V, '(get-clock)', (v) => v.includes('(batch-start none)') || v.includes('ready'));
  await tx('public pool.finalize-swap(v2): real finish attributes the STX', STRANGER, PL, 'finalize-swap', [P_(V)], (v) => /^\{"ok":"u[1-9]\d*"\}$/.test(v));
  await ev('tranche has a positive STX pot', PL, `(> (get-stx-pot u${cycle} u0) u0)`, 'true');
  const s0 = await stxBal(STRANGER);
  await tx('pay-stx-stakers pays the single staker', STRANGER, PL, 'pay-stx-stakers', [listCV([P_(STRANGER)]), uintCV(cycle), uintCV(0)], isOk);
  const s1 = await stxBal(STRANGER);
  check('staker received native STX', s1 > s0, `before ${s0}, after ${s1}`);
  await ev('vault STX back to the pyth-fee reserve (u0 at fee 0)', V, '(stx-get-balance current-contract)', 'u0');
  await ev('vault clock clear after finish', V, '(get-clock)', (v) => v.includes('(batch-start none)'));
} catch (e) {
  if (!(e instanceof C.Stop)) { console.error(e); S.fails.push(`EXCEPTION ${e.message}`); } else console.log(e.message);
}

C.summary();
const dir = resolve(here, 'results/pool-vault-stx'); mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'autoswap-v2.json'), JSON.stringify({ urls, hashes, passed: S.passed, total: S.checks, fails: S.fails, notes: S.notes, groups: S.groups }, null, 2) + '\n');
process.exit(S.fails.length ? 1 : 0);
