// Isolated runtime tests for both current production drafts.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
const testDir=dirname(fileURLToPath(import.meta.url));
const projectRoot=resolve(testDir,'../..');
const require=createRequire(resolve(projectRoot,'package.json'));
const { initSimnet, tx }=require('@stacks/clarinet-sdk');
const { Cl, cvToString }=require('@stacks/transactions');
const manifest=resolve(testDir,'.build/Clarinet.toml');
const sim=await initSimnet(manifest,true,{trackCoverage:true});
const accounts=sim.getAccounts(), admin=accounts.get('deployer'), alice=accounts.get('wallet_1'), bob=accounts.get('wallet_2');
const cp=n=>Cl.contractPrincipal(admin,n),u=Cl.uint, update=Cl.buffer(new Uint8Array());
function call(n,f,a=[],sender=alice){
 const result=sim.callPublicFn(n,f,a,sender);
 if(result.result.type==='ok'){
  for(const event of eventChecks[`${n}.${f}`]||[]){
   assert.ok(result.events.some(e=>e.data?.value&&cvToString(e.data.value).includes(`"${event}"`)),`Missing ${event} event`);
  }
 }
 return result;
}
function ok(r){assert.equal(r.result.type,'ok',cvToString(r.result));return r.result.value}
function err(r,code){assert.equal(cvToString(r.result),`(err u${code})`)}
function read(n,f,a=[]){return sim.callReadOnlyFn(n,f,a,admin).result}
function stx(w){return sim.getAssetsMap().get('STX').get(w)||0n}
const J='juice-pool-stx-signer-stx-rewards',JV='juice-pool-swap-vault',F='fastpool-stx-vault-signer',FV='fastpool-swap-vault';
const eventChecks={
 [`${J}.propose-admin`]:['propose-admin'],
 [`${J}.accept-admin`]:['accept-admin'],
 [`${J}.cancel-admin-proposal`]:['cancel-admin-proposal'],
 [`${J}.pox-claim-rewards`]:['fund','claim-rewards'],
 [`${J}.finalize-swap`]:['finish','finalize-swap'],
 [`${J}.emergency-recover`]:['emergency-recover'],
 [`${J}.pay-recovered-sbtc-stakers`]:['pay-recovered-sbtc-stakers'],
 [`${J}.sweep-recovered-sbtc-dust`]:['sweep-recovered-sbtc-dust'],
 [`${J}.withdraw-sbtc-fees`]:['withdraw-sbtc-fees'],
 [`${J}.refloor-vault`]:['jing-refloor'],
};
for(const setting of ['window-blocks','leeway-bps','slippage-bps','max-chunk-sats','dia-band-bps','router-cooldown']){
 eventChecks[`${J}.set-vault-${setting}`]=[`set-${setting}`];
}

ok(sim.transferSTX(Cl.uint(50000000000).value,`${admin}.mock-router`,admin));
// New Juice admin controls: every setting checks caller and its upper bound.
for(const [name,value,max,positive] of [
 ['window-blocks',288,1008,false],['leeway-bps',500,1000,false],
 ['slippage-bps',100,1000,false],['max-chunk-sats',5000000,100000000,true],
 ['dia-band-bps',1000,5000,false],['router-cooldown',1,144,false]]){
 err(call(JV,`set-${name}`,[u(value)],admin),16000);
 err(call(J,`set-vault-${name}`,[u(value)]),100);
 err(call(J,`set-vault-${name}`,[u(max+1)],admin),16033);
 if(positive)err(call(J,`set-vault-${name}`,[u(0)],admin),16033);
 ok(call(J,`set-vault-${name}`,[u(max)],admin));
 ok(call(J,`set-vault-${name}`,[u(value)],admin));
}
const split=[u(500000),u(100000),u(100000),u(100000),u(200000),update];
err(call(JV,'router-swap-split',split,admin),16000);
err(call(J,'router-swap-split',split),100);

for(const [pool,vault,cycle] of [[J,JV,140],[F,FV,141]]){
 for(const [who,amount] of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(pool),Cl.principal(who),u(cycle),u(amount)]));
 err(call(vault,'fund',[u(1)]),16000);
 if(pool===J){ok(call(pool,'pox-claim-rewards',[Cl.list([]),u(cycle)]));err(call(pool,'pay-stx-stakers',[Cl.list([Cl.principal(alice)]),u(cycle),u(0)]),115);}
 else{ok(call(pool,'claim-rewards',[u(cycle)]));ok(call(pool,'fund-swap-vault',[u(cycle)]));err(call(pool,'fund-swap-vault',[u(cycle)]),1050);}
 if(pool===J){
  const clock=cvToString(read(JV,'get-clock'));
  err(call(J,'set-vault-window-blocks',[u(1)],admin),16045);
  assert.equal(cvToString(read(JV,'get-clock')),clock);
  err(call(J,'router-swap-split',split,admin),16031);
  err(call(J,'jing-take',[u(100000),update],admin),16031);
 }
 err(call(vault,'finish'),16000);
 err(call(vault,'router-swap',[u(500000),update]),16031);
 ok(call(vault,'jing-place',[update]));
 err(call(vault,'jing-reclaim'),16031);
 err(call(pool,pool===J?'finalize-swap':'finalize-swap-vault'),16043);
 sim.mineEmptyBurnBlocks(288);
 ok(call(vault,'jing-reclaim'));
 // DIA divergence and staleness fail closed.
 ok(call('mock-dia','set-skew',[u(13000)]));
 err(call(vault,'router-swap',[u(500000),update]),16037);
 ok(call('mock-dia','set-skew',[u(10000)]));
 ok(call('mock-dia','set-stale',[Cl.bool(true)]));
 err(call(vault,'router-swap',[u(500000),update]),16036);
 ok(call('mock-dia','set-stale',[Cl.bool(false)]));
 err(call(vault,'router-swap',[u(5000001),update]),16039);
 // Two sales in the same burn block: exactly one succeeds.
 if(pool===J){
  err(call(J,'router-swap-split',[u(500001),...split.slice(1)],admin),16040);
  err(call(J,'router-swap-split',[u(5000001),u(5000001),u(0),u(0),u(0),update],admin),16039);
 }
 const first=pool===J?tx.callPublicFn(J,'router-swap-split',split,admin):tx.callPublicFn(vault,'router-swap',[u(500000),update],alice);
 const batch=sim.mineBlock([first,tx.callPublicFn(vault,'router-swap',[u(500000),update],bob)]);
 ok(batch[0]);err(batch[1],16044);
 err(call(pool,pool===J?'finalize-swap':'finalize-swap-vault'),16043);
 sim.mineEmptyBurnBlock();ok(call(vault,'router-swap',[u(500000),update]));
 const final=ok(call(pool,pool===J?'finalize-swap':'finalize-swap-vault'));
 assert.equal(final.value,3200000000n);
 const a=stx(alice),b=stx(bob);
 if(pool===J){ok(call(pool,'pay-stx-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(cycle),u(0)]));}
 else{ok(call(pool,'distribute-rewards-many',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(cycle)]));}
 assert.equal(stx(alice)-a,800000000n);assert.equal(stx(bob)-b,2400000000n);
 const paid=stx(alice);
 if(pool===J)ok(call(pool,'pay-stx-stakers',[Cl.list([Cl.principal(alice)]),u(cycle),u(0)]));
 else err(call(pool,'distribute-rewards',[Cl.principal(alice),u(cycle)]),1001);
 assert.equal(stx(alice),paid);
 assert.equal(cvToString(read(vault,'get-clock')).includes('(batch-start none)'),true);
 console.log(`${pool}: resting -> reclaim -> two router chunks -> STX 1:3 payouts; guards and replay passed`);
}
// Maker fill during patience, plus Juice OG exemption and native STX fees.
for(const [who,amount] of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(J),Cl.principal(who),u(142),u(amount)]));
ok(call(J,'propose-fee-bips',[u(500)],admin));sim.mineEmptyBurnBlocks(144);ok(call(J,'confirm-fee-bips',[],admin));ok(call(J,'set-og',[Cl.principal(alice),Cl.bool(true)],admin));
ok(call(J,'pox-claim-rewards',[Cl.list([]),u(142)]));ok(call(JV,'jing-place',[update]));
err(call(JV,'jing-refloor',[update]),16000);err(call(J,'refloor-vault',[update]),100);ok(call(J,'refloor-vault',[update],admin));
ok(call('v6-market','swap',[u(3206412825),u(32000000000000),update,cp('mock-ft'),Cl.stringAscii('mock-ft'),cp('mock-ft'),Cl.stringAscii('mock-ft'),Cl.bool(false)],bob));
const makerOut=ok(call(J,'finalize-swap')).value;assert.equal(makerOut,3203212825n);
const aliceMaker=makerOut/4n, bobMaker=makerOut*3n/4n, juiceFee=bobMaker/20n;
let a=stx(alice),b=stx(bob);
ok(call(J,'pay-stx-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(142),u(0)]));
assert.equal(stx(alice)-a,aliceMaker);assert.equal(stx(bob)-b,bobMaker-juiceFee);
assert.equal(read(J,'get-earned-fees').value,juiceFee);
err(call(J,'withdraw-fees',[u(juiceFee+1n),Cl.principal(admin)],admin),111);
ok(call(J,'withdraw-all-fees',[Cl.principal(admin)],admin));
console.log('Juice: maker fill during patience, +10bps proceeds, OG exemption and native STX fee withdrawal passed');
// FastPool fees snapshot survives rate change and late claims do not mix batches.
ok(call(F,'update-fees',[u(500)],admin));ok(call('mock-pox','set-cycle',[u(152)]));
for(const [who,amount] of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(F),Cl.principal(who),u(149),u(amount)]));
ok(call(F,'claim-rewards',[u(149)]));ok(call(F,'update-fees',[u(0)],admin));
for(let batch=0;batch<2;batch++){
 ok(call(F,'fund-swap-vault',[u(149)]));
 assert.equal(read(F,'get-earned-fees').value,BigInt((batch+1)*50000));
 if(batch===0)ok(call(F,'claim-rewards',[u(149)]));
 sim.mineEmptyBurnBlocks(288);ok(call(FV,'router-swap',[u(950000),update]));
 assert.equal(ok(call(F,'finalize-swap-vault')).value,3040000000n);
 a=stx(alice);b=stx(bob);
 ok(call(F,'distribute-rewards-many',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(149)]));
 assert.equal(stx(alice)-a,760000000n);assert.equal(stx(bob)-b,2280000000n);
}
assert.equal(read(F,'get-unswapped-sats').value,0n);assert.equal(read(F,'get-unpaid-stx').value,0n);
err(call(F,'withdraw-fees',[u(100001),Cl.principal(admin)],admin),1007);
ok(call(F,'withdraw-fees',[u(100000),Cl.principal(admin)],admin));
console.log('FastPool: snapshotted sBTC fees, late-claim batch isolation and incremental STX payouts passed');
// Maker rounding residue is sweepable only after all stakers were paid.
assert.equal(ok(call(J,'sweep-tranche-dust',[u(142),u(0)],admin)).value,1n);
// A third-party sBTC donation cannot strand the next funding before it starts.
ok(call('mock-ft','mint',[u(7),cp(JV)]));
ok(call('mock-pox','stake-test',[cp(J),Cl.principal(alice),u(143),u(1)]));
ok(call(J,'pox-claim-rewards',[Cl.list([]),u(143)]));
assert.equal(ok({result:read('mock-ft','get-balance',[cp(JV)])}).value,1000007n);
ok(call('mock-pox','next-dist'));
err(call(J,'pox-claim-rewards',[Cl.list([]),u(143)]),115);
assert.equal(ok({result:read('mock-ft','get-balance',[cp(JV)])}).value,1000007n);
console.log('Juice: rounding dust, donation-safe funding and overlapping-batch rollback passed');
console.log('Juice: bounded admin setters, stable active deadline, split allocation, phase, chunk and shared cooldown guards passed');

// Direct Jing liquidation uses the admin wrapper and keeps the batch pending.
err(call(JV,'jing-take',[u(1000007),update],admin),16000);
err(call(J,'jing-take',[u(1000007),update]),100);
sim.mineEmptyBurnBlocks(288);
err(call(J,'jing-take',[u(0),update],admin),16006);
err(call(J,'jing-take',[u(1000008),update],admin),16006);
ok(call('v6-market','deposit-token-y',[u(4000000000),u(32000000000000),Cl.some(u(0)),update,cp('mock-ft'),Cl.stringAscii('mock-ft')],bob));
const beforeTake=stx(`${admin}.${JV}`);
const taken=ok(call(J,'jing-take',[u(1000007),update],admin));
const received=taken.value.payload.value.out.value;
assert.ok(received>0n);
assert.equal(stx(`${admin}.${JV}`)-beforeTake,received);
assert.equal(cvToString(read(JV,'is-empty')),'true');
assert.equal(cvToString(read(JV,'get-clock')).includes('(window-elapsed true)'),true);
assert.equal(read(J,'get-pending-swap').type,'some');
assert.equal(ok(call(J,'finalize-swap')).value,received);
assert.equal(cvToString(read(JV,'get-clock')).includes('(batch-start none)'),true);
console.log('Juice: admin Jing take, native STX receipt, retained batch clock and finalization passed');

// Emergency recovery: fixed age, only admin, no oracle, paused Jing withdrawals.
const ft=w=>ok({result:read('mock-ft','get-balance',[Cl.principal(w)])}).value;
err(call(JV,'emergency-recover',[],admin),16000);
err(call(J,'emergency-recover'),100);
err(call(J,'emergency-recover',[],admin),115);
err(call(J,'pay-recovered-sbtc-stakers',[Cl.list([Cl.principal(alice)]),u(143),u(0)]),116);
// Remove the remaining bid from the previous Jing-take test.
ok(call('v6-market','cancel-token-y-deposit',[cp('mock-ft'),Cl.stringAscii('mock-ft')],bob));
for(const [cycle,kind] of [[160,'resting'],[161,'parked'],[162,'mixed'],[163,'stx-only']]){
 for(const [who,amount] of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(J),Cl.principal(who),u(cycle),u(amount)]));
 ok(call('mock-pox','next-dist'));
 ok(call(J,'pox-claim-rewards',[Cl.list([]),u(cycle)]));
 const start=Number(read(JV,'get-clock').value['batch-start'].value.value);
 err(call(J,'emergency-recover',[],admin),16046);
 err(call(J,'pay-recovered-sbtc-stakers',[Cl.list([Cl.principal(alice)]),u(cycle),u(0)]),116);
 if(kind==='resting'||kind==='parked'){
  ok(call(JV,'jing-place',[update]));
  if(kind==='parked'){
   ok(call('v6-market','rv-park-x-for-test',[cp(JV)],admin));
   assert.equal(read('v6-market','get-token-x-parked',[cp(JV)]).value,1000000n);
  }
 }
 if(kind==='mixed'||kind==='stx-only'){
  sim.mineEmptyBurnBlocks(288);
  ok(call(JV,'router-swap',[u(kind==='mixed'?500000:1000000),update]));
 }
 sim.mineEmptyBurnBlocks(start+4319-sim.burnBlockHeight);
 err(call(J,'emergency-recover',[],admin),16046);
 sim.mineEmptyBurnBlock();
 // Oracle disagreement cannot obstruct the emergency exit.
 ok(call('mock-dia','set-skew',[u(13000)]));
 ok(call('v6-market','set-paused',[Cl.bool(true)],admin));
 const expectedSbtc=kind==='mixed'?500000n:kind==='stx-only'?0n:1000000n;
 const expectedStx=kind==='mixed'?1600000000n:kind==='stx-only'?3200000000n:0n;
 if(kind==='resting'){
  const cycleCV=read('v6-market','get-current-cycle');
  const deposit=read('v6-market','get-token-x-deposit',[cycleCV,cp(JV)]).value;
  const clock=cvToString(read(JV,'get-clock'));
  const poolTokens=ft(`${admin}.${J}`);
  ok(call('mock-ft','set-blocked-recipient',[Cl.some(cp(J))],admin));
  err(call(J,'emergency-recover',[],admin),402);
  assert.equal(read('v6-market','get-token-x-deposit',[cycleCV,cp(JV)]).value,deposit);
  assert.equal(cvToString(read(JV,'get-clock')),clock);
  assert.equal(ft(`${admin}.${J}`),poolTokens);
  assert.equal(read(J,'get-pending-swap').type,'some');
  assert.equal(cvToString(read(J,'is-recovered-tranche',[u(cycle),u(0)])),'false');
  ok(call('mock-ft','set-blocked-recipient',[Cl.none()],admin));
 }
 const recovered=ok(call(J,'emergency-recover',[],admin));
 assert.equal(recovered.value.sbtc.value,expectedSbtc);
 assert.equal(recovered.value.stx.value,expectedStx);
 assert.equal(cvToString(read(J,'get-pending-swap')),'none');
 assert.equal(cvToString(read(JV,'get-clock')).includes('(batch-start none)'),true);
 assert.equal(cvToString(read(JV,'is-empty')),'true');
 err(call(J,'finalize-swap'),115);
 err(call(J,'emergency-recover',[],admin),115);
 err(call(J,'withdraw-sbtc-fees',[u(1),Cl.principal(admin)],admin),111);
 if(expectedSbtc>0n)err(call(J,'sweep-recovered-sbtc-dust',[u(cycle),u(0)],admin),104);
 const beforeA=ft(alice),beforeB=ft(bob),stxA=stx(alice),stxB=stx(bob);
 // Recovered sBTC collection must not transfer any STX.
 ok(call(J,'pay-stx-stakers',[Cl.list([Cl.principal(alice)]),u(cycle),u(0)]));
 ok(call(J,'pay-recovered-sbtc-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob),Cl.principal(bob)]),u(cycle),u(0)]));
 assert.equal(stx(bob),stxB);
 ok(call(J,'pay-stx-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(cycle),u(0)]));
 const aGrossSbtc=expectedSbtc/4n,bGrossSbtc=expectedSbtc*3n/4n;
 const aGrossStx=expectedStx/4n,bGrossStx=expectedStx*3n/4n;
 assert.equal(ft(alice)-beforeA,aGrossSbtc);
 assert.equal(ft(bob)-beforeB,bGrossSbtc-bGrossSbtc/20n);
 assert.equal(stx(alice)-stxA,aGrossStx);
 assert.equal(stx(bob)-stxB,bGrossStx-bGrossStx/20n);
 const balances=[ft(alice),ft(bob),stx(alice),stx(bob)];
 ok(call(J,'pay-recovered-sbtc-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(cycle),u(0)]));
 ok(call(J,'pay-stx-stakers',[Cl.list([Cl.principal(bob)]),u(cycle),u(0)]));
 assert.deepEqual([ft(alice),ft(bob),stx(alice),stx(bob)],balances);
 const fees=read(J,'get-earned-sbtc-fees').value;
 err(call(J,'withdraw-sbtc-fees',[u(fees+1n),Cl.principal(admin)],admin),111);
 if(fees>0n)ok(call(J,'withdraw-sbtc-fees',[u(fees),Cl.principal(admin)],admin));
 ok(call('mock-dia','set-skew',[u(10000)]));
 ok(call('v6-market','set-paused',[Cl.bool(false)],admin));
 console.log(`Juice: ${kind} recovery at 4320 blocks, paused withdrawals, mixed-asset payouts and replay passed`);
}
// Recovery dust and a subsequent normal batch coexist without mixing assets.
ok(call('mock-ft','mint',[u(7),cp(JV)]));
for(const [who,amount] of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(J),Cl.principal(who),u(164),u(amount)]));
ok(call(J,'pox-claim-rewards',[Cl.list([]),u(164)]));
sim.mineEmptyBurnBlocks(4320);
ok(call(J,'emergency-recover',[],admin));
// Fund the next batch before the previous recovered batch is paid.
ok(call('mock-pox','next-dist'));
ok(call(J,'pox-claim-rewards',[Cl.list([]),u(164)]));
ok(call(J,'pay-recovered-sbtc-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(164),u(0)]));
assert.equal(ok(call(J,'sweep-recovered-sbtc-dust',[u(164),u(0)],admin)).value,1n);
err(call(J,'sweep-recovered-sbtc-dust',[u(164),u(0)],admin),105);
sim.mineEmptyBurnBlocks(288);
ok(call(JV,'router-swap',[u(1000000),update]));
assert.equal(ok(call(J,'finalize-swap')).value,3200000000n);
ok(call(J,'pay-stx-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(164),u(1)]));
assert.equal(cvToString(read(JV,'is-empty')),'true');
console.log('Juice: recovered dust, unpaid recovery/next-batch isolation and return to normal STX route passed');

// Admin handover preserves the old admin until nominee accepts after 144 burns.
err(call(J,'accept-admin',[],bob),117);
err(call(J,'propose-admin',[Cl.principal(alice)],bob),100);
ok(call(J,'propose-admin',[Cl.principal(alice)],admin));
assert.equal(read(J,'get-admin').value,admin);
err(call(J,'accept-admin',[],alice),114);
err(call(J,'accept-admin',[],bob),100);
err(call(J,'set-paused',[Cl.bool(true)],alice),100);
ok(call(J,'set-paused',[Cl.bool(false)],admin));
sim.mineEmptyBurnBlocks(143);
err(call(J,'accept-admin',[],alice),114);
// Replacing a nominee resets the full delay, not just its remaining block.
ok(call(J,'propose-admin',[Cl.principal(bob)],admin));
sim.mineEmptyBurnBlock();
err(call(J,'accept-admin',[],alice),100);
err(call(J,'accept-admin',[],bob),114);
err(call(J,'cancel-admin-proposal',[],alice),100);
ok(call(J,'cancel-admin-proposal',[],admin));
err(call(J,'accept-admin',[],bob),117);
assert.equal(read(J,'get-admin').value,admin);
ok(call(J,'propose-admin',[Cl.principal(bob)],admin));
sim.mineEmptyBurnBlocks(143);
err(call(J,'accept-admin',[],bob),114);
sim.mineEmptyBurnBlock();
ok(call(J,'accept-admin',[],bob));
assert.equal(read(J,'get-admin').value,bob);
assert.equal(cvToString(read(J,'get-pending-admin')).includes('(admin none)'),true);
err(call(J,'accept-admin',[],bob),117);
err(call(J,'propose-admin',[Cl.principal(alice)],admin),100);
err(call(J,'set-paused',[Cl.bool(true)],admin),100);
ok(call(J,'set-paused',[Cl.bool(false)],bob));
// A later handover still works with its own fresh cooldown.
ok(call(J,'propose-admin',[Cl.principal(admin)],bob));
sim.mineEmptyBurnBlocks(144);
ok(call(J,'accept-admin',[],admin));
assert.equal(read(J,'get-admin').value,admin);
console.log('Juice: admin propose/accept at 144 burns, nominee-only acceptance, replacement/cancel, old-role revocation and repeat handover passed');

// Additional vault branch outcomes via authorized pool calls and declared fault fixtures.
err(call(J,'test-fund',[u(0)],admin),16006);
err(call(J,'test-finish',[],admin),16032);
ok(call(J,'set-vault-window-blocks',[u(0)],admin));
for(const [who,amount]of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(J),Cl.principal(who),u(169),u(amount)]));
ok(call('mock-pox','next-dist'));ok(call(J,'pox-claim-rewards',[Cl.list([]),u(169)]));
err(call(J,'test-fund',[u(1)],admin),16045);
ok(call(J,'set-vault-dia-band-bps',[u(0)],admin));
ok(call('mock-dia','set-failed',[Cl.bool(true)]));
ok(call(JV,'router-swap',[u(100000),update]));
ok(call('mock-dia','set-failed',[Cl.bool(false)]));
ok(call(J,'set-vault-dia-band-bps',[u(1000)],admin));
ok(call('mock-dia','set-skew',[u(7000)]));err(call(J,'refloor-vault',[update],admin),16037);
ok(call('mock-dia','set-skew',[u(10000)]));
ok(call('v6-market','test-zero-price',[Cl.bool(true)],admin));err(call(J,'refloor-vault',[update],admin),16013);
ok(call('v6-market','test-zero-price',[Cl.bool(false)],admin));
ok(call(J,'set-vault-router-cooldown',[u(0)],admin));
ok(call(JV,'router-swap',[u(900000),update]));ok(call(J,'finalize-swap'));
// Positive DIA cross can still round its slippage floor to zero: fail closed.
ok(call('mock-lazer-oracle','set-mid',[u(1)]));err({result:read(JV,'get-no-pyth-price')},16013);
ok(call('mock-dia','set-stx-usd',[u(200000000)]));err({result:read(JV,'get-dia-price')},16013);
ok(call('mock-dia','set-stx-usd',[u(100000000)]));ok(call('mock-lazer-oracle','set-mid',[u(32000000000000)]));
// Both a resting deposit AND a parked balance require two reclaim calls.
ok(call(J,'set-vault-window-blocks',[u(288)],admin));
for(const [who,amount]of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(J),Cl.principal(who),u(168),u(amount)]));
ok(call('mock-pox','next-dist'));ok(call(J,'pox-claim-rewards',[Cl.list([]),u(168)]));
ok(call(JV,'jing-place',[update]));ok(call('v6-market','test-park-extra',[cp(JV),u(7)],admin));
sim.mineEmptyBurnBlocks(4320);
const recoveryClock=cvToString(read(JV,'get-clock')),recoveryPosition=cvToString(read('v6-market','get-token-x-deposit',[read('v6-market','get-current-cycle'),cp(JV)]));
ok(call('mock-ft','set-short-transfer',[Cl.bool(true)],admin));
err(call(J,'emergency-recover',[],admin),16043);
assert.equal(cvToString(read(JV,'get-clock')),recoveryClock);
assert.equal(cvToString(read('v6-market','get-token-x-deposit',[read('v6-market','get-current-cycle'),cp(JV)])),recoveryPosition);
ok(call('mock-ft','set-short-transfer',[Cl.bool(false)],admin));
const double=ok(call(J,'emergency-recover',[],admin));assert.equal(double.value.sbtc.value,1000007n);
console.log('Juice extra branches: zero/busy funding, no-clock finish, DIA-band-off, both divergence edges, faulty zero market mid, rounding-to-zero, double reclaim passed');
// Current emergency interface: boundaries and real local asset accounting.
ok(call(J,'set-vault-router-cooldown',[u(1)],admin));
for(const value of [0,1000,5000])ok(call(J,'set-vault-no-pyth-slippage-bps',[u(value)],admin));
err(call(J,'set-vault-no-pyth-slippage-bps',[u(5001)],admin),16033);
err(call(J,'set-vault-no-pyth-slippage-bps',[u(1000)],alice),100);
err(call(JV,'set-no-pyth-slippage-bps',[u(1000)],admin),16000);
ok(call(J,'set-vault-no-pyth-slippage-bps',[u(1000)],admin));
ok(call(J,'set-vault-window-blocks',[u(0)],admin));
err(call(J,'router-swap-split-dia',[u(1),u(1),u(0),u(0)],admin),16031);
for(const [who,amount]of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(J),Cl.principal(who),u(170),u(amount)]));
ok(call('mock-pox','next-dist'));ok(call(J,'pox-claim-rewards',[Cl.list([]),u(170)]));
assert.equal(read(JV,'window-elapsed').type,'true');assert.equal(read(JV,'window-open').type,'false');
err(call(JV,'jing-place',[update]),16030);
err(call(JV,'jing-refloor',[update],admin),16000);
err(call(J,'router-swap-split-dia',[u(0),u(0),u(0),u(0)],admin),16006);
err(call(J,'router-swap-split-dia',[u(10),u(9),u(0),u(0)],admin),16040);
err(call(J,'router-swap-split-dia',[u(1000001),u(1000001),u(0),u(0)],admin),16006);
err(call(J,'router-swap-split-dia',[u(1),u(1),u(0),u(0)],alice),100);
err(call(JV,'router-swap-split-dia',[u(1),u(1),u(0),u(0)],admin),16000);
ok(call(J,'set-vault-max-chunk-sats',[u(100)],admin));
err(call(J,'router-swap-split-dia',[u(101),u(101),u(0),u(0)],admin),16039);
ok(call(J,'set-vault-max-chunk-sats',[u(5000000)],admin));
const quote=()=>read(JV,'get-no-pyth-price');
assert.equal(quote().value.value.source.value,'dia');
assert.equal(quote().value.value.limit.value,28800000000000n);
ok(call('mock-dia','set-age',[u(7200)]));ok({result:read(JV,'get-dia-price')});
ok(call('mock-dia','set-age',[u(7201)]));err({result:read(JV,'get-dia-price')},16036);
assert.equal(quote().value.value.source.value,'native');assert.equal(quote().value.value.limit.value,16000000000000n);
const before=ft(`${admin}.${JV}`),beforeSTX=stx(`${admin}.${JV}`);
const emergency=ok(call(J,'router-swap-split-dia',[u(100000),u(40000),u(30000),u(30000)],admin));
assert.equal(emergency.value.payload.value['price-source'].value,'native');
assert.equal(ft(`${admin}.${JV}`),before-100000n);assert.equal(stx(`${admin}.${JV}`),beforeSTX+320000000n);
err(call(J,'router-swap-split-dia',[u(100000),u(100000),u(0),u(0)],admin),16044);
ok(call(J,'set-vault-router-cooldown',[u(0)],admin));
ok(call('mock-dia','set-age',[u(0)]));ok(call('mock-dia','set-zero-stx',[Cl.bool(true)]));
assert.equal(quote().value.value['dia-error'].value.value,16013n);
ok(call('mock-native','set-failed',[Cl.bool(true)]));err({result:quote()},900);
const clockBefore=cvToString(read(JV,'get-config')),ftBefore=ft(`${admin}.${JV}`);
err(call(J,'router-swap-split-dia',[u(100000),u(100000),u(0),u(0)],admin),900);
assert.equal(cvToString(read(JV,'get-config')),clockBefore);assert.equal(ft(`${admin}.${JV}`),ftBefore);
ok(call('mock-native','set-failed',[Cl.bool(false)]));ok(call('mock-native','set-mid',[u(0)]));err({result:quote()},16013);
ok(call('mock-native','set-mid',[u(32000000000000)]));ok(call('mock-dia','set-zero-stx',[Cl.bool(false)]));
ok(call('mock-dia','set-failed',[Cl.bool(true)]));assert.equal(quote().value.value['dia-error'].value.value,16035n);
ok(call('mock-dia','set-failed',[Cl.bool(false)]));
// An over-high reference floor must revert all effects, including cooldown.
ok(call('mock-dia','set-skew',[u(13000)]));
err(call(J,'router-swap-split-dia',[u(100000),u(100000),u(0),u(0)],admin),3002);
assert.equal(ft(`${admin}.${JV}`),ftBefore);assert.equal(cvToString(read(JV,'get-config')),clockBefore);
ok(call('mock-dia','set-skew',[u(10000)]));
ok(call('mock-ft','set-blocked-recipient',[Cl.some(cp('mock-router'))],admin));
err(call(J,'router-swap-split-dia',[u(100000),u(100000),u(0),u(0)],admin),402);
assert.equal(ft(`${admin}.${JV}`),ftBefore);assert.equal(cvToString(read(JV,'get-config')),clockBefore);
ok(call('mock-ft','set-blocked-recipient',[Cl.none()],admin));
ok(call(J,'router-swap-split-dia',[u(900000),u(300000),u(300000),u(300000)],admin));
ok(call(J,'finalize-swap'));assert.equal(read(JV,'is-empty').type,'true');
console.log('Juice emergency: zero window, amount/auth/chunk guards, DIA/native boundaries, rollback, balance conservation and full drain passed');
const directory=resolve(projectRoot,'tests/vault/results');mkdirSync(directory,{recursive:true});
const report=sim.collectReport(false,'');
const vaultRecord=report.coverage.split('end_of_record').find(r=>r.includes('/juice-pool-swap-vault.clar'));
assert.ok(vaultRecord,'vault coverage missing');
const normalized=vaultRecord.replace(/^SF:.*juice-pool-swap-vault.clar$/m,'SF:contracts/pox-5/juice-pool-swap-vault.clar')+'end_of_record\n';
writeFileSync(resolve(directory,'runtime.lcov'),normalized);
const lineCounts=[...normalized.matchAll(/^DA:(\d+),(\d+)$/gm)].map(m=>({line:Number(m[1]),hits:Number(m[2])}));
const branchTotal=Number(normalized.match(/^BRF:(\d+)$/m)[1]),branchHits=Number(normalized.match(/^BRH:(\d+)$/m)[1]);
assert.equal(branchHits,branchTotal,'current vault branch coverage regressed');
writeFileSync(resolve(directory,'coverage.json'),JSON.stringify({sourceHashes:JSON.parse(readFileSync(resolve(testDir,'.build/source-hashes.json'))),
 branchTotal,branchHits,lineTotal:lineCounts.length,lineHits:lineCounts.filter(c=>c.hits>0).length,
 zeroHitLines:lineCounts.filter(c=>!c.hits).map(c=>c.line),
 notes:'Two zero-hit literal/binding lines execute semantically (mins tuple/native literal); all instrumented branch outcomes reached. Dependency addresses/assets rebound to fixtures, with declared fault injection. This is local vault coverage, not exhaustive mainnet dependency coverage.'},null,2)+'\n');
writeFileSync(resolve(directory,'runtime.json'),JSON.stringify({sourceHashes:JSON.parse(readFileSync(resolve(testDir,'.build/source-hashes.json'))),status:'passed',scope:'full-source local runtime with fixture dependencies; fork runs validate real dependency behavior'},null,2)+'\n');
