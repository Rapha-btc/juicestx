// Accounting coverage on a mainnet fork: juice-pool-sbtc-signer.
//
// Round 1 (STX path): fee timelock (bounds, early confirm, cancel), claim
// pacing, pay-before-finalize, partial and idempotent payouts, the OG partial
// fee, fully-paid detection, dust sweep guards, fee withdrawals.
// Round 2 (recovered sBTC path): emergency-recover after the 432-block delay,
// sBTC payouts with the OG partial fee, recovered dust sweep, sBTC fee withdrawal.
// Plus: validate-stake! caller and pause guards (real pox-5 stake), the
// pox-5 settle bookkeeping call, and every read-only getter.
//
// Real: deploys, signer registration, the paused stake, fee changes, claims,
// Jing placement / reclaim / router sale, finalize, emergency-recover, payouts.
// Fixtures: the earned-reward state of two past cycles (shares A 1000 STX OG
// with 500 covered, B 1000 STX, C 7 uSTX for rounding dust) and the vault's
// batch-start clock, same shape as the pool suite.
//
// Run: node simulations/pool-accounting-stxer.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJingStack } from './_jing-v6-3.mjs';
import { POOL_NAME, VAULT_NAME, juiceSource, juiceForkBlock, traitSource, JUICE_LIVE, verifyLiveJuice } from './_juice-fork.mjs';
import { withVaultArgument } from './_pool-vault-interface.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(directory, '../package.json'));
const { SimulationBuilder, getSimulationResult } = require('stxer');
const {
  Cl, ClarityVersion, deserializeCV, cvToString, serializeCV,
  getAddressFromPrivateKey, randomPrivateKey, privateKeyToPublic, signMessageHashRsv,
} = require('@stacks/transactions');

const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const STRANGER = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const STX_WHALE = 'SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51';
const SBTC_WHALE = 'SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1';
const FEE_SINK = 'SP3HXJJMJQ06GNAZ8XWDN1QM48JEDC6PP6W3YZPZJ';
const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const API = process.env.STXER_API_URL || 'https://api.stxer.xyz';
const POX = 'SP000000000000000000002Q6VF78.pox-5';
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const PID = `${DEP}.${POOL_NAME}`, VID = `${DEP}.${VAULT_NAME}`;
const FIRST_BURN = 666050, CYCLE = 2100;
const STX = 1_000_000n, SH = 1000n * STX, C_SH = 7n, TOTAL = 2n * SH + C_SH;
const FUND = 100000n, FEE = 500n, MAXB = 10000n, COVER = 500n * STX;

const acct = (d) => getAddressFromPrivateKey(d.repeat(64) + '01', 'mainnet');
const A = acct('1'), B = acct('2'), C = acct('3'), STAKER = acct('4');

const readOnly = async (id, fn, args = []) => {
  const [a, n] = id.split('.');
  const r = await fetch(`${NODE}/v2/contracts/call-read/${a}/${n}/${fn}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sender: DEP, arguments: args.map((cv) => '0x' + serializeCV(cv).replace(/^0x/, '')) }),
  });
  const body = await r.json();
  if (!body.okay) throw new Error(`${fn}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.result;
};

const AUTH_ID = 7;
const privKey = randomPrivateKey();
const signerKey = privateKeyToPublic(privKey);
const grantHex = await readOnly(POX, 'get-signer-grant-message-hash', [Cl.contractPrincipal(DEP, POOL_NAME), Cl.uint(AUTH_ID)]);
const signerSig = signMessageHashRsv({ messageHash: grantHex.replace(/^0x/, '').slice(2 + 8), privateKey: privKey });

const { fetchLazerUpdateAny } = await import('./_pool-vault-lazer.mjs');
const proof = await fetchLazerUpdateAny();
const update = Cl.buffer(Buffer.from(proof.hex.replace(/^0x/, ''), 'hex'));
const forkBlock = await juiceForkBlock(NODE);
const info = await (await fetch(`${NODE}/v2/info`)).json();
let burn = info.burn_block_height;
const cycleNow = Number(deserializeCV(await readOnly(POX, 'current-pox-reward-cycle')).value);
const R1 = cycleNow - 1, R2 = cycleNow - 2;

const builder = SimulationBuilder.new({ stacksNodeAPI: NODE, apiEndpoint: API, skipTracing: !process.env.STXER_TRACE })
  .useBlockHeight(forkBlock).withSender(DEP);
const plan = [], sourceHashes = {};
appendJingStack(builder, plan, sourceHashes, forkBlock);
const call = (label, id, fn, args, want, sender = DEP) => {
  builder.addContractCall({ contract_id: id, function_name: fn, function_args: withVaultArgument(PID, VID, id, fn, args, Cl), sender });
  plan.push({ label, kind: 'tx', want });
  return plan.length - 1;
};
const ev = (label, id, code, want) => { builder.addEvalCode(id, code); plan.push({ label, kind: 'eval', want }); return plan.length - 1; };
const rd = (label, code, want) => ev(label, PID, code, want);
const advance = (n, label) => {
  builder.addAdvanceBlocks({ bitcoin_blocks: n, stacks_blocks_per_bitcoin: 1, bitcoin_interval_secs: 1 });
  burn += n;
  plan.push({ label: `${label}: advance ${n} burn blocks`, kind: 'advance' });
};
const ok = (v) => v.startsWith('(ok');
const isU = (v) => /^u\d+$/.test(v);
const list = (...w) => Cl.list(w.map((x) => Cl.principal(x)));

// Earned-reward fixture for one past cycle, same shape as the pool suite.
const fixture = (rc) => {
  const key = `{ reward-cycle: u${rc}, bond-index: none, signer: '${PID} }`;
  const share = (who, n) => `(map-set staker-shares-staked-for-cycle { reward-cycle: u${rc}, bond-index: none, signer: '${PID}, staker: '${who} } u${n})`;
  return ev(`fixture: cycle ${rc} earned ${FUND} sats, shares A ${SH} / B ${SH} / C ${C_SH}`, POX, `(begin
    (map-set signer-shares-staked-for-cycle ${key} u${TOTAL})
    (map-set signer-pending-staked-ustx-per-cycle { signer: '${PID}, cycle: u${rc} } u${TOTAL})
    (map-set signer-rewards-per-token-settled-for-cycle ${key} (get-rewards-per-token-for-cycle u${rc} none))
    (map-set signer-unclaimed-rewards-for-cycle ${key} u${FUND})
    ${share(A, SH)} ${share(B, SH)} ${share(C, C_SH)}
    (var-set last-accounted-rewards-only (+ (var-get last-accounted-rewards-only) u${FUND}))
    (ok true))`, '(ok true)');
};

// -- 1. contracts + guards -----------------------------------------------------
if (JUICE_LIVE) await verifyLiveJuice(NODE, sourceHashes); // live trait, vault, pool at DEP
else {
const trait = traitSource(sourceHashes);
builder.addContractDeploy({ contract_name: trait.name, source_code: trait.source, clarity_version: ClarityVersion.Clarity6 });
plan.push({ label: `deploy ${trait.name} (repo source, new trait)`, kind: 'deploy' });
for (const repoName of ['juice-sbtc-autoswap', 'juice-pool-sbtc-signer']) {
  const j = juiceSource(repoName, resolve(directory, `../contracts/pox-5/${repoName}.clar`), sourceHashes);
  builder.addContractDeploy({ contract_name: j.name, source_code: j.source, clarity_version: ClarityVersion.Clarity6 });
  plan.push({ label: `deploy ${j.name} (repo source)`, kind: 'deploy' });
}
}
call('register the pool as a pox-5 signer', PID, 'register-self',
  [Cl.contractPrincipal(DEP, POOL_NAME), Cl.buffer(Buffer.from(signerKey.replace(/^0x/, ''), 'hex')),
   Cl.uint(AUTH_ID), Cl.buffer(Buffer.from(signerSig.replace(/^0x/, ''), 'hex'))], ok);
call('validate-stake! refuses any caller but pox-5 (u102)', PID, 'validate-stake!',
  [Cl.principal(STRANGER), Cl.uint(cycleNow + 1), Cl.uint(1), Cl.uint(SH), Cl.uint(0), Cl.bool(false), Cl.none()], '(err u102)', STRANGER);
builder.withSender(STX_WHALE).addSTXTransfer({ recipient: STAKER, amount: Number(600n * STX) });
plan.push({ label: 'fund a staker 600 STX', kind: 'transfer' });
builder.withSender(DEP);
if ((burn - FIRST_BURN) % CYCLE > 1950) advance(CYCLE - ((burn - FIRST_BURN) % CYCLE) + 20, 'leave the prepare phase');
call('outsider cannot pause', PID, 'set-paused', [Cl.bool(true)], '(err u100)', STRANGER);
call('admin pauses', PID, 'set-paused', [Cl.bool(true)], '(ok true)');
rd('is-paused', '(is-paused)', 'true');
const stakeArgs = [Cl.contractPrincipal(DEP, POOL_NAME), Cl.uint(500n * STX), Cl.uint(1), Cl.uint(burn), Cl.none()];
call('a real stake into a paused pool is refused (u101)', POX, 'stake', stakeArgs, '(err u101)', STAKER);
call('admin resumes', PID, 'set-paused', [Cl.bool(false)], '(ok true)');
call('the same stake goes through once resumed', POX, 'stake', stakeArgs, ok, STAKER);

// -- 2. fee timelock -----------------------------------------------------------
rd('fee starts at the 4.5% launch rate', '(get-fee-bips)', 'u450');
rd('no pending fee', '(get-pending-fee)', (v) => v.includes('(fee none)'));
call('fee above the 5% cap refused (u110)', PID, 'propose-fee-bips', [Cl.uint(501)], '(err u110)');
call('outsider cannot propose a fee', PID, 'propose-fee-bips', [Cl.uint(100)], '(err u100)', STRANGER);
call('confirm with nothing pending (u113)', PID, 'confirm-fee-bips', [], '(err u113)');
call('propose 3%', PID, 'propose-fee-bips', [Cl.uint(300)], '(ok u300)');
rd('pending 3% is visible', '(get-pending-fee)', (v) => v.includes('(fee (some u300))'));
call('confirm before 144 blocks refused (u114)', PID, 'confirm-fee-bips', [], '(err u114)');
call('outsider cannot cancel', PID, 'cancel-fee-bips', [], '(err u100)', STRANGER);
call('admin cancels', PID, 'cancel-fee-bips', [], '(ok true)');
call('cancelled fee cannot confirm (u113)', PID, 'confirm-fee-bips', [], '(err u113)');
call('propose 5%', PID, 'propose-fee-bips', [Cl.uint(FEE)], `(ok u${FEE})`);
advance(144, 'fee cooldown');
call('outsider cannot confirm', PID, 'confirm-fee-bips', [], '(err u100)', STRANGER);
call('confirm 5% at 144 blocks', PID, 'confirm-fee-bips', [], '(ok true)');
rd('fee is 5%', '(get-fee-bips)', `u${FEE}`);
rd('effective rate for a non-OG', `(get-effective-fee-bips '${B})`, `u${FEE}`);
builder.withSender(STX_WHALE).addSTXTransfer({ recipient: A, amount: Number(600n * STX) });
plan.push({ label: 'fund A 600 STX', kind: 'transfer' });
builder.withSender(DEP);
call('A stakes 500 STX and takes an OG seat', POX, 'stake',
  [Cl.contractPrincipal(DEP, POOL_NAME), Cl.uint(COVER), Cl.uint(1), Cl.uint(burn), Cl.none()], ok, A);
rd('A covers 500 STX', `(get-og-ustx '${A})`, `u${COVER}`);
rd('get-staker-fee: A taxed on 500 of 1000 STX', `(get-staker-fee '${A} u${SH} u1000000 u${FEE})`, 'u25000');
rd('get-staker-fee: B taxed on all', `(get-staker-fee '${B} u${SH} u1000000 u${FEE})`, 'u50000');
rd('get-staker-fee: zero shares owe nothing', `(get-staker-fee '${A} u0 u1000000 u${FEE})`, 'u0');

// -- 3. round 1: STX path --------------------------------------------------------
call('fund real PoX sBTC for two cycles (fork only)', SBTC, 'transfer',
  [Cl.uint(2n * FUND), Cl.principal(SBTC_WHALE), Cl.principal(POX), Cl.none()], '(ok true)', SBTC_WHALE);
fixture(R1);
rd('no claim yet for R1', `(get-last-claim-dist-cycle u${R1})`, 'none');
rd('R1 tranche count 0', `(get-tranche-count u${R1})`, 'u0');
const claim1 = call('claim R1 into the vault', PID, 'pox-claim-rewards', [Cl.list([]), Cl.uint(R1)],
  (v) => ok(v) && v.includes(`(total-rewards u${FUND})`), STRANGER);
rd('R1 claim recorded at the current distribution cycle', `(get-last-claim-dist-cycle u${R1})`, (v) => v.startsWith('(some u'));
rd('R1 tranche count 1', `(get-tranche-count u${R1})`, 'u1');
rd('pending swap is R1/0', '(get-pending-swap)', (v) => v.includes(`(reward-cycle u${R1})`) && v.includes('(tranche u0)'));
call('a second R1 claim in the same distribution cycle (u112)', PID, 'pox-claim-rewards', [Cl.list([]), Cl.uint(R1)], '(err u112)', STRANGER);
rd('unclaimed signer rewards drained', `(get-unclaimed-signer-rewards u${R1} none)`, 'u0');
call('pay before finalize refused (u115)', PID, 'pay-stx-stakers', [list(A, B), Cl.uint(R1), Cl.uint(0)], '(err u115)', STRANGER);
call('sweep before finalize refused (u115)', PID, 'sweep-tranche-dust', [Cl.uint(R1), Cl.uint(0)], '(err u115)');
call('vault rests the sBTC on Jing', VID, 'jing-place', [update], ok, STRANGER);
call('set chunk cap 50k', PID, 'set-vault-max-chunk-sats', [Cl.uint(50000)], '(ok true)');
ev('fixture: patience window elapsed', VID, '(begin (var-set batch-start (some (- burn-block-height u288))) true)', 'true');
call('reclaim from Jing', VID, 'jing-reclaim', [], ok, STRANGER);
// Live AMMs can sit ~2% under the Pyth mid; widen the floor so the sale tests the flow, not today's prices.
call('widen slippage to 10% for live AMM prices', PID, 'set-vault-slippage-bps', [Cl.uint(1000)], '(ok true)');
call('router sells chunk 1', VID, 'router-swap', [update], ok, STRANGER);
advance(1, 'router cooldown');
call('router sells chunk 2', VID, 'router-swap', [update], ok, STRANGER);
const pot1 = call('finalize R1', PID, 'finalize-swap', [], (v) => /^\(ok u[1-9]\d*\)$/.test(v), STRANGER);
const potRead1 = rd('get-stx-pot R1/0', `(get-stx-pot u${R1} u0)`, isU);
rd('cycle total shares', `(get-cycle-total-shares u${R1})`, `u${TOTAL}`);
call('outsider cannot sweep', PID, 'sweep-tranche-dust', [Cl.uint(R1), Cl.uint(0)], '(err u100)', STRANGER);
call('sweep while unpaid refused (u104)', PID, 'sweep-tranche-dust', [Cl.uint(R1), Cl.uint(0)], '(err u104)');
const pay1 = call('pay A and B', PID, 'pay-stx-stakers', [list(A, B), Cl.uint(R1), Cl.uint(0)], ok, STRANGER);
const paidA = rd('get-stx-paid A', `(get-stx-paid u${R1} u0 '${A})`, (v) => v.startsWith('(some u') || isU(v));
rd('paid shares 2000 STX', `(get-tranche-paid-shares u${R1} u0)`, `u${2n * SH}`);
rd('not fully paid while C is unpaid', `(is-tranche-fully-paid u${R1} u0)`, 'false');
call('re-paying A and B pays nothing', PID, 'pay-stx-stakers', [list(A, B), Cl.uint(R1), Cl.uint(0)], '(ok u0)', STRANGER);
rd('get-stx-owed is 0 once paid', `(get-stx-owed u${R1} u0 '${A})`, 'u0');
call('pay C (rounds to 0 STX, shares still counted)', PID, 'pay-stx-stakers', [list(C), Cl.uint(R1), Cl.uint(0)], '(ok u0)', STRANGER);
rd('fully paid', `(is-tranche-fully-paid u${R1} u0)`, 'true');
const paidT = rd('tranche paid (gross)', `(get-tranche-paid u${R1} u0)`, isU);
const resid = rd('tranche residue', `(get-tranche-residue u${R1} u0)`, (v) => isU(v) && v !== 'u0');
const sweep1 = call('admin sweeps the dust', PID, 'sweep-tranche-dust', [Cl.uint(R1), Cl.uint(0)], (v) => /^\(ok u[1-9]\d*\)$/.test(v));
rd('residue now 0', `(get-tranche-residue u${R1} u0)`, 'u0');
call('second sweep refused (u105)', PID, 'sweep-tranche-dust', [Cl.uint(R1), Cl.uint(0)], '(err u105)');
const fees1 = rd('earned STX fees', '(get-earned-fees)', isU);
call('withdraw more than earned refused (u111)', PID, 'withdraw-fees', [Cl.uint(10n ** 15n), Cl.principal(FEE_SINK)], '(err u111)');
call('outsider cannot withdraw fees', PID, 'withdraw-fees', [Cl.uint(1), Cl.principal(STRANGER)], '(err u100)', STRANGER);
call('withdraw 1 uSTX of fees', PID, 'withdraw-fees', [Cl.uint(1), Cl.principal(FEE_SINK)], '(ok u1)');
call('outsider cannot withdraw-all', PID, 'withdraw-all-fees', [Cl.principal(STRANGER)], '(err u100)', STRANGER);
const wall = call('withdraw the rest', PID, 'withdraw-all-fees', [Cl.principal(FEE_SINK)], ok);
rd('STX fees drained', '(get-earned-fees)', 'u0');
call('pox-settle-stakers updates pox-5 bookkeeping only', PID, 'pox-settle-stakers', [list(A, B), Cl.uint(R1), Cl.none()], ok, STRANGER);
rd('entitlement read', `(get-staker-entitlement '${A} u${R1} none)`, () => true);

// -- 4. round 2: recovered sBTC path ---------------------------------------------
fixture(R2);
call('claim R2', PID, 'pox-claim-rewards', [Cl.list([]), Cl.uint(R2)], (v) => ok(v) && v.includes(`(total-rewards u${FUND})`), STRANGER);
call('vault rests R2 on Jing', VID, 'jing-place', [update], ok, STRANGER);
call('recovered payout on a normal tranche refused (u116)', PID, 'pay-recovered-sbtc-stakers', [list(A), Cl.uint(R1), Cl.uint(0)], '(err u116)', STRANGER);
ev('fixture: batch aged 432 blocks', VID, '(begin (var-set batch-start (some (- burn-block-height u432))) true)', 'true');
const rec = call('anyone triggers emergency-recover', PID, 'emergency-recover', [], ok, STRANGER);
rd('R2/0 is a recovered tranche', `(is-recovered-tranche u${R2} u0)`, 'true');
const rpot = rd('recovered sBTC pot', `(get-recovered-sbtc-pot u${R2} u0)`, (v) => isU(v) && v !== 'u0');
call('recovered sweep while unpaid refused (u104)', PID, 'sweep-recovered-sbtc-dust', [Cl.uint(R2), Cl.uint(0)], '(err u104)');
const rpay = call('pay recovered sBTC to A and B', PID, 'pay-recovered-sbtc-stakers', [list(A, B), Cl.uint(R2), Cl.uint(0)], ok, STRANGER);
const rpaidA = rd('A recovered net', `(get-recovered-sbtc-paid u${R2} u0 '${A})`, (v) => v.startsWith('(some u'));
const rpaidB = rd('B recovered net', `(get-recovered-sbtc-paid u${R2} u0 '${B})`, (v) => v.startsWith('(some u'));
call('re-paying recovered pays nothing', PID, 'pay-recovered-sbtc-stakers', [list(A, B), Cl.uint(R2), Cl.uint(0)], '(ok u0)', STRANGER);
rd('recovered not fully paid', `(is-recovered-tranche-fully-paid u${R2} u0)`, 'false');
call('pay C recovered', PID, 'pay-recovered-sbtc-stakers', [list(C), Cl.uint(R2), Cl.uint(0)], '(ok u0)', STRANGER);
rd('recovered paid shares', `(get-recovered-sbtc-paid-shares u${R2} u0)`, `u${TOTAL}`);
rd('recovered fully paid', `(is-recovered-tranche-fully-paid u${R2} u0)`, 'true');
const rres = rd('recovered residue', `(get-recovered-sbtc-residue u${R2} u0)`, isU);
call('outsider cannot sweep recovered dust', PID, 'sweep-recovered-sbtc-dust', [Cl.uint(R2), Cl.uint(0)], '(err u100)', STRANGER);
const rsweep = call('admin sweeps recovered dust', PID, 'sweep-recovered-sbtc-dust', [Cl.uint(R2), Cl.uint(0)], (v) => ok(v) || v === '(err u105)');
rd('recovered residue now 0', `(get-recovered-sbtc-residue u${R2} u0)`, 'u0');
const sfees = rd('earned sBTC fees', '(get-earned-sbtc-fees)', (v) => isU(v) && v !== 'u0');
call('sBTC fee over-withdraw refused (u111)', PID, 'withdraw-sbtc-fees', [Cl.uint(10n ** 12n), Cl.principal(FEE_SINK)], '(err u111)');
call('outsider cannot withdraw sBTC fees', PID, 'withdraw-sbtc-fees', [Cl.uint(1), Cl.principal(STRANGER)], '(err u100)', STRANGER);
// Recovered sBTC is the whole claim (nothing sold), so its fees are known now.
const feeOf = (owed, shares, cover) => { const t = shares > cover ? shares - cover : 0n; return t === 0n ? 0n : (owed * FEE * t) / (MAXB * shares); };
const rOwed = FUND * SH / TOTAL, SBTC_FEES = feeOf(rOwed, SH, COVER) + feeOf(rOwed, SH, 0n);
call('withdraw all sBTC fees', PID, 'withdraw-sbtc-fees', [Cl.uint(SBTC_FEES), Cl.principal(FEE_SINK)], `(ok u${SBTC_FEES})`);
rd('sBTC fees drained', '(get-earned-sbtc-fees)', 'u0');

console.log(`fork block ${forkBlock}, burn ${info.burn_block_height}, cycle ${cycleNow} (R1 ${R1}, R2 ${R2}), ${plan.length} steps`);
const id = await builder.run();
console.log(`View: https://stxer.xyz/simulations/mainnet/${id}`);
const result = await getSimulationResult(id, { stxerApi: API });
const checks = plan.map((p, i) => {
  const step = result.steps[i]?.Result;
  let actual;
  if (p.kind === 'advance') actual = step?.AdvanceBlocks?.Ok ? 'ok' : `ENGINE ${JSON.stringify(step).slice(0, 200)}`;
  else if (p.kind === 'eval') actual = step?.Eval?.Ok !== undefined ? cvToString(deserializeCV(step.Eval.Ok)) : `ENGINE ${JSON.stringify(step).slice(0, 200)}`;
  else actual = step?.Transaction?.Ok && !step.Transaction.Ok.vm_error ? cvToString(deserializeCV(step.Transaction.Ok.result)) : `ENGINE ${JSON.stringify(step).slice(0, 300)}`;
  const passed = p.kind === 'advance' ? actual === 'ok'
    : p.kind === 'deploy' || p.kind === 'transfer' ? !actual.startsWith('ENGINE')
    : typeof p.want === 'function' ? p.want(actual) : actual === p.want;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${p.label}: ${actual.slice(0, 220)}`);
  return { label: p.label, passed, actual };
});

const a = (i) => checks[i].actual;
const num = (s) => BigInt(s.match(/u(\d+)/)?.[1] ?? '-1');
const fee = (owed, shares, cover) => { const t = shares > cover ? shares - cover : 0n; return t === 0n ? 0n : (owed * FEE * t) / (MAXB * shares); };
// Round 1 expectations from the real pot.
const P1 = num(a(pot1)), oA = P1 * SH / TOTAL, oB = oA, oC = P1 * C_SH / TOTAL;
const fA = fee(oA, SH, COVER), fB = fee(oB, SH, 0n);
// Round 2 expectations from the recovered pot.
const P2 = num(a(rpot)), rA = P2 * SH / TOTAL, rfA = fee(rA, SH, COVER), rfB = fee(rA, SH, 0n);
const extra = [
  ['R1 pot read matches finalize', num(a(potRead1)) === P1, `${a(potRead1)} vs ${P1}`],
  ['R1 A paid owed minus 5% on its uncovered half', num(a(paidA)) === oA - fA, `${a(paidA)} vs ${oA - fA}`],
  ['R1 pay A+B total = both nets', num(a(pay1)) === (oA - fA) + (oB - fB), `${a(pay1)} vs ${(oA - fA) + (oB - fB)}`],
  ['R1 tranche paid = gross of all three', num(a(paidT)) === oA + oB + oC, `${a(paidT)} vs ${oA + oB + oC}`],
  ['R1 residue = pot - gross paid, swept exactly', num(a(resid)) === P1 - (oA + oB + oC) && num(a(sweep1)) === num(a(resid)), `${a(resid)} / ${a(sweep1)}`],
  ['R1 fees earned = A + B fees', num(a(fees1)) === fA + fB, `${a(fees1)} vs ${fA + fB}`],
  ['R1 withdraw-all returns the rest', num(a(wall)) === fA + fB - 1n, `${a(wall)} vs ${fA + fB - 1n}`],
  ['R2 recovered pot is the whole claim', P2 === FUND, `${P2} vs ${FUND}`],
  ['R2 A sBTC net: 5% only on uncovered half', num(a(rpaidA)) === rA - rfA, `${a(rpaidA)} vs ${rA - rfA}`],
  ['R2 B sBTC net: full 5%', num(a(rpaidB)) === rA - rfB, `${a(rpaidB)} vs ${rA - rfB}`],
  ['R2 sBTC fees = A + B fees', num(a(sfees)) === rfA + rfB, `${a(sfees)} vs ${rfA + rfB}`],
];
for (const [label, passed, actual] of extra) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}: ${actual}`);
  checks.push({ label, passed, actual });
}
const failed = checks.filter((c) => !c.passed).length;
const dir = resolve(directory, 'results/pool-vault-stx'); mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'juice-pool-accounting.json'), JSON.stringify({ id, url: `https://stxer.xyz/simulations/mainnet/${id}`, block: forkBlock, cycle: cycleNow, sourceHashes, checks }, null, 2));
console.log(`\n=== ${checks.length - failed}/${checks.length} passed ===\nView: https://stxer.xyz/simulations/mainnet/${id}`);
if (failed) process.exit(1);
