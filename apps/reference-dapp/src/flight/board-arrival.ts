// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Flight transition): the arrival on /board after sign-in ("Board now" returns to `/board?board=1`, an invite to
 * `/board?invite=1`), as pure decisions shared by the server page and the board's client.
 *
 * 1. The server may send the person straight to /app before anything renders, but only when nothing remains for "Board now" to do: closed
 *    beta, boarding open, signed in, the campaign answers "eligible" (not a pass to show, not a closed group), no pending access link or
 *    code to bind, AND the product gate itself (`requireFlightAccess`, read-only) already lets them in. The grant, the wallet links and the
 *    claim are written only by the explicit POST /api/board/board, never here; everyone else gets the board and its own check.
 * 2. While the board's client checks (POST /api/board/board), the page shows FloFi's branded checking state from its first paint.
 * 3. The answer of that check, as one outcome the board acts on (the same branches the board always had).
 */
import type { BetaAccessMode } from './beta-access.ts';
import type { FlightAccess, FlightPhase } from './campaign.ts';

/** Which of /board's own return marks the URL carries. An invite wins, as on the client (the invite form opens; nothing is checked). */
export type BoardArrival = 'BOARD' | 'INVITE' | null;
export function boardArrival(search: Readonly<Record<string, string | readonly string[] | undefined>>): BoardArrival {
  return search.invite !== undefined ? 'INVITE' : search.board !== undefined ? 'BOARD' : null;
}

/** Whether the board's client runs its access check on arrival (and so the page opens on the checking state, not on the board). */
export const boardArrivalChecks = (arrival: BoardArrival, phase: FlightPhase | null): boolean => arrival === 'BOARD' && phase === 'BOARDING';

/** The read-only facts the server has for an arrival (from `flightState()` and the deployment's gate mode). */
export type BoardArrivalFacts = {
  readonly arrival: BoardArrival; readonly mode: BetaAccessMode; readonly phase: FlightPhase | null; readonly signedIn: boolean;
  readonly accessPending: boolean; readonly access: FlightAccess['kind'] | null;
};
/**
 * Whether the facts alone could send the person to /app; only then is the product gate asked. Open rollout always keeps the board's own
 * check: there "Board now" also claims the verified list entry and records the result, which a page view must not do.
 */
export function boardArrivalCandidate(facts: BoardArrivalFacts): boolean {
  return facts.arrival !== null && facts.mode === 'beta' && facts.phase === 'BOARDING' && facts.signedIn && !facts.accessPending && facts.access === 'eligible';
}
/** /app only for a candidate the product gate already admits (`productAccess`); the board otherwise. */
export function decideBoardArrival(facts: BoardArrivalFacts & { readonly productAccess: boolean }): 'APP' | 'BOARD' {
  return boardArrivalCandidate(facts) && facts.productAccess ? 'APP' : 'BOARD';
}

/** POST /api/board/board's answer, as the board reads it. */
export type BoardAnswer = { readonly ok: boolean; readonly code?: string; readonly flight?: unknown; readonly access?: unknown };
/**
 * SIGN_IN: sign in first (then come back). APP: open /app (a full navigation). PASS: show the person's boarding pass. PERSONAL: the hero
 * becomes the person's own state. REFUSED: the board shows the refusal's message. NONE: nothing to do. `notice` is an `ACCESS_*` message
 * code (an access link or code that was claimed elsewhere), shown with the outcome.
 */
export type BoardOutcome =
  | { readonly kind: 'SIGN_IN' }
  | { readonly kind: 'APP'; readonly notice: string | null }
  | { readonly kind: 'PASS'; readonly notice: string | null }
  | { readonly kind: 'PERSONAL'; readonly access: FlightAccess; readonly notice: string | null }
  | { readonly kind: 'REFUSED'; readonly code: string | undefined }
  | { readonly kind: 'NONE' };
export function boardOutcome(answer: BoardAnswer): BoardOutcome {
  if (answer.code === 'FLIGHT_SIGN_IN_REQUIRED') return { kind: 'SIGN_IN' };
  const flight = answer.flight as { readonly access?: FlightAccess } | null | undefined;
  const access = flight && typeof flight === 'object' ? flight.access : undefined;
  if (!answer.ok) return access && (access.kind === 'batch_closed' || access.kind === 'not_listed')
    ? { kind: 'PERSONAL', access, notice: null } : { kind: 'REFUSED', code: answer.code };
  if (!access || typeof access !== 'object') return { kind: 'NONE' };
  const notice = answer.access ? `ACCESS_${String(answer.access)}` : null;
  if (access.kind === 'eligible') return { kind: 'APP', notice };
  if (access.kind === 'boarded') return { kind: 'PASS', notice };
  return { kind: 'PERSONAL', access, notice };
}
