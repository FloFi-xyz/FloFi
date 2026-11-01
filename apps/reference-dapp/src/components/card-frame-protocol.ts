// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: the messages between Add card on the product origin and the card page on the card origin
 * (src/server/card-origin.ts). Only Mercado Pago's one-time card token and the email ever cross, never card data.
 */
/** The messages between Add card (product origin) and the card page (card origin). Strict shapes; anything else is ignored. */
export type CardFrameMessage =
  | { readonly type: 'flofi-card-ready' }
  | { readonly type: 'flofi-card-unavailable' }
  | { readonly type: 'flofi-card-cancel' }
  | { readonly type: 'flofi-card-token'; readonly token: string; readonly email: string };
export type CardParentMessage = { readonly type: 'flofi-card-result'; readonly ok: boolean; readonly error?: string };
const TOKEN = /^[A-Za-z0-9_-]{8,256}$/;
/** The email shape both sides accept (the card page checks it before asking the provider for a token). */
export const CARD_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
export function parseCardFrameMessage(value: unknown): CardFrameMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>, keys = Object.keys(message).sort().join(',');
  if ((message.type === 'flofi-card-ready' || message.type === 'flofi-card-unavailable' || message.type === 'flofi-card-cancel') && keys === 'type')
    return { type: message.type };
  if (message.type === 'flofi-card-token' && keys === 'email,token,type' && typeof message.token === 'string' && TOKEN.test(message.token)
    && typeof message.email === 'string' && message.email.length <= 254 && CARD_EMAIL.test(message.email)) return { type: 'flofi-card-token', token: message.token, email: message.email };
  return null;
}
export function parseCardParentMessage(value: unknown): CardParentMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.type !== 'flofi-card-result' || typeof message.ok !== 'boolean') return null;
  const keys = Object.keys(message).sort().join(',');
  if (keys === 'ok,type') return { type: 'flofi-card-result', ok: message.ok };
  if (keys === 'error,ok,type' && typeof message.error === 'string' && message.error.length <= 200) return { type: 'flofi-card-result', ok: message.ok, error: message.error };
  return null;
}
