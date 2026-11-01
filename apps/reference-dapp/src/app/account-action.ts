// SPDX-License-Identifier: AGPL-3.0-only
'use server';
/**
 * Account server actions (BUILD-FLOFI-AUTH-WALLETS-001; Privy since BUILD-FLOFI-PRIVY-UX-001). Each one derives the account from the
 * verified HttpOnly session (sealed cookie + server-side record), never from an argument. Arguments are a Privy access token (verified
 * server-side and never stored or logged), wallet ids, addresses, labels and choices: never a key, phrase or code. None of these actions
 * signs, submits or authorizes a transaction, and none creates or imports a wallet: that happens in Privy, in the person's browser.
 */
import { accountAvailability, accountHost, clearAccountCookie, currentAccountSession, nextPath, setAccountCookie, supersede, type AccountAvailability,
  type AccountHost } from '../accounts/account-host';
import { safeReturnPath, type AccountSessionToken } from '../accounts/account-session';
import { parseAccountWalletId, type AccountView, type AccountWallet } from '../accounts/account-model';
import type { PrivyBrowserConfig } from '../accounts/privy-server';
import type { PrivyWalletSync } from '../accounts/account-service';
import { currentSolanaSession, currentWalletSession } from '../server/session-principal';
import { publicOrigin } from '../server/deployment';
import { WALLET_SESSION_TTL_SECONDS } from '../server/wallet-session';
import { ACCOUNT_REAUTH_SECONDS } from '../accounts/account-session';
import { solanaSignOut, walletSignOut } from './wallet-session-action';

type Result<T> = { ok: true; value: T } | { ok: false; code: string };
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const failure = (cause: unknown, fallback = 'ACCOUNT_REQUEST_FAILED'): { ok: false; code: string } =>
  ({ ok: false, code: cause instanceof Error && CODE.test(cause.message) ? cause.message : fallback });
const fail = (code: string): never => { throw new Error(code); };
async function host(): Promise<AccountHost> {
  try { return await accountHost() ?? fail('ACCOUNTS_NOT_CONFIGURED'); } catch (error) { throw new Error(failure(error, 'ACCOUNTS_UNAVAILABLE').code, { cause: error }); }
}
/** The wallet proven in this browser within the last few minutes (a new EIP-4361 / SIWS signature), or null. */
async function freshWalletProof(namespace: 'eip155' | 'solana'): Promise<{ namespace: 'eip155' | 'solana'; address: string } | null> {
  const proof = namespace === 'eip155' ? await currentWalletSession() : namespace === 'solana' ? await currentSolanaSession() : fail('WALLET_NAMESPACE_INVALID');
  if (!proof) return null;
  const issued = Date.parse(proof.expiresAt) / 1000 - WALLET_SESSION_TTL_SECONDS;
  return Date.now() / 1000 - issued <= ACCOUNT_REAUTH_SECONDS ? { namespace, address: proof.account } : fail('WALLET_PROOF_STALE');
}
async function signedIn(): Promise<{ host: AccountHost; session: AccountSessionToken }> {
  const h = await host(), session = await currentAccountSession(h);
  return session ? { host: h, session } : fail('ACCOUNT_SESSION_REQUIRED');
}
/** Where Disconnect lands: the deployment's own sign-in page (`https://flofi.xyz/login` in production). */
export async function loginUrl(): Promise<string> {
  const origin = publicOrigin(process.env);
  return origin ? `${origin}/login` : '/login';
}
/**
 * What the product pages may know: availability, the signed-in account (public data) and Privy's public app settings. Never a token or
 * secret.
 */
export type AccountState = { readonly availability: AccountAvailability; readonly account: AccountView | null; readonly privy: PrivyBrowserConfig | null };
export async function accountState(): Promise<AccountState> {
  let h: AccountHost | null;
  try { h = await accountHost(); } catch { h = null; }
  const availability = accountAvailability(process.env, h), session = await currentAccountSession(h);
  if (!h || !session) return { availability, account: null, privy: h?.privy ?? null };
  return { availability, account: await h.service.view(session).catch(() => null), privy: h.privy };
}

/**
 * Completes a Privy sign-in (Google, email code or Web3 wallet): the server verifies the access token and reads the Privy user itself,
 * signs in to that person's one FloFi account and sets the session cookie. Returns where to continue.
 */
export async function privySignIn(accessToken: string, returnTo = '/app'): Promise<Result<{ next: string; method: AccountSessionToken['method'] }>> {
  try {
    const h = await host(), previous = await currentAccountSession(h);
    const outcome = await h.service.completePrivy(accessToken);
    await supersede(h, previous, outcome.session);
    await setAccountCookie(outcome.session);
    // `method` is the server-verified sign-in method (public): the browser uses it only to restore the wallet it just authenticated with.
    return { ok: true, value: { next: nextPath(outcome, 'sign-in', safeReturnPath(returnTo)), method: outcome.session.method } };
  } catch (cause) { return failure(cause, 'PRIVY_SIGN_IN_FAILED'); }
}
/** Saves one wallet just created or imported in Privy, after Privy's API confirms this account's own Privy user holds it. */
export async function savePrivyWallet(accessToken: string, ecosystem: 'evm' | 'solana', address: string, label?: string): Promise<Result<AccountWallet>> {
  try {
    const { host: h, session } = await signedIn();
    return { ok: true, value: await h.service.savePrivyWallet(session, accessToken, { ecosystem, address, label }) };
  } catch (cause) { return failure(cause, 'ACCOUNT_WALLET_SAVE_FAILED'); }
}
/** Saves every Privy wallet of this account's Privy user that the account does not list yet (after a refresh, a timeout or a closed tab). */
export async function syncPrivyWallets(accessToken: string): Promise<Result<PrivyWalletSync>> {
  try {
    const { host: h, session } = await signedIn();
    return { ok: true, value: await h.service.syncPrivyWallets(session, accessToken) };
  } catch (cause) { return failure(cause, 'ACCOUNT_WALLET_SAVE_FAILED'); }
}

/**
 * Disconnect: revokes this browser's FloFi session server-side (or every session of the account), clears the session cookie and this
 * browser's wallet proofs (EIP-4361 / Sign-In With Solana sessions). Returns the sign-in page to go to. Nothing about the account, its
 * wallets, keys, assets or history is deleted; the browser also logs out of Privy and forgets its wallet connections.
 */
export async function accountSignOut(everywhere = false): Promise<{ readonly next: string }> {
  try {
    const h = await accountHost(), session = await currentAccountSession(h);
    if (h && session) await (everywhere ? h.store.revokeAllSessions(session.accountId) : h.store.revokeSession(session));
  } catch { /* the cookies are cleared regardless */ }
  await clearAccountCookie();
  await walletSignOut().catch(() => undefined);
  await solanaSignOut().catch(() => undefined);
  return { next: await loginUrl() };
}
export async function setAccountOnboarding(value: 'completed' | 'dismissed'): Promise<Result<null>> {
  try {
    const { host: h, session } = await signedIn();
    if (value !== 'completed' && value !== 'dismissed') fail('ONBOARDING_INVALID');
    await h.store.setOnboarding(session.accountId, value);
    return { ok: true, value: null };
  } catch (cause) { return failure(cause); }
}
/** Links the external wallet proven in this browser (fresh EIP-4361 / SIWS session) to the signed-in account. */
export async function linkAccountWallet(namespace: 'eip155' | 'solana', providerKey: string, providerName: string): Promise<Result<AccountWallet>> {
  try {
    const { host: h, session } = await signedIn();
    return { ok: true, value: await h.service.linkExternalWallet(session, await freshWalletProof(namespace), { key: providerKey, name: providerName }) };
  } catch (cause) { return failure(cause, 'ACCOUNT_WALLET_LINK_FAILED'); }
}
export async function renameAccountWallet(id: string, label: string): Promise<Result<null>> {
  try {
    const { host: h, session } = await signedIn(), wallet = parseAccountWalletId(id) ?? fail('ACCOUNT_WALLET_INVALID');
    await h.store.renameWallet(session.accountId, wallet!.ecosystem, wallet!.address, label);
    return { ok: true, value: null };
  } catch (cause) { return failure(cause); }
}
/** Removes FloFi's association only. The wallet, its keys at the provider and its assets are unchanged. */
export async function removeAccountWallet(id: string): Promise<Result<null>> {
  try {
    const { host: h, session } = await signedIn(), wallet = parseAccountWalletId(id) ?? fail('ACCOUNT_WALLET_INVALID');
    await h.store.removeWallet(session.accountId, wallet!.ecosystem, wallet!.address);
    return { ok: true, value: null };
  } catch (cause) { return failure(cause); }
}
/**
 * Deletes the signed-in FloFi account (recent sign-in required): identities, sessions and saved wallet metadata. Wallets kept by the
 * provider and on-chain assets are not deleted or moved; export a managed wallet first to keep using it elsewhere.
 */
export async function deleteFloFiAccount(): Promise<Result<null>> {
  try {
    const { host: h, session } = await signedIn();
    await h.service.deleteAccount(session);
    await clearAccountCookie();
    return { ok: true, value: null };
  } catch (cause) { return failure(cause); }
}
