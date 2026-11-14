// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ADMIN-AI-PROVIDERS-001: the at-a-glance status is derived only from existing probes and never reads a total outage as healthy. */
import { describe, expect, it } from 'vitest';
import { copilotStatus, healthAttention, healthStatus } from './attention.ts';
import type { CopilotSettingsView } from './copilot-view.ts';
import type { HealthReport } from './health.ts';

const healthy: HealthReport = { checkedAt: '2026-11-14T00:00:00.000Z',
  database: { ok: true, value: { latencyMs: 12, appliedMigrations: 15, shippedMigrations: 15, tenantId: 'default' } },
  api: { topology: 'remote', readiness: { ok: true, value: { status: 200, latencyMs: 80 } } },
  queue: { ok: true, value: { ready: 0, overdue: 0, oldestOverdueSeconds: null, leased: 0, expiredLeases: 0, done24h: 9, dead24h: 0, lastCompletedAt: null, byKind: [] } },
  runs: { ok: true, value: { observing: 0, oldestObservationSeconds: null, attention: 0 } },
  scheduler: { ok: true, value: { installed: true, lastEvaluationAt: null, overdueRules: 0 } }, incidents: [] };
const openai = { provider: 'OPENAI', model: 'gpt-5-mini', temperature: null, reasoningEffort: null, maxOutputTokens: 4096, timeoutMs: 20_000, acknowledgedUnverified: false } as const;
const view = (overrides: Partial<CopilotSettingsView>): CopilotSettingsView => ({ mode: 'live', apiKeyConfigured: true, runtimeEnabled: true, runtimeDisabledReason: null, storeError: null,
  activeVersion: 2, activeSource: 'RUNTIME', activeDocument: null, activeCode: null, environment: null, environmentCode: null,
  effective: (['WEB', 'TELEGRAM', 'WHATSAPP'] as const).map(scope => ({ scope, source: 'RUNTIME' as const, settings: openai, code: null })), history: [], families: [],
  providers: [{ id: 'OPENAI', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', keyConfigured: true, efforts: [], usedBy: ['WEB', 'TELEGRAM', 'WHATSAPP'] },
    { id: 'ANTHROPIC', label: 'Anthropic', keyEnv: 'ANTHROPIC_API_KEY', keyConfigured: false, efforts: [], usedBy: [] }],
  anthropicModels: null, prices: [], pricesChecked: '2026-11-03', console: { billing: '', usage: '', keys: '', pricing: '' }, ...overrides } as CopilotSettingsView);

describe('BUILD-ADMIN-AI-PROVIDERS-001 status at a glance', () => {
  it('reports healthy probes as normal and every failing or slow probe as something to look at', () => {
    expect(healthAttention(healthy)).toEqual([]);
    expect(healthStatus(healthy)).toMatchObject({ tone: 'ok', value: 'Operating normally' });
    const slow = { ...healthy, database: { ok: true as const, value: { ...healthy.database.ok ? healthy.database.value : ({} as never), latencyMs: 900 } } };
    expect(healthAttention(slow).map(item => [item.key, item.tone])).toEqual([['db-slow', 'warn']]);
    const broken: HealthReport = { ...healthy, database: { ok: false, code: 'QUERY_FAILED' }, queue: { ok: true, value: { ...(healthy.queue.ok ? healthy.queue.value : ({} as never)), dead24h: 2 } } };
    expect(healthStatus(broken)).toMatchObject({ tone: 'bad', value: 'Action needed' });
    expect(healthAttention(broken).map(item => item.key)).toEqual(['db', 'dead']);
  });
  it('reads a live Copilot as live only when a channel can be served, and never downgrades a total outage to a warning', () => {
    expect(copilotStatus(view({}))).toMatchObject({ tone: 'ok', value: 'Live · OpenAI', items: [] });
    const none = copilotStatus(view({ effective: (['WEB', 'TELEGRAM', 'WHATSAPP'] as const).map(scope => ({ scope, source: 'ENVIRONMENT' as const, settings: null, code: 'OPENAI_COPILOT_MODEL_MISSING' })) }));
    expect(none).toMatchObject({ tone: 'bad', value: 'Unavailable' });
    expect(none.items.map(item => [item.key, item.tone])).toEqual([['copilot-unconfigured', 'bad']]);
    const claude = { ...openai, provider: 'ANTHROPIC' as const, model: 'claude-sonnet-5-5' };
    const keyless = copilotStatus(view({ effective: [{ scope: 'WEB', source: 'RUNTIME', settings: claude, code: null }, { scope: 'TELEGRAM', source: 'RUNTIME', settings: openai, code: null },
      { scope: 'WHATSAPP', source: 'RUNTIME', settings: openai, code: null }],
      providers: [{ id: 'OPENAI', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', keyConfigured: true, efforts: [], usedBy: ['TELEGRAM', 'WHATSAPP'] },
        { id: 'ANTHROPIC', label: 'Anthropic', keyEnv: 'ANTHROPIC_API_KEY', keyConfigured: false, efforts: [], usedBy: ['WEB'] }] }));
    expect(keyless.tone).toBe('bad');
    expect(keyless.items.map(item => item.key)).toEqual(['copilot-key-ANTHROPIC']);
    expect(copilotStatus(view({ activeCode: 'COPILOT_SETTINGS_SHAPE_INVALID' }))).toMatchObject({ tone: 'bad', value: 'Unavailable' });
    expect(copilotStatus(view({ mode: 'off' }))).toMatchObject({ tone: 'neutral', value: 'Off', items: [] });
  });
});
