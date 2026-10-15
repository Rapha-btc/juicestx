// earned-fees / earned-sbtc-fees batch accounting on a mainnet fork, side by side.
// NEW = da7913d pool (or NEW_REV), OLD = e425a4c pool (or OLD_REV), both via git show.
//
// Bounty mv7dfb Rare Io I2 (da7913d) moved the earned-fees write out of pay-one
// and the earned-sbtc-fees write out of pay-recovered-sbtc-one (the sBTC one
// wrote even when fee = 0). pay-stx-stakers and pay-recovered-sbtc-stakers now
// add the fold's `fees` total once after the fold. This sim deploys NEW and OLD
// under two names, gives both the same fixture state and runs the same calls on
// both. After every step it checks each pool against a JS model and checks that
// NEW and OLD read the same values.
//
// STX path (pay-stx-stakers): tranche 0 over four batches with a fee change
// (450 -> 200 bips, real propose / 144-block cooldown / confirm) between
// batches, duplicate staker in one batch and across batches, zero-share staker,
// a batch that pays nobody, OG fully / partly / over covered vs taxed stakers,
// rounding dust, partial withdraw-fees between batches, sweep refused while
// unpaid, sweep, second sweep refused; tranche 1 in one batch; tranche 2 is the
// recovered tranche (its recovered STX pot also goes through pay-stx-stakers).
//
// Recovered-sBTC path (pay-recovered-sbtc-stakers) on tranche 2: the recovered
// state is the exact set of writes emergency-recover makes (stx-pot,
// recovered-sbtc-pot, finalized-tranches) plus real sBTC sent from a whale;
// the full emergency-recover path runs in pool-vault-recovery-stxer.mjs. Four
// batches with a second fee change (200 -> 500) between them, zero-fee stakers
// (OG and 0-sat dust) that OLD still wrote for, a batch that pays nobody,
// partial withdraw-sbtc-fees, over-withdraw refused (u111), sweep refused while
// unpaid, sweep, second sweep refused.
//
// Checked after every batch, per pool and NEW == OLD: earned-fees,
// earned-sbtc-fees, tranche-paid, tranche-paid-shares, residue, fully-paid,
// recovered-sbtc pot / tranche-paid / paid-shares / residue / fully-paid, raw
// map entries, per-staker stx-paid / recovered-sbtc-paid rows, per-staker STX
// and sBTC deltas, pool STX and sBTC balances, returned totals.
//
// Run: node simulations/pool-pay-fees-stxer.mjs
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
const SBTC_WHALE = 'SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1';
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const POX = 'SP000000000000000000002Q6VF78.pox-5';
const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const API = process.env.STXER_API_URL || 'https://api.stxer.xyz';
const REPO_PATH = 'contracts/pox-5/juice-pool-sbtc-signer.clar';
const NEW_REV = process.env.NEW_REV || 'da7913d', OLD_REV = process.env.OLD_REV || 'e425a4c';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const gitShow = (rev) => execFileSync('git', ['show', `${rev}:${REPO_PATH}`], { cwd: resolve(directory, '..'), encoding: 'utf8' });
// NEW_SOURCE_FILE=<path> deploys that file as NEW instead (e.g. the exact deploy bytes).
const NEW_FILE = process.env.NEW_SOURCE_FILE ? resolve(process.env.NEW_SOURCE_FILE) : null;
const newSource = NEW_FILE ? readFileSync(NEW_FILE, 'utf8') : gitShow(NEW_REV), oldSource = gitShow(OLD_REV);
if (newSource === oldSource) throw new Error('NEW and OLD sources are identical');
const TAGS = ['NEW', 'OLD'];
const POOLS = { NEW: `${DEP}.juice-pool-sbtc-signer`, OLD: `${DEP}.juice-pool-sbtc-signer-${OLD_REV}` };

const STX = 1_000_000n, MAXB = 10000n;
const acct = (d) => getAddressFromPrivateKey(d.repeat(64) + '01', 'mainnet');
// name: [shares, OG cover]
const STAKERS = {
  S1: [1000n * STX, 1000n * STX], // OG fully covered: no fee
  S2: [1000n * STX, 300n * STX], // OG partly covered
  S3: [500n * STX, 0n], // taxed
  S4: [0n, 0n], // listed, zero shares
  S5: [7n, 0n], // rounding dust (0-sat sBTC, fee 0)
  S6: [123_456_789n, 0n], // taxed, odd amount
  S7: [2000n * STX, 0n], // taxed, largest
  S8: [50n * STX, 5000n * STX], // cover above shares: no fee
};
const NAMES = Object.keys(STAKERS);
const W = Object.fromEntries(NAMES.map((k, i) => [k, acct(String(i + 1))]));
const TOTAL = Object.values(STAKERS).reduce((t, [n]) => t + n, 0n);
const POT = [800n * STX + 3n, 150n * STX + 11n, 5n * STX + 17n]; // tranche 2 = recovered STX
const SPOT = 123_457n; // recovered sBTC sats on tranche 2

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
const advance = (n, label) => {
  builder.addAdvanceBlocks({ bitcoin_blocks: n, stacks_blocks_per_bitcoin: 1, bitcoin_interval_secs: 1 });
  return push({ label: `${label}: advance ${n} burn blocks`, kind: 'advance' });
};
const both = (fn) => Object.fromEntries(TAGS.map((tag) => [tag, fn(tag, POOLS[tag])]));

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
for (const tag of TAGS) {
  const P = POOLS[tag];
  const key = `{ reward-cycle: u${R}, bond-index: none, signer: '${P} }`;
  const sets = Object.entries(STAKERS).filter(([, [n]]) => n > 0n)
    .map(([k, [n]]) => `(map-set staker-shares-staked-for-cycle { reward-cycle: u${R}, bond-index: none, signer: '${P}, staker: '${W[k]} } u${n})`).join(' ');
  ev(`fixture ${tag}: pox-5 cycle ${R} shares, total ${TOTAL}`, POX,
    `(begin (map-set signer-shares-staked-for-cycle ${key} u${TOTAL}) ${sets} true)`, 'true');
  const og = Object.entries(STAKERS).filter(([, [, c]]) => c > 0n).map(([k, [, c]]) => `(map-set og-stakers '${W[k]} u${c})`).join(' ');
  ev(`fixture ${tag}: tranches 0/1 finalized, tranche 2 recovered (emergency-recover writes), OG covers`, P, `(begin
    (map-set finalized-tranches { reward-cycle: u${R}, tranche: u0 } true)
    (map-set finalized-tranches { reward-cycle: u${R}, tranche: u1 } true)
    (map-set finalized-tranches { reward-cycle: u${R}, tranche: u2 } true)
    (map-set stx-pot { reward-cycle: u${R}, tranche: u0 } u${POT[0]})
    (map-set stx-pot { reward-cycle: u${R}, tranche: u1 } u${POT[1]})
    (map-set stx-pot { reward-cycle: u${R}, tranche: u2 } u${POT[2]})
    (map-set recovered-sbtc-pot { reward-cycle: u${R}, tranche: u2 } u${SPOT})
    (map-set tranche-count u${R} u3)
    ${og} true)`, 'true');
  builder.withSender(STX_WHALE).addSTXTransfer({ recipient: P, amount: Number(POT[0] + POT[1] + POT[2]) });
  builder.withSender(DEP);
  push({ label: `fund ${tag} pool ${POT[0] + POT[1] + POT[2]} uSTX`, kind: 'transfer' });
  call(`fund ${tag} pool ${SPOT} sats sBTC`, SBTC, 'transfer', [Cl.uint(SPOT), Cl.principal(SBTC_WHALE), Cl.principal(P), Cl.none()], '(ok true)', SBTC_WHALE);
  ev(`${tag} cycle total shares`, P, `(get-cycle-total-shares u${R})`, `u${TOTAL}`);
  ev(`${tag} fee is 4.5%`, P, '(get-fee-bips)', 'u450');
  ev(`${tag} tranche 2 is recovered, 0/1 are not`, P, `(list (is-recovered-tranche u${R} u0) (is-recovered-tranche u${R} u1) (is-recovered-tranche u${R} u2))`, '(list false false true)');
  ev(`${tag} recovered sBTC pot`, P, `(get-recovered-sbtc-pot u${R} u2)`, `u${SPOT}`);
}

// -- JS model -------------------------------------------------------------------
let FEE = 450n;
const m = {
  paid: {}, gross: [0n, 0n, 0n], shares: [0n, 0n, 0n], swept: [0n, 0n, 0n], fees: 0n, stxOut: 0n,
  sPaid: {}, sGross: 0n, sShares: 0n, sSwept: 0n, sFees: 0n, sOut: 0n,
};
const share = (pot, k) => pot * STAKERS[k][0] / TOTAL;
const feeOn = (owed, k) => {
  const [n, c] = STAKERS[k], taxed = n > c ? n - c : 0n;
  return taxed === 0n ? 0n : (owed * FEE * taxed) / (MAXB * n);
};
const STX_IN = POT[0] + POT[1] + POT[2];
const stxSnapCode = (t) => `{ paid: (get-tranche-paid u${R} u${t}), paid-shares: (get-tranche-paid-shares u${R} u${t}),
  residue: (get-tranche-residue u${R} u${t}), fully-paid: (is-tranche-fully-paid u${R} u${t}),
  earned-fees: (get-earned-fees), earned-sbtc-fees: (get-earned-sbtc-fees), balance: (stx-get-balance current-contract),
  raw-paid: (map-get? tranche-paid { reward-cycle: u${R}, tranche: u${t} }), raw-shares: (map-get? tranche-paid-shares { reward-cycle: u${R}, tranche: u${t} }) }`;
const sbtcSnapCode = `{ pot: (get-recovered-sbtc-pot u${R} u2), paid-shares: (get-recovered-sbtc-paid-shares u${R} u2),
  residue: (get-recovered-sbtc-residue u${R} u2), fully-paid: (is-recovered-tranche-fully-paid u${R} u2),
  earned-fees: (get-earned-fees), earned-sbtc-fees: (get-earned-sbtc-fees),
  raw-paid: (map-get? recovered-sbtc-tranche-paid { reward-cycle: u${R}, tranche: u2 }), raw-shares: (map-get? recovered-sbtc-paid-shares { reward-cycle: u${R}, tranche: u2 }) }`;
const stxBalCode = `(list ${NAMES.map((k) => `(stx-get-balance '${W[k]})`).join(' ')})`;
const sbtcBalCode = (P) => `(list (ft-get-balance sbtc-token '${P}) ${NAMES.map((k) => `(ft-get-balance sbtc-token '${W[k]})`).join(' ')})`;
const expStx = (t) => {
  const paid = m.gross[t] + m.swept[t];
  return { paid, 'paid-shares': m.shares[t], residue: POT[t] - paid, 'fully-paid': m.shares[t] >= TOTAL,
    'earned-fees': m.fees, 'earned-sbtc-fees': m.sFees, balance: STX_IN - m.stxOut };
};
const expSbtc = () => {
  const paid = m.sGross + m.sSwept;
  return { pot: SPOT, 'paid-shares': m.sShares, residue: SPOT - paid, 'fully-paid': m.sShares >= TOTAL,
    'earned-fees': m.fees, 'earned-sbtc-fees': m.sFees, poolSbtc: SPOT - m.sOut };
};

const steps = []; // { label, kind: 'stx'|'sbtc', t, list, pay, nets, expect, idx }
const stxBatch = (label, t, list) => {
  let pay = 0n; const nets = Object.fromEntries(NAMES.map((k) => [k, 0n]));
  for (const k of list) {
    const pk = `${t}:${k}`;
    if (m.paid[pk] !== undefined || STAKERS[k][0] === 0n) continue;
    const owed = share(POT[t], k), fee = feeOn(owed, k), net = owed - fee;
    m.paid[pk] = net; nets[k] = net; pay += net;
    m.gross[t] += owed; m.shares[t] += STAKERS[k][0]; m.fees += fee; m.stxOut += net;
  }
  const idx = both((tag, P) => ({
    before: ev(`${tag} ${label}: staker STX before`, P, stxBalCode),
    pay: call(`${tag} ${label}: pay-stx-stakers t${t} [${list.join(',')}] @${FEE}bips`, P, 'pay-stx-stakers',
      [Cl.list(list.map((k) => Cl.principal(W[k]))), Cl.uint(R), Cl.uint(t)], `(ok u${pay})`),
    after: ev(`${tag} ${label}: staker STX after`, P, stxBalCode),
    snap: ev(`${tag} ${label}: tranche ${t} snapshot`, P, stxSnapCode(t)),
  }));
  steps.push({ label, kind: 'stx', t, list, pay, nets, expect: expStx(t), idx });
};
const sbtcBatch = (label, list) => {
  let pay = 0n; const nets = Object.fromEntries(NAMES.map((k) => [k, 0n]));
  for (const k of list) {
    if (m.sPaid[k] !== undefined || STAKERS[k][0] === 0n) continue;
    const owed = share(SPOT, k), fee = feeOn(owed, k), net = owed - fee;
    m.sPaid[k] = net; nets[k] = net; pay += net;
    m.sGross += owed; m.sShares += STAKERS[k][0]; m.sFees += fee; m.sOut += net;
  }
  const idx = both((tag, P) => ({
    before: ev(`${tag} ${label}: pool + staker sBTC before`, SBTC, sbtcBalCode(P)),
    pay: call(`${tag} ${label}: pay-recovered-sbtc-stakers t2 [${list.join(',')}] @${FEE}bips`, P, 'pay-recovered-sbtc-stakers',
      [Cl.list(list.map((k) => Cl.principal(W[k]))), Cl.uint(R), Cl.uint(2)], `(ok u${pay})`),
    after: ev(`${tag} ${label}: pool + staker sBTC after`, SBTC, sbtcBalCode(P)),
    snap: ev(`${tag} ${label}: recovered tranche snapshot`, P, sbtcSnapCode),
  }));
  steps.push({ label, kind: 'sbtc', list, pay, nets, expect: expSbtc(), idx });
};
const pair = []; // [label, {NEW, OLD}] whose results must match
const callBoth = (label, fn, args, wantFn, sender = DEP) => {
  const idx = both((tag, P) => call(`${tag} ${label}`, P, fn, args, wantFn, sender));
  pair.push([label, idx]); return idx;
};
const evBoth = (label, code, want) => { const idx = both((tag, P) => ev(`${tag} ${label}`, P, code, want)); pair.push([label, idx]); return idx; };
const changeFee = (to) => {
  callBoth(`propose-fee-bips u${to}`, 'propose-fee-bips', [Cl.uint(to)], `(ok u${to})`);
  callBoth('confirm-fee-bips before cooldown refused (u114)', 'confirm-fee-bips', [], '(err u114)');
  advance(145, `fee ${FEE} -> ${to} cooldown`);
  callBoth(`confirm-fee-bips -> u${to}`, 'confirm-fee-bips', [], '(ok true)');
  evBoth(`fee is now ${to}`, '(get-fee-bips)', `u${to}`);
  FEE = BigInt(to);
};

// -- STX tranche 0: four batches, fee change and partial fee withdraw between --
stxBatch('B1 S2 twice + zero-share S4', 0, ['S1', 'S2', 'S2', 'S4']);
stxBatch('B2 S1/S2 again + S3 twice + dust S5', 0, ['S2', 'S3', 'S1', 'S5', 'S3']);
callBoth('withdraw-fees above earned refused (u111)', 'withdraw-fees', [Cl.uint(m.fees + 1n), Cl.principal(DEP)], '(err u111)');
const part1 = m.fees / 3n;
callBoth(`withdraw-fees ${part1} (a third of earned)`, 'withdraw-fees', [Cl.uint(part1), Cl.principal(DEP)], `(ok u${part1})`);
m.fees -= part1; m.stxOut += part1;
evBoth('earned-fees after partial withdraw', '(get-earned-fees)', `u${m.fees}`);
changeFee(200);
stxBatch('B3 nobody owed (S4 zero, S1 paid) @200', 0, ['S4', 'S1']);
const early0 = callBoth('sweep t0 while S6/S7/S8 unpaid refused (u104)', 'sweep-tranche-dust', [Cl.uint(R), Cl.uint(0)], '(err u104)');
stxBatch('B4 last @200: S6, S7, S8', 0, ['S6', 'S7', 'S8']);
const residue0 = POT[0] - m.gross[0];
callBoth('sweep t0 after the last batch', 'sweep-tranche-dust', [Cl.uint(R), Cl.uint(0)], `(ok u${residue0})`);
m.swept[0] = residue0; m.stxOut += residue0;
callBoth('second t0 sweep refused (u105)', 'sweep-tranche-dust', [Cl.uint(R), Cl.uint(0)], '(err u105)');

// -- STX tranche 1: one batch, everyone, duplicates ------------------------------
stxBatch('B5 t1 everyone, S1/S2 twice @200', 1, ['S8', 'S7', 'S6', 'S5', 'S4', 'S3', 'S2', 'S1', 'S1', 'S2']);
const residue1 = POT[1] - m.gross[1];
callBoth('sweep t1', 'sweep-tranche-dust', [Cl.uint(R), Cl.uint(1)], `(ok u${residue1})`);
m.swept[1] = residue1; m.stxOut += residue1;

// -- recovered tranche 2: sBTC path with a fee change, plus its STX pot ----------
callBoth('pay-recovered-sbtc-stakers on a non-recovered tranche refused (u116)', 'pay-recovered-sbtc-stakers',
  [Cl.list([Cl.principal(W.S3)]), Cl.uint(R), Cl.uint(0)], '(err u116)', STRANGER);
sbtcBatch('SB1 S1 (OG, fee 0) + S5 (0 sats) + S4 zero @200', ['S1', 'S5', 'S4']);
sbtcBatch('SB2 S2 twice, S3, S1 again @200', ['S2', 'S3', 'S2', 'S1']);
callBoth('withdraw-sbtc-fees above earned refused (u111)', 'withdraw-sbtc-fees', [Cl.uint(m.sFees + 1n), Cl.principal(DEP)], '(err u111)');
const spart = m.sFees / 2n;
callBoth(`withdraw-sbtc-fees ${spart} (half of earned)`, 'withdraw-sbtc-fees', [Cl.uint(spart), Cl.principal(DEP)], `(ok u${spart})`);
m.sFees -= spart; m.sOut += spart;
const earlyS = callBoth('sweep recovered sBTC while S6/S7/S8 unpaid refused (u104)', 'sweep-recovered-sbtc-dust', [Cl.uint(R), Cl.uint(2)], '(err u104)');
changeFee(500);
sbtcBatch('SB3 nobody owed (S4, S5, S1 paid) @500', ['S4', 'S5', 'S1']);
stxBatch('B6 t2 recovered STX pot, first half @500', 2, ['S1', 'S3', 'S5', 'S7']);
sbtcBatch('SB4 last @500: S8 (over-covered), S7, S6, S3 again', ['S8', 'S7', 'S6', 'S3']);
stxBatch('B7 t2 recovered STX pot, rest @500', 2, ['S2', 'S4', 'S6', 'S8', 'S1']);
const sres = SPOT - m.sGross;
callBoth('sweep recovered sBTC dust', 'sweep-recovered-sbtc-dust', [Cl.uint(R), Cl.uint(2)], sres > 0n ? `(ok u${sres})` : '(err u105)');
if (sres > 0n) { m.sSwept = sres; m.sOut += sres; }
callBoth('second recovered sBTC sweep refused (u105)', 'sweep-recovered-sbtc-dust', [Cl.uint(R), Cl.uint(2)], '(err u105)');
const residue2 = POT[2] - m.gross[2];
callBoth('sweep t2 STX', 'sweep-tranche-dust', [Cl.uint(R), Cl.uint(2)], residue2 > 0n ? `(ok u${residue2})` : '(err u105)');
if (residue2 > 0n) { m.swept[2] = residue2; m.stxOut += residue2; }

// -- final state ------------------------------------------------------------------
const finals = both((tag, P) => ({
  t: [0, 1, 2].map((t) => ev(`${tag} final tranche ${t}`, P, stxSnapCode(t))),
  s: ev(`${tag} final recovered tranche`, P, sbtcSnapCode),
  rows: ev(`${tag} stx-paid + recovered-sbtc-paid rows`, P,
    `{ stx: (list ${[0, 1, 2].flatMap((t) => NAMES.map((k) => `(get-stx-paid u${R} u${t} '${W[k]})`)).join(' ')}), sbtc: (list ${NAMES.map((k) => `(get-recovered-sbtc-paid u${R} u2 '${W[k]})`).join(' ')}) }`),
}));
const finalExp = { t: [0, 1, 2].map(expStx), s: expSbtc() };
const fw = callBoth('withdraw-all-fees drains the rest of earned-fees', 'withdraw-all-fees', [Cl.principal(DEP)], `(ok u${m.fees})`);
const sw = callBoth('withdraw-sbtc-fees drains the rest of earned-sbtc-fees', 'withdraw-sbtc-fees', [Cl.uint(m.sFees), Cl.principal(DEP)], `(ok u${m.sFees})`);
evBoth('earned-fees and earned-sbtc-fees both 0', '(list (get-earned-fees) (get-earned-sbtc-fees))', '(list u0 u0)');
evBoth('pool STX balance 0', '(stx-get-balance current-contract)', 'u0');
const poolSbtc0 = both((tag, P) => ev(`${tag} pool sBTC balance 0`, SBTC, `(ft-get-balance sbtc-token '${P})`, 'u0'));
pair.push(['pool sBTC balance 0', poolSbtc0]);

// -- run ----------------------------------------------------------------------
console.log(`fork block ${forkBlock}, cycle ${cycleNow} (R ${R}), total shares ${TOTAL}, ${plan.length} steps, NEW ${NEW_REV} OLD ${OLD_REV}`);
const id = await builder.run();
const url = `https://stxer.xyz/simulations/mainnet/${id}`;
console.log(`View: ${url}`);
const result = await getSimulationResult(id, { stxerApi: API });
const checks = plan.map((p, i) => {
  const step = result.steps[i]?.Result;
  let actual;
  if (p.kind === 'advance') actual = step?.AdvanceBlocks?.Ok ? 'ok' : `ENGINE ${JSON.stringify(step).slice(0, 200)}`;
  else if (p.kind === 'eval') actual = step?.Eval?.Ok !== undefined ? cvToString(deserializeCV(step.Eval.Ok)) : `ENGINE ${JSON.stringify(step).slice(0, 200)}`;
  else actual = step?.Transaction?.Ok && !step.Transaction.Ok.vm_error ? cvToString(deserializeCV(step.Transaction.Ok.result)) : `ENGINE ${JSON.stringify(step).slice(0, 300)}`;
  const passed = p.kind === 'advance' ? actual === 'ok'
    : p.kind === 'deploy' || p.kind === 'transfer' ? !actual.startsWith('ENGINE')
    : typeof p.want === 'function' ? p.want(actual) && !actual.startsWith('ENGINE') : actual === p.want;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${p.label}: ${actual.slice(0, 220)}`);
  return { label: p.label, passed, actual };
});

const a = (i) => checks[i].actual;
const field = (s, f) => { const mm = s.match(new RegExp(`\\(${f} (u\\d+|true|false)\\)`)); return mm ? (mm[1].startsWith('u') ? BigInt(mm[1].slice(1)) : mm[1] === 'true') : undefined; };
const uints = (s) => [...s.matchAll(/u(\d+)/g)].map((x) => BigInt(x[1]));
const extra = [];
const matches = (s, e) => Object.entries(e).filter(([k]) => k !== 'poolSbtc').every(([k, v]) => field(s, k) === v);
const fmt = (e) => Object.entries(e).map(([k, v]) => `${k} ${v}`).join(' ');
for (const b of steps) {
  for (const tag of TAGS) {
    const x = b.idx[tag];
    extra.push([`${tag} ${b.label}: snapshot matches the model`, matches(a(x.snap), b.expect), `${a(x.snap).replace(/\s+/g, ' ')} | model ${fmt(b.expect)}`]);
    const before = uints(a(x.before)), after = uints(a(x.after));
    const d = after.map((v, i) => v - before[i]);
    const stakerD = b.kind === 'sbtc' ? d.slice(1) : d;
    const want = NAMES.map((k) => b.nets[k]);
    extra.push([`${tag} ${b.label}: each staker received exactly its net`, stakerD.join() === want.join(), `got [${stakerD}] want [${want}]`]);
    if (b.kind === 'sbtc') {
      extra.push([`${tag} ${b.label}: pool sBTC fell by the returned total and matches the model`,
        -d[0] === b.pay && after[0] === b.expect.poolSbtc, `delta ${d[0]} pay ${b.pay} pool ${after[0]} model ${b.expect.poolSbtc}`]);
    }
  }
  for (const key of ['pay', 'snap']) {
    const n = a(b.idx.NEW[key]), o = a(b.idx.OLD[key]);
    extra.push([`NEW == OLD ${b.label}: ${key === 'pay' ? 'returned total' : 'snapshot (incl. raw maps, both fee vars, balance)'} identical`, n === o, n === o ? 'identical' : `NEW ${n} | OLD ${o}`]);
  }
  const dn = uints(a(b.idx.NEW.after)).map((v, i) => v - uints(a(b.idx.NEW.before))[i]);
  const dold = uints(a(b.idx.OLD.after)).map((v, i) => v - uints(a(b.idx.OLD.before))[i]);
  extra.push([`NEW == OLD ${b.label}: per-account transfers identical`, dn.join() === dold.join(), `NEW [${dn}] OLD [${dold}]`]);
}
for (const [label, idx] of pair) {
  extra.push([`NEW == OLD ${label}`, a(idx.NEW) === a(idx.OLD), `${a(idx.NEW)} / ${a(idx.OLD)}`]);
}
for (const tag of TAGS) {
  finals[tag].t.forEach((i, t) => extra.push([`${tag} final tranche ${t} matches the model (residue 0)`, matches(a(i), finalExp.t[t]), `${a(i).replace(/\s+/g, ' ')} | model ${fmt(finalExp.t[t])}`]));
  extra.push([`${tag} final recovered tranche matches the model (residue 0)`, matches(a(finals[tag].s), finalExp.s), `${a(finals[tag].s).replace(/\s+/g, ' ')} | model ${fmt(finalExp.s)}`]);
  const rows = a(finals[tag].rows);
  const wantStx = [0, 1, 2].flatMap((t) => NAMES.map((k) => m.paid[`${t}:${k}`]));
  const wantS = NAMES.map((k) => m.sPaid[k]);
  const fmtRow = (v) => (v === undefined ? 'none' : `(some u${v})`);
  const want = `(tuple (sbtc (list ${wantS.map(fmtRow).join(' ')})) (stx (list ${wantStx.map(fmtRow).join(' ')})))`;
  extra.push([`${tag} stx-paid / recovered-sbtc-paid rows = model nets, zero-share staker has no row`, rows === want, rows === want ? 'match' : `${rows} | model ${want}`]);
}
for (const k of ['t', 's', 'rows']) {
  const n = JSON.stringify([finals.NEW[k]].flat().map(a)), o = JSON.stringify([finals.OLD[k]].flat().map(a));
  extra.push([`NEW == OLD final ${k}`, n === o, 'compared']);
}
extra.push(['model: fee paths exercised (STX fees at 450/200/500, sBTC fees at 200/500, zero-fee OG + 0-sat stakers)',
  m.paid['0:S3'] > 0n && feeOn(share(SPOT, 'S5'), 'S5') === 0n && share(SPOT, 'S5') === 0n && feeOn(share(SPOT, 'S1'), 'S1') === 0n,
  `S5 sBTC owed ${share(SPOT, 'S5')}, fees withdrawn final ${a(fw.NEW)} / ${a(sw.NEW)}`]);
for (const [label, passed, actual] of extra) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}: ${actual}`);
  checks.push({ label, passed, actual });
}
const failed = checks.filter((c) => !c.passed).length;
const dir = resolve(directory, 'results/pool-vault-stx'); mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'juice-pay-fees.json'), JSON.stringify({ id, url, block: forkBlock, cycle: cycleNow, rewardCycle: R,
  newSource: { rev: NEW_FILE ? null : NEW_REV, path: NEW_FILE ?? REPO_PATH, sha256: sha(newSource) }, oldSource: { rev: OLD_REV, sha256: sha(oldSource) }, sourceHashes, checks }, null, 2));
console.log(`\n=== juice-pay-fees: ${checks.length - failed}/${checks.length} passed ===\nView: ${url}`);
if (failed) process.exit(1);
