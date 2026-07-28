# How STX moves through the protocol

Answers the question: *a withdrawal is demanded against the vault, so how does that
turn into STX coming back from a stacker?*

## The four contracts

There is **one vault** and **many stackers**. That trips people up.

| contract | holds | job |
|---|---|---|
| `vault` | all the STX | dumb custody: receive, release, reserve, unreserve |
| `registry` | admin config | which stackers exist, their weight, their fee |
| `delegation` | user config | which stacker each user picked, and how much |
| `allocation` | nothing | works out how much each stacker *should* hold, and moves it |

`vault`, `registry` and `delegation` are storage. **`allocation` is the only one that
thinks**, and the only one that moves STX between vault and stackers.

## Where real STX moves

```
DEPOSIT
  user --STX--> vault                    core.deposit -> vault.receive
  delegation.assign(user, stacker, amt)  accounting only, nothing moves

ALLOCATE                                 keeper, one stacker at a time
  allocation.execute-allocation(stacker, vault)
    vault.release deficit stacker        <== REAL: vault -> stacker
  stacker.delegate-stx                   locks it in PoX

START-WITHDRAW
  jSTX user -> core
  vault.reserve ustx                     accounting: earmark, nothing moves
  delegation.reduce                      accounting: target drops
  mint redeem NFT (unlock-height)
  ==> excess appears on a stacker, but the STX is still LOCKED

CYCLE END
  PoX unlocks -- STX is unlocked but still sitting in the stacker contract

RETURN                                   keeper, one stacker at a time
  allocation.return-excess(stacker, vault)
    stacker.stx-transfer excess vault    <== REAL: stacker -> vault

FINALIZE
  vault.release ustx-net user            <== REAL: vault -> user
  vault.release fee treasury
```

The user is **always** paid from the vault, never from a stacker directly.

## Earmarking is a sticky note, not a lock

`vault.reserve(amount)` only increments a counter:

```clarity
(var-set reserved-stx (+ (var-get reserved-stx) amount))
```

Nothing is frozen. Its only effect is on `get-pending-balance`:

```
pending = max(balance - reserved, 0)   ;; "free STX, safe to stack"
```

`vault.release` never consults `reserved-stx`, so the earmark is an input to a
calculation, not a constraint on movement.

`reserved > balance` is **normal**, not an error: the STX backing a pending
withdrawal is locked in a stacker until cycle end. That is why `start-withdraw` is
uncapped and slow (NFT + unlock height), while `withdraw-pending` is instant but
capped at STX that was never stacked.

## Targets: what each stacker should hold

```
total-stackable = pending (free in vault) + total-allocated (already at stackers)

target = assigned-stacker   <- delegation: users who picked this stacker
       + from-weight        <- registry:   admin's cut of unclaimed STX
       + from-assigned      <- delegation: users' cut of unclaimed STX
```

`user-influence` (default 2000 = 20%) is the dial splitting the unclaimed pool
between the admin bucket and the user bucket. Targets always sum to
`total-stackable`.

### Worked example

```
registry:  A = 7000 (70%)   B = 3000 (30%)      user-influence = 2000 (20%)
total-stackable 1,000,000    Alice->A 100,000    Bob->B 100,000
total-assigned    200,000    total-unassigned   800,000

admin-unassigned = 800,000 * 80% = 640,000      (split by registry weight)
user-unassigned  = 800,000 - 640,000 = 160,000  (split by who users picked)

target A = 100,000 + 640,000*70% + 160,000*50% = 628,000
target B = 100,000 + 640,000*30% + 160,000*50% = 372,000
                                                 ---------
                                                 1,000,000  = total-stackable
```

Then `deficit = target - allocated` (push STX out) and
`excess = allocated - target` (pull STX back).

`allocated` is `stacker-allocated`, a **bookkeeping map** maintained only by
`execute-allocation` and `return-excess`. It is not a balance read.

## How a withdrawal creates excess

Two different behaviours, same 100,000 withdrawal against the example above.

**User never picked a stacker.** `reserve` fires, `delegation.reduce` is a no-op.
`total-stackable` drops 100,000, so every target shrinks pro-rata by weight:

| | before | after | |
|---|---|---|---|
| A | 628,000 | 562,000 | excess 66,000 |
| B | 372,000 | 338,000 | excess 34,000 |

Excesses sum to exactly the withdrawal. Clean, but you cannot choose who absorbs it.

**Alice (assigned to A) withdraws.** Both `reserve` and `reduce` fire:

| | before | after | |
|---|---|---|---|
| A | 628,000 | 448,000 | excess 180,000 |
| B | 372,000 | 452,000 | **deficit 80,000** |

Counterintuitive: removing Alice's assignment also hands Bob 100% of the
user-influenced bucket instead of 50%, so B's target *grows*. Servicing a 100,000
withdrawal means pulling 180,000 out of A and pushing 80,000 into B.

## Getting STX back: the operator's two levers

Only unlocked STX can move, so this only works in the window after PoX unlocks at
cycle end and before re-delegation. That window is what `finalize-buffer` (10
blocks) protects.

`revoke-delegate-stx` is all-or-nothing per stacker and unlocks nothing — it only
stops the pool re-committing next cycle. To change an amount: revoke, then
`delegate-stx` with the new number.

| lever | effect |
|---|---|
| `registry.set-delegate-allocation(stacker, u0)` | `from-weight` -> 0, target collapses to the user-assigned part, large excess appears, `return-excess` drains it through the normal path |
| `stacker.stx-transfer-all(vault)` | sweeps every unlocked sat straight to the vault, bypassing the target math entirely |

Dropping a weight to 0 does **not** redistribute it — the other weights are
unchanged, so targets simply sum to less than `total-stackable`. Good when funding a
withdrawal; if retiring a stacker for good, raise the others so weights sum back to
`PRECISION`.

The operator decides off-chain which lever to pull.

## Known gaps

- **No net pull-back once `reserved > balance`.** `pending` floors at 0, so targets
  stop shrinking and `sum(targets) = total-allocated`. Every excess is matched by a
  deficit elsewhere and the vault nets zero — exactly when it needs funding.
  Fix: size `total-stackable` as `max(balance + total-allocated - reserved, 0)` so
  excesses keep growing past the crossover. That is StackingDAO's `outflow`
  (`strategy-v4.get-outflow-inflow`), which they compute in the planner, not the
  reserve.
- **No shortfall figure on-chain.** The keeper needs `reserved - balance` to sequence
  work; today that is an off-chain subtraction.
- **`execute-allocation` can release reserved STX.** `vault.release` ignores
  `reserved-stx`, so a per-stacker deficit larger than `pending` will happily spend
  withdrawal money.
- **Ordering is the keeper's problem.** Deficits and excesses only net out across
  *all* stackers. Call `execute-allocation` before `return-excess` and it can fail on
  balance.
- **Weights are unchecked.** Nothing enforces `sum(delegate-allocation) = PRECISION`.
- **`delegation` drifts.** jSTX is transferable and a transfer does not notify the
  contract, so `stacker-total` and `total-assigned` go stale until a keeper calls
  `delegation.update(user)`.
