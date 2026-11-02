// SPDX-License-Identifier: AGPL-3.0-only
/** Issue #149: the Dashboard list reads the recorded attempts of runs whose summary cannot say what landed (owner-scoped, read-only). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudApiBaseUrl, callCloudFlow } from '../../server/cloud-api-client';
import { currentWalletPrincipal } from '../../server/session-principal';
import { loadDashboardSnapshot } from './data-service';
import { dashboardRunIndex } from './run-mapping';

vi.mock('../../server/cloud-api-client', () => ({ cloudApiBaseUrl: vi.fn(), callCloudFlow: vi.fn() }));
vi.mock('../../server/session-principal', () => ({ currentWalletPrincipal: vi.fn() }));
const account = '0x' + 'a'.repeat(40), other = '0x' + 'b'.repeat(40), hash = '0x' + 'c'.repeat(64);
const summary = (runId: string, status: string, flow = 'base-aave') => ({ runId, ownerAccount: account, flow, status, hasEvidence: false });
const response = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: status === 200, value }), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
function setup(details: Record<string, unknown>, list: unknown[]) {
  vi.mocked(currentWalletPrincipal).mockResolvedValue(account);
  vi.mocked(cloudApiBaseUrl).mockReturnValue(new URL('http://127.0.0.1:9999/'));
  const transport = vi.fn().mockImplementation((url: URL) => {
    if (url.pathname === '/v1/runs') return Promise.resolve(response({ items: list, next: null }));
    const id = decodeURIComponent(url.pathname.split('/').at(-1)!), detail = details[id];
    return detail instanceof Error ? Promise.reject(detail) : Promise.resolve(detail === undefined ? response(null, 404) : response(detail));
  });
  vi.stubGlobal('fetch', transport);
  return transport;
}

describe('Issue #149: Dashboard list attempt evidence', () => {
  it('reads the attempts of not-started-looking runs only, and shows the landed approval instead of "nothing was sent"', async () => {
    const approved = { ...summary('aave-approved', 'AUTHORIZED'), attempts: [{ attemptId: 'aave-approved.APPROVAL', step: 'APPROVAL', state: 'CONFIRMED', transactionHash: hash, reconciled: true }] };
    const simulated = { ...summary('aave-simulated', 'SIMULATED'), attempts: [] };
    const transport = setup({ 'aave-approved': approved, 'aave-simulated': simulated },
      [summary('aave-approved', 'AUTHORIZED'), summary('aave-simulated', 'SIMULATED'), summary('aave-done', 'RECONCILED'), summary('aave-pending', 'PENDING')]);
    const snapshot = await loadDashboardSnapshot(account);
    expect(snapshot.connection).toBe('CONNECTED');
    // The reconciled and in-flight summaries are self-describing: only the two ambiguous runs are read, each through its owner-scoped record.
    expect(transport.mock.calls.map(([url]) => (url as URL).pathname).sort()).toEqual(['/v1/runs', '/v1/runs/aave-approved', '/v1/runs/aave-simulated']);
    for (const [, init] of transport.mock.calls) expect(init).toMatchObject({ method: 'GET', headers: { 'x-flofi-wallet-principal': account } });
    expect(callCloudFlow).not.toHaveBeenCalled();
    const views = Object.fromEntries(dashboardRunIndex(account, snapshot.runs, null).map(view => [view.run.runId, view]));
    expect(views['aave-approved']).toMatchObject({ status: 'Partially completed', landed: 'Approval confirmed · main action not sent' });
    expect(views['aave-simulated']).toMatchObject({ status: 'Not started', landed: null });
    expect(views['aave-done']?.status).toBe('Completed');
    expect(snapshot.runs.find(run => run.runId === 'aave-done')).not.toHaveProperty('attempts');
  });

  it('fails closed when a run record cannot be read or belongs to another owner or run: never "nothing was sent"', async () => {
    setup({ 'read-fails': new Error('offline'), 'other-owner': { ...summary('other-owner', 'AUTHORIZED'), ownerAccount: other, attempts: [] },
      'other-run': { ...summary('another-id', 'AUTHORIZED'), attempts: [] }, 'no-attempts': summary('no-attempts', 'AUTHORIZED') },
    [summary('read-fails', 'AUTHORIZED'), summary('other-owner', 'AUTHORIZED'), summary('other-run', 'AUTHORIZED'), summary('no-attempts', 'AUTHORIZED'), summary('absent', 'SIMULATED')]);
    const snapshot = await loadDashboardSnapshot(account);
    expect(snapshot.connection).toBe('CONNECTED');
    expect(snapshot.runs.map(run => [run.runId, run.attemptsUnavailable, run.attempts])).toEqual([
      ['read-fails', true, undefined], ['other-owner', true, undefined], ['other-run', true, undefined], ['no-attempts', true, undefined], ['absent', true, undefined]]);
    for (const view of dashboardRunIndex(account, snapshot.runs, null)) expect(view.status, view.run.runId).toBe('Unresolved');
  });

  it('bounds the reads of one page (25 runs, at most 5 at a time)', async () => {
    let inFlight = 0, peak = 0;
    vi.mocked(currentWalletPrincipal).mockResolvedValue(account);
    vi.mocked(cloudApiBaseUrl).mockReturnValue(new URL('http://127.0.0.1:9999/'));
    const list = Array.from({ length: 25 }, (_, i) => summary(`run-${i}`, 'SIMULATED'));
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: URL) => {
      if (url.pathname === '/v1/runs') return response({ items: list, next: null });
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      return response({ ...summary(decodeURIComponent(url.pathname.split('/').at(-1)!), 'SIMULATED'), attempts: [] });
    }));
    const snapshot = await loadDashboardSnapshot(account);
    expect(snapshot.runs).toHaveLength(25);
    expect(snapshot.runs.every(run => Array.isArray(run.attempts) && !run.attemptsUnavailable)).toBe(true);
    expect(peak).toBeLessThanOrEqual(5);
  });
});
