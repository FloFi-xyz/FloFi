// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTenant, assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createAccountStore } from '../accounts/account-store.ts';
import { runAdminCommand } from '../admin/cli-commands.ts';
import { typedId } from '../platform/ids.ts';
import { createDeveloperConsoleStore, developerOwnershipInstalled } from './console-store.ts';
import { developerApi, developerConfig, recordingRuntime } from './developer.test-harness.ts';
import { apiKeyDigest } from './keys.ts';
import { createPgDeveloperStore } from './pg-store.ts';

const tenant = 'default';
const account = (digit: string) => 'acct_' + digit.repeat(32);
const first = account('a'), second = account('b');
const oldCertificate = CERTIFIED_FORWARD_MIGRATIONS.map(c => c.base.version === 28 ? { ...c, migrations: c.migrations.slice(0, 5) } : c);
const config = developerConfig();
let t: TestDatabase;
const consoleFor = (id: string, scope = tenant) => createDeveloperConsoleStore(t.db, scope, id);
const now = () => new Date();

beforeAll(async () => {
  t = await createTestDatabase();
  for (const scope of [tenant, 'other']) {
    await ensureTenant(t.db, scope);
    for (const id of [first, second]) await t.db.query('INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ($1,$2)', [scope, id]);
  }
  const head = Number((await t.db.query<{ version: number }>('SELECT max(version) AS version FROM schema_migrations')).rows[0]?.version);
  if (head === 28) {
    expect(await developerOwnershipInstalled(t.db)).toBe(false);
    await expect(runAdminCommand('developer-projects-migrate', {}, t.db, tenant)).rejects.toThrow('DEVELOPER_PROJECTS_REQUIRES_SCHEMA_33');
    for (const command of ['finops-migrate', 'finops-sync-migrate', 'position-purge-migrate', 'single-step-runs-migrate', 'workflow-run-purge-migrate'] as const)
      await runAdminCommand(command, {}, t.db, tenant);
    expect(await runAdminCommand('developer-projects-migrate', {}, t.db, tenant)).toEqual({ applied: [34] });
  }
});
afterAll(async () => { await t?.drop(); });

describe('developer console ownership', () => {
  it('uses an explicitly certified additive migration and the operator step is repeatable', async () => {
    expect(await developerOwnershipInstalled(t.db)).toBe(true);
    expect(await runAdminCommand('developer-projects-migrate', {}, t.db, tenant)).toEqual({ applied: [] });
    expect(await assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS)).toMatchObject({ version: 34, application: 28 });
    await expect(assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS, oldCertificate)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
  });

  it('isolates projects, credentials, reads and writes by verified account and tenant', async () => {
    const owner = consoleFor(first), other = consoleFor(second), otherTenant = consoleFor(first, 'other');
    const project = await owner.create('Ledger integration', 'Wallet tools', now());
    expect(await owner.list()).toContainEqual(expect.objectContaining({ id: project, description: 'Wallet tools' }));
    await owner.edit(project, 'Wallet integration', 'Scope settings', now());
    expect(await owner.details(project)).toMatchObject({ name: 'Wallet integration', description: 'Scope settings' });
    const key = await owner.issue(project, 'sandbox', ['strategies'], config, now());
    const otherProject = await other.create('Another integration', '', now());
    for (const outsider of [other, otherTenant]) {
      expect(await outsider.details(project)).toBeNull();
      await expect(outsider.disable(project, now())).rejects.toThrow('PROJECT_NOT_FOUND');
      await expect(outsider.revoke(project, key.keyId, now())).rejects.toThrow('PROJECT_NOT_FOUND');
      await expect(outsider.issue(project, 'sandbox', ['strategies'],
        outsider === otherTenant ? { ...config, tenantId: 'other' } : config, now(), key.keyId)).rejects.toThrow('PROJECT_NOT_FOUND');
    }
    await expect(other.revoke(otherProject, key.keyId, now())).rejects.toThrow('KEY_NOT_FOUND');
    await expect(owner.issue(project, 'production', ['strategies'], config, now())).rejects.toThrow('LIVE_MODE_DISABLED');
    const api = developerApi({ db: t.db, runtime: recordingRuntime() }, key.key);
    expect((await api('GET', '/capabilities')).status).toBe(200);
    expect((await api('POST', '/approvals', {})).body.error).toMatchObject({ reason: 'INSUFFICIENT_SCOPE' });
    expect(JSON.stringify(await owner.details(project))).not.toContain(key.key);
  });

  it('rotates atomically, preserves scopes and records an audit without storing credentials', async () => {
    const owner = consoleFor(first), raw = createPgDeveloperStore(t.db, tenant);
    const project = await owner.create('Rotation', '', now());
    const original = await owner.issue(project, 'sandbox', ['strategies'], config, now());
    const attempts = await Promise.allSettled(Array.from({ length: 2 }, () => owner.issue(project, 'sandbox', [], config, now(), original.keyId)));
    const issued = attempts.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    expect(issued).toHaveLength(1);
    const [replacement] = issued;
    expect(await raw.authenticate(apiKeyDigest(config, original.key), now())).toBeNull();
    expect(await raw.authenticate(apiKeyDigest(config, replacement!.key), now())).toMatchObject({ scopes: ['strategies'] });
    await owner.revoke(project, replacement!.keyId, now());
    expect(await raw.authenticate(apiKeyDigest(config, replacement!.key), now())).toBeNull();
    const audit = (await t.db.query('SELECT kind, detail FROM admin_audit_events WHERE tenant_id=$1 AND target=$2 ORDER BY event_id', [tenant, project])).rows;
    expect(audit.map(row => row.kind)).toEqual(['DEVELOPER_PROJECT_CREATED', 'DEVELOPER_KEY_ISSUED', 'DEVELOPER_KEY_ROTATED', 'DEVELOPER_KEY_REVOKED']);
    expect(JSON.stringify(audit)).not.toContain(replacement!.key);
  });

  it('shows only owned usage in the last 30 UTC days and keeps environments distinct', async () => {
    const owner = consoleFor(first), outsider = consoleFor(second), store = createPgDeveloperStore(t.db, tenant);
    const projectId = await owner.create('Usage isolation', '', now());
    const sandbox = { projectId, environment: 'sandbox' as const };
    await store.incrementUsage(sandbox, 'strategy.create', '', new Date('2026-11-01T12:00:00Z'), 5);
    await store.incrementUsage(sandbox, 'strategy.create', '', new Date('2026-11-02T12:00:00Z'), 2);
    await store.incrementUsage({ projectId, environment: 'production' }, 'strategy.create', '', new Date('2026-11-02T12:00:00Z'), 3);
    const at = new Date('2026-12-01T01:00:00Z');
    expect(await owner.activity(projectId, at)).toEqual([
      { environment: 'production', metric: 'strategy.create', total: '3' },
      { environment: 'sandbox', metric: 'strategy.create', total: '2' },
    ]);
    expect(await outsider.activity(projectId, at)).toEqual([]);
    expect(await consoleFor(first, 'other').activity(projectId, at)).toEqual([]);
  });

  it('serializes late API writes with project shutdown', async () => {
    const owner = consoleFor(first), store = createPgDeveloperStore(t.db, tenant);
    const projectId = await owner.create('Shutdown', '', now());
    const key = await owner.issue(projectId, 'sandbox', ['strategies'], config, now());
    const api = developerApi({ db: t.db, runtime: recordingRuntime() }, key.key);
    const scope = { projectId, environment: 'sandbox' as const };
    const created = await api<{ id: string }>('POST', '/strategies', { strategy: {
      action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '5',
    } });
    expect(created.status).toBe(201);
    const stored = await store.strategy(scope, created.body.id);
    if (!stored) throw new Error('Strategy fixture missing');
    const lateStrategy = { ...stored, strategyId: typedId('str') };
    const writes: Promise<void>[] = [];
    await t.db.transaction(async tx => {
      await tx.query("UPDATE developer_projects SET status='DISABLED', disabled_at=$3 WHERE tenant_id=$1 AND project_id=$2", [tenant, projectId, now()]);
      // These run on other connections while the project change is uncommitted.
      writes.push(
        expect(store.createKey(projectId, 'sandbox', ['strategies'], apiKeyDigest(config, 'disposable test value'), 'test', now())).resolves.toBeNull(),
        expect(store.createStrategy(lateStrategy, now())).rejects.toThrow('DEVELOPER_PROJECT_DISABLED'),
      );
    });
    await Promise.all(writes);
    expect(await store.strategy(scope, lateStrategy.strategyId)).toBeNull();
    expect(await store.listKeys(projectId)).toMatchObject([{ keyId: key.keyId, status: 'REVOKED' }]);
  });

  it('closes dependent resources on account deletion and leaves its project identity for history', async () => {
    const id = account('c');
    await t.db.query('INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ($1,$2)', [tenant, id]);
    const owner = consoleFor(id), project = await owner.create('Lifecycle', '', now());
    const key = await owner.issue(project, 'sandbox', ['webhooks'], config, now());
    const api = developerApi({ db: t.db, runtime: recordingRuntime() }, key.key);
    expect((await api('POST', '/webhook-endpoints', { url: 'https://example.com/flofi' })).status).toBe(201);
    const accounts = createAccountStore(t.db, tenant);
    expect(await accounts.retirementBlockers(id)).toContain('DEVELOPER_PROJECTS');
    await accounts.deleteAccount(id);
    expect(await owner.details(project)).toBeNull();
    expect((await api('GET', '/capabilities')).status).toBe(401);
    expect((await t.db.query('SELECT status FROM developer_projects WHERE tenant_id=$1 AND project_id=$2', [tenant, project])).rows[0]?.status).toBe('DISABLED');
    expect((await t.db.query('SELECT status FROM developer_webhook_endpoints WHERE tenant_id=$1 AND project_id=$2', [tenant, project])).rows[0]?.status).toBe('DELETED');
  });
});
