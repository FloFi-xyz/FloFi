// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: how a Uniswap position operation is presented (product Review, Execute lifecycle, evidence, Dashboard
 * run detail), from real Reviews and runs of the Uniswap liquidity service on the MOCKED in-process Base chain. EN and PT-BR.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { catalogPoolOn, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, initialEditor } from './editor';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { liquidityPositionOperationPhrase, projectSimulation, simulationAmount, uniswapPositionReviewLines, type SimulationSource } from './simulation-presentation';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from './execution-lifecycle';
import { projectExecutionEvidence } from './execution-evidence';
import { financialAttemptState } from './financial-run-status';
import { confirmedApproval, uniswapPositionReviewAuthorizable, uniswapPositionRunResumable, uniswapRunResumable } from './uniswap-liquidity-continuation';
import { projectDashboardRecord } from '../lib/dashboard/record-projection';
import { translate } from '../i18n/locale';
import { portuguese } from '../i18n/pt';
import type { Workflow } from './initial-workflow';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER } from '../../e2e/uniswap-liquidity-harness';
import { baseAsset, baseCatalog } from '../server/base-mainnet.test-harness';
import { createUniswapLiquidityService } from '../server/uniswap-liquidity-service';
import type { UniswapPositionRecord, UniswapPositionRequest } from '../server/uniswap-position-service';
import type { Rpc } from '../server/public-testnet-service';
import type { DashboardRunDetail } from '../lib/dashboard/types';

const context = createBaseSepoliaReviewContext();
const catalog = baseCatalog();
const USDC = baseAsset(catalog, 'USDC'), CBBTC = baseAsset(catalog, 'cbBTC');
const token = (asset: CanonicalAsset) => asset as { symbol: string; address: string; decimals: number };
const PROFILE = catalogPoolOn('eip155:8453', token(USDC), token(CBBTC), 500);
const USDC_IS_0 = PROFILE.token0.address === USDC.address;
const TICK = USDC_IS_0 ? -69_082 : 69_082;
const LOWER = Math.floor((TICK - 2_000) / 10) * 10, UPPER = Math.ceil((TICK + 2_000) / 10) * 10;
const view = (t: { symbol: string; address: string; decimals: number }) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals });

/** A real run of the service: the position's own pool node (MANAGE_LIQUIDITY_POSITION), the staged request, optionally executed by the scripted wallet. */
async function run(request: Omit<UniswapPositionRequest, 'tokenId'>, execute = false): Promise<{ record: UniswapPositionRecord; workflow: SemanticWorkflow }> {
  const chain = createUniswapLiquidityChain({ profile: PROFILE, tick: TICK, usdc: USDC_IS_0 ? 1_000_000_000n : 10_000_000n, weth: USDC_IS_0 ? 10_000_000n : 1_000_000_000n });
  const sepolia: Rpc = async () => { throw new Error('BASE_SEPOLIA_CLIENT_MUST_NOT_BE_USED'); };
  const service = createUniswapLiquidityService({ storage: createFileExecutionStorage(await mkdtemp(join(tmpdir(), 'flofi-unipm-present-')), 'UNISWAP_LIQUIDITY_BUSY'), rpc: sepolia,
    rpcs: { 'eip155:8453': chain.rpc }, provenance: 'MOCKED', now: chain.clock, mockedCodePins: UNI_MOCK_CODE_PINS, executionEnabled: true,
    catalog: { chain: 'eip155:8453', catalogFor: async () => catalog, codePins: chain.catalogPins } });
  const tokenId = chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 6_000_000_000n, owed0: 7n });
  chain.accrueFees(tokenId, 1_000n, 2_000n);
  const choice = { position: { protocol: 'UNISWAP_V3' as const, chain: 'eip155:8453', network: 'Base', manager: PROFILE.positionManager, pool: PROFILE.pool, positionId: tokenId, owner: UNI_OWNER },
    operation: request.operation, partBps: request.partBps, close: request.close };
  const result = editorReducer(initialEditor(), { type: 'MANAGE_LIQUIDITY_POSITION', choice, pool: { token0: view(PROFILE.token0), token1: view(PROFILE.token1), feeTier: 500,
    tickLower: LOWER, tickUpper: UPPER, amount0: '0', amount1: '0', slippageBps: 100 }, source: 'CHAT', baseRevision: 0 }, context);
  if (result.error) throw new Error(result.error);
  const workflow = structuredClone(result.workflow) as unknown as SemanticWorkflow;
  let record = await service.positionSimulate(workflow, UNI_OWNER, { ...request, tokenId });
  if (execute) {
    await service.positionReview(record.id, record.review.commitment, workflow);
    const begun = await service.positionBegin(record.id, UNI_OWNER, workflow);
    await service.positionHandoff(record.id);
    await service.positionReport(record.id, { kind: 'HASH', hash: chain.wallet.send(begun.transaction) });
    record = await service.positionObserve(record.id);
  }
  return { record, workflow };
}
const asMainnet = (record: UniswapPositionRecord): UniswapPositionRecord => ({ ...record, provenance: 'PUBLIC_MAINNET' });
const source = (record: UniswapPositionRecord) => ({ kind: 'uniswap-pool', state: { record, busy: false, error: null, retired: false, recovered: false, signing: false,
  requoted: null, available: true } }) as unknown as SimulationSource & ExecutionLifecycleSource;
const both = (text: string) => [text, translate('PT', text)];

beforeAll(() => registerNetworkCatalog(catalog));
afterAll(() => resetNetworkCatalogs());

describe('BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: Uniswap position operation presentation', () => {
  it('states a true floor: for a withdrawal, "collected, at least" is the enforced principal minimum plus owed tokens and fees (flofi-liquidity P2-1)', async () => {
    const { record } = await run({ operation: 'DECREASE', partBps: 5_000, close: false });
    const q = record.review, details = Object.fromEntries(uniswapPositionReviewLines(q).details.map(line => [line.label, line.value]));
    const floor = (min: string, owed: string) => (BigInt(min) + BigInt(owed)).toString();
    const pairOf = (a: string, b: string) => uniswapPositionReviewLines({ ...q, expected: { ...q.expected, collect0: a, collect1: b }, innerCalls: ['COLLECT'],
      liquidityToRemove: '0' } as typeof q).details.find(line => line.label === 'Collected, at least')!.value;
    expect(details['Collected, at least']).toBe(pairOf(floor(q.minimums.amount0Min, q.expected.owedAndFees0), floor(q.minimums.amount1Min, q.expected.owedAndFees1)));
    expect(details['Collected (expected)']).toBe(pairOf(q.expected.collect0, q.expected.collect1));
    expect(BigInt(q.minimums.amount0Min) + BigInt(q.expected.owedAndFees0)).toBeLessThanOrEqual(BigInt(q.expected.collect0));
    // A collection alone keeps its own floor (owed tokens only grow until execution) and has no separate expected row.
    const collect = (await run({ operation: 'COLLECT', partBps: null, close: false })).record.review;
    const collectRows = uniswapPositionReviewLines(collect).details.map(line => line.label);
    expect(collectRows).toContain('Collected, at least');
    expect(collectRows).not.toContain('Collected (expected)');
  });
  it('names each operation in plain words, distinguishing keeping the NFT from closing (burning) it, in EN and PT-BR', () => {
    const phrases = { collect: liquidityPositionOperationPhrase('UNISWAP_V3', 'COLLECT', false), decrease: liquidityPositionOperationPhrase('UNISWAP_V3', 'DECREASE', false),
      keep: liquidityPositionOperationPhrase('UNISWAP_V3', 'EXIT', false), close: liquidityPositionOperationPhrase('UNISWAP_V3', 'EXIT', true),
      orca: liquidityPositionOperationPhrase('ORCA', 'EXIT', true) };
    expect(phrases.collect).toBe('Collect owed tokens and fees (liquidity unchanged)');
    expect(phrases.keep).toBe('Remove all liquidity and collect (the position NFT stays in your wallet)');
    expect(phrases.close).toBe('Remove all liquidity, collect and close the position (burns the NFT)');
    expect(phrases.orca).toContain('the position NFT is closed and its account rent is refunded');
    for (const phrase of Object.values(phrases)) {
      const pt = translate('PT', phrase);
      expect(pt, phrase).not.toBe(phrase);
      expect(`${phrase} ${pt}`).not.toMatch(/\byield\b|rendimento/i);
    }
    expect(translate('PT', phrases.keep)).toContain('continua na sua carteira');
    expect(translate('PT', phrases.close)).toContain('queima o NFT');
  });

  it('a collection: owed tokens and fees, the collected amount as a lower bound, tokens returned as the pool\'s own, one wallet request, real funds', async () => {
    const { record } = await run({ operation: 'COLLECT', partBps: null, close: false });
    const lines = uniswapPositionReviewLines(record.review);
    expect(lines).toMatchObject({ action: 'Collect fees', input: `#${record.review.position.tokenId}`, resultLabel: 'Collected, at least', minimum: null });
    expect(lines.result).toMatch(/^≥ /);
    const labels = lines.details.map(line => line.label);
    for (const label of ['Operation', 'Protocol', 'Network', 'Position', 'Pool', 'Price range', 'Range state', 'Current price', 'Owed tokens and fees', 'Collected, at least',
      'Tokens returned', 'Position NFT', 'Deadline', 'Wallet requests']) expect(labels, label).toContain(label);
    expect(labels).not.toContain('Minimum principal (enforced)');
    expect(lines.details.find(line => line.label === 'Deadline')?.value).toBe('None (collect only)');
    expect(lines.details.find(line => line.label === 'Wallet requests')?.value).toBe('1');
    const messages = lines.warnings.map(w => w.message);
    expect(messages).toContain('The collected amount is a lower bound: you receive at least the amount shown; fees accrued until execution are also collected.');
    expect(messages).toContain('Tokens are returned to your wallet as the pool\'s own tokens; nothing is swapped or unwrapped.');
    expect(messages).toContain('This uses real funds. One wallet request to the Uniswap Position Manager; FloFi never signs or sends.');
    for (const message of [...messages, ...lines.details.map(line => line.label), lines.action, lines.resultLabel]) {
      // Every sentence and label has its PT-BR entry ("Pool" is the same word in both languages).
      expect(Object.hasOwn(portuguese, message), message).toBe(true);
      if (message.includes(' ')) expect(translate('PT', message), message).not.toBe(message);
      expect(both(message).join(' '), message).not.toMatch(/\byield\b|rendimento/i);
    }
    expect(translate('PT', 'Owed tokens and fees')).toBe('Tokens devidos e taxas');
    expect(translate('PT', 'Collected, at least')).toBe('Coletado, no mínimo');
  });

  it('a partial withdrawal: share, liquidity removed and remaining, expected principal and the enforced minimums with the slippage', async () => {
    const { record } = await run({ operation: 'DECREASE', partBps: 5_000, close: false });
    const q = record.review, lines = uniswapPositionReviewLines(q);
    expect(lines).toMatchObject({ action: 'Remove liquidity', input: `50% · #${q.position.tokenId}`, resultLabel: 'Expected principal returned' });
    const detail = (label: string) => lines.details.find(line => line.label === label)?.value;
    expect(detail('Liquidity removed')).toBe(`${q.liquidityToRemove} of ${q.position.liquidity} (50%)`);
    expect(detail('Liquidity remaining')).toBe(q.liquidityAfter);
    expect(detail('Minimum principal (enforced)')).toMatch(/ · 1% slippage$/);
    expect(lines.minimum).not.toBeNull();
    expect(detail('Position NFT')).toBe('Stays in your wallet');
    expect(lines.warnings.map(w => w.message)).toContain('The withdrawal reverts on chain if the principal returned is below the enforced minimum (your slippage limit).');
    expect(lines.warnings.map(w => w.message)).not.toContain('Closing burns the position NFT. This cannot be undone.');
  });

  it('an exit keeps the NFT unless the owner chose to close it; closing is said to burn it and be irreversible', async () => {
    const keep = uniswapPositionReviewLines((await run({ operation: 'EXIT', partBps: null, close: false })).record.review);
    const close = uniswapPositionReviewLines((await run({ operation: 'EXIT', partBps: null, close: true })).record.review);
    expect(keep).toMatchObject({ action: 'Remove all liquidity' });
    expect(keep.details.find(line => line.label === 'Position NFT')?.value).toBe('Stays in your wallet');
    expect(keep.warnings.map(w => w.message)).not.toContain('Closing burns the position NFT. This cannot be undone.');
    expect(close).toMatchObject({ action: 'Close position' });
    expect(close.details.find(line => line.label === 'Position NFT')?.value).toBe('Burned (closed)');
    // B (BUILD-FLOFI-LIQUIDITY-RELIABILITY-GLOBAL-PRECISION-001): the operation is the short Review's first row, never repeated as a banner; the
    // irreversible close stays a visible (non-technical) warning.
    expect(close.summary.find(line => line.label === 'Operation')?.value).toBe('Remove all liquidity, collect and close the position (burns the NFT)');
    expect(close.summary.find(line => line.label === 'Position NFT')?.value).toBe('Burned (closed)');
    expect(close.warnings.filter(w => !w.technical).map(w => w.message)).toEqual(expect.arrayContaining(['Closing burns the position NFT. This cannot be undone.']));
    expect(close.warnings.map(w => w.message)).not.toContain('Remove all liquidity, collect and close the position (burns the NFT)');
  });

  it('B: the short Review keeps only decisions; every engineering figure stays exact in the details (Technical details)', async () => {
    const { record } = await run({ operation: 'DECREASE', partBps: 2_500, close: false }), q = record.review;
    const lines = uniswapPositionReviewLines(q), label = (rows: readonly { label: string }[]) => rows.map(row => row.label);
    expect(label(lines.summary)).toEqual(['Operation', 'Pool', 'Position', 'You receive (estimated)', 'Minimum you receive', 'Slippage', 'Recipient', 'Position NFT',
      'Wallet requests']);
    // Amount rows are marked for display rounding: the estimate to nearest, the guaranteed minimum down; their values stay exact here.
    expect(lines.summary.find(row => row.label === 'You receive (estimated)')).toMatchObject({ amount: 'nearest' });
    expect(lines.summary.find(row => row.label === 'Minimum you receive')).toMatchObject({ amount: 'down' });
    // The minimum is only the floor the chain enforces (the principal minimum), exactly as recorded; the estimate includes owed tokens and fees.
    expect(lines.summary.find(row => row.label === 'Minimum you receive')!.value).toBe(
      `${simulationAmount(q.minimums.amount0Min, q.token0.decimals, q.token0.symbol)} + ${simulationAmount(q.minimums.amount1Min, q.token1.decimals, q.token1.symbol)}`);
    expect(lines.summary.find(row => row.label === 'You receive (estimated)')!.value).toBe(
      `${simulationAmount(q.expected.collect0, q.token0.decimals, q.token0.symbol)} + ${simulationAmount(q.expected.collect1, q.token1.decimals, q.token1.symbol)}`);
    for (const technical of ['Liquidity removed', 'Liquidity remaining', 'Price range', 'Range state', 'Current price', 'Deadline', 'Position Manager', 'Expected principal returned',
      'Minimum principal (enforced)', 'Owed tokens and fees', 'Collected (expected)', 'Collected, at least', 'Tokens returned'])
      expect(label(lines.details), technical).toContain(technical);
    expect(lines.details.find(row => row.label === 'Liquidity removed')!.value).toContain(q.liquidityToRemove);
    expect(lines.details.find(row => row.label === 'Position Manager')!.value).toBe(q.contracts.positionManager);
    // How the figures are built moves under Technical details; nothing material is hidden.
    expect(lines.warnings.filter(w => !w.technical).map(w => w.message)).toEqual(['This uses real funds. One wallet request to the Uniswap Position Manager; FloFi never signs or sends.']);
  });

  it('the product Review projects a position run as its operation — never as a deposit with token approvals — with the network fee bound', async () => {
    const { record, workflow } = await run({ operation: 'DECREASE', partBps: 2_500, close: false });
    const view = projectSimulation(workflow as unknown as Workflow, context, source(asMainnet(record)), Date.parse(record.review.observedAt));
    expect(view.status).not.toBe('blocked');
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]).toMatchObject({ action: 'Remove liquidity', provider: 'Uniswap V3', networks: ['Base'], resultLabel: 'Expected principal returned' });
    expect(view.steps[0]!.input).toBe(`25% · #${record.review.position.tokenId}`);
    expect(view.fees.map(line => line.label)).toEqual(['Maximum network fee']);
    expect(view.warnings.map(w => w.message)).not.toContain('Token approval is required before execution.');
    // A MOCKED run is never presented as a live, authorizable Review.
    expect(projectSimulation(workflow as unknown as Workflow, context, source(record), Date.parse(record.review.observedAt)).status).not.toBe('ready');
  });

  it('the Execute lifecycle, evidence and Dashboard run detail of a reconciled position run (record-projection is format-aware)', async () => {
    const { record, workflow } = await run({ operation: 'DECREASE', partBps: 5_000, close: false }, true);
    expect(record.verdict).toBe('RECONCILED');
    const progress = projectExecutionLifecycle(workflow as unknown as Workflow, context, source(record));
    expect(progress).toMatchObject({ state: 'complete', runKey: record.id, completed: 1 });
    expect(progress.steps[0]).toMatchObject({ action: 'Remove liquidity', input: `50% · #${record.review.position.tokenId}`, provider: 'Uniswap V3' });
    expect(progress.steps[0]!.operations).toMatchObject([{ id: 'DECREASE', title: 'Remove liquidity', state: 'confirmed', approval: false, wallet: true }]);
    const evidence = projectExecutionEvidence(source(record), progress);
    expect(evidence.wallet).toBe(UNI_OWNER);
    expect(evidence.operations.DECREASE!.values.map(v => v.label)).toEqual(expect.arrayContaining(['Liquidity removed', 'Liquidity remaining',
      'Principal returned · Token 1', 'Collected (owed tokens and fees included) · Token 1', 'Position NFT']));
    const detail = { run: { runId: record.id, workflowId: workflow.workflowId, flow: 'base-liquidity', status: 'RECONCILED', provenance: 'MOCKED', ownerAccount: UNI_OWNER, errorCode: null,
      needsObservation: false, attentionRequired: false, hasEvidence: true, createdAt: null, updatedAt: null }, attempts: [], evidence: [], record, evidenceUnavailable: false,
      recordUnavailable: false } as DashboardRunDetail;
    const projected = projectDashboardRecord(detail, context);
    expect(projected).toMatchObject({ state: 'complete', runKey: record.id });
    expect(projected?.evidence.operations.DECREASE?.values.length).toBeGreaterThan(0);
    // A record of another format in the same namespace is never projected as either.
    expect(projectDashboardRecord({ ...detail, record: { ...record, format: 'flofi.unknown.v1' } }, context)).toBeNull();
  });

  it('continuation guards: a position step is never a mint approval; a position run is resumable only while nothing could have been sent', async () => {
    const { record } = await run({ operation: 'COLLECT', partBps: null, close: false }, true);
    const confirmed = record.attempts[0]!;
    expect(confirmed).toMatchObject({ step: 'COLLECT', state: 'CONFIRMED', reconciled: true });
    expect(confirmedApproval(confirmed)).toBe(false);
    expect(confirmedApproval({ ...confirmed, step: 'APPROVE_TOKEN0' })).toBe(true);
    // A pending position run read by the mint continuation is never "resumable" because of its confirmed operation.
    expect(uniswapRunResumable({ ...record, verdict: 'PENDING' })).toBe(false);
    expect(uniswapPositionRunResumable({ ...record, verdict: 'PENDING' })).toBe(false);
    const unsent = { ...confirmed, state: 'CANCELLED' as const, transactionHash: null, receipt: null, reconciled: false, note: 'UNISWAP_REVIEW_EXPIRED' };
    expect(uniswapPositionRunResumable({ ...record, verdict: 'PENDING', attempts: [unsent] })).toBe(true);
    expect(uniswapPositionReviewAuthorizable({ ...record, verdict: 'PENDING', attempts: [unsent] })).toBe(false);
    expect(uniswapPositionReviewAuthorizable({ ...record, verdict: 'PENDING', attempts: [{ ...unsent, reviewCommitment: '0xearlier' }] })).toBe(true);
    expect(financialAttemptState({ ...unsent, note: 'UNISWAP_POSITION_STATE_CHANGED_REVIEW_REQUIRED' })).toBe('NOT_SUBMITTED');
    expect(financialAttemptState({ ...unsent, note: 'UNISWAP_REJECTED' })).toBe('REJECTED');
  });
});
