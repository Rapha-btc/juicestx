# Friedger's pox-5 pool — contract notes

Working notes on **`friedger/clarity-pox-5-pool`** (our fork: `Rapha-btc/clarity-pox-5-pool`).
These are the pox-5 stacking contracts that the Juice jBTC LST work is being built on.

> Source of truth is the repo, not this file. This is a high-level map so we don't
> have to re-read 2k lines every time. Last reviewed against `main @ 0e151b2`
> ("chore: update to rv 1.0.1", 2026-06-23).

## What pox-5 is (vs pox-4)

pox-5 is a **new bond/signer architecture** — there is **no `delegate-stx`**. Stacking
happens through **bonds**: a bond is a stacking commitment registered by a signer, set up
by a `bond-admin` who controls a frozen allowlist (`setup-bond`). Practical gates to
participate: ~50k STX signer floor, a per-bond STX-vs-sBTC ratio param, and — the real
gate — being on the bond-admin's allowlist.

## The two consumer routes (don't conflate them)

The same signer infrastructure feeds **two different products**:

| | **Pool route (LST)** | **As-a-service route (direct)** |
|---|---|---|
| Contract | `pool.clar` | `signer-manager.clar` |
| What you hold | fungible liquid token (`pool-sbtc` / jBTC) | your own bond/position |
| How rewards reach you | fold into the token's **redemption rate** for all holders | claimed **per-staker**, your share minus a fee |
| BTC payout option | **No** — pooled & fungible, there is no "your BTC address" | **Yes** — set a pox-addr, rewards peg-out to your BTC |

**Key takeaway:** an LST structurally *cannot* offer per-user BTC payouts (it's fungible).
The BTC-payment feature lives only in the `signer-manager` (direct) path. If a
conversation mixes "LST" and "BTC reward payout," that's the confusion to flag.

## Contracts

### `pox-5.clar` — the base protocol
The pox-5 stacking core. Defines `signer-manager-trait`, the bond registry
(`protocol-bonds`, `protocol-bond-allowances`, `protocol-bond-memberships`), signer
accounting, and per-cycle reward math (`rewards-per-token-for-cycle`, staker/signer
shares & unclaimed rewards). Admin entry points: `set-bond-admin`, `setup-bond`
(allowlist), `register-for-bond`. `bond-admin` defaults to the burn address until
configured.

### `signer-manager.clar` — direct / as-a-service manager
Implements `pox-5.signer-manager-trait`. Runs one bond's stakers + reward distribution
with optional BTC payout and admin fees. Lifecycle:

1. **`validate-stake!`** — pox-5 callback (only pox-5 may call it) validating a staker's
   calldata on stake. Calldata may carry a **pox-addr** (BTC `version`+`hashbytes` +
   `max-fee`) → stored in `pox-addrs` for later L1 payout.
2. **`claim-rewards`** — permissionless; pulls the gross sBTC rewards into the contract,
   tracked in `unclaimed-staker-rewards`.
3. **`claim-staker-rewards`** — a staker takes their proportional share minus a **fee**
   (basis points; snapshotted per cycle via `snapshot-bond-fee` so a fee change can't be
   applied retroactively). Delivered as: direct **sBTC**, OR an **sBTC withdrawal
   (peg-out to BTC)** if a pox-addr is set, OR retained as the manager's fee
   (`earned-fees`).
4. **Withdrawal settlement** — `reclaim-failed-withdrawal` (rejected → returned) /
   `settle-accepted-withdrawal` (accepted → done).
5. **Admin** — `update-admin`, `update-fees`, `withdraw-fees`, `sweep-fee-refunds`,
   `register-self`.

**Accounting guards (anti-rug):** `withdrawal-liability` (sum of `amount + max-fee` over
live withdrawals) and `unclaimed-staker-rewards` are both **subtracted** in
`sweep-fee-refunds`, so an admin can sweep only their own fees — **never** staker money.

Note: friedger's `0e151b2` **deleted** the duplicate `signer-manager-2.clar` (a second
reference copy used by the old fuzz setup). The live contract is `signer-manager.clar`.

#### `claim-staker-rewards` internals — fee split, peg-out, liability

Three details that are easy to misread (worked through against `signer-manager.clar`):

**1. The fee split.** `gross` = the staker's full reward (booked into
`unclaimed-staker-rewards` when `claim-rewards` pulled it in). `fees` = the manager's cut
(`gross × snapshotted-bips / MAX_BIPS`) which **stays in the contract** (added to
`earned-fees`). `earned = gross − fees` is the **only amount that leaves** — either a direct
sBTC transfer to the staker, or an L1 peg-out. On each claim:
`unclaimed-staker-rewards −= gross`, `earned-fees += fees`, balance `−= earned`. The two
sides net out, so the global solvency invariant is preserved.

**2. `amount = earned − max-fee`, and the `try!` aborts cleanly.** On the BTC-payout path:

```clarity
(amount (try! (if (>= earned (get max-fee l1-info))
                  (ok (- earned (get max-fee l1-info)))
                  ERR_NO_CLAIMABLE_REWARDS)))   ;; == (err u1001)
```

`max-fee` is **not** the fee the bridge charges — it's the staker's declared **ceiling** for
the L1 Bitcoin tx fee (actual fee ≤ max-fee; the unused remainder is minted back on accept).
If `earned < max-fee`, the `if` yields `(err u1001)` and **`try!` returns immediately from the
whole function** — `amount` is never bound, `initiate-withdrawal-request` is never called,
nothing reaches the bridge, and the tx reverts. The `u1001` is the error code, not a sats
amount. (Note the `>=` boundary: `earned == max-fee` → `amount == 0`, an all-fee withdrawal.)

**3. `withdrawal-liability += amount + max-fee` (== `earned`).** `amount + max-fee` is the
**total sBTC locked into the sBTC withdrawal system**, i.e. the full `earned` that just left
the contract's free balance. It's recorded as a liability because the withdrawal is initiated
inside `as-contract?`, so **this contract is the requester** — anything the sBTC protocol
returns flows back *here*, not to the staker (whose pox-5 balance is already zeroed):

- **REJECTED** → full `amount + max-fee` minted back here → reclaimable by the staker via
  `reclaim-failed-withdrawal` (which then `−= refund` from the liability).
- **ACCEPTED** → staker paid on L1; only `max-fee − actual-fee` dust minted back →
  `settle-accepted-withdrawal` releases the liability so the dust becomes sweepable.

`sweep-fee-refunds` computes sweepable as
`balance − (earned-fees + withdrawal-liability + unclaimed-staker-rewards)`, so when a
rejected withdrawal's funds re-enter the balance they're **cancelled by the still-standing
liability** — the admin can never sweep a staker's in-flight peg-out as if it were fees.

> The sBTC-balance guard in `claim-staker-rewards` (`(> balance u0)`) is only a smoke test —
> the `transfer` / `initiate-withdrawal-request` already aborts if `balance < earned`. If it
> should mean more, the real floor is full solvency
> (`balance >= earned-fees + withdrawal-liability + unclaimed-staker-rewards`), not `balance − gross`.

### `pool.clar` — the LST pool (jBTC)
SIP-010 fungible token (`pool-sbtc`). Holders get a liquid token whose redemption rate
rises as rewards accrue — no per-user payout. Routes deposits into **vaults** that are
bound to **signers** (our PR #5: `vault-signer` binding + signer validation at
`assign-vault`). Key fns: `list-signer`/`update-listing`/`delist`, `assign-vault`,
`deposit`, `register-cohort`, `fold-rewards`, `unstake-cohort`, `withdraw`,
`set-operator`. Share math: `shares-for-sbtc` / `sbtc-for-shares`.

**`fold-rewards` solvency fix (found by rv fuzzing, shipped in `0e151b2`):** it used to
just bump `total-sbtc`, *trusting* the operator had delivered reward sBTC out-of-band.
The fuzzer (run from deep, bootstrapped state) showed this breaks `invariant-solvency` —
`total-sbtc` could exceed reachable sBTC. Now `fold-rewards` **pulls** the sBTC into the
vault atomically (`SBTC transfer`), so backing is always real. (An earlier fuzz find also
added the `supply > 0` guard so you can't fold into an empty pool and strand sBTC.)

### `vault.clar` / `vault-trait.clar` — staking vaults
Vaults are the pre-deployed sinks the pool routes into. `set-pool` (point at the router),
`register-bond`, `unstake-sbtc`, `payout`, `get-pool`. The pool binds each vault to a
signer-manager (`vault-signer` map) and validates the signer when assigning.

## Asset flow: deposit, rewards, withdrawal (pool ⇄ vault ⇄ signer-manager)

Roles recap: **pool** = LST token + global accounting; **vault** = single-position pox-5
staker (one bond, `only-pool` gated, acts via `as-contract`); **signer-manager** = the
pox-5 signer that validates stakes and is the hub rewards are claimed into.

**Critical accounting fact:** `total-sbtc` and the `pool-sbtc` (jBTC) supply are **single,
pool-wide** vars. So the redemption rate `sbtc-for-shares = shares × total-sbtc / supply`
is **global across all vaults** — a share is a claim on the whole pool, not on one vault.

### Deposit
`pool.deposit(sm, vault, sbtc, ustx)` moves the user's sBTC+STX **directly into the vault**
(`SBTC transfer sbtc user vault`) and into `vault-pending`, then mints **global** shares.
A user is bound to exactly one vault (`user-vault`); the vault must already be bound to the
chosen signer (`vault-signer`). Operator later locks the pending cohort with
`register-cohort` → `vault.register-bond` → `pox-5.register-for-bond` (vault is the staker).

### Where reward sBTC actually lands (two steps — it is NOT direct to the vault)
1. **`signer-manager.claim-rewards(bond-periods, reward-cycle)`** → calls
   `pox-5.claim-rewards`; pox-5 sends the gross sBTC to the **signer-manager** contract
   (parked there, tracked in `unclaimed-staker-rewards`). **Signer-level:** one call pulls
   the signer's whole pot for those (≤6) bond periods — covering *all* its vaults at once.
2. **`signer-manager.claim-staker-rewards(staker, cycle, bond-index)`** → computes that
   staker's `gross`, takes the `fee`, pays `earned` out of the signer-manager:
   - no pox-addr → `transfer earned -> staker` (the staker principal = the **vault**), or
   - pox-addr set → routed into an **L1 sBTC withdrawal** (peg-out).
   **Per-vault:** called once per staker, so `claim-rewards` ×1 then `claim-staker-rewards`
   ×N (one per vault).
3. **`pool.fold-rewards(vault, amount)`** (operator) bumps the **global** `total-sbtc` and
   pulls `amount` sBTC into the vault atomically → **lifts the global redemption rate** for
   *every* jBTC holder (rewards earned via one vault's bond benefit all holders).

So the path is **pox-5 → signer-manager → vault/BTC**, then folded into the pool's global
ratio. Reward sBTC sits in the signer-manager between steps 1 and 2.

#### Signer vs staker (don't mix them up)
In pox-5 calls, the **signer** = the signer-manager contract, and the **staker** = the
vault. E.g. `get-earned-staker-rewards(... current-contract ... staker)` passes
`current-contract` (the signer-manager) as the *signer* and `staker` (the vault) separately.
One signer-manager sits over many vaults/stakers.

#### Fee snapshotting (the `bond-index: none` line)
`claim-rewards` freezes the fee rate for the cycle so a later `update-fees` can't rewrite
history. It writes into `fee-bips-for-cycle` keyed by `{reward-cycle, (optional bond-index)}`:
- once with `bond-index: none` → the fee for the **STX-only stacking leg** (the rewards
  pox-5 tracks under `none`);
- then `fold snapshot-bond-fee` writes `{reward-cycle, (some bond-index)}` for **each sBTC
  bond that actually earned**.
So the two key kinds line up with the two reward legs: `none` = STX-only, `(some n)` = each
bond. `map-insert` (write-once) means the first claim locks it in. Lookup
(`get-fee-bips-for-cycle`) is exact-key with `default-to u0` — no fallback from `(some n)` to
`none`.

#### Why `bond-index` is `(optional uint)`
Not because a staker can be in many bonds — a staker has exactly one
`protocol-bond-memberships` entry at a time. The option flags **which kind of reward**:
- `none` = plain STX-only stacking rewards (`stake` / `stake-update` path, no bond);
- `(some n)` = rewards from a specific sBTC **bond** (`register-for-bond` path).
pox-5's `claim-rewards` fetches the STX leg with `none`, then each bond with `(some bond-index)`.

#### `get-earned-staker-rewards` (read-only quote)
A preview, no state change: asks pox-5 what the staker earned before fees, subtracts the
signer's cut, returns `{ earned, fees }`. Call it before `claim-staker-rewards` to see the
split.

### Withdrawal — single vault, global price (not an average across vaults)
`pool.withdraw(vault, shares)`: a user redeems from **their own bound vault only**
(`vault.payout`), but the **amount** uses the global rate
(`sbtc-out = shares × total-sbtc / supply`); STX principal returns pro-rata from their own
tracked `stx-principal` (`stx-out = user-stx × shares / user-shares`). Sequence: burn
shares → `total-sbtc -= sbtc-out` → update/clear the user's maps → `vault.payout`. The
cohort must be unwound first (`unstake-cohort` → `vault.unstake-sbtc`) so the vault holds
the sBTC.

> **Tension (flagged in code as `TODO … global pooled position? (see #2)`):** the rate is
> global but custody is per-vault. Rewards inflate everyone's claim, yet the coins may have
> been folded into a *different* vault than the one a user withdraws from — so the operator
> must keep each vault funded to cover its depositors' globally-valued claims.

> **Seam to confirm with friedger:** `claim-staker-rewards` pays the **vault** directly, but
> `fold-rewards` transfers from the **operator** (`tx-sender`). Both can't be canonical
> without double-handling. Likely the signer-manager's per-staker/pox-addr/fee machinery is
> for the **direct (as-a-service) stakers**, while the **pool** uses the simpler
> "operator claims → `fold-rewards`" trust model. Pin down which path the pool's vaults use.

## Bond periods (the global timeline model)

A **bond-index identifies one specific bond period** — a 6-cycle stacking timeline. Key
facts:

- A bond period is **protocol-global**, not per-vault / per-signer / per-pool. The
  `protocol-bonds` and `protocol-bonds-total-staked` maps are keyed by a bare `uint`
  (the bond-index) with no signer/vault in the key. Each bond carries protocol-wide
  params: `target-rate`, `stx-value-ratio`, `min-ustx-ratio`, the L1 early-unlock script.
- The id space is **unbounded** — a new bond period can begin each cycle, so bond-indexes
  keep incrementing (0, 1, 2, …). The `bond-admin` defines them via `setup-bond`.
- Each bond **lasts 6 cycles** (everywhere: `end = bond-period-to-reward-cycle (+ bond-index u6)`).
  Because they're staggered one-per-cycle, **at most 6 are active at the same time.**

So a snapshot reads: *"a bond-index is one of the (≤6) bond periods currently active in the
protocol."* The `6` is the concurrent-active window, **not** a total count and **not** a
per-vault quota.

**How the layers map onto it:**

- **signer** — a staker picks a signer-manager; many signers operate *within* the same
  global bond periods.
- **vault (friedger's layer)** — `vault.register-bond` enrolls the vault under a signer
  into one of those global bond periods. A vault is a *participant* in a shared bond, not
  the owner of a private set. Its `protocol-bond-memberships` entry holds one `bond-index`.

### Why `claim-rewards` / `calculate-rewards` take `(list 6 uint)`

`bond-periods` is a list of up to 6 **bond-index** values — the (≤6) periods active in the
`reward-cycle` being claimed (a new period started, plus the up-to-5 still running). It's
**not** amount/start/end. Rewards are computed per period, so the claim folds over every
active one (`fold update-claimable-bond-rewards bond-periods …`). And it's not
"pass whichever you like": `calculate-rewards` calls `assert-all-active-bonds-included`,
so the caller must supply the **complete** active set. The cap is 6 because a bond's
lifetime is 6 cycles.

## `validate-stake!` callback + reentrancy guard

`validate-stake!` (on the signer-manager) is a **pox-5 callback**, not something the
manager initiates. Direction is **staker → pox-5 → signer-manager**:

1. A staker (or a contract acting for them) calls a pox-5 entry point — one of
   `register-for-bond`, `update-bond-registration`, `stake`, `stake-update` — passing
   `signer-calldata`.
2. pox-5 calls back `validate-stake!` on the signer-manager the staker chose. The `staker`
   arg is pox-5's `tx-sender`.
3. The manager records (`map-set pox-addrs`) or clears (`map-delete pox-addrs`) the
   staker's BTC-payout preference, per the calldata (see `signer-manager` section).

All four call sites go through one private helper, `signer-manager-validate-stake`, which
wraps the cross-contract call in a **reentrancy guard**:

```clarity
(asserts! (not (var-get signer-manager-call-active)) ERR_REENTRANT_CALL)
(var-set signer-manager-call-active true)
(try! (contract-call? signer-manager validate-stake! ...))
(var-set signer-manager-call-active false)
```

**Why it's needed (the hack it blocks).** The `signer-manager` is a **trait argument the
caller supplies** — i.e. attacker-controlled code. pox-5 hands it execution *before* it
finishes its own checks and writes (a checks-effects-interactions violation): in `stake`,
the callback is at the top, but the duplicate-stake guard (`is-none (get-staker-info …)`)
and the actual writes (`add-staker-to-signer-cycles`, `map-set staker-info`) come later.
So at callback time, `staker-info` is still empty and no shares are recorded. Without the
guard, a malicious `validate-stake!` could **re-enter** `stake`/`register-for-bond` for the
same staker; the duplicate guard still passes (state not yet written), so the **same
STX/sBTC gets counted into reward shares multiple times** — minting `staker-shares` the
collateral doesn't back and draining more rewards than funded (and corrupting the
`total-shares` vs `staker-shares` invariants). The global mutex makes the whole
`validate-stake!`-bearing family mutually exclusive — simpler than reordering state across
four functions.

> Note: the guard only covers the `validate-stake!` path. `claim-rewards` /
> `claim-staker-rewards` are **not** behind this flag — their safety relies on their own
> ordering, so audit them separately.

## Bitcoin address-version bytes (used in pox-addr validation)

pox-addr tuple is `{ version: (buff 1), hashbytes: (buff 32) }`. Constants in
`signer-manager.clar`: `MAX_ADDRESS_VERSION = u6`, `MAX_ADDRESS_VERSION_BUFF_20 = u4`.

| version | type | hashbytes |
|---|---|---|
| `0x00` | P2PKH | 20 |
| `0x01` | P2SH | 20 |
| `0x02` | P2SH-P2WPKH | 20 |
| `0x03` | P2SH-P2WSH | 20 |
| `0x04` | P2WPKH (segwit v0) | 20 |
| `0x05` | P2WSH (segwit v0) | 32 |
| `0x06` | P2TR (taproot) | 32 |

So: version must be `≤ 6`; if version `≤ 4` hashbytes must be 20 bytes, else 32.
`0x04` is the boundary of the 20-byte group — not the overall max.

## Testing (Rendezvous fuzzing)

`0e151b2` rebuilt the rv harness. The plain `rv` CLI starts from an empty pool and bounces
off the `assign-vault` / signer gates, so it never reaches `supply > 0`. The new
**bootstrapped** harness (`tests/rv/`) uses a custom Clarinet manifest + `rv-bootstrap.clar`
that calls the simnet-only `pool.rv-wire` to seed vault→signer bindings, so the campaign
runs from real depth. A one-line rendezvous patch (skip contracts whose AST can't load —
the mainnet sBTC *requirement* contracts) is auto-applied via `patch-package` postinstall.

```bash
npm run rv:test       # fuzz the test-* properties
npm run rv:invariant  # random call sequences, checking invariant-* after each
npm test              # vitest lifecycle + invariant assertions
```

## Glossary

- **bond / bond-index** — a protocol-global 6-cycle stacking timeline; `bond-index` is its
  permanent numeric id (unbounded; a new one can start each cycle, ≤6 active at once).
  Not per-vault/signer/pool. In fee maps keyed by `(reward-cycle, optional bond-index)`,
  `none` = global/default, `(some n)` = per-bond override.
- **fold rewards** — add sBTC rewards into the pool so the LST redemption rate rises.
- **pox-addr** — a staker's BTC payout address (version + hashbytes) + their `max-fee`.
- **withdrawal-liability / unclaimed-staker-rewards** — staker-owed sBTC tallies that
  admin sweeps must subtract, so admins can never take staker funds.
