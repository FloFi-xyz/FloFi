// SPDX-License-Identifier: Apache-2.0
import { ROBINHOOD_MAINNET_TRANSFER, ROBINHOOD_TESTNET_TRANSFER } from './robinhood-chain.js';
import { ETHEREUM_SEPOLIA_TRANSFER } from './ethereum-sepolia.js';
/**
 * The transfer profiles: the native test-ETH self-transfers on public testnets (RH-DEMO-001, BUILD-ETHEREUM-001) and, since
 * BUILD-RH-002, Robinhood Chain mainnet (native ETH and catalog ERC-20s, explicit recipients allowed).
 */
export type NativeTransferProfile = typeof ROBINHOOD_TESTNET_TRANSFER | typeof ETHEREUM_SEPOLIA_TRANSFER | typeof ROBINHOOD_MAINNET_TRANSFER;
export const NATIVE_TRANSFER_PROFILES: readonly NativeTransferProfile[] = Object.freeze([ROBINHOOD_TESTNET_TRANSFER, ETHEREUM_SEPOLIA_TRANSFER, ROBINHOOD_MAINNET_TRANSFER]);
/** Explicit recipients and ERC-20 transfers are a profile capability (only Robinhood Chain mainnet today). */
export const transferAllowsRecipients = (profile: NativeTransferProfile) => 'recipients' in profile && profile.recipients === 'ANY';
export const transferAllowsTokens = (profile: NativeTransferProfile) => 'tokenAdapterId' in profile;
/** The deployment environment of a transfer profile. */
export const transferEnvironment = (profile: NativeTransferProfile): 'PUBLIC_TESTNET' | 'MAINNET' => 'environment' in profile ? profile.environment : 'PUBLIC_TESTNET';
export function nativeTransferProfile(chain: string): NativeTransferProfile {
  const profile = NATIVE_TRANSFER_PROFILES.find(item => item.chain === chain);
  if (!profile) throw new Error('TRANSFER_NETWORK_UNSUPPORTED');
  return profile;
}
