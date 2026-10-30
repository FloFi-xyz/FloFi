// SPDX-License-Identifier: AGPL-3.0-only
/** Durable, content-free daily counters. This is operational telemetry, never execution evidence.
 * Client turn reports are separately labelled and can be forged or dropped. No address, request ID,
 * transcript, asset, amount, tool arguments, or client-supplied code is persisted. */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { parseTurnMetrics, type TurnMetrics } from '../domain/intelligence/turn-metrics';
import type { CopilotTelemetry } from './copilot-service';

export type CopilotMetricsHost = { readonly db: Database; readonly tenantId: string };
export type CopilotMetricsMode = 'live' | 'replay';
export const COPILOT_METRICS_RETENTION_DAYS = 90;
type Env = Readonly<Record<string, string | undefined>>;
export function copilotMetricsEnabled(env: Env, mode: CopilotMetricsMode): boolean {
  const setting = env.FLOFI_COPILOT_TELEMETRY?.trim();
  return setting !== 'off' && (mode === 'live' || setting === 'log');
}
const ERRORS = new Set(['COPILOT_BUSY', 'COPILOT_INPUT_INVALID', 'COPILOT_INTENT_INVALID', 'COPILOT_REFUSED', 'COPILOT_REPLAY_INVALID',
  'COPILOT_REPLAY_MISS', 'COPILOT_RESPONSE_INCOMPLETE', 'COPILOT_RESPONSE_INVALID', 'COPILOT_RESPONSE_TOO_LARGE', 'COPILOT_TIMEOUT',
  'COPILOT_TOO_MANY_ACTIONS', 'COPILOT_UNAVAILABLE', 'COPILOT_UPSTREAM_RATE_LIMITED', 'COPILOT_UPSTREAM_REJECTED', 'COPILOT_UPSTREAM_UNAUTHORIZED',
  'COPILOT_UPSTREAM_UNAVAILABLE']);
const COLUMNS = ['duration_ms', 'input_tokens', 'input_samples', 'output_tokens', 'output_samples', 'reasoning_tokens', 'reasoning_samples',
  'tool_calls', 'tool_failures', 'tool_rounds', 'mismatches', 'clarifications', 'repeated_question_reports', 'correction_reports', 'turns_to_proposal',
  'proposals', 'proposal_steps'] as const;
type Counters = Partial<Record<(typeof COLUMNS)[number], number>>;
const counter = (value: unknown, maximum = 10_000_000): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;

async function write(host: CopilotMetricsHost, dims: { surface: 'WEB' | 'CHANNEL'; mode: CopilotMetricsMode; provenance: 'CLIENT' | 'SERVER';
  kind: 'INTERPRETATION' | 'TURN'; outcome: string; model: string }, counters: Counters, now: Date): Promise<void> {
  if (!Number.isFinite(now.getTime())) throw new Error('COPILOT_METRICS_TIME_INVALID');
  const day = now.toISOString().slice(0, 10), oldest = new Date(now.getTime() - (COPILOT_METRICS_RETENTION_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  await host.db.transaction(async tx => {
    // Indexed by the primary key's tenant/day prefix. Retention runs on every accepted write and Admin read.
    await tx.query('DELETE FROM copilot_daily_metrics WHERE tenant_id = $1 AND day < $2::date', [host.tenantId, oldest]);
    const values = [host.tenantId, day, dims.surface, dims.mode, dims.provenance, dims.kind, dims.outcome, dims.model, ...COLUMNS.map(key => counters[key] ?? 0)];
    await tx.query(`INSERT INTO copilot_daily_metrics (tenant_id, day, surface, mode, provenance, kind, outcome, model, events, ${COLUMNS.join(', ')})
      VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, 1, ${COLUMNS.map((_, i) => `$${i + 9}`).join(', ')})
      ON CONFLICT (tenant_id, day, surface, mode, provenance, kind, outcome, model) DO UPDATE SET
        events = copilot_daily_metrics.events + 1, ${COLUMNS.map(key => `${key} = copilot_daily_metrics.${key} + EXCLUDED.${key}`).join(', ')}, updated_at = clock_timestamp()`, values);
  });
}

export async function persistCopilotInterpretation(host: CopilotMetricsHost, record: CopilotTelemetry, now: Date = new Date()): Promise<void> {
  const tokens = (value: unknown) => ({ value: counter(value), known: typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? 1 : 0 });
  const input = tokens(record.inputTokens), output = tokens(record.outputTokens), reasoning = tokens(record.reasoningTokens);
  if (record.event !== 'flofi.copilot.interpret' || record.protocol !== 'v2' || !['live', 'replay'].includes(record.mode) ||
    !['WEB', 'CHANNEL'].includes(record.surface ?? '') || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(record.model)) throw new Error('COPILOT_METRICS_RECORD_INVALID');
  await write(host, { surface: record.surface!, mode: record.mode, provenance: 'SERVER', kind: 'INTERPRETATION',
    outcome: record.outcome === 'OK' ? 'OK' : ERRORS.has(record.outcome) ? record.outcome : 'FAILED', model: record.model },
  { duration_ms: counter(record.durationMs, 3_600_000), input_tokens: input.value, input_samples: input.known, output_tokens: output.value, output_samples: output.known,
    reasoning_tokens: reasoning.value, reasoning_samples: reasoning.known, tool_calls: counter(record.toolCalls, 64), tool_failures: counter(record.toolFailures, 64),
    tool_rounds: counter(record.toolRounds, 16) }, now);
}

export async function persistCopilotTurn(host: CopilotMetricsHost, mode: CopilotMetricsMode, record: TurnMetrics, provenance: 'CLIENT' | 'SERVER', now: Date = new Date()): Promise<void> {
  const parsed = parseTurnMetrics(record);
  if (!parsed || !['live', 'replay'].includes(mode) || (provenance === 'CLIENT' && parsed.surface !== 'WEB') || !['CLIENT', 'SERVER'].includes(provenance))
    throw new Error('COPILOT_METRICS_RECORD_INVALID');
  const proposal = parsed.outcome === 'PROPOSAL' || parsed.outcome === 'AUTOMATION_PROPOSAL';
  await write(host, { surface: parsed.surface, mode, provenance, kind: 'TURN', outcome: parsed.outcome, model: '' },
  { mismatches: Number(parsed.mismatch), clarifications: Number(parsed.outcome === 'CLARIFICATION'), repeated_question_reports: Number(parsed.repeatedQuestions > 0),
    correction_reports: Number(parsed.corrections > 0), turns_to_proposal: proposal ? parsed.turnsInRequest : 0, proposals: Number(proposal),
    proposal_steps: proposal ? parsed.proposalSteps : 0 }, now);
}

/** Preserve the journey on a telemetry outage; the closed failure signal never includes DB errors or data. Awaited by callers. */
export async function recordCopilotMetrics(work: () => Promise<void>, warn: (line: string) => void = line => console.warn(line)): Promise<void> {
  try { await work(); } catch { warn(JSON.stringify({ event: 'flofi.copilot.metrics', outcome: 'FAILED', code: 'COPILOT_METRICS_UNAVAILABLE' })); }
}
