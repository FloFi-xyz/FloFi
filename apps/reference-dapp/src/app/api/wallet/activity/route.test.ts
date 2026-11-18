// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the wallet activity GET route reads only for the wallet's owner, same-origin, never cached. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const access = vi.fn(async (work: () => Promise<unknown>) => work());
const principals = vi.fn(async () => [{ namespace: 'eip155', address: '0x' + 'a'.repeat(40) }]);
const read = vi.fn(async (input: { account: string; cursor: string | null }) => ({ account: input.account, transfers: [], coverage: [], cursor: null, hidden: 0 }));
vi.mock('../../../../server/flight-access', () => ({ withFlightAccess: (work: () => Promise<unknown>) => access(work) }));
vi.mock('../../../../server/history-principals', () => ({ historyPrincipals: () => principals() }));
vi.mock('../../../../server/wallet-activity', async importOriginal => ({ ...await importOriginal<typeof import('../../../../server/wallet-activity')>(),
  readWalletActivity: (input: { account: string; cursor: string | null }) => read(input) }));
const { GET } = await import('./route');
const owner = '0x' + 'a'.repeat(40);
const get = (query = '', headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', 'x-flofi-account': owner }) =>
  GET(new Request(`https://flofi.test/api/wallet/activity${query}`, { headers }));

describe('GET /api/wallet/activity', () => {
  beforeEach(() => { access.mockClear(); read.mockClear(); principals.mockClear(); });
  it('reads one page for a wallet this browser or the signed-in account holds, through the Flight boundary, never cached', async () => {
    const response = await get('?cursor=abc');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(read).toHaveBeenCalledWith({ account: owner, cursor: 'abc' }); expect(access).toHaveBeenCalledTimes(1);
  });
  it('refuses another wallet (no proof, no account link) without reading anything', async () => {
    const response = await get('', { 'sec-fetch-site': 'same-origin', 'x-flofi-account': '0x' + 'b'.repeat(40) });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ ok: false, code: 'ACTIVITY_SIGN_IN_REQUIRED' }); expect(read).not.toHaveBeenCalled();
  });
  it.each([['', { 'sec-fetch-site': 'cross-site', 'x-flofi-account': owner }, 403], ['', { 'sec-fetch-site': 'same-origin' }, 400], [`?account=${owner}`, undefined, 400],
    ['?cursor=bad cursor!', undefined, 400], ['?other=1', undefined, 400]] as const)('refuses a cross-origin or malformed request (%s)', async (query, headers, status) => {
    const response = await get(query, headers as Record<string, string> | undefined);
    expect(response.status).toBe(status); expect(read).not.toHaveBeenCalled();
  });
  it('a provider failure answers a closed code, never a message', async () => {
    read.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1:443'));
    const response = await get();
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ ok: false, code: 'ACTIVITY_READ_UNAVAILABLE' });
  });
});
