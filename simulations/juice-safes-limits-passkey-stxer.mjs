// stxer mainnet fork: Juice safes (Earn BTC = juice-safe-v9, Grow STX =
// juice-autostake-safe), live template bytes, onboarded with a REAL P-256 passkey.
//   Section 2 OVER-LIMIT: admin-only requests above the 5,000 STX / 100,000 sats
//     limits queue a pending op; execute before the 144-block cooldown fails
//     (u4017); admin and passkey can each veto; after the cooldown the op executes.
//     Admin-created op + passkey execute-now = immediate; a passkey-created op
//     cannot use execute-now (u4003).
//   Section 3 PASSKEY: WebAuthn sig-auth built like stx-juice-fe (safe-webauthn.ts):
//     transfer within limit, replay (u4006), cross-safe (u4002, domain binding),
//     stake + unstake via passkey, set-keeper via passkey (Grow).
//   Section 4 GAS: gas-station fee (20 sats sBTC) + full-balance sBTC transfer
//     fails with sbtc-token err u1 (known UX issue), balance minus fee succeeds.
// Run: node simulations/juice-safes-limits-passkey-stxer.mjs
import {
  T, ADMIN, OUTSIDE, SBTC, SBTC_WHALE, POX, GAS, KINDS, COOLDOWN, H,
  ok, u, num, get, ro, loadTemplates, newPasskey, sip018, sigAuth, msg, helperExpr, harness, planFunding,
} from './_juice-safes-lib.mjs';
const { Cl } = T;

const STX = 1_000_000;
const OVER_STX = 6_000 * STX, OVER_SATS = 150_000;
const FUND_STX = 13_200 * STX, FUND_SATS = 400_000;
const STAKE = 1_000 * STX, SMALL = 100 * STX;
const STRANGER = 'SP3TS3T9GSGFEDW7ZBJNFXMH6RY0AP7HNCQEE77DH';

await loadTemplates();
const [E, G] = KINDS;
const pk = newPasskey();
const info = await get('/v2/info');
const s = harness({ burn: info.burn_block_height });
console.log(`fork tip burn ${s.burn}, cycle ${s.cycle()} offset ${s.offset()}, gas ${await ro(GAS, 'get-gas')} sats, sponsor ${await ro(GAS, 'get-sponsor')}`);
const funding = await planFunding(KINDS.map((k) => [k.id, FUND_STX]));

let authId = 0;
const sa = (k, message) => { authId += 1; const a = authId; return { a, cv: sigAuth(pk, a, sip018(k.id, message(a))) }; };
const sbtcArgs = (amount, to) => [Cl.uint(amount), Cl.principal(to), Cl.none(), Cl.principal(SBTC), Cl.stringAscii('sbtc-token')];
const isOp = (fields) => (v) => v.startsWith('(some') && fields.every((f) => v.includes(f));
const keep = {};

// -- 1. deploy + onboard + fund -------------------------------------------------
s.section = '1 SETUP';
if (s.offset() > 1500) s.advance(2100 - s.offset() + 20, 'leave the late cycle / prepare phase');
for (const k of KINDS) s.deployOnboard(k, pk.pub);
for (const [from, to, amt] of funding) s.stx(`fund ${to.split('.')[1]} ${Number(amt) / STX} STX from ${from.slice(0, 8)}...`, from, to, amt);
for (const k of KINDS) s.tx(`[${k.kind}] fund ${FUND_SATS} sats sBTC`, SBTC, 'transfer', [Cl.uint(FUND_SATS), Cl.principal(SBTC_WHALE), Cl.principal(k.id), Cl.none()], '(ok true)', SBTC_WHALE);
keep.outStx0 = s.acct('OUTSIDE STX before', OUTSIDE);
keep.outSats0 = s.sbtcBal('OUTSIDE sBTC before', OUTSIDE);

// -- 2. over-limit, one key (admin wallet, no passkey) --------------------------
s.section = '2 OVER-LIMIT';
for (const k of KINDS) {
  const K = `[${k.kind}]`;
  s.tx(`${K} admin stx-transfer 6,000 STX (> 5,000 limit) -> queued, op u0`, k.id, 'stx-transfer', [Cl.uint(OVER_STX), Cl.principal(OUTSIDE), Cl.none(), Cl.none(), Cl.none()], '(ok true)', ADMIN);
  s.ev(`${K} op u0 is a pending stx-transfer, admin-created`, k.id, '(get-pending-operation u0)', isOp(['"stx-transfer"', `amount u${OVER_STX}`, 'executed false', 'passkey-created false']));
  s.acct(`${K} safe still holds all ${FUND_STX / STX} STX (nothing moved)`, k.id, (v) => u('balance')(v) === BigInt(FUND_STX));
  s.tx(`${K} execute op u0 before cooldown -> err-cooldown-not-passed u4017`, k.id, 'execute-pending-stx-transfer', [Cl.uint(0), Cl.none()], '(err u4017)', ADMIN);
  s.tx(`${K} admin sBTC transfer 150,000 sats (> 100,000 limit) -> queued, op u1`, k.id, 'sip010-transfer', [...sbtcArgs(OVER_SATS, OUTSIDE), Cl.none(), Cl.none()], '(ok true)', ADMIN);
  s.ev(`${K} op u1 is a pending sbtc-transfer`, k.id, '(get-pending-operation u1)', isOp(['"sbtc-transfer"', `amount u${OVER_SATS}`]));
  s.sbtcBal(`${K} safe still holds ${FUND_SATS} sats`, k.id, `u${FUND_SATS}`);
  s.tx(`${K} execute sBTC op u1 before cooldown -> u4017`, k.id, 'execute-pending-sbtc-transfer', [Cl.uint(1), Cl.none()], '(err u4017)', ADMIN);
  s.tx(`${K} admin queues stx op u2`, k.id, 'stx-transfer', [Cl.uint(OVER_STX), Cl.principal(OUTSIDE), Cl.none(), Cl.none(), Cl.none()], '(ok true)', ADMIN);
  s.tx(`${K} stranger cannot veto -> u4001`, k.id, 'veto-operation', [Cl.uint(2), Cl.none(), Cl.none()], '(err u4001)', STRANGER);
  s.tx(`${K} ADMIN key vetoes op u2`, k.id, 'veto-operation', [Cl.uint(2), Cl.none(), Cl.none()], '(ok true)', ADMIN);
  s.tx(`${K} admin queues sBTC op u3`, k.id, 'sip010-transfer', [...sbtcArgs(OVER_SATS, OUTSIDE), Cl.none(), Cl.none()], '(ok true)', ADMIN);
  const v3 = sa(k, (a) => msg.veto(a, 3));
  s.tx(`${K} PASSKEY vetoes op u3 (build-veto-operation-hash, sent by a stranger as relay)`, k.id, 'veto-operation', [Cl.uint(3), Cl.some(v3.cv), Cl.none()], '(ok true)', STRANGER);
  s.ev(`${K} op u2 and u3 vetoed`, k.id, '{ a: (get vetoed (unwrap-panic (get-pending-operation u2))), b: (get vetoed (unwrap-panic (get-pending-operation u3))) }', '(tuple (a true) (b true))');
}
s.advance(COOLDOWN + 1, 'past the 144-block cooldown');
for (const k of KINDS) {
  const K = `[${k.kind}]`;
  s.tx(`${K} stranger cannot execute op u0 after cooldown -> u4001`, k.id, 'execute-pending-stx-transfer', [Cl.uint(0), Cl.none()], '(err u4001)', STRANGER);
  s.tx(`${K} admin executes op u0 after cooldown`, k.id, 'execute-pending-stx-transfer', [Cl.uint(0), Cl.none()], '(ok true)', ADMIN);
  s.tx(`${K} op u0 again -> err-already-executed u4014`, k.id, 'execute-pending-stx-transfer', [Cl.uint(0), Cl.none()], '(err u4014)', ADMIN);
  s.tx(`${K} admin executes sBTC op u1 after cooldown`, k.id, 'execute-pending-sbtc-transfer', [Cl.uint(1), Cl.none()], '(ok true)', ADMIN);
  s.tx(`${K} vetoed op u2 -> err-vetoed u4015`, k.id, 'execute-pending-stx-transfer', [Cl.uint(2), Cl.none()], '(err u4015)', ADMIN);
  s.tx(`${K} vetoed sBTC op u3 -> u4015`, k.id, 'execute-pending-sbtc-transfer', [Cl.uint(3), Cl.none()], '(err u4015)', ADMIN);
}
keep.outStx1 = s.acct('OUTSIDE STX after the two cooldown executes', OUTSIDE);
keep.outSats1 = s.sbtcBal('OUTSIDE sBTC after the two cooldown executes', OUTSIDE);
// both keys = immediate: admin creates, passkey signs execute-now
for (const k of KINDS) {
  const K = `[${k.kind}]`;
  s.tx(`${K} admin queues stx op u4`, k.id, 'stx-transfer', [Cl.uint(OVER_STX), Cl.principal(OUTSIDE), Cl.none(), Cl.none(), Cl.none()], '(ok true)', ADMIN);
  const n4 = sa(k, (a) => msg.executeNow(a, 4));
  s.ev(`${K} JS execute-now hash == mm-safe-auth-helpers-v1 in the safe`, k.id, `(is-eq ${helperExpr.executeNow(n4.a, 4)} 0x${sip018(k.id, msg.executeNow(n4.a, 4)).toString('hex')})`, 'true');
  s.tx(`${K} PASSKEY execute-pending-stx-transfer-now op u4 -> immediate`, k.id, 'execute-pending-stx-transfer-now', [Cl.uint(4), Cl.none(), n4.cv, Cl.none()], '(ok true)', STRANGER);
  s.tx(`${K} admin queues sBTC op u5`, k.id, 'sip010-transfer', [...sbtcArgs(OVER_SATS, OUTSIDE), Cl.none(), Cl.none()], '(ok true)', ADMIN);
  const n5 = sa(k, (a) => msg.executeNow(a, 5));
  s.tx(`${K} PASSKEY execute-pending-sbtc-transfer-now op u5 -> immediate`, k.id, 'execute-pending-sbtc-transfer-now', [Cl.uint(5), Cl.none(), n5.cv, Cl.none()], '(ok true)', STRANGER);
  const t6 = sa(k, (a) => msg.stxTransfer(a, OVER_STX, OUTSIDE));
  s.tx(`${K} PASSKEY-signed 6,000 STX transfer -> queued op u6 (passkey-created)`, k.id, 'stx-transfer', [Cl.uint(OVER_STX), Cl.principal(OUTSIDE), Cl.none(), Cl.some(t6.cv), Cl.none()], '(ok true)', STRANGER);
  s.ev(`${K} op u6 passkey-created true`, k.id, '(get-pending-operation u6)', isOp(['passkey-created true']));
  const n6 = sa(k, (a) => msg.executeNow(a, 6));
  s.tx(`${K} passkey execute-now on a passkey-created op -> err-forbidden u4003`, k.id, 'execute-pending-stx-transfer-now', [Cl.uint(6), Cl.none(), n6.cv, Cl.none()], '(err u4003)', STRANGER);
}
keep.outStx2 = s.acct('OUTSIDE STX after execute-now', OUTSIDE);
keep.outSats2 = s.sbtcBal('OUTSIDE sBTC after execute-now', OUTSIDE);

// -- 3. passkey signing path ------------------------------------------------------
s.section = '3 PASSKEY';
let replay;
for (const k of KINDS) {
  const K = `[${k.kind}]`;
  const t = sa(k, (a) => msg.stxTransfer(a, SMALL, OUTSIDE));
  if (k === E) replay = t;
  s.ev(`${K} JS stx-transfer hash == smart-wallet-standard-auth-helpers-v7 in the safe`, k.id, `(is-eq ${helperExpr.stxTransfer(t.a, SMALL, OUTSIDE)} 0x${sip018(k.id, msg.stxTransfer(t.a, SMALL, OUTSIDE)).toString('hex')})`, 'true');
  const before = s.acct(`${K} OUTSIDE before passkey transfer`, OUTSIDE);
  s.tx(`${K} PASSKEY stx-transfer 100 STX (within limit, relayed by a stranger)`, k.id, 'stx-transfer', [Cl.uint(SMALL), Cl.principal(OUTSIDE), Cl.none(), Cl.some(t.cv), Cl.none()], '(ok true)', STRANGER);
  const after = s.acct(`${K} OUTSIDE after passkey transfer`, OUTSIDE);
  keep[`pk_${k.key}`] = [before, after];
  s.tx(`${K} REPLAY of the same sig-auth -> err-signature-replay u4006`, k.id, 'stx-transfer', [Cl.uint(SMALL), Cl.principal(OUTSIDE), Cl.none(), Cl.some(t.cv), Cl.none()], '(err u4006)', STRANGER);
}
s.tx('[Grow STX] Earn-safe signature submitted to the Grow safe -> err-invalid-signature u4002 (domain = safe)', G.id, 'stx-transfer', [Cl.uint(SMALL), Cl.principal(OUTSIDE), Cl.none(), Cl.some(replay.cv), Cl.none()], '(err u4002)', STRANGER);
for (const k of KINDS) {
  const K = `[${k.kind}]`;
  const st = sa(k, (a) => msg.stake(a, STAKE));
  s.tx(`${K} PASSKEY stake-stx-juice 1,000 STX (juice-safe-auth-helpers-v2)`, k.id, 'stake-stx-juice', [Cl.uint(STAKE), Cl.some(st.cv), Cl.none(), Cl.none()], '(ok true)', STRANGER);
  s.ev(`${K} pox-5 position with ${k.pool.split('.')[1]}`, POX, `(get-staker-info '${k.id})`, (v) => v.includes(k.pool) && v.includes(`amount-ustx u${STAKE}`));
  const un = sa(k, (a) => msg.unstake(a));
  s.tx(`${K} PASSKEY unstake (juice-safe-auth-helpers-v1)`, k.id, 'unstake', [Cl.some(un.cv), Cl.none()], '(ok true)', STRANGER);
  s.ev(`${K} pox-5 position after unstake (unlocks next cycle)`, POX, `(get-staker-info '${k.id})`);
}
const kp = sa(G, (a) => msg.setKeeper(a, OUTSIDE));
s.ev('[Grow STX] JS set-keeper hash == juice-autostake-safe-auth-helpers-v1', G.id, `(is-eq ${helperExpr.setKeeper(kp.a, OUTSIDE)} 0x${sip018(G.id, msg.setKeeper(kp.a, OUTSIDE)).toString('hex')})`, 'true');
s.tx('[Grow STX] PASSKEY set-keeper -> OUTSIDE', G.id, 'set-keeper', [Cl.principal(OUTSIDE), Cl.some(kp.cv), Cl.none()], '(ok true)', STRANGER);
s.ev('[Grow STX] get-keeper', G.id, '(get-keeper)', OUTSIDE);
s.tx('[Grow STX] same set-keeper sig replayed -> u4006', G.id, 'set-keeper', [Cl.principal(OUTSIDE), Cl.some(kp.cv), Cl.none()], '(err u4006)', STRANGER);

// -- 4. gas param + full-balance sBTC transfer ------------------------------------
s.section = '4 GAS';
const left = FUND_SATS - 2 * OVER_SATS; // ops u1 + u5 executed, u3 vetoed
const gasFee = Number(num(await ro(GAS, 'get-gas')));
const sponsor = (await ro(GAS, 'get-sponsor')).trim();
s.sbtcBal(`[Earn BTC] safe sBTC = ${left}`, E.id, `u${left}`);
const sponsor0 = s.sbtcBal('gas sponsor sBTC before', sponsor);
const g1 = sa(E, (a) => msg.sip010(a, left, OUTSIDE, SBTC));
s.tx(`[Earn BTC] PASSKEY send FULL ${left} sats WITH gas -> gas takes ${gasFee} first, transfer fails sbtc-token err u1 (KNOWN UX BUG)`, E.id, 'sip010-transfer', [...sbtcArgs(left, OUTSIDE), Cl.some(g1.cv), Cl.some(Cl.principal(GAS))], '(err u1)', STRANGER);
s.sbtcBal('[Earn BTC] safe sBTC unchanged (whole tx rolled back)', E.id, `u${left}`);
const g2 = sa(E, (a) => msg.sip010(a, left - gasFee, OUTSIDE, SBTC));
s.tx(`[Earn BTC] PASSKEY send ${left - gasFee} sats (balance - gas) WITH gas -> ok`, E.id, 'sip010-transfer', [...sbtcArgs(left - gasFee, OUTSIDE), Cl.some(g2.cv), Cl.some(Cl.principal(GAS))], '(ok true)', STRANGER);
s.sbtcBal('[Earn BTC] safe sBTC is 0', E.id, 'u0');
const sponsor1 = s.sbtcBal('gas sponsor sBTC after', sponsor);
s.tx('[Grow STX] ADMIN sends 1,000 sats WITH the gas param -> ok, but gas is only charged on the passkey path', G.id, 'sip010-transfer', [...sbtcArgs(1000, OUTSIDE), Cl.none(), Cl.some(Cl.principal(GAS))], '(ok true)', ADMIN);
const sponsor2 = s.sbtcBal('gas sponsor sBTC after the admin send (unchanged)', sponsor);

const r = await s.run('juice-safes-limits-passkey', (a) => {
  const stx = (i) => u('balance')(a(i)), sat = (i) => num(a(i));
  const out = [
    ['OUTSIDE got 2 x 6,000 STX after the cooldown (one per safe)', stx(keep.outStx1) - stx(keep.outStx0) === BigInt(2 * OVER_STX), `${stx(keep.outStx1) - stx(keep.outStx0)}`, '2 OVER-LIMIT'],
    ['OUTSIDE got 2 x 150,000 sats after the cooldown', sat(keep.outSats1) - sat(keep.outSats0) === BigInt(2 * OVER_SATS), `${sat(keep.outSats1) - sat(keep.outSats0)}`, '2 OVER-LIMIT'],
    ['execute-now moved 2 x 6,000 STX immediately', stx(keep.outStx2) - stx(keep.outStx1) === BigInt(2 * OVER_STX), `${stx(keep.outStx2) - stx(keep.outStx1)}`, '2 OVER-LIMIT'],
    ['execute-now moved 2 x 150,000 sats immediately', sat(keep.outSats2) - sat(keep.outSats1) === BigInt(2 * OVER_SATS), `${sat(keep.outSats2) - sat(keep.outSats1)}`, '2 OVER-LIMIT'],
    ['gas sponsor received exactly the gas fee once', sat(sponsor1) - sat(sponsor0) === BigInt(gasFee), `${sat(sponsor1) - sat(sponsor0)}`, '4 GAS'],
    ['admin path ignored the gas param (sponsor unchanged)', sat(sponsor2) === sat(sponsor1), `${sat(sponsor1)} -> ${sat(sponsor2)}`, '4 GAS'],
  ];
  for (const k of KINDS) { const [b0, b1] = keep[`pk_${k.key}`]; out.push([`[${k.kind}] passkey transfer landed 100 STX`, stx(b1) - stx(b0) === BigInt(SMALL), `${stx(b1) - stx(b0)}`, '3 PASSKEY']); }
  return out;
});
if (r.failed.length) process.exit(1);
