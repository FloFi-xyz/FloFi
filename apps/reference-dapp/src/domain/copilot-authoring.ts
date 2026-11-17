// SPDX-License-Identifier: AGPL-3.0-only
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import { parseLocalCommand, type Command } from './commands';
import type { Workflow } from './initial-workflow';
import { ROUTER_DEFAULT_SLIPPAGE, ROUTER_NETWORK_OPTIONS } from './router-authoring';
import { formatTokenAmount } from './jupiter-authoring';
import { DEFAULT_SLIPPAGE } from './slippage-policy';
import { UNISWAP_LIQUIDITY_DEFAULT_SLIPPAGE } from './uniswap-liquidity-authoring';
import { ROBINHOOD_LIQUIDITY_DEFAULT_SLIPPAGE } from './robinhood-liquidity-authoring';
import { SOLANA_LIQUIDITY_DEFAULT_SLIPPAGE } from './solana-liquidity-authoring';
import type { SolanaSwapInput } from './jupiter-authoring';
import { priceBoundsAround } from './pool-price-bounds';
import { catalogPercentRange, catalogPoolView, catalogPriceRange, catalogTickRange, orcaPercentRange, orcaPriceRange, orcaTickRange, ORCA_MAINNET_POOL, poolMissing, poolRetryable,
  poolReadFor, percentValue, type CatalogPoolView, type PoolPriceRead, type PoolRef, type ResolvedRange } from './pool-range';
import { COPILOT_FEE_TIERS, COPILOT_LIMITS, CopilotIntentError, parseCopilotIntent, safeCopilotProse, type CopilotAction, type CopilotAsset, type CopilotBridgeAction,
  type CopilotLegacyAsset, type CopilotLendingAction, type CopilotLiquidityAction, type CopilotMissingField, type CopilotNetwork, type CopilotSwapAction,
  type CopilotTransferAction } from './copilot-intent';
import { copilotCopy, type CopilotCopy, type CopilotLanguage, type NetworkSubject, type Subject } from './copilot-messages';
import { AAVE_V3_AMOUNT_POLICY, assetDisplayName, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY, solanaTransferAsset, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { solanaTransferProfileFor } from './solana-transfer-authoring';
import { copilotNetworksFor, lendingOffers, routeLabels, type StrategyAction } from './authoring-capabilities';
import { lendingProfileFor, lendingReservesFor } from './supply-authoring';
import type { PendingAgentCapability } from './agent-rollout';
import { solanaDisplayCatalogLoaded } from './solana-asset-catalog';
import { destinationAmounts, explicitInputAsset, explicitOutputAsset, groundExplicitAssets, withoutDestinationAmounts, type DestinationAmount } from './copilot-asset-intent';
import { resolveAssetReference } from './asset-catalogs';
import { COPILOT_NETWORK_IDS, copilotNetworksMentioned, catalogNetworkOfChatName, networkIdentity, networkOfCopilot, type CopilotNetworkId } from './network-registry';
import { routerNetworksOf } from './router-authoring';
import { checkRecipient } from './recipient-address';
import { defaultUniversalOutput, resolveUniversalAsset, universalAssetReference, universalChatSentence, UNIVERSAL_CANVAS_LABEL, universalCanvasPair, type UniversalBridgeRouting } from './universal-bridge-authoring';
import { isSolanaPublicKey, UNIVERSAL_NETWORKS, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
import { lexiconAssets, lexiconNamedNetworkIds, lexiconNetworks, targetEnvironment, type LexiconEntry } from './copilot-lexicon';
import { fiatCandidates, fiatReference, lookupAsset } from './intelligence/asset-resolution';
import { activeNetworkScope, TEST_NETWORK_NOT_AVAILABLE } from './network-scope';
import { intelligenceCopy } from './intelligence/copy';

/**
 * BUILD-COPILOT-001: the deterministic boundary between an untrusted AI intent and the existing authoring path.
 * An intent becomes a proposal only by rendering one canonical exact-grammar sentence from validated, grounded fields
 * and parsing it with `parseLocalCommand`, so the Copilot can never author anything a user could not type.
 * Grounding: every amount, slippage, range bound and address must appear in the user's own words; every asset must be
 * named; a mainnet must be named explicitly with no test-network wording. Anything else becomes a clarification.
 *
 * BUILD-COPILOT-002: the planners take a grounding context. Besides the open request's text it may name fields whose
 * values Flofi itself carried from a resolved referent (a canonical step, the visible pending proposal or an earlier
 * proposal); those values have deterministic provenance and skip the text check, and nothing else does. It also selects
 * the reply language and whether a network may default (V1) or must be asked for (V2).
 */
export type CopilotAuthoringMissing = CopilotMissingField | 'inputAsset' | 'outputAsset';
export type CopilotOutcome =
  | { readonly kind: 'PROPOSAL'; readonly command: Command; readonly sentence: string; readonly notes: readonly string[] }
  | { readonly kind: 'CLARIFICATION'; readonly missing: readonly CopilotAuthoringMissing[]; readonly question: string; readonly options: readonly string[];
      /** PR B: the pool token whose maximum the question asks for, so a bare amount can answer it. */ readonly deposit?: string;
      /** BUILD-P1: a closed code for what is missing (analytics only), and the pool whose price FloFi must read before it can continue. */
      readonly code?: string; readonly pool?: PoolRef }
  | { readonly kind: 'UNSUPPORTED'; readonly message: string; readonly missing?: readonly CopilotAuthoringMissing[]; readonly code?: string }
  | { readonly kind: 'REJECTED'; readonly code: string; readonly message: string; readonly missing?: readonly CopilotAuthoringMissing[] };
export type CopilotConversion = { readonly userText: string; readonly workflow: Workflow; readonly context: ReviewContext; readonly wallet: string | null };
export const COPILOT_AUTOMATION_AUTHORING_INTENT = 'AUTOMATION' as const;
/** Automation authoring uses a separate typed draft, never a workflow/execution Command. */
/** The only Command types an AI interpretation can produce: new authoring proposals, never edits, removals or execution. */
export const COPILOT_AUTHORING_COMMANDS = Object.freeze(['ADD_SWAP', 'ADD_TESTNET_SWAP', 'ADD_ETHEREUM_SEPOLIA_SWAP', 'ADD_SOLANA_SWAP', 'ADD_ROUTER_BRIDGE', 'ADD_SUPPLY', 'ADD_BORROW',
  'ADD_REPAY', 'ADD_WITHDRAW', 'ADD_UNISWAP_LIQUIDITY', 'ADD_SOLANA_LIQUIDITY', 'AUTHOR_LENDING',
  // BUILD-BASE-001: catalog-network swaps and positions (the Canvas action command) and catalog-network transfers, as the exact grammar authors them.
  'ADD_CRYPTO_ACTION', 'ADD_RH_TRANSFER',
  // BUILD-CROSSCHAIN-UNIVERSAL-001: the universal bridge between the five mainnets.
  'ADD_UNIVERSAL_BRIDGE',
  // PR B: a Solana Devnet swap's output funding an Orca position, added and linked exactly as the Canvas does.
  'ADD_SOLANA_COMPOSITION'] as const);
export type CopilotAuthoringCommand = (typeof COPILOT_AUTHORING_COMMANDS)[number];
export const COPILOT_CAPABILITIES = copilotCopy('EN').capabilities;

/**
 * How the planners treat unstated networks and which language they reply in. `catalog` (BUILD-BASE-001, CopilotIntentV2): the catalog networks
 * (Base, Robinhood Chain) with their catalog tokens, transfers, Base mainnet Aave and every Router route; V1 keeps its original vocabulary.
 */
export type PlanningPolicy = { readonly language: CopilotLanguage; readonly networkDefaults: boolean; readonly catalog?: boolean;
  /** Tests only: approved agent rollouts (audit A9). Product planning uses `AGENT_ROLLOUT_APPROVED`. */
  readonly agentRollout?: readonly PendingAgentCapability[] };
export const V1_POLICY: PlanningPolicy = Object.freeze({ language: 'EN', networkDefaults: true });
/** A field whose value Flofi carried from a resolved referent rather than read from the open request. */
export type CarriedField = 'network' | 'sourceNetwork' | 'destinationNetwork' | 'inputAsset' | 'outputAsset' | 'asset' | 'amount' | 'supplyAmount' | 'borrowAmount'
  | 'slippage' | 'recipient' | 'beneficiary' | 'routing' | 'protocol' | 'range' | 'feeTier' | `deposit:${string}` | `asset:${string}`;
/**
 * The swap whose actual output funds a position ("with these tokens"), resolved by FloFi from its own state: a swap proposal not yet applied (it is
 * authored again with the position) or an existing swap step (the position links to it).
 */
export type SwapSource = { readonly kind: 'NEW'; readonly input: SolanaSwapInput } | { readonly kind: 'STEP'; readonly nodeId: string; readonly input: SolanaSwapInput };
export type Grounding = { readonly text: string; readonly carried: ReadonlySet<CarriedField>; readonly policy: PlanningPolicy;
  /** V2: the latest user message alone, so an explicit answer to Flofi's own question can settle a choice the request left open. */
  readonly latest?: string;
  /** V2: verified Solana Devnet context FloFi read itself — the Orca pool price for percentage ranges, and the swap a position may be funded by. */
  readonly solana?: { readonly price: string | null; readonly swap: SwapSource | null };
  /**
   * BUILD-P1 pool conversational reliability: pool prices the surface read for this turn (`pool-range.ts`), whether it can read one on request
   * (the web chat: a question carrying `pool` makes it read that pool and replay the turn), and the time the reads are judged fresh against.
   * A mainnet range is never computed from any other price (never Devnet's, never the model's).
   */
  readonly pools?: readonly PoolPriceRead[]; readonly poolReads?: boolean; readonly now?: number;
  /**
   * BUILD-CHAT-LEARNING-001: learned vocabulary (`copilot-lexicon.ts`). It only widens which networks and tokens the user *named*: the user's
   * own meanings (this conversation's, or saved for their verified identity) name networks and tokens; FloFi's reviewed glossary names test
   * networks only. It never grounds an amount, a slippage, a range, a fee or an address.
   */
  readonly lexicon?: readonly LexiconEntry[];
  /**
   * BUILD-FLOFI-INTELLIGENCE-001: false for the steps of a goal plan. Their assets were grounded per goal field; a role read from the whole message
   * ("to Aave", "receive SOL") describes the goal, not each step, so it must not overwrite a step's own planned asset.
   */
  readonly explicitAssets?: boolean;
  /**
   * BUILD-FLOFI-UX-FIX-003: the request is a new action (not an edit or repeat of a step), so an amount written after "to"/"receive" ("bridge ETH to
   * 1 USDC") is what the user wants to receive. Absent: no destination-amount reading (edits, V1, goal steps).
   */
  readonly receiving?: boolean;
  /**
   * BUILD-FLOFI-UNIFIED-COPILOT-001: public addresses FloFi itself resolved from a Saved Recipient the user named exactly in this request
   * (`saved-recipients.ts`). They ground a destination like a typed address (and are re-checked for the network like one); nothing else.
   */
  readonly saved?: readonly string[];
  /**
   * BUILD-P1: the bare number the user answered to FloFi's own percentage question ("10" after "Which percentage…?"), read by FloFi itself. It is the
   * only way a number without "%" grounds a percentage; a bare number answering any other question never does.
   */
  readonly answeredPercent?: string;
  /** BUILD-P1: FloFi already asked this request for its range (COPILOT_RANGE_REQUIRED): only the answer decides whether a range was written. */
  readonly rangeAsked?: boolean };
const NOTHING_CARRIED: ReadonlySet<CarriedField> = new Set();
const ORCA_WHIRLPOOLS_MAINNET_TICK_SPACING = ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY.pool.tickSpacing;

type Network = Exclude<CopilotNetwork, 'OTHER'>;
// BUILD-BASE-001: the network vocabulary (identifiers, names, environment, family, how a message names a network) is the network registry's.
type Family = string;
const NETWORK_IDS: readonly Network[] = COPILOT_NETWORK_IDS;
const FAMILY: Readonly<Record<Network, Family>> = Object.freeze(Object.fromEntries(NETWORK_IDS.map(id => [id, networkOfCopilot(id).family])) as Record<Network, Family>);
/** Display labels from the network registry (Base, Arbitrum One, Robinhood Chain, …). */
export const COPILOT_NETWORK_LABEL: Readonly<Record<Network, string>> = Object.freeze(Object.fromEntries(NETWORK_IDS.map(id => [id, networkOfCopilot(id as CopilotNetworkId).name])) as
  Record<Network, string>);
// Explicit Ethereum names ground Mainnet; Sepolia/test wording never grants Mainnet authority.
// BUILD-BASE-001: real-funds networks come from the network registry (Base, Arbitrum One, Ethereum, Solana, Robinhood Chain).
const MAINNETS: ReadonlySet<CopilotNetwork> = new Set(NETWORK_IDS.filter(id => networkOfCopilot(id as CopilotNetworkId).environment === 'MAINNET'));
/** The catalog networks (official asset catalog) and their CAIP-2 chains. */
const isCatalogNetwork = (network: Network) => networkOfCopilot(network as CopilotNetworkId).catalog;
/**
 * BUILD-BASE-001 (owner addendum): where an action can be authored comes from the shared capability truth (`authoring-capabilities.ts`),
 * never from a Copilot list. CopilotIntent V1 is a frozen protocol that cannot name catalog tokens: on a catalog network it keeps only the
 * one action it always expressed, the BUILD-002 Base USDC ⇄ WETH reference swap.
 */
const V1_REFERENCE_SWAP: Network = 'BASE';
function actionNetworks(action: StrategyAction, g: Grounding): Network[] {
  return copilotNetworksFor(action, g.policy.agentRollout).filter(id => g.policy.catalog === true || !isCatalogNetwork(id) || (action === 'swap' && id === V1_REFERENCE_SWAP));
}
const chainOf = (network: Network) => networkOfCopilot(network as CopilotNetworkId).chain;
// Any test-network or test-token wording rules out a mainnet (real funds) interpretation.
export const TESTNET_WORDS = /\b(?:sepolia|devnet|testnets?|test\s?net(?:work)?|test\s+(?:usdc|tokens?|funds?|sol|eth)|dev\s?usdc|teste|testes|de\s+teste)\b/i;
const ASSET_MENTIONS: Readonly<Record<Exclude<CopilotLegacyAsset, 'OTHER'>, RegExp>> = {
  // `\busdc` does not match inside "devUSDC": there is no word boundary between "v" and "U".
  USDC: /\busdc\b/i, DEVUSDC: /\b(?:dev\s?usdc|test\s?usdc)\b/i, WETH: /\bw?eth\b|\bether\b/i, ETH: /\bw?eth\b|\bether\b/i,
  SOL: /\bsol\b/i, USDT: /\b(?:usdt|tether)\b/i, WBTC: /\bwbtc\b/i,
};

/** P0 hotfix (FIX 1): native ETH on a catalog network is grounded only by the user's own "ETH"/"ether" — "WETH" is a different asset and never
 * makes a model-reported ETH native (`ASSET_MENTIONS.ETH` also accepts "weth", for the test networks' WETH-only swaps). */
const NATIVE_ETH_WORDS = /\beth\b|\bether\b/i;
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: people also name the coin by its network's name ("trocar ethereum por usdc na arbitrum", "swap ethereum to
 * usdc on arbitrum one"). "Ethereum" is the coin only in a coin position: after an amount ("1 ethereum"), after a trade verb ("swap/trocar
 * (o) ethereum"), or before "por/for/to/into <token>". Anywhere else it is the network. A coin-position "ethereum" never names the Ethereum
 * network (`mentionedNetworks` removes it), so "trocar 1 ethereum por usdc" still asks which network: one word never grounds both.
 */
const COIN_VERBS = String.raw`(?:swap|trade|buy|sell|convert|exchange|troca|trocar|troque|compra|comprar|compre|vende|vender|venda|converte|converter|converta)`;
const ETHEREUM_AS_COIN_SOURCE = String.raw`(?:(?<=\b\d[\d.,]*\s*)|(?<=\b${COIN_VERBS}\s+(?:(?:o|a|os|as|my|meu|meus|minha|the|all|todo|tudo|some|um|uma)\s+)?))ethereum\b`
  + String.raw`|(?<!\b(?:on|in|at|na|no|em|from|da|do|de|to|para|pra|network|rede|chain|mainnet)\s+(?:(?:the|a|o)\s+)?)`
  + String.raw`\bethereum(?=\s+(?:por|for|to|into|em|pra|para)\s+(?:usdc(?:\.e)?|usdt|weth|wbtc|btc|sol|dai|arb|eth|ether)\b)`;
const ETHEREUM_AS_COIN = new RegExp(ETHEREUM_AS_COIN_SOURCE, 'i');
const ETHEREUM_AS_COIN_ALL = new RegExp(ETHEREUM_AS_COIN_SOURCE, 'gi');
const NATIVE_ETH_NAMED = { test: (text: string) => NATIVE_ETH_WORDS.test(text) || ETHEREUM_AS_COIN.test(text) };
/** WETH as people write it ("weth", "w-eth", "wrapped ether"): removed before native ETH is looked for (its catalog name "Ether" is inside it). */
const WRAPPED_ETH_WORDS = /\bweth\b|\bw[\s-]+eth\b|\bwrapped[\s-]+eth(?:er)?\b/gi;
/** Networks the user named, in any language that uses the network names (each by its network registry `mention`). */
export function mentionedNetworks(raw: string): Network[] {
  const text = raw.replace(ETHEREUM_AS_COIN_ALL, ' ');
  return copilotNetworksMentioned(text).filter(id => {
    const identity = networkOfCopilot(id);
    // Catalog names can equal a chain alias (ARB is named Arbitrum). Asset context alone cannot choose a mainnet.
    const collision = identity.catalog && [identity.name, ...identity.aliases].some(label => resolveAssetReference(identity.chain, label).kind === 'FOUND');
    if (!collision || !identity.chatName) return true;
    const explicit = new RegExp(`(?:^|\\b(?:on|na|no|da|de|do|from|to|para|network|rede|chain)\\s+(?:(?:the|a|o)\\s+)?)(?:${identity.chatName.source})(?![A-Za-z0-9])`, 'im');
    return explicit.test(text);
  });
}
/** BUILD-CHAT-LEARNING-001: networks the user named — by the registry's own names, or through a lexicon term allowed to ground one. */
function namedNetworks(g: Grounding): Network[] {
  const named = mentionedNetworks(g.text);
  if (!g.lexicon?.length) return named;
  return [...new Set([...named, ...lexiconNamedNetworkIds(g.text, g.lexicon).filter((id): id is Network => Object.hasOwn(FAMILY, id))])];
}
/** Test-network wording, including a lexicon term for a test network ("arb sep"): it rules out a real-funds reading just like "Sepolia". */
const testWording = (g: Grounding): boolean => TESTNET_WORDS.test(g.text) ||
  (!!g.lexicon?.length && lexiconNetworks(g.text, g.lexicon).some(match => targetEnvironment(match.entry.target) === 'TESTNET'));
/** A pinned token the user named through their own (session or saved) term, e.g. "dólar digital" for USDC. */
const lexiconNamesAsset = (g: Grounding, value: string): boolean =>
  !!g.lexicon?.length && lexiconAssets(g.text, g.lexicon).some(match => match.asset === value.toUpperCase());
export const canonicalDecimal = (value: string): string => {
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return whole!.replace(/^0+(?=\d)/, '') + (trimmed ? '.' + trimmed : '');
};
/**
 * Every exact reading of one written number: 1.5 / 1,5 as decimals, 1,000 / 1.000 as grouped thousands, 1,000.50 and 1.000,50.
 * BUILD-FLOFI-INTELLIGENCE-001: a thousands group never starts a number with 0 — "0.001" and "0,005" are decimals only, never 1 or 5.
 */
export function amountReadings(token: string): string[] {
  const out: string[] = [];
  if (/^\d+(?:\.\d+)?$/.test(token)) out.push(token);
  if (/^\d+,\d+$/.test(token)) out.push(token.replace(',', '.'));
  if (/^[1-9]\d{0,2}(?:\.\d{3})+$/.test(token) || /^[1-9]\d{0,2}(?:,\d{3})+$/.test(token)) out.push(token.replace(/[.,]/g, ''));
  if (/^[1-9]\d{0,2}(?:,\d{3})+\.\d+$/.test(token)) out.push(token.replace(/,/g, ''));
  if (/^[1-9]\d{0,2}(?:\.\d{3})+,\d+$/.test(token)) out.push(token.replace(/\./g, '').replace(',', '.'));
  return [...new Set(out.map(canonicalDecimal))];
}
type Reading = { readonly value: string; readonly negative: boolean; readonly percent: boolean };
function numbersIn(text: string): Reading[] {
  // Digits inside addresses and other hex strings are not amounts.
  const clean = text.replace(/0x[0-9a-f]*/gi, ' ');
  const out: Reading[] = [];
  for (const match of clean.matchAll(/(?<![A-Za-z0-9_.,])\d(?:[\d.,]*\d)?/g)) {
    const before = clean[match.index - 1], after = clean.slice(match.index + match[0].length);
    for (const value of amountReadings(match[0])) out.push({ value, negative: before === '-' || before === '−', percent: /^\s?%/.test(after) });
  }
  return out;
}
export function groundedAmount(text: string, value: string): boolean {
  const wanted = canonicalDecimal(value);
  return numbersIn(text).some(reading => reading.value === wanted);
}
export function groundedSigned(text: string, value: string): boolean {
  const negative = value.startsWith('-'), wanted = canonicalDecimal(negative ? value.slice(1) : value);
  return numbersIn(text).some(reading => reading.value === wanted && reading.negative === negative);
}
const percentToBps = (value: string): string | null => {
  const [whole, fraction = ''] = value.split('.');
  return fraction.length > 2 ? null : String(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')));
};
/**
 * Basis points written as such ("50 bps", "slippage 50") or as a percentage ("0.5%"), only when the user mentions slippage at all.
 * BUILD-P1 (`strict`, liquidity): only a number written as bps or next to a slippage word ("slippage 1%", "0.5% max slippage"): a position's range
 * band ("±5%") or a deposit amount ("500 USDC") never grounds a slippage the interpreter reported.
 */
export function groundedBps(text: string, value: string, strict = false): boolean {
  if (!/slippage|slip|bps|basis\s+points?|pontos?\s+base|deslizamento|toler|%/i.test(text)) return false;
  if (strict) return slippageWritten(text, value);
  return numbersIn(text).some(reading => !reading.negative && (reading.value === value || (reading.percent && percentToBps(reading.value) === value)));
}
const SLIPPAGE_WORD = String.raw`(?:slippage|slip|deslizamento|derrapagem|toler(?:ance|[aâ]ncia))`;
/** What may stand between a slippage word and its value: "slippage of up to 0.5%", "max slippage: 50 bps", "deslizamento de até 0,5%". */
const SLIPPAGE_GAP = String.raw`(?:\s*(?:(?:of|de|do|da|at|em|is|é|max(?:imum)?|m[aá]xim[oa]|up to|até|at most|no m[aá]ximo|tolerance|toler[aâ]ncia)(?![\p{L}])|[:=]))*\s*`;
const BPS_UNIT = String.raw`(?:bps|bp|basis\s+points?|pontos?\s+(?:de\s+)?base)`;
const SLIPPAGE_FORMS = [
  new RegExp(String.raw`${SLIPPAGE_WORD}${SLIPPAGE_GAP}(\d+(?:[.,]\d+)?)\s*(%|${BPS_UNIT})?`, 'giu'),
  new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*(%|${BPS_UNIT})?\s*(?:(?:of|de)\s+)?(?:(?:max(?:imum)?|m[aá]xim[oa])\s+)?(?:de\s+)?${SLIPPAGE_WORD}`, 'giu'),
  new RegExp(String.raw`(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(${BPS_UNIT})(?![\p{L}])`, 'giu'),
];
function slippageWritten(text: string, value: string): boolean {
  const own = withoutExamples(text);
  return SLIPPAGE_FORMS.some(form => [...own.matchAll(form)].some(match => {
    const written = canonicalDecimal(match[1]!.replace(',', '.')), percent = match[2] === '%';
    return (percent ? percentToBps(written) : /^\d+$/.test(written) ? written : null) === value;
  }));
}
export function groundedAddress(text: string, address: string): boolean {
  if (!address.startsWith('0x')) return [...text.matchAll(/(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![A-Za-z0-9])/g)].some(match => match[0] === address);
  return [...text.matchAll(/(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].some(match => match[0].toLowerCase() === address.toLowerCase());
}
/** UX-001: a grounded address exactly as the user typed it (its EIP-55 case is validated); the interpreted value when it was carried. */
function typedAddress(text: string, address: string): string {
  return [...text.matchAll(/(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map(match => match[0]).find(match => match.toLowerCase() === address.toLowerCase()) ?? address;
}
/** The fixed-vocabulary key of a token in any case ("devusdc", "DevUSDC" → DEVUSDC); null for catalog symbols. */
const legacyAsset = (asset: string): Exclude<CopilotLegacyAsset, 'OTHER'> | null => {
  const key = asset.toUpperCase() === 'TESTUSDC' ? 'DEVUSDC' : asset.toUpperCase();
  return Object.hasOwn(ASSET_MENTIONS, key) ? key as Exclude<CopilotLegacyAsset, 'OTHER'> : null;
};
const assetNamed = (text: string, asset: Exclude<CopilotAsset, 'OTHER'>) => { const key = legacyAsset(asset); return key ? ASSET_MENTIONS[key].test(text) : symbolNamed(text, asset); };
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A catalog symbol written as a word (case-insensitive): "cbbtc" grounds cbBTC; "ETHx" does not ground ETH. */
const symbolNamed = (text: string, symbol: string) => new RegExp(`(?<![A-Za-z0-9.])${escapeRegExp(symbol)}(?![A-Za-z0-9]|\\s+(?:network|rede)\\b)`, 'i').test(text);
/** The catalog's display name written in full ("Coinbase Wrapped BTC", "Tesla"); never a fragment of it. */
const nameNamed = (text: string, asset: CanonicalAsset) => {
  const name = assetDisplayName(asset).trim();
  if (name.length < 3) return false;
  const matches = [...text.matchAll(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, 'gi'))];
  // A token name equal to a network label (e.g. ARB's name Arbitrum) must occur in asset context, not only after 'on'.
  return matches.some(match => !(networkIdentity(name) || catalogNetworkOfChatName(name)) || !/(?:\b(?:on|na|no|da|de|do|from|to|para|network|rede|chain))\s+(?:(?:the|a|o)\s+)?$/i.test(text.slice(0, match.index)));
};

class Stop { constructor(readonly outcome: CopilotOutcome) {} }
const ask = (missing: CopilotAuthoringMissing[], question: string, options: readonly string[] = [], deposit?: string, extra: { readonly code?: string; readonly pool?: PoolRef } = {}): never => {
  throw new Stop({ kind: 'CLARIFICATION', missing, question, options, ...deposit ? { deposit } : {}, ...extra.code ? { code: extra.code } : {}, ...extra.pool ? { pool: extra.pool } : {} });
};
const refuse = (message: string, code?: string, missing?: CopilotAuthoringMissing[]): never => { throw new Stop({ kind: 'UNSUPPORTED', message, ...code ? { code } : {}, ...missing ? { missing } : {} }); };
const reject = (code: string, message: string, missing?: CopilotAuthoringMissing[]): never => { throw new Stop({ kind: 'REJECTED', code, message, ...missing ? { missing } : {} }); };
const labels = (networks: readonly Network[]) => networks.map(n => COPILOT_NETWORK_LABEL[n]);
const copyOf = (g: Grounding): CopilotCopy => copilotCopy(g.policy.language);
const stillNeeds = (m: CopilotCopy, missing: readonly CopilotAuthoringMissing[], subject: Subject) => m.stillNeeds(m.subject[subject], missing.map(field => m.field[field]));

/** A network can only default when it is the action's single, test-token deployment and the user named no other network of that family. */
function defaultNetwork(supported: readonly Network[], g: Grounding): Network | null {
  const only = supported.length === 1 ? supported[0]! : null;
  return only && !MAINNETS.has(only) && !namedNetworks(g).some(n => FAMILY[n] === FAMILY[only]) ? only : null;
}
function resolveNetwork(value: CopilotNetwork | null, supported: readonly Network[], g: Grounding, subject: NetworkSubject, notes: string[]): Network {
  const m = copyOf(g), what = m.networkSubject[subject], named = namedNetworks(g), options = labels(supported);
  const carried = value !== null && value !== 'OTHER' && g.carried.has('network');
  if (value === 'OTHER') return ask(['network'], m.networkOnlyOn(what, options), options);
  // A model cannot reinterpret an explicitly named Ethereum Mainnet as Sepolia.
  if (named.includes('ETHEREUM') && !named.includes('ETHEREUM_SEPOLIA') && !carried && value === 'ETHEREUM_SEPOLIA')
    return ask(['network'], m.realFundsWhichNetwork(COPILOT_NETWORK_LABEL.ETHEREUM), options);
  let network: Network | null = value;
  if (network === null) { const candidates = supported.filter(n => named.includes(n)); network = candidates.length === 1 ? candidates[0]! : null; }
  if (network === null) {
    const fallback = g.policy.networkDefaults ? defaultNetwork(supported, g) : null;
    if (!fallback) return ask(['network'], m.whichNetwork(what), options);
    notes.push(m.defaultNetworkNote(what, COPILOT_NETWORK_LABEL[fallback]));
    return fallback;
  }
  if (!supported.includes(network)) return ask(['network'], m.networkOnlyOn(what, options), options);
  if (MAINNETS.has(network)) {
    // Real funds are never inferred: the user must name the mainnet (or it is carried from a step they authored) and use no test-network wording.
    if ((!named.includes(network) && !carried) || testWording(g)) return ask(['network'], m.realFundsWhichNetwork(COPILOT_NETWORK_LABEL[network]), options);
    return network;
  }
  if (named.includes(network) || carried) return network;
  if (!g.policy.networkDefaults || defaultNetwork(supported, g) !== network) return ask(['network'], m.whichNetwork(what), options);
  notes.push(m.defaultNetworkNote(what, COPILOT_NETWORK_LABEL[network]));
  return network;
}
/**
 * BUILD-FLOFI-INTELLIGENCE-001: the written number behind an amount when it has several exact readings ("1,000" is 1 or 1000; "1.000" too) and the
 * request writes it in no unambiguous form: FloFi asks instead of choosing. "0,0001" and "1,5" have one reading and never ask.
 */
export function ambiguousAmount(text: string, value: string): { readonly written: string; readonly readings: readonly string[] } | null {
  const wanted = canonicalDecimal(value), clean = text.replace(/0x[0-9a-f]*/gi, ' ');
  const tokens = [...clean.matchAll(/(?<![A-Za-z0-9_.,])\d(?:[\d.,]*\d)?/g)].map(match => ({ written: match[0], readings: amountReadings(match[0]) }))
    .filter(token => token.readings.includes(wanted));
  if (!tokens.length || tokens.some(token => token.readings.length === 1)) return null;
  return { written: tokens[0]!.written, readings: tokens[0]!.readings };
}
function amountOf(value: string | null, g: Grounding, subject: Subject, field: CarriedField = 'amount'): string {
  const m = copyOf(g);
  if (value === null) return ask(['amount'], stillNeeds(m, ['amount'], subject));
  if (!g.carried.has(field) && !groundedAmount(g.text, value)) return ask(['amount'], m.amountNotFound(value));
  const ambiguous = g.carried.has(field) || g.policy.catalog !== true ? null : ambiguousAmount(g.text, value);
  if (ambiguous) return ask(['amount'], intelligenceCopy(g.policy.language).amountAmbiguous(ambiguous.written, ambiguous.readings), ambiguous.readings);
  return value;
}
/**
 * BUILD-FLOFI-INTELLIGENCE-001: a test network the user named, in the public product, is said to be one — never offered a mainnet in its place
 * (the user names the mainnet and amount they want; FloFi never moves test funds to real funds).
 */
function testNetworkGuard(action: CopilotAction, g: Grounding): void {
  if (g.policy.catalog !== true || activeNetworkScope() !== 'PUBLIC_MAINNET') return;
  const networks = action.type === 'BRIDGE' ? [action.sourceNetwork, action.destinationNetwork] : [action.network];
  const named = namedNetworks(g);
  for (const network of networks) if (network && network !== 'OTHER' && networkOfCopilot(network).environment === 'TESTNET' && named.includes(network))
    refuse(intelligenceCopy(g.policy.language).goalGaps.TEST_NETWORK_NOT_AVAILABLE(COPILOT_NETWORK_LABEL[network]), TEST_NETWORK_NOT_AVAILABLE);
}
/**
 * BUILD-FLOFI-INTELLIGENCE-001: a currency the user wrote where a token belongs ("swap 1 usd to eth on base") is asked about, with the network's own
 * stablecoins of that currency as the options; FloFi never turns USD into USDC by itself. Only a reference the user actually wrote is checked.
 */
function fiatGuard(action: CopilotAction, g: Grounding): void {
  if (g.policy.catalog !== true) return;
  const slots: [string, CopilotAsset | null, CopilotNetwork | null, CopilotAuthoringMissing][] = action.type === 'SWAP'
    ? [['inputAsset', action.inputAsset, action.network, 'inputAsset'], ['outputAsset', action.outputAsset, action.network, 'outputAsset']]
    : action.type === 'BRIDGE' ? [['asset', action.asset, action.sourceNetwork, 'asset'], ['outputAsset', action.outputAsset ?? null, action.destinationNetwork, 'outputAsset']]
      : action.type === 'LIQUIDITY' ? action.deposits.map(deposit => ['deposit', deposit.asset, action.network, 'asset'] as [string, CopilotAsset, CopilotNetwork | null, CopilotAuthoringMissing])
        : [['asset', action.asset, action.network, 'asset']];
  const plain = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  for (const [, value, network, missing] of slots) {
    const currency = fiatReference(value);
    if (!value || !currency || !symbolNamed(plain(g.text), plain(value)) && !/(?:^|\s)(?:us\$|\$|r\$|€)/i.test(g.text)) continue;
    const identity = network && network !== 'OTHER' ? networkOfCopilot(network) : null;
    const candidates = identity ? fiatCandidates(identity.key, currency) : [];
    ask([missing], intelligenceCopy(g.policy.language).fiatAmbiguous(value, currency, identity?.name ?? null, candidates), candidates);
  }
}
function slippageOf(value: string | null, fallback: string, g: Grounding, notes: string[], maximum?: number, strict = false): string {
  const m = copyOf(g);
  if (value === null) { notes.push(m.defaultSlippageNote(fallback)); return fallback; }
  if (!g.carried.has('slippage') && !groundedBps(g.text, value, strict)) return ask(['slippage'], m.slippageNotFound(value));
  if (maximum !== undefined && Number(value) > maximum) return reject('COPILOT_SLIPPAGE_OUT_OF_RANGE', m.slippageAtMost(maximum));
  return value;
}
function addressOf(value: string | null, g: Grounding, field: 'beneficiary' | 'recipient', notFound = copyOf(g).addressNotFound(field)): string | null {
  if (value !== null && field === 'recipient' && g.saved?.includes(value)) return value;
  if (value !== null && !g.carried.has(field)) {
    const assetAddresses = [explicitInputAsset(g.text), explicitOutputAsset(g.text)].flatMap(asset => asset && /^0x/i.test(asset) ? [asset.split('@')[0]!.toLowerCase()] : []);
    const mentions = [...g.text.matchAll(/0x[0-9a-fA-F]{40}/g)].filter(match => match[0].toLowerCase() === value.toLowerCase());
    if (assetAddresses.includes(value.toLowerCase()) && mentions.length === 1) return ask([field], copyOf(g).addressIsAsset);
  }
  if (value !== null && !g.carried.has(field) && !groundedAddress(g.text, value)) return ask([field], notFound);
  return value;
}
function needAsset(value: CopilotAsset | null, g: Grounding, subject: Subject, field: CarriedField): Exclude<CopilotAsset, 'OTHER'> {
  const m = copyOf(g);
  const missing = g.policy.catalog && (field === 'inputAsset' || field === 'outputAsset') ? field : 'asset';
  if (value === null) return ask([missing], stillNeeds(m, [missing], subject));
  if (value === 'OTHER') return refuse(m.tokenUnsupported(m.tokenSubject[subject]));
  if (!g.carried.has(field) && !assetNamed(g.text, value) && !lexiconNamesAsset(g, value)) return ask([missing], m.tokenNotFound(value));
  return value;
}
/**
 * BUILD-BASE-001: a token on a catalog network, resolved by FloFi through the shared resolver in that network's validated catalog, never
 * by the model (owner addendum: the symbol in any case, or the whole token or company name of exactly one asset — "Tesla" is TSLA on
 * Robinhood Chain and nothing on Base). The user must have written that symbol or name (or it was carried from a step). Several assets
 * sharing a name are asked about; an unknown token is refused; an unloaded catalog fails closed. `ERC20`: swaps and pools take ERC-20s, so
 * "ETH" is the wrapped token, said in `ether`. A name is never silently replaced: `notes` (when given) tells which catalog asset it is.
 */
function catalogToken(value: CopilotAsset | null, network: Network, g: Grounding, subject: Subject, field: CarriedField, kinds: 'ERC20' | 'ANY',
  notes?: string[]): { readonly asset: CanonicalAsset; readonly ether: boolean } {
  const m = copyOf(g), label = COPILOT_NETWORK_LABEL[network], chain = chainOf(network);
  const missing = g.policy.catalog && (field === 'inputAsset' || field === 'outputAsset') ? field : 'asset';
  if (value === null) return ask([missing], stillNeeds(m, [missing], subject));
  if (value === 'OTHER') return refuse(m.tokenUnsupported(m.tokenSubject[subject]));
  const ether = /^eth$/i.test(value) && kinds === 'ERC20';
  const found = resolveAssetReference(chain, ether ? 'WETH' : value);
  if (found.kind === 'INVALID_REFERENCE' || found.kind === 'DECIMALS_MISMATCH') {
    const code = found.kind === 'INVALID_REFERENCE' ? 'ASSET_ADDRESS_INVALID' : 'ASSET_DECIMALS_MISMATCH';
    return refuse(m.universalAssetInvalid(value, label, code), code, [missing]);
  }
  if (found.kind === 'UNAVAILABLE') return reject('ASSET_CATALOG_UNAVAILABLE', m.catalogUnavailable(label), [missing]);
  if (found.kind === 'UNKNOWN') return refuse(m.catalogTokenUnknown(value, label), 'ASSET_UNKNOWN', [missing]);
  if (found.kind === 'AMBIGUOUS') {
    const options = found.assets.map(asset => asset.symbol).slice(0, COPILOT_LIMITS.maxOptions);
    return ask([missing], m.catalogTokenAmbiguous(value, label), options);
  }
  const asset = found.asset;
  if (kinds === 'ERC20' && asset.kind !== 'ERC20') return refuse(m.catalogTokenUnknown(value, label), 'ASSET_UNKNOWN', [missing]);
  // Native ETH is grounded only by the user's ETH/Ether, never by their WETH (FIX 1 review: ETH and WETH stay distinct).
  const text = /^eth$/i.test(value) && !ether ? g.text.replace(WRAPPED_ETH_WORDS, ' ') : g.text;
  const grounded = g.carried.has(field) || lexiconNamesAsset(g, value) || ((found.by === 'SYMBOL' || found.by === 'ADDRESS') && symbolNamed(text, value)) || (/^eth$/i.test(value) && NATIVE_ETH_NAMED.test(text)) ||
    nameNamed(text, asset);
  if (!grounded) return ask([missing], m.tokenNotFound(value));
  if (found.by === 'NAME' && notes) notes.push(m.catalogNameNote(value, asset.symbol, assetDisplayName(asset), label));
  return { asset, ether };
}

export type Plan = { readonly sentence: string; readonly expect: CopilotAuthoringCommand; readonly notes: string[] };

/**
 * V2: devUSDC exists only on Solana Devnet, so a request that names devUSDC (in any case) and no network is Solana Devnet, with a note. Test-token
 * wording never resolves to a mainnet; any named network still goes through `resolveNetwork`.
 */
const impliesDevnet = (g: Grounding, assets: readonly (CopilotAsset | null)[]) => g.policy.catalog === true &&
  assets.some(asset => asset !== null && legacyAsset(asset) === 'DEVUSDC') && ASSET_MENTIONS.DEVUSDC.test(g.text);
function devnetByAsset(g: Grounding, notes: string[]): Network { notes.push(copyOf(g).devUsdcNetworkNote); return 'SOLANA_DEVNET'; }

function planSwap(a: CopilotSwapAction, g: Grounding): Plan {
  const m = copyOf(g), notes: string[] = [];
  const supported = actionNetworks('swap', g);
  // Ethereum and Ethereum Sepolia are grounded independently through the shared network registry.
  const named = namedNetworks(g);
  const devnetImplied = a.network === null && !named.length && impliesDevnet(g, [a.inputAsset, a.outputAsset]);
  const missing: CopilotAuthoringMissing[] = [...(a.amount === null ? ['amount' as const] : []), ...(a.inputAsset === null ? [g.policy.catalog ? 'inputAsset' as const : 'asset' as const] : []), ...(a.outputAsset === null ? [g.policy.catalog ? 'outputAsset' as const : 'asset' as const] : []),
    ...(a.network === null && !devnetImplied && !supported.some(n => named.includes(n)) && !named.includes('ETHEREUM') ? ['network' as const] : [])];
  if (missing.length) ask(missing, stillNeeds(m, missing, 'swap'), missing.length === 1 && missing[0] === 'network' ? labels(supported) : []);
  const network = devnetImplied ? devnetByAsset(g, notes) : resolveNetwork(a.network, supported, g, 'swap', notes);
  // BUILD-FLOFI-CHAT-E2E-FIX-002 / BUILD-FLOFI-BRIDGE-LIVE-FIX-003: ETH and WETH are different assets. On a catalog network native ETH is its own
  // asset (a native swap, or a WETH9 wrap/unwrap against WETH); elsewhere (test networks: USDC ⇄ WETH only) it is refused, never authored as WETH.
  const catalogNetwork = g.policy.catalog && isCatalogNetwork(network);
  if (!catalogNetwork && !/^SOLANA/.test(network) && [a.inputAsset, a.outputAsset].some(asset => typeof asset === 'string' && /^eth$/i.test(asset))) refuse(m.nativeSwapUnavailable, 'SWAP_NATIVE_ASSET_UNSUPPORTED');
  // BUILD-BASE-001: on a catalog network any two catalog assets; Base's USDC ⇄ WETH keeps its BUILD-002 sentence and command.
  if (catalogNetwork) {
    const input = catalogToken(a.inputAsset, network, g, 'swap', 'inputAsset', 'ANY', notes), output = catalogToken(a.outputAsset, network, g, 'swap', 'outputAsset', 'ANY', notes);
    if (input.asset.id === output.asset.id) reject('INVALID_ASSET_PAIR', m.differentTokens);
    const amount = amountOf(a.amount, g, 'swap');
    const slippage = slippageOf(a.slippageBps, DEFAULT_SLIPPAGE, g, notes);
    const from = input.asset.symbol, to = output.asset.symbol, label = COPILOT_NETWORK_LABEL[network];
    if (from === 'ETH' || to === 'ETH') notes.push([from, to].includes('WETH') ? m.wrapNote : m.nativeEthNote);
    if (network === 'BASE' && [from, to].every(symbol => symbol === 'USDC' || symbol === 'WETH'))
      return { sentence: `swap ${amount} ${from} to ${to} on Base slippage ${slippage} bps`, expect: 'ADD_SWAP', notes };
    notes.push(m.catalogFundsNote(label));
    return { sentence: `swap ${amount} ${from} to ${to} on ${label} slippage ${slippage} bps`, expect: 'ADD_CRYPTO_ACTION', notes };
  }
  const input = needAsset(a.inputAsset, g, 'swap', 'inputAsset'), output = needAsset(a.outputAsset, g, 'swap', 'outputAsset');
  const amount = amountOf(a.amount, g, 'swap');
  const slippage = slippageOf(a.slippageBps, DEFAULT_SLIPPAGE, g, notes);
  if (FAMILY[network] === 'base' || FAMILY[network] === 'ethereum') {
    const evm = (written: string) => { const asset = written.toUpperCase(); return asset === 'USDC' ? 'USDC' : asset === 'WETH' || asset === 'ETH' ? 'WETH' : refuse(m.evmSwapTokens); };
    const from = evm(input), to = evm(output);
    if (from === to) reject('INVALID_ASSET_PAIR', m.differentTokens);
    if (input.toUpperCase() === 'ETH' || output.toUpperCase() === 'ETH') notes.push(m.wethNote);
    return { sentence: `swap ${amount} ${from} to ${to} on ${COPILOT_NETWORK_LABEL[network]} slippage ${slippage} bps`,
      expect: network === 'BASE_SEPOLIA' ? 'ADD_TESTNET_SWAP' : network === 'ETHEREUM_SEPOLIA' ? 'ADD_ETHEREUM_SEPOLIA_SWAP' : 'ADD_SWAP', notes };
  }
  const devnet = network === 'SOLANA_DEVNET';
  const solana = (written: string) => { const asset = legacyAsset(written) ?? written.toUpperCase();
    return asset === 'SOL' ? 'SOL' : devnet ? (asset === 'DEVUSDC' || asset === 'USDC' ? 'devUSDC' : refuse(m.devnetSwapTokens))
      : asset === 'USDC' || asset === 'USDT' ? asset : refuse(m.solanaSwapTokens); };
  const from = solana(input), to = solana(output);
  if (from === to) reject('INVALID_ASSET_PAIR', m.differentTokens);
  return { sentence: `swap ${amount} ${from} to ${to} on ${devnet ? 'Solana Devnet' : 'Solana'} slippage ${slippage} bps`, expect: 'ADD_SOLANA_SWAP', notes };
}

/**
 * BUILD-BASE-001: every Router route beyond the original two pairs (Arbitrum One → Base and the four Robinhood Chain routes), generically
 * from the route registry. All are real funds: both networks must be named (or carried) and no test-network wording may appear. The token is
 * the route's source token (USDC, or USDG out of Robinhood Chain); the destination token is shown by the route itself.
 */
function routeCopilot(label: string): Network | null { return (networkIdentity(label)?.copilot ?? null) as Network | null; }
const EXTENDED_ROUTES = routerNetworksOf('mainnet').filter(key => key !== 'mainnet').map(key => {
  const option = ROUTER_NETWORK_OPTIONS[key];
  return { key, option, src: routeCopilot(option.sourceLabel)!, dst: routeCopilot(option.destinationLabel)!, token: option.pair.source.symbol };
});
const extendedRoute = (a: CopilotBridgeAction, g: Grounding) => g.policy.catalog === true && (a.sourceNetwork === 'ROBINHOOD' || a.destinationNetwork === 'ROBINHOOD' ||
  a.sourceNetwork === 'ETHEREUM' || a.destinationNetwork === 'ETHEREUM' || a.sourceNetwork === 'ARBITRUM' || a.destinationNetwork === 'BASE' || /^usdg$/i.test(a.asset ?? '') || namedNetworks(g).includes('ROBINHOOD'));
function planRoute(a: CopilotBridgeAction, g: Grounding): Plan {
  const m = copyOf(g), notes: string[] = [], text = g.text;
  const named = [...namedNetworks(g), ...(['sourceNetwork', 'destinationNetwork'] as const).flatMap(field => {
    const value = a[field]; return value !== null && value !== 'OTHER' && g.carried.has(field) ? [value] : []; })];
  // A side counts only when the user named that network (or it was carried): a mainnet is never inferred.
  const side = (value: CopilotNetwork | null): Network | null | 'OTHER' => value === null ? null : value === 'OTHER' ? 'OTHER' : named.includes(value) ? value : null;
  const source = side(a.sourceNetwork), destination = side(a.destinationNetwork);
  if (source === 'OTHER' || destination === 'OTHER') return refuse(m.routerRoutesAll(routeLabels()));
  // BUILD-FLOFI-UX-FIX-003: in the public product an unnamed side is asked among every mainnet (the universal bridge's question), whichever source.
  if (publicScope() && (source === null || destination === null)) return planUniversalBridge(a, g);
  const touching = EXTENDED_ROUTES.filter(r => (source === null || r.src === source) && (destination === null || r.dst === destination) &&
    (source !== null || destination !== null || named.includes(r.src) || named.includes(r.dst)));
  const options = touching.map(r => `${r.option.sourceLabel} → ${r.option.destinationLabel}`);
  const missing: CopilotMissingField[] = [...(a.amount === null ? ['amount' as const] : []), ...(a.asset === null ? ['asset' as const] : []),
    ...(source === null ? ['sourceNetwork' as const] : []), ...(destination === null ? ['destinationNetwork' as const] : [])];
  if (missing.length) ask(missing, stillNeeds(m, missing, 'bridge'), source === null || destination === null ? options : []);
  const route = EXTENDED_ROUTES.find(r => r.src === source && r.dst === destination);
  if (!route) return ask(['sourceNetwork', 'destinationNetwork'], m.whichRoute, EXTENDED_ROUTES.filter(r => r.src === source || r.dst === destination)
    .map(r => `${r.option.sourceLabel} → ${r.option.destinationLabel}`));
  if (testWording(g)) ask(['sourceNetwork', 'destinationNetwork'], m.routeRealFunds(`${route.option.sourceLabel} → ${route.option.destinationLabel}`), options);
  const reference = needAsset(a.asset, g, 'bridge', 'asset');
  // Known symbols retain the route-specific refusal; whole names resolve within the route's source catalog.
  const asset = g.policy.catalog && !/^[A-Za-z][A-Za-z0-9.]{0,15}$/.test(reference)
    ? catalogToken(reference, route.src, g, 'bridge', 'asset', 'ANY', notes).asset.symbol : reference;
  // BUILD-CROSSCHAIN-UNIVERSAL-001: another asset on a mainnet route is a universal bridge (no artificial token restriction).
  if (asset.toUpperCase() !== route.token) return planUniversalBridge(a, g);
  const amount = amountOf(a.amount, g, 'bridge');
  const slippage = slippageOf(a.slippageBps, ROUTER_DEFAULT_SLIPPAGE, g, notes, route.option.profile.maximumSlippageBps);
  const routingNamed = g.carried.has('routing');
  if (a.routing === 'LIFI' && !routingNamed && !/li\.?\s?fi/i.test(text)) ask([], m.whichRouting, m.routingOptions);
  if (a.routing === 'ACROSS' && !routingNamed && !/\bacross\b/i.test(text)) ask([], m.whichRouting, m.routingOptions);
  const routing = a.routing === 'LIFI' ? 'LI.FI' : a.routing === 'ACROSS' ? 'Across' : 'auto';
  if (routing === 'auto') notes.push(m.autoRoutingNote);
  const recipient = addressOf(a.recipient, g, 'recipient');
  if (!recipient) notes.push(m.connectedRecipientNote);
  notes.push(route.option.funds);
  return { sentence: `bridge ${amount} ${route.token} from ${route.option.source} to ${route.option.destination}${recipient ? ' to ' + recipient : ''} via ${routing} slippage ${slippage} bps`,
    expect: 'ADD_ROUTER_BRIDGE', notes };
}

/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: a bridge between any two of the five mainnets that the certified Router does not serve exactly — Solana
 * in or out, another asset, a chosen destination asset ("receive SOL") or a named provider (Relay, Mayan) — is a universal bridge (V2 only:
 * CopilotIntent V1 is frozen). As everywhere, both networks must be named (or carried), real funds are never inferred, values come only from
 * the user's own words, and a destination asset FloFi proposes is stated. The route itself is chosen at Simulate and shown at Review.
 */
const UNIVERSAL_OF: Readonly<Partial<Record<Network, UniversalNetworkKey>>> = { SOLANA: 'solana', BASE: 'base', ARBITRUM: 'arbitrum-one', ETHEREUM: 'ethereum', ROBINHOOD: 'robinhood' };
/** The destination asset the message names ("receive SOL"); never for a goal plan's step, whose own planned asset (or the default) stands. */
const receivedAsset = (text: string, g?: Grounding) => g?.explicitAssets === false ? null : explicitOutputAsset(text);
const universalWanted = (a: CopilotBridgeAction, g: Grounding) => {
  if (!g.policy.catalog) return false;
  if (a.sourceNetwork === 'SOLANA' || a.destinationNetwork === 'SOLANA' || namedNetworks(g).includes('SOLANA') ||
    ['BEST', 'RELAY', 'MAYAN'].includes(a.routing ?? '') || /\b(?:relay|mayan)\b/i.test(g.text)) return true;
  const src = a.sourceNetwork && a.sourceNetwork !== 'OTHER' ? UNIVERSAL_OF[a.sourceNetwork] : undefined;
  const dst = a.destinationNetwork && a.destinationNetwork !== 'OTHER' ? UNIVERSAL_OF[a.destinationNetwork] : undefined;
  return !!src && !!dst && !!universalCanvasPair({ source: UNIVERSAL_CANVAS_LABEL[src], destination: UNIVERSAL_CANVAS_LABEL[dst],
    ...a.asset ? { inputAsset: a.asset } : {}, ...a.outputAsset ?? receivedAsset(g.text, g) ? { outputAsset: (a.outputAsset ?? receivedAsset(g.text, g))! } : {} });
};
function planUniversalBridge(a: CopilotBridgeAction, g: Grounding): Plan {
  const m = copyOf(g), notes: string[] = [], text = g.text;
  const named = [...namedNetworks(g), ...(['sourceNetwork', 'destinationNetwork'] as const).flatMap(field => {
    const value = a[field]; return value !== null && value !== 'OTHER' && g.carried.has(field) ? [value] : []; })];
  const side = (value: CopilotNetwork | null): Network | null | 'OTHER' => value === null ? null : value === 'OTHER' ? 'OTHER' : named.includes(value) ? value : null;
  const source = side(a.sourceNetwork), destination = side(a.destinationNetwork);
  const labelsAll = Object.values(UNIVERSAL_NETWORKS).map(n => n.name);
  if (source === 'OTHER' || destination === 'OTHER' || (source !== null && !UNIVERSAL_OF[source]) || (destination !== null && !UNIVERSAL_OF[destination]))
    return refuse(m.universalNetworks(labelsAll));
  const missing: CopilotMissingField[] = [...(a.amount === null ? ['amount' as const] : []), ...(a.asset === null ? ['asset' as const] : []),
    ...(source === null ? ['sourceNetwork' as const] : []), ...(destination === null ? ['destinationNetwork' as const] : [])];
  const known = source ?? destination;
  // BUILD-FLOFI-UX-FIX-003: the public product asks one network side at a time, offering only the mainnets the universal bridge serves (a button then
  // answers exactly that side); the asset and the amount follow. Whether a live route exists between the two is decided at Simulate, never here.
  if (publicScope() && (source === null || destination === null)) {
    const offered = labelsAll.filter(label => known === null || label !== UNIVERSAL_NETWORKS[UNIVERSAL_OF[known]!].name);
    if (source === null) ask(['sourceNetwork'], m.bridgeSourceQuestion(a.asset && a.asset !== 'OTHER' ? assetLabel(a.asset, null) : null), offered);
    ask(['destinationNetwork'], m.bridgeDestinationQuestion(UNIVERSAL_NETWORKS[UNIVERSAL_OF[source!]!].name), offered);
  }
  if (missing.length) ask(missing, stillNeeds(m, missing, 'bridge'), source === null || destination === null
    ? labelsAll.filter(label => known === null || label !== UNIVERSAL_NETWORKS[UNIVERSAL_OF[known]!].name) : []);
  if (source === destination) return ask(['destinationNetwork'], m.universalSameNetwork, labelsAll.filter(label => label !== UNIVERSAL_NETWORKS[UNIVERSAL_OF[source!]!].name));
  const src = UNIVERSAL_OF[source!]!, dst = UNIVERSAL_OF[destination!]!, srcName = UNIVERSAL_NETWORKS[src].name, dstName = UNIVERSAL_NETWORKS[dst].name;
  const route = `${srcName} → ${dstName}`;
  if (testWording(g)) ask(['sourceNetwork', 'destinationNetwork'], m.routeRealFunds(route));
  const written = isCatalogNetwork(source as Network) && !g.carried.has('asset') && !a.asset?.includes('@') ? catalogToken(a.asset, source as Network, g, 'bridge', 'asset', 'ANY', notes).asset.symbol : needAsset(a.asset, g, 'bridge', 'asset');
  const reference = (key: UniversalNetworkKey, value: string, network: string) => {
    try { return universalAssetReference(key, value); } catch (cause) {
      const code = cause instanceof Error ? cause.message : 'UNIVERSAL_ASSET_UNKNOWN';
      const field = key === src ? 'asset' : 'outputAsset';
      if (code === 'UNIVERSAL_ASSET_UNKNOWN' && key === 'solana' && !solanaDisplayCatalogLoaded()) return reject('ASSET_CATALOG_UNAVAILABLE', m.catalogUnavailable(network), [field]);
      if (code === 'UNIVERSAL_ASSET_AMBIGUOUS') return ask([field], m.catalogTokenAmbiguous(value, network));
      return refuse(code === 'UNIVERSAL_ASSET_UNKNOWN' || code === 'ASSET_CATALOG_UNAVAILABLE' ? m.universalAssetUnknown(value, network) : m.universalAssetInvalid(value, network, code), code, [field]);
    }
  };
  const asset = reference(src, written, srcName), wantedOutput = a.outputAsset ?? receivedAsset(text, g);
  // Destination values have their own grounding and catalog. They can never change the source asset.
  if (wantedOutput !== null) {
    if (isCatalogNetwork(destination as Network) && !g.carried.has('outputAsset') && !wantedOutput.includes('@')) catalogToken(wantedOutput, destination as Network, g, 'bridge', 'outputAsset', 'ANY', notes);
    else needAsset(wantedOutput, g, 'bridge', 'outputAsset');
  }
  let outputAsset: string;
  if (wantedOutput !== null) outputAsset = reference(dst, wantedOutput, dstName);
  else {
    try { outputAsset = defaultUniversalOutput(src, resolveUniversalAsset(src, asset).symbol, dst); } catch { return ask(['outputAsset'], m.universalOutputQuestion(dstName)); }
    notes.push(m.universalDefaultOutputNote(outputAsset, dstName));
  }
  const amount = amountOf(a.amount, g, 'bridge');
  const slippage = slippageOf(a.slippageBps, DEFAULT_SLIPPAGE, g, notes, UNIVERSAL_MAXIMUM_SLIPPAGE_BPS);
  const routingNamed = g.carried.has('routing');
  if (a.routing && a.routing !== 'AUTO' && a.routing !== 'BEST' && !routingNamed &&
    !(a.routing === 'LIFI' ? /li\.?\s?fi/i : new RegExp(`\\b${a.routing}\\b`, 'i')).test(text)) ask([], m.whichRouting, m.routingOptions);
  const routing: UniversalBridgeRouting = a.routing === 'RELAY' || /\brelay\b/i.test(text) ? 'RELAY' : a.routing === 'MAYAN' || /\bmayan\b/i.test(text) ? 'MAYAN'
    : a.routing === 'LIFI' && (routingNamed || /li\.?\s?fi/i.test(text)) ? 'LIFI' : a.routing === 'ACROSS' && (routingNamed || /\bacross\b/i.test(text)) ? 'ACROSS' : 'BEST';
  if (routing === 'BEST') notes.push(m.universalBestRoutingNote);
  const destinationEcosystem = UNIVERSAL_NETWORKS[dst].ecosystem === 'SOLANA' ? 'Solana' : 'EVM';
  const solanaRecipient = () => {
    if (a.recipient !== null && /^0x/i.test(a.recipient)) return refuse(m.universalRecipientFormat(dstName, destinationEcosystem));
    if (a.recipient !== null && g.saved?.includes(a.recipient) && isSolanaPublicKey(a.recipient)) return a.recipient;
    const outputIdentity = resolveUniversalAsset(dst, outputAsset).asset;
    // Explicit token references and the selected token mint are asset identities, never implicit recipient wallets.
    const keys = [...new Set([...text.matchAll(/(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![A-Za-z0-9@])/g)].map(match => match[0])
      .filter(isSolanaPublicKey).filter(key => outputIdentity.kind !== 'TOKEN' || key !== outputIdentity.address))];
    return keys.length > 1 ? ask(['recipient'], m.universalRecipientWhich, keys) : keys[0] ?? '';
  };
  const recipient = destinationEcosystem === 'EVM' ? addressOf(a.recipient, g, 'recipient')?.toLowerCase() ?? '' : solanaRecipient();
  if (!recipient) notes.push(UNIVERSAL_NETWORKS[src].ecosystem === UNIVERSAL_NETWORKS[dst].ecosystem ? m.connectedRecipientNote : m.universalDestinationWalletNote(destinationEcosystem));
  notes.push(m.universalFundsNote(route));
  return { sentence: universalChatSentence({ source: src, destination: dst, inputAsset: asset, outputAsset, amount, recipient, slippage, routing }), expect: 'ADD_UNIVERSAL_BRIDGE', notes };
}
const UNIVERSAL_MAXIMUM_SLIPPAGE_BPS = 300;

function planBridge(a: CopilotBridgeAction, g: Grounding): Plan {
  if (g.policy.catalog && g.explicitAssets !== false) a = groundExplicitAssets(a, g.latest ?? g.text, g.lexicon, g.receiving === true) as CopilotBridgeAction;
  if (g.policy.catalog && a.outputAsset && a.destinationNetwork && a.destinationNetwork !== 'OTHER' && !g.carried.has('outputAsset')) {
    if (isCatalogNetwork(a.destinationNetwork) && !a.outputAsset.includes('@')) catalogToken(a.outputAsset, a.destinationNetwork, g, 'bridge', 'outputAsset', 'ANY');
    else needAsset(a.outputAsset, g, 'bridge', 'outputAsset');
  }
  if (universalWanted(a, g)) return planUniversalBridge(a, g);
  if (extendedRoute(a, g)) return planRoute(a, g);
  const m = copyOf(g), notes: string[] = [], text = g.text;
  const carriedSide = (value: CopilotNetwork | null, field: CarriedField): Network[] => value !== null && value !== 'OTHER' && g.carried.has(field) ? [value] : [];
  const named = [...namedNetworks(g), ...carriedSide(a.sourceNetwork, 'sourceNetwork'), ...carriedSide(a.destinationNetwork, 'destinationNetwork')];
  // A side is the network the user named in that family; an unnamed test network is only a candidate, an unnamed mainnet is dropped.
  const side = (value: CopilotNetwork | null, family: Family): Network | null | 'OTHER' | 'CONFLICT' => {
    const inFamily = [...new Set(named.filter(n => FAMILY[n] === family))];
    if (value === null) return inFamily.length === 1 ? inFamily[0]! : inFamily.length > 1 ? 'CONFLICT' : null;
    if (value === 'OTHER' || FAMILY[value] !== family) return 'OTHER';
    if (inFamily.includes(value)) return value;
    if (inFamily.length) return 'CONFLICT';
    return MAINNETS.has(value) ? null : value;
  };
  // BUILD-FLOFI-UX-FIX-003: the public product never offers the engineering test-network pair (Base Sepolia → Arbitrum Sepolia).
  const pairs = (publicScope() ? [ROUTER_NETWORK_OPTIONS.mainnet] : [ROUTER_NETWORK_OPTIONS.testnet, ROUTER_NETWORK_OPTIONS.mainnet])
    .map(option => `${option.sourceLabel} → ${option.destinationLabel}`);
  let source = side(a.sourceNetwork, 'base'), destination = side(a.destinationNetwork, 'arbitrum');
  if (source === 'OTHER' || destination === 'OTHER') refuse(g.policy.catalog ? m.routerRoutesAll(routeLabels()) : m.routerRoutes);
  if (source === 'CONFLICT' || destination === 'CONFLICT') ask(['sourceNetwork', 'destinationNetwork'], m.whichRoute, pairs);
  // An unnamed side is asked among every mainnet the bridge serves (not only the Router's Base → Arbitrum One pair); the certified Router still
  // authors Base → Arbitrum One USDC once both sides are named.
  if (publicScope() && g.policy.catalog && (source === null || destination === null)) {
    // A side the user did name (read from their words even when the model left it out) is kept: only the unnamed side is asked.
    const named = (value: typeof source): value is Network => value !== null && value !== 'OTHER' && value !== 'CONFLICT';
    return planUniversalBridge({ ...a, ...named(source) ? { sourceNetwork: source } : {}, ...named(destination) ? { destinationNetwork: destination } : {} }, g);
  }
  // V1: a test-network pair may complete itself; a mainnet side never implies the other one. V2 asks instead.
  if (g.policy.networkDefaults && source === null && destination === 'ARBITRUM_SEPOLIA') { source = 'BASE_SEPOLIA'; notes.push(m.routerSourceNote); }
  if (g.policy.networkDefaults && destination === null && source === 'BASE_SEPOLIA') { destination = 'ARBITRUM_SEPOLIA'; notes.push(m.routerDestinationNote); }
  const missing: CopilotMissingField[] = [...(a.amount === null ? ['amount' as const] : []), ...(a.asset === null ? ['asset' as const] : []),
    ...(source === null ? ['sourceNetwork' as const] : []), ...(destination === null ? ['destinationNetwork' as const] : [])];
  // Only the counterpart that forms a supported pair is offered.
  if (missing.length) ask(missing, stillNeeds(m, missing, 'bridge'), source === null && destination === null ? pairs
    : source === null ? [destination === 'ARBITRUM_SEPOLIA' ? 'Base Sepolia' : 'Base'] : destination === null ? [source === 'BASE_SEPOLIA' ? 'Arbitrum Sepolia' : 'Arbitrum One'] : []);
  const src = source as Network, dst = destination as Network;
  const network = src === 'BASE' && dst === 'ARBITRUM' ? 'mainnet' : src === 'BASE_SEPOLIA' && dst === 'ARBITRUM_SEPOLIA' ? 'testnet' : null;
  if (!network) return ask(['sourceNetwork', 'destinationNetwork'], m.routerMixed, pairs);
  if (network === 'mainnet' && (!named.includes('BASE') || !named.includes('ARBITRUM') || testWording(g))) ask(['sourceNetwork', 'destinationNetwork'], m.routerRealFunds, pairs);
  if (network === 'testnet' && !named.includes(src) && !named.includes(dst)) ask(['sourceNetwork', 'destinationNetwork'], m.whichRoute, pairs);
  const asset = g.policy.catalog && network === 'mainnet' ? catalogToken(a.asset, src, g, 'bridge', 'asset', 'ANY', notes).asset.symbol : needAsset(a.asset, g, 'bridge', 'asset');
  if (asset !== ROUTER_NETWORK_OPTIONS[network].pair.source.symbol) return g.policy.catalog && network === 'mainnet' ? planUniversalBridge(a, g) : refuse(m.routerUsdcOnly);
  const amount = amountOf(a.amount, g, 'bridge');
  const profile = ROUTER_NETWORK_OPTIONS[network].profile;
  const slippage = slippageOf(a.slippageBps, ROUTER_DEFAULT_SLIPPAGE, g, notes, profile.maximumSlippageBps);
  const routingNamed = g.carried.has('routing');
  if (a.routing === 'LIFI' && !routingNamed && !/li\.?\s?fi/i.test(text)) ask([], m.whichRouting, m.routingOptions);
  if (a.routing === 'ACROSS' && !routingNamed && !/\bacross\b/i.test(text)) ask([], m.whichRouting, m.routingOptions);
  const routing = a.routing === 'LIFI' ? 'LI.FI' : a.routing === 'ACROSS' ? 'Across' : 'auto';
  if (routing === 'auto') notes.push(m.autoRoutingNote);
  const recipient = addressOf(a.recipient, g, 'recipient');
  if (!recipient) notes.push(m.connectedRecipientNote);
  if (network === 'mainnet') notes.push(m.mainnetFundsNote);
  return { sentence: `bridge ${amount} USDC from ${src === 'BASE' ? 'Base' : 'Base Sepolia'} to ${dst === 'ARBITRUM' ? 'Arbitrum' : 'Arbitrum Sepolia'}` +
    `${recipient ? ' to ' + recipient : ''} via ${routing} slippage ${slippage} bps`, expect: 'ADD_ROUTER_BRIDGE', notes };
}

/**
 * BUILD-BASE-001: a transfer on a catalog network (real funds): native ETH or a catalog token, to the connected owner or a typed address.
 * The network must be named; the sentence is the exact grammar's (`transfer 0.01 ETH on Base to 0x…`).
 */
/** UX-001: the user names the connected owner as the destination, in the request or as the answer to "Which wallet should I send it to?". */
/** "To me" / "para minha carteira": the connected owner wallet (also read by the conversation: a saved name never replaces it). */
export const SELF_RECIPIENT = /\b(?:to|into)\s+(?:me|myself|my(?:\s+own)?(?:\s+connected)?\s+wallet)\b|\b(?:para|pra)\s+(?:mim(?:\s+mesm[oa])?|(?:a\s+)?minha(?:\s+própria)?\s+carteira)(?![\p{L}\p{N}])/iu;
const SELF_ANSWER = /^(?:(?:to\s+)?(?:me|myself|my(?:\s+own)?(?:\s+connected)?\s+wallet)|(?:para\s+)?(?:mim(?:\s+mesm[oa])?|(?:a\s+)?minha(?:\s+própria)?\s+carteira))[.!]?$/iu;
function planTransfer(a: CopilotTransferAction, g: Grounding): Plan {
  const m = copyOf(g), notes: string[] = [];
  if (!g.policy.catalog) return refuse(m.cannotAuthor);
  const TRANSFER_COPILOT_NETWORKS = actionNetworks('transfer', g);
  const named = namedNetworks(g);
  // UX-001: the destination is a required slot. It is a typed address, or the connected owner only when the user says so ("to me",
  // "to my own wallet", "para mim"); otherwise Flofi asks — it never defaults a Send to the connected wallet.
  const self = a.recipient === null && (SELF_RECIPIENT.test(g.text) || SELF_ANSWER.test((g.latest ?? '').trim()));
  const missing: CopilotMissingField[] = [...(a.amount === null ? ['amount' as const] : []), ...(a.asset === null ? ['asset' as const] : []),
    ...(a.network === null && !TRANSFER_COPILOT_NETWORKS.some(n => named.includes(n)) ? ['network' as const] : [])];
  // One combined question when other slots are missing too; a lone missing destination is asked once the asset and network resolve.
  if (missing.length) ask(a.recipient === null && !self ? [...missing, 'recipient'] : missing, stillNeeds(m, a.recipient === null && !self ? [...missing, 'recipient'] : missing, 'transfer'),
    missing.length === 1 && missing[0] === 'network' ? labels(TRANSFER_COPILOT_NETWORKS) : []);
  const network = resolveNetwork(a.network, TRANSFER_COPILOT_NETWORKS, g, 'transfer', notes), label = COPILOT_NETWORK_LABEL[network];
  if (network === 'SOLANA' || network === 'SOLANA_DEVNET') {
    const profile = solanaTransferProfileFor(network === 'SOLANA' ? 'Solana' : 'Solana Devnet');
    const token = a.asset && solanaTransferAsset(profile, a.asset);
    if (!token) return refuse(m.tokenUnsupported(m.tokenSubject.transfer));
    if (!g.carried.has('asset') && !symbolNamed(g.text, a.asset!)) return ask(['asset'], m.tokenNotFound(a.asset!));
    const amount = amountOf(a.amount, g, 'transfer');
    const recipient = addressOf(a.recipient, g, 'recipient', m.sendRecipientNotFound), check = checkRecipient(label, recipient);
    if (!check.ok) return ask(['recipient'], check.code === 'TRANSFER_RECIPIENT_REQUIRED' ? m.sendRecipientQuestion : m.sendRecipientInvalid(label));
    return { sentence: `send ${amount} ${token.symbol} to ${check.recipient} on ${label}`, expect: 'ADD_RH_TRANSFER', notes };
  }
  if (network === 'ETHEREUM_SEPOLIA' || network === 'ROBINHOOD_TESTNET') {
    const asset = needAsset(a.asset, g, 'transfer', 'asset');
    if (asset.toUpperCase() !== 'ETH' || a.recipient !== null) return refuse(m.cannotAuthor);
    if (!self) return ask(['recipient'], m.sendRecipientQuestion);
    const amount = amountOf(a.amount, g, 'transfer');
    notes.push(m.connectedRecipientNote);
    return { sentence: `transfer ${amount} ETH on ${label}`, expect: 'ADD_RH_TRANSFER', notes };
  }
  const token = catalogToken(a.asset, network, g, 'transfer', 'asset', 'ANY', notes).asset;
  const amount = amountOf(a.amount, g, 'transfer');
  // The Canvas "To" field's own network-aware check: the same canonical recipient whichever surface authored it.
  const typed = self ? null : addressOf(a.recipient, g, 'recipient', m.sendRecipientNotFound);
  const check = self ? { ok: true as const, recipient: 'CONNECTED_OWNER' } : checkRecipient(label, typed === null ? null : typedAddress(g.text, typed));
  if (!check.ok) return check.code === 'TRANSFER_RECIPIENT_REQUIRED' ? ask(['recipient'], m.sendRecipientQuestion)
    : check.code === 'TRANSFER_RECIPIENT_INVALID' ? ask(['recipient'], m.sendRecipientInvalid(label)) : refuse(m.cannotAuthor);
  if (check.recipient === 'CONNECTED_OWNER') notes.push(m.connectedRecipientNote);
  notes.push(m.catalogFundsNote(label));
  return { sentence: `transfer ${amount} ${token.symbol} on ${label}${check.recipient === 'CONNECTED_OWNER' ? '' : ' to ' + check.recipient}`, expect: 'ADD_RH_TRANSFER', notes };
}

const LENDING_SUBJECT = { SUPPLY: 'supply', BORROW: 'borrow', REPAY: 'repay', WITHDRAW: 'withdraw' } as const;
/** BUILD-BASE-001: the Aave networks of an asset, from the shared capability truth (V1: no catalog, hence no real-funds, network). */
function lendingNetworks(asset: CopilotAsset | null, g: Grounding): Network[] {
  // A market lists many reserves (BUILD AAVE-V3-EXPANSION-001): each network once, in offer order.
  return [...new Set(lendingOffers().filter(offer => (asset === null || offer.asset === asset) && offer.network.copilot !== null && actionNetworks('supply', g).includes(offer.network.copilot))
    .map(offer => offer.network.copilot as Network))];
}
/**
 * A reserve label written as a whole token: never as part of a longer label ("USDC" inside "USDC.e", "USDe" inside "PT-USDe-5FEB2026"). A dot
 * continues a label only when a letter or digit follows it, so a sentence-final period ("supply 10 GHO.") still names the reserve.
 */
const reserveLabelWritten = (text: string, label: string) => new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(label)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'i').test(text);
/** Other reserve labels of the same market that contain `asset` and that the user wrote in full (for example USDC.e when the model said USDC). */
function longerReservesWritten(asset: string, network: Network, g: Grounding): string[] {
  const wanted = asset.toLowerCase();
  return lendingReservesFor(COPILOT_NETWORK_LABEL[network]).map(reserve => reserve.symbol)
    .filter(label => label.toLowerCase() !== wanted && label.toLowerCase().includes(wanted) && reserveLabelWritten(g.text, label));
}
/** The Aave reserve of `network`'s market the user named by its label (grounded in their words or carried), or null. Identity, not symbol. */
function aaveReserveNamed(value: CopilotAsset | null, network: Network, g: Grounding): string | null {
  if (value === null || value === 'OTHER') return null;
  if (!g.carried.has('asset') && !reserveLabelWritten(g.text, value) && !(legacyAsset(value) && assetNamed(g.text, value))) return null;
  try { return lendingProfileFor(COPILOT_NETWORK_LABEL[network], value).symbol; } catch { return null; }
}
function planLending(a: CopilotLendingAction, g: Grounding, wallet: string | null): Plan {
  const m = copyOf(g), notes: string[] = [], subject = LENDING_SUBJECT[a.type];
  const amountPolicy = a.type === 'REPAY' ? AAVE_V3_AMOUNT_POLICY.repay : a.type === 'WITHDRAW' ? AAVE_V3_AMOUNT_POLICY.withdraw : null;
  if (amountPolicy === 'PARTIAL_ONLY' && /\b(?:all|full|max(?:imum)?|entire|tudo|todos?|total|integral|máximo|maximo)\b/i.test(g.latest ?? g.text))
    refuse(m.partialLendingOnly(a.type === 'REPAY' ? 'repay' : 'withdraw'));
  const missing: CopilotMissingField[] = [...(a.amount === null ? ['amount' as const] : []), ...(a.asset === null ? ['asset' as const] : [])];
  // BUILD-ETHEREUM-001: each Aave asset has its own deployments (USDC on Base Sepolia — and, BUILD-BASE-001, Base mainnet — WBTC on Ethereum
  // Sepolia), so the asset bounds the network.
  // BUILD AAVE-V3-EXPANSION-001: the asset options are the named market's first reserves (its original verified asset first).
  const reserveOptions = a.network === null || a.network === 'OTHER' ? ['USDC', 'WETH', 'WBTC'] : lendingReservesFor(COPILOT_NETWORK_LABEL[a.network]).slice(0, 4).map(reserve => reserve.symbol);
  if (missing.length) ask(missing, stillNeeds(m, missing, subject), !missing.includes('asset') ? [] : reserveOptions.length ? reserveOptions : ['USDC', 'WBTC']);
  const namedCatalog = g.policy.catalog && namedNetworks(g).some(isCatalogNetwork);
  // Without a named catalog network, the networks are those whose market lists a reserve with exactly this label (USDC when none does).
  const wanted = a.asset && a.asset !== 'OTHER' ? lendingOffers().find(offer => offer.asset.toLowerCase() === a.asset!.toLowerCase())?.asset ?? null : null;
  // When no network this conversation may use lists that reserve, the original default networks answer (and refuse the asset there).
  const preferred = wanted ? lendingNetworks(wanted, g) : [];
  const supported = lendingNetworks(namedCatalog ? null : preferred.length ? wanted : a.asset === 'WBTC' ? 'WBTC' : 'USDC', g);
  const network = resolveNetwork(a.network, supported, g, 'aave', notes);
  const catalog = g.policy.catalog && isCatalogNetwork(network);
  // A known unsupported reserve can be refused from protocol profiles even before the token catalog is available.
  const legacy = a.asset === null ? null : legacyAsset(a.asset);
  if (catalog && legacy && !lendingOffers(subject).some(offer => offer.network.copilot === network && offer.asset === legacy)) refuse(m.aaveOnlyCatalog);
  // The market's own reserve, named by the user (its label, grounded in their words) and identity-checked against the catalog when loaded;
  // otherwise the official catalog resolves the token, which must then be one of the market's reserves.
  const asset = (catalog ? aaveReserveNamed(a.asset, network, g) : null)
    ?? (catalog ? catalogToken(a.asset, network, g, subject, 'asset', 'ERC20', notes).asset.symbol : needAsset(a.asset, g, subject, 'asset'));
  if (!lendingOffers(subject).some(offer => offer.network.copilot === network && offer.asset === asset))
    refuse(g.policy.catalog ? m.aaveOnlyCatalog : m.aaveOnly);
  // BUILD AAVE-V3-EXPANSION-001: the user's words name a longer reserve of this market that contains the model's asset (USDC.e vs USDC,
  // PT-USDe-… vs USDe) and never the asset on its own: FloFi asks which reserve instead of choosing one.
  const longer = g.carried.has('asset') ? [] : longerReservesWritten(asset, network, g);
  if (longer.length && !reserveLabelWritten(g.text, asset)) ask(['asset'], m.tokenNotFound(asset), [asset, ...longer]);
  // Native ETH is never an Aave reserve: "supply my ETH" is not silently turned into WETH (which the wallet may not hold); FloFi asks.
  if (!g.carried.has('asset') && /^weth$/i.test(asset) && !reserveLabelWritten(g.text, asset) && !/\bwrapped\s+eth(?:er)?\b/i.test(g.text) && /\b(?:eth|ether)\b/i.test(g.text))
    ask(['asset'], m.aaveNativeEth, ['WETH']);
  const amount = amountOf(a.amount, g, subject), on = COPILOT_NETWORK_LABEL[network];
  if (MAINNETS.has(network)) notes.push(m.catalogFundsNote(on));
  if (a.type === 'WITHDRAW') {
    if (a.beneficiary !== null) refuse(m.withdrawToWallet);
    notes.push(m.connectedRecipientNote);
    return { sentence: `withdraw ${amount} ${asset} from Aave on ${on}`, expect: 'ADD_WITHDRAW', notes };
  }
  const beneficiary = addressOf(a.beneficiary, g, 'beneficiary');
  if (!beneficiary && !wallet) ask(['beneficiary'], stillNeeds(m, ['beneficiary'], subject));
  if (!beneficiary) notes.push(m.beneficiaryNote(wallet!));
  const suffix = beneficiary ? ` beneficiary ${beneficiary}` : '';
  return a.type === 'SUPPLY' ? { sentence: `supply ${amount} ${asset} to Aave on ${on}${suffix}`, expect: 'ADD_SUPPLY', notes }
    : a.type === 'BORROW' ? { sentence: `borrow ${amount} ${asset} from Aave on ${on}${suffix}`, expect: 'ADD_BORROW', notes }
    : { sentence: `repay ${amount} ${asset} to Aave on ${on}${suffix}`, expect: 'ADD_REPAY', notes };
}

export const COPILOT_POOLS = Object.freeze({
  UNISWAP_V3: { network: 'BASE_SEPOLIA' as const, base: 'WETH', quote: 'USDC', first: 'USDC', second: 'WETH', expect: 'ADD_UNISWAP_LIQUIDITY' as const,
    slippage: UNISWAP_LIQUIDITY_DEFAULT_SLIPPAGE, symbol: (asset: string) => { const a = asset.toUpperCase(); return a === 'USDC' ? 'USDC' : a === 'WETH' || a === 'ETH' ? 'WETH' : null; } },
  ORCA: { network: 'SOLANA_DEVNET' as const, base: 'SOL', quote: 'devUSDC', first: 'SOL', second: 'devUSDC', expect: 'ADD_SOLANA_LIQUIDITY' as const,
    slippage: SOLANA_LIQUIDITY_DEFAULT_SLIPPAGE, symbol: (asset: string) => { const a = legacyAsset(asset) ?? asset.toUpperCase(); return a === 'SOL' ? 'SOL' : a === 'DEVUSDC' || a === 'USDC' ? 'devUSDC' : null; } },
});
function planLiquidity(a: CopilotLiquidityAction, g: Grounding): Plan {
  const m = copyOf(g), notes: string[] = [], text = g.text;
  const named = (source: string) => (['UNISWAP_V3', 'ORCA'] as const).filter(p => (p === 'UNISWAP_V3' ? /uniswap/i : /\borca\b|whirlpool/i).test(source) ||
    (g.carried.has('protocol') && a.protocol === p));
  const answered = g.latest === undefined ? [] : named(g.latest);
  const namedProtocols = answered.length === 1 ? answered : named(text);
  if (namedProtocols.length > 1) ask(['protocol'], m.whichPool, m.poolOptions);
  // The protocol is trusted only when the user named it or the named network determines it. Uniswap v3 runs on two test
  // networks (BUILD-ETHEREUM-001), so it never defaults to one of them.
  // BUILD-BASE-001: Uniswap v3 also runs on the catalog networks (Base, Robinhood Chain: real funds), which are always named.
  // The pool networks come from the capability truth; Orca serves its own network and Uniswap v3 every other one.
  const pools = actionNetworks('add_liquidity', g), orca = pools.filter(n => n === 'SOLANA' || n === 'SOLANA_DEVNET'), uniswap = pools.filter(n => !orca.some(value => value === n));
  const supported: Network[] = namedProtocols.length ? namedProtocols[0] === 'UNISWAP_V3' ? uniswap : orca : pools;
  const devnetImplied = a.network === null && namedProtocols[0] !== 'UNISWAP_V3' && !namedNetworks(g).length && impliesDevnet(g, a.deposits.map(d => d.asset));
  const network = devnetImplied ? devnetByAsset(g, notes) : resolveNetwork(a.network, supported, g, 'liquidity', notes);
  if (g.policy.catalog && isCatalogNetwork(network)) {
    if (a.protocol === 'ORCA' || namedProtocols[0] === 'ORCA') ask(['protocol'], m.whichPool, m.poolOptions);
    return planCatalogLiquidity(a, g, network, notes);
  }
  const protocol = network === 'SOLANA' || network === 'SOLANA_DEVNET' ? 'ORCA' : 'UNISWAP_V3';
  // BUILD-SOLANA-MAINNET-001: the mainnet pool quotes in USDC; BUILD-P1: every question names that pool's own unit (never devUSDC on mainnet).
  const pool = network === 'SOLANA' ? { ...COPILOT_POOLS.ORCA, quote: 'USDC', second: 'USDC',
    symbol: (asset: string) => asset.toUpperCase() === 'SOL' ? 'SOL' : asset.toUpperCase() === 'USDC' ? 'USDC' : null } : COPILOT_POOLS[protocol];
  if (a.feeTier) ask(['range'], m.rangeNotFound(pool.quote, pool.base));
  if (a.protocol !== null && a.protocol !== protocol) ask(['protocol'], m.whichPool, m.poolOptions);
  const deposits = new Map<string, string>();
  for (const deposit of a.deposits) {
    const symbol = pool.symbol(deposit.asset);
    if (!symbol) refuse(m.poolTokens(pool.first, pool.second));
    if (deposits.has(symbol!)) reject('COPILOT_DUPLICATE_DEPOSIT', m.poolTokenOnce(pool.first, pool.second));
    // "The same tokens" carries the token names from a swap step (`asset:`); the amounts must still be the user's own words.
    needAsset(deposit.asset, g, 'liquidity', g.carried.has(`asset:${symbol}`) ? `asset:${symbol}` : `deposit:${symbol}`);
    deposits.set(symbol!, amountOf(deposit.maxAmount, g, 'liquidity', `deposit:${symbol}`));
  }
  // A percentage is offered only where FloFi reads a verified price for the pool: Orca, and on mainnet only on a surface that reads pools (the web
  // chat; a channel cannot); the Uniswap test pools take prices or ticks.
  const percentOffered = protocol === 'ORCA' && (network !== 'SOLANA' || !!g.poolReads);
  const units = { quote: pool.quote, base: pool.base }, openRange = rangeQuestion(a, units, m, percentOffered);
  // BUILD-P1: FloFi asks only for what is still missing, one slot at a time once the deposits are known (a bare answer then fills exactly that slot).
  if (deposits.size === 0 && openRange) ask(['amount', 'range'], m.liquidityNeeds(pool.first, pool.second, pool.quote, pool.base));
  if (deposits.size === 1) { const other = [pool.first, pool.second].find(token => !deposits.has(token))!; ask(['amount'], m.depositNeeded(other), [], other, { code: 'COPILOT_DEPOSIT_REQUIRED' }); }
  if (deposits.size === 0) ask(['amount'], m.depositsNeeded(pool.first, pool.second), [], undefined, { code: 'COPILOT_DEPOSIT_REQUIRED' });
  // Orca positions in FloFi always have a finite range (the exact grammar takes prices or ticks): the full range is never substituted silently.
  if (a.rangeUnit === 'FULL') ask(['range'], m.fullRangeUnavailable(pool.quote, pool.base, percentOffered), [], undefined, { code: 'COPILOT_RANGE_UNSUPPORTED' });
  if (a.rangeUnit === 'PERCENT' && protocol !== 'ORCA') ask(['range'], m.percentRangeOrcaOnly, [], undefined, { code: 'COPILOT_RANGE_UNSUPPORTED' });
  if (openRange) ask(['range'], openRange.question, [], undefined, { code: openRange.code });
  const range = network === 'SOLANA' ? orcaMainnetRange(a, g, notes) : protocol === 'ORCA' ? orcaRange(a, g, notes, pool.quote) : (() => {
    const lower = a.lower!, upper = a.upper!;
    const grounded = g.carried.has('range') ? true : a.rangeUnit === 'PRICE' ? !lower.startsWith('-') && !upper.startsWith('-') && groundedAmount(text, lower) && groundedAmount(text, upper)
      : /^-?\d+$/.test(lower) && /^-?\d+$/.test(upper) && groundedSigned(text, lower) && groundedSigned(text, upper);
    if (!grounded) ask(['range'], m.rangeNotFound(pool.quote, pool.base), [], undefined, { code: 'COPILOT_RANGE_NOT_FOUND' });
    return a.rangeUnit === 'PRICE' ? `from ${lower} to ${upper} ${pool.quote} per ${pool.base}` : `ticks ${lower} to ${upper}`;
  })();
  const slippage = slippageOf(a.slippageBps, pool.slippage, g, notes, undefined, true);
  return { sentence: `add liquidity ${deposits.get(pool.first)} ${pool.first} and ${deposits.get(pool.second)} ${pool.second} ${range} on ` +
    `${COPILOT_NETWORK_LABEL[network]} slippage ${slippage} bps`, expect: pool.expect, notes };
}

// ── BUILD-P1 pool conversational reliability: ranges from the user's words and verified pool reads ───────────────────────────────────
type Units = { readonly quote: string; readonly base: string };
type GoodRead = Extract<PoolPriceRead, { ok: true }>;
/** FloFi's own question for whatever part of the range is still missing; null when the range is complete. */
function rangeQuestion(a: CopilotLiquidityAction, units: Units, m: CopilotCopy, percent = true): { readonly question: string; readonly code: string } | null {
  if (a.rangeUnit === null) return { question: m.rangeNeeded(units.quote, units.base, percent), code: 'COPILOT_RANGE_REQUIRED' };
  if (a.rangeUnit === 'FULL') return null;
  if (a.rangeUnit === 'PERCENT') return a.upper === null && a.lower === null ? { question: m.percentNeeded, code: 'COPILOT_RANGE_PERCENT_REQUIRED' } : null;
  if (a.lower === null && a.upper === null) return { question: m.rangeBoundsNeeded(a.rangeUnit, units.quote, units.base), code: 'COPILOT_RANGE_REQUIRED' };
  if (a.lower === null || a.upper === null)
    return { question: m.rangeOtherBound(a.lower !== null ? 'LOWER' : 'UPPER', (a.lower ?? a.upper)!, a.rangeUnit, units.quote, units.base), code: 'COPILOT_RANGE_BOUND_REQUIRED' };
  return null;
}
/** The pool's price unit for FloFi's range questions (quote per base); null when the pool is not known yet. */
export function liquidityUnits(a: CopilotLiquidityAction): Units | null {
  const network = a.network;
  if (network === 'SOLANA' || (network === null && a.protocol === 'ORCA' && publicScope())) return { quote: 'USDC', base: 'SOL' };
  if (network === 'SOLANA_DEVNET' || (network === null && a.protocol === 'ORCA')) return { quote: COPILOT_POOLS.ORCA.quote, base: COPILOT_POOLS.ORCA.base };
  if (network === null || network === 'OTHER') return null;
  if (!isCatalogNetwork(network)) return { quote: COPILOT_POOLS.UNISWAP_V3.quote, base: COPILOT_POOLS.UNISWAP_V3.base };
  const chain = chainOf(network), tokens = a.deposits.map(deposit => {
    const found = resolveAssetReference(chain, /^eth$/i.test(deposit.asset) ? 'WETH' : deposit.asset);
    return found.kind === 'FOUND' && found.asset.kind === 'ERC20' && found.asset.address ? { symbol: found.asset.symbol, address: found.asset.address, decimals: found.asset.decimals } : null;
  });
  if (tokens.length !== 2 || !tokens[0] || !tokens[1]) return null;
  try { const view = catalogPoolView(chain, tokens[0], tokens[1], FEE_BPS[a.feeTier ?? '0.3'] ?? 3000); return { quote: view.quote, base: view.base }; } catch { return null; }
}
const FEE_BPS: Readonly<Record<string, number>> = { '0.01': 100, '0.05': 500, '0.3': 3000, '1': 10000 };
/** Words that state a range (a percentage band, bounds, ticks), in English or Portuguese; "full range" is not one of them. */
const RANGE_WORDS = new RegExp([
  String.raw`(?:±|\+\s*\/\s*-|\+-|plus or minus|mais ou menos)\s*\d`,
  String.raw`\d+(?:[.,]\d+)?\s*(?:%|percent|per\s?cent|por\s?cento)\s*,?\s*(?:range|band|wide|width|spread|around|each|either|on each|on either|on both|both|above and below|below and above|within|faixa|em torno|ao redor|para cada|pra cada|de cada|dos dois|nos dois|acima e abaixo|abaixo e acima)`,
  String.raw`-\s*\d+(?:[.,]\d+)?\s*%\s*(?:to|a|até|and|e)\s*\+?\s*\d`,
  String.raw`\b(?:within|dentro de)\s+\d+(?:[.,]\d+)?\s*(?:%|percent|por\s?cento)`,
  String.raw`\b(?:range|faixa|intervalo)\s+(?:of\s+|from\s+|de\s+)?\$?-?\d`,
  String.raw`\b(?:between|entre)\s+\$?\d[\d.,]*\s*\S*\s+(?:and|e)\s+\$?\d`,
  String.raw`\b(?:from|de)\s+\$?-?\d[\d.,]*\s*(?:[\p{L}$]+\s+)?(?:to|a|até)\s+\$?-?\d`,
  String.raw`(?<![\p{L}\p{N}.,])\$?\d+(?:[.,]\d+)?\s*[-–]\s*\$?\d+(?:[.,]\d+)?(?![\p{L}\p{N}%])`,
  String.raw`\b(?:lower|upper|inferior|superior)\s+(?:price|bound|pre[cç]o)?\s*\$?\d`,
  // "max 10 USDC" is a deposit maximum (FloFi's own question asks for maximum amounts): min/max name a bound only with a range noun.
  String.raw`\b(?:min(?:imum)?|max(?:imum)?|m[ií]nim[oa]|m[aá]xim[oa])\s+(?:price|bound|tick|pre[cç]o)\s*\$?-?\d`,
  String.raw`\bticks?\s+(?:from\s+|range\s+|of\s+)?-?\d`,
].join('|'), 'iu');
/** The user asked for the full range itself ("full range", "faixa completa"). */
const FULL_WORDS = /\b(?:full(?:[- ]price)?[- ]range|whole range|entire range|infinite range)\b|faixa (?:completa|inteira|toda|total)|toda a faixa|range (?:completo|total|inteiro)/i;
/** A bare answer that is the full range ("full", "the whole one", "completa") — only as the whole latest message. */
const FULL_ANSWER = /^\s*(?:the\s+|a\s+)?(?:full|whole|entire|completa|inteira|toda)\s*[.!]?\s*$/i;
/** What follows a percentage written as the range band ("10% around the price", "10%, on either side"). */
const RANGE_AFTER = String.raw`\s*,?\s*(?:range|band|wide|width|spread|around|each|either|on each|on either|on both|both|above|below|from|of|within|faixa|em torno|ao redor|para cada|pra cada|de cada|dos dois|nos dois|do pre[cç]o|acima|abaixo)\b`;
/** A model option's example the user clicked ("A percentage range (for example, ±10%)") is the model's example, never the user's value. */
const withoutExamples = (text: string): string => text.replace(/\((?:for example|for instance|e\.g\.|por exemplo|ex\.)[^)]*\)/gi, ' ');
/** A deposit amount with its token ("10 USDC", "0,004 ETH") is that deposit, never a range bound or a range word's number. */
function withoutDeposits(text: string, deposits: readonly { readonly asset: string; readonly maxAmount: string }[]): string {
  const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase() || (/^w?eth$/i.test(a) && /^w?eth$/i.test(b));
  return text.replace(/(?<![\d.,])(\d+(?:[.,]\d+)*)(\s*)([A-Za-z][A-Za-z0-9.]{0,11})(?![A-Za-z0-9])/g, (all, amount: string, _space: string, symbol: string) =>
    deposits.some(d => same(d.asset, symbol) && amountReadings(amount).includes(canonicalDecimal(d.maxAmount))) ? ' ' : all);
}
/**
 * A range the user wrote in `text`: range wording, or a percentage that cannot be the fee tier or the slippage (a bare "10%" answering a range
 * question), so a range the interpreter dropped is asked for instead of becoming the full range.
 */
function rangeWritten(text: string, deposits: readonly { readonly asset: string; readonly maxAmount: string }[] = []): boolean {
  const own = withoutDeposits(withoutExamples(text), deposits);
  if (RANGE_WORDS.test(own)) return true;
  return [...own.replace(OTHER_FIELD_PERCENT, ' ').matchAll(new RegExp(WRITTEN_PERCENT, 'gi'))]
    .some(match => !COPILOT_FEE_TIERS.some(tier => canonicalDecimal(tier) === percentOf(match[0])));
}
/**
 * A symmetric percentage of a PERCENT range ("±10%": upper "10"; a model's lower "-10" or "10" beside it is the same band); null when asymmetric or
 * one-sided: a lone lower bound ("10% below the price") never becomes a band whose other side the user did not give.
 */
function symmetricPercent(a: CopilotLiquidityAction): string | null {
  const upper = a.upper;
  if (upper === null || upper.startsWith('-')) return null;
  return a.lower === null || canonicalDecimal(a.lower.replace(/^-/, '')) === canonicalDecimal(upper) ? upper : null;
}
/** The percentage is the user's own: written as one ("10%", "10 percent"), or the bare number answering FloFi's own percentage question. */
const percentGrounded = (g: Grounding, percent: string) => g.carried.has('range') || groundedPercent(g.text, percent)
  || (g.answeredPercent !== undefined && canonicalDecimal(g.answeredPercent) === canonicalDecimal(percent));
/**
 * The ±percentage of a PERCENT range, checked: symmetric, the user's own, and not a percentage that names one side of the price only. Otherwise FloFi
 * asks (the request stays open).
 */
function bandPercent(a: CopilotLiquidityAction, g: Grounding, units: Units): string {
  const m = copyOf(g), percent = symmetricPercent(a), side = percent ?? (a.upper ?? a.lower)?.replace(/^-/, '') ?? null;
  // Answered: carried, the number FloFi asked for, or the same percentage stated as a band in the latest message ("±10%" after a one-sided question).
  const latestBand = side !== null && g.latest !== undefined && g.latest !== g.text && groundedPercent(g.latest, side);
  const answered = g.carried.has('range') || latestBand || (side !== null && g.answeredPercent !== undefined && canonicalDecimal(g.answeredPercent) === canonicalDecimal(side));
  if (side !== null && !answered && oneSidedPercent(g.text, side))
    return ask(['range'], m.percentOneSided(canonicalDecimal(side), units.quote, units.base), [], undefined, { code: 'COPILOT_RANGE_PERCENT_ONE_SIDED' });
  if (percent === null) return ask(['range'], m.rangeNotFound(units.quote, units.base), [], undefined, { code: 'COPILOT_RANGE_NOT_FOUND' });
  if (!percentGrounded(g, percent)) return ask(['range'], m.percentNotFound(percent), [], undefined, { code: 'COPILOT_RANGE_PERCENT_NOT_FOUND' });
  return percent;
}
/**
 * How many of the user's written numbers equal `value` and are not already claimed by another field (a deposit maximum, the other bound): a number
 * written once grounds one field only ("2800 USDC and 1 WETH" never grounds a 1–2800 range by itself).
 */
function unclaimed(text: string, value: string, claimed: readonly string[], signed: boolean): boolean {
  const negative = signed && value.startsWith('-'), wanted = canonicalDecimal(negative ? value.slice(1) : value);
  const written = numbersIn(text).filter(reading => !reading.percent && reading.value === wanted && (!signed || reading.negative === negative)).length;
  return written > claimed.filter(item => canonicalDecimal(item.replace(/^-/, '')) === wanted && item.startsWith('-') === negative).length;
}
function decimalCompare(a: string, b: string): number {
  const [ai = '0', af = ''] = a.split('.'), [bi = '0', bf = ''] = b.split('.'), n = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(n, '0')), y = BigInt(bi + bf.padEnd(n, '0'));
  return x < y ? -1 : x > y ? 1 : 0;
}
/** Explicit bounds as the user wrote them: grounded in their words (or carried), in order, and ticks on the pool's spacing. */
function explicitBounds(a: CopilotLiquidityAction, g: Grounding, units: Units, spacing: number): { readonly lower: string; readonly upper: string } {
  const m = copyOf(g), lower = a.lower!, upper = a.upper!, text = withoutExamples(g.text), price = a.rangeUnit === 'PRICE';
  // Each bound needs its own written number: one already used as a deposit maximum, the slippage (written in bps), or the other bound does not
  // count twice, for prices and ticks alike; a written percentage (a fee tier, a slippage) is never a bound.
  const deposits = a.deposits.map(deposit => deposit.maxAmount);
  const slippage = a.slippageBps !== null && new RegExp(String.raw`(?<![\d.,])${a.slippageBps}\s*(?:bps|basis\s+points?|pontos?\s+(?:de\s+)?base)|(?:slippage|deslizamento)\s*(?:of|de|:)?\s*${a.slippageBps}(?![\d.,%])`, 'i').test(text)
    ? [a.slippageBps] : [];
  const own = (value: string, other: string) => unclaimed(text, value, [...deposits, ...slippage, other], !price);
  const grounded = g.carried.has('range') ? true : (price ? !lower.startsWith('-') && !upper.startsWith('-') && groundedAmount(text, lower) && groundedAmount(text, upper)
    : /^-?\d+$/.test(lower) && /^-?\d+$/.test(upper) && groundedSigned(text, lower) && groundedSigned(text, upper)) && own(lower, upper) && own(upper, lower);
  if (!grounded) ask(['range'], m.rangeNotFound(units.quote, units.base), [], undefined, { code: 'COPILOT_RANGE_NOT_FOUND' });
  const ordered = price ? !lower.startsWith('-') && !upper.startsWith('-') && decimalCompare(canonicalDecimal(lower), canonicalDecimal(upper)) < 0 : Number(lower) < Number(upper);
  if (!ordered) ask(['range'], m.rangeOrder(lower, upper, price ? 'PRICE' : 'TICK'), [], undefined, { code: 'COPILOT_RANGE_ORDER_INVALID' });
  if (!price && (Number(lower) % spacing !== 0 || Number(upper) % spacing !== 0)) ask(['range'], m.rangeTicksInvalid(spacing), [], undefined, { code: 'COPILOT_RANGE_TICKS_INVALID' });
  return { lower, upper };
}
/**
 * The verified read of `ref` for this turn. Without one FloFi asks: the web chat reads the pool and replays the turn (the question carries the
 * pool); a surface that cannot read says exactly what it could not confirm. A percentage range is never computed from any other price.
 */
function requiredRead(ref: PoolRef, g: Grounding, label: string): GoodRead {
  const m = copyOf(g), read = poolReadFor(ref, g.pools, g.now ?? Date.now());
  if (read?.ok) return read;
  if (read && poolMissing(read.code)) return ask(['range'], m.poolNotFound(label, ref.kind !== 'ORCA'), [], undefined, { code: 'COPILOT_POOL_NOT_FOUND' });
  if (!read && g.poolReads) return ask(['range'], m.poolPriceReading, [m.retryOption], undefined, { code: 'COPILOT_POOL_PRICE_REQUIRED', pool: ref });
  // "Try again" only where the surface can read the pool again (the web chat) and another read could succeed; elsewhere FloFi says what it could
  // not confirm. FloFi's own read failures (a timeout, an unbound or malformed answer) keep their code, so the turn metrics tell them apart.
  const retry = !!g.poolReads && (!read || poolRetryable(read.code));
  const code = read && /^COPILOT_POOL_(?:READ_|IDENTITY_)/.test(read.code) ? read.code : 'COPILOT_POOL_PRICE_UNAVAILABLE';
  return ask(['range'], m.poolPriceUnavailable(label, retry), retry ? [m.retryOption] : [], undefined, { code });
}
/** A read used only to tell where an explicit range sits against the current price: a failed read never blocks it, a missing pool does. */
function advisoryRead(ref: PoolRef, g: Grounding, label: string): GoodRead | null {
  const m = copyOf(g), read = poolReadFor(ref, g.pools, g.now ?? Date.now());
  if (read && !read.ok && poolMissing(read.code)) return ask(['range'], m.poolNotFound(label, ref.kind !== 'ORCA'), [], undefined, { code: 'COPILOT_POOL_NOT_FOUND' });
  if (read) return read.ok ? read : null;
  if (g.poolReads) ask(['range'], m.poolPriceReading, [m.retryOption], undefined, { code: 'COPILOT_POOL_PRICE_REQUIRED', pool: ref });
  return null;
}
/** A conversion's closed failures become FloFi's question about the range (the request stays open). */
function converted<T>(g: Grounding, label: string, run: () => T): T {
  const m = copyOf(g);
  try { return run(); } catch (cause) {
    const code = cause instanceof Error ? cause.message : '';
    if (code === 'COPILOT_RANGE_OUT_OF_RANGE') return ask(['range'], m.percentRangeInvalid, [], undefined, { code });
    if (code === 'COPILOT_POOL_PRICE_UNAVAILABLE') return ask(['range'], m.poolPriceUnavailable(label, !!g.poolReads), g.poolReads ? [m.retryOption] : [], undefined, { code });
    return ask(['range'], m.rangeConversionInvalid, [], undefined, { code: 'COPILOT_RANGE_CONVERSION_INVALID' });
  }
}
/** What the person sees before approving: the effective (aligned) range, when and where the price was read, and where the price sits. */
function rangeNotes(m: CopilotCopy, r: ResolvedRange, units: Units, read: GoodRead | null, at: 'SLOT' | 'BLOCK'): string[] {
  return [m.effectiveRange(r.lowerPrice, r.upperPrice, units.quote, units.base, r.tickLower, r.tickUpper, r.poolOrder ?? null), ...read ? [m.priceReadAt(at, read.at)] : [],
    ...r.position ? [m.rangePosition(r.position, r.onlyToken)] : []];
}
/**
 * BUILD-P1: the Orca SOL/USDC range on Solana mainnet-beta. A percentage is ±that percent around the mainnet pool's verified price, through the
 * same bounds as the Canvas range control; explicit prices or ticks are the user's own. The aligned (effective) range is always shown.
 */
function orcaMainnetRange(a: CopilotLiquidityAction, g: Grounding, notes: string[]): string {
  const m = copyOf(g), units = { quote: 'USDC', base: 'SOL' }, label = `Orca SOL/USDC (${COPILOT_NETWORK_LABEL.SOLANA})`;
  if (a.rangeUnit === 'PERCENT') {
    const percent = bandPercent(a, g, units);
    converted(g, label, () => percentValue(percent));
    const read = requiredRead(ORCA_MAINNET_POOL, g, label), r = converted(g, label, () => orcaPercentRange(read, percent));
    notes.push(m.percentRangeIn(canonicalDecimal(percent), r.reference!, units.quote, units.base), ...rangeNotes(m, r, units, read, 'SLOT'));
    return `from ${r.lower} to ${r.upper} USDC per SOL`;
  }
  const { lower, upper } = explicitBounds(a, g, units, ORCA_WHIRLPOOLS_MAINNET_TICK_SPACING);
  const read = advisoryRead(ORCA_MAINNET_POOL, g, label);
  const r = converted(g, label, () => a.rangeUnit === 'PRICE' ? orcaPriceRange(lower, upper, read) : orcaTickRange(Number(lower), Number(upper), read));
  notes.push(...rangeNotes(m, r, units, read, 'SLOT'));
  return a.rangeUnit === 'PRICE' ? `from ${lower} to ${upper} USDC per SOL` : `ticks ${lower} to ${upper}`;
}

/** A written percentage: "10%", "10 %", "10 percent", "10 por cento". */
const WRITTEN_PERCENT = String.raw`\d+(?:[.,]\d+)?\s*(?:%|percent\b|per\s?cent\b|por\s?cento\b)`;
/** Words that make a written percentage the fee tier ("the 1% pool", "fee 0.05%") or the slippage ("slippage 1%", "1% de slippage"). */
const FEE_OR_SLIPPAGE = String.raw`fees?|tier|taxa|tarifa|pool|slippage|slip|deslizamento|derrapagem|toler[aâ]ncia|tolerance`;
const ONE_SIDE = String.raw`above|below|higher|lower|acima|abaixo`;
/**
 * A percentage that belongs to another field: one written number grounds one field only, so the fee tier's or the slippage's percentage never grounds
 * the range band as well.
 */
const fieldPercent = (words: string) => new RegExp(String.raw`\b(?:${words})(?:\s+tier)?${SLIPPAGE_GAP}${WRITTEN_PERCENT}`
  + String.raw`|${WRITTEN_PERCENT}(?=\s*(?:(?:de|of)\s+)?(?:(?:max(?:imum)?|m[aá]xim[oa])\s+)?(?:de\s+)?(?:${words})\b)`, 'giu');
const OTHER_FIELD_PERCENT = fieldPercent(FEE_OR_SLIPPAGE);
/** A percentage written as the slippage ("slippage 1%", "0.5% max slippage", "slippage de até 0,5%"): never a fee tier or a range band. */
const SLIPPAGE_PERCENT = fieldPercent(String.raw`slippage|slip|deslizamento|derrapagem|toler[aâ]ncia|tolerance`);
/** A percentage that names one side of the price only ("10% below", "5% acima"), unless both sides follow ("10% above and below"). */
const SIDE_LINK = String.raw`\s*(?:and|or|to|e|ou|a|até|&|\/)\s*(?:\d+(?:[.,]\d+)?\s*%\s*)?`;
const ONE_SIDED_PERCENT = new RegExp(String.raw`(?<!(?:${ONE_SIDE})${SIDE_LINK})(${WRITTEN_PERCENT})(?=\s*(?:${ONE_SIDE})\b(?!${SIDE_LINK}(?:${ONE_SIDE})\b))`, 'gi');
const percentOf = (written: string): string => canonicalDecimal(written.replace(/[^\d.,]/g, '').replace(',', '.'));
/** A percentage written as the range band: signed ("±10%") or followed by range wording ("10% around the price"). */
const BAND_PERCENT = new RegExp(String.raw`(?:±|\+\s*\/\s*-|\+-|plus or minus|mais ou menos)\s*${WRITTEN_PERCENT}|${WRITTEN_PERCENT}(?=${RANGE_AFTER})`, 'gi');
/** A percentage written as the fee tier: after a fee word ("fee 0.05%", "taxa de 0,05%") or before one ("the 1% pool", "0.3% fee tier"). */
const FEE_PERCENT = new RegExp(String.raw`\b(?:fee(?:\s+tier)?|tier|taxa|tarifa)\s+(?:(?:of|de|do|da)\s+)?(${WRITTEN_PERCENT})|(${WRITTEN_PERCENT})(?=\s*(?:fee|tier|pool|taxa|tarifa)\b)`, 'gi');
/** A percentage written as such for the range: not the fee tier's or the slippage's, and not one side of the price only. */
function groundedPercent(text: string, percent: string): boolean {
  const wanted = canonicalDecimal(percent), band = withoutExamples(text).replace(OTHER_FIELD_PERCENT, ' ').replace(ONE_SIDED_PERCENT, ' ');
  return numbersIn(band).some(reading => reading.value === wanted && reading.percent && !reading.negative) ||
    new RegExp(`(?<![\\d.,])${escapeRegExp(wanted)}\\s*(?:percent|per\\s?cent|por\\s?cento)\\b`, 'i').test(band);
}
const oneSidedPercent = (text: string, percent: string): boolean =>
  [...withoutExamples(text).replace(OTHER_FIELD_PERCENT, ' ').matchAll(ONE_SIDED_PERCENT)].some(match => percentOf(match[1]!) === canonicalDecimal(percent));
/**
 * The Orca SOL/devUSDC range as exact-grammar words. A percentage ("a 10% range") is ±that percent around the verified pool price FloFi read itself
 * (`g.solana.price`), through the same bounds as the Canvas range control; without a verified price nothing is proposed.
 */
function orcaRange(a: CopilotLiquidityAction, g: Grounding, notes: string[], quote = COPILOT_POOLS.ORCA.quote): string {
  const m = copyOf(g), pool = { ...COPILOT_POOLS.ORCA, quote }, text = g.text;
  if (a.rangeUnit === 'PERCENT') {
    const percent = bandPercent(a, g, { quote: pool.quote, base: pool.base });
    const value = Number(percent), bps = Math.round(value * 100);
    if (!Number.isFinite(value) || bps < 1 || bps > 9_000) return reject('COPILOT_RANGE_OUT_OF_RANGE', m.percentRangeInvalid);
    const price = g.solana?.price ?? null;
    if (!price) return reject('COPILOT_POOL_PRICE_UNAVAILABLE', m.priceUnavailable);
    const bounds = priceBoundsAround(price, -value, value);
    notes.push(m.percentRangeNote(canonicalDecimal(percent), price, bounds.lower, bounds.upper));
    return `from ${bounds.lower} to ${bounds.upper} ${pool.quote} per ${pool.base}`;
  }
  if (a.rangeUnit === null || a.rangeUnit === 'FULL' || a.lower === null || a.upper === null) return ask(['range'], m.rangeNotFound(pool.quote, pool.base), [], undefined, { code: 'COPILOT_RANGE_NOT_FOUND' });
  const lower = a.lower, upper = a.upper;
  const grounded = g.carried.has('range') ? true : a.rangeUnit === 'PRICE' ? !lower.startsWith('-') && !upper.startsWith('-') && groundedAmount(text, lower) && groundedAmount(text, upper)
    : /^-?\d+$/.test(lower) && /^-?\d+$/.test(upper) && groundedSigned(text, lower) && groundedSigned(text, upper);
  if (!grounded) ask(['range'], m.rangeNotFound(pool.quote, pool.base), [], undefined, { code: 'COPILOT_RANGE_NOT_FOUND' });
  return a.rangeUnit === 'PRICE' ? `from ${lower} to ${upper} ${pool.quote} per ${pool.base}` : `ticks ${lower} to ${upper}`;
}

/**
 * A position funded by a Solana Devnet swap's actual output (PR A's executable composition): a new swap in the same request, or the swap FloFi
 * resolved for "these tokens" (`g.solana.swap`). The swapped token's maximum is 100% of the actual reconciled output unless the user named a cap; a
 * pre-existing balance of it is never used. The other pool token needs an explicit maximum. Both steps stay separately simulated, reviewed and signed.
 */
function planSolanaComposition(swapAction: CopilotSwapAction | null, a: CopilotLiquidityAction, g: Grounding): Plan {
  const m = copyOf(g), notes: string[] = [], pool = COPILOT_POOLS.ORCA, source = swapAction ? null : g.solana?.swap ?? null;
  if (a.protocol === 'UNISWAP_V3' || (a.network !== null && a.network !== 'SOLANA_DEVNET') || a.rangeUnit === 'FULL' || a.feeTier) return refuse(m.swapOutputUnsupported);
  let swap: Pick<SolanaSwapInput, 'from' | 'to'>, swapSentence: string | null = null;
  if (swapAction) {
    const planned = planSwap(swapAction, g), words = /^swap \S+ (SOL|devUSDC) to (SOL|devUSDC) on Solana Devnet /.exec(planned.sentence);
    if (planned.expect !== 'ADD_SOLANA_SWAP' || !words) return refuse(m.swapOutputUnsupported);
    notes.push(...planned.notes);
    swap = { from: words[1] as 'SOL', to: words[2] as 'SOL' }; swapSentence = planned.sentence;
  } else if (source) {
    if (source.input.network !== 'Solana Devnet') return refuse(m.swapOutputUnsupported);
    swap = source.input;
    if (source.kind === 'NEW') swapSentence = `swap ${source.input.amount} ${source.input.from} to ${source.input.to} on Solana Devnet slippage ${source.input.slippage} bps`;
  } else return refuse(m.noSwapForTokens);
  const bound = swap.to === 'SOL' ? 'SOL' : 'devUSDC', other = bound === 'SOL' ? 'devUSDC' : 'SOL';
  let cap = 'all', otherMax: string | null = null;
  for (const deposit of a.deposits) {
    const symbol = pool.symbol(deposit.asset);
    if (!symbol) refuse(m.poolTokens(pool.first, pool.second));
    needAsset(deposit.asset, g, 'liquidity', g.carried.has(`asset:${symbol}`) ? `asset:${symbol}` : `deposit:${symbol}`);
    const value = amountOf(deposit.maxAmount, g, 'liquidity', `deposit:${symbol}`);
    if (symbol === bound) cap = value; else otherMax = value;
  }
  if (otherMax === null) return ask(['amount'], m.otherTokenMaximum(other, bound), [], other);
  const range = orcaRange(a, g, notes);
  const slippage = slippageOf(a.slippageBps, pool.slippage, g, notes, undefined, true);
  notes.push(cap === 'all' ? m.swapOutputNote(bound) : m.swapOutputCapNote(bound, cap), m.twoTransactionsNote);
  return swapSentence ? { sentence: `${swapSentence} then add liquidity ${cap} swapped ${bound} and ${otherMax} ${other} ${range} slippage ${slippage} bps`,
    expect: 'ADD_SOLANA_COMPOSITION', notes }
    : { sentence: `add liquidity ${cap} ${bound} from ${(source as Extract<SwapSource, { kind: 'STEP' }>).nodeId} and ${otherMax} ${other} ${range} on Solana Devnet slippage ${slippage} bps`,
      expect: 'ADD_SOLANA_COMPOSITION', notes };
}

/** "0.05%" written as a fee percentage (the tier must be the user's own words, or carried). */
/**
 * The fee tier as the user wrote it: next to a fee word ("fee 0.05%", "the 1% pool"), or a written percentage that is not the range band ("±1%",
 * "1% around the price"): one written percentage never grounds both the fee tier and the range.
 */
const groundedFee = (text: string, fee: string) => {
  const wanted = canonicalDecimal(fee), own = withoutExamples(text);
  if ([...own.matchAll(FEE_PERCENT)].some(match => percentOf(match[1] ?? match[2]!) === wanted)) return true;
  return numbersIn(own.replace(BAND_PERCENT, ' ').replace(SLIPPAGE_PERCENT, ' ')).some(reading => reading.percent && !reading.negative && reading.value === wanted);
};
/**
 * BUILD-BASE-001: a Uniswap v3 position on a catalog network — any two catalog ERC-20s the user named, a standard fee tier (0.3% unless the
 * user named another) and the full range unless the user gave a range. The sentence is the exact grammar's
 * (`add liquidity 100 USDC and 0.04 WETH on Base fee 0.05% slippage 100 bps`).
 * BUILD-P1: a range is ticks in the IR. Ticks the user gave are kept; a price range (quote per base, e.g. USDC per WETH) and a percentage around the
 * pool's verified on-chain price become ticks aligned outward to the pool's spacing, in the token order of the pool, and the effective range is shown.
 * A percentage is never turned into the full range or any other default.
 */
function planCatalogLiquidity(a: CopilotLiquidityAction, g: Grounding, network: Network, notes: string[]): Plan {
  const m = copyOf(g), text = g.text, label = COPILOT_NETWORK_LABEL[network];
  if (a.deposits.length < 2) ask(['amount'], m.catalogLiquidityNeeds(label));
  const tokens = a.deposits.map(deposit => {
    const token = catalogToken(deposit.asset, network, g, 'liquidity', `deposit:${deposit.asset}` as CarriedField, 'ERC20', notes);
    return { symbol: token.asset.symbol, address: token.asset.address, decimals: token.asset.decimals, ether: token.ether,
      amount: amountOf(deposit.maxAmount, g, 'liquidity', `deposit:${deposit.asset}` as CarriedField) };
  });
  if (tokens[0]!.address === tokens[1]!.address) reject('COPILOT_DUPLICATE_DEPOSIT', m.poolTokenOnce(tokens[0]!.symbol, tokens[1]!.symbol));
  const fee = a.feeTier ?? null;
  // BUILD-P1: "at 10% around the price" / "at 10%, on either side" is a range, not a fee tier; "fee 0.05%" / "taxa de 0,05%" always names the fee.
  const feeWords = new RegExp(String.raw`\b(?:fee(?: tier)?|taxa)\s+(?:(?:of|de)\s+)?([0-9]+(?:[.,][0-9]+)?)\s*%|\bat\s+([0-9]+(?:[.,][0-9]+)?)\s*%(?!${RANGE_AFTER})`, 'i')
    .exec((g.latest ?? text).replace(SLIPPAGE_PERCENT, ' '));
  const writtenFee = (feeWords?.[1] ?? feeWords?.[2])?.replace(',', '.');
  if (writtenFee && !COPILOT_FEE_TIERS.some(tier => canonicalDecimal(tier) === canonicalDecimal(writtenFee)))
    refuse(m.catalogFeeUnsupported(COPILOT_FEE_TIERS));
  if (writtenFee && fee === null && !g.carried.has('feeTier')) ask(['range'], m.feeNotFound(writtenFee));
  if (fee !== null && !g.carried.has('feeTier') && !groundedFee(text, fee)) ask(['range'], m.feeNotFound(fee));
  let range = '';
  if (a.rangeUnit === 'PERCENT' || a.rangeUnit === 'PRICE' || a.rangeUnit === 'TICK') {
    let view: CatalogPoolView;
    try {
      const token = (t: (typeof tokens)[number]) => ({ symbol: t.symbol, address: t.address!, decimals: t.decimals });
      view = catalogPoolView(chainOf(network), token(tokens[0]!), token(tokens[1]!), FEE_BPS[fee ?? '0.3']!);
    } catch { return refuse(m.catalogFeeUnsupported(COPILOT_FEE_TIERS)); }
    const units = { quote: view.quote, base: view.base }, poolName = `Uniswap v3 ${view.base}/${view.quote} ${fee ?? '0.3'}% (${label})`;
    const open = rangeQuestion(a, units, m, !!g.poolReads);
    if (open) ask(['range'], open.question, [], undefined, { code: open.code });
    let resolved: ResolvedRange, read: GoodRead | null;
    if (a.rangeUnit === 'PERCENT') {
      const percent = bandPercent(a, g, units);
      converted(g, poolName, () => percentValue(percent));
      const verified = requiredRead(view.ref, g, poolName);
      read = verified; resolved = converted(g, poolName, () => catalogPercentRange(view, verified, percent));
      notes.push(m.percentRangeIn(canonicalDecimal(percent), resolved.reference!, units.quote, units.base));
    } else {
      const { lower, upper } = explicitBounds(a, g, units, view.profile.tickSpacing);
      read = advisoryRead(view.ref, g, poolName);
      const current = read;
      resolved = converted(g, poolName, () => a.rangeUnit === 'PRICE' ? catalogPriceRange(view, lower, upper, current) : catalogTickRange(view, Number(lower), Number(upper), current));
    }
    notes.push(...rangeNotes(m, resolved, units, read, 'BLOCK'));
    range = ` ticks ${resolved.tickLower} to ${resolved.tickUpper}`;
  } else {
    // BUILD-P1: the full range is the default only when the user said nothing about a range, or asked for the full range itself. A range they wrote
    // (a percentage, bounds) that the interpreter did not report, or reported as the full range, is asked for, never replaced by the full range.
    // The full range counts as the user's only when written as a range ("full range", "faixa completa", or a bare "full" answering FloFi's
    // question) and not alongside another range in the same message ("not the full range, ±10%"); a later message's range replaces it.
    const latest = withoutExamples(g.latest ?? ''), deposits = a.deposits;
    const fullLatest = (FULL_WORDS.test(latest) || FULL_ANSWER.test(latest)) && !rangeWritten(latest.replace(new RegExp(FULL_WORDS.source, 'gi'), ' '), deposits);
    const full = a.rangeUnit === 'FULL' && (g.carried.has('range') || fullLatest || (FULL_WORDS.test(withoutExamples(text)) && !rangeWritten(latest, deposits)));
    // Once FloFi has asked for the range, the answer decides it: words written before the question are not asked about again (no question loop).
    const written = rangeWritten(latest, deposits) || (!g.rangeAsked && rangeWritten(text, deposits));
    if (!full && written) {
      const token = (t: (typeof tokens)[number]) => ({ symbol: t.symbol, address: t.address!, decimals: t.decimals });
      let units: Units = { quote: tokens[0]!.symbol, base: tokens[1]!.symbol };
      try { const view = catalogPoolView(chainOf(network), token(tokens[0]!), token(tokens[1]!), FEE_BPS[fee ?? '0.3']!); units = { quote: view.quote, base: view.base }; } catch { /* the pair's own order */ }
      ask(['range'], m.catalogRangeNeeded(units.quote, units.base, !!g.poolReads), [], undefined, { code: 'COPILOT_RANGE_REQUIRED' });
    }
    notes.push(m.fullRangeNote);
  }
  const slippage = slippageOf(a.slippageBps, ROBINHOOD_LIQUIDITY_DEFAULT_SLIPPAGE, g, notes, undefined, true);
  if (fee === null) notes.push(m.defaultFeeNote('0.3'));
  if (tokens.some(token => token.ether)) notes.push(m.wethNote);
  notes.push(m.catalogFundsNote(label));
  return { sentence: `add liquidity ${tokens[0]!.amount} ${tokens[0]!.symbol} and ${tokens[1]!.amount} ${tokens[1]!.symbol} on ${label}` +
    `${fee !== null ? ` fee ${fee}%` : ''}${range} slippage ${slippage} bps`, expect: 'ADD_CRYPTO_ACTION', notes };
}

function planComposition(actions: readonly CopilotAction[], g: Grounding, wallet: string | null): Plan {
  const m = copyOf(g);
  if (g.policy.catalog && actions.map(a => a.type).join('>') === 'SWAP>LIQUIDITY') return planSolanaComposition(actions[0] as CopilotSwapAction, actions[1] as CopilotLiquidityAction, g);
  if (actions.map(a => a.type).join('>') !== 'SUPPLY>BORROW>SWAP') return refuse(m.compositionUnsupported);
  const [supply, borrow, swap] = actions as [CopilotLendingAction, CopilotLendingAction, CopilotSwapAction];
  const notes: string[] = [];
  const missing: CopilotMissingField[] = [...(supply.amount === null || borrow.amount === null ? ['amount' as const] : []),
    ...(supply.asset === null || borrow.asset === null || swap.outputAsset === null ? ['asset' as const] : [])];
  if (missing.length) ask(missing, stillNeeds(m, missing, 'composition'));
  for (const network of new Set([supply.network, borrow.network, swap.network])) resolveNetwork(network, actionNetworks('lending_composition', g), g, 'composition', notes);
  if (needAsset(supply.asset, g, 'composition', 'asset').toUpperCase() !== 'USDC' || needAsset(borrow.asset, g, 'composition', 'asset').toUpperCase() !== 'USDC' ||
    (swap.inputAsset !== null && needAsset(swap.inputAsset, g, 'composition', 'inputAsset').toUpperCase() !== 'USDC')) refuse(m.compositionUnsupported);
  if (!['WETH', 'ETH'].includes(needAsset(swap.outputAsset, g, 'composition', 'outputAsset').toUpperCase())) refuse(m.compositionUnsupported);
  const supplied = amountOf(supply.amount, g, 'composition', 'supplyAmount'), borrowed = amountOf(borrow.amount, g, 'composition', 'borrowAmount');
  if (swap.amount !== null && canonicalDecimal(swap.amount) !== canonicalDecimal(borrowed)) refuse(m.swapUsesBorrowed);
  const slippage = slippageOf(swap.slippageBps, DEFAULT_SLIPPAGE, g, notes);
  const owners = [...new Set([supply.beneficiary, borrow.beneficiary].filter((v): v is string => v !== null).map(v => addressOf(v, g, 'beneficiary')!))];
  if (owners.length > 1) reject('COPILOT_OWNER_CONFLICT', m.sameOwner);
  if (!owners.length && !wallet) ask(['beneficiary'], stillNeeds(m, ['beneficiary'], 'composition'));
  if (!owners.length) notes.push(m.ownerNote(wallet!));
  if (swap.outputAsset?.toUpperCase() === 'ETH') notes.push(m.compositionWethNote);
  notes.push(m.debtNote);
  return { sentence: `compose supply ${supplied} USDC to Aave then borrow ${borrowed} USDC then swap borrowed USDC to WETH on Base Sepolia slippage ${slippage} bps` +
    `${owners.length ? ' owner ' + owners[0] : ''}`, expect: 'AUTHOR_LENDING', notes };
}

/** BUILD-FLOFI-UX-FIX-003: the Router amount ranges of the networks in scope (the public product names the mainnet route only). */
const routerRanges = () => (publicScope() ? ['mainnet'] as const : ['testnet', 'mainnet'] as const).map(network => {
  const option = ROUTER_NETWORK_OPTIONS[network], decimals = option.pair.source.decimals;
  return `${option.sourceLabel} → ${option.destinationLabel} ${formatTokenAmount(option.pair.minimumAmount, decimals)}–${formatTokenAmount(option.pair.maximumAmount, decimals)} USDC`;
}).join('; ');
/** A closed rejection code with deterministic copy; unknown codes are named, never explained by the model. */
export function copilotRejection(code: string, language: CopilotLanguage = 'EN'): Extract<CopilotOutcome, { kind: 'REJECTED' }> {
  const m = copilotCopy(language);
  return { kind: 'REJECTED', code, message: m.rejection[code] ?? (code === 'ROUTER_AMOUNT_OUT_OF_RANGE' ? m.routerAmountRange(routerRanges()) : m.rejectedCode(code)) };
}

const publicScope = () => activeNetworkScope() === 'PUBLIC_MAINNET';
/** A written asset as the network's catalog spells it ("eth" → ETH on Base); as written when the network or the asset is not known. */
function assetLabel(value: string, network: CopilotNetwork | null | undefined): string {
  const found = network && network !== 'OTHER' ? lookupAsset(networkOfCopilot(network).key, value) : null;
  if (found?.kind === 'FOUND') return found.identity.symbol;
  return /^[a-z]{2,6}$/.test(value) ? value.toUpperCase() : value;
}
/** BUILD-FLOFI-UX-FIX-003: the amount a single bridge or swap request says the user wants to receive, from the request's own words. */
function receivedAmount(action: CopilotAction, g: Grounding): DestinationAmount | null {
  if (g.policy.catalog !== true || g.explicitAssets === false || g.receiving !== true || (action.type !== 'BRIDGE' && action.type !== 'SWAP')) return null;
  return destinationAmounts(g.text, sentAsset(action)).at(-1) ?? null;
}
const sentAsset = (action: CopilotAction): string | null => action.type === 'SWAP' ? action.inputAsset : action.type === 'LIQUIDITY' ? null : action.asset;
function exactInputNote(wanted: DestinationAmount, action: CopilotAction, g: Grounding): string {
  const output = action.type === 'BRIDGE' ? action.outputAsset ?? null : action.type === 'SWAP' ? action.outputAsset : null;
  const network = action.type === 'BRIDGE' ? action.destinationNetwork : action.type === 'SWAP' ? action.network : null;
  // The token the user settled on ("usdc" after FloFi asked what "usd" meant), else the one written with the amount.
  const asset = output && output !== 'OTHER' && !fiatReference(output) ? output : wanted.asset;
  // A number with one reading is shown canonically; one with several ("1,000") exactly as written, never a reading FloFi chose.
  const readings = amountReadings(wanted.written);
  return copyOf(g).exactInputNote(readings.length === 1 ? readings[0]! : wanted.written, assetLabel(asset, network));
}
/**
 * The amount question of a bridge or swap names the asset sent ("How much ETH would you like to send?") once everything else is known (public
 * product), and is preceded by the exact-input explanation when the request stated an amount to receive.
 */
function amountQuestion(outcome: CopilotOutcome, action: CopilotAction, wanted: DestinationAmount | null, g: Grounding): CopilotOutcome {
  if (outcome.kind !== 'CLARIFICATION' || !outcome.missing.includes('amount') || (action.type !== 'BRIDGE' && action.type !== 'SWAP')) return outcome;
  const m = copyOf(g), sent = action.type === 'BRIDGE' ? action.asset : action.inputAsset, network = action.type === 'BRIDGE' ? action.sourceNetwork : action.network;
  let question = outcome.question;
  // Only FloFi's generic "still needs the amount" question is reworded; an ambiguity or not-found question keeps its own explanation.
  const subject = action.type === 'SWAP' ? 'swap' : 'bridge';
  if (publicScope() && outcome.missing.length === 1 && sent && sent !== 'OTHER' && !fiatReference(sent) && outcome.question === stillNeeds(m, ['amount'], subject))
    question = m.howMuchToSend(assetLabel(sent, network), subject);
  return { ...outcome, question: wanted ? `${exactInputNote(wanted, action, g)} ${question}` : question };
}

/**
 * One validated action (or the lending composition) → the canonical sentence Flofi would type, or the clarification,
 * refusal or rejection that stops it. Pure. Values come only from the grounding context.
 */
export function planCopilotActions(actions: readonly CopilotAction[], composition: boolean, g: Grounding, wallet: string | null):
  { readonly kind: 'PLAN'; readonly plan: Plan } | Exclude<CopilotOutcome, { kind: 'PROPOSAL' }> {
  try {
    for (const candidate of actions) { testNetworkGuard(candidate, g); fiatGuard(candidate, g); }
    if (composition) return { kind: 'PLAN', plan: planComposition(actions, g, wallet) };
    let action = g.policy.catalog && g.explicitAssets !== false ? groundExplicitAssets(actions[0]!, g.latest ?? g.text, g.lexicon, g.receiving === true) : actions[0]!;
    fiatGuard(action, g);
    if (g.policy.catalog && action.type === 'LIQUIDITY' && action.funding === 'SWAP_OUTPUT') return { kind: 'PLAN', plan: planSolanaComposition(null, action, g) };
    // BUILD-FLOFI-UX-FIX-003: "bridge ETH to 1 USDC" states what the user wants to receive. That number is never the amount sent (every provider
    // FloFi uses quotes the amount sent), so FloFi asks for the amount to send and says why it cannot target the received amount exactly.
    const wanted = receivedAmount(action, g);
    if (wanted && (action.type === 'BRIDGE' || action.type === 'SWAP') && action.amount !== null && !g.carried.has('amount') &&
      !groundedAmount(withoutDestinationAmounts(g.text, sentAsset(action)), action.amount)) action = { ...action, amount: null };
    try {
      const plan = action.type === 'SWAP' ? planSwap(action, g) : action.type === 'BRIDGE' ? planBridge(action, g)
        : action.type === 'LIQUIDITY' ? planLiquidity(action, g) : action.type === 'TRANSFER' ? planTransfer(action, g) : planLending(action, g, wallet);
      return { kind: 'PLAN', plan: wanted ? { ...plan, notes: [exactInputNote(wanted, action, g), ...plan.notes] } : plan };
    } catch (stop) {
      if (stop instanceof Stop) throw new Stop(amountQuestion(stop.outcome, action, wanted, g));
      throw stop;
    }
  } catch (cause) {
    if (cause instanceof Stop) return cause.outcome as Exclude<CopilotOutcome, { kind: 'PROPOSAL' }>;
    return copilotRejection('COPILOT_CONVERSION_FAILED', g.policy.language);
  }
}
/** The canonical sentence → the exact grammar → the planned authoring Command at the current revision, or a rejection. */
export function proposalFromPlan(plan: Plan, input: Omit<CopilotConversion, 'userText'>, language: CopilotLanguage = 'EN'): CopilotOutcome {
  let command: Command;
  try { command = parseLocalCommand(plan.sentence, input.workflow, input.context, input.wallet); }
  catch (cause) {
    const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'COPILOT_SENTENCE_UNMATCHED';
    return copilotRejection(code, language);
  }
  // Defense in depth: the sentence must have produced exactly the planned authoring command at the current revision.
  if (command.type !== plan.expect || command.source !== 'CHAT' || command.baseRevision !== input.workflow.revision) return copilotRejection('COPILOT_COMMAND_MISMATCH', language);
  return { kind: 'PROPOSAL', command, sentence: plan.sentence, notes: [...new Set(plan.notes)] };
}

/**
 * Untrusted intent → existing typed `Command`, or a clarification / unsupported / rejected outcome. Pure: it reads the
 * workflow only for its revision and the existing grammar's checks, and never mutates state. `userText` is the user's
 * own messages in the current clarification thread, used for grounding.
 */
export function copilotIntentToCommand(raw: unknown, input: CopilotConversion): CopilotOutcome {
  let intent;
  try { intent = parseCopilotIntent(raw); } catch (cause) { return copilotRejection(cause instanceof CopilotIntentError ? cause.message : 'COPILOT_INTENT_INVALID'); }
  const text = typeof input.userText === 'string' ? input.userText : '';
  const m = copilotCopy('EN');
  if (intent.kind === 'UNSUPPORTED') return { kind: 'UNSUPPORTED', message: safeCopilotProse(intent.reason) ?? m.cannotAuthor };
  if (intent.kind === 'CLARIFICATION_REQUIRED') return { kind: 'CLARIFICATION', missing: intent.missing,
    question: safeCopilotProse(intent.question) ?? stillNeeds(m, intent.missing.length ? intent.missing : ['amount'], 'request'),
    options: intent.options.flatMap(option => safeCopilotProse(option) ?? []) };
  const planned = planCopilotActions(intent.kind === 'COMPOSITION' ? intent.actions : [intent.action], intent.kind === 'COMPOSITION',
    { text, carried: NOTHING_CARRIED, policy: V1_POLICY }, input.wallet);
  return planned.kind === 'PLAN' ? proposalFromPlan(planned.plan, input) : planned;
}
