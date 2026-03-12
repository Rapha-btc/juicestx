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
