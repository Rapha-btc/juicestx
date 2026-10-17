# Juice safe stxer sims (Earn BTC + Grow STX)

Mainnet-fork simulations of the two Juice staking safes, deployed fresh in the
fork from the **live template bytes** (sha512/256 checked against
`fakfun-wallet-core-v2 get-verified-contract-hash` before every run):

- **Earn BTC** = `juice-safe-v9`, stakes with `juice-pool-stx-signer`, rewards paid in sBTC.
- **Grow STX** = `juice-autostake-safe`, stakes with `juice-pool-sbtc-signer`; rewards are
  swapped to STX by `juice-sbtc-autoswap`, paid in STX, and the keeper calls `restake()`.

Both safes are deployed as `SP28MP1HQDJWQAFSQJN2HBAXBVP7H7THD1W2NYZVK.sim-earn-btc-safe` /
`.sim-grow-stx-safe` and onboarded by FAKFUN-DEPLOYER with admin
`SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51`, recovery `SP3HXJJ...`, limits
**5,000 STX / 100,000 sats** per period and a **144-block** cooldown.
Nothing is broadcast; every run is a stxer fork.

| Sim | File | What it covers | Result | stxer |
|---|---|---|---|---|
| Happy path (baseline) | `juice-safes-happy-path-stxer.mjs` | deploy, onboard (dummy pubkey), fund, admin stake 1,000 STX, advance, unstake, unlock, withdraw | all PASS | https://stxer.xyz/simulations/mainnet/ab4d78476d6bc5393452839c2aaee5e0 |
| Rewards | `juice-safes-rewards-stxer.mjs` | real pox-5 reward round into both safes; Grow swap + keeper restake | 60/60 | https://stxer.xyz/simulations/mainnet/f0cadb2e81b25c0672546e2aeaf3c613 |
| Limits + passkey + gas | `juice-safes-limits-passkey-stxer.mjs` | over-limit queue / cooldown / veto / execute-now, real P-256 passkey path, replay + domain binding, gas-station edge | 115/115 | https://stxer.xyz/simulations/mainnet/eb4b98e60dc722d3e33c895c992ca240 |

Earlier runs of the same harnesses: rewards before the bond fix
`3b0e3e875328d9daef22bbdcc038eab3` (43/60, see "Bonds" below), limits first
run `e9c1bf877b51ccb3ac878d54f0ae1798` (113/113, before the admin-gas step was
rewritten).

Shared code: `_juice-safes-lib.mjs` (template load + hash check, P-256 passkey,
SIP-018 hashes, step/plan/assert harness, STX funding from rich mainnet
accounts). Results are written to `results/juice-safes/<name>.json`.

## How to re-run

```
cd ~/projects/juicestx
node simulations/juice-safes-happy-path-stxer.mjs
node simulations/juice-safes-limits-passkey-stxer.mjs
node simulations/juice-safes-rewards-stxer.mjs   # fetches a Lazer update (keyless route), forks ~35 min back
```

Env: `STACKS_API_URL` (default the juice box `http://77.42.3.101/stacks-api`, avoids Hiro 429),
`STX_SOURCES` (comma list of addresses with unlocked STX used to fund the fork),
`JUICE_SAFES_LAG_SECS` (rewards sim fork lag), `STXER_TRACE=1`.
Each script exits non-zero on any FAIL.

---

## 1. Happy path (baseline) - `juice-safes-happy-path-stxer.mjs`

https://stxer.xyz/simulations/mainnet/ab4d78476d6bc5393452839c2aaee5e0 - all steps PASS.

| Steps | What | Result |
|---|---|---|
| 0-9 | deploy both safes from live bytes; hash == core-v2 verified hash; onboard (pubkey `0x02abab...`, sig-auth none); `get-owner`; core-v2 whitelisted | ok |
| 10-19 | admin funds each safe 1,000 STX; `stake-stx-juice` 1,000 STX; pox-5 `get-staker-info` names the right pool; all 1,000 STX locked | ok |
| 20-24 | advance into the first staked cycle (145 -> 146); still locked | ok |
| 25-26 | admin `stx-transfer` 1,000 STX while locked | `(err u1)` **expected**: STX is locked, the STX transfer itself fails |
| 27-32 | admin `unstake`; position `num-cycles` drops; still locked until the unlock cycle | ok |
| 33-39 | advance past the unlock height; STX unlocked back in the safe; pox-5 position gone | ok |
| 40+ | admin withdraws 1,000 STX to an outside address (within limit = immediate); safe balance 0; no pending op; outside address +1,000 STX | ok |

## 2. Rewards - `juice-safes-rewards-stxer.mjs`

https://stxer.xyz/simulations/mainnet/f0cadb2e81b25c0672546e2aeaf3c613 - **60/60 PASS**.

What is real and what is fork-only:
- **Real (live mainnet contracts):** both stakes through pox-5, the pool signer-set
  minimum, `calculate-rewards` (with the active protocol bonds), both pools'
  `pox-claim-rewards`, the vault's Jing place / reclaim after the real 288-block
  window / router sale with a live Pyth Lazer update, `finalize-swap`,
  `pay-stx-stakers`, the keeper `restake()`.
- **Fork-only:** (1) the reward money: a real sBTC whale sends 10 BTC to pox-5
  (pox-5 treats any balance above staked + reserve as new rewards; same method as
  the pool lifecycle sims). (2) `juice-pool-sbtc-signer` has 0 STX on mainnet, below
  pox-5's 50k STX signer minimum, so two fork-only accounts stake 30,000 STX each
  with it (pool total 61,000 STX). Below 50k the pool is not a counted signer and earns nothing.

Results:
- **Earn BTC:** stx pool claimed 2,237,639 sats for cycle 146; the safe was owed
  1,938 sats (1,000 / 1,154,034 STX of the pool, fee 0) and its sBTC balance went
  0 -> 1,938. A second payout moves nothing. The admin can withdraw it.
- **Grow STX:** sbtc pool claimed 118,277 sats into the vault; Jing place,
  reclaim after 289 blocks, one router sale -> 257,781,061 uSTX; finalize; the safe
  was paid exactly its owed 4,225,919 uSTX in STX (tranche fully paid); a stranger
  cannot restake (u4001); the keeper `restake()` locked exactly 4,225,919 uSTX and
  rolled the lock (+1 cycle); pox-5 amount 1,004,225,919.

### Bonds (finding, backend)
pox-5 now has active protocol bonds (indices **1 and 2** at cycle 146).
`calculate-rewards` must list them ordered by `stx-value-ratio` (here `(list u1 u2)`);
an empty list returns **`err u33` ERR_ACTIVE_BOND_NOT_INCLUDED** (first run
`3b0e3e87...`). The faktory-dao `pox5-keeper.ts` calculate-rewards fallback still
sends `Cl.list([])`, so that fallback would fail on mainnet today. Claims are not
affected (`pox-claim-rewards` with an empty list is fine for STX-only signers).
#### Step table (juice-safes-rewards, fork block 9236311)

| # | Step | Result | Status |
|---|---|---|---|
| 1 | [1 SETUP] [Earn BTC] deploy SP28MP1HQDJWQAFSQJN2HBAXBVP7H7THD1W2NYZVK.sim-earn-btc-safe (live juice-safe-v9 bytes) | `(ok true)` | PASS |
| 2 | [1 SETUP] [Earn BTC] fresh safe hash == template verified hash | `true` | PASS |
| 3 | [1 SETUP] [Earn BTC] onboard with REAL P-256 passkey 0338a66ad5..., admin SP9BP4PN... | `(ok true)` | PASS |
| 4 | [1 SETUP] [Earn BTC] is-admin-pubkey(passkey) | `(ok true)` | PASS |
| 5 | [1 SETUP] [Grow STX] deploy SP28MP1HQDJWQAFSQJN2HBAXBVP7H7THD1W2NYZVK.sim-grow-stx-safe (live juice-autostake-safe bytes) | `(ok true)` | PASS |
| 6 | [1 SETUP] [Grow STX] fresh safe hash == template verified hash | `true` | PASS |
| 7 | [1 SETUP] [Grow STX] onboard with REAL P-256 passkey 0338a66ad5..., admin SP9BP4PN... | `(ok true)` | PASS |
| 8 | [1 SETUP] [Grow STX] is-admin-pubkey(passkey) | `(ok true)` | PASS |
| 9 | [1 SETUP] fund sim-earn-btc-safe 1000 STX | `(ok true)` | PASS |
| 10 | [1 SETUP] fund sim-grow-stx-safe 1000 STX | `(ok true)` | PASS |
| 11 | [1 SETUP] fund SP8K2RZG 30005 STX | `(ok true)` | PASS |
| 12 | [1 SETUP] fund SP29HM6Q 30005 STX | `(ok true)` | PASS |
| 13 | [1 SETUP] [Earn BTC] admin stake-stx-juice 1,000 STX | `(ok true)` | PASS |
| 14 | [1 SETUP] [Earn BTC] pox-5 position | `(some (tuple (amount-ustx u1000000000) (first-reward-cycle u146) (num-cycles u96) (signer ...` | PASS |
| 15 | [1 SETUP] [Grow STX] admin stake-stx-juice 1,000 STX | `(ok true)` | PASS |
| 16 | [1 SETUP] [Grow STX] pox-5 position | `(some (tuple (amount-ustx u1000000000) (first-reward-cycle u146) (num-cycles u96) (signer ...` | PASS |
| 17 | [1 SETUP] fork-only staker 1 stakes 30,000 STX with juice-pool-sbtc-signer | `(ok (tuple (amount-ustx u30000000000) (first-reward-cycle u146) (num-cycles u12) (signer S...` | PASS |
| 18 | [1 SETUP] fork-only staker 2 stakes 30,000 STX with juice-pool-sbtc-signer | `(ok (tuple (amount-ustx u30000000000) (first-reward-cycle u146) (num-cycles u12) (signer S...` | PASS |
| 19 | [1 SETUP] juice-pool-sbtc-signer delegated for cycle 146 >= 50k STX | `u61000000000` | PASS |
| 20 | [1 REWARDS] into staked cycle 146: +775 burn -> 972670 (cycle 146 offset 20) | `ok` | PASS |
| 21 | [1 REWARDS] current cycle | `u146` | PASS |
| 22 | [1 REWARDS] calculate-rewards for the previous half with active bonds (flush; err u30 if mainnet already did it) | `(ok (tuple (accrued-rewards-per-ustx u184788853015) (bond-periods (list u1 u2)) (calculati...` | PASS |
| 23 | [1 REWARDS] juice-pool-stx-signer shares for 146 | `u1154034860830` | PASS |
| 24 | [1 REWARDS] juice-pool-sbtc-signer shares for 146 (counted signer) | `u61000000000` | PASS |
| 25 | [1 REWARDS] all pox-5 STX shares for 146 | `u419045609130682` | PASS |
| 26 | [1 REWARDS] rewards arrive: 10 BTC of sBTC into pox-5 (fork-only input) | `(ok true)` | PASS |
| 27 | [1 REWARDS] into the second half of 146: +1035 burn -> 973705 (cycle 146 offset 1055) | `ok` | PASS |
| 28 | [1 REWARDS] calculate-rewards books the first half of 146 | `(ok (tuple (accrued-rewards-per-ustx u1938970162903) (bond-periods (list u1 u2)) (calculat...` | PASS |
| 29 | [1a EARN] stx pool tranche index before claim | `u0` | PASS |
| 30 | [1a EARN] juice-pool-stx-signer pox-claim-rewards(146) (permissionless) | `(ok (tuple (bond-rewards (list )) (bond-totals u0) (stx-rewards (tuple (earned u2237639) (...` | PASS |
| 31 | [1a EARN] [Earn BTC] get-stx-owed for the claimed tranche | `u1938` | PASS |
| 32 | [1a EARN] [Earn BTC] safe sBTC before payout | `u0` | PASS |
| 33 | [1a EARN] [Earn BTC] pay-stx-stakers([safe]) (permissionless) | `(ok u1938)` | PASS |
| 34 | [1a EARN] [Earn BTC] safe sBTC after payout | `u1938` | PASS |
| 35 | [1a EARN] [Earn BTC] paying the safe twice moves nothing | `(ok u0)` | PASS |
| 36 | [1a EARN] [Earn BTC] admin can withdraw the reward (within limit) | `(ok true)` | PASS |
| 37 | [1b GROW] stacks-block-time at claim (vs Lazer update time) | `u1792261997` | PASS |
| 38 | [1b GROW] juice-pool-sbtc-signer pox-claim-rewards(146) -> sBTC into the autoswap vault | `(ok (tuple (bond-rewards (list )) (bond-totals u0) (stx-rewards (tuple (earned u118277) (r...` | PASS |
| 39 | [1b GROW] vault rests the sBTC on Jing (jing-place, Lazer update) | `(ok (tuple (notification "jing-place") (payload (tuple (amount u118277) (floor u2082913628...` | PASS |
| 40 | [1b GROW] vault patience window (288 blocks): +289 burn -> 973994 (cycle 146 offset 1344) | `ok` | PASS |
| 41 | [1b GROW] vault reclaims from Jing | `(ok (tuple (notification "jing-reclaim") (payload (tuple (amount u118277)))))` | PASS |
| 42 | [1b GROW] stacks-block-time at router sale | `u1792262286` | PASS |
| 43 | [1b GROW] router sells the sBTC for STX (router-swap, Lazer update) | `(ok (tuple (notification "router-swap") (payload (tuple (amount u118277) (limit-price u217...` | PASS |
| 44 | [1b GROW] router cooldown: +1 burn -> 973995 (cycle 146 offset 1345) | `ok` | PASS |
| 45 | [1b GROW] router-swap again (only if a chunk is left; err is fine) | `(err u16031)` | PASS (expected error) |
| 46 | [1b GROW] finalize-swap: the STX pot | `(ok u257781061)` | PASS |
| 47 | [1b GROW] [Grow STX] get-stx-owed (uSTX) for the safe | `u4225919` | PASS |
| 48 | [1b GROW] [Grow STX] safe before payout | `(tuple (account (tuple (locked u1000000000) (unlock-height u1174250) (unlocked u0))) (bala...` | PASS |
| 49 | [1b GROW] [Grow STX] pay-stx-stakers([safe, staker1, staker2]) in STX | `(ok u257781059)` | PASS |
| 50 | [1b GROW] [Grow STX] safe after payout | `(tuple (account (tuple (locked u1000000000) (unlock-height u1174250) (unlocked u4225919)))...` | PASS |
| 51 | [1b GROW] tranche fully paid | `true` | PASS |
| 52 | [1b GROW] [Grow STX] a stranger cannot restake -> u4001 | `(err u4001)` | PASS (expected error) |
| 53 | [1b GROW] [Grow STX] keeper (chavita SPV9K21) restake() | `(ok (tuple (amount u4225919) (cycles-to-extend u1)))` | PASS |
| 54 | [1b GROW] [Grow STX] all STX locked again | `(tuple (account (tuple (locked u1004225919) (unlock-height u1176350) (unlocked u0))) (bala...` | PASS |
| 55 | [1b GROW] [Grow STX] pox-5 position after restake | `(some (tuple (amount-ustx u1004225919) (first-reward-cycle u146) (num-cycles u97) (signer ...` | PASS |
| + | Earn BTC safe sBTC grew by exactly get-stx-owed | `+1938 sats (owed 1938)` | PASS |
| + | Earn BTC share matches stake / pool shares x claim (fee 0) | `1938 vs 1938.97 (claim 2237639)` | PASS |
| + | Grow STX safe got exactly get-stx-owed in STX | `+4225919 uSTX (owed 4225919, pot 257781061)` | PASS |
| + | restake locked exactly the payout | `4225919 vs 4225919` | PASS |
| + | pox-5 amount = 1,000 STX + payout | `1004225919` | PASS |


## 3. Limits + passkey + gas - `juice-safes-limits-passkey-stxer.mjs`

https://stxer.xyz/simulations/mainnet/eb4b98e60dc722d3e33c895c992ca240 - **115/115 PASS**.

Both safes are onboarded with a **real P-256 key** (node crypto). Every sig-auth is
built the way `stx-juice-fe/src/utils/safe-webauthn.ts` gets it from the browser:
authenticatorData = sha256("juiceofbtc.com") (= `RP-ID-HASH-JUICEOFBTC-COM`) | flags
0x05 (UP + UV) | sign counter; clientDataJSON =
`{"type":"webauthn.get","challenge":"` + base64url(SIP-018 hash) +
`","origin":"https://juiceofbtc.com","crossOrigin":false}`; ES256 signature over
authenticatorData || sha256(clientDataJSON), raw r||s, low-S. The SIP-018 hashes are
built in JS and checked in-sim against the on-chain helpers evaluated inside the safe.
Passkey calls are relayed by an unrelated address (the passkey, not the sender, authorizes).

Rules confirmed (from the source and the run):
- Over-limit request with **one key** (admin wallet, or passkey alone) is queued as a
  pending op, nothing moves. `execute-pending-*` before 144 blocks -> **u4017**; only
  the **admin wallet** can execute after the cooldown (stranger -> u4001).
- **Either key can veto**: admin (`sig-auth none`) or passkey (`build-veto-operation-hash`).
  Vetoed op -> **u4015**; executed twice -> **u4014**.
- **Both keys = immediate**: an op created by the admin wallet + a passkey
  `execute-pending-{stx,sbtc}-transfer-now` executes at once. An op created with the
  passkey cannot be fast-tracked with the same passkey -> **u4003** (it waits for the cooldown).
- Replay of a sig-auth -> **u4006**; a signature made for the Earn safe and sent to
  the Grow safe -> **u4002** (domain = `contract-caller` = the safe).
- Passkey stake (`juice-safe-auth-helpers-v2`), unstake (`juice-safe-auth-helpers-v1`)
  and Grow `set-keeper` (`juice-autostake-safe-auth-helpers-v1`) all work.
- **Gas:** the gas-station fee (20 sats sBTC) is only charged on the passkey path; it is
  paid BEFORE the transfer, so sending the **full** sBTC balance with gas fails with
  **sbtc-token `err u1`** (whole tx rolls back). Balance minus 20 sats works.
  **Known UX bug, not a contract bug:** the FE "max" must subtract the gas fee when gas
  is attached. The admin path ignores the gas param (sponsor balance unchanged).
#### Step table (juice-safes-limits-passkey, fork block tip)

| # | Step | Result | Status |
|---|---|---|---|
| 1 | [1 SETUP] [Earn BTC] deploy SP28MP1HQDJWQAFSQJN2HBAXBVP7H7THD1W2NYZVK.sim-earn-btc-safe (live juice-safe-v9 bytes) | `(ok true)` | PASS |
| 2 | [1 SETUP] [Earn BTC] fresh safe hash == template verified hash | `true` | PASS |
| 3 | [1 SETUP] [Earn BTC] onboard with REAL P-256 passkey 035bf426dc..., admin SP9BP4PN... | `(ok true)` | PASS |
| 4 | [1 SETUP] [Earn BTC] is-admin-pubkey(passkey) | `(ok true)` | PASS |
| 5 | [1 SETUP] [Grow STX] deploy SP28MP1HQDJWQAFSQJN2HBAXBVP7H7THD1W2NYZVK.sim-grow-stx-safe (live juice-autostake-safe bytes) | `(ok true)` | PASS |
| 6 | [1 SETUP] [Grow STX] fresh safe hash == template verified hash | `true` | PASS |
| 7 | [1 SETUP] [Grow STX] onboard with REAL P-256 passkey 035bf426dc..., admin SP9BP4PN... | `(ok true)` | PASS |
| 8 | [1 SETUP] [Grow STX] is-admin-pubkey(passkey) | `(ok true)` | PASS |
| 9 | [1 SETUP] fund sim-earn-btc-safe 13200 STX from SP2ADT4T... | `(ok true)` | PASS |
| 10 | [1 SETUP] fund sim-grow-stx-safe 13200 STX from SP2ADT4T... | `(ok true)` | PASS |
| 11 | [1 SETUP] [Earn BTC] fund 400000 sats sBTC | `(ok true)` | PASS |
| 12 | [1 SETUP] [Grow STX] fund 400000 sats sBTC | `(ok true)` | PASS |
| 13 | [1 SETUP] OUTSIDE STX before | `(tuple (account (tuple (locked u0) (unlock-height u0) (unlocked u68805000))) (balance u688...` | PASS |
| 14 | [1 SETUP] OUTSIDE sBTC before | `u0` | PASS |
| 15 | [2 OVER-LIMIT] [Earn BTC] admin stx-transfer 6,000 STX (> 5,000 limit) -> queued, op u0 | `(ok true)` | PASS |
| 16 | [2 OVER-LIMIT] [Earn BTC] op u0 is a pending stx-transfer, admin-created | `(some (tuple (amount u6000000000) (execute-after u972042) (executed false) (extension none...` | PASS |
| 17 | [2 OVER-LIMIT] [Earn BTC] safe still holds all 13200 STX (nothing moved) | `(tuple (account (tuple (locked u0) (unlock-height u0) (unlocked u13200000000))) (balance u...` | PASS |
| 18 | [2 OVER-LIMIT] [Earn BTC] execute op u0 before cooldown -> err-cooldown-not-passed u4017 | `(err u4017)` | PASS (expected error) |
| 19 | [2 OVER-LIMIT] [Earn BTC] admin sBTC transfer 150,000 sats (> 100,000 limit) -> queued, op u1 | `(ok true)` | PASS |
| 20 | [2 OVER-LIMIT] [Earn BTC] op u1 is a pending sbtc-transfer | `(some (tuple (amount u150000) (execute-after u972042) (executed false) (extension none) (o...` | PASS |
| 21 | [2 OVER-LIMIT] [Earn BTC] safe still holds 400000 sats | `u400000` | PASS |
| 22 | [2 OVER-LIMIT] [Earn BTC] execute sBTC op u1 before cooldown -> u4017 | `(err u4017)` | PASS (expected error) |
| 23 | [2 OVER-LIMIT] [Earn BTC] admin queues stx op u2 | `(ok true)` | PASS |
| 24 | [2 OVER-LIMIT] [Earn BTC] stranger cannot veto -> u4001 | `(err u4001)` | PASS (expected error) |
| 25 | [2 OVER-LIMIT] [Earn BTC] ADMIN key vetoes op u2 | `(ok true)` | PASS |
| 26 | [2 OVER-LIMIT] [Earn BTC] admin queues sBTC op u3 | `(ok true)` | PASS |
| 27 | [2 OVER-LIMIT] [Earn BTC] PASSKEY vetoes op u3 (build-veto-operation-hash, sent by a stranger as relay) | `(ok true)` | PASS |
| 28 | [2 OVER-LIMIT] [Earn BTC] op u2 and u3 vetoed | `(tuple (a true) (b true))` | PASS |
| 29 | [2 OVER-LIMIT] [Grow STX] admin stx-transfer 6,000 STX (> 5,000 limit) -> queued, op u0 | `(ok true)` | PASS |
| 30 | [2 OVER-LIMIT] [Grow STX] op u0 is a pending stx-transfer, admin-created | `(some (tuple (amount u6000000000) (execute-after u972042) (executed false) (extension none...` | PASS |
| 31 | [2 OVER-LIMIT] [Grow STX] safe still holds all 13200 STX (nothing moved) | `(tuple (account (tuple (locked u0) (unlock-height u0) (unlocked u13200000000))) (balance u...` | PASS |
| 32 | [2 OVER-LIMIT] [Grow STX] execute op u0 before cooldown -> err-cooldown-not-passed u4017 | `(err u4017)` | PASS (expected error) |
| 33 | [2 OVER-LIMIT] [Grow STX] admin sBTC transfer 150,000 sats (> 100,000 limit) -> queued, op u1 | `(ok true)` | PASS |
| 34 | [2 OVER-LIMIT] [Grow STX] op u1 is a pending sbtc-transfer | `(some (tuple (amount u150000) (execute-after u972042) (executed false) (extension none) (o...` | PASS |
| 35 | [2 OVER-LIMIT] [Grow STX] safe still holds 400000 sats | `u400000` | PASS |
| 36 | [2 OVER-LIMIT] [Grow STX] execute sBTC op u1 before cooldown -> u4017 | `(err u4017)` | PASS (expected error) |
| 37 | [2 OVER-LIMIT] [Grow STX] admin queues stx op u2 | `(ok true)` | PASS |
| 38 | [2 OVER-LIMIT] [Grow STX] stranger cannot veto -> u4001 | `(err u4001)` | PASS (expected error) |
| 39 | [2 OVER-LIMIT] [Grow STX] ADMIN key vetoes op u2 | `(ok true)` | PASS |
| 40 | [2 OVER-LIMIT] [Grow STX] admin queues sBTC op u3 | `(ok true)` | PASS |
| 41 | [2 OVER-LIMIT] [Grow STX] PASSKEY vetoes op u3 (build-veto-operation-hash, sent by a stranger as relay) | `(ok true)` | PASS |
| 42 | [2 OVER-LIMIT] [Grow STX] op u2 and u3 vetoed | `(tuple (a true) (b true))` | PASS |
| 43 | [2 OVER-LIMIT] past the 144-block cooldown: +145 burn -> 972043 (cycle 145 offset 1493) | `ok` | PASS |
| 44 | [2 OVER-LIMIT] [Earn BTC] stranger cannot execute op u0 after cooldown -> u4001 | `(err u4001)` | PASS (expected error) |
| 45 | [2 OVER-LIMIT] [Earn BTC] admin executes op u0 after cooldown | `(ok true)` | PASS |
| 46 | [2 OVER-LIMIT] [Earn BTC] op u0 again -> err-already-executed u4014 | `(err u4014)` | PASS (expected error) |
| 47 | [2 OVER-LIMIT] [Earn BTC] admin executes sBTC op u1 after cooldown | `(ok true)` | PASS |
| 48 | [2 OVER-LIMIT] [Earn BTC] vetoed op u2 -> err-vetoed u4015 | `(err u4015)` | PASS (expected error) |
| 49 | [2 OVER-LIMIT] [Earn BTC] vetoed sBTC op u3 -> u4015 | `(err u4015)` | PASS (expected error) |
| 50 | [2 OVER-LIMIT] [Grow STX] stranger cannot execute op u0 after cooldown -> u4001 | `(err u4001)` | PASS (expected error) |
| 51 | [2 OVER-LIMIT] [Grow STX] admin executes op u0 after cooldown | `(ok true)` | PASS |
| 52 | [2 OVER-LIMIT] [Grow STX] op u0 again -> err-already-executed u4014 | `(err u4014)` | PASS (expected error) |
| 53 | [2 OVER-LIMIT] [Grow STX] admin executes sBTC op u1 after cooldown | `(ok true)` | PASS |
| 54 | [2 OVER-LIMIT] [Grow STX] vetoed op u2 -> err-vetoed u4015 | `(err u4015)` | PASS (expected error) |
| 55 | [2 OVER-LIMIT] [Grow STX] vetoed sBTC op u3 -> u4015 | `(err u4015)` | PASS (expected error) |
| 56 | [2 OVER-LIMIT] OUTSIDE STX after the two cooldown executes | `(tuple (account (tuple (locked u0) (unlock-height u0) (unlocked u12068805000))) (balance u...` | PASS |
| 57 | [2 OVER-LIMIT] OUTSIDE sBTC after the two cooldown executes | `u300000` | PASS |
| 58 | [2 OVER-LIMIT] [Earn BTC] admin queues stx op u4 | `(ok true)` | PASS |
| 59 | [2 OVER-LIMIT] [Earn BTC] JS execute-now hash == mm-safe-auth-helpers-v1 in the safe | `true` | PASS |
| 60 | [2 OVER-LIMIT] [Earn BTC] PASSKEY execute-pending-stx-transfer-now op u4 -> immediate | `(ok true)` | PASS |
| 61 | [2 OVER-LIMIT] [Earn BTC] admin queues sBTC op u5 | `(ok true)` | PASS |
| 62 | [2 OVER-LIMIT] [Earn BTC] PASSKEY execute-pending-sbtc-transfer-now op u5 -> immediate | `(ok true)` | PASS |
| 63 | [2 OVER-LIMIT] [Earn BTC] PASSKEY-signed 6,000 STX transfer -> queued op u6 (passkey-created) | `(ok true)` | PASS |
| 64 | [2 OVER-LIMIT] [Earn BTC] op u6 passkey-created true | `(some (tuple (amount u6000000000) (execute-after u972187) (executed false) (extension none...` | PASS |
| 65 | [2 OVER-LIMIT] [Earn BTC] passkey execute-now on a passkey-created op -> err-forbidden u4003 | `(err u4003)` | PASS (expected error) |
| 66 | [2 OVER-LIMIT] [Grow STX] admin queues stx op u4 | `(ok true)` | PASS |
| 67 | [2 OVER-LIMIT] [Grow STX] JS execute-now hash == mm-safe-auth-helpers-v1 in the safe | `true` | PASS |
| 68 | [2 OVER-LIMIT] [Grow STX] PASSKEY execute-pending-stx-transfer-now op u4 -> immediate | `(ok true)` | PASS |
| 69 | [2 OVER-LIMIT] [Grow STX] admin queues sBTC op u5 | `(ok true)` | PASS |
| 70 | [2 OVER-LIMIT] [Grow STX] PASSKEY execute-pending-sbtc-transfer-now op u5 -> immediate | `(ok true)` | PASS |
| 71 | [2 OVER-LIMIT] [Grow STX] PASSKEY-signed 6,000 STX transfer -> queued op u6 (passkey-created) | `(ok true)` | PASS |
| 72 | [2 OVER-LIMIT] [Grow STX] op u6 passkey-created true | `(some (tuple (amount u6000000000) (execute-after u972187) (executed false) (extension none...` | PASS |
| 73 | [2 OVER-LIMIT] [Grow STX] passkey execute-now on a passkey-created op -> err-forbidden u4003 | `(err u4003)` | PASS (expected error) |
| 74 | [2 OVER-LIMIT] OUTSIDE STX after execute-now | `(tuple (account (tuple (locked u0) (unlock-height u0) (unlocked u24068805000))) (balance u...` | PASS |
| 75 | [2 OVER-LIMIT] OUTSIDE sBTC after execute-now | `u600000` | PASS |
| 76 | [3 PASSKEY] [Earn BTC] JS stx-transfer hash == smart-wallet-standard-auth-helpers-v7 in the safe | `true` | PASS |
| 77 | [3 PASSKEY] [Earn BTC] OUTSIDE before passkey transfer | `(tuple (account (tuple (locked u0) (unlock-height u0) (unlocked u24068805000))) (balance u...` | PASS |
| 78 | [3 PASSKEY] [Earn BTC] PASSKEY stx-transfer 100 STX (within limit, relayed by a stranger) | `(ok true)` | PASS |
| 79 | [3 PASSKEY] [Earn BTC] OUTSIDE after passkey transfer | `(tuple (account (tuple (locked u0) (unlock-height u0) (unlocked u24168805000))) (balance u...` | PASS |
| 80 | [3 PASSKEY] [Earn BTC] REPLAY of the same sig-auth -> err-signature-replay u4006 | `(err u4006)` | PASS (expected error) |
| 81 | [3 PASSKEY] [Grow STX] JS stx-transfer hash == smart-wallet-standard-auth-helpers-v7 in the safe | `true` | PASS |
| 82 | [3 PASSKEY] [Grow STX] OUTSIDE before passkey transfer | `(tuple (account (tuple (locked u0) (unlock-height u0) (unlocked u24168805000))) (balance u...` | PASS |
| 83 | [3 PASSKEY] [Grow STX] PASSKEY stx-transfer 100 STX (within limit, relayed by a stranger) | `(ok true)` | PASS |
| 84 | [3 PASSKEY] [Grow STX] OUTSIDE after passkey transfer | `(tuple (account (tuple (locked u0) (unlock-height u0) (unlocked u24268805000))) (balance u...` | PASS |
| 85 | [3 PASSKEY] [Grow STX] REPLAY of the same sig-auth -> err-signature-replay u4006 | `(err u4006)` | PASS (expected error) |
| 86 | [3 PASSKEY] [Grow STX] Earn-safe signature submitted to the Grow safe -> err-invalid-signature u4002 (domain = safe) | `(err u4002)` | PASS (expected error) |
| 87 | [3 PASSKEY] [Earn BTC] PASSKEY stake-stx-juice 1,000 STX (juice-safe-auth-helpers-v2) | `(ok true)` | PASS |
| 88 | [3 PASSKEY] [Earn BTC] pox-5 position with juice-pool-stx-signer | `(some (tuple (amount-ustx u1000000000) (first-reward-cycle u146) (num-cycles u96) (signer ...` | PASS |
| 89 | [3 PASSKEY] [Earn BTC] PASSKEY unstake (juice-safe-auth-helpers-v1) | `(ok true)` | PASS |
| 90 | [3 PASSKEY] [Earn BTC] pox-5 position after unstake (unlocks next cycle) | `(some (tuple (amount-ustx u1000000000) (first-reward-cycle u146) (num-cycles u0) (signer S...` | PASS |
| 91 | [3 PASSKEY] [Grow STX] PASSKEY stake-stx-juice 1,000 STX (juice-safe-auth-helpers-v2) | `(ok true)` | PASS |
| 92 | [3 PASSKEY] [Grow STX] pox-5 position with juice-pool-sbtc-signer | `(some (tuple (amount-ustx u1000000000) (first-reward-cycle u146) (num-cycles u96) (signer ...` | PASS |
| 93 | [3 PASSKEY] [Grow STX] PASSKEY unstake (juice-safe-auth-helpers-v1) | `(ok true)` | PASS |
| 94 | [3 PASSKEY] [Grow STX] pox-5 position after unstake (unlocks next cycle) | `(some (tuple (amount-ustx u1000000000) (first-reward-cycle u146) (num-cycles u0) (signer S...` | PASS |
| 95 | [3 PASSKEY] [Grow STX] JS set-keeper hash == juice-autostake-safe-auth-helpers-v1 | `true` | PASS |
| 96 | [3 PASSKEY] [Grow STX] PASSKEY set-keeper -> OUTSIDE | `(ok true)` | PASS |
| 97 | [3 PASSKEY] [Grow STX] get-keeper | `SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM` | PASS |
| 98 | [3 PASSKEY] [Grow STX] same set-keeper sig replayed -> u4006 | `(err u4006)` | PASS (expected error) |
| 99 | [4 GAS] [Earn BTC] safe sBTC = 100000 | `u100000` | PASS |
| 100 | [4 GAS] gas sponsor sBTC before | `u62` | PASS |
| 101 | [4 GAS] [Earn BTC] PASSKEY send FULL 100000 sats WITH gas -> gas takes 20 first, transfer fails sbtc-token err u1 (KNOWN UX BUG) | `(err u1)` | PASS (expected error) |
| 102 | [4 GAS] [Earn BTC] safe sBTC unchanged (whole tx rolled back) | `u100000` | PASS |
| 103 | [4 GAS] [Earn BTC] PASSKEY send 99980 sats (balance - gas) WITH gas -> ok | `(ok true)` | PASS |
| 104 | [4 GAS] [Earn BTC] safe sBTC is 0 | `u0` | PASS |
| 105 | [4 GAS] gas sponsor sBTC after | `u82` | PASS |
| 106 | [4 GAS] [Grow STX] ADMIN sends 1,000 sats WITH the gas param -> ok, but gas is only charged on the passkey path | `(ok true)` | PASS |
| 107 | [4 GAS] gas sponsor sBTC after the admin send (unchanged) | `u82` | PASS |
| + | OUTSIDE got 2 x 6,000 STX after the cooldown (one per safe) | `12000000000` | PASS |
| + | OUTSIDE got 2 x 150,000 sats after the cooldown | `300000` | PASS |
| + | execute-now moved 2 x 6,000 STX immediately | `12000000000` | PASS |
| + | execute-now moved 2 x 150,000 sats immediately | `300000` | PASS |
| + | gas sponsor received exactly the gas fee once | `20` | PASS |
| + | admin path ignored the gas param (sponsor unchanged) | `82 -> 82` | PASS |
| + | [Earn BTC] passkey transfer landed 100 STX | `100000000` | PASS |
| + | [Grow STX] passkey transfer landed 100 STX | `100000000` | PASS |
