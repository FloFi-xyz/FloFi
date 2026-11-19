// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-SOLANA-MAINNET-001 / BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the MOCKED loopback copy of the mainnet-beta Orca SOL/USDC pool
 * (e2e/solana-devnet-harness.mjs `/mainnet-rpc`). The app's MOCKED Orca mainnet runtime and the Dashboard's position scan read exactly this
 * endpoint when `GRYLOO_ORCA_MAINNET_HARNESS=MOCKED_LOOPBACK_ONLY`; it is never a public endpoint, and nothing read from it is mainnet evidence.
 */
export const ORCA_MAINNET_HARNESS_RPC = 'http://127.0.0.1:8552/mainnet-rpc';
