// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createJourney } from '../domain/journey-metrics';
import { createJourneyReceiver } from './journey-telemetry';
import { sealAccountSession } from '../accounts/account-session';

const event = () => {
  let n = 0;
  const journey = createJourney({ operation: 'swap', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', provider: 'Jupiter', wallet: 'privy-embedded', clock: () => (n += 250) });
  journey.mark('intent'); journey.mark('first_quote'); journey.mark('wallet_open'); journey.mark('user_decision');
  return journey.event('in_progress')!;
};
const post = (body: string, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) =>
  new Request('https://flofi.xyz/api/flofi/journey', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

describe('BUILD-FLOFI-EXECUTION-PERFORMANCE-001 journey receiver', () => {
  it('logs exactly the closed, content-free fields of a same-origin event', async () => {
    const logged: Record<string, unknown>[] = [];
    const receive = createJourneyReceiver({ env: {}, account: () => 'acct-1', log: fields => logged.push(fields) });
    expect((await receive(post(JSON.stringify(event())))).status).toBe(204);
    expect(Object.keys(logged[0]!).sort()).toEqual(['evidence', 'intent_to_first_quote_ms', 'journey_id', 'network', 'operation', 'outcome', 'provider', 'system_ms', 'user_ms',
      'wallet', 'wallet_open_to_user_decision_ms']);
    expect(logged[0]!.evidence).toBe('CLIENT_REPORTED');
    expect(logged[0]).toMatchObject({ user_ms: 250, system_ms: 250, operation: 'swap', provider: 'Jupiter' });
  });
  it('refuses cross-site posts, oversized or malformed bodies and anything outside the schema; can be turned off; is rate-bounded', async () => {
    const logged: unknown[] = [], receive = createJourneyReceiver({ env: {}, account: () => 'acct-1', log: fields => logged.push(fields) });
    expect((await receive(post(JSON.stringify(event()), { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await receive(post(JSON.stringify(event()), { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await receive(post(JSON.stringify(event()), { origin: 'https://flofi.xyz' }))).status).toBe(204);
    expect((await receive(post('x'.repeat(5_000)))).status).toBe(413);
    const chunked = new Request('https://flofi.xyz/api/flofi/journey', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, duplex: 'half',
      body: new ReadableStream({ start(controller) { for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(1_000))); controller.close(); } }) } as RequestInit);
    expect((await receive(chunked)).status).toBe(413);
    expect((await receive(post('{not json'))).status).toBe(400);
    expect((await receive(post(JSON.stringify({ ...event(), chat: 'swap my savings' })))).status).toBe(400);
    expect(logged).toHaveLength(1);
    const off = createJourneyReceiver({ env: { FLOFI_JOURNEY_TELEMETRY: 'off' }, account: () => 'acct-1', log: fields => logged.push(fields) });
    expect((await off(post(JSON.stringify(event())))).status).toBe(204);
    expect(logged).toHaveLength(1);
    let now = 0, sender = 0;
    // The process bound: many distinct accounts (each within its own bound) still cannot exceed 600 events a minute.
    const bounded = createJourneyReceiver({ env: {}, now: () => now, account: () => `acct-${sender++}`, log: () => undefined });
    const statuses: number[] = [];
    for (let i = 0; i < 601; i++) statuses.push((await bounded(post(JSON.stringify(event())))).status);
    expect(statuses.at(-1)).toBe(429);
    now = 60_000;
    expect((await bounded(post(JSON.stringify(event())))).status).toBe(204);
  });
});

describe('BUILD-FLOFI-EXECUTION-PERFORMANCE-001 latency report over the existing log stream', () => {
  it('turns logged journeys into labelled p50/p95, and says INSUFFICIENT_SAMPLE instead of inventing percentiles', async () => {
    // @ts-expect-error -- plain ESM operations script without type declarations
    const { summarize } = await import('../../../../scripts/journey-latency-report.mjs') as { summarize: (lines: string[], o: { environment: string; minimum?: number }) => {
      environment: string; rows: { metric: string; dimension: string; value: string; count: number; p50?: number; p95?: number; result?: string }[] } };
    const { createLogger } = await import('@defi-workflow-engine/cloud-runtime');
    const lines: string[] = [];
    const receive = createJourneyReceiver({ env: {}, account: () => 'acct-1', log: fields => createLogger({ service: 'flofi-journey', sink: line => lines.push(line) }).info('journey.timing', fields) });
    for (let i = 0; i < 25; i++) await receive(post(JSON.stringify(event())));
    lines.push('not json', JSON.stringify({ event: 'quote.provider_result', provider: 'relay', status: 'EXECUTABLE', duration_ms: 400 }));
    const report = summarize(lines, { environment: 'MOCKED' });
    expect(report.environment).toBe('MOCKED');
    expect(report.rows.find(r => r.metric === 'wallet_open_to_user_decision_ms' && r.dimension === 'all')).toMatchObject({ count: 25, p50: 250, p95: 250 });
    expect(report.rows.find(r => r.metric === 'provider_answer_ms')).toMatchObject({ count: 1, result: 'INSUFFICIENT_SAMPLE' });
    expect(() => summarize(lines, { environment: 'GUESSED' })).toThrow('--environment');
  });
});

describe('BUILD-FLOFI-EXECUTION-PERFORMANCE-001 journey receiver abuse bounds', () => {
  const env = { FLOFI_SESSION_SECRET: 'journey-test-secret-0123456789abcdef0123456789abcdef' };
  const T0 = Date.parse('2026-11-01T12:00:00.000Z');
  const cookieFor = (accountId: string, at = T0) => sealAccountSession(env, { accountId, sessionId: 'a'.repeat(32), method: 'google',
    authenticatedAt: Math.floor(at / 1000), expiresAt: Math.floor(at / 1000) + 3_600 }, 'flofi.xyz', new Date(at));
  const signedIn = (token: string | null) => post(JSON.stringify(event()), { 'sec-fetch-site': 'same-origin', host: 'flofi.xyz', 'x-forwarded-proto': 'https',
    ...token === null ? {} : { cookie: `other=1; __Host-flofi_account_session=${encodeURIComponent(token)}` } });

  it('accepts only a signed-in FloFi session (sealed, host-bound, unexpired) and never logs who sent it', async () => {
    const logged: Record<string, unknown>[] = [];
    const receive = createJourneyReceiver({ env, now: () => T0, log: fields => logged.push(fields) });
    const accountId = 'acct_' + 'b'.repeat(32);
    expect((await receive(signedIn(cookieFor(accountId)))).status).toBe(204);
    expect((await receive(signedIn(null))).status).toBe(401);
    const malformed = post(JSON.stringify(event()), { 'sec-fetch-site': 'same-origin', host: 'flofi.xyz', 'x-forwarded-proto': 'https',
      cookie: '__Host-flofi_account_session=%E0%A4%A' });
    expect((await receive(malformed)).status).toBe(401);
    expect((await receive(signedIn(cookieFor(accountId).slice(0, -2) + 'xx'))).status).toBe(401);
    expect((await receive(signedIn(cookieFor(accountId, T0 - 7_200_000)))).status).toBe(401);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain(accountId);
  });
  it('bounds each account separately, so one sender cannot crowd out everyone else', async () => {
    let now = T0;
    const receive = createJourneyReceiver({ env: {}, now: () => now, account: request => request.headers.get('x-test-account'), log: () => undefined });
    const from = (account: string) => receive(post(JSON.stringify(event()), { 'sec-fetch-site': 'same-origin', 'x-test-account': account }));
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await from('noisy')).status);
    expect(statuses.slice(0, 60).every(status => status === 204)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect((await from('quiet')).status).toBe(204);
    now += 600_000;
    expect((await from('noisy')).status).toBe(204);
  });
});
