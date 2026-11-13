// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef, useState } from 'react';
import type { AutomationInput } from '../automations/definition';
import type { WorkflowOwner } from '../domain/saved-workflow';
import { parseLocalCommand, summarize, type Command } from '../domain/commands';
import { editorReducer } from '../domain/editor';
import { activeNetworkScope, introducedTestNetworks, testNetworkTemplate } from '../domain/network-scope';
import { loadSolanaAuthoringAssetCatalog } from '../app/solana-asset-catalog-action';
import { registerSolanaDisplayCatalog, clearSolanaDisplayCatalog } from '../domain/solana-asset-catalog';
import { ensureNetworkCatalog } from './asset-catalog-store';
import { catalogNetworksNamed } from '../domain/network-registry';
import { useWorkflow } from './workflow-store';
import { completeSendDestination, sendDestinationIssue, SEND_DESTINATION_INVALID, SEND_DESTINATION_QUESTION } from '../domain/send-destination';
import { useBuild009Wallet } from './build009-wallet-store';
import { usesFloFiWallet } from '../wallet/flofi-wallet-channel';
import { floFiWalletMessage } from '../wallet/flofi-signing';
import { floFiPrivyWalletIssue, useFloFiPrivy } from '../accounts/privy-context';
import { copilotHelp, useCopilotInterpreter } from '../components/copilot-ai';
import { blockerExplanation, isExplainRequest, type ActiveBlocker } from '../domain/approved-ux';
import { FLOFI_WELCOME_COMMANDS } from '../domain/assistant-welcome';
import { copilotRejection } from '../domain/copilot-authoring';
import { composerActions } from '../domain/composer-presentation';
import { projectCanvasAction } from '../domain/canvas-lifecycle';
import { currentExecution, isFinalExecutionResult } from '../domain/execution-result';
import { STEPS_COMPLETED } from '../domain/workflow-progress';
import { requotedMessage, simulationError } from '../domain/simulation-presentation';
import { translate } from '../i18n/locale';
import type { ExecutionControls } from './execution-controls';
import { conversationCopy } from '../domain/conversation-copy';
import type { ChatContent, ChatMessage, Rendering } from '../domain/chat-message';
import { aboutNextRequest, answerLanguage, bindingIssue, classifyAnswer, continuationReason, conversationExecution, reviewExpired, conversationPhase, conversationReview, describeChatChange, executionContinuation, lifecycleRequest, lostSteps,
  QUOTE_MOVED, reviewBinding, reviewChanges, type ConversationLanguage, type ConversationReview, type LifecycleView, type PendingQuestion, type ReviewBinding } from '../domain/conversation-lifecycle';

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
// P0 hotfix (locale contract): the message shape and its current-language rendering live in `domain/chat-message.ts` (no client state there).
export type { ChatContent, ChatMessage } from '../domain/chat-message';
export { shownMessage } from '../domain/chat-message';
type Copy = ReturnType<typeof conversationCopy>;
export type ConversationBridge = LifecycleView & {
  /**
   * P0 approved UX (board 07): the blocker the Simulate panel shows now (its title, sentence and the server's numbers when it has them). While it is
   * set, a vague request ("explain", "why?", "não entendi", "me explique melhor") is answered with it — never "there is no pending proposal".
   */
  readonly blocker?: ActiveBlocker | null;
  /** P0 approved UX (board 08): this workflow is executing (or its wallet is being asked); the chat changes nothing in it until that ends. */
  readonly editingPaused?: boolean;
  /** The selected runtime's existing simulation entry (the Canvas CTA's), and why no simulation can start now (null: it can). */
  readonly simulate: () => void | Promise<void>; readonly simulationBlocked: string | null;
  /** P0 hotfix (locale contract): the same reason rendered in a given language, so FloFi's message follows the interface language. */
  readonly simulationBlockedIn?: ((language: ConversationLanguage) => string | null) | undefined;
  readonly controls: ExecutionControls;
  readonly networkAction?: { readonly label: string; readonly labelIn?: (language: ConversationLanguage) => string; readonly network?: string; readonly disabled: boolean; request(): void } | undefined;
  readonly connectWallet: () => void; readonly startNewWorkflow?: (() => void) | undefined;
  /**
   * BUILD-FLOFI-CHAT-E2E-FIX-002: amounts typed on Canvas cards and never applied (they block every simulation), and the existing card actions that
   * apply (`apply: true`) or discard one. The returned text is why an apply was refused (nothing changed), else null.
   */
  readonly pendingEdits?: readonly PendingEdit[] | undefined; readonly resolveEdit?: ((nodeId: string, apply: boolean) => string | null) | undefined;
  /** The wallet's current network label, and the last wallet network-switch error (a rejected or failed request). */
  /** P0 hotfix (locale contract): that error as a catalog message and its values, so FloFi's message renders it in either language. */
  readonly networkErrorNotice?: readonly [string, ...string[]] | null | undefined;
  readonly walletNetwork?: string | null | undefined; readonly networkError?: string | null | undefined;
  /** True while a runtime this workflow needs has not answered whether it is available here (unknown, not "unavailable"). */
  readonly runtimeChecking?: boolean | undefined;
  /** BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: executed actions of this workflow still in it, and how many the runtime skips as completed steps. */
  readonly executedActions?: { readonly executed: number; readonly carried: number } | undefined;
  /**
   * Whether this completed workflow can continue as further steps (a finished sequence, or one action whose runtime runs steps): an added action
   * is then its own next step. Otherwise (a composition, a runtime that runs the workflow as a whole) any change is reviewed as a whole again.
   */
  readonly continuable?: boolean | undefined;
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
/** BUILD-FLOFI-E2E-RELIABILITY-001: the public swap run behind the view (its quote binds the owner on owner-bound networks), else null. */
type PublicRunFacts = { readonly quote?: { readonly ownerReview?: unknown } | null; readonly attempts?: readonly { readonly account?: string }[] } | null;
const publicRun = (view: Pick<LifecycleView, 'source'>): PublicRunFacts => view.source.kind === 'public' ? (view.source.state as { run?: PublicRunFacts }).run ?? null : null;
/** Owner-bound networks (Arbitrum One, Ethereum): the swap after an approval is a new owner transaction with its own fresh Review. */
const ownerBoundRun = (view: Pick<LifecycleView, 'source'>) => Boolean(publicRun(view)?.quote?.ownerReview);
/** The wallet whose request of the public run already landed, when it is not the connected one (one run, one wallet). */
function otherRunWallet(view: Pick<LifecycleView, 'source' | 'wallet'>): string | null {
  const account = publicRun(view)?.attempts?.find(attempt => typeof attempt.account === 'string')?.account ?? null;
  return account && view.wallet.account && account.toLowerCase() !== view.wallet.account.toLowerCase() ? account : null;
}

const EDITING_PAUSED = 'Editing is paused while this workflow executes. You can change it once the run finishes or is ended.';
/** The answer buttons FloFi offers for an open question (re-offered when an answer is unclear or an explanation interrupts it). */
function questionOptions(kind: Question['open']['kind'], c: ReturnType<typeof conversationCopy>): string[] {
  return kind === 'RESOLVE_EDIT' ? [c.applyEdit, c.discardEdit] : kind === 'CONFIRM_WORKFLOW' ? [c.confirmYes, c.confirmNo]
    : kind === 'CONFIRM_EXECUTION' ? [c.executeYes, c.executeNo] : kind === 'CONFIRM_CONTINUE_REVIEW' ? [c.continueAccept, c.executeNo] : [c.continueYes, c.executeNo];
}
/** The runtime's in-place re-quote, when its state carries one (Router and universal bridges: BUILD-FLOFI-MAINNET-EXEC-002). */
function requotedOf(state: unknown): { readonly code: string } | null {
  const value = state && typeof state === 'object' ? (state as { readonly requoted?: unknown }).requoted : null;
  return value && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string' ? value as { readonly code: string } : null;
}

export function useFlofiConversation({ owner, epoch, bridge, direct, interfaceLanguage }: {
  owner: WorkflowOwner | null; epoch: number; bridge: ConversationBridge; direct: boolean; interfaceLanguage: ConversationLanguage;
}) {
  const workflow = useWorkflow();
  const { state, context, propose, dismissProposal, commitChatCommand, undoChatCommit } = workflow;
  const wallet = useBuild009Wallet();
  // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: the chat's confirmation checks the FloFi wallet (Privy) can sign in this page, as the Canvas Authorize does.
  const privy = useFloFiPrivy(), privyRef = useRef(privy);
  privyRef.current = privy;
  /**
   * Why the person's FloFi wallet (Privy) cannot sign in this page yet, or null when it can (or another wallet signs). The chat checks it before
   * the first request and before a continuation, as the Canvas checks before Authorize and Continue.
   */
  const floFiWalletRefusal = (account: unknown, language: ConversationLanguage, continuing: boolean): string | null => {
    if (typeof account !== 'string' || !usesFloFiWallet(account)) return null;
    const ecosystem = /^0x/i.test(account) ? 'evm' as const : 'solana' as const;
    if (privyRef.current?.canSign(ecosystem, account)) return null;
    const issue = floFiPrivyWalletIssue(privyRef.current, ecosystem, account), c = conversationCopy(language);
    if (issue === 'FLOFI_WALLET_NOT_READY') return continuing ? c.walletNotReadyToContinue : c.walletNotReady;
    return translate(language, floFiWalletMessage(issue) ?? issue);
  };
  const copilot = useCopilotInterpreter({ direct, interfaceLanguage });
  // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the FloFi Assistant's short welcome (the panel shows the Copilot mode's own variant when one is configured).
  const intro = (): ChatMessage => ({ id: 0, role: 'system', text: direct ? FLOFI_WELCOME_COMMANDS : 'Review each proposed change before applying it.' });
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
  /** BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the workflow FloFi last reported a final completed result for, and whether it continues as steps. */
  const finished = useRef<{ readonly workflowId: string; readonly continuable: boolean } | null>(null);
  const reviewLock = useRef<{ scope: number; key: string | null; sawBusy: boolean; settled: boolean; language: ConversationLanguage; continuation?: boolean } | null>(null);
  /**
   * The execution the chat follows. `start` (BUILD-FLOFI-CHAT-E2E-FIX-002) exists only while the chat's own wallet request is starting: the runtime
   * error it saw then, and whether the authorize/request controls became active, so a start that ends without any execution record is reported.
   */
  const watch = useRef<{ scope: number; language: ConversationLanguage; phase: string | null; runKey: string | null; continued: string | null;
    /** `requoted`: the runtime's in-place re-quote at the start (BUILD-FLOFI-MAINNET-EXEC-002); a different one after it is this start's refusal. */
    start?: { error: string | null; active: boolean; idle: number; requoted?: unknown } | undefined;
    /**
     * BUILD-FLOFI-E2E-RELIABILITY-001: the next wallet request of a run that already has a confirmed one (a continuation), while it starts. A start
     * that ends without a new wallet request is reported with its reason (before, the chat stayed silent and repeated "0 of 1 actions completed").
     */
    continuing?: { error: string | null; cleared: boolean; active: boolean; idle: number; fingerprint: string; requoted?: unknown } | undefined;
    /** The continuation (run and record fingerprint) whose fresh Review FloFi already prepared, so it is never re-offered in a loop. */
    requoted?: string | null | undefined;
    /**
     * Whether FloFi may prepare the next request's fresh Review by itself: only for a continuation the owner started in this conversation
     * (Execute or Continue). A run restored after a reload stays observation-only until the owner asks (“Review workflow”).
     */
    auto?: boolean | undefined } | null>(null);
  const restored = useRef<string | null>(null);
  // BUILD-FLOFI-CHAT-E2E-FIX-002: a Review the chat continues by itself once what blocked it is resolved (the wallet's network switched, an edit
  // applied or discarded), and the sequence step whose completion hands over to the next step's own Review.
  const resume = useRef<{ scope: number; language: ConversationLanguage; until: 'NETWORK' | 'EDIT' | 'READY'; error: string | null } | null>(null);
  const handover = useRef<{ scope: number; language: ConversationLanguage; from: number; waiting: boolean } | null>(null);
  /**
   * BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the last Review the chat presented (to name what a fresh quote changed) and an open re-quote — after the
   * execution boundary refused a changed quote, or the owner asked for a fresh one — whose next Review lists its changes before any confirmation.
   */
  const lastReview = useRef<{ workflowId: string; revision: number; review: ConversationReview } | null>(null);
  const requote = useRef<{ scope: number } | null>(null);
  /** BUILD-FLOFI-E2E-RELIABILITY-001: continuations (run + next request) the owner declined in this conversation: never re-offered by FloFi itself. */
  const declined = useRef<Set<string>>(new Set());
  const setQuestion = (next: Question | null) => { questionRef.current = next; setQuestionState(next); };
  const append = (scope: number, ...list: Omit<ChatMessage, 'id'>[]) => {
    if (scope !== session.current) return;
    setMessages(old => [...old, ...list.map(message => ({ ...message, id: ids.current++ }) as ChatMessage)]);
  };
  /**
   * A deterministic FloFi message, rendered from its copy key and values in both languages (`build` is called once per language with that
   * language's copy), shown in `language` now and in whichever language the interface has later. `fixed` holds what is the same in both
   * (model notes the message carries).
   */
  const say = (scope: number, language: ConversationLanguage, build: (language: ConversationLanguage, c: Copy) => Rendering,
    role: ChatMessage['role'] = 'flofi', fixed: Partial<ChatContent> = {}) => {
    const render = (l: ConversationLanguage): ChatContent => { const out = build(l, conversationCopy(l)); return typeof out === 'string' ? { text: out } : { text: out[0], ...out[1] ?? {} }; };
    const variants = { EN: render('EN'), PT: render('PT') };
    append(scope, { role, ...fixed, ...variants[language], language, variants });
  };
  /** The offered network switch, answered in either language (its label is offered in the language each message is shown in). */
  const offeredNetwork = (text: string) => {
    const offer = bridge.networkAction;
    return Boolean(offer && [offer.label, translate('PT', offer.label), offer.labelIn?.('EN'), offer.labelIn?.('PT')].includes(text));
  };

  // A new owner (another wallet identity) or a new workflow starts a new conversation; a late answer of the previous one is dropped.
  const ownerKey = owner ? `${owner.namespace}:${owner.address}` : null, lastOwner = useRef(ownerKey), lastEpoch = useRef(epoch), lastWorkflow = useRef(state.workflow.workflowId);
  function reset() {
    session.current += 1; ids.current = 1;
    setMessages([intro()]); setQuestion(null); setAutomation(null); setDestination(null); setInput('');
    copilot.clear(); pendingCommit.current = null; lastCommit.current = null; reviewLock.current = null; watch.current = null; restored.current = null;
    resume.current = null; handover.current = null; lastReview.current = null; requote.current = null; declined.current = new Set(); finished.current = null;
  }
  useEffect(() => {
    const changed = ownerKey !== null && lastOwner.current !== null && ownerKey !== lastOwner.current;
    if (ownerKey !== null) lastOwner.current = ownerKey;
    if (changed) reset();
  }, [ownerKey]);
  useEffect(() => { if (lastEpoch.current !== epoch) { lastEpoch.current = epoch; reset(); } }, [epoch]);
  useEffect(() => {
    // A reopened workflow keeps the conversation, but no open question of the previous workflow.
    // BUILD-FLOFI-E2E-RELIABILITY-001: the previous workflow's follow-up (and its permission to re-quote by itself) does not carry over either.
    if (lastWorkflow.current !== state.workflow.workflowId) { lastWorkflow.current = state.workflow.workflowId; setQuestion(null); pendingCommit.current = null; lastCommit.current = null;
      watch.current = null; reviewLock.current = null; requote.current = null; resume.current = null; handover.current = null; finished.current = null; }
  }, [state.workflow.workflowId]);

  // A committed chat change is confirmed from the stored workflow once it lands; a refused or superseded commit says so.
  useEffect(() => {
    const commit = pendingCommit.current;
    if (!commit) return;
    const scope = session.current;
    if (state.workflow === commit.before) {
      if (state.error) { const code = state.error.split(':')[0]!.trim(); pendingCommit.current = null; say(scope, commit.language, language => copilotRejection(code, language).message, commit.role, { notes: commit.notes }); }
      return;
    }
    pendingCommit.current = null;
    if (JSON.stringify(state.workflow) !== JSON.stringify(commit.expected)) { say(scope, commit.language, (_, c) => c.invalidated.WORKFLOW_CHANGED, commit.role); return; }
    lastCommit.current = { before: commit.before, expected: state.workflow };
    confirm(scope, commit, state.workflow);
  }, [state]);
  /** FloFi's confirmation of a landed commit, read from the stored workflow, then its next question. */
  function confirm(scope: number, commit: Commit, stored: Workflow) {
    const context = latest.current.context;
    // BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: after an execution, say whether what already executed stays completed or would be reviewed again.
    const executed = latest.current.bridge.executedActions, whole = finished.current?.workflowId === stored.workflowId && !finished.current.continuable;
    say(scope, commit.language, (language, c) => {
      const history = executed?.executed ? executed.executed > executed.carried ? [c.executedAgain] : [c.executedKept(executed.carried)] : whole ? [c.executedAgain] : [];
      return [commit.summary ? `${commit.summary}. ${c.positionPrepared}` : describeChatChange(commit.before, stored, context, language).join(' '),
        { notes: [...commit.notes, ...commit.reviewed ? [c.changed] : [], ...history], question: c.nextQuestion, options: commit.summary ? [c.addAnother, c.review] : [c.addAnother, c.review, c.undo] }];
    }, commit.role);
    setQuestion({ open: { kind: 'NEXT_STEP', workflowId: stored.workflowId, revision: stored.revision }, language: commit.language });
  }

  /**
   * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: after a final completed result the side chat keeps the workflow open for more work: add another action
   * (it becomes this workflow's next step; what executed is not sent again), modify it, or create a new workflow. Authoring only: nothing is
   * simulated, reviewed or signed until the owner asks, and every later request still needs its own fresh Review and wallet confirmation.
   */
  function offerNextSteps(scope: number, language: ConversationLanguage, result: (language: ConversationLanguage, c: Copy) => readonly [string, readonly string[]], sequence = false) {
    const view = latest.current.bridge, workflow = latest.current.state.workflow;
    // Only a workflow that continues as steps is promised that what executed is not sent again; anything else says it is reviewed as a whole.
    // A sequence's steps are carried by construction (its last step's completion is recorded on the next render).
    const continuable = sequence || view.continuable === true;
    finished.current = { workflowId: workflow.workflowId, continuable };
    setQuestion({ open: { kind: 'NEXT_STEP', workflowId: workflow.workflowId, revision: workflow.revision, executed: true }, language });
    say(scope, language, (language, c) => { const [text, notes] = result(language, c); return [text, { ...notes.length ? { notes } : {}, question: continuable ? c.afterExecution : c.afterExecutionWhole,
      options: [c.addAnother, c.modify, ...view.startNewWorkflow ? [c.startNew] : []] }]; });
  }

  function commit(scope: number, command: Command, meta: { exact: boolean; role: 'flofi' | 'ai'; language: ConversationLanguage; notes: readonly string[]; summary?: string }) {
    const now = latest.current, before = now.state.workflow;
    if (now.bridge.editingPaused) { say(scope, meta.language, language => translate(language, EDITING_PAUSED), meta.role, { notes: meta.notes }); return; }
    const preview = editorReducer(now.state, command, now.context);
    const lost = preview.error ? [] : lostSteps(before, preview.workflow, command, now.context, meta.language);
    if (lost.length) {
      propose(command);
      say(scope, meta.language, (language, c) => c.destructive(lostSteps(before, preview.workflow, command, now.context, language).join(', ')), meta.role, { notes: meta.notes }); return;
    }
    const result = commitChatCommand(command);
    if (!result.ok) {
      // A refusal sentence (a test network in the public product) is shown as is (the interface translates it); an editor code gets the
      // Copilot's existing explanation.
      const error = result.error;
      say(scope, meta.language, (language, c) => error === 'NO_CHANGE' ? c.noChange : error.startsWith('LOCKED_PARAMETER') ? c.locked : / /.test(error) && !/^[A-Z_]+:/.test(error) ? error
        : copilotRejection(error.split(':')[0]!.trim(), language).message, meta.role, { notes: meta.notes }); return;
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
  function presentReview(scope: number, language: ConversationLanguage, continuation = false) {
    const view = latest.current.bridge, review = conversationReview(view), binding = reviewBinding(view);
    if (!binding || !review.canConfirm) {
      // A simulation that failed or was refused says why in its own words (a retired earlier Review would only say the workflow changed).
      const about = (text: string) => currentExecution(view.progress)?.started ? aboutNextRequest(text) : text;
      say(scope, language, (language, c) => [about(review.simulationProblem ? c.reviewFailed(translate(language, review.simulationProblem)) : c.reviewNotApprovable(translate(language, review.message))),
        { ...review.steps.length && !review.simulationProblem ? { review } : {}, options: [c.review] }]);
      return;
    }
    const sequence = view.sequence, workflow = view.workflow, previous = lastReview.current;
    // BUILD-FLOFI-E2E-RELIABILITY-001: the remaining request of a run whose earlier request already landed. The workflow was confirmed already;
    // this fresh Review of the next request alone is accepted with one explicit answer, which also opens the wallet (the binding is checked again).
    const next = continuation ? executionContinuation(view) : null;
    setQuestion(next ? { open: { kind: 'CONFIRM_CONTINUE_REVIEW', binding, runKey: currentExecution(view.progress)?.runKey ?? null }, language }
      : { open: { kind: 'CONFIRM_WORKFLOW', binding }, language });
    // A fresh quote after a refused start (or one the owner asked for) says exactly what changed before it asks again; nothing is reused.
    const requoted = requote.current?.scope === scope && previous?.workflowId === workflow.workflowId && previous.revision === workflow.revision ? previous.review : null;
    requote.current = null;
    lastReview.current = { workflowId: workflow.workflowId, revision: workflow.revision, review };
    const changed = requoted ? reviewChanges(requoted, review) : [];
    // Each change names its field in the message's language, with its values (`{0} {1} → {2}`, never an English label inside Portuguese).
    const notes = (language: ConversationLanguage, c: Copy) => requoted ? { notes: [changed.length
      ? c.quoteChanges(changed.map(change => translate(language, '{0} {1} → {2}', translate(language, change.label), change.before, change.after)).join('; ')) : c.quoteUnchanged] } : {};
    if (next) { say(scope, language, (language, c) => [c.continuationReview(translate(language, next.next)), { review, ...notes(language, c), question: c.continuationQuestion, options: [c.continueAccept, c.executeNo] }]); return; }
    say(scope, language, (language, c) => [sequence ? c.sequenceReviewReady(sequence.current, sequence.total) : c.reviewReady,
      { review, ...notes(language, c), question: sequence ? c.confirmStep(sequence.current, sequence.total) : requoted ? c.confirmUpdated : c.confirmWorkflow, options: [c.confirmYes, c.confirmNo] }]);
  }
  /** P0 hotfix: a finished step-by-step workflow is Completed with every step and what its reconciled record proves it delivered. */
  function completedSequenceText(language: ConversationLanguage, sequence: NonNullable<ConversationBridge['sequence']>): string {
    const c = conversationCopy(language);
    const delivered = sequence.steps.filter(step => step.delivered).map(step => c.stepDelivered(step.number, translate(language, step.action), step.delivered!));
    return [c.workflowCompleted(sequence.total), ...delivered].join(' ');
  }
  /** A run of this workflow is open (not final), its wallet is being asked, or a step-by-step workflow is between its steps. */
  function workflowExecuting(view: ConversationBridge): boolean {
    const live = currentExecution(view.progress), sequence = view.sequence;
    return Boolean(live && !isFinalExecutionResult(live)) || Boolean(view.editingPaused)
      || Boolean(sequence && !sequence.finished && sequence.steps.some(step => step.state === 'COMPLETED'));
  }
  /** Where the executing workflow stands (whole-workflow count and the current step's phase, from durable records) and the next action. */
  function reportProgress(scope: number, language: ConversationLanguage, action: ReturnType<typeof projectCanvasAction>) {
    const view = latest.current.bridge, progress = view.workflowProgress ?? null;
    const step = progress?.steps.find(item => item.current) ?? null;
    const waitingWallet = currentExecution(view.progress)?.steps.some(item => item.operations.some(operation => operation.state === 'wallet'))
      || action.processing && action.label === 'Waiting for wallet…';
    const blocked = view.simulationBlocked, blockedIn = view.simulationBlockedIn, canCheck = view.controls.canCheck;
    const busy = action.processing || view.source.state.busy;
    // P0 hotfix (locale contract): rendered in the message's own language, so a later language switch re-renders it.
    say(scope, language, (language, c) => {
      const where = [progress ? translate(language, STEPS_COMPLETED, progress.completed, progress.total) : null,
        step ? c.stepPhase(step.number, translate(language, step.action), translate(language, step.text.key, ...step.text.args)) : null].filter(Boolean).join(' · ');
      const next = waitingWallet ? c.nextWallet : canCheck || action.kind === 'recover' ? c.nextCheck
        : busy ? c.nextPreparing
        : (action.kind === 'approve' || action.kind === 'execute') && !action.disabled && step ? c.nextAuthorize(step.number)
        : blocked ? blockedIn?.(language) ?? translate(language, blocked) : c.nextObserve;
      return [c.inProgress(where || translate(language, 'Execution in progress'), next), canCheck ? { options: [c.checkStatus] } : {}];
    });
  }
  function startReview(scope: number, language: ConversationLanguage, fresh = false, announced = false) {
    const view = latest.current.bridge;
    setQuestion(null); resume.current = null;
    if (!actionable(view.workflow)) { say(scope, language, (_, c) => c.emptyWorkflow); return; }
    const action = projectCanvasAction(view.controls.current, view.controls);
    // P0 hotfix (execution continuity): while this workflow executes, asking to review or continue says where it stands and what comes next.
    if ((action.processing || view.source.state.busy) && workflowExecuting(view)) { reportProgress(scope, language, action); return; }
    if (action.processing || view.source.state.busy) { say(scope, language, (_, c) => c.busy); return; }
    // BUILD-FLOFI-CHAT-E2E-FIX-002: an amount typed on a card and never applied blocks every simulation; FloFi names it and asks, never guesses.
    const edit = view.pendingEdits?.[0];
    if (edit && view.resolveEdit) {
      const workflow = latest.current.state.workflow;
      setQuestion({ open: { kind: 'RESOLVE_EDIT', nodeId: edit.nodeId, workflowId: workflow.workflowId, revision: workflow.revision }, language });
      say(scope, language, (language, c) => [c.editPending(edit.step, translate(language, edit.action), edit.value), { question: c.editQuestion, options: [c.applyEdit, c.discardEdit] }]);
      return;
    }
    // A runtime's availability that has not answered yet is unknown: FloFi waits and continues by itself instead of calling it unavailable.
    if (view.runtimeChecking) { resume.current = { scope, language, until: 'READY', error: null }; say(scope, language, (_, c) => c.checkingProviders); return; }
    const sequence = view.sequence;
    if (sequence?.finished) { offerNextSteps(scope, language, language => [completedSequenceText(language, sequence), []], true); return; }
    if (sequence?.awaitingDelivery) { say(scope, language, (_, c) => [c.awaitingDelivery(sequence.current), view.controls.canCheck ? { options: [c.checkStatus] } : {}]); return; }
    // The current Review is still approvable (also a fresh Review for the rest of a started run): present it as the Canvas does — unless the owner
    // asked for a fresh quote before anything was requested (BUILD-FLOFI-BRIDGE-LIVE-FIX-003), which re-simulates and retires the unused Review.
    // BUILD-FLOFI-E2E-RELIABILITY-001: a run that already has a confirmed request continues with a Review of its next request only.
    // Only the public swap's same-route re-quote is accepted with one answer; any other runtime's fresh Review keeps both confirmations.
    // Another wallet's run is never continued from this wallet (the runtime then prepares a separate run for it).
    const live = currentExecution(view.progress), nextRequest = live?.started && live.matchesWorkflow !== false ? executionContinuation(view) : null;
    const otherWallet = nextRequest ? otherRunWallet(view) : null;
    const continuation = view.source.kind === 'public' && Boolean(nextRequest) && !otherWallet;
    if (otherWallet) say(scope, language, (_, c) => c.otherWallet(short(otherWallet)));
    // Owner-bound networks: the accepted Review of the approval cannot start the swap (a new owner transaction): its own fresh Review comes first.
    if (continuation && ownerBoundRun(view) && action.kind === 'continue' && !action.disabled) { requoteNext(scope, language, nextRequest!, true); return; }
    // A fresh quote asked for while the accepted, still valid Review can continue: nothing to refresh; the Continue question is asked again.
    if (fresh && continuation && action.kind === 'continue') {
      say(scope, language, (_, c) => c.quoteStillValid); follow(scope, language);
      if (watch.current) watch.current.continued = null;
      return;
    }
    const refresh = fresh && (action.kind === 'approve' || action.kind === 'execute') && !action.disabled && (!live?.started || continuation && action.kind === 'approve');
    if (!refresh && (action.kind === 'approve' || action.kind === 'execute')) { presentReview(scope, language, continuation); return; }
    // Otherwise an execution of this workflow is the financial truth: follow it (recovery stays observation-only), never simulate over it.
    if (currentExecution(view.progress) && action.kind !== 'simulate') { follow(scope, language); return; }
    // The wallet is on another network than the workflow: the existing wallet network request comes first (nothing is simulated on the wrong chain).
    // The existing wallet network switch is offered in the chat; once the wallet reports the step's network, the Review continues by itself.
    if (view.networkAction) {
      if (!view.networkAction.disabled) resume.current = { scope, language, until: 'NETWORK', error: view.networkError ?? null };
      const offer = view.networkAction;
      const offered = (language: ConversationLanguage) => offer.labelIn?.(language) ?? translate(language, offer.label);
      say(scope, language, (language, c) => [c.switchNetworkFor(view.walletNetwork ?? null, offer.network ?? offered(language)), offer.disabled ? {} : { options: [offered(language)] }]);
      return;
    }
    if (view.simulationBlocked || (action.kind !== 'simulate' && !refresh) || action.disabled) {
      // P0 hotfix (production 2026-11-12: "the Assistant said it cannot start Review while the owner was executing"): a workflow that is executing
      // (a run, or a step-by-step workflow between its steps) is described with its status and next action, never refused as a Review.
      if (workflowExecuting(view)) { reportProgress(scope, language, action); return; }
      // Each piece in the message's own language: the blocked reason is a catalog key, never an English sentence inside Portuguese copy.
      const blocked = view.simulationBlocked, label = action.label, blockedIn = view.simulationBlockedIn, connect = !view.wallet.account;
      const reason = (language: ConversationLanguage) => blocked ? blockedIn?.(language) ?? translate(language, blocked) : translate(language, label);
      say(scope, language, (language, c) => [c.reviewBlocked(reason(language)), connect ? { options: [translate(language, 'Connect wallet')] } : {}]);
      return;
    }
    const next = { scope, key: view.authorization.key, sawBusy: false, settled: false, language, continuation };
    reviewLock.current = next;
    if (fresh && lastReview.current) requote.current = { scope };
    if (!continuation) say(scope, language, (_, c) => sequence ? c.stepSimulatingNext(sequence.current) : fresh ? c.refreshing : c.reviewStarting);
    else if (!announced) say(scope, language, (language, c) => c.continuationRefreshing(translate(language, nextRequest!.next)));
    void Promise.resolve().then(view.simulate).catch(() => undefined).finally(() => { if (reviewLock.current === next) { next.settled = true; setTick(n => n + 1); } });
  }
  useEffect(() => {
    const current = reviewLock.current;
    if (!current) return;
    if (bridge.source.state.busy) { current.sawBusy = true; return; }
    if (!current.sawBusy && !current.settled && bridge.authorization.key === current.key) return;
    reviewLock.current = null;
    if (current.scope !== session.current) return;
    presentReview(current.scope, current.language, current.continuation);
  });

  // ── Confirmation, execution and follow-up ──────────────────────────────────────────────────────────────────────────────────────────
  /** Follows the current execution in the chat from its durable record (announcing its phases), and offers only what the record allows. */
  function follow(scope: number, language: ConversationLanguage, auto = false) {
    const live = currentExecution(latest.current.bridge.progress), previous = watch.current;
    // Following the same run again (a status check, a closed question) keeps what this conversation already did with it: the continuation it
    // asked about, the fresh Review it prepared, and whether the owner started it here.
    const same = Boolean(previous && previous.scope === scope && previous.runKey !== null && previous.runKey === (live?.runKey ?? null));
    watch.current = { scope, language, phase: null, runKey: live?.runKey ?? null, continued: same ? previous!.continued : null, auto: auto || Boolean(same && previous!.auto),
      requoted: same ? previous!.requoted : undefined };
    setTick(n => n + 1);
  }
  /** The next request's own fresh Review, read-only (the runtime re-quotes the remaining request of the same run), then one question. */
  function requoteNext(scope: number, language: ConversationLanguage, next: NonNullable<ReturnType<typeof executionContinuation>>, ownerBound: boolean) {
    const view = latest.current.bridge;
    const lock = { scope, key: view.authorization.key, sawBusy: false, settled: false, language, continuation: true };
    reviewLock.current = lock;
    if (lastReview.current) requote.current = { scope };
    say(scope, language, (language, c) => ownerBound ? c.ownerBoundNext(translate(language, next.done), translate(language, next.next)) : c.continuationRefreshing(translate(language, next.next)));
    void Promise.resolve().then(view.simulate).catch(() => undefined).finally(() => { if (reviewLock.current === lock) { lock.settled = true; setTick(n => n + 1); } });
  }
  function execute(scope: number, language: ConversationLanguage, binding: ReviewBinding) {
    const view = latest.current.bridge, controls = view.controls;
    setQuestion(null);
    if (currentExecution(view.progress)?.started && !['simulate', 'approve', 'execute'].includes(projectCanvasAction(controls.current, controls).kind)) { follow(scope, language); return; }
    // Re-project at the answer, exactly as the Canvas CTA does at its click: an expired or replaced Review never starts.
    const action = projectCanvasAction(controls.current, controls);
    if (bindingIssue(binding, view) || action.disabled || (action.kind !== 'approve' && action.kind !== 'execute')) {
      say(scope, language, (language, c) => [c.reviewNotApprovable(translate(language, action.label)), { options: [c.review] }]); return;
    }
    // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: FloFi says it is preparing the wallet request only once an authorization or request actually began; a start
    // the controls refuse at once says why, and nothing claims a wallet request that never opened.
    // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: when the person's FloFi wallet (Privy) will sign, the chat accepts the Review only once Privy can sign with
    // it here — the same check as the Canvas Authorize — so no short-lived Review is accepted, begun or claimed for a wallet that cannot show it.
    // BUILD-FLOFI-E2E-RELIABILITY-001: once a request of this run landed, a refusal concerns the next request only (never "nothing was sent").
    const notStarted = (c: Copy, reason: string) => currentExecution(view.progress)?.started ? c.continueFailed(aboutNextRequest(reason)) : c.executionNotStarted(reason);
    const account = view.wallet.account;
    if (floFiWalletRefusal(account, language, false)) { say(scope, language, (language, c) => [notStarted(c, floFiWalletRefusal(account, language, false) ?? ''), { options: [c.review] }]); return; }
    const startError = view.source.state.error, startRequote = requotedOf(view.source.state), started = controls.authorize();
    if (!started.started) {
      const issue = started.issue ?? 'Execution cannot begin with the current wallet or execution state. Check this workflow\'s simulation.';
      say(scope, language, (language, c) => [notStarted(c, translate(language, issue)), { options: [c.review] }]); return;
    }
    say(scope, language, (_, c) => c.executing);
    const live = currentExecution(view.progress);
    watch.current = live?.started
      ? { scope, language, phase: null, runKey: live.runKey, continued: null, requoted: watch.current?.requoted, auto: true,
        continuing: { error: startError, cleared: startError === null, active: false, idle: 0, fingerprint: live.fingerprint, requoted: startRequote } }
      : { scope, language, phase: null, runKey: null, continued: null, auto: true, start: { error: startError, active: false, idle: 0, requoted: startRequote } };
  }
  function answer(scope: number, open: Question, text: string) {
    const language = open.language, verdict = classifyAnswer(text, open.open.kind), view = latest.current.bridge;
    if (open.open.kind === 'NEXT_STEP') return false;
    if (open.open.kind === 'RESOLVE_EDIT') {
      if (verdict === 'UNCLEAR') { say(scope, language, (_, c) => [c.unclear, { options: [c.applyEdit, c.discardEdit] }]); return true; }
      setQuestion(null);
      const refused = view.resolveEdit ? view.resolveEdit(open.open.nodeId, verdict === 'YES') : 'This edit is no longer pending.';
      if (refused) { say(scope, language, (language, c) => [c.editRefused(translate(language, refused)), { options: [c.review] }]); return true; }
      say(scope, language, (_, c) => verdict === 'YES' ? c.editApplied : c.editDiscarded);
      resume.current = { scope, language, until: 'EDIT', error: null };
      setTick(n => n + 1);
      return true;
    }
    if (verdict === 'NO') {
      setQuestion(null);
      // A run with a confirmed request is never described as "nothing was sent": only the next request was not.
      const started = Boolean(currentExecution(view.progress)?.started), next = started ? executionContinuation(view) : null;
      if (next) declined.current.add(next.key);
      say(scope, language, (language, c) => [started ? c.continueFailed(translate(language, 'You chose not to continue now.')) : c.declined, { options: [c.review] }]); return true;
    }
    const kind = open.open.kind;
    if (verdict === 'UNCLEAR') { say(scope, language, (_, c) => [c.unclear, { options: questionOptions(kind, c) }]); return true; }
    if (open.open.kind === 'CONFIRM_CONTINUE') {
      // Only the next never-attempted request of this same run, under the authority already accepted: the existing continuation gate decides.
      setQuestion(null);
      const live = currentExecution(view.progress);
      if (!view.controls.canContinue || live?.runKey !== open.open.runKey || live?.fingerprint !== open.open.fingerprint) { follow(scope, language, true); return true; }
      // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: the same FloFi wallet check as the first request; the question stays open to answer again.
      const account = view.wallet.account;
      if (floFiWalletRefusal(account, language, true)) {
        setQuestion(open); say(scope, language, (language, c) => [c.continueFailed(floFiWalletRefusal(account, language, true) ?? ''), { options: [c.continueYes, c.executeNo] }]); return true;
      }
      say(scope, language, (_, c) => c.executing);
      const followed = watch.current?.scope === scope ? watch.current : null, startError = view.source.state.error;
      watch.current = { scope, language, phase: followed?.phase ?? null, runKey: live?.runKey ?? null, continued: followed?.continued ?? null, requoted: followed?.requoted, auto: true,
        continuing: { error: startError, cleared: startError === null, active: false, idle: 0, fingerprint: live?.fingerprint ?? '', requoted: requotedOf(view.source.state) } };
      view.controls.request(true);
      return true;
    }
    const issue = bindingIssue(open.open.binding, view);
    if (issue) { setQuestion(null); say(scope, language, (_, c) => [c.invalidated[issue], { options: [c.review] }]); return true; }
    if (open.open.kind === 'CONFIRM_CONTINUE_REVIEW') {
      // The fresh Review belongs to one run: an answer after that run was replaced (another execution record) starts nothing.
      if (currentExecution(view.progress)?.runKey !== open.open.runKey) { setQuestion(null); say(scope, language, (_, c) => [c.invalidated.REVIEW_REPLACED, { options: [c.review] }]); return true; }
      execute(scope, language, open.open.binding); return true;
    }
    if (open.open.kind === 'CONFIRM_WORKFLOW') {
      const review = conversationReview(view);
      setQuestion({ open: { kind: 'CONFIRM_EXECUTION', binding: open.open.binding }, language });
      const account = short(open.open.binding.account), sequence = view.sequence, revision = view.workflow.revision;
      say(scope, language, (language, c) => [c.workflowConfirmed(revision, account), {
        notes: [review.walletRequests.length ? c.walletRequests(review.walletRequests.map(item => translate(language, item)).join(', ')) : c.walletRequestsUnknown,
          ...review.approvals.length || review.walletRequests.some(item => /^Approve\b/.test(item)) ? [c.approvalIfNeeded] : [],
          ...review.providerSteps.length ? [c.providerSettles(review.providerSteps.map(item => translate(language, item).toLowerCase()).join(', '))] : []],
        question: sequence ? c.executeStepQuestion(sequence.current, sequence.total) : c.executeQuestion, options: [c.executeYes, c.executeNo] }]);
      return true;
    }
    execute(scope, language, open.open.binding);
    return true;
  }
  function lifecycle(scope: number, request: NonNullable<ReturnType<typeof lifecycleRequest>>, language: ConversationLanguage) {
    const view = latest.current.bridge;
    if (request === 'REVIEW') { startReview(scope, language); return; }
    if (request === 'REFRESH') { startReview(scope, language, true); return; }
    if (request === 'ROUTE') { say(scope, language, (_, c) => c.anotherRoute); startReview(scope, language, true); return; }
    if (request === 'ADD') { setQuestion(null); say(scope, language, (_, c) => c.addPrompt); return; }
    if (request === 'MODIFY') {
      setQuestion(null);
      const empty = !actionable(latest.current.state.workflow), interprets = copilot.mayInterpret;
      say(scope, language, (_, c) => empty ? c.emptyWorkflow : interprets ? c.modifyPrompt : c.modifyOnCanvas); return;
    }
    if (request === 'UNDO') {
      const done = lastCommit.current && undoChatCommit(lastCommit.current);
      lastCommit.current = null; setQuestion(null);
      if (!done) { say(scope, language, (_, c) => c.undoUnavailable); return; }
      const workflow = latest.current.state.workflow;
      setQuestion({ open: { kind: 'NEXT_STEP', workflowId: workflow.workflowId, revision: workflow.revision }, language });
      say(scope, language, (_, c) => [c.undone, { question: c.nextQuestion, options: [c.addAnother, c.review] }]); return;
    }
    const live = currentExecution(view.progress);
    if (request === 'STATUS') {
      if (!live) { say(scope, language, (_, c) => c.statusUnavailable); return; }
      if (view.controls.canCheck) { say(scope, language, (_, c) => c.statusChecking); view.controls.checkStatus(); }
      follow(scope, language); return;
    }
    // EXECUTE outside its question: execution needs a fresh Review and two explicit answers.
    if (live && !['simulate', 'approve', 'execute'].includes(projectCanvasAction(view.controls.current, view.controls).kind)) { follow(scope, language); return; }
    say(scope, language, (_, c) => [c.executeNeedsReview, { options: [c.review] }]);
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
    if (!open || open.open.kind === 'NEXT_STEP') return;
    if (open.open.kind === 'CONFIRM_CONTINUE') {
      // BUILD-FLOFI-E2E-RELIABILITY-001: a Continue whose binding no longer holds (quote expired, wallet or network changed) is retired too.
      // An expired quote of a continuation the owner started here is re-quoted once by the follow-up (which says so); otherwise FloFi says why.
      if (bridge.controls.requesting || watch.current?.continuing) return;
      const lapsed = bindingIssue(open.open.binding, bridge);
      if (!lapsed) return;
      setQuestion(null);
      if (!(watch.current?.auto && lapsed === 'QUOTE_EXPIRED' && bridge.source.kind === 'public'))
        say(session.current, open.language, (_, c) => [c.invalidated[lapsed], { options: [c.review] }]);
      setTick(n => n + 1);
      return;
    }
    const issue = bindingIssue(open.open.binding, bridge);
    if (!issue) return;
    setQuestion(null);
    // P0 hotfix (execution continuity): the owner already authorized this Review in Execute and its run started, or the whole workflow completed:
    // the question was answered by that action. It closes quietly — never a "no longer valid / review again" message about a step that ran.
    if (bridge.sequence?.finished || bridge.authorization.accepted && currentExecution(bridge.progress)?.started) return;
    say(session.current, open.language, (_, c) => [c.invalidated[issue], { options: [c.review] }]);
  });
  // Execution follow-up: each phase of the durable record once, and the next wallet request only as its own explicit question.
  useEffect(() => {
    const live = currentExecution(bridge.progress);
    // After a reload, an unresolved run restored from its durable record is announced once; its state is that record's, never this chat's.
    if (!watch.current && live?.restored && !isFinalExecutionResult(live) && restored.current !== live.runKey && direct) {
      restored.current = live.runKey;
      const language = interfaceLanguage, check = bridge.controls.canCheck;
      say(session.current, language, (_, c) => [c.restored, check ? { options: [c.checkStatus] } : {}]);
      watch.current = { scope: session.current, language, phase: null, runKey: live.runKey, continued: null };
    }
    const followed = watch.current;
    if (!followed || followed.scope !== session.current) return;
    const language = followed.language, check = bridge.controls.canCheck;
    if (!live) {
      const start = followed.start, active = bridge.controls.authorizing || bridge.controls.requesting || Boolean(bridge.source.state.busy);
      if (start && active) { start.active = true; start.idle = 0; return; }
      // BUILD-FLOFI-CHAT-E2E-FIX-002: a start that ends with no execution record — a refused request (some runtimes keep the failure as their own
      // error, e.g. a balance too low) or an authorization that could not begin — is reported with the runtime's classified reason, never left
      // as "opening the wallet request". Nothing was sent: there is no execution record.
      const error = bridge.source.state.error, newError = Boolean(error) && error !== start?.error;
      const ended = !active && (bridge.controls.requestFailed || newError || Boolean(start && start.active) || Boolean(start && ++start.idle > 1));
      if (ended && (start || bridge.controls.requestFailed)) {
        watch.current = null;
        // BUILD-FLOFI-MAINNET-EXEC-002 (review P1): the runtime already re-quoted this run in place (nothing was sent): FloFi says why once and
        // presents that fresh Review with what changed — it never simulates again over it, and the owner confirms it again.
        const rq = requotedOf(bridge.source.state);
        if (rq && rq !== start?.requoted) {
          say(followed.scope, language, language => translate(language, requotedMessage(rq.code)));
          requote.current = { scope: followed.scope };
          startReview(followed.scope, language);
          return;
        }
        // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a quote or state the execution boundary found changed (or expired) after the Review is re-quoted at once;
        // the fresh Review names its changes and needs its own confirmations. Nothing was sent, and the earlier run stays on record.
        if (error && newError && QUOTE_MOVED.test(error)) {
          say(followed.scope, language, (language, c) => c.quoteMoved(translate(language, simulationError(error))));
          requote.current = { scope: followed.scope };
          startReview(followed.scope, language);
          return;
        }
        const why = error && (newError || bridge.controls.requestFailed) ? simulationError(error) : bridge.controls.startIssue ?? null;
        say(followed.scope, language, (language, c) => [why ? `${c.executionStartFailed} ${translate(language, why)}` : c.executionStartFailed, { options: [c.review] }]);
      } else if (start && !active) setTick(n => n + 1);
      return;
    }
    if (followed.start) followed.start = undefined;
    // BUILD-FLOFI-E2E-RELIABILITY-001: a continuation that ends without a new wallet request (the record's operations did not move) is reported
    // with its reason; a quote that moved or expired is re-quoted at once for the next request only. Nothing is resent, and the earlier
    // confirmed request is never described as "nothing was sent".
    // Another run than the one this follow-up began with: what was done for that run (and the permission to re-quote by itself) does not apply.
    if (followed.runKey && live.runKey && followed.runKey !== live.runKey) { followed.auto = false; followed.requoted = undefined; followed.continued = null; followed.runKey = live.runKey; }
    const going = followed.continuing;
    if (going) {
      const error = bridge.source.state.error, active = bridge.controls.authorizing || bridge.controls.requesting || Boolean(bridge.source.state.busy);
      if (error === null) going.cleared = true;
      if (live.fingerprint !== going.fingerprint) followed.continuing = undefined;
      else if (active) { going.active = true; going.idle = 0; return; }
      else {
        const newError = Boolean(error) && (going.cleared || error !== going.error);
        if (bridge.controls.requestFailed || newError || going.active || ++going.idle > 1) {
          followed.continuing = undefined;
          followed.requoted = executionContinuation(bridge)?.key ?? `${live.runKey}:${live.fingerprint}`;
          // The next request was re-quoted in place by the runtime (nothing new was sent): its fresh Review is presented, never simulated again.
          const rq = requotedOf(bridge.source.state);
          if (rq && rq !== going.requoted) {
            say(followed.scope, language, (language, c) => `${c.earlierRequestStays} ${translate(language, requotedMessage(rq.code))}`);
            requote.current = { scope: followed.scope };
            startReview(followed.scope, language, false, true);
            return;
          }
          if (error && newError && QUOTE_MOVED.test(error)) {
            const why = continuationReason(error);
            say(followed.scope, language, (language, c) => c.continuationRequote(why ? translate(language, why) : null));
            requote.current = { scope: followed.scope };
            startReview(followed.scope, language, false, true);
            return;
          }
          const why = error && (newError || bridge.controls.requestFailed) ? simulationError(error) : bridge.controls.startIssue ?? null;
          say(followed.scope, language, (language, c) => [c.continueFailed(why ? aboutNextRequest(translate(language, why)) : check ? c.checkThenContinue : c.reviewToContinue),
            { options: check ? [c.checkStatus] : [c.review] }]);
          return;
        }
        setTick(n => n + 1);
        return;
      }
    }
    const view = conversationExecution(bridge)!, phase = view.phase;
    if (phase !== followed.phase) {
      followed.phase = phase; followed.runKey = live.runKey;
      // P0 hotfix (one progress truth): in a step-by-step workflow the run covers one step, so its own count ("0 of 1 actions completed") is
      // replaced by the whole workflow's ("1 of 2 steps completed"), the numbers Execute and the Dashboard show. Each piece is translated in the
      // message's own language and joined as `{0}. {1}` (never an English label inside Portuguese).
      const whole = bridge.sequence && bridge.workflowProgress ? bridge.workflowProgress : null;
      const status = (language: ConversationLanguage) => whole && (phase === 'EXECUTING' || phase === 'RECONCILING' || phase === 'COMPLETED')
        ? translate(language, '{0}. {1}', translate(language, view.label), `${translate(language, STEPS_COMPLETED, whole.completed, whole.total)}.`)
        : translate(language, '{0}. {1}', translate(language, view.label), translate(language, view.message));
      if (phase === 'AWAITING_WALLET') say(followed.scope, language, language => translate(language, 'Confirm or decline the reviewed request in your wallet.'));
      else if (phase === 'UNCERTAIN') say(followed.scope, language, (language, c) => [status(language), check ? { options: [c.checkStatus] } : {}]);
      else if (phase === 'COMPLETED' || phase === 'PARTIAL' || phase === 'FAILED') {
        watch.current = null;
        // BUILD-FLOFI-CHAT-E2E-FIX-002: a completed step of a sequence is not the workflow's result. The next step gets its own fresh Review once
        // the shell records this step's reconciled delivery (`handover`); a step that did not complete stops the sequence there.
        const sequence = bridge.sequence;
        if (sequence && phase === 'COMPLETED' && sequence.current < sequence.total) { handover.current = { scope: followed.scope, language, from: sequence.current, waiting: false }; setTick(n => n + 1); return; }
        if (sequence && phase === 'COMPLETED') { offerNextSteps(followed.scope, language, language => [completedSequenceText(language, sequence), []], true); return; }
        if (!sequence && phase === 'COMPLETED' && view.final) { offerNextSteps(followed.scope, language, (language, c) => [status(language), [c.finished]]); return; }
        const startNew = view.final && Boolean(bridge.startNewWorkflow);
        say(followed.scope, language, (language, c) => [status(language), { ...sequence ? { notes: [c.stepStopped(sequence.current, sequence.total)] } : startNew ? { notes: [c.finished] } : {},
          ...startNew ? { options: [c.startNew] } : {} }]);
        return;
      } else if (phase === 'RECONCILING') {
        if (whole) say(followed.scope, language, language => status(language));
        else { const message = live.message; say(followed.scope, language, language => translate(language, message)); }
      }
    }
    const continuation = `${live.runKey}:${live.fingerprint}`, next = executionContinuation(bridge);
    // Owner-bound networks: a Continue under the approval's Review can never start the swap, so it is not offered; the swap's own fresh Review
    // is prepared once (read-only) for a continuation the owner started here, and asked with one question.
    const ownerBoundNext = Boolean(next && ownerBoundRun(bridge));
    if (ownerBoundNext && bridge.controls.canContinue && !questionRef.current && !reviewLock.current && followed.auto && followed.requoted !== next!.key &&
        !declined.current.has(next!.key) && !bridge.source.state.busy && !bridge.controls.requesting && !otherRunWallet(bridge)) {
      followed.requoted = next!.key; requoteNext(followed.scope, language, next!, true);
      return;
    }
    if (!ownerBoundNext && bridge.controls.canContinue && followed.continued !== continuation && !questionRef.current && !(next && declined.current.has(next.key))) {
      const binding = reviewBinding(bridge);
      if (!binding) return;
      followed.continued = continuation;
      setQuestion({ open: { kind: 'CONFIRM_CONTINUE', binding, runKey: live.runKey, fingerprint: live.fingerprint }, language });
      // BUILD-FLOFI-E2E-RELIABILITY-001: name what landed (an approval is never the action itself) and what has not been sent yet.
      say(followed.scope, language, (language, c) => [next ? c.continueAfter(translate(language, next.done), translate(language, next.next), next.approval) : c.continueQuestion,
        { options: [c.continueYes, c.executeNo] }]);
      return;
    }
    // BUILD-FLOFI-E2E-RELIABILITY-001: the earlier request landed but its Review can no longer start the next one (the quote expired while the
    // approval confirmed, or a fresh quote awaits its Review). FloFi prepares the next request's own fresh Review once (read-only) and asks once;
    // it never re-offers the same continuation after the owner declined it, and never repeats the landed request.
    if (bridge.source.kind === 'public' && followed.auto && next && live.state === 'active' && live.matchesWorkflow !== false && !bridge.controls.canContinue &&
        !questionRef.current && !reviewLock.current && followed.requoted !== next.key && !declined.current.has(next.key) &&
        !bridge.source.state.busy && !bridge.controls.requesting && !bridge.controls.authorizing) {
      const action = projectCanvasAction(bridge.controls.current, bridge.controls);
      if ((action.kind === 'simulate' || action.kind === 'approve') && !action.disabled) {
        followed.requoted = next.key;
        const expired = reviewExpired(bridge);
        if (action.kind === 'simulate') say(followed.scope, language, (language, c) => c.continuationRequote(expired ? translate(language, continuationReason('QUOTE_EXPIRED')!) : null));
        requote.current = { scope: followed.scope };
        startReview(followed.scope, language, false, true);
      }
    }
  });

  // BUILD-FLOFI-CHAT-E2E-FIX-002: the next step of a sequence is simulated (read-only) as soon as the shell recorded the previous step's reconciled
  // delivery; while that delivery is not proven yet, FloFi says so once and waits (observation only, nothing is resent).
  useEffect(() => {
    const next = handover.current, sequence = bridge.sequence;
    if (!next || next.scope !== session.current) return;
    if (!sequence) { handover.current = null; return; }
    const done = sequence.steps[next.from - 1], from = next.from;
    if (sequence.current > next.from || sequence.finished) {
      handover.current = null;
      say(next.scope, next.language, (_, c) => c.stepCompleted(from, sequence.total, done?.delivered ?? null));
      // P0 hotfix (execution continuity): the shell may already be simulating the next step (read-only, in Execute): its Review is presented
      // here once that simulation settles, never a second simulation and never "still working on the previous step".
      if (!sequence.finished && bridge.source.state.busy) {
        reviewLock.current = { scope: next.scope, key: bridge.authorization.key, sawBusy: true, settled: false, language: next.language, continuation: false };
        say(next.scope, next.language, (_, c) => c.stepSimulatingNext(sequence.current));
      } else if (!sequence.finished) startReview(next.scope, next.language);
      return;
    }
    if (sequence.awaitingDelivery && !next.waiting) { next.waiting = true; const check = bridge.controls.canCheck; say(next.scope, next.language, (_, c) => [c.awaitingDelivery(from), check ? { options: [c.checkStatus] } : {}]); }
  });
  // A Review blocked by the wallet's network or by an unapplied edit continues by itself once that is resolved; a failed switch is reported.
  useEffect(() => {
    const waiting = resume.current;
    if (!waiting || waiting.scope !== session.current) return;
    if (waiting.until === 'NETWORK') {
      const failed = bridge.networkError, notice = bridge.networkErrorNotice;
      if (failed && failed !== waiting.error) { resume.current = null; say(waiting.scope, waiting.language, (language, c) => c.switchFailed(notice ? translate(language, ...notice) : translate(language, failed))); return; }
      if (bridge.networkAction || bridge.source.state.busy) return;
      resume.current = null;
      if (!bridge.wallet.account) return;
      const network = bridge.walletNetwork ?? '';
      say(waiting.scope, waiting.language, (_, c) => c.switched(network));
      startReview(waiting.scope, waiting.language);
      return;
    }
    if (waiting.until === 'READY' ? bridge.runtimeChecking : bridge.pendingEdits?.length) return;
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
    const language = answerLanguage(text, interfaceLanguage), open = questionRef.current;
    if (direct) {
      // P0 approved UX (board 07): while a blocker is active, "explain / why? / não entendi" explains THAT blocker, with the same facts as the panel.
      // It changes nothing else: an open question keeps its answer buttons, a promised auto-continue stays promised, and a clarification the model
      // is drafting still receives the message. A run whose request already landed is never told "nothing was sent": only this request was not.
      if (bridge.blocker && isExplainRequest(text) && !copilot.drafting()) {
        const blocker = bridge.blocker, facts = blockerExplanation(blocker), started = Boolean(blocker.started || currentExecution(latest.current.bridge.progress)?.started);
        // The blocker's title and sentence are catalog keys, each translated and joined as `{0}: {1}` (never an English piece in Portuguese).
        const said = (language: ConversationLanguage) => facts ? translate(language, facts.text, ...facts.parameters.map(value => translate(language, value)))
          : translate(language, '{0}: {1}', translate(language, blocker.title), blocker.messageIn?.(language) ?? translate(language, blocker.message));
        const kind = open && open.open.kind !== 'NEXT_STEP' ? open.open.kind : null;
        say(scope, language, (language, c) => [started ? aboutNextRequest(said(language)) : said(language), kind ? { options: questionOptions(kind, c) } : {}]);
        return;
      }
      // A new message (other than the offered network switch) replaces a Review the chat was waiting to continue.
      if (!offeredNetwork(text)) resume.current = null;
      // FloFi's open question takes the answer first; only an explicit answer to it does anything. BUILD-FLOFI-BRIDGE-LIVE-FIX-003: asking for a
      // fresh quote or another route instead closes the question (nothing was confirmed) and re-simulates.
      const recovery = open && open.open.kind !== 'NEXT_STEP' ? lifecycleRequest(text) : null;
      if (open && (recovery === 'REFRESH' || recovery === 'ROUTE')) { setQuestion(null); lifecycle(scope, recovery, language); return; }
      if (open && open.open.kind !== 'NEXT_STEP') { answer(scope, open, text); return; }
      // P0 hotfix (execution continuity): "continue" while this workflow executes asks where it stands (never a bare yes to "add or review").
      if (open?.open.kind === 'NEXT_STEP' && lifecycleRequest(text) === 'REVIEW' && workflowExecuting(bridge)) { setQuestion(null); lifecycle(scope, 'REVIEW', language); return; }
      // A bare yes/no does not choose between "add another action" and "review": FloFi asks again, or closes its question.
      const bare = open ? classifyAnswer(text, 'CONFIRM_CONTINUE') : 'UNCLEAR';
      if (open && bare !== 'UNCLEAR') {
        setQuestion(bare === 'NO' ? null : open);
        const executed = open.open.kind === 'NEXT_STEP' && Boolean(open.open.executed), continuable = Boolean(finished.current?.continuable), startNew = Boolean(bridge.startNewWorkflow);
        if (bare !== 'NO' && executed) {
          say(scope, open.language, (_, asked) => [continuable ? asked.afterExecution : asked.afterExecutionWhole,
            { options: [asked.addAnother, asked.modify, ...startNew ? [asked.startNew] : []] }]);
          return;
        }
        say(scope, open.language, (_, asked) => [bare === 'NO' ? executed ? asked.closedAfterExecution : asked.declined : asked.nextQuestion,
          bare === 'NO' ? {} : { options: [asked.addAnother, asked.review] }]);
        return;
      }
      const request = lifecycleRequest(text);
      if (request) { lifecycle(scope, request, language); return; }
      if (bridge.networkAction && offeredNetwork(text)) { bridge.networkAction.request(); return; }
      // Offered options are matched in either language (the interface language may have changed since they were offered).
      if (text === translate('PT', 'Connect wallet') || text === 'Connect wallet') { bridge.connectWallet(); return; }
      if (text === conversationCopy('EN').checkStatus || text === conversationCopy('PT').checkStatus) { lifecycle(scope, 'STATUS', language); return; }
      // The option is matched in either language: its label carries no word that tells the reply language.
      if ((text === conversationCopy('EN').startNew || text === conversationCopy('PT').startNew) && bridge.startNewWorkflow) { bridge.startNewWorkflow(); return; }
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
        const [template, ...values] = testNetworkTemplate(introduced);
        append(scope, { role: 'system', text: template, params: values });
        return;
      }
      copilot.reset();
      if (direct) { commit(scope, command, { exact: true, role: 'flofi', language, notes: [] }); return; }
      propose(command);
      // A catalog message with its values (never an English sentence with the request spliced in).
      append(scope, { role: 'system', text: 'Proposal: {0}. Review against revision {1} before applying.', params: [request, String(command.baseRevision)] });
    } catch (cause) {
      // BUILD-FLOFI-CHAT-E2E-FIX-002: a native-ETH swap where none exists is refused with its exact reason, deterministically (ETH is never authored
      // as WETH). BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a wrap without its network, or a swap without its amount, is asked for — never guessed.
      if (cause instanceof Error && ['SWAP_NATIVE_ASSET_UNSUPPORTED', 'WRAP_NETWORK_REQUIRED', 'SWAP_AMOUNT_REQUIRED'].includes(cause.message)) {
        const code = cause.message;
        dismissProposal(); say(scope, language, language => copilotRejection(code, language).message, 'system'); return;
      }
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
  // BUILD0-UX-001: `submit` is the same `send`, awaitable, for Build 0 (the request and FloFi's answer stay in this conversation).
  return { messages, input, setInput, send: (text: string) => void send(text), submit: send, busy: copilot.busy || sending, copilot, automation, dismissAutomation: () => setAutomation(null),
    phase, question: question?.open.kind ?? null, direct };
}
export type FlofiConversation = ReturnType<typeof useFlofiConversation>;
