// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-COPILOT-001: the only shape an AI interpretation may take. The model is an untrusted natural-language
 * interpreter with no financial authority; its output is data at the trust level of user text. It reports what the
 * user said (with `null` for anything unstated). Flofi alone decides support, defaults and clarifications, then
 * renders an exact-grammar sentence for `parseLocalCommand`. Nothing here can execute, sign, quote or authorize.
 */
import { COPILOT_NETWORK_IDS } from './network-registry';

export const COPILOT_INTENT_VERSION = '1';
/** BUILD-ETHEREUM-001: ETHEREUM_SEPOLIA is a test network; ETHEREUM is "Ethereum" named without Sepolia (never executable, always clarified). */
export const COPILOT_NETWORKS = ['BASE', 'BASE_SEPOLIA', 'ARBITRUM', 'ARBITRUM_SEPOLIA', 'ETHEREUM', 'ETHEREUM_SEPOLIA', 'SOLANA', 'SOLANA_DEVNET', 'OTHER'] as const;
export const COPILOT_ASSETS = ['USDC', 'WETH', 'ETH', 'SOL', 'USDT', 'DEVUSDC', 'WBTC', 'OTHER'] as const;
export const COPILOT_ROUTING = ['AUTO', 'LIFI', 'ACROSS'] as const;
export const COPILOT_LENDING_TYPES = ['SUPPLY', 'BORROW', 'REPAY', 'WITHDRAW'] as const;
export const COPILOT_LIQUIDITY_PROTOCOLS = ['UNISWAP_V3', 'ORCA'] as const;
export const COPILOT_RANGE_UNITS = ['PRICE', 'TICK'] as const;
/**
 * BUILD-BASE-001 (CopilotIntentV2 only; V1 is unchanged): catalog networks join the vocabulary (ROBINHOOD; BASE already is one), a token
 * is any catalog symbol exactly as the user wrote it (FloFi resolves it through that network's validated catalog, never the model), a
 * TRANSFER action, and catalog pools take a fee tier and the full range.
 */
/** The network registry's Copilot identifiers, plus OTHER for any network FloFi does not know. */
export const COPILOT_V2_NETWORKS = Object.freeze([...COPILOT_NETWORK_IDS, 'OTHER'] as const);
export const COPILOT_V2_RANGE_UNITS = ['PRICE', 'TICK', 'FULL', 'PERCENT'] as const;
/**
 * V2 liquidity funding the user named: SWAP_OUTPUT ("with these tokens", "com esses tokens") is a swap's actual output; REMAINING ("the remaining
 * tokens") is a reconciled execution's leftover. FloFi resolves both against its own state, never the model.
 */
export const COPILOT_FUNDING = ['SWAP_OUTPUT', 'REMAINING'] as const;
export const COPILOT_FEE_TIERS = ['0.01', '0.05', '0.3', '1'] as const;
/** The asset symbol grammar of every catalog (`ASSET_SYMBOL`), case as written: `cbBTC`, `TSLA`, `USDbC`. */
export const COPILOT_SYMBOL = /^[A-Za-z][A-Za-z0-9.]{0,15}$/;
/**
 * BUILD-BASE-001 (owner addendum): a V2 token is what the user wrote — a symbol (`COPILOT_SYMBOL`) or a whole token or company name
 * (`Tesla`, `Coinbase Wrapped BTC`, `Coca-Cola`): ASCII words separated by single spaces, at most `maxValueLength` characters. It is only
 * text to look up: FloFi resolves it in the named network's catalog (`resolveAssetReference`) and requires it in the user's own words.
 */
export const COPILOT_ASSET_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9.&'-]*(?: [A-Za-z0-9.&'-]+)*$/;
export const COPILOT_MISSING_FIELDS = ['amount', 'asset', 'network', 'sourceNetwork', 'destinationNetwork', 'protocol', 'range', 'slippage',
  'beneficiary', 'recipient'] as const;
export const COPILOT_LIMITS = Object.freeze({
  maxActions: 3, maxMessages: 6, maxUserMessageLength: 1024, maxAssistantMessageLength: 600, maxValueLength: 40,
  maxQuestionLength: 300, maxReasonLength: 300, maxOptions: 4, maxOptionLength: 60, maxOutputTextLength: 8192,
});

export type CopilotNetwork = (typeof COPILOT_V2_NETWORKS)[number];
/** A V1 token name; V2 also carries any catalog symbol or token name as written (`COPILOT_ASSET_REFERENCE`). */
export type CopilotLegacyAsset = (typeof COPILOT_ASSETS)[number];
export type CopilotAsset = CopilotLegacyAsset | (string & {});
export type CopilotRouting = (typeof COPILOT_ROUTING)[number];
export type CopilotLendingType = (typeof COPILOT_LENDING_TYPES)[number];
export type CopilotMissingField = (typeof COPILOT_MISSING_FIELDS)[number];
export type CopilotFeeTier = (typeof COPILOT_FEE_TIERS)[number];
export type CopilotSwapAction = { readonly type: 'SWAP'; readonly network: CopilotNetwork | null; readonly inputAsset: CopilotAsset | null;
  readonly outputAsset: CopilotAsset | null; readonly amount: string | null; readonly slippageBps: string | null };
/** BUILD-BASE-001 (V2): a transfer of native ETH or a catalog token on a catalog network, to the connected owner (null) or a typed address. */
export type CopilotTransferAction = { readonly type: 'TRANSFER'; readonly network: CopilotNetwork | null; readonly asset: CopilotAsset | null;
  readonly amount: string | null; readonly recipient: string | null };
export type CopilotBridgeAction = { readonly type: 'BRIDGE'; readonly sourceNetwork: CopilotNetwork | null; readonly destinationNetwork: CopilotNetwork | null;
  readonly asset: CopilotAsset | null; readonly amount: string | null; readonly slippageBps: string | null; readonly routing: CopilotRouting | null;
  readonly recipient: string | null };
export type CopilotLendingAction = { readonly type: CopilotLendingType; readonly protocol: 'AAVE_V3'; readonly network: CopilotNetwork | null;
  readonly asset: CopilotAsset | null; readonly amount: string | null; readonly beneficiary: string | null };
export type CopilotDeposit = { readonly asset: CopilotAsset; readonly maxAmount: string };
export type CopilotLiquidityAction = { readonly type: 'LIQUIDITY'; readonly protocol: (typeof COPILOT_LIQUIDITY_PROTOCOLS)[number] | null;
  readonly network: CopilotNetwork | null; readonly deposits: readonly CopilotDeposit[]; readonly rangeUnit: (typeof COPILOT_V2_RANGE_UNITS)[number] | null;
  readonly lower: string | null; readonly upper: string | null; readonly slippageBps: string | null;
  /** V2, catalog pools only: the fee tier the user named (null: Flofi's default tier). Absent in V1 intents. */ readonly feeTier?: CopilotFeeTier | null;
  /** V2: where the deposits come from, when the user said so (absent in V1 intents and recorded answers). PERCENT ranges carry the percent in `upper`. */
  readonly funding?: (typeof COPILOT_FUNDING)[number] | null };
export type CopilotAction = CopilotSwapAction | CopilotBridgeAction | CopilotLendingAction | CopilotLiquidityAction | CopilotTransferAction;
export type CopilotIntentV1 =
  | { readonly version: '1'; readonly kind: 'ACTION'; readonly action: CopilotAction }
  | { readonly version: '1'; readonly kind: 'COMPOSITION'; readonly actions: readonly CopilotAction[] }
  | { readonly version: '1'; readonly kind: 'CLARIFICATION_REQUIRED'; readonly missing: readonly CopilotMissingField[]; readonly question: string;
      readonly options: readonly string[] }
  | { readonly version: '1'; readonly kind: 'UNSUPPORTED'; readonly reason: string };
/** One turn of the bounded clarification thread sent to the interpreter. */
export type CopilotThreadMessage = { readonly role: 'user' | 'assistant'; readonly text: string };

export class CopilotIntentError extends Error {}
const fail = (code = 'COPILOT_INTENT_INVALID'): never => { throw new CopilotIntentError(code); };

/** Exactly these own, enumerable, string-keyed data properties on a plain object; nothing hidden, symbolic or inherited. */
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail();
  }
  return value as Record<string, unknown>;
}
function list(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return fail();
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  return value;
}
const oneOf = <T extends string>(values: readonly T[], value: unknown): T => (values as readonly unknown[]).includes(value) ? value as T : fail();
const nullableOneOf = <T extends string>(values: readonly T[], value: unknown): T | null => value === null ? null : oneOf(values, value);
/** Control characters (other than tab and newline) and bidirectional marks or overrides, refused in anything displayed. */
export function hasUnsafeCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f || code === 0x200e || code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return fail();
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || hasUnsafeCharacters(trimmed)) return fail();
  return trimmed;
}
const AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const SIGNED_DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const BPS = /^(0|[1-9][0-9]{0,4})$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
function pattern(value: unknown, shape: RegExp, nullable: boolean, max: number = COPILOT_LIMITS.maxValueLength): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length > max || !shape.test(value)) return fail();
  return value;
}
const amount = (value: unknown) => pattern(value, AMOUNT, true);
const bps = (value: unknown) => pattern(value, BPS, true);
const address = (value: unknown) => { const found = pattern(value, ADDRESS, true, 42); return found && found.toLowerCase(); };
const transferAddress = (value: unknown) => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : address(value);

function parseAction(value: unknown): CopilotAction {
  const type = value && typeof value === 'object' ? (value as Record<string, unknown>).type : undefined;
  if (type === 'SWAP') {
    const v = exact(value, ['type', 'network', 'inputAsset', 'outputAsset', 'amount', 'slippageBps']);
    return { type, network: nullableOneOf(COPILOT_NETWORKS, v.network), inputAsset: nullableOneOf(COPILOT_ASSETS, v.inputAsset),
      outputAsset: nullableOneOf(COPILOT_ASSETS, v.outputAsset), amount: amount(v.amount), slippageBps: bps(v.slippageBps) };
  }
  if (type === 'BRIDGE') {
    const v = exact(value, ['type', 'sourceNetwork', 'destinationNetwork', 'asset', 'amount', 'slippageBps', 'routing', 'recipient']);
    return { type, sourceNetwork: nullableOneOf(COPILOT_NETWORKS, v.sourceNetwork), destinationNetwork: nullableOneOf(COPILOT_NETWORKS, v.destinationNetwork),
      asset: nullableOneOf(COPILOT_ASSETS, v.asset), amount: amount(v.amount), slippageBps: bps(v.slippageBps),
      routing: nullableOneOf(COPILOT_ROUTING, v.routing), recipient: address(v.recipient) };
  }
  if ((COPILOT_LENDING_TYPES as readonly unknown[]).includes(type)) {
    const v = exact(value, ['type', 'protocol', 'network', 'asset', 'amount', 'beneficiary']);
    return { type: type as CopilotLendingType, protocol: oneOf(['AAVE_V3'] as const, v.protocol), network: nullableOneOf(COPILOT_NETWORKS, v.network),
      asset: nullableOneOf(COPILOT_ASSETS, v.asset), amount: amount(v.amount), beneficiary: address(v.beneficiary) };
  }
  if (type === 'LIQUIDITY') {
    const v = exact(value, ['type', 'protocol', 'network', 'deposits', 'rangeUnit', 'lower', 'upper', 'slippageBps']);
    const deposits = list(v.deposits, 2).map(item => {
      const d = exact(item, ['asset', 'maxAmount']);
      return { asset: oneOf(COPILOT_ASSETS, d.asset), maxAmount: pattern(d.maxAmount, AMOUNT, false)! };
    });
    return { type, protocol: nullableOneOf(COPILOT_LIQUIDITY_PROTOCOLS, v.protocol), network: nullableOneOf(COPILOT_NETWORKS, v.network), deposits,
      rangeUnit: nullableOneOf(COPILOT_RANGE_UNITS, v.rangeUnit), lower: pattern(v.lower, SIGNED_DECIMAL, true), upper: pattern(v.upper, SIGNED_DECIMAL, true),
      slippageBps: bps(v.slippageBps) };
  }
  return fail();
}

/** V2 token: null, OTHER, or a symbol or token name as written (grammar only; FloFi resolves it). */
const symbol = (value: unknown): CopilotAsset | null => value === null ? null : typeof value === 'string' && (value === 'OTHER' ||
  (value.length <= COPILOT_LIMITS.maxValueLength && COPILOT_ASSET_REFERENCE.test(value))) ? value : fail();
/**
 * BUILD-BASE-001: the CopilotIntentV2 action — the V1 shapes over the V2 vocabulary (catalog networks and symbols), TRANSFER, and a
 * liquidity fee tier and full range. A key a V1-shaped action omits (`feeTier`) stays omitted, so every V1-shaped action is still valid.
 */
function parseActionV2(value: unknown): CopilotAction {
  const type = value && typeof value === 'object' ? (value as Record<string, unknown>).type : undefined;
  const network = (v: unknown) => nullableOneOf(COPILOT_V2_NETWORKS, v);
  if (type === 'SWAP') {
    const v = exact(value, ['type', 'network', 'inputAsset', 'outputAsset', 'amount', 'slippageBps']);
    return { type, network: network(v.network), inputAsset: symbol(v.inputAsset), outputAsset: symbol(v.outputAsset), amount: amount(v.amount), slippageBps: bps(v.slippageBps) };
  }
  if (type === 'TRANSFER') {
    const v = exact(value, ['type', 'network', 'asset', 'amount', 'recipient']);
    return { type, network: network(v.network), asset: symbol(v.asset), amount: amount(v.amount), recipient: transferAddress(v.recipient) };
  }
  if (type === 'BRIDGE') {
    const v = exact(value, ['type', 'sourceNetwork', 'destinationNetwork', 'asset', 'amount', 'slippageBps', 'routing', 'recipient']);
    return { type, sourceNetwork: network(v.sourceNetwork), destinationNetwork: network(v.destinationNetwork), asset: symbol(v.asset), amount: amount(v.amount),
      slippageBps: bps(v.slippageBps), routing: nullableOneOf(COPILOT_ROUTING, v.routing), recipient: address(v.recipient) };
  }
  if ((COPILOT_LENDING_TYPES as readonly unknown[]).includes(type)) {
    const v = exact(value, ['type', 'protocol', 'network', 'asset', 'amount', 'beneficiary']);
    return { type: type as CopilotLendingType, protocol: oneOf(['AAVE_V3'] as const, v.protocol), network: network(v.network), asset: symbol(v.asset),
      amount: amount(v.amount), beneficiary: address(v.beneficiary) };
  }
  if (type === 'LIQUIDITY') {
    const keys = ['type', 'protocol', 'network', 'deposits', 'rangeUnit', 'lower', 'upper', 'slippageBps'];
    const has = (key: string) => !!value && typeof value === 'object' && Object.hasOwn(value, key);
    const withTier = has('feeTier'), withFunding = has('funding');
    const v = exact(value, [...keys, ...withTier ? ['feeTier'] : [], ...withFunding ? ['funding'] : []]);
    const deposits = list(v.deposits, 2).map(item => {
      const d = exact(item, ['asset', 'maxAmount']);
      return { asset: symbol(d.asset) ?? fail(), maxAmount: pattern(d.maxAmount, AMOUNT, false)! };
    });
    return { type, protocol: nullableOneOf(COPILOT_LIQUIDITY_PROTOCOLS, v.protocol), network: network(v.network), deposits,
      rangeUnit: nullableOneOf(COPILOT_V2_RANGE_UNITS, v.rangeUnit), lower: pattern(v.lower, SIGNED_DECIMAL, true), upper: pattern(v.upper, SIGNED_DECIMAL, true),
      slippageBps: bps(v.slippageBps), ...withTier ? { feeTier: nullableOneOf(COPILOT_FEE_TIERS, v.feeTier) } : {},
      ...withFunding ? { funding: nullableOneOf(COPILOT_FUNDING, v.funding) } : {} };
  }
  return fail();
}

/** Strict validation of one intent. Throws `CopilotIntentError` with a closed code; never repairs or guesses. */
export function parseCopilotIntent(value: unknown): CopilotIntentV1 {
  const kind = value && typeof value === 'object' ? (value as Record<string, unknown>).kind : undefined;
  if (kind === 'ACTION') {
    const v = exact(value, ['version', 'kind', 'action']);
    oneOf([COPILOT_INTENT_VERSION], v.version);
    return { version: '1', kind, action: parseAction(v.action) };
  }
  if (kind === 'COMPOSITION') {
    const v = exact(value, ['version', 'kind', 'actions']);
    oneOf([COPILOT_INTENT_VERSION], v.version);
    if (Array.isArray(v.actions) && v.actions.length > COPILOT_LIMITS.maxActions) return fail('COPILOT_TOO_MANY_ACTIONS');
    const actions = list(v.actions, COPILOT_LIMITS.maxActions).map(parseAction);
    if (actions.length < 2) return fail();
    return { version: '1', kind, actions };
  }
  if (kind === 'CLARIFICATION_REQUIRED') {
    const v = exact(value, ['version', 'kind', 'missing', 'question', 'options']);
    oneOf([COPILOT_INTENT_VERSION], v.version);
    const missing = list(v.missing, COPILOT_MISSING_FIELDS.length).map(item => oneOf(COPILOT_MISSING_FIELDS, item));
    if (new Set(missing).size !== missing.length) return fail();
    return { version: '1', kind, missing, question: text(v.question, COPILOT_LIMITS.maxQuestionLength),
      options: list(v.options, COPILOT_LIMITS.maxOptions).map(option => text(option, COPILOT_LIMITS.maxOptionLength)) };
  }
  if (kind === 'UNSUPPORTED') {
    const v = exact(value, ['version', 'kind', 'reason']);
    oneOf([COPILOT_INTENT_VERSION], v.version);
    return { version: '1', kind, reason: text(v.reason, COPILOT_LIMITS.maxReasonLength) };
  }
  return fail();
}
/** The structured-output root: `{ "intent": … }` (strict mode requires an object root). */
export function parseCopilotOutput(value: unknown): CopilotIntentV1 {
  return parseCopilotIntent(exact(value, ['intent']).intent);
}

/**
 * Model prose (question, option, reason) is displayed only as plain, labelled text and only when it carries no
 * link, no hex string or address and no claim of execution; otherwise the caller substitutes deterministic copy.
 */
export function safeCopilotProse(value: string): string | null {
  if (/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|0x[0-9a-f]{6,}|[1-9A-HJ-NP-Za-km-z]{32,})/i.test(value)) return null;
  if (/\b(?:executed|executad[oa]s?|broadcast(?:ed)?|signed|assinad[oa]s?)\b|\b(?:has|have|was|were) been (?:sent|submitted|transferred|approved|confirmed)\b|\b(?:foi|foram) (?:enviad|transferid|aprovad|confirmad)/i
    .test(value)) return null;
  return value;
}

// Strict structured-output schema for the model. Only conservative keywords are used; lengths, patterns and counts
// are enforced by the parser above, never trusted from the model.
const string = (description: string) => ({ type: 'string', description });
const nullableString = (description: string) => ({ type: ['string', 'null'], description });
const constant = (value: string) => ({ type: 'string', enum: [value] });
const choice = (values: readonly string[], description: string) => ({ type: 'string', enum: [...values], description });
const nullableChoice = (values: readonly string[], description: string) => ({ anyOf: [{ type: 'string', enum: [...values] }, { type: 'null' }], description });
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const AMOUNT_TEXT = 'Exactly the number the user wrote, digits with "." as decimal separator; null if not stated.';
const SLIPPAGE_TEXT = 'Maximum slippage in basis points only if the user stated it (0.5% = "50"); null otherwise.';
const NETWORK_TEXT = 'Network the user named; ETHEREUM for Ethereum without "Sepolia" (including Ethereum Mainnet); OTHER for any network not listed; null if not named.';
const ASSET_TEXT = 'Token the user named: ETH for ether, WETH only if the user said WETH; OTHER if not listed; null if not named.';
const ADDRESS_TEXT = 'A 0x address only if the user typed it exactly; null otherwise (the connected wallet is used).';
const actionSchemas = [
  object({ type: constant('SWAP'), network: nullableChoice(COPILOT_NETWORKS, NETWORK_TEXT), inputAsset: nullableChoice(COPILOT_ASSETS, ASSET_TEXT),
    outputAsset: nullableChoice(COPILOT_ASSETS, ASSET_TEXT), amount: nullableString(AMOUNT_TEXT), slippageBps: nullableString(SLIPPAGE_TEXT) }),
  object({ type: constant('BRIDGE'), sourceNetwork: nullableChoice(COPILOT_NETWORKS, NETWORK_TEXT), destinationNetwork: nullableChoice(COPILOT_NETWORKS, NETWORK_TEXT),
    asset: nullableChoice(COPILOT_ASSETS, ASSET_TEXT), amount: nullableString(AMOUNT_TEXT), slippageBps: nullableString(SLIPPAGE_TEXT),
    routing: nullableChoice(COPILOT_ROUTING, 'Provider preference only if the user named LI.FI or Across; null otherwise.'),
    recipient: nullableString(ADDRESS_TEXT) }),
  object({ type: choice(COPILOT_LENDING_TYPES, 'Aave V3 operation.'), protocol: constant('AAVE_V3'), network: nullableChoice(COPILOT_NETWORKS, NETWORK_TEXT),
    asset: nullableChoice(COPILOT_ASSETS, ASSET_TEXT), amount: nullableString(AMOUNT_TEXT),
    beneficiary: nullableString(ADDRESS_TEXT + ' Always null for WITHDRAW.') }),
  object({ type: constant('LIQUIDITY'), protocol: nullableChoice(COPILOT_LIQUIDITY_PROTOCOLS, 'Pool protocol only if the user named it; null otherwise.'),
    network: nullableChoice(COPILOT_NETWORKS, NETWORK_TEXT),
    deposits: { type: 'array', description: 'Maximum amount of each token the user named (at most 2).',
      items: object({ asset: choice(COPILOT_ASSETS, ASSET_TEXT), maxAmount: string(AMOUNT_TEXT) }) },
    rangeUnit: nullableChoice(COPILOT_RANGE_UNITS, 'PRICE for a price range (quote token per base token), TICK for tick indexes; null if not stated.'),
    lower: nullableString('Lower range bound exactly as written; null if not stated.'), upper: nullableString('Upper range bound exactly as written; null if not stated.'),
    slippageBps: nullableString(SLIPPAGE_TEXT) }),
];
/** BUILD-BASE-001: the V2 action schemas (catalog networks and symbols, TRANSFER, fee tier and full range). */
const NETWORK_V2_TEXT = 'Network the user named; BASE and ROBINHOOD (Robinhood Chain) are real-funds mainnets; ETHEREUM for Ethereum without "Sepolia" (including ' +
  'Ethereum Mainnet); OTHER for any network not listed; null if not named.';
const SYMBOL_TEXT = 'The token exactly as the user wrote it: its symbol (USDC, WETH, cbBTC, TSLA, USDG) or its token or company name (Tesla, Apple, ' +
  'Coinbase Wrapped BTC), without words such as stock, shares, ações or token; ETH for ether. OTHER only if the user described a token without naming it ' +
  '("that car company"); null if not named. Never translate a name into a symbol the user did not write: Flofi resolves names and symbols in the network\'s official catalog.';
const nullableSymbol = nullableString(SYMBOL_TEXT);
const actionSchemasV2 = [
  object({ type: constant('SWAP'), network: nullableChoice(COPILOT_V2_NETWORKS, NETWORK_V2_TEXT), inputAsset: nullableSymbol, outputAsset: nullableSymbol,
    amount: nullableString(AMOUNT_TEXT), slippageBps: nullableString(SLIPPAGE_TEXT) }),
  object({ type: constant('TRANSFER'), network: nullableChoice(COPILOT_V2_NETWORKS, NETWORK_V2_TEXT), asset: nullableSymbol, amount: nullableString(AMOUNT_TEXT),
    recipient: nullableString('The recipient wallet the user typed: EVM 0x address or case-sensitive Solana base58 public key. Solana requires an explicit recipient; null if missing.') }),
  object({ type: constant('BRIDGE'), sourceNetwork: nullableChoice(COPILOT_V2_NETWORKS, NETWORK_V2_TEXT), destinationNetwork: nullableChoice(COPILOT_V2_NETWORKS, NETWORK_V2_TEXT),
    asset: nullableSymbol, amount: nullableString(AMOUNT_TEXT), slippageBps: nullableString(SLIPPAGE_TEXT),
    routing: nullableChoice(COPILOT_ROUTING, 'Provider preference only if the user named LI.FI or Across; null otherwise.'),
    recipient: nullableString(ADDRESS_TEXT) }),
  object({ type: choice(COPILOT_LENDING_TYPES, 'Aave V3 operation.'), protocol: constant('AAVE_V3'), network: nullableChoice(COPILOT_V2_NETWORKS, NETWORK_V2_TEXT),
    asset: nullableSymbol, amount: nullableString(AMOUNT_TEXT), beneficiary: nullableString(ADDRESS_TEXT + ' Always null for WITHDRAW.') }),
  object({ type: constant('LIQUIDITY'), protocol: nullableChoice(COPILOT_LIQUIDITY_PROTOCOLS, 'Pool protocol only if the user named it; null otherwise.'),
    network: nullableChoice(COPILOT_V2_NETWORKS, NETWORK_V2_TEXT),
    deposits: { type: 'array', description: 'Maximum amount of each token the user named (at most 2).', items: object({ asset: string(SYMBOL_TEXT), maxAmount: string(AMOUNT_TEXT) }) },
    rangeUnit: nullableChoice(COPILOT_V2_RANGE_UNITS, 'PRICE for a price range (quote token per base token), TICK for tick indexes, FULL for "full range", ' +
      'PERCENT for a range of plus or minus a percentage around the current pool price ("a 10% range": upper "10", lower null); null if not stated.'),
    lower: nullableString('Lower range bound exactly as written; null if not stated.'), upper: nullableString('Upper range bound exactly as written; null if not stated.'),
    slippageBps: nullableString(SLIPPAGE_TEXT),
    feeTier: nullableChoice(COPILOT_FEE_TIERS, 'Pool fee tier in percent only if the user named it (0.01, 0.05, 0.3 or 1); null otherwise.'),
    funding: nullableChoice(COPILOT_FUNDING, 'SWAP_OUTPUT when the user funds the position with a swap\'s tokens ("with these tokens", "with the swapped devUSDC", ' +
      '"com esses tokens"); REMAINING for "the remaining tokens" / "o que sobrou"; null otherwise. Leave that token\'s deposit out unless the user named a cap.') }),
];
export const COPILOT_OUTPUT_SCHEMA = Object.freeze(object({ intent: { anyOf: [
  object({ version: constant('1'), kind: constant('ACTION'), action: { anyOf: actionSchemas } }),
  object({ version: constant('1'), kind: constant('COMPOSITION'),
    actions: { type: 'array', description: 'Two or three dependent steps in order.', items: { anyOf: actionSchemas } } }),
  object({ version: constant('1'), kind: constant('CLARIFICATION_REQUIRED'), missing: { type: 'array', items: choice(COPILOT_MISSING_FIELDS, 'Missing field.') },
    question: string('One short question in the user\'s language.'), options: { type: 'array', description: 'Up to 4 short answer options.', items: string('Option.') } }),
  object({ version: constant('1'), kind: constant('UNSUPPORTED'), reason: string('One short sentence in the user\'s language.') }),
] } }));

/** BUILD-COPILOT-002: the V1 building blocks that CopilotIntentV2 reuses unchanged (same checks, same closed error codes). */
export const COPILOT_V1_PARTS = Object.freeze({
  exact, list, oneOf, nullableOneOf, text, amount, bps, address, transferAddress, parseAction, signedDecimal: (value: unknown) => pattern(value, SIGNED_DECIMAL, true),
  depositAmount: (value: unknown) => pattern(value, AMOUNT, false)!, fail, symbol, parseActionV2,
  schema: Object.freeze({ string, nullableString, constant, choice, nullableChoice, object, actions: actionSchemas, actionsV2: actionSchemasV2, symbolText: SYMBOL_TEXT,
    networkV2Text: NETWORK_V2_TEXT }),
});
