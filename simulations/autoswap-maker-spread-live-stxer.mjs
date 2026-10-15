// stxer MAINNET-FORK proof of the maker-spread fix on the LIVE Juice contracts
// (bounty mv8wal, Cunning Nexus #2; their repro: gist ff32bbf3ca426837cbc75d54bb3ff036,
// https://stxer.xyz/simulations/mainnet/314fe4dff5b4ecb1b7e630019b1900ec).
// Nothing is deployed: the fork is at the tip (>= 9219777, after the juice deploys at
// 9219775-6) and every contract is the live mainnet contract at its real principal:
// juice-pool-sbtc-signer, juice-sbtc-autoswap (maker-spread-bps default u1, max u50),
// markets-sbtc-stx-jing-v6-4, swap-router-sbtc-stx-jing-v5-5, rungs jing-{buy,sell}-stx-*.
//
// Session 1 (live book as found): jing-buy-stx-0 rests sBTC on X pegged at spread
//   (some u0) = the mid. The vault's jing-place rests next to it at mid + 1 bp.
//   Setter auth/bounds through the pool wrapper; direct calls refused; get-config.
//   Then the gist's condition is built with real calls: a real STX holder takes
//   buy-0 out at limit = mid, and puts a Y bid pegged at (some u0) (a bid at the mid).
//   The vault refloor at its var (u1) settles; at u0 the same refloor is refused
//   "crossing". The order keeps (some u1).
// Session 2 (the gist's order of events): the Y at-mid bid rests FIRST. With the
//   var set to u0 the vault's placement is refunded "crossing" (the old bytes'
//   behaviour); with u1 it rests at mid + 1 bp, and a walking STX->sBTC taker
//   fills it there.
//
// FIXTURE (one Eval per session, disclosed): pool.pox-claim-rewards needs a PoX-5
// reward claim, which a fork cannot produce. One Eval in the POOL's own context runs
// its claim tail (as-contract? with-ft sBTC -> vault.fund, var-set pending-swap) on a
// real 20,000-sat transfer from a real sBTC holder to the pool. vault.fund runs its
// real code. Everything else is a plain transaction from a real or fresh sender.
//
// Run: node simulations/autoswap-maker-spread-live-stxer.mjs
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const JING = process.env.JING_SRC ? resolve(process.env.JING_SRC, '..') : resolve(homedir(), 'projects/jing-contracts-v3');
const req = createRequire(resolve(JING, 'package.json'));
const { someCV, uintCV, bufferCV, stringAsciiCV, contractPrincipalCV, standardPrincipalCV, noneCV, falseCV, deserializeCV, cvToString } = req('@stacks/transactions');
const { SimulationBuilder, getSimulationResult, getSimulationTip, submitSimulationSteps, callContract } = req('stxer');
const { c32address } = req('c32check');
const { fetchLazerUpdateAny, lazerFeedTimes } = await import(resolve(JING, 'simulations/_lazer.js'));
const NODE = process.env.STACKS_API_URL ||= 'http://77.42.3.101/stacks-api';

const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const MK = `${DEP}.markets-sbtc-stx-jing-v6-4`;
const CORE = `${DEP}.jing-core-v6`;
const V = `${DEP}.juice-sbtc-autoswap`, PL = `${DEP}.juice-pool-sbtc-signer`;
const B0 = `${DEP}.jing-buy-stx-0`;
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const WSTX = 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2';
const DONOR = 'SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1'; // real sBTC holder (reward stand-in)
const TAKER = 'SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51'; // real STX holder (takes buy-0 out, then rests the Y bid)
const WALKER = c32address(22, '5742a46e00000000000000000000000000000c5e'); // fresh, funded by TAKER (a maker can not also swap: u1018)
const KEEPER = DEP; // settles on mainnet
const ADMIN = DEP; // live pool admin
const STRANGER = c32address(22, '5742a46e00000000000000000000000000000c5d');
const FUND = 20_000;
const LIVE_AFTER = 9219776; // juice-sbtc-autoswap deploy block
// sha512/256 of the on-chain sources, DEPLOYED-VERIFIED.md
const LIVE_HASH = {
  'juice-sbtc-autoswap': 'eb4cd0f7497b62181b1b3527cc4db71ef86e43f32bf8d9466eff56c790ad68d5',
  'juice-pool-sbtc-signer': '9b0cdd5bb6274ca4aeef34834e01cfb18bfa3a6120527dc9fbfb849031b1aebe',
  'juice-swap-vault-trait-v2': 'de229849f1823c5e3006ea0b410e806b6da28792ff47d1e308a648980bc84063',
};
const P = (s) => s.includes('.') ? contractPrincipalCV(...s.split('.')) : standardPrincipalCV(s);
const cv = (hex) => cvToString(deserializeCV(hex));
const U = (v) => BigInt(String(v).match(/u(\d+)/)?.[1] ?? '-1');
const has = (...ss) => (v) => ss.every((s) => v.includes(s));
const lacks = (...ss) => (v) => ss.every((s) => !v.includes(s));
const and = (...fs) => (v) => fs.every((f) => f(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sid, n = 0, passed = 0;
const fails = [], log = [], urls = [];
function check(id, label, actual, want, wantDesc) {
  n++;
  const good = typeof want === 'function' ? !!want(actual) : actual === want;
  if (good) passed++; else fails.push(`${id} ${label}`);
  log.push({ id, label, passed: good, actual: String(actual).slice(0, 2000) });
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${id} ${label}\n         expected: ${wantDesc ?? (typeof want === 'function' ? 'predicate' : want)}\n         actual:   ${String(actual).slice(0, 500)}`);
  return good;
}
const decode = (step) => {
  const r = step?.Result ?? step;
  if (r?.Eval) return 'Ok' in r.Eval ? cv(r.Eval.Ok) : `EVAL-ERR ${JSON.stringify(r.Eval.Err).slice(0, 300)}`;
  if (r?.Transaction?.Ok) { const t = r.Transaction.Ok; if (t.vm_error || t.post_condition_aborted) return `ENGINE-ERR ${JSON.stringify(t).slice(0, 300)}`; return cv(t.result); }
  return `ENGINE-ERR ${JSON.stringify(r).slice(0, 300)}`;
};
async function ev(id, label, cid, code, want, wantDesc) {
  const out = await submitSimulationSteps(sid, { steps: [{ Eval: [DEP, '', cid, code] }] });
  const v = decode(out.steps[0]);
  if (want !== undefined) check(id, label, v, want, wantDesc);
  return v;
}
function prints(r, from = CORE) {
  const evs = (r.receipt?.events ?? []).map((e) => typeof e === 'string' ? JSON.parse(e) : e);
  return evs.filter((e) => e.contract_event?.contract_identifier === from).map((e) => cv(e.contract_event.raw_value)).join(' | ');
}
async function tx(id, label, sender, contract, fn, args, want, wantDesc) {
  const r = await callContract(sid, { sender, contract, functionName: fn, functionArgs: args, fee: 0 });
  const v = r.vmError || r.pcAborted ? `ENGINE-ERR ${JSON.stringify({ vm: r.vmError, pc: r.pcAborted }).slice(0, 300)}` : r.result;
  check(id, label, v, want, wantDesc);
  return r;
}
async function freshUpdate(notBefore, label) {
  for (let i = 0; i < 400; i++) {
    const now = Date.now() / 1000;
    if (now < notBefore + 2) { await sleep(Math.min(15_000, (notBefore + 3 - now) * 1000)); continue; }
    const u = await fetchLazerUpdateAny();
    const at = (await lazerFeedTimes(u.hex)).at;
    if (at > notBefore) {
      const mid = (u.px * 100_000_000n) / u.py;
      console.log(`lazer ${label}: feeds at ${at} (fork clock ${notBefore}), mid ${mid}`);
      return { cv: bufferCV(Buffer.from(u.hex.replace(/^0x/, ''), 'hex')), at, mid };
    }
    await sleep(2000);
  }
  throw new Error('no Lazer update newer than the fork clock');
}
const cyc = '(get-current-cycle)';
const xdep = (p) => `(get-token-x-deposit ${cyc} '${p})`;
const ydep = (p) => `(get-token-y-deposit ${cyc} '${p})`;
const onX = (p) => `(is-some (index-of? (get-token-x-depositors ${cyc}) '${p}))`;
const claimTail = `(begin
  (unwrap-panic (as-contract? ((with-ft '${SBTC} "sbtc-token" u${FUND}))
    (unwrap-panic (contract-call? '${V} fund u${FUND}))))
  (var-set pending-swap (some { reward-cycle: u0, tranche: u0 }))
  (contract-call? '${V} get-clock))`;
const vaultState = `{ dep: (contract-call? '${MK} get-token-x-deposit (contract-call? '${MK} get-current-cycle) '${V}), pend: (contract-call? '${MK} get-token-x-pending-deposit '${V}), sbtc: (unwrap-panic (contract-call? '${SBTC} get-balance '${V})), clock: (contract-call? '${V} get-clock) }`;
const settleX = (id, label, upd, want, wantDesc) => tx(id, label, KEEPER, MK, 'settle-token-x-deposit', [P(V), upd.cv, P(SBTC), stringAsciiCV('sbtc-token')], want, wantDesc);
const setSpread = (id, label, sender, bps, want) => tx(id, label, sender, PL, 'set-vault-maker-spread-bps', [uintCV(bps), P(V)], want);
const swapStx = (id, label, ustx, limit, upd, want = has('(ok'), who = TAKER) => tx(id, label, who, MK, 'swap',
  [uintCV(ustx), uintCV(limit), upd.cv, P(SBTC), stringAsciiCV('sbtc-token'), P(WSTX), stringAsciiCV('wstx'), falseCV()], want);

// live source hashes (sha512/256 = contract-hash?) at the node tip
async function liveSourceHashes() {
  const out = {};
  for (const [name, want] of Object.entries(LIVE_HASH)) {
    const r = await fetch(`${NODE}/v2/contracts/source/${DEP}/${name}?proof=0`, { signal: AbortSignal.timeout(20000) });
    const src = (await r.json()).source;
    out[name] = createHash('sha512-256').update(src).digest('hex');
    check(`H-${name}`, `live ${name} source hash = DEPLOYED-VERIFIED`, out[name], want);
  }
  return out;
}

async function openSession(tag) {
  let b = SimulationBuilder.new({ stacksNodeAPI: NODE });
  const plan = [];
  const add = (id, label, f, want) => { b = f(b); plan.push({ id, label, want }); };
  add(`${tag}-S1b`, 'real STX holder funds a fresh walker with 50 STX', (bb) => bb.withSender(TAKER).addSTXTransfer({ recipient: WALKER, amount: 50_000_000 }), (v) => !v.startsWith('ENGINE'));
  add(`${tag}-S1`, 'real sBTC holder sends the 20,000-sat reward stand-in to the live pool',
    (bb) => bb.withSender(DONOR).addContractCall({ contract_id: SBTC, function_name: 'transfer', function_args: [uintCV(FUND), P(DONOR), P(PL), noneCV()] }), '(ok true)');
  sid = await b.run();
  const url = `https://stxer.xyz/simulations/mainnet/${sid}`;
  urls.push(url);
  console.log(`\n=== session ${tag}: ${url}`);
  const setup = (await getSimulationResult(sid)).steps.filter((s) => s.Result?.Transaction || s.Result?.Eval);
  plan.forEach((s, i) => check(s.id, s.label, decode(setup[i]), s.want));
  const tip = await getSimulationTip(sid);
  check(`${tag}-S0`, `fork is after the live juice deploys (> ${LIVE_AFTER})`, String(tip.stacks_height), (v) => Number(v) > LIVE_AFTER, `> ${LIVE_AFTER}`);
  console.log(`fork: stacks ${tip.stacks_height} burn ${tip.burn_height} time ${tip.block_time}`);
  await ev(`${tag}-S2`, 'live vault is idle and empty before the fixture', V, '(get-upgrade-status)', has('(empty true)', '(batch-start none)', '(sbtc-balance u0)'));
  await ev(`${tag}-S3`, 'live pool is the vault\'s pool, vault is the pool\'s active vault', PL, '(get-swap-vault)', V);
  await ev(`${tag}-S4`, 'FIXTURE: pool claim tail -> live vault.fund u20000 (opens the batch clock)', PL, claimTail, has('(window-open true)', '(window-elapsed false)'));
  const u = await freshUpdate(Number(tip.block_time), `${tag} update`);
  await ev(`${tag}-S5`, 'fork clock is before the signed update', MK, `(< stacks-block-time u${u.at})`, 'true');
  return u;
}

// helper: the gist's condition, built with real calls (buy-0 taken out, then a Y bid at the mid)
async function buildAtMidBid(tag, u, limitBps) {
  const mid = u.mid;
  const b0 = U(await ev(`${tag}-G1`, 'live: jing-buy-stx-0 sBTC resting on X', MK, xdep(B0), (v) => U(v) > 0n, 'u > 0'));
  // swap must fill in full (ERR_PARTIAL_FILL u1017), so it takes all of buy-0 at the mid
  // and the rest from the next ask at or below mid + limitBps (session A: the vault at
  // mid + 1 bp; session B: buy-10 at mid + 10 bp). 1.5x buy-0 stays inside that depth.
  const take = (b0 * mid) / 10_000_000_000n * 150n / 100n;
  const limit = (mid * (10000n + BigInt(limitBps))) / 10000n;
  const r = await swapStx(`${tag}-G2`, `real STX holder swaps ${take} uSTX for sBTC, limit mid + ${limitBps} bp`, take, limit, u);
  const matches = prints(r).split(' | ').filter((e) => e.includes('"match"'));
  console.log(`         matches: ${matches.map((e) => e.slice(0, 260)).join('\n                  ')}`);
  // buy-0 is a spread-0 peg, so it clears in the batch the swap settles at the mid
  // (the walk then fills pegs with a spread, e.g. the vault at mid + 1 bp)
  const all = prints(r).split(' | ');
  check(`${tag}-G2b`, 'buy-0 filled in the batch the swap settled at clearing = mid', all.filter((e) => e.includes('"settlement"') || (e.includes('"distribute-x-depositor"') && e.includes(B0))).join(' | '),
    and(has(`(clearing-price u${mid})`), (v) => v.includes(B0)), `settlement clearing-price u${mid} + distribute-x-depositor ${B0}`);
  await ev(`${tag}-G3`, 'buy-0 has nothing left on X', MK, xdep(B0), 'u0');
  await ev(`${tag}-G4`, 'no live ask at or below the mid remains (would-take-as-y(mid, mid))', MK, `(would-take-as-y u${mid} u${mid})`, 'false');
  const bid = 50_000_000n;
  await tx(`${tag}-G5`, 'real STX holder deposits a Y bid pegged at spread (some u0), cap mid + 5%', TAKER, MK, 'deposit-token-y',
    [uintCV(bid), uintCV((mid * 105n) / 100n), someCV(uintCV(0)), P(WSTX), stringAsciiCV('wstx')], `(ok u${bid})`);
  const pend = await ev(`${tag}-G6`, 'Y bid escrow (pending while X has makers)', MK, `(get-token-y-pending-deposit '${TAKER})`, (v) => v === 'none' || v.startsWith('(some'), 'none | (some ...)');
  if (pend.startsWith('(some')) {
    const r = await tx(`${tag}-G7`, 'keeper settle-token-y-deposit(taker bid)', KEEPER, MK, 'settle-token-y-deposit', [P(TAKER), u.cv, P(WSTX), stringAsciiCV('wstx')], `(ok u${bid})`);
    check(`${tag}-G8`, 'the at-mid bid rests: deposit-y, no refund', prints(r), and(has('"deposit-y"'), lacks('pending-refund')), 'deposit-y, no pending-refund-y');
  }
  await ev(`${tag}-G9`, 'gist condition: a Y bid at the mid rests (token-y-limit-at = mid)', MK, `(token-y-limit-at '${TAKER} u${mid})`, `u${mid}`);
  await ev(`${tag}-G10`, 'gate: an ask AT the mid would take (crossing)', MK, `(would-take-as-x u${mid} u${mid})`, 'true');
  await ev(`${tag}-G11`, 'gate: an ask at mid + 1 bp would not', MK, `(would-take-as-x u${mid} u${(mid * 10001n) / 10000n})`, 'false');
  return matches;
}

console.log(`principals: STRANGER=${STRANGER} KEEPER=${KEEPER} DONOR=${DONOR} TAKER=${TAKER}`);
const hashes = await liveSourceHashes();

// ================= Session 1: the live book as found =================
{
  const u = await openSession('A');
  const mid = u.mid, ask = (mid * 10001n) / 10000n;
  await ev('A1', 'get-config: maker-spread-bps u1 (default), market v6-4, router v5-5', V, '(get-config)',
    has('(maker-spread-bps u1)', `(market ${MK})`, `(router ${DEP}.swap-router-sbtc-stx-jing-v5-5)`));
  await ev('A2', 'live: jing-buy-stx-0 X order is a peg at spread (some u0)', MK, `(get-token-x-order '${B0})`, has('(spread-bps (some u0))'));
  await ev('A3', 'live: jing-buy-stx-0 ask at the mid = the mid', MK, `(token-x-limit-at '${B0} u${mid})`, `u${mid}`);
  await ev('A4', 'live: buy-0 rests sBTC', MK, xdep(B0), (v) => U(v) > 0n, 'u > 0');
  const wty0 = await ev('A5', 'baseline would-take-as-y(mid, mid) with buy-0 at the mid', MK, `(would-take-as-y u${mid} u${mid})`, 'true');
  // direct setter calls refused (only the POOL contract may call)
  await tx('A6', 'stranger calls vault.set-maker-spread-bps directly', STRANGER, V, 'set-maker-spread-bps', [uintCV(5)], '(err u16000)');
  await tx('A7', 'pool admin (DEP) calls vault.set-maker-spread-bps directly, not through the pool', ADMIN, V, 'set-maker-spread-bps', [uintCV(5)], '(err u16000)');
  await setSpread('A8', 'stranger calls pool.set-vault-maker-spread-bps', STRANGER, 5, '(err u100)');
  await setSpread('A9', 'admin sets u51 (> MAX u50)', ADMIN, 51, '(err u16033)');
  await ev('A10', 'unchanged after the refusals: u1', V, '(get maker-spread-bps (get-config))', 'u1');
  await setSpread('A11', 'admin sets u50 (= MAX)', ADMIN, 50, '(ok true)');
  await ev('A12', 'get-config shows u50', V, '(get maker-spread-bps (get-config))', 'u50');
  await setSpread('A13', 'admin sets u0', ADMIN, 0, '(ok true)');
  await ev('A14', 'get-config shows u0', V, '(get maker-spread-bps (get-config))', 'u0');
  await setSpread('A15', 'admin restores u1', ADMIN, 1, '(ok true)');
  await ev('A16', 'get-config shows u1', V, '(get maker-spread-bps (get-config))', 'u1');
  // placement next to the live spread-0 order
  await tx('A17', 'stranger jing-place(update) on the live vault', STRANGER, V, 'jing-place', [u.cv], has('(ok', `(amount u${FUND})`));
  const pendA = await ev('A18', 'escrow carries spread-bps (some u1) from the var', MK, `(get-token-x-pending-deposit '${V})`, has('(spread-bps (some u1))', `(amount u${FUND})`));
  if (pendA.startsWith('(some')) {
    const r = await settleX('A19', 'keeper settle-token-x-deposit(vault, update)', u, `(ok u${FUND})`);
    check('A20', 'placed: deposit-x event, no pending-refund-x, no "crossing"', prints(r), and(has('"deposit-x"'), lacks('pending-refund', 'crossing')), 'deposit-x, no refund');
  }
  await ev('A21', 'vault rests on X with (some u1), all 20,000 sats', MK, `{ dep: ${xdep(V)}, on: ${onX(V)}, order: (get-token-x-order '${V}) }`, has(`(dep u${FUND})`, '(on true)', '(spread-bps (some u1))'));
  await ev('A22', 'vault ask at the mid = mid + 1 bp', MK, `(token-x-limit-at '${V} u${mid})`, `u${ask}`);
  await ev('A23', 'buy-0 still rests at the mid beside it', MK, `{ dep: ${xdep(B0)}, px: (token-x-limit-at '${B0} u${mid}) }`, and(has(`(px u${mid})`), (v) => !v.includes('(dep u0)')));
  await ev('A24', 'would-take-as-y(mid, mid) unchanged with the vault resting', MK, `(would-take-as-y u${mid} u${mid})`, wty0);
  await ev('A25', 'vault status: resting, window open', V, vaultState, has(`(dep u${FUND})`, '(sbtc u0)', '(window-open true)'));
  // build the gist's condition around the resting vault, then refloor
  const gm = await buildAtMidBid('A', u, 1);
  check('A26', 'the same walk then filled the resting vault at mid + 1 bp', gm.find((e) => e.includes(V)) ?? '', has(`(price u${ask})`), `match with ${V} at u${ask}`);
  const restA = U(await ev('A26b', 'vault keeps the unfilled rest on X at mid + 1 bp after the walk and the at-mid bid', MK, `{ dep: ${xdep(V)}, px: (token-x-limit-at '${V} u${mid}) }`, (v) => has(`(px u${ask})`)(v) && U(v) > 0n && U(v) < BigInt(FUND), `0 < dep < ${FUND}, px u${ask}`));
  await tx('A27', 'stranger cannot refloor the vault directly', STRANGER, V, 'jing-refloor', [u.cv], '(err u16000)');
  await tx('A28', 'admin pool.refloor-vault (var u1) -> pending', ADMIN, PL, 'refloor-vault', [u.cv, P(V)], (v) => /^\(ok u\d+\)$/.test(v), '(ok floor)');
  await ev('A29', 'pending limit carries (some u1)', MK, `(get-token-x-pending-limit '${V})`, has('(spread-bps (some u1))'));
  let r = await tx('A30', 'keeper settle-token-x-limit(vault) at u1 next to the at-mid bid', KEEPER, MK, 'settle-token-x-limit', [P(V), u.cv], '(ok true)');
  check('A31', 'u1 refloor not refused', prints(r), lacks('crossing', 'refused'), 'no crossing / refused event');
  await setSpread('A32', 'admin sets u0 (the old peg)', ADMIN, 0, '(ok true)');
  await tx('A33', 'admin pool.refloor-vault at u0 -> pending', ADMIN, PL, 'refloor-vault', [u.cv, P(V)], (v) => /^\(ok u\d+\)$/.test(v), '(ok floor)');
  await ev('A34', 'refloor uses the var: pending limit carries (some u0)', MK, `(get-token-x-pending-limit '${V})`, has('(spread-bps (some u0))'));
  r = await tx('A35', 'keeper settle-token-x-limit at u0', KEEPER, MK, 'settle-token-x-limit', [P(V), u.cv], '(ok false)');
  check('A36', 'u0 refloor refused "crossing" (the condition is live)', prints(r), has('(reason "crossing")'), 'reason "crossing"');
  await ev('A37', 'order unchanged at (some u1), the rest still resting', MK, `{ dep: ${xdep(V)}, order: (get-token-x-order '${V}) }`, has(`(dep u${restA})`, '(spread-bps (some u1))'));
  await setSpread('A38', 'admin restores u1', ADMIN, 1, '(ok true)');
}

// ================= Session 2: the gist's order (at-mid bid first) =================
{
  const u = await openSession('B');
  const mid = u.mid, ask = (mid * 10001n) / 10000n;
  await buildAtMidBid('B', u, 10);
  // control: the var at u0 reproduces the old bytes' refusal on the live vault
  await setSpread('B1', 'admin sets u0', ADMIN, 0, '(ok true)');
  await tx('B2', 'stranger jing-place at u0', STRANGER, V, 'jing-place', [u.cv], has('(ok', `(amount u${FUND})`));
  await ev('B3', 'escrow carries (some u0)', MK, `(get-token-x-pending-deposit '${V})`, has('(spread-bps (some u0))'));
  let r = await settleX('B4', 'keeper settles the u0 placement', u, `(ok u${FUND})`);
  check('B5', 'u0: refunded "crossing" (Cunning Nexus #2 on the old peg)', prints(r), has('"pending-refund-x"', '(reason "crossing")'), 'pending-refund-x, reason "crossing"');
  await ev('B6', 'u0: nothing on the market, 20,000 back in the vault, window open', V, vaultState, has('(dep u0)', '(pend none)', `(sbtc u${FUND})`, '(window-open true)'));
  // the fix: default u1 rests
  await setSpread('B7', 'admin restores u1', ADMIN, 1, '(ok true)');
  await tx('B8', 'stranger jing-place at u1', STRANGER, V, 'jing-place', [u.cv], has('(ok', `(amount u${FUND})`));
  await ev('B9', 'escrow carries (some u1)', MK, `(get-token-x-pending-deposit '${V})`, has('(spread-bps (some u1))'));
  r = await settleX('B10', 'keeper settles the u1 placement', u, `(ok u${FUND})`);
  check('B11', 'u1: deposit-x, NOT refunded "crossing"', prints(r), and(has('"deposit-x"'), lacks('pending-refund', 'crossing')), 'deposit-x, no refund');
  await ev('B12', 'vault rests 20,000 on X at (some u1)', MK, `{ dep: ${xdep(V)}, on: ${onX(V)}, order: (get-token-x-order '${V}) }`, has(`(dep u${FUND})`, '(on true)', '(spread-bps (some u1))'));
  await ev('B13', 'vault ask = mid + 1 bp', MK, `(token-x-limit-at '${V} u${mid})`, `u${ask}`);
  await ev('B14', 'the at-mid bid still rests beside it', MK, `(token-y-limit-at '${TAKER} u${mid})`, `u${mid}`);
  await ev('B15', 'vault does not block the bid side: would-take-as-y(mid, mid) false', MK, `(would-take-as-y u${mid} u${mid})`, 'false');
  // a walking STX->sBTC taker fills the vault at mid + 1 bp
  const stx0 = U(await ev('B16', 'vault STX before', V, '(stx-get-balance current-contract)', (v) => /^u\d+$/.test(v), 'uint'));
  r = await swapStx('B17', 'walker swaps 10 STX for sBTC, limit mid + 1%', 10_000_000n, (mid * 10100n) / 10000n, u, has('(ok'), WALKER);
  const m = prints(r).split(' | ').find((e) => e.includes('"match"') && e.includes(V));
  check('B18', 'the walk matched the vault at mid + 1 bp', m ?? '', has(`(price u${ask})`), `match with ${V} at u${ask}`);
  await ev('B19', 'vault received STX from the fill', V, '(stx-get-balance current-contract)', (v) => U(v) > stx0, `> u${stx0}`);
  await ev('B20', 'vault sBTC still resting is below 20,000', MK, xdep(V), (v) => /^u\d+$/.test(v) && U(v) < BigInt(FUND), `< ${FUND}`);
}

console.log(`\n${passed}/${n} checks passed${fails.length ? `; FAILED: ${fails.join('; ')}` : ''}`);
console.log(`RESULT: ${fails.length ? 'FAIL' : 'PASS'}`);
for (const u of urls) console.log(u);
const dir = resolve(here, 'results/pool-vault-stx'); mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'autoswap-maker-spread-live.json'), JSON.stringify({ urls, liveSourceHashes: hashes, passed, total: n, fails, checks: log }, null, 2));
process.exit(fails.length ? 1 : 0);
