#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: p50/p95 of the end-user journey from FloFi's existing structured logs (no second analytics system).
 *
 *   node scripts/journey-latency-report.mjs --environment PRODUCTION|PREVIEW|LOCAL|MOCKED [--min-sample 20] [file.ndjson ...]   (stdin without files)
 *
 * Reads the JSON lines `createLogger` writes (`journey.timing` from /api/flofi/journey, `quote.discovery_window` from route discovery) and
 * prints, per metric and per breakdown, the sample count and nearest-rank p50/p95. A group below the minimum sample (at least 20; it can be
 * raised, never lowered) prints INSUFFICIENT_SAMPLE instead of a percentile. The environment label is mandatory and copied verbatim; journey
 * lines written by another deployment (their `deployment` field) or without one are excluded and counted, never relabelled. Journey rows are
 * split by the network's registry environment (MAINNET or TESTNET), and a journey reported more than once counts once (its most complete
 * report). Provider answer times count one sample per provider per discovery, and providers still pending when the window closed are
 * counted as timeouts next to those percentiles. Content-free inputs only; other log lines are ignored.
 */
import { createReadStream, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const ENVIRONMENTS = Object.freeze({ PRODUCTION: ['production'], PREVIEW: ['preview'], LOCAL: ['development', 'local'], MOCKED: ['development', 'local'] });
export const MINIMUM_SAMPLE = 20;
/** The journey metrics the receiver logs: `JOURNEY_METRICS` (domain/journey-metrics.ts) plus the two server-recomputed totals. */
export const METRICS = Object.freeze(['intent_to_first_quote_ms', 'intent_to_best_quote_ms', 'quote_to_review_ready_ms', 'review_request_to_ready_ms',
  'review_to_wallet_open_ms', 'authorize_to_wallet_open_ms', 'wallet_open_to_user_decision_ms', 'decision_to_submission_ms', 'submission_to_hash_ms',
  'submission_to_confirmation_ms', 'confirmation_to_reconciliation_ms', 'workflow_total_duration_ms', 'user_ms', 'system_ms']);
const BREAKDOWNS = ['network', 'operation', 'provider', 'wallet', 'outcome'];
const PROVIDER = /^[a-z]{2,16}$/;

export function percentiles(samples, minimum) {
  const values = samples.filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (values.length < minimum) return { count: values.length, result: 'INSUFFICIENT_SAMPLE' };
  const rank = p => values[Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1))];
  return { count: values.length, p50: rank(0.5), p95: rank(0.95) };
}

const measured = record => METRICS.filter(metric => typeof record[metric] === 'number').length;

export function summarize(lines, { environment, minimum = MINIMUM_SAMPLE }) {
  if (!Object.hasOwn(ENVIRONMENTS, environment)) throw new Error('--environment must be PRODUCTION, PREVIEW, LOCAL or MOCKED');
  if (!Number.isSafeInteger(minimum) || minimum < MINIMUM_SAMPLE) throw new Error(`--min-sample must be an integer of at least ${MINIMUM_SAMPLE}`);
  const groups = new Map();
  const group = (metric, dimension, value, extra = {}) => {
    const key = JSON.stringify([metric, dimension, value, extra.networkEnvironment ?? null]);
    if (!groups.has(key)) groups.set(key, { metric, dimension, value, ...extra, samples: [] });
    return groups.get(key);
  };
  const journeys = new Map(), excluded = { otherDeployment: 0, unlabelled: 0 };
  const timeouts = new Map(), routeDiscoveries = new Map();
  let windows = 0;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== 'object') continue;
    if (record.event === 'journey.timing') {
      if (typeof record.deployment !== 'string') { excluded.unlabelled++; continue; }
      if (!ENVIRONMENTS[environment].includes(record.deployment)) { excluded.otherDeployment++; continue; }
      // One journey counts once: keep its most complete report (the later one on a tie).
      const id = typeof record.journey_id === 'string' ? record.journey_id : `line-${journeys.size}`;
      const previous = journeys.get(id);
      if (!previous || measured(record) >= measured(previous)) journeys.set(id, record);
    } else if (record.event === 'quote.discovery_window') {
      windows++;
      const route = `${record.source_chain}>${record.destination_chain}`;
      routeDiscoveries.set(route, (routeDiscoveries.get(route) ?? 0) + 1);
      const asked = String(record.asked_providers ?? '').split(',').filter(p => PROVIDER.test(p));
      const pending = new Set(String(record.pending_providers ?? '').split(','));
      for (const provider of asked) {
        if (pending.has(provider)) timeouts.set(provider, (timeouts.get(provider) ?? 0) + 1);
        else if (typeof record[`answer_ms_${provider}`] === 'number') group('provider_answer_ms', 'provider', provider).samples.push(record[`answer_ms_${provider}`]);
      }
      if (typeof record.first_executable_ms === 'number') group('discovery_first_executable_ms', 'route', route).samples.push(record.first_executable_ms);
      if (typeof record.duration_ms === 'number') group('discovery_total_ms', 'completeness', String(record.completeness ?? 'unknown')).samples.push(record.duration_ms);
    }
  }
  for (const record of journeys.values()) {
    const networkEnvironment = typeof record.network_environment === 'string' ? record.network_environment : 'UNKNOWN';
    for (const metric of METRICS) {
      if (typeof record[metric] !== 'number') continue;
      group(metric, 'all', 'all', { networkEnvironment }).samples.push(record[metric]);
      for (const dimension of BREAKDOWNS) if (typeof record[dimension] === 'string') group(metric, dimension, record[dimension], { networkEnvironment }).samples.push(record[metric]);
    }
  }
  const rows = [...groups.values()].sort((a, b) => a.metric.localeCompare(b.metric) || String(a.networkEnvironment ?? '').localeCompare(String(b.networkEnvironment ?? ''))
    || a.dimension.localeCompare(b.dimension) || a.value.localeCompare(b.value))
    .map(({ samples, ...row }) => ({ ...row, ...percentiles(samples, minimum),
      // Answer times are only the answers that arrived inside the window: the providers' timeouts are counted beside them, never hidden.
      ...row.metric === 'provider_answer_ms' ? { scope: 'ANSWERED_WITHIN_WINDOW', timedOut: timeouts.get(row.value) ?? 0 } : {},
      ...row.metric === 'discovery_first_executable_ms' ? { scope: 'DISCOVERIES_WITH_AN_EXECUTABLE_ROUTE', discoveries: routeDiscoveries.get(row.value) ?? 0 } : {} }));
  for (const [provider, count] of timeouts) if (!groups.has(JSON.stringify(['provider_answer_ms', 'provider', provider, null])))
    rows.push({ metric: 'provider_answer_ms', dimension: 'provider', value: provider, count: 0, result: 'INSUFFICIENT_SAMPLE', scope: 'ANSWERED_WITHIN_WINDOW', timedOut: count });
  // Journey timings come from a signed-in session but are the client's own measurements; discovery timings are measured by the server.
  return { format: 'flofi.journey-latency-report.v2', environment, provenance: 'STRUCTURED_LOGS_AS_SUPPLIED',
    evidence: { journeyTimings: 'CLIENT_REPORTED', quoteDiscovery: 'SERVER_MEASURED' }, minimumSample: minimum,
    inputs: { journeys: journeys.size, discoveryWindows: windows, excludedJourneyLines: excluded }, rows };
}

async function main(argv) {
  const files = [], options = { environment: null, minimum: MINIMUM_SAMPLE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--environment') options.environment = argv[++i];
    else if (argv[i] === '--min-sample') options.minimum = Number(argv[++i]);
    else files.push(argv[i]);
  }
  const lines = [];
  for (const stream of files.length ? files.map(file => createReadStream(file)) : [process.stdin])
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) lines.push(line);
  process.stdout.write(JSON.stringify(summarize(lines, options), null, 2) + '\n');
}

const invoked = (() => { try { return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null; } catch { return null; } })();
if (import.meta.url === invoked) main(process.argv.slice(2)).catch(error => { process.stderr.write(`journey-latency-report: ${error.message}\n`); process.exit(1); });
