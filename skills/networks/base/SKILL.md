# Base (FloFi engineering skill)

- Chain `eip155:8453`, an OP Stack chain (about 2 s blocks). Origin-chain confirmation is not destination
  settlement for any bridge that starts or ends here.
- Fees: the execution fee (EIP-1559) plus an L1 data fee charged by the protocol, readable from the GasPriceOracle
  predeploy (`getL1Fee`). FloFi's Review budget includes both and fails closed when the oracle cannot be read.
- Native ETH vs WETH (`0x4200000000000000000000000000000000000006`) are distinct; the reference USDC ⇄ WETH swap
  and catalog swaps keep the authored identity.
- Public `mainnet.base.org` rate-limits bursts (measured: about five calls, then HTTP 429). Keep reads paced unless
  an operator endpoint is declared dedicated.
- Registered here: Uniswap V3 swaps and liquidity, Aave V3, the certified Router and the universal router.
