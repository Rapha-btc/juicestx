# stxer mainnet-fork simulations

Each script forks mainnet at the current tip and replays a scenario against **real
deployed contracts**. Run with `node simulations/<file>.mjs`; each prints a
`https://stxer.xyz/simulations/mainnet/<id>` link.

Results below are from **2026-07-30**, the day epoch 4.0 activated (burn 960,230),
against `SP000000000000000000002Q6VF78.pox-5` as a genuine mainnet boot contract —
no shim, no injected code.

### Run links

| Sim | stxer |
|---|---|
| lifecycle | https://stxer.xyz/simulations/mainnet/fa2a2ad771044759283343f3e89c8385 |
| late-claim | https://stxer.xyz/simulations/mainnet/57fb44a0b6e16b51d13f62cca3e13116 |
| lifecycle vs the **comment-stripped deploy template** | https://stxer.xyz/simulations/mainnet/ea7acfecf95c988b8561bcc9ddca9305 |

The third matters most before a deploy: it runs the full lifecycle against the
exact comment-stripped source shipped in
`faktory-dao/backend/server/utils/juice-pool-stx-signer-template.ts`, proving the
stripping changed nothing. Same result as the commented source —
`tranche-count = 2`, both tranches fully paid.

---

## `pool-stx-signer-lifecycle-sim.mjs` — full lifecycle

Deploy → register signer → real stakers stake → advance → rewards → two tranches
→ payouts with a deliberate hole.

Rewards are simulatable because pox-5 defines new rewards as
`(its own sBTC balance) - staked-sbtc - reserve`. So "rewards arrived" just means
sBTC landed in pox-5; the sim sends 1 sBTC from a real whale and
`calculate-rewards` distributes it by share exactly as mainnet does. 15% is
skimmed to reserve (`RESERVE_RATIO u1500`).

### Result: PASS

| Step | Outcome |
|---|---|
| deploy at chavita.btc (`SPV9K21…JDC22`), Clarity 5 | ok |
| `register-self` (grant + register, one tx) | ok, signer registered |
| 8 real `juice-pool-v0` stakers call pox-5 `stake` | all ok, `validate-stake!` fired |
| friedgerpool.btc — already staked with Fast Pool | **err u19 `ERR_ALREADY_STAKED`** |
| `propose-fee-bips` → 2,900 blocks → `confirm-fee-bips` | rate `u500` live |
| tranche 0 + tranche 1 opened | `tranche-count = 2` |
| tranche 0 paid 7/8, one staker withheld | `is-tranche-fully-paid t0` = false |
| `sweep-tranche-dust` on tranche 0 | **err u104 `ERR_TRANCHE_UNPAID`** |
| tranche 1 paid 8/8 | true — withheld staker paid normally |
| withheld staker back-filled in tranche 0 | paid; tranche 0 now complete |
| re-run payout over all 8 | no transfers — no double-pay |
| tranche 0 residue | 3 sats of dust |

**Tranches are independent.** A staker left unpaid in tranche 0 does not affect
tranche 1, is repairable later, and the only thing the hole blocks is that
tranche's dust sweep.

**Fee arithmetic is exact.** OG staked 238,300 STX → 2,051,215 sats. Non-OG
staked 112,612 STX → 920,864 sats. Scaled by stake, the non-OG would have had
969,332 fee-free, and `920,864 / 969,332 = 0.95000` — precisely the 5%, with the
OG paying nothing.

---

## `pool-stx-signer-late-claim-sim.mjs` — forgotten tranche

Claims cycle 141 tranche 0 on time, **deliberately skips tranche 1**, lets ~2
reward cycles pass, then claims and pays it late.

### Result: PASS

```
after skipping and advancing ~2 cycles:
  pox-5 reward cycle now        144
  last-claim-dist-cycle[141]    (some 283)    <- bookmark from tranche 0
  LATE pox-claim-rewards(141)   ok — 4,448,150 sats pulled in
  get-tranche-count             2
  tranche 1 pot                 4,447,126
  tranche 1 fully paid          true
```

Fee arithmetic still exact three cycles later: OG 1,869,764 on 238,300 STX;
non-OG 839,634 on 112,612 STX → ratio **0.9503**.

**Why it works.** pox-5 never expires unclaimed rewards
(`signer-unclaimed-rewards-for-cycle` only decrements on claim, no sweep window),
and `unstake` removes shares only from `current-cycle + 1` onward — so a closed
cycle's share history is immutable. Late claiming is therefore safe indefinitely,
and stakers who have since unstaked still get their final week.

### Edge case: a cycle can legitimately end with ONE tranche

**No money is ever missed by claiming late.** A claim pulls *everything* pox-5
has accumulated as unclaimed for that reward cycle — not one week's worth. So the
number of tranches depends on **when you claimed**, not on how much you are owed:

| What you did | Tranches | Total sats received |
|---|---|---|
| claimed both weeks on time | 2 | full |
| claimed week 1, forgot week 2, claimed later | 2 | full ← *simulated above* |
| forgot both, claimed once months later | **1** | **full** |

In the last row that single tranche holds **both** weeks' rewards. Same money,
fewer boxes. The per-staker split is still exact either way, because it divides
by cycle-141 shares, which are frozen once the cycle closes.

So the number of tranches carries **no information about whether you have been
paid everything**. Only `is-tranche-fully-paid` does, per tranche.

**What this breaks is tooling, not accounting:**

- a dashboard rendering "1 of 2 tranches paid" implies money is missing when none is
- a job waiting for `tranche-count == 2` before marking a cycle settled **hangs forever**
- a payout loop that *requires* tranches 0 and 1 to exist errors on a 1-tranche cycle

Correct pattern: read `get-tranche-count`, iterate `0 .. count-1`, and check
`is-tranche-fully-paid` for each. Right whether the cycle ended with one tranche or
two. Never hardcode 2 — even though pox-5 credits a cycle exactly twice, the
contract does not enforce that and does not depend on it.

---

## `pool-stx-signer-tranche-sim.mjs` — deploy + guards

Deploy and error-path checks with empty pots. Confirms the contract compiles and
deploys against real pox-5, and that guards fire:

### Result: PASS

| Check | Result |
|---|---|
| deploy at chavita.btc | ok |
| `confirm-fee-bips` before the 144-block cooldown | **err u114 `ERR_COOLDOWN`** |
| `propose-fee-bips` over cap | **err u110 `ERR_INVALID_FEE`** |
| `pox-claim-rewards` with nothing to claim | err — and `tranche-count` stays u0, no empty tranche |
| `withdraw-fees` with none earned | **err u111 `ERR_INSUFFICIENT_FEES`** |
| `sweep-tranche-dust` with no dust | **err u105 `ERR_NO_DUST`** |
| `propose-fee-bips` from non-admin | **err u100 `ERR_UNAUTHORIZED`** |

---

## `pool-stx-signer-sim.mjs` — superseded

The original, from before epoch 4.0. It had to **inject** pox-5 via
`addSetContractCode` because the contract did not exist on mainnet and an epoch
transition cannot be simulated by advancing blocks.

**Will not run as-is** — it still calls `get-cycle-paid`, `get-cycle-paid-shares`
and `get-cycle-residue`, which were renamed to `get-tranche-*` when the pot became
per-tranche. Kept only as a record of how pox-5 was simulated before activation;
use the lifecycle sim instead.

---

## Gotchas found while building these

- **`start-burn-ht` must be a real height inside the current reward cycle.**
  Passing `0` underflows `burn-height-to-reward-cycle` against
  `first-burnchain-block-height` and every stake fails with `ArithmeticUnderflow`.
- **Rewards credit the cycle containing `dist-boundary - 1`.** Advancing merely
  *into* cycle 141 is not enough — the first boundary there credits cycle 140.
  You need burn ≥ 963,200 for cycle 141.
- **`serializeCV` returns a hex string** in `@stacks/transactions` v7, not bytes.
- **`addAdvanceBlocks` takes an object**:
  `{ bitcoin_blocks, stacks_blocks_per_bitcoin }`.
- **`get-unclaimed-signer-rewards` reads u0 even when rewards are claimable.** It
  reflects pox-5's *settled* snapshot, not what a claim would pull. Do not drive a
  "rewards pending" UI or a claim-trigger cron off it — it reported u0 immediately
  before a claim that pulled 4.4M sats.
