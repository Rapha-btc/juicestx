#!/usr/bin/env python3
"""Bind CURRENT Juice source to self-contained local fixtures, preserving guards."""
from pathlib import Path
import shutil,json,hashlib
here=Path(__file__).resolve().parent;root=here.parents[1];out=here/('.build-rv' if '--rv' in __import__('sys').argv else '.build');(out/'contracts').mkdir(parents=True,exist_ok=True);(out/'settings').mkdir(exist_ok=True)
# the -v6-3 / -v5-3 ids first: the bare -v6 / -v5 prefixes would otherwise leave a stray "-3"
replacements={"'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6-3":'.v6-market',"'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.swap-router-sbtc-stx-jing-v5-3":'.mock-router',"'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6":'.v6-market',"'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.swap-router-sbtc-stx-jing-v5":'.mock-router',"'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3":'.mock-native',"'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token":'.mock-ft',"'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2":'.mock-ft',"'SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle":'.mock-dia',"'SP000000000000000000002Q6VF78.pox-5":'.mock-pox',"'ST000000000000000000002AMW42H.pox-5":'.mock-pox','"sbtc-token"':'"mock-ft"'}
files={p.stem:p.read_text() for p in (here/'fixtures').glob('*.clar') if p.stem!='pool-emergency-wrappers'}
files['mock-signer-trait']='(define-trait signer-manager-trait ((validate-stake! (principal uint uint uint uint bool (optional (buff 500))) (response bool uint))))'
hashes={}
files['juice-swap-vault-trait']=(root/'contracts/pox-5/juice-swap-vault-trait.clar').read_text();hashes['juice-swap-vault-trait']=hashlib.sha256(files['juice-swap-vault-trait'].encode()).hexdigest()
for n in ['juice-pool-sbtc-signer','juice-sbtc-autoswap']:
 s=(root/f'contracts/pox-5/{n}.clar').read_text();hashes[n]=hashlib.sha256(s.encode()).hexdigest();files[n]=s
for n,s in files.items():
 for a,b in replacements.items():s=s.replace(a,b)
 s=s.replace('.mock-pox.signer-manager-trait','.mock-signer-trait.signer-manager-trait')
 if n=='v6-market':s+='\n(define-public (rv-park-x-for-test (who principal)) (park-token-x (var-get current-cycle) (contract-call? .mock-lazer-oracle get-mid) who (get-token-x-depositors (var-get current-cycle))))\n'
 if n=='juice-pool-sbtc-signer':
  if '(define-public (router-swap-split-dia' not in s:s+='\n'+(here/'fixtures/pool-emergency-wrappers.clar').read_text()
  s+='\n(define-public (test-fund (amount uint) (vault <swap-vault-interface>)) (begin (try! (assert-admin)) (try! (assert-active-vault vault)) (as-contract? ((with-ft .mock-ft "mock-ft" amount)) (try! (contract-call? vault fund amount)))))\n(define-public (test-finish (vault <swap-vault-interface>)) (begin (try! (assert-admin)) (try! (assert-active-vault vault)) (contract-call? vault finish)))\n'
 if n=='fastpool-swap-vault':
  # historical v6 snapshot: keep it on the fixture's v6-shaped entry points
  for fn in ['deposit-token-x','set-token-x-limit','cancel-token-x-deposit']:
   assert s.count(f'JING_MARKET {fn} ')==1,fn
   s=s.replace(f'JING_MARKET {fn} ',f'JING_MARKET {fn}-v6 ')
 if n=='v6-market':
  s+='\n(define-public (test-park-extra (who principal) (amount uint)) (begin (try! (contract-call? .mock-ft mint amount current-contract)) (ok (map-set token-x-parked who amount))))\n'
  # v6-3 getter the vault reads (is-empty, market-total, recovery): the fixture
  # has no pending-escrow stage, so it always answers none. Without it the
  # read-only is-empty fails analysis as a writing call.
  if '(define-read-only (get-token-x-pending-deposit' not in s:
   s+='\n(define-map token-x-pending-deposits principal {amount: uint, limit: uint, spread-bps: (optional uint), submitted-at: uint})\n(define-read-only (get-token-x-pending-deposit (depositor principal)) (map-get? token-x-pending-deposits depositor))\n'
  # v6-3 entry points the vault calls take no update (submit, then a keeper
  # settles). The fixture admits at once through its v6 body with an empty
  # update, which the mock Lazer oracle ignores.
  for fn,sig,args in [('deposit-token-x','(amount uint) (limit-price uint) (spread-bps (optional uint)) (t <ft-trait>) (asset-name (string-ascii 128))','amount limit-price spread-bps 0x t asset-name'),
                      ('set-token-x-limit','(limit-price uint) (spread-bps (optional uint))','limit-price spread-bps 0x')]:
   assert s.count(f'(define-public ({fn}\n')==1,fn
   s=s.replace(f'(define-public ({fn}\n',f'(define-public ({fn}-v6\n')
   # the fixture's own RV wrappers call the v6 shape
   assert s.count(f'  ({fn} ')==1,fn
   s=s.replace(f'  ({fn} ',f'  ({fn}-v6 ')
   s+=f'(define-public ({fn} {sig}) ({fn}-v6 {args}))\n'
  # v6-3 cancel returns pending + resting + parked in one call; the v6 body
  # returns resting first, parked on a second call. Chain the two.
  fn='cancel-token-x-deposit'
  assert s.count(f'(define-public ({fn}\n')==1 and s.count(f'  ({fn} ')==1,fn
  s=s.replace(f'(define-public ({fn}\n',f'(define-public ({fn}-v6\n').replace(f'  ({fn} ',f'  ({fn}-v6 ')
  s+=('(define-public (cancel-token-x-deposit (t <ft-trait>) (asset-name (string-ascii 128)))\n'
      '  (let ((first (try! (cancel-token-x-deposit-v6 t asset-name))))\n'
      '    (if (> (get-token-x-parked tx-sender) u0) (ok (+ first (try! (cancel-token-x-deposit-v6 t asset-name)))) (ok first))))\n')
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
 p=out/'contracts/juice-sbtc-autoswap.clar'
 s=p.read_text().replace('(define-constant POOL .juice-pool-sbtc-signer)', "(define-constant POOL 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM)")
 p.write_text(s+'\n'+(here/'rv.invariants.clar').read_text())
 print('RV ONLY: pool principal bound to the deployer actor; original equality guards unchanged; eight invariants appended')
