// SPDX-License-Identifier: AGPL-3.0-only
import { withFlightAccess } from '../../../../server/flight-access';
import { loadDashboardRunDetail, loadDashboardSnapshot } from '../../../../lib/dashboard/data-service';
import { ownerHistoryOperation } from '../../../../server/owner-history';

/**
 * BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (PERF-01): the Dashboard's history reads — one page of the owner's execution history (`view=list`,
 * optional `cursor`), one owned execution record (`view=detail`) and its history disposition (`view=disposition`) — as a GET Route Handler.
 * They were Server Actions, which Next.js dispatches ONE AT A TIME per client: opening a record waited behind every action already in flight on
 * the page — the ~60 availability checks every page load sends, a slow swap preview, a bridge observation — and showed "Loading execution…" for
 * the sum of them. A route handler is fetched directly, in parallel with them.
 *
 * Same boundary and reads as the actions it replaces: the Flight boundary (`withFlightAccess`) for every read, and the owner-scoped, read-only
 * `loadDashboardSnapshot` / `loadDashboardRunDetail` / `ownerHistoryOperation('disposition')` (the wallet must be one this browser or the
 * signed-in account proved; another owner's run is NOT_FOUND). Nothing here observes, reconciles, signs or submits. Never cached.
 *
 * Two protections the Server Actions had implicitly are explicit here (flofi-security review): the expected wallet travels in the
 * `x-flofi-account` request header — never in the URL, so it does not reach access logs, and a header no cross-origin page can send without a
 * CORS preflight this route never grants — and a browser fetch from another origin (`Sec-Fetch-Site` other than `same-origin`) is refused.
 */
export const dynamic = 'force-dynamic';
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;
const ACCOUNT = /^(?:0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const refuse = (code: string, status: number) => Response.json({ ok: false, code }, { status, headers: NO_STORE });
export async function GET(request: Request) {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return refuse('DASHBOARD_CROSS_ORIGIN_REFUSED', 403);
  const query = new URL(request.url).searchParams;
  const account = request.headers.get('x-flofi-account') ?? '', runId = query.get('runId') ?? '', view = query.get('view') ?? 'detail';
  const cursor = query.get('cursor');
  const valid = view === 'list' ? !runId && (cursor === null || /^[A-Za-z0-9_-]{1,400}$/.test(cursor))
    : (view === 'detail' || view === 'disposition') && Boolean(runId) && runId.length <= 200 && cursor === null;
  if (!ACCOUNT.test(account) || query.has('account') || !valid) return refuse('DASHBOARD_REQUEST_INVALID', 400);
  try {
    const value: unknown = await withFlightAccess<unknown>(() => view === 'list' ? loadDashboardSnapshot(account, cursor)
      : view === 'disposition' ? ownerHistoryOperation(account, 'disposition', runId.startsWith('wfr_') ? 'WORKFLOW_RUN' : 'EXECUTION_RUN', runId)
      : loadDashboardRunDetail(account, runId));
    return Response.json({ ok: true, value }, { headers: NO_STORE });
  } catch (error) {
    // A Flight refusal keeps its closed code; anything else is a failed read (never a message or a cause).
    return error instanceof Error && /^BETA_[A-Z_]+$/.test(error.message) ? refuse(error.message, 403) : refuse('DASHBOARD_READ_UNAVAILABLE', 500);
  }
}
