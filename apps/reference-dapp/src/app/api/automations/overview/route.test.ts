// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the Automations GET reads availability and the overview in parallel, through the same boundary. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
const access = vi.fn(async (work: () => Promise<unknown>) => work());
const availability = vi.fn(async () => { order.push('availability:start'); await new Promise(r => setTimeout(r, 5)); order.push('availability:end'); return { enabled: true, code: null }; });
const operation = vi.fn(async (method: string, args: unknown[], owner: unknown) => { order.push('overview:start'); await new Promise(r => setTimeout(r, 5)); order.push('overview:end');
  return { ok: true, value: { method, args, owner } }; });
vi.mock('../../../../server/flight-access', () => ({ withFlightAccess: (work: () => Promise<unknown>) => access(work) }));
vi.mock('../../../../server/automation-operation', () => ({ automationAvailability: () => availability(), automationOperation: (m: string, a: unknown[], o: unknown) => operation(m, a, o) }));
const { GET } = await import('./route');
const owner = '0x' + 'A'.repeat(40);
const get = (query = '', headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', 'x-flofi-account': owner }) =>
  GET(new Request(`https://flofi.test/api/automations/overview${query}`, { headers }));

describe('GET /api/automations/overview', () => {
  beforeEach(() => { order.length = 0; access.mockClear(); availability.mockClear(); operation.mockClear(); });
  it('runs availability and the owner-scoped overview in parallel, in one request, through the Flight boundary, never cached', async () => {
    const response = await get();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(order.slice(0, 2).sort()).toEqual(['availability:start', 'overview:start']);
    expect(await response.json()).toEqual({ ok: true, value: { availability: { enabled: true, code: null },
      overview: { ok: true, value: { method: 'overview', args: [], owner: { namespace: 'eip155', address: owner.toLowerCase() } } } } });
    expect(access).toHaveBeenCalledOnce();
  });
  it('a background refresh reads the overview alone; without a wallet only availability is read', async () => {
    await get('?scope=overview'); expect(availability).not.toHaveBeenCalled(); expect(operation).toHaveBeenCalledOnce();
    operation.mockClear();
    const response = await get('', { 'sec-fetch-site': 'same-origin' });
    expect((await response.json()).value).toEqual({ availability: { enabled: true, code: null }, overview: null }); expect(operation).not.toHaveBeenCalled();
  });
  it.each([['', { 'sec-fetch-site': 'cross-site', 'x-flofi-account': owner }, 403], ['?scope=everything', undefined, 400], ['?account=x', undefined, 400],
    ['', { 'sec-fetch-site': 'same-origin', 'x-flofi-account': 'not-a-wallet' }, 400], ['?scope=overview', { 'sec-fetch-site': 'same-origin' }, 400]] as const)(
    'refuses a cross-origin or malformed request before any read (%s)', async (query, headers, status) => {
      const response = await get(query, headers as Record<string, string> | undefined);
      expect(response.status).toBe(status); expect(availability).not.toHaveBeenCalled(); expect(operation).not.toHaveBeenCalled();
    });
});
