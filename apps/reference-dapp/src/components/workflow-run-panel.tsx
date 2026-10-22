// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-CHAT-E2E-001: a multi-step approval on `/approve` — inside the existing approval notice, above the signing surface (the Canvas stays
 * optional). It shows every step and its durable state, how many authorizations the workflow needs, and the one action the owner can take now:
 *
 *   choose a mode          confirm each step in the wallet, or — when the owner's own Credentials cover every step — authorize the whole workflow
 *                          ONCE with their passkey (the Universal Workflow Authorization: its limits are shown before the passkey is used)
 *   continue               after a step reconciled, load the next step into the signing surface (its own fresh simulation, Review and signature)
 *   end / try again        a halted run (partial completion) can be ended, or a step that submitted nothing tried again
 *
 * Status is polled read-only. Nothing here builds, signs or sends a transaction; the passkey assertion and every wallet confirmation stay the
 * owner's own, and FloFi re-verifies each of them on the server.
 */
import { useEffect, useRef, useState } from 'react';
import { authorizeWorkflowRunHandoff, cancelWorkflowRunHandoff, continueWorkflowRunHandoff, resumeWorkflowRunHandoff, reviewWorkflowRunAuthorization,
  startWorkflowRunHandoff, workflowRunStatusHandoff } from '../app/approve-action';
import type { ReviewView } from '../delegation/views';
import { useLocale } from '../i18n/locale';
import type { ClaimedProposal } from '../platform/approvals';
import type { WorkflowRunClaim } from '../platform/workflow-run-approvals';
import { assertPasskey, passkeysSupported } from './delegation-browser';

const STEP_STATE: Readonly<Record<string, string>> = { PENDING: 'Waiting', READY: 'Ready for your signature', AWAITING_OWNER: 'In your wallet', DELEGATED: 'Authorized',
  RECONCILED: 'Reconciled', FAILED: 'Failed', UNCERTAIN: 'Outcome pending', SKIPPED: 'Not run', BLOCKED: 'Stopped before submission' };
const RUN_STATE: Readonly<Record<string, string>> = { PENDING: 'Choose how to authorize', RUNNING: 'Running', COMPLETED: 'Completed', HALTED: 'Partially completed',
  FAILED: 'Failed', ATTENTION: 'Needs attention', CANCELLED: 'Ended', EXPIRED: 'Expired' };
const ACTION: Readonly<Record<string, string>> = { swap: 'Swap', bridge: 'Bridge', supply: 'Supply', borrow: 'Borrow', repay: 'Repay', withdraw: 'Withdraw',
  add_liquidity: 'Add liquidity', transfer: 'Transfer', lending_composition: 'Lending composition' };
const WHY_NOT_ONCE: Readonly<Record<string, string>> = {
  CREDENTIAL_ENROLLMENT_REQUIRED: 'Enroll a Credential for every network of this workflow in FloFi → Automations → Credentials first.',
  DELEGATED_SIGNER_UNAVAILABLE: 'This FloFi deployment cannot sign delegated steps.', DELEGATION_NOT_ENABLED: 'Not enabled on this FloFi deployment.',
  CREDENTIALS_USE_DIFFERENT_PASSKEYS: 'Your Credentials for these networks use different passkeys.',
};
const short = (hash: string) => hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;

export function WorkflowRunPanel({ claim, approvalId, secret, onProposal, onError }: { claim: WorkflowRunClaim; approvalId: string; secret: string | null;
  onProposal: (proposal: ClaimedProposal) => void; onError: (code: string) => void }) {
  const { t: tr } = useLocale();
  const [review, setReview] = useState<ReviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const { run, plan } = claim;
  const open = ['PENDING', 'RUNNING', 'ATTENTION', 'HALTED'].includes(run.state);
  // Read-only status: the server never loads or resolves a step for a poll.
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    const timer = setInterval(() => {
      void workflowRunStatusHandoff(approvalId).then(result => { if (!stopped && result.ok) onProposal(result.value); }).catch(() => undefined);
    }, 15_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [approvalId, open, onProposal]);

  async function act(work: () => Promise<{ ok: true; value: ClaimedProposal } | { ok: false; code: string }>) {
    if (acting.current) return; acting.current = true; setBusy(true);
    try { const result = await work(); if (result.ok) { setReview(null); onProposal(result.value); } else onError(result.code); }
    catch { onError('APPROVAL_UNAVAILABLE'); }
    finally { acting.current = false; setBusy(false); }
  }
  async function prepareOnce() {
    if (acting.current) return; acting.current = true; setBusy(true);
    try { const result = await reviewWorkflowRunAuthorization(approvalId); if (result.ok) setReview(result.value); else onError(result.code); }
    catch { onError('APPROVAL_UNAVAILABLE'); }
    finally { acting.current = false; setBusy(false); }
  }
  // The owner's ONE signature: the passkey asserts the envelope digest FloFi showed; the server re-verifies it and starts the run.
  const signOnce = () => act(async () => {
    if (!secret) return { ok: false, code: 'APPROVAL_LINK_REQUIRED' };
    const assertion = await assertPasskey(review!);
    return authorizeWorkflowRunHandoff(secret, review!.revision, assertion);
  });

  const confirmations = plan.confirmEachStep.walletConfirmationsAtLeast;
  const choosing = run.state === 'PENDING' && run.mode === null;
  const nextStep = run.nextAction === 'OWNER_SIGNS_STEP' && claim.step === null ? run.currentStep + 1 : null;
  return <section className="workflow-run" aria-label={tr('Workflow steps')} data-run-state={run.state}>
    <div className="workflow-run-head">
      <strong>{tr('{0}-step workflow', String(run.stepCount))}</strong>
      <span className="status-badge info">{tr(RUN_STATE[run.state] ?? run.state)}</span>
      {run.mode && <span className="muted">{tr(run.mode === 'DELEGATED' ? 'Authorized once with your passkey' : 'You confirm each step in your wallet')}</span>}
    </div>
    <ol className="workflow-run-steps">
      {run.steps.map(step => <li key={step.index} data-step-state={step.state} aria-current={step.index === run.currentStep && open ? 'step' : undefined}>
        <span>{tr('Step {0}', String(step.index + 1))} · {tr(ACTION[step.action] ?? step.action)}</span>
        <span className="workflow-run-state">{tr(STEP_STATE[step.state] ?? step.state)}</span>
        {step.outcome?.submissions.map(tx => tx.explorerUrl
          ? <a key={tx.hash} href={tx.explorerUrl} target="_blank" rel="noreferrer"><code>{short(tx.hash)}</code></a>
          : <code key={tx.hash}>{short(tx.hash)}</code>)}
      </li>)}
    </ol>
    {choosing && <div className="workflow-run-choice">
      <p><strong>{tr('Nothing is authorized yet.')}</strong> {tr('Choose how to authorize this workflow. Each step starts only after the previous one is reconciled on chain.')}</p>
      <div className="approval-actions">
        {plan.confirmEachStep.available && <button type="button" className="secondary" disabled={busy} onClick={() => void act(() => startWorkflowRunHandoff(approvalId))}>
          {tr('Confirm each step in my wallet ({0} confirmations at least)', String(confirmations))}</button>}
        {plan.delegatedSingleAuthorization.available && !review && <button type="button" disabled={busy || !passkeysSupported()} onClick={() => void prepareOnce()}>
          {tr('Authorize the whole workflow once')}</button>}
      </div>
      {!plan.delegatedSingleAuthorization.available && plan.delegatedSingleAuthorization.reason &&
        <p className="muted">{tr('Authorizing once is not available here.')} {tr(WHY_NOT_ONCE[plan.delegatedSingleAuthorization.reason] ?? plan.delegatedSingleAuthorization.reason)}</p>}
      {plan.delegatedSingleAuthorization.available && !passkeysSupported() && <p className="muted">{tr('This browser cannot use a passkey.')}</p>}
    </div>}
    {review && <div className="workflow-run-review" aria-label={tr('Authorization limits')}>
      <p>{tr('Your passkey signs these limits once. FloFi then executes each step within them, without asking your wallet again, and stops at the first step that would exceed them.')}</p>
      <dl className="approval-facts">
        <div><dt>{tr('Networks')}</dt><dd>{review.manifest.networks.join(' · ')}</dd></div>
        {review.manifest.assets.filter(a => a.role === 'INPUT').map(a => <div key={a.asset}><dt>{tr('Max {0}', a.symbol)}</dt><dd>{a.maxPerExecution} {a.symbol}</dd></div>)}
        <div><dt>{tr('Max slippage')}</dt><dd>{(review.manifest.maxSlippageBps / 100).toString()}%</dd></div>
        <div><dt>{tr('Valid until')}</dt><dd>{new Date(review.manifest.expiresAt).toLocaleString()}</dd></div>
        <div><dt>{tr('Executions')}</dt><dd>{tr('This workflow, once')}</dd></div>
      </dl>
      <div className="approval-actions">
        <button type="button" disabled={busy} onClick={() => void signOnce()}>{tr('Sign once with my passkey')}</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => setReview(null)}>{tr('Back')}</button>
      </div>
    </div>}
    {nextStep !== null && <div className="approval-actions">
      <button type="button" disabled={busy} onClick={() => void act(() => continueWorkflowRunHandoff(approvalId))}>{tr('Continue to step {0}', String(nextStep))}</button>
    </div>}
    {run.state === 'HALTED' && <div className="workflow-run-choice">
      <p role="status">{tr('Partially completed: the reconciled steps stay done and their funds rest in your wallet. Nothing later was submitted.')}</p>
      <div className="approval-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => void act(() => resumeWorkflowRunHandoff(approvalId))}>{tr('Try this step again')}</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => cancelWorkflowRunHandoff(approvalId))}>{tr('End workflow')}</button>
      </div>
    </div>}
    {run.state === 'ATTENTION' && <p role="status">{tr('A submitted step has no final outcome yet. FloFi keeps observing it and never resubmits it.')}</p>}
    {run.state === 'COMPLETED' && <p role="status"><strong>{tr('Every step reconciled.')}</strong> {tr('Your conversation can show the result.')}</p>}
    <p className="muted workflow-run-note">{tr(plan.notes[0] ?? '')}</p>
  </section>;
}
