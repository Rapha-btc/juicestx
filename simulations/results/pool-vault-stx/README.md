# Juice swap-vault Stxer results

Current-source validation on **2026-09-18**: **570/570 Stxer checks passed** across 11 mainnet forks for the three contracts pushed in `fc58b61`. Each fork deploys the exact trait, vault and pool source before testing. No production transactions are sent.

The rotation fork has **89 passing checks**: admin/pool binding, cancellation and reset, 4,031-block rejection and 4,032-block activation, pending-tranche protection, old/new batch clocks and resting/parked positions, tiny donations accepted on both idle vaults, every stale wrapper rejected, and a real post-switch PoX claim, AMM swap, finalization and payout. Candidate vault copies exist only in the fork.

The local migration suite passes **97 checks**. Current local vault coverage reaches **129/129 branch outcomes** and **292/294 line counters**. The two zero-hit literal/binding counters execute semantically. The earlier Rendezvous runs (2,000 checks, zero exceptions, 60 completed batches) refer to pre-rotation hashes; they have not been rerun for vault rotation.

| Scenario | Passed | Stxer | Raw report |
| --- | --- | --- | --- |
| Vault rotation and post-switch rewards | 89/89 | [simulation](https://stxer.xyz/simulations/mainnet/dbd028618b2a89291b43a66069b62d23) | [juice-vault-upgrade.json](juice-vault-upgrade.json) |
| Deployment and guards | 15/15 | [simulation](https://stxer.xyz/simulations/mainnet/2274b02948e1381360d12f2a0b6d53b6) | [juice-deployment-guards.json](juice-deployment-guards.json) |
| Maker fill during patience | 31/31 | [simulation](https://stxer.xyz/simulations/mainnet/a773f4a7d6d7dff8554b476832dbb9bc) | [juice-maker.json](juice-maker.json) |
| Smart-router AMM liquidation | 35/35 | [simulation](https://stxer.xyz/simulations/mainnet/d3b40e8a7c10664eb3d6e0e4e10f7ac9) | [juice-liquidation.json](juice-liquidation.json) |
| Smart-router Jing fills | 40/40 | [simulation](https://stxer.xyz/simulations/mainnet/0a2efbe80b3936672dce8c6be4e042a8) | [juice-jing-router.json](juice-jing-router.json) |
| Admin direct Jing take | 35/35 | [simulation](https://stxer.xyz/simulations/mainnet/caa0a8749794c515cee4b16372eb58fd) | [juice-jing-take.json](juice-jing-take.json) |
| Required-Pyth manual split | 36/36 | [simulation](https://stxer.xyz/simulations/mainnet/acd282c4b730fa9ee454824bcdb5772f) | [juice-split-pyth.json](juice-split-pyth.json) |
| Four-batch recovery continuity | 186/186 | [simulation](https://stxer.xyz/simulations/mainnet/b9107092fc2f1c74bac94a5dae9b9306) | [juice-recovery-continuity.json](juice-recovery-continuity.json) |
| Timed admin handover | 53/53 | [simulation](https://stxer.xyz/simulations/mainnet/423cbe080c8335e611ee87f2809f5df4) | [juice-admin-handover.json](juice-admin-handover.json) |
| Emergency DIA swap | 20/20 | [simulation](https://stxer.xyz/simulations/mainnet/b14d5ed91cf95e2e0995f460dbd775e5) | [juice-emergency-dia.json](juice-emergency-dia.json) |
| Emergency native fallback | 30/30 | [simulation](https://stxer.xyz/simulations/mainnet/02d37affb122566fff0de32e0cb628c5) | [juice-emergency-native.json](juice-emergency-native.json) |

See [verification, commands and fixture scope](../../README-pool-vault-stx.md). Pre-rotation reports are preserved in [pre-rotation](pre-rotation/); earlier reports remain in [history](history/).
