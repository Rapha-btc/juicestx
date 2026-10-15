# Mainnet deploys, verified

On-chain source compared by hand with the repo source. Deploy bytes have no
comments and are `clarinet format` output. Hash = sha512/256 of the on-chain
source.

## 2026-10-15: Juice sBTC pool set

Verified by Rapha: GREEN.

| Contract | Tx | Block | Hash | Source |
|---|---|---|---|---|
| `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.juice-swap-vault-trait-v2` | `0x167efd0193ccec880aa3f17fa025fa7dc5c73ca979798590bfb1a67fe7588b48` | 9219775 | `de229849f1823c5e3006ea0b410e806b6da28792ff47d1e308a648980bc84063` | `contracts/pox-5/juice-swap-vault-trait-v2.clar` at `f071a5e` |
| `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.juice-pool-sbtc-signer` | `0x750c512afb7e525ac886acaeed544d90a7347eddc373ece643c06c1143b1491d` | 9219775 | `9b0cdd5bb6274ca4aeef34834e01cfb18bfa3a6120527dc9fbfb849031b1aebe` | `contracts/pox-5/juice-pool-sbtc-signer.clar` at `f071a5e` |
| `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.juice-sbtc-autoswap` | `0xafd3b3eda744b414812ecb2c7d34c01410b14d43ad69b82be379315532279285` | 9219776 | `eb4cd0f7497b62181b1b3527cc4db71ef86e43f32bf8d9466eff56c790ad68d5` | `contracts/pox-5/juice-sbtc-autoswap.clar` at `f071a5e` |

Autoswap: Jing market v6-4 + router v5-5, maker-spread-bps default 1 bp
(bounty mv8wal, Cunning Nexus #2). Pool still needs `register-self`.
