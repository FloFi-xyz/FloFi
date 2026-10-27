// SPDX-License-Identifier: AGPL-3.0-only
/** Release A (schema 15) → 0016 → Release A rollback. REAL disposable PostgreSQL; synthetic records only. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, createPostgresLogStore, ensureTenant, loadMigrations, migrate,
  SHIPPED_MIGRATIONS, type Migration, type Projector } from '../src/index.js';
import { bytes, createTestDatabase, type TestDatabase } from './pg-harness.js';

const opened: TestDatabase[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(t => t.drop())); });
const sha = (sql: string) => createHash('sha256').update(sql).digest('hex');
const fixture = async (): Promise<Migration> => {
  const sql = await readFile(new URL('./fixtures/0016_owner_history_purge.sql', import.meta.url), 'utf8');
  expect(sha(sql)).toBe('a3c258cadd9d7865ad9d36d63ec0921fc47455bb3651c201074f3b0486b4be6f');
  return { version: 16, name: 'owner_history_purge', sql, sha256: sha(sql) };
};
it('certifies cold starts and rollback on 0016, preserves existing bytes and blocks an old writer from resurrecting a deleted identity', async () => {
  const t = await createTestDatabase({ migrated: false }); opened.push(t);
  const base = (await loadMigrations()).slice(0, 15), next = await fixture();
  await migrate(t.db, base); await ensureTenant(t.db, 'default');
  const owner = '0x' + '11'.repeat(20), id = 'compat-run';
  const projector: Projector = name => name.endsWith('.jsonl') ? { run: { runId: id, workflowId: 'compat-workflow', flow: 'base-swap', status: 'SIMULATED',
    provenance: 'MOCKED', ownerAccount: owner, recoveryOf: null, errorCode: null, needsObservation: false, hasEvidence: false, attempts: [], journal: [] }, work: [] } : null;
  const store = createPostgresLogStore({ db: t.db, tenantId: 'default', namespace: 'compat', projector });
  const content = bytes(JSON.stringify({ quote: { executionId: id, ownerReview: { account: owner } }, workflow: { workflowId: 'compat-workflow' }, reviewedManifestHash: null, attempts: [], outcome: null }) + '\n');
  await store.create(id + '.jsonl', content);
  await migrate(t.db, [...base, next]);
  expect(await store.read(id + '.jsonl')).toEqual(content);
  expect(await assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS.slice(0, 15))).toMatchObject({ version: 16, application: 15, forward: [{ sha256: next.sha256 }] });
  await expect(assertSchemaCompatible(t.db, base, [])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
  await expect(assertSchemaCurrent(t.db, base)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
  // A second process is the rollback target, not an older binary without the certificate.
  expect((await assertSchemaCompatible(t.open(), base)).version).toBe(16);
  await store.extend(id + '.jsonl', bytes(new TextDecoder().decode(content).repeat(2)), () => undefined);
  const deleted = await t.db.query<{ result: { ok: boolean; disposition?: string } }>('SELECT purge_unstarted_execution($1,$2,$3) AS result', ['default',owner,id]);
  expect(deleted.rows[0]!.result).toMatchObject({ ok: true, disposition: 'DELETED' });
  await expect(store.create(id + '.jsonl', content)).rejects.toThrow('EXECUTION_DELETED');
  expect((await t.db.query('SELECT count(*)::int AS n FROM execution_runs')).rows).toEqual([{ n: 0 }]);
  expect((await t.db.query('SELECT count(*)::int AS n FROM execution_purge_audit')).rows).toEqual([{ n: 1 }]);
});
it('rolls a failing 0016 back atomically, preserving the schema-15 ledger and append-only triggers', async () => {
  const t = await createTestDatabase({ migrated: false }); opened.push(t);
  const base = (await loadMigrations()).slice(0, 15), next = await fixture();
  await migrate(t.db, base);
  const broken = next.sql + '\nSELECT 1/0;';
  await expect(migrate(t.db, [...base, { ...next, sql: broken, sha256: sha(broken) }])).rejects.toThrow();
  expect((await t.db.query('SELECT max(version) AS version FROM schema_migrations')).rows).toEqual([{ version: 15 }]);
  expect((await t.db.query("SELECT to_regclass('public.execution_purge_audit')::text AS audit")).rows).toEqual([{ audit: null }]);
  expect((await t.db.query("SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgname='journal_entries_append_only'")).rows[0]!.definition).toContain('reject_append_only_mutation');
  expect((await assertSchemaCompatible(t.db, base)).version).toBe(15);
});
