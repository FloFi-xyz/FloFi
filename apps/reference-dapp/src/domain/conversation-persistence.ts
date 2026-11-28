// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HOTFIX-P1-FLIGHT-ACCESS-AND-CHAT-RECOVERY-001 (production 2026-11-16): the FloFi chat survives a reload or an unexpected remount of the Editor.
 * Before, the conversation lived only in React memory and was replaced by the welcome message whenever the connected wallet identity changed
 * (an EVM wallet → the Solana session of a Jupiter swap), while the Canvas kept the workflow the chat had just built.
 *
 * What is kept, where and for how long:
 * - only in THIS browser tab's sessionStorage (removed when the tab closes), never sent to a FloFi server: the conversation's own temporary
 *   state, as the privacy notice describes it, made to outlive a reload of the same tab;
 * - only for a signed-in FloFi account, under an opaque digest of its tenant and account the server supplies (`server/conversation-scope.ts`),
 *   and per workflow identity: another account, tenant or workflow never reads or receives these messages; signing out removes them;
 * - at most `CONVERSATION_LIMITS` (messages, bytes, conversations, 24 hours from the last new message); older ones are dropped, never invented
 *   again (FloFi's welcome stays first).
 *
 * Only what the chat showed is kept (text, notes, the Review summary it displayed). Never a question's answer buttons or an open question:
 * a restored conversation is read-only history, and every confirmation is asked again against a fresh Review. A message the owner typed (or
 * a model reply) that FloFi recognises as a possible private key, secret key or recovery phrase (`mayHoldSecret`) is not written. No wallet
 * signature, token, credential, quote, authorization or execution payload is part of a chat message. Nothing is written once the page is
 * leaving through sign-out or account deletion (`pageExitInProgress`), which remove what this tab kept.
 */
import type { ChatContent, ChatMessage } from './chat-message';
import { looksSecret } from './copilot-conversation';
import { pageExitInProgress } from '../accounts/page-exit';

export const CONVERSATION_STORAGE_PREFIX = 'flofi:conversation:v1:';
const FORMAT = 'flofi.conversation.v1';
// At most about 2 million characters for the whole tab (10 × 200 000), well inside the browser's sessionStorage quota for this origin.
export const CONVERSATION_LIMITS = Object.freeze({ messages: 200, bytes: 200_000, conversations: 10, retentionMs: 24 * 60 * 60_000 });
const SCOPE = /^[A-Za-z0-9_-]{32}$/; // `server/conversation-scope.ts` conversationScopeOf: 32 base64url characters.
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROLES: ReadonlySet<string> = new Set(['you', 'system', 'ai', 'flofi']);
type ReadStorage = Pick<Storage, 'getItem'> | null;
type WriteStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> | null;

/** This tab's sessionStorage, or null where it is blocked (private modes, sandboxed frames): the chat then stays in memory, as before. */
export function conversationStorage(): WriteStorage {
  try { return window.sessionStorage; } catch { return null; }
}
/** The storage key of one account's conversation about one workflow, or null when either identity is not usable. */
export function conversationStorageKey(scope: string | null | undefined, workflowId: string): string | null {
  return scope && SCOPE.test(scope) && WORKFLOW_ID.test(workflowId) ? `${CONVERSATION_STORAGE_PREFIX}${scope}:${workflowId}` : null;
}

const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]{64,}/;
const BYTE_ARRAY = /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/;
const PHRASE = /^(?:[a-z]{3,8} ){11,23}[a-z]{3,8}$/;
/**
 * The chat's own refusal (`looksSecret`: words that name a key or phrase, a 64-hex secret, a lowercase phrase) and, for this tab's storage only,
 * the other shapes a wallet exports: a Solana secret key (base58, far longer than an address), a keypair file's byte array, and a recovery
 * phrase written with capitals, numbering or punctuation. Erring towards not keeping a message only means it is not restored after a reload.
 */
export function mayHoldSecret(text: string): boolean {
  if (looksSecret(text) || BASE58_RUN.test(text) || BYTE_ARRAY.test(text)) return true;
  const words = text.toLowerCase().replace(/\b\d{1,2}\s*[.):-]/g, ' ').replace(/[,.;:!?"'“”()[\]-]/g, ' ').replace(/\s+/g, ' ').trim();
  return PHRASE.test(words);
}

/** A message as history: its answer buttons and open question are not restored (the question it asked is no longer open). */
export function historical(message: ChatMessage): ChatMessage {
  const { options: _options, question: _question, awaitingAmount: _awaiting, focus: _focus, variants, ...rest } = message;
  void _options; void _question; void _awaiting; void _focus;
  if (!variants) return rest;
  const content = (value: ChatContent): ChatContent => { const { options: _o, question: _q, ...kept } = value; void _o; void _q; return kept; };
  return { ...rest, variants: { EN: content(variants.EN), PT: content(variants.PT) } };
}

const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const lines = (value: unknown) => Array.isArray(value) && value.every(line => record(line) && typeof line.label === 'string' && typeof line.value === 'string');
/**
 * Every part of a Review summary the chat's Review card reads (`components/conversation-cards.tsx`), checked before it is shown again: a record
 * kept by an earlier version of FloFi that no longer has this shape is restored as its text alone, never rendered half-read.
 */
function reviewShape(value: unknown): boolean {
  if (!record(value) || !strings(value.walletRequests) || !strings(value.providerSteps) || !strings(value.unknown) || !lines(value.fees) || !lines(value.limits)) return false;
  if (!Array.isArray(value.warnings) || !value.warnings.every(warning => record(warning) && typeof warning.message === 'string')) return false;
  if (!Array.isArray(value.approvals) || !value.approvals.every(approval => record(approval) && ['symbol', 'value', 'spender', 'network'].every(field => typeof approval[field] === 'string'))) return false;
  const totals = value.totals, fee = value.flofiFee, sequence = value.sequence;
  if (!record(totals) || !strings(totals.additional) || !strings(totals.ceilings) || !Array.isArray(totals.excludes)
    || !totals.excludes.every(item => record(item) && typeof item.text === 'string' && Array.isArray(item.parameters))) return false;
  if (!record(fee) || typeof fee.value !== 'string' || typeof fee.note !== 'string' || typeof fee.recorded !== 'boolean') return false;
  if (sequence !== null && (!record(sequence) || !Array.isArray(sequence.steps) || !Number.isSafeInteger(sequence.total))) return false;
  return Array.isArray(value.steps) && value.steps.length > 0 && value.steps.every(step => record(step) && Number.isSafeInteger(step.number)
    && typeof step.action === 'string' && typeof step.input === 'string' && typeof step.resultLabel === 'string' && lines(step.details));
}
/** A content rendering whose Review is not readable any more keeps its text, notes and everything else. */
function withReadableReview<T extends { review?: unknown }>(value: T): T {
  if (value.review === undefined || reviewShape(value.review)) return value;
  const { review: _review, ...rest } = value; void _review;
  return rest as T;
}
/** Structural check of a stored message: anything unexpected makes the whole record unusable (nothing is guessed or repaired). */
function storedMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (!Number.isSafeInteger(message.id) || (message.id as number) < 0 || typeof message.role !== 'string' || !ROLES.has(message.role) || typeof message.text !== 'string') return null;
  if (message.notes !== undefined && !strings(message.notes)) return null;
  if (message.params !== undefined && !strings(message.params)) return null;
  if (message.language !== undefined && message.language !== 'EN' && message.language !== 'PT') return null;
  if (message.verbatim !== undefined && typeof message.verbatim !== 'boolean') return null;
  if (message.fixedLanguage !== undefined && message.fixedLanguage !== true) return null;
  if (message.link !== undefined && (!message.link || typeof (message.link as { path?: unknown }).path !== 'string' || typeof (message.link as { label?: unknown }).label !== 'string')) return null;
  if (message.variants !== undefined) {
    const variants = message.variants as Record<string, unknown> | null;
    if (!variants || typeof variants !== 'object') return null;
    for (const language of ['EN', 'PT']) {
      const variant = variants[language] as Record<string, unknown> | undefined;
      if (!variant || typeof variant.text !== 'string' || (variant.notes !== undefined && !strings(variant.notes))) return null;
    }
  }
  const restored = withReadableReview(historical(message as unknown as ChatMessage));
  return restored.variants ? { ...restored, variants: { EN: withReadableReview(restored.variants.EN), PT: withReadableReview(restored.variants.PT) } } : restored;
}

/**
 * The stored conversation of this account and workflow, as read-only history; null when nothing usable is stored (absent, another format,
 * another scope or workflow, malformed, or older than the retention period — an expired record is removed).
 */
export function readConversation(storage: ReadStorage & Partial<Pick<Storage, 'removeItem'>> | null, scope: string | null | undefined, workflowId: string,
  now: number): ChatMessage[] | null {
  const key = conversationStorageKey(scope, workflowId);
  if (!storage || !key) return null;
  let value: unknown;
  try { value = JSON.parse(storage.getItem(key) ?? 'null'); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { format?: unknown; scope?: unknown; workflowId?: unknown; savedAt?: unknown; messages?: unknown };
  if (record.format !== FORMAT || record.scope !== scope || record.workflowId !== workflowId || !Number.isSafeInteger(record.savedAt) || !Array.isArray(record.messages)) return null;
  if (now - (record.savedAt as number) > CONVERSATION_LIMITS.retentionMs || (record.savedAt as number) > now + 60_000) {
    try { storage.removeItem?.(key); } catch { /* storage is optional */ }
    return null;
  }
  const messages = record.messages.map(storedMessage);
  return messages.length && messages.every(message => message !== null) ? messages as ChatMessage[] : null;
}

/**
 * A kept record's scope and time, read from its fixed opening (`writeConversation` always writes these fields first, in this order) without
 * parsing the messages: cheap enough to run on every message. Anything else reads as unknown (scope null, time 0: removed first).
 */
const HEADER = /^\{"format":"flofi\.conversation\.v1","scope":"([A-Za-z0-9_-]{32})","workflowId":"[A-Za-z0-9._:-]{1,128}","savedAt":(\d{1,16}),/;
function headerOf(value: string | null): { scope: string | null; savedAt: number } {
  const match = value ? HEADER.exec(value.slice(0, 256)) : null;
  return match ? { scope: match[1]!, savedAt: Number(match[2]) } : { scope: null, savedAt: 0 };
}
/** Every stored conversation key of this tab, with its scope and age. */
function storedKeys(storage: NonNullable<WriteStorage>): { key: string; scope: string | null; savedAt: number }[] {
  const out: { key: string; scope: string | null; savedAt: number }[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(CONVERSATION_STORAGE_PREFIX)) out.push({ key, ...headerOf(storage.getItem(key)) });
  }
  return out;
}

/**
 * Keeps this account's conversation about this workflow. Nothing is written for a conversation the owner has not taken part in (FloFi's
 * welcome alone), for an unusable identity, or when storage is unavailable or full (the chat then stays in memory for this visit). The newest
 * messages are kept within the limits; another account's conversations in this tab are removed, and the oldest beyond the limit too.
 */
export function writeConversation(storage: WriteStorage, scope: string | null | undefined, workflowId: string, messages: readonly ChatMessage[], now: number): void {
  const key = conversationStorageKey(scope, workflowId);
  if (!storage || !key || pageExitInProgress() || !messages.some(message => message.role === 'you')) return;
  try {
    // FloFi's own deterministic messages carry public addresses and hashes, never what the owner typed; the owner's and the model's text is checked.
    const safe = messages.filter(message => !((message.role === 'you' || message.role === 'ai') && mayHoldSecret(message.text))).map(historical);
    // FloFi's welcome stays first (the panel renders the first message as the welcome); the newest of the rest fit the limits.
    const head = safe[0]?.id === 0 ? [safe[0]] : [];
    let rest = safe.slice(head.length).slice(-(CONVERSATION_LIMITS.messages - head.length));
    const bodyOf = (savedAt: number) => JSON.stringify({ format: FORMAT, scope, workflowId, savedAt, messages: [...head, ...rest] });
    let body = bodyOf(now);
    while (body.length > CONVERSATION_LIMITS.bytes && rest.length > 1) { rest = rest.slice(Math.ceil(rest.length / 4)); body = bodyOf(now); }
    if (body.length > CONVERSATION_LIMITS.bytes) return;
    pruneConversations(storage, scope, now);
    const others = storedKeys(storage).filter(entry => entry.key !== key).sort((a, b) => b.savedAt - a.savedAt);
    for (const entry of others.slice(CONVERSATION_LIMITS.conversations - 1)) storage.removeItem(entry.key);
    // Reopening a conversation unchanged (a reload) keeps its original time: the retention period counts from its last new message.
    const stored = storage.getItem(key), header = headerOf(stored);
    if (header.scope === scope && now - header.savedAt <= CONVERSATION_LIMITS.retentionMs && stored === bodyOf(header.savedAt)) return;
    storage.setItem(key, body);
  } catch { /* storage is optional (quota, private mode): the conversation stays in memory this visit */ }
}

/**
 * Removes what this tab keeps for anyone else or for too long: every conversation of another account (or unreadable) and every expired one.
 * Run when a signed-in account opens its conversation and before each write, so a previous account's chat never waits for this one to type.
 */
export function pruneConversations(storage: WriteStorage, scope: string | null | undefined, now: number): void {
  if (!storage || !scope) return;
  try {
    for (const entry of storedKeys(storage)) if (entry.scope !== scope || now - entry.savedAt > CONVERSATION_LIMITS.retentionMs) storage.removeItem(entry.key);
  } catch { /* storage is optional */ }
}

/** Removes one conversation (an explicit New workflow over a stored identity) or, without a key, every conversation of this tab (sign-out). */
export function forgetConversations(storage: WriteStorage, only?: { readonly scope: string | null | undefined; readonly workflowId: string }): void {
  if (!storage) return;
  try {
    if (only) { const key = conversationStorageKey(only.scope, only.workflowId); if (key) storage.removeItem(key); return; }
    for (const entry of storedKeys(storage)) storage.removeItem(entry.key);
  } catch { /* storage is optional */ }
}
