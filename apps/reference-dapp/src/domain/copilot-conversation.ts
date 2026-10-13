// SPDX-License-Identifier: AGPL-3.0-only
import { groundAutomationDraft } from './copilot-automation';
import type { AutomationInput } from './copilot-automation';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import { commandIsValid, type Command } from './commands';
import { editorReducer } from './editor';
import type { Workflow } from './initial-workflow';
import { lendingDetails } from './lending-authoring';
import { workflowSteps, type WorkflowStep } from './workflow-steps';
import { editCommandFor, removeCommandFor } from './workflow-edits';
import { COPILOT_AUTHORING_COMMANDS, COPILOT_NETWORK_LABEL, COPILOT_POOLS, amountReadings, canonicalDecimal, copilotRejection, groundedAmount, planCopilotActions,
  proposalFromPlan, type CarriedField, type CopilotOutcome, type Grounding, type SwapSource } from './copilot-authoring';
import { SOLANA_LIQUIDITY_DEFAULT_SLIPPAGE, solanaLiquidityDetails, type SolanaLiquidityInput } from './solana-liquidity-authoring';
import { formatTokenAmount, parseTokenAmount } from './jupiter-authoring';
import { ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY } from '@defi-workflow-engine/action-registry';
import { orcaLiquidityAmounts, orcaSqrtPriceAtTick } from '@defi-workflow-engine/reference-compiler';
import { COPILOT_LIMITS, hasUnsafeCharacters, safeCopilotProse, type CopilotAction, type CopilotFeeTier, type CopilotLendingAction, type CopilotNetwork,
  type CopilotSwapAction } from './copilot-intent';
import { canonicalSymbol } from './asset-catalogs';
import { networkIdentity, networkOfCopilot } from './network-registry';
import { ROUTER_NETWORK_OPTIONS } from './router-authoring';
import { COPILOT_TRANSCRIPT, COPILOT_V2_LIMITS, isCopilotIntentError, parseCopilotIntentV2, type CopilotChanges, type CopilotIntentV2, type CopilotOrdinal, type CopilotQuestionTopic,
  type CopilotReuseField, type CopilotTarget } from './copilot-intent-v2';
import { copilotCopy, type CarriedLabel, type CopilotCopy, type CopilotLanguage } from './copilot-messages';
import { answerQuestion, stepSummary, type CopilotFacts } from './copilot-answers';

/**
 * BUILD-COPILOT-002: the conversation engine. Pure: no React, no network, no wallet, no execution. It keeps a bounded
 * transcript for the model's context, the open request segment (the only text explicit values may come from), Flofi's own
 * open question, and the proposals Flofi showed. Every reference is resolved here against the canonical workflow and
 * the visible pending proposal; the model never names a node. Every outcome is a reply plus, at most, one Command that
 * the caller hands to the existing `propose`; the workflow changes only when the user clicks Apply.
 */
export type TranscriptEntry = { readonly role: 'user' | 'assistant'; readonly text: string };
/** A proposal Flofi showed, as Flofi recorded it from the Command and its editor preview (never as the model described it). */
export type CopilotReferent = { readonly command: Command; readonly sentence: string; readonly step: WorkflowStep };
export type ContextSnapshot = { readonly workflow: Workflow; readonly pending: object | null; readonly wallet: string | null; readonly walletChainId: string | null; readonly solanaOwner?: string | null };
type Resolved =
  | { readonly source: 'PENDING'; readonly step: WorkflowStep; readonly command: Command }
  | { readonly source: 'NODE'; readonly step: WorkflowStep }
  | { readonly source: 'REFERENT'; readonly step: WorkflowStep; readonly referent: CopilotReferent };
type DraftFill = { readonly kind: 'TARGET'; readonly target: Resolved } | { readonly kind: 'ACTION'; readonly patch: Readonly<Record<string, unknown>> }
  | { readonly kind: 'EXTRAS'; readonly extras: Extras };
/** Flofi's own open question: each button has a deterministic meaning, so answering it needs no model. */
type Draft = { readonly intent: CopilotIntentV2; readonly options: readonly { readonly label: string; readonly fill: DraftFill }[]; readonly amountFill: boolean;
  readonly snapshot: ContextSnapshot;
  /** A bare amount answers Flofi's question for this pool token's maximum (FloFi's own question named it). */ readonly depositFill?: 'SOL' | 'devUSDC';
  /** What resolving the open request already settled (a chosen swap or position). */ readonly extras?: Extras;
  /** The question and the buttons shown, so "yes" never guesses among several. */ readonly question?: string; readonly shown?: readonly string[] };
/** Values Flofi settled itself while resolving one request: values it carried, the swap whose output funds a position, a position and its portion. */
type Extras = { readonly carried?: readonly CarriedField[]; readonly swap?: SwapSource; readonly position?: string; readonly portion?: string };
export type CopilotConversation = {
  readonly transcript: readonly TranscriptEntry[]; readonly segment: readonly string[]; readonly clarifications: number;
  readonly draft: Draft | null; readonly referents: readonly CopilotReferent[]; readonly language: CopilotLanguage;
};
export type CopilotEnvironment = {
  readonly timezone?: string; readonly workflow: Workflow; readonly context: ReviewContext; readonly wallet: string | null; readonly walletChainId: string | null;
  readonly pending: { readonly command: Command; readonly diff: readonly string[] } | null; readonly facts: CopilotFacts;
  /** Read-only Solana Devnet facts FloFi read itself (never the model's or the user's words); absent when not loaded. */
  readonly verified?: CopilotVerified;
};
/** One FloFi-registered Orca position of the connected Solana Devnet wallet, as the position registry and the chain report it. */
export type CopilotPosition = { readonly positionMint: string; readonly status: string; readonly tickLower: number | null; readonly tickUpper: number | null;
  readonly liquidity: string | null };
export type CopilotVerified = {
  /** The Orca SOL/devUSDC pool price (devUSDC per SOL) and current tick, read from Solana Devnet. */
  readonly orcaPrice: { readonly price: string; readonly tickCurrentIndex: number } | null;
  /** The connected Solana Devnet wallet and its FloFi positions on that pool (null: not loaded). */
  readonly solanaOwner: string | null; readonly orcaPositions: readonly CopilotPosition[] | null;
  /** Swap output a reconciled execution left in the wallet: a reconciled Devnet swap's output, or a composition's undeposited swap output. */
  readonly remaining: readonly { readonly token: 'SOL' | 'devUSDC'; readonly amount: string }[];
};
export type CopilotReply = {
  readonly kind: 'PROPOSAL' | 'AUTOMATION_PROPOSAL' | 'ANSWER' | 'CLARIFICATION' | 'UNSUPPORTED' | 'FAILED'; readonly text: string; readonly notes: readonly string[];
  readonly options: readonly string[]; readonly automation?: AutomationInput; readonly command?: Command; readonly sentence?: string; readonly topic?: CopilotQuestionTopic;
};
export type CopilotRequestV2 = { readonly version: '2'; readonly messages: readonly TranscriptEntry[] };
export type CopilotResultV2 = { readonly ok: true; readonly intent: unknown } | { readonly ok: false; readonly code: string; readonly retryAfterSeconds?: number };
export type PendingTurn = { readonly before: CopilotConversation; readonly state: CopilotConversation; readonly snapshot: ContextSnapshot };
export type TurnStart = { readonly kind: 'LOCAL'; readonly reply: CopilotReply; readonly next: CopilotConversation }
  | { readonly kind: 'REMOTE'; readonly request: CopilotRequestV2; readonly turn: PendingTurn };
type Result = { readonly reply: CopilotReply; readonly next: CopilotConversation };

/** Every Command the Copilot may hand to `propose`: new authoring, typed edits of existing steps, and removal. */
export const COPILOT_V2_COMMANDS: ReadonlySet<string> = new Set([...COPILOT_AUTHORING_COMMANDS, 'SET_SUPPLY', 'SET_BORROW', 'SET_REPAY', 'SET_WITHDRAW',
  'SET_SOLANA_SWAP', 'SET_ROUTER_BRIDGE', 'SET_UNISWAP_LIQUIDITY', 'SET_SOLANA_LIQUIDITY', 'SET_SWAP_AMOUNT', 'SET_SLIPPAGE', 'REMOVE',
  // BUILD-BASE-001: edits of catalog-network swaps, positions and transfers, with the same commands the Canvas uses.
  'SET_CRYPTO_ACTION', 'SET_RH_TRANSFER',
  // PR B: preparing a verified FloFi position for removal or exit (the owner still simulates, reviews and signs).
  'MANAGE_SOLANA_POSITION']);
export const emptyConversation = (): CopilotConversation => ({ transcript: [], segment: [], clarifications: 0, draft: null, referents: [], language: 'EN' });
export const snapshotOf = (env: CopilotEnvironment): ContextSnapshot =>
  ({ workflow: env.workflow, pending: env.pending, wallet: env.wallet, walletChainId: env.walletChainId, solanaOwner: env.verified?.solanaOwner ?? null });
/** What changed between two snapshots, by identity: the IR and the pending proposal are immutable objects replaced on every change. */
export function contextChange(a: ContextSnapshot, b: ContextSnapshot): 'WORKFLOW' | 'PROPOSAL' | 'WALLET' | null {
  if (a.workflow !== b.workflow) return 'WORKFLOW';
  if (a.pending !== b.pending) return 'PROPOSAL';
  return a.wallet !== b.wallet || a.walletChainId !== b.walletChainId || (a.solanaOwner ?? null) !== (b.solanaOwner ?? null) ? 'WALLET' : null;
}

// A private key, seed phrase or other 64-hex secret is refused locally: it is never sent to the model and never stored.
const SECRET_WORDS = /\b(?:private[\s_-]*keys?|secret[\s_-]*keys?|seed[\s_-]*phrases?|recovery[\s_-]*phrases?|mnemonics?|chaves?[\s_-]*privadas?|frases?[\s_-]*(?:semente|secretas?|de\s+recupera[cç][aã]o)|palavras[\s_-]*secretas)\b/i;
const HEX_SECRET = /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
const MNEMONIC = /^\s*(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\s*$/;
export const looksSecret = (text: string): boolean => SECRET_WORDS.test(text) || HEX_SECRET.test(text) || MNEMONIC.test(text);
// Carrying a value from an earlier step needs the user's own reuse wording; repeating a whole proposal needs a repeat cue.
const REUSE_CUE = /\b(?:same|again|also|too|as before|like before|mesm[oa]s?|igual|iguais|de novo|novamente|tamb[ée]m|outra vez|como antes)\b/i;
const REPEAT_CUE = /\b(?:same|again|repeat|once more|as before|like before|mesm[oa]s?|igual|de novo|novamente|repet\w*|outra vez|como antes)\b/i;

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
const segmentText = (state: CopilotConversation) => state.segment.join('\n');
/** Flofi's own transcript entries never carry an address (a carried beneficiary, a connected wallet): the model needs none. */
const redact = (text: string) => text.replace(/0x[0-9a-fA-F]{40}/g, '[address]').slice(0, COPILOT_LIMITS.maxAssistantMessageLength);
function bounded(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  let out = entries.map(entry => entry.role === 'assistant' ? { role: entry.role, text: redact(entry.text) } : entry)
    .slice(-COPILOT_V2_LIMITS.maxTranscriptMessages);
  const size = (list: readonly TranscriptEntry[]) => list.reduce((total, entry) => total + entry.text.length, 0);
  while (out.filter(entry => entry.role === 'user').length > COPILOT_V2_LIMITS.maxUserTurns || size(out) > COPILOT_V2_LIMITS.maxRequestCharacters) out = out.slice(1);
  while (out.length && out[0]!.role !== 'user') out = out.slice(1);
  return out;
}
const withUser = (state: CopilotConversation, text: string): CopilotConversation => ({ ...state, draft: null,
  segment: [...state.segment, text].slice(-COPILOT_V2_LIMITS.maxSegmentUserTurns), transcript: bounded([...state.transcript, { role: 'user', text }]) });
export const closeSegment = (state: CopilotConversation): CopilotConversation => ({ ...state, segment: [], clarifications: 0, draft: null });
const reply = (kind: CopilotReply['kind'], text: string, extra: Partial<CopilotReply> = {}): CopilotReply => ({ kind, text, notes: [], options: [], ...extra });
/** A turn that ends the open request: proposal, answer, refusal or failure. */
const terminal = (state: CopilotConversation, value: CopilotReply, summary: string): Result =>
  ({ reply: value, next: { ...closeSegment(state), transcript: bounded([...state.transcript, { role: 'assistant', text: summary }]) } });
const failed = (state: CopilotConversation, m: CopilotCopy, message: string): Result =>
  terminal(state, reply('FAILED', /(?:Nothing changed|Nada mudou)\.$/.test(message) ? message : `${message} ${m.nothingChanged}`), COPILOT_TRANSCRIPT.declined + message);
const refused = (state: CopilotConversation, m: CopilotCopy, message: string): Result =>
  terminal(state, reply('UNSUPPORTED', message), COPILOT_TRANSCRIPT.declined + message);
/** A question keeps the request open, up to the clarification budget. */
function question(state: CopilotConversation, m: CopilotCopy, text: string, options: readonly string[], draft: Draft | null): Result {
  if (state.clarifications >= COPILOT_V2_LIMITS.maxClarifications) return failed(state, m, m.tooManyClarifications);
  return { reply: reply('CLARIFICATION', text, { options }),
    next: { ...state, clarifications: state.clarifications + 1, draft: draft && { ...draft, question: text, shown: options },
      transcript: bounded([...state.transcript, { role: 'assistant', text: COPILOT_TRANSCRIPT.asked + text }]) } };
}
export const failureText = (code: string, language: CopilotLanguage, retryAfterSeconds?: number): string => {
  const m = copilotCopy(language);
  return `${m.failures[code] ?? m.failureDefault}${retryAfterSeconds ? m.retryAfter(retryAfterSeconds) : ''}${m.failureSuffix}`;
};

// ── Steps, previews and referents ────────────────────────────────────────────────────────────────────────────────────
const editable = (step: WorkflowStep) => step.kind !== 'TEMPLATE' && step.kind !== 'OTHER';
const previewOf = (env: CopilotEnvironment, command: Command) => editorReducer({ workflow: env.workflow, error: null }, command, env.context);
/** The steps a command would create or change, read from its editor preview. */
function changedSteps(env: CopilotEnvironment, command: Command): WorkflowStep[] {
  const preview = previewOf(env, command);
  if (preview.error || preview.workflow === env.workflow) return [];
  const before = new Map(env.workflow.nodes.map(node => [node.nodeId, JSON.stringify(node)]));
  const changed = new Set(preview.workflow.nodes.filter(node => before.get(node.nodeId) !== JSON.stringify(node)).map(node => node.nodeId));
  return workflowSteps(preview.workflow, env.context).filter(step => changed.has(step.nodeId));
}
const pendingSteps = (env: CopilotEnvironment): WorkflowStep[] => env.pending && env.pending.command.type !== 'REMOVE' ? changedSteps(env, env.pending.command) : [];
/** Records a proposal the user can now see, whoever made it (the Copilot or the exact grammar). */
export function recordProposal(state: CopilotConversation, env: CopilotEnvironment, command: Command, sentence?: string): CopilotConversation {
  if (state.referents[0]?.command === command) return state;
  const step = changedSteps(env, command)[0];
  if (!step) return state;
  return { ...state, referents: [{ command, sentence: sentence ?? stepSummary(step, 'EN'), step }, ...state.referents].slice(0, COPILOT_V2_LIMITS.maxReferents) };
}
/** A referent still names a canonical step only if that step exists unchanged (it was applied and not edited since). */
function appliedStep(referent: CopilotReferent | undefined, steps: readonly WorkflowStep[]): WorkflowStep | null {
  if (!referent || referent.step.detail.type === 'LENDING_COMPOSITION') return null;
  const step = steps.find(item => item.nodeId === referent.step.nodeId);
  return step && JSON.stringify(step.detail) === JSON.stringify(referent.step.detail) ? step : null;
}
const stepLabel = (m: CopilotCopy, step: WorkflowStep, language: CopilotLanguage) => m.stepLabel(step.index, stepSummary(step, language));
const sourceLabel = (m: CopilotCopy, resolved: Resolved, language: CopilotLanguage) => resolved.source === 'PENDING' ? m.fromPending
  : resolved.source === 'REFERENT' ? m.fromEarlier(resolved.referent.sentence) : m.fromStep(resolved.step.index, stepSummary(resolved.step, language));

type Purpose = 'EDIT' | 'REMOVE' | 'REPEAT' | 'REUSE' | 'QUESTION' | 'ANCHOR';
type Resolution = { readonly ok: true; readonly resolved: Resolved } | { readonly ok: false; readonly result: Result };
const ORDINAL_INDEX: Readonly<Record<Exclude<CopilotOrdinal, 'LAST'>, number>> = { FIRST: 0, SECOND: 1, THIRD: 2, FOURTH: 3, FIFTH: 4 };
const pick = <T>(list: readonly T[], ordinal: CopilotOrdinal): T | undefined => ordinal === 'LAST' ? list.at(-1) : list[ORDINAL_INDEX[ordinal]];

/** "it", "the swap", "the second step" → exactly one step, or Flofi's question with concrete step buttons. Never a guess. */
function resolveTarget(target: CopilotTarget, purpose: Purpose, intent: CopilotIntentV2, state: CopilotConversation, env: CopilotEnvironment): Resolution {
  const language = intent.language, m = copilotCopy(language);
  const steps = workflowSteps(env.workflow, env.context);
  const proposed = purpose === 'EDIT' || purpose === 'QUESTION' ? pendingSteps(env) : [];
  const asPending = (step: WorkflowStep): Resolved => ({ source: 'PENDING', step, command: env.pending!.command });
  // A step with a visible pending edit is presented as that proposal: it is the newest state the user sees.
  const latest = (step: WorkflowStep): Resolved => { const p = proposed.find(item => item.nodeId === step.nodeId); return p ? asPending(p) : { source: 'NODE', step }; };
  const stop = (result: Result): Resolution => ({ ok: false, result });
  const found = (resolved: Resolved): Resolution => ({ ok: true, resolved });
  const ask = (candidates: readonly Resolved[], kind: string | null) => stop(question(state, m, kind ? m.whichKind(kind) : m.whichStep,
    candidates.map(item => optionLabel(m, item, language)), { intent, amountFill: false, snapshot: snapshotOf(env),
      options: candidates.map(item => ({ label: optionLabel(m, item, language), fill: { kind: 'TARGET', target: item } })) }));
  const repeat = purpose === 'REPEAT' || purpose === 'REUSE';
  if (target.step === null && target.ordinal === null) {
    if (purpose === 'REMOVE' && env.pending) return stop(refused(state, m, m.pendingOnly));
    if (proposed.length === 1) return found(asPending(proposed[0]!));
    if (proposed.length > 1) return ask(proposed.map(asPending), null);
    if (repeat && state.referents[0]) return found({ source: 'REFERENT', step: state.referents[0].step, referent: state.referents[0] });
    const applied = repeat ? null : appliedStep(state.referents[0], steps);
    if (applied) return found({ source: 'NODE', step: applied });
    const candidates = steps.filter(editable);
    if (candidates.length === 1) return found(latest(candidates[0]!));
    if (!candidates.length) return stop(refused(state, m, repeat ? m.nothingToRepeat : m.noReferent));
    return ask(candidates.map(latest), null);
  }
  if (target.step !== null) {
    const kind = m.kind[target.step]!;
    if (repeat && target.ordinal === null) {
      const referent = state.referents.find(item => item.step.kind === target.step);
      if (referent) return found({ source: 'REFERENT', step: referent.step, referent });
    }
    const existing = steps.filter(step => step.kind === target.step).map(latest);
    const added = proposed.filter(step => step.kind === target.step && !steps.some(item => item.nodeId === step.nodeId)).map(asPending);
    const candidates = [...existing, ...added];
    if (!candidates.length) return stop(refused(state, m, m.noKind(kind)));
    if (target.ordinal !== null) {
      const chosen = pick(candidates, target.ordinal);
      return chosen ? found(chosen) : stop(refused(state, m, m.noOrdinalKind(candidates.length, kind)));
    }
    return candidates.length === 1 ? found(candidates[0]!) : ask(candidates, kind);
  }
  const chosen = pick(steps, target.ordinal!);
  return chosen ? found(latest(chosen)) : stop(refused(state, m, m.noOrdinal(steps.length)));
}
const optionLabel = (m: CopilotCopy, resolved: Resolved, language: CopilotLanguage) =>
  resolved.source === 'PENDING' ? m.pendingOption(stepSummary(resolved.step, language)) : m.stepOption(resolved.step.index, stepSummary(resolved.step, language));

// ── Steps as V1 actions, changes and reuse ───────────────────────────────────────────────────────────────────────────
type Base = { readonly actions: readonly CopilotAction[]; readonly composition: boolean; readonly role: 'SUPPLY' | 'BORROW' | 'SWAP' | null };
type ChangeField = keyof CopilotChanges | 'deposit';
const SWAP_FIELDS: readonly CarriedField[] = ['network', 'inputAsset', 'outputAsset', 'amount', 'slippage'];
const BRIDGE_FIELDS: readonly CarriedField[] = ['sourceNetwork', 'destinationNetwork', 'asset', 'amount', 'slippage', 'routing', 'recipient'];
const LENDING_FIELDS: readonly CarriedField[] = ['network', 'asset', 'amount', 'beneficiary'];
const TRANSFER_FIELDS: readonly CarriedField[] = ['network', 'asset', 'amount', 'recipient'];
const COMPOSITION_FIELDS: readonly CarriedField[] = ['network', 'asset', 'inputAsset', 'outputAsset', 'supplyAmount', 'borrowAmount', 'slippage', 'beneficiary'];
/** The Copilot id of a step's network label (Base Sepolia, Ethereum Sepolia, BUILD-BASE-001 Base, Robinhood Chain, …), from the network registry. */
const lendingNetworkOf = (network: string): CopilotNetwork => (networkIdentity(network)?.copilot ?? 'OTHER') as CopilotNetwork;
/** Catalog-pool fee tiers as the user writes them (3000 → "0.3"). */
const FEE_PERCENT: Readonly<Record<number, CopilotFeeTier>> = { 100: '0.01', 500: '0.05', 3000: '0.3', 10000: '1' };
/** A neutral label ("Token", "Stock Token") means the current catalog does not resolve the asset: never re-authored from a guess. */
const unresolved = (...symbols: readonly string[]) => symbols.some(symbol => symbol === 'Token' || symbol === 'Stock Token');
/** A step's typed IR fields as the V1 action that would author it again; null for steps the Copilot does not re-author. */
function stepAction(step: WorkflowStep): Base | null {
  const d = step.detail;
  const solana = (symbol: string) => (symbol === 'devUSDC' ? 'DEVUSDC' : symbol) as CopilotSwapAction['inputAsset'];
  switch (d.type) {
    case 'EVM_SWAP': return { composition: false, role: null, actions: [{ type: 'SWAP', network: d.network === 'Base' ? 'BASE' : d.network === 'Ethereum Sepolia' ? 'ETHEREUM_SEPOLIA' : 'BASE_SEPOLIA', inputAsset: d.from,
      outputAsset: d.to, amount: d.amount, slippageBps: d.slippage }] };
    case 'SOLANA_SWAP': return { composition: false, role: null, actions: [{ type: 'SWAP', network: d.input.network === 'Solana' ? 'SOLANA' : 'SOLANA_DEVNET',
      inputAsset: solana(d.input.from), outputAsset: solana(d.input.to), amount: d.input.amount, slippageBps: d.input.slippage }] };
    // BUILD-BASE-001: every Router route, from the route registry (Robinhood Chain routes and Arbitrum One → Base included).
    case 'ROUTER': { const option = ROUTER_NETWORK_OPTIONS[d.network];
      return { composition: false, role: null, actions: [{ type: 'BRIDGE', sourceNetwork: lendingNetworkOf(option.sourceLabel), destinationNetwork: lendingNetworkOf(option.destinationLabel),
      asset: d.input.token, amount: d.input.amount, slippageBps: d.input.slippage,
      routing: d.input.routing === 'AUTO' ? null : d.input.routing, recipient: d.input.recipient ? d.input.recipient.toLowerCase() : null }] }; }
    case 'AAVE': return { composition: false, role: null, actions: [{ type: d.operation, protocol: 'AAVE_V3', network: lendingNetworkOf(d.input.network), asset: d.input.asset,
      amount: d.input.amount, beneficiary: d.input.beneficiary.toLowerCase() }] };
    case 'AAVE_WITHDRAW': return { composition: false, role: null, actions: [{ type: 'WITHDRAW', protocol: 'AAVE_V3', network: lendingNetworkOf(d.input.network), asset: d.input.asset,
      amount: d.input.amount, beneficiary: null }] };
    // BUILD-BASE-001: catalog networks (Base, Robinhood Chain): swaps, positions and transfers re-authored through the same exact grammar.
    case 'CATALOG_SWAP': if (unresolved(d.from, d.to)) return null;
      return { composition: false, role: null, actions: [{ type: 'SWAP', network: lendingNetworkOf(d.network), inputAsset: d.from, outputAsset: d.to, amount: d.amount,
      slippageBps: d.slippage }] };
    case 'CATALOG_LIQUIDITY': if (unresolved(d.input.tokenA, d.input.tokenB)) return null;
      return { composition: false, role: null, actions: [{ type: 'LIQUIDITY', protocol: 'UNISWAP_V3', network: lendingNetworkOf(d.input.network),
      deposits: [{ asset: d.input.tokenA, maxAmount: d.input.amountA }, { asset: d.input.tokenB, maxAmount: d.input.amountB }], rangeUnit: d.fullRange ? 'FULL' : 'TICK',
      lower: d.fullRange ? null : d.input.lower ?? null, upper: d.fullRange ? null : d.input.upper ?? null, slippageBps: d.input.slippage, feeTier: FEE_PERCENT[d.input.fee] ?? null }] };
    case 'TRANSFER': if (unresolved(d.input.asset) || !networkIdentity(d.input.network)?.catalog) return null;
      return { composition: false, role: null, actions: [{ type: 'TRANSFER', network: lendingNetworkOf(d.input.network), asset: d.input.asset, amount: d.input.amount,
      recipient: d.input.recipient === 'CONNECTED_OWNER' ? null : d.input.recipient.toLowerCase() }] };
    case 'UNISWAP_LIQUIDITY': return { composition: false, role: null, actions: [{ type: 'LIQUIDITY', protocol: 'UNISWAP_V3', network: lendingNetworkOf(d.input.network),
      deposits: [{ asset: 'USDC', maxAmount: d.input.maxUsdc }, { asset: 'WETH', maxAmount: d.input.maxWeth }], rangeUnit: d.input.rangeUnit, lower: d.input.lower,
      upper: d.input.upper, slippageBps: d.input.slippage }] };
    case 'ORCA_LIQUIDITY': return { composition: false, role: null, actions: [{ type: 'LIQUIDITY', protocol: 'ORCA', network: 'SOLANA_DEVNET',
      deposits: [{ asset: 'SOL', maxAmount: d.input.maxSol }, { asset: 'DEVUSDC', maxAmount: d.input.maxDevUsdc }], rangeUnit: d.input.rangeUnit, lower: d.input.lower,
      upper: d.input.upper, slippageBps: d.input.slippage }] };
    case 'LENDING_COMPOSITION': {
      const owner = d.input.owner.toLowerCase();
      const lending = (type: 'SUPPLY' | 'BORROW', amount: string): CopilotLendingAction => ({ type, protocol: 'AAVE_V3', network: 'BASE_SEPOLIA', asset: 'USDC', amount, beneficiary: owner });
      return { composition: true, role: d.role, actions: [lending('SUPPLY', d.input.supply), lending('BORROW', d.input.borrow),
        { type: 'SWAP', network: 'BASE_SEPOLIA', inputAsset: 'USDC', outputAsset: 'WETH', amount: d.input.borrow, slippageBps: d.input.slippage }] };
    }
    default: return null;
  }
}
function allFields(base: Base): Set<CarriedField> {
  if (base.composition) return new Set(COMPOSITION_FIELDS);
  const action = base.actions[0]!;
  if (action.type === 'SWAP') return new Set(SWAP_FIELDS);
  if (action.type === 'BRIDGE') return new Set(BRIDGE_FIELDS);
  if (action.type === 'TRANSFER') return new Set(TRANSFER_FIELDS);
  if (action.type === 'LIQUIDITY') return new Set<CarriedField>(['protocol', 'network', 'range', 'slippage', ...action.feeTier !== undefined ? ['feeTier' as const] : [],
    ...action.deposits.map(d => `deposit:${poolSymbol(action, d.asset)}` as CarriedField)]);
  return new Set(LENDING_FIELDS);
}
/** A deposit's pool token: the fixed test pools map their aliases; a catalog pool (BUILD-BASE-001) takes the catalog's own spelling. */
const poolSymbol = (action: Extract<CopilotAction, { type: 'LIQUIDITY' }>, asset: string) => {
  const network = action.network !== null && action.network !== 'OTHER' ? networkOfCopilot(action.network) : null;
  return network?.catalog ? canonicalSymbol(network.chain, asset) ?? asset : COPILOT_POOLS[action.protocol === 'ORCA' ? 'ORCA' : 'UNISWAP_V3'].symbol(asset);
};
const CARRIED_LABEL: Readonly<Record<string, CarriedLabel>> = { network: 'network', sourceNetwork: 'network', destinationNetwork: 'destination', asset: 'token',
  inputAsset: 'token', outputAsset: 'token', amount: 'amount', supplyAmount: 'amount', borrowAmount: 'amount', slippage: 'slippage', recipient: 'recipient',
  beneficiary: 'beneficiary', routing: 'routing', range: 'range' };
const carriedLabels = (m: CopilotCopy, carried: ReadonlySet<CarriedField>) =>
  [...new Set([...carried].flatMap(field => field.startsWith('deposit:') ? ['maxima' as const] : field.startsWith('asset:') ? ['token' as const]
    : CARRIED_LABEL[field] ? [CARRIED_LABEL[field]!] : []))].map(label => m.carriedLabel[label]);

type Applied = { readonly ok: true; readonly base: Base; readonly carried: Set<CarriedField>; readonly changed: readonly string[] } | { readonly ok: false; readonly field: ChangeField };
/** Only the changed fields leave the carried set; each of them must then be grounded in the open request by the planners. */
function applyChanges(base: Base, changes: CopilotChanges): Applied {
  const carried = allFields(base), changed: string[] = [];
  let actions = base.actions.map(action => ({ ...action })) as CopilotAction[];
  const set = (index: number, key: string, value: unknown) => { actions = actions.map((item, at) => at === index ? { ...item, [key]: value } as CopilotAction : item); };
  const drop = (...fields: CarriedField[]) => fields.forEach(field => carried.delete(field));
  const entries = (Object.keys(changes) as (keyof CopilotChanges)[]).filter(key => key === 'deposits' ? changes.deposits.length > 0 : key === 'lower' || key === 'upper' ? false
    : changes[key] !== null && changes[key] !== undefined);
  for (const key of entries) {
    const action = actions[0]!, type = base.composition ? 'COMPOSITION' : action.type;
    const fail = (): Applied => ({ ok: false, field: key });
    switch (key) {
      case 'amount':
        if (type === 'LIQUIDITY') return fail();
        if (type === 'COMPOSITION') {
          if (base.role === 'SWAP') return { ok: false, field: 'deposit' };
          if (base.role === 'SUPPLY') { set(0, 'amount', changes.amount); drop('supplyAmount'); }
          else { set(1, 'amount', changes.amount); set(2, 'amount', changes.amount); drop('borrowAmount'); }
        } else { set(0, 'amount', changes.amount); drop('amount'); }
        break;
      case 'slippageBps':
        if (type === 'COMPOSITION') set(2, 'slippageBps', changes.slippageBps); else if (type === 'SWAP' || type === 'BRIDGE' || type === 'LIQUIDITY') set(0, 'slippageBps', changes.slippageBps);
        else return fail();
        drop('slippage'); break;
      case 'network':
        if (type === 'BRIDGE') { set(0, 'sourceNetwork', changes.network); drop('sourceNetwork'); }
        else if (type === 'COMPOSITION') return fail();
        else { set(0, 'network', changes.network); drop('network'); }
        break;
      case 'destinationNetwork': if (type !== 'BRIDGE') return fail(); set(0, 'destinationNetwork', changes.destinationNetwork); drop('destinationNetwork'); break;
      case 'inputAsset': case 'outputAsset':
        if (type === 'SWAP') { set(0, key, changes[key]); drop(key); }
        else if (type === 'BRIDGE' || type === 'SUPPLY' || type === 'BORROW' || type === 'REPAY' || type === 'WITHDRAW' || type === 'TRANSFER') { set(0, 'asset', changes[key]); drop('asset'); }
        else return fail();
        break;
      case 'recipient':
        if (type === 'BRIDGE' || type === 'TRANSFER') { set(0, 'recipient', changes.recipient); drop('recipient'); }
        else if (type === 'COMPOSITION') { set(0, 'beneficiary', changes.recipient); set(1, 'beneficiary', changes.recipient); drop('beneficiary'); }
        else if (type === 'SUPPLY' || type === 'BORROW' || type === 'REPAY' || type === 'WITHDRAW') { set(0, 'beneficiary', changes.recipient); drop('beneficiary'); }
        else return fail();
        break;
      case 'routing': if (type !== 'BRIDGE') return fail(); set(0, 'routing', changes.routing); drop('routing'); break;
      case 'feeTier': if (type !== 'LIQUIDITY') return fail(); set(0, 'feeTier', changes.feeTier); drop('feeTier'); break;
      case 'rangeUnit':
        if (type !== 'LIQUIDITY') return fail();
        set(0, 'rangeUnit', changes.rangeUnit); set(0, 'lower', changes.lower); set(0, 'upper', changes.upper); drop('range'); break;
      case 'deposits': {
        if (type !== 'LIQUIDITY') return fail();
        const liquidity = actions[0] as Extract<CopilotAction, { type: 'LIQUIDITY' }>;
        let deposits = [...liquidity.deposits];
        for (const deposit of changes.deposits) {
          const symbol = poolSymbol(liquidity, deposit.asset);
          if (!symbol) return fail();
          deposits = deposits.map(item => poolSymbol(liquidity, item.asset) === symbol ? { asset: deposit.asset, maxAmount: deposit.maxAmount } : item);
          drop(`deposit:${symbol}`);
        }
        set(0, 'deposits', deposits); break;
      }
    }
    changed.push(key);
  }
  return { ok: true, base: { ...base, actions }, carried, changed };
}
/** Values the user asked to reuse ("the same network"), copied from the resolved step into fields the user left unstated. */
function applyReuse(action: CopilotAction, from: Base, fields: readonly CopilotReuseField[]): { readonly action: CopilotAction; readonly carried: Set<CarriedField> } {
  const source = from.composition ? null : from.actions[0]!, carried = new Set<CarriedField>();
  if (!source) return { action, carried };
  const sourceNetwork = (): CopilotNetwork | null => source.type === 'BRIDGE' ? null : source.network;
  const sourceAsset = () => source.type === 'SWAP' ? source.inputAsset : source.type === 'LIQUIDITY' ? null : source.asset;
  const sourceAmount = () => source.type === 'LIQUIDITY' ? null : source.amount;
  let out = { ...action } as Record<string, unknown>;
  const fill = (key: string, value: unknown, field: CarriedField) => { if (value !== null && value !== undefined && key in out && out[key] === null) { out = { ...out, [key]: value }; carried.add(field); } };
  for (const field of fields) {
    if (field === 'network' && action.type === 'BRIDGE') fill('sourceNetwork', source.type === 'BRIDGE' ? source.sourceNetwork : sourceNetwork(), 'sourceNetwork');
    else if (field === 'network') fill('network', sourceNetwork(), 'network');
    if (field === 'destination' && action.type === 'BRIDGE' && source.type === 'BRIDGE') fill('destinationNetwork', source.destinationNetwork, 'destinationNetwork');
    if (field === 'asset' && action.type === 'LIQUIDITY' && source.type === 'SWAP') {
      // "Add liquidity with the same tokens": the swap's pair names the pool (Orca SOL/devUSDC on Solana Devnet, Uniswap v3 USDC/WETH on a test network).
      const pair = [source.inputAsset, source.outputAsset].map(asset => (asset ?? '').toUpperCase()).sort().join('/');
      const pool = source.network === 'SOLANA_DEVNET' && pair === 'DEVUSDC/SOL' ? { protocol: 'ORCA', network: source.network, symbols: ['SOL', 'devUSDC'] }
        : (source.network === 'BASE_SEPOLIA' || source.network === 'ETHEREUM_SEPOLIA') && ['USDC/WETH', 'ETH/USDC'].includes(pair)
          ? { protocol: 'UNISWAP_V3', network: source.network, symbols: ['USDC', 'WETH'] } : null;
      if (pool) { fill('protocol', pool.protocol, 'protocol'); fill('network', pool.network, 'network'); pool.symbols.forEach(symbol => carried.add(`asset:${symbol}`)); }
    } else if (field === 'asset') {
      if (action.type === 'SWAP' && source.type === 'SWAP') { fill('inputAsset', source.inputAsset, 'inputAsset'); fill('outputAsset', source.outputAsset, 'outputAsset'); }
      else if (action.type === 'SWAP') fill('inputAsset', sourceAsset(), 'inputAsset');
      else fill('asset', sourceAsset(), 'asset');
    }
    if (field === 'amount') fill('amount', sourceAmount(), 'amount');
    if (field === 'slippage') fill('slippageBps', source.type === 'SWAP' || source.type === 'BRIDGE' || source.type === 'LIQUIDITY' ? source.slippageBps : null, 'slippage');
    if (field === 'recipient' && (action.type === 'BRIDGE' || action.type === 'TRANSFER'))
      fill('recipient', source.type === 'BRIDGE' || source.type === 'TRANSFER' ? source.recipient : null, 'recipient');
    else if (field === 'recipient') fill('beneficiary', source.type !== 'SWAP' && source.type !== 'BRIDGE' && source.type !== 'LIQUIDITY' && source.type !== 'TRANSFER'
      ? source.beneficiary : null, 'beneficiary');
  }
  return { action: out as CopilotAction, carried };
}

// ── Deterministic answers to Flofi's own questions ───────────────────────────────────────────────────────────────────
const NETWORK_BY_LABEL = new Map<string, CopilotNetwork>(Object.entries(COPILOT_NETWORK_LABEL).map(([network, label]) => [normalize(label), network as CopilotNetwork]));
/** The deterministic meaning of each button Flofi offered for a new action; buttons without one go to the model like typed text. */
function actionFills(intent: CopilotIntentV2, missing: readonly string[], options: readonly string[]): Draft['options'] {
  if (intent.kind !== 'ACTION') return [];
  const action = intent.action, en = copilotCopy('EN'), pt = copilotCopy('PT');
  const out: { label: string; fill: DraftFill }[] = [];
  for (const label of options) {
    const patch = ((): Record<string, unknown> | null => {
      const parts = label.split('→').map(normalize), networks = parts.map(part => NETWORK_BY_LABEL.get(part) ?? null);
      if (action.type === 'BRIDGE') {
        const routing = [en.routingOptions, pt.routingOptions].map(list => list.map(normalize).indexOf(normalize(label))).find(index => index >= 0);
        if (routing !== undefined) return { routing: [null, 'LIFI', 'ACROSS'][routing] };
        if (networks.length === 2 && networks.every(Boolean)) return { sourceNetwork: networks[0], destinationNetwork: networks[1] };
        if (networks.length === 1 && networks[0]) return /^ARBITRUM/.test(networks[0]) ? missing.includes('destinationNetwork') ? { destinationNetwork: networks[0] } : null
          : missing.includes('sourceNetwork') ? { sourceNetwork: networks[0] } : null;
        return null;
      }
      if (action.type === 'LIQUIDITY') {
        const pool = [en.poolOptions, pt.poolOptions].map(list => list.map(normalize).indexOf(normalize(label))).find(index => index >= 0);
        if (pool !== undefined) return pool === 0 ? { protocol: 'UNISWAP_V3', network: 'BASE_SEPOLIA' } : pool === 2 ? { protocol: 'UNISWAP_V3', network: 'ETHEREUM_SEPOLIA' }
          : { protocol: 'ORCA', network: 'SOLANA_DEVNET' };
      }
      if (networks.length === 1 && networks[0] && missing.includes('network')) return { network: networks[0] };
      if (/^(?:usdc|wbtc)$/.test(normalize(label)) && missing.includes('asset') && action.type !== 'SWAP' && action.type !== 'LIQUIDITY')
        return { asset: normalize(label) === 'wbtc' ? 'WBTC' : 'USDC' };
      return null;
    })();
    if (patch) out.push({ label, fill: { kind: 'ACTION', patch } });
  }
  return out;
}
/** A reply that is only a number answers Flofi's amount question, when it has exactly one reading. */
function bareAmount(text: string): string | null {
  const match = /^\s*(\d+(?:[.,]\d+)*)\s*(?:usdc|weth|eth|sol|usdt|devusdc)?\s*[.!]?\s*$/i.exec(text);
  const readings = match ? amountReadings(match[1]!) : [];
  return readings.length === 1 && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(readings[0]!) && readings[0]!.length <= COPILOT_LIMITS.maxValueLength ? readings[0]! : null;
}
/** A bare amount that answers Flofi's question for one pool token's maximum becomes that deposit of the request's liquidity step. */
function patchDeposit(intent: CopilotIntentV2, asset: 'SOL' | 'devUSDC', maxAmount: string): CopilotIntentV2 {
  const add = (action: CopilotAction): CopilotAction => action.type !== 'LIQUIDITY' ? action
    : { ...action, deposits: [...action.deposits.filter(d => COPILOT_POOLS.ORCA.symbol(d.asset) !== asset), { asset: asset === 'SOL' ? 'SOL' : 'DEVUSDC', maxAmount }] };
  return intent.kind === 'ACTION' ? { ...intent, action: add(intent.action) } : intent.kind === 'COMPOSITION' ? { ...intent, actions: intent.actions.map(add) } : intent;
}
// "yes"/"no" as a whole message. Flofi never applies, signs or guesses from them: yes picks the single deterministic answer to Flofi's own open question.
const YES = /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|confirm(?:ed)?|go ahead|do it|sim|claro|pode(?: ser)?|isso|confirmo|beleza|manda)\s*[.!]?\s*$/i;
const NO = /^\s*(?:no|nope|nah|cancel|stop|n[ãa]o|cancela(?:r)?|deixa(?: pra l[áa])?)\s*[.!]?\s*$/i;
function yesOrNo(state: CopilotConversation, text: string, env: CopilotEnvironment, m: CopilotCopy): TurnStart | { readonly pick: string } | null {
  const yes = YES.test(text), no = !yes && NO.test(text);
  if (!yes && !no) return null;
  const local = (value: CopilotReply, next: CopilotConversation): TurnStart => ({ kind: 'LOCAL', reply: value, next });
  const draft = state.draft;
  if (draft) {
    if (no) return local(reply('ANSWER', m.noDropped), closeSegment(state));
    const shown = draft.shown ?? draft.options.map(option => option.label);
    if (draft.options.length === 1 && shown.length === 1 && !draft.amountFill) return { pick: draft.options[0]!.label };
    return local(reply('CLARIFICATION', shown.length ? m.yesWhich : draft.question ?? m.yesWhich, { options: shown }), state);
  }
  // The model asked its own question: it reads the answer in context.
  if (state.clarifications > 0) return null;
  return local(reply('ANSWER', yes ? env.pending ? m.yesPending : m.yesNothingOpen : env.pending ? m.noPending : m.noDropped), closeSegment(state));
}
function patchIntent(intent: CopilotIntentV2, patch: Readonly<Record<string, unknown>>): CopilotIntentV2 {
  if (intent.kind !== 'ACTION') return intent;
  const action = { ...intent.action } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) if (key in action) action[key] = value;
  return { ...intent, action: action as CopilotAction };
}

// ── Turns ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Starts a user turn: a local answer (input refused, secret, or a reply to Flofi's own question) or a request for the model. */
export function startTurn(state: CopilotConversation, raw: string, env: CopilotEnvironment): TurnStart {
  const text = typeof raw === 'string' ? raw.trim() : '', m = copilotCopy(state.language);
  if (!text || text.length > COPILOT_LIMITS.maxUserMessageLength || hasUnsafeCharacters(text))
    return { kind: 'LOCAL', reply: reply('FAILED', failureText('COPILOT_INPUT_INVALID', state.language)), next: state };
  // No model runs for a secret, so its language comes from the conversation or from the Portuguese wording that matched.
  if (looksSecret(text)) return { kind: 'LOCAL', reply: reply('UNSUPPORTED', /chaves?\s+privad|frases?\s+(?:semente|secreta|de\s+recupera)|palavras\s+secretas/i.test(text)
    ? copilotCopy('PT').secret : m.secret), next: state };
  const answered = yesOrNo(state, text, env, m);
  if (answered && !('pick' in answered)) return answered;
  const draft = state.draft, picked = answered ? answered.pick : text;
  if (draft) {
    const option = draft.options.find(item => normalize(item.label) === normalize(picked));
    const amount = !option && (draft.amountFill || draft.depositFill) ? bareAmount(text) : null;
    if (option || amount) {
      if (contextChange(draft.snapshot, snapshotOf(env))) return { kind: 'LOCAL', ...failed(closeSegment(state), m, m.draftStale) };
      // "Yes" to a question with exactly one offered answer is that answer, in Flofi's own words.
      const next = withUser(state, picked), extras = draft.extras ?? {};
      if (option?.fill.kind === 'TARGET') return { kind: 'LOCAL', ...resolveIntent(draft.intent, next, env, option.fill.target, extras) };
      if (option?.fill.kind === 'EXTRAS') return { kind: 'LOCAL', ...resolveIntent(draft.intent, next, env, null, { ...extras, ...option.fill.extras }) };
      if (!option && draft.depositFill) return { kind: 'LOCAL', ...resolveIntent(patchDeposit(draft.intent, draft.depositFill, amount!), next, env, null,
        { ...extras, carried: [...extras.carried ?? [], `asset:${draft.depositFill}`] }) };
      const intent = option?.fill.kind === 'ACTION' ? patchIntent(draft.intent, option.fill.patch) : patchIntent(draft.intent, { amount });
      return { kind: 'LOCAL', ...resolveIntent(intent, next, env, null, extras) };
    }
  }
  const next = withUser(state, text);
  return { kind: 'REMOTE', request: { version: '2', messages: next.transcript }, turn: { before: state, state: next, snapshot: snapshotOf(env) } };
}
/** Finishes a model turn against the current state. A changed workflow, proposal or wallet discards the answer. */
export function finishTurn(turn: PendingTurn, result: CopilotResultV2, env: CopilotEnvironment): Result {
  const language = turn.state.language, m = copilotCopy(language), rollback = closeSegment(turn.before);
  const change = contextChange(turn.snapshot, snapshotOf(env));
  if (change) return { reply: reply('FAILED', change === 'WORKFLOW' ? m.workflowChanged : change === 'PROPOSAL' ? m.proposalChanged : m.walletChanged), next: rollback };
  if (!result.ok) return { reply: reply('FAILED', failureText(result.code, language, result.retryAfterSeconds)), next: rollback };
  let intent: CopilotIntentV2;
  try { intent = parseCopilotIntentV2(result.intent); }
  catch (cause) { return { reply: reply('FAILED', failureText(isCopilotIntentError(cause) && cause.message === 'COPILOT_TOO_MANY_ACTIONS' ? cause.message : 'COPILOT_INTENT_INVALID', language)), next: rollback }; }
  return resolveIntent(intent, { ...turn.state, language: intent.language }, env, null, {});
}

/** One validated intent → reply and next state. `forced` is a step the user picked from Flofi's own buttons. */
function resolveIntent(intent: CopilotIntentV2, state: CopilotConversation, env: CopilotEnvironment, forced: Resolved | null, extras: Extras): Result {
  const language = intent.language, m = copilotCopy(language);
  const target = (value: CopilotTarget, purpose: Purpose): Resolution => forced ? { ok: true, resolved: forced } : resolveTarget(value, purpose, intent, state, env);
  switch (intent.kind) {
    case 'AUTOMATION': {
      const automation = groundAutomationDraft(intent.draft, segmentText(state), env.timezone ?? 'UTC', Date.now(), language);
      if (automation.kind === 'PROPOSAL') return terminal(state, reply('AUTOMATION_PROPOSAL', 'Review this automation proposal. Nothing is created until you choose Create automation.', { automation: automation.input }), COPILOT_TRANSCRIPT.proposed + automation.input.name);
      if (automation.kind === 'CLARIFICATION') return question(state, m, automation.message, [], null);
      return refused(state, m, automation.message);
    }

    // PR B: a short, contextual reason; the full capability list is only the answer to a CAPABILITIES question.
    case 'UNSUPPORTED': return refused(state, m, safeCopilotProse(intent.reason) ?? m.cannotAuthor);
    case 'POSITION': return resolvePosition(intent, state, env, extras);
    case 'CLARIFICATION_REQUIRED': {
      const text = safeCopilotProse(intent.question) ?? m.stillNeeds(m.subject.request, intent.missing.filter(field => field !== 'target').map(field => m.field[field as keyof typeof m.field]));
      return question(state, m, text, intent.options.flatMap(option => safeCopilotProse(option) ?? []), null);
    }
    case 'QUESTION': {
      let step: WorkflowStep | null = null;
      if (intent.target !== null || intent.topic === 'STEP_DETAIL') {
        const resolution = target(intent.target ?? { step: null, ordinal: null }, 'QUESTION');
        if (!resolution.ok) return resolution.result;
        step = resolution.resolved.step;
      }
      const answer = answerQuestion(intent.topic, step, env.facts, language);
      return terminal(state, reply('ANSWER', answer.text, { notes: answer.notes, topic: intent.topic }), m.answered(intent.topic));
    }
    case 'ACTION': case 'COMPOSITION': {
      let actions = intent.kind === 'ACTION' ? [intent.action] : intent.actions;
      const carried = new Set<CarriedField>(extras.carried ?? []);
      let notes: string[] = [];
      if (intent.kind === 'ACTION' && intent.reuse && REUSE_CUE.test(segmentText(state))) {
        const resolution = target(intent.reuse.from, 'REUSE');
        if (!resolution.ok) return resolution.result;
        const from = stepAction(resolution.resolved.step);
        if (from) {
          const reused = applyReuse(intent.action, from, intent.reuse.fields);
          actions = [reused.action]; reused.carried.forEach(field => carried.add(field));
          if (reused.carried.size) notes = [m.carried(sourceLabel(m, resolution.resolved, language), carriedLabels(m, reused.carried))];
        }
      }
      const liquidity = intent.kind === 'ACTION' && intent.action.type === 'LIQUIDITY' ? intent.action : null;
      // "With these tokens": the swap whose actual output funds the position, resolved from FloFi's own state (a visible swap proposal or a swap step).
      let swap: SwapSource | null = extras.swap ?? null;
      if (liquidity?.funding === 'SWAP_OUTPUT' && !swap) {
        const found = swapSourceFor(intent, state, env, extras);
        if (!found.ok) return found.result;
        swap = found.source;
      }
      // "The remaining tokens": only what a reconciled execution left over; never a balance or an estimate.
      if (liquidity?.funding === 'REMAINING') {
        const remaining = env.verified?.remaining ?? [];
        if (!remaining.length) return question(state, m, m.remainingUnavailable, [], null);
        const deposits = [...liquidity.deposits.filter(deposit => !remaining.some(item => COPILOT_POOLS.ORCA.symbol(deposit.asset) === item.token)),
          ...remaining.map(item => {
            const explicit = liquidity.deposits.find(deposit => COPILOT_POOLS.ORCA.symbol(deposit.asset) === item.token);
            const decimals = item.token === 'SOL' ? 9 : 6;
            const cap = explicit && groundedAmount(segmentText(state), explicit.maxAmount) ? BigInt(parseTokenAmount(explicit.maxAmount, decimals)) : null;
            const received = BigInt(parseTokenAmount(item.amount, decimals));
            return { asset: item.token === 'SOL' ? 'SOL' : 'DEVUSDC', maxAmount: cap !== null && cap < received ? explicit!.maxAmount : item.amount };
          })];
        actions = [{ ...liquidity, protocol: 'ORCA', network: 'SOLANA_DEVNET', deposits, funding: null }];
        for (const field of ['protocol', 'network', ...remaining.map(item => `deposit:${item.token}`)] as CarriedField[]) carried.add(field);
        notes = [...notes, ...remaining.map(item => m.remainingNote(item.amount, item.token))];
      }
      return author(intent, actions, intent.kind === 'COMPOSITION', carried, state, env, notes, sentence => m.interpreted(sentence), m.subject.composition, null, swap, extras);
    }
    case 'EDIT': case 'REPEAT': {
      if (intent.kind === 'REPEAT' && !REPEAT_CUE.test(segmentText(state))) return refused(state, m, m.repeatNeedsCue);
      const resolution = target(intent.target, intent.kind === 'EDIT' ? 'EDIT' : 'REPEAT');
      if (!resolution.ok) return resolution.result;
      const resolved = resolution.resolved, label = resolved.source === 'PENDING' ? m.sourcePending : stepLabel(m, resolved.step, language);
      const base = stepAction(resolved.step);
      if (!base) return refused(state, m, m.refusal.STEP_NOT_EDITABLE(label));
      const applied = applyChanges(base, intent.changes);
      if (!applied.ok) return refused(state, m, applied.field === 'deposit' ? m.compositionSwapAmount
        : m.changeNotApplicable(m.carriedLabel[CARRIED_LABEL[applied.field] ?? (applied.field === 'deposits' ? 'maxima' : 'range')], label));
      const notes = applied.carried.size ? [m.carried(sourceLabel(m, resolved, language), carriedLabels(m, applied.carried))] : [];
      if (intent.kind === 'REPEAT') return author(intent, applied.base.actions, applied.base.composition, applied.carried, state, env, notes, sentence => m.interpreted(sentence), label);
      const revising = resolved.source === 'PENDING' && (resolved.command.type.startsWith('ADD_') || resolved.command.type === 'AUTHOR_LENDING');
      return author(intent, applied.base.actions, applied.base.composition, applied.carried, state, env, notes,
        sentence => revising ? m.interpretedRevision(sentence) : m.interpretedEdit(label, sentence), label, revising ? null : resolved.step.nodeId, null, extras);
    }
    case 'REMOVE': {
      const resolution = target(intent.target, 'REMOVE');
      if (!resolution.ok) return resolution.result;
      const resolved = resolution.resolved, label = stepLabel(m, resolved.step, language);
      if (resolved.source === 'PENDING') return refused(state, m, m.pendingOnly);
      const plan = removeCommandFor(env.workflow, env.context, resolved.step.nodeId, env.workflow.revision);
      if (!plan.ok) return refused(state, m, m.refusal[plan.code as keyof typeof m.refusal]?.(label) ?? m.rejectedCode(plan.code));
      return propose(state, env, plan.command, `remove ${stepLabel(copilotCopy('EN'), resolved.step, 'EN')}`, m.interpretedRemove(label), [], label);
    }
    case 'INSERT': {
      const resolution = target(intent.anchor, 'ANCHOR');
      if (!resolution.ok) return resolution.result;
      return refused(state, m, m.insertUnsupported);
    }
  }
}

// ── PR B: the swap behind "these tokens", and FloFi-registered positions ─────────────────────────────────────────────
type SwapFound = { readonly ok: true; readonly source: SwapSource } | { readonly ok: false; readonly result: Result };
/**
 * "With these tokens": the Solana Devnet swap whose actual output funds the position — the visible swap proposal (authored again together with the
 * position) or a swap step that does not fund a position yet. The step the user saw last wins; otherwise one candidate, or Flofi's buttons.
 */
function swapSourceFor(intent: CopilotIntentV2, state: CopilotConversation, env: CopilotEnvironment, extras: Extras): SwapFound {
  const m = copilotCopy(intent.language);
  const pending = env.pending?.command.type === 'ADD_SOLANA_SWAP' && env.pending.command.input.network === 'Solana Devnet' ? env.pending.command.input : null;
  if (pending) return { ok: true, source: { kind: 'NEW', input: pending } };
  const funded = new Set(env.workflow.nodes.flatMap(node => { const source = solanaLiquidityDetails(node)?.source; return source ? [source.nodeId] : []; }));
  const swaps = workflowSteps(env.workflow, env.context).flatMap(step => step.detail.type === 'SOLANA_SWAP' && step.detail.input.network === 'Solana Devnet' ? [step] : []);
  const open = swaps.filter(step => !funded.has(step.nodeId)).map(step => ({ step, source: { kind: 'STEP' as const, nodeId: step.nodeId,
    input: (step.detail as Extract<WorkflowStep['detail'], { type: 'SOLANA_SWAP' }>).input } }));
  const last = state.referents[0], recent = last && open.find(item => item.step.nodeId === last.step.nodeId && JSON.stringify(item.step.detail) === JSON.stringify(last.step.detail));
  if (recent) return { ok: true, source: recent.source };
  if (open.length === 1) return { ok: true, source: open[0]!.source };
  if (!open.length) return { ok: false, result: refused(state, m, swaps.length ? m.swapAlreadyLinked : m.noSwapForTokens) };
  const options = open.slice(0, COPILOT_LIMITS.maxOptions).map(item => ({ label: m.stepOption(item.step.index, stepSummary(item.step, intent.language)),
    fill: { kind: 'EXTRAS' as const, extras: { ...extras, swap: item.source } } }));
  return { ok: false, result: question(state, m, m.whichSwap, options.map(option => option.label), { intent, options, amountFill: false, snapshot: snapshotOf(env), extras }) };
}

const ORCA = ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY;
/** A position's principal at the verified current tick, rounded up and bounded at both ends of that tick, within the Devnet token maxima. */
function positionPrincipal(position: CopilotPosition, tick: number): { readonly maxSol: string; readonly maxDevUsdc: string } {
  const liquidity = BigInt(position.liquidity ?? '0');
  const at = (t: number) => orcaLiquidityAmounts({ tickCurrentIndex: t, sqrtPrice: orcaSqrtPriceAtTick(t) }, position.tickLower!, position.tickUpper!, liquidity, true);
  const [low, high] = [at(tick), at(tick + 1)];
  const bound = (a: bigint, b: bigint, max: string) => { const value = a > b ? a : b; return value > BigInt(max) ? BigInt(max) : value; };
  let sol = bound(low.amount0, high.amount0, ORCA.token0.maximumAmount);
  const usdc = bound(low.amount1, high.amount1, ORCA.token1.maximumAmount);
  if (sol === 0n && usdc === 0n) sol = 1n;
  return { maxSol: formatTokenAmount(sol.toString(), ORCA.token0.decimals), maxDevUsdc: formatTokenAmount(usdc.toString(), ORCA.token1.decimals) };
}
/** "Remove 50% of my liquidity", "exit my position": a FloFi-registered Orca position of the connected Solana Devnet wallet, verified on chain. */
function resolvePosition(intent: Extract<CopilotIntentV2, { kind: 'POSITION' }>, state: CopilotConversation, env: CopilotEnvironment, extras: Extras): Result {
  const m = copilotCopy(intent.language), verified = env.verified, text = segmentText(state);
  if ((intent.protocol !== null && intent.protocol !== 'ORCA') || (intent.network !== null && intent.network !== 'SOLANA_DEVNET')) return refused(state, m, m.positionOnlyOrca);
  if (!verified?.solanaOwner) return refused(state, m, m.positionWalletRequired);
  if (!verified.orcaPositions) return failed(state, m, m.positionsUnavailable);
  const draft = (options: Draft['options']): Draft => ({ intent, options, amountFill: false, snapshot: snapshotOf(env), extras });
  const half = /\b(?:half|metade)\b/i.test(text);
  // The portion is the user's own words ("50%", "half"), EXIT, or one of Flofi's buttons; never a guess.
  let portion: string | null = extras.portion ?? (intent.operation === 'EXIT' ? 'EXIT' : null);
  if (portion === null && intent.percent !== null) {
    const wanted = canonicalDecimal(intent.percent);
    if ((wanted === '50' && half) || (groundedAmount(text, wanted) && new RegExp(`(?<![\\d.,])${wanted.replace('.', '\\.')}\\s*(?:%|percent|per\\s?cent|por\\s?cento)`, 'i').test(text)))
      portion = wanted;
  }
  if (portion === null && half && intent.operation === 'DECREASE') portion = '50';
  const exiting = portion === 'EXIT';
  const eligible = verified.orcaPositions.filter(p => p.tickLower !== null && p.tickUpper !== null && (p.status === 'ACTIVE' || (exiting && p.status === 'EMPTY')));
  if (!eligible.length) return refused(state, m, m.positionNone);
  const chosen = extras.position ? eligible.find(p => p.positionMint === extras.position) : eligible.length === 1 ? eligible[0] : undefined;
  if (extras.position && !chosen) return failed(closeSegment(state), m, m.draftStale);
  if (!chosen) {
    const options = eligible.slice(0, COPILOT_LIMITS.maxOptions).map(p => ({ label: m.positionOption(p.positionMint, p.tickLower!, p.tickUpper!),
      fill: { kind: 'EXTRAS' as const, extras: { ...extras, position: p.positionMint, ...portion ? { portion } : {} } } }));
    return question(state, m, m.positionWhich, options.map(option => option.label), draft(options));
  }
  if (portion === null) {
    const options = ['25', '50', '75', 'EXIT'].map((value, index) => ({ label: m.positionPortionOptions[index]!,
      fill: { kind: 'EXTRAS' as const, extras: { ...extras, position: chosen.positionMint, portion: value } } }));
    return question(state, m, m.positionPortion, options.map(option => option.label), draft(options));
  }
  let exit = portion === 'EXIT', partBps: number | null = null;
  if (!exit) {
    const value = Number(portion), bps = Math.round(value * 100);
    if (bps === 10_000) exit = true;
    else if (!Number.isFinite(value) || bps < 1 || bps > 9_999 || Math.abs(value * 100 - bps) > 1e-9) return refused(state, m, m.positionPercentInvalid);
    else partBps = bps;
  }
  if (!exit && chosen.status !== 'ACTIVE') return refused(state, m, m.positionNone);
  // The position step keeps an existing position step's maxima and slippage (they only limit adding liquidity); otherwise its own principal.
  const existing = env.workflow.nodes.map(node => solanaLiquidityDetails(node)).find(details => details !== null) ?? null, notes = [m.positionNote];
  let maxima: { readonly maxSol: string; readonly maxDevUsdc: string }, slippage = SOLANA_LIQUIDITY_DEFAULT_SLIPPAGE;
  if (existing) { maxima = { maxSol: existing.maxSol, maxDevUsdc: existing.maxDevUsdc }; slippage = existing.slippage; }
  else {
    if (!verified.orcaPrice) return failed(state, m, m.positionsUnavailable);
    maxima = positionPrincipal(chosen, verified.orcaPrice.tickCurrentIndex); notes.push(m.positionMaximaNote);
  }
  const input: SolanaLiquidityInput = { network: 'Solana Devnet', ...maxima, rangeUnit: 'TICK', lower: String(chosen.tickLower), upper: String(chosen.tickUpper), slippage };
  const command: Command = { type: 'MANAGE_SOLANA_POSITION', input, positionMint: chosen.positionMint, operation: exit ? 'EXIT' : 'DECREASE_PARTIAL', partBps,
    source: 'CHAT', baseRevision: env.workflow.revision };
  if (previewOf(env, command).error?.startsWith('POSITION_WORKFLOW_HAS_OTHER_STEPS')) return refused(state, m, m.positionOtherSteps);
  const sentence = exit ? 'exit the Flofi Orca position on Solana Devnet' : `remove ${portion}% of the liquidity of the Flofi Orca position on Solana Devnet`;
  return propose(state, env, command, sentence, m.positionProposal(exit, portion, chosen.positionMint), notes, m.positionWhich);
}

/** Planners → exact grammar → (for an existing step) the typed edit command → editor preview → proposal. */
function author(intent: CopilotIntentV2, actions: readonly CopilotAction[], composition: boolean, carried: ReadonlySet<CarriedField>, state: CopilotConversation,
  env: CopilotEnvironment, notes: readonly string[], describe: (sentence: string) => string, label: string, editNodeId: string | null = null,
  swap: SwapSource | null = null, extras: Extras = {}): Result {
  const language = intent.language, m = copilotCopy(language);
  // BUILD-BASE-001: the conversation (CopilotIntentV2) authors on the catalog networks too. PR B: with the verified Orca price and the funding swap.
  const grounding: Grounding = { text: segmentText(state), carried, policy: { language, networkDefaults: false, catalog: true }, latest: state.segment.at(-1) ?? '',
    solana: { price: env.verified?.orcaPrice?.price ?? null, swap } };
  const planned = planCopilotActions(actions, composition, grounding, env.wallet);
  if (planned.kind !== 'PLAN') return stopped(planned, intent, state, env, m, { ...extras, carried: [...carried], ...swap ? { swap } : {} });
  const outcome = proposalFromPlan(planned.plan, env, language);
  if (outcome.kind !== 'PROPOSAL') return stopped(outcome, intent, state, env, m, { ...extras, carried: [...carried], ...swap ? { swap } : {} });
  let command = outcome.command;
  if (editNodeId) {
    const edit = editCommandFor(env.workflow, env.context, editNodeId, command);
    if (!edit.ok) { const label = workflowSteps(env.workflow, env.context).find(step => step.nodeId === editNodeId);
      return refused(state, m, m.refusal[edit.code as keyof typeof m.refusal]?.(label ? stepLabel(m, label, language) : editNodeId) ?? m.rejectedCode(edit.code)); }
    command = edit.command;
  }
  return propose(state, env, command, outcome.sentence, describe(outcome.sentence), [...notes, ...outcome.notes], label);
}
function stopped(outcome: Exclude<CopilotOutcome, { kind: 'PROPOSAL' }>, intent: CopilotIntentV2, state: CopilotConversation, env: CopilotEnvironment, m: CopilotCopy,
  extras: Extras = {}): Result {
  if (outcome.kind === 'UNSUPPORTED') return refused(state, m, outcome.message);
  if (outcome.kind === 'REJECTED') return failed(state, m, outcome.message);
  // Flofi's question for the other pool token's maximum (a position funded by a swap's output) is answered by a bare amount.
  const otherToken = outcome.deposit;
  const draft: Draft = { intent, options: actionFills(intent, outcome.missing, outcome.options), snapshot: snapshotOf(env), extras,
    amountFill: intent.kind === 'ACTION' && outcome.missing.includes('amount') && intent.action.type !== 'LIQUIDITY',
    ...otherToken && outcome.missing.includes('amount') ? { depositFill: otherToken } : {} };
  return question(state, m, outcome.question, outcome.options, draft.options.length || draft.amountFill || draft.depositFill ? draft : null);
}
/** Defense in depth, then the editor preview: an unappliable or empty edit is explained instead of shown as a proposal. */
function propose(state: CopilotConversation, env: CopilotEnvironment, command: Command, sentence: string, text: string, notes: readonly string[], label: string): Result {
  const m = copilotCopy(state.language);
  if (!COPILOT_V2_COMMANDS.has(command.type) || command.source !== 'CHAT' || command.baseRevision !== env.workflow.revision || !commandIsValid(command))
    return failed(state, m, copilotRejection('COPILOT_COMMAND_MISMATCH', state.language).message);
  const preview = previewOf(env, command);
  if (preview.error) return failed(state, m, copilotRejection(preview.error.split(':')[0]!.trim(), state.language).message);
  // A position-management proposal may leave the IR as it is (the workflow already holds that position's step): Apply still prepares the operation.
  const unchanged = command.type !== 'MANAGE_SOLANA_POSITION' && (preview.workflow === env.workflow || (command.type === 'AUTHOR_LENDING' && lendingDetails(env.workflow) !== null &&
    JSON.stringify(lendingDetails(preview.workflow)) === JSON.stringify(lendingDetails(env.workflow))));
  if (unchanged) return refused(state, m, m.refusal.NO_CHANGE(label));
  return terminal(recordProposal(state, env, command, sentence), reply('PROPOSAL', text, { notes: [...new Set(notes)], command, sentence }),
    COPILOT_TRANSCRIPT.proposed + sentence);
}
