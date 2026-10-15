// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the rolling deployment of migration 0012, with the repository's real migration runner, schema checks, admin host and web
 * chat server action. Production deploys three things independently — the Railway API (whose pre-deploy migrates), the Railway worker and
 * Vercel — so for a while the database and a serving build disagree:
 *
 *   before   this build is live, the database is still behind it   → platform state (MCP, Developer, Channels, approvals, /admin) refuses to
 *            open, as for every earlier migration; the web Copilot keeps working on its environment bootstrap (no settings can exist yet);
 *   during   0012 applies while the API writes runs                  → it takes no lock on execution_runs, so no API run write waits for it; a
 *            lock it does need (the automation evaluation history) is waited for at most 5 s, then the migration rolls back entirely
 *            (while it is open, evaluation writes wait for it: the worker's, and the API's automation/delegation owner routes);
 *   after    the previous build still serves                         → it is BUILD-DB-COMPAT-001 (Release A), whose certificate names this exact
 *            0012: warm and cold instances keep serving and its pre-deploy (a rollback) changes nothing; only a build older than Release A
 *            refuses the newer schema on a cold start (`MIGRATION_HISTORY_MISMATCH`);
 *   next     a later migration is applied while this build serves    → this build refuses platform state, but its web Copilot keeps the
 *            administrator's settings (never the environment model, never unavailable); a tampered history still fails closed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, loadMigrations, migrate, SHIPPED_MIGRATIONS, type Database, type Migration } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { resolveCopilotLive } from '../server/copilot-runtime.ts';
import { COPILOT_SETTINGS_SCHEMA } from '../server/copilot-settings.ts';
import { SETTINGS_MIGRATION, webCopilotSettingsReader } from '../server/copilot-settings-source.ts';
import { platformStateHost } from '../server/platform-state-host.ts';
import { adminHost } from './host.ts';

const ADMIN = SHIPPED_MIGRATIONS.findIndex(m => m.name === SETTINGS_MIGRATION); // the migrations before the console: the previous build
const PREVIOUS = SHIPPED_MIGRATIONS.slice(0, ADMIN);
const copilot = { FLOFI_COPILOT: 'live', OPENAI_API_KEY: 'sk-test-not-a-real-key', OPENAI_COPILOT_MODEL: 'gpt-4.1-mini' };
const settings = { schema: COPILOT_SETTINGS_SCHEMA, overrides: {},
  default: { model: 'gpt-5-mini', temperature: null, reasoningEffort: 'low', maxOutputTokens: 6000, timeoutMs: 30_000, acknowledgedUnverified: false } };

let all: readonly Migration[];
const opened: Database[] = [];
/** Platform-state hosts and settings pools are per process; each phase is a cold instance of this build. */
async function coldInstance() {
  const caches = globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>;
  const hosts = caches[Symbol.for('flofi.platform-state')] as Map<string, Promise<{ db: Database }>> | undefined;
  const pools = caches[Symbol.for('flofi.copilot-settings-window')] as Map<string, Database> | undefined;
  for (const host of hosts?.values() ?? []) await host.then(h => h.db.close(), () => undefined);
  for (const pool of pools?.values() ?? []) await pool.close().catch(() => undefined);
  hosts?.clear(); pools?.clear();
}
async function database(applied: number): Promise<TestDatabase> {
  const t = await createTestDatabase({ migrated: false });
  await migrate(t.db, all.slice(0, applied));
  return t;
}
const env = (t: TestDatabase) => ({ ...copilot, DATABASE_URL: t.url, TENANT_ID: 'default' });
const web = (t: TestDatabase) => resolveCopilotLive(env(t), 'WEB', webCopilotSettingsReader(env(t)));
async function chatStatus(t: TestDatabase) {
  for (const [key, value] of Object.entries({ ...env(t), API_BASE_URL: undefined, VERCEL: undefined, FLOFI_RUNTIME: undefined, FLOFI_COPILOT_RUNTIME_CONFIG: undefined }))
    vi.stubEnv(key, value);
  return (await import('../app/copilot-action.ts')).copilotStatus();
}

beforeAll(async () => { all = await loadMigrations(); });
afterEach(async () => { vi.unstubAllEnvs(); await coldInstance(); });
afterAll(async () => { await coldInstance(); await Promise.allSettled(opened.map(db => db.close())); });

describe('BUILD-ADMIN-001 rolling deployment of 0012 (PostgreSQL)', () => {
  it('before the migration: this build refuses platform state, the previous build is fine, and the web Copilot keeps its environment bootstrap', async () => {
    const t = await database(ADMIN);
    try {
      expect(await assertSchemaCurrent(t.db, PREVIOUS)).toBe(ADMIN);
      await expect(assertSchemaCurrent(t.db, SHIPPED_MIGRATIONS)).rejects.toThrow('SCHEMA_NOT_MIGRATED');
      await expect(platformStateHost(env(t))).rejects.toThrow('SCHEMA_NOT_MIGRATED');
      expect(await adminHost(env(t))).toEqual({ code: 'ADMIN_SCHEMA_NOT_CURRENT' });
      // No administrator can have chosen settings before the table exists: the Copilot is exactly what it was before the console.
      expect(await web(t)).toMatchObject({ ok: true, source: 'ENVIRONMENT', version: null, settings: { model: 'gpt-4.1-mini' } });
      expect(await chatStatus(t)).toEqual({ mode: 'live' });
    } finally { await t.drop(); }
  });

  it('during the migration: no API run write waits for it; a lock it needs is waited for at most 5 s, then it rolls back whole and can be retried', async () => {
    const t = await database(ADMIN);
    try {
      await t.db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ('default', 'wf-1')`);
      await t.db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256)
        VALUES ('default', 'aave-supply', 'run-1.jsonl', 'RUN', 1, 1, 2, $1)`, ['0'.repeat(64)]);
      await t.db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, needs_observation, has_evidence, log_version)
        VALUES ('default', 'run-1', 'aave-supply', 'run-1.jsonl', 'wf-1', 'aave-supply', 'PREPARED', 'PUBLIC_TESTNET', false, false, 1)`);
      const rule = 'aut_' + 'a'.repeat(26);
      await t.db.query(`INSERT INTO automation_rules (tenant_id, rule_id, owner_namespace, owner_account, display_name, kind, state, definition, timezone, next_evaluation_at)
        VALUES ('default', $1, 'eip155', $2, 'Watch', 'DAILY_WATCH', 'ACTIVE', '{}', 'UTC', now())`, [rule, '0x' + 'ab'.repeat(20)]);
      const runner = t.open(1), writers = t.open(4);
      opened.push(runner, writers);
      const hold = (sql: string, values: unknown[]) => {
        let release!: () => void, held!: () => void;
        const holding = new Promise<void>(r => { held = r; }), done = writers.transaction(async tx => { await tx.query(sql, values); held(); await new Promise<void>(r => { release = r; }); });
        return { holding, done, release: () => release() };
      };

      // An API transaction that has written a run and is still open: 0012 applies anyway, and other run writes go through meanwhile.
      const api = hold(`UPDATE execution_runs SET status = 'AUTHORIZED', updated_at = now() WHERE tenant_id = 'default' AND run_id = $1`, ['run-1']);
      await api.holding;
      // A worker transaction that has written an evaluation and is still open: the index on that history waits for it, 5 s at most.
      const worker = hold(`INSERT INTO automation_evaluations (tenant_id, rule_id, at, outcome) VALUES ('default', $1, now(), 'CONDITION_NOT_MET')`, [rule]);
      await worker.holding;
      const started = Date.now(), refused = await migrate(runner, all.slice(0, ADMIN + 1)).then(() => 'APPLIED', (e: { code?: string }) => e.code);
      expect(refused).toBe('55P03'); // lock_not_available, from the migration's own lock timeout
      expect(Date.now() - started).toBeLessThan(15_000);
      // Rolled back entirely: still the previous schema, nothing half-created.
      expect(await assertSchemaCurrent(runner, PREVIOUS)).toBe(ADMIN);
      expect((await runner.query(`SELECT to_regclass('public.admin_settings_versions') IS NULL AS absent`)).rows).toEqual([{ absent: true }]);
      worker.release(); await worker.done;

      // Retried, it applies while the API transaction is still open: it never waits for (or queues) a run write.
      expect(await migrate(runner, all.slice(0, ADMIN + 1))).toEqual([ADMIN + 1]);
      api.release(); await api.done;
      expect(await assertSchemaCurrent(runner, SHIPPED_MIGRATIONS.slice(0, ADMIN + 1))).toBe(ADMIN + 1);
    } finally { await t.drop(); }
  });

  it('after the migration: the previous build (Release A) keeps serving and cold-starting, its rollback pre-deploy changes nothing; an older build refuses; this build opens', async () => {
    const t = await database(ADMIN);
    try {
      const warm = t.open(2);
      opened.push(warm);
      expect(await assertSchemaCompatible(warm, PREVIOUS)).toEqual({ version: ADMIN, application: ADMIN, forward: [] }); // started before 0012
      await migrate(t.db, all.slice(0, ADMIN + 1));
      expect((await warm.query(`SELECT count(*)::int AS n FROM execution_runs`)).rows).toEqual([{ n: 0 }]); // additive: it keeps working
      // A previous-build cold start: BUILD-DB-COMPAT-001's certificate names the 0012 this build ships, byte for byte, so it serves.
      expect(await assertSchemaCompatible(t.db, PREVIOUS)).toEqual({ version: ADMIN + 1, application: ADMIN, forward: [SHIPPED_MIGRATIONS[ADMIN]] });
      // Its runner — the pre-deploy of a rollback to it — applies nothing and changes nothing on the newer schema.
      const ledger = async () => (await t.db.query(`SELECT version, name, sha256, applied_at FROM schema_migrations ORDER BY version`)).rows;
      const before = await ledger();
      expect(await migrate(t.db, all.slice(0, ADMIN))).toEqual([]);
      expect(await ledger()).toEqual(before);
      // A build older than Release A checks the exact history only: it refuses on a cold start.
      await expect(assertSchemaCurrent(t.db, PREVIOUS)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
      if (ADMIN + 1 === SHIPPED_MIGRATIONS.length) {
        expect((await platformStateHost(env(t))).tenantId).toBe('default');
        expect(await web(t)).toMatchObject({ ok: true, source: 'ENVIRONMENT', version: null });
      }
    } finally { await t.drop(); }
  });

  it('a later migration while this build serves: platform state refuses, the web Copilot keeps the administrator’s settings; a foreign history fails closed', async () => {
    const t = await database(all.length);
    try {
      await t.db.query(`INSERT INTO admin_settings_versions (tenant_id, setting_key, version, document, created_by) VALUES ('default', 'copilot', 1, $1::jsonb, 'cli')`,
        [JSON.stringify(settings)]);
      await t.db.query(`INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, 'a_later_change', $2)`, [all.length + 1, 'e'.repeat(64)]);
      await expect(platformStateHost(env(t))).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
      expect(await adminHost(env(t))).toEqual({ code: 'ADMIN_SCHEMA_NOT_CURRENT' });
      expect(await web(t)).toMatchObject({ ok: true, source: 'RUNTIME', version: 1, settings: { model: 'gpt-5-mini', reasoningEffort: 'low' } });
      expect(await chatStatus(t)).toEqual({ mode: 'live' });

      // A history this build does not recognize up to the settings migration is never trusted.
      await coldInstance();
      await t.db.query(`UPDATE schema_migrations SET sha256 = $2 WHERE version = $1`, [ADMIN + 1, 'f'.repeat(64)]);
      expect(await web(t)).toEqual({ ok: false, code: 'COPILOT_CONFIG_UNAVAILABLE' });
      expect(await chatStatus(t)).toEqual({ mode: 'unavailable' });
      // The break-glass still ignores the database entirely.
      expect(await resolveCopilotLive({ ...env(t), FLOFI_COPILOT_RUNTIME_CONFIG: 'disabled' }, 'WEB', webCopilotSettingsReader(env(t))))
        .toMatchObject({ ok: true, source: 'ENVIRONMENT', settings: { model: 'gpt-4.1-mini' } });
    } finally { await t.drop(); }
  });
});
