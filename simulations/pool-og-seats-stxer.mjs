// OG seats and channel refs on a mainnet fork: juice-pool-sbtc-signer.
//
// Real, not fixtures: signer registration, every stake and stake-update
// (pox-5 calling the pool's validate-stake!), the fee timelock, the vault's
// Jing placement / reclaim / router sale, finalize and pay-stx-stakers.
// Fixture: the earned-reward state of the previous cycle (an OG with 1000 STX
// of shares, 700 covered, and a non-OG with 1000), same shape as the pool suite.
//
// Checks: a seat for any stake (no minimum), top-ups grow the seat, partial fee
// at payout, and the ?ref= calldata print. Seats come only from staking in (no admin grant). The cap clamp and
// 21-seat limit need ~11k STX of real stakes, more than the fork whales hold:
// the local harness (tests/vault/runtime.mjs) covers them; the deadline and
// the raise-only window/cap are in pool-og-deadline-stxer.mjs.
//
// Run: node simulations/pool-og-seats-stxer.mjs
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
const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const API = process.env.STXER_API_URL || 'https://api.stxer.xyz';
const POX = 'SP000000000000000000002Q6VF78.pox-5';
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const PID = `${DEP}.${POOL_NAME}`, VID = `${DEP}.${VAULT_NAME}`;
const FIRST_BURN = 666050, CYCLE = 2100;
const STX = 1_000_000n;
const FUND = 100000; // sats of earned reward in the fixture
const FEE_BIPS = 500n;

const acct = (d) => getAddressFromPrivateKey(d.repeat(64) + '01', 'mainnet');
const UNDER = acct('1'), OG1 = acct('2'), PAYER = acct('3');

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
const rewardCycle = cycleNow - 1;


const builder = SimulationBuilder.new({ stacksNodeAPI: NODE, apiEndpoint: API, skipTracing: !process.env.STXER_TRACE })
  .useBlockHeight(forkBlock).withSender(DEP);
const plan = [], sourceHashes = {};
appendJingStack(builder, plan, sourceHashes, forkBlock);
const call = (label, id, fn, args, want, sender = DEP, extra = {}) => {
  builder.addContractCall({ contract_id: id, function_name: fn, function_args: withVaultArgument(PID, VID, id, fn, args, Cl), sender });
  plan.push({ label, kind: 'tx', want, ...extra });
  return plan.length - 1;
};
const ev = (label, id, code, want) => { builder.addEvalCode(id, code); plan.push({ label, kind: 'eval', want }); return plan.length - 1; };
const advance = (n, label) => {
  builder.addAdvanceBlocks({ bitcoin_blocks: n, stacks_blocks_per_bitcoin: 1, bitcoin_interval_secs: 1 });
  burn += n;
  plan.push({ label: `${label}: advance ${n} burn blocks -> cycle offset ${(burn - FIRST_BURN) % CYCLE}`, kind: 'advance' });
};
const fund = (who, ustx) => {
  builder.withSender(STX_WHALE).addSTXTransfer({ recipient: who, amount: Number(ustx) });
  plan.push({ label: `fund ${who.slice(0, 8)}… ${ustx / STX} STX`, kind: 'transfer' });
  builder.withSender(DEP);
};
const ok = (v) => v.startsWith('(ok');
const isOg = (label, who, want) => ev(label, PID, `(is-og '${who})`, String(want));
const ogUstx = (label, who, want) => ev(label, PID, `(get-og-ustx '${who})`, `u${want}`);
const stake = (label, who, ustx, ref, want = ok) => call(label, POX, 'stake',
  [Cl.contractPrincipal(DEP, POOL_NAME), Cl.uint(ustx), Cl.uint(96), Cl.uint(burn),
   ref ? Cl.some(Cl.bufferFromUtf8(ref)) : Cl.none()], want, who, { ref });
const stakeUpdate = (label, who, increase, want = ok) => call(label, POX, 'stake-update',
  [Cl.contractPrincipal(DEP, POOL_NAME), Cl.contractPrincipal(DEP, POOL_NAME), Cl.uint(0), Cl.uint(increase), Cl.none()], want, who);

// -- 1. contracts --------------------------------------------------------------
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
call('register the pool as a pox-5 signer (real grant path)', PID, 'register-self',
  [Cl.contractPrincipal(DEP, POOL_NAME), Cl.buffer(Buffer.from(signerKey.replace(/^0x/, ''), 'hex')),
   Cl.uint(AUTH_ID), Cl.buffer(Buffer.from(signerSig.replace(/^0x/, ''), 'hex'))], ok);
ev('OG status starts empty', PID, '(get-og-status)', (v) => v.includes('(seats u0)') && v.includes('(covered-ustx u0)'));
for (const [who, amt] of [[UNDER, 700n * STX], [OG1, 800n * STX], [PAYER, 600n * STX]]) fund(who, amt);
if ((burn - FIRST_BURN) % CYCLE > 1950) advance(CYCLE - ((burn - FIRST_BURN) % CYCLE) + 20, 'leave the prepare phase');

// -- 2. stake-in seats ---------------------------------------------------------
const refSlot = stake('499 STX stake with ?ref=telegram goes through', UNDER, 499n * STX, 'telegram');
isOg('499 STX takes a seat: no minimum', UNDER, true);
ogUstx('covers 499 STX', UNDER, 499n * STX);
stakeUpdate('top-up +100 STX (position 599)', UNDER, 100n * STX);
ogUstx('top-up grows the seat to 599 (pox-5 passes the new total)', UNDER, 599n * STX);
stake('600 STX stake takes a seat', OG1, 600n * STX, null);
isOg('600 STX staker is an OG', OG1, true);
ogUstx('covers exactly 600 STX', OG1, 600n * STX);
stakeUpdate('OG top-up +100 STX', OG1, 100n * STX);
ogUstx('top-up grows the seat to 700', OG1, 700n * STX);

ev('2 seats, 1,299 STX covered', PID, '(get-og-status)', (v) => v.includes('(seats u2)') && v.includes(`(covered-ustx u${1299n * STX})`));

// -- 3. fee timelock + a real payout -------------------------------------------
call('propose 5% fee', PID, 'propose-fee-bips', [Cl.uint(FEE_BIPS)], `(ok u${FEE_BIPS})`);
advance(144, 'fee cooldown');
call('confirm 5% fee', PID, 'confirm-fee-bips', [], '(ok true)');
call('fund real PoX sBTC balance (fork only)', SBTC, 'transfer',
  [Cl.uint(FUND), Cl.principal(SBTC_WHALE), Cl.principal(POX), Cl.none()], '(ok true)', SBTC_WHALE);
const key = `{ reward-cycle: u${rewardCycle}, bond-index: none, signer: '${PID} }`;
const share = (who, n) => `(map-set staker-shares-staked-for-cycle { reward-cycle: u${rewardCycle}, bond-index: none, signer: '${PID}, staker: '${who} } u${n})`;
const SH = 1000n * STX;
ev('fixture: earned rewards, shares OG1 1000 STX / PAYER 1000 STX', POX, `(begin
  (map-set signer-shares-staked-for-cycle ${key} u${2n * SH})
  (map-set signer-pending-staked-ustx-per-cycle { signer: '${PID}, cycle: u${rewardCycle} } u${2n * SH})
  (map-set signer-rewards-per-token-settled-for-cycle ${key} (get-rewards-per-token-for-cycle u${rewardCycle} none))
  (map-set signer-unclaimed-rewards-for-cycle ${key} u${FUND})
  ${share(OG1, SH)} ${share(PAYER, SH)}
  (var-set last-accounted-rewards-only (+ (var-get last-accounted-rewards-only) u${FUND}))
  (ok true))`, '(ok true)');
call('pool claims the sBTC into the vault', PID, 'pox-claim-rewards', [Cl.list([]), Cl.uint(rewardCycle)],
  (v) => ok(v) && v.includes(`(total-rewards u${FUND})`), STRANGER);
call('vault rests the sBTC on Jing', VID, 'jing-place', [update], ok, STRANGER);
call('set chunk cap 50k', PID, 'set-vault-max-chunk-sats', [Cl.uint(50000)], '(ok true)');
ev('fixture: patience window elapsed', VID, '(begin (var-set batch-start (some (- burn-block-height u288))) true)', 'true');
call('reclaim from Jing', VID, 'jing-reclaim', [], ok, STRANGER);
// Live AMMs can sit ~2% under the Pyth mid; widen the floor so the sale tests the flow, not today's prices.
call('widen slippage to 10% for live AMM prices', PID, 'set-vault-slippage-bps', [Cl.uint(1000)], '(ok true)');
call('router sells chunk 1', VID, 'router-swap', [update], ok, STRANGER);
advance(1, 'router cooldown');
call('router sells chunk 2', VID, 'router-swap', [update], ok, STRANGER);
const potSlot = call('finalize: the STX pot', PID, 'finalize-swap', [], (v) => /^\(ok u[1-9]\d*\)$/.test(v), STRANGER);
const owedOg = ev('OG1 owed (net view)', PID, `(get-stx-owed u${rewardCycle} u0 '${OG1})`, (v) => /^u\d+$/.test(v));
const owedPayer = ev('PAYER owed (net view)', PID, `(get-stx-owed u${rewardCycle} u0 '${PAYER})`, (v) => /^u\d+$/.test(v));
const paySlot = call('pay-stx-stakers pays both', PID, 'pay-stx-stakers',
  [Cl.list([Cl.principal(OG1), Cl.principal(PAYER)]), Cl.uint(rewardCycle), Cl.uint(0)], ok, STRANGER);
const feesSlot = ev('earned fees', PID, '(get-earned-fees)', (v) => /^u\d+$/.test(v));

console.log(`fork block ${forkBlock}, burn ${info.burn_block_height}, cycle ${cycleNow}, ${plan.length} steps`);
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
// The ref rides pox-5 -> validate-stake! and is printed by the pool.
const printed = (slot) => (result.steps[slot]?.Result?.Transaction?.Ok?.events ?? []).map((raw) => typeof raw === 'string' ? JSON.parse(raw) : raw)
  .filter((e) => e.type === 'contract_event' && e.contract_event?.contract_identifier === PID && e.committed)
  .map((e) => cvToString(deserializeCV(e.contract_event.raw_value)));
const refHex = Buffer.from('telegram').toString('hex');
const pot = num(a(potSlot)), half = pot / 2n;
const ogFee = half * FEE_BIPS * 300n / (10000n * 1000n), payerFee = half * FEE_BIPS / 10000n;
const extra = [
  ['?ref=telegram printed on-chain in validate-stake', printed(refSlot).some((s) => s.includes('validate-stake') && s.includes(refHex)), printed(refSlot).join(' | ').slice(0, 300)],
  ['OG1 pays 5% only on the 300 STX above its 700 cover (grown by top-up)', num(a(owedOg)) === half - ogFee, `${a(owedOg)} vs ${half - ogFee}`],
  ['PAYER pays the full 5%', num(a(owedPayer)) === half - payerFee, `${a(owedPayer)} vs ${half - payerFee}`],
  ['earned fees = both fees', num(a(feesSlot)) === ogFee + payerFee, `${a(feesSlot)} vs ${ogFee + payerFee}`],
];
for (const [label, passed, actual] of extra) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}: ${actual}`);
  checks.push({ label, passed, actual });
}
const failed = checks.filter((c) => !c.passed).length;
const dir = resolve(directory, 'results/pool-vault-stx'); mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'juice-og-seats.json'), JSON.stringify({ id, url: `https://stxer.xyz/simulations/mainnet/${id}`, block: forkBlock, cycle: cycleNow, sourceHashes, checks }, null, 2));
console.log(`\n=== ${checks.length - failed}/${checks.length} passed ===\nView: https://stxer.xyz/simulations/mainnet/${id}`);
if (failed) process.exit(1);
