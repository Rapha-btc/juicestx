import { runPoolVaultFork, runPoolVaultLifecycle } from './_pool-vault-stxer.mjs';
import { fileURLToPath } from 'node:url';
const run=(process.argv.includes('--lifecycle')||process.argv.includes('--maker')||process.argv.includes('--jing-router')||process.argv.includes('--jing-take')||process.argv.includes('--split-pyth'))?runPoolVaultLifecycle:runPoolVaultFork;
await run({profile:process.argv.includes('--maker')?'maker':process.argv.includes('--jing-router')?'jing-router':process.argv.includes('--jing-take')?'jing-take':process.argv.includes('--split-pyth')?'split-pyth':'liquidation',kind:'juice',
 poolSource:fileURLToPath(new URL('../contracts/pox-5/juice-pool-stx-signer-stx-rewards.clar',import.meta.url)),
 vaultSource:fileURLToPath(new URL('../contracts/pox-5/juice-pool-swap-vault.clar',import.meta.url)),
 resultDirectory:fileURLToPath(new URL('./results/pool-vault-stx',import.meta.url))});
