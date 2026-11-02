// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #149: `/api/flofi/journey` is off unless the deployment owner sets `FLOFI_JOURNEY_TELEMETRY=on`. While off the route builds no
 * receiver and reads nothing from the request (no cookie, no body), so nothing is processed or logged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const receiver = vi.hoisted(() => ({ created: 0, received: [] as Request[] }));
vi.mock('../../../../server/journey-telemetry', () => ({
  createJourneyReceiver: () => {
    receiver.created++;
    return async (request: Request) => { receiver.received.push(request); return new Response(null, { status: 204 }); };
  },
}));

const beacon = () => new Request('https://flofi.xyz/api/flofi/journey', { method: 'POST', body: '{"format":"flofi.journey-timing.v1"}',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: '__Host-flofi_account_session=sealed' } });
async function route(setting: string | undefined) {
  vi.resetModules();
  vi.stubEnv('FLOFI_JOURNEY_TELEMETRY', setting);
  return await import('./route');
}
afterEach(() => { vi.unstubAllEnvs(); receiver.created = 0; receiver.received = []; });

describe('Issue #149 journey endpoint opt-in', () => {
  it('is off by default and for any value other than `on`: answers 204 without building a receiver or reading the request', async () => {
    for (const setting of [undefined, '', 'off', 'OFF', 'disabled', 'true', '1', 'yes', 'onn']) {
      const { POST } = await route(setting);
      const request = beacon();
      const response = await POST(request);
      expect(response.status, String(setting)).toBe(204);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(request.bodyUsed, String(setting)).toBe(false);
    }
    expect(receiver.created).toBe(0);
    expect(receiver.received).toEqual([]);
  });
  it('hands every request to the bounded receiver once the owner opted in', async () => {
    for (const setting of ['on', ' ON ']) {
      const { POST } = await route(setting);
      const request = beacon();
      expect((await POST(request)).status).toBe(204);
      expect(receiver.received.at(-1)).toBe(request);
    }
    expect(receiver.created).toBe(2);
  });
});
