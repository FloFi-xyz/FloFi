// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createJourney, journeyNetworkEnvironment, journeyTotals, parseJourneyEvent, reportJourney, summarizeLatency } from './journey-metrics';

describe('BUILD-FLOFI-EXECUTION-PERFORMANCE-001 journey metrics', () => {
  it('measures each stage from marks, keeps the person\'s wallet deliberation out of system latency, and carries no content', () => {
    let now = 0;
    const journey = createJourney({ operation: 'swap', network: 'eip155:8453', provider: 'Uniswap V3', wallet: 'privy-embedded', clock: () => now });
    const at = (mark: Parameters<typeof journey.mark>[0], ms: number) => { now = ms; journey.mark(mark); };
    at('intent', 0); at('first_quote', 900); at('review_requested', 5_000); at('review_ready', 7_500); at('authorize_clicked', 20_000); at('wallet_open', 20_400);
    at('user_decision', 32_400); at('submission', 32_900); at('hash', 32_900); at('confirmation', 35_000); at('reconciliation', 37_000);
    at('intent', 99_999); // a repeated mark never moves a measured boundary
    const event = journey.event('reconciled')!;
    expect(event.metrics).toEqual({ intent_to_first_quote_ms: 900, quote_to_review_ready_ms: 6_600, review_request_to_ready_ms: 2_500, review_to_wallet_open_ms: 12_900,
      authorize_to_wallet_open_ms: 400, wallet_open_to_user_decision_ms: 12_000, decision_to_submission_ms: 500, submission_to_hash_ms: 0,
      submission_to_confirmation_ms: 2_100, confirmation_to_reconciliation_ms: 2_000, workflow_total_duration_ms: 37_000 });
    expect(event.userMs).toBe(12_000);
    expect(event.systemMs).toBe(900 + 2_500 + 400 + 500 + 2_100 + 2_000);
    expect(Object.keys(event).sort()).toEqual(['format', 'journeyId', 'metrics', 'network', 'operation', 'outcome', 'provider', 'systemMs', 'userMs', 'wallet']);
    expect(JSON.stringify(event)).not.toMatch(/0x[0-9a-f]{40}|signature|token|amount|authorization/i);
    // Always its own random id (never a correlation, trace, run, session or account id).
    expect(event.journeyId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(createJourney({ operation: 'swap', network: 'eip155:8453' }).journeyId).not.toBe(journey.journeyId);
  });
  it('never reports an unmeasured stage as 0 ms, and names the network\'s registry environment', () => {
    expect(journeyTotals({ intent_to_first_quote_ms: 900 })).toEqual({ userMs: null, systemMs: 900 });
    expect(journeyTotals({ quote_to_review_ready_ms: 900 })).toEqual({ userMs: null, systemMs: null });
    expect(journeyTotals({ wallet_open_to_user_decision_ms: 0 })).toEqual({ userMs: 0, systemMs: null });
    let n = 0;
    const journey = createJourney({ operation: 'swap', network: 'eip155:8453', clock: () => (n += 10) });
    journey.mark('intent'); journey.mark('first_quote');
    expect(journey.event('abandoned')).toMatchObject({ userMs: null, systemMs: 10 });
    expect(journeyNetworkEnvironment('eip155:8453')).toBe('MAINNET');
    expect(journeyNetworkEnvironment('eip155:84532')).toBe('TESTNET');
    expect(journeyNetworkEnvironment('eip155:31337')).toBeNull();
  });
  it('refuses anything outside the closed schema (addresses, free text, unknown metrics, negative or absurd times)', () => {
    const journey = createJourney({ operation: 'swap', network: 'eip155:8453', clock: (() => { let n = 0; return () => (n += 10); })() });
    journey.mark('intent'); journey.mark('first_quote');
    const valid = journey.event('in_progress')!;
    expect(parseJourneyEvent(valid)).toEqual(valid);
    expect(parseJourneyEvent({ ...valid, network: '0x1111111111111111111111111111111111111111' })).toBeNull();
    expect(parseJourneyEvent({ ...valid, provider: 'see https://evil.example' })).toBeNull();
    // Closed vocabularies: an address in the network or provider field is refused, even when shaped like a valid reference.
    expect(parseJourneyEvent({ ...valid, network: 'solana:7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV' })).toBeNull();
    expect(parseJourneyEvent({ ...valid, network: 'eip155:31337' })).toBeNull();
    expect(parseJourneyEvent({ ...valid, provider: '0x1111111111111111111111111111' })).toBeNull();
    expect(parseJourneyEvent({ ...valid, provider: 'Jupiter' })).not.toBeNull();
    expect(parseJourneyEvent({ ...valid, owner: '0x11' })).toBeNull();
    // Only a random (v4) UUID: a run, correlation or other structured id is refused.
    expect(parseJourneyEvent({ ...valid, journeyId: '00000000-0000-1000-8000-000000000001' })).toBeNull();
    expect(parseJourneyEvent({ ...valid, userMs: 'x' })).toBeNull();
    expect(parseJourneyEvent({ ...valid, userMs: null, systemMs: null })).not.toBeNull();
    expect(parseJourneyEvent({ ...valid, metrics: { prompt_length_ms: 1 } })).toBeNull();
    expect(parseJourneyEvent({ ...valid, metrics: { intent_to_first_quote_ms: -1 } })).toBeNull();
    expect(parseJourneyEvent({ ...valid, metrics: { intent_to_first_quote_ms: 1e12 } })).toBeNull();
    expect(createJourney({ operation: 'swap', network: 'eip155:8453' }).event('abandoned')).toBeNull();
  });
  it('computes p50/p95 only from a genuine sample', () => {
    expect(summarizeLatency([1, 2, 3])).toEqual({ count: 3, insufficientSample: true });
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(summarizeLatency(samples)).toEqual({ count: 100, p50: 50, p95: 95 });
    expect(summarizeLatency([...samples, Number.NaN, -5])).toEqual({ count: 100, p50: 50, p95: 95 });
  });
  it('reports through a same-origin beacon and never throws', () => {
    const sent: [string, string][] = [];
    const journey = createJourney({ operation: 'bridge', network: 'eip155:42161', clock: (() => { let n = 0; return () => (n += 5); })() });
    journey.mark('intent'); journey.mark('first_quote');
    expect(reportJourney(journey.event('in_progress'), (url, body) => { sent.push([url, body]); return true; })).toBe(true);
    expect(sent[0]![0]).toBe('/api/flofi/journey');
    expect(reportJourney(null)).toBe(false);
    expect(reportJourney(journey.event('in_progress'), () => { throw new Error('blocked'); })).toBe(false);
  });
});
