# PoX-5 — the functions Juice touches for jBTC

A function-by-function walkthrough of `contracts/external/pox-5.clar`, scoped to the
**pooled sBTC-custody path** Juice uses to issue jBTC. Line numbers are against the
3,199-line contract in this repo (the `pox-wf-integration` source). Read this together
with [`jbtc-pox5-bond-requirements.md`](./jbtc-pox5-bond-requirements.md), which covers the
economics, the allowlist gate, and the open questions for brice / friedger / the Endowment.

> ⚠️ **Provisional.** Constants and the admin/allowlist model can still change before
> mainnet. Build to compile-and-test, not to deploy.

---

## TL;DR — Juice's surface

- **Write:** `grant-signer-key` → `register-signer` (once), then `register-for-bond`
  (sBTC `err` path, under `as-contract`), `claim-rewards` (signer = direct caller),
  `unstake-sbtc` / rollover.
- **Implement:** `signer-manager-trait` (`validate-stake!`, `checkpoint-staker`).
- **Hold:** both **sBTC** *and* the **paired STX** in the Juice contract — pox-5 custodies
  the sBTC and the node-side locking layer locks the STX in place.
- **Yield:** arrives as **sBTC** at your signer-manager.
- **Blocker:** being on a bond's frozen `setup-bond` allowlist — an off-chain admin decision,
  not an on-chain qualification.

Execution order: **§1 register signer → §2 register-for-bond → §3 claim rewards →
§4 unstake / §5 rollover**, with §0 (the trait) implemented up front and §6 read-onlys for
pre-flight. §7 is the admin-side gate Juice depends on.

---

## 0. The trait you implement — `signer-manager-trait` (L343)

```clarity
(define-trait signer-manager-trait (
  (validate-stake!   (principal uint uint uint uint bool (optional (buff 500))) (response bool uint))
  ;; staker, first-index, num-indexes, amount-ustx, amount-sats, is-bond, signer-calldata
  (checkpoint-staker (principal uint uint bool) (response bool uint))
  ;; staker, first-index, num-indexes, is-bond
))
```

The one contract **Juice writes**. pox-5 calls back into it:

- **`validate-stake!`** — admission gate. `register-for-bond` calls it (L628) and reverts the
  whole stake on `err`. For a single-pool jBTC this can be permissive; it's where per-staker
  caps or a pause switch would live.
- **`checkpoint-staker`** — accounting hook on exit (`unstake-sbtc` L1183, `unstake` L1264),
  wrapped so it **cannot** fail the unstake (`err-val true`). Use it to snapshot jBTC share state.

Juice's **signer identity = `(contract-of signer-manager)`** — the signer-manager contract's own
principal. This drives the `tx-sender` requirements below.

---

## 1. Register the signer — two calls, in order

### `grant-signer-key` (L2168) — authorize the key off-chain
```clarity
(grant-signer-key signer-key signer-manager auth-id signer-sig)
```
The holder of the **signer private key** signs a SIP-018 message
(`get-signer-grant-message-hash`, domain `POX_5_SIGNER_DOMAIN`, topic `"grant-authorization"`,
L2261) and submits it here. The contract `secp256k1-recover?`s the **65-byte RSV** signature
(L2187) and records the grant, binding a signer pubkey to your signer-manager principal.

> RSV, 65 bytes — use `signMessageHashRsv()`, not `signWithKey()` (which is VRS).

### `register-signer` (L848) — claim it on-chain
```clarity
(register-signer signer-manager signer-key)
```
Two asserts shape the architecture:
- `verify-signer-key-grant` (L856) — the grant above must exist.
- **`(is-eq tx-sender signer)`** (L859), `signer = (contract-of signer-manager)`.

So **the signer-manager contract must call `register-signer` on itself** — Juice invokes it
under `as-contract` so `tx-sender` becomes the signer-manager principal. Give the signer-manager
a deploy-time init path that does this.

> **Signer-set floor:** `SIGNER_SET_MIN_USTX = u50000000000` (50k STX, L76), surfaced via
> `get-pox-info` (L2441). Juice's ~400k-STX signer clears it.

---

## 2. The core staking call — `register-for-bond` (L532)

**The** function Juice calls to stake the pool. sBTC path:
```clarity
(as-contract
  (contract-call? .pox-5 register-for-bond
    bond-index
    .juice-signer-manager   ;; <signer-manager-trait>
    amount-ustx             ;; paired STX (recorded; locked node-side)
    (err sats-amount)       ;; ERR variant = sBTC custody path
    none))                  ;; optional signer-calldata
```

**Branch selection (L562):** `btc-lockup` is a `response`. `(ok …)` → L1 native
(Merkle-proven via `verify-l1-lockups`); `(err sats)` → **sBTC custody — jBTC's path.**
`new-sbtc` becomes `sats-total` only on the `err` path (L573).

**Gates, in execution order:**

| # | Check | Line | Error |
|---|-------|------|-------|
| 1 | not in prepare phase (`verify-not-prepare-phase`) | 596 | `ERR_STAKE_IN_PREPARE_PHASE u47` |
| 2 | `amount-ustx ≥ min-ustx-for-sats-amount` | 598 | `ERR_INSUFFICIENT_STX u8` |
| 3 | `burn-block-height < bond-start-height` (register before start) | 607 | `ERR_BOND_ALREADY_STARTED u43` |
| 4 | no conflicting STX-only stake | 615 | `ERR_ALREADY_STAKED u19` |
| 5 | `sats-total ≤ allowance` | 625 | `ERR_TOO_MUCH_SATS u10` |
| 6 | `validate-stake!` returns ok | 628 | trait's own |
| 7 | signer registered (`get-signer-info`) | 632 | `ERR_SIGNER_NOT_FOUND u23` |
| 8 | caller allowed (`tx-sender == contract-caller`) | 635 | `ERR_UNAUTHORIZED_CALLER u22` |
| 9 | no overlapping membership / rollover window | 640, 647 | `ERR_ALREADY_REGISTERED u9` / `ERR_ROLLOVER_TOO_EARLY u48` |

On success: `roll-sbtc` moves the sBTC (L651); writes `protocol-bond-memberships` with
**`is-l1-lock: false`** (L657); bumps the share maps; runs `settle-rewards`; prints
`register-for-bond`.

**Two Juice-critical facts:**

1. **`as-contract` is mandatory.** `roll-sbtc` (L1603) transfers sBTC `tx-sender → contract`
   and membership is keyed on `tx-sender`. Under `as-contract`, `tx-sender` = the Juice
   contract → the **pool's** sBTC is staked, one membership backs all jBTC, and gate #8
   (`tx-sender == contract-caller`) passes for free.
2. **It does NOT move your STX.** `register-for-bond` only *records* `amount-ustx` — there is no
   `stx-transfer`/lock in the Clarity. The node-side pox-locking layer locks `tx-sender`'s STX
   (PR #7062). So **Juice's contract must hold both legs**: the sBTC (custodied into pox-5) and
   the paired STX (locked in place). Size the treasury for both.

---

## 3. Rewards — paid in **sBTC**, to the signer

### `get-earned` (L1945) — read accrued
`(get-earned signer is-bond index)` → `pending + shares × (rpt_now − rpt_paid) / 1e18`.
Rewards-per-token accumulator model (`PRECISION = 1e18`, L94).

### `claim-rewards` (L1961)
```clarity
(claim-rewards bond-periods reward-cycle)   ;; bond-periods: (list 6 uint)
```
- **`signer = contract-caller`** (L1966) — **not** `tx-sender`. Your signer-manager must be the
  *direct* caller (call via `as-contract` from Juice, or expose a wrapper on the signer-manager).
- Rewards transfer as **sBTC** to the signer (L1982).

**Yield is sBTC**, lands at your signer-manager, and your contract redistributes it to jBTC
holders (or compounds it into the next bond). This shapes the jBTC exchange-rate accounting.

---

## 4. Exit — `unstake-sbtc` (L1148)

```clarity
(unstake-sbtc signer-manager amount-to-withdrawal-sats)
```
Partial sBTC withdrawal. Asserts the membership exists; `signer-manager` matches the recorded
signer (L1171); it's an sBTC lock not L1 (L1176, `ERR_CANNOT_UNSTAKE_SBTC u38`);
`amount ≤ staked` (L1164). Calls `checkpoint-staker`, settles rewards, decrements the share
maps, and transfers sBTC back to `tx-sender` (L1222) — call it **under `as-contract`** so the
pool (not an EOA) receives the sBTC.

> Plain `unstake` (L1241) is for the **STX-only** position (`staker-info`), not the bond — not
> the jBTC path.

---

## 5. Rollover & signer change

- **Rollover is not a special call** — call **`register-for-bond` again** into bond **N+6**
  (12 cycles later; `BOND_GAP_CYCLES = 2`, `BOND_LENGTH_CYCLES = 12`, so +6 indices = +12
  cycles). pox-5 nets the sBTC transfer via `roll-sbtc` (only the delta moves) and the overlap /
  window gates (L640–647) require you to do it inside the **L1 unlock window** =
  `get-bond-l1-unlock-height` (L2677), the last ½ cycle of the bond. The keeper must fire in
  that window.
- **`update-bond-registration`** (L722) — swap the signer-manager mid-bond. Likely not needed
  at launch.

---

## 6. Read-onlys for the keeper's pre-flight

| Function | Line | Use |
|----------|------|-----|
| `get-bond-allowance bond-index staker` | 2450 | **the gate** — allowlisted? what `max-sats`? |
| `get-protocol-bond bond-index` | 2671 | pull `stx-value-ratio`, `min-ustx-ratio` |
| `min-ustx-for-sats-amount sats ratio min-ratio` | 2484 | `(stx-value-ratio·sats/100)·min-ustx-ratio/10000` |
| `get-bond-membership staker` | 2461 | current (non-expired) membership |
| `get-staker-custodied-sbtc staker` | 2364 | sBTC currently locked for you |
| `get-bond-l1-unlock-height bond-index` | 2677 | when you may roll / exit |
| `is-in-prepare-phase` | 2341 | don't stake/unstake in prepare |
| `get-signer-info signer` | 2510 | confirm signer registered |
| `get-earned signer is-bond index` | 1945 | accrued sBTC yield |
| `current-pox-reward-cycle` / `bond-period-to-reward-cycle` | 2316 / 2296 | cycle math |

---

## 7. The gate Juice depends on — `setup-bond` (L407, admin-only)

`bond-admin`-only (L423). Writes the `protocol-bonds` record **and** folds the allowlist into
`protocol-bond-allowances` via `add-staker-to-bond` (L490), which uses **`map-insert`** (L507) —
**frozen at creation, no add-later**. Bond params:
```clarity
{ target-rate, stx-value-ratio, min-ustx-ratio, early-unlock-bytes, early-unlock-admin }
```
The "~5%" pairing minimum is `min-ustx-ratio` (bps), **not** a constant. `bond-admin` is a single
principal set at boot (L308).

**This is the only real blocker.** There is no on-chain qualification a staker can self-satisfy —
getting Juice's principal into a bond's `setup-bond` allowlist (with a useful `max-sats`) is the
admin's off-chain decision. See questions A1–A4 in
[`jbtc-pox5-bond-requirements.md`](./jbtc-pox5-bond-requirements.md).

---

## Key constants (L66–98)

| Constant | Value | Meaning |
|----------|-------|---------|
| `BOND_LENGTH_CYCLES` | `u12` | bond term in reward cycles |
| `BOND_GAP_CYCLES` | `u2` | spacing between bond start indices |
| `MAX_NUM_CYCLES` | `u96` | max lock for STX-only `stake` |
| `SIGNER_SET_MIN_USTX` | `u50000000000` | 50k STX signer-set floor |
| `PRECISION` | `u1000000000000000000` | 1e18, rewards-per-token scaling |
| `RESERVE_RATIO` | `u1500` | reserve mechanism (not central to the basic flow) |
| sBTC token | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` | custody + reward asset |

---

## Next step

Scaffold `juice-signer-manager` (trait impl + the `as-contract`
`register-signer` / `register-for-bond` / `claim-rewards` wrappers) against these exact
signatures, with a `clarinet check` setup that uses this `pox-5.clar` as the external dep.
