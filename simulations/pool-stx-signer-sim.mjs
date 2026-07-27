// stxer mainnet-fork simulation for juice-pool-stx-signer
// Run: node simulations/pool-stx-signer-sim.mjs
//
// STATUS: expected to FAIL until epoch 4.0 activates at burn height 960,230.
// juice-pool-stx-signer does (impl-trait 'SP000...pox-5.signer-manager-trait)
// and calls into pox-5, which does not exist on mainnet yet and which
// pox5-probe-sim.mjs proved AdvanceBlocks does not conjure into being.
//
// Kept in the repo so it can be re-run the moment the fork lands. Step 1 also
// tries deploying the vendored pox-5 source directly, to record exactly why
// that shortcut does not work either.

import { SimulationBuilder, getSimulationResult } from "stxer";
import { ClarityVersion } from "@stacks/transactions";
import { readFileSync } from "node:fs";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";

const poolSrc = readFileSync(
  new URL("../contracts/pox-5/juice-pool-stx-signer.clar", import.meta.url),
  "utf8",
);
// NOTE: pox-5.clar is ~136 KB, over the 100 KB contract-deploy limit. It can
// only ever exist as a boot contract, so there is no shim shortcut.

const sim = SimulationBuilder.new()
  .withSender(DEPLOYER)

  // The contract under test.
  .addContractDeploy({
    contract_name: "juice-pool-stx-signer",
    source_code: poolSrc,
    clarity_version: ClarityVersion.Clarity4,
  })

  // 3. If the deploy somehow succeeded, prove the read path works.
  .addEvalCode(`${DEPLOYER}.juice-pool-stx-signer`, `(get-admin)`)
  .addEvalCode(`${DEPLOYER}.juice-pool-stx-signer`, `(get-stx-pot u141)`)
  .addEvalCode(`${DEPLOYER}.juice-pool-stx-signer`, `(is-cycle-fully-paid u141)`);

const id = await sim.run();
console.log("simulation id:", id);

const result = await getSimulationResult(id);
const labels = [
  "deploy juice-pool-stx-signer",
  "get-admin",
  "get-stx-pot u141",
  "is-cycle-fully-paid u141",
];
console.log("epoch:", result.metadata?.epoch, "| burn:", result.metadata?.burn_block_height);
result.steps.forEach((s, i) => {
  console.log("---", labels[i] ?? `step ${i}`);
  console.log(JSON.stringify(s.Result).slice(0, 600));
});
