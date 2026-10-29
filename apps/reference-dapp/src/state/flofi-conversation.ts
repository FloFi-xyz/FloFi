// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef, useState } from 'react';
import type { AutomationInput } from '../automations/definition';
import type { WorkflowOwner } from '../domain/saved-workflow';
import { parseLocalCommand, summarize, type Command } from '../domain/commands';
import { editorReducer } from '../domain/editor';
import { activeNetworkScope, introducedTestNetworks, testNetworkMessage } from '../domain/network-scope';
import { loadSolanaAuthoringAssetCatalog } from '../app/solana-asset-catalog-action';
import { registerSolanaDisplayCatalog, clearSolanaDisplayCatalog } from '../domain/solana-asset-catalog';
import { ensureNetworkCatalog } from './asset-catalog-store';
import { catalogNetworksNamed } from '../domain/network-registry';
import { useWorkflow } from './workflow-store';
import { completeSendDestination, sendDestinationIssue, SEND_DESTINATION_INVALID, SEND_DESTINATION_QUESTION } from '../domain/send-destination';
import { useBuild009Wallet } from './build009-wallet-store';
import { copilotHelp, useCopilotInterpreter } from '../components/copilot-ai';
import { copilotRejection } from '../domain/copilot-authoring';
import { composerActions } from '../domain/composer-presentation';
import { projectCanvasAction } from '../domain/canvas-lifecycle';
import { currentExecution, isFinalExecutionResult } from '../domain/execution-result';
import { translate } from '../i18n/locale';
import type { ExecutionControls } from './execution-controls';
import { conversationCopy } from '../domain/conversation-copy';
import { answerLanguage, bindingIssue, classifyAnswer, conversationExecution, conversationPhase, conversationReview, describeChatChange, lifecycleRequest, lostSteps,
  reviewBinding, type ConversationLanguage, type ConversationReview, type LifecycleView, type PendingQuestion, type ReviewBinding } from '../domain/conversation-lifecycle';

/**
 * BUILD-FLOFI-CONVERSATIONAL-001: the FloFi chat's state, owned by the workspace shell (above the stage switch) so navigating Build, Simulate and
 * Execute never discards the conversation or its open question. Nothing is persisted: a reload starts a new conversation, and the execution status
 * the chat then shows comes from the existing durable records.
 *
 * Authoring: an explicit, valid request is committed to the canonical workflow at once (`commitChatCommand`: editor validation, base revision,
 * test-network refusal, undoable history), and FloFi confirms what the stored workflow now holds. A change that would drop a step the owner did
 * not name stays the existing Canvas proposal. Lifecycle: "Review workflow" runs the selected runtime's existing simulation; FloFi presents that
 * Review, asks "Do you confirm this workflow?", then separately "Would you like to execute this workflow now?". Only an explicit yes to that
 * question, while the confirmation still binds the same workflow revision, Review authority, Manifest, wallet, network and unexpired quote,
 * invokes the existing Authorize-in-wallet control; the wallet's own confirmation stays mandatory and FloFi never signs. Progress, results and
 * recovery are read from the durable execution record; recovery is observation-only. In an approval context (`direct` false) the chat keeps
 * its previous proposal behaviour and has no lifecycle controls.
 */
export type ChatMessage = {
  readonly id: number; readonly role: 'you' | 'system' | 'ai' | 'flofi'; readonly text: string;
  readonly notes?: readonly string[]; readonly options?: readonly string[];
  /** FloFi's lifecycle copy is written in this language; other `system` copy is translated by the interface. */
  readonly language?: ConversationLanguage;
  readonly review?: ConversationReview; readonly question?: string;
};
export type ConversationBridge = LifecycleView & {
  /** The selected runtime's existing simulation entry (the Canvas CTA's), and why no simulation can start now (null: it can). */
  readonly simulate: () => void | Promise<void>; readonly simulationBlocked: string | null;
  readonly controls: ExecutionControls;
  readonly networkAction?: { readonly label: string; readonly network?: string; readonly disabled: boolean; request(): void } | undefined;
  readonly connectWallet: () => void; readonly startNewWorkflow?: (() => void) | undefined;
  /**
   * BUILD-FLOFI-CHAT-E2E-FIX-002: amounts typed on Canvas cards and never applied (they block every simulation), and the existing card actions that
   * apply (`apply: true`) or discard one. The returned text is why an apply was refused (nothing changed), else null.
   */
  readonly pendingEdits?: readonly PendingEdit[] | undefined; readonly resolveEdit?: ((nodeId: string, apply: boolean) => string | null) | undefined;
  /** The wallet's current network label, and the last wallet network-switch error (a rejected or failed request). */
  readonly walletNetwork?: string | null | undefined; readonly networkError?: string | null | undefined;
};
export type PendingEdit = { readonly nodeId: string; readonly step: number; readonly action: string; readonly value: string };
type Question = { readonly open: PendingQuestion; readonly language: ConversationLanguage };
type Workflow = LifecycleView['workflow'];
type Commit = { readonly before: Workflow; readonly expected: Workflow; readonly role: 'flofi' | 'ai'; readonly language: ConversationLanguage; readonly notes: readonly string[]; readonly reviewed: boolean;
  /** What a position operation does (it may leave the IR as it is): said instead of the step diff. */ readonly summary?: string | undefined };
/** The Copilot's interpretation without its proposal instruction ("…nothing changes until you apply it"): the chat commits instead. */
const APPLY_INSTRUCTION = /\s*(?:Review (?:the proposal |it )?below: nothing changes until you apply it\.|Apply the proposal, then Simulate, Review and sign in your wallet\.|Revise (?:a proposta )?abaixo: nada muda até você aplicá-la\.|Aplique a proposta e depois simule, revise e assine na sua carteira\.)\s*$/;
const short = (value: string) => value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
const actionable = (workflow: LifecycleView['workflow']) => composerActions(workflow).length > 0;

export function useFlofiConversation({ owner, epoch, bridge, direct, interfaceLanguage }: {
  owner: WorkflowOwner | null; epoch: number; bridge: ConversationBridge; direct: boolean; interfaceLanguage: ConversationLanguage;
}) {
  const workflow = useWorkflow();
  const { state, context, propose, dismissProposal, commitChatCommand, undoChatCommit } = workflow;
  const wallet = useBuild009Wallet();
  const copilot = useCopilotInterpreter({ direct });
  const intro = (): ChatMessage => ({ id: 0, role: 'system', text: direct ? 'Describe an action to add it to your workflow. Funds move only after you review, confirm and sign in your wallet.' : 'Review each proposed change before applying it.' });
  const [messages, setMessages] = useState<ChatMessage[]>(() => [intro()]);
  const [input, setInput] = useState('');
  const [automation, setAutomation] = useState<AutomationInput | null>(null);
  // UX-001: an exact Send waiting for its destination ("Which wallet should I send it to?").
  const [destination, setDestination] = useState<{ request: string; network: string } | null>(null);
  const [question, setQuestionState] = useState<Question | null>(null);
  const [sending, setSending] = useState(false);
  const [, setTick] = useState(0);
  const ids = useRef(1), session = useRef(0), lock = useRef(false);
  const questionRef = useRef<Question | null>(null);
  const latest = useRef({ bridge, state, context }); latest.current = { bridge, state, context };
  const pendingCommit = useRef<Commit | null>(null), lastCommit = useRef<{ readonly before: Workflow; readonly expected: Workflow } | null>(null);
  const reviewLock = useRef<{ scope: number; key: string | null; sawBusy: boolean; settled: boolean; language: ConversationLanguage } | null>(null);
  const watch = useRef<{ scope: number; language: ConversationLanguage; phase: string | null; runKey: string | null; continued: string | null } | null>(null);
  const restored = useRef<string | null>(null);
  // BUILD-FLOFI-CHAT-E2E-FIX-002: a Review the chat continues by itself once what blocked it is resolved (the wallet's network switched, an edit
  // applied or discarded), and the sequence step whose completion hands over to the next step's own Review.
  const resume = useRef<{ scope: number; language: ConversationLanguage; until: 'NETWORK' | 'EDIT'; error: string | null } | null>(null);
  const handover = useRef<{ scope: number; language: ConversationLanguage; from: number; waiting: boolean } | null>(null);
  const setQuestion = (next: Question | null) => { questionRef.current = next; setQuestionState(next); };
  const append = (scope: number, ...list: Omit<ChatMessage, 'id'>[]) => {
    if (scope !== session.current) return;
    setMessages(old => [...old, ...list.map(message => ({ ...message, id: ids.current++ }) as ChatMessage)]);
  };
  const flofi = (scope: number, language: ConversationLanguage, text: string, extra: Partial<Omit<ChatMessage, 'id' | 'role' | 'text'>> = {}) =>
    append(scope, { role: 'flofi', text, language, ...extra });

  // A new owner (another wallet identity) or a new workflow starts a new conversation; a late answer of the previous one is dropped.
  const ownerKey = owner ? `${owner.namespace}:${owner.address}` : null, lastOwner = useRef(ownerKey), lastEpoch = useRef(epoch), lastWorkflow = useRef(state.workflow.workflowId);
  function reset() {
    session.current += 1; ids.current = 1;
    setMessages([intro()]); setQuestion(null); setAutomation(null); setDestination(null); setInput('');
    copilot.clear(); pendingCommit.current = null; lastCommit.current = null; reviewLock.current = null; watch.current = null; restored.current = null;
    resume.current = null; handover.current = null;
  }
  useEffect(() => {
    const changed = ownerKey !== null && lastOwner.current !== null && ownerKey !== lastOwner.current;
    if (ownerKey !== null) lastOwner.current = ownerKey;
    if (changed) reset();
  }, [ownerKey]);
  useEffect(() => { if (lastEpoch.current !== epoch) { lastEpoch.current = epoch; reset(); } }, [epoch]);
  useEffect(() => {
    // A reopened workflow keeps the conversation, but no open question of the previous workflow.
    if (lastWorkflow.current !== state.workflow.workflowId) { lastWorkflow.current = state.workflow.workflowId; setQuestion(null); pendingCommit.current = null; lastCommit.current = null; }
  }, [state.workflow.workflowId]);

  // A committed chat change is confirmed from the stored workflow once it lands; a refused or superseded commit says so.
  useEffect(() => {
    const commit = pendingCommit.current;
    if (!commit) return;
    const scope = session.current, c = conversationCopy(commit.language);
    if (state.workflow === commit.before) {
      if (state.error) { pendingCommit.current = null; append(scope, { role: commit.role, text: copilotRejection(state.error.split(':')[0]!.trim(), commit.language).message, language: commit.language, notes: commit.notes }); }
      return;
    }
    pendingCommit.current = null;
    if (JSON.stringify(state.workflow) !== JSON.stringify(commit.expected)) { append(scope, { role: commit.role, text: c.invalidated.WORKFLOW_CHANGED, language: commit.language }); return; }
    lastCommit.current = { before: commit.before, expected: state.workflow };
    confirm(scope, commit, state.workflow);
  }, [state]);
  /** FloFi's confirmation of a landed commit, read from the stored workflow, then its next question. */
  function confirm(scope: number, commit: Commit, stored: Workflow) {
    const c = conversationCopy(commit.language), lines = describeChatChange(commit.before, stored, latest.current.context, commit.language);
    append(scope, { role: commit.role, language: commit.language, text: commit.summary ? `${commit.summary}. ${c.positionPrepared}` : lines.join(' '),
      notes: [...commit.notes, ...commit.reviewed ? [c.changed] : []], question: c.nextQuestion, options: commit.summary ? [c.addAnother, c.review] : [c.addAnother, c.review, c.undo] });
    setQuestion({ open: { kind: 'NEXT_STEP', workflowId: stored.workflowId, revision: stored.revision }, language: commit.language });
  }

  function commit(scope: number, command: Command, meta: { exact: boolean; role: 'flofi' | 'ai'; language: ConversationLanguage; notes: readonly string[]; summary?: string }) {
    const now = latest.current, c = conversationCopy(meta.language), before = now.state.workflow;
    const preview = editorReducer(now.state, command, now.context);
    const lost = preview.error ? [] : lostSteps(before, preview.workflow, command, now.context, meta.language);
    if (lost.length) { propose(command); append(scope, { role: meta.role, text: c.destructive(lost.join(', ')), language: meta.language, notes: meta.notes }); return; }
    const result = commitChatCommand(command);
    if (!result.ok) {
      // A refusal sentence (a test network in the public product) is shown as is; an editor code gets the Copilot's existing explanation.
      const text = result.error === 'NO_CHANGE' ? c.noChange : result.error.startsWith('LOCKED_PARAMETER') ? c.locked : / /.test(result.error) && !/^[A-Z_]+:/.test(result.error) ? result.error
        : copilotRejection(result.error.split(':')[0]!.trim(), meta.language).message;
      append(scope, { role: meta.role, text, language: meta.language, notes: meta.notes }); return;
    }
    copilot.committed(command, result.expected, meta.exact);
    setQuestion(null);
    const pending: Commit = { before: result.before, expected: result.expected, role: meta.role, language: meta.language, notes: meta.notes, reviewed: Boolean(now.bridge.authorization.key),
      summary: meta.summary };
    // A position operation on the step the workflow already holds leaves the IR as it is: it only prepares the operation for Simulate.
    if (result.expected === result.before) { lastCommit.current = null; confirm(scope, pending, result.before); return; }
    pendingCommit.current = pending;
  }

  // ── Review ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function presentReview(scope: number, language: ConversationLanguage) {
    const view = latest.current.bridge, c = conversationCopy(language), review = conversationReview(view), binding = reviewBinding(view);
    if (!binding || !review.canConfirm) {
      // A simulation that failed or was refused says why in its own words (a retired earlier Review would only say the workflow changed).
      flofi(scope, language, review.simulationProblem ? c.reviewFailed(translate(language, review.simulationProblem)) : c.reviewNotApprovable(translate(language, review.message)),
        { ...review.steps.length && !review.simulationProblem ? { review } : {}, options: [c.review] });
      return;
    }
    setQuestion({ open: { kind: 'CONFIRM_WORKFLOW', binding }, language });
    const sequence = view.sequence;
    flofi(scope, language, sequence ? c.sequenceReviewReady(sequence.current, sequence.total) : c.reviewReady,
      { review, question: sequence ? c.confirmStep(sequence.current, sequence.total) : c.confirmWorkflow, options: [c.confirmYes, c.confirmNo] });
  }
  function startReview(scope: number, language: ConversationLanguage) {
    const view = latest.current.bridge, c = conversationCopy(language);
    setQuestion(null); resume.current = null;
    if (!actionable(view.workflow)) { flofi(scope, language, c.emptyWorkflow); return; }
    const action = projectCanvasAction(view.controls.current, view.controls);
    if (action.processing || view.source.state.busy) { flofi(scope, language, c.busy); return; }
    // BUILD-FLOFI-CHAT-E2E-FIX-002: an amount typed on a card and never applied blocks every simulation; FloFi names it and asks, never guesses.
    const edit = view.pendingEdits?.[0];
    if (edit && view.resolveEdit) {
      const workflow = latest.current.state.workflow;
      setQuestion({ open: { kind: 'RESOLVE_EDIT', nodeId: edit.nodeId, workflowId: workflow.workflowId, revision: workflow.revision }, language });
      flofi(scope, language, c.editPending(edit.step, translate(language, edit.action), edit.value), { question: c.editQuestion, options: [c.applyEdit, c.discardEdit] });
      return;
    }
    const sequence = view.sequence;
    if (sequence?.finished) { flofi(scope, language, c.workflowCompleted(sequence.total), view.startNewWorkflow ? { options: [c.startNew] } : {}); return; }
    if (sequence?.awaitingDelivery) { flofi(scope, language, c.awaitingDelivery(sequence.current), view.controls.canCheck ? { options: [c.checkStatus] } : {}); return; }
    // The current Review is still approvable (also a fresh Review for the rest of a started run): present it as the Canvas does.
    if (action.kind === 'approve' || action.kind === 'execute') { presentReview(scope, language); return; }
    // Otherwise an execution of this workflow is the financial truth: follow it (recovery stays observation-only), never simulate over it.
    if (currentExecution(view.progress) && action.kind !== 'simulate') { follow(scope, language); return; }
    // The wallet is on another network than the workflow: the existing wallet network request comes first (nothing is simulated on the wrong chain).
    // The existing wallet network switch is offered in the chat; once the wallet reports the step's network, the Review continues by itself.
    if (view.networkAction) {
      if (!view.networkAction.disabled) resume.current = { scope, language, until: 'NETWORK', error: view.networkError ?? null };
      flofi(scope, language, c.switchNetworkFor(view.walletNetwork ?? null, view.networkAction.network ?? view.networkAction.label), view.networkAction.disabled ? {} : { options: [view.networkAction.label] });
      return;
    }
    if (view.simulationBlocked || action.kind !== 'simulate' || action.disabled) {
      const reason = translate(language, view.simulationBlocked ?? action.label);
      const options = !view.wallet.account ? [translate(language, 'Connect wallet')] : [];
      flofi(scope, language, c.reviewBlocked(reason), options.length ? { options } : {});
      return;
    }
    const next = { scope, key: view.authorization.key, sawBusy: false, settled: false, language };
    reviewLock.current = next;
    flofi(scope, language, sequence ? c.stepSimulatingNext(sequence.current) : c.reviewStarting);
    void Promise.resolve().then(view.simulate).catch(() => undefined).finally(() => { if (reviewLock.current === next) { next.settled = true; setTick(n => n + 1); } });
  }
  useEffect(() => {
    const current = reviewLock.current;
    if (!current) return;
    if (bridge.source.state.busy) { current.sawBusy = true; return; }
    if (!current.sawBusy && !current.settled && bridge.authorization.key === current.key) return;
    reviewLock.current = null;
    if (current.scope !== session.current) return;
    presentReview(current.scope, current.language);
  });

  // ── Confirmation, execution and follow-up ──────────────────────────────────────────────────────────────────────────────────────────
  /** Follows the current execution in the chat from its durable record (announcing its phases), and offers only what the record allows. */
  function follow(scope: number, language: ConversationLanguage) {
    const live = currentExecution(latest.current.bridge.progress);
    watch.current = { scope, language, phase: null, runKey: live?.runKey ?? null, continued: null };
    setTick(n => n + 1);
  }
  function execute(scope: number, language: ConversationLanguage, binding: ReviewBinding) {
    const view = latest.current.bridge, c = conversationCopy(language), controls = view.controls;
    setQuestion(null);
    if (currentExecution(view.progress)?.started && !['simulate', 'approve', 'execute'].includes(projectCanvasAction(controls.current, controls).kind)) { follow(scope, language); return; }
    // Re-project at the answer, exactly as the Canvas CTA does at its click: an expired or replaced Review never starts.
    const action = projectCanvasAction(controls.current, controls);
    if (bindingIssue(binding, view) || action.disabled || (action.kind !== 'approve' && action.kind !== 'execute')) {
      flofi(scope, language, c.reviewNotApprovable(translate(language, action.label)), { options: [c.review] }); return;
    }
    flofi(scope, language, c.executing);
    watch.current = { scope, language, phase: null, runKey: null, continued: null };
    controls.authorize();
  }
  function answer(scope: number, open: Question, text: string) {
    const language = open.language, c = conversationCopy(language), verdict = classifyAnswer(text, open.open.kind), view = latest.current.bridge;
    if (open.open.kind === 'NEXT_STEP') return false;
    if (open.open.kind === 'RESOLVE_EDIT') {
      if (verdict === 'UNCLEAR') { flofi(scope, language, c.unclear, { options: [c.applyEdit, c.discardEdit] }); return true; }
      setQuestion(null);
      const refused = view.resolveEdit ? view.resolveEdit(open.open.nodeId, verdict === 'YES') : 'This edit is no longer pending.';
      if (refused) { flofi(scope, language, c.editRefused(translate(language, refused)), { options: [c.review] }); return true; }
      flofi(scope, language, verdict === 'YES' ? c.editApplied : c.editDiscarded);
      resume.current = { scope, language, until: 'EDIT', error: null };
      setTick(n => n + 1);
      return true;
    }
    if (verdict === 'NO') { setQuestion(null); flofi(scope, language, c.declined, { options: [c.review] }); return true; }
    if (verdict === 'UNCLEAR') {
      const options = open.open.kind === 'CONFIRM_WORKFLOW' ? [c.confirmYes, c.confirmNo] : open.open.kind === 'CONFIRM_EXECUTION' ? [c.executeYes, c.executeNo] : [c.continueYes, c.executeNo];
      flofi(scope, language, c.unclear, { options }); return true;
    }
    if (open.open.kind === 'CONFIRM_CONTINUE') {
      // Only the next never-attempted request of this same run, under the authority already accepted: the existing continuation gate decides.
      setQuestion(null);
      const live = currentExecution(view.progress);
      if (!view.controls.canContinue || live?.runKey !== open.open.runKey || live?.fingerprint !== open.open.fingerprint) { follow(scope, language); return true; }
      flofi(scope, language, c.executing);
      view.controls.request(true);
      return true;
    }
    const issue = bindingIssue(open.open.binding, view);
    if (issue) { setQuestion(null); flofi(scope, language, c.invalidated[issue], { options: [c.review] }); return true; }
    if (open.open.kind === 'CONFIRM_WORKFLOW') {
      const review = conversationReview(view);
      setQuestion({ open: { kind: 'CONFIRM_EXECUTION', binding: open.open.binding }, language });
      flofi(scope, language, c.workflowConfirmed(view.workflow.revision, short(open.open.binding.account)), {
        notes: [review.walletRequests.length ? c.walletRequests(review.walletRequests.map(item => translate(language, item)).join(', ')) : c.walletRequestsUnknown],
        question: view.sequence ? c.executeStepQuestion(view.sequence.current, view.sequence.total) : c.executeQuestion, options: [c.executeYes, c.executeNo] });
      return true;
    }
    execute(scope, language, open.open.binding);
    return true;
  }
  function lifecycle(scope: number, request: NonNullable<ReturnType<typeof lifecycleRequest>>, language: ConversationLanguage) {
    const view = latest.current.bridge, c = conversationCopy(language);
    if (request === 'REVIEW') { startReview(scope, language); return; }
    if (request === 'ADD') { setQuestion(null); flofi(scope, language, c.addPrompt); return; }
    if (request === 'UNDO') {
      const done = lastCommit.current && undoChatCommit(lastCommit.current);
      lastCommit.current = null; setQuestion(null);
      if (!done) { flofi(scope, language, c.undoUnavailable); return; }
      const workflow = latest.current.state.workflow;
      setQuestion({ open: { kind: 'NEXT_STEP', workflowId: workflow.workflowId, revision: workflow.revision }, language });
      flofi(scope, language, c.undone, { question: c.nextQuestion, options: [c.addAnother, c.review] }); return;
    }
    const live = currentExecution(view.progress);
    if (request === 'STATUS') {
      if (!live) { flofi(scope, language, c.statusUnavailable); return; }
      if (view.controls.canCheck) { flofi(scope, language, c.statusChecking); view.controls.checkStatus(); }
      follow(scope, language); return;
    }
    // EXECUTE outside its question: execution needs a fresh Review and two explicit answers.
    if (live && !['simulate', 'approve', 'execute'].includes(projectCanvasAction(view.controls.current, view.controls).kind)) { follow(scope, language); return; }
    flofi(scope, language, c.executeNeedsReview, { options: [c.review] });
  }

  // A confirmation that no longer binds (workflow, Review, wallet, network or quote changed) is retired as soon as FloFi sees it.
  useEffect(() => {
    const open = questionRef.current;
    if (open?.open.kind === 'RESOLVE_EDIT') {
      // The owner applied or discarded the edit on the Canvas: the question has nothing left to decide.
      const nodeId = open.open.nodeId;
      if (!bridge.pendingEdits?.some(edit => edit.nodeId === nodeId)) setQuestion(null);
      return;
    }
    if (!open || open.open.kind === 'NEXT_STEP' || open.open.kind === 'CONFIRM_CONTINUE') return;
    const issue = bindingIssue(open.open.binding, bridge);
    if (!issue) return;
    setQuestion(null);
    flofi(session.current, open.language, conversationCopy(open.language).invalidated[issue], { options: [conversationCopy(open.language).review] });
  });
  // Execution follow-up: each phase of the durable record once, and the next wallet request only as its own explicit question.
  useEffect(() => {
    const live = currentExecution(bridge.progress);
    // After a reload, an unresolved run restored from its durable record is announced once; its state is that record's, never this chat's.
    if (!watch.current && live?.restored && !isFinalExecutionResult(live) && restored.current !== live.runKey && direct) {
      restored.current = live.runKey;
      const language = interfaceLanguage, c = conversationCopy(language);
      flofi(session.current, language, c.restored, bridge.controls.canCheck ? { options: [c.checkStatus] } : {});
      watch.current = { scope: session.current, language, phase: null, runKey: live.runKey, continued: null };
    }
    const followed = watch.current;
    if (!followed || followed.scope !== session.current) return;
    const c = conversationCopy(followed.language), language = followed.language;
    if (!live) {
      if (bridge.controls.requestFailed && !bridge.controls.authorizing && !bridge.controls.requesting) { watch.current = null; flofi(followed.scope, language, c.executionStartFailed, { options: [c.review] }); }
      return;
    }
    const view = conversationExecution(bridge)!, phase = view.phase;
    if (phase !== followed.phase) {
      followed.phase = phase; followed.runKey = live.runKey;
      const status = `${translate(language, view.label)}. ${translate(language, view.message)}`;
      if (phase === 'AWAITING_WALLET') flofi(followed.scope, language, translate(language, 'Confirm or decline the reviewed request in your wallet.'));
      else if (phase === 'UNCERTAIN') flofi(followed.scope, language, status, bridge.controls.canCheck ? { options: [c.checkStatus] } : {});
      else if (phase === 'COMPLETED' || phase === 'PARTIAL' || phase === 'FAILED') {
        watch.current = null;
        // BUILD-FLOFI-CHAT-E2E-FIX-002: a completed step of a sequence is not the workflow's result. The next step gets its own fresh Review once
        // the shell records this step's reconciled delivery (`handover`); a step that did not complete stops the sequence there.
        const sequence = bridge.sequence;
        if (sequence && phase === 'COMPLETED' && sequence.current < sequence.total) { handover.current = { scope: followed.scope, language, from: sequence.current, waiting: false }; setTick(n => n + 1); return; }
        if (sequence && phase === 'COMPLETED') { flofi(followed.scope, language, c.workflowCompleted(sequence.total), bridge.startNewWorkflow ? { options: [c.startNew] } : {}); return; }
        flofi(followed.scope, language, status, { ...sequence ? { notes: [c.stepStopped(sequence.current, sequence.total)] } : view.final && bridge.startNewWorkflow ? { notes: [c.finished] } : {},
          ...view.final && bridge.startNewWorkflow ? { options: [c.startNew] } : {} });
        return;
      } else if (phase === 'RECONCILING') flofi(followed.scope, language, translate(language, live.message));
    }
    const continuation = `${live.runKey}:${live.fingerprint}`;
    if (bridge.controls.canContinue && followed.continued !== continuation && !questionRef.current) {
      const binding = reviewBinding(bridge);
      if (!binding) return;
      followed.continued = continuation;
      setQuestion({ open: { kind: 'CONFIRM_CONTINUE', binding, runKey: live.runKey, fingerprint: live.fingerprint }, language });
      flofi(followed.scope, language, c.continueQuestion, { options: [c.continueYes, c.executeNo] });
    }
  });

  // BUILD-FLOFI-CHAT-E2E-FIX-002: the next step of a sequence is simulated (read-only) as soon as the shell recorded the previous step's reconciled
  // delivery; while that delivery is not proven yet, FloFi says so once and waits (observation only, nothing is resent).
  useEffect(() => {
    const next = handover.current, sequence = bridge.sequence;
    if (!next || next.scope !== session.current) return;
    if (!sequence) { handover.current = null; return; }
    const c = conversationCopy(next.language), done = sequence.steps[next.from - 1];
    if (sequence.current > next.from || sequence.finished) {
      handover.current = null;
      flofi(next.scope, next.language, c.stepCompleted(next.from, sequence.total, done?.delivered ?? null));
      if (!sequence.finished) startReview(next.scope, next.language);
      return;
    }
    if (sequence.awaitingDelivery && !next.waiting) { next.waiting = true; flofi(next.scope, next.language, c.awaitingDelivery(next.from), bridge.controls.canCheck ? { options: [c.checkStatus] } : {}); }
  });
  // A Review blocked by the wallet's network or by an unapplied edit continues by itself once that is resolved; a failed switch is reported.
  useEffect(() => {
    const waiting = resume.current;
    if (!waiting || waiting.scope !== session.current) return;
    const c = conversationCopy(waiting.language);
    if (waiting.until === 'NETWORK') {
      if (bridge.networkError && bridge.networkError !== waiting.error) { resume.current = null; flofi(waiting.scope, waiting.language, c.switchFailed(translate(waiting.language, bridge.networkError))); return; }
      if (bridge.networkAction || bridge.source.state.busy) return;
      resume.current = null;
      if (!bridge.wallet.account) return;
      flofi(waiting.scope, waiting.language, c.switched(bridge.walletNetwork ?? ''));
      startReview(waiting.scope, waiting.language);
      return;
    }
    if (bridge.pendingEdits?.length) return;
    resume.current = null;
    startReview(waiting.scope, waiting.language);
  });

  // ── Messages ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const guidance = copilotHelp(copilot.mode) ?? 'This request could not be understood. Check the action, amount, asset and chain, then try again.';
  async function send(raw: string) {
    const text = raw.trim();
    if (!text || copilot.busy || lock.current) return;
    lock.current = true; setSending(true);
    const scope = session.current;
    // The request is shown at once; FloFi's answer follows (catalog reads and interpretation can take a moment).
    append(scope, { role: 'you', text });
    try { await handle(scope, text); } finally { lock.current = false; setSending(false); }
  }
  async function handle(scope: number, text: string) {
    const language = answerLanguage(text, interfaceLanguage), c = conversationCopy(language), open = questionRef.current;
    if (direct) {
      // A new message (other than the offered network switch) replaces a Review the chat was waiting to continue.
      if (!(bridge.networkAction && text === bridge.networkAction.label)) resume.current = null;
      // FloFi's open question takes the answer first; only an explicit answer to it does anything.
      if (open && open.open.kind !== 'NEXT_STEP') { answer(scope, open, text); return; }
      // A bare yes/no does not choose between "add another action" and "review": FloFi asks again, or closes its question.
      const bare = open ? classifyAnswer(text, 'CONFIRM_CONTINUE') : 'UNCLEAR';
      if (open && bare !== 'UNCLEAR') {
        setQuestion(bare === 'NO' ? null : open);
        flofi(scope, open.language, bare === 'NO' ? conversationCopy(open.language).declined : conversationCopy(open.language).nextQuestion,
          bare === 'NO' ? {} : { options: [conversationCopy(open.language).addAnother, conversationCopy(open.language).review] });
        return;
      }
      const request = lifecycleRequest(text);
      if (request) { lifecycle(scope, request, language); return; }
      if (bridge.networkAction && text === bridge.networkAction.label) { bridge.networkAction.request(); return; }
      if (text === translate(language, 'Connect wallet') || text === 'Connect wallet') { bridge.connectWallet(); return; }
      if (text === c.checkStatus) { lifecycle(scope, 'STATUS', language); return; }
      if (text === c.startNew && bridge.startNewWorkflow) { bridge.startNewWorkflow(); return; }
      setQuestion(null);
    }
    // BUILD-RH-002 / BUILD-BASE-001: catalog-network symbols resolve only in validated catalogs; load those the sentence names first.
    if (/\bsolana\b/i.test(text)) {
      const catalog = await loadSolanaAuthoringAssetCatalog();
      if (catalog.ok) registerSolanaDisplayCatalog(catalog.catalog); else clearSolanaDisplayCatalog();
    }
    await Promise.all(catalogNetworksNamed(text).map(network => ensureNetworkCatalog(false, network.chain)));
    if (scope !== session.current) return;
    setAutomation(null);
    const now = latest.current;
    if (text.toLowerCase() === 'explain') {
      dismissProposal();
      // Display the same authored actions as the canvas; the canonical scaffold stays untouched.
      const nodes = now.state.workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
      const summary = nodes.length ? summarize({ ...now.state.workflow, nodes }, now.context) : 'Your flow has no actions yet. Add an action to start building.';
      append(scope, { role: 'system', text: summary });
      return;
    }
    // UX-001: a one-word answer completes the pending exact Send with that destination; anything else starts a new request.
    let request = text;
    if (destination && /^\S+$/.test(text)) {
      const completed = completeSendDestination(destination.request, destination.network, text);
      if (!completed) { append(scope, { role: 'system', text: SEND_DESTINATION_INVALID }); return; }
      request = completed;
    }
    setDestination(null);
    try {
      const command = parseLocalCommand(request, now.state.workflow, now.context, wallet.account);
      const issue = sendDestinationIssue(command, request);
      if (issue) {
        dismissProposal();
        if (issue.kind === 'MISSING') setDestination({ request, network: issue.network });
        append(scope, { role: 'system', text: issue.kind === 'MISSING' ? SEND_DESTINATION_QUESTION : SEND_DESTINATION_INVALID });
        return;
      }
      // BUILD-FLOFI-MAINNET-PRODUCT-001: a test network named in chat is refused in the public product, never moved to a mainnet for the owner.
      const preview = editorReducer(now.state, command, now.context), introduced = preview.error ? [] : introducedTestNetworks(now.state.workflow, preview.workflow, activeNetworkScope());
      if (introduced.length) {
        dismissProposal(); copilot.reset();
        append(scope, { role: 'system', text: testNetworkMessage(introduced) });
        return;
      }
      copilot.reset();
      if (direct) { commit(scope, command, { exact: true, role: 'flofi', language, notes: [] }); return; }
      propose(command);
      append(scope, { role: 'system', text: `Proposal: ${request}. Review against revision ${command.baseRevision} before applying.` });
    } catch {
      // BUILD-COPILOT-002: the Copilot keeps the pending proposal visible while it interprets ("make it 2", questions about it).
      if (copilot.mayInterpret) {
        const reply = await copilot.respond(text);
        if (scope !== session.current) return;
        if (reply?.automation) setAutomation(reply.automation);
        if (!reply) { append(scope, { role: 'system', text: guidance }); return; }
        if (direct && reply.command) {
          const spoken: ConversationLanguage = copilot.language() === 'PT' ? 'PT' : 'EN';
          const read = APPLY_INSTRUCTION.test(reply.text) ? reply.text.replace(APPLY_INSTRUCTION, '')
            : reply.sentence ? spoken === 'PT' ? `Interpretado como “${reply.sentence}”.` : `Interpreted as “${reply.sentence}”.` : null;
          commit(scope, reply.command, { exact: false, role: 'ai', language: spoken, ...reply.command.type === 'MANAGE_SOLANA_POSITION' && read
            ? { summary: read.replace(/\.$/, ''), notes: reply.notes } : { notes: [...read ? [read] : [], ...reply.notes] } });
          return;
        }
        append(scope, { role: 'ai', text: reply.text, notes: reply.notes, options: reply.options });
        return;
      }
      dismissProposal();
      append(scope, { role: 'system', text: guidance });
    }
  }
  const phase = direct ? conversationPhase(bridge, question?.open ?? null, Boolean(destination) || copilot.drafting() || question?.open.kind === 'RESOLVE_EDIT') : null;
  return { messages, input, setInput, send: (text: string) => void send(text), busy: copilot.busy || sending, copilot, automation, dismissAutomation: () => setAutomation(null),
    phase, question: question?.open.kind ?? null, execution: direct ? conversationExecution(bridge) : null, direct };
}
export type FlofiConversation = ReturnType<typeof useFlofiConversation>;
