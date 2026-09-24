# Juice: cancel-only recovery against Jing v6-3

Verified 2026-09-23: **1147/1147 checks green** — recovery matrix **529/529**, existing regression suites **618/618**. No production contract edits; fork transactions only.

## Recovery matrix

Each inventory shape runs in four modes: normal, no oracle update supplied, market paused, and core-v6 paused. The normal mode also omits the update; the separately labelled no-update mode repeats the case explicitly. Signed Lazer data is used only to create or settle fixture orders, never during recovery.

The fixtures create pending escrow by calling `jing-place` with a nonempty opposite book. Resting, parked, pending plus resting, and no market position are tested separately. Every recovery checks exact returned sBTC, zero vault balance, empty pending/live/parked state, and `u1030` on a later settle. Pending refunds must emit the committed core event with reason `cancel` and the exact escrow amount. Paused cases also assert the pause remains set.

The actual pool calls `emergency-recover` with the vault trait. Its dynamic call invokes **`emergency-recover()` with no arguments**, checking conformance against the live shared trait. Direct unauthorized calls to the vault are refused. The pool receives the exact recovered total.

| Inventory | Recovery caller | N/M, including setup | Fork |
| --- | --- | ---: | --- |
| pending | pool | 105/105 | [stxer](https://stxer.xyz/simulations/mainnet/8ec4a71a0e1ace4c5203ad6beea60861) |
| resting | pool | 94/94 | [stxer](https://stxer.xyz/simulations/mainnet/0dc1340652e93ee5c764526b2abfe7ba) |
| parked | pool | 123/123 | [stxer](https://stxer.xyz/simulations/mainnet/6a160d25dc2c7f490346241203078be7) |
| pending+resting | pool | 117/117 | [stxer](https://stxer.xyz/simulations/mainnet/a32ec71cc6eda7543121a3f2b0b68e28) |
| none | pool | 90/90 | [stxer](https://stxer.xyz/simulations/mainnet/efa2fa374a636040fef2a7f15084e021) |

[Machine-checked recovery report](results/v6-3-recovery/juice.json).

## Existing regression reruns

| Harness / mode | N/M | Fork | Saved evidence |
| --- | ---: | --- | --- |
| juice-admin-handover | 59/59 | [stxer](https://stxer.xyz/simulations/mainnet/4cc831e9fecfae620585cacbafbcfc0e) | [JSON](results/pool-vault-stx/juice-admin-handover.json) |
| juice-deployment-guards | 21/21 | [stxer](https://stxer.xyz/simulations/mainnet/b7440c69e582e2110d0d58ed2f8ec302) | [JSON](results/pool-vault-stx/juice-deployment-guards.json) |
| juice-emergency-dia | 26/26 | [stxer](https://stxer.xyz/simulations/mainnet/288726966502961c09fc33d1591885e9) | [JSON](results/pool-vault-stx/juice-emergency-dia.json) |
| juice-emergency-native | 36/36 | [stxer](https://stxer.xyz/simulations/mainnet/8008d76cf9c10a93866b142c95fb15e8) | [JSON](results/pool-vault-stx/juice-emergency-native.json) |
| juice-jing-router | 43/43 | [stxer](https://stxer.xyz/simulations/mainnet/1fe2f3260dfcecc587f17b2be171f180) | [JSON](results/pool-vault-stx/juice-jing-router.json) |
| juice-jing-take | 38/38 | [stxer](https://stxer.xyz/simulations/mainnet/2c862a8bc904ae0fdb884c5ba16479b9) | [JSON](results/pool-vault-stx/juice-jing-take.json) |
| juice-liquidation | 38/38 | [stxer](https://stxer.xyz/simulations/mainnet/d47a6196c6bdf6210bae52971d013a3c) | [JSON](results/pool-vault-stx/juice-liquidation.json) |
| juice-maker | 34/34 | [stxer](https://stxer.xyz/simulations/mainnet/f2f80a8f08b0c2f1ef15743f620b711e) | [JSON](results/pool-vault-stx/juice-maker.json) |
| juice-recovery-continuity | 189/189 | [stxer](https://stxer.xyz/simulations/mainnet/326a5d1d623170f6feb9caf79ac72220) | [JSON](results/pool-vault-stx/juice-recovery-continuity.json) |
| juice-split-pyth | 39/39 | [stxer](https://stxer.xyz/simulations/mainnet/806ce8d26ed0cd9817ef696e415ee8ed) | [JSON](results/pool-vault-stx/juice-split-pyth.json) |
| juice-vault-upgrade | 95/95 | [stxer](https://stxer.xyz/simulations/mainnet/139557e02ca5f0585a25c78c6a36cdf3) | [JSON](results/pool-vault-stx/juice-vault-upgrade.json) |

## Fork setup and limits

Every recovery fork deploys the unmodified sibling Jing sources under `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22`: `jing-core-v6` → `jing-ladder-v1` → `markets-sbtc-stx-jing-v6-3` → `swap-router-sbtc-stx-jing-v5-3`. It syncs the ladder seats, verifies the market in core, then initializes it with sBTC/STX traits, minimums 1,000 sats / 1,000,000 µSTX, and feed IDs 1 / 45. Market initialization registers with core. The vault and pool (CCD016: book and vault) are then deployed from this repository.

Juice is pinned to block **9021103**, after the shared zero-argument vault trait was deployed and before the Juice vault/pool names were deployed. Thus the fork can deploy the current vault and pool under their production names. `observedTip` in legacy reports is only the API tip observed during preparation; `block` / `forkBlock` records the actual fork base.

The primary matrix uses real fork token transfers. PoX earned rewards and mirrored pool shares are seeded in storage; creating locks and signer registration are outside this test. The vault funding clock is aged with an explicit Eval (433 burn blocks for the pools, 288 for CCD016); Fastpool’s settlement deadline is also aged. This tests the recovery gate on elapsed state without expiring the signed update needed for fixture creation. It does not simulate days of independent market activity.

Parking is reached through the public ladder seat-reservation setter and a larger publicly submitted and settled entrant. The primary matrix does not rewrite market balances or order maps. CCD016’s DAO Extensions map enables only the actual vault and a sender-guarded proposal extension; this tests extension authorization and treasury flow, not governance voting.

Legacy regression fixtures retain their stated scope: earned rewards/shares, compressed burn-block intervals, and DAO/DIA fixtures. Juice’s upgrade suite also uses deliberately altered candidate authority and injected tranche/order state. The four legacy CCD016 scripts strip comments only from deployed Jing/vault sources, use canonical dependency names, and retain their simulated DAO implementation. The old oracle-staleness widening has been removed. Source hashes and fixture disclosures are saved with the reports.

Migration adjustments preserve scenario intent: deposit calls use submit’s current ABI; full-side placement/readmit tests explicitly settle; empty reclaim is idempotent. Two-chunk liquidation explicitly caps a chunk, because current `sweep-amount` drains a smaller balance in one call. Maker fills close the batch before finishing. Recovery continuity uses the current 432-block emergency delay. No recovery failure was hidden by changing a contract.

## Run

Requires the sibling `~/projects/jing-contracts-v3` checkout and its installed Node dependencies. `JING_SRC` can override its contracts directory. The Lazer helper uses the public route without `PYTH_API_KEY`. The default node is `http://77.42.3.101/stacks-api`; `STACKS_API_URL` overrides it.

```sh
node simulations/pool-vault-recovery-stxer.mjs --matrix
node simulations/pool-vault-stx-stxer.mjs
node simulations/pool-vault-stx-stxer.mjs --maker
node simulations/pool-vault-stx-stxer.mjs --lifecycle
node simulations/pool-vault-stx-stxer.mjs --jing-router
node simulations/pool-vault-stx-stxer.mjs --jing-take
node simulations/pool-vault-stx-stxer.mjs --split-pyth
node simulations/pool-vault-recovery-stxer.mjs
node simulations/pool-vault-upgrade-stxer.mjs
node simulations/pool-admin-handover-stxer.mjs
node simulations/pool-vault-emergency-stxer.cjs
node simulations/pool-vault-emergency-stxer.cjs --native
```

Vault recovery source base: `f2ca24b`; Jing source checkout: `24f3e23`.

## Exact recovery-matrix source hashes

| Contract | SHA-256 |
| --- | --- |
| `jing-core-v6` | `53c9b38a46196f777b3c76f76152c172aa50c220e4e8e449d47cb6cd3fe9ab32` |
| `jing-ladder-v1` | `99a6e9f6db9305ebb29d938e69439c720e497bd38c53ec8b447c8c34c528a902` |
| `markets-sbtc-stx-jing-v6-3` | `04b0a7df781aec46124d40d3c73c68169aeed919fed155ec5bf12153bb0bfb85` |
| `swap-router-sbtc-stx-jing-v5-3` | `dfc8165bb846c1e6bb2a95f1e3ac87d3a22bce0e5f2a8f6618a499c8a03f8cae` |
| `juice-pool-swap-vault` | `75fa49b8a81ca7758bb5cf2013e3424312f94383767d348321c4b6396e91c004` |
| `juice-pool-stx-signer-stx-rewards` | `a5be5363956688c17376ba55f2af688372997d21823755797b9a6b4c919036cc` |
