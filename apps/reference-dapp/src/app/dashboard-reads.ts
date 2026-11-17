// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { DashboardDetailResponse, DashboardSnapshot } from '../lib/dashboard/types';
import type { HistoryDisposition } from '@defi-workflow-engine/cloud-runtime';

/**
 * BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (PERF-01): the Dashboard's history reads over the GET route `/api/dashboard/history`, so the history and
 * an opened record never wait in the page's Server Action queue (Next.js dispatches actions one at a time per client). `signal` cancels a read the page no longer
 * needs (another record opened, the wallet changed). Any failure rejects; the caller shows the record as unavailable.
 */
async function read<T>(account: string, view: 'list' | 'detail' | 'disposition', target: { runId?: string; cursor?: string | null }, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams({ view, ...target.runId ? { runId: target.runId } : {}, ...target.cursor ? { cursor: target.cursor } : {} });
  // The expected wallet is a header (never in the URL or access logs); the route requires it and a same-origin fetch.
  const response = await fetch(`/api/dashboard/history?${query}`, { method: 'GET', cache: 'no-store', credentials: 'same-origin',
    headers: { 'x-flofi-account': account }, ...signal ? { signal } : {} });
  const body = await response.json() as { ok?: unknown; value?: unknown };
  if (!response.ok || body.ok !== true) throw new Error('DASHBOARD_READ_UNAVAILABLE');
  return body.value as T;
}
export const dashboardSnapshot = (account: string, cursor: string | null = null, signal?: AbortSignal) => read<DashboardSnapshot>(account, 'list', { cursor }, signal);
export const dashboardRunDetail = (account: string, runId: string, signal?: AbortSignal) => read<DashboardDetailResponse>(account, 'detail', { runId }, signal);
export const runHistoryDisposition = (account: string, runId: string, signal?: AbortSignal) => read<HistoryDisposition>(account, 'disposition', { runId }, signal);
