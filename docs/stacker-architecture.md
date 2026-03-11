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
       | operator calls lock-delegator + finalize-cycle
       v
   [PoX-4]  -- STX locked, earning sBTC yield
       |
       | cycle ends, STX unlocks
       v
   [stacker.clar] -- unlocked STX sitting in contract
       |
       | allocation.return-excess (if needed)
       v
   [vault.clar]  -- STX available for withdrawals or re-stacking
```

## Per-Cycle Operator Flow

Each PoX cycle (~2 weeks), the operator must:

1. **Register auth** -- `stacker.register-cycle-auth` with signer key + signature. Must happen before the prepare phase (~100 blocks before cycle end). Missing this = stacker misses the cycle.

2. **Run allocation** -- `allocation.execute-allocation` for stackers that need more STX, `allocation.return-excess` for stackers that have too much. This moves STX between vault and stacker contracts.

3. **Lock STX** -- `stacker.lock-delegator` calls `pox-4.delegate-stack-stx` to lock each stacker's STX into PoX.

4. **Finalize** -- `stacker.finalize-cycle` calls `pox-4.stack-aggregation-commit-indexed` to commit the total stacked amount with the signer's authorization.

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
            → stacker.release-rewards transfers all sBTC to yield, reports fee rate
            → yield deducts signer fee (operator cut + protocol commission)
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

Each signer sets their fee rate on their stacker contract (`set-signer-fee`, in basis points). When yield sweeps:

1. **Signer fee** is calculated from gross sBTC (e.g. 500 bps = 5%)
2. **Operator cut** (from registry) determines what share of the fee goes to the signer operator vs protocol treasury
3. **Net rewards** (gross - fee) go into the vesting bucket for jSTX holders
4. **Protocol commission** accumulates in the bucket, flushed to treasury via `flush-commission`

If signer fee is u0, users get 100% of yield. Signers can turn on fees at any time.

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

2. **Allocation tracking**: StackingDAO tracks `stx-stacking` in the reserve. We track `total-allocated` in allocation.clar, keeping the vault simple.

3. **Outflow algorithm**: StackingDAO has an on-chain `calculate-lowest-combination` algorithm. We rely on the operator to pick which stacker to stop. On-chain algo is a future improvement.

4. **Reward handling**: StackingDAO handles rewards per delegate via `delegates-handler-v1`. We handle rewards in `yield.clar` separately.

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
