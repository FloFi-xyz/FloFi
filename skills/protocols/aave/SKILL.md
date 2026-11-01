# Aave V3 (FloFi engineering skill)

- Aave V3 supply, borrow, repay and withdraw are registered for Ethereum, Base and Arbitrum One through the Pool,
  deployment-gated (no mainnet execution evidence is recorded in the registry); check `executionCapabilityRegistry`.
- Health factor and amounts are economic state: read fresh at the pinned block for every Review; a change requires a
  new Review. Variable-rate debt grows every block; "repay all" must use the protocol's own max semantics, never a
  stale balance.
- Approvals are exact amounts. Never widen an approval to "unlimited" for convenience.
- The core contracts are BUSL-1.1: reference them, do not vendor them.
