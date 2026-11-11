// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: the secrets that prove a person reads a beta-list address (Email 3's access link and six-digit code) and the
 * one-click unsubscribe signature. Pure (node:crypto only): no database, no request, no clock of its own.
 *
 * - A link token and a code are DERIVED from the outbox email that carries them (`FLOFI_FLIGHT_ACCESS_SECRET`, HMAC-SHA-256), so a worker that
 *   renders the same email again after a crash or a lost provider answer renders exactly the same body (the provider's idempotency key then
 *   matches) and nothing secret is ever stored: the database keeps the SHA-256 of the link token and a keyed HMAC of the code.
 * - The link token travels in the URL FRAGMENT (`/board/access#t=…`): browsers never send a fragment to a server, so it is not in any request
 *   log, referrer or proxy; and opening the link consumes nothing — only the person's explicit "Continue" does (email scanners open links).
 * - A code is six digits, compared in constant time, valid until its persisted expiry, at most `CODE_MAX_ATTEMPTS` wrong tries per token, single use.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Email 3's link: 72 hours ("Link do e-mail: 72 horas"). */
export const ACCESS_LINK_MS = 72 * 60 * 60 * 1000;
/** A code the person asked for at /board: 15 minutes ("Código de 6 dígitos pedido na landing: 15 minutos"). */
export const REQUESTED_CODE_MS = 15 * 60 * 1000;
/** Email 3 (GROUP_BOARDING): 72 hours from generation, like its paired link. Existing rows keep their persisted expiry. */
export const EMAIL_CODE_MS = 72 * 60 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
/**
 * After proving the address before signing in, the browser keeps that proof for one day; it binds only when the person presses "Board now"
 * signed in (security review: a shared browser must not hand a stranger's entry to the next account for weeks).
 */
export const ACCESS_SESSION_MS = 24 * 60 * 60 * 1000;
export const ACCESS_SESSION_COOKIE = 'flofi_flight_access';
/** Abuse limits per hour ("5 tentativas de código por hora por IP e e-mail; 3 links únicos por hora por e-mail"). */
export const ACCESS_LIMITS = { codePerClientHour: 30, codePerAddressHour: 5, requestPerAddressHour: 3, requestPerClientHour: 30, consumePerClientHour: 120, // A link flow is a peek and a consume.
  // Requested access emails a tenant sends per day at most, and per entry per hour at most one: requests can never eat the email quota.
  requestedEmailsPerDay: 30 } as const; // Per-client limits allow carriers' shared IPv4 addresses (CGNAT), as the list form does.
/** A request without a usable client address counts under this one shared subject (it is never exempt). */
export const NO_CLIENT_SUBJECT = 'no-client';

const MIN_SECRET = 32;
/** The deployment's access secret, or null when it is missing or too short (every access feature then fails closed). */
export function accessSecret(env: Readonly<Record<string, string | undefined>>): string | null {
  const secret = env.FLOFI_FLIGHT_ACCESS_SECRET;
  return secret && secret.length >= MIN_SECRET ? secret : null;
}
const mac = (secret: string, label: string, value: string) => createHmac('sha256', createHmac('sha256', secret).update(`flofi-flight-${label}-v1`).digest())
  .update(value).digest();

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
/** The 43-character base64url link token carried by one email (256 bits). */
export const linkTokenFor = (secret: string, emailId: string) => mac(secret, 'link', emailId).toString('base64url');
export const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** The six-digit code carried by one email (uniform over 000000–999999 up to a negligible bias of 2^-32). */
export function codeFor(secret: string, emailId: string): string {
  const value = mac(secret, 'code', emailId).readUInt32BE(0);
  return String(value % 1_000_000).padStart(6, '0');
}
export const CODE = /^\d{6}$/;
export function normalizeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.replace(/[\s-]/g, '');
  return CODE.test(code) ? code : null;
}
/** What the database keeps for a code: bound to its token, keyed (a stolen table does not reveal codes by trying all million). */
export const codeHash = (secret: string, tokenId: string, code: string) => mac(secret, 'code-hash', `${tokenId}:${code}`).toString('hex');
export function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
/** The token row id of one email's access (stable across re-renders). */
export const tokenIdFor = (secret: string, emailId: string) => `fat_${mac(secret, 'token-id', emailId).subarray(0, 16).toString('hex')}`;

/**
 * The one-click unsubscribe parameter of one email: its id, its recipient's address digest and a signature over both, so nobody can unsubscribe
 * an address they did not receive, and the opt-out works even after the email's own record was pruned or erased.
 */
export const unsubscribeTokenFor = (secret: string, emailId: string, recipient: string) => {
  const digest = addressHash(recipient);
  return `${emailId}.${digest}.${mac(secret, 'unsubscribe', `${emailId}:${digest}`).subarray(0, 16).toString('base64url')}`;
};
export function readUnsubscribeToken(secret: string, value: unknown): { readonly emailId: string; readonly addressHash: string } | null {
  if (typeof value !== 'string' || value.length > 160) return null;
  const match = /^(fem_[0-9a-f]{32})\.([0-9a-f]{64})\.([A-Za-z0-9_-]{22})$/.exec(value);
  if (!match) return null;
  const expected = mac(secret, 'unsubscribe', `${match[1]}:${match[2]}`).subarray(0, 16).toString('base64url');
  const a = Buffer.from(expected), b = Buffer.from(match[3]!);
  return a.length === b.length && timingSafeEqual(a, b) ? { emailId: match[1]!, addressHash: match[2]! } : null;
}
/** A suppressed address is kept as the SHA-256 of its lower-cased form. */
export const addressHash = (email: string) => sha256Hex(`flofi-flight-address-v1:${email.trim().toLowerCase()}`);
/** A keyed digest of a rate-limit subject (an address or a network client), never the subject itself. */
export const subjectDigest = (secret: string, kind: string, value: string) => mac(secret, `subject-${kind}`, value).toString('hex');
