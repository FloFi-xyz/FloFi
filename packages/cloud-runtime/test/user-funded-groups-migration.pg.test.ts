// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: schema 22 → 23 against real disposable PostgreSQL. 0023 widens the two workflow_runs mode CHECKs for
 * USER_FUNDED and adds workflow_run_groups: every earlier row survives byte for byte, no existing column changes, a group's fee payer can only
 * be the run's own wallet (invariant S1, enforced by the database), and the group lifecycle is closed and append-only.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertSchemaCurrent, loadMigrations, migrate, SHIPPED_MIGRATIONS, type Database } from '../src/index.js';
import { createTestDatabase } from './pg-harness';

const HASH = '0x' + '1'.repeat(64), OWNER = '0x' + 'ab'.repeat(20), OTHER = '0x' + 'cd'.repeat(20), SOL = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex').slice(0, 26).replace(/[0189]/g, 'a')}`;
const ok = (work: Promise<unknown>) => work.then(() => true, () => false);
const fails = (work: Promise<unknown>) => work.then(() => null, (e: Error) => e.message);
async function handoff(db: Database): Promise<string> {
  const handoffId = id('apr');
  await db.query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind, requester_id, account_id, client_id, client_name, secret_digest, strategy,
      workflow_hash, engine_version, network_environment, funds_class, plan, status, expires_at)
    VALUES ('default', $1, 'CHANNEL_CONVERSATION', 'cnv_userfundedmigration', NULL, 'flofi-channel', 'Channel', $2, '{}', $3, 'flofi-engine-2', 'MAINNET', 'REAL_FUNDS',
      '{"kind":"SEQUENTIAL"}', 'PENDING', now() + interval '1 hour')`, [handoffId, randomBytes(32), HASH]);
  return handoffId;
}
async function run(db: Database, wallets: Record<string, string> = { eip155: OWNER, solana: SOL }): Promise<string> {
  const runId = id('wfr');
  await db.query(`INSERT INTO workflow_runs (tenant_id, run_id, handoff_id, requester_kind, requester_ref, owner_namespace, owner_account, wallets, strategy, workflow_hash,
      engine_version, step_count, state, expires_at)
    VALUES ('default', $1, $2, 'CHANNEL_CONVERSATION', 'cnv_userfundedmigration', 'eip155', $3, $4::jsonb, '{}', $5, 'flofi-engine-2', 3, 'PENDING', now() + interval '1 day')`,
  [runId, await handoff(db), OWNER, JSON.stringify(wallets), HASH]);
  for (let i = 0; i < 3; i++) await db.query(`INSERT INTO workflow_run_steps (tenant_id, run_id, step_index, state) VALUES ('default', $1, $2, 'PENDING')`, [runId, i]);
  return runId;
}
const userFunded = (db: Database, runId: string) => db.query(`UPDATE workflow_runs SET mode = 'USER_FUNDED', state = 'RUNNING', version = version + 1 WHERE run_id = $1`, [runId]);
const group = (db: Database, runId: string, index: number, namespace: string, chain: string, payer: string, from = index, to = index) =>
  db.query(`INSERT INTO workflow_run_groups (tenant_id, run_id, group_index, namespace, chain, fee_payer, step_from, step_to, strategy, signing, state)
    VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, 'UPFRONT', 'PLANNED')`, [runId, index, namespace, chain, payer, from, to,
    namespace === 'solana' ? 'SOLANA_SIGN_ALL' : 'EVM_WALLET_BATCH']);
const move = (db: Database, runId: string, index: number, set: string) =>
  db.query(`UPDATE workflow_run_groups SET ${set}, version = version + 1 WHERE run_id = $1 AND group_index = $2`, [runId, index]);
const definition = async (db: Database, name: string) =>
  (await db.query<{ def: string }>('SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1', [name])).rows.map(row => row.def);
const columns = async (db: Database) => (await db.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name <> 'workflow_run_groups' ORDER BY table_name, ordinal_position`)).rows;
const snapshot = async (db: Database) => ({ runs: (await db.query('SELECT * FROM workflow_runs ORDER BY run_id')).rows,
  steps: (await db.query('SELECT * FROM workflow_run_steps ORDER BY run_id, step_index')).rows });

describe('User-funded execution groups additive migration (0023)', () => {
  it('widens the mode checks, keeps every earlier row and column, and stores user-funded runs whose groups only the owner pays for', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const all = (await loadMigrations()).slice(0, 23), base = all.slice(0, 22);
      expect(all[22]).toMatchObject({ version: 23, name: 'user_funded_groups', sha256: SHIPPED_MIGRATIONS[22]!.sha256 });
      await migrate(t.db, base);
      // Before 0023: USER_FUNDED is refused like any unknown mode; earlier rows of each mode exist.
      const confirm = await run(t.db);
      await t.db.query(`UPDATE workflow_runs SET mode = 'CONFIRM_EACH_STEP', state = 'RUNNING', version = version + 1 WHERE run_id = $1`, [confirm]);
      const pending = await run(t.db);
      expect(await ok(userFunded(t.db, pending))).toBe(false);
      const shape = await columns(t.db), rows = await snapshot(t.db);
      expect(await migrate(t.db, all)).toEqual([23]);
      expect(await columns(t.db)).toEqual(shape);
      expect(await snapshot(t.db)).toEqual(rows);
      expect(await assertSchemaCurrent(t.db, SHIPPED_MIGRATIONS.slice(0, 23))).toBe(23);
      expect(await migrate(t.db, all)).toEqual([]);
      expect(await definition(t.db, 'workflow_runs_mode_check')).toEqual([
        "CHECK (((mode IS NULL) OR (mode = ANY (ARRAY['CONFIRM_EACH_STEP'::text, 'DELEGATED'::text, 'USER_FUNDED'::text]))))"]);
      // USER_FUNDED never carries a delegated authorization; DELEGATED still must.
      expect(await ok(t.db.query(`UPDATE workflow_runs SET mode = 'USER_FUNDED', state = 'RUNNING', authorization_id = 'dau_${'a'.repeat(26)}', version = version + 1
        WHERE run_id = $1`, [pending]))).toBe(false);
      expect(await ok(t.db.query(`UPDATE workflow_runs SET mode = 'DELEGATED', state = 'RUNNING', version = version + 1 WHERE run_id = $1`, [pending]))).toBe(false);
      // A group needs a USER_FUNDED run.
      expect(await fails(group(t.db, confirm, 0, 'eip155', 'eip155:8453', OWNER))).toBe('WORKFLOW_RUN_GROUP_MODE_INVALID');
      await userFunded(t.db, pending);
      // S1 in the database: the fee payer is the run's own wallet of that namespace — never another account, never the other namespace's wallet.
      expect(await fails(group(t.db, pending, 0, 'eip155', 'eip155:8453', OTHER))).toBe('GAS_PAYER_NOT_OWNER');
      expect(await ok(group(t.db, pending, 0, 'eip155', 'eip155:8453', OWNER, 0, 1))).toBe(true);
      expect(await fails(group(t.db, pending, 1, 'solana', SOLANA, '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2', 2, 2))).toBe('GAS_PAYER_NOT_OWNER');
      expect(await ok(group(t.db, pending, 1, 'solana', SOLANA, SOL, 2, 2))).toBe(true);
      // Inserted only PLANNED and empty.
      expect(await ok(t.db.query(`INSERT INTO workflow_run_groups (tenant_id, run_id, group_index, namespace, chain, fee_payer, step_from, step_to, strategy, signing, state)
        VALUES ('default', $1, 2, 'eip155', 'eip155:1', $2, 2, 2, 'EVM_OWNER_STEP', 'WHEN_DUE', 'SUBMITTED')`, [pending, OWNER]))).toBe(false);
      // Lifecycle: prepared → authorized (artifact and authorization frozen) → submitted (written once) → reconciled (terminal).
      expect(await ok(move(t.db, pending, 0, `state = 'AUTHORIZED'`))).toBe(false);
      await move(t.db, pending, 0, `state = 'PREPARED', prepared = '{"kind":"EVM_WALLET_BATCH"}'`);
      await move(t.db, pending, 0, `state = 'PREPARED', prepared = '{"kind":"EVM_WALLET_BATCH","v":2}'`);
      await move(t.db, pending, 0, `state = 'AUTHORIZED', owner_authorization = '{"batchId":"0x01"}'`);
      expect(await fails(move(t.db, pending, 0, `prepared = '{"kind":"EVM_WALLET_BATCH","v":3}'`))).toBe('WORKFLOW_RUN_GROUP_IMMUTABLE');
      expect(await fails(move(t.db, pending, 0, `owner_authorization = '{"batchId":"0x02"}'`))).toBe('WORKFLOW_RUN_GROUP_IMMUTABLE');
      expect(await fails(move(t.db, pending, 0, `fee_payer = '${OTHER}'`))).toBe('WORKFLOW_RUN_GROUP_IMMUTABLE');
      expect(await ok(move(t.db, pending, 0, `state = 'SUBMITTED'`))).toBe(false);
      await move(t.db, pending, 0, `state = 'SUBMITTED', submission = '{"hashes":["0x${'a'.repeat(64)}"]}'`);
      expect(await fails(move(t.db, pending, 0, `submission = '{"hashes":[]}'`))).toBe('WORKFLOW_RUN_GROUP_IMMUTABLE');
      expect(await fails(move(t.db, pending, 0, `state = 'PLANNED'`))).toBe('WORKFLOW_RUN_GROUP_TRANSITION_INVALID');
      expect(await ok(move(t.db, pending, 0, `state = 'RECONCILED'`))).toBe(false);
      await move(t.db, pending, 0, `state = 'RECONCILED', outcome = '{"status":"RECONCILED"}'`);
      expect(await fails(move(t.db, pending, 0, `code = 'LATER'`))).toBe('WORKFLOW_RUN_GROUP_TERMINAL');
      // Grouped steps reuse DELEGATED and its 0015 transitions; groups and runs are never deleted.
      await t.db.query(`UPDATE workflow_run_steps SET state = 'DELEGATED', version = version + 1 WHERE run_id = $1 AND step_index = 0`, [pending]);
      expect(await fails(t.db.query('DELETE FROM workflow_run_groups WHERE run_id = $1', [pending]))).toBe('WORKFLOW_RUN_RECORD_APPEND_ONLY');
      // The mode is still chosen once.
      expect(await fails(t.db.query(`UPDATE workflow_runs SET mode = 'CONFIRM_EACH_STEP', version = version + 1 WHERE run_id = $1`, [pending]))).toBe('WORKFLOW_RUN_IMMUTABLE');
    } finally { await t.drop(); }
  });

  it('rolls failed DDL back together with its ledger entry', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const all = await loadMigrations(), next = all[22]!;
      await migrate(t.db, all.slice(0, 22));
      const sql = next.sql + '\nSELECT missing_user_funded_migration_test_function();\n';
      await expect(migrate(t.db, [...all.slice(0, 22), { ...next, sql, sha256: createHash('sha256').update(sql).digest('hex') }])).rejects.toThrow();
      expect((await t.db.query('SELECT max(version)::int AS version FROM schema_migrations')).rows).toEqual([{ version: 22 }]);
      expect(await definition(t.db, 'workflow_runs_mode_check')).toEqual(["CHECK (((mode IS NULL) OR (mode = ANY (ARRAY['CONFIRM_EACH_STEP'::text, 'DELEGATED'::text]))))"]);
      expect((await t.db.query(`SELECT to_regclass('workflow_run_groups') AS t`)).rows).toEqual([{ t: null }]);
    } finally { await t.drop(); }
  });
});
