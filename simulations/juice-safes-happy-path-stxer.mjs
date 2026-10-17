// stxer mainnet-fork happy path for both Juice staking safe kinds.
// Fresh safes deployed from the exact live template bytes, onboarded by
// FAKFUN-DEPLOYER with a funded mainnet address as admin (no passkey: sig-auth none),
// then: fund -> stake -> advance into next cycle -> unstake -> advance to unlock -> withdraw.
import { createHash } from 'node:crypto';
import { SimulationBuilder, getSimulationResult } from 'stxer';
import { Cl, ClarityVersion, deserializeCV, cvToString, serializeCV } from '@stacks/transactions';

const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const API = 'https://api.stxer.xyz';
const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const RELAY = 'SP28MP1HQDJWQAFSQJN2HBAXBVP7H7THD1W2NYZVK'; // FAKFUN-DEPLOYER
const ADMIN = 'SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51';  // funded mainnet STX address
const RECOVERY = 'SP3HXJJMJQ06GNAZ8XWDN1QM48JEDC6PP6W3YZPZJ';
const OUTSIDE = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const POX = 'SP000000000000000000002Q6VF78.pox-5';
const CORE = `${DEP}.fakfun-wallet-core-v2`;
const FIRST_BURN = 666050, CYCLE = 2100;
const STAKE = 1_000_000_000;      // 1,000 STX per safe
const THRESHOLD = 5_000_000_000;  // 5,000 STX per-period limit -> 1,000 STX withdraw is immediate
const CLARITY_6 = ClarityVersion.Clarity6 ?? 6;

const KINDS = [
  { kind: 'Earn BTC (juice-safe-v9)', template: 'juice-safe-v9', name: 'sim-earn-btc-safe', pool: `${DEP}.juice-pool-stx-signer` },
  { kind: 'Auto-compound (juice-autostake-safe)', template: 'juice-autostake-safe', name: 'sim-grow-stx-safe', pool: `${DEP}.juice-pool-sbtc-signer` },
];

const get = async (p) => { const r = await fetch(`${NODE}${p}`, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
const ro = async (id, fn, args = []) => {
  const [a, n] = id.split('.');
  const r = await fetch(`${NODE}/v2/contracts/call-read/${a}/${n}/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sender: DEP, arguments: args.map((c) => '0x' + serializeCV(c).replace(/^0x/, '')) }) });
  const b = await r.json(); if (!b.okay) throw new Error(JSON.stringify(b)); return cvToString(deserializeCV(b.result));
};

for (const k of KINDS) {
  k.source = (await get(`/v2/contracts/source/${DEP}/${k.template}?proof=0`)).source;
  k.hash = createHash('sha512-256').update(k.source).digest('hex');
  const verified = await ro(CORE, 'get-verified-contract-hash', [Cl.principal(`${DEP}.${k.template}`)]);
  if (verified !== `(some 0x${k.hash})`) throw new Error(`${k.template}: source hash ${k.hash} != core-v2 verified ${verified}`);
  k.id = `${RELAY}.${k.name}`;
  console.log(`${k.template}: live bytes sha512/256 ${k.hash.slice(0, 12)}... == core-v2 verified hash`);
}

const info = await get('/v2/info');
let burn = info.burn_block_height;
const offset = () => (burn - FIRST_BURN) % CYCLE;
const cycleOf = (b) => Math.floor((b - FIRST_BURN) / CYCLE);
console.log(`fork tip: stacks ${info.stacks_tip_height}, burn ${burn}, cycle ${cycleOf(burn)} offset ${offset()}`);
if (offset() >= 1990) throw new Error('tip is in/near the prepare phase; rerun later');

const b = SimulationBuilder.new({ stacksNodeAPI: NODE, apiEndpoint: API, skipTracing: true }).withSender(RELAY);
const plan = [];
const tx = (label, id, fn, args, want, sender) => { b.addContractCall({ contract_id: id, function_name: fn, function_args: args, sender }); plan.push({ label, kind: 'tx', want }); return plan.length - 1; };
const ev = (label, id, code, want = () => true) => { b.addEvalCode(id, code); plan.push({ label, kind: 'eval', want }); return plan.length - 1; };
const advance = (n, label) => { b.addAdvanceBlocks({ bitcoin_blocks: n, stacks_blocks_per_bitcoin: 1, bitcoin_interval_secs: 1 }); burn += n; plan.push({ label: `${label}: +${n} burn -> ${burn} (cycle ${cycleOf(burn)} offset ${offset()})`, kind: 'advance' }); };
const ok = (v) => v.startsWith('(ok');
const u = (field) => (v) => BigInt((v.match(new RegExp(`${field} u(\\d+)`)) || [])[1] ?? '-1');
const acct = (label, who, want) => ev(label, POX, `{ account: (stx-account '${who}), balance: (stx-get-balance '${who}) }`, want);
const slots = Object.fromEntries(KINDS.map((k) => [k.name, {}]));

// 1. deploy + onboard
for (const k of KINDS) {
  b.addContractDeploy({ contract_name: k.name, source_code: k.source, clarity_version: CLARITY_6 });
  plan.push({ label: `[${k.kind}] deploy ${k.id} (live template bytes)`, kind: 'deploy' });
  ev(`[${k.kind}] fresh safe hash == template verified hash`, CORE, `(is-eq (some (unwrap-panic (contract-hash? '${k.id}))) (get-verified-contract-hash '${DEP}.${k.template}))`, (v) => v === 'true');
  tx(`[${k.kind}] onboard (FAKFUN-DEPLOYER), admin ${ADMIN.slice(0, 8)}...`, k.id, 'onboard',
    [Cl.buffer(Buffer.from('02' + 'ab'.repeat(32), 'hex')), Cl.principal(ADMIN), Cl.principal(RECOVERY), Cl.uint(THRESHOLD), Cl.uint(100_000), Cl.uint(144)], ok, RELAY);
  ev(`[${k.kind}] get-owner`, k.id, '(get-owner)', (v) => v.includes(ADMIN));
  ev(`[${k.kind}] core-v2 whitelisted the safe`, CORE, `(is-whitelisted '${k.id})`, (v) => v === 'true');
}

// 2a. fund + stake
for (const k of KINDS) {
  const s = slots[k.name];
  b.withSender(ADMIN).addSTXTransfer({ recipient: k.id, amount: STAKE });
  plan.push({ label: `[${k.kind}] admin funds the safe ${STAKE / 1e6} STX`, kind: 'transfer' });
  s.funded = acct(`[${k.kind}] safe balance after funding`, k.id, (v) => u('unlocked')(v) === BigInt(STAKE));
  s.stake = tx(`[${k.kind}] admin stake-stx-juice ${STAKE / 1e6} STX (sig-auth none)`, k.id, 'stake-stx-juice', [Cl.uint(STAKE), Cl.none(), Cl.none(), Cl.none()], ok, ADMIN);
  s.info1 = ev(`[${k.kind}] pox-5 get-staker-info`, POX, `(get-staker-info '${k.id})`, (v) => v.includes(k.pool) && v.includes(`amount-ustx u${STAKE}`));
  s.locked = acct(`[${k.kind}] all ${STAKE / 1e6} STX locked`, k.id, (v) => u('locked')(v) === BigInt(STAKE) && u('unlocked')(v) === 0n);
}
ev('current reward cycle', POX, '(current-pox-reward-cycle)');

// 2b. advance into the next cycle (the stake becomes active), still locked
advance(CYCLE - offset() + 20, 'into the first staked cycle');
ev('current reward cycle', POX, '(current-pox-reward-cycle)');
for (const k of KINDS) acct(`[${k.kind}] still locked in the staked cycle`, k.id, (v) => u('locked')(v) === BigInt(STAKE));
for (const k of KINDS) tx(`[${k.kind}] withdraw while locked fails (no unlocked STX)`, k.id, 'stx-transfer', [Cl.uint(STAKE), Cl.principal(OUTSIDE), Cl.none(), Cl.none(), Cl.none()], (v) => !ok(v), ADMIN);

// 2c. unstake
for (const k of KINDS) {
  const s = slots[k.name];
  s.unstake = tx(`[${k.kind}] admin unstake (sig-auth none)`, k.id, 'unstake', [Cl.none(), Cl.none()], ok, ADMIN);
  s.info2 = ev(`[${k.kind}] pox-5 get-staker-info after unstake`, POX, `(get-staker-info '${k.id})`);
  acct(`[${k.kind}] still locked until the unlock cycle starts`, k.id, (v) => u('locked')(v) === BigInt(STAKE));
}
const unlockBurn = FIRST_BURN + (cycleOf(burn) + 1) * CYCLE;
advance(unlockBurn - burn + 5, 'past the unlock-burn-height');
ev('current reward cycle', POX, '(current-pox-reward-cycle)');
for (const k of KINDS) {
  const s = slots[k.name];
  s.unlocked = acct(`[${k.kind}] STX unlocked back in the safe`, k.id, (v) => u('locked')(v) === 0n && u('unlocked')(v) === BigInt(STAKE));
  ev(`[${k.kind}] pox-5 get-staker-info after unlock`, POX, `(get-staker-info '${k.id})`);
}

// 2d. withdraw to an outside address (within the limit -> immediate)
for (const k of KINDS) {
  const s = slots[k.name];
  s.outBefore = acct(`[${k.kind}] outside address balance before`, OUTSIDE);
  s.withdraw = tx(`[${k.kind}] admin stx-transfer ${STAKE / 1e6} STX -> outside`, k.id, 'stx-transfer', [Cl.uint(STAKE), Cl.principal(OUTSIDE), Cl.none(), Cl.none(), Cl.none()], (v) => v === '(ok true)', ADMIN);
  s.safeAfter = acct(`[${k.kind}] safe balance after withdraw`, k.id, (v) => u('balance')(v) === 0n || /balance u0/.test(v));
  s.outAfter = acct(`[${k.kind}] outside address balance after`, OUTSIDE);
  ev(`[${k.kind}] no pending op queued`, k.id, '(get-pending-operation u0)');
}

console.log(`${plan.length} steps, running...`);
const id = await b.run();
const url = `https://stxer.xyz/simulations/mainnet/${id}`;
console.log(`View: ${url}`);
const res = await getSimulationResult(id, { stxerApi: API });
const checks = plan.map((p, i) => {
  const st = res.steps[i]?.Result;
  let actual;
  if (p.kind === 'advance') actual = st?.AdvanceBlocks?.Ok ? 'ok' : `ENGINE ${JSON.stringify(st).slice(0, 200)}`;
  else if (p.kind === 'eval') actual = st?.Eval?.Ok !== undefined ? cvToString(deserializeCV(st.Eval.Ok)) : `ENGINE ${JSON.stringify(st).slice(0, 200)}`;
  else actual = st?.Transaction?.Ok && !st.Transaction.Ok.vm_error ? (st.Transaction.Ok.result ? cvToString(deserializeCV(st.Transaction.Ok.result)) : 'ok') : `ENGINE ${JSON.stringify(st).slice(0, 300)}`;
  const passed = p.kind === 'advance' ? actual === 'ok'
    : p.kind === 'deploy' || p.kind === 'transfer' ? !actual.startsWith('ENGINE')
    : p.want(actual);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${p.label}: ${actual.slice(0, 260)}`);
  return { passed, actual };
});
for (const k of KINDS) {
  const s = slots[k.name], a = (i) => checks[i].actual;
  const delta = u('balance')(a(s.outAfter)) - u('balance')(a(s.outBefore));
  const passed = delta === BigInt(STAKE);
  console.log(`${passed ? 'PASS' : 'FAIL'} [${k.kind}] outside address received ${delta} uSTX`);
  checks.push({ passed });
}
const failed = checks.filter((c) => !c.passed).length;
console.log(`\n=== ${checks.length - failed}/${checks.length} passed ===\n${url}`);
if (failed) process.exit(1);
