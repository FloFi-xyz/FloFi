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
import { UNIVERSAL_QUOTE_SUBJECTS, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
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
function workflow(network: string, inputAsset: string, outputAsset: string, amount = '1') {
  const result = composeStrategy({ action: 'swap', network, inputAsset, outputAsset, amount });
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

describe('P0 catalog reliability: a cancelled estimate cancels its preview', () => {
  it('forwards the browser signal to the API preview and reports a cancelled estimate as cancelled, never as a provider answer', async () => {
    const s = evmSetup(networkCases[1]), cancelled = new AbortController();
    const preview = vi.fn(async (_name: FlowName, _args: readonly unknown[], options: Parameters<typeof cloudPreview>[2]) => {
      expect(options?.signal).toBe(cancelled.signal);
      cancelled.abort();
      return { ok: false as const, code: 'CLOUD_API_DEADLINE_EXCEEDED' };
    });
    expect(await readBuildEstimate({ workflow: s.w, nodeId: s.w.nodes[0]!.nodeId }, production, { preview, prices: null, signal: cancelled.signal }))
      .toMatchObject({ ok: false, code: 'ESTIMATE_CANCELLED' });
    expect(preview).toHaveBeenCalledOnce();
  });
  it('a quote that arrives after the browser cancelled is never published as an estimate', async () => {
    const s = evmSetup(networkCases[1]), cancelled = new AbortController();
    s.preview.mockImplementationOnce(async (name, args, options) => { const answer = await s.preview.getMockImplementation()!(name, args, options); cancelled.abort(); return answer; });
    const result = await readBuildEstimate({ workflow: s.w, nodeId: s.w.nodes[0]!.nodeId }, production, { preview: s.preview, prices: null, signal: cancelled.signal });
    expect(result).toMatchObject({ ok: false, code: 'ESTIMATE_CANCELLED' });
  });
});

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
  it.each([['EVM selected', '0x' + '1'.repeat(40)], ['signed out', undefined], ['Solana connected', createMockedSolanaWallet().owner]])(
    'quotes the 5 USDC → SOL incident through the deployed preview contract with %s', async (_scenario, owner) => {
      const harness = createMockedSolanaJupiter();
      const http = vi.fn(harness.http);
      const backend = createBackend({ db, env: { GRYLOO_JUPITER_HARNESS: 'MOCKED_LOOPBACK_ONLY' }, logger: quiet,
        tenantId: 'test', holderId: 'quote', evidenceStore: null, http,
        rpc: { 'jupiter-swap': async () => { throw Error('QUOTE_MUST_NOT_READ_WALLET_STATE'); } } });
      const w = workflow('solana', 'USDC', 'SOL', '5'), nodeId = w.nodes[0]!.nodeId;
      const preview: NonNullable<Parameters<typeof readBuildEstimate>[2]>['preview'] = async (flow, args, options) => {
        const path = '/v1/previews/jupiter-swap', route = backend.routes.find(r => r.name === 'preview')!;
        expect(flow).toBe('jupiter-swap');
        const answer = await route.handler({ method: 'POST', path, query: new URLSearchParams(), headers: {},
          body: { args, purpose: options?.purpose }, requestId: 'incident-regression' }, route.pattern.exec(path)!);
        return answer.body as Awaited<ReturnType<typeof backend.previewFlow>>;
      };
      const result = await readBuildEstimate({ workflow: w, nodeId, owner }, production, { preview, prices: null });
      expect(result).toMatchObject({ ok: true, estimate: { provider: 'Jupiter', symbol: 'SOL', expected: expect.stringMatching(/^[0-9.]+$/) } });
      expect(http).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ amount: '5000000', taker: UNIVERSAL_QUOTE_SUBJECTS.SOLANA }));
      expect(harness.state.sent).toEqual([]);
    });
  it('quotes a mainnet EVM swap with Solana selected without forwarding the Solana address', async () => {
    const s = evmSetup(networkCases[0]), owner = createMockedSolanaWallet().owner;
    expect(await readBuildEstimate({ workflow: s.w, nodeId: s.w.nodes[0]!.nodeId, owner }, production, { preview: s.preview, prices: null }))
      .toMatchObject({ ok: true, estimate: { provider: 'Uniswap V3', symbol: 'WETH' } });
    expect(s.preview.mock.calls[0]![1]).toEqual([s.w]);
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

/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P0-07, T11/T12/T22): production logged `swap.quote_failed ESTIMATE_RESPONSE_INVALID` for every
 * USDC → ETH Arbitrum estimate while the API's `arbitrum-swap` preview returned a real quote: a native ETH side (`nativeId`, no `address`)
 * was refused by the hosted response check. A native side now matches only the runtime's native ETH sentinel, never WETH or another token.
 */
describe('production native ETH swap quotes through cloudPreview', () => {
  const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  function nativeSetup(c: typeof networkCases[number], reverse = false) {
    const s = evmSetup(c);
    const w = workflow(c.id, reverse ? 'ETH' : c.stable, reverse ? c.stable : 'ETH');
    return { ...s, w };
  }
  for (const c of networkCases.filter(n => n.id !== 'robinhood')) for (const reverse of [false, true])
    it(`${c.id} ${reverse ? 'ETH → stable' : 'stable → ETH'}: the verified runtime quote reaches the card`, async () => {
      const s = nativeSetup(c, reverse), output = s.w.nodes[0]!.inputs.find(i => i.name === 'asset-out');
      expect(reverse ? output?.kind === 'ASSET' && 'address' in output.value : output?.kind === 'ASSET' && 'nativeId' in output.value).toBe(true);
      const estimate = await readBuildEstimate({ workflow: s.w, nodeId: s.w.nodes[0]!.nodeId }, production, { preview: s.preview, prices: null });
      expect(estimate).toMatchObject({ ok: true, estimate: { chain: s.w.nodes[0]!.chainId, provider: 'Uniswap V3', symbol: reverse ? c.stable : 'ETH', slippageBps: 100 } });
      if (estimate.ok) expect(Number(estimate.estimate.expected)).toBeGreaterThan(0);
    });
  it.each([['WETH instead of native ETH', 'outputToken'], ['a native sentinel on the token side', 'inputToken']] as const)('refuses %s (no asset substitution)', async (_label, field) => {
    const s = nativeSetup(networkCases[1]), weth = s.catalog.assets.find(a => a.symbol === 'WETH')!.address!;
    const preview = async (flow: FlowName, args: readonly unknown[]) => {
      const result = await s.preview(flow, args, {});
      if (!result.ok) return result;
      const value = structuredClone(result.value) as { quote: Record<string, unknown> };
      value.quote[field] = field === 'outputToken' ? weth : NATIVE;
      return { ok: true as const, value };
    };
    expect(await readBuildEstimate({ workflow: s.w, nodeId: s.w.nodes[0]!.nodeId }, production, { preview, prices: null }))
      .toMatchObject({ ok: false, code: 'ESTIMATE_RESPONSE_MISMATCH' });
  });
});

/**
 * BUILD-FLOFI-MAINNET-BRIDGE-RECONCILIATION-003 (Workstream B): the BFF asks the API for the read-only QUOTE preview first. Vercel and Railway roll
 * independently, so an API that does not offer QUOTE yet (PREVIEW_QUOTE_NOT_AVAILABLE) is asked once more for the verified ownerless SIMULATION
 * preview within what is left of the same time budget — never for any other refusal, and never after the browser cancelled.
 */
describe('production QUOTE preview with the SIMULATION compatibility fallback', () => {
  type Preview = NonNullable<NonNullable<Parameters<typeof readBuildEstimate>[2]>['preview']>;
  /** A preview port that refuses with `codes` first, then (optionally) answers as the verified runtime does. */
  const refusing = (codes: string[], then?: Preview, before?: () => void) => vi.fn<Preview>(async (...args) => {
    before?.();
    const code = codes.shift();
    return code ? { ok: false as const, code } : then ? then(...args) : { ok: false as const, code: 'TEST_PREVIEW_EXHAUSTED' };
  });
  const ask = (s: ReturnType<typeof evmSetup>, preview: Preview, signal?: AbortSignal) =>
    readBuildEstimate({ workflow: s.w, nodeId: s.w.nodes[0]!.nodeId }, production, { preview, prices: null, ...signal ? { signal } : {} });

  it('asks for the QUOTE purpose first and uses its answer', async () => {
    const s = evmSetup(networkCases[2]);
    expect(await ask(s, s.preview)).toMatchObject({ ok: true, estimate: { symbol: 'WETH' } });
    expect(s.preview).toHaveBeenCalledOnce();
    expect(s.preview.mock.calls[0]![2]).toMatchObject({ purpose: 'QUOTE', timeoutMs: 30_000, maxAttempts: 1 });
  });

  it('an API without QUOTE is asked once for SIMULATION within the remaining budget, and its verified quote reaches the card', async () => {
    const s = evmSetup(networkCases[2]), preview = refusing(['PREVIEW_QUOTE_NOT_AVAILABLE'], s.preview);
    expect(await ask(s, preview)).toMatchObject({ ok: true, estimate: { symbol: 'WETH' } });
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview.mock.calls.map(call => call[2]?.purpose)).toEqual(['QUOTE', 'SIMULATION']);
    expect(preview.mock.calls[1]![0]).toBe(s.flow);
    expect(preview.mock.calls[1]![1]).toEqual([s.w]);
    expect(preview.mock.calls[1]![2]!.timeoutMs).toBeGreaterThan(0);
    expect(preview.mock.calls[1]![2]!.timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it.each(['CLOUD_API_DEADLINE_EXCEEDED', 'POOL_UNUSABLE', 'CLOUD_RUNTIME_NOT_CONFIGURED'])('%s is final: no SIMULATION retry', async code => {
    const s = evmSetup(networkCases[2]);
    const preview = refusing([code], s.preview);
    expect(await ask(s, preview)).toMatchObject({ ok: false });
    expect(preview).toHaveBeenCalledOnce();
  });

  it('never falls back after the browser cancelled', async () => {
    const s = evmSetup(networkCases[2]), cancelled = new AbortController();
    const preview = refusing(['PREVIEW_QUOTE_NOT_AVAILABLE'], s.preview, () => cancelled.abort());
    expect(await ask(s, preview, cancelled.signal)).toMatchObject({ ok: false, code: 'ESTIMATE_CANCELLED' });
    expect(preview).toHaveBeenCalledOnce();
  });

  it('with the stream seam the token estimate returns before a slow USD source answers, and USD follows on its own promise', async () => {
    const s = evmSetup(networkCases[2]);
    let answer!: (value: import('../automations/price-source').PriceResult) => void;
    const prices = { id: 'fixture' as const, maxAgeMs: 60_000, assets: ['ETH' as const],
      observe: vi.fn(() => new Promise<import('../automations/price-source').PriceResult>(resolve => { answer = resolve; })) };
    let usd: Promise<unknown> | undefined;
    const result = await readBuildEstimate({ workflow: s.w, nodeId: s.w.nodes[0]!.nodeId }, production,
      { preview: s.preview, prices, onUsd: pending => { usd = pending; } });
    // The price source has not answered: the token estimate is already complete, without USD.
    expect(result).toMatchObject({ ok: true, estimate: { symbol: 'WETH', usd: null } });
    expect(prices.observe).toHaveBeenCalled();
    expect(usd).toBeDefined();
    answer({ ok: true, observation: { asset: 'ETH', priceUsd: '2500', observedAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      source: 'FIXTURE', evidence: 'MOCKED', provenance: {} } });
    expect(await usd).toMatchObject({ output: expect.stringMatching(/^[0-9]+\.[0-9]{2}$/), source: 'FIXTURE', evidence: 'MOCKED' });
  });
});
