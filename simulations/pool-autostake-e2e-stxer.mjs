// End to end on a mainnet fork: juice-pool-sbtc-signer pays STX into a
// juice-autostake-safe, and the keeper restakes it.
//
// Everything is the exact repo source, deployed under production names:
//   Jing v6-3 stack (_jing-v6-3.mjs), juice-sbtc-autoswap, juice-pool-sbtc-signer,
//   juice-autostake-safe-auth-helpers-v1 and juice-autostake-safe (read from
//   ~/projects/pillar/contracts/pillar-wallets, unchanged: the pool it names
//   exists in this fork at its real address).
//
// Real, not fixtures: signer registration (register-self with a generated key
// over pox-5's own grant hash), the safe's stake (pox-5 stake through the pool's
// validate-stake!), STX locks, the vault's Jing placement / reclaim / router
// sale, finalize, pay-stx-stakers, and both restakes.
// Fixture (same as the pool suite): the earned-reward state of the previous
// cycle, with the safe as a third staker (Alice 1, Bob 3, safe 4 shares).
//
// Run: node simulations/pool-autostake-e2e-stxer.mjs
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJingStack } from './_jing-v6-3.mjs';
import { POOL_NAME, VAULT_NAME, juiceSource, juiceForkBlock, traitSource, JUICE_LIVE, verifyLiveJuice } from './_juice-fork.mjs';
import { withVaultArgument } from './_pool-vault-interface.mjs';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'));
const { SimulationBuilder, getSimulationResult } = require('stxer');
const {
  Cl, ClarityVersion, deserializeCV, cvToString, serializeCV,
  getAddressFromPrivateKey, randomPrivateKey, privateKeyToPublic, signMessageHashRsv,
} = require('@stacks/transactions');

const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';           // pool admin + default keeper
const FAKFUN_DEPLOYER = 'SP28MP1HQDJWQAFSQJN2HBAXBVP7H7THD1W2NYZVK';
const OWNER = 'SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2';
const RECOVERY = 'SP3HXJJMJQ06GNAZ8XWDN1QM48JEDC6PP6W3YZPZJ';
const STRANGER = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const STX_WHALE = 'SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51';
const SBTC_WHALE = 'SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1';
const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const API = process.env.STXER_API_URL || 'https://api.stxer.xyz';
const POX = 'SP000000000000000000002Q6VF78.pox-5';
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const CORE = `${DEP}.fakfun-wallet-core-v2`;
const PID = `${DEP}.${POOL_NAME}`, VID = `${DEP}.${VAULT_NAME}`;
const SAFE_NAME = 'juice-autostake-safe', HELPER_NAME = 'juice-autostake-safe-auth-helpers-v1';
const SAFE = `${DEP}.${SAFE_NAME}`;
const PILLAR = resolve(process.env.HOME, 'projects/pillar/contracts/pillar-wallets/contracts');
const CLARITY_6 = ClarityVersion.Clarity6 ?? 6;
const FIRST_BURN = 666050, CYCLE = 2100;
const STAKE = 2_000_000_000;      // the safe stakes everything it holds
const SECOND_PAYOUT = 25_000_000; // a later payout, next cycle
const FUND = 100000;              // sats of earned reward in the fixture

const ALICE = getAddressFromPrivateKey('7'.repeat(64) + '01', 'mainnet');
const BOB = getAddressFromPrivateKey('8'.repeat(64) + '01', 'mainnet');

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

// Signer key: pox-5 only needs the signature to recover to the key we register.
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
const rewardCycle = Number(deserializeCV(await readOnly(POX, 'current-pox-reward-cycle')).value) - 1;

const builder = SimulationBuilder.new({ stacksNodeAPI: NODE, apiEndpoint: API, skipTracing: !process.env.STXER_TRACE })
  .useBlockHeight(forkBlock).withSender(DEP);
const plan = [], sourceHashes = {};
appendJingStack(builder, plan, sourceHashes, forkBlock);
const deployJuice = (name, path) => {
  const j = juiceSource(path.endsWith('juice-sbtc-autoswap.clar') ? 'juice-sbtc-autoswap' : 'juice-pool-sbtc-signer', path, sourceHashes);
  builder.addContractDeploy({ contract_name: j.name, source_code: j.source, clarity_version: ClarityVersion.Clarity6 });
  plan.push({ label: `deploy ${j.name} (repo source)`, kind: 'deploy' });
};
const deployFile = (name, path, version) => {
  const source = readFileSync(path, 'utf8');
  sourceHashes[name] = createHash('sha256').update(source).digest('hex');
  builder.addContractDeploy({ contract_name: name, source_code: source, clarity_version: version });
  plan.push({ label: `deploy ${name} (pillar-wallets source, unchanged)`, kind: 'deploy' });
};
const call = (label, id, fn, args, want, sender = DEP) => {
  builder.addContractCall({ contract_id: id, function_name: fn, function_args: withVaultArgument(PID, VID, id, fn, args, Cl), sender });
  plan.push({ label, kind: 'tx', want });
  return plan.length - 1;
};
const ev = (label, id, code, want) => { builder.addEvalCode(id, code); plan.push({ label, kind: 'eval', want }); return plan.length - 1; };
const advance = (n, label) => {
  builder.addAdvanceBlocks({ bitcoin_blocks: n, stacks_blocks_per_bitcoin: 1, bitcoin_interval_secs: 1 });
  burn += n;
  plan.push({ label: `${label}: advance ${n} burn blocks -> offset ${(burn - FIRST_BURN) % CYCLE}`, kind: 'advance' });
};
const ok = (v) => v.startsWith('(ok');
const uintIn = (field) => (v) => BigInt((v.match(new RegExp(`${field} u(\\d+)`)) || [])[1] ?? '-1');

// -- 1. contracts --------------------------------------------------------------
if (JUICE_LIVE) await verifyLiveJuice(NODE, sourceHashes); // live trait, vault, pool at DEP
else {
const trait = traitSource(sourceHashes);
builder.addContractDeploy({ contract_name: trait.name, source_code: trait.source, clarity_version: ClarityVersion.Clarity6 });
plan.push({ label: `deploy ${trait.name} (repo source, new trait)`, kind: 'deploy' });
deployJuice(VAULT_NAME, fileURLToPath(new URL('../contracts/pox-5/juice-sbtc-autoswap.clar', import.meta.url)));
deployJuice(POOL_NAME, fileURLToPath(new URL('../contracts/pox-5/juice-pool-sbtc-signer.clar', import.meta.url)));
}
call('register the pool as a pox-5 signer (real grant path)', PID, 'register-self',
  [Cl.contractPrincipal(DEP, POOL_NAME), Cl.buffer(Buffer.from(signerKey.replace(/^0x/, ''), 'hex')),
   Cl.uint(AUTH_ID), Cl.buffer(Buffer.from(signerSig.replace(/^0x/, ''), 'hex'))], ok);
ev('pox-5 knows the signer', POX, `(get-signer-info '${PID})`, (v) => v.startsWith('(some'));
// Live: the helper (block 9219792) and the safe (9219793) are on mainnet, not
// onboarded; their bytes equal the pillar files modulo comments and whitespace.
for (const [name, version] of [[HELPER_NAME, ClarityVersion.Clarity4], [SAFE_NAME, CLARITY_6]]) {
  const live = JUICE_LIVE && (await fetch(`${NODE}/v2/contracts/interface/${DEP}/${name}`, { signal: AbortSignal.timeout(20000) })).ok;
  if (live) sourceHashes[`live:${name}`] = 'on mainnet';
  else deployFile(name, `${PILLAR}/${name}.clar`, version);
}
ev('the deployed safe names this pool', SAFE, '(get-keeper)', (v) => v.includes(DEP));
call('core-v2 verifies the safe', CORE, 'set-verified-contract', [Cl.principal(SAFE), Cl.none()], ok);
builder.withSender(STX_WHALE).addSTXTransfer({ recipient: SAFE, amount: STAKE });
plan.push({ label: `fund the safe ${STAKE / 1e6} STX`, kind: 'transfer' });
builder.withSender(DEP);
call('onboard the safe', SAFE, 'onboard',
  [Cl.buffer(Buffer.from('02' + 'ab'.repeat(32), 'hex')), Cl.principal(OWNER), Cl.principal(RECOVERY),
   Cl.uint(100_000_000), Cl.uint(100_000), Cl.uint(144)], ok, FAKFUN_DEPLOYER);

// Stake outside the prepare phase.
if ((burn - FIRST_BURN) % CYCLE > 1950) advance(CYCLE - ((burn - FIRST_BURN) % CYCLE) + 20, 'leave the prepare phase');
call('owner stakes all 2000 STX with juice-pool-sbtc-signer (real pox-5 stake)', SAFE, 'stake-stx-juice',
  [Cl.uint(STAKE), Cl.none(), Cl.none(), Cl.none()], ok, OWNER); // amount, sig-auth, gas, signer-calldata
ev('pox-5 position names juice-pool-sbtc-signer', POX, `(get-staker-info '${SAFE})`,
  (v) => v.includes(PID) && v.includes(`amount-ustx u${STAKE}`));
ev('all 2000 STX locked, 0 unlocked', POX, `(stx-account '${SAFE})`,
  (v) => uintIn('locked')(v) === BigInt(STAKE) && uintIn('unlocked')(v) === 0n);
call('nothing landed yet: keeper restake refused (u4026)', SAFE, 'restake', [], '(err u4026)');

// -- 2. a real reward round through the pool and vault -------------------------
call('fund real PoX sBTC balance (fork only)', SBTC, 'transfer',
  [Cl.uint(FUND), Cl.principal(SBTC_WHALE), Cl.principal(POX), Cl.none()], '(ok true)', SBTC_WHALE);
const key = `{ reward-cycle: u${rewardCycle}, bond-index: none, signer: '${PID} }`;
const share = (who, n) => `(map-set staker-shares-staked-for-cycle { reward-cycle: u${rewardCycle}, bond-index: none, signer: '${PID}, staker: '${who} } u${n})`;
ev('fixture: earned rewards, shares Alice 1 / Bob 3 / safe 4', POX, `(begin
  (map-set signer-shares-staked-for-cycle ${key} u8)
  (map-set signer-pending-staked-ustx-per-cycle { signer: '${PID}, cycle: u${rewardCycle} } u8)
  (map-set signer-rewards-per-token-settled-for-cycle ${key} (get-rewards-per-token-for-cycle u${rewardCycle} none))
  (map-set signer-unclaimed-rewards-for-cycle ${key} u${FUND})
  ${share(ALICE, 1)} ${share(BOB, 3)} ${share(SAFE, 4)}
  (var-set last-accounted-rewards-only (+ (var-get last-accounted-rewards-only) u${FUND}))
  (ok true))`, '(ok true)');
call('pool claims the sBTC into the vault', PID, 'pox-claim-rewards', [Cl.list([]), Cl.uint(rewardCycle)],
  (v) => ok(v) && v.includes(`(total-rewards u${FUND})`), STRANGER);
call('vault rests the sBTC on Jing', VID, 'jing-place', [update], (v) => ok(v) && v.includes(`(amount u${FUND})`), STRANGER);
call('set chunk cap 50k (two router chunks)', PID, 'set-vault-max-chunk-sats', [Cl.uint(50000)], '(ok true)');
ev('fixture: patience window elapsed', VID, '(begin (var-set batch-start (some (- burn-block-height u288))) true)', 'true');
call('reclaim from Jing', VID, 'jing-reclaim', [], ok, STRANGER);
call('router sells chunk 1 (50k sats -> STX)', VID, 'router-swap', [update], (v) => ok(v) && v.includes('(amount u50000)'), STRANGER);
advance(1, 'router cooldown');
call('router sells chunk 2', VID, 'router-swap', [update], (v) => ok(v) && v.includes('(amount u50000)'), STRANGER);
const finalSlot = call('finalize: the STX pot', PID, 'finalize-swap', [], (v) => /^\(ok u[1-9]\d*\)$/.test(v), STRANGER);
const safeBefore = ev('safe unlocked STX before payout', POX, `(stx-account '${SAFE})`, (v) => uintIn('unlocked')(v) === 0n);
call('pay-stx-stakers pays Alice, Bob and the safe in STX', PID, 'pay-stx-stakers',
  [Cl.list([Cl.principal(ALICE), Cl.principal(BOB), Cl.principal(SAFE)]), Cl.uint(rewardCycle), Cl.uint(0)], ok, STRANGER);
const safeAfter = ev('safe unlocked STX after payout', POX, `(stx-account '${SAFE})`, (v) => uintIn('unlocked')(v) > 0n);

// -- 3. the keeper restakes the payout ------------------------------------------
call('a stranger cannot restake (u4001)', SAFE, 'restake', [], '(err u4001)', STRANGER);
const restake1 = call('keeper restakes exactly the payout, extend 0', SAFE, 'restake', [],
  (v) => ok(v) && v.includes('(cycles-to-extend u0)'));
const lock1 = ev('the payout is locked, nothing unlocked', POX, `(stx-account '${SAFE})`, (v) => uintIn('unlocked')(v) === 0n);
const info1 = ev('pox-5 amount grew, still with the pool', POX, `(get-staker-info '${SAFE})`, (v) => v.includes(PID));

// -- 4. next cycle: second payout + the roll -----------------------------------
advance(CYCLE - ((burn - FIRST_BURN) % CYCLE) + 20, 'into the next cycle');
builder.withSender(STX_WHALE).addSTXTransfer({ recipient: SAFE, amount: SECOND_PAYOUT });
plan.push({ label: `a second payout of ${SECOND_PAYOUT / 1e6} STX lands`, kind: 'transfer' });
builder.withSender(DEP);
const act0 = ev('safe last-activity before the keeper restake', SAFE, '(var-get last-activity-block)', (v) => /^u\d+$/.test(v));
const restake2 = call('keeper restakes it and rolls the lock: extend 1', SAFE, 'restake', [],
  (v) => v === `(ok (tuple (amount u${SECOND_PAYOUT}) (cycles-to-extend u1)))`);
const info2 = ev('pox-5 position after the roll', POX, `(get-staker-info '${SAFE})`, (v) => v.includes(PID));
const cyc2 = ev('current cycle', POX, '(current-pox-reward-cycle)', (v) => /^u\d+$/.test(v));
const act1 = ev('safe last-activity after the keeper restake', SAFE, '(var-get last-activity-block)', (v) => /^u\d+$/.test(v));

// -- 5. set-keeper, then unstake ------------------------------------------------
const NEW_KEEPER = STRANGER, OUTSIDER = getAddressFromPrivateKey('9'.repeat(64) + '01', 'mainnet');
call('a stranger cannot set the keeper (u4001)', SAFE, 'set-keeper', [Cl.principal(OUTSIDER), Cl.none(), Cl.none()], '(err u4001)', OUTSIDER);
call('the owner sets a new keeper', SAFE, 'set-keeper', [Cl.principal(NEW_KEEPER), Cl.none(), Cl.none()], ok, OWNER);
ev('get-keeper is the new keeper', SAFE, '(get-keeper)', NEW_KEEPER);
builder.withSender(STX_WHALE).addSTXTransfer({ recipient: SAFE, amount: 1_000_000 });
plan.push({ label: 'a third payout of 1 STX lands', kind: 'transfer' });
builder.withSender(DEP);
call('the old keeper is refused (u4001)', SAFE, 'restake', [], '(err u4001)');
call('the new keeper restakes the 1 STX', SAFE, 'restake', [], (v) => ok(v) && v.includes('(amount u1000000)'), NEW_KEEPER);
call('the owner unstakes', SAFE, 'unstake', [Cl.none(), Cl.none()], ok, OWNER);
builder.withSender(STX_WHALE).addSTXTransfer({ recipient: SAFE, amount: 1_000_000 });
plan.push({ label: 'another 1 STX lands after the unstake', kind: 'transfer' });
builder.withSender(DEP);
call('the keeper cannot re-lock a leaving safe (u4040)', SAFE, 'restake', [], '(err u4040)', NEW_KEEPER);

console.log(`fork block ${forkBlock}, burn ${info.burn_block_height}, reward cycle fixture ${rewardCycle}, ${plan.length} steps`);
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
const pot = BigInt(a(finalSlot).match(/u(\d+)/)?.[1] ?? '-1');
const safeShare = pot * 4n / 8n;
const paid = uintIn('unlocked')(a(safeAfter)) - uintIn('unlocked')(a(safeBefore));
const restaked = uintIn('amount')(a(restake1));
const amt1 = uintIn('amount-ustx')(a(info1)), amt2 = uintIn('amount-ustx')(a(info2));
const unlock2 = uintIn('first-reward-cycle')(a(info2)) + uintIn('num-cycles')(a(info2));
const extra = [
  ['the pool paid the safe its 4/8 share of the STX pot (the safe is an OG: 0% fee)', paid === safeShare, `${paid} vs ${safeShare}`],
  ['restake staked exactly what the pool paid', restaked === paid, `${restaked} vs ${paid}`],
  ['pox-5 amount = stake + first payout', amt1 === BigInt(STAKE) + paid, `${amt1}`],
  ['locked = stake + first payout', uintIn('locked')(a(lock1)) === BigInt(STAKE) + paid, a(lock1)],
  ['pox-5 amount = stake + both payouts', amt2 === BigInt(STAKE) + paid + BigInt(SECOND_PAYOUT), `${amt2}`],
  ['after the roll the unlock is current + 1 + 96', unlock2 === BigInt(a(cyc2).slice(1)) + 97n, `${unlock2} vs ${a(cyc2)}`],
  ['the keeper restake did not touch last-activity (recovery clock)', a(act0) === a(act1), `${a(act0)} -> ${a(act1)}`],
];
for (const [label, passed, actual] of extra) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}: ${actual}`);
  checks.push({ label, passed, actual });
}
const failed = checks.filter((c) => !c.passed).length;
const resultDir = resolve(dirname(fileURLToPath(import.meta.url)), 'results/pool-vault-stx'); mkdirSync(resultDir, { recursive: true });
writeFileSync(resolve(resultDir, 'juice-autostake-e2e.json'), JSON.stringify({ id, url: `https://stxer.xyz/simulations/mainnet/${id}`, block: forkBlock, rewardCycle, sourceHashes, checks }, null, 2));
console.log(`\n=== ${checks.length - failed}/${checks.length} passed ===\nView: https://stxer.xyz/simulations/mainnet/${id}`);
if (failed) process.exit(1);
