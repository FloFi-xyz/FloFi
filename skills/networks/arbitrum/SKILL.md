# Arbitrum One (FloFi engineering skill)

- Chain `eip155:42161`, Nitro. Gas estimates already include L1 posting gas; there is no separate OP-style
  `l1Fee` field. FloFi applies `nitroGasLimit` / `nitroMaxFeePerGas` bounds.
- Blocks are produced quickly by the sequencer; L1-backed finality takes longer. A sequencer receipt is
  "confirmed onchain"; FloFi's reconciliation, not the receipt, establishes completion.
- `block.number` inside Arbitrum contracts follows L1 block numbers; use the chain's own head for FloFi's pinned
  reads, never cross-chain block arithmetic.
- The third-party "Arbitrum DeFi guide" is recorded as PENDING_VERIFICATION: it is a lead to check against the
  official Arbitrum documentation, never guidance by itself.
