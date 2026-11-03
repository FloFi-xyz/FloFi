// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-UX-FIX-003: the header's account entry, read once per page and shared. Before, the Settings menu asked the server for the whole
 * account (`accountState`, four database reads) and the learning tier each time it first opened, then grew a row or two and changed width while
 * open. Now the page reads only the session's presence (`accountPresence`, one verified read, no account data), ahead of the first open (idle time,
 * or hover/focus on the gear), and every reader shares that one request.
 *
 * Freshness without leaking another session's state: the value lives only in this page's memory (never Web Storage), is forgotten and read again
 * when the page observes a different Privy user, expires after a short time, and is read again when the tab becomes visible. Signing in, signing
 * out and deleting the account already load a fresh page, which starts empty.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { accountPresence, type AccountPresence } from '../app/account-action';

export const ACCOUNT_PRESENCE_FRESH_MS = 30_000;
/** One page, one browser session cookie: a session change this page observes calls `forgetAccountPresence` (the header does, on a Privy user change). */
const PAGE_KEY = 'page';
type Entry = { readonly key: string; readonly value: AccountPresence; readonly at: number };
let entry: Entry | null = null;
let pending: { readonly key: string; readonly promise: Promise<AccountPresence> } | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** The shared presence for `key` (one request in flight per key); a fresh value is returned without a request. */
export function readAccountPresence(key: string, read: () => Promise<AccountPresence> = accountPresence, now = Date.now()): Promise<AccountPresence> {
  if (entry?.key === key && now - entry.at < ACCOUNT_PRESENCE_FRESH_MS) return Promise.resolve(entry.value);
  if (pending?.key === key) return pending.promise;
  const promise = read().then(value => {
    if (pending?.promise === promise) { entry = { key, value, at: Date.now() }; pending = null; notify(); }
    return value;
  }, cause => {
    // A failed read leaves only the safe fallback ("Sign in"), already stale, so the next prefetch asks again.
    if (pending?.promise === promise) { pending = null; entry = { key, value: { accounts: true, signedIn: false }, at: 0 }; notify(); }
    throw cause;
  });
  pending = { key, promise };
  return promise;
}
/** The value known for `key`, or null (unknown: never another key's value). */
export const knownAccountPresence = (key: string): AccountPresence | null => entry?.key === key ? entry.value : null;
/** Forgets everything (tests, and a session change this page observes). */
export function forgetAccountPresence(): void { entry = null; pending = null; notify(); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/**
 * The presence for this page, prefetched when the browser is idle after mount (or at once through `prefetch`, e.g. on hover or focus of the gear),
 * re-read when the tab becomes visible again after it went stale. `enabled` false (accounts not offered, or the MCP approval page) reads nothing.
 */
export function useAccountPresence(enabled: boolean): { readonly presence: AccountPresence | null; readonly prefetch: () => void } {
  const key = PAGE_KEY;
  const presence = useSyncExternalStore(subscribe, () => enabled ? knownAccountPresence(key) : null, () => null);
  const prefetch = useCallback(() => { if (enabled) void readAccountPresence(key).catch(() => undefined); }, [enabled, key]);
  useEffect(() => {
    if (!enabled) return;
    const idle = typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(prefetch, { timeout: 2_000 }) : null;
    const timer = idle === null ? window.setTimeout(prefetch, 600) : null;
    const visible = () => { if (document.visibilityState === 'visible') prefetch(); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      if (idle !== null) window.cancelIdleCallback(idle);
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [enabled, prefetch]);
  return { presence, prefetch };
}
