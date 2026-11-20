#!/usr/bin/env python3
"""Generate the Rendezvous projects under tests/rv/ from CURRENT source.

  tests/rv/.build-pool   target juice-pool-sbtc-signer (invariant mode)
  tests/rv/.build-vault  target juice-sbtc-autoswap   (invariant mode)

Both start from tests/vault/build.py output (the same fixture binding the
vitest suite uses). Production contracts/ and Clarinet.toml are only read.
See tests/rv/README.md for every test-only change.
"""
from pathlib import Path
import hashlib, json, shutil, subprocess, sys

here = Path(__file__).resolve().parent
root = here.parents[1]
vault_build = root / 'tests/vault/build.py'

V2 = '--v2' in sys.argv
SUFFIX = '-v2' if V2 else ''
PASS = [a for a in sys.argv[1:] if a == '--v2']

def run(*args):
    subprocess.run([sys.executable, str(vault_build), *args, *PASS], check=True, cwd=root)

def manifest(names, name):
    m = f'[project]\nname = "{name}"\ntelemetry = false\ncache_dir = "./.cache"\n[repl.analysis]\npasses = []\n'
    for n in names:
        m += f'\n[contracts.{n}]\npath = "contracts/{n}.clar"\nclarity_version = 6\nepoch = "4.0"\n'
    return m

def fresh(out):
    if out.exists():
        shutil.rmtree(out)
    (out / 'contracts').mkdir(parents=True)
    (out / 'settings').mkdir()
    shutil.copy(root / 'settings/Devnet.toml', out / 'settings/Devnet.toml')

# the fastpool fixtures are left out: they would only add foreign
# signer-manager / swap-vault trait implementations for RV to pick
CONTRACTS = ['sip-010-trait', 'mock-ft', 'mock-signer-trait', 'mock-pox', 'mock-lazer-oracle',
             'mock-dia', 'mock-native', 'mock-jing-core', 'mock-jing-ladder', 'v6-market', 'mock-router',
             'juice-swap-vault-trait', 'juice-swap-vault-trait-v2', 'juice-sbtc-autoswap',
             'juice-pool-sbtc-signer']

def build_pool():
    run()
    src = root / f'tests/vault/.build{SUFFIX}/contracts'
    out = here / f'.build-pool{SUFFIX}'
    fresh(out)
    for n in CONTRACTS:
        shutil.copy(src / f'{n}.clar', out / f'contracts/{n}.clar')
    # pool: drop the vitest-only test-fund / test-finish helpers that
    # tests/vault/build.py appends, then append the RV harness
    p = out / 'contracts/juice-pool-sbtc-signer.clar'
    s = p.read_text()
    cut = s.index('\n(define-public (test-fund ')
    s = s[:cut] + '\n'
    assert '(define-public (test-' not in s
    harness = (here / 'pool/pool.invariants.clar').read_text()
    if '--no-zero-stake' in sys.argv:
        # pox-5 may refuse a 0-uSTX stake at the node; this variant never
        # sends one, so the rest of the suite runs past the zero-seat finding
        zero = '(if (is-eq (mod raw u29) u0) u0'
        assert zero in harness
        harness = harness.replace(zero, '(if false u0')
        print('pool harness: zero-uSTX stakes disabled')
    p.write_text(s + '\n' + harness)
    # mock-pox: a reward cycle pays only once it is past and only if the
    # signer had stake in it (pox-5 claim-rewards); then the pox-5 model
    m = out / 'contracts/mock-pox.clar'
    t = m.read_text()
    old = ('(define-public (claim-rewards (bonds (list 6 uint)) (c uint))\n'
           ' (begin (if (> (var-get reward) u0) (try! (contract-call? .mock-ft mint (var-get reward) contract-caller)) true) (ok { total-rewards: (var-get reward) })))')
    assert old in t, 'mock-pox claim-rewards shape changed'
    new = ('(define-public (claim-rewards (bonds (list 6 uint)) (c uint))\n'
           ' (let ((r (if (and (< c (var-get cycle)) (> (get-signer-shares-staked-for-cycle contract-caller c none) u0) (rv-record-claim c)) (var-get reward) u0)))\n'
           '  (if (> r u0) (try! (contract-call? .mock-ft mint r contract-caller)) true) (ok { total-rewards: r })))')
    t = t.replace(old, new)
    m.write_text(t + '\n' + (here / 'pool/mock-pox-model.clar').read_text())
    (out / 'Clarinet.toml').write_text(manifest(CONTRACTS, 'juice-rv-pool'))
    print('built', out)

def build_vault():
    run('--rv')
    src = root / f'tests/vault/.build-rv{SUFFIX}'
    out = here / f'.build-vault{SUFFIX}'
    fresh(out)
    names = [n for n in CONTRACTS if n != 'juice-pool-sbtc-signer']
    for n in names:
        shutil.copy(src / f'contracts/{n}.clar', out / f'contracts/{n}.clar')
    p = out / 'contracts/juice-sbtc-autoswap.clar'
    extra = (here / 'vault/vault.extra.clar').read_text()
    p.write_text(p.read_text() + '\n' + extra)
    (out / 'Clarinet.toml').write_text(manifest(names, 'juice-rv-vault'))
    print('built', out)

def hashes():
    vault = 'juice-sbtc-autoswap' + SUFFIX
    h = {n: hashlib.sha256((root / f'contracts/pox-5/{n}.clar').read_bytes()).hexdigest()
         for n in ['juice-pool-sbtc-signer', vault]}
    (here / f'source-hashes{SUFFIX}.json').write_text(json.dumps(h, indent=2) + '\n')

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    target = args[0] if args else 'all'
    if target in ('pool', 'all'):
        build_pool()
    if target in ('vault', 'all'):
        build_vault()
    hashes()
