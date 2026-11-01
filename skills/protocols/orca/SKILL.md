# Orca Whirlpools (FloFi engineering skill)

- FloFi uses Whirlpools for concentrated liquidity on Solana mainnet (`orca.whirlpools-mainnet-liquidity`) and for
  devnet swaps in isolated certification. Positions are NFTs owned by the owner's wallet.
- Tick arrays, the whirlpool account and token vaults are read from the chain at Review; the reviewed message is
  compiled and simulated by FloFi like any other Solana transaction.
- The upstream repository's licence changed in 2025 (custom licence after an Apache-2.0 period); record the licence
  of any code you reference, and never vendor code without a licence review.
