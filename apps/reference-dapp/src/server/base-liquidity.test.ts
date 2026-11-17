// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: Base mainnet concentrated liquidity on catalog pairs through the shared Uniswap v3 liquidity service (`balp-` runs), on a
 * MOCKED in-process chain with FloFi's Base token-list fixture: no network, no key, no send path but the scripted owner wallet. The OP Stack
 * L1 data fee is bounded at Review and read from each receipt. Evidence is MOCKED, never MAINNET_EXECUTED.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { decodeUniswapMint } from '@defi-workflow-engine/reference-compiler';
import { readConcentratedLiquidity, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { catalogPoolOn, UNISWAP_V3_BASE, type AssetCatalog, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { editorReducer, initialEditor } from '../domain/editor';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import { catalogLiquidityCopy, liquidityRunNetwork, parseBaseLiquidityChat } from '../domain/robinhood-liquidity-authoring';
import { parseLocalCommand } from '../domain/commands';
import { canvasAmountCommand } from '../domain/canvas-action-setup';
import { defaultPoolRange, selectCryptoNetwork } from '../domain/crypto-action-picker';
import { editorHistoryReducer, initialEditorHistory } from '../domain/editor-history';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER, type UniswapLiquidityChain } from '../../e2e/uniswap-liquidity-harness';
import { baseAsset, baseCatalog } from './base-mainnet.test-harness';
import { createUniswapLiquidityService, type UniswapBegin, type UniswapLiquidityRecord } from './uniswap-liquidity-service';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from '../domain/execution-lifecycle';
import { projectExecutionResult, REVIEW_EXPIRED_CONTINUE, REVIEW_EXPIRED_REFRESH } from '../domain/execution-result';
import { financialAttemptState } from '../domain/financial-run-status';
import { requotedMessage, simulationError } from '../domain/simulation-presentation';
import { currentUniswapAttempts, UNISWAP_REFRESH_IN_PLACE, uniswapRefreshInPlace, uniswapReviewAuthorizable, uniswapRunResumable } from '../domain/uniswap-liquidity-continuation';
import { translate } from '../i18n/translate';
import type { Rpc } from './public-testnet-service';

const context = createBaseSepoliaReviewContext();
const catalog = baseCatalog();
const USDC = baseAsset(catalog, 'USDC'), CBBTC = baseAsset(catalog, 'cbBTC');
const token = (asset: CanonicalAsset) => asset as { symbol: string; address: string; decimals: number };
const workflow = (fee = 500): SemanticWorkflow => {
  const result = editorReducer(initialEditor(), { type: 'ADD_CRYPTO_ACTION', source: 'CANVAS', baseRevision: 0, input: { selection: { action: 'pool', network: 'Base',
    from: 'USDC', to: 'cbBTC' }, amount: '100', secondAmount: '0.001', slippage: '100', fee } }, context);
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
};
type Setup = { chain: UniswapLiquidityChain; service: ReturnType<typeof createUniswapLiquidityService> };
async function setup(options: { catalogFor?: (chain: string) => Promise<AssetCatalog>; executionEnabled?: boolean } = {}): Promise<Setup> {
  const profile = catalogPoolOn('eip155:8453', token(USDC), token(CBBTC), 500);
  const usdcIs0 = profile.token0.address === USDC.address;
  // cbBTC ≈ 100,000 USDC: the raw token1/token0 price decides the tick.
  const chain = createUniswapLiquidityChain({ profile, tick: usdcIs0 ? -69_082 : 69_082, usdc: usdcIs0 ? 1_000_000_000n : 10_000_000n, weth: usdcIs0 ? 10_000_000n : 1_000_000_000n });
  const dir = await mkdtemp(join(tmpdir(), 'flofi-base-lp-'));
  const sepolia: Rpc = async () => { throw new Error('BASE_SEPOLIA_CLIENT_MUST_NOT_BE_USED'); };
  const service = createUniswapLiquidityService({ storage: createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY'), rpc: sepolia, rpcs: { 'eip155:8453': chain.rpc },
    provenance: 'MOCKED', now: chain.clock, mockedCodePins: UNI_MOCK_CODE_PINS, executionEnabled: options.executionEnabled ?? true,
    catalog: { chain: 'eip155:8453', catalogFor: options.catalogFor ?? (async () => catalog), codePins: chain.catalogPins } });
  return { chain, service };
}
beforeAll(() => registerNetworkCatalog(catalog));
afterAll(() => resetNetworkCatalogs());

describe('BUILD-BASE-001 Base liquidity authoring', () => {
  it('authors any two Base catalog tokens at a standard tier in pool order, and Chat = Canvas', () => {
    const node = workflow().nodes.find(n => n.actionType === 'asset.liquidity.concentrated')!, f = readConcentratedLiquidity(node);
    const P = catalogPoolOn('eip155:8453', token(USDC), token(CBBTC), 500);
    expect(node.chainId).toBe('eip155:8453');
    expect([f.token0.address, f.token1.address]).toEqual([P.token0.address, P.token1.address]);
    expect([f.feeTier, f.tickLower, f.tickUpper]).toEqual([500, -887_270, 887_270]);
    expect(parseBaseLiquidityChat('Add liquidity 100 USDC and 0.001 cbbtc on Base fee 0.05%')).toMatchObject({ network: 'Base', tokenB: 'cbBTC', fee: 500, rangeUnit: 'FULL' });
    const chat = parseLocalCommand('add liquidity 100 USDC and 0.001 cbBTC on Base fee 0.05% slippage 100 bps', initialEditor().workflow, context, null);
    const viaChat = editorReducer(initialEditor(), chat, context).workflow.nodes.at(-1);
    expect(JSON.stringify(viaChat)).toBe(JSON.stringify(node));
  });
  // A Base pool used to start at Base Sepolia's 0.05% ticks (±887270), which the default 0.3% tier (spacing 60) cannot use: Review failed and
  // the toolbox card never applied (canvas-ux browser profile). Every catalog network now starts at its default tier's full range.
  it('starts a new Pool card on Base at the default tier\'s full range, so the toolbox flow reviews and applies', () => {
    for (const [network, tick] of [['Base', '887220'], ['Robinhood Chain', '887220'], ['Base Sepolia', '887270'], ['Ethereum Sepolia', '887220'], ['Solana Devnet', '443584']] as const)
      expect(defaultPoolRange(network), network).toEqual({ rangeUnit: 'TICK', lower: `-${tick}`, upper: tick });
    let history = editorHistoryReducer(initialEditorHistory(), { type: 'START_ACTION_SETUP', action: 'pool', position: { x: 10, y: 20 } });
    const id = history.actionSetup!.id;
    history = editorHistoryReducer(history, { type: 'EDIT_CRYPTO_SELECTION', id, selection: selectCryptoNetwork('pool', 'Base'), context });
    expect(history.actionSetup).toMatchObject({ cryptoSelection: { network: 'Base' }, input: { rangeUnit: 'TICK', lower: '-887220', upper: '887220' } });
    const setup = history.actionSetup as Extract<NonNullable<typeof history.actionSetup>, { action: 'pool' }>;
    history = editorHistoryReducer(history, { type: 'EDIT_POOL_SETUP', id, input: { ...setup.input, maxUsdc: '0.0001', maxWeth: '1' } });
    const command = canvasAmountCommand(history.editor, history.actionSetup, history.amountInputs, id, context, {}, history.cryptoSelections);
    const next = editorReducer(history.editor, command, context);
    expect(next.error).toBeNull();
    const node = next.workflow.nodes.at(-1)!;
    expect(node).toMatchObject({ actionType: 'asset.liquidity.concentrated', chainId: 'eip155:8453' });
    // The default 0.3% tier at its full range (tick spacing 60).
    const fields = readConcentratedLiquidity(node as Parameters<typeof readConcentratedLiquidity>[0]);
    expect([fields.feeTier, fields.tickLower, fields.tickUpper]).toEqual([3000, -887_220, 887_220]);
  });
  it('presents a Base position as real funds on Base, never as a testnet profile', () => {
    expect(liquidityRunNetwork('eip155:8453')).toMatchObject({ network: 'Base', realFunds: true, robinhood: false, evidenceSlug: 'base-mainnet',
      profile: { chainHex: '0x2105', explorer: 'https://basescan.org/' } });
    expect(liquidityRunNetwork(8453)).toMatchObject({ network: 'Base', realFunds: true });
    // Robinhood Chain and the testnet profiles keep their presentation; nothing authored is still Base Sepolia, as before.
    expect(liquidityRunNetwork('eip155:4663')).toMatchObject({ network: 'Robinhood Chain', realFunds: true, robinhood: true, evidenceSlug: 'robinhood-chain' });
    expect(liquidityRunNetwork('eip155:84532')).toMatchObject({ network: 'Base Sepolia', realFunds: false, evidenceSlug: 'base-sepolia' });
    expect(liquidityRunNetwork('eip155:11155111')).toMatchObject({ network: 'Ethereum Sepolia', realFunds: false });
    expect(liquidityRunNetwork(undefined)).toMatchObject({ network: 'Base Sepolia', realFunds: false });
    // The catalog copy names the position's own network; Robinhood Chain's and the testnets' text is unchanged.
    const text = 'This pair has no live Uniswap v3 pool at this fee tier on Robinhood Chain. Choose another fee tier; nothing was signed.';
    expect(catalogLiquidityCopy(text, 'Base')).toBe('This pair has no live Uniswap v3 pool at this fee tier on Base. Choose another fee tier; nothing was signed.');
    expect(catalogLiquidityCopy('Robinhood Chain liquidity is not enabled on this server.', 'Base')).toBe('Base liquidity is not enabled on this server.');
    for (const network of ['Robinhood Chain', 'Base Sepolia']) expect(catalogLiquidityCopy(text, network)).toBe(text);
  });
});

describe('BUILD-BASE-001 Base liquidity service (MOCKED)', () => {
  it('binds chain 8453, the CREATE2 pool and both catalog identities into Review, with an L1 data fee bound', async () => {
    const { service } = await setup();
    const run = await service.simulate(workflow(), UNI_OWNER), r = run.review;
    expect(run.id).toMatch(/^balp-[a-f0-9]{32}$/);
    expect(r).toMatchObject({ chainId: 8453, network: 'Base', contracts: { positionManager: UNISWAP_V3_BASE.positionManager }, pool: { fee: 500, tickSpacing: 10 } });
    expect(r.stocks ?? []).toEqual([]);
    expect(r.calls.map(c => c.step)).toEqual(['APPROVE_TOKEN0', 'APPROVE_TOKEN1', 'MINT']);
    expect(decodeUniswapMint(r.calls[2]!.data)).toMatchObject({ fee: 500, recipient: UNI_OWNER });
    expect(BigInt(r.fees.l1FeeUpperBoundWei ?? '0')).toBeGreaterThan(0n);
  });
  it("approves, mints and reconciles on 0x2105 with each receipt's l1Fee; evidence is MOCKED", async () => {
    const { service, chain } = await setup(), w = workflow();
    const simulated = await service.simulate(w, UNI_OWNER), run = await service.review(simulated.id, simulated.review.commitment, w);
    for (let index = 0; index < 3; index++) {
      const begun: UniswapBegin = await service.begin(run.id, UNI_OWNER, w);
      expect(begun.transaction.chainId).toBe('0x2105');
      await service.handoff(run.id);
      await service.report(run.id, { kind: 'HASH', hash: chain.wallet.send(begun.transaction) });
      await service.observe(run.id);
    }
    const record = await service.load(run.id);
    expect(record.verdict).toBe('RECONCILED');
    expect(record.attempts.every(a => BigInt(a.receipt?.l1FeeWei ?? '0') > 0n)).toBe(true);
    expect(record.evidence).toMatchObject({ evidenceClass: 'MOCKED', chainId: 8453, bundle: { environment: 'MOCKED', outcome: 'RECONCILED' } });
    expect(record.evidence!.transactions.every(t => t.explorer.startsWith('https://basescan.org/'))).toBe(true);
  });
  it('fails closed: token list unavailable, a token no longer listed, no pool at the tier, owner execution not enabled', async () => {
    const w = workflow();
    await expect((await setup({ catalogFor: async () => { throw new Error('BASE_TOKEN_LIST_UNAVAILABLE'); } })).service.simulate(w, UNI_OWNER)).rejects.toThrow('BASE_TOKEN_LIST_UNAVAILABLE');
    const without: AssetCatalog = { ...catalog, assets: catalog.assets.filter(a => a.address !== CBBTC.address) };
    await expect((await setup({ catalogFor: async () => without })).service.simulate(w, UNI_OWNER)).rejects.toThrow('CATALOG_ASSET_IDENTITY_CHANGED');
    await expect((await setup()).service.simulate(workflow(3000), UNI_OWNER)).rejects.toThrow('UNISWAP_CONTRACT_CODE_MISSING');
    const off = await setup({ executionEnabled: false }), simulated = await off.service.simulate(w, UNI_OWNER);
    await off.service.review(simulated.id, simulated.review.commitment, w);
    await expect(off.service.begin(simulated.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_EXECUTION_NOT_ENABLED');
  });
  it('a Robinhood Chain service never serves a Base position', async () => {
    const { chain } = await setup(), dir = await mkdtemp(join(tmpdir(), 'flofi-base-lp-'));
    const robinhood = createUniswapLiquidityService({ storage: createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY'), rpc: chain.rpc, provenance: 'MOCKED',
      mockedCodePins: UNI_MOCK_CODE_PINS, now: chain.clock, catalog: { catalogFor: async () => catalog } });
    await expect(robinhood.simulate(workflow(), UNI_OWNER)).rejects.toThrow('UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED');
    expect(chain.counters.sends).toBe(0);
  });
});

/**
 * BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (EXEC-01): the production incident on Base (run balp-ae7ef0ce…, 1 USDC + 0.001 WETH). The WETH
 * approval (APPROVE_TOKEN0) confirmed and reconciled; the USDC approval (APPROVE_TOKEN1) was then PREPARED 1.8 s after the 60 s Review had
 * expired and refused at the wallet handoff (UNISWAP_WALLET_HANDOFF_NOT_AUTHORIZED). `begin` checked expiry only on entry and then spent
 * seconds on public reads and simulation before persisting the attempt. These tests reproduce that on the MOCKED chain, then certify the
 * continuation: refresh → updated Review → explicit authorization → only the remaining USDC approval → mint → reconcile.
 */
describe('EXEC-01 Review expiry between sequential wallet requests (MOCKED Base WETH/USDC)', () => {
  const WETH = baseAsset(catalog, 'WETH');
  const incidentWorkflow = (): SemanticWorkflow => {
    const result = editorReducer(initialEditor(), { type: 'ADD_CRYPTO_ACTION', source: 'CANVAS', baseRevision: 0, input: { selection: { action: 'pool', network: 'Base',
      from: 'USDC', to: 'WETH' }, amount: '1', secondAmount: '0.001', slippage: '100', fee: 500 } }, context);
    if (result.error) throw new Error(result.error);
    return structuredClone(result.workflow) as unknown as SemanticWorkflow;
  };
  /** `slow`: seconds the public network takes to answer the gas estimate of a prepare (the clock moves on while `begin` waits). */
  async function incident() {
    const profile = catalogPoolOn('eip155:8453', token(USDC), token(WETH), 500);
    expect(profile.token0.address).toBe(WETH.address);
    // WETH ≈ 3,000 USDC: token1 (USDC, 6 decimals) per token0 (WETH, 18 decimals) ≈ 3e-9 → tick ≈ −195,000. Balances: 1 WETH, 1,000 USDC.
    const chain = createUniswapLiquidityChain({ profile, tick: -195_000, usdc: 10n ** 18n, weth: 1_000_000_000n });
    const latency = { estimateGas: 0 };
    const rpc: Rpc = async (method, params) => {
      if (method === 'eth_estimateGas' && latency.estimateGas) { chain.advance(latency.estimateGas); latency.estimateGas = 0; }
      return chain.rpc(method, params);
    };
    const dir = await mkdtemp(join(tmpdir(), 'flofi-base-lp-exec01-'));
    const make = () => createUniswapLiquidityService({ storage: createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY'), rpc: async () => { throw new Error('UNUSED'); },
      rpcs: { 'eip155:8453': rpc }, provenance: 'MOCKED', now: chain.clock, mockedCodePins: UNI_MOCK_CODE_PINS,
      catalog: { chain: 'eip155:8453', catalogFor: async () => catalog, codePins: chain.catalogPins } });
    return { chain, latency, service: make(), make };
  }
  async function approveWeth(s: Awaited<ReturnType<typeof incident>>, w: SemanticWorkflow) {
    const simulated = await s.service.simulate(w, UNI_OWNER);
    expect(simulated.review.calls.map(c => c.step)).toEqual(['APPROVE_TOKEN0', 'APPROVE_TOKEN1', 'MINT']);
    expect(simulated.review.approvals.map(a => a.symbol)).toEqual(['WETH', 'USDC']);
    const run = await s.service.review(simulated.id, simulated.review.commitment, w);
    const begun = await s.service.begin(run.id, UNI_OWNER, w);
    expect(begun.attempt.step).toBe('APPROVE_TOKEN0');
    await s.service.handoff(run.id);
    await s.service.report(run.id, { kind: 'HASH', hash: s.chain.wallet.send(begun.transaction) });
    const observed = await s.service.observe(run.id);
    expect(observed.attempts[0]).toMatchObject({ step: 'APPROVE_TOKEN0', state: 'CONFIRMED', reconciled: true });
    return observed;
  }

  const secondsLeft = (s: Awaited<ReturnType<typeof incident>>, run: { review: { expiresAt: string } }) =>
    Math.floor((Date.parse(run.review.expiresAt) - s.chain.clock().getTime()) / 1000);

  it('reproduces the incident: a prepare that starts before expiry must not persist a wallet request after it', async () => {
    const s = await incident(), w = incidentWorkflow();
    const run = await approveWeth(s, w);
    // The USDC approval is begun 12 s before expiry and the public network takes 15 s to answer the gas estimate (in production the reads took
    // about 2 s and the attempt was persisted 1.8 s after expiry).
    s.chain.advance(secondsLeft(s, run) - 12);
    s.latency.estimateGas = 15;
    await expect(s.service.begin(run.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_REVIEW_EXPIRED');
    const after = await s.service.load(run.id);
    // No USDC request was prepared with the expired Review; the confirmed WETH approval is untouched; nothing else was sent.
    expect(after.attempts.map(a => [a.step, a.state])).toEqual([['APPROVE_TOKEN0', 'CONFIRMED']]);
    expect(after.error).toBe('UNISWAP_REVIEW_EXPIRED');
    // The expired Review's authorization is cleared, so nothing presents it as executable any more.
    expect(after.authorization).toBeNull();
    expect(s.chain.counters.sends).toBe(1);
  });

  it('a Review too close to expiry to reach the wallet is neither authorized nor used to prepare the next request', async () => {
    const s = await incident(), w = incidentWorkflow();
    const run = await approveWeth(s, w);
    // Fewer seconds left than the wallet handoff needs (UNISWAP_REVIEW_HANDOFF_MARGIN_MS): no attempt is prepared; the run asks for a refresh.
    s.chain.advance(secondsLeft(s, run) - 5);
    await expect(s.service.begin(run.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_REVIEW_EXPIRED');
    expect((await s.service.load(run.id)).attempts).toHaveLength(1);
    const fresh = await s.service.simulate(w, UNI_OWNER);
    s.chain.advance(secondsLeft(s, fresh) - 5);
    await expect(s.service.review(fresh.id, fresh.review.commitment, w)).rejects.toThrow('UNISWAP_REVIEW_EXPIRED');
  });

  it('the handoff names an expired Review (not a refusal) and concludes the provably unsent attempt, on entry and after its fresh reads', async () => {
    for (const late of ['entry', 'reads'] as const) {
      const s = await incident(), w = incidentWorkflow();
      const run = await approveWeth(s, w);
      const begun = await s.service.begin(run.id, UNI_OWNER, w);
      expect(begun.attempt.step).toBe('APPROVE_TOKEN1');
      // entry: the owner's wallet-session check outlasts the Review. reads: the handoff starts 2 s before expiry and its gas estimate takes 3 s.
      if (late === 'entry') s.chain.advance(secondsLeft(s, run) + 1);
      else { s.chain.advance(secondsLeft(s, run) - 2); s.latency.estimateGas = 3; }
      await expect(s.service.handoff(run.id), late).rejects.toThrow('UNISWAP_REVIEW_EXPIRED');
      const after = await s.service.load(run.id);
      expect(after.attempts.at(-1), late).toMatchObject({ step: 'APPROVE_TOKEN1', state: 'CANCELLED', note: 'UNISWAP_REVIEW_EXPIRED', transactionHash: null });
      expect(after).toMatchObject({ authorization: null, error: 'UNISWAP_REVIEW_EXPIRED' });
      expect(s.chain.counters.sends, late).toBe(1);
      // The browser's pre-wallet failure report finds the attempt already concluded and changes nothing.
      await expect(s.service.walletFailure(run.id, { invoked: false, calls: [], code: 'UNISWAP_REVIEW_EXPIRED' })).rejects.toThrow('UNISWAP_DIAGNOSTIC_NOT_PRE_SUBMISSION');
      // The same run continues: refresh keeps the confirmed WETH approval and the cancelled USDC attempt, and asks for the USDC approval again.
      const refreshed = await s.service.refresh(run.id);
      expect(refreshed.review.calls.map(c => c.step)).toEqual(['APPROVE_TOKEN1', 'MINT']);
      await s.service.review(run.id, refreshed.review.commitment, w);
      const again = await s.service.begin(run.id, UNI_OWNER, w);
      expect(again.attempt).toMatchObject({ step: 'APPROVE_TOKEN1', nonce: begun.attempt.nonce });
    }
  });

  it('continues the same run after expiry: refresh → updated Review → explicit authorization → USDC approval → mint → reconciled, WETH approved once', async () => {
    const s = await incident(), w = incidentWorkflow();
    const run = await approveWeth(s, w);
    s.chain.advance(secondsLeft(s, run) + 1);
    await expect(s.service.begin(run.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_REVIEW_EXPIRED');
    // A reload in between: a new service instance reads the same durable run.
    const restarted = s.make();
    await expect(restarted.review(run.id, run.review.commitment, w)).rejects.toThrow('UNISWAP_REVIEW_EXPIRED');
    const refreshed = await restarted.refresh(run.id);
    // The updated Review re-read the chain: the WETH allowance now suffices, so only the USDC approval and the mint remain; no authorization yet.
    expect(refreshed.authorization).toBeNull();
    expect(refreshed.review.commitment).not.toBe(run.review.commitment);
    expect(refreshed.review.calls.map(c => c.step)).toEqual(['APPROVE_TOKEN1', 'MINT']);
    expect(refreshed.review.approvals.map(a => [a.symbol, a.required])).toEqual([['WETH', false], ['USDC', true]]);
    expect(refreshed.attempts.map(a => [a.step, a.state])).toEqual([['APPROVE_TOKEN0', 'CONFIRMED']]);
    // Nothing is prepared without the owner's explicit authorization of the updated Review.
    await expect(restarted.begin(run.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_REVIEW_REQUIRED');
    await restarted.review(run.id, refreshed.review.commitment, w);
    for (const step of ['APPROVE_TOKEN1', 'MINT'] as const) {
      const begun = await restarted.begin(run.id, UNI_OWNER, w);
      expect(begun.attempt.step).toBe(step);
      expect(begun.attempt.reviewCommitment).toBe(refreshed.review.commitment);
      await restarted.handoff(run.id);
      await restarted.report(run.id, { kind: 'HASH', hash: s.chain.wallet.send(begun.transaction) });
      await restarted.observe(run.id);
    }
    const done = await restarted.load(run.id);
    expect(done.verdict).toBe('RECONCILED');
    expect(done.attempts.map(a => [a.step, a.state])).toEqual([['APPROVE_TOKEN0', 'CONFIRMED'], ['APPROVE_TOKEN1', 'CONFIRMED'], ['MINT', 'CONFIRMED']]);
    expect(done.attempts.filter(a => a.step === 'APPROVE_TOKEN0')).toHaveLength(1);
    expect(s.chain.counters.sends).toBe(3);
    // The evidence carries every transaction with the Review it was authorized under: the original for WETH, the refreshed one after.
    expect(done.evidence!.transactions.map(t => [t.step, t.reviewCommitment])).toEqual([['APPROVE_TOKEN0', run.review.commitment],
      ['APPROVE_TOKEN1', refreshed.review.commitment], ['MINT', refreshed.review.commitment]]);
    expect(done.position).toMatchObject({ owner: UNI_OWNER });
  });

  /** The run as the chat, the Canvas lifecycle and the Dashboard project it (the store's state, read-only). */
  const lifecycle = (record: UniswapLiquidityRecord) => projectExecutionLifecycle(record.workflow as never, context,
    { kind: 'uniswap-pool', state: { record, busy: false, error: null, retired: false, recovered: false, signing: false, requoted: null } } as unknown as ExecutionLifecycleSource);
  const operations = (record: UniswapLiquidityRecord) => lifecycle(record).steps.flatMap(step => step.operations).map(op => [op.id, op.state, op.reason ?? null]);

  it('the owner is told the Review expired (never declined or cancelled), keeps the confirmed WETH approval, and continues the same run', async () => {
    const s = await incident(), w = incidentWorkflow();
    const run = await approveWeth(s, w);
    const begun = await s.service.begin(run.id, UNI_OWNER, w);
    s.chain.advance(secondsLeft(s, run) + 1);
    await expect(s.service.handoff(run.id)).rejects.toThrow('UNISWAP_REVIEW_EXPIRED');
    const stopped = await s.service.load(run.id);
    expect(UNISWAP_REFRESH_IN_PLACE.test('UNISWAP_REVIEW_EXPIRED')).toBe(true);
    // Not submitted because the Review expired: the step says so, and the run's result explains how to continue.
    expect(financialAttemptState(stopped.attempts[1])).toBe('NOT_SUBMITTED');
    expect(operations(stopped)).toEqual([['APPROVE_TOKEN0', 'confirmed', null], ['APPROVE_TOKEN1', 'not-submitted', 'UNISWAP_REVIEW_EXPIRED'], ['MINT', 'waiting', null]]);
    expect(projectExecutionResult(lifecycle(stopped))).toMatchObject({ label: 'Execution partially completed', message: REVIEW_EXPIRED_CONTINUE });
    expect(simulationError('UNISWAP_REVIEW_EXPIRED')).toBe(REVIEW_EXPIRED_REFRESH);
    // The production record (USDC approval prepared 1.8 s after its Review expired, then cancelled by the browser with the hand-off's code before
    // this fix) reads the same way: the record itself proves the expiry.
    const lateAt = new Date(Date.parse(stopped.review.expiresAt) + 1_761).toISOString();
    const production = { ...stopped, attempts: [stopped.attempts[0]!, { ...stopped.attempts[1]!, createdAt: lateAt, note: 'UNISWAP_WALLET_HANDOFF_NOT_AUTHORIZED' }] } as UniswapLiquidityRecord;
    expect(financialAttemptState(production.attempts[1])).toBe('NOT_SUBMITTED');
    expect(operations(production)[1]).toEqual(['APPROVE_TOKEN1', 'not-submitted', 'UNISWAP_REVIEW_EXPIRED']);
    expect(projectExecutionResult(lifecycle(production))?.message).toBe(REVIEW_EXPIRED_CONTINUE);
    // A hand-off refusal of a request prepared while its Review was valid (cleared authorization, execution disabled) is not called an expiry:
    // still never "declined" or "cancelled by you", and nothing was sent.
    const refused = { ...production, attempts: [production.attempts[0]!, { ...production.attempts[1]!, createdAt: stopped.attempts[1]!.createdAt }] } as UniswapLiquidityRecord;
    expect(operations(refused)[1]).toEqual(['APPROVE_TOKEN1', 'not-submitted', 'UNISWAP_WALLET_HANDOFF_NOT_AUTHORIZED']);
    expect(projectExecutionResult(lifecycle(refused))?.message).not.toBe(REVIEW_EXPIRED_CONTINUE);
    // "Simulate again" refreshes this same run in place; the expired Review itself is not authorized again.
    expect([uniswapRunResumable(stopped), uniswapRefreshInPlace(stopped, false), uniswapRefreshInPlace(stopped, true)]).toEqual([true, true, false]);
    expect(uniswapReviewAuthorizable(stopped)).toBe(false);
    const refreshed = await s.service.refresh(run.id);
    // The updated Review is authorizable; the never-sent USDC attempt of the expired Review no longer holds its step; the confirmed WETH
    // approval stays in the run's history although the updated Review no longer asks for it.
    expect(uniswapReviewAuthorizable(refreshed)).toBe(true);
    expect(currentUniswapAttempts(refreshed).map(a => a.step)).toEqual(['APPROVE_TOKEN0']);
    expect(operations(refreshed)).toEqual([['APPROVE_TOKEN0', 'confirmed', null], ['APPROVE_TOKEN1', 'waiting', null], ['MINT', 'waiting', null]]);
    expect(lifecycle(refreshed).state).toBe('active');
    expect(begun.attempt.step).toBe('APPROVE_TOKEN1');
  });

  it('a request declined in the wallet is not re-authorized under the same Review: the owner refreshes first', async () => {
    const s = await incident(), w = incidentWorkflow();
    const run = await approveWeth(s, w);
    await s.service.begin(run.id, UNI_OWNER, w);
    await s.service.handoff(run.id);
    const declined = await s.service.walletFailure(run.id, { invoked: true, calls: [{ method: 'eth_sendTransaction', submission: true, error: { code: 4001 } }],
      code: 'UNISWAP_REJECTED', rejectionCode: 4001 });
    expect(financialAttemptState(declined.attempts[1])).toBe('REJECTED');
    expect(operations(declined)[1]).toEqual(['APPROVE_TOKEN1', 'failed', null]);
    expect(projectExecutionResult(lifecycle(declined))?.message).not.toBe(REVIEW_EXPIRED_CONTINUE);
    expect(uniswapReviewAuthorizable(declined)).toBe(false);
    expect(uniswapRefreshInPlace(declined, false)).toBe(true);
    expect(uniswapReviewAuthorizable(await s.service.refresh(run.id))).toBe(true);
  });

  it('runs that may still move funds are never refreshed, re-authorized or continued in place', () => {
    const base = { verdict: 'PENDING', review: { commitment: '0xb' } };
    const attempt = (patch: Record<string, unknown>) => ({ step: 'APPROVE_TOKEN1', state: 'CANCELLED', reconciled: false, reviewCommitment: '0xa', transactionHash: null, replacementHash: null, ...patch });
    const weth = attempt({ step: 'APPROVE_TOKEN0', state: 'CONFIRMED', reconciled: true, transactionHash: '0x' + '1'.repeat(64) });
    for (const blocking of [{ state: 'PENDING', transactionHash: '0x' + '2'.repeat(64) }, { state: 'SUBMISSION_RESULT_UNKNOWN' }, { state: 'SUBMITTING' }, { state: 'PREPARED' },
      { state: 'REVERTED', transactionHash: '0x' + '3'.repeat(64) }, { state: 'CANCELLED', transactionHash: '0x' + '4'.repeat(64) }, { state: 'NOT_FOUND' }]) {
      const record = { ...base, attempts: [weth, attempt(blocking)] };
      expect([uniswapRunResumable(record), uniswapRefreshInPlace(record, false), uniswapReviewAuthorizable(record)], JSON.stringify(blocking)).toEqual([false, false, false]);
    }
    expect(uniswapRunResumable({ ...base, verdict: 'RECONCILED', attempts: [weth] })).toBe(false);
    expect(uniswapRunResumable({ ...base, attempts: [weth, attempt({ step: 'MINT', state: 'CONFIRMED', reconciled: true, transactionHash: '0x' + '5'.repeat(64) })] })).toBe(false);
    expect(uniswapRunResumable({ ...base, attempts: Array.from({ length: 14 }, () => attempt({})) })).toBe(false);
    // Nothing landed yet: a separate new simulation, as before (the refresh in place continues only a started run).
    expect(uniswapRefreshInPlace({ ...base, attempts: [attempt({})] }, false)).toBe(false);
    // A run that already attempted its mint starts a new simulation on "Simulate again" (its duplicate-position guard stays as it is).
    expect(uniswapRefreshInPlace({ ...base, attempts: [weth, attempt({ step: 'APPROVE_TOKEN1', state: 'CONFIRMED', reconciled: true, transactionHash: '0x' + '6'.repeat(64) }),
      attempt({ step: 'MINT' })] }, false)).toBe(false);
  });

  it('says why the Review was refreshed in place, in English and Portuguese', () => {
    for (const code of ['UNISWAP_REVIEW_EXPIRED', 'UNISWAP_STATE_CHANGED_REVIEW_REQUIRED']) {
      const text = requotedMessage(code);
      expect(text).toMatch(/same position; anything already confirmed is kept and not repeated/);
      expect(translate('PT', text)).not.toBe(text);
    }
    expect(translate('PT', REVIEW_EXPIRED_CONTINUE)).toMatch(/^Sua revisão expirou/);
    // A bridge keeps its own re-quote wording.
    expect(requotedMessage('UNIVERSAL_REVIEW_EXPIRED')).toMatch(/fresh quote/);
  });

  it('after a reload, a started run that still needs the owner is restored on the untouched Canvas only, with no authority', () => {
    const w = incidentWorkflow();
    const restored = editorHistoryReducer(initialEditorHistory(), { type: 'RESTORE_LIQUIDITY_CANVAS', workflow: w });
    expect(JSON.stringify(restored.editor.workflow)).toBe(JSON.stringify(w));
    expect([restored.past.length, restored.future.length]).toEqual([0, 0]);
    // Never over an owner's own edits, and never a workflow that is not one liquidity position.
    const edited = editorHistoryReducer(initialEditorHistory(), { type: 'START_ACTION_SETUP', action: 'pool', position: { x: 10, y: 20 } });
    expect(editorHistoryReducer(edited, { type: 'RESTORE_LIQUIDITY_CANVAS', workflow: w })).toBe(edited);
    const authored = { ...initialEditorHistory(), editor: { workflow: workflow() as never, error: null } };
    expect(editorHistoryReducer(authored, { type: 'RESTORE_LIQUIDITY_CANVAS', workflow: w })).toBe(authored);
    const swap = editorReducer(initialEditor(), { type: 'ADD_CRYPTO_ACTION', source: 'CANVAS', baseRevision: 0, input: { selection: { action: 'swap', network: 'Base',
      from: 'USDC', to: 'WETH' }, amount: '1', slippage: '50' } }, context);
    if (!swap.error) expect(editorHistoryReducer(initialEditorHistory(), { type: 'RESTORE_LIQUIDITY_CANVAS', workflow: swap.workflow as never }).editor.workflow.nodes
      .every(n => n.actionType.startsWith('mock-'))).toBe(true);
  });

  it('a run at its 16-attempt limit refuses before reserving the owner\'s nonce, so a new run can still use it', async () => {
    const s = await incident(), w = incidentWorkflow();
    let run = await s.service.simulate(w, UNI_OWNER);
    // Sixteen requests that never reached the wallet (the browser stopped before each hand-off).
    for (let i = 0; i < 16; i++) {
      run = await s.service.review(run.id, run.review.commitment, w);
      await s.service.begin(run.id, UNI_OWNER, w);
      await s.service.observe(run.id);
      run = await s.service.refresh(run.id);
    }
    expect(run.attempts).toHaveLength(16);
    await s.service.review(run.id, run.review.commitment, w);
    await expect(s.service.begin(run.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_ATTEMPT_LIMIT_SIMULATE_AGAIN');
    expect(simulationError('UNISWAP_ATTEMPT_LIMIT_SIMULATE_AGAIN')).toMatch(/limit of wallet attempts/);
    const fresh = await s.service.simulate(w, UNI_OWNER);
    await s.service.review(fresh.id, fresh.review.commitment, w);
    expect((await s.service.begin(fresh.id, UNI_OWNER, w)).attempt.step).toBe('APPROVE_TOKEN0');
    expect(s.chain.counters.sends).toBe(0);
  });
});

