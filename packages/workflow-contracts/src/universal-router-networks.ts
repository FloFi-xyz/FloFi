// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: identities of the universal Cross-chain Router — the five FloFi mainnets, their ecosystems,
 * address formats and provider chain identifiers. Dependency-free so schema validation can use it.
 *
 * Provider chain identifiers were read from each provider's own chain list on 2026-10-25: LI.FI `/v1/chains` (Solana
 * 1151111081099710), Relay `/chains` (Solana 792703809, slugs `solana`/`base`/`arbitrum`/`ethereum`/`robinhood`), Mayan
 * `sia.mayan.finance/v6/init` (`solana`/`base`/`arbitrum`/`ethereum`; no Robinhood Chain), Across `available-routes`
 * (EVM only; no Solana route).
 */
export const UNIVERSAL_ROUTER_ADAPTER = Object.freeze({ id: 'flofi.router.universal', version: '1.0.0' } as const);
export const UNIVERSAL_ROUTER_CAPABILITY = 'bridge.universal-route';
/** Routing providers the universal router asks for routes. Order in the IR is the owner's preference (used by `PREFERENCE_ORDER`). */
export const UNIVERSAL_ROUTING_PROVIDERS = Object.freeze(['relay', 'lifi', 'mayan', 'across'] as const);
export type UniversalRoutingProvider = typeof UNIVERSAL_ROUTING_PROVIDERS[number];
/** `BEST_MINIMUM_OUTPUT`: the executable route with the highest guaranteed minimum output. `PREFERENCE_ORDER`: the first executable provider in order. */
export const UNIVERSAL_ROUTE_SELECTIONS = Object.freeze(['BEST_MINIMUM_OUTPUT', 'PREFERENCE_ORDER'] as const);
export type UniversalRouteSelection = typeof UNIVERSAL_ROUTE_SELECTIONS[number];
export const UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS = 300;

export type UniversalEcosystem = 'EVM' | 'SOLANA';
export type UniversalNetworkKey = 'solana' | 'base' | 'arbitrum-one' | 'ethereum' | 'robinhood';
export type UniversalNetwork = {
  readonly key: UniversalNetworkKey; readonly name: string; readonly chain: string; readonly ecosystem: UniversalEcosystem;
  /** EVM chain id; null on Solana. */ readonly evmChainId: number | null;
  readonly native: { readonly nativeId: 'ETH' | 'SOL'; readonly symbol: 'ETH' | 'SOL'; readonly decimals: number };
  readonly explorer: string;
  readonly providers: { readonly relay: { readonly chainId: number; readonly slug: string }; readonly lifi: { readonly chainId: number };
    readonly mayan: string | null; readonly across: number | null };
};
export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const UNIVERSAL_NETWORKS: Readonly<Record<UniversalNetworkKey, UniversalNetwork>> = Object.freeze({
  solana: Object.freeze({ key: 'solana', name: 'Solana', chain: SOLANA_MAINNET, ecosystem: 'SOLANA', evmChainId: null,
    native: Object.freeze({ nativeId: 'SOL', symbol: 'SOL', decimals: 9 }), explorer: 'https://solscan.io/',
    providers: Object.freeze({ relay: Object.freeze({ chainId: 792703809, slug: 'solana' }), lifi: Object.freeze({ chainId: 1151111081099710 }), mayan: 'solana', across: null }) }),
  base: Object.freeze({ key: 'base', name: 'Base', chain: 'eip155:8453', ecosystem: 'EVM', evmChainId: 8453,
    native: Object.freeze({ nativeId: 'ETH', symbol: 'ETH', decimals: 18 }), explorer: 'https://basescan.org/',
    providers: Object.freeze({ relay: Object.freeze({ chainId: 8453, slug: 'base' }), lifi: Object.freeze({ chainId: 8453 }), mayan: 'base', across: 8453 }) }),
  'arbitrum-one': Object.freeze({ key: 'arbitrum-one', name: 'Arbitrum One', chain: 'eip155:42161', ecosystem: 'EVM', evmChainId: 42161,
    native: Object.freeze({ nativeId: 'ETH', symbol: 'ETH', decimals: 18 }), explorer: 'https://arbiscan.io/',
    providers: Object.freeze({ relay: Object.freeze({ chainId: 42161, slug: 'arbitrum' }), lifi: Object.freeze({ chainId: 42161 }), mayan: 'arbitrum', across: 42161 }) }),
  ethereum: Object.freeze({ key: 'ethereum', name: 'Ethereum', chain: 'eip155:1', ecosystem: 'EVM', evmChainId: 1,
    native: Object.freeze({ nativeId: 'ETH', symbol: 'ETH', decimals: 18 }), explorer: 'https://etherscan.io/',
    providers: Object.freeze({ relay: Object.freeze({ chainId: 1, slug: 'ethereum' }), lifi: Object.freeze({ chainId: 1 }), mayan: 'ethereum', across: 1 }) }),
  robinhood: Object.freeze({ key: 'robinhood', name: 'Robinhood Chain', chain: 'eip155:4663', ecosystem: 'EVM', evmChainId: 4663,
    native: Object.freeze({ nativeId: 'ETH', symbol: 'ETH', decimals: 18 }), explorer: 'https://robinhoodchain.blockscout.com/',
    providers: Object.freeze({ relay: Object.freeze({ chainId: 4663, slug: 'robinhood' }), lifi: Object.freeze({ chainId: 4663 }), mayan: null, across: 4663 }) }),
});
export const UNIVERSAL_NETWORK_KEYS = Object.freeze(Object.keys(UNIVERSAL_NETWORKS) as UniversalNetworkKey[]);
export const universalNetworkOfChain = (chain: string): UniversalNetwork | null =>
  Object.values(UNIVERSAL_NETWORKS).find(network => network.chain === chain) ?? null;
/** Every directed combination of two distinct networks (20). */
export const UNIVERSAL_DIRECTED_PAIRS: readonly { readonly source: UniversalNetworkKey; readonly destination: UniversalNetworkKey }[] = Object.freeze(
  UNIVERSAL_NETWORK_KEYS.flatMap(source => UNIVERSAL_NETWORK_KEYS.filter(destination => destination !== source).map(destination => Object.freeze({ source, destination }))));

/**
 * Fixed public quote subjects: the addresses FloFi asks providers to quote for before a wallet is connected, and the read-only preview
 * recipient of a Solana ⇄ EVM bridge. Never an owner, a recipient of real funds or an authorization (the Review always re-quotes for the
 * real owner and recipient). Both are nothing-up-my-sleeve values, so nobody is known to hold a key: EVM = the first 20 bytes of
 * sha256("flofi.universal-router.public-quote-subject.evm.v1"); Solana = sha256("flofi.universal-router.public-quote-subject.solana.v1:0"),
 * a valid Ed25519 point. Ordinary addresses on purpose: Relay replaces a burn address such as 0x…dead with its own recipient and refund
 * address, which FloFi's order verifier then (correctly) refuses, hiding the provider's real availability before a wallet connects.
 */
export const UNIVERSAL_QUOTE_SUBJECTS = Object.freeze({ EVM: '0x7e63d8d571a4793941b903ce2f445dcfb1f1090e', SOLANA: 'htEfnEL8TnmfY5huT9CdJhnRN4ze8T5brBunyuP6xXL' } as const);

// --- addresses -------------------------------------------------------------------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Strict base58 decode (no checksum); null when the text is not canonical base58. */
export function base58Bytes(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 64) return null;
  let n = 0n;
  for (const char of text) { const digit = B58.indexOf(char); if (digit < 0) return null; n = n * 58n + BigInt(digit); }
  const body: number[] = [];
  while (n > 0n) { body.unshift(Number(n % 256n)); n /= 256n; }
  let zeros = 0;
  for (const char of text) { if (char !== '1') break; zeros++; }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const EVM_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const SOLANA_SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** A Solana public key: canonical base58 of exactly 32 bytes. */
export function isSolanaPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const bytes = base58Bytes(value);
  return bytes !== null && bytes.length === 32;
}
/**
 * The canonical form of an account address on a network's ecosystem (EVM lowercase hex; Solana exact base58), or throws.
 * The zero address and the System Program id are never accounts that can hold delivered funds.
 */
export function canonicalUniversalAddress(network: UniversalNetwork, value: unknown, code = 'UNIVERSAL_ADDRESS_INVALID'): string {
  if (network.ecosystem === 'EVM') {
    if (typeof value !== 'string' || !EVM_ADDRESS.test(value) || value.toLowerCase() === EVM_ZERO_ADDRESS) throw new Error(code);
    return value.toLowerCase();
  }
  if (!isSolanaPublicKey(value) || value === SOLANA_SYSTEM_PROGRAM) throw new Error(code);
  return value;
}
/** A token contract (EVM) or mint (Solana) address on a network, canonical form, or throws. */
export function canonicalUniversalToken(network: UniversalNetwork, value: unknown, code = 'UNIVERSAL_TOKEN_INVALID'): string {
  return canonicalUniversalAddress(network, value, code);
}
