// SPDX-License-Identifier: AGPL-3.0-only
import { COPILOT_FEE_TIERS, COPILOT_LIMITS, COPILOT_LIQUIDITY_PROTOCOLS, COPILOT_MISSING_FIELDS, COPILOT_ROUTING, COPILOT_V1_PARTS, COPILOT_V2_NETWORKS, COPILOT_V2_RANGE_UNITS,
  CopilotIntentError, type CopilotAction, type CopilotAsset, type CopilotDeposit, type CopilotFeeTier, type CopilotMissingField, type CopilotNetwork,
  type CopilotRouting } from './copilot-intent';
import { parseAutomationDraft, AUTOMATION_DRAFT_SCHEMA, type AutomationDraft } from './copilot-automation';
import { COPILOT_LANGUAGES, type CopilotLanguage } from './copilot-messages';

/**
 * BUILD-COPILOT-002: the versioned successor of CopilotIntentV1 for a bounded conversation. The model still only reports
 * what the user said. It may now point at an existing step, but only by kind and ordinal ("the swap", "the second
 * step", "it"), never by node id; Flofi resolves that against the canonical workflow. It may ask Flofi a read-only
 * question by topic; Flofi writes the answer from its own state. Actions are the V1 shapes. Nothing here can execute,
 * sign, quote, carry calldata or name a chain id, nonce, key or signature.
 */
export const COPILOT_INTENT_V2_VERSION = '2';
/** BUILD-BASE-001: TRANSFER steps (catalog-network transfers) can be referred to like every other step. */
export const COPILOT_STEP_KINDS = ['SWAP', 'BRIDGE', 'SUPPLY', 'BORROW', 'REPAY', 'WITHDRAW', 'LIQUIDITY', 'TRANSFER'] as const;
export const COPILOT_ORDINALS = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'LAST'] as const;
export const COPILOT_REUSE_FIELDS = ['network', 'asset', 'amount', 'destination', 'recipient', 'slippage'] as const;
export const COPILOT_QUESTION_TOPICS = ['WORKFLOW_OVERVIEW', 'STEP_COUNT', 'STEP_DETAIL', 'PROTOCOLS', 'NETWORKS', 'APPROVALS', 'EXECUTION_FLOW',
  'EXECUTION_BLOCKERS', 'MANIFEST', 'SIMULATION', 'FAILURE', 'PROPOSAL', 'REVIEW_FINDINGS', 'CAPABILITIES', 'MARKET_DATA', 'OTHER'] as const;
export const COPILOT_V2_MISSING_FIELDS = [...COPILOT_MISSING_FIELDS, 'target'] as const;
/** Managing an existing FloFi-registered position: remove part of its liquidity, or all of it and close it. */
export const COPILOT_POSITION_OPERATIONS = ['DECREASE', 'EXIT'] as const;
export const COPILOT_V2_LIMITS = Object.freeze({ ...COPILOT_LIMITS, maxDeposits: 2, maxReuseFields: COPILOT_REUSE_FIELDS.length,
  maxTranscriptMessages: 16, maxUserTurns: 8, maxSegmentUserTurns: 6, maxClarifications: 3, maxReferents: 4, maxRequestCharacters: 12_000 });

/** Prefixes of the transcript entries Flofi writes; a replayed answer is keyed by the user turns after the last non-question entry. */
export const COPILOT_TRANSCRIPT = Object.freeze({ proposed: 'Flofi proposed: ', asked: 'Flofi asked: ', declined: 'Flofi declined: ' });

export type CopilotStepKind = (typeof COPILOT_STEP_KINDS)[number];
export type CopilotOrdinal = (typeof COPILOT_ORDINALS)[number];
export type CopilotReuseField = (typeof COPILOT_REUSE_FIELDS)[number];
export type CopilotQuestionTopic = (typeof COPILOT_QUESTION_TOPICS)[number];
export type CopilotV2MissingField = (typeof COPILOT_V2_MISSING_FIELDS)[number];
/** Both null: "it", "this", "that" — the most recent referent. */
export type CopilotTarget = { readonly step: CopilotStepKind | null; readonly ordinal: CopilotOrdinal | null };
/** Only the fields the user asked to change are set; everything else stays as the target has it. */
export type CopilotChanges = {
  readonly amount: string | null; readonly slippageBps: string | null; readonly network: CopilotNetwork | null; readonly destinationNetwork: CopilotNetwork | null;
  readonly inputAsset: CopilotAsset | null; readonly outputAsset: CopilotAsset | null; readonly recipient: string | null; readonly routing: CopilotRouting | null;
  readonly deposits: readonly CopilotDeposit[]; readonly rangeUnit: (typeof COPILOT_V2_RANGE_UNITS)[number] | null; readonly lower: string | null; readonly upper: string | null;
  /** BUILD-BASE-001: a new catalog-pool fee tier; absent when the model's shape omits it. */ readonly feeTier?: CopilotFeeTier | null;
};
export type CopilotReuse = { readonly from: CopilotTarget; readonly fields: readonly CopilotReuseField[] };
/** "Remove 50% of my liquidity", "exit my position": FloFi selects the position from the connected wallet's verified FloFi positions. */
export type CopilotPositionRequest = { readonly operation: (typeof COPILOT_POSITION_OPERATIONS)[number]; readonly protocol: (typeof COPILOT_LIQUIDITY_PROTOCOLS)[number] | null;
  readonly network: CopilotNetwork | null; readonly percent: string | null };
type Common = { readonly version: '2'; readonly language: CopilotLanguage };
export type CopilotIntentV2 = Common & (
  | { readonly kind: 'AUTOMATION'; readonly draft: AutomationDraft }
  | { readonly kind: 'ACTION'; readonly action: CopilotAction; readonly reuse: CopilotReuse | null }
  | { readonly kind: 'COMPOSITION'; readonly actions: readonly CopilotAction[] }
  | { readonly kind: 'EDIT'; readonly target: CopilotTarget; readonly changes: CopilotChanges }
  | { readonly kind: 'REPEAT'; readonly target: CopilotTarget; readonly changes: CopilotChanges }
  | { readonly kind: 'REMOVE'; readonly target: CopilotTarget }
  | { readonly kind: 'INSERT'; readonly position: 'BEFORE' | 'AFTER'; readonly anchor: CopilotTarget; readonly action: CopilotAction }
  | { readonly kind: 'QUESTION'; readonly topic: CopilotQuestionTopic; readonly target: CopilotTarget | null }
  | ({ readonly kind: 'POSITION' } & CopilotPositionRequest)
  | { readonly kind: 'CLARIFICATION_REQUIRED'; readonly missing: readonly CopilotV2MissingField[]; readonly question: string; readonly options: readonly string[] }
  | { readonly kind: 'UNSUPPORTED'; readonly reason: string });

const { exact, list, oneOf, nullableOneOf, text, amount, bps, transferAddress, parseActionV2: parseAction, signedDecimal, depositAmount, fail, symbol } = COPILOT_V1_PARTS;
const CHANGE_KEYS = ['amount', 'slippageBps', 'network', 'destinationNetwork', 'inputAsset', 'outputAsset', 'recipient', 'routing', 'deposits', 'rangeUnit',
  'lower', 'upper'] as const;

function parseTarget(value: unknown): CopilotTarget {
  const v = exact(value, ['step', 'ordinal']);
  return { step: nullableOneOf(COPILOT_STEP_KINDS, v.step), ordinal: nullableOneOf(COPILOT_ORDINALS, v.ordinal) };
}
function parseChanges(value: unknown, requireOne: boolean): CopilotChanges {
  const withTier = !!value && typeof value === 'object' && Object.hasOwn(value, 'feeTier');
  const v = exact(value, withTier ? [...CHANGE_KEYS, 'feeTier'] : CHANGE_KEYS);
  const deposits = list(v.deposits, COPILOT_V2_LIMITS.maxDeposits).map(item => {
    const d = exact(item, ['asset', 'maxAmount']);
    return { asset: symbol(d.asset) ?? fail(), maxAmount: depositAmount(d.maxAmount) };
  });
  const changes: CopilotChanges = { amount: amount(v.amount), slippageBps: bps(v.slippageBps), network: nullableOneOf(COPILOT_V2_NETWORKS, v.network),
    destinationNetwork: nullableOneOf(COPILOT_V2_NETWORKS, v.destinationNetwork), inputAsset: symbol(v.inputAsset),
    outputAsset: symbol(v.outputAsset), recipient: transferAddress(v.recipient), routing: nullableOneOf(COPILOT_ROUTING, v.routing), deposits,
    rangeUnit: nullableOneOf(COPILOT_V2_RANGE_UNITS, v.rangeUnit), lower: signedDecimal(v.lower), upper: signedDecimal(v.upper),
    ...withTier ? { feeTier: nullableOneOf(COPILOT_FEE_TIERS, v.feeTier) } : {} };
  // A range is one change: unit and both bounds together (the full range has none), or none of them.
  const range = [changes.rangeUnit, changes.lower, changes.upper].filter(item => item !== null).length;
  // A percentage range is the unit and the percent (in `upper`) only.
  if (changes.rangeUnit === 'FULL' ? range !== 1 : changes.rangeUnit === 'PERCENT' ? range !== 2 || changes.lower !== null : range !== 0 && range !== 3) return fail();
  if (requireOne && !CHANGE_KEYS.some(key => key === 'deposits' ? deposits.length > 0 : changes[key] !== null) && !changes.feeTier) return fail();
  return changes;
}
const common = (v: Record<string, unknown>): Common => {
  oneOf([COPILOT_INTENT_V2_VERSION], v.version);
  return { version: '2', language: oneOf(COPILOT_LANGUAGES, v.language) };
};

/** Strict validation of one V2 intent. Throws `CopilotIntentError` with a closed code; never repairs or guesses. */
export function parseCopilotIntentV2(value: unknown): CopilotIntentV2 {
  const kind = value && typeof value === 'object' ? (value as Record<string, unknown>).kind : undefined;
  const keys = (rest: readonly string[]) => exact(value, ['version', 'language', 'kind', ...rest]);
  switch (kind) {
    case 'AUTOMATION': { const v = keys(['draft']); return { ...common(v), kind, draft: parseAutomationDraft(v.draft) }; }
    case 'ACTION': {
      const v = keys(['action', 'reuse']);
      let reuse: CopilotReuse | null = null;
      if (v.reuse !== null) {
        const r = exact(v.reuse, ['from', 'fields']);
        const fields = list(r.fields, COPILOT_V2_LIMITS.maxReuseFields).map(item => oneOf(COPILOT_REUSE_FIELDS, item));
        if (!fields.length || new Set(fields).size !== fields.length) return fail();
        reuse = { from: parseTarget(r.from), fields };
      }
      return { ...common(v), kind, action: parseAction(v.action), reuse };
    }
    case 'COMPOSITION': {
      const v = keys(['actions']);
      if (Array.isArray(v.actions) && v.actions.length > COPILOT_LIMITS.maxActions) return fail('COPILOT_TOO_MANY_ACTIONS');
      const actions = list(v.actions, COPILOT_LIMITS.maxActions).map(parseAction);
      if (actions.length < 2) return fail();
      return { ...common(v), kind, actions };
    }
    case 'EDIT': case 'REPEAT': {
      const v = keys(['target', 'changes']);
      return { ...common(v), kind, target: parseTarget(v.target), changes: parseChanges(v.changes, kind === 'EDIT') };
    }
    case 'REMOVE': { const v = keys(['target']); return { ...common(v), kind, target: parseTarget(v.target) }; }
    case 'INSERT': {
      const v = keys(['position', 'anchor', 'action']);
      return { ...common(v), kind, position: oneOf(['BEFORE', 'AFTER'] as const, v.position), anchor: parseTarget(v.anchor), action: parseAction(v.action) };
    }
    case 'QUESTION': {
      const v = keys(['topic', 'target']);
      return { ...common(v), kind, topic: oneOf(COPILOT_QUESTION_TOPICS, v.topic), target: v.target === null ? null : parseTarget(v.target) };
    }
    case 'POSITION': {
      const v = keys(['operation', 'protocol', 'network', 'percent']);
      return { ...common(v), kind, operation: oneOf(COPILOT_POSITION_OPERATIONS, v.operation), protocol: nullableOneOf(COPILOT_LIQUIDITY_PROTOCOLS, v.protocol),
        network: nullableOneOf(COPILOT_V2_NETWORKS, v.network), percent: amount(v.percent) };
    }
    case 'CLARIFICATION_REQUIRED': {
      const v = keys(['missing', 'question', 'options']);
      const missing = list(v.missing, COPILOT_V2_MISSING_FIELDS.length).map(item => oneOf(COPILOT_V2_MISSING_FIELDS, item));
      if (new Set(missing).size !== missing.length) return fail();
      return { ...common(v), kind, missing, question: text(v.question, COPILOT_LIMITS.maxQuestionLength),
        options: list(v.options, COPILOT_LIMITS.maxOptions).map(option => text(option, COPILOT_LIMITS.maxOptionLength)) };
    }
    case 'UNSUPPORTED': { const v = keys(['reason']); return { ...common(v), kind, reason: text(v.reason, COPILOT_LIMITS.maxReasonLength) }; }
    default: return fail();
  }
}
/** The structured-output root: `{ "intent": … }`. */
export function parseCopilotOutputV2(value: unknown): CopilotIntentV2 {
  return parseCopilotIntentV2(exact(value, ['intent']).intent);
}
export const isCopilotIntentError = (cause: unknown): cause is CopilotIntentError => cause instanceof CopilotIntentError;
/** Missing fields that V1 conversion understands; `target` is answered by Flofi's own step question. */
export const v1MissingFields = (missing: readonly CopilotV2MissingField[]): CopilotMissingField[] =>
  missing.filter((field): field is CopilotMissingField => field !== 'target');

// Strict structured-output schema. Only conservative keywords; lengths, patterns, counts and the range rule are enforced above.
const { string, nullableString, constant, choice, nullableChoice, object, actionsV2: actionSchemas, symbolText, networkV2Text } = COPILOT_V1_PARTS.schema;
const AMOUNT_TEXT = 'Exactly the number the user wrote in the current request, digits with "." as decimal separator; null if not stated.';
const TARGET = object({
  step: nullableChoice(COPILOT_STEP_KINDS, 'The kind of step the user referred to ("the swap", "a bridge", "o supply"); null if none was named.'),
  ordinal: nullableChoice(COPILOT_ORDINALS, 'The position the user named ("the second step", "o último passo"); null if none. Both null means "it/this/that".'),
});
const CHANGES = object({
  amount: nullableString(AMOUNT_TEXT),
  slippageBps: nullableString('New maximum slippage in basis points only if the user stated it (0.5% = "50"); null otherwise.'),
  network: nullableChoice(COPILOT_V2_NETWORKS, 'New network (for a bridge: new source) only if the user named it; null otherwise. ' + networkV2Text),
  destinationNetwork: nullableChoice(COPILOT_V2_NETWORKS, 'New bridge destination only if the user named it; null otherwise.'),
  inputAsset: nullableString('New input token only if the user named it; null otherwise. ' + symbolText),
  outputAsset: nullableString('New output token only if the user named it; null otherwise. ' + symbolText),
  recipient: nullableString('A new recipient or beneficiary 0x address only if the user typed it exactly; null otherwise.'),
  routing: nullableChoice(COPILOT_ROUTING, 'New bridge provider preference only if the user named LI.FI, Across or automatic; null otherwise.'),
  deposits: { type: 'array', description: 'New liquidity maximum for each token the user named (at most 2); empty if unchanged.',
    items: object({ asset: string(symbolText), maxAmount: string(AMOUNT_TEXT) }) },
  rangeUnit: nullableChoice(COPILOT_V2_RANGE_UNITS, 'PRICE or TICK (with both bounds), FULL (no bounds) or PERCENT (the percent in upper, lower null) for a new liquidity range; null if unchanged.'),
  lower: nullableString('New lower range bound exactly as written; null if unchanged.'), upper: nullableString('New upper range bound exactly as written; null if unchanged.'),
  feeTier: nullableChoice(COPILOT_FEE_TIERS, 'New catalog-pool fee tier in percent only if the user named it; null otherwise.'),
});
const head = (kind: string) => ({ version: constant(COPILOT_INTENT_V2_VERSION),
  language: choice(COPILOT_LANGUAGES, 'Language of the latest user message: PT for Portuguese (also mixed Portuguese and English), EN otherwise.'), kind: constant(kind) });
const ACTION = { anyOf: actionSchemas };
export const COPILOT_OUTPUT_SCHEMA_V2 = Object.freeze(object({ intent: { anyOf: [
  object({ ...head('AUTOMATION'), draft: AUTOMATION_DRAFT_SCHEMA }),
  object({ ...head('ACTION'), action: ACTION, reuse: { anyOf: [object({ from: TARGET, fields: { type: 'array', items: choice(COPILOT_REUSE_FIELDS,
    'A value the user explicitly asked to reuse from an earlier step ("the same network", "a mesma rede").') } }), { type: 'null' }],
    description: 'Only when the user said "same …" about an earlier step; null otherwise.' } }),
  object({ ...head('COMPOSITION'), actions: { type: 'array', description: 'Two or three dependent steps in order.', items: ACTION } }),
  object({ ...head('EDIT'), target: TARGET, changes: CHANGES }),
  object({ ...head('REPEAT'), target: TARGET, changes: CHANGES }),
  object({ ...head('REMOVE'), target: TARGET }),
  object({ ...head('INSERT'), position: choice(['BEFORE', 'AFTER'], 'Where the new step goes relative to the anchor.'), anchor: TARGET, action: ACTION }),
  object({ ...head('POSITION'), operation: choice(COPILOT_POSITION_OPERATIONS, 'DECREASE to remove part of an existing position\'s liquidity, EXIT to remove all of it and close the position.'),
    protocol: nullableChoice(COPILOT_LIQUIDITY_PROTOCOLS, 'The pool protocol only if the user named it; null otherwise.'),
    network: nullableChoice(COPILOT_V2_NETWORKS, 'The network only if the user named it; null otherwise.'),
    percent: nullableString('For DECREASE: the percentage to remove exactly as written ("50" for 50%, "50" for half); null if not stated, and null for EXIT.') }),
  object({ ...head('QUESTION'), topic: choice(COPILOT_QUESTION_TOPICS, 'What the read-only question is about.'),
    target: { anyOf: [TARGET, { type: 'null' }], description: 'The step the question is about, if any.' } }),
  object({ ...head('CLARIFICATION_REQUIRED'), missing: { type: 'array', items: choice(COPILOT_V2_MISSING_FIELDS, 'Missing field.') },
    question: string('One short question in the user\'s language.'), options: { type: 'array', description: 'Up to 4 short answer options.', items: string('Option.') } }),
  object({ ...head('UNSUPPORTED'), reason: string('One short sentence in the user\'s language.') }),
] } }));
