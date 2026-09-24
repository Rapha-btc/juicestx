// Mainnet-fork emergency swap checks; no production transactions.
const fs=require('fs');
const {createHash}=require('node:crypto');
const path=require('node:path');
const base=path.resolve(__dirname,'..');
const {SimulationBuilder,getSimulationResult}=require(base+'/node_modules/stxer');
const {Cl,ClarityVersion,deserializeCV,cvToString}=require(base+'/node_modules/@stacks/transactions');
const DEP='SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const POOL=DEP+'.juice-pool-stx-signer-stx-rewards', VAULT=DEP+'.juice-pool-swap-vault';
const SBTC='SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const DIA='SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle';
const WHALE='SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1';
const NODE=process.env.STACKS_API_URL||'http://77.42.3.101/stacks-api',API=process.env.STXER_API_URL||'https://api.stxer.xyz';
const nativeMode=process.argv.includes('--native');
(async()=>{
const {withVaultArgument}=await import('./_pool-vault-interface.mjs');
const tipResp=await fetch(NODE+'/extended/v1/block?limit=1',{signal:AbortSignal.timeout(20000)});
if(!tipResp.ok)throw Error('tip '+tipResp.status);
const tip=(await tipResp.json()).results[0];
const b=SimulationBuilder.new({stacksNodeAPI:NODE,apiEndpoint:API,skipTracing:false}).useBlockHeight(tip.height).withSender(DEP);
const plan=[],sourceHashes={};
(await import('./_jing-v6-3.mjs')).appendJingStack(b,plan,sourceHashes);
const ev=(label,id,code)=>{b.addEvalCode(id,code);plan.push({label,kind:'eval'});};
const call=(label,id,fn,args,sender=DEP)=>{b.addContractCall({contract_id:id,function_name:fn,function_args:withVaultArgument(POOL,VAULT,id,fn,args,Cl),sender});plan.push({label,kind:'tx'});};
for(const [name,file]of [['juice-pool-swap-vault','juice-pool-swap-vault.clar'],['juice-pool-stx-signer-stx-rewards','juice-pool-stx-signer-stx-rewards.clar']]){
b.addContractDeploy({contract_name:name,source_code:((source)=>{sourceHashes[name]=createHash('sha256').update(source).digest('hex');return source;})(fs.readFileSync(base+'/contracts/pox-5/'+file,'utf8')),clarity_version:ClarityVersion.Clarity6});plan.push({label:'deploy exact local '+name,kind:'tx'});}
ev('raw DIA STX/USD',VAULT,`(contract-call? '${DIA} get-value "STX/USD")`);
ev('raw DIA BTC/USD',VAULT,`(contract-call? '${DIA} get-value "BTC/USD")`);
ev('DIA freshness arithmetic',VAULT,`(let ((now (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))))
(stx (unwrap-panic (contract-call? '${DIA} get-value "STX/USD")))
(btc (unwrap-panic (contract-call? '${DIA} get-value "BTC/USD"))))
{previous-block-time: now, max-age: MAX_DIA_AGE, stx-ts-seconds: (/ (get timestamp stx) u1000), btc-ts-seconds: (/ (get timestamp btc) u1000),
stx-valid: (>= (+ (/ (get timestamp stx) u1000) MAX_DIA_AGE) now), btc-valid: (>= (+ (/ (get timestamp btc) u1000) MAX_DIA_AGE) now)})`);
ev('validated STX/USD integer',VAULT,'(get-dia-value "STX/USD")');
ev('validated BTC/USD integer',VAULT,'(get-dia-value "BTC/USD")');
ev('legacy output guards for 10000 sats',VAULT,`(let ((mid (try! (get-dia-price)))) (ok {mid: mid, normal-limit: (floor-of mid), normal-min-ustx: (floor-out u10000 (floor-of mid)), velar-min-ustx: (floor-out u10000 (/ (* mid (- BPS_PRECISION VELAR_SLIPPAGE_BPS)) BPS_PRECISION))}))`);
ev('real deployed RFQ native price',VAULT,"(contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3 get-native-price)");
ev('emergency DIA price and limit',VAULT,'(get-no-pyth-price)');
call('admin sets DIA emergency tolerance to 10 percent',POOL,'set-vault-no-pyth-slippage-bps',[Cl.uint(1000)]);
call('tolerance above 50 percent rejected',POOL,'set-vault-no-pyth-slippage-bps',[Cl.uint(5001)]);
call('admin sets zero-block window',POOL,'set-vault-window-blocks',[Cl.uint(0)]);
call('fixture: real whale sBTC funds draft pool on fork',SBTC,'transfer',[Cl.uint(100000),Cl.principal(WHALE),Cl.principal(POOL),Cl.none()],WHALE);
ev('fixture: pool funds exact draft vault',POOL,'(as-contract? ((with-ft SBTC "sbtc-token" u100000)) (try! (contract-call? .juice-pool-swap-vault fund u100000)))');
ev('zero window immediately elapsed',VAULT,'(get-clock)');
if(nativeMode){
ev('fixture: DIA feed stale by one second',DIA,`(let ((old (unwrap-panic (contract-call? '${DIA} get-value "STX/USD"))) (now (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))))) (map-set values "STX/USD" {value: (get value old), timestamp: (* (- now u7201) u1000)}))`);
ev('DIA helper rejects stale feed',VAULT,'(get-dia-value "STX/USD")');
ev('emergency quote falls back to native half-price',VAULT,'(get-no-pyth-price)');
call('real native fallback swap, no Pyth or Jing',POOL,'router-swap-split-dia',[Cl.uint(10000),Cl.uint(4000),Cl.uint(3000),Cl.uint(3000)]);
ev('balances after native fallback',VAULT,'{sbtc: (sbtc-balance), stx: (stx-get-balance current-contract)}');
ev('fixture: DIA STX price zero',DIA,'(map-set values "STX/USD" {value: u0, timestamp: u0})');
ev('zero DIA also falls back to native',VAULT,'(get-no-pyth-price)');
call('outsider cannot use emergency pool wrapper',POOL,'router-swap-split-dia',[Cl.uint(10000),Cl.uint(10000),Cl.uint(0),Cl.uint(0)],'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM');
ev('fixture: native coinbase zero',DEP+'.rfq-sbtc-stx-jing-v2-3','(var-set coinbase-ustx u0)');
ev('neither price usable fails closed',VAULT,'(get-no-pyth-price)');
call('fixture: disable cooldown only to isolate invalid price guard',POOL,'set-vault-router-cooldown',[Cl.uint(0)]);
call('unusable price split rejected',POOL,'router-swap-split-dia',[Cl.uint(10000),Cl.uint(10000),Cl.uint(0),Cl.uint(0)]);
}else{
call('real DIA emergency DLMM swap',POOL,'router-swap-split-dia',[Cl.uint(10000),Cl.uint(10000),Cl.uint(0),Cl.uint(0)]);
ev('balances after DIA emergency',VAULT,'{sbtc: (sbtc-balance), stx: (stx-get-balance current-contract)}');
}
console.log('Submitting',plan.length,'steps, mainnet block',9021103);
const id=await b.run();console.log('SIMULATION https://stxer.xyz/simulations/mainnet/'+id);
const result=await getSimulationResult(id,{stxerApi:API});
const checks=plan.map((p,i)=>{const r=result.steps[i]?.Result;let value;
if(p.kind==='eval')value=r?.Eval?.Ok!==undefined?cvToString(deserializeCV(r.Eval.Ok)):JSON.stringify(r);
else if(p.kind==='advance')value=JSON.stringify(r);
else value=r?.Transaction?.Ok&&!r.Transaction.Ok.vm_error?cvToString(deserializeCV(r.Transaction.Ok.result)):JSON.stringify(r);
console.log(p.label+': '+value);return {...p,value};});
const expectedErrors={
 'tolerance above 50 percent rejected':'(err u16033)',
 'DIA helper rejects stale feed':'(err u16036)',
 'outsider cannot use emergency pool wrapper':'(err u100)',
 'neither price usable fails closed':'(err u16013)',
 'unusable price split rejected':'(err u16013)',
};
for(const check of checks){
 check.passed=expectedErrors[check.label]?check.value===expectedErrors[check.label]:
 check.label.startsWith('fixture: DIA')||check.label==='fixture: native coinbase zero'?check.value==='true':
 check.value.startsWith('(ok ')||check.value.startsWith('(tuple ');
}
for(let i=0;i<checks.length;i++)if(checks[i].label.startsWith('real ')&&checks[i].label.includes('swap')){
 const receipt=result.steps[i]?.Result?.Transaction?.Ok;
 const events=(receipt?.events||[]).map(e=>typeof e==='string'?JSON.parse(e):e);
 const event=events.find(e=>e.committed&&e.contract_event?.contract_identifier===DEP+'.swap-router-sbtc-stx-jing-v5-3');
 const routing=event?deserializeCV(event.contract_event.raw_value).value:null;
 checks.push({label:'router reports Jing skipped and no unsold sats',kind:'event',value:routing?cvToString(deserializeCV(event.contract_event.raw_value)):'missing print',
 passed:routing?.['jing-ok']?.type==='false'&&routing?.['jing-in']?.value===0n&&routing?.['jing-out']?.value===0n&&routing?.unsold?.value===0n});
 break;
}
const directory=path.join(base,'simulations/results/pool-vault-stx');fs.mkdirSync(directory,{recursive:true});
const output=path.join(directory,nativeMode?'juice-emergency-native.json':'juice-emergency-dia.json');
fs.writeFileSync(output,JSON.stringify({id,url:'https://stxer.xyz/simulations/mainnet/'+id,forkBlock:9021103,observedTip:tip,sourceHashes,mode:nativeMode?'emergency-native':'emergency-dia',
 fixtures:['Real whale transfer and pool Eval funding on fork only','Admin zero window; no Pyth fetched or supplied',...(nativeMode?['DIA stale and zero map fixtures; RFQ coinbase zero fixture; final cooldown disabled to isolate price rejection']:[])],checks,result},null,2)+'\n');
const failed=checks.filter(c=>!c.passed);if(failed.length)throw Error(failed.length+' checks failed: '+failed.map(c=>c.label).join(', '));
console.log(checks.length+'/'+checks.length+' checks passed; report '+output);
})().catch(e=>{console.error(e);process.exitCode=1;});
