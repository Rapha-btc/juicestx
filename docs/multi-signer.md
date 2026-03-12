# Multi-Signer Architecture

STX Juice supports multiple institutional signers from day 1.

## How it works

```
registry.clar
  |
  +-- signers: [pool-A, pool-B, pool-C]
  |
  +-- signer-allocation: pool-A = 5000 (50%), pool-B = 3000 (30%), pool-C = 2000 (20%)
  +-- signer-fee:        pool-A = 500 (5%),   pool-B = 300 (3%)   [set on pool contract]
  +-- signer-delegates:  pool-A = [stacker-1a, stacker-1b, stacker-1c]
  +-- delegate-allocation: stacker-1a = 5000, stacker-1b = 3000, stacker-1c = 2000
```

- **Signer allocation** controls what percentage of total STX each signer receives (must sum to 10,000 bps)
- **Signer fee** is set by each signer on their pool contract (their revenue share of rewards)
- **Stacker delegates** are thin STX-holding contracts per pool (multiple per pool for graceful rotation)
- **Delegate allocation** controls how STX is split among stackers within a single pool

## Adding a new signer

No contract upgrades needed. An admin calls:

```clarity
(contract-call? .registry set-signers (list .pool-a .pool-b .pool-new))
(contract-call? .registry set-signer-allocation .pool-new u2000)
```

The signer sets their own fee on their pool contract. Allocation routes STX to the new pool's stackers on the next cycle.

## Launch plan

Phase 1: Single signer (us or Fast Pool) -- signer allocation = 10,000 (100%)
Phase 2: Add 2-3 institutional signers -- split allocations
Phase 3: Full signer set with per-signer fee negotiation
