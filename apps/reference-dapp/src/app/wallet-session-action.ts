// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { cookies, headers } from 'next/headers';
import { challengeMessage, issueWalletChallenge, SOLANA_CHALLENGE_COOKIE, SOLANA_SESSION_COOKIE, solanaChallengeMessage, verifySolanaSignIn, verifyWalletSignIn,
  WALLET_CHALLENGE_COOKIE, WALLET_CHALLENGE_TTL_SECONDS, WALLET_SESSION_COOKIE, WALLET_SESSION_TTL_SECONDS, type SolanaWalletSession,
  type WalletSession } from '../server/wallet-session';
import { currentSolanaSession, currentWalletSession, requestOrigin } from '../server/session-principal';
import { EMBEDDED_APPROVAL_PATH, embeddedWalletCookie, walletCookieOptions } from '../server/embedded-approval';
import { sessionCookieName } from '../server/session-cookie';

/**
 * BUILD-JOURNEY-001: sign-in with the connected wallet (EIP-4361 over `personal_sign`). The challenge and the session live in
 * HttpOnly, SameSite=Strict cookies; the browser only relays the message to its own wallet and returns the signature.
 * The session binds runs to the wallet that created them. It authorizes no transaction: Flofi still never signs or sends.
 */
type Result<T> = { ok: true; value: T } | { ok: false; code: string };
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const failure = (cause: unknown): { ok: false; code: string } =>
  ({ ok: false, code: cause instanceof Error && CODE.test(cause.message) ? cause.message : 'WALLET_SIGN_IN_FAILED' });
const cookieName = (name: string, embedded: boolean, secure: boolean) => embedded ? embeddedWalletCookie(name) : sessionCookieName(name, secure);
async function proofOrigin(embedded: boolean) {
  if (typeof embedded !== 'boolean' || (embedded && (await headers()).get('x-flofi-pathname') !== EMBEDDED_APPROVAL_PATH))
    throw new Error('WALLET_SESSION_CONTEXT_INVALID');
  return requestOrigin();
}

export async function walletSignInChallenge(address: string, chainId: number, embedded = false): Promise<Result<{ message: string }>> {
  try {
    const account = typeof address === 'string' ? address.toLowerCase() : '', origin = await proofOrigin(embedded), now = new Date();
    const challenge = issueWalletChallenge(process.env, { domain: origin.domain, uri: origin.uri, now });
    const message = challengeMessage(process.env, { challengeToken: challenge.token, domain: origin.domain, uri: origin.uri, address: account, chainId, now });
    (await cookies()).set(cookieName(WALLET_CHALLENGE_COOKIE, embedded, origin.secure), challenge.token, walletCookieOptions(origin.secure || embedded, WALLET_CHALLENGE_TTL_SECONDS, embedded));
    return { ok: true, value: { message } };
  } catch (cause) { return failure(cause); }
}
export async function walletSignIn(address: string, chainId: number, signature: string, embedded = false): Promise<Result<WalletSession>> {
  try {
    const jar = await cookies(), origin = await proofOrigin(embedded), challengeToken = jar.get(cookieName(WALLET_CHALLENGE_COOKIE, embedded, origin.secure))?.value;
    // The challenge is single-use from the browser's side: it is removed whatever the outcome.
    jar.set(cookieName(WALLET_CHALLENGE_COOKIE, embedded, origin.secure), '', walletCookieOptions(origin.secure || embedded, 0, embedded));
    const { token, session } = verifyWalletSignIn(process.env, { challengeToken, domain: origin.domain, uri: origin.uri,
      address: typeof address === 'string' ? address.toLowerCase() : '', chainId, signature, now: new Date() });
    jar.set(cookieName(WALLET_SESSION_COOKIE, embedded, origin.secure), token, walletCookieOptions(origin.secure || embedded, WALLET_SESSION_TTL_SECONDS, embedded));
    return { ok: true, value: session };
  } catch (cause) { return failure(cause); }
}
export async function walletSessionStatus(): Promise<WalletSession | null> {
  try { return await currentWalletSession(); } catch { return null; }
}
export async function walletSignOut(): Promise<void> {
  await clearProofCookies([WALLET_SESSION_COOKIE, WALLET_CHALLENGE_COOKIE]);
}
/** Clear current host-prefixed proofs and the retired names; retired cookies are never an authentication fallback. */
async function clearProofCookies(names: readonly string[]): Promise<void> {
  const jar = await cookies(), origin = await requestOrigin();
  for (const name of names) {
    const current = sessionCookieName(name, origin.secure);
    jar.set(current, '', walletCookieOptions(origin.secure, 0));
    if (current !== name) jar.set(name, '', walletCookieOptions(origin.secure, 0));
    jar.set(embeddedWalletCookie(name), '', walletCookieOptions(true, 0, true));
    jar.set(`embedded_${name}`, '', { ...walletCookieOptions(true, 0, true), path: EMBEDDED_APPROVAL_PATH });
  }
}

/**
 * BUILD-MCP-002: Sign-In With Solana (Wallet Standard `solana:signMessage`). Same rules as the Ethereum sign-in: a single-use
 * HttpOnly challenge, the server rebuilds the message, verifies the Ed25519 signature and seals a session for exactly that key.
 */
export async function solanaSignInChallenge(address: string, embedded = false): Promise<Result<{ message: string }>> {
  try {
    const origin = await proofOrigin(embedded), now = new Date(), account = typeof address === 'string' ? address : '';
    const challenge = issueWalletChallenge(process.env, { domain: origin.domain, uri: origin.uri, now });
    const message = solanaChallengeMessage(process.env, { challengeToken: challenge.token, domain: origin.domain, uri: origin.uri, address: account, now });
    (await cookies()).set(cookieName(SOLANA_CHALLENGE_COOKIE, embedded, origin.secure), challenge.token, walletCookieOptions(origin.secure || embedded, WALLET_CHALLENGE_TTL_SECONDS, embedded));
    return { ok: true, value: { message } };
  } catch (cause) { return failure(cause); }
}
export async function solanaSignIn(address: string, signature: string, embedded = false): Promise<Result<SolanaWalletSession>> {
  try {
    const jar = await cookies(), origin = await proofOrigin(embedded), challengeToken = jar.get(cookieName(SOLANA_CHALLENGE_COOKIE, embedded, origin.secure))?.value;
    jar.set(cookieName(SOLANA_CHALLENGE_COOKIE, embedded, origin.secure), '', walletCookieOptions(origin.secure || embedded, 0, embedded));
    const { token, session } = verifySolanaSignIn(process.env, { challengeToken, domain: origin.domain, uri: origin.uri,
      address: typeof address === 'string' ? address : '', signature: typeof signature === 'string' ? signature : '', now: new Date() });
    jar.set(cookieName(SOLANA_SESSION_COOKIE, embedded, origin.secure), token, walletCookieOptions(origin.secure || embedded, WALLET_SESSION_TTL_SECONDS, embedded));
    return { ok: true, value: session };
  } catch (cause) { return failure(cause); }
}
export async function solanaSessionStatus(): Promise<SolanaWalletSession | null> {
  try { return await currentSolanaSession(); } catch { return null; }
}
export async function solanaSignOut(): Promise<void> {
  await clearProofCookies([SOLANA_SESSION_COOKIE, SOLANA_CHALLENGE_COOKIE]);
}
