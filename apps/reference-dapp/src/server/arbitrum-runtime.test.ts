// SPDX-License-Identifier: AGPL-3.0-only
/** MOCKED only. No wallet key, public RPC or MAINNET_EXECUTED evidence. */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARBITRUM_ONE, ARBITRUM_ONE_TRANSFER, ARBITRUM_TOKEN_LIST, catalogAsset, parseArbitrumTokenList, transferL1FeeOracle,
  UNISWAP_V3_ARBITRUM as UNI, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import { createCatalogSwapNode, createNativeTransferNode, createTokenTransferNode, type CatalogAssetRef, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { decodeNativeSwap, fromHex } from '@defi-workflow-engine/reference-compiler';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { createPublicTestnetService, createDurablePublicTestnetService, NATIVE_ETH, relayedNonceRelease, reviewPublicRun, validatePublicRunLog, type PublicRun } from './public-testnet-service';
import { createRobinhoodTransferService } from './robinhood-transfer-service';
import { createRobinhoodMockChain, mockCatalogRuntime } from './robinhood-mainnet.test-harness';
import { arbitrumMainnetMode, arbitrumOwnerExecutionEnabled, arbitrumMainnetRpc, arbitrumRpcUrl, createArbitrumCatalogLoader } from './arbitrum-mainnet';
import { CATALOG_NETWORKS, catalogNetworkOfRun } from './catalog-networks';
import { flowMode, FLOWS } from '../../backend/flows';

const bytes = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8');
const owner = '0x1111111111111111111111111111111111111111', recipient = '0x3333333333333333333333333333333333333333';
const chainId = ARBITRUM_ONE.chain;
let now = Date.parse('2026-10-11T22:06:20Z'), catalog: AssetCatalog, chain: ReturnType<typeof createRobinhoodMockChain>;
const dirs: string[] = [], dir = () => { const d = mkdtempSync(join(tmpdir(), 'flofi-arbitrum-')); dirs.push(d); return d; };
const asset = (symbol: string) => catalogAsset(catalog, { symbol })!;
const flow = (node: SemanticWorkflow['nodes'][number]): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, nodes: [node], resourceEdges: [] });
const swap = (input = 'USDC', output = 'WETH', amount = '10000000') => flow(createCatalogSwapNode('node-002', { chain: chainId, amount, slippageBps: 50,
  input: { chain: chainId, address: asset(input).address!, decimals: asset(input).decimals, officialId: null },
  output: { chain: chainId, address: asset(output).address!, decimals: asset(output).decimals, officialId: null } }));
const native = (amount = '10000000000000000', to = recipient) => flow(createNativeTransferNode('node-002', { chain: chainId, amount, recipient: to }));
const token = (symbol = 'USDC', amount = '5000000', to = recipient) => flow(createTokenTransferNode('node-002', { chain: chainId, amount, recipient: to,
  token: { address: asset(symbol).address!, decimals: asset(symbol).decimals, officialId: null } }));
function swapService(options: { enabled?: boolean; path?: string; load?: () => Promise<AssetCatalog> } = {}) {
  return createPublicTestnetService({ rpc: async () => { throw Error('NO_FALLBACK'); }, rpcs: { [chainId]: chain.rpc }, idPrefix: 'ars',
    journalDir: options.path ?? dir(), now: () => new Date(now), catalog: mockCatalogRuntime(options.load ?? catalog, options.enabled ?? true) });
}
function transferService(options: { enabled?: boolean; path?: string; load?: () => Promise<AssetCatalog> } = {}) {
  return createRobinhoodTransferService({ rpcs: { [chainId]: chain.rpc }, idPrefix: 'art', journalDir: options.path ?? dir(), now: () => now,
    provenance: 'MOCKED', catalogFor: options.load ?? (async () => catalog), executionEnabled: options.enabled ?? true });
}
beforeEach(() => {
  now = Date.parse('2026-10-11T22:06:20Z'); catalog = parseArbitrumTokenList(bytes, new Date(now).toISOString());
  chain = createRobinhoodMockChain(catalog, { now: () => now });
  chain.fundNative(owner, 10n ** 18n); chain.fund(UNI.usdc, owner, 1_000_000_000n); chain.fund(UNI.weth, owner, 10n ** 18n);
  chain.addPool(UNI.usdc, UNI.weth, { fee: 500, liquidity: 10n ** 20n, rate: { [UNI.usdc]: 4n * 10n ** 26n, [UNI.weth]: 2_500_000n } });
});
afterEach(() => { vi.unstubAllGlobals(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('Arbitrum live catalog and deployment profiles', () => {
  it('uses the canonical HTTPS source and shared parser; no cross-chain fallback, FLUX remains excluded', async () => {
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(bytes));
    const load = createArbitrumCatalogLoader({ mode: 'live', fetcher, now: () => new Date(now) });
    const parsed = await load(chainId);
    expect(parsed).toEqual(catalog);
    expect(parsed.assets.every(a => a.chainId === 42161)).toBe(true);
    expect(catalogAsset(parsed, { symbol: 'FLUX' })).toBeNull();
    expect(fetcher.mock.calls[0]?.[0]).toBe(ARBITRUM_TOKEN_LIST.url);
    await expect(load('eip155:8453')).rejects.toThrow('CATALOG_NETWORK_UNSUPPORTED');
  });
  it.each(['{', JSON.stringify({ tokens: [] }), bytes.replace('"decimals": 6', '"decimals": 37')])('fails closed on malformed source', async text => {
    await expect(createArbitrumCatalogLoader({ mode: 'live', fetcher: async () => new Response(text) })(chainId)).rejects.toThrow();
  });
  it('does not use a stale catalog after cache expiry, accept redirects or fetch a substitute chain', async () => {
    let clock = now;
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(bytes));
    const load = createArbitrumCatalogLoader({ mode: 'live', fetcher, now: () => new Date(clock), ttlMs: 1 });
    await load(chainId); clock += 2; fetcher.mockRejectedValueOnce(Error('unavailable'));
    await expect(load(chainId)).rejects.toThrow('ARBITRUM_TOKEN_LIST_UNAVAILABLE');
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', cache: 'no-store' });
  });
  it('defaults gates off and keeps Router/Base gates independent; no Arbitrum harness bypass', () => {
    expect(arbitrumMainnetMode({})).toBe('off');
    expect(arbitrumMainnetMode({ GRYLOO_ROUTER: 'live', GRYLOO_BASE_MAINNET: 'live' })).toBe('off');
    expect(arbitrumMainnetMode({ GRYLOO_ARBITRUM_MAINNET_HARNESS: 'MOCKED_LOOPBACK_ONLY' })).toBe('off');
    expect(arbitrumOwnerExecutionEnabled('live', {})).toBe(false);
    expect(arbitrumOwnerExecutionEnabled('off', { GRYLOO_ARBITRUM_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' })).toBe(false);
    expect(arbitrumOwnerExecutionEnabled('live', { GRYLOO_BASE_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' })).toBe(false);
    expect(arbitrumOwnerExecutionEnabled('live', { GRYLOO_ARBITRUM_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' })).toBe(true);
    expect(flowMode('arbitrum-swap', {})).toBe('off'); expect(flowMode('arbitrum-mainnet-transfer', {})).toBe('off');
    expect(CATALOG_NETWORKS['arbitrum-one'].flows.liquidity).toBe('arbitrum-liquidity');
    expect(CATALOG_NETWORKS['arbitrum-one'].flows.lending).toBe('arbitrum-aave');
    expect(arbitrumRpcUrl(undefined)).toBe(ARBITRUM_ONE.rpc);
    expect(() => arbitrumRpcUrl('http://localhost:8545')).toThrow('ARBITRUM_RPC_CONFIGURATION_INVALID');
  });
  it('rejects a foreign-chain RPC and denies signing/sending methods', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: '0x2105' }))));
    const rpc = arbitrumMainnetRpc('live', {});
    await expect(rpc('eth_chainId', [])).rejects.toThrow('WRONG_PROVIDER_CHAIN');
    await expect(rpc('eth_sendTransaction', [])).rejects.toThrow('PUBLIC_RPC_METHOD_DENIED');
  });
});

describe('Arbitrum swaps on the shared owner runtime', () => {
  it.each([['USDC', 'WETH', '10000000'], ['WETH', 'USDC', '10000000000000000']])('quotes %s → %s with chain-bound identities', async (input, output, amount) => {
    const run = await swapService().prepare(swap(input, output, amount), owner);
    expect(run.quote).toMatchObject({ chainId: 42161, inputToken: asset(input).address, outputToken: asset(output).address, amountIn: amount,
      provenance: 'MOCKED', fee: 500, ownerReview: { account: owner, router: UNI.router } });
    expect(catalogNetworkOfRun(run.quote.executionId, 'swap')?.chain).toBe(chainId);
  });
  it('quotes USDC → ARB only when a canonical pool actually has liquidity', async () => {
    await expect(swapService().prepare(swap('USDC', 'ARB'), owner)).rejects.toThrow('POOL_UNUSABLE');
    chain.addPool(UNI.usdc, asset('ARB').address!, { fee: 3000, liquidity: 10n ** 20n, rate: { [UNI.usdc]: 10n ** 30n } });
    expect((await swapService().prepare(swap('USDC', 'ARB'), owner)).quote.fee).toBe(3000);
  });
  it.each([
    ['wrong provider', () => { chain.state.chainHex = '0x2105'; }, 'WRONG_PROVIDER_CHAIN'],
    ['wrong router', () => { chain.state.codeOverride.set(UNI.router, '0x60ff'); }, 'PROTOCOL_DEPLOYMENT_MISMATCH'],
    ['wrong token decimals', () => { chain.state.decimalsOverride.set(UNI.usdc, 18); }, 'TOKEN_METADATA_MISMATCH'],
    ['no token code', () => { chain.state.codeOverride.set(UNI.usdc, '0x'); }, 'CONTRACT_CODE_MISSING'],
  ] as const)('refuses %s', async (_label, mutate, code) => {
    mutate(); await expect(swapService().prepare(swap(), owner)).rejects.toThrow(code);
  });
  it('requires an owner-bound simulation before Review and refuses another owner', async () => {
    const s = swapService(), preview = await s.prepare(swap());
    expect(() => s.review(preview.quote.executionId, preview.quote.manifestHash)).toThrow('OWNER_SIMULATION_REQUIRED');
    const run = await s.prepare(swap(), owner); s.review(run.quote.executionId, run.quote.manifestHash);
    await expect(s.begin(run.quote.executionId, recipient)).rejects.toThrow('OWNER_REVIEW_MISMATCH');
  });
  it('gate off refuses before any attempt or nonce intent', async () => {
    const path = dir(), s = swapService({ path, enabled: false }), run = await s.prepare(swap(), owner);
    s.review(run.quote.executionId, run.quote.manifestHash);
    await expect(s.begin(run.quote.executionId, owner)).rejects.toThrow('OWNER_EXECUTION_NOT_ENABLED');
    expect(s.load(run.quote.executionId).attempts).toEqual([]);
    expect((await swapService({ path }).begin(run.quote.executionId, owner)).attempt.state).toBe('PREPARED');
  });
  it.each(['quote', 'allowance', 'nonce', 'fee', 'expiry'] as const)('invalidates stale Review when %s changes', async change => {
    const s = swapService(), run = await s.prepare(swap(), owner); s.review(run.quote.executionId, run.quote.manifestHash);
    if (change === 'quote') chain.addPool(UNI.usdc, UNI.weth, { fee: 500, liquidity: 10n ** 20n, rate: { [UNI.usdc]: 5n * 10n ** 26n } });
    if (change === 'allowance') chain.state.allowances.set(`${UNI.usdc}:${owner}:${UNI.router}`, 1n);
    if (change === 'nonce') chain.state.nonces.set(owner, 1);
    if (change === 'fee') chain.state.gasPrice *= 3n;
    if (change === 'expiry') now += 61_000;
    await expect(s.begin(run.quote.executionId, owner)).rejects.toThrow(/REVIEW_REQUIRED/);
    expect(s.load(run.quote.executionId).reviewedManifestHash).toBeNull();
    expect(s.load(run.quote.executionId).attempts).toHaveLength(0);
  });
  it('approves exactly the input, refreshes, reviews the deadline-bound swap, restarts, and reconciles MOCKED fees', async () => {
    const path = dir(), s = swapService({ path }), prepared = await s.prepare(swap(), owner), id = prepared.quote.executionId;
    expect(prepared.quote.ownerReview).toMatchObject({ step: 'approval', allowance: '0', nonce: '0', feeBudgetWei: '3600000000000' });
    s.review(id, prepared.quote.manifestHash);
    const approve = await s.begin(id, owner);
    expect(approve.tx.data).toBe('0x095ea7b3' + UNI.router.slice(2).padStart(64, '0') + (10_000_000n).toString(16).padStart(64, '0'));
    s.report(id, approve.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(approve.tx) }); await s.observe(id);
    const next = await s.refresh(id); expect(next.reviewedManifestHash).toBeNull(); s.review(id, next.quote.manifestHash);
    expect(next.quote.ownerReview?.transaction.data).toMatch(/^0x5ae401dc/);
    const begun = await s.begin(id, owner); expect(begun.tx).toEqual(next.quote.ownerReview?.transaction);
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(begun.tx) });
    const done = await swapService({ path }).observe(id);
    expect(done.outcome?.evidence).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
    expect(done.outcome?.gasCostWei).toBe('2400000000000');
    expect(done.attempts.at(-1)?.receipt?.l1FeeWei).toBe('0');
  });
  it('durably recovers UNKNOWN by nonce on a new service instance without another wallet request', async () => {
    chain.state.allowances.set(`${UNI.usdc}:${owner}:${UNI.router}`, 10_000_000n);
    const storage = createFileExecutionStorage(dir(), 'EXECUTION_BUSY');
    const create = () => createDurablePublicTestnetService({ storage, rpc: chain.rpc, rpcs: { [chainId]: chain.rpc }, idPrefix: 'ars',
      now: () => new Date(now), catalog: mockCatalogRuntime(catalog) });
    const s = create(), run = await s.prepare(swap(), owner), id = run.quote.executionId;
    await s.review(id, run.quote.manifestHash); const begun = await s.begin(id, owner);
    await s.report(id, begun.attempt.attemptId, { kind: 'UNKNOWN' });
    await expect(create().begin(id, owner)).rejects.toThrow('ATTEMPT_ALREADY_ACTIVE');
    expect((await create().observe(id)).attempts).toHaveLength(1);
    chain.apply(begun.tx); const done = await create().observe(id);
    expect(done.outcome?.evidence.environment).toBe('MOCKED');
    expect(done.attempts).toHaveLength(1);
    expect(FLOWS['arbitrum-swap'].needsObservation({ ...run, attempts: [{ ...begun.attempt, state: 'UNKNOWN' }] })).toBe(true);
  });
  it('marks a different transaction consuming the nonce divergent, with no evidence', async () => {
    const s = swapService(), run = await s.prepare(swap(), owner), id = run.quote.executionId;
    s.review(id, run.quote.manifestHash); const begun = await s.begin(id, owner); s.report(id, begun.attempt.attemptId, { kind: 'UNKNOWN' });
    chain.apply({ from: owner, to: recipient, data: '0x', value: '0x1' });
    expect(await s.observe(id)).toMatchObject({ divergence: 'NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION', outcome: null });
  });
  it('binds every quote field and refuses tampered Review or durable history', async () => {
    const run = await swapService().prepare(swap(), owner);
    const changed = { ...run, quote: { ...run.quote, minimumOut: '1' } };
    expect(() => reviewPublicRun(changed, run.quote.manifestHash, new Date(now))).toThrow('QUOTE_BINDING_INVALID');
    expect(() => validatePublicRunLog(new TextEncoder().encode(JSON.stringify(changed) + '\n'))).toThrow('QUOTE_BINDING_INVALID');
  });
  it('invalidates Review if another owner transaction appears during final preflight', async () => {
    const rpc = chain.rpc;
    chain.rpc = async (method, params) => {
      const result = await rpc(method, params);
      if (method === 'eth_estimateGas' && params.length === 1) chain.state.nonces.set(owner, 1);
      return result;
    };
    // A new instance uses this RPC seam; only the final estimate changes the nonce after the pinned quote.
    const updated = createPublicTestnetService({ rpc: chain.rpc, rpcs: { [chainId]: chain.rpc }, idPrefix: 'ars',
      journalDir: dir(), now: () => new Date(now), catalog: mockCatalogRuntime(catalog) });
    const fresh = await updated.prepare(swap(), owner); updated.review(fresh.quote.executionId, fresh.quote.manifestHash);
    await expect(updated.begin(fresh.quote.executionId, owner)).rejects.toThrow('OWNER_STATE_CHANGED_REVIEW_REQUIRED');
    expect(updated.load(fresh.quote.executionId)).toMatchObject({ attempts: [], reviewedManifestHash: null });
  });
  it('permanently reserves the reviewed owner nonce across separate swap runs', async () => {
    const s = swapService(), a = await s.prepare(swap(), owner), b = await s.prepare(swap(), owner);
    s.review(a.quote.executionId, a.quote.manifestHash); s.review(b.quote.executionId, b.quote.manifestHash);
    await s.begin(a.quote.executionId, owner);
    await expect(s.begin(b.quote.executionId, owner)).rejects.toThrow('SWAP_NONCE_ALREADY_RESERVED');
    expect(s.load(b.quote.executionId).attempts).toHaveLength(0);
  });
  it('HOTFIX-WORKFLOW-CONCURRENCY-001: a pending swap never blocks another; the next Review binds the next nonce and both reconcile', async () => {
    chain.state.allowances.set(`${UNI.usdc}:${owner}:${UNI.router}`, 10n ** 12n);
    const s = swapService(), a = await s.prepare(swap(), owner);
    s.review(a.quote.executionId, a.quote.manifestHash);
    const beginA = await s.begin(a.quote.executionId, owner);
    expect(beginA.tx.nonce).toBe('0x0');
    s.report(a.quote.executionId, beginA.attempt.attemptId, { kind: 'HASH', txHash: chain.queue(beginA.tx) });
    // A is pending in the mempool: B, the same swap again on purpose, is simulated, reviewed and executed meanwhile.
    const b = await s.prepare(swap(), owner);
    expect(b.quote.ownerReview).toMatchObject({ nonce: '1', transaction: { nonce: '0x1' } });
    s.review(b.quote.executionId, b.quote.manifestHash);
    const beginB = await s.begin(b.quote.executionId, owner);
    s.report(b.quote.executionId, beginB.attempt.attemptId, { kind: 'HASH', txHash: chain.queue(beginB.tx) });
    expect(chain.mineQueued()).toHaveLength(2);
    const [doneA, doneB] = [await s.observe(a.quote.executionId), await s.observe(b.quote.executionId)];
    for (const done of [doneA, doneB]) {
      expect(done).toMatchObject({ outcome: { inputSpent: '10000000', outputReceived: '4000000000000000', evidence: { outcome: 'RECONCILED' } } });
      expect(done.divergence).toBeUndefined();
      expect(done.outcome!.evidence.reconciliation.limitations).toContain('OWNER_TRANSACTIONS_IN_WINDOW_RECEIPT_RECONCILED');
    }
    expect([doneA.attempts.at(-1)?.receipt?.nonce, doneB.attempts.at(-1)?.receipt?.nonce]).toEqual(['0', '1']);
  });
  it('HOTFIX-WORKFLOW-CONCURRENCY-001: a Review whose nonce another transaction took first must be reviewed again', async () => {
    chain.state.allowances.set(`${UNI.usdc}:${owner}:${UNI.router}`, 10n ** 12n);
    const s = swapService(), a = await s.prepare(swap(), owner);
    s.review(a.quote.executionId, a.quote.manifestHash);
    chain.queue({ from: owner, to: recipient, data: '0x', value: '0x1' }); // an unrelated wallet transaction, pending with nonce 0
    await expect(s.begin(a.quote.executionId, owner)).rejects.toThrow('OWNER_STATE_CHANGED_REVIEW_REQUIRED');
    const again = await s.prepare(swap(), owner);
    expect(again.quote.ownerReview?.nonce).toBe('1');
  });
  it.each(['approval', 'swap'] as const)('allows an explicit identical %s request after a proven rejection, retaining the nonce reservation', async step => {
    if (step === 'swap') chain.state.allowances.set(`${UNI.usdc}:${owner}:${UNI.router}`, 10_000_000n);
    const path = dir(), s = swapService({ path }), run = await s.prepare(swap(), owner), id = run.quote.executionId;
    s.review(id, run.quote.manifestHash);
    const first = await s.begin(id, owner); s.report(id, first.attempt.attemptId, { kind: 'REJECTED' });
    const restarted = swapService({ path }), retry = await restarted.begin(id, owner);
    expect(retry.tx).toEqual(first.tx); expect(retry.attempt.attemptId).not.toBe(first.attempt.attemptId);
    const other = await restarted.prepare(swap(), owner); restarted.review(other.quote.executionId, other.quote.manifestHash);
    await expect(restarted.begin(other.quote.executionId, owner)).rejects.toThrow('SWAP_NONCE_ALREADY_RESERVED');
    await expect(restarted.begin(id, owner)).rejects.toThrow('ATTEMPT_ALREADY_ACTIVE');
  });
  it('persists a balance mismatch as divergence and never refreshes a falsely confirmed approval', async () => {
    const path = dir(), s = swapService({ path }), run = await s.prepare(swap(), owner), id = run.quote.executionId;
    s.review(id, run.quote.manifestHash); const begun = await s.begin(id, owner);
    const hash = chain.apply(begun.tx); chain.fund(UNI.usdc, owner, 1n);
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: hash });
    expect(await s.observe(id)).toMatchObject({ divergence: 'APPROVAL_NOT_EFFECTIVE', outcome: null });
    const restarted = swapService({ path });
    await expect(restarted.refresh(id)).rejects.toThrow('RECONCILIATION_MISMATCH');
    expect(restarted.load(id).divergence).toBe('APPROVAL_NOT_EFFECTIVE');
    expect(FLOWS['arbitrum-swap'].needsObservation(restarted.load(id))).toBe(false);
  });
  it.each(['approval', 'swap'] as const)('continues durable worker observation after the %s receipt is saved but balance reads fail', async step => {
    if (step === 'swap') chain.state.allowances.set(`${UNI.usdc}:${owner}:${UNI.router}`, 10_000_000n);
    const path = dir(), s = swapService({ path }), run = await s.prepare(swap(), owner), id = run.quote.executionId;
    s.review(id, run.quote.manifestHash); const begun = await s.begin(id, owner);
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(begun.tx) });
    const rpc = chain.rpc;
    chain.rpc = async (method, params) => { if (method === 'eth_getBalance') throw Error('RPC_TEMPORARILY_UNAVAILABLE'); return rpc(method, params); };
    const unavailable = swapService({ path });
    await expect(unavailable.observe(id)).rejects.toThrow('RPC_TEMPORARILY_UNAVAILABLE');
    const partial = unavailable.load(id);
    expect(partial.attempts.at(-1)?.state).toBe('CONFIRMED'); expect(partial.divergence).toBeUndefined();
    const projection = FLOWS['arbitrum-swap'].projector(id + '.jsonl', new TextEncoder().encode(JSON.stringify(partial) + '\n'))!;
    expect(projection.run).toMatchObject({ needsObservation: true, hasEvidence: false, attempts: [{ reconciled: false }] });
    expect(projection.work.map(w => w.kind)).toContain('reconcile');
    if (step === 'approval') await expect(unavailable.refresh(id)).rejects.toThrow('QUOTE_REFRESH_NOT_ALLOWED');
    chain.rpc = rpc;
    // Reuse the MOCKED run's durable snapshots. Observation cannot grant authority, sign or resubmit.
    const storage = createFileExecutionStorage(dir(), 'EXECUTION_BUSY');
    await storage.log.extend(id + '.jsonl', new TextEncoder().encode(JSON.stringify(partial) + '\n'), validatePublicRunLog);
    const recoveredWorker = FLOWS['arbitrum-swap'].create(storage, { rpc, mode: 'live', env: {}, catalog: async () => catalog });
    const done = await recoveredWorker.observe(id) as Awaited<ReturnType<typeof s.observe>>;
    expect(done.attempts).toHaveLength(1);
    if (step === 'swap') expect(done.outcome?.evidence.environment).toBe('MOCKED');
    else expect(done.attempts[0]?.nativeAfter).not.toBeNull();
    expect(FLOWS['arbitrum-swap'].needsObservation(done)).toBe(false);
  });
  it.each(['chain', 'gas'] as const)('refuses a submitted transaction with wrong %s bounds', async change => {
    const s = swapService(), run = await s.prepare(swap(), owner), id = run.quote.executionId;
    s.review(id, run.quote.manifestHash); const begun = await s.begin(id, owner);
    const hash = chain.apply(begun.tx), tx = chain.state.transactions.get(hash)!;
    if (change === 'chain') tx.chainId = '0x2105';
    else tx.gas = '0xffffff';
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: hash });
    expect(await s.observe(id)).toMatchObject({ divergence: change === 'chain' ? 'TRANSACTION_MISMATCH' : 'TRANSACTION_BOUNDS_MISMATCH', outcome: null });
  });
});

describe('Arbitrum native and ERC20 transfers', () => {
  it.each(['native', 'token'] as const)('runs the %s owner lifecycle and reconciles after restart with MOCKED evidence', async kind => {
    const path = dir(), s = transferService({ path }), w = kind === 'native' ? native() : token(), simulated = await s.simulate(w, owner);
    expect(simulated.review).toMatchObject({ chain: chainId, chainId: 42161, account: owner, recipient });
    expect(simulated.review.l1FeeUpperBound).toBeUndefined();
    await s.review(simulated.id, simulated.review.commitment, w); const begun = await s.begin(simulated.id, owner, w);
    expect(begun.transaction).toMatchObject({ chainId: '0xa4b1', from: owner });
    if (kind === 'native') expect(begun.transaction).toMatchObject({ to: recipient, value: '0x2386f26fc10000', data: '0x' });
    else expect(begun.transaction).toMatchObject({ to: UNI.usdc, value: '0x0', data: '0xa9059cbb' + recipient.slice(2).padStart(64, '0') + (5_000_000n).toString(16).padStart(64, '0') });
    await s.handoff(simulated.id); await s.report(simulated.id, { kind: 'HASH', hash: chain.apply(begun.transaction) }); chain.mine(2);
    const done = await transferService({ path }).observe(simulated.id);
    expect(done.verdict).toBe('RECONCILED'); expect(done.evidence?.bundle.environment).toBe('MOCKED');
    expect(done.evidence?.bundle.reconciliation.limitations.join('\n')).toContain('Arbitrum One');
    expect(done.evidence?.bundle.reconciliation.limitations.join('\n')).not.toContain('Robinhood');
    expect(chain.state.allowances.size).toBe(0);
    expect(transferL1FeeOracle(ARBITRUM_ONE_TRANSFER)).toBeNull();
  });
  it.each(['native', 'token'] as const)('refuses %s owner execution with gate off', async kind => {
    const s = transferService({ enabled: false }), w = kind === 'native' ? native() : token(), run = await s.simulate(w, owner);
    await s.review(run.id, run.review.commitment, w); await expect(s.begin(run.id, owner, w)).rejects.toThrow('OWNER_EXECUTION_NOT_ENABLED');
    expect((await s.load(run.id)).attempt).toBeNull();
  });
  it.each(['native', 'token'] as const)('recovers ambiguous %s submission by nonce without resend', async kind => {
    const path = dir(), s = transferService({ path }), w = kind === 'native' ? native() : token(), run = await s.simulate(w, owner);
    await s.review(run.id, run.review.commitment, w); const begun = await s.begin(run.id, owner, w); await s.handoff(run.id);
    await s.report(run.id, { kind: 'UNKNOWN' }); await expect(s.begin(run.id, owner, w)).rejects.toThrow(/REVIEW_REQUIRED|OBSERVE_ONLY/);
    chain.apply(begun.transaction); chain.mine(2);
    expect((await transferService({ path }).observe(run.id)).verdict).toBe('RECONCILED');
  });
  it('refuses invalid recipient, zero amount, wrong chain/owner and changed Review intent', async () => {
    for (const to of ['bad', '0x' + '0'.repeat(40)]) expect(() => native('1', to)).toThrow();
    expect(() => native('0')).toThrow(); expect(() => token('USDC', '0')).toThrow();
    const s = transferService(); chain.state.chainHex = '0x2105'; await expect(s.simulate(native(), owner)).rejects.toThrow('TRANSFER_WRONG_CHAIN');
    chain.state.chainHex = '0xa4b1'; const w = native(), run = await s.simulate(w, owner); await s.review(run.id, run.review.commitment, w);
    await expect(s.begin(run.id, recipient, w)).rejects.toThrow();
    await expect(s.begin(run.id, owner, native('1'))).rejects.toThrow();
  });
  it('requires exact catalog chain, token contract and decimals; no symbol substitution or missing code', async () => {
    await expect(transferService({ load: async () => ({ ...catalog, chain: 'eip155:8453' }) }).simulate(token(), owner)).rejects.toThrow('TRANSFER_CATALOG_NETWORK_MISMATCH');
    chain.state.decimalsOverride.set(UNI.usdc, 18); await expect(transferService().simulate(token(), owner)).rejects.toThrow('TRANSFER_TOKEN_METADATA_MISMATCH');
    chain.state.decimalsOverride.clear(); chain.state.codeOverride.set(UNI.usdc, '0x'); await expect(transferService().simulate(token(), owner)).rejects.toThrow('TRANSFER_TOKEN_CODE_MISSING');
    chain.state.codeOverride.clear();
    const foreign = flow(createTokenTransferNode('node-002', { chain: chainId, amount: '1', recipient, token: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, officialId: null } }));
    await expect(transferService().simulate(foreign, owner)).rejects.toThrow('TRANSFER_TOKEN_CODE_MISSING');
  });
  it('revalidates catalog and decimals after Review before reserving any nonce', async () => {
    const s = transferService(), w = token(), run = await s.simulate(w, owner); await s.review(run.id, run.review.commitment, w);
    chain.state.decimalsOverride.set(UNI.usdc, 18); await expect(s.begin(run.id, owner, w)).rejects.toThrow('TRANSFER_TOKEN_METADATA_MISMATCH');
    expect((await s.load(run.id)).attempt).toBeNull();
  });
  it('supports a valid contract recipient with a value-only call and binds recipient code into Review', async () => {
    chain.state.codeOverride.set(recipient, '0x60006000');
    const s = transferService(), w = native(), run = await s.simulate(w, owner);
    expect(run.review.state.recipientCodeHash).toBeDefined();
    await s.review(run.id, run.review.commitment, w);
    chain.state.codeOverride.set(recipient, '0x60016000');
    await expect(s.begin(run.id, owner, w)).rejects.toThrow('TRANSFER_RECIPIENT_CODE_CHANGED_REVIEW_REQUIRED');
    chain.state.codeOverride.set(recipient, '0x60006000');
    const begun = await s.begin(run.id, owner, w); expect(begun.transaction.data).toBe('0x');
    await s.handoff(run.id); await s.report(run.id, { kind: 'HASH', hash: chain.apply(begun.transaction) }); chain.mine(2);
    expect((await s.observe(run.id)).verdict).toBe('RECONCILED');
  });
  it('refuses foreign-chain assets even inside a correctly labelled catalog', async () => {
    const contaminated: AssetCatalog = { ...catalog, assets: catalog.assets.map(a => a.address === UNI.usdc ? { ...a, chain: 'eip155:8453', chainId: 8453 } : a) };
    await expect(transferService({ load: async () => contaminated }).simulate(token(), owner)).rejects.toThrow('TRANSFER_ASSET_IDENTITY_CHANGED');
    await expect(swapService({ load: async () => contaminated }).prepare(swap(), owner)).rejects.toThrow('CATALOG_ASSET_IDENTITY_CHANGED');
  });
  it('uses Nitro estimate gas including posting gas; never calls the OP Stack oracle', async () => {
    const reads: string[] = [], rpc = chain.rpc; chain.rpc = async (method, params) => {
      reads.push(method + ':' + JSON.stringify(params)); return rpc(method, params);
    };
    const run = await transferService().simulate(native(), owner);
    expect(run.review).toMatchObject({ gasEstimate: '120000', gasLimit: '180000', expectedFee: '1200000000000', feeBudget: '3600000000000' });
    expect(reads.join('\n')).not.toMatch(/420000000000000000000000000000000000000f|f1c7a58b/);
  });
  it.each(['native', 'token'] as const)('requires fresh Review when Nitro posting gas exceeds reviewed %s bounds', async kind => {
    let increased = false;
    const rpc = chain.rpc; chain.rpc = async (method, params) => increased && method === 'eth_estimateGas' ? '0x493e0' : rpc(method, params);
    const s = transferService(), w = kind === 'native' ? native() : token(), run = await s.simulate(w, owner);
    await s.review(run.id, run.review.commitment, w);
    increased = true;
    await expect(s.begin(run.id, owner, w)).rejects.toThrow('TRANSFER_GAS_CHANGED_REVIEW_REQUIRED');
    expect((await s.load(run.id)).attempt).toBeNull();
  });
});

describe('BUILD-FLOFI-BRIDGE-LIVE-FIX-003 native ETH on Arbitrum One (owner-bound Review; aeWETH mint/burn logs)', () => {
  const ETH = { chain: chainId, address: null, decimals: 18, officialId: null } as const;
  const ref = (symbol: string) => ({ chain: chainId, address: asset(symbol).address!, decimals: asset(symbol).decimals, officialId: null });
  const nativeSwap = (input: CatalogAssetRef, output: CatalogAssetRef, amount: string, slippageBps = 50) =>
    flow(createCatalogSwapNode('node-002', { chain: chainId, amount, slippageBps, input, output }));
  it('C — native ETH → USDC: the owner-bound Review is the swap itself (no approval), value = amount, budget covers amount + gas', async () => {
    const s = swapService(), run = await s.prepare(nativeSwap(ETH, ref('USDC'), '10000000000000000'), owner), id = run.quote.executionId;
    expect(run.quote).toMatchObject({ native: 'INPUT', inputToken: NATIVE_ETH, ownerReview: { step: 'swap', transaction: { to: UNI.router, value: '0x' + (10n ** 16n).toString(16) } } });
    expect(decodeNativeSwap(fromHex(run.quote.ownerReview!.transaction.data), UNI.weth)).toMatchObject({ native: 'INPUT', recipient: owner });
    s.review(id, run.quote.manifestHash);
    const begun = await s.begin(id, owner); expect(begun.tx).toEqual(run.quote.ownerReview!.transaction);
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(begun.tx) });
    const done = await s.observe(id);
    expect(done.outcome).toMatchObject({ inputSpent: '10000000000000000' });
    expect(chain.balance(UNI.weth, owner)).toBe(10n ** 18n); // the owner's own WETH is never touched by a native-ETH swap
  });
  it('D — USDC → native ETH: approval, then the router unwraps (aeWETH burn) and pays the owner at least the minimum', async () => {
    const s = swapService(), first = await s.prepare(nativeSwap(ref('USDC'), ETH, '10000000'), owner), id = first.quote.executionId;
    expect(first.quote.ownerReview?.step).toBe('approval');
    s.review(id, first.quote.manifestHash);
    const approve = await s.begin(id, owner);
    s.report(id, approve.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(approve.tx) }); await s.observe(id);
    const next = await s.refresh(id); s.review(id, next.quote.manifestHash);
    expect(decodeNativeSwap(fromHex(next.quote.ownerReview!.transaction.data), UNI.weth)).toMatchObject({ native: 'OUTPUT', recipient: owner });
    const begun = await s.begin(id, owner), nativeBefore = chain.state.native.get(owner)!;
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(begun.tx) });
    const done = await s.observe(id), received = BigInt(done.outcome!.outputReceived);
    expect(received).toBeGreaterThanOrEqual(BigInt(next.quote.minimumOut));
    expect(chain.state.native.get(owner)! - nativeBefore).toBe(received - BigInt(done.attempts.at(-1)!.receipt!.gasCostWei));
  });
  it('wrap and unwrap through aeWETH (Transfer mint/burn) reconcile exactly 1:1', async () => {
    const s = swapService(), wrap = await s.prepare(nativeSwap(ETH, ref('WETH'), '5000000000000000', 0), owner), id = wrap.quote.executionId;
    expect(wrap.quote).toMatchObject({ conversion: 'WRAP', ownerReview: { step: 'swap', transaction: { to: UNI.weth, data: '0xd0e30db0' } } });
    s.review(id, wrap.quote.manifestHash);
    const begun = await s.begin(id, owner);
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(begun.tx) });
    expect((await s.observe(id)).outcome).toMatchObject({ inputSpent: '5000000000000000', outputReceived: '5000000000000000' });
    expect(chain.balance(UNI.weth, owner)).toBe(10n ** 18n + 5n * 10n ** 15n);
    const unwrap = await s.prepare(nativeSwap(ref('WETH'), ETH, '5000000000000000', 0), owner), uid = unwrap.quote.executionId;
    s.review(uid, unwrap.quote.manifestHash);
    const out = await s.begin(uid, owner);
    s.report(uid, out.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(out.tx) });
    expect((await s.observe(uid)).outcome).toMatchObject({ outputReceived: '5000000000000000' });
  });
});

describe('BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 owner account types on the owner-bound swap (T16/T18)', () => {
  const metaMaskDeleGator = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
  const ETH = { chain: chainId, address: null, decimals: 18, officialId: null } as const;
  const ref = (symbol: string) => ({ chain: chainId, address: asset(symbol).address!, decimals: asset(symbol).decimals, officialId: null });
  const usdcToEth = () => flow(createCatalogSwapNode('node-002', { chain: chainId, amount: '10000000', slippageBps: 100, input: ref('USDC'), output: ETH }));
  it('a standard EOA keeps its exact Review (no delegation field)', async () => {
    const run = await swapService().prepare(usdcToEth(), owner);
    expect(run.quote.ownerReview).toBeDefined();
    expect(run.quote.ownerReview).not.toHaveProperty('delegation');
  });
  it('a MetaMask Smart Account (EIP-7702 delegated EOA) is simulated, reviewed, executed and reconciled — never refused as a contract', async () => {
    chain.state.codeOverride.set(owner, '0xef0100' + metaMaskDeleGator.slice(2));
    const s = swapService(), first = await s.prepare(usdcToEth(), owner), id = first.quote.executionId;
    expect(first.quote.ownerReview).toMatchObject({ account: owner, step: 'approval', delegation: metaMaskDeleGator });
    s.review(id, first.quote.manifestHash);
    const approve = await s.begin(id, owner);
    s.report(id, approve.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(approve.tx) }); await s.observe(id);
    const next = await s.refresh(id); s.review(id, next.quote.manifestHash);
    expect(next.quote.ownerReview).toMatchObject({ step: 'swap', delegation: metaMaskDeleGator });
    const begun = await s.begin(id, owner);
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(begun.tx) });
    const done = await s.observe(id);
    expect(done.divergence ?? null).toBeNull();
    expect(BigInt(done.outcome!.outputReceived)).toBeGreaterThanOrEqual(BigInt(next.quote.minimumOut));
    // A delegated owner's balances can also move through relays (no nonce change): its own receipts are the proof; it paid both fees itself.
    expect(done.outcome!.evidence.reconciliation.limitations).toContain('OWNER_DELEGATED_ACCOUNT_RECEIPT_RECONCILED');
    expect(done.outcome!.evidence.reconciliation.limitations).not.toContain('OWNER_SUBMISSION_RELAYED_FEE_PAID_BY_RELAYER');
    expect(BigInt(done.outcome!.gasCostWei)).toBe(done.attempts.reduce((sum, a) => sum + BigInt(a.receipt!.gasCostWei), 0n));
  });
  it('refuses a delegation to an unreviewed implementation with its own code (a sweeper delegate never receives swap output)', async () => {
    chain.state.codeOverride.set(owner, '0xef0100' + '9'.repeat(40));
    await expect(swapService().prepare(usdcToEth(), owner)).rejects.toThrow('OWNER_DELEGATION_UNVERIFIED');
  });
  it('still refuses a smart contract wallet that cannot originate the transaction', async () => {
    chain.state.codeOverride.set(owner, '0x6080604052');
    await expect(swapService().prepare(usdcToEth(), owner)).rejects.toThrow('OWNER_NOT_EOA');
  });
  it('never reconciles a swap whose owner account carries contract code or an unreviewed delegate where it landed', async () => {
    const s = swapService(), first = await s.prepare(usdcToEth(), owner), id = first.quote.executionId;
    s.review(id, first.quote.manifestHash);
    const approve = await s.begin(id, owner);
    s.report(id, approve.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(approve.tx) }); await s.observe(id);
    const next = await s.refresh(id); s.review(id, next.quote.manifestHash);
    const begun = await s.begin(id, owner);
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(begun.tx) });
    chain.state.codeOverride.set(owner, '0xef0100' + '9'.repeat(40));
    const done = await s.observe(id);
    expect(done).toMatchObject({ divergence: 'OWNER_ACCOUNT_CODE_MISMATCH', outcome: null });
  });
  it('a delegation added after Review needs a new Review before any wallet request (T19)', async () => {
    const s = swapService(), run = await s.prepare(swap(), owner), id = run.quote.executionId;
    s.review(id, run.quote.manifestHash);
    chain.state.codeOverride.set(owner, '0xef0100' + metaMaskDeleGator.slice(2));
    await expect(s.begin(id, owner)).rejects.toThrow('OWNER_STATE_CHANGED_REVIEW_REQUIRED');
    expect(s.load(id).attempts).toHaveLength(0);
    expect(s.load(id).reviewedManifestHash).toBeNull();
  });
});

describe('BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 relayed MetaMask Smart Account submissions (Delegation Manager redemptions)', () => {
  // MOCKED loopback only: the relay is played by the in-memory chain in the shape of the real MetaMask relay recorded in
  // testdata/metamask-delegated-depth1-approval.base-sepolia.json. This is not evidence of a live mainnet relay.
  const metaMaskDeleGator = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b', relayer = '0xc066ac5d385419b1a8c43a0e146fa439837a8b8c';
  const ETH = { chain: chainId, address: null, decimals: 18, officialId: null } as const;
  const ref = (symbol: string) => ({ chain: chainId, address: asset(symbol).address!, decimals: asset(symbol).decimals, officialId: null });
  const usdcToEth = () => flow(createCatalogSwapNode('node-002', { chain: chainId, amount: '10000000', slippageBps: 100, input: ref('USDC'), output: ETH }));
  const intents = (path: string, nonce = 0) => readFileSync(join(path, `swap-42161-${owner}-${nonce}.intent`), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  beforeEach(() => { chain.state.codeOverride.set(owner, '0xef0100' + metaMaskDeleGator.slice(2)); chain.fundNative(relayer, 10n ** 18n); });
  /** Reviews and begins the run's next step; the wallet result is left to the test. */
  async function step(s: ReturnType<typeof swapService>, id: string, refresh = false) {
    const run = refresh ? await s.refresh(id) : s.load(id); s.review(id, run.quote.manifestHash);
    return s.begin(id, owner);
  }

  it('T16/T18: USDC → native ETH relayed approval and swap reconcile from their receipts; the owner pays no fee and keeps its nonce', async () => {
    const path = dir(), s = swapService({ path }), id = (await s.prepare(usdcToEth(), owner)).quote.executionId, nativeBefore = chain.state.native.get(owner)!;
    const approve = await step(s, id);
    expect(approve.tx.nonce).toBe('0x0');
    s.report(id, approve.attempt.attemptId, { kind: 'HASH', txHash: chain.relay(approve.tx, { relayer }) });
    const observed = await s.observe(id); expect(observed.divergence ?? null).toBeNull();
    expect(observed.attempts[0]).toMatchObject({ state: 'CONFIRMED', receipt: { submissionKind: 'DELEGATED_SINGLE', gasPayer: relayer, delegationDepth: 1 } });
    // The relayed approval never used owner nonce 0: the swap is reviewed at nonce 0 again and takes the reservation over with that evidence.
    const swap = await step(s, id, true);
    expect(swap.tx.nonce).toBe('0x0');
    s.report(id, swap.attempt.attemptId, { kind: 'HASH', txHash: chain.relay(swap.tx, { relayer }) });
    const done = await s.observe(id);
    expect(done.divergence ?? null).toBeNull();
    expect(done.outcome).toMatchObject({ inputSpent: '10000000', gasCostWei: '0', evidence: { environment: 'MOCKED', outcome: 'RECONCILED' } });
    expect(BigInt(done.outcome!.outputReceived)).toBeGreaterThanOrEqual(BigInt(done.quote.minimumOut));
    expect(chain.state.native.get(owner)! - nativeBefore).toBe(BigInt(done.outcome!.outputReceived));
    expect(chain.state.nonces.get(owner) ?? 0).toBe(0);
    expect(done.outcome!.evidence.reconciliation.limitations).toEqual(expect.arrayContaining(['OWNER_SUBMISSION_RELAYED_FEE_PAID_BY_RELAYER', 'OWNER_DELEGATED_ACCOUNT_RECEIPT_RECONCILED', 'NATIVE_ETH_RECEIPT_RECONCILED']));
    expect(intents(path)).toEqual([{ id, transaction: approve.tx },
      { id, transaction: swap.tx, supersedes: id, release: { attemptId: approve.attempt.attemptId, txHash: done.attempts[0]!.txHash } }]);
  });

  it('a completed relayed swap does not block the next one: the next run takes nonce 0 over and executes directly', async () => {
    const path = dir(), s = swapService({ path }), a = (await s.prepare(swap(), owner)).quote.executionId;
    const approve = await step(s, a); s.report(a, approve.attempt.attemptId, { kind: 'HASH', txHash: chain.relay(approve.tx, { relayer }) }); await s.observe(a);
    const swapA = await step(s, a, true); s.report(a, swapA.attempt.attemptId, { kind: 'HASH', txHash: chain.relay(swapA.tx, { relayer }) });
    expect((await s.observe(a)).outcome?.evidence.outcome).toBe('RECONCILED');
    const b = (await s.prepare(swap(), owner)).quote.executionId;
    const approveB = await step(s, b);
    expect(approveB.tx.nonce).toBe('0x0');
    s.report(b, approveB.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(approveB.tx) }); await s.observe(b);
    const swapB = await step(s, b, true);
    expect(swapB.tx.nonce).toBe('0x1');
    s.report(b, swapB.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(swapB.tx) });
    const done = await s.observe(b);
    expect(done.outcome?.evidence.outcome).toBe('RECONCILED');
    expect(BigInt(done.outcome!.gasCostWei)).toBeGreaterThan(0n);
    expect(intents(path).at(-1)).toMatchObject({ id: b, supersedes: a, release: { attemptId: swapA.attempt.attemptId } });
  });

  it('never releases a reservation because a relay was merely observed: not before verification and reconciliation, never after a divergence', async () => {
    const s = swapService(), a = (await s.prepare(swap(), owner)).quote.executionId;
    const approve = await step(s, a);
    const early = (await s.prepare(swap(), owner)).quote.executionId;
    await expect(step(s, early)).rejects.toThrow('SWAP_NONCE_ALREADY_RESERVED'); // the holder's attempt is only PREPARED
    const hash = chain.relay(approve.tx, { relayer, extraLogs: [{ address: asset('ARB').address!, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + owner.slice(2).padStart(64, '0'), '0x' + relayer.slice(2).padStart(64, '0')], data: '0x' + (1n).toString(16).padStart(64, '0') }] });
    s.report(a, approve.attempt.attemptId, { kind: 'HASH', txHash: hash });
    // A Review made after the relay landed (the allowance now exists: a swap at owner nonce 0, which the relay did not use).
    const b = (await s.prepare(swap(), owner)).quote.executionId;
    expect(s.load(b).quote.ownerReview).toMatchObject({ step: 'swap', nonce: '0' });
    await expect(step(s, b)).rejects.toThrow('SWAP_NONCE_ALREADY_RESERVED'); // relayed, not yet verified
    // The redemption also moved another token of the owner: not the reviewed effect, so it is never reconciled and never releases the nonce.
    expect(await s.observe(a)).toMatchObject({ divergence: 'TRANSACTION_MISMATCH', outcome: null });
    await expect(s.begin(b, owner)).rejects.toThrow('SWAP_NONCE_ALREADY_RESERVED');
    expect(s.load(b).attempts).toHaveLength(0);
  });

  it('discovers a relayed submission whose wallet result was lost, without another wallet request', async () => {
    const s = swapService(), id = (await s.prepare(swap(), owner)).quote.executionId;
    const approve = await step(s, id); s.report(id, approve.attempt.attemptId, { kind: 'UNKNOWN' });
    expect((await s.observe(id)).attempts[0]?.state).toBe('UNKNOWN');
    const hash = chain.relay(approve.tx, { relayer });
    const found = await s.observe(id);
    expect(found.divergence ?? null).toBeNull();
    expect(found.attempts).toHaveLength(1);
    expect(found.attempts[0]).toMatchObject({ state: 'CONFIRMED', txHash: hash, receipt: { gasPayer: relayer, submissionKind: 'DELEGATED_SINGLE' } });
  });

  it.each(['two relayed executions', 'a relayed and a direct execution'] as const)('records %s of one reviewed call as a duplicate (divergent, reservation kept)', async kind => {
    const s = swapService(), id = (await s.prepare(swap(), owner)).quote.executionId;
    const approve = await step(s, id); s.report(id, approve.attempt.attemptId, { kind: 'UNKNOWN' });
    chain.relay(approve.tx, { relayer });
    if (kind === 'two relayed executions') chain.relay(approve.tx, { relayer }); else chain.apply(approve.tx);
    expect(await s.observe(id)).toMatchObject({ divergence: 'RELAYED_DUPLICATE_EXECUTION', outcome: null });
    const next = await s.prepare(swap(), owner);
    s.review(next.quote.executionId, next.quote.manifestHash);
    if (kind === 'two relayed executions') await expect(s.begin(next.quote.executionId, owner)).rejects.toThrow('SWAP_NONCE_ALREADY_RESERVED');
  });

  it('credits one relayed transaction to one attempt only (no replay of its evidence by another run)', async () => {
    const path = dir(), s = swapService({ path }), a = (await s.prepare(swap(), owner)).quote.executionId;
    const approveA = await step(s, a);
    chain.apply({ from: owner, to: recipient, data: '0x', value: '0x1' }); // the owner's own transaction takes nonce 0 meanwhile
    const b = (await s.prepare(swap(), owner)).quote.executionId, approveB = await step(s, b);
    expect([approveA.tx.nonce, approveB.tx.nonce, approveA.tx.data === approveB.tx.data]).toEqual(['0x0', '0x1', true]);
    const hash = chain.relay(approveA.tx, { relayer });
    s.report(a, approveA.attempt.attemptId, { kind: 'HASH', txHash: hash }); s.report(b, approveB.attempt.attemptId, { kind: 'HASH', txHash: hash });
    expect((await s.observe(a)).attempts[0]?.state).toBe('CONFIRMED');
    expect(await s.observe(b)).toMatchObject({ divergence: 'RELAYED_TRANSACTION_ALREADY_CLAIMED', outcome: null });
    expect(JSON.parse(readFileSync(join(path, `claim-42161-${hash}.tx`), 'utf8'))).toEqual({ id: a, attemptId: approveA.attempt.attemptId });
  });

  it('relayedNonceRelease accepts only the reserved transaction verified as relayed, reconciled, with no pending, direct or divergent attempt', async () => {
    const s = swapService(), id = (await s.prepare(swap(), owner)).quote.executionId;
    const approve = await step(s, id); s.report(id, approve.attempt.attemptId, { kind: 'HASH', txHash: chain.relay(approve.tx, { relayer }) });
    const run: PublicRun = await s.observe(id), [attempt] = run.attempts;
    expect(relayedNonceRelease(run, '0', approve.tx)).toEqual({ attemptId: attempt!.attemptId, txHash: attempt!.txHash });
    expect(relayedNonceRelease(run, '0', { ...approve.tx, data: '0x' })).toBeNull(); // not the reserved transaction
    expect(relayedNonceRelease({ ...run, divergence: 'RECONCILIATION_MISMATCH' }, '0', approve.tx)).toBeNull();
    expect(relayedNonceRelease({ ...run, attempts: [{ ...attempt!, nativeAfter: null }] }, '0', approve.tx)).toBeNull(); // not reconciled
    expect(relayedNonceRelease({ ...run, attempts: [{ ...attempt!, receipt: { ...attempt!.receipt!, gasPayer: owner, from: owner, submissionKind: 'DIRECT' } }] }, '0', approve.tx)).toBeNull();
    expect(relayedNonceRelease({ ...run, attempts: [attempt!, { ...attempt!, attemptId: 'x', state: 'PENDING' }] }, '0', approve.tx)).toBeNull();
    expect(relayedNonceRelease({ ...run, attempts: [{ ...attempt!, state: 'REJECTED', txHash: null, receipt: null }] }, '0', approve.tx)).toBeNull();
    expect(relayedNonceRelease({ ...run, attempts: [{ ...attempt!, state: 'REVERTED', nativeAfter: null, receipt: { ...attempt!.receipt!, status: 0 } }] }, '0', approve.tx)).toBeNull();
  });

  it.each(['relayed twice', 'relayed and sent directly'] as const)('records a reviewed call %s as a duplicate even when the wallet reported a hash', async kind => {
    const s = swapService(), id = (await s.prepare(swap(), owner)).quote.executionId, approve = await step(s, id);
    if (kind === 'relayed twice') chain.relay(approve.tx, { relayer }); else chain.apply(approve.tx); // the earlier execution the wallet never reported
    s.report(id, approve.attempt.attemptId, { kind: 'HASH', txHash: chain.relay(approve.tx, { relayer }) });
    expect(await s.observe(id)).toMatchObject({ divergence: 'RELAYED_DUPLICATE_EXECUTION', outcome: null });
  });

  it('a wallet refusal that was in fact relayed is found before any new attempt (no second authorization of the same call)', async () => {
    const s = swapService(), id = (await s.prepare(swap(), owner)).quote.executionId, approve = await step(s, id);
    s.report(id, approve.attempt.attemptId, { kind: 'REJECTED' });
    chain.relay(approve.tx, { relayer });
    // The allowance now exists, so the next step needs a new Review first; that Review's attempt is then refused before any wallet request.
    await expect(s.begin(id, owner)).rejects.toThrow('OWNER_STATE_CHANGED_REVIEW_REQUIRED');
    s.review(id, s.load(id).quote.manifestHash);
    await expect(s.begin(id, owner)).rejects.toThrow('RECONCILIATION_MISMATCH');
    expect(s.load(id)).toMatchObject({ divergence: 'REJECTED_ATTEMPT_EXECUTED', reviewedManifestHash: null });
    expect(s.load(id).attempts).toHaveLength(1);
  });

  it('a refused or lost attempt that the relay executed in another shape (batch) is recorded, never ignored and never reconciled', async () => {
    const s = swapService(), id = (await s.prepare(swap(), owner)).quote.executionId, approve = await step(s, id);
    s.report(id, approve.attempt.attemptId, { kind: 'REJECTED' });
    chain.relay(approve.tx, { relayer, batch: true });
    await expect(s.begin(id, owner)).rejects.toThrow('OWNER_STATE_CHANGED_REVIEW_REQUIRED');
    s.review(id, s.load(id).quote.manifestHash);
    await expect(s.begin(id, owner)).rejects.toThrow('RECONCILIATION_MISMATCH');
    expect(s.load(id).divergence).toBe('REJECTED_ATTEMPT_EXECUTED');
    chain.state.allowances.clear();
    const r = swapService(), lost = (await r.prepare(swap(), owner)).quote.executionId, approveLost = await step(r, lost);
    r.report(lost, approveLost.attempt.attemptId, { kind: 'UNKNOWN' });
    chain.relay(approveLost.tx, { relayer, batch: true });
    expect(await r.observe(lost)).toMatchObject({ divergence: 'RELAYED_EXECUTION_UNSUPPORTED_SHAPE', outcome: null });
  });

  it('keeps a relayed receipt pending when the duplicate check cannot cover the whole window (never reconciled on a partial scan)', async () => {
    const s = swapService(), id = (await s.prepare(swap(), owner)).quote.executionId, approve = await step(s, id);
    s.report(id, approve.attempt.attemptId, { kind: 'HASH', txHash: chain.relay(approve.tx, { relayer }) });
    chain.mine(1); chain.state.head += 2_100_000; // observed far later than the bounded scan reaches
    const pending = await s.observe(id);
    expect(pending.divergence ?? null).toBeNull();
    expect(pending.attempts[0]).toMatchObject({ state: 'PENDING', receipt: null });
  });

  it('never accepts a relayed authorization that could be redeemed again, or a reverted relay, and keeps the nonce reservation', async () => {
    const s = swapService(), a = (await s.prepare(swap(), owner)).quote.executionId, approve = await step(s, a);
    s.report(a, approve.attempt.attemptId, { kind: 'HASH', txHash: chain.relay(approve.tx, { relayer, singleUse: false }) });
    expect(await s.observe(a)).toMatchObject({ divergence: 'RELAYED_DELEGATION_NOT_SINGLE_USE', outcome: null });
    chain.state.allowances.clear(); // a fresh owner state for the second case
    const r = swapService(), b = (await r.prepare(swap(), owner)).quote.executionId, approveB = await step(r, b);
    r.report(b, approveB.attempt.attemptId, { kind: 'HASH', txHash: chain.relay(approveB.tx, { relayer, reverted: true }) });
    expect(await r.observe(b)).toMatchObject({ divergence: 'RELAYED_SUBMISSION_REVERTED', outcome: null });
    const c = (await r.prepare(swap(), owner)).quote.executionId;
    await expect(step(r, c)).rejects.toThrow('SWAP_NONCE_ALREADY_RESERVED');
  });

  it.each(['direct', 'relayed'] as const)('reconciles a %s WETH → USDC swap whose aeWETH transferFrom also logs the spent allowance (OpenZeppelin ERC20)', async kind => {
    chain.state.transferFromApproval.add(UNI.weth);
    const s = swapService(), id = (await s.prepare(swap('WETH', 'USDC', '10000000000000000'), owner)).quote.executionId;
    const approve = await step(s, id);
    s.report(id, approve.attempt.attemptId, { kind: 'HASH', txHash: kind === 'direct' ? chain.apply(approve.tx) : chain.relay(approve.tx, { relayer }) }); await s.observe(id);
    const begun = await step(s, id, true);
    const hash = kind === 'direct' ? chain.apply(begun.tx) : chain.relay(begun.tx, { relayer });
    expect((chain.state.receipts.get(hash)!.logs as { topics: string[] }[]).some(log => log.topics[0] === '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925')).toBe(true);
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: hash });
    const done = await s.observe(id);
    expect(done.divergence ?? null).toBeNull();
    expect(done.outcome).toMatchObject({ inputSpent: '10000000000000000', evidence: { outcome: 'RECONCILED' } });
  });

  it('proves a delegated owner\'s direct swap from its receipt: an extra movement of the owner\'s input token is never reconciled', async () => {
    const s = swapService(), id = (await s.prepare(swap(), owner)).quote.executionId, approve = await step(s, id);
    s.report(id, approve.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(approve.tx) }); await s.observe(id);
    const begun = await step(s, id, true);
    const extra = { address: UNI.usdc, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + owner.slice(2).padStart(64, '0'),
      '0x' + recipient.slice(2).padStart(64, '0')], data: '0x' + (1n).toString(16).padStart(64, '0') };
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(begun.tx, { extraLogs: [extra] }) });
    expect(await s.observe(id)).toMatchObject({ divergence: 'TRANSACTION_MISMATCH', outcome: null });
  });

  it('an owner reviewed as a standard account is never reconciled from a relayed redemption', async () => {
    chain.state.codeOverride.delete(owner);
    const s = swapService(), id = (await s.prepare(swap(), owner)).quote.executionId, approve = await step(s, id);
    chain.state.codeOverride.set(owner, '0xef0100' + metaMaskDeleGator.slice(2));
    s.report(id, approve.attempt.attemptId, { kind: 'HASH', txHash: chain.relay(approve.tx, { relayer }) });
    expect(await s.observe(id)).toMatchObject({ divergence: expect.stringMatching(/^(TRANSACTION_MISMATCH|OWNER_SUBMISSION_UNSUPPORTED)$/), outcome: null });
  });
});
