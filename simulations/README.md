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
| lifecycle (incl. dust sweep + full fee drain) | https://stxer.xyz/simulations/mainnet/af4d7530ea3a20f8b8ebca40a435c2ff |
| guards (pause / anti-griefing / callback / admin gates) | https://stxer.xyz/simulations/mainnet/27987e188876ab5b0f0117b89adaa6b0 |
| coverage (tier 2 + 3) | https://stxer.xyz/simulations/mainnet/9270a2d58fb72cb86d0aa228a0bc6fe5 |
| late-claim | https://stxer.xyz/simulations/mainnet/57fb44a0b6e16b51d13f62cca3e13116 |
| lifecycle vs the **comment-stripped deploy template** | https://stxer.xyz/simulations/mainnet/b6c92c03ea444126c1b3d1842b297593 |
| lifecycle (earlier run, before sweep coverage) | https://stxer.xyz/simulations/mainnet/fa2a2ad771044759283343f3e89c8385 |

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
| tranche 0 residue | 4 sats of dust |
| `sweep-tranche-dust` t0, now fully paid | **ok — 4 sats to admin** |
| residue after sweep | u0 |
| `sweep-tranche-dust` t0 again | **err u105 `ERR_NO_DUST`** |
| `sweep-tranche-dust` t1 | ok — 4 sats |
| `withdraw-fees` 1 sBTC | **err u111 `ERR_INSUFFICIENT_FEES`**, fees unchanged |
| `withdraw-all-fees` | ok — drained 184,774 |
| earned-fees after drain | u0 |

**The dust guard discriminates in both directions.** Earlier in the same run it
refused to sweep tranche 0 with `err u104` while a staker was unpaid — the
residue was 325,487 sats, of which 325,483 belonged to that staker and only 4
were genuine rounding dust. After the back-fill it swept exactly those 4.

> **Finding:** `withdraw-all-fees` on an empty balance returns **`err u3`** (the
> sBTC token rejecting a zero-amount transfer), not a clean `ok u0`. Nothing
> moves and nothing breaks, but a retry-on-failure cron would read it as a real
> error. Worth an `(is-eq amount u0)` early return.

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

## `pool-stx-signer-guards-sim.mjs` — safety mechanisms

The lifecycle sim proves the happy path. This one proves the things that must
*refuse*. Every one of these was untested until 2026-07-30.

### Result: PASS

| Guard | Result |
|---|---|
| claim twice in the SAME distribution cycle | **err u112 `ERR_TRANCHE_TOO_SOON`**, `tranche-count` stays u1 |
| ...even with fresh rewards waiting | **still err u112** — it is a rate limit, not a "nothing to claim" check |
| `set-paused true`, then a new `stake` | **err u101 `ERR_PAUSED`** — the staker's pox-5 tx reverts |
| signer shares after the paused attempt | unchanged — the stake really was rejected |
| `set-paused false`, same staker retries | ok, `validate-stake!` fires |
| `validate-stake!` called directly | **err u102 `ERR_NOT_POX5`** |
| `withdraw-fees` from non-admin | **err u100 `ERR_UNAUTHORIZED`** |
| `withdraw-all-fees` from non-admin | **err u100 `ERR_UNAUTHORIZED`** |
| `sweep-tranche-dust` from non-admin | **err u100** |
| `set-og` / `set-paused` / `set-admin` from non-admin | **err u100** |
| admin + earned-fees after all refusals | unchanged |

**Why the admin gates are tested here specifically.** `withdraw-fees` was
refactored into a wrapper plus a private `do-withdraw-fees` when
`withdraw-all-fees` was added, which **moved `assert-admin`**. A refactor that
relocates an auth check is exactly the kind that drops it on the new path, and
every other sim calls these as the deployer — who *is* the admin — so the
refusal path would never have been exercised. It holds: both entry points
refuse, and neither the admin nor `earned-fees` moves.

**Why the anti-griefing test matters.** `ERR_TRANCHE_TOO_SOON` is the entire
point of `last-claim-dist-cycle`. Dropping the old cycle-ended gate is what
enables weekly payouts, but it left claiming callable at any moment by anyone;
without this limit a griefer could open dozens of dust tranches, each costing a
full payout pass over every staker. The second case is the meaningful one — the
gate holds *even when there is money waiting*, confirming it limits frequency
rather than merely rejecting empty claims.

**Why the pause test matters.** `validate-stake!` is pox-5's admission callback,
and returning `err` from it reverts the staker's transaction **inside pox-5**.
That is the only mechanism you have to stop new inflow. The sim confirms the
error propagates all the way out to the user's `stake` call rather than being
swallowed, and that shares genuinely do not move.

---

## `pool-stx-signer-coverage-sim.mjs` — tier 2 + 3

The money-correctness claims we had asserted from reading pox-5 but never
demonstrated, plus the remaining unexercised entry points.

### Result: PASS

**A staker who unstakes mid-cycle still gets paid for that cycle.** The claim in
the late-claim section, now demonstrated rather than reasoned:

| | |
|---|---|
| leaver's cycle-141 shares before `unstake` | 112,612,000,000 |
| ...after `unstake` | **112,612,000,000 — unchanged** |
| leaver's cycle-**142** shares | u0 — gone from future cycles |
| paying the leaver for cycle 141 afterwards | ok — **813,979 sats transferred** |

So `unstake` only strips shares from `current-cycle + 1` onward, exactly as
pox-5's source implies. A departed staker keeps every tranche of the cycle they
were in, and your payout list must still include them.

**Bad lists are handled safely:**

| Case | Result |
|---|---|
| same staker twice in ONE list `[alice, alice, X]` | paid **once** (1,813,128), one transfer |
| `tranche-paid-shares` after that call | counted alice **once** |
| principal that never staked | **none** — skipped, not paid |

Idempotency was already proven *across* calls; this proves it *within* one.

**Remaining entry points:**

| Check | Result |
|---|---|
| `cancel-fee-bips` after a proposal | ok — pending cleared to `none` |
| `confirm-fee-bips` with nothing pending | **err u113 `ERR_NO_PENDING_FEE`** |
| live fee after a cancelled proposal | unchanged at u500 |
| `pox-settle-stakers` (all 8) | ok |
| `get-cycle-total-shares` on an unstaked cycle | u0 |
| `pay-stx-stakers` on that cycle | ok — no divide-by-zero |
| `set-admin` rotation | new admin set |
| OLD admin calls `set-og` after rotation | **err u100 `ERR_UNAUTHORIZED`** |
| NEW admin calls `set-og` | ok — write landed |

> **Usage note, not a defect.** `is-tranche-fully-paid` returns **true** for a
> cycle nobody staked (`0 >= 0`). It answers *"is anyone still owed?"* — and for
> such a cycle, no one is. That is a different question from *"did this cycle
> happen and settle?"*, which needs `get-tranche-count > 0` alongside it.
> **No money path is affected:** `sweep-tranche-dust` also requires `dust > u0`,
> which is zero for a cycle that never existed, so `ERR_NO_DUST` blocks it
> regardless. The vacuous `true` can never let sats out.

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
- **`addAdvanceBlocks` takes an object** (see above).

---

## `get-unclaimed-signer-rewards` reads u0 while rewards ARE claimable

Seen live at **step 25 of the lifecycle sim**: the read-only returned `u0`, and
the very next step claimed ~4.8M sats. This is not a bug in either contract, and
it is the single most likely thing to mislead whoever writes the payout cron.

### Why

`get-unclaimed-signer-rewards` passes through to pox-5's
`get-signer-unclaimed-rewards-for-cycle`, which reads a **map**. That map is only
ever written by `update-claimable-rewards` and `settle-rewards`.

`calculate-rewards` writes **neither**. It only advances the pool-wide
rewards-per-token accumulator. So after it runs, your entitlement exists as
*"accumulator minus your last settled watermark"* — a computation, not a stored
number. Nothing has written your row yet, so the map still reads zero.

The claim then works because pox-5's `claim-rewards` materialises the row as its
very first binding, before paying:

```clarity
(signer contract-caller)
(stx-rewards (update-claimable-rewards signer reward-cycle none))
```

So the read-only says zero right up to the instant the claim computes the real
figure.

### What it actually answers

> "How much has been **settled** and not yet claimed?"

Which is a different question from "what would a claim pull right now?". Both are
legitimate; only the second one is what a payout job wants.

### Do not

- render a "rewards pending" badge from it — it shows nothing while money waits
- gate a claim-trigger cron on `> u0` — **the cron would never fire**, because
  the value only becomes non-zero *after* a claim has already settled the row

### Instead

- **just attempt the claim.** It fails harmlessly with pox-5's `err u32`
  (`ERR_NO_CLAIMABLE_REWARDS`) when there is genuinely nothing, and a failed
  attempt does not consume the distribution cycle's slot — the bookmark is only
  written on success.
- or infer it from the clock: compare pox-5's `current-distribution-cycle`
  against our `get-last-claim-dist-cycle` for that reward cycle. If the global
  clock has moved past the bookmark, a claim is due.

---

## Coverage: what is still NOT simulated

Tiers 1-3 are now covered by the guards and coverage sims. What remains:

- **`ERR_SETTLE_FAILED`** — requires pox-5's `claim-staker-rewards-for-signer`
  to fail for a staker in the batch, which needs a state we have not found a way
  to produce against the real contract.
- **Batch limits.** Every payout runs well under the 100-staker list bound; the
  block-cost ceiling at a full 100 is untested, and the contract's own comment
  says the bound is "a starting point, NOT a measured limit".
- **Multi-signer interference** — another signer claiming and paying in the same
  blocks. All sims run our signer in isolation.
- **`withdraw-all-fees` on an empty balance** returns `err u3` rather than a
  clean `ok u0` (see the lifecycle finding). Recorded, not fixed.

Note `validate-stake!` fires on every stake in all sims; what the guards sim adds
is coverage of its two *refusal* paths.
