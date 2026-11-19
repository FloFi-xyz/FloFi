// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 within BUILD-FLOFI-UX-EDITOR-FINOPS-001's Editor: a position-management workflow (the real reducer's
 * MANAGE_LIQUIDITY_POSITION, its canonical marker) reads as its operation and position on Create (Canvas card, overview, footer count), in the
 * Simulate panel's "operations as configured", the Review's steps and the expired Review's summary — never as "Pool / Liquidity" with the node's
 * descriptive maxima as amounts — and is never re-authored as a deposit on the Canvas. EN and PT-BR.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintWorkflow } from '@defi-workflow-engine/reference-linter';
import { readConcentratedLiquidityManagement, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, initialEditor } from './editor';
import { composerActions, composerSummary } from './composer-presentation';
import { canSelectCryptoAssets, cryptoSelectionOf } from './crypto-action-picker';
import { canEditCanvasAmount, canvasAmountMessage } from './canvas-action-setup';
import { planCanvasDuplicate } from './editor-history';
import { workflowMixesPositionManagement } from './liquidity-positions';
import { canvasCardFlow, canvasCardParams } from './canvas-card-summary';
import { editorOverview } from './editor-overview';
import { editorStageReasons } from './editor-stages';
import { projectSimulation } from './simulation-presentation';
import { projectReview } from './review-presentation';
import { liquidityPositionResultRows, liquidityPositionSubject, liquidityPositionSummaryOf, liquidityPositionTitle, positionPreparationConflict,
  positionPreparationRefusal, positionWorkflowOf } from './liquidity-position-summary';
import { uniswapPositionRefreshInPlace } from './uniswap-liquidity-continuation';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { operationSteps } from '../components/operation-summary';
import { translate } from '../i18n/locale';
import { portuguese } from '../i18n/pt';
import type { Workflow } from './initial-workflow';
import { managedWorkflow, ORCA_POOL, orcaChoice, positionCatalog, positionContext as context, UNI_POOL, uniswapChoice } from './liquidity-position-editor.test-harness';

const MINT = 'Fm7mfcbKeHsUo2u8nDWjpcAfNudKk7XqzGu1QW8k6PJx';
const uni = (operation: Parameters<typeof uniswapChoice>[1], partBps: number | null = null, close = false, id = '123') => managedWorkflow(uniswapChoice(id, operation, partBps, close), UNI_POOL);
const orca = (operation: Parameters<typeof orcaChoice>[1], partBps: number | null = null, mint = MINT) => managedWorkflow(orcaChoice(mint, operation, partBps), ORCA_POOL);
const only = (workflow: Workflow) => composerActions(workflow)[0]!;
const summary = (workflow: Workflow) => composerSummary(workflow, only(workflow), context);
const both = (text: string) => [text, translate('PT', text)];
const unmarked = (workflow: Workflow): Workflow => ({ ...workflow, nodes: workflow.nodes.map(node => node.actionType === 'asset.liquidity.concentrated'
  ? readConcentratedLiquidityManagement(node as Parameters<typeof readConcentratedLiquidityManagement>[0]).node as typeof node : node) });

beforeAll(() => registerNetworkCatalog(positionCatalog));
afterAll(() => resetNetworkCatalogs());

describe('the configured position operation (Create)', () => {
  it('titles name the operation and the share; subjects name the position; both read in PT-BR and never say yield', () => {
    expect([liquidityPositionTitle('UNISWAP_V3', { operation: 'COLLECT', partBps: null, close: false }), liquidityPositionTitle('UNISWAP_V3', { operation: 'DECREASE', partBps: 5_000, close: false }),
      liquidityPositionTitle('UNISWAP_V3', { operation: 'DECREASE', partBps: 1_250, close: false }), liquidityPositionTitle('UNISWAP_V3', { operation: 'EXIT', partBps: null, close: false }),
      liquidityPositionTitle('UNISWAP_V3', { operation: 'EXIT', partBps: null, close: true }), liquidityPositionTitle('ORCA', { operation: 'EXIT', partBps: null, close: true })])
      .toEqual(['Collect fees', 'Remove 50% of liquidity', 'Remove 12.5% of liquidity', 'Remove all liquidity', 'Close position', 'Close position']);
    expect(liquidityPositionSubject('UNISWAP_V3', '123')).toBe('Uniswap v3 position #123');
    expect(liquidityPositionSubject('ORCA', MINT)).toBe('Orca position Fm7m…6PJx');
    expect(translate('PT', 'Remove 50% of liquidity')).toBe('Remover 50% da liquidez');
    expect(translate('PT', 'Uniswap v3 position #123')).toBe('Posição Uniswap v3 #123');
    expect(translate('PT', 'Orca position Fm7m…6PJx')).toBe('Posição Orca Fm7m…6PJx');
    for (const text of ['Collect fees', 'Remove all liquidity', 'Close position']) expect(translate('PT', text), text).not.toBe(text);
    for (const text of ['Remove 50% of liquidity', 'Uniswap v3 position #123', 'Collect fees', 'Close position']) expect(both(text).join(' ')).not.toMatch(/\byield\b|rendimento/i);
  });

  it('a Uniswap position step is its operation on its position (title, position, pair, network) — never "Pool / Liquidity" with the maxima as amounts', () => {
    const cases = [[uni('COLLECT'), 'Collect fees'], [uni('DECREASE', 5_000), 'Remove 50% of liquidity'], [uni('EXIT'), 'Remove all liquidity'],
      [uni('EXIT', null, true), 'Close position']] as const;
    for (const [workflow, title] of cases) {
      const card = summary(workflow);
      expect(card, title).toMatchObject({ action: title, provider: 'Uniswap v3', amount: 'Uniswap v3 position #123', linked: false });
      expect(card.chain).toMatch(/^Base/);
      expect(card.detail).toMatch(/^(USDC \/ cbBTC|cbBTC \/ USDC)$/);
      expect(card.liquidityValues).toBeUndefined();
      expect(card.position?.label).toBe(`${title} · Uniswap v3 position #123 · Base`);
      // The node's descriptive maxima (the principal it held when read) are never presented as amounts: the same node unmarked reads as a deposit.
      const deposit = summary(unmarked(workflow));
      expect(deposit.action).toBe('Pool / Liquidity');
      expect(deposit.liquidityValues).toHaveLength(2);
      for (const value of deposit.liquidityValues!) expect(JSON.stringify(card), value.amount).not.toContain(value.amount);
      expect(JSON.stringify(card)).not.toContain(deposit.amount);
    }
  });

  it('an Orca position step names its operation and position; an Orca exit always reads "Close position"', () => {
    for (const [workflow, title] of [[orca('COLLECT'), 'Collect fees'], [orca('DECREASE', 2_500), 'Remove 25% of liquidity'], [orca('EXIT'), 'Close position']] as const) {
      expect(summary(workflow), title).toMatchObject({ action: title, provider: 'Orca Whirlpools', chain: 'Solana', amount: 'Orca position Fm7m…6PJx', detail: 'SOL / USDC' });
      expect(summary(workflow).liquidityValues).toBeUndefined();
      expect(summary(workflow).position?.management.positionId).toBe(MINT);
    }
  });

  it('the Canvas never re-picks the position\'s network or pair, nor edits an amount on it (an unmarked deposit keeps its pickers)', () => {
    for (const workflow of [uni('DECREASE', 5_000), orca('EXIT')]) {
      expect(cryptoSelectionOf(only(workflow) as never)).toBeNull();
      expect(canSelectCryptoAssets(only(workflow) as never, workflow as never)).toBe(false);
      expect(canEditCanvasAmount(only(workflow), context, workflow)).toBe(false);
      const deposit = unmarked(workflow);
      expect(cryptoSelectionOf(only(deposit) as never)).toMatchObject({ action: 'pool' });
      expect(summary(deposit).action).toBe('Pool / Liquidity');
    }
  });

  it('card rows: a collection states no slippage (nothing is removed); a withdrawal keeps its slippage; the flow line is the position', () => {
    expect(canvasCardParams(only(uni('COLLECT'))).map(param => param.key)).toEqual(['fee-tier']);
    expect(canvasCardParams(only(uni('DECREASE', 5_000))).map(param => param.key)).toEqual(['slippage', 'fee-tier']);
    expect(canvasCardFlow(summary(uni('EXIT', null, true)))).toBe('Uniswap v3 position #123');
  });

  it('the Editor overview counts one configured step named by its operation (the real review: simulation still required, nothing to fix)', () => {
    const workflow = uni('DECREASE', 5_000);
    const overview = editorOverview(workflow, context, lintWorkflow(workflow as unknown as SemanticWorkflow, context));
    expect(overview).toMatchObject({ count: 1, state: 'configured', attention: [], networks: ['Base'] });
    expect(overview.steps[0]).toMatchObject({ action: 'Remove 50% of liquidity', flow: 'Uniswap v3 position #123' });
  });

  it('Create keeps a position operation its workflow\'s only step: adding, chatting or duplicating another step is refused with the separate-workflow reason', () => {
    const workflow = uni('DECREASE', 5_000), state = { workflow, error: null };
    for (const command of [{ type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '1', slippage: '50' } as const,
      { type: 'ADD_CRYPTO_ACTION', input: { selection: { action: 'swap', network: 'Base', from: 'USDC', to: 'WETH' }, amount: '1', slippage: '50' } } as const]) {
      for (const source of ['CANVAS', 'CHAT'] as const) {
        const next = editorReducer(state, { ...command, source, baseRevision: workflow.revision } as Parameters<typeof editorReducer>[1], context);
        expect(next, `${command.type} ${source}`).toEqual({ workflow, error: 'POSITION_WORKFLOW_HAS_OTHER_STEPS' });
      }
    }
    expect(canvasAmountMessage(new Error('POSITION_WORKFLOW_HAS_OTHER_STEPS'))).toBe('This action cannot be combined with the current workflow. Check its settings or use a separate workflow.');
    expect(planCanvasDuplicate(workflow, {}, [only(workflow).nodeId], context)).toBeNull();
    // Another operation on the same position stays a new revision of the same one-step workflow; removing the step empties it.
    const other = editorReducer(state, { type: 'MANAGE_LIQUIDITY_POSITION', choice: uniswapChoice('123', 'EXIT', null, true), pool: UNI_POOL, source: 'CANVAS', baseRevision: workflow.revision }, context);
    expect(other.error).toBeNull();
    expect(other.workflow.revision).toBe(workflow.revision + 1);
    expect(summary(other.workflow).action).toBe('Close position');
    expect(composerActions(editorReducer(state, { type: 'REMOVE', nodeId: only(workflow).nodeId, source: 'CANVAS', baseRevision: workflow.revision }, context).workflow)).toEqual([]);
    expect(workflowMixesPositionManagement(workflow)).toBe(false);
  });

  it('Simulate opens for a position workflow (it has an action); Execute waits for its simulation', () => {
    const workflow = orca('COLLECT');
    const actionable = workflow.nodes.some(node => !node.actionType.startsWith('mock-'));
    expect(editorStageReasons({ actionable, reviewed: false, lifecycleBeyondSimulation: false, executionEvidence: false }))
      .toEqual({ Simulate: null, Execute: 'Simulate the workflow first' });
  });
});

describe('the operations as configured (Simulate panel, expired Review summary) and the Review steps', () => {
  it('list the operation and the position, never deposit amounts', () => {
    expect(operationSteps(uni('DECREASE', 5_000), context)).toEqual([expect.objectContaining({ action: 'Remove 50% of liquidity', amount: 'Uniswap v3 position #123',
      positionOperation: 'DECREASE', recipient: null })]);
    expect(operationSteps(orca('EXIT'), context)).toEqual([expect.objectContaining({ action: 'Close position', amount: 'Orca position Fm7m…6PJx', detail: 'SOL / USDC',
      network: 'Solana', positionOperation: 'EXIT' })]);
    // Before any simulation the step reads as configured (the runtime's projection replaces it with the reviewed figures).
    const pending = projectSimulation(uni('COLLECT'), context);
    expect(pending.steps[0]).toMatchObject({ action: 'Collect fees', input: 'Uniswap v3 position #123', result: null });
    const review = projectReview(uni('EXIT', null, true), context, { kind: 'unavailable', state: { error: null, busy: false } },
      { key: null, manifest: null, owner: null, chain: null, ready: false, accepted: false, approve: null, approvals: [], tokens: [], limits: [], technical: null },
      { account: null, chain: null, environment: 'mainnet', changed: false });
    expect(review.steps[0]).toMatchObject({ action: 'Close position', input: 'Uniswap v3 position #123', provider: 'Uniswap v3' });
    expect(review.permissions).toEqual(['Close position']);
  });

  it('the result rows of a simulated position step: Simulate states the outcome only; Execute adds what is authorized (EN keys all have PT-BR)', () => {
    const step = { action: 'Remove liquidity', input: '50% · #123', result: '1 USDC + 2 cbBTC', resultLabel: 'Expected principal returned', minimum: '0.99 USDC + 1.98 cbBTC',
      networks: ['Base'], details: [
        { label: 'Operation', value: 'Remove part of the position\'s liquidity and collect' }, { label: 'Protocol', value: 'Uniswap V3' }, { label: 'Network', value: 'Base' },
        { label: 'Position', value: '#123' }, { label: 'Pool', value: 'USDC/cbBTC · 0.05%' }, { label: 'Liquidity removed', value: '50 of 100 (50%)' },
        { label: 'Liquidity remaining', value: '50' }, { label: 'Expected principal returned', value: '1 USDC + 2 cbBTC' },
        { label: 'Minimum principal (enforced)', value: '0.99 USDC + 1.98 cbBTC · 1% slippage' }, { label: 'Owed tokens and fees', value: '≥ 0.1 USDC + 0 cbBTC' },
        { label: 'Collected, at least', value: '1.1 USDC + 2 cbBTC' }, { label: 'Tokens returned', value: 'USDC and cbBTC to 0xabc' }, { label: 'Position NFT', value: 'Stays in your wallet' },
        { label: 'Deadline', value: '2026-11-19T12:00:00.000Z' }, { label: 'Wallet requests', value: '1' }, { label: 'Position Manager', value: '0xdef' }] };
    expect(liquidityPositionResultRows(step, 'simulate').map(row => row.label)).toEqual(['Remove liquidity', 'Liquidity removed', 'Liquidity remaining',
      'Expected principal returned', 'Minimum principal (enforced)', 'Owed tokens and fees', 'Collected, at least', 'Position NFT']);
    expect(liquidityPositionResultRows(step, 'simulate').find(row => row.label === 'Minimum principal (enforced)')?.value).toBe('0.99 USDC + 1.98 cbBTC · 1% slippage');
    const execute = liquidityPositionResultRows(step, 'execute').map(row => row.label);
    expect(execute).toEqual(['Operation', 'Protocol', 'Network', 'Position', 'Pool', 'Liquidity removed', 'Liquidity remaining', 'Expected principal returned',
      'Minimum principal (enforced)', 'Owed tokens and fees', 'Collected, at least', 'Tokens returned', 'Position NFT', 'Deadline', 'Position Manager', 'Wallet requests']);
    for (const label of execute) expect(Object.hasOwn(portuguese, label), label).toBe(true);
    // An Orca withdrawal's "Expected withdrawal" is its principal; the minimum without a detail is the step's own minimum.
    const orcaRows = liquidityPositionResultRows({ ...step, resultLabel: 'Expected withdrawal', details: [{ label: 'Position NFT', value: 'Closed (account rent refunded)' }] }, 'simulate');
    expect(orcaRows).toEqual([{ label: 'Remove liquidity', value: '50% · #123' }, { label: 'Expected principal returned', value: '1 USDC + 2 cbBTC' },
      { label: 'Minimum principal (enforced)', value: '0.99 USDC + 1.98 cbBTC' }, { label: 'Position NFT', value: 'Closed (account rent refunded)' }]);
  });
});

describe('preparing a position from the Dashboard on the open workflow', () => {
  it('asks before replacing other steps, never changes a workflow being executed, and re-prepares the same position in place', () => {
    const choice = uniswapChoice('123', 'COLLECT');
    expect(positionPreparationRefusal(initialEditor().workflow, choice, false)).toBeNull();
    // The same position with another operation: a new revision of the same workflow (no earlier Review can be authorized for it).
    expect(positionPreparationConflict(uni('DECREASE', 5_000), choice)).toBe(false);
    // Another position, a deposit or a swap: the owner explicitly starts a new workflow first.
    expect(positionPreparationRefusal(uni('DECREASE', 5_000, false, '456'), choice, false)).toBe('POSITION_WORKFLOW_HAS_OTHER_STEPS');
    expect(positionPreparationRefusal(unmarked(uni('DECREASE', 5_000)), choice, false)).toBe('POSITION_WORKFLOW_HAS_OTHER_STEPS');
    expect(positionPreparationRefusal(orca('EXIT'), choice, false)).toBe('POSITION_WORKFLOW_HAS_OTHER_STEPS');
    const swap = editorReducer(initialEditor(), { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '1', slippage: '50', source: 'CHAT', baseRevision: 0 }, context).workflow;
    expect(positionPreparationRefusal(swap, choice, false)).toBe('POSITION_WORKFLOW_HAS_OTHER_STEPS');
    expect(positionPreparationRefusal(uni('DECREASE', 5_000), choice, true)).toBe('POSITION_WORKFLOW_EXECUTING');
    expect(translate('PT', 'Your current workflow is still being executed or checked. Follow it in Operate; prepare this position once it has finished. Nothing was changed.'))
      .toContain('Operar');
  });
  it('a workflow is presented as a position operation only when that operation is its one step', () => {
    expect(positionWorkflowOf(uni('EXIT', null, true))).toMatchObject({ title: 'Close position', management: { operation: 'EXIT', close: true } });
    const swap = editorReducer(initialEditor(), { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '1', slippage: '50', source: 'CHAT', baseRevision: 0 }, context).workflow;
    expect(positionWorkflowOf({ ...swap, nodes: [...swap.nodes, only(uni('COLLECT'))] })).toBeNull();
    expect(positionWorkflowOf(swap)).toBeNull();
  });
  it('a malformed or absent marker is not a position (display only; every runtime refuses it)', () => {
    expect(liquidityPositionSummaryOf(only(unmarked(uni('COLLECT'))))).toBeNull();
    const workflow = uni('COLLECT'), node = only(workflow);
    const broken = { ...node, inputs: node.inputs.map(input => input.name === 'position-management' ? { ...input, value: 'COLLECT:not-an-id' } : input) };
    expect(liquidityPositionSummaryOf(broken as typeof node)).toBeNull();
  });
});

describe('"Refresh review" of a Uniswap position run (Execute C2)', () => {
  const run = (attempts: { state: string; transactionHash: string | null; replacementHash?: string | null }[], verdict = 'PENDING') => ({
    format: 'flofi.uniswap-position-run.v1' as const, verdict, owner: '0x' + 'a'.repeat(40),
    attempts: attempts.map(a => ({ step: 'DECREASE', reconciled: false, reviewCommitment: '0x1', replacementHash: null, ...a })) });
  it('refreshes the SAME run in place only while nothing of it was sent, it still stands for this choice and its owner is connected', () => {
    const owner = '0x' + 'A'.repeat(40);
    expect(uniswapPositionRefreshInPlace(run([]), false, owner)).toBe(true);
    expect(uniswapPositionRefreshInPlace(run([{ state: 'CANCELLED', transactionHash: null }]), false, owner)).toBe(true);
    expect(uniswapPositionRefreshInPlace(run([]), true, owner)).toBe(false);
    expect(uniswapPositionRefreshInPlace(run([]), false, '0x' + 'b'.repeat(40))).toBe(false);
    expect(uniswapPositionRefreshInPlace(run([]), false, null)).toBe(false);
    // A sent, pending, unknown or confirmed request is never refreshed (only observed); a final run starts a new simulation.
    for (const attempt of [{ state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: null }, { state: 'PENDING', transactionHash: '0x' + '1'.repeat(64) },
      { state: 'CONFIRMED', transactionHash: '0x' + '1'.repeat(64) }, { state: 'CANCELLED', transactionHash: '0x' + '1'.repeat(64) }])
      expect(uniswapPositionRefreshInPlace(run([attempt]), false, owner), attempt.state).toBe(false);
    expect(uniswapPositionRefreshInPlace(run([], 'RECONCILED'), false, owner)).toBe(false);
    expect(uniswapPositionRefreshInPlace(null, false, owner)).toBe(false);
  });
});
