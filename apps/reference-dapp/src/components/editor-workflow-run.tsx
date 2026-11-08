// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * P0 workflow execution: the Editor's ONE execution path for a multi-step Canvas workflow — Review the whole workflow once, Authorize once, and
 * follow the whole run to reconciliation in place, without returning to the Canvas between steps.
 *
 *   Review     the owner's wallet capabilities are read from the wallet itself (EIP-5792 `wallet_getCapabilities`; never a prompt), then the
 *              server prepares, read-only, exactly what the wallet would be asked: every step's amounts (in, quoted out, signed minimum, a
 *              borrow's delivery), the whole-batch simulation (Aave health factor after it) and the fee estimate, and how many wallet
 *              prompts, signatures, transactions, batched calls and network switches the workflow needs (never rounded down)
 *   Authorize  one click: the shared workflow run starts (claimed for the wallet this browser proved), its first group is prepared from fresh
 *              chain facts and handed to the wallet as ONE `wallet_sendCalls` (atomic, no capabilities: the owner's own account sends and pays).
 *              A minimum below the reviewed one is shown and confirmed before the wallet is asked
 *   Progress   the persisted run (status poll): each step's state, transactions and reconciled amounts; a batch the wallet already sent is read
 *              back by its id (never sent twice); a later group is offered when it becomes due. The run id survives a reload or a tab change
 *
 * Nothing here signs or sends: the wallet does, after the owner confirms it there. Every artifact is verified on the server.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { eip5792 } from '@defi-workflow-engine/reference-compiler';
import { authorizeEditorWorkflow, editorWorkflowExecutionAvailability, reviewEditorWorkflow } from '../app/editor-workflow-execution-action';
import { authorizeUserFundedGroup, cancelWorkflowRunHandoff, prepareUserFundedGroup, reportUserFundedBatch, workflowRunStatusHandoff } from '../app/approve-action';
import type { EditorExecutionReview, ReviewAmount } from '../editor/workflow-execution';
import type { ClaimedProposal } from '../platform/approvals';
import type { RunView } from '../workflow-runs/service';
import { useLocale } from '../i18n/locale';
import { sendWalletBatch, signSolanaGroup, signUserOperation, walletBatchHashes, walletProfile } from './user-funded-browser';
import { useWalletProof } from './wallet-proof';

const STORAGE_KEY = 'flofi.editor-workflow-run.v1';
type Stored = { readonly workflowId: string; readonly approvalId: string; readonly workflowHash: string; readonly owner: string };
const readStored = (workflowId: string): Stored | null => {
  try { const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Stored | null; return v && v.workflowId === workflowId ? v : null; } catch { return null; }
};
const writeStored = (value: Stored | null) => { try { if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); else localStorage.removeItem(STORAGE_KEY); } catch { /* tab only */ } };
const CODE = /^[A-Z][A-Z0-9_:]{2,100}$/;
const codeOf = (cause: unknown) => cause instanceof Error && CODE.test(cause.message) ? cause.message
  : (cause as { code?: unknown } | null)?.code === 4001 ? 'WALLET_REQUEST_REJECTED' : 'EDITOR_EXECUTION_FAILED';
const OPEN_RUN = ['PENDING', 'RUNNING', 'ATTENTION', 'HALTED'];
const EVM_MAINNETS: readonly string[] = ['eip155:1', 'eip155:8453', 'eip155:42161', 'eip155:4663'];

export type EditorRunPhase = 'idle' | 'reviewing' | 'reviewed' | 'authorizing' | 'proving' | 'confirm-update' | 'wallet' | 'confirming' | 'running' | 'done';
export type EditorWorkflowRunState = {
  readonly available: boolean; readonly phase: EditorRunPhase; readonly review: EditorExecutionReview | null; readonly error: string | null;
  readonly run: RunView | null; readonly updated: readonly { readonly index: number; readonly reviewed: string; readonly now: string }[];
  /** A run of this workflow exists (started here or found after a reload): the per-step path must not start this workflow again. */
  readonly started: boolean;
  /** The whole workflow runs here as wallet-grouped authorization (the review says so); otherwise the Editor keeps its step-by-step path. */
  readonly grouped: boolean;
  startReview(): Promise<void>; authorize(): Promise<void>; confirmUpdate(): Promise<void>; authorizeDue(): Promise<void>; checkWallet(): Promise<void>; end(): Promise<void>;
  dismiss(): void;
};

/**
 * The Editor's whole-workflow run for this Canvas workflow and connected EVM wallet. `enabled`: the Editor shows a multi-step sequence that has not
 * started through its per-step path in this visit.
 */
export function useEditorWorkflowRun(input: { readonly workflow: { readonly workflowId: string; readonly revision: number }; readonly evmAccount: string | null;
  readonly enabled: boolean }): EditorWorkflowRunState {
  const { workflow, evmAccount, enabled } = input;
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<EditorRunPhase>('idle');
  const [review, setReview] = useState<EditorExecutionReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [updated, setUpdated] = useState<EditorWorkflowRunState['updated']>([]);
  const pendingSend = useRef<{ approvalId: string; index: number; prepared: Record<string, unknown> } | null>(null);
  const acting = useRef(false);
  const proof = useWalletProof('eip155');
  const workflowSnapshot = useRef<unknown>(workflow);
  workflowSnapshot.current = workflow;
  useEffect(() => { void editorWorkflowExecutionAvailability().then(r => setAvailable(r.enabled)).catch(() => setAvailable(false)); }, []);
  // A Review describes one workflow revision and one wallet: any edit or wallet change makes it stale (nothing was started).
  const reviewKey = `${workflow.workflowId}:${workflow.revision}:${evmAccount ?? ''}`;
  const reviewedFor = useRef<string | null>(null);
  useEffect(() => {
    if (reviewedFor.current !== null && reviewedFor.current !== reviewKey && !approvalId) { setReview(null); setPhase('idle'); setError(null); setUpdated([]); reviewedFor.current = null; }
  }, [reviewKey, approvalId]);

  const adopt = useCallback((proposal: ClaimedProposal) => {
    const r = proposal.view.workflowRun?.run ?? null;
    if (!r) return;
    setRun(r);
    if (!OPEN_RUN.includes(r.state)) { setPhase('done'); writeStored(null); }
    else if (r.state !== 'PENDING') setPhase(current => current === 'wallet' || current === 'confirming' ? current : 'running');
  }, []);
  // A run of this workflow started earlier (this tab, a reload or another tab): its progress continues here, read from the server.
  useEffect(() => {
    if (!enabled || approvalId) return;
    const stored = readStored(workflow.workflowId);
    if (!stored) return;
    setApprovalId(stored.approvalId);
    void workflowRunStatusHandoff(stored.approvalId).then(result => { if (result.ok) adopt(result.value); else writeStored(null); }).catch(() => undefined);
  }, [enabled, workflow.workflowId, approvalId, adopt]);
  // Status poll while the run is open (the server observes the chain exactly as its worker does; nothing is resolved or sent by a poll).
  useEffect(() => {
    if (!approvalId || !run || !OPEN_RUN.includes(run.state)) return;
    let stopped = false;
    const timer = setInterval(() => {
      void workflowRunStatusHandoff(approvalId).then(result => { if (!stopped && result.ok) adopt(result.value); }).catch(() => undefined);
    }, 4_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [approvalId, run?.state, adopt]);

  async function guard(work: () => Promise<void>) {
    if (acting.current) return; acting.current = true; setError(null);
    try { await work(); } catch (cause) { setError(codeOf(cause)); setPhase(p => p === 'wallet' || p === 'confirming' ? approvalId ? 'running' : 'reviewed' : p === 'reviewing' ? 'idle' : p === 'authorizing' || p === 'proving' ? 'reviewed' : p); }
    finally { acting.current = false; }
  }
  const profileFor = async (chains: readonly string[]) => walletProfile(evmAccount, chains, false);

  const runReview = () => guard(async () => {
    if (!evmAccount) throw new Error('EVM_WALLET_REQUIRED');
    setPhase('reviewing'); setUpdated([]);
    // The wallet is asked what it can do on FloFi's EVM mainnets (`wallet_getCapabilities` shows no prompt); the server keeps only this workflow's.
    const result = await reviewEditorWorkflow(workflowSnapshot.current, evmAccount, await profileFor(EVM_MAINNETS));
    if (!result.ok) throw new Error(result.code);
    reviewedFor.current = reviewKey; setReview(result.value); setPhase('reviewed');
  });
  /** Hands a prepared group to the owner's wallet and relays the answer; a batch is then followed until the wallet reports its transactions. */
  async function sendPrepared(id: string, index: number, p: Record<string, unknown>, feePayer: string) {
    setPhase('wallet');
    if (p.kind === 'EVM_WALLET_BATCH') {
      const request = p.request as eip5792.SendCallsRequest;
      // A batch the wallet already has (a reload, a lost answer) is read back by its id, never sent again.
      const known = request.id ? await walletBatchHashes(request.id).then(() => true, () => false) : false;
      const batchId = known ? request.id! : await sendWalletBatch(request);
      const authorized = await authorizeUserFundedGroup(id, index, { kind: 'EVM_WALLET_BATCH', batchId });
      if (!authorized.ok) throw new Error(authorized.code);
      adopt(authorized.value); setPhase('confirming');
      await followBatch(id, index, batchId);
      return;
    }
    if (p.kind === 'EVM_USER_OPERATION') {
      const authorized = await authorizeUserFundedGroup(id, index, { kind: 'EVM_USER_OPERATION', signature: await signUserOperation(feePayer, Number(p.chainId), p.typedData) });
      if (!authorized.ok) throw new Error(authorized.code);
      adopt(authorized.value); setPhase('running'); return;
    }
    if (p.kind === 'SOLANA_SIGN_ALL') {
      const txs = (p.transactions as { unsignedTransaction: string }[]).map(t => t.unsignedTransaction);
      const authorized = await authorizeUserFundedGroup(id, index, { kind: 'SOLANA_SIGN_ALL', transactions: await signSolanaGroup(feePayer, txs) });
      if (!authorized.ok) throw new Error(authorized.code);
      adopt(authorized.value); setPhase('running'); return;
    }
    throw new Error('USER_FUNDED_GROUP_NOT_PREPARABLE');
  }
  async function followBatch(id: string, index: number, batchId: string) {
    for (let i = 0; i < 60; i++) {
      const done = await walletBatchHashes(batchId).catch(() => null);
      if (done?.hashes.length) { const r = await reportUserFundedBatch(id, index, [...done.hashes]); if (r.ok) adopt(r.value); setPhase('running'); return; }
      if (done?.failed) { const r = await reportUserFundedBatch(id, index, [], true); if (r.ok) adopt(r.value); setPhase('running'); return; }
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    // Still pending in the wallet: the run keeps observing; "Check my wallet" reads it back later (never a second batch).
    setPhase('running');
  }
  const minimumsOf = (planned: RunView['groups'][number]['planned']) => new Map((planned?.steps ?? []).flatMap(s => s.minimum ? [[s.index, s.minimum] as const] : []));

  const authorize = () => guard(async () => {
    if (!review || !evmAccount) throw new Error('REVIEW_REQUIRED');
    if (review.validUntil && Date.parse(review.validUntil) <= Date.now()) throw new Error('REVIEW_EXPIRED');
    setPhase('authorizing');
    const profile = await profileFor([...new Set(review.groups.map(g => g.chain))]);
    let result = await authorizeEditorWorkflow(workflowSnapshot.current, profile);
    if (!result.ok && result.code === 'EVM_WALLET_PROOF_REQUIRED') {
      // One-time sign-in of this wallet in this browser (EIP-4361 message; it authorizes no transaction), then the same Authorize continues.
      setPhase('proving');
      const proven = await proof.proveEvm();
      if (!proven.account) throw new Error(proven.error ?? 'WALLET_REQUEST_REJECTED');
      setPhase('authorizing');
      result = await authorizeEditorWorkflow(workflowSnapshot.current, profile);
    }
    if (!result.ok) throw new Error(result.code);
    const { approvalId: id, proposal, prepared } = result.value;
    setApprovalId(id); writeStored({ workflowId: workflow.workflowId, approvalId: id, workflowHash: review.workflowHash, owner: evmAccount });
    adopt(proposal);
    // The wallet is asked for exactly what the owner reviewed, or the owner sees what changed first (a signed minimum below the reviewed one).
    const fresh = await workflowRunStatusHandoff(id);
    const planned = fresh.ok ? fresh.value.view.workflowRun?.run.groups[0]?.planned ?? null : null;
    if (fresh.ok) adopt(fresh.value);
    const lower = [...minimumsOf(planned)].flatMap(([index, now]) => {
      const before = review.steps[index]?.minimum;
      return before && BigInt(now.units) < BigInt(before.units) ? [{ index, reviewed: before.text, now: now.text }] : [];
    });
    pendingSend.current = { approvalId: id, index: 0, prepared: prepared.prepared as unknown as Record<string, unknown> };
    if (lower.length) { setUpdated(lower); setPhase('confirm-update'); return; }
    await sendPrepared(id, 0, pendingSend.current.prepared, prepared.feePayer);
  });
  const confirmUpdate = () => guard(async () => {
    const pending = pendingSend.current;
    if (!pending || !evmAccount) throw new Error('REVIEW_REQUIRED');
    setUpdated([]);
    // Prepared again from fresh facts if the earlier preparation expired (the same group, the same batch id: never a second batch).
    const prepared = await prepareUserFundedGroup(pending.approvalId, pending.index);
    if (!prepared.ok) throw new Error(prepared.code);
    await sendPrepared(pending.approvalId, pending.index, prepared.value.prepared as unknown as Record<string, unknown>, prepared.value.feePayer);
  });
  /** A later group that became due (or a group the wallet answer was lost for): prepared now and handed to the wallet. */
  const authorizeDue = () => guard(async () => {
    if (!approvalId || !run) throw new Error('WORKFLOW_RUN_NOT_FOUND');
    const group = run.groups.find(g => g.steps[0] <= run.currentStep && run.currentStep <= g.steps[1]);
    if (!group) throw new Error('WORKFLOW_RUN_GROUP_NOT_FOUND');
    const prepared = await prepareUserFundedGroup(approvalId, group.index);
    if (!prepared.ok) throw new Error(prepared.code);
    await sendPrepared(approvalId, group.index, prepared.value.prepared as unknown as Record<string, unknown>, prepared.value.feePayer);
  });
  /** The wallet already has this run's batch (after a reload, a closed tab or a timeout): its transactions are read back and reported. */
  const checkWallet = useCallback(() => guard(async () => {
    if (!approvalId || !run) return;
    const group = run.groups.find(g => g.state === 'AUTHORIZED' && g.batchId) ?? run.groups.find(g => g.state === 'PREPARED' && g.batchId);
    if (!group?.batchId) { const r = await workflowRunStatusHandoff(approvalId); if (r.ok) adopt(r.value); return; }
    const done = await walletBatchHashes(group.batchId).catch(() => null);
    if (done?.hashes.length) {
      if (group.state === 'PREPARED') { const a = await authorizeUserFundedGroup(approvalId, group.index, { kind: 'EVM_WALLET_BATCH', batchId: group.batchId }); if (a.ok) adopt(a.value); }
      const r = await reportUserFundedBatch(approvalId, group.index, [...done.hashes]); if (r.ok) adopt(r.value);
    } else if (done?.failed && group.state === 'AUTHORIZED') { const r = await reportUserFundedBatch(approvalId, group.index, [], true); if (r.ok) adopt(r.value); }
    else { const r = await workflowRunStatusHandoff(approvalId); if (r.ok) adopt(r.value); }
  }), [approvalId, run, adopt]);
  // After a reload with a batch in the wallet, its result is read back once, automatically (never sent again).
  const recovered = useRef<string | null>(null);
  useEffect(() => {
    if (!approvalId || !run || run.nextAction !== 'OWNER_CONFIRMS_BATCH' || recovered.current === approvalId || phase === 'wallet' || phase === 'confirming') return;
    recovered.current = approvalId;
    void checkWallet();
  }, [approvalId, run?.nextAction, phase, checkWallet]);
  const end = () => guard(async () => {
    if (!approvalId) return;
    const r = await cancelWorkflowRunHandoff(approvalId);
    if (!r.ok) throw new Error(r.code);
    adopt(r.value); writeStored(null);
  });
  const dismiss = () => { setApprovalId(null); setRun(null); setReview(null); setPhase('idle'); setError(null); setUpdated([]); writeStored(null); recovered.current = null; };
  const grouped = Boolean(review && review.mode !== 'STEP_BY_STEP' && !review.refusal);
  return { available: available && enabled, phase, review, error, run, updated, started: Boolean(approvalId), grouped,
    startReview: runReview, authorize, confirmUpdate, authorizeDue, checkWallet, end, dismiss };
}

const ACTION: Readonly<Record<string, string>> = { swap: 'Swap', bridge: 'Bridge', supply: 'Supply', borrow: 'Borrow', repay: 'Repay', withdraw: 'Withdraw',
  add_liquidity: 'Add liquidity', transfer: 'Transfer' };
const STEP_STATE: Readonly<Record<string, string>> = { PENDING: 'Waiting', READY: 'Ready for your signature', AWAITING_OWNER: 'In your wallet', DELEGATED: 'Authorized in the batch',
  RECONCILED: 'Reconciled', FAILED: 'Failed', UNCERTAIN: 'Outcome pending', SKIPPED: 'Not run', BLOCKED: 'Stopped before submission' };
const GROUP_STATE: Readonly<Record<string, string>> = { PLANNED: 'Not signed yet', PREPARED: 'Waiting for your wallet', AUTHORIZED: 'Confirmed in your wallet', SUBMITTED: 'Sent to the network',
  RECONCILED: 'Reconciled', FAILED: 'Failed', UNCERTAIN: 'Outcome pending', BLOCKED: 'Stopped before submission', SKIPPED: 'Not run', EXPIRED: 'Expired' };
const HOW: Readonly<Record<string, string>> = { EVM_WALLET_BATCH: 'One wallet confirmation: one atomic transaction', EVM_USER_OPERATION: 'One signature now; FloFi relays it when due',
  EVM_OWNER_STEP: 'Each step confirmed in your wallet', SOLANA_SIGN_ALL: 'One Solana signing request for every transaction', SOLANA_OWNER_STEP: 'One Solana prompt per step',
  SOLANA_DURABLE_NONCE: 'One Solana signing request now' };
/** Why fewer wallet interactions are not possible, in plain words (closed codes; anything else is shown with its code). */
export const EXECUTION_REASON: Readonly<Record<string, string>> = {
  WALLET_ATOMIC_BATCH_UNSUPPORTED: 'Your wallet does not offer atomic batching on this network, so each step is confirmed in your wallet.',
  WALLET_ATOMIC_BATCH_UNKNOWN: 'Your wallet did not report atomic batching on this network, so each step is confirmed in your wallet.',
  USER_FUNDED_CHAIN_DISABLED: 'Grouped authorization is not enabled for this network on this FloFi deployment.',
  WORKFLOW_BINDING_RESOLVED_WHEN_DUE: 'A step spends what an earlier step delivers on another network; it is authorized when that delivery lands.',
  USER_OPERATION_BUNDLER_UNAVAILABLE: 'A step after a bridge is authorized when the bridge delivery lands (no relay is configured for signing it earlier).',
  EVM_SMART_ACCOUNT_REQUIRED: 'A step after a bridge is authorized when the bridge delivery lands (your account is not a smart account).',
  SOLANA_MULTI_SIGN_UNSUPPORTED: 'Your Solana wallet confirms each transaction separately.',
  SOLANA_DURABLE_NONCE_NOT_OFFERED: 'A Solana step after a bridge is signed when the delivery lands (a recent blockhash expires within about a minute).',
};
export const EXECUTION_REFUSAL: Readonly<Record<string, string>> = {
  BORROW_UNSAFE_HEALTH_FACTOR: 'This Borrow would leave your Aave health factor below 2.0 after the batch. Lower the Borrow amount or supply more collateral.',
  SIMULATION_REVERTED: 'FloFi simulated the whole batch and step {0} would fail on chain now. Check its amount, balance and allowance; nothing was sent.',
  SWAP_MINIMUM_NOT_MET: 'The swap in step {0} would deliver less than its signed minimum now. Review again for a fresh quote.',
  USER_FUNDED_SIMULATION_UNAVAILABLE: 'This network’s RPC cannot simulate the whole batch, so FloFi does not offer it in one confirmation. Each step is confirmed on its own instead.',
  USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE: 'Your wallet does not hold enough ETH on this network for the network fee of the batch.',
  AAVE_BENEFICIARY_NOT_OWNER: 'An Aave step names another account than the connected wallet. Rebuild that step with this wallet.',
  WORKFLOW_SLIPPAGE_UNSUPPORTED: 'A swap allows more than 3% slippage, which cannot be fixed in one batch. Lower the slippage.',
  ACCOUNT_SESSION_REQUIRED: 'Sign in to FloFi to run the whole workflow with one wallet confirmation. You can still confirm each step on its own.',
  EVM_WALLET_REQUIRED: 'Connect your wallet to review the whole workflow.',
  REVIEW_EXPIRED: 'The reviewed prices expired. Review the workflow again to refresh them.',
  WALLET_REQUEST_REJECTED: 'You declined the request in your wallet. Nothing was sent. You can authorize again or end the workflow.',
  EDITOR_RUNS_NOT_ENABLED: 'Running a whole workflow is not enabled on this FloFi deployment.',
  HANDOFF_RATE_LIMITED: 'Too many workflow runs were started recently. Try again later.',
  HANDOFF_PENDING_LIMIT: 'Too many workflow runs are waiting for you. Finish or end one of them first.',
  EIP5792_UNSUPPORTED_CHAIN: 'Your wallet cannot batch on this network.',
};
const fmtTime = (iso: string, language: string) => new Date(iso).toLocaleTimeString(language === 'PT' ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
/** Native fee in wei as ETH with at most 6 decimals (a non-zero fee never reads 0). */
const eth = (wei: string) => { const v = BigInt(wei), step = 10n ** 12n, shown = (v + step - 1n) / step * step; if (v > 0n && shown === 0n) return '< 0.000001 ETH';
  const whole = shown / 10n ** 18n, frac = (shown % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, ''); return `${whole}${frac ? '.' + frac : ''} ETH`; };
const healthFactor = (wad: string) => { const v = BigInt(wad); return v >= 10n ** 30n ? '∞' : (Number(v / 10n ** 14n) / 10_000).toFixed(2); };
const amountText = (a: ReviewAmount | null | undefined) => a?.text ?? null;

export function EditorWorkflowRunPanel({ state }: { state: EditorWorkflowRunState }) {
  const { t: tr, language } = useLocale();
  const { review, run, phase, error } = state;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  if (!state.available) return null;
  const expired = Boolean(review?.validUntil && Date.parse(review.validUntil) <= now);
  const busy = ['reviewing', 'authorizing', 'proving', 'wallet', 'confirming'].includes(phase);
  const refusal = review?.refusal ? tr(EXECUTION_REFUSAL[review.refusal.code] ?? 'FloFi cannot prepare this workflow now ({0}). Nothing was sent.', review.refusal.code === 'SIMULATION_REVERTED' || review.refusal.code === 'SWAP_MINIMUM_NOT_MET' ? String((review.refusal.step ?? 0) + 1) : review.refusal.code) : null;
  const errorText = error ? tr(EXECUTION_REFUSAL[error] ?? 'FloFi could not complete this request ({0}). Nothing was sent.', error) : null;
  const runStep = (index: number) => run?.steps.find(s => s.index === index) ?? null;
  const plannedOf = (index: number) => run?.groups.flatMap(g => g.planned?.steps ?? []).find(s => s.index === index) ?? null;
  const currentGroup = run?.groups.find(g => g.steps[0] <= run.currentStep && run.currentStep <= g.steps[1]) ?? null;
  const due = run && run.nextAction === 'OWNER_SIGNS_GROUP' && currentGroup && !['wallet', 'confirming'].includes(phase);
  const counts = review?.counts;
  return <section className="editor-workflow-run panel" aria-label={tr('Whole workflow')} data-run-phase={phase} data-run-state={run?.state ?? undefined}>
    <h3>{tr(run ? 'Workflow progress' : 'Review the whole workflow')}</h3>
    {!review && !run && <p>{tr('FloFi checks every step together — amounts, minimums, fees and Aave risk — and asks your wallet only once where it can batch. Nothing is signed or sent by a review.')}</p>}
    {review && <>
      <p className="editor-run-mechanism" data-mode={review.mode}>{tr(review.mode === 'ONE_WALLET_CONFIRMATION'
        ? 'All {0} steps run as ONE wallet confirmation on {1}: one atomic transaction from your own wallet, which pays the network fee.'
        : review.mode === 'GROUPED' ? 'All {0} steps run in {2} wallet confirmations, one per group; a later group is asked when it becomes due.'
        : 'This workflow needs a confirmation in your wallet for each step on its own.', String(review.stepCount), review.groups[0]?.network ?? '', String(review.counts.walletPrompts))}</p>
      {review.mode === 'STEP_BY_STEP' && review.reasons.length > 0 && <ul className="editor-run-reasons">{review.reasons.map(code => <li key={code}>{tr(EXECUTION_REASON[code.split(':')[0]!] ?? 'Not available for this step ({0}).', code)}</li>)}</ul>}
      <ol className="editor-run-steps" aria-label={tr('Steps')}>
        {review.steps.map(step => {
          const live = runStep(step.index), planned = plannedOf(step.index);
          const spend = amountText(planned?.spend) ?? amountText(step.spend), expected = amountText(planned?.expected) ?? amountText(step.expected), minimum = amountText(planned?.minimum) ?? amountText(step.minimum);
          return <li key={step.index} data-step-state={live?.state ?? 'PLANNED'}>
            <strong>{tr('Step {0}', String(step.index + 1))} · {tr(ACTION[step.action] ?? step.action)}</strong>
            <span className="muted"> · {tr(step.network)}{step.provider ? ` · ${step.provider}` : ''}</span>
            <dl className="editor-run-amounts">
              {spend && <div><dt>{tr(step.basis === 'GUARANTEED_MINIMUM' ? 'Spends (the minimum step {0} guarantees)' : step.basis === 'RECONCILED_ACTUAL' ? 'Spends (what step {0} delivers, at most)' : 'Spends', String((step.boundTo ?? 0) + 1))}</dt><dd>{spend}</dd></div>}
              {expected && <div><dt>{tr(step.action === 'borrow' ? 'You receive' : 'Expected')}</dt><dd>{expected}</dd></div>}
              {minimum && <div><dt>{tr('Minimum (your slippage limit)')}</dt><dd>{minimum}</dd></div>}
              {!expected && step.action === 'swap' && <div><dt>{tr('Expected')}</dt><dd>{tr('Quoted when this step becomes due')}</dd></div>}
              {live?.outcome?.received.map(r => <div key={r.asset}><dt>{tr('Received (reconciled)')}</dt><dd>{receivedText(r, [planned?.expected, step.expected, planned?.spend, step.spend])}</dd></div>)}
            </dl>
            {live && <span className="workflow-run-state">{tr(STEP_STATE[live.state] ?? live.state)}</span>}
            {live?.outcome?.submissions.map(tx => tx.explorerUrl ? <a key={tx.hash} href={tx.explorerUrl} target="_blank" rel="noreferrer"><code>{tx.hash.slice(0, 10)}…</code></a> : <code key={tx.hash}>{tx.hash.slice(0, 10)}…</code>)}
          </li>;
        })}
      </ol>
      <dl className="editor-run-facts">
        {review.groups.map(g => <div key={g.index}><dt>{review.groups.length > 1 ? tr('Group {0} · {1}', String(g.index + 1), g.network) : g.network}</dt>
          <dd>{tr(HOW[g.strategy] ?? g.strategy)}{g.calls ? ` · ${tr('{0} calls in the batch ({1} token approvals)', String(g.calls.length), String(g.approvals ?? 0))}` : ''}
            {g.fee ? ` · ${tr('about {0} in network fees, at most {1}', eth(g.fee.estimatedWei), eth(g.fee.maxWei))}` : ''}
            {run?.groups[g.index] ? ` · ${tr(GROUP_STATE[run.groups[g.index]!.state] ?? run.groups[g.index]!.state)}` : ''}
            {run?.groups[g.index]?.gasPaid ? ` · ${tr('network fees paid: {0}', eth(run.groups[g.index]!.gasPaid!.amount))}` : ''}</dd></div>)}
        {review.groups.some(g => g.healthFactorAfter) && <div><dt>{tr('Aave health factor after the batch')}</dt>
          <dd>{tr('{0} (FloFi requires at least 2.00)', healthFactor((run?.groups.find(g => g.planned?.healthFactorAfter)?.planned?.healthFactorAfter) ?? review.groups.find(g => g.healthFactorAfter)!.healthFactorAfter!))}</dd></div>}
        {counts && <div><dt>{tr('What your wallet is asked')}</dt><dd>{tr(counts.atLeast ? 'at least {0} wallet confirmations' : counts.walletPrompts === 1 ? 'one wallet confirmation' : '{0} wallet confirmations', String(counts.walletPrompts))}
          {' · '}{tr('{0} on-chain transactions', String(counts.transactions))}{counts.batchedCalls ? ` · ${tr('{0} calls batched', String(counts.batchedCalls))}` : ''}
          {' · '}{tr('{0} signatures', String(counts.signatures))}{counts.networkSwitches ? ` · ${tr('{0} network switches', String(counts.networkSwitches))}` : ''}
          {counts.oneTimeSetup.includes('EVM_SMART_ACCOUNT_UPGRADE') ? ` · ${tr('your wallet may upgrade this account to its smart account inside the same confirmation (one time)')}` : ''}</dd></div>}
        {review.validUntil && !run && <div><dt>{tr('Prices')}</dt><dd>{expired ? tr('Expired at {0}: review again to refresh them before authorizing.', fmtTime(review.validUntil, language))
          : tr('Quoted at {0}, valid until {1}', fmtTime(review.reviewedAt, language), fmtTime(review.validUntil, language))}</dd></div>}
      </dl>
      <p className="muted">{tr('Your wallet pays every network fee. FloFi never pays, advances or reimburses gas, and never signs or sends for you.')}</p>
    </>}
    {refusal && <p className="error-banner" role="alert">{refusal}</p>}
    {state.updated.length > 0 && <div className="editor-run-update" role="alert"><p>{tr('Prices moved since your review. Your wallet would be asked with these minimums:')}</p>
      <ul>{state.updated.map(u => <li key={u.index}>{tr('Step {0}: {1} (reviewed {2})', String(u.index + 1), u.now, u.reviewed)}</li>)}</ul></div>}
    {errorText && <p className="error-banner" role="alert">{errorText}</p>}
    {run?.state === 'ATTENTION' && <p role="status">{tr('A submitted step has no final outcome yet. FloFi keeps observing it and never resubmits it.')}</p>}
    {run?.state === 'HALTED' && <p role="status">{tr('Partially completed: the reconciled steps stay done and their funds rest in your wallet. Nothing later was submitted.')}</p>}
    {run?.state === 'COMPLETED' && <p role="status"><strong>{tr('Every step reconciled.')}</strong></p>}
    {phase === 'wallet' && <p role="status">{tr('Confirm the request in your wallet. It shows every call of the batch and the network fee.')}</p>}
    {phase === 'confirming' && <p role="status">{tr('Waiting for your wallet to report the batch…')}</p>}
    {phase === 'proving' && <p role="status">{tr('Sign the FloFi sign-in message in your wallet (once per session). It authorizes no transaction.')}</p>}
    <div className="approval-actions">
      {!run && <button type="button" className={review ? 'secondary' : 'primary'} disabled={busy} aria-busy={phase === 'reviewing' || undefined} onClick={() => void state.startReview()}>
        {tr(phase === 'reviewing' ? 'Reviewing the whole workflow…' : review ? 'Review again' : 'Review whole workflow')}</button>}
      {review && !run && state.grouped && <button type="button" className="primary editor-run-authorize" disabled={busy || expired} aria-busy={busy || undefined} onClick={() => void state.authorize()}>
        {tr(phase === 'authorizing' ? 'Preparing your wallet request…' : review.counts.walletPrompts === 1 && !review.counts.atLeast ? 'Authorize workflow · 1 wallet confirmation' : 'Authorize workflow')}</button>}
      {phase === 'confirm-update' && <button type="button" className="primary" onClick={() => void state.confirmUpdate()}>{tr('Confirm the updated minimums')}</button>}
      {due && <button type="button" className="primary" onClick={() => void state.authorizeDue()}>{tr('Authorize steps {0}–{1} now', String(currentGroup!.steps[0] + 1), String(currentGroup!.steps[1] + 1))}</button>}
      {run?.nextAction === 'OWNER_CONFIRMS_BATCH' && !['wallet', 'confirming'].includes(phase) && <button type="button" className="secondary" onClick={() => void state.checkWallet()}>{tr('Check my wallet for the batch')}</button>}
      {run && OPEN_RUN.includes(run.state) && !run.groups.some(g => g.signed && !['RECONCILED', 'FAILED', 'SKIPPED'].includes(g.state)) && !['wallet', 'confirming'].includes(phase) &&
        <button type="button" className="quiet" onClick={() => void state.end()}>{tr('End workflow')}</button>}
      {run && !OPEN_RUN.includes(run.state) && <button type="button" className="quiet" onClick={state.dismiss}>{tr('Close')}</button>}
    </div>
  </section>;
}

/** A reconciled amount in the step's own units when its asset is one the step names; otherwise its raw units (never guessed). */
function receivedText(fact: { readonly asset: string; readonly amount: string }, refs: readonly (ReviewAmount | null | undefined)[]): string {
  const ref = refs.find(r => r && r.asset.toLowerCase() === fact.asset.toLowerCase()) ?? null;
  if (!ref) return `${fact.amount} (${fact.asset.split(':').at(-1)?.slice(0, 10)}…)`;
  const d = ref.decimals, padded = fact.amount.padStart(d + 1, '0'), frac = padded.slice(-d).replace(/0+$/, '');
  return `${d ? padded.slice(0, -d) + (frac ? '.' + frac : '') : fact.amount} ${ref.symbol}`;
}
