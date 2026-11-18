// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import type { PositionWallet } from '../../../../domain/defi-positions';

const seams = vi.hoisted(() => ({ linked: vi.fn<() => Promise<PositionWallet[]>>(), proven: vi.fn<() => Promise<PositionWallet[]>>(),
  access: vi.fn(async (work: () => Promise<unknown>) => work()), read: vi.fn<(_wallet: PositionWallet) => Promise<unknown[]>>(async () => []) }));
vi.mock('../../../../server/defi-positions', () => ({ readWalletPositions: seams.read }));
vi.mock('../../../../server/flight-access', () => ({ withFlightAccess: seams.access }));
vi.mock('../../../../server/history-principals', () => ({ accountWalletPrincipals: seams.linked }));
vi.mock('../../../../server/session-principal', () => ({ currentWalletPrincipals: seams.proven }));

const OWNER = { namespace: 'eip155', address: '0x' + 'a'.repeat(40) } as const;
const LINKED = { namespace: 'eip155', address: '0x' + 'b'.repeat(40) } as const;
const FOREIGN = '0x' + 'c'.repeat(40);
const url = 'https://flofi.xyz/api/dashboard/positions';
const request = (address?: string, site = 'same-origin', path = url) => new Request(path, {
  headers: { 'sec-fetch-site': site, ...(address ? { 'x-flofi-account': address } : {}) },
});
beforeEach(() => {
  vi.clearAllMocks();
  seams.linked.mockResolvedValue([OWNER, LINKED]);
  seams.proven.mockResolvedValue([OWNER]);
});

describe('dashboard positions route', () => {
  it('lists only distinct verified or linked wallets for this session with a non-cacheable response', async () => {
    const result = await GET(request());
    expect(await result.json()).toEqual({ ok: true, value: [OWNER, LINKED] });
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(seams.read).not.toHaveBeenCalled();
  });
  it('allows owned wallet scans and refuses foreign or removed wallets before reading any cached results', async () => {
    expect((await GET(request(LINKED.address))).status).toBe(200);
    expect(seams.read).toHaveBeenCalledExactlyOnceWith(LINKED);
    seams.linked.mockResolvedValue([]);
    expect((await GET(request(LINKED.address))).status).toBe(403);
    expect((await GET(request(FOREIGN))).status).toBe(403);
    expect(seams.read).toHaveBeenCalledTimes(1);
  });
  it('rejects cross-origin, malformed and URL-supplied wallet selectors before account or provider access', async () => {
    expect((await GET(request(OWNER.address, 'cross-site'))).status).toBe(403);
    expect((await GET(request('not-an-address'))).status).toBe(400);
    expect((await GET(request(undefined, 'same-origin', url + '?account=' + OWNER.address))).status).toBe(400);
    expect(seams.access).not.toHaveBeenCalled();
  });
  it('distinguishes a disconnected wallet list from unavailable authority and provider failures', async () => {
    seams.linked.mockResolvedValue([]);
    seams.proven.mockResolvedValue([]);
    const disconnected = await GET(request());
    expect(await disconnected.json()).toEqual({ ok: true, value: [] });
    seams.linked.mockRejectedValueOnce(new Error('STORE_UNAVAILABLE'));
    expect((await GET(request())).status).toBe(503);
    seams.proven.mockResolvedValue([OWNER]);
    seams.read.mockRejectedValueOnce(new Error('POSITION_SCAN_BUSY'));
    expect((await GET(request(OWNER.address))).status).toBe(429);
    seams.read.mockRejectedValueOnce(new Error('RPC_FAILURE'));
    expect((await GET(request(OWNER.address))).status).toBe(503);
  });
});
