// Writes an RV config (accounts deployer + wallet_1 + wallet_2, so one call
// in three comes from the admin / vault POOL actor) for a given seed and run
// count, then execs rv. Usage: node tests/rv/run.mjs <pool|vault> <runs> <seed>
import { writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [target, runs = "1000", seed = "1"] = process.argv.slice(2);
const dir = { pool: "tests/rv/.build-pool", vault: "tests/rv/.build-vault", "pool-v2": "tests/rv/.build-pool-v2", "vault-v2": "tests/rv/.build-vault-v2" }[target];
const contract = { pool: "juice-pool-sbtc-signer", vault: "juice-sbtc-autoswap", "pool-v2": "juice-pool-sbtc-signer", "vault-v2": "juice-sbtc-autoswap" }[target];
if (!dir) throw new Error("target must be pool, vault, pool-v2 or vault-v2");
const cfg = {
  accounts: [
    { name: "deployer", address: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM" },
    { name: "wallet_1", address: "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5" },
    { name: "wallet_2", address: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG" },
  ],
  accounts_mode: "overwrite",
  seed: Number(seed),
  runs: Number(runs),
  bail: true,
};
mkdirSync(`${dir}/.rv`, { recursive: true });
const file = `${dir}/.rv/config-${seed}.json`;
writeFileSync(file, JSON.stringify(cfg, null, 2));
const r = spawnSync("node_modules/.bin/rv", [dir, contract, "invariant", `--config=${file}`], { stdio: "inherit" });
process.exit(r.status ?? 1);
