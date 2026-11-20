// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ADMIN-AI-PROVIDERS-001: the at-a-glance status is derived only from existing probes and never reads a total outage as healthy. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CERTIFIED_FORWARD_MIGRATIONS, SchemaCompatibilityError, schemaCompatibilityState as schemaHealth, SHIPPED_MIGRATIONS, type Database } from '@defi-workflow-engine/cloud-runtime';
import { copilotStatus, healthAttention, healthStatus } from './attention.ts';
import { adminConfig } from './config.ts';
import type { CopilotSettingsView } from './copilot-view.ts';
import { healthReport, type HealthReport } from './health.ts';
import { ADMIN_SESSION_COOKIE, sealAdminSession } from './session.ts';
import type { AttentionCounts } from './support/lifecycle.ts';
import AdminHealthPage from '../app/admin/health/page';

const request = vi.hoisted(() => ({ token: undefined as string | undefined, platformStateHost: vi.fn() }));
vi.mock('../server/platform-state-host.ts', () => ({ platformStateHost: request.platformStateHost }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'flofi.example' }),
  cookies: async () => ({ get: (name: string) => name === ADMIN_SESSION_COOKIE && request.token ? { value: request.token } : undefined }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); }, redirect: (path: string) => { throw new Error(path); } }));

afterEach(() => { request.token = undefined; request.platformStateHost.mockReset(); vi.unstubAllEnvs(); });

function useAdminCookie() {
  vi.stubEnv('FLOFI_ADMIN', 'enabled');
  vi.stubEnv('FLOFI_ADMIN_SESSION_SECRET', randomBytes(32).toString('hex'));
  const config = adminConfig(process.env);
  if (!config.enabled) throw new Error('Expected test admin configuration');
  const reference = { sessionId: 'a'.repeat(32), principalId: 'adm_' + 'a'.repeat(26), domain: 'flofi.example', issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000) };
  request.token = sealAdminSession(config.key, reference);
  return reference;
}

const zero: AttentionCounts = { active: 0, underInvestigation: 0, historical: 0, resolved: 0, activeRealFunds: 0, observationExhausted: 0, notScheduled: 0, unknownOutcome: 0,
  partial: 0, unclassified: 0, evidence: 0, tasks: 0, ownerReviewPending: 0 };
const healthy: HealthReport = { checkedAt: '2026-11-14T00:00:00.000Z',
  database: { ok: true, value: { latencyMs: 12, appliedMigrations: 28, shippedMigrations: 28, tenantId: 'default', schema: 'exact' } },
  api: { topology: 'remote', readiness: { ok: true, value: { status: 200, latencyMs: 80 } } },
  queue: { ok: true, value: { ready: 0, overdue: 0, oldestOverdueSeconds: null, leased: 0, expiredLeases: 0, done24h: 9, dead24h: 0, lastCompletedAt: null, byKind: [] } },
  runs: { ok: true, value: { observing: 0, oldestObservationSeconds: null, flagged: 0, attention: zero, truncated: false, notesOk: true } },
  scheduler: { ok: true, value: { installed: true, lastEvaluationAt: null, overdueRules: 0 } }, incidents: [], incidentsAvailable: true };
const openai = { provider: 'OPENAI', model: 'gpt-5-mini', temperature: null, reasoningEffort: null, maxOutputTokens: 4096, timeoutMs: 20_000, acknowledgedUnverified: false } as const;
const view = (overrides: Partial<CopilotSettingsView>): CopilotSettingsView => ({ mode: 'live', apiKeyConfigured: true, runtimeEnabled: true, runtimeDisabledReason: null, storeError: null,
  activeVersion: 2, activeSource: 'RUNTIME', activeDocument: null, activeCode: null, environment: null, environmentCode: null,
  effective: (['WEB', 'TELEGRAM', 'WHATSAPP'] as const).map(scope => ({ scope, source: 'RUNTIME' as const, settings: openai, code: null })), history: [], families: [],
  providers: [{ id: 'OPENAI', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', keyConfigured: true, efforts: [], usedBy: ['WEB', 'TELEGRAM', 'WHATSAPP'] },
    { id: 'ANTHROPIC', label: 'Anthropic', keyEnv: 'ANTHROPIC_API_KEY', keyConfigured: false, efforts: [], usedBy: [] }],
  anthropicModels: null, prices: [], pricesChecked: '2026-11-03', console: { billing: '', usage: '', keys: '', pricing: '' }, ...overrides } as CopilotSettingsView);

describe('BUILD-ADMIN-AI-PROVIDERS-001 status at a glance', () => {
  it('accepts certified forward migrations and classifies invalid histories independently of the count', () => {
    const shipped = SHIPPED_MIGRATIONS;
    const ahead = [...shipped, ...CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === shipped.length)!.migrations];
    expect(schemaHealth(shipped)).toBe('exact');
    expect(schemaHealth(ahead)).toBe('certified-ahead');
    expect(schemaHealth(shipped.slice(0, -1))).toBe('behind');
    expect(schemaHealth([...ahead.slice(0, -1), { ...ahead.at(-1)!, sha256: 'a'.repeat(64) }])).toBe('uncertified-ahead');
    expect(schemaHealth([{ ...shipped[0]!, sha256: 'a'.repeat(64) }, ...ahead.slice(1)])).toBe('invalid-history');
    expect(schemaHealth(ahead.filter(row => row.version !== shipped.length + 1))).toBe('invalid-history');
    if (!healthy.database.ok) throw new Error('Expected a reachable test database');
    expect(healthAttention({ ...healthy, database: { ok: true, value: { ...healthy.database.value, appliedMigrations: ahead.length,
      schema: schemaHealth(ahead) } } })).toEqual([]);
  });
  it('reports healthy probes as normal and every failing or slow probe as something to look at', () => {
    expect(healthAttention(healthy)).toEqual([]);
    expect(healthStatus(healthy)).toMatchObject({ tone: 'ok', value: 'Operating normally' });
    const slow = { ...healthy, database: { ok: true as const, value: { ...healthy.database.ok ? healthy.database.value : ({} as never), latencyMs: 900 } } };
    expect(healthAttention(slow).map(item => [item.key, item.tone])).toEqual([['db-slow', 'warn']]);
    const broken: HealthReport = { ...healthy, database: { ok: false, code: 'QUERY_FAILED' }, queue: { ok: true, value: { ...(healthy.queue.ok ? healthy.queue.value : ({} as never)), dead24h: 2 } } };
    expect(healthStatus(broken)).toMatchObject({ tone: 'bad', value: 'Action needed' });
    expect(healthAttention(broken).map(item => item.key)).toEqual(['db', 'dead']);
  });
  it('shows only generic startup diagnostics even when a browser has a valid sealed reference', async () => {
    useAdminCookie();
    const token = request.token;
    for (const [state, message, code] of [
      ['behind', 'SCHEMA_NOT_MIGRATED', 'ADMIN_SCHEMA_NOT_CURRENT'],
      ['invalid-history', 'MIGRATION_HISTORY_MISMATCH', 'ADMIN_SCHEMA_NOT_CURRENT'],
      ['uncertified-ahead', 'MIGRATION_HISTORY_MISMATCH', 'ADMIN_SCHEMA_NOT_CURRENT'],
      ['unavailable', 'SCHEMA_NOT_MIGRATED', 'ADMIN_STORE_UNAVAILABLE'],
    ] as const) {
      request.platformStateHost.mockRejectedValue(new SchemaCompatibilityError(message, state, new Error('test diagnosis')));
      request.token = undefined;
      await expect(AdminHealthPage()).resolves.toMatchObject({ props: { code } });
      request.token = token;
      await expect(AdminHealthPage()).resolves.toMatchObject({ props: { code } });
    }
  });
  it('rechecks the live tenant session before returning any health report', async () => {
    const { principalId, sessionId } = useAdminCookie();
    // An ended session or revoked principal is absent from the store even while its cookie remains sealed and unexpired.
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    request.platformStateHost.mockResolvedValue({ db: { query }, tenantId: 'tenant-review' });
    await expect(AdminHealthPage()).rejects.toThrow('/admin/login');
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("s.ended_at IS NULL AND s.expires_at > $4 AND p.state = 'ACTIVE'"),
      ['tenant-review', sessionId, principalId, expect.any(Date)]);
  });
  it('separates stopped-work history failure from a successful empty read and retains the stop code', async () => {
    const completed = new Date('2026-11-10T12:00:00.000Z');
    const incidentRead = vi.fn<() => { rows: Record<string, unknown>[]; rowCount: number }>().mockReturnValue({ rows: [], rowCount: 0 });
    const query = vi.fn(async (text: string) => {
      if (text.includes('schema_migrations')) return { rows: SHIPPED_MIGRATIONS, rowCount: SHIPPED_MIGRATIONS.length };
      if (text.includes("state = 'READY' AND available_at")) return { rows: [{ ready: 0, overdue: 0, leased: 0, expired: 0, done: 0, dead: 0 }], rowCount: 1 };
      if (text.includes("state = 'DEAD' ORDER BY completed_at")) return incidentRead();
      return { rows: [], rowCount: 0 };
    });
    const host = { db: { query } as unknown as Database, tenantId: 'tenant-review' };
    const now = new Date(healthy.checkedAt);
    const getReport = () => healthReport({}, host, now, fetch, Promise.resolve(null));
    const empty = await getReport();
    expect(empty).toMatchObject({ incidentsAvailable: true, incidents: [] });
    expect(healthAttention(empty).map(item => item.key)).not.toContain('incidents');
    incidentRead.mockReturnValue({ rows: [{ kind: 'reconcile', last_error: 'NONCE_CONFLICT_STABLE_OPERATOR_REVIEW private runner detail',
      completed_at: completed, run_id: 'workflow-run-example' }], rowCount: 1 });
    expect(await getReport()).toMatchObject({ incidentsAvailable: true, incidents: [{ kind: 'reconcile', code: 'NONCE_CONFLICT_STABLE_OPERATOR_REVIEW',
      at: completed.toISOString(), run: 'workflow-run-examp' }] });
    incidentRead.mockImplementation(() => { throw new Error('query failed'); });
    const failed = await getReport();
    expect(failed).toMatchObject({ incidentsAvailable: false, incidents: [] });
    expect(healthAttention(failed)).toContainEqual(expect.objectContaining({ key: 'incidents', tone: 'warn' }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("tenant_id = $1 AND state = 'DEAD'"), ['tenant-review']);
  });
  it('BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: alerts on active execution incidents only; historical flags are reported separately, never as healthy-and-verified', () => {
    const runs = (attention: Partial<AttentionCounts>, flagged = 12, truncated = false): HealthReport => ({ ...healthy,
      runs: { ok: true, value: { observing: 2, oldestObservationSeconds: 60, flagged, attention: { ...zero, ...attention }, truncated, notesOk: true } } });
    // The confirmed production shape: 12 flagged runs, of which 2 have active unknown outcomes on mainnet and 10 are historical.
    const production = runs({ active: 2, activeRealFunds: 2, unknownOutcome: 2, observationExhausted: 2, historical: 9, resolved: 1 });
    expect(healthAttention(production)).toEqual([expect.objectContaining({ key: 'attention', tone: 'bad', href: '/admin/support?lifecycle=OPEN',
      title: '2 execution runs with an active incident', detail: '2 outcome unknown · 2 observation exhausted · 2 on mainnet or an unrecognised network' })]);
    const historicalOnly = runs({ historical: 10 }, 10);
    expect(healthAttention(historicalOnly)).toEqual([]);
    expect(healthStatus(historicalOnly)).toMatchObject({ tone: 'ok', detail: expect.stringContaining('10 historical attention flags (not verified resolved)') });
    expect(healthAttention(runs({ active: 1, underInvestigation: 1, tasks: 2 }))[0]).toMatchObject({ tone: 'warn', title: '2 execution runs with an active incident (1 under investigation)' });
    expect(healthAttention(runs({}, 0, true)).map(item => item.key)).toEqual(['attention-partial']);
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
