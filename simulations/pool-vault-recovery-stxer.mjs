import {createHash} from 'node:crypto';
import {withVaultArgument} from './_pool-vault-interface.mjs';
// Mainnet fork only: unchanged Juice sources, real token/market/router contracts.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory=dirname(fileURLToPath(import.meta.url));
const require=createRequire(resolve(directory,'../package.json'));
const {SimulationBuilder,getSimulationResult}=require('stxer');
const {Cl,ClarityVersion,serializeCV,deserializeCV,cvToString,getAddressFromPrivateKey}=require('@stacks/transactions');
const DEP='SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const POX='SP000000000000000000002Q6VF78.pox-5';
const SBTC='SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const WSTX='SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2';
const MARKET=`${DEP}.markets-sbtc-stx-jing-v6`;
const POOL=`${DEP}.juice-pool-stx-signer-stx-rewards`;
const VAULT=`${DEP}.juice-pool-swap-vault`;
const WHALE='SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1';
const ALICE=getAddressFromPrivateKey('7'.repeat(64)+'01','mainnet');
const BOB=getAddressFromPrivateKey('8'.repeat(64)+'01','mainnet');
const NODE=process.env.STACKS_API_URL||'http://77.42.3.101/stacks-api';
const API=process.env.STXER_API_URL||'https://api.stxer.xyz';
const FUND=100000;
const u=Cl.uint,cp=id=>Cl.contractPrincipal(...id.split('.'));
async function read(id,fn,args=[]){
 const [address,name]=id.split('.');
 const response=await fetch(`${NODE}/v2/contracts/call-read/${address}/${name}/${fn}`,{
  method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(20000),
  body:JSON.stringify({sender:DEP,arguments:args.map(v=>'0x'+serializeCV(v).replace(/^0x/,''))})});
 const body=await response.json();if(!body.okay)throw new Error(`${fn}: ${JSON.stringify(body)}`);
 return deserializeCV(body.result);
}
const {fetchLazerUpdateAny}=await import('./_pool-vault-lazer.mjs');
const proof=await fetchLazerUpdateAny();
const update=Cl.buffer(Buffer.from(proof.hex.replace(/^0x/,''),'hex'));
const tipResponse=await fetch(`${NODE}/extended/v1/block?limit=1`,{signal:AbortSignal.timeout(20000)});
if(!tipResponse.ok)throw new Error(`tip HTTP ${tipResponse.status}`);
const tip=(await tipResponse.json()).results[0];
const cycle=Number((await read(POX,'current-pox-reward-cycle')).value)-1;
const marketCycle=await read(MARKET,'get-current-cycle');
const sellers=await read(MARKET,'get-token-x-depositors',[marketCycle]);
const buyers=await read(MARKET,'get-token-y-depositors',[marketCycle]);
const operatorResponse=await fetch(`${NODE}/v2/data_var/${DEP}/markets-sbtc-stx-jing-v6/operator`,{signal:AbortSignal.timeout(20000)});
if(!operatorResponse.ok)throw new Error(`operator HTTP ${operatorResponse.status}`);
const operator=deserializeCV((await operatorResponse.json()).data).value;
const builder=SimulationBuilder.new({stacksNodeAPI:NODE,apiEndpoint:API,skipTracing:true}).useBlockHeight(tip.height).withSender(DEP);
const plan=[],batches=[],sourceHashes={};
const ok=v=>v.startsWith('(ok');
function call(label,id,fn,args=[],want=ok,sender=DEP){
 const slot=plan.length;
 builder.addContractCall({contract_id:id,function_name:fn,function_args:withVaultArgument(POOL,VAULT,id,fn,args,Cl),sender});
 plan.push({label,kind:'tx',want});return slot;
}
function ev(label,id,code,want){const slot=plan.length;builder.addEvalCode(id,code);plan.push({label,kind:'eval',want});return slot;}
function advance(){builder.addAdvanceBlocks({bitcoin_blocks:1,stacks_blocks_per_bitcoin:1,bitcoin_interval_secs:1});plan.push({label:'advance one burn block for router cooldown',kind:'advance'});}
for(const [name,path] of [['juice-swap-vault-trait','../contracts/pox-5/juice-swap-vault-trait.clar'],['juice-pool-swap-vault','../contracts/pox-5/juice-pool-swap-vault.clar'],['juice-pool-stx-signer-stx-rewards','../contracts/pox-5/juice-pool-stx-signer-stx-rewards.clar']]){
 builder.addContractDeploy({contract_name:name,source_code:((source)=>{sourceHashes[name]=createHash('sha256').update(source).digest('hex');return source;})(readFileSync(resolve(directory,path),'utf8')),clarity_version:ClarityVersion.Clarity6});
 plan.push({label:`deploy unchanged ${name}`,kind:'deploy'});
}
for(const [side,orders] of [['x',sellers],['y',buyers]])for(const order of orders.value){
 if(order.value.includes('.'))throw new Error('Live book contains a contract maker; cannot safely isolate the fork book');
 call(`fork-only cancel existing ${side} maker`,MARKET,`cancel-token-${side}-deposit`,[cp(side==='x'?SBTC:WSTX),Cl.stringAscii(side==='x'?'sbtc-token':'wstx')],ok,order.value);
}
function claim(label,offset){
 const c=cycle-offset,key=`{ reward-cycle: u${c}, bond-index: none, signer: '${POOL} }`;
 call(`${label}: transfer real sBTC into PoX fork`,SBTC,'transfer',[u(FUND),Cl.principal(WHALE),Cl.principal(POX),Cl.none()],'(ok true)',WHALE);
 ev(`${label}: seed earned rewards and fixed 1:3 shares`,POX,`(begin
  (map-set signer-shares-staked-for-cycle ${key} u4)
  (map-set signer-pending-staked-ustx-per-cycle { signer: '${POOL}, cycle: u${c} } u4)
  (map-set signer-rewards-per-token-settled-for-cycle ${key} (get-rewards-per-token-for-cycle u${c} none))
  (map-set signer-unclaimed-rewards-for-cycle ${key} u${FUND})
  (map-set staker-shares-staked-for-cycle { reward-cycle: u${c}, bond-index: none, signer: '${POOL}, staker: '${ALICE} } u1)
  (map-set staker-shares-staked-for-cycle { reward-cycle: u${c}, bond-index: none, signer: '${POOL}, staker: '${BOB} } u3)
  (var-set last-accounted-rewards-only (+ (var-get last-accounted-rewards-only) u${FUND}))
  (ok true))`,'(ok true)');
 call(`${label}: real PoX claim funds new batch`,POOL,'pox-claim-rewards',[Cl.list([]),u(c)],v=>ok(v)&&v.includes(`(total-rewards u${FUND})`));
 ev(`${label}: pending batch belongs to this cycle`,POOL,'(get-pending-swap)',`(some (tuple (reward-cycle u${c}) (tranche u0)))`);
 ev(`${label}: vault contains only new batch sBTC`,VAULT,`(contract-call? '${SBTC} get-balance current-contract)`,`(ok u${FUND})`);
 const b={label,cycle:c,recovered:false};batches.push(b);return b;
}
function age(label,blocks){ev(`${label}: fork fixture ages funding clock by ${blocks} blocks`,VAULT,`(begin (var-set batch-start (some (- burn-block-height u${blocks}))) true)`,'true');}
function recover(b){
 b.recovered=true;
 call(`${b.label}: outsider cannot recover`,POOL,'emergency-recover',[],'(err u100)',ALICE);
 call(`${b.label}: admin cannot recover a young batch`,POOL,'emergency-recover',[],'(err u16046)');
 age(b.label,4319);
 call(`${b.label}: recovery blocked one block before deadline`,POOL,'emergency-recover',[],'(err u16046)');
 age(b.label,4320);
 call(`${b.label}: pause Jing market`,MARKET,'set-paused',[Cl.bool(true)],'(ok true)',operator);
 call(`${b.label}: recover real sBTC and any STX despite pause`,POOL,'emergency-recover');
 ev(`${b.label}: recovery clears pending batch`,POOL,'(get-pending-swap)','none');
 ev(`${b.label}: recovery empties liquid/resting/parked sBTC`,VAULT,'(is-empty)','true');
 ev(`${b.label}: recovery resets both phases`,VAULT,'(get-clock)',v=>v.includes('(batch-start none)')&&v.includes('(window-open false)')&&v.includes('(window-elapsed false)'));
 call(`${b.label}: normal finalization cannot repeat recovery`,POOL,'finalize-swap',[],'(err u115)');
 call(`${b.label}: recovery cannot repeat`,POOL,'emergency-recover',[],'(err u115)');
 call(`${b.label}: resume Jing market for next batch`,MARKET,'set-paused',[Cl.bool(false)],'(ok true)',operator);
 capturePots(b);
}
function capturePots(b){
 b.stxPot=ev(`${b.label}: recorded STX pot`,POOL,`(get-stx-pot u${b.cycle} u0)`,v=>/^u\d+$/.test(v));
 b.sbtcPot=ev(`${b.label}: recorded recovered sBTC pot`,POOL,`(get-recovered-sbtc-pot u${b.cycle} u0)`,v=>/^u\d+$/.test(v));
}
function balances(label){
 const slots={};for(const [name,who] of [['Alice',ALICE],['Bob',BOB]]){
  slots[`${name}Stx`]=ev(`${label}: ${name} native STX`,POOL,`(stx-get-balance '${who})`,v=>/^u\d+$/.test(v));
  slots[`${name}Sbtc`]=ev(`${label}: ${name} real sBTC`,POOL,`(unwrap-panic (contract-call? '${SBTC} get-balance '${who}))`,v=>/^u\d+$/.test(v));
 }return slots;
}
function pay(b,active){
 b.before=balances(`${b.label} before payout`);
 call(`${b.label}: native STX uses existing payout path`,POOL,'pay-stx-stakers',[Cl.list([Cl.principal(ALICE),Cl.principal(BOB)]),u(b.cycle),u(0)]);
 if(b.recovered)call(`${b.label}: sBTC uses separate recovery payout path`,POOL,'pay-recovered-sbtc-stakers',[Cl.list([Cl.principal(ALICE),Cl.principal(BOB)]),u(b.cycle),u(0)]);
 b.after=balances(`${b.label} after payout`);
 call(`${b.label}: STX replay pays nothing`,POOL,'pay-stx-stakers',[Cl.list([Cl.principal(ALICE),Cl.principal(BOB)]),u(b.cycle),u(0)],'(ok u0)');
 if(b.recovered)call(`${b.label}: sBTC replay pays nothing`,POOL,'pay-recovered-sbtc-stakers',[Cl.list([Cl.principal(ALICE),Cl.principal(BOB)]),u(b.cycle),u(0)],'(ok u0)');
 b.replay=balances(`${b.label} after replay`);
 if(active){
  ev(`${b.label}: old payouts leave new batch pending`,POOL,'(get-pending-swap)',`(some (tuple (reward-cycle u${active.cycle}) (tranche u0)))`);
  ev(`${b.label}: old payouts cannot spend new vault rewards`,VAULT,`(contract-call? '${SBTC} get-balance current-contract)`,`(ok u${FUND})`);
 }
}
const a=claim('A resting recovery',0);
call('A: real Jing maker placement',VAULT,'jing-place',[update]);
recover(a);
const b=claim('B second recovery with partial conversion',1);
pay(a,b);
age('B liquidation phase',288);
call('B: convert half through real smart router',VAULT,'router-swap',[u(50000),update],v=>ok(v)&&v.includes('(unsold u0)'),ALICE);
recover(b);
const c=claim('C normal batch after recovery',2);
pay(b,c);
age('C liquidation phase',288);
advance();
call('C: first normal chunk through real router',VAULT,'router-swap',[u(50000),update],v=>ok(v)&&v.includes('(unsold u0)'),ALICE);
advance();
call('C: second normal chunk through real router',VAULT,'router-swap',[u(50000),update],v=>ok(v)&&v.includes('(unsold u0)'),BOB);
call('C: normal finalization after earlier recoveries',POOL,'finalize-swap',[],v=>/^\(ok u[1-9]\d*\)$/.test(v));
ev('C: normal finalization clears pending state',POOL,'(get-pending-swap)','none');
capturePots(c);
const d=claim('D recovery after normal batch',3);
pay(c,d);
recover(d);
pay(d);
ev('all batches completed: vault empty',VAULT,'(is-empty)','true');
ev('all batches completed: no pending swap',POOL,'(get-pending-swap)','none');
console.log(`Juice: submitting ${plan.length} recovery continuity checks with unchanged contracts`);
const id=await builder.run();console.log(`View: https://stxer.xyz/simulations/mainnet/${id}`);
const result=await getSimulationResult(id,{stxerApi:API});
const checks=plan.map((p,i)=>{
 const step=result.steps[i]?.Result;let actual;
 if(p.kind==='advance')actual=step?.AdvanceBlocks?.Ok?'ok':`ENGINE ${JSON.stringify(step)}`;
 else if(p.kind==='eval')actual=step?.Eval?.Ok!==undefined?cvToString(deserializeCV(step.Eval.Ok)):`ENGINE ${JSON.stringify(step)}`;
 else actual=step?.Transaction?.Ok&&!step.Transaction.Ok.vm_error?cvToString(deserializeCV(step.Transaction.Ok.result)):`ENGINE ${JSON.stringify(step)}`;
 const passed=p.kind==='advance'?actual==='ok':p.kind==='deploy'?ok(actual):typeof p.want==='function'?p.want(actual):actual===p.want;
 console.log(`${passed?'PASS':'FAIL'} ${p.label}: ${actual.slice(0,180)}`);return {label:p.label,passed,actual};
});
const uint=slot=>BigInt(checks[slot].actual.match(/^u(\d+)$/)?.[1]??'-1');
if(checks.every(c=>c.passed))for(const b of batches){
 for(const [name,shares] of [['Alice',1n],['Bob',3n]])for(const [asset,pot] of [['Stx',b.stxPot],['Sbtc',b.sbtcPot]]){
  const key=`${name}${asset}`,paid=uint(b.after[key])-uint(b.before[key]),expected=uint(pot)*shares/4n;
  checks.push({label:`${b.label}: ${name} ${asset} matches its own 1:3 batch pot`,passed:paid===expected,actual:`${paid}, expected ${expected}`});
  checks.push({label:`${b.label}: ${name} ${asset} unchanged on replay`,passed:uint(b.replay[key])===uint(b.after[key]),actual:`balance ${uint(b.replay[key])}`});
 }
}
const report={id,url:`https://stxer.xyz/simulations/mainnet/${id}`,kind:'juice',mode:'recovery-continuity',block:tip.height,burn:tip.burn_block_height,productionSourcesUnmodified:true,sourceHashes,proofTimestamp:proof.ts,
 fixtures:['PoX crystallized rewards and 1:3 shares seeded in fork; real sBTC transfers back the rewards; STX lock admission not tested','Funding clock aged via explicit vault Eval fixtures at 288, 4319 and 4320 blocks to retain valid signed oracle updates; not a real month of elapsed chain time','Existing Jing orders canceled only in fork; real Jing operator impersonated to pause/resume','Two burn blocks advanced with one-second synthetic intervals for production router cooldown'],checks,result};
const resultsDirectory=resolve(directory,'results/pool-vault-stx');mkdirSync(resultsDirectory,{recursive:true});
writeFileSync(resolve(resultsDirectory,'juice-recovery-continuity.json'),JSON.stringify(report,null,2));
if(checks.some(c=>!c.passed))throw new Error(`${checks.filter(c=>!c.passed).length}/${checks.length} continuity checks failed`);
console.log(`Juice recovery continuity: ${checks.length}/${checks.length} checks passed`);
