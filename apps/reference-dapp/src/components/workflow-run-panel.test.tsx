// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: the multi-step approval panel shows every step's durable state, the authorization count of each mode and only the actions
 * the run allows now (EN/PT). Server actions are not called by rendering.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../app/approve-action', () => {
  const never = async () => { throw new Error('NOT_CALLED_BY_RENDER'); };
  return { authorizeWorkflowRunHandoff: never, cancelWorkflowRunHandoff: never, continueWorkflowRunHandoff: never, resumeWorkflowRunHandoff: never,
    reviewWorkflowRunAuthorization: never, startWorkflowRunHandoff: never, workflowRunStatusHandoff: never };
});
const { WorkflowRunPanel } = await import('./workflow-run-panel');
const { LocaleProvider } = await import('../i18n/locale');
import type { WorkflowRunClaim } from '../platform/workflow-run-approvals';
import type { Language } from '../i18n/locale';

const step = (index: number, state: string, outcome: WorkflowRunClaim['run']['steps'][number]['outcome'] = null) =>
  ({ index, action: index === 0 ? 'swap' : 'bridge', state, flow: 'base-sepolia-swap', stepWorkflowHash: null, code: null, bound: null, outcome });
function claim(patch: Partial<WorkflowRunClaim['run']>, delegated: { available: boolean; reason: string | null } = { available: true, reason: null }): WorkflowRunClaim {
  return { step: null, stepWallet: null,
    run: { workflowRunId: 'wfr_' + 'a'.repeat(26), approvalId: 'apr_' + 'a'.repeat(26), state: 'PENDING', mode: null, stepCount: 2, currentStep: 0, code: null,
      workflowHash: '0x' + '1'.repeat(64), expiresAt: '2026-10-29T00:00:00.000Z', completedAt: null, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
      stepsVisible: true, steps: [step(0, 'PENDING'), step(1, 'PENDING')], nextAction: 'OWNER_CHOOSES_MODE', authority: 'NONE', note: null, ...patch },
    plan: { stepCount: 2, confirmEachStep: { available: true, reason: null, walletConfirmationsAtLeast: 2, walletNamespaces: ['eip155'] },
      delegatedSingleAuthorization: { ...delegated, passkeyAssertions: 1, enrollments: [], ownerKnown: true }, recommended: 'CONFIRM_EACH_STEP', steps: [], bindings: [],
      notes: ['One authorization is not one transaction: every step still submits its own transactions and pays its own network fees.'] } };
}
const render = (c: WorkflowRunClaim, language: Language = 'EN') => renderToStaticMarkup(<LocaleProvider initialLanguage={language}>
  <WorkflowRunPanel claim={c} approvalId={c.run.approvalId} secret={null} onProposal={vi.fn()} onError={vi.fn()}/></LocaleProvider>);

describe('BUILD-CHAT-E2E-001 workflow run panel', () => {
  it('offers both modes with their authorization counts before anything is authorized', () => {
    const html = render(claim({}));
    expect(html).toContain('Nothing is authorized yet.');
    expect(html).toContain('Confirm each step in my wallet (2 confirmations at least)');
    expect(html).toContain('One authorization is not one transaction');
    expect(html).toContain('Step 1');
    const pt = render(claim({}), 'PT');
    expect(pt).toContain('Confirmar cada etapa na minha carteira (pelo menos 2 confirmações)');
    expect(pt).toContain('Uma autorização não é uma transação');
  });

  it('says why one authorization is not available instead of offering it', () => {
    const html = render(claim({}, { available: false, reason: 'CREDENTIAL_ENROLLMENT_REQUIRED' }));
    expect(html).not.toContain('Authorize the whole workflow once');
    expect(html).toContain('Enroll a Credential for every network of this workflow');
    expect(render(claim({}, { available: false, reason: 'DELEGATED_SIGNER_UNAVAILABLE' }))).toContain('cannot sign delegated steps');
  });

  it('offers the next step only after the previous one reconciled, and shows its transaction', () => {
    const tx = { chain: 'eip155:84532', hash: '0x' + 'f'.repeat(64), explorerUrl: 'https://sepolia.basescan.org/tx/0x' + 'f'.repeat(64) };
    const outcome = { executionId: 'run-1', kind: 'OWNER_RUN', status: 'RECONCILED', evidence: { environment: 'TESTNET_EXECUTED', outcome: 'RECONCILED', bundleHash: '0x' + '2'.repeat(64) },
      submissions: [tx], spent: [], received: [], receiptUrl: null };
    const html = render(claim({ state: 'RUNNING', mode: 'CONFIRM_EACH_STEP', currentStep: 1, nextAction: 'OWNER_SIGNS_STEP', steps: [step(0, 'RECONCILED', outcome), step(1, 'PENDING')] }));
    expect(html).toContain('Continue to step 2');
    expect(html).toContain(`href="${tx.explorerUrl}"`);
    expect(html).not.toContain('Nothing is authorized yet.');
    const waiting = render(claim({ state: 'RUNNING', mode: 'CONFIRM_EACH_STEP', nextAction: 'WAITING_FOR_RECONCILIATION', steps: [step(0, 'AWAITING_OWNER'), step(1, 'PENDING')] }));
    expect(waiting).not.toContain('Continue to step');
    expect(waiting).toContain('In your wallet');
  });

  it('reports partial completion and uncertainty honestly', () => {
    const halted = render(claim({ state: 'HALTED', mode: 'CONFIRM_EACH_STEP', currentStep: 1, nextAction: 'OWNER_DECIDES', steps: [step(0, 'RECONCILED'), step(1, 'BLOCKED')] }));
    expect(halted).toContain('Partially completed: the reconciled steps stay done');
    expect(halted).toContain('End workflow');
    expect(render(claim({ state: 'ATTENTION', mode: 'CONFIRM_EACH_STEP', nextAction: 'WAITING_FOR_RECONCILIATION', steps: [step(0, 'UNCERTAIN'), step(1, 'PENDING')] })))
      .toContain('never resubmits it');
    expect(render(claim({ state: 'COMPLETED', mode: 'DELEGATED', nextAction: 'NONE', steps: [step(0, 'RECONCILED'), step(1, 'RECONCILED')] }), 'PT'))
      .toContain('Todas as etapas reconciliadas.');
  });
});
