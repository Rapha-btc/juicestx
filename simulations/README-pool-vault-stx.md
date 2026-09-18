# Juice pool / swap-vault Stxer simulations

The scripts deploy juice-pool-stx-signer-stx-rewards and juice-pool-swap-vault together
in mainnet forks; they send no live transactions.

From this repo, install dependencies with `npm ci`, then run:

```sh
node simulations/pool-vault-stx-stxer.mjs
node simulations/pool-vault-stx-stxer.mjs --maker
node simulations/pool-vault-stx-stxer.mjs --lifecycle
node simulations/pool-vault-recovery-stxer.mjs
node simulations/pool-admin-handover-stxer.mjs
```

The shared runner and signed-update helper are local to this simulations directory;
no sibling repo is required. STACKS_API_URL and STXER_API_URL override the default
node and simulation service. PYTH_API_KEY is optional; without it the scripts use
the public Jing backend for a signed BTC/STX update.

## Successful swap and recovery runs (before timed admin handover)

| Scenario | Passed | Stxer |
| --- | --- | --- |
| Deployment and guards | 14/14 | [simulation](https://stxer.xyz/simulations/mainnet/1f0b057a825cecb7ccb51cac99a3b593) |
| Maker fill during resting window | 30/30 | [simulation](https://stxer.xyz/simulations/mainnet/fda8d36ef8d440cdf306f89fd350947a) |
| Reclaim and smart-router liquidation | 34/34 | [simulation](https://stxer.xyz/simulations/mainnet/e036509b1b13ff7e6768b2873b70cbd5) |
| Recovery → recovery → normal → recovery | 185/185 | [simulation](https://stxer.xyz/simulations/mainnet/10e4772ef6fba8fee2ba5a2d85c72fc5) |

See [raw reports, fixture details and every earlier Juice swap-vault run](results/pool-vault-stx/README.md).

## Recovery behavior

Pool admin can call emergency-recover after 4,320 Bitcoin blocks from funding
(approximately one month). The vault reclaims resting/parked sBTC and returns
all remaining sBTC and already-earned STX only to the pool. The pool records both
pots against the pending tranche and clears the pending batch atomically.
Recovered STX uses the normal pay-stx-stakers entry point; recovered sBTC has
pay-recovered-sbtc-stakers, sweep-recovered-sbtc-dust and withdraw-sbtc-fees.
The normal STX fee/dust ledgers are unchanged. Payouts are permissionless and
apply the existing OG exemptions and live fee rate, capped at 5%.

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

## Timed admin handover

The current admin calls `propose-admin`; only the proposed principal can call
`accept-admin`, after 144 Bitcoin blocks. The current admin remains in charge
until acceptance and can call `cancel-admin-proposal`. Replacing a proposal
restarts the full 144-block delay. `get-pending-admin` exposes the nominee,
proposal height and acceptance height. Each successful action emits a pool print.

```sh
node simulations/pool-admin-handover-stxer.mjs
```

Stxer: [0bb89b79924e5dac7fc81f96decec1f8](https://stxer.xyz/simulations/mainnet/0bb89b79924e5dac7fc81f96decec1f8) — **52/52 checks passed**.
The simulation checks 143/144-block boundaries, nominee-only acceptance,
cancellation, replacement resetting the delay, former-admin authority revocation,
a second successful handover, and decoded committed proposal/accept/cancel prints.
It deploys both contract sources unchanged and advances actual fork Bitcoin blocks
with one-second synthetic timestamps; it uses no reward, share or storage fixtures.
Earlier swap/recovery runs below predate this admin-interface amendment.
