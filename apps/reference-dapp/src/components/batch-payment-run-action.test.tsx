// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (FE-BATCH-04): a lone Batch Payment has no per-card flow. Its whole-workflow action is always the one shown,
 * closed with the reason while that path cannot simulate it here (no FloFi account session, runs off on this deployment, the answer pending, a Review
 * that cannot run it as one atomic approval), never another runtime's Simulate. Rendering calls no server action and no wallet.
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
vi.mock('./user-funded-browser', () => ({ evmWalletKind: () => 'INJECTED', batchHandout: () => undefined, batchSponsorshipOf: () => null, keepBatchHandout: () => undefined, sendWalletBatch: vi.fn(), signSolanaGroup: vi.fn(), signUserOperation: vi.fn(), walletBatchHashes: vi.fn(), walletProfile: vi.fn() }));
vi.mock('./wallet-proof', () => ({ useWalletProof: () => ({ proveEvm: vi.fn() }) }));
const { BATCH_RUN_BLOCKED, EditorWorkflowSimulateAction, batchPaymentRunBlocked } = await import('./editor-workflow-run');
const { LocaleProvider } = await import('../i18n/locale');
const { portuguese } = await import('../i18n/pt');
import type { EditorWorkflowRunState } from './editor-workflow-run';
import type { EditorExecutionReview } from '../editor/workflow-execution';

const state = (patch: Partial<EditorWorkflowRunState>): EditorWorkflowRunState => ({ available: true, phase: 'idle', review: null, error: null, run: null,
  updated: [], started: false, grouped: false, unrecorded: false, visible: true, stepByStep: false, unloaded: false, canReview: true, availability: { known: true, code: null },
  resume: vi.fn(), startReview: vi.fn(), authorize: vi.fn(), confirmUpdate: vi.fn(), authorizeDue: vi.fn(), checkWallet: vi.fn(), end: vi.fn(), dismiss: vi.fn(), ...patch });

describe('FE-BATCH-04: a lone Batch Payment keeps its whole-workflow action, closed with the reason', () => {
  it('names why it cannot be simulated here, or nothing while it can (and once its run exists)', () => {
    expect(batchPaymentRunBlocked(state({}))).toBeNull();
    expect(batchPaymentRunBlocked(state({ started: true, canReview: false, available: true }))).toBeNull();
    expect(batchPaymentRunBlocked(state({ available: false, canReview: false, visible: false, availability: { known: false, code: null } }))).toBe(BATCH_RUN_BLOCKED.CHECKING);
    expect(batchPaymentRunBlocked(state({ available: false, canReview: false, visible: false, availability: { known: true, code: 'ACCOUNT_SESSION_REQUIRED' } }))).toBe(BATCH_RUN_BLOCKED.SIGN_IN);
    expect(batchPaymentRunBlocked(state({ available: false, canReview: false, visible: false, availability: { known: true, code: 'EDITOR_RUNS_NOT_ENABLED' } }))).toBe(BATCH_RUN_BLOCKED.UNAVAILABLE);
    // The path is on but held here (another execution of this browser, a restore): closed, never another runtime's Simulate.
    expect(batchPaymentRunBlocked(state({ canReview: false }))).toBe(BATCH_RUN_BLOCKED.HELD);
    // A Review that cannot run it as one atomic approval (or refused it for good): atomic only, never split into separate transfers.
    const review = (patch: Partial<EditorExecutionReview>) => ({ mode: 'ONE_WALLET_CONFIRMATION', refusal: null, ...patch }) as unknown as EditorExecutionReview;
    expect(batchPaymentRunBlocked(state({ stepByStep: true, review: review({ mode: 'STEP_BY_STEP' }) }))).toBe(BATCH_RUN_BLOCKED.ATOMIC_ONLY);
    expect(batchPaymentRunBlocked(state({ stepByStep: true, review: review({ refusal: { code: 'USER_FUNDED_SIMULATION_UNAVAILABLE', step: 0 } }) }))).toBe(BATCH_RUN_BLOCKED.ATOMIC_ONLY);
    // A grouped Review, or one refused for a safety reason, keeps the action open (the Review shows why; nothing is atomic-only about it).
    expect(batchPaymentRunBlocked(state({ review: review({}) }))).toBeNull();
    expect(batchPaymentRunBlocked(state({ review: review({ refusal: { code: 'USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE', step: 0 } }) }))).toBeNull();
  });

  // F2 (WS02 review): this case used to read the hook's error-derived `stepByStep` and answer ATOMIC_ONLY for any failed Review; only a Review itself
  // proves the atomic approval is unavailable, so each of these states now gets its own reason.
  it('F2: a held path, a sign-in, a failed Review and a failed availability answer each name their own reason, never "atomic only"', () => {
    // The hook is held (a restore, or an execution of this visit on another path): available false while the deployment answered on (code null).
    expect(batchPaymentRunBlocked(state({ held: true, available: false, canReview: false, visible: false, availability: { known: true, code: null } }))).toBe(BATCH_RUN_BLOCKED.HELD);
    expect(batchPaymentRunBlocked(state({ held: true, available: false, canReview: false, visible: false, availability: { known: false, code: null } }))).toBe(BATCH_RUN_BLOCKED.HELD);
    // A Review refused for want of a FloFi account session (the hook's error-derived `stepByStep` is true then): sign in, not atomic only.
    expect(batchPaymentRunBlocked(state({ stepByStep: true, error: 'ACCOUNT_SESSION_REQUIRED' }))).toBe(BATCH_RUN_BLOCKED.SIGN_IN);
    // A Review that failed for a moment: the action stays open to review again.
    for (const error of ['EDITOR_REVIEW_RATE_LIMITED', 'USER_FUNDED_RPC_UNAVAILABLE', 'EDITOR_EXECUTION_FAILED', 'EVM_WALLET_REQUIRED']) expect(batchPaymentRunBlocked(state({ error }))).toBeNull();
    // A Review that failed for a reason no retry changes: held, never claimed as atomic only.
    expect(batchPaymentRunBlocked(state({ stepByStep: true, error: 'EDITOR_WORKFLOW_SINGLE_STEP' }))).toBe(BATCH_RUN_BLOCKED.HELD);
    expect(batchPaymentRunBlocked(state({ stepByStep: true, error: 'BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION' }))).toBe(BATCH_RUN_BLOCKED.HELD);
    // An error beside a Review (e.g. an authorization refused) leaves the Review to be made again.
    expect(batchPaymentRunBlocked(state({ error: 'EDITOR_EXECUTION_PLAN_CHANGED', review: { mode: 'ONE_WALLET_CONFIRMATION', refusal: null } as unknown as EditorExecutionReview }))).toBeNull();
    // The availability answer failed for a moment: not "this deployment cannot".
    expect(batchPaymentRunBlocked(state({ available: false, canReview: false, visible: false, availability: { known: true, code: 'EDITOR_EXECUTION_FAILED' } }))).toBe(BATCH_RUN_BLOCKED.HELD);
    // The answer is still pending.
    expect(batchPaymentRunBlocked(state({ available: false, canReview: false, visible: false, availability: { known: false, code: null } }))).toBe(BATCH_RUN_BLOCKED.CHECKING);
    // Answered off without a code: off on this deployment.
    expect(batchPaymentRunBlocked(state({ available: false, canReview: false, visible: false, availability: { known: true, code: null } }))).toBe(BATCH_RUN_BLOCKED.UNAVAILABLE);
  });

  it('every reason exists in Portuguese and the closed action shows it', () => {
    for (const message of Object.values(BATCH_RUN_BLOCKED)) expect(portuguese[message], message).toBeTruthy();
    const closed = renderToStaticMarkup(<LocaleProvider initialLanguage="EN"><EditorWorkflowSimulateAction state={state({ available: false, canReview: false, visible: false,
      availability: { known: true, code: 'ACCOUNT_SESSION_REQUIRED' } })} disabled reason={BATCH_RUN_BLOCKED.SIGN_IN}/></LocaleProvider>);
    expect(closed).toMatch(/<button type="button" class="primary" data-lifecycle-action="workflow-simulate" disabled="">Simulate workflow<\/button>/);
    expect(closed).toContain('<p role="status">Sign in to your FloFi account to simulate and run this Batch Payment.</p>');
    const pt = renderToStaticMarkup(<LocaleProvider initialLanguage="PT"><EditorWorkflowSimulateAction state={state({ stepByStep: true })} disabled reason={BATCH_RUN_BLOCKED.ATOMIC_ONLY}/></LocaleProvider>);
    expect(pt).toContain(portuguese[BATCH_RUN_BLOCKED.ATOMIC_ONLY]!);
  });
});
