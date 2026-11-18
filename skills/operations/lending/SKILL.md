# Lending operation (FloFi engineering skill)

- Aave V3 supply, borrow, repay and withdraw. Health factor, debt and collateral are economic state read fresh at
  Review; FloFi refuses an action that would leave an unsafe position as reviewed.
- Compositions (for example supply then borrow) are sequential: each step's Review uses the reconciled result of
  the step before it. Verify the finite mock/public-testnet composition binding separately from single-action
  public mainnet profiles.
- Check the registered market and underlying address, live reserve caps and pause/freeze state; label missing
  observations as unknown. Use the protocol max semantics for repay-all.
