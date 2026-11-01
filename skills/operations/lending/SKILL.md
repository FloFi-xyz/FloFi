# Lending operation (FloFi engineering skill)

- Aave V3 supply, borrow, repay and withdraw. Health factor, debt and collateral are economic state read fresh at
  Review; FloFi refuses an action that would leave an unsafe position as reviewed.
- Compositions (for example supply then borrow) are sequential: each step's Review uses the reconciled result of
  the step before it.
