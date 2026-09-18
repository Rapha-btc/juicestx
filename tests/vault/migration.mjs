// Candidate copies exist only inside this isolated simnet, not as production vaults.
import {initSimnet} from '@stacks/clarinet-sdk';
import {Cl,cvToString} from '@stacks/transactions';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const dir=fileURLToPath(new URL('.',import.meta.url));
const sim=await initSimnet(dir+'.build/Clarinet.toml');
const accounts=sim.getAccounts(),admin=accounts.get('deployer'),alice=accounts.get('wallet_1');
const P='juice-pool-stx-signer-stx-rewards',OLD='juice-pool-swap-vault',NEXT='sim-next-vault',OTHER='sim-other-vault';
const u=Cl.uint,cp=n=>Cl.contractPrincipal(admin,n),principal=n=>`${admin}.${n}`;
let checks=0;const call=(n,f,a=[],sender=admin)=>sim.callPublicFn(n,f,a,sender);
const pool=(f,a=[],sender=admin)=>call(P,f,a,sender);
const read=(n,f,a=[])=>sim.callReadOnlyFn(n,f,a,admin).result;
const ok=r=>{checks++;assert.equal(r.result.type,'ok',cvToString(r.result));return r.result.value};
const err=(r,c)=>{checks++;assert.equal(cvToString(r.result),`(err u${c})`)};
const eq=(a,b)=>{checks++;assert.equal(a,b)};
const pending=()=>read(P,'get-pending-swap-vault').value;
const ft=n=>read('mock-ft','get-balance',[cp(n)]).value.value;
const source=readFileSync(dir+'.build/contracts/'+OLD+'.clar','utf8');
const helpers=`
;; Fixture-only controls; these are never added to a production vault file.
(define-public (test-clock (active bool))
 (begin (asserts! (is-eq tx-sender '${admin}) (err u999))
 (ok (var-set batch-start (if active (some burn-block-height) none)))))
(define-public (test-rest)
 (begin (asserts! (is-eq tx-sender '${admin}) (err u999))
 (as-contract? ((with-ft .mock-ft "mock-ft" u1000))
  (try! (contract-call? JING_MARKET deposit-token-x u1000 u30400000000000 (some u0) 0x SBTC_TOKEN ASSET_SBTC)))))
(define-public (test-reclaim)
 (begin (asserts! (is-eq tx-sender '${admin}) (err u999))
 (as-contract? () (try! (contract-call? JING_MARKET cancel-token-x-deposit SBTC_TOKEN ASSET_SBTC)))))
(define-public (test-clear)
 (begin (asserts! (is-eq tx-sender '${admin}) (err u999))
 (let ((sbtc (sbtc-balance)) (stx (stx-get-balance current-contract)))
  (if (> sbtc u0) (begin (try! (as-contract? ((with-ft .mock-ft "mock-ft" sbtc))
   (try! (contract-call? .mock-ft transfer sbtc current-contract '${admin} none)))) true) true)
  (if (> stx u0) (begin (try! (as-contract? ((with-stx stx))
   (try! (stx-transfer? stx current-contract '${admin})))) true) true))
 (ok (var-set batch-start none))))`;
for(const n of [NEXT,OTHER])eq(sim.deployContract(n,source+helpers,{clarityVersion:6},admin).result.type,'true');
const wrongPool=source.replace('(define-constant POOL .'+P+')',`(define-constant POOL '${alice})`);
eq(sim.deployContract('sim-wrong-pool',wrongPool,{clarityVersion:6},admin).result.type,'true');
eq(cvToString(read(P,'get-swap-vault')),cvToString(cp(OLD)));eq(pending().vault.type,'none');
err(pool('confirm-swap-vault',[cp(OLD),cp(NEXT)]),118);
err(pool('propose-swap-vault',[cp(NEXT)],alice),100);
err(pool('cancel-swap-vault-proposal',[],alice),100);
err(pool('confirm-swap-vault',[cp(OLD),cp(NEXT)],alice),100);
err(pool('propose-swap-vault',[cp(OLD)]),119);
err(pool('propose-swap-vault',[cp('sim-wrong-pool')]),119);
ok(call('mock-ft','mint',[u(1),cp(OTHER)]));ok(sim.transferSTX(1n,principal(OTHER),admin));ok(pool('propose-swap-vault',[cp(OTHER)]));ok(pool('cancel-swap-vault-proposal'));ok(call(OTHER,'test-clear'));
ok(call('mock-ft','mint',[u(1000),cp(OTHER)]));ok(call(OTHER,'test-rest'));err(pool('propose-swap-vault',[cp(OTHER)]),120);ok(call(OTHER,'test-reclaim'));ok(call(OTHER,'test-clear'));
ok(call('v6-market','test-park-extra',[cp(OTHER),u(1000)]));err(pool('propose-swap-vault',[cp(OTHER)]),120);ok(call(OTHER,'test-reclaim'));ok(call(OTHER,'test-clear'));
ok(pool('propose-swap-vault',[cp(NEXT)]));const firstDeadline=pending()['executable-at'].value;
sim.mineEmptyBurnBlocks(10);ok(pool('propose-swap-vault',[cp(OTHER)]));eq(pending()['executable-at'].value,firstDeadline+10n);
ok(pool('cancel-swap-vault-proposal'));eq(pending().vault.type,'none');eq(pending()['proposed-at'].value,0n);
err(pool('confirm-swap-vault',[cp(OLD),cp(OTHER)]),118);
// Normal rewards continue to use OLD throughout the notice period.
ok(pool('set-vault-window-blocks',[u(0),cp(OLD)]));
ok(call('mock-pox','stake-test',[cp(P),Cl.principal(alice),u(200),u(1)]));
ok(pool('pox-claim-rewards',[Cl.list([]),u(200),cp(OLD)],alice));eq(ft(OLD),1000000n);eq(ft(NEXT),0n);
ok(pool('propose-swap-vault',[cp(NEXT)]));const deadline=Number(pending()['executable-at'].value);
sim.mineEmptyBurnBlocks(deadline-sim.burnBlockHeight-1);
eq(sim.burnBlockHeight,deadline-1);err(pool('confirm-swap-vault',[cp(OLD),cp(NEXT)]),114);
sim.mineEmptyBurnBlock();eq(sim.burnBlockHeight,deadline);err(pool('confirm-swap-vault',[cp(OLD),cp(NEXT)]),115);
eq(cvToString(read(P,'get-swap-vault')),cvToString(cp(OLD)));eq(ft(OLD),1000000n);
err(pool('confirm-swap-vault',[cp(NEXT),cp(NEXT)]),119);
err(pool('confirm-swap-vault',[cp(OLD),cp(OTHER)]),119);
// Existing rewards stay attributable to their original tranche before migration.
ok(sim.transferSTX(10000000000n,principal('mock-router'),admin));
ok(pool('router-swap-split-dia',[u(1000000),u(1000000),u(0),u(0),cp(OLD)]));
eq(ft(OLD),0n);ok(pool('finalize-swap',[cp(OLD)],alice));
eq(read(P,'get-stx-pot',[u(200),u(0)]).value,3200000000n);eq(read(P,'get-pending-swap').type,'none');
// Candidate state is checked again at execution, not just at proposal time.
ok(call(NEXT,'test-clock',[Cl.bool(true)]));err(pool('confirm-swap-vault',[cp(OLD),cp(NEXT)]),120);ok(call(NEXT,'test-clear'));
ok(call('mock-ft','mint',[u(1),cp(NEXT)]));ok(sim.transferSTX(1n,principal(NEXT),admin));
// Donations to either idle vault must not block confirmation.
ok(sim.transferSTX(1n,principal(OLD),admin));ok(call('mock-ft','mint',[u(1),cp(OLD)]));
ok(pool('confirm-swap-vault',[cp(OLD),cp(NEXT)]));
eq(cvToString(read(P,'get-swap-vault')),cvToString(cp(NEXT)));eq(pending().vault.type,'none');eq(pending()['proposed-at'].value,0n);
err(pool('confirm-swap-vault',[cp(OLD),cp(NEXT)]),118);
// Every typed wrapper rejects the former destination before any external action.
const stale=[
 ['pox-claim-rewards',[Cl.list([]),u(202)]],['finalize-swap',[]],['emergency-recover',[]],
 ['refloor-vault',[Cl.buffer(new Uint8Array())]],['jing-take',[u(1),Cl.buffer(new Uint8Array())]],
 ['router-swap-split',[u(1),u(0),u(1),u(0),u(0),Cl.buffer(new Uint8Array())]],
 ['router-swap-split-dia',[u(1),u(1),u(0),u(0)]],
 ...['window-blocks','leeway-bps','slippage-bps','max-chunk-sats','dia-band-bps','router-cooldown','no-pyth-slippage-bps'].map(n=>['set-vault-'+n,[u(1)]])];
for(const [f,a] of stale)err(pool(f,[...a,cp(OLD)]),119);
ok(call('mock-pox','next-dist'));ok(call('mock-pox','stake-test',[cp(P),Cl.principal(alice),u(202),u(1)]));
ok(pool('set-vault-window-blocks',[u(0),cp(NEXT)]));ok(pool('pox-claim-rewards',[Cl.list([]),u(202),cp(NEXT)],alice));
eq(ft(OLD),1n);eq(ft(NEXT),1000001n);
eq(read(P,'get-stx-pot',[u(202),u(0)]).value,0n); // no early attribution
sim.mineEmptyBurnBlock();ok(pool('router-swap-split-dia',[u(1000001),u(1000001),u(0),u(0),cp(NEXT)]));
ok(pool('finalize-swap',[cp(NEXT)],alice));eq(read(P,'get-stx-pot',[u(202),u(0)]).value,3200003201n);
eq(ft(NEXT),0n);eq(ft(OLD),1n);eq(read(P,'get-pending-swap').type,'none');
// Previously earned rewards remain payable; rotation never changes shares/fees.
const aliceBefore=sim.getAssetsMap().get('STX').get(alice);
ok(pool('pay-stx-stakers',[Cl.list([Cl.principal(alice)]),u(200),u(0)],alice));
eq(sim.getAssetsMap().get('STX').get(alice)-aliceBefore,3200000000n);
// A later upgrade needs a fresh full notice period too.
ok(pool('propose-swap-vault',[cp(OLD)]));eq(pending()['executable-at'].value,BigInt(sim.burnBlockHeight+4032));
err(pool('confirm-swap-vault',[cp(NEXT),cp(OLD)]),114);ok(pool('cancel-swap-vault-proposal'));
const output=dir+'results/';mkdirSync(output,{recursive:true});const report={status:'passed',checks,delayBitcoinBlocks:4032,sourceHashes:JSON.parse(readFileSync(dir+'.build/source-hashes.json')),cases:['admin gate','candidate interface/pool binding','proposal replacement resets delay','cancellation','4031 rejected / 4032 accepted after draining','pending-tranche guard','candidate batch revalidation; donated STX/sBTC accepted at proposal and confirmation','old STX/sBTC donations do not block rotation; remain in retired vault','all stale wrapper targets rejected','future rewards routed only to new vault','old and new tranche attribution','prior payouts preserved','second upgrade starts a fresh delay'],scope:'Current source local simnet; replacement vault copies created only in memory for this test; no production deployment.'};
writeFileSync(output+'migration.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
