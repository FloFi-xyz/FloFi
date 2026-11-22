// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTenant, assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { verifyWebhook } from '../../../../packages/developer-sdk/src/index.ts';
import { createAccountStore } from '../accounts/account-store.ts';
import { runAdminCommand } from '../admin/cli-commands.ts';
import { composeStrategy } from '../engine/strategy-engine';
import { typedId } from '../platform/ids.ts';
import { applyApproval, claimApproval, resumeApproval, shareAppliedDeveloperApproval, viewApproval, workflowRunContinue, type WalletRef } from '../platform/index.ts';
import { FLOFI_PRODUCTION_ORIGIN } from '../platform/navigation.ts';
import { approvalSurface } from '../server/approval-surface.ts';
import { observeOwnerStep } from '../workflow-runs/observe.ts';
import { createDeveloperConsoleStore, developerOwnershipInstalled } from './console-store.ts';
import { developerApi, developerConfig, developerEnv, recordingRuntime } from './developer.test-harness.ts';
import type { WebhookRequest } from './dispatch.ts';
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

  it('binds live-shaped approvals to the exact project and gates further signing after shutdown', async () => {
    const dispatchToken = randomBytes(24).toString('hex');
    const env = developerEnv({ VERCEL: '1', VERCEL_ENV: 'production', FLOFI_PUBLIC_ORIGIN: FLOFI_PRODUCTION_ORIGIN,
      FLOFI_BETA_ACCESS: 'open', FLOFI_WORKFLOW_RUNS: 'enabled',
      FLOFI_DEVELOPER_CONSOLE: 'enabled', FLOFI_DEVELOPER_LIVE: 'enabled',
      FLOFI_DEVELOPER_DISPATCH_TOKEN_SHA256: createHash('sha256').update(dispatchToken).digest('hex') });
    const live = developerConfig(env);
    expect(live.live).toBe(true);
    const owner = consoleFor(first), other = consoleFor(second);
    const calls: string[] = [];
    const runtime = {
      ...recordingRuntime({ calls, modes: { 'crosschain-router': 'live' } }),
      sequences: async () => ({ enabled: true, delegation: null }),
    };
    const host = { db: t.db, tenantId: tenant };
    const surface = await approvalSurface(env, () => undefined, { host, runtime });
    const delivered: WebhookRequest[] = [];
    const wallet: WalletRef = { namespace: 'eip155', address: '0x' + '1'.repeat(40) };
    const otherWallet: WalletRef = { ...wallet, address: '0x' + '2'.repeat(40) };
    const build = async (projects: typeof owner, name: string) => {
      const projectId = await projects.create(name, '', now());
      const key = await projects.issue(projectId, 'production', ['strategies', 'approvals', 'executions', 'webhooks'], live, now());
      const api = developerApi({ db: t.db, env, runtime, transport: async request => { delivered.push(request); return { status: 204 }; } }, key.key);
      const strategyInput = { strategy: { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', amount: '5' } };
      expect((await api('POST', '/strategies', strategyInput)).body.error).toMatchObject({ reason: 'IDEMPOTENCY_KEY_REQUIRED' });
      const created = await api<{ id: string; workflowHash: string }>('POST', '/strategies', strategyInput, { 'idempotency-key': 'project-draft-1' });
      expect(created.status).toBe(201);
      const input = { strategyId: created.body.id, workflowHash: created.body.workflowHash,
        returnTarget: { url: 'https://example.com/flofi/return', state: 'nonsecret-integration-state' } };
      const unsafe = { ...input, returnTarget: { ...input.returnTarget, url: 'https://example.com/flofi/return#credential' } };
      expect((await api('POST', '/approvals', unsafe, { 'idempotency-key': 'unsafe-return-target' })).body.error).toMatchObject({ reason: 'RETURN_TARGET_INVALID' });
      const approval = await api<{ id: string; approvalUrl: string }>('POST', '/approvals', input, { 'idempotency-key': 'project-approval-1' });
      expect(approval.status).toBe(201);
      const originalSecret = decodeURIComponent(new URL(approval.body.approvalUrl).hash.slice(1));
      return { projectId, key, api, input, approvalId: approval.body.id, originalSecret };
    };
    const one = await build(owner, 'First integrator'), two = await build(other, 'Second integrator');
    const endpoint = await two.api<{ secret: string }>('POST', '/webhook-endpoints', { url: 'https://example.com/flofi' },
      { 'idempotency-key': 'project-webhook-1' });
    expect(endpoint.status).toBe(201);
    expect(one.input.workflowHash).toBe(two.input.workflowHash);
    expect((await two.api('GET', `/approvals/${one.approvalId}`)).status).toBe(404);
    expect((await developerApi({ db: t.db, env: { ...env, FLOFI_DEVELOPER_LIVE: 'off' }, runtime }, one.key.key)('GET', '/capabilities')).status).toBe(403);
    const claim = async (project: typeof one) => {
      const replay = await project.api<{ approvalUrl: string }>('POST', '/approvals', project.input, { 'idempotency-key': 'project-approval-1' });
      const secret = decodeURIComponent(new URL(replay.body.approvalUrl).hash.slice(1));
      const proposal = await claimApproval(surface, secret, [wallet], true);
      expect(proposal.workflow).toBeTruthy();
      expect(proposal.view.returnTarget).toBeUndefined();
      const applied = await applyApproval(surface, secret, [wallet], proposal.workflow);
      expect(applied.returnTarget).toBe(`https://example.com/flofi/return?approvalId=${project.approvalId}&state=nonsecret-integration-state`);
      const recovery = await resumeApproval(surface, project.approvalId, [wallet]);
      expect(recovery.view.returnTarget).toBe(applied.returnTarget);
      expect((await viewApproval(surface, project.originalSecret, [otherWallet])).returnTarget).toBeUndefined();
      return { proposal, secret };
    };
    const firstClaim = await claim(one), secondClaim = await claim(two);
    expect(firstClaim.proposal.workflowHash).not.toBe(secondClaim.proposal.workflowHash);
    const runStore = surface.workflowRuns?.store;
    const secondRun = await runStore?.byHandoff(two.approvalId);
    if (!runStore || !secondRun) throw new Error('Workflow run fixture missing');
    // Record a synthetic observation under the exact second handoff. No wallet/provider operations run in this fixture.
    const executionId = 'xroute-' + 'a'.repeat(32);
    const evidence = { environment: 'MOCKED', outcome: 'RECONCILED', bundleHash: '0x' + 'b'.repeat(64) };
    const pending = {
      kind: 'OWNER_RUN' as const, executionId, flow: 'crosschain-router', status: 'CONFIRMING', evidence: null,
      transactions: [], spent: [], received: [], observedAt: now().toISOString(),
    };
    expect(await runStore.settleOwnerStep(secondRun.runId, 0, 'UNCERTAIN', pending, 'STEP_OUTCOME_PENDING')).toBe('RECORDED');
    expect((await two.api('GET', `/approvals/${two.approvalId}`)).body).toMatchObject({
      executions: [{ id: executionId, reconciled: false, terminal: false, evidence: null }],
    });
    expect(await runStore.settleOwnerStep(secondRun.runId, 0, 'RECONCILED',
      { ...pending, executionId: 'xroute-' + 'c'.repeat(32), status: 'RECONCILED', evidence }, null)).toBe('CLAIMED');
    expect(await runStore.settleOwnerStep(secondRun.runId, 0, 'RECONCILED', { ...pending, status: 'RECONCILED', evidence }, null)).toBe('RECORDED');
    expect((await two.api('GET', `/approvals/${two.approvalId}`)).body).toMatchObject({
      executions: [{ id: executionId, reconciled: true, evidence }],
    });
    expect((await one.api('GET', `/approvals/${one.approvalId}`)).body).toMatchObject({ executions: [] });
    expect((await one.api('GET', `/executions/${executionId}/evidence`)).status).toBe(404);
    expect((await two.api('POST', '/internal/dispatch', undefined, { authorization: `Bearer ${dispatchToken}` })).status).toBe(200);
    const events = await Promise.all(delivered.map(request => verifyWebhook({
      payload: request.body, headers: request.headers, secret: endpoint.body.secret,
    })));
    expect(events.find(event => event.type === 'execution.reconciled')?.data).toMatchObject({ approvalId: two.approvalId, executionId, evidence });
    await expect(shareAppliedDeveloperApproval(surface, one.approvalId, [otherWallet], false)).rejects.toThrow('HANDOFF_NOT_FOUND');
    expect(await shareAppliedDeveloperApproval(surface, one.approvalId, [wallet], false)).toEqual({ statusShared: false });
    expect((await one.api('GET', `/approvals/${one.approvalId}`)).body).toMatchObject({ workflowRun: null, statusShared: false });
    expect((await two.api('GET', `/approvals/${two.approvalId}`)).body).toMatchObject({ statusShared: true });
    await owner.disable(one.projectId, now());
    await expect(resumeApproval(surface, one.approvalId, [wallet])).rejects.toThrow('DEVELOPER_PROJECT_DISABLED');
    await expect(workflowRunContinue(surface, one.approvalId, [wallet])).rejects.toThrow('DEVELOPER_PROJECT_DISABLED');
    expect(calls.every(call => /^(mode:|info:|runs$|journal$)/.test(call))).toBe(true);
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

  it('looks up a pinned execution directly and still verifies the reviewed workflow', async () => {
    const composed = composeStrategy({ action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', amount: '5' });
    if (!composed.ok) throw new Error('Reference strategy fixture missing');
    const at = now(), flow = 'crosschain-router', pinnedExecutionId = 'xroute-' + 'a'.repeat(32), wallet = '0x' + '1'.repeat(40);
    const runtime = recordingRuntime({
      runList: async () => { throw new Error('Pinned observation must not scan the listing'); },
      runs: async (id, owner) => ({ ok: true, value: id === pinnedExecutionId && owner === wallet ? {
        runId: id, flow, workflowId: composed.workflow.workflowId, ownerAccount: wallet, status: 'CONFIRMING', provenance: 'MOCKED',
        needsObservation: true, attentionRequired: false, hasEvidence: false, errorCode: null, attempts: [],
        createdAt: at.toISOString(), updatedAt: at.toISOString(),
      } : null }),
      record: async () => ({ ok: true, value: { review: { workflow: composed.workflow } } }),
    });
    const step = { flow, wallet, workflowHash: composed.workflowHash, claimedAt: at, chain: 'eip155:8453', now: at, pinnedExecutionId };
    expect(await observeOwnerStep(runtime, step)).toMatchObject({ verdict: 'UNCERTAIN', outcome: { executionId: pinnedExecutionId, evidence: null } });
    expect(await observeOwnerStep(runtime, { ...step, workflowHash: '0x' + '2'.repeat(64) })).toMatchObject({ verdict: 'UNAVAILABLE' });
  });
});
