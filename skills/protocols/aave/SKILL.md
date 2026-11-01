# Aave V3 (FloFi engineering skill)

- FloFi supports supply, borrow, repay and withdraw on Aave V3 (Ethereum, Base, Arbitrum One) through the Pool.
- Health factor and amounts are economic state: read fresh at the pinned block for every Review; a change requires a
  new Review. Variable-rate debt grows every block; "repay all" must use the protocol's own max semantics, never a
  stale balance.
- Approvals are exact amounts. Never widen an approval to "unlimited" for convenience.
- The core contracts are BUSL-1.1: reference them, do not vendor them.
