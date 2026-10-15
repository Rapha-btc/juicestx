// Juice fork setup at the current mainnet tip.
// The vault and pool deploy under their production names (free on mainnet), so
// the map below is the identity and the fork deploys the repo file byte for byte.
// Kept as a map so a taken name can be redirected again: then only the two
// contract names and their references are rewritten, in memory, and mapping the
// names back must give the repo file byte for byte.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
export const DEP='SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
export const JUICE_RENAMES={'juice-sbtc-autoswap':'juice-sbtc-autoswap','juice-pool-sbtc-signer':'juice-pool-sbtc-signer'};
export const VAULT_NAME=JUICE_RENAMES['juice-sbtc-autoswap'],POOL_NAME=JUICE_RENAMES['juice-pool-sbtc-signer'];
export const VAULT_ID=`${DEP}.${VAULT_NAME}`,POOL_ID=`${DEP}.${POOL_NAME}`;
const sha=s=>createHash('sha256').update(s).digest('hex');
// `.name` covers both the short form and the fully qualified 'DEP.name form;
// the lookahead keeps longer names (e.g. juice-swap-vault-trait) untouched.
const swap=(src,map)=>src.replace(new RegExp(`\\.(${Object.keys(map).join('|')})(?![A-Za-z0-9_-])`,'g'),(_,n)=>'.'+map[n]);
const inverse=Object.fromEntries(Object.entries(JUICE_RENAMES).map(([a,b])=>[b,a]));
export function renameJuice(source){
 if(Object.entries(JUICE_RENAMES).every(([a,b])=>a===b))return source;
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
// juice-swap-vault-trait-v2 is new (v1 is on mainnet and can not gain
// set-pyth-fee-budget), so every fork deploys it from the repo file, as DEP,
// before the vault and the pool.
export const TRAIT_NAME='juice-swap-vault-trait-v2',TRAIT_ID=`${DEP}.${TRAIT_NAME}`;
export function traitSource(sourceHashes={}){
 const source=readFileSync(new URL(`../contracts/pox-5/${TRAIT_NAME}.clar`,import.meta.url),'utf8');
 sourceHashes[TRAIT_NAME]=sha(source);
 return {name:TRAIT_NAME,source,sha256:sha(source)};
}
// One fork height for a whole rerun set: JUICE_FORK_BLOCK, else the newest
// block at least JUICE_FORK_LAG_SECS (default 600) old. The lag keeps a freshly
// fetched Lazer update inside the market's 80 s staleness limit after the sims
// advance ~150 burn blocks (each moves block time 1 s forward).
export async function juiceForkBlock(node){
 const h=await juiceForkBlockRaw(node);
 if(process.env.JUICE_LIVE!=='0'&&h<9219777)throw new Error(`live mode needs a fork block >= 9219777 (juice deploys), got ${h}`);
 return h;
}
async function juiceForkBlockRaw(node){
 if(process.env.JUICE_FORK_BLOCK)return Number(process.env.JUICE_FORK_BLOCK);
 const get=async(path)=>{const r=await fetch(`${node}${path}`,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`${path} HTTP ${r.status}`);return r.json();};
 const tip=(await get('/extended/v1/block?limit=1')).results[0];
 const target=Math.floor(Date.now()/1000)-Number(process.env.JUICE_FORK_LAG_SECS??600);
 if(tip.burn_block_time<=target)return tip.height;
 let lo=tip.height-5000,hi=tip.height;
 while(hi-lo>1){const mid=Math.floor((lo+hi)/2);((await get(`/extended/v2/blocks/${mid}`)).block_time<=target)?lo=mid:hi=mid;}
 return lo;
}

// LIVE mode (default since 2026-10-15): the trait, vault and pool are on mainnet
// (trait + pool block 9219775, vault 9219776; the pool is not register-self'd yet),
// so sims fork at the tip and run against those live bytes instead of deploying
// the repo files. JUICE_LIVE=0 restores the old deploy-from-repo mode (it needs a
// JUICE_FORK_BLOCK before 9219775).
export const JUICE_LIVE=process.env.JUICE_LIVE!=='0';
export const JUICE_LIVE_FROM=9219777;
export const JUICE_LIVE_HASHES={
 'juice-swap-vault-trait-v2':'de229849f1823c5e3006ea0b410e806b6da28792ff47d1e308a648980bc84063',
 'juice-pool-sbtc-signer':'9b0cdd5bb6274ca4aeef34834e01cfb18bfa3a6120527dc9fbfb849031b1aebe',
 'juice-sbtc-autoswap':'eb4cd0f7497b62181b1b3527cc4db71ef86e43f32bf8d9466eff56c790ad68d5',
};
// Fetches the three live sources, checks sha512/256 against DEPLOYED-VERIFIED.md
// and records them as sourceHashes['live:<name>']. Returns { name: source }.
export async function verifyLiveJuice(node,sourceHashes={}){
 const out={};
 for(const [name,want] of Object.entries(JUICE_LIVE_HASHES)){
  const r=await fetch(`${node}/v2/contracts/source/${DEP}/${name}?proof=0`,{signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error(`live source ${name} HTTP ${r.status}`);
  const src=(await r.json()).source,h=createHash('sha512-256').update(src).digest('hex');
  if(h!==want)throw new Error(`live ${name} sha512/256 ${h} != verified ${want}`);
  sourceHashes[`live:${name}`]=h;out[name]=src;
 }
 console.log(`live juice bytes verified (sha512/256): trait ${JUICE_LIVE_HASHES['juice-swap-vault-trait-v2'].slice(0,8)} pool ${JUICE_LIVE_HASHES['juice-pool-sbtc-signer'].slice(0,8)} vault ${JUICE_LIVE_HASHES['juice-sbtc-autoswap'].slice(0,8)}`);
 return out;
}
