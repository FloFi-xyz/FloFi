// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { WalletActivityPage } from '../domain/wallet-activity';

/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the History's wallet activity read over the GET route `/api/dashboard/activity` — outside the page's
 * Server Action queue and independent of the execution history and portfolio reads. Concurrent readers of the same wallet and page share one
 * request; a caller that no longer needs the answer ignores it (the shared request is never aborted for the others). Any failure rejects with
 * its closed code; the History keeps showing FloFi's own records.
 */
const inflight = new Map<string, Promise<WalletActivityPage>>();
export function walletActivity(account: string, cursor: string | null = null): Promise<WalletActivityPage> {
  const key = `${account}|${cursor ?? ''}`;
  const shared = inflight.get(key);
  if (shared) return shared;
  // The wallet and its continuation are headers, never part of the URL (they would reach access logs).
  const request = fetch('/api/dashboard/activity', { method: 'GET', cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(65_000),
    headers: { 'x-flofi-account': account, ...cursor ? { 'x-flofi-cursor': cursor } : {} } })
    .then(async response => {
      const body = await response.json().catch(() => ({})) as { ok?: unknown; value?: unknown; code?: unknown };
      if (!response.ok || body.ok !== true) throw new Error(typeof body.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(body.code) ? body.code : 'ACTIVITY_READ_UNAVAILABLE');
      return body.value as WalletActivityPage;
    })
    .finally(() => { if (inflight.get(key) === request) inflight.delete(key); });
  inflight.set(key, request);
  return request;
}
