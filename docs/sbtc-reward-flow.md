# sBTC Reward Flow

How BTC stacking rewards become sBTC in jSTX holder wallets.

## Current Flow

```
BTC rewards arrive at pool's pox-addr (registered with Emily)
       |
       v
Emily bridge mints sBTC into stacker contracts automatically
       |
       v
yield.sweep-stacker pulls sBTC from each stacker
       |
       +---> stacker pays signer fee (set on pool contract)
       +---> yield takes protocol commission → commission.clar → treasury
       |
       v
yield vests remaining sBTC linearly over ~2100 blocks
       |
       v
jSTX holders claim sBTC proportional to their balance
```

## How pox-addr Works in PoX-4

- `pool.clar` stores `btc-address` as `{ version: (buff 1), hashbytes: (buff 32) }`
- Passed to `pox-4.stack-aggregation-commit-indexed` once per cycle
- Once committed, `stack-aggregation-increase` enforces the **same** pox-addr for that cycle
- Can be set to a **different** address on the next cycle via `register-cycle-auth`

## Emily Bridge Integration

The pool's `btc-address` is a taproot address obtained from the Emily API. When BTC rewards arrive at this address, Emily automatically mints sBTC into the stacker contract.

The taproot address is derived from a pubkey we provide to Emily. This matters for the signer rotation edge case below.

## sBTC Signer Rotation Mid-Cycle

If sBTC signers rotate mid-cycle, the deposit address registered with Emily may change. Since pox-addr is locked at commit time, BTC rewards still go to the old address.

**Best case**: the sBTC bridge still honors deposits to the previous-rotation address and mints sBTC normally. No action needed.

**Fallback**: because the taproot address was created using our pubkey, we can claw back BTC that wasn't processed by the bridge via the taproot spend path. This is a safety net, not the expected flow.

**To validate with friedger**: is this understanding correct? Does the taproot key path we provided to Emily give us reclaim capability if the bridge doesn't process a deposit after signer rotation?

## Manual Fallback

If Emily minting fails for any reason, a keeper can manually convert BTC to sBTC off-chain and call `yield.receive-rewards()`. The protocol works either way.
