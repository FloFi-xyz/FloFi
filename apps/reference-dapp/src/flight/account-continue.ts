// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Authentication UX & Login Regression Fix (item 6): "Continue to my account" on /board's "You boarded with another sign-in." state.
 *
 * One action, and the next step only when it is needed. It reuses the reviewed move of BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 unchanged
 * (`startAccountMove`: a recent sign-in to this account, an EMPTY duplicate checked at FloFi and at the provider, a sealed single-use intent,
 * then a sign-in to the account that keeps everything and an explicit confirmation there). This module only decides what the browser does with
 * the server's answer; the server stays the authority on every check, so nothing here can link, merge or move an account.
 *
 * - The move started → sign in to the boarded account (`/login?move=1`).
 * - This sign-in is not recent → confirm it is you, once, then come back and continue (`/board?continue=1`). A continue that comes back and is
 *   still refused for the same reason never redirects again: it asks the person to press the button (no authentication loop).
 * - This sign-in holds something of its own (or cannot be closed) → it stays a separate account; the person signs in with the method they
 *   boarded with, which opens the boarded account with everything it holds.
 * - The session ended meanwhile → sign in again.
 * - Anything else (a provider outage, an expired step, a lost answer) → try again. The message never claims nothing changed: an answer lost in
 *   transit may follow a move the server did start, and the next press then finds the session ended and signs in again.
 */
export const CONTINUE_PARAM = 'continue';
export const CONTINUE_RETURN = `/board?${CONTINUE_PARAM}=1`;
export const CONTINUE_REAUTH = `/login?reauth=1&returnTo=${encodeURIComponent(CONTINUE_RETURN)}`;
/**
 * Set in this tab's session storage just before the identity confirmation; `/board?continue=1` continues only when it finds (and removes) it.
 * A `?continue=1` link from anywhere else therefore never starts anything without the person's own click.
 */
export const CONTINUE_MARKER = 'flofi.flight.continue';
/** The sign-in that opens the boarded account, then continues straight to Board now's check (never back to this state on its own). */
export const BOARDED_SIGN_IN = `/login?returnTo=${encodeURIComponent('/board?board=1')}`;

export type ContinueStep =
  | { readonly kind: 'NAVIGATE'; readonly to: string }
  | { readonly kind: 'REAUTH_AGAIN' }
  | { readonly kind: 'SEPARATE' }
  | { readonly kind: 'RETRY' };

/** Refusals that mean this sign-in's account is not an empty duplicate FloFi can close (see `AccountService.startAccountMove`). */
const SEPARATE = new Set(['ACCOUNT_MOVE_HAS_WALLET', 'ACCOUNT_MOVE_WALLET_SIGN_IN', 'ACCOUNT_MOVE_PRIVY_HAS_MFA', 'ACCOUNT_MOVE_PRIVY_METHOD_UNSUPPORTED',
  'ACCOUNT_MOVE_PRIVY_HELD', 'PRIVY_ACCOUNT_NOT_LINKED', 'PRIVY_USER_NOT_FOUND']);

/** `returning`: this continue runs on the way back from the identity confirmation it asked for. */
export function continueStep(result: { readonly ok: true; readonly value: { readonly next: string } } | { readonly ok: false; readonly code: string },
  returning: boolean): ContinueStep {
  // Only the move sign-in the server named: never an arbitrary destination.
  if (result.ok) return result.value.next === '/login?move=1' ? { kind: 'NAVIGATE', to: '/login?move=1' } : { kind: 'RETRY' };
  if (result.code === 'ACCOUNT_REAUTHENTICATION_REQUIRED') return returning ? { kind: 'REAUTH_AGAIN' } : { kind: 'NAVIGATE', to: CONTINUE_REAUTH };
  // The session ended meanwhile: sign in again (nothing to retry here). Back on Board now's check, never on its own back to this step.
  if (result.code === 'ACCOUNT_SESSION_REQUIRED') return { kind: 'NAVIGATE', to: BOARDED_SIGN_IN };
  if (result.code.startsWith('ACCOUNT_MOVE_BLOCKED_') || SEPARATE.has(result.code)) return { kind: 'SEPARATE' };
  return { kind: 'RETRY' };
}
