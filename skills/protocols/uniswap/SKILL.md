# Uniswap (FloFi engineering skill)

## How FloFi quotes
- FloFi quotes Uniswap V3 on-chain: each standard fee tier's pool address is derived locally (CREATE2), verified
  (factory, token0, token1, fee), checked for liquidity and slot0, then quoted with QuoterV2
  `quoteExactInputSingle` at one pinned block. The best `expectedOut` wins; ties go to the lower fee.
- QuoterV2 is not a view: it simulates the swap and reverts with the result. Call it with `eth_call` only.
- Pool immutables and the protocol contracts' code are stable deployment facts; liquidity, slot0 and quotes are
  read fresh for every quote and Review.

## The Uniswap Trading API is a different product
- `routingPreference` (`BEST_PRICE` or `FASTEST`) belongs to the Trading API's `/quote`. `FASTEST` skips UniswapX
  private liquidity. FloFi does not use the Trading API: its quotes come with calldata FloFi's adapters would have
  to verify independently, and it needs an API key. Do not add these modes to the on-chain QuoterV2 adapter.

## Review commitments
- Native ETH in/out travels through the router's `WETH9()`; the reviewed native side, exact approval amount,
  minimum output (slippage bound) and deadline are bound into Review.
