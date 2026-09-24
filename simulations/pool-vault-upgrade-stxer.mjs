import {appendJingStack} from './_jing-v6-3.mjs';
// Exact production sources; candidate copies and state seeds exist on this fork only.
import {SimulationBuilder,getSimulationResult} from 'stxer';
import {Cl,ClarityVersion,deserializeCV,cvToString} from '@stacks/transactions';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {POOL_VAULT_FUNCTIONS} from './_pool-vault-interface.mjs';
const DEP='SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22',OTHER='SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const P=DEP+'.juice-pool-stx-signer-stx-rewards',V=DEP+'.juice-pool-swap-vault',N=DEP+'.sim-upgrade-next',W=DEP+'.sim-upgrade-wrong';
const SBTC='SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token',WHALE='SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1';
const NODE=process.env.STACKS_API_URL||'http://77.42.3.101/stacks-api',API=process.env.STXER_API_URL||'https://api.stxer.xyz';
const POX='SP000000000000000000002Q6VF78.pox-5';
const read=await (await fetch(NODE+'/v2/contracts/call-read/SP000000000000000000002Q6VF78/pox-5/current-pox-reward-cycle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sender:DEP,arguments:[]})})).json();
const cycle=Number(deserializeCV(read.result).value)-1;
const tip=await (await fetch(NODE+'/extended/v1/block?limit=1')).json();
const b=SimulationBuilder.new({stacksNodeAPI:NODE,apiEndpoint:API}).useBlockHeight(tip.results[0].height).withSender(DEP),plan=[],sourceHashes={};
appendJingStack(b,plan,sourceHashes);
const ok=s=>s.startsWith('(ok');
const deploy=(name,source,production=true)=>{b.addContractDeploy({contract_name:name,source_code:source,clarity_version:ClarityVersion.Clarity6});plan.push({label:'deploy '+name,kind:'tx',want:ok});if(production)sourceHashes[name]=createHash('sha256').update(source).digest('hex');};
const ev=(label,id,code,want)=>{b.addEvalCode(id,code);plan.push({label,kind:'eval',want});};
const call=(label,fn,args=[],want=ok,sender=DEP,id=P)=>{b.addContractCall({contract_id:id,function_name:fn,function_args:args,sender});plan.push({label,kind:'tx',want});};
const cp=id=>Cl.principal(id),u=Cl.uint;
const advance=n=>{b.addAdvanceBlocks({bitcoin_blocks:n,stacks_blocks_per_bitcoin:1,bitcoin_interval_secs:1});plan.push({label:'advance '+n+' burn blocks (synthetic timestamps)',kind:'advance'});};
let vaultSource;
for(const name of ['juice-pool-swap-vault','juice-pool-stx-signer-stx-rewards']){const source=readFileSync(new URL('../contracts/pox-5/'+name+'.clar',import.meta.url),'utf8');deploy(name,source);if(name==='juice-pool-swap-vault')vaultSource=source;}
deploy('sim-upgrade-next',vaultSource,false);deploy('sim-upgrade-wrong',vaultSource.replace('(define-constant POOL .juice-pool-stx-signer-stx-rewards)',`(define-constant POOL '${OTHER})`),false);
ev('initial active vault',P,'(get-swap-vault)',V);
call('no proposal', 'confirm-swap-vault',[cp(V),cp(N)],'(err u118)');
for(const [fn,args]of [['propose-swap-vault',[cp(N)]],['cancel-swap-vault-proposal',[]],['confirm-swap-vault',[cp(V),cp(N)]]])call('outsider '+fn,fn,args,'(err u100)',OTHER);
call('same vault rejected','propose-swap-vault',[cp(V)],'(err u119)');
call('wrong pool rejected','propose-swap-vault',[cp(W)],'(err u119)');
ev('fixture candidate active clock',N,'(var-set batch-start (some burn-block-height))','true');
call('candidate batch rejected','propose-swap-vault',[cp(N)],'(err u120)');
ev('fixture clear candidate clock',N,'(var-set batch-start none)','true');
for(const id of [V,N]){call('donate one satoshi '+id,'transfer',[u(1),cp(WHALE),cp(id),Cl.none()], '(ok true)',WHALE,SBTC);ev('donate one microSTX '+id,P,`(stx-transfer? u1 tx-sender '${id})`,'(ok true)');}
const MKT=DEP+'.markets-sbtc-stx-jing-v6-3';
const position=(id,kind,n)=>kind==='resting'?`(map-set token-x-deposits {cycle: (var-get current-cycle), depositor: '${id}} u${n})`:`(map-set token-x-parked '${id} u${n})`;
for(const kind of ['resting','parked']){
 ev('fixture candidate '+kind,MKT,position(N,kind,1),'true');
 call('candidate '+kind+' blocks proposal','propose-swap-vault',[cp(N)],'(err u120)');
 ev('fixture clear candidate '+kind,MKT,position(N,kind,0),'true');
}
call('donations allow proposal','propose-swap-vault',[cp(N)]);
ev('full notice is 4032',P,'(is-eq (get executable-at (get-pending-swap-vault)) (+ burn-block-height u4032))','true');
advance(10);call('replacement restarts notice','propose-swap-vault',[cp(N)]);
ev('reset notice is 4032',P,'(is-eq (get executable-at (get-pending-swap-vault)) (+ burn-block-height u4032))','true');
call('cancel proposal','cancel-swap-vault-proposal');call('cancelled cannot confirm','confirm-swap-vault',[cp(V),cp(N)],'(err u118)');
call('propose again','propose-swap-vault',[cp(N)]);advance(4031);
call('4031 too early','confirm-swap-vault',[cp(V),cp(N)],'(err u114)');advance(1);
ev('fixture pending tranche',P,'(var-set pending-swap (some {reward-cycle: u1, tranche: u0}))','true');
call('pending tranche blocks switch','confirm-swap-vault',[cp(V),cp(N)],'(err u115)');
ev('fixture clear pending tranche',P,'(var-set pending-swap none)','true');
ev('fixture old active clock',V,'(var-set batch-start (some burn-block-height))','true');
call('old batch blocks switch','confirm-swap-vault',[cp(V),cp(N)],'(err u120)');
ev('fixture clear old clock',V,'(var-set batch-start none)','true');
ev('fixture candidate dirtied after proposal',N,'(var-set batch-start (some burn-block-height))','true');
call('candidate revalidated','confirm-swap-vault',[cp(V),cp(N)],'(err u120)');
ev('fixture candidate clear again',N,'(var-set batch-start none)','true');
call('wrong old rejected','confirm-swap-vault',[cp(N),cp(N)],'(err u119)');
call('wrong target rejected','confirm-swap-vault',[cp(V),cp(W)],'(err u119)');
for(const id of [V,N])for(const kind of ['resting','parked']){
 ev('fixture '+id+' '+kind,MKT,position(id,kind,1),'true');
 call(id+' '+kind+' blocks confirmation','confirm-swap-vault',[cp(V),cp(N)],'(err u120)');
 ev('fixture clear '+id+' '+kind,MKT,position(id,kind,0),'true');
}
call('4032 switch succeeds despite donations','confirm-swap-vault',[cp(V),cp(N)]);
ev('new active vault',P,'(get-swap-vault)',N);
ev('proposal cleared',P,'(is-none (get vault (get-pending-swap-vault)))','true');
const staleArgs={ 'pox-claim-rewards':[Cl.list([]),u(1)],'finalize-swap':[],'emergency-recover':[],'refloor-vault':[Cl.buffer(new Uint8Array())],'jing-take':[u(1),Cl.buffer(new Uint8Array())],'router-swap-split':[u(1),u(0),u(1),u(0),u(0),Cl.buffer(new Uint8Array())],'router-swap-split-dia':[u(1),u(1),u(0),u(0)]};
for(const fn of POOL_VAULT_FUNCTIONS)call('stale target '+fn,fn,[...(staleArgs[fn]||[u(1)]),cp(V)],'(err u119)');
call('new vault accepts admin setting','set-vault-window-blocks',[u(0),cp(N)]);
// Explicit earned-reward fixture; real PoX, token, pool, candidate, and router calls.
call('fund real PoX reward balance','transfer',[u(10000),cp(WHALE),cp(POX),Cl.none()],'(ok true)',WHALE,SBTC);
const key=`{reward-cycle: u${cycle}, bond-index: none, signer: '${P}}`;
ev('fixture earned PoX reward and one staker',POX,`(begin
(map-set signer-shares-staked-for-cycle ${key} u1)
(map-set signer-pending-staked-ustx-per-cycle {signer: '${P}, cycle: u${cycle}} u1)
(map-set signer-rewards-per-token-settled-for-cycle ${key} (get-rewards-per-token-for-cycle u${cycle} none))
(map-set signer-unclaimed-rewards-for-cycle ${key} u10000)
(map-set staker-shares-staked-for-cycle {reward-cycle: u${cycle}, bond-index: none, signer: '${P}, staker: '${OTHER}} u1)
(var-set last-accounted-rewards-only (+ (var-get last-accounted-rewards-only) u10000))
(try! (contract-call? '${P} validate-stake! '${OTHER} u${cycle} u1 u1 u0 false none))
(ok true))`,'(ok true)');
call('future public reward claim routes to new vault','pox-claim-rewards',[Cl.list([]),u(cycle),cp(N)],s=>ok(s)&&s.includes('(total-rewards u10000)'),OTHER);
ev('new vault receives reward plus donation',N,'(sbtc-balance)','u10001');
ev('old vault retains only donation',V,'(sbtc-balance)','u1');
call('real emergency split from new vault','router-swap-split-dia',[u(10001),u(10001),u(0),u(0),cp(N)]);
call('permissionless new vault finalization','finalize-swap',[cp(N)],s=>/^\(ok u[1-9]/.test(s),OTHER);
ev('new tranche has positive STX pot',P,`(> (get-stx-pot u${cycle} u0) u0)`,'true');
call('pay new tranche to original staker','pay-stx-stakers',[Cl.list([cp(OTHER)]),u(cycle),u(0)],ok,OTHER);
call('next upgrade fresh notice','propose-swap-vault',[cp(V)]);call('next upgrade cannot skip delay','confirm-swap-vault',[cp(N),cp(V)],'(err u114)');call('cancel second upgrade','cancel-swap-vault-proposal');
console.log('Submitting',plan.length,'upgrade checks');const id=await b.run();console.log('https://stxer.xyz/simulations/mainnet/'+id);
const result=await getSimulationResult(id,{stxerApi:API});
const checks=plan.map((p,i)=>{const r=result.steps[i]?.Result;let actual=p.kind==='advance'?(r?.AdvanceBlocks?.Ok?'ok':JSON.stringify(r)):p.kind==='eval'?(r?.Eval?.Ok!==undefined?cvToString(deserializeCV(r.Eval.Ok)):JSON.stringify(r)):(r?.Transaction?.Ok&&!r.Transaction.Ok.vm_error?cvToString(deserializeCV(r.Transaction.Ok.result)):JSON.stringify(r));const passed=p.kind==='advance'?actual==='ok':typeof p.want==='function'?p.want(actual):p.want===actual;console.log(passed?'PASS':'FAIL',p.label,actual?.slice(0,180));return {label:p.label,passed,actual};});
const dir=new URL('./results/pool-vault-stx/',import.meta.url);mkdirSync(dir,{recursive:true});writeFileSync(new URL('juice-vault-upgrade.json',dir),JSON.stringify({id,url:'https://stxer.xyz/simulations/mainnet/'+id,forkBlock:9021103,sourceHashes,fixtures:['Candidate copies deployed only in fork; wrong-pool copy changes only POOL binding','Tiny real STX/sBTC donations; private batch, resting/parked market maps and pending-tranche state injected explicitly','PoX earned-reward and share fixture; public claim, real AMM swap, finalize and payout on new vault','4032 real burn-height advance with compressed timestamps; not oracle-freshness evidence'],checks,result},null,2)+'\n');
if(checks.some(c=>!c.passed))throw Error(checks.filter(c=>!c.passed).length+' upgrade checks failed');
console.log(`${checks.filter(c=>c.passed).length}/${checks.length} checks green`);
