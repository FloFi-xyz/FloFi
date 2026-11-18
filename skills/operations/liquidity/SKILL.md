# Liquidity operation (FloFi engineering skill)

- Concentrated liquidity (Uniswap V3 on EVM, Orca Whirlpools on Solana): range, amounts and the position owner
  are bound by Review; price movement between Review and execution is bounded by the reviewed minimums.
- A liquidity step that depends on an earlier step's output (bound compositions) waits for that output to be
  reconciled before its own Review.
- Resolve the exact catalog pool, fee tier and token orientation before calculating ranges. Use a fresh verified
  pool read for relative ranges. Public authoring and position management have separate capability checks.
- Preserve reconciled approvals or steps when an unsubmitted request expires. Resolve any ambiguous wallet
  request before allowing the owner to review a replacement commitment.
