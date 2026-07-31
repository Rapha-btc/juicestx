// stxer mainnet-fork simulation for juice-pool-stx-signer (tranches + fees)
// Run: node simulations/pool-stx-signer-tranche-sim.mjs
//
// Difference from pool-stx-signer-sim.mjs: that one had to INJECT pox-5 with
// addSetContractCode, because pox-5 did not exist on mainnet and an epoch
// transition cannot be simulated by advancing blocks.
//
// Epoch 4.0 activated at burn 960,230 on 2026-07-30, so pox-5 is now a real
// mainnet boot contract. This sim uses the DEPLOYED one -- no shim, no
// injection -- so what compiles and resolves here is what will on mainnet.
//
// Deployer is chavita.btc, which resolves (BNS v2) to SPV9K21...JDC22.

import { SimulationBuilder, getSimulationResult } from "stxer";
import { ClarityVersion, uintCV, boolCV, principalCV, listCV } from "@stacks/transactions";
import { readFileSync } from "node:fs";

// chavita.btc -> SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22 (BNS v2)
const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const POX5_ID = "SP000000000000000000002Q6VF78.pox-5";
const POOL_ID = `${DEPLOYER}.juice-pool-stx-signer`;

const poolSrc = readFileSync(
  new URL("../contracts/pox-5/juice-pool-stx-signer.clar", import.meta.url),
  "utf8"
);

console.log(`pool source: ${poolSrc.length} bytes (deploy limit is 100,000)`);
console.log(`deploying as chavita.btc = ${DEPLOYER}`);

// Cycle 141 is the first pox-5 reward cycle (140 is live as of the fork).
const C = 141;

const steps = [];
const sim = SimulationBuilder.new().withSender(DEPLOYER);

const evalCode = (label, code) => {
  steps.push(label);
  sim.addEvalCode(POOL_ID, code);
};
const call = (label, function_name, function_args = []) => {
  steps.push(label);
  sim.addContractCall({ contract_id: POOL_ID, function_name, function_args, sender: DEPLOYER });
};

// --- 1. Is the REAL pox-5 there and callable? If this fails, nothing else means
// anything -- it would mean the fork tip predates epoch 4.0.
steps.push("pox-5 (deployed) current-pox-reward-cycle");
sim.addEvalCode(POX5_ID, `(current-pox-reward-cycle)`);

// --- 2. First time the edited contract meets a compiler.
steps.push("DEPLOY juice-pool-stx-signer at chavita.btc");
sim.addContractDeploy({
  contract_name: "juice-pool-stx-signer",
  source_code: poolSrc,
  deployer: DEPLOYER,
  clarity_version: ClarityVersion.Clarity5,
});

// --- 3. Deploy-time state.
evalCode("get-admin -> deployer", `(get-admin)`);
evalCode("get-fee-bips -> u0", `(get-fee-bips)`);
evalCode("get-earned-fees -> u0", `(get-earned-fees)`);
evalCode("is-og deployer -> false", `(is-og '${DEPLOYER})`);

// --- 4. Tranche accounting on an untouched cycle.
evalCode("get-tranche-count -> u0", `(get-tranche-count u${C})`);
evalCode("get-stx-pot (c,0) -> u0", `(get-stx-pot u${C} u0)`);
evalCode("get-tranche-paid (c,0) -> u0", `(get-tranche-paid u${C} u0)`);
evalCode("get-tranche-paid-shares (c,0) -> u0", `(get-tranche-paid-shares u${C} u0)`);
evalCode("get-tranche-residue (c,0) -> u0", `(get-tranche-residue u${C} u0)`);
evalCode("get-stx-owed (deployer) -> u0", `(get-stx-owed u${C} u0 '${DEPLOYER})`);
evalCode("get-stx-owed (the pool itself) -> u0", `(get-stx-owed u${C} u0 '${POOL_ID})`);

// --- 5. Fee admin. The cap is the point: 25% must be refused.
call("propose-fee-bips u500 (5%) -> ok", "propose-fee-bips", [uintCV(500)]);
evalCode("get-pending-fee -> (some u500), not yet live", `(get-pending-fee)`);
call("confirm-fee-bips before cooldown -> EXPECT ERR_COOLDOWN u114", "confirm-fee-bips", []);
call("propose-fee-bips u2500 -> EXPECT ERR_INVALID_FEE u110", "propose-fee-bips", [uintCV(2500)]);
evalCode("get-fee-bips still u0 (never confirmed)", `(get-fee-bips)`);

// --- 6. OG exemption.
evalCode("effective fee, non-OG", `(get-effective-fee-bips '${DEPLOYER})`);
call("set-og deployer true -> ok", "set-og", [principalCV(DEPLOYER), boolCV(true)]);
evalCode("is-og deployer -> true", `(is-og '${DEPLOYER})`);
evalCode("effective fee, OG -> u0", `(get-effective-fee-bips '${DEPLOYER})`);
call("set-og deployer false -> ok", "set-og", [principalCV(DEPLOYER), boolCV(false)]);
evalCode("is-og deployer -> false again", `(is-og '${DEPLOYER})`);

// --- 7. Claiming with nothing to claim must refuse rather than open an empty
// tranche. This is the new ERR_NO_NEW_REWARDS, and it replaces the old
// cycle-not-ended / rewards-not-computed gating that blocked weekly payouts.
call("pox-claim-rewards (nothing to claim) -> EXPECT ERR_NO_NEW_REWARDS u109",
  "pox-claim-rewards", [listCV([]), uintCV(C)]);
evalCode("get-tranche-count still u0 (no empty tranche)", `(get-tranche-count u${C})`);

// --- 8. Payout on an empty tranche is a no-op, not a failure.
call("pay-stx-stakers (empty list) -> ok u0", "pay-stx-stakers",
  [listCV([]), uintCV(C), uintCV(0)]);
call("pay-stx-stakers (deployer, empty pot) -> ok u0", "pay-stx-stakers",
  [listCV([principalCV(DEPLOYER)]), uintCV(C), uintCV(0)]);

// --- 9. Fees cannot be withdrawn before any are earned.
call("withdraw-fees u1 -> EXPECT ERR_INSUFFICIENT_FEES u111", "withdraw-fees",
  [uintCV(1), principalCV(DEPLOYER)]);

// --- 10. Dust sweep on an empty tranche -> ERR_NO_DUST (u105), NOT a transfer.
call("sweep-tranche-dust (c,0) -> EXPECT err (no dust / unpaid)", "sweep-tranche-dust",
  [uintCV(C), uintCV(0)]);

// --- 11. Non-admin must not be able to set fees or OGs.
steps.push("propose-fee-bips from NON-admin -> EXPECT ERR_UNAUTHORIZED u100");
sim.addContractCall({
  contract_id: POOL_ID,
  function_name: "propose-fee-bips",
  function_args: [uintCV(100)],
  sender: "SP1Y6ZAD2ZZFKNWN58V8EA42R3VRWFJSGWFAD9C36",
});

const id = await sim.run();
console.log("simulation id:", id);
console.log(`https://stxer.xyz/simulations/mainnet/${id}`);

const result = await getSimulationResult(id);
console.log("epoch:", result.metadata?.epoch, "| burn:", result.metadata?.burn_block_height);
result.steps.forEach((s, i) => {
  console.log("---", steps[i] ?? `step ${i}`);
  console.log(JSON.stringify(s.Result).slice(0, 400));
});
