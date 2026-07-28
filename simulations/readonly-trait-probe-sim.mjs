// stxer probe: can a define-read-only function satisfy a trait AND be reached
// by dynamic dispatch at runtime?
// Run: node simulations/readonly-trait-probe-sim.mjs
//
// WHY
//   fees-trait was changed so the fees contract only QUOTES a fee and never
//   moves money. A quote does no state change, so clarinet's linter wants it
//   declared define-read-only ("unnecessary_public"). clarinet check accepts a
//   read-only impl-trait and accepts a caller dispatching into it.
//
//   But clarinet check is static analysis. The real question is whether a node
//   actually executes the dispatch, because the call happens from inside a
//   public function that then WRITES state. If the runtime treats the whole
//   dispatch as read-only context, the var-set would abort.
//
// WHAT IT DOES
//   Deploys a trait, a read-only impl, a public impl (control), and a caller
//   whose public fn dispatches into the trait then writes a data-var.
//   Calls the caller with each impl and reads the var back.
//
//   read-only leg succeeding + var reading 100 == read-only impls are safe.

import { SimulationBuilder, getSimulationResult, getTip } from "stxer";
import { uintCV, contractPrincipalCV } from "@stacks/transactions";

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";

const TRAIT = "rotrait-probe";
const IMPL_RO = "rotrait-impl-ro";
const IMPL_PUB = "rotrait-impl-pub";
const CALLER = "rotrait-caller";

const SRC_TRAIT = `
(define-trait fees-trait
  ((get-fee (uint) (response uint uint))))
`;

// 1% fee, no state change -> the shape fees-none/get-fee now has
const SRC_IMPL_RO = `
(impl-trait .${TRAIT}.fees-trait)
(define-read-only (get-fee (ustx uint)) (ok (/ ustx u100)))
`;

const SRC_IMPL_PUB = `
(impl-trait .${TRAIT}.fees-trait)
(define-public (get-fee (ustx uint)) (ok (/ ustx u100)))
`;

// Public fn: dispatch into the trait, THEN write state. The write is the point.
const SRC_CALLER = `
(use-trait ft .${TRAIT}.fees-trait)
(define-data-var last uint u0)
(define-public (charge (amount uint) (fees <ft>))
  (let ((fee (try! (contract-call? fees get-fee amount))))
    (var-set last fee)
    (ok fee)))
(define-read-only (get-last) (var-get last))
`;

const tip = await getTip();
console.log("chain tip:", tip);

const sim = SimulationBuilder.new()
  .withSender(DEPLOYER)

  .addContractDeploy({ contract_name: TRAIT, source_code: SRC_TRAIT })
  .addContractDeploy({ contract_name: IMPL_RO, source_code: SRC_IMPL_RO })
  .addContractDeploy({ contract_name: IMPL_PUB, source_code: SRC_IMPL_PUB })
  .addContractDeploy({ contract_name: CALLER, source_code: SRC_CALLER })

  // --- the actual question: dispatch into a READ-ONLY impl, then write -----
  .addContractCall({
    contract_id: `${DEPLOYER}.${CALLER}`,
    function_name: "charge",
    function_args: [uintCV(10000), contractPrincipalCV(DEPLOYER, IMPL_RO)],
  })
  .addVarRead(`${DEPLOYER}.${CALLER}`, "last") // expect u100

  // --- control: same thing against a public impl ---------------------------
  .addContractCall({
    contract_id: `${DEPLOYER}.${CALLER}`,
    function_name: "charge",
    function_args: [uintCV(20000), contractPrincipalCV(DEPLOYER, IMPL_PUB)],
  })
  .addVarRead(`${DEPLOYER}.${CALLER}`, "last"); // expect u200

const id = await sim.run();
console.log("simulation id:", id);
console.log(JSON.stringify(await getSimulationResult(id), null, 2));
