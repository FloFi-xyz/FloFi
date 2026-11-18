// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: Automations reads share one in-flight GET; a read after a mutation never joins an earlier one. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automationSnapshot } from './automation-reads';

const owner = { namespace: 'eip155' as const, address: '0x' + 'a'.repeat(40) };
const answer = (value: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { ok: true, value } : value), { status });
afterEach(() => vi.unstubAllGlobals());

describe('automationSnapshot', () => {
  it('joins concurrent readers of the same owner and scope; the owner travels in a header, never in the URL', async () => {
    let release!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const a = automationSnapshot(owner), b = automationSnapshot(owner);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/api/automations/overview', expect.objectContaining({ method: 'GET', headers: { 'x-flofi-account': owner.address } }));
    release(answer({ availability: { enabled: true, code: null }, overview: null }));
    expect(await a).toBe(await b);
  });
  it('a fresh read (after a mutation) never joins an earlier one, and later readers join the fresh one', async () => {
    const pending: ((r: Response) => void)[] = [];
    const fetch = vi.fn(() => new Promise<Response>(resolve => { pending.push(resolve); }));
    vi.stubGlobal('fetch', fetch);
    const before = automationSnapshot(owner, 'overview');
    const fresh = automationSnapshot(owner, 'overview', true);
    const after = automationSnapshot(owner, 'overview');
    expect(fetch).toHaveBeenCalledTimes(2);
    pending[0]!(answer({ availability: null, overview: { ok: true, value: 'old' } }));
    pending[1]!(answer({ availability: null, overview: { ok: true, value: 'new' } }));
    expect((await before).overview).toEqual({ ok: true, value: 'old' });
    expect((await fresh).overview).toEqual({ ok: true, value: 'new' });
    expect(await after).toBe(await fresh);
    expect(fetch.mock.calls.every(call => (call as unknown[])[0] === '/api/automations/overview?scope=overview')).toBe(true);
  });
  it('rejects with the route’s closed code, or a generic one; a failed read is not cached', async () => {
    const fetch = vi.fn(async () => answer({ ok: false, code: 'BETA_SESSION_REQUIRED' }, 403));
    vi.stubGlobal('fetch', fetch);
    await expect(automationSnapshot(owner)).rejects.toThrow('BETA_SESSION_REQUIRED');
    fetch.mockResolvedValueOnce(new Response('<html>', { status: 502 }));
    await expect(automationSnapshot(owner)).rejects.toThrow('AUTOMATION_UNAVAILABLE');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
