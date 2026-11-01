# Liquidity operation (FloFi engineering skill)

- Concentrated liquidity (Uniswap V3 on EVM, Orca Whirlpools on Solana): range, amounts and the position owner
  are bound by Review; price movement between Review and execution is bounded by the reviewed minimums.
- A liquidity step that depends on an earlier step's output (bound compositions) waits for that output to be
  reconciled before its own Review.
