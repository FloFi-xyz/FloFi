// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: the Base mainnet runtime — its gates, the token-list loader and the catalog-network registry — and Base transfers on the
 * shared transfer engine (OP Stack L1 fee bound at Review and reconciled from the receipt), against a MOCKED in-memory Base chain. No test
 * reaches a network, signs or sends.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTransferNode, createTokenTransferNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { BASE_TOKEN_LIST, catalogAsset, type AssetCatalog, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { baseMainnetMode, baseOwnerExecutionEnabled, baseRpcUrl, createBaseCatalogLoader } from './base-mainnet';
import { CATALOG_NETWORKS, catalogNetworkOfChain, catalogNetworkOfRun, catalogNetworkOfWorkflow, localCatalogNetworkMode } from './catalog-networks';
import { createRobinhoodTransferService } from './robinhood-transfer-service';
import { createRobinhoodMockChain, type RobinhoodMockChain } from './robinhood-mainnet.test-harness';
import { BASE_TOKEN_LIST_TEXT, baseAsset, baseCatalog } from './base-mainnet.test-harness';

const owner = '0x1111111111111111111111111111111111111111', friend = '0x3333333333333333333333333333333333333333';
const T0 = Date.parse('2026-10-11T03:00:00.000Z');
const ok = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });

describe('BUILD-BASE-001 Base mainnet gates', () => {
  it('is off unless explicitly enabled; the loopback harness always wins; execution needs its own real-funds opt-in', () => {
    expect(baseMainnetMode({})).toBe('off');
    expect(baseMainnetMode({ GRYLOO_BASE_MAINNET: 'true' })).toBe('off');
    expect(baseMainnetMode({ GRYLOO_BASE_MAINNET: 'live' })).toBe('live');
    expect(baseMainnetMode({ GRYLOO_BASE_MAINNET: 'live', GRYLOO_BASE_MAINNET_HARNESS: 'MOCKED_LOOPBACK_ONLY' })).toBe('harness');
    expect(baseOwnerExecutionEnabled('live', { GRYLOO_BASE_MAINNET: 'live' })).toBe(false);
    expect(baseOwnerExecutionEnabled('live', { GRYLOO_BASE_OWNER_EXECUTION: 'yes' })).toBe(false);
    expect(baseOwnerExecutionEnabled('live', { GRYLOO_BASE_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' })).toBe(true);
    expect(baseOwnerExecutionEnabled('off', { GRYLOO_BASE_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' })).toBe(false);
    // The Robinhood approval never enables Base, and the reverse.
    expect(baseOwnerExecutionEnabled('live', { GRYLOO_ROBINHOOD_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' })).toBe(false);
    expect(CATALOG_NETWORKS.robinhood.ownerExecutionEnabled('live', { GRYLOO_BASE_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' })).toBe(false);
    // In-process server actions use a live network only in local development; hosted deployments use the cloud flows.
    expect(localCatalogNetworkMode(CATALOG_NETWORKS.base, { GRYLOO_BASE_MAINNET: 'live', NODE_ENV: 'production' })).toBe('off');
    expect(localCatalogNetworkMode(CATALOG_NETWORKS.base, { GRYLOO_BASE_MAINNET: 'live', NODE_ENV: 'development' })).toBe('live');
  });
  it('accepts only an HTTPS RPC override without credentials', () => {
    expect(baseRpcUrl(undefined)).toBe('https://mainnet.base.org');
    expect(baseRpcUrl('https://base.example/v1')).toBe('https://base.example/v1');
    for (const bad of ['http://base.example', 'https://user:pass@base.example', 'https://base.example/#x', 'not a url'])
      expect(() => baseRpcUrl(bad)).toThrow('BASE_RPC_CONFIGURATION_INVALID');
  });
  it('routes chains, run namespaces and workflows to their catalog network, and nothing else', () => {
    expect(catalogNetworkOfChain('eip155:8453')?.id).toBe('base');
    expect(catalogNetworkOfChain(4663)?.id).toBe('robinhood');
    expect(catalogNetworkOfChain('eip155:84532')).toBeNull();
    for (const [id, capability, network] of [['bas-' + 'a'.repeat(24), 'swap', 'base'], ['bat-' + 'a'.repeat(32), 'transfer', 'base'], ['balp-' + 'a'.repeat(32), 'liquidity', 'base'],
      ['baave-' + 'a'.repeat(32), 'lending', 'base'], ['rhs-' + 'a'.repeat(24), 'swap', 'robinhood']] as const)
      expect(catalogNetworkOfRun(id, capability)?.id).toBe(network);
    expect(catalogNetworkOfRun('pub-' + 'a'.repeat(24), 'swap')).toBeNull();
    expect(catalogNetworkOfRun('baave-' + 'a'.repeat(32), 'swap')).toBeNull();
    expect(catalogNetworkOfWorkflow({ nodes: [{ actionType: 'asset.transfer', chainId: 'eip155:8453' }] }, 'asset.transfer')?.id).toBe('base');
    expect(catalogNetworkOfWorkflow({ nodes: [{ actionType: 'asset.transfer', chainId: 'eip155:46630' }] }, 'asset.transfer')).toBeNull();
  });
});

describe('BUILD-BASE-001 Base token-list loader', () => {
  it('reads the pinned URL once (no redirects, no cache), validates it and shares one read', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const loader = createBaseCatalogLoader({ mode: 'live', now: () => new Date(T0), fetcher: async (url, init) => { calls.push({ url, init }); return ok(BASE_TOKEN_LIST_TEXT); } });
    const [a, b] = await Promise.all([loader('eip155:8453'), loader('eip155:8453')]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: BASE_TOKEN_LIST.url, init: { method: 'GET', cache: 'no-store', redirect: 'error' } });
    expect(catalogAsset(a, { symbol: 'cbbtc' })?.symbol).toBe('cbBTC');
    expect(catalogAsset(a, { symbol: '1INCH' })).toBeNull();
    expect(a.chain).toBe('eip155:8453');
  });
  it.each([
    ['an HTTP error', async () => new Response('nope', { status: 503 }), 'BASE_TOKEN_LIST_UNAVAILABLE'],
    ['a redirect or network failure', async () => { throw new TypeError('redirect'); }, 'BASE_TOKEN_LIST_UNAVAILABLE'],
    ['a declared size above the cap', async () => ok('{}', { 'content-length': String(BASE_TOKEN_LIST.maximumBytes + 1) }), 'BASE_TOKEN_LIST_UNAVAILABLE'],
    ['a body above the cap', async () => ok(' '.repeat(BASE_TOKEN_LIST.maximumBytes + 1)), 'BASE_TOKEN_LIST_UNAVAILABLE'],
    ['a malformed payload', async () => ok('{"tokens": 3}'), /BASE_TOKEN_LIST_/],
  ])('fails closed on %s and never serves a recorded copy', async (_name, fetcher, code) => {
    const loader = createBaseCatalogLoader({ mode: 'live', now: () => new Date(T0), fetcher: fetcher as never });
    await expect(loader('eip155:8453')).rejects.toThrow(code);
  });
  it('refuses another chain, and a failure after the cache expires is not replaced by the older catalog', async () => {
    let clock = T0, fail = false;
    const loader = createBaseCatalogLoader({ mode: 'live', now: () => new Date(clock), ttlMs: 1_000,
      fetcher: async () => fail ? new Response('down', { status: 500 }) : ok(BASE_TOKEN_LIST_TEXT) });
    await expect(loader('eip155:4663')).rejects.toThrow('CATALOG_NETWORK_UNSUPPORTED');
    await loader('eip155:8453');
    fail = true; clock += 2_000;
    await expect(loader('eip155:8453')).rejects.toThrow('BASE_TOKEN_LIST_UNAVAILABLE');
  });
});

describe('BUILD-BASE-001 Base mainnet transfers (OP Stack L1 fee)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  let clock = T0, catalog: AssetCatalog, chain: RobinhoodMockChain, usdc: CanonicalAsset;
  const flow = (node: SemanticWorkflow['nodes'][number]): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, nodes: [node], resourceEdges: [] });
  function service(executionEnabled = true) {
    const dir = mkdtempSync(join(tmpdir(), 'flofi-base-transfer-')); dirs.push(dir);
    return createRobinhoodTransferService({ rpcs: { 'eip155:8453': chain.rpc }, journalDir: dir, provenance: 'MOCKED', idPrefix: 'bat', now: () => clock,
      catalogFor: async () => catalog, executionEnabled });
  }
  beforeEach(() => {
    clock = T0; catalog = baseCatalog(); chain = createRobinhoodMockChain(catalog, { now: () => clock, network: 'base' });
    usdc = baseAsset(catalog, 'USDC');
    chain.fundNative(owner, 10n ** 16n); chain.fund(usdc.address!, owner, 500_000_000n);
  });
  async function execute(s: ReturnType<typeof service>, workflow: SemanticWorkflow, receipt?: (hash: string) => void) {
    const simulated = await s.simulate(workflow, owner);
    await s.review(simulated.id, simulated.review.commitment, workflow);
    const { transaction } = await s.begin(simulated.id, owner, workflow);
    await s.handoff(simulated.id);
    const hash = chain.apply(transaction);
    receipt?.(hash);
    await s.report(simulated.id, { kind: 'HASH', hash });
    await s.observe(simulated.id);
    chain.mine(2);
    return { simulated, transaction, record: await s.observe(simulated.id) };
  }
  it('binds the L1 fee bound at Review and reconciles ETH value + execution fee + l1Fee exactly (bat- runs, MOCKED evidence)', async () => {
    const workflow = flow(createNativeTransferNode('node-002', { chain: 'eip155:8453', amount: '1000000000000000', recipient: friend }));
    const { simulated, transaction, record } = await execute(service(), workflow);
    expect(simulated.id).toMatch(/^bat-[0-9a-f]{32}$/);
    expect(simulated.review).toMatchObject({ chain: 'eip155:8453', recipient: friend, l1FeeUpperBound: '25000000000' });
    expect(transaction).toMatchObject({ from: owner, to: friend, chainId: '0x2105', data: '0x' });
    expect(record).toMatchObject({ verdict: 'RECONCILED', error: null });
    expect(record.evidence!.bundle).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
  });
  it('transfers a catalog ERC-20 (USDC) with the exact transfer call and both balances reconciled', async () => {
    const workflow = flow(createTokenTransferNode('node-002', { chain: 'eip155:8453', amount: '25000000', recipient: friend,
      token: { address: usdc.address!, decimals: 6, officialId: null } }));
    const { transaction, record } = await execute(service(), workflow);
    expect(transaction).toMatchObject({ to: usdc.address, value: '0x0' });
    expect(record).toMatchObject({ verdict: 'RECONCILED' });
    expect(chain.balance(usdc.address!, friend)).toBe(25_000_000n);
  });
  it('does not reconcile a Base receipt that omits l1Fee', async () => {
    const workflow = flow(createNativeTransferNode('node-002', { chain: 'eip155:8453', amount: '1000000000000000', recipient: friend }));
    const { record } = await execute(service(), workflow, hash => { delete (chain.state.receipts.get(hash) as Record<string, unknown>).l1Fee; });
    expect(record.verdict).not.toBe('RECONCILED');
    expect(record.evidence).toBeNull();
  });
  it('refuses begin without GRYLOO_BASE_OWNER_EXECUTION and a token outside the validated list', async () => {
    const s = service(false), workflow = flow(createNativeTransferNode('node-002', { chain: 'eip155:8453', amount: '1000', recipient: friend }));
    const simulated = await s.simulate(workflow, owner);
    await s.review(simulated.id, simulated.review.commitment, workflow);
    await expect(s.begin(simulated.id, owner, workflow)).rejects.toThrow('OWNER_EXECUTION_NOT_ENABLED');
    const unlisted = flow(createTokenTransferNode('node-002', { chain: 'eip155:8453', amount: '1', recipient: friend,
      token: { address: '0x' + 'ab'.repeat(20), decimals: 18, officialId: null } }));
    await expect(service().simulate(unlisted, owner)).rejects.toThrow();
  });
});
