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
/** The browser's call: the expected wallet in the header, a same-origin fetch. */
const get = (input: Record<string, string>, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) => {
  const { account, ...query } = input;
  return GET(new Request(`https://flofi.test/api/dashboard/history?${new URLSearchParams(query)}`,
    { headers: { ...headers, ...account ? { 'x-flofi-account': account } : {} } }));
};

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
  it.each(['cross-site', 'same-site', 'none-of-these'])('refuses a browser fetch from another origin (sec-fetch-site: %s) before any read', async site => {
    const response = await get({ account: owner, runId: 'xroute-1' }, { 'sec-fetch-site': site });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ ok: false, code: 'DASHBOARD_CROSS_ORIGIN_REFUSED' });
    expect(access).not.toHaveBeenCalled(); expect(detail).not.toHaveBeenCalled();
  });
  it('never takes the wallet from the URL (it would reach access logs); a same-origin read without the fetch metadata header is served', async () => {
    const url = `https://flofi.test/api/dashboard/history?account=${owner}&runId=xroute-1`;
    expect((await GET(new Request(url, { headers: { 'sec-fetch-site': 'same-origin' } }))).status).toBe(400);
    expect((await GET(new Request(url, { headers: { 'x-flofi-account': owner } }))).status).toBe(400);
    expect(access).not.toHaveBeenCalled();
    expect((await get({ account: owner, runId: 'xroute-1' }, {})).status).toBe(200);
  });
  it('a Flight refusal is a 403 with its closed code and reads nothing', async () => {
    access.mockImplementationOnce(async () => { throw new Error('BETA_SIGN_IN_REQUIRED'); });
    const response = await get({ account: owner, runId: 'xroute-1' });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ ok: false, code: 'BETA_SIGN_IN_REQUIRED' }); expect(detail).not.toHaveBeenCalled();
    access.mockImplementationOnce(async () => { throw new Error('connection reset at 10.0.0.1'); });
    const failed = await get({ account: owner, runId: 'xroute-1' });
    expect(failed.status).toBe(500); expect(await failed.json()).toEqual({ ok: false, code: 'DASHBOARD_READ_UNAVAILABLE' });
  });
});
