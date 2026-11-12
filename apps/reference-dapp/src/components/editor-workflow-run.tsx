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
import { authorizeUserFundedGroup, cancelWorkflowRunHandoff, prepareUserFundedGroup, reportUserFundedBatch, resumeWorkflowRunHandoff, workflowRunStatusHandoff } from '../app/approve-action';
import type { EditorExecutionReview, ReviewAmount } from '../editor/workflow-execution';
import type { ClaimedProposal } from '../platform/approvals';
import type { RunView } from '../workflow-runs/service';
import { walletRequestView } from '../domain/approved-ux';
import { BlockerPanel } from './review-summary-panel';
import { WALLET_BATCH_OUTCOME_UNKNOWN, canEndWorkflow, haltedAs } from '../workflow-runs/state-machine';
import { useLocale } from '../i18n/locale';
import { batchHandout, keepBatchHandout, sendWalletBatch, signSolanaGroup, signUserOperation, walletBatchHashes, walletProfile } from './user-funded-browser';
import { useWalletProof } from './wallet-proof';
import { FLIGHT_REFUSAL_MESSAGES } from '../domain/flight-refusal';
import { EXECUTION_PHASE_LABEL } from '../domain/execution-phase';
import { awaitedDelivery, runProgress, runStepPhase } from '../workflow-runs/run-step-phase';

/**
 * The whole-workflow runs this browser started and has not closed, by approval id. A page load gives the Canvas a new workflow id, so a run is
 * never found by that id alone: a run of THIS visit's workflow is followed at once, and a run from an earlier visit is offered ("Show its
 * progress") so a batch in the wallet is read back and reported after a reload. Kept until the owner closes or ends the run.
 * `sent`: the batch id the wallet answered `wallet_sendCalls` with, kept the moment it answers — the wallet holds that batch from then on, so
 * FloFi reads it back and never asks the wallet to send that group again (even a wallet that ignores the app-provided EIP-5792 id).
 */
const STORAGE_KEY = 'flofi.editor-workflow-runs.v2';
type Stored = { readonly workflowId: string; readonly approvalId: string; readonly workflowHash: string; readonly owner: string; readonly revision: number;
  readonly at: string;
  /** `attempt`: wallet_sendCalls was called and has not answered (yet) — the wallet may hold the batch under the group's own id. `nonce`:
   *  which send wrote it, so a send clears only its own attempt, never one another tab of this browser wrote for the same group. */
  readonly sent?: { readonly group: number; readonly batchId: string; readonly attempt?: boolean; readonly nonce?: string } };
const STORED_LIMIT = 16;
const readAll = (): Stored[] => {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is Stored => Boolean(x) && typeof (x as Stored).approvalId === 'string' && typeof (x as Stored).workflowId === 'string'
      && typeof (x as Stored).owner === 'string') : [];
  } catch { return []; }
};
const writeAll = (all: readonly Stored[]) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all.slice(0, STORED_LIMIT))); } catch { /* tab only */ } };
const storedRun = (approvalId: string): Stored | null => readAll().find(s => s.approvalId === approvalId) ?? null;
const putStored = (value: Stored) => writeAll([value, ...readAll().filter(s => s.approvalId !== value.approvalId)]);
const dropStored = (approvalId: string | null) => { if (approvalId) writeAll(readAll().filter(s => s.approvalId !== approvalId)); };
/**
 * /approve's record of the batches IT handed to the owner's wallet (`workflow-run-panel.tsx`, `BATCH_ATTEMPTS_KEY`; same origin, so the same
 * storage): `${approvalId}:${group}` → { at, batchId?, nonce? }. The Editor links to /approve for the same run, and a wallet that ignores the
 * app-provided EIP-5792 id cannot tell either page that it already holds a batch: before this page hands a group to the wallet it treats an
 * attempt there exactly like its own — the batch id the wallet answered with is read back, an unanswered request is never sent again. Read only
 * (/approve clears its own). `batchId` null: the wallet never answered there.
 */
const APPROVE_ATTEMPTS_KEY = 'flofi.approve-batch-attempts.v1';
const approveAttempt = (approvalId: string, group: number): { readonly batchId: string | null } | null => {
  try {
    const all = JSON.parse(localStorage.getItem(APPROVE_ATTEMPTS_KEY) ?? '{}') as unknown;
    const found = all && typeof all === 'object' ? (all as Record<string, unknown>)[`${approvalId}:${group}`] : undefined;
    if (found === undefined || found === null) return null;
    // Anything but a usable batch id reads as a request the wallet never answered (fail closed: never sent again from here).
    const batchId = (found as { batchId?: unknown }).batchId;
    return { batchId: typeof batchId === 'string' && batchId ? batchId : null };
  } catch { return null; }
};
/** A batch handed to the wallet for this group (by this page or /approve) that the run has not recorded: read back, never sent again. */
const handedOver = (approvalId: string, group: number) => storedRun(approvalId)?.sent?.group === group || approveAttempt(approvalId, group) !== null;
/** Status refusals after which the stored run no longer exists for this browser; any other refusal keeps the pointer (e.g. a sign-in expired). */
const FORGOTTEN = /_NOT_FOUND$/;
/** A Review that failed for a moment (rate limit, RPC): reviewing again is the way forward, not the step-by-step path. */
const TRANSIENT_REVIEW_FAILURE: ReadonlySet<string> = new Set(['EDITOR_REVIEW_RATE_LIMITED', 'USER_FUNDED_RPC_UNAVAILABLE', 'HANDOFF_RATE_LIMITED',
  'EVM_WALLET_REQUIRED', 'EDITOR_EXECUTION_FAILED']);
/**
 * Review refusals no retry changes that each step's own owner-signed flow handles itself (it re-checks, simulates and reviews its step): the
 * workflow is offered step by step instead of a batch that can never be prepared (the same codes a due group resumes step by step for).
 */
const STEP_BY_STEP_REFUSALS: ReadonlySet<string> = new Set(['USER_FUNDED_SIMULATION_UNAVAILABLE', 'SIMULATION_SWAP_OUTPUT_SHORT', 'USER_FUNDED_DEADLINE_UNAVAILABLE',
  'TOKEN_METADATA_MISMATCH', 'CONTRACT_CODE_MISSING']);
/** Whether a whole-workflow Review sends the owner to the step-by-step path: it planned one, or refused the batch for good. */
export const reviewOffersStepByStep = (review: Pick<EditorExecutionReview, 'mode' | 'refusal'>) =>
  review.mode === 'STEP_BY_STEP' || (review.refusal !== null && STEP_BY_STEP_REFUSALS.has(review.refusal.code));
/**
 * Wallet answers that prove nothing was sent: the request was declined, or never made (no wallet, the network switch or account check failed,
 * or this browser could not keep its "handed to the wallet" record, WALLET_ATTEMPT_UNRECORDABLE).
 */
const NOTHING_SENT: ReadonlySet<string> = new Set(['WALLET_REQUEST_REJECTED', 'WALLET_WRONG_NETWORK', 'EVM_WALLET_NOT_FOUND', 'WALLET_BATCH_NOT_SENT',
  'WALLET_ACCOUNT_MISMATCH', 'WALLET_ATTEMPT_UNRECORDABLE']);
/**
 * The run already recorded ANOTHER batch id (or other transactions) for the group than the one this browser reports: the group may have
 * executed twice. The server refuses and logs it; it is shown as such, never as "not recorded yet" and never as "nothing was sent".
 */
const ANSWER_MISMATCH = 'WALLET_BATCH_ANSWER_MISMATCH';
/**
 * The owner's wallet answered (or reported) a batch for a group FloFi had already stopped while that batch was unanswered (WALLET_BATCH_OUTCOME_UNKNOWN):
 * the run cannot record it any more (the group is closed) and the server logged it. The batch may have executed: shown as such, never as "not
 * recorded yet", "nothing was sent" or dropped silently.
 */
const ANSWERED_AFTER_STOP = 'WALLET_BATCH_ANSWERED_AFTER_STOP';
/** Refusals of a recorded answer or a report that say something about the batch itself: shown as they are, never replaced. */
const ANSWER_REFUSALS: readonly string[] = [ANSWER_MISMATCH, ANSWERED_AFTER_STOP];
/**
 * The server prepared no second batch while the one it handed out can still execute (`PREPARED_MIN_REMAINING_MS`). The panel words it from the
 * refused group's own state (`refusalSettled`, `refusedGroup`).
 */
const PREPARED_STILL_VALID_CODE = 'USER_FUNDED_PREPARED_STILL_VALID';
/**
 * How long a NEW wallet batch preparation stays executable: mirrors `EVM_PREPARED_TTL_MS` (user-funded/groups.ts, server code this page does not
 * import). The server prepares a new one only while the run's window outlasts it (workflow-runs/service.ts, `preparedHorizonMs`), so this page
 * offers to ask for a fresh request only then.
 */
export const BATCH_PREPARATION_VALIDITY_MS = 10 * 60_000;
/** Step and group states whose own words already say what the wallet answered or the chain decided. */
const ANSWERED_STATES: readonly string[] = ['AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'RECONCILED', 'FAILED'];
/**
 * A USER_FUNDED_PREPARED_STILL_VALID refusal is over for its group once the wallet answered it (an answered state, or signed) — the group's own
 * state says what happened — or once FloFi stopped it while its batch was unanswered (WALLET_BATCH_OUTCOME_UNKNOWN): the run's "may have
 * executed" note says what may have happened. Never "stays valid … try again" for either.
 */
const refusalSettled = (g: { readonly state: string; readonly signed: boolean; readonly code: string | null }) =>
  g.signed || ANSWERED_STATES.includes(g.state) || g.code === WALLET_BATCH_OUTCOME_UNKNOWN;
/** Whether the wallet knows a batch id (`wallet_getCallsStatus` answers; EIP-5792 5730 or no answer: it does not) and its status if final. */
const probe = (batchId: string) => walletBatchHashes(batchId).then(result => ({ known: true as const, result }), () => ({ known: false as const, result: null }));
const CODE = /^[A-Z][A-Z0-9_:]{2,100}$/;
const codeOf = (cause: unknown) => cause instanceof Error && CODE.test(cause.message) ? cause.message
  : (cause as { code?: unknown } | null)?.code === 4001 ? 'WALLET_REQUEST_REJECTED' : 'EDITOR_EXECUTION_FAILED';
const OPEN_RUN = ['PENDING', 'RUNNING', 'ATTENTION', 'HALTED'];
const EVM_MAINNETS: readonly string[] = ['eip155:1', 'eip155:8453', 'eip155:42161', 'eip155:4663'];

export type EditorRunPhase = 'idle' | 'reviewing' | 'reviewed' | 'authorizing' | 'proving' | 'confirm-update' | 'wallet' | 'confirming' | 'running' | 'done';
export type EditorWorkflowRunState = {
  readonly available: boolean; readonly phase: EditorRunPhase; readonly review: EditorExecutionReview | null; readonly error: string | null;
  readonly run: RunView | null;
  /** What the wallet would be asked that the owner has not accepted in this tab: a minimum below the accepted one, or (no Review in memory,
   *  e.g. after a reload, or a step quoted only when due) a minimum or recipient never shown. Confirmed before the wallet is asked. */
  readonly updated: readonly { readonly index: number; readonly kind: 'minimum' | 'recipient'; readonly reviewed: string | null; readonly now: string }[];
  /** A run of this workflow exists (started here or found after a reload): the per-step path must not start this workflow again. */
  readonly started: boolean;
  /** The whole workflow runs here as wallet-grouped authorization (the review says so); otherwise the Editor keeps its step-by-step path. */
  readonly grouped: boolean;
  /** A batch this browser handed to the wallet that the run has not recorded yet: it is read back, never sent again, and the run is not ended. */
  readonly unrecorded: boolean;
  /**
   * The group a USER_FUNDED_PREPARED_STILL_VALID refusal on screen is about (the one this tab asked to prepare): the refusal is dated and retired
   * from that group's own state, also once it left PREPARED. Absent: the panel dates it from the run view's prepared wallet batches.
   */
  readonly refusedGroup?: number | null;
  /** The panel has something to show: this workflow's Review or run, or a run from an earlier visit (after a reload) to offer. */
  readonly visible: boolean;
  /** A run this browser started in an earlier visit (e.g. before a reload) that it has not closed: offered, never followed silently. */
  readonly earlier: boolean;
  followEarlier(): Promise<void>;
  /**
   * The Editor's step-by-step path is the honest way to run this workflow: the Review says it cannot be grouped, this network's RPC cannot
   * simulate the batch, or the whole-workflow path cannot run here at all. NOT for a safety refusal (an unsafe health factor, a swap below its
   * minimum, a failing call, too little gas money): the workflow must change first, or it would run half way step by step.
   */
  readonly stepByStep: boolean;
  /** This tab follows a run it cannot load (another wallet, an expired sign-in): the owner may forget it in this browser, explicitly. */
  readonly unloaded: boolean;
  /** This workflow can be reviewed and authorized here (the path is on and the Editor shows a multi-step workflow not started step by step). */
  readonly canReview: boolean;
  /** The run shown is one from an earlier visit (not this Canvas workflow's): it never takes over this workflow's primary action. */
  readonly following: boolean;
  /** Stops showing a followed earlier run (it stays stored and is offered again). */
  hide(): void;
  /** A HALTED run stopped at a group nothing was signed for: it continues (as a batch again, or through each step's own flow). */
  resume(): Promise<void>;
  startReview(): Promise<void>; authorize(): Promise<void>; confirmUpdate(): Promise<void>; authorizeDue(): Promise<void>; checkWallet(interactive?: boolean): Promise<void>; end(): Promise<void>;
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
  // A HALTED run no longer asks the updated minimums (Resume or End takes over): their notice goes with the question.
  useEffect(() => { if (run?.state === 'HALTED' && phase !== 'confirm-update' && updated.length) setUpdated([]); }, [run?.state, phase, updated.length]);
  const pendingSend = useRef<{ approvalId: string; index: number } | null>(null);
  /** `refusedGroup`, also as a ref: a status update retires the refusal once that group was answered or stopped (`refusalSettled`). */
  const [refusedGroup, setRefusedGroup] = useState<number | null>(null);
  const stillValidGroup = useRef<number | null>(null);
  const refusedFor = (index: number | null) => { stillValidGroup.current = index; setRefusedGroup(index); };
  /** The minimum the owner accepted for each step (the reviewed one, or an update they confirmed): the wallet is never asked for less. */
  const accepted = useRef<Map<number, ReviewAmount>>(new Map());
  const offered = useRef<Map<number, ReviewAmount>>(new Map());
  /** The recipient the owner accepted for each transfer step (the reviewed one, or one confirmed after a reload). */
  const acceptedRecipients = useRef<Map<number, string>>(new Map());
  const offeredRecipients = useRef<Map<number, string>>(new Map());
  const runRef = useRef<RunView | null>(null);
  const reviewRef = useRef<EditorExecutionReview | null>(null);
  /** The exact Canvas workflow the Review describes: Authorize starts THIS one (the server refuses any other hash). */
  const reviewedWorkflow = useRef<unknown>(null);
  const [unrecorded, setUnrecorded] = useState(false);
  /**
   * This tab's copy of the shown run's stored record (written at Authorize, or found for this workflow or an earlier visit): the "handed to the
   * wallet" marker is written into it when the browser's own record is gone (e.g. evicted by newer runs), so no send ever goes without one.
   */
  const record = useRef<Stored | null>(null);
  const acting = useRef(false);
  /** Mirrors `acting` as state so a workflow switch deferred during an action is applied once the action ends. */
  const [actingNow, setActingNow] = useState(false);
  const proof = useWalletProof('eip155');
  const workflowSnapshot = useRef<unknown>(workflow);
  workflowSnapshot.current = workflow;
  // The EVM chains this workflow uses: the only ones the wallet is asked about. A workflow without any EVM step (Solana only) is not reviewed
  // here — this path needs the owner's EVM wallet — and keeps the Editor's per-step path instead of a dead end.
  const evmChains = [...new Set(((workflow as { nodes?: readonly { chainId?: string }[] }).nodes ?? []).map(n => n.chainId ?? '').filter(c => c.startsWith('eip155:')))];
  const evmWorkflow = evmChains.length > 0;
  // Re-read when the wallet changes (a FloFi sign-in usually comes with it): without an account session the step-by-step path stays primary.
  useEffect(() => { void editorWorkflowExecutionAvailability().then(r => setAvailable(r.enabled)).catch(() => setAvailable(false)); }, [evmAccount]);
  // A Review describes one workflow revision and one wallet: any edit or wallet change makes it stale (nothing was started).
  const reviewKey = `${workflow.workflowId}:${workflow.revision}:${evmAccount ?? ''}`;
  const reviewedFor = useRef<string | null>(null);
  const currentKey = useRef(reviewKey);
  currentKey.current = reviewKey;
  useEffect(() => {
    if (reviewedFor.current !== null && reviewedFor.current !== reviewKey && !approvalId) { setReview(null); setPhase('idle'); setError(null); setUpdated([]); reviewedFor.current = null; }
    if (failedFor.current !== null && failedFor.current !== reviewKey && !approvalId) { setError(null); failedFor.current = null; }
  }, [reviewKey, approvalId]);

  const adopt = useCallback((proposal: ClaimedProposal) => {
    const r = proposal.view.workflowRun?.run ?? null;
    if (!r) return;
    setRun(r); runRef.current = r;
    // A finished run stays shown (after a reload too) until the owner closes it: the same workflow is never offered again by accident.
    if (!OPEN_RUN.includes(r.state)) { setPhase('done'); setUnrecorded(false); }
    // A status poll never hides what the owner is being asked (the wallet prompt, or an updated minimum to confirm).
    // An updated minimum is no longer asked once the run HALTED (it would only be refused): the run's own controls take over.
    else if (r.state !== 'PENDING') setPhase(current => current === 'confirm-update' && r.state === 'HALTED' ? 'running'
      : ['wallet', 'confirming', 'confirm-update', 'authorizing', 'proving'].includes(current) ? current : 'running');
    // A batch handed to the wallet (from here or /approve) for a group the run still shows prepared: not recorded yet.
    setUnrecorded(r.groups.some(g => g.state === 'PREPARED' && g.strategy === 'EVM_WALLET_BATCH' && handedOver(r.approvalId, g.index)));
    // A USER_FUNDED_PREPARED_STILL_VALID refusal whose group the wallet answered since (or FloFi stopped with its batch unanswered) is over: it
    // stops being shown, and no longer holds back reading an answered batch back from the wallet (the recovery waits while an error is shown).
    const refused = stillValidGroup.current === null ? undefined : r.groups.find(g => g.index === stillValidGroup.current);
    if (refused && refusalSettled(refused)) { refusedFor(null); setError(e => e === PREPARED_STILL_VALID_CODE ? null : e); }
  }, []);
  // A run of this workflow started earlier (this tab, a reload or another tab): its progress continues here, read from the server.
  const [earlier, setEarlier] = useState<Stored | null>(null);
  const [following, setFollowing] = useState(false);
  /** The key of a Review that failed: a Canvas edit or a wallet change clears its error (the cause may be fixed). */
  const failedFor = useRef<string | null>(null);
  const authorizedRevision = useRef<number | null>(null);
  /** Clears what this tab shows (the stored runs are kept). */
  const resetView = () => {
    setApprovalId(null); setRun(null); runRef.current = null; setReview(null); reviewRef.current = null; reviewedWorkflow.current = null; setPhase('idle');
    setError(null); setUpdated([]); recovered.current = null; setUnrecorded(false); authorizedRevision.current = null; setFollowing(false); setEarlier(null);
    accepted.current = new Map(); acceptedRecipients.current = new Map(); failedFor.current = null; record.current = null; refusedFor(null);
  };
  // ONE effect resolves what this tab shows for the Canvas workflow, so a workflow switch and the lookup of its run can never race:
  //   another workflow opened in place (e.g. from the library): the previous one's Review and run stop being shown (both stay stored) — once
  //   the action in flight, if any, has ended; then
  //   a run of THIS workflow started earlier (this tab, a reload of a saved workflow, another tab) is followed, read from the server; or
  //   a run from an earlier visit (after a reload the Canvas has a new workflow id) is offered for the connected wallet.
  const shownWorkflow = useRef(workflow.workflowId);
  useEffect(() => {
    if (shownWorkflow.current !== workflow.workflowId) {
      if (actingNow) return; // applied when the action ends (`actingNow` is a dependency)
      shownWorkflow.current = workflow.workflowId;
      resetView();
      if (approvalId) return; // `approvalId` becomes null: the lookup runs on the next pass
    }
    if (approvalId) { setEarlier(null); return; }
    const all = readAll(), mine = all.find(s => s.workflowId === workflow.workflowId) ?? null;
    if (!mine || !enabled) {
      setEarlier(all.find(s => s.workflowId !== workflow.workflowId && (!evmAccount || s.owner === evmAccount.toLowerCase())) ?? null);
      return;
    }
    setEarlier(null); setApprovalId(mine.approvalId); authorizedRevision.current = mine.revision; record.current = mine;
    // A refusal never forgets the run: the server answers "not found" also when this browser's wallet sign-in expired or another wallet is
    // signed in, so the pointer stays (and the same workflow is never authorized a second time) until the run loads or the owner forgets it.
    // A status answer for a workflow or run no longer shown is dropped.
    let current = true;
    void workflowRunStatusHandoff(mine.approvalId).then(result => {
      if (!current) return;
      if (result.ok) adopt(result.value);
      else setError(FORGOTTEN.test(result.code) || result.code === 'EVM_WALLET_PROOF_REQUIRED' ? 'EDITOR_RUN_SIGN_IN_REQUIRED' : result.code);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [enabled, workflow.workflowId, approvalId, evmAccount, adopt, actingNow]);
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
    if (acting.current) return; acting.current = true; setActingNow(true); setError(null); refusedFor(null);
    try { await work(); } catch (cause) { setError(codeOf(cause)); setPhase(p => p === 'wallet' || p === 'confirming' ? 'running' : p === 'reviewing' ? 'idle' : p === 'authorizing' || p === 'proving' ? runRef.current ? 'running' : 'reviewed' : p); }
    finally { acting.current = false; setActingNow(false); }
  }
  const profileFor = async (chains: readonly string[]) => walletProfile(evmAccount, chains, false);

  const runReview = () => guard(async () => {
    // Never while a run is shown (this workflow's or a followed earlier one): the Review would be read against another run's facts.
    if (approvalId) return;
    if (!evmAccount) { failedFor.current = currentKey.current; throw new Error('EVM_WALLET_REQUIRED'); }
    setPhase('reviewing'); setUpdated([]);
    // The wallet is asked what it can do on FloFi's EVM mainnets (`wallet_getCapabilities` shows no prompt); the server keeps only this workflow's.
    const key = currentKey.current, reviewing = workflowSnapshot.current;
    failedFor.current = null;
    const result = await reviewEditorWorkflow(reviewing, evmAccount, await profileFor(evmChains.length ? evmChains : EVM_MAINNETS));
    // A Review of a revision (or wallet) that changed while it was made describes nothing current: it is dropped, never authorized.
    if (currentKey.current !== key) { setPhase('idle'); return; }
    if (!result.ok) { failedFor.current = key; throw new Error(result.code); }
    reviewedFor.current = key; reviewRef.current = result.value; reviewedWorkflow.current = reviewing; setReview(result.value); setPhase('reviewed');
  });
  /** Hands a prepared group to the owner's wallet and relays the answer; a batch is then followed until the wallet reports its transactions. */
  async function sendPrepared(id: string, index: number, p: Record<string, unknown>, feePayer: string) {
    setPhase('wallet');
    if (p.kind === 'EVM_WALLET_BATCH') {
      const request = p.request as eip5792.SendCallsRequest;
      // A batch the wallet already has (a reload, a lost answer) is read back by its id, never sent again.
      let batchId = await heldBatch(id, index, request.id ?? null);
      if (!batchId) {
        // Kept the moment the wallet is asked to send (`onSending`, immediately before `wallet_sendCalls`): if its answer is lost (a timeout, a
        // reload, an unreadable answer) the wallet may hold the batch, so FloFi reads it back and never sends this group again. Never earlier:
        // a failed network switch or account check sent nothing and must not block the group for good. Only an answer that proves nothing was
        // sent clears it, and only the attempt this send wrote.
        const nonce = crypto.randomUUID();
        const handOver = () => {
          const before = storedRun(id);
          // Re-read the moment the wallet would be asked: `heldBatch` found no record for this group, so one now was written by another tab
          // (it handed the group to the wallet meanwhile). This tab never sends it too; the batch is read back from the wallet instead.
          if (before?.sent?.group === index) {
            setUnrecorded(true);
            throw new Error(before.sent.attempt ? 'WALLET_BATCH_SEND_UNCONFIRMED' : 'WALLET_BATCH_SENT_UNRECORDED');
          }
          // The same for /approve handing this group to the wallet meanwhile (its own record, same origin).
          const there = approveAttempt(id, index);
          if (there) { setUnrecorded(true); throw new Error(there.batchId ? 'WALLET_BATCH_SENT_UNRECORDED' : 'WALLET_BATCH_SEND_UNCONFIRMED'); }
          // The marker is what stops this group from ever being sent twice after a lost answer, so it is written AND read back before the wallet
          // is asked: a browser that cannot keep it (storage blocked, full or failing) is never asked to send (WALLET_ATTEMPT_UNRECORDABLE,
          // nothing sent). A run whose own record is gone (e.g. evicted by newer runs) gets it back from this tab's copy, never a send without one.
          const base = before ?? (record.current?.approvalId === id ? record.current : null);
          if (base) putStored({ ...base, sent: { group: index, batchId: request.id ?? '', attempt: true, nonce } });
          const back = storedRun(id)?.sent;
          if (back?.nonce !== nonce) {
            // Another tab's record for this group landed in between: the group is in its hands (never sent from here too).
            if (back?.group === index) { setUnrecorded(true); throw new Error(back.attempt ? 'WALLET_BATCH_SEND_UNCONFIRMED' : 'WALLET_BATCH_SENT_UNRECORDED'); }
            throw new Error('WALLET_ATTEMPT_UNRECORDABLE');
          }
          setUnrecorded(true);
        };
        try { batchId = await sendWalletBatch(request, handOver); }
        catch (cause) {
          if (NOTHING_SENT.has(codeOf(cause))) {
            // Only this send's own attempt (none exists when the wallet was never asked to send; another tab's record stays, and so does what
            // it means: the group may still be in the wallet).
            const now = storedRun(id);
            if (now?.sent?.nonce === nonce) { const { sent: _sent, ...rest } = now; void _sent; putStored(rest); }
            setUnrecorded(handedOver(id, index));
          }
          throw cause;
        }
        const stored = storedRun(id);
        if (stored) putStored({ ...stored, sent: { group: index, batchId, nonce } });
      }
      await recordBatch(id, index, batchId);
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
  /**
   * The batch the wallet already holds for this group, if any: the id it answered with (kept by this browser, on this page or /approve), then
   * the group's own EIP-5792 id. A batch this browser handed over that the wallet no longer reports is never sent again (the owner checks the
   * wallet's activity).
   */
  async function heldBatch(id: string, index: number, groupId: string | null): Promise<string | null> {
    const stored = storedRun(id), there = approveAttempt(id, index);
    const mine = stored?.sent?.group === index ? stored.sent.batchId || groupId : null, theirs = there ? there.batchId ?? groupId : null;
    for (const candidate of [...new Set([mine, theirs, groupId].filter((v): v is string => Boolean(v)))]) if ((await probe(candidate)).known) return candidate;
    // The wallet was asked and its answer never arrived: FloFi cannot tell whether it sent the batch, so it never asks again for this group.
    if (mine) throw new Error(stored?.sent?.attempt ? 'WALLET_BATCH_SEND_UNCONFIRMED' : 'WALLET_BATCH_SENT_UNRECORDED');
    if (there) throw new Error(there.batchId ? 'WALLET_BATCH_SENT_UNRECORDED' : 'WALLET_BATCH_SEND_UNCONFIRMED');
    return null;
  }
  /**
   * The wallet holds the batch: the run records it and follows it. A failure here is never "nothing was sent"; a run that already recorded
   * ANOTHER batch for the group says so (WALLET_BATCH_ANSWER_MISMATCH: the group may have executed twice), and a group FloFi already stopped
   * says the batch may have executed and cannot be recorded (WALLET_BATCH_ANSWERED_AFTER_STOP) — never "not recorded yet".
   */
  async function recordBatch(id: string, index: number, batchId: string) {
    const authorized = await authorizeUserFundedGroup(id, index, { kind: 'EVM_WALLET_BATCH', batchId }).catch(() => null);
    if (!authorized?.ok) throw new Error(authorized && ANSWER_REFUSALS.includes(authorized.code) ? authorized.code : 'WALLET_BATCH_SENT_UNRECORDED');
    adopt(authorized.value); setPhase('confirming');
    await followBatch(id, index, batchId);
  }
  /**
   * Relays the wallet's report of a batch; the run refusing it as another batch's transactions, or for a group it already stopped (the batch may
   * have executed), is shown, never dropped silently.
   */
  async function report(id: string, index: number, hashes: readonly string[], notSent = false) {
    const r = await reportUserFundedBatch(id, index, [...hashes], notSent);
    if (r.ok) adopt(r.value);
    else if (ANSWER_REFUSALS.includes(r.code)) throw new Error(r.code);
  }
  async function followBatch(id: string, index: number, batchId: string) {
    for (let i = 0; i < 60; i++) {
      const done = await walletBatchHashes(batchId).catch(() => null);
      if (done?.hashes.length) { await report(id, index, done.hashes); setPhase('running'); return; }
      if (done?.failed) { await report(id, index, [], true); setPhase('running'); return; }
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    // Still pending in the wallet: the run keeps observing; "Check my wallet" reads it back later (never a second batch).
    setPhase('running');
  }
  /**
   * Prepares a group (or takes the one just prepared) and hands it to the wallet — only after its signed minimums were compared with what the
   * owner accepted, on EVERY preparation (a re-preparation after expiry quotes again). The comparison fails closed: without the prepared
   * group's planned values the wallet is not asked. A group whose batch the wallet already holds is read back first, never prepared again.
   */
  async function continueGroup(id: string, index: number, given?: { readonly prepared: unknown; readonly feePayer: string; readonly strategy?: string }) {
    const current = runRef.current?.groups[index];
    if (!given && current?.strategy === 'EVM_WALLET_BATCH' && current.state === 'PREPARED') {
      const held = await heldBatch(id, index, current.batchId);
      if (held) { await recordBatch(id, index, held); return; }
    }
    let prepared = given;
    if (!prepared) {
      const r = await prepareUserFundedGroup(id, index, batchHandout(id, index));
      if (!r.ok) { if (r.code === PREPARED_STILL_VALID_CODE) refusedFor(index); throw new Error(r.code); }
      keepBatchHandout(id, index, r.value.handout);
      prepared = r.value;
    }
    const kind = (prepared.prepared as { kind?: string } | null)?.kind;
    // Only a wallet batch has planned values to compare with what the owner accepted; any other kind is never handed to the wallet from here.
    if (kind !== 'EVM_WALLET_BATCH') throw new Error('EDITOR_EXECUTION_PLAN_UNVERIFIED');
    {
      const fresh = await workflowRunStatusHandoff(id);
      if (!fresh.ok) throw new Error(fresh.code);
      adopt(fresh.value);
      const planned = fresh.value.view.workflowRun?.run.groups[index]?.planned;
      if (!planned) throw new Error('EDITOR_EXECUTION_PLAN_UNVERIFIED');
      // A transfer pays exactly the recipient the owner accepted (the workflow is bound by its hash; this re-checks the prepared call itself).
      // Every minimum the owner accepted is still there, for the same asset. Anything the owner has not accepted in this tab — a lower minimum,
      // or (no Review in memory, e.g. after a reload; a step quoted only when due) a minimum or recipient never shown — is shown and confirmed
      // first: the wallet is never asked for something the owner did not see.
      const changes: { index: number; kind: 'minimum' | 'recipient'; reviewed: string | null; now: string; amount?: ReviewAmount; recipient?: string }[] = [];
      for (const step of planned.steps) {
        if (step.recipient) {
          const known = acceptedRecipients.current.get(step.index) ?? null;
          if (known && known.toLowerCase() !== step.recipient.toLowerCase()) throw new Error('EDITOR_EXECUTION_PLAN_CHANGED');
          if (!known) changes.push({ index: step.index, kind: 'recipient', reviewed: null, now: step.recipient, recipient: step.recipient });
        }
        const before = accepted.current.get(step.index);
        if (before && step.minimum?.asset !== before.asset) throw new Error('EDITOR_EXECUTION_PLAN_CHANGED');
        if (step.minimum && (!before || BigInt(step.minimum.units) < BigInt(before.units)))
          changes.push({ index: step.index, kind: 'minimum', reviewed: before?.text ?? null, now: step.minimum.text, amount: step.minimum });
      }
      if (changes.length) {
        pendingSend.current = { approvalId: id, index };
        offered.current = new Map(changes.flatMap(c => c.amount ? [[c.index, c.amount] as const] : []));
        offeredRecipients.current = new Map(changes.flatMap(c => c.recipient ? [[c.index, c.recipient] as const] : []));
        setUpdated(changes.map(c => ({ index: c.index, kind: c.kind, reviewed: c.reviewed, now: c.now }))); setPhase('confirm-update');
        return;
      }
    }
    await sendPrepared(id, index, prepared.prepared as Record<string, unknown>, prepared.feePayer);
  }

  const authorize = () => guard(async () => {
    if (!review || !evmAccount) throw new Error('REVIEW_REQUIRED');
    if (review.validUntil && Date.parse(review.validUntil) <= Date.now()) throw new Error('REVIEW_EXPIRED');
    setPhase('authorizing');
    const profile = await profileFor([...new Set(review.groups.map(g => g.chain))]);
    // Authorize is bound to this Review: the reviewed wallet, workflow and plan of groups (the server refuses anything else).
    const binding = { owner: review.owner, workflowHash: review.workflowHash, groups: review.groups.map(g => ({ strategy: g.strategy, steps: g.steps })) };
    let result = await authorizeEditorWorkflow(reviewedWorkflow.current, profile, binding);
    if (!result.ok && result.code === 'EVM_WALLET_PROOF_REQUIRED') {
      // One-time sign-in of this wallet in this browser (EIP-4361 message; it authorizes no transaction), then the same Authorize continues.
      setPhase('proving');
      const proven = await proof.proveEvm();
      if (!proven.account) throw new Error(proven.error ?? 'WALLET_REQUEST_REJECTED');
      setPhase('authorizing');
      result = await authorizeEditorWorkflow(reviewedWorkflow.current, profile, binding);
    }
    if (!result.ok) throw new Error(result.code);
    const { approvalId: id, proposal, prepared } = result.value;
    keepBatchHandout(id, 0, (prepared as { handout?: string | null } | null)?.handout);
    setApprovalId(id); authorizedRevision.current = workflow.revision;
    record.current = { workflowId: workflow.workflowId, approvalId: id, workflowHash: review.workflowHash, owner: evmAccount.toLowerCase(), revision: workflow.revision,
      at: new Date().toISOString() };
    putStored(record.current);
    adopt(proposal);
    // The wallet is asked for exactly what the owner reviewed, or the owner sees what changed first (a signed minimum below the reviewed one).
    accepted.current = new Map(review.steps.flatMap(step => step.minimum ? [[step.index, step.minimum] as const] : []));
    acceptedRecipients.current = new Map(review.steps.flatMap(step => step.recipient ? [[step.index, step.recipient] as const] : []));
    await continueGroup(id, 0, prepared as { prepared: unknown; feePayer: string });
  });
  const confirmUpdate = () => guard(async () => {
    const pending = pendingSend.current;
    if (!pending || !evmAccount) throw new Error('REVIEW_REQUIRED');
    // The owner accepted exactly the minimums shown; anything lower after a new quote is shown again before the wallet is asked.
    for (const [index, amount] of offered.current) accepted.current.set(index, amount);
    for (const [index, recipient] of offeredRecipients.current) acceptedRecipients.current.set(index, recipient);
    setUpdated([]); setPhase('authorizing');
    await continueGroup(pending.approvalId, pending.index);
  });
  /** A later group that became due (or a group the wallet answer was lost for): prepared now and handed to the wallet. */
  const authorizeDue = () => guard(async () => {
    if (!approvalId || !run) throw new Error('WORKFLOW_RUN_NOT_FOUND');
    const group = run.groups.find(g => g.steps[0] <= run.currentStep && run.currentStep <= g.steps[1]);
    if (!group) throw new Error('WORKFLOW_RUN_GROUP_NOT_FOUND');
    setPhase('authorizing');
    await continueGroup(approvalId, group.index);
  });
  /** The run's status, signing this wallet in again first when its session expired (the sign-in authorizes no transaction). */
  async function loadStatus(id: string, interactive = true) {
    let r = await workflowRunStatusHandoff(id);
    // Automatic reads never open a wallet prompt: the owner signs in from the panel ("Load workflow progress").
    if (!interactive && !r.ok && (FORGOTTEN.test(r.code) || r.code === 'EVM_WALLET_PROOF_REQUIRED')) throw new Error('EDITOR_RUN_SIGN_IN_REQUIRED');
    // "Not found" is also the answer when this browser's wallet sign-in expired: the connected wallet signs FloFi's sign-in message once (no
    // transaction) and the status is read again. Still not found: another wallet started it (the run is kept; the owner may forget it here).
    if (!r.ok && (FORGOTTEN.test(r.code) || r.code === 'EVM_WALLET_PROOF_REQUIRED')) {
      setPhase('proving');
      const proven = await proof.proveEvm();
      // A declined (or busy) sign-in says nothing about what the wallet sent: never the "nothing was sent" of a declined wallet request.
      if (!proven.account) throw new Error('EDITOR_RUN_SIGN_IN_REQUIRED');
      r = await workflowRunStatusHandoff(id);
      if (!r.ok && FORGOTTEN.test(r.code)) throw new Error('EDITOR_RUN_OTHER_WALLET');
    }
    if (!r.ok) throw new Error(r.code);
    adopt(r.value); setPhase(p => p === 'proving' ? 'running' : p);
  }
  /** The wallet already has this run's batch (after a reload, a closed tab or a lost answer): it is recorded, read back and reported. */
  const checkWallet = useCallback((interactive = true) => guard(async () => {
    if (!approvalId) return;
    const current = runRef.current;
    if (!current) { await loadStatus(approvalId, interactive); return; }
    const group = current.groups.find(g => g.state === 'AUTHORIZED' && g.batchId) ?? current.groups.find(g => g.state === 'PREPARED' && g.strategy === 'EVM_WALLET_BATCH');
    const held = group ? await heldBatch(approvalId, group.index, group.batchId) : null;
    if (!group || !held) { await loadStatus(approvalId, interactive); return; }
    if (group.state === 'PREPARED') { await recordBatch(approvalId, group.index, held); return; }
    const done = await walletBatchHashes(held).catch(() => null);
    if (done?.hashes.length) await report(approvalId, group.index, done.hashes);
    else if (done?.failed) await report(approvalId, group.index, [], true);
    else await loadStatus(approvalId, interactive);
  }), [approvalId, adopt]);
  // After a reload with a batch in the wallet, its result is read back once, automatically (never sent again).
  const recovered = useRef<string | null>(null);
  const recoverable = Boolean(run && (run.nextAction === 'OWNER_CONFIRMS_BATCH' || unrecorded
    || run.groups.some(g => g.state === 'PREPARED' && g.strategy === 'EVM_WALLET_BATCH' && g.batchId)));
  useEffect(() => {
    const key = `${approvalId}:${run?.nextAction}:${run?.currentStep}`;
    // Never while an action is in flight, and never over an error the owner has not seen yet (they act on it, e.g. "Check my wallet").
    if (!approvalId || !recoverable || recovered.current === key || acting.current || error !== null
      || ['wallet', 'confirming', 'authorizing', 'proving', 'confirm-update'].includes(phase)) return;
    recovered.current = key;
    void checkWallet(false);
  }, [approvalId, recoverable, run?.nextAction, run?.currentStep, phase, error, checkWallet]);
  const end = () => guard(async () => {
    if (!approvalId) return;
    const r = await cancelWorkflowRunHandoff(approvalId);
    if (!r.ok) throw new Error(r.code);
    adopt(r.value); dropStored(approvalId);
  });
  const resume = () => guard(async () => {
    if (!approvalId) return;
    const r = await resumeWorkflowRunHandoff(approvalId);
    if (!r.ok) throw new Error(r.code);
    adopt(r.value); setPhase('running');
  });
  /** Stops showing the run in this tab without forgetting it (an earlier visit's run is offered again). */
  const hide = () => { if (acting.current) return; setApprovalId(null); setRun(null); runRef.current = null; setFollowing(false); setPhase('idle'); setError(null); setUpdated([]);
    recovered.current = null; setUnrecorded(false); accepted.current = new Map(); acceptedRecipients.current = new Map(); refusedFor(null); };
  const dismiss = () => { dropStored(approvalId); setFollowing(false); setApprovalId(null); setRun(null); runRef.current = null; setReview(null); reviewRef.current = null; setPhase('idle');
    setError(null); setUpdated([]); recovered.current = null; setUnrecorded(false); authorizedRevision.current = null; accepted.current = new Map();
    acceptedRecipients.current = new Map(); record.current = null; refusedFor(null); };
  /** Follows a run this browser started in an earlier visit: its progress, a batch to read back from the wallet, its result. */
  const followEarlier = () => guard(async () => {
    const e = earlier;
    if (!e) return;
    setEarlier(null); setReview(null); reviewRef.current = null; authorizedRevision.current = null; setFollowing(true); setApprovalId(e.approvalId); record.current = e;
    await loadStatus(e.approvalId);
  });
  // A finished run of this visit's workflow is closed once the owner edits the Canvas into another workflow (the result was shown).
  useEffect(() => {
    if (run && !OPEN_RUN.includes(run.state) && authorizedRevision.current !== null && workflow.revision !== authorizedRevision.current) dismiss();
  }, [workflow.revision, run?.state]); // only a Canvas edit after a finished run closes it
  const grouped = Boolean(review && review.mode !== 'STEP_BY_STEP' && !review.refusal);
  // A followed earlier run is this tab's view only: it never counts as THIS workflow's run (its primary action and Review stay its own).
  const ownRun = Boolean(approvalId) && !following;
  return { available: available && enabled, phase, review, error, run, updated, started: ownRun, grouped, unrecorded, refusedGroup, following, hide, resume,
    canReview: available && enabled && evmWorkflow && !approvalId,
    visible: available && (enabled || Boolean(approvalId) || Boolean(earlier)), earlier: Boolean(available && earlier && !approvalId), followEarlier,
    stepByStep: !ownRun && (!evmWorkflow || (review ? reviewOffersStepByStep(review)
      : error !== null && !following && !TRANSIENT_REVIEW_FAILURE.has(error))),
    unloaded: Boolean(approvalId && !run),
    startReview: runReview, authorize, confirmUpdate, authorizeDue, checkWallet, end, dismiss };
}

const ACTION: Readonly<Record<string, string>> = { swap: 'Swap', bridge: 'Bridge', supply: 'Supply', borrow: 'Borrow', repay: 'Repay', withdraw: 'Withdraw',
  add_liquidity: 'Add liquidity', transfer: 'Transfer' };
/** A user-funded run's DELEGATED step is worded by its group (`stepText`), never "authorized" for a group nothing was signed for. */
const STEP_STATE: Readonly<Record<string, string>> = { PENDING: 'Waiting', READY: 'Ready for your signature', AWAITING_OWNER: 'In your wallet', DELEGATED: 'Authorized',
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
  USER_FUNDED_NOT_FEWER_INTERACTIONS: 'Grouping would not ask your wallet fewer times for this workflow, so each step is confirmed on its own.',
  USER_FUNDED_CHAIN_DISABLED: 'Grouped authorization is not enabled for this network on this FloFi deployment.',
  WORKFLOW_BINDING_RESOLVED_WHEN_DUE: 'A step spends what an earlier step delivers on another network; it is authorized when that delivery lands.',
  USER_OPERATION_BUNDLER_UNAVAILABLE: 'A step after a bridge is authorized when the bridge delivery lands (no relay is configured for signing it earlier).',
  EVM_SMART_ACCOUNT_REQUIRED: 'A step after a bridge is authorized when the bridge delivery lands (your account is not a smart account).',
  WALLET_TYPED_DATA_USER_OPERATION_UNSUPPORTED: 'A step after a bridge is authorized when the bridge delivery lands (your wallet cannot sign it in advance).',
  USER_OPERATION_AAVE_SIGNED_WHEN_DUE: 'An Aave step after a bridge is authorized when the bridge delivery lands, after FloFi simulates it on that state (health factor and supply cap).',
  USER_OPERATION_SWAP_OUTPUT_SIGNED_WHEN_DUE: 'A swap after a bridge whose output a later step spends is authorized when the bridge delivery lands, after FloFi simulates the whole batch and proves you receive that output.',
  SOLANA_MULTI_SIGN_UNSUPPORTED: 'Your Solana wallet confirms each transaction separately.',
  SOLANA_DURABLE_NONCE_NOT_OFFERED: 'A Solana step after a bridge is signed when the delivery lands (a recent blockhash expires within about a minute).',
  USER_FUNDED_NATIVE_SWAP_UNSUPPORTED: 'A swap of native ETH runs through its own review and wallet confirmation.',
  USER_FUNDED_ACTION_NOT_BUILDABLE: 'This step (for example a bridge or a liquidity position) runs through its own review and wallet confirmation.',
  WORKFLOW_SLIPPAGE_UNSUPPORTED: 'A swap allows more than 3% slippage, which cannot be fixed in one batch, so it is confirmed on its own. Lower the slippage to batch it.',
  AAVE_BENEFICIARY_NOT_OWNER: 'An Aave step names another account than the connected wallet, so it cannot be batched. Rebuild that step with this wallet.',
  USER_FUNDED_SWAP_ASSET_UNSUPPORTED: 'A swap of this asset (for example a Stock Token) runs through its own review, which checks it, and its own wallet confirmation.',
  USER_FUNDED_SWAP_ADAPTER_UNSUPPORTED: 'This step (for example wrapping or unwrapping ETH) runs through its own review and wallet confirmation.',
  USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED: 'A transfer of this token (for example a Stock Token, or a token outside FloFi\'s catalog) runs through its own review and wallet confirmation.',
  // The planner starts a new sign-all group at a Solana step that spends an output of an earlier step of its own group (it could not be
  // simulated before that output lands): one more wallet prompt, signed when it has landed.
  SOLANA_GROUP_STEP_DEPENDENT: 'A Solana step that spends what an earlier step of the same batch delivers is signed once that output has landed (one more wallet prompt).',
  // P0 hotfix (E1): why a bridge is not part of the batch (it then runs through its own review: an approval and the deposit may each ask your wallet).
  USER_OPERATION_BRIDGE_SIGNED_WHEN_DUE: 'A bridge after another bridge is authorized when the first delivery lands (its price and deadline are fixed when you sign it).',
  USER_FUNDED_BRIDGE_PROVIDER_UNSUPPORTED: 'This bridge uses a route FloFi does not batch (only a direct Across deposit is batched), so it runs through its own review and wallet confirmations.',
  USER_FUNDED_BRIDGE_PAIR_UNSUPPORTED: 'This bridge route is not one FloFi batches, so it runs through its own review and wallet confirmations.',
  USER_FUNDED_BRIDGE_ASSET_UNSUPPORTED: 'This bridge moves an asset FloFi does not batch, so it runs through its own review and wallet confirmations.',
  USER_FUNDED_BRIDGE_DESTINATION_UNREADABLE: 'FloFi cannot follow deliveries on this bridge\'s destination network here, so the bridge runs through its own review and wallet confirmations.',
  USER_FUNDED_BRIDGE_RECIPIENT_NOT_OWNER: 'This bridge pays another wallet than the connected one, so it cannot be batched. It runs through its own review and wallet confirmations.',
  USER_FUNDED_BRIDGE_FLOW_CLOSED: 'This bridge\'s own flow is not open for execution on FloFi right now, so it cannot join the batch. Nothing was sent.',
};
/**
 * USER_FUNDED_PREPARED_STILL_VALID: the batch FloFi already prepared for this group can still execute on chain (less than
 * `PREPARED_MIN_REMAINING_MS`, 3 minutes, left: too little to review and confirm it again), so the server prepares no second batch that could
 * run alongside it. This request asked the wallet nothing; the earlier batch may be in the wallet (another tab or device may have handed it
 * over), so nothing here says it was never sent. Worded from the refused group's own state (`refusedGroup`), whatever it is by now:
 *   still PREPARED and valid        until when the owner waits for it, and to try again then (`PREPARED_STILL_VALID_UNTIL`) only when a fresh
 *                                   one will be possible at that time (the same rule as below, evaluated at its validity); else to confirm it
 *                                   before then, with no new request to come (`PREPARED_STILL_VALID_LAST`)
 *   its validity passed             that it expired; that a fresh one can be asked (`PREPARED_EXPIRED_AT`) only when this page would actually
 *                                   send one — it never asked the wallet for this group and lost the answer (`askedOnce`), and the run is
 *                                   running with a window that outlasts a new preparation — else to check the wallet's activity and end the
 *                                   workflow (`PREPARED_EXPIRED_CHECK_WALLET`)
 *   answered, or stopped unanswered nothing: the group's own state, or the run's "may have executed" note, says what happened (`refusalSettled`)
 *   moved on, no time to date it    nothing (it no longer describes the group)
 * The undated words only when the run view shows no group to date it from (and on /approve, which shows no group validity): true before and
 * after the request expires, they never tell the owner to confirm it unconditionally — once its validity passed, its on-chain deadline refuses
 * it and the wallet would still pay the fee.
 */
const PREPARED_STILL_VALID = 'FloFi already prepared a request for this step that may still be open in your wallet. Confirm it only within 10 minutes of when it was prepared (after that its on-chain deadline refuses it and your wallet would still pay the fee: reject it), or try again once it has expired; FloFi never prepares a second one that could run alongside it.';
const PREPARED_STILL_VALID_UNTIL = 'FloFi did not ask your wallet this time: the request it already prepared stays valid on chain until {0}, and your wallet may hold it. If your wallet shows it, confirm it there; otherwise wait until {0}, then try again. FloFi never prepares a second request that could run alongside it.';
const PREPARED_STILL_VALID_LAST = 'FloFi did not ask your wallet this time: the request it already prepared stays valid on chain until {0}, and your wallet may hold it. If your wallet shows it, confirm it there before then. FloFi will not prepare another request for this step.';
/**
 * WORKFLOW_RUN_EXPIRED: the run's window has passed, or ends before a NEW wallet request could expire (the server prepares one only while the
 * window outlasts its validity, `preparedHorizonMs`). A request FloFi prepared earlier may still be in the wallet, so never "nothing was sent".
 * Also the note shown where the due group's "Authorize" is withheld for that reason.
 */
const RUN_WINDOW_CLOSED = 'This workflow\'s time window has ended, or ends too soon for a new wallet request, so FloFi does not prepare another one for it. If a request is still open in your wallet, check your wallet\'s activity; you can end the workflow once no request of it can still execute.';
const PREPARED_EXPIRED_AT = 'The request FloFi prepared expired at {0}; you can ask for a fresh one now.';
const PREPARED_EXPIRED_CHECK_WALLET = 'The request FloFi prepared expired at {0}. FloFi will not ask your wallet for a fresh one: check your wallet\'s activity (it may have executed before it expired), then end the workflow.';
/**
 * Refusals in plain words, keyed by the bare code the server answers with: never a placeholder, because a refusal of a preparation, an
 * authorization or a Review that failed as a whole names no step (a step number would be invented, or the code shown in its place). A
 * Review's own refusal that names its step uses `STEP_REFUSAL` instead.
 */
export const EXECUTION_REFUSAL: Readonly<Record<string, string>> = {
  // P0: Flight Beta refusals (wallet not linked to the account, session ended, access not active) in plain words.
  ...FLIGHT_REFUSAL_MESSAGES,
  BORROW_UNSAFE_HEALTH_FACTOR: 'This Borrow would leave your Aave health factor below 2.0 after the batch. Lower the Borrow amount or supply more collateral.',
  SIMULATION_REVERTED: 'FloFi simulated the whole batch and one of its calls would fail on chain now, so your wallet was not asked. Check the amounts, balances and allowances, then try again.',
  SWAP_MINIMUM_NOT_MET: 'A swap in this batch would deliver less than its signed minimum now, so your wallet was not asked. Try again for a fresh quote.',
  USER_FUNDED_SIMULATION_UNAVAILABLE: 'This network’s RPC cannot simulate the whole batch, so FloFi does not offer it in one confirmation. Each step is confirmed on its own instead.',
  USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE: 'Your wallet does not hold enough ETH on this network for the network fee of the batch.',
  AAVE_BENEFICIARY_NOT_OWNER: 'An Aave step names another account than the connected wallet. Rebuild that step with this wallet.',
  WORKFLOW_SLIPPAGE_UNSUPPORTED: 'A swap allows more than 3% slippage, which cannot be fixed in one batch. Lower the slippage.',
  ACCOUNT_SESSION_REQUIRED: 'Sign in to FloFi to run the whole workflow with one wallet confirmation. You can still confirm each step on its own.',
  EVM_WALLET_REQUIRED: 'Connect your wallet to review the whole workflow.',
  REVIEW_EXPIRED: 'The reviewed prices expired. Review the workflow again to refresh them.',
  WALLET_REQUEST_REJECTED: 'You declined the request in your wallet. Nothing was sent. You can authorize again; the workflow can be ended once the prepared request expires.',
  // The same answer once this workflow's window no longer allows a new request (the Authorize action is gone): nothing to authorize again.
  WALLET_REQUEST_REJECTED_WINDOW_CLOSED: 'You declined the request in your wallet. Nothing was sent. FloFi does not prepare another request for this workflow; you can end it.',
  WALLET_BATCH_SENT_UNRECORDED: 'Your wallet already has the batch for these steps, but FloFi has not recorded it yet. Do not send it again: FloFi reads it back from your wallet.',
  WORKFLOW_RUN_GROUP_IN_FLIGHT: 'A prepared wallet request is still valid, so the workflow cannot be ended yet. Try again after it expires.',
  EDITOR_EXECUTION_PLAN_UNVERIFIED: 'FloFi could not compare the prepared minimums with your review, so your wallet was not asked. Try again.',
  EVM_WALLET_PROOF_REQUIRED: 'Sign in with your wallet to follow this workflow. The sign-in authorizes no transaction.',
  EDITOR_EXECUTION_PLAN_CHANGED: 'The workflow or its plan changed since your review. Nothing was asked from your wallet. Review the whole workflow again.',
  EDITOR_RUN_SIGN_IN_REQUIRED: 'Sign in with the wallet that started this workflow to follow it (the sign-in authorizes no transaction).',
  EDITOR_RUN_OTHER_WALLET: 'This workflow was started by another wallet. Connect that wallet to follow it.',
  WALLET_BATCH_SEND_UNCONFIRMED: 'Your wallet was asked to send this batch, but its answer never arrived, so FloFi cannot tell whether it was sent. Check your wallet\'s activity. FloFi will not ask your wallet for it again; the workflow can be ended once the prepared request expires.',
  EDITOR_REVIEW_RATE_LIMITED: 'Too many reviews in a short time. Wait a few minutes and review again.',
  WITHDRAW_UNSAFE_HEALTH_FACTOR: 'This Withdraw would leave your Aave health factor below 2.0 after the batch. Withdraw less or repay part of the debt first.',
  REPAY_PARTIAL_DEBT_REQUIRED: 'A Repay must be smaller than your current debt (a full repayment is not offered here). Lower the Repay amount.',
  WALLET_BATCH_NOT_SENT: 'Your wallet refused this batch before sending anything (it may not support it on this network). Nothing was sent; you can try again.',
  WALLET_WRONG_NETWORK: 'Switch your wallet to the network of this group, then try again.',
  WALLET_ACCOUNT_MISMATCH: 'Your wallet is locked or another account is selected. Unlock your wallet, select the account this run belongs to, and try again; nothing was sent.',
  // P0 universal execution: what the chain's own contracts say about a token, or what the network lacks, in plain words.
  SIMULATION_SWAP_OUTPUT_SHORT: 'A token in this batch does not deliver the full amount the swap sends (it charges a fee on transfer or changes balances), so it cannot be batched. Nothing was sent.',
  TOKEN_METADATA_MISMATCH: 'A token\'s contract does not match FloFi\'s catalog (its decimals differ on chain), so nothing was prepared.',
  CONTRACT_CODE_MISSING: 'A token in this workflow has no contract on this network, so nothing was prepared.',
  USER_FUNDED_DEADLINE_UNAVAILABLE: 'This network has no registered router to give the batch an on-chain expiry, so it is not offered as a batch. Nothing was sent.',
  USER_FUNDED_L1_FEE_UNAVAILABLE: 'FloFi could not read this network\'s data fee, so the batch was not offered. Nothing was sent; try again.',
  EDITOR_RUNS_NOT_ENABLED: 'Running a whole workflow is not enabled on this FloFi deployment.',
  HANDOFF_RATE_LIMITED: 'Too many workflow runs were started recently. Try again later.',
  HANDOFF_PENDING_LIMIT: 'Too many workflow runs are waiting for you. Finish or end one of them first.',
  EIP5792_UNSUPPORTED_CHAIN: 'Your wallet cannot batch on this network.',
  // Review fixes: a batch already handed out is never prepared a second time while it can still execute (a refusal before any wallet request);
  // a second, different answer for one group; and a browser that cannot keep the record that stops a request from being sent twice.
  USER_FUNDED_PREPARED_STILL_VALID: PREPARED_STILL_VALID,
  // Final review: a wallet batch goes to ONE browser (workflow-runs/service.ts `handedTo`); another one is refused before any wallet request.
  WALLET_BATCH_HANDED_OUT_ELSEWHERE: 'This step\'s wallet request was already handed to another browser or wallet, and FloFi gives it only to that one: if it was confirmed there, it may already have executed. Continue in that browser; once the request has expired you can end the workflow here and check your wallet\'s activity.',
  WALLET_BATCH_ANSWER_MISMATCH: 'Your wallet reported a different batch for this step than the one FloFi recorded: it may have run twice. Check your wallet\'s activity; FloFi recorded only the first.',
  WALLET_ATTEMPT_UNRECORDABLE: 'This browser could not keep a record of the request, so FloFi did not ask your wallet (that record is what stops a request from ever being sent twice). Allow site storage or use another browser, then try again.',
  // A wallet answer (or report) for a group FloFi had already stopped while its batch was unanswered: never recorded, never "nothing was sent".
  WALLET_BATCH_ANSWERED_AFTER_STOP: 'Your wallet reported a batch for a step FloFi had already stopped: it may have executed. Check your wallet\'s activity; FloFi could not record it.',
  WORKFLOW_RUN_EXPIRED: RUN_WINDOW_CLOSED,
  // P0 hotfix (E1): a bridge in the batch was refused before your wallet was asked (nothing was sent).
  BRIDGE_QUOTE_UNAVAILABLE: 'The bridge provider did not answer with a route just now, so your wallet was not asked. Nothing was sent; try again.',
  BRIDGE_FEE_ABOVE_LIMIT: 'The bridge fee is above your slippage limit for this amount, so your wallet was not asked. Nothing was sent; raise the limit or bridge more.',
  BRIDGE_QUOTE_VALIDITY_SHORT: 'The bridge quote would expire before the batch could execute, so your wallet was not asked. Nothing was sent; try again.',
  BRIDGE_FILL_DEADLINE_SHORT: 'The bridge deadline leaves too little time for the delivery, so your wallet was not asked. Nothing was sent; try again.',
  BRIDGE_EXCLUSIVITY_INVALID: 'The bridge quote reserves its delivery past its own deadline, so your wallet was not asked. Nothing was sent; try again.',
  SIMULATION_BRIDGE_DEPOSIT_MISMATCH: 'FloFi simulated the batch and the bridge deposit would not be exactly the one you sign, so your wallet was not asked. Nothing was sent.',
  ROUTER_DEPOSITS_PAUSED: 'Bridge deposits are paused on this network right now, so your wallet was not asked. Nothing was sent.',
  ROUTER_FILLS_PAUSED: 'Bridge deliveries are paused on the destination network right now, so your wallet was not asked. Nothing was sent.',
  ROUTER_UNEXPECTED_CONTRACT: 'A bridge contract is not the one FloFi verified, so nothing was prepared. Nothing was sent.',
  ACROSS_CALLDATA_MISMATCH: 'The bridge quote did not match what FloFi asked for (amount, recipient or tokens), so your wallet was not asked. Nothing was sent.',
};
/** A Review refusal that names the step it is about (`refusal.step`, shown as {0}): only then is a step number written. */
export const STEP_REFUSAL: Readonly<Record<string, string>> = {
  SIMULATION_REVERTED: 'FloFi simulated the whole batch and step {0} would fail on chain now. Check its amount, balance and allowance; nothing was sent.',
  SWAP_MINIMUM_NOT_MET: 'The swap in step {0} would deliver less than its signed minimum now. Review again for a fresh quote.',
};
const fmtTime = (iso: string, language: string) => new Date(iso).toLocaleTimeString(language === 'PT' ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
/** Native fee in wei as ETH with at most 6 decimals (a non-zero fee never reads 0). */
const eth = (wei: string) => { const v = BigInt(wei), step = 10n ** 12n, shown = (v + step - 1n) / step * step; if (v > 0n && shown === 0n) return '< 0.000001 ETH';
  const whole = shown / 10n ** 18n, frac = (shown % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, ''); return `${whole}${frac ? '.' + frac : ''} ETH`; };
/** An Aave health factor (1e18) truncated to 2 decimals: a value below 2 never reads as 2.00. */
const healthFactor = (wad: string) => { const v = BigInt(wad); return v >= 10n ** 30n ? '∞' : (Number(v / 10n ** 16n) / 100).toFixed(2); };
const amountText = (a: ReviewAmount | null | undefined) => a?.text ?? null;
/**
 * A step the run asks the owner to sign through its own flow (a bridge, liquidity, a step resumed step by step): the Editor does not host that
 * flow, so it links the shared signing page, which resumes this run by its approval reference (wallet proof required there; no new authority).
 */
const approvalSlotHref = (run: RunView) => run.nextAction === 'OWNER_SIGNS_STEP' && /^apr_[a-z2-7]{26}$/.test(run.approvalId ?? '') ? `/approve#${run.approvalId}` : null;
/** How a HALTED run is described: the one rule the Editor and /approve share (workflow-runs/state-machine.ts). */
export { haltedAs };
/** The server's own Resume rule (`RunView.resumable`); undefined only for a view from a server that does not send it yet. */
const serverResumable = (run: RunView): boolean | undefined => {
  const said = (run as { readonly resumable?: unknown }).resumable;
  return typeof said === 'boolean' ? said : undefined;
};
/**
 * A step or group whose wallet batch was handed to the owner's wallet and never answered: it may have executed before its on-chain deadline.
 * Only an answered state (`ANSWERED_STATES`) keeps its own label when it carries WALLET_BATCH_OUTCOME_UNKNOWN (e.g. a late answer recorded after
 * it). Every other state — BLOCKED ("Stopped before submission") when the run stopped at its expiry, SKIPPED ("Not run") when it was ended,
 * anything else — would claim the batch did not run, which nothing proves.
 */
const batchUnanswered = (item: { readonly state: string; readonly code: string | null }) => item.code === WALLET_BATCH_OUTCOME_UNKNOWN && !ANSWERED_STATES.includes(item.state);
/**
 * Whether the run's halted or ended words say a batch may have executed: any step or group carries WALLET_BATCH_OUTCOME_UNKNOWN (the run was
 * stopped at its expiry or ended while a batch it handed to the owner's wallet had no recorded answer), whatever state it shows now — the
 * server's own rule for the run's note (workflow-runs/service.ts) and the channels' (channels/core/status.ts). Such a run never "stopped before
 * anything was sent" or "before any step completed", and never says the reconciled steps' funds still rest in the wallet. A COMPLETED run
 * reconciled every step, and says so.
 */
const outcomeUnknown = (run: RunView) => run.state !== 'COMPLETED'
  && (run.groups.some(g => g.code === WALLET_BATCH_OUTCOME_UNKNOWN) || run.steps.some(s => s.code === WALLET_BATCH_OUTCOME_UNKNOWN));
/** A step's or group's state in words; one whose wallet batch may have executed unseen says so instead of "Not run" or "Stopped before submission". */
const stateText = (labels: Readonly<Record<string, string>>, item: { readonly state: string; readonly code: string | null }) =>
  batchUnanswered(item) ? 'Its batch may have executed before it expired; check your wallet\'s activity' : labels[item.state] ?? item.state;
/**
 * A step's state in words. A user-funded run's DELEGATED step belongs to its group, so it says what that group shows: signed in the wallet,
 * waiting for it while the run can still ask, else not signed (a halted or ended run) — never "authorized" for a group nothing was signed for.
 * The channels' rule (channels/core/status.ts) and /approve's.
 */
const stepText = (run: RunView, step: RunView['steps'][number]) => {
  if (batchUnanswered(step) || run.mode !== 'USER_FUNDED' || step.state !== 'DELEGATED') return stateText(STEP_STATE, step);
  const group = run.groups.find(g => g.steps[0] <= step.index && step.index <= g.steps[1]);
  return group?.signed ? 'Signed in your wallet' : ['RUNNING', 'ATTENTION'].includes(run.state) ? 'Waiting for your wallet' : 'Not signed';
};

export function EditorWorkflowRunPanel({ state }: { state: EditorWorkflowRunState }) {
  const { t: tr, language } = useLocale();
  const { review, run, phase, error } = state;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  if (!state.visible) return null;
  const expired = Boolean(review?.validUntil && Date.parse(review.validUntil) <= now);
  const busy = ['reviewing', 'authorizing', 'proving', 'wallet', 'confirming'].includes(phase);
  // A step number only when the Review names the step (never step 1 by default); otherwise the code's own placeholder-free words.
  const stepRefusal = review?.refusal && review.refusal.step !== null ? STEP_REFUSAL[review.refusal.code] : undefined;
  const refusal = !review?.refusal ? null : stepRefusal ? tr(stepRefusal, String(review.refusal.step! + 1))
    : tr(EXECUTION_REFUSAL[review.refusal.code] ?? 'FloFi cannot prepare this workflow now ({0}). Nothing was sent.', review.refusal.code);
  const runStep = (index: number) => run?.steps.find(s => s.index === index) ?? null;
  const plannedOf = (index: number) => run?.groups.flatMap(g => g.planned?.steps ?? []).find(s => s.index === index) ?? null;
  const currentGroup = run?.groups.find(g => g.steps[0] <= run.currentStep && run.currentStep <= g.steps[1]) ?? null;
  const dueGroup = run && run.nextAction === 'OWNER_SIGNS_GROUP' && currentGroup && !state.unrecorded && !['wallet', 'confirming', 'authorizing', 'confirm-update'].includes(phase)
    ? currentGroup : null;
  // A wallet batch group is offered only while the server would hand out a request for it rather than refuse WORKFLOW_RUN_EXPIRED: a fresh
  // preparation (the run's window outlasts its validity: workflow-runs/service.ts `preparedHorizonMs`), or the request it already prepared while
  // that is still valid (handed out again, or refused as USER_FUNDED_PREPARED_STILL_VALID with its own words). An unreadable time fails closed.
  const preparable = (g: RunView['groups'][number]) => g.strategy !== 'EVM_WALLET_BATCH' || Boolean(run && Date.parse(run.expiresAt) > now + BATCH_PREPARATION_VALIDITY_MS)
    || (g.state === 'PREPARED' && g.validUntil !== null && Date.parse(g.validUntil) > now);
  const due = dueGroup !== null && preparable(dueGroup);
  // The due group's request can no longer be prepared: no "Authorize" (it would only be refused); the panel says why instead.
  const windowClosed = dueGroup !== null && !due;
  // The prepared wallet request(s) of the run view, dated by the LATEST validity: while any of them is still valid it is never called expired.
  const preparedUntil = run?.groups.filter(g => g.state === 'PREPARED' && g.strategy === 'EVM_WALLET_BATCH' && g.validUntil && Number.isFinite(Date.parse(g.validUntil)))
    .map(g => g.validUntil!).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  // A prepared wallet request still valid (the wallet may hold it): the run cannot be ended yet.
  const heldUntil = preparedUntil && Date.parse(preparedUntil) > now ? preparedUntil : null;
  // A run whose wallet batch was handed out and never answered (stopped at its expiry or ended): it may have executed before its deadline.
  const unanswered = run ? outcomeUnknown(run) : false;
  // "Nothing was sent" only while nothing can have reached the wallet: once a batch was handed over or a group signed, the request stands.
  const mayHold = state.unrecorded || unanswered || Boolean(run?.groups.some(g => g.signed || ['AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'RECONCILED'].includes(g.state)));
  // The wallet was asked for this group and FloFi never asks it again (`heldBatch`), so rejecting it there no longer brings a fresh request —
  // except while the wallet prompt is open: a rejection then answers (nothing sent) and the group is offered again.
  const askedOnce = state.unrecorded && phase !== 'wallet';
  // This page would hand a FRESH request to the wallet for an expired one at time `at`: it never asked the wallet for it and lost the answer,
  // and the server would prepare one then (a running run whose window outlasts a new preparation's validity: workflow-runs/service.ts
  // `preparedHorizonMs`).
  const freshAt = (at: number) => Boolean(run && !askedOnce && ['RUNNING', 'ATTENTION'].includes(run.state) && Date.parse(run.expiresAt) > at + BATCH_PREPARATION_VALIDITY_MS);
  const freshRequest = freshAt(now);
  // USER_FUNDED_PREPARED_STILL_VALID, worded from the refused group's own state (see `PREPARED_STILL_VALID`), dated by its validity itself (NOT
  // only while it is still in the future: `now` ticks while the refusal stays on screen). A state without `refusedGroup` dates it from the run
  // view's prepared wallet batches (the latest validity).
  const refused = error !== PREPARED_STILL_VALID_CODE || !run ? null : typeof state.refusedGroup === 'number' ? run.groups.find(g => g.index === state.refusedGroup) ?? null
    : run.groups.find(g => g.state === 'PREPARED' && g.strategy === 'EVM_WALLET_BATCH' && g.validUntil === preparedUntil) ?? null;
  const refusedUntil = refused?.validUntil && Number.isFinite(Date.parse(refused.validUntil)) ? refused.validUntil : null;
  // Not past PREPARED yet (PLANNED: a run view older than the server's preparation).
  const refusedOpen = refused === null || refused.state === 'PREPARED' || refused.state === 'PLANNED';
  const stillValidText = (): string | null => {
    if (refused && refusalSettled(refused)) return null;
    if (refusedUntil && Date.parse(refusedUntil) <= now)
      return tr(refusedOpen && freshRequest ? PREPARED_EXPIRED_AT : PREPARED_EXPIRED_CHECK_WALLET, fmtTime(refusedUntil, language));
    if (!refusedOpen) return null;
    // "Wait until then, then try again" only when a fresh request will be possible at that time; else the request on hand is the last one.
    return refusedUntil ? tr(freshAt(Date.parse(refusedUntil)) ? PREPARED_STILL_VALID_UNTIL : PREPARED_STILL_VALID_LAST, fmtTime(refusedUntil, language))
      : tr(PREPARED_STILL_VALID);
  };
  const errorText = !error ? null : error === PREPARED_STILL_VALID_CODE ? stillValidText()
    : error === 'WALLET_REQUEST_REJECTED' && windowClosed ? tr(EXECUTION_REFUSAL.WALLET_REQUEST_REJECTED_WINDOW_CLOSED!)
    : tr(EXECUTION_REFUSAL[error] ?? (mayHold
      ? 'FloFi could not complete this request ({0}). What your wallet already has stands: FloFi keeps following it and never sends it again.'
      : 'FloFi could not complete this request ({0}). Nothing was sent.'), error);
  // "End workflow" follows the server's own rule (`canEndWorkflow`, the one /approve and the store's cancellation use): e.g. a group whose batch
  // the wallet reported not sent is BLOCKED but keeps its authorization, and its HALTED run can (only) be ended. One stricter case: a signed user
  // operation FloFi has not relayed stays valid on chain until the owner cancels it, which only /approve offers, so it is not ended from here.
  const unrelayed = run?.groups.some(g => g.strategy === 'EVM_USER_OPERATION' && g.signed && !['SUBMITTED', 'UNCERTAIN', 'RECONCILED', 'FAILED'].includes(g.state)) ?? false;
  const endable = Boolean(run && canEndWorkflow(run, run.steps, run.groups, new Date(now)) && !unrelayed);
  // Resume is offered exactly when the server would accept it (`run.resumable`, its own `resumeRefusal`: inside the run's window, an owner-step
  // group's BLOCKED step too); only a view without that field falls back to this page's own reading, which never resumes a group whose batch was
  // handed to the wallet and never answered (it may have executed).
  const resumable = run ? serverResumable(run) ?? (run.state === 'HALTED' && currentGroup?.state === 'BLOCKED' && !currentGroup.signed
    && currentGroup.code !== WALLET_BATCH_OUTCOME_UNKNOWN) : false;
  // A run whose batch may have executed unseen (`unanswered`) is never "stopped before anything was sent", whatever a view without the server's
  // own `halted` would suggest (fails closed to STOPPED).
  const halted = run?.state === 'HALTED' ? (unanswered && haltedAs(run) === 'NOTHING_SENT' ? 'STOPPED' : haltedAs(run)) : null;
  const counts = review?.counts;
  // P0 hotfix (E1): a step's words from the shared execution vocabulary where a batched bridge adds a fact (its delivery awaited, or not observed);
  // otherwise the step's own words. Progress counts reconciled steps only; a group whose delivery is awaited says so.
  const stepWords = (r: RunView, step: RunView['steps'][number]) => {
    const p = runStepPhase(r, step);
    return p && p.phase !== 'RECONCILED' ? tr(EXECUTION_PHASE_LABEL[p.phase], p.network ? tr(p.network) : '') : tr(stepText(r, step));
  };
  const progress = run ? runProgress(run) : null, awaited = run ? awaitedDelivery(run) : null;
  const groupWords = (g: RunView['groups'][number]) => g.delivery?.state === 'AWAITING_DESTINATION' && (g.state === 'SUBMITTED' || g.state === 'UNCERTAIN') && awaited
    ? `${tr(EXECUTION_PHASE_LABEL.CONFIRMED_AT_SOURCE, tr(awaited.source))} · ${tr(EXECUTION_PHASE_LABEL.AWAITING_DESTINATION, tr(awaited.destination))}` : tr(stateText(GROUP_STATE, g));
  const bridgeTo = review?.steps.find(step => step.action === 'bridge')?.destination ?? null;
  return <section className="editor-workflow-run panel" aria-label={tr('Whole workflow')} data-run-phase={phase} data-run-state={run?.state ?? undefined}>
    <h3>{tr(run ? 'Workflow progress' : 'Review the whole workflow')}</h3>
    {/* P0 approved UX (board 08): while the wallet holds the request, say which request it is and what the wallet shows, in plain words. */}
    {review && (phase === 'wallet' || phase === 'confirming') && (() => {
      // Only for the run this Review describes (a run of another revision or wallet profile shows its own progress below, never this plan).
      const view = run && run.workflowHash !== review.workflowHash ? null : walletRequestView(review, run);
      return view && <div className="execution-wallet-request" data-phase={phase}>
        <p className="eyebrow">{view.of === null ? tr('EXECUTION · REQUEST {0}', String(view.request)) : tr('EXECUTION · REQUEST {0} OF {1}', String(view.request), String(view.of))}</p>
        <h4>{tr(phase === 'wallet' ? 'Confirm in your wallet' : 'Waiting for your wallet')}</h4>
        {view.items.length > 0 && <><p className="muted">{view.calls === null ? tr('Steps in this request:')
          : !view.itemized ? tr(view.calls === 1 ? 'This request has 1 call, for this step:' : 'This request has {0} calls, for these steps:', String(view.calls))
          : tr(view.calls === 1 ? 'This request has 1 call:' : 'This request has {0} calls:', String(view.calls))}</p>
          <ol className="execution-wallet-calls">{view.items.map((item, index) => <li key={index}>{tr(item.text, ...item.parameters.map((value, at) => at === 1 ? tr(ACTION[value] ?? value) : value))}</li>)}</ol></>}
        <p className="muted">{tr('Editing paused during execution')}</p>
      </div>;
    })()}
    {state.earlier && <div className="editor-run-earlier" role="status"><p>{tr('A workflow you authorized earlier in this browser has not been closed. Its progress, and any batch your wallet already has, are read from FloFi and your wallet.')}</p>
      <button type="button" className="secondary" disabled={busy} onClick={() => void state.followEarlier()}>{tr('Show its progress')}</button></div>}
    {!review && !run && state.canReview && <p>{tr('FloFi checks every step together — amounts, minimums, fees and Aave risk — and asks your wallet only once where it can batch. Nothing is signed or sent by a review.')}</p>}
    {state.following && <p className="muted">{tr('This is a workflow you authorized earlier, not the one on the Canvas.')}</p>}
    {review && <>
      <p className="editor-run-mechanism" data-mode={review.mode}>{tr(review.mode === 'ONE_WALLET_CONFIRMATION'
        ? 'All {0} steps run as ONE wallet confirmation on {1}: one atomic transaction from your own wallet, which pays the network fee.'
        : review.mode === 'GROUPED' ? 'All {0} steps run in {2} wallet confirmations, one per group; a later group is asked when it becomes due.'
        : 'This workflow needs a confirmation in your wallet for each step on its own.', String(review.stepCount), review.groups[0]?.network ?? '', String(review.counts.walletPrompts))}
        {bridgeTo && review.mode !== 'STEP_BY_STEP' ? <> {tr('Then FloFi waits for the bridge delivery on {0} and completes the workflow once it has verified it; you can leave this page meanwhile.', tr(bridgeTo))}</> : null}</p>
      {bridgeTo && review.mode === 'STEP_BY_STEP' && <p className="muted">{tr('The bridge then runs through its own review: its token approval and its deposit may each ask your wallet once more.')}</p>}
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
              {expected && <div><dt>{step.action === 'bridge' && step.destination ? tr('Arrives on {0}', tr(step.destination))
                : tr(step.action === 'borrow' || step.action === 'withdraw' ? 'You receive' : 'Expected')}</dt><dd>{expected}</dd></div>}
              {minimum && step.action !== 'bridge' && <div><dt>{tr('Minimum (your slippage limit)')}</dt><dd>{minimum}</dd></div>}
              {step.action === 'bridge' && step.destination && review.groups.some(g => g.strategy === 'EVM_WALLET_BATCH' && g.steps[0] <= step.index && step.index <= g.steps[1])
                && <div><dt>{tr('Delivery')}</dt><dd>{tr('FloFi waits for this delivery on {0} and verifies it before the workflow completes.', tr(step.destination))}</dd></div>}
              {(planned?.recipient ?? step.recipient) && <div><dt>{tr('To')}</dt><dd><code className="editor-run-recipient">{planned?.recipient ?? step.recipient}</code>
                {(planned?.recipient ?? step.recipient)!.toLowerCase() === review.owner.toLowerCase() ? ` ${tr('(your wallet)')}` : ''}</dd></div>}
              {!expected && step.action === 'swap' && !review.refusal && review.groups.find(g => g.steps[0] <= step.index && step.index <= g.steps[1])?.signing === 'WHEN_DUE'
                && <div><dt>{tr('Expected')}</dt><dd>{tr('Quoted when this step becomes due')}</dd></div>}
              {live?.outcome?.received.map(r => <div key={r.asset}><dt>{tr('Received (reconciled)')}</dt><dd>{receivedText(r, [planned?.expected, step.expected, planned?.spend, step.spend])}</dd></div>)}
            </dl>
            {live && run && <span className="workflow-run-state">{stepWords(run, live)}</span>}
            {live?.outcome?.submissions.map(tx => tx.explorerUrl ? <a key={tx.hash} href={tx.explorerUrl} target="_blank" rel="noreferrer"><code>{tx.hash.slice(0, 10)}…</code></a> : <code key={tx.hash}>{tx.hash.slice(0, 10)}…</code>)}
          </li>;
        })}
      </ol>
      <dl className="editor-run-facts">
        {review.groups.map(g => <div key={g.index}><dt>{review.groups.length > 1 ? tr('Group {0} · {1}', String(g.index + 1), g.network) : g.network}</dt>
          <dd>{tr(HOW[g.strategy] ?? g.strategy)}{g.calls ? ` · ${tr('{0} calls in the batch ({1} token approvals)', String(g.calls.length), String(g.approvals ?? 0))}` : ''}
            {g.fee ? ` · ${tr('about {0} in network fees (up to {1} at today\'s prices; your wallet sets the final fee)', eth(g.fee.estimatedWei), eth(g.fee.maxWei))}`
              : run?.groups[g.index]?.maxFee?.unit === 'wei' ? ` · ${tr('up to {0} in network fees at today\'s prices; your wallet sets the final fee', eth(run.groups[g.index]!.maxFee!.amount))}` : ''}
            {run?.groups[g.index] ? ` · ${groupWords(run.groups[g.index]!)}` : ''}
            {run?.groups[g.index]?.gasPaid ? ` · ${tr('network fees paid: {0}', eth(run.groups[g.index]!.gasPaid!.amount))}` : ''}
            {/* While the wallet prompt is open, an expired request is always rejected there (its on-chain deadline would refuse it and the wallet
                would still pay the fee); a fresh one is promised only when this page would send one. */}
            {run?.groups[g.index]?.state === 'PREPARED' && run.groups[g.index]!.validUntil && Date.parse(run.groups[g.index]!.validUntil!) <= now
              ? ` · ${tr(freshRequest ? 'its quote expired at {0}: reject the request in your wallet; FloFi prepares a fresh one'
                : phase === 'wallet' ? 'its quote expired at {0}: reject the request in your wallet; FloFi does not prepare another one for this workflow'
                : 'its quote expired at {0}: FloFi does not ask your wallet for it again; check your wallet\'s activity, then you can end the workflow',
              fmtTime(run.groups[g.index]!.validUntil!, language))}` : ''}</dd></div>)}
        {review.groups.map(g => {
          // Each group's own health factor: the run's preparation of it when there is one (a later group is prepared when due), else the Review's.
          const hf = run?.groups[g.index]?.planned?.healthFactorAfter ?? g.healthFactorAfter;
          if (!hf) return null;
          const floor = review.steps.some(s => s.index >= g.steps[0] && s.index <= g.steps[1] && (s.action === 'borrow' || s.action === 'withdraw'));
          return <div key={`hf-${g.index}`}><dt>{review.groups.length > 1 ? tr('Aave health factor after group {0}', String(g.index + 1)) : tr('Aave health factor after the batch')}</dt>
            <dd>{floor ? tr('{0} (FloFi requires at least 2.00)', healthFactor(hf)) : healthFactor(hf)}</dd></div>;
        })}
        {counts && <div><dt>{tr('What your wallet is asked')}</dt><dd>{tr(counts.atLeast ? 'at least {0} wallet confirmations' : counts.walletPrompts === 1 ? 'one wallet confirmation' : '{0} wallet confirmations', String(counts.walletPrompts))}
          {' · '}{tr(counts.transactions === 1 ? '1 on-chain transaction' : '{0} on-chain transactions', String(counts.transactions))}{counts.batchedCalls ? ` · ${tr('{0} calls batched', String(counts.batchedCalls))}` : ''}
          {' · '}{tr(counts.signatures === 1 ? '1 signature' : '{0} signatures', String(counts.signatures))}{counts.networkSwitches ? ` · ${tr('{0} network switches', String(counts.networkSwitches))}` : ''}
          {counts.oneTimeSetup.includes('EVM_SMART_ACCOUNT_UPGRADE') ? ` · ${tr('your wallet may upgrade this account to its smart account inside the same confirmation (one time)')}` : ''}
          <br/><span className="muted">{tr('Before it, your wallet may ask to switch to {0} if it is on another network and, once per session, to sign FloFi\'s sign-in message (no transaction).', review.groups[0]?.network ?? '')}</span></dd></div>}
        {review.validUntil && !run && <div><dt>{tr('Prices')}</dt><dd>{expired ? tr('Expired at {0}: review again to refresh them before authorizing.', fmtTime(review.validUntil, language))
          : tr('Quoted at {0}, valid until {1}', fmtTime(review.reviewedAt, language), fmtTime(review.validUntil, language))}</dd></div>}
      </dl>
      <p className="muted">{tr('Your wallet pays every network fee. FloFi never pays, advances or reimburses gas, and never signs or sends for you.')}</p>
      {/* Every wallet batch expires on chain at its preparation's validity: through each swap's own deadline, else a deadline guard as its first
          call (a transfer-only batch too). A batch FloFi cannot give one is refused (USER_FUNDED_DEADLINE_UNAVAILABLE), never sent without it. */}
      {review.groups.some(g => g.strategy === 'EVM_WALLET_BATCH') && <p className="muted">{tr(review.steps.some(step => step.action === 'swap'
        && review.groups.some(g => g.strategy === 'EVM_WALLET_BATCH' && g.steps[0] <= step.index && step.index <= g.steps[1]))
        ? 'Confirm the wallet request promptly: about 10 minutes after FloFi prepares it, an on-chain deadline refuses the whole batch (your wallet would still pay the network fee). Each swap\'s minimum is fixed when FloFi prepares the request.'
        : 'Confirm the wallet request promptly: about 10 minutes after FloFi prepares it, an on-chain deadline refuses the whole batch (your wallet would still pay the network fee).')}</p>}
    </>}
    {!review && run && <>
      {/* After a reload the Review is not in this tab any more: the run's own progress is shown from the server (amounts as reconciled). */}
      <ol className="editor-run-steps" aria-label={tr('Steps')}>
        {run.steps.map(step => {
          const planned = run.groups.flatMap(g => g.planned?.steps ?? []).find(s => s.index === step.index) ?? null;
          return <li key={step.index} data-step-state={step.state}>
            <strong>{tr('Step {0}', String(step.index + 1))} · {tr(ACTION[step.action] ?? step.action)}</strong>
            <dl className="editor-run-amounts">
              {planned?.spend && <div><dt>{tr('Spends')}</dt><dd>{planned.spend.text}</dd></div>}
              {planned?.minimum && <div><dt>{tr('Minimum (your slippage limit)')}</dt><dd>{planned.minimum.text}</dd></div>}
              {planned?.recipient && <div><dt>{tr('To')}</dt><dd><code className="editor-run-recipient">{planned.recipient}</code></dd></div>}
              {step.outcome?.received.map(r => <div key={r.asset}><dt>{tr('Received (reconciled)')}</dt><dd>{receivedText(r, [planned?.expected, planned?.spend])}</dd></div>)}
            </dl>
            <span className="workflow-run-state">{stepWords(run, step)}</span>
            {step.outcome?.submissions.map(tx => tx.explorerUrl ? <a key={tx.hash} href={tx.explorerUrl} target="_blank" rel="noreferrer"><code>{tx.hash.slice(0, 10)}…</code></a> : <code key={tx.hash}>{tx.hash.slice(0, 10)}…</code>)}
          </li>;
        })}
      </ol>
      <dl className="editor-run-facts">{run.groups.map(g => <div key={g.index}><dt>{run.groups.length > 1 ? tr('Group {0}', String(g.index + 1)) : tr('Wallet request')}</dt>
        <dd>{tr(HOW[g.strategy] ?? g.strategy)} · {groupWords(g)}{g.gasPaid ? ` · ${tr('network fees paid: {0}', eth(g.gasPaid.amount))}` : ''}</dd></div>)}</dl>
    </>}
    {refusal && <p className="error-banner" role="alert">{refusal}</p>}
    {/* Board 07: a native-fee shortfall found while preparing this Review shows the server's own numbers (no run exists yet: nothing was sent). */}
    {review?.refusal?.evidence && !run && !state.started && !state.unloaded && <BlockerPanel title={refusal ?? ''} message={refusal ?? ''} error={review.refusal.code} owner={review.owner}
      feeShortfall={review.refusal.evidence} technical={null}/>}
    {state.updated.length > 0 && <div className="editor-run-update" role="alert">
      <p>{tr(state.updated.every(u => u.reviewed) ? 'Prices moved since your review. Your wallet would be asked with these minimums:' : 'Confirm what your wallet will be asked:')}</p>
      <ul>{state.updated.map(u => <li key={`${u.kind}:${u.index}`}>{u.reviewed ? tr('Step {0}: {1} (reviewed {2})', String(u.index + 1), u.now, u.reviewed)
        : u.kind === 'recipient' ? <>{tr('Step {0} pays', String(u.index + 1))} <code className="editor-run-recipient">{u.now}</code></>
        : tr('Step {0}: minimum {1}', String(u.index + 1), u.now)}</li>)}</ul></div>}
    {errorText && <p className="error-banner" role="alert">{errorText}</p>}
    {run && run.stepCount > 1 && <p className="editor-run-progress" role="status" data-completed={progress!.completed}>{tr('{0} of {1} steps completed', String(progress!.completed), String(progress!.total))}</p>}
    {awaited && <p className="editor-run-delivery" role="status">{tr('Your batch is confirmed on {0}. FloFi is waiting for the delivery on {1} and keeps checking even if you leave this page; nothing is sent again.',
      tr(awaited.source), tr(awaited.destination))}</p>}
    {run?.state === 'ATTENTION' && <p role="status">{tr('A submitted step has no final outcome yet. FloFi keeps observing it and never resubmits it.')}</p>}
    {halted && <p role="status">{halted === 'NOTHING_SENT'
      ? <>{tr('Stopped before anything was sent: your funds stay in your wallet.')}{resumable && endable ? <> {tr('You can run each step through its own flow from here, or end the workflow.')}</> : null}</>
      // A batch that may have executed unseen: neither "before any step completed" nor that the reconciled steps' funds still rest in the wallet
      // (that batch may have spent them); the note below says what may have happened.
      : halted === 'STOPPED' ? tr(unanswered ? 'Stopped. FloFi submits nothing more of this workflow; you decide what happens next.'
        : 'Stopped before any step completed. FloFi submits nothing more of this workflow; you decide what happens next.')
      : tr(unanswered ? 'Partially completed: the reconciled steps stay done. FloFi submits nothing more of this workflow; you decide what happens next.'
        : 'Partially completed: the reconciled steps stay done and their funds rest in your wallet. The step that stopped shows what happened to it.')}</p>}
    {/* "Never recorded", not "never reached FloFi": an answer may have arrived after the stop and been refused (WALLET_BATCH_ANSWERED_AFTER_STOP, logged). */}
    {unanswered && <p role="status">{tr('A batch was handed to your wallet and FloFi never recorded an answer for it: it may have executed before it expired. Check your wallet\'s activity.')}</p>}
    {windowClosed && error !== 'WORKFLOW_RUN_EXPIRED' && <p className="muted" role="note">{tr(RUN_WINDOW_CLOSED)}</p>}
    {run?.state === 'COMPLETED' && <p role="status"><strong>{tr('Every step reconciled.')}</strong></p>}
    {phase === 'wallet' && <p role="status">{tr('Confirm the request in your wallet. It shows every call of the batch and the network fee.')}</p>}
    {phase === 'confirming' && <p role="status">{tr('Waiting for your wallet to report the batch…')}</p>}
    {phase === 'proving' && <p role="status">{tr('Sign the FloFi sign-in message in your wallet (once per session). It authorizes no transaction.')}</p>}
    <div className="approval-actions">
      {state.canReview && <button type="button" className={review ? 'secondary' : 'primary'} disabled={busy} aria-busy={phase === 'reviewing' || undefined} onClick={() => void state.startReview()}>
        {tr(phase === 'reviewing' ? 'Reviewing the whole workflow…' : review ? 'Review again' : 'Review whole workflow')}</button>}
      {state.unloaded && <button type="button" className="primary" disabled={busy} onClick={() => void state.checkWallet()}>{tr('Load workflow progress')}</button>}
      {state.following && !busy && <button type="button" className="quiet" onClick={state.hide}>{tr('Hide this workflow')}</button>}
      {review && state.canReview && state.grouped && <button type="button" className="primary editor-run-authorize" disabled={busy || expired} aria-busy={busy || undefined} onClick={() => void state.authorize()}>
        {tr(phase === 'authorizing' ? 'Preparing your wallet request…' : 'Authorize workflow')}</button>}
      {phase === 'confirm-update' && <button type="button" className="primary" onClick={() => void state.confirmUpdate()}>{tr(state.updated.every(u => u.reviewed) ? 'Confirm the updated minimums' : 'Confirm and continue in my wallet')}</button>}
      {resumable && !busy && <button type="button" className="primary" onClick={() => void state.resume()}>{tr('Resume the workflow')}</button>}
      {run && approvalSlotHref(run) && <p><a className="secondary" href={approvalSlotHref(run)!}>{tr('Continue step {0} on the signing page', String(run.currentStep + 1))}</a></p>}
      {due && <button type="button" className="primary" onClick={() => void state.authorizeDue()}>{tr('Authorize steps {0}–{1} now', String(currentGroup!.steps[0] + 1), String(currentGroup!.steps[1] + 1))}</button>}
      {(run?.nextAction === 'OWNER_CONFIRMS_BATCH' || state.unrecorded) && !['wallet', 'confirming'].includes(phase) && <button type="button" className="secondary" onClick={() => void state.checkWallet()}>{tr('Check my wallet for the batch')}</button>}
      {endable && !['wallet', 'confirming'].includes(phase) && <>
          {state.unrecorded && <p className="muted" role="note">{tr('Your wallet may already have sent this batch. Check your wallet\'s activity before ending the workflow: ending it does not stop a batch already on chain.')}</p>}
          <button type="button" className="quiet" onClick={() => void state.end()}>{tr('End workflow')}</button></>}
      {state.unloaded && !busy && <>
        <p className="muted" role="note">{tr('Forgetting removes this workflow only from this browser: the run, and anything your wallet already sent, stay. Check your wallet\'s activity first.')}</p>
        <button type="button" className="quiet" onClick={state.dismiss}>{tr('Forget this workflow in this browser')}</button></>}
      {run && OPEN_RUN.includes(run.state) && heldUntil && !['wallet', 'confirming'].includes(phase)
        && <p className="muted">{tr('The prepared wallet request is valid until {0}; the workflow can be ended after that.', fmtTime(heldUntil, language))}</p>}
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
