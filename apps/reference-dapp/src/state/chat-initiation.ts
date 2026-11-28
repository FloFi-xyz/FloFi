// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (KAN-25 §8.1): the browser half of the web Chat's initiation reference. The reference is the server's
 * (`app/chat-initiation-action.ts`, account-bound and short-lived); this module only keeps the latest one in memory and presents it, in a cookie
 * scoped to the app page, for exactly the duration of a call the Chat itself starts (its Review's simulation). The Editor never presents it.
 *
 * Fail closed and side-effect free for the financial flow: nothing waits for a reference. Without a fresh one (none issued yet, no FloFi account
 * session, a failed read) the call runs unchanged and is recorded as the Editor's; a refresh starts in the background for the next one.
 */
import { chatInitiationReference } from '../app/chat-initiation-action';
import { chatInitiationCookie, clearedChatInitiationCookie } from '../domain/chat-initiation';

type Held = { readonly reference: string; readonly expiresAt: number; readonly fetchedAt: number; readonly scope: string | null };
/** `scope`: the signed-in account's opaque conversation scope the held reference was fetched under (another account fetches its own). */
let held: Held | null = null, loading: Promise<void> | null = null, open = 0, wanted = false, scope: string | null = null;
/** A reference older than this is replaced in the background; one ending within MIN_REMAINING_MS is never presented. */
const REFRESH_AFTER_MS = 5 * 60_000, MIN_REMAINING_MS = 60_000;
const secure = () => typeof window !== 'undefined' && window.location.protocol === 'https:';
const write = (value: string) => { try { if (typeof document !== 'undefined') document.cookie = value; } catch { /* presented nowhere: the Editor's */ } };

/** Fetches a reference when none is held, the held one is getting old or another account signed in (deduplicated; never throws). */
export function ensureChatInitiation(now = Date.now(), account: string | null = scope): Promise<void> {
  wanted = true;
  if (account !== scope) { scope = account; held = null; }
  if (held && now - held.fetchedAt < REFRESH_AFTER_MS && held.expiresAt - now > MIN_REMAINING_MS) return Promise.resolve();
  const asked = scope;
  return loading ??= chatInitiationReference().then(value => {
    held = wanted && asked === scope && value && typeof value.reference === 'string' && Number.isFinite(value.expiresAt) ? { ...value, fetchedAt: Date.now(), scope: asked } : null;
  }, () => { held = null; }).finally(() => { loading = null; });
}
/** Drops the held reference and stops refreshing it (no account session, not the app page's Chat). */
export function forgetChatInitiation(): void { wanted = false; held = null; if (!open) write(clearedChatInitiationCookie(secure())); }

/**
 * Runs `work` (a call the Chat starts) with the held reference presented, and withdraws it when `work` settles. Returns `work`'s own result,
 * unchanged; `work` starts synchronously, exactly as without this wrapper.
 */
export function chatInitiated<T>(work: () => T | Promise<T>, now = Date.now()): Promise<T> {
  const current = held && held.scope === scope && held.expiresAt - now > MIN_REMAINING_MS ? held : null;
  if (wanted) void ensureChatInitiation(now);
  const cookie = current ? chatInitiationCookie(current.reference, Math.min((current.expiresAt - now) / 1000, 900), secure()) : null;
  if (cookie) { open++; write(cookie); }
  const close = () => { if (cookie && --open === 0) write(clearedChatInitiationCookie(secure())); };
  let result: T | Promise<T>;
  try { result = work(); } catch (error) { close(); return Promise.reject(error); }
  return Promise.resolve(result).finally(close);
}
