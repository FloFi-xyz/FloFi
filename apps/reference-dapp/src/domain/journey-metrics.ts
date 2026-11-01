// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: content-free timing of one end-user journey (Build → Quote → Review → wallet → submission → outcome).
 *
 * A journey is a random identifier plus monotonic marks; it carries no address, amount, asset, transaction hash, signature, token, chat text or
 * account identifier. Each metric is the time between two marks of the same journey. The person's own deliberation inside the wallet
 * (`wallet_open_to_user_decision_ms`) is reported separately and is never part of a system-latency figure. Percentiles are computed only from
 * a genuine sample (`summarizeLatency`), never extrapolated.
 */
import { NETWORKS } from './network-registry';
export const JOURNEY_MARKS = Object.freeze(['intent', 'first_quote', 'best_quote', 'review_requested', 'review_ready', 'authorize_clicked', 'wallet_open',
  'user_decision', 'submission', 'hash', 'confirmation', 'reconciliation'] as const);
export type JourneyMark = typeof JOURNEY_MARKS[number];
/**
 * [metric, from, to, kind]. `USER`: the person's own deliberation in the wallet. `SYSTEM`: FloFi's, the network's or a provider's time (summed into
 * `systemMs` unless it overlaps another system interval). `MIXED`: a span that also contains the person's own reading and clicking (reported, never
 * summed as system latency). `TOTAL`: the whole journey.
 */
export const JOURNEY_METRICS = Object.freeze([
  ['intent_to_first_quote_ms', 'intent', 'first_quote', 'SYSTEM'],
  ['intent_to_best_quote_ms', 'intent', 'best_quote', 'OVERLAP'],
  ['quote_to_review_ready_ms', 'first_quote', 'review_ready', 'MIXED'],
  ['review_request_to_ready_ms', 'review_requested', 'review_ready', 'SYSTEM'],
  ['review_to_wallet_open_ms', 'review_ready', 'wallet_open', 'MIXED'],
  ['authorize_to_wallet_open_ms', 'authorize_clicked', 'wallet_open', 'SYSTEM'],
  ['wallet_open_to_user_decision_ms', 'wallet_open', 'user_decision', 'USER'],
  ['authorization_to_submission_ms', 'user_decision', 'submission', 'SYSTEM'],
  ['submission_to_hash_ms', 'submission', 'hash', 'OVERLAP'],
  ['submission_to_confirmation_ms', 'submission', 'confirmation', 'SYSTEM'],
  ['confirmation_to_reconciliation_ms', 'confirmation', 'reconciliation', 'SYSTEM'],
  ['workflow_total_duration_ms', 'intent', 'reconciliation', 'TOTAL'],
] as const);
export type JourneyMetric = typeof JOURNEY_METRICS[number][0];
export const JOURNEY_OPERATIONS = Object.freeze(['swap', 'bridge', 'transfer', 'liquidity', 'lending', 'workflow'] as const);
export const JOURNEY_WALLETS = Object.freeze(['privy-embedded', 'external', 'unknown'] as const);
export const JOURNEY_OUTCOMES = Object.freeze(['reconciled', 'rejected', 'failed', 'inconclusive', 'abandoned', 'in_progress'] as const);
/** The closed, content-free event a journey reports. `network` is a chain reference (e.g. eip155:8453), `provider` a routing provider label. */
export type JourneyEvent = { readonly format: 'flofi.journey-timing.v1'; readonly journeyId: string; readonly operation: typeof JOURNEY_OPERATIONS[number];
  readonly network: string; readonly provider: string | null; readonly wallet: typeof JOURNEY_WALLETS[number]; readonly outcome: typeof JOURNEY_OUTCOMES[number];
  readonly metrics: Partial<Record<JourneyMetric, number>>; readonly userMs: number; readonly systemMs: number };

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Closed vocabularies (no free text): a journey names only one of FloFi's registered networks and a known provider label, so neither field can
// carry an address or any other identifier.
const knownNetwork = (value: unknown) => typeof value === 'string' && NETWORKS.some(network => network.chain === value);
export const JOURNEY_PROVIDERS = Object.freeze(['Uniswap V3', 'Jupiter', 'Orca Whirlpools', 'Bridge', 'Relay', 'LI.FI', 'Mayan', 'Across'] as const);
const knownProvider = (value: unknown) => typeof value === 'string' && (JOURNEY_PROVIDERS as readonly string[]).includes(value);
const MAX_MS = 24 * 3_600_000;

/** One journey's marks (first time wins: a repeated mark never moves a measured boundary). */
export function createJourney(input: { readonly operation: JourneyEvent['operation']; readonly network: string; readonly provider?: string | null;
  readonly wallet?: JourneyEvent['wallet']; readonly clock?: () => number; readonly id?: string }) {
  const clock = input.clock ?? (() => performance.now()), marks = new Map<JourneyMark, number>();
  const journeyId = input.id ?? crypto.randomUUID();
  let provider = input.provider ?? null, wallet = input.wallet ?? 'unknown';
  return {
    journeyId,
    mark(name: JourneyMark, at = clock()) { if (!marks.has(name)) marks.set(name, at); },
    has: (name: JourneyMark) => marks.has(name),
    describe(patch: { readonly provider?: string | null; readonly wallet?: JourneyEvent['wallet'] }) {
      if (patch.provider !== undefined) provider = patch.provider; if (patch.wallet) wallet = patch.wallet;
    },
    /** The content-free event, or null when nothing measurable happened. */
    event(outcome: JourneyEvent['outcome']): JourneyEvent | null {
      const metrics: Partial<Record<JourneyMetric, number>> = {};
      let userMs = 0, systemMs = 0;
      for (const [metric, from, to, kind] of JOURNEY_METRICS) {
        const start = marks.get(from), end = marks.get(to);
        if (start === undefined || end === undefined || end < start || end - start > MAX_MS) continue;
        const ms = Math.round(end - start);
        metrics[metric] = ms;
        if (kind === 'USER') userMs += ms;
        else if (kind === 'SYSTEM') systemMs += ms;
      }
      if (!Object.keys(metrics).length) return null;
      return parseJourneyEvent({ format: 'flofi.journey-timing.v1', journeyId, operation: input.operation, network: input.network,
        provider: knownProvider(provider) ? provider : null, wallet, outcome, metrics, userMs, systemMs });
    },
  };
}
export type Journey = ReturnType<typeof createJourney>;

/** The closed schema every reported event must satisfy (the browser builds it; the server re-validates it). Anything else is null. */
export function parseJourneyEvent(value: unknown): JourneyEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = ['format', 'journeyId', 'operation', 'network', 'provider', 'wallet', 'outcome', 'metrics', 'userMs', 'systemMs'];
  if (Object.keys(v).length !== keys.length || keys.some(key => !(key in v))) return null;
  if (v.format !== 'flofi.journey-timing.v1' || typeof v.journeyId !== 'string' || !ID.test(v.journeyId)) return null;
  if (!(JOURNEY_OPERATIONS as readonly unknown[]).includes(v.operation) || !(JOURNEY_WALLETS as readonly unknown[]).includes(v.wallet)
    || !(JOURNEY_OUTCOMES as readonly unknown[]).includes(v.outcome)) return null;
  if (!knownNetwork(v.network)) return null;
  if (v.provider !== null && !knownProvider(v.provider)) return null;
  const ms = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_MS;
  if (!ms(v.userMs) || !ms(v.systemMs) || !v.metrics || typeof v.metrics !== 'object' || Array.isArray(v.metrics)) return null;
  const names = new Set<string>(JOURNEY_METRICS.map(([metric]) => metric)), metrics = v.metrics as Record<string, unknown>;
  if (!Object.keys(metrics).length || Object.entries(metrics).some(([name, value]) => !names.has(name) || !ms(value))) return null;
  return v as JourneyEvent;
}

/** Nearest-rank percentiles, only from a genuine sample: below `minimum` samples the summary says so instead of inventing a p95. */
export function summarizeLatency(samples: readonly number[], minimum = 20):
  { readonly count: number; readonly p50: number; readonly p95: number } | { readonly count: number; readonly insufficientSample: true } {
  const values = samples.filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (values.length < Math.max(1, minimum)) return { count: values.length, insufficientSample: true };
  const rank = (p: number) => values[Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1))]!;
  return { count: values.length, p50: rank(0.5), p95: rank(0.95) };
}

/** Sends a finished journey without delaying anything (a beacon to the same origin); a browser without beacons simply reports nothing. */
export function reportJourney(event: JourneyEvent | null, send: (url: string, body: string) => boolean = (url, body) =>
  typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' ? navigator.sendBeacon(url, new Blob([body], { type: 'application/json' })) : false): boolean {
  if (!event) return false;
  try { return send('/api/flofi/journey', JSON.stringify(event)); } catch { return false; }
}
