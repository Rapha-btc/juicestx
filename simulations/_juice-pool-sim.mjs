// Shared mainnet-fork setup for the juice-pool-sbtc-signer branch sims:
// Jing v6-3 stack + repo vault + repo pool, a real signer registration, and
// step helpers. `run` submits, prints PASS/FAIL per step plus any `extra`
// checks, writes results/pool-vault-stx/<name>.json and exits non-zero on a fail.
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
export const T = require('@stacks/transactions');
const { Cl, ClarityVersion, deserializeCV, cvToString, serializeCV,
  getAddressFromPrivateKey, randomPrivateKey, privateKeyToPublic, signMessageHashRsv } = T;

export const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
export const STRANGER = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
export const STX_WHALE = 'SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51';
export const SBTC_WHALE = 'SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1';
export const POX = 'SP000000000000000000002Q6VF78.pox-5';
export const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
export const PID = `${DEP}.${POOL_NAME}`, VID = `${DEP}.${VAULT_NAME}`;
export const FIRST_BURN = 666050, CYCLE = 2100;
export const STX = 1_000_000n;
const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const API = process.env.STXER_API_URL || 'https://api.stxer.xyz';

export const acct = (d) => getAddressFromPrivateKey(d.repeat(64) + '01', 'mainnet');
export const ok = (v) => v.startsWith('(ok');
export const isU = (v) => /^u\d+$/.test(v);
export const num = (s) => BigInt(s.match(/u(\d+)/)?.[1] ?? '-1');

async function readOnly(id, fn, args = []) {
  const [a, n] = id.split('.');
  const r = await fetch(`${NODE}/v2/contracts/call-read/${a}/${n}/${fn}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sender: DEP, arguments: args.map((cv) => '0x' + serializeCV(cv).replace(/^0x/, '')) }),
  });
  const body = await r.json();
  if (!body.okay) throw new Error(`${fn}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.result;
}

export async function poolSim({ lazer = false } = {}) {
  const forkBlock = await juiceForkBlock(NODE);
  const info = await (await fetch(`${NODE}/v2/info`)).json();
  const cycleNow = Number(deserializeCV(await readOnly(POX, 'current-pox-reward-cycle')).value);
  const AUTH_ID = 7, privKey = randomPrivateKey(), signerKey = privateKeyToPublic(privKey);
  const grantHex = await readOnly(POX, 'get-signer-grant-message-hash', [Cl.contractPrincipal(DEP, POOL_NAME), Cl.uint(AUTH_ID)]);
  const signerSig = signMessageHashRsv({ messageHash: grantHex.replace(/^0x/, '').slice(2 + 8), privateKey: privKey });
  let update = null;
  if (lazer) {
    const { fetchLazerUpdateAny } = await import('./_pool-vault-lazer.mjs');
    update = Cl.buffer(Buffer.from((await fetchLazerUpdateAny()).hex.replace(/^0x/, ''), 'hex'));
  }
  const builder = SimulationBuilder.new({ stacksNodeAPI: NODE, apiEndpoint: API, skipTracing: !process.env.STXER_TRACE })
    .useBlockHeight(forkBlock).withSender(DEP);
  const plan = [], sourceHashes = {};
  const s = { builder, plan, forkBlock, cycleNow, burn: info.burn_block_height, update };
  appendJingStack(builder, plan, sourceHashes, forkBlock);
  s.call = (label, id, fn, args, want, sender = DEP) => {
    builder.addContractCall({ contract_id: id, function_name: fn, function_args: withVaultArgument(PID, VID, id, fn, args, Cl), sender });
    plan.push({ label, kind: 'tx', want }); return plan.length - 1;
  };
  // No vault auto-append: for passing a vault other than the repo one.
  s.raw = (label, id, fn, args, want, sender = DEP) => {
    builder.addContractCall({ contract_id: id, function_name: fn, function_args: args, sender });
    plan.push({ label, kind: 'tx', want }); return plan.length - 1;
  };
  s.ev = (label, id, code, want) => { builder.addEvalCode(id, code); plan.push({ label, kind: 'eval', want }); return plan.length - 1; };
  s.rd = (label, code, want) => s.ev(label, PID, code, want);
  s.offset = () => (s.burn - FIRST_BURN) % CYCLE;
  s.advance = (n, label) => {
    builder.addAdvanceBlocks({ bitcoin_blocks: n, stacks_blocks_per_bitcoin: 1, bitcoin_interval_secs: 1 });
    s.burn += n; plan.push({ label: `${label}: advance ${n} burn blocks -> offset ${s.offset()}`, kind: 'advance' });
  };
  // Into `target`, 20 blocks past its start (clear of the prepare phase).
  s.toCycle = (target, label) => s.advance((target - s.cycle()) * CYCLE - s.offset() + 20, label);
  s.cycle = () => Math.floor((s.burn - FIRST_BURN) / CYCLE);
  s.fund = (who, ustx) => {
    builder.withSender(STX_WHALE).addSTXTransfer({ recipient: who, amount: Number(ustx) });
    plan.push({ label: `fund ${who.slice(0, 8)}… ${ustx / STX} STX`, kind: 'transfer' }); builder.withSender(DEP);
  };
  s.stake = (label, who, ustx, want = ok) => s.call(label, POX, 'stake',
    [Cl.contractPrincipal(DEP, POOL_NAME), Cl.uint(ustx), Cl.uint(96), Cl.uint(s.burn), Cl.none()], want, who);
  s.deploy = (name, source, version = ClarityVersion.Clarity6) => {
    builder.addContractDeploy({ contract_name: name, source_code: source, clarity_version: version });
    plan.push({ label: `deploy ${name}`, kind: 'deploy' });
  };
  if (JUICE_LIVE) await verifyLiveJuice(NODE, sourceHashes); // live trait, vault, pool at DEP
  else {
    const trait = traitSource(sourceHashes);
    s.deploy(trait.name, trait.source);
    for (const repoName of ['juice-sbtc-autoswap', 'juice-pool-sbtc-signer']) {
      const j = juiceSource(repoName, resolve(directory, `../contracts/pox-5/${repoName}.clar`), sourceHashes);
      s.deploy(j.name, j.source);
    }
  }
  s.call('register the pool as a pox-5 signer', PID, 'register-self',
    [Cl.contractPrincipal(DEP, POOL_NAME), Cl.buffer(Buffer.from(signerKey.replace(/^0x/, ''), 'hex')),
     Cl.uint(AUTH_ID), Cl.buffer(Buffer.from(signerSig.replace(/^0x/, ''), 'hex'))], ok);
  // Earned-reward fixture for one past cycle, same shape as the pool suite.
  s.fixture = (rc, fund, shares) => {
    const key = `{ reward-cycle: u${rc}, bond-index: none, signer: '${PID} }`;
    const total = shares.reduce((t, [, n]) => t + n, 0n);
    const sets = shares.map(([w, n]) => `(map-set staker-shares-staked-for-cycle { reward-cycle: u${rc}, bond-index: none, signer: '${PID}, staker: '${w} } u${n})`).join(' ');
    return s.ev(`fixture: cycle ${rc} earned ${fund} sats over ${shares.length} stakers`, POX, `(begin
      (map-set signer-shares-staked-for-cycle ${key} u${total})
      (map-set signer-pending-staked-ustx-per-cycle { signer: '${PID}, cycle: u${rc} } u${total})
      (map-set signer-rewards-per-token-settled-for-cycle ${key} (get-rewards-per-token-for-cycle u${rc} none))
      (map-set signer-unclaimed-rewards-for-cycle ${key} u${fund})
      ${sets}
      (var-set last-accounted-rewards-only (+ (var-get last-accounted-rewards-only) u${fund}))
      (ok true))`, '(ok true)');
  };
  s.run = async (name, extra = () => []) => {
    console.log(`${name}: fork block ${forkBlock}, cycle ${cycleNow}, ${plan.length} steps`);
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
        : typeof p.want === 'function' ? p.want(actual) : actual === p.want;
      if (!/^(deploy|Jing )/.test(p.label)) console.log(`${passed ? 'PASS' : 'FAIL'} ${p.label}: ${actual.slice(0, 220)}`);
      return { label: p.label, passed, actual };
    });
    for (const [label, passed, actual] of extra((i) => checks[i].actual, result)) {
      console.log(`${passed ? 'PASS' : 'FAIL'} ${label}: ${actual}`);
      checks.push({ label, passed, actual });
    }
    const failed = checks.filter((c) => !c.passed).length;
    const dir = resolve(directory, 'results/pool-vault-stx'); mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${name}.json`), JSON.stringify({ id, url, block: forkBlock, cycle: cycleNow, sourceHashes, checks }, null, 2));
    console.log(`\n=== ${name}: ${checks.length - failed}/${checks.length} passed ===\nView: ${url}`);
    if (failed) process.exit(1);
  };
  return s;
}
