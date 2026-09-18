# Juice swap-vault Stxer results

Current-source runs: **471/471 checks passed**, 2026-09-18.

| Scenario | Passed | Stxer | Raw report |
| --- | --- | --- | --- |
| Deployment and guards | 14/14 | [simulation](https://stxer.xyz/simulations/mainnet/a802afe1e2560bfe2c3b7d892b538666) | [juice-deployment-guards.json](juice-deployment-guards.json) |
| Maker fill during patience | 30/30 | [simulation](https://stxer.xyz/simulations/mainnet/575d7961086357312e7a464a543fdb98) | [juice-maker.json](juice-maker.json) |
| Smart-router AMM liquidation | 34/34 | [simulation](https://stxer.xyz/simulations/mainnet/ca99c1e1ea2564f52e2867ee00cef13a) | [juice-liquidation.json](juice-liquidation.json) |
| Smart-router Jing fills | 39/39 | [simulation](https://stxer.xyz/simulations/mainnet/805d3ef5744496d654b69c6c259fddc4) | [juice-jing-router.json](juice-jing-router.json) |
| Owner-only direct Jing take | 34/34 | [simulation](https://stxer.xyz/simulations/mainnet/a1f6901f1527cd7407beeb9d395a3bf1) | [juice-jing-take.json](juice-jing-take.json) |
| Required-Pyth manual split | 35/35 | [simulation](https://stxer.xyz/simulations/mainnet/d68fa679b74688e94fd2df8a1f922191) | [juice-split-pyth.json](juice-split-pyth.json) |
| Four-batch recovery continuity | 185/185 | [simulation](https://stxer.xyz/simulations/mainnet/e662fbe736f230e530fc31cfc53a37a9) | [juice-recovery-continuity.json](juice-recovery-continuity.json) |
| Timed admin handover | 52/52 | [simulation](https://stxer.xyz/simulations/mainnet/9010c0341aa816fad433d5bf4e0134fc) | [juice-admin-handover.json](juice-admin-handover.json) |
| Emergency DIA swap | 19/19 | [simulation](https://stxer.xyz/simulations/mainnet/f1aee856d660d58e8709ccd279fa296f) | [juice-emergency-dia.json](juice-emergency-dia.json) |
| Emergency native fallback | 29/29 | [simulation](https://stxer.xyz/simulations/mainnet/bcc54d2a6ad69210bd7a91c44b08be72) | [juice-emergency-native.json](juice-emergency-native.json) |

See [verification, numeric examples, fixture scope, commands and runtime/RV results](../../README-pool-vault-stx.md).
Historical JSON reports are preserved in [history](history), named by simulation ID.
The superseded optional-update split and older recovery/admin reports are historical,
not proofs of coverage for the current emergency interface.
