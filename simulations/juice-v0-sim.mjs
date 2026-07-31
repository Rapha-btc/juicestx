// stxer mainnet-fork simulation for juice-v0
// Run: node simulations/juice-v0-sim.mjs
//
// Covers the full lifecycle on REAL cycle 134 / 135 data + every error path,
// asserting each payout from the distribute tx's sBTC ft_transfer events
// (robust even when a real delegator already holds sBTC).
//
// DATA NOTES
//  - Deployer/owner = SPV9K21... (the real intended deployer).
//  - Funder        = SP2C7... (sBTC-rich; calls fund(), which anyone may call).
//  - STX amounts are REAL. Addresses are REAL where resolvable:
//      * .btc names resolved via BNS.
//      * SPC7SY... and SPZSQN... given/known in full.
//      * 4 truncated/unresolvable principals (SP55J9, SP11XC, SMMEZR, chainlist.stx)
//        use deterministic PLACEHOLDERs -- marked below; swap in real ones later.
//  - Cycle 135 includes SPC7SY at its real cycle-135 stake (17,022,674,501 uSTX);
//    the admin page shows it as 0/Revoked because that's its CURRENT (136) state.
//  - REWARD_135 (sats) is still PROVISIONAL -- confirm the real net sBTC.

import { SimulationBuilder, getSimulationResult } from "stxer";
import {
  ClarityVersion,
  uintCV,
  listCV,
  tupleCV,
  standardPrincipalCV,
  getAddressFromPrivateKey,
} from "@stacks/transactions";
import { readFileSync } from "node:fs";

const SBTC_ID = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const OWNER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22"; // deployer/owner
const FUNDER = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2"; // sBTC-rich, funds the pool
const CONTRACT_NAME = "juice-v0";
const JUICE_ID = `${OWNER}.${CONTRACT_NAME}`;
const source = readFileSync(new URL("../contracts/juice-v0.clar", import.meta.url), "utf8");

// Reward pools = NET sBTC that landed after Emily bridge fees (sats).
const REWARD_134 = 88_566n; // confirmed: 9761+14761+14761+19761+14761+14761
const REWARD_135 = 139_891n; // PROVISIONAL -- confirm real net

const uSTX = (stx) => BigInt(Math.round(stx * 1_000_000));

// Deterministic placeholders for principals we couldn't resolve in full.
let seed = 0;
const placeholder = () => {
  seed += 1;
  return getAddressFromPrivateKey(seed.toString(16).padStart(64, "0") + "01", "mainnet");
};
const PH = { // labelled placeholders (real address unknown / unresolvable)
  "SP55J9...N6CD": placeholder(),
  "SP11XC...8N9Z": placeholder(),
  "SMMEZR...J711": placeholder(),
  "chainlist.stx": placeholder(),
};

// Resolved real principals.
const ADDR = {
  "SPZSQN...P5P3": "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3",
  "SPC7SY...151P": "SPC7SY8R9NQ0KKFBGD2KA2VKV8A7WVMTX541151P",
  "auds.btc": "SP781P5F0AR41A7H5AD4P8ZVVBM6D8H5TYNJHPCK",
  "moofv.btc": "SP38B5H07H1XJ756EEPMS8VBJE9HPGH03C50VPNAJ",
  "wutdufuq.btc": "SP33JQ5QJVQVQYYWVDMSRCZR81WS4N1KWP6YR94VH",
  "web3musicmag.btc": "SP3TS3T9GSGFEDW7ZBJNFXMH6RY0AP7HNCQEE77DH",
  "thommy.btc": "SPY3VW50YQCEWD905SSBPVF55D1E502ZV24TE2M6",
  "raccoonsito.btc": "SP218F71JZ4R2ERQDKEBGA1FKVAQNZBM3HK7W8EA7",
  "deadwood.btc": "SPT298DGTCVJFTBYJJTWG14K6D2ZX1VG669EA36F",
  "chadstx.btc": "SP3WAAYXPC6WZNEC7SHGR36D32RJPZVXRR1BG0QSY",
  "friedgerpool.btc": "SP1Y6ZAD2ZZFKNWN58V8EA42R3VRWFJSGWFAD9C36",
  "jamief.btc": "SP389APB4DHZ836P4AE9RJW7EKEZAPV5NPDNG7N46",
  "peacelovemusic.btc": "SP2Z2CBMGWB9MQZAF5Z8X56KS69XRV3SJF4WKJ7J9",
  "wtflol.btc": "SPV00QHST52GD7D0SEWV3R5N04RD4Q1PMA3TE2MP",
  "peptoshi.btc": "SP2XBRCMNEZKDT5G2CVB8EXE4K9WZGJVB374XHSMX",
  ...PH,
};
const addrOf = (label) => ADDR[label] ?? PH[label];

const mk = (rows) => rows.map(([label, stx]) => ({ label, addr: addrOf(label), micro: uSTX(stx) }));

// Cycle 134: 3 delegators.
const ROSTER_134 = mk([
  ["SP55J9...N6CD", 4946],
  ["SPZSQN...P5P3", 26000],
  ["SMMEZR...J711", 238300],
]);

// Cycle 135: 19 delegators (SPC7SY at its real 135 stake; peacelovemusic once).
const ROSTER_135 = mk([
  ["auds.btc", 108.54],
  ["moofv.btc", 104.5],
  ["wutdufuq.btc", 261.41],
  ["web3musicmag.btc", 10006.71],
  ["thommy.btc", 503.15],
  ["raccoonsito.btc", 100],
  ["deadwood.btc", 17544.01],
  ["chadstx.btc", 367.63],
  ["friedgerpool.btc", 5000],
  ["jamief.btc", 131.53],
  ["peacelovemusic.btc", 1384.14],
  ["chainlist.stx", 102.28],
  ["wtflol.btc", 375.77],
  ["peptoshi.btc", 259.23],
  ["SP55J9...N6CD", 4946],
  ["SP11XC...8N9Z", 100.9],
  ["SPZSQN...P5P3", 26000],
  ["SMMEZR...J711", 238300],
]);
// SPC7SY: real cycle-135 stake is an exact uSTX figure, not a 2-dp STX value.
ROSTER_135.splice(14, 0, { label: "SPC7SY...151P", addr: addrOf("SPC7SY...151P"), micro: 17_022_674_501n });

function expected(roster, reward) {
  const total = roster.reduce((a, s) => a + s.micro, 0n);
  const shares = roster.map((s) => ({ ...s, share: (reward * s.micro) / total }));
  const paid = shares.reduce((a, s) => a + s.share, 0n);
  return { total, shares, paid, dust: reward - paid };
}
const exp134 = expected(ROSTER_134, REWARD_134);
const exp135 = expected(ROSTER_135, REWARD_135);

const entriesCV = (roster) =>
  listCV(roster.map((s) => tupleCV({ staker: standardPrincipalCV(s.addr), stx: uintCV(s.micro) })));

console.log("Building juice-v0 simulation (real addresses + amounts)...");
console.log(`  cycle 134: ${ROSTER_134.length} stakers, total ${exp134.total} uSTX, reward ${REWARD_134} sats, dust ${exp134.dust}`);
console.log(`  cycle 135: ${ROSTER_135.length} stakers, total ${exp135.total} uSTX, reward ${REWARD_135} sats, dust ${exp135.dust}`);

const sim = SimulationBuilder.new()
  .withSender(OWNER)
  .addContractDeploy({ contract_name: CONTRACT_NAME, source_code: source, clarity_version: ClarityVersion.Clarity4 })

  // ERR_NOT_OWNER: funder (non-owner) cannot register
  .withSender(FUNDER)
  .addContractCall({ contract_id: JUICE_ID, function_name: "register-stakers", function_args: [uintCV(134), entriesCV(ROSTER_134)] })

  // Cycle 134: register
  .withSender(OWNER)
  .addContractCall({ contract_id: JUICE_ID, function_name: "register-stakers", function_args: [uintCV(134), entriesCV(ROSTER_134)] })
  .addEvalCode(JUICE_ID, "(get-total-stx)")
  // OVERWRITE BEFORE DISTRIBUTION: re-submit 134 smaller, then restore
  .addContractCall({ contract_id: JUICE_ID, function_name: "register-stakers", function_args: [uintCV(134), entriesCV(ROSTER_134.slice(0, 2))] })
  .addEvalCode(JUICE_ID, "(get-total-stx)")
  .addContractCall({ contract_id: JUICE_ID, function_name: "register-stakers", function_args: [uintCV(134), entriesCV(ROSTER_134)] })
  .addEvalCode(JUICE_ID, "(get-total-stx)")

  // ERR_NO_REWARD: distribute before funding
  .addContractCall({ contract_id: JUICE_ID, function_name: "distribute", function_args: [uintCV(134)] })

  // Fund (as funder) + distribute
  .withSender(FUNDER)
  .addContractCall({ contract_id: JUICE_ID, function_name: "fund", function_args: [uintCV(REWARD_134)] })
  .withSender(OWNER)
  .addContractCall({ contract_id: JUICE_ID, function_name: "distribute", function_args: [uintCV(134)] })

  // Error cluster after 134 distributed
  .addContractCall({ contract_id: JUICE_ID, function_name: "distribute", function_args: [uintCV(134)] })          // ALREADY_DISTRIBUTED
  .addContractCall({ contract_id: JUICE_ID, function_name: "register-stakers", function_args: [uintCV(134), entriesCV(ROSTER_134)] }) // ALREADY_DISTRIBUTED
  .addContractCall({ contract_id: JUICE_ID, function_name: "register-stakers", function_args: [uintCV(133), entriesCV(ROSTER_134)] }) // BACK_TO_THE_FUTURE
  .addContractCall({ contract_id: JUICE_ID, function_name: "distribute", function_args: [uintCV(135)] })          // WRONG_CYCLE

  // Withdraw 134 dust, then cycle 135
  .addContractCall({ contract_id: JUICE_ID, function_name: "withdraw", function_args: [uintCV(exp134.dust)] })
  .addContractCall({ contract_id: JUICE_ID, function_name: "register-stakers", function_args: [uintCV(135), entriesCV(ROSTER_135)] })
  .addEvalCode(JUICE_ID, "(get-total-stx)")
  .addContractCall({ contract_id: JUICE_ID, function_name: "register-stakers", function_args: [uintCV(136), entriesCV(ROSTER_134)] }) // PREVIOUS_NOT_DISTRIBUTED
  .withSender(FUNDER)
  .addContractCall({ contract_id: JUICE_ID, function_name: "fund", function_args: [uintCV(REWARD_135)] })
  .withSender(OWNER)
  .addContractCall({ contract_id: JUICE_ID, function_name: "distribute", function_args: [uintCV(135)] })

  // ERR_NO_STAKERS: empty registration
  .addContractCall({ contract_id: JUICE_ID, function_name: "withdraw", function_args: [uintCV(exp135.dust)] })
  .addContractCall({ contract_id: JUICE_ID, function_name: "register-stakers", function_args: [uintCV(136), listCV([])] })
  .withSender(FUNDER)
  .addContractCall({ contract_id: JUICE_ID, function_name: "fund", function_args: [uintCV(1000)] })
  .withSender(OWNER)
  .addContractCall({ contract_id: JUICE_ID, function_name: "distribute", function_args: [uintCV(136)] })           // NO_STAKERS

  // Ownership rotation: old owner loses access
  .addContractCall({ contract_id: JUICE_ID, function_name: "set-owner", function_args: [standardPrincipalCV(FUNDER)] })
  .addContractCall({ contract_id: JUICE_ID, function_name: "register-stakers", function_args: [uintCV(137), entriesCV(ROSTER_134)] }); // NOT_OWNER

const sessionId = await sim.run();
const url = `https://stxer.xyz/simulations/mainnet/${sessionId}`;
console.log(`\nSimulation submitted: ${url}\n`);
await new Promise((r) => setTimeout(r, 9000));

// ---------------------------------------------------------------------------
// Verify from receipts
// ---------------------------------------------------------------------------
const res = await getSimulationResult(sessionId);

// 1. Error-path coverage: every err code must appear.
const errs = new Set();
const oks = [];
for (const s of res.steps) {
  const hex = s.Result?.Transaction?.Ok?.result;
  if (!hex) continue;
  if (hex.startsWith("0801")) errs.add(Number(BigInt("0x" + hex.slice(4, 36))));
  else if (hex.startsWith("0701")) oks.push(BigInt("0x" + hex.slice(4, 36)));
  else if (hex === "0703") oks.push("ok-true");
}
const wantErrs = [20001, 20002, 20003, 20004, 20005, 20006, 20007];
console.log("=== Error-path coverage ===");
for (const c of wantErrs) console.log(`  ${errs.has(c) ? "PASS" : "MISS"} err u${c}`);

// 2. Overwrite-before-distribution: get-total-stx eval sequence.
const totals = res.steps
  .filter((s) => Array.isArray(s.Eval) && s.Eval[3] === "(get-total-stx)")
  .map((s) => BigInt("0x" + String(s.Result.Eval.Ok).slice(2)));
console.log("\n=== Overwrite-before-distribution (get-total-stx) ===");
console.log(`  register 134 full   : ${totals[0]}  (expect ${exp134.total})`);
console.log(`  re-register 2 only  : ${totals[1]}  (expect ${ROSTER_134.slice(0,2).reduce((a,s)=>a+s.micro,0n)})`);
console.log(`  restore full        : ${totals[2]}  (expect ${exp134.total})`);
console.log(`  register 135        : ${totals[3]}  (expect ${exp135.total})`);

// 3. Per-payout assertions from distribute ft_transfer events.
function outgoing(step) {
  const out = {};
  for (const raw of step.Result?.Transaction?.Ok?.events ?? []) {
    const e = typeof raw === "string" ? JSON.parse(raw) : raw; // stxer serializes events as JSON strings
    const t = e.ft_transfer_event;
    if (t && t.sender === JUICE_ID && t.recipient !== JUICE_ID && t.recipient !== OWNER)
      out[t.recipient] = (out[t.recipient] ?? 0n) + BigInt(t.amount);
  }
  return out;
}
function checkRoster(name, exp) {
  const want = new Set(exp.shares.filter((s) => s.share > 0n).map((s) => s.addr));
  const step = res.steps.find((s) => {
    const o = outgoing(s);
    const keys = Object.keys(o);
    return keys.length > 0 && keys.every((k) => want.has(k)) && keys.length === want.size;
  });
  console.log(`\n=== ${name} payouts (total ${exp.total} uSTX, reward split) ===`);
  if (!step) { console.log("  (distribute step not found)"); return; }
  const o = outgoing(step);
  let ok = 0;
  for (const s of exp.shares) {
    if (s.share === 0n) continue;
    const got = o[s.addr] ?? 0n;
    const pass = got === s.share;
    if (pass) ok += 1;
    console.log(`  ${pass ? "PASS" : "FAIL"} ${s.label.padEnd(22)} ${s.addr.slice(0, 12)}… expect ${String(s.share).padStart(7)}  got ${got}`);
  }
  console.log(`  ${ok}/${exp.shares.filter((s) => s.share > 0n).length} exact, dust ${exp.dust} sats`);
}
checkRoster("Cycle 134", exp134);
checkRoster("Cycle 135", exp135);

console.log(`\nFull step-by-step: ${url}`);
