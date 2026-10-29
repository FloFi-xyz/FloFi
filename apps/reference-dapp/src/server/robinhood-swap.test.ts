// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: Robinhood Chain mainnet catalog swaps on the shared Uniswap swap service, against a MOCKED in-memory chain
 * and the official Stock Token catalog captured read-only. No test reaches a network, signs or sends: the "wallet" below is
 * the mock chain applying the exact reviewed transaction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalogSwapNode, hashArtifactBytes, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { UNISWAP_V3_ROBINHOOD as UNI, uniswapV3PoolAddress, type AssetCatalog, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { validateAuthoringWorkflow, createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createPublicTestnetService, type PublicTestnetService } from './public-testnet-service';
import { asset, createRobinhoodMockChain, MOCK_CODE, mockCatalogRuntime, OFFICIAL_REGISTRY_TEXT, officialCatalog, type RobinhoodMockChain } from './robinhood-mainnet.test-harness';
import { editorReducer, initialEditor } from '../domain/editor';

const owner = '0x1111111111111111111111111111111111111111';
const T0 = Date.parse('2026-10-11T03:00:00.000Z');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

export function catalogSwapWorkflow(input: CanonicalAsset, output: CanonicalAsset, amount: string, slippageBps = 50, revision = 1): SemanticWorkflow {
  const node = createCatalogSwapNode('node-002', { chain: 'eip155:4663', amount, slippageBps,
    input: { chain: input.chain, address: input.address!, decimals: input.decimals, officialId: input.stock?.officialId ?? null },
    output: { chain: output.chain, address: output.address!, decimals: output.decimals, officialId: output.stock?.officialId ?? null } });
  return { schemaVersion: '1.0.0', workflowId: 'workflow-local', revision, nodes: [node], resourceEdges: [] };
}

let clock = T0, catalog: AssetCatalog, chain: RobinhoodMockChain, usdg: CanonicalAsset, tsla: CanonicalAsset, pltr: CanonicalAsset;
function service(options: { executionEnabled?: boolean; catalogFor?: () => Promise<AssetCatalog> } = {}): PublicTestnetService {
  const dir = mkdtempSync(join(tmpdir(), 'flofi-rh-swap-')); dirs.push(dir);
  return createPublicTestnetService({ rpc: async () => { throw new Error('PUBLIC_NETWORK_UNAVAILABLE'); }, rpcs: { 'eip155:4663': chain.rpc },
    journalDir: dir, idPrefix: 'rhs', now: () => new Date(clock), catalog: mockCatalogRuntime(options.catalogFor ?? catalog, options.executionEnabled ?? true) });
}
beforeEach(() => {
  clock = T0;
  catalog = officialCatalog();
  chain = createRobinhoodMockChain(catalog, { now: () => clock });
  usdg = asset(catalog, 'USDG'); tsla = asset(catalog, 'TSLA'); pltr = asset(catalog, 'PLTR');
  // 100 USDG (1e8 units) → 0.26 TSLA on the 0.3% pool; the 0.05% pool quotes slightly less and the 1% pool has no liquidity.
  chain.addPool(usdg.address!, tsla.address!, { fee: 3000, liquidity: 10n ** 20n, rate: { [usdg.address!]: 2_600_000_000_000_000_000_000_000_000n, [tsla.address!]: 384_000_000n } });
  chain.addPool(usdg.address!, tsla.address!, { fee: 500, liquidity: 10n ** 19n, rate: { [usdg.address!]: 2_590_000_000_000_000_000_000_000_000n, [tsla.address!]: 383_000_000n } });
  chain.addPool(usdg.address!, tsla.address!, { fee: 10000, liquidity: 0n, rate: { [usdg.address!]: 1n, [tsla.address!]: 1n } });
  chain.addPool(usdg.address!, pltr.address!, { fee: 3000, liquidity: 10n ** 20n, rate: { [usdg.address!]: 5_000_000_000_000_000_000_000_000_000n, [pltr.address!]: 199_000_000n } });
  chain.fund(usdg.address!, owner, 1_000_000_000n);
  chain.fundNative(owner, 10n ** 17n);
});

describe('Robinhood Chain catalog swap: Simulate and Review', () => {
  it('quotes USDG → TSLA on the best live canonical pool and binds identity, multiplier and provenance', async () => {
    const run = await service().prepare(catalogSwapWorkflow(usdg, tsla, '100000000'));
    const q = run.quote;
    expect(q.executionId).toMatch(/^rhs-[0-9a-f]{24}$/);
    expect(q).toMatchObject({ chainId: 4663, inputToken: usdg.address, outputToken: tsla.address, inputSymbol: 'USDG', outputSymbol: 'TSLA',
      inputDecimals: 6, outputDecimals: 18, amountIn: '100000000', expectedOut: '260000000000000000', minimumOut: '258700000000000000', slippageBps: 50,
      fee: 3000, pool: uniswapV3PoolAddress(UNI.factory, UNI.poolInitCodeHash, usdg.address!, tsla.address!, 3000), environment: 'MAINNET', provenance: 'MOCKED' });
    expect(q.feeTiers!.map(t => [t.fee, t.expectedOut])).toEqual([[100, null], [500, '259000000000000000'], [3000, '260000000000000000'], [10000, null]]);
    expect(q.stocks).toEqual([expect.objectContaining({ side: 'output', symbol: 'TSLA', officialId: tsla.stock!.officialId, multiplierWad: '1000000000000000000',
      registryMultiplierWad: '1000000000000000000', scheduledEffectiveAt: 0 })]);
    expect(Date.parse(q.expiresAt) - Date.parse(q.observedAt)).toBe(60_000);
    expect(q.workflowHash).toBe(hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(run.workflow))));
  });
  it('quotes a non-featured Stock Token (PLTR) through the same catalog, IR and service', async () => {
    const q = (await service().prepare(catalogSwapWorkflow(usdg, pltr, '10000000'))).quote;
    expect(q).toMatchObject({ outputSymbol: 'PLTR', outputToken: pltr.address, fee: 3000, expectedOut: '50000000000000000' });
    expect(q.stocks?.[0]?.officialId).toBe(pltr.stock!.officialId);
  });
  it('binds a non-1.0 multiplier (AAPL) and shows it as shares per token', async () => {
    const aapl = asset(catalog, 'AAPL');
    chain.addPool(usdg.address!, aapl.address!, { fee: 500, liquidity: 10n ** 20n, rate: { [usdg.address!]: 4_000_000_000_000_000_000_000_000n, [aapl.address!]: 1n } });
    const q = (await service().prepare(catalogSwapWorkflow(usdg, aapl, '1000000'))).quote;
    expect(q.stocks?.[0]).toMatchObject({ symbol: 'AAPL', multiplierWad: '1000566080061092436', registryMultiplierWad: '1000566080061092436' });
  });
  it.each([
    ['the registry is unavailable', () => ({ catalogFor: async () => { throw new Error('STOCK_REGISTRY_UNAVAILABLE'); } }), 'STOCK_REGISTRY_UNAVAILABLE'],
    ['the registry now maps TSLA to another contract', () => { const changed = JSON.parse(OFFICIAL_REGISTRY_TEXT) as { assets: Record<string, unknown>[] };
      const index = changed.assets.findIndex(a => a.tokenSymbol === 'TSLA');
      changed.assets[index] = { ...changed.assets[index], deployments: [{ contractAddress: '0x000000000000000000000000000000000000dEaD', chainId: 4663 }] };
      return { catalogFor: async () => officialCatalog(JSON.stringify(changed)) }; }, 'CATALOG_ASSET_IDENTITY_CHANGED'],
  ])('fails closed when %s', async (_name, setup, code) => {
    await expect(service(setup()).prepare(catalogSwapWorkflow(usdg, tsla, '100000000'))).rejects.toThrow(code);
  });
  it.each([
    ['the onchain uid differs from the official id', () => { chain.state.stocks.get(tsla.address!)!.uid = '0x' + '1'.repeat(64); }, 'STOCK_TOKEN_IDENTITY_MISMATCH'],
    ['the onchain multiplier differs from the registry', () => { chain.state.stocks.get(tsla.address!)!.multiplierWad = 2n * 10n ** 18n; }, 'STOCK_MULTIPLIER_MISMATCH'],
    ['a multiplier change takes effect inside the Review window', () => { Object.assign(chain.state.stocks.get(tsla.address!)!, { scheduledWad: 2n * 10n ** 18n,
      effectiveAt: Math.floor(T0 / 1000) + 30 }); }, 'STOCK_MULTIPLIER_CHANGE_PENDING'],
    ['the token is not the official beacon proxy', () => { chain.state.codeOverride.set(tsla.address!, '0x60ff'); }, 'STOCK_TOKEN_DEPLOYMENT_MISMATCH'],
    ['the token proxy points to another beacon', () => { chain.state.stocks.get(tsla.address!)!.beacon = '0x' + '9'.repeat(40); }, 'STOCK_TOKEN_DEPLOYMENT_MISMATCH'],
    ['the router code is not the pinned deployment', () => { chain.state.codeOverride.set(UNI.router, '0x60ff'); }, 'PROTOCOL_DEPLOYMENT_MISMATCH'],
    ['the USDG code is not the pinned deployment', () => { chain.state.codeOverride.set(UNI.usdg, '0x60ff'); }, 'TOKEN_DEPLOYMENT_MISMATCH'],
    ['the provider is on another chain', () => { chain.state.chainHex = '0x2105'; }, 'WRONG_PROVIDER_CHAIN'],
    ['no canonical pool has liquidity', () => { for (const pool of chain.state.pools.values()) Object.assign(pool, { liquidity: 0n }); }, 'POOL_UNUSABLE'],
    ['the chain head is stale', () => { chain.state.blockTime.set(chain.state.head, Math.floor(T0 / 1000) - 600); }, 'STALE_CHAIN_HEAD'],
  ])('fails closed when %s', async (_name, mutate, code) => {
    mutate();
    await expect(service().prepare(catalogSwapWorkflow(usdg, tsla, '100000000'))).rejects.toThrow(code);
  });
  it('records a multiplier change scheduled after the Review window as a Review-visible fact, not a blocker', async () => {
    Object.assign(chain.state.stocks.get(tsla.address!)!, { scheduledWad: 2n * 10n ** 18n, effectiveAt: Math.floor(T0 / 1000) + 3_600 });
    const q = (await service().prepare(catalogSwapWorkflow(usdg, tsla, '100000000'))).quote;
    expect(q.stocks?.[0]).toMatchObject({ scheduledMultiplierWad: '2000000000000000000', scheduledEffectiveAt: Math.floor(T0 / 1000) + 3_600 });
  });
  it('keeps the testnet and mainnet namespaces apart', async () => {
    const testnet = editorReducer(initialEditor(), { type: 'ADD_TESTNET_SWAP', direction: 'USDC_TO_WETH', amount: '2', slippage: '50', source: 'CANVAS', baseRevision: 0 },
      createBaseSepoliaReviewContext()).workflow as unknown as SemanticWorkflow;
    await expect(service().prepare(testnet)).rejects.toThrow('PUBLIC_WORKFLOW_UNSUPPORTED');
    const dir = mkdtempSync(join(tmpdir(), 'flofi-rh-swap-')); dirs.push(dir);
    const pub = createPublicTestnetService({ rpc: chain.rpc, journalDir: dir, now: () => new Date(clock), catalog: mockCatalogRuntime(catalog) });
    await expect(pub.prepare(catalogSwapWorkflow(usdg, tsla, '100000000'))).rejects.toThrow('PUBLIC_WORKFLOW_UNSUPPORTED');
  });
});

describe('Robinhood Chain catalog swap: authoring identity', () => {
  it('accepts exactly the canonical declaration and keeps the workflow hash stable', () => {
    const a = catalogSwapWorkflow(usdg, tsla, '100000000'), b = catalogSwapWorkflow(usdg, tsla, '100000000');
    expect(validateAuthoringWorkflow(a, createBaseSepoliaReviewContext())).toBe(a);
    expect(hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(a)))).toBe(hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(b))));
    const node = a.nodes[0]!;
    expect(node.inputs.map(input => input.name)).toEqual(['amount-in', 'asset-out', 'asset-out-official-id']);
    expect(node.inputs[2]).toEqual({ name: 'asset-out-official-id', kind: 'IDENTIFIER', value: tsla.stock!.officialId });
  });
  it('refuses a Stock Token without its official id, a base asset with wrong decimals, and a tampered declaration', () => {
    const ctx = createBaseSepoliaReviewContext();
    const unbound = catalogSwapWorkflow(usdg, { ...tsla, stock: null }, '1');
    expect(() => validateAuthoringWorkflow(unbound, ctx)).toThrow('CATALOG_SWAP_ASSET_IDENTITY_INVALID');
    expect(() => validateAuthoringWorkflow(catalogSwapWorkflow({ ...usdg, decimals: 18 }, tsla, '1'), ctx)).toThrow('CATALOG_SWAP_ASSET_IDENTITY_INVALID');
    const tampered = structuredClone(catalogSwapWorkflow(usdg, tsla, '1'));
    (tampered.nodes[0]!.expectedOutputs[0] as { minimumAmount: string }).minimumAmount = '5';
    expect(() => validateAuthoringWorkflow(tampered, ctx)).toThrow('CATALOG_SWAP_DECLARATION_INVALID');
    expect(() => createCatalogSwapNode('n', { chain: 'eip155:4663', amount: '1', slippageBps: 301, input: { chain: 'eip155:4663', address: usdg.address!, decimals: 6, officialId: null },
      output: { chain: 'eip155:4663', address: tsla.address!, decimals: 18, officialId: tsla.stock!.officialId } })).toThrow('CATALOG_SWAP_SLIPPAGE_INVALID');
    // Unregistered Polygon remains outside the catalog-swap network registry.
    expect(() => createCatalogSwapNode('n', { chain: 'eip155:137', amount: '1', slippageBps: 50, input: { chain: 'eip155:137', address: usdg.address!, decimals: 6, officialId: null },
      output: { chain: 'eip155:137', address: tsla.address!, decimals: 18, officialId: null } })).toThrow('CATALOG_SWAP_NETWORK_UNSUPPORTED');
  });
  it('refuses composition: a catalog swap executes isolated', () => {
    const workflow = catalogSwapWorkflow(usdg, tsla, '1');
    const second = { ...workflow.nodes[0]!, nodeId: 'node-003', dependencies: ['node-002'] };
    expect(() => validateAuthoringWorkflow({ ...workflow, nodes: [workflow.nodes[0]!, second] }, createBaseSepoliaReviewContext())).toThrow('CATALOG_SWAP_ISOLATED_ONLY');
  });
});

describe('Robinhood Chain catalog swap: owner execution, recovery and reconciliation', () => {
  /** The owner's wallet in this test: the mock chain applies exactly the prepared transaction (never anything else). */
  const wallet = (tx: { from: string; to: string; data: string; value: string }) => chain.apply(tx);
  it('refuses begin without the deployment real-funds opt-in, before persisting any attempt', async () => {
    const s = service({ executionEnabled: false }), run = await s.prepare(catalogSwapWorkflow(usdg, tsla, '100000000'));
    s.review(run.quote.executionId, run.quote.manifestHash);
    await expect(s.begin(run.quote.executionId, owner)).rejects.toThrow('OWNER_EXECUTION_NOT_ENABLED');
    expect(s.load(run.quote.executionId).attempts).toEqual([]);
  });
  it('approves, refreshes, reviews again, swaps and reconciles; evidence is MOCKED, never MAINNET_EXECUTED', async () => {
    const s = service(), id = (await s.prepare(catalogSwapWorkflow(usdg, tsla, '100000000'))).quote.executionId;
    s.review(id, s.load(id).quote.manifestHash);
    const approval = await s.begin(id, owner);
    expect(approval.attempt).toMatchObject({ step: 'approval', state: 'PREPARED', environment: 'MAINNET', chainId: 4663 });
    expect(approval.tx).toMatchObject({ chainId: '0x1237', from: owner, to: usdg.address, value: '0x0' });
    expect(approval.tx.data).toBe('0x095ea7b3' + UNI.router.slice(2).padStart(64, '0') + (100_000_000n).toString(16).padStart(64, '0'));
    s.report(id, approval.attempt.attemptId, { kind: 'HASH', txHash: wallet(approval.tx) });
    expect((await s.observe(id)).attempts.at(-1)?.state).toBe('CONFIRMED');
    clock += 5_000;
    const refreshed = await s.refresh(id);
    s.review(id, refreshed.quote.manifestHash);
    const swap = await s.begin(id, owner);
    expect(swap.attempt.step).toBe('swap');
    expect(swap.tx.to).toBe(UNI.router);
    expect(swap.tx.data.slice(0, 10)).toBe('0x04e45aaf');
    s.report(id, swap.attempt.attemptId, { kind: 'HASH', txHash: wallet(swap.tx) });
    const done = await s.observe(id);
    expect(done.outcome).toMatchObject({ inputSpent: '100000000', outputReceived: '260000000000000000' });
    expect(done.outcome!.evidence).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
    expect(done.outcome!.evidence.reconciliation.limitations).toEqual(['OWNER_WALLET_MAINNET', 'MOCKED_LOOPBACK_CHAIN']);
    expect(done.outcome!.evidence.reconciliation.balances).toEqual([
      { asset: { chainId: 'eip155:4663', address: usdg.address, decimals: 6 }, amount: '900000000' },
      { asset: { chainId: 'eip155:4663', address: tsla.address, decimals: 18 }, amount: '260000000000000000' }]);
    expect(chain.balance(tsla.address!, owner)).toBe(260_000_000_000_000_000n);
    // One run, one swap: a second attempt is refused.
    await expect(s.begin(id, owner)).rejects.toThrow(/ATTEMPT_ALREADY_ACTIVE|SWAP_ALREADY_ATTEMPTED|REVIEW_REQUIRED/);
  });
  it('invalidates the reviewed authority when the multiplier changes after Review', async () => {
    chain.state.allowances.set(`${usdg.address}:${owner}:${UNI.router}`, 10n ** 12n);
    const s = service(), id = (await s.prepare(catalogSwapWorkflow(usdg, tsla, '100000000'))).quote.executionId;
    s.review(id, s.load(id).quote.manifestHash);
    // A corporate action lands: chain and registry move together to 1.01.
    chain.state.stocks.get(tsla.address!)!.multiplierWad = 1_010_000_000_000_000_000n;
    const changed = JSON.parse(OFFICIAL_REGISTRY_TEXT) as { assets: Record<string, unknown>[] };
    const index = changed.assets.findIndex(a => a.tokenSymbol === 'TSLA');
    changed.assets[index] = { ...changed.assets[index], currentMultiplier: '1.010000000000000000' };
    const after = officialCatalog(JSON.stringify(changed));
    const s2 = createPublicTestnetService({ rpc: chain.rpc, rpcs: { 'eip155:4663': chain.rpc }, journalDir: dirs.at(-1)!, idPrefix: 'rhs', now: () => new Date(clock),
      catalog: mockCatalogRuntime(after) });
    await expect(s2.begin(id, owner)).rejects.toThrow('STOCK_MULTIPLIER_CHANGED_REVIEW_REQUIRED');
    expect(s2.load(id).reviewedManifestHash).toBeNull();
    expect(s2.load(id).attempts).toEqual([]);
  });
  it('requires a new Review when the quote moves, and refuses after expiry', async () => {
    chain.state.allowances.set(`${usdg.address}:${owner}:${UNI.router}`, 10n ** 12n);
    const s = service(), id = (await s.prepare(catalogSwapWorkflow(usdg, tsla, '100000000'))).quote.executionId;
    s.review(id, s.load(id).quote.manifestHash);
    const pool = chain.state.pools.get(uniswapV3PoolAddress(UNI.factory, UNI.poolInitCodeHash, usdg.address!, tsla.address!, 3000))!;
    Object.assign(pool, { rate: { ...pool.rate, [usdg.address!]: 2_500_000_000_000_000_000_000_000_000n } });
    await expect(s.begin(id, owner)).rejects.toThrow('QUOTE_CHANGED_REVIEW_REQUIRED');
    clock += 120_000;
    expect(() => s.review(id, s.load(id).quote.manifestHash)).toThrow('REVIEW_EXPIRED');
  });
  it('keeps an uncertain wallet result observation-only: no second attempt, no resubmission path', async () => {
    chain.state.allowances.set(`${usdg.address}:${owner}:${UNI.router}`, 10n ** 12n);
    const s = service(), id = (await s.prepare(catalogSwapWorkflow(usdg, tsla, '100000000'))).quote.executionId;
    s.review(id, s.load(id).quote.manifestHash);
    const begun = await s.begin(id, owner);
    s.report(id, begun.attempt.attemptId, { kind: 'UNKNOWN' });
    await expect(s.begin(id, owner)).rejects.toThrow('ATTEMPT_ALREADY_ACTIVE');
    expect(s.load(id).attempts.map(a => a.state)).toEqual(['UNKNOWN']);
  });
  it('HOTFIX-WORKFLOW-CONCURRENCY-001: swaps the same pair again while the first swap is pending; both reconcile from their own receipts', async () => {
    chain.state.allowances.set(`${usdg.address}:${owner}:${UNI.router}`, 10n ** 12n);
    const s = service(), first = (await s.prepare(catalogSwapWorkflow(usdg, tsla, '100000000'))).quote.executionId;
    s.review(first, s.load(first).quote.manifestHash);
    // Robinhood Chain's wallet assigns the nonce (no owner-bound Review): A is broadcast and still pending when B is reviewed and executed.
    const a = await s.begin(first, owner);
    s.report(first, a.attempt.attemptId, { kind: 'HASH', txHash: chain.queue(a.tx) });
    const second = (await s.prepare(catalogSwapWorkflow(usdg, tsla, '50000000'))).quote.executionId;
    s.review(second, s.load(second).quote.manifestHash);
    const b = await s.begin(second, owner);
    s.report(second, b.attempt.attemptId, { kind: 'HASH', txHash: chain.queue(b.tx) });
    // Both land in ONE block: each run's balance window holds both swaps, so each is proven from its own receipt.
    expect(chain.mineQueued()).toHaveLength(2);
    const [doneA, doneB] = [await s.observe(first), await s.observe(second)];
    expect(doneA.outcome).toMatchObject({ inputSpent: '100000000', outputReceived: '260000000000000000' });
    expect(doneB.outcome).toMatchObject({ inputSpent: '50000000', outputReceived: '130000000000000000' });
    for (const done of [doneA, doneB]) {
      expect(done.divergence).toBeUndefined();
      expect(done.outcome!.evidence.reconciliation.limitations).toEqual(['OWNER_WALLET_MAINNET', 'MOCKED_LOOPBACK_CHAIN', 'OWNER_TRANSACTIONS_IN_WINDOW_RECEIPT_RECONCILED']);
    }
    expect(doneA.attempts.at(-1)!.txHash).not.toBe(doneB.attempts.at(-1)!.txHash);
    expect(chain.balance(tsla.address!, owner)).toBe(390_000_000_000_000_000n);
  });
  it('HOTFIX-WORKFLOW-CONCURRENCY-001: with other owner transactions in the window, a receipt that does not prove the reviewed swap diverges', async () => {
    chain.state.allowances.set(`${usdg.address}:${owner}:${UNI.router}`, 10n ** 12n);
    const s = service(), id = (await s.prepare(catalogSwapWorkflow(usdg, tsla, '100000000'))).quote.executionId;
    s.review(id, s.load(id).quote.manifestHash);
    const begun = await s.begin(id, owner);
    // Another owner transaction (a plain token transfer) lands first, then the swap; the swap receipt's logs are then tampered.
    chain.apply({ from: owner, to: usdg.address!, data: '0xa9059cbb' + '0'.repeat(24) + '2'.repeat(40) + (1n).toString(16).padStart(64, '0'), value: '0x0' });
    const hash = chain.apply(begun.tx);
    const receipt = chain.state.receipts.get(hash)! as { logs: Record<string, unknown>[] };
    receipt.logs = receipt.logs.filter(log => (log.topics as string[])[0] !== '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67');
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: hash });
    // Never reconciled: on this network an unprovable receipt fails the observation (owner-bound networks persist it as divergence).
    await expect(s.observe(id)).rejects.toThrow('TRANSACTION_MISMATCH');
    expect(s.load(id).outcome).toBeNull();
  });
  it('persists runs only in the rhs- namespace and no code path sends a transaction', async () => {
    const s = service(), run = await s.prepare(catalogSwapWorkflow(usdg, tsla, '100000000'));
    expect(s.list()).toEqual([run.quote.executionId]);
    expect(MOCK_CODE.router).toBe(chain.state.code.get(UNI.router));
    expect(chain.state.receipts.size).toBe(0);
  });
});

describe('BUILD-FLOFI-BRIDGE-LIVE-FIX-003 native ETH on Robinhood Chain (its native currency is ETH; its WETH logs a Transfer mint/burn)', () => {
  it('swaps native ETH into USDG and back, never touching the owner\'s WETH', async () => {
    chain.addPool(usdg.address!, UNI.weth, { fee: 100, liquidity: 10n ** 20n, rate: { [usdg.address!]: 430_000_000_000_000_000_000_000n, [UNI.weth]: 2_326_000_000_000_000_000_000n } });
    chain.fundNative(owner, 10n ** 18n);
    const ETH = { chain: 'eip155:4663', address: null, decimals: 18, officialId: null };
    const USDG = { chain: 'eip155:4663', address: usdg.address!, decimals: usdg.decimals, officialId: null };
    const flow = (node: SemanticWorkflow['nodes'][number]): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, nodes: [node], resourceEdges: [] });
    const s = service(), id = (await s.prepare(flow(createCatalogSwapNode('node-002', { chain: 'eip155:4663', input: ETH, output: USDG, amount: '1000000000000000', slippageBps: 100 })))).quote.executionId;
    expect(s.load(id).quote).toMatchObject({ native: 'INPUT', inputSymbol: 'ETH', outputToken: usdg.address });
    s.review(id, s.load(id).quote.manifestHash);
    const begun = await s.begin(id, owner);
    expect(begun.tx).toMatchObject({ to: UNI.router, value: '0x' + (10n ** 15n).toString(16) });
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(begun.tx) });
    const done = await s.observe(id);
    expect(done.outcome).toMatchObject({ inputSpent: '1000000000000000' });
    expect(chain.balance(UNI.weth, owner)).toBe(0n);
  });
});
