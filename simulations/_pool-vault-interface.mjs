// Trait calls require the active vault as the last argument on Juice pool wrappers.
export const POOL_VAULT_FUNCTIONS=new Set([
 'pox-claim-rewards','finalize-swap','emergency-recover','refloor-vault',
 'set-vault-window-blocks','set-vault-leeway-bps','set-vault-slippage-bps',
 'set-vault-max-chunk-sats','set-vault-dia-band-bps','set-vault-router-cooldown',
 'set-vault-no-pyth-slippage-bps','jing-take','router-swap-split','router-swap-split-dia',
]);
export function withVaultArgument(poolId,vaultId,id,fn,args,Cl){
 return id===poolId&&poolId.endsWith('.juice-pool-stx-signer-stx-rewards')&&POOL_VAULT_FUNCTIONS.has(fn)
  ? [...args,Cl.principal(vaultId)] : args;
}
