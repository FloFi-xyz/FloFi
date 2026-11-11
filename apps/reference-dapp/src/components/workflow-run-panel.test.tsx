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
      stepsVisible: true, steps: [step(0, 'PENDING'), step(1, 'PENDING')], nextAction: 'OWNER_CHOOSES_MODE', groups: [], halted: null, resumable: false, authority: 'NONE',
      note: null, ...patch },
    plan: { stepCount: 2, confirmEachStep: { available: true, reason: null, walletConfirmationsAtLeast: 2, walletNamespaces: ['eip155'] },
      delegatedSingleAuthorization: { ...delegated, walletSignatures: 1, passkeyAssertions: 0, enrollments: [], ownerKnown: true },
      userFunded: { available: false, reason: 'USER_FUNDED_NOT_ENABLED', groups: [], interactions: null, feePayer: 'OWNER_WALLET', wallets: 'ASSUMED' },
      recommended: 'CONFIRM_EACH_STEP', steps: [], bindings: [],
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
    const html = render(claim({}, { available: false, reason: 'WORKFLOW_GRANT_NAMESPACE_UNSUPPORTED' }));
    expect(html).not.toContain('Authorize the whole workflow once');
    expect(html).toContain('Solana steps cannot be authorized once yet: confirm each step in your wallet.');
    expect(render(claim({}, { available: false, reason: 'WORKFLOW_BINDING_NOT_EXACT' }))).toContain('cannot be fixed on chain when you sign');
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

  it('offers End workflow for safe pending/running/halted runs and no terminal or in-flight run', () => {
    for (const state of ['PENDING', 'RUNNING', 'HALTED']) expect(render(claim({ state, steps: [step(0, 'RECONCILED'), step(1, 'PENDING')] }))).toContain('End workflow');
    for (const state of ['ATTENTION', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']) expect(render(claim({ state }))).not.toContain('End workflow');
    for (const state of ['AWAITING_OWNER', 'UNCERTAIN', 'DELEGATED']) expect(render(claim({ state: 'HALTED', steps: [step(0, state), step(1, 'PENDING')] }))).not.toContain('End workflow');
    const delegated = render(claim({ state: 'RUNNING', mode: 'DELEGATED' }));
    expect(delegated).not.toContain('End workflow'); expect(delegated).toContain('Revoke workflow authorization');
    expect(render(claim({}), 'PT')).toContain('Encerrar fluxo');
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

  it('a run halted before anything was sent (its first group refused for good when due) is never called partially completed', () => {
    type Group = WorkflowRunClaim['run']['groups'][number];
    const group = (patch: Partial<Group>): Group => ({ index: 0, chain: 'eip155:8453', strategy: 'EVM_WALLET_BATCH', signing: 'UPFRONT', steps: [0, 1], state: 'BLOCKED',
      awaitsDelivery: null, code: 'USER_FUNDED_SIMULATION_UNAVAILABLE', validUntil: null, feePayer: '0x' + 'ab'.repeat(20), maxFee: null, gasPaid: null, submissions: [],
      batchId: null, signed: false, planned: null, ...patch });
    // The server would resume it (`resumable`: HALTED inside its window, the stopped group BLOCKED and unsigned).
    const stopped = { state: 'HALTED', mode: 'USER_FUNDED', nextAction: 'OWNER_DECIDES' as const, steps: [step(0, 'BLOCKED'), step(1, 'BLOCKED')], groups: [group({})],
      resumable: true };
    const html = render(claim(stopped));
    expect(html).toContain('<span class="status-badge info">Stopped: nothing sent</span>');
    expect(html).toContain('Stopped before anything was sent: your funds stay in your wallet. You can run each step through its own flow from here, or end the workflow.');
    expect(html).not.toContain('Partially completed');
    expect(html).toContain('Try this step again');
    expect(html).toContain('End workflow');
    const pt = render(claim(stopped), 'PT');
    expect(pt).toContain('Parado: nada enviado');
    expect(pt).toContain('Parado antes de qualquer envio');
    // Nothing reconciled but something may have reached the chain (fail closed): neither "nothing sent" nor a partial completion.
    for (const patch of [{ state: 'FAILED', signed: true }, { signed: true }, { state: 'SUBMITTED', signed: true }, { batchId: '0x' + '12'.repeat(32) }]) {
      const html = render(claim({ ...stopped, groups: [group(patch)] }));
      expect(html, JSON.stringify(patch)).toContain('<span class="status-badge info">Stopped</span>');
      expect(html, JSON.stringify(patch)).toContain('Stopped before any step completed. FloFi submits nothing more of this workflow');
      expect(html, JSON.stringify(patch)).not.toContain('nothing sent');
    }
    expect(render(claim({ ...stopped, steps: [step(0, 'RECONCILED'), step(1, 'BLOCKED')] }))).toContain('<span class="status-badge info">Partially completed</span>');
  });
});

type Group = WorkflowRunClaim['run']['groups'][number];
const group = (patch: Partial<Group>): Group => ({ index: 0, chain: 'eip155:8453', strategy: 'EVM_WALLET_BATCH', signing: 'UPFRONT', steps: [0, 1], state: 'BLOCKED',
  awaitsDelivery: null, code: null, validUntil: null, feePayer: '0x' + 'ab'.repeat(20), maxFee: null, gasPaid: null, submissions: [], batchId: null, signed: false,
  planned: null, ...patch });
const TRY = 'Try this step again';

describe('review fix U6: "Try this step again" is offered exactly when the server would accept it (run.resumable)', () => {
  const blocked = { state: 'HALTED', mode: 'USER_FUNDED', nextAction: 'OWNER_DECIDES' as const, steps: [step(0, 'BLOCKED'), step(1, 'BLOCKED')], groups: [group({})] };
  it('the server refuses it (e.g. the run\'s window passed) for a BLOCKED unsigned group: not offered; the run can be ended', () => {
    const html = render(claim({ ...blocked, resumable: false }));
    expect(html).not.toContain(TRY);
    expect(html).not.toContain('You can run each step through its own flow');
    expect(html).toContain('This step cannot be tried again in this workflow: end it, and start a new workflow for anything left to do.');
    expect(html).not.toContain('Something you already signed');
    expect(render(claim({ ...blocked, resumable: false }), 'PT')).toContain('Esta etapa não pode ser tentada de novo neste fluxo: encerre-o');
  });
  it('a confirm-mode step that is not BLOCKED (it may have reached the chain) is never offered again', () => {
    const failed = claim({ state: 'HALTED', mode: 'CONFIRM_EACH_STEP', currentStep: 1, nextAction: 'OWNER_DECIDES', steps: [step(0, 'RECONCILED'), step(1, 'FAILED')] });
    expect(render(failed)).not.toContain(TRY);
    expect(render(claim({ ...failed.run, resumable: true }))).toContain(TRY);
  });
  it('a signed group keeps its own words', () => {
    expect(render(claim({ ...blocked, groups: [group({ signed: true })] }))).toContain('Something you already signed for this step is never replaced');
  });
  it('a view without the field falls back to this page\'s own reading', () => {
    const older = claim(blocked);
    delete (older.run as { resumable?: boolean }).resumable;
    expect(render(older)).toContain(TRY);
  });
});

describe('review fix U7: a partial completion and an ended run claim nothing they cannot prove', () => {
  const OUTCOME_UNKNOWN = 'WALLET_BATCH_OUTCOME_UNKNOWN';
  it('a partial completion points to the step that stopped, never "nothing later was submitted"', () => {
    const partial = claim({ state: 'HALTED', mode: 'USER_FUNDED', currentStep: 1, nextAction: 'OWNER_DECIDES', steps: [step(0, 'RECONCILED'), step(1, 'FAILED')],
      groups: [group({ steps: [0, 0], state: 'RECONCILED', signed: true }), group({ index: 1, steps: [1, 1], state: 'FAILED', signed: true })] });
    const html = render(partial);
    expect(html).toContain('Partially completed: the reconciled steps stay done and their funds rest in your wallet. The step that stopped shows what happened to it.');
    expect(html).not.toMatch(/nothing later/i);
    expect(render(partial, 'PT')).toContain('A etapa que parou mostra o que aconteceu com ela.');
  });
  it('ended while a batch handed to the wallet was never answered: it may have executed; its steps and group are never "Not run"', () => {
    const ended = claim({ state: 'CANCELLED', mode: 'USER_FUNDED', code: 'OWNER_CANCELLED', nextAction: 'NONE',
      steps: [{ ...step(0, 'SKIPPED'), code: OUTCOME_UNKNOWN }, { ...step(1, 'SKIPPED'), code: OUTCOME_UNKNOWN }], groups: [group({ state: 'SKIPPED', code: OUTCOME_UNKNOWN })] });
    const html = render(ended);
    expect(html).toContain('A batch was handed to your wallet and its answer never reached FloFi: it may have executed before it expired. Check your wallet&#x27;s activity.');
    expect(html).toContain('Outcome unknown: check your wallet');
    expect(html).not.toContain('Not run');
    const pt = render(ended, 'PT');
    expect(pt).toContain('ele pode ter sido executado antes de expirar');
    expect(pt).not.toContain('Não executada');
    const plain = claim({ ...ended.run, steps: [step(0, 'SKIPPED'), step(1, 'SKIPPED')], groups: [group({ state: 'SKIPPED', code: 'OWNER_CANCELLED' })] });
    expect(render(plain)).toContain('Not run');
    expect(render(plain)).not.toContain('A batch was handed to your wallet');
  });
});
