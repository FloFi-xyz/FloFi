// SPDX-License-Identifier: AGPL-3.0-only
import { withFlightAccess } from '../../../../server/flight-access';
import { loadDashboardRunDetail, loadDashboardSnapshot } from '../../../../lib/dashboard/data-service';
import { ownerHistoryOperation } from '../../../../server/owner-history';

/**
 * BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (PERF-01): the Dashboard's history reads — one page of the owner's execution history (`view=list`,
 * optional `cursor`), one owned execution record (`view=detail`) and its history disposition (`view=disposition`) — as a GET Route Handler. They were Server Actions, which Next.js dispatches ONE AT A TIME per client: opening a
 * record waited behind every action already in flight on the page — the ~60 availability checks every page load sends, a slow swap preview, a
 * bridge observation — and showed "Loading execution…" for the sum of them. A route handler is fetched directly, in parallel with them.
 *
 * Same boundary and reads as the actions it replaces: the Flight boundary (`withFlightAccess`) for every read, and the owner-scoped, read-only
 * `loadDashboardSnapshot` / `loadDashboardRunDetail` / `ownerHistoryOperation('disposition')` (the wallet must be one this browser or the signed-in account proved; another
 * owner's run is NOT_FOUND). Nothing here observes, reconciles, signs or submits. Never cached.
 */
export const dynamic = 'force-dynamic';
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;
const ACCOUNT = /^(?:0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const account = query.get('account') ?? '', runId = query.get('runId') ?? '', view = query.get('view') ?? 'detail', cursor = query.get('cursor');
  const valid = view === 'list' ? !runId && (cursor === null || /^[A-Za-z0-9_-]{1,400}$/.test(cursor))
    : (view === 'detail' || view === 'disposition') && Boolean(runId) && runId.length <= 200 && cursor === null;
  if (!ACCOUNT.test(account) || !valid) return Response.json({ ok: false, code: 'DASHBOARD_REQUEST_INVALID' }, { status: 400, headers: NO_STORE });
  try {
    const value: unknown = await withFlightAccess<unknown>(() => view === 'list' ? loadDashboardSnapshot(account, cursor)
      : view === 'disposition' ? ownerHistoryOperation(account, 'disposition', runId.startsWith('wfr_') ? 'WORKFLOW_RUN' : 'EXECUTION_RUN', runId)
      : loadDashboardRunDetail(account, runId));
    return Response.json({ ok: true, value }, { headers: NO_STORE });
  } catch (error) {
    return Response.json({ ok: false, code: error instanceof Error && /^BETA_[A-Z_]+$/.test(error.message) ? error.message : 'BETA_ACCESS_UNAVAILABLE' },
      { status: 403, headers: NO_STORE });
  }
}
