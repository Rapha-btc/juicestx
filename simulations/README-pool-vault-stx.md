# Juice pool / swap-vault verification

> Latest (2026-09-30): [rerun on the exact-rebate market, forked at the tip](#rerun-on-the-exact-rebate-market-forked-at-the-tip-2026-09-30), with the vault and pool deployed as `-v1`.
>
> 2026-09-23 v6-3 recovery and regression results: [cancel-only recovery verification](README-v6-3-recovery.md). The notes below describe the earlier verification; linked JSON artifacts now contain the current reruns.

Current-source validation on **2026-09-18**: **570/570 Stxer checks passed** across 11 mainnet forks for the three contracts pushed in `fc58b61`. Each fork deploys the exact trait, vault and pool source before testing. No production transactions are sent.

The rotation fork has **89 passing checks**: admin/pool binding, cancellation and reset, 4,031-block rejection and 4,032-block activation, pending-tranche protection, old/new batch clocks and resting/parked positions, tiny donations accepted on both idle vaults, every stale wrapper rejected, and a real post-switch PoX claim, AMM swap, finalization and payout. Candidate vault copies exist only in the fork.

The local migration suite passes **97 checks**. Current local vault coverage reaches **129/129 branch outcomes** and **292/294 line counters**. The two zero-hit literal/binding counters execute semantically. The earlier Rendezvous runs (2,000 checks, zero exceptions, 60 completed batches) refer to pre-rotation hashes; they have not been rerun for vault rotation.

## Current Stxer runs

| Scenario | Passed | Stxer | Raw report |
| --- | --- | --- | --- |
| Vault rotation and post-switch rewards | 89/89 | [simulation](https://stxer.xyz/simulations/mainnet/dbd028618b2a89291b43a66069b62d23) | [juice-vault-upgrade.json](results/pool-vault-stx/juice-vault-upgrade.json) |
| Deployment and guards | 15/15 | [simulation](https://stxer.xyz/simulations/mainnet/2274b02948e1381360d12f2a0b6d53b6) | [juice-deployment-guards.json](results/pool-vault-stx/juice-deployment-guards.json) |
| Maker fill during patience | 31/31 | [simulation](https://stxer.xyz/simulations/mainnet/a773f4a7d6d7dff8554b476832dbb9bc) | [juice-maker.json](results/pool-vault-stx/juice-maker.json) |
| Smart-router AMM liquidation | 35/35 | [simulation](https://stxer.xyz/simulations/mainnet/d3b40e8a7c10664eb3d6e0e4e10f7ac9) | [juice-liquidation.json](results/pool-vault-stx/juice-liquidation.json) |
| Smart-router Jing fills | 40/40 | [simulation](https://stxer.xyz/simulations/mainnet/0a2efbe80b3936672dce8c6be4e042a8) | [juice-jing-router.json](results/pool-vault-stx/juice-jing-router.json) |
| Admin direct Jing take | 35/35 | [simulation](https://stxer.xyz/simulations/mainnet/caa0a8749794c515cee4b16372eb58fd) | [juice-jing-take.json](results/pool-vault-stx/juice-jing-take.json) |
| Required-Pyth manual split | 36/36 | [simulation](https://stxer.xyz/simulations/mainnet/acd282c4b730fa9ee454824bcdb5772f) | [juice-split-pyth.json](results/pool-vault-stx/juice-split-pyth.json) |
| Four-batch recovery continuity | 186/186 | [simulation](https://stxer.xyz/simulations/mainnet/b9107092fc2f1c74bac94a5dae9b9306) | [juice-recovery-continuity.json](results/pool-vault-stx/juice-recovery-continuity.json) |
| Timed admin handover | 53/53 | [simulation](https://stxer.xyz/simulations/mainnet/423cbe080c8335e611ee87f2809f5df4) | [juice-admin-handover.json](results/pool-vault-stx/juice-admin-handover.json) |
| Emergency DIA swap | 20/20 | [simulation](https://stxer.xyz/simulations/mainnet/b14d5ed91cf95e2e0995f460dbd775e5) | [juice-emergency-dia.json](results/pool-vault-stx/juice-emergency-dia.json) |
| Emergency native fallback | 30/30 | [simulation](https://stxer.xyz/simulations/mainnet/02d37affb122566fff0de32e0cb628c5) | [juice-emergency-native.json](results/pool-vault-stx/juice-emergency-native.json) |

Current SHA-256 source fingerprints:

- `juice-pool-swap-vault`: `be613079fbb7d40cfa205f287e2b9b653badef24724497e66a3e85bc7bf74a2f`
- `juice-swap-vault-trait`: `c0f471b1cd5876bcb12afcd689cdb82109f63163aee879d58e5ff691325cbbed`
- `juice-pool-stx-signer-stx-rewards`: `bdff5e99574f132b5b2e207144da46f273793f8576c6cdbb1652cdb2fba6471a`

Pre-rotation reports (471 checks) are preserved in [pre-rotation](results/pool-vault-stx/pre-rotation/). Older runs remain in [history](results/pool-vault-stx/history/).

## Run the fork cases

```sh
npm ci
node simulations/pool-vault-upgrade-stxer.mjs
node simulations/pool-vault-stx-stxer.mjs
node simulations/pool-vault-stx-stxer.mjs --maker
node simulations/pool-vault-stx-stxer.mjs --lifecycle
node simulations/pool-vault-stx-stxer.mjs --jing-router
node simulations/pool-vault-stx-stxer.mjs --jing-take
node simulations/pool-vault-stx-stxer.mjs --split-pyth
node simulations/pool-vault-recovery-stxer.mjs
node simulations/pool-admin-handover-stxer.mjs
node simulations/pool-vault-emergency-stxer.cjs
node simulations/pool-vault-emergency-stxer.cjs --native
```

`STACKS_API_URL` and `STXER_API_URL` override the node and fork service.
Signed-update cases use the local `_pool-vault-lazer.mjs` helper; `PYTH_API_KEY`
is optional. Emergency cases never fetch or supply a Pyth update. The common
and emergency runners capture source hashes at deployment. Older runner reports
also carry explicitly labeled offline current-source hash verification.

## Fork fixtures and scope

Lifecycle/recovery cases use the real PoX-5 claim path, token ledger, Jing market,
router, and AMMs. Crystallized earned rewards and 1:3 staker shares are explicit
fork-only Eval fixtures backed by real fork sBTC transfers. Existing live Jing
orders are canceled only inside the fork to isolate fills. These cases test
claims, swaps, recovery, attribution, payouts and replay; they do not test new
STX lock admission, signer registration, or newly accrued mining rewards.
Fees are zero in the fork lifecycle cases; local tests exercise 5% fees/OG exemptions.

Maker fills complete inside the patience window. Router cases advance 288+1
Bitcoin blocks with compressed one-second timestamps, keeping the production
signed-feed freshness checks enabled. Recovery fixtures age clocks to test the
4,319/4,320-block boundary without waiting a month. A four-batch sequence tests
resting recovery, mixed STX/sBTC recovery, normal liquidation and another recovery.
Replays, outstanding payout reserves and next-batch isolation are checked.

Emergency cases explicitly transfer 100,000 sats from a real whale to the draft
pool inside the fork. A pool Eval funds the vault through `as-contract?` with an
FT allowance; this isolates the swap path rather than testing PoX accounting.
Native-error tests mutate DIA timestamps/values and RFQ coinbase only in the fork.
The last negative swap disables cooldown through the admin wrapper to isolate
unusable-price rejection. Native runs do not synthesize blocks: a longer exploratory
case hit Stxer's `BlockingError` when native pricing read synthetic tenure data.
The successful parent-chain cases above replace that incomplete run.

## Emergency price and output examples

`router-swap-split-dia(amount, dlmm, xyk, velar, active-vault)` has no Jing or update arguments.
It forwards Jing `u0` and update `none`. The restored `router-swap-split` requires
a Pyth buffer, and retains its normal 1% floor and separate 0.6% Velar floor.

The archived pre-rotation emergency DIA run returned:

- STX/USD `(ok {value: u28252561, timestamp: u1789764657889})`: $0.28252561/STX.
- BTC/USD `(ok {value: u8110528212401, timestamp: u1789764657889})`: $81,105.28212401/BTC.
- `get-dia-value` returns only `(ok value)` after positive-value/freshness checks.
- `floor(BTC-USD * 100000000 / STX-USD) = u28707231929880`, or
  **287,072.31929880 STX/BTC**. The identical USD scales cancel.

The feed timestamp truncates to `1789764657` seconds. Previous Stacks block time
was `1789765458`: **801 seconds old**. Its expiry is
`1789764657 + 7200 = 1789771857 >= 1789765458`, so the freshness guard passes.
Local runtime tests verify age exactly 7,200 seconds passes and 7,201 seconds fails.

| Emergency case | Allocation, sats | Minimum total STX | Received STX | Unsold sats |
| --- | --- | --- | --- | --- |
| Valid DIA, default 10% tolerance | DLMM 10,000 | 25.836508 | 28.707443 | 0 |
| Stale DIA, native fallback | DLMM 4,000 / XYK 3,000 / Velar 3,000 | 15.204315 | 28.645061 | 0 |

DIA errors use a direct call to
`SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3 get-native-price`.
It returned `(ok u30408631185875)`, or **304,086.31185875 STX/BTC**.
`limit = floor(native/2) = u15204315592937`, the lower edge of the 0.5x–2x
band. For this sBTC sale, there is no upper cap on favorable STX output.
The configurable DIA tolerance is default 10%, bounded at 50%, and applies to
all emergency AMMs. It is not applied again to the native half-price floor.

Prints report the reference `mid`, enforced `limit-price`, `price-source`, original
`dia-error`, output and unsold sats. `mid` is diagnostic; `limit` enforces min-out.
All transfers and failed-call state rollbacks are tested. Both sources unusable
rejects; no zero-price escape is used. Emergency swaps remain admin-only and keep
window, amount, chunk-size and cooldown guards. A zero window is allowed only
between batches in the Juice vault.

## Timed admin handover

Only the current admin proposes/cancels a successor. Only the nominee accepts,
no earlier than 144 Bitcoin blocks after the latest proposal. Replacement resets
the delay; former-admin authority is revoked at acceptance. Fork and local tests
cover 143/144-block boundaries, cancellation, replacement, repeat handover and
committed prints. Current handover results are linked in the table above.

## Local runtime and Rendezvous

See [the self-contained harness README](../tests/vault/README.md) for every
fixture/rewrite, coverage artifacts, seeds and replay commands. Runtime tests keep
the real pool authorization wrappers and full vault source; external dependencies
are local fixtures. RV alone binds the vault's POOL principal to the deployer
actor and appends test-only progress/actor wrappers to make successful calls reachable.
Production source files are never rewritten by the fixture builder.

The confirmed defect was in the JavaScript Jing-router assertion, not the contract:
decoded Clarity boolean true has `type: "true"`, not `.value === true`.
The archived report's two false failures were corrected by rechecking the original
committed events, and the current run passes all 39 assertions using the corrected
checker. No new contract defect was found by these runs.

## Historical reports

Earlier results are preserved under [history](results/pool-vault-stx/history),
with filenames equal to Stxer IDs. These document prior source versions and are
not current-source coverage. In particular
[ed4d8d4d0bb0698f50d4e059a811f026](https://stxer.xyz/simulations/mainnet/ed4d8d4d0bb0698f50d4e059a811f026)
is the superseded optional-Pyth split prototype; its `err u16047` and interface no
longer apply. The emergency function's separate interface is verified by current runs.

## Rotation fork fixtures

The rotation fork deploys an unchanged candidate copy plus a wrong-pool copy. It seeds private batch clocks, market position maps and the pending-tranche guard only in the fork to isolate each rejection. Real one-satoshi and one-microSTX donations remain on the retired vault. After switching, a seeded earned PoX reward of 10,000 sats plus the candidate donation is claimed through the public pool API, swapped through the real router/AMM, finalized and paid to the original staker. The 4,032 burn-height steps use compressed timestamps; they test the height gate, not a month of real-time oracle updates. Local migration tests separately preserve prior tranche payouts.

## Deployment source preparation

The three production contracts are now comment-free and formatted with Clarinet.
Comparing Clarity tokens before/after (ignoring whitespace and optional commas)
confirmed identical executable content. Backend deployment templates match the
formatted source byte for byte and use Clarity 6, account index 0. Deployment order
is trait, vault, rewards pool; wait for each transaction to confirm before the next.
[Curl commands and fees](https://github.com/Rapha-btc/faktory-dao/blob/master/backend/docs/juice-stx-rewards-deployment.md)
are recorded in the backend repository.

The 570 fork checks above refer to the recorded **pre-format hashes** in `fc58b61`.
They are preserved unchanged. After formatting, local migration checks still pass
**97/97**, and local vault coverage reaches **129/129 branch outcomes**, now
**398/417 line counters**. Formatting creates additional tuple-field, binding and
multiline contract-call counters; zero counters are listed in the saved coverage
report. It did not change executable behavior.

## Rerun on the current sources, and the vault fixes (L-1, L-2, #6, #7)

Juice vault `07476d1b` (juicestx `45bf3be`), pool `a5be5363`, Jing market
`d1e3bbad`, router `dfc8165b`, core `67242f19`; fork at block 9021103. No
expectation changed (the AMMs sat above the 1% floor at this block).

| sim | stxer | checks |
|---|---|---|
| guards | [22a079d6](https://stxer.xyz/simulations/mainnet/22a079d61a6c98b5484e0b75269c10a2) | 21/21 |
| maker | [5af8935a](https://stxer.xyz/simulations/mainnet/5af8935a16cbbec380a1dc8bfc70c8a6) | 34/34 |
| liquidation | [f6ad3bb6](https://stxer.xyz/simulations/mainnet/f6ad3bb67c89d5acd3390363ba59a8be) | 40/40 |
| jing-router | [5db1d2bc](https://stxer.xyz/simulations/mainnet/5db1d2bcab47b0a5587bfa97d4234d74) | 45/45 |
| jing-take | [812a09de](https://stxer.xyz/simulations/mainnet/812a09de2da4fab84e97bfadd4b808af) | 40/40 |
| split-pyth | [98090c31](https://stxer.xyz/simulations/mainnet/98090c31296e1797a96bedbb4cee23e5) | 41/41 |
| recovery-continuity | [1dee3dd2](https://stxer.xyz/simulations/mainnet/1dee3dd2e738147e598cb988ca3198f2) | 189/189 |
| upgrade | [0aa4ab91](https://stxer.xyz/simulations/mainnet/0aa4ab9172a19ff74a6726683e6bcddb) | 95/95 |
| admin-handover | [dedf87f3](https://stxer.xyz/simulations/mainnet/dedf87f364aab94665be5c5600017c5a) | 59/59 |
| emergency-dia | [83d8d37a](https://stxer.xyz/simulations/mainnet/83d8d37a1a7d13f8169e4b4166c18826) | 26/26 |
| emergency-native | [8fcd1f79](https://stxer.xyz/simulations/mainnet/8fcd1f7995d903483a30104c7a2972da) | 36/36 |
| recovery matrix (5 forks) | see `results/v6-3-recovery/juice.json` | 529/529 |
| **vault fixes** (`pool-vault-fixes-stxer.mjs`) | [5d728fd5](https://stxer.xyz/simulations/mainnet/5d728fd5588d24df1cf334ea9847874d) | 195/195 |

The vault-fixes sim:
- **#6:** a 2-sat claim closes and finalizes `(ok u0)` with no transfer; the
  next 6-sat claim lands on top (the vault holds 8).
- **L-2:** 289 and 1008 refused `(err u16033)`; 288 and 287 accepted.
- **L-1:** an 8-sat sale reverts `(err u16047)` without burning the cooldown,
  and 9 sats sell in the same burn block; a partial sale of a 1 BTC chunk
  sells 9,664,748 and keeps 90,335,252, the next call at the same floor reverts
  u16047, and after raising slippage the rest sells; `finalize` equals the sum
  of all `out`.
- **#7:** a 1-sat top-up in pending escrow after the live ask sold out;
  `close-batch` reclaims it and closes at once.
- **#8** (allowance band) cannot be built since the market's M-1 fix: the book
  leg fills in full, so no refund can push the outflow past the allowance.


## Rerun on the exact-rebate market, forked at the tip (2026-09-30)

What changed since the run above:
- **Market** (jing-contracts-v3 `34bbe18`): `swap` sizes the rebate on the net,
  `net = floor(amount*10000/(10000+bps))`, `rebate = amount - net` (bps 20 fresh,
  +1/s after 30 s, max 70). The taker still sends exactly `amount`; the unused
  rebate refunded is only rounding. `gross-cap = net-cap==0 ? 0 : floor(((net-cap+1)*10020-1)/10000)`.
- **Router** (`6a84e02`): `jing-size` estimates `net = size*BPS/(BPS+20)`.
- **Vault** (juicestx `5211831`): the `router-swap` allowance is
  `amount + min-x + JING_REBATE_DUST_SATS` (u51), replacing `amount*70/10000`.

Fork setup changes:
- **All sims fork at one tip height, 9093074** (`JUICE_FORK_BLOCK`, default: the node tip),
  so AMM prices match the live Pyth mid. The old 9021103 pin predated the live
  Juice deploys. At that pin, AMM prices were frozen while the mid moved, and L-1 did not clear.
- **The vault and pool deploy as `-v1`**, because `juice-pool-swap-vault` and
  `juice-pool-stx-signer-stx-rewards` are live on mainnet with an older version.
  `_juice-fork.mjs` rewrites only the two names and their references, in memory.
  Each run asserts that mapping the names back gives the repo file byte for byte.
  The Jing contracts are not on mainnet and keep their names.
- **L-1 is sized to the tip's AMM depth.** It now sells 0.3 BTC in 0.1 BTC chunks, down from 3 BTC in 1 BTC chunks. At the tip, 3 BTC did not clear within 10% in the fixed eight-call plan.
  The plan is unchanged:
  - sale 1 at 1% is partial (7,370,940 of 10,000,000 unsold);
  - sales 2–4 at 1% get `u16047`;
  - 3% and 10% sell the rest, the batch closes and finalize equals the sum of `out`;
  - then #7 and #8.
- **Model updates.**
  - #8 checks the gross outflow against `amount + 1000 + 51`.
  - A new check tests `gross-cap = gross-up(net-cap)` (198,379 → 198,776).

| sim | stxer | checks |
|---|---|---|
| guards | [1d02c55b0902eac5461d0442175e3865](https://stxer.xyz/simulations/mainnet/1d02c55b0902eac5461d0442175e3865) | 21/21 |
| maker | [ec53c85f5f3089bd08ea47b5366668e7](https://stxer.xyz/simulations/mainnet/ec53c85f5f3089bd08ea47b5366668e7) | 34/34 |
| liquidation | [c87b52f3d691e62ddca1c1670d173dab](https://stxer.xyz/simulations/mainnet/c87b52f3d691e62ddca1c1670d173dab) | 40/40 |
| jing-router | [d3110309c7b97af257487b7c2c7beb2d](https://stxer.xyz/simulations/mainnet/d3110309c7b97af257487b7c2c7beb2d) | 45/45 |
| jing-take | [6c6996e1311e95672b73cde787385f8f](https://stxer.xyz/simulations/mainnet/6c6996e1311e95672b73cde787385f8f) | 40/40 |
| split-pyth | [f5f35918654330bc4bef338ef95423b7](https://stxer.xyz/simulations/mainnet/f5f35918654330bc4bef338ef95423b7) | 41/41 |
| recovery-continuity | [9f2885d6a2c876ef0a28976dc0b8dfe3](https://stxer.xyz/simulations/mainnet/9f2885d6a2c876ef0a28976dc0b8dfe3) | 189/189 |
| upgrade | [ecbdab692fa40181ada73d3e13496125](https://stxer.xyz/simulations/mainnet/ecbdab692fa40181ada73d3e13496125) | 95/95 |
| admin-handover | [a30603c3391a182ece988754cebe753a](https://stxer.xyz/simulations/mainnet/a30603c3391a182ece988754cebe753a) | 59/59 |
| emergency-dia | [3386c5059b86b8df25ded6d74d716557](https://stxer.xyz/simulations/mainnet/3386c5059b86b8df25ded6d74d716557) | 26/26 |
| emergency-native | [cbeb64d2fd7ddb6fd3112a390d95822f](https://stxer.xyz/simulations/mainnet/cbeb64d2fd7ddb6fd3112a390d95822f) | 36/36 |
| recovery matrix: pending | [fa434d8eb55842102823dde5e460f32f](https://stxer.xyz/simulations/mainnet/fa434d8eb55842102823dde5e460f32f) | 529/529 in total |
| recovery matrix: resting | [7427ad0e7a32e050d055ef4616bf7781](https://stxer.xyz/simulations/mainnet/7427ad0e7a32e050d055ef4616bf7781) | |
| recovery matrix: parked | [f287169685f521a5a5c71288d52f8752](https://stxer.xyz/simulations/mainnet/f287169685f521a5a5c71288d52f8752) | |
| recovery matrix: pending+resting | [b8fcf37af2267c9deee65b283c39038b](https://stxer.xyz/simulations/mainnet/b8fcf37af2267c9deee65b283c39038b) | |
| recovery matrix: none | [41a84ddb3d757474159382fe0d07a8c1](https://stxer.xyz/simulations/mainnet/41a84ddb3d757474159382fe0d07a8c1) | |
| vault fixes | [716855fa46f534d9fd82b38b9382a609](https://stxer.xyz/simulations/mainnet/716855fa46f534d9fd82b38b9382a609) | 186/186 |
| allowance proof | [df24e5278e709229bf9da6dde4c0bda9](https://stxer.xyz/simulations/mainnet/df24e5278e709229bf9da6dde4c0bda9) | 4/4 cases |

**Allowance proof** (`vault-allowance-proof-stxer.mjs`,
[vault-allowance-proof.json](results/pool-vault-stx/vault-allowance-proof.json)).
The repo vault runs next to a TEST-ONLY `juice-pool-swap-vault-oldallow`, which has
`JING_REBATE_DUST_SATS` removed from the allowance (`amount + min-x`). Both sell
into the same three-bid book, which fills the whole chunk on Jing.

| chunk | print | Jing leg | rebate (model = paid) | rebate refunded | gross outflow | old allowance | 51-sat allowance |
|---|---|---|---|---|---|---|---|
| 1,000,000 | 5 s, 20 bps | 1,000,000 | 1,997 | 2 | 1,000,000 | ok | ok |
| 100,000,000 | 5 s, 20 bps | 100,000,000 | 199,601 | 1 | 100,000,000 | ok | ok |
| 1,000,000 | 79 s, 69 bps | 1,000,000 | 6,853 | 2 | 1,000,000 | ok | ok |
| 100,000,000 | 79 s, 69 bps | 100,000,000 | 685,272 | 1 | 100,000,000 | ok | ok |

On the old market, the 1 BTC case at 69 bps failed with the old allowance.
Now the refund is 1–2 sats (≤ 51) in every case, and both allowances pass.

SHA-256 (repo file → deployed `-v1` source):

- `juice-pool-swap-vault`: `d6e7637c7ece8eb8243361b50f065dc6734e50e6344a59199528e837dd4b6dbf` → `juice-pool-swap-vault-v1` `2219e13874055fa2dfa008a852857de5da5e159e26b6b688a74c17eb3c541a29`
- `juice-pool-stx-signer-stx-rewards`: `a5be5363956688c17376ba55f2af688372997d21823755797b9a6b4c919036cc` → `juice-pool-stx-signer-stx-rewards-v1` `04111e41dba556a3f41b6389b04fac11f60b49e2953e63577fc8b663ccdde426`
- `juice-pool-swap-vault-oldallow` (TEST-ONLY): `27b4b87cd355b7eeaac6fef277e25f0eab2ccf8dae5ea6815d01c7411147a8cf`
- `markets-sbtc-stx-jing-v6-3`: `5c08412fc5990a8bf0db3a0cbbec3fa4c859d4185d0caf1cd16ae0c78f851bfb`
- `swap-router-sbtc-stx-jing-v5-3`: `882374f40bfdf8270b3ea18ba2d7e68fce4431ee17c60f70b00bb2670240fe58`
- `jing-core-v6`: `88a689affb23f13030953e891336af42a3f5cb275f13b3c54c79d8cd4de50697`
- `jing-ladder-v1`: `0f1e08b023272ed96a2653f727292626d4b0325dcf4e42963104d977860ec786`

Rerun the set on one fork: `JUICE_FORK_BLOCK=<height> node simulations/<sim>` (commands above;
the matrix is `pool-vault-recovery-stxer.mjs --matrix`, the proof `vault-allowance-proof-stxer.mjs`).
