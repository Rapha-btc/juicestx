# PoX-5 contract set — equivalents to the jSTX (pox-4) stack

Maps every pox-4 jSTX contract (`contracts/*.clar`) to its pox-5 equivalent. The split is the
two-layer model from [`migration-jstx-to-pox5.md`](./migration-jstx-to-pox5.md): the **reward/token
layer** is copied (separate state per product), the **stacking layer** is rebuilt on bonds/signers,
the **shared infra** is reused in place, and `delegation` is retired.

Legend: ✅ scaffolded + `clarinet check` · ⛳ TODO (next) · ♻️ reused as-is (not forked) · ❌ retired

> **Live on mainnet:** `juice-pool-stx-signer` — the STX-only pox-5 pool, deployed and
> stacking from cycle 141. Everything below is the jBTC/bond build-out, which is still
> scaffolding. See [`juice-pool-stx-signer.md`](./juice-pool-stx-signer.md) for the pox-5
> functions it uses, what it deliberately skips and why, key rotation, and fee governance.

## Reward / token layer  → in this folder (copies, separate state)

| pox-4 (jSTX) | role | pox-5 | status |
|---|---|---|---|
| `share-data.clar` | reward data store (global index, snapshots) | **`jbtc-share-data.clar`** | ✅ copy |
| `yield.clar` | vesting/drip + settle engine | **`jbtc-yield.clar`** | ✅ adapted — `record-rewards` replaces `sweep-stacker` |
| `jstx-token.clar` | liquid SIP-010 | **`jbtc-token.clar`** | ✅ copy, 8 decimals (sBTC), settle → `jbtc-yield` |

`jstx-token` / `yield` / `share-data` **stay** for the new **jSTX-pox5** product (STX-only); they
just get the pox-5 feed (`record-rewards` from the signer-manager) instead of `sweep-stacker`. So
each product has its own token + index; the *code* is shared, the *state* is not.

## Staking layer  → in this folder (rebuilt on pox-5 primitives)

| pox-4 (jSTX) | role | pox-5 | status |
|---|---|---|---|
| `pool.clar` (1 per signer) | pox-4 touchpoint (`delegate-stack-stx`, aggregation) | **`juice-signer-manager.clar`** (the signer) | ✅ scaffold |
| `stacker.clar` (M per signer) | per-position STX+sBTC holder | **`juice-staker.clar`** (M per signer, bond laddering) | ✅ scaffold |
| `registry.clar` | directory of signer pools | **`juice-registry`** (signer-managers + bonds) | ⛳ TODO |
| `allocation.clar` | spread STX vault → stackers | **`juice-allocation`** (spread sBTC+STX → stakers; sets signer weight) | ⛳ TODO |
| `core.clar` | user entry (deposit/withdraw) | **`jbtc-core`** + **`jstx-core`** (per product) | ⛳ TODO |

`core` splits per product: **jBTC** = deposit sBTC → pair ~5% STX (from reserve) → `stake-bond` →
mint jBTC; redeem = `unstake-sbtc` (instant). **jSTX** = deposit STX → `stake-stx` → mint jSTX;
redeem = withdrawal-NFT queue.

## Shared infra  → reused in place from `contracts/` (no fork)

| contract | why no fork |
|---|---|
| `dao.clar` | one permission gate for the whole protocol; pox-5 contracts call `.dao` directly |
| `treasury.clar` | STX fee treasury |
| `commission.clar` | sBTC fee splitter (used by `jbtc-yield.flush-commission`) |
| `position-zest.clar` | DeFi position adapter (jBTC can be collateral too) |
| `redeem-stx-nft.clar` | the STX withdrawal NFT — used by the **jSTX** redemption queue |
| `fees-none.clar` | fees impl |

These don't need a pox-5 copy; the new contracts reference them by name. (If we ever want them
fully isolated per product, fork later — not needed to ship.)

## Retired

| pox-4 | why |
|---|---|
| `delegation.clar` ❌ | pox-5 has no per-user `delegate-stx`; users hold the liquid token, and the STX→signer weighting is native to pox-5 (`signer-delegated-per-cycle`), steered by `allocation` |

---

## Deploy / dependency order (pox-5 stack)

```
dao  →  jbtc-share-data  →  jbtc-yield  →  jbtc-token
pox-5 (external)  →  juice-staker  →  juice-signer-manager  (→ jbtc-yield)
```

## Status summary

- **Done (5):** `jbtc-share-data`, `jbtc-yield`, `jbtc-token`, `juice-staker`, `juice-signer-manager` — all `clarinet check` clean.
- **Next (⛳):** `jbtc-core` / `jstx-core` (deposit/redeem + the sBTC+STX pairing source), `juice-allocation`, `juice-registry`, and the jSTX-pox5 reward route (`stx-rewards.earned` → jSTX engine; currently a TODO in `juice-signer-manager`).
- **Open contract question:** the reserve draw-down (see [`pox-5-reward-mechanics.md`](./pox-5-reward-mechanics.md)).
