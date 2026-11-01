// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createJourney, JOURNEY_MARKS, JOURNEY_METRICS } from '../domain/journey-metrics';
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
    expect(Object.keys(logged[0]!).sort()).toEqual(['deployment', 'evidence', 'intent_to_first_quote_ms', 'journey_id', 'network', 'network_environment', 'operation',
      'outcome', 'provider', 'system_ms', 'user_ms', 'wallet', 'wallet_open_to_user_decision_ms']);
    expect(logged[0]!.evidence).toBe('CLIENT_REPORTED');
    expect(logged[0]).toMatchObject({ user_ms: 250, system_ms: 250, operation: 'swap', provider: 'Jupiter', deployment: 'local', network_environment: 'MAINNET' });
  });
  it('recomputes the totals from the accepted metrics (never the client\'s figures; null, not 0, when unmeasured) and logs a journey once', async () => {
    const logged: Record<string, unknown>[] = [];
    const receive = createJourneyReceiver({ env: { VERCEL_ENV: 'preview' }, account: () => 'acct-1', log: fields => logged.push(fields) });
    const inflated = { ...event(), userMs: 9_999, systemMs: 1 };
    expect((await receive(post(JSON.stringify(inflated)))).status).toBe(204);
    expect(logged[0]).toMatchObject({ user_ms: 250, system_ms: 250, deployment: 'preview' });
    expect((await receive(post(JSON.stringify(inflated)))).status).toBe(409);
    let n = 0;
    const quoteOnly = createJourney({ operation: 'bridge', network: 'eip155:84532', clock: () => (n += 100) });
    quoteOnly.mark('intent'); quoteOnly.mark('first_quote');
    expect((await receive(post(JSON.stringify(quoteOnly.event('in_progress')))))?.status).toBe(204);
    expect(logged[1]).toMatchObject({ user_ms: null, system_ms: 100, network_environment: 'TESTNET' });
    expect(logged).toHaveLength(2);
  });
  it('writes every journey metric as a number through the real logger (no metric name is caught by its redaction)', async () => {
    const { createLogger } = await import('@defi-workflow-engine/cloud-runtime');
    const lines: string[] = [];
    const receive = createJourneyReceiver({ env: {}, account: () => 'acct-1', log: fields => createLogger({ service: 'flofi-journey', sink: line => lines.push(line) }).info('journey.timing', fields) });
    let n = 0;
    const journey = createJourney({ operation: 'swap', network: 'eip155:8453', provider: 'Uniswap V3', wallet: 'external', clock: () => (n += 100) });
    for (const mark of JOURNEY_MARKS) journey.mark(mark);
    expect((await receive(post(JSON.stringify(journey.event('reconciled')))))?.status).toBe(204);
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    for (const [metric] of JOURNEY_METRICS) expect(typeof line[metric], metric).toBe('number');
    expect(typeof line.user_ms).toBe('number');
    expect(typeof line.system_ms).toBe('number');
    expect(lines[0]).not.toContain('REDACTED');
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
    // Fails closed: anything other than unset or `on` turns logging off (a typo or another convention never leaves it on).
    for (const setting of ['off', 'OFF', ' off ', 'disabled', 'false', '0']) {
      const off = createJourneyReceiver({ env: { FLOFI_JOURNEY_TELEMETRY: setting }, account: () => 'acct-1', log: fields => logged.push(fields) });
      expect((await off(post(JSON.stringify(event())))).status, setting).toBe(204);
    }
    expect(logged).toHaveLength(1);
    const on = createJourneyReceiver({ env: { FLOFI_JOURNEY_TELEMETRY: 'on' }, account: () => 'acct-1', log: fields => logged.push(fields) });
    expect((await on(post(JSON.stringify(event())))).status).toBe(204);
    expect(logged).toHaveLength(2);
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
  type Row = { metric: string; dimension: string; value: string; networkEnvironment?: string; count: number; p50?: number; p95?: number; result?: string;
    scope?: string; timedOut?: number; discoveries?: number };
  type Report = { environment: string; evidence: Record<string, string>; minimumSample: number;
    inputs: { journeys: number; discoveryWindows: number; excludedJourneyLines: { otherDeployment: number; unlabelled: number } }; rows: Row[] };
  // @ts-expect-error -- plain ESM operations script without type declarations (linted; its API is asserted here)
  const load = async () => await import('../../../../scripts/journey-latency-report.mjs') as unknown as {
    summarize: (lines: string[], o: { environment: string; minimum?: number }) => Report; METRICS: readonly string[] };

  it('turns logged journeys into labelled p50/p95, and says INSUFFICIENT_SAMPLE instead of inventing percentiles', async () => {
    const { summarize, METRICS } = await load();
    const { createLogger } = await import('@defi-workflow-engine/cloud-runtime');
    // The report reads exactly the metrics the receiver writes (no drift between the two lists).
    expect([...METRICS]).toEqual([...JOURNEY_METRICS.map(([metric]) => metric), 'user_ms', 'system_ms']);
    const lines: string[] = [];
    const receive = createJourneyReceiver({ env: {}, account: () => 'acct-1', log: fields => createLogger({ service: 'flofi-journey', sink: line => lines.push(line) }).info('journey.timing', fields) });
    for (let i = 0; i < 25; i++) await receive(post(JSON.stringify(event())));
    lines.push('not json');
    const report = summarize(lines, { environment: 'MOCKED' });
    expect(report.environment).toBe('MOCKED');
    // Signed-in senders, but the timings are still the client's word: never upgraded to server-measured evidence.
    expect(report.evidence).toEqual({ journeyTimings: 'CLIENT_REPORTED', quoteDiscovery: 'SERVER_MEASURED' });
    expect(report.rows.find(r => r.metric === 'wallet_open_to_user_decision_ms' && r.dimension === 'all'))
      .toMatchObject({ networkEnvironment: 'MAINNET', count: 25, p50: 250, p95: 250 });
    expect(report.rows.find(r => r.metric === 'wallet_open_to_user_decision_ms' && r.dimension === 'outcome')).toMatchObject({ value: 'in_progress', count: 25 });
    expect(() => summarize(lines, { environment: 'GUESSED' })).toThrow('--environment');
    // The minimum can be raised, never lowered below 20.
    expect(() => summarize(lines, { environment: 'MOCKED', minimum: 1 })).toThrow('--min-sample');
    expect(summarize(lines, { environment: 'MOCKED', minimum: 30 }).rows.find(r => r.metric === 'user_ms' && r.dimension === 'all')).toMatchObject({ count: 25, result: 'INSUFFICIENT_SAMPLE' });
    // Logs from another deployment, or lines without a deployment, are excluded and counted: never relabelled as the requested environment.
    const production = summarize(lines, { environment: 'PRODUCTION' });
    expect(production.inputs.excludedJourneyLines.otherDeployment).toBe(25);
    expect(production.rows.filter(r => r.metric === 'user_ms')).toEqual([]);
  });
  it('counts a journey once, keeps testnet apart from mainnet, and counts one provider answer per discovery with its timeouts', async () => {
    const { summarize } = await load();
    const journey = (id: string, network: string, environment: string, metrics: Record<string, number>) =>
      JSON.stringify({ event: 'journey.timing', deployment: 'production', network_environment: environment, journey_id: id, network, operation: 'swap', outcome: 'reconciled', ...metrics });
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => journey(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 'eip155:8453', 'MAINNET', { intent_to_first_quote_ms: 1_000 })),
      // The same journey reported again (more complete): one sample, the more complete one.
      journey('00000000-0000-4000-8000-000000000000', 'eip155:8453', 'MAINNET', { intent_to_first_quote_ms: 3_000, submission_to_confirmation_ms: 2_000 }),
      journey('00000000-0000-4000-8000-0000000000ff', 'eip155:84532', 'TESTNET', { intent_to_first_quote_ms: 50 }),
      JSON.stringify({ event: 'journey.timing', journey_id: 'x', intent_to_first_quote_ms: 1 }),
      // A provider returning many routes is still one sample; a provider pending at the deadline is a timeout, not a missing row.
      ...Array.from({ length: 3 }, () => JSON.stringify({ event: 'quote.discovery_window', source_chain: 'eip155:8453', destination_chain: 'eip155:42161',
        completeness: 'PARTIAL', asked_providers: 'relay,lifi,mayan', pending_providers: 'mayan', answer_ms_relay: 400, answer_ms_lifi: 900, answer_ms_mayan: null,
        first_executable_ms: 400, duration_ms: 12_000 })),
      ...Array.from({ length: 12 }, () => JSON.stringify({ event: 'quote.provider_result', provider: 'lifi', status: 'EXECUTABLE' })),
    ];
    const report = summarize(lines, { environment: 'PRODUCTION' });
    expect(report.inputs).toMatchObject({ journeys: 21, discoveryWindows: 3, excludedJourneyLines: { otherDeployment: 0, unlabelled: 1 } });
    expect(report.rows.find(r => r.metric === 'intent_to_first_quote_ms' && r.dimension === 'all' && r.networkEnvironment === 'MAINNET'))
      .toMatchObject({ count: 20, p50: 1_000, p95: 1_000 });
    expect(report.rows.find(r => r.metric === 'intent_to_first_quote_ms' && r.dimension === 'all' && r.networkEnvironment === 'TESTNET')).toMatchObject({ count: 1 });
    expect(report.rows.find(r => r.metric === 'provider_answer_ms' && r.value === 'lifi')).toMatchObject({ count: 3, timedOut: 0, scope: 'ANSWERED_WITHIN_WINDOW' });
    expect(report.rows.find(r => r.metric === 'provider_answer_ms' && r.value === 'mayan')).toMatchObject({ count: 0, timedOut: 3, result: 'INSUFFICIENT_SAMPLE' });
    expect(report.rows.find(r => r.metric === 'discovery_first_executable_ms')).toMatchObject({ value: 'eip155:8453>eip155:42161', count: 3, discoveries: 3 });
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
