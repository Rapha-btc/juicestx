# Juice swap-vault Stxer results

## Latest reviewed code

All **263/263 checks passed** across the following four runs.

| Scenario | Passed | Stxer | Raw results |
| --- | --- | --- | --- |
| Deployment and guards | 14/14 | [1f0b057a825cecb7ccb51cac99a3b593](https://stxer.xyz/simulations/mainnet/1f0b057a825cecb7ccb51cac99a3b593) | [juice-deployment-guards.json](juice-deployment-guards.json) |
| Maker fill during resting window | 30/30 | [fda8d36ef8d440cdf306f89fd350947a](https://stxer.xyz/simulations/mainnet/fda8d36ef8d440cdf306f89fd350947a) | [juice-maker.json](juice-maker.json) |
| Reclaim and smart-router liquidation | 34/34 | [e036509b1b13ff7e6768b2873b70cbd5](https://stxer.xyz/simulations/mainnet/e036509b1b13ff7e6768b2873b70cbd5) | [juice-liquidation.json](juice-liquidation.json) |
| Recovery → recovery → normal → recovery | 185/185 | [10e4772ef6fba8fee2ba5a2d85c72fc5](https://stxer.xyz/simulations/mainnet/10e4772ef6fba8fee2ba5a2d85c72fc5) | [juice-recovery-continuity.json](juice-recovery-continuity.json) |

## Scope and fixtures

All runs deploy the production Juice signer and swap-vault sources unchanged,
using Clarity 6, and run only in independent mainnet forks. They use the real
PoX-5 claim path, sBTC ledger, Jing v6 market, smart router and available AMM state.
Signed BTC/STX Lazer updates use the public Jing backend; no private Pyth key is required.

Lifecycle and recovery runs seed crystallized PoX rewards and fixed 1:3 staker
shares with explicit fork-only Eval writes. Real sBTC transfers back those rewards.
These runs test claims, swaps, recovery, accounting, payouts and replay protection;
they do not test signer registration, STX lock admission, or rewards calculated from new stakes.
Pool fees are zero in these Stxer cases; 5% fees and OG exemptions are covered by local runtime tests.

The maker case completes within the resting window. Liquidation advances 288 + 1
Bitcoin blocks using one-second synthetic intervals. Production 80-second oracle
freshness remains enabled. Existing live Jing orders are canceled only inside the fork.

Recovery continuity executes four batches: resting sBTC recovery, partial-conversion
recovery with both STX and sBTC, a normal router batch, then another sBTC recovery.
It verifies admin authorization, the 4,319/4,320-block age boundary, recovery while
Jing is paused, clock/pending reset, separate per-batch entitlements and replay safety.
Old tranches are paid while the next batch is active, proving payout reserves stay separate.
Recovered STX uses pay-stx-stakers; remaining sBTC uses pay-recovered-sbtc-stakers.
Funding clocks are aged by explicit vault Eval fixtures (288, 4,319 and 4,320 blocks)
to keep signed updates valid for the following swaps. This is a state-transition test,
not a real month of chain time. Two additional one-second Bitcoin blocks exercise router cooldown.

## Earlier runs

These links document earlier contract versions; use the latest runs above for the final amendments.

| Earlier scenario | Passed | Stxer |
| --- | --- | --- |
| Initial deployment and guards | 14/14 | [0bf6a0a5b41f12a380793620e48dcebb](https://stxer.xyz/simulations/mainnet/0bf6a0a5b41f12a380793620e48dcebb) |
| Initial maker lifecycle | 30/30 | [b05bffa7d714f6a497c79bf311a56ed6](https://stxer.xyz/simulations/mainnet/b05bffa7d714f6a497c79bf311a56ed6) |
| Initial liquidation lifecycle | 34/34 | [f7c21a3e95ddf16c45df3d5cab22dccd](https://stxer.xyz/simulations/mainnet/f7c21a3e95ddf16c45df3d5cab22dccd) |
| Recovery continuity before final print/layout amendments | 185/185 | [fda41364996150a91b14a9e50f66e34e](https://stxer.xyz/simulations/mainnet/fda41364996150a91b14a9e50f66e34e) |
