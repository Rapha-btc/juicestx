# Juice - Liquid Stacking on Stacks

**Stack STX. Earn sBTC. Stay Liquid.**

Juice (jSTX) is a liquid stacking protocol on Bitcoin. Deposit STX, receive jSTX, and earn sBTC stacking rewards -- all while staying liquid in DeFi.

Website: [stxjuice.com](https://www.stxjuice.com/)

## How It Works

1. **Deposit**: Send STX to the protocol, get jSTX back (1:1 ratio)
2. **Earn**: Your STX is stacked via PoX signers, earning BTC rewards each cycle (~2 weeks)
3. **Claim**: sBTC rewards vest linearly; claim anytime
4. **Withdraw**: Request a withdrawal, get an NFT receipt, redeem for STX when the cycle ends
5. **DeFi**: Use jSTX as collateral in Zest and other protocols while still earning sBTC

jSTX is **not** a rebasing token. Your jSTX balance never changes. Yield comes as separate sBTC payments.

### Under the Hood

```
User deposits STX → vault.clar
       |
       | [Every ~2 weeks]
       v
allocation.clar computes per-stacker targets from registry weights
       |
       +---> Pool A (1 pool.clar + N stacker.clar)
       +---> Pool B, C, ... (added via registry)
       |
       v
BTC rewards → Emily mints sBTC into stacker contracts
       |
       v
yield.clar sweeps sBTC (stacker pays signer fee, yield takes protocol commission)
       |
       v
sBTC vests linearly over ~2100 blocks → jSTX holders claim
```

## Contracts

| Contract | Role |
|----------|------|
| **dao** | Permission gate (authorized contracts + admin wallets) |
| **registry** | Signer directory with allocation weights and stacker assignments |
| **jstx-token** | SIP-010 jSTX token, settles rewards on every transfer/mint/burn |
| **share-data** | Reward-per-share tracking data store (upgradeable separately) |
| **vault** | Holds all deposited STX |
| **core** | User entry: deposit, init-withdraw, withdraw |
| **yield** | Sweeps sBTC from stackers, vests rewards, settles wallets (O(1) per holder) |
| **commission** | Sends protocol commission to treasury (trait-swappable) |
| **pool** | PoX-4 signer operator (1 per signer): lock, extend, increase, finalize |
| **stacker** | Thin STX + sBTC holder (N per signer): delegates to PoX, pays signer fee |
| **allocation** | Computes stacker targets, moves STX from vault to stackers |
| **delegation** | Tracks user delegation preferences per stacker |
| **redeem-nft** | SIP-009 withdrawal receipt NFT with built-in marketplace |
| **fees-none** | No-op fee contract (swap in a real one later) |
| **position-zest** | Zest DeFi adapter (jSTX as collateral still earns sBTC) |

### Traits

| Trait | Purpose |
|-------|---------|
| **sip-010-trait** | Fungible token (jSTX, sBTC) |
| **sip-009-trait** | NFT (withdrawal receipts) |
| **vault-trait** | Vault deposit/release interface |
| **pool-trait** | Pool interface for stacker cross-contract calls |
| **stacker-trait** | Stacker interface for allocation + yield |
| **commission-trait** | Swappable fee strategy |
| **fees-trait** | Protocol fee on deposits/withdrawals |
| **position-trait** | DeFi adapter interface |

## Architecture Details

See [docs/](docs/) for deep dives:

- [STX Flow](docs/stx-flow.md) -- vault / registry / delegation / allocation, and how a withdrawal pulls STX back out of a stacker
- [StackingDAO Security Ops](docs/stackingdao-security-ops.md) -- their two permission lists, the escape hatches, and the stale entry that leaves ~4M STX behind a 2-of-3 key
- [Pool + Stacker Architecture](docs/stacker-architecture.md) -- why each signer has 1 pool + N stackers
- [Multi-Signer](docs/multi-signer.md) -- registry, allocation weights, adding signers
- [PoX Cycle Operations](docs/pox-cycle-operations.md) -- prepare phase, lock vs extend vs increase
- [sBTC Reward Flow](docs/sbtc-reward-flow.md) -- how BTC rewards become claimable sBTC

## Development

```bash
clarinet check       # Validate all contracts
npm test             # Run tests (vitest + Clarinet SDK)
```

## Status

Contracts scaffolded and compiling. Next steps:
- [ ] Unit tests for deposit/mint/withdraw flow
- [ ] Unit tests for reward distribution math
- [ ] Test multi-signer registry configuration
- [ ] Keeper bot for cycle management
- [ ] Security review

## License

TBD

## PoX-5 pool rewards converted to STX

The Juice pool variant in [juice-pool-stx-signer-stx-rewards.clar](contracts/pox-5/juice-pool-stx-signer-stx-rewards.clar)
routes claimed sBTC through [juice-pool-swap-vault.clar](contracts/pox-5/juice-pool-swap-vault.clar)
before paying stakers native STX. After 4,320 Bitcoin blocks, admin recovery can
return the remaining sBTC and converted STX to their original tranche. The vault
can then fund another batch, even while earlier recovered payouts are uncollected.

Latest-code Stxer validation: **263/263 checks passed**.

| Scenario | Passed | Stxer |
| --- | --- | --- |
| Deployment and guards | 14/14 | [simulation](https://stxer.xyz/simulations/mainnet/1f0b057a825cecb7ccb51cac99a3b593) |
| Maker fill during resting window | 30/30 | [simulation](https://stxer.xyz/simulations/mainnet/fda8d36ef8d440cdf306f89fd350947a) |
| Reclaim and smart-router liquidation | 34/34 | [simulation](https://stxer.xyz/simulations/mainnet/e036509b1b13ff7e6768b2873b70cbd5) |
| Recovery → recovery → normal → recovery | 185/185 | [simulation](https://stxer.xyz/simulations/mainnet/10e4772ef6fba8fee2ba5a2d85c72fc5) |

See [simulation commands and recovery behavior](simulations/README-pool-vault-stx.md)
and [all run links, raw reports and fixture scope](simulations/results/pool-vault-stx/README.md).
