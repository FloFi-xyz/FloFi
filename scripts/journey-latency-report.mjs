#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: p50/p95 of the end-user journey from FloFi's existing structured logs (no second analytics system).
 *
 *   node scripts/journey-latency-report.mjs --environment PRODUCTION|PREVIEW|LOCAL|MOCKED [--min-sample 20] [file.ndjson ...]   (stdin without files)
 *
 * Reads the JSON lines `createLogger` writes (`journey.timing` from /api/flofi/journey, `quote.provider_result` and `quote.discovery_window` from
 * route discovery) and prints, per metric and per breakdown (network, operation, provider, wallet), the sample count and nearest-rank p50/p95.
 * A group below the minimum sample prints INSUFFICIENT_SAMPLE instead of a percentile. The environment label is mandatory and is copied into the
 * report verbatim: this script cannot tell where the logs came from, so it never upgrades MOCKED or LOCAL evidence. Content-free inputs only;
 * other log lines are ignored.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const ENVIRONMENTS = new Set(['PRODUCTION', 'PREVIEW', 'LOCAL', 'MOCKED']);
const METRICS = ['intent_to_first_quote_ms', 'intent_to_best_quote_ms', 'quote_to_review_ready_ms', 'review_request_to_ready_ms', 'review_to_wallet_open_ms',
  'authorize_to_wallet_open_ms', 'wallet_open_to_user_decision_ms', 'authorization_to_submission_ms', 'submission_to_hash_ms', 'submission_to_confirmation_ms',
  'confirmation_to_reconciliation_ms', 'workflow_total_duration_ms', 'user_ms', 'system_ms'];

export function percentiles(samples, minimum) {
  const values = samples.filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (values.length < minimum) return { count: values.length, result: 'INSUFFICIENT_SAMPLE' };
  const rank = p => values[Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1))];
  return { count: values.length, p50: rank(0.5), p95: rank(0.95) };
}

export function summarize(lines, { environment, minimum = 20 }) {
  if (!ENVIRONMENTS.has(environment)) throw new Error('--environment must be PRODUCTION, PREVIEW, LOCAL or MOCKED');
  const groups = new Map();
  const add = (metric, dimension, value, ms) => {
    const key = `${metric}\u0000${dimension}\u0000${value}`;
    if (!groups.has(key)) groups.set(key, { metric, dimension, value, samples: [] });
    groups.get(key).samples.push(ms);
  };
  let journeys = 0, providerResults = 0, windows = 0;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== 'object') continue;
    if (record.event === 'journey.timing') {
      journeys++;
      for (const metric of METRICS) {
        if (typeof record[metric] !== 'number') continue;
        add(metric, 'all', 'all', record[metric]);
        for (const dimension of ['network', 'operation', 'provider', 'wallet']) if (typeof record[dimension] === 'string') add(metric, dimension, record[dimension], record[metric]);
      }
    } else if (record.event === 'quote.provider_result' && typeof record.duration_ms === 'number') {
      providerResults++;
      add('provider_answer_ms', 'provider', `${record.provider ?? 'unknown'} ${record.status ?? ''}`.trim(), record.duration_ms);
    } else if (record.event === 'quote.discovery_window') {
      windows++;
      if (typeof record.first_executable_ms === 'number') add('discovery_first_executable_ms', 'route', `${record.source_chain}>${record.destination_chain}`, record.first_executable_ms);
      if (typeof record.duration_ms === 'number') add('discovery_total_ms', 'completeness', String(record.completeness ?? 'unknown'), record.duration_ms);
    }
  }
  const rows = [...groups.values()].sort((a, b) => a.metric.localeCompare(b.metric) || a.dimension.localeCompare(b.dimension) || a.value.localeCompare(b.value))
    .map(group => ({ metric: group.metric, dimension: group.dimension, value: group.value, ...percentiles(group.samples, minimum) }));
  return { format: 'flofi.journey-latency-report.v1', environment, provenance: 'STRUCTURED_LOGS_AS_SUPPLIED', minimumSample: minimum,
    inputs: { journeys, providerResults, discoveryWindows: windows }, rows };
}

async function main(argv) {
  const files = [], options = { environment: null, minimum: 20 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--environment') options.environment = argv[++i];
    else if (argv[i] === '--min-sample') options.minimum = Number(argv[++i]);
    else files.push(argv[i]);
  }
  if (!Number.isSafeInteger(options.minimum) || options.minimum < 1) throw new Error('--min-sample must be a positive integer');
  const lines = [];
  for (const stream of files.length ? files.map(file => createReadStream(file)) : [process.stdin])
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) lines.push(line);
  process.stdout.write(JSON.stringify(summarize(lines, options), null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).catch(error => { process.stderr.write(`journey-latency-report: ${error.message}\n`); process.exit(1); });
