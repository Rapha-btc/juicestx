// stxer mainnet fork: the Grow STX (Auto-compound) safe "happy story", one
// fork, read top to bottom by the owner.
//   1 DEPLOY + ONBOARD  fresh safe from the live juice-autostake-safe bytes
//                       (hash == fakfun-wallet-core-v2 verified hash), onboard
//                       with the admin wallet + a real P-256 passkey and the
//                       /safe wizard defaults (100 STX / 100,000 sats / 144 blocks).
//   2 FUND + STAKE      admin sends 1,000 STX and calls stake-stx-juice into
//                       juice-pool-sbtc-signer. All 1,000 STX locked.
//   3 ROUND 1           real pox-5 reward round for cycle C1: calculate-rewards
//                       (active bonds), pool claim -> juice-sbtc-autoswap ->
//                       Jing place / reclaim / router sale (keyless Lazer update)
//                       -> finalize -> pay-stx-stakers in STX -> keeper restake().
//   4 ROUND 2           same flow for cycle C1+1, where the safe's pox-5 shares
//                       are 1,000 STX + round 1 (the compounding).
//   5 EXIT              admin unstake, advance past the unlock, admin withdraws
//                       the whole balance: over the 100 STX wizard limit, so it
//                       queues as op u0 and the PASSKEY co-signs
//                       execute-pending-stx-transfer-now (both keys = immediate).
//
// Fork-only inputs (everything else is live mainnet code):
//   - the reward money: a real sBTC whale sends 10 BTC to pox-5 before each
//     round (pox-5 books any balance above staked + reserve as new rewards);
//   - two throwaway accounts stake 30,000 STX each with juice-pool-sbtc-signer,
//     because on mainnet the pool is below pox-5's 50k STX signer minimum;
//   - STX top-up of the admin wallet only if it holds < 1,010 STX at the fork.
//
// Two passes on the same fork block + the same Lazer update: pass 1 learns the
// exact unlocked balance (the payouts depend on the swap), pass 2 is the story
// with the exact "withdraw everything" amount. Only pass 2 is reported.
// Run: node simulations/juice-grow-safe-story-stxer.mjs
import {
  T, DEP, RELAY, ADMIN, RECOVERY, OUTSIDE, SBTC, SBTC_WHALE, POX, KINDS, POOL_SBTC, CORE, FIRST_BURN, CYCLE, HALF, CLARITY_6,
  ok, u, num, get, ro, loadTemplates, newPasskey, harness, planFunding, sigAuth, sip018, msg, helperExpr,
} from './_juice-safes-lib.mjs';
import { fetchLazerUpdateAny } from './_pool-vault-lazer.mjs';
const { Cl, getAddressFromPrivateKey } = T;

const STX = 1_000_000n;
const STAKE = 1_000n * STX, HELPER_STAKE = 30_000n * STX;
const WIZ_STX_LIMIT = 100n * STX, WIZ_SBTC_LIMIT = 100_000n, WIZ_COOLDOWN = 144n; // stx-juice-fe SafePage defaults
const INJECT = 1_000_000_000; // 10 BTC of rewards into pox-5 per round (fork only)
const STRANGER = 'SP3TS3T9GSGFEDW7ZBJNFXMH6RY0AP7HNCQEE77DH';
const HELPERS = ['a', 'b'].map((d) => getAddressFromPrivateKey(d.repeat(64) + '01', 'mainnet'));
const fmt = (ustx) => `${(Number(ustx) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} STX`;

await loadTemplates();
const G = KINDS.find((k) => k.key === 'grow');
G.name = 'sim-grow-stx-story'; G.id = `${RELAY}.${G.name}`;
const pk = newPasskey();
const VAULT = (await ro(POOL_SBTC, 'get-swap-vault')).replace(/^\(some /, '').replace(/\)$/, '');
console.log(`active swap vault: ${VAULT}`);

// Fork block: old enough that the round-2 router sale (the last Lazer use) lands
// just before the Lazer publish time. Earlier uses see a "future" publish time,
// which the market and pyth-lazer-oracle accept (they only reject stale prices).
const tipInfo = await get('/v2/info');
const o0 = (tipInfo.burn_block_height - FIRST_BURN) % CYCLE;
const lead = o0 > 1800 ? CYCLE - o0 + 20 : 0;
const planned = lead + (CYCLE - (lead ? 20 : o0) + 20) + (HALF - 20 + 5) + 290 + (CYCLE - (HALF + 5 + 290) + 20) + (HALF - 20 + 5) + 291;
const LAG = Number(process.env.JUICE_SAFES_LAG_SECS ?? planned + 240);
const tip = (await get('/extended/v1/block?limit=1')).results[0];
const target = Math.floor(Date.now() / 1000) - LAG;
let lo = tip.height - 20000, hi = tip.height;
while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); ((await get(`/extended/v2/blocks/${mid}`)).block_time <= target) ? lo = mid : hi = mid; }
const FORK = lo, forkInfo = await get(`/extended/v2/blocks/${FORK}`);
console.log(`fork block ${FORK} (time ${forkInfo.block_time}, lag ${LAG}s), burn ${forkInfo.burn_block_height}, planned advance ~${planned} burn blocks (DIA max age 7,200 s)`);

const adminNow = await get(`/v2/accounts/${ADMIN}?proof=0`);
const adminFree = BigInt(adminNow.balance) - BigInt(adminNow.locked);
const funding = await planFunding([
  ...(adminFree < STAKE + 10n * STX ? [[ADMIN, STAKE + 10n * STX - adminFree]] : []),
  ...HELPERS.map((h) => [h, HELPER_STAKE + 5n * STX]),
]);

// pox-5 calculate-rewards must list every protocol bond active at the
// calculation height, ordered by stx-value-ratio desc (empty list -> err u33).
async function activeBonds(height) {
  const out = [];
  for (let i = 0; i < 60; i++) {
    if (await ro(POX, 'is-bond-active-at-height', [Cl.uint(i), Cl.uint(height)]) !== 'true') continue;
    out.push([i, num((await ro(POX, 'get-protocol-bond', [Cl.uint(i)])).match(/stx-value-ratio u\d+/)[0])]);
  }
  out.sort((a, b) => (a[1] === b[1] ? a[0] - b[0] : (b[1] > a[1] ? 1 : -1)));
  return out.map(([i]) => i);
}
const bondList = (l) => Cl.list(l.map((i) => Cl.uint(i)));
const update = Cl.buffer(Buffer.from((await fetchLazerUpdateAny()).hex.replace(/^0x/, ''), 'hex'));
const bondCache = new Map();

async function build(withdrawAll) {
  const s = harness({ forkBlock: FORK, burn: forkInfo.burn_block_height });
  const ix = {};
  let authId = 0;
  const sa = (message) => { authId += 1; const a = authId; return { a, cv: sigAuth(pk, a, sip018(G.id, message(a))) }; };

  // -- 1 DEPLOY + ONBOARD ------------------------------------------------------
  s.section = '1 DEPLOY+ONBOARD';
  if (lead) s.advance(lead, 'leave the prepare phase (so the stake starts next cycle)');
  s.b.withSender(RELAY).addContractDeploy({ contract_name: G.name, source_code: G.source, clarity_version: CLARITY_6 });
  s.plan.push({ label: `[1 DEPLOY+ONBOARD] deploy ${G.id} from the live juice-autostake-safe bytes`, kind: 'deploy', section: s.section });
  s.ev('safe code hash == juice-autostake-safe hash verified in fakfun-wallet-core-v2', CORE, `(is-eq (some (unwrap-panic (contract-hash? '${G.id}))) (get-verified-contract-hash '${DEP}.${G.template}))`, 'true');
  s.tx(`onboard (FAKFUN-DEPLOYER): passkey ${pk.pub.toString('hex').slice(0, 10)}..., admin ${ADMIN.slice(0, 8)}..., wizard limits 100 STX / 100,000 sats / 144 blocks`, G.id, 'onboard',
    [Cl.buffer(pk.pub), Cl.principal(ADMIN), Cl.principal(RECOVERY), Cl.uint(WIZ_STX_LIMIT), Cl.uint(WIZ_SBTC_LIMIT), Cl.uint(WIZ_COOLDOWN)], ok, RELAY);
  s.ev('passkey is an admin key', G.id, `(is-admin-pubkey 0x${pk.pub.toString('hex')})`, (v) => v === '(ok (ok true))' || v === '(ok true)');
  s.ev('admin wallet is the owner', G.id, '(get-owner)', (v) => v.includes(ADMIN));
  s.ev('keeper = chavita (SPV9K21)', G.id, '(get-keeper)', (v) => v.includes(DEP));
  s.ev('core-v2 whitelisted the safe', CORE, `(is-whitelisted '${G.id})`, 'true');

  // -- 2 FUND + STAKE ----------------------------------------------------------
  s.section = '2 FUND+STAKE';
  for (const [from, to, amt] of funding) s.stx(`(fork-only) top up ${to.slice(0, 8)}... ${amt / STX} STX`, from, to, amt);
  s.stx(`admin wallet sends ${fmt(STAKE)} to the safe`, ADMIN, G.id, STAKE);
  s.acct('safe holds 1,000 STX unlocked', G.id, (v) => u('unlocked')(v) === STAKE);
  s.tx('admin stake-stx-juice 1,000 STX (sig-auth none)', G.id, 'stake-stx-juice', [Cl.uint(STAKE), Cl.none(), Cl.none(), Cl.none()], ok, ADMIN);
  ix.locked0 = s.acct('LOCKED: 1,000 STX, unlocked 0', G.id, (v) => u('locked')(v) === STAKE && u('unlocked')(v) === 0n);
  s.ev('pox-5 position: juice-pool-sbtc-signer, 1,000 STX', POX, `(get-staker-info '${G.id})`, (v) => v.includes(POOL_SBTC) && v.includes(`amount-ustx u${STAKE}`));
  const C1 = s.cycle() + 1, C2 = C1 + 1;
  for (const [i, h] of HELPERS.entries()) s.tx(`(fork-only) staker ${i + 1} stakes 30,000 STX with the pool (pool needs 50k to be a counted signer)`, POX, 'stake',
    [Cl.principal(POOL_SBTC), Cl.uint(HELPER_STAKE), Cl.uint(12), Cl.uint(s.burn), Cl.none()], ok, h);
  s.ev(`pool delegated for cycle ${C1} >= 50k STX`, POX, `(get-amount-delegated-for-signer '${POOL_SBTC} u${C1})`, (v) => num(v) >= 50_000n * STX);

  const bonds = async (h) => { if (!bondCache.has(h)) bondCache.set(h, await activeBonds(h)); return bondCache.get(h); };

  // One full reward round for `cyc`: we are at offset 20 of `cyc`.
  async function round(tag, cyc) {
    const r = {};
    s.tx(`calculate-rewards: close the previous half (flush; err u30 if already done)`, POX, 'calculate-rewards', [bondList(await bonds(FIRST_BURN + cyc * CYCLE - 1))], (v) => ok(v) || v === '(err u30)', STRANGER);
    r.shares = s.ev(`[safe] pox-5 shares in cycle ${cyc}`, POX, `(get-staker-shares-staked-for-cycle '${G.id} u${cyc} none '${POOL_SBTC})`, (v) => num(v) > 0n);
    r.total = s.ev(`pool shares in cycle ${cyc}`, POX, `(get-signer-shares-staked-for-cycle '${POOL_SBTC} u${cyc} none)`, (v) => num(v) >= 50_000n * STX);
    s.tx(`(fork-only) rewards arrive: ${INJECT / 1e8} BTC of sBTC into pox-5`, SBTC, 'transfer', [Cl.uint(INJECT), Cl.principal(SBTC_WHALE), Cl.principal(POX), Cl.none()], '(ok true)', SBTC_WHALE);
    s.advance(HALF - s.offset() + 5, `to the reward point (second half of ${cyc})`);
    const bl = await bonds(FIRST_BURN + cyc * CYCLE + HALF - 1);
    s.tx(`calculate-rewards books the first half of ${cyc} (bonds [${bl}])`, POX, 'calculate-rewards', [bondList(bl)], (v) => ok(v) && v.includes(`(stx-cycle u${cyc})`), STRANGER);
    r.trn = s.ev('pool tranche index for this claim', POOL_SBTC, `(get-tranche-count u${cyc})`, 'u0');
    r.claim = s.tx(`pool pox-claim-rewards(${cyc}) -> sBTC into juice-sbtc-autoswap (SATS IN)`, POOL_SBTC, 'pox-claim-rewards', [Cl.list([]), Cl.uint(cyc), Cl.principal(VAULT)], (v) => ok(v) && num(v.match(/total-rewards u\d+/)?.[0]) > 0n, STRANGER);
    s.tx('vault rests the sBTC on Jing (jing-place, Lazer update)', VAULT, 'jing-place', [update], ok, STRANGER);
    s.advance(289, 'vault patience window (288 blocks)');
    s.tx('vault reclaims the unfilled sBTC from Jing', VAULT, 'jing-reclaim', [], ok, STRANGER);
    r.swap = s.tx('router sells the sBTC for STX (router-swap, Lazer update)', VAULT, 'router-swap', [update], ok, STRANGER);
    s.advance(1, 'router cooldown');
    s.tx('router-swap again (only if a chunk is left; err is fine)', VAULT, 'router-swap', [update], () => true, STRANGER);
    r.pot = s.tx('finalize-swap: STX pot for the stakers (STX OUT)', POOL_SBTC, 'finalize-swap', [Cl.principal(VAULT)], (v) => /^\(ok u[1-9]\d*\)$/.test(v), STRANGER);
    r.owed = s.ev('[safe] get-stx-owed (uSTX)', POOL_SBTC, `(get-stx-owed u${cyc} u0 '${G.id})`, (v) => num(v) > 0n);
    r.before = s.acct('[safe] before payout', G.id, (v) => u('unlocked')(v) === 0n);
    s.tx('pay-stx-stakers([safe, staker1, staker2]) in STX (permissionless)', POOL_SBTC, 'pay-stx-stakers', [Cl.list([Cl.principal(G.id), ...HELPERS.map((h) => Cl.principal(h))]), Cl.uint(cyc), Cl.uint(0)], ok, STRANGER);
    r.after = s.acct('[safe] after payout: reward sits unlocked', G.id, (v) => u('unlocked')(v) > 0n);
    s.ev('tranche fully paid', POOL_SBTC, `(is-tranche-fully-paid u${cyc} u0)`, 'true');
    r.restake = s.tx('keeper (chavita SPV9K21) restake()', G.id, 'restake', [], ok, DEP);
    r.locked = s.acct('[safe] LOCKED after restake (unlocked 0)', G.id, (v) => u('unlocked')(v) === 0n);
    r.info = s.ev('[safe] pox-5 position after restake', POX, `(get-staker-info '${G.id})`, (v) => v.includes(POOL_SBTC));
    return r;
  }

  s.section = '3 ROUND 1';
  s.advance(CYCLE - s.offset() + 20, `into the staked cycle ${C1}`);
  s.ev('current cycle', POX, '(current-pox-reward-cycle)', `u${C1}`);
  ix.r1 = await round('R1', C1);

  s.section = '4 ROUND 2';
  s.advance(CYCLE - s.offset() + 20, `into cycle ${C2} (the restaked amount now counts)`);
  s.ev('current cycle', POX, '(current-pox-reward-cycle)', `u${C2}`);
  ix.r2 = await round('R2', C2);

  s.section = '5 EXIT';
  s.tx('admin unstake (sig-auth none)', G.id, 'unstake', [Cl.none(), Cl.none()], ok, ADMIN);
  s.ev('pox-5 position after unstake', POX, `(get-staker-info '${G.id})`);
  s.acct('still locked until the next cycle starts', G.id, (v) => u('locked')(v) > 0n);
  const unlockBurn = FIRST_BURN + (s.cycle() + 1) * CYCLE;
  s.advance(unlockBurn - s.burn + 5, 'past the unlock height');
  ix.unlocked = s.acct('STX unlocked back in the safe, locked 0', G.id, (v) => u('locked')(v) === 0n && u('unlocked')(v) > STAKE);
  ix.posGone = s.ev('pox-5 position gone', POX, `(get-staker-info '${G.id})`, 'none');
  if (withdrawAll != null) {
    ix.out0 = s.acct('OUTSIDE wallet before', OUTSIDE);
    s.tx(`admin stx-transfer ALL ${fmt(withdrawAll)} -> OUTSIDE (over the 100 STX limit -> queued as op u0)`, G.id, 'stx-transfer', [Cl.uint(withdrawAll), Cl.principal(OUTSIDE), Cl.none(), Cl.none(), Cl.none()], '(ok true)', ADMIN);
    s.ev('op u0 pending, admin-created, nothing moved yet', G.id, '(get-pending-operation u0)', (v) => v.startsWith('(some') && v.includes(`amount u${withdrawAll}`) && v.includes('executed false') && v.includes('passkey-created false'));
    s.acct('safe still holds everything', G.id, (v) => u('balance')(v) === withdrawAll);
    const n = sa((a) => msg.executeNow(a, 0));
    s.ev('JS execute-now SIP-018 hash == mm-safe-auth-helpers-v1 inside the safe', G.id, `(is-eq ${helperExpr.executeNow(n.a, 0)} 0x${sip018(G.id, msg.executeNow(n.a, 0)).toString('hex')})`, 'true');
    s.tx('PASSKEY co-signs execute-pending-stx-transfer-now op u0 (both keys = immediate, relayed by a stranger)', G.id, 'execute-pending-stx-transfer-now', [Cl.uint(0), Cl.none(), n.cv, Cl.none()], '(ok true)', STRANGER);
    ix.safeEnd = s.acct('END: safe balance 0', G.id, (v) => u('balance')(v) === 0n);
    ix.out1 = s.acct('END: OUTSIDE wallet after', OUTSIDE);
  }
  return { s, ix, C1, C2 };
}

// -- pass 1: learn the exact unlocked balance --------------------------------
const p1 = await build(null);
const r1 = await p1.s.run('juice-grow-safe-story-pass1');
const total = u('unlocked')(r1.checks[p1.ix.unlocked].actual);
if (total <= STAKE) { console.log(`pass 1 did not reach a rewarded unlock (unlocked ${total}); stopping`); process.exit(1); }
console.log(`\npass 1 unlocked balance: ${total} uSTX -> pass 2 withdraws exactly that\n`);

// -- pass 2: the story ---------------------------------------------------------
const { s, ix, C1, C2 } = await build(total);
const r = await s.run('juice-grow-safe-story', (a) => {
  const paid = (rr) => u('unlocked')(a(rr.after)) - u('unlocked')(a(rr.before));
  const p1v = paid(ix.r1), p2v = paid(ix.r2);
  const lk = (i) => u('locked')(a(i));
  const sats = (rr) => num(a(rr.claim).match(/total-rewards u\d+/)?.[0]);
  const share = (rr) => Number(num(a(rr.shares))) / Number(num(a(rr.total)));
  const outDelta = u('balance')(a(ix.out1)) - u('balance')(a(ix.out0));
  console.log(`\nround 1: pool claimed ${sats(ix.r1)} sats -> pot ${fmt(num(a(ix.r1.pot)))}; safe share ${(share(ix.r1) * 100).toFixed(4)}% -> +${fmt(p1v)}`);
  console.log(`round 2: pool claimed ${sats(ix.r2)} sats -> pot ${fmt(num(a(ix.r2.pot)))}; safe share ${(share(ix.r2) * 100).toFixed(4)}% -> +${fmt(p2v)}`);
  console.log(`SUMMARY: staked ${fmt(STAKE)}, round1 +${fmt(p1v)}, round2 +${fmt(p2v)}, withdrawn ${fmt(outDelta)} (= ${fmt(STAKE + p1v + p2v)} expected)`);
  return [
    ['R1: safe paid exactly get-stx-owed', p1v === num(a(ix.r1.owed)) && p1v > 0n, `+${p1v} uSTX (owed ${num(a(ix.r1.owed))})`, '3 ROUND 1'],
    ['R1: restake locked exactly the payout', u('amount')(a(ix.r1.restake)) === p1v, `${u('amount')(a(ix.r1.restake))}`, '3 ROUND 1'],
    ['R1: locked grew 1,000 STX -> 1,000 STX + round 1', lk(ix.r1.locked) === STAKE + p1v && lk(ix.locked0) === STAKE, `${lk(ix.locked0)} -> ${lk(ix.r1.locked)}`, '3 ROUND 1'],
    [`R2: safe shares in ${C2} = 1,000 STX + round 1 (compounding)`, num(a(ix.r2.shares)) === STAKE + p1v, `${num(a(ix.r2.shares))} (cycle ${C1}: ${num(a(ix.r1.shares))})`, '4 ROUND 2'],
    ['R2: safe paid exactly get-stx-owed', p2v === num(a(ix.r2.owed)) && p2v > 0n, `+${p2v} uSTX (owed ${num(a(ix.r2.owed))})`, '4 ROUND 2'],
    ['R2: restake locked exactly the payout', u('amount')(a(ix.r2.restake)) === p2v, `${u('amount')(a(ix.r2.restake))}`, '4 ROUND 2'],
    ['R2: locked grew again to 1,000 STX + round 1 + round 2', lk(ix.r2.locked) === STAKE + p1v + p2v, `${lk(ix.r1.locked)} -> ${lk(ix.r2.locked)}`, '4 ROUND 2'],
    ['R2: bigger share of the pool than round 1', share(ix.r2) > share(ix.r1), `${(share(ix.r1) * 100).toFixed(4)}% -> ${(share(ix.r2) * 100).toFixed(4)}%`, '4 ROUND 2'],
    ['EXIT: unlocked = 1,000 STX + round 1 + round 2', u('unlocked')(a(ix.unlocked)) === STAKE + p1v + p2v, `${u('unlocked')(a(ix.unlocked))}`, '5 EXIT'],
    ['EXIT: OUTSIDE received principal + both rounds', outDelta === STAKE + p1v + p2v, `+${outDelta} uSTX`, '5 EXIT'],
    ['SUMMARY', true, `staked ${fmt(STAKE)}, round1 +${fmt(p1v)}, round2 +${fmt(p2v)}, withdrawn ${fmt(outDelta)}`, '5 EXIT'],
  ];
});
if (r.failed.length) process.exit(1);
