# PoX Cycle Operations

How the protocol manages PoX stacking cycles and the operational risks involved.

## The prepare phase

Every PoX cycle (~2,100 Bitcoin blocks, ~2 weeks), there is a **prepare phase** in the last 100 blocks before the next cycle starts. During this window, pool operators MUST:

1. Get the signer's key + authorization signature for the next cycle
2. Call `pool.register-cycle-auth(cycle, ...)` with signer key and signature
3. Call `pool.finalize-cycle(cycle)` which calls `pox-4.stack-aggregation-commit-indexed`

If ANY of these steps are late -- the entire pool earns **zero rewards** for that cycle. No partial commit, no grace period, no retry.

## Why it's hard at scale

With many signers:
- N signer keys to coordinate per cycle
- N pool contracts to update
- All within a ~100 block window (~16 hours)
- Each signer operator must generate and deliver their authorization signature on time

## Mitigation plan

1. **Start with 1 signer** -- eliminates coordination complexity at launch
2. **Automated keeper** -- bot monitors the prepare phase and triggers transactions automatically
3. **Early warning system** -- alerts if signer info isn't registered N blocks before deadline
4. **Graceful degradation** -- if one signer in a multi-signer setup misses, only their share is affected (multi-signer is risk diversification)

## Lock vs Extend vs Increase

- **Lock** (`lock-delegated-stx`): first-time PoX lock for a stacker. Can only be called when the stacker has no active lock.
- **Extend** (`extend-delegated-stx`): keeps STX rolling into the next cycle. Must use extend (not re-lock) while STX is locked.
- **Increase** (`increase-delegated-stx`): adds more STX mid-cycle to an already-locked stacker. The additional STX must already be delegated.
