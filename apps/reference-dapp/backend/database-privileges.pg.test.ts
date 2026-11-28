// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, createDatabase, createOwnerHistory, createPostgresLogStore,
  createPostgresWorkQueue, ensureTenant, forwardMigrationSqlUrl, loadMigrations, migrate, sweep, type Database } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import { createAccountStore } from '../src/accounts/account-store.ts';
import { runAdminCommand } from '../src/admin/cli-commands.ts';
import { configureFinancialSync, queueFinancialSync, claimFinancialSync, finishFinancialSync } from '../src/admin/finops/sync-store.ts';
import { createAdminStore, recordAudit } from '../src/admin/store.ts';
import { writeSupportText } from '../src/admin/support/privacy.ts';
import { createEmailOutbox } from '../src/flight/email/outbox.ts';

const tenantId = 'default';
const wallet = '0x' + '11'.repeat(20);
const nonce = randomBytes(6).toString('hex');
const password = randomBytes(18).toString('hex');
const names = { owner: 'owner', runtime: 'runtime', admin_web: 'admin_web', admin_operations: 'admin_operations', finops_worker: 'finops_worker' } as const;
type Role = keyof typeof names;
const roles = Object.keys(names) as Role[];
const name = (role: Role) => `acl_${role}_${nonce}`;
const pools = new Map<Role, Database>();
const db = (role: Role) => pools.get(role)!;
const runtime = () => db('runtime');
const owner = () => db('owner');
const admins = () => createAdminStore(db('admin_operations'), tenantId);
const sql = (filename: string) => readFile(new URL(`../../../docs/deploy/database-privileges/${filename}.sql`, import.meta.url), 'utf8');
const app = new URL('../', import.meta.url);
const restricted = { code: '42501' };
let test: TestDatabase;
let admin: Database;

function url(role: Role) {
  const parsed = new URL(test.url);
  parsed.username = name(role); parsed.password = password;
  return parsed.toString();
}
function node(script: string, args: string[], env: Record<string, string>) {
  return promisify(execFile)(process.execPath, [`backend/${script}`, ...args], {
    cwd: app, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env }, timeout: 30_000,
  });
}
async function audit(mode: 'audit' | 'stage' | 'enforce', options: { apply?: boolean; beforeVerify?: string } = {}) {
  const [policy, apply, verify] = await Promise.all([sql('policy'), sql('apply'), sql('verify')]);
  return owner().transaction(async tx => {
    if (!options.apply) await tx.query('SET TRANSACTION READ ONLY');
    await tx.query(`SET LOCAL flofi_acl.mode = '${mode}'`);
    for (const role of roles) await tx.query('SELECT set_config($1, $2, true)', [`flofi_acl.${role}`, name(role)]);
    await tx.query(policy);
    if (options.apply) await tx.query(apply);
    if (options.beforeVerify) await tx.query(options.beforeVerify);
    // The PostgreSQL driver returns an array for multiple statements in the same query. The deployment runs this same SQL with psql.
    const [report, assertion] = verify.split('\nDO $verify$');
    const queryStart = report!.indexOf('\nWITH');
    await tx.query(report!.slice(0, queryStart));
    const { rows } = await tx.query(report!.slice(queryStart));
    await tx.query(`DO $verify$${assertion}`);
    return rows[0]!;
  });
}
const ledger = () => owner().query('SELECT version, name, sha256, applied_at FROM schema_migrations ORDER BY version');

beforeAll(async () => {
  test = await createTestDatabase({ migrated: false });
  admin = createDatabase({ connectionString: testDatabaseUrl().toString() });
  for (const role of roles) await admin.query(`CREATE ROLE ${name(role)} LOGIN PASSWORD '${password}'`);
  await admin.query(`ALTER DATABASE ${new URL(test.url).pathname.slice(1)} OWNER TO ${name('owner')}`);
  for (const role of roles) pools.set(role, createDatabase({ connectionString: url(role) }));
  await owner().query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${name('runtime')};
    ALTER DEFAULT PRIVILEGES GRANT USAGE ON SEQUENCES TO ${name('runtime')}`);
  const forward = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!.migrations;
  const optional = await Promise.all(forward.map(async m => {
    const body = await readFile(forwardMigrationSqlUrl(m), 'utf8');
    expect(createHash('sha256').update(body).digest('hex')).toBe(m.sha256);
    return { ...m, sql: body };
  }));
  expect(await migrate(owner(), [...await loadMigrations(), ...optional])).toHaveLength(38);
  await owner().query(`REVOKE ALL ON execution_purge_permits, workflow_run_purge_permits FROM ${name('runtime')};
    REVOKE INSERT, UPDATE, DELETE ON schema_migrations, execution_purge_audit, workflow_run_purge_audit FROM ${name('runtime')};
    GRANT EXECUTE ON FUNCTION purge_unstarted_execution(text, text, text), purge_unsubmitted_workflow_run(text, text, text) TO ${name('runtime')}`);
});

afterAll(async () => {
  await Promise.all([...pools.values()].map(pool => pool.close()));
  try { await test?.drop(); }
  finally {
    try { for (const role of roles) await admin?.query(`DROP ROLE IF EXISTS ${name(role)}`); }
    finally { await admin?.close(); }
  }
});

it('reports the old ACL and preserves the protected ledger and runtime during additive preparation', async () => {
  const before = await ledger();
  const pre = await audit('audit');
  expect(pre).toMatchObject({ existing_protections_intact: true, migration_ledger: { version: 38, entries: 38 } });
  expect(pre.tables).toHaveLength(119 * roles.filter(r => r !== 'owner').length);
  await audit('stage', { apply: true });
  await audit('stage');
  expect(await ledger()).toEqual(before);
  await expect(runtime().query('DELETE FROM privacy_requests WHERE false')).resolves.toMatchObject({ rowCount: 0 });
  await expect(db('admin_web').query('SELECT * FROM admin_principals')).resolves.toMatchObject({ rowCount: 0 });
});

it('rolls back all grants if post-verification fails and rejects INHERIT and SET-only memberships', async () => {
  await expect(audit('enforce', { apply: true, beforeVerify: `GRANT UPDATE(version) ON public.schema_migrations TO ${name('runtime')}` }))
    .rejects.toThrow('FLOFI_ACL_VERIFICATION_FAILED');
  await expect(runtime().query('DELETE FROM privacy_requests WHERE false')).resolves.toMatchObject({ rowCount: 0 });
  for (const membership of ['INHERIT TRUE, SET FALSE', 'INHERIT FALSE, SET TRUE']) {
    await admin.query(`GRANT ${name('admin_operations')} TO ${name('runtime')} WITH ${membership}`);
    try { await expect(audit('enforce', { apply: true })).rejects.toThrow('FLOFI_ACL_UNSAFE_ROLE'); }
    finally { await admin.query(`REVOKE ${name('admin_operations')} FROM ${name('runtime')}`); }
  }
});

it('applies once and on rerun, checks exact privileges and denies new implicit access', async () => {
  const before = await ledger();
  await owner().query(`GRANT UPDATE(body) ON admin_support_texts TO ${name('runtime')}`);
  const first = await audit('enforce', { apply: true });
  expect(await audit('enforce', { apply: true })).toEqual(first);
  expect(await audit('enforce')).toEqual(first);
  await expect(audit('enforce', { apply: true, beforeVerify:
    'ALTER POLICY flofi_runtime_audit_insert ON public.admin_audit_events WITH CHECK (true)' }))
    .rejects.toThrow('row policy definitions');
  expect(await audit('enforce')).toEqual(first);
  await owner().query('CREATE TABLE public.unclassified (id bigint GENERATED ALWAYS AS IDENTITY); CREATE FUNCTION public.unclassified() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$');
  try {
    for (const role of roles.filter(r => r !== 'owner')) {
      await expect(db(role).query('INSERT INTO unclassified DEFAULT VALUES')).rejects.toMatchObject(restricted);
      await expect(db(role).query('SELECT public.unclassified()')).rejects.toMatchObject(restricted);
    }
  } finally { await owner().query('DROP FUNCTION public.unclassified(); DROP TABLE public.unclassified'); }
  expect(await ledger()).toEqual(before);
  const denied = ['UPDATE schema_migrations SET version = 1', 'SELECT * FROM execution_purge_permits',
    'SELECT * FROM workflow_run_purge_permits', 'DELETE FROM execution_purge_audit', 'DELETE FROM workflow_run_purge_audit',
    'DELETE FROM execution_runs', 'DELETE FROM workflow_run_events', 'UPDATE execution_runs SET log_name = null',
    'UPDATE execution_attempts SET run_id = null', 'UPDATE privacy_legal_holds SET released_at = now()', 'DELETE FROM admin_support_texts',
    'INSERT INTO studio_publication_events DEFAULT VALUES', 'INSERT INTO admin_settings_versions DEFAULT VALUES',
    'TRUNCATE journal_entries', 'ALTER TABLE workflow_run_events DISABLE TRIGGER ALL', 'CREATE TABLE public.refused (id int)',
    `SET ROLE ${name('admin_operations')}`, `SET ROLE ${name('owner')}`];
  for (const statement of denied) await expect(runtime().query(statement)).rejects.toMatchObject(restricted);
});

it('preserves runtime startup, account authentication, durable logs, the queue and both checked History functions', async () => {
  expect(await assertSchemaCompatible(runtime())).toMatchObject({ version: 38, application: 28 });
  const runtimeEnv = { DATABASE_URL: url('runtime'), FLOFI_DEPLOYMENT: 'hosted' };
  const schema = await node('main.ts', ['check-schema'], runtimeEnv);
  expect(schema.stdout).toContain('schema.compatible');
  await expect(node('main.ts', ['migrate'], runtimeEnv)).rejects.toMatchObject({ code: 1 });
  await expect(node('main.ts', ['migrate'], { DATABASE_MIGRATION_URL: url('owner') })).resolves.toMatchObject({ stdout: expect.stringContaining('migrate.applied') });
  await ensureTenant(runtime(), 'acl-runtime');
  const accounts = createAccountStore(runtime(), 'acl-runtime');
  const session = await accounts.signIn({ kind: 'eip155', subject: wallet, label: null });
  expect(await accounts.verifySession(session)).toBe(true);
  await accounts.revokeSession(session);
  expect(await accounts.verifySession(session)).toBe(false);

  const projection = { run: { runId: 'acl-run', workflowId: 'acl-workflow', flow: 'base-swap', status: 'SIMULATED',
    provenance: 'MOCKED' as const, ownerAccount: wallet, recoveryOf: null, errorCode: null, needsObservation: false,
    hasEvidence: false, attempts: [], journal: [] }, work: [] };
  const logs = createPostgresLogStore({ db: runtime(), tenantId, namespace: 'base-swap', projector: () => projection });
  const line = Buffer.from(JSON.stringify({ quote: { executionId: 'acl-run', ownerReview: { account: wallet } },
    workflow: { workflowId: 'acl-workflow' }, reviewedManifestHash: null, attempts: [], outcome: null }) + '\n');
  await logs.create('acl-run.jsonl', line);
  await logs.extend('acl-run.jsonl', Buffer.concat([line, line]), () => undefined);
  const queue = createPostgresWorkQueue({ db: runtime(), tenantId, ownerId: 'acl-worker' });
  expect(await queue.enqueue(tenantId, 'reconcile', 'acl-worker', null)).toBe(true);
  const [item] = await queue.claim(1);
  expect(item?.dedupeKey).toBe('acl-worker');
  expect(await queue.complete(item!)).toBe(true);
  await sweep(runtime(), { tenantId });

  const hash = '0x' + '1'.repeat(64), handoff = 'apr_' + 'a'.repeat(26), runId = 'wfr_' + 'b'.repeat(26), requester = 'acct_' + 'a'.repeat(32);
  await runtime().query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind, requester_id, client_id, client_name, secret_digest, strategy,
      workflow_hash, engine_version, network_environment, funds_class, plan, status, claimed_namespace, claimed_address, claimed_at, claim_expires_at, expires_at)
    VALUES ('default', $1, 'EDITOR_SESSION', $2, 'flofi-editor', 'Editor', $3, '{}', $4, 'flofi-engine-2', 'MAINNET', 'REAL_FUNDS',
      '{"kind":"SEQUENTIAL"}', 'CLAIMED', 'eip155', $5, now(), now() + interval '1 hour', now() + interval '1 hour')`,
  [handoff, requester, randomBytes(32), hash, wallet]);
  expect(await runtime().query('DELETE FROM mcp_handoffs WHERE handoff_id = $1', [handoff])).toMatchObject({ rowCount: 0 });
  await runtime().query(`INSERT INTO workflow_runs (tenant_id, run_id, handoff_id, requester_kind, requester_ref, owner_namespace, owner_account, wallets, strategy,
      workflow_hash, engine_version, step_count, state, expires_at)
    VALUES ('default', $1, $2, 'EDITOR_SESSION', $3, 'eip155', $4, $5::jsonb, '{}', $6, 'flofi-engine-2', 1, 'PENDING', now() + interval '1 day')`,
  [runId, handoff, requester, wallet, JSON.stringify({ eip155: wallet }), hash]);
  await runtime().query(`INSERT INTO workflow_run_steps (tenant_id, run_id, step_index, state) VALUES ('default', $1, 0, 'PENDING')`, [runId]);
  await runtime().query(`INSERT INTO workflow_run_events (tenant_id, run_id, kind, detail) VALUES ('default', $1, 'RUN_CREATED', $2::jsonb)`,
    [runId, { stepCount: 1, workflowHash: hash }]);
  const [outcome] = (await runtime().query<{ result: { ok: boolean } }>(
    'SELECT purge_unsubmitted_workflow_run($1,$2,$3) AS result', [tenantId, wallet, 'not-a-run'])).rows;
  expect(outcome?.result.ok).toBe(false);
  const history = createOwnerHistory(runtime(), tenantId);
  expect(await history.change(wallet, 'WORKFLOW_RUN', runId, 'DELETE')).toMatchObject({ ok: false });
  await runtime().transaction(async tx => {
    await tx.query(`UPDATE workflow_runs SET state = 'CANCELLED', code = 'OWNER_CANCELLED', version = version + 1 WHERE run_id = $1`, [runId]);
    await tx.query(`UPDATE workflow_run_steps SET state = 'SKIPPED', code = 'OWNER_CANCELLED', version = version + 1 WHERE run_id = $1`, [runId]);
    await tx.query(`INSERT INTO workflow_run_events (tenant_id, run_id, step_index, kind, code, detail) VALUES
      ('default', $1, 0, 'STEP_STATE', 'OWNER_CANCELLED', '{"state":"SKIPPED"}'),
      ('default', $1, NULL, 'RUN_CANCELLED', 'OWNER_CANCELLED', '{"state":"CANCELLED"}')`, [runId]);
  });
  expect(await history.change(wallet, 'WORKFLOW_RUN', runId, 'DELETE')).toMatchObject({ ok: true, disposition: 'DELETED' });
  expect(await history.change(wallet, 'EXECUTION_RUN', 'acl-run', 'DELETE')).toMatchObject({ ok: true, disposition: 'DELETED' });
});

it('uses dedicated administrative logins for support, privacy, operator audit and FinOps', async () => {
  const web = db('admin_web'), ops = db('admin_operations'), finops = db('finops_worker');
  const principal = await admins().grant({ account: wallet, role: 'OPERATOR', label: null });
  const listed = await node('admin-cli.ts', ['list', '--tenant', tenantId], { DATABASE_ADMIN_OPERATIONS_URL: url('admin_operations') });
  expect(JSON.parse(listed.stdout)).toMatchObject({ principals: [expect.objectContaining({ principalId: principal.principalId })] });
  expect(await createAdminStore(web, tenantId).activePrincipalByAccount(wallet)).toEqual(principal);
  await expect(createAdminStore(web, tenantId).grant({ account: '0x' + '22'.repeat(20), role: 'VIEWER', label: null })).rejects.toMatchObject(restricted);
  const now = new Date(), past = new Date(now.getTime() - 400 * 86_400_000);
  const note = await web.transaction(tx => writeSupportText(tx, tenantId, { purpose: 'SUPPORT_NOTE', body: 'Retained fixture',
    actor: principal.principalId, runId: 'acl-run', incidentId: 'run:acl-run', now: past, retentionDays: 30 }));
  const cli = (command: Parameters<typeof runAdminCommand>[0], values: Record<string, string | boolean>) =>
    runAdminCommand(command, values, ops, tenantId, { env: {}, adminKey: () => Buffer.alloc(32, 1), wallet: async () => wallet, now: () => now });
  const { hold } = await cli('legal-hold', { scope: 'RUN', value: 'acl-run', 'reason-code': 'DISPUTE_PENDING', 'approval-ref': 'ACL-APPROVAL' }) as { hold: { holdId: string } };
  await expect(ops.query('DELETE FROM admin_support_texts WHERE text_id=$1', [note.textRef])).rejects.toThrow('ADMIN_SUPPORT_TEXT_LEGAL_HOLD');
  await cli('retention-activate', { policy: 'SUPPORT_TEXT', days: '30', 'approval-ref': 'ACL-APPROVAL' });
  await cli('legal-hold-release', { hold: hold.holdId, 'approval-ref': 'ACL-APPROVAL' });
  await cli('retention-apply', { policy: 'SUPPORT_TEXT' });
  expect(await web.query('SELECT 1 FROM admin_support_texts WHERE text_id=$1', [note.textRef])).toMatchObject({ rowCount: 0 });
  await cli('privacy-request', { kind: 'ACCESS', 'subject-kind': 'WALLET', 'wallet-stdin': true });
  await expect(recordAudit(runtime(), tenantId, { actor: 'cli', kind: 'PRIVACY_LEGAL_HOLD_RELEASED', outcome: 'OK' })).rejects.toMatchObject(restricted);
  await expect(recordAudit(runtime(), tenantId, { actor: 'anonymous', kind: 'ACCOUNT_DUPLICATE_RETIRED', outcome: 'OK' })).resolves.toBeUndefined();
  const outbox = createEmailOutbox({ db: runtime(), tenantId });
  await createEmailOutbox({ db: ops, tenantId }).setPaused(true, 'ACL TEST');
  expect((await outbox.control()).paused).toBe(true);
  await expect(outbox.setPaused(false, null)).rejects.toMatchObject(restricted);
  const finance = { db: finops, tenantId };
  await configureFinancialSync(finance, ['openai']);
  await queueFinancialSync({ db: web, tenantId }, principal.principalId, 'openai');
  const lease = await claimFinancialSync(finance, ['openai'], 12);
  expect(lease).not.toBeNull();
  if (lease) await finishFinancialSync(finance, lease, { kind: 'COMPLETE', coverage: 'UNAVAILABLE', entries: [], meters: [], limitations: ['FINOPS_PROVIDER_NO_DATA'] }, 12);
  await expect(finops.query('SELECT * FROM privacy_requests')).rejects.toMatchObject(restricted);
});
