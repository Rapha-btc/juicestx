// Mainnet fork only: focused scenarios for the Nested Quinn L-1 / L-2 and
// Void Kael #6 / #7 / #8 vault fixes (see jing-contracts-v3
// README-audit-bounty-v6-3-submit-settle.md). Unchanged Juice vault and pool,
// current Jing market / core / router, real sBTC, AMMs and PoX-5 claim path.
// PoX earned rewards and 1:3 shares are Eval fixtures backed by real fork sBTC.
import {appendJingStack} from './_jing-v6-3.mjs';
import {POOL_ID,VAULT_ID,juiceSource,juiceForkBlock} from './_juice-fork.mjs';
import {withVaultArgument} from './_pool-vault-interface.mjs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=dirname(fileURLToPath(import.meta.url));
const require=createRequire(resolve(directory,'../package.json'));
const {SimulationBuilder,getSimulationResult}=require('stxer');
const {Cl,ClarityVersion,serializeCV,deserializeCV,cvToString,getAddressFromPrivateKey}=require('@stacks/transactions');
const DEP='SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const STRANGER='SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const TAKER='SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51';
const POX='SP000000000000000000002Q6VF78.pox-5';
const SBTC='SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const WSTX='SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2';
const MARKET=`${DEP}.markets-sbtc-stx-jing-v6-3`;
const ROUTER=`${DEP}.swap-router-sbtc-stx-jing-v5-3`;
const POOL=POOL_ID;
const VAULT=VAULT_ID;
const WHALE='SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1';
const ALICE=getAddressFromPrivateKey('7'.repeat(64)+'01','mainnet');
const BOB=getAddressFromPrivateKey('8'.repeat(64)+'01','mainnet');
const NODE=process.env.STACKS_API_URL||'http://77.42.3.101/stacks-api';
const API=process.env.STXER_API_URL||'https://api.stxer.xyz';
const u=Cl.uint,cp=id=>Cl.contractPrincipal(...id.split('.'));
const sbtcCv=cp(SBTC),wstxCv=cp(WSTX);
// L-1: 0.3 BTC sold in 0.1 BTC chunks. Sized for AMM depth at the tip fork: the
// 1% floor takes only part of one chunk (partial sale, then u16047), and the rest
// sells at 3% / 10%, so the batch closes. At the tip, 3 BTC in 1 BTC chunks no
// longer clears within 10% in the fixed plan.
const BIG=30000000;
const BAND_FUND=300000,BAND_CAP=198380; // #8: Void Kael's measured book-capacity band 198,320-198,440
const CHUNK=10000000;    // L-1 max-chunk setting (0.1 BTC)
const MAKER=100000;      // #7: vault maker order, filled by a real taker
async function read(id,fn,args=[]){
 const [address,name]=id.split('.');
 const r=await fetch(`${NODE}/v2/contracts/call-read/${address}/${name}/${fn}`,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(20000),
  body:JSON.stringify({sender:DEP,arguments:args.map(v=>'0x'+serializeCV(v).replace(/^0x/,''))})});
 const body=await r.json();if(!body.okay)throw new Error(`${fn}: ${JSON.stringify(body)}`);return deserializeCV(body.result);
}
const {fetchLazerUpdateAny}=await import('./_pool-vault-lazer.mjs');
const proof=await fetchLazerUpdateAny();
const update=Cl.buffer(Buffer.from(proof.hex.replace(/^0x/,''),'hex'));
const mid=proof.px*100000000n/proof.py;
const tip=(await (await fetch(`${NODE}/extended/v1/block?limit=1`,{signal:AbortSignal.timeout(20000)})).json()).results[0];
const cycle=Number((await read(POX,'current-pox-reward-cycle')).value)-1;
const forkBlock=await juiceForkBlock(NODE);
const builder=SimulationBuilder.new({stacksNodeAPI:NODE,apiEndpoint:API,skipTracing:true}).useBlockHeight(forkBlock).withSender(DEP);
const plan=[],sourceHashes={},post=[];
appendJingStack(builder,plan,sourceHashes,forkBlock);
const ok=v=>v.startsWith('(ok');
const any=()=>true;
function call(label,id,fn,args=[],want=ok,sender=DEP){const slot=plan.length;builder.addContractCall({contract_id:id,function_name:fn,function_args:withVaultArgument(POOL,VAULT,id,fn,args,Cl),sender});plan.push({label,kind:'tx',want});return slot;}
function ev(label,id,code,want){const slot=plan.length;builder.addEvalCode(id,code);plan.push({label,kind:'eval',want});return slot;}
function advance(n=1){builder.addAdvanceBlocks({bitcoin_blocks:n,stacks_blocks_per_bitcoin:1,bitcoin_interval_secs:1});plan.push({label:`advance ${n} burn block(s), compressed timestamps`,kind:'advance'});}
const vaultSbtc=(label,want)=>ev(label,VAULT,`(contract-call? '${SBTC} get-balance current-contract)`,want);
const vaultStx=(label,want)=>ev(label,VAULT,'(stx-get-balance current-contract)',want);
const age=(label,blocks)=>ev(`${label}: fixture ages the funding clock by ${blocks} blocks`,VAULT,`(begin (var-set batch-start (some (- burn-block-height u${blocks}))) true)`,'true');
const donate=(label,n)=>call(label,SBTC,'transfer',[u(n),Cl.principal(WHALE),Cl.principal(VAULT),Cl.none()],'(ok true)',WHALE);
// Repo sources under the fork names; only the contract names are rewritten (sourceHashes keeps both hashes).
for(const repoName of ['juice-sbtc-autoswap','juice-pool-sbtc-signer']){
 const {name,source}=juiceSource(repoName,resolve(directory,'../contracts/pox-5/'+repoName+'.clar'),sourceHashes);
 builder.addContractDeploy({contract_name:name,source_code:source,clarity_version:ClarityVersion.Clarity6});
 plan.push({label:`deploy ${name} (repo source, names only rewritten)`,kind:'deploy'});
}
// a real PoX claim of `amount` sats for reward cycle (cycle - offset)
function claim(label,offset,amount,extra){
 const c=cycle-offset,key=`{ reward-cycle: u${c}, bond-index: none, signer: '${POOL} }`;
 call(`${label}: ${amount} real sBTC into PoX fork`,SBTC,'transfer',[u(amount),Cl.principal(WHALE),Cl.principal(POX),Cl.none()],'(ok true)',WHALE);
 ev(`${label}: seed earned rewards and 1:3 shares`,POX,`(begin
  (map-set signer-shares-staked-for-cycle ${key} u4)
  (map-set signer-pending-staked-ustx-per-cycle { signer: '${POOL}, cycle: u${c} } u4)
  (map-set signer-rewards-per-token-settled-for-cycle ${key} (get-rewards-per-token-for-cycle u${c} none))
  (map-set signer-unclaimed-rewards-for-cycle ${key} u${amount})
  (map-set staker-shares-staked-for-cycle { reward-cycle: u${c}, bond-index: none, signer: '${POOL}, staker: '${ALICE} } u1)
  (map-set staker-shares-staked-for-cycle { reward-cycle: u${c}, bond-index: none, signer: '${POOL}, staker: '${BOB} } u3)
  (var-set last-accounted-rewards-only (+ (var-get last-accounted-rewards-only) u${amount}))
  (try! (contract-call? '${POOL} validate-stake! '${ALICE} u${c} u1 u1 u0 false none))
  (try! (contract-call? '${POOL} validate-stake! '${BOB} u${c} u1 u3 u0 false none))
  (ok true))`,'(ok true)');
 const slot=call(`${label}: real PoX claim funds the vault`,POOL,'pox-claim-rewards',[Cl.list([]),u(c)],v=>ok(v)&&v.includes(`(total-rewards u${amount})`));
 ev(`${label}: pending tranche is this cycle`,POOL,'(get-pending-swap)',`(some (tuple (reward-cycle u${c}) (tranche u0)))`);
 return {c,slot};
}
function finalize(label,c,want){
 const slot=call(`${label}: finalize-swap attributes the batch`,POOL,'finalize-swap',[],want);
 ev(`${label}: pending tranche cleared`,POOL,'(get-pending-swap)','none');
 ev(`${label}: finalized tranche marked`,POOL,`(default-to false (map-get? finalized-tranches { reward-cycle: u${c}, tranche: u0 }))`,'true');
 return slot;
}

// ---- Void Kael #6: a dust-only batch closes and finishes with 0 STX ----
const A=claim('#6 dust batch',1,2);
vaultSbtc('#6: vault holds the 2-sat claim','(ok u2)');
ev('#6: 2 sats count as empty',VAULT,'(is-empty)','true');
vaultStx('#6: vault holds 0 STX','u0');
const a6close=call('#6: anyone closes the dust-only batch at once',VAULT,'close-batch',[],v=>ok(v)&&v.includes('close-batch'),STRANGER);
ev('#6: clock ready to finish',VAULT,'(get-clock)',v=>v.includes('(batch-start none)')&&v.includes('(ready-to-finish true)'));
const a6fin=finalize('#6',A.c,'(ok u0)');
ev('#6: 0-STX pot recorded',POOL,`(get-stx-pot u${A.c} u0)`,'u0');
ev('#6: vault flag cleared after finish',VAULT,'(get-clock)',v=>v.includes('(ready-to-finish false)'));
vaultSbtc('#6: the 2 sats stay in the vault as dust','(ok u2)');
call('#6: paying the 0 pot moves nothing',POOL,'pay-stx-stakers',[Cl.list([Cl.principal(ALICE),Cl.principal(BOB)]),u(A.c),u(0)],'(ok u0)');
post.push({kind:'events',slot:a6fin,label:'#6 finish: no STX transfer event, vault finish print amount 0, pool print amount 0',
 check:e=>e.stx.length===0&&e.ft.length===0&&e.vaultPrints.some(p=>p.includes('"finish"')&&p.includes('(amount u0)'))&&e.poolPrints.some(p=>p.includes('"finalize-swap"')&&p.includes('(amount u0)'))});

// ---- Nested Quinn L-2: window cap 288 ----
call('L-2: a 289-block window is refused',POOL,'set-vault-window-blocks',[u(289)],'(err u16033)');
ev('L-2: window unchanged at 288',VAULT,'(get-config)',v=>v.includes('(window-blocks u288)'));
call('L-2: 1008 (old cap) is refused',POOL,'set-vault-window-blocks',[u(1008)],'(err u16033)');
call('L-2: 288 is accepted',POOL,'set-vault-window-blocks',[u(288)],'(ok true)');
call('L-2: 287 accepted, then back to 288',POOL,'set-vault-window-blocks',[u(287)],'(ok true)');
ev('L-2: window reads 287',VAULT,'(get-config)',v=>v.includes('(window-blocks u287)'));
call('L-2: restore 288',POOL,'set-vault-window-blocks',[u(288)],'(ok true)');

// ---- #6 continued: the pool's next claim resumes; L-1: 8 sats sold reverts u16047 ----
const D=claim('#6 resume / L-1 small batch',2,6);
vaultSbtc('#6: next claim funded on top of the 2-sat dust (6 + 2 = 8)','(ok u8)');
age('L-1 small',288);
advance();
const d8=call('L-1 small: a sale of 8 sats (<= ROUTER_SLACK_SATS) reverts u16047',VAULT,'router-swap',[update],'(err u16047)',STRANGER);
const d8bal=vaultSbtc('L-1 small: nothing left the vault','(ok u8)');
ev('L-1 small: batch still open, cooldown not burned',VAULT,'(get-config)',v=>v.includes('(last-router-swap u0)'));
const d9don=donate('L-1 small: whale donates 1 sat',1);
const d9=call('L-1 small: 9 sats sell in the same burn block (the revert burned no cooldown)',VAULT,'router-swap',[update],v=>ok(v)&&v.includes('(amount u9)')&&v.includes('(unsold u0)'),STRANGER);
vaultSbtc('L-1 small: vault empty after the sale','(ok u0)');
const dFin=finalize('L-1 small',D.c,v=>/^\(ok u[1-9]\d*\)$/.test(v));
post.push({kind:'small',d8,d9,dFin});

// ---- L-1: partial sale, rest kept, next call sells more ----
const C=claim('L-1 batch',3,BIG);
vaultSbtc('L-1: vault holds the 0.3 BTC claim',`(ok u${BIG})`);
call('L-1: chunk cap at 0.1 BTC',POOL,'set-vault-max-chunk-sats',[u(CHUNK)],'(ok true)');
age('L-1',288);
advance();
const l1=[],l1bal=[],l1clk=[],l1bps=[];
function sale(label,bps){l1.push(call(label,VAULT,'router-swap',[update],any,STRANGER));l1bps.push(bps);
 l1bal.push(vaultSbtc(`${label}: vault balance`,v=>/^\(ok u\d+\)$/.test(v)));
 l1clk.push(ev(`${label}: clock`,VAULT,'(get-clock)',any));}
sale('L-1 sale 1 at 1%',100);
call('L-1: second call in the same burn block hits the cooldown',VAULT,'router-swap',[update],'(err u16044)',STRANGER);
for(const n of [2,3,4]){advance();sale(`L-1 sale ${n} at 1%`,100);}
call('L-1: admin widens slippage to 3%',POOL,'set-vault-slippage-bps',[u(300)],'(ok true)');
advance();sale('L-1 sale 5 at 3%',300);
call('L-1: admin widens slippage to 10%',POOL,'set-vault-slippage-bps',[u(1000)],'(ok true)');
for(const n of [6,7,8]){advance();sale(`L-1 sale ${n} at 10%`,1000);}
ev('L-1: batch closed once empty',VAULT,'(get-clock)',v=>v.includes('(ready-to-finish true)'));
const cFin=finalize('L-1',C.c,v=>/^\(ok u[1-9]\d*\)$/.test(v));
call('L-1: restore 1% slippage',POOL,'set-vault-slippage-bps',[u(100)],'(ok true)');
call('L-1: restore the 1M chunk',POOL,'set-vault-max-chunk-sats',[u(1000000)],'(ok true)');
post.push({kind:'l1',slots:l1,bal:l1bal,clk:l1clk,bps:l1bps,fin:cFin,total:BIG});
const dustAfterL1=vaultSbtc('L-1: dust left after the batch',v=>/^\(ok u[0-2]\)$/.test(v));

// ---- Void Kael #7: a 1-sat jing-place after the sell-out ----
// The market refunds any maker rest under the minimum on a fill, and a plain
// 1-sat place with no position is under the minimum (u1001). The dust reaches
// the market as a top-up that goes to pending (the Y book is not empty), and
// then the live order sells out.
const E=claim('#7 batch',4,MAKER);
const e7funded=vaultSbtc('#7: vault holds the claim (+ any L-1 dust)',v=>/^\(ok u\d+\)$/.test(v));
call('#7: a real STX bid rests far under the ask (Y book not empty)',MARKET,'deposit-token-y',[u(2000000),u(mid*90n/100n),Cl.none(),wstxCv,Cl.stringAscii('wstx')],'(ok u2000000)',DEP);
const e7p1=call('#7: vault places its ask (pending: the Y book is not empty)',VAULT,'jing-place',[update],v=>ok(v),STRANGER);
call('#7: anyone settles the vault ask live (no cross)',MARKET,'settle-token-x-deposit',[Cl.principal(VAULT),update,sbtcCv,Cl.stringAscii('sbtc-token')],ok,STRANGER);
const e7live=ev('#7: vault ask is live',VAULT,`(contract-call? '${MARKET} get-token-x-deposit (contract-call? '${MARKET} get-current-cycle) current-contract)`,v=>/^u[1-9]\d*$/.test(v));
donate('#7: griefer sends the vault 1 sat',1);
const e7place=call('#7: griefer jing-place tops up 1 sat (pending)',VAULT,'jing-place',[update],v=>ok(v)&&v.includes('(amount u1)'),STRANGER);
ev('#7: the 1 sat sits in pending escrow',VAULT,`(contract-call? '${MARKET} get-token-x-pending-deposit current-contract)`,v=>v.includes('(amount u1)'));
call('#7: real maker depth behind the vault (pending)',MARKET,'deposit-token-x',[u(MAKER),u(mid*101n/100n),Cl.none(),sbtcCv,Cl.stringAscii('sbtc-token')],`(ok u${MAKER})`,WHALE);
call('#7: settle the depth live (no cross)',MARKET,'settle-token-x-deposit',[Cl.principal(WHALE),update,sbtcCv,Cl.stringAscii('sbtc-token')],ok,STRANGER);
const take=BigInt(MAKER)*mid/10000000000n*150n/100n;
call('#7: real STX taker buys the whole live ask',MARKET,'swap',[u(take),u(mid*105n/100n),update,sbtcCv,Cl.stringAscii('sbtc-token'),wstxCv,Cl.stringAscii('wstx'),Cl.bool(false)],ok,TAKER);
const e7mkt=ev('#7: after the sell-out: live 0, parked 0, pending 1, wallet 0',VAULT,`(let ((c (contract-call? '${MARKET} get-current-cycle))) {live: (contract-call? '${MARKET} get-token-x-deposit c current-contract), parked: (contract-call? '${MARKET} get-token-x-parked current-contract), pending: (default-to u0 (get amount (contract-call? '${MARKET} get-token-x-pending-deposit current-contract))), wallet: (unwrap-panic (contract-call? '${SBTC} get-balance current-contract))})`,'(tuple (live u0) (parked u0) (pending u1) (wallet u0))');
ev('#7: the 1 sat on the market keeps is-empty false',VAULT,'(is-empty)','false');
ev('#7: window still open',VAULT,'(get-clock)',v=>v.includes('(window-open true)'));
const e7stx=vaultStx('#7: STX proceeds in the vault',v=>/^u[1-9]\d*$/.test(v));
const e7close=call('#7: close-batch cancels the 1 sat home and closes at once',VAULT,'close-batch',[],v=>ok(v)&&v.includes('close-batch'),STRANGER);
ev('#7: market position is 0',VAULT,`(contract-call? '${MARKET} get-token-x-pending-deposit current-contract)`,'none');
vaultSbtc('#7: the 1 sat is wallet dust again','(ok u1)');
ev('#7: ready to finish',VAULT,'(get-clock)',v=>v.includes('(batch-start none)')&&v.includes('(ready-to-finish true)'));
const eFin=finalize('#7',E.c,v=>/^\(ok u[1-9]\d*\)$/.test(v));
vaultStx('#7: finish moved all the STX','u0');
post.push({kind:'seven',e7close,e7stx,eFin,e7funded,dustAfterL1});

// ---- Void Kael #8: router-swap with a partly filled book leg ----
call('#8: whale cancels its leftover ask so the next bid rests live',MARKET,'cancel-token-x-deposit',[sbtcCv,Cl.stringAscii('sbtc-token')],ok,WHALE);
const F=claim('#8 batch',5,BAND_FUND);
age('#8',288);
advance();
const f8bid=BigInt(BAND_CAP)*mid/10000000000n;
call('#8: real STX bid sized near the measured band',MARKET,'deposit-token-y',[u(f8bid),u(mid*105n/100n),Cl.none(),wstxCv,Cl.stringAscii('wstx')],v=>ok(v),TAKER);
const f8settle=call('#8: settle the bid live if it went pending',MARKET,'settle-token-y-deposit',[Cl.principal(TAKER),update,wstxCv,Cl.stringAscii('wstx')],any,STRANGER);
ev('#8: the bid is live',MARKET,`(get-token-y-deposit (var-get current-cycle) '${TAKER})`,`u${f8bid}`);
const f8cap=ev('#8: book taker capacity at the vault floor',MARKET,`(get-taker-capacity u${mid} u${mid*99n/100n} true '${VAULT})`,any);
const f8=call('#8: router-swap with a book leg and the rest to the AMMs',VAULT,'router-swap',[update],v=>ok(v),STRANGER);
const f8bal=vaultSbtc('#8: vault balance after the sale',v=>/^\(ok u\d+\)$/.test(v));
post.push({kind:'eight',f8,f8cap,f8bal,dust:null});

console.log(`juice fixes: ${plan.length} planned steps at fork block ${forkBlock}`);
let id;
for(let attempt=1;;attempt++){try{id=await builder.run();break;}catch(e){if(attempt>=3)throw e;console.log('retry run:',e.message);await new Promise(r=>setTimeout(r,5000));}}
console.log(`View: https://stxer.xyz/simulations/mainnet/${id}`);
const result=await getSimulationResult(id,{stxerApi:API});
const checks=plan.map((p,i)=>{
 const step=result.steps[i]?.Result;let actual;
 if(p.kind==='advance')actual=step?.AdvanceBlocks?.Ok?'ok':`ENGINE ${JSON.stringify(step)}`;
 else if(p.kind==='eval')actual=step?.Eval?.Ok!==undefined?cvToString(deserializeCV(step.Eval.Ok)):`ENGINE ${JSON.stringify(step)}`;
 else actual=step?.Transaction?.Ok&&!step.Transaction.Ok.vm_error?cvToString(deserializeCV(step.Transaction.Ok.result)):`ENGINE ${JSON.stringify(step)}`;
 const passed=p.kind==='advance'?actual==='ok':p.kind==='deploy'?actual.startsWith('(ok'):typeof p.want==='function'?p.want(actual):actual===p.want;
 console.log(`${passed?'PASS':'FAIL'} [${i}] ${p.label}: ${actual.slice(0,400)}`);return {label:p.label,passed,actual};
});
function events(slot){
 const raw=result.steps[slot]?.Result?.Transaction?.Ok?.events??[];
 const out={ft:[],stx:[],vaultPrints:[],poolPrints:[],router:null,all:[]};
 for(const r of raw){const e=typeof r==='string'?JSON.parse(r):r;if(!e.committed)continue;out.all.push(e);
  if(e.ft_transfer_event&&(e.ft_transfer_event.sender===VAULT||e.ft_transfer_event.recipient===VAULT))out.ft.push(e.ft_transfer_event);
  if(e.stx_transfer_event&&(e.stx_transfer_event.sender===VAULT||e.stx_transfer_event.recipient===VAULT))out.stx.push(e.stx_transfer_event);
  const ce=e.contract_event;if(!ce)continue;
  if(ce.contract_identifier===VAULT)out.vaultPrints.push(cvToString(deserializeCV(ce.raw_value)));
  if(ce.contract_identifier===POOL)out.poolPrints.push(cvToString(deserializeCV(ce.raw_value)));
  if(ce.contract_identifier===ROUTER){const t=deserializeCV(ce.raw_value).value;if(t?.topic?.value==='smart-swap-sbtc-for-stx')out.router=t;}
 }
 return out;
}
const U=s=>BigInt(String(s).match(/u(\d+)/)?.[1]??'-1');
const field=(s,k)=>BigInt(s.match(new RegExp(`\\(${k} u(\\d+)\\)`))?.[1]??'-1');
const flows=e=>({sbtcOut:e.ft.filter(t=>t.sender===VAULT).reduce((a,t)=>a+BigInt(t.amount),0n),sbtcIn:e.ft.filter(t=>t.recipient===VAULT).reduce((a,t)=>a+BigInt(t.amount),0n),stxIn:e.stx.filter(t=>t.recipient===VAULT).reduce((a,t)=>a+BigInt(t.amount),0n)});
const push=(label,passed,actual)=>{checks.push({label,passed,actual});console.log(`${passed?'PASS':'FAIL'} ${label}: ${actual}`);};
const floorOut=(amount,limit)=>amount*limit/10000000000n;
for(const p of post){
 if(p.kind==='events'){const e=events(p.slot);push(p.label,p.check(e),`stx ${e.stx.length}, ft ${e.ft.length}, vault ${e.vaultPrints.join(' | ').slice(0,200)}`);}
 if(p.kind==='l1'){
  let held=BigInt(p.total),partialAt=-1;
  p.slots.forEach((slot,k)=>{
   const r=checks[slot].actual,bal=U(checks[p.bal[k]].actual),clk=checks[p.clk[k]].actual,n=`L-1 sale ${k+1} (${p.bps[k]} bps)`;
   if(!r.startsWith('(ok')){
    const closed=held<=2n&&r==='(err u16031)';
    push(`${n}: ${r}, balance unchanged, no transfer`,bal===held&&(r==='(err u16047)'||closed)&&events(slot).ft.length===0,`${r}, balance ${bal}, held ${held}`);
    if(r==='(err u16047)')push(`${n}: batch stays open after the refusal`,clk.includes('(batch-start (some'),clk.slice(0,120));
    return;}
   const e=events(slot),f=flows(e),amount=field(r,'amount'),unsold=field(r,'unsold'),out=field(r,'out'),limit=field(r,'limit-price'),sold=amount-unsold;
   push(`${n}: sells min(balance, chunk)`,amount===(held<BigInt(CHUNK)?held:BigInt(CHUNK)),`amount ${amount}, held ${held}`);
   push(`${n}: vault net sBTC outflow equals sold`,f.sbtcOut-f.sbtcIn===sold,`out ${f.sbtcOut} - back ${f.sbtcIn} = ${f.sbtcOut-f.sbtcIn}, sold ${sold}`);
   push(`${n}: STX in equals the reported out`,f.stxIn===out,`stx in ${f.stxIn}, out ${out}`);
   push(`${n}: sold > 8 and out >= floor-out(sold - 8)`,sold>8n&&out>=floorOut(sold-8n,limit),`sold ${sold}, out ${out}, floor ${floorOut(sold-8n,limit)}`);
   push(`${n}: vault balance = held - sold (rest kept)`,bal===held-sold,`balance ${bal}, held ${held}, sold ${sold}`);
   push(`${n}: batch open while more than dust remains`,(bal>2n)===clk.includes('(batch-start (some'),`balance ${bal}; ${clk.slice(0,60)}`);
   push(`${n}: router print agrees`,!!e.router&&e.router.unsold.value===unsold&&e.router.amount.value===amount&&e.router.out.value===out,e.router?`unsold ${e.router.unsold.value}, jing ${e.router['jing-in'].value}, dlmm ${e.router['dlmm-in'].value}/${e.router['dlmm-cap'].value}, xyk ${e.router['xyk-in'].value}/${e.router['xyk-cap'].value}, velar ${e.router['velar-in'].value}/${e.router['velar-cap'].value}`:'missing');
   if(partialAt<0&&unsold>0n)partialAt=k;
   held=held-sold;
  });
  push('L-1: a 1% sale was partial (0 < unsold < chunk)',partialAt>=0&&p.bps[partialAt]===100,`first partial at sale ${partialAt+1}`);
  const later=p.slots.slice(partialAt+1).findIndex(s=>checks[s].actual.startsWith('(ok'));
  push('L-1: a later call sold more of the kept rest',partialAt>=0&&later>=0,later>=0?`sale ${partialAt+2+later} sold more`:'none');
  push('L-1: vault ends empty (<= DUST_SATS)',held<=2n,`held ${held}`);
  const stx=p.slots.map(s=>checks[s].actual.startsWith('(ok')?field(checks[s].actual,'out'):0n).reduce((a,b)=>a+b,0n);
  push('L-1: finalize attributes exactly the STX of all sales',U(checks[p.fin].actual)===stx,`finalize ${checks[p.fin].actual}, sum out ${stx}`);
 }
 if(p.kind==='small'){
  const e=events(p.d8);push('L-1 small: reverted 8-sat call committed no transfer',e.ft.length===0&&e.stx.length===0,`ft ${e.ft.length}, stx ${e.stx.length}`);
  const r=checks[p.d9].actual;if(r.startsWith('(ok')){const e9=events(p.d9),f=flows(e9);
   push('L-1 small: 9-sat sale moves exactly 9 sats out',f.sbtcOut-f.sbtcIn===9n,`net out ${f.sbtcOut-f.sbtcIn}`);
   push('L-1 small: finalize = the STX out = STX received',U(checks[p.dFin].actual)===field(r,'out')&&f.stxIn===field(r,'out'),`${checks[p.dFin].actual}, out ${field(r,'out')}, stx in ${f.stxIn}`);}
 }
 if(p.kind==='seven'){
  push('#7: funded = claim + L-1 dust',U(checks[p.e7funded].actual)===BigInt(MAKER)+U(checks[p.dustAfterL1].actual),`${checks[p.e7funded].actual}, dust ${checks[p.dustAfterL1].actual}`);
  const e=events(p.e7close),f=flows(e);
  push('#7 close-batch: jing-reclaim print (amount 1), 1 sat market -> vault, then close-batch print',e.vaultPrints.some(s=>s.includes('jing-reclaim')&&s.includes('(amount u1)'))&&e.vaultPrints.some(s=>s.includes('close-batch'))&&f.sbtcIn===1n&&f.sbtcOut===0n&&e.ft.every(t=>t.sender===MARKET),`prints ${e.vaultPrints.join(' | ').slice(0,300)}, sbtc in ${f.sbtcIn}`);
  const ef=events(p.eFin);
  push('#7 finalize: the whole sell-out STX moves vault -> pool',U(checks[p.eFin].actual)===U(checks[p.e7stx].actual)&&ef.stx.length===1&&ef.stx[0].recipient===POOL&&BigInt(ef.stx[0].amount)===U(checks[p.e7stx].actual),`${checks[p.eFin].actual} vs ${checks[p.e7stx].actual}`);
 }
 if(p.kind==='eight'){
  const r=checks[p.f8].actual;console.log('#8 capacity',checks[p.f8cap].actual);
  // market gross-up of the book's net capacity: 0 if net-cap is 0, else floor(((net-cap+1)*10020-1)/10000)
  {const cap=checks[p.f8cap].actual,net=field(cap,'net-cap'),gross=field(cap,'gross-cap'),want=net===0n?0n:((net+1n)*10020n-1n)/10000n;
   push('#8: gross-cap = gross-up(net-cap) at 20 bps',gross===want,`net-cap ${net}, gross-cap ${gross}, model ${want}`);}
  if(r.startsWith('(ok')){const e=events(p.f8),f=flows(e),amount=field(r,'amount'),unsold=field(r,'unsold');
   const oldAllow=amount+1000n,newAllow=amount+1000n+51n; // amount + min-x + JING_REBATE_DUST_SATS
   const fromMkt=e.ft.filter(t=>t.recipient===VAULT&&t.sender===MARKET).reduce((a,t)=>a+BigInt(t.amount),0n);
   push('#8: gross sBTC outflow within the new allowance',f.sbtcOut<=newAllow,`gross out ${f.sbtcOut}, market refund ${fromMkt}, old allowance ${oldAllow}, new ${newAllow}, jing ${e.router?.['jing-in']?.value}/${e.router?.['jing-cap']?.value} ok ${e.router?.['jing-ok']?.type}, amms ${e.router?.['dlmm-in']?.value}/${e.router?.['xyk-in']?.value}/${e.router?.['velar-in']?.value}`);
   push('#8: net sBTC outflow equals sold',f.sbtcOut-f.sbtcIn===amount-unsold,`net ${f.sbtcOut-f.sbtcIn}, sold ${amount-unsold}`);
   console.log(`#8 band reached: ${f.sbtcOut>oldAllow} (gross ${f.sbtcOut} vs old allowance ${oldAllow})`);
  } else push('#8: router-swap succeeded',false,r);
 }
}
const passed=checks.filter(c=>c.passed).length;
const dir=resolve(directory,'results/pool-vault-stx');mkdirSync(dir,{recursive:true});
writeFileSync(resolve(dir,'juice-fixes.json'),JSON.stringify({id,url:`https://stxer.xyz/simulations/mainnet/${id}`,mode:'fix-scenarios L-1 L-2 #6 #7',block:forkBlock,observedTip:tip,proofTimestamp:proof.ts,mid:String(mid),sourceHashes,
 fixtures:['PoX earned rewards and 1:3 shares seeded with Eval, backed by real fork sBTC','Vault funding clock aged by Eval to open liquidation without expiring the signed update','Whale donations are real sBTC transfers'],passed,total:checks.length,checks,result},null,2)+'\n');
console.log(`juice fixes: ${passed}/${checks.length} checks passed`);
if(passed!==checks.length)process.exit(1);
