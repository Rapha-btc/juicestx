# Juice pool / swap-vault verification

Current-source validation on **2026-09-18**: **471/471 Stxer checks passed** in
10 mainnet forks. Every run deploys the local Clarity 6 pool and vault before
calling real mainnet dependencies. No live transactions are submitted.

The local runtime suite reaches **129/129 instrumented branch outcomes** and
**286/288 line counters** for `contracts/pox-5/juice-pool-swap-vault.clar`.
The two zero-hit counters are the `mins` tuple binding and the native contract
literal (lines 272/336); tests execute both paths. Rendezvous checked eight
invariants over two seeds: **2,000/2,000 invariant checks passed**, no runtime
exceptions, and **60 successful batch round trips**. This is measured vault
coverage with declared fixtures, not proof that every possible transaction or
all external contract code is bug-free.

Vault SHA-256: `ab3e77289a9692ba5d217451177766ee1bf88aeeacc5f211d136bf4afd9677d7`.
Pool SHA-256: `3df2ddc15523fc00850fcbd28f9b6a38672e14cfc5c69bca5f4df73978def350`.
The pool hash includes the emergency admin wrappers in the local working tree;
those pool source amendments remain uncommitted separately from this test work.
Do not assume a previously deployed pool has these new methods.

## Current Stxer runs

| Scenario | Passed | Stxer | Raw report |
| --- | --- | --- | --- |
| Deployment and guards | 14/14 | [simulation](https://stxer.xyz/simulations/mainnet/a802afe1e2560bfe2c3b7d892b538666) | [juice-deployment-guards.json](results/pool-vault-stx/juice-deployment-guards.json) |
| Maker fill during patience | 30/30 | [simulation](https://stxer.xyz/simulations/mainnet/575d7961086357312e7a464a543fdb98) | [juice-maker.json](results/pool-vault-stx/juice-maker.json) |
| Smart-router AMM liquidation | 34/34 | [simulation](https://stxer.xyz/simulations/mainnet/ca99c1e1ea2564f52e2867ee00cef13a) | [juice-liquidation.json](results/pool-vault-stx/juice-liquidation.json) |
| Smart-router Jing fills | 39/39 | [simulation](https://stxer.xyz/simulations/mainnet/805d3ef5744496d654b69c6c259fddc4) | [juice-jing-router.json](results/pool-vault-stx/juice-jing-router.json) |
| Owner-only direct Jing take | 34/34 | [simulation](https://stxer.xyz/simulations/mainnet/a1f6901f1527cd7407beeb9d395a3bf1) | [juice-jing-take.json](results/pool-vault-stx/juice-jing-take.json) |
| Required-Pyth manual split | 35/35 | [simulation](https://stxer.xyz/simulations/mainnet/d68fa679b74688e94fd2df8a1f922191) | [juice-split-pyth.json](results/pool-vault-stx/juice-split-pyth.json) |
| Four-batch recovery continuity | 185/185 | [simulation](https://stxer.xyz/simulations/mainnet/e662fbe736f230e530fc31cfc53a37a9) | [juice-recovery-continuity.json](results/pool-vault-stx/juice-recovery-continuity.json) |
| Timed admin handover | 52/52 | [simulation](https://stxer.xyz/simulations/mainnet/9010c0341aa816fad433d5bf4e0134fc) | [juice-admin-handover.json](results/pool-vault-stx/juice-admin-handover.json) |
| Emergency DIA swap | 19/19 | [simulation](https://stxer.xyz/simulations/mainnet/f1aee856d660d58e8709ccd279fa296f) | [juice-emergency-dia.json](results/pool-vault-stx/juice-emergency-dia.json) |
| Emergency native fallback | 29/29 | [simulation](https://stxer.xyz/simulations/mainnet/bcc54d2a6ad69210bd7a91c44b08be72) | [juice-emergency-native.json](results/pool-vault-stx/juice-emergency-native.json) |

## Run the fork cases

```sh
npm ci
node simulations/pool-vault-stx-stxer.mjs
node simulations/pool-vault-stx-stxer.mjs --maker
node simulations/pool-vault-stx-stxer.mjs --lifecycle
node simulations/pool-vault-stx-stxer.mjs --jing-router
node simulations/pool-vault-stx-stxer.mjs --jing-take
node simulations/pool-vault-stx-stxer.mjs --split-pyth
node simulations/pool-vault-recovery-stxer.mjs
node simulations/pool-admin-handover-stxer.mjs
node simulations/pool-vault-emergency-stxer.cjs
node simulations/pool-vault-emergency-stxer.cjs --native
```

`STACKS_API_URL` and `STXER_API_URL` override the node and fork service.
Signed-update cases use the local `_pool-vault-lazer.mjs` helper; `PYTH_API_KEY`
is optional. Emergency cases never fetch or supply a Pyth update. The common
and emergency runners capture source hashes at deployment. Older runner reports
also carry explicitly labeled offline current-source hash verification.

## Fork fixtures and scope

Lifecycle/recovery cases use the real PoX-5 claim path, token ledger, Jing market,
router, and AMMs. Crystallized earned rewards and 1:3 staker shares are explicit
fork-only Eval fixtures backed by real fork sBTC transfers. Existing live Jing
orders are canceled only inside the fork to isolate fills. These cases test
claims, swaps, recovery, attribution, payouts and replay; they do not test new
STX lock admission, signer registration, or newly accrued mining rewards.
Fees are zero in the fork lifecycle cases; local tests exercise 5% fees/OG exemptions.

Maker fills complete inside the patience window. Router cases advance 288+1
Bitcoin blocks with compressed one-second timestamps, keeping the production
signed-feed freshness checks enabled. Recovery fixtures age clocks to test the
4,319/4,320-block boundary without waiting a month. A four-batch sequence tests
resting recovery, mixed STX/sBTC recovery, normal liquidation and another recovery.
Replays, outstanding payout reserves and next-batch isolation are checked.

Emergency cases explicitly transfer 100,000 sats from a real whale to the draft
pool inside the fork. A pool Eval funds the vault through `as-contract?` with an
FT allowance; this isolates the swap path rather than testing PoX accounting.
Native-error tests mutate DIA timestamps/values and RFQ coinbase only in the fork.
The last negative swap disables cooldown through the admin wrapper to isolate
unusable-price rejection. Native runs do not synthesize blocks: a longer exploratory
case hit Stxer's `BlockingError` when native pricing read synthetic tenure data.
The successful parent-chain cases above replace that incomplete run.

## Emergency price and output examples

`router-swap-split-dia(amount, dlmm, xyk, velar)` has no Jing or update arguments.
It forwards Jing `u0` and update `none`. The restored `router-swap-split` requires
a Pyth buffer, and retains its normal 1% floor and separate 0.6% Velar floor.

The current emergency DIA run returned:

- STX/USD `(ok {value: u28252561, timestamp: u1789764657889})`: $0.28252561/STX.
- BTC/USD `(ok {value: u8110528212401, timestamp: u1789764657889})`: $81,105.28212401/BTC.
- `get-dia-value` returns only `(ok value)` after positive-value/freshness checks.
- `floor(BTC-USD * 100000000 / STX-USD) = u28707231929880`, or
  **287,072.31929880 STX/BTC**. The identical USD scales cancel.

The feed timestamp truncates to `1789764657` seconds. Previous Stacks block time
was `1789765458`: **801 seconds old**. Its expiry is
`1789764657 + 7200 = 1789771857 >= 1789765458`, so the freshness guard passes.
Local runtime tests verify age exactly 7,200 seconds passes and 7,201 seconds fails.

| Emergency case | Allocation, sats | Minimum total STX | Received STX | Unsold sats |
| --- | --- | --- | --- | --- |
| Valid DIA, default 10% tolerance | DLMM 10,000 | 25.836508 | 28.707443 | 0 |
| Stale DIA, native fallback | DLMM 4,000 / XYK 3,000 / Velar 3,000 | 15.204315 | 28.645061 | 0 |

DIA errors use a direct call to
`SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3 get-native-price`.
It returned `(ok u30408631185875)`, or **304,086.31185875 STX/BTC**.
`limit = floor(native/2) = u15204315592937`, the lower edge of the 0.5x–2x
band. For this sBTC sale, there is no upper cap on favorable STX output.
The configurable DIA tolerance is default 10%, bounded at 50%, and applies to
all emergency AMMs. It is not applied again to the native half-price floor.

Prints report the reference `mid`, enforced `limit-price`, `price-source`, original
`dia-error`, output and unsold sats. `mid` is diagnostic; `limit` enforces min-out.
All transfers and failed-call state rollbacks are tested. Both sources unusable
rejects; no zero-price escape is used. Emergency swaps remain admin-only and keep
window, amount, chunk-size and cooldown guards. A zero window is allowed only
between batches in the Juice vault.

## Timed admin handover

Only the current admin proposes/cancels a successor. Only the nominee accepts,
no earlier than 144 Bitcoin blocks after the latest proposal. Replacement resets
the delay; former-admin authority is revoked at acceptance. Fork and local tests
cover 143/144-block boundaries, cancellation, replacement, repeat handover and
committed prints. Current handover results are linked in the table above.

## Local runtime and Rendezvous

See [the self-contained harness README](../tests/vault/README.md) for every
fixture/rewrite, coverage artifacts, seeds and replay commands. Runtime tests keep
the real pool authorization wrappers and full vault source; external dependencies
are local fixtures. RV alone binds the vault's POOL principal to the deployer
actor and appends test-only progress/actor wrappers to make successful calls reachable.
Production source files are never rewritten by the fixture builder.

The confirmed defect was in the JavaScript Jing-router assertion, not the contract:
decoded Clarity boolean true has `type: "true"`, not `.value === true`.
The archived report's two false failures were corrected by rechecking the original
committed events, and the current run passes all 39 assertions using the corrected
checker. No new contract defect was found by these runs.

## Historical reports

Earlier results are preserved under [history](results/pool-vault-stx/history),
with filenames equal to Stxer IDs. These document prior source versions and are
not current-source coverage. In particular
[ed4d8d4d0bb0698f50d4e059a811f026](https://stxer.xyz/simulations/mainnet/ed4d8d4d0bb0698f50d4e059a811f026)
is the superseded optional-Pyth split prototype; its `err u16047` and interface no
longer apply. The emergency function's separate interface is verified by current runs.
