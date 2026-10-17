// Shared setup for the Juice SAFE stxer sims (Earn BTC = juice-safe-v9,
// Grow STX = juice-autostake-safe): live template bytes, a real P-256 passkey,
// WebAuthn sig-auth built the way stx-juice-fe does it, and the step/plan/assert
// harness used by the other juicestx sims.
import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync, createSign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(directory, '../package.json'));
const { SimulationBuilder, getSimulationResult } = require('stxer');
export const T = require('@stacks/transactions');
const { Cl, ClarityVersion, deserializeCV, cvToString, serializeCV } = T;

export const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
export const API = process.env.STXER_API_URL || 'https://api.stxer.xyz';
export const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
export const RELAY = 'SP28MP1HQDJWQAFSQJN2HBAXBVP7H7THD1W2NYZVK'; // FAKFUN-DEPLOYER
export const ADMIN = 'SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51';
export const RECOVERY = 'SP3HXJJMJQ06GNAZ8XWDN1QM48JEDC6PP6W3YZPZJ';
export const OUTSIDE = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
export const SBTC_WHALE = 'SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1';
export const POX = 'SP000000000000000000002Q6VF78.pox-5';
export const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
export const CORE = `${DEP}.fakfun-wallet-core-v2`;
export const GAS = `${DEP}.gas-station`;
export const POOL_STX = `${DEP}.juice-pool-stx-signer`, POOL_SBTC = `${DEP}.juice-pool-sbtc-signer`, VAULT = `${DEP}.juice-sbtc-autoswap`;
export const H = {
  std: `${DEP}.smart-wallet-standard-auth-helpers-v7`,
  now: `${DEP}.mm-safe-auth-helpers-v1`,
  stake: `${DEP}.juice-safe-auth-helpers-v2`,
  unstake: `${DEP}.juice-safe-auth-helpers-v1`,
  keeper: `${DEP}.juice-autostake-safe-auth-helpers-v1`,
};
export const FIRST_BURN = 666050, CYCLE = 2100, HALF = 1050;
export const STX_LIMIT = 5_000_000_000, SBTC_LIMIT = 100_000, COOLDOWN = 144;
export const CLARITY_6 = ClarityVersion.Clarity6 ?? 6;
export const KINDS = [
  { key: 'earn', kind: 'Earn BTC', template: 'juice-safe-v9', name: 'sim-earn-btc-safe', pool: POOL_STX },
  { key: 'grow', kind: 'Grow STX', template: 'juice-autostake-safe', name: 'sim-grow-stx-safe', pool: POOL_SBTC },
];

export const ok = (v) => v.startsWith('(ok');
export const u = (field) => (v) => BigInt((v.match(new RegExp(`${field} u(\\d+)`)) || [])[1] ?? '-1');
export const num = (s) => BigInt(String(s).match(/u(\d+)/)?.[1] ?? '-1');

export const get = async (p) => {
  const r = await fetch(`${NODE}${p}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json();
};
export const ro = async (id, fn, args = []) => {
  const [a, n] = id.split('.');
  const r = await fetch(`${NODE}/v2/contracts/call-read/${a}/${n}/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sender: DEP, arguments: args.map((c) => '0x' + serializeCV(c).replace(/^0x/, '')) }) });
  const b = await r.json(); if (!b.okay) throw new Error(`${fn}: ${JSON.stringify(b).slice(0, 200)}`); return cvToString(deserializeCV(b.result));
};

// Live template bytes, checked against core-v2's verified hash (as the baseline sim).
export async function loadTemplates() {
  for (const k of KINDS) {
    k.source = (await get(`/v2/contracts/source/${DEP}/${k.template}?proof=0`)).source;
    k.hash = createHash('sha512-256').update(k.source).digest('hex');
    const verified = await ro(CORE, 'get-verified-contract-hash', [Cl.principal(`${DEP}.${k.template}`)]);
    if (verified !== `(some 0x${k.hash})`) throw new Error(`${k.template}: source hash ${k.hash} != core-v2 verified ${verified}`);
    k.id = `${RELAY}.${k.name}`;
  }
  return KINDS;
}

// ---- passkey (P-256) ---------------------------------------------------------
const sha256 = (b) => createHash('sha256').update(b).digest();
const N_P256 = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
export const RP_ID = 'juiceofbtc.com';
export const RP_ID_HASH = sha256(Buffer.from(RP_ID));
if (RP_ID_HASH.toString('hex') !== '1516f9ea2a21f961d99143eedf2aeeab86e3784a34a401b038bb97a7631e668b') throw new Error('rpIdHash mismatch');
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function newPasskey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url');
  const pub = Buffer.concat([Buffer.from([(y[31] & 1) ? 3 : 2]), x]);
  let counter = 0;
  // Same pieces navigator.credentials.get() hands safe-webauthn.ts: authenticatorData
  // (rpIdHash | flags UP+UV | signCount), clientDataJSON split around the base64url
  // challenge, DER -> raw r||s (normalized to low-S).
  const sign = (challenge) => {
    counter += 1;
    const authData = Buffer.concat([RP_ID_HASH, Buffer.from([0x05]), Buffer.from([0, 0, 0, counter])]);
    const prefix = Buffer.from('{"type":"webauthn.get","challenge":"');
    const suffix = Buffer.from(`","origin":"https://${RP_ID}","crossOrigin":false}`);
    const clientDataJSON = Buffer.concat([prefix, Buffer.from(b64url(challenge)), suffix]);
    const signer = createSign('SHA256'); // ES256: ECDSA over sha256(authData || sha256(clientDataJSON))
    signer.update(Buffer.concat([authData, sha256(clientDataJSON)]));
    const raw = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
    let s = BigInt('0x' + raw.subarray(32).toString('hex'));
    if (s > N_P256 / 2n) s = N_P256 - s;
    const sig = Buffer.concat([raw.subarray(0, 32), Buffer.from(s.toString(16).padStart(64, '0'), 'hex')]);
    return { authData, prefix, suffix, sig };
  };
  return { pub, sign };
}

// SIP-018 hash exactly as the helpers build it (domain wallet = contract-caller = the safe).
export function sip018(wallet, message) {
  const domain = Cl.tuple({ name: Cl.stringAscii('smart-wallet-standard'), version: Cl.stringAscii('1.0.0'), 'chain-id': Cl.uint(1), wallet: Cl.principal(wallet) });
  const ser = (cv) => Buffer.from(serializeCV(cv).replace(/^0x/, ''), 'hex');
  return sha256(Buffer.concat([Buffer.from('SIP018'), sha256(ser(domain)), sha256(ser(message))]));
}
export function sigAuth(pk, authId, hash) {
  const s = pk.sign(hash);
  return Cl.tuple({ 'auth-id': Cl.uint(authId), pubkey: Cl.buffer(pk.pub), signature: Cl.buffer(s.sig),
    'authenticator-data': Cl.buffer(s.authData), 'client-data-prefix': Cl.buffer(s.prefix), 'client-data-suffix': Cl.buffer(s.suffix) });
}
export const msg = {
  stxTransfer: (a, amount, recipient, memo = null) => Cl.tuple({ topic: Cl.stringAscii('stx-transfer'), 'auth-id': Cl.uint(a), amount: Cl.uint(amount), recipient: Cl.principal(recipient), memo: memo ? Cl.some(Cl.buffer(memo)) : Cl.none() }),
  sip010: (a, amount, recipient, token) => Cl.tuple({ topic: Cl.stringAscii('sip010-transfer'), 'auth-id': Cl.uint(a), amount: Cl.uint(amount), recipient: Cl.principal(recipient), memo: Cl.none(), sip010: Cl.principal(token) }),
  veto: (a, op) => Cl.tuple({ topic: Cl.stringAscii('veto-operation'), 'auth-id': Cl.uint(a), 'op-id': Cl.uint(op) }),
  executeNow: (a, op) => Cl.tuple({ topic: Cl.stringAscii('execute-now'), 'auth-id': Cl.uint(a), 'op-id': Cl.uint(op) }),
  stake: (a, amount) => Cl.tuple({ topic: Cl.stringAscii('stake-stx-juice-pox5'), 'auth-id': Cl.uint(a), 'amount-ustx': Cl.uint(amount), 'signer-calldata': Cl.none() }),
  unstake: (a) => Cl.tuple({ topic: Cl.stringAscii('unstake-stx-juice'), 'auth-id': Cl.uint(a) }),
  setKeeper: (a, keeper) => Cl.tuple({ topic: Cl.stringAscii('set-keeper'), 'auth-id': Cl.uint(a), keeper: Cl.principal(keeper) }),
};
// Clarity expression of the same helper call, evaluated inside the safe (contract-caller = safe).
export const helperExpr = {
  stxTransfer: (a, amount, recipient) => `(contract-call? '${H.std} build-stx-transfer-hash { auth-id: u${a}, amount: u${amount}, recipient: '${recipient}, memo: none })`,
  executeNow: (a, op) => `(contract-call? '${H.now} build-execute-now-hash { auth-id: u${a}, op-id: u${op} })`,
  setKeeper: (a, k) => `(contract-call? '${H.keeper} build-set-keeper-hash { auth-id: u${a}, keeper: '${k} })`,
};

// ---- simulation harness ------------------------------------------------------
export function harness({ forkBlock, burn }) {
  const b = SimulationBuilder.new({ stacksNodeAPI: NODE, apiEndpoint: API, skipTracing: !process.env.STXER_TRACE }).withSender(RELAY);
  if (forkBlock) b.useBlockHeight(forkBlock);
  const plan = [];
  const s = { b, plan, burn, section: '' };
  const lbl = (l) => `${s.section ? `[${s.section}] ` : ''}${l}`;
  s.tx = (label, id, fn, args, want, sender) => { b.addContractCall({ contract_id: id, function_name: fn, function_args: args, sender }); plan.push({ label: lbl(label), kind: 'tx', want, section: s.section }); return plan.length - 1; };
  s.ev = (label, id, code, want = () => true) => { b.addEvalCode(id, code); plan.push({ label: lbl(label), kind: 'eval', want, section: s.section }); return plan.length - 1; };
  s.stx = (label, from, to, amount) => { b.withSender(from).addSTXTransfer({ recipient: to, amount: Number(amount) }); b.withSender(RELAY); plan.push({ label: lbl(label), kind: 'transfer', section: s.section }); return plan.length - 1; };
  s.offset = () => (s.burn - FIRST_BURN) % CYCLE;
  s.cycle = () => Math.floor((s.burn - FIRST_BURN) / CYCLE);
  s.advance = (n, label) => { b.addAdvanceBlocks({ bitcoin_blocks: n, stacks_blocks_per_bitcoin: 1, bitcoin_interval_secs: 1 }); s.burn += n; plan.push({ label: lbl(`${label}: +${n} burn -> ${s.burn} (cycle ${s.cycle()} offset ${s.offset()})`), kind: 'advance', section: s.section }); return plan.length - 1; };
  s.acct = (label, who, want) => s.ev(label, POX, `{ account: (stx-account '${who}), balance: (stx-get-balance '${who}) }`, want);
  s.sbtcBal = (label, who, want) => s.ev(label, SBTC, `(unwrap-panic (get-balance '${who}))`, want);
  s.deployOnboard = (k, pubkey) => {
    b.withSender(RELAY).addContractDeploy({ contract_name: k.name, source_code: k.source, clarity_version: CLARITY_6 });
    plan.push({ label: lbl(`[${k.kind}] deploy ${k.id} (live ${k.template} bytes)`), kind: 'deploy', section: s.section });
    s.ev(`[${k.kind}] fresh safe hash == template verified hash`, CORE, `(is-eq (some (unwrap-panic (contract-hash? '${k.id}))) (get-verified-contract-hash '${DEP}.${k.template}))`, (v) => v === 'true');
    s.tx(`[${k.kind}] onboard with REAL P-256 passkey ${pubkey.toString('hex').slice(0, 10)}..., admin ${ADMIN.slice(0, 8)}...`, k.id, 'onboard',
      [Cl.buffer(pubkey), Cl.principal(ADMIN), Cl.principal(RECOVERY), Cl.uint(STX_LIMIT), Cl.uint(SBTC_LIMIT), Cl.uint(COOLDOWN)], ok, RELAY);
    s.ev(`[${k.kind}] is-admin-pubkey(passkey)`, k.id, `(is-admin-pubkey 0x${pubkey.toString('hex')})`, (v) => v === '(ok (ok true))' || v === '(ok true)');
  };
  s.run = async (name, extra = () => []) => {
    console.log(`${name}: ${plan.length} steps, running...`);
    const id = await b.run();
    const url = `https://stxer.xyz/simulations/mainnet/${id}`;
    console.log(`View: ${url}`);
    const res = await getSimulationResult(id, { stxerApi: API });
    const checks = plan.map((p, i) => {
      const st = res.steps[i]?.Result;
      let actual;
      if (p.kind === 'advance') actual = st?.AdvanceBlocks?.Ok ? 'ok' : `ENGINE ${JSON.stringify(st).slice(0, 200)}`;
      else if (p.kind === 'eval') actual = st?.Eval?.Ok !== undefined ? cvToString(deserializeCV(st.Eval.Ok)) : `ENGINE ${JSON.stringify(st).slice(0, 300)}`;
      else actual = st?.Transaction?.Ok && !st.Transaction.Ok.vm_error ? (st.Transaction.Ok.result ? cvToString(deserializeCV(st.Transaction.Ok.result)) : 'ok') : `ENGINE ${JSON.stringify(st).slice(0, 400)}`;
      const passed = p.kind === 'advance' ? actual === 'ok'
        : p.kind === 'deploy' || p.kind === 'transfer' ? !actual.startsWith('ENGINE')
        : typeof p.want === 'function' ? p.want(actual) : actual === p.want;
      console.log(`${String(i + 1).padStart(3)} ${passed ? 'PASS' : 'FAIL'} ${p.label}: ${actual.slice(0, 240)}`);
      return { step: i + 1, label: p.label, section: p.section, passed, actual };
    });
    for (const [label, passed, actual, section] of extra((i) => checks[i].actual)) {
      console.log(`    ${passed ? 'PASS' : 'FAIL'} ${label}: ${actual}`);
      checks.push({ step: null, label, section, passed, actual: String(actual) });
    }
    const failed = checks.filter((c) => !c.passed);
    const dir = resolve(directory, 'results/juice-safes'); mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${name}.json`), JSON.stringify({ id, url, forkBlock, checks }, null, 2));
    console.log(`\n=== ${name}: ${checks.length - failed.length}/${checks.length} passed ===\nView: ${url}`);
    return { id, url, checks, failed };
  };
  return s;
}

// Rich mainnet accounts with UNLOCKED STX (sims only move them inside the fork).
export const STX_SOURCES = (process.env.STX_SOURCES || [
  'SP2ADT4TAV92SPBNP3WE9GPJ12F6CKGWMEJ1H1BB9', 'SP34EBMKMRR6SXX65GRKJ1FHEXV7AGHJ2D8ASQ5M3',
].join(',')).split(',');
// Plans transfers of `amounts` (list of [recipient, ustx]) out of STX_SOURCES, keeping 10 STX per source for fees.
export async function planFunding(amounts) {
  const avail = [];
  for (const a of STX_SOURCES) {
    const r = await get(`/v2/accounts/${a}?proof=0`);
    avail.push([a, BigInt(r.balance) - BigInt(r.locked) - 10_000_000n]);
  }
  const out = [];
  for (const [to, want] of amounts) {
    let need = BigInt(want);
    for (const src of avail) {
      if (need === 0n) break;
      const take = src[1] < need ? src[1] : need;
      if (take <= 0n) continue;
      out.push([src[0], to, take]); src[1] -= take; need -= take;
    }
    if (need > 0n) throw new Error(`not enough unlocked STX in STX_SOURCES for ${to}: short ${need}`);
  }
  return out;
}
