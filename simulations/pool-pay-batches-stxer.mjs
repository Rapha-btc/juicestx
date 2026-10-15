// pay-stx-stakers batch accounting on a mainnet fork, side by side.
// NEW = e425a4c pool (or NEW_REV), OLD = e8ad9b1 pool, both read via git show.
//
// Bounty mv7dfb Rare Io I1 (e425a4c) moved the tranche-paid and
// tranche-paid-shares writes out of pay-one: the fold now sums owed and shares
// and pay-stx-stakers writes each map once per batch. This sim deploys the repo
// pool (NEW) and the e8ad9b1 pool (OLD, the last source with per-staker writes)
// under two names, gives both the same fixture state and runs the same calls
// on both. After every batch it checks each pool against a JS model and checks
// that NEW and OLD read the same values.
//
// Cases: split staker lists over several batches for one tranche, a staker
// twice in one batch and again in later batches (paid once), zero-share
// stakers, a batch that pays nobody, OG fully covered / partly covered /
// cover above shares / taxed stakers, rounding dust, sweep refused while
// unpaid (u104), sweep after the last batch, second sweep (u105), earned-fees,
// and pool + staker STX balance deltas against the transfers.
//
// Fixtures (Eval): pox-5 cycle shares for both pool signers; per pool the
// finalized flag, the STX pot, the tranche count and the OG cover map. The
// pots are real STX sent from a whale. No Jing / vault / claim path: the
// accounting sim (pool-accounting-stxer.mjs) covers that path on the new source.
//
// Run: node simulations/pool-pay-batches-stxer.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { juiceForkBlock, traitSource, JUICE_LIVE, verifyLiveJuice } from './_juice-fork.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(directory, '../package.json'));
const { SimulationBuilder, getSimulationResult } = require('stxer');
const { Cl, ClarityVersion, deserializeCV, cvToString, getAddressFromPrivateKey } = require('@stacks/transactions');

const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const STRANGER = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const STX_WHALE = 'SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51';
const POX = 'SP000000000000000000002Q6VF78.pox-5';
const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const API = process.env.STXER_API_URL || 'https://api.stxer.xyz';
const OLD_REV = 'e8ad9b1';
const REPO_PATH = 'contracts/pox-5/juice-pool-sbtc-signer.clar';
const sha = (s) => createHash('sha256').update(s).digest('hex');

// Both sources come from git so the sim pins exact commits (NEW_REV overrides).
const NEW_REV = process.env.NEW_REV || 'e425a4c';
const gitShow = (rev) => execFileSync('git', ['show', `${rev}:${REPO_PATH}`], { cwd: resolve(directory, '..'), encoding: 'utf8' });
// NEW_SOURCE_FILE=<path> deploys that file as NEW instead (e.g. the exact deploy bytes).
const NEW_FILE = process.env.NEW_SOURCE_FILE ? resolve(process.env.NEW_SOURCE_FILE) : null;
const newSource = NEW_FILE ? readFileSync(NEW_FILE, 'utf8') : gitShow(NEW_REV), oldSource = gitShow(OLD_REV);
if (newSource === oldSource) throw new Error('NEW and OLD sources are identical');
const POOLS = { NEW: `${DEP}.juice-pool-sbtc-signer`, OLD: `${DEP}.juice-pool-sbtc-signer-${OLD_REV}` };

const STX = 1_000_000n, FEE = 450n, MAXB = 10000n;
const acct = (d) => getAddressFromPrivateKey(d.repeat(64) + '01', 'mainnet');
// name: [shares, OG cover]
const STAKERS = {
  S1: [1000n * STX, 1000n * STX], // OG fully covered: no fee
  S2: [1000n * STX, 300n * STX], // OG partly covered
  S3: [500n * STX, 0n], // taxed
  S4: [0n, 0n], // listed, zero shares
  S5: [7n, 0n], // rounding dust
  S6: [123_456_789n, 0n], // taxed, odd amount
  S7: [2000n * STX, 0n], // taxed, largest
  S8: [50n * STX, 5000n * STX], // cover above shares: no fee
};
const W = Object.fromEntries(Object.keys(STAKERS).map((k, i) => [k, acct(String(i + 1))]));
const TOTAL = Object.values(STAKERS).reduce((t, [n]) => t + n, 0n);
const POT = [800n * STX + 3n, 150n * STX + 11n];

const forkBlock = await juiceForkBlock(NODE);
const cycleNow = Number(deserializeCV((await (await fetch(`${NODE}/v2/contracts/call-read/${POX.split('.')[0]}/pox-5/current-pox-reward-cycle`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sender: DEP, arguments: [] }),
})).json()).result).value);
const R = cycleNow - 1;

const builder = SimulationBuilder.new({ stacksNodeAPI: NODE, apiEndpoint: API, skipTracing: !process.env.STXER_TRACE })
  .useBlockHeight(forkBlock).withSender(DEP);
const plan = [];
const push = (p) => { plan.push(p); return plan.length - 1; };
const call = (label, id, fn, args, want, sender = STRANGER) => {
  builder.withSender(sender).addContractCall({ contract_id: id, function_name: fn, function_args: args });
  builder.withSender(DEP);
  return push({ label, kind: 'tx', want });
};
const ev = (label, id, code, want = () => true) => { builder.addEvalCode(id, code); return push({ label, kind: 'eval', want }); };
const ok = (v) => v.startsWith('(ok');

// -- deploy ---------------------------------------------------------------------
const sourceHashes = {};
// Live: trait + NEW pool are the mainnet contracts (NEW = the live pool bytes,
// whatever NEW_REV says); only OLD deploys, under its suffixed name.
if (JUICE_LIVE) await verifyLiveJuice(NODE, sourceHashes);
else {
const trait = traitSource(sourceHashes);
builder.addContractDeploy({ contract_name: trait.name, source_code: trait.source, clarity_version: ClarityVersion.Clarity6 });
push({ label: `deploy ${trait.name}`, kind: 'deploy' });
}
for (const [tag, src] of [['NEW', newSource], ['OLD', oldSource]]) {
  if (JUICE_LIVE && tag === 'NEW') continue;
  const name = POOLS[tag].split('.')[1];
  sourceHashes[name] = sha(src);
  builder.addContractDeploy({ contract_name: name, source_code: src, clarity_version: ClarityVersion.Clarity6 });
  push({ label: `deploy ${tag} ${name} (${tag === 'NEW' ? (NEW_FILE ?? NEW_REV) : OLD_REV} file)`, kind: 'deploy' });
}

// -- fixtures (identical for both pools) ----------------------------------------
for (const tag of ['NEW', 'OLD']) {
  const P = POOLS[tag];
  const key = `{ reward-cycle: u${R}, bond-index: none, signer: '${P} }`;
  const sets = Object.entries(STAKERS).filter(([, [n]]) => n > 0n)
    .map(([k, [n]]) => `(map-set staker-shares-staked-for-cycle { reward-cycle: u${R}, bond-index: none, signer: '${P}, staker: '${W[k]} } u${n})`).join(' ');
  ev(`fixture ${tag}: pox-5 cycle ${R} shares, total ${TOTAL}`, POX,
    `(begin (map-set signer-shares-staked-for-cycle ${key} u${TOTAL}) ${sets} true)`, 'true');
  const og = Object.entries(STAKERS).filter(([, [, c]]) => c > 0n).map(([k, [, c]]) => `(map-set og-stakers '${W[k]} u${c})`).join(' ');
  ev(`fixture ${tag}: tranches 0/1 finalized with pots ${POT.join('/')}, OG covers`, P, `(begin
    (map-set finalized-tranches { reward-cycle: u${R}, tranche: u0 } true)
    (map-set finalized-tranches { reward-cycle: u${R}, tranche: u1 } true)
    (map-set stx-pot { reward-cycle: u${R}, tranche: u0 } u${POT[0]})
    (map-set stx-pot { reward-cycle: u${R}, tranche: u1 } u${POT[1]})
    (map-set tranche-count u${R} u2)
    ${og} true)`, 'true');
  builder.withSender(STX_WHALE).addSTXTransfer({ recipient: P, amount: Number(POT[0] + POT[1]) });
  builder.withSender(DEP);
  push({ label: `fund ${tag} pool ${POT[0] + POT[1]} uSTX`, kind: 'transfer' });
  ev(`${tag} cycle total shares`, P, `(get-cycle-total-shares u${R})`, `u${TOTAL}`);
  ev(`${tag} fee is 4.5%`, P, '(get-fee-bips)', `u${FEE}`);
}

// -- JS model -------------------------------------------------------------------
const model = { paid: {}, paidShares: [0n, 0n], gross: [0n, 0n], fees: 0n, out: 0n, swept: [0n, 0n] };
const owedOf = (t, k) => POT[t] * STAKERS[k][0] / TOTAL;
const feeOf = (t, k) => {
  const [n, c] = STAKERS[k], taxed = n > c ? n - c : 0n;
  return taxed === 0n ? 0n : (owedOf(t, k) * FEE * taxed) / (MAXB * n);
};
const netOf = (t, k) => owedOf(t, k) - feeOf(t, k);
const snapshotCode = (t) => `{ paid: (get-tranche-paid u${R} u${t}), paid-shares: (get-tranche-paid-shares u${R} u${t}),
  residue: (get-tranche-residue u${R} u${t}), fully-paid: (is-tranche-fully-paid u${R} u${t}),
  earned-fees: (get-earned-fees), balance: (stx-get-balance current-contract) }`;
const rawCode = (t) => `{ paid: (map-get? tranche-paid { reward-cycle: u${R}, tranche: u${t} }), shares: (map-get? tranche-paid-shares { reward-cycle: u${R}, tranche: u${t} }) }`;
const balancesCode = `(list ${Object.values(W).map((w) => `(stx-get-balance '${w})`).join(' ')})`;

const batches = []; // { label, t, list, expectPay, expect, idx: {NEW:{pay,snap,raw,balBefore,balAfter}, OLD:{...}} }
const expectedSnap = (t) => {
  const paid = model.gross[t] + model.swept[t];
  return { paid, paidShares: model.paidShares[t], residue: POT[t] - paid, full: model.paidShares[t] >= TOTAL, fees: model.fees,
    balance: POT[0] + POT[1] - model.out };
};
const batch = (label, t, list) => {
  // model first, then both pools run the same list
  let pay = 0n;
  for (const k of list) {
    const pk = `${t}:${k}`;
    if (model.paid[pk] !== undefined || STAKERS[k][0] === 0n) continue;
    const net = netOf(t, k);
    model.paid[pk] = net; pay += net;
    model.gross[t] += owedOf(t, k); model.paidShares[t] += STAKERS[k][0]; model.fees += feeOf(t, k); model.out += net;
  }
  const b = { label, t, list, pay, expect: expectedSnap(t), idx: {} };
  for (const tag of ['NEW', 'OLD']) {
    const P = POOLS[tag];
    const balBefore = ev(`${tag} ${label}: staker balances before`, P, balancesCode);
    const payIdx = call(`${tag} ${label}: pay-stx-stakers t${t} [${list.join(',')}]`, P, 'pay-stx-stakers',
      [Cl.list(list.map((k) => Cl.principal(W[k]))), Cl.uint(R), Cl.uint(t)], `(ok u${pay})`);
    const balAfter = ev(`${tag} ${label}: staker balances after`, P, balancesCode);
    const snap = ev(`${tag} ${label}: tranche ${t} snapshot`, P, snapshotCode(t));
    const raw = ev(`${tag} ${label}: raw tranche ${t} map entries`, P, rawCode(t));
    b.idx[tag] = { pay: payIdx, balBefore, balAfter, snap, raw };
  }
  batches.push(b);
};
const sweep = (label, t, want) => {
  const idx = {};
  for (const tag of ['NEW', 'OLD']) {
    idx[tag] = call(`${tag} ${label}`, POOLS[tag], 'sweep-tranche-dust', [Cl.uint(R), Cl.uint(t)], typeof want === 'function' ? want : want, DEP);
  }
  return idx;
};

// -- tranche 0: four batches over split lists -----------------------------------
batch('B1 S2 twice + zero-share S4', 0, ['S1', 'S2', 'S2', 'S4']);
batch('B2 S1/S2 again + S3 twice + dust S5', 0, ['S2', 'S3', 'S1', 'S5', 'S3']);
batch('B3 nobody owed (S4 zero, S1 paid)', 0, ['S4', 'S1']);
const early = sweep('sweep t0 while S6/S7/S8 unpaid refused (u104)', 0, '(err u104)');
batch('B4 last: S6, S7, S8 (cover above shares)', 0, ['S6', 'S7', 'S8']);
const residue0 = POT[0] - model.gross[0];
model.swept[0] = residue0; model.out += residue0;
const sweep0 = sweep('sweep t0 after the last batch', 0, `(ok u${residue0})`);
const after0 = {};
for (const tag of ['NEW', 'OLD']) after0[tag] = ev(`${tag} t0 after sweep`, POOLS[tag], snapshotCode(0));
const expAfter0 = expectedSnap(0);
sweep('second t0 sweep refused (u105)', 0, '(err u105)');

// -- tranche 1: a fresh tranche whose first batch pays nobody, then one batch ---
batch('B5 fresh tranche, zero-share only', 1, ['S4']);
batch('B6 everyone, S1/S2 listed twice', 1, ['S8', 'S7', 'S6', 'S5', 'S4', 'S3', 'S2', 'S1', 'S1', 'S2']);
const residue1 = POT[1] - model.gross[1];
model.swept[1] = residue1; model.out += residue1;
const sweep1 = sweep('sweep t1 after its single batch', 1, `(ok u${residue1})`);
const after1 = {};
for (const tag of ['NEW', 'OLD']) after1[tag] = ev(`${tag} t1 after sweep`, POOLS[tag], snapshotCode(1));
const expAfter1 = expectedSnap(1);
const paidRows = {};
for (const tag of ['NEW', 'OLD']) {
  paidRows[tag] = ev(`${tag} stx-paid rows`, POOLS[tag],
    `(list ${[0, 1].flatMap((t) => Object.values(W).map((w) => `(get-stx-paid u${R} u${t} '${w})`)).join(' ')})`);
}
const fees = {};
for (const tag of ['NEW', 'OLD']) {
  fees[tag] = call(`${tag} withdraw-all-fees drains exactly the earned fees`, POOLS[tag], 'withdraw-all-fees', [Cl.principal(DEP)], `(ok u${model.fees})`, DEP);
  ev(`${tag} earned-fees 0 after withdraw`, POOLS[tag], '(get-earned-fees)', 'u0');
  ev(`${tag} pool balance 0 after payouts, sweeps and fees`, POOLS[tag], '(stx-get-balance current-contract)', 'u0');
}

// -- run ----------------------------------------------------------------------
console.log(`fork block ${forkBlock}, cycle ${cycleNow} (R ${R}), total shares ${TOTAL}, ${plan.length} steps`);
const id = await builder.run();
const url = `https://stxer.xyz/simulations/mainnet/${id}`;
console.log(`View: ${url}`);
const result = await getSimulationResult(id, { stxerApi: API });
const checks = plan.map((p, i) => {
  const step = result.steps[i]?.Result;
  let actual;
  if (p.kind === 'eval') actual = step?.Eval?.Ok !== undefined ? cvToString(deserializeCV(step.Eval.Ok)) : `ENGINE ${JSON.stringify(step).slice(0, 200)}`;
  else actual = step?.Transaction?.Ok && !step.Transaction.Ok.vm_error ? cvToString(deserializeCV(step.Transaction.Ok.result)) : `ENGINE ${JSON.stringify(step).slice(0, 300)}`;
  const passed = p.kind === 'deploy' || p.kind === 'transfer' ? !actual.startsWith('ENGINE')
    : typeof p.want === 'function' ? p.want(actual) && !actual.startsWith('ENGINE') : actual === p.want;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${p.label}: ${actual.slice(0, 220)}`);
  return { label: p.label, passed, actual };
});

const a = (i) => checks[i].actual;
const field = (s, f) => { const m = s.match(new RegExp(`\\(${f} (u\\d+|true|false)\\)`)); return m ? (m[1].startsWith('u') ? BigInt(m[1].slice(1)) : m[1] === 'true') : undefined; };
const uints = (s) => [...s.matchAll(/u(\d+)/g)].map((m) => BigInt(m[1]));
const extra = [];
const snapMatches = (s, e) => field(s, 'paid') === e.paid && field(s, 'paid-shares') === e.paidShares && field(s, 'residue') === e.residue
  && field(s, 'fully-paid') === e.full && field(s, 'earned-fees') === e.fees && field(s, 'balance') === e.balance;
const fmt = (e) => `paid ${e.paid} shares ${e.paidShares} residue ${e.residue} full ${e.full} fees ${e.fees} bal ${e.balance}`;
for (const b of batches) {
  const order = Object.keys(W);
  for (const tag of ['NEW', 'OLD']) {
    const x = b.idx[tag];
    extra.push([`${tag} ${b.label}: tranche-paid / paid-shares / residue / fully-paid / earned-fees / balance match the model`,
      snapMatches(a(x.snap), b.expect), `${a(x.snap).replace(/\s+/g, ' ')} | model ${fmt(b.expect)}`]);
    const before = uints(a(x.balBefore)), after = uints(a(x.balAfter));
    const deltas = order.map((k, i) => after[i] - before[i]);
    const sum = deltas.reduce((t, d) => t + d, 0n);
    extra.push([`${tag} ${b.label}: staker balance deltas sum to the returned total`, sum === b.pay, `${sum} vs ${b.pay}`]);
  }
  const n = a(b.idx.NEW.snap), o = a(b.idx.OLD.snap);
  extra.push([`NEW == OLD ${b.label}: snapshot identical`, n === o, n === o ? 'identical' : `NEW ${n} | OLD ${o}`]);
  extra.push([`NEW == OLD ${b.label}: returned total identical`, a(b.idx.NEW.pay) === a(b.idx.OLD.pay), `${a(b.idx.NEW.pay)} / ${a(b.idx.OLD.pay)}`]);
  const dn = uints(a(b.idx.NEW.balAfter)).map((v, i) => v - uints(a(b.idx.NEW.balBefore))[i]);
  const dold = uints(a(b.idx.OLD.balAfter)).map((v, i) => v - uints(a(b.idx.OLD.balBefore))[i]);
  extra.push([`NEW == OLD ${b.label}: per-staker transfers identical`, dn.join() === dold.join(), `NEW [${dn}] OLD [${dold}]`]);
  const rn = a(b.idx.NEW.raw), ro = a(b.idx.OLD.raw);
  // Only difference by design: NEW always writes both entries, so a fresh
  // tranche whose first batch pays nobody stores (some u0) where OLD stores none.
  // Every reader goes through default-to u0, so the getters above stay equal.
  const rawOk = rn === ro || (rn.replace(/\(some u0\)/g, 'none') === ro);
  extra.push([`NEW vs OLD ${b.label}: raw map entries equal, or NEW (some u0) where OLD none`, rawOk, rn === ro ? 'identical' : `NEW ${rn} | OLD ${ro}`]);
}
// per-staker deltas against the model, per batch (both pools)
{
  const order = Object.keys(W), seen = {};
  for (const b of batches) {
    const want = order.map((k) => {
      const pk = `${b.t}:${k}`;
      if (!b.list.includes(k) || seen[pk] || STAKERS[k][0] === 0n) return 0n;
      seen[pk] = true; return netOf(b.t, k);
    });
    for (const tag of ['NEW', 'OLD']) {
      const x = b.idx[tag], before = uints(a(x.balBefore)), after = uints(a(x.balAfter));
      const got = order.map((k, i) => after[i] - before[i]);
      extra.push([`${tag} ${b.label}: each staker received exactly its net`, got.join() === want.join(), `got [${got}] want [${want}]`]);
    }
  }
}
for (const tag of ['NEW', 'OLD']) {
  extra.push([`${tag} t0 after sweep matches model (residue 0)`, snapMatches(a(after0[tag]), expAfter0), `${a(after0[tag]).replace(/\s+/g, ' ')} | model ${fmt(expAfter0)}`]);
  extra.push([`${tag} t1 after sweep matches model (residue 0)`, snapMatches(a(after1[tag]), expAfter1), `${a(after1[tag]).replace(/\s+/g, ' ')} | model ${fmt(expAfter1)}`]);
  const rows = uints(a(paidRows[tag]));
  const wantRows = [0, 1].flatMap((t) => Object.keys(W).filter((k) => STAKERS[k][0] > 0n).map((k) => netOf(t, k)));
  extra.push([`${tag} stx-paid rows = model nets, zero-share staker has no row`, rows.join() === wantRows.join() && (a(paidRows[tag]).match(/\(some /g) || []).length === wantRows.length, `[${rows}] vs [${wantRows}]`]);
}
extra.push(['NEW == OLD early sweep result', a(early.NEW) === a(early.OLD), `${a(early.NEW)} / ${a(early.OLD)}`]);
extra.push(['NEW == OLD t0 sweep amount', a(sweep0.NEW) === a(sweep0.OLD), `${a(sweep0.NEW)} / ${a(sweep0.OLD)}`]);
extra.push(['NEW == OLD t1 sweep amount', a(sweep1.NEW) === a(sweep1.OLD), `${a(sweep1.NEW)} / ${a(sweep1.OLD)}`]);
extra.push(['NEW == OLD t0/t1 final snapshots', a(after0.NEW) === a(after0.OLD) && a(after1.NEW) === a(after1.OLD), 'compared']);
extra.push(['NEW == OLD stx-paid rows', a(paidRows.NEW) === a(paidRows.OLD), 'compared']);
extra.push(['NEW == OLD fees withdrawn', a(fees.NEW) === a(fees.OLD), `${a(fees.NEW)} / ${a(fees.OLD)}`]);
extra.push(['model: OG fees exercised (S1 0, S2 partial, S8 0) and taxed fees > 0',
  feeOf(0, 'S1') === 0n && feeOf(0, 'S8') === 0n && feeOf(0, 'S2') > 0n && feeOf(0, 'S2') < feeOf(0, 'S3') * 2n && feeOf(0, 'S7') > 0n,
  `S1 ${feeOf(0, 'S1')} S2 ${feeOf(0, 'S2')} S3 ${feeOf(0, 'S3')} S7 ${feeOf(0, 'S7')} S8 ${feeOf(0, 'S8')}`]);
for (const [label, passed, actual] of extra) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}: ${actual}`);
  checks.push({ label, passed, actual });
}
const failed = checks.filter((c) => !c.passed).length;
const dir = resolve(directory, 'results/pool-vault-stx'); mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'juice-pay-batches.json'), JSON.stringify({ id, url, block: forkBlock, cycle: cycleNow, rewardCycle: R,
  newSource: { rev: NEW_FILE ? null : NEW_REV, path: NEW_FILE ?? REPO_PATH, sha256: sha(newSource) }, oldSource: { rev: OLD_REV, sha256: sha(oldSource) }, sourceHashes, checks }, null, 2));
console.log(`\n=== juice-pay-batches: ${checks.length - failed}/${checks.length} passed ===\nView: ${url}`);
if (failed) process.exit(1);
