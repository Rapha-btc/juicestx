// stxer COVERAGE sim -- tier 2 + tier 3 gaps left by the lifecycle and guards
// sims. Money-correctness claims we asserted from reading pox-5 but never
// demonstrated, plus the remaining unexercised entry points.
// Original header follows.
// stxer mainnet-fork END-TO-END lifecycle sim for juice-pool-stx-signer.
// Run: node simulations/pool-stx-signer-lifecycle-sim.mjs
//
// Uses the REAL DEPLOYED pox-5. No shim, no injection, no doctored contract.
// Epoch 4.0 activated at burn 960,230 on 2026-07-30, so pox-5 is a genuine
// mainnet boot contract now.
//
// The one thing that looked unsimulatable -- rewards arriving -- turns out to be
// trivial. pox-5 computes new rewards as:
//     get-rewards = (its own sBTC balance) - staked-sbtc - reserve
// so "rewards arrived" just means sBTC landed in the pox-5 contract. We send it
// from a real whale and calculate-rewards distributes it by share, exactly as
// mainnet does. 15% is skimmed to reserve (RESERVE_RATIO u1500).
//
// Lifecycle covered:
//   deploy -> register-self (generated signer key) -> stakers stake ->
//   advance into cycle 141 -> inject sBTC -> calculate-rewards ->
//   pox-claim-rewards (tranche 0) -> pay SOME stakers -> inject again ->
//   tranche 1 -> pay ALL -> prove tranche 1 is unharmed by the tranche-0 hole.

import { SimulationBuilder, getSimulationResult } from "stxer";
import {
  ClarityVersion, uintCV, boolCV, principalCV, contractPrincipalCV,
  listCV, noneCV, bufferCV,
  randomPrivateKey, privateKeyToPublic, signMessageHashRsv,
} from "@stacks/transactions";
import { readFileSync } from "node:fs";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22"; // chavita.btc
const POOL_NAME = "juice-pool-stx-signer";
const POOL_ID = `${DEPLOYER}.${POOL_NAME}`;
const POX5_ADDR = "SP000000000000000000002Q6VF78";
const POX5_ID = `${POX5_ADDR}.pox-5`;
const SBTC_ADDR = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_ID = `${SBTC_ADDR}.sbtc-token`;
const WHALE = "SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1"; // 808 sBTC
const NODE = "http://77.42.3.101/stacks-api";

const AUTH_ID = 1;
const NUM_CYCLES = 96;          // proven value (Friedger used it today)
const REWARD_SATS = 100_000_000; // 1 sBTC per injection
const CYCLE = 141;
// Must sit INSIDE the current cycle (140): pox-5 requires
// first-reward-cycle == 1 + burn-height-to-reward-cycle(start-burn-ht).
// Passing 0 underflows against first-burnchain-block-height.
const START_BURN_HT = 960_300;               // first pox-5 cycle our stakers land in

// Real juice-pool-v0 stakers (from register-stakers cycle 139), amounts in uSTX.
// All verified unlocked. friedgerpool is included ON PURPOSE: he already staked
// into Fast Pool today, so pox-5 must reject him with ERR_ALREADY_STAKED.
const STAKERS = [
  { a: "SMMEZR3PBHR14R42ZBMSVXS9RZV0H5TWGFANJ711", stx: 238_300_000_000, og: true  },
  { a: "SMAQBT70FCQQQZ56DJW0YKDY5SXPSN1KD8DJ8WPP", stx: 112_612_000_000, og: false },
  { a: "SM1QR2SKD92NXY96TV612FWGP4YBZXG1A7K3TP6ZY", stx:  60_331_000_000, og: true  },
  { a: "SM3EQ9BJHDEQN982YFZCRKY0WVYY64H8VR5FYQAFQ", stx:  59_956_000_000, og: false },
  { a: "SP3A4CP63QJB1R0EJR3TJ1PN16FC5HVJSPT77C8C0", stx:  42_008_000_000, og: false },
  { a: "SPZSQNQF9SM88N00K4XYV05ZAZRACC748T78P5P3",  stx:  26_000_000_000, og: true  },
  { a: "SPT298DGTCVJFTBYJJTWG14K6D2ZX1VG669EA36F",  stx:  17_544_000_000, og: false },
  { a: "SP3TS3T9GSGFEDW7ZBJNFXMH6RY0AP7HNCQEE77DH", stx:  10_007_000_000, og: false },
];
const ALREADY_STAKED = "SP1Y6ZAD2ZZFKNWN58V8EA42R3VRWFJSGWFAD9C36"; // friedgerpool.btc
// Deliberately withheld from tranche 0 so we can prove tranche 1 still works.
const WITHHELD = STAKERS[4].a;

// --- Signer key. pox-5 only requires the signature to recover to whatever
// pubkey we pass, so a throwaway key proves the whole registration path without
// touching the real juice signer key.
const privKey = randomPrivateKey();
const signerKey = privateKeyToPublic(privKey); // 33-byte compressed

// --- Ask the DEPLOYED pox-5 what hash the signer must sign.
async function callReadOnly(contract, fn, args, sender = DEPLOYER) {
  const [addr, name] = contract.split(".");
  const res = await fetch(`${NODE}/v2/contracts/call-read/${addr}/${name}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sender, arguments: args }),
  });
  return res.json();
}

// serializeCV returns a hex STRING in @stacks/transactions v7, not bytes.
const { serializeCV } = await import("@stacks/transactions");
const hexArg = (cv) => "0x" + serializeCV(cv).replace(/^0x/, "");
const poolPrincipalHex = hexArg(contractPrincipalCV(DEPLOYER, POOL_NAME));
const authIdHex = hexArg(uintCV(AUTH_ID));

const hashRes = await callReadOnly(POX5_ID, "get-signer-grant-message-hash",
  [poolPrincipalHex, authIdHex]);
if (!hashRes.okay) {
  console.error("could not get grant message hash:", JSON.stringify(hashRes));
  process.exit(1);
}
// result is a (buff 32) clarity value: 0x02 + 4-byte len + 32 bytes
const msgHash = hashRes.result.replace(/^0x/, "").slice(2 + 8);
const signerSig = signMessageHashRsv({ messageHash: msgHash, privateKey: privKey });

console.log("signer key :", signerKey);
console.log("grant hash :", msgHash);
console.log("signature  :", signerSig.slice(0, 24) + "...");

// --- Build the simulation -----------------------------------------------------
const steps = [];
const sim = SimulationBuilder.new().withSender(DEPLOYER);
const poolCV = () => contractPrincipalCV(DEPLOYER, POOL_NAME);

const evalCode = (label, code, target = POOL_ID) => {
  steps.push(label); sim.addEvalCode(target, code);
};
const call = (label, fn, args, sender = DEPLOYER, contract = POOL_ID) => {
  steps.push(label);
  sim.addContractCall({ contract_id: contract, function_name: fn, function_args: args, sender });
};

// 1. sanity on the real pox-5
steps.push("REAL pox-5 current-pox-reward-cycle");
sim.addEvalCode(POX5_ID, `(current-pox-reward-cycle)`);

// 2. deploy
steps.push(`DEPLOY ${POOL_NAME} at chavita.btc`);
sim.addContractDeploy({
  contract_name: POOL_NAME, source_code:
    readFileSync(new URL(`../contracts/pox-5/${POOL_NAME}.clar`, import.meta.url), "utf8"),
  deployer: DEPLOYER, clarity_version: ClarityVersion.Clarity5,
});

// 3. register the signer (grant + register in one call)
call("register-self (grant + register) -> expect ok", "register-self",
  [poolCV(), bufferCV(Buffer.from(signerKey.replace(/^0x/, ""), "hex")), uintCV(AUTH_ID),
   bufferCV(Buffer.from(signerSig.replace(/^0x/, ""), "hex"))]);
evalCode("pox-5 get-signer-info(pool) -> expect (some ...)",
  `(get-signer-info '${POOL_ID})`, POX5_ID);

// 4. mark OGs before anyone stakes
call("propose-fee-bips u500 (5% for non-OGs)", "propose-fee-bips", [uintCV(500)]);
for (const s of STAKERS.filter((s) => s.og)) {
  call(`set-og ${s.a.slice(0, 8)} true`, "set-og", [principalCV(s.a), boolCV(true)]);
}

// 5. stakers stake into OUR signer
const stakeArgs = (amt) => [poolCV(), uintCV(amt), uintCV(NUM_CYCLES), uintCV(START_BURN_HT), noneCV()];
for (const s of STAKERS) {
  call(`STAKE ${s.a.slice(0, 8)} ${(s.stx / 1e6).toLocaleString()} STX`,
    "stake", stakeArgs(s.stx), s.a, POX5_ID);
}
call(`STAKE friedgerpool -> EXPECT ERR_ALREADY_STAKED`,
  "stake", stakeArgs(1_000_000_000), ALREADY_STAKED, POX5_ID);

evalCode(`pox-5 signer shares for cycle ${CYCLE}`,
  `(get-signer-shares-staked-for-cycle '${POOL_ID} u${CYCLE} none)`, POX5_ID);

// 6. advance into cycle 141 so calculate-rewards credits OUR cycle
steps.push("ADVANCE 2900 blocks -> burn ~963220, past dist boundary 963200");
sim.addAdvanceBlocks({ bitcoin_blocks: 2900, stacks_blocks_per_bitcoin: 1 });
call("confirm-fee-bips (cooldown 144 elapsed) -> expect ok", "confirm-fee-bips", []);
evalCode("get-fee-bips -> expect u500", `(get-fee-bips)`);
steps.push("pox-5 current-pox-reward-cycle after advance");
sim.addEvalCode(POX5_ID, `(current-pox-reward-cycle)`);

// 7. TRANCHE 0 -- inject 1 sBTC as rewards, compute, claim
call("WHALE sends 1 sBTC to pox-5 (this IS the reward)", "transfer",
  [uintCV(REWARD_SATS), principalCV(WHALE), principalCV(POX5_ID), noneCV()], WHALE, SBTC_ID);
call("pox-5 calculate-rewards", "calculate-rewards", [listCV([])], DEPLOYER, POX5_ID);
evalCode("pox-5 unclaimed for our signer", `(get-unclaimed-signer-rewards u${CYCLE} none)`);
call("pox-claim-rewards -> TRANCHE 0", "pox-claim-rewards", [listCV([]), uintCV(CYCLE)]);
evalCode("get-tranche-count -> expect u1", `(get-tranche-count u${CYCLE})`);
evalCode("tranche 0 pot", `(get-stx-pot u${CYCLE} u0)`);
evalCode("effective fee, non-OG -> expect u500", `(get-effective-fee-bips '${STAKERS[1].a})`);
evalCode("effective fee, OG -> expect u0", `(get-effective-fee-bips '${STAKERS[0].a})`);

// ===== TIER 2 =====

// --- A. duplicate staker in ONE list, and a principal with ZERO shares -------
// Idempotency was proven ACROSS calls. A backend bug producing [alice, alice]
// in a single call is at least as likely. And a bad list may contain someone
// who never staked -- they must be skipped, not paid.
const ALICE = STAKERS[0].a;                       // OG, 238,300 STX
const NEVER_STAKED = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";
evalCode("alice unpaid before", `(get-stx-paid u${CYCLE} u0 '${ALICE})`);
call("pay-stx-stakers [alice, alice, never-staked] -> alice paid ONCE",
  "pay-stx-stakers",
  [listCV([principalCV(ALICE), principalCV(ALICE), principalCV(NEVER_STAKED)]),
   uintCV(CYCLE), uintCV(0)]);
evalCode("alice paid exactly her share (not doubled)",
  `(get-stx-paid u${CYCLE} u0 '${ALICE})`);
evalCode("never-staked principal -> expect none (skipped, not paid)",
  `(get-stx-paid u${CYCLE} u0 '${NEVER_STAKED})`);
evalCode("tranche-paid-shares counted alice ONCE",
  `(get-tranche-paid-shares u${CYCLE} u0)`);

// --- B. unstake mid-cycle, then STILL get paid for that cycle ----------------
// We documented this from pox-5's source (unstake removes shares only from
// current-cycle + 1 onward) but never demonstrated it. It is a money claim.
const LEAVER = STAKERS[1].a;                      // non-OG, 112,612 STX
evalCode("leaver's cycle-141 shares BEFORE unstaking",
  `(get-staker-shares-staked-for-cycle '${LEAVER} u${CYCLE} none '${POOL_ID})`, POX5_ID);
call("LEAVER calls pox-5 unstake", "unstake", [poolCV()], LEAVER, POX5_ID);
evalCode("leaver's cycle-141 shares AFTER unstaking -> must be UNCHANGED",
  `(get-staker-shares-staked-for-cycle '${LEAVER} u${CYCLE} none '${POOL_ID})`, POX5_ID);
evalCode("leaver's shares for the NEXT cycle -> should be gone",
  `(get-staker-shares-staked-for-cycle '${LEAVER} u142 none '${POOL_ID})`, POX5_ID);
call("pay the LEAVER for cycle 141 anyway -> must still work",
  "pay-stx-stakers", [listCV([principalCV(LEAVER)]), uintCV(CYCLE), uintCV(0)]);
evalCode("leaver got paid despite having left",
  `(get-stx-paid u${CYCLE} u0 '${LEAVER})`);

// ===== TIER 3 =====

// --- C. cancel-fee-bips and ERR_NO_PENDING_FEE ------------------------------
call("propose-fee-bips u1000", "propose-fee-bips", [uintCV(1000)]);
evalCode("pending fee -> (some u1000)", `(get-pending-fee)`);
call("cancel-fee-bips -> expect ok", "cancel-fee-bips", []);
evalCode("pending fee cleared -> none", `(get-pending-fee)`);
call("confirm-fee-bips with nothing pending -> EXPECT ERR_NO_PENDING_FEE u113",
  "confirm-fee-bips", []);
evalCode("live fee unchanged by the cancelled proposal", `(get-fee-bips)`);

// --- D. pox-settle-stakers ---------------------------------------------------
// Moves no funds; brings pox-5's per-staker view forward so its read-onlys stop
// reporting paid users as unclaimed. Exercised by RV, never by stxer.
call("pox-settle-stakers (all 8) -> expect ok", "pox-settle-stakers",
  [listCV(STAKERS.map((s) => principalCV(s.a))), uintCV(CYCLE), noneCV()]);

// --- E. a cycle with ZERO total shares --------------------------------------
// pay-one guards with (if (is-eq total-shares u0) u0 ...). Nobody staked cycle
// 999, so this must return ok u0 rather than dividing by zero.
evalCode("total shares for an unstaked cycle -> u0", `(get-cycle-total-shares u999)`);
call("pay-stx-stakers on a cycle nobody staked -> ok u0, no divide-by-zero",
  "pay-stx-stakers", [listCV([principalCV(ALICE)]), uintCV(999), uintCV(0)]);
evalCode("is-tranche-fully-paid on empty cycle", `(is-tranche-fully-paid u999 u0)`);

// --- F. set-admin rotation: old loses power, new gains it -------------------
const NEW_ADMIN = "SP1Y6ZAD2ZZFKNWN58V8EA42R3VRWFJSGWFAD9C36";
call("set-admin -> NEW_ADMIN", "set-admin", [principalCV(NEW_ADMIN)]);
evalCode("get-admin -> new admin", `(get-admin)`);
call("OLD admin tries set-og -> EXPECT ERR_UNAUTHORIZED u100",
  "set-og", [principalCV(ALICE), boolCV(true)], DEPLOYER);
call("NEW admin does set-og -> expect ok",
  "set-og", [principalCV(ALICE), boolCV(true)], NEW_ADMIN);
evalCode("alice is now an OG (new admin's write landed)", `(is-og '${ALICE})`);

// --- run ---------------------------------------------------------------------
const id = await sim.run();
console.log("simulation id:", id);
console.log(`https://stxer.xyz/simulations/mainnet/${id}`);
const result = await getSimulationResult(id);
console.log("epoch:", result.metadata?.epoch, "| burn:", result.metadata?.burn_block_height);
result.steps.forEach((s, i) => {
  console.log("---", steps[i] ?? `step ${i}`);
  console.log(JSON.stringify(s.Result).slice(0, 240));
});
