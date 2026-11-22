// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSchemaCompatible, ensureTenant, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { runAdminCommand } from '../admin/cli-commands.ts';
import { createDeveloperConsoleStore } from '../developer/console-store.ts';
import { HYPEREVM } from './integration-manifest.ts';
import type { StudioEvidence } from './integration-probe.ts';
import { createStudioStore, studioInstalled, studioReviewQueue } from './integration-store.ts';

const owner = 'acct_' + 'a'.repeat(32), outsider = 'acct_' + 'b'.repeat(32);
const tenant = 'default', now = new Date('2026-11-22T19:00:00Z');
const hash = '0x' + 'a'.repeat(64);
const manifest = { schemaVersion: 1, slug: 'hyperevm', name: 'HyperEVM', kind: 'network', chainRef: HYPEREVM.chainRef } as const;
const verification: StudioEvidence = {
  schemaVersion: 1, mode: 'verify', source: 'MAINNET_RPC', chainRef: HYPEREVM.chainRef,
  rpcUrl: HYPEREVM.rpcUrl, observedAt: now.toISOString(), checkpointHash: hash,
  block: { height: '0x100', hash, timestamp: '0x1', baseFeePerGas: '0x1' }, facts: { canonicalNativeTransferProfile: false },
};
const testResult: StudioEvidence = { ...verification, mode: 'test' };
let database: TestDatabase;
let ownerProject: ReturnType<typeof createDeveloperConsoleStore>;
const studio = (accountId = owner, scope = tenant) => createStudioStore(database.db, scope, accountId);
const clock = () => now;
const read = (evidence: StudioEvidence) => async () => evidence;
const headOf = async (id: string) => (await studio().list(id))[0]!;

beforeAll(async () => {
  database = await createTestDatabase();
  const { db } = database;
  for (const scope of [tenant, 'other']) {
    await ensureTenant(db, scope);
    for (const id of [owner, outsider]) await db.query('INSERT INTO flofi_accounts (tenant_id,account_id) VALUES ($1,$2)', [scope, id]);
  }
  ownerProject = createDeveloperConsoleStore(db, tenant, owner);
  const { version } = await assertSchemaCompatible(db, SHIPPED_MIGRATIONS);
  if (version === 28) {
    expect(await studioInstalled(db)).toBe(false);
    await expect(runAdminCommand('studio-migrate', {}, db, tenant)).rejects.toThrow('STUDIO_REQUIRES_SCHEMA_34');
    for (const command of ['finops-migrate', 'finops-sync-migrate', 'position-purge-migrate', 'single-step-runs-migrate',
      'workflow-run-purge-migrate', 'developer-projects-migrate'] as const) await runAdminCommand(command, {}, db, tenant);
    expect(await studioInstalled(db)).toBe(false);
    expect(await runAdminCommand('studio-migrate', {}, db, tenant)).toEqual({ applied: [35] });
  }
});

afterAll(async () => { await database?.drop(); });

describe('Studio proposal persistence and isolation', () => {
  it('adds and pins schema 35 while preserving the account-owned project schema', async () => {
    expect(await assertSchemaCompatible(database.db, SHIPPED_MIGRATIONS)).toMatchObject({ version: 35, application: 28 });
    expect(await studioInstalled(database.db)).toBe(true);
    expect(await runAdminCommand('studio-migrate', {}, database.db, tenant)).toEqual({ applied: [] });
    expect(await runAdminCommand('developer-projects-migrate', {}, database.db, tenant)).toEqual({ applied: [] });
  });

  it('keeps certification separate, serializes concurrent changes, and audits evidence invalidation', async () => {
    const id = await ownerProject.create('HyperEVM Studio', '', now);
    const store = studio();
    await store.create(id, manifest, now);
    await expect(store.create(id, manifest, now)).rejects.toThrow('STUDIO_SLUG_EXISTS');
    const draft = await headOf(id);
    await expect(store.submit(id, draft, now)).rejects.toThrow('STUDIO_TRANSITION_FORBIDDEN');
    await expect(store.probe(id, draft, 'test', clock, read(testResult))).rejects.toThrow('STUDIO_TRANSITION_FORBIDDEN');
    const outcomes = await Promise.allSettled([
      store.probe(id, draft, 'verify', clock, async value => {
        expect(value).toEqual(manifest);
        return verification;
      }), store.probe(id, draft, 'verify', clock, read(verification)),
    ]);
    expect(outcomes.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']);
    const verified = await headOf(id);
    await expect(store.submit(id, verified, now)).rejects.toThrow('STUDIO_TEST_REQUIRED');
    await expect(store.probe(id, verified, 'test', clock, read({ ...testResult, chainRef: 'eip155:1' }))).rejects.toThrow('STUDIO_EVIDENCE_INVALID');
    await store.probe(id, verified, 'test', clock, read(testResult));
    const tested = await headOf(id);
    await expect(store.submit(id, tested, new Date(now.getTime() + 86_400_001))).rejects.toThrow('STUDIO_EVIDENCE_EXPIRED');
    await store.submit(id, tested, now);
    const submitted = await headOf(id);
    expect(submitted.status).toBe('CERTIFICATION_PENDING');
    expect(await studioReviewQueue(database.db, tenant, 20, now)).toEqual([
      expect.objectContaining({ project_id: id, slug: manifest.slug, version: 1, evidenceFresh: true }),
    ]);
    expect(await studioReviewQueue(database.db, 'other', 20, now)).toEqual([]);
    await expect(store.probe(id, submitted, 'verify', clock, read(verification))).rejects.toThrow('STUDIO_TRANSITION_FORBIDDEN');
    await store.create(id, { ...manifest, name: 'HyperEVM v2' }, now, submitted);
    const [next, prior] = await store.list(id);
    expect(next).toMatchObject({ version: 2, status: 'DRAFT' });
    expect(prior).toMatchObject({ version: 1, status: 'SUSPENDED', verification: null, test_result: null });
    await expect(store.submit(id, submitted, now)).rejects.toThrow('STUDIO_VERSION_CHANGED');
    await store.deactivate(id, next!, 'REVOKED', now);
    await expect(store.probe(id, await headOf(id), 'verify', clock, read(verification))).rejects.toThrow('STUDIO_TRANSITION_FORBIDDEN');
    const audit = await database.db.query('SELECT event, evidence FROM studio_integration_events WHERE project_id=$1 ORDER BY version,generation', [id]);
    expect(audit.rows.map(row => row.event)).toEqual(['CREATED', 'VERIFIED', 'TESTED', 'SUBMITTED', 'SUSPENDED', 'CREATED', 'REVOKED']);
    expect(audit.rows[2]?.evidence).toEqual(testResult);
  });

  it('invalidates contradictory evidence even when a submit wins the race', async () => {
    const id = await ownerProject.create('Divergent RPC', '', now);
    const store = studio();
    await store.create(id, manifest, now);
    await store.probe(id, await headOf(id), 'verify', clock, read(verification));
    await store.probe(id, await headOf(id), 'test', clock, read(testResult));
    const tested = await headOf(id);
    await expect(store.probe(id, tested, 'test', clock, async () => {
      throw new Error('STUDIO_RPC_UNAVAILABLE');
    })).rejects.toThrow('STUDIO_RPC_UNAVAILABLE');
    expect(await headOf(id)).toMatchObject({ generation: tested.generation, test_result: testResult });
    await expect(store.probe(id, tested, 'test', clock, async () => {
      await store.submit(id, tested, now);
      throw new Error('STUDIO_CHAIN_MISMATCH');
    })).rejects.toThrow('STUDIO_CHAIN_MISMATCH');
    const invalidated = await headOf(id);
    expect(invalidated).toMatchObject({ status: 'DRAFT', verification: null, test_result: null });
    await expect(store.submit(id, invalidated, now)).rejects.toThrow('STUDIO_TRANSITION_FORBIDDEN');
    expect(await studioReviewQueue(database.db, tenant, 20, now)).toEqual([]);
    expect((await database.db.query('SELECT evidence FROM studio_integration_events WHERE project_id=$1 AND event=$2',
      [id, 'INVALIDATED'])).rows).toEqual([{ evidence: { code: 'STUDIO_CHAIN_MISMATCH' } }]);
  });

  it('requires the project owner and active project at both probe start and commit', async () => {
    const id = await ownerProject.create('Access control', '', now);
    const another = await ownerProject.create('Same owner other project', '', now);
    await studio().create(id, manifest, now);
    const draft = await headOf(id);
    for (const foreign of [studio(outsider), studio(owner, 'other')]) {
      await expect(foreign.list(id)).resolves.toEqual([]);
      await expect(foreign.create(id, manifest, now)).rejects.toThrow('PROJECT_NOT_FOUND');
      await expect(foreign.probe(id, draft, 'verify', clock, read(verification))).rejects.toThrow('STUDIO_VERSION_NOT_FOUND');
    }
    await expect(studio().probe(another, draft, 'verify', clock, read(verification))).rejects.toThrow('STUDIO_VERSION_NOT_FOUND');
    await expect(studio().probe(id, draft, 'verify', clock, async value => {
      expect(value).toEqual(manifest);
      await ownerProject.disable(id, now);
      return verification;
    })).rejects.toThrow('PROJECT_NOT_ACTIVE');
    expect(await headOf(id)).toMatchObject({ status: 'DRAFT', verification: null });
  });

  it('cascades project-owned proposals and events on account deletion', async () => {
    const id = await createDeveloperConsoleStore(database.db, tenant, outsider).create('Account deletion', '', now);
    await studio(outsider).create(id, manifest, now);
    await database.db.query('DELETE FROM flofi_accounts WHERE tenant_id=$1 AND account_id=$2', [tenant, outsider]);
    for (const table of ['studio_integration_versions', 'studio_integration_events']) {
      expect((await database.db.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND project_id=$2`, [tenant, id])).rowCount).toBe(0);
    }
  });
});
