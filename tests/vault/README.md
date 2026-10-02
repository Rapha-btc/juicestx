# Current Juice vault runtime and Rendezvous tests

[Four-week vault rotation](../../contracts/pox-5/README-juice-pool-vault-upgrades.md) is pushed in `fc58b61`. Current local runtime coverage (2026-10-01, vault on the v6-3 market / v5-3 router interface) reaches **144/144 branch outcomes** and **455/475 line counters**, with **98 passing migration checks**. See [harness update](#2026-10-01-harness-update). [Current Stxer verification](../../simulations/README-pool-vault-stx.md) passes **570/570 checks** across 11 forks. The Rendezvous counts below remain archived pre-rotation results.

Target: `contracts/pox-5/juice-sbtc-autoswap.clar`.

Pre-rotation 2026-09-18 results: the full local runtime suite passed, reaching **129/129
instrumented branch outcomes** and **286/288 line counters**. Two Rendezvous
seeds passed **2,000/2,000 invariant checks**, with **zero falsified invariants**,
**zero runtime exceptions** and **60 completed batch round trips**. These complement
the [471 current-source Stxer checks](../../simulations/README-pool-vault-stx.md).
Finite testing is not an exhaustive proof for every uint128 input or external dependency.

## Run and replay

```sh
npm ci
npm run test:vault
npm run rv:vault:build
npm run rv:vault -- --seed=20260918 --bail
npm run rv:vault -- --seed=20260919 --bail
```

Python 3 builds the isolated manifests from current source; Clarinet SDK 3.21.0
runs Clarity 6/epoch 4.0. Rendezvous 1.0.0-rc.1 generates transaction sequences.
No sibling checkout or network oracle is needed for local tests. Generated
`.build/` and `.build-rv/` files are ignored and production sources never change.

## Runtime fixtures and coverage

`build.py` copies the full current Juice pool and vault, rebinding only external
principals/assets to local fixtures. Pool authorization remains intact. Two
test-only, admin-guarded pool methods isolate vault zero/busy funding and no-clock
finish. If the committed pool lacks the separately uncommitted emergency wrappers,
the builder appends their exact admin-guarded counterparts to the test copy only,
so a clean checkout can reproduce vault tests without claiming a deployed pool upgrade.

Dependency fixtures are self-contained snapshots originally adapted from the
CityCoins/Fastpool/Jing runtime harnesses. `v6-market` is an augmented/simplified
local market fixture, with six maker slots, mock core/ladder and Lazer feeds; it
is not the deployed market or a claim of full market coverage. sBTC and wSTX are
bound to one strict test FT ledger. A PoX fixture seeds fixed shares/rewards;
Fastpool snapshots retain the historical compatibility checks in the copied
runtime suite and are not Fastpool deployment amendments.

Additional declared fault fixtures:

- DIA: failure response, zero STX value, configurable USD scale, skew and age.
- RFQ native: independent price, zero and failure response.
- Market: return a zero mid, and create both resting and parked balances.
- FT: reject a recipient, or deliberately transfer one unit less than requested.
  The latter is a broken dependency model used to exercise the vault's final
  recovery-emptiness guard; it is not a claim that mainnet sBTC behaves that way.
- Router: buys with its funded STX at the fixture mid and enforces minimum output;
  it models one aggregated venue, not real per-AMM mechanics. Real venue execution
  and router event fields are covered by the Stxer runs.

The strict runtime suite checks every settings boundary/auth gate, zero/busy
funding, no-clock/window cases, maker fill, direct Jing take, Pyth split,
emergency DIA/native branches, 7,200/7,201-second age boundary, rounding to zero,
chunk/cooldown, full/partial sales, both resting+parked recovery, 4,319/4,320-block
recovery, failed-transfer/oracle/minimum rollback, balance changes, fees/OG
exemptions, recovery/normal reserves, payouts/replays and admin handovers.

Artifacts:

- [coverage.json](results/coverage.json): target counters and exact source hashes.
- [runtime.lcov](results/runtime.lcov): only the target vault coverage record.
- [runtime.json](results/runtime.json): status, source hashes and scope.

The 20 zero-hit line counters are tuple labels (`payload: {`, `(mins {`) and the
static principal / function-name lines of literal `contract-call?` forms
(native price, market getters in `is-empty` and `get-upgrade-status`). All
enclosing expressions execute and their values are asserted; branch outcomes
are 144/144. No contract patch was required to achieve these results.

## 2026-10-01 harness update

`npm run test:vault` had failed on a clean HEAD since the vault moved to the
v6-3 market: the fixture market had no `get-token-x-pending-deposit`, so the
read-only `is-empty` failed analysis as a writing call. Harness-only changes:

- `build.py` gives the `v6-market` fixture the v6-3 entry points the vault
  calls: `get-token-x-pending-deposit` (always `none`, the fixture admits at
  once), `deposit-token-x` / `set-token-x-limit` without an update (wrapping
  the v6 bodies with an empty update the mock oracle ignores), and a one-call
  `cancel-token-x-deposit` returning resting + parked. The FastPool snapshot
  and the fixture's own RV wrappers keep the v6 shapes (`-v6` names).
- `runtime.mjs` follows the vault changes since 2026-09-18: `router-swap`
  takes only the update and sells min(balance, max-chunk) (`20fb4f1`; exact
  partial sales set the chunk first); finalize refuses an open batch with
  u16032 (`ready-to-finish`); a maker fill needs `close-batch`; a balance
  within one chunk is swept whole by `jing-take`; a take or sale that empties
  the vault closes the batch; `emergency-recover` is permissionless after
  432 blocks (`8fac7c0`); an all-STX batch closes on its sale.
- New cases for the branches added since: `close-batch` (no clock, funds
  left, dust cancelled home), funding refused while a closed batch awaits
  finalize, both router floor refusals (nothing sold, output under the
  floor) and recovery of an all-STX batch. `mock-router` gains test-only
  `set-refuse` / `set-haircut-bps`; `mock-ft` gains `set-short-by` (the vault
  now tolerates DUST_SATS = 2 of residue, so the emptiness-guard fault
  withholds 3 units).
- `migration.mjs`: the test-rest helper uses the v6-3 deposit shape, and the
  replacement vault's chunk is raised before a 1M + 1 sat sale (default 1M).

## Rendezvous scope

RV appends `rv.invariants.clar` to a test copy of the full current vault. Only in
this fuzz build, POOL is rebound to the known simnet deployer principal. The
original caller-equality expressions remain intact; this models an authorized
pool actor plus nine unauthorized accounts without circular pool/vault calls.
Strict actual pool-wrapper authorization is covered by runtime and fork tests,
not by this actor substitution.

Test-only wrappers vary settings, mint explicit donations/funding, fund router
liquidity, toggle DIA/native faults and execute whole batch round trips.
`rv-release-window` and `rv-batch` can set the test window to zero even mid-batch
for progress through short fuzz sequences; the production mid-batch setter lock
is checked separately. Prices are bounded fixture values; RV's default naturals
are not an exhaustive exploration of the uint128 domain. Failed calls are valid
and must preserve invariants. A runtime panic is inspected separately because
RV can log it without falsifying an invariant.

Eight invariants check window exclusivity, no clock/no window, clock and cooldown
not in the future, bounded settings (including window zero), correct positive
DIA/native floor, no clock/no market position, and FT supply conservation across
the known actor/vault/market/router holders. RV selects an invariant after a
random command sequence: 2,000 runs means 2,000 checks, not 16,000 checks.

| Seed | Runs / passed checks | Completed batches | Successful public calls | Failed invariants | Runtime exceptions |
| --- | --- | --- | --- | --- | --- |
| 20260918 | 1,000 | 29 | 924 | 0 | 0 |
| 20260919 | 1,000 | 31 | 946 | 0 | 0 |

See [seed 20260918 JSON](results/rv-20260918.json),
[seed 20260919 JSON](results/rv-20260919.json), and their matching text summaries.
Exploratory earlier runs were green but had poorer successful batch reach;
the reported final seeds use the improved funding/progress harness.

The confirmed false failure in the earlier Jing-router report was a JavaScript
boolean decoder assertion (`type: "true"`, not `.value`), not a contract defect.
No new contract bug was found by the current runtime, fork or fuzz runs.

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
