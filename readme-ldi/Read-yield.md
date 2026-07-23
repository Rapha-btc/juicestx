# yield.clar - how settlement and reward distribution work

Companion read for `contracts/yield.clar` (+ `share-data.clar`, `jstx-token.clar`).
Modeled on StackingDAO's ststxbtc tracking/rewards contracts.

## What "settle" means

**Settle = pay out everything this wallet is owed up to this exact moment,
then take a fresh snapshot.**

The problem it solves: rewards are computed as "sBTC per jSTX held." If your
balance changes (buy, sell, mint, burn), the question "how much were you owed?"
depends on what balance you held during which period. Instead of tracking
history, the protocol enforces one rule:

> Your balance is never allowed to change until your pending rewards at the
> OLD balance are paid.

`settle-wallet(who)` does three things atomically:

1. Compute what the wallet is owed since its last settlement (at its old balance)
2. Transfer that sBTC to it, right now
3. Record a new snapshot: "settled at index X, balance Y"

That is why `jstx-token.clar` calls `settle-wallet` on every transfer (both
sides), mint, and burn, BEFORE the balance moves. After settlement the reward
clock restarts from zero at the new balance. There is no window where you hold
a new balance but carry old accruals, so no gaming:

- transferring jSTX to yourself before a distribution: useless
- flash-minting before a payout: useless
- buying right before rewards land: useless - the seller gets paid for the
  period they actually held

## Toy-number walkthrough

### Setup

Three users deposit STX, get jSTX 1:1:

```
Alice: 500 jSTX
Bob:   300 jSTX
Carol: 200 jSTX
-----------------
Supply: 1,000 jSTX      global-index = 0
```

Everyone's snapshot: `{ index: 0, balance: their balance }`.

### Cycle ends: 1.00 sBTC of rewards arrive

Emily mints 1.00 sBTC into the stacker. Keeper calls `sweep-stacker`:

```
1.00 sBTC gross
- 0.05  signer fee (5%)  -> paid to signer immediately
- 0.05  protocol fee     -> commission pot (treasury later)
-------------------------
0.90 sBTC -> reward bucket, vesting starts (2,100 blocks)
```

Nothing hits the index yet. The 0.90 drips in over ~one cycle.

### Block 1,050 - halfway through vesting

Vested so far: 0.90 * (1050/2100) = 0.45 sBTC. Index bumps by vested/supply:

```
global-index = 0.45 / 1,000 = 0.00045 sBTC per jSTX
```

Nobody has been paid yet - the index just says what each jSTX has EARNED:

```
owed = balance * (index - your snapshot index)
Alice: 500 * 0.00045 = 0.225 sBTC pending
Bob:   300 * 0.00045 = 0.135 sBTC pending
Carol: 200 * 0.00045 = 0.090 sBTC pending
                       ----- = 0.450 (checks out)
```

### Bob sells 300 jSTX to Dave - this is where SETTLE fires

Before a single token moves, `settle-wallet` runs for BOTH:

```
Bob:  paid 0.135 sBTC now.   New snapshot { index: 0.00045, balance: 0 }
Dave: paid 0 (owed nothing). New snapshot { index: 0.00045, balance: 300 }
```

Bob walks away with the yield for the exact period he held. Dave's clock
starts at today's index - he cannot claim anything from before he bought.
That is the whole trick: the snapshot marks "you have been paid up to here."

### Block 2,100 - fully vested

Remaining 0.45 vests, index goes to 0.00090. Pending now:

```
Alice: 500 * (0.00090 - 0)       = 0.450   (never settled, full ride)
Dave:  300 * (0.00090 - 0.00045) = 0.135   (only the second half)
Carol: 200 * (0.00090 - 0)       = 0.180
Bob:   0   * anything            = 0       (already cashed out 0.135)
                                   -----
                          total  = 0.900   every sat accounted for
```

Alice does nothing? Fine - her 0.450 sits as pending until ANY touch (a
claim, receiving a transfer) pays it out. No keeper needed for distribution;
the index math self-serves.

### Why the vesting drip matters (in numbers)

Without it: a whale mints 9,000 jSTX one block before the sweep, supply
becomes 10,000, and he instantly captures 90% of a full cycle's rewards he
never stacked for, then exits. With the drip, holding 1 block earns 1 block's
worth (0.90/2100 ~ 0.0004 sBTC across everyone) - flash-minting earns dust.

### The one-line summary

> The index counts "sBTC ever earned per jSTX." Your snapshot marks where you
> have been paid up to. Pending = balance * (index - snapshot) - and no
> balance may change until pending is paid.

## The three mechanisms in yield.clar

### 1. The global index (per-share accounting)

One number, `global-index` (in `share-data.clar`), = total sBTC ever
distributed per jSTX since genesis, scaled by 1e10 (`INDEX_SCALE`).

When R sBTC gets distributed across supply S, the index bumps by R * 1e10 / S.
Each wallet stores a snapshot of the index at its last settlement. Then:

```
pending = balance * (global-index - snapshot-index) / INDEX_SCALE
```

O(1) per wallet. No loops over holders, no per-holder distribution txs.
Standard reward-per-share pattern (same family as MasterChef / Synthetix
staking rewards).

### 2. Linear vesting (the drip)

When a keeper sweeps a stacker's sBTC (`sweep-stacker`, once per cycle), the
net amount does NOT hit the index at once. It goes into a per-cycle
`reward-bucket` that vests over `VESTING_BLOCKS` = 2100 burn blocks (~one PoX
cycle). The vested fraction is pure arithmetic on `burn-block-height`:

```
vested = total * min(elapsed / 2100, 1)
```

No keeper drips it out. Any settle lazily calls `apply-vested`, which computes
"how much SHOULD be vested by now vs how much has already been applied" and
bumps the index by the difference. The chain's own clock does the dripping;
if nothing new has vested it is a no-op.

Why vest at all: if a whole cycle's rewards hit the index in one block,
someone could mint jSTX one block before the sweep, capture a full cycle's
yield, and exit. With vesting you only earn for the blocks you actually held
through.

### 3. The fee waterfall on the way in

During a sweep, fees peel off before anything vests:

1. **Signer fee** - the stacker contract pays it directly to the signer at the
   rate set on that signer's pool contract (cap 10%)
2. **Protocol fee** - yield takes it on what it received (admin-set,
   `MAX_PROTOCOL_FEE` cap 10%) into a per-cycle commission pot, flushed to the
   treasury separately via `flush-commission`

The two fees are independent - neither party needs the other's permission.
Only the net enters the vesting bucket.

## One flow, concretely

```
BTC rewards -> Emily mints sBTC into stacker
  -> keeper calls sweep-stacker (once per cycle)
     -> signer fee paid at source, protocol fee held back
     -> net parks in the cycle's reward-bucket (vesting starts)
  -> over the next ~2100 blocks, ANY transfer/mint/burn/claim anywhere:
     -> apply-vested nudges global-index up to its correct block-height value
     -> that wallet gets paid balance * index-delta
     -> its snapshot resets
```

Hold and do nothing? Pending just accumulates. `claim-rewards` on jstx-token
(or any incoming transfer) pays it whenever touched. `get-unclaimed` shows the
projected amount without settling.

## DeFi positions

`settle-defi-position` is the same math, but the balance comes from a
registered position adapter (e.g. `position-zest.clar` reporting jSTX supplied
to Zest), added on top of the wallet snapshot balance. Adapters must be
whitelisted in `share-data.defi-adapters`.

## Data layout (share-data.clar)

- `global-index` (uint, 1e10 scale) - cumulative rewards per jSTX
- `tracked-supply` (uint) - supply as of the last settle
- `wallet-snapshot` (map principal -> { index, balance })
- `defi-adapters` (map principal -> bool)

Logic (yield) and state (share-data) are split so the logic contract can be
upgraded without a data migration.
