// SPDX-License-Identifier: AGPL-3.0-only
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import { parseLocalCommand, type Command } from './commands';
import type { Workflow } from './initial-workflow';
import { ROUTER_DEFAULT_SLIPPAGE, ROUTER_NETWORK_OPTIONS } from './router-authoring';
import { formatTokenAmount } from './jupiter-authoring';
import { UNISWAP_LIQUIDITY_DEFAULT_SLIPPAGE } from './uniswap-liquidity-authoring';
import { ROBINHOOD_LIQUIDITY_DEFAULT_SLIPPAGE } from './robinhood-liquidity-authoring';
import { SOLANA_LIQUIDITY_DEFAULT_SLIPPAGE } from './solana-liquidity-authoring';
import type { SolanaSwapInput } from './jupiter-authoring';
import { priceBoundsAround } from './pool-price-bounds';
import { COPILOT_FEE_TIERS, COPILOT_LIMITS, CopilotIntentError, parseCopilotIntent, safeCopilotProse, type CopilotAction, type CopilotAsset, type CopilotBridgeAction,
  type CopilotLegacyAsset, type CopilotLendingAction, type CopilotLiquidityAction, type CopilotMissingField, type CopilotNetwork, type CopilotSwapAction,
  type CopilotTransferAction } from './copilot-intent';
import { copilotCopy, type CopilotCopy, type CopilotLanguage, type NetworkSubject, type Subject } from './copilot-messages';
import { AAVE_V3_AMOUNT_POLICY, assetDisplayName, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { copilotNetworksFor, lendingOffers, routeLabels, type StrategyAction } from './authoring-capabilities';
import { resolveAssetReference } from './asset-catalogs';
import { COPILOT_NETWORK_IDS, copilotNetworksMentioned, catalogNetworkOfChatName, networkIdentity, networkOfCopilot, type CopilotNetworkId } from './network-registry';
import { routerNetworksOf } from './router-authoring';
import { checkRecipient } from './recipient-address';
import { lexiconAssets, lexiconNamedNetworkIds, lexiconNetworks, targetEnvironment, type LexiconEntry } from './copilot-lexicon';

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
export type CopilotOutcome =
  | { readonly kind: 'PROPOSAL'; readonly command: Command; readonly sentence: string; readonly notes: readonly string[] }
  | { readonly kind: 'CLARIFICATION'; readonly missing: readonly CopilotMissingField[]; readonly question: string; readonly options: readonly string[];
      /** PR B: the pool token whose maximum the question asks for, so a bare amount can answer it. */ readonly deposit?: 'SOL' | 'devUSDC' }
  | { readonly kind: 'UNSUPPORTED'; readonly message: string }
  | { readonly kind: 'REJECTED'; readonly code: string; readonly message: string };
export type CopilotConversion = { readonly userText: string; readonly workflow: Workflow; readonly context: ReviewContext; readonly wallet: string | null };
export const COPILOT_AUTOMATION_AUTHORING_INTENT = 'AUTOMATION' as const;
/** Automation authoring uses a separate typed draft, never a workflow/execution Command. */
/** The only Command types an AI interpretation can produce: new authoring proposals, never edits, removals or execution. */
export const COPILOT_AUTHORING_COMMANDS = Object.freeze(['ADD_SWAP', 'ADD_TESTNET_SWAP', 'ADD_ETHEREUM_SEPOLIA_SWAP', 'ADD_SOLANA_SWAP', 'ADD_ROUTER_BRIDGE', 'ADD_SUPPLY', 'ADD_BORROW',
  'ADD_REPAY', 'ADD_WITHDRAW', 'ADD_UNISWAP_LIQUIDITY', 'ADD_SOLANA_LIQUIDITY', 'AUTHOR_LENDING',
  // BUILD-BASE-001: catalog-network swaps and positions (the Canvas action command) and catalog-network transfers, as the exact grammar authors them.
  'ADD_CRYPTO_ACTION', 'ADD_RH_TRANSFER',
  // PR B: a Solana Devnet swap's output funding an Orca position, added and linked exactly as the Canvas does.
  'ADD_SOLANA_COMPOSITION'] as const);
export type CopilotAuthoringCommand = (typeof COPILOT_AUTHORING_COMMANDS)[number];
export const COPILOT_CAPABILITIES = copilotCopy('EN').capabilities;

/**
 * How the planners treat unstated networks and which language they reply in. `catalog` (BUILD-BASE-001, CopilotIntentV2): the catalog networks
 * (Base, Robinhood Chain) with their catalog tokens, transfers, Base mainnet Aave and every Router route; V1 keeps its original vocabulary.
 */
export type PlanningPolicy = { readonly language: CopilotLanguage; readonly networkDefaults: boolean; readonly catalog?: boolean };
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
   * BUILD-CHAT-LEARNING-001: learned vocabulary (`copilot-lexicon.ts`). It only widens which networks and tokens the user *named*: the user's
   * own meanings (this conversation's, or saved for their verified identity) name networks and tokens; FloFi's reviewed glossary names test
   * networks only. It never grounds an amount, a slippage, a range, a fee or an address.
   */
  readonly lexicon?: readonly LexiconEntry[] };
const NOTHING_CARRIED: ReadonlySet<CarriedField> = new Set();

type Network = Exclude<CopilotNetwork, 'OTHER'>;
// BUILD-BASE-001: the network vocabulary (identifiers, names, environment, family, how a message names a network) is the network registry's.
type Family = string;
const NETWORK_IDS: readonly Network[] = COPILOT_NETWORK_IDS;
const FAMILY: Readonly<Record<Network, Family>> = Object.freeze(Object.fromEntries(NETWORK_IDS.map(id => [id, networkOfCopilot(id).family])) as Record<Network, Family>);
/** Display labels from the network registry (Base, Arbitrum One, Robinhood Chain, …). */
export const COPILOT_NETWORK_LABEL: Readonly<Record<Network, string>> = Object.freeze(Object.fromEntries(NETWORK_IDS.map(id => [id, networkOfCopilot(id as CopilotNetworkId).name])) as
  Record<Network, string>);
// BUILD-ETHEREUM-001: ETHEREUM ("Ethereum" without Sepolia) is in no action's supported list, so it never resolves; it is always clarified.
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
  return copilotNetworksFor(action).filter(id => g.policy.catalog === true || !isCatalogNetwork(id) || (action === 'swap' && id === V1_REFERENCE_SWAP));
}
const chainOf = (network: Network) => networkOfCopilot(network as CopilotNetworkId).chain;
// Any test-network or test-token wording rules out a mainnet (real funds) interpretation.
export const TESTNET_WORDS = /\b(?:sepolia|devnet|testnets?|test\s?net(?:work)?|test\s+(?:usdc|tokens?|funds?|sol|eth)|dev\s?usdc|teste|testes|de\s+teste)\b/i;
const ASSET_MENTIONS: Readonly<Record<Exclude<CopilotLegacyAsset, 'OTHER'>, RegExp>> = {
  // `\busdc` does not match inside "devUSDC": there is no word boundary between "v" and "U".
  USDC: /\busdc\b/i, DEVUSDC: /\b(?:dev\s?usdc|test\s?usdc)\b/i, WETH: /\bw?eth\b|\bether\b/i, ETH: /\bw?eth\b|\bether\b/i,
  SOL: /\bsol\b/i, USDT: /\b(?:usdt|tether)\b/i, WBTC: /\bwbtc\b/i,
};

/** Networks the user named, in any language that uses the network names (each by its network registry `mention`). */
export function mentionedNetworks(text: string): Network[] {
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
/** Every exact reading of one written number: 1.5 / 1,5 as decimals, 1,000 / 1.000 as grouped thousands, 1,000.50 and 1.000,50. */
export function amountReadings(token: string): string[] {
  const out: string[] = [];
  if (/^\d+(?:\.\d+)?$/.test(token)) out.push(token);
  if (/^\d+,\d+$/.test(token)) out.push(token.replace(',', '.'));
  if (/^\d{1,3}(?:\.\d{3})+$/.test(token) || /^\d{1,3}(?:,\d{3})+$/.test(token)) out.push(token.replace(/[.,]/g, ''));
  if (/^\d{1,3}(?:,\d{3})+\.\d+$/.test(token)) out.push(token.replace(/,/g, ''));
  if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(token)) out.push(token.replace(/\./g, '').replace(',', '.'));
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
function groundedSigned(text: string, value: string): boolean {
  const negative = value.startsWith('-'), wanted = canonicalDecimal(negative ? value.slice(1) : value);
  return numbersIn(text).some(reading => reading.value === wanted && reading.negative === negative);
}
const percentToBps = (value: string): string | null => {
  const [whole, fraction = ''] = value.split('.');
  return fraction.length > 2 ? null : String(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')));
};
/** Basis points written as such ("50 bps", "slippage 50") or as a percentage ("0.5%"), only when the user mentions slippage at all. */
export function groundedBps(text: string, value: string): boolean {
  if (!/slippage|slip|bps|basis\s+points?|pontos?\s+base|deslizamento|toler|%/i.test(text)) return false;
  return numbersIn(text).some(reading => !reading.negative && (reading.value === value || (reading.percent && percentToBps(reading.value) === value)));
}
export function groundedAddress(text: string, address: string): boolean {
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
const ask = (missing: CopilotMissingField[], question: string, options: readonly string[] = [], deposit?: 'SOL' | 'devUSDC'): never => {
  throw new Stop({ kind: 'CLARIFICATION', missing, question, options, ...deposit ? { deposit } : {} });
};
const refuse = (message: string): never => { throw new Stop({ kind: 'UNSUPPORTED', message }); };
const reject = (code: string, message: string): never => { throw new Stop({ kind: 'REJECTED', code, message }); };
const labels = (networks: readonly Network[]) => networks.map(n => COPILOT_NETWORK_LABEL[n]);
const copyOf = (g: Grounding): CopilotCopy => copilotCopy(g.policy.language);
const stillNeeds = (m: CopilotCopy, missing: readonly CopilotMissingField[], subject: Subject) => m.stillNeeds(m.subject[subject], missing.map(field => m.field[field]));

/** A network can only default when it is the action's single, test-token deployment and the user named no other network of that family. */
function defaultNetwork(supported: readonly Network[], g: Grounding): Network | null {
  const only = supported.length === 1 ? supported[0]! : null;
  return only && !MAINNETS.has(only) && !namedNetworks(g).some(n => FAMILY[n] === FAMILY[only]) ? only : null;
}
function resolveNetwork(value: CopilotNetwork | null, supported: readonly Network[], g: Grounding, subject: NetworkSubject, notes: string[]): Network {
  const m = copyOf(g), what = m.networkSubject[subject], named = namedNetworks(g), options = labels(supported);
  const carried = value !== null && value !== 'OTHER' && g.carried.has('network');
  if (value === 'OTHER') return ask(['network'], m.networkOnlyOn(what, options), options);
  // "Ethereum" without Sepolia never means Ethereum Mainnet (not executable in Flofi) nor silently Ethereum Sepolia: Flofi asks.
  const ethereumOnly = named.includes('ETHEREUM') && !named.includes('ETHEREUM_SEPOLIA') && !carried;
  if (value === 'ETHEREUM' || (ethereumOnly && (value === 'ETHEREUM_SEPOLIA' || (value === null && !supported.some(n => named.includes(n))))))
    return ask(['network'], m.ethereumWhichNetwork(what, options), options);
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
function amountOf(value: string | null, g: Grounding, subject: Subject, field: CarriedField = 'amount'): string {
  const m = copyOf(g);
  if (value === null) return ask(['amount'], stillNeeds(m, ['amount'], subject));
  if (!g.carried.has(field) && !groundedAmount(g.text, value)) return ask(['amount'], m.amountNotFound(value));
  return value;
}
function slippageOf(value: string | null, fallback: string, g: Grounding, notes: string[], maximum?: number): string {
  const m = copyOf(g);
  if (value === null) { notes.push(m.defaultSlippageNote(fallback)); return fallback; }
  if (!g.carried.has('slippage') && !groundedBps(g.text, value)) return ask(['slippage'], m.slippageNotFound(value));
  if (maximum !== undefined && Number(value) > maximum) return reject('COPILOT_SLIPPAGE_OUT_OF_RANGE', m.slippageAtMost(maximum));
  return value;
}
function addressOf(value: string | null, g: Grounding, field: 'beneficiary' | 'recipient', notFound = copyOf(g).addressNotFound(field)): string | null {
  if (value !== null && !g.carried.has(field) && !groundedAddress(g.text, value)) return ask([field], notFound);
  return value;
}
function needAsset(value: CopilotAsset | null, g: Grounding, subject: Subject, field: CarriedField): Exclude<CopilotAsset, 'OTHER'> {
  const m = copyOf(g);
  if (value === null) return ask(['asset'], stillNeeds(m, ['asset'], subject));
  if (value === 'OTHER') return refuse(m.tokenUnsupported(m.tokenSubject[subject]));
  if (!g.carried.has(field) && !assetNamed(g.text, value) && !lexiconNamesAsset(g, value)) return ask(['asset'], m.tokenNotFound(value));
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
  if (value === null) return ask(['asset'], stillNeeds(m, ['asset'], subject));
  if (value === 'OTHER') return refuse(m.tokenUnsupported(m.tokenSubject[subject]));
  const ether = /^eth$/i.test(value) && kinds === 'ERC20';
  const found = resolveAssetReference(chain, ether ? 'WETH' : value);
  if (found.kind === 'UNAVAILABLE') return reject('ASSET_CATALOG_UNAVAILABLE', m.catalogUnavailable(label));
  if (found.kind === 'UNKNOWN') return refuse(m.catalogTokenUnknown(value, label));
  if (found.kind === 'AMBIGUOUS') {
    const options = found.assets.map(asset => asset.symbol).slice(0, COPILOT_LIMITS.maxOptions);
    return ask(['asset'], m.catalogTokenAmbiguous(value, label), options);
  }
  const asset = found.asset;
  if (kinds === 'ERC20' && asset.kind !== 'ERC20') return refuse(m.catalogTokenUnknown(value, label));
  const grounded = g.carried.has(field) || lexiconNamesAsset(g, value) || (found.by === 'SYMBOL' && symbolNamed(g.text, value)) || (/^eth$/i.test(value) && ASSET_MENTIONS.ETH.test(g.text)) ||
    nameNamed(g.text, asset);
  if (!grounded) return ask(['asset'], m.tokenNotFound(value));
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
  // A generic "Ethereum" is left to resolveNetwork, which explains that Ethereum Mainnet is never used.
  const named = namedNetworks(g);
  const devnetImplied = a.network === null && !named.length && impliesDevnet(g, [a.inputAsset, a.outputAsset]);
  const missing: CopilotMissingField[] = [...(a.amount === null ? ['amount' as const] : []), ...(a.inputAsset === null || a.outputAsset === null ? ['asset' as const] : []),
    ...(a.network === null && !devnetImplied && !supported.some(n => named.includes(n)) && !named.includes('ETHEREUM') ? ['network' as const] : [])];
  if (missing.length) ask(missing, stillNeeds(m, missing, 'swap'), missing.length === 1 && missing[0] === 'network' ? labels(supported) : []);
  const network = devnetImplied ? devnetByAsset(g, notes) : resolveNetwork(a.network, supported, g, 'swap', notes);
  // BUILD-BASE-001: on a catalog network any two catalog ERC-20s; Base's USDC ⇄ WETH keeps its BUILD-002 sentence and command.
  if (g.policy.catalog && isCatalogNetwork(network)) {
    const input = catalogToken(a.inputAsset, network, g, 'swap', 'inputAsset', 'ERC20', notes), output = catalogToken(a.outputAsset, network, g, 'swap', 'outputAsset', 'ERC20', notes);
    if (input.asset.address === output.asset.address) reject('INVALID_ASSET_PAIR', m.differentTokens);
    const amount = amountOf(a.amount, g, 'swap');
    const slippage = slippageOf(a.slippageBps, '50', g, notes);
    if (input.ether || output.ether) notes.push(m.wethNote);
    const from = input.asset.symbol, to = output.asset.symbol, label = COPILOT_NETWORK_LABEL[network];
    if (network === 'BASE' && [from, to].every(symbol => symbol === 'USDC' || symbol === 'WETH'))
      return { sentence: `swap ${amount} ${from} to ${to} on Base slippage ${slippage} bps`, expect: 'ADD_SWAP', notes };
    notes.push(m.catalogFundsNote(label));
    return { sentence: `swap ${amount} ${from} to ${to} on ${label} slippage ${slippage} bps`, expect: 'ADD_CRYPTO_ACTION', notes };
  }
  const input = needAsset(a.inputAsset, g, 'swap', 'inputAsset'), output = needAsset(a.outputAsset, g, 'swap', 'outputAsset');
  const amount = amountOf(a.amount, g, 'swap');
  const slippage = slippageOf(a.slippageBps, '50', g, notes);
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
  a.sourceNetwork === 'ARBITRUM' || a.destinationNetwork === 'BASE' || /^usdg$/i.test(a.asset ?? '') || namedNetworks(g).includes('ROBINHOOD'));
function planRoute(a: CopilotBridgeAction, g: Grounding): Plan {
  const m = copyOf(g), notes: string[] = [], text = g.text;
  const named = [...namedNetworks(g), ...(['sourceNetwork', 'destinationNetwork'] as const).flatMap(field => {
    const value = a[field]; return value !== null && value !== 'OTHER' && g.carried.has(field) ? [value] : []; })];
  // A side counts only when the user named that network (or it was carried): a mainnet is never inferred.
  const side = (value: CopilotNetwork | null): Network | null | 'OTHER' => value === null ? null : value === 'OTHER' ? 'OTHER' : named.includes(value) ? value : null;
  const source = side(a.sourceNetwork), destination = side(a.destinationNetwork);
  if (source === 'OTHER' || destination === 'OTHER') return refuse(m.routerRoutesAll(routeLabels()));
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
  if (asset.toUpperCase() !== route.token) refuse(m.routerTokenOnly(route.token, route.option.sourceLabel));
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

function planBridge(a: CopilotBridgeAction, g: Grounding): Plan {
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
  const pairs = [ROUTER_NETWORK_OPTIONS.testnet, ROUTER_NETWORK_OPTIONS.mainnet].map(option => `${option.sourceLabel} → ${option.destinationLabel}`);
  let source = side(a.sourceNetwork, 'base'), destination = side(a.destinationNetwork, 'arbitrum');
  if (source === 'OTHER' || destination === 'OTHER') refuse(g.policy.catalog ? m.routerRoutesAll(routeLabels()) : m.routerRoutes);
  if (source === 'CONFLICT' || destination === 'CONFLICT') ask(['sourceNetwork', 'destinationNetwork'], m.whichRoute, pairs);
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
  if (asset !== ROUTER_NETWORK_OPTIONS[network].pair.source.symbol) refuse(m.routerUsdcOnly);
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
const SELF_RECIPIENT = /\b(?:to|into)\s+(?:me|myself|my(?:\s+own)?(?:\s+connected)?\s+wallet)\b|\b(?:para|pra)\s+(?:mim(?:\s+mesm[oa])?|(?:a\s+)?minha(?:\s+própria)?\s+carteira)(?![\p{L}\p{N}])/iu;
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
  return lendingOffers().filter(offer => (asset === null || offer.asset === asset) && offer.network.copilot !== null && actionNetworks('supply', g).includes(offer.network.copilot))
    .map(offer => offer.network.copilot as Network);
}
function planLending(a: CopilotLendingAction, g: Grounding, wallet: string | null): Plan {
  const m = copyOf(g), notes: string[] = [], subject = LENDING_SUBJECT[a.type];
  const amountPolicy = a.type === 'REPAY' ? AAVE_V3_AMOUNT_POLICY.repay : a.type === 'WITHDRAW' ? AAVE_V3_AMOUNT_POLICY.withdraw : null;
  if (amountPolicy === 'PARTIAL_ONLY' && /\b(?:all|full|max(?:imum)?|entire|tudo|todos?|total|integral|máximo|maximo)\b/i.test(g.latest ?? g.text))
    refuse(m.partialLendingOnly(a.type === 'REPAY' ? 'repay' : 'withdraw'));
  const missing: CopilotMissingField[] = [...(a.amount === null ? ['amount' as const] : []), ...(a.asset === null ? ['asset' as const] : [])];
  // BUILD-ETHEREUM-001: each Aave asset has its own deployments (USDC on Base Sepolia — and, BUILD-BASE-001, Base mainnet — WBTC on Ethereum
  // Sepolia), so the asset bounds the network.
  if (missing.length) ask(missing, stillNeeds(m, missing, subject), !missing.includes('asset') ? [] : a.network === 'ETHEREUM_SEPOLIA' ? ['WBTC']
    : a.network === 'BASE_SEPOLIA' || a.network === 'BASE' ? ['USDC'] : ['USDC', 'WBTC']);
  const namedCatalog = g.policy.catalog && namedNetworks(g).some(isCatalogNetwork);
  const supported = lendingNetworks(namedCatalog ? null : a.asset === 'WBTC' ? 'WBTC' : 'USDC', g);
  const network = resolveNetwork(a.network, supported, g, 'aave', notes);
  const catalog = g.policy.catalog && isCatalogNetwork(network);
  const asset = catalog ? catalogToken(a.asset, network, g, subject, 'asset', 'ERC20', notes).asset.symbol : needAsset(a.asset, g, subject, 'asset');
  if (!lendingOffers(subject).some(offer => offer.network.copilot === network && offer.asset === asset))
    refuse(g.policy.catalog ? m.aaveOnlyCatalog : m.aaveOnly);
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
  const pools = actionNetworks('add_liquidity', g), orca = pools.filter(n => n === COPILOT_POOLS.ORCA.network), uniswap = pools.filter(n => n !== COPILOT_POOLS.ORCA.network);
  const supported: Network[] = namedProtocols.length ? namedProtocols[0] === 'UNISWAP_V3' ? uniswap : orca : pools;
  const devnetImplied = a.network === null && namedProtocols[0] !== 'UNISWAP_V3' && !namedNetworks(g).length && impliesDevnet(g, a.deposits.map(d => d.asset));
  const network = devnetImplied ? devnetByAsset(g, notes) : resolveNetwork(a.network, supported, g, 'liquidity', notes);
  if (g.policy.catalog && isCatalogNetwork(network)) {
    if (a.protocol === 'ORCA' || namedProtocols[0] === 'ORCA') ask(['protocol'], m.whichPool, m.poolOptions);
    return planCatalogLiquidity(a, g, network, notes);
  }
  const protocol = network === COPILOT_POOLS.ORCA.network ? 'ORCA' : 'UNISWAP_V3';
  if (a.rangeUnit === 'FULL' || a.feeTier) ask(['range'], m.rangeNotFound(COPILOT_POOLS[protocol].quote, COPILOT_POOLS[protocol].base));
  if (a.protocol !== null && a.protocol !== protocol) ask(['protocol'], m.whichPool, m.poolOptions);
  const pool = COPILOT_POOLS[protocol];
  const deposits = new Map<string, string>();
  for (const deposit of a.deposits) {
    const symbol = pool.symbol(deposit.asset);
    if (!symbol) refuse(m.poolTokens(pool.first, pool.second));
    if (deposits.has(symbol!)) reject('COPILOT_DUPLICATE_DEPOSIT', m.poolTokenOnce(pool.first, pool.second));
    // "The same tokens" carries the token names from a swap step (`asset:`); the amounts must still be the user's own words.
    needAsset(deposit.asset, g, 'liquidity', g.carried.has(`asset:${symbol}`) ? `asset:${symbol}` : `deposit:${symbol}`);
    deposits.set(symbol!, amountOf(deposit.maxAmount, g, 'liquidity', `deposit:${symbol}`));
  }
  const missing: CopilotMissingField[] = [...(deposits.size < 2 ? ['amount' as const] : []),
    ...(a.rangeUnit === null || (a.rangeUnit !== 'PERCENT' && a.lower === null) || a.upper === null ? ['range' as const] : [])];
  if (missing.length) ask(missing, m.liquidityNeeds(pool.first, pool.second, pool.quote, pool.base));
  if (a.rangeUnit === 'PERCENT' && protocol !== 'ORCA') ask(['range'], m.percentRangeOrcaOnly);
  const range = protocol === 'ORCA' ? orcaRange(a, g, notes) : (() => {
    const lower = a.lower!, upper = a.upper!;
    const grounded = g.carried.has('range') ? true : a.rangeUnit === 'PRICE' ? !lower.startsWith('-') && !upper.startsWith('-') && groundedAmount(text, lower) && groundedAmount(text, upper)
      : /^-?\d+$/.test(lower) && /^-?\d+$/.test(upper) && groundedSigned(text, lower) && groundedSigned(text, upper);
    if (!grounded) ask(['range'], m.rangeNotFound(pool.quote, pool.base));
    return a.rangeUnit === 'PRICE' ? `from ${lower} to ${upper} ${pool.quote} per ${pool.base}` : `ticks ${lower} to ${upper}`;
  })();
  const slippage = slippageOf(a.slippageBps, pool.slippage, g, notes);
  return { sentence: `add liquidity ${deposits.get(pool.first)} ${pool.first} and ${deposits.get(pool.second)} ${pool.second} ${range} on ` +
    `${COPILOT_NETWORK_LABEL[network]} slippage ${slippage} bps`, expect: pool.expect, notes };
}

/** A percentage written as such: "10%", "10 %", "10 percent", "10 por cento". */
function groundedPercent(text: string, percent: string): boolean {
  const wanted = canonicalDecimal(percent);
  return numbersIn(text).some(reading => reading.value === wanted && reading.percent && !reading.negative) ||
    new RegExp(`(?<![\\d.,])${escapeRegExp(wanted)}\\s*(?:percent|per\\s?cent|por\\s?cento)\\b`, 'i').test(text);
}
/**
 * The Orca SOL/devUSDC range as exact-grammar words. A percentage ("a 10% range") is ±that percent around the verified pool price FloFi read itself
 * (`g.solana.price`), through the same bounds as the Canvas range control; without a verified price nothing is proposed.
 */
function orcaRange(a: CopilotLiquidityAction, g: Grounding, notes: string[]): string {
  const m = copyOf(g), pool = COPILOT_POOLS.ORCA, text = g.text;
  if (a.rangeUnit === 'PERCENT') {
    const percent = a.upper;
    if (percent === null || a.lower !== null) return ask(['range'], m.rangeNotFound(pool.quote, pool.base));
    if (!g.carried.has('range') && !groundedPercent(text, percent)) return ask(['range'], m.percentNotFound(percent));
    const value = Number(percent), bps = Math.round(value * 100);
    if (!Number.isFinite(value) || bps < 1 || bps > 9_000) return reject('COPILOT_RANGE_OUT_OF_RANGE', m.percentRangeInvalid);
    const price = g.solana?.price ?? null;
    if (!price) return reject('COPILOT_POOL_PRICE_UNAVAILABLE', m.priceUnavailable);
    const bounds = priceBoundsAround(price, -value, value);
    notes.push(m.percentRangeNote(canonicalDecimal(percent), price, bounds.lower, bounds.upper));
    return `from ${bounds.lower} to ${bounds.upper} ${pool.quote} per ${pool.base}`;
  }
  if (a.rangeUnit === null || a.rangeUnit === 'FULL' || a.lower === null || a.upper === null) return ask(['range'], m.rangeNotFound(pool.quote, pool.base));
  const lower = a.lower, upper = a.upper;
  const grounded = g.carried.has('range') ? true : a.rangeUnit === 'PRICE' ? !lower.startsWith('-') && !upper.startsWith('-') && groundedAmount(text, lower) && groundedAmount(text, upper)
    : /^-?\d+$/.test(lower) && /^-?\d+$/.test(upper) && groundedSigned(text, lower) && groundedSigned(text, upper);
  if (!grounded) ask(['range'], m.rangeNotFound(pool.quote, pool.base));
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
  const slippage = slippageOf(a.slippageBps, pool.slippage, g, notes);
  notes.push(cap === 'all' ? m.swapOutputNote(bound) : m.swapOutputCapNote(bound, cap), m.twoTransactionsNote);
  return swapSentence ? { sentence: `${swapSentence} then add liquidity ${cap} swapped ${bound} and ${otherMax} ${other} ${range} slippage ${slippage} bps`,
    expect: 'ADD_SOLANA_COMPOSITION', notes }
    : { sentence: `add liquidity ${cap} ${bound} from ${(source as Extract<SwapSource, { kind: 'STEP' }>).nodeId} and ${otherMax} ${other} ${range} on Solana Devnet slippage ${slippage} bps`,
      expect: 'ADD_SOLANA_COMPOSITION', notes };
}

/** "0.05%" written as a fee percentage (the tier must be the user's own words, or carried). */
const groundedFee = (text: string, fee: string) => numbersIn(text).some(reading => reading.percent && !reading.negative && reading.value === canonicalDecimal(fee));
/**
 * BUILD-BASE-001: a Uniswap v3 position on a catalog network — any two catalog ERC-20s the user named, a standard fee tier (0.3% unless the
 * user named another) and the full range unless the user gave ticks. The sentence is the exact grammar's
 * (`add liquidity 100 USDC and 0.04 WETH on Base fee 0.05% slippage 100 bps`).
 */
function planCatalogLiquidity(a: CopilotLiquidityAction, g: Grounding, network: Network, notes: string[]): Plan {
  const m = copyOf(g), text = g.text, label = COPILOT_NETWORK_LABEL[network];
  if (a.deposits.length < 2) ask(['amount'], m.catalogLiquidityNeeds(label));
  const tokens = a.deposits.map(deposit => {
    const token = catalogToken(deposit.asset, network, g, 'liquidity', `deposit:${deposit.asset}` as CarriedField, 'ERC20', notes);
    return { symbol: token.asset.symbol, address: token.asset.address, ether: token.ether, amount: amountOf(deposit.maxAmount, g, 'liquidity', `deposit:${deposit.asset}` as CarriedField) };
  });
  if (tokens[0]!.address === tokens[1]!.address) reject('COPILOT_DUPLICATE_DEPOSIT', m.poolTokenOnce(tokens[0]!.symbol, tokens[1]!.symbol));
  const fee = a.feeTier ?? null;
  const writtenFee = /\b(?:fee(?: tier)?|taxa|at)\s+(?:(?:of|de)\s+)?([0-9]+(?:[.,][0-9]+)?)\s*%/i.exec(g.latest ?? text)?.[1]?.replace(',', '.');
  if (writtenFee && !COPILOT_FEE_TIERS.some(tier => canonicalDecimal(tier) === canonicalDecimal(writtenFee)))
    refuse(m.catalogFeeUnsupported(COPILOT_FEE_TIERS));
  if (writtenFee && fee === null && !g.carried.has('feeTier')) ask(['range'], m.feeNotFound(writtenFee));
  if (fee !== null && !g.carried.has('feeTier') && !groundedFee(text, fee)) ask(['range'], m.feeNotFound(fee));
  let range = '';
  if (a.rangeUnit === 'TICK') {
    const lower = a.lower ?? '', upper = a.upper ?? '';
    if (!(g.carried.has('range') || (/^-?\d+$/.test(lower) && /^-?\d+$/.test(upper) && groundedSigned(text, lower) && groundedSigned(text, upper))))
      ask(['range'], m.catalogRangeNotFound);
    range = ` ticks ${lower} to ${upper}`;
  } else if (a.rangeUnit === 'PRICE') ask(['range'], m.catalogRangeNotFound);
  else if (a.rangeUnit === null) notes.push(m.fullRangeNote);
  const slippage = slippageOf(a.slippageBps, ROBINHOOD_LIQUIDITY_DEFAULT_SLIPPAGE, g, notes);
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
  const slippage = slippageOf(swap.slippageBps, '50', g, notes);
  const owners = [...new Set([supply.beneficiary, borrow.beneficiary].filter((v): v is string => v !== null).map(v => addressOf(v, g, 'beneficiary')!))];
  if (owners.length > 1) reject('COPILOT_OWNER_CONFLICT', m.sameOwner);
  if (!owners.length && !wallet) ask(['beneficiary'], stillNeeds(m, ['beneficiary'], 'composition'));
  if (!owners.length) notes.push(m.ownerNote(wallet!));
  if (swap.outputAsset?.toUpperCase() === 'ETH') notes.push(m.compositionWethNote);
  notes.push(m.debtNote);
  return { sentence: `compose supply ${supplied} USDC to Aave then borrow ${borrowed} USDC then swap borrowed USDC to WETH on Base Sepolia slippage ${slippage} bps` +
    `${owners.length ? ' owner ' + owners[0] : ''}`, expect: 'AUTHOR_LENDING', notes };
}

const ROUTER_RANGES = (['testnet', 'mainnet'] as const).map(network => {
  const option = ROUTER_NETWORK_OPTIONS[network], decimals = option.pair.source.decimals;
  return `${option.sourceLabel} → ${option.destinationLabel} ${formatTokenAmount(option.pair.minimumAmount, decimals)}–${formatTokenAmount(option.pair.maximumAmount, decimals)} USDC`;
}).join('; ');
/** A closed rejection code with deterministic copy; unknown codes are named, never explained by the model. */
export function copilotRejection(code: string, language: CopilotLanguage = 'EN'): Extract<CopilotOutcome, { kind: 'REJECTED' }> {
  const m = copilotCopy(language);
  return { kind: 'REJECTED', code, message: m.rejection[code] ?? (code === 'ROUTER_AMOUNT_OUT_OF_RANGE' ? m.routerAmountRange(ROUTER_RANGES) : m.rejectedCode(code)) };
}

/**
 * One validated action (or the lending composition) → the canonical sentence Flofi would type, or the clarification,
 * refusal or rejection that stops it. Pure. Values come only from the grounding context.
 */
export function planCopilotActions(actions: readonly CopilotAction[], composition: boolean, g: Grounding, wallet: string | null):
  { readonly kind: 'PLAN'; readonly plan: Plan } | Exclude<CopilotOutcome, { kind: 'PROPOSAL' }> {
  try {
    if (composition) return { kind: 'PLAN', plan: planComposition(actions, g, wallet) };
    const action = actions[0]!;
    if (g.policy.catalog && action.type === 'LIQUIDITY' && action.funding === 'SWAP_OUTPUT') return { kind: 'PLAN', plan: planSolanaComposition(null, action, g) };
    return { kind: 'PLAN', plan: action.type === 'SWAP' ? planSwap(action, g) : action.type === 'BRIDGE' ? planBridge(action, g)
      : action.type === 'LIQUIDITY' ? planLiquidity(action, g) : action.type === 'TRANSFER' ? planTransfer(action, g) : planLending(action, g, wallet) };
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
