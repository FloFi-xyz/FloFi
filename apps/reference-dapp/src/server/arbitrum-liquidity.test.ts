// SPDX-License-Identifier: AGPL-3.0-only
/** Closed MOCKED owner-wallet certification; no network, signer key or public execution. */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARBITRUM_ONE, catalogAsset, catalogPoolOn, parseArbitrumTokenList, UNISWAP_V3_ARBITRUM as UNI,
  uniswapCatalogDeployment, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { createBaseSepoliaReviewContext, validateUniswapLiquidityNode } from '@defi-workflow-engine/reference-linter';
import { decodeUniswapApprove, decodeUniswapMint, sqrtRatioAtTick, UNISWAP_SELECTORS as SEL, UNISWAP_TOPICS as TOPIC,
  uniswapAlignQuotePriceRange, uniswapBandAroundSqrtPrice, uniswapQuotePriceAtTick, uniswapUsableTicks } from '@defi-workflow-engine/reference-compiler';
import { readConcentratedLiquidity, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER } from '../../e2e/uniswap-liquidity-harness';
import { FLOWS, disabledCode, flowMode } from '../../backend/flows';
import { editorReducer, initialEditor } from '../domain/editor';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import { createCatalogLiquidityNode } from '../domain/robinhood-liquidity-authoring';
import { defaultPoolRange, selectCryptoNetwork } from '../domain/crypto-action-picker';
import { arbitrumOwnerExecutionEnabled, ARBITRUM_LIQUIDITY_RPC_METHODS } from './arbitrum-mainnet';
import { catalogNetworkOfRun, CATALOG_NETWORKS } from './catalog-networks';
import { createUniswapLiquidityService, uniswapNeedsObservation } from './uniswap-liquidity-service';
import type { Rpc } from './public-testnet-service';

const bytes = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8');
const catalog = parseArbitrumTokenList(bytes, '2026-10-12T00:00:00Z'), chainId = ARBITRUM_ONE.chain;
const asset = (symbol: string) => catalogAsset(catalog, { symbol })!;
const token = (a: CanonicalAsset) => a as { symbol: string; address: string; decimals: number };
const dirs: string[] = [], context = createBaseSepoliaReviewContext();
const word = (n: bigint) => (n & ((1n << 256n) - 1n)).toString(16).padStart(64, '0');
const addressWord = (a: string) => a.slice(2).padStart(64, '0');
function input(fee = 500, reverse = false, lower?: number, upper?: number) {
  return { selection: { action: 'pool' as const, network: 'Arbitrum One', from: reverse ? 'WETH' : 'USDC', to: reverse ? 'USDC' : 'WETH' },
    amount: reverse ? '0.005' : '10', secondAmount: reverse ? '10' : '0.005', slippage: '100', fee,
    ...lower === undefined ? {} : { rangeUnit: 'TICK' as const, lower: String(lower), upper: String(upper) } };
}
function workflow(fee = 500, reverse = false, lower?: number, upper?: number): SemanticWorkflow {
  const result = editorReducer(initialEditor(), { type: 'ADD_CRYPTO_ACTION', source: 'CANVAS', baseRevision: 0, input: input(fee, reverse, lower, upper) }, context);
  if (result.error) throw Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
}
type Fault = (method: string, params: readonly unknown[], result: unknown) => unknown;
async function setup(options: { fee?: number; approved?: boolean; execution?: boolean; fault?: Fault; pair?: readonly [string, string] } = {}) {
  const [a, b] = (options.pair ?? ['USDC', 'WETH']).map(asset) as [CanonicalAsset, CanonicalAsset];
  const profile = catalogPoolOn(chainId, token(a), token(b), options.fee ?? 500);
  const chain = createUniswapLiquidityChain({ profile, tick: profile.token0.decimals === profile.token1.decimals ? 60_000 : -225_600,
    usdc: 10n ** BigInt(profile.token0.decimals + 4), weth: 10n ** BigInt(profile.token1.decimals + 4) });
  if (options.approved) { chain.externalAllowance('token0', 10n ** 30n); chain.externalAllowance('token1', 10n ** 30n); }
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const rpc: Rpc = async (method, params) => {
    calls.push({ method, params });
    const result = await chain.rpc(method, params);
    return options.fault ? options.fault(method, params, result) : result;
  };
  const path = mkdtempSync(join(tmpdir(), 'flofi-arbitrum-lp-')); dirs.push(path);
  const restart = () => createUniswapLiquidityService({ storage: createFileExecutionStorage(path, 'UNISWAP_LIQUIDITY_BUSY'),
    rpc: async () => { throw Error('NO_OTHER_CHAIN_CLIENT'); }, rpcs: { [chainId]: rpc }, provenance: 'MOCKED', now: chain.clock,
    mockedCodePins: UNI_MOCK_CODE_PINS, executionEnabled: options.execution ?? true,
    catalog: { chain: chainId, catalogFor: async () => catalog, codePins: chain.catalogPins } });
  return { chain, profile, service: restart(), restart, calls, path };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function reviewed(s: Setup, w = workflow()) {
  const run = await s.service.simulate(w, UNI_OWNER);
  return s.service.review(run.id, run.review.commitment, w);
}
async function send(s: Setup, id: string, w = workflow(), hold = false) {
  const begun = await s.service.begin(id, UNI_OWNER, w); await s.service.handoff(id);
  const hash = s.chain.wallet.send(begun.transaction, { hold }); await s.service.report(id, { kind: 'HASH', hash });
  return { begun, hash };
}
beforeEach(() => registerNetworkCatalog(catalog));
afterEach(() => { resetNetworkCatalogs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Arbitrum liquidity deployments, discovery, ordering and ranges', () => {
  it('pins fresh authoritative deployments and derives the factory pool on eip155:42161', () => {
    const proof = JSON.parse(readFileSync(new URL('../../../../docs/builds/BUILD-ARB-001-PHASE-4-READ-VERIFICATION.json', import.meta.url), 'utf8'));
    expect(proof.environment).toBe('PUBLIC_READ_ONLY'); expect(proof.chain).toBe(chainId);
    for (const [name, field] of [['UniswapV3Factory', 'factory'], ['NonfungiblePositionManager', 'positionManager'], ['SwapRouter02', 'router'], ['QuoterV2', 'quoter']] as const) {
      expect(proof.contracts[name].address).toBe(UNI[field]); expect(proof.contracts[name].codeSha256).toBe(UNI.codeSha256[field]);
    }
    const pool = catalogPoolOn(chainId, token(asset('USDC')), token(asset('WETH')), 500);
    expect(pool.pool).toBe('0xc6962004f452be9203591991d15f6b388e09e8d0');
    expect(pool.token0.address).toBe(UNI.weth); expect(pool.token1.address).toBe(UNI.usdc);
    expect(uniswapCatalogDeployment(42161)).toMatchObject({ factory: UNI.factory, positionManager: UNI.positionManager, gasPriceOracle: null });
  });
  it.each([['USDC', 'WETH'], ['USDC', 'ARB'], ['WETH', 'ARB']] as const)('checks an existing %s/%s factory pool, without promising other tiers', async (a, b) => {
    const s = await setup({ pair: [a, b] });
    const value = await s.service.price(chainId, { tokenA: asset(a).address!, tokenB: asset(b).address!, fee: 500 });
    expect(value.blockNumber).toBeGreaterThan(0); expect(s.chain.counters.sends).toBe(0);
    await expect(s.service.price(chainId, { tokenA: asset(a).address!, tokenB: asset(b).address!, fee: 3000 })).rejects.toThrow('UNISWAP_CONTRACT_CODE_MISSING');
  });
  it('preserves amounts in both authored orders; protocol ordering follows addresses, not symbols', () => {
    const a = workflow(), b = workflow(500, true); expect(b).toEqual(a);
    const f = readConcentratedLiquidity(a.nodes.at(-1)!);
    expect([f.token0.address, f.token1.address, f.amount0Max, f.amount1Max]).toEqual([UNI.weth, UNI.usdc, '5000000000000000', '10000000']);
    expect(selectCryptoNetwork('pool', 'Arbitrum One')).toEqual({ action: 'pool', network: 'Arbitrum One', from: 'USDC', to: 'WETH' });
    expect(defaultPoolRange('Arbitrum One')).toEqual({ rangeUnit: 'TICK', lower: '-887220', upper: '887220' });
    expect(() => createCatalogLiquidityNode('node-002', { network: 'Arbitrum One', tokenA: 'ETH', tokenB: 'USDC', amountA: '1', amountB: '10',
      fee: 500, rangeUnit: 'FULL', slippage: '100' })).toThrow('UNISWAP_TOKEN_UNSUPPORTED');
  });
  it('refuses foreign same-symbol asset identities and an unsorted IR, without substitution', async () => {
    const s = await setup(), w = workflow();
    const foreign = JSON.parse(JSON.stringify(w).replaceAll(UNI.usdc, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'));
    await expect(s.service.simulate(foreign, UNI_OWNER)).rejects.toThrow('CATALOG_ASSET_IDENTITY_CHANGED');
    const unsorted = JSON.parse(JSON.stringify(w).replaceAll(UNI.weth, 'TOKEN_A').replaceAll(UNI.usdc, UNI.weth).replaceAll('TOKEN_A', UNI.usdc));
    await expect(s.service.simulate(unsorted, UNI_OWNER)).rejects.toThrow(); expect(s.chain.counters.sends).toBe(0);
    await expect(s.service.simulate(JSON.parse(JSON.stringify(w).replaceAll(chainId, 'eip155:8453')), UNI_OWNER)).rejects.toThrow('UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED');
  });
  it.each([[100, 1], [500, 10], [3000, 60], [10000, 200]])('tier %i uses spacing %i, valid boundaries and refuses misalignment', (fee, spacing) => {
    const bounds = uniswapUsableTicks(spacing), full = workflow(fee), fields = readConcentratedLiquidity(full.nodes.at(-1)!);
    expect([fields.tickLower, fields.tickUpper]).toEqual([bounds.min, bounds.max]);
    expect(() => validateUniswapLiquidityNode(full.nodes.at(-1)!)).not.toThrow();
    const range = uniswapBandAroundSqrtPrice(sqrtRatioAtTick(-225_600), 1000, spacing);
    expect(Math.abs(range.tickLower % spacing)).toBe(0); expect(Math.abs(range.tickUpper % spacing)).toBe(0);
    expect(range.tickLower).toBeLessThan(-225_600); expect(range.tickUpper).toBeGreaterThan(-225_600);
    if (spacing > 1) expect(() => workflow(fee, false, bounds.min + 1, bounds.max)).toThrow();
    expect(() => workflow(fee, false, bounds.max, bounds.min)).toThrow();
    expect(() => workflow(fee, false, -887_273, 887_273)).toThrow();
  });
  it('keeps canonical WETH-per-USDC price orientation and deterministic band-to-tick conversion', () => {
    const band = uniswapBandAroundSqrtPrice(sqrtRatioAtTick(-225_600), 1000, 10);
    const low = uniswapQuotePriceAtTick(band.tickUpper, 18, 6, 18), high = uniswapQuotePriceAtTick(band.tickLower, 18, 6, 18);
    expect(Number(low)).toBeLessThan(Number(high));
    const prices = uniswapAlignQuotePriceRange('0.0005', '0.0007', 18, 6, 10);
    expect(uniswapAlignQuotePriceRange('0.0005', '0.0007', 18, 6, 10)).toEqual(prices);
    expect(() => workflow(500, false, band.tickLower, band.tickUpper)).not.toThrow();
    expect(() => catalogPoolOn(chainId, token(asset('USDC')), token(asset('WETH')), 42)).toThrow('UNISWAP_FEE_TIER_UNSUPPORTED');
  });
  it.each([
    ['chain', 'UNISWAP_WRONG_CHAIN'], ['factory code', 'UNISWAP_UNEXPECTED_CONTRACT'], ['NPM code', 'UNISWAP_UNEXPECTED_CONTRACT'],
    ['NPM factory', 'UNISWAP_DEPLOYMENT_MISMATCH'], ['NPM WETH', 'UNISWAP_DEPLOYMENT_MISMATCH'], ['pool factory', 'UNISWAP_POOL_MISMATCH'],
    ['factory pool', 'UNISWAP_POOL_MISMATCH'], ['enabled spacing', 'UNISWAP_FEE_TIER_UNSUPPORTED'], ['pool spacing', 'UNISWAP_POOL_MISMATCH'],
    ['token order', 'UNISWAP_POOL_MISMATCH'], ['decimals', 'UNISWAP_TOKEN_MISMATCH'],
  ])('refuses wrong %s before simulation or a wallet request', async (kind, code) => {
    const s = await setup({ fault(method, params, value) {
      const call = params[0] as { to?: string; data?: string }, selector = call?.data?.slice(0, 10);
      if (kind === 'chain' && method === 'eth_chainId') return '0x2105';
      if (method === 'eth_getCode' && params[0] === (kind === 'factory code' ? UNI.factory : kind === 'NPM code' ? UNI.positionManager : null)) return '0x6000';
      if (method !== 'eth_call') return value;
      if (kind === 'NPM factory' && call.to === UNI.positionManager && selector === SEL.factory ||
          kind === 'NPM WETH' && call.to === UNI.positionManager && selector === SEL.weth9 || kind === 'pool factory' && call.to === s.profile.pool && selector === SEL.factory ||
          kind === 'factory pool' && selector === SEL.getPool || kind === 'token order' && selector === SEL.token0) return '0x' + addressWord('0x' + '1'.repeat(40));
      if (kind === 'enabled spacing' && selector === SEL.feeAmountTickSpacing || kind === 'pool spacing' && selector === SEL.tickSpacing ||
          kind === 'decimals' && selector === SEL.decimals) return '0x' + word(2n);
      return value;
    } });
    await expect(s.service.simulate(workflow(), UNI_OWNER)).rejects.toThrow(code);
    expect(s.chain.counters).toEqual({ sends: 0, simulate: 0 });
  });
});

describe('Arbitrum liquidity Review, fees, approvals and owner boundary', () => {
  it('refuses a missing catalog pool before simulation, Review or a wallet request', async () => {
    let missingPool = '';
    const s = await setup({ fault(method, params, value) {
      return method === 'eth_getCode' && params[0] === missingPool ? '0x' : value;
    } });
    missingPool = s.profile.pool;
    await expect(s.service.simulate(workflow(), UNI_OWNER)).rejects.toThrow('UNISWAP_CONTRACT_CODE_MISSING');
    expect(s.chain.counters).toEqual({ sends: 0, simulate: 0 });
  });
  it('binds exact canonical assets, range, pool, NPM, minimums, expiry, value, approvals and Nitro budget', async () => {
    const s = await setup(), run = await reviewed(s), r = run.review;
    expect(run.id).toMatch(/^arlp-[a-f0-9]{32}$/); expect(catalogNetworkOfRun(run.id, 'liquidity')?.id).toBe('arbitrum-one');
    expect(r).toMatchObject({ chainId: 42161, owner: UNI_OWNER, recipient: UNI_OWNER, contracts: { factory: UNI.factory, positionManager: UNI.positionManager, pool: s.profile.pool },
      pool: { fee: 500, tickSpacing: 10 }, token0: { address: UNI.weth, decimals: 18 }, token1: { address: UNI.usdc, decimals: 6 },
      intent: { amount0Max: '5000000000000000', amount1Max: '10000000', slippageBps: 100 } });
    expect(r.approvals.map(a => [a.token, a.spender, a.amount])).toEqual([[UNI.weth, UNI.positionManager, r.intent.amount0Max], [UNI.usdc, UNI.positionManager, r.intent.amount1Max]]);
    expect(decodeUniswapApprove(r.calls[0]!.data)).toEqual({ spender: UNI.positionManager, amount: 5_000_000_000_000_000n });
    expect(decodeUniswapMint(r.calls.at(-1)!.data)).toMatchObject({ token0: UNI.weth, token1: UNI.usdc, recipient: UNI_OWNER, fee: 500,
      amount0Min: BigInt(r.minimums.amount0Min), amount1Min: BigInt(r.minimums.amount1Min), deadline: BigInt(r.deadline) });
    expect(r.fees).toMatchObject({ maxFeePerGas: '2000000', maxPriorityFeePerGas: '0', l1FeeUpperBoundWei: '0' });
    expect(r.calls[0]!.gasLimit).toBe(String((46_000n + 20_000n) * 150n / 100n));
    expect(r.calls.at(-1)!.gasLimit).toBe(String((480_000n + 20_000n) * 150n / 100n));
    expect(s.calls.some(c => c.method === 'eth_maxPriorityFeePerGas')).toBe(false);
    expect(s.calls.some(c => c.method === 'eth_call' && (c.params[0] as { to: string }).to === '0x420000000000000000000000000000000000000f')).toBe(false);
    const begun = await s.service.begin(run.id, UNI_OWNER, workflow());
    expect(begun.transaction).toMatchObject({ chainId: '0xa4b1', from: UNI_OWNER, value: '0x0', maxPriorityFeePerGas: '0x0' });
    expect(BigInt(begun.transaction.maxFeePerGas)).toBe(BigInt(r.fees.maxFeePerGas));
    expect(s.calls.every(c => !/send|sign|wallet/i.test(c.method))).toBe(true); expect(s.chain.counters.sends).toBe(0);
    const bytes = new TextEncoder().encode(JSON.stringify(begun.record) + '\n');
    expect(FLOWS['arbitrum-liquidity'].projector(run.id + '.jsonl', bytes)?.run).toMatchObject({ flow: 'arbitrum-liquidity',
      runId: run.id, ownerAccount: UNI_OWNER, status: 'PREPARED', needsObservation: false });
    await s.service.handoff(run.id); await s.service.report(run.id, { kind: 'UNKNOWN' });
    expect(FLOWS['arbitrum-liquidity'].needsObservation(await s.service.load(run.id))).toBe(true);
  });
  it('gates default off and requires the existing network and owner gates; no liquidity-specific gate', async () => {
    expect(flowMode('arbitrum-liquidity', {})).toBe('off'); expect(disabledCode('arbitrum-liquidity')).toBe('ARBITRUM_MAINNET_NOT_ENABLED');
    expect(flowMode('arbitrum-liquidity', { GRYLOO_ROUTER: 'live' })).toBe('off');
    const env = { GRYLOO_ARBITRUM_MAINNET: 'live' }; expect(flowMode('arbitrum-liquidity', env)).toBe('live');
    expect(arbitrumOwnerExecutionEnabled('live', env)).toBe(false);
    expect(arbitrumOwnerExecutionEnabled('live', { ...env, GRYLOO_ARBITRUM_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' })).toBe(true);
    expect(CATALOG_NETWORKS['arbitrum-one'].flows.liquidity).toBe('arbitrum-liquidity');
    expect(FLOWS['arbitrum-liquidity'].runId.test('balp-' + 'a'.repeat(32))).toBe(false);
    expect(ARBITRUM_LIQUIDITY_RPC_METHODS).toContain('eth_simulateV1'); expect(ARBITRUM_LIQUIDITY_RPC_METHODS.join()).not.toMatch(/send|sign/);
    const s = await setup({ execution: false }), run = await reviewed(s);
    await expect(s.service.begin(run.id, UNI_OWNER, workflow())).rejects.toThrow('UNISWAP_EXECUTION_NOT_ENABLED');
    expect(s.chain.counters.sends).toBe(0);
  });
  it.each(['before begin', 'before handoff'])('invalidates Review if gas or price exceeds the bound %s', async boundary => {
    for (const method of ['eth_estimateGas', 'eth_gasPrice']) {
      let expensive = false;
      const s = await setup({ fault: (m, _p, value) => expensive && m === method ? '0xffffffffffff' : value }), run = await reviewed(s);
      if (boundary === 'before handoff') await s.service.begin(run.id, UNI_OWNER, workflow());
      expensive = true;
      const action = boundary === 'before handoff' ? s.service.handoff(run.id) : s.service.begin(run.id, UNI_OWNER, workflow());
      await expect(action).rejects.toThrow(method === 'eth_estimateGas' ? 'UNISWAP_GAS_CHANGED_REVIEW_REQUIRED' : 'UNISWAP_FEES_CHANGED_REVIEW_REQUIRED');
      expect((await s.service.load(run.id)).authorization).toBeNull(); expect(s.chain.counters.sends).toBe(0);
    }
  });
  it.each(['before begin', 'before handoff'])('requires new Review for material pool drift %s', async boundary => {
    const s = await setup(), run = await reviewed(s);
    if (boundary === 'before handoff') await s.service.begin(run.id, UNI_OWNER, workflow());
    s.chain.movePrice(1000);
    await expect(boundary === 'before handoff' ? s.service.handoff(run.id) : s.service.begin(run.id, UNI_OWNER, workflow())).rejects.toThrow('UNISWAP_STATE_CHANGED_REVIEW_REQUIRED');
    expect((await s.service.load(run.id)).authorization).toBeNull(); expect(s.chain.counters.sends).toBe(0);
  });
  it('refuses an expired Review, changed workflow, wrong owner and unreviewed commitment', async () => {
    const s = await setup(), run = await s.service.simulate(workflow(), UNI_OWNER);
    await expect(s.service.begin(run.id, UNI_OWNER, workflow())).rejects.toThrow('UNISWAP_REVIEW_REQUIRED');
    await expect(s.service.review(run.id, '0x' + '0'.repeat(64), workflow())).rejects.toThrow('UNISWAP_REVIEW_CHANGED');
    await s.service.review(run.id, run.review.commitment, workflow());
    await expect(s.service.begin(run.id, '0x' + '1'.repeat(40), workflow())).rejects.toThrow('UNISWAP_WRONG_OWNER');
    await expect(s.service.begin(run.id, UNI_OWNER, workflow(3000))).rejects.toThrow('UNISWAP_SEMANTIC_REVISION_CHANGED');
    s.chain.advance(61); await expect(s.service.begin(run.id, UNI_OWNER, workflow())).rejects.toThrow('UNISWAP_REVIEW_EXPIRED');
  });
  it('a newly required approval is never substituted for a reviewed mint; a changed spender fails closed', async () => {
    const s = await setup({ approved: true }), run = await reviewed(s);
    s.chain.externalAllowance('token0', 0n);
    await expect(s.service.begin(run.id, UNI_OWNER, workflow())).rejects.toThrow('UNISWAP_STATE_CHANGED_REVIEW_REQUIRED');
    expect((await s.service.load(run.id)).authorization).toBeNull();
    const w = workflow(), serialized = JSON.stringify(w).replaceAll(UNI.positionManager, '0x' + '1'.repeat(40));
    await expect(s.service.simulate(JSON.parse(serialized), UNI_OWNER)).rejects.toThrow('UNISWAP_LIQUIDITY_DECLARATION_INVALID');
    expect(s.chain.counters.sends).toBe(0);
  });
});

describe('Arbitrum liquidity durable recovery and position reconciliation', () => {
  it('refuses to recover a MOCKED journal as a public mainnet run', async () => {
    const s = await setup(), run = await reviewed(s);
    const publicReader = createUniswapLiquidityService({ storage: createFileExecutionStorage(s.path, 'UNISWAP_LIQUIDITY_BUSY'),
      rpc: async () => { throw Error('NO_PUBLIC_RPC_EXPECTED'); }, provenance: 'PUBLIC_MAINNET', executionEnabled: false,
      catalog: { chain: chainId, catalogFor: async () => catalog } });
    await expect(publicReader.load(run.id)).rejects.toThrow('UNISWAP_LIQUIDITY_STORE_CORRUPT');
    expect((await s.restart().load(run.id)).provenance).toBe('MOCKED'); expect(s.chain.counters.sends).toBe(0);
  });
  it('owner approvals and mint reconcile with actual Nitro receipt cost and MOCKED evidence', async () => {
    const s = await setup(), run = await reviewed(s);
    for (let step = 0; step < 3; step++) {
      const { begun } = await send(s, run.id); const settled = await s.service.observe(run.id);
      expect(begun.transaction.from).toBe(UNI_OWNER); expect(settled.attempts.at(-1)!.state).toBe('CONFIRMED');
      if (step < 2) { const fresh = await s.service.refresh(run.id); await s.service.review(run.id, fresh.review.commitment, workflow()); }
    }
    const result = await s.service.load(run.id);
    expect(result.verdict).toBe('RECONCILED'); expect(result.position?.owner).toBe(UNI_OWNER);
    expect(result.evidence).toMatchObject({ evidenceClass: 'MOCKED', chainId: 42161, positionManager: UNI.positionManager,
      bundle: { environment: 'MOCKED', outcome: 'RECONCILED' } });
    expect(result.attempts.every(a => a.receipt?.l1FeeWei === '0' && BigInt(a.receipt.gasCostWei) === BigInt(a.receipt.gasUsed) * BigInt(a.receipt.effectiveGasPrice))).toBe(true);
    expect(result.evidence!.transactions.every(t => t.explorer.startsWith('https://arbiscan.io/tx/'))).toBe(true);
    expect(await s.restart().observe(run.id)).toEqual(result); expect(s.chain.counters.sends).toBe(3);
  });
  it.each(['hash returned', 'hash lost', 'no result reported'])('recovers a mint after restart with %s; delayed receipts remain pending and no duplicate mint', async kind => {
    const s = await setup({ approved: true }), run = await reviewed(s), begun = await s.service.begin(run.id, UNI_OWNER, workflow());
    await s.service.handoff(run.id); const hash = s.chain.wallet.send(begun.transaction, { hold: true });
    if (kind === 'hash returned') await s.service.report(run.id, { kind: 'HASH', hash });
    if (kind === 'hash lost') await s.service.report(run.id, { kind: 'UNKNOWN' });
    const restart = s.restart(), pending = await restart.observe(run.id);
    expect(pending.verdict).toBe('PENDING'); expect(uniswapNeedsObservation(pending)).toBe(true);
    await expect(restart.begin(run.id, UNI_OWNER, workflow())).rejects.toThrow('UNISWAP_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
    await expect(restart.refresh(run.id)).rejects.toThrow('UNISWAP_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
    s.chain.wallet.release(); const result = await restart.observe(run.id);
    expect(result.verdict).toBe('RECONCILED'); expect(result.position?.transactionHash).toBe(hash);
    expect(await s.restart().observe(run.id)).toEqual(result); expect(s.chain.counters.sends).toBe(1);
    await expect(restart.begin(run.id, UNI_OWNER, workflow())).rejects.toThrow('UNISWAP_POSITION_ALREADY_MINTED');
  });
  it('recovers from an RPC interruption after inclusion before evidence, without saving a premature terminal success', async () => {
    let interrupt = false;
    const s = await setup({ approved: true, fault(method, params, value) {
      if (interrupt && method === 'eth_call' && (params[0] as { data: string }).data.startsWith(SEL.positions)) throw Error('RPC_TEMPORARILY_UNAVAILABLE');
      return value;
    } }), run = await reviewed(s); await send(s, run.id); interrupt = true;
    await expect(s.service.observe(run.id)).rejects.toThrow('RPC_TEMPORARILY_UNAVAILABLE');
    expect((await s.service.load(run.id)).verdict).toBe('PENDING'); interrupt = false;
    expect((await s.restart().observe(run.id)).verdict).toBe('RECONCILED'); expect(s.chain.counters.sends).toBe(1);
  });
  it('recovers after position readback when evidence reads time out, and retains the original receipt and tokenId', async () => {
    let evidenceFailure = false;
    const s = await setup({ approved: true, fault(method, params, value) {
      if (evidenceFailure && method === 'eth_call' && (params[0] as { data: string }).data.startsWith(SEL.allowance)) throw Error('UNISWAP_RPC_TIMEOUT');
      return value;
    } }), run = await reviewed(s), { hash } = await send(s, run.id); evidenceFailure = true;
    await expect(s.service.observe(run.id)).rejects.toThrow('UNISWAP_RPC_TIMEOUT');
    expect((await s.service.load(run.id)).verdict).toBe('PENDING'); evidenceFailure = false;
    const result = await s.restart().observe(run.id); expect(result.verdict).toBe('RECONCILED');
    expect(result.position?.transactionHash).toBe(hash); expect(await s.restart().observe(run.id)).toEqual(result);
    expect(s.chain.counters.sends).toBe(1);
  });
  it.each(['owner', 'token', 'fee', 'range', 'amount', 'NPM', 'receipt chain', 'receipt cost', 'offered gas', 'offered price', 'priority', 'nonce', 'approval spender'])('wrong %s becomes divergent and stays observation-only after restart', async kind => {
    let faulty = false;
    const s = await setup({ approved: kind !== 'approval spender', fault(method, params, value) {
      if (!faulty) return value;
      const call = params[0] as { data?: string };
      if (method === 'eth_call' && call.data?.startsWith(SEL.ownerOf) && kind === 'owner') return '0x' + addressWord('0x' + '1'.repeat(40));
      if (method === 'eth_call' && call.data?.startsWith(SEL.positions) && ['token', 'fee', 'range'].includes(kind)) {
        const words = (value as string).slice(2).match(/.{64}/g)!;
        words[kind === 'token' ? 2 : kind === 'fee' ? 4 : 5] = kind === 'token' ? addressWord(UNI.usdc) : word(kind === 'fee' ? 3000n : 1n);
        return '0x' + words.join('');
      }
      if (method === 'eth_getTransactionByHash' && kind === 'receipt chain') return { ...(value as object), chainId: '0x2105' };
      if (method === 'eth_getTransactionByHash' && ['offered gas', 'offered price', 'priority', 'nonce'].includes(kind)) {
        const field = kind === 'offered gas' ? 'gas' : kind === 'offered price' ? 'maxFeePerGas' : kind === 'priority' ? 'maxPriorityFeePerGas' : 'nonce';
        return { ...(value as object), [field]: '0xffffffffff' };
      }
      if (method === 'eth_getTransactionReceipt') {
        const receipt = structuredClone(value) as { gasUsed: string; logs: { address: string; topics: string[]; data: string }[] };
        if (kind === 'receipt cost') receipt.gasUsed = '0xffffffffff';
        if (kind === 'amount') receipt.logs.find(l => l.topics[0] === TOPIC.increaseLiquidity)!.data = '0x' + word(1n) + word(10n ** 30n) + word(1n);
        if (kind === 'NPM') receipt.logs.find(l => l.address === UNI.positionManager)!.address = '0x' + '1'.repeat(40);
        if (kind === 'approval spender') receipt.logs.find(l => l.topics[0] === TOPIC.approval)!.topics[2] = '0x' + addressWord('0x' + '1'.repeat(40));
        return receipt;
      }
      return value;
    } }), run = await reviewed(s); await send(s, run.id); faulty = true;
    const result = await s.service.observe(run.id);
    expect(result.verdict).toBe('DIVERGENT'); expect(result.evidence).toBeNull(); expect(result.authorization).toBeNull();
    expect(await s.restart().observe(run.id)).toEqual(result); expect(s.chain.counters.sends).toBe(1);
    await expect(s.service.begin(run.id, UNI_OWNER, workflow())).rejects.toThrow('UNISWAP_RECONCILIATION_REQUIRED');
  });
  it('a mined failure stays reverted; uncertain unconsumed submission reserves its owner nonce across runs', async () => {
    const s = await setup({ approved: true }), run = await reviewed(s), begun = await s.service.begin(run.id, UNI_OWNER, workflow());
    await s.service.handoff(run.id); await s.service.report(run.id, { kind: 'UNKNOWN' });
    const second = await reviewed(s); await expect(s.service.begin(second.id, UNI_OWNER, workflow())).rejects.toThrow('UNISWAP_OWNER_NONCE_IN_USE');
    const hash = s.chain.wallet.send(begun.transaction, { revert: true }); await s.service.report(run.id, { kind: 'HASH', hash });
    expect((await s.service.observe(run.id)).attempts.at(-1)!.state).toBe('REVERTED');
    expect(s.chain.counters.sends).toBe(1);
  });
});
