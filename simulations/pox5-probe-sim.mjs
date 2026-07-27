// stxer probe: does pox-5 exist inside a simulation before mainnet activation?
// Run: node simulations/pox5-probe-sim.mjs
//
// WHY
//   pox-5 is a BOOT contract. It is not deployed by a transaction -- every node
//   running stacks-core 4.0.1 instantiates it into chainstate at the epoch 4.0
//   transition, burn height 960,230. Right now it 404s on mainnet.
//
//   So the question is whether stxer's simulation node is on 4.0.1 and whether
//   addAdvanceBlocks past the activation height triggers that instantiation.
//   If it does, we can verify juice-pool-stx-signer TODAY instead of waiting.
//   If it does not, nothing that touches pox-5 can be simulated until Thursday.
//
// WHAT IT DOES
//   1. Reads a pox-5 read-only at the current tip. Expected to fail (404 today).
//   2. Advances burn blocks past 960,230.
//   3. Reads the same function again. Success here means pox-5 was instantiated
//      by the epoch transition and the whole contract suite is testable now.
//
// Requires stxer >= 0.10.0 (Clarity 6 support). npm i stxer@latest

import { SimulationBuilder, getSimulationResult, getTip } from "stxer";

const POX5 = "SP000000000000000000002Q6VF78.pox-5";
const POX4 = "SP000000000000000000002Q6VF78.pox-4";
const ACTIVATION_BURN_HEIGHT = 960_230;

// Any mainnet principal works as the caller; read-onlys change no state.
const CALLER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";

const tip = await getTip();
console.log("chain tip:", tip);

const burnTip = tip?.bitcoin_height;
if (!burnTip) {
  console.warn("could not read burn height off the tip; advancing a fixed amount");
}

// Advance a little past activation so the epoch transition is unambiguous.
const blocksToAdvance = burnTip
  ? Math.max(1, ACTIVATION_BURN_HEIGHT - Number(burnTip) + 5)
  : 400;
console.log(
  `burn tip ${burnTip} -> advancing ${blocksToAdvance} burn blocks (activation ${ACTIVATION_BURN_HEIGHT})`,
);

const sim = SimulationBuilder.new()
  .withSender(CALLER)

  // --- control: pox-4 works today, proving the harness itself is fine -------
  .addEvalCode(POX4, `(current-pox-reward-cycle)`)

  // --- before: expected to fail while pox-5 does not exist ------------------
  .addEvalCode(POX5, `(get-first-pox-5-reward-cycle)`)

  // --- cross the epoch 4.0 boundary ----------------------------------------
  .addAdvanceBlocks({ bitcoin_blocks: blocksToAdvance, stacks_blocks_per_bitcoin: 1 })

  // --- after: success here means the sim node instantiated pox-5 -----------
  .addEvalCode(POX5, `(get-first-pox-5-reward-cycle)`)
  .addEvalCode(POX5, `(current-pox-reward-cycle)`)
  // SIGNER_SET_MIN_USTX is 50k STX; a clean read confirms real contract state.
  .addEvalCode(POX5, `(get-signer-shares-staked-for-cycle '${CALLER} u141 none)`);

const id = await sim.run();
console.log("simulation id:", id);
console.log(await getSimulationResult(id));
