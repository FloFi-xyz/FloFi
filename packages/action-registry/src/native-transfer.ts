// SPDX-License-Identifier: Apache-2.0
import { ROBINHOOD_MAINNET_TRANSFER, ROBINHOOD_TESTNET_TRANSFER } from './robinhood-chain.js';
import { ETHEREUM_SEPOLIA_TRANSFER } from './ethereum-sepolia.js';
import { BASE_MAINNET_TRANSFER } from './base-chain.js';
/**
 * The transfer profiles: the native test-ETH self-transfers on public testnets (RH-DEMO-001, BUILD-ETHEREUM-001), Robinhood Chain mainnet
 * since BUILD-RH-002 and Base mainnet since BUILD-BASE-001 (native ETH and catalog ERC-20s, explicit recipients allowed).
 */
export type NativeTransferProfile = typeof ROBINHOOD_TESTNET_TRANSFER | typeof ETHEREUM_SEPOLIA_TRANSFER | typeof ROBINHOOD_MAINNET_TRANSFER | typeof BASE_MAINNET_TRANSFER;
export const NATIVE_TRANSFER_PROFILES: readonly NativeTransferProfile[] = Object.freeze([ROBINHOOD_TESTNET_TRANSFER, ETHEREUM_SEPOLIA_TRANSFER, ROBINHOOD_MAINNET_TRANSFER,
  BASE_MAINNET_TRANSFER]);
/** Explicit recipients and ERC-20 transfers are a profile capability (the mainnet profiles: Robinhood Chain and Base). */
export const transferAllowsRecipients = (profile: NativeTransferProfile) => 'recipients' in profile && profile.recipients === 'ANY';
export const transferAllowsTokens = (profile: NativeTransferProfile) => 'tokenAdapterId' in profile;
/** The deployment environment of a transfer profile. */
export const transferEnvironment = (profile: NativeTransferProfile): 'PUBLIC_TESTNET' | 'MAINNET' => 'environment' in profile ? profile.environment : 'PUBLIC_TESTNET';
/** BUILD-BASE-001: the OP Stack GasPriceOracle of a profile whose receipts carry a separate `l1Fee` (Base), or null (no L1 data fee). */
export const transferL1FeeOracle = (profile: NativeTransferProfile): string | null => 'l1DataFee' in profile && profile.l1DataFee ? profile.gasPriceOracle : null;
export function nativeTransferProfile(chain: string): NativeTransferProfile {
  const profile = NATIVE_TRANSFER_PROFILES.find(item => item.chain === chain);
  if (!profile) throw new Error('TRANSFER_NETWORK_UNSUPPORTED');
  return profile;
}
