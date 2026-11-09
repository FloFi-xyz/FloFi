// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Editor's whole-workflow panel (EN/PT), rendered from a given hook state: what it says about a halted run, a refusal, an expired quote,
 * and when it offers "End workflow". Rendering calls no server action and no wallet (every one is a double that refuses to be called).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../app/editor-workflow-execution-action', () => {
  const never = async () => { throw new Error('NOT_CALLED_BY_RENDER'); };
  return { authorizeEditorWorkflow: never, editorWorkflowExecutionAvailability: never, reviewEditorWorkflow: never };
});
vi.mock('../app/approve-action', () => {
  const never = async () => { throw new Error('NOT_CALLED_BY_RENDER'); };
  return { authorizeUserFundedGroup: never, cancelWorkflowRunHandoff: never, prepareUserFundedGroup: never, reportUserFundedBatch: never, resumeWorkflowRunHandoff: never,
    workflowRunStatusHandoff: never };
});
vi.mock('./user-funded-browser', () => ({ sendWalletBatch: vi.fn(), signSolanaGroup: vi.fn(), signUserOperation: vi.fn(), walletBatchHashes: vi.fn(), walletProfile: vi.fn() }));
vi.mock('./wallet-proof', () => ({ useWalletProof: () => ({ proveEvm: vi.fn() }) }));
const { EditorWorkflowRunPanel } = await import('./editor-workflow-run');
const { LocaleProvider } = await import('../i18n/locale');
import type { EditorWorkflowRunState } from './editor-workflow-run';
import type { EditorExecutionReview } from '../editor/workflow-execution';
import type { RunView } from '../workflow-runs/service';
import type { Language } from '../i18n/locale';

const OWNER = '0x' + 'ab'.repeat(20), APPROVAL = 'apr_' + 'c'.repeat(26), PAST = '2020-01-01T00:00:00.000Z', FUTURE = '2999-01-01T00:00:00.000Z';
type Group = RunView['groups'][number];
const group = (index: number, patch: Partial<Group> = {}): Group => ({ index, chain: 'eip155:8453', strategy: 'EVM_WALLET_BATCH', signing: index ? 'WHEN_DUE' : 'UPFRONT',
  steps: [index, index], state: 'PLANNED', awaitsDelivery: null, code: null, validUntil: null, feePayer: OWNER, maxFee: null, gasPaid: null, submissions: [], batchId: null,
  signed: false, planned: null, ...patch });
const step = (index: number, state: string) => ({ index, action: 'swap', state, flow: null, stepWorkflowHash: null, code: null, bound: null, outcome: null });
const runOf = (patch: Partial<RunView>): RunView => ({ workflowRunId: 'wfr_' + 'c'.repeat(26), approvalId: APPROVAL, state: 'RUNNING', mode: 'USER_FUNDED', stepCount: 2,
  currentStep: 0, code: null, workflowHash: '0x' + '1'.repeat(64), expiresAt: FUTURE, completedAt: null, createdAt: PAST, updatedAt: PAST, stepsVisible: true,
  steps: [step(0, 'DELEGATED'), step(1, 'DELEGATED')], nextAction: 'OWNER_SIGNS_GROUP', groups: [group(0), group(1)], halted: null, authority: 'NONE', note: null, ...patch });
const review = (patch: Partial<EditorExecutionReview> = {}): EditorExecutionReview => ({ workflowHash: '0x' + '1'.repeat(64), stepCount: 2, owner: OWNER, reviewedAt: PAST,
  validUntil: FUTURE, mode: 'GROUPED', reasons: [], refusal: null,
  groups: [0, 1].map(i => ({ index: i, chain: 'eip155:8453', network: 'Base', strategy: 'EVM_WALLET_BATCH' as const, steps: [i, i] as const, signing: 'UPFRONT' as const,
    interactions: 1, setup: [], downgrades: [], calls: null, approvals: null, fee: null, healthFactorAfter: null })),
  steps: [0, 1].map(i => ({ index: i, action: 'swap', network: 'Base', chain: 'eip155:8453', provider: null, spend: null, basis: 'EXACT' as const, boundTo: null, expected: null,
    minimum: null, recipient: null })),
  counts: { walletPrompts: 2, atLeast: false, signatures: 2, transactions: 2, batchedCalls: 0, networkSwitches: 0, oneTimeSetup: [] }, ...patch });
const state = (patch: Partial<EditorWorkflowRunState>): EditorWorkflowRunState => ({ available: true, phase: 'running', review: null, error: null, run: null, updated: [],
  started: true, grouped: true, unrecorded: false, visible: true, earlier: false, stepByStep: false, unloaded: false, canReview: false, following: false,
  followEarlier: vi.fn(), hide: vi.fn(), resume: vi.fn(), startReview: vi.fn(), authorize: vi.fn(), confirmUpdate: vi.fn(), authorizeDue: vi.fn(), checkWallet: vi.fn(),
  end: vi.fn(), dismiss: vi.fn(), ...patch });
const render = (s: EditorWorkflowRunState, language: Language = 'EN') =>
  renderToStaticMarkup(<LocaleProvider initialLanguage={language}><EditorWorkflowRunPanel state={s}/></LocaleProvider>);
const END = '>End workflow</button>';

describe('Editor panel: "End workflow" follows the server\'s own rule (canEndWorkflow)', () => {
  it('a group whose batch the wallet reported NOT sent (blocked, authorization kept) halts a run that can be ended, and only ended', () => {
    const halted = runOf({ state: 'HALTED', currentStep: 1, nextAction: 'OWNER_DECIDES', steps: [step(0, 'RECONCILED'), step(1, 'BLOCKED')],
      groups: [group(0, { state: 'RECONCILED', signed: true }), group(1, { state: 'BLOCKED', signed: true, code: 'EIP5792_BATCH_NOT_SENT' })] });
    const html = render(state({ run: halted }));
    expect(html).toContain(END);
    expect(html).not.toContain('Resume the workflow');
    expect(render(state({ run: halted }), 'PT')).toContain('>Encerrar fluxo</button>');
  });
  it('never while a batch may be executing: authorized in the wallet, sent, or a prepared request still valid', () => {
    for (const g of [group(0, { state: 'AUTHORIZED', signed: true, batchId: '0x' + '12'.repeat(32) }), group(0, { state: 'SUBMITTED', signed: true }),
      group(0, { state: 'PREPARED', validUntil: FUTURE, batchId: '0x' + '12'.repeat(32) })])
      expect(render(state({ run: runOf({ groups: [g, group(1)] }) })), g.state).not.toContain(END);
    expect(render(state({ run: runOf({ groups: [group(0, { state: 'PREPARED', validUntil: FUTURE }), group(1)] }) }))).toContain('the workflow can be ended after that');
    // Its validity over, the prepared request can no longer execute (its on-chain deadline): the run can be ended.
    expect(render(state({ run: runOf({ groups: [group(0, { state: 'PREPARED', validUntil: PAST }), group(1)] }) }))).toContain(END);
  });
  it('never for a run with a step whose outcome is pending, nor while the wallet is being asked', () => {
    expect(render(state({ run: runOf({ state: 'ATTENTION', steps: [step(0, 'UNCERTAIN'), step(1, 'DELEGATED')], groups: [group(0, { state: 'UNCERTAIN', signed: true }), group(1)] }) })))
      .not.toContain(END);
    expect(render(state({ run: runOf({}), phase: 'wallet' }))).not.toContain(END);
    expect(render(state({ run: runOf({}) }))).toContain(END);
  });
  it('not from here while a user operation the owner signed has not been relayed (only /approve offers to cancel it)', () => {
    expect(render(state({ run: runOf({ groups: [group(0), group(1, { strategy: 'EVM_USER_OPERATION', state: 'AUTHORIZED', signed: true })] }) }))).not.toContain(END);
  });
});

describe('Editor panel: a halted run is described by what reached the chain', () => {
  const stopped = runOf({ state: 'HALTED', nextAction: 'OWNER_DECIDES', code: 'USER_FUNDED_SIMULATION_UNAVAILABLE', steps: [step(0, 'BLOCKED'), step(1, 'DELEGATED')],
    groups: [group(0, { state: 'BLOCKED', code: 'USER_FUNDED_SIMULATION_UNAVAILABLE' }), group(1)] });
  it('its first group refused for good when due, nothing reconciled: stopped before anything was sent, never "partially completed"', () => {
    const html = render(state({ run: stopped }));
    expect(html).toContain('Stopped before anything was sent: your funds stay in your wallet. You can run each step through its own flow from here, or end the workflow.');
    expect(html).not.toContain('Partially completed');
    expect(html).toContain('Resume the workflow');
    expect(html).toContain(END);
    const pt = render(state({ run: stopped }), 'PT');
    expect(pt).toContain('Parado antes de qualquer envio: seus fundos continuam na sua carteira.');
    expect(pt).not.toContain('Parcialmente');
  });
  it('a reconciled step is a partial completion', () => {
    const partial = runOf({ state: 'HALTED', currentStep: 1, nextAction: 'OWNER_DECIDES', steps: [step(0, 'RECONCILED'), step(1, 'BLOCKED')],
      groups: [group(0, { state: 'RECONCILED', signed: true }), group(1, { state: 'BLOCKED' })] });
    expect(render(state({ run: partial }))).toContain('Partially completed: the reconciled steps stay done');
  });
  it('nothing reconciled but something may have been sent: neither "nothing was sent" nor progress it did not make', () => {
    const maybeSent = [{ ...stopped, steps: [step(0, 'FAILED'), step(1, 'DELEGATED')] },
      ...[{ state: 'BLOCKED', signed: true }, { state: 'FAILED', signed: true }, { batchId: '0x' + '12'.repeat(32) },
        { planned: { steps: [], calls: 1, approvals: 0, healthFactorAfter: null } }].map(patch => ({ ...stopped, groups: [group(0, { state: 'BLOCKED', ...patch }), group(1)] }))];
    for (const run of maybeSent) {
      const html = render(state({ run }));
      expect(html, JSON.stringify(run.groups[0])).toContain('Stopped before any step completed. FloFi submits nothing more of this workflow');
      expect(html).not.toContain('Stopped before anything was sent');
      expect(html).not.toContain('Partially completed');
    }
    expect(render(state({ run: maybeSent[0]! }), 'PT')).toContain('Parado antes de qualquer etapa ser concluída');
  });
});

describe('Editor panel: refusals without a step never show one', () => {
  it('a refusal that arrives as a bare code (a preparation, an authorization) reads in words, never "step SIMULATION_REVERTED"', () => {
    for (const code of ['SIMULATION_REVERTED', 'SWAP_MINIMUM_NOT_MET']) {
      const html = render(state({ run: runOf({}), error: code }));
      expect(html, code).toContain('so your wallet was not asked');
      expect(html, code).not.toContain(code);
      expect(render(state({ run: runOf({}), error: code }), 'PT'), code).toContain('nada foi pedido à sua carteira');
    }
  });
  it('a Review refusal that names its step shows that step; one that does not never invents step 1', () => {
    const named = render(state({ run: null, started: false, review: review({ refusal: { code: 'SIMULATION_REVERTED', step: 1 } }) }));
    expect(named).toContain('step 2 would fail on chain now');
    const unnamed = render(state({ run: null, started: false, review: review({ refusal: { code: 'SWAP_MINIMUM_NOT_MET', step: null } }) }));
    expect(unnamed).toContain('A swap in this batch would deliver less than its signed minimum now');
    expect(unnamed).not.toContain('step 1');
  });
});

describe('Editor panel: an expired quote says what the owner can still do', () => {
  const expired = runOf({ groups: [group(0, { state: 'PREPARED', validUntil: PAST, batchId: '0x' + '12'.repeat(32) }), group(1)] });
  it('not handed to the wallet from this browser (or the wallet prompt is open): reject it, FloFi prepares a fresh one', () => {
    expect(render(state({ run: expired, review: review() }))).toContain('reject the request in your wallet; FloFi prepares a fresh one');
    expect(render(state({ run: expired, review: review(), unrecorded: true, phase: 'wallet' }))).toContain('reject the request in your wallet');
  });
  it('handed to the wallet and its answer lost: FloFi never asks again, so the owner checks the wallet and may end the workflow', () => {
    const html = render(state({ run: expired, review: review(), unrecorded: true }));
    expect(html).toContain('FloFi does not ask your wallet for it again');
    expect(html).not.toContain('reject the request in your wallet');
    expect(html).toContain(END);
    expect(render(state({ run: expired, review: review(), unrecorded: true }), 'PT')).toContain('a FloFi não pede esse lote de novo à sua carteira');
  });
});
