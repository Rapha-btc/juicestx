// Juice fork setup at the current mainnet tip.
// The production vault and pool names are already taken on mainnet by an older
// deployment, so the fork deploys the repo sources under the -v1 names below.
// Only the two contract names and the references to them are rewritten, in
// memory; mapping the names back must give the repo file byte for byte.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
export const DEP='SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
export const JUICE_RENAMES={'juice-pool-swap-vault':'juice-pool-swap-vault-v1','juice-pool-stx-signer-stx-rewards':'juice-pool-stx-signer-stx-rewards-v1'};
export const VAULT_NAME=JUICE_RENAMES['juice-pool-swap-vault'],POOL_NAME=JUICE_RENAMES['juice-pool-stx-signer-stx-rewards'];
export const VAULT_ID=`${DEP}.${VAULT_NAME}`,POOL_ID=`${DEP}.${POOL_NAME}`;
const sha=s=>createHash('sha256').update(s).digest('hex');
// `.name` covers both the short form and the fully qualified 'DEP.name form;
// the lookahead keeps longer names (e.g. juice-swap-vault-trait) untouched.
const swap=(src,map)=>src.replace(new RegExp(`\\.(${Object.keys(map).join('|')})(?![A-Za-z0-9_-])`,'g'),(_,n)=>'.'+map[n]);
const inverse=Object.fromEntries(Object.entries(JUICE_RENAMES).map(([a,b])=>[b,a]));
export function renameJuice(source){
 for(const n of Object.values(JUICE_RENAMES))if(source.includes(n))throw new Error(`source already contains ${n}`);
 const out=swap(source,JUICE_RENAMES),back=swap(out,inverse);
 if(back!==source||sha(back)!==sha(source))throw new Error('renamed source does not map back to the repo file');
 return out;
}
// Reads a repo contract, returns the renamed source to deploy under `name` and
// records both hashes: sourceHashes[repo name] (repo file) and sourceHashes[name] (deployed).
export function juiceSource(repoName,path,sourceHashes={}){
 const source=readFileSync(path,'utf8'),name=JUICE_RENAMES[repoName];
 if(!name)throw new Error(`no fork name for ${repoName}`);
 const deployed=renameJuice(source);
 sourceHashes[repoName]=sha(source);sourceHashes[name]=sha(deployed);
 return {name,source:deployed,repoSha256:sha(source),deployedSha256:sha(deployed)};
}
// One fork height for a whole rerun set: JUICE_FORK_BLOCK, else the node tip.
export async function juiceForkBlock(node){
 if(process.env.JUICE_FORK_BLOCK)return Number(process.env.JUICE_FORK_BLOCK);
 const r=await fetch(`${node}/extended/v1/block?limit=1`,{signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw new Error(`tip HTTP ${r.status}`);
 return (await r.json()).results[0].height;
}
