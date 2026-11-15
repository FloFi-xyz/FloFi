// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: the signed-in account's Saved Recipients in this page, IN MEMORY ONLY (never Web Storage). The server actions
 * in `app/recipient-action.ts` are the only source: the account comes from the verified session cookie, so a signed-out page reads nothing and
 * stores nothing. A saved recipient is a name for a public address — never proof of ownership, a delegation or an authorization; `status` of
 * each recipient is derived by the server from verified wallets.
 *
 * Isolation between accounts (one page, one session): the list is dropped by `invalidateSavedRecipients()` — called on Disconnect, on a
 * completed sign-in, after account deletion and whenever Credentials re-reads the account — and automatically when the page observes another
 * Privy user (or none) than the one it read the list for, and it is read again once older than `SAVED_RECIPIENTS_FRESH_MS`. A refusal that says
 * the session ended clears it at once. So a later sign-in in this page never sees another account's names.
 *
 * Public API (stable; consumed by Credentials, the Review destination tag and the Copilot):
 *   - `useSavedRecipients(): SavedRecipientsState` — React hook (useSyncExternalStore): `{ status, recipients, code }`. The server render and
 *     the first client render see `status: 'IDLE'` and no recipients. Reading the hook never calls the server.
 *   - `savedRecipientsSnapshot()` / `subscribeSavedRecipients(listener)` — the same state outside React.
 *   - `loadSavedRecipients({ ifStale? })` — reads the list from the server; concurrent calls share one request; `ifStale: true` reads only when
 *     nothing was read yet for this session or the list is older than `SAVED_RECIPIENTS_FRESH_MS`. Resolves to the new state.
 *   - `saveRecipientReference({ label, address, ecosystem? })`, `renameRecipientReference(id, label)`, `removeRecipientReference(id)` —
 *     `RecipientOutcome<T>`: `{ ok: true, value }` or `{ ok: false, code, existing? }` with a closed code (see recipient-action.ts).
 *     RECIPIENT_EXISTS carries the record already saved for that address (nothing was changed).
 *   - `savedRecipientForAddress(address, recipients)` — the saved recipient whose canonical address equals `address` exactly (display only:
 *     an address is never derived from a name), or null.
 *   - `invalidateSavedRecipients()` — drops the list (status `IDLE`); the next `loadSavedRecipients` reads the current session again.
 * Status: IDLE (not read for this session) → LOADING → READY | SIGNED_OUT (no account session: no recipients) | UNAVAILABLE (accounts or
 * migration 0028 are not available on this deployment: no recipients) | ERROR (`code` says why; recipients of THIS session already read are kept).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useFloFiPrivy } from '../accounts/privy-context';
import { listSavedRecipients, removeSavedRecipient, renameSavedRecipient, saveRecipient, type SaveRecipientInput } from '../app/recipient-action';
import { ecosystemOfAddress, savedRecipientAddress, type SavedRecipient, type SavedRecipientView } from '../domain/saved-recipients';

export type SavedRecipientsStatus = 'IDLE' | 'LOADING' | 'READY' | 'SIGNED_OUT' | 'UNAVAILABLE' | 'ERROR';
export type SavedRecipientsState = { readonly status: SavedRecipientsStatus; readonly recipients: readonly SavedRecipientView[]; readonly code: string | null };
export type RecipientOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly existing?: SavedRecipientView };
/** A list read longer ago than this is read again by `loadSavedRecipients({ ifStale: true })`. */
export const SAVED_RECIPIENTS_FRESH_MS = 60_000;

const NONE: readonly SavedRecipientView[] = Object.freeze([]);
const IDLE: SavedRecipientsState = Object.freeze({ status: 'IDLE', recipients: NONE, code: null });
const SIGNED_OUT = new Set(['ACCOUNT_SESSION_REQUIRED', 'ACCOUNT_NOT_FOUND']);
const UNAVAILABLE = new Set(['RECIPIENTS_UNAVAILABLE', 'ACCOUNTS_NOT_CONFIGURED']);
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const listeners = new Set<() => void>();
let state: SavedRecipientsState = IDLE;
/** Bumped by every change and invalidation, so a read started earlier never overwrites what came after it (or another session's state). */
let generation = 0;
let inflight: { readonly generation: number; readonly promise: Promise<SavedRecipientsState> } | null = null;
let readAt = 0;
/** The Privy user (or null) the page last observed; undefined until a component first observes it. */
let observedUser: string | null | undefined;

function publish(next: SavedRecipientsState): SavedRecipientsState {
  state = Object.freeze({ ...next, recipients: Object.freeze([...next.recipients]) });
  for (const listener of listeners) listener();
  return state;
}
const closed = (code: unknown) => (typeof code === 'string' && CODE.test(code) ? code : 'RECIPIENTS_REQUEST_FAILED');
/** The state a refusal leads to: an ended session or an unavailable feature has no recipients at all. */
const after = (code: string, kept: readonly SavedRecipientView[]): SavedRecipientsState =>
  SIGNED_OUT.has(code) ? { status: 'SIGNED_OUT', recipients: NONE, code } : UNAVAILABLE.has(code) ? { status: 'UNAVAILABLE', recipients: NONE, code }
    : { status: 'ERROR', recipients: kept, code };
function refused<T>(code: string): RecipientOutcome<T> {
  if (SIGNED_OUT.has(code) || UNAVAILABLE.has(code)) { generation++; publish(after(code, NONE)); }
  return { ok: false, code };
}
function changed(recipients: readonly SavedRecipientView[]): void { generation++; readAt = Date.now(); publish({ status: 'READY', recipients, code: null }); }
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: a write that finishes after the list was invalidated (another sign-in, a re-read) or left READY never publishes a
 * list built from the old one: the next read fetches the current session's list instead.
 */
function changedSince(started: number, next: () => readonly SavedRecipientView[]): void {
  if (started !== generation || state.status !== 'READY') { readAt = 0; return; }
  changed(next());
}
const upsert = (recipient: SavedRecipientView) => {
  const at = state.recipients.findIndex(other => other.id === recipient.id);
  return at < 0 ? [...state.recipients, recipient] : state.recipients.map((other, index) => index === at ? recipient : other);
};

export function savedRecipientsSnapshot(): SavedRecipientsState { return state; }
export function subscribeSavedRecipients(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function invalidateSavedRecipients(): void { generation++; inflight = null; readAt = 0; publish(IDLE); }
/** The current session's saved recipients. Observes the Privy user: another user (or none) than before drops the list at once. */
export function useSavedRecipients(): SavedRecipientsState {
  const user = useFloFiPrivy()?.userId ?? null;
  useEffect(() => {
    if (observedUser !== undefined && observedUser !== user) invalidateSavedRecipients();
    observedUser = user;
  }, [user]);
  return useSyncExternalStore(subscribeSavedRecipients, savedRecipientsSnapshot, () => IDLE);
}

export function loadSavedRecipients(options: { readonly ifStale?: boolean } = {}): Promise<SavedRecipientsState> {
  if (inflight && inflight.generation === generation) return inflight.promise;
  // Signed out or not available on this deployment: nothing to re-read until the session changes (sign-in invalidates the list).
  if (options.ifStale && (state.status === 'SIGNED_OUT' || state.status === 'UNAVAILABLE')) return Promise.resolve(state);
  if (options.ifStale && state.status !== 'IDLE' && state.status !== 'ERROR' && Date.now() - readAt < SAVED_RECIPIENTS_FRESH_MS) return Promise.resolve(state);
  const started = ++generation;
  publish({ ...state, status: 'LOADING', code: null });
  const promise = listSavedRecipients().catch(() => ({ ok: false as const, code: 'RECIPIENTS_REQUEST_FAILED' })).then(result => {
    if (started !== generation) return state;
    if (inflight?.generation === started) inflight = null;
    readAt = Date.now();
    return publish(result.ok ? { status: 'READY', recipients: result.value, code: null } : after(closed(result.code), state.recipients));
  });
  inflight = { generation: started, promise };
  return promise;
}

export async function saveRecipientReference(input: SaveRecipientInput): Promise<RecipientOutcome<SavedRecipientView>> {
  const started = generation;
  const result = await saveRecipient(input).catch(() => ({ ok: false as const, code: 'RECIPIENTS_REQUEST_FAILED' }));
  if (!result.ok && 'existing' in result) {
    // Nothing was written: the account already holds this address, and the list shows that record (under its own name).
    changedSince(started, () => upsert(result.existing));
    return { ok: false, code: 'RECIPIENT_EXISTS', existing: result.existing };
  }
  if (!result.ok) return refused(closed(result.code));
  changedSince(started, () => upsert(result.value));
  return { ok: true, value: result.value };
}
export async function renameRecipientReference(id: string, label: string): Promise<RecipientOutcome<SavedRecipientView>> {
  const started = generation;
  const result = await renameSavedRecipient(id, label).catch(() => ({ ok: false as const, code: 'RECIPIENTS_REQUEST_FAILED' }));
  // Already gone (removed elsewhere): the list drops it, as a remove does.
  if (!result.ok && result.code === 'RECIPIENT_NOT_FOUND') { changedSince(started, () => state.recipients.filter(recipient => recipient.id !== id)); return { ok: false, code: 'RECIPIENT_NOT_FOUND' }; }
  if (!result.ok) return refused(closed(result.code));
  changedSince(started, () => upsert(result.value));
  return { ok: true, value: result.value };
}
export async function removeRecipientReference(id: string): Promise<RecipientOutcome<null>> {
  const started = generation;
  const result = await removeSavedRecipient(id).catch(() => ({ ok: false as const, code: 'RECIPIENTS_REQUEST_FAILED' }));
  // Already gone (removed elsewhere): the list drops it too, and the caller still learns it was not found.
  if (!result.ok && result.code !== 'RECIPIENT_NOT_FOUND') return refused(closed(result.code));
  changedSince(started, () => state.recipients.filter(recipient => recipient.id !== id));
  return result.ok ? { ok: true, value: null } : { ok: false, code: 'RECIPIENT_NOT_FOUND' };
}

/** The saved recipient whose canonical address is exactly `address` (EVM compared in lower case after the EIP-55 rule; Solana as typed). */
export function savedRecipientForAddress<T extends SavedRecipient>(address: string | null | undefined, recipients: readonly T[]): T | null {
  if (!address || !recipients.length) return null;
  const ecosystem = ecosystemOfAddress(address), canonical = ecosystem ? savedRecipientAddress(ecosystem, address) : null;
  return canonical ? recipients.find(recipient => recipient.ecosystem === ecosystem && recipient.address === canonical) ?? null : null;
}
