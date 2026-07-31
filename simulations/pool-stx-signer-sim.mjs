// stxer mainnet-fork simulation for juice-pool-stx-signer
// Run: node simulations/pool-stx-signer-sim.mjs
//
// pox-5 does not exist on mainnet until epoch 4.0 activates at burn 960,230,
// and it CANNOT be brought into a simulation the usual ways:
//   - AdvanceBlocks past the activation height does not run the epoch
//     transition (see pox5-probe-sim.mjs -- reached 960,235, still absent)
//   - it cannot be deployed as an ordinary contract: ~136 KB of source, over
//     the 100 KB contract-deploy limit
//
// So we inject it with addSetContractCode, which writes contract code straight
// into the forked state with no transaction and no size limit, at the real boot
// principal. Everything downstream then resolves exactly as it will on mainnet.

import { SimulationBuilder, getSimulationResult } from "stxer";
import { ClarityVersion } from "@stacks/transactions";
import { readFileSync } from "node:fs";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const POX5_ID = "SP000000000000000000002Q6VF78.pox-5";
const POOL_ID = `${DEPLOYER}.juice-pool-stx-signer`;

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const pox5Src = src("../contracts/external/pox-5-sim.clar");
const poolSrc = src("../contracts/pox-5/juice-pool-stx-signer.clar");

console.log(`pox-5 shim: ${pox5Src.length} bytes (deploy limit is 100,000)`);

const sim = SimulationBuilder.new()
  .withSender(DEPLOYER)

  // 1. Put pox-5 at its real boot address, bypassing the tx size limit.
  .addSetContractCode({
    contract_id: POX5_ID,
    source_code: pox5Src,
    clarity_version: ClarityVersion.Clarity5,
  })

  // 2. Sanity: is pox-5 actually callable now?
  .addEvalCode(POX5_ID, `(current-pox-reward-cycle)`)

  // 3. The contract under test. This is the first time it meets a compiler.
  .addContractDeploy({
    contract_name: "juice-pool-stx-signer",
    source_code: poolSrc,
    clarity_version: ClarityVersion.Clarity4,
  })

  // 4. Read path: admin set at deploy, empty pot, nothing paid.
  .addEvalCode(POOL_ID, `(get-admin)`)
  .addEvalCode(POOL_ID, `(get-stx-pot u141)`)
  .addEvalCode(POOL_ID, `(get-cycle-paid u141)`)
  .addEvalCode(POOL_ID, `(get-cycle-paid-shares u141)`)
  .addEvalCode(POOL_ID, `(get-cycle-residue u141)`)

  // 5. A staker with no shares must be owed nothing, and must not blow up.
  .addEvalCode(POOL_ID, `(get-stx-owed u141 '${DEPLOYER})`)

  // 6. The pool itself as staker -- the case you asked about. Expect u0.
  .addEvalCode(POOL_ID, `(get-stx-owed u141 '${POOL_ID})`)

  // 7. Claiming a cycle that has not ended must be refused (err u106).
  .addEvalCode(POOL_ID, `(pox-claim-rewards (list) u9999)`);

const id = await sim.run();
console.log("simulation id:", id);

const result = await getSimulationResult(id);
const labels = [
  "inject pox-5 at boot address",
  "pox-5 current-pox-reward-cycle",
  "DEPLOY juice-pool-stx-signer",
  "get-admin",
  "get-stx-pot u141",
  "get-cycle-paid u141",
  "get-cycle-paid-shares u141",
  "get-cycle-residue u141",
  "get-stx-owed (deployer)",
  "get-stx-owed (the pool itself)",
  "pox-claim-rewards on a future cycle -> expect ERR_CYCLE_NOT_ENDED u106",
];
console.log("epoch:", result.metadata?.epoch, "| burn:", result.metadata?.burn_block_height);
result.steps.forEach((s, i) => {
  console.log("---", labels[i] ?? `step ${i}`);
  console.log(JSON.stringify(s.Result).slice(0, 500));
});
