# Review: bounty mv7dfb43df5505479788 (10,000 sats, open until 2026-10-20)

Pre-deploy audit of the Juice sBTC pool, the autostake safe, the Jing
router/market/dispatch, and the three swap vaults. Pinned at juicestx `1e9a2fb`,
pillar-wallets `c910c1b`, jing-contracts-v3 `ada49d8`, fastpool-pox-5 `bfe3591`,
citycoins-protocol `8bb69aa`. Submissions are reviewed one at a time below.

## Award (proposed, bounty still open until 2026-10-20)

**Winner candidate: Patient Reed.** First submission (2026-10-13 20:33Z) and
the most impactful one: a free OG hop that let one actor hold the whole 2.1M
STX cap at 0% (Medium, fixed `d90dc1c`). Also two more valid findings: a
fresh small stake after the lock ended kept the old cover (Low-Medium, row
10), and the vaults kept no STX for a Pyth fee (`finish` reserve, Low).

Runners-up and tip candidates (all adopted):

- Giant Moth: passkey `set-keeper` past the token lock (`7758200`), keeper
  kept after an owner change (`611873c`), DLMM core-address check (router).
- Zealous Citadel: limit-blind DLMM pick, +8 to 9% output on a fork repro
  (router).
- Calm Forge: ccd016 elapsed window on funding (`8adfa68`).
- Super Orb: the vault pays both Lazer verifies (3 vaults).
- Void Cannon: Fast Pool `CYCLE_OFFSETS` (`3f82a93`) and fee on unswapped
  sBTC (signer).
- Rare Io: payout gas (I1 `e425a4c`, I2 `da7913d`).

Not awarded: Iron Hub (findings do not hold), Violet Reed (by design),
Frosty Narwhal (no finding holds).

| # | Submission | Who | Claim | Verdict | Status |
|---|---|---|---|---|---|
| 1 | Patient Reed | Patient Reed | OG seat without stake | Holds, Medium | Fixed `d90dc1c`: seat lasts while the staker stays, `evict-og` |
| 2 | Rare Io I1 | Rare Io | `pay-one` writes tranche totals per staker | Holds, gas | Adopted `e425a4c`: totals summed in the fold, written once per batch. Fork proof NEW vs `e8ad9b1` side by side 166/166 https://stxer.xyz/simulations/mainnet/3b073415ed6f7c5ff0814ceef0cdbb44, accounting 126/126 https://stxer.xyz/simulations/mainnet/fec1c71d4e374f8b7b74d23a072d5214 |
| 3 | Rare Io I2 | Rare Io | `pay-one` / `pay-recovered-sbtc-one` write earned-fees / earned-sbtc-fees per staker (sBTC even at fee 0) | Holds, gas | Adopted `da7913d`: fees summed in the fold, added once per batch. Fork proof NEW vs `e425a4c` side by side (STX + recovered-sBTC paths, fee changes between batches, partial fee withdraws) 299/299 https://stxer.xyz/simulations/mainnet/cdff423729665a87980eaf114b6d975c, pay-batches on `da7913d` 166/166 https://stxer.xyz/simulations/mainnet/0335b48163067ae8b747d8b31413d047, accounting 126/126 https://stxer.xyz/simulations/mainnet/778153ea61fa87e69521b47790345e61, recovery-continuity 190/190 https://stxer.xyz/simulations/mainnet/b5aa91981c64577233e8a57446924eed |
| 4 | Void Cannon F3 | Void Cannon | `assert-idle-vault` ignores `empty`, escrow, `ready-to-finish`, STX balance | Does not hold | Rejected: `confirm-swap-vault` also requires no `pending-swap` |
| 6 | Super Orb | Super Orb | The first Lazer verify (`current-mid` -> market `refresh-mid`) ran before `as-contract?`, so the caller paid that Pyth fee | Holds, Low | Fixed (uncommitted): every entry that takes an update reads its mid through `vault-mid` (`current-mid` in its own `as-contract?` scope with `with-stx pyth-fee-budget`); the vault pays both verifies. Budget >= 2 x fee. pyth-fee 58/58 https://stxer.xyz/simulations/mainnet/cc401ad86130ceda10aa9da4670a1c4c |
| 7 | Iron Hub F1 | Iron Hub | `router-swap` passes the floor as `mid` to the router, so the book leg is sized at the floor | Does not hold | Rejected: `mid` is the verified oracle mid, the floor goes in as the limit |
| 8 | Iron Hub F2 | Iron Hub | `finish` is permissionless: dust theft by donation | Does not hold | Rejected: `finish` is POOL-only |
| 9 | Violet Reed | Violet Reed | `router-swap-split` reverts u3002 when a bid sits in `[limit, book-limit)`: the manual book leg pays net, the vault signs a gross min-out | By design | No change: fail-safe, operator path; the keeper sizes the book slice at `book-limit` |
| 10 | Patient Reed recheck | Patient Reed | Recheck of `d90dc1c`: after the lock ends, a fresh small stake before `evict-og` keeps the old cover | Holds, Medium | Fixed (uncommitted): a stake below the cover shrinks it to the stake (`og-shrink`). og-shrink 52/52 https://stxer.xyz/simulations/mainnet/06341a94a7acbdfe0b4f5cb3d87b7669 |
| 11 | Zealous Citadel Info | Zealous Citadel | `propose-fee-bips` never expires | Holds, Info | Accepted, no change: the 5% cap is the guarantee |
| 13 | Frosty Narwhal | Frosty Narwhal | 19 claims over 5 repos (C-1, H-1 to H-3, M-1 to M-8, L-1 to L-7) | None holds | No change: duplicates of apeir I-2/I-3, by design, or not true in the code (section 13) |

## 1. Patient Reed: OG seat without stake

**Holds, Medium.** `validate-stake!` gave the seat at stake time from the
amount pox-5 passes, and the cover never shrank. pox-5 `stake-update` can
move a stake to another signer with no new STX and no extension. So a staker
already locked at another signer could move into the pool, take the seat, and
move back out in the same cycle. The STX never left their lock and kept
earning at the other signer; the cost was two transaction fees.

One actor could take the whole 2.1M STX cap this way and keep it, and refill
any room `raise-og-cap` opened. Real first stakers would then pay 4.5%. No
funds are at risk; it is a free grief of the offer, or a free 0% seat held for
a later return. It also breaks the design note in
[README-apeir-audit.md](README-apeir-audit.md), which said this costs at
least one cycle of locked STX.

**Fix: a seat lasts while the staker stays.** We did not take the proposed
fix (grant cover only from shares in the running cycle), because a new staker
would then need a second call a cycle later to get their seat. Instead:

- Seats are still taken at stake time, exactly as before.
- `og-staying(staker)` (read-only): true while pox-5 `get-staker-info` names
  this pool as the staker's signer. False once they move to another signer
  (pox-5 names the new one at once) or their lock has ended (pox-5 returns
  none). An unstaker stays in until the lock ends.
- `evict-og(staker)` (permissionless): when `og-staying` is false, deletes the
  seat and returns its cover to the cap. `ERR_OG_NOT_SEATED (u128)` if there
  is no seat, `ERR_OG_STILL_STAKED (u129)` if the staker is still in.
- An evicted staker can take a seat again by staking while the cap has room.

The hop still takes the seat for a moment, but anyone (our keeper runs it) can
evict it as soon as the staker leaves, so the cap cannot be held for free.
Seats now rotate: leave, and your seat opens for someone else.

Trade-off: "cover never shrinks" is gone. An OG who unstakes keeps 0% through
their last locked cycle; eviction is possible only after the lock ends. Payout
reads the cover when it runs, so evict after that cycle's payout, or the last
tranche pays the standard fee.

Accepted by design: a bond roll-over. If an OG rolls their STX stake into a
bond at another signer, pox-5 `register-for-bond` deletes their `staker-info`
(pox-5 L830-831), so `og-staying` is false at once and the seat can be
evicted. Their old STX shares still earn with this pool until the original
term ends, and those last cycles pay the standard fee. We charge the exit.
A lock can never shrink while the staker stays: `stake-update` only adds
(pox-5 L1126), and `unstake` keeps the amount until the lock ends.

Tests: 6 cases in tests/juice-pool-og.test.ts ("og-staying / evict-og").
They cover the bounty hop (in and out in one cycle, then evict), still staked
(u129), no seat (u128), unstake (staying until the lock ends, then evict),
re-seat after eviction, and eviction by a non-admin. The vault build mock
(tests/vault/build.py) adds a pox-5 style get-staker-info to mock-pox.
Result: npm test 125/125 pass (5 files).
stxer mainnet fork (real pox-5, exact pool source; real stakers hop in from fastpool and xverse-3, unstake, prepare phase, re-seat): simulations/pool-og-evict-stxer.mjs 69/69 https://stxer.xyz/simulations/mainnet/b04f2ff1e6049a80e8905e72abeaf96d; reruns og-seats 49/49 https://stxer.xyz/simulations/mainnet/1b41a8ff94bae0b303fc9f2fe91e079c, og-cap 47/47 https://stxer.xyz/simulations/mainnet/dc6a007eabe3b1a2b960f1248d04a898, accounting 126/126 https://stxer.xyz/simulations/mainnet/757a16db8f7f786b38ea0bcc2787c6c3, autostake-e2e 63/63 https://stxer.xyz/simulations/mainnet/8b4b717193658142e01775293061a496.

## 4. Void Cannon finding 3: `assert-idle-vault` misses vault states

**Does not hold. Rejected, no change.** The claim: `assert-idle-vault`
(pool L143) checks only `batch-start`, `jing-resting` and `jing-parked`, so a
vault switch could leave escrowed sBTC, a batch waiting to finish, or swap STX
behind.

`confirm-swap-vault` also asserts `(is-none (var-get pending-swap))`
(pool L205). The pool sets `pending-swap` when it funds the vault and clears
it only when the batch ends: `finalize-swap` (pool L967, calls the vault's
`finish`, all STX back) or `emergency-recover` (pool L1107, everything
back). So while any of these states exist, the
switch is refused:

- escrow on the market (pending deposit): the batch is open.
- `ready-to-finish`: the vault sold out but the pool has not called `finalize-swap`.
- STX in the vault: proceeds of an unfinished batch.

What `assert-idle-vault` adds on top is the market check (nothing resting or
parked), for the new vault too. A plain sBTC donation to an idle vault is not
pool money and does not block a switch.

## 6. Bounty mv7dfb: Super Orb, vault pays both Pyth verifies

**Holds, Low.** Every vault entry that takes a Lazer `update` first called
`current-mid`. It calls the market `refresh-mid`, which runs the oracle
verify. The oracle charges its fee with `(stx-transfer? fee tx-sender
recipient)`. That call ran before the vault's `as-contract?`, so tx-sender
was the caller and the caller paid. Only the second verify (inside the market
swap) was paid by the vault. jing-place and jing-refloor had no `with-stx` at
all. The live fee is u0, so nothing was lost. Decision: the vault pays every
Pyth fee, never the caller.

**Fix** (`juice-sbtc-autoswap.clar`):

- New private `vault-mid` runs `current-mid` in its own `as-contract?` scope
  with `(with-stx (var-get pyth-fee-budget))`, so tx-sender is the vault for
  the refresh-mid verify.
- jing-place, jing-take, router-swap, router-swap-split and jing-refloor call
  `vault-mid` where they called `current-mid`. That is the whole change to
  them: the mid stays in the outer `let`, then the original swap or deposit
  `as-contract?` runs as before (jing-take and the router entries keep their
  own `with-stx` for the market's verify).
- Floor and limit math, the DIA band check and the check order are as at HEAD
  (the mid is read first, as before).
- Error codes: unchanged except over budget. A budget below the fee now fails
  in `vault-mid` with `(err u0)` (its only allowance, `with-stx`) in every
  entry. At HEAD the market verify failed the swap scope's `with-stx` with
  `(err u1)`, and jing-place and jing-refloor had no allowance.
- Each scope's allowance caps one verify, so the budget is per verify, not
  per call: budget = fee passes a 2-verify entry.

**Budget.** router-swap, router-swap-split and jing-take verify twice
(refresh-mid, then the market swap). Each scope needs only 1 x fee of
allowance, but `finish` keeps the budget back as the STX both verifies spend:
set `pyth-fee-budget` to at least 2 x fee. jing-place and jing-refloor verify once. The 10 STX cap still fits: it
allows a fee up to 5 STX per verify. With a fee above 0 the vault also needs
STX on hand before jing-place. `finish` keeps that STX back (section 12).

**Tests.** npm test 134/134. Five Pyth fee cases: budget 0 and fee - 1
abort with `(err u0)`, budget = fee passes. A caller with 0 STX runs
router-swap and jing-place. The vault pays 2 fees (1 for jing-place and
refloor) and the caller sends no STX. These cases fail on the old source.
tests/vault/runtime.mjs passes.

stxer mainnet fork, exact repo source:

- pool-vault-pyth-fee 58/58 https://stxer.xyz/simulations/mainnet/cc401ad86130ceda10aa9da4670a1c4c
  (fee u10, a 0-STX caller; budget 0 and u9 abort with (err u0); the vault
  pays exactly 2 x u10, the caller sends nothing)
- pool-vault-fixes 218/218 https://stxer.xyz/simulations/mainnet/94692d1d1429e9c1f935d550b2ee41f0
- pool-vault-recovery 190/190 https://stxer.xyz/simulations/mainnet/f37298d51e3749f0138ca92e30f2567b
- pool-vault-upgrade 97/97 https://stxer.xyz/simulations/mainnet/6537e143660d39a230e53e3f631d1cb3
- pool-accounting 126/126 https://stxer.xyz/simulations/mainnet/eb9a4c99ed698a1e3e2388a30ee2c1c9

The same fix is in fastpool-swap-vault and ccd016-swap-vault-mia-v2.

## 7. Iron Hub finding 1: floor passed as `mid`

**Does not hold. Rejected, no change.** The claim: `router-swap` calls the
router with the floor in the `mid` slot, so the book leg is sized at the floor.

Code at `1e9a2fb` (the HEAD committed source is the same), `juice-sbtc-autoswap.clar`:

- L414: `mid` is `current-mid update`. `current-mid` (L702-720) is the market's
  verified `refresh-mid`, asserted above 0 (L707) and DIA-banded.
- L415: `limit` is `floor-of mid`.
- L443-444: `smart-swap-sbtc-for-stx amount limit (some update) mid u0`.

The router signature (jing-contracts-v3 `c14f038`, router v5-3 L1407) is
`amount, limit-price, update, mid, min-stx-out`. So the oracle mid goes in as
`mid` and the floor goes in as `limit-price`. The report reads them the other
way round. The zero-mid case it raises is also refused (L707).

The report text is cut at 2,000 characters by the bounty API and has no
content URL. Nothing after the start of finding 2 can be read.

## 8. Iron Hub finding 2: `finish` dust theft

**Does not hold. Rejected, no change.** The claim: `finish` is permissionless,
so anyone can trigger it and take dust.

`finish` (L253) starts with `(asserts! (is-eq contract-caller POOL)
ERR_UNAUTHORIZED)` (L255). It sends the STX only to POOL (L262), and the pool
checks the exact delta (pool `finalize-swap`, L935-939 at `1e9a2fb`). No other caller gets past L255. A
donation only adds to what POOL receives.

## 9. Violet Reed: `router-swap-split` and a bid in the net band

**By design. No change.** The claim: `router-swap-split` (L471) signs a gross
min-out, `floor-out(jing + dlmm + xyk, limit) + floor-out(velar,
velar-limit)` (L508). The router's manual book leg (router v5-3 `swap-sbtc-for-stx`
L466) fills at the maker's price but pays net of the rebate and the 10 bps
fee. A best bid in `[limit, book-limit(limit))` fills the book slice under the
gross floor, and router L524 aborts the whole split with u3002.

The trace is right. It is not a bug:

- The direction is safe. The vault never sells under its floor. The tx rolls
  back and nothing moves.
- `router-swap-split` is POOL-only (L490). The operator picks the `jing`
  slice. If it sizes that slice with the market's `get-taker-capacity` at
  `book-limit` (the read the smart path does, router L822-890), the walk takes
  the best bids first and stops above `book-limit`. A new bid in the band sits
  below them and is not reached.
- e5c58c4 changed the smart paths only, on purpose ("Manual paths
  unchanged"). A direct caller signs their own min-out and gets exactly what
  they signed.
- The permissionless `router-swap` (smart) already skips a band bid and lets
  DLMM fill (the submitter's own test 5).

The grief (cancel a bid above `book-limit` between sizing and broadcast) is
the same for any split with a book leg: a fill-or-kill leg against a moving
book. It costs the griefer a place and a cancel, and the vault keeps its sBTC.
The proposed fix lowers the vault's floor on the book slice by up to 80 bps,
which we do not want.

The same holds for `fastpool-swap-vault` and `ccd016-swap-vault-mia-v2`.

## 10. Patient Reed recheck: fresh small stake keeps the old cover

**Holds, Medium.** A recheck of the `d90dc1c` fix. An OG with a 1M cover
unstakes. The lock ends and `og-staying` is false. Before anyone calls
`evict-og`, the OG stakes 1 STX fresh with the pool. `og-staying` is true
again, so `evict-og` returns u129. The cover only grew, never shrank, so the
1 STX staker kept the whole 1M cover at 0%, and that room stayed out of the
cap.

**Fix** (`take-og-seat`, uncommitted): when the new stake `amount` is below
the current cover `prev`, the cover becomes `amount`, `og-covered-ustx` drops
by `prev - amount`, the pool prints `og-shrink` (covered, freed), and the
call returns `(ok amount)`. The seat stays (`og-seats` unchanged), because the
staker is staying. Otherwise the grow path is unchanged.

When it triggers: pox-5 passes the whole new position to `validate-stake!`.
While the staker stays, the lock never shrinks (`stake-update` only adds), so
the amount is never below the cover. A smaller amount comes only from a fresh
`stake` after the lock ended, or a hop back in with less. A 0 amount cannot
reach the pool: the node refuses a 0 lock (`PoxInvalidLockAmount`, seen on the
fork) and the tx is not mined. The contract alone would keep a 0-cover seat
(u128 on evict, seat counted twice on the next stake); the unit test pins
this edge.

**Tests.** tests/juice-pool-og.test.ts: "smaller update never shrinks" now
expects the shrink; new block "og-shrink" (6 cases): the attack (whole cap,
lock ends, 1 STX fresh, cover 1 STX, u129, another staker takes the freed
room), equal stake unchanged, top-up still grows, shrink then top-up grows
again clamped to the cap, evict after a shrink frees only the shrunk cover,
the 0 edge. npm test 134/134 (5 files; OG file 36).

stxer mainnet fork, real pox-5, exact pool source
(simulations/pool-og-shrink-stxer.mjs): a real 200k STX fastpool staker hops
in (200k seat), unstakes, the lock ends, stakes 1 STX fresh. u129, cover 1 STX,
199,999 STX back to the cap, `og-shrink` print checked. Then a same-total
`stake-update` leaves the cover, a +5 STX top-up grows it, and a 0 STX stake is
refused by the node. 52/52
https://stxer.xyz/simulations/mainnet/06341a94a7acbdfe0b4f5cb3d87b7669.
Reruns: og-seats 49/49 https://stxer.xyz/simulations/mainnet/95fb33a637337e7156fd306a1d7a34e9,
og-cap 47/47 https://stxer.xyz/simulations/mainnet/c4e8ed43af3bdc069608211d4b4b4b2a,
og-evict 69/69 https://stxer.xyz/simulations/mainnet/e7defd67b02bfb44b6f79d57c4e94965,
accounting 126/126 https://stxer.xyz/simulations/mainnet/f5b092caeff9f2f2f80ea9db465754de,
autostake-e2e 63/63 https://stxer.xyz/simulations/mainnet/2f2e8c416e5b2eed6b098487d07a7be5,
pay-batches 166/166 https://stxer.xyz/simulations/mainnet/64b5eff4d143e08ff25d4727c0efbdb3,
pay-fees 299/299 https://stxer.xyz/simulations/mainnet/f6b3b93f2d5f6f92c98ebde9bdaba26f.

## 11. Zealous Citadel Info: a fee proposal never expires

**Holds. Accepted, no change.** `confirm-fee-bips` can confirm a
`propose-fee-bips` from any time in the past, as long as `FEE_COOLDOWN`
(144 burn blocks) has passed. We keep it:

- Both calls are admin-only.
- `MAX_FEE_BIPS` (5%) is a constant. At launch the fee is 4.5%, so the most a
  stale proposal can add is 0.5 points.
- The pending fee is public on chain (`get-pending-fee`) for as long as it
  waits, and the admin can drop it with `cancel-fee-bips`.

An expiry would add code for no real gain: the cap is the guarantee.

## 12. Patient Reed F2: finish keeps the Pyth fee reserve

**Holds, Low. Accepted.** `finish` sent the vault's whole STX balance to the
pool. Every batch then started with 0 STX, so the `with-stx pyth-fee-budget`
allowance had nothing behind it. With a Pyth fee above 0, every entry that
verifies would abort. The live fee is u0, so nothing failed yet.

**Fix** (`juice-sbtc-autoswap.clar`, `finish`), as ccd016 `fuel-fair-book`:

- `finish` keeps back min(balance, `pyth-fee-budget`) uSTX. It sends only the
  rest to the pool and returns the amount sent.
- The pool's `finalize-swap` check (after - before = amount) still holds: it
  sees the sent amount.
- When balance <= budget, the amount is 0. The 0 transfer is skipped, as before.
- The print adds `reserve` (STX kept).
- Budget is u0 by default, so nothing changes until the admin sets it.

**Where the reserve comes from.** The first finish after the budget is set
keeps it from that batch's STX (stakers' proceeds, at most 10 STX, once).
Later batches refill it from their own proceeds, so each batch pays its own
fees. Set the budget while the fee is still u0. If the fee goes live while the
vault holds 0 STX, the first verify of that batch fails. Then anyone sends STX
to the vault (a plain `stx-transfer?`; the vault accepts it). No new funding
path is needed. STX above the budget goes to the pool with the next finish,
into that batch's pot.

**Recovery and upgrade.**

- `emergency-recover` is unchanged: it sends all STX, reserve included. It is
  the exit path. It needs an open batch (`batch-start`).
- `is-empty` and `assert-idle-vault` look at sBTC and Jing positions only, so
  the reserve never blocks a close or a vault switch.
- After a switch the old vault can keep up to the budget (10 STX cap). The
  pool refuses calls to an inactive vault, so nobody can recover it. To avoid
  this, set the budget to u0 before the last batch on the old vault finishes:
  that finish then sends all STX.

**Tests.** npm test 134/134. Two new cases: budget u100, fee u10: after
finalize the vault keeps u100, the pool gets balance - u100; batch 2 has no
float, a 0-STX caller sells, the reserve pays both verifies, finalize sends
out - fee and the reserve refills. Balance u50 <= budget u100: finish returns
u0 with no transfer; budget u0 then sends the u50.

stxer mainnet fork, exact repo source:

- pool-vault-pyth-fee 58/58 https://stxer.xyz/simulations/mainnet/cc401ad86130ceda10aa9da4670a1c4c
  (two batches at fee u10; batch 2 starts with the u100 reserve only, the vault
  pays 2 x u10 from it, finalize = out - u10, the vault keeps u100 again)
- pool-vault-fixes 218/218 https://stxer.xyz/simulations/mainnet/94692d1d1429e9c1f935d550b2ee41f0
- pool-vault-recovery 190/190 https://stxer.xyz/simulations/mainnet/f37298d51e3749f0138ca92e30f2567b
- pool-vault-upgrade 97/97 https://stxer.xyz/simulations/mainnet/6537e143660d39a230e53e3f631d1cb3
- pool-accounting 126/126 https://stxer.xyz/simulations/mainnet/eb9a4c99ed698a1e3e2388a30ee2c1c9

The same fix is in fastpool-swap-vault.

## 13. Frosty Narwhal: 19 claims, none holds

**No change.** Submission 2026-10-14 19:20Z (gist by Iskander-Agent), pinned
at the bounty commits. Checked against the final code: juicestx `570226c`.
Every verdict below is the same at the pinned `1e9a2fb`. Items for the other
repos are answered in their own READMEs (pillar
`README-juice-autostake-safe-review.md`, jing-contracts-v3
`contracts/README-bounty-mv7dfb.md`, fastpool `docs/deploy-stx-rewards.md`
11.4, ccd016 `README-ccd016-swap-vault-v2.md`).

**C-1, `emergency-recover` books the vault's numbers without a balance
diff: duplicate of apeir I-3, accepted by design.** Pool L1130-1153 books
`(get stx recovered)` and `(get sbtc recovered)` as reported;
`finalize-swap` (L991-1004) checks the diff. The report's code is not the
pool's: it shows `(var-set stx-pot cycle (+ ...))`, the pool does
`map-set stx-pot batch` (L1137). Our vault returns exactly what it sends
(autoswap `emergency-recover`, L292-365). A lying vault needs the admin key and a public
notice: `propose-swap-vault` (L158), then 4,032 burn blocks
(`SWAP_VAULT_COOLDOWN`, L22, about a month), then `confirm-swap-vault`
(L190) with no pending swap and both vaults idle. Such a vault also holds
the whole funded tranche, so the trust is already total. The diff would
only cap the extra harm to other tranches' STX, and it adds a way for the
exit path to fail.

**H-1, `close-batch` is permissionless: does not hold.** It is open on
purpose (L222, "Anyone may close"). It needs `is-empty` (L828): at most
`DUST_SATS` (2) sats in the vault and nothing on the market. The
`reclaim-core` in it (L242-246) runs only when wallet + market is at most 2
sats. Then the batch is sold. The STX proceeds stay in the vault, and
`finish` sends them to the pool (L261-290); nothing is zeroed. A reclaim
mid-window puts the sBTC back in the vault, so `is-empty` is false and the
close is refused (`ERR_SOME_FUNDS`). Every sale already ends with
`close-if-empty` (L818), which does the same.

**H-2, `finish` uses `(and ...)` for the transfer: does not hold.** L274-280:
`(and (> amount u0) (try! ...))`. When `amount` is 0 nothing is owed and
`finish` returns 0. When it is above 0 the transfer runs, and `try!` aborts
the call if it fails. The pool checks `after - before = amount` (L1001).
`juice-pool-swap-vault.clar`, named in the report, is not in the repo.

**H-3, the native fallback floor is mid / 2: by design.** L603-630. The
DIA branch uses `no-pyth-slippage-bps`. The fallback (DIA errored) uses the
RFQ `get-native-price`: the miners' implied STX price, a day average of
tenure spend. It is a coarse second source, not a market price, so the
floor is its lower band edge, `native / 2`, as the core-spread rungs use
it (commit `0f5bdc0`, "the deployed RFQ's native lower band edge"). A 10%
band on it would stop the emergency sale whenever the miner price lags the
market. It is reached only by `router-swap-split-dia` (L549), which is
POOL-only (L556), and only when DIA errors.

**M-4, `router-swap-split` allowance lacks the rebate dust: does not hold**
(claimed for fastpool and ccd016, the same here). The split calls the
manual router path with `fallback none` (L520). Router v5-3 `with-fallback`
(L396-406) adds the Jing residual only to the fallback venue, so with
`none` nothing is re-sold. The vault sends at most `jing + dlmm + xyk +
velar = amount`; the refunded rest and rebate dust stay in the vault.
`amount + min-x` (L516) already covers that. `router-swap` passes a
fallback through the smart path, which is why it has the larger
allowance (`024d2b1`).

**M-5, DIA timestamp in the future passes: duplicate of apeir I-2,
accepted.**

**M-6, `is-empty` uses `is-none` on the pending deposit, `market-total`
uses the amount: does not hold.** A pending entry is never left at 0. The
market writes it only with the deposited `amount` (market v6-3 L1590), the
sBTC transfer before it refuses 0, and the entry is deleted, not reduced,
on settle (L1628), cancel (L1781) and refund. A pending deposit is not
filled, so no partial fill touches it.

**L-5, `jing-reclaim` is permissionless after the window: by design.**
L389-394. When the patience window has elapsed, the resting order has had
its chance. Anyone may bring the sBTC home so the permissionless
`router-swap` can sell it. This keeps the sale from depending on our
keeper.

**L-6, `dia-band-bps` u0 turns off the DIA check: by design** (apeir I-2:
it is the off switch). The mid is then the Pyth Lazer mid from the market's
`refresh-mid`, not a raw book price (L723-742).
