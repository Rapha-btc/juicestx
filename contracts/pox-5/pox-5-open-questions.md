# PoX-5 — Open Questions (Juice integration)

Questions that came up while scaffolding `juice-signer-manager` + `juice-staker` against the
WIP source:
[`stacks-core@pox-wf-integration` · `boot/pox-5.clar`](https://github.com/stacks-network/stacks-core/blob/pox-wf-integration/stackslib/src/chainstate/stacks/boot/pox-5.clar).

Part 1 is what the source already answers (so we don't re-ask). Part 2 is for Brice / the pox-5
authors — the parts that change how jBTC + jSTX must be built and that the Clarity source alone
doesn't settle (some live in the node-side handler / PR [#7062](https://github.com/stacks-network/stacks-core/pull/7062)).

---

## Part 1 — Answered from the source (confirmed)

1. **STX is not locked by this contract.** Neither `register-for-bond` nor `stake` transfers/locks
   STX; they only validate balance. The comment is explicit: *"the node-side handler extends that
   lock."* So STX locking lives in the node (PR #7062), not the boot contract.
2. **There is a 15% reserve.** `RESERVE_RATIO = u1500` (15%). Reward calc takes a reserve cut;
   STX-only stakers receive the remainder, and if there are no STX-only stakers that cycle their
   portion folds into the reserve. **No separate reward rate** — bonds and STX-only both earn
   proportional to shares.
3. **sBTC has no withdrawal lock.** `unstake-sbtc` checks only: caller == current signer,
   membership is sBTC-backed (not L1), and amount <= staked. **No bond-term/time check** — custodied
   sBTC can be pulled mid-bond.
4. **Rewards are claimed bundled.** `claim-rewards` sums STX-only rewards + bond rewards and sends
   **one** sBTC transfer to the signer. Nothing separates the two on-chain.
5. **Reward sBTC is funded by external transfer.** Distributable rewards =
   `sbtc-balance(contract) − total-sbtc-staked − reserve-balance`. The contract neither mints nor
   has an admin-deposit fn — some external actor must transfer sBTC in.

---

## Part 2 — Open questions for the authors

### A. Reward attribution — splitting one bundled claim across two tokens *(highest impact)*
`claim-rewards` pays the signer **one** sBTC amount covering *both* its bond positions (jBTC) and
its STX-only stakes (jSTX). But jBTC and jSTX need **separate reward indices** (different supplies,
different token).
- Is the intended pattern to read `get-earned(signer, true, bond-index)` vs
  `get-earned(signer, false, index)` **before** claiming and split the payout by those proportions?
- Any rounding / settle-timing pitfalls that would make that split drift from what was actually
  paid? Is there (or could there be) a way to claim bond-only or STX-only separately?

### B. The 15% reserve — whose 15%, and what's the net yield?
- Does `RESERVE_RATIO` (15%) come off the top of **pooled stakers'** rewards, i.e. is it effectively
  a protocol-level haircut on jBTC/jSTX APY?
- Is it **on top of** any signer/operator fee, or the only cut?
- Who can withdraw `reserve-balance`, and what is it for (insurance, ops, slashing buffer)?
- Net: for a pooled LST, what BTC APY survives after reserve + signer fee? (This sets jBTC's
  headline rate.)

### C. sBTC liquidity — no lock, so what's the model?
Confirmed `unstake-sbtc` has no time-lock. For jBTC this is big — it implies **sBTC is liquid, only
the STX leg is term-locked.**
- Is that the intended model (instant sBTC redemption, STX termed)?
- Does pulling sBTC mid-bond **forfeit** that position's accrued/future rewards, and does it drop the
  signer's weight immediately?
- Reward calc is `balance − staked − reserve`. Can a staker grief by unstaking sBTC right after a
  reward batch lands (changing balances mid-cycle), or does `settle-rewards` snapshot protect that?

### D. STX locking & unlock schedule (node-side / PR #7062)
Since the boot contract doesn't lock STX:
- Exactly **when** does the node lock the staker's STX — same tx as `register-for-bond`/`stake`, or
  a later block? And exactly `amount-ustx` of that principal's **liquid** STX?
- **Unlock schedule:** does it unlock at bond end (12 cycles)? Partial unlocks? For STX-only, at
  `num-cycles` end?
- Is locking automatic, or must the keeper send a separate node-level tx? (We need this to know
  what the keeper does and what the treasury must keep liquid.)

### E. sBTC reward funding — who, when, how attributed
Rewards = `balance − staked − reserve`, funded by an external transfer.
- **Who** transfers the sBTC yield into pox-5, and on **what cadence** (per cycle? per bond)?
- How is a single transfer attributed across signers — purely by the rewards-per-token settle on
  `signer-shares-staked-for-cycle`?
- **Timing:** at what point in a cycle can a signer first `claim-rewards` for that cycle?

### F. Signer identity vs signing key (decentralization)
The signer is a **contract** (`signer-manager` principal), but `signer-key` is a 33-byte secp256k1
pubkey.
- Confirm: the contract is the **on-chain identity**, and `signer-key` is the **node's
  block-signing key** (operator holds the privkey), linked via `grant-signer-key`?
- For independent-operator decentralization, is the model "each operator runs a node with their own
  `signer-key` **and** their own `signer-manager` contract"? Anything stopping N independent
  operators from each registering their own signer-manager?

### G. The signer-manager trait contract
- What **must** `validate-stake!` enforce vs. leave to the operator? Is there a reference
  implementation, or a minimum (e.g. must it ever reject)?
- `checkpoint-staker` is called inside a `match` that ignores its error on unstake — confirm it's
  purely advisory (can never block an exit) and document exactly when it fires.

### H. Rollover window for **sBTC** bonds
`verify-bond-rollover-window` gates on `get-bond-l1-unlock-height` — an **L1-derived** height — even
for sBTC bonds where `is-l1-lock = false` and there's no L1 collateral.
- For an sBTC-custody bond, does the same L1-derived window govern when it can roll into bond N+6 /
  exit? When exactly is that window for a pure-sBTC position?

### I. Caps
- Any cap on **stakers per signer**, or on **signers in the set** per cycle
  (`add-signer-to-set-for-cycle` is a per-cycle linked list)?
- Beyond `SIGNER_SET_MIN_USTX` (50k STX), is there a **max** weight per signer (an
  anti-concentration cap) — which would itself force the multi-signer design?

### J. Bond availability & the allowlist *(cross-ref)*
- How frequently are bonds created, and how do we guarantee a staker is allowlisted **before** a
  bond's start height so we can ladder continuously? (Access details in
  [`jbtc-pox5-bond-requirements.md`](./jbtc-pox5-bond-requirements.md) §A — still the gating blocker.)

---

*Derived from the `pox-wf-integration` source as of this writing; constants and behavior may change
before mainnet.*
