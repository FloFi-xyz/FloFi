// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { withFlightAccess } from '../server/flight-access';
// BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (PERF-01): the history list, one record's detail and its history disposition are read over
// GET /api/dashboard/history (`dashboard-reads.ts`), outside the per-client Server Action queue. Only the history change stays an action.
import { ownerHistoryOperation } from '../server/owner-history';
import { endVerifiedDeclinedAttempt } from '../server/workflow-run-history';

export async function changeRunHistory(account: string, runId: string, action: 'DELETE' | 'ARCHIVE') {
  return withFlightAccess(async () => {
  const kind = runId.startsWith('wfr_') ? 'WORKFLOW_RUN' : 'EXECUTION_RUN';
  // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): a single-card attempt whose batch the wallet rejected is ended first, only
  // when the server proves from the chain it was never sent; the API's guarded purge then decides whether the attempt may be deleted.
  if (kind === 'WORKFLOW_RUN' && action === 'DELETE') await endVerifiedDeclinedAttempt(runId);
  return ownerHistoryOperation(account, 'change', kind, runId, action);

  });
}
