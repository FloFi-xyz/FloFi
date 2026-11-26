// SPDX-License-Identifier: AGPL-3.0-only
import { relativeAmountIn, type RelativeAmount } from './relative-amount';
import { activeNetworkScope, introducedTestNetworks, mentionsTestNetwork, publicText, testNetworkMessage } from './network-scope';
import { automationFaq, groundAutomationDraft, matchAutomationFaq, rescheduleDraft } from './copilot-automation';
import type { AutomationInput } from './copilot-automation';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import { commandIsValid, SEQUENCE_STEP_COMMANDS, type Command } from './commands';
import { editorReducer } from './editor';
import type { Workflow } from './initial-workflow';
import { lendingDetails } from './lending-authoring';
import { workflowSteps, type WorkflowStep } from './workflow-steps';
import { editCommandFor, removeCommandFor } from './workflow-edits';
import { COPILOT_AUTHORING_COMMANDS, COPILOT_NETWORK_LABEL, COPILOT_POOLS, amountReadings, canonicalDecimal, copilotRejection, groundedAddress, groundedAmount, groundedSigned, liquidityUnits, mentionedNetworks,
  planCopilotActions, proposalFromPlan, SELF_RECIPIENT, type CarriedField, type CopilotOutcome, type Grounding, type SwapSource } from './copilot-authoring';
import { SOLANA_LIQUIDITY_DEFAULT_SLIPPAGE, solanaLiquidityDetails, type SolanaLiquidityInput } from './solana-liquidity-authoring';
import { formatTokenAmount, parseTokenAmount } from './jupiter-authoring';
import { ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY } from '@defi-workflow-engine/action-registry';
import { orcaLiquidityAmounts, orcaSqrtPriceAtTick } from '@defi-workflow-engine/reference-compiler';
import { COPILOT_LIMITS, hasUnsafeCharacters, safeCopilotProse, type CopilotAction, type CopilotFeeTier, type CopilotLendingAction, type CopilotNetwork,
  type CopilotSwapAction } from './copilot-intent';
import { groundExplicitAssets } from './copilot-asset-intent';
import { answerDraftField, draftSlots, mergeDraftIntent, validatedDraftFields, type DraftField, type ValidatedDraftField } from './copilot-draft';
import { applyRangeAnswer, readRangeAnswer, type RangeHold } from './copilot-range-dialogue';
import type { PoolPriceRead, PoolRef } from './pool-range';
import { canonicalSymbol } from './asset-catalogs';
import { networkIdentity, networkOfCopilot } from './network-registry';
import { UNIVERSAL_NETWORKS } from '@defi-workflow-engine/workflow-contracts';
import { defaultUniversalOutput, resolveUniversalAsset } from './universal-bridge-authoring';
import { ROUTER_NETWORK_OPTIONS, routerNetworkOfInput } from './router-authoring';
import { COPILOT_TRANSCRIPT, COPILOT_V2_LIMITS, isCopilotIntentError, parseCopilotIntentV2, type CopilotAutomationOperation, type CopilotChanges, type CopilotGoal,
  type CopilotIntentV2, type CopilotOrdinal, type CopilotQuestionTopic, type CopilotReuseField, type CopilotTarget } from './copilot-intent-v2';
import { copilotCopy, type CarriedLabel, type CopilotCopy, type CopilotLanguage, type PositionRefusal } from './copilot-messages';
import { answerQuestion, stepSentence, stepSummary, type CopilotFacts } from './copilot-answers';
import { answerConcept, conceptCatalog, conceptFollowUp, conceptInWorkflow, conceptName, conceptQuestion, foldText, matchConcept, type ConceptId, type ConceptLevel,
  type ConceptProtocol, type ConceptState } from './intelligence/concepts';
import { ASSIST_COPY, correctTypos, questionLanguage, recipientOfferAnswer, requestLikeName, resumeRequest } from './copilot-assist';
import { matchPlatformTopic, platformAnswer, type PlatformSurface, type PlatformTopic } from './intelligence/platform-guide';
import { ecosystemOfAddress, maskSavedRecipients, matchSavedRecipients, recipientLabelKey, savedRecipientAddress, savedRecipientLabel, SAVED_RECIPIENT_LIMITS, SAVED_RECIPIENT_MARKER,
  type SavedRecipient, type SavedRecipientEcosystem } from './saved-recipients';
import { copilotNetworksMentioned, type CopilotNetworkId } from './network-registry';
import type { PendingAgentCapability } from './agent-rollout';
import { lexiconAssets, lexiconNetworks, lexiconSuggestions, LEXICON_LIMITS, mergeLexicon, parseLexicon, parseMemoryStatement, statedSource, type LexiconEntry,
  type LexiconTarget, type MemoryStatement } from './copilot-lexicon';
import { learningCopy, MEMORY_NO, MEMORY_YES, refusalFor, suggestionNote, targetLabel, usedNote } from './copilot-learning-copy';
import { lintWorkflow } from '@defi-workflow-engine/reference-linter';
import { workflowSequence } from './workflow-sequence';
import { networkCapabilityProfile } from './intelligence/capability-api';
import { lookupAsset } from './intelligence/asset-resolution';
import type { AwaitingAmount } from './amount-shortcuts';
import { intelligenceCopy } from './intelligence/copy';
import { planGoal, type Goal, type GoalField, type GoalPlan, type GoalStep } from './intelligence/goal-planner';
import { copilotNetworksFor, lendingOffers } from './authoring-capabilities';
import { followOnSelection, type CryptoAction } from './crypto-action-picker';
import { formatAssetAmount } from '@defi-workflow-engine/action-registry';
import { BATCH_PAYMENT_MAX_RECIPIENTS, BATCH_PAYMENT_MIN_RECIPIENTS, BATCH_PAYMENT_NETWORKS, type BatchPaymentInput } from './batch-payment-authoring';
import type { RobinhoodTransferInput } from './robinhood-transfer-authoring';
import { resolveNetworkAsset } from './asset-catalogs';
import { lendingProfileOfReserve } from './supply-authoring';
import { contextCard, contextKey, operationalState, type CopilotContextCard } from './intelligence/operational-state';
import { groundedProse } from './intelligence/grounding';
import { liquidityPositionChoiceValid, liquidityPositionKey, type LiquidityPositionChoice, type LiquidityPositionOperation, type LiquidityPositionView } from './liquidity-positions';
import { assetNamed, closeNamed, describePosition, halfNamed, liquidityRemovalNamed, ordinalNamed, pairMatches, pairName, positionDetails, positionKey, positionLine,
  positionNetworksText, positionOptionLabel, positionSlippageBps, positionStepWallet, POSITION_FACT_LIMITS, protocolName, rangeFilterNamed, readPositionAnswer, shortPositionId,
  statedPercent, redactPositionIds, type CopilotLiquidityFacts } from './copilot-positions';
import { actionDiff, ADAPTATION_LIMITS, clarifiedAdaptation, confirmedAdaptation, correctionAdaptation, correctionCue, fieldsOfAction, inferredUse, mergeAdaptations, messageLanguage,
  NO_ADAPTATION, proposalReadings, type Adaptation, type AdaptationEvent, type LearningObservation, type ProposalReading, type ReadingField,
  type ReadingFields } from './copilot-adaptation';

/**
 * BUILD-COPILOT-002: the conversation engine. Pure: no React, no network, no wallet, no execution. It keeps a bounded
 * transcript for the model's context, the open request segment (the only text explicit values may come from), Flofi's own
 * open question, and the proposals Flofi showed. Every reference is resolved here against the canonical workflow and
 * the visible pending proposal; the model never names a node. Every outcome is a reply plus, at most, one Command that
 * the caller hands to the existing `propose`; the workflow changes only when the user clicks Apply.
 */
export type TranscriptEntry = { readonly role: 'user' | 'assistant'; readonly text: string };
/** A proposal Flofi showed, as Flofi recorded it from the Command and its editor preview (never as the model described it). */
export type CopilotReferent = { readonly command: Command; readonly sentence: string; readonly step: WorkflowStep;
  /** BUILD-CHAT-LEARNING-002 (Copilot proposals only): how FloFi read each field, the request's own words (bounded), and whether the user applied it
   *  and FloFi still watches the applied step for a correction on the canvas. */
  readonly readings?: readonly ProposalReading[]; readonly request?: string; readonly applied?: boolean; readonly watched?: boolean };
export type ContextSnapshot = { readonly workflow: Workflow; readonly pending: object | null; readonly wallet: string | null; readonly walletChainId: string | null; readonly solanaOwner?: string | null };
type Resolved =
  | { readonly source: 'PENDING'; readonly step: WorkflowStep; readonly command: Command }
  | { readonly source: 'NODE'; readonly step: WorkflowStep }
  | { readonly source: 'REFERENT'; readonly step: WorkflowStep; readonly referent: CopilotReferent };
type DraftFill = { readonly kind: 'TARGET'; readonly target: Resolved } | { readonly kind: 'ACTION'; readonly patch: Readonly<Record<string, unknown>> }
  | { readonly kind: 'EXTRAS'; readonly extras: Extras };
/** BUILD-FLOFI-INTELLIGENCE-001: what each operational question asked in this request, and what the user corrected (content-free counters). */
export type ConversationLedger = { readonly asked: readonly { readonly field: string; readonly count: number }[]; readonly corrected: readonly string[];
  /** Questions about a field FloFi had already asked in this request (a settled question asked again is a defect to measure). */ readonly repeats: number;
  /** User turns since the request opened (time to a valid proposal, in turns). */ readonly turns: number };
/** Flofi's own open question: each button has a deterministic meaning, so answering it needs no model. */
type Draft = { readonly expected?: readonly DraftField[]; readonly validated?: readonly ValidatedDraftField[]; readonly grounding?: string;
  readonly intent: CopilotIntentV2; readonly options: readonly { readonly label: string; readonly fill: DraftFill }[]; readonly amountFill: boolean;
  readonly snapshot: ContextSnapshot;
  /** A bare amount answers Flofi's question for this pool token's maximum (FloFi's own question named it). */ readonly depositFill?: string;
  /** BUILD-P1: an open range answer — a value whose side FloFi asked about, or the side whose value it asked for (`copilot-range-dialogue.ts`). */
  readonly rangeHold?: RangeHold;
  /** BUILD-P1: the closed code of FloFi's own open question (a range answer is read locally only under FloFi's range questions). */
  readonly code?: string;
  /** What resolving the open request already settled (a chosen swap or position). */ readonly extras?: Extras;
  /**
   * BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001: the user stated this amount relative to their balance ("todo o USDC que tenho", "half my ETH"); the
   * balance shortcut answers FloFi's amount question with it from a fresh read (never a guessed number).
   */
  readonly relative?: RelativeAmount;
  /** The question and the buttons shown, so "yes" never guesses among several. */ readonly question?: string; readonly shown?: readonly string[];
  /** BUILD-CHAT-LEARNING-001: a mainnet FloFi's glossary suggested, offered first (picking it or another option is a feedback signal). */
  readonly suggestion?: CopilotNetworkId };
/** Values Flofi settled itself while resolving one request: values it carried, the swap whose output funds a position, a position and its portion. */
type Extras = { readonly carried?: readonly CarriedField[]; readonly swap?: SwapSource; readonly position?: string; readonly portion?: string;
  /** BUILD-FLOFI-INTELLIGENCE-001: the action is a goal plan's step (its assets were grounded per goal field, see `Grounding.explicitAssets`). */ readonly planned?: true;
  /** BUILD-FLOFI-UNIFIED-COPILOT-001: misspelled words whose reading FloFi already showed the user ("arbriturm" as Arbitrum One). */ readonly typos?: readonly string[];
  /** BUILD-FLOFI-UNIFIED-COPILOT-001: the step an edit or repeat already resolved (a later answer never asks "which step?" again). */ readonly target?: Resolved;
  /** BUILD-FLOFI-UNIFIED-COPILOT-001: the saved recipient (id) the user picked from FloFi's "which one?" buttons. */ readonly savedRecipient?: string;
  /** BUILD-P1: the bare number the user gave to FloFi's own percentage question (see `Grounding.answeredPercent`). */ readonly answeredPercent?: string;
  /** BUILD-P1: FloFi asked this request for its range (see `Grounding.rangeAsked`). */ readonly rangeAsked?: boolean;
  /**
   * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the owner's own close words from the Uniswap choice a short answer changes ("Arbitrum" after "exit and close
   * my Base position"). Only FloFi sets it, from a choice it prepared on those words; a model's CLOSE never burns an NFT.
   */
  readonly close?: true;
  /**
   * BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001: FloFi asked for the cap of this (0-based) step of a sequence request, which spends what the earlier step
   * delivers in another asset ("troque 1 USDC por ETH e depois troque o ETH recebido por USDC"). Only FloFi sets it; a bare amount answers it.
   */
  readonly capStep?: number;
  /** The (0-based) steps whose cap the user gave in answer to FloFi's `capStep` question: they must still be funded by the step before them. */
  readonly capFunded?: readonly number[] };
export type CopilotConversation = {
  readonly transcript: readonly TranscriptEntry[]; readonly segment: readonly string[]; readonly clarifications: number;
  readonly draft: Draft | null; readonly referents: readonly CopilotReferent[]; readonly language: CopilotLanguage;
  /** BUILD-CHAT-LEARNING-001: meanings the user stated in this conversation (never stored unless they accept FloFi's offer). */
  readonly aliases?: readonly LexiconEntry[];
  /** FloFi's open memory offer: its two buttons (or yes/no) answer it; anything else drops it. */
  readonly offer?: MemoryOffer | null;
  /** A reply language the user asked for in this conversation (wins over a saved preference). */
  readonly languageSet?: CopilotLanguage | null;
  /** Consecutive turns that ended without a proposal or an answer (a repeated failure is signalled once, at two). */
  readonly failures?: number;
  /** BUILD-CHAT-LEARNING-002: meanings FloFi inferred in this conversation (answers to its questions, corrections), inferred meanings the user
   *  corrected (withdrawn for this conversation), where FloFi's first question split the open request from the answers, and whether this
   *  conversation's language was already observed. */
  readonly adapted?: readonly LexiconEntry[]; readonly suppressed?: readonly { readonly term: string; readonly target: LexiconTarget }[];
  readonly askedAt?: number; readonly languageObserved?: boolean;
  /** BUILD-P1: every slot the open request has filled so far (reset with the request): only a never-filled slot is progress for the budget. */
  readonly slots?: readonly string[];
  /** BUILD-FLOFI-INTELLIGENCE-001: the open request's ledger (reset with the request). */
  readonly ledger?: ConversationLedger;
  /** BUILD-FLOFI-UNIFIED-COPILOT-001: the DeFi concept FloFi last explained, so "não entendi" or "e na Aave?" has a grounded subject. */
  readonly concept?: ConceptState | null;
  /** FloFi's open, optional offer to save a typed public address in Credentials (never required; anything else drops it). */
  readonly recipientOffer?: RecipientOffer | null;
  /** Addresses whose save offer the user declined in this conversation: never offered again. */
  readonly recipientDeclined?: readonly string[];
  /**
   * BUILD-FLOFI-UNIFIED-COPILOT-001: the automation this conversation is about — the proposal FloFi last showed (and whether the owner created it),
   * or null input after a management turn — so "e se o preço cair?" or "muda para segunda" refers to it.
   */
  readonly automation?: { readonly input: AutomationInput | null; readonly created: boolean } | null;
  /** BUILD-FLOFI-UNIFIED-COPILOT-001: every saved recipient this conversation has mentioned. Masking keeps using them even if the list is later
   * unavailable, renamed or removed, so a name once masked is never sent to a model in a later turn (local state only, never sent anywhere). */
  readonly recipientMasks?: readonly SavedRecipient[];
};
export type RecipientOffer = { readonly address: string; readonly ecosystem: SavedRecipientEcosystem; readonly suggestion: string | null;
  /** True once the user accepted and FloFi asked for the name. */ readonly naming: boolean };
/**
 * BUILD-CHAT-LEARNING-001: what the caller knows about this user's learning. It never decides grounding by itself: the engine validates every
 * entry again and applies the source rules of `copilot-lexicon.ts`. Absent = learning is not enabled: the engine behaves exactly as before.
 */
export type CopilotLearning = {
  /** AVAILABLE: a verified identity whose memory can be written. PAUSED: verified, memory turned off. ANONYMOUS: no verified identity.
   *  SESSION (BUILD-CHAT-LEARNING-002): in-conversation adaptation only — the deployment stores nothing. */
  readonly memory: 'AVAILABLE' | 'PAUSED' | 'ANONYMOUS' | 'UNAVAILABLE' | 'SESSION';
  /** How FloFi names whose memory it is, per reply language ("your wallet 0x12…ab", "esta conta do Telegram"); null when anonymous. */
  readonly owner: Readonly<Record<CopilotLanguage, string>> | null;
  readonly private: readonly LexiconEntry[]; readonly global: readonly LexiconEntry[]; readonly globalVersion: number | null;
  readonly language: CopilotLanguage | null;
  /** BUILD-CHAT-LEARNING-002: meanings learned automatically for this identity (LEARNED: inferred, never naming real funds or a token); whether
   *  persistent automatic learning is permitted for it now (deployment basis + the identity's own choice: observations are stored only when ON);
   *  and the language its earlier conversations were written in (only a starting point, never over the user's own words). */
  readonly learned?: readonly LexiconEntry[]; readonly automatic?: 'ON' | 'OFF'; readonly languageHint?: CopilotLanguage | null;
};
/** A memory change the engine only describes; the caller performs it on the user's verified identity (and reports a failure). */
export type MemoryAction = { readonly op: 'SAVE'; readonly entry: LexiconEntry } | { readonly op: 'FORGET'; readonly term: string } | { readonly op: 'FORGET_ALL' }
  | { readonly op: 'LANGUAGE'; readonly language: CopilotLanguage };
export type LearningSignal = 'CORRECTION' | 'CLARIFICATION_ANSWERED' | 'REPEATED_FAILURE' | 'SUGGESTION_CONFIRMED' | 'SUGGESTION_REJECTED';
type MemoryOffer = { readonly action: MemoryAction; readonly declined: string };
export type CopilotEnvironment = {
  readonly timezone?: string; readonly workflow: Workflow; readonly context: ReviewContext; readonly wallet: string | null; readonly walletChainId: string | null;
  readonly pending: { readonly command: Command; readonly diff: readonly string[] } | null; readonly facts: CopilotFacts;
  /** Read-only Solana Devnet facts FloFi read itself (never the model's or the user's words); absent when not loaded. */
  readonly verified?: CopilotVerified;
  /** BUILD-CHAT-LEARNING-001: the user's learning context; absent when learning is not enabled on this deployment. */
  readonly learning?: CopilotLearning;
  /** Tests only: approved agent rollouts (audit A9). Absent in the product, where `AGENT_ROLLOUT_APPROVED` applies. */
  readonly agentRollout?: readonly PendingAgentCapability[];
  /**
   * P0 approved UX (board 02/16 §4): the active interface language. When present, every reply is written in it — FloFi's own copy and the model's
   * (sent as the turn's reply language) — whatever language the person typed in; their words are still understood in either language.
   */
  readonly interfaceLanguage?: CopilotLanguage;
  /**
   * BUILD-FLOFI-UNIFIED-COPILOT-001: the signed-in account's Saved Recipients (public addresses with names), read by the surface from its verified
   * session. Absent: none are available here (signed out, unlinked channel, not migrated). A name selects an address only through the exact-name
   * rules of `saved-recipients.ts`; names and addresses are masked before anything is sent to a model.
   */
  readonly recipients?: readonly SavedRecipient[];
  /** The surface can save a recipient for this user (the web app, signed in): FloFi may offer to save a typed address. */
  readonly recipientWrites?: boolean;
  /** Where the conversation happens (default WEB): a chat channel never applies a change, it links to the owner's FloFi screen. */
  readonly surface?: PlatformSurface;
  /**
   * BUILD-P1: the surface reads a pool's price on request. A reply whose `pool` is set asks it to read that pool (read-only) and replay the same
   * turn with the read in `verified.pools`; a surface without it gets FloFi's explanation of what it could not confirm instead.
   */
  readonly poolReads?: boolean;
  /** Tests only: the time pool reads are judged fresh against (default: now). */
  readonly now?: number;
};
/** Engineering scope only: one FloFi-registered Orca position of the connected Solana Devnet wallet, as the position registry and the chain report it. */
export type CopilotPosition = { readonly positionMint: string; readonly status: string; readonly tickLower: number | null; readonly tickUpper: number | null;
  readonly liquidity: string | null };
export type CopilotVerified = {
  /** The Orca SOL/devUSDC pool price (devUSDC per SOL) and current tick, read from Solana Devnet. */
  readonly orcaPrice: { readonly price: string; readonly tickCurrentIndex: number } | null;
  /** The connected Solana Devnet wallet and its FloFi positions on that pool (null: not loaded). */
  readonly solanaOwner: string | null; readonly orcaPositions: readonly CopilotPosition[] | null;
  /** Swap output a reconciled execution left in the wallet: a reconciled Devnet swap's output, or a composition's undeposited swap output. */
  readonly remaining: readonly { readonly token: 'SOL' | 'devUSDC'; readonly amount: string }[];
  /**
   * BUILD-P1 pool conversational reliability: mainnet pool prices the surface read on chain for this turn (Orca SOL/USDC, a catalog network's
   * Uniswap v3 pool), each with its pool identity, slot or block and read time. FloFi computes a percentage range only from one of these.
   */
  readonly pools?: readonly PoolPriceRead[];
  /**
   * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the connected wallets' verified liquidity positions (Uniswap v3 on the catalog mainnets, Orca SOL/USDC on
   * Solana), read by the surface through FloFi's discovery route for the current owners. Absent: not read here (a channel, or not loaded yet).
   */
  readonly liquidity?: CopilotLiquidityFacts;
};
export type CopilotReply = {
  readonly code?: string; readonly kind: 'PROPOSAL' | 'AUTOMATION_PROPOSAL' | 'AUTOMATION_MANAGE' | 'ANSWER' | 'CLARIFICATION' | 'UNSUPPORTED' | 'FAILED' | 'MEMORY';
  readonly text: string; readonly notes: readonly string[];
  /**
   * BUILD-FLOFI-UNIFIED-COPILOT-001: a public address the user explicitly asked to save under a name; the caller performs the save on the verified
   * account and reports the result. It authorizes nothing and is independent of any transaction.
   */
  readonly recipientSave?: { readonly label: string; readonly address: string; readonly ecosystem: SavedRecipientEcosystem };
  /** An automation-management request: the caller reads the owner's own automations and shows FloFi's view; a change needs the owner's confirmation. */
  readonly manage?: { readonly operation: CopilotAutomationOperation; readonly request: string };
  /** A FloFi page that answers a "where/how do I" question (relative path from the platform guide). */
  readonly link?: { readonly path: string; readonly label: string };
  /** FloFi's optional offer after a proposal (save the typed address): shown as its own message with its two answers; never required. */
  readonly offer?: { readonly text: string; readonly options: readonly string[] };
  readonly options: readonly string[]; readonly automation?: AutomationInput; readonly command?: Command; readonly sentence?: string; readonly topic?: CopilotQuestionTopic;
  /** BUILD-P1: the pool whose current price FloFi needs before it can continue (read-only; see `CopilotEnvironment.poolReads`). */
  readonly pool?: PoolRef;
  /** BUILD-FLOFI-UNIFIED-COPILOT-001: the options are the user's own saved names, shown and sent exactly as saved (never translated). */ readonly verbatimOptions?: true;
  /** BUILD-CHAT-LEARNING-001: a memory change for the caller to perform (only after the user's own click or explicit statement). */
  readonly memory?: MemoryAction;
  /** Learned entries FloFi used to read this request (each also shown as a note) and content-free feedback signals. BUILD-CHAT-LEARNING-002:
   *  observations about the user's words (stored by the caller only when persistent automatic learning is permitted) and content-free events. */
  readonly learning?: ReplyLearning;
};
export type ReplyLearning = { readonly used: readonly LexiconEntry[]; readonly signals: readonly LearningSignal[]; readonly observations?: readonly LearningObservation[];
  readonly events?: readonly AdaptationEvent[] };
/**
 * BUILD-FLOFI-INTELLIGENCE-001: a request may carry FloFi's sanitized context card (`intelligence/operational-state.ts`) and its fingerprint. The server
 * hands the card to the model only through the read-only `get_workflow_context` / `get_wallet_context` tools, and echoes the fingerprint so an
 * answer computed for another context is never applied.
 */
export type CopilotRequestV2 = { readonly version: '2'; readonly messages: readonly TranscriptEntry[]; readonly context?: CopilotContextCard; readonly contextKey?: string;
  /** P0 approved UX: the interface language the model must reply in. */ readonly replyLanguage?: CopilotLanguage };
export type CopilotResultV2 = { readonly ok: true; readonly intent: unknown; readonly contextKey?: string;
  /** BUILD-FLOFI-INTELLIGENCE-001: the numbers FloFi's own tools returned this turn (the server's facts), for grounding the model's explanation again here. */
  readonly groundingNumbers?: readonly string[] } | { readonly ok: false; readonly code: string; readonly retryAfterSeconds?: number };
export type PendingTurn = { readonly before: CopilotConversation; readonly state: CopilotConversation; readonly snapshot: ContextSnapshot; readonly contextKey?: string };
export type TurnStart = { readonly kind: 'LOCAL'; readonly reply: CopilotReply; readonly next: CopilotConversation }
  | { readonly kind: 'REMOTE'; readonly request: CopilotRequestV2; readonly turn: PendingTurn };
type Result = { readonly reply: CopilotReply; readonly next: CopilotConversation };

/** Every Command the Copilot may hand to `propose`: new authoring, typed edits of existing steps, and removal. */
export const COPILOT_V2_COMMANDS: ReadonlySet<string> = new Set([...COPILOT_AUTHORING_COMMANDS, 'SET_SUPPLY', 'SET_BORROW', 'SET_REPAY', 'SET_WITHDRAW',
  'SET_SOLANA_SWAP', 'SET_ROUTER_BRIDGE', 'SET_UNIVERSAL_BRIDGE', 'SET_UNISWAP_LIQUIDITY', 'SET_SOLANA_LIQUIDITY', 'SET_SWAP_AMOUNT', 'SET_SLIPPAGE', 'REMOVE',
  // BUILD-BASE-001: edits of catalog-network swaps, positions and transfers, with the same commands the Canvas uses.
  'SET_CRYPTO_ACTION', 'SET_RH_TRANSFER',
  // PR B: preparing a verified FloFi position for removal or exit (the owner still simulates, reviews and signs).
  'MANAGE_SOLANA_POSITION',
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: preparing one verified mainnet position for a collection, partial removal, exit or close (same rule).
  'MANAGE_LIQUIDITY_POSITION',
  // BUILD-FLOFI-INTELLIGENCE-001: a goal plan's ordered single-action steps, applied as one change (each step is one of the authoring commands above).
  'ADD_SEQUENCE']);
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
/**
 * Flofi's own transcript entries never carry an address (a carried beneficiary, a connected wallet, EVM or Solana): the model needs none. Nor a
 * position id (`redactPositionIds`): it singles out the owner on chain.
 */
const redact = (text: string) => redactPositionIds(text.replace(/0x[0-9a-fA-F]{40}/g, '[address]').replace(/(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![A-Za-z0-9])/g, '[address]'))
  .slice(0, COPILOT_LIMITS.maxAssistantMessageLength);
function bounded(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  let out = entries.map(entry => entry.role === 'assistant' ? { role: entry.role, text: redact(entry.text) } : entry)
    .slice(-COPILOT_V2_LIMITS.maxTranscriptMessages);
  const size = (list: readonly TranscriptEntry[]) => list.reduce((total, entry) => total + entry.text.length, 0);
  while (out.filter(entry => entry.role === 'user').length > COPILOT_V2_LIMITS.maxUserTurns || size(out) > COPILOT_V2_LIMITS.maxRequestCharacters) out = out.slice(1);
  while (out.length && out[0]!.role !== 'user') out = out.slice(1);
  return out;
}
const withUser = (state: CopilotConversation, text: string): CopilotConversation => ({ ...state, draft: null,
  ledger: { ...state.ledger ?? EMPTY_LEDGER, turns: (state.ledger?.turns ?? 0) + 1 },
  segment: state.draft?.grounding ? [state.draft.grounding.slice(-(COPILOT_V2_LIMITS.maxRequestCharacters - text.length - 1)), text]
    : [...state.segment, text].slice(-COPILOT_V2_LIMITS.maxSegmentUserTurns), transcript: bounded([...state.transcript, { role: 'user', text }]) });
export const closeSegment = (state: CopilotConversation): CopilotConversation => {
  const { askedAt: _asked, ledger: _ledger, slots: _slots, ...rest } = state;
  void _asked; void _ledger; void _slots;
  return { ...rest, segment: [], clarifications: 0, draft: null };
};
const EMPTY_LEDGER: ConversationLedger = Object.freeze({ asked: [], corrected: [], repeats: 0, turns: 0 });
/** The ledger after FloFi asks for `fields` (each counted; one already asked in this request is a repeat). */
function askedLedger(ledger: ConversationLedger | undefined, fields: readonly string[]): ConversationLedger {
  const current = ledger ?? EMPTY_LEDGER, asked = [...current.asked];
  let repeats = current.repeats;
  for (const field of new Set(fields.filter(field => field !== 'target'))) {
    const at = asked.findIndex(item => item.field === field);
    if (at >= 0) { asked[at] = { field, count: asked[at]!.count + 1 }; repeats += 1; } else asked.push({ field, count: 1 });
  }
  return { ...current, asked: asked.slice(-16), repeats };
}
const correctedLedger = (ledger: ConversationLedger | undefined, fields: readonly string[]): ConversationLedger =>
  ({ ...ledger ?? EMPTY_LEDGER, corrected: [...new Set([...(ledger ?? EMPTY_LEDGER).corrected, ...fields])].slice(-16) });
const reply = (kind: CopilotReply['kind'], text: string, extra: Partial<CopilotReply> = {}): CopilotReply => ({ kind, text, notes: [], options: [], ...extra });
/** A turn that ends the open request: proposal, answer, refusal or failure. */
const terminal = (state: CopilotConversation, value: CopilotReply, summary: string): Result =>
  ({ reply: value, next: { ...closeSegment(state), transcript: bounded([...state.transcript, { role: 'assistant', text: summary }]) } });
const failed = (state: CopilotConversation, m: CopilotCopy, message: string): Result =>
  terminal(state, reply('FAILED', /(?:Nothing changed|Nada mudou)\.$/.test(message) ? message : `${message} ${m.nothingChanged}`), COPILOT_TRANSCRIPT.declined + message);
/** BUILD-P1 observability: the same failure with its closed code, so content-free turn metrics can tell why a request stopped. */
const failedWith = (state: CopilotConversation, m: CopilotCopy, message: string, code: string): Result => {
  const result = failed(state, m, message);
  return { ...result, reply: { ...result.reply, code } };
};
const refused = (state: CopilotConversation, m: CopilotCopy, message: string): Result =>
  terminal(state, reply('UNSUPPORTED', message), COPILOT_TRANSCRIPT.declined + message);
/** A question keeps the request open, up to the clarification budget. */
function question(state: CopilotConversation, m: CopilotCopy, text: string, options: readonly string[], draft: Draft | null, notes: readonly string[] = [],
  extra: Partial<CopilotReply> = {}): Result {
  // BUILD-P1: FloFi's own request to read a pool (the surface reads it and answers the same message again) is not a question to the person: it
  // neither counts against nor is stopped by the clarification budget.
  const internal = extra.code === 'COPILOT_POOL_PRICE_REQUIRED';
  if (!internal && state.clarifications >= COPILOT_V2_LIMITS.maxClarifications) return failedWith(state, m, m.tooManyClarifications, 'COPILOT_CLARIFICATION_LIMIT');
  const slots = draft ? [...new Set([...state.slots ?? [], ...draftSlots(draft.intent)])] : state.slots;
  return { reply: reply('CLARIFICATION', text, { options, ...notes.length ? { notes } : {}, ...extra }),
    next: { ...state, clarifications: state.clarifications + (internal ? 0 : 1), ledger: askedLedger(state.ledger, draft?.expected ?? ['request']), ...slots ? { slots } : {},
      draft: draft && { ...draft, grounding: segmentText(state), expected: draft.expected ?? ['target'], question: text, shown: options, ...extra.code ? { code: extra.code } : {} },
      // BUILD-CHAT-LEARNING-002: what the user writes from here on answers FloFi's question (the request's own words end here).
      askedAt: state.askedAt ?? state.segment.length,
      transcript: bounded([...state.transcript, { role: 'assistant', text: COPILOT_TRANSCRIPT.asked + text }]) } };
}
export const failureText = (code: string, language: CopilotLanguage, retryAfterSeconds?: number): string => {
  const m = copilotCopy(language);
  return `${m.failures[code] ?? m.failureDefault}${retryAfterSeconds ? m.retryAfter(retryAfterSeconds) : ''}${m.failureSuffix}`;
};

// ── BUILD-CHAT-LEARNING-001: learned vocabulary and memory ───────────────────────────────────────────────────────────────────────────
const suppressedPair = (state: CopilotConversation, entry: LexiconEntry) => (state.suppressed ?? []).some(pair => pair.term === entry.term && pair.target === entry.target);
/**
 * The lexicon a turn grounds with — this conversation's stated and adapted meanings, the identity's saved and learned ones, FloFi's glossary —
 * re-validated, one per term. BUILD-CHAT-LEARNING-002: an inferred meaning the user corrected in this conversation is withdrawn for it.
 */
export const lexiconOf = (state: CopilotConversation, env: CopilotEnvironment): LexiconEntry[] => !env.learning ? []
  : mergeLexicon(parseLexicon(state.aliases ?? [], 'SESSION'), parseLexicon(state.adapted ?? [], 'ADAPTED'), parseLexicon(env.learning.private, 'PRIVATE'),
    parseLexicon(env.learning.learned ?? [], 'LEARNED'), parseLexicon(env.learning.global, 'GLOBAL')).filter(entry => statedSource(entry.source) || !suppressedPair(state, entry));
/** The reply language the user chose (in this conversation, else saved); null = the language of their message, as before. */
export const preferredLanguage = (state: CopilotConversation, env: CopilotEnvironment): CopilotLanguage | null =>
  env.interfaceLanguage ?? (!env.learning ? null : state.languageSet ?? env.learning.language ?? null);
function withLearning(result: Result, env: CopilotEnvironment, signals: readonly LearningSignal[], used: readonly LexiconEntry[] = []): Result {
  if (!env.learning || (!signals.length && !used.length)) return result;
  const prior = result.reply.learning;
  return { ...result, reply: { ...result.reply, learning: { ...prior, used: [...new Set([...prior?.used ?? [], ...used])], signals: [...new Set([...prior?.signals ?? [], ...signals])] } } };
}
/**
 * BUILD-CHAT-LEARNING-002: this conversation's adapted meanings and withdrawn inferred ones after a signal (bounded). The newest meaning of a word
 * wins; a withdrawn (word, meaning) pair is never applied again in this conversation unless the user's own answer brings it back.
 */
export function applyAdaptation(state: CopilotConversation, adaptation: Adaptation): CopilotConversation {
  if (!adaptation.adapted.length && !adaptation.suppressed.length) return state;
  const same = (a: { term: string; target: LexiconTarget }, b: { term: string; target: LexiconTarget }) => a.term === b.term && a.target === b.target;
  const suppressed = [...(state.suppressed ?? []).filter(pair => !adaptation.adapted.some(entry => same(entry, pair))), ...adaptation.suppressed]
    .filter((pair, index, all) => all.findIndex(other => same(other, pair)) === index).slice(-ADAPTATION_LIMITS.maxSuppressed);
  const adapted = [...adaptation.adapted, ...(state.adapted ?? []).filter(entry => !adaptation.adapted.some(added => added.term === entry.term))]
    .filter((entry, index, all) => all.findIndex(other => other.term === entry.term) === index && !suppressed.some(pair => same(pair, entry))
      && !(state.aliases ?? []).some(alias => alias.term === entry.term)).slice(0, LEXICON_LIMITS.maxAdapted);
  return { ...state, adapted, suppressed };
}
/** BUILD-CHAT-LEARNING-002: a signal's effect on the conversation (adapted, withdrawn) and on the reply (observations, content-free events). */
function withAdaptation(result: Result, env: CopilotEnvironment, adaptation: Adaptation): Result {
  if (!env.learning || adaptation === NO_ADAPTATION || (!adaptation.observations.length && !adaptation.events.length && !adaptation.adapted.length)) return result;
  const prior = result.reply.learning, observations = env.learning.automatic === 'ON' ? adaptation.observations : [];
  return { next: applyAdaptation(result.next, adaptation), reply: { ...result.reply, learning: { used: prior?.used ?? [], signals: prior?.signals ?? [],
    observations: [...prior?.observations ?? [], ...observations], events: [...prior?.events ?? [], ...adaptation.events] } } };
}
/** Turns that ended without a proposal or answer, in a row; the second one is signalled (content-free) as a repeated failure. */
function tallied(result: Result, env: CopilotEnvironment): Result {
  if (!env.learning) return result;
  const kind = result.reply.kind;
  if (kind !== 'FAILED' && kind !== 'UNSUPPORTED') return kind === 'CLARIFICATION' ? result : { ...result, next: { ...result.next, failures: 0 } };
  const failures = (result.next.failures ?? 0) + 1;
  return withLearning({ ...result, next: { ...result.next, failures } }, env, failures === 2 ? ['REPEATED_FAILURE'] : []);
}
/** Learned entries that made the difference in a proposal: their target is in the proposal, and the user's words did not name it otherwise. */
function usedEntries(text: string, lexicon: readonly LexiconEntry[], sentence: string): LexiconEntry[] {
  if (!lexicon.length) return [];
  const canonical = mentionedNetworks(text), proposed = copilotNetworksMentioned(sentence);
  const word = (symbol: string) => new RegExp(`(?<![A-Za-z0-9])${symbol}(?![A-Za-z0-9])`, 'i');
  return [...new Set([...lexiconNetworks(text, lexicon).filter(({ network }) => proposed.includes(network) && !canonical.includes(network)).map(match => match.entry),
    ...lexiconAssets(text, lexicon).filter(({ asset }) => word(asset === 'DEVUSDC' ? 'devUSDC' : asset).test(sentence) && !word(asset).test(text)).map(match => match.entry)])];
}
const isYes = (text: string) => MEMORY_YES.has(normalize(text).replace(/[.!]+$/, '')) || YES.test(text);
const isNo = (text: string) => MEMORY_NO.has(normalize(text).replace(/[.!]+$/, '')) || NO.test(text);
/** The user's answer to FloFi's confirmation before erasing everything: only now does the reply carry the erasure, for the caller to perform. */
function answerOffer(state: CopilotConversation, offer: MemoryOffer, yes: boolean, language: CopilotLanguage): Result {
  const next = { ...state, offer: null };
  if (!yes) return { reply: reply('ANSWER', offer.declined), next };
  const l = learningCopy(language), action = offer.action;
  const text = action.op === 'SAVE' ? l.saved(action.entry.term, targetLabel(action.entry.target, language)) : action.op === 'LANGUAGE'
    ? learningCopy(action.language).languageSaved(action.language) : action.op === 'FORGET_ALL' ? l.deletedAll : l.forgotten(action.term);
  return { reply: reply('MEMORY', text, { memory: action }), next };
}
/**
 * A statement about the user's own vocabulary or reply language. Deterministic and local: never sent to the model, never a workflow change.
 * BUILD-CHAT-LEARNING-002: no "Remember" offer — a stated meaning applies to this conversation at once and is observed for the identity's memory
 * only when persistent automatic learning is permitted for it (`learning.automatic`); the reply never invites the user to teach or sign in.
 */
function memoryTurn(state: CopilotConversation, statement: MemoryStatement, learning: CopilotLearning, language: CopilotLanguage): Result {
  const l = learningCopy(language), aliases = state.aliases ?? [], stored = learning.memory === 'AVAILABLE' || learning.memory === 'PAUSED';
  // Persistent learning of what the user states needs the deployment's basis and the user's own choice (`learning.automatic`).
  const persist = learning.automatic === 'ON';
  const local = (value: CopilotReply, next: CopilotConversation = state): Result => ({ reply: value, next: { ...next, offer: null } });
  const learned = (observations: readonly LearningObservation[], outcome: string): ReplyLearning =>
    ({ used: [], signals: [], observations: persist ? observations : [], events: [{ kind: 'ADAPTATION', outcome }] });
  switch (statement.kind) {
    case 'REMEMBER': {
      if (!statement.term) return local(reply('UNSUPPORTED', l.invalidTerm));
      if (!statement.target) return local(reply('UNSUPPORTED', l.unknownTarget));
      if (!statement.validation?.ok) return local(reply('UNSUPPORTED', refusalFor(statement.validation?.code ?? 'LEARNING_TERM_INVALID', statement.term, statement.target, language)));
      const { term, target } = statement.validation, label = targetLabel(target, language);
      const next = { ...state, aliases: [{ term, target, source: 'SESSION' as const }, ...aliases.filter(alias => alias.term !== term)].slice(0, LEXICON_LIMITS.maxSession),
        adapted: (state.adapted ?? []).filter(entry => entry.term !== term) };
      return local(reply('ANSWER', persist ? l.understoodSaved(term, label) : l.understood(term, label),
        { learning: learned([{ kind: 'STATED', term, target, via: 'CHAT' }], 'STATED') }), next);
    }
    case 'FORGET': {
      if (!statement.term) return local(reply('UNSUPPORTED', l.invalidTerm));
      const term = statement.term, known = [...aliases, ...state.adapted ?? []].some(entry => entry.term === term);
      // Forgetting a word also withdraws, for this conversation, whatever FloFi inferred or reviewed for it.
      const withdrawn = [...state.adapted ?? [], ...parseLexicon(learning.learned ?? [], 'LEARNED'), ...parseLexicon(learning.global, 'GLOBAL')]
        .filter(entry => entry.term === term).map(entry => ({ term, target: entry.target }));
      const next = { ...state, aliases: aliases.filter(alias => alias.term !== term), adapted: (state.adapted ?? []).filter(entry => entry.term !== term),
        suppressed: [...state.suppressed ?? [], ...withdrawn].slice(-ADAPTATION_LIMITS.maxSuppressed) };
      if (stored && [...learning.private, ...learning.learned ?? []].some(entry => entry.term === term))
        return local(reply('MEMORY', l.forgotten(term), { memory: { op: 'FORGET', term } }), next);
      return local(reply('ANSWER', known || withdrawn.length ? l.forgotten(term) : l.notKnown(term)), next);
    }
    case 'FORGET_ALL': {
      const next = { ...state, aliases: [], adapted: [], languageSet: null };
      if (stored) return { reply: reply('MEMORY', l.forgetAllOffer, { options: l.forgetAllOptions }), next: { ...next, offer: { action: { op: 'FORGET_ALL' }, declined: l.kept } } };
      return local(reply('ANSWER', aliases.length || state.adapted?.length ? l.deletedAll : l.nothingToDelete), next);
    }
    case 'LANGUAGE': {
      const chosen = statement.language, c = learningCopy(chosen), next = { ...state, languageSet: chosen, language: chosen };
      return local(reply('ANSWER', c.language(chosen), { learning: learned([{ kind: 'LANGUAGE', language: chosen, stated: true }], 'STATED_LANGUAGE') }), next);
    }
  }
}
/** FloFi inferred or reviewed a mainnet for a word the user wrote: offer that option first and say why; the user still decides. */
function withSuggestion(state: CopilotConversation, env: CopilotEnvironment, options: readonly string[], language: CopilotLanguage):
  { readonly options: readonly string[]; readonly notes: readonly string[]; readonly suggestion?: CopilotNetworkId } {
  const lexicon = lexiconOf(state, env);
  if (!lexicon.length || !options.length) return { options, notes: [] };
  const mentions = (option: string, network: CopilotNetworkId) => copilotNetworksMentioned(option).includes(network);
  const found = lexiconSuggestions(segmentText(state), lexicon).find(match => options.some(option => mentions(option, match.network)));
  if (!found) return { options, notes: [] };
  return { options: [...options.filter(option => mentions(option, found.network)), ...options.filter(option => !mentions(option, found.network))],
    notes: [suggestionNote(found.entry, language)], suggestion: found.network };
}

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
/** BUILD-FLOFI-UNIFIED-COPILOT-001: the owner created the automation FloFi proposed (its later changes are a confirmed replacement of the saved rule). */
export const automationCreated = (state: CopilotConversation): CopilotConversation =>
  state.automation ? { ...state, automation: { ...state.automation, created: true } } : state;
export function recordProposal(state: CopilotConversation, env: CopilotEnvironment, command: Command, sentence?: string,
  learned: { readonly readings: readonly ProposalReading[]; readonly request: string } | null = null): CopilotConversation {
  if (state.referents[0]?.command === command) return state;
  const step = changedSteps(env, command)[0];
  if (!step) return state;
  // BUILD-CHAT-LEARNING-002: a Copilot proposal keeps how FloFi read it, so applying it or correcting it later can be evidence about the user's words.
  const readings = learned?.readings.length ? { readings: learned.readings, request: learned.request.slice(0, ADAPTATION_LIMITS.maxRequestText), watched: true } : {};
  return { ...state, referents: [{ command, sentence: sentence ?? stepSummary(step, 'EN'), step, ...readings }, ...state.referents].slice(0, COPILOT_V2_LIMITS.maxReferents) };
}
/** BUILD-CHAT-LEARNING-002: the interpretable fields (networks, pinned tokens, operation) of a step FloFi can author again; none for compositions. */
const stepFields = (step: WorkflowStep | undefined): ReadingFields => { const base = step ? stepAction(step) : null; return base && !base.composition ? fieldsOfAction(base.actions[0]!) : {}; };
const learningOf = (adaptation: Adaptation, env: CopilotEnvironment): ReplyLearning | null => !env.learning || (!adaptation.observations.length && !adaptation.events.length) ? null
  : { used: [], signals: [], observations: env.learning.automatic === 'ON' ? adaptation.observations : [], events: adaptation.events };
/**
 * BUILD-CHAT-LEARNING-002: the user applied a proposal. If FloFi read some of its fields on its own (adapted, learned or glossary vocabulary),
 * applying it unchanged confirms those readings; from now on FloFi watches that step for a correction on the canvas.
 */
export function proposalApplied(state: CopilotConversation, env: CopilotEnvironment, command: Command): { readonly next: CopilotConversation; readonly learning: ReplyLearning | null } {
  const index = state.referents.findIndex(item => item.command === command), referent = state.referents[index];
  if (!env.learning || !referent?.readings?.length) return { next: state, learning: null };
  const steps = workflowSteps(env.workflow, env.context), detail = JSON.stringify(referent.step.detail);
  const step = steps.find(item => item.nodeId === referent.step.nodeId && JSON.stringify(item.detail) === detail) ?? steps.find(item => JSON.stringify(item.detail) === detail);
  const referents = state.referents.map((item, at) => at === index ? { ...item, applied: true, watched: !!step, ...step ? { step } : {} }
    : step && item.watched && item.step.nodeId === step.nodeId ? { ...item, watched: false } : item);
  return { next: { ...state, referents }, learning: learningOf(confirmedAdaptation(referent.readings), env) };
}
/**
 * BUILD-CHAT-LEARNING-002: the workflow changed outside the Copilot (the canvas). For each applied Copilot step FloFi still watches: a change of
 * exactly a network or token FloFi had read on its own is a correction; a removal, a financial edit or a change of what the user named is not.
 * Each step is evaluated once (its first change). `APPLIED`: the change came from applying a proposal — steps it changed stop being watched,
 * without any signal.
 */
export function observeWorkflow(state: CopilotConversation, env: CopilotEnvironment, origin: 'CANVAS' | 'APPLIED' = 'CANVAS'):
  { readonly next: CopilotConversation; readonly learning: ReplyLearning | null } {
  if (!env.learning || !state.referents.some(item => item.applied && item.watched)) return { next: state, learning: null };
  const steps = workflowSteps(env.workflow, env.context);
  let adaptation: Adaptation = NO_ADAPTATION, changed = false;
  const referents = state.referents.map(item => {
    if (!item.applied || !item.watched || !item.readings?.length) return item;
    const current = steps.find(step => step.nodeId === item.step.nodeId);
    if (!current) {
      changed = true;
      if (origin === 'CANVAS') adaptation = mergeAdaptations(adaptation, { ...NO_ADAPTATION, events: [{ kind: 'CORRECTION_IGNORED', outcome: 'STEP_REMOVED' }] });
      return { ...item, watched: false };
    }
    if (JSON.stringify(current.detail) === JSON.stringify(item.step.detail)) return item;
    changed = true;
    if (origin === 'APPLIED') return { ...item, watched: false, step: current };
    const before = stepAction(item.step), after = stepAction(current);
    if (before && after && !before.composition && !after.composition) {
      const diff = actionDiff(before.actions[0]!, after.actions[0]!);
      if (!diff.replaced) adaptation = mergeAdaptations(adaptation, correctionAdaptation({ readings: item.readings, before: fieldsOfAction(before.actions[0]!),
        after: fieldsOfAction(after.actions[0]!), changed: diff.changed, financial: diff.financial, via: 'CANVAS', cue: null, request: item.request ?? '' }));
    }
    return { ...item, watched: false, step: current };
  });
  if (!changed) return { next: state, learning: null };
  return { next: applyAdaptation({ ...state, referents }, adaptation), learning: learningOf(adaptation, env) };
}
/** BUILD-CHAT-LEARNING-002: the user's message changed fields of a proposal FloFi showed (`referent`) into `result`'s: a correction or not. */
function correctedBy(result: Result, referent: CopilotReferent | undefined, state: CopilotConversation, env: CopilotEnvironment, operationOnly: boolean): Result {
  if (!env.learning || result.reply.kind !== 'PROPOSAL' || !result.reply.command || !referent?.readings?.length) return result;
  const step = changedSteps(env, result.reply.command)[0], before = stepAction(referent.step), after = step ? stepAction(step) : null;
  if (!before || !after || before.composition || after.composition) return result;
  const a = before.actions[0]!, b = after.actions[0]!, cue = correctionCue(state.segment.at(-1) ?? '');
  // A different operation: only the operation is compared (the amount must be the same request's); the same operation: every interpretable field.
  const diff = a.type !== b.type ? { changed: ['operation'] as ReadingField[], financial: !('amount' in a) || !('amount' in b) || a.amount !== b.amount }
    : operationOnly ? null : actionDiff(a, b);
  if (!diff || (operationOnly && cue === null)) return result;
  return withAdaptation(result, env, correctionAdaptation({ readings: referent.readings, before: fieldsOfAction(a), after: fieldsOfAction(b), changed: diff.changed,
    financial: diff.financial, via: 'CHAT', cue, request: referent.request ?? '' }));
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
const BRIDGE_FIELDS: readonly CarriedField[] = ['sourceNetwork', 'destinationNetwork', 'asset', 'outputAsset', 'amount', 'slippage', 'routing', 'recipient'];
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
      asset: d.input.token, outputAsset: option.pair.destination.symbol, amount: d.input.amount, slippageBps: d.input.slippage,
      routing: d.input.routing === 'AUTO' ? null : d.input.routing, recipient: d.input.recipient ? d.input.recipient.toLowerCase() : null }] }; }
    case 'UNIVERSAL_BRIDGE': return { composition: false, role: null, actions: [{ type: 'BRIDGE',
      sourceNetwork: lendingNetworkOf(UNIVERSAL_NETWORKS[d.input.source].chain), destinationNetwork: lendingNetworkOf(UNIVERSAL_NETWORKS[d.input.destination].chain),
      asset: d.input.inputAsset, outputAsset: d.input.outputAsset, amount: d.input.amount, slippageBps: d.input.slippage,
      routing: d.input.routing, recipient: d.input.recipient || null }] };
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
    // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the step's own network (an Orca step on Solana is re-authored on Solana with USDC, never on Devnet).
    case 'ORCA_LIQUIDITY': return { composition: false, role: null, actions: [{ type: 'LIQUIDITY', protocol: 'ORCA', network: d.input.network === 'Solana' ? 'SOLANA' : 'SOLANA_DEVNET',
      deposits: [{ asset: 'SOL', maxAmount: d.input.maxSol }, { asset: d.input.network === 'Solana' ? 'USDC' : 'DEVUSDC', maxAmount: d.input.maxDevUsdc }], rangeUnit: d.input.rangeUnit, lower: d.input.lower,
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
/** The step's current value of a change field (single actions only), as the user would restate it. */
function currentValue(action: CopilotAction, key: keyof CopilotChanges): unknown {
  const a = action as Record<string, unknown>;
  switch (key) {
    case 'network': return action.type === 'BRIDGE' ? action.sourceNetwork : a.network;
    case 'inputAsset': return action.type === 'SWAP' ? action.inputAsset : a.asset;
    case 'recipient': return a.recipient ?? a.beneficiary;
    case 'amount': case 'slippageBps': case 'destinationNetwork': case 'outputAsset': case 'routing': case 'feeTier': return a[key];
    default: return undefined;
  }
}
const unchangedValue = (action: CopilotAction, key: keyof CopilotChanges, value: unknown): boolean => {
  const current = currentValue(action, key);
  if (typeof current !== 'string' || typeof value !== 'string') return false;
  return key === 'amount' || key === 'slippageBps' ? canonicalDecimal(current) === canonicalDecimal(value) : current.toLowerCase() === value.toLowerCase();
};
/** Only the changed fields leave the carried set; each of them must then be grounded in the open request by the planners. */
function applyChanges(base: Base, changes: CopilotChanges): Applied {
  const carried = allFields(base), changed: string[] = [];
  let actions = base.actions.map(action => ({ ...action })) as CopilotAction[];
  const set = (index: number, key: string, value: unknown) => { actions = actions.map((item, at) => at === index ? { ...item, [key]: value } as CopilotAction : item); };
  const drop = (...fields: CarriedField[]) => fields.forEach(field => carried.delete(field));
  // A token moved with its side to another network: carried by symbol, or dropped (and asked again) when it cannot be named portably.
  const move = (index: number, key: string, field: CarriedField, network: CopilotNetwork | null, value: string | null | undefined) => {
    const moved = portableAsset(network, value);
    set(index, key, moved ?? null);
    if (moved === null) drop(field);
  };
  const entries = (Object.keys(changes) as (keyof CopilotChanges)[]).filter(key => key === 'deposits' ? changes.deposits.length > 0 : key === 'lower' || key === 'upper' ? false
    : changes[key] !== null && changes[key] !== undefined);
  for (const key of entries) {
    const action = actions[0]!, type = base.composition ? 'COMPOSITION' : action.type;
    const fail = (): Applied => ({ ok: false, field: key });
    // BUILD-FLOFI-INTELLIGENCE-001: a "change" to the value the step already has is a restatement, not a change: it stays carried.
    if (!base.composition && unchangedValue(action, key, changes[key])) continue;
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
      // BUILD-FLOFI-UX-FIX-003: a side that moves to another network carries its token by symbol (a carried identity is that old chain's contract).
      case 'network':
        if (type === 'COMPOSITION') return fail();
        if (action.type === 'BRIDGE') { move(0, 'asset', 'asset', action.sourceNetwork, action.asset); set(0, 'sourceNetwork', changes.network); drop('sourceNetwork'); }
        else {
          if (action.type === 'SWAP') { move(0, 'inputAsset', 'inputAsset', action.network, action.inputAsset); move(0, 'outputAsset', 'outputAsset', action.network, action.outputAsset); }
          else if (action.type !== 'LIQUIDITY') move(0, 'asset', 'asset', action.network, action.asset);
          set(0, 'network', changes.network); drop('network');
        }
        break;
      case 'destinationNetwork': {
        if (action.type !== 'BRIDGE') return fail();
        // A destination token FloFi chose by default (or the old chain's native coin) is not the user's choice: the new network's default applies, stated.
        if (action.outputAsset && impliedOutput(action)) { set(0, 'outputAsset', null); drop('outputAsset'); }
        else if (action.outputAsset) move(0, 'outputAsset', 'outputAsset', action.destinationNetwork, action.outputAsset);
        set(0, 'destinationNetwork', changes.destinationNetwork); drop('destinationNetwork'); break;
      }
      case 'inputAsset': case 'outputAsset':
        if (type === 'SWAP') { set(0, key, changes[key]); drop(key); }
        else if (type === 'BRIDGE') { const field = key === 'outputAsset' ? 'outputAsset' : 'asset'; set(0, field, changes[key]); drop(field); }
        else if (type === 'SUPPLY' || type === 'BORROW' || type === 'REPAY' || type === 'WITHDRAW' || type === 'TRANSFER') { set(0, 'asset', changes[key]); drop('asset'); }
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
/**
 * BUILD-FLOFI-UX-FIX-003: a token reference carried from `network` as that network's catalog symbol ("0xaf88…@6" on Arbitrum One → USDC), so the
 * planner resolves it again in the new network's own registry (and asks when it is ambiguous there). Unchanged when it cannot be read.
 */
function portableAsset(network: CopilotNetwork | null, value: string | null | undefined): string | null | undefined {
  if (!value || !network || network === 'OTHER') return value;
  const found = lookupAsset(networkOfCopilot(network).key, value);
  if (found.kind === 'FOUND' && found.identity.symbol !== 'TOKEN') return found.identity.symbol;
  // A plain symbol is resolved again on the new network; a contract or mint FloFi cannot name is never carried to another chain (null: asked again).
  return /^[A-Za-z][A-Za-z0-9.]{0,15}$/.test(value) ? value : null;
}
/** BUILD-FLOFI-UX-FIX-003: whether a bridge's destination token is what FloFi would choose by default for its pair, or the destination's native coin. */
function impliedOutput(action: Extract<CopilotAction, { type: 'BRIDGE' }>): boolean {
  const key = (network: CopilotNetwork | null) => network && network !== 'OTHER' ? Object.values(UNIVERSAL_NETWORKS).find(n => n.chain === networkOfCopilot(network).chain)?.key ?? null : null;
  const from = action.sourceNetwork, to = action.destinationNetwork, src = key(from), dst = key(to);
  if (!src || !dst || !from || from === 'OTHER' || !to || to === 'OTHER' || !action.asset || !action.outputAsset || action.asset === 'OTHER' || action.outputAsset === 'OTHER') return false;
  const output = lookupAsset(networkOfCopilot(to).key, action.outputAsset);
  if (output.kind !== 'FOUND') return false;
  if (output.identity.native) return true;
  const input = lookupAsset(networkOfCopilot(from).key, action.asset);
  if (input.kind !== 'FOUND') return false;
  try { return defaultUniversalOutput(src, input.identity.symbol, dst).toUpperCase() === output.identity.symbol.toUpperCase(); } catch { return false; }
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
        if (networks.length === 1 && networks[0]) return missing.includes('sourceNetwork') && !missing.includes('destinationNetwork') ? { sourceNetwork: networks[0] }
          : missing.includes('destinationNetwork') && !missing.includes('sourceNetwork') ? { destinationNetwork: networks[0] } : null;
        return null;
      }
      if (action.type === 'LIQUIDITY') {
        const pool = [en.poolOptions, pt.poolOptions].map(list => list.map(normalize).indexOf(normalize(label))).find(index => index >= 0);
        // BUILD-FLOFI-UX-FIX-003: each button authors on the network it names (the public product's buttons name mainnets).
        const mainnet = activeNetworkScope() === 'PUBLIC_MAINNET';
        if (pool !== undefined) return pool === 0 ? { protocol: 'UNISWAP_V3', network: mainnet ? 'BASE' : 'BASE_SEPOLIA' }
          : pool === 2 ? { protocol: 'UNISWAP_V3', network: mainnet ? 'ETHEREUM' : 'ETHEREUM_SEPOLIA' } : { protocol: 'ORCA', network: mainnet ? 'SOLANA' : 'SOLANA_DEVNET' };
      }
      if (networks.length === 1 && networks[0] && missing.includes('network')) return { network: networks[0] };
      const assetField = missing.filter(field => ['asset', 'inputAsset', 'outputAsset'].includes(field));
      if (assetField.length === 1 && action.type !== 'LIQUIDITY') return { [assetField[0]!]: label };
      return null;
    })();
    if (patch) out.push({ label, fill: { kind: 'ACTION', patch } });
  }
  return out;
}
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (UX-02): FloFi's own open question when, and only when, it waits for the AMOUNT of one single action
 * that spends a wallet balance (swap input, bridge, transfer, Aave supply) on a named network and asset, and nothing else is missing. Read from
 * the structured draft (never from the question's wording). Null for a goal plan's amount or cap (a future output), a composition or sequence,
 * a liquidity deposit and Borrow/Repay/Withdraw (not a wallet balance; Repay and Withdraw are partial-only). A model-phrased clarification
 * qualifies only when it waits for exactly the amount of one open action whose asset and network the person stated (FIX-01: both
 * clarification paths carry the same structured metadata; the model's wording never widens what a shortcut may do).
 */
export function awaitingAmount(state: CopilotConversation): AwaitingAmount | null {
  const draft = state.draft;
  if (!draft || !draft.amountFill || draft.depositFill || draft.rangeHold || !draft.question || draft.intent.kind !== 'ACTION') return null;
  if ((draft.expected ?? []).length !== 1 || draft.expected![0] !== 'amount' || draft.extras?.planned || draft.extras?.target) return null;
  const action = draft.intent.action;
  const spent = action.type === 'SWAP' ? { kind: 'SWAP' as const, asset: action.inputAsset, network: action.network }
    : action.type === 'BRIDGE' ? { kind: 'BRIDGE' as const, asset: action.asset, network: action.sourceNetwork }
      : action.type === 'TRANSFER' ? { kind: 'TRANSFER' as const, asset: action.asset, network: action.network }
        : action.type === 'SUPPLY' ? { kind: 'SUPPLY' as const, asset: action.asset, network: action.network } : null;
  if (!spent || !spent.asset || spent.asset === 'OTHER' || !spent.network || spent.network === 'OTHER') return null;
  // FloFi's buttons for "which reading?" of a typed amount are the answer there: no balance shortcuts beside them.
  if ((draft.shown ?? []).length) return null;
  // The planners ask for the amount BEFORE they check the network and the asset, so both must already be the person's own (stated in their
  // words, with an identity on that chain) or carried by FloFi itself; a value only the model wrote never selects a balance.
  const fields = action.type === 'SWAP' ? { asset: 'inputAsset', network: 'network' } : action.type === 'BRIDGE' ? { asset: 'asset', network: 'sourceNetwork' }
    : { asset: 'asset', network: 'network' };
  const carried = new Set<string>(draft.extras?.carried ?? []), validated = draft.validated ?? [];
  const settled = (field: string, value: string) => carried.has(field) || validated.some(entry => entry.step === 0 && entry.field === field && entry.value === value);
  if (!settled(fields.network, spent.network) || !settled(fields.asset, spent.asset)) return null;
  // Aave: only a reserve this market lists for supplying on that network (FloFi would otherwise refuse after the amount).
  if (spent.kind === 'SUPPLY' && !lendingOffers('supply').some(offer => offer.network.copilot === spent.network && offer.asset.toLowerCase() === spent.asset!.toLowerCase())) return null;
  return { field: 'amount', action: spent.kind, asset: spent.asset, network: spent.network as CopilotNetworkId, question: draft.question,
    ...draft.relative ? { relative: draft.relative } : {} };
}
/** A reply that is only a number answers Flofi's amount question, when it has exactly one reading. */
const BARE_AMOUNT = /^\s*(\d+(?:[.,]\d+)*)\s*(usdc|usdg|weth|eth|sol|usdt|devusdc)?\s*[.!]?\s*$/i;
function bareAmount(text: string): string | null {
  const match = BARE_AMOUNT.exec(text);
  const readings = match ? amountReadings(match[1]!) : [];
  return readings.length === 1 && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(readings[0]!) && readings[0]!.length <= COPILOT_LIMITS.maxValueLength ? readings[0]! : null;
}
/** The asset unit written after a bare amount ("1 USDC" → USDC), or null when none is written. */
const amountUnit = (text: string): string | null => BARE_AMOUNT.exec(text)?.[2]?.toUpperCase() ?? null;
/** The asset an open single action sends (bridge/transfer/lending asset, swap input), or null. */
function sentAssetOf(intent: CopilotIntentV2): string | null {
  if (intent.kind !== 'ACTION') return null;
  const action = intent.action;
  const sent = action.type === 'SWAP' ? action.inputAsset : action.type === 'LIQUIDITY' ? null : action.asset;
  return sent && sent !== 'OTHER' ? sent : null;
}
const displayAsset = (asset: string) => /^[a-z]{2,6}$/.test(asset) ? asset.toUpperCase() : asset;
/** A bare amount that answers Flofi's question for one pool token's maximum becomes that deposit of the request's liquidity step. */
function patchDeposit(intent: CopilotIntentV2, asset: string, maxAmount: string): CopilotIntentV2 {
  const same = (written: string) => written.toUpperCase() === asset.toUpperCase() || (asset === 'devUSDC' && COPILOT_POOLS.ORCA.symbol(written) === 'devUSDC');
  const add = (action: CopilotAction): CopilotAction => action.type !== 'LIQUIDITY' ? action
    : { ...action, deposits: [...action.deposits.filter(d => !same(d.asset)), { asset: asset === 'devUSDC' ? 'DEVUSDC' : asset, maxAmount }] };
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
function patchIntent(intent: CopilotIntentV2, patch: Readonly<Record<string, unknown>>, expected: readonly string[] = []): CopilotIntentV2 {
  if (intent.kind === 'GOAL') return patchGoal(intent, patch, expected);
  if (intent.kind === 'EDIT' || intent.kind === 'REPEAT') return { ...intent, changes: { ...intent.changes, ...patch } };
  if (intent.kind !== 'ACTION') return intent;
  const action = { ...intent.action } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) if (key in action) action[key] = value;
  return { ...intent, action: action as CopilotAction };
}

/** The clarification budget counts lack of progress. A newly validated value opens the budget for the next missing slot. */
function answeredDraft(state: CopilotConversation, intent: CopilotIntentV2, text: string): CopilotConversation {
  const next = withUser(state, text), before = state.draft?.validated ?? [];
  const after = validatedDraftFields(intent, segmentText(next)), slots = filledSlots(state, intent);
  const progress = after.some(field => !before.some(old => old.step === field.step && old.field === field.field && JSON.stringify(old.value) === JSON.stringify(field.value)))
    || slots.progress;
  return { ...next, slots: slots.slots, ...progress ? { clarifications: 0 } : {} };
}
/**
 * BUILD-P1: an answer that fills a slot this request never had (a deposit, a range bound, a range kind, a fee tier) is progress too. The request
 * remembers every slot it has filled (`slots`), so clearing and refilling one is not progress again: the budget reopens at most once per slot.
 */
function filledSlots(state: CopilotConversation, after: CopilotIntentV2): { readonly progress: boolean; readonly slots: readonly string[] } {
  const before = state.draft?.intent ?? null;
  // Only the same request progresses: another operation is not an answer to the open question.
  if (!before || operationsOf(before) !== operationsOf(after)) return { progress: false, slots: state.slots ?? [] };
  const known = new Set([...state.slots ?? [], ...draftSlots(before)]), fresh = draftSlots(after).filter(slot => !known.has(slot));
  return { progress: fresh.length > 0, slots: [...known, ...fresh] };
}
/**
 * BUILD-P1 pool conversational reliability: a short answer to FloFi's open range question ("lower", "1usdc", "±10%", "full range", "150 to 180") is
 * read here, deterministically, and fills only the range of the open liquidity request — never a model call, never another field. A value whose side
 * is not known is held and FloFi asks which side it is; a side whose value is not known is asked for. Anything else returns null (the interpreter).
 */
const RANGE_QUESTION = /^COPILOT_(?:RANGE_|POOL_PRICE_|POOL_READ_|POOL_IDENTITY_)/;
/** FloFi's own questions for the percentage itself: which one, one it could not find in the message, one outside 0.01–90%. */
const PERCENT_QUESTION = /^COPILOT_RANGE_(?:PERCENT_REQUIRED|PERCENT_NOT_FOUND|OUT_OF_RANGE)$/;
function rangeTurn(state: CopilotConversation, draft: Draft, picked: string, env: CopilotEnvironment, m: CopilotCopy): TurnStart | null {
  const intent = draft.intent;
  if (intent.kind !== 'ACTION' || intent.action.type !== 'LIQUIDITY') return null;
  // Only under FloFi's own range questions (or while it holds a range answer): a fee tier, a pool or a model's own question is never read here.
  if (!draft.rangeHold && !RANGE_QUESTION.test(draft.code ?? '')) return null;
  // The pool's unit, also when the interpreter left the network out but the user named it ("on Solana"): FloFi never asks with empty units.
  const action = intent.action, named = action.network === null ? copilotNetworksMentioned(segmentText(state)) : [];
  const units = liquidityUnits(action) ?? (named.length === 1 ? liquidityUnits({ ...action, network: named[0]! }) : null);
  const answer = readRangeAnswer(picked, units);
  if (!answer) return null;
  const percentAsked = PERCENT_QUESTION.test(draft.code ?? '');
  const step = applyRangeAnswer(action, draft.rangeHold ?? null, answer, percentAsked);
  if (!step) return null;
  const patched: CopilotIntentV2 = { ...intent, action: step.action }, next = answeredDraft(state, patched, picked);
  // A bare number that answered FloFi's own percentage question is that percentage (and only then: never a number answering anything else, such
  // as a range or price question that a percentage kind happened to be open under).
  const percentAnswer = answer.kind === 'VALUE' && percentAsked && action.rangeUnit === 'PERCENT' && step.action.rangeUnit === 'PERCENT' ? step.action.upper : null;
  const extras: Extras = { ...draft.extras ?? {}, ...percentAnswer ? { answeredPercent: percentAnswer } : {} };
  const local = (result: Result): TurnStart => ({ kind: 'LOCAL', ...withLearning(tallied(result, env), env, ['CLARIFICATION_ANSWERED']) });
  const keep = { intent: patched, expected: ['range'] as DraftField[], validated: validatedDraftFields(patched, segmentText(next)), options: [], amountFill: false,
    snapshot: snapshotOf(env), ...draft.extras ? { extras: draft.extras } : {} };
  // Without the pool's unit FloFi cannot word its own question: the interpreter answers instead.
  if (!units && step.ask !== null) return null;
  const quote = units?.quote ?? '', base = units?.base ?? '';
  const unit = step.action.rangeUnit === 'TICK' ? 'TICK' as const : 'PRICE' as const;
  if (step.ask === 'SIDE' && step.hold?.value) {
    const both = step.action.lower !== null && step.action.upper !== null && (step.action.rangeUnit === 'PRICE' || step.action.rangeUnit === 'TICK');
    const valueUnit = step.hold.unit ?? (step.hold.value.startsWith('-') ? 'TICK' : unit);
    const text = both ? m.rangeSideReplace(step.hold.value, valueUnit, quote, base) : m.rangeSide(step.hold.value, valueUnit, quote, base);
    return local(question(next, m, text, m.rangeSideOptions, { ...keep, rangeHold: step.hold }, [], { code: 'COPILOT_RANGE_SIDE_REQUIRED' }));
  }
  if (step.ask === 'BOUND' && step.hold?.side)
    return local(question(next, m, m.rangeBoundAsk(step.hold.side, unit, quote, base), [], { ...keep, rangeHold: step.hold }, [], { code: 'COPILOT_RANGE_BOUND_REQUIRED' }));
  return local(resolveIntent(patched, next, env, null, extras));
}

// ── BUILD-FLOFI-UNIFIED-COPILOT-001: conversational aids ─────────────────────────────────────────────────────────────────
/** A turn beside the open request: the draft, its question, the segment and the clarification budget stay exactly as they were. */
const aside = (state: CopilotConversation, text: string, summary: string, patch: Partial<CopilotConversation> = {}): CopilotConversation =>
  ({ ...state, ...patch, transcript: bounded([...state.transcript, { role: 'user', text }, { role: 'assistant', text: summary }]) });
/** An answer given while FloFi's question is open reminds the user of it and offers to continue (nothing is cancelled or approved). */
function withDraftReminder(value: CopilotReply, state: CopilotConversation, language: CopilotLanguage): CopilotReply {
  const question = state.draft?.question;
  if (!question) return value;
  const a = ASSIST_COPY[language];
  return { ...value, notes: [...value.notes, a.stillOpen(question)], options: [...value.options.filter(option => option !== a.resumeOption).slice(0, 3), a.resumeOption] };
}
/** FloFi's explanation of a concept (or of the concept in the user's workflow), from its own copy only. */
function conceptReply(env: CopilotEnvironment, language: CopilotLanguage, id: ConceptId, level: ConceptLevel, protocol: ConceptProtocol | null, workflow: boolean):
  { readonly reply: CopilotReply; readonly concept: ConceptState } {
  if (workflow) {
    const view = conceptInWorkflow(id, env.facts.steps, language, step => stepSentence(step, language));
    return { reply: reply('ANSWER', view.text, { notes: view.notes, topic: 'CONCEPT' }), concept: { id, level, protocol } };
  }
  const answer = answerConcept(id, { level, protocol, language, workflowSteps: env.facts.steps });
  return { reply: reply('ANSWER', answer.text, { notes: answer.notes, options: answer.options, topic: 'CONCEPT' }), concept: answer.state };
}
/** FloFi's guide to one of its own screens or settings, with the page to open when the surface can link to it. */
function platformReply(topic: PlatformTopic, language: CopilotLanguage, env: CopilotEnvironment): CopilotReply {
  const answer = platformAnswer(topic, language, env.surface ?? 'WEB');
  return reply('ANSWER', answer.text, { topic: 'PLATFORM', ...answer.link ? { link: answer.link } : {} });
}
const AUTOMATION_WORD = /(?:^|\s)(?:automac\w*|automation\w*|automatiz\w*|dca|recorrente|recurring|compra recorrente)(?:\s|$)/;
const QUESTIONISH = /\?\s*$|(?:^|\s)(?:o que acontece|what happens|e se|what if|and if|como|how|por que|porque|why|pode|can it|will it|vai|sera que|e quando|when)(?:\s|$)/;
const MANAGE_VERBS: readonly (readonly [CopilotAutomationOperation, RegExp])[] = [
  ['PAUSE', /(?:^|\s)(?:pausa|pausar|pause|suspende|suspender)(?:\s|$)/], ['RESUME', /(?:^|\s)(?:retoma|retomar|resume|reativa|reativar|reactivate|despausa)(?:\s|$)/],
  ['ARCHIVE', /(?:^|\s)(?:exclui|excluir|apaga|apagar|deleta|deletar|delete|remove|remover|cancela|cancelar|arquiva|arquivar|archive)(?:\s|$)/],
  ['LIST', /(?:^|\s)(?:quais|which|what|lista|list|mostra|mostrar|show|ver|see)(?:\s|$)/]];
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: the automation this conversation is about. A question about how automations behave is FloFi's own answer; "muda
 * para segunda" re-proposes an automation the owner has not created yet (a saved one is changed only through FloFi's confirmed replacement); a
 * pause/resume/delete/list request opens the owner's own automations for an explicit confirmation. Nothing here changes a saved automation.
 */
function automationTurn(state: CopilotConversation, text: string, env: CopilotEnvironment, language: CopilotLanguage): TurnStart | null {
  // An open automation question is answered by the draft path ("toda segunda às 9h" is that request's schedule, never an earlier proposal's).
  if (state.draft?.intent.kind === 'AUTOMATION') return null;
  const folded = foldText(text), about = Boolean(state.automation) || AUTOMATION_WORD.test(folded);
  if (!about || folded.length > 160 || /0x[0-9a-f]{6}/i.test(text)) return null;
  // The folded text has no punctuation: a trailing "?" is read from the raw message.
  const a = ASSIST_COPY[language], current = state.automation?.input ?? null, question = /\?\s*$/.test(text) || QUESTIONISH.test(folded);
  // A schedule change of the proposal FloFi just showed and the owner has not created: the same proposal, with the new schedule. Only a plain
  // instruction with no other request open: a question ("is 9am ok?") is answered, never applied.
  const patched = current && !state.automation?.created && !state.draft && !question ? rescheduleDraft(current, text) : null;
  if (patched) {
    const value = reply('AUTOMATION_PROPOSAL', a.automationUpdated, { automation: patched });
    return { kind: 'LOCAL', reply: value, next: aside(state, text, COPILOT_TRANSCRIPT.proposed + patched.name, { automation: { input: patched, created: false } }) };
  }
  const manage = (operation: CopilotAutomationOperation): TurnStart => ({ kind: 'LOCAL', reply: withDraftReminder(reply('AUTOMATION_MANAGE', a.manage[operation],
    { manage: { operation, request: text } }), state, language), next: aside(state, text, `Flofi opened the user's saved automations (${operation}).`, { automation: { input: null, created: true } }) });
  const faq = matchAutomationFaq(text);
  // A saved automation's schedule changes only by a confirmed replacement, which the owner's own automation view prepares.
  if (state.automation?.created && faq === 'SCHEDULE_CHANGE' && !question) return manage('RESCHEDULE');
  if (faq === 'WHY_NOT_RUN' && (state.automation?.created || AUTOMATION_WORD.test(folded))) return manage('WHY_NOT_RUN');
  if (question && faq && (faq !== 'SCHEDULE_CHANGE' || !/\d/.test(folded))) return { kind: 'LOCAL', reply: withDraftReminder(reply('ANSWER', automationFaq(faq, language), { topic: 'AUTOMATIONS' }), state, language),
    next: aside(state, text, `Flofi explained how automations behave (${faq}).`) };
  if (!AUTOMATION_WORD.test(folded)) return null;
  const verb = MANAGE_VERBS.find(([operation, pattern]) => pattern.test(folded) && (operation === 'LIST' || !question));
  return verb ? manage(verb[0]) : null;
}
/** "What can you explain?": the catalog's names, with a few of them as options. */
const conceptMenu = (language: CopilotLanguage): { readonly text: string; readonly notes: readonly string[]; readonly options: readonly string[] } => {
  const names = conceptCatalog(language).map(entry => entry.name);
  return { text: ASSIST_COPY[language].conceptMenu(names.slice(0, 8)), notes: [], options: [] };
};
function assistTurn(state: CopilotConversation, text: string, env: CopilotEnvironment, language: CopilotLanguage): TurnStart | null {
  const a = ASSIST_COPY[language], draft = state.draft;
  // "Ok, vamos continuar": FloFi's own open question again, with its buttons. It answers nothing and is not counted as a new question.
  if (draft?.question && resumeRequest(text) && !contextChange(draft.snapshot, snapshotOf(env)))
    return { kind: 'LOCAL', reply: reply('CLARIFICATION', a.resumed(draft.question), { options: draft.shown ?? draft.options.map(option => option.label) }),
      next: aside(state, text, COPILOT_TRANSCRIPT.asked + draft.question, { concept: null }) };
  // An answer to FloFi's open question always wins over an explanation (a slot value is never read as a concept): a value it reads, one of its own
  // buttons ("Across", a saved name, "Arbitrum One"), or a bare amount for an amount question.
  if (draft && (answerDraftField(draft.intent, draft.expected ?? [], text) || [...draft.shown ?? [], ...draft.options.map(option => option.label)].some(label => normalize(label) === normalize(text))
    || ((draft.amountFill || draft.depositFill) && bareAmount(text)) || (draft.intent.kind === 'POSITION' && readPositionAnswer(text) !== null))) return null;
  const followUp = state.concept ? conceptFollowUp(text) : null, asked = followUp ? null : conceptQuestion(text);
  if (!followUp && !asked) {
    const automated = automationTurn(state, text, env, language);
    if (automated) return automated;
    // "Como conecto minha Phantom?", "onde vejo minhas automações?": FloFi's own guide to its screens, never a change.
    const topic = matchPlatformTopic(text);
    if (!topic) return null;
    return { kind: 'LOCAL', reply: withDraftReminder(platformReply(topic, language, env), state, language), next: aside(state, text, `Flofi answered how to use FloFi (${topic}).`) };
  }
  let id: ConceptId, level: ConceptLevel = 'STANDARD', protocol: ConceptProtocol | null = null, workflow = false;
  if (followUp && state.concept) {
    id = state.concept.id;
    if (followUp.kind === 'LEVEL') level = followUp.level === 'SIMPLE' && state.concept.level === 'SIMPLE' ? 'EXAMPLE' : followUp.level;
    else if (followUp.kind === 'PROTOCOL') protocol = followUp.protocol;
    else { level = state.concept.level; protocol = state.concept.protocol; workflow = true; }
  } else id = asked!;
  const answer = conceptReply(env, language, id, level, protocol, workflow);
  return { kind: 'LOCAL', reply: withDraftReminder(answer.reply, state, language),
    next: aside(state, text, a.explained(conceptName(id, 'EN'), workflow ? 'WORKFLOW' : protocol ?? level), { concept: answer.concept }) };
}
/** The user's answer to FloFi's optional offer to save a typed address; null when the message is about something else (the offer is dropped). */
function answerRecipientOffer(state: CopilotConversation, offer: RecipientOffer, text: string, language: CopilotLanguage, env: CopilotEnvironment): TurnStart | null {
  const a = ASSIST_COPY[language], answer = recipientOfferAnswer(text);
  const local = (value: CopilotReply, next: CopilotConversation): TurnStart => ({ kind: 'LOCAL', reply: value, next });
  if (answer?.kind === 'DECLINE')
    return local(reply('ANSWER', a.recipientDeclined), aside({ ...state, recipientOffer: null, recipientDeclined: [...state.recipientDeclined ?? [], offer.address].slice(-16) },
      text, 'Flofi did not save the address.'));
  // While FloFi waits for a name, a new request or an address is read as itself (the offer is dropped), never saved as the name.
  if (!answer && (!offer.naming || requestLikeName(text))) return null;
  const written = answer?.kind === 'ACCEPT' ? answer.label : offer.naming ? text.trim() : null;
  if (written === null) return local(reply('CLARIFICATION', a.recipientName(offer.suggestion), { options: offer.suggestion ? [offer.suggestion] : [] }),
    aside({ ...state, recipientOffer: { ...offer, naming: true } }, text, 'Flofi asked for a name for the address.'));
  const label = savedRecipientLabel(written);
  if (!label) return local(reply('CLARIFICATION', a.recipientLabelInvalid, { options: offer.suggestion ? [offer.suggestion] : [] }),
    aside({ ...state, recipientOffer: { ...offer, naming: true } }, text, 'Flofi asked for another name.'));
  if ((env.recipients ?? []).some(recipient => recipientLabelKey(recipient.label) === recipientLabelKey(label)))
    return local(reply('CLARIFICATION', a.recipientLabelTaken(label), { options: [] }), aside({ ...state, recipientOffer: { ...offer, naming: true } }, text, 'Flofi asked for another name.'));
  return local(reply('ANSWER', a.recipientSaving(label), { recipientSave: { label, address: offer.address, ecosystem: offer.ecosystem } }),
    aside({ ...state, recipientOffer: null }, text, 'Flofi saved the address under a name the user chose.'));
}

// ── Turns ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Starts a user turn: a local answer (input refused, secret, or a reply to Flofi's own question) or a request for the model. */
export function startTurn(current: CopilotConversation, raw: string, env: CopilotEnvironment): TurnStart {
  let state = current;
  // BUILD-CHAT-LEARNING-002: a new conversation starts in the language this identity usually writes in (a starting point; its own words decide after).
  const hint = env.learning?.languageHint;
  if (hint && !state.transcript.length && !state.languageSet && state.language !== hint) state = { ...state, language: hint };
  const language = preferredLanguage(state, env) ?? state.language;
  const text = typeof raw === 'string' ? raw.trim() : '', m = copilotCopy(language);
  if (!text || text.length > COPILOT_LIMITS.maxUserMessageLength || hasUnsafeCharacters(text))
    return { kind: 'LOCAL', reply: reply('FAILED', failureText('COPILOT_INPUT_INVALID', language)), next: state };
  // No model runs for a secret, so its language comes from the conversation or from the Portuguese wording that matched.
  if (looksSecret(text)) return { kind: 'LOCAL', reply: reply('UNSUPPORTED', /chaves?\s+privad|frases?\s+(?:semente|secreta|de\s+recupera)|palavras\s+secretas/i.test(text)
    ? copilotCopy('PT').secret : m.secret), next: state };
  // BUILD-CHAT-LEARNING-001: FloFi's memory offer, then statements about the user's own vocabulary — deterministic, local, never sent to the model.
  if (env.learning) {
    // BUILD-CHAT-LEARNING-002: FloFi no longer offers to remember; only its confirmation before erasing everything is still answered.
    if (state.offer && state.offer.action.op !== 'FORGET_ALL') state = { ...state, offer: null };
    if (state.offer) {
      const yes = isYes(text) ? true : isNo(text) ? false : null;
      if (yes !== null) return { kind: 'LOCAL', ...answerOffer(state, state.offer, yes, language) };
      state = { ...state, offer: null };
    }
    const statement = parseMemoryStatement(text);
    // FloFi answers in the language the statement was written in, unless the user chose a reply language (a language statement: the new one).
    // P0 approved UX: with an interface language, a reply-language statement is answered in that language and points to the language setting —
    // nothing is promised, set or learned that the screen's language would then override.
    if (statement?.kind === 'LANGUAGE' && env.interfaceLanguage)
      return { kind: 'LOCAL', reply: reply('ANSWER', learningCopy(env.interfaceLanguage).languageFollowsScreen), next: { ...state, offer: null } };
    if (statement) return { kind: 'LOCAL', ...memoryTurn(state, statement, env.learning, statement.kind === 'LANGUAGE' ? statement.language
      : preferredLanguage(state, env) ?? statement.said) };
  }
  // BUILD-FLOFI-UNIFIED-COPILOT-001: FloFi's optional offer to save a typed address is answered by its buttons or words; anything else drops it.
  const assistLanguage = env.interfaceLanguage ?? preferredLanguage(state, env) ?? messageLanguage(text) ?? questionLanguage(text) ?? state.language;
  if (state.recipientOffer) {
    const offered = answerRecipientOffer(state, state.recipientOffer, text, assistLanguage, env);
    if (offered) return offered;
    state = { ...state, recipientOffer: null };
  }
  const answered = yesOrNo(state, text, env, m);
  if (answered && !('pick' in answered)) return answered;
  // BUILD-FLOFI-UNIFIED-COPILOT-001: going back to the open request, a DeFi concept and its follow-ups are answered locally (no model, no change).
  if (!answered) {
    const assisted = assistTurn(state, text, env, assistLanguage);
    // The conversation continues in the language FloFi just answered in ("mais detalhes" after a Portuguese explanation stays Portuguese).
    if (assisted) return assisted.kind === 'LOCAL' && !state.languageSet ? { ...assisted, next: { ...assisted.next, language: assistLanguage } } : assisted;
    if (state.concept) state = { ...state, concept: null };
  }
  const draft = state.draft, picked = answered ? answered.pick : text;
  if (draft) {
    const changed = contextChange(draft.snapshot, snapshotOf(env));
    // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: an open position choice says which change ended it (another wallet's positions are read again on request).
    if (changed) return { kind: 'LOCAL', ...failedWith(closeSegment(state), m, draft.intent.kind === 'POSITION' ? m.lifecycle.stale(changed) : m.draftStale, 'COPILOT_CONTEXT_CHANGED') };
    const positioned = positionTurn(state, draft, picked, env);
    if (positioned) return positioned;
    const ranged = rangeTurn(state, draft, picked, env, m);
    if (ranged) return ranged;
    const filled = answerDraftField(draft.intent, draft.expected ?? [], picked);
    if (filled && !draft.options.some(o => normalize(o.label) === normalize(picked))) return { kind: 'LOCAL', ...withLearning(tallied(resolveIntent(filled, answeredDraft(state, filled, picked), env, null, draft.extras ?? {}), env), env, ['CLARIFICATION_ANSWERED']) };
    const option = draft.options.find(item => normalize(item.label) === normalize(picked));
    // BUILD-FLOFI-UX-FIX-003: "1 USDC" never answers "How much ETH…?": an amount written in another asset than the one sent is asked again.
    const unit = !option && draft.amountFill ? amountUnit(text) : null, sent = sentAssetOf(draft.intent);
    if (unit && sent && unit !== sent.toUpperCase()) return { kind: 'LOCAL', ...question(withUser(state, text), m, m.amountUnitMismatch(unit, displayAsset(sent)), [], draft) };
    // BUILD-P1: "2 SOL" never answers "How much USDC at most?": an answer in another token than the one asked for is asked again.
    // The same token by another name is the same answer (USDC for devUSDC, ETH for WETH); a test token is never repeated in the public product.
    const written = !option && draft.depositFill ? amountUnit(text) : null, fill = draft.depositFill?.toUpperCase() ?? '';
    const sameToken = written === fill || (fill === 'DEVUSDC' && written === 'USDC') || (fill === 'WETH' && written === 'ETH');
    if (written && !sameToken) {
      const shown = activeNetworkScope() === 'PUBLIC_MAINNET' && mentionsTestNetwork(written) ? null : written;
      return { kind: 'LOCAL', ...question(withUser(state, text), m, m.depositUnitMismatch(shown, draft.depositFill!), [], draft) };
    }
    const amount = !option && (draft.amountFill || draft.depositFill) ? bareAmount(text) : null;
    if (option || amount) {
      if (contextChange(draft.snapshot, snapshotOf(env))) return { kind: 'LOCAL', ...failed(closeSegment(state), m, m.draftStale) };
      // "Yes" to a question with exactly one offered answer is that answer, in Flofi's own words.
      // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 (flofi-chat review P1/P2): a position button is recorded as a neutral choice, never as its label — the
      // label's fee tier ("0.05%") is not the user's percentage, and its token id and amounts never reach the model's transcript.
      const listedPosition = draft.code === POSITION_WHICH && option?.fill.kind === 'EXTRAS' && option.fill.extras.position !== undefined;
      const next = withUser(state, listedPosition ? POSITION_OPTION_CHOSEN : picked), extras = draft.extras ?? {};
      // BUILD-CHAT-LEARNING-001: answering FloFi's own question is a content-free clarification signal (and says whether a glossary suggestion held).
      const signals: LearningSignal[] = ['CLARIFICATION_ANSWERED', ...option && draft.suggestion
        ? [copilotNetworksMentioned(option.label).includes(draft.suggestion) ? 'SUGGESTION_CONFIRMED' as const : 'SUGGESTION_REJECTED' as const] : []];
      const local = (result: Result): TurnStart => ({ kind: 'LOCAL', ...withLearning(tallied(result, env), env, signals) });
      if (option?.fill.kind === 'TARGET') return local(resolveIntent(draft.intent, next, env, option.fill.target, extras));
      if (option?.fill.kind === 'EXTRAS') return local(resolveIntent(draft.intent, next, env, null, { ...extras, ...option.fill.extras }));
      // A deposit FloFi asked for fills a slot of the request: progress, like any other answer to its own question.
      // BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001: the cap FloFi asked for a dependent step of a sequence request fills exactly that step's amount.
      if (!option && amount && draft.intent.kind === 'COMPOSITION' && extras.capStep !== undefined && draft.intent.actions[extras.capStep]) {
        const index = extras.capStep, capped = draft.intent.actions[index]!;
        // "0.0004 USDC" never answers "the most ETH step 2 may use" (chat review M4): an amount in another token is asked again.
        const written = amountUnit(text), spent = inputAssetOf(capped);
        if (written && spent && !sameWrittenAsset(written, spent))
          return { kind: 'LOCAL', ...question(withUser(state, text), m, m.amountUnitMismatch(written, displayAsset(spent)), [], draft) };
        const patched: CopilotIntentV2 = { ...draft.intent, actions: draft.intent.actions.map((action, at) => at === index && action.type !== 'LIQUIDITY'
          ? { ...action, amount } as CopilotAction : action) };
        const { capStep: _asked, ...rest } = extras;
        void _asked;
        return local(resolveIntent(patched, answeredDraft(state, patched, picked), env, null, { ...rest, capFunded: [...rest.capFunded ?? [], index] }));
      }
      if (!option && draft.depositFill) {
        const patched = patchDeposit(draft.intent, draft.depositFill, amount!);
        return local(resolveIntent(patched, answeredDraft(state, patched, picked), env, null, { ...extras, carried: [...extras.carried ?? [], `asset:${draft.depositFill}`] }));
      }
      const intent = option?.fill.kind === 'ACTION' ? patchIntent(draft.intent, option.fill.patch, draft.expected) : patchIntent(draft.intent, { amount }, draft.expected);
      return local(resolveIntent(intent, answeredDraft(state, intent, picked), env, null, extras));
    }
  }
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: "50%", "all of it", "only the fees", "yes, close it", "Arbitrum" right after FloFi prepared a position
  // operation change that choice (local, re-read from the verified facts, a new proposal every time).
  if (!state.draft) {
    const followed = positionFollowUp(state, text, env);
    if (followed) return followed;
  }
  let next = withUser(state, text);
  // BUILD-FLOFI-INTELLIGENCE-001: FloFi's sanitized context card travels with the request; the model reads it only through a read-only tool.
  const card = contextCard(operationalState(next, env)), key = contextKey(card);
  // BUILD-FLOFI-UNIFIED-COPILOT-001: a saved recipient's name and address never leave for a model provider, in the user's words or in FloFi's own
  // (a "which one?" question lists names; a proposal summary carries the address); FloFi resolves them itself.
  const live = env.recipients ?? [], all = next.transcript.map(entry => entry.text).join('\n');
  const masks = [...state.recipientMasks ?? [], ...live.filter(recipient => !(state.recipientMasks ?? []).some(other => other.id === recipient.id)
    && maskSavedRecipients(all, [recipient]) !== all)].slice(-SAVED_RECIPIENT_LIMITS.maxPerAccount);
  const maskWith = [...live, ...masks.filter(mask => !live.some(recipient => recipient.id === mask.id))];
  const messages = maskWith.length ? next.transcript.map(entry => ({ ...entry, text: maskSavedRecipients(entry.text, maskWith) })) : next.transcript;
  if (masks.length) next = { ...next, recipientMasks: masks };
  return { kind: 'REMOTE', request: { version: '2', messages, context: card, contextKey: key, ...env.interfaceLanguage ? { replyLanguage: env.interfaceLanguage } : {} },
    turn: { before: state, state: next, snapshot: snapshotOf(env), contextKey: key } };
}
/** Finishes a model turn against the current state. A changed workflow, proposal or wallet discards the answer. */
export function finishTurn(turn: PendingTurn, result: CopilotResultV2, env: CopilotEnvironment): Result {
  // BUILD-CHAT-LEARNING-001: a reply language the user chose wins over the language of their message (display copy only).
  const preferred = preferredLanguage(turn.state, env), language = preferred ?? turn.state.language, m = copilotCopy(language), rollback = turn.before.draft ? turn.before : closeSegment(turn.before);
  const change = contextChange(turn.snapshot, snapshotOf(env));
  if (change) return { reply: reply('FAILED', change === 'WORKFLOW' ? m.workflowChanged : change === 'PROPOSAL' ? m.proposalChanged : m.walletChanged), next: closeSegment(turn.before) };
  // BUILD-P1: a failed interpretation keeps FloFi's open question (and says so), with its closed code for content-free turn metrics.
  if (!result.ok) return tallied({ reply: withDraftReminder(reply('FAILED', failureText(result.code, language, result.retryAfterSeconds), { code: result.code }), rollback, language), next: rollback }, env);
  // BUILD-FLOFI-INTELLIGENCE-001: tool facts were read for the context this turn sent; an answer bound to any other context is never applied.
  if (turn.contextKey && result.contextKey !== undefined && result.contextKey !== turn.contextKey)
    return { reply: reply('FAILED', m.workflowChanged), next: closeSegment(turn.before) };
  let intent: CopilotIntentV2;
  try { intent = parseCopilotIntentV2(withoutRecipientMarker(result.intent)); }
  catch (cause) {
    const code = isCopilotIntentError(cause) && cause.message === 'COPILOT_TOO_MANY_ACTIONS' ? cause.message : 'COPILOT_INTENT_INVALID';
    return tallied({ reply: withDraftReminder(reply('FAILED', failureText(code, language), { code }), rollback, language), next: rollback }, env);
  }
  intent = mergeDraftIntent(turn.before.draft?.intent ?? null, intent, turn.state.segment.at(-1) ?? '');
  // BUILD-P1: an interpreted answer that filled a slot the open request never had is progress: the clarification budget opens again for the next one.
  const progressed = filledSlots(turn.before, intent);
  // P0 approved UX: FloFi composes its reply in the interface language, not the language the model detected.
  // P0 hotfix (locale contract): a model text written in another language than the person's (a closed replay fixture, or a model that ignored the
  // reply-language note) is never shown; FloFi's own copy in the person's language stands instead. The values it offered (networks, assets) stay.
  if (env.interfaceLanguage && 'language' in intent && intent.language !== env.interfaceLanguage) intent = { ...withoutForeignProse(intent), language: env.interfaceLanguage } as CopilotIntentV2;
  // BUILD-FLOFI-INTELLIGENCE-001 (defense in depth): a model explanation shows only when every number in it is one of FloFi's facts — the user's words,
  // the workflow facts and context FloFi holds, and the numbers FloFi's tools returned this turn. Otherwise FloFi's own answer stands alone.
  if ((intent.kind === 'QUESTION' || intent.kind === 'GOAL') && intent.answer) {
    const facts = [...turn.state.segment, ...turn.state.transcript.filter(entry => entry.role === 'user').map(entry => entry.text), JSON.stringify(env.facts),
      JSON.stringify(contextCard(operationalState(turn.state, env))), (result.groundingNumbers ?? []).slice(0, 256).join(' ')];
    if (!groundedProse(intent.answer, facts).ok) intent = { ...intent, answer: null };
  }
  // BUILD-CHAT-LEARNING-002: the language this conversation is unmistakably written in — the user's words and the interpreter agree (once per
  // conversation; evidence for the identity's starting language only, never a setting, and only where persistent learning is permitted).
  // P0 approved UX: with an interface language the interpreter is told to answer in it, so its language is no independent evidence: nothing is
  // observed then (the screen's language governs, and a heuristic alone never becomes a learned preference).
  const said = !env.interfaceLanguage && env.learning?.automatic === 'ON' && !turn.state.languageObserved ? messageLanguage(turn.state.segment.at(-1) ?? '') : null,
    read = intent.language;
  if (preferred && intent.language !== preferred) intent = { ...intent, language: preferred };
  const resolved = tallied(resolveIntent(intent, { ...turn.state, draft: turn.before.draft, language: intent.language, slots: progressed.slots, ...progressed.progress ? { clarifications: 0 } : {} }, env, null,
    carriedOver(turn.before.draft, intent)), env);
  if (!said || said !== read) return resolved;
  return withAdaptation({ ...resolved, next: { ...resolved.next, languageObserved: true } }, env, { ...NO_ADAPTATION, observations: [{ kind: 'LANGUAGE', language: said }] });
}

/** "Para mim" / "to my wallet", or a saved name, in the user's latest words: a new destination that replaces a carried one. */
function releasesRecipient(state: CopilotConversation, env: CopilotEnvironment, extras: Extras): boolean {
  const latest = state.segment.at(-1) ?? '', recipients = env.recipients ?? [];
  return SELF_RECIPIENT.test(latest) || (recipients.length > 0 && (Boolean(extras.savedRecipient) || matchSavedRecipients(latest, recipients).kind !== 'NONE'));
}
/** The operation(s) an intent is about, to tell a continuation of the open request from a new one. */
const operationsOf = (intent: CopilotIntentV2): string => intent.kind === 'ACTION' ? intent.action.type : intent.kind === 'COMPOSITION' ? intent.actions.map(action => action.type).join('+')
  : intent.kind;
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: what a model answer inherits from FloFi's open question. The step an edit pinned stays pinned only for the same
 * edit or repeat that names no step of its own ("remove step 2" after an edit question of step 1 targets step 2); the saved recipient the user
 * named stays chosen only while the request is the same operation (a new bridge never inherits the send's "Ana"). Other extras behave as before.
 */
function carriedOver(draft: Draft | null, intent: CopilotIntentV2): Extras {
  if (!draft?.extras) return {};
  const { target, savedRecipient, capStep, capFunded, ...rest } = draft.extras;
  const unnamed = (intent.kind === 'EDIT' || intent.kind === 'REPEAT') && intent.target.step === null && intent.target.ordinal === null;
  // BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001 (workflow review): a cap question or answer belongs to the same steps only (never another request's).
  const same = operationsOf(draft.intent) === operationsOf(intent);
  return { ...rest, ...target && unnamed && draft.intent.kind === intent.kind ? { target } : {},
    ...savedRecipient && same ? { savedRecipient } : {}, ...capStep !== undefined && same ? { capStep } : {}, ...capFunded && same ? { capFunded } : {} };
}
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: a model that copied FloFi's masked saved-recipient marker into an address field wrote no address: that field is
 * empty (FloFi resolves the saved name itself). Nothing else is touched; the intent is still validated in full.
 */
function withoutRecipientMarker(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRecipientMarker);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, (key === 'recipient' || key === 'beneficiary') && typeof item === 'string'
    && item.trim().toLowerCase() === SAVED_RECIPIENT_MARKER ? null : withoutRecipientMarker(item)]));
}
/** The intent without the model's own sentences (question, reason, explanation): used when they are not in the person's language. */
function withoutForeignProse(intent: CopilotIntentV2): CopilotIntentV2 {
  if (intent.kind === 'CLARIFICATION_REQUIRED') return { ...intent, question: '' };
  if (intent.kind === 'UNSUPPORTED') return { ...intent, reason: '' };
  if ((intent.kind === 'QUESTION' || intent.kind === 'GOAL') && intent.answer) return { ...intent, answer: null };
  return intent;
}
/**
 * One validated intent → reply and next state. BUILD-FLOFI-UNIFIED-COPILOT-001: an automation stays "the automation this conversation is about"
 * only until another request is resolved, so a later "is 9am ok?" or "preciso assinar?" about a swap is never read as being about it.
 */
function resolveIntent(intent: CopilotIntentV2, state: CopilotConversation, env: CopilotEnvironment, forced: Resolved | null, extras: Extras): Result {
  const result = resolveIntentCore(intent, state, env, forced, extras);
  const about = intent.kind === 'AUTOMATION' || intent.kind === 'AUTOMATION_MANAGE' || (intent.kind === 'QUESTION' && intent.topic === 'AUTOMATIONS');
  return about || !result.next.automation ? result : { ...result, next: { ...result.next, automation: null } };
}
/** One validated intent → reply and next state. `forced` is a step the user picked from Flofi's own buttons. */
function resolveIntentCore(intent: CopilotIntentV2, state: CopilotConversation, env: CopilotEnvironment, forced: Resolved | null, extras: Extras): Result {
  const language = intent.language, m = copilotCopy(language);
  const pinned = forced ?? (intent.kind === 'EDIT' || intent.kind === 'REPEAT' ? extras.target ?? null : null);
  const target = (value: CopilotTarget, purpose: Purpose): Resolution => pinned ? { ok: true, resolved: pinned } : resolveTarget(value, purpose, intent, state, env);
  switch (intent.kind) {
    case 'AUTOMATION': {
      const automation = groundAutomationDraft(intent.draft, segmentText(state), env.timezone ?? 'UTC', Date.now(), language);
      if (automation.kind === 'PROPOSAL') {
        const done = terminal(state, reply('AUTOMATION_PROPOSAL', ASSIST_COPY[language].automationProposal, { automation: automation.input }), COPILOT_TRANSCRIPT.proposed + automation.input.name);
        return { ...done, next: { ...done.next, automation: { input: automation.input, created: false } } };
      }
      if (automation.kind === 'CLARIFICATION') return question(state, m, automation.message, [], { intent, expected: automation.missing, options: [], amountFill: false, snapshot: snapshotOf(env) });
      return refused(state, m, automation.message);
    }

    // BUILD-FLOFI-UNIFIED-COPILOT-001: managing SAVED automations. FloFi reads the owner's own records on the surface that holds the verified owner
    // (the web card, a linked channel); a change is only prepared and needs the owner's explicit confirmation there. The open request stays open.
    case 'AUTOMATION_MANAGE': {
      const value = withDraftReminder(reply('AUTOMATION_MANAGE', ASSIST_COPY[language].manage[intent.operation], { manage: { operation: intent.operation, request: state.segment.at(-1) ?? '' } }),
        state, language);
      const summary = `Flofi opened the user's saved automations (${intent.operation}).`;
      if (state.draft) return { reply: value, next: { ...state, automation: { input: null, created: true }, segment: state.segment.slice(0, -1), transcript: bounded([...state.transcript, { role: 'assistant', text: summary }]) } };
      const done = terminal(state, value, summary);
      return { ...done, next: { ...done.next, automation: { input: null, created: true } } };
    }
    // PR B: a short, contextual reason; the full capability list is only the answer to a CAPABILITIES question.
    case 'UNSUPPORTED': return refused(state, m, publicText(safeCopilotProse(intent.reason)) || m.cannotAuthor);
    case 'GOAL': return resolveGoal(intent, state, env, extras);
    case 'POSITION': return resolvePosition(intent, state, env, extras);
    case 'CLARIFICATION_REQUIRED': {
      const text = publicText(safeCopilotProse(intent.question)) || m.stillNeeds(m.subject.request, intent.missing.filter(field => field !== 'target').map(field => m.field[field as keyof typeof m.field]));
      // BUILD-FLOFI-UX-FIX-003: an option the model wrote that names a test network is never offered in the public product.
      // BUILD-FLOFI-BETA-REGRESSION-FIX-001 (FIX-01): a model-phrased question waiting for exactly the AMOUNT of one open action carries the
      // same structured metadata as the engine's own (`amountFill` + validated grounding evidence), so the UX-02 balance shortcuts are offered
      // consistently on both clarification paths. `awaitingAmount` still enforces every guard: the asset and network must be the person's own
      // stated words (or carried), nothing else missing, no option buttons, and the shortcut only ever writes the amount as the answer.
      const kept = state.draft?.intent ?? intent;
      const expected = intent.missing.map(field => field === 'asset' && state.draft?.expected?.length === 1 ? state.draft.expected[0]! : field);
      const amountFill = kept.kind === 'ACTION' && expected.length === 1 && expected[0] === 'amount' && kept.action.type !== 'LIQUIDITY';
      return question(state, m, text, intent.options.flatMap(option => publicText(safeCopilotProse(option)) ?? []),
        { intent: kept, expected, validated: validatedDraftFields(kept, segmentText(state)), options: [], amountFill, snapshot: snapshotOf(env), ...state.draft?.extras ? { extras: state.draft.extras } : {} });
    }
    case 'QUESTION': {
      let step: WorkflowStep | null = null;
      if (intent.target !== null || intent.topic === 'STEP_DETAIL') {
        const resolution = target(intent.target ?? { step: null, ordinal: null }, 'QUESTION');
        if (!resolution.ok) return resolution.result;
        step = resolution.resolved.step;
      }
      // BUILD-FLOFI-UNIFIED-COPILOT-001: a DeFi concept is explained from FloFi's own catalog (the model only classified it; its prose is not shown,
      // since a concept answer is general knowledge and never "verified data"). The open request stays open and is recalled.
      const latest = state.segment.at(-1) ?? '';
      const concept = intent.topic === 'CONCEPT' || intent.topic === 'OTHER' ? matchConcept(latest) : null;
      if (concept) {
        const explained = conceptReply(env, language, concept, 'STANDARD', null, false), value = withDraftReminder(explained.reply, state, language);
        const summary = ASSIST_COPY[language].explained(conceptName(concept, 'EN'), 'STANDARD');
        if (state.draft) return { reply: value, next: { ...state, concept: explained.concept, segment: state.segment.slice(0, -1), transcript: bounded([...state.transcript, { role: 'assistant', text: summary }]) } };
        return { reply: value, next: { ...closeSegment(state), concept: explained.concept, transcript: bounded([...state.transcript, { role: 'assistant', text: summary }]) } };
      }
      // BUILD-FLOFI-INTELLIGENCE-001: a capability question about a named network is answered from that network's Capability API profile; the model's
      // explanation (grounded by the server in the tool facts it read) is shown apart from FloFi's own answer, labelled as such.
      const faq = intent.topic === 'AUTOMATIONS' ? matchAutomationFaq(latest) : null;
      if (faq) {
        const value = withDraftReminder(reply('ANSWER', automationFaq(faq, language), { topic: 'AUTOMATIONS' }), state, language), summary = `Flofi explained how automations behave (${faq}).`;
        if (state.draft) return { reply: value, next: { ...state, segment: state.segment.slice(0, -1), transcript: bounded([...state.transcript, { role: 'assistant', text: summary }]) } };
        return terminal(state, value, summary);
      }
      const platform = intent.topic === 'PLATFORM' ? matchPlatformTopic(latest) : null;
      if (platform) {
        const value = withDraftReminder(platformReply(platform, language, env), state, language), summary = `Flofi answered how to use FloFi (${platform}).`;
        if (state.draft) return { reply: value, next: { ...state, segment: state.segment.slice(0, -1), transcript: bounded([...state.transcript, { role: 'assistant', text: summary }]) } };
        return terminal(state, value, summary);
      }
      const answer = (intent.topic === 'CAPABILITIES' || intent.topic === 'NETWORKS' ? scopedCapabilities(latest, language) : null)
        ?? (intent.topic === 'CONCEPT' ? conceptMenu(language) : null)
        ?? answerQuestion(intent.topic, step, env.facts, language);
      const prose = intent.answer && intent.topic !== 'CONCEPT' ? publicText(safeCopilotProse(intent.answer)) : null;
      const value = withDraftReminder(reply('ANSWER', answer.text, { notes: [...prose ? [intelligenceCopy(language).explanation(prose)] : [], ...answer.notes],
        options: 'options' in answer ? [...(answer as { options: readonly string[] }).options] : [], topic: intent.topic }), state, language);
      if (state.draft) return { reply: value, next: { ...state, segment: state.segment.slice(0, -1), transcript: bounded([...state.transcript, { role: 'assistant', text: m.answered(intent.topic) }]) } };
      return terminal(state, value, m.answered(intent.topic));
    }
    case 'ACTION': case 'COMPOSITION': {
      // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: "retira metade da minha liquidez" is a removal from the user's liquidity positions, never an Aave Withdraw,
      // whatever the interpreter read; a request that names Aave ("sacar meu USDC da Aave") stays an Aave Withdraw.
      // A withdrawal of a token amount the user wrote ("sacar 10 USDC do pool") is an Aave Withdraw as before: a position removal is a share, never a
      // token amount (flofi-chat review P3).
      if (intent.kind === 'ACTION' && intent.action.type === 'WITHDRAW' && liquidityRemovalNamed(segmentText(state)) && !tokenAmountWithdrawal(intent.action, segmentText(state)))
        return resolvePosition(positionIntentOf(intent, segmentText(state)), state, env, extras);
      let actions = intent.kind === 'ACTION' ? [intent.action] : intent.actions;
      // Mainnet combinations share the canonical sequence runtime. Historical engineering compositions keep their atomic runtime.
      // BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001: in the public (mainnet-only) product a request that names no network yet ("troque 1 USDC por ETH e
      // depois troque o ETH recebido por USDC") is a sequence too: its steps ask for the network instead of falling into the legacy test-network
      // lending composition, which refused it as unsupported.
      if (intent.kind === 'COMPOSITION' && actions.length > 1 && actions.some(action => {
        const network = action.type === 'BRIDGE' ? action.sourceNetwork : action.network;
        return network && network !== 'OTHER' && networkOfCopilot(network).environment === 'MAINNET';
      } ) || intent.kind === 'COMPOSITION' && actions.length > 1 && activeNetworkScope() === 'PUBLIC_MAINNET' && actions.every(action =>
        (action.type === 'BRIDGE' ? action.sourceNetwork : action.network) === null))
        return authorSequence(intent, null, actions, state, env, [], extras);
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
        // Reconciled leftovers are Solana Devnet facts (engineering certification only): the public product never authors a Devnet position from them.
        const remaining = activeNetworkScope() === 'ENGINEERING' ? env.verified?.remaining ?? [] : [];
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
      const authored = author(intent, actions, intent.kind === 'COMPOSITION', carried, state, env, notes, sentence => m.interpreted(sentence), m.subject.composition, null, swap, extras);
      // BUILD-CHAT-LEARNING-002: "no, I meant a bridge" restated as a new action while FloFi's proposal is open: the operation FloFi chose may be corrected.
      const open = env.pending && state.referents[0]?.command === env.pending.command ? state.referents[0] : undefined;
      return intent.kind === 'ACTION' ? correctedBy(authored, open, state, env, true) : authored;
    }
    case 'EDIT': case 'REPEAT': {
      if (intent.kind === 'REPEAT' && !REPEAT_CUE.test(segmentText(state))) return refused(state, m, m.repeatNeedsCue);
      const resolution = target(intent.target, intent.kind === 'EDIT' ? 'EDIT' : 'REPEAT');
      if (!resolution.ok) return resolution.result;
      const resolved = resolution.resolved, label = resolved.source === 'PENDING' ? m.sourcePending : stepLabel(m, resolved.step, language);
      const base = stepAction(resolved.step);
      if (!base) return refused(state, m, m.refusal.STEP_NOT_EDITABLE(label));
      const changed = applyChanges(base, intent.changes);
      if (!changed.ok) return refused(state, m, changed.field === 'deposit' ? m.compositionSwapAmount
        : m.changeNotApplicable(m.carriedLabel[CARRIED_LABEL[changed.field] ?? (changed.field === 'deposits' ? 'maxima' : 'range')], label));
      // BUILD-FLOFI-UNIFIED-COPILOT-001: "para mim" or a saved name in the latest words is a new destination, never the carried one (and the
      // carried note does not claim it).
      const applied = changed.carried.has('recipient') && releasesRecipient(state, env, extras) ? { ...changed,
        carried: new Set([...changed.carried].filter(field => field !== 'recipient')),
        base: { ...changed.base, actions: changed.base.actions.map(action => (action.type === 'TRANSFER' || action.type === 'BRIDGE') && action.recipient
          ? { ...action, recipient: null } as CopilotAction : action) } } : changed;
      // BUILD-FLOFI-INTELLIGENCE-001: a restated settled value ("keep the same source") stays carried, so it is never asked again; what changed is a correction.
      if (intent.kind === 'EDIT') state = { ...state, ledger: correctedLedger(state.ledger, applied.changed) };
      const notes = applied.carried.size ? [m.carried(sourceLabel(m, resolved, language), carriedLabels(m, applied.carried))] : [];
      if (intent.kind === 'REPEAT') return author(intent, applied.base.actions, applied.base.composition, applied.carried, state, env, notes, sentence => m.interpreted(sentence), label,
        null, null, { ...extras, target: resolved });
      const revising = resolved.source === 'PENDING' && (resolved.command.type.startsWith('ADD_') || resolved.command.type === 'AUTHOR_LENDING');
      const edited = author(intent, applied.base.actions, applied.base.composition, applied.carried, state, env, notes,
        sentence => revising ? m.interpretedRevision(sentence) : m.interpretedEdit(label, sentence), label, revising ? null : resolved.step.nodeId, null, { ...extras, target: resolved });
      // BUILD-CHAT-LEARNING-002: a change of a proposal FloFi showed (pending, or applied and unchanged since) may correct how FloFi read it.
      const referent = resolved.source === 'PENDING' ? state.referents.find(item => item.command === resolved.command)
        : resolved.source === 'NODE' ? state.referents.find(item => item.applied && item.watched && item.step.nodeId === resolved.step.nodeId) : undefined;
      const corrected = correctedBy(edited, referent, state, env, false);
      // BUILD-CHAT-LEARNING-001: the user revised the proposal FloFi had just shown — a correction signal (observed, never ground truth).
      return revising ? withLearning(corrected, env, ['CORRECTION']) : corrected;
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

// ── BUILD-FLOFI-INTELLIGENCE-001: capability discovery and goal-to-workflow planning ─────────────────────────────────────────────
/** "What can I do on Arbitrum?": each named network's Capability API profile in this scope (test networks are named as such); null when none named. */
function scopedCapabilities(latest: string, language: CopilotLanguage): { readonly text: string; readonly notes: readonly string[] } | null {
  const named = copilotNetworksMentioned(latest);
  if (!named.length) return null;
  const c = intelligenceCopy(language), scope = activeNetworkScope();
  const lines = named.map(id => {
    const network = networkOfCopilot(id), profile = networkCapabilityProfile(scope, network.key);
    return profile ? c.capabilitiesOf(profile) : network.environment === 'TESTNET' ? c.capabilitiesTestNetwork(network.name) : c.capabilitiesUnknown(network.name);
  });
  return { text: lines.join(' '), notes: [c.capabilityScopeNote, language === 'PT' ? 'Somente leitura: nada foi proposto, alterado, assinado ou executado.'
    : 'Read only: nothing was proposed, changed, signed or executed.'] };
}
const COPILOT_ID_OF_KEY = (key: string): CopilotNetwork => (networkIdentity(key)?.copilot ?? 'OTHER') as CopilotNetwork;
const keyOfCopilot = (id: CopilotNetwork | null): string | null => id && id !== 'OTHER' ? networkOfCopilot(id).key : id === 'OTHER' ? 'unknown-network' : null;
const named = (text: string, value: string) => new RegExp(`(?<![\\p{L}\\p{N}.])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(text);
/**
 * A goal keeps only what the user's own words in the open request state (FloFi asks for the rest): a network they named, an asset they wrote, an amount
 * or cap they typed. The model's reading never adds a value.
 */
function groundedGoal(goal: CopilotGoal, text: string, carried: ReadonlySet<string>): CopilotGoal {
  const networks = copilotNetworksMentioned(text);
  const network = (value: CopilotNetwork | null, field: string) => value === null ? null : value === 'OTHER' || networks.includes(value as CopilotNetworkId) || carried.has(field) ? value : null;
  const asset = (value: string | null, field: string) => value !== null && (named(text, value) || carried.has(field)) ? value : null;
  const amount = (value: string | null, field: string) => value !== null && (groundedAmount(text, value) || carried.has(field)) ? value : null;
  const recipient = goal.recipient && groundedAddress(text, goal.recipient) ? goal.recipient : null;
  return { source: { network: network(goal.source.network, 'sourceNetwork'), asset: asset(goal.source.asset, 'sourceAsset'), amount: amount(goal.source.amount, 'amount') },
    target: { network: network(goal.target.network, 'targetNetwork'), asset: asset(goal.target.asset, 'targetAsset'), use: goal.target.use }, preference: goal.preference,
    cap: amount(goal.cap, 'cap'), recipient,
    liquidity: goal.liquidity ? { ...goal.liquidity, network: null,
      deposits: goal.liquidity.deposits.filter(deposit => named(text, deposit.asset) && groundedAmount(text, deposit.maxAmount)),
      lower: goal.liquidity.rangeUnit === 'TICK' && goal.liquidity.lower !== null ? groundedSigned(text, goal.liquidity.lower) ? goal.liquidity.lower : null : amount(goal.liquidity.lower, 'lower'),
      upper: goal.liquidity.rangeUnit === 'TICK' && goal.liquidity.upper !== null ? groundedSigned(text, goal.liquidity.upper) ? goal.liquidity.upper : null : amount(goal.liquidity.upper, 'upper') } : null };
}
const plannerGoal = (goal: CopilotGoal): Goal => ({ source: { network: keyOfCopilot(goal.source.network), asset: goal.source.asset, amount: goal.source.amount },
  target: { network: keyOfCopilot(goal.target.network), asset: goal.target.asset, use: goal.target.use }, preference: goal.preference, cap: goal.cap, liquidity: goal.liquidity ?? null });
/**
 * A plan step as the V1 action the existing planners author (and ground) exactly like a typed request. The user's typed address belongs to the final
 * step only (a supply's beneficiary, a holding bridge's recipient): an earlier step always delivers to the owner, so the next step can spend it.
 */
function stepCopilotAction(step: GoalStep, recipient: string | null): CopilotAction {
  switch (step.action) {
    case 'swap': return { type: 'SWAP', network: COPILOT_ID_OF_KEY(step.network), inputAsset: step.inputAsset, outputAsset: step.outputAsset, amount: step.amount, slippageBps: null };
    case 'bridge': return { type: 'BRIDGE', sourceNetwork: COPILOT_ID_OF_KEY(step.network), destinationNetwork: COPILOT_ID_OF_KEY(step.destinationNetwork!), asset: step.inputAsset,
      outputAsset: step.outputAsset, amount: step.amount, slippageBps: null, routing: step.routing, recipient };
    case 'supply': return { type: 'SUPPLY', protocol: 'AAVE_V3', network: COPILOT_ID_OF_KEY(step.network), asset: step.inputAsset, amount: step.amount, beneficiary: recipient };
    case 'add_liquidity': return { ...step.liquidity!, type: 'LIQUIDITY', network: COPILOT_ID_OF_KEY(step.network), funding: null };
  }
}
const GOAL_DRAFT_FIELD: Readonly<Record<GoalField, DraftField>> = { sourceAsset: 'inputAsset', sourceNetwork: 'sourceNetwork', amount: 'amount', targetNetwork: 'destinationNetwork',
  targetAsset: 'outputAsset', cap: 'amount', deposits: 'deposits', range: 'range' };
/** Option buttons of a goal question: each one sets that goal field (a network by its registry label, an asset by symbol). */
function goalFills(field: GoalField, options: readonly string[]): Draft['options'] {
  return options.flatMap(label => {
    const network = NETWORK_BY_LABEL.get(normalize(label));
    if (field === 'sourceNetwork' || field === 'targetNetwork') return network ? [{ label, fill: { kind: 'ACTION' as const, patch: { [field]: network } } }] : [];
    if (field === 'sourceAsset' || field === 'targetAsset') return /^[A-Za-z][A-Za-z0-9.]{0,15}$/.test(label) ? [{ label, fill: { kind: 'ACTION' as const, patch: { [field]: label } } }] : [];
    return [];
  });
}
/** A patch of goal fields (option buttons, a bare amount): the only way FloFi's own question fills a goal. */
function patchGoal(intent: Extract<CopilotIntentV2, { kind: 'GOAL' }>, patch: Readonly<Record<string, unknown>>, expected: readonly string[]): CopilotIntentV2 {
  const g = intent.goal, value = (key: string) => typeof patch[key] === 'string' ? patch[key] as string : undefined;
  const amount = value('amount'), cap = expected.includes('cap') ? amount : undefined, sourceAmount = cap === undefined ? amount : undefined;
  return { ...intent, goal: { ...g, source: { network: (value('sourceNetwork') as CopilotNetwork | undefined) ?? g.source.network, asset: value('sourceAsset') ?? g.source.asset,
    amount: sourceAmount ?? g.source.amount }, target: { ...g.target, network: (value('targetNetwork') as CopilotNetwork | undefined) ?? g.target.network,
    asset: value('targetAsset') ?? g.target.asset }, cap: cap ?? g.cap } };
}
function goalNotes(plan: Extract<GoalPlan, { kind: 'PLAN' }>, language: CopilotLanguage): string[] {
  const c = intelligenceCopy(language);
  return [...plan.reasons.map(reason => c.goalReasons[reason]), ...plan.alternatives.map(alternative => c.goalAlternatives[alternative.code])];
}
/** A goal → FloFi's plan → the proposal (one step, or the ordered sequence), or FloFi's one question, or why the registries cannot reach it. */
function resolveGoal(intent: Extract<CopilotIntentV2, { kind: 'GOAL' }>, state: CopilotConversation, env: CopilotEnvironment, extras: Extras): Result {
  const language = intent.language, m = copilotCopy(language), c = intelligenceCopy(language), text = segmentText(state);
  const carried = new Set<string>((extras.carried ?? []).map(String));
  const goal = groundedGoal(intent.goal, text, carried), grounded: Extract<CopilotIntentV2, { kind: 'GOAL' }> = { ...intent, goal };
  // BUILD AAVE-V3-EXPANSION-001: a reserve to supply that the model named but the user's words do not ground (for example a full token name)
  // is asked for — never replaced by the asset the user already holds.
  const droppedTarget = goal.target.use === 'SUPPLY' && intent.goal.target.asset !== null && goal.target.asset === null;
  const plan: GoalPlan = droppedTarget ? { kind: 'NEEDS', field: 'targetAsset', options: [...new Set(lendingOffers()
    .filter(offer => goal.target.network === null || offer.network.copilot === goal.target.network).map(offer => offer.asset))].slice(0, COPILOT_LIMITS.maxOptions) }
    : planGoal(plannerGoal(goal), activeNetworkScope());
  const prose = intent.answer ? publicText(safeCopilotProse(intent.answer)) : null, explained = prose ? [c.explanation(prose)] : [];
  switch (plan.kind) {
    case 'NEEDS': {
      const expected = [plan.field === 'cap' ? 'cap' : GOAL_DRAFT_FIELD[plan.field]] as DraftField[];
      const question_ = plan.field === 'cap' ? c.goalCap(plan.step ?? 1, plan.asset ?? '') : c.goalNeeds[plan.field];
      return question(state, m, question_, plan.options.slice(0, COPILOT_LIMITS.maxOptions), { intent: grounded, expected, options: goalFills(plan.field, plan.options),
        amountFill: plan.field === 'amount' || plan.field === 'cap', snapshot: snapshotOf(env), extras }, explained);
    }
    case 'UNSUPPORTED': {
      const options = plan.options.length ? [c.goalOptionsNote(plan.options)] : [];
      return refused(state, m, [c.goalGaps[plan.code](plan.network), ...options, ...plan.alternatives.map(item => c.goalAlternatives[item.code])].join(' '));
    }
    case 'NOTHING_TO_DO': return terminal(state, reply('ANSWER', c.goalNothing(plan.network, plan.asset), { notes: explained }), m.answered('PROPOSAL'));
    case 'LIQUIDITY': {
      const liquidity: CopilotAction = { type: 'LIQUIDITY', protocol: null, network: COPILOT_ID_OF_KEY(plan.network), deposits: [], rangeUnit: null, lower: null, upper: null, slippageBps: null, feeTier: null };
      return author({ version: '2', language, kind: 'ACTION', action: liquidity, reuse: null }, [liquidity], false, new Set(['network']), state, env, explained, sentence => m.interpreted(sentence), m.subject.request);
    }
    case 'PLAN': {
      const actions = plan.steps.map((step, index) => stepCopilotAction(step, index === plan.steps.length - 1 ? goal.recipient ?? null : null));
      const notes = [...explained, ...goalNotes(plan, language)];
      if (actions.length === 1) return author({ version: '2', language, kind: 'ACTION', action: actions[0]!, reuse: null }, actions, false, new Set(), state, env, notes,
        sentence => `${c.goalIntro(1)} ${m.interpreted(sentence)}`, m.subject.request, null, null, { ...extras, planned: true });
      return authorSequence(grounded, plan, actions, state, env, notes, extras);
    }
  }
}
/**
 * Several plan steps → one `ADD_SEQUENCE` proposal: each step planned and grounded exactly like a typed request at the revision the steps before it
 * produce, then the whole workflow must be FloFi's reviewed sequence with the funding the plan expects (a later step spends the earlier step's output).
 */
/** The relative amount of the newest user turn of the open request that states one about `asset` (chat review M2), or null. */
function newestRelative(state: CopilotConversation, asset: string | null): RelativeAmount | null {
  // Answered turns are kept joined by line breaks in one segment entry: each line is one user turn.
  for (const turn of state.segment.flatMap(entry => entry.split('\n')).reverse()) { const found = relativeAmountIn(turn, asset); if (found) return found; }
  return null;
}
/** The asset a new step spends as the user (or the model) wrote it, and the network it spends on. */
const inputAssetOf = (action: CopilotAction): string | null => action.type === 'SWAP' ? action.inputAsset : action.type === 'LIQUIDITY' ? null : action.asset;
const inputNetworkOf = (action: CopilotAction): CopilotNetwork | null => action.type === 'BRIDGE' ? action.sourceNetwork : action.network;
/** One token identity for comparing written references: case-insensitive and "Solana" is SOL. ETH and WETH stay distinct (FIX-04; a swap delivers native ETH). */
const sameWrittenAsset = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const key = (value: string) => { const upper = value.toUpperCase(); return upper === 'SOLANA' ? 'SOL' : upper; };
  return Boolean(a && b && a !== 'OTHER' && b !== 'OTHER' && key(a) === key(b));
};
/**
 * BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001 (beta incidents "Levar 1 USDC da Ethereum para a Base e emprestar na Aave", "Troque 1 USDC por ETH e
 * depois troque o ETH recebido por USDC"): a later step of one request that names no amount and spends exactly what the step before it delivers
 * (that step's output token, on its destination network) is funded by that step — the same rule the goal planner applies. The sequence runtime
 * then binds it to what the earlier step actually delivered (reconciled, never an estimate), up to its cap:
 *  - SAME_ASSET: a bridge that delivers the token it sends; the cap is the user's own amount (a bridge delivers at most what it sends).
 *  - OTHER_ASSET: a conversion; the delivered amount is only known after settlement, so the user states the cap (FloFi never guesses it).
 * A step without a network takes the earlier step's delivery network. Nothing else is filled; every value is still validated as usual.
 */
type StepDelivery = { asset: string | null; network: CopilotNetwork | null; same: boolean; amount: string | null };
function bridgeDelivery(command: Command | undefined): StepDelivery | null {
  if (command?.type !== 'ADD_ROUTER_BRIDGE' && command?.type !== 'ADD_UNIVERSAL_BRIDGE') return null;
  // The validated command includes the route's destination asset, including a default such as Robinhood USDG, and its actual recipient.
  if (command.input.recipient !== '') return null;
  if (command.type === 'ADD_ROUTER_BRIDGE') {
    const route = routerNetworkOfInput(command.input);
    if (!route) return null;
    const { source, destination } = ROUTER_NETWORK_OPTIONS[route].pair;
    return { asset: destination.symbol, network: networkIdentity(destination.chainId)?.copilot ?? null,
      same: sameWrittenAsset(source.symbol, destination.symbol), amount: command.input.amount };
  }
  const { source, destination, inputAsset, outputAsset, amount } = command.input;
  const from = resolveUniversalAsset(source, inputAsset).symbol;
  return { asset: outputAsset, network: networkIdentity(UNIVERSAL_NETWORKS[destination].chain)?.copilot ?? null,
    same: from !== 'TOKEN' && !inputAsset.includes('@') && sameWrittenAsset(from, outputAsset), amount };
}
function bindDependentStep(action: CopilotAction, producer: CopilotAction | undefined, previous: Command | undefined, answeredCap: boolean) {
  if (!producer || action.type === 'LIQUIDITY' || action.amount !== null && !answeredCap) return null;
  const delivered = producer.type === 'SWAP' ? { asset: producer.outputAsset, network: producer.network, same: false, amount: producer.amount } : bridgeDelivery(previous);
  if (!delivered || !sameWrittenAsset(inputAssetOf(action), delivered.asset)) return null;
  const network = inputNetworkOf(action);
  if (network !== null && delivered.network !== null && network !== delivered.network) return null;
  const inherited = network === null ? delivered.network : null;
  const next = inherited ? action.type === 'BRIDGE' ? { ...action, sourceNetwork: inherited } : { ...action, network: inherited } : action;
  const cap = action.amount === null && delivered.same ? delivered.amount : null;
  return { action: cap !== null ? { ...next, amount: cap } : next, inherited, copiedCap: cap !== null };
}
/** BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: the Batch Payment several planned sends make, a duplicate recipient (never merged), or null. */
function batchPaymentOf(steps: readonly Command[], baseRevision: number): { readonly command: Command } | { readonly duplicate: string } | null {
  if (steps.length < BATCH_PAYMENT_MIN_RECIPIENTS || steps.length > BATCH_PAYMENT_MAX_RECIPIENTS) return null;
  const sends = steps.map(step => step.type === 'ADD_RH_TRANSFER' ? step.input : null);
  if (sends.some(send => send === null)) return null;
  const [first] = sends as RobinhoodTransferInput[];
  if (!first || !(BATCH_PAYMENT_NETWORKS as readonly string[]).includes(first.network)) return null;
  if ((sends as RobinhoodTransferInput[]).some(send => send.network !== first.network || send.asset !== first.asset || send.recipient === 'CONNECTED_OWNER'
    || send.decimals !== undefined || send.program !== undefined)) return null;
  const seen = new Set<string>();
  for (const send of sends as RobinhoodTransferInput[]) {
    const key = send.recipient.toLowerCase();
    if (seen.has(key)) return { duplicate: send.recipient };
    seen.add(key);
  }
  return { command: { type: 'ADD_BATCH_PAYMENT', source: 'CHAT', baseRevision, input: { network: first.network as BatchPaymentInput['network'], asset: first.asset,
    payments: (sends as RobinhoodTransferInput[]).map(send => ({ recipient: send.recipient, amount: send.amount })) } } as Command };
}
const BATCH_PAYMENT_COPY = {
  EN: { sentence: (n: number, asset: string, network: string) => `batch payment of ${asset} to ${n} recipients on ${network}`,
    intro: (n: number, network: string) => `One Batch Payment on ${network} to ${n} recipients:`,
    atomic: 'It runs only as one atomic authorization of your wallet: every payment settles, or none does. Review every recipient before you authorize.',
    duplicate: (address: string) => `${address} appears more than once. A Batch Payment pays each recipient once and FloFi never merges or drops a payment: say the one amount for that recipient.` },
  PT: { sentence: (n: number, asset: string, network: string) => `pagamento em lote de ${asset} para ${n} destinatários na ${network}`,
    intro: (n: number, network: string) => `Um Pagamento em lote na ${network} para ${n} destinatários:`,
    atomic: 'Ele só executa como uma autorização atômica da sua carteira: todos os pagamentos são liquidados, ou nenhum. Revise cada destinatário antes de autorizar.',
    duplicate: (address: string) => `${address} aparece mais de uma vez. Um Pagamento em lote paga cada destinatário uma vez e a FloFi nunca junta nem descarta um pagamento: diga o valor único desse destinatário.` },
} as const;
function authorSequence(intent: CopilotIntentV2, plan: Extract<GoalPlan, { kind: 'PLAN' }> | null, sequenceActions: readonly CopilotAction[], state: CopilotConversation,
  env: CopilotEnvironment, notesIn: readonly string[], extras: Extras = {}): Result {
  const language = intent.language, m = copilotCopy(language), c = intelligenceCopy(language);
  // BUILD-FLOFI-UNIFIED-COPILOT-001: a saved recipient named for a plan fills its send or bridge destination exactly as for a single step (or asks,
  // or refuses a wrong ecosystem); it never silently falls back to the owner's wallet. Saved names never ground a network or token.
  const recipients = env.recipients ?? [], masked = (text: string) => recipients.length ? maskSavedRecipients(text, recipients) : text;
  const saved = savedRecipientFor(sequenceActions, state, env, language, intent, extras, segmentText(state), new Set(), masked(segmentText(state)));
  if ('result' in saved) return saved.result;
  const actions = saved.actions, notes = [...notesIn, ...saved.notes];
  const final = [...actions].reverse().find(action => action.type === 'TRANSFER' || action.type === 'BRIDGE');
  if (saved.id && final && final.recipient === null)
    return refused(state, m, ASSIST_COPY[language].recipientNotUsed(recipients.find(recipient => recipient.id === saved.id)?.label ?? ''));
  const grounding: Grounding = { text: masked(segmentText(state)), carried: new Set(), policy: { language, networkDefaults: false, catalog: true, ...env.agentRollout ? { agentRollout: env.agentRollout } : {} },
    latest: masked(state.segment.at(-1) ?? ''), solana: { price: env.verified?.orcaPrice?.price ?? null, swap: null }, explicitAssets: false,
    ...saved.addresses.length ? { saved: saved.addresses } : {},
    // BUILD-P1: a liquidity step of a sequence reads its pool exactly as a single position does.
    ...env.verified?.pools?.length ? { pools: env.verified.pools } : {}, ...env.poolReads ? { poolReads: true } : {}, now: env.now ?? Date.now() };
  let workflow = env.workflow;
  const steps: Command[] = [], sentences: string[] = [], stepNotes: string[] = [];
  // BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001: a step the user described as spending what the earlier step of the same request delivers.
  const bound = new Map<number, boolean>();
  for (const [index, requested] of actions.entries()) {
    const answeredCap = !plan && (extras.capFunded?.includes(index) ?? false);
    const binding = plan ? null : bindDependentStep(requested, actions[index - 1], steps.at(-1), answeredCap);
    if (answeredCap && !binding) return refused(state, m, c.dependentUnfunded(index + 1, index));
    const action = binding?.action ?? requested;
    if (binding) bound.set(index, binding.copiedCap);
    // A funded step's cap is the user's own amount (or the cap they stated): FloFi's provenance, grounded in the same words.
    const carried: CarriedField[] = plan && plan.steps[index]!.fundedBy !== null || binding?.copiedCap ? ['amount'] : [];
    if (binding?.inherited) carried.push(action.type === 'BRIDGE' ? 'sourceNetwork' : 'network');
    const planned = planCopilotActions([action], false, { ...grounding, carried: new Set(carried) }, env.wallet);
    if (planned.kind === 'CLARIFICATION' && binding && !binding.copiedCap && planned.missing.includes('amount')) {
      // The delivered amount is only known after the earlier step settles: the user states the most this step may spend (never guessed).
      const asset = inputAssetOf(action) ?? '';
      return question(state, m, c.dependentCap(index + 1, index, displayAsset(asset)), [], { intent, expected: ['amount'], validated: validatedDraftFields(intent, segmentText(state)),
        options: [], amountFill: true, snapshot: snapshotOf(env), extras: { ...extras, capStep: index } });
    }
    if (planned.kind !== 'PLAN') return stopped(planned, intent, state, env, m);
    const outcome = proposalFromPlan(planned.plan, { workflow, context: env.context, wallet: env.wallet }, language);
    if (outcome.kind !== 'PROPOSAL') return stopped(outcome, intent, state, env, m);
    if (!SEQUENCE_STEP_COMMANDS.includes(outcome.command.type)) return refused(state, m, m.compositionUnsupported);
    const next = editorReducer({ workflow, error: null }, outcome.command, env.context);
    if (next.error) return failed(state, m, copilotRejection(next.error.split(':')[0]!.trim(), language).message);
    steps.push(outcome.command); sentences.push(outcome.sentence); stepNotes.push(...outcome.notes); workflow = next.workflow;
  }
  // BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: several sends of one asset on one EVM mainnet, each to its own explicit recipient, are ONE Batch
  // Payment (every recipient and amount exactly as planned and grounded above, in the person's order), never separate transfer cards.
  const batch = !plan && !bound.size ? batchPaymentOf(steps, env.workflow.revision) : null;
  if (batch && 'duplicate' in batch) return refused(state, m, BATCH_PAYMENT_COPY[language].duplicate(batch.duplicate));
  if (batch) {
    const next = editorReducer({ workflow: env.workflow, error: null }, batch.command, env.context);
    if (next.error) return failed(state, m, copilotRejection(next.error.split(':')[0]!.trim(), language).message);
    const input = (batch.command as Extract<Command, { type: 'ADD_BATCH_PAYMENT' }>).input;
    const lines = input.payments.map((p, index) => `${index + 1}. ${p.amount} ${input.asset} → ${p.recipient}`);
    return propose(state, env, batch.command, BATCH_PAYMENT_COPY[language].sentence(input.payments.length, input.asset, input.network),
      [BATCH_PAYMENT_COPY[language].intro(input.payments.length, input.network), ...lines, BATCH_PAYMENT_COPY[language].atomic].join(' '), [...notes, ...stepNotes], m.subject.request);
  }
  const command = { type: 'ADD_SEQUENCE', steps, source: 'CHAT', baseRevision: env.workflow.revision } as Command;
  // The existing sequence runtime must take every step on its own, funded exactly as planned; otherwise this is not executable and FloFi says so.
  const sequence = workflowSequence(workflow, candidate => lintWorkflow(candidate, env.context));
  const added = sequence?.steps.slice(-steps.length) ?? [];
  const offset = (sequence?.steps.length ?? 0) - steps.length;
  if (!sequence || added.length !== steps.length || plan?.steps.some((step, index) => step.fundedBy !== null && added[index]!.fundedBy !== step.fundedBy + offset)) {
    return refused(state, m, m.compositionUnsupported);
  }
  // BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001 (chat review H1): a step FloFi read as spending the earlier step's delivery must be funded by it in the
  // runtime too (same chain, token and decimals, delivered to the owner). Otherwise it would spend the wallet's own balance while the notes said
  // the opposite (a bridge to another recipient, ETH vs WETH, another destination token): FloFi says so and asks for an explicit amount instead.
  for (const index of bound.keys()) {
    if (added[index]?.fundedBy !== offset + index - 1) return refused(state, m, c.dependentUnfunded(index + 1, index));
  }
  // BUILD AAVE-V3-EXPANSION-001: a step funded by a conversion of another asset whose cap repeats the earlier step's number ("swap 100 USDC to WETH
  // then supply it", read as 100 WETH) is a copied number, not the user's cap: FloFi says so instead of proposing it.
  for (const [index, step] of added.entries()) {
    const producer = step.fundedBy === null ? null : sequence.steps[step.fundedBy];
    if (!plan && !bound.get(index) && !extras.capFunded?.includes(index) && producer?.input && step.input && producer.input.address !== step.input.address &&
        formatAssetAmount(step.input.amount, step.input.decimals) === formatAssetAmount(producer.input.amount, producer.input.decimals)) {
      const label = (asset: { chainId: string; address: string | null }) => resolveNetworkAsset(asset.chainId, asset.address ? { address: asset.address } : { symbol: 'ETH' })?.symbol
        ?? lendingProfileOfReserve(asset.chainId, asset.address)?.symbol ?? '';
      return refused(state, m, c.capCopied(offset + index + 1, formatAssetAmount(step.input.amount, step.input.decimals), label(step.input), label(producer.input)));
    }
  }
  if (bound.size) notes.push(c.goalReasons.FUNDED_BY_PREVIOUS_STEP, ...[...bound.values()].some(Boolean) ? [c.goalReasons.CAP_IS_YOUR_AMOUNT] : []);
  const listed = sentences.map((sentence, index) => c.goalStep(index + 1, sentence));
  return propose(state, env, command, sentences.join(' then '), [c.goalIntro(steps.length), ...listed, c.sequenceInterpreted].join(' '), [...notes, ...stepNotes], m.subject.request);
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
// ── BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the owner's verified liquidity positions ────────────────────────────────────────────────────────────
type PositionIntent = Extract<CopilotIntentV2, { kind: 'POSITION' }>;
/** FloFi's own questions about a position: a short answer under them is read locally (`positionTurn`), never by the model. */
const POSITION_WHICH = 'COPILOT_POSITION_WHICH', POSITION_PORTION = 'COPILOT_POSITION_PORTION';
/** The user's entry for a position button FloFi listed: no digit, percentage, network, protocol or ordinal the request could be grounded in. */
const POSITION_OPTION_CHOSEN = '[chose one of the positions FloFi listed]';
/**
 * "Show my pools", "collect my fees on Base", "remove 50% of my liquidity", "close my Orca position": one per-position workflow action the owner
 * asks for, prepared for Review (FloFi never chooses, rebalances or acts on a position by itself). The connected wallets' verified positions
 * decide; engineering certification keeps its Solana Devnet path for FloFi-registered Devnet positions (a request naming Solana Devnet, or a
 * surface that read only Devnet facts). A chat channel has no verified wallet: it is refused there with the way to do it.
 */
function resolvePosition(intent: PositionIntent, state: CopilotConversation, env: CopilotEnvironment, extras: Extras): Result {
  const m = copilotCopy(intent.language);
  if ((env.surface ?? 'WEB') !== 'WEB') return refused(state, m, m.lifecycle.channel);
  const devnet = intent.network === 'SOLANA_DEVNET' || !env.verified?.liquidity;
  if (activeNetworkScope() === 'ENGINEERING' && devnet && (intent.operation === 'DECREASE' || intent.operation === 'EXIT' || intent.operation === 'CLOSE'))
    return resolveDevnetPosition({ ...intent, operation: intent.operation === 'DECREASE' ? 'DECREASE' : 'EXIT' }, state, env, extras);
  return resolveLiquidityPosition(intent, state, env, extras);
}
/** An Aave Withdraw whose asset and amount are the user's own words, with no percentage: never a liquidity-position removal. */
function tokenAmountWithdrawal(action: CopilotAction, text: string): boolean {
  return action.type === 'WITHDRAW' && action.asset !== null && action.amount !== null && assetNamed(text, action.asset) && groundedAmount(text, action.amount)
    && statedPercent(text) === null;
}
/** An Aave Withdraw the interpreter read from words about the user's liquidity ("retira metade da minha liquidez"): that request as a position request. */
function positionIntentOf(intent: Extract<CopilotIntentV2, { kind: 'ACTION' }>, text: string): PositionIntent {
  const network = 'network' in intent.action ? intent.action.network : null;
  const all = /(?<![\p{L}])(?:all|everything|tudo|toda|inteira|completamente|totalmente)(?![\p{L}])/iu.test(text);
  return { version: '2', language: intent.language, kind: 'POSITION', operation: all ? 'EXIT' : 'DECREASE', protocol: null, network,
    percent: all ? null : statedPercent(text) ?? (halfNamed(text) ? '50' : null) };
}
/** The filters a request may narrow positions by — only those in the user's own words (a model's protocol, network, pair or ordinal is a hint). */
function positionFilters(intent: PositionIntent, text: string) {
  const protocol = intent.protocol === 'UNISWAP_V3' && /uniswap/i.test(text) ? 'UNISWAP_V3' as const : intent.protocol === 'ORCA' && /(?<![A-Za-z])orca(?![A-Za-z])/i.test(text) ? 'ORCA' as const : null;
  const network = intent.network !== null && intent.network !== 'OTHER' && copilotNetworksMentioned(text).includes(intent.network) ? networkOfCopilot(intent.network) : null;
  const assets = (intent.select?.assets ?? []).filter(asset => assetNamed(text, asset));
  const ordinal = intent.select?.ordinal && ordinalNamed(text, intent.select.ordinal) ? intent.select.ordinal : null;
  return { protocol, chain: network?.chain ?? null, networkName: network?.name ?? null, assets, ordinal };
}
/** A read answer about positions: it ends the request, or (under FloFi's open question) leaves that question open and recalls it. */
function positionAnswer(state: CopilotConversation, language: CopilotLanguage, value: CopilotReply): Result {
  const summary = 'Flofi answered from the user\'s verified liquidity positions.';
  if (state.draft) return { reply: withDraftReminder(value, state, language), next: { ...state, segment: state.segment.slice(0, -1),
    transcript: bounded([...state.transcript, { role: 'assistant', text: summary }]) } };
  return terminal(state, value, summary);
}
/** Why FloFi cannot prepare `operation` for a position (its manageability first, then what the position holds). */
const positionRefusal = (view: LiquidityPositionView, operation: LiquidityPositionOperation): PositionRefusal => !view.manageable.ok ? view.manageable.reason
  : operation === 'COLLECT' ? 'NOTHING_TO_COLLECT' : operation === 'DECREASE' && view.status === 'EMPTY' ? 'NO_LIQUIDITY' : 'OPERATION_UNAVAILABLE';
/** The canonical (English) sentence of a prepared position operation: identity, pair and network only (FloFi's verified values). */
function positionSentence(view: LiquidityPositionView, operation: LiquidityPositionOperation, partBps: number | null, close: boolean): string {
  const what = `${protocolName(view.ref.protocol)} position ${shortPositionId(view.ref)} ${pairName(view)} on ${view.ref.network}`;
  return operation === 'COLLECT' ? `collect the fees and owed tokens of ${what}` : operation === 'DECREASE' ? `remove ${partBps! / 100}% of the liquidity of ${what}`
    : `remove all liquidity from ${what}${close ? view.ref.protocol === 'ORCA' ? ' and close it' : ' and burn its NFT' : ''}`;
}
function resolveLiquidityPosition(intent: PositionIntent, state: CopilotConversation, env: CopilotEnvironment, extras: Extras): Result {
  const language = intent.language, m = copilotCopy(language), p = m.lifecycle, text = segmentText(state), latest = state.segment.at(-1) ?? '';
  const named = intent.network !== null && intent.network !== 'OTHER' ? networkOfCopilot(intent.network) : null;
  // A test network is never offered in the public product; engineering certification reaches its Devnet path above.
  if (named?.environment === 'TESTNET') return refused(state, m, activeNetworkScope() === 'PUBLIC_MAINNET' ? testNetworkMessage([named]) : p.networkUnsupported(positionNetworksText(language)));
  if (intent.network === 'OTHER') return refused(state, m, p.networkUnsupported(positionNetworksText(language)));
  const filter = positionFilters(intent, text), facts = env.verified?.liquidity;
  const family = filter.protocol === 'ORCA' || filter.chain?.startsWith('solana:') ? 'solana' as const
    : filter.protocol === 'UNISWAP_V3' || filter.chain?.startsWith('eip155:') ? 'eip155' as const : null;
  // Facts the surface could not read (or a wallet it may not read) are said as such: never "you have no positions".
  if (!facts) return env.wallet || env.verified?.solanaOwner ? failedWith(state, m, p.unavailable, 'COPILOT_POSITIONS_UNAVAILABLE') : refused(state, m, p.walletRequired(family));
  const wallets = facts.wallets.filter(wallet => family === null || wallet.namespace === family);
  if (!wallets.length) return refused(state, m, p.walletRequired(family));
  const readable = wallets.filter(wallet => wallet.status === 'COMPLETE' || wallet.status === 'PARTIAL');
  if (!readable.length) return wallets.every(wallet => wallet.status === 'UNVERIFIED') ? refused(state, m, p.unverified) : failedWith(state, m, p.unavailable, 'COPILOT_POSITIONS_UNAVAILABLE');
  const notes = [...wallets.length !== readable.length || readable.some(wallet => wallet.status === 'PARTIAL') ? [p.partial] : [],
    // Positions read from MOCKED test data (a loopback harness) are said to be test data, as the Dashboard labels them; never presented as a public read.
    ...readable.some(wallet => wallet.mocked) ? [p.mockedNote] : []];
  const owners = new Set(readable.map(wallet => wallet.namespace === 'eip155' ? wallet.address.toLowerCase() : wallet.address));
  const all = facts.positions.filter(view => owners.has(view.ref.owner));
  const candidates = all.filter(view => (!filter.protocol || view.ref.protocol === filter.protocol) && (!filter.chain || view.ref.chain === filter.chain) && pairMatches(view, filter.assets));
  const filters = [filter.protocol ? protocolName(filter.protocol) : null, filter.networkName, filter.assets.length ? filter.assets.join('/') : null].filter(Boolean).join(', ') || null;
  const reason = (manageable: LiquidityPositionView['manageable']) => p.reason[manageable.ok ? 'OPERATION_UNAVAILABLE' : manageable.reason];

  // Reads: FloFi's own answer from the verified facts (no PnL, APY or estimate; an unread amount is "unavailable").
  if (intent.operation === 'LIST') {
    if (!candidates.length) return positionAnswer(state, language, reply('ANSWER', p.listNone(filters), { notes }));
    const range = rangeFilterNamed(latest);
    const matched = range === null ? candidates : candidates.filter(view => view.status === 'OPEN' && (range === 'IN' ? view.rangeState === 'IN_RANGE'
      : view.rangeState === 'BELOW_RANGE' || view.rangeState === 'ABOVE_RANGE'));
    const shown = matched.slice(0, POSITION_FACT_LIMITS.maxListed);
    return positionAnswer(state, language, reply('ANSWER', p.list(matched.length, candidates.length, range), { notes: [...shown.map(view => positionLine(view, language)),
      ...matched.length > shown.length ? [p.listMore(matched.length - shown.length)] : [], ...shown.length ? [p.listRounded] : [], ...notes, p.readOnly] }));
  }
  if (intent.operation === 'INSPECT') {
    if (!candidates.length) return positionAnswer(state, language, reply('ANSWER', p.listNone(filters), { notes }));
    const pinned = extras.position ? candidates.find(view => positionKey(view) === extras.position) : undefined;
    const picked = pinned ?? (filter.ordinal ? pick(candidates, filter.ordinal) : undefined);
    if (filter.ordinal && !picked) return positionAnswer(state, language, reply('ANSWER', p.noOrdinal(candidates.length), { notes: candidates.map(view => positionLine(view, language)) }));
    const shown = picked ? [picked] : candidates.slice(0, POSITION_FACT_LIMITS.maxInspected);
    return positionAnswer(state, language, reply('ANSWER', shown.length === 1 ? p.inspectOne(describePosition(shown[0]!, language)) : p.inspectMany(candidates.length, shown.length),
      { notes: [...shown.flatMap(view => [...shown.length > 1 ? [describePosition(view, language)] : [], ...positionDetails(view, language, reason)]), ...notes, p.readOnly] }));
  }

  // Operations: the portion is the user's own words ("50%", "half", "metade"), the operation they named, or one of FloFi's buttons; never a guess.
  // An answer to FloFi's portion question belongs to the partial removal that asked it; a request the user changed to another operation starts afresh.
  let portion: string | null = extras.portion && (intent.operation === 'DECREASE' || extras.portion === intent.operation) ? extras.portion : null;
  if (portion === null) {
    if (intent.operation === 'COLLECT' || intent.operation === 'EXIT' || intent.operation === 'CLOSE') portion = intent.operation;
    else {
      const wanted = intent.percent === null ? null : canonicalDecimal(intent.percent), written = statedPercent(text);
      if (wanted !== null && ((wanted === '50' && halfNamed(text)) || written === wanted)) portion = wanted;
      else if (wanted === null) portion = written ?? (halfNamed(text) ? '50' : null);
    }
  }
  const needed: LiquidityPositionOperation = portion === 'COLLECT' ? 'COLLECT' : portion === 'EXIT' || portion === 'CLOSE' || portion === '100' ? 'EXIT' : 'DECREASE';
  if (!candidates.length) return refused(state, m, p.none(filters));
  const eligible = candidates.filter(view => view.operations.includes(needed));
  // The structured reference kept across turns is re-read from the verified facts every turn: a position that is no longer there ends the request.
  const pinned = extras.position ? all.find(view => positionKey(view) === extras.position) ?? null : null;
  if (extras.position && !pinned) return failedWith(closeSegment(state), m, p.positionGone, 'COPILOT_CONTEXT_CHANGED');
  let chosen: LiquidityPositionView | null = pinned && candidates.includes(pinned) ? pinned : null;
  if (chosen && !chosen.operations.includes(needed)) return refused(state, m, p.cannot(describePosition(chosen, language), p.reason[positionRefusal(chosen, needed)]));
  if (!eligible.length) {
    if (candidates.length === 1) return refused(state, m, p.cannot(describePosition(candidates[0]!, language), p.reason[positionRefusal(candidates[0]!, needed)]));
    const result = refused(state, m, p.cannotAny(candidates.length));
    return { ...result, reply: { ...result.reply, notes: candidates.slice(0, POSITION_FACT_LIMITS.maxListed)
      .map(view => p.cannotLine(describePosition(view, language), p.reason[positionRefusal(view, needed)])) } };
  }
  // An ordinal counts the positions as FloFi lists them (every matching position, manageable or not): the one named is the one meant, and one that
  // cannot do this operation is refused, never swapped for another (flofi-chat review P2).
  if (!chosen && filter.ordinal) {
    const named = pick(candidates, filter.ordinal);
    if (named && !named.operations.includes(needed)) return refused(state, m, p.cannot(describePosition(named, language), p.reason[positionRefusal(named, needed)]));
    chosen = named ?? null;
  }
  // Exactly one eligible position is the one meant (unless the user named an ordinal FloFi could not resolve); several are never auto-selected:
  // FloFi asks which, with buttons.
  if (!chosen && !filter.ordinal && eligible.length === 1) chosen = eligible[0]!;
  if (!chosen) {
    const shown = eligible.slice(0, POSITION_FACT_LIMITS.maxOptions), keep: Extras = { ...extras, ...portion ? { portion } : {} };
    const options = shown.map(view => ({ label: positionOptionLabel(view, language), fill: { kind: 'EXTRAS' as const, extras: { ...keep, position: positionKey(view) } } }));
    const ask = filter.ordinal ? p.noOrdinal(eligible.length) : eligible.length > shown.length ? `${p.which} ${p.whichMore(eligible.length, shown.length)}` : p.which;
    return question(state, m, ask, options.map(option => option.label), { intent, options, amountFill: false, snapshot: snapshotOf(env), extras: keep, expected: ['target'] },
      notes, { code: POSITION_WHICH });
  }
  if (portion === null) {
    const values = [...chosen.operations.includes('DECREASE') ? ['25', '50', '75'] : [], ...chosen.operations.includes('EXIT') ? ['EXIT'] : []];
    const keep: Extras = { ...extras, position: positionKey(chosen) };
    const options = values.map(value => ({ label: value === 'EXIT' ? p.allExit : `${value}%`, fill: { kind: 'EXTRAS' as const, extras: { ...keep, portion: value } } }));
    return question(state, m, p.portion(describePosition(chosen, language)), options.map(option => option.label),
      { intent, options, amountFill: false, snapshot: snapshotOf(env), extras: keep, expected: ['percent'] }, notes, { code: POSITION_PORTION });
  }
  let operation: LiquidityPositionOperation, partBps: number | null = null;
  if (portion === 'COLLECT') operation = 'COLLECT';
  else if (portion === 'EXIT' || portion === 'CLOSE') operation = 'EXIT';
  else {
    const value = Number(portion), bps = Math.round(value * 100);
    if (!Number.isFinite(value) || Math.abs(value * 100 - bps) > 1e-9 || bps < 1 || bps > 10_000) return refused(state, m, p.percentInvalid);
    if (bps === 10_000) operation = 'EXIT'; else { operation = 'DECREASE'; partBps = bps; }
  }
  // Only an operation the verified position offers now; a collection never becomes a removal.
  if (!chosen.operations.includes(operation)) return refused(state, m, p.cannot(describePosition(chosen, language), p.reason[positionRefusal(chosen, operation)]));
  const orca = chosen.ref.protocol === 'ORCA';
  // Orca's verified exit always closes the position; a Uniswap NFT is burned only when the user's own words ask to close it (in this request, or
  // in the choice a short answer changes: `extras.close`).
  const close = operation === 'EXIT' && (orca || closeNamed(text) || extras.close === true);
  const slippageBps = positionSlippageBps(chosen.ref);
  if (slippageBps === null) return refused(state, m, p.networkUnsupported(positionNetworksText(language)));
  const { protocol, chain, network, manager, pool, positionId, owner } = chosen.ref;
  const choice: LiquidityPositionChoice = { position: { protocol, chain, network, manager, pool, positionId, owner }, operation, partBps, close };
  const tokenOf = (t: LiquidityPositionView['token0']) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals });
  if (!liquidityPositionChoiceValid(choice)) return failedWith(state, m, copilotRejection('COPILOT_COMMAND_MISMATCH', language).message, 'COPILOT_COMMAND_MISMATCH');
  const command: Command = { type: 'MANAGE_LIQUIDITY_POSITION', choice, pool: { token0: tokenOf(chosen.token0), token1: tokenOf(chosen.token1), feeTier: chosen.feeTier,
    tickLower: chosen.tickLower, tickUpper: chosen.tickUpper, amount0: chosen.principal[0] ?? '0', amount1: chosen.principal[1] ?? '0', slippageBps },
    source: 'CHAT', baseRevision: env.workflow.revision };
  if (previewOf(env, command).error?.startsWith('POSITION_WORKFLOW_HAS_OTHER_STEPS')) return refused(state, m, p.otherSteps);
  const position = describePosition(chosen, language);
  const what = operation === 'COLLECT' ? p.collect(position) : operation === 'DECREASE' ? p.decrease(position, String(partBps! / 100))
    : orca ? p.orcaExit(position) : close ? p.exitClose(position, chosen.status === 'EMPTY') : p.exit(position);
  const proposalNotes = [p.selectedNote, ...notes, ...operation === 'COLLECT' ? [p.collectNote] : [],
    ...operation !== 'COLLECT' && chosen.status === 'OPEN' ? [p.slippageNote(slippageBps)] : [],
    ...operation === 'EXIT' ? orca ? [p.orcaCloseNote] : close ? [p.burnNote] : [p.keepNftNote] : [],
    ...operation !== 'COLLECT' && chosen.principal.some(units => units === null) ? [p.partialPrincipalNote] : [],
    // The one wallet request and its confirmation depth (the runtime's own policy), then PR #219's flow: Simulate's result, Execute's authorization.
    positionStepWallet(chosen.ref, language), p.flowNote];
  return propose(state, env, command, positionSentence(chosen, operation, partBps, close), `${what} ${p.apply}`, proposalNotes, position);
}
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a short answer under FloFi's own position question, read here without the model: "the first one", "a segunda",
 * "Base", "WETH/USDC", "50%", "metade", "all of it", "only the fees", "yes, close it". Each settled answer is progress: the clarification budget opens
 * again, so a which → portion → yes dialogue never runs out of questions. Anything else (or an exact button label) takes the usual path.
 */
function positionTurn(state: CopilotConversation, draft: Draft, picked: string, env: CopilotEnvironment): TurnStart | null {
  if (draft.intent.kind !== 'POSITION' || (draft.code !== POSITION_WHICH && draft.code !== POSITION_PORTION)) return null;
  if (draft.options.some(option => normalize(option.label) === normalize(picked))) return null;
  const answer = readPositionAnswer(picked);
  if (!answer) return null;
  const intent = draft.intent;
  let extras = draft.extras ?? {}, other = false;
  const positionOf = (option: Draft['options'][number]) => option.fill.kind === 'EXTRAS' ? option.fill.extras.position ?? null : null;
  const views = env.verified?.liquidity?.positions ?? [];
  let patch: Extras | null = null, patched: PositionIntent = intent;
  if (draft.code === POSITION_WHICH) {
    const options = draft.options.filter(option => positionOf(option) !== null);
    const viewOf = (option: Draft['options'][number]) => views.find(view => positionKey(view) === positionOf(option));
    const ordinal = answer.kind === 'ORDINAL' ? pick(options, answer.ordinal) : undefined;
    const matches = answer.kind === 'ORDINAL' ? ordinal ? [ordinal] : []
      : answer.kind === 'NETWORK' ? options.filter(option => viewOf(option)?.ref.chain === networkOfCopilot(answer.network).chain)
        : answer.kind === 'PROTOCOL' ? options.filter(option => viewOf(option)?.ref.protocol === answer.protocol)
          : answer.kind === 'PAIR' ? options.filter(option => { const view = viewOf(option); return view ? pairMatches(view, answer.assets) : false; }) : null;
    if (!matches) return null;
    // One shown position is the answer; several (or none) are narrowed by the user's words on the next resolution, never guessed.
    if (matches.length === 1 && matches[0]!.fill.kind === 'EXTRAS') patch = matches[0]!.fill.extras;
    else if (matches.length > 1 && answer.kind === 'NETWORK') patched = { ...intent, network: answer.network };
    else if (matches.length > 1 && answer.kind === 'PROTOCOL') patched = { ...intent, protocol: answer.protocol };
    else if (matches.length > 1 && answer.kind === 'PAIR') patched = { ...intent, select: { ordinal: null, assets: [...answer.assets] } };
    else return null;
  } else {
    const position = extras.position;
    if (!position) return null;
    if (answer.kind === 'PERCENT') patch = { ...extras, portion: answer.percent === '100' ? 'EXIT' : answer.percent };
    else if (answer.kind === 'ALL') patch = { ...extras, portion: 'EXIT' };
    else if (answer.kind === 'FEES') patch = { ...extras, portion: 'COLLECT' };
    else if (answer.kind === 'CLOSE') patch = { ...extras, portion: 'CLOSE' };
    else if (answer.kind === 'NETWORK' || answer.kind === 'PROTOCOL' || answer.kind === 'PAIR') {
      // Another network, protocol or pair than the position FloFi asked about is another position: the earlier choice no longer applies (said), and
      // the request is resolved again for the one named (FloFi asks which when several match). The same position named again settles nothing.
      const current = views.find(view => positionKey(view) === position);
      const same = !!current && (answer.kind === 'NETWORK' ? current.ref.chain === networkOfCopilot(answer.network).chain
        : answer.kind === 'PROTOCOL' ? current.ref.protocol === answer.protocol : pairMatches(current, answer.assets));
      if (same) return null;
      patched = answer.kind === 'NETWORK' ? { ...intent, network: answer.network } : answer.kind === 'PROTOCOL' ? { ...intent, protocol: answer.protocol }
        : { ...intent, select: { ordinal: null, assets: [...answer.assets] } };
      extras = Object.fromEntries(Object.entries(extras).filter(([key]) => key !== 'position')) as Extras;
      patch = {}; other = true;
    } else return null;
  }
  const next = { ...withUser(state, picked), clarifications: 0 };
  const result = resolveIntent(patched, next, env, null, { ...extras, ...patch ?? {} });
  const said = other ? { ...result, reply: { ...result.reply, notes: [copilotCopy(intent.language).lifecycle.otherPositionNote, ...result.reply.notes] } } : result;
  return { kind: 'LOCAL', ...withLearning(tallied(said, env), env, ['CLARIFICATION_ANSWERED']) };
}
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a short answer right after FloFi prepared a position operation changes that choice, read locally:
 *  - "50%", "metade", "all of it", "tudo", "only the fees", "só os rendimentos", "yes, close it", "sim, fecha": the SAME verified position with another
 *    portion or operation (an exit keeps the Uniswap NFT unless the user's own words close it; "close it" after a close changes nothing);
 *  - "Base", "the Arbitrum one", "the Orca one", "WETH/USDC": the same operation on ANOTHER position (asked which when several match).
 * Every change is a new MANAGE_LIQUIDITY_POSITION proposal resolved again from the verified facts (never conversation state alone), and says that it
 * replaces the earlier choice. A position that is gone, or a wallet that changed, ends the choice and says so. Ordinals and anything else take the
 * usual path. Nothing is staged, simulated or signed by the answer itself.
 */
function positionFollowUp(state: CopilotConversation, text: string, env: CopilotEnvironment): TurnStart | null {
  const last = state.referents[0]?.command;
  if (!last || last.type !== 'MANAGE_LIQUIDITY_POSITION' || (env.surface ?? 'WEB') !== 'WEB') return null;
  const answer = readPositionAnswer(text);
  if (!answer || answer.kind === 'ORDINAL') return null;
  const { choice } = last, ref = choice.position, uniswap = ref.protocol === 'UNISWAP_V3';
  if (answer.kind === 'CLOSE' && (!uniswap || choice.close)) return null;
  // The same position named again is not a change.
  if ((answer.kind === 'NETWORK' && networkOfCopilot(answer.network).chain === ref.chain) || (answer.kind === 'PROTOCOL' && answer.protocol === ref.protocol)
    || (answer.kind === 'PAIR' && pairMatches(last.pool, answer.assets))) return null;
  const language = preferredLanguage(state, env) ?? messageLanguage(text) ?? state.language, p = copilotCopy(language).lifecycle;
  const next = { ...withUser(state, text), language };
  const facts = env.verified?.liquidity;
  // Another wallet is connected now: the earlier choice belongs to the previous wallet's position (said, never carried over).
  if (facts && !facts.wallets.some(wallet => (wallet.namespace === 'eip155' ? wallet.address.toLowerCase() : wallet.address) === ref.owner))
    return { kind: 'LOCAL', ...tallied(failedWith(closeSegment(next), copilotCopy(language), p.walletChanged, 'COPILOT_CONTEXT_CHANGED'), env) };
  const base = { version: '2', language, kind: 'POSITION', protocol: null, network: null, percent: null } as const;
  const same: Extras = { position: liquidityPositionKey(ref) };
  const earlierPortion = choice.operation === 'DECREASE' ? String(choice.partBps! / 100) : choice.operation === 'EXIT' ? 'EXIT' : null;
  let intent: PositionIntent, extras: Extras;
  switch (answer.kind) {
    case 'PERCENT': intent = answer.percent === '100' ? { ...base, operation: 'EXIT' } : { ...base, operation: 'DECREASE', percent: answer.percent };
      extras = { ...same, portion: answer.percent === '100' ? 'EXIT' : answer.percent }; break;
    case 'ALL': intent = { ...base, operation: 'EXIT' }; extras = { ...same, portion: 'EXIT' }; break;
    case 'FEES': intent = { ...base, operation: 'COLLECT' }; extras = same; break;
    case 'CLOSE': intent = { ...base, operation: 'CLOSE' }; extras = same; break;
    default: {
      // The same operation and portion on the position the user named now; the owner's own close words carry over (an Orca exit's implied close does not).
      const operation = choice.operation;
      intent = answer.kind === 'NETWORK' ? { ...base, operation, network: answer.network } : answer.kind === 'PROTOCOL' ? { ...base, operation, protocol: answer.protocol }
        : { ...base, operation, select: { ordinal: null, assets: [...answer.assets] } };
      if (operation === 'DECREASE') intent = { ...intent, percent: earlierPortion };
      extras = { ...earlierPortion ? { portion: earlierPortion } : {}, ...uniswap && choice.close ? { close: true as const } : {} };
    }
  }
  const result = resolveIntent(intent, next, env, null, extras), proposed = result.reply.command;
  const replaced = proposed?.type === 'MANAGE_LIQUIDITY_POSITION' && JSON.stringify(proposed.choice) !== JSON.stringify(choice);
  const said = replaced ? { ...result, reply: { ...result.reply, notes: [p.replacedNote, ...result.reply.notes] } } : result;
  return { kind: 'LOCAL', ...tallied(said, env) };
}
/** Engineering certification only: "Remove 50% of my liquidity", "exit my position" on a FloFi-registered Orca position of the connected Solana Devnet wallet. */
function resolveDevnetPosition(intent: PositionIntent & { readonly operation: 'DECREASE' | 'EXIT' }, state: CopilotConversation, env: CopilotEnvironment, extras: Extras): Result {
  const m = copilotCopy(intent.language), verified = env.verified, text = segmentText(state);
  if ((intent.protocol !== null && intent.protocol !== 'ORCA') || (intent.network !== null && intent.network !== 'SOLANA_DEVNET')) return refused(state, m, m.positionOnlyOrca);
  if (!verified?.solanaOwner) return refused(state, m, m.positionWalletRequired);
  if (!verified.orcaPositions) return failed(state, m, m.positionsUnavailable);
  const draft = (options: Draft['options']): Draft => ({ intent, options, amountFill: false, snapshot: snapshotOf(env), extras });
  const half = /\b(?:half|metade)\b/i.test(text);
  // The portion is the user's own words ("50%", "half"), EXIT, or one of Flofi's buttons; never a guess.
  const exitNamed = /\b(?:close|exit|fechar|feche|fecha|encerrar|encerre|encerra)\b|\b(?:remove|withdraw)\s+all\b|\b(?:retir\w*|remov\w*)\s+(?:tud[oa]|100\s*%)\b/i.test(text);
  let portion: string | null = extras.portion ?? (intent.operation === 'EXIT' && exitNamed ? 'EXIT' : null);
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
function author(intent: CopilotIntentV2, actions: readonly CopilotAction[], composition: boolean, carriedIn: ReadonlySet<CarriedField>, state: CopilotConversation,
  env: CopilotEnvironment, notes: readonly string[], describe: (sentence: string) => string, label: string, editNodeId: string | null = null,
  swap: SwapSource | null = null, extras: Extras = {}): Result {
  const language = intent.language, m = copilotCopy(language), a = ASSIST_COPY[language];
  // BUILD-BASE-001: the conversation (CopilotIntentV2) authors on the catalog networks too. PR B: with the verified Orca price and the funding swap.
  // BUILD-CHAT-LEARNING-001: learned vocabulary may only widen which networks/tokens the user named (see `Grounding.lexicon`).
  const lexicon = lexiconOf(state, env);
  // BUILD-FLOFI-UNIFIED-COPILOT-001: unambiguous typos of network and coin names ("arbriturm", "etheruem") are read as the name they clearly are,
  // but FloFi always says how it read them before it proposes: a corrected word never becomes a proposal in the same turn it was written.
  // A word the learned vocabulary already knows keeps that path (a glossary meaning for a mainnet only suggests, and the user picks it).
  const known = new Set(lexicon.map(entry => entry.term.toLowerCase()));
  // BUILD-FLOFI-UNIFIED-COPILOT-001: the words of a saved name are not the user naming a network, token or route ("Base da Ana", "Solange",
  // "Mayan"): typo reading and grounding see the request with saved names masked; the address comes from the saved recipient itself.
  const recipients = env.recipients ?? [], unmasked = segmentText(state), latestText = state.segment.at(-1) ?? '';
  const masked = (text: string) => recipients.length ? maskSavedRecipients(text, recipients) : text;
  const raw = correctTypos(masked(unmasked)), unknown = raw.corrections.filter(item => !known.has(item.written));
  const fix = (text: string) => unknown.reduce((out, item) => out.replace(new RegExp(`(?<![\\p{L}])${item.written}(?![\\p{L}])`, 'giu'), item.corrected), text);
  const corrected = unknown.length === raw.corrections.length ? raw : { text: fix(masked(unmasked)), corrections: unknown };
  const shown = new Set(extras.typos ?? []);
  const unshown = corrected.corrections.filter(item => !shown.has(item.written));
  const typos = [...shown, ...unshown.map(item => item.written)];
  // BUILD-FLOFI-UNIFIED-COPILOT-001: a saved recipient named in the user's latest words replaces a carried destination ("manda o mesmo para Minha
  // Carteira" repeats the step to that saved address, never to the old one); a typed new address is a change the model reports itself.
  // "Manda o mesmo para mim" repeats the step to the user's own wallet: a carried third-party destination is dropped (the planner's "to me" rule).
  let carried = carriedIn;
  if (carried.has('recipient') && releasesRecipient(state, env, extras)) {
    actions = actions.map(action => (action.type === 'TRANSFER' || action.type === 'BRIDGE') && action.recipient ? { ...action, recipient: null } as CopilotAction : action);
    carried = new Set([...carried].filter(field => field !== 'recipient'));
  }
  // BUILD-FLOFI-UNIFIED-COPILOT-001: a saved recipient named exactly ("para Minha Solana") fills an empty destination with its public address. It is
  // re-resolved on every turn of the request (the draft keeps its id, never the address), so its ecosystem is re-checked once the network is known.
  const scope = !state.draft || operationsOf(state.draft.intent) === operationsOf(intent) ? unmasked : latestText;
  const saved = savedRecipientFor(actions, state, env, language, intent, { ...extras, carried: [...carried], ...swap ? { swap } : {} }, scope, carried, masked(unmasked));
  if ('result' in saved) return saved.result;
  actions = saved.actions;
  const grounding: Grounding = { text: corrected.text, carried, policy: { language, networkDefaults: false, catalog: true, ...env.agentRollout ? { agentRollout: env.agentRollout } : {} },
    latest: fix(masked(latestText)),
    solana: { price: env.verified?.orcaPrice?.price ?? null, swap }, ...lexicon.length ? { lexicon } : {}, ...extras.planned ? { explicitAssets: false } : {},
    // BUILD-P1: the mainnet pool reads the surface made for this turn, whether it can read one on request, and the time they are judged fresh against.
    ...env.verified?.pools?.length ? { pools: env.verified.pools } : {}, ...env.poolReads ? { poolReads: true } : {}, now: env.now ?? Date.now(),
    // BUILD-FLOFI-UX-FIX-003: only a new single action reads "to 1 USDC" as an amount to receive; an edit's "to 4 USDC" is its new amount.
    ...intent.kind === 'ACTION' && !composition ? { receiving: true } : {}, ...saved.addresses.length ? { saved: saved.addresses } : {},
    ...extras.answeredPercent ? { answeredPercent: extras.answeredPercent } : {}, ...extras.rangeAsked ? { rangeAsked: true } : {} };
  if (!composition && !extras.planned) actions = actions.map(a => groundExplicitAssets(a, grounding.latest ?? grounding.text, lexicon, grounding.receiving === true));
  // The stored draft never holds a saved address: it keeps the recipient's id, so the next turn resolves (and re-checks) it again.
  const open = (list: readonly CopilotAction[]) => saved.id ? list.map(action => (action.type === 'TRANSFER' || action.type === 'BRIDGE') && action.recipient !== null
    && saved.addresses.includes(action.recipient) ? { ...action, recipient: null } as CopilotAction : action) : list;
  const draftIntent: CopilotIntentV2 = intent.kind === 'ACTION' ? { ...intent, action: open(actions)[0]! } : intent.kind === 'COMPOSITION' ? { ...intent, actions: open(actions) } : intent;
  const kept = { ...extras, carried: [...carried], ...swap ? { swap } : {}, ...typos.length ? { typos } : {}, ...saved.id ? { savedRecipient: saved.id } : {} };
  const readNotes = [...unshown.length ? [a.readAs(unshown)] : [], ...saved.notes];
  const planned = planCopilotActions(actions, composition, grounding, env.wallet);
  if (planned.kind !== 'PLAN') return stopped(planned, draftIntent, state, env, m, kept, readNotes);
  const outcome = proposalFromPlan(planned.plan, env, language);
  if (outcome.kind !== 'PROPOSAL') return stopped(outcome, draftIntent, state, env, m, kept, readNotes);
  // The plan is complete, but a word was read through a typo correction the user has not seen yet: confirm that reading first.
  if (unshown.length) return question(state, m, a.confirmReading(unshown, outcome.sentence), [a.confirmOption],
    { intent: draftIntent, expected: ['target'], validated: validatedDraftFields(draftIntent, segmentText(state)), options: [{ label: a.confirmOption, fill: { kind: 'EXTRAS', extras: kept } }],
      amountFill: false, snapshot: snapshotOf(env), extras: kept });
  let command = outcome.command;
  if (editNodeId) {
    const edit = editCommandFor(env.workflow, env.context, editNodeId, command);
    if (!edit.ok) { const label = workflowSteps(env.workflow, env.context).find(step => step.nodeId === editNodeId);
      return refused(state, m, m.refusal[edit.code as keyof typeof m.refusal]?.(label ? stepLabel(m, label, language) : editNodeId) ?? m.rejectedCode(edit.code)); }
    command = edit.command;
  }
  // Every learned entry that made the difference is named in the proposal, so the user reviews how their words were read.
  const used = usedEntries(segmentText(state), lexicon, outcome.sentence);
  // BUILD-CHAT-LEARNING-002: how each field was read — the request's own words up to FloFi's first question, then the user's answers.
  const asked = state.askedAt ?? state.segment.length, request = state.segment.slice(0, asked).join('\n'), answers = state.segment.slice(asked).join('\n');
  const readings = env.learning ? proposalReadings(stepFields(changedSteps(env, command)[0]), request, answers, lexicon, carried) : [];
  const proposed = propose(state, env, command, outcome.sentence, describe(outcome.sentence), [...notes, ...saved.notes, ...outcome.notes, ...used.map(entry => usedNote(entry, language))], label,
    readings.length ? { readings, request } : null);
  if (proposed.reply.kind !== 'PROPOSAL') return proposed;
  // BUILD-FLOFI-UNIFIED-COPILOT-001: a new public address the user typed may be saved for later, only if they choose to (never required, never
  // asked again for an address already saved or declined here). Saving is independent of this proposal and authorizes nothing.
  const offered = recipientOfferFor(actions, saved.addresses, state, env, language);
  if (offered) return withAdaptation(withLearning({ reply: { ...proposed.reply, offer: { text: a.recipientOffer(offered.short), options: [a.recipientSaveOption, a.recipientNotNowOption] } },
    next: { ...proposed.next, recipientOffer: offered.offer } }, env, [], used), env, mergeAdaptations(clarifiedAdaptation(readings, request), inferredUse(readings)));
  // A word FloFi asked about and the user answered is adapted for the rest of the conversation; every reading FloFi made on its own is reported.
  return withAdaptation(withLearning(proposed, env, [], used), env, mergeAdaptations(clarifiedAdaptation(readings, request), inferredUse(readings)));
}
function stopped(outcome: Exclude<CopilotOutcome, { kind: 'PROPOSAL' }>, intent: CopilotIntentV2, state: CopilotConversation, env: CopilotEnvironment, m: CopilotCopy,
  extras: Extras = {}, readNotes: readonly string[] = []): Result {
  if (outcome.kind === 'UNSUPPORTED' || outcome.kind === 'REJECTED') {
    if (outcome.missing?.length) {
      const draft: Draft = { intent, grounding: segmentText(state), expected: outcome.missing, validated: validatedDraftFields(intent, segmentText(state)), options: [], amountFill: false, snapshot: snapshotOf(env), extras };
      // How FloFi read a misspelled word is shown here too: the stored draft counts that reading as seen.
      const value = reply(outcome.kind === 'REJECTED' ? 'FAILED' : 'UNSUPPORTED', outcome.message, { ...outcome.code ? { code: outcome.code } : {}, ...readNotes.length ? { notes: [...readNotes] } : {} });
      return { reply: value, next: { ...state, draft, transcript: bounded([...state.transcript, { role: 'assistant', text: outcome.message }]) } };
    }
    return outcome.kind === 'UNSUPPORTED' ? refused(state, m, outcome.message) : failed(state, m, outcome.message);
  }
  // Flofi's question for the other pool token's maximum (a position funded by a swap's output) is answered by a bare amount.
  const otherToken = outcome.deposit;
  // BUILD-CHAT-LEARNING-001: a glossary suggestion for a mainnet only puts that option first, with a note; the user still picks.
  const followOn = intent.kind === 'ACTION' && outcome.missing.includes('network') && !extras.target && !extras.planned &&
    !mentionedNetworks(segmentText(state)).length ? followOnClarification(intent.action, intent.language, env) : null;
  const original = outcome.options.filter(option => publicText(option) !== null);
  const options = followOn?.network ? [followOn.network, ...original.filter(option => option !== followOn.network)] : original;
  const suggested = withSuggestion(state, env, options, intent.language);
  // BUILD-P1: "Try again" after a pool read FloFi could not make resolves the same request again (locally; the surface reads the pool once more).
  const retry: Draft['options'] = suggested.options.includes(m.retryOption) ? [{ label: m.retryOption, fill: { kind: 'EXTRAS', extras: {} } }] : [];
  // BUILD-P1: once FloFi has asked for the range, the answer alone decides it (see `Grounding.rangeAsked`).
  const kept: Extras = outcome.code === 'COPILOT_RANGE_REQUIRED' ? { ...extras, rangeAsked: true } : extras;
  const draft: Draft = { intent, expected: outcome.missing, validated: validatedDraftFields(intent, segmentText(state)), options: [...actionFills(intent, outcome.missing, suggested.options), ...retry], snapshot: snapshotOf(env), extras: kept,
    amountFill: intent.kind === 'ACTION' && outcome.missing.includes('amount') && intent.action.type !== 'LIQUIDITY',
    // The relative amount must be about the very token FloFi asks the amount of ("todo o USDC" for a USDC question; never "toda a Base").
    // The newest user turn that states one wins ("metade do meu USDC", then "não, todo o USDC": all of it).
    ...intent.kind === 'ACTION' && outcome.missing.length === 1 && outcome.missing[0] === 'amount' && newestRelative(state, inputAssetOf(intent.action))
      ? { relative: newestRelative(state, inputAssetOf(intent.action))! } : {},
    ...otherToken && outcome.missing.includes('amount') ? { depositFill: otherToken } : {}, ...suggested.suggestion ? { suggestion: suggested.suggestion } : {} };
  return question(state, m, outcome.question, suggested.options, draft, [...readNotes, ...suggested.notes, ...followOn ? [followOn.note] : []],
    { ...outcome.code ? { code: outcome.code } : {}, ...outcome.pool ? { pool: outcome.pool } : {} });
}

function followOnClarification(action: CopilotAction, language: CopilotLanguage, env: CopilotEnvironment) {
  const kinds = { TRANSFER: 'transfer', SUPPLY: 'supply', REPAY: 'repay', BORROW: 'borrow', WITHDRAW: 'withdraw', SWAP: 'swap', LIQUIDITY: 'pool' } as const;
  const kind: CryptoAction | undefined = kinds[action.type as keyof typeof kinds];
  if (!kind || kind === 'pool') return null;
  const suggestion = followOnSelection(env.workflow, kind, activeNetworkScope() === 'PUBLIC_MAINNET' ? 'mainnet' : undefined);
  if (!suggestion) return null;
  const match = suggestion.selection && networkIdentity(suggestion.selection.network);
  const network = match?.copilot && copilotNetworksFor(kind, env.agentRollout).includes(match.copilot) ? match.name : null;
  if (suggestion.issue === 'ambiguous') return null;
  if (!network || !suggestion.selection) return { note: language === 'PT'
    ? 'A rede de destino do passo anterior não está disponível para esta ação. Escolha uma rede compatível.'
    : 'The previous step’s output network is unavailable for this action. Choose a supported network.' };
  if (suggestion.issue === 'asset') return { network, note: language === 'PT'
    ? `O passo anterior termina em ${network}. Escolha um ativo compatível com esta ação.`
    : `The previous step ends on ${network}. Choose an asset supported by this action.` };
  return { network, note: language === 'PT' ? `O passo anterior entrega ${suggestion.selection.from} em ${network}.`
    : `The previous step delivers ${suggestion.selection.from} on ${network}.` };
}
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: the saved recipient a request names, for its empty destination (a send's recipient, a bridge's destination
 * wallet). Exactly one name selects one address; several names, or part of a name, is a question; an address of the other ecosystem than the
 * destination network is refused with the reason (a send cannot cross ecosystems: that is a bridge). The model never sees the name or address.
 */
function savedRecipientFor(actions: readonly CopilotAction[], state: CopilotConversation, env: CopilotEnvironment, language: CopilotLanguage, intent: CopilotIntentV2,
  extras: Extras, scope: string, carried: ReadonlySet<CarriedField>, maskedText: string):
  { readonly actions: readonly CopilotAction[]; readonly addresses: readonly string[]; readonly notes: readonly string[]; readonly id: string | null } | { readonly result: Result } {
  const none = { actions, addresses: [] as string[], notes: [] as string[], id: null };
  const recipients = env.recipients ?? [], a = ASSIST_COPY[language], m = copilotCopy(language);
  // A recipient picked from FloFi's own buttons (or resolved earlier in this request) must still be in this account's list: otherwise the request
  // is stale and nothing falls back to matching other names.
  const picked = extras.savedRecipient ? recipients.find(recipient => recipient.id === extras.savedRecipient) ?? null : null;
  if (extras.savedRecipient && !picked) return { result: failed(closeSegment(state), m, a.recipientStale) };
  if (!recipients.length) return none;
  // "Para mim" / "to my wallet" is the connected owner wallet: a saved name never replaces it.
  if (!picked && SELF_RECIPIENT.test(scope)) return none;
  const mention = picked ? { kind: 'ONE' as const, recipient: picked } : matchSavedRecipients(scope, recipients);
  if (mention.kind === 'NONE') return none;
  const fillable = actions.filter(action => action.type === 'TRANSFER' || action.type === 'BRIDGE');
  if (!fillable.length) return { ...none, notes: mention.kind === 'ONE' ? [a.recipientNotUsed(mention.recipient.label)] : [] };
  // "Which one?": each saved name is a button that picks exactly that recipient for the same request (its step, edit and values are kept).
  if (mention.kind === 'CHOOSE') { const labels = mention.candidates.map(recipient => recipient.label);
    const asked = question(state, m, a.recipientChoose(labels), labels, { intent, expected: ['recipient'], options: mention.candidates.map(recipient =>
      ({ label: recipient.label, fill: { kind: 'EXTRAS' as const, extras: { ...extras, savedRecipient: recipient.id } } })), amountFill: false, snapshot: snapshotOf(env), extras });
    return { result: { ...asked, reply: { ...asked.reply, verbatimOptions: true } } }; }
  const chosen = mention.recipient, ecosystem = chosen.ecosystem === 'EVM' ? 'EVM' : 'Solana';
  const same = (address: string | null) => address !== null && (chosen.ecosystem === 'EVM' ? address.toLowerCase() === chosen.address : address === chosen.address);
  // The ecosystem is enforced against a network the user named (outside saved names) or one carried from the step; a network only the model
  // guessed is asked instead, and the recipient waits by id until then.
  const named: readonly string[] = mentionedNetworks(maskedText);
  // Only the request's final send or bridge goes to the saved recipient ("bridge to Arbitrum, then send to Ana": the bridge stays with the owner).
  const last = actions.reduce((at, action, index) => (action.type === 'TRANSFER' || action.type === 'BRIDGE') && (action.recipient === null || same(action.recipient)) ? index : at, -1);
  if (last < 0) return { ...none, notes: [a.recipientNotUsed(chosen.label)] };
  const filled: CopilotAction[] = [];
  for (const [index, action] of actions.entries()) {
    if (index !== last || (action.type !== 'TRANSFER' && action.type !== 'BRIDGE')) { filled.push(action); continue; }
    const network = action.type === 'TRANSFER' ? action.network : action.destinationNetwork;
    const known = network && network !== 'OTHER' && (named.includes(network) || carried.has(action.type === 'TRANSFER' ? 'network' : 'destinationNetwork'));
    const wanted = network && network !== 'OTHER' ? (networkOfCopilot(network).family === 'solana' || /^SOLANA/.test(network) ? 'SOLANA' : 'EVM') : null;
    if (wanted && wanted !== chosen.ecosystem) {
      if (known) return { result: refused(state, m, a.recipientWrongEcosystem(chosen.label, ecosystem, COPILOT_NETWORK_LABEL[network as Exclude<CopilotNetwork, 'OTHER'>],
        action.type === 'BRIDGE')) };
      filled.push({ ...action, recipient: null } as CopilotAction); continue;
    }
    filled.push({ ...action, recipient: chosen.address } as CopilotAction);
  }
  return { actions: filled, addresses: [chosen.address], notes: [a.recipientNamed(chosen.label, ecosystem, chosen.address)], id: chosen.id };
}
/** The optional save offer for a public address the user typed in this request (not a saved one, not already saved, not declined here). */
function recipientOfferFor(actions: readonly CopilotAction[], savedAddresses: readonly string[], state: CopilotConversation, env: CopilotEnvironment, language: CopilotLanguage):
  { readonly offer: RecipientOffer; readonly short: string } | null {
  if (!env.recipientWrites) return null;
  for (const action of actions) {
    if ((action.type !== 'TRANSFER' && action.type !== 'BRIDGE') || !action.recipient || savedAddresses.includes(action.recipient)) continue;
    const ecosystem = ecosystemOfAddress(action.recipient), address = ecosystem ? savedRecipientAddress(ecosystem, action.recipient) : null;
    if (!ecosystem || !address || !groundedAddress(segmentText(state), action.recipient)) continue;
    if ((env.recipients ?? []).some(recipient => recipient.ecosystem === ecosystem && recipient.address === address) || (state.recipientDeclined ?? []).includes(address)) continue;
    const pt = language === 'PT';
    // A neutral suggestion: a typed address may be anyone's, so FloFi never proposes a name that calls it the user's own wallet.
    const tail = `${address.slice(0, 4)}…${address.slice(-4)}`;
    const suggestion = ecosystem === 'SOLANA' ? (pt ? `Destinatário Solana ${tail}` : `Solana recipient ${tail}`) : (pt ? `Destinatário EVM ${tail}` : `EVM recipient ${tail}`);
    return { offer: { address, ecosystem, suggestion: (env.recipients ?? []).some(recipient => recipientLabelKey(recipient.label) === recipientLabelKey(suggestion)) ? null : suggestion,
      naming: false }, short: `${address.slice(0, 6)}…${address.slice(-4)}` };
  }
  return null;
}
/** Defense in depth, then the editor preview: an unappliable or empty edit is explained instead of shown as a proposal. */
function propose(state: CopilotConversation, env: CopilotEnvironment, command: Command, sentence: string, text: string, notes: readonly string[], label: string,
  learned: { readonly readings: readonly ProposalReading[]; readonly request: string } | null = null): Result {
  const m = copilotCopy(state.language);
  if (!COPILOT_V2_COMMANDS.has(command.type) || command.source !== 'CHAT' || command.baseRevision !== env.workflow.revision || !commandIsValid(command))
    return failed(state, m, copilotRejection('COPILOT_COMMAND_MISMATCH', state.language).message);
  const preview = previewOf(env, command);
  if (preview.error) return failed(state, m, copilotRejection(preview.error.split(':')[0]!.trim(), state.language).message);
  // BUILD-FLOFI-MAINNET-PRODUCT-001: the public product never proposes a step on a test network (and never moves one to a mainnet itself).
  const introduced = introducedTestNetworks(env.workflow, preview.workflow, activeNetworkScope());
  if (introduced.length) return refused(state, m, testNetworkMessage(introduced));
  // A position-management proposal may leave the IR as it is (the workflow already holds that position's step): Apply still prepares the operation.
  const unchanged = command.type !== 'MANAGE_SOLANA_POSITION' && command.type !== 'MANAGE_LIQUIDITY_POSITION' && (preview.workflow === env.workflow || (command.type === 'AUTHOR_LENDING' && lendingDetails(env.workflow) !== null &&
    JSON.stringify(lendingDetails(preview.workflow)) === JSON.stringify(lendingDetails(env.workflow))));
  if (unchanged) return refused(state, m, m.refusal.NO_CHANGE(label));
  return terminal(recordProposal(state, env, command, sentence, learned), reply('PROPOSAL', text, { notes: [...new Set(notes)], command, sentence }),
    COPILOT_TRANSCRIPT.proposed + sentence);
}
