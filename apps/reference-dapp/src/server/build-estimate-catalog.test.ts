// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ARB-001 Phase 7, UX-007: catalog-network live quotes (Base, Arbitrum One, Robinhood Chain) go through the one shared read-only
 * swap quote reader, under each network's own gate. MOCKED loopback chain and catalog only; no provider, wallet or Review is involved.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCatalogSwapNode, hashArtifactBytes, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { parseArbitrumTokenList, UNISWAP_V3_ARBITRUM, type AssetCatalog, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { readBuildEstimate } from './build-estimate';
import { asset as rhAsset, createRobinhoodMockChain, mockCatalogRuntime, officialCatalog } from './robinhood-mainnet.test-harness';
import { baseAsset, baseCatalog } from './base-mainnet.test-harness';
import type { PriceResult, PriceSource } from '../automations/price-source';

type Case = { name: string; chain: string; env: Record<string, string>; catalog: () => AssetCatalog; network?: 'base';
  pair: (catalog: AssetCatalog) => [CanonicalAsset, CanonicalAsset]; rate: (input: string, output: string) => Record<string, bigint>; amount: string; expected: string };
const arbitrumBytes = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8');
const CASES: readonly Case[] = [
  { name: 'Arbitrum One USDC → WETH', chain: 'eip155:42161', env: { GRYLOO_ARBITRUM_MAINNET: 'live', NODE_ENV: 'development' },
    catalog: () => parseArbitrumTokenList(arbitrumBytes, '2026-10-11T22:06:20.000Z'),
    pair: c => [c.assets.find(a => a.address === UNISWAP_V3_ARBITRUM.usdc)!, c.assets.find(a => a.address === UNISWAP_V3_ARBITRUM.weth)!],
    rate: (i, o) => ({ [i]: 4n * 10n ** 26n, [o]: 2_500_000n }), amount: '10000000', expected: '0.004' },
  { name: 'Base USDC → cbBTC (catalog pair)', chain: 'eip155:8453', env: { GRYLOO_BASE_MAINNET: 'live', NODE_ENV: 'development' }, catalog: baseCatalog, network: 'base',
    pair: c => [baseAsset(c, 'USDC'), baseAsset(c, 'cbBTC')], rate: (i, o) => ({ [i]: 1_000_000_000_000_000n, [o]: 10n ** 21n }), amount: '100000000', expected: '0.001' },
  { name: 'Robinhood Chain USDG → TSLA (Stock Token)', chain: 'eip155:4663', env: { GRYLOO_ROBINHOOD_MAINNET: 'live', NODE_ENV: 'development' }, catalog: officialCatalog,
    pair: c => [rhAsset(c, 'USDG'), rhAsset(c, 'TSLA')], rate: (i, o) => ({ [i]: 2_600_000_000_000_000_000_000_000_000n, [o]: 384_000_000n }), amount: '10000000', expected: '' },
];
const T0 = Date.parse('2026-10-11T22:06:20.000Z');
function setup(c: Case, pool = true) {
  const catalog = c.catalog(), chain = createRobinhoodMockChain(catalog, { now: () => T0, ...c.network ? { network: c.network } : {} });
  const [input, output] = c.pair(catalog);
  if (pool) chain.addPool(input.address!, output.address!, { fee: 3000, liquidity: 10n ** 20n, rate: c.rate(input.address!, output.address!) });
  const node = createCatalogSwapNode('node-002', { chain: c.chain, amount: c.amount, slippageBps: 50,
    input: { chain: c.chain, address: input.address!, decimals: input.decimals, officialId: input.stock?.officialId ?? null },
    output: { chain: c.chain, address: output.address!, decimals: output.decimals, officialId: output.stock?.officialId ?? null } });
  const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, nodes: [node], resourceEdges: [] };
  return { workflow, output, seams: { rpc: chain.rpc, catalog: mockCatalogRuntime(catalog), now: () => new Date(T0) } };
}

describe('UX-007 shared catalog-network live quote', () => {
  it.each(CASES)('$name: the shared reader quotes this exact snapshot, estimation only', async c => {
    const { workflow, output, seams } = setup(c);
    const result = await readBuildEstimate({ workflow, nodeId: 'node-002', owner: '0x1111111111111111111111111111111111111111' }, c.env, seams);
    expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) return;
    expect(result.estimate).toMatchObject({ workflowHash: hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow))), nodeId: 'node-002',
      chain: c.chain, provider: 'Uniswap V3', symbol: output.symbol, slippageBps: 50 });
    if (c.expected) expect(result.estimate.expected).toBe(c.expected);
    expect(Number(result.estimate.minimum)).toBeLessThan(Number(result.estimate.expected));
    expect(Date.parse(result.estimate.expiresAt)).toBeGreaterThan(T0);
    // A presentation estimate only: no Review, calldata, approval, owner binding or execution identity.
    expect(Object.keys(result.estimate).sort()).toEqual(['chain', 'expected', 'expiresAt', 'minimum', 'nodeId', 'provider', 'slippageBps', 'symbol', 'usd', 'workflowHash']);
    // BUILD-FIX-UX-001: no price source is configured here, so there is no USD figure (never a fabricated one).
    expect(result.estimate.usd).toBeNull();
  });
  it.each(CASES)('$name: the network gate off gives no estimate, before any read', async c => {
    const { workflow, seams } = setup(c);
    let reads = 0;
    const result = await readBuildEstimate({ workflow, nodeId: 'node-002' }, {}, { ...seams, rpc: async (method, params) => { reads++; return seams.rpc(method, params); } });
    expect(result).toMatchObject({ ok: false, code: 'ESTIMATE_NETWORK_NOT_ENABLED', correlationId: expect.any(String) }); expect(reads).toBe(0);
  });
  it.each(CASES)('$name: no usable route is reported as unavailable, never a guessed number', async c => {
    const { workflow, seams } = setup(c, false);
    expect(await readBuildEstimate({ workflow, nodeId: 'node-002' }, c.env, seams)).toMatchObject({ ok: false, code: 'POOL_UNUSABLE', correlationId: expect.any(String) });
  });

  // BUILD-FIX-UX-001: USD equivalents come only from the deployment's verified price source, for an asset that has a feed.
  const priced = (result: PriceResult, calls: string[] = []): PriceSource => ({ id: 'chainlink', maxAgeMs: 3_600_000, assets: ['ETH', 'BTC', 'SOL'],
    observe: async asset => { calls.push(asset); return result; } });
  const ethAt = (priceUsd: string): PriceResult => ({ ok: true, observation: { asset: 'ETH', priceUsd, observedAt: new Date(T0 - 60_000).toISOString(),
    receivedAt: new Date(T0).toISOString(), source: 'CHAINLINK', evidence: 'PUBLIC_READ_ONLY', provenance: { network: 'base', chainId: 8453 } } });
  const arbitrum = CASES.find(c => c.chain === 'eip155:42161')!;
  it('values the WETH output at the fresh ETH/USD price and gives USDC (no verified feed) no figure', async () => {
    const { workflow, seams } = setup(arbitrum), calls: string[] = [];
    const result = await readBuildEstimate({ workflow, nodeId: 'node-002' }, arbitrum.env, { ...seams, prices: priced(ethAt('2500.5'), calls) });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(calls).toEqual(['ETH']);
    expect(result.estimate.usd).toMatchObject({ input: null, source: 'CHAINLINK', evidence: 'PUBLIC_READ_ONLY', observedAt: new Date(T0 - 60_000).toISOString() });
    const usd = Number(result.estimate.usd!.output), expected = Number(result.estimate.expected) * 2500.5;
    expect(Math.abs(usd - expected)).toBeLessThanOrEqual(Math.max(0.01, expected * 0.001));
  });
  it.each([{ ok: false, code: 'PRICE_STALE' }, { ok: false, code: 'PRICE_SOURCE_TIMEOUT' }] as const)('a $code observation gives no USD figure, and the token estimate is unchanged', async failure => {
    const { workflow, seams } = setup(arbitrum);
    const plain = await readBuildEstimate({ workflow, nodeId: 'node-002' }, arbitrum.env, { ...seams, prices: null });
    const result = await readBuildEstimate({ workflow, nodeId: 'node-002' }, arbitrum.env, { ...seams, prices: priced(failure) });
    expect(result).toEqual(plain); expect(result.ok && result.estimate.usd).toBeNull();
  });
});
