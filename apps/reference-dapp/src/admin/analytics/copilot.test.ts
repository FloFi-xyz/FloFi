// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ADMIN-AI-PROVIDERS-001: usage by provider and model folds the daily rows once, and estimates only what was measured and priced. */
import { describe, expect, it } from 'vitest';
import { modelUsage, type CopilotMetricRow } from './copilot.ts';

const row = (model: string, extra: Partial<CopilotMetricRow> = {}): CopilotMetricRow => ({ day: '2026-11-13', surface: 'WEB', provenance: 'SERVER', kind: 'INTERPRETATION', model,
  outcome: 'OK', events: 10, duration_ms: 10_000, input_tokens: 1_000_000, input_samples: 10, output_tokens: 100_000, output_samples: 10, reasoning_tokens: 0, reasoning_samples: 0,
  tool_calls: 0, tool_failures: 0, tool_rounds: 0, mismatches: 0, clarifications: 0, repeated_question_reports: 0, correction_reports: 0, turns_to_proposal: 0, proposals: 0, proposal_steps: 0,
  ...extra });

describe('BUILD-ADMIN-AI-PROVIDERS-001 usage by provider and model', () => {
  it('folds days and outcomes once per model and surface, ignoring client and turn rows', () => {
    const usage = modelUsage([row('claude-sonnet-5-5'), row('claude-sonnet-5-5', { day: '2026-11-12', outcome: 'COPILOT_TIMEOUT', events: 2, input_samples: 0, input_tokens: 0, output_tokens: 0 }),
      row('claude-sonnet-5-5', { surface: 'CHANNEL', events: 1, input_samples: 1, input_tokens: 1000, output_tokens: 100 }), row('gpt-5-mini', { events: 3, input_samples: 3 }),
      row('claude-sonnet-5-5', { provenance: 'CLIENT' }), row('', { kind: 'TURN' })]);
    expect(usage.map(line => [line.provider, line.model, line.surface, line.requests, line.failures, line.usageSamples])).toEqual([
      ['ANTHROPIC', 'claude-sonnet-5-5', 'WEB', 12, 2, 10], ['OPENAI', 'gpt-5-mini', 'WEB', 3, 0, 3], ['ANTHROPIC', 'claude-sonnet-5-5', 'CHANNEL', 1, 0, 1]]);
    expect(usage[0]!.estimatedCostUsd).toBeCloseTo(3, 6);
    expect(usage[0]!.meanLatencyMs).toBe(Math.round(20_000 / 12));
    expect(usage[1]!.estimatedCostUsd).toBeNull();
  });
  it('never attributes replay rows to a provider or a cost', () => {
    expect(modelUsage([row('browser-fixture-model'), row('claude-opus-5-5')], 'replay').map(line => [line.provider, line.estimatedCostUsd])).toEqual([['REPLAY', 0], ['REPLAY', 0]]);
    expect(modelUsage([row('replay')]).map(line => line.provider)).toEqual(['REPLAY']);
  });
});
