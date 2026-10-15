// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the administrator's proof of control and the sealed admin session reference. Pure functions; cookies and the
 * database are handled by `http.ts` and `store.ts`.
 *
 * Sign-in reuses the wallet-session primitives (EIP-4361 text, `personal_sign`, `recoverPersonalSigner`) but is a distinct boundary:
 * its own statement (a product sign-in signature can never be replayed here, nor the reverse), its own sealed kinds and HKDF key
 * (`config.ts`), its own cookies scoped to `/admin`, and a short absolute lifetime. A valid signature only proves control of an
 * address; the grant check against `admin_principals` happens server-side afterwards, and every request re-checks the server-side
 * session row, so sign-out and revocation are immediate. Nothing here authorizes a transaction or touches a wallet's funds.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { checksumAddress, recoverPersonalSigner } from '../server/wallet-session.ts';

export const ADMIN_SESSION_COOKIE = 'flofi_admin_session';
export const ADMIN_CHALLENGE_COOKIE = 'flofi_admin_challenge';
export const ADMIN_COOKIE_PATH = '/admin';
export const ADMIN_SESSION_TTL_SECONDS = 4 * 3600;
export const ADMIN_CHALLENGE_TTL_SECONDS = 300;
export const ADMIN_SIGN_IN_STATEMENT = 'Sign in to the FloFi Admin console. This signature authorizes no transaction, moves no funds and grants no access by itself.';
export const ADMIN_CSRF_HEADER = 'x-flofi-admin-csrf';

type Challenge = { readonly n: string; readonly i: number; readonly e: number; readonly d: string; readonly u: string };
type Sealed = { readonly s: string; readonly p: string; readonly i: number; readonly e: number; readonly d: string };
export type AdminSessionReference = { readonly sessionId: string; readonly principalId: string; readonly issuedAt: Date; readonly expiresAt: Date };

const ACCOUNT = /^0x[0-9a-f]{40}$/, DOMAIN = /^[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?$/, SESSION_ID = /^[a-f0-9]{32}$/, PRINCIPAL = /^adm_[a-z2-7]{26}$/;
const fail = (code: string): never => { throw new Error(code); };
const seconds = (now: Date) => Math.floor(now.getTime() / 1000);

function seal(kind: 'ac1' | 'as1', payload: Challenge | Sealed, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${kind}.${body}.${createHmac('sha256', key).update(`${kind}.${body}`).digest('base64url')}`;
}
function unseal<T extends { e: number }>(kind: 'ac1' | 'as1', token: string | undefined, key: Buffer, now: Date): T | null {
  if (typeof token !== 'string' || token.length > 2_048) return null;
  const [prefix, body, mac, ...rest] = token.split('.');
  if (prefix !== kind || !body || !mac || rest.length) return null;
  const expected = createHmac('sha256', key).update(`${kind}.${body}`).digest(), supplied = Buffer.from(mac, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  let value: T;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T; } catch { return null; }
  return value && typeof value === 'object' && Number.isSafeInteger(value.e) && value.e > seconds(now) ? value : null;
}

/** The exact message the administrator's wallet signs. Every field comes from the sealed challenge or is re-checked. */
export function adminSignInMessage(input: { readonly domain: string; readonly uri: string; readonly address: string; readonly chainId: number;
  readonly nonce: string; readonly issuedAt: string; readonly expirationTime: string }): string {
  return `${input.domain} wants you to sign in with your Ethereum account:\n${checksumAddress(input.address)}\n\n${ADMIN_SIGN_IN_STATEMENT}\n\n` +
    `URI: ${input.uri}/admin\nVersion: 1\nChain ID: ${input.chainId}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expirationTime}`;
}
/** A fresh nonce bound to this origin, sealed into the short-lived HttpOnly challenge cookie. */
export function issueAdminChallenge(key: Buffer, input: { readonly domain: string; readonly uri: string; readonly now: Date }): { readonly token: string } {
  if (!DOMAIN.test(input.domain) || !/^https?:\/\/[^\s/?#]+$/.test(input.uri)) fail('ADMIN_SIGN_IN_ORIGIN_INVALID');
  const issued = seconds(input.now);
  return { token: seal('ac1', { n: randomBytes(16).toString('hex'), i: issued, e: issued + ADMIN_CHALLENGE_TTL_SECONDS, d: input.domain, u: input.uri }, key) };
}
export function adminChallengeMessage(key: Buffer, input: { readonly challengeToken: string | undefined; readonly domain: string; readonly uri: string;
  readonly address: string; readonly chainId: number; readonly now: Date }): string {
  const challenge = unseal<Challenge>('ac1', input.challengeToken, key, input.now) ?? fail('ADMIN_SIGN_IN_CHALLENGE_INVALID');
  if (challenge.d !== input.domain || challenge.u !== input.uri) fail('ADMIN_SIGN_IN_ORIGIN_MISMATCH');
  if (!ACCOUNT.test(input.address)) fail('WALLET_ADDRESS_INVALID');
  if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) fail('WALLET_CHAIN_INVALID');
  return adminSignInMessage({ domain: challenge.d, uri: challenge.u, address: input.address, chainId: input.chainId, nonce: challenge.n,
    issuedAt: new Date(challenge.i * 1000).toISOString(), expirationTime: new Date(challenge.e * 1000).toISOString() });
}
/**
 * The lower-case address that signed the challenge message and the session id this challenge can open, or a closed code. It proves
 * control only; it grants nothing. The session id is derived from the challenge nonce, so a replayed challenge and signature can never
 * open a second session (the server-side session row already exists under that id).
 */
export function verifyAdminSignature(key: Buffer, input: { readonly challengeToken: string | undefined; readonly domain: string; readonly uri: string;
  readonly address: string; readonly chainId: number; readonly signature: string; readonly now: Date }): { readonly account: string; readonly sessionId: string } {
  const message = adminChallengeMessage(key, input);
  let signer: string;
  try { signer = recoverPersonalSigner(message, input.signature); } catch { return fail('WALLET_SIGNATURE_INVALID'); }
  if (signer !== input.address) fail('WALLET_SIGNATURE_INVALID');
  const nonce = unseal<Challenge>('ac1', input.challengeToken, key, input.now)!.n;
  return { account: signer, sessionId: createHmac('sha256', key).update(`session.${nonce}`).digest('hex').slice(0, 32) };
}

/** The browser's sealed reference to a server-side session row, bound to the host that issued it. */
export function sealAdminSession(key: Buffer, input: { readonly sessionId: string; readonly principalId: string; readonly domain: string;
  readonly issuedAt: Date; readonly expiresAt: Date }): string {
  if (!SESSION_ID.test(input.sessionId) || !PRINCIPAL.test(input.principalId) || !DOMAIN.test(input.domain)) fail('ADMIN_SESSION_INVALID');
  return seal('as1', { s: input.sessionId, p: input.principalId, i: seconds(input.issuedAt), e: seconds(input.expiresAt), d: input.domain }, key);
}
/** The sealed reference in a cookie value, or null (absent, tampered, expired, another key or another host). */
export function readAdminSession(key: Buffer, token: string | undefined, now: Date, domain: string): AdminSessionReference | null {
  const value = unseal<Sealed>('as1', token, key, now);
  if (!value || typeof value.s !== 'string' || !SESSION_ID.test(value.s) || typeof value.p !== 'string' || !PRINCIPAL.test(value.p) ||
    value.d !== domain || !Number.isSafeInteger(value.i)) return null;
  return { sessionId: value.s, principalId: value.p, issuedAt: new Date(value.i * 1000), expiresAt: new Date(value.e * 1000) };
}

/** The per-session anti-CSRF token the console sends in `x-flofi-admin-csrf` with every mutation. */
export function adminCsrfToken(key: Buffer, sessionId: string): string {
  return createHmac('sha256', key).update(`csrf.${sessionId}`).digest('base64url');
}
export function adminCsrfValid(key: Buffer, sessionId: string, supplied: string | null): boolean {
  if (typeof supplied !== 'string' || supplied.length > 128) return false;
  const expected = Buffer.from(adminCsrfToken(key, sessionId)), given = Buffer.from(supplied);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
