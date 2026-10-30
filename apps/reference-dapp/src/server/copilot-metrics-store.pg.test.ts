// SPDX-License-Identifier: AGPL-3.0-only
/** Disposable PostgreSQL: real aggregate concurrency, retention, provenance and tenant boundaries. No provider or wallet calls. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTenant } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { copilotAnalytics } from '../admin/analytics/copilot';
import type { TurnMetrics } from '../domain/intelligence/turn-metrics';
import type { CopilotTelemetry } from './copilot-service';
import { persistCopilotInterpretation, persistCopilotTurn } from './copilot-metrics-store';

let t: TestDatabase;
const at = new Date('2026-10-30T12:00:00Z');
const interpretation: CopilotTelemetry = { event: 'flofi.copilot.interpret', protocol: 'v2', mode: 'live', model: 'configured-model', outcome: 'OK',
  intentKind: 'GOAL', topic: null, durationMs: 500, messages: 1, userTurns: 1, inputTokens: 100, outputTokens: 20, reasoningTokens: null,
  responseModel: 'configured-model-response', surface: 'WEB', toolCalls: 2, toolFailures: 1, toolRounds: 1 };
const turn: TurnMetrics = { event: 'flofi.copilot.turn', version: 1, surface: 'WEB', outcome: 'PROPOSAL', code: null, interpreted: 'GOAL', mismatch: false,
  clarifications: 1, repeatedQuestions: 0, corrections: 1, turnsInRequest: 3, proposalSteps: 2 };
const host = (tenantId = 'default') => ({ db: t.db, tenantId });
beforeAll(async () => { t = await createTestDatabase(); await ensureTenant(t.db, 'other'); });
afterAll(async () => { await t?.drop(); });

describe('durable copilot metrics', () => {
  it('increments atomically across independent DB clients and exposes measured tool/token usage', async () => {
    const peer = t.open(2);
    await Promise.all(Array.from({ length: 12 }, (_, i) => persistCopilotInterpretation({ db: i % 2 ? peer : t.db, tenantId: 'default' }, interpretation, at)));
    const view = await copilotAnalytics(host(), {}, at);
    expect(view).toMatchObject({ interpretations: 12, interpretationFailures: 0, toolCalls: 24, toolFailures: 12, inputTokens: 1200,
      outputTokens: 240, reasoningTokens: 0, tokenSamples: 12 });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ provenance: 'SERVER', kind: 'INTERPRETATION', day: '2026-10-30', events: 12, reasoning_samples: 0 });
    // A new connection sees committed aggregates; nothing depends on an in-process buffer.
    expect((await peer.query('SELECT events::int FROM copilot_daily_metrics WHERE tenant_id=$1', ['default'])).rows).toEqual([{ events: 12 }]);
  });

  it('keeps client reports, server turns, tenants and replay distinct and discards arbitrary client codes', async () => {
    await persistCopilotTurn(host(), 'live', { ...turn, code: 'CLIENT_ENCODED_PRIVATE_DATA' }, 'CLIENT', at);
    await persistCopilotTurn(host(), 'live', { ...turn, surface: 'CHANNEL' }, 'SERVER', at);
    await persistCopilotInterpretation(host(), { ...interpretation, mode: 'replay' }, at);
    await persistCopilotInterpretation(host('other'), { ...interpretation, outcome: 'COPILOT_TIMEOUT' }, at);
    const live = await copilotAnalytics(host(), {}, at), replay = await copilotAnalytics(host(), { mode: 'replay' }, at), other = await copilotAnalytics(host('other'), {}, at);
    expect(live).toMatchObject({ interpretations: 12, proposals: 1, browserProposals: 1 });
    expect(replay).toMatchObject({ interpretations: 1, proposals: 0, browserProposals: 0 });
    expect(other).toMatchObject({ interpretations: 1, interpretationFailures: 1, proposals: 0, browserProposals: 0 });
    expect(JSON.stringify((await t.db.query('SELECT * FROM copilot_daily_metrics')).rows)).not.toMatch(/CLIENT_ENCODED_PRIVATE_DATA|configured-model-response/);
    await expect(persistCopilotTurn(host(), 'live', { ...turn, surface: 'CHANNEL' }, 'CLIENT', at)).rejects.toThrow('COPILOT_METRICS_RECORD_INVALID');
    await expect(persistCopilotTurn(host(), 'live', { ...turn, prompt: 'private' } as TurnMetrics, 'CLIENT', at)).rejects.toThrow('COPILOT_METRICS_RECORD_INVALID');
  });

  it('retains exactly 90 UTC days and limits reads; one tenant cannot purge another', async () => {
    const old = new Date('2026-08-01T23:59:59Z'), oldest = new Date('2026-08-02T00:00:00Z');
    await persistCopilotInterpretation(host(), interpretation, old);
    await persistCopilotInterpretation(host(), interpretation, oldest);
    await persistCopilotInterpretation(host('other'), interpretation, old);
    const view = await copilotAnalytics(host(), { days: '90' }, at);
    expect(view.rows.map(row => row.day)).toContain('2026-08-02');
    expect(view.rows.map(row => row.day)).not.toContain('2026-08-01');
    expect((await t.db.query('SELECT day::text FROM copilot_daily_metrics WHERE tenant_id=$1 AND day=$2::date', ['other', '2026-08-01'])).rows).toHaveLength(1);
    expect((await copilotAnalytics(host(), { days: '9000', mode: 'invented' }, at))).toMatchObject({ days: 30, mode: 'live' });
    await persistCopilotInterpretation(host(), interpretation, at);
    expect((await t.db.query('SELECT 1 FROM copilot_daily_metrics WHERE tenant_id=$1 AND day<$2::date', ['default', '2026-08-02'])).rows).toHaveLength(0);
  });
});
