// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { FLOFI_WELCOME, FLOFI_WELCOME_COMMANDS, FLOFI_WELCOME_REPLAY } from '../domain/assistant-welcome';
import { useLocale } from '../i18n/locale';

import { useCallback, useEffect, useRef, useState } from 'react';
import { copilotInterpret, copilotStatus, copilotTurnReport } from '../app/copilot-action';
import { turnMetrics } from '../domain/intelligence/turn-metrics';
import { learningApply, learningFeedback, learningObserve, learningStatus } from '../app/learning-action';
import { learningCopy } from '../domain/copilot-learning-copy';
import type { LearningStatusView } from '../learning/web-actions';
import { LEARNING_CHANGED } from './wallet-proof';
import type { Command } from '../domain/commands';
import type { AwaitingAmount } from '../domain/amount-shortcuts';
import type { Workflow } from '../domain/initial-workflow';
import { chainStatus } from '../domain/artifact-chain';
import { buildCopilotFacts, simulationFlowOf, type CopilotFacts, type SimulationFlow } from '../domain/copilot-answers';
import { assistantSimulation } from '../domain/assistant-facts';
import type { LifecycleView } from '../domain/conversation-lifecycle';
import { automationCreated, awaitingAmount as engineAwaitingAmount, closeSegment, contextChange, emptyConversation, finishTurn, observeWorkflow, proposalApplied, recordProposal, startTurn,
  type CopilotConversation, type CopilotEnvironment, type CopilotReply, type CopilotResultV2, type CopilotVerified, type ReplyLearning } from '../domain/copilot-conversation';
import { solanaLiquidityPositions, solanaLiquidityPrice } from '../app/solana-liquidity-action';
import { solanaMainnetLiquidityPrice } from '../app/solana-mainnet-liquidity-action';
import { catalogLiquidityPrice } from '../app/uniswap-liquidity-action';
import { POOL_READS_PER_TURN, type PoolPriceRead } from '../domain/pool-range';
import { POOL_READ_TIMEOUT_MS, poolReader } from '../state/copilot-pool-reads';
import { activeNetworkScope } from '../domain/network-scope';
import { reconciledRemaining } from '../domain/copilot-reconciled-context';
import { liquidityRemovalNamed, mergeLiquidityFacts, positionOwnersKey, positionScanFacts, POSITION_FACT_LIMITS, type CopilotLiquidityFacts,
  type CopilotPositionWallet } from '../domain/copilot-positions';
import type { LiquidityPositionView } from '../domain/liquidity-positions';
import { useSolanaComposition } from '../state/solana-composition-store';
import { workflowSteps } from '../domain/workflow-steps';
import { ensureCopilotCatalogs } from '../state/copilot-catalogs';
import { loadSavedRecipients, saveRecipientReference, savedRecipientsSnapshot, useSavedRecipients } from '../state/saved-recipients-store';
import { ASSIST_COPY } from '../domain/copilot-assist';
import type { CopilotMode } from '../server/copilot-service';
import { useBuild009Wallet } from '../state/build009-wallet-store';
import { useWorkflowCapability } from '../state/capability-store';
import { useJupiter } from '../state/jupiter-store';
import { useLending } from '../state/lending-store';
import { usePublicTestnet } from '../state/public-testnet-store';
import { useRobinhoodTransfer } from '../state/robinhood-transfer-store';
import { useRouter } from '../state/router-store';
import { useSolanaLiquidity } from '../state/solana-liquidity-store';
import { useSupply } from '../state/supply-store';
import { useUniswapLiquidity } from '../state/uniswap-liquidity-store';
import { useWorkflow } from '../state/workflow-store';
import { useProductBootstrap } from '../state/product-bootstrap';
import { chatActionVariant } from '../domain/chat-action-variant';

/**
 * BUILD-COPILOT-001: AI interpretation for the Copilot panel, kept apart from the panel itself. Text the exact grammar
 * does not recognize goes to the server-side interpreter; its untrusted intent becomes a proposal only through
 * `copilotIntentToCommand` (exact grammar) and the existing `propose`. Applying stays an explicit user action, and
 * any workflow change while the interpreter runs discards its answer.
 *
 * BUILD-COPILOT-002: the hook drives the pure conversation engine. It hands the engine a read-only snapshot of state
 * Flofi already holds (canonical IR, pending proposal, lint review, capability blockers, the active flow's own record)
 * and passes at most one resulting Command to `propose`. It never dispatches, signs, simulates or executes.
 *
 * BUILD-CHAT-LEARNING-001: when the deployment enables learning, the hook also loads this browser's learning context (its proven wallet's
 * own memory and the active global glossary, from the server), performs a memory action only after the user's own click or statement, and
 * reports content-free feedback (reply kinds, signals, proposal applied/dismissed). Learning off or unavailable: exactly the previous behaviour.
 *
 * BUILD-CHAT-LEARNING-002: learning is invisible. The hook tells the engine when the user applied a Copilot proposal and when the workflow changed
 * outside the chat (the canvas), and hands the server the engine's observations about the user's words — only when persistent automatic learning
 * is permitted for the proven wallet (the server checks again) — with a random id of this conversation and the request's ordinal, never text.
 *
 * BUILD-FLOFI-CONVERSATIONAL-001: with `direct`, the hook no longer hands a Command to `propose`: the FloFi chat commits the validated command to
 * the canonical workflow itself (`commitChatCommand`) and tells the hook through `committed`, so referents and learning treat it as an applied
 * proposal. The hook still never dispatches, signs, simulates or executes.
 */
type LearningNamespace = 'eip155' | 'solana';
type FeedbackEvent = { readonly kind: string; readonly outcome?: string; readonly language?: string | null; readonly privateEntries?: number; readonly globalEntries?: number;
  readonly knowledgeVersion?: number | null };
export type { CopilotReply };
type Record_ = { readonly record?: unknown; readonly run?: unknown; readonly retired: boolean } | null;
/** A random id of this browser conversation (it only lets the server count a request once; it identifies nobody). */
const conversationId = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
  : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
const TERMINAL: ReadonlySet<string> = new Set(['PROPOSAL', 'AUTOMATION_PROPOSAL', 'AUTOMATION_MANAGE', 'ANSWER', 'UNSUPPORTED', 'FAILED']);
const authorized = (value: unknown) => {
  const record = value as { authorization?: unknown; reviewedManifestHash?: unknown } | null;
  return Boolean(record && (record.authorization || record.reviewedManifestHash));
};

export function useCopilotInterpreter({ direct = false, interfaceLanguage, lifecycle }: { direct?: boolean;
  /** P0 approved UX: the interface language (the fallback when a turn names no reply language; absent: the language of the message, as before). */
  interfaceLanguage?: 'EN' | 'PT';
  /**
   * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (A05): the chat's lifecycle view — the same selected-runtime simulation its Review card and the
   * Simulate panel show. When present, the engine's simulation facts (status and the current revision's figures) are read from it.
   */
  lifecycle?: LifecycleView } = {}) {
  const workflow = useWorkflow();
  const wallet = useBuild009Wallet();
  const { environment, result: capability } = useWorkflowCapability();
  const jupiter = useJupiter(), orca = useSolanaLiquidity(), composition = useSolanaComposition();
  const flows: Readonly<Record<Exclude<SimulationFlow, 'MOCKED_CHAIN'>, Record_>> = { SUPPLY: useSupply(), LENDING: useLending(), ROUTER: useRouter(),
    SOLANA_SWAP: jupiter, ORCA: orca, UNISWAP: useUniswapLiquidity(), PUBLIC_TESTNET: usePublicTestnet(), TRANSFER: useRobinhoodTransfer() };
  // `loading` renders exactly like `off`; text sent before the status arrives waits for it rather than guessing.
  // BUILD-FLOFI-PRODUCT-UX-001: the product renders with the mode the server rendered (its configured mode), so the Copilot's text does not change
  // during hydration; the status read below still confirms it (a live mode whose settings fail becomes `unavailable`).
  const configured = useProductBootstrap().copilotMode;
  const [mode, setMode] = useState<CopilotMode | 'loading'>(configured ?? 'loading');
  const status = useRef<Promise<CopilotMode> | null>(null);
  const [busy, setBusy] = useState(false);
  const conversation = useRef<CopilotConversation>(emptyConversation());
  const proposals = useRef(new WeakMap<Command, string>());
  const latest = useRef({ workflow, wallet, environment, capability, flows, jupiter, orca, composition });
  latest.current = { workflow, wallet, environment, capability, flows, jupiter, orca, composition };
  // BUILD-CHAT-LEARNING-001: this browser's learning context (null until loaded, or when learning is off).
  const [learning, setLearning] = useState<LearningStatusView | null>(null);
  const learningView = useRef<LearningStatusView | null>(null), identity = useRef<LearningNamespace | null>(null);
  const refreshLearning = useCallback(async (namespace?: LearningNamespace | null) => {
    if (namespace !== undefined) identity.current = namespace;
    const view = await learningStatus(identity.current ?? undefined).catch(() => null);
    learningView.current = view; setLearning(view);
    return view;
  }, []);
  useEffect(() => {
    void refreshLearning();
    // BUILD-CHAT-LEARNING-002: a wallet proven or a Privacy & memory choice made elsewhere in FloFi applies to the next turn.
    const changed = () => void refreshLearning();
    window.addEventListener(LEARNING_CHANGED, changed);
    return () => window.removeEventListener(LEARNING_CHANGED, changed);
  }, [refreshLearning]);
  const report = useCallback((events: readonly FeedbackEvent[]) => {
    const view = learningView.current;
    if (view?.enabled && view.learning.memory !== 'UNAVAILABLE' && view.learning.memory !== 'SESSION' && events.length) void learningFeedback(events).catch(() => undefined);
  }, []);
  // BUILD-CHAT-LEARNING-002: this conversation's random id and the ordinal of its current request (a request counts once as evidence).
  const conversationKey = useRef<string | null>(null), requestSeq = useRef(0), proposalSeq = useRef(new WeakMap<Command, number>());
  /** Content-free events of a signal, and its observations for the server when persistent learning is permitted (best effort, never awaited by the chat). */
  const deliver = useCallback((learned: ReplyLearning | null | undefined, request: number) => {
    const view = learningView.current;
    if (!learned || !view?.enabled) return;
    report((learned.events ?? []).map(event => ({ kind: event.kind, outcome: event.outcome })));
    if (learned.observations?.length && view.learning.automatic === 'ON') {
      conversationKey.current ??= conversationId();
      void learningObserve(learned.observations, { conversation: conversationKey.current, request }, identity.current ?? undefined).catch(() => undefined);
    }
  }, [report]);
  // Read-only Solana Devnet facts fetched for the last turn that needed them (pool price, the wallet's FloFi positions): never the model's words.
  const fetched = useRef<{ readonly owner: string | null; readonly price: CopilotVerified['orcaPrice']; readonly positions: CopilotVerified['orcaPositions'] }>({ owner: null, price: null, positions: null });
  /**
   * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the connected wallets' verified liquidity positions, read through FloFi's discovery route for the current
   * owners (one read per connected EVM account and Solana mainnet session), cached per owners and conversation epoch. A wallet change, a new
   * conversation (owner or workflow) or a read that finished for other owners never reaches the engine; a new request re-reads stale facts.
   */
  const positionFacts = useRef<{ readonly key: string; readonly at: number; readonly facts: CopilotLiquidityFacts } | null>(null), positionEpoch = useRef(0);
  useEffect(() => {
    let stopped = false;
    const pending = copilotStatus().then(result => result.mode, () => 'off' as const);
    status.current = pending;
    void pending.then(next => { if (!stopped) setMode(next); });
    return () => { stopped = true; };
  }, []);
  /** A read-only snapshot of Flofi state for the engine, taken now. */
  // The language is read at each turn (the interface can switch mid-conversation); the callback itself stays stable.
  // BUILD-FLOFI-UNIFIED-COPILOT-001: the signed-in account's Saved Recipients (in memory only; cleared on sign-out). The engine resolves exact
  // saved names itself and masks them before any request leaves for a model; a save happens only on the user's explicit request.
  // Subscribed so a sign-in user change drops the list at once; each turn reads the store's snapshot itself (`recipientsNow`).
  useSavedRecipients();
  const interfaceLanguageRef = useRef(interfaceLanguage);
  interfaceLanguageRef.current = interfaceLanguage;
  const lifecycleRef = useRef(lifecycle);
  lifecycleRef.current = lifecycle;
  /** A09: the language the chat answers the current turn in (the person's conversational language), set by `respond`. */
  const replyLanguageRef = useRef<'EN' | 'PT' | null>(null);
  /** BUILD-FLOFI-UNIFIED-COPILOT-001: the account's saved recipients as the store holds them right now (not the last render): any known list resolves
   * and masks names, even while a refresh failed; only a READY list may be written to (the save offer). */
  const recipientsNow = useCallback((): Pick<CopilotEnvironment, 'recipients' | 'recipientWrites'> => {
    const list = savedRecipientsSnapshot();
    return { ...list.recipients.length ? { recipients: list.recipients } : {}, ...list.status === 'READY' ? { recipientWrites: true } : {} };
  }, []);
  const savedRecipientsNow = useCallback(() => savedRecipientsSnapshot().recipients, []);
  /** The workflow, proposal, wallet and facts a message is written against (everything but the saved recipients). */
  const contextNow = useCallback((): CopilotEnvironment => {
    const now = latest.current, store = now.workflow, current = store.state.workflow;
    const steps = workflowSteps(current, store.context), flow = simulationFlowOf(steps);
    const owner = flow === 'MOCKED_CHAIN' ? null : now.flows[flow];
    const record = owner ? owner.record ?? owner.run ?? null : null;
    const chain = chainStatus(store.chain), lifecycleView = lifecycleRef.current;
    // A05: the chat's own view of the selected runtime (every runtime the shell can select, the universal bridge included) when it is known; the
    // per-flow records otherwise. A retired or expired simulation is STALE and carries no figure.
    const details = lifecycleView ? assistantSimulation(lifecycleView, { workflow: current, context: store.context }) : null;
    const simulation = details ? { flow, status: details.status === 'CURRENT' ? 'CURRENT' as const : details.status === 'EXPIRED' || details.status === 'CHANGED' ? 'STALE' as const : 'NONE' as const,
      reviewed: details.status === 'CURRENT' && Boolean(lifecycleView!.authorization.accepted), details }
      : flow === 'MOCKED_CHAIN' ? { flow, status: chain === 'CURRENT' ? 'CURRENT' as const : chain === 'INVALIDATED' || chain === 'EXPIRED' ? 'STALE' as const : 'NONE' as const, reviewed: false }
      : { flow, status: record ? owner!.retired ? 'STALE' as const : 'CURRENT' as const : 'NONE' as const, reviewed: Boolean(record && !owner!.retired && authorized(record)) };
    const facts: CopilotFacts = buildCopilotFacts({ workflow: current, context: store.context, pending: store.pending, findings: store.review?.findings ?? [], reviewError: store.reviewError,
      capability: { environment: now.environment, executionSupported: now.capability.executionSupported, executionReady: now.capability.executionReady,
        evidenceCeiling: now.capability.evidenceCeiling, blockers: now.capability.blockers.filter(item => item.dimension === 'EXECUTE' || item.dimension === 'AUTHORIZE') },
      simulation, walletConnected: Boolean(now.wallet.account) });
    // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the public product reads the Solana mainnet session (never a Devnet one); engineering certification keeps the
    // Devnet Orca owner, its Devnet positions and reconciled Devnet leftovers for its Devnet path.
    const engineering = activeNetworkScope() === 'ENGINEERING', owners = positionOwners(now), loaded = fetched.current;
    const solanaOwner = engineering ? now.orca.owner : owners.solana, cached = positionFacts.current;
    const liquidity = devnetPositions(now) ? undefined : !owners.evm && !owners.solana ? { wallets: [], positions: [] }
      : cached && cached.key === positionOwnersKey(owners) ? cached.facts : undefined;
    const verified: CopilotVerified = { orcaPrice: engineering ? loaded.price : null, solanaOwner,
      orcaPositions: engineering && solanaOwner && loaded.owner === solanaOwner ? loaded.positions : null,
      remaining: engineering ? reconciledRemaining(solanaOwner, now.jupiter.record, now.composition.record) : [], ...liquidity ? { liquidity } : {} };
    const view = learningView.current;
    const interfaceLanguage = interfaceLanguageRef.current, replyLanguage = replyLanguageRef.current;
    return { ...interfaceLanguage ? { interfaceLanguage } : {}, ...replyLanguage ? { replyLanguage } : {}, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, workflow: current, context: store.context, wallet: now.wallet.account, walletChainId: now.wallet.chainId, pending: store.pending, facts,
      verified, ...view?.enabled ? { learning: view.learning } : {}, surface: 'WEB', poolReads: true };
  }, []);
  const environmentNow = useCallback((): CopilotEnvironment => ({ ...contextNow(), ...recipientsNow() }), [contextNow, recipientsNow]);
  /** BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: reads the current owners' verified positions (bounded); fresh facts are reused, a stale or foreign read is dropped. */
  const loadPositions = useCallback(async () => {
    const owners = positionOwners(latest.current), key = positionOwnersKey(owners), epoch = positionEpoch.current, cached = positionFacts.current;
    if (cached && cached.key === key && Date.now() - cached.at < POSITION_FACT_LIMITS.freshMs) return;
    const wallets: Pick<CopilotPositionWallet, 'namespace' | 'address'>[] = [...owners.evm ? [{ namespace: 'eip155' as const, address: owners.evm }] : [],
      ...owners.solana ? [{ namespace: 'solana' as const, address: owners.solana }] : []];
    if (!wallets.length) return;
    const parts = await Promise.all(wallets.map(readWalletPositions));
    if (epoch !== positionEpoch.current || positionOwnersKey(positionOwners(latest.current)) !== key) return;
    positionFacts.current = { key, at: Date.now(), facts: mergeLiquidityFacts(parts) };
  }, []);
  /** Reads the Orca pool price and the connected wallet's FloFi positions when the interpreted request needs them (a percentage range, a position). */
  const loadVerified = useCallback(async (intent: unknown, request = '') => {
    const shape = JSON.stringify(intent) ?? '';
    // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a position request (or an Aave Withdraw worded about liquidity, which FloFi reads as one) reads the connected
    // wallets' verified mainnet positions; only engineering certification with a Solana Devnet session reads its Devnet positions below.
    if ((/"kind":"POSITION"/.test(shape) || (/"type":"WITHDRAW"/.test(shape) && liquidityRemovalNamed(request))) && !devnetPositions(latest.current)) {
      await loadPositions(); return;
    }
    // BUILD-P1: a mainnet percentage range reads its own pool on request (`readPool`); the Devnet price is only ever read in engineering certification.
    if (!/"kind":"POSITION"/.test(shape) && !(/"rangeUnit":"PERCENT"/.test(shape) && activeNetworkScope() === 'ENGINEERING')) return;
    const owner = latest.current.orca.owner;
    const [price, positions] = await Promise.all([solanaLiquidityPrice().catch(() => null), owner && /"kind":"POSITION"/.test(shape) ? solanaLiquidityPositions(owner).catch(() => null) : null]);
    fetched.current = { owner, price: price?.ok ? { price: price.value.price, tickCurrentIndex: price.value.tickCurrentIndex } : null,
      positions: positions?.ok ? positions.value.map(p => ({ positionMint: p.positionMint, status: p.status, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: p.liquidity }))
        : owner === fetched.current.owner && !/"kind":"POSITION"/.test(shape) ? fetched.current.positions : null };
  }, [loadPositions]);
  // Every proposal the user can see becomes a referent, including exact-grammar proposals ("make it 2" after one).
  const pendingCommand = workflow.pending?.command;
  useEffect(() => { if (pendingCommand) conversation.current = recordProposal(conversation.current, environmentNow(), pendingCommand); }, [pendingCommand, environmentNow]);
  // BUILD-CHAT-LEARNING-001: what became of a Copilot proposal — observed behaviour only, never proof that the interpretation was right.
  const watched = useRef<{ readonly command: Command; readonly revision: number } | null>(null);
  // BUILD-CHAT-LEARNING-002: the workflow change that applying a proposal made is not a canvas edit.
  const appliedWorkflow = useRef<unknown>(null);
  useEffect(() => {
    const prior = watched.current, revision = latest.current.workflow.state.workflow.revision;
    const outcome = prior && prior.command !== pendingCommand ? pendingCommand && proposals.current.has(pendingCommand) ? 'PROPOSAL_REVISED'
      : !pendingCommand && revision > prior.revision ? 'PROPOSAL_APPLIED' : 'PROPOSAL_DISMISSED' : null;
    if (outcome) report([{ kind: outcome }]);
    if (prior && outcome === 'PROPOSAL_APPLIED') {
      appliedWorkflow.current = latest.current.workflow.state.workflow;
      const applied = proposalApplied(conversation.current, environmentNow(), prior.command);
      conversation.current = applied.next;
      deliver(applied.learning, proposalSeq.current.get(prior.command) ?? requestSeq.current);
    }
    watched.current = pendingCommand && proposals.current.has(pendingCommand) ? { command: pendingCommand, revision } : null;
  }, [pendingCommand, report, environmentNow, deliver]);
  // BUILD-FLOFI-CONVERSATIONAL-001: a command the chat committed directly is an applied proposal once the stored workflow is exactly its result.
  const committing = useRef<{ readonly command: Command; readonly expected: string } | null>(null);
  // BUILD-CHAT-LEARNING-002: a change of the workflow outside the chat may correct a value FloFi read on its own in a step the user applied.
  const ir = workflow.state.workflow;
  useEffect(() => {
    const marker = committing.current;
    if (marker && JSON.stringify(ir) === marker.expected) {
      committing.current = null; appliedWorkflow.current = ir;
      report([{ kind: 'PROPOSAL_APPLIED' }]);
      const applied = proposalApplied(conversation.current, environmentNow(), marker.command);
      conversation.current = applied.next;
      deliver(applied.learning, proposalSeq.current.get(marker.command) ?? requestSeq.current);
    }
    if (!learningView.current?.enabled) return;
    const applying = appliedWorkflow.current === ir;
    const observed = observeWorkflow(conversation.current, environmentNow(), applying ? 'APPLIED' : 'CANVAS');
    conversation.current = observed.next;
    if (!applying) deliver(observed.learning, requestSeq.current);
  }, [ir, environmentNow, deliver, report]);
  /** The exact grammar handled a message: Flofi's open question, if any, is over. */
  const reset = useCallback(() => { conversation.current = closeSegment(conversation.current); }, []);
  const show = useCallback((reply: CopilotReply) => {
    if (reply.command) { proposals.current.set(reply.command, reply.sentence ?? reply.command.type); if (!direct) latest.current.workflow.propose(reply.command); }
    return reply;
  }, [direct]);
  /**
   * BUILD-FLOFI-CONVERSATIONAL-001: the chat committed `command` (its result is `expected`). An exact-grammar command becomes a referent here
   * ("make it 2" after it); a Copilot command already is one.
   */
  const committed = useCallback((command: Command, expected: unknown, exact: boolean) => {
    if (exact) conversation.current = recordProposal(conversation.current, environmentNow(), command);
    committing.current = { command, expected: JSON.stringify(expected) };
  }, [environmentNow]);
  /**
   * HOTFIX-P1-CHAT-RECOVERY: which conversation a turn belongs to. `clear` starts another one; a turn that began before (its model answer, catalog
   * or saved-name read still in flight) then writes nothing into it — no transcript, open clarification, language or referent — and has no effect.
   */
  const generation = useRef(0);
  /** BUILD-FLOFI-CONVERSATIONAL-001: a new owner or workflow starts a new conversation; nothing of the previous one carries over. */
  const clear = useCallback(() => {
    generation.current += 1;
    conversation.current = emptyConversation(); committing.current = null; watched.current = null; appliedWorkflow.current = null;
    conversationKey.current = null; fetched.current = { owner: null, price: null, positions: null };
    positionFacts.current = null; positionEpoch.current += 1;
  }, []);
  const language = useCallback(() => conversation.current.language, []);
  /** Whether FloFi's own clarification question is open (the request still misses a required field). */
  const drafting = useCallback(() => Boolean(conversation.current.draft), []);
  /**
   * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (UX-02): FloFi's open question for an amount (the engine's structured draft), with the wallets that
   * would sign and the workflow it was asked against — null as soon as the workflow, the pending proposal or a wallet changed (the engine
   * would refuse that answer as stale), so a shortcut is never computed for another wallet or workflow.
   */
  const awaitingAmountNow = useCallback((): { readonly request: AwaitingAmount; readonly evm: string | null; readonly solana: string | null; readonly workflow: Workflow } | null => {
    const state = conversation.current, request = engineAwaitingAmount(state);
    if (!request || !state.draft) return null;
    const now = latest.current, store = now.workflow;
    const snapshot = { workflow: store.state.workflow, pending: store.pending, wallet: now.wallet.account, walletChainId: now.wallet.chainId,
      solanaOwner: activeNetworkScope() === 'ENGINEERING' ? now.orca.owner : positionOwners(now).solana };
    return contextChange(state.draft.snapshot, snapshot) ? null : { request, evm: now.wallet.account, solana: now.orca.owner, workflow: store.state.workflow };
  }, []);
  /** BUILD-FLOFI-UNIFIED-COPILOT-001: FloFi just explained a DeFi concept, so "não entendi" refers to it (not to an execution blocker). */
  const explaining = useCallback(() => Boolean(conversation.current.concept), []);
  /** The owner created the automation FloFi proposed: a later schedule change is a confirmed replacement of the saved rule. */
  const automationCreatedNow = useCallback(() => { conversation.current = automationCreated(conversation.current); }, []);
  /** BUILD-CHAT-LEARNING-001: performs the memory action the user just confirmed, and reports the turn's content-free feedback. */
  const settle = useCallback(async (input: CopilotReply): Promise<CopilotReply> => {
    let reply = input;
    // BUILD-FLOFI-UNIFIED-COPILOT-001: the user asked FloFi to save a typed public address under a name. Only the server's answer is reported.
    if (reply.recipientSave) {
      const a = ASSIST_COPY[conversation.current.language === 'PT' ? 'PT' : 'EN'], { recipientSave: wanted, ...rest } = reply;
      const result = await saveRecipientReference(wanted).catch(() => ({ ok: false as const, code: 'RECIPIENTS_REQUEST_FAILED' }));
      reply = { ...rest, text: result.ok ? a.recipientSaved(result.value.label) : result.code === 'RECIPIENT_EXISTS' && 'existing' in result && result.existing
        ? a.recipientExists(result.existing.label) : result.code === 'RECIPIENT_LABEL_TAKEN' ? a.recipientLabelTaken(wanted.label)
        : result.code === 'RECIPIENTS_UNAVAILABLE' || result.code === 'ACCOUNT_SESSION_REQUIRED' ? a.recipientsUnavailable : a.recipientSaveFailed };
    }
    const view = learningView.current;
    if (!view?.enabled) return reply;
    let out = reply;
    if (reply.memory) {
      const result = await learningApply(reply.memory, identity.current ?? undefined).catch(() => ({ ok: false as const, code: 'LEARNING_UNAVAILABLE' as const }));
      if (!result.ok) {
        const l = learningCopy(conversation.current.language);
        const { memory: _failed, ...rest } = reply;
        void _failed;
        out = { ...rest, text: result.code === 'LEARNING_RATE_LIMITED' ? l.limited : result.code === 'LEARNING_MEMORY_FULL' ? l.full : l.failed };
      }
      void refreshLearning();
    }
    const used = reply.learning?.used ?? [], own = used.filter(entry => entry.source !== 'GLOBAL').length, shared = used.length - own;
    report([{ kind: 'TURN', outcome: out.kind, language: conversation.current.language, privateEntries: own, globalEntries: shared, knowledgeVersion: view.learning.globalVersion },
      ...(reply.learning?.signals ?? []).map(kind => ({ kind })), ...own ? [{ kind: 'MEMORY_USED' }] : [],
      ...shared ? [{ kind: 'KNOWLEDGE_USED', knowledgeVersion: view.learning.globalVersion }] : []]);
    // BUILD-CHAT-LEARNING-002: the turn's signals; a proposal remembers its request's ordinal (applying it later is evidence about that request).
    deliver(reply.learning, requestSeq.current);
    if (reply.command) proposalSeq.current.set(reply.command, requestSeq.current);
    if (TERMINAL.has(reply.kind)) requestSeq.current += 1;
    return out;
  }, [refreshLearning, report, deliver]);
  const interpret = useCallback(async (text: string): Promise<CopilotReply> => {
    setBusy(true);
    const turn = generation.current, ended = () => generation.current !== turn;
    // The conversation this turn was written in has ended: its answer is not shown (the chat drops it) and changes nothing.
    const dropped: CopilotReply = { kind: 'FAILED', code: 'COPILOT_CONVERSATION_ENDED', text: '', notes: [], options: [] };
    try {
      // Local clarification answers use the same validated catalogs as model turns. Retry a previous load failure on a new user turn.
      await ensureCopilotCatalogs([...conversation.current.segment, text].join('\n'), conversation.current.draft?.intent);
      // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a short answer about a position (FloFi's open position question, or a change right after it prepared one) is
      // resolved locally from the verified facts: facts older than POSITION_FACT_LIMITS.freshMs are read again first, never for longer than a moment
      // (a slow read leaves the facts already known; Simulate and Review read the position again in any case).
      const positioned = conversation.current.draft?.intent.kind === 'POSITION' || conversation.current.referents[0]?.command.type === 'MANAGE_LIQUIDITY_POSITION';
      if (positioned && !devnetPositions(latest.current))
        await Promise.race([loadPositions().catch(() => undefined), new Promise(resolve => setTimeout(resolve, POSITION_REFRESH_WAIT_MS))]);
      if (ended()) return dropped;
      // The workflow, proposal and wallet this message is written against, taken before FloFi reads the saved names: a change while it reads them
      // (or while the model interprets) discards the late answer, exactly as without the read.
      const sent = contextNow();
      // The account's saved names, read again when stale (signed out or not available: none, and nothing is offered).
      // Never more than a moment: a slow read leaves the turn with the list already known.
      await Promise.race([loadSavedRecipients({ ifStale: true }).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 2500))]);
      if (ended()) return dropped;
      const before = conversation.current;
      // Engineering certification only: a local percentage answer about the Devnet pool reads the Devnet price first (mainnet pools are read on request).
      // The Devnet pool is named or implied (Orca with no network, a devUSDC deposit); the answer is a written percentage or the number FloFi asked for.
      const draftText = JSON.stringify(before.draft?.intent ?? null);
      const devnetPool = /SOLANA_DEVNET|devUSDC/i.test(draftText) || (/"protocol":"ORCA"/.test(draftText) && /"network":null/.test(draftText));
      const percentAnswer = /%|percent|por\s?cento/i.test(text) || (/^COPILOT_RANGE_PERCENT_/.test(before.draft?.code ?? '') && /^\s*\d+(?:[.,]\d+)?\s*$/.test(text));
      const devnetPercent = activeNetworkScope() === 'ENGINEERING' && Boolean(before.draft) && devnetPool && percentAnswer;
      if (devnetPercent) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const loaded = await Promise.race([loadVerified({ rangeUnit: 'PERCENT' }).then(() => true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), POOL_READ_TIMEOUT_MS); })]).finally(() => clearTimeout(timer));
        if (ended()) return dropped;
        // A read that did not answer in time leaves no price for this turn: an earlier price is never shown as the current one.
        if (!loaded) fetched.current = { ...fetched.current, price: null };
      }
      let start = startTurn(before, text, { ...(devnetPercent ? contextNow() : sent), ...recipientsNow() });
      // BUILD-P1: FloFi needs a pool's current price for this answer: read it (read-only, this turn only) and answer the same message again with it.
      // A request touching several pools (a composition) asks for each in turn, up to POOL_READS_PER_TURN reads for this message.
      const reads: PoolPriceRead[] = [];
      while (start.kind === 'LOCAL' && start.reply.pool && reads.length < POOL_READS_PER_TURN) {
        reads.push(await readPool(start.reply.pool));
        if (ended()) return dropped;
        // Answered against the context as it is now: a wallet, workflow or proposal change during the read ends the request (never a stale answer).
        start = startTurn(before, text, withPoolReads({ ...contextNow(), ...recipientsNow() }, reads));
      }
      // BUILD-FLOFI-INTELLIGENCE-001: one content-free turn record (counters and codes only), best effort and never awaited by the chat.
      const measure = (reply: CopilotReply, next: CopilotConversation, interpreted: string | null) =>
        void copilotTurnReport(turnMetrics(before, reply, next, interpreted, 'WEB')).catch(() => undefined);
      if (start.kind === 'LOCAL') {
        if (ended()) return dropped;
        conversation.current = start.next;
        measure(start.reply, start.next, 'LOCAL');
        return show(await settle(start.reply));
      }
      let result: CopilotResultV2;
      // BUILD-CHAT-LEARNING-001: which proven wallet's memory, and this conversation's own aliases (a glossary hint the server re-validates).
      const options = learningView.current?.enabled ? { identity: identity.current, aliases: start.turn.state.aliases ?? [], adapted: start.turn.state.adapted ?? [] } : undefined;
      try { result = await copilotInterpret(start.request, options) as CopilotResultV2; } catch { result = { ok: false, code: 'COPILOT_UNAVAILABLE' }; }
      // BUILD-BASE-001: catalog-network symbols resolve only in validated catalogs: load those this request or its intent names (where enabled).
      if (result.ok) await Promise.all([ensureCopilotCatalogs(start.turn.state.segment.join('\n'), result.intent), loadVerified(result.intent, start.turn.state.segment.join('\n'))]);
      let finished = finishTurn(start.turn, result, environmentNow());
      const later: PoolPriceRead[] = [];
      while (finished.reply.pool && later.length < POOL_READS_PER_TURN) {
        later.push(await readPool(finished.reply.pool));
        if (ended()) return dropped;
        finished = finishTurn(start.turn, result, withPoolReads(environmentNow(), later));
      }
      if (ended()) return dropped;
      conversation.current = finished.next;
      measure(finished.reply, finished.next, result.ok ? String((result.intent as { kind?: unknown } | null)?.kind ?? '') || null : null);
      return show(await settle(finished.reply));
    } finally { setBusy(false); }
  }, [contextNow, recipientsNow, environmentNow, show, settle, loadVerified, loadPositions]);
  /** The Copilot's reply, or null when it is not enabled on this server (the caller shows its exact-grammar guidance). */
  const respond = useCallback(async (text: string, language?: 'EN' | 'PT'): Promise<CopilotReply | null> => {
    // A09: this turn is answered in the person's conversational language (absent: the interface language, as before).
    replyLanguageRef.current = language ?? null;
    const resolved = await (status.current ?? Promise.resolve<CopilotMode>('off'));
    if (resolved === 'live' || resolved === 'replay') return interpret(text);
    // Off mode keeps the exact-grammar behaviour: unrecognized text discards the pending proposal.
    latest.current.workflow.dismissProposal();
    return null;
  }, [interpret]);
  const proposalSentence = useCallback((command: Command | undefined) => command ? proposals.current.get(command) ?? null : null, []);
  return { mode, enabled: mode === 'live' || mode === 'replay', mayInterpret: mode === 'loading' || mode === 'live' || mode === 'replay', busy, respond,
    reset, proposalSentence, learning, refreshLearning, committed, clear, language, drafting, explaining, automationCreated: automationCreatedNow,
    awaitingAmount: awaitingAmountNow,
    // R09–R12: the account's saved recipients as this page holds them now (display only: the chat names a Batch Payment's recipients by label).
    savedRecipients: savedRecipientsNow };
}

type Now = { readonly wallet: { readonly account: string | null }; readonly jupiter: { readonly session: { readonly chain: string; readonly account: { readonly address: string } } | null } };
/** BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the owners whose positions the chat may read now: the connected EVM account and the Solana mainnet session. */
const positionOwners = (now: Now) => ({ evm: now.wallet.account?.toLowerCase() ?? null,
  solana: now.jupiter.session?.chain === 'solana:mainnet' ? now.jupiter.session.account.address : null });
/** How long a local position answer waits for stale facts to be read again before it uses the facts already known. */
const POSITION_REFRESH_WAIT_MS = 4_000;
/** Engineering certification only: a Solana Devnet session keeps the Devnet position path (FloFi-registered Devnet positions). */
const devnetPositions = (now: Now) => activeNetworkScope() === 'ENGINEERING' && now.jupiter.session?.chain === 'solana:devnet';
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: one wallet's verified positions through FloFi's same-origin discovery route (`x-flofi-account`; only a wallet
 * linked or proven in this session is read), bounded in time. A refusal or failure is said as such (UNVERIFIED, UNAVAILABLE), never as "no positions".
 */
async function readWalletPositions(wallet: Pick<CopilotPositionWallet, 'namespace' | 'address'>): Promise<{ readonly wallet: CopilotPositionWallet; readonly positions: readonly LiquidityPositionView[] }> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), POSITION_FACT_LIMITS.timeoutMs);
  try {
    const response = await fetch('/api/dashboard/positions', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal, headers: { 'x-flofi-account': wallet.address } });
    const body = await response.json().catch(() => null) as { readonly ok?: unknown; readonly code?: unknown; readonly value?: unknown } | null;
    if (response.status === 403 && body?.code === 'POSITION_WALLET_UNVERIFIED') return { wallet: { ...wallet, status: 'UNVERIFIED' }, positions: [] };
    if (!response.ok || body?.ok !== true) return { wallet: { ...wallet, status: 'UNAVAILABLE' }, positions: [] };
    return positionScanFacts(wallet, body.value);
  } catch { return { wallet: { ...wallet, status: 'UNAVAILABLE' }, positions: [] }; } finally { clearTimeout(timer); }
}
/** BUILD-P1: the web chat's pool reads, through the existing read-only server actions (see `state/copilot-pool-reads.ts`). */
const readPool = poolReader({ orca: solanaMainnetLiquidityPrice, catalog: catalogLiquidityPrice });
const withPoolReads = (env: CopilotEnvironment, reads: readonly PoolPriceRead[]): CopilotEnvironment =>
  ({ ...env, verified: { orcaPrice: null, solanaOwner: null, orcaPositions: null, remaining: [], ...env.verified, pools: [...env.verified?.pools ?? [], ...reads] } });
/** BUILD-FLOFI-MAINNET-PRODUCT-001: the example names a mainnet (the public product never suggests a test network). */
export const COPILOT_PLACEHOLDER = 'Put 1 USDC into Aave on Base';
export function copilotIntro(mode: CopilotMode | 'loading', direct = false): string | null {
  if (direct) return mode === 'live' ? FLOFI_WELCOME : mode === 'replay' ? `${FLOFI_WELCOME} ${FLOFI_WELCOME_REPLAY}` : mode === 'unavailable' ? FLOFI_WELCOME_COMMANDS : null;
  if (mode === 'live') return 'Flofi Copilot ready. Describe an action in your own words, change a step, ask about this workflow, or type an exact command. An AI model turns free text into a proposal; it cannot sign or execute, and nothing changes until you apply.';
  if (mode === 'replay') return 'Flofi Copilot ready in replay mode (recorded answers, no AI model). Describe an action, change a step, ask about this workflow, or type an exact command. Nothing changes until you apply a proposal.';
  if (mode === 'unavailable') return 'Local command assistant ready. Flofi Copilot is not configured on this server, so only exact commands work. Review each proposal before applying it.';
  return null;
}
export function copilotHelp(mode: CopilotMode | 'loading'): string | null {
  return mode === 'live' || mode === 'replay' ? `Swaps, Cross-chain Router bridges, Aave V3 and liquidity; edits and questions about this workflow. ${mode === 'live' ? 'An AI model with no authority interprets' : 'Recorded replay answers interpret'} free text; exact commands skip it.` : null;
}
export const copilotLabel = (role: string, mode: CopilotMode | 'loading') => role === 'you' ? 'YOU' : role === 'ai' ? 'FLOFI COPILOT · AI'
  : mode === 'off' || mode === 'loading' ? 'GRYLOO' : 'FLOFI';

/** Keeps the newest message in view while the Copilot is enabled (off mode keeps its existing scrolling). */
export function useFollowLatest(enabled: boolean, messages: number, busy: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (enabled && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [enabled, messages, busy]);
  return ref;
}
/** A Copilot answer: plain text, deterministic notes, and clarification options that are sent as the next message. */
export function CopilotMessage({ text, notes, options, link, verbatim, disabled, onPick }: { text: string; notes?: readonly string[] | undefined; options?: readonly string[] | undefined;
  /** BUILD-FLOFI-UNIFIED-COPILOT-001: options that are the user's own words (saved names): shown and sent exactly as saved, never translated. */
  verbatim?: boolean | undefined;
  /** BUILD-FLOFI-UNIFIED-COPILOT-001: a FloFi page from the platform guide (a relative path; never a link the model wrote). */
  link?: { readonly path: string; readonly label: string } | undefined;
  disabled: boolean; onPick(option: string): void }) {
  const { t: tr } = useLocale();
  return <>
    <p>{tr(text)}</p>
    {notes && notes.length > 0 && <ul className="copilot-notes">{notes.map((note, index) => <li key={index}>{tr(note)}</li>)}</ul>}
    {link && /^\/(?:app|connections)(?:\/[a-z-]+)*$/.test(link.path) && <p className="copilot-link"><a href={link.path}>{tr(link.label)} →</a></p>}
    {options && options.length > 0 && <ChatActions options={options} verbatim={verbatim} busy={disabled} onPick={onPick}/>}
  </>;
}
/**
 * FloFi's suggested answers as buttons: one component for its deterministic lifecycle replies and the Copilot's replies. Each button sends
 * exactly the answer it shows, as before. `chatActionVariant` only decides how it looks (`data-variant`): FloFi's next step in the primary blue,
 * a choice neutral, an undo/discard/delete in the danger tone; the user's own saved names are always choices. While FloFi is answering every
 * answer is disabled and the group is marked busy.
 */
export function ChatActions({ options, verbatim, busy, onPick }: { options: readonly string[]; verbatim?: boolean | undefined; busy: boolean; onPick(option: string): void }) {
  const { t: tr } = useLocale();
  return <div className="copilot-options" role="group" aria-label={tr("Suggested answers")} aria-busy={busy || undefined}>
    {options.map(option => <button key={option} type="button" className="chat-action" data-variant={verbatim ? 'secondary' : chatActionVariant(option)} disabled={busy}
      onClick={() => onPick(verbatim ? option : tr(option))}>{verbatim ? option : tr(option)}</button>)}</div>;
}
/** Shown inside the existing proposal box when the pending proposal came from the Copilot. */
export function CopilotProposalNotice({ sentence }: { sentence: string }) {
  const { t: tr } = useLocale();
  return <p className="copilot-notice" role="note">{tr("AI interpretation of your words as “")}{tr(sentence)}{tr("”. It has no authority: check every field.")}</p>;
}
