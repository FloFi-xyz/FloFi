// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HOTFIX-P1-FLIGHT-ACCESS-AND-CHAT-RECOVERY-001 (production 2026-11-16): "Board now" answered "eligible" (the browser then opens /app) for an
 * account the product layout refused, so the person went /app → /board → /app → /board. Board now's answer in closed beta is now the product
 * layout's own decision: "eligible" only when the layout admits the account, otherwise the refusal with its reason. Request-boundary tests: the
 * host stands in for an already verified FloFi session; no wallet signature, grant or database is simulated here (beta-access.pg.test.ts is).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ person: null as { accountId: string; emails: string[] } | null, cookie: null as string | null,
  now: Date.parse('2026-11-16T13:15:00Z'), account: vi.fn(), claim: vi.fn(), bind: vi.fn(), record: vi.fn(), grant: vi.fn(),
  product: vi.fn(), access: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => harness.cookie ? { value: harness.cookie } : undefined }) }));
vi.mock('./host', () => ({
  flightPerson: async () => harness.person,
  flightNow: async () => harness.now,
  flightStore: async () => ({ account: harness.account, claimVerifiedEntry: harness.claim, recordEvent: harness.record, calendar: {} }),
  flightAccessStore: async () => ({ bindSession: harness.bind }),
  flightOutbox: async () => null, clientDigest: async () => null, requestClient: async () => null,
}));
vi.mock('../server/platform-state-host', () => ({ platformStateHost: async () => ({}) }));
vi.mock('./beta-access', async importOriginal => ({ ...await importOriginal<typeof import('./beta-access')>(),
  createBetaAccessStore: () => ({ grant: harness.grant }) }));
vi.mock('../server/flight-access', () => ({ requireFlightProductAccess: harness.product, requireFlightAccess: harness.access }));
import { handleBoard } from './http';
import { boardOutcome } from './board-arrival';
import { FLIGHT_COPY } from '../components/flight/flight-copy';

const request = () => new Request('http://localhost/api/board/board', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: '{}' });
const eligible = { access: { kind: 'eligible', origin: 'LIST' }, pass: null, invites: [], listed: 'FIRST' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('FLOFI_BETA_ACCESS', 'beta');
  harness.person = { accountId: 'acct_server', emails: [] }; harness.cookie = null;
  harness.account.mockResolvedValue(eligible); harness.bind.mockResolvedValue('NONE'); harness.claim.mockResolvedValue('NONE');
  harness.grant.mockResolvedValue({ ok: true, accountId: 'acct_server' });
  harness.product.mockResolvedValue({ accountId: 'acct_server', sessionId: 's' });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('Board now answers "eligible" only for an account the product layout admits', () => {
  it('a valid grant the layout admits opens /app, without any email claim in closed beta', async () => {
    const response = await handleBoard(request());
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(boardOutcome(answer)).toEqual({ kind: 'APP', notice: null });
    expect(harness.grant).toHaveBeenCalledExactlyOnceWith('acct_server', harness.now);
    expect(harness.product).toHaveBeenCalledOnce();
    expect(harness.claim).not.toHaveBeenCalled();
  });
  it('an account the layout refuses gets that refusal with its reason, never "eligible" (no /app ↔ /board loop)', async () => {
    harness.product.mockRejectedValue(new Error('BETA_WALLET_NOT_LINKED'));
    const response = await handleBoard(request());
    expect(response.status).toBe(403);
    const answer = await response.json();
    expect(answer).toMatchObject({ ok: false, code: 'BETA_WALLET_NOT_LINKED' });
    expect(boardOutcome(answer)).toEqual({ kind: 'REFUSED', code: 'BETA_WALLET_NOT_LINKED' });
    // A failure to check is reported as such (the real check wraps any failure as BETA_UNAVAILABLE), never as a decision about the person and
    // never with its internal text; anything else that is not a BETA_* code is BETA_ACCESS_UNAVAILABLE.
    harness.product.mockRejectedValue(new Error('BETA_UNAVAILABLE'));
    expect(await (await handleBoard(request())).json()).toMatchObject({ ok: false, code: 'BETA_UNAVAILABLE' });
    for (const failure of [new Error('connection refused: secret detail'), 'not an error']) {
      harness.product.mockRejectedValue(failure);
      const answer = await (await handleBoard(request())).json();
      expect(answer).toMatchObject({ ok: false, code: 'BETA_ACCESS_UNAVAILABLE' });
      expect(JSON.stringify(answer)).not.toContain('secret detail');
    }
  });
  it('a refused grant (revoked, absent, closed group) is answered before the product is asked; nothing else is granted', async () => {
    for (const code of ['BETA_ACCESS_REVOKED', 'BETA_ACCESS_DENIED', 'BETA_NOT_OPEN', 'BETA_WALLET_REQUIRED']) {
      harness.grant.mockResolvedValueOnce({ ok: false, code });
      const answer = await (await handleBoard(request())).json();
      expect(answer).toMatchObject({ ok: false, code });
      expect(boardOutcome(answer).kind).not.toBe('APP');
    }
    expect(harness.product).not.toHaveBeenCalled();
  });
  it('a refusal also ends a pending browser access session, so it never holds back the later /board?board=1 → /app hand-off', async () => {
    harness.cookie = 'a'.repeat(43); harness.product.mockRejectedValue(new Error('BETA_WALLET_NOT_LINKED'));
    const response = await handleBoard(request());
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    harness.cookie = null;
    expect((await handleBoard(request())).headers.get('set-cookie')).toBeNull();
  });
  it('a pending proof of a second list email that this account cannot hold is a notice, not a loss of its own access', async () => {
    harness.cookie = 'a'.repeat(43); harness.bind.mockResolvedValue('ACCOUNT_HAS_OTHER_ENTRY');
    const response = await handleBoard(request());
    const answer = await response.json();
    expect(answer).toMatchObject({ ok: true, access: 'ACCOUNT_HAS_OTHER_ENTRY' });
    expect(boardOutcome(answer)).toEqual({ kind: 'APP', notice: 'ACCESS_ACCOUNT_HAS_OTHER_ENTRY' });
    expect(harness.bind).toHaveBeenCalledExactlyOnceWith({ session: harness.cookie, accountId: 'acct_server', now: harness.now });
    expect(harness.claim).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('every refusal Board now can answer has its own message in both languages (never "Something went wrong")', () => {
    for (const language of ['EN', 'PT'] as const) {
      const errors = FLIGHT_COPY[language].errors as Record<string, string>;
      for (const code of ['BETA_WALLET_NOT_LINKED', 'BETA_WALLET_REQUIRED', 'BETA_ACCESS_DENIED', 'BETA_ACCESS_REVOKED', 'BETA_NOT_OPEN', 'BETA_ACCESS_CLOSED',
        'BETA_SESSION_REQUIRED', 'BETA_SIGN_IN_REQUIRED', 'BETA_ACCESS_UNAVAILABLE', 'BETA_UNAVAILABLE', 'BETA_CONFIGURATION_INVALID', 'ACCESS_ACCOUNT_HAS_OTHER_ENTRY']) {
        expect(errors[code], `${language} ${code}`).toBeTruthy();
        expect(errors[code]).not.toBe(errors.generic);
      }
    }
    // The second-email refusal says the account's current access is unchanged and how to continue.
    expect(FLIGHT_COPY.EN.errors.ACCESS_ACCOUNT_HAS_OTHER_ENTRY).toMatch(/current access is unchanged.*Board now/);
    expect(FLIGHT_COPY.PT.errors.ACCESS_ACCOUNT_HAS_OTHER_ENTRY).toMatch(/acesso atual não muda.*Embarcar agora/);
  });
});
