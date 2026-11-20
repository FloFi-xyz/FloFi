// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, createPostgresWorkQueue, ensureTenant, migrate, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { runAdminCommand } from '../cli-commands.ts';
import { addDays, selectRecords, validateEntry, type Period } from './economics.ts';
import { aiFinancialAdapters } from './sync-ai-providers.ts';
import { circleCiFinancialAdapter } from './sync-circleci.ts';
import { createFinancialSyncEngine, financialSyncEnabled, financialSyncHours, type FinancialProviderId, type FinancialSyncAdapter, type FinancialSyncResult } from './sync-engine.ts';
import { infraFinancialAdapters, RAILWAY_FINANCIAL_PROJECT, RAILWAY_PRODUCTION_ENVIRONMENT } from './sync-infra-providers.ts';
import {
  claimFinancialSync, configureFinancialSync, financialSyncPeriods, finishFinancialSync, queueFinancialSync, readFinancialMeters, readFinancialSync,
} from './sync-store.ts';
import { readLedger, writeLedger } from './store.ts';

let database: TestDatabase;
let tenantIndex = 0;

const envOf = (tenantId: string) => ({ FLOFI_FINOPS_SYNC: 'enabled', FLOFI_FINOPS_BILLING_TENANT: tenantId });
const target = (id: FinancialProviderId, read: FinancialSyncAdapter['read']): FinancialSyncAdapter => ({ id, configured: () => true, read });
const notConfigured = target('anthropic', async () => { throw new Error('unexpected provider read'); });
const meter = (period: Period) => ({ scope: 'circleci' as const, environment: 'production' as const, project: 'FloFi-xyz/FloFi',
  service: 'certification', metric: 'credits', unit: 'credits', amount: '42', period });
const metered = (period: Period): FinancialSyncResult => ({ kind: 'COMPLETE', entries: [], meters: [meter(period)],
  coverage: 'PARTIAL', limitations: ['INVOICE_UNAVAILABLE'] });
const monetary = (period: Period, net = '2.4901'): FinancialSyncResult => ({ kind: 'COMPLETE', entries: [validateEntry({
  start: period.from, end: addDays(period.from, 1), scope: 'openai', source: 'PROVIDER_COST', environment: 'production', reference: 'OpenAI Costs',
  currency: 'USD', coverage: 'FULL', net,
}, true)], meters: [], coverage: 'FULL', limitations: [] });

function engine(tenantId: string, adapters: readonly FinancialSyncAdapter[], env = envOf(tenantId)) {
  return createFinancialSyncEngine({ host: { tenantId, db: database.db }, env, adapters,
    fetcher: async () => { throw new Error('unexpected fetch outside fixture'); } });
}
async function host() {
  const tenantId = 'finops-fixture-' + (++tenantIndex);
  await ensureTenant(database.db, tenantId);
  return { tenantId, db: database.db };
}
async function due(tenant: string, id?: FinancialProviderId) {
  await database.db.query(`UPDATE finops_sync_jobs SET next_run_at = clock_timestamp() - interval '1 second'
    WHERE tenant_id = $1 AND ($2::text IS NULL OR provider = $2)`, [tenant, id ?? null]);
}

async function plan(tenant: Awaited<ReturnType<typeof host>>, id: FinancialProviderId, periods: readonly { period: Period; historical: boolean }[]) {
  await configureFinancialSync(tenant, [id]);
  await tenant.db.query(`UPDATE finops_sync_jobs SET next_run_at = clock_timestamp() - interval '1 second',
    cycle_started_at = clock_timestamp(), periods = $3::jsonb WHERE tenant_id = $1 AND provider = $2`,
  [tenant.tenantId, id, JSON.stringify(periods)]);
}

beforeAll(async () => { database = await createTestDatabase({ migrated: false }); await migrate(database.db); });
afterAll(async () => { await database?.drop(); });

describe('autonomous Financial Sync on disposable PostgreSQL', () => {
  it('certifies exact forward migration and leaves schema 29 available before controlled activation', async () => {
    const defaultHost = { tenantId: 'default', db: database.db };
    const openai = vi.fn<FinancialSyncAdapter['read']>(async ({ period }) => monetary(period));
    const worker = engine('default', [target('openai', openai)]);
    await expect(runAdminCommand('finops-sync-migrate', {}, database.db, 'default')).rejects.toThrow('FINOPS_LEDGER_NOT_MIGRATED');
    expect(await runAdminCommand('finops-migrate', {}, database.db, 'default')).toEqual({ applied: [29] });
    expect(await assertSchemaCompatible(database.db, SHIPPED_MIGRATIONS)).toMatchObject({ version: 29 });
    expect(await worker.runOnce()).toBe(false);
    expect(openai).not.toHaveBeenCalled();
    expect(await readFinancialSync(defaultHost)).toEqual({ available: false, providers: [] });
    await expect(queueFinancialSync(defaultHost, 'cli', 'all')).rejects.toThrow('FINOPS_SYNC_SCHEMA_REQUIRED');
    expect(await runAdminCommand('finops-sync-migrate', {}, database.db, 'default')).toEqual({ applied: [30] });
    const applied = await assertSchemaCompatible(database.db, SHIPPED_MIGRATIONS);
    expect(applied).toMatchObject({ version: 30, application: 28, forward: [{ version: 29 }, { version: 30 }] });
    expect(await runAdminCommand('finops-sync-migrate', {}, database.db, 'default')).toEqual({ applied: [] });
    expect(await runAdminCommand('finops-migrate', {}, database.db, 'default')).toEqual({ applied: [] });
    expect(await migrate(database.db)).toEqual([]);
    expect(await worker.runOnce()).toBe(true);
    expect(openai).toHaveBeenCalledTimes(1);
    const certificate = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
    const before0030 = [{ ...certificate, migrations: certificate.migrations.slice(0, 1) }];
    await expect(assertSchemaCompatible(database.db, SHIPPED_MIGRATIONS, before0030)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    const path = new URL('../../../../../packages/cloud-runtime/test/fixtures/0030_finops_sync.sql', import.meta.url);
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(certificate.migrations[1]!.sha256);
  });

  it('plans closed UTC billing windows and only refreshes recently closed periods when due', () => {
    const nov18 = new Date('2026-11-18T17:00:00Z');
    expect(financialSyncPeriods(nov18, null)).toEqual([
      { period: { from: '2026-11-01', to: '2026-11-18' }, historical: false },
      { period: { from: '2026-10-01', to: '2026-11-01' }, historical: true },
      { period: { from: '2026-09-01', to: '2026-10-01' }, historical: true },
    ]);
    expect(financialSyncPeriods(nov18, new Date('2026-11-17T23:59:00Z'))).toHaveLength(1);
    expect(financialSyncPeriods(nov18, new Date('2026-11-11T17:00:00Z'))).toHaveLength(2);
    expect(financialSyncPeriods(new Date('2027-01-01T13:00:00Z'), null).map(item => item.period.from)).toEqual(['2026-12-01', '2026-11-01']);
    expect(financialSyncHours({})).toBe(24);
    expect(financialSyncHours({ FLOFI_FINOPS_SYNC_HOURS: '168' })).toBe(168);
    expect(() => financialSyncHours({ FLOFI_FINOPS_SYNC_HOURS: '5' })).toThrow('FINOPS_SYNC_CADENCE_INVALID');
    expect(() => financialSyncHours({ FLOFI_FINOPS_SYNC_HOURS: '169' })).toThrow('FINOPS_SYNC_CADENCE_INVALID');
  });

  it('checkpoints async exports, reclaims an expired lease, and refuses the old worker commit', async () => {
    const h = await host();
    const adapter = vi.fn<FinancialSyncAdapter['read']>(async ({ period, checkpoint }) =>
      checkpoint ? metered(period) : { kind: 'WAIT', checkpoint: 'export-fixture-id', retryAfterMs: 10_000 });
    const a = engine(h.tenantId, [target('circleci', adapter)]);
    expect(await a.runOnce()).toBe(true);
    expect(await a.runOnce()).toBe(false);
    const persisted = await h.db.query<{ checkpoint: string }>('SELECT checkpoint FROM finops_sync_jobs WHERE tenant_id = $1 AND provider = $2', [h.tenantId, 'circleci']);
    expect(persisted.rows[0]?.checkpoint).toBe('export-fixture-id');
    await due(h.tenantId, 'circleci');
    const lost = await claimFinancialSync(h, ['circleci'], 24);
    expect(lost?.checkpoint).toBe('export-fixture-id');
    await h.db.query(`UPDATE finops_sync_jobs SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE tenant_id = $1 AND provider = $2`, [h.tenantId, 'circleci']);
    const b = engine(h.tenantId, [target('circleci', adapter)]);
    expect(await b.runOnce()).toBe(true);
    const period = lost!.plans[0]!.period;
    expect(adapter).toHaveBeenLastCalledWith(expect.objectContaining({ period, checkpoint: 'export-fixture-id' }));
    const result = metered(period);
    if (result.kind !== 'COMPLETE') throw new Error('fixture must complete');
    expect(await finishFinancialSync(h, lost!, result, 24)).toBe(false);
    expect(await readFinancialMeters(h, 'circleci', period.from)).toEqual([meter(period)]);
    const status = (await readFinancialSync(h)).providers.find(row => row.id === 'circleci');
    expect(status?.coverage).toMatchObject([{ period, quality: 'PARTIAL', meterCount: 1 }]);
  });

  it('keeps other providers and execution-critical lease admission independent of a stalled provider', async () => {
    const h = await host();
    const { promise, resolve } = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const down = vi.fn<FinancialSyncAdapter['read']>(async () => {
      entered.resolve();
      await promise;
      throw new Error('upstream response with private detail');
    });
    const worker = engine(h.tenantId, [target('openai', down), target('circleci', async ({ period }) => metered(period))]);
    await configureFinancialSync(h, ['openai', 'circleci']);
    await h.db.query(`UPDATE finops_sync_jobs SET next_run_at = clock_timestamp() - interval '2 seconds'
      WHERE tenant_id = $1 AND provider = 'openai'`, [h.tenantId]);
    const blocked = worker.runOnce();
    try {
      await entered.promise;
      expect(await worker.runOnce()).toBe(true);
      await h.db.query("INSERT INTO work_items (tenant_id, kind, dedupe_key, state) VALUES ($1, 'workflow-run.advance', 'fixture-run', 'READY')", [h.tenantId]);
      const executionQueue = createPostgresWorkQueue({ db: h.db, ownerId: 'fixture-worker', tenantId: h.tenantId });
      expect(await executionQueue.claim(1, ['workflow-run.advance'])).toHaveLength(1);
    } finally {
      resolve();
      await blocked;
    }
    const { providers } = await readFinancialSync(h);
    const openai = providers.find(p => p.id === 'openai'), circleci = providers.find(p => p.id === 'circleci');
    expect(openai).toMatchObject({ errorCode: 'FINOPS_PROVIDER_UNAVAILABLE', active: true });
    expect(circleci?.coverage).toHaveLength(1);
    expect(JSON.stringify(providers)).not.toContain('private detail');
    expect(new Date(openai!.nextSync!).getTime() - new Date(openai!.lastAttempt!).getTime()).toBeGreaterThanOrEqual(59_000);
  });

  it('deduplicates backfill and manual triggering while preserving invoice precedence and tenant isolation', async () => {
    const h = await host(), other = await host();
    const normalized = vi.fn<FinancialSyncAdapter['read']>(async ({ period }) => monetary(period));
    const worker = engine(h.tenantId, [target('openai', normalized)]);
    expect(await engine(other.tenantId, [target('openai', normalized)], envOf(h.tenantId)).runOnce()).toBe(false);
    expect(financialSyncEnabled({ ...envOf(h.tenantId), VERCEL_ENV: 'preview' }, h.tenantId)).toBe(false);
    for (let index = 0; index < 4; index++) await worker.runOnce();
    const window = financialSyncPeriods(new Date(), null);
    expect(normalized.mock.calls.map(call => call[0].period)).toEqual(window.map(plan => plan.period));
    const first = window[0]!.period.from, range = { from: first, to: addDays(first, 1) };
    expect((await readLedger(h, range)).records).toHaveLength(1);
    expect((await readLedger(other, range)).records).toHaveLength(0);
    await expect(queueFinancialSync(other, 'cli', 'openai')).rejects.toThrow('FINOPS_PROVIDER_NOT_CONFIGURED');
    await expect(queueFinancialSync(h, 'cli', notConfigured.id)).rejects.toThrow('FINOPS_PROVIDER_NOT_CONFIGURED');
    await h.db.query(`UPDATE finops_sync_jobs SET last_attempt_at = clock_timestamp() - interval '6 minutes'
      WHERE tenant_id = $1 AND provider = 'openai'`, [h.tenantId]);
    const queue = await Promise.all([queueFinancialSync(h, 'cli', 'openai'), queueFinancialSync(h, 'cli', 'all')]);
    expect(queue.flatMap(result => result.queued)).toEqual(['openai']);
    expect(queue.flatMap(result => result.deferred)).toEqual(['openai']);
    await worker.runOnce();
    expect((await readLedger(h, range)).records).toHaveLength(1);
    const invoice = validateEntry({ scope: 'openai', environment: 'production', start: range.from, end: range.to,
      source: 'INVOICE', reference: 'Independent accounting', currency: 'USD', net: '1.90', coverage: 'FULL' });
    await writeLedger(h, 'cli', [invoice], { action: 'MANUAL' });
    expect(selectRecords((await readLedger(h, range)).records)).toMatchObject([{ source: 'INVOICE', net: '1.9' }]);
    expect((await readFinancialSync(other)).providers.every(provider => !provider.configured && provider.coverage.length === 0)).toBe(true);
  });

  it('records empty coverage without fabricating costs, and rejects out-of-scope provider data', async () => {
    const h = await host();
    const wrong = engine(h.tenantId, [target('neon', async ({ period }) => monetary(period)),
      target('openai', async () => { throw new Error('FINOPS_PROVIDER_NO_COST_DATA'); })]);
    for (let index = 0; index < 5; index++) await wrong.runOnce();
    const { providers } = await readFinancialSync(h);
    expect(providers.find(provider => provider.id === 'neon')).toMatchObject({ errorCode: 'FINOPS_PROVIDER_RESPONSE_INVALID', coverage: [] });
    const openai = providers.find(provider => provider.id === 'openai')!;
    expect(openai.errorCode).toBe('FINOPS_PROVIDER_NO_DATA');
    expect(openai.coverage.every(snapshot => snapshot.quality === 'UNAVAILABLE' && snapshot.meterCount === 0)).toBe(true);
    expect(await h.db.query('SELECT 1 FROM finops_cost_records WHERE tenant_id = $1', [h.tenantId])).toMatchObject({ rowCount: 0 });
  });

  it('persists separate Anthropic product meters and a single exact provider-cost entry', async () => {
    const h = await host();
    const period = { from: '2026-11-01', to: '2026-11-02' };
    const adapter = aiFinancialAdapters[1];
    const fetcher = vi.fn<typeof fetch>(async request => {
      const cost = new URL(String(request)).pathname.endsWith('/cost');
      const data = ['messages_api', 'message_batches_api'].map(product => ({
        starting_at: period.from + 'T00:00:00Z', ending_at: period.to + 'T00:00:00Z',
        group: { workspace_id: 'wrkspc_fixture', model: 'claude-fixture', product, ...(cost ? { cost_type: 'tokens' } : {}) },
        ...(cost ? { cost: { currency: 'USD', amount: '1.123456' } } : { usage: { requests: 2 } }),
      }));
      return Response.json({ data, data_refreshed_at: period.to + 'T00:00:00Z', has_more: false, next_page: null });
    });
    const worker = createFinancialSyncEngine({ host: h, env: { ...envOf(h.tenantId), FLOFI_FINOPS_ANTHROPIC_ADMIN_KEY: 'fixture-inert',
      FLOFI_FINOPS_ANTHROPIC_WORKSPACE_ID: 'wrkspc_fixture' }, adapters: [adapter], fetcher });
    for (let index = 0; index < 2; index++) {
      await plan(h, 'anthropic', [{ period, historical: false }]);
      expect(await worker.runOnce()).toBe(true);
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect((await readLedger(h, period)).records).toMatchObject([{ scope: 'anthropic', net: '0.02246912', source: 'PROVIDER_COST' }]);
    expect((await readFinancialMeters(h, 'anthropic', period.from)).map(meter => [meter.metric, meter.basis])).toEqual([
      ['provider_cost', 'messages_api:tokens'], ['provider_cost', 'message_batches_api:tokens'],
      ['requests', 'messages_api'], ['requests', 'message_batches_api'],
    ]);
  });

  it('preserves successful Railway usage across empty history and a rate-limited rerun', async () => {
    const h = await host();
    const period = { from: '2026-11-01', to: '2026-11-02' };
    const historical = { from: '2026-10-01', to: '2026-11-01' };
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => Response.json({ data: { usage: [1.2, 3.4].map(value =>
        ({ measurement: 'CPU_USAGE', value, tags: { serviceId: '5379d4b0-ea9d-4775-a369-34fa526968db',
          projectId: RAILWAY_FINANCIAL_PROJECT, environmentId: RAILWAY_PRODUCTION_ENVIRONMENT } })) } }))
      .mockImplementationOnce(async () => Response.json({ data: { usage: [] } }))
      .mockImplementationOnce(async () => Response.json({ errors: [{ message: 'Too many usage queries are running at once. Retry later.' }] }));
    const worker = createFinancialSyncEngine({ host: h, env: { ...envOf(h.tenantId), FLOFI_FINOPS_RAILWAY_API_TOKEN: 'fixture-inert' },
      adapters: [infraFinancialAdapters[1]], fetcher });
    const state = async () => (await readFinancialSync(h)).providers.find(row => row.id === 'railway');
    await plan(h, 'railway', [{ period, historical: false }, { period: historical, historical: true }]);
    expect(await worker.runOnce()).toBe(true);
    const lastSuccess = (await state())?.lastSuccess;
    expect(lastSuccess).not.toBeNull();
    const meters = await readFinancialMeters(h, 'railway', period.from);
    expect(meters).toMatchObject([{ scope: 'railway-worker', metric: 'CPU_USAGE', amount: '4.6' },
      { scope: 'railway-worker', metric: 'list_price_estimate', unit: 'USD' }]);
    expect(await worker.runOnce()).toBe(true);
    expect(await state()).toMatchObject({ errorCode: null, lastSuccess, coverage: [
      { period, quality: 'PARTIAL', meterCount: 2 }, { period: historical, quality: 'UNAVAILABLE', meterCount: 0 },
    ] });
    await plan(h, 'railway', [{ period, historical: false }]);
    expect(await worker.runOnce()).toBe(true);
    expect(await state()).toMatchObject({ errorCode: 'FINOPS_PROVIDER_RATE_LIMITED', lastSuccess });
    expect(await readFinancialMeters(h, 'railway', period.from)).toEqual(meters);
    expect((await readLedger(h, period)).records).toEqual([]);
  });

  it('refuses an address-shaped meter basis without writing a snapshot', async () => {
    const h = await host();
    const period = { from: '2026-11-01', to: '2026-11-02' };
    const worker = engine(h.tenantId, [target('circleci', async () => ({ ...metered(period),
      meters: [{ ...meter(period), basis: 'tokens:0x' + 'ab'.repeat(20) }] }))]);
    await plan(h, 'circleci', [{ period, historical: false }]);
    expect(await worker.runOnce()).toBe(true);
    expect((await readFinancialSync(h)).providers.find(row => row.id === 'circleci'))
      .toMatchObject({ errorCode: 'FINOPS_PROVIDER_RESPONSE_INVALID', coverage: [] });
    expect(await readFinancialMeters(h, 'circleci', period.from)).toEqual([]);
  });

  it('keeps the current period status while a historical export polls and then fails', async () => {
    const h = await host();
    const current = { from: '2026-11-01', to: '2026-11-02' }, historical = { from: '2026-10-01', to: '2026-11-01' };
    const read = vi.fn<FinancialSyncAdapter['read']>(async ({ period, checkpoint }) => {
      if (period.from === current.from) throw new Error('FINOPS_PROVIDER_NO_COST_DATA');
      if (!checkpoint) return { kind: 'WAIT', checkpoint: 'historical-export', retryAfterMs: 0 };
      throw new Error('FINOPS_PROVIDER_EXPORT_FAILED');
    });
    const worker = engine(h.tenantId, [target('circleci', read)]);
    const state = async () => (await readFinancialSync(h)).providers.find(row => row.id === 'circleci')!;
    await plan(h, 'circleci', [{ period: current, historical: false }, { period: historical, historical: true }]);
    expect(await worker.runOnce()).toBe(true);
    expect(await state()).toMatchObject({ errorCode: 'FINOPS_PROVIDER_NO_DATA', lastSuccess: null, active: true });
    expect(await worker.runOnce()).toBe(true);
    // Polling the historical export must not clear the current period's error.
    expect(await state()).toMatchObject({ errorCode: 'FINOPS_PROVIDER_NO_DATA', active: true });
    await due(h.tenantId, 'circleci');
    expect(await worker.runOnce()).toBe(true);
    // Nor may its failure replace it: the historical period records the failure as its own coverage gap instead.
    expect(await state()).toMatchObject({ errorCode: 'FINOPS_PROVIDER_NO_DATA', lastSuccess: null, active: false, coverage: [
      { period: current, quality: 'UNAVAILABLE', meterCount: 0 },
      { period: historical, quality: 'UNAVAILABLE', meterCount: 0, limitations: ['FINOPS_PROVIDER_EXPORT_FAILED'] },
    ] });
    expect(read.mock.calls.map(([input]) => [input.period.from, input.checkpoint]))
      .toEqual([[current.from, null], [historical.from, null], [historical.from, 'historical-export']]);
  });

  it('shows an account-wide refusal met by a historical-only cycle and keeps good historical data over a later failure', async () => {
    const h = await host();
    const historical = { from: '2026-10-01', to: '2026-11-01' };
    let failure: string | null = null;
    const worker = engine(h.tenantId, [target('circleci', async ({ period }) => {
      if (failure) throw new Error(failure);
      return metered(period);
    })]);
    const state = async () => (await readFinancialSync(h)).providers.find(row => row.id === 'circleci')!;
    await plan(h, 'circleci', [{ period: historical, historical: true }]);
    expect(await worker.runOnce()).toBe(true);
    const good = await readFinancialMeters(h, 'circleci', historical.from);
    expect(good).toHaveLength(1);
    // A period-specific failure leaves the good snapshot and the provider status as they were.
    failure = 'FINOPS_PROVIDER_RESPONSE_INVALID';
    await plan(h, 'circleci', [{ period: historical, historical: true }]);
    expect(await worker.runOnce()).toBe(true);
    expect(await state()).toMatchObject({ errorCode: null, coverage: [{ period: historical, quality: 'PARTIAL', meterCount: 1 }] });
    expect(await readFinancialMeters(h, 'circleci', historical.from)).toEqual(good);
    // A refused credential is the provider's status even on the 1st of the month, when only historical periods are planned.
    failure = 'FINOPS_PROVIDER_FORBIDDEN';
    await plan(h, 'circleci', [{ period: historical, historical: true }]);
    expect(await worker.runOnce()).toBe(true);
    expect(await state()).toMatchObject({ errorCode: 'FINOPS_PROVIDER_FORBIDDEN', active: false,
      coverage: [{ period: historical, quality: 'PARTIAL', meterCount: 1 }] });
  });

  it('records an abandoned historical lease as its gap without replacing the provider status', async () => {
    const h = await host();
    const current = { from: '2026-11-01', to: '2026-11-02' }, historical = { from: '2026-10-01', to: '2026-11-01' };
    await configureFinancialSync(h, ['circleci']);
    const abandon = (periods: unknown, error: string | null) => h.db.query(`UPDATE finops_sync_jobs SET attempts = 4,
      lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() - interval '1 second', cycle_started_at = clock_timestamp(),
      periods = $3::jsonb, checkpoint = 'stale-export', last_error = $4 WHERE tenant_id = $1 AND provider = $2`,
    [h.tenantId, 'circleci', JSON.stringify(periods), error]);
    const row = async () => (await h.db.query<{ periods: unknown; cycle_started_at: Date | null; checkpoint: string | null; last_error: string | null }>(
      'SELECT periods, cycle_started_at, checkpoint, last_error FROM finops_sync_jobs WHERE tenant_id = $1 AND provider = $2', [h.tenantId, 'circleci'])).rows[0];
    // The reset reads the leased plan from the row as it was before the same statement empties it.
    await abandon([{ period: historical, historical: true }], 'FINOPS_PROVIDER_NO_DATA');
    expect(await claimFinancialSync(h, ['circleci'], 24)).toBeNull();
    expect(await row()).toEqual({ periods: [], cycle_started_at: null, checkpoint: null, last_error: 'FINOPS_PROVIDER_NO_DATA' });
    expect((await readFinancialSync(h)).providers.find(provider => provider.id === 'circleci')!.coverage)
      .toMatchObject([{ period: historical, quality: 'UNAVAILABLE', limitations: ['FINOPS_PROVIDER_UNAVAILABLE'] }]);
    await abandon([{ period: current, historical: false }], null);
    expect(await claimFinancialSync(h, ['circleci'], 24)).toBeNull();
    expect(await row()).toMatchObject({ periods: [], last_error: 'FINOPS_PROVIDER_UNAVAILABLE' });
  });

  it('ends an active cycle when the credential is removed and starts a fresh plan when it returns', async () => {
    const h = await host();
    const period = { from: '2026-11-01', to: '2026-11-02' };
    const read = vi.fn<FinancialSyncAdapter['read']>(async ({ checkpoint }) => checkpoint
      ? metered(period) : { kind: 'WAIT', checkpoint: 'first-export', retryAfterMs: 0 });
    const worker = engine(h.tenantId, [target('circleci', read)]);
    const state = async () => (await readFinancialSync(h)).providers.find(row => row.id === 'circleci')!;
    await plan(h, 'circleci', [{ period, historical: false }]);
    expect(await worker.runOnce()).toBe(true);
    expect(await state()).toMatchObject({ configured: true, active: true });
    await configureFinancialSync(h, []);
    expect(await state()).toMatchObject({ configured: false, active: false });
    await configureFinancialSync(h, ['circleci']);
    const { rows: [job] } = await h.db.query<{ periods: unknown; checkpoint: string | null; cycle_started_at: Date | null }>(
      'SELECT periods, checkpoint, cycle_started_at FROM finops_sync_jobs WHERE tenant_id = $1 AND provider = $2', [h.tenantId, 'circleci']);
    expect(job).toEqual({ periods: [], checkpoint: null, cycle_started_at: null });
  });

  it('retries an unavailable CircleCI download on the same export and preserves previous meters', async () => {
    const h = await host();
    const period = { from: '2026-11-01', to: '2026-11-02' };
    const exportId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const signed = 'https://fixtures.s3.amazonaws.com/export.csv?X-Amz-Credential=fixture&X-Amz-Signature=fixture';
    const csv = ['organization_id,project_id,job_id,job_run_date,job_name,workflow_id,workflow_name,job_run_seconds,resource_class,executor,total_credits,job_build_status',
      '2b3602e4-47d3-420f-97fa-e034c55d919b,bdb424bd-4927-4f7f-a360-d9674a7a66b8,11111111-2222-4333-8444-555555555555,2026-11-01,unit,22222222-2222-4333-8444-555555555555,certification,120,large,docker,25,success'].join('\n');
    let canDownload = true, exportRequests = 0;
    const fetcher = vi.fn<typeof fetch>(async (request, init) => {
      if (String(request) === signed) return canDownload ? new Response(csv) : new Response(null, { status: 404 });
      if (init?.method === 'POST') {
        exportRequests++;
        return Response.json({ usage_export_job_id: exportId, state: 'created' });
      }
      expect(String(request)).toMatch(new RegExp('/' + exportId + '$'));
      return Response.json({ usage_export_job_id: exportId, state: 'completed', download_urls: [signed] });
    });
    const worker = createFinancialSyncEngine({ host: h, env: { ...envOf(h.tenantId), FLOFI_FINOPS_CIRCLECI_BILLING_TOKEN: 'fixture-inert' },
      adapters: [circleCiFinancialAdapter], fetcher });
    await plan(h, 'circleci', [{ period, historical: false }]);
    expect(await worker.runOnce()).toBe(true);
    await due(h.tenantId, 'circleci');
    expect(await worker.runOnce()).toBe(true);
    const meters = await readFinancialMeters(h, 'circleci', period.from);
    expect(meters).toContainEqual(expect.objectContaining({ metric: 'total_credits', amount: '25' }));
    await plan(h, 'circleci', [{ period, historical: false }]);
    expect(await worker.runOnce()).toBe(true);
    canDownload = false;
    await due(h.tenantId, 'circleci');
    expect(await worker.runOnce()).toBe(true);
    const sync = (await readFinancialSync(h)).providers.find(row => row.id === 'circleci');
    expect(sync).toMatchObject({ errorCode: 'FINOPS_PROVIDER_RETRY_LATER', active: true });
    expect(await readFinancialMeters(h, 'circleci', period.from)).toEqual(meters);
    canDownload = true;
    await due(h.tenantId, 'circleci');
    expect(await worker.runOnce()).toBe(true);
    expect(exportRequests).toBe(2);
    expect(await readFinancialMeters(h, 'circleci', period.from)).toEqual(meters);
    expect((await readLedger(h, period)).records).toEqual([]);
  });
});
