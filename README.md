# Juice - Liquid Stacking on Stacks

**Stack STX. Earn sBTC. Stay Liquid.**

Juice (jSTX) is a community-built liquid stacking token on Bitcoin. Deposit STX, receive jSTX, and earn sBTC stacking rewards -- all while staying liquid in DeFi.

Website: [stxjuice.com](https://www.stxjuice.com/)

## Why Juice?

The Stacks liquid stacking space needs fresh energy. StackingDAO has missed stacking deadlines twice, leaving users frustrated. LISA lacks a swap for users to convert in and out easily. There's room for a new protocol built from scratch with the community in mind.

## Origin

Juice started as a conversation between [RaphaStacks](https://x.com/RaphaStacks) and [friedger.btc](https://x.com/AskFriedger) about the need for more innovation in the Stacks liquid stacking space -- and a commitment to build something new from scratch, with the community first.

The study plan is public at [stxjuice.com/learn](https://www.stxjuice.com/learn).

## How It Works

### The User's Perspective

1. **Deposit**: Send STX to the protocol, get jSTX back (1:1 ratio)
2. **Earn**: Your STX is stacked via PoX signers, earning BTC rewards each cycle (~2 weeks)
3. **Claim**: sBTC rewards drip into the system gradually; claim anytime
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
  helpers.clar reads registry.clar to determine pool allocations
       |
       +---> Pool A (Signer: us / Fast Pool)  -- 100% at launch
       |       calls pox-4.delegate-stack-stx
       |       calls pox-4.stack-aggregation-commit-indexed
       |
       +---> Pool B (Signer: ALUM Labs)       -- added later
       |
       +---> Pool C (Signer: Kiln)            -- added later
       |
       v
  BTC rewards arrive each cycle
       |
       v
  yield.clar receives sBTC, takes per-pool commission
       |
       +---> commission.clar (protocol treasury cut)
       +---> pool owner cut (signer operator revenue share)
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
2. **Separated data and logic**: Data contracts (share-data) are separate from logic contracts (share) so logic can be upgraded without migrating state.
3. **Trait-based modularity**: Commission strategy, pool implementation, and DeFi adapters are all trait-based. Swap implementations via DAO governance without touching the pipeline.
4. **No circular dependencies**: The token calls yield, but yield never calls back to the token. Balance data flows as parameters to break the cycle.

### Contract Map

```
                         +----------+
                         |   dao    |  Permission gate for the entire protocol.
                         +----+-----+  Every privileged function checks here.
                              |
          +-------------------+-------------------+
          |                   |                   |
    +-----v------+    +------v------+    +-------v-------+
    |  registry   |    | share-data  |    | withdraw-nft  |
    | Pool/signer |    | Reward      |    | SIP-009 NFT   |
    | directory   |    | tracking    |    | for withdrawal |
    | with weights|    | data store  |    | receipts +    |
    | and fees    |    |             |    | marketplace   |
    +-----+------+    +------+------+    +-------+-------+
          |                  |                    |
          |           +------v------+             |
          |           | jstx-token  |             |
          |           | SIP-010     |             |
          |           | "Juiced STX"|             |
          |           +------+------+             |
          |                  |                    |
    +-----v------+    +------v------+    +-------+-------+
    |  helpers    |    |    core     |    |     vault     |
    | Multi-pool  |    | User entry |    | STX bank      |
    | router      |    | deposit /  |    | account       |
    |             |    | withdraw   |    |               |
    +-----+------+    +------+------+    +---------------+
          |                  |
    +-----v------+    +------v------+     +-------------+
    |    pool     |    |   yield     |     | commission  |
    | PoX-4       |    | Rewards +   |     | Fee splitter|
    | signer      |    | vesting +   +---->| (trait-     |
    | operator    |    | settlement  |     |  based)     |
    +-------------+    +-------------+     +-------------+
```

### Contract Details

| Contract | What it does | Inspired by (StackingDAO) |
|----------|-------------|--------------------------|
| **dao** | Permission gate. Two whitelists: "protocols" (authorized contracts) and "admins" (authorized wallets). Every privileged function in the system calls `dao.check-is-protocol` or `dao.check-is-admin` before executing. Deployer is the initial admin. | `dao.clar` |
| **registry** | Central directory of signer pools. Tracks which signers are active, how much STX each gets (weight in basis points), per-pool commission rates, pool-owner revenue share, and delegate contract assignments. Multi-signer is a registry update, not a code change. | `data-pools-v1.clar` |
| **jstx-token** | SIP-010 fungible token ("Juiced STX", 6 decimals). Every transfer/mint/burn refreshes reward tracking via yield.settle-wallet first, so no one can game the reward timing. Claims sBTC rewards go through here too. | `ststxbtc-token.clar` |
| **share-data** | Data store for reward tracking. Holds the global reward-per-share counter, per-holder snapshots, tracked supply, and registered DeFi positions. Separated so yield logic can be upgraded without migrating data. | `ststxbtc-tracking-data.clar` |
| **vault** | The STX bank account. All deposited STX lives here. Only authorized contracts can deposit or withdraw. Simple by design -- deposit, withdraw, check balance. | `reserve-v1.clar` |
| **core** | User entry point. Deposit (STX in, jSTX out at 1:1). Init-withdraw (lock jSTX, get withdrawal NFT with unlock height). Withdraw (after unlock, burn NFT + jSTX, get STX back). | `stacking-dao-core-btc-v3.clar` |
| **yield** | Unified reward + distribution contract. Receives sBTC from signer pools, takes per-pool commission, then vests rewards linearly over ~2100 blocks as a function of block height (no keeper needed). Handles wallet settlement using cumulative-reward-per-share math (O(1) per holder). Also settles DeFi positions (jSTX in Zest still earns). | `rewards-v5.clar` + `ststxbtc-tracking.clar` |
| **commission** | Fee splitter. Takes the commission portion of sBTC rewards and sends it to the treasury. Implements a trait so governance can deploy a new commission strategy (e.g., add governance staker rewards) without touching the yield pipeline. | `commission-btc-v1.clar` |
| **pool** | PoX-4 signer operator contract. Each signer in the network gets their own deployed copy. Manages signer key + signature registration per cycle, calls pox-4 to lock STX and commit aggregated stake. The pool owner (signer operator) controls their own key material. | `stacking-pool-signer-v1.clar` |
| **helpers** | Multi-pool router. Routes STX to the correct signer pool based on registry weights. Core contract calls helpers, helpers calls the pool trait. When we add a new signer, helpers automatically routes to them. | `direct-helpers-v4.clar` |
| **withdraw-nft** | SIP-009 NFT for withdrawal receipts. Each NFT represents a claim on X STX after block height Y. Includes a built-in non-custodial marketplace: list your withdrawal position for sale if you don't want to wait. | `ststxbtc-withdraw-nft.clar` |
| **position-zest** | Zest DeFi adapter. Tells the share contract how much jSTX a user has deposited as collateral in Zest, so they still earn sBTC rewards on collateralized jSTX. ~10 lines. | `position-zest-v2.clar` |

### Traits

| Trait | Purpose |
|-------|---------|
| **sip-010-trait** | Standard fungible token interface (jSTX, sBTC) |
| **sip-009-trait** | Standard NFT interface (withdrawal receipts) |
| **commission-trait** | `(process uint)` -- swappable fee strategy |
| **position-trait** | `(get-balance principal)` -- DeFi adapter interface |
| **stacking-trait** | `(delegate-stx, revoke-delegate-stx, return-stx)` -- pool operator interface |

### Mocks (test-only, never deployed)

| Mock | Purpose |
|------|---------|
| **sbtc-mock** | Minimal SIP-010 sBTC with public mint for testing |
| **pox-4-mock** | Stubs pox-4 stacking functions (returns ok) |
| **zest-mock** | Minimal Zest lending pool (supply/withdraw/get-balance) |

## Multi-Signer Architecture

STX Juice is designed for multiple institutional signers from day 1, inspired by how StackingDAO delegates to 13 signers (ALUM Labs, Blockdaemon, Chorus One, Kiln, etc.).

### How it works

```
registry.clar
  |
  +-- active-pools: [pool-A, pool-B, pool-C]
  |
  +-- pool-weight:    pool-A = 5000 (50%), pool-B = 3000 (30%), pool-C = 2000 (20%)
  +-- pool-fee-rate:  pool-A = 500 (5%),   pool-B = 300 (3%)
  +-- pool-owner-cut: pool-A = { receiver: SP_SIGNER_A, share: 2000 }  (20% of commission)
  +-- pool-delegates: pool-A = [delegate-1, delegate-2, delegate-3]
```

- **Weights** control what percentage of total STX each signer receives (must sum to 10,000 bps)
- **Fee rate** is the protocol's commission on rewards from that pool (can differ per signer)
- **Pool owner cut** is the signer operator's revenue share of the commission
- **Delegates** are thin STX-holding contracts per pool (multiple per pool for graceful rotation)

### Adding a new signer

No contract upgrades needed. An admin calls:

```clarity
(contract-call? .registry set-active-pools (list .pool-a .pool-b .pool-new))
(contract-call? .registry set-pool-weight .pool-new u2000)
(contract-call? .registry set-pool-fee-rate .pool-new u400)
```

The helpers contract automatically routes STX to the new pool on the next cycle.

### Launch plan

Phase 1: Single signer (us or Fast Pool) -- pool weight = 10,000 (100%)
Phase 2: Add 2-3 institutional signers -- split weights
Phase 3: Full signer set with per-signer commission negotiation

## The PoX Cycle Problem (Why Signers Miss Cycles)

This is the operational challenge that StackingDAO has struggled with, and that we need to solve.

### The prepare phase

Every PoX cycle (~2,100 Bitcoin blocks, ~2 weeks), there is a **prepare phase** in the last 100 blocks before the next cycle starts. During this window, pool operators MUST:

1. Get the signer's key + authorization signature for the next cycle
2. Call `pool.set-signer-info(cycle, signer-key, signer-sig, ...)` on the pool contract
3. Call `pool.commit-stacking(cycle)` which calls `pox-4.stack-aggregation-commit-indexed`

If ANY of these steps are late -- the entire pool earns **zero rewards** for that cycle. There is no partial commit, no grace period, no retry.

### Why it's hard at scale

With 13 signers like StackingDAO:
- 13 signer keys to coordinate per cycle
- 13 pool contracts to update
- All within a ~100 block window (~16 hours)
- Each signer operator must generate and deliver their authorization signature on time

As Philip (StackingDAO lead dev) explained:

> "It is not just 2 TXs. There is quite some coordination going on to have signer signatures each cycle, make sure we delegate the right amount of stake to our signers and then there's the native pool which is also a lot more than 2 TXs at scale."

### Our mitigation plan

1. **Start with 1 signer** -- eliminates coordination complexity at launch
2. **Automated keeper** -- bot monitors the prepare phase and triggers transactions automatically
3. **Early warning system** -- alerts if signer info isn't registered N blocks before deadline
4. **Graceful degradation** -- if one signer in a multi-signer setup misses, only their share is affected (multi-signer is risk diversification)

## Key Differences from StackingDAO

| Aspect | StackingDAO | STX Juice (jSTX) |
|--------|------------|-------------------|
| Token model | Two tokens: stSTX (rebasing, STX yield) + stSTXbtc (fixed, sBTC yield) | One token: jSTX (fixed 1:1, sBTC yield only) |
| Reward delivery | stSTX: implicit via exchange rate. stSTXbtc: claimable sBTC | Claimable sBTC only |
| Shared pool | Both tokens share the same STX reserve and signer infrastructure | Single pool for jSTX |
| Naming | Version-suffixed (reserve-v1, rewards-v5, commission-btc-v1) | Clean names (vault, yield, commission) |
| Strategy | Complex on-chain allocation algorithm (strategy-v3-pools, strategy-v3-delegates, algo) | Off-chain keeper calculates, on-chain executes via helpers |
| Reward distribution | Keeper-triggered drips (30x per cycle) | Time-based vesting (no keeper for distribution) |
| Complexity | ~40+ contracts across v1/v2/v3 | 12 core contracts + 5 traits + 3 mocks |

### What we changed from StackingDAO

- **Merged yield + share into one contract** -- StackingDAO has separate reward routing (rewards-v5) and reward tracking (ststxbtc-tracking) because they route to two different token types (stSTX + stSTXbtc). We have one token, one destination, so the routing layer is unnecessary. Data store (share-data) remains separate for upgradeability.
- **Time-based vesting replaces keeper drips** -- instead of a keeper calling drip() 30 times per cycle, rewards vest linearly as a function of block height. `apply-vested` computes `total * elapsed / VESTING_BLOCKS` lazily on every settle. Same flash-mint protection, zero keeper dependency for distribution.

### What we kept from StackingDAO

- **Cumulative reward-per-share math** -- proven O(1) reward distribution
- **Withdrawal NFT marketplace** -- non-custodial trading of withdrawal positions
- **Commission trait** -- swappable fee strategies via governance
- **Multi-pool routing** -- helpers contract abstracts pool selection
- **DeFi position tracking** -- jSTX earns rewards even when used as collateral

### What we simplified

- **Single token** -- no stSTX equivalent, only jSTX (sBTC yield)
- **No on-chain strategy algo** -- off-chain keeper determines allocations
- **No version suffixes** -- contracts are named for what they do
- **Fewer layers** -- no data-core, data-direct-stacking, strategy-v3-algo, etc.
- **No governance token staking split in commission** -- StackingDAO passes a `staking-contract` through core into commission so protocol fees can be split between treasury and governance token stakers. We don't need this yet. Our fees-trait is designed so that a future fees contract can handle any split internally (treasury, governance stakers, burn, etc.) without changing core. When we launch a governance token, we deploy a new fees contract that distributes accordingly -- no protocol upgrade required.

## Research: Keeper-less sBTC Reward Flow

**Status: Open question -- needs validation with sBTC team**

### The idea (from friedger.btc)

Instead of a keeper converting BTC rewards to sBTC off-chain, set the pool's PoX reward address (`btc-address` in `pool.clar`) to the sBTC deposit address that maps to the yield contract's Stacks principal. Then:

1. Miners pay BTC rewards to the pox-addr (which IS the sBTC deposit address)
2. sBTC bridge sees the BTC deposit, mints sBTC to the yield contract
3. No keeper needed for BTC→sBTC conversion

### How the pox-addr works in PoX-4

- `pool.clar` stores `btc-address` as `{ version: (buff 1), hashbytes: (buff 32) }` -- a BTC address, not a Stacks principal
- This gets passed to `pox-4.stack-aggregation-commit-indexed` once per cycle
- Once committed, `stack-aggregation-increase` enforces the **same** pox-addr for that cycle
- But it can be set to a **different** address on the next cycle via `register-cycle-auth`

### The sBTC deposit address problem

The sBTC deposit address (from Emily API) is a taproot address derived from the current sBTC signer set. When signers rotate, the deposit address changes.

- **Within a cycle**: pox-addr is locked at commit time. If sBTC signers rotate mid-cycle, BTC rewards still go to the old deposit address. Question: does the bridge still honor deposits to a previous-rotation address?
- **Between cycles**: we can query Emily for the current deposit address and use it for the next cycle's commit. This part works cleanly.

### Potential fallback: own taproot key

If the sBTC deposit address is constructed as a taproot address using a BTC pubkey we control, we could potentially claw back BTC from a stale deposit address even after signer rotation. This depends on how Emily constructs the deposit address -- whether our key is part of the taproot spend path.

### Questions for Friedger / sBTC team

1. Does the sBTC deposit address stay valid for deposits after a signer rotation? (i.e., will BTC sent to a previous-rotation deposit address still get bridged?)
2. Can we get a deposit address that maps to a specific contract principal (not just an EOA)?
3. Is there a taproot key path that lets the depositor reclaim BTC if the bridge fails to process?
4. What's the expected signer rotation frequency relative to PoX cycle length (~2100 blocks)?

### Current approach (safe)

Keeper collects BTC from signer, converts to sBTC off-chain, calls `yield.receive-rewards()`. This works regardless of sBTC bridge behavior. The keeper-less approach is an optimization to explore, not a blocker.

## Development

```bash
clarinet check       # Validate all 22 contracts
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
