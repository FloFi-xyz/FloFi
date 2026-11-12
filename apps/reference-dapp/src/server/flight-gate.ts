// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Flight transition): what a page does when the Flight gate (`requireFlightAccess`) does not let a request into the product.
 * Pure: no request, cookie, database or framework state is read here, so the decision is unit-tested and the same wherever it runs.
 *
 * - A refusal that means "no product access" (not signed in, not boarded, revoked, a wallet not linked, the gate closed, ...) sends the
 *   person to the Flight experience (/board), as before.
 * - A failure to CHECK access (the access store or its configuration is unavailable) is not a decision about the person: it is never
 *   presented as one (no hop to /board). The layout shows "We could not check your access" with Try again instead.
 * Both fail closed: neither renders anything of the workspace nor reads its data, and nothing here grants, creates or links anything.
 *
 * How the person is sent to /board depends on the request. A document request gets the HTTP redirect. A Server Action re-render (a wallet
 * action that set a cookie) or a client-router fetch must never redirect into the already-loaded product document: Next.js would draw
 * /board inside it, under the product's global CSS and theme (the "broken board"). Those render a full-page hand-off instead, which loads
 * the destination as its own document. The request headers only choose between these presentations of a refusal; a forged header can
 * change how a refusal looks, never whether the product renders.
 */

/** Why the gate did not let the request in. */
export type FlightGateOutcome = 'REFUSED' | 'UNAVAILABLE';
/** A full document load, a Server Action (its response re-renders the current tree) or a client-router fetch (RSC navigation, refresh, prefetch). */
export type FlightRequestKind = 'DOCUMENT' | 'ACTION' | 'FETCH';
/** REDIRECT: an HTTP redirect. HANDOFF: a page that performs a full navigation. RETRY: the "could not check your access" state. */
export type FlightGateResponse = 'REDIRECT' | 'HANDOFF' | 'RETRY';

/** `BETA_*` codes that report the check itself failed. Every other `BETA_*` code is a refusal of this person. */
const UNCHECKED: ReadonlySet<string> = new Set(['BETA_UNAVAILABLE', 'BETA_ACCESS_UNAVAILABLE', 'BETA_CONFIGURATION_INVALID']);

/** A refusal (`BETA_*` decision about the person) or a failure to check (any other error, including an unknown one). */
export function flightGateOutcome(error: unknown): FlightGateOutcome {
  const code = error instanceof Error ? error.message : '';
  return /^BETA_[A-Z_]+$/.test(code) && !UNCHECKED.has(code) ? 'REFUSED' : 'UNAVAILABLE';
}

type HeaderReader = { get(name: string): string | null };
/**
 * Next.js marks a Server Action with the `next-action` header (node_modules/next/dist/client/components/app-router-headers.js ACTION_HEADER;
 * not hidden from `headers()`, unlike the RSC flight headers). Browsers mark every navigation with `Sec-Fetch-Mode: navigate` (frames
 * included); a client-router fetch is `cors`/`same-origin`. Without Fetch Metadata (an older browser, a non-browser client) the request is
 * treated as a document, which keeps today's HTTP redirect.
 */
export function flightRequestKind(headers: HeaderReader): FlightRequestKind {
  if (headers.get('next-action') !== null) return 'ACTION';
  const mode = headers.get('sec-fetch-mode');
  return mode === null || mode === 'navigate' ? 'DOCUMENT' : 'FETCH';
}

/** How to leave for another page: an HTTP redirect only for a document request, else a full-page hand-off (never a client navigation). */
export const fullNavigation = (kind: FlightRequestKind): 'REDIRECT' | 'HANDOFF' => kind === 'DOCUMENT' ? 'REDIRECT' : 'HANDOFF';

/** What the product layout renders for a request the gate did not let in. */
export function flightGateResponse(outcome: FlightGateOutcome, kind: FlightRequestKind): FlightGateResponse {
  return outcome === 'UNAVAILABLE' ? 'RETRY' : fullNavigation(kind);
}
