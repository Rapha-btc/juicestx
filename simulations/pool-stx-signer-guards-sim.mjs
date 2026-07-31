// stxer GUARDS sim -- the safety mechanisms the lifecycle sim never exercises.
//   1. ERR_TRANCHE_TOO_SOON  the anti-griefing gate (claim twice in one
//                            distribution cycle must fail)
//   2. ERR_PAUSED            set-paused must block NEW stakes at pox-5,
//                            via validate-stake! reverting the user's tx
//   3. ERR_NOT_POX5          validate-stake! called directly must be refused
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
// Hold the LAST staker back -- used below to prove the pause gate blocks new
// stakes and that unpausing lets them straight back in.
const HELD_BACK = STAKERS[STAKERS.length - 1];
for (const s of STAKERS.slice(0, -1)) {
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

// --- GUARD 1: the anti-griefing gate --------------------------------------
// Tranche 0 was just opened in this distribution cycle. A second claim for the
// same reward cycle, in the same distribution cycle, MUST be refused -- that is
// the whole purpose of last-claim-dist-cycle. Without it anyone could open
// unbounded dust tranches, each costing a full payout pass over every staker.
evalCode("bookmark after tranche 0", `(get-last-claim-dist-cycle u${CYCLE})`);
call("pox-claim-rewards AGAIN, same dist cycle -> EXPECT ERR_TRANCHE_TOO_SOON u112",
  "pox-claim-rewards", [listCV([]), uintCV(CYCLE)]);
evalCode("tranche-count still u1 (no second tranche opened)",
  `(get-tranche-count u${CYCLE})`);

// Even with MORE rewards waiting, the gate still holds within the same
// distribution cycle -- it is a rate limit, not a "nothing to claim" check.
call("WHALE sends another 1 sBTC", "transfer",
  [uintCV(REWARD_SATS), principalCV(WHALE), principalCV(POX5_ID), noneCV()], WHALE, SBTC_ID);
call("pox-claim-rewards with rewards waiting -> STILL ERR_TRANCHE_TOO_SOON u112",
  "pox-claim-rewards", [listCV([]), uintCV(CYCLE)]);
evalCode("tranche-count STILL u1", `(get-tranche-count u${CYCLE})`);

// --- GUARD 2: the pause switch --------------------------------------------
// validate-stake! is pox-5's admission callback. Returning err reverts the
// staker's transaction inside pox-5 itself, which is the only way to stop new
// inflow. Untested until now.
evalCode("is-paused -> false", `(is-paused)`);
call("set-paused true", "set-paused", [boolCV(true)]);
evalCode("is-paused -> true", `(is-paused)`);
call(`STAKE ${HELD_BACK.a.slice(0, 8)} WHILE PAUSED -> EXPECT ERR_PAUSED u101`,
  "stake", [poolCV(), uintCV(HELD_BACK.stx), uintCV(NUM_CYCLES), uintCV(963_220), noneCV()],
  HELD_BACK.a, POX5_ID);
evalCode("signer shares unchanged (the stake really was rejected)",
  `(get-signer-shares-staked-for-cycle '${POOL_ID} u142 none)`, POX5_ID);

call("set-paused false", "set-paused", [boolCV(false)]);
call(`STAKE ${HELD_BACK.a.slice(0, 8)} after unpause -> expect ok`,
  "stake", [poolCV(), uintCV(HELD_BACK.stx), uintCV(NUM_CYCLES), uintCV(963_220), noneCV()],
  HELD_BACK.a, POX5_ID);

// --- GUARD 3: only pox-5 may call the callback ----------------------------
// Anyone can invoke a public function. If this guard were missing, a forged
// admission could be recorded and our indexer would see a phantom staker.
call("validate-stake! called DIRECTLY -> EXPECT ERR_NOT_POX5 u102",
  "validate-stake!",
  [principalCV(DEPLOYER), uintCV(CYCLE), uintCV(1), uintCV(1_000_000), uintCV(0),
   boolCV(false), noneCV()]);

// --- run ---------------------------------------------------------------------
const id = await sim.run();
console.log("simulation id:", id);
console.log(`https://stxer.xyz/simulations/mainnet/${id}`);
const result = await getSimulationResult(id);
console.log("epoch:", result.metadata?.epoch, "| burn:", result.metadata?.burn_block_height);
result.steps.forEach((s, i) => {
  console.log("---", steps[i] ?? `step ${i}`);
  console.log(JSON.stringify(s.Result).slice(0, 260));
});
