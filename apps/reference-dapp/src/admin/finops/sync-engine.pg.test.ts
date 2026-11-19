// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, createPostgresWorkQueue, ensureTenant, migrate, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { runAdminCommand } from '../cli-commands.ts';
import { addDays, selectRecords, validateEntry, type Period } from './economics.ts';
import { createFinancialSyncEngine, financialSyncEnabled, financialSyncHours, type FinancialProviderId, type FinancialSyncAdapter, type FinancialSyncResult } from './sync-engine.ts';
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
});
