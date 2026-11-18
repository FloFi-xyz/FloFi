// SPDX-License-Identifier: AGPL-3.0-only
'use server';
/**
 * Account server actions (BUILD-FLOFI-AUTH-WALLETS-001; Privy since BUILD-FLOFI-PRIVY-UX-001). Each one derives the account from the
 * verified HttpOnly session (sealed cookie + server-side record), never from an argument. Arguments are a Privy access token (verified
 * server-side and never stored or logged), wallet ids, addresses, labels and choices: never a key, phrase or code. None of these actions
 * signs, submits or authorizes a transaction, and none creates or imports a wallet: that happens in Privy, in the person's browser.
 */
import { accountAvailability, accountHost, clearAccountCookie, clearMoveCookie, currentAccountSession, currentMoveIntent, nextPath, setAccountCookie, setMoveCookie,
  supersede, type AccountAvailability, type AccountHost } from '../accounts/account-host';
import { ExistingAccountFound, type MaskedMethod } from '../accounts/account-service';
import type { IdentityKind } from '../accounts/account-model';
import type { RetirementBlocker } from '../accounts/account-store';
import { platformStateHost } from '../server/platform-state-host';
import { safeReturnPath, type AccountSessionToken } from '../accounts/account-session';
import { parseAccountWalletId, type AccountView, type AccountWallet } from '../accounts/account-model';
import type { PrivyBrowserConfig } from '../accounts/privy-server';
import type { PrivyWalletSync } from '../accounts/account-service';
import { currentSolanaSession, currentWalletSession } from '../server/session-principal';
import { publicOrigin } from '../server/deployment';
import { WALLET_SESSION_TTL_SECONDS } from '../server/wallet-session';
import { ACCOUNT_REAUTH_SECONDS } from '../accounts/account-session';
import { solanaSignOut, walletSignOut } from './wallet-session-action';
import { isOtherAccountOfBoardedPerson, otherAccountDestination } from '../flight/other-account';

type Result<T> = { ok: true; value: T } | { ok: false; code: string };
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const failure = (cause: unknown, fallback = 'ACCOUNT_REQUEST_FAILED'): { ok: false; code: string } =>
  ({ ok: false, code: cause instanceof Error && CODE.test(cause.message) ? cause.message : fallback });
const fail = (code: string): never => { throw new Error(code); };
/**
 * Authentication UX & Login Regression Fix: what happened to a sign-in, a move start or a session, as an enum or a FloFi code only (never an
 * account id, an address, a token or a provider's text), so the step where a real sign-in stops can be told apart in the deployment's logs.
 */
type AccountEvent = { readonly event: 'account.sign_in'; readonly mode: 'sign-in' | 'reauth' | 'move'; readonly result: string; readonly created?: boolean;
  readonly destination?: 'board' | 'onboarding' | 'app' | 'sign-in-methods' | 'other' }
  | { readonly event: 'account.session_ended'; readonly reason: 'sign_out' | 'sign_out_everywhere' | 'move_started' | 'reauth_other_account' | 'move_handoff' | 'superseded' }
  | { readonly event: 'account.move_start'; readonly result: string };
const logAccount = (entry: AccountEvent) => console.info(JSON.stringify(entry));
const destinationKind = (path: string) => path.startsWith('/board') ? 'board' as const : path.startsWith('/onboarding') ? 'onboarding' as const
  : path.startsWith('/app') ? 'app' as const : path.startsWith('/account/sign-in-methods') ? 'sign-in-methods' as const : 'other' as const;
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
 * BUILD-FLOFI-UX-FIX-003: what the header's Settings menu needs — whether this deployment offers accounts and whether this browser holds a valid
 * FloFi session — from one verified-session read. No account data (identities, emails, wallets) leaves the server for it; pages that show the
 * account keep using `accountState`.
 */
export type AccountPresence = { readonly accounts: boolean; readonly signedIn: boolean };
export async function accountPresence(): Promise<AccountPresence> {
  let h: AccountHost | null;
  try { h = await accountHost(); } catch { h = null; }
  if (!h) return { accounts: false, signedIn: false };
  return { accounts: true, signedIn: await currentAccountSession(h) !== null };
}

/**
 * Completes a Privy sign-in (Google, email code or Web3 wallet): the server verifies the access token and reads the Privy user itself,
 * signs in to that person's one FloFi account and sets the session cookie. Returns where to continue.
 *
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (P0):
 * - A sign-in that would CREATE an account for an address another account already verified answers `ACCOUNT_EXISTS_FOR_EMAIL` with that
 *   account's method kinds (nothing created, nothing merged); `allowNew` (the person chose a separate account) skips the question.
 * - `mode: 'reauth'` (a step-up): only the account already signed in in this browser may be confirmed; any other account is refused and the
 *   current session is kept. `mode: 'move'` (proving the account that keeps everything after starting to retire a duplicate): continues to
 *   Sign-in methods, where the move is confirmed. A step-up or a move never detours through wallet onboarding.
 */
export async function privySignIn(accessToken: string, returnTo = '/app', options: { readonly allowNew?: boolean; readonly mode?: 'reauth' | 'move' } = {}):
  Promise<Result<{ next: string; method: AccountSessionToken['method'] }> | { ok: false; code: 'ACCOUNT_EXISTS_FOR_EMAIL'; kinds: readonly IdentityKind[] }> {
  try {
    const h = await host(), previous = await currentAccountSession(h);
    // A move sign-in needs this browser's own move intent (checked before anything is consumed).
    const move = options.mode === 'move' ? await currentMoveIntent().catch(() => null) : null;
    if (options.mode === 'move' && !move) return { ok: false, code: 'ACCOUNT_MOVE_EXPIRED' };
    // A step-up or a move signs in to an existing account only: it never creates one the person did not ask for.
    const outcome = await h.service.completePrivy(accessToken, { allowNew: options.allowNew === true, existingOnly: options.mode !== undefined }).catch((cause: unknown) => {
      if (cause instanceof Error && cause.message === 'ACCOUNT_SIGN_IN_NO_ACCOUNT') throw new Error(options.mode === 'reauth' ? 'ACCOUNT_REAUTH_OTHER_ACCOUNT' : 'ACCOUNT_MOVE_TARGET_UNKNOWN');
      throw cause;
    });
    if (options.mode === 'reauth' && (!previous || previous.accountId !== outcome.session.accountId)) {
      await h.store.revokeSession(outcome.session).catch(() => undefined);
      logAccount({ event: 'account.session_ended', reason: 'reauth_other_account' });
      logAccount({ event: 'account.sign_in', mode: 'reauth', result: 'ACCOUNT_REAUTH_OTHER_ACCOUNT' });
      return { ok: false, code: 'ACCOUNT_REAUTH_OTHER_ACCOUNT' };
    }
    await supersede(h, previous, outcome.session);
    if (previous && previous.sessionId !== outcome.session.sessionId) logAccount({ event: 'account.session_ended', reason: 'superseded' });
    await setAccountCookie(outcome.session);
    // A move intent belongs to the move sign-in (and the keeper's step-up while confirming it): any other sign-in in this browser ends it.
    if (!move && options.mode !== 'reauth') await clearMoveCookie();
    let next = move ? '/account/sign-in-methods' : options.mode === 'reauth' ? safeReturnPath(returnTo) : nextPath(outcome, 'sign-in', safeReturnPath(returnTo));
    // Authentication UX & Login Regression Fix (P0): the person's OTHER account (no beta access, its verified address held by the boarded
    // account) goes straight to /board's recovery, never through wallet onboarding (a wallet there would make it impossible to close).
    if (!options.mode && otherAccountDestination(next) !== next) {
      const view = await h.service.view(outcome.session).catch(() => null);
      if (view && await isOtherAccountOfBoardedPerson(view.accountId, view.identities)) next = otherAccountDestination(next);
    }
    logAccount({ event: 'account.sign_in', mode: options.mode ?? 'sign-in', result: 'ok', created: outcome.created, destination: destinationKind(next) });
    // `method` is the server-verified sign-in method (public): the browser uses it only to restore the wallet it just authenticated with.
    return { ok: true, value: { next, method: outcome.session.method } };
  } catch (cause) {
    if (cause instanceof ExistingAccountFound) {
      logAccount({ event: 'account.sign_in', mode: options.mode ?? 'sign-in', result: 'ACCOUNT_EXISTS_FOR_EMAIL' });
      return { ok: false, code: 'ACCOUNT_EXISTS_FOR_EMAIL', kinds: cause.kinds };
    }
    const result = failure(cause, 'PRIVY_SIGN_IN_FAILED');
    logAccount({ event: 'account.sign_in', mode: options.mode ?? 'sign-in', result: result.code });
    // HOTFIX-FLOFI-PRODUCTION-RECOVERY-001: a failure without a FloFi code reached the person as the generic message with nothing in the logs.
    // Record its class only (never the token, the provider's text or an identity), so the failing step can be told apart.
    if (result.code === 'PRIVY_SIGN_IN_FAILED') console.warn(JSON.stringify({ event: 'account.privy_sign_in_failed',
      error: cause instanceof Error ? cause.name.slice(0, 40) : typeof cause }));
    return result;
  }
}

/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (P0): what the Sign-in methods page shows — the signed-in account's methods (masked), whether it signed
 * in recently (linking needs it), whether it may be retired as an empty duplicate (and what blocks it), and the move this browser started.
 */
export type SignInMethodsState = { readonly signedIn: boolean; readonly methods: readonly MaskedMethod[]; readonly fresh: boolean; readonly privy: boolean;
  readonly retirement: readonly RetirementBlocker[]; readonly move: { readonly methods: readonly MaskedMethod[]; readonly mine: boolean } | null;
  readonly emailLink: boolean };
export async function signInMethodsState(): Promise<SignInMethodsState> {
  const move = await currentMoveIntent().catch(() => null);
  let h: AccountHost | null;
  try { h = await accountHost(); } catch { h = null; }
  const session = await currentAccountSession(h);
  const moving = move ? { methods: move.methods as readonly MaskedMethod[], mine: session?.accountId === move.retiring } : null;
  // Privy's bot protection runs a captcha FloFi's link page cannot show: linking an email is then not offered (stated on the page).
  const emailLink = !process.env.FLOFI_PRIVY_BOT_PROTECTION;
  if (!h || !session) return { signedIn: false, methods: [], fresh: false, privy: false, retirement: [], move: moving, emailLink };
  const view = await h.service.signInMethods(session);
  return { signedIn: true, ...view, move: moving, emailLink };
}
/** Step-up before linking a sign-in method in Privy (see `AccountService.linkReadiness`). */
export async function linkReadiness(accessToken: string): Promise<Result<null>> {
  try {
    const { host: h, session } = await signedIn();
    await h.service.linkReadiness(session, accessToken);
    return { ok: true, value: null };
  } catch (cause) { return failure(cause, 'ACCOUNT_LINK_FAILED'); }
}
/** After a link FloFi confirmed: adopts the methods linked to this account's own Privy user (see `AccountService.syncLinkedIdentities`). */
export async function syncSignInMethods(accessToken: string): Promise<Result<{ readonly added: number; readonly heldElsewhere: number; readonly unconfirmed: number;
  readonly methods: readonly MaskedMethod[] }>> {
  try {
    const { host: h, session } = await signedIn();
    return { ok: true, value: await h.service.syncLinkedIdentities(session, accessToken) };
  } catch (cause) { return failure(cause, 'ACCOUNT_LINK_FAILED'); }
}
/**
 * Starts retiring this EMPTY duplicate account: after the checks (`AccountService.startAccountMove`), seals the move intent into this browser,
 * ends this session and sends the person to sign in to the account that keeps everything.
 */
export async function startAccountMove(): Promise<Result<{ readonly next: string }>> {
  try {
    const { host: h, session } = await signedIn();
    const intent = await h.service.startAccountMove(session);
    await setMoveCookie(intent);
    await h.store.revokeSession(session).catch(() => undefined);
    logAccount({ event: 'account.move_start', result: 'ok' });
    logAccount({ event: 'account.session_ended', reason: 'move_started' });
    await clearAccountCookie();
    await walletSignOut().catch(() => undefined);
    await solanaSignOut().catch(() => undefined);
    return { ok: true, value: { next: '/login?move=1' } };
  } catch (cause) {
    const result = failure(cause, 'ACCOUNT_MOVE_FAILED');
    logAccount({ event: 'account.move_start', result: result.code });
    return result;
  }
}
/**
 * The sign-in just completed at Privy would create a new account for an email another account already verified, and the person chose to bring
 * this sign-in to that account: the new (empty) account is created and its move started at once (the same checks and proofs as
 * `startAccountMove`; this login is the recent sign-in), so its method can be linked to the other account after signing in to it. Nothing else
 * is created, merged or moved.
 */
export async function privyMoveToExisting(accessToken: string): Promise<Result<{ readonly next: string }>> {
  try {
    const h = await host();
    const outcome = await h.service.completePrivy(accessToken, { allowNew: true });
    try {
      const intent = await h.service.startAccountMove(outcome.session);
      await setMoveCookie(intent);
      logAccount({ event: 'account.move_start', result: 'ok' });
    } catch (cause) {
      logAccount({ event: 'account.move_start', result: failure(cause, 'ACCOUNT_MOVE_FAILED').code });
      // The person asked to bring this sign-in to another account, not for a new one: an account created just now that cannot move is discarded.
      if (outcome.created) await h.store.discardEmptyAccount(outcome.session.accountId).catch(() => false);
      throw cause;
    } finally {
      await h.store.revokeSession(outcome.session).catch(() => undefined);
      logAccount({ event: 'account.session_ended', reason: 'move_handoff' });
    }
    return { ok: true, value: { next: '/login?move=1' } };
  } catch (cause) { return failure(cause, 'ACCOUNT_MOVE_FAILED'); }
}
/** Signed in to the account that keeps everything: retires the duplicate this browser started to move (see `AccountService.completeAccountMove`). */
export async function completeAccountMove(): Promise<Result<{ readonly kinds: readonly IdentityKind[] }>> {
  try {
    const { host: h, session } = await signedIn();
    const intent = await currentMoveIntent() ?? fail('ACCOUNT_MOVE_EXPIRED');
    const { tenantId } = await platformStateHost(process.env);
    const result = await h.service.completeAccountMove(session, { ...intent!, methods: intent!.methods as readonly MaskedMethod[] }, tenantId);
    await clearMoveCookie();
    return { ok: true, value: result };
  } catch (cause) { return failure(cause, 'ACCOUNT_MOVE_FAILED'); }
}
/** Stops a move this browser started (nothing was changed yet, or the person changed their mind). */
export async function cancelAccountMove(): Promise<Result<null>> {
  await clearMoveCookie();
  return { ok: true, value: null };
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
    if (h && session) {
      await (everywhere ? h.store.revokeAllSessions(session.accountId) : h.store.revokeSession(session));
      logAccount({ event: 'account.session_ended', reason: everywhere ? 'sign_out_everywhere' : 'sign_out' });
    }
  } catch { /* the cookies are cleared regardless */ }
  await clearAccountCookie();
  await clearMoveCookie().catch(() => undefined);
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
