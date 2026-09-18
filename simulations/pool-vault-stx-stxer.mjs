import { runPoolVaultFork, runPoolVaultLifecycle } from './_pool-vault-stxer.mjs';
import { fileURLToPath } from 'node:url';
const run=(process.argv.includes('--lifecycle')||process.argv.includes('--maker'))?runPoolVaultLifecycle:runPoolVaultFork;
await run({profile:process.argv.includes('--maker')?'maker':'liquidation',kind:'juice',
 poolSource:fileURLToPath(new URL('../contracts/pox-5/juice-pool-stx-signer-stx-rewards.clar',import.meta.url)),
 vaultSource:fileURLToPath(new URL('../contracts/pox-5/juice-pool-swap-vault.clar',import.meta.url)),
 resultDirectory:fileURLToPath(new URL('./results/pool-vault-stx',import.meta.url))});
