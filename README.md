# Juice - Liquid Stacking on Stacks

**Stack STX. Earn sBTC. Stay Liquid.**

Juice (jSTX) is a liquid stacking protocol on Bitcoin. Deposit STX, receive jSTX, and earn sBTC stacking rewards -- all while staying liquid in DeFi.

Website: [stxjuice.com](https://www.stxjuice.com/)

## How It Works

### The User's Perspective

1. **Deposit**: Send STX to the protocol, get jSTX back (1:1 ratio)
2. **Earn**: Your STX is stacked via PoX signers, earning BTC rewards each cycle (~2 weeks)
3. **Claim**: sBTC rewards vest linearly; claim anytime
4. **Withdraw**: Request a withdrawal, get an NFT receipt, redeem for STX when the cycle ends
5. **DeFi**: Use jSTX as collateral in Zest and other protocols while still earning sBTC

jSTX is **not** a rebasing token. Your jSTX balance never changes. The yield comes as separate sBTC payments you can claim whenever you want.

### Under the Hood

```
User deposits STX
       |
       v
  vault.clar (holds all deposited STX)
       |
       | [Every ~2 weeks, at cycle boundary]
       v
  allocation.clar computes per-stacker targets from registry weights
       |
       +---> Pool A (1 pool.clar + N stacker.clar)  -- 100% at launch
       |       pool calls pox-4 to lock, extend, increase, finalize
       |       stackers hold STX and receive sBTC from Emily bridge
       |
       +---> Pool B (added later, same pattern)
       |
       +---> Pool C (added later)
       |
       v
  BTC rewards arrive each cycle → Emily mints sBTC into stacker contracts
       |
       v
  yield.clar sweeps sBTC from stackers
       |
       +---> stacker pays signer fee directly (set by signer on pool contract)
       +---> commission.clar (protocol treasury cut, set by admin)
       |
       v
  yield.clar vests rewards linearly over ~2100 blocks (no keeper needed)
       |
       v
  jSTX holders claim sBTC proportional to their balance
```

## Architecture

### Design Principles

1. **Multi-signer from day 1**: Even though we launch with one signer, the architecture supports N signers. Adding a signer is a registry update, not a code change.
2. **Separated data and logic**: Data contracts (share-data) are separate from logic contracts so logic can be upgraded without migrating state.
3. **Trait-based modularity**: Commission strategy, pool implementation, and DeFi adapters are all trait-based. Swap implementations via DAO governance without touching the pipeline.
4. **No circular dependencies**: The token calls yield, but yield never calls back to the token. Balance data flows as parameters to break the cycle.

### Pool + Stacker Architecture

Each signer has **one pool contract** (complex, deployed once) and **multiple stacker contracts** (thin, deployed N times per signer).

**Why this split?**
- **Signer convenience**: signers interact with one contract, not N stacker contracts
- **No code duplication**: PoX operations, signer key management, and cycle auth live in pool.clar once
- **Graceful rotation**: stop one stacker without unlocking all STX

**PoX operations and where they live:**

| Operation | Contract | What it does |
|-----------|----------|-------------|
| `delegate-stx` | stacker | Self-delegates STX to PoX (prerequisite for locking) |
| `revoke-delegate-stx` | stacker | Revokes delegation (locked STX still unlocks at cycle end) |
| `lock-delegated-stx` | pool | Locks a stacker's STX into PoX for the first time |
| `extend-delegated-stx` | pool | Extends lock for additional cycles (can't re-lock while locked) |
| `increase-delegated-stx` | pool | Adds more STX mid-cycle to an already-locked stacker |
| `finalize-cycle` | pool | Commits aggregated stake with signer auth (`stack-aggregation-commit-indexed`) |

### Contract Map

```
                         +----------+
                         |   dao    |  Permission gate for the entire protocol.
                         +----+-----+  Every privileged function checks here.
                              |
          +-------------------+-------------------+
          |                   |                   |
    +-----v------+    +------v------+    +-------v-------+
    |  registry   |    | share-data  |    | redeem-nft    |
    | Pool/signer |    | Reward      |    | SIP-009 NFT   |
    | directory   |    | tracking    |    | for withdrawal |
    | with weights|    | data store  |    | receipts +    |
    |             |    |             |    | marketplace   |
    +-----+------+    +------+------+    +-------+-------+
          |                  |                    |
          |           +------v------+             |
          |           | jstx-token  |             |
          |           | SIP-010     |             |
          |           | "Juiced STX"|             |
          |           +------+------+             |
          |                  |                    |
    +-----v------+    +------v------+    +-------+-------+
    | allocation  |    |    core     |    |     vault     |
    | Stacker     |    | User entry |    | STX bank      |
    | targets +   |    | deposit /  |    | account       |
    | execution   |    | withdraw   |    |               |
    +-----+------+    +------+------+    +---------------+
          |                  |
    +-----v------+    +------v------+     +-------------+
    | pool +     |    |   yield     |     | commission  |
    | stacker    |    | Rewards +   |     | Fee splitter|
    | PoX-4      |    | vesting +   +---->| (trait-     |
    | signer ops |    | settlement  |     |  based)     |
    +------------+    +-------------+     +-------------+
```

### Contract Details

| Contract | What it does |
|----------|-------------|
| **dao** | Permission gate. Two whitelists: "authorized" (contracts) and "admins" (wallets). Every privileged function checks here. Deployer is the initial admin. |
| **registry** | Central directory of signer pools. Tracks active signers, per-signer STX allocation (basis points), per-signer fee rates, and stacker contract assignments. Two-level allocation: signer-allocation (pool level) + delegate-allocation (stacker level). Multi-signer is a registry update, not a code change. |
| **jstx-token** | SIP-010 fungible token ("Juiced STX", 6 decimals). Every transfer/mint/burn refreshes reward tracking via yield.settle-wallet first, so no one can game the reward timing. |
| **share-data** | Data store for reward tracking. Holds the global reward-per-share counter, per-holder snapshots, tracked supply, and registered DeFi positions. Separated so yield logic can be upgraded without migrating data. |
| **vault** | The STX bank account. All deposited STX lives here. Only authorized contracts can deposit or withdraw. |
| **core** | User entry point. Deposit (STX in, jSTX out at 1:1). Init-withdraw (lock jSTX, get withdrawal NFT with unlock height). Withdraw (after unlock, burn NFT + jSTX, get STX back). |
| **yield** | Reward distribution. Sweeps sBTC from stacker contracts (stacker pays signer fee, yield takes protocol commission), then vests rewards linearly over ~2100 blocks (no keeper needed). Handles wallet settlement using cumulative-reward-per-share math (O(1) per holder). Settles DeFi positions too (jSTX in Zest still earns). |
| **commission** | Fee splitter. Takes the protocol commission portion of sBTC rewards and sends it to the treasury. Implements a trait so governance can deploy a new commission strategy without touching the yield pipeline. |
| **pool** | PoX-4 signer operator contract. One per signer. Manages signer key + signature registration per cycle, calls pox-4 to lock/extend/increase STX and commit aggregated stake. The signer controls their own key material. Sets their own fee rate. |
| **stacker** | Thin STX + sBTC holder. Multiple deployed per signer. Holds STX for PoX locking, receives sBTC from Emily bridge. Pays signer fee directly during reward release. |
| **allocation** | Computes per-stacker STX targets blending admin weights (registry) with user delegation preferences, then executes allocation by moving STX from vault to stacker contracts. |
| **redeem-nft** | SIP-009 NFT for withdrawal receipts. Each NFT represents a claim on X STX after block height Y. Includes a built-in non-custodial marketplace: list your withdrawal position for sale if you don't want to wait. |
| **position-zest** | Zest DeFi adapter. Tells the share contract how much jSTX a user has deposited as collateral in Zest, so they still earn sBTC rewards on collateralized jSTX. |

### Traits

| Trait | Purpose |
|-------|---------|
| **sip-010-trait** | Standard fungible token interface (jSTX, sBTC) |
| **sip-009-trait** | Standard NFT interface (withdrawal receipts) |
| **vault-trait** | `(deposit, release, get-pending-balance)` -- vault interface |
| **pool-trait** | `(get-btc-address, get-signer-info)` -- pool interface for stacker cross-contract calls |
| **stacker-trait** | `(stx-transfer, release-rewards)` -- stacker interface for allocation + yield |
| **commission-trait** | `(process uint)` -- swappable fee strategy |
| **fees-trait** | Protocol fee configuration |
| **position-trait** | `(get-balance principal)` -- DeFi adapter interface |

### Fee Structure

Two independent fees, each set by different parties:

1. **Signer fee** (set by signer on their pool contract): deducted from sBTC rewards by the stacker before sending to yield. Revenue for the signer operator.
2. **Protocol fee** (set by admin): deducted from sBTC rewards by yield and sent to commission contract. Revenue for the protocol treasury.

## Multi-Signer Architecture

STX Juice supports multiple institutional signers from day 1.

### How it works

```
registry.clar
  |
  +-- signers: [pool-A, pool-B, pool-C]
  |
  +-- signer-allocation: pool-A = 5000 (50%), pool-B = 3000 (30%), pool-C = 2000 (20%)
  +-- signer-fee:        pool-A = 500 (5%),   pool-B = 300 (3%)   [set on pool contract]
  +-- signer-delegates:  pool-A = [stacker-1a, stacker-1b, stacker-1c]
  +-- delegate-allocation: stacker-1a = 5000, stacker-1b = 3000, stacker-1c = 2000
```

- **Signer allocation** controls what percentage of total STX each signer receives (must sum to 10,000 bps)
- **Signer fee** is set by each signer on their pool contract (their revenue share of rewards)
- **Stacker delegates** are thin STX-holding contracts per pool (multiple per pool for graceful rotation)
- **Delegate allocation** controls how STX is split among stackers within a single pool

### Adding a new signer

No contract upgrades needed. An admin calls:

```clarity
(contract-call? .registry set-signers (list .pool-a .pool-b .pool-new))
(contract-call? .registry set-signer-allocation .pool-new u2000)
```

The signer sets their own fee on their pool contract. Allocation routes STX to the new pool's stackers on the next cycle.

### Launch plan

Phase 1: Single signer (us or Fast Pool) -- signer allocation = 10,000 (100%)
Phase 2: Add 2-3 institutional signers -- split allocations
Phase 3: Full signer set with per-signer fee negotiation

## The PoX Cycle Problem

### The prepare phase

Every PoX cycle (~2,100 Bitcoin blocks, ~2 weeks), there is a **prepare phase** in the last 100 blocks before the next cycle starts. During this window, pool operators MUST:

1. Get the signer's key + authorization signature for the next cycle
2. Call `pool.register-cycle-auth(cycle, ...)` with signer key and signature
3. Call `pool.finalize-cycle(cycle)` which calls `pox-4.stack-aggregation-commit-indexed`

If ANY of these steps are late -- the entire pool earns **zero rewards** for that cycle. No partial commit, no grace period, no retry.

### Why it's hard at scale

With many signers:
- N signer keys to coordinate per cycle
- N pool contracts to update
- All within a ~100 block window (~16 hours)
- Each signer operator must generate and deliver their authorization signature on time

### Our mitigation plan

1. **Start with 1 signer** -- eliminates coordination complexity at launch
2. **Automated keeper** -- bot monitors the prepare phase and triggers transactions automatically
3. **Early warning system** -- alerts if signer info isn't registered N blocks before deadline
4. **Graceful degradation** -- if one signer in a multi-signer setup misses, only their share is affected (multi-signer is risk diversification)

## Research: Keeper-less sBTC Reward Flow

**Status: Open question -- needs validation with sBTC team**

### The idea

Set the pool's PoX reward address (`btc-address` in `pool.clar`) to the sBTC deposit address that maps to the stacker contract's principal. Then:

1. Miners pay BTC rewards to the pox-addr (which IS the sBTC deposit address)
2. Emily bridge sees the BTC deposit, mints sBTC to the stacker contract
3. No keeper needed for BTC → sBTC conversion

### How the pox-addr works in PoX-4

- `pool.clar` stores `btc-address` as `{ version: (buff 1), hashbytes: (buff 32) }` -- a BTC address, not a Stacks principal
- This gets passed to `pox-4.stack-aggregation-commit-indexed` once per cycle
- Once committed, `stack-aggregation-increase` enforces the **same** pox-addr for that cycle
- But it can be set to a **different** address on the next cycle via `register-cycle-auth`

### The sBTC deposit address problem

The sBTC deposit address (from Emily API) is a taproot address derived from the current sBTC signer set. When signers rotate, the deposit address changes.

- **Within a cycle**: pox-addr is locked at commit time. If sBTC signers rotate mid-cycle, BTC rewards still go to the old deposit address. Question: does the bridge still honor deposits to a previous-rotation address?
- **Between cycles**: we can query Emily for the current deposit address and use it for the next cycle's commit. This part works cleanly.

### Questions to validate

1. Does the sBTC deposit address stay valid for deposits after a signer rotation?
2. Can we get a deposit address that maps to a specific contract principal (not just an EOA)?
3. Is there a taproot key path that lets the depositor reclaim BTC if the bridge fails to process?
4. What's the expected signer rotation frequency relative to PoX cycle length (~2100 blocks)?

### Current approach (safe)

Keeper collects BTC from signer, converts to sBTC off-chain, calls `yield.receive-rewards()`. This works regardless of sBTC bridge behavior. The keeper-less approach is an optimization to explore, not a blocker.

## Development

```bash
clarinet check       # Validate all contracts
npm test             # Run tests (vitest + Clarinet SDK)
```

## Status

Contracts scaffolded and compiling. Next steps:
- [ ] Write unit tests for deposit/mint/withdraw flow
- [ ] Write unit tests for reward distribution math
- [ ] Test multi-signer registry configuration
- [ ] Implement keeper bot for cycle management
- [ ] Security review

## License

TBD
