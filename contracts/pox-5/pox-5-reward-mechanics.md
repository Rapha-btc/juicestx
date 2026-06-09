# PoX-5 Reward Mechanics — and verifying our assumptions

Findings from the `pox-wf-integration` source + the Bitcoin Staking whitepaper, focused on what
drives jBTC and jSTX economics. Companion to [`pox-5-open-questions.md`](./pox-5-open-questions.md)
(what's still open) and [`migration-jstx-to-pox5.md`](./migration-jstx-to-pox5.md).

---

## The reward waterfall (per distribution)

`calculate-rewards` + `calculate-bond-rewards` (pox-5.clar:1764, 1850). Each distribution starts
from newly-accrued sBTC:

```
accrued = sbtc-balance(pox-5) − total-sbtc-staked − reserve-balance − last-accounted   (get-new-rewards, :1755)
```

then pays out in strict priority:

```
1. BONDS (jBTC)  ── fixed, priority ───────────────────────────────────
   per bond:  target-yield = total-sats × target-rate / 10000 / 50
   earned     = min(available, target-yield)          ← gets its target if funds allow
   paid in sorted order (stx-value-ratio, then index); each bond drains `available`
        │  remaining = accrued − Σ earned
        ▼
2. RESERVE  ── 15% of the remainder ───────────────────────────────────
   new-reserve = remaining × RESERVE_RATIO(1500) / 10000
        │
        ▼
3. STX-ONLY (jSTX)  ── residual, variable ─────────────────────────────
   stx-staker-rewards = remaining − new-reserve        ← the other 85% of the remainder
   if no STX stakers this cycle → that 85% ALSO folds into the reserve
```

- `target-rate` is the bond's APY in bps; the `/50` spreads it across ~50 distributions/year.
- Bonds are paid **first and at a fixed target**, off the top.
- Define **`remaining = accrued − Σ(bond payouts)`** — the one pool left after bonds. **Both** the
  reserve and STX-only draw from `remaining`: the reserve takes **15% of `remaining`**, STX-only
  gets the **other 85% of `remaining`**. Bonds never touch this pool.

**Plain numbers** — a distribution brings in 100 sBTC, bonds' fixed target totals 60:

| Step | Who | Gets | Left |
|---|---|---|---|
| 1 | Bonds (jBTC), fixed, first | 60 | `remaining = 40` |
| 2 | Reserve, 15% of `remaining` | 0.15 × 40 = **6** | 34 |
| 3 | STX-only (jSTX), the rest | 40 − 6 = **34** (85%) | 0 |

If **no STX stakers**, step-3's 34 also folds into the reserve. If **bonds' target > accrued**,
bonds drain it all (`remaining = 0`) and both reserve and STX-only get 0.

## What it means for the two products

| | **jBTC** (bonds, Tranche 1) | **jSTX** (STX-only, Tranche 3) |
|---|---|---|
| Rate | **Fixed** target-rate, **priority** | **Residual / variable** (can be ~0) |
| Reserve 15% | **Not haircut** — bonds paid before reserve | Funds the reserve (the 15% + stranded cut come off the STX side) |
| Backstop | Reserve exists to top up the fixed bond rate | None — eats shortfalls |

**Key correction to our earlier worry:** the 15% reserve does **not** haircut jBTC's APY. jBTC is the
*protected* tranche (fixed, priority, reserve-backstopped). The reserve and the variability land on
**jSTX**, the residual tranche.

---

## Verifying the assumptions

### ✅ "Split jBTC vs jSTX rewards — is there a callback?"
**No callback needed — `claim-rewards`'s return value already carries the split.** It returns:
```clarity
(ok { stx-rewards: { earned: uint, … },   ;; jSTX side
      bond-rewards: (list …),
      bond-totals: uint,                   ;; jBTC side (sum of bond payouts)
      total-rewards: uint })
```
So the signer-manager captures the result and routes: **jBTC reward index ← `bond-totals`**,
**jSTX reward index ← `(get earned stx-rewards)`**. For a read-only pre-claim estimate, use
`get-earned(signer, is-bond, index)` (`:1945`) per category. (Caveat: bonds + STX-only are still
*paid out* in one sBTC transfer to the signer; we split the already-received lump by these figures.)

### ⚠️ "The 15% reserve is a backstop tranche for the fixed rate" — right idea, two corrections
- **True:** the reserve exists to support the **fixed** rate paid to bonds; whitepaper says it
  *"drains upward to plug Tranche 1's gap, and once empty, stakers eat the shortfall."*
- **Correction 1 — numbering:** the **reserve is Tranche 2**, and **STX-only stakers are Tranche 3**
  (the residual). (We'd called the reserve "tranche 3".)
- **Correction 2 — funding:** it's funded from **15% of the post-bond remainder** (i.e. off the
  **jSTX/STX-only** side), not off jBTC.
- **Open caveat:** the *upward drain* (reserve topping up a short bond) is **not visible in
  `calculate-bond-rewards`** — `accrued` excludes the reserve (`get-rewards` subtracts it), and a
  short bond just gets `earned = available`. So in this WIP the reserve **accumulates** but the
  draw-down path isn't in the code we read → flagged for Brice.

### ✅ "Instant sBTC redemption is intentional; STX can't be withdrawn anytime"
Confirmed in code:
- **jBTC:** `unstake-sbtc` has **no time-lock** — we can pull sBTC out of pox-5 on a user's behalf
  any time and hand it over. The **paired STX is the protocol's** (the 5% reserve STX) and stays
  term-locked, so a redemption doesn't force us to unwind the whole staker. Exactly the LST
  flexibility you described.
- **jSTX:** STX is term-locked (node-side, until the stake's `num-cycles` end), so it **cannot** be
  withdrawn on demand → jSTX keeps the **withdrawal-NFT queue** (`redeem-stx-nft`, the stSTXbtc
  pattern). Asymmetry by design: jBTC redeems instantly, jSTX queues to the next unlock.

### ✅ "The rest is answerable from whitepaper + code" — yes
- **STX unlock schedule:** code — bond = `BOND_LENGTH_CYCLES` (12), stake = `num-cycles`; unlock at
  term end (node-side performs the lock/unlock, PR #7062).
- **Reward cadence:** external sBTC transfer in; `calculate-rewards` runs per distribution cycle
  (~50/yr); bonds ~6 months (whitepaper).
- **Signer vs key:** code — `register-signer` (contract = on-chain signer) + `signer-key` (node's
  block-signing key) linked by `grant-signer-key`.
- **Rollover window:** code — `get-bond-l1-unlock-height` (`:2677`); applies to sBTC bonds too.
- **Concentration:** code has the `SIGNER_SET_MIN_USTX` (50k) **floor**; no on-chain **max** weight
  per signer found → anti-concentration is policy/allowlist (the managed bootstrap), which is itself
  the argument for multi-signer.

---

## Consequences for the build

1. **Two reward indices, fed from one claim** — `juice-signer-manager.claim-rewards` captures the
   `claim-rewards` result and forwards `bond-totals` → jBTC engine, `stx-rewards.earned` → jSTX
   engine. (No per-product pox-5 claim; we split the lump.)
2. **jBTC = fixed-rate product**, jSTX = variable/residual — set user expectations accordingly; jSTX
   yield can approach zero in lean cycles.
3. **jBTC instant redemption** via `unstake-sbtc`; **jSTX queued** via a withdrawal NFT.
4. The reserve is a pox-5-level construct (Tranche 2); Juice doesn't manage it, but jSTX's headline
   rate is net of it.

*Open items remain in [`pox-5-open-questions.md`](./pox-5-open-questions.md) — chiefly the reserve
draw-down path and per-cycle split rounding.*
