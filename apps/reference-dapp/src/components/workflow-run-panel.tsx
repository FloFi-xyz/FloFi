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
import { authorizeUserFundedGroup, authorizeWorkflowRunHandoff, cancelWorkflowRunHandoff, consentUserFundedGroupUpgrade, continueWorkflowRunHandoff,
  declineUserFundedGroupCircle, permitUserFundedGroup, prepareUserFundedGroup, upgradeUserFundedGroup,
  reportUserFundedBatch, resumeWorkflowRunHandoff, reviewWorkflowRunAuthorization, startUserFundedWorkflowRun, startWorkflowRunHandoff,
  workflowRunStatusHandoff } from '../app/approve-action';
import type { eip5792 } from '@defi-workflow-engine/reference-compiler';
import { batchHandout, batchSponsorshipOf, entryPointOfGroup, evmWalletKind, isCirclePaid, keepBatchHandout, revokeUserOperation, sendWalletBatch, signCirclePaidGroup,
  signSolanaGroup, signUserOperation, walletBatchHashes, walletProfile } from './user-funded-browser';
import { CIRCLE_CONSENT_DECLINE, CIRCLE_NOTHING_SENT, feeAmountText, nativeLaterMessage } from '../domain/token-fee';
import { askCircleFirst, circlePaidGroup, floFiWalletCircleGroup, type CircleConsentOffer, type OwnerStepCircleSteps, type PreparedCircleGroup } from './flofi-wallet-circle-flow';
import { CircleConsentCard } from './circle-consent-card';
import { chosenEvmProvider, injected } from '../wallet/evm-discovery';
import type { WalletWorkflowReviewView } from '../delegation/views';
import { WALLET_BATCH_OUTCOME_UNKNOWN, canEndWorkflow, haltedAs } from '../workflow-runs/state-machine';
import { EXECUTION_PHASE_LABEL } from '../domain/execution-phase';
import { awaitedDelivery, runProgress, runStepPhase } from '../workflow-runs/run-step-phase';
import { useLocale } from '../i18n/locale';
import type { ClaimedProposal } from '../platform/approvals';
import type { WorkflowRunClaim } from '../platform/workflow-run-approvals';
import { signWorkflowGrant } from './delegation-browser';

const STEP_STATE: Readonly<Record<string, string>> = { PENDING: 'Waiting', READY: 'Ready for your signature', AWAITING_OWNER: 'In your wallet', DELEGATED: 'Authorized',
  RECONCILED: 'Reconciled', FAILED: 'Failed', UNCERTAIN: 'Outcome pending', SKIPPED: 'Not run', BLOCKED: 'Stopped before submission' };
const RUN_STATE: Readonly<Record<string, string>> = { PENDING: 'Choose how to authorize', RUNNING: 'Running', COMPLETED: 'Completed', HALTED: 'Partially completed',
  FAILED: 'Failed', ATTENTION: 'Needs attention', CANCELLED: 'Ended', EXPIRED: 'Expired' };
/** How a HALTED run is described: the one rule the Editor and /approve share (workflow-runs/state-machine.ts). */
export { haltedAs };
const HALTED_BADGE: Readonly<Record<ReturnType<typeof haltedAs>, string>> = { PARTIAL: 'Partially completed', NOTHING_SENT: 'Stopped: nothing sent', STOPPED: 'Stopped' };
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
const GROUP_STATE: Readonly<Record<string, string>> = { PLANNED: 'Not signed yet', PREPARED: 'Waiting for your wallet', AUTHORIZED: 'Authorized', SUBMITTED: 'Sent to the network', RECONCILED: 'Reconciled',
  FAILED: 'Failed', UNCERTAIN: 'Outcome pending', BLOCKED: 'Stopped before submission', SKIPPED: 'Not run', EXPIRED: 'Expired' };
const NETWORK: Readonly<Record<string, string>> = { 'eip155:1': 'Ethereum', 'eip155:8453': 'Base', 'eip155:42161': 'Arbitrum One', 'eip155:4663': 'Robinhood Chain',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana' };
/**
 * A fee amount with at most 6 decimals: a nonzero fee never reads "0" (L2 fees are tiny), and a maximum is rounded UP, never below itself.
 * ADR-0010: wei reads as ETH, lamports as SOL, a token fee in its own symbol and decimals — a USDC amount is never printed as ETH.
 */
const units = (amount: string, unit: string, round: 'down' | 'up' = 'down', token?: { readonly symbol: string; readonly decimals: number } | null) =>
  feeAmountText(amount, unit, token ?? null, round);
/** "Steps 2–3" or "Step 2": a single-step group is never "Steps 3–3". */
const stepsOf = (tr: (key: string, ...args: string[]) => string, from: number, to: number) => from === to ? tr('Step {0}', String(from + 1)) : tr('Steps {0}–{1}', String(from + 1), String(to + 1));
const short = (hash: string) => hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
/**
 * P0 universal execution: the batches this browser handed to the owner's wallet, per approval and group, written immediately before
 * `wallet_sendCalls` is requested (`sendWalletBatch`'s `onSending`; the Editor's rule, now on /approve too — the page every MCP, channel and chat
 * handoff uses). Never earlier: a failure before that request (a network switch, the account check) sent nothing and must not leave a marker
 * that blocks the group for good. A wallet that ignores the app-provided EIP-5792 id cannot be asked whether it holds an earlier request, so
 * after a lost answer the group is never sent again from here: the batch id is reused when the wallet answered, else the owner is told to
 * check the wallet (the group can be ended once its preparation expires).
 * `nonce`: which call wrote the attempt. Another tab of this browser may hand the same group to the wallet between this tab's checks and its
 * request, so the attempt is re-read the moment the wallet would be asked (one found then is another's: this tab does not send), and an
 * answer that proves nothing was sent clears only this call's own attempt, never another tab's.
 */
const BATCH_ATTEMPTS_KEY = 'flofi.approve-batch-attempts.v1';
type BatchAttempt = { readonly at: string; readonly batchId?: string; readonly nonce?: string };
function batchAttempts(): Record<string, BatchAttempt> {
  try { const v = JSON.parse(localStorage.getItem(BATCH_ATTEMPTS_KEY) ?? '{}') as unknown; return v && typeof v === 'object' ? v as Record<string, BatchAttempt> : {}; } catch { return {}; }
}
function putBatchAttempt(key: string, value: BatchAttempt | null) {
  try { const all = batchAttempts(); if (value) all[key] = value; else delete all[key]; localStorage.setItem(BATCH_ATTEMPTS_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
}
/**
 * The Editor's record of the batch IT handed to the owner's wallet for the same run (`editor-workflow-run.tsx`, `STORAGE_KEY`; same origin, so
 * the same storage): runs by approval id, each with `sent` = { group, batchId, attempt?, nonce? } — `attempt` while `wallet_sendCalls` has not
 * answered (its `batchId` is then only the group's own EIP-5792 id, no answer), else the id the wallet answered with. The Editor links here for
 * the same run, and a wallet that ignores app-provided ids cannot tell either page it already holds a batch: an attempt there is treated
 * exactly like one of this page's own. Read only (the Editor keeps its record). Anything unreadable as an answer reads as an unanswered attempt.
 */
const EDITOR_RUNS_KEY = 'flofi.editor-workflow-runs.v2';
function editorAttempt(approvalId: string, group: number): BatchAttempt | null {
  try {
    const all = JSON.parse(localStorage.getItem(EDITOR_RUNS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(all)) return null;
    const sent = (all.find(r => Boolean(r) && (r as { approvalId?: unknown }).approvalId === approvalId) as { sent?: unknown } | undefined)?.sent as
      { group?: unknown; batchId?: unknown; attempt?: unknown } | null | undefined;
    if (!sent || typeof sent !== 'object' || sent.group !== group) return null;
    return sent.attempt === undefined && typeof sent.batchId === 'string' && sent.batchId ? { at: '', batchId: sent.batchId } : { at: '' };
  } catch { return null; }
}
/** This page's attempt for the group, else the Editor's; an answered one (a batch id) first, since it is read back without asking again. */
function anyAttempt(approvalId: string, group: number): BatchAttempt | null {
  const own = batchAttempts()[`${approvalId}:${group}`] ?? null, editor = editorAttempt(approvalId, group);
  return own?.batchId ? own : editor?.batchId ? editor : own ?? editor;
}
/**
 * Wallet answers that mean nothing was sent: the attempt is forgotten and the group may be offered again. WALLET_ATTEMPT_UNRECORDABLE: this
 * browser could not keep (write and read back) its attempt, so the wallet was never asked.
 */
const NOTHING_SENT: ReadonlySet<string> = new Set(['WALLET_REQUEST_REJECTED', 'WALLET_WRONG_NETWORK', 'EVM_WALLET_NOT_FOUND', 'WALLET_BATCH_NOT_SENT',
  'WALLET_ACCOUNT_MISMATCH', 'WALLET_ATTEMPT_UNRECORDABLE', 'GAS_SPONSORSHIP_WALLET_UNSUPPORTED', ...CIRCLE_NOTHING_SENT]);
/** Whether the owner's wallet knows a batch id (`wallet_getCallsStatus` answers; EIP-5792 5730 or no answer: it does not). */
const walletKnows = (batchId: string) => walletBatchHashes(batchId).then(() => true, () => false);
/**
 * States whose own words already say what the wallet answered or the chain decided: only these keep their label when a step or group carries
 * WALLET_BATCH_OUTCOME_UNKNOWN (e.g. a late answer recorded after it). Every other state — BLOCKED ("Stopped before submission") when the run
 * stopped at its expiry, SKIPPED ("Not run") when it was ended, anything else — would claim the batch did not run, which nothing proves.
 */
const ANSWERED_STATES: readonly string[] = ['AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'RECONCILED', 'FAILED'];
/**
 * A step or group carrying WALLET_BATCH_OUTCOME_UNKNOWN (the run was stopped at its expiry or ended while a batch handed to the owner's wallet
 * had no recorded answer) in a state that does not say otherwise: it may have executed before its on-chain deadline.
 */
const batchUnanswered = (item: { readonly state: string; readonly code: string | null }) => item.code === WALLET_BATCH_OUTCOME_UNKNOWN && !ANSWERED_STATES.includes(item.state);
/** A step's or group's state in words; one whose wallet batch may have executed unseen is never called "Not run" or "Stopped before submission". */
const stateText = (labels: Readonly<Record<string, string>>, item: { readonly state: string; readonly code: string | null }) =>
  batchUnanswered(item) ? 'Its batch may have executed before it expired; check your wallet\'s activity' : labels[item.state] ?? item.state;
/**
 * A step's state in words. A user-funded run's DELEGATED step belongs to its group, so it says what that group shows: signed in the wallet,
 * waiting for it while the run can still ask, else not signed (a halted or ended run) — never "Authorized" for a group nothing was signed for.
 * The channels' rule (channels/core/status.ts) and the Editor's. A delegated-mode run's DELEGATED step keeps "Authorized" (its grant was signed).
 */
const stepText = (run: WorkflowRunClaim['run'], step: WorkflowRunClaim['run']['steps'][number]) => {
  if (batchUnanswered(step) || run.mode !== 'USER_FUNDED' || step.state !== 'DELEGATED') return stateText(STEP_STATE, step);
  const group = (run.groups ?? []).find(g => g.steps[0] <= step.index && step.index <= g.steps[1]);
  return group?.signed ? 'Signed in your wallet' : ['RUNNING', 'ATTENTION'].includes(run.state) ? 'Waiting for your wallet' : 'Not signed';
};

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
  // BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: a batch the wallet is still reporting, and cancellations of signed operations sent from this page.
  const [waitingBatch, setWaitingBatch] = useState(false), [revocations, setRevocations] = useState<Readonly<Record<number, string>>>({});
  const { run, plan } = claim;
  // Owner requirement (FloFi Wallet + Circle): FloFi's consent card while it waits for the owner's answer (the action in flight awaits it), and the
  // step a "Not now" sent to its own flow (said once, until the next action).
  const [consentOffer, setConsentOffer] = useState<CircleConsentOffer | null>(null), [declinedStep, setDeclinedStep] = useState<number | null>(null);
  const consentAnswer = useRef<((agreed: boolean) => void) | null>(null);
  const askConsent = (offer: CircleConsentOffer) => new Promise<boolean>(resolve => { consentAnswer.current = resolve; setConsentOffer(offer); });
  const answerConsent = (agreed: boolean) => { const resolve = consentAnswer.current; consentAnswer.current = null; setConsentOffer(null); resolve?.(agreed); };
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
    if (acting.current) return; acting.current = true; setBusy(true); setDeclinedStep(null);
    try {
      const result = await work();
      if (result.ok) { unknownOutcome.current = null; setReview(null); onProposal(result.value); }
      else { unknownOutcome.current = result.code === 'DELEGATION_OUTCOME_UNKNOWN' ? lastSent.current : null; onError(result.code); }
    }
    catch (cause) {
      // ADR-0010: a Circle refusal (the page's own check, or the server's permit/upgrade step) keeps its closed code and its words (CIRCLE_REFUSAL).
      // Final review (P1): so does FloFi Wallet's own answer (e.g. FLOFI_WALLET_ALREADY_SIGNED: this request's signature was already asked once).
      const code = cause instanceof Error
        && /^(WALLET_[A-Z_]+|EVM_WALLET_NOT_FOUND|SOLANA_WALLET_[A-Z_]+|EIP5792_[A-Z_]+|GAS_SPONSORSHIP_[A-Z_]+|CIRCLE_[A-Z_]+|FLOFI_WALLET_[A-Z_]+)$/.test(cause.message)
        ? cause.message : 'APPROVAL_UNAVAILABLE';
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
  // Capabilities are read for the wallet's selected account (`eth_accounts[0]`): while the owner chooses the mode the run has no groups and no
  // step wallet yet, so nothing else names the account. That is enough: atomic batching is a property of the wallet, not of one of its
  // accounts, and the safety guarantee is the send-time check that the selected account IS the run's account (`sendWalletBatch`).
  const evmAddress = async () => { const p = chosenEvmProvider() ?? injected(); const a = p ? await p.request({ method: 'eth_accounts', params: [] }) : null;
    return Array.isArray(a) && typeof a[0] === 'string' ? a[0].toLowerCase() : null; };
  const startUserFunded = () => act(async () => {
    const chains = [...new Set(plan.userFunded.groups.map(g => g.chain))];
    const profile = await walletProfile(plan.confirmEachStep.walletNamespaces.includes('eip155') ? await evmAddress() : null, chains,
      plan.confirmEachStep.walletNamespaces.includes('solana'));
    const started = await startUserFundedWorkflowRun(approvalId, profile);
    // Owner requirement (FloFi Wallet + Circle): the server left a FloFi Wallet owner-step group's first step unloaded so it can be asked about
    // first: the started run is shown, then the server prepares it — ETH covers: the step loads exactly as before; Circle: FloFi's consent card.
    const runClaim = started.ok ? started.value.view?.workflowRun ?? null : null;
    const candidate = runClaim && !runClaim.step ? floFiWalletCircleGroup(runClaim.run, profile.eip155?.wallet) : null;
    if (!started.ok || !runClaim || candidate === null) return started;
    onProposal(started.value);
    return askCircleFirst(ownerStepCircle(candidate, runClaim.run.currentStep));
  });
  /** "Continue to step N": a FloFi Wallet owner-step group whose fee Circle may pay is asked about first; any other step loads exactly as before. */
  const continueNext = () => act(async () => {
    const candidate = floFiWalletCircleGroup(run, evmWalletKind());
    return candidate === null ? continueWorkflowRunHandoff(approvalId) : askCircleFirst(ownerStepCircle(candidate, run.currentStep));
  });
  /**
   * Owner requirement (FloFi Wallet + Circle): the server actions a Circle-paid group of this run is continued with (`flofi-wallet-circle-flow.ts`):
   * FloFi's consent card, "Not now" (withdrawn, the step loaded into its own flow), or the signatures — the upgrade authorization on first use (FloFi
   * Wallet bound to this run, after the consent was recorded), the USDC permit, then the operation, each checked by this page first.
   */
  const circleSteps = (index: number, step: number) => ({
    consent: askConsent,
    decline: async () => {
      const declined = await declineUserFundedGroupCircle(approvalId, index);
      if (declined.ok) setDeclinedStep(step + 1);
      return declined;
    },
    authorize: async (group: PreparedCircleGroup, agreed: boolean) => {
      const p = group.prepared as Record<string, unknown>;
      const signature = await signCirclePaidGroup(group.feePayer, p, permit => permitUserFundedGroup(approvalId, index, permit),
        { runId: run.workflowRunId, consent: async () => agreed, recordConsent: () => consentUserFundedGroupUpgrade(approvalId, index),
          upgrade: signed => upgradeUserFundedGroup(approvalId, index, signed) }, { runId: run.workflowRunId });
      return authorizeUserFundedGroup(approvalId, index, { kind: 'EVM_USER_OPERATION', signature });
    },
  });
  const ownerStepCircle = (index: number, step: number): OwnerStepCircleSteps<ClaimedProposal> => ({ ...circleSteps(index, step),
    prepare: () => prepareUserFundedGroup(approvalId, index, undefined, 'FLOFI_WALLET'), loadStep: () => continueWorkflowRunHandoff(approvalId) });
  /** Prepares one group on the server, asks the owner's wallet for exactly that, and relays the answer (verified by the server). */
  const authorizeGroup = (index: number) => act(async () => {
    const attemptKey = `${approvalId}:${index}`, view = run.groups?.find(g => g.index === index) ?? null;
    // A batch the wallet already holds is reported BEFORE anything is prepared again: once it executed, a fresh preparation's simulation fails
    // (its effects are already on chain) and a refused preparation must never hide the batch the owner sent. The id the wallet answered with
    // (kept by this browser) is recorded as is; else the batch id the run shows for the group (its own EIP-5792 id while it is prepared), if
    // the wallet knows it. Only then is the group prepared (again). An attempt the Editor made for the same run counts as this page's own.
    const stored = anyAttempt(approvalId, index);
    if (stored?.batchId) return recordBatch(index, attemptKey, stored.batchId);
    if (view?.strategy === 'EVM_WALLET_BATCH' && view.batchId) {
      if (await walletKnows(view.batchId)) return recordBatch(index, attemptKey, view.batchId);
      // The wallet was asked and its answer was lost, and it does not know the group's id. That id is fixed per run and group, so preparing
      // again could not change this answer — it could only fail (e.g. the sent batch made the fresh simulation revert) and hide it.
      if (stored) throw new Error('WALLET_BATCH_SEND_UNCONFIRMED');
    }
    // Otherwise the group is prepared (again). A lost answer still reaches this point only when the run showed no batch id for the group: its
    // prepared id is then asked of the wallet below before anything is sent.
    const prepared = await prepareUserFundedGroup(approvalId, index, batchHandout(approvalId, index), evmWalletKind());
    if (!prepared.ok) return prepared;
    keepBatchHandout(approvalId, index, prepared.value.handout);
    const p = prepared.value.prepared as unknown as Record<string, unknown>;
    if (p.kind === 'EVM_WALLET_BATCH') {
      const request = p.request as eip5792.SendCallsRequest;
      // The group's batch may already be in the wallet (a reload, a lost answer, an earlier preparation): it is read back by its id, never sent again.
      const known = request.id ? await walletKnows(request.id) : false;
      const earlier = anyAttempt(approvalId, index);
      let batchId: string;
      if (known) batchId = request.id!;
      else if (earlier?.batchId) batchId = earlier.batchId;
      else if (earlier) throw new Error('WALLET_BATCH_SEND_UNCONFIRMED');
      else {
        // The attempt is kept the moment the wallet is asked to send (never before: a failed network switch or account check sent nothing).
        // Re-read then: an attempt found at that moment was written by another tab or the Editor (none existed above), so this tab never sends
        // the group too.
        const nonce = crypto.randomUUID();
        try {
          batchId = await sendWalletBatch(request, () => {
            if (anyAttempt(approvalId, index)) throw new Error('WALLET_BATCH_SEND_UNCONFIRMED');
            putBatchAttempt(attemptKey, { at: new Date().toISOString(), nonce });
            // Read back before the wallet is asked: the attempt is what stops a lost answer from ever leading to a second send, so a browser
            // that cannot keep it (storage blocked, full or failing) never asks the wallet (WALLET_ATTEMPT_UNRECORDABLE: nothing sent). Another
            // tab's attempt landing in between stops this request too.
            const back = batchAttempts()[attemptKey] as BatchAttempt | null | undefined;
            if (back?.nonce !== nonce) throw new Error(back ? 'WALLET_BATCH_SEND_UNCONFIRMED' : 'WALLET_ATTEMPT_UNRECORDABLE');
          }, batchSponsorshipOf(p));
        } catch (cause) {
          // Nothing was sent by THIS call: only its own attempt is forgotten (another tab's stays, whatever this call's failure).
          if (cause instanceof Error && NOTHING_SENT.has(cause.message) && batchAttempts()[attemptKey]?.nonce === nonce) putBatchAttempt(attemptKey, null);
          throw cause;
        }
        putBatchAttempt(attemptKey, { at: new Date().toISOString(), batchId, nonce });
      }
      return recordBatch(index, attemptKey, batchId);
    }
    if (isCirclePaid(p)) {
      // ADR-0010: the fee is paid from the owner's USDC through Circle — the permit, then the operation, each checked by this page first.
      // Owner requirement (FloFi Wallet + Circle): a FloFi Wallet owner-step group's preparation shows FloFi's consent card first (Privy shows no
      // confirmation for the EIP-7702 upgrade); "Not now" withdraws it and loads the step into its own flow, nothing signed. Any other wallet's
      // Circle-paid group goes straight to its wallet's own two prompts, as before.
      return circlePaidGroup(circleSteps(index, view?.steps[0] ?? run.currentStep), { prepared: p, feePayer: prepared.value.feePayer });
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
  /** The wallet holds the group's batch: the run records its id, then its result is followed and reported. */
  async function recordBatch(index: number, attemptKey: string, batchId: string) {
    const authorized = await authorizeUserFundedGroup(approvalId, index, { kind: 'EVM_WALLET_BATCH', batchId });
    if (!authorized.ok) return authorized;
    // The run recorded the batch: from now on the server holds its id (a reload recovers it from there).
    putBatchAttempt(attemptKey, null);
    return followBatch(index, batchId, authorized);
  }
  /** Waits for the wallet to settle the batch and reports it: its transactions, or that it failed off chain (nothing was sent). */
  async function followBatch<T>(index: number, batchId: string, pending: T) {
    setWaitingBatch(true);
    try {
      for (let i = 0; i < 40; i++) {
        const done = await walletBatchHashes(batchId).catch(() => null);
        if (done?.hashes.length) return reportUserFundedBatch(approvalId, index, [...done.hashes]);
        if (done?.failed) return reportUserFundedBatch(approvalId, index, [], true);
        await new Promise(resolve => setTimeout(resolve, 3_000));
      }
      return pending;
    } finally { setWaitingBatch(false); }
  }
  /** A batch the wallet already sent (e.g. after a reload): its hashes are read back from the wallet and reported. */
  const recoverBatch = (index: number, batchId: string) => act(async () => {
    const done = await walletBatchHashes(batchId);
    return done?.hashes.length ? reportUserFundedBatch(approvalId, index, [...done.hashes]) : done?.failed ? reportUserFundedBatch(approvalId, index, [], true)
      : workflowRunStatusHandoff(approvalId);
  });
  const currentGroup = run.groups?.find(g => g.steps[0] <= run.currentStep && run.currentStep <= g.steps[1]) ?? null;
  // "Try this step again" is offered exactly when the server would accept it (`run.resumable`, its own `resumeRefusal`: inside the run's
  // window, a confirm-mode or owner-step group's step only while BLOCKED, any other group only while BLOCKED and unsigned). Only a view without
  // that field falls back to this page's own reading: a confirm-mode step, an owner-step group's step, or a group stopped before anything was signed.
  const ownerStepGroup = currentGroup?.strategy === 'EVM_OWNER_STEP' || currentGroup?.strategy === 'SOLANA_OWNER_STEP';
  const said = (run as { readonly resumable?: unknown }).resumable;
  // A group whose batch was handed to the wallet and never answered may have executed: never tried again from this page's own reading either.
  const resumable = typeof said === 'boolean' ? said : run.mode !== 'USER_FUNDED' || ownerStepGroup
    || (currentGroup?.state === 'BLOCKED' && !currentGroup.signed && currentGroup.code !== WALLET_BATCH_OUTCOME_UNKNOWN);
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
  // A run stopped at its expiry or ended while a batch it handed to the owner's wallet was never answered: that batch may have executed before
  // its on-chain deadline. Any step or group carrying WALLET_BATCH_OUTCOME_UNKNOWN decides, whatever state it shows now (the server's own rule for
  // the run's note, workflow-runs/service.ts, and the channels'): the halted or ended words then never say "before any step completed", "nothing
  // sent" or that the reconciled steps' funds still rest in the wallet. A COMPLETED run reconciled every step, and says so.
  const unanswered = run.state !== 'COMPLETED'
    && ((run.groups ?? []).some(g => g.code === WALLET_BATCH_OUTCOME_UNKNOWN) || run.steps.some(s => s.code === WALLET_BATCH_OUTCOME_UNKNOWN));
  // Such a run is never "nothing sent" (badge or text), whatever a view without the server's own `halted` would suggest (fails closed to STOPPED).
  const halted = run.state === 'HALTED' ? (unanswered && haltedAs(run) === 'NOTHING_SENT' ? 'STOPPED' : haltedAs(run)) : null;
  const endable = canEndWorkflow(run, run.steps, run.groups ?? [], new Date());
  // P0 hotfix (E1): a batched bridge's awaited delivery, in the shared execution vocabulary; progress counts reconciled steps only.
  const phased = { mode: run.mode, steps: run.steps, groups: run.groups ?? [] }, awaited = awaitedDelivery(phased), progress = runProgress(phased);
  const stepWords = (step: WorkflowRunClaim['run']['steps'][number]) => {
    const p = runStepPhase(phased, step);
    return p && p.phase !== 'RECONCILED' ? tr(EXECUTION_PHASE_LABEL[p.phase], p.network ? tr(p.network) : '') : tr(stepText(run, step));
  };
  return <section className="workflow-run" aria-label={tr('Workflow steps')} data-run-state={run.state}>
    <div className="workflow-run-head">
      <strong>{tr('{0}-step workflow', String(run.stepCount))}</strong>
      <span className="status-badge info">{tr(halted ? HALTED_BADGE[halted] : RUN_STATE[run.state] ?? run.state)}</span>
      {run.mode && <span className="muted">{tr(run.mode === 'DELEGATED' ? 'Authorized once with your wallet' : run.mode === 'USER_FUNDED'
        ? 'You authorize each group with your own wallet' : 'You confirm each step in your wallet')}</span>}
    </div>
    <ol className="workflow-run-steps">
      {run.steps.map(step => <li key={step.index} data-step-state={step.state} aria-current={step.index === run.currentStep && open ? 'step' : undefined}>
        <span>{tr('Step {0}', String(step.index + 1))} · {tr(ACTION[step.action] ?? step.action)}</span>
        <span className="workflow-run-state">{stepWords(step)}</span>
        {step.outcome?.submissions.map(tx => tx.explorerUrl
          ? <a key={tx.hash} href={tx.explorerUrl} target="_blank" rel="noreferrer"><code>{short(tx.hash)}</code></a>
          : <code key={tx.hash}>{short(tx.hash)}</code>)}
      </li>)}
    </ol>
    {/* Review B1/LQ1: before anything of the run was signed or reconciled, a later step on a network that needs its native coin for its fee after an
        earlier token-paid one there is said visibly (the run would stop there with the funds midway); the design stays as it is. */}
    {open && !(run.groups ?? []).some(g => g.signed || ANSWERED_STATES.includes(g.state)) && !run.steps.some(s => ['RECONCILED', 'FAILED', 'UNCERTAIN'].includes(s.state))
      && (plan.nativeLater ?? []).map(w => <p key={w.chain} className="workflow-run-native-later" role="note" data-native-later={w.chain}>
        {nativeLaterMessage(w, tr, action => tr(ACTION[action] ?? action))}</p>)}
    {run.stepCount > 1 && run.mode === 'USER_FUNDED' && <p className="muted workflow-run-progress">{tr('{0} of {1} steps completed', String(progress.completed), String(progress.total))}</p>}
    {awaited && <p role="status">{tr('Your batch is confirmed on {0}. FloFi is waiting for the delivery on {1} and keeps checking even if you leave this page; nothing is sent again.',
      tr(awaited.source), tr(awaited.destination))}</p>}
    {choosing && <div className="workflow-run-choice">
      <p><strong>{tr('Nothing is authorized yet.')}</strong> {tr('Choose how to authorize this workflow. Each step starts only after the previous one is reconciled on chain.')}</p>
      <div className="approval-actions">
        {plan.confirmEachStep.available && <button type="button" className="secondary" disabled={busy} onClick={() => void act(() => startWorkflowRunHandoff(approvalId))}>
          {tr('Confirm each step in my wallet ({0} confirmations at least)', String(confirmations))}</button>}
        {plan.userFunded?.available && <button type="button" disabled={busy} onClick={() => void startUserFunded()}>
          {plan.userFunded.interactions?.atLeast || plan.userFunded.wallets === 'ASSUMED' || (plan.userFunded.interactions?.networkSwitches ?? 0) > 0
            ? tr('Authorize in groups with my own wallet (at least {0} wallet interactions)', String(userFundedCount))
            : userFundedCount === 1 ? tr('Authorize in groups with my own wallet (one wallet interaction)')
            : tr('Authorize in groups with my own wallet ({0} wallet interactions)', String(userFundedCount))}</button>}
        {plan.delegatedSingleAuthorization.available && !review && <button type="button" disabled={busy} onClick={() => void prepareOnce()}>
          {plan.delegatedSingleAuthorization.walletSignatures > 1
            ? tr('Authorize the whole workflow once ({0} wallet signatures, one per network)', String(plan.delegatedSingleAuthorization.walletSignatures))
            : tr('Authorize the whole workflow once')}</button>}
      </div>
      {plan.userFunded?.available && <ol className="workflow-run-groups" aria-label={tr('Execution groups')}>
        {plan.userFunded.groups.map(g => <li key={g.index}>{tr('{0} on {1}', stepsOf(tr, g.stepFrom, g.stepTo), NETWORK[g.chain] ?? g.chain)}
          {' · '}{tr(GROUP_HOW[g.strategy] ?? g.strategy)}{' · '}{tr(g.signing === 'UPFRONT' ? 'signed now' : 'signed when it becomes due')}
          {g.awaitsDelivery !== null && <> · {tr('waits for the delivery of step {0}', String(g.awaitsDelivery + 1))}</>}
          {g.setup.includes('EVM_SMART_ACCOUNT_UPGRADE') && <> · {tr('your wallet upgrades this account inside the same confirmation (one time)')}</>}
          {/* ADR-0010 review C5: whether ETH or USDC pays this group's fee is decided when it is prepared; Circle then needs two signatures. */}
          {g.tokenGas && <> · {tr('if your ETH cannot pay its network fee, it can be paid from your USDC through Circle: then two signatures (a USDC permit, then the operation)')}</>}</li>)}
      </ol>}
      {plan.userFunded?.available && <p className="muted">{tr('Your wallet pays every network fee, unless FloFi offers to sponsor a step\'s fee and your wallet supports it. FloFi never advances or reimburses gas.')}
        {plan.userFunded.wallets === 'ASSUMED' && <> {tr('The grouping depends on what your wallet supports: FloFi asks your wallet before anything is signed, and a wallet that cannot batch confirms each step.')}</>}</p>}
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
        <span>{tr('{0} on {1}', stepsOf(tr, g.steps[0], g.steps[1]), NETWORK[g.chain] ?? g.chain)} · {tr(g.gasPayment?.upgrade
          ? 'Three signatures: the smart-account upgrade, a USDC permit for the fee, then the operation'
          : g.gasPayment ? 'Two signatures: a USDC permit for the fee, then the operation' : GROUP_HOW[g.strategy] ?? g.strategy)}</span>
        <span className="workflow-run-state">{g.delivery?.state === 'AWAITING_DESTINATION' && (g.state === 'SUBMITTED' || g.state === 'UNCERTAIN') && awaited
          ? `${tr(EXECUTION_PHASE_LABEL.CONFIRMED_AT_SOURCE, tr(awaited.source))} · ${tr(EXECUTION_PHASE_LABEL.AWAITING_DESTINATION, tr(awaited.destination))}`
          : tr(stateText(GROUP_STATE, g))}</span>
        {g.gasPaid?.sponsored || g.maxFee?.sponsorship === 'REQUIRED' && !g.gasPaid ? null : <span className="muted">{tr('Fees paid by {0}', short(g.feePayer))}</span>}
        {g.maxFee?.sponsorship === 'REQUIRED' && !g.gasPaid && <span className="muted">{tr('Sponsored network fee: FloFi offers to pay it (your wallet must support sponsored fees on this network)')}</span>}
        {/* ADR-0010: a fee the owner pays in a token names the token and who receives it — Circle (USDC permit cap) on EVM, Pimlico's Kora fee payer on Solana. */}
        {g.maxFee?.token && !g.gasPaid && <span className="muted">{g.chain.startsWith('solana:')
          ? tr('Network fee, at most {0} · paid from your {1} to Pimlico', units(g.maxFee.amount, g.maxFee.unit, 'up', g.maxFee.token), g.maxFee.token.symbol)
          : tr('Network fee, at most {0} — paid from your USDC through Circle', units(g.maxFee.amount, g.maxFee.unit, 'up', g.maxFee.token))}</span>}
        {g.maxFee && !g.maxFee.token && g.maxFee.sponsorship !== 'REQUIRED' && !g.gasPaid && <span className="muted">{g.maxFee.estimated
          ? tr('About {0} in network fees (an estimate; your wallet shows the final fee)', units(g.maxFee.amount, g.maxFee.unit, 'up'))
          : tr('At most {0} in network fees', units(g.maxFee.amount, g.maxFee.unit, 'up'))}</span>}
        {g.maxFee?.sponsorship === 'OFFERED' && !g.gasPaid && <span className="muted">{tr('Sponsored network fee: FloFi offers to pay it when your wallet supports it; otherwise your wallet pays the estimate above')}</span>}
        {g.gasPaid && <span className="muted">{g.gasPaid.sponsored ? tr('Gas paid by FloFi: {0}', units(g.gasPaid.amount, g.gasPaid.unit))
          : g.gasPaid.paidInToken ? g.chain.startsWith('solana:')
            ? tr('Network fees paid: {0} from your wallet to Pimlico', units(g.gasPaid.paidInToken.amount, 'token', 'up', g.gasPaid.paidInToken))
            : tr('Network fee paid: {0}', units(g.gasPaid.paidInToken.amount, 'token', 'up', g.gasPaid.paidInToken))
          : tr('Network fees paid: {0}', units(g.gasPaid.amount, g.gasPaid.unit))}</span>}
        {/* ADR-0010: Circle's protocol facts stay behind the collapsed technical details. */}
        {g.gasPayment && <details className="review-panel-technical"><summary>{tr('Technical details')}</summary>
          <p className="muted">{tr('Circle paymaster {0} · EntryPoint {1} · USDC permit cap {2}', g.gasPayment.paymaster, g.gasPayment.entryPoint,
            units(g.gasPayment.permitCap, 'token', 'up', g.gasPayment))}</p>
          <p className="muted">{tr('What is left of the permit cap stays approved to Circle\'s paymaster until your next USDC permit replaces it.')}</p></details>}
        {g.submissions.map(tx => tx.explorerUrl ? <a key={tx.hash} href={tx.explorerUrl} target="_blank" rel="noreferrer"><code>{short(tx.hash)}</code></a> : <code key={tx.hash}>{short(tx.hash)}</code>)}
      </li>)}
    </ol>}
    {/* Owner requirement (FloFi Wallet + Circle): FloFi's own consent card, before FloFi Wallet is asked anything for a Circle-paid group. */}
    {consentOffer && <CircleConsentCard offer={consentOffer} network={NETWORK[`eip155:${consentOffer.chainId}`] ?? `eip155:${consentOffer.chainId}`} onAnswer={answerConsent}/>}
    {declinedStep !== null && <p role="status">{tr(CIRCLE_CONSENT_DECLINE.DONE, String(declinedStep))}</p>}
    {run.mode === 'USER_FUNDED' && run.nextAction === 'OWNER_SIGNS_GROUP' && currentGroup && <div className="approval-actions">
      <button type="button" disabled={busy} onClick={() => void authorizeGroup(currentGroup.index)}>
        {tr('Authorize {0} now', stepsOf(tr, currentGroup.steps[0], currentGroup.steps[1]))}</button>
    </div>}
    {waitingBatch && <p role="status">{tr('Waiting for your wallet to report the batch…')}</p>}
    {/* Only a user operation can be signed before it is due (FloFi relays it when due); a wallet batch would be sent at once, out of order. */}
    {run.mode === 'USER_FUNDED' && ['RUNNING', 'ATTENTION'].includes(run.state) && (run.groups ?? []).filter(g => g.signing === 'UPFRONT' && g.strategy === 'EVM_USER_OPERATION'
      && g.state === 'PLANNED' && g.index !== currentGroup?.index).map(g =>
      <div key={g.index} className="approval-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => void authorizeGroup(g.index)}>
          {tr('Sign {0} now; FloFi relays it when it is due', stepsOf(tr, g.steps[0], g.steps[1]))}</button>
      </div>)}
    {/* A user operation the owner signed that FloFi never relayed stays valid on chain (its delegator has no expiry) until the owner uses its nonce key. */}
    {/* Shown once the run can no longer relay it: ended, or halted AT that group (a halted run that may still resume would relay a later one when due). */}
    {run.mode === 'USER_FUNDED' && !['RUNNING', 'ATTENTION'].includes(run.state) && (run.groups ?? []).filter(g => g.strategy === 'EVM_USER_OPERATION' && g.signed
      && !['SUBMITTED', 'UNCERTAIN', 'RECONCILED'].includes(g.state) && (run.state !== 'HALTED' || g.index === currentGroup?.index)).map(g => {
      const label = stepsOf(tr, g.steps[0], g.steps[1]), sent = revocations[g.index];
      return <div key={`revoke-${g.index}`} className="workflow-run-choice">
        <p role="note" id={`revoke-note-${g.index}`}>{tr('You signed {0} as an operation FloFi did not relay. It stays valid until you cancel it with one transaction from your own wallet.', label)}</p>
        {/* ADR-0010 review UX8: Circle was chosen because this wallet's ETH could not pay the network fee, and the cancellation is an ordinary
            transaction the wallet pays in ETH (never in USDC through Circle): said before the wallet is asked. */}
        {g.gasPayment && !sent && <p role="note" id={`revoke-fee-${g.index}`}>{tr('Cancelling is an ordinary transaction from your wallet, and its network fee is paid in ETH, not in USDC through Circle: you need a small amount of ETH on {0} first.', NETWORK[g.chain] ?? g.chain)}</p>}
        {sent ? <p role="status">{tr('Cancellation sent from your wallet ({0}). Once it is confirmed, the signed operation can never execute.', short(sent))}</p>
          : <div className="approval-actions">
            <button type="button" className="secondary" disabled={busy} aria-describedby={g.gasPayment ? `revoke-note-${g.index} revoke-fee-${g.index}` : `revoke-note-${g.index}`} onClick={() => void act(async () => {
              const hash = await revokeUserOperation(g.feePayer, Number(g.chain.slice('eip155:'.length)), run.workflowRunId, g.index, entryPointOfGroup(g.gasPayment));
              setRevocations(current => ({ ...current, [g.index]: hash }));
              return workflowRunStatusHandoff(approvalId);
            })}>{tr('Cancel the signed operation for {0} in my wallet', label)}</button>
          </div>}
      </div>;
    })}
    {run.mode === 'USER_FUNDED' && run.nextAction === 'OWNER_CONFIRMS_BATCH' && currentGroup?.batchId && <div className="approval-actions">
      <button type="button" className="secondary" disabled={busy} onClick={() => void recoverBatch(currentGroup.index, currentGroup.batchId!)}>{tr('Check my wallet for the batch')}</button>
    </div>}
    {nextStep !== null && <div className="approval-actions">
      <button type="button" disabled={busy} onClick={() => void continueNext()}>{tr('Continue to step {0}', String(nextStep))}</button>
    </div>}
    {run.state === 'HALTED' && <div className="workflow-run-choice">
      <p role="status">{halted === 'NOTHING_SENT'
        ? <>{tr('Stopped before anything was sent: your funds stay in your wallet.')}{resumable ? <> {tr('You can run each step through its own flow from here, or end the workflow.')}</> : null}</>
        // A batch that may have executed unseen: neither "before any step completed" nor that the reconciled steps' funds still rest in the
        // wallet (that batch may have spent them); the note below says what may have happened.
        : halted === 'STOPPED' ? tr(unanswered ? 'Stopped. FloFi submits nothing more of this workflow; you decide what happens next.'
          : 'Stopped before any step completed. FloFi submits nothing more of this workflow; you decide what happens next.')
        : tr(unanswered ? 'Partially completed: the reconciled steps stay done. FloFi submits nothing more of this workflow; you decide what happens next.'
          : 'Partially completed: the reconciled steps stay done and their funds rest in your wallet. The step that stopped shows what happened to it.')}</p>
      {resumable ? <div className="approval-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => void act(() => resumeWorkflowRunHandoff(approvalId))}>{tr('Try this step again')}</button>
      </div> : <p className="muted">{tr(currentGroup?.signed ? 'Something you already signed for this step is never replaced: end this workflow and start a new one.'
        : endable ? 'This step cannot be tried again in this workflow: end it, and start a new workflow for anything left to do.'
        : 'This step cannot be tried again in this workflow.')}</p>}
    </div>}
    {/* "Never recorded", not "never reached FloFi": an answer may have arrived after the stop and been refused (WALLET_BATCH_ANSWERED_AFTER_STOP, logged). */}
    {unanswered && <p role="status">{tr('A batch was handed to your wallet and FloFi never recorded an answer for it: it may have executed before it expired. Check your wallet\'s activity.')}</p>}
    {endable && <div className="approval-actions">
      <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => cancelWorkflowRunHandoff(approvalId))}>{tr('End workflow')}</button>
    </div>}
    {run.mode === 'DELEGATED' && open && <div className="workflow-run-choice">
      <p>{tr('Revoking stops FloFi from starting any further step. Submitted transactions keep being observed. The calls you signed stay valid on chain until they expire (at most one hour); to cancel them on chain at once, revoke them from your wallet in FloFi → Credentials.')}</p>
      <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => cancelWorkflowRunHandoff(approvalId))}>{tr('Revoke workflow authorization')}</button>
    </div>}
    {run.state === 'ATTENTION'  && <p role="status">{tr('A submitted step has no final outcome yet. FloFi keeps observing it and never resubmits it.')}</p>}
    {run.state === 'COMPLETED' && <p role="status"><strong>{tr('Every step reconciled.')}</strong> {tr('Your conversation can show the result.')}</p>}
    {/* The fee note describes this build's modes; a legacy delegated run was paid by FloFi's (now retired) executor. */}
    {run.mode !== 'DELEGATED' && <p className="muted workflow-run-note">{tr(plan.notes[0] ?? '')}</p>}
  </section>;
}
