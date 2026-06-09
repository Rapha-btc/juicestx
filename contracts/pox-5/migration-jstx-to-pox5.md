# Migrating Juice from PoX-4 to PoX-5 — jBTC + jSTX

**Goal.** Two liquid-staking products on PoX-5, sharing one reward engine:

- **jBTC** — pooled Bitcoin staking. The pool holds **sBTC + paired STX** and stakes via
  `register-for-bond` (sBTC-custody path). Earns sBTC.
- **jSTX (pox-5)** — STX-only staking on PoX-5, via `stake`. Earns sBTC. This is the *new* jSTX
  that replaces the PoX-4 jSTX below.

Both reuse the same sBTC reward/token layer we already built for PoX-4 jSTX. The work is not a
rewrite — it's swapping the **stacking layer** (how STX gets locked) while keeping the
**reward layer** (how sBTC gets distributed) intact.

> See also: [`pox-5-functions-for-juice.md`](./pox-5-functions-for-juice.md) (the pox-5 call
> walkthrough) and [`jbtc-pox5-bond-requirements.md`](./jbtc-pox5-bond-requirements.md) (economics +
> the allowlist blocker).

---

## The two layers

The PoX-4 jSTX repo splits cleanly. Only the stacking layer changes for PoX-5.

### Layer 1 — stacking layer (how STX is locked)
PoX-4 used `delegate-stx`; PoX-5 uses bonds + signers. The *mechanism* changes — **the
multi-signer / multi-staker architecture does not.** It remaps onto pox-5 primitives:

| PoX-4 contract | Role | PoX-5 mapping |
|---|---|---|
| `pool.clar` (one per signer) | the signer's single PoX-4 touchpoint (`delegate-stack-stx`, aggregation) | → **`juice-signer-manager`** (one per signer): `register-signer`, `register-for-bond` / `stake`, `claim-rewards` |
| `stacker.clar` (**multiple per signer**) | thin per-position STX+sBTC holder | → **multiple pox-5 staker contracts per signer** (see below — this gets *more* important, not less) |
| `allocation.clar` | spreads STX from vault across stackers | → spreads sBTC+STX across staker contracts / bonds |
| `registry.clar` | directory of signer pools | → directory of signer-managers + their bonds |
| `delegation.clar` | per-user → stacker delegation map | → **mostly retired** — pox-5 has no user `delegate-stx`; users hold the liquid token, the pool holds funds directly |
| `core.clar` | user entry (deposit / withdraw) | → rewritten per product (jBTC core, jSTX core) around signer-managers |

### Layer 2 — reward / token layer (how sBTC is distributed) — **reused as-is**
Chain-agnostic: it only cares that sBTC flows in. Identical for jSTX-pox5 and jBTC.

| Contract | Role | PoX-5 |
|---|---|---|
| `yield.clar` | vesting/drip distribution engine (linear over a cycle, anti-flash-mint) | **keep** — feed from `claim-rewards` instead of `sweep-stacker` |
| `share-data.clar` | global reward index + per-holder snapshots | **keep** |
| `jstx-token.clar` | liquid token, settle-on-transfer hooks | **keep** (also the jBTC token template) |
| `commission.clar` | sBTC fee splitter (signer cut + protocol) | **keep** |
| `position-zest.clar` | DeFi position adapter (multi-position tracking) | **keep** — generalizes to multi-bond aggregation |
| `dao` / `vault` / `treasury` / `redeem-stx-nft` | permissions, STX custody, fees, withdrawal NFT | **keep** |

---

## Why `stacker` (multi-per-signer) survives — and matters more

PoX-5 keys bond membership **one per principal**:

```clarity
(define-map protocol-bond-memberships principal { bond-index, amount-ustx, signer, is-l1-lock })
```

A single principal can be in **exactly one bond at a time**. Bonds start every `BOND_GAP_CYCLES`
(2 cycles) and run `BOND_LENGTH_CYCLES` (12). So to keep the pool's capital **continuously
deployed** — laddered across overlapping bonds rather than all unlocking together — you need
**multiple staker principals**, each registered into a different bond.

That is exactly what `stacker.clar` was: *multiple thin holding contracts per signer.* It does not
disappear in pox-5 — it becomes the mechanism for **bond laddering** under one signer-manager:

```
signer-manager (signer identity)
├── staker-a  → bond N      (sBTC + STX custodied here)
├── staker-b  → bond N+3    (overlapping ladder)
└── staker-c  → bond N+6    (the rollover target)
```

Each staker calls `register-for-bond` under `as-contract` (tx-sender = that staker), so its sBTC
is custodied and its STX locked independently. The signer-manager coordinates them; `allocation`
decides how much sBTC/STX each staker takes.

**So the decentralization is two-dimensional and both axes are preserved:**

- **multi-signer** — N signer-managers (each its own pox-5 signer + allowlist slot) → spreads
  signing power, the explicit goal.
- **multi-staker per signer** — M staker contracts per signer-manager → continuous bond coverage
  + the single-membership-per-principal workaround.

---

## The two products, side by side

| | **jSTX (pox-5)** | **jBTC** |
|---|---|---|
| User deposits | STX | sBTC (+ the pool pairs STX) |
| PoX-5 entry | `stake` (STX-only) | `register-for-bond` with `(err sats)` (sBTC custody) |
| What's locked | STX | sBTC custodied in pox-5 + paired STX locked node-side |
| Rewards | sBTC | sBTC |
| Liquid token | jSTX | jBTC |
| Reward engine | shared `yield` + `share-data` | shared `yield` + `share-data` |
| Signer-manager | shared | shared |

The *only* real differences are the pox-5 entry call and whether sBTC is custodied. Everything
downstream (claim → vest → distribute) is one engine serving both tokens.

---

## The reward rewire — the single change inside Layer 2

PoX-4 fed `yield.clar` like this:

```
Emily mints sBTC → stacker → keeper: sweep-stacker(stacker, pool, cycle)
                          → release-rewards pulls sBTC into yield
                          → per-cycle bucket → vest linearly → global index
```

PoX-5 feeds the same bucket from the bond claim instead:

```
pox-5 accrues sBTC per signer → keeper: signer-manager.claim-rewards (DIRECT call)
                              → sBTC lands at signer-manager
                              → hand to yield (one bucket per claim/cycle)
                              → vest linearly → global index   ← unchanged
```

So the change is: **replace `sweep-stacker`'s `release-rewards` source with the sBTC claimed via
`pox-5 claim-rewards`.** The vesting math, the global index, the per-holder snapshots, the
anti-flash-mint property, the two fee legs — all unchanged. `supported-positions` (from
stSTXbtc's tracking design / our `position-zest` adapter) is how multiple staker/bond positions
aggregate into one token's reward index.

---

## What's reused / rebuilt / retired

- **Reused (the high-leverage keepers):** `yield`, `share-data`, `jstx-token` (→ + jBTC token),
  `commission`, `position-zest`, `dao`, `vault`, `treasury`, `redeem-stx-nft`.
- **Rebuilt onto pox-5 primitives:** `pool` → `juice-signer-manager`; `stacker` → pox-5 staker
  contracts (multi, for laddering); `allocation`, `registry`, `core` → adapted to signers/bonds.
- **Retired:** `delegation` (no per-user `delegate-stx` in pox-5; the liquid token + reward
  snapshots replace it).

**Priority implication:** finishing the PoX-4 jSTX review pays off for pox-5 **only on Layer 2.**
Polishing Layer-1 contracts that pox-5 rebuilds (pool/allocation/core) has limited carry-over;
finishing the **reward layer** (`yield` + `share-data` + `commission` + `jstx-token`) is the work
that ships unchanged on both pox-5 products.

---

## Open tension to resolve with the bond-admin

Decentralizing signer power **multiplies the allowlist blocker**: every signer-manager is a
distinct pox-5 signer that needs its **own `setup-bond` allowlist slot + `max-sats`**. The
allowlist is frozen at bond creation and granted off-chain. So "many small Juice signers" and "a
frozen, admin-granted allowlist" pull against each other — a question for whoever holds
`bond-admin` (see [`jbtc-pox5-bond-requirements.md`](./jbtc-pox5-bond-requirements.md), §A).
