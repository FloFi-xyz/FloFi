// SPDX-License-Identifier: AGPL-3.0-only
/** Tenant-scoped AI operations projection. No execution or financial success is inferred from proposals. */
import { COPILOT_METRICS_RETENTION_DAYS, type CopilotMetricsHost, type CopilotMetricsMode } from '../../server/copilot-metrics-store';
import { estimatedCostUsd } from '../../server/copilot-providers';
import { providerOfModel, type CopilotProvider } from '../../server/copilot-settings';

const COUNTERS = ['events', 'duration_ms', 'input_tokens', 'input_samples', 'output_tokens', 'output_samples', 'reasoning_tokens', 'reasoning_samples',
  'tool_calls', 'tool_failures', 'tool_rounds', 'mismatches', 'clarifications', 'repeated_question_reports', 'correction_reports', 'turns_to_proposal',
  'proposals', 'proposal_steps'] as const;
export type CopilotMetricRow = { readonly day: string; readonly surface: 'WEB' | 'CHANNEL'; readonly provenance: 'CLIENT' | 'SERVER';
  readonly kind: 'INTERPRETATION' | 'TURN'; readonly model: string; readonly outcome: string } & Record<(typeof COUNTERS)[number], number>;
export type CopilotAnalytics = { readonly days: number; readonly mode: CopilotMetricsMode; readonly from: string; readonly to: string;
  readonly rows: readonly CopilotMetricRow[]; readonly interpretations: number; readonly interpretationFailures: number; readonly toolCalls: number; readonly toolFailures: number;
  readonly proposals: number; readonly browserProposals: number; readonly mismatches: number; readonly clarifications: number;
  readonly inputTokens: number; readonly outputTokens: number; readonly reasoningTokens: number; readonly tokenSamples: number;
  /** BUILD-ADMIN-AI-PROVIDERS-001: server interpretations by provider, model and surface, with an estimate where a list price exists. */
  readonly usage: readonly ModelUsage[]; readonly estimatedCostUsd: number | null; readonly unpricedRequests: number };
/**
 * Measured usage of one model on one surface. `estimatedCostUsd` is list price × measured tokens (null without a listed price, or when no
 * request reported usage): an estimate, never billing data. Requests count model interpretations, never proposals or executions.
 */
export type ModelUsage = { readonly provider: CopilotProvider | 'REPLAY'; readonly model: string; readonly surface: 'WEB' | 'CHANNEL'; readonly requests: number;
  readonly failures: number; readonly inputTokens: number; readonly outputTokens: number; readonly usageSamples: number; readonly meanLatencyMs: number | null;
  readonly estimatedCostUsd: number | null };

/** Folds the daily server interpretation rows into one line per provider, model and surface (no row is counted twice). */
export function modelUsage(rows: readonly CopilotMetricRow[]): ModelUsage[] {
  const groups = new Map<string, { model: string; surface: 'WEB' | 'CHANNEL'; requests: number; failures: number; input: number; output: number; samples: number; duration: number }>();
  for (const row of rows) {
    if (row.kind !== 'INTERPRETATION' || row.provenance !== 'SERVER') continue;
    const key = `${row.model}\u0000${row.surface}`, group = groups.get(key) ?? { model: row.model, surface: row.surface, requests: 0, failures: 0, input: 0, output: 0, samples: 0, duration: 0 };
    group.requests += row.events; group.failures += row.outcome === 'OK' ? 0 : row.events; group.input += row.input_tokens; group.output += row.output_tokens;
    group.samples += row.input_samples; group.duration += row.duration_ms;
    groups.set(key, group);
  }
  return [...groups.values()].map((group): ModelUsage => {
    const provider = group.model === 'replay' ? 'REPLAY' as const : providerOfModel(group.model);
    return { provider, model: group.model, surface: group.surface, requests: group.requests, failures: group.failures, inputTokens: group.input, outputTokens: group.output,
      usageSamples: group.samples, meanLatencyMs: group.requests ? Math.round(group.duration / group.requests) : null,
      // Only requests that reported usage can be estimated; the page shows how many did (`usageSamples` of `requests`).
      estimatedCostUsd: provider === 'REPLAY' ? 0 : group.samples ? estimatedCostUsd(group.model, group.input, group.output) : null };
  }).sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
}

export async function copilotAnalytics(host: CopilotMetricsHost, params: { readonly days?: string | undefined; readonly mode?: string | undefined }, now: Date): Promise<CopilotAnalytics> {
  const days = params.days === '7' ? 7 : params.days === '90' ? 90 : 30, mode = params.mode === 'replay' ? 'replay' : 'live';
  const to = new Date(now); to.setUTCHours(0, 0, 0, 0); to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to.getTime() - days * 86_400_000), oldest = new Date(to.getTime() - COPILOT_METRICS_RETENTION_DAYS * 86_400_000);
  // Retention is scoped to this tenant, including periods without new requests.
  await host.db.query('DELETE FROM copilot_daily_metrics WHERE tenant_id = $1 AND day < $2::date', [host.tenantId, oldest.toISOString().slice(0, 10)]);
  const result = await host.db.query<Record<string, unknown>>(`SELECT day::text, surface, provenance, kind, model, outcome, ${COUNTERS.join(', ')} FROM copilot_daily_metrics
    WHERE tenant_id = $1 AND day >= $2::date AND day < $3::date AND mode = $4 ORDER BY day DESC, surface, provenance, kind, model, outcome`,
  [host.tenantId, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10), mode]);
  const rows = result.rows.map(row => ({ ...row, ...Object.fromEntries(COUNTERS.map(key => [key, Number(row[key])])) }) as CopilotMetricRow);
  const interpretations = rows.filter(row => row.kind === 'INTERPRETATION' && row.provenance === 'SERVER'), turns = rows.filter(row => row.kind === 'TURN');
  const sum = (records: readonly CopilotMetricRow[], key: (typeof COUNTERS)[number]) => records.reduce((total, row) => total + row[key], 0);
  return { days, mode, from: from.toISOString(), to: to.toISOString(), rows, interpretations: sum(interpretations, 'events'),
    interpretationFailures: sum(interpretations.filter(row => row.outcome !== 'OK'), 'events'), toolCalls: sum(interpretations, 'tool_calls'), toolFailures: sum(interpretations, 'tool_failures'),
    proposals: sum(turns.filter(row => row.provenance === 'SERVER'), 'proposals'), browserProposals: sum(turns.filter(row => row.provenance === 'CLIENT'), 'proposals'),
    mismatches: sum(turns, 'mismatches'), clarifications: sum(turns, 'clarifications'), inputTokens: sum(interpretations, 'input_tokens'),
    outputTokens: sum(interpretations, 'output_tokens'), reasoningTokens: sum(interpretations, 'reasoning_tokens'), tokenSamples: sum(interpretations, 'input_samples'),
    ...costOf(modelUsage(rows)) };
}
function costOf(usage: readonly ModelUsage[]): { usage: readonly ModelUsage[]; estimatedCostUsd: number | null; unpricedRequests: number } {
  const priced = usage.filter(line => line.estimatedCostUsd !== null);
  return { usage, estimatedCostUsd: priced.length ? priced.reduce((total, line) => total + line.estimatedCostUsd!, 0) : null,
    unpricedRequests: usage.filter(line => line.estimatedCostUsd === null).reduce((total, line) => total + line.requests, 0) };
}
