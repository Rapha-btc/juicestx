# StackingDAO security operations, as observed on chain

Reference notes for `SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG`, gathered while
deciding whether to copy their escape-hatch pattern into `vault.clar` and
`yield.clar`. Everything here is verifiable with the read-only calls and txids
quoted; nothing is inferred from their repo alone, because the repo is not
necessarily what is deployed.

Snapshot taken 2026-07-28. Re-check before relying on it.

## Two permission lists, not one

Their `dao` keeps two independent maps:

```clarity
admins     ->  who can change settings        (check-is-admin)
contracts  ->  who passes the protocol gate   (check-is-protocol)
```

Both are `principal -> bool`, so **either can hold a wallet address**. Being an
admin grants nothing on the protocol list and vice versa. An admin can add
themselves to `contracts` via `set-contract-active`, but that is a separate,
visible transaction.

Read either list with:

```clarity
(contract-call? 'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.dao get-admin 'PRINCIPAL)
(contract-call? 'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.dao get-contract-active 'PRINCIPAL)
```

## Current state

```
get-admin  SM1SEBGTH5V9HJKF9BY7HYDNY3FZV23YMY15DPWFT   FALSE
get-admin  SP4SZE494...dao-executor                    TRUE     <- admin is a contract
get-contract-active  SM1SEBGTH...                      TRUE     <- multisig still on the protocol list
get-contract-active  SP4SZE494...  (deployer wallet)   FALSE
get-contract-active  SP2694C0VGQZPGSHR9Y45WAYBYKYQFGW45CKETA1T   FALSE   (a wallet; was TRUE, later revoked)
```

`SM1SEBGTH...` was the original admin and did all the wiring. Admin later moved to
the `.dao-executor` contract, but nobody removed the multisig from `contracts`.
It therefore still passes `check-is-protocol` without holding any admin role.

`SM1SEBGTH...` is a native Stacks multisig, **2-of-3**, membership published on
chain (any spend reveals all members). Two of those three keys are sufficient.

## The escape hatches

Every contract that custodies an asset carries an unaccounted mover per asset,
gated only on `check-is-protocol`:

```clarity
(define-public (get-stx (requested-stx uint) (receiver principal))
  (begin
    (try! (contract-call? .dao check-is-protocol contract-caller))
    (try! (as-contract (stx-transfer? requested-stx tx-sender receiver)))
    (ok requested-stx)))
```

No `check-is-enabled`, so it keeps working while the protocol is halted. No
counter is touched, so accounting is deliberately left inconsistent afterwards.

Verified present in deployed mainnet bytecode, not just the repo:

| contract | get-stx | get-sbtc | STX held (2026-07-28) |
|---|---|---|---|
| `reserve-v1` | yes | no | **3,984,960 STX** |
| `rewards-v8` | yes | yes | 5,351 STX + sBTC |
| `rewards-v5` | yes | yes | 0 |
| `rewards-v2` | yes | no | 0 |

Repo-only, never deployed under these names: `stacking-delegate-1.clar:131`,
`stacking-pool-payout-v1.clar:177`.

## The hatches are operational, not dormant

They are used on every rewards-contract upgrade, to drain the retiring contract:

```
2025-09-09  rewards-v5 -> SP4SZE494... (a wallet)
  get-stx    133,469 STX     0x9086b94c369380b0d3464c316ff823719c38209cfab02fc858656b15c5e8e3c5
  get-sbtc   0.4199 sBTC     0x2c1a4d3f912fdab48ad0bb425892d592680a002248a7496dfa978ac5a8db4e91

2026-02-17  rewards-v7 -> SP4SZE494... (same wallet), same block as set-contract-active
  get-stx    141,894.67 STX  0xc819cab90f3f95e3e631753e43319f6b0e35a3106111dc354b2e054989f46124
  get-sbtc   0.33516 sBTC    0x415a36ce260d61d48d5780eebaf4f39a369bcb7c13eff1eb33ff9087b5293795
```

Both times the recipient is a **plain wallet**, not a contract — so users'
unclaimed rewards sat in an EOA between the old and new rewards contract.

Other recent `check-is-protocol` uses by the multisig, not hatches:
`stacking-delegate-restake-1-5.return-stx` (2026-03-15),
`stacking-delegate-1-4.return-stx` (2026-03-31). Last activity of any kind
2026-06-29; last admin action `dao.set-admin` on 2026-06-22.

## The exposure, stated plainly

Two of three keys, acting together, can call `reserve-v1.get-stx` today and move
~3.98M STX to any address. No admin role required, no `.dao-executor` governance
involved. The path exists solely because a stale entry was left on the
`contracts` list when admin was migrated away.

This is not a code flaw — their code matches the intent. It is a housekeeping
gap, and it is invisible unless you read the map directly.

## What we took from this

`vault.get-stx`, `yield.get-sbtc` and `stacker.get-sbtc` mirror theirs, including
`check-is-authorized contract-caller` and the absence of a liveness check.

We did **not** add `stacker.get-stx`. `stx-transfer-all` already sweeps every
unlocked sat, and it is tighter than theirs: the destination is a `<vault-trait>`,
so it can only go to a contract, never to a wallet. No hatch can reach locked STX
before the cycle ends in any case.

We briefly added `(asserts! (not (is-eq contract-caller tx-sender)))` to force the
hatch to be reached through a contract, then removed it: it would block a direct
emergency call, requiring a pre-deployed and pre-authorized recovery contract at
exactly the wrong moment.

So we inherit the same requirement, and it is a discipline rather than a
constraint:

- **`authorized` must contain contract principals only.** One wallet on that list
  is the whole vault.
- **Audit the list after every migration.** Their gap is precisely a role moved
  without the old entry being cleared.
- **Add an invariant test** asserting every member of `authorized` is a contract
  principal, so CI catches it rather than chain.
- **Prefer draining to a contract, not a wallet**, if we ever run the migration
  play they ran twice.
