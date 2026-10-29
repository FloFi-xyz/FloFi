// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, initialEditor } from './editor';
import { canvasAddCommand } from './canvas-authoring';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from './execution-lifecycle';
import type { SimulationSource } from './simulation-presentation';
import { answerLanguage, bindingIssue, classifyAnswer, conversationExecution, conversationPhase, conversationReview, describeChatChange, lifecycleRequest, lostSteps, reviewBinding, workflowHash, type LifecycleView, sumByAsset } from './conversation-lifecycle';
import { conversationCopy } from './conversation-copy';
import { portuguese } from '../i18n/pt';
import { reviewFixture, reviewNow, reviewOwner } from '../test-utils/review-fixture';

function view(): LifecycleView & { manifest: ReturnType<typeof reviewFixture>['manifest'] } {
  const f = reviewFixture();
  return { workflow: f.workflow, context: f.context, source: f.source, authorization: f.authorization, wallet: f.wallet, progress: null, invalidWorkflow: false, manifest: f.manifest };
}
const hash = (c: string) => `0x${c.repeat(64)}`;
function withRun(attempts: { step: string; state: string; txHash: string | null }[], restored = false): LifecycleView {
  const v = view();
  const run = { workflow: v.workflow, quote: { executionId: 'conversation-run', nodeId: v.workflow.nodes.at(-1)!.nodeId, chainId: 84532, inputSymbol: 'USDC', outputSymbol: 'WETH' }, attempts };
  const state = { ...v.source.state, recoveryOnly: restored, run };
  return { ...v, source: { kind: 'public', state } as unknown as SimulationSource,
    progress: projectExecutionLifecycle(v.workflow, v.context, { kind: 'public', state } as unknown as ExecutionLifecycleSource) };
}

describe('BUILD-FLOFI-CONVERSATIONAL-001 conversational lifecycle', () => {
  it('binds a confirmation to the exact reviewed revision, workflow hash, Review authority, Manifest, wallet, network and expiry', () => {
    const v = view(), binding = reviewBinding(v, reviewNow)!;
    expect(binding).toMatchObject({ workflowId: v.workflow.workflowId, revision: v.workflow.revision, workflowHash: workflowHash(v.workflow), source: 'public',
      authorizationKey: 'test-review', account: reviewOwner, chain: v.wallet.chain });
    expect(binding.manifestHash).toBe(hashArtifactBytes('strategy-manifest', new TextEncoder().encode(JSON.stringify(v.manifest))));
    expect(binding.expiresAt).toBe(reviewNow + 120_000);
    expect(bindingIssue(binding, v, reviewNow)).toBeNull();
    // No wallet, no authority key, or an invalid workflow: nothing to confirm.
    expect(reviewBinding({ ...v, wallet: { ...v.wallet, account: null } }, reviewNow)).toBeNull();
    expect(reviewBinding({ ...v, authorization: { ...v.authorization, key: null } }, reviewNow)).toBeNull();
    expect(reviewBinding({ ...v, invalidWorkflow: true }, reviewNow)).toBeNull();
  });
  it('retires a confirmation when the workflow, quote, wallet or network changes, or the quote expires (never a stale "yes")', () => {
    const v = view(), binding = reviewBinding(v, reviewNow)!;
    const edited = editorReducer({ workflow: v.workflow, error: null }, { type: 'SET_SWAP_AMOUNT', nodeId: v.workflow.nodes.at(-1)!.nodeId, amount: '5', source: 'CHAT', baseRevision: v.workflow.revision }, v.context).workflow;
    expect(bindingIssue(binding, { ...v, workflow: edited }, reviewNow)).toBe('WORKFLOW_CHANGED');
    expect(bindingIssue(binding, { ...v, authorization: { ...v.authorization, key: 'a-new-simulation' } }, reviewNow)).toBe('REVIEW_REPLACED');
    expect(bindingIssue(binding, { ...v, authorization: { ...v.authorization, manifest: { ...v.manifest, nonce: '2' } } }, reviewNow)).toBe('REVIEW_REPLACED');
    expect(bindingIssue(binding, { ...v, wallet: { ...v.wallet, account: '0x3333333333333333333333333333333333333333' } }, reviewNow)).toBe('WALLET_CHANGED');
    expect(bindingIssue(binding, { ...v, wallet: { ...v.wallet, changed: true } }, reviewNow)).toBe('WALLET_CHANGED');
    expect(bindingIssue(binding, { ...v, wallet: { ...v.wallet, chain: 'eip155:8453' } }, reviewNow)).toBe('NETWORK_CHANGED');
    expect(bindingIssue(binding, v, reviewNow + 120_000)).toBe('QUOTE_EXPIRED');
    // The same account in another letter case is the same EVM wallet.
    expect(bindingIssue(binding, { ...v, wallet: { ...v.wallet, account: reviewOwner.toUpperCase().replace('0X', '0x') } }, reviewNow)).toBeNull();
  });
  it('accepts only an explicit answer to the open question; hedges, edits and the wrong question’s words change nothing', () => {
    for (const text of ['Yes, I confirm', 'yes', 'Confirm', 'Sim, confirmo', 'confirmo.', 'Eu confirmo']) expect(classifyAnswer(text, 'CONFIRM_WORKFLOW'), text).toBe('YES');
    for (const text of ['Yes, execute', 'Execute now', 'sim, executar', 'Pode executar', 'yes']) expect(classifyAnswer(text, 'CONFIRM_EXECUTION'), text).toBe('YES');
    for (const text of ['No', 'not now', 'Agora não', 'cancelar', 'wait']) for (const kind of ['CONFIRM_WORKFLOW', 'CONFIRM_EXECUTION', 'CONFIRM_CONTINUE'] as const) expect(classifyAnswer(text, kind), text).toBe('NO');
    for (const text of ['yes but make it 5 USDC', 'ok', 'sure', 'maybe', 'yes and add a bridge', 'swap 10 USDC to WETH on Base', 'sim, mas muda para 5']) {
      expect(classifyAnswer(text, 'CONFIRM_WORKFLOW'), text).toBe('UNCLEAR'); expect(classifyAnswer(text, 'CONFIRM_EXECUTION'), text).toBe('UNCLEAR');
    }
    // Confirming the workflow is not a request to execute it: "execute" answers only the execution question.
    expect(classifyAnswer('execute', 'CONFIRM_WORKFLOW')).toBe('UNCLEAR');
    expect(classifyAnswer('yes', 'NEXT_STEP')).toBe('UNCLEAR');
  });
  it('recognizes Review, Add, Execute, Status and Undo requests in English and Portuguese without the model, and nothing else', () => {
    for (const text of ['Review my workflow.', 'Revisar workflow', 'Let’s review', "Let's review", 'review', 'Simular meu fluxo', 'revisar o workflow!']) expect(lifecycleRequest(text), text).toBe('REVIEW');
    expect(lifecycleRequest('Add another action')).toBe('ADD'); expect(lifecycleRequest('Adicionar outra ação')).toBe('ADD');
    expect(lifecycleRequest('Execute my workflow')).toBe('EXECUTE'); expect(lifecycleRequest('check status')).toBe('STATUS'); expect(lifecycleRequest('Desfazer')).toBe('UNDO');
    expect(lifecycleRequest('Undo this change')).toBe('UNDO'); expect(lifecycleRequest('Desfazer esta alteração')).toBe('UNDO');
    for (const text of ['Swap 10 USDC to ETH on Base.', 'review the swap amount and make it 5', 'bridge 5 USDC from Base to Arbitrum']) expect(lifecycleRequest(text), text).toBeNull();
    expect(answerLanguage('Revisar workflow', 'EN')).toBe('PT'); expect(answerLanguage('Review my workflow', 'PT')).toBe('EN'); expect(answerLanguage('ok', 'PT')).toBe('PT');
  });
  it('reads the phase from the open question and the existing records, execution first', () => {
    const v = view(), empty = { ...v, workflow: initialEditor().workflow };
    expect(conversationPhase(empty, null, false, reviewNow)).toBe('AUTHORING');
    expect(conversationPhase(empty, null, true, reviewNow)).toBe('AWAITING_MISSING_FIELDS');
    expect(conversationPhase({ ...v, authorization: { ...v.authorization, key: null } }, null, false, reviewNow)).toBe('READY_TO_REVIEW');
    expect(conversationPhase({ ...v, source: { ...v.source, state: { ...v.source.state, busy: true } } as SimulationSource }, null, false, reviewNow)).toBe('SIMULATING');
    expect(conversationPhase(v, null, false, reviewNow)).toBe('REVIEW_AVAILABLE');
    const binding = reviewBinding(v, reviewNow)!;
    expect(conversationPhase(v, { kind: 'CONFIRM_WORKFLOW', binding }, false, reviewNow)).toBe('AWAITING_WORKFLOW_CONFIRMATION');
    expect(conversationPhase(v, { kind: 'CONFIRM_EXECUTION', binding }, false, reviewNow)).toBe('AWAITING_EXECUTION_CONFIRMATION');
    expect(conversationPhase({ ...v, authorization: { ...v.authorization, accepted: true } }, null, false, reviewNow)).toBe('WORKFLOW_CONFIRMED');
    expect(conversationPhase(withRun([{ step: 'approval', state: 'PENDING', txHash: hash('a') }]), null, false)).toBe('RECONCILING');
    expect(conversationPhase(withRun([{ step: 'approval', state: 'UNKNOWN', txHash: null }]), null, false)).toBe('UNCERTAIN');
    expect(conversationPhase(withRun([{ step: 'approval', state: 'REJECTED', txHash: null }]), null, false)).toBe('FAILED');
    expect(conversationPhase(withRun([{ step: 'approval', state: 'CONFIRMED', txHash: hash('a') }, { step: 'swap', state: 'REVERTED', txHash: hash('b') }]), null, false)).toBe('PARTIAL');
    expect(conversationPhase(withRun([{ step: 'approval', state: 'CONFIRMED', txHash: hash('a') }, { step: 'swap', state: 'CONFIRMED', txHash: hash('b') }]), null, false)).toBe('COMPLETED');
  });
  it('a declined wallet request is reported as not submitted, never as executed', () => {
    const execution = conversationExecution(withRun([{ step: 'approval', state: 'REJECTED', txHash: null }]))!;
    expect(execution).toMatchObject({ phase: 'FAILED', label: 'Transaction not submitted', final: true, completed: 0 });
    expect(execution.operations.every(operation => operation.hash === null)).toBe(true);
    expect(JSON.stringify(execution)).not.toMatch(/Execution completed|Confirmed/);
    const uncertain = conversationExecution(withRun([{ step: 'approval', state: 'UNKNOWN', txHash: null }], true))!;
    expect(uncertain).toMatchObject({ phase: 'UNCERTAIN', label: 'Execution status unresolved', final: true });
  });
  it('presents the Review from the existing projections only and names what the simulation does not provide', () => {
    const review = conversationReview(view(), reviewNow);
    expect(review).toMatchObject({ status: 'ready', canConfirm: true, account: reviewOwner, network: 'Base Sepolia' });
    expect(review.steps).toHaveLength(1);
    expect(review.steps[0]).toMatchObject({ number: 1, action: 'Swap', input: '100 USDC' });
    expect(review.limits.map(line => line.label)).toEqual(expect.arrayContaining(['Max spend', 'Max slippage']));
    // Nothing is estimated here: no fee line the simulation lacks is invented.
    for (const name of review.unknown) expect(review.fees.some(line => line.label.includes(name))).toBe(false);
    // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a pool quote has no network-fee line, so that cost is named unknown; the pool fee is included in the quote;
    // the FloFi fee says what this route actually does (nothing charged or recorded), and nothing is summed into a total.
    expect(review.unknown).toEqual(['Network cost']);
    expect(review.fees.every(line => line.treatment === 'INCLUDED')).toBe(true);
    expect(review.flofiFee).toEqual({ value: 'Not charged', note: expect.stringContaining('not collected on-chain'), recorded: false });
    expect(review.totals).toMatchObject({ additional: [], ceilings: [], excludes: [{ text: 'Network cost', parameters: [] }] });
    // The expected output is the record's own quote (100 USDC → 0.025 WETH in the fixture); with no record there is none, never a guess.
    expect(review.steps[0]!.result).toBe('0.025 WETH'); expect(review.steps[0]!.minimum).toBe('0.024875 WETH');
    const blocked = conversationReview({ ...view(), authorization: { ...view().authorization, key: null } }, reviewNow);
    expect(blocked.canConfirm).toBe(false);
    const unsimulated = view(), noRecord = { ...unsimulated, source: { kind: 'public', state: { busy: false, error: null, retired: false, recoveryOnly: false, available: true, run: null } } as unknown as SimulationSource,
      authorization: { ...unsimulated.authorization, key: null, manifest: null, policy: null } };
    expect(conversationReview(noRecord, reviewNow).steps[0]).toMatchObject({ result: null, minimum: null });
  });
  it('describes a committed change from the stored workflow, keeps unrelated steps, and never commits a change that drops an unnamed step', () => {
    const context = view().context, empty = initialEditor();
    const swap = editorReducer(empty, { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '10', slippage: '100', source: 'CHAT', baseRevision: 0 }, context).workflow;
    const [added] = describeChatChange(empty.workflow, swap, context, 'EN');
    expect(added).toMatch(/^Swap added to your workflow: 10 USDC/);
    expect(describeChatChange(empty.workflow, swap, context, 'PT')[0]).toMatch(/^Adicionado ao seu workflow: /);
    const nodeId = swap.nodes.at(-1)!.nodeId;
    const edited = editorReducer({ workflow: swap, error: null }, { type: 'SET_SWAP_AMOUNT', nodeId, amount: '5', source: 'CHAT', baseRevision: swap.revision }, context).workflow;
    expect(describeChatChange(swap, edited, context, 'EN')).toEqual([expect.stringMatching(/^Swap updated: 5 USDC/)]);
    const removal = { type: 'REMOVE', nodeId, source: 'CHAT', baseRevision: edited.revision } as const;
    const removed = editorReducer({ workflow: edited, error: null }, removal, context).workflow;
    expect(describeChatChange(edited, removed, context, 'EN')).toEqual(['Swap removed from your workflow. The other steps are unchanged.']);
    expect(lostSteps(edited, removed, removal, context)).toEqual([]);
    // A composition that replaces the workflow would drop the swap the owner did not name: it stays a Canvas proposal.
    const lending = canvasAddCommand('lending', edited.revision, reviewOwner);
    const replaced = editorReducer({ workflow: edited, error: null }, { ...lending, source: 'CHAT' }, context).workflow;
    expect(lostSteps(edited, replaced, { ...lending, source: 'CHAT' }, context)).toEqual(['1. Swap']);
  });
  it('has complete Portuguese copy for every lifecycle message', () => {
    const en = conversationCopy('EN'), pt = conversationCopy('PT');
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(pt.invalidated).sort()).toEqual(Object.keys(en.invalidated).sort());
    for (const [key, value] of Object.entries(pt)) if (typeof value === 'string') expect(value, key).not.toBe((en as unknown as Record<string, string>)[key]);
    // Projection labels the chat Review shows are translated by the shared catalog.
    for (const label of ['Max spend', 'Max slippage', 'Minimum received', 'Expected output', 'Network cost', 'Provider fees', 'FloFi fee', 'Token approval', 'Valid until']) expect(portuguese[label], label).toBeTruthy();
  });
});

describe('BUILD-FLOFI-CHAT-E2E-FIX-002 chat review additions', () => {
  it('an unapplied Canvas edit is applied or discarded only on an explicit answer', () => {
    for (const yes of ['Apply it', 'apply', 'Yes', 'Aplicar', 'sim']) expect(classifyAnswer(yes, 'RESOLVE_EDIT')).toBe('YES');
    for (const no of ['Discard it', 'discard', 'Descartar', 'No', 'não']) expect(classifyAnswer(no, 'RESOLVE_EDIT')).toBe('NO');
    for (const unclear of ['maybe', 'apply 30 instead', 'make it 5']) expect(classifyAnswer(unclear, 'RESOLVE_EDIT')).toBe('UNCLEAR');
    expect(answerLanguage('Descartar', 'EN')).toBe('PT');
  });
  it('sums cost lines exactly per asset (no conversion, no rounding) and counts what it cannot read', () => {
    expect(sumByAsset(['0.0001 ETH', '0.00002 ETH', '0.25 USDC', '1 USDC', 'about 3 dollars'])).toEqual({ sums: ['0.00012 ETH', '1.25 USDC'], unreadable: 1 });
    expect(sumByAsset(['0.1 ETH', '0.2 ETH'])).toEqual({ sums: ['0.3 ETH'], unreadable: 0 });
    expect(sumByAsset([])).toEqual({ sums: [], unreadable: 0 });
  });
});
