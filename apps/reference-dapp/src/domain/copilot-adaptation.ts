// SPDX-License-Identifier: AGPL-3.0-only
import { mentionedNetworks } from './copilot-authoring';
import type { CopilotAction } from './copilot-intent';
import { grounds, isLexiconTarget, lexiconMatches, statedSource, targetAsset, targetEnvironment, targetKind, targetNetwork, validateLexiconEntry,
  type LexiconEntry, type LexiconSource, type LexiconTarget } from './copilot-lexicon';
import { NETWORKS } from './network-registry';

/**
 * BUILD-CHAT-LEARNING-002: which natural interactions are evidence about the user's words, decided deterministically. Pure: no state, storage,
 * network or model. The conversation engine (`copilot-conversation.ts`) calls it; the caller only ever stores what it returns, and only when the
 * deployment and the user allow it.
 *
 * Grounding never lets the model choose a network or a token the user did not name — FloFi asks instead. So the reliable signals are:
 *
 *   CLARIFIED     FloFi asked for a network or token the request left unresolved; the user's answer named one; exactly one word group of the
 *                 request has lexical affinity with it (a prefix such as "arb" of Arbitrum, an abbreviation with test wording such as "arb sep",
 *                 a small typo such as "solona") and is a valid lexicon entry for it.
 *   CORRECTED     The user corrected a value FloFi read ON ITS OWN (an adapted, learned or glossary term; the model's choice of operation): in chat
 *                 with a correction cue ("no, I meant…", "não, eu quis dizer…"), or on the canvas by changing exactly that one field of the
 *                 applied step. The same word is learned for the new value only when it has affinity with it (operations: the one unexplained verb).
 *   CONTRADICTED  ...and the inferred meaning that produced the old value is withdrawn.
 *   CONFIRMED     A proposal that used an inferred reading was applied without changing that field.
 *   STATED        An explicit statement ("whenever I say arb, I mean Arbitrum"), parsed by `copilot-lexicon.ts`.
 *
 * Never evidence: a value the user named or chose themselves (changing it is changing their objective), an objective-change cue ("actually,
 * let's…", "mudei de ideia"), an edit that also changes an amount, a slippage, an address, a range or a fee, removals, layout moves, dismissed
 * proposals, failed executions. Those produce a content-free reason code only. Nothing here ever reads or yields an amount, an address, a
 * recipient, a slippage, a balance, a signature or a decision: observations carry a validated term and one closed-vocabulary target.
 */
export type ObservationKind = 'STATED' | 'CLARIFIED' | 'CORRECTED' | 'CONFIRMED' | 'CONTRADICTED';
export type LearningObservation = { readonly kind: ObservationKind; readonly term: string; readonly target: LexiconTarget; readonly via: 'CHAT' | 'CANVAS' }
  | { readonly kind: 'LANGUAGE'; readonly language: 'EN' | 'PT'; readonly stated?: boolean };
/** Content-free outcome of a signal (closed kinds and codes, never a word the user wrote). */
export type AdaptationEvent = { readonly kind: 'ADAPTATION' | 'CORRECTION_IGNORED' | 'INFERRED_USED' | 'INFERRED_CONFIRMED' | 'INFERRED_CORRECTED';
  readonly outcome: string };
export type ReadingField = 'network' | 'sourceNetwork' | 'destinationNetwork' | 'asset' | 'inputAsset' | 'outputAsset' | 'operation';
/**
 * How FloFi came to a proposal's value: NAMED by the user's own words, ASKED (named in the answer to FloFi's question), STATED (the user's declared
 * meaning), INFERRED (a term FloFi applied on its own: adapted, learned, glossary), CARRIED from an earlier step, or MODEL (the interpreter's choice
 * of operation).
 */
export type ReadingVia = 'NAMED' | 'ASKED' | 'STATED' | 'INFERRED' | 'CARRIED' | 'MODEL';
export type ProposalReading = { readonly field: ReadingField; readonly target: LexiconTarget; readonly via: ReadingVia; readonly term: string | null;
  readonly source: LexiconSource | null };
export type ReadingFields = Partial<Record<ReadingField, LexiconTarget>>;
/** What a signal changes: observations for the caller, this conversation's adapted meanings, words whose inferred meaning is withdrawn, events. */
export type Adaptation = { readonly observations: readonly LearningObservation[]; readonly adapted: readonly LexiconEntry[];
  readonly suppressed: readonly { readonly term: string; readonly target: LexiconTarget }[]; readonly events: readonly AdaptationEvent[] };
export const NO_ADAPTATION: Adaptation = Object.freeze({ observations: [], adapted: [], suppressed: [], events: [] });
export const ADAPTATION_LIMITS = Object.freeze({ maxRequestText: 400, maxReadings: 8, maxSuppressed: 16 });

const OPERATIONS = new Set(['SWAP', 'BRIDGE', 'SUPPLY', 'BORROW', 'REPAY', 'WITHDRAW', 'LIQUIDITY', 'TRANSFER']);
const target = (value: string): LexiconTarget | null => isLexiconTarget(value) ? value : null;
const networkTarget = (value: string | null | undefined) => value ? target(`network:${value}`) : null;
const assetTarget = (value: string | null | undefined) => value ? target(`asset:${value.toUpperCase()}`) : null;

// ── Proposal fields ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The interpretable fields of an authored action: networks, pinned tokens and the operation. Catalog tokens and compositions have none. */
export function fieldsOfAction(action: CopilotAction | null): ReadingFields {
  if (!action) return {};
  const out: Record<string, LexiconTarget> = {};
  const put = (field: ReadingField, value: LexiconTarget | null) => { if (value) out[field] = value; };
  if (OPERATIONS.has(action.type)) put('operation', target(`operation:${action.type}`));
  if (action.type === 'BRIDGE') { put('sourceNetwork', networkTarget(action.sourceNetwork)); put('destinationNetwork', networkTarget(action.destinationNetwork)); put('asset', assetTarget(action.asset)); }
  else put('network', networkTarget(action.network));
  if (action.type === 'SWAP') { put('inputAsset', assetTarget(action.inputAsset)); put('outputAsset', assetTarget(action.outputAsset)); }
  else if (action.type !== 'BRIDGE' && action.type !== 'LIQUIDITY') put('asset', assetTarget(action.asset));
  return out;
}
/** Everything else an action carries (amounts, slippage, recipients, ranges, fees, routing, protocol): never learned, and a change to it is no correction. */
function otherFields(action: CopilotAction): string {
  const rest: Record<string, unknown> = { ...action };
  for (const key of ['type', 'network', 'sourceNetwork', 'destinationNetwork', 'asset', 'inputAsset', 'outputAsset']) delete rest[key];
  return JSON.stringify(rest, Object.keys(rest).sort());
}
/** Which interpretable fields changed between two versions of one step, and whether anything financial changed too. */
export function actionDiff(before: CopilotAction, after: CopilotAction): { readonly changed: readonly ReadingField[]; readonly financial: boolean; readonly replaced: boolean } {
  if (before.type !== after.type) return { changed: [], financial: false, replaced: true };
  const a = fieldsOfAction(before), b = fieldsOfAction(after), keys = [...new Set([...Object.keys(a), ...Object.keys(b)])] as ReadingField[];
  const changed = keys.filter(key => a[key] !== b[key]);
  // A field FloFi cannot name in its closed vocabulary (a catalog token) on either side counts as a change it cannot interpret: never a correction.
  const raw = (action: CopilotAction) => JSON.stringify([action.type === 'BRIDGE' ? [action.sourceNetwork, action.destinationNetwork, action.asset] : action.network,
    action.type === 'SWAP' ? [action.inputAsset, action.outputAsset] : action.type === 'LIQUIDITY' ? null : action.asset]);
  const uninterpretable = changed.some(key => !a[key] || !b[key]) || (!changed.length && raw(before) !== raw(after));
  return { changed: changed.filter(key => a[key] && b[key]), financial: otherFields(before) !== otherFields(after) || uninterpretable, replaced: false };
}

// ── Words: canonical mentions, affinity, cues ─────────────────────────────────────────────────────────────────────────────────────────
const words = (text: string) => text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Function words (EN, PT) that never start or end a learned word group. */
const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'from', 'on', 'in', 'into', 'at', 'of', 'for', 'with', 'and', 'or', 'my', 'me', 'i', 'it', 'please', 'want',
  'would', 'like', 'can', 'you', 'could', 'some', 'all', 'this', 'that', 'then', 'now', 'network', 'chain', 'via', 'using', 'use', 'no', 'not', 'yes', 'is',
  'o', 'os', 'as', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos', 'para', 'pra', 'pro', 'na', 'no', 'nas', 'nos', 'em', 'com', 'e', 'ou', 'meu', 'minha', 'meus',
  'minhas', 'eu', 'quero', 'queria', 'por', 'favor', 'pode', 'faz', 'faça', 'faca', 'isso', 'esse', 'essa', 'rede', 'não', 'nao', 'sim', 'é', 'agora', 'depois',
  'usando', 'via', 'tudo', 'todo', 'toda', 'mais', 'menos']);
const TEST_WORDS = new Set(['sep', 'sepolia', 'test', 'teste', 'testnet', 'testes', 'tst', 'dev', 'devnet']);
const TEST_LABELS = new Set(['sepolia', 'devnet', 'testnet']);
/** The label word lists a target is known by (registry names, keys and aliases; pinned token names). */
const ASSET_LABELS: Readonly<Record<string, readonly string[][]>> = { USDC: [['usdc'], ['usd', 'coin']], WETH: [['weth'], ['wrapped', 'ether']], ETH: [['eth'], ['ether']],
  SOL: [['sol']], USDT: [['usdt'], ['tether']], WBTC: [['wbtc'], ['wrapped', 'bitcoin']], DEVUSDC: [['devusdc'], ['dev', 'usdc'], ['test', 'usdc']] };
function labelsOf(value: LexiconTarget): readonly string[][] {
  const network = targetNetwork(value);
  if (network) return NETWORKS.filter(n => n.copilot === network).flatMap(n => [n.name, n.key, ...n.aliases].map(label => words(label).filter(word => !/^\d+$/.test(word))))
    .filter(list => list.length);
  const asset = targetAsset(value);
  return asset ? ASSET_LABELS[asset] ?? [] : [];
}
/** Optimal string alignment distance (bounded inputs: at most 32 characters). */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
  }
  return d[a.length]![b.length]!;
}
/** One word of the user's against one label word: equal, an abbreviation (prefix of ≥ 3 letters), a small typo, or test wording for a test label. */
function wordMatches(word: string, label: string, testTarget: boolean): boolean {
  if (word === label) return true;
  if (testTarget && TEST_WORDS.has(word) && TEST_LABELS.has(label)) return true;
  if (word.length >= 3 && label.startsWith(word)) return true;
  return word.length >= 5 && label.length >= 5 && distance(word, label) <= (label.length >= 8 ? 2 : 1);
}
/** A word group has affinity with a target when its words match the target's label words in order, the first one matching the label's first. */
export function hasAffinity(term: string, value: LexiconTarget): boolean {
  const termWords = words(term), test = targetEnvironment(value) === 'TESTNET';
  if (!termWords.length) return false;
  return labelsOf(value).some(label => {
    if (!wordMatches(termWords[0]!, label[0]!, test)) return false;
    let at = 1;
    for (const word of termWords.slice(1)) {
      while (at < label.length && !wordMatches(word, label[at]!, test)) at += 1;
      if (at >= label.length) return false;
      at += 1;
    }
    return true;
  });
}
export type TermResult = { readonly ok: true; readonly term: string } | { readonly ok: false; readonly reason: 'NO_TERM' | 'AMBIGUOUS' | 'TERM_INVALID' };
/**
 * The one word group of `text` (1–3 words, no function word at either end) that has affinity with `value` and is a valid lexicon entry for it.
 * Longest groups win over the groups inside them. A longest group that is not a valid entry for `value` (a token word such as "sol", test wording
 * next to a real-funds choice, a canonical name) is dropped with the words inside it; two separate valid candidates are ambiguous.
 */
export function affinityTerm(text: string, value: LexiconTarget): TermResult {
  const tokens = words(text.slice(0, ADAPTATION_LIMITS.maxRequestText)), realFunds = targetEnvironment(value) === 'MAINNET', network = targetKind(value) === 'network';
  const spans: { start: number; end: number; term: string }[] = [];
  for (let start = 0; start < tokens.length; start++) for (let size = 1; size <= 3 && start + size <= tokens.length; size++) {
    const group = tokens.slice(start, start + size);
    if (STOPWORDS.has(group[0]!) || STOPWORDS.has(group.at(-1)!) || group.some(word => /^\d+$/.test(word))) continue;
    // As the lexicon matcher reads words: a real-funds word right before test wording ("arb sep") or a network word right after a number ("10 arb",
    // an amount of a token) never means that value.
    if ((realFunds && TEST_WORDS.has(tokens[start + size] ?? '')) || (network && /^\d+$/.test(tokens[start - 1] ?? ''))) continue;
    const term = group.join(' ');
    if (hasAffinity(term, value)) spans.push({ start, end: start + size, term });
  }
  const maximal = spans.filter(span => !spans.some(other => other !== span && other.start <= span.start && other.end >= span.end && other.end - other.start > span.end - span.start));
  const valid = [...new Set(maximal.flatMap(span => { const entry = validateLexiconEntry(span.term, value); return entry.ok ? [entry.term] : []; }))];
  if (valid.length > 1) return { ok: false, reason: 'AMBIGUOUS' };
  return valid.length ? { ok: true, term: valid[0]! } : { ok: false, reason: maximal.length ? 'TERM_INVALID' : 'NO_TERM' };
}
// Canonical operation vocabulary (EN, PT): a user who wrote one of these named the operation.
const OPERATION_MENTIONS: Readonly<Record<string, RegExp>> = {
  SWAP: /\b(?:swap\w*|trade|exchange|troca\w*|trocar|convert\w*)\b/iu, BRIDGE: /\b(?:bridge\w*|ponte|cross[\s-]?chain)\b/iu,
  SUPPLY: /\b(?:supply|deposit\w*|lend|fornecer|aplicar)\b/iu, BORROW: /\b(?:borrow\w*|emprest\w*)\b/iu, REPAY: /\b(?:repay\w*|pay\s+back|pagar|quitar)\b/iu,
  WITHDRAW: /\b(?:withdraw\w*|sacar|saque|retirar)\b/iu, LIQUIDITY: /\b(?:liquidity|liquidez|pool)\b/iu, TRANSFER: /\b(?:transfer\w*|send|enviar|transferir)\b/iu,
};
const operationNamed = (text: string) => Object.values(OPERATION_MENTIONS).some(pattern => pattern.test(text));
/**
 * The verb the user used for an operation FloFi read wrong: what remains of the request once numbers, function words, token and network words
 * (named or with affinity to the proposal's networks) and canonical operation words are removed — exactly one run of one or two words.
 */
export function operationTerm(text: string, value: LexiconTarget, fields: ReadingFields): TermResult {
  const tokens = words(text.slice(0, ADAPTATION_LIMITS.maxRequestText)), networks = Object.values(fields).filter(f => targetKind(f) === 'network');
  const keep = tokens.map(word => !(STOPWORDS.has(word) || /\d/.test(word) || Object.keys(ASSET_LABELS).some(asset => ASSET_LABELS[asset]!.some(l => l.includes(word)))
    || mentionedNetworks(word).length || networks.some(n => hasAffinity(word, n)) || TEST_WORDS.has(word) || operationNamed(word)));
  const runs: string[][] = [];
  keep.forEach((kept, index) => { if (!kept) return; if (index > 0 && keep[index - 1]) runs.at(-1)!.push(tokens[index]!); else runs.push([tokens[index]!]); });
  if (!runs.length) return { ok: false, reason: 'NO_TERM' };
  if (runs.length > 1 || runs[0]!.length > 2) return { ok: false, reason: 'AMBIGUOUS' };
  const valid = validateLexiconEntry(runs[0]!.join(' '), value);
  return valid.ok ? { ok: true, term: valid.term } : { ok: false, reason: 'TERM_INVALID' };
}
/**
 * What the user's message says about a change FloFi's proposal had: CORRECTION ("no", "I meant", "não, eu quis dizer"), OBJECTIVE (a change of
 * plan: "actually, let's", "instead", "mudei de ideia", "em vez disso") or nothing. An explicit "I meant" wins over a change-of-plan word.
 */
export function correctionCue(text: string): 'CORRECTION' | 'OBJECTIVE' | null {
  const t = text.normalize('NFC').toLowerCase();
  if (/\b(?:i\s+meant|i\s+mean|i\s+said|i\s+wrote|not\s+what\s+i|that'?s\s+(?:wrong|not\s+(?:it|right))|wrong\s+(?:network|token|chain|one))\b/u.test(t)
    || /(?:quis\s+dizer|queria\s+dizer|eu\s+disse|eu\s+falei|eu\s+escrevi|n[ãa]o\s+(?:era|foi|é|e)\s+(?:isso|essa|esse)|(?:rede|token)\s+errad[oa]|t[áa]\s+errado|est[áa]\s+errado)/u.test(t))
    return 'CORRECTION';
  if (/\b(?:actually|instead|rather|on\s+second\s+thought|change\s+of\s+plans?|let'?s\s+(?:do|use|go|try)|switch\s+to|changed\s+my\s+mind)\b/u.test(t)
    || /(?:mudei\s+de\s+ideia|em\s+vez\s+disso|ao\s+inv[ée]s|na\s+verdade|prefiro|vamos\s+(?:usar|fazer)|melhor\s+(?:usar|fazer))/u.test(t)) return 'OBJECTIVE';
  return /^\s*(?:no|nope|n[ãa]o)\b/u.test(t) ? 'CORRECTION' : null;
}

// ── Readings ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ASSET_MENTION = (symbol: string) => symbol === 'DEVUSDC' ? /\b(?:dev\s?usdc|test\s?usdc)\b/i : symbol === 'ETH' || symbol === 'WETH' ? /\bw?eth\b|\bether\b/i
  : symbol === 'USDT' ? /\b(?:usdt|tether)\b/i : new RegExp(`(?<![A-Za-z0-9])${symbol}(?![A-Za-z0-9])`, 'i');
const named = (text: string, value: LexiconTarget): boolean => {
  const network = targetNetwork(value), asset = targetAsset(value);
  if (network) return (mentionedNetworks(text) as readonly string[]).includes(network);
  if (asset) return ASSET_MENTION(asset).test(text);
  return OPERATION_MENTIONS[value.slice('operation:'.length)]?.test(text) ?? false;
};
/**
 * How each field of a proposal was read. `request`: the open request's text up to FloFi's first question; `answers`: the user's answers to it;
 * `carried`: fields FloFi carried from an earlier step.
 */
export function proposalReadings(fields: ReadingFields, request: string, answers: string, lexicon: readonly LexiconEntry[], carried: ReadonlySet<string>): ProposalReading[] {
  const matches = lexiconMatches(request, lexicon);
  return (Object.entries(fields) as [ReadingField, LexiconTarget][]).slice(0, ADAPTATION_LIMITS.maxReadings).map(([field, value]) => {
    const reading = (via: ReadingVia, entry: LexiconEntry | null = null): ProposalReading => ({ field, target: value, via, term: entry?.term ?? null, source: entry?.source ?? null });
    if (carried.has(field)) return reading('CARRIED');
    if (named(request, value)) return reading('NAMED');
    const entry = matches.find(match => match.entry.target === value)?.entry ?? null;
    // A meaning that selects the value on its own (stated; inferred for a test network) is how FloFi read it. One that only suggested it (real
    // funds, tokens) left the choice to the user's answer: that is the user's choice, and the suggested word is the word they confirmed.
    if (entry && grounds(entry)) return reading(statedSource(entry.source) ? 'STATED' : 'INFERRED', entry);
    if (answers && named(answers, value)) return reading('ASKED', entry);
    if (entry) return reading(statedSource(entry.source) ? 'STATED' : 'INFERRED', entry);
    // The interpreter chose it (an operation; or a test network, which grounding lets it pick): the request's word for it, when unambiguous.
    const word = targetKind(value) === 'operation' ? null : affinityTerm(request, value);
    return { ...reading('MODEL'), term: word?.ok ? word.term : null };
  });
}
/** A reading FloFi made on its own, with the user's word for it: an inferred meaning, or the interpreter's unprompted choice. */
const ownReading = (reading: ProposalReading) => !!reading.term && (reading.via === 'INFERRED' || reading.via === 'MODEL');
const fieldKind = (value: LexiconTarget) => targetKind(value) === 'network' ? 'NETWORK' : targetKind(value) === 'asset' ? 'ASSET' : 'OPERATION';
const adaptedEntry = (term: string, value: LexiconTarget): LexiconEntry => Object.freeze({ term, target: value, source: 'ADAPTED' as const });

/** FloFi asked, the user answered: each ASKED network or token whose word in the request is unambiguous becomes this conversation's meaning. */
export function clarifiedAdaptation(readings: readonly ProposalReading[], request: string): Adaptation {
  const out = { observations: [] as LearningObservation[], adapted: [] as LexiconEntry[], events: [] as AdaptationEvent[] };
  for (const reading of readings.filter(r => r.via === 'ASKED' && targetKind(r.target) !== 'operation')) {
    const found: TermResult = reading.term ? { ok: true, term: reading.term } : affinityTerm(request, reading.target);
    if (!found.ok) { out.events.push({ kind: 'CORRECTION_IGNORED', outcome: `CLARIFIED_${found.reason}` }); continue; }
    out.observations.push({ kind: 'CLARIFIED', term: found.term, target: reading.target, via: 'CHAT' });
    out.adapted.push(adaptedEntry(found.term, reading.target));
    out.events.push({ kind: 'ADAPTATION', outcome: `CLARIFIED_${fieldKind(reading.target)}` });
  }
  return { ...out, suppressed: [] };
}
/**
 * A change of one or more fields of a proposal FloFi made (`before` → `after`), in chat (`cue` from the user's message) or on the canvas (no cue:
 * changing a value FloFi filled in on its own is the correction). Only INFERRED readings and the model's operation can be corrected.
 */
export function correctionAdaptation(input: { readonly readings: readonly ProposalReading[]; readonly before: ReadingFields; readonly after: ReadingFields;
  readonly changed: readonly ReadingField[]; readonly financial: boolean; readonly via: 'CHAT' | 'CANVAS'; readonly cue: 'CORRECTION' | 'OBJECTIVE' | null;
  readonly request: string }): Adaptation {
  const { readings, after, changed, via, cue } = input;
  if (!changed.length) return NO_ADAPTATION;
  const ignored = (outcome: string): Adaptation => ({ ...NO_ADAPTATION, events: [{ kind: 'CORRECTION_IGNORED', outcome }] });
  if (input.financial) return ignored('FINANCIAL_FIELD');
  if (via === 'CHAT' && cue === 'OBJECTIVE') return ignored('OBJECTIVE_CHANGED');
  // Without a message, only a change of exactly one value reads as fixing it: changing several (network and token) is a new objective.
  if (via === 'CANVAS' && changed.length > 1) return ignored('SEVERAL_FIELDS');
  const out = { observations: [] as LearningObservation[], adapted: [] as LexiconEntry[], suppressed: [] as { term: string; target: LexiconTarget }[],
    events: [] as AdaptationEvent[] };
  for (const field of changed) {
    const reading = readings.find(r => r.field === field), next = after[field];
    if (!reading || !next) { out.events.push({ kind: 'CORRECTION_IGNORED', outcome: 'NO_READING' }); continue; }
    const operation = targetKind(reading.target) === 'operation';
    if (reading.via === 'NAMED' || reading.via === 'CARRIED') { out.events.push({ kind: 'CORRECTION_IGNORED', outcome: 'CANONICAL' }); continue; }
    if (reading.via === 'ASKED' || reading.via === 'STATED') { out.events.push({ kind: 'CORRECTION_IGNORED', outcome: 'USER_CHOSEN' }); continue; }
    if (via === 'CHAT' && cue !== 'CORRECTION') { out.events.push({ kind: 'CORRECTION_IGNORED', outcome: 'AMBIGUOUS' }); continue; }
    out.events.push({ kind: 'ADAPTATION', outcome: `CORRECTED_${fieldKind(reading.target)}_${via}` });
    if (ownReading(reading)) {
      out.observations.push({ kind: 'CONTRADICTED', term: reading.term!, target: reading.target, via });
      out.suppressed.push({ term: reading.term!, target: reading.target });
      out.events.push({ kind: 'INFERRED_CORRECTED', outcome: reading.source ?? 'MODEL' });
    }
    // The word itself: the inferred term, or (an operation the model chose) the one verb of the request nothing else explains.
    const term = reading.term ?? (operation ? (() => { const found = operationTerm(input.request, next, input.before); return found.ok ? found.term : null; })() : null);
    if (!term || (!operation && !hasAffinity(term, next)) || !validateLexiconEntry(term, next).ok) {
      out.events.push({ kind: 'CORRECTION_IGNORED', outcome: term ? 'TERM_INVALID' : 'NO_TERM' });
      continue;
    }
    out.observations.push({ kind: 'CORRECTED', term, target: next, via });
    out.adapted.push(adaptedEntry(term, next));
  }
  return out;
}
/** A proposal FloFi read on its own was applied, those fields unchanged: each such reading (with the user's word for it) is confirmed. */
export function confirmedAdaptation(readings: readonly ProposalReading[]): Adaptation {
  const own = readings.filter(ownReading);
  return { ...NO_ADAPTATION, observations: own.map(r => ({ kind: 'CONFIRMED' as const, term: r.term!, target: r.target, via: 'CHAT' as const })),
    events: own.map(r => ({ kind: 'INFERRED_CONFIRMED' as const, outcome: r.source ?? 'MODEL' })) };
}
/** Readings FloFi made on its own in a proposal, as content-free events (which source). */
export const inferredUse = (readings: readonly ProposalReading[]): Adaptation =>
  ({ ...NO_ADAPTATION, events: readings.filter(ownReading).map(r => ({ kind: 'INFERRED_USED' as const, outcome: r.source ?? 'MODEL' })) });
export const mergeAdaptations = (...list: readonly Adaptation[]): Adaptation => ({ observations: list.flatMap(a => a.observations), adapted: list.flatMap(a => a.adapted),
  suppressed: list.flatMap(a => a.suppressed), events: list.flatMap(a => a.events) });

// ── Language ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PT_WORDS = new Set(['de', 'da', 'do', 'para', 'pra', 'pro', 'com', 'em', 'na', 'no', 'quero', 'uma', 'um', 'não', 'meu', 'minha', 'faz', 'fazer', 'troca', 'trocar',
  'ponte', 'coloca', 'colocar', 'depositar', 'emprestar', 'sacar', 'enviar', 'mandar', 'muda', 'mudar', 'qual', 'quanto', 'como', 'tudo', 'então']);
// Function words only: operation loanwords ("swap", "bridge") are Portuguese too.
const EN_WORDS = new Set(['the', 'to', 'from', 'on', 'with', 'and', 'my', 'please', 'want', 'into', 'of', 'put', 'send', 'make', 'change', 'what', 'how', 'which',
  'then', 'some', 'all']);
/** The language a message is unmistakably written in (two or more function words of one language and none of the other), else null. */
export function messageLanguage(text: string): 'EN' | 'PT' | null {
  const list = words(text.slice(0, ADAPTATION_LIMITS.maxRequestText));
  const pt = list.filter(word => PT_WORDS.has(word)).length, en = list.filter(word => EN_WORDS.has(word)).length;
  return pt >= 2 && en === 0 ? 'PT' : en >= 2 && pt === 0 ? 'EN' : null;
}
