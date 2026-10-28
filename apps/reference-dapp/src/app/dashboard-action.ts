// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { loadDashboardRunDetail, loadDashboardSnapshot } from '../lib/dashboard/data-service';
import { ownerHistoryOperation } from '../server/owner-history';

export async function dashboardSnapshot(account: string, cursor: string | null = null) { return loadDashboardSnapshot(account, cursor); }
export async function dashboardRunDetail(account: string, runId: string) { return loadDashboardRunDetail(account, runId); }
export async function changeRunHistory(account: string, runId: string, action: 'DELETE' | 'ARCHIVE') {
  return ownerHistoryOperation(account, 'change', runId.startsWith('wfr_') ? 'WORKFLOW_RUN' : 'EXECUTION_RUN', runId, action);
}
export async function runHistoryDisposition(account: string, runId: string) {
  return ownerHistoryOperation(account, 'disposition', runId.startsWith('wfr_') ? 'WORKFLOW_RUN' : 'EXECUTION_RUN', runId);
}
