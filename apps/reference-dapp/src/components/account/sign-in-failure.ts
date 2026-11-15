// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HOTFIX-FLOFI-PRODUCTION-RECOVERY-001 (FIX 3): why the call that hands a completed Privy sign-in to FloFi's server failed, as a code.
 *
 * Root cause observed in production: a `/login` page loaded before a new deployment keeps calling the previous deployment's Server Action
 * id. The new deployment answers `409` with `x-nextjs-action-not-found` (verified against https://flofi.xyz on 2026-11-14), Next.js throws
 * an `UnrecognizedActionError`, and the page turned it into the generic "Sign-in did not complete. Try again." — and every retry in that tab
 * failed the same way, because the page still held the old id. Email and Web3 Wallet complete inside the page, so the time spent reading an
 * email code was enough to cross a deployment; Google returns through a fresh page load and was not affected.
 *
 * Nothing about the sign-in itself is decided here: the server never received the token, so nothing was signed in, no proof was consumed
 * and no account or wallet changed. The page only learns that it must load the current deployment before the person signs in again.
 */
import { unstable_isUnrecognizedActionError } from 'next/navigation';

export const SIGN_IN_PAGE_OUTDATED = 'SIGN_IN_PAGE_OUTDATED';

/** The code for a failed `privySignIn` call (the call itself, not a refusal the server returned). */
export function signInCallFailure(cause: unknown, unrecognized: (error: unknown) => boolean = unstable_isUnrecognizedActionError): string {
  return unrecognized(cause) ? SIGN_IN_PAGE_OUTDATED : 'PRIVY_SIGN_IN_FAILED';
}

/** The sign-in page of the current deployment, saying why it was reloaded, keeping where the person was going. */
export function currentSignInPage(returnTo: string): string {
  return `/login?${new URLSearchParams({ error: SIGN_IN_PAGE_OUTDATED, returnTo })}`;
}
