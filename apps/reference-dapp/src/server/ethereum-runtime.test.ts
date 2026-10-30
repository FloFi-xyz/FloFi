// SPDX-License-Identifier: AGPL-3.0-only
/** MOCKED only. No wallet key, public RPC or MAINNET_EXECUTED evidence. */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ETHEREUM_MAINNET, ETHEREUM_MAINNET_TRANSFER, ETHEREUM_TOKEN_LIST, catalogAsset, parseEthereumTokenList, transferL1FeeOracle,
  UNISWAP_V3_ETHEREUM as UNI, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import { createCatalogSwapNode, createNativeTransferNode, createTokenTransferNode, type CatalogAssetRef, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { decodeNativeSwap, fromHex } from '@defi-workflow-engine/reference-compiler';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { createPublicTestnetService, createDurablePublicTestnetService, reviewPublicRun, validatePublicRunLog } from './public-testnet-service';
import { createRobinhoodTransferService } from './robinhood-transfer-service';
import { createRobinhoodMockChain, mockCatalogRuntime } from './robinhood-mainnet.test-harness';
import { ethereumMainnetMode, ethereumOwnerExecutionEnabled, ethereumMainnetRpc, ethereumRpcUrl, createEthereumCatalogLoader } from './ethereum-mainnet';
import { CATALOG_NETWORKS, catalogNetworkOfRun } from './catalog-networks';
import { flowMode, FLOWS } from '../../backend/flows';

const bytes = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/ethereum-token-list-fixture.json', import.meta.url), 'utf8');
const owner = '0x1111111111111111111111111111111111111111', recipient = '0x3333333333333333333333333333333333333333';
const chainId = ETHEREUM_MAINNET.chain;
let now = Date.parse('2026-10-11T22:06:20Z'), catalog: AssetCatalog, chain: ReturnType<typeof createRobinhoodMockChain>;
const dirs: string[] = [], dir = () => { const d = mkdtempSync(join(tmpdir(), 'flofi-ethereum-')); dirs.push(d); return d; };
const asset = (symbol: string) => catalogAsset(catalog, { symbol })!;
const flow = (node: SemanticWorkflow['nodes'][number]): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, nodes: [node], resourceEdges: [] });
const swap = (input = 'USDC', output = 'WETH', amount = '10000000') => flow(createCatalogSwapNode('node-002', { chain: chainId, amount, slippageBps: 50,
  input: { chain: chainId, address: asset(input).address!, decimals: asset(input).decimals, officialId: null },
  output: { chain: chainId, address: asset(output).address!, decimals: asset(output).decimals, officialId: null } }));
const native = (amount = '10000000000000000', to = recipient) => flow(createNativeTransferNode('node-002', { chain: chainId, amount, recipient: to }));
const token = (symbol = 'USDC', amount = '5000000', to = recipient) => flow(createTokenTransferNode('node-002', { chain: chainId, amount, recipient: to,
  token: { address: asset(symbol).address!, decimals: asset(symbol).decimals, officialId: null } }));
function swapService(options: { enabled?: boolean; path?: string; load?: () => Promise<AssetCatalog> } = {}) {
  return createPublicTestnetService({ rpc: async () => { throw Error('NO_FALLBACK'); }, rpcs: { [chainId]: chain.rpc }, idPrefix: 'ets',
    journalDir: options.path ?? dir(), now: () => new Date(now), catalog: mockCatalogRuntime(options.load ?? catalog, options.enabled ?? true) });
}
function transferService(options: { enabled?: boolean; path?: string; load?: () => Promise<AssetCatalog> } = {}) {
  return createRobinhoodTransferService({ rpcs: { [chainId]: chain.rpc }, idPrefix: 'ett', journalDir: options.path ?? dir(), now: () => now,
    provenance: 'MOCKED', catalogFor: options.load ?? (async () => catalog), executionEnabled: options.enabled ?? true });
}
beforeEach(() => {
  now = Date.parse('2026-10-11T22:06:20Z'); catalog = parseEthereumTokenList(bytes, new Date(now).toISOString());
  chain = createRobinhoodMockChain(catalog, { now: () => now });
  chain.fundNative(owner, 10n ** 18n); chain.fund(UNI.usdc, owner, 1_000_000_000n); chain.fund(UNI.weth, owner, 10n ** 18n);
  chain.addPool(UNI.usdc, UNI.weth, { fee: 500, liquidity: 10n ** 20n, rate: { [UNI.usdc]: 4n * 10n ** 26n, [UNI.weth]: 2_500_000n } });
});
afterEach(() => { vi.unstubAllGlobals(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('Ethereum live catalog and deployment profiles', () => {
  it('uses the canonical HTTPS source and shared parser; no cross-chain fallback, foreign records remain excluded', async () => {
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(bytes));
    const load = createEthereumCatalogLoader({ mode: 'live', fetcher, now: () => new Date(now) });
    const parsed = await load(chainId);
    expect(parsed).toEqual(catalog);
    expect(parsed.assets.every(a => a.chainId === 1)).toBe(true);
    expect(catalogAsset(parsed, { symbol: 'FLUX' })).toBeNull();
    expect(fetcher.mock.calls[0]?.[0]).toBe(ETHEREUM_TOKEN_LIST.url);
    await expect(load('eip155:8453')).rejects.toThrow('CATALOG_NETWORK_UNSUPPORTED');
  });
  it.each(['{', JSON.stringify({ tokens: [] }), bytes.replace('"decimals": 6', '"decimals": 37')])('fails closed on malformed source', async text => {
    await expect(createEthereumCatalogLoader({ mode: 'live', fetcher: async () => new Response(text) })(chainId)).rejects.toThrow();
  });
  it('does not use a stale catalog after cache expiry, accept redirects or fetch a substitute chain', async () => {
    let clock = now;
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(bytes));
    const load = createEthereumCatalogLoader({ mode: 'live', fetcher, now: () => new Date(clock), ttlMs: 1 });
    await load(chainId); clock += 2; fetcher.mockRejectedValueOnce(Error('unavailable'));
    await expect(load(chainId)).rejects.toThrow('ETHEREUM_TOKEN_LIST_UNAVAILABLE');
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', cache: 'no-store' });
  });
  it('defaults gates off and keeps Router/Base gates independent; no Ethereum harness bypass', () => {
    expect(ethereumMainnetMode({})).toBe('off');
    expect(ethereumMainnetMode({ GRYLOO_ROUTER: 'live', GRYLOO_BASE_MAINNET: 'live' })).toBe('off');
    expect(ethereumMainnetMode({ GRYLOO_ETHEREUM_MAINNET_HARNESS: 'MOCKED_LOOPBACK_ONLY' })).toBe('off');
    expect(ethereumOwnerExecutionEnabled('live', {})).toBe(false);
    expect(ethereumOwnerExecutionEnabled('off', { GRYLOO_ETHEREUM_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' })).toBe(false);
    expect(ethereumOwnerExecutionEnabled('live', { GRYLOO_BASE_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' })).toBe(false);
    expect(ethereumOwnerExecutionEnabled('live', { GRYLOO_ETHEREUM_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' })).toBe(true);
    expect(flowMode('ethereum-swap', {})).toBe('off'); expect(flowMode('ethereum-mainnet-transfer', {})).toBe('off');
    expect(CATALOG_NETWORKS['ethereum'].flows.liquidity).toBe('ethereum-liquidity');
    expect(CATALOG_NETWORKS['ethereum'].flows.lending).toBe('ethereum-aave');
    expect(ethereumRpcUrl(undefined)).toBe(ETHEREUM_MAINNET.rpc);
    expect(() => ethereumRpcUrl('http://localhost:8545')).toThrow('ETHEREUM_RPC_CONFIGURATION_INVALID');
  });
  it('rejects a foreign-chain RPC and denies signing/sending methods', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: '0x2105' }))));
    const rpc = ethereumMainnetRpc('live', {});
    await expect(rpc('eth_chainId', [])).rejects.toThrow('WRONG_PROVIDER_CHAIN');
    await expect(rpc('eth_sendTransaction', [])).rejects.toThrow('PUBLIC_RPC_METHOD_DENIED');
  });
});

describe('Ethereum swaps on the shared owner runtime', () => {
  it('prepares execution for an independent connected end user without a developer-wallet allowlist', async () => {
    chain.fundNative(recipient, 10n ** 18n); chain.fund(UNI.usdc, recipient, 1_000_000_000n);
    const s = swapService(), run = await s.prepare(swap(), recipient);
    s.review(run.quote.executionId, run.quote.manifestHash);
    const begun = await s.begin(run.quote.executionId, recipient);
    expect(begun.tx).toMatchObject({ from: recipient, chainId: '0x1', to: UNI.usdc });
  });
  it.each([['USDC', 'WETH', '10000000'], ['WETH', 'USDC', '10000000000000000']])('quotes %s → %s with chain-bound identities', async (input, output, amount) => {
    const run = await swapService().prepare(swap(input, output, amount), owner);
    expect(run.quote).toMatchObject({ chainId: 1, inputToken: asset(input).address, outputToken: asset(output).address, amountIn: amount,
      provenance: 'MOCKED', fee: 500, ownerReview: { account: owner, router: UNI.router } });
    expect(catalogNetworkOfRun(run.quote.executionId, 'swap')?.chain).toBe(chainId);
  });
  it('quotes USDC → LINK only when a canonical pool actually has liquidity', async () => {
    await expect(swapService().prepare(swap('USDC', 'LINK'), owner)).rejects.toThrow('POOL_UNUSABLE');
    chain.addPool(UNI.usdc, asset('LINK').address!, { fee: 3000, liquidity: 10n ** 20n, rate: { [UNI.usdc]: 10n ** 30n } });
    expect((await swapService().prepare(swap('USDC', 'LINK'), owner)).quote.fee).toBe(3000);
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
    const create = () => createDurablePublicTestnetService({ storage, rpc: chain.rpc, rpcs: { [chainId]: chain.rpc }, idPrefix: 'ets',
      now: () => new Date(now), catalog: mockCatalogRuntime(catalog) });
    const s = create(), run = await s.prepare(swap(), owner), id = run.quote.executionId;
    await s.review(id, run.quote.manifestHash); const begun = await s.begin(id, owner);
    await s.report(id, begun.attempt.attemptId, { kind: 'UNKNOWN' });
    await expect(create().begin(id, owner)).rejects.toThrow('ATTEMPT_ALREADY_ACTIVE');
    expect((await create().observe(id)).attempts).toHaveLength(1);
    chain.apply(begun.tx); const done = await create().observe(id);
    expect(done.outcome?.evidence.environment).toBe('MOCKED');
    expect(done.attempts).toHaveLength(1);
    expect(FLOWS['ethereum-swap'].needsObservation({ ...run, attempts: [{ ...begun.attempt, state: 'UNKNOWN' }] })).toBe(true);
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
    const updated = createPublicTestnetService({ rpc: chain.rpc, rpcs: { [chainId]: chain.rpc }, idPrefix: 'ets',
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
    expect(FLOWS['ethereum-swap'].needsObservation(restarted.load(id))).toBe(false);
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
    const projection = FLOWS['ethereum-swap'].projector(id + '.jsonl', new TextEncoder().encode(JSON.stringify(partial) + '\n'))!;
    expect(projection.run).toMatchObject({ needsObservation: true, hasEvidence: false, attempts: [{ reconciled: false }] });
    expect(projection.work.map(w => w.kind)).toContain('reconcile');
    if (step === 'approval') await expect(unavailable.refresh(id)).rejects.toThrow('QUOTE_REFRESH_NOT_ALLOWED');
    chain.rpc = rpc;
    // Reuse the MOCKED run's durable snapshots. Observation cannot grant authority, sign or resubmit.
    const storage = createFileExecutionStorage(dir(), 'EXECUTION_BUSY');
    await storage.log.extend(id + '.jsonl', new TextEncoder().encode(JSON.stringify(partial) + '\n'), validatePublicRunLog);
    const recoveredWorker = FLOWS['ethereum-swap'].create(storage, { rpc, mode: 'live', env: {}, catalog: async () => catalog });
    const done = await recoveredWorker.observe(id) as Awaited<ReturnType<typeof s.observe>>;
    expect(done.attempts).toHaveLength(1);
    if (step === 'swap') expect(done.outcome?.evidence.environment).toBe('MOCKED');
    else expect(done.attempts[0]?.nativeAfter).not.toBeNull();
    expect(FLOWS['ethereum-swap'].needsObservation(done)).toBe(false);
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

describe('Ethereum native and ERC20 transfers', () => {
  it.each(['native', 'token'] as const)('runs the %s owner lifecycle and reconciles after restart with MOCKED evidence', async kind => {
    const path = dir(), s = transferService({ path }), w = kind === 'native' ? native() : token(), simulated = await s.simulate(w, owner);
    expect(simulated.review).toMatchObject({ chain: chainId, chainId: 1, account: owner, recipient });
    expect(simulated.review.l1FeeUpperBound).toBeUndefined();
    await s.review(simulated.id, simulated.review.commitment, w); const begun = await s.begin(simulated.id, owner, w);
    expect(begun.transaction).toMatchObject({ chainId: '0x1', from: owner });
    if (kind === 'native') expect(begun.transaction).toMatchObject({ to: recipient, value: '0x2386f26fc10000', data: '0x' });
    else expect(begun.transaction).toMatchObject({ to: UNI.usdc, value: '0x0', data: '0xa9059cbb' + recipient.slice(2).padStart(64, '0') + (5_000_000n).toString(16).padStart(64, '0') });
    await s.handoff(simulated.id); await s.report(simulated.id, { kind: 'HASH', hash: chain.apply(begun.transaction) }); chain.mine(3);
    const done = await transferService({ path }).observe(simulated.id);
    expect(done.verdict).toBe('RECONCILED'); expect(done.evidence?.bundle.environment).toBe('MOCKED');
    expect(done.evidence?.bundle.reconciliation.limitations.join('\n')).toContain('Ethereum');
    expect(done.evidence?.bundle.reconciliation.limitations.join('\n')).not.toContain('Robinhood');
    expect(chain.state.allowances.size).toBe(0);
    expect(transferL1FeeOracle(ETHEREUM_MAINNET_TRANSFER)).toBeNull();
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
    chain.apply(begun.transaction); chain.mine(3);
    expect((await transferService({ path }).observe(run.id)).verdict).toBe('RECONCILED');
  });
  it('refuses invalid recipient, zero amount, wrong chain/owner and changed Review intent', async () => {
    for (const to of ['bad', '0x' + '0'.repeat(40)]) expect(() => native('1', to)).toThrow();
    expect(() => native('0')).toThrow(); expect(() => token('USDC', '0')).toThrow();
    const s = transferService(); chain.state.chainHex = '0x2105'; await expect(s.simulate(native(), owner)).rejects.toThrow('TRANSFER_WRONG_CHAIN');
    chain.state.chainHex = '0x1'; const w = native(), run = await s.simulate(w, owner); await s.review(run.id, run.review.commitment, w);
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
    await s.handoff(run.id); await s.report(run.id, { kind: 'HASH', hash: chain.apply(begun.transaction) }); chain.mine(3);
    expect((await s.observe(run.id)).verdict).toBe('RECONCILED');
  });
  it('refuses foreign-chain assets even inside a correctly labelled catalog', async () => {
    const contaminated: AssetCatalog = { ...catalog, assets: catalog.assets.map(a => a.address === UNI.usdc ? { ...a, chain: 'eip155:8453', chainId: 8453 } : a) };
    await expect(transferService({ load: async () => contaminated }).simulate(token(), owner)).rejects.toThrow('TRANSFER_ASSET_IDENTITY_CHANGED');
    await expect(swapService({ load: async () => contaminated }).prepare(swap(), owner)).rejects.toThrow('CATALOG_ASSET_IDENTITY_CHANGED');
  });
  it('uses Ethereum L1 gas estimates; never calls the OP Stack oracle', async () => {
    const reads: string[] = [], rpc = chain.rpc; chain.rpc = async (method, params) => {
      reads.push(method + ':' + JSON.stringify(params)); return rpc(method, params);
    };
    const run = await transferService().simulate(native(), owner);
    expect(run.review).toMatchObject({ gasEstimate: '120000', gasLimit: '180000', expectedFee: '1200000000000', feeBudget: '3600000000000' });
    expect(reads.join('\n')).not.toMatch(/420000000000000000000000000000000000000f|f1c7a58b/);
  });
  it.each(['native', 'token'] as const)('requires fresh Review when gas estimate exceeds reviewed %s bounds', async kind => {
    let increased = false;
    const rpc = chain.rpc; chain.rpc = async (method, params) => increased && method === 'eth_estimateGas' ? '0x493e0' : rpc(method, params);
    const s = transferService(), w = kind === 'native' ? native() : token(), run = await s.simulate(w, owner);
    await s.review(run.id, run.review.commitment, w);
    increased = true;
    await expect(s.begin(run.id, owner, w)).rejects.toThrow('TRANSFER_GAS_CHANGED_REVIEW_REQUIRED');
    expect((await s.load(run.id)).attempt).toBeNull();
  });
});

describe('BUILD-FLOFI-BRIDGE-LIVE-FIX-003 native ETH on Ethereum (owner-bound Review; WETH9 Deposit/Withdrawal logs)', () => {
  const ETH = { chain: chainId, address: null, decimals: 18, officialId: null } as const;
  const ref = (symbol: string) => ({ chain: chainId, address: asset(symbol).address!, decimals: asset(symbol).decimals, officialId: null });
  const nativeSwap = (input: CatalogAssetRef, output: CatalogAssetRef, amount: string, slippageBps = 50) =>
    flow(createCatalogSwapNode('node-002', { chain: chainId, amount, slippageBps, input, output }));
  async function execute(s: ReturnType<typeof swapService>, id: string) {
    const begun = await s.begin(id, owner);
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: chain.apply(begun.tx) });
    return { begun, run: await s.observe(id) };
  }
  it('E — native ETH → USDC with the deadline multicall and exact value, reconciled from the receipt', async () => {
    const s = swapService(), run = await s.prepare(nativeSwap(ETH, ref('USDC'), '10000000000000000'), owner), id = run.quote.executionId;
    expect(run.quote).toMatchObject({ native: 'INPUT', ownerReview: { step: 'swap', transaction: { value: '0x' + (10n ** 16n).toString(16) } } });
    s.review(id, run.quote.manifestHash);
    const { run: done } = await execute(s, id);
    expect(done.outcome).toMatchObject({ inputSpent: '10000000000000000', outputReceived: run.quote.expectedOut });
  });
  it('F — USDC → native ETH after the exact approval; the router unwraps (WETH9 Withdrawal) for the owner', async () => {
    const s = swapService(), first = await s.prepare(nativeSwap(ref('USDC'), ETH, '10000000'), owner), id = first.quote.executionId;
    s.review(id, first.quote.manifestHash);
    await execute(s, id);
    const next = await s.refresh(id); s.review(id, next.quote.manifestHash);
    const { begun, run: done } = await execute(s, id);
    expect(decodeNativeSwap(fromHex(begun.tx.data), UNI.weth)).toMatchObject({ native: 'OUTPUT', recipient: owner });
    expect(BigInt(done.outcome!.outputReceived)).toBeGreaterThanOrEqual(BigInt(next.quote.minimumOut));
  });
});
