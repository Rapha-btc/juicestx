# Manual Self-Delegation Runbook

How a signer operator manually bootstraps their own stacking pool by self-delegating from a multisig (Asigna) directly to their signer's pool admin, without using the STX Juice protocol contracts.

This is what you do **before** the protocol's automation is wired up — to manually register your signer for a cycle. Future cycles should use the protocol's `pool.clar` automation; this doc documents the manual fallback path.

## Three Roles, Three Addresses

The mental model that trips everyone up. These are **separate keys / addresses**, not one combined identity:

| Role | Identity | Touches |
|---|---|---|
| **Delegator** | STX wallet (e.g. Asigna multisig) | Owns STX. Calls `delegate-stx` to permit a pool admin. |
| **Pool admin** | Hot STX wallet (Leather/Xverse) | Calls `delegate-stack-stx` and `stack-aggregated-commit-indexed`. |
| **Signer** | secp256k1 keypair on the signer box | Signs Stacks blocks AND signs an `agg-commit` message that proves the signer authorizes the pool admin's commit. |

The link between pool admin and signer is **cryptographic**, not address-based. The pool admin's `stack-aggregated-commit-indexed` call includes the signer's pubkey AND a signature over `(pox-addr, reward-cycle, period, method, max-amount, auth-id, network)`. pox-4 verifies the signature against the pubkey. That's what binds the pool to the signer.

**Do not** import the signer privkey into a hot wallet to use as pool admin. Signer key must stay on the signer host.

## Three Transactions, In Order

```
delegator (multisig)        pool admin (hot wallet)        pool admin (hot wallet)
──────────────────────      ──────────────────────────     ─────────────────────────────
delegate-stx        ──>     delegate-stack-stx       ──>   stack-aggregated-commit-indexed
                                                            (with signer signature)
```

All three target `SP000000000000000000002Q6VF78.pox-4`. Tx 2 fails until tx 1 confirms. Tx 3 fails until tx 2 confirms.

### Tx 1: `delegate-stx` (delegator)

**Where:** Asigna multisig (https://app.asigna.io) → Earn → Stack in a pool → Custom Pool, OR a generic contract call.

**Args:**

| Arg | Value | Notes |
|---|---|---|
| `amount-ustx` | uSTX (STX × 1e6) | How much to authorize for delegation |
| `delegate-to` | pool-admin STX address | Hot wallet that will run txs 2 and 3 |
| `until-burn-ht` | `none` | `none` = open-ended (recommended) |
| `pox-addr` | `none` | Leaving `none` lets pool admin pick any reward address per cycle |

**Why `pox-addr = none`:** `delegate-stack-stx` and `delegate-stack-extend` enforce `(asserts! (match (get pox-addr delegation-info) specified-pox-addr (is-eq pox-addr specified-pox-addr) true) ...)`. If `delegate-stx`'s pox-addr is set, **all** subsequent locks for this delegator must use that exact address forever. Leaving it `none` gives the pool admin freedom to change reward addresses across cycles without re-onboarding the delegator.

### Tx 2: `delegate-stack-stx` (pool admin)

**Where:** https://earn.leather.io/pool-admin → "Delegate Stack STX". Connect with hot pool-admin wallet.

**Args:**

| Arg | Value | Notes |
|---|---|---|
| `stacker` | delegator address (the multisig) | The cold delegator from tx 1 |
| `amount-ustx` | uSTX | Must be ≤ `amount-ustx` from tx 1 |
| `pox-addr` | `{ version, hashbytes }` | BTC reward address. Leather encodes from the bc1.../1.../3... string. Taproot = version `0x06`. |
| `start-burn-ht` | current burn block | Must satisfy `burn-height-to-reward-cycle(start-burn-ht) + 1 = current_cycle + 1`. Practically: any burn block in the current cycle. UI auto-fills. |
| `lock-period` | `1` (recommended for first cycle) | 1–12 cycles. 1 cycle = ~15 days. Use 1 for first run to validate; extend later. |

**Important:** the contract's `start-burn-ht` check is strict — it must put `first-reward-cycle` exactly at `current_cycle + 1`. Don't post-date this tx into the next cycle.

### Tx 3: `stack-aggregated-commit-indexed` (pool admin)

**Where:** https://earn.leather.io/pool-admin → "Stack Aggregation Commit". Same hot wallet.

**Args:**

| Arg | Value | Notes |
|---|---|---|
| Reward cycle | `current_cycle + 1` | The cycle being committed |
| `pox-addr` | same as tx 2 | Where rewards land |
| `signer-key` | 33-byte compressed pubkey (hex) | From signer config / `docker logs signer` |
| `signer-sig` | 65-byte RSV signature (hex) | Generate on signer box (see below) |
| `max-amount` | uSTX cap for this commit | `>=` actual partial-stacked total. Set higher for headroom (allows future delegators in same cycle). |
| `auth-id` | unique uint per signature | Replay protection. Bump for each new signature you generate. |

**Deadline:** must land before the cycle's prepare phase ends (~100 BTC blocks before next cycle starts). After that, your signer is not in the reward set for that cycle.

## Generating the Signer Signature

**Never paste the signer privkey into a webpage.** Generate the signature on the signer host using `stacks-signer generate-stacking-signature`. The signature is public (one-shot, bound to specific params); the privkey is not.

Inside the signer container:

```bash
docker exec signer stacks-signer generate-stacking-signature \
    --config /etc/signer/config.toml \
    --pox-address bc1p... \
    --reward-cycle <N> \
    --period 1 \
    --method agg-commit \
    --max-amount <uSTX> \
    --auth-id <unique-int>
```

Outputs:

```
Signer Public Key: 0x...
Signer Key Signature: 0x...
```

For `stack-aggregated-increase` (adding more delegators to an already-committed cycle), repeat with `--method agg-increase` and a fresh `--auth-id`.

## Adding More Delegators After You've Already Committed

`stack-aggregated-commit-indexed` does not seal the pool. To add new delegators to the same cycle:

1. New user calls `delegate-stx` → your pool admin
2. Pool admin calls `delegate-stack-stx` for them (adds to partial-stacked total at same pox-addr)
3. Pool admin calls **`stack-aggregated-increase`** (different function, needs `agg-increase` signature) to bump the reward slot's committed amount

All before the prepare phase ends. After the cycle starts, late delegators wait for the next cycle.

## Gotchas

### Leather Earn `max-amount` field is in STX, not uSTX

Despite generating signatures in uSTX (`--max-amount 6000000000000` = 6M STX), the Leather Earn pool-admin form's "Maximum amount of STX" field expects **STX**, then multiplies by 1e6 internally before sending to the contract.

To match a signature generated for `--max-amount 6000000000000` (6e12 uSTX):

- Enter `6000000` in the form (6M STX).
- Leather converts to `6000000000000` uSTX on submission. ✓

Entering `6000000000000` in the form sends `6e18` uSTX → signature mismatch + JS BigInt errors that silently disable the submit button (no error message, just dead clicks).

Verify in browser devtools: the submitted `maxAmount` should match what the signer signed over.

### Leather Earn's client-side signature validator is buggy

The "Unable to validate signature" warning often appears even with correct sigs (the page banners "Leather Earn is outdated"). The on-chain contract validation works correctly regardless. Only treat it as a real error if the submit button is disabled AND the browser console shows `Cannot convert NaN to a BigInt` — that points to the units bug above.

### Pool admin needs STX for fees

The hot pool-admin wallet pays tx fees for txs 2 and 3 — typically ~0.005 STX total. Fund it from somewhere before starting.

### Signer is not "registered" until tx 3 lands

`docker logs signer` will show:

```
Signer ... was not found in stacker db. Must not be registered for this reward cycle N.
```

That's expected before tx 3 confirms. After it lands, the warning flips to confirmation that the signer is registered for the next cycle.

### Cold wallet not needed after tx 1

Once `delegate-stx` is on-chain, the multisig's job is done. txs 2 and 3 are pool-admin only. Don't queue more multisig signatures unless you need to revoke or change delegation amount.

## When to Use This Runbook vs. The Protocol

This runbook is the **manual baseline** — useful for:

- Initial signer bootstrapping before automation is deployed
- Self-delegation of personal STX to your own signer
- Debugging when the protocol's automation fails for a cycle (you can hand-finalize)

For everything else — multi-signer pool operation, treasury-scale delegations, automatic cycle finalization — use the STX Juice protocol contracts (`pool.clar` + `stacker.clar` + the keeper). See `pox-cycle-operations.md` and `stacker-architecture.md`.
