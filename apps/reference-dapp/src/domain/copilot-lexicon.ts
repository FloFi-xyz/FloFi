// SPDX-License-Identifier: AGPL-3.0-only
import { COPILOT_NETWORK_IDS, NETWORKS, copilotNetworksMentioned, networkOfCopilot, type CopilotNetworkId } from './network-registry';
import { hasUnsafeCharacters } from './copilot-intent';

/**
 * BUILD-CHAT-LEARNING-001: the Copilot's learned vocabulary — words a user (or FloFi's reviewed glossary) uses for a network, a token or an
 * operation FloFi already knows. Pure: no state, storage, network or model.
 *
 * A lexicon entry describes language only. It maps a short validated term to one closed-vocabulary target and never carries a value: an
 * amount, an address, a slippage, a range or a balance can only ever come from the user's own words (`copilot-authoring.ts`). Where an entry
 * may count as the user *naming* something is decided by its source:
 *
 *   SESSION  the user said it in this conversation ("whenever I say arb I mean Arbitrum")     names networks and tokens
 *   ADAPTED  BUILD-CHAT-LEARNING-002: inferred in this conversation from the user's answers   names TEST networks only; for a mainnet it only
 *            to FloFi's questions and corrections (`copilot-adaptation.ts`)                   suggests (FloFi still asks), never a token
 *   PRIVATE  the user's own stated meaning, saved for their verified identity                names networks and tokens
 *   LEARNED  BUILD-CHAT-LEARNING-002: inferred from repeated evidence, saved for the identity  as ADAPTED
 *   GLOBAL   FloFi's reviewed, evaluated, versioned glossary                                 as ADAPTED
 *
 * Only what the user *stated* (SESSION, PRIVATE) may select a real-funds network or a token; whatever FloFi inferred is offered first in FloFi's
 * own question instead, and the user decides.
 *
 * Validation keeps the canonical vocabulary fixed (a registry network name, a pinned token symbol, a protocol, a command word or an
 * instruction-like word can never be redefined) and keeps environments apart: a term with test-network wording can only name a test network
 * or test token, a term without it never can. Matching is deterministic: longest term first, whole words, no overlaps; an alias of a mainnet
 * never matches right before test-network wording ("arb sepolia") or right after a number ("10 arb" is an amount of a token).
 */
export const LEXICON_LIMITS = Object.freeze({ minTermLength: 2, maxTermLength: 32, maxTermWords: 3, maxSession: 8, maxAdapted: 8, maxPrivate: 64, maxGlobal: 200,
  maxGlossary: 8 });
export const LEXICON_OPERATIONS = Object.freeze(['SWAP', 'BRIDGE', 'SUPPLY', 'BORROW', 'REPAY', 'WITHDRAW', 'LIQUIDITY', 'TRANSFER'] as const);
/** Pinned, network-independent token symbols a term may stand for (catalog tokens are always resolved by FloFi from the named network). */
export const LEXICON_ASSETS = Object.freeze(['USDC', 'WETH', 'ETH', 'SOL', 'USDT', 'WBTC', 'DEVUSDC'] as const);
export type LexiconOperation = (typeof LEXICON_OPERATIONS)[number];
export type LexiconAsset = (typeof LEXICON_ASSETS)[number];
export type LexiconTarget = `network:${CopilotNetworkId}` | `asset:${LexiconAsset}` | `operation:${LexiconOperation}`;
export type LexiconSource = 'SESSION' | 'ADAPTED' | 'PRIVATE' | 'LEARNED' | 'GLOBAL';
export type LexiconEntry = { readonly term: string; readonly target: LexiconTarget; readonly source: LexiconSource;
  /** GLOBAL only: the knowledge version the entry was published in. */ readonly version?: number };
export type LexiconCode = 'LEARNING_TERM_INVALID' | 'LEARNING_TERM_RESERVED' | 'LEARNING_TARGET_INVALID' | 'LEARNING_ENVIRONMENT_CONFLICT';
export type LexiconValidation = { readonly ok: true; readonly term: string; readonly target: LexiconTarget } | { readonly ok: false; readonly code: LexiconCode };

const TARGET = /^(network|asset|operation):([A-Z][A-Z0-9_]{1,31})$/;
const TERM_SHAPE = /^[\p{Ll}\p{Nd}](?:[\p{Ll}\p{Nd} .'-]*[\p{Ll}\p{Nd}])?$/u;
/** Test-network wording inside a term ("arb sep", "sol devnet", "base teste"). */
const TEST_WORDING = /(?:^|[\s.-])(?:sepolia|sep|devnet|dev|testnet|testnets|test|teste|testes|tst)(?:$|[\s.-])/u;
/** Test-network wording in a message after a mainnet alias: "arb sepolia", "arb one sepolia", "arb-testnet". */
const TEST_SUFFIX = /^[\s-]*(?:one[\s-]*)?(?:sepolia|sep|devnet|testnets?|test\s?net|teste)(?![\p{L}\p{N}])/u;
/** A number right before a term makes it a token amount ("10 arb"), never a network. */
const AMOUNT_BEFORE = /\d(?:[\d.,]*\d)?\s*$/;

// Words whose meaning is fixed anywhere in a term: commands, confirmations, authority and instruction vocabulary, protocols.
const RESERVED_WORDS = new Set([
  'yes', 'no', 'ok', 'okay', 'sure', 'confirm', 'cancel', 'stop', 'start', 'help', 'menu', 'status', 'link', 'new', 'reset', 'memory', 'forget', 'remember',
  'sim', 'não', 'nao', 'confirmo', 'cancelar', 'parar', 'ajuda', 'novo', 'memória', 'memoria', 'esquecer', 'esqueça', 'lembrar', 'lembre',
  'execute', 'executar', 'executa', 'run', 'sign', 'assinar', 'assina', 'approve', 'aprovar', 'aprova', 'authorize', 'autorizar', 'submit',
  'transaction', 'transação', 'transacao', 'signature', 'assinatura', 'wallet', 'carteira', 'key', 'keys', 'chave', 'chaves', 'seed', 'semente',
  'mnemonic', 'password', 'senha', 'private', 'privada', 'secret', 'segredo', 'admin', 'root',
  'ignore', 'ignorar', 'ignora', 'system', 'sistema', 'prompt', 'instruction', 'instructions', 'instrução', 'instrucao', 'instruções', 'rule', 'rules',
  'regra', 'regras', 'assistant', 'assistente', 'developer', 'model', 'modelo', 'schema', 'json', 'flofi', 'gryloo', 'copilot',
  'aave', 'uniswap', 'orca', 'jupiter', 'whirlpool', 'lifi', 'li.fi', 'across', 'cow', 'chainlink',
  // BUILD-CHAT-LEARNING-002: words naming a financial parameter never become vocabulary (nothing learned may even appear to stand for a value).
  'amount', 'amounts', 'slippage', 'recipient', 'address', 'balance', 'fee', 'fees', 'gas', 'price', 'range', 'max', 'maximum', 'minimum',
  'valor', 'valores', 'quantia', 'quantidade', 'deslizamento', 'destinatário', 'destinatario', 'endereço', 'endereco', 'saldo', 'taxa', 'taxas', 'preço', 'preco',
  'faixa', 'máximo', 'maximo', 'mínimo', 'minimo',
]);
/** Canonical operation words: never a term on their own; inside a phrase ("fazer bridge") only for an operation. */
const OPERATION_TERMS = new Set(['swap', 'bridge', 'supply', 'borrow', 'repay', 'withdraw', 'liquidity', 'transfer', 'deposit', 'send']);
/** Token words: never a term on their own; inside a phrase ("eth sepolia") only for a test network named with test wording. */
// ARB (Arbitrum's token) is deliberately not here: "arb" for Arbitrum is the canonical user abbreviation; "10 arb" never matches a network.
const TOKEN_TERMS = new Set(['usdc', 'weth', 'eth', 'ether', 'sol', 'usdt', 'tether', 'wbtc', 'devusdc', 'usdg', 'cbbtc', 'btc', 'bitcoin']);
/** Generic nouns that never stand for one thing on their own. */
const RESERVED_WHOLE = new Set(['mainnet', 'testnet', 'network', 'rede', 'chain', 'token', 'tokens', 'dev usdc', 'test usdc', 'arbitrum one', 'ethereum mainnet',
  'solana mainnet', 'robinhood chain', 'op mainnet']);
const words = (term: string) => term.split(/[\s.-]+/).filter(Boolean);

export const isLexiconTarget = (value: unknown): value is LexiconTarget => {
  if (typeof value !== 'string') return false;
  const match = TARGET.exec(value);
  if (!match) return false;
  const [, kind, name] = match;
  return kind === 'network' ? (COPILOT_NETWORK_IDS as readonly string[]).includes(name!) : kind === 'asset' ? (LEXICON_ASSETS as readonly string[]).includes(name!)
    : (LEXICON_OPERATIONS as readonly string[]).includes(name!);
};
export const targetKind = (target: LexiconTarget) => target.slice(0, target.indexOf(':')) as 'network' | 'asset' | 'operation';
export const targetValue = (target: LexiconTarget) => target.slice(target.indexOf(':') + 1);
export const targetNetwork = (target: LexiconTarget): CopilotNetworkId | null => targetKind(target) === 'network' ? targetValue(target) as CopilotNetworkId : null;
export const targetAsset = (target: LexiconTarget): LexiconAsset | null => targetKind(target) === 'asset' ? targetValue(target) as LexiconAsset : null;
/** Whether the target means real funds: a mainnet, or a mainnet token (only DEVUSDC is test-only). Operations name no environment. */
export function targetEnvironment(target: LexiconTarget): 'MAINNET' | 'TESTNET' | null {
  const network = targetNetwork(target);
  if (network) return networkOfCopilot(network).environment;
  const asset = targetAsset(target);
  return asset === null ? null : asset === 'DEVUSDC' ? 'TESTNET' : 'MAINNET';
}

/** The canonical form of a term (NFC, lower case, single spaces, no surrounding quotes or punctuation); null when it cannot be one. */
export function normalizeTerm(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 128 || hasUnsafeCharacters(raw)) return null;
  const term = raw.normalize('NFC').trim().replace(/^["“”'‘’`«»]+|["“”'‘’`«».!?,;:]+$/gu, '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (term.length < LEXICON_LIMITS.minTermLength || term.length > LEXICON_LIMITS.maxTermLength || !TERM_SHAPE.test(term)) return null;
  if (term.split(' ').length > LEXICON_LIMITS.maxTermWords || /^[\d .'-]+$/.test(term) || /0x[0-9a-f]/.test(term) || /\.\./.test(term)) return null;
  return term;
}
/** A term that already has a fixed meaning in FloFi: any network name or mention, a pinned token, a protocol, a command or instruction word. */
export function reservedTerm(term: string): boolean {
  if (RESERVED_WHOLE.has(term) || RESERVED_WORDS.has(term) || OPERATION_TERMS.has(term) || TOKEN_TERMS.has(term)) return true;
  if (words(term).some(word => RESERVED_WORDS.has(word))) return true;
  if (copilotNetworksMentioned(term).length) return true;
  return NETWORKS.some(network => [network.name, network.key, ...network.aliases].some(label => label.toLowerCase() === term));
}
/** Validates one term → target meaning. Never repairs: an invalid entry is refused with a closed code. */
export function validateLexiconEntry(rawTerm: unknown, rawTarget: unknown): LexiconValidation {
  const term = normalizeTerm(rawTerm);
  if (term === null) return { ok: false, code: 'LEARNING_TERM_INVALID' };
  if (!isLexiconTarget(rawTarget)) return { ok: false, code: 'LEARNING_TARGET_INVALID' };
  if (reservedTerm(term)) return { ok: false, code: 'LEARNING_TERM_RESERVED' };
  const environment = targetEnvironment(rawTarget), testWords = TEST_WORDING.test(term), kind = targetKind(rawTarget);
  if (words(term).some(word => OPERATION_TERMS.has(word)) && kind !== 'operation') return { ok: false, code: 'LEARNING_TERM_RESERVED' };
  if (words(term).some(word => TOKEN_TERMS.has(word)) && !(kind === 'network' && environment === 'TESTNET' && testWords)) return { ok: false, code: 'LEARNING_TERM_RESERVED' };
  if (environment === 'TESTNET' && !testWords) return { ok: false, code: 'LEARNING_ENVIRONMENT_CONFLICT' };
  if (environment === 'MAINNET' && testWords) return { ok: false, code: 'LEARNING_ENVIRONMENT_CONFLICT' };
  return { ok: true, term, target: rawTarget };
}
/** Untrusted entries (a persisted channel state, a server response, a stored document) → the valid ones, deduplicated, bounded. */
export function parseLexicon(value: unknown, source: LexiconSource, limit: number = source === 'GLOBAL' ? LEXICON_LIMITS.maxGlobal
  : source === 'PRIVATE' || source === 'LEARNED' ? LEXICON_LIMITS.maxPrivate : source === 'ADAPTED' ? LEXICON_LIMITS.maxAdapted : LEXICON_LIMITS.maxSession): LexiconEntry[] {
  if (!Array.isArray(value)) return [];
  const out: LexiconEntry[] = [], seen = new Set<string>();
  for (const item of value.slice(0, limit)) {
    const record = item as { term?: unknown; target?: unknown; version?: unknown } | null;
    if (!record || typeof record !== 'object') continue;
    const valid = validateLexiconEntry(record.term, record.target);
    if (!valid.ok || seen.has(valid.term)) continue;
    seen.add(valid.term);
    const version = source === 'GLOBAL' && typeof record.version === 'number' && Number.isSafeInteger(record.version) && record.version >= 1 ? record.version : undefined;
    out.push(Object.freeze({ term: valid.term, target: valid.target, source, ...version ? { version } : {} }));
  }
  return out;
}

const PRECEDENCE: Readonly<Record<LexiconSource, number>> = { SESSION: 0, ADAPTED: 1, PRIVATE: 2, LEARNED: 3, GLOBAL: 4 };
/** One entry per term: this conversation (stated, then adapted), then the identity's saved meanings (stated, then learned), then FloFi's glossary. */
export function mergeLexicon(...lists: readonly (readonly LexiconEntry[])[]): LexiconEntry[] {
  const best = new Map<string, LexiconEntry>();
  for (const entry of lists.flat()) {
    const current = best.get(entry.term);
    if (!current || PRECEDENCE[entry.source] < PRECEDENCE[current.source]) best.set(entry.term, entry);
  }
  return [...best.values()];
}

export type LexiconMatch = { readonly entry: LexiconEntry; readonly index: number; readonly length: number };
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Every occurrence of a lexicon term in `text`, longest terms first, whole words, never overlapping. */
export function lexiconMatches(text: string, lexicon: readonly LexiconEntry[]): LexiconMatch[] {
  if (!lexicon.length || typeof text !== 'string' || !text) return [];
  const haystack = text.normalize('NFC').toLowerCase(), taken: [number, number][] = [], out: LexiconMatch[] = [];
  const entries = mergeLexicon(lexicon).sort((a, b) => b.term.length - a.term.length || PRECEDENCE[a.source] - PRECEDENCE[b.source]);
  for (const entry of entries) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(entry.term).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'gu');
    for (const match of haystack.matchAll(pattern)) {
      const start = match.index, end = start + match[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      if (targetEnvironment(entry.target) === 'MAINNET' && (TEST_SUFFIX.test(haystack.slice(end)) || (targetKind(entry.target) === 'network' &&
        AMOUNT_BEFORE.test(haystack.slice(0, start))))) continue;
      taken.push([start, end]);
      out.push({ entry, index: start, length: end - start });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}
/** The user stated this meaning (in this conversation, or saved for their identity); anything else FloFi inferred or reviewed globally. */
export const statedSource = (source: LexiconSource): boolean => source === 'SESSION' || source === 'PRIVATE';
/** Whether an entry may count as the user naming its target (see the module comment). */
export const grounds = (entry: LexiconEntry): boolean => statedSource(entry.source) || (targetKind(entry.target) === 'network' && targetEnvironment(entry.target) === 'TESTNET');
const unique = <T>(values: readonly T[]) => [...new Set(values)];
/** Networks the user named through a lexicon term that may ground them, with the entry that did. */
export function lexiconNetworks(text: string, lexicon: readonly LexiconEntry[]): { readonly network: CopilotNetworkId; readonly entry: LexiconEntry }[] {
  return lexiconMatches(text, lexicon).flatMap(({ entry }) => { const network = targetNetwork(entry.target); return network && grounds(entry) ? [{ network, entry }] : []; });
}
/** Mainnets an inferred or global term suggests: never grounded, only offered first in FloFi's own question. */
export function lexiconSuggestions(text: string, lexicon: readonly LexiconEntry[]): { readonly network: CopilotNetworkId; readonly entry: LexiconEntry }[] {
  return lexiconMatches(text, lexicon).flatMap(({ entry }) => { const network = targetNetwork(entry.target); return network && !grounds(entry) ? [{ network, entry }] : []; });
}
/** Pinned tokens the user named through their own stated (session or saved) terms. */
export function lexiconAssets(text: string, lexicon: readonly LexiconEntry[]): { readonly asset: LexiconAsset; readonly entry: LexiconEntry }[] {
  return lexiconMatches(text, lexicon).flatMap(({ entry }) => { const asset = targetAsset(entry.target); return asset && statedSource(entry.source) ? [{ asset, entry }] : []; });
}
export const lexiconNamedNetworkIds = (text: string, lexicon: readonly LexiconEntry[]): CopilotNetworkId[] => unique(lexiconNetworks(text, lexicon).map(item => item.network));
/** The entries a model request may show as glossary data: matched in the open request, the user's own first, bounded. */
export function glossaryEntries(text: string, lexicon: readonly LexiconEntry[], limit: number = LEXICON_LIMITS.maxGlossary): LexiconEntry[] {
  const matched = unique(lexiconMatches(text, lexicon).map(match => match.entry));
  return matched.sort((a, b) => PRECEDENCE[a.source] - PRECEDENCE[b.source]).slice(0, Math.max(0, Math.min(limit, LEXICON_LIMITS.maxGlossary)));
}

// ── Preference statements (deterministic, EN and PT) ─────────────────────────────────────────────────────────────────────────────────
/** `said`: the language the statement was written in (FloFi answers in it unless the user chose a reply language). */
export type MemoryStatement =
  | { readonly kind: 'REMEMBER'; readonly term: string | null; readonly target: LexiconTarget | null; readonly validation: LexiconValidation | null; readonly said: 'EN' | 'PT' }
  | { readonly kind: 'FORGET'; readonly term: string | null; readonly said: 'EN' | 'PT' }
  | { readonly kind: 'FORGET_ALL'; readonly said: 'EN' | 'PT' }
  | { readonly kind: 'LANGUAGE'; readonly language: 'EN' | 'PT'; readonly said: 'EN' | 'PT' };

const OPERATION_WORDS: readonly (readonly [LexiconOperation, RegExp])[] = [
  ['SWAP', /^(?:a\s+|um\s+|uma\s+)?(?:swap|swaps|swapping|trade|exchange|troca|trocar|converter|conversão|conversao)$/],
  ['BRIDGE', /^(?:a\s+|um\s+|uma\s+)?(?:bridge|bridging|ponte|cross[\s-]?chain)$/],
  ['SUPPLY', /^(?:supply|supplying|deposit|depositar|fornecer|aplicar)$/], ['BORROW', /^(?:borrow|borrowing|pegar emprestado|empréstimo|emprestimo)$/],
  ['REPAY', /^(?:repay|repaying|pagar|quitar|pagar a dívida|pagar a divida)$/], ['WITHDRAW', /^(?:withdraw|withdrawing|sacar|saque|retirar)$/],
  ['LIQUIDITY', /^(?:liquidity|add liquidity|liquidez|prover liquidez|pool)$/], ['TRANSFER', /^(?:transfer|send|enviar|transferir|transferência|transferencia)$/],
];
const ASSET_WORDS: Readonly<Record<string, LexiconAsset>> = { usdc: 'USDC', weth: 'WETH', eth: 'ETH', ether: 'ETH', sol: 'SOL', usdt: 'USDT', tether: 'USDT',
  wbtc: 'WBTC', devusdc: 'DEVUSDC', 'dev usdc': 'DEVUSDC', 'test usdc': 'DEVUSDC' };
const LEADING = /^(?:(?:the|a|an|o|a|os|as)\s+)?(?:(?:network|rede|chain|token|moeda|operação|operacao|operation|action|ação|acao)\s+)?(?:(?:of|de|da|do)\s+)?/u;
/** What a phrase like "Arbitrum", "Arbitrum One", "the Base Sepolia network", "USDC" or "bridge" names in FloFi's vocabulary; null if not exactly one. */
export function resolveTargetText(raw: string): LexiconTarget | null {
  const text = raw.normalize('NFC').trim().replace(/^["“”'‘’`«»]+|["“”'‘’`«».!?,;:]+$/gu, '').trim().replace(/\s+/g, ' ').toLowerCase().replace(LEADING, '').trim();
  if (!text || text.length > 48 || text.split(' ').length > 5) return null;
  const asset = ASSET_WORDS[text];
  if (asset) return `asset:${asset}`;
  for (const [operation, pattern] of OPERATION_WORDS) if (pattern.test(text)) return `operation:${operation}`;
  const byLabel = NETWORKS.filter(n => n.copilot && [n.name, n.key, ...n.aliases].some(label => label.toLowerCase() === text));
  if (byLabel.length === 1) return `network:${byLabel[0]!.copilot!}`;
  const mentioned = copilotNetworksMentioned(text);
  // The phrase must be just the network's name ("arbitrum", "arbitrum one", "base sepolia"), not a sentence that happens to contain one.
  if (mentioned.length === 1 && text.split(' ').length <= 3) return `network:${mentioned[0]!}`;
  return null;
}

const QUOTED = '["“”\'‘’«»]?';
const T = `${QUOTED}(.+?)${QUOTED}`;
// The first four are English, the rest Portuguese (`STRICT_ENGLISH`).
const REMEMBER_STRICT: readonly RegExp[] = [
  // "Whenever I say Arb, I mean Arbitrum", "remember: when I write arb I mean Arbitrum One"
  new RegExp(`^(?:please\\s+)?(?:remember(?:\\s+that)?[:,]?\\s+)?(?:whenever|when|every\\s+time|if)\\s+i\\s+(?:say|write|type|use)\\s+${T},?\\s+i\\s+(?:mean|am\\s+talking\\s+about|refer\\s+to)\\s+(.+)$`, 'iu'),
  // "Remember that arb means Arbitrum", "remember arb = Arbitrum"
  new RegExp(`^(?:please\\s+)?remember(?:\\s+that)?[:,]?\\s+${T}\\s+(?:means|is|=|stands\\s+for)\\s+(.+)$`, 'iu'),
  // "By arb I mean Arbitrum", "by arb, I meant Arbitrum Sepolia", "no, when I said arb I meant Arbitrum"
  new RegExp(`^(?:no[,.]?\\s+)?by\\s+${T},?\\s+i\\s+(?:mean|meant)\\s+(.+)$`, 'iu'),
  new RegExp(`^(?:no[,.]?\\s+)?when\\s+i\\s+(?:said|wrote|typed)\\s+${T},?\\s+i\\s+meant\\s+(.+)$`, 'iu'),
  // "Sempre que eu disser arb, quero dizer Arbitrum", "quando eu falar arb é Arbitrum"
  new RegExp(`^(?:por\\s+favor[,]?\\s+)?(?:lembr[ae](?:-se)?(?:\\s+que)?[:,]?\\s+)?(?:sempre\\s+que|quando|toda\\s+vez\\s+que|se)\\s+eu\\s+(?:disser|falar|escrever|digitar|usar|digo|falo|escrevo)\\s+${T},?\\s+(?:eu\\s+)?(?:quero\\s+dizer|me\\s+refiro\\s+(?:a|à|ao)|estou\\s+falando\\s+(?:de|da|do)|é|significa|seria)\\s+(.+)$`, 'iu'),
  // "Lembre que arb é Arbitrum", "lembra que arb significa Arbitrum"
  new RegExp(`^(?:por\\s+favor[,]?\\s+)?lembr[ae](?:-se)?(?:\\s+que)?[:,]?\\s+${T}\\s+(?:é|significa|quer\\s+dizer|=)\\s+(.+)$`, 'iu'),
  // "Por arb eu quero dizer Arbitrum", "não, quando eu disse arb eu quis dizer Arbitrum"
  new RegExp(`^(?:não[,.]?\\s+|nao[,.]?\\s+)?por\\s+${T},?\\s+(?:eu\\s+)?(?:quero\\s+dizer|quis\\s+dizer)\\s+(.+)$`, 'iu'),
  new RegExp(`^(?:não[,.]?\\s+|nao[,.]?\\s+)?quando\\s+eu\\s+(?:disse|falei|escrevi)\\s+${T},?\\s+(?:eu\\s+)?(?:quis\\s+dizer|queria\\s+dizer|me\\s+referia\\s+(?:a|à|ao))\\s+(.+)$`, 'iu'),
];
// "arb means Arbitrum", "arb significa Arbitrum": a memory statement only when both sides resolve (otherwise the model reads it).
const STRICT_ENGLISH = 4;
const REMEMBER_LOOSE: readonly RegExp[] = [new RegExp(`^${T}\\s+(?:means|stands\\s+for|significa|quer\\s+dizer)\\s+(.+)$`, 'iu')];
const FORGET_ALL = /^(?:please\s+)?(?:forget\s+(?:everything|all|all\s+my\s+preferences|my\s+preferences|what\s+you\s+remember)|delete\s+(?:my|all\s+my)\s+memory)$|^(?:por\s+favor[,]?\s+)?(?:esque[cç]a\s+(?:tudo|todas?\s+as\s+(?:minhas\s+)?prefer[eê]ncias|minhas\s+prefer[eê]ncias|minha\s+mem[oó]ria)|apague\s+(?:a\s+)?minha\s+mem[oó]ria)$/iu;
const FORGET: readonly RegExp[] = [new RegExp(`^(?:please\\s+)?forget\\s+(?:what\\s+)?${T}(?:\\s+means)?$`, 'iu'),
  new RegExp(`^(?:por\\s+favor[,]?\\s+)?esque[cç]a\\s+(?:o\\s+que\\s+)?${T}(?:\\s+significa)?$`, 'iu')];
const LANGUAGE: readonly [RegExp, 'EN' | 'PT'][] = [
  [/^(?:please\s+)?(?:always\s+)?(?:reply|answer|respond|talk|speak|write)(?:\s+always)?(?:\s+to\s+me)?\s+in\s+(portuguese|english)(?:\s+from\s+now\s+on)?$/iu, 'EN'],
  [/^(?:por\s+favor[,]?\s+)?(?:sempre\s+)?(?:responda|responde|fale|fala|escreva|escreve)(?:\s+sempre)?(?:\s+comigo)?\s+em\s+(portugu[eê]s|ingl[eê]s)(?:\s+(?:a\s+partir\s+de\s+agora|daqui\s+pra\s+frente|daqui\s+para\s+frente))?$/iu, 'PT'],
];
const strip = (text: string) => text.normalize('NFC').trim().replace(/[.!]+$/u, '').replace(/\s+/g, ' ');
/** A statement about the user's own vocabulary or reply language; null for anything else (which then goes to the normal flow). */
export function parseMemoryStatement(raw: string): MemoryStatement | null {
  if (typeof raw !== 'string' || raw.length > 200 || raw.includes('?')) return null;
  const text = strip(raw);
  for (const [pattern, said] of LANGUAGE) { const match = pattern.exec(text); if (match) return { kind: 'LANGUAGE', language: /^p/i.test(match[1]!) ? 'PT' : 'EN', said }; }
  if (FORGET_ALL.test(text)) return { kind: 'FORGET_ALL', said: /^(?:please\s+)?(?:forget|delete)\b/i.test(text) ? 'EN' : 'PT' };
  for (const [index, pattern] of FORGET.entries()) {
    const match = pattern.exec(text);
    // "Forget it" / "esquece isso" means "never mind", not a memory.
    if (match && !/^(?:it|that|this|about it|isso|isto|aquilo|disso)$/iu.test(match[1]!.trim()))
      return { kind: 'FORGET', term: normalizeTerm(match[1]), said: index === 0 ? 'EN' : 'PT' };
  }
  for (const [index, pattern] of REMEMBER_STRICT.entries()) {
    const match = pattern.exec(text);
    if (!match) continue;
    const target = resolveTargetText(match[2]!), term = normalizeTerm(match[1]);
    return { kind: 'REMEMBER', term, target, validation: target ? validateLexiconEntry(match[1], target) : null, said: index < STRICT_ENGLISH ? 'EN' : 'PT' };
  }
  for (const pattern of REMEMBER_LOOSE) {
    const match = pattern.exec(text);
    if (!match) continue;
    const target = resolveTargetText(match[2]!), term = normalizeTerm(match[1]);
    if (!target || !term) return null;
    return { kind: 'REMEMBER', term, target, validation: validateLexiconEntry(match[1], target), said: /\b(?:means|stands)\b/i.test(text) ? 'EN' : 'PT' };
  }
  return null;
}
