// SPDX-License-Identifier: AGPL-3.0-only
/** Production caller → the cloud preview port and its existing verified quote readers, on MOCKED chain/catalog/HTTP seams. No local production runtime is enabled. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type Database } from '@defi-workflow-engine/cloud-runtime';
import { parseArbitrumTokenList, parseEthereumTokenList, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import { createMockedSolanaJupiter, createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { createBackend } from '../../backend/app';
import { createPublicSwapQuoteReader, createPublicTestnetService } from './public-testnet-service';
import { CATALOG_NETWORKS } from './catalog-networks';
import { mockCatalogRuntime, createRobinhoodMockChain, officialCatalog } from './robinhood-mainnet.test-harness';
import { baseCatalog } from './base-mainnet.test-harness';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import { composeStrategy } from '../engine/strategy-engine';
import { readBuildEstimate } from './build-estimate';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import type { cloudPreview } from './flow-runtime';
import type { FlowName } from '../../backend/flows';

const quiet = createLogger({ service: 'swap-preview-test', sink: () => undefined });
const db = { query: async () => { throw Error('PREVIEW_MUST_NOT_TOUCH_DB'); }, close: async () => undefined } as unknown as Database;
const production = { VERCEL: '1', NODE_ENV: 'production', API_BASE_URL: 'https://api.invalid' };
const tokenList = (name: string) => readFileSync(new URL(`../../../../packages/action-registry/test/fixtures/${name}-token-list-fixture.json`, import.meta.url), 'utf8');
const networkCases = [
  { id: 'base', flag: 'BASE', catalog: baseCatalog, stable: 'USDC' },
  { id: 'arbitrum-one', flag: 'ARBITRUM', catalog: () => parseArbitrumTokenList(tokenList('arbitrum'), new Date().toISOString()), stable: 'USDC' },
  { id: 'ethereum', flag: 'ETHEREUM', catalog: () => parseEthereumTokenList(tokenList('ethereum'), new Date().toISOString()), stable: 'USDC' },
  { id: 'robinhood', flag: 'ROBINHOOD', catalog: officialCatalog, stable: 'USDG' },
] as const;
const dirs: string[] = [];
afterEach(() => { resetNetworkCatalogs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function workflow(network: string, inputAsset: string, outputAsset: string) {
  const result = composeStrategy({ action: 'swap', network, inputAsset, outputAsset, amount: '1' });
  if (!result.ok) throw Error(result.code);
  return result.workflow;
}
function evmSetup(c: typeof networkCases[number], reverse = false, pool = true) {
  const catalog = c.catalog() as AssetCatalog, now = Date.now(); registerNetworkCatalog(catalog);
  const chain = createRobinhoodMockChain(catalog, { now: () => now, ...c.id === 'base' ? { network: 'base' as const } : {} });
  const stable = catalog.assets.find(a => a.symbol === c.stable)!, weth = catalog.assets.find(a => a.symbol === 'WETH')!;
  if (pool) chain.addPool(stable.address!, weth.address!, { fee: 3000, liquidity: 10n ** 20n,
    rate: { [stable.address!]: 4n * 10n ** 26n, [weth.address!]: 2_500_000n } });
  const flow = `${c.id === 'arbitrum-one' ? 'arbitrum' : c.id}-swap` as FlowName;
  const reader = createPublicSwapQuoteReader(() => chain.rpc, () => new Date(now), mockCatalogRuntime(catalog));
  const w = workflow(c.id, reverse ? 'WETH' : c.stable, reverse ? c.stable : 'WETH');
  const preview = vi.fn(async (_name: FlowName, args: readonly unknown[], options: Parameters<typeof cloudPreview>[2]) => {
    void options;
    return { ok: true as const, value: { quote: await reader(args[0] as SemanticWorkflow, 'preview-read-only') } };
  });
  return { w, chain, flow, preview, catalog, now };
}

describe('production Swap quote parity through cloudPreview', () => {
  for (const c of networkCases) for (const reverse of [false, true]) it(`${c.id} ${reverse ? 'WETH → stable' : 'stable → WETH'}: verified runtime quote, 100 bps, no wallet, DB or authority`, async () => {
    const s = evmSetup(c, reverse);
    const estimate = await readBuildEstimate({ workflow: s.w, nodeId: s.w.nodes[0]!.nodeId }, production, { preview: s.preview, prices: null });
    expect(estimate).toMatchObject({ ok: true, estimate: { chain: s.w.nodes[0]!.chainId, symbol: reverse ? c.stable : 'WETH', slippageBps: 100, usd: null } });
    expect(s.preview).toHaveBeenCalledOnce(); expect(s.preview.mock.calls[0]![0]).toBe(s.flow);
    expect(s.preview.mock.calls[0]![2]).toMatchObject({ timeoutMs: 30_000, maxAttempts: 1 });
    if (estimate.ok) {
      expect(Number(estimate.estimate.expected)).toBeGreaterThan(0); expect(Number(estimate.estimate.minimum)).toBeLessThan(Number(estimate.estimate.expected));
      for (const key of ['review', 'authorization', 'manifest', 'quote', 'executionId', 'transaction', 'unsignedTransaction']) expect(estimate.estimate).not.toHaveProperty(key);
    }
    expect(s.chain.state.transactions.size).toBe(0);
    // The Build quote grants no authority. Both independent test owners must simulate freshly, review and confirm each wallet request.
    const path = mkdtempSync(join(tmpdir(), 'flofi-swap-production-')); dirs.push(path);
    const service = createPublicTestnetService({ rpc: s.chain.rpc, rpcs: { [s.catalog.chain]: s.chain.rpc }, journalDir: path,
      idPrefix: CATALOG_NETWORKS[c.id].prefixes.swap, now: () => new Date(s.now), catalog: mockCatalogRuntime(s.catalog) });
    const input = s.w.nodes[0]!.inputs.find(i => i.name === 'amount-in');
    if (input?.kind !== 'QUANTITY' || !('address' in input.value.asset)) throw Error('TEST_INPUT_INVALID');
    for (const owner of ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40)]) {
      s.chain.fund(input.value.asset.address, owner, BigInt(input.value.amount) * 10n); s.chain.fundNative(owner, 10n ** 20n);
      const simulated = await service.prepare(s.w as SemanticWorkflow, owner), id = simulated.quote.executionId;
      expect(simulated.attempts).toEqual([]);
      expect(simulated.quote.workflowHash).toBe(estimate.ok ? estimate.estimate.workflowHash : 'BUILD_MUST_SUCCEED');
      await expect(service.begin(id, owner)).rejects.toThrow(/REVIEW_REQUIRED/);
      service.review(id, simulated.quote.manifestHash);
      await expect(service.begin(id, '0x' + '3'.repeat(40))).rejects.toThrow();
      for (let step = 0; step < 2; step++) {
        if (step) { const fresh = await service.refresh(id); service.review(id, fresh.quote.manifestHash); }
        const begin = await service.begin(id, owner);
        service.report(id, begin.attempt.attemptId, { kind: 'HASH', txHash: s.chain.apply(begin.tx) });
        await service.observe(id);
      }
      expect(service.load(id).outcome?.evidence).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
      const count = s.chain.state.transactions.size;
      await expect(service.begin(id, owner)).rejects.toThrow(); expect(s.chain.state.transactions.size).toBe(count);
    }
  });
  it.each([['SOL', 'USDC'], ['USDC', 'SOL'], ['SOL', 'USDT'], ['USDT', 'SOL'], ['USDC', 'USDT'], ['USDT', 'USDC']])('quotes Jupiter %s → %s through the backend with an unfunded independent quote subject, without a balance check or simulation', async (input, output) => {
    const harness = createMockedSolanaJupiter(), owner = createMockedSolanaWallet().owner;
    const methods: string[] = [];
    const backend = createBackend({ db, env: { GRYLOO_JUPITER_HARNESS: 'MOCKED_LOOPBACK_ONLY' }, logger: quiet, tenantId: 'test', holderId: 'quote', evidenceStore: null,
      rpc: { 'jupiter-swap': async (method, args) => { methods.push(method); return harness.rpc(method, args); } }, http: harness.http });
    const w = workflow('solana', input, output);
    const result = await readBuildEstimate({ workflow: w, nodeId: w.nodes[0]!.nodeId, owner }, production, {
      preview: (flow, args, options) => backend.previewFlow(flow, args, options?.purpose), prices: null });
    expect(result).toMatchObject({ ok: true, estimate: { provider: 'Jupiter', symbol: output, slippageBps: 100 } });
    expect(methods).toEqual([]); expect(harness.state.sent).toEqual([]);
  });
  it('a production configuration failure never opens a local RPC or direct provider fallback', async () => {
    const s = evmSetup(networkCases[0]), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const preview = vi.fn(async () => ({ ok: false as const, code: 'CLOUD_RUNTIME_NOT_CONFIGURED' }));
    const result = await readBuildEstimate({ workflow: s.w, nodeId: s.w.nodes[0]!.nodeId }, production, { preview });
    expect(result).toMatchObject({ ok: false, code: 'CLOUD_RUNTIME_NOT_CONFIGURED', reason: 'Quote service is not configured. Contact support.', correlationId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('real lack of a pool remains a pool diagnosis, with no fabricated quote', async () => {
    const s = evmSetup(networkCases[0], false, false);
    expect(await readBuildEstimate({ workflow: s.w, nodeId: s.w.nodes[0]!.nodeId }, production, { preview: s.preview }))
      .toMatchObject({ ok: false, code: 'POOL_UNUSABLE', correlationId: expect.any(String) });
  });
  it('a throwing optional USD source cannot invalidate a verified token quote', async () => {
    const s = evmSetup(networkCases[0]);
    const seams = Object.defineProperty({ preview: s.preview }, 'prices', { get() { throw Error('private-price-url?token=secret'); } });
    expect(await readBuildEstimate({ workflow: s.w, nodeId: s.w.nodes[0]!.nodeId }, production, seams))
      .toMatchObject({ ok: true, estimate: { symbol: 'WETH', usd: null } });
  });
  it.each(['workflowHash', 'inputToken', 'outputToken', 'inputSymbol', 'outputSymbol', 'amountIn', 'slippageBps', 'minimumOut', 'expiresAt'])('rejects a mismatched runtime %s before publishing a financial value', async field => {
    const s = evmSetup(networkCases[0]);
    const preview = async (flow: FlowName, args: readonly unknown[]) => {
      const result = await s.preview(flow, args, {});
      if (!result.ok) return result;
      const value = structuredClone(result.value) as { quote: Record<string, unknown> };
      value.quote[field] = field === 'slippageBps' ? 999 : field === 'minimumOut' ? '1' : 'wrong';
      return { ok: true as const, value };
    };
    const result = await readBuildEstimate({ workflow: s.w, nodeId: s.w.nodes[0]!.nodeId }, production, { preview, prices: null });
    expect(result).toMatchObject({ ok: false, correlationId: expect.any(String) }); expect(result).not.toHaveProperty('estimate');
  });
});
