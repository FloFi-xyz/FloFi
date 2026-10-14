// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: how analytics name networks — FloFi's own network registry (`domain/network-registry.ts`: names, local marks, family,
 * mainnet/testnet), keyed by CAIP-2 chain, plus the execution environment of a run from its recorded provenance. Unknown chains are shown
 * by their chain id, never renamed. Chart colors follow the network family in a fixed order, so a network keeps its color whatever its rank.
 */
import { networkIdentity } from '../../domain/network-registry.ts';

export type AnalyticsEnvironment = 'MAINNET' | 'TESTNET' | 'MOCKED';
export const ENVIRONMENTS: readonly AnalyticsEnvironment[] = ['MAINNET', 'TESTNET', 'MOCKED'];
export const ENVIRONMENT_LABELS: Readonly<Record<AnalyticsEnvironment, string>> = { MAINNET: 'Mainnet', TESTNET: 'Testnet / Devnet', MOCKED: 'Mocked (local)' };
/** The environment a run executed in, from its recorded provenance (PUBLIC_DEVNET is grouped with testnets and labelled so). */
export function environmentOf(provenance: string): AnalyticsEnvironment | null {
  if (provenance === 'PUBLIC_MAINNET') return 'MAINNET';
  if (provenance === 'PUBLIC_TESTNET' || provenance === 'PUBLIC_DEVNET') return 'TESTNET';
  if (provenance === 'MOCKED') return 'MOCKED';
  return null;
}

/** Fixed categorical slot per network family (1–5); anything else is "Other". */
export const FAMILY_SLOTS: Readonly<Record<string, number>> = { base: 1, arbitrum: 2, ethereum: 3, solana: 4, robinhood: 5 };
export type NetworkInfo = { readonly chain: string; readonly name: string; readonly family: string; readonly registryEnvironment: 'MAINNET' | 'TESTNET' | null;
  readonly mark: string | null; readonly slot: number | null };
export function networkInfo(chain: string): NetworkInfo {
  const identity = networkIdentity(chain);
  if (!identity || identity.chain !== chain) return { chain, name: chain, family: 'other', registryEnvironment: null, mark: null, slot: null };
  return { chain, name: identity.name, family: identity.family, registryEnvironment: identity.environment, mark: identity.mark, slot: FAMILY_SLOTS[identity.family] ?? null };
}
