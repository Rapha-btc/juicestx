# Juice STX rewards pool: delayed swap-vault rotation

The pool starts with `.juice-pool-swap-vault` but stores its active destination
in `swap-vault`. Its current admin can select a compatible future vault after
**4,032 Bitcoin burn blocks** (about 28 days). This is a proposal delay, not a
pause in rewards or a change to the router's per-swap cooldown. It lets this
pool version keep its address while future vaults bind to newer Jing markets.
No replacement production vault is created or deployed by this amendment.
Existing deployed Clarity contracts are immutable; this feature becomes available
when the amended pool version is deployed.

## Upgrade sequence

1. Later, deploy a new vault that implements
   [juice-swap-vault-trait](juice-swap-vault-trait.clar) and binds its `POOL` to this
   exact rewards pool address. It must have no batch clock or resting/parked
   market positions. Donated STX/sBTC balances are allowed. The admin chooses/trusts the implementation; trait compatibility
   and a reported pool address do not constitute an audit of that implementation.
2. The current admin calls `propose-swap-vault(new-vault)`.
   `get-pending-swap-vault` reports the target, proposal burn height and
   `executable-at`. Proposing again replaces the target and restarts the full delay.
   The admin can cancel with `cancel-swap-vault-proposal`.
3. During the notice period, normal rewards still fund the active old vault.
   Finish its pending tranche normally or recover it through the existing emergency
   route. Those funds are credited to their original tranche before rotation.
4. At or after the deadline, the current admin calls
   `confirm-swap-vault(old-vault, new-vault)`. It checks the exact current and
   proposed addresses, the delay, no pool `pending-swap`, and both vaults' current
   upgrade status. Both must bind to this pool, have no batch clock and no market
   position. Neither requires zero STX/sBTC balances; donations are allowed. Failure preserves the active address and
   proposal. No in-flight funds are moved between vaults during confirmation.
5. Future reward claims and pool wrappers use the new address, returned by
   `get-swap-vault`. Confirmation clears the proposal. Every later rotation needs
   a fresh full 4,032-block notice too.

Donated STX/sBTC balances do not block proposal or confirmation for either vault.
The old reward tranche must still be finalized or recovered; an active batch clock
or market position also prevents switching. Any donations left in the retired
vault stay there: confirmation does not sweep them or credit them to a completed
tranche. New-vault donations join its first normal batch. Candidate clock/positions
are rechecked at confirmation even if it was ready at proposal time.

## Calling the amended pool

Clarity requires a trait reference as a function argument for dynamic contract
calls; storing a principal alone cannot be used as a callable vault. These pool
functions now take the **active vault as their last argument**:

- `pox-claim-rewards(bond-periods, reward-cycle, vault)`
- `finalize-swap(vault)` and `emergency-recover(vault)`
- `refloor-vault(update, vault)` and `jing-take(amount, update, vault)`
- `router-swap-split(amount, jing, dlmm, xyk, velar, update, vault)`
- `router-swap-split-dia(amount, dlmm, xyk, velar, vault)`
- all seven `set-vault-*` controls, e.g. `set-vault-window-blocks(blocks, vault)`

Each checks `(contract-of vault)` against the stored address before making any
external call. A stale/wrong target returns `u119`. Callers should read
`get-swap-vault` when constructing transactions; they cannot select another
recipient. Permissionless claims/finalization remain permissionless and admin
controls remain gated. PoX registration/callbacks, staking shares, fee logic,
OG exemptions and payout functions keep their existing arguments and behavior.
Frontend/bot transaction builders using the old pool ABI must add this argument;
this source amendment does not update or deploy those applications.

The existing vault adds `get-upgrade-status`, a read-only response containing
`pool`, `empty`, `sbtc-balance`, `stx-balance`, `batch-start`, `jing-resting`, and
`jing-parked`. Its pricing,
routing, cooldown and recovery logic are unchanged. It explicitly implements
the new trait. Initial deployment order: trait, existing vault, amended pool.
The future replacement can be deployed at any compatible contract address; it
does not need the original vault's name or deployer.

New errors: `u118` no pending vault proposal; `u119` wrong address/pool;
`u120` vault not idle. Existing `u100` admin gate, `u114` delay and
`u115` pending-swap guard are reused. Events are `propose-swap-vault`,
`cancel-swap-vault-proposal`, and `confirm-swap-vault`.

## Required behavior of future implementations

The trait checks argument and return types, not implementation behavior. A setting
or unused route may return a correctly typed no-op result if that behavior is
intentional for the new vault. `fund` must actually receive the claimed sBTC.
`finish` must return all payout STX to this pool and return the accurate amount;
the pool records that returned amount as the pending tranche's `stx-pot`.
It currently trusts the amount rather than checking its own balance delta.
`emergency-recover` must actually return remaining sBTC and STX, and report their
accurate amounts: the pool credits its recovered-sBTC ledger and STX pot, finalizes
the tranche and clears the pending swap. A no-op or dishonest response from either
exit function would corrupt reward accounting or leave assets behind. These core
behaviors must be reviewed/tested in each future vault; interface compatibility
alone does not guarantee them.

## Verification

```bash
npm run test:vault
npm run test:vault:migration
```

The existing full local runtime suite passes with the new trait arguments, reaching
129/129 instrumented vault branch outcomes and 292/294 line counters.
[Migration results](../../tests/vault/results/migration.json) record **97 passing
checks**, including 4,031/4,032-block boundaries, authorization, cancellation,
replacement/reset, pool binding, candidate batch/resting/parked rejection, donated new-vault balances
accepted at proposal/confirmation and credited on its first batch, old idle
STX/sBTC donations accepted without blocking confirmation, all 14 stale-target rejections, old/new tranche attribution, future
funding only to the new address, preserved prior payouts and a fresh second delay.
Replacement copies exist only in the test's in-memory simnet, not production files.
The fork harnesses deploy the trait first and supply the active-vault argument.
[Current Stxer reports](../../simulations/README-pool-vault-stx.md) record **570/570 passing checks** across 11 forks, including 89 rotation checks and a real post-switch reward claim, swap, finalization and payout. All three deployed source hashes match `fc58b61`. The candidate copies and private state seeds exist only in the forks. Run rotation with:

```bash
node simulations/pool-vault-upgrade-stxer.mjs
```

Earlier Rendezvous reports validate the recorded pre-rotation hashes; they do not test the rotation feature.
