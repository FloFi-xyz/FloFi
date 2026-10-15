// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: migration 0012 in the shipped sequence. A populated 0011 database reaches the current schema with the normal runner;
 * 0012 is additive — every earlier table keeps its columns, constraints, indexes and triggers; only one read index is added
 * (automation_evaluations; execution_runs is left untouched so the migration never queues the API's run writes); existing rows survive;
 * a second run applies nothing. (Rolling-deployment behavior and the migration's lock timeout: `rollout.pg.test.ts`.) The database itself enforces the console's invariants: grants
 * are permanent and only move ACTIVE → REVOKED, one ACTIVE grant per wallet, sessions only end once, audit events and settings versions
 * are append-only, settings versions are gapless.
 */
import { describe, expect, it } from 'vitest';
import { assertSchemaCurrent, loadMigrations, migrate, SHIPPED_MIGRATIONS, type Database } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';

async function shape(db: Database): Promise<Record<string, string[]>> {
  const rows = (await db.query<{ table_name: string; item: string }>(`
    SELECT table_name::text, 'column ' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') AS item
      FROM information_schema.columns WHERE table_schema = 'public'
    UNION ALL SELECT conrelid::regclass::text, 'constraint ' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND conrelid <> 0
    UNION ALL SELECT tablename::text, 'index ' || indexname || ' ' || indexdef FROM pg_indexes WHERE schemaname = 'public'
    UNION ALL SELECT event_object_table::text, 'trigger ' || trigger_name || ' ' || action_timing || ' ' || event_manipulation
      FROM information_schema.triggers WHERE trigger_schema = 'public'`)).rows;
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.table_name] ??= []).push(r.item);
  for (const items of Object.values(out)) items.sort();
  return out;
}
const ADMIN_TABLES = ['admin_audit_events', 'admin_principals', 'admin_run_facts', 'admin_sessions', 'admin_settings_versions'];
const ACCOUNT = '0x' + 'ab'.repeat(20), P1 = 'adm_' + 'a'.repeat(26), P2 = 'adm_' + 'b'.repeat(26);
const rejects = (promise: Promise<unknown>, code: string | RegExp) => expect(promise).rejects.toThrow(code);

describe('BUILD-ADMIN-001 migration 0012 (shipped)', () => {
  it('follows 0011 in the gapless shipped sequence and is pinned', async () => {
    const all = await loadMigrations();
    expect(all.map(m => [m.version, m.name]).slice(-2)).toEqual([[11, 'delegated_execution'], [12, 'admin_control_plane']]);
    expect(SHIPPED_MIGRATIONS.at(-1)).toEqual({ version: 12, name: 'admin_control_plane', sha256: all.at(-1)!.sha256 });
  });

  it('upgrades a populated 0011 database additively; only one read index is added to an existing table', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const all = await loadMigrations();
      await migrate(t.db, all.slice(0, 11));
      await t.db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ('default', 'wf-1')`);
      await t.db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256)
        VALUES ('default', 'aave-supply', 'run-1.jsonl', 'RUN', 1, 1, 2, $1)`, ['0'.repeat(64)]);
      await t.db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, needs_observation, has_evidence, log_version)
        VALUES ('default', 'run-1', 'aave-supply', 'run-1.jsonl', 'wf-1', 'aave-supply', 'RECONCILED', 'PUBLIC_TESTNET', false, true, 1)`);
      const before = await shape(t.db);
      expect(await migrate(t.db, all)).toEqual([12]);
      expect(await assertSchemaCurrent(t.db, SHIPPED_MIGRATIONS)).toBe(12);
      expect(await migrate(t.db, all)).toEqual([]);
      const after = await shape(t.db);
      expect(Object.keys(after).filter(name => !(name in before)).sort()).toEqual(ADMIN_TABLES);
      for (const [table, items] of Object.entries(before)) {
        const added = after[table]!.filter(item => !items.includes(item)), removed = items.filter(item => !after[table]!.includes(item));
        expect(removed, table).toEqual([]);
        expect(added, table).toEqual(table === 'automation_evaluations'
          ? ['index automation_evaluations_at CREATE INDEX automation_evaluations_at ON public.automation_evaluations USING btree (tenant_id, at)'] : []);
      }
      expect((await t.db.query(`SELECT status FROM execution_runs WHERE run_id = 'run-1'`)).rows).toEqual([{ status: 'RECONCILED' }]);
    } finally { await t.drop(); }
  });

  it('enforces the console invariants in the database', async () => {
    const t = await createTestDatabase();
    try {
      const db = t.db;
      const grant = (principal: string, account = ACCOUNT, role = 'OPERATOR') => db.query(`INSERT INTO admin_principals (tenant_id, principal_id, namespace, account, role,
        state, granted_by) VALUES ('default', $1, 'eip155', $2, $3, 'ACTIVE', 'cli')`, [principal, account, role]);
      await grant(P1);
      await rejects(grant(P2), /admin_principals_active_account/);
      await rejects(db.query(`INSERT INTO admin_principals (tenant_id, principal_id, namespace, account, role, state, granted_by)
        VALUES ('default', $1, 'eip155', $2, 'OWNER', 'ACTIVE', 'cli')`, [P2, '0x' + 'cd'.repeat(20)]), /admin_principals_role_check/);
      await rejects(db.query(`INSERT INTO admin_principals (tenant_id, principal_id, namespace, account, role, state, granted_by)
        VALUES ('default', $1, 'eip155', $2, 'VIEWER', 'ACTIVE', 'console')`, [P2, '0x' + 'cd'.repeat(20)]), /admin_principals_granted_by_check/);
      await rejects(db.query(`UPDATE admin_principals SET role = 'VIEWER' WHERE principal_id = $1`, [P1]), 'ADMIN_PRINCIPAL_IMMUTABLE');
      await rejects(db.query(`UPDATE admin_principals SET account = $2 WHERE principal_id = $1`, [P1, '0x' + 'cd'.repeat(20)]), 'ADMIN_PRINCIPAL_IMMUTABLE');
      await rejects(db.query(`DELETE FROM admin_principals WHERE principal_id = $1`, [P1]), 'ADMIN_PRINCIPAL_PERMANENT');

      await db.query(`INSERT INTO admin_sessions (tenant_id, session_id, principal_id, expires_at) VALUES ('default', $1, $2, now() + interval '4 hours')`, ['a'.repeat(32), P1]);
      await rejects(db.query(`INSERT INTO admin_sessions (tenant_id, session_id, principal_id, expires_at) VALUES ('default', $1, $2, now() + interval '13 hours')`,
        ['b'.repeat(32), P1]), /admin_sessions_check/);
      await rejects(db.query(`INSERT INTO admin_sessions (tenant_id, session_id, principal_id, expires_at) VALUES ('default', $1, $2, now() + interval '1 hour')`,
        ['a'.repeat(32), P1]), /admin_sessions_pkey/);
      await rejects(db.query(`UPDATE admin_sessions SET expires_at = now() + interval '5 hours' WHERE session_id = $1`, ['a'.repeat(32)]), 'ADMIN_SESSION_IMMUTABLE');
      await db.query(`UPDATE admin_sessions SET ended_at = now(), end_reason = 'SIGNED_OUT' WHERE session_id = $1`, ['a'.repeat(32)]);
      await rejects(db.query(`UPDATE admin_sessions SET ended_at = now(), end_reason = 'REVOKED' WHERE session_id = $1`, ['a'.repeat(32)]), 'ADMIN_SESSION_IMMUTABLE');
      await rejects(db.query(`DELETE FROM admin_sessions`), 'ADMIN_SESSION_PERMANENT');

      await db.query(`UPDATE admin_principals SET state = 'REVOKED', revoked_at = now() WHERE principal_id = $1`, [P1]);
      await rejects(db.query(`UPDATE admin_principals SET state = 'ACTIVE', revoked_at = NULL WHERE principal_id = $1`, [P1]), 'ADMIN_PRINCIPAL_TRANSITION_INVALID');
      await grant(P2); // a revoked grant frees the wallet for a new principal

      await db.query(`INSERT INTO admin_audit_events (tenant_id, actor, kind, outcome) VALUES ('default', 'cli', 'ADMIN_PRINCIPAL_GRANTED', 'OK')`);
      await rejects(db.query(`UPDATE admin_audit_events SET outcome = 'FAILED'`), 'APPEND_ONLY_VIOLATION');
      await rejects(db.query(`DELETE FROM admin_audit_events`), 'APPEND_ONLY_VIOLATION');
      await rejects(db.query(`INSERT INTO admin_audit_events (tenant_id, actor, kind, outcome) VALUES ('default', '0xabc', 'X_Y_Z', 'OK')`), /admin_audit_events_actor_check/);

      const version = (v: number, document: string | null = '{"schema":"x"}', restored: number | null = null) => db.query(`INSERT INTO admin_settings_versions
        (tenant_id, setting_key, version, document, restored_from, created_by) VALUES ('default', 'copilot', $1, $2::jsonb, $3, $4)`, [v, document, restored, P2]);
      await rejects(version(2), 'ADMIN_SETTINGS_VERSION_CONFLICT');
      await version(1);
      await rejects(version(1), /ADMIN_SETTINGS_VERSION_CONFLICT|admin_settings_versions_pkey/);
      await version(2, null);
      await version(3, '{"schema":"x"}', 1);
      await rejects(version(4, '{"schema":"x"}', 4), /admin_settings_versions_check/);
      await rejects(db.query(`UPDATE admin_settings_versions SET document = NULL`), 'APPEND_ONLY_VIOLATION');
      await rejects(db.query(`DELETE FROM admin_settings_versions`), 'APPEND_ONLY_VIOLATION');
      await rejects(db.query(`INSERT INTO admin_settings_versions (tenant_id, setting_key, version, created_by) VALUES ('default', 'openai_api_key', 1, 'cli')`),
        /admin_settings_versions_setting_key_check/);

      await rejects(db.query(`INSERT INTO admin_run_facts (tenant_id, run_id, indexer_version, indexed_log_version, state) VALUES ('default', 'r', 1, 1, 'UNINDEXABLE')`),
        /admin_run_facts_check/);
      await db.query(`INSERT INTO admin_run_facts (tenant_id, run_id, indexer_version, indexed_log_version, state, code) VALUES ('default', 'r', 1, 1, 'UNINDEXABLE', 'LOG_MISSING')`);
      await rejects(db.query(`INSERT INTO admin_run_facts (tenant_id, run_id, indexer_version, indexed_log_version, state, skipped_nodes) VALUES ('default', 's', 1, 1, 'INDEXED', -1)`),
        /admin_run_facts_skipped_nodes_check/);
      await db.query(`DELETE FROM admin_run_facts`); // a derived cache: rebuildable by design
    } finally { await t.drop(); }
  });
});
