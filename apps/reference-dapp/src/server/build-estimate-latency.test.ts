// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BETA-UX-INTELLIGENCE-001 (WS03): the FloFi-controlled part of time-to-first-quote on a catalog network. MOCKED loopback chain and
 * catalog; the chain (provider) answers after a controlled delay and the verified price source after another. Measures only what FloFi's own
 * code adds around the provider: before this build, a price source slower than the quote held the token estimate for up to 2.5 s more.
 * The printed medians are local engineering evidence, not production latency.
 */
import { describe, expect, it } from 'vitest';
import { createCatalogSwapNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { parseArbitrumTokenList, UNISWAP_V3_ARBITRUM } from '@defi-workflow-engine/action-registry';
import { readFileSync } from 'node:fs';
import { readBuildEstimate } from './build-estimate';
import { createRobinhoodMockChain, mockCatalogRuntime } from './robinhood-mainnet.test-harness';
import type { PriceResult, PriceSource } from '../automations/price-source';

const T0 = Date.parse('2026-10-11T22:06:20.000Z');
const bytes = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8');
const ENV = { GRYLOO_ARBITRUM_MAINNET: 'live', NODE_ENV: 'development' };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function setup(rpcDelayMs: number) {
  const catalog = parseArbitrumTokenList(bytes, '2026-10-11T22:06:20.000Z'), chain = createRobinhoodMockChain(catalog, { now: () => T0 });
  const input = catalog.assets.find(a => a.address === UNISWAP_V3_ARBITRUM.usdc)!, output = catalog.assets.find(a => a.address === UNISWAP_V3_ARBITRUM.weth)!;
  chain.addPool(input.address!, output.address!, { fee: 3000, liquidity: 10n ** 20n, rate: { [input.address!]: 4n * 10n ** 26n, [output.address!]: 2_500_000n } });
  const node = createCatalogSwapNode('node-002', { chain: 'eip155:42161', amount: '10000000', slippageBps: 50,
    input: { chain: 'eip155:42161', address: input.address!, decimals: input.decimals, officialId: null },
    output: { chain: 'eip155:42161', address: output.address!, decimals: output.decimals, officialId: null } });
  const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, nodes: [node], resourceEdges: [] };
  // The provider: one controlled delay before its first answer (one quote's network round trip), then the mocked chain.
  let delayed = false;
  const rpc: typeof chain.rpc = async (method, params) => { if (!delayed) { delayed = true; await sleep(rpcDelayMs); } return chain.rpc(method, params); };
  return { workflow, seams: { rpc, catalog: mockCatalogRuntime(catalog), now: () => new Date(T0) } };
}
const ethAt = (priceUsd: string): PriceResult => ({ ok: true, observation: { asset: 'ETH', priceUsd, observedAt: new Date(T0 - 60_000).toISOString(),
  receivedAt: new Date(T0).toISOString(), source: 'CHAINLINK', evidence: 'PUBLIC_READ_ONLY', provenance: { network: 'base', chainId: 8453 } } });
const prices = (delayMs: number): PriceSource => ({ id: 'chainlink', maxAgeMs: 3_600_000, assets: ['ETH', 'BTC', 'SOL'], observe: async () => { await sleep(delayMs); return ethAt('2500.5'); } });
const quantile = (values: readonly number[], q: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!; };
async function sample(rpcDelayMs: number, priceDelayMs: number) {
  const { workflow, seams } = setup(rpcDelayMs);
  const started = performance.now();
  const result = await readBuildEstimate({ workflow, nodeId: 'node-002' }, ENV, { ...seams, prices: prices(priceDelayMs) });
  return { ms: performance.now() - started, ok: result.ok, usd: result.ok ? result.estimate.usd !== null : false };
}

describe('WS03 time to first quote (FloFi-controlled latency, controlled provider delays)', () => {
  it('a slow price source no longer holds the token estimate after the quote is ready', async () => {
    // One discarded warm-up (first-call schema compilation and reader construction are not what is measured; infrastructure-ci review).
    await sample(80, 0);
    const runs: { ms: number; ok: boolean; priceDelayMs: number }[] = [];
    // Provider 80–160 ms, price source 1.2–1.6 s (slower than the quote): same conditions before and after.
    for (let i = 0; i < 12; i++) { const priceDelayMs = 1_200 + (i % 4) * 100; runs.push({ ...await sample(80 + (i % 5) * 20, priceDelayMs), priceDelayMs }); }
    const times = runs.map(run => run.ms);
    // Printed only (local engineering evidence); the assertion below is relative to each run's own price delay, not a wall-clock percentile.
    console.info(JSON.stringify({ benchmark: 'ws03-slow-price', samples: runs.length, medianMs: Math.round(quantile(times, 0.5)), maxMs: Math.round(Math.max(...times)) }));
    expect(runs.every(run => run.ok)).toBe(true);
    // Before this build every run waited for the price source (≥ its delay); now each answers before it — the provider plus ≤ 300 ms grace.
    for (const run of runs) expect(run.ms).toBeLessThan(run.priceDelayMs);
  }, 60_000);
  it('a price source that answers in time still gives the USD figure (no regression)', async () => {
    const runs: { ms: number; usd: boolean }[] = [];
    for (let i = 0; i < 6; i++) runs.push(await sample(150, 40 + i * 10));
    console.info(JSON.stringify({ benchmark: 'ws03-fast-price', samples: runs.length, medianMs: Math.round(quantile(runs.map(run => run.ms), 0.5)), usd: runs.filter(run => run.usd).length }));
    expect(runs.every(run => run.usd)).toBe(true);
  }, 60_000);
});
