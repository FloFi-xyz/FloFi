// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the Base mainnet position-management browser harness (e2e/base-mainnet-serve.ts `/__harness/uniswap`), proven
 * without a browser. The MOCKED Base Uniswap v3 chain the loopback serves (catalog USDC/WETH 0.05%, positions opened outside FloFi) is discovered
 * exactly as the Dashboard discovers it, and managed by a liquidity runtime configured exactly as the in-process MOCKED harness action configures
 * it (synthetic pins, the Base liquidity read allowlist). The real verified pins never accept the synthetic code. The serve's `/rpc` never takes a
 * transaction: only its scripted owner wallet sends. Loopback only (an ephemeral 127.0.0.1 port); no public network, no key; MOCKED evidence.
 */
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE_BASE_ASSETS } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { decodeUniswapMulticall } from '@defi-workflow-engine/reference-compiler';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { BASE_POSITION_POOL, createBaseMainnetHarness, createBasePositionChain } from '../../e2e/base-mainnet-serve';
import type { UniswapLiquidityChain } from '../../e2e/uniswap-liquidity-harness';
import { editorReducer, initialEditor } from '../domain/editor';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import type { LiquidityPositionChoice, LiquidityPositionView } from '../domain/liquidity-positions';
import { baseCatalog } from './base-mainnet.test-harness';
import { BASE_LIQUIDITY_RPC_METHODS } from './base-mainnet';
import { POSITION_EVM_METHODS, uniswapPositions, UNISWAP_POSITION_DEPLOYMENTS } from './defi-positions-evm';
import type { Rpc } from './public-testnet-service';
import { createUniswapLiquidityService } from './uniswap-liquidity-service';
import { UNI_MOCK_CATALOG_PINS, UNI_MOCK_CODE_PINS } from './uniswap-liquidity-mock';

const OWNER = '0x7777777777777777777777777777777777777777';
const catalog = baseCatalog();
/** Two positions opened elsewhere: one in range with recorded owed tokens and fees accrued since, one out of range (ticks below the pool's). */
const SEEDED = [{ tickLower: -197_000, tickUpper: -195_500, liquidity: '1000000000000000', owed0: '1000000000000000', owed1: '3000000', fees0: '2100000000000000', fees1: '6500000' },
  { tickLower: -199_000, tickUpper: -198_000, liquidity: '400000000000000' }];
/** Only the methods the app's chain-bound clients allow (any other method fails as the real allowlist would). */
const allowed = (chain: UniswapLiquidityChain, methods: readonly string[]): Rpc => async (method, params) => {
  if (!methods.includes(method)) throw new Error('PUBLIC_RPC_METHOD_DENIED');
  return chain.rpc(method, params);
};
beforeAll(() => registerNetworkCatalog(catalog));
afterAll(() => resetNetworkCatalogs());

function authored(view: LiquidityPositionView, operation: LiquidityPositionChoice['operation'], partBps: number | null, close: boolean): SemanticWorkflow {
  const choice: LiquidityPositionChoice = { position: view.ref, operation, partBps, close };
  const result = editorReducer(initialEditor(), { type: 'MANAGE_LIQUIDITY_POSITION', choice, pool: { token0: view.token0, token1: view.token1, feeTier: view.feeTier,
    tickLower: view.tickLower, tickUpper: view.tickUpper, amount0: view.principal[0]!, amount1: view.principal[1]!, slippageBps: 100 }, source: 'CANVAS', baseRevision: 0 },
  createBaseSepoliaReviewContext());
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
}
async function discover(chain: UniswapLiquidityChain) {
  return uniswapPositions(allowed(chain, POSITION_EVM_METHODS), UNISWAP_POSITION_DEPLOYMENTS.base, OWNER, chain.clock(), BASE_BASE_ASSETS.assets,
    asset => ({ ...asset, valuation: null }), false, { network: 'Base', catalog });
}
/** The runtime exactly as `src/app/uniswap-liquidity-action.ts` builds it in MOCKED harness mode. */
async function harnessRuntime(chain: UniswapLiquidityChain, pins: 'synthetic' | 'verified' = 'synthetic') {
  const storage = createFileExecutionStorage(join(await mkdtemp(join(tmpdir(), 'flofi-base-position-harness-')), 'liquidity'), 'UNISWAP_LIQUIDITY_BUSY');
  return createUniswapLiquidityService({ storage, rpc: async () => { throw new Error('UNISWAP_NETWORK_UNAVAILABLE'); },
    rpcs: { 'eip155:8453': allowed(chain, BASE_LIQUIDITY_RPC_METHODS) }, provenance: 'MOCKED', executionEnabled: true,
    catalog: { chain: 'eip155:8453', catalogFor: async () => catalog, ...pins === 'synthetic' ? { codePins: UNI_MOCK_CATALOG_PINS } : {} },
    ...pins === 'synthetic' ? { mockedCodePins: UNI_MOCK_CODE_PINS } : {}, now: chain.clock });
}

describe('BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 Base position-management browser harness (MOCKED loopback)', () => {
  it('the Dashboard discovery reads the seeded positions with every fact and capability, through the discovery read allowlist', async () => {
    const { chain, tokenIds } = createBasePositionChain(OWNER, SEEDED);
    const scan = await discover(chain);
    expect(scan.status).toBe('COMPLETE');
    expect(scan.positions.map(p => p.id)).toEqual(tokenIds);
    const open = scan.positions[0]!.liquidity!, below = scan.positions[1]!.liquidity!;
    expect(open).toMatchObject({ ref: { protocol: 'UNISWAP_V3', chain: 'eip155:8453', network: 'Base', pool: BASE_POSITION_POOL.pool, positionId: tokenIds[0], owner: OWNER },
      token0: { symbol: 'WETH' }, token1: { symbol: 'USDC' }, feeTier: 500, rangeState: 'IN_RANGE', status: 'OPEN', manageable: { ok: true },
      recordedOwed: ['1000000000000000', '3000000'],
      // What a collect pays now includes the fees accrued since the last checkpoint (never the stale record alone).
      collectable: ['3100000000000000', '9500000'] });
    expect(open.operations).toEqual(expect.arrayContaining(['COLLECT', 'DECREASE', 'EXIT']));
    expect(open.principal.every(amount => amount !== null && BigInt(amount) > 0n)).toBe(true);
    // The quote orientation is token0 per token1 (a lower tick is a higher quote price): ticks below the pool's read "above range".
    expect(below).toMatchObject({ rangeState: 'ABOVE_RANGE', status: 'OPEN', manageable: { ok: true } });
    expect(chain.counters.sends).toBe(0);
  });

  it('the in-process MOCKED harness runtime manages a discovered position end to end: one Position Manager request, reconciled', async () => {
    const { chain, tokenIds } = createBasePositionChain(OWNER, SEEDED);
    const view = (await discover(chain)).positions[0]!.liquidity!, service = await harnessRuntime(chain);
    const workflow = authored(view, 'DECREASE', 5_000, false);
    const run = await service.positionSimulate(workflow, OWNER, { operation: 'DECREASE', tokenId: tokenIds[0]!, partBps: 5_000, close: false });
    expect(run).toMatchObject({ provenance: 'MOCKED', verdict: 'PENDING', authorization: null, review: { chainId: 8453, network: 'Base', liquidityToRemove: '500000000000000' } });
    expect(run.id).toMatch(/^balp-[a-f0-9]{32}$/);
    await service.positionReview(run.id, run.review.commitment, workflow);
    const begun = await service.positionBegin(run.id, OWNER, workflow);
    expect(begun.transaction).toMatchObject({ from: OWNER, to: BASE_POSITION_POOL.positionManager, chainId: '0x2105', value: '0x0' });
    expect(decodeUniswapMulticall(begun.transaction.data).length).toBeGreaterThanOrEqual(2);
    await service.positionHandoff(run.id);
    await service.positionReport(run.id, { kind: 'HASH', hash: chain.wallet.send(begun.transaction) });
    const done = await service.positionObserve(run.id);
    expect(done).toMatchObject({ verdict: 'RECONCILED', result: { liquidityRemoved: '500000000000000', liquidityAfter: '500000000000000', burned: false } });
    expect(chain.counters.sends).toBe(1);
    expect(chain.snapshot.positions[tokenIds[0]!]!.liquidity).toBe(500_000_000_000_000n);
  });

  it('the verified (public) pins never accept the synthetic harness code', async () => {
    const { chain, tokenIds } = createBasePositionChain(OWNER, SEEDED);
    const view = (await discover(chain)).positions[0]!.liquidity!, service = await harnessRuntime(chain, 'verified');
    await expect(service.positionSimulate(authored(view, 'COLLECT', null, false), OWNER, { operation: 'COLLECT', tokenId: tokenIds[0]!, partBps: null, close: false }))
      .rejects.toThrow(/UNISWAP_UNEXPECTED_CONTRACT|TOKEN_DEPLOYMENT_MISMATCH/);
    expect(chain.counters.sends).toBe(0);
  });

  it('refuses malformed seeds (owner, ticks off the spacing, zero liquidity)', () => {
    expect(() => createBasePositionChain('not-an-address', SEEDED)).toThrow('MOCK_CONTROL_DENIED');
    expect(() => createBasePositionChain(OWNER, [{ ...SEEDED[0], tickLower: -197_005 }])).toThrow('MOCK_CONTROL_DENIED');
    expect(() => createBasePositionChain(OWNER, [{ ...SEEDED[0], liquidity: '0' }])).toThrow('MOCK_CONTROL_DENIED');
  });
});

describe('the loopback serve (ephemeral 127.0.0.1 port)', () => {
  let server: ReturnType<typeof createBaseMainnetHarness> | null = null;
  afterEach(async () => { await new Promise(resolve => server ? server.close(resolve) : resolve(undefined)); server = null; });
  it('routes /rpc to the position chain, never accepts a transaction there, and sends only through its scripted owner wallet control', async () => {
    server = createBaseMainnetHarness();
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown) => (await fetch(origin + path, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;
    expect((await fetch(`${origin}/rpc`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }) })).status).toBe(503);
    const reset = await post('/__harness/uniswap', { action: 'reset', owner: OWNER, positions: SEEDED });
    expect(reset.result).toMatchObject({ tokenIds: ['9001', '9002'], pool: BASE_POSITION_POOL.pool, positionManager: BASE_POSITION_POOL.positionManager });
    expect(await post('/rpc', { jsonrpc: '2.0', id: 1, method: 'eth_chainId' })).toMatchObject({ result: '0x2105' });
    expect(await post('/rpc', { jsonrpc: '2.0', id: 2, method: 'eth_sendRawTransaction', params: ['0x02'] })).toMatchObject({ error: { message: 'MOCK_SEND_FORBIDDEN_USE_WALLET' } });
    expect(await post('/__harness/uniswap', { action: 'sends' })).toEqual({ result: 0 });
    expect(await post('/__harness/uniswap', { action: 'position', tokenId: '9001' })).toMatchObject({ result: { owner: OWNER, liquidity: '1000000000000000', pending0: '2100000000000000' } });
    expect(await post('/__harness/uniswap', { action: 'reset', owner: 'nobody', positions: [] })).toMatchObject({ error: 'MOCK_CONTROL_DENIED' });
    // A chain reset (the Base authoring harness) leaves the position mode.
    expect(await post('/__harness/chain', { action: 'reset' })).toEqual({ result: true });
    expect(await post('/__harness/uniswap', { action: 'sends' })).toMatchObject({ error: 'MOCK_CONTROL_DENIED', reason: 'MOCK_CHAIN_NOT_STARTED' });
  });
});
