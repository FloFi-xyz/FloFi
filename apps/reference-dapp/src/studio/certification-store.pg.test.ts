// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { ensureTenant } from '@defi-workflow-engine/cloud-runtime';
import { defineIntegrationPackage, type IntegrationPackage } from '@defi-workflow-engine/developer-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { runAdminCommand } from '../admin/cli-commands.ts';
import { adminConfig } from '../admin/config.ts';
import { authenticateAdmin, type AdminContext } from '../admin/guard.ts';
import { ADMIN_SESSION_COOKIE, sealAdminSession } from '../admin/session.ts';
import { createAdminStore } from '../admin/store.ts';
import { createDeveloperConsoleStore } from '../developer/console-store.ts';
import { handleStudioCertification } from './certification-http.ts';
import { decideStudioCertification, listPublishedStudioIntegrations, parseStudioDecision, studioCertificationInstalled, studioCertificationQueue } from './certification-store.ts';
import { HYPEREVM } from './integration-manifest.ts';
import type { StudioEvidence } from './integration-probe.ts';
import { createStudioStore } from './integration-store.ts';

const tenant = 'default', externalTenant = 'external';
const owner = 'acct_' + 'a'.repeat(32), reviewer = 'acct_' + 'b'.repeat(32), guest = 'acct_' + 'c'.repeat(32);
const now = new Date('2026-11-22T21:00:00.000Z'), clock = () => now;
const chainRef = 'eip155:923508';
const checkpointHash = `0x${'1'.repeat(64)}`;
const origin = 'https://admin.example.org';
const env = { FLOFI_ADMIN: 'enabled', FLOFI_ADMIN_SESSION_SECRET: randomBytes(32).toString('hex') };
const config = adminConfig(env);
if (!config.enabled) throw new Error('ADMIN_TEST_CONFIG_INVALID');
const key = config.key;
const rpcUrl = 'https://separate-rpc.example.org/';
const reference = 'https://network-reference.example.org/';
const defineNetwork = (slug: string, proposed = { chainRef, name: 'Reference Network' }) => defineIntegrationPackage({
  schemaVersion: 2, kind: 'network', slug, architecture: 'evm', environment: 'mainnet', rpcUrl: 'https://proposal-rpc.example.net/',
  checkpoint: { height: '0x0', hash: checkpointHash }, adapter: { kind: 'builtin', id: 'evm-rpc', version: 1 },
  capabilities: ['network.read', 'transfer.native'], dependencies: [], ...proposed,
});
let t: TestDatabase;
let operator: AdminContext, ownerOperator: AdminContext, viewer: AdminContext, unbound: AdminContext;
let tokens: Record<string, string>;

const projectFor = (accountId = owner, scope = tenant) => createDeveloperConsoleStore(t.db, scope, accountId);
const studio = (accountId = owner) => createStudioStore(t.db, tenant, accountId);
const catalog = (scope = tenant, requester?: Parameters<typeof listPublishedStudioIntegrations>[2]) => listPublishedStudioIntegrations(t.db, scope, requester);

function evidence(manifest: IntegrationPackage, mode: 'verify' | 'test', observedAt = now): StudioEvidence {
  if (manifest.adapter.kind !== 'builtin' || !manifest.chainRef || !manifest.rpcUrl) throw new Error('TEST_PACKAGE_INVALID');
  return { schemaVersion: 2, source: 'PROPOSAL_RPC', mode, adapterId: manifest.adapter.id, adapterVersion: 1, chainRef: manifest.chainRef,
    rpcUrl: manifest.rpcUrl, observedAt: observedAt.toISOString(), checkpointHash: manifest.checkpoint?.hash ?? null,
    block: { height: '0x10', hash: `0x${'2'.repeat(64)}`, timestamp: '0x1', baseFeePerGas: '0x1' }, facts: { estimate: true } };
}
const probe = (manifest: IntegrationPackage) => Promise.resolve(evidence(manifest, 'test'));

async function createPrincipal(holder: string | undefined, digit: string, role: 'OPERATOR' | 'VIEWER' = 'OPERATOR') {
  const wallet = `0x${digit.repeat(40)}`;
  if (holder) await t.db.query(`INSERT INTO flofi_account_identities(tenant_id,kind,subject,account_id) VALUES($1,'EIP155',$2,$3)`, [tenant, wallet, holder]);
  const store = createAdminStore(t.db, tenant);
  const principal = await store.grant({ account: wallet, role, label: null });
  const sessionId = randomBytes(16).toString('hex'), expiresAt = new Date(now.getTime() + 3_600_000);
  await store.createSession({ sessionId, principalId: principal.principalId, createdAt: now, expiresAt });
  const token = sealAdminSession(key, { sessionId, principalId: principal.principalId, issuedAt: now, expiresAt, domain: new URL(origin).hostname });
  const context = await authenticateAdmin({ store, key, token, now, domain: new URL(origin).hostname });
  if (!context) throw new Error('TEST_ADMIN_UNAVAILABLE');
  tokens[principal.principalId] = token;
  return context;
}

async function pending(projectId: string, manifest: IntegrationPackage) {
  const store = studio();
  const latest = async () => (await store.list(projectId)).find(item => item.slug === manifest.slug)!;
  await store.create(projectId, manifest, now, (await store.list(projectId)).find(item => item.slug === manifest.slug));
  await store.probe(projectId, await latest(), 'verify', clock, async () => evidence(manifest, 'verify'));
  await store.probe(projectId, await latest(), 'test', clock, async () => evidence(manifest, 'test'));
  await store.submit(projectId, await latest(), now);
  const { slug, version, generation } = await latest();
  return { projectId, slug, version, generation };
}

const actionBody = (target: { projectId: string; slug: string; version: number; generation: number }, action: string, more: Record<string, unknown> = {}) =>
  ({ ...target, action, reason: 'Independent metadata review', catalogRevision: '0', ...more });
const change = (body: Record<string, unknown>, admin = operator) => decideStudioCertification(t.db, tenant, admin, parseStudioDecision(body), clock, probe);

function post(body: unknown, admin?: AdminContext, headers: Record<string, string> = {}) {
  return new Request(origin + '/admin/api/studio', { method: 'POST', body: JSON.stringify(body),
    headers: { host: new URL(origin).hostname, 'x-forwarded-proto': 'https', origin, 'content-type': 'application/json',
      ...(admin ? { cookie: `${ADMIN_SESSION_COOKIE}=${tokens[admin.principal.principalId]}`, 'x-flofi-admin-csrf': admin.csrf } : {}), ...headers } });
}
const route = (request: Request) => handleStudioCertification(request, { env, now: clock, host: { db: t.db, tenantId: tenant } });

beforeAll(async () => {
  tokens = {};
  t = await createTestDatabase();
  await ensureTenant(t.db, tenant);
  await ensureTenant(t.db, externalTenant);
  const schema = (await t.db.query<{ version: number }>('SELECT max(version) AS version FROM schema_migrations')).rows[0]?.version;
  if (schema === 28) {
    await expect(runAdminCommand('studio-certification-migrate', {}, t.db, tenant)).rejects.toThrow('STUDIO_CERTIFICATION_REQUIRES_SCHEMA_35');
    for (const command of ['finops-migrate', 'finops-sync-migrate', 'position-purge-migrate', 'single-step-runs-migrate',
      'workflow-run-purge-migrate', 'developer-projects-migrate', 'studio-migrate'] as const) await runAdminCommand(command, {}, t.db, tenant);
    expect(await studioCertificationInstalled(t.db)).toBe(false);
    expect(await runAdminCommand('studio-certification-migrate', {}, t.db, tenant)).toEqual({ applied: [36] });
  }
  for (const account of [owner, reviewer, guest]) {
    await t.db.query('INSERT INTO flofi_accounts (tenant_id,account_id) VALUES ($1,$2),($3,$2)', [tenant, account, externalTenant]);
  }
  operator = await createPrincipal(reviewer, '1');
  ownerOperator = await createPrincipal(owner, '2');
  viewer = await createPrincipal(guest, '3', 'VIEWER');
  unbound = await createPrincipal(undefined, '4');
});

afterAll(async () => { await t?.drop(); });

describe('Studio metadata certification and publication', () => {
  it('keeps legacy data intact and applies 0036 explicitly and idempotently', async () => {
    expect(await studioCertificationInstalled(t.db)).toBe(true);
    expect(await runAdminCommand('studio-certification-migrate', {}, t.db, tenant)).toEqual({ applied: [] });
    const projectId = await projectFor().create('Legacy metadata', '', now);
    const store = studio();
    await store.create(projectId, { schemaVersion: 1, kind: 'network', slug: 'hyperevm', name: HYPEREVM.name, chainRef: HYPEREVM.chainRef }, now);
    const head = async () => (await store.list(projectId))[0]!;
    const legacyEvidence = {
      schemaVersion: 1, source: 'MAINNET_RPC', mode: 'verify', chainRef: HYPEREVM.chainRef, rpcUrl: HYPEREVM.rpcUrl,
      observedAt: now.toISOString(), checkpointHash, block: { height: '0x10', hash: checkpointHash, timestamp: '0x1', baseFeePerGas: '0x1' }, facts: {},
    } as const;
    await store.probe(projectId, await head(), 'verify', clock, async () => legacyEvidence);
    await store.probe(projectId, await head(), 'test', clock, async () => ({ ...legacyEvidence, mode: 'test' }));
    await store.submit(projectId, await head(), now);
    const { slug, version, generation } = await head();
    expect(await studioCertificationQueue(t.db, tenant)).toEqual(expect.arrayContaining([
      expect.objectContaining({ project_id: projectId, version: 1, status: 'CERTIFICATION_PENDING', verification: legacyEvidence }),
    ]));
    await expect(change(actionBody({ projectId, slug, version, generation }, 'approve', { reference, rpcUrl }))).rejects.toThrow('STUDIO_MANIFEST_INVALID');
    expect(await head()).toMatchObject({ version: 1, status: 'CERTIFICATION_PENDING', verification: legacyEvidence });
    expect(await catalog()).toEqual([]);
  });

  it('refuses unauthenticated, cross-origin, viewer, unbound and self reviews before certification', async () => {
    const projectId = await projectFor().create('Certification permissions', '', now);
    const target = await pending(projectId, defineNetwork('permissions'));
    const body = actionBody(target, 'reject');
    const attempts = [
      [post(body), 'ADMIN_SESSION_REQUIRED'],
      [post(body, operator, { origin: 'https://other.example.org' }), 'ADMIN_ORIGIN_INVALID'],
      [post(body, operator, { 'x-flofi-admin-csrf': '' }), 'ADMIN_CSRF_INVALID'],
      [post(body, viewer), 'ADMIN_ROLE_INSUFFICIENT'],
      [post(body, unbound), 'STUDIO_CERTIFICATION_REVIEWER_UNBOUND'],
      [post(body, ownerOperator), 'STUDIO_CERTIFICATION_SELF_REVIEW'],
    ] as const;
    for (const [request, code] of attempts) {
      const response = await route(request);
      expect(response.status).toBe(code === 'ADMIN_SESSION_REQUIRED' ? 401 : 403);
      await expect(response.json()).resolves.toEqual({ ok: false, code });
    }
    const rejected = await route(post(body, operator));
    expect(rejected.status).toBe(200);
    await expect(rejected.json()).resolves.toEqual({ ok: true, status: 'REJECTED' });
    await expect(change(actionBody(target, 'approve', { reference, rpcUrl }))).rejects.toThrow('STUDIO_CERTIFICATION_TRANSITION_FORBIDDEN');
  });

  it('checks operator expiry again after serializing the proposal', async () => {
    const projectId = await projectFor().create('Review expires while waiting', '', now);
    const target = await pending(projectId, defineNetwork('review-expiry'));
    const decision = parseStudioDecision(actionBody(target, 'reject'));
    const elapsed = vi.fn().mockReturnValueOnce(now).mockReturnValue(operator.expiresAt);
    await expect(decideStudioCertification(t.db, tenant, operator, decision, elapsed, probe))
      .rejects.toThrow('STUDIO_CERTIFICATION_OPERATOR_REQUIRED');
    expect((await studioCertificationQueue(t.db, tenant))[0]).toMatchObject({ project_id: projectId, status: 'CERTIFICATION_PENDING' });
  });

  it('binds certification to one version, independent observation, and only approved read capabilities', async () => {
    const projectId = await projectFor().create('Exact evidence', '', now);
    const manifest = defineNetwork('exact-evidence', { chainRef: 'eip155:923509', name: 'Exact Network' });
    const target = await pending(projectId, manifest);
    const badProbe = vi.fn(probe);
    await expect(decideStudioCertification(t.db, tenant, operator,
      parseStudioDecision(actionBody(target, 'approve', { reference, rpcUrl: manifest.rpcUrl })), clock, badProbe)).rejects.toThrow('STUDIO_CERTIFICATION_REFERENCE_NOT_INDEPENDENT');
    expect(badProbe).not.toHaveBeenCalled();
    const newTarget = await pending(projectId, { ...manifest, name: 'Exact Network V2' });
    await expect(change(actionBody(target, 'approve', { reference, rpcUrl }))).rejects.toThrow('STUDIO_CERTIFICATION_VERSION_UNAVAILABLE');
    const approved = parseStudioDecision(actionBody(newTarget, 'approve', { reference, rpcUrl }));
    const finalProbe = vi.fn(probe);
    await expect(decideStudioCertification(t.db, tenant, operator, approved, clock, finalProbe)).resolves.toEqual({ status: 'CERTIFIED' });
    expect(finalProbe).toHaveBeenCalledWith({ ...manifest, name: 'Exact Network V2', rpcUrl }, 'test', now);
    expect(await catalog()).toEqual([]);
    const certified = await t.db.query(`SELECT capabilities,manifest_sha256,adapter_sha256,evidence_sha256,evidence FROM studio_certifications
      WHERE tenant_id=$1 AND project_id=$2 AND version=$3`, [tenant, projectId, newTarget.version]);
    expect(certified.rows).toEqual([expect.objectContaining({ capabilities: ['network.read'], adapter_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), evidence: expect.objectContaining({ corroboration: expect.objectContaining({ reference }) }) })]);
    await expect(t.db.query('UPDATE studio_certifications SET reason=$1 WHERE project_id=$2', ['Attempted change', projectId])).rejects.toThrow();
  });

  it('scopes private publication, rolls back only certified immutable versions, and immediately revokes access', async () => {
    const projectId = await projectFor().create('Publication', '', now);
    const guestProject = await projectFor(guest).create('Guest project', '', now);
    const manifest = defineNetwork('publication');
    const v1 = await pending(projectId, manifest);
    await change(actionBody(v1, 'approve', { reference, rpcUrl }));
    await change(actionBody(v1, 'publish', { visibility: 'PRIVATE', audience: [`account:${guest}`, `project:${guestProject}`] }));
    expect(await catalog()).toEqual([]);
    expect(await catalog(tenant, { accountId: owner })).toEqual([]);
    expect(await catalog(externalTenant, { accountId: guest, projectId: guestProject })).toEqual([]);
    const [shared] = await catalog(tenant, { accountId: guest });
    expect(shared).toMatchObject({ slug: v1.slug, capabilities: ['network.read'], version: 1, visibility: 'PRIVATE' });
    expect(await catalog(tenant, { projectId: guestProject })).toEqual([shared]);
    expect(shared).not.toHaveProperty('rpcUrl');
    expect(shared).not.toHaveProperty('evidence');
    expect(shared).not.toHaveProperty('audience');

    const v2 = await pending(projectId, { ...manifest, name: 'Reference Network V2' });
    expect(await catalog(tenant, { projectId: guestProject })).toEqual([shared]);
    await change(actionBody(v2, 'approve', { reference, rpcUrl, catalogRevision: shared!.revision }));
    await change(actionBody(v2, 'publish', { visibility: 'PUBLIC', audience: [], catalogRevision: shared!.revision }));
    const [latest] = await catalog();
    expect(latest).toMatchObject({ version: 2, visibility: 'PUBLIC' });
    await expect(change(actionBody(v1, 'rollback', { visibility: 'PUBLIC', audience: [], catalogRevision: shared!.revision })))
      .rejects.toThrow('STUDIO_CERTIFICATION_VERSION_CHANGED');
    await change(actionBody(v1, 'rollback', { visibility: 'PUBLIC', audience: [], catalogRevision: latest!.revision }));
    const [restored] = await catalog();
    expect(restored).toMatchObject({ version: 1, visibility: 'PUBLIC' });
    await change(actionBody(v1, 'revoke', { catalogRevision: restored!.revision }));
    expect(await catalog()).toEqual([]);
    await expect(change(actionBody(v1, 'rollback', { visibility: 'PUBLIC', audience: [], catalogRevision: restored!.revision }))).rejects.toThrow();
    const rows = await studioCertificationQueue(t.db, tenant);
    expect(rows.find(row => row.project_id === projectId && row.version === 1)).toMatchObject({ status: 'REVOKED' });
    expect((await t.db.query("SELECT kind FROM admin_audit_events WHERE target LIKE $1 ORDER BY event_id", [`${projectId}:%`])).rows)
      .toEqual(['APPROVE', 'PUBLISH', 'APPROVE', 'PUBLISH', 'ROLLBACK', 'REVOKE'].map(action => ({ kind: `ADMIN_STUDIO_${action}` })));
  });
});
