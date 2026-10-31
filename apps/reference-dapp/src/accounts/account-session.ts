// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: sealed, server-verified account cookies.
 *
 * The account session cookie is HttpOnly, host-bound and MAC-sealed with a key derived (separate HKDF label) from the same
 * deployment secret as the wallet session (`FLOFI_SESSION_SECRET`, else `API_AUTH_TOKEN`, else a per-process key on a local
 * server only). A sealed cookie is necessary but not sufficient: the account store must also hold an unrevoked, unexpired record
 * for its session id (`account-store.ts`), so sign-out and "sign out everywhere" take effect server-side.
 *
 * The short-lived flow cookies (OIDC state, email challenge) carry only nonces, PKCE verifiers, the provider's OTP id and the
 * browser's public session key: never an OTP code, an OIDC token or any wallet key.
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { walletSessionKey } from '../server/wallet-session.ts';
import { ACCOUNT_ID, type IdentityKind } from './account-model.ts';

type Env = Readonly<Record<string, string | undefined>>;
export const ACCOUNT_SESSION_COOKIE = 'flofi_account_session';
export const ACCOUNT_OIDC_COOKIE = 'flofi_account_oidc';
export const ACCOUNT_EMAIL_COOKIE = 'flofi_account_email';
export const ACCOUNT_SESSION_TTL_SECONDS = 12 * 3600;
export const ACCOUNT_FLOW_TTL_SECONDS = 600;
/** A sensitive action (wallet export) needs a sign-in at most this old. */
export const ACCOUNT_REAUTH_SECONDS = 10 * 60;

export type AccountSessionToken = { readonly accountId: string; readonly sessionId: string; readonly method: IdentityKind;
  readonly authenticatedAt: number; readonly expiresAt: number;
  /** Hint only (never authority): the browser key that the wallet provider opened a session for at sign-in, and until when. */
  readonly managedKey?: string | null; readonly managedUntil?: number | null };
export type OidcProvider = 'google' | 'apple';
export type AccountIntent = 'sign-in' | 'link';
export type OidcFlow = { readonly provider: OidcProvider; readonly state: string; readonly nonce: string; readonly verifier: string;
  readonly sessionKey: string | null; readonly intent: AccountIntent; readonly returnTo: string };
export type EmailFlow = { readonly otpId: string; readonly email: string; readonly sessionKey: string; readonly intent: AccountIntent; readonly returnTo: string };

type Kind = 'a1' | 'o1' | 'm1';
const seconds = (now: Date) => Math.floor(now.getTime() / 1000);
const METHODS: readonly IdentityKind[] = ['google', 'apple', 'email', 'eip155', 'solana'];
const HEX32 = /^[0-9a-f]{32}$/, B64URL = /^[A-Za-z0-9_-]{43,128}$/;
/** A compressed P-256 public key (hex): the browser's provider session key. */
export const SESSION_PUBLIC_KEY = /^0[23][0-9a-f]{64}$/;
const OTP_ID = /^[A-Za-z0-9-]{8,128}$/;

function accountKey(env: Env): Buffer {
  return Buffer.from(hkdfSync('sha256', walletSessionKey(env), 'flofi', 'flofi/account-session/v1', 32));
}
function seal(kind: Kind, payload: object, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${kind}.${body}.${createHmac('sha256', key).update(`${kind}.${body}`).digest('base64url')}`;
}
function unseal(kind: Kind, token: unknown, key: Buffer, now: Date, domain: string): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length > 4_096) return null;
  const [prefix, body, mac, ...rest] = token.split('.');
  if (prefix !== kind || !body || !mac || rest.length) return null;
  const expected = createHmac('sha256', key).update(`${kind}.${body}`).digest(), supplied = Buffer.from(mac, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return Number.isSafeInteger(v.e) && (v.e as number) > seconds(now) && v.d === domain ? v : null;
}
const keyOrNull = (env: Env) => { try { return accountKey(env); } catch { return null; } };

export function newSessionId(): string { return randomBytes(16).toString('hex'); }
export function newAccountId(): string { return `acct_${randomBytes(16).toString('hex')}`; }

export function sealAccountSession(env: Env, session: AccountSessionToken, domain: string, now: Date): string {
  if (!ACCOUNT_ID.test(session.accountId) || !HEX32.test(session.sessionId) || !METHODS.includes(session.method)) throw new Error('ACCOUNT_SESSION_INVALID');
  const managed = typeof session.managedKey === 'string' && SESSION_PUBLIC_KEY.test(session.managedKey) && Number.isSafeInteger(session.managedUntil)
    ? { k: session.managedKey, x: session.managedUntil } : {};
  return seal('a1', { a: session.accountId, s: session.sessionId, m: session.method, t: session.authenticatedAt, i: seconds(now), e: session.expiresAt, d: domain,
    ...managed }, accountKey(env));
}
/** The sealed claims of an account cookie, or null (absent, tampered, expired, another key or host). The store still decides. */
export function readAccountSession(env: Env, token: string | undefined, now: Date, domain: string): AccountSessionToken | null {
  const key = keyOrNull(env), v = key && unseal('a1', token, key, now, domain);
  if (!v || typeof v.a !== 'string' || !ACCOUNT_ID.test(v.a) || typeof v.s !== 'string' || !HEX32.test(v.s)
    || !METHODS.includes(v.m as IdentityKind) || !Number.isSafeInteger(v.t) || (v.t as number) > seconds(now) + 60) return null;
  const managed = typeof v.k === 'string' && SESSION_PUBLIC_KEY.test(v.k) && Number.isSafeInteger(v.x) && (v.x as number) > seconds(now);
  return { accountId: v.a, sessionId: v.s, method: v.m as IdentityKind, authenticatedAt: v.t as number, expiresAt: v.e as number,
    managedKey: managed ? v.k as string : null, managedUntil: managed ? v.x as number : null };
}
/** Whether a session signed in recently enough for a sensitive action. */
export const freshlyAuthenticated = (session: Pick<AccountSessionToken, 'authenticatedAt'>, now: Date) =>
  seconds(now) - session.authenticatedAt <= ACCOUNT_REAUTH_SECONDS;

/** Only same-origin FloFi paths are accepted as a destination after sign-in (no open redirect). */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || !/^\/(?!\/)[A-Za-z0-9/_?=&.%-]*$/.test(value) || value.includes('\\')) return '/app';
  return /^\/(?:app|onboarding)(?:[/?]|$)/.test(value) ? value : '/app';
}

export function newOidcFlow(provider: OidcProvider, sessionKey: string | null, intent: AccountIntent, returnTo: string): OidcFlow {
  if (sessionKey !== null && !SESSION_PUBLIC_KEY.test(sessionKey)) throw new Error('ACCOUNT_SESSION_KEY_INVALID');
  // With a provider session key the nonce commits the ID token to that browser key (sha256 of the compressed key, hex), so the token
  // can open a provider session for this browser only; otherwise it is a random single-use value.
  const nonce = sessionKey ? createHash('sha256').update(sessionKey).digest('hex') : randomBytes(32).toString('base64url');
  return { provider, state: randomBytes(32).toString('base64url'), nonce, verifier: randomBytes(48).toString('base64url'),
    sessionKey, intent, returnTo: safeReturnPath(returnTo) };
}
export function sealOidcFlow(env: Env, flow: OidcFlow, domain: string, now: Date): string {
  return seal('o1', { p: flow.provider, s: flow.state, n: flow.nonce, v: flow.verifier, k: flow.sessionKey, r: flow.intent, u: flow.returnTo,
    e: seconds(now) + ACCOUNT_FLOW_TTL_SECONDS, d: domain }, accountKey(env));
}
export function readOidcFlow(env: Env, token: string | undefined, now: Date, domain: string): OidcFlow | null {
  const key = keyOrNull(env), v = key && unseal('o1', token, key, now, domain);
  if (!v || (v.p !== 'google' && v.p !== 'apple') || typeof v.s !== 'string' || !B64URL.test(v.s) || typeof v.n !== 'string' || !B64URL.test(v.n)
    || typeof v.v !== 'string' || !B64URL.test(v.v) || (v.k !== null && (typeof v.k !== 'string' || !SESSION_PUBLIC_KEY.test(v.k)))
    || (v.r !== 'sign-in' && v.r !== 'link')) return null;
  return { provider: v.p, state: v.s, nonce: v.n, verifier: v.v, sessionKey: v.k as string | null, intent: v.r, returnTo: safeReturnPath(v.u) };
}
export function sealEmailFlow(env: Env, flow: EmailFlow, domain: string, now: Date): string {
  return seal('m1', { o: flow.otpId, m: flow.email, k: flow.sessionKey, r: flow.intent, u: flow.returnTo, e: seconds(now) + ACCOUNT_FLOW_TTL_SECONDS, d: domain },
    accountKey(env));
}
export function readEmailFlow(env: Env, token: string | undefined, now: Date, domain: string): EmailFlow | null {
  const key = keyOrNull(env), v = key && unseal('m1', token, key, now, domain);
  if (!v || typeof v.o !== 'string' || !OTP_ID.test(v.o) || typeof v.m !== 'string' || v.m.length > 254 || typeof v.k !== 'string'
    || !SESSION_PUBLIC_KEY.test(v.k) || (v.r !== 'sign-in' && v.r !== 'link')) return null;
  return { otpId: v.o, email: v.m, sessionKey: v.k, intent: v.r, returnTo: safeReturnPath(v.u) };
}
