# Juice pool / swap-vault verification

> Current 2026-09-23 v6-3 recovery and regression results: [cancel-only recovery verification](README-v6-3-recovery.md). The notes below describe the earlier verification; linked JSON artifacts now contain the current reruns.

Current-source validation on **2026-09-18**: **570/570 Stxer checks passed** across 11 mainnet forks for the three contracts pushed in `fc58b61`. Each fork deploys the exact trait, vault and pool source before testing. No production transactions are sent.

The rotation fork has **89 passing checks**: admin/pool binding, cancellation and reset, 4,031-block rejection and 4,032-block activation, pending-tranche protection, old/new batch clocks and resting/parked positions, tiny donations accepted on both idle vaults, every stale wrapper rejected, and a real post-switch PoX claim, AMM swap, finalization and payout. Candidate vault copies exist only in the fork.

The local migration suite passes **97 checks**. Current local vault coverage reaches **129/129 branch outcomes** and **292/294 line counters**. The two zero-hit literal/binding counters execute semantically. The earlier Rendezvous runs (2,000 checks, zero exceptions, 60 completed batches) refer to pre-rotation hashes; they have not been rerun for vault rotation.

## Current Stxer runs

| Scenario | Passed | Stxer | Raw report |
| --- | --- | --- | --- |
| Vault rotation and post-switch rewards | 89/89 | [simulation](https://stxer.xyz/simulations/mainnet/dbd028618b2a89291b43a66069b62d23) | [juice-vault-upgrade.json](results/pool-vault-stx/juice-vault-upgrade.json) |
| Deployment and guards | 15/15 | [simulation](https://stxer.xyz/simulations/mainnet/2274b02948e1381360d12f2a0b6d53b6) | [juice-deployment-guards.json](results/pool-vault-stx/juice-deployment-guards.json) |
| Maker fill during patience | 31/31 | [simulation](https://stxer.xyz/simulations/mainnet/a773f4a7d6d7dff8554b476832dbb9bc) | [juice-maker.json](results/pool-vault-stx/juice-maker.json) |
| Smart-router AMM liquidation | 35/35 | [simulation](https://stxer.xyz/simulations/mainnet/d3b40e8a7c10664eb3d6e0e4e10f7ac9) | [juice-liquidation.json](results/pool-vault-stx/juice-liquidation.json) |
| Smart-router Jing fills | 40/40 | [simulation](https://stxer.xyz/simulations/mainnet/0a2efbe80b3936672dce8c6be4e042a8) | [juice-jing-router.json](results/pool-vault-stx/juice-jing-router.json) |
| Admin direct Jing take | 35/35 | [simulation](https://stxer.xyz/simulations/mainnet/caa0a8749794c515cee4b16372eb58fd) | [juice-jing-take.json](results/pool-vault-stx/juice-jing-take.json) |
| Required-Pyth manual split | 36/36 | [simulation](https://stxer.xyz/simulations/mainnet/acd282c4b730fa9ee454824bcdb5772f) | [juice-split-pyth.json](results/pool-vault-stx/juice-split-pyth.json) |
| Four-batch recovery continuity | 186/186 | [simulation](https://stxer.xyz/simulations/mainnet/b9107092fc2f1c74bac94a5dae9b9306) | [juice-recovery-continuity.json](results/pool-vault-stx/juice-recovery-continuity.json) |
| Timed admin handover | 53/53 | [simulation](https://stxer.xyz/simulations/mainnet/423cbe080c8335e611ee87f2809f5df4) | [juice-admin-handover.json](results/pool-vault-stx/juice-admin-handover.json) |
| Emergency DIA swap | 20/20 | [simulation](https://stxer.xyz/simulations/mainnet/b14d5ed91cf95e2e0995f460dbd775e5) | [juice-emergency-dia.json](results/pool-vault-stx/juice-emergency-dia.json) |
| Emergency native fallback | 30/30 | [simulation](https://stxer.xyz/simulations/mainnet/02d37affb122566fff0de32e0cb628c5) | [juice-emergency-native.json](results/pool-vault-stx/juice-emergency-native.json) |

Current SHA-256 source fingerprints:

- `juice-pool-swap-vault`: `be613079fbb7d40cfa205f287e2b9b653badef24724497e66a3e85bc7bf74a2f`
- `juice-swap-vault-trait`: `c0f471b1cd5876bcb12afcd689cdb82109f63163aee879d58e5ff691325cbbed`
- `juice-pool-stx-signer-stx-rewards`: `bdff5e99574f132b5b2e207144da46f273793f8576c6cdbb1652cdb2fba6471a`

Pre-rotation reports (471 checks) are preserved in [pre-rotation](results/pool-vault-stx/pre-rotation/). Older runs remain in [history](results/pool-vault-stx/history/).

## Run the fork cases

```sh
npm ci
node simulations/pool-vault-upgrade-stxer.mjs
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

`router-swap-split-dia(amount, dlmm, xyk, velar, active-vault)` has no Jing or update arguments.
It forwards Jing `u0` and update `none`. The restored `router-swap-split` requires
a Pyth buffer, and retains its normal 1% floor and separate 0.6% Velar floor.

The archived pre-rotation emergency DIA run returned:

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

## Rotation fork fixtures

The rotation fork deploys an unchanged candidate copy plus a wrong-pool copy. It seeds private batch clocks, market position maps and the pending-tranche guard only in the fork to isolate each rejection. Real one-satoshi and one-microSTX donations remain on the retired vault. After switching, a seeded earned PoX reward of 10,000 sats plus the candidate donation is claimed through the public pool API, swapped through the real router/AMM, finalized and paid to the original staker. The 4,032 burn-height steps use compressed timestamps; they test the height gate, not a month of real-time oracle updates. Local migration tests separately preserve prior tranche payouts.

## Deployment source preparation

The three production contracts are now comment-free and formatted with Clarinet.
Comparing Clarity tokens before/after (ignoring whitespace and optional commas)
confirmed identical executable content. Backend deployment templates match the
formatted source byte for byte and use Clarity 6, account index 0. Deployment order
is trait, vault, rewards pool; wait for each transaction to confirm before the next.
[Curl commands and fees](https://github.com/Rapha-btc/faktory-dao/blob/master/backend/docs/juice-stx-rewards-deployment.md)
are recorded in the backend repository.

The 570 fork checks above refer to the recorded **pre-format hashes** in `fc58b61`.
They are preserved unchanged. After formatting, local migration checks still pass
**97/97**, and local vault coverage reaches **129/129 branch outcomes**, now
**398/417 line counters**. Formatting creates additional tuple-field, binding and
multiline contract-call counters; zero counters are listed in the saved coverage
report. It did not change executable behavior.
