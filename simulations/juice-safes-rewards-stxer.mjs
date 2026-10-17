// stxer mainnet fork: REAL pox-5 reward rounds into both Juice safe kinds.
//   1a Earn BTC (juice-safe-v9 -> juice-pool-stx-signer): stake, next cycle,
//      sBTC arrives in pox-5, calculate-rewards books the half, the pool claims
//      (pox-claim-rewards) and pays (pay-stx-stakers): the safe's sBTC balance
//      grows by exactly get-stx-owed.
//   1b Grow STX (juice-autostake-safe -> juice-pool-sbtc-signer): the pool is
//      below pox-5's 50k STX signer minimum on mainnet, so two fork-only stakers
//      add 60k STX to it. Then the same round: claim into juice-sbtc-autoswap,
//      Jing place -> reclaim after the 288-block window -> router sale (live
//      Pyth Lazer update, keyless route) -> finalize -> pay-stx-stakers in STX ->
//      keeper restake() locks exactly the payout.
// The only fork-only input is the reward money itself: on mainnet pox-5 gets
// its sBTC from the protocol; here a real sBTC whale sends 10 BTC to pox-5
// (pox-5 counts any balance above staked + reserve as new rewards). Everything
// else (stakes, signer-set minimum, calculate-rewards, claims, swaps, payouts,
// restake) runs the live mainnet contracts.
// The fork block is taken JUICE_SAFES_LAG_SECS old so the Lazer update fetched
// now stays inside the market's 80 s staleness window after ~2,000 synthetic
// 1-second burn blocks.
// Run: node simulations/juice-safes-rewards-stxer.mjs
import {
  T, DEP, ADMIN, OUTSIDE, SBTC, SBTC_WHALE, POX, KINDS, POOL_STX, POOL_SBTC, VAULT, FIRST_BURN, CYCLE, HALF,
  ok, u, num, get, ro, loadTemplates, newPasskey, harness, planFunding, NODE,
} from './_juice-safes-lib.mjs';
import { fetchLazerUpdateAny } from './_pool-vault-lazer.mjs';
const { Cl, getAddressFromPrivateKey } = T;

const STX = 1_000_000n;
const STAKE = 1_000n * STX, HELPER_STAKE = 30_000n * STX;
const INJECT = 1_000_000_000; // 10 BTC of rewards into pox-5 (fork only)
const STRANGER = 'SP3TS3T9GSGFEDW7ZBJNFXMH6RY0AP7HNCQEE77DH';
const HELPERS = ['a', 'b'].map((d) => getAddressFromPrivateKey(d.repeat(64) + '01', 'mainnet'));

await loadTemplates();
const [E, G] = KINDS;
const pk = newPasskey();
const vaultLive = (await ro(POOL_SBTC, 'get-swap-vault')).replace(/^\(some /, '').replace(/\)$/, '');
if (vaultLive !== VAULT) console.log(`note: active vault is ${vaultLive}`);

// Fork block: the newest block at least LAG seconds old.
const tipInfo = await get('/v2/info');
const offsetNow = (tipInfo.burn_block_height - FIRST_BURN) % CYCLE;
const planned = (offsetNow > 1800 ? CYCLE : 0) + (CYCLE - offsetNow + 20) + (HALF - 20 + 5) + 289 + 2;
const LAG = Number(process.env.JUICE_SAFES_LAG_SECS ?? planned + 240);
const tip = (await get('/extended/v1/block?limit=1')).results[0];
const target = Math.floor(Date.now() / 1000) - LAG;
let lo = tip.height - 20000, hi = tip.height;
while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); ((await get(`/extended/v2/blocks/${mid}`)).block_time <= target) ? lo = mid : hi = mid; }
const forkBlockInfo = await get(`/extended/v2/blocks/${lo}`);
const s = harness({ forkBlock: lo, burn: forkBlockInfo.burn_block_height });
console.log(`fork block ${lo} (time ${forkBlockInfo.block_time}, lag ${LAG}s), burn ${s.burn}, cycle ${s.cycle()} offset ${s.offset()}, planned advance ~${planned} blocks`);
const funding = await planFunding([[E.id, STAKE], [G.id, STAKE], ...HELPERS.map((h) => [h, HELPER_STAKE + 5n * STX])]);

// -- setup --------------------------------------------------------------------
s.section = '1 SETUP';
if (s.offset() > 1800) s.advance(CYCLE - s.offset() + 20, 'leave the prepare phase');
for (const k of KINDS) s.deployOnboard(k, pk.pub);
for (const [from, to, amt] of funding) s.stx(`fund ${to.includes('.') ? to.split('.')[1] : to.slice(0, 8)} ${amt / STX} STX`, from, to, amt);
for (const k of KINDS) {
  s.tx(`[${k.kind}] admin stake-stx-juice 1,000 STX`, k.id, 'stake-stx-juice', [Cl.uint(STAKE), Cl.none(), Cl.none(), Cl.none()], ok, ADMIN);
  s.ev(`[${k.kind}] pox-5 position`, POX, `(get-staker-info '${k.id})`, (v) => v.includes(k.pool) && v.includes(`amount-ustx u${STAKE}`));
}
const C1 = s.cycle() + 1;
for (const [i, h] of HELPERS.entries()) s.tx(`fork-only staker ${i + 1} stakes 30,000 STX with juice-pool-sbtc-signer`, POX, 'stake',
  [Cl.principal(POOL_SBTC), Cl.uint(HELPER_STAKE), Cl.uint(12), Cl.uint(s.burn), Cl.none()], ok, h);
s.ev(`juice-pool-sbtc-signer delegated for cycle ${C1} >= 50k STX`, POX, `(get-amount-delegated-for-signer '${POOL_SBTC} u${C1})`, (v) => num(v) >= 50_000n * STX);

// pox-5 calculate-rewards must list every protocol bond active at the
// calculation height, ordered by stx-value-ratio desc (err u33 / u29 otherwise).
async function activeBonds(height) {
  const out = [];
  for (let i = 0; i < 60; i++) {
    if (await ro(POX, 'is-bond-active-at-height', [Cl.uint(i), Cl.uint(height)]) !== 'true') continue;
    out.push([i, num((await ro(POX, 'get-protocol-bond', [Cl.uint(i)])).match(/stx-value-ratio u\d+/)[0])]);
  }
  out.sort((a, b) => (a[1] === b[1] ? a[0] - b[0] : (b[1] > a[1] ? 1 : -1)));
  return out.map(([i]) => i);
}
const calcH1 = FIRST_BURN + C1 * CYCLE - 1, calcH2 = FIRST_BURN + C1 * CYCLE + HALF - 1;
const bonds1 = await activeBonds(calcH1), bonds2 = await activeBonds(calcH2);
console.log(`active bonds at ${calcH1}: [${bonds1}], at ${calcH2}: [${bonds2}]`);
const bondList = (l) => Cl.list(l.map((i) => Cl.uint(i)));

// -- into the staked cycle ------------------------------------------------------
s.section = '1 REWARDS';
s.advance(CYCLE - s.offset() + 20, `into staked cycle ${C1}`);
s.ev('current cycle', POX, '(current-pox-reward-cycle)', `u${C1}`);
s.tx('calculate-rewards for the previous half with active bonds (flush; err u30 if mainnet already did it)', POX, 'calculate-rewards', [bondList(bonds1)], (v) => ok(v) || v === '(err u30)', STRANGER);
const shares = {};
shares.stxPool = s.ev(`juice-pool-stx-signer shares for ${C1}`, POX, `(get-signer-shares-staked-for-cycle '${POOL_STX} u${C1} none)`, (v) => num(v) > 0n);
shares.sbtcPool = s.ev(`juice-pool-sbtc-signer shares for ${C1} (counted signer)`, POX, `(get-signer-shares-staked-for-cycle '${POOL_SBTC} u${C1} none)`, (v) => num(v) >= 50_000n * STX);
shares.total = s.ev(`all pox-5 STX shares for ${C1}`, POX, `(get-total-shares-staked-for-cycle u${C1} none)`, (v) => num(v) > 0n);
s.tx(`rewards arrive: ${INJECT / 1e8} BTC of sBTC into pox-5 (fork-only input)`, SBTC, 'transfer', [Cl.uint(INJECT), Cl.principal(SBTC_WHALE), Cl.principal(POX), Cl.none()], '(ok true)', SBTC_WHALE);
s.advance(HALF - s.offset() + 5, `into the second half of ${C1}`);
const calc = s.tx(`calculate-rewards books the first half of ${C1}`, POX, 'calculate-rewards', [bondList(bonds2)], (v) => ok(v) && v.includes(`(stx-cycle u${C1})`), STRANGER);

// 1a. Earn BTC
s.section = '1a EARN';
const trnE = s.ev('stx pool tranche index before claim', POOL_STX, `(get-tranche-count u${C1})`, (v) => /^u\d+$/.test(v));
const claimE = s.tx(`juice-pool-stx-signer pox-claim-rewards(${C1}) (permissionless)`, POOL_STX, 'pox-claim-rewards', [Cl.list([]), Cl.uint(C1)], (v) => ok(v) && num(v.match(/total-rewards u\d+/)?.[0]) > 0n, STRANGER);
const owedE2 = s.ev('[Earn BTC] get-stx-owed for the claimed tranche', POOL_STX, `(get-stx-owed u${C1} (- (get-tranche-count u${C1}) u1) '${E.id})`, (v) => num(v) > 0n);
const balE0 = s.sbtcBal('[Earn BTC] safe sBTC before payout', E.id, 'u0');
const payE = s.tx('[Earn BTC] pay-stx-stakers([safe]) (permissionless)', POOL_STX, 'pay-stx-stakers', [Cl.list([Cl.principal(E.id)]), Cl.uint(C1), Cl.uint(0)], ok, STRANGER);
const balE1 = s.sbtcBal('[Earn BTC] safe sBTC after payout', E.id, (v) => num(v) > 0n);
s.tx('[Earn BTC] paying the safe twice moves nothing', POOL_STX, 'pay-stx-stakers', [Cl.list([Cl.principal(E.id)]), Cl.uint(C1), Cl.uint(0)], '(ok u0)', STRANGER);
s.tx('[Earn BTC] admin can withdraw the reward (within limit)', E.id, 'sip010-transfer', [Cl.uint(1), Cl.principal(OUTSIDE), Cl.none(), Cl.principal(SBTC), Cl.stringAscii('sbtc-token'), Cl.none(), Cl.none()], '(ok true)', ADMIN);

// 1b. Grow STX
s.section = '1b GROW';
const update = Cl.buffer(Buffer.from((await fetchLazerUpdateAny()).hex.replace(/^0x/, ''), 'hex'));
s.ev('stacks-block-time at claim (vs Lazer update time)', POX, 'stacks-block-time');
const claimG = s.tx(`juice-pool-sbtc-signer pox-claim-rewards(${C1}) -> sBTC into the autoswap vault`, POOL_SBTC, 'pox-claim-rewards', [Cl.list([]), Cl.uint(C1), Cl.principal(vaultLive)], (v) => ok(v) && num(v.match(/total-rewards u\d+/)?.[0]) > 0n, STRANGER);
s.tx('vault rests the sBTC on Jing (jing-place, Lazer update)', vaultLive, 'jing-place', [update], ok, STRANGER);
s.advance(289, 'vault patience window (288 blocks)');
s.tx('vault reclaims from Jing', vaultLive, 'jing-reclaim', [], ok, STRANGER);
s.ev('stacks-block-time at router sale', POX, 'stacks-block-time');
s.tx('router sells the sBTC for STX (router-swap, Lazer update)', vaultLive, 'router-swap', [update], ok, STRANGER);
s.advance(1, 'router cooldown');
s.tx('router-swap again (only if a chunk is left; err is fine)', vaultLive, 'router-swap', [update], () => true, STRANGER);
const pot = s.tx('finalize-swap: the STX pot', POOL_SBTC, 'finalize-swap', [Cl.principal(vaultLive)], (v) => /^\(ok u[1-9]\d*\)$/.test(v), STRANGER);
const owedG = s.ev('[Grow STX] get-stx-owed (uSTX) for the safe', POOL_SBTC, `(get-stx-owed u${C1} u0 '${G.id})`, (v) => num(v) > 0n);
const accG0 = s.acct('[Grow STX] safe before payout', G.id, (v) => u('unlocked')(v) === 0n);
s.tx('[Grow STX] pay-stx-stakers([safe, staker1, staker2]) in STX', POOL_SBTC, 'pay-stx-stakers', [Cl.list([Cl.principal(G.id), ...HELPERS.map((h) => Cl.principal(h))]), Cl.uint(C1), Cl.uint(0)], ok, STRANGER);
const accG1 = s.acct('[Grow STX] safe after payout', G.id, (v) => u('unlocked')(v) > 0n);
s.ev('tranche fully paid', POOL_SBTC, `(is-tranche-fully-paid u${C1} u0)`, 'true');
s.tx('[Grow STX] a stranger cannot restake -> u4001', G.id, 'restake', [], '(err u4001)', STRANGER);
const restake = s.tx('[Grow STX] keeper (chavita SPV9K21) restake()', G.id, 'restake', [], ok, DEP);
const accG2 = s.acct('[Grow STX] all STX locked again', G.id, (v) => u('unlocked')(v) === 0n);
const infoG = s.ev('[Grow STX] pox-5 position after restake', POX, `(get-staker-info '${G.id})`, (v) => v.includes(POOL_SBTC));

const r = await s.run('juice-safes-rewards', (a) => {
  const owed = num(a(owedE2)), delta = num(a(balE1)) - num(a(balE0));
  const paidG = u('unlocked')(a(accG1)) - u('unlocked')(a(accG0));
  const restaked = u('amount')(a(restake));
  const amt = u('amount-ustx')(a(infoG));
  const claimed = num(a(claimE).match(/total-rewards u\d+/)?.[0]);
  const ratio = Number(STAKE) / Number(num(a(shares.stxPool)));
  return [
    ['Earn BTC safe sBTC grew by exactly get-stx-owed', delta === owed && owed > 0n, `+${delta} sats (owed ${owed})`, '1a EARN'],
    ['Earn BTC share matches stake / pool shares x claim (fee 0)', Math.abs(Number(delta) - Number(claimed) * ratio) <= 1, `${delta} vs ${(Number(claimed) * ratio).toFixed(2)} (claim ${claimed})`, '1a EARN'],
    ['Grow STX safe got exactly get-stx-owed in STX', paidG === num(a(owedG)) && paidG > 0n, `+${paidG} uSTX (owed ${num(a(owedG))}, pot ${num(a(pot))})`, '1b GROW'],
    ['restake locked exactly the payout', restaked === paidG, `${restaked} vs ${paidG}`, '1b GROW'],
    ['pox-5 amount = 1,000 STX + payout', amt === STAKE + paidG, `${amt}`, '1b GROW'],
  ];
});
if (r.failed.length) process.exit(1);
