// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (R09–R12, P1 §6): a Batch Payment authored and edited in the chat with the account's Saved Recipients,
 * always on the SAME Batch Payment card (one `asset.transfer.batch` step; never one card per recipient). Pure: no React, no network, no model.
 *
 *   - `namedClauses`: the payments a request writes as "<amount> [<asset>] para|to <recipient>[, <recipient>…]", in the person's order, where a
 *     recipient is an explicit address or a saved name ("20 USDC para Caio e 30 USDC para Dayane"; "10 USDC para Caio e Pedro" is one amount for each).
 *   - `readBatchEdit`: an edit of an existing Batch Payment in the person's own words (English and Portuguese): add recipients, change one recipient's
 *     amount, remove or replace a recipient.
 *   - `resolveBatchRecipient`: a written recipient → an address, only through an explicit address or the exact saved-name rules of
 *     `saved-recipients.ts`. Several matches (or part of a name) are a question, no match asks for a valid address, and a saved address of another
 *     ecosystem than the payment's network is refused. Nothing here invents an address; the conversation masks every saved name and address before
 *     anything is sent to a model, so resolution happens here, locally.
 *   - `batchChangeView`: what the chat says about a created or edited Batch Payment: each recipient (by saved name when it is one), the recipient
 *     count, the exact total, the token and the network, in English and Portuguese.
 *
 * Amounts stay exact decimal strings (the authoring turns them into integer base units); a written amount with several readings ("1.000") is asked
 * about, never chosen. Every edited payment list is re-authored by `createAuthoredBatchPayment` (the card's own validation) before it is proposed.
 */
import { BATCH_PAYMENT_SOLANA_NETWORK, batchPaymentChain, batchPaymentDetails, createAuthoredBatchPayment, type BatchPaymentDetails,
  type BatchPaymentInput } from './batch-payment-authoring';
import { authoringAssetSymbol } from './asset-catalogs';
import { amountReadings, canonicalDecimal, mentionedNetworks, SELF_RECIPIENT } from './copilot-authoring';
import { ecosystemOfAddress, matchSavedRecipients, recipientLabelKey, reservedRecipientLabel, savedRecipientAddress, type SavedRecipient,
  type SavedRecipientEcosystem } from './saved-recipients';
import type { Workflow } from './initial-workflow';

type Language = 'EN' | 'PT';

// ── Written recipients ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Words around a recipient that are not part of it: a leading preposition or article, a trailing "também" or "please". */
const LEADING = /^(?:(?:para|pra|pro|to|for|o|a|os|as|the|ao|aos|à|às)\s+)+/i;
const TRAILING = /(?:\s+(?:tamb[ée]m|too|also|as well|por favor|please|no lote|no pagamento|ao lote|ao pagamento|to the batch|to the payment))+$/i;
export const cleanPhrase = (raw: string): string => raw.trim().replace(/[.!?;:,]+$/, '').trim().replace(LEADING, '').replace(TRAILING, '').trim();
/** The comparison key of a written recipient (the folded name, or the address as written). */
export const phraseKey = (phrase: string): string => { const clean = cleanPhrase(phrase); return EVM_ADDRESS.test(clean) || SOLANA_ADDRESS.test(clean) ? clean : recipientLabelKey(clean) || clean; };
/** A placeholder ("wallet A", "carteira 2", "B") names nobody: it is never read as a name (FloFi asks for the recipient as it always did). */
const PLACEHOLDER = /^(?:(?:wallet|carteira|address|endere[cç]o|recipient|destinat[aá]rio|account|conta|person|pessoa|user|usu[aá]rio)\s+)?[\p{L}\p{N}]{1,2}$/iu;
export type WrittenRecipient ={ readonly kind: 'ADDRESS'; readonly address: string } | { readonly kind: 'SELF' } | { readonly kind: 'NAME'; readonly phrase: string }
  | { readonly kind: 'OTHER' };
/**
 * What a written recipient is: an explicit address, the person's own wallet ("mim", "my wallet": a Batch Payment needs each recipient's address), a
 * name, or anything else (a network, a token, a number: never a recipient, so the words keep their meaning elsewhere).
 */
export function writtenRecipient(phrase: string, recipients: readonly SavedRecipient[] = []): WrittenRecipient {
  const clean = cleanPhrase(phrase);
  if (EVM_ADDRESS.test(clean) || SOLANA_ADDRESS.test(clean)) return { kind: 'ADDRESS', address: clean };
  if (!clean || clean.length > 60) return { kind: 'OTHER' };
  if (SELF_RECIPIENT.test(`para ${clean}`) || SELF_RECIPIENT.test(`to ${clean}`) || /^(?:mim|me|myself|eu)$/i.test(clean)) return { kind: 'SELF' };
  // A saved name stays a name even when one of its words is a network ("Base da Ana"): it never selects that network.
  if (recipients.length && matchSavedRecipients(clean, recipients).kind !== 'NONE') return { kind: 'NAME', phrase: clean };
  if (/\d/.test(clean) || !/\p{L}/u.test(clean) || reservedRecipientLabel(clean) || mentionedNetworks(clean).length || PLACEHOLDER.test(clean)) return { kind: 'OTHER' };
  return { kind: 'NAME', phrase: clean };
}

// ── Payments written in a request ────────────────────────────────────────────────────────────────────────────────────────────────────────
const AMOUNT = String.raw`(\d(?:[\d.,]*\d)?)`;
const ASSET = String.raw`([A-Za-z][A-Za-z0-9.-]{0,23})`;
/** "<amount> [<asset>] para|to " — the start of one payment clause (digits inside an address or a word never start one). */
const clauseStart = () => new RegExp(String.raw`(?<![\p{L}\p{N}_.,])${AMOUNT}\s*(?:${ASSET}\s+)?(?:to|for|para|pra|pro)\s+`, 'giu');
const SEPARATOR = /(\s*[,;]\s*|\s+(?:e|and|&)\s+)/i;
const NETWORK_TAIL = /\s+(?:on|in|via|through|pela|pelo|na|no|em)\s+/gi;
const STOP = /[.!?](?:\s|$)|\s+(?:then|and then|depois|e depois|e então|e entao)\s+/i;
/** The recipients part of a clause: up to the end of its sentence, without a trailing network ("pela Base") or list separator. */
function sectionOf(raw: string): string {
  let section = raw;
  const stop = STOP.exec(section);
  if (stop) section = section.slice(0, stop.index);
  for (const match of section.matchAll(NETWORK_TAIL)) if (mentionedNetworks(section.slice(match.index)).length) { section = section.slice(0, match.index); break; }
  return section.replace(/(?:\s*[,;]\s*|\s+(?:e|and|&)\s*)$/i, '').trim();
}
/** The recipients of one clause, in order. A saved name that itself holds a separator ("Caio e Ana") stays one recipient. */
function phrasesOf(section: string, recipients: readonly SavedRecipient[]): string[] {
  if (!section) return [];
  const parts = section.split(SEPARATOR), words = parts.filter((_, at) => at % 2 === 0), separators = parts.filter((_, at) => at % 2 === 1);
  const labels = new Set(recipients.filter(recipient => !reservedRecipientLabel(recipient.label)).map(recipient => recipientLabelKey(recipient.label)));
  const out: string[] = [];
  for (let start = 0; start < words.length;) {
    let end = start + 1;
    for (let longer = words.length; longer > start + 1; longer--) {
      const run = words.slice(start, longer).map((word, at) => at ? `${separators[start + at - 1]}${word}` : word).join('');
      if (labels.has(recipientLabelKey(cleanPhrase(run)))) { end = longer; break; }
    }
    const phrase = words.slice(start, end).map((word, at) => at ? `${separators[start + at - 1]}${word}` : word).join('').trim();
    if (cleanPhrase(phrase)) out.push(phrase);
    start = end;
  }
  return out;
}
/** One written payment clause: its amount as written (with every exact reading), its asset (null: not written) and its recipients. */
export type NamedClause = { readonly written: string; readonly readings: readonly string[]; readonly asset: string | null; readonly phrases: readonly string[] };
/** One payment: a clause's amount and asset for one of its recipients. */
export type NamedPayment = { readonly clause: number; readonly written: string; readonly readings: readonly string[]; readonly asset: string | null; readonly phrase: string };
export function namedClauses(text: string, recipients: readonly SavedRecipient[]): NamedClause[] {
  const starts = [...text.matchAll(clauseStart())];
  const clauses = starts.map((match, index) => {
    const end = match.index + match[0].length, next = starts[index + 1]?.index ?? text.length;
    return { written: match[1]!, readings: amountReadings(match[1]!), asset: match[2] ?? null, phrases: phrasesOf(sectionOf(text.slice(end, next)), recipients) };
  }).filter(clause => clause.phrases.length);
  // An asset written once names the asset of the clauses that left it out ("20 para Caio e 30 USDC para Dayane").
  const shared = clauses.find(clause => clause.asset)?.asset ?? null;
  return clauses.map(clause => ({ ...clause, asset: clause.asset ?? shared }));
}
export const namedPayments = (clauses: readonly NamedClause[]): NamedPayment[] =>
  clauses.flatMap((clause, index) => clause.phrases.map(phrase => ({ clause: index, written: clause.written, readings: clause.readings, asset: clause.asset, phrase })));
/**
 * The payments of a request that names at least one recipient by name: two or more payments, every recipient an address, a name or the person's own
 * wallet (which is refused later, with its reason). Null otherwise: requests written only with addresses keep the address pairing of
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 exactly as before, and words that are a network or token are never read as a recipient.
 */
export function namedBatchWritten(text: string, recipients: readonly SavedRecipient[]): { readonly clauses: readonly NamedClause[]; readonly payments: readonly NamedPayment[] } | null {
  const clauses = namedClauses(text, recipients), payments = namedPayments(clauses);
  if (payments.length < 2) return null;
  const kinds = payments.map(payment => writtenRecipient(payment.phrase, recipients).kind);
  return kinds.includes('NAME') && !kinds.includes('OTHER') ? { clauses, payments } : null;
}

// ── Resolving a written recipient ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The person's answers to FloFi's own questions about this request, by written recipient (or amount) key: a saved recipient they picked, an
 *  address they gave for a name that is not saved, and the reading of an ambiguous amount. */
export type BatchAnswers = { readonly picks?: Readonly<Record<string, string>>; readonly addresses?: Readonly<Record<string, string>>;
  readonly readings?: Readonly<Record<string, string>> };
export type BatchAsk = { readonly kind: 'CHOOSE'; readonly key: string; readonly phrase: string; readonly candidates: readonly SavedRecipient[] }
  | { readonly kind: 'ADDRESS'; readonly key: string; readonly phrase: string }
  | { readonly kind: 'READING'; readonly key: string; readonly written: string; readonly readings: readonly string[] };
export type BatchRefusal = { readonly code: 'NOT_FOUND'; readonly phrase: string } | { readonly code: 'ALREADY_IN'; readonly name: string }
  | { readonly code: 'ASSET'; readonly asset: string } | { readonly code: 'WRONG_ECOSYSTEM'; readonly label: string; readonly ecosystem: SavedRecipientEcosystem }
  | { readonly code: 'SELF' } | { readonly code: 'STALE' } | { readonly code: 'AUTHORING'; readonly error: string };
export type RecipientResolution = { readonly kind: 'RESOLVED'; readonly address: string; readonly label: string | null }
  | { readonly kind: 'ASK'; readonly ask: BatchAsk } | { readonly kind: 'REFUSE'; readonly reason: BatchRefusal };
/** The ecosystem a Batch Payment network pays (Solana or EVM). */
export const batchEcosystem = (network: string): SavedRecipientEcosystem => network === BATCH_PAYMENT_SOLANA_NETWORK ? 'SOLANA' : 'EVM';
/** The saved recipient whose canonical address is exactly this address (display only: an address is never derived from a name), or null. */
export function savedRecipientOf(address: string, recipients: readonly SavedRecipient[]): SavedRecipient | null {
  const ecosystem = ecosystemOfAddress(address), canonical = ecosystem ? savedRecipientAddress(ecosystem, address) : null;
  return canonical ? recipients.find(recipient => recipient.ecosystem === ecosystem && recipient.address === canonical) ?? null : null;
}
/**
 * One written recipient → its address. `ecosystem`: the payment network's, when the person named that network (a saved address of the other
 * ecosystem is refused with the reason; a network only guessed refuses nothing). A saved name chosen from FloFi's buttons must still be in the list.
 */
export function resolveBatchRecipient(phrase: string, recipients: readonly SavedRecipient[], answers: BatchAnswers, ecosystem: SavedRecipientEcosystem | null): RecipientResolution {
  const key = phraseKey(phrase), written = writtenRecipient(phrase, recipients);
  const saved = (recipient: SavedRecipient): RecipientResolution => ecosystem && recipient.ecosystem !== ecosystem
    ? { kind: 'REFUSE', reason: { code: 'WRONG_ECOSYSTEM', label: recipient.label, ecosystem: recipient.ecosystem } }
    : { kind: 'RESOLVED', address: recipient.address, label: recipient.label };
  const typed = (address: string): RecipientResolution => { const known = savedRecipientOf(address, recipients);
    return known ? saved(known) : { kind: 'RESOLVED', address, label: null }; };
  const picked = answers.picks?.[key];
  if (picked) { const recipient = recipients.find(item => item.id === picked); return recipient ? saved(recipient) : { kind: 'REFUSE', reason: { code: 'STALE' } }; }
  const given = answers.addresses?.[key];
  if (given) return typed(given);
  if (written.kind === 'ADDRESS') return typed(written.address);
  if (written.kind === 'SELF') return { kind: 'REFUSE', reason: { code: 'SELF' } };
  const mention = matchSavedRecipients(phrase, recipients);
  if (mention.kind === 'ONE') return saved(mention.recipient);
  if (mention.kind === 'CHOOSE') {
    // Several names (or part of one) are always a question, never a guess; only recipients the payment's network can pay are offered.
    const fit = ecosystem ? mention.candidates.filter(recipient => recipient.ecosystem === ecosystem) : mention.candidates;
    return fit.length ? { kind: 'ASK', ask: { kind: 'CHOOSE', key, phrase: cleanPhrase(phrase), candidates: fit } } : saved(mention.candidates[0]!);
  }
  return { kind: 'ASK', ask: { kind: 'ADDRESS', key, phrase: cleanPhrase(phrase) } };
}
/** The exact reading of a written amount: one reading, the person's answer among several, or the question. */
export function amountReading(key: string, written: string, readings: readonly string[], answers: BatchAnswers): { readonly amount: string } | { readonly ask: BatchAsk } | null {
  const answered = answers.readings?.[key];
  if (answered && readings.includes(answered)) return { amount: answered };
  if (readings.length === 1) return { amount: readings[0]! };
  return readings.length ? { ask: { kind: 'READING', key, written, readings } } : null;
}
/** A bare address the person typed in answer to FloFi's address question (anything else is not an answer). */
export const bareAddress = (text: string): string | null => { const value = text.trim().replace(/[.!]+$/, ''); return EVM_ADDRESS.test(value) || SOLANA_ADDRESS.test(value) ? value : null; };

// ── Edits of an existing Batch Payment ───────────────────────────────────────────────────────────────────────────────────────────────────
export type BatchEdit = { readonly op: 'ADD'; readonly clauses: readonly NamedClause[] }
  | { readonly op: 'AMOUNT'; readonly phrase: string; readonly written: string; readonly readings: readonly string[]; readonly asset: string | null }
  | { readonly op: 'REMOVE'; readonly phrases: readonly string[] } | { readonly op: 'REPLACE'; readonly from: string; readonly to: string };
const ADD_CUE = /^(?:(?:por favor|please),?\s+)?(?:(?:adicion[ae](?:r)?|inclu[ai](?:r)?|acrescent[ae](?:r)?|coloqu[e]|colocar|coloca|bot[ae](?:r)?|ponha|p[oõ]e|add|include|plus)\s+)?(?:(?:mais|tamb[ée]m|another|also|outro|outra)\s+)?/i;
const ADD_VERB = /^(?:(?:por favor|please),?\s+)?(?:adicion[ae](?:r)?|inclu[ai](?:r)?|acrescent[ae](?:r)?|coloqu[e]|colocar|coloca|bot[ae](?:r)?|ponha|p[oõ]e|add|include|plus)\b/i;
const ADD_MORE = /^(?:(?:por favor|please),?\s+)?(?:mais|tamb[ée]m|also)\s+/i;
const ADD_WITH = new RegExp(String.raw`^(?:(?:por favor|please),?\s+)?(?:adicion[ae](?:r)?|inclu[ai](?:r)?|acrescent[ae](?:r)?|add|include)\s+(.+?)\s+(?:com|with)\s+${AMOUNT}(?:\s*${ASSET})?$`, 'iu');
const AMOUNT_EDITS: readonly RegExp[] = [
  new RegExp(String.raw`^(?:mud[ae](?:r)?|alter[ae](?:r)?|ajust[ae](?:r)?|atualiz[ae](?:r)?|corrij[ae]|corrigir|deix[ae](?:r)?)\s+(?:o\s+valor\s+(?:d[aeo]s?|para|de)\s+|o\s+pagamento\s+(?:d[aeo]|para|de)\s+)?(.+?)\s+(?:para|em|com)\s+${AMOUNT}(?:\s*${ASSET})?$`, 'iu'),
  new RegExp(String.raw`^(?:o\s+|a\s+)?(.+?)\s+(?:agora\s+)?(?:recebe|vai\s+receber|fica\s+com|deve\s+receber|passa\s+a\s+receber)\s+${AMOUNT}(?:\s*${ASSET})?$`, 'iu'),
  new RegExp(String.raw`^(?:change|set|update|make|adjust)\s+(?:the\s+amount\s+(?:of|for)\s+|the\s+payment\s+(?:to|for|of)\s+)?(.+?)(?:['’]s\s+(?:amount|payment))?\s+to\s+${AMOUNT}(?:\s*${ASSET})?$`, 'iu'),
  new RegExp(String.raw`^(.+?)\s+(?:now\s+)?(?:gets|receives|should\s+get|should\s+receive)\s+${AMOUNT}(?:\s*${ASSET})?(?:\s+instead)?$`, 'iu'),
];
const REMOVE_EDIT = /^(?:remov[ae](?:r)?|tir[ae](?:r)?|exclu[ai](?:r)?|retir[ae](?:r)?|apag(?:a|ar|ue)|delet[ae](?:r)?|remove|drop|delete|take\s+out|exclude)\s+(.+?)(?:\s+(?:d[oa]\s+(?:lote|pagamento(?:\s+em\s+lote)?)|from\s+the\s+(?:batch(?:\s+payment)?|payment)))?$/iu;
const REPLACE_EDITS: readonly RegExp[] = [/^(?:substitu[ai](?:r)?|troc(?:a|ar)|troque)\s+(.+?)\s+(?:por|pel[oa])\s+(.+)$/iu, /^(?:replace|swap|switch)\s+(.+?)\s+(?:with|for|by)\s+(.+)$/iu,
  /^(?:change|switch)\s+(.+?)\s+to\s+(?!\d)(.+)$/iu];
/**
 * An edit of a Batch Payment written in the person's own words, or null. Only a shape: whether its recipients are this payment's (or saved, or
 * addresses) is decided against the payment (`applyBatchEdit`), so "troque 1 ETH por USDC" or "remove the second step" never become one.
 */
export function readBatchEdit(raw: string, recipients: readonly SavedRecipient[]): BatchEdit | null {
  const text = raw.trim().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  const withAmount = ADD_WITH.exec(text);
  if (withAmount) return { op: 'ADD', clauses: [{ written: withAmount[2]!, readings: amountReadings(withAmount[2]!), asset: withAmount[3] ?? null, phrases: phrasesOf(withAmount[1]!, recipients) }] };
  // "Adicione mais 10 USDC para Pedro", "mais 10 USDC para Ana e Bia", "add 10 USDC for Pedro": an add cue, then payment clauses.
  if (ADD_VERB.test(text) || ADD_MORE.test(text)) {
    const rest = text.replace(ADD_CUE, '');
    const first = clauseStart().exec(rest);
    if (first && first.index === 0) { const clauses = namedClauses(rest, recipients); if (clauses.length) return { op: 'ADD', clauses }; }
  }
  for (const pattern of AMOUNT_EDITS) {
    const match = pattern.exec(text);
    if (match) return { op: 'AMOUNT', phrase: match[1]!, written: match[2]!, readings: amountReadings(match[2]!), asset: match[3] ?? null };
  }
  const removal = REMOVE_EDIT.exec(text);
  if (removal) return { op: 'REMOVE', phrases: phrasesOf(removal[1]!, recipients) };
  for (const pattern of REPLACE_EDITS) {
    const match = pattern.exec(text);
    if (match) return { op: 'REPLACE', from: match[1]!, to: match[2]! };
  }
  return null;
}
/** Two recipients are the same key: a 0x address in any case, a base58 Solana key exactly. */
const sameRecipient = (network: string, a: string, b: string) => network === BATCH_PAYMENT_SOLANA_NETWORK ? a === b : a.toLowerCase() === b.toLowerCase();
/** The written asset is the payment's own (as the network's catalog spells it); unknown spellings are compared as written. */
function sameAsset(network: string, written: string, asset: string): boolean {
  const chain = batchPaymentChain(network);
  let symbol = written;
  try { if (chain && network !== BATCH_PAYMENT_SOLANA_NETWORK) symbol = authoringAssetSymbol(chain, written); } catch { /* compared as written */ }
  return symbol.toUpperCase() === asset.toUpperCase();
}
export type EditOutcome = { readonly kind: 'INPUT'; readonly input: BatchPaymentInput } | { readonly kind: 'ASK'; readonly ask: BatchAsk }
  | { readonly kind: 'REFUSE'; readonly reason: BatchRefusal };
/** The payment an edit names among this payment's own recipients: its index, FloFi's question, or null (it names none of them). */
function existingPayment(phrase: string, input: BatchPaymentInput, recipients: readonly SavedRecipient[], answers: BatchAnswers): number | { readonly ask: BatchAsk } | null {
  const written = writtenRecipient(phrase, recipients), key = phraseKey(phrase);
  const indexOf = (address: string) => { const at = input.payments.findIndex(payment => sameRecipient(input.network, payment.recipient, address)); return at < 0 ? null : at; };
  if (written.kind === 'ADDRESS') return indexOf(written.address);
  if (written.kind !== 'NAME') return null;
  const picked = answers.picks?.[key] ? recipients.find(recipient => recipient.id === answers.picks![key]) : undefined;
  if (picked) return indexOf(picked.address);
  const inPayment = recipients.filter(recipient => input.payments.some(payment => sameRecipient(input.network, payment.recipient, recipient.address)));
  const mention = matchSavedRecipients(phrase, inPayment);
  if (mention.kind === 'ONE') return indexOf(mention.recipient.address);
  if (mention.kind === 'CHOOSE') return { ask: { kind: 'CHOOSE', key, phrase: cleanPhrase(phrase), candidates: mention.candidates } };
  return null;
}
const recipientName = (address: string, recipients: readonly SavedRecipient[]) => savedRecipientOf(address, recipients)?.label ?? shortAddress(address);
/**
 * The payment list an edit makes from `input`, FloFi's question, its refusal, or null when the words do not name this payment's recipients (the
 * request is then not a Batch Payment edit and is read as before). Every list is re-authored with the card's own validation.
 */
export function applyBatchEdit(edit: BatchEdit, input: BatchPaymentInput, recipients: readonly SavedRecipient[], answers: BatchAnswers): EditOutcome | null {
  const ecosystem = batchEcosystem(input.network);
  let payments = input.payments.map(payment => ({ ...payment }));
  const ask = (value: BatchAsk): EditOutcome => ({ kind: 'ASK', ask: value }), refuse = (reason: BatchRefusal): EditOutcome => ({ kind: 'REFUSE', reason });
  const inPayment = (address: string) => payments.some(payment => sameRecipient(input.network, payment.recipient, address));
  switch (edit.op) {
    case 'ADD': {
      if (edit.clauses.some(clause => clause.phrases.some(phrase => writtenRecipient(phrase, recipients).kind === 'OTHER'))) return null;
      for (const [index, clause] of edit.clauses.entries()) {
        if (clause.asset && !sameAsset(input.network, clause.asset, input.asset)) return refuse({ code: 'ASSET', asset: input.asset });
        const reading = amountReading(`amount:${index}`, clause.written, clause.readings, answers);
        if (!reading) return refuse({ code: 'AUTHORING', error: 'BATCH_PAYMENT_AMOUNT_INVALID' });
        if ('ask' in reading) return ask(reading.ask);
        for (const phrase of clause.phrases) {
          const resolved = resolveBatchRecipient(phrase, recipients, answers, ecosystem);
          if (resolved.kind === 'ASK') return ask(resolved.ask);
          if (resolved.kind === 'REFUSE') return refuse(resolved.reason);
          if (inPayment(resolved.address)) return refuse({ code: 'ALREADY_IN', name: resolved.label ?? shortAddress(resolved.address) });
          payments = [...payments, { recipient: resolved.address, amount: reading.amount }];
        }
      }
      break;
    }
    case 'AMOUNT': {
      const found = existingPayment(edit.phrase, input, recipients, answers);
      if (found === null) return null;
      if (typeof found !== 'number') return ask(found.ask);
      if (edit.asset && !sameAsset(input.network, edit.asset, input.asset)) return refuse({ code: 'ASSET', asset: input.asset });
      const reading = amountReading('amount:0', edit.written, edit.readings, answers);
      if (!reading) return refuse({ code: 'AUTHORING', error: 'BATCH_PAYMENT_AMOUNT_INVALID' });
      if ('ask' in reading) return ask(reading.ask);
      payments = payments.map((payment, at) => at === found ? { ...payment, amount: reading.amount } : payment);
      break;
    }
    case 'REMOVE': {
      const found = edit.phrases.map(phrase => ({ phrase, at: existingPayment(phrase, input, recipients, answers) }));
      if (!found.length || found.every(item => item.at === null)) return null;
      const question = found.find(item => item.at !== null && typeof item.at !== 'number');
      if (question) return ask((question.at as { readonly ask: BatchAsk }).ask);
      const missing = found.find(item => item.at === null);
      if (missing) return refuse({ code: 'NOT_FOUND', phrase: cleanPhrase(missing.phrase) });
      const removed = new Set(found.map(item => item.at as number));
      payments = payments.filter((_, at) => !removed.has(at));
      break;
    }
    case 'REPLACE': {
      const found = existingPayment(edit.from, input, recipients, answers);
      if (found === null || writtenRecipient(edit.to, recipients).kind === 'OTHER') return null;
      if (typeof found !== 'number') return ask(found.ask);
      const resolved = resolveBatchRecipient(edit.to, recipients, answers, ecosystem);
      if (resolved.kind === 'ASK') return ask(resolved.ask);
      if (resolved.kind === 'REFUSE') return refuse(resolved.reason);
      if (payments.some((payment, at) => at !== found && sameRecipient(input.network, payment.recipient, resolved.address)))
        return refuse({ code: 'ALREADY_IN', name: resolved.label ?? shortAddress(resolved.address) });
      payments = payments.map((payment, at) => at === found ? { ...payment, recipient: resolved.address } : payment);
      break;
    }
  }
  const next: BatchPaymentInput = { network: input.network, asset: input.asset, payments };
  try { createAuthoredBatchPayment('batch-payment-chat', next); } catch (cause) { return refuse({ code: 'AUTHORING', error: cause instanceof Error ? cause.message : 'BATCH_PAYMENT_FIELDS_INVALID' }); }
  return { kind: 'INPUT', input: next };
}

// ── What the chat says ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** An exact decimal as the language writes it (Portuguese: decimal comma); never rounded. */
export const shownDecimal = (value: string, language: Language): string => language === 'PT' ? value.replace('.', ',') : value;
export const shortAddress = (address: string): string => address.startsWith('0x') ? `${address.slice(0, 6)}…${address.slice(-4)}` : `${address.slice(0, 4)}…${address.slice(-4)}`;
const join = (items: readonly string[], language: Language) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${language === 'PT' ? 'e' : 'and'} ${items.at(-1)}`;
export const BATCH_CHAT_COPY = {
  EN: {
    created: (total: string, asset: string, to: string) => `I prepared a batch payment of ${total} ${asset} to ${to}.`,
    recipients: (count: number) => `${count} recipients`,
    createdQuestion: 'Would you like to add another recipient and amount, or review the payment?',
    added: (names: readonly string[]) => `${join(names, 'EN')} ${names.length > 1 ? 'were' : 'was'} added.`,
    removed: (names: readonly string[]) => `Removed ${join(names, 'EN')} from the payment.`,
    replaced: (from: string, to: string) => `Replaced ${from} with ${to}.`,
    amount: (name: string, before: string, after: string, asset: string) => `${name}: ${before} → ${after} ${asset}.`,
    updated: 'Batch payment updated.',
    now: (count: number, total: string, asset: string) => `Now there are ${count} recipients and a total of ${total} ${asset}.`,
    editedQuestion: 'Would you like to add someone else or review?',
    summary: (count: number, total: string, asset: string, network: string) => `${count} recipients · ${total} ${asset} · ${network}`,
    atomic: 'It runs only as one atomic authorization of your wallet: every payment settles, or none does. Review every recipient before you authorize.',
    notFound: (phrase: string) => `${phrase} is not in this payment. Nothing changed.`,
    alreadyIn: (name: string) => `${name} is already in this payment. To change the amount, say for example “change ${name} to 25”.`,
    askAddress: (phrase: string) => `I couldn’t find “${phrase}” in your saved recipients. Send the full address for ${phrase}.`,
    invalidAddress: 'Enter a valid address.',
    asset: (asset: string) => `This batch payment pays ${asset}: every recipient receives the same asset. Nothing changed.`,
    network: (network: string) => `This batch payment is on ${network}: every payment uses the same network. Nothing changed.`,
    self: 'A batch payment needs each recipient’s address: use a saved recipient or write the full address. Nothing changed.',
    several: 'This workflow has more than one batch payment. Edit the one you mean on its card. Nothing changed.',
  },
  PT: {
    created: (total: string, asset: string, to: string) => `Preparei um pagamento em lote de ${total} ${asset} para ${to}.`,
    recipients: (count: number) => `${count} destinatários`,
    createdQuestion: 'Deseja adicionar outro destinatário e valor ou revisar o pagamento?',
    added: (names: readonly string[]) => `${join(names, 'PT')} ${names.length > 1 ? 'foram adicionados' : 'foi adicionado'}.`,
    removed: (names: readonly string[]) => `Removi ${join(names, 'PT')} do pagamento.`,
    replaced: (from: string, to: string) => `Troquei ${from} por ${to}.`,
    amount: (name: string, before: string, after: string, asset: string) => `${name}: ${before} → ${after} ${asset}.`,
    updated: 'Pagamento em lote atualizado.',
    now: (count: number, total: string, asset: string) => `Agora são ${count} destinatários e um total de ${total} ${asset}.`,
    editedQuestion: 'Deseja adicionar mais alguém ou revisar?',
    summary: (count: number, total: string, asset: string, network: string) => `${count} destinatários · ${total} ${asset} · ${network}`,
    atomic: 'Ele só executa como uma autorização atômica da sua carteira: todos os pagamentos são liquidados, ou nenhum. Revise cada destinatário antes de autorizar.',
    notFound: (phrase: string) => `${phrase} não está neste pagamento. Nada mudou.`,
    alreadyIn: (name: string) => `${name} já está neste pagamento. Para mudar o valor, diga por exemplo “mude ${name} para 25”.`,
    askAddress: (phrase: string) => `Não encontrei “${phrase}” nos seus destinatários salvos. Informe o endereço completo de ${phrase}.`,
    invalidAddress: 'Informe um endereço válido.',
    asset: (asset: string) => `Este pagamento em lote paga ${asset}: todos os destinatários recebem o mesmo ativo. Nada mudou.`,
    network: (network: string) => `Este pagamento em lote está na ${network}: todos os pagamentos usam a mesma rede. Nada mudou.`,
    self: 'Um pagamento em lote precisa do endereço de cada destinatário: use um destinatário salvo ou escreva o endereço completo. Nada mudou.',
    several: 'Este fluxo tem mais de um pagamento em lote. Edite o que você quer no card dele. Nada mudou.',
  },
} as const;
/** A Batch Payment as the chat describes it: decimal amounts, the catalog symbol, the exact total. */
export type BatchView = Pick<BatchPaymentDetails, 'network' | 'asset' | 'payments' | 'total'>;
/** The Batch Payment `input` declares (its exact total), or null when it is not a valid one. */
export function batchViewOf(input: BatchPaymentInput): BatchView | null {
  try { return batchPaymentDetails(createAuthoredBatchPayment('batch-payment-view', input)); } catch { return null; }
}
/** Each payment as one line: its amount, and its recipient by saved name (with the full address) or by its full address. */
export function batchPaymentLines(view: Pick<BatchView, 'asset' | 'payments'>, language: Language, recipients: readonly SavedRecipient[] = []): string[] {
  return view.payments.map((payment, index) => {
    const label = savedRecipientOf(payment.recipient, recipients)?.label;
    return `${index + 1}. ${shownDecimal(payment.amount, language)} ${view.asset} → ${label ? `${label} · ${payment.recipient}` : payment.recipient}`;
  });
}
export type BatchChangeView = { readonly text: string; readonly question: string; readonly summary: string; readonly lines: readonly string[]; readonly atomic: string };
/**
 * What the chat says about a Batch Payment it created (`before` null) or edited: the change in a few words (who was added, removed or replaced, and
 * each amount before → after), the count and exact total, the question that follows, a compact count · total · network line and every payment.
 */
export function batchChangeView(before: BatchView | null, after: BatchView, recipients: readonly SavedRecipient[], language: Language): BatchChangeView {
  const c = BATCH_CHAT_COPY[language], name = (address: string) => recipientName(address, recipients), total = shownDecimal(after.total, language);
  const count = after.payments.length;
  const tail = { summary: c.summary(count, total, after.asset, after.network), lines: batchPaymentLines(after, language, recipients), atomic: c.atomic };
  if (!before) {
    const to = count > 3 ? c.recipients(count) : join(after.payments.map(payment => name(payment.recipient)), language);
    return { text: c.created(total, after.asset, to), question: c.createdQuestion, ...tail };
  }
  const same = (a: string, b: string) => sameRecipient(after.network, a, b);
  const added = after.payments.filter(payment => !before.payments.some(old => same(old.recipient, payment.recipient)));
  const removed = before.payments.filter(old => !after.payments.some(payment => same(old.recipient, payment.recipient)));
  const parts: string[] = [];
  const replaced = added.length === 1 && removed.length === 1 && before.payments.length === count
    && before.payments.findIndex(old => same(old.recipient, removed[0]!.recipient)) === after.payments.findIndex(payment => same(payment.recipient, added[0]!.recipient));
  if (replaced) parts.push(c.replaced(name(removed[0]!.recipient), name(added[0]!.recipient)));
  else {
    if (added.length) parts.push(c.added(added.map(payment => name(payment.recipient))));
    if (removed.length) parts.push(c.removed(removed.map(payment => name(payment.recipient))));
  }
  for (const payment of after.payments) {
    const old = before.payments.find(item => same(item.recipient, payment.recipient));
    if (old && canonicalDecimal(old.amount) !== canonicalDecimal(payment.amount))
      parts.push(c.amount(name(payment.recipient), shownDecimal(old.amount, language), shownDecimal(payment.amount, language), after.asset));
  }
  return { text: [...parts.length ? parts : [c.updated], c.now(count, total, after.asset)].join(' '), question: c.editedQuestion, ...tail };
}
/** The Batch Payment step a chat change added or edited (with what it declared before), or null when it changed none. */
export function batchChatChange(before: Pick<Workflow, 'nodes'>, after: Pick<Workflow, 'nodes'>): { readonly nodeId: string; readonly before: BatchView | null; readonly after: BatchView } | null {
  const details = (node: Workflow['nodes'][number]) => batchPaymentDetails(node as Parameters<typeof batchPaymentDetails>[0]);
  for (const node of after.nodes) {
    const view = details(node);
    if (!view) continue;
    const old = before.nodes.find(item => item.nodeId === node.nodeId);
    if (!old) return { nodeId: node.nodeId, before: null, after: view };
    if (JSON.stringify(old) !== JSON.stringify(node)) return { nodeId: node.nodeId, before: details(old), after: view };
  }
  return null;
}
