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
| `delegation.clar` | per-user → stacker delegation map | → **per-user map retired**, but the STX→signer relationship is **not** — pox-5 weights each signer by the uSTX locked under it (see "Signers are weighted by their STX" below) |
| `core.clar` | user entry (deposit / withdraw) | → rewritten per product (jBTC core, jSTX core) around signer-managers |

### Layer 2 — reward / token layer (how sBTC is distributed) — **reused as-is**
Chain-agnostic: it only cares that sBTC flows in. Identical for jSTX-pox5 and jBTC.

| Contract | Role | PoX-5 |
|---|---|---|
| `yield.clar` | vesting/drip distribution engine (linear over a cycle, anti-flash-mint) | **keep** — feed from `claim-rewards` instead of `sweep-stacker` |
| `share-data.clar` | global reward index + per-holder snapshots | **keep** |
| `jstx-token.clar` | jSTX liquid token, settle-on-transfer hooks | **keep** — serves jSTX-pox5 |
| **`jbtc-token` (new)** | jBTC liquid token, same settle pattern | **build** — a *separate* SIP-010 with its **own** reward index (jBTC and jSTX have different supplies + reward rates) |
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
  signing power. **This is the protocol goal**: no single signer / node / key dominates the
  jBTC/jSTX position. `allocation` sets how much STX backs each signer, and
  `signer-delegated-per-cycle` turns that into signer-set weight — so "decentralize" = spread STX
  across N signers so each holds a bounded share of the power.
- **multi-staker per signer** — M staker contracts per signer-manager → continuous bond coverage
  + the single-membership-per-principal workaround. (Internal liquidity plumbing, not
  decentralization.)

> **Honest caveat:** N signer-managers that Juice's *own admin* controls is decentralized on paper
> only. Real decentralization means those N signers are **independent operators** — different keys,
> different nodes — with `registry` + `allocation` coordinating capital and the shared reward engine
> aggregating their sBTC into one token. The cost: each independent signer is its own
> `setup-bond` allowlist slot + its own 50k-STX floor + its own node, so decentralization scales the
> Phase-0 blocker **linearly**.

---

## Signers are weighted by their STX — so allocation *is* the decentralization lever

`delegation.clar`'s per-user map retires, but the "STX backs a signer" relationship does not — it
becomes native to pox-5 and central to decentralizing signing power. pox-5 tracks, per cycle, the
total uSTX behind each signer:

```clarity
(get-amount-delegated-for-signer signer cycle)   ;; → signer-delegated-per-cycle { cycle, signer }
;; "total uSTX delegated (through protocol bonds AND STX-only staking) to this signer"
```

A signer's weight in the signer set **is the STX locked under it** — and this counts **both**
products: jSTX-pox5's STX directly, and **jBTC's paired STX (the ~5% min)** too. So jBTC's STX leg
isn't just bond collateral; it's also what gives that signer representation.

Consequence: to **decentralize signer power**, Juice's `allocation` layer decides how much STX (and
sBTC) flows to each signer-manager — and that allocation *directly sets each signer's weight*.
Spreading STX across N signer-managers = distributing signing power. So `allocation` is not retired
plumbing; in pox-5 it's the **governance knob for decentralization.**

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

- **Reused (the high-leverage keepers):** `yield`, `share-data`, `jstx-token`, `commission`,
  `position-zest`, `dao`, `vault`, `treasury`, `redeem-stx-nft`.
- **New:** **`jbtc-token`** — a separate SIP-010 with its own reward index (the reward *engine*
  is shared code, but each token carries its own supply + index state).
- **Rebuilt onto pox-5 primitives:** `pool` → `juice-signer-manager`; `stacker` → pox-5 staker
  contracts (multi, for laddering); `registry`, `core` → adapted to signers/bonds. `allocation`
  stays but gains a new job — it sets each signer's weight (decentralization knob).
- **Retired:** only `delegation`'s **per-user → stacker map** (users hold the liquid token). The
  STX→signer weighting it implied is now native to pox-5 (`signer-delegated-per-cycle`) and
  steered by `allocation`.

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
