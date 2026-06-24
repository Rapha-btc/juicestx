# jSTX (pox-4) vs StackingDAO ststxbtc — architecture map & review

**Purpose of this doc.** Map the jSTX pox-4 contracts end-to-end (the "circle": deposit →
allocate → stack → earn sBTC → withdraw), line them up against StackingDAO's `ststxbtc` suite
(the exact same product — *stack STX, earn sBTC*), and pin down the **two routing seams** that
were still open when the per-contract review paused. Read this before swapping the stacking
layer for pox-5; the seams below are the same ones the pox-5 rebuild has to resolve.

> jSTX and ststxbtc solve the identical problem with the identical reward engine
> (cumulative-index sBTC distribution). The differences are deliberate simplifications plus
> one safety addition (time-vesting). Where they diverge is called out explicitly.

---

## 1. The jSTX circle — who does each step

```
                         ┌─────────────────────────────────────────────┐
  USER ── deposit STX ──▶│ core.deposit                                │
                         │  • fees.pay → fee skim                       │
                         │  • vault.receive  (STX custody)             │
                         │  • jstx-token.mint  (1:1, no rebase)        │
                         │  • delegation.assign  (user picks routing)  │
                         │  • pending-ustx-per-cycle[cycle] += net     │
                         └─────────────────────────────────────────────┘
                                          │  [keeper, once per cycle]
                                          ▼
                         ┌─────────────────────────────────────────────┐
                         │ allocation.execute-allocation (per stacker) │
                         │  • target = registry weight ⊕ delegation    │
                         │  • vault.release → stacker  (STX moves)     │
                         └─────────────────────────────────────────────┘
                                          │  [keeper / signer]
                                          ▼   ⚠ SEAM 1 (pool↔stacker delegation)
                         ┌─────────────────────────────────────────────┐
                         │ stacker.delegate-stx  → pox-4.delegate-stx  │
                         │ pool.lock-delegated-stx → delegate-stack-stx│
                         │ pool.finalize-cycle → agg-commit-indexed    │
                         └─────────────────────────────────────────────┘
                                          │  BTC paid to pool.btc-address
                                          │  Emily mints sBTC INTO stacker
                                          ▼   [keeper, cycle N+1]
                         ┌─────────────────────────────────────────────┐
                         │ yield.sweep-stacker                          │
                         │  • stacker.release-rewards (pays signer fee)│
                         │  • protocol fee → commission bucket          │
                         │  • net → reward-bucket[cycle], vest 2100 blk│
                         └─────────────────────────────────────────────┘
                                          │  on every jSTX transfer/mint/burn/claim
                                          ▼
                         ┌─────────────────────────────────────────────┐
                         │ yield.settle-wallet  (via jstx-token hook)  │
                         │  • apply-vested → share-data.global-index   │
                         │  • pay pending sBTC, snapshot wallet         │
                         └─────────────────────────────────────────────┘

  WITHDRAW:  core.start-withdraw → redeem-stx-nft (unlock height)
             … wait for cycle unlock …
             core.finalize-withdraw → burn NFT + jSTX, vault.release STX
```

---

## 2. Contract-by-contract map vs ststxbtc

| jSTX (this repo) | role in the circle | ststxbtc equivalent | notes on the difference |
|---|---|---|---|
| `core.clar` | user entry: deposit / start-withdraw / finalize / withdraw-pending | `stacking-dao-core-v6` | jSTX is **1:1 fixed** (mint = net STX). ststxbtc mints at an exchange rate. jSTX `withdraw-pending` ≈ ststxbtc `withdraw-idle` (both 1% anti-gaming fee). |
| `vault.clar` | holds all STX, reserve accounting | `reserve-v1` | Same job. jSTX `reserve`/`unreserve` ≈ ststxbtc `lock-stx-for-withdrawal`. |
| `jstx-token.clar` | SIP-010, settles on every balance change | `ststxbtc-token-v2` | Same hook pattern (settle-before-balance-change). jSTX 6 decimals (STX), ststxbtc 6 decimals. |
| `yield.clar` | sBTC reward engine + distribution | `ststxbtc-tracking-v2` | **Same cumulative-index core**, but jSTX **adds linear vesting over 2100 blocks**; ststxbtc bumps the index instantly. See §4. |
| `share-data.clar` | reward index state (global-index, snapshots) | `ststxbtc-tracking-data-v2` | Same data/logic split. jSTX `global-index` ≈ ststxbtc `cumm-reward`; both scale `1e10`. jSTX snapshots `{index,balance}` ≈ ststxbtc `holder-position {amount,cumm-reward}`. |
| `commission.clar` + `treasury.clar` | protocol fee routing | `commission-v2` | ststxbtc enforces ≥70% to stakers; jSTX splits signer-fee (paid by stacker) vs protocol-fee (to treasury). |
| `pool.clar` (1/signer) | PoX touchpoint: lock/extend/increase/finalize, signer key + btc-addr | *(external `.stacker-1..10` + `strategy-v3`)* | **jSTX makes this first-class; ststxbtc hides it.** This is where Seam 1 lives. |
| `stacker.clar` (N/signer) | thin STX+sBTC holder, self-delegates, releases rewards | *(external `.stacker-1..10`)* | Same "thin holder" idea as StackingDAO stackers. |
| `registry.clar` | signer directory + weights | `data-pools-v1` | Holds **two** weight concepts (`signer-allocation` and `delegate-allocation`). Seam 2 lives here. |
| `allocation.clar` | spread vault STX → stackers by target | `strategy-v3-pools-v1` + `strategy-v3` | Port of StackingDAO's blended target math. |
| `delegation.clar` | track user's chosen routing | `direct-helpers-v4` + `data-direct-stacking-v1` | Port of direct-stacking bookkeeping. Seam 2 also lives here. |
| `redeem-stx-nft.clar` | withdrawal receipt NFT + marketplace | `ststx-withdraw-nft-v2` | Same — tradeable early-exit ticket. |
| `fees-none.clar` | zero-fee impl (swap later) | *(fees inline in core-v6)* | jSTX externalizes fee logic behind `fees-trait`. |
| `position-zest.clar` | DeFi adapter (jSTX collateral still earns) | `position-trait` + supported-positions | Same idea; ststxbtc has the richer supported-positions registry. |
| `dao.clar` | allowlist / admin / kill-switch | `dao.clar` | Same trust root. jSTX uses `check-is-authorized` (contract-caller) like ststxbtc `check-is-protocol`. |
| — | exchange-rate / appreciation carve-out | `data-core-v1/v2/v3` | **No jSTX equivalent — intentionally.** jSTX never appreciates (yield is pure sBTC), so there is no STX-per-token ratio to compute. This whole sub-system is dropped. |

**Net:** every essential ststxbtc contract has a jSTX counterpart **except** `data-core` (dropped on
purpose) — and jSTX *adds* the explicit `pool`/`stacker`/`registry`/`allocation` layer that StackingDAO
keeps off-chain in its strategy contracts. So the jSTX circle is complete on paper. The gaps are in the
**wiring between** those added contracts, not in any missing contract.

---

## 3. The deliberate divergences (not bugs)

1. **1:1 fixed, no rebase, no exchange rate.** jSTX mints exactly the net STX deposited and yield is
   paid as separate sBTC. ststxbtc mints at `stx-per-ststx`. This is why `data-core` and the whole
   ratio carve-out (`- total-stx ststxbtc-supply`) have no jSTX analog.
2. **Time-vesting on rewards.** `yield.clar` vests each cycle's sBTC linearly over `VESTING_BLOCKS`
   (2100). ststxbtc-tracking-v2 has **no** vesting — `add-rewards` bumps `cumm-reward` instantly and
   relies solely on settle-before-balance-change. jSTX keeps that same protection **and** adds vesting.
3. **Explicit signer plumbing on-chain.** `pool` + `stacker` + `registry` + `allocation` are real
   contracts; StackingDAO runs the equivalent as `strategy-v3` orchestration over opaque `.stacker-N`
   principals. More transparent, but it means the per-cycle stacking sequence is jSTX's to drive.

---

## 4. Reward-engine equivalence (so the swap preserves it)

Both are MasterChef/Synthetix cumulative-index-with-debt, scaled `1e10`:

```
ststxbtc:  reward-per-token += amount * 1e10 / total-supply           ;; instant
           pending = balance * (cumm-reward − holder.cumm-reward) / 1e10 + saved

jSTX:      should-be-vested = total * elapsed / 2100   (capped at total)
           global-index += (newly-vested) * 1e10 / tracked-supply     ;; vested
           pending = snap.balance * (global-index − snap.index) / 1e10
```

Same shape; jSTX inserts the vesting throttle between "sBTC arrives" and "index moves." Any pox-5
reward route (`jbtc-yield.record-rewards`) must preserve **both** properties or rewards leak /
become re-earnable: (a) settle the wallet's snapshot *before* its balance changes, and (b) only
credit vested-so-far, not the full cycle.

---

## 5. ⚠ The two seams that close the circle

These are the "1–2 contracts I hadn't finished reviewing." Both are **routing seams between
already-written contracts**, and both must be resolved (the pox-5 rebuild faces the same questions).

### Seam 1 — pool ↔ stacker PoX delegation wiring

The handoff that actually locks STX into PoX doesn't line up:

- `stacker.delegate-stx` (`stacker.clar:62`) calls
  `(pox-4 delegate-stx ustx tx-sender none (some btc-addr))` — under `as-contract?`, `tx-sender`
  is **the stacker itself**, so the stacker **delegates to itself**.
- `pool.lock-delegated-stx` (`pool.clar:164`) calls
  `(pox-4 delegate-stack-stx stacker ustx (btc-address) …)` under `as-contract?` — so **the pool**
  is the caller of `delegate-stack-stx`.

pox-4 requires the caller of `delegate-stack-stx` to be the principal the stacker **delegated to**.
The stacker delegated to *itself*, but the *pool* makes the call ⇒ this path fails
(`ERR_STACKING_PERMISSION_DENIED`) on real pox-4. The pool/stacker split is sound, but one of these
must change so the delegate and the operator agree:

- **Fix A (keep split):** stacker delegates **to the pool** —
  `(pox-4 delegate-stx ustx <pool-principal> none (some btc-addr))` — then `pool.lock-delegated-stx`
  is the legitimate delegate. (`pool-trait` already lets the stacker read the pool principal.)
- **Fix B (collapse):** the **stacker** calls `delegate-stack-stx` itself (StackingDAO-style, where
  the stacker is both delegator and operator), and `pool` only holds signer key / btc-addr / agg-commit.

Either is fine; the repo currently does neither consistently. **This is the seam that decides whether
STX ever actually stacks.** (Note: `pox-4-mock` may not enforce the delegate check — verify against
real pox-4 / a faithful mock, not the permissive one.)

### Seam 2 — "does the user pick a signer or a stacker?"

`core.deposit`'s `(stacker (optional principal))` is consumed three different ways:

- `core.deposit:147` — `dao.check-is-authorized (unwrap stacker)` (must be an authorized contract).
- `delegation.assign:64` — validates `(> (registry.get-signer-allocation new-stacker) u0)` — i.e.
  treats the picked principal as a **signer** (checks `signer-allocation`), and stores it in
  `stacker-total[picked]`.
- `allocation.calculate-stacker-target` / `execute-allocation:185` — reads
  `registry.get-delegate-allocation stacker` (the **stacker/delegate** weight) and
  `delegation.get-stacker-total stacker`, then does `vault.release → stacker` (so the principal must
  be a **stacker contract that holds STX**).

So `delegation` validates the choice as a *signer* (pool) while `allocation` consumes it as a
*stacker* (STX-holding contract) — and `registry` keeps **both** `signer-allocation` and
`delegate-allocation` maps that these two contracts cross over. A signer/pool is not a stacker, so
`get-stacker-total` and the vault→stacker release won't line up for a user-directed deposit.

**Decision to make (and document in registry):** users pick a **signer** (coarse, what "support this
signer" means) and the protocol maps signer → its stackers via `registry.signer-delegates`; *or*
users pick a specific **stacker**. Then make all three contracts agree on that unit:

- if **signer**: `allocation` must translate per-signer assignment → per-stacker targets through
  `signer-delegates` + `delegate-allocation`, and `delegation` keys by signer (current
  `get-signer-allocation` check is then correct).
- if **stacker**: `delegation.assign` must validate `get-delegate-allocation` (not
  `get-signer-allocation`), and the deposit UI exposes stackers, not signers.

Until this is pinned, the user-directed allocation path is internally inconsistent even though each
contract compiles and reads cleanly in isolation — which is exactly why it slipped a single-contract
review.

### (Seam 3, operational, not a bug) — no on-chain orchestrator

There is no `strategy` contract sequencing the per-cycle calls. Each cycle a keeper must, in order:
`allocation.execute-allocation` (fund stackers) → `stacker.delegate-stx` → `pool.lock-delegated-stx`
(or extend/increase) → `pool.finalize-cycle`; and on the back end `yield.sweep-stacker` →
`yield.flush-commission`; and `allocation.return-excess` after unlock. StackingDAO encodes this in
`strategy-v3`. For jSTX it lives in the keeper bot. Worth writing down as the runbook even if it
stays off-chain.

---

## 6. Implication for the pox-5 swap

- **Reward/token layer ports almost verbatim** — `yield`/`share-data`/`jstx-token` →
  `jbtc-yield`/`jbtc-share-data`/`jbtc-token` already done; preserve the §4 invariants.
- **Seam 1 disappears under pox-5** — there is no `delegate-stx`/`delegate-stack-stx` dance; the
  signer-manager registers a bond position directly. The pox-5 equivalent question becomes "which
  vault (one bond/principal) does this cohort register into," which `juice-signer-manager` /
  `juice-staker` must answer cleanly.
- **Seam 2 carries over** — the signer-vs-stacker routing decision becomes signer-vs-vault in pox-5
  (one vault = one bond period). Resolve the unit *now* in the pox-4 mental model so the pox-5
  `registry`/`allocation` rebuild inherits a consistent answer.
- **`data-core` stays dropped** — jBTC is likewise a pure sBTC claim (and jX the STX-collateral
  tranche), so no exchange-rate sub-system is needed on the pox-5 side either.
```
