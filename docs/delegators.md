# Delegate to STX Juice

**Pool address:** `SP1JAG6TV2XRYFGJN7CAAN6Z3CEW2YMZWMHJAJV91`
**Fees:** 0% on sBTC distribution
**Lock:** ~15 days per cycle, auto-rolls (revoke anytime via Leather)

## Steps (single tx from your wallet)

1. Go to **https://earn.leather.io** → "Stack in a pool".
2. Connect your wallet (Leather, Xverse, or Asigna for multisigs).
3. Scroll to **Custom Pool** and enter:

   | Field | Value |
   |---|---|
   | Pool address | `SP1JAG6TV2XRYFGJN7CAAN6Z3CEW2YMZWMHJAJV91` |
   | Amount | how much STX to stack — no per-user minimum (pool aggregate must clear 150k STX, which is already met) |
   | Duration | **Indefinite permission** (12 cycles max per lock; revoke any time before re-up) |

4. Click **Confirm and pool**, sign in your wallet.

Done. You'll see "Waiting on pool" — that's the pool admin's job from here.

## What happens next

- Within ~24 hours (before next cycle starts), STX Juice locks your STX and registers it for rewards.
- BTC rewards land on the pool's reward address each cycle.
- Rewards distributed to delegators as sBTC with **no fee**.
- New cycle every ~15 days; your delegation auto-renews until you revoke.

## Unstacking

Revoke delegation via Leather → "Stop pooling". Your STX unlocks at the end of the current cycle (up to ~15 days). You can re-delegate any time after.

## Help

If something looks wrong on-chain, check the pool's status on the explorer:
https://explorer.hiro.so/address/SP1JAG6TV2XRYFGJN7CAAN6Z3CEW2YMZWMHJAJV91?chain=mainnet
