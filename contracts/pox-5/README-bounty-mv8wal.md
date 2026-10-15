# Review: bounty mv8wal65aa4a0c11edcd (10,000 sats, Juice pool part)

Pre-deploy review of the Juice part of the bounty: `juice-pool-sbtc-signer`
at `570226c`, `juice-sbtc-autoswap`, the autostake safe and juice-safe-v8.
The Jing v6-3 findings are reviewed in jing-contracts-v3.

| # | Submission | Who | Claim | Verdict | Status |
|---|---|---|---|---|---|
| 1 | Diamond Lance | Nilo | Fee on a past cycle reads the cover at payout, so a seat taken after the cycle ends skips that cycle's fee | Does not hold, by design | Rejected, no change |
| 2 | Calm Forge, Rare Io M-1 | Calm Forge, Rare Io | Passkey stake hash does not bind `signer-calldata` | Holds, Info (pool only prints it) | Fixed in pillar-wallets `5b1aa6b`: `juice-safe-auth-helpers-v2`. Deployed 2026-10-15 |

## 1. Diamond Lance (Nilo): seat taken after the cycle ends skips the fee

Claim: `get-staker-fee` (L296) reads the CURRENT OG cover. Payout calls it at
L766, L798 and L1175. Bob earns cycle N with no cover and owes the fee. After
N ends, an OG seat is freed by `evict-og`. Bob tops up, `take-og-seat` gives
him cover, and his unpaid cycle-N tranche then pays 0%.

The mechanism is correct. It is not a bug. We reject it for two reasons.

**The fee moves, it is not lost.** The seat Bob takes was freed by `evict-og`
on another OG. That OG's last tranche is paid after the eviction, so it also
reads the current cover (now 0) and pays the standard fee. This is the
accepted trade-off in README-bounty-mv7dfb section 1: "Payout reads the cover
when it runs, so evict after that cycle's payout, or the last tranche pays
the standard fee." One rule, read at payout, works in both directions: the
leaving OG pays the fee on their last tranche, and the new OG skips it on
theirs. Juice charges the fee on about the same amount of STX.

**The error is in the user's favor.** The worst case is one cycle's fee on
the stake that takes the freed cover. The amount is capped by that cover.
No staker loses STX or sBTC, and no staker pays more than the standard fee.

A per-cycle cover history (the proposed `og-history`, 6 entries per staker)
adds storage and a write to every growing stake, and runs on every payout.
That cost is not worth one cycle's fee on a rotated seat.

## 2. Calm Forge, Rare Io M-1: `signer-calldata` not in the passkey hash

Same finding as apeir on bounty mv7dfb. This pool only prints the calldata in
`validate-stake!`, so a swapped calldata could only fake a `ref` print. Fixed
in the safes, not the pool: `juice-safe-auth-helpers-v2` binds
`signer-calldata` in both stake hashes, and juice-safe-v8 and
juice-autostake-safe call it (pillar-wallets `5b1aa6b`, tests `d4b4ff0`).
helpers-v2 and juice-safe-v8 are on mainnet since 2026-10-15
(pillar-wallets DEPLOYED-VERIFIED.md).
