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
 * - at most `CONVERSATION_LIMITS` (messages, bytes, conversations, 24 hours); older ones are dropped, never invented again.
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
export const CONVERSATION_LIMITS = Object.freeze({ messages: 200, bytes: 300_000, conversations: 20, retentionMs: 24 * 60 * 60_000 });
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
  const { options: _options, question: _question, variants, ...rest } = message;
  void _options; void _question;
  if (!variants) return rest;
  const content = (value: ChatContent): ChatContent => { const { options: _o, question: _q, ...kept } = value; void _o; void _q; return kept; };
  return { ...rest, variants: { EN: content(variants.EN), PT: content(variants.PT) } };
}

const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
/** Structural check of a stored message: anything unexpected makes the whole record unusable (nothing is guessed or repaired). */
function storedMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (!Number.isSafeInteger(message.id) || (message.id as number) < 0 || typeof message.role !== 'string' || !ROLES.has(message.role) || typeof message.text !== 'string') return null;
  if (message.notes !== undefined && !strings(message.notes)) return null;
  if (message.params !== undefined && !strings(message.params)) return null;
  if (message.language !== undefined && message.language !== 'EN' && message.language !== 'PT') return null;
  if (message.verbatim !== undefined && typeof message.verbatim !== 'boolean') return null;
  if (message.link !== undefined && (!message.link || typeof (message.link as { path?: unknown }).path !== 'string' || typeof (message.link as { label?: unknown }).label !== 'string')) return null;
  if (message.review !== undefined && (!message.review || typeof message.review !== 'object' || !Array.isArray((message.review as { steps?: unknown }).steps))) return null;
  if (message.variants !== undefined) {
    const variants = message.variants as Record<string, unknown> | null;
    if (!variants || typeof variants !== 'object') return null;
    for (const language of ['EN', 'PT']) {
      const variant = variants[language] as Record<string, unknown> | undefined;
      if (!variant || typeof variant.text !== 'string' || (variant.notes !== undefined && !strings(variant.notes))) return null;
    }
  }
  return historical(message as unknown as ChatMessage);
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

/** Every stored conversation key of this tab, with its scope and age (unreadable records count as expired). */
function storedKeys(storage: NonNullable<WriteStorage>): { key: string; scope: string | null; savedAt: number }[] {
  const out: { key: string; scope: string | null; savedAt: number }[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(CONVERSATION_STORAGE_PREFIX)) continue;
    let savedAt = 0, scope: string | null = null;
    try {
      const record = JSON.parse(storage.getItem(key) ?? 'null') as { savedAt?: unknown; scope?: unknown } | null;
      savedAt = Number.isSafeInteger(record?.savedAt) ? record!.savedAt as number : 0; scope = typeof record?.scope === 'string' ? record.scope : null;
    } catch { /* unreadable: removed first */ }
    out.push({ key, scope, savedAt });
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
    let kept = messages.filter(message => !((message.role === 'you' || message.role === 'ai') && mayHoldSecret(message.text))).map(historical)
      .slice(-CONVERSATION_LIMITS.messages);
    let body = JSON.stringify({ format: FORMAT, scope, workflowId, savedAt: now, messages: kept });
    while (body.length > CONVERSATION_LIMITS.bytes && kept.length > 1) {
      kept = kept.slice(Math.ceil(kept.length / 4));
      body = JSON.stringify({ format: FORMAT, scope, workflowId, savedAt: now, messages: kept });
    }
    if (body.length > CONVERSATION_LIMITS.bytes) return;
    pruneConversations(storage, scope, now);
    const same = storedKeys(storage).filter(entry => entry.key !== key).sort((a, b) => b.savedAt - a.savedAt);
    for (const entry of same.slice(CONVERSATION_LIMITS.conversations - 1)) storage.removeItem(entry.key);
    // Reopening a conversation unchanged (a reload) keeps its original time: the retention period counts from its last new message.
    const stored = JSON.parse(storage.getItem(key) ?? 'null') as { scope?: unknown; workflowId?: unknown; savedAt?: unknown; messages?: unknown } | null;
    if (stored?.scope === scope && stored.workflowId === workflowId && Number.isSafeInteger(stored.savedAt) && now - (stored.savedAt as number) <= CONVERSATION_LIMITS.retentionMs
      && JSON.stringify(stored.messages) === JSON.stringify(kept)) return;
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
