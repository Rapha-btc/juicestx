# PoX-5 — our understanding, please confirm or correct

Working through jBTC + jSTX on PoX-5, we read most of our answers out of the
[`pox-wf-integration` source](https://github.com/stacks-network/stacks-core/blob/pox-wf-integration/stackslib/src/chainstate/stacks/boot/pox-5.clar)
+ the [Bitcoin Staking whitepaper](https://forum.stacks.org/t/the-bitcoin-staking-whitepaper/18834).
So this is **what we believe is true** with the evidence, and the specific points where we'd like a
✅ or a correction. A few are still genuinely open (last section). Reward-math detail lives in
[`pox-5-reward-mechanics.md`](./pox-5-reward-mechanics.md).

---

## Our understanding — confirm or correct

### 1. Splitting one bundled claim across the two tokens
**Our read:** No callback is needed — `claim-rewards`'s **return value** carries the split:
`bond-totals` (the jBTC/bonds slice) and `stx-rewards.earned` (the jSTX/STX-only slice). We claim
the lump and route each slice to its token's reward index; `get-earned(signer, is-bond, index)` gives
a pre-claim read.
**Confirm?** Is splitting by the returned `bond-totals` / `stx-rewards.earned` the intended
attribution, with no rounding drift vs. the sBTC actually transferred?

### 2. The 15% reserve and jBTC's fixed rate
**Our read:** Bonds are paid their fixed `target-rate` **first, off the top**
(`calculate-bond-rewards`: `earned = min(available, target-yield)`). The reserve then takes **15% of
the remainder**, and STX-only (jSTX) gets the other 85%. So **the 15% reserve does not haircut
jBTC** — it comes off the jSTX side. The reserve (Tranche 2) exists to backstop the fixed bond rate;
STX-only stakers are Tranche 3 (residual, can be ~0).
**Confirm?** (a) jBTC's headline rate = the bond's `target-rate`, net only of any operator fee (not
the 15%)? (b) The reserve's **upward draw-down** (topping up a short bond) isn't visible in
`calculate-bond-rewards` — `accrued` excludes the reserve. Is the top-up implemented elsewhere /
coming, or do lean cycles simply underpay bonds until the reserve is separately injected?

### 3. sBTC is liquid, STX is termed
**Our read:** `unstake-sbtc` has **no time-lock**, so custodied sBTC is redeemable any time, while
STX stays term-locked. We read this as intentional: jBTC offers **instant sBTC redemption** (we pull
from pox-5 on a user's behalf), jSTX uses a **withdrawal-NFT queue** to the next unlock.
**Confirm?** Does pulling sBTC mid-bond **forfeit** that position's accrued/future rewards and drop
the signer's weight immediately? And does `settle-rewards`' snapshot stop a "unstake right after a
reward batch lands" grief against the `balance − staked − reserve` reward calc?

### 4. STX locking is node-side
**Our read:** The boot contract doesn't lock STX (it only validates balance); the **node-side
handler** does (PR [#7062](https://github.com/stacks-network/stacks-core/pull/7062)). Term = 12
cycles for a bond / `num-cycles` for a stake; unlock at the computed `unlock-cycle` (the cycle math
is in-contract).
**Confirm?** When exactly does the node lock — same tx as `register-for-bond`/`stake`, or a later
block — and is it automatic or a separate keeper tx? Exactly `amount-ustx` of the staker's liquid
STX, unlocking all-at-once at term end?

### 5. Reward sBTC is funded externally
**Our read:** Distributable rewards = `sbtc-balance(pox-5) − total-sbtc-staked − reserve-balance`;
an external actor transfers the yield sBTC in (no mint / admin-deposit fn in the contract).
`calculate-rewards` runs per distribution cycle, and `target-yield = … / 50` implies ~50
distributions/year.
**Confirm?** **Who** transfers the yield sBTC in, and on **what cadence**? Is per-signer attribution
purely the rewards-per-token settle on `signer-shares-staked-for-cycle`? Earliest point a signer can
`claim-rewards` for cycle N?

### 6. Signer = contract identity; signer-key = the node's signing key
**Our read:** The signer is the **`signer-manager` contract principal** (on-chain identity);
`signer-key` (33-byte secp256k1) is the **node's block-signing key**, linked via `grant-signer-key`
(signed by that key). So an independent operator = their own node + their own `signer-key` + their
own `signer-manager`.
**Confirm?** Anything preventing N independent operators from each registering their own
signer-manager, with Juice spreading capital across them to decentralize signing power?

### 7. The signer-manager trait
**Our read:** `validate-stake!` is the admission gate — returning `err` reverts the stake;
`checkpoint-staker` is advisory (pox-5 calls it inside a `match` that ignores its error, so it can't
block an exit).
**Confirm?** Is there a minimum `validate-stake!` must enforce, or a reference implementation?
Exactly when does `checkpoint-staker` fire?

### 8. Rollover window applies to sBTC bonds too
**Our read:** `verify-bond-rollover-window` gates on `get-bond-l1-unlock-height` (½ cycle before bond
end) **even for sBTC bonds** (`is-l1-lock = false`). So an sBTC bond can roll into N+6 only in that
last-½-cycle window.
**Confirm?** Correct that the L1-derived window also governs pure-sBTC positions?

### 9. Bond cadence and concentration
**Our read:** Bonds are spaced `BOND_GAP_CYCLES` = 2 cycles apart and run `BOND_LENGTH_CYCLES` = 12
(cadence is in-contract). The signer floor is `SIGNER_SET_MIN_USTX` = 50k STX; we found **no on-chain
max** weight per signer.
**Confirm?** (a) How often does `bond-admin` actually **create** bonds — every 2-cycle slot, or
sparser? (b) Is there really no max-weight-per-signer cap (i.e. anti-concentration is purely
allowlist policy)?

---

## Still genuinely open

- **The reserve upward draw-down** (2b) — accumulation is in the code; the top-up of a short bond is
  not, in the path we read.
- **Who funds the reward sBTC, and the exact cadence** (5).
- **Bond-admin allowlist access** — the real gating blocker; details in
  [`jbtc-pox5-bond-requirements.md`](./jbtc-pox5-bond-requirements.md) §A (who holds `bond-admin`,
  what gets a pool listed, `max-sats` per operator).

*Derived from the `pox-wf-integration` source; constants/behaviour may change before mainnet.*
