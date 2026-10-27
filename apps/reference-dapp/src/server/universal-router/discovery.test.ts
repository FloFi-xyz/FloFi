// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UNIVERSAL_NETWORKS, type UniversalToken } from '@defi-workflow-engine/workflow-contracts';
import { createUniversalDiscovery } from './discovery.ts';
import type { UniversalHttp } from './http.ts';

/** Live provider answers recorded read-only on 2026-10-25 (random addresses). */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../testdata/universal/${name}.json`, import.meta.url), 'utf8')) as { request?: Record<string, string>; response: unknown };
const SOL_USDC: UniversalToken = { chainId: UNIVERSAL_NETWORKS.solana.chain, kind: 'TOKEN', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC' };
const BASE_USDC: UniversalToken = { chainId: UNIVERSAL_NETWORKS.base.chain, kind: 'TOKEN', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC' };
const ARB_USDC: UniversalToken = { chainId: UNIVERSAL_NETWORKS['arbitrum-one'].chain, kind: 'TOKEN', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6, symbol: 'USDC' };
function http(routes: Record<string, unknown | (() => never)>): UniversalHttp {
  const answer = async (url: string) => {
    const key = Object.keys(routes).find(k => url.includes(k));
    if (!key) throw new Error('UNIVERSAL_PROVIDER_UNAVAILABLE');
    const value = routes[key];
    return typeof value === 'function' ? (value as () => never)() : value;
  };
  return { get: answer, post: answer };
}
const relay = fixture('relay-sol-base'), deadline = (relay.response as { protocol: { v2: { orderData: { output: { deadline: number } } } } }).protocol.v2.orderData.output.deadline;
const now = () => new Date((deadline - 7 * 86_400 + 30) * 1000);

describe('BUILD-CROSSCHAIN-UNIVERSAL-001 route discovery', () => {
  it('Solana USDC → Base USDC: Relay executable (recommended), LI.FI and Mayan live quotes with their reasons, Across has no Solana route', async () => {
    const discovery = createUniversalDiscovery({ now, http: http({ 'api.relay.link/quote': relay.response, 'li.quest': fixture('lifi-routes-sol-base').response,
      'price-api.mayan.finance': fixture('mayan-quote-sol-base').response }) });
    const result = await discovery.discover({ source: UNIVERSAL_NETWORKS.solana, destination: UNIVERSAL_NETWORKS.base, inputToken: SOL_USDC, outputToken: BASE_USDC, amount: '20000000',
      slippageBps: 200, owner: String(relay.request!.user), recipient: String(relay.request!.recipient) });
    expect(result.status).toBe('EXECUTABLE');
    expect(result.candidates[result.recommended!]).toMatchObject({ provider: 'relay', status: 'EXECUTABLE', executableBy: 'UNIVERSAL_ROUTER', minimumOutput: '19574715' });
    const lifi = result.candidates.filter(c => c.provider === 'lifi');
    expect(lifi.length).toBeGreaterThan(2);
    expect(lifi.every(c => c.status === 'LIVE_QUOTE' && c.reason === 'LIFI_BRIDGE_VERIFIER_NOT_IMPLEMENTED')).toBe(true);
    expect(lifi.find(c => c.bridge === 'relaydepository')?.fees.find(f => f.label === 'LIFI Fixed Fee')).toMatchObject({ amount: '50000', included: true, symbol: 'USDC' });
    expect(result.candidates.filter(c => c.provider === 'mayan').map(c => [c.bridge, c.status, c.expectedOutput])).toEqual([['mayan-fast_mctp', 'LIVE_QUOTE', '19987524'],
      ['mayan-mctp', 'LIVE_QUOTE', '18993634']]);
    expect(result.candidates.find(c => c.provider === 'across')).toMatchObject({ status: 'NO_ROUTE', reason: 'ACROSS_NETWORK_UNSUPPORTED' });
  });
  it('quotes on certified pairs still require transaction validation before execution', async () => {
    const lifi = { routes: [{ id: 'route-1', fromChainId: 8453, toChainId: 42161, fromAmount: '10000000', fromToken: BASE_USDC, toToken: ARB_USDC, toAmount: '9990000', toAmountMin: '9990000', steps: [{ tool: 'across', estimate: { executionDuration: 4, feeCosts: [] } }] }] };
    const across = { inputAmount: '10000000', inputToken: { ...BASE_USDC, chainId: 8453 }, outputToken: { ...ARB_USDC, chainId: 42161 }, crossSwapType: 'bridgeableToBridgeable', expectedOutputAmount: '9995000', minOutputAmount: '9995000', expectedFillTime: 2, id: 'q-1' };
    const discovery = createUniversalDiscovery({ http: http({ 'api.relay.link/quote': { __httpStatus: 400, __body: { message: 'No routes found' } }, 'li.quest': lifi, 'app.across.to': across,
      'price-api.mayan.finance': { quotes: [] } }) });
    const result = await discovery.discover({ source: UNIVERSAL_NETWORKS.base, destination: UNIVERSAL_NETWORKS['arbitrum-one'], inputToken: BASE_USDC, outputToken: ARB_USDC,
      amount: '10000000', slippageBps: 50 });
    expect(result.quoteSubjects).toBe('PUBLIC_QUOTE_SUBJECT');
    expect(result.candidates.filter(c => c.status === 'EXECUTABLE').map(c => [c.provider, c.executableBy])).toEqual([]);
    expect(result.candidates.filter(c => c.status === 'LIVE_QUOTE').map(c => c.provider)).toEqual(['across', 'lifi']);
    expect(result.recommended).toBeNull();
    expect(result.candidates.find(c => c.provider === 'relay')).toMatchObject({ status: 'NO_ROUTE', reason: 'RELAY_NO_ROUTE' });
  });
  it('an unreachable provider is TEMPORARILY_UNAVAILABLE; Mayan does not serve Robinhood Chain', async () => {
    const discovery = createUniversalDiscovery({ http: http({}) });
    const result = await discovery.discover({ source: UNIVERSAL_NETWORKS.solana, destination: UNIVERSAL_NETWORKS.robinhood, inputToken: SOL_USDC,
      outputToken: { chainId: UNIVERSAL_NETWORKS.robinhood.chain, kind: 'TOKEN', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, symbol: 'USDG' }, amount: '20000000', slippageBps: 50 });
    expect(result.candidates.map(c => [c.provider, c.status, c.reason])).toEqual([['relay', 'TEMPORARILY_UNAVAILABLE', 'UNIVERSAL_PROVIDER_UNAVAILABLE'],
      ['lifi', 'TEMPORARILY_UNAVAILABLE', 'UNIVERSAL_PROVIDER_UNAVAILABLE'], ['mayan', 'NO_ROUTE', 'MAYAN_NETWORK_UNSUPPORTED'], ['across', 'NO_ROUTE', 'ACROSS_NETWORK_UNSUPPORTED']]);
    expect(result.status).toBe('TEMPORARILY_UNAVAILABLE');
  });
  it('Mayan is asked with the SDK version it serves; a version refusal is availability, never "no route"', async () => {
    const urls: string[] = [];
    const recording = (routes: Record<string, unknown>): UniversalHttp => { const inner = http(routes); return { get: async url => { urls.push(url); return inner.get(url); }, post: inner.post }; };
    const refused = createUniversalDiscovery({ http: recording({ 'price-api.mayan.finance': { __httpStatus: 406, __body: { code: 'SDK_VERSION_TOO_OLD', msg: 'Upgrade sdk' } } }) });
    const result = await refused.discover({ source: UNIVERSAL_NETWORKS.solana, destination: UNIVERSAL_NETWORKS.base, inputToken: SOL_USDC, outputToken: BASE_USDC, amount: '20000000',
      slippageBps: 50 }, ['mayan']);
    expect(result.candidates.map(c => [c.provider, c.status, c.reason])).toEqual([['mayan', 'TEMPORARILY_UNAVAILABLE', 'MAYAN_API_VERSION_REJECTED']]);
    expect(new URL(urls[0]!).searchParams.get('sdkVersion')).toBe('15_3_0');
  });
});

it.each([
  [503, 'No route', 'TEMPORARILY_UNAVAILABLE', 'RELAY_HTTP_503'],
  [401, 'Unauthorized', 'TEMPORARILY_UNAVAILABLE', 'RELAY_HTTP_401'],
  [429, 'No route', 'TEMPORARILY_UNAVAILABLE', 'RELAY_HTTP_429'],
  [400, 'Insufficient liquidity', 'INSUFFICIENT_LIQUIDITY', 'RELAY_INSUFFICIENT_LIQUIDITY'],
  [400, 'Amount is too low', 'BELOW_MINIMUM', 'RELAY_AMOUNT_TOO_LOW'],
  [400, 'Amount is too high', 'ABOVE_MAXIMUM', 'RELAY_AMOUNT_TOO_HIGH'],
  [400, 'No routes found', 'NO_ROUTE', 'RELAY_NO_ROUTE'],
])('provider HTTP %s (%s) has a distinct and honest result', async (status, message, expected, reason) => {
  const d = createUniversalDiscovery({ http: http({ 'api.relay.link': { __httpStatus: status, __body: { message } } }) });
  const result = await d.discover({ source: UNIVERSAL_NETWORKS.solana, destination: UNIVERSAL_NETWORKS.base, inputToken: SOL_USDC, outputToken: BASE_USDC, amount: '1000000', slippageBps: 100 }, ['relay']);
  expect(result.candidates[0]).toMatchObject({ status: expected, reason, executableBy: null });
  expect(result.recommended).toBeNull();
});

it('Mayan token identity includes chain and address, not just matching decimals', async () => {
  const raw = structuredClone(fixture('mayan-quote-sol-base').response) as { quotes: { toToken: { contract: string } }[] };
  raw.quotes.forEach(q => { q.toToken.contract = ARB_USDC.address!; });
  const d = createUniversalDiscovery({ http: http({ 'price-api.mayan.finance': raw }) });
  const result = await d.discover({ source: UNIVERSAL_NETWORKS.solana, destination: UNIVERSAL_NETWORKS.base, inputToken: SOL_USDC, outputToken: BASE_USDC, amount: '20000000', slippageBps: 100 }, ['mayan']);
  expect(result.candidates.every(c => c.status === 'NO_ROUTE' && c.reason === 'MAYAN_OUTPUT_MISMATCH')).toBe(true);
});

it('malformed provider responses cannot claim a quote or execution', async () => {
  const d = createUniversalDiscovery({ http: http({ 'li.quest': {}, 'price-api.mayan.finance': {}, 'app.across.to': {} }) });
  const result = await d.discover({ source: UNIVERSAL_NETWORKS.base, destination: UNIVERSAL_NETWORKS['arbitrum-one'], inputToken: BASE_USDC, outputToken: ARB_USDC, amount: '1000000', slippageBps: 100 }, ['lifi', 'mayan', 'across']);
  expect(result.candidates.every(c => c.status !== 'EXECUTABLE' && c.status !== 'LIVE_QUOTE' && c.executableBy === null)).toBe(true);
});
