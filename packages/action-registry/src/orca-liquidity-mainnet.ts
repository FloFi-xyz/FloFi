// SPDX-License-Identifier: Apache-2.0
import { JUPITER_SOLANA_MAINNET, SOLANA_MAINNET_TOKENS } from './jupiter-solana.js';
import { ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY as devnet } from './orca-liquidity-devnet.js';

/**
 * BUILD-SOLANA-MAINNET-001: Orca Whirlpools concentrated liquidity on Solana mainnet-beta — the same canonical
 * `asset.liquidity.concentrated` action and the same deployed Whirlpools program as the Devnet runtime, on one verified pool.
 * Real funds.
 *
 * Read from mainnet-beta (genesis 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d) at slot 456,346,347 on 2026-10-13:
 * Whirlpool HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ is owned by the Whirlpools program, belongs to the Orca
 * WhirlpoolsConfig 2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ, pairs wrapped SOL (token A, 9 decimals) with Circle USDC
 * (token B, 6 decimals), has fee rate 3000 (0.30%) and tick spacing 64, and keeps fixed 9,988-byte tick arrays for the
 * full range and for ranges around the current price. Its one initialized reward slot (ORCA) has a zero emission rate,
 * so no reward can accrue; every simulation re-reads the pool and refuses any slot that emits.
 * Program constants (instructions, events, discriminators, tick bounds, NFT update authority) are the program's own and
 * equal to the Devnet deployment's; the registry tests pin that equality.
 */
export const ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY = Object.freeze({
  chain: JUPITER_SOLANA_MAINNET.chain, network: 'Solana', cluster: 'mainnet-beta', walletChain: 'solana:mainnet',
  genesisHash: JUPITER_SOLANA_MAINNET.genesisHash, protocol: 'orca-whirlpools', adapterId: 'orca.whirlpools-mainnet-liquidity',
  providerLabel: 'Orca Whirlpools', rpc: JUPITER_SOLANA_MAINNET.rpc, explorer: JUPITER_SOLANA_MAINNET.explorer,
  officialSource: devnet.officialSource, docsSource: 'https://docs.orca.so/developers/architecture/whirlpool-parameters',
  programs: devnet.programs,
  whirlpoolsConfig: '2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ',
  pool: Object.freeze({ address: 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ', tokenMintA: SOLANA_MAINNET_TOKENS.SOL.mint,
    tokenMintB: SOLANA_MAINNET_TOKENS.USDC.mint, tokenVaultA: '3YQm7ujtXWJU2e9jhp2QGHpnn1ShXn12QjvzMvDgabpX',
    tokenVaultB: '2JTw1fE2wz1SymWUQ7UqpVtrTuKjcd6mWwYwUJUCh2rq', tickSpacing: 64 }),
  token0: SOLANA_MAINNET_TOKENS.SOL, token1: SOLANA_MAINNET_TOKENS.USDC,
  feeTier: 3000,
  metadataUpdateAuth: devnet.metadataUpdateAuth, instructions: devnet.instructions, events: devnet.events,
  positionDiscriminator: devnet.positionDiscriminator, tickArrayDiscriminator: devnet.tickArrayDiscriminator,
  tickArraySize: devnet.tickArraySize, minTick: devnet.minTick, maxTick: devnet.maxTick,
  maximumSlippageBps: 300, reviewTtlSeconds: 60, baseFeeLamports: '5000', maximumComputeUnits: 400_000,
  environment: 'MAINNET', provenance: 'PUBLIC_MAINNET', executedEvidence: 'PUBLIC_EXECUTED', bundleEnvironment: 'MAINNET_EXECUTED', realFunds: true,
  contractVersion: 'orca-whirlpools-mainnet', explorerTx: (signature: string) => `${JUPITER_SOLANA_MAINNET.explorer}/tx/${signature}`,
});
