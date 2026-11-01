# Ethereum mainnet (FloFi engineering skill)

- Chain `eip155:1`. Proof-of-stake: 12 s slots; blocks are final after two epochs (about 13 minutes). FloFi treats a
  receipt as "confirmed onchain", not as reconciled completion.
- Mainnet gas is the costliest of FloFi's networks: Review shows the fee budget (`gasLimit × maxFeePerGas`) and the
  owner's ETH must cover it plus any native amount.
- Native ETH and WETH are different assets. A swap side named ETH is native (router `WETH9()` wraps it); WETH is the
  ERC-20. Never substitute one for the other in Review or in a quote.
- Uniswap V3 and Aave V3 are the registered mainnet protocols here; see the protocol skills.
- Read pacing: the public endpoint is paced; `GRYLOO_ETHEREUM_RPC_URL` may be an operator endpoint.
