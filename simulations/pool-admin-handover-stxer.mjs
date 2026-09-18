import {createHash} from 'node:crypto';
import {withVaultArgument} from './_pool-vault-interface.mjs';
// Mainnet fork only: unchanged Juice sources, timed propose/accept admin handover.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory=dirname(fileURLToPath(import.meta.url));
const require=createRequire(resolve(directory,'../package.json'));
const {SimulationBuilder,getSimulationResult}=require('stxer');
const {Cl,ClarityVersion,deserializeCV,cvToString,getAddressFromPrivateKey}=require('@stacks/transactions');
const DEP='SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const POOL=`${DEP}.juice-pool-stx-signer-stx-rewards`;
const VAULT=`${DEP}.juice-pool-swap-vault`;
const ALICE=getAddressFromPrivateKey('7'.repeat(64)+'01','mainnet');
const BOB=getAddressFromPrivateKey('8'.repeat(64)+'01','mainnet');
const NODE=process.env.STACKS_API_URL||'http://77.42.3.101/stacks-api';
const API=process.env.STXER_API_URL||'https://api.stxer.xyz';
const tipResponse=await fetch(`${NODE}/extended/v1/block?limit=1`,{signal:AbortSignal.timeout(20000)});
if(!tipResponse.ok)throw new Error(`tip HTTP ${tipResponse.status}`);
const tip=(await tipResponse.json()).results[0];
const builder=SimulationBuilder.new({stacksNodeAPI:NODE,apiEndpoint:API,skipTracing:true}).useBlockHeight(tip.height).withSender(DEP);
const plan=[],sourceHashes={};
const ok=v=>v.startsWith('(ok');
function call(label,id,fn,args=[],want=ok,sender=DEP){
 const slot=plan.length;
 builder.addContractCall({contract_id:id,function_name:fn,function_args:withVaultArgument(POOL,VAULT,id,fn,args,Cl),sender});
 plan.push({label,kind:'tx',want});return slot;
}
function ev(label,id,code,want){const slot=plan.length;builder.addEvalCode(id,code);plan.push({label,kind:'eval',want});return slot;}
for(const [name,path] of [['juice-swap-vault-trait','../contracts/pox-5/juice-swap-vault-trait.clar'],['juice-pool-swap-vault','../contracts/pox-5/juice-pool-swap-vault.clar'],['juice-pool-stx-signer-stx-rewards','../contracts/pox-5/juice-pool-stx-signer-stx-rewards.clar']]){
 builder.addContractDeploy({contract_name:name,source_code:((source)=>{sourceHashes[name]=createHash('sha256').update(source).digest('hex');return source;})(readFileSync(resolve(directory,path),'utf8')),clarity_version:ClarityVersion.Clarity6});
 plan.push({label:`deploy unchanged ${name}`,kind:'deploy'});
}
const admin=(label,want)=>ev(label,POOL,'(get-admin)',want);
const pending=(label,want)=>ev(label,POOL,'(get-pending-admin)',want);
call('accept without proposal fails',POOL,'accept-admin',[],'(err u117)',ALICE);
call('outsider cannot propose',POOL,'propose-admin',[Cl.principal(ALICE)],'(err u100)',BOB);
call('current admin proposes Alice',POOL,'propose-admin',[Cl.principal(ALICE)],`(ok ${ALICE})`);
admin('proposal leaves current admin in charge',`${DEP}`);
pending('proposal records Alice and 144-block deadline',v=>v.includes(`(admin (some ${ALICE}))`));
call('Alice cannot accept immediately',POOL,'accept-admin',[],'(err u114)',ALICE);
call('Bob cannot accept Alice proposal',POOL,'accept-admin',[],'(err u100)',BOB);
call('current admin cannot accept on nominee behalf',POOL,'accept-admin',[],'(err u100)',DEP);
call('Alice cannot administer before accepting',POOL,'set-paused',[Cl.bool(true)],'(err u100)',ALICE);
call('current admin retains privileges while pending',POOL,'set-paused',[Cl.bool(false)],'(ok true)',DEP);
call('outsider cannot cancel proposal',POOL,'cancel-admin-proposal',[],'(err u100)',BOB);
function blocks(n){builder.addAdvanceBlocks({bitcoin_blocks:n,stacks_blocks_per_bitcoin:1,bitcoin_interval_secs:1});plan.push({label:`advance ${n} real fork Bitcoin blocks`,kind:'advance'});}
blocks(143);
call('Alice cannot accept at 143 blocks',POOL,'accept-admin',[],'(err u114)',ALICE);
call('replace nominee with Bob; restart cooldown',POOL,'propose-admin',[Cl.principal(BOB)],`(ok ${BOB})`);
blocks(1);
call('superseded Alice cannot accept after original deadline',POOL,'accept-admin',[],'(err u100)',ALICE);
call('Bob cannot inherit original deadline',POOL,'accept-admin',[],'(err u114)',BOB);
call('current admin cancels Bob proposal',POOL,'cancel-admin-proposal',[],'(ok true)',DEP);
pending('cancellation clears nominee',v=>v.includes('(admin none)')&&v.includes('(proposed-at u0)'));
call('cancelled nominee cannot accept',POOL,'accept-admin',[],'(err u117)',BOB);
admin('cancellation preserves original admin',`${DEP}`);
call('propose Bob again',POOL,'propose-admin',[Cl.principal(BOB)],`(ok ${BOB})`);
blocks(143);
call('Bob cannot accept at 143 blocks',POOL,'accept-admin',[],'(err u114)',BOB);
blocks(1);
call('Bob accepts at exactly 144 blocks',POOL,'accept-admin',[],'(ok true)',BOB);
admin('Bob is now the admin',`${BOB}`);
pending('acceptance clears nominee and proposal height',v=>v.includes('(admin none)')&&v.includes('(proposed-at u0)'));
call('accepted proposal cannot replay',POOL,'accept-admin',[],'(err u117)',BOB);
call('former admin loses pause authority',POOL,'set-paused',[Cl.bool(true)],'(err u100)',DEP);
call('former admin cannot propose another successor',POOL,'propose-admin',[Cl.principal(ALICE)],'(err u100)',DEP);
call('former admin cannot cancel proposals',POOL,'cancel-admin-proposal',[],'(err u100)',DEP);
call('new admin can pause',POOL,'set-paused',[Cl.bool(true)],'(ok true)',BOB);
ev('pause change persisted',POOL,'(is-paused)','true');
call('new admin can resume',POOL,'set-paused',[Cl.bool(false)],'(ok true)',BOB);
call('new admin proposes another successor',POOL,'propose-admin',[Cl.principal(ALICE)],`(ok ${ALICE})`,BOB);
blocks(143);
call('second successor also waits 144 blocks',POOL,'accept-admin',[],'(err u114)',ALICE);
blocks(1);
call('second successor accepts fresh proposal',POOL,'accept-admin',[],'(ok true)',ALICE);
admin('successive handover reaches Alice',`${ALICE}`);
call('Bob loses admin authority after second handover',POOL,'set-paused',[Cl.bool(true)],'(err u100)',BOB);
call('Alice can administer after second handover',POOL,'set-paused',[Cl.bool(false)],'(ok true)',ALICE);
console.log(`Juice: submitting ${plan.length} timed admin handover checks with unchanged contracts`);
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
const eventChecks=[];
for(let i=0;i<plan.length;i++){
 const label=plan[i].label;
 let topic;
 if(label.startsWith('current admin proposes')||label.startsWith('replace nominee')||label==='propose Bob again'||label==='new admin proposes another successor')topic='propose-admin';
 if(label==='current admin cancels Bob proposal')topic='cancel-admin-proposal';
 if(label==='Bob accepts at exactly 144 blocks'||label==='second successor accepts fresh proposal')topic='accept-admin';
 if(!topic)continue;
 const events=result.steps[i]?.Result?.Transaction?.Ok?.events??[];
 const printed=events.some(raw=>{
  const event=typeof raw==='string'?JSON.parse(raw):raw;
  if(event.type!=='contract_event'||event.contract_event?.contract_identifier!==POOL||!event.committed)return false;
  const value=deserializeCV(event.contract_event.raw_value);
  return value.value?.topic?.value===topic;
 });
 eventChecks.push({label:`${label}: ${topic} print emitted`,passed:printed,actual:'decoded committed pool print event'});
}
checks.push(...eventChecks);
const report={id,url:`https://stxer.xyz/simulations/mainnet/${id}`,kind:'juice',mode:'admin-handover',block:tip.height,burn:tip.burn_block_height,productionSourcesUnmodified:true,sourceHashes,
 fixtures:['Admin handover uses actual fork Bitcoin-block advances at 143/144-block boundaries; one-second synthetic intervals','No storage seeds, oracle updates or reward/share fixtures are used; signer registration is outside this scenario'],checks,result};
const resultsDirectory=resolve(directory,'results/pool-vault-stx');mkdirSync(resultsDirectory,{recursive:true});
writeFileSync(resolve(resultsDirectory,'juice-admin-handover.json'),JSON.stringify(report,null,2));
if(checks.some(c=>!c.passed))throw new Error(`${checks.filter(c=>!c.passed).length}/${checks.length} admin checks failed`);
console.log(`Juice admin handover: ${checks.length}/${checks.length} checks passed`);
