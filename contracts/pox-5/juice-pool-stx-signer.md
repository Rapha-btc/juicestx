# `juice-pool-stx-signer` — the pox-5 surface Juice actually uses

Companion to [`juice-pool-stx-signer.clar`](./juice-pool-stx-signer.clar), the **deployed**
STX-only pox-5 staking pool.

| | |
|---|---|
| Contract | `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.juice-pool-stx-signer` |
| Clarity version | 5 |
| Deployed | Stacks block 8,671,025 · 2026-07-31 |
| Signer key | `0x038d545b66cc01a93fe405e14d6432432d81ec03e296d55cf3c07b143a4407aa4a` |
| Signer key's principal | `SP3C0VDGRRBFFAXV09KCE82HS82TVCEDHNHBT2EYC` (`hash160` of the key) |
| Registered by | [`0xaf26b5f8…dd4c7b70`](https://explorer.hiro.so/txid/0xaf26b5f8fba114dbc628be6a11e89fe13410ccdfd23410a8420c5d57dd4c7b70) (`register-self`) |
| First cycle | 141 |

> Unlike [`pox-5-functions-for-juice.md`](./pox-5-functions-for-juice.md), which is
> provisional and written against a pre-release pox-5 for the **jBTC bond** path, this
> document describes **shipped** pox-5 (stacks-core 4.0.1) and a contract that is live on
> mainnet. Where the two disagree, this one is right.

---

## The whole pox-5 surface, and what we do with it

pox-5 exposes 18 public functions. This is every one of them, so "did we forget
something?" has a written answer instead of being re-derived each time.

### We call these

| pox-5 function | our entry point | why it must be us |
|---|---|---|
| `grant-signer-key` | `register-self` | pox-5 asserts `contract-caller` is the signer-manager, so **an EOA cannot make this call**, whoever holds the key |
| `register-signer` | `register-self` | asserts `contract-caller` is the signer contract itself |
| `claim-rewards` | `claim-rewards` | the signer must be the direct caller; pulls the cycle's sBTC lump into this contract |

### Stakers call these directly — no wrapper is possible

`stake`, `stake-update`, `unstake`. These take the signer-manager as an *argument*;
the caller is the staker. The front end builds them.

`stake-update` is worth knowing: it takes a new AND an old signer-manager and does
**not** require them to match, so switching pools is one transaction — no unstake, no
unlock wait. That is both our best acquisition path and the reason a staker can leave
us just as fast.

### Deliberately not used

| pox-5 function | why not |
|---|---|
| `register-for-bond`, `update-bond-registration`, `setup-bond`, `unstake-sbtc` | bonds and sBTC staking. This pool is **STX only**. The bond path lives in `juice-signer-manager.clar`. |
| `claim-staker-rewards-for-signer` | the **reference manager's** pull model: one call per staker per cycle. We claim the whole lump with `claim-rewards` and split it ourselves in `pay-stx-stakers`, 100 stakers per transaction. Different architecture, not an omission. |
| `announce-l1-early-exit` | starts with `(unwrap! (get-bond-membership staker) ERR_NOT_BOND_PARTICIPANT)` and asserts `contract-caller == tx-sender == staker`. Bond-only **and** staker-only — a signer-manager wrapper could never help. |
| `calculate-rewards` | read path, called inside pox-5's own `claim-rewards`. |
| `pause-rewards`, `set-pause-admin`, `set-bond-admin`, `set-burnchain-parameters` | protocol-level admin. Not ours. |
| `revoke-signer-grant` | callable, but **not from this contract** — see below. |

---

## Key rotation

`register-self` is **not one-shot**, despite what the source comment used to say.

- `auth-id` is single-use per **grant** — pox-5 records `(signer-key, signer-manager,
  auth-id)` in `used-signer-key-grants` and rejects a repeat. That is per grant, not per
  registration.
- pox-5's `register-signer` ends in `(map-set signers signer signer-key)` — a `map-set`,
  not a `map-insert`.
- Nothing in our contract guards against a second call.

So calling `register-self` again with a **new** signer key, a **fresh** `auth-id`, and a
signature from the new key rotates the pool's signer key.

This matters precisely when it is least convenient to discover. pox-5 requires
`contract-caller` to be the signer contract, so **no EOA can register or rotate on the
pool's behalf** — `register-self` is the only route, and it is admin-gated.

```
register-self(signer-manager, signer-key, auth-id, signer-sig)
  where signer-sig = 65-byte secp256k1 signature over
        get-signer-grant-message-hash(signer-manager, auth-id)
        produced off-chain by the signer key's PRIVATE key
```

`signer-manager` must be this contract: pox-5 derives the signer as
`(contract-of signer-manager)` and compares the grant against it. No `as-contract` —
both calls must see this contract as the direct caller.

## `revoke-signer-grant` — the key holder's veto

pox-5 keeps a `signer-key-grants` map keyed on `{signer-key, signer-manager}`. It is a
permission slip: *the holder of this key consents to that contract acting as a signer
using it.*

| function | effect on the slip | caller |
|---|---|---|
| `grant-signer-key` | creates it | the **manager contract**, carrying a signature from the key |
| `verify-signer-key-grant` | reads it — `register-signer` fails without it | anyone (read-only) |
| `revoke-signer-grant` | **deletes it** | the **key's own principal** |

`revoke-signer-grant` asserts that `contract-caller` equals the standard principal
constructed from `hash160(signer-key)`. It needs no signature, because sending from that
address already proves possession of the key — it is the exact counterpart of the
`signer-sig` we produce in `register-self`. Consent granted by signature, consent
withdrawn by transaction.

**What it does not do.** It deletes the permission slip only. It does *not* unregister
the signer: `signers` still maps this contract to the key, the reward set is unaffected,
and stackers keep earning. It blocks **future** `register-signer` calls for that
(key, contract) pair, nothing more.

**Operational note.** The revoking address, `SP3C0VDGRRBFFAXV09KCE82HS82TVCEDHNHBT2EYC`,
is derived from the signer key that lives on the juice box. It is not a wallet that opens
in Leather — sending that transaction means signing with the box key. So this is not an
`/admin` button, and should not become one. The realistic use is retiring an old grant
after a rotation.

---

## Fee governance

Deliberately narrower than the reference manager
([`stx-labs/signer-sidekick`](https://github.com/stx-labs/signer-sidekick/tree/main/contracts/reference-manager/generated/mainnet),
generated from `friedger/clarity-pox-5-pool`).

| | reference manager | this contract |
|---|---|---|
| ceiling | `MAX_BIPS` = 100% | `MAX_FEE_BIPS` = **20%**, a constant |
| how it is set | one `update-fees`, immediate | `propose-fee-bips` → **144 burn blocks** → `confirm-fee-bips` |
| retroactivity | fee snapshots at crystallization, so a raise hits rewards earned *before* it was set (their own header says so) | rewards are **pushed** twice per cycle, so nothing sits unclaimed waiting to be repriced |

`fee-bips` is written in exactly one place, `confirm-fee-bips`, reachable only after a
proposal that printed publicly. There is no `set-fee-bips`.

**Known gap, currently harmless.** The rate is read **live** at payout rather than
snapshotted per cycle, so tranche 1 and tranche 2 of the same cycle could be charged
differently. That was a deliberate trade — snapshotting costs a map write per tranche to
defend against someone who already holds the admin key and could pause the pool anyway —
but the reference manager is more principled here. While `fee-bips` is `u0` it cannot
affect anyone. **Treat a fee proposal as the trigger to add the snapshot first.**

---

## Print topics

One SecondLayer `print_event` subscription on this contract covers all of them; the
receiver dispatches on `topic`.

| topic | emitted by | consumed by |
|---|---|---|
| `validate-stake` | pox-5's callback on every stake pointed at us | `/api/sl/record-pox5-stake` → staker roster |
| `claim-rewards` | `claim-rewards` | logged |
| `pay-stx-stakers` | `pay-stx-stakers` | `/api/sl/record-pox5-stake` → payouts |
| `settle-stakers` | `settle-stakers` | logged |
| `sweep-tranche-dust` | `sweep-tranche-dust` | logged |
| `propose-fee-bips`, `confirm-fee-bips`, `cancel-fee-bips`, `set-og`, `withdraw-fees` | admin | logged |

**`pay-stx-stakers` prints one aggregate per batch** — `count`, `total`, `fees` — and
never names a staker. Per-staker amounts are only recoverable from the sBTC
`ft_transfer` events in the same transaction. Any consumer of the payout feed has to read
the transaction, not just the print.

**There is no print on unstake.** The signer-manager trait has one function,
`validate-stake!`, so pox-5 calls us on the way in but not on the way out. The
`validate-stake` feed is an accurate *join* roster; it is not a list of current stakers.
The contract's own share accounting is the source of truth for who is owed, which is why
`pay-stx-stakers` divides by `get-cycle-total-shares`.
