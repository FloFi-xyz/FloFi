// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useCallback, useEffect, useRef, useState } from 'react';
import { copilotInterpret, copilotStatus } from '../app/copilot-action';
import { learningApply, learningFeedback, learningStatus } from '../app/learning-action';
import { learningCopy } from '../domain/copilot-learning-copy';
import type { LearningStatusView } from '../learning/web-actions';
import type { Command } from '../domain/commands';
import { chainStatus } from '../domain/artifact-chain';
import { buildCopilotFacts, simulationFlowOf, type CopilotFacts, type SimulationFlow } from '../domain/copilot-answers';
import { closeSegment, emptyConversation, finishTurn, recordProposal, startTurn, type CopilotConversation, type CopilotEnvironment, type CopilotReply,
  type CopilotResultV2, type CopilotVerified } from '../domain/copilot-conversation';
import { solanaLiquidityPositions, solanaLiquidityPrice } from '../app/solana-liquidity-action';
import { reconciledRemaining } from '../domain/copilot-reconciled-context';
import { useSolanaComposition } from '../state/solana-composition-store';
import { workflowSteps } from '../domain/workflow-steps';
import { catalogNetworksNamed } from '../domain/network-registry';
import { ensureNetworkCatalog } from '../state/asset-catalog-store';
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
 */
type LearningNamespace = 'eip155' | 'solana';
type FeedbackEvent = { readonly kind: string; readonly outcome?: string; readonly language?: string | null; readonly privateEntries?: number; readonly globalEntries?: number;
  readonly knowledgeVersion?: number | null };
export type { CopilotReply };
type Record_ = { readonly record?: unknown; readonly run?: unknown; readonly retired: boolean } | null;
const authorized = (value: unknown) => {
  const record = value as { authorization?: unknown; reviewedManifestHash?: unknown } | null;
  return Boolean(record && (record.authorization || record.reviewedManifestHash));
};

export function useCopilotInterpreter() {
  const workflow = useWorkflow();
  const wallet = useBuild009Wallet();
  const { environment, result: capability } = useWorkflowCapability();
  const jupiter = useJupiter(), orca = useSolanaLiquidity(), composition = useSolanaComposition();
  const flows: Readonly<Record<Exclude<SimulationFlow, 'MOCKED_CHAIN'>, Record_>> = { SUPPLY: useSupply(), LENDING: useLending(), ROUTER: useRouter(),
    SOLANA_SWAP: jupiter, ORCA: orca, UNISWAP: useUniswapLiquidity(), PUBLIC_TESTNET: usePublicTestnet(), TRANSFER: useRobinhoodTransfer() };
  // `loading` renders exactly like `off`; text sent before the status arrives waits for it rather than guessing.
  const [mode, setMode] = useState<CopilotMode | 'loading'>('loading');
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
  useEffect(() => { void refreshLearning(); }, [refreshLearning]);
  const report = useCallback((events: readonly FeedbackEvent[]) => {
    const view = learningView.current;
    if (view?.enabled && view.learning.memory !== 'UNAVAILABLE' && events.length) void learningFeedback(events).catch(() => undefined);
  }, []);
  // Read-only Solana Devnet facts fetched for the last turn that needed them (pool price, the wallet's FloFi positions): never the model's words.
  const fetched = useRef<{ readonly owner: string | null; readonly price: CopilotVerified['orcaPrice']; readonly positions: CopilotVerified['orcaPositions'] }>({ owner: null, price: null, positions: null });
  useEffect(() => {
    let stopped = false;
    const pending = copilotStatus().then(result => result.mode, () => 'off' as const);
    status.current = pending;
    void pending.then(next => { if (!stopped) setMode(next); });
    return () => { stopped = true; };
  }, []);
  /** A read-only snapshot of Flofi state for the engine, taken now. */
  const environmentNow = useCallback((): CopilotEnvironment => {
    const now = latest.current, store = now.workflow, current = store.state.workflow;
    const steps = workflowSteps(current, store.context), flow = simulationFlowOf(steps);
    const owner = flow === 'MOCKED_CHAIN' ? null : now.flows[flow];
    const record = owner ? owner.record ?? owner.run ?? null : null;
    const chain = chainStatus(store.chain);
    const simulation = flow === 'MOCKED_CHAIN' ? { flow, status: chain === 'CURRENT' ? 'CURRENT' as const : chain === 'INVALIDATED' || chain === 'EXPIRED' ? 'STALE' as const : 'NONE' as const, reviewed: false }
      : { flow, status: record ? owner!.retired ? 'STALE' as const : 'CURRENT' as const : 'NONE' as const, reviewed: Boolean(record && !owner!.retired && authorized(record)) };
    const facts: CopilotFacts = buildCopilotFacts({ workflow: current, context: store.context, pending: store.pending, findings: store.review?.findings ?? [], reviewError: store.reviewError,
      capability: { environment: now.environment, executionSupported: now.capability.executionSupported, executionReady: now.capability.executionReady,
        evidenceCeiling: now.capability.evidenceCeiling, blockers: now.capability.blockers.filter(item => item.dimension === 'EXECUTE' || item.dimension === 'AUTHORIZE') },
      simulation, walletConnected: Boolean(now.wallet.account) });
    const solanaOwner = now.orca.owner, loaded = fetched.current;
    const verified: CopilotVerified = { orcaPrice: loaded.price, solanaOwner, orcaPositions: solanaOwner && loaded.owner === solanaOwner ? loaded.positions : null,
      remaining: reconciledRemaining(solanaOwner, now.jupiter.record, now.composition.record) };
    const view = learningView.current;
    return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, workflow: current, context: store.context, wallet: now.wallet.account, walletChainId: now.wallet.chainId, pending: store.pending, facts,
      verified, ...view?.enabled ? { learning: view.learning } : {} };
  }, []);
  /** Reads the Orca pool price and the connected wallet's FloFi positions when the interpreted request needs them (a percentage range, a position). */
  const loadVerified = useCallback(async (intent: unknown) => {
    const shape = JSON.stringify(intent) ?? '';
    if (!/"rangeUnit":"PERCENT"|"kind":"POSITION"/.test(shape)) return;
    const owner = latest.current.orca.owner;
    const [price, positions] = await Promise.all([solanaLiquidityPrice().catch(() => null), owner && /"kind":"POSITION"/.test(shape) ? solanaLiquidityPositions(owner).catch(() => null) : null]);
    fetched.current = { owner, price: price?.ok ? { price: price.value.price, tickCurrentIndex: price.value.tickCurrentIndex } : null,
      positions: positions?.ok ? positions.value.map(p => ({ positionMint: p.positionMint, status: p.status, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: p.liquidity }))
        : owner === fetched.current.owner && !/"kind":"POSITION"/.test(shape) ? fetched.current.positions : null };
  }, []);
  // Every proposal the user can see becomes a referent, including exact-grammar proposals ("make it 2" after one).
  const pendingCommand = workflow.pending?.command;
  useEffect(() => { if (pendingCommand) conversation.current = recordProposal(conversation.current, environmentNow(), pendingCommand); }, [pendingCommand, environmentNow]);
  // BUILD-CHAT-LEARNING-001: what became of a Copilot proposal — observed behaviour only, never proof that the interpretation was right.
  const watched = useRef<{ readonly command: Command; readonly revision: number } | null>(null);
  useEffect(() => {
    const prior = watched.current, revision = latest.current.workflow.state.workflow.revision;
    if (prior && prior.command !== pendingCommand) report([{ kind: pendingCommand && proposals.current.has(pendingCommand) ? 'PROPOSAL_REVISED'
      : !pendingCommand && revision > prior.revision ? 'PROPOSAL_APPLIED' : 'PROPOSAL_DISMISSED' }]);
    watched.current = pendingCommand && proposals.current.has(pendingCommand) ? { command: pendingCommand, revision } : null;
  }, [pendingCommand, report]);
  /** The exact grammar handled a message: Flofi's open question, if any, is over. */
  const reset = useCallback(() => { conversation.current = closeSegment(conversation.current); }, []);
  const show = useCallback((reply: CopilotReply) => {
    if (reply.command) { proposals.current.set(reply.command, reply.sentence ?? reply.command.type); latest.current.workflow.propose(reply.command); }
    return reply;
  }, []);
  /** BUILD-CHAT-LEARNING-001: performs the memory action the user just confirmed, and reports the turn's content-free feedback. */
  const settle = useCallback(async (reply: CopilotReply): Promise<CopilotReply> => {
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
    return out;
  }, [refreshLearning, report]);
  const interpret = useCallback(async (text: string): Promise<CopilotReply> => {
    const start = startTurn(conversation.current, text, environmentNow());
    if (start.kind === 'LOCAL') {
      conversation.current = start.next;
      if (!start.reply.memory) return show(await settle(start.reply));
      // A confirmed memory change is one server action: the chat stays busy until it settled (no double submission).
      setBusy(true);
      try { return show(await settle(start.reply)); } finally { setBusy(false); }
    }
    setBusy(true);
    try {
      let result: CopilotResultV2;
      // BUILD-CHAT-LEARNING-001: which proven wallet's memory, and this conversation's own aliases (a glossary hint the server re-validates).
      const options = learningView.current?.enabled ? { identity: identity.current, aliases: start.turn.state.aliases ?? [] } : undefined;
      try { result = await copilotInterpret(start.request, options) as CopilotResultV2; } catch { result = { ok: false, code: 'COPILOT_UNAVAILABLE' }; }
      // BUILD-BASE-001: catalog-network symbols resolve only in validated catalogs: load those this request or its intent names (where enabled).
      if (result.ok) await Promise.all([...catalogNetworksNamed(start.turn.state.segment.join('\n'), result.intent).map(n => ensureNetworkCatalog(false, n.chain)),
        loadVerified(result.intent)]);
      const finished = finishTurn(start.turn, result, environmentNow());
      conversation.current = finished.next;
      return show(await settle(finished.reply));
    } finally { setBusy(false); }
  }, [environmentNow, show, settle, loadVerified]);
  /** The Copilot's reply, or null when it is not enabled on this server (the caller shows its exact-grammar guidance). */
  const respond = useCallback(async (text: string): Promise<CopilotReply | null> => {
    const resolved = await (status.current ?? Promise.resolve<CopilotMode>('off'));
    if (resolved === 'live' || resolved === 'replay') return interpret(text);
    // Off mode keeps the exact-grammar behaviour: unrecognized text discards the pending proposal.
    latest.current.workflow.dismissProposal();
    return null;
  }, [interpret]);
  const proposalSentence = useCallback((command: Command | undefined) => command ? proposals.current.get(command) ?? null : null, []);
  return { mode, enabled: mode === 'live' || mode === 'replay', mayInterpret: mode === 'loading' || mode === 'live' || mode === 'replay', busy, respond,
    reset, proposalSentence, learning, refreshLearning };
}

export const COPILOT_PLACEHOLDER = 'Put 1 USDC into Aave on Base Sepolia';
export function copilotIntro(mode: CopilotMode | 'loading'): string | null {
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
export function CopilotMessage({ text, notes, options, disabled, onPick }: { text: string; notes?: readonly string[] | undefined; options?: readonly string[] | undefined;
  disabled: boolean; onPick(option: string): void }) {
  const { t: tr } = useLocale();
  return <>
    <p>{tr(text)}</p>
    {notes && notes.length > 0 && <ul className="copilot-notes">{notes.map((note, index) => <li key={index}>{tr(note)}</li>)}</ul>}
    {options && options.length > 0 && <div className="copilot-options" role="group" aria-label={tr("Suggested answers")}>
      {options.map(option => <button key={option} type="button" className="quiet" disabled={disabled} onClick={() => onPick(option)}>{option}</button>)}</div>}
  </>;
}
/** Shown inside the existing proposal box when the pending proposal came from the Copilot. */
export function CopilotProposalNotice({ sentence }: { sentence: string }) {
  const { t: tr } = useLocale();
  return <p className="copilot-notice" role="note">{tr("AI interpretation of your words as “")}{tr(sentence)}{tr("”. It has no authority: check every field.")}</p>;
}
