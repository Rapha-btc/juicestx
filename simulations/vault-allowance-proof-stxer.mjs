// Mainnet fork only (stxer), at the tip. Measures whether the Void Kael #8
// allowance extra in juice-pool-swap-vault `router-swap` is still needed now
// that the market sizes the rebate exactly (net = amount*BPS/(BPS+bps)).
//
// The production names are taken on mainnet by an older deployment, so the
// repo sources deploy under the -v1 fork names (_juice-fork.mjs: only the
// contract names are rewritten; mapping them back gives the repo file).
// Two vaults from the same source file:
//   juice-pool-swap-vault-v1       the repo file, names rewritten (allowance:
//                                  amount + min-x + JING_REBATE_DUST_SATS u51)
//   juice-pool-swap-vault-oldallow TEST-ONLY VARIANT: identical except
//                                  JING_REBATE_DUST_SATS removed from the
//                                  allowance (amount + min-x). Never deploy.
// Both vaults get the same state (funded through their real `fund` from the
// pool, same chunk cap via their real pool-gated setter), and each case runs
// `router-swap` on each against the same Jing book (rebuilt identically between
// the two calls). Real v6-3 market / router / core, real sBTC, real AMMs.
//
// Fixtures (fork only): the vault funding clock is aged 288 blocks by Eval so
// liquidation is open; setters are called from the pool contract's context by
// Eval (the vault checks contract-caller = pool, the old copy is not the pool's
// active vault); dia-band-bps is set to 0 on both vaults because moving the fork
// clock to the live Lazer print time leaves the fork's DIA value days stale.
//
// Run: PYTH_API_KEY=... node simulations/vault-allowance-proof-stxer.mjs
import {appendJingStack,fetchLazerUpdateAny,lazerFeedTimes} from './_jing-v6-3.mjs';
import {POOL_ID,VAULT_ID,juiceSource,juiceForkBlock} from './_juice-fork.mjs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=dirname(fileURLToPath(import.meta.url));
const require=createRequire(resolve(directory,'../package.json'));
const {SimulationBuilder,getSimulationTip,submitSimulationSteps,callContract}=require('stxer');
const {Cl,ClarityVersion,deserializeCV,cvToString,getAddressFromPrivateKey}=require('@stacks/transactions');

const DEP='SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const STRANGER='SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const SBTC='SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const WSTX='SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2';
const MARKET=`${DEP}.markets-sbtc-stx-jing-v6-3`;
const CORE=`${DEP}.jing-core-v6`;
const POOL=POOL_ID;
const NEWV=VAULT_ID;
const OLDV=`${DEP}.juice-pool-swap-vault-oldallow`;
const SBTC_WHALE='SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1';
const STX_WHALE='SP2XXSW2KPPTY7KJDYS9RQ868D7JH58QSZKK8KXAV';
const MAKERS=[1,2,3].map(n=>getAddressFromPrivateKey(String(930+n).repeat(22).slice(0,64)+'01','mainnet'));
const NODE=process.env.STACKS_API_URL||'http://77.42.3.101/stacks-api';
const API=process.env.STXER_API_URL||'https://api.stxer.xyz';
const FUND=250000000n;            // per vault: covers both 1 BTC chunks
const MAKER_STX=3000000000000n;   // 3M STX per maker
// book: three bids just under the mid (walked at their own price), sized to
// 1.2x the chunk in value so the whole book leg fills across three makers
const BOOK=[{bps:2n,share:50n},{bps:5n,share:40n},{bps:8n,share:30n}];
const MIN_X=1000n,DUST=51n,BPS=10000n; // DUST = JING_REBATE_DUST_SATS
const CASES=[
 {id:1,label:'control: 1M chunk, fresh print',chunk:1000000n,age:5},
 {id:3,label:'1 BTC chunk, fresh print',chunk:100000000n,age:5},
 {id:2,label:'1M chunk, aged print',chunk:1000000n,age:79},
 {id:4,label:'1 BTC chunk, aged print',chunk:100000000n,age:79},
];

// ---- the two sources ----
const sourceHashes={};
const newVault=juiceSource('juice-pool-swap-vault',resolve(directory,'../contracts/pox-5/juice-pool-swap-vault.clar'),sourceHashes);
const newPool=juiceSource('juice-pool-stx-signer-stx-rewards',resolve(directory,'../contracts/pox-5/juice-pool-stx-signer-stx-rewards.clar'),sourceHashes);
const newSource=newVault.source;
// the test copy: JING_REBATE_DUST_SATS taken out of the router-swap allowance
const NEW_ALLOW=/\(\+ amount \(get min-token-x mins\)\s+JING_REBATE_DUST_SATS\s*\)/g;
if((newSource.match(NEW_ALLOW)||[]).length!==1)throw new Error('allowance with JING_REBATE_DUST_SATS not found exactly once');
const oldSource=newSource.replace(NEW_ALLOW,'(+ amount (get min-token-x mins))');
const sha=s=>createHash('sha256').update(s).digest('hex');
console.log(`vault repo sha256 ${newVault.repoSha256}, deployed as ${newVault.name} sha256 ${newVault.deployedSha256}`);
console.log(`TEST-ONLY VARIANT juice-pool-swap-vault-oldallow sha256 ${sha(oldSource)}: allowance without JING_REBATE_DUST_SATS: (+ amount (get min-token-x mins))`);

const cp=id=>Cl.contractPrincipal(...id.split('.'));
const u=Cl.uint,sbtcCv=cp(SBTC),wstxCv=cp(WSTX);
const show=hex=>cvToString(deserializeCV(hex));
const buf=p=>Cl.buffer(Buffer.from(p.hex.replace(/^0x/,''),'hex'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function retry(what,fn,n=5){for(let i=1;;i++){try{return await fn();}catch(e){if(i>=n)throw e;console.log(`retry ${what} (${i}): ${String(e.message).slice(0,160)}`);await sleep(4000*i);}}}

// ---- setup batch ----
const forkBlock=await juiceForkBlock(NODE);
const builder=SimulationBuilder.new({stacksNodeAPI:NODE,apiEndpoint:API,skipTracing:true}).useBlockHeight(forkBlock).withSender(DEP);
const plan=[];
appendJingStack(builder,plan,sourceHashes,forkBlock);
for(const [name,src] of [[newVault.name,newSource],[newPool.name,newPool.source],['juice-pool-swap-vault-oldallow',oldSource]]){
 builder.withSender(DEP).addContractDeploy({contract_name:name,source_code:src,clarity_version:ClarityVersion.Clarity6});plan.push({label:`deploy ${name}`,kind:'deploy'});
}
const bcall=(label,sender,id,fn,args,want)=>{builder.withSender(sender).addContractCall({contract_id:id,function_name:fn,function_args:args});plan.push({label,kind:'tx',want});};
const beval=(label,id,code,want)=>{builder.withSender(DEP).addEvalCode(id,code);plan.push({label,kind:'eval',want});};
bcall('whale sBTC to the pool for both vaults',SBTC_WHALE,SBTC,'transfer',[u(FUND*2n),Cl.principal(SBTC_WHALE),Cl.principal(POOL),Cl.none()],'(ok true)');
for(const v of [NEWV,OLDV]){
 beval(`pool funds ${v.split('.')[1]} through its real fund`,POOL,`(as-contract? ((with-ft '${SBTC} "sbtc-token" u${FUND})) (try! (contract-call? '${v} fund u${FUND})))`,v=>v.startsWith("(ok"));
 beval(`${v.split('.')[1]}: dia band 0 (pool-gated setter)`,POOL,`(contract-call? '${v} set-dia-band-bps u0)`,'(ok true)');
 beval(`${v.split('.')[1]}: fixture ages funding clock 288 blocks`,v,'(begin (var-set batch-start (some (- burn-block-height u288))) true)','true');
 beval(`${v.split('.')[1]}: window elapsed`,v,'(get window-elapsed (get-clock))','true');
}
for(const m of MAKERS){builder.withSender(STX_WHALE).addSTXTransfer({recipient:m,amount:MAKER_STX});plan.push({label:`fund maker ${m.slice(0,8)} with STX`,kind:'tx',want:'(ok true)'});}
beval('min deposits',MARKET,'(get-min-deposits)',v=>v.includes(`(min-token-x u${MIN_X})`));
console.log(`setup: ${plan.length} steps at fork block ${forkBlock}`);
const sid=await retry('setup run',()=>builder.run());
console.log(`View: https://stxer.xyz/simulations/mainnet/${sid}`);
// verify setup
{
 const {getSimulationResult}=require('stxer');
 const res=await retry('setup result',()=>getSimulationResult(sid,{stxerApi:API}));
 let bad=0;
 plan.forEach((p,i)=>{const r=res.steps[i]?.Result;let a;
  if(p.kind==='eval')a=r?.Eval?.Ok!==undefined?show(r.Eval.Ok):`ENGINE ${JSON.stringify(r).slice(0,300)}`;
  else a=r?.Transaction?.Ok&&!r.Transaction.Ok.vm_error?show(r.Transaction.Ok.result):`ENGINE ${JSON.stringify(r).slice(0,300)}`;
  const pass=p.kind==='deploy'?a.startsWith('(ok'):p.want===undefined?true:typeof p.want==='function'?p.want(a):a===p.want;
  if(!pass)bad++;console.log(`${pass?'PASS':'FAIL'} setup: ${p.label}: ${a.slice(0,200)}`);});
 if(bad)throw new Error(`${bad} setup steps failed`);
}

// ---- incremental helpers ----
async function ev(code,id=MARKET){
 const out=await retry('eval',()=>submitSimulationSteps(sid,{steps:[{Eval:[DEP,'',id,code]}]},{stxerApi:API}));
 const r=out.steps[0];return r?.Eval?.Ok!==undefined?show(r.Eval.Ok):`ENGINE ${JSON.stringify(r).slice(0,300)}`;
}
async function tx(sender,id,fn,args){
 const r=await retry(`${fn}`,()=>callContract(sid,{sender,contract:id,functionName:fn,functionArgs:args,fee:0},{stxerApi:API}));
 return {...r,shown:r.vmError?`VM ${r.vmError}`:r.result};
}
const U=s=>BigInt(String(s).match(/u(\d+)/)?.[1]??'-1');
const hexOf=p=>'0x'+p.hex.replace(/^0x/,'');

async function advanceTo(stamp){
 const tip=await retry('tip',()=>getSimulationTip(sid,{stxerApi:API}));
 const interval=stamp-Number(tip.burn_block_time);
 if(stamp<=Number(tip.block_time)||interval<=0)return false;
 const out=await retry('advance',()=>submitSimulationSteps(sid,{steps:[{AdvanceBlocks:{bitcoin_blocks:1,stacks_blocks_per_bitcoin:1,bitcoin_interval_secs:interval}}]},{stxerApi:API}));
 if(!out.steps[0]?.AdvanceBlocks?.Ok)throw new Error(`advance failed ${JSON.stringify(out.steps[0]).slice(0,300)}`);
 return true;
}
// Pick a live print, move the fork clock so the print is `age` s old, and
// confirm the market prices it (exact rebate bps). Retries with a newer print
// (and one second less age) on a stale refusal.
async function priceAt(age){
 for(let attempt=0;attempt<12;attempt++){
  const target=Math.max(age-attempt,age>30?70:0);
  const p=await retry('lazer',()=>fetchLazerUpdateAny());
  const t=await retry('feed times',()=>lazerFeedTimes(p.hex));
  const stamp=t.at+target;
  if(!await advanceTo(stamp)){console.log(`print at ${t.at} too old for the fork clock; waiting`);await sleep(5000);continue;}
  const now=U(await ev('stacks-block-time'));
  const probe=await ev(`(let ((a (try! (fresh-classification-price-aged ${hexOf(p)})))) (ok {age: (get age a), bps: (rebate-bps-for-age (get age a)), price: (get price a), at: (get at a)}))`);
  if(probe.startsWith('(ok')){return {p,at:t.at,now,age:U(probe.match(/\(age u\d+\)/)[0]),bps:U(probe.match(/\(bps u\d+\)/)[0]),mid:U(probe.match(/\(price u\d+\)/)[0])};}
  console.log(`probe at age ${Number(now)-t.at}: ${probe}; retrying with a newer print`);await sleep(3000);
 }
 throw new Error('could not price a print at the requested age');
}

async function placeBook(chunk,mid){
 const value=chunk*mid/10000000000n; // uSTX value of the chunk at mid
 const bids=BOOK.map((b,i)=>({maker:MAKERS[i],amount:value*b.share/100n,limit:mid*(10000n-b.bps)/10000n}));
 for(const b of bids){
  const r=await tx(b.maker,MARKET,'deposit-token-y',[u(b.amount),u(b.limit),Cl.none(),wstxCv,Cl.stringAscii('wstx')]);
  if(!r.shown.startsWith('(ok'))throw new Error(`bid failed ${r.shown}`);
  const live=U(await ev(`(get-token-y-deposit (var-get current-cycle) '${b.maker})`));
  if(live!==b.amount){
   const s=await tx(STRANGER,MARKET,'settle-token-y-deposit',[Cl.principal(b.maker),Cl.buffer(Buffer.alloc(0)),wstxCv,Cl.stringAscii('wstx')]);
   throw new Error(`bid not live (${live} vs ${b.amount}); ${s.shown}`);
  }
 }
 return bids;
}
async function clearBook(){for(const m of MAKERS){await tx(m,MARKET,'cancel-token-y-deposit',[wstxCv,Cl.stringAscii('wstx')]);}
 const left=await ev(`(list ${MAKERS.map(m=>`(get-token-y-deposit (var-get current-cycle) '${m})`).join(' ')})`);
 if(left!=='(list u0 u0 u0)')throw new Error(`book not cleared ${left}`);}

function measure(r,vault,amount){
 const raw=(r.receipt.events??[]).map(e=>typeof e==='string'?JSON.parse(e):e);
 const committed=raw.filter(e=>e.committed!==false);
 const set=r.result.startsWith('(ok')?committed:raw; // an aborted call: show what it tried
 const ft=set.filter(e=>e.ft_transfer_event).map(e=>e.ft_transfer_event).filter(t=>t.asset_identifier?.startsWith(SBTC));
 const out=ft.filter(t=>t.sender===vault),back=ft.filter(t=>t.recipient===vault&&t.sender===MARKET);
 const toMarket=out.filter(t=>t.recipient===MARKET).map(t=>BigInt(t.amount));
 let rest=0n,router=null;
 for(const e of set){const c=e.contract_event;if(!c)continue;
  const v=cvToString(deserializeCV(c.raw_value));
  if(c.contract_identifier===CORE&&v.includes('"refund-x"')&&v.includes(`(depositor ${vault})`))rest+=U(v.match(/\(amount u\d+\)/)[0]);
  if(c.contract_identifier.endsWith('swap-router-sbtc-stx-jing-v5-3')&&v.includes('smart-swap-sbtc-for-stx'))router=v;}
 const refunded=back.reduce((a,t)=>a+BigInt(t.amount),0n);
 return {events:raw.length,committed:committed.length,gross:out.reduce((a,t)=>a+BigInt(t.amount),0n),refunded,rest,crumbs:refunded-rest,
  rebateTransfer:toMarket.length>=2?toMarket[0]:0n,toMarket:toMarket.map(String),router,
  allowOld:amount+MIN_X,allowNew:amount+MIN_X+DUST};
}

const rows=[];
for(const c of CASES){
 console.log(`\n=== case ${c.id}: ${c.label} ===`);
 const pr=await priceAt(c.age);
 console.log(`print at ${pr.at}, fork clock ${pr.now}, age ${pr.age} s, rebate ${pr.bps} bps, mid ${pr.mid}`);
 for(const v of [NEWV,OLDV]){const s=await ev(`(contract-call? '${v} set-max-chunk-sats u${c.chunk})`,POOL);if(s!=='(ok true)')throw new Error(`chunk ${s}`);}
 const row={case:c.id,label:c.label,chunk:String(c.chunk),printAge:String(pr.age),rebateBps:String(pr.bps),mid:String(pr.mid),vaults:{}};
 for(const [tag,v] of [['old',OLDV],['new',NEWV]]){
  const bids=await placeBook(c.chunk,pr.mid);
  const cap=await ev(`(get-taker-capacity u${pr.mid} u${pr.mid*99n/100n} true '${v})`);
  const bal=U(await ev(`(contract-call? '${SBTC} get-balance '${v})`,v));
  const amount=bal<c.chunk?bal:c.chunk;
  const r=await tx(STRANGER,v,'router-swap',[buf(pr.p)]);
  const m=measure(r,v,amount);
  const bpsSet=await ev('(var-get pending-rebate-bps-x)');
  const after=U(await ev(`(contract-call? '${SBTC} get-balance '${v})`,v));
  const res={vault:v.split('.')[1],testOnly:v===OLDV,amount:String(amount),result:r.shown,balanceBefore:String(bal),balanceAfter:String(after),
   capacity:cap,book:bids.map(b=>({maker:b.maker,amount:String(b.amount),limit:String(b.limit)})),marketRebateBpsVar:bpsSet,
   gross:String(m.gross),refunded:String(m.refunded),rest:String(m.rest),crumbs:String(m.crumbs),rebateTransfer:String(m.rebateTransfer),
   toMarket:m.toMarket,allowOld:String(m.allowOld),allowNew:String(m.allowNew),allowance:String(v===OLDV?m.allowOld:m.allowNew),router:m.router,events:m.events,committed:m.committed};
  row.vaults[tag]=res;
  console.log(`${v===OLDV?'[TEST-ONLY oldallow]':'[repo vault]'} ${res.vault}: ${r.shown.slice(0,260)}`);
  console.log(`  amount ${amount}, rebate transfer ${m.rebateTransfer} (${amount?m.rebateTransfer*10000n/amount:0n} bps floor), to market ${m.toMarket.join('+')}, market refund ${m.refunded} = rest ${m.rest} + crumbs ${m.crumbs}`);
  console.log(`  gross sBTC out ${m.gross} (amount + ${m.gross-amount}); allowance ${res.allowance}; balance ${bal} -> ${after}; ${m.committed}/${m.events} events committed`);
  if(m.router)console.log(`  router: ${m.router.slice(0,400)}`);
  await clearBook();
 }
 rows.push(row);
}

// ---- model checks and verdict ----
// market swap on the Jing leg of size g at rebate bps b: net = floor(g*BPS/(BPS+b)),
// rebate = g - net (the taker sends g in total); the unused rebate refunded is only
// rounding, at most JING_REBATE_DUST_SATS.
const field=(s,k)=>BigInt(String(s).match(new RegExp(`\\(${k} u(\\d+)\\)`))?.[1]??'-1');
console.log('\n=== results ===');
console.log('case | chunk | print age | rebate bps | jing leg | model rebate | rebate transfer | rest | rebate refunded | gross outflow | old allowance | new allowance | old-vault (TEST-ONLY) | new vault');
const verdict=[];
for(const r of rows){
 const o=r.vaults.old,n=r.vaults.new,src=n.result.startsWith('(ok')?n:o,b=BigInt(r.rebateBps);
 const g=src.router?field(src.router,'jing-cap'):0n,net=g*BPS/(BPS+b),model=g-net;
 const refund=BigInt(src.crumbs);
 console.log(`${r.case} | ${r.chunk} | ${r.printAge}s | ${r.rebateBps} | ${g} | ${model} | ${src.rebateTransfer} | ${src.rest} | ${refund} | ${src.gross} | ${o.allowOld} | ${n.allowNew} | ${o.result.slice(0,40)} | ${n.result.slice(0,40)}`);
 for(const x of [o,n])if(x.result.startsWith('(ok')&&BigInt(x.gross)!==BigInt(x.amount)+BigInt(x.refunded)-BigInt((x.router?.match(/\(unsold u(\d+)\)/)?.[1])??0))
  console.log(`  note ${x.vault}: gross ${x.gross} != amount + refund - unsold`);
 const oldOk=o.result.startsWith('(ok'),newOk=n.result.startsWith('(ok');
 verdict.push({case:r.case,chunk:r.chunk,rebateBps:r.rebateBps,jingLeg:String(g),modelRebate:String(model),rebateTransfer:src.rebateTransfer,rebateMatchesModel:BigInt(src.rebateTransfer)===model,
  rebateRefunded:String(refund),refundWithinDust:refund<=DUST,gross:src.gross,grossWithinNewAllowance:BigInt(src.gross)<=BigInt(n.allowNew),grossWithinOldAllowance:BigInt(src.gross)<=BigInt(o.allowOld),oldOk,newOk});
}
for(const v of verdict)console.log(`case ${v.case}: old ${v.oldOk?'ok':'ABORT'}, new ${v.newOk?'ok':'FAIL'}, rebate ${v.rebateTransfer} = model ${v.modelRebate}: ${v.rebateMatchesModel}, refunded ${v.rebateRefunded} <= ${DUST}: ${v.refundWithinDust}`);
const passed=verdict.every(v=>v.oldOk&&v.newOk&&v.rebateMatchesModel&&v.refundWithinDust&&v.grossWithinNewAllowance);
const dir=resolve(directory,'results/pool-vault-stx');mkdirSync(dir,{recursive:true});
writeFileSync(resolve(dir,'vault-allowance-proof.json'),JSON.stringify({sid,url:`https://stxer.xyz/simulations/mainnet/${sid}`,block:forkBlock,
 sourceHashes:{...sourceHashes,'juice-pool-swap-vault-oldallow (TEST-ONLY)':sha(oldSource)},rows,verdict,passed},null,2)+'\n');
console.log(`View: https://stxer.xyz/simulations/mainnet/${sid}`);
console.log(passed?'allowance proof: all cases as expected':'allowance proof: NOT as expected');
if(!passed)process.exitCode=1;
