// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (PERF-01): the run-detail GET route keeps the actions' boundary and reads; it adds no new access. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const access = vi.fn(async (work: () => Promise<unknown>) => work());
const detail = vi.fn(async (account: string, runId: string) => ({ connection: 'CONNECTED', account, detail: { runId } }));
const list = vi.fn(async (account: string, cursor: string | null) => ({ connection: 'CONNECTED', account, runs: [], hasMore: false, cursor }));
const history = vi.fn(async () => ({ ok: true, disposition: 'VISIBLE' }));
vi.mock('../../../../server/flight-access', () => ({ withFlightAccess: (work: () => Promise<unknown>) => access(work) }));
vi.mock('../../../../lib/dashboard/data-service', () => ({ loadDashboardRunDetail: (account: string, runId: string) => detail(account, runId),
  loadDashboardSnapshot: (account: string, cursor: string | null) => list(account, cursor) }));
vi.mock('../../../../server/owner-history', () => ({ ownerHistoryOperation: (...args: unknown[]) => history(...args as []) }));
const { GET } = await import('./route');
const owner = '0x' + 'a'.repeat(40);
const get = (query: Record<string, string>) => GET(new Request(`https://flofi.test/api/dashboard/history?${new URLSearchParams(query)}`));

describe('GET /api/dashboard/history', () => {
  beforeEach(() => { access.mockClear(); detail.mockClear(); history.mockClear(); });
  it('reads one owned record through the Flight boundary, never cached', async () => {
    const response = await get({ account: owner, runId: 'xroute-' + 'c'.repeat(32) });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, value: { connection: 'CONNECTED', account: owner, detail: { runId: 'xroute-' + 'c'.repeat(32) } } });
    expect(access).toHaveBeenCalledTimes(1); expect(detail).toHaveBeenCalledWith(owner, 'xroute-' + 'c'.repeat(32)); expect(history).not.toHaveBeenCalled();
  });
  it('reads the history disposition with the run kind the action used', async () => {
    await get({ account: owner, runId: 'wfr_123', view: 'disposition' });
    expect(history).toHaveBeenCalledWith(owner, 'disposition', 'WORKFLOW_RUN', 'wfr_123');
    await get({ account: owner, runId: 'xroute-1', view: 'disposition' });
    expect(history).toHaveBeenLastCalledWith(owner, 'disposition', 'EXECUTION_RUN', 'xroute-1');
  });
  it.each([{ account: 'not-a-wallet', runId: 'x' }, { account: owner, runId: '' }, { account: owner, runId: 'x'.repeat(201) }, { account: owner, runId: 'x', view: 'observe' },
    { account: owner, view: 'list', cursor: 'bad cursor!' }, { account: owner, view: 'list', runId: 'x' }, { account: owner, runId: 'x', cursor: 'c' }])(
    'refuses a malformed request before any read (%o)', async query => {
      const response = await get(query);
      expect(response.status).toBe(400); expect(access).not.toHaveBeenCalled(); expect(detail).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    });
  it('a Flight refusal is a 403 with its closed code and reads nothing', async () => {
    access.mockImplementationOnce(async () => { throw new Error('BETA_SIGN_IN_REQUIRED'); });
    const response = await get({ account: owner, runId: 'xroute-1' });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ ok: false, code: 'BETA_SIGN_IN_REQUIRED' }); expect(detail).not.toHaveBeenCalled();
    access.mockImplementationOnce(async () => { throw new Error('connection reset at 10.0.0.1'); });
    expect(await (await get({ account: owner, runId: 'xroute-1' })).json()).toEqual({ ok: false, code: 'BETA_ACCESS_UNAVAILABLE' });
  });
});
