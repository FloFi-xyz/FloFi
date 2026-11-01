# Base (FloFi engineering skill)

- Chain `eip155:8453`, an OP Stack chain (about 2 s blocks). Origin-chain confirmation is not destination
  settlement for any bridge that starts or ends here.
- Fees: the execution fee (EIP-1559) plus an L1 data fee. FloFi reads an upper bound from the GasPriceOracle predeploy
  with `getL1FeeUpperBound(uint256)` (selector `0xf1c7a58b`, the transaction size), not `getL1Fee(bytes)`. For catalog
  swaps the Review's fee budget is the execution fee; `begin` adds the L1 bound to its balance check and fails closed
  when the oracle cannot be read.
- Native ETH vs WETH (`0x4200000000000000000000000000000000000006`) are distinct; the reference USDC ⇄ WETH swap
  and catalog swaps keep the authored identity.
- Public `mainnet.base.org` rate-limits bursts (measured: about five calls, then HTTP 429). Keep reads paced unless
  an operator endpoint is declared dedicated.
- Registered here: Uniswap V3 swaps and liquidity, Aave V3, the certified Router and the universal router.
