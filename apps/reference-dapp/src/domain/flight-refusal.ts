// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 (2026-11-12, owner test of Arbitrum Swap → Base Bridge): a Flight Beta refusal in plain words, with the next action.
 *
 * The Flight gate (src/flight/beta-access.ts, src/server/flight-access.ts, backend/app.ts) refuses a request BEFORE that request's own work, so the
 * refused request itself quoted, simulated, prepared or sent nothing. These sentences say only that: they never claim anything about earlier
 * requests (an already-sent transaction stays tracked through the owner-recovery paths, which these codes do not close).
 *
 * Before this module every BETA_* code reached the Editor as the generic "FloFi could not complete this simulation" ("Simulation failed"), so a
 * wallet that was connected but not linked to the signed-in FloFi account looked like a broken simulation. The policy itself is unchanged:
 * linking proves a wallet belongs to the account (a signature, never a transaction) and Board binds proven wallets to Flight access.
 */
export type FlightRefusalAction = 'LINK_WALLET' | 'BOARD' | 'SIGN_IN' | 'RETRY' | 'NONE';
export type FlightRefusal = { readonly code: string; readonly title: string; readonly message: string; readonly action: FlightRefusalAction };

const STOPPED = 'so FloFi stopped this request: it was not quoted, simulated or sent.';
const REFUSALS: Readonly<Record<string, Omit<FlightRefusal, 'code'>>> = Object.freeze({
  BETA_WALLET_NOT_LINKED: { title: 'Wallet not linked to your FloFi account', action: 'LINK_WALLET',
    message: `This wallet is not linked to your FloFi account for Flight access, ${STOPPED} Save it in Credentials (you sign a message, never a transaction), then choose Board now on the Board page to add it to your access — or switch to a wallet you already linked.` },
  BETA_WALLET_REQUIRED: { title: 'Link a wallet to your FloFi account', action: 'LINK_WALLET',
    message: `Your FloFi account has no wallet linked for Flight access yet, ${STOPPED} Link the wallet you will sign with in Credentials, then choose Board now on the Board page.` },
  BETA_SESSION_REQUIRED: { title: 'Sign in again', action: 'SIGN_IN',
    message: 'Your FloFi session ended, so FloFi stopped this request. Sign in again to continue; anything already sent stays tracked.' },
  BETA_SIGN_IN_REQUIRED: { title: 'Sign in again', action: 'SIGN_IN',
    message: 'Your FloFi session ended, so FloFi stopped this request. Sign in again to continue; anything already sent stays tracked.' },
  BETA_ACCESS_DENIED: { title: 'Flight access not active for this account', action: 'BOARD',
    message: `This FloFi account does not have active Flight access, ${STOPPED} Open the Board page to check your access.` },
  BETA_ACCESS_REVOKED: { title: 'Flight access ended', action: 'NONE',
    message: `Flight access for this account has ended, ${STOPPED} Anything already sent stays tracked.` },
  BETA_NOT_OPEN: { title: 'Boarding has not opened yet', action: 'BOARD',
    message: `Boarding has not opened yet, ${STOPPED} Open the Board page to see when it opens.` },
  BETA_ACCESS_CLOSED: { title: 'FloFi is not accepting new activity', action: 'NONE',
    message: `FloFi is not accepting new activity right now, ${STOPPED} Anything already sent stays tracked.` },
  BETA_ACCESS_UNAVAILABLE: { title: 'Flight access could not be checked', action: 'RETRY',
    message: `FloFi could not check your Flight access right now, ${STOPPED} Try again in a moment.` },
  BETA_UNAVAILABLE: { title: 'Flight access could not be checked', action: 'RETRY',
    message: `FloFi could not check your Flight access right now, ${STOPPED} Try again in a moment.` },
  BETA_CONFIGURATION_INVALID: { title: 'Flight access could not be checked', action: 'RETRY',
    message: `FloFi could not check your Flight access right now, ${STOPPED} Try again in a moment.` },
});

/** The code inside a classified error (`BETA_X`, `BETA_X:detail`), or null. Never matches a provider text. */
export function flightRefusalCode(error: unknown): string | null {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const code = /^(BETA_[A-Z_]{3,60})(?::|$)/.exec(text.trim())?.[1];
  return code && Object.hasOwn(REFUSALS, code) ? code : null;
}
export function flightRefusal(error: unknown): FlightRefusal | null {
  const code = flightRefusalCode(error);
  return code ? { code, ...REFUSALS[code]! } : null;
}
/** The sentence shown for a Flight refusal, or null for any other code. */
export const flightRefusalMessage = (error: unknown): string | null => flightRefusal(error)?.message ?? null;
/** Short label for a status line or a blocker title, matched back from a sentence this module produced (null otherwise). */
export function flightRefusalTitleOf(message: string): string | null {
  return Object.values(REFUSALS).find(refusal => refusal.message === message)?.title ?? null;
}
/** Every sentence and title (catalog completeness tests and the PT-BR catalog). */
export const FLIGHT_REFUSAL_COPY: readonly string[] = Object.freeze([...new Set(Object.values(REFUSALS).flatMap(r => [r.title, r.message]))]);
/** Where the person acts on a refusal. Links only to existing pages; nothing here grants, binds or signs anything. */
export const FLIGHT_REFUSAL_HREF: Readonly<Record<FlightRefusalAction, string | null>> = Object.freeze({
  LINK_WALLET: '/app/credentials', BOARD: '/board', SIGN_IN: '/login?returnTo=%2Fapp', RETRY: null, NONE: null });
/** Code → sentence, for the code-keyed refusal tables of the Editor run panels. */
export const FLIGHT_REFUSAL_MESSAGES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(Object.entries(REFUSALS).map(([code, r]) => [code, r.message])));
