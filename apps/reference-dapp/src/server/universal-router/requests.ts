// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: the closed discovery request a browser, MCP client or channel may send. Network keys, token references
 * (native, or a contract/mint with its decimals and display symbol), an amount in base units, the slippage bound, optional owner and
 * recipient for owner-specific quotes, optional provider subset. Everything is re-validated here; nothing is trusted.
 */
import { canonicalUniversalAddress, UNIVERSAL_NETWORKS, UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS, UNIVERSAL_ROUTING_PROVIDERS, universalAmountCeiling, universalToken,
  type UniversalNetworkKey, type UniversalRoutingProvider, type UniversalToken } from '@defi-workflow-engine/workflow-contracts';
import type { DiscoveryRequest } from './discovery.ts';

const fail = (code: string): never => { throw new Error(code); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export type DiscoveryTokenInput = { readonly kind: 'NATIVE' } | { readonly kind: 'TOKEN'; readonly address: string; readonly decimals: number; readonly symbol?: string };
export type DiscoveryRequestInput = { readonly source: UniversalNetworkKey; readonly destination: UniversalNetworkKey; readonly inputToken: DiscoveryTokenInput;
  readonly outputToken: DiscoveryTokenInput; readonly amount: string; readonly slippageBps: number; readonly owner?: string; readonly recipient?: string;
  readonly providers?: readonly UniversalRoutingProvider[] };
const KEYS = Object.keys(UNIVERSAL_NETWORKS) as UniversalNetworkKey[];
function token(network: (typeof UNIVERSAL_NETWORKS)[UniversalNetworkKey], value: unknown): UniversalToken {
  if (!isObject(value)) return fail('UNIVERSAL_REQUEST_INVALID');
  if (value.kind === 'NATIVE') return { chainId: network.chain, kind: 'NATIVE', address: null, decimals: network.native.decimals, symbol: network.native.symbol };
  const symbol = typeof value.symbol === 'string' && /^[A-Za-z0-9.$+_-]{1,24}$/.test(value.symbol) ? value.symbol : 'TOKEN';
  return universalToken({ chainId: network.chain, kind: 'TOKEN', address: value.address as string, decimals: value.decimals as number, symbol }, network.chain, 'UNIVERSAL_REQUEST_TOKEN_INVALID');
}
export function parseDiscoveryRequest(value: unknown): DiscoveryRequest & { readonly providers: readonly UniversalRoutingProvider[] } {
  if (!isObject(value) || Object.keys(value).some(k => !['source', 'destination', 'inputToken', 'outputToken', 'amount', 'slippageBps', 'owner', 'recipient', 'providers'].includes(k)))
    return fail('UNIVERSAL_REQUEST_INVALID');
  if (!KEYS.includes(value.source as UniversalNetworkKey) || !KEYS.includes(value.destination as UniversalNetworkKey) || value.source === value.destination)
    return fail('UNIVERSAL_REQUEST_NETWORK_INVALID');
  const source = UNIVERSAL_NETWORKS[value.source as UniversalNetworkKey], destination = UNIVERSAL_NETWORKS[value.destination as UniversalNetworkKey];
  if (typeof value.amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value.amount) || BigInt(value.amount) > universalAmountCeiling(source)) return fail('UNIVERSAL_REQUEST_AMOUNT_INVALID');
  if (!Number.isSafeInteger(value.slippageBps) || (value.slippageBps as number) < 1 || (value.slippageBps as number) > UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS)
    return fail('UNIVERSAL_REQUEST_SLIPPAGE_INVALID');
  const providers = value.providers === undefined ? [...UNIVERSAL_ROUTING_PROVIDERS] : Array.isArray(value.providers) &&
    value.providers.length >= 1 && value.providers.every(p => (UNIVERSAL_ROUTING_PROVIDERS as readonly unknown[]).includes(p)) && new Set(value.providers).size === value.providers.length
    ? value.providers as UniversalRoutingProvider[] : fail('UNIVERSAL_REQUEST_PROVIDERS_INVALID');
  return { source, destination, inputToken: token(source, value.inputToken), outputToken: token(destination, value.outputToken), amount: value.amount,
    slippageBps: value.slippageBps as number, providers,
    ...value.owner !== undefined ? { owner: canonicalUniversalAddress(source, value.owner, 'UNIVERSAL_REQUEST_OWNER_INVALID') } : {},
    ...value.recipient !== undefined ? { recipient: canonicalUniversalAddress(destination, value.recipient, 'UNIVERSAL_REQUEST_RECIPIENT_INVALID') } : {} };
}
