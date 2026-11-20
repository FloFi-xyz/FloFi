// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { AutomationSnapshot } from './api/automations/overview/route';
import type { WorkflowOwner } from '../domain/saved-workflow';

/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the Automations reads over the GET route `/api/automations/overview` (availability and the owner's
 * overview in parallel, outside the page's Server Action queue). Concurrent readers of the same owner and scope share one request (the
 * workspace's first load, the proposals notice, a focus refresh). Any failure rejects with a closed code; callers keep what they already show.
 */
export type { AutomationSnapshot };
/** Codes after which this deployment genuinely does not serve automations ("Coming soon"); any other refusal is temporary. */
export const AUTOMATIONS_OFF: ReadonlySet<string> = new Set(['AUTOMATIONS_NOT_ENABLED', 'AUTOMATION_CONFIGURATION_INVALID']);
const inflight = new Map<string, Promise<AutomationSnapshot>>();
export function automationSnapshot(owner: WorkflowOwner | null, scope: 'all' | 'overview' | 'availability' = 'all', signal?: AbortSignal): Promise<AutomationSnapshot> {
  // Availability names nobody: no wallet is sent with it.
  const reader = scope === 'availability' ? null : owner;
  const key = `${scope}|${reader ? `${reader.namespace}:${reader.address}` : ''}`;
  // A caller managing a session-specific read must never join a request started under previous credentials.
  const shared = signal ? undefined : inflight.get(key);
  if (shared) return shared;
  // Bounded: a stalled read ends (the route's own budget is 60 s), so the page shows Retry instead of loading forever.
  const timeout = AbortSignal.timeout(65_000);
  const request = fetch(`/api/automations/overview${scope === 'all' ? '' : `?scope=${scope}`}`, { method: 'GET', cache: 'no-store', credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: reader ? { 'x-flofi-account': reader.address } : {} })
    .then(async response => {
      const body = await response.json().catch(() => ({})) as { ok?: unknown; value?: unknown; code?: unknown };
      if (!response.ok || body.ok !== true) throw new Error(typeof body.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(body.code) ? body.code : 'AUTOMATION_UNAVAILABLE');
      return body.value as AutomationSnapshot;
    })
    .finally(() => { if (inflight.get(key) === request) inflight.delete(key); });
  if (!signal) inflight.set(key, request);
  return request;
}
