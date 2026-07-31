# juice-pool-stx-signer — verification record

Covers `contracts/pox-5/juice-pool-stx-signer.clar` after the tranche + fee work
of 2026-07-30. Two independent methods: a **stxer mainnet-fork simulation**
against the real deployed pox-5, and **Rendezvous invariant fuzzing** on
clarinet simnet. They cover different things and neither replaces the other.

## Background: why tranches

pox-5 computes rewards once per **distribution cycle**, which is exactly half a
reward cycle (1,050 burn blocks vs 2,100). So a reward cycle is credited twice —
once at its midpoint, once at the start of the next cycle.

Careful: the two distribution cycles that **span** a reward cycle are not the two
that **credit** it. `calculate-rewards` uses `dist-boundary - 1`, which shifts the
credit one distribution cycle later:

```
burn 962,150  cycle 141 starts      dist 282  -> credits cycle 140
burn 963,200  cycle 141 midpoint    dist 283  -> credits 141   <- tranche 0
burn 964,250  cycle 142 starts      dist 284  -> credits 141   <- tranche 1
```

So cycle 141 is credited at distribution cycles **283 and 284**, and its second
tranche only becomes claimable once cycle 141 is already over. Confirmed by the
late-claim sim, where the tranche-0 bookmark read `(some 283)`.

The old contract claimed once per reward cycle and refused to claim until pox-5's
final computation had landed, because a pot that grows after some stakers are
paid dilutes them. That gave correct payouts every ~2 weeks.

Tranches keep the same guarantee weekly: each claim opens a **new** tranche
holding exactly the sats that claim received, and a written tranche is never
revisited — so the "pot must be final before it is divided" invariant holds per
tranche instead of per cycle. Shares still come from pox-5 per **reward** cycle,
so both tranches of a cycle divide by the same denominator. A tranche slices
money, never shares.

`pox-claim-rewards` is capped at one tranche per distribution cycle
(`last-claim-dist-cycle`). That permits exactly the two tranches pox-5 produces
and blocks unbounded dust tranches, each of which would otherwise cost a full
payout pass over every staker.

## 1. stxer mainnet-fork simulation

`simulations/pool-stx-signer-lifecycle-sim.mjs`

Runs against the **real deployed pox-5** — no shim, no injection. Epoch 4.0
activated at burn 960,230 on 2026-07-30, so pox-5 is a genuine boot contract.

Rewards turned out to be trivially simulatable: pox-5 computes new rewards as
`(its own sBTC balance) - staked-sbtc - reserve`, so "rewards arrived" just means
sBTC landed in the pox-5 contract. The sim sends 1 sBTC from a real whale and
`calculate-rewards` distributes it by share exactly as mainnet does. 15% is
skimmed to reserve (`RESERVE_RATIO u1500`).

### Covered

| Step | Result |
|---|---|
| deploy at chavita.btc (`SPV9K21…JDC22`), Clarity 5 | ok |
| `register-self` — grant + register in one tx | ok, signer registered |
| 8 real `juice-pool-v0` stakers call pox-5 `stake` | all ok, `validate-stake!` fired |
| friedgerpool.btc (already staked with Fast Pool) | **err u19 `ERR_ALREADY_STAKED`** |
| `propose-fee-bips` → 2,900 blocks → `confirm-fee-bips` | rate `u500` live |
| tranche 0 opened, tranche 1 opened | `tranche-count = 2` |
| tranche 0 paid 7/8, one staker withheld | `is-tranche-fully-paid t0` = false |
| `sweep-tranche-dust` tranche 0 | **err u104 `ERR_TRANCHE_UNPAID`** |
| tranche 1 paid 8/8 | fully paid = true, withheld staker paid normally |
| withheld staker back-filled in tranche 0 later | paid, tranche 0 now complete |
| re-run payout over all 8 | no transfers — no double-pay |
| tranche 0 residue | 3 sats of pure dust |

### Key results

**Tranches are independent.** A staker left unpaid in tranche 0 does not affect
tranche 1 at all, is repairable at any later time, and the only thing the hole
blocks is that tranche's dust sweep.

**Fee arithmetic is exact.** OG staked 238,300 STX → 2,051,215 sats. Non-OG
staked 112,612 STX → 920,864 sats. Scaled by stake the non-OG "should" have had
969,332 with no fee, and 920,864 / 969,332 = **0.95000** — precisely the 5%, with
the OG paying nothing.

### Late claiming (`pool-stx-signer-late-claim-sim.mjs`)

Claimed cycle 141 tranche 0 on time, deliberately skipped tranche 1, advanced ~2
reward cycles, then claimed and paid it late. **PASS** — tranche 1 opened with
4,448,150 sats at reward cycle 144, paid out in full, fee ratio 0.9503.

Safe because pox-5 never expires unclaimed rewards, and `unstake` removes shares
only from `current-cycle + 1` onward, so a closed cycle's share history is
immutable. Stakers who have since unstaked still get their final week.

**Edge case: a cycle can legitimately end with ONE tranche.** A claim pulls
everything accumulated for that cycle, so if both weeks are forgotten and claimed
once, a single tranche holds both weeks' sats — same total money, fewer boxes.
The tranche count therefore says nothing about whether stakers have been paid in
full; only `is-tranche-fully-paid` does, per tranche. Tooling must read
`get-tranche-count` and iterate `0 .. count-1` rather than hardcoding 2, or a
"wait for 2 tranches" job hangs forever on a forgotten cycle. See
`simulations/README.md` for the full table.

**Operational trap found while simulating.**
`get-unclaimed-signer-rewards` returns `u0` even when rewards are claimable — it
reads pox-5's settled map, which `calculate-rewards` never writes. Seen at step 25
of the lifecycle sim, immediately before a claim that pulled ~4.8M sats. A
claim-trigger cron gated on `> u0` would never fire. Full explanation and the two
correct alternatives are in `simulations/README.md`.

### Not covered

Adversarial call *ordering* — interleaving `set-paused`, `set-admin`,
`withdraw-fees` and partial payouts in sequences the script does not try.

## 2. Rendezvous invariant fuzzing

Requires **clarinet ≥ 3.23.0** and `@stacks/clarinet-sdk` ≥ 3.23.0. Earlier
versions bundle a pre-release pox-5 whose API differs from what shipped
(`get-signer-shares-staked-for-cycle` expects a `bool` in arg 2; the read-only
`get-earned-staker-rewards` is treated as a writing operation), so they reject
contracts that deploy fine on mainnet.

Two projects, both harness-only copies — the harness must never be deployed.

### 2a. Unseeded (real boot pox-5)

400+ runs, ~2,000 randomised calls. All invariants held.

**But three of six passed vacuously.** Simnet's pox-5 has no rewards, so
`pox-claim-rewards` never succeeded (0/98), no tranche was ever opened, and the
money invariants were checking `0 <= 0`. Real coverage was limited to the
admin/fee state machine: `invariant-fee-within-cap`,
`invariant-pending-fee-within-cap`, `invariant-og-pays-nothing`.

### 2b. Seeded (mock pox-5 + mock sBTC)

`mock-pox5.clar` and `mock-sbtc.clar` replace the two external dependencies so
the fuzzer can reach states simnet's pox-5 cannot produce.

Seeding is deliberately constrained so it cannot fabricate impossible states —
which would otherwise yield false violations:

- rewards must be **minted as real tokens** into mock-pox5 before becoming
  claimable, so no pot can exist without backing;
- shares can only be **added**, and `add-staker-shares` bumps the signer total by
  the same amount, preserving `signer-shares = sum(staker-shares)` as real pox-5
  guarantees.

**400 runs, zero failures across seven invariants**, with the money paths live:
`pox-claim-rewards` 48 successful, `pay-stx-stakers` 91, `pox-settle-stakers` 77.

| Invariant | Meaning |
|---|---|
| `invariant-paid-never-exceeds-pot` | a tranche never pays out more than it holds |
| `invariant-fees-backed-by-balance` | booked fees are backed by sBTC actually held |
| `invariant-solvent` | residue + fees ≤ balance |
| `invariant-fee-within-cap` | live rate never exceeds `MAX_FEE_BIPS` |
| `invariant-pending-fee-within-cap` | a pending proposal cannot carry an over-cap rate |
| `invariant-opened-tranche-records-dist` | every opened tranche recorded its distribution cycle |
| `invariant-og-pays-nothing` | an OG is never charged |

### Not covered

`sweep-tranche-dust` (0/71) and `withdraw-fees` (0/97) never succeeded — they are
admin-gated and RV mostly calls from random wallets, so every attempt returned
`err u100`. `confirm-fee-bips` (0/78) needs the 144-block cooldown to elapse.
Those three are covered by the stxer sim instead.

## Audit notes (self-audit, not third-party)

Fixed during this work:

- **Unbounded tranche proliferation.** Dropping the old cycle-ended gate left
  `pox-claim-rewards` callable at any moment by anyone; a griefer could open
  dozens of dust tranches, each costing a full payout pass. Capped at one per
  distribution cycle.
- **`pox-register-signer` was dead code.** Its comment described a grant existing
  without a registration, which Clarity cannot produce — if the register step
  errors, the whole transaction reverts and the grant goes with it. Removed.
- Three error constants left unused after the rework. Removed.

Accepted, deliberately:

- **Nothing is snapshot per tranche.** Both the fee rate and OG membership are
  read live at payout, so changes apply to any tranche not yet paid. Snapshotting
  would cost a map write per tranche (rate) or per staker per tranche
  (membership), purely to defend against an operator who already holds the admin
  key. `propose-fee-bips` + 144-block cooldown provides visibility instead.
- **Rounding favours the admin** by up to roughly one sat per staker per tranche,
  since each fee is floored independently and the remainder is swept as dust.

Open:

- `validate-stake!` is still admit-all (pausable). Anyone can point a stake at
  this signer until an allowlist is written.

## Re-running

```bash
# stxer lifecycle (real pox-5, real money movement)
node simulations/pool-stx-signer-lifecycle-sim.mjs

# rendezvous (needs clarinet >= 3.23 and the harness copies)
node <rendezvous>/dist/app.js <rvproj|rvseed> juice-pool-stx-signer invariant --runs=400
```

Clarinet gotchas in this repo: `settings/Mainnet.toml` points at
`https://api.hiro.so`, which fails requirement fetches (rate limits) — point it
at the juice node. Do **not** declare pox-5 as a requirement; clarinet provides
it as a boot contract. `[repl.remote_data]` needs `/v3/` node RPC routes the
juice API proxy does not serve.
