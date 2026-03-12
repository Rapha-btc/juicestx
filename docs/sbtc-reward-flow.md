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

The pool's `btc-address` is registered with Emily so that when BTC rewards arrive, Emily automatically mints sBTC into the stacker contract.

### Open Questions

- If sBTC signers rotate mid-cycle, do deposits to the previous-rotation address still get bridged?
- What's the expected signer rotation frequency relative to PoX cycle length (~2100 blocks)?

## Fallback

If Emily minting fails for any reason, a keeper can manually convert BTC to sBTC off-chain and call `yield.receive-rewards()`. The protocol works either way.
