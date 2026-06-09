# jBTC on PoX-5 — Bond Requirements & Open Questions

**Goal:** extend Juice from jSTX (liquid stacking of STX) to **jBTC** — a *pooled* form of
Bitcoin L1 staking, where the pool holds **sBTC + STX** and stakes on behalf of depositors via
the upcoming **PoX-5** contract, issuing a liquid jBTC token against the position.

> ⚠️ **Provisional.** Everything below is read from the WIP contract on
> `stacks-network/stacks-core` branch
> [`pox-wf-integration`](https://github.com/stacks-network/stacks-core/tree/pox-wf-integration),
> file `stackslib/src/chainstate/stacks/boot/pox-5.clar` (brice's pox-locking PR
> [#7062](https://github.com/stacks-network/stacks-core/pull/7062) targets this branch, building
> on Aaron's `feat/pox-5-integration`). Constants and the admin/allowlist model can still change
> before mainnet. The local `contracts/external/pox-5.clar` in this repo is currently an empty
> placeholder — populate it from the branch before testing.

Background: [Bitcoin Staking Whitepaper](https://forum.stacks.org/t/the-bitcoin-staking-whitepaper/18834)
· [Bitcoin Staking SIP v1 Draft](https://forum.stacks.org/t/introducing-the-bitcoin-staking-sip-v1-draft/18862)

---

## 1. PoX-5 is a new architecture (not PoX-4 delegation)

There is **no `delegate-stx` / `delegate-stack-stx` / `stack-aggregation-commit`** in PoX-5.
The model is rebuilt around three roles:

- **bond** — a protocol-defined staking position with a target rate, an STX-pairing ratio, a
  fixed length (`BOND_LENGTH_CYCLES u12`), and an **allowlist** of who may join it. Created only
  by the `bond-admin`.
- **signer** — registered via `register-signer` with a signer-key grant; carries a
  `signer-manager` contract implementing `signer-manager-trait`. Signer-set entry floor is
  `SIGNER_SET_MIN_USTX u50000000000` (**50,000 STX**, tbc).
- **staker** — joins a bond via `register-for-bond`, locking the Bitcoin side either as native
  L1 BTC or as **custodied sBTC**, paired with STX.

## 2. Two ways to supply the Bitcoin side — and why a pool must use sBTC

`register-for-bond`'s `btc-lockup` argument is a `response`, and the contract branches on it:

```clarity
(sats-total (try! (match btc-lockup
    l1-lockups  (verify-l1-lockups tx-sender bond-index l1-lockups) ;; ok  → native BTC L1 lockup (Merkle-proven)
    sbtc-amount (ok sbtc-amount))))                                 ;; err → sBTC custody, L1 proof skipped
...
is-l1-lock: (is-ok btc-lockup)   ;; true = L1 native, false = sBTC custody
```

- **`ok` variant** → you submit a native Bitcoin L1 lockup; `verify-l1-lockups` /
  `validate-l1-lockup` check the BTC tx outputs + Merkle proof. This is the **self-custody solo**
  path — you can't pool other people's keys-on-L1 BTC.
- **`err` variant** → the contract pulls your **sBTC into custody** (`roll-sbtc`) and skips L1
  verification. This is the **poolable** path. **jBTC must use this.**

Both paths grant the same bond and the same yield; they differ only in where the BTC sits and
which flows are available. The whitepaper's "primary tranche" = paired BTC+STX positions during
the ~12-month managed bootstrap (targets cited: ~3,000 BTC capacity, ~3% BTC APY, 5% min STX
pairing).

## 3. The call Juice makes

Entry point: **`register-for-bond`**, sBTC path, wrapped in `as-contract`:

```clarity
(as-contract                          ;; ← makes tx-sender = Juice contract (the staker)
  (contract-call? .pox-5 register-for-bond
    bond-index            ;; the bond Juice was allowlisted into
    .juice-signer-manager ;; a signer-manager-trait contract (signer = its principal)
    amount-ustx           ;; STX paired (must clear the ~5% minimum)
    (err sats-amount)     ;; ERR variant = sBTC path; the sats to custody
    none))                ;; optional signer-calldata
```

**Why `as-contract` is mandatory:** the staker is `tx-sender`, and sBTC is transferred *from*
`tx-sender` and custodied *under* `tx-sender`:

```clarity
(try! (roll-sbtc tx-sender old-sbtc new-sbtc))   ;; sbtc-token transfer: tx-sender → pox-5
```

Without `as-contract`, `tx-sender` is the admin EOA and PoX-5 pulls the admin's *personal* sBTC.
With `as-contract`, `tx-sender` = the Juice contract, so the **pool's** sBTC is staked and the
bond membership is custodied under Juice's principal (one position backing all jBTC). It also
makes `tx-sender == contract-caller`, satisfying `check-caller-allowed`.

## 4. It succeeds **if and only if** — exact conditions

### Prerequisites (state that must already exist)

| # | Condition | Code | Failure |
|---|-----------|------|---------|
| 1 | Bond exists | `(unwrap! (map-get? protocol-bonds bond-index) ...)` | `ERR_BOND_NOT_FOUND (u7)` |
| 2 | **Juice principal is on the bond allowlist** | `(unwrap! (map-get? protocol-bond-allowances {staker: tx-sender, bond-index}) ...)` | `ERR_NOT_ALLOWLISTED (u11)` |
| 3 | Signer registered | `(asserts! (is-some (get-signer-info signer)) ...)` where `signer = (contract-of signer-manager)` | `ERR_SIGNER_NOT_FOUND (u23)` |
| 4 | signer-manager approves | `(try! (contract-call? signer-manager validate-stake! tx-sender bond-index u1 amount-ustx sats-total true signer-calldata))` must return `(ok …)` | trait's own err |

### Per-call asserts (in execution order)

| # | Condition | Code |
|---|-----------|------|
| 1 | Not in prepare phase — `(try! (verify-not-prepare-phase))` | `ERR_STAKE_IN_PREPARE_PHASE (u47)` |
| 2 | Enough paired STX — `(>= amount-ustx (min-ustx-for-sats-amount sats-total (get stx-value-ratio bond) (get min-ustx-ratio bond)))` | `ERR_INSUFFICIENT_STX (u8)` |
| 3 | Bond not started — `(< burn-block-height bond-start-height)` (register **before** start) | `ERR_BOND_ALREADY_STARTED (u43)` |
| 4 | No conflicting STX-only stake (`staker-info` ends ≤ this bond's first cycle) | `ERR_ALREADY_STAKED (u19)` |
| 5 | Within allowlisted cap — `(<= sats-total allowance)` | `ERR_TOO_MUCH_SATS (u10)` |
| 6 | Caller authorized — `tx-sender == contract-caller` (true under `as-contract`) or a non-expired `allow-contract-caller` grant | `ERR_UNAUTHORIZED_CALLER (u22)` |
| 7 | No overlapping bond membership — `(not (bond-overlaps-new-position? existing-membership first-reward-cycle))` | `ERR_ALREADY_REGISTERED (u9)` |
| 8 | Rollover window — if rolling from a prior membership, its L1 unlock height has passed | `ERR_ROLLOVER_TOO_EARLY (u48)` |
| 9 | sBTC transfer succeeds — `(try! (roll-sbtc tx-sender old-sbtc new-sbtc))`; Juice must hold ≥ `sats-total` sBTC | (sbtc-token err / revert) |

On success: writes `protocol-bond-memberships` with `is-l1-lock: false`, updates the
staked-shares maps, runs `settle-rewards`, emits a `register-for-bond` print event.

### The bond record (set by `bond-admin` in `setup-bond`)

```clarity
(define-map protocol-bonds uint {
    target-rate: uint,
    stx-value-ratio: uint,   ;; uSTX per 100 sats (live STX/BTC price representation)
    min-ustx-ratio: uint,    ;; bps — the "~5%" STX-vs-sBTC pairing minimum
    early-unlock-bytes: (buff 683),
    early-unlock-admin: principal,
})
```

The "~5%" is **not a hardcoded constant** — it's `min-ustx-ratio` (× `stx-value-ratio`), set
per-bond by the admin. The allowlist is a `setup-bond` parameter
(`(list 1000 {staker, max-sats})`), written once via `map-insert` and **frozen at bond
creation** (no add-staker-later function). If Juice isn't in the list when `setup-bond` is
called for a bond, Juice cannot join *that* bond.

## 5. The gate that matters: the allowlist

`bond-admin` is a **single principal** (`define-data-var bond-admin`, init null, set at boot),
the only caller of `setup-bond`. There is **no on-chain qualification** a staker can self-satisfy
to get a bond allowance — it's an **off-chain/social** decision: the admin includes your
principal (+ a `max-sats` cap) in the allowlist when creating the bond. **This is the thing Juice
must secure.**

## 6. Where Juice stands

- ✅ **Signer with ~400k STX (nascent)** — comfortably clears the `SIGNER_SET_MIN_USTX` 50k STX
  floor (tbc).
- ✅ Existing jSTX architecture (vault, pool, stacker, yield, registry) — reusable patterns.
- ⛳ **Need:** a `signer-manager`-trait contract (`validate-stake!` + `checkpoint-staker`) and a
  registered signer key for PoX-5; a jBTC token + sBTC-custody vault path; and the `as-contract`
  `register-for-bond` integration.
- ⛔ **Blocker:** being on a bond's allowlist with a meaningful `max-sats` cap. Requirements for
  this are **not in the contract** — they're set by whoever holds `bond-admin`.

---

## 7. Questions for brice / friedger / Stacks Endowment

**A. Allowlist / bond access (the blocker)**
1. What are the actual requirements to get **whitelisted into a bond's `setup-bond` allowlist**
   so Juice can offer jBTC? Is there an application/KYB process, a STX/collateral commitment, a
   technical bar (running signer + signer-manager), or is it purely discretionary?
2. Who holds the `bond-admin` key for tranche 1 — Stacks Labs, a foundation multisig, governance?
3. What `max-sats` cap can a pool operator expect in tranche 1, and how is total ~3,000 BTC
   capacity divided across allowlisted operators?
4. The allowlist is **frozen at `setup-bond`** (no add-later). How often are new bonds created,
   and how do we make sure Juice is in the list *before* a bond's start height?

**B. Pooling via sBTC custody**
5. Confirm the **sBTC-custody (`err`) path** is the intended/sanctioned route for *pooled* LSTs
   like jBTC, and that pooled sBTC positions are eligible for the primary-tranche target yield
   (not only the STX-only/reserve split).
6. Is there any per-operator or per-bond cap difference between the L1-native and sBTC-custody
   paths?

**C. Signer & signer-manager**
7. We already run a signer (~400k STX, nascent). Is that signer reusable for PoX-5, or do we need
   a fresh signer-key grant + `register-signer` flow? What grants signer keys (`grant-signer-key`
   authority)?
8. Is there a reference / required implementation for the **`signer-manager-trait`**
   (`validate-stake!`, `checkpoint-staker`)? What must `validate-stake!` enforce vs. leave to the
   operator?

**D. STX locking & economics**
9. Where exactly does the **paired STX get locked**? `register-for-bond` records `amount-ustx`
   but performs no STX transfer — confirm the native pox-locking layer (PR #7062) locks the
   staker's STX in place, keyed off this call, and what the unlock schedule is.
10. Final numbers for tranche 1: `min-ustx-ratio` (the "5%"), `target-rate` (BTC APY),
    `SIGNER_SET_MIN_USTX`, `BOND_LENGTH_CYCLES` — are the whitepaper figures (3,000 BTC / 3% /
    5% / 50k STX / 12 cycles) the values that will ship?

**E. Roadmap**
11. Is the `bond-admin` allowlist the long-term access model, or a bootstrap step toward a
    permissionless join later? Timeline for PoX-5 mainnet activation?
