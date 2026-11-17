// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { withFlightAccess } from '../server/flight-access';
// BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (PERF-01): the history list, one record's detail and its history disposition are read over
// GET /api/dashboard/history (`dashboard-reads.ts`), outside the per-client Server Action queue. Only the history change stays an action.
import { ownerHistoryOperation } from '../server/owner-history';

export async function changeRunHistory(account: string, runId: string, action: 'DELETE' | 'ARCHIVE') {
  return withFlightAccess(async () => {
  return ownerHistoryOperation(account, 'change', runId.startsWith('wfr_') ? 'WORKFLOW_RUN' : 'EXECUTION_RUN', runId, action);

  });
}
