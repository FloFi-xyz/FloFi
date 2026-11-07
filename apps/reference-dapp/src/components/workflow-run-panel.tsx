// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-CHAT-E2E-001: a multi-step approval on `/approve` — inside the existing approval notice, above the signing surface (the Canvas stays
 * optional). It shows every step and its durable state, how many authorizations the workflow needs, and the one action the owner can take now:
 *
 *   choose a mode          confirm each step in the wallet, or authorize the whole workflow ONCE: the wallet signs one exact workflow grant per
 *                          network (BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001), whose every call is listed before the wallet is asked
 *   continue               after a step reconciled, load the next step into the signing surface (its own fresh simulation, Review and signature)
 *   end / try again        a halted run (partial completion) can be ended, or a step that submitted nothing tried again
 *
 * Status is polled; a poll observes the run as FloFi's worker does and never loads a step. Nothing here builds, signs or sends a transaction;
 * every wallet signature and confirmation stays the owner's own, and FloFi re-verifies each of them on the server.
 */
import { useEffect, useRef, useState } from 'react';
import { authorizeUserFundedGroup, authorizeWorkflowRunHandoff, cancelWorkflowRunHandoff, continueWorkflowRunHandoff, prepareUserFundedGroup, reportUserFundedBatch,
  resumeWorkflowRunHandoff, reviewWorkflowRunAuthorization, startUserFundedWorkflowRun, startWorkflowRunHandoff, workflowRunStatusHandoff } from '../app/approve-action';
import type { eip5792 } from '@defi-workflow-engine/reference-compiler';
import { sendWalletBatch, signSolanaGroup, signUserOperation, walletBatchHashes, walletProfile } from './user-funded-browser';
import { chosenEvmProvider, injected } from '../wallet/evm-discovery';
import type { WalletWorkflowReviewView } from '../delegation/views';
import { canEndWorkflow } from '../workflow-runs/state-machine';
import { useLocale } from '../i18n/locale';
import type { ClaimedProposal } from '../platform/approvals';
import type { WorkflowRunClaim } from '../platform/workflow-run-approvals';
import { signWorkflowGrant } from './delegation-browser';

const STEP_STATE: Readonly<Record<string, string>> = { PENDING: 'Waiting', READY: 'Ready for your signature', AWAITING_OWNER: 'In your wallet', DELEGATED: 'Authorized',
  RECONCILED: 'Reconciled', FAILED: 'Failed', UNCERTAIN: 'Outcome pending', SKIPPED: 'Not run', BLOCKED: 'Stopped before submission' };
const RUN_STATE: Readonly<Record<string, string>> = { PENDING: 'Choose how to authorize', RUNNING: 'Running', COMPLETED: 'Completed', HALTED: 'Partially completed',
  FAILED: 'Failed', ATTENTION: 'Needs attention', CANCELLED: 'Ended', EXPIRED: 'Expired' };
const ACTION: Readonly<Record<string, string>> = { swap: 'Swap', bridge: 'Bridge', supply: 'Supply', borrow: 'Borrow', repay: 'Repay', withdraw: 'Withdraw',
  add_liquidity: 'Add liquidity', transfer: 'Transfer', lending_composition: 'Lending composition' };
const WHY_NOT_ONCE: Readonly<Record<string, string>> = {
  DELEGATED_SIGNER_UNAVAILABLE: 'This FloFi deployment cannot sign delegated steps.', DELEGATION_NOT_ENABLED: 'Not enabled on this FloFi deployment.',
  // BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001
  WORKFLOW_BINDING_NOT_EXACT: 'A step depends on an amount that cannot be fixed on chain when you sign (for example after a bridge).',
  WORKFLOW_GRANT_NAMESPACE_UNSUPPORTED: 'Solana steps cannot be authorized once yet: confirm each step in your wallet.',
  DELEGATION_FRAMEWORK_NOT_DEPLOYED: 'This network has no verified delegation framework yet.',
  EVM_ACCOUNT_NOT_UPGRADED: 'Switch this wallet to a MetaMask smart account (one time, in MetaMask), then sign again.',
  WORKFLOW_SLIPPAGE_UNSUPPORTED: 'A swap allows more than 3% slippage, which cannot be authorized once.',
  WORKFLOW_GRANT_TOO_MANY_CALLS: 'This workflow has too many calls on one network to authorize once.',
  // BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: the capability gaps a mainnet workflow can hit, in plain words.
  MAINNET_DELEGATION_DISABLED: 'Delegated execution is not enabled for this network on this FloFi deployment.',
  DELEGATION_TEMPLATE_NOT_IMPLEMENTED: 'One of these steps has no delegated execution yet.',
  DELEGATED_TARGET_SCOPE_UNAVAILABLE: 'One of these steps cannot be limited on chain for delegated execution.',
  // BUILD-FLOFI-UNIVERSAL-WORKFLOW-002
  EXECUTOR_FUNDED_GAS_RETIRED: 'FloFi no longer executes steps from its own account: your own wallet pays every fee.',
};
/** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: how each execution group is authorized, in plain words. */
const GROUP_HOW: Readonly<Record<string, string>> = { EVM_WALLET_BATCH: 'One wallet confirmation (atomic batch)', EVM_USER_OPERATION: 'One signature now; FloFi relays it when due',
  EVM_OWNER_STEP: 'One wallet confirmation per step', SOLANA_SIGN_ALL: 'One Solana signing request for every transaction', SOLANA_DURABLE_NONCE: 'One Solana signing request now',
  SOLANA_OWNER_STEP: 'One Solana prompt per step' };
const GROUP_STATE: Readonly<Record<string, string>> = { PLANNED: 'Planned', PREPARED: 'Prepared', AUTHORIZED: 'Authorized', SUBMITTED: 'Submitted', RECONCILED: 'Reconciled',
  FAILED: 'Failed', UNCERTAIN: 'Outcome pending', BLOCKED: 'Stopped before submission', SKIPPED: 'Not run', EXPIRED: 'Expired' };
const NETWORK: Readonly<Record<string, string>> = { 'eip155:1': 'Ethereum', 'eip155:8453': 'Base', 'eip155:42161': 'Arbitrum One', 'eip155:4663': 'Robinhood Chain',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana' };
const units = (amount: string, unit: string) => { const d = unit === 'lamports' ? 9 : 18, v = BigInt(amount), whole = v / 10n ** BigInt(d), frac = (v % 10n ** BigInt(d)).toString().padStart(d, '0').slice(0, 6).replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''} ${unit === 'lamports' ? 'SOL' : 'ETH'}`; };
const short = (hash: string) => hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;

export function WorkflowRunPanel({ claim, approvalId, secret, onProposal, onError }: { claim: WorkflowRunClaim; approvalId: string; secret: string | null;
  onProposal: (proposal: ClaimedProposal) => void; onError: (code: string) => void }) {
  const { t: tr } = useLocale();
  const [review, setReview] = useState<WalletWorkflowReviewView | null>(null);
  // Signatures already given (kept so a retry after the one-time smart-account upgrade never asks the wallet again).
  const signed = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  // The exact request whose answer was lost (timeout): only this snapshot is ever re-sent automatically, never a new wallet prompt.
  type Sent = { readonly revision: number; readonly signatures: readonly { readonly grantId: string; readonly signature: string }[] };
  const lastSent = useRef<Sent | null>(null), unknownOutcome = useRef<Sent | null>(null);
  const { run, plan } = claim;
  const open = ['PENDING', 'RUNNING', 'ATTENTION', 'HALTED'].includes(run.state);
  // A status poll: the server observes the run (a reconciled step shows at once) but never loads or resolves a step for it.
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
    try {
      const result = await work();
      if (result.ok) { unknownOutcome.current = null; setReview(null); onProposal(result.value); }
      else { unknownOutcome.current = result.code === 'DELEGATION_OUTCOME_UNKNOWN' ? lastSent.current : null; onError(result.code); }
    }
    catch (cause) {
      const code = cause instanceof Error && /^(WALLET_[A-Z_]+|EVM_WALLET_NOT_FOUND)$/.test(cause.message) ? cause.message : 'APPROVAL_UNAVAILABLE';
      onError(code);
    }
    finally { acting.current = false; setBusy(false); }
  }
  async function prepareOnce() {
    if (acting.current) return; acting.current = true; setBusy(true);
    unknownOutcome.current = null;
    try { const result = await reviewWorkflowRunAuthorization(approvalId); if (result.ok) setReview(result.value); else onError(result.code); }
    catch { onError('APPROVAL_UNAVAILABLE'); }
    finally { acting.current = false; setBusy(false); }
  }
  // The owner's ONE authorization: the wallet signs each network's exact workflow grant; the server verifies every signature and starts the run.
  const signOnce = () => act(async () => {
    if (!secret) return { ok: false, code: 'APPROVAL_LINK_REQUIRED' };
    for (const grant of review!.grants) if (grant.state === 'PENDING_SIGNATURE' && grant.typedData && !signed.current.has(grant.grantId))
      signed.current.set(grant.grantId, await signWorkflowGrant(grant.walletAddress, grant.chainId, grant.typedData));
    lastSent.current = { revision: review!.revision, signatures: [...signed.current].map(([grantId, signature]) => ({ grantId, signature })) };
    return authorizeWorkflowRunHandoff(secret, lastSent.current.revision, [...lastSent.current.signatures]);
  });

  // BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: user-funded execution groups — the owner's own wallets authorize (and, for a batch, send) and pay.
  const evmAddress = async () => { const p = chosenEvmProvider() ?? injected(); const a = p ? await p.request({ method: 'eth_accounts', params: [] }) : null;
    return Array.isArray(a) && typeof a[0] === 'string' ? a[0].toLowerCase() : null; };
  const startUserFunded = () => act(async () => {
    const chains = [...new Set(plan.userFunded.groups.map(g => g.chain))];
    const profile = await walletProfile(plan.confirmEachStep.walletNamespaces.includes('eip155') ? await evmAddress() : null, chains,
      plan.confirmEachStep.walletNamespaces.includes('solana'));
    return startUserFundedWorkflowRun(approvalId, profile);
  });
  /** Prepares one group on the server, asks the owner's wallet for exactly that, and relays the answer (verified by the server). */
  const authorizeGroup = (index: number) => act(async () => {
    const prepared = await prepareUserFundedGroup(approvalId, index);
    if (!prepared.ok) return prepared;
    const p = prepared.value.prepared as unknown as Record<string, unknown>;
    if (p.kind === 'EVM_WALLET_BATCH') {
      const batchId = await sendWalletBatch(p.request as eip5792.SendCallsRequest);
      const authorized = await authorizeUserFundedGroup(approvalId, index, { kind: 'EVM_WALLET_BATCH', batchId });
      if (!authorized.ok) return authorized;
      for (let i = 0; i < 40; i++) {
        const done = await walletBatchHashes(batchId).catch(() => null);
        if (done?.hashes.length) return reportUserFundedBatch(approvalId, index, [...done.hashes]);
        await new Promise(resolve => setTimeout(resolve, 3_000));
      }
      return authorized;
    }
    if (p.kind === 'EVM_USER_OPERATION') {
      const signature = await signUserOperation(prepared.value.feePayer, Number(p.chainId), p.typedData);
      return authorizeUserFundedGroup(approvalId, index, { kind: 'EVM_USER_OPERATION', signature });
    }
    if (p.kind === 'SOLANA_SIGN_ALL') {
      const txs = (p.transactions as { unsignedTransaction: string }[]).map(t => t.unsignedTransaction);
      return authorizeUserFundedGroup(approvalId, index, { kind: 'SOLANA_SIGN_ALL', transactions: await signSolanaGroup(prepared.value.feePayer, txs) });
    }
    return { ok: false as const, code: 'USER_FUNDED_GROUP_NOT_PREPARABLE' };
  });
  /** A batch the wallet already sent (e.g. after a reload): its hashes are read back from the wallet and reported. */
  const recoverBatch = (index: number, batchId: string) => act(async () => {
    const done = await walletBatchHashes(batchId);
    return done?.hashes.length ? reportUserFundedBatch(approvalId, index, [...done.hashes]) : workflowRunStatusHandoff(approvalId);
  });
  const currentGroup = run.groups?.find(g => g.steps[0] <= run.currentStep && run.currentStep <= g.steps[1]) ?? null;
  const userFundedCount = plan.userFunded?.interactions ? plan.userFunded.interactions.upfront + plan.userFunded.interactions.whenDue : 0;

  // BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: a sign whose answer was lost (timeout) may still have started the run. Once the status poll shows
  // the run DELEGATED, the same cached signatures are sent once more: the sign is idempotent and the wallet is never asked again.
  useEffect(() => {
    const sent = unknownOutcome.current;
    if (!sent || run.mode !== 'DELEGATED' || !secret) return;
    unknownOutcome.current = null;
    void act(() => authorizeWorkflowRunHandoff(secret, sent.revision, [...sent.signatures]));
  }, [run.mode]);
  const confirmations = plan.confirmEachStep.walletConfirmationsAtLeast;
  const choosing = run.state === 'PENDING' && run.mode === null;
  const nextStep = run.nextAction === 'OWNER_SIGNS_STEP' && claim.step === null ? run.currentStep + 1 : null;
  return <section className="workflow-run" aria-label={tr('Workflow steps')} data-run-state={run.state}>
    <div className="workflow-run-head">
      <strong>{tr('{0}-step workflow', String(run.stepCount))}</strong>
      <span className="status-badge info">{tr(RUN_STATE[run.state] ?? run.state)}</span>
      {run.mode && <span className="muted">{tr(run.mode === 'DELEGATED' ? 'Authorized once with your wallet' : run.mode === 'USER_FUNDED'
        ? 'You authorize each group with your own wallet' : 'You confirm each step in your wallet')}</span>}
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
        {plan.userFunded?.available && <button type="button" disabled={busy} onClick={() => void startUserFunded()}>
          {userFundedCount === 1 ? tr('Pay the fees from my own wallet, in one wallet interaction')
            : tr('Pay the fees from my own wallet, in {0} wallet interactions', String(userFundedCount))}</button>}
        {plan.delegatedSingleAuthorization.available && !review && <button type="button" disabled={busy} onClick={() => void prepareOnce()}>
          {plan.delegatedSingleAuthorization.walletSignatures > 1
            ? tr('Authorize the whole workflow once ({0} wallet signatures, one per network)', String(plan.delegatedSingleAuthorization.walletSignatures))
            : tr('Authorize the whole workflow once')}</button>}
      </div>
      {plan.userFunded?.available && <ol className="workflow-run-groups" aria-label={tr('Execution groups')}>
        {plan.userFunded.groups.map(g => <li key={g.index}>{tr('Steps {0}–{1} on {2}', String(g.stepFrom + 1), String(g.stepTo + 1), NETWORK[g.chain] ?? g.chain)}
          {' · '}{tr(GROUP_HOW[g.strategy] ?? g.strategy)}{' · '}{tr(g.signing === 'UPFRONT' ? 'signed now' : 'signed when it becomes due')}
          {g.awaitsDelivery !== null && <> · {tr('waits for the delivery of step {0}', String(g.awaitsDelivery + 1))}</>}
          {g.setup.includes('EVM_SMART_ACCOUNT_UPGRADE') && <> · {tr('your wallet upgrades this account inside the same confirmation (one time)')}</>}</li>)}
      </ol>}
      {plan.userFunded?.available && <p className="muted">{tr('Your wallet pays every network fee. FloFi never pays, advances or reimburses gas.')}</p>}
      {!plan.delegatedSingleAuthorization.available && plan.delegatedSingleAuthorization.reason && plan.delegatedSingleAuthorization.reason !== 'EXECUTOR_FUNDED_GAS_RETIRED' &&
        <p className="muted">{tr('Authorizing once is not available here.')} {tr(WHY_NOT_ONCE[plan.delegatedSingleAuthorization.reason] ?? plan.delegatedSingleAuthorization.reason)}</p>}
      {plan.delegatedSingleAuthorization.available && <p className="muted">{tr('One-time setup: your wallet must be a MetaMask smart account on each network (EIP-7702).')}</p>}
    </div>}
    {review && <div className="workflow-run-review" aria-label={tr('Authorization limits')}>
      <p>{tr('Your wallet signs exactly these calls, once, on each network. FloFi can execute nothing else with this authorization, each call at most once, until it expires. Your wallet is not asked again.')}</p>
      {review.grants.map(grant => <div key={grant.grantId} className="workflow-run-grant" data-grant-state={grant.state}>
        <p><strong>{grant.network}</strong> · {tr('executor {0}', short(grant.executor))} · {tr('valid until {0}', new Date(grant.validUntil).toLocaleString())}</p>
        <ol>{grant.calls.map((call, i) => <li key={i}>{tr('Step {0}', String(call.stepIndex + 1))}: {call.kind === 'APPROVE'
          ? tr(call.spender === 'AAVE_V3_POOL' ? 'Approve exactly {0} {1} to the Aave V3 Pool' : 'Approve exactly {0} {1} to the Uniswap v3 router', call.amount, call.symbol)
          : call.kind === 'SWAP' ? tr('Swap exactly {0} {1} for at least {2} {3} (Uniswap v3, 0.05%)', call.amount, call.symbol, call.minimum ?? '', call.outputSymbol ?? '')
          : call.kind === 'SUPPLY' ? tr('Supply exactly {0} {1} to Aave V3 for this wallet', call.amount, call.symbol)
          : tr('Borrow exactly {0} {1} from Aave V3 at the variable rate, for this wallet', call.amount, call.symbol)}</li>)}</ol>
      </div>)}
      <dl className="approval-facts">
        {review.manifest.minHealthFactor && <div><dt>{tr('Health factor after Borrow')}</dt><dd>{tr('at least {0}', review.manifest.minHealthFactor)}</dd></div>}
        <div><dt>{tr('Executions')}</dt><dd>{tr('This workflow, once')}</dd></div>
      </dl>
      <div className="approval-actions">
        <button type="button" disabled={busy} onClick={() => void signOnce()}>{review.walletSignatures > 1
          ? tr('Sign once in my wallet ({0} networks)', String(review.walletSignatures)) : tr('Sign once in my wallet')}</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => { unknownOutcome.current = null; setReview(null); }}>{tr('Back')}</button>
      </div>
    </div>}
    {run.mode === 'USER_FUNDED' && <ol className="workflow-run-groups" aria-label={tr('Execution groups')}>
      {(run.groups ?? []).map(g => <li key={g.index} data-group-state={g.state}>
        <span>{tr('Steps {0}–{1} on {2}', String(g.steps[0] + 1), String(g.steps[1] + 1), NETWORK[g.chain] ?? g.chain)} · {tr(GROUP_HOW[g.strategy] ?? g.strategy)}</span>
        <span className="workflow-run-state">{tr(GROUP_STATE[g.state] ?? g.state)}</span>
        <span className="muted">{tr('Fees paid by {0}', short(g.feePayer))}</span>
        {g.maxFee && !g.gasPaid && <span className="muted">{tr('At most {0} in network fees', units(g.maxFee.amount, g.maxFee.unit))}</span>}
        {g.gasPaid && <span className="muted">{tr('Network fees paid: {0}', units(g.gasPaid.amount, g.gasPaid.unit))}</span>}
        {g.transactions.map(tx => tx.explorerUrl ? <a key={tx.hash} href={tx.explorerUrl} target="_blank" rel="noreferrer"><code>{short(tx.hash)}</code></a> : <code key={tx.hash}>{short(tx.hash)}</code>)}
      </li>)}
    </ol>}
    {run.mode === 'USER_FUNDED' && run.nextAction === 'OWNER_SIGNS_GROUP' && currentGroup && <div className="approval-actions">
      <button type="button" disabled={busy} onClick={() => void authorizeGroup(currentGroup.index)}>
        {tr('Authorize steps {0}–{1} now', String(currentGroup.steps[0] + 1), String(currentGroup.steps[1] + 1))}</button>
    </div>}
    {run.mode === 'USER_FUNDED' && run.nextAction === 'OWNER_CONFIRMS_BATCH' && currentGroup?.batchId && <div className="approval-actions">
      <button type="button" className="secondary" disabled={busy} onClick={() => void recoverBatch(currentGroup.index, currentGroup.batchId!)}>{tr('Check my wallet for the batch')}</button>
    </div>}
    {nextStep !== null && <div className="approval-actions">
      <button type="button" disabled={busy} onClick={() => void act(() => continueWorkflowRunHandoff(approvalId))}>{tr('Continue to step {0}', String(nextStep))}</button>
    </div>}
    {run.state === 'HALTED' && <div className="workflow-run-choice">
      <p role="status">{tr('Partially completed: the reconciled steps stay done and their funds rest in your wallet. Nothing later was submitted.')}</p>
      <div className="approval-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => void act(() => resumeWorkflowRunHandoff(approvalId))}>{tr('Try this step again')}</button>
      </div>
    </div>}
    {canEndWorkflow(run, run.steps) && <div className="approval-actions">
      <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => cancelWorkflowRunHandoff(approvalId))}>{tr('End workflow')}</button>
    </div>}
    {run.mode === 'DELEGATED' && open && <div className="workflow-run-choice">
      <p>{tr('Revoking stops FloFi from starting any further step. Submitted transactions keep being observed. The calls you signed stay valid on chain until they expire (at most one hour); to cancel them on chain at once, revoke them from your wallet in FloFi → Credentials.')}</p>
      <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => cancelWorkflowRunHandoff(approvalId))}>{tr('Revoke workflow authorization')}</button>
    </div>}
    {run.state === 'ATTENTION'  && <p role="status">{tr('A submitted step has no final outcome yet. FloFi keeps observing it and never resubmits it.')}</p>}
    {run.state === 'COMPLETED' && <p role="status"><strong>{tr('Every step reconciled.')}</strong> {tr('Your conversation can show the result.')}</p>}
    <p className="muted workflow-run-note">{tr(plan.notes[0] ?? '')}</p>
  </section>;
}
