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
`reward-bucket` that vests linearly across that cycle's own PoX burn window
(~2100 blocks on mainnet, read from pox-4). The vested fraction is pure
arithmetic on `burn-block-height`:

```
vested = total * min(elapsed-in-window / window-length, 1)
```

Past the window's end this clamps to the full total, so a late apply always
pays out 100% - no remainder can strand (see the FIXED GAP section).

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

## How the reward bucket plays into this

The bucket is the staging area between "sBTC arrived" and "sBTC is in the
index" - it is what makes the drip possible.

### What it holds

One bucket per cycle (`reward-bucket` map):

```
{
  total-sbtc:      0.90    ;; net rewards parked for this cycle
  vested-sbtc:     0.45    ;; how much has ALREADY been pushed into the index
  commission-sbtc: 0.05    ;; protocol fee waiting for flush-commission
}
```

The vesting clock is NOT stored in the bucket: it is the cycle's own PoX
burn window `[cycle-start, next-cycle-start)`, read from pox-4. See the
FIXED GAP section below for why.

### Its job in the flow

Without a bucket, sweep would do `index += 0.90/supply` in one block -
instant distribution, flash-mint exploitable.

With the bucket, sweep just PARKS the 0.90. The index has not moved. Then
the bucket acts as a slow-release valve (`apply-vested`, called at the top
of every settle):

```
window           = [cycle-start, next-cycle-start)   from pox-4
should-be-vested = total * elapsed-in-window / window-length
                   (clamped to total once the window has ended)
newly-vested     = should-be-vested - vested-sbtc     <- the bucket's memory
index           += newly-vested / supply
vested-sbtc      = should-be-vested                   <- remember we applied it
```

`vested-sbtc` is the crucial field: a high-water mark of what has already
been applied, so no matter how many times settlement fires (or how
irregularly), each sat enters the index exactly once. Ten settles in one
block: nine are no-ops. No settle for 500 blocks: the next one catches up
the whole 500 blocks' worth in one bump.

Division of labor:

- **Bucket**   = time-release of the cycle's total (WHEN rewards enter the index)
- **Index**    = cumulative per-share earnings (HOW they are split)
- **Snapshot** = per-wallet paid-up-to marker (WHO has been paid)

Two more roles: multiple stackers swept in the same cycle accumulate into the
same bucket and share that cycle's vesting window, and the bucket carries the
commission pot until `flush-commission` empties it to treasury.

### FIXED GAP: stranded remainder on cycle rollover

The original draft vested from a sweep-time `start-height` over a fixed 2100
blocks, and `apply-vested` only ever ran on `active-cycle`. Since the next
sweep lands ~2100 blocks after the previous one, the old bucket's tail could
still be unvested when `active-cycle` flipped - and nothing would ever apply
that remainder. Stranded sBTC, no recovery function, borderline every cycle.

StackingDAO's rewards-v5 never had this bug: their buckets are addressed by
cycle number forever (`process-rewards(cycle)` takes the cycle as a
parameter), and the vesting window is the cycle's own PoX calendar with a
clamp - any call after the window's end pays out 100% of what is left.

yield.clar now follows that shape:

1. **Calendar window, not sweep clock** - `get-vested-amount(cycle)` measures
   against the cycle's own burn window `[cycle-start, next-cycle-start)` via
   pox-4 `reward-cycle-to-burn-height`, and CLAMPS to the full total once the
   window has ended. A late apply always reaches 100%. (`start-height` is
   gone from the bucket tuple.)
2. **Auto-finalize on rollover** - `sweep-stacker` calls
   `apply-vested(active-cycle)` BEFORE flipping to the new cycle. The old
   window has ended by then, so the clamp pays out its full remainder first.
   It also asserts `cycle` equals the current PoX cycle, so active-cycle can
   only move forward in step with the calendar.
3. **Permissionless catch-up** - public `apply-cycle(cycle)` lets anyone push
   any bucket's vested remainder into the index (mirror of StackingDAO's
   per-cycle process-rewards). Recovery path if sweeps ever skip a cycle.

Note the ordering detail in sweep-stacker: the bucket is read AFTER
apply-vested runs, so a second sweep in the same cycle can never clobber a
freshly bumped `vested-sbtc` with a stale copy.

Remaining behavior to know: if the keeper sweeps late (mid-window), the
already-elapsed fraction vests immediately at the first settle - same as
StackingDAO's past-intervals catch-up. Sweep promptly at cycle start.

### Why sweep applies `active-cycle`, not `cycle`

In sweep-stacker the finalize line reads the VAR, not the param:

```clarity
(try! (apply-vested (var-get active-cycle)))   ;; active-cycle still OLD here
...
(var-set active-cycle cycle)                   ;; only NOW does it become cycle
```

Two cases when a sweep lands:

- **Same cycle** (second/third stacker swept): active-cycle already equals
  cycle, so the call is just the normal lazy apply. Harmless, and it
  guarantees the bucket read that follows is fresh.
- **First sweep of a NEW cycle** (the one that matters): active-cycle still
  holds the previous cycle. That old bucket's window has ended, so
  apply-vested hits the clamp and pays its FULL remainder into the index -
  the finalize step. THEN the pointer flips.

If it read `(apply-vested cycle)` instead: on a new cycle the new bucket
does not exist yet (no-op), the old bucket is abandoned with its tail
unvested, and once the pointer flips settles only ever look at the new
cycle - the stranding bug reintroduced in one keystroke.

Mnemonic: that line means "close the old book before opening the new one" -
and you can only close the old book while active-cycle still points at it.

### Does the current-cycle assert strand a forgotten sweep? No.

**TLDR in laymen terms: the sBTC is not labeled with a cycle - it is just
cash sitting in the stacker until someone sweeps it.**

The sweep grabs whatever balance the stacker holds right now and drops it
into the current cycle's drip window. Miss a sweep? The sats wait patiently;
next cycle's sweep scoops them up and they drip out then instead. Late by a
cycle, lost never.

The assert only forbids MISLABELING: without it a keeper could stamp a batch
with an old cycle (window already over -> the whole amount dumps into the
index instantly, defeating the anti-flash-mint drip) or a future one (funds
parked in a window that has not opened). "Whatever you sweep goes into
TODAY's window" is the one labeling that is always safe.

Worst case of a missed sweep: yield arrives one cycle late, to whoever holds
jSTX during that later window. A timing shift, not a loss.

### The longer version

`sweep-stacker` asserts `cycle` equals the current PoX cycle. This does NOT
mean un-swept rewards from a past cycle are lost:

- The sweep does not pull "cycle N's rewards" - it pulls WHATEVER sBTC is
  sitting in the stacker right now (`release-rewards` reads the live
  balance). sBTC in a stacker is never cycle-tagged.
- The `cycle` param only answers "which vesting window does this batch
  join," not "which cycle earned it."
- Forget to sweep during cycle N? The sats sit safely in the stacker; the
  next sweep in cycle N+1 scoops them into bucket N+1 and they vest across
  that window instead.

The assert protects the BOOKKEEPING, not the funds: it stops a keeper from
labeling a batch with a past cycle (would resurrect an ended window and
instant-vest) or a future cycle (would park funds in a window that has not
opened), and it guarantees active-cycle only moves forward in step with the
PoX calendar.

Only side effect of a missed sweep: yield lands one cycle late, and it is
distributed to whoever holds jSTX during the LATER window - a small fairness
shift, not a loss. Same behavior as StackingDAO.

TLDR: sBTC waits in the stacker until swept, and always joins the current
window - a forgotten sweep delays yield by a cycle, strands nothing.

## FIXED transcription bug: settle AFTER the move, not before

The original jstx-token draft settled BEFORE moving tokens (transfer, mint,
burn all read balances pre-operation, then moved). The intuition "pay
rewards before the balance changes" sounds right but is wrong: pending is
computed from the wallet's STORED SNAPSHOT, never from the balance passed
in. So settling before vs after does not change what the old period pays -
what changes is what the NEW snapshot records. Pre-op reads store STALE
balances:

- **transfer**: the sender's snapshot kept their full pre-transfer balance,
  so a seller kept earning yield on tokens they no longer owned until their
  next touch, while the buyer earned nothing on them. Wrong attribution.
- **mint**: the recipient's snapshot and tracked-supply excluded the new
  tokens. Fresh deposits earned NOTHING until the wallet's next touch -
  first the old holders absorbed their share, then (once tracked-supply
  refreshed) the share fell to nobody as unclaimable index dust.

StackingDAO's ststxbtc-token-v2 does it correctly: `ft-transfer?` /
`ft-mint?` / `ft-burn?` FIRST, then refresh with post-operation
`ft-get-balance` / `ft-get-supply`. The old period is still paid correctly
(snapshot balance is the old one), and the new snapshot matches reality.

jstx-token.clar now follows their order. Rule to remember: **the snapshot
must always record the post-operation balance; the payout takes care of
itself because it reads the previous snapshot.**

### The one-line mental model

> Settle pays the OLD snapshot, then records the POST-transfer balance as
> the new baseline.

settle-wallet does two jobs in one call:

1. **Pay the past** - backward-looking, computed from the STORED snapshot
   (`pending = snap-balance * index-delta`). Order-independent: the transfer
   cannot shrink this payout, because the snapshot still holds the old
   balance no matter what just happened to the live balance.
2. **Register the future** - forward-looking, the `current-balance` param
   becomes the new snapshot. This is the ONLY thing the passed balance is
   used for, so it must be the balance as it will be from now on:
   post-operation.

Numbers: Bob snapshot { index: 0.00040, balance: 300 }, index now 0.00050,
he sends all 300 to Dave.

```
transfer 300 -> Dave                       (move first)
settle Bob: pending = 300 * 0.00010 = 0.030 sBTC   <- SNAPSHOT balance, paid in full
            new snapshot { 0.00050, balance: 0 }    <- post-transfer truth
settle Dave: pending = 0 (his old snapshot)
            new snapshot { 0.00050, balance: 300 }
```

Bob is paid exactly the same 0.030 as settle-first would have paid - but
the books now match reality, so every FUTURE index bump goes to Dave, who
owns the tokens, not to Bob, who sold them.

## Who can call settle-wallet - and the honest-balance assumption

`settle-wallet(who, current-balance, total-supply)` TRUSTS its inputs: the
caller reports the wallet's balance and the total supply, and whatever is
passed becomes the new snapshot / tracked-supply. The security model is
therefore "only code that reads the real ledger may report it":

- The check is `check-is-authorized contract-caller` - only DAO-authorized
  CALLERS get in. In the intended flow that is `jstx-token`, which always
  passes the live `ft-get-balance` / `ft-get-supply`. (Admins are a separate
  map; `check-is-admin` plays no role here.)

### FOOTGUN: the deployer EOA is authorized at bootstrap

`dao.clar` bootstraps `(map-set authorized tx-sender true)` - the deployer
WALLET sits in the authorized map alongside the contracts. So the deployer
can call settle-wallet directly with arbitrary numbers:

- inflated `current-balance` -> fat snapshot balance -> that wallet's future
  `pending = snap-balance * index-delta` overpays, draining sBTC meant for
  everyone else
- fake `total-supply` -> corrupts tracked-supply -> every subsequent index
  bump is skewed

Any admin can also `set-authorized` any principal, so for other EOAs it is
one tx away - acceptable as an explicit admin action, but the deployer being
authorized BY DEFAULT is a silent trust hole.

Pre-deploy fix (OPEN, deliberately not yet applied to dao.clar): remove the
deployer from the `authorized` map in the dao bootstrap (keep it admin-only),
so no EOA is ever authorized and settlement inputs provably come only from
contracts that read the token ledger. Revisit before mainnet deploy.

### StackingDAO has the same hole, live on mainnet

Verified in their repo - we inherited the pattern faithfully:

- `dao.clar` bootstrap: `(map-set contracts { address: tx-sender }
  { active: true })` - their deployer EOA sits in the protocol map.
- `ststxbtc-tracking-v2.refresh-wallet(holder, balance)` takes a
  caller-supplied balance gated only by `check-is-protocol
  contract-caller` - so their deployer can write arbitrary position
  amounts for any holder, inflating that holder's share of every future
  add-rewards distribution.

For them it is a deliberate centralization trade-off (their keeper/admin
scripts drive many flows through the deployer key). We get no such
operational benefit - our keeper paths go through authorized contracts -
so dropping the deployer from the authorized map is free hardening.

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
