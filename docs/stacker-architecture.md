# Stacker Architecture

## Overview

The stacker contract is the delegate that holds STX and interacts with PoX-4 to earn stacking yield. Each signer in the STX Juice network has **multiple stacker contracts** deployed, all delegating to the same signer key.

## Why Multiple Stackers Per Signer

PoX does not allow decreasing the amount of STX stacked by a delegate. You can only stop a delegate entirely -- all its STX unlocks at the end of the cycle.

If we had 1 stacker with 10M STX locked and needed to free 2M for withdrawals, we'd have to unlock all 10M, losing an entire cycle of yield on 8M STX that didn't need to move.

With 3 stackers (3.3M each), we stop the smallest one that covers the withdrawal. The other two keep earning. Only 3.3M misses a cycle instead of 10M.

```
Signer A
  |-- stacker-a1  (3,333,333 STX locked)  <-- stop this one
  |-- stacker-a2  (3,333,333 STX locked)  <-- keeps earning
  |-- stacker-a3  (3,333,334 STX locked)  <-- keeps earning

Need 2M for withdrawals:
  - Stop stacker-a1 -> 3.3M unlocks at cycle end
  - 2M goes to withdrawal reserves
  - 1.3M re-delegated next cycle
  - Lost yield: 1 cycle on 3.3M (not 10M)
```

## STX Lifecycle

```
User deposits STX
       |
       v
   [vault.clar]  -- holds all pending STX
       |
       | allocation.execute-allocation (per cycle)
       v
   [stacker.clar] -- holds STX waiting for or locked in PoX
       |
       | signer calls lock-delegated-stx (cycle 1) or extend-delegated-stx (cycle 2+)
       | signer calls increase-delegated-stx (if more STX arrived)
       | signer calls finalize-cycle (commit with signer auth)
       v
   [PoX-4]  -- STX locked, earning sBTC yield
       |
       | cycle ends, STX unlocks (only if not extended)
       v
   [stacker.clar] -- unlocked STX sitting in contract
       |
       | allocation.return-excess calls stacker.stx-transfer
       v
   [vault.clar]  -- STX available for withdrawals or re-stacking
```

## PoX Delegation Model

The stacker contract is both the **STX holder** and the **pool operator** in PoX terms.

### Roles

| PoX Role | Who | What they do |
|----------|-----|-------------|
| Delegator | stacker contract | Holds STX, calls `delegate-stx` to authorize itself as pool operator |
| Pool operator | stacker contract (as-contract) | Calls `delegate-stack-stx`, `delegate-stack-extend`, `delegate-stack-increase` |
| Signer | external principal | Registers cycle auth (keys/sigs), triggers lock/extend/finalize on the stacker |
| Protocol | dao-authorized callers | Controls `delegate-stx` and `revoke-delegate-stx` — the signer can't self-authorize |

### PoX-4 operations

| PoX-4 call | Our function | Gated by | Purpose |
|---|---|---|---|
| `delegate-stx` | `delegate-stx(amount)` | protocol (dao) | Authorize stacking — must be called first |
| `revoke-delegate-stx` | `revoke-delegate-stx()` | protocol (dao) | Revoke authorization — blocks future locks |
| `delegate-stack-stx` | `lock-delegated-stx(stacker, ustx, start, period)` | signer | Initial lock into PoX |
| `delegate-stack-extend` | `extend-delegated-stx(stacker)` | signer | Extend existing lock by 1 cycle |
| `delegate-stack-increase` | `increase-delegated-stx(stacker, increase-by)` | signer | Add more STX to existing lock |
| `stack-aggregation-commit-indexed` | `finalize-cycle(cycle)` | signer | Commit aggregated stake with signer auth |

### Delegation lifecycle (protocol-controlled)

```
Protocol calls delegate-stx(amount)
  → stacker as-contract calls pox-4.delegate-stx
  → delegate-to = stacker itself (it's its own pool operator)
  → pox-addr = btc-address (Emily-registered, locked in)
  → signer can now lock STX via lock-delegated-stx

Protocol calls revoke-delegate-stx()
  → stacker as-contract calls pox-4.revoke-delegate-stx
  → signer can no longer lock or extend
  → already-locked STX still unlocks at cycle end
```

The protocol controls delegation. The signer controls locking within that delegation.

### Lock vs Extend vs Increase

PoX-4 has three distinct operations for managing locked STX:

| Operation | When to use | What happens |
|-----------|------------|--------------|
| `lock-delegated-stx` → `delegate-stack-stx` | First time, or after STX fully unlocked | Locks unlocked STX into PoX. Fails if STX is already locked. |
| `extend-delegated-stx` → `delegate-stack-extend` | Every subsequent cycle | Extends an existing lock by 1 cycle. Works while STX is still locked — no gap, no missed yield. |
| `increase-delegated-stx` → `delegate-stack-increase` | More STX arrives mid-cycle | Increases the locked amount without touching the lock period. Used when allocation sends more STX. |

**Why extend instead of re-lock?** Once STX is locked, `delegate-stack-stx` fails — you can't lock already-locked STX. If you wait for it to unlock first, you miss a cycle of yield. `delegate-stack-extend` keeps the lock rolling with no gap.

**Why increase?** `delegate-stack-stx` sets the initial amount. If more STX arrives later (e.g. new deposits allocated to this stacker), you can't re-lock at a higher amount. `delegate-stack-increase` adds to the existing lock.

### Per-cycle signer flow

```
Cycle 1 (first time):
  1. register-cycle-auth (signer key + sig)
  2. lock-delegated-stx (initial lock via delegate-stack-stx)
  3. finalize-cycle (commit aggregated stake)

Cycle 2+ (ongoing):
  1. register-cycle-auth (signer key + sig)
  2. extend-delegated-stx (extend lock 1 more cycle)
  3. increase-delegated-stx (if more STX was allocated)
  4. finalize-cycle (commit aggregated stake)

Winding down:
  1. Protocol calls revoke-delegate-stx
  2. Signer can't extend or lock
  3. STX unlocks at cycle end
  4. allocation.return-excess moves STX back to vault
```

## Reward Flow (sBTC)

Each stacker's `btc-address` is registered with the Emily API (sBTC bridge). PoX miners pay BTC to this address every block throughout the cycle.

### How rewards arrive

1. Miners pay BTC to the stacker's registered BTC address (every block)
2. Emily detects the deposit and mints sBTC into the stacker contract on Stacks
3. sBTC accumulates in the stacker throughout the cycle

### How rewards are distributed

Rewards are swept **one cycle behind**: the keeper sweeps cycle N's sBTC during cycle N+1.

```
Cycle N:    miners pay BTC every block → Emily mints sBTC into stacker contracts
Cycle N+1:  keeper calls yield.sweep-stacker(stacker, N) for each stacker
            → stacker.release-rewards transfers all sBTC to yield
            → stacker reports { amount, fee-rate, signer-principal }
            → yield pays signer fee directly to signer
            → yield deducts protocol fee into bucket (for flush-commission)
            → net sBTC stored in reward-bucket[N]
            → rewards vest linearly over 2100 blocks (~1 cycle)
            → jSTX holders claim as it vests via settle-wallet
```

### Why sweep one cycle behind (not mid-cycle)

Miners pay BTC to the stacker's address throughout the entire cycle. If we swept mid-cycle:

- **Partial rewards**: We'd only capture BTC paid so far, not the full cycle. The remaining sBTC would leak into the next cycle's sweep, skewing per-cycle accounting.
- **Flash-mint gaming**: Someone could mint jSTX, trigger a sweep of whatever sBTC is there, claim a disproportionate share, then burn jSTX. The vesting mechanism mitigates this, but sweeping a complete cycle removes the attack surface entirely.
- **Uneven attribution**: With multiple stackers, some might have more sBTC than others at any given moment depending on block timing. Waiting for the full cycle ensures each stacker's contribution reflects its actual locked STX proportion.

By waiting until cycle N is complete, we know all BTC has been paid, all sBTC has been minted, and the sweep captures the full cycle's yield for each stacker.

### Per-stacker accounting

Yield tracks gross sBTC contributed per stacker in `stacker-yield-total` (on-chain map). Each `sweep-stacker` call also emits a print event with the stacker, gross amount, fee, and net -- enabling off-chain dashboards to show per-signer yield performance.

### Fee structure

Two independent fees, set by different parties:

| Fee | Set by | Where | Cap |
|-----|--------|-------|-----|
| Signer fee | Signer (`stacker.set-signer-fee`) | Paid directly to signer on sweep | 10% (1000 bps) |
| Protocol fee | Admin (`yield.set-protocol-fee`) | Stored in bucket, flushed to treasury | 10% (1000 bps) |

When `yield.sweep-stacker` runs:

```
gross sBTC from stacker
  - signer fee (e.g. 3%) → paid to signer immediately
  = after-signer amount
  - protocol fee (e.g. 5%) → stored in bucket for flush-commission
  = net rewards → vesting bucket for jSTX holders
```

Neither party needs the other's permission. The signer sets their rate, the protocol sets its rate. Both are transparent on-chain.

### Advantage over other liquid stacking protocols

In other protocols, the signer must manually sell BTC for STX and deposit it into the correct delegate contract each cycle. If they're late or make a mistake, stakers miss rewards.

With STX Juice, the signer does nothing on the reward side. Emily mints sBTC automatically, yield sweeps it. The signer just registers their key each cycle and earns their fee.

## Withdrawal Flow

When a user requests withdrawal:

1. `core.clar` calls `vault.reserve(amount)` -- earmarks STX in vault
2. If vault has enough pending STX, withdrawal completes immediately
3. If not, user waits for next cycle:
   - `vault.get-pending-balance` returns less (pending = balance - reserved)
   - `allocation.calculate-stacker-target` sees lower total-stackable
   - Operator picks which stacker(s) to stop to free up STX
   - At cycle end, stopped stacker's STX unlocks
   - `allocation.return-excess` sends it back to vault
   - Withdrawal completes

## How This Relates to User Delegation

User delegation preferences (in `delegation.clar`) are **intents**, not instant actions:

- Users say "I want my STX with signer X" via `delegation.assign`
- This feeds into `allocation.calculate-stacker-target` which blends user preferences with admin weights
- Allocation runs once per cycle to rebalance STX across stackers
- Between cycles, actual allocations may not match intents because STX is locked in PoX

The multi-stacker split is invisible to users. They pick a signer; the protocol decides how to split across that signer's stacker contracts.

## Comparison with StackingDAO

| Concept | StackingDAO | STX Juice |
|---------|-------------|-----------|
| Signer pool contract | stacking-pool-signer-v1 | (not needed -- stacker handles auth directly) |
| Delegate contract | stacking-delegate-1 | stacker.clar |
| Delegates per signer | 3 (delegate-1-1, 1-2, 1-3) | 2-3 per signer (stacker-1a, 1b, 1c) |
| Handler/orchestrator | delegates-handler-v1 | allocation.clar (combined) |
| Strategy (per pool) | strategy-v3-pools-v1 | allocation.calculate-stacker-target |
| Strategy (per delegate) | strategy-v3-delegates-v1 | allocation.clar targets individual stackers directly |
| STX holder | reserve-v1 | vault.clar |
| Outflow algorithm | strategy-v3-algo-v1 (lowest-combination) | Off-chain keeper picks which stacker(s) to stop |

### Key Differences

1. **Simpler hierarchy**: StackingDAO has pool -> delegates -> PoX. We have stacker -> PoX. Each stacker handles both delegation and signer auth.

2. **Self-delegating**: Our stacker delegates to itself (it's its own pool operator). StackingDAO delegates to an external pool contract. Ours is simpler — fewer moving parts.

3. **Independent fees**: StackingDAO routes all fees through the pool. We have two independent fees (signer + protocol) — no coordination needed, both transparent on-chain.

4. **No accounting callbacks**: StackingDAO needs `delegate-stx`/`revoke-delegate-stx` callbacks on their delegates for STX accounting (because rewards come back as STX, same token as deposits). Our rewards are sBTC (different token), so no ambiguity — allocation tracks totals directly.

5. **Outflow algorithm**: StackingDAO has an on-chain `calculate-lowest-combination` algorithm. We rely on the keeper to pick which stacker(s) to stop. On-chain algo is a future improvement.

## Deployment

For each signer, deploy multiple copies of `stacker.clar`:

```toml
# Clarinet.toml
[contracts.stacker-1a]
path = "contracts/stacker.clar"
clarity_version = 4
epoch = "latest"

[contracts.stacker-1b]
path = "contracts/stacker.clar"
clarity_version = 4
epoch = "latest"

[contracts.stacker-1c]
path = "contracts/stacker.clar"
clarity_version = 4
epoch = "latest"
```

Register each in the registry with equal weights. Allocation treats them as independent stackers.

## Future Improvements

- **On-chain outflow algorithm**: Automatically pick which stacker(s) to stop based on locked amounts and withdrawal needs (like StackingDAO's lowest-combination algo)
