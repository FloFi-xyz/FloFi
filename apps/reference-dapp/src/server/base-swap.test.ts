// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: Base mainnet swaps on the shared Uniswap swap service, against a MOCKED in-memory Base chain and FloFi's own Base
 * token-list fixture. A listed token is checked on chain (code present, `decimals()` exactly the catalog's); USDC and WETH carry their
 * pinned code; the OP Stack L1 fee is part of the gas-funds check. Base's USDC ⇄ WETH reference swap keeps its BUILD-002 declaration and
 * is read into the same fields. No test reaches a network, signs or sends: the "wallet" is the mock chain applying the exact transaction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalogSwapNode, type CatalogAssetRef, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { decodeNativeSwap, fromHex } from '@defi-workflow-engine/reference-compiler';
import { UNISWAP_V3_BASE as UNI, uniswapV3PoolAddress, type AssetCatalog, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { createPublicTestnetService, NATIVE_ETH, type PublicTestnetService } from './public-testnet-service';
import { createRobinhoodMockChain, mockCatalogRuntime, officialCatalog, asset as rhAsset, WITHDRAWAL_TOPIC, type RobinhoodMockChain } from './robinhood-mainnet.test-harness';
import { baseAsset, baseCatalog } from './base-mainnet.test-harness';
import { createSwapNode } from '../domain/swap-authoring';
import { cryptoReviewContext } from '../domain/crypto-action-picker';

const owner = '0x1111111111111111111111111111111111111111';
const T0 = Date.parse('2026-10-11T03:00:00.000Z');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function catalogSwapWorkflow(input: CanonicalAsset, output: CanonicalAsset, amount: string, slippageBps = 50): SemanticWorkflow {
  const node = createCatalogSwapNode('node-002', { chain: 'eip155:8453', amount, slippageBps,
    input: { chain: input.chain, address: input.address!, decimals: input.decimals, officialId: null },
    output: { chain: output.chain, address: output.address!, decimals: output.decimals, officialId: null } });
  return { schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, nodes: [node], resourceEdges: [] };
}
/** Base's BUILD-002 reference swap (USDC → WETH), authored exactly as the chat and Canvas author it. */
const referenceWorkflow = (amount: string): SemanticWorkflow =>
  ({ schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, nodes: [createSwapNode('node-002', 'USDC_TO_WETH', amount, '50', cryptoReviewContext('Base'))], resourceEdges: [] });

let clock = T0, catalog: AssetCatalog, chain: RobinhoodMockChain, usdc: CanonicalAsset, weth: CanonicalAsset, cbbtc: CanonicalAsset;
function service(options: { executionEnabled?: boolean; catalogFor?: () => Promise<AssetCatalog> } = {}): PublicTestnetService {
  const dir = mkdtempSync(join(tmpdir(), 'flofi-base-swap-')); dirs.push(dir);
  return createPublicTestnetService({ rpc: async () => { throw new Error('PUBLIC_NETWORK_UNAVAILABLE'); }, rpcs: { 'eip155:8453': chain.rpc },
    journalDir: dir, idPrefix: 'bas', now: () => new Date(clock), catalog: mockCatalogRuntime(options.catalogFor ?? catalog, options.executionEnabled ?? true) });
}
beforeEach(() => {
  clock = T0;
  catalog = baseCatalog();
  chain = createRobinhoodMockChain(catalog, { now: () => clock, network: 'base' });
  usdc = baseAsset(catalog, 'USDC'); weth = baseAsset(catalog, 'WETH'); cbbtc = baseAsset(catalog, 'cbBTC');
  // 100 USDC (1e8 units) → 0.001 cbBTC (1e5 sats) on the 0.05% pool; 100 USDC → 0.04 WETH on the 0.05% pool.
  chain.addPool(usdc.address!, cbbtc.address!, { fee: 500, liquidity: 10n ** 20n, rate: { [usdc.address!]: 1_000_000_000_000_000n, [cbbtc.address!]: 10n ** 21n } });
  chain.addPool(usdc.address!, weth.address!, { fee: 500, liquidity: 10n ** 20n, rate: { [usdc.address!]: 400_000_000_000_000_000_000_000_000n, [weth.address!]: 2_500_000n } });
  chain.fund(usdc.address!, owner, 1_000_000_000n);
  chain.fundNative(owner, 10n ** 17n);
});

describe('BUILD-BASE-001 Base mainnet swap: Simulate and Review', () => {
  it('quotes a listed token (cbBTC) on the best live canonical pool, in the bas- namespace, with MOCKED provenance', async () => {
    const run = await service().prepare(catalogSwapWorkflow(usdc, cbbtc, '100000000'));
    expect(run.quote.executionId).toMatch(/^bas-[0-9a-f]{24}$/);
    expect(run.quote).toMatchObject({ chainId: 8453, inputToken: usdc.address, outputToken: cbbtc.address, inputSymbol: 'USDC', outputSymbol: 'cbBTC',
      inputDecimals: 6, outputDecimals: 8, amountIn: '100000000', expectedOut: '100000', fee: 500, environment: 'MAINNET', provenance: 'MOCKED',
      pool: uniswapV3PoolAddress(UNI.factory, UNI.poolInitCodeHash, usdc.address!, cbbtc.address!, 500) });
    expect(run.quote.stocks ?? []).toEqual([]);
  });
  it('reads the BUILD-002 USDC → WETH declaration into the same quote fields', async () => {
    const run = await service().prepare(referenceWorkflow('100'));
    expect(run.quote).toMatchObject({ chainId: 8453, inputToken: usdc.address, outputToken: weth.address, inputSymbol: 'USDC', outputSymbol: 'WETH',
      amountIn: '100000000', expectedOut: '40000000000000000', fee: 500, provenance: 'MOCKED' });
  });
  it.each([
    ['the token list is unavailable', () => ({ catalogFor: async () => { throw new Error('BASE_TOKEN_LIST_UNAVAILABLE'); } }), 'BASE_TOKEN_LIST_UNAVAILABLE'],
    ['the list no longer contains the token', () => ({ catalogFor: async () => ({ ...catalog, assets: catalog.assets.filter(a => a.symbol !== 'cbBTC') }) }), 'CATALOG_ASSET_IDENTITY_CHANGED'],
  ])('fails closed when %s', async (_name, setup, code) => {
    await expect(service(setup()).prepare(catalogSwapWorkflow(usdc, cbbtc, '100000000'))).rejects.toThrow(code);
  });
  it.each([
    ['decimals() on chain differ from the list (listing is never authority)', () => { chain.state.decimalsOverride.set(cbbtc.address!, 18); }, 'TOKEN_METADATA_MISMATCH'],
    ['the listed token has no code', () => { chain.state.codeOverride.set(cbbtc.address!, '0x'); }, 'CONTRACT_CODE_MISSING'],
    ['the USDC code is not the pinned deployment', () => { chain.state.codeOverride.set(UNI.usdc, '0x60ff'); }, 'TOKEN_DEPLOYMENT_MISMATCH'],
    ['the router code is not the pinned deployment', () => { chain.state.codeOverride.set(UNI.router, '0x60ff'); }, 'PROTOCOL_DEPLOYMENT_MISMATCH'],
    ['the provider is on another chain', () => { chain.state.chainHex = '0x1237'; }, 'WRONG_PROVIDER_CHAIN'],
    ['no canonical pool has liquidity', () => { for (const pool of chain.state.pools.values()) Object.assign(pool, { liquidity: 0n }); }, 'POOL_UNUSABLE'],
  ])('fails closed when %s', async (_name, mutate, code) => {
    mutate();
    await expect(service().prepare(catalogSwapWorkflow(usdc, cbbtc, '100000000'))).rejects.toThrow(code);
  });
  it("refuses another network's asset and keeps the Robinhood and Base namespaces apart", async () => {
    const rh = officialCatalog(), tsla = rhAsset(rh, 'TSLA');
    await expect(service().prepare(catalogSwapWorkflow(usdc, { ...tsla, chain: 'eip155:8453' }, '1000000'))).rejects.toThrow();
    const dir = mkdtempSync(join(tmpdir(), 'flofi-base-swap-')); dirs.push(dir);
    const robinhood = createPublicTestnetService({ rpc: chain.rpc, rpcs: { 'eip155:4663': chain.rpc }, journalDir: dir, idPrefix: 'rhs', now: () => new Date(clock),
      catalog: mockCatalogRuntime(rh) });
    await expect(robinhood.prepare(catalogSwapWorkflow(usdc, cbbtc, '100000000'))).rejects.toThrow('PUBLIC_WORKFLOW_UNSUPPORTED');
  });
});

describe('BUILD-BASE-001 Base mainnet swap: owner execution, L1 fee and reconciliation', () => {
  const wallet = (tx: { from: string; to: string; data: string; value: string }) => chain.apply(tx);
  it('refuses begin without GRYLOO_BASE_OWNER_EXECUTION, before persisting any attempt', async () => {
    const s = service({ executionEnabled: false }), run = await s.prepare(catalogSwapWorkflow(usdc, cbbtc, '100000000'));
    s.review(run.quote.executionId, run.quote.manifestHash);
    await expect(s.begin(run.quote.executionId, owner)).rejects.toThrow('OWNER_EXECUTION_NOT_ENABLED');
    expect(s.load(run.quote.executionId).attempts).toEqual([]);
  });
  it('refuses to prepare a request whose gas and L1 data fee the owner cannot pay', async () => {
    chain.fundNative(owner, 120_000n * 10_000_000n * 2n);
    const s = service(), id = (await s.prepare(catalogSwapWorkflow(usdc, cbbtc, '100000000'))).quote.executionId;
    s.review(id, s.load(id).quote.manifestHash);
    await expect(s.begin(id, owner)).rejects.toThrow('INSUFFICIENT_GAS_FUNDS');
  });
  it('approves, refreshes, reviews again, swaps and reconciles; evidence is MOCKED, never MAINNET_EXECUTED', async () => {
    const s = service(), id = (await s.prepare(catalogSwapWorkflow(usdc, cbbtc, '100000000'))).quote.executionId;
    s.review(id, s.load(id).quote.manifestHash);
    const approval = await s.begin(id, owner);
    expect(approval.tx).toMatchObject({ chainId: '0x2105', from: owner, to: usdc.address, value: '0x0' });
    s.report(id, approval.attempt.attemptId, { kind: 'HASH', txHash: wallet(approval.tx) });
    expect((await s.observe(id)).attempts.at(-1)?.state).toBe('CONFIRMED');
    clock += 5_000;
    const refreshed = await s.refresh(id);
    s.review(id, refreshed.quote.manifestHash);
    const swap = await s.begin(id, owner);
    expect(swap.tx.to).toBe(UNI.router);
    s.report(id, swap.attempt.attemptId, { kind: 'HASH', txHash: wallet(swap.tx) });
    const done = await s.observe(id);
    expect(done.outcome).toMatchObject({ inputSpent: '100000000', outputReceived: '100000' });
    expect(done.outcome!.evidence).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
    expect(chain.balance(cbbtc.address!, owner)).toBe(100_000n);
  });
  it('keeps an uncertain wallet result observation-only', async () => {
    chain.state.allowances.set(`${usdc.address}:${owner}:${UNI.router}`, 10n ** 12n);
    const s = service(), id = (await s.prepare(catalogSwapWorkflow(usdc, cbbtc, '100000000'))).quote.executionId;
    s.review(id, s.load(id).quote.manifestHash);
    const begun = await s.begin(id, owner);
    s.report(id, begun.attempt.attemptId, { kind: 'UNKNOWN' });
    await expect(s.begin(id, owner)).rejects.toThrow('ATTEMPT_ALREADY_ACTIVE');
  });
});

describe('BUILD-FLOFI-BRIDGE-LIVE-FIX-003 native ETH on Base: swaps in and out, wrap and unwrap', () => {
  const ETH = { chain: 'eip155:8453', address: null, decimals: 18, officialId: null } as const;
  const ref = (a: CanonicalAsset) => ({ chain: a.chain, address: a.address!, decimals: a.decimals, officialId: null });
  const nativeWorkflow = (input: CatalogAssetRef, output: CatalogAssetRef, amount: string, slippageBps: number): SemanticWorkflow =>
    ({ schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, nodes: [createCatalogSwapNode('node-002', { chain: 'eip155:8453', input, output, amount, slippageBps })], resourceEdges: [] });
  const wallet = (tx: { from: string; to: string; data: string; value: string }) => chain.apply(tx);
  async function run(workflow: SemanticWorkflow) {
    const s = service(), id = (await s.prepare(workflow)).quote.executionId;
    s.review(id, s.load(id).quote.manifestHash);
    return { s, id };
  }
  it('A — native ETH → USDC: a native quote (never WETH), no approval, value = amount in, receipt-reconciled with gas kept apart', async () => {
    chain.fundNative(owner, 10n ** 18n);
    const { s, id } = await run(nativeWorkflow(ETH, ref(usdc), '1000000000000000', 100));
    const q = s.load(id).quote;
    expect(q).toMatchObject({ native: 'INPUT', inputToken: NATIVE_ETH, inputSymbol: 'ETH', inputDecimals: 18, outputToken: usdc.address, fee: 500 });
    expect(q.conversion).toBeUndefined();
    const begun = await s.begin(id, owner);
    expect(begun.attempt.step).toBe('swap');
    expect(begun.tx).toMatchObject({ to: UNI.router, value: '0x' + (10n ** 15n).toString(16) });
    expect(decodeNativeSwap(fromHex(begun.tx.data), UNI.weth)).toMatchObject({ native: 'INPUT', tokenIn: UNI.weth, tokenOut: usdc.address, recipient: owner, amountIn: 10n ** 15n,
      amountOutMinimum: BigInt(q.minimumOut) });
    const nativeBefore = chain.state.native.get(owner)!;
    s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: wallet(begun.tx) });
    const done = await s.observe(id);
    expect(done.outcome).toMatchObject({ inputSpent: '1000000000000000', outputReceived: q.expectedOut });
    const gas = BigInt(done.attempts.at(-1)!.receipt!.gasCostWei);
    expect(nativeBefore - chain.state.native.get(owner)!).toBe(10n ** 15n + gas);
    expect(chain.balance(UNI.weth, owner)).toBe(0n);
    expect(done.outcome!.evidence.reconciliation.balances[0]!.asset).toEqual({ chainId: 'eip155:8453', nativeId: 'ETH', decimals: 18 });
    expect(done.outcome!.evidence.reconciliation.allowances).toEqual([]);
    expect(done.outcome!.evidence.reconciliation.limitations).toContain('NATIVE_ETH_RECEIPT_RECONCILED');
  });
  it('B — USDC → native ETH: exact approval, then the swap pays the router and unwrapWETH9 pays the owner native ETH (≥ minimum)', async () => {
    const { s, id } = await run(nativeWorkflow(ref(usdc), ETH, '100000000', 100));
    const q = s.load(id).quote;
    expect(q).toMatchObject({ native: 'OUTPUT', outputToken: NATIVE_ETH, outputSymbol: 'ETH', outputDecimals: 18 });
    const approval = await s.begin(id, owner);
    expect(approval.tx).toMatchObject({ to: usdc.address, value: '0x0' });
    s.report(id, approval.attempt.attemptId, { kind: 'HASH', txHash: wallet(approval.tx) });
    await s.observe(id);
    clock += 5_000;
    s.review(id, (await s.refresh(id)).quote.manifestHash);
    const swap = await s.begin(id, owner), minimum = BigInt(s.load(id).quote.minimumOut);
    expect(swap.tx).toMatchObject({ to: UNI.router, value: '0x0' });
    expect(decodeNativeSwap(fromHex(swap.tx.data), UNI.weth)).toMatchObject({ native: 'OUTPUT', recipient: owner, amountOutMinimum: minimum });
    const nativeBefore = chain.state.native.get(owner)!;
    s.report(id, swap.attempt.attemptId, { kind: 'HASH', txHash: wallet(swap.tx) });
    const done = await s.observe(id);
    const received = BigInt(done.outcome!.outputReceived), gas = BigInt(done.attempts.at(-1)!.receipt!.gasCostWei);
    expect(received).toBeGreaterThanOrEqual(minimum);
    // The gas the owner paid is never read as a missing output: native delta = received − gas.
    expect(chain.state.native.get(owner)! - nativeBefore).toBe(received - gas);
    expect(chain.balance(UNI.weth, owner)).toBe(0n);
  });
  it('G/H — wrap ETH → WETH and unwrap WETH → ETH are WETH9 deposit/withdraw of exactly the amount (1:1, no pool, no approval)', async () => {
    chain.fundNative(owner, 10n ** 18n);
    const wrapped = await run(nativeWorkflow(ETH, ref(weth), '10000000000000000', 0));
    expect(wrapped.s.load(wrapped.id).quote).toMatchObject({ conversion: 'WRAP', native: 'INPUT', expectedOut: '10000000000000000', minimumOut: '10000000000000000', pool: UNI.weth, fee: 0 });
    const deposit = await wrapped.s.begin(wrapped.id, owner);
    expect(deposit.tx).toMatchObject({ to: UNI.weth, data: '0xd0e30db0', value: '0x' + (10n ** 16n).toString(16) });
    wrapped.s.report(wrapped.id, deposit.attempt.attemptId, { kind: 'HASH', txHash: wallet(deposit.tx) });
    expect((await wrapped.s.observe(wrapped.id)).outcome).toMatchObject({ inputSpent: '10000000000000000', outputReceived: '10000000000000000' });
    expect(chain.balance(UNI.weth, owner)).toBe(10n ** 16n);
    const unwrapped = await run(nativeWorkflow(ref(weth), ETH, '10000000000000000', 0));
    const withdraw = await unwrapped.s.begin(unwrapped.id, owner);
    expect(withdraw.attempt.step).toBe('swap');
    expect(withdraw.tx).toMatchObject({ to: UNI.weth, value: '0x0', data: '0x2e1a7d4d' + (10n ** 16n).toString(16).padStart(64, '0') });
    unwrapped.s.report(unwrapped.id, withdraw.attempt.attemptId, { kind: 'HASH', txHash: wallet(withdraw.tx) });
    expect((await unwrapped.s.observe(unwrapped.id)).outcome).toMatchObject({ inputSpent: '10000000000000000', outputReceived: '10000000000000000' });
    expect(chain.balance(UNI.weth, owner)).toBe(0n);
  });
  it('refuses a native-ETH request the owner cannot pay together with its network fee', async () => {
    chain.fundNative(owner, 10n ** 15n);
    const { s, id } = await run(nativeWorkflow(ETH, ref(usdc), '1000000000000000', 100));
    await expect(s.begin(id, owner)).rejects.toThrow('INSUFFICIENT_GAS_FUNDS');
    chain.fundNative(owner, 10n ** 14n);
    await expect(s.begin(id, owner)).rejects.toThrow('INSUFFICIENT_INPUT');
    expect(s.load(id).attempts).toEqual([]);
  });
  it('never accepts native delivery from a Transfer alone: a receipt without the router\'s unwrap, or paying someone else, is a mismatch', async () => {
    chain.state.allowances.set(`${usdc.address}:${owner}:${UNI.router}`, 10n ** 12n);
    const { s, id } = await run(nativeWorkflow(ref(usdc), ETH, '100000000', 100));
    const swap = await s.begin(id, owner), hash = wallet(swap.tx);
    const receipt = chain.state.receipts.get(hash)!;
    chain.state.receipts.set(hash, { ...receipt, logs: (receipt.logs as Record<string, unknown>[]).filter(log => (log.topics as string[])[0] !== WITHDRAWAL_TOPIC) });
    s.report(id, swap.attempt.attemptId, { kind: 'HASH', txHash: hash });
    await expect(s.observe(id)).rejects.toThrow('TRANSACTION_MISMATCH');
    expect(s.load(id).outcome).toBeNull();
  });
});
