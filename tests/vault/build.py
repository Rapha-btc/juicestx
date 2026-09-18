#!/usr/bin/env python3
"""Bind CURRENT Juice source to self-contained local fixtures, preserving guards."""
from pathlib import Path
import shutil,json,hashlib
here=Path(__file__).resolve().parent;root=here.parents[1];out=here/('.build-rv' if '--rv' in __import__('sys').argv else '.build');(out/'contracts').mkdir(parents=True,exist_ok=True);(out/'settings').mkdir(exist_ok=True)
replacements={"'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6":'.v6-market',"'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.swap-router-sbtc-stx-jing-v5":'.mock-router',"'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3":'.mock-native',"'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token":'.mock-ft',"'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2":'.mock-ft',"'SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle":'.mock-dia',"'SP000000000000000000002Q6VF78.pox-5":'.mock-pox',"'ST000000000000000000002AMW42H.pox-5":'.mock-pox','"sbtc-token"':'"mock-ft"'}
files={p.stem:p.read_text() for p in (here/'fixtures').glob('*.clar') if p.stem!='pool-emergency-wrappers'}
files['mock-signer-trait']='(define-trait signer-manager-trait ((validate-stake! (principal uint uint uint uint bool (optional (buff 500))) (response bool uint))))'
hashes={}
files['juice-swap-vault-trait']=(root/'contracts/pox-5/juice-swap-vault-trait.clar').read_text();hashes['juice-swap-vault-trait']=hashlib.sha256(files['juice-swap-vault-trait'].encode()).hexdigest()
for n in ['juice-pool-stx-signer-stx-rewards','juice-pool-swap-vault']:
 s=(root/f'contracts/pox-5/{n}.clar').read_text();hashes[n]=hashlib.sha256(s.encode()).hexdigest();files[n]=s
for n,s in files.items():
 for a,b in replacements.items():s=s.replace(a,b)
 s=s.replace('.mock-pox.signer-manager-trait','.mock-signer-trait.signer-manager-trait')
 if n=='v6-market':s+='\n(define-public (rv-park-x-for-test (who principal)) (park-token-x (var-get current-cycle) (contract-call? .mock-lazer-oracle get-mid) who (get-token-x-depositors (var-get current-cycle))))\n'
 if n=='juice-pool-stx-signer-stx-rewards':
  if '(define-public (router-swap-split-dia' not in s:s+='\n'+(here/'fixtures/pool-emergency-wrappers.clar').read_text()
  s+='\n(define-public (test-fund (amount uint) (vault <swap-vault-interface>)) (begin (try! (assert-admin)) (try! (assert-active-vault vault)) (as-contract? ((with-ft .mock-ft "mock-ft" amount)) (try! (contract-call? vault fund amount)))))\n(define-public (test-finish (vault <swap-vault-interface>)) (begin (try! (assert-admin)) (try! (assert-active-vault vault)) (contract-call? vault finish)))\n'
 if n=='v6-market':
  s+='\n(define-public (test-park-extra (who principal) (amount uint)) (begin (try! (contract-call? .mock-ft mint amount current-contract)) (ok (map-set token-x-parked who amount))))\n'
  start=s.index('(define-public (refresh-mid');count=0
  for i in range(start,len(s)):
   if s[i]=='(':count+=1
   elif s[i]==')':
    count-=1
    if count==0:end=i+1;break
  original=s[start:end];body=original[original.index('\n')+1:].rsplit(')',1)[0]
  s=s[:start]+original[:original.index('\n')+1]+'  (if (var-get test-zero-mid) (ok u0) '+body+'))'+s[end:]
  s='(define-data-var test-zero-mid bool false)\n(define-public (test-zero-price (b bool)) (ok (var-set test-zero-mid b)))\n'+s
 (out/f'contracts/{n}.clar').write_text(s)
manifest='[project]\nname = "juice-vault-runtime"\ntelemetry = false\ncache_dir = "./.cache"\n[repl.analysis]\npasses = []\n'
for n in files:manifest+=f'\n[contracts.{n}]\npath = "contracts/{n}.clar"\nclarity_version = 6\nepoch = "4.0"\n'
(out/'Clarinet.toml').write_text(manifest);shutil.copy(root/'settings/Devnet.toml',out/'settings/Devnet.toml');(out/'source-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n');print('Built current-source vault fixtures:',out)

if __import__('sys').argv[-1]=='--rv':
 p=out/'contracts/juice-pool-swap-vault.clar'
 s=p.read_text().replace('(define-constant POOL .juice-pool-stx-signer-stx-rewards)', "(define-constant POOL 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM)")
 p.write_text(s+'\n'+(here/'rv.invariants.clar').read_text())
 print('RV ONLY: pool principal bound to the deployer actor; original equality guards unchanged; eight invariants appended')
