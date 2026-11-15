// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: the real, bounded and harmless Anthropic probe — the Admin probe's fixed transcript through the production
 * Anthropic transport and FloFi's full validation. It runs only with `pnpm test:copilot-live` and an `ANTHROPIC_API_KEY` in the environment
 * (model: `FLOFI_ANTHROPIC_LIVE_MODEL`, default `claude-sonnet-5-5`); without a key it is SKIPPED, which is not a pass. It offers no tools,
 * touches no workflow, signs and submits nothing, and reports closed metadata only (never the key or the transcript).
 */
import { describe, expect, it } from 'vitest';
import { PROBE_TRANSCRIPT } from '../admin/settings-http';
import { interpretCopilotV2, type CopilotTelemetry } from './copilot-service';
import { anthropicRequestPlan, createAnthropicTransport } from './copilot-providers';

const key = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
const model = process.env.FLOFI_ANTHROPIC_LIVE_MODEL?.trim() || 'claude-sonnet-5-5';

describe.skipIf(!key)('Anthropic live probe (real Messages API, harmless fixed request)', () => {
  for (const reasoningEffort of [null, 'medium'] as const) {
    it(`interprets the probe transcript and passes FloFi validation (effort ${reasoningEffort ?? 'default'})`, async () => {
      const records: CopilotTelemetry[] = [];
      let structure: string | null = null;
      const live = createAnthropicTransport(key);
      const result = await interpretCopilotV2(PROBE_TRANSCRIPT, { mode: 'live', settings: { model, temperature: null, maxOutputTokens: 4096, reasoningEffort },
        transport: async input => { structure = anthropicRequestPlan(JSON.parse(input.body) as Record<string, unknown>).structure.output; return live(input); },
        telemetry: record => records.push(record) });
      console.info('[anthropic-live-probe]', JSON.stringify({ model, reasoningEffort, structure, outcome: records[0]?.outcome, intentKind: records[0]?.intentKind,
        durationMs: records[0]?.durationMs, inputTokens: records[0]?.inputTokens, outputTokens: records[0]?.outputTokens, responseModel: records[0]?.responseModel }));
      expect(result.ok, `probe outcome ${records[0]?.outcome}`).toBe(true);
      expect(structure).toBe('PROMPTED');
    }, 120_000);
  }
});
