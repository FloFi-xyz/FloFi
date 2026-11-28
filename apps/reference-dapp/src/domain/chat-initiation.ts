// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (KAN-25 §8.1): how the web Chat's initiation reference travels with the server actions the Chat itself
 * starts. Pure and client-safe (no key, no crypto). The reference is minted and verified only on the server (`server/chat-initiation.ts`); the
 * browser merely holds an opaque, short-lived value it cannot forge and presents it in a cookie scoped to the FloFi app page while the Chat's own
 * Review runs. Anything else (no cookie, an unverifiable value, another account's) is the Editor: a reference is never required and never fails
 * a call.
 */
export const CHAT_INITIATION_COOKIE = 'flofi_chat_initiation';
/** Only the app page's own server actions carry it (`/app`, `/app/…`; never `/approve`, `/mcp/approve` or any other page). */
export const CHAT_INITIATION_PATH = '/app';
/** The shape of a reference (`ci1.<payload>.<mac>`, base64url parts), so a cookie value is never anything else. */
export const CHAT_INITIATION_FORMAT = /^ci1\.[A-Za-z0-9_-]{16,256}\.[A-Za-z0-9_-]{43}$/;

/** The `document.cookie` assignment presenting `reference` for at most `maxAgeSeconds` (host-only, Strict, Secure over HTTPS). */
export function chatInitiationCookie(reference: string, maxAgeSeconds: number, secure: boolean): string | null {
  if (!CHAT_INITIATION_FORMAT.test(reference)) return null;
  const age = Math.max(1, Math.min(900, Math.floor(maxAgeSeconds)));
  return `${CHAT_INITIATION_COOKIE}=${reference}; Path=${CHAT_INITIATION_PATH}; Max-Age=${age}; SameSite=Strict${secure ? '; Secure' : ''}`;
}
/** The assignment that removes it. */
export const clearedChatInitiationCookie = (secure: boolean): string =>
  `${CHAT_INITIATION_COOKIE}=; Path=${CHAT_INITIATION_PATH}; Max-Age=0; SameSite=Strict${secure ? '; Secure' : ''}`;
