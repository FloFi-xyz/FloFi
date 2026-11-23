// SPDX-License-Identifier: AGPL-3.0-only
import { CERTIFIED_FORWARD_MIGRATIONS, type Database, type Queryable } from '@defi-workflow-engine/cloud-runtime';
import { PROJECT_ID } from '../developer/admin.ts';
import { parseStudioIntegration, studioManifestDigest, supportsStudioProbe, type StudioIntegration } from './integration-manifest.ts';
import type { ProbeMode, StudioEvidence } from './integration-probe.ts';
import { studioCertificationOwnsVersion } from './certification-store.ts';

const migration = CERTIFIED_FORWARD_MIGRATIONS.flatMap(entry => entry.migrations).find(entry => entry.name === 'studio_integrations');
const EVIDENCE_TTL = 24 * 60 * 60 * 1_000;
const MAX_PROJECT_VERSIONS = 100;
const SLUG = /^[a-z][a-z0-9-]{1,49}$/;

export type StudioStatus = 'DRAFT' | 'VERIFIED' | 'CERTIFICATION_PENDING' | 'CERTIFIED' | 'PUBLISHED' | 'SUSPENDED' | 'REVOKED';
export type StudioVersion = {
  slug: string; version: number; generation: number; manifest: StudioIntegration; manifest_sha256: string;
  status: StudioStatus; verification: StudioEvidence | null; test_result: StudioEvidence | null; updated_at: Date;
  adapter_submitted_at?: Date | null;
};
export type StudioRef = Pick<StudioVersion, 'slug' | 'version' | 'generation'>;
type Event = 'CREATED' | 'VERIFIED' | 'TESTED' | 'SUBMITTED' | 'INVALIDATED' | 'SUSPENDED' | 'REVOKED';
type EventEvidence = StudioEvidence | { code: Contradiction } | { kind: 'ADAPTER_SOURCE'; manifestSha256: string };
export type StudioActivity = { slug: string; version: number; generation: number; event: Event; at: Date };
const contradictions = ['STUDIO_CHAIN_MISMATCH', 'STUDIO_VAULT_ASSET_MISMATCH', 'STUDIO_VAULT_CODE_MISSING', 'STUDIO_VAULT_CODE_CHANGED'] as const;
type Contradiction = (typeof contradictions)[number];
const isContradiction = (cause: unknown): cause is Error & { message: Contradiction } =>
  cause instanceof Error && (contradictions as readonly string[]).includes(cause.message);

export async function studioInstalled(db: Queryable): Promise<boolean> {
  if (!migration) return false;
  return (await db.query('SELECT 1 FROM schema_migrations WHERE version=$1 AND name=$2 AND sha256=$3',
    [migration.version, migration.name, migration.sha256])).rowCount === 1;
}

export function freshStudioEvidence(evidence: StudioEvidence | null, now: Date): boolean {
  if (!evidence || !((evidence.schemaVersion === 1 && evidence.source === 'MAINNET_RPC')
    || (evidence.schemaVersion === 2 && evidence.source === 'PROPOSAL_RPC'))) return false;
  const age = now.getTime() - Date.parse(evidence.observedAt);
  return age >= 0 && age <= EVIDENCE_TTL;
}

/** Operator tooling reads a tenant's inbound proposals. Project-scoped user routes never call this queue. */
export async function studioReviewQueue(db: Queryable, tenantId: string, limit: number, now: Date) {
  const { rows } = await db.query<StudioVersion & { project_id: string }>(`SELECT s.project_id,s.slug,s.version,s.generation,
    s.manifest,s.manifest_sha256,s.status,s.verification,s.test_result,s.updated_at
    FROM studio_integration_versions s JOIN developer_projects p USING (tenant_id,project_id)
    WHERE s.tenant_id=$1 AND s.status='CERTIFICATION_PENDING' AND p.status='ACTIVE'
    ORDER BY s.updated_at,s.project_id,s.slug,s.version LIMIT $2`, [tenantId, limit]);
  return rows.map(row => ({ ...row, evidenceFresh: freshStudioEvidence(row.verification, now) && freshStudioEvidence(row.test_result, now) }));
}

const columns = 's.slug,s.version,s.generation,s.manifest,s.manifest_sha256,s.status,s.verification,s.test_result,s.updated_at';

export function createStudioStore(db: Database, tenantId: string, accountId: string) {
  if (!/^acct_[0-9a-f]{32}$/.test(accountId)) throw new Error('ACCOUNT_SESSION_REQUIRED');

  function scope(projectId: string) {
    if (!PROJECT_ID.test(projectId)) throw new Error('PROJECT_NOT_FOUND');
    return [tenantId, projectId, accountId] as const;
  }

  async function lockProject(tx: Queryable, projectId: string) {
    const args = scope(projectId);
    // Account deletion takes the account lock before removing ownership; project disable locks p.
    if (!(await tx.query('SELECT 1 FROM flofi_accounts WHERE tenant_id=$1 AND account_id=$2 FOR KEY SHARE', [tenantId, accountId])).rowCount) {
      throw new Error('ACCOUNT_SESSION_REQUIRED');
    }
    const { rows: [project] } = await tx.query<{ status: string }>(`SELECT p.status FROM developer_project_owners o
      JOIN developer_projects p USING (tenant_id,project_id)
      WHERE o.tenant_id=$1 AND o.project_id=$2 AND o.account_id=$3 FOR UPDATE OF p`, args);
    if (!project) throw new Error('PROJECT_NOT_FOUND');
    if (project.status !== 'ACTIVE') throw new Error('PROJECT_NOT_ACTIVE');
  }

  async function latest(q: Queryable, projectId: string, slug: string) {
    if (!SLUG.test(slug)) throw new Error('STUDIO_VERSION_NOT_FOUND');
    return (await q.query<StudioVersion>(`SELECT ${columns} FROM studio_integration_versions s
      JOIN developer_project_owners o USING (tenant_id, project_id)
      JOIN developer_projects p USING (tenant_id, project_id)
      WHERE s.tenant_id=$1 AND s.project_id=$2 AND o.account_id=$3 AND s.slug=$4 AND p.status='ACTIVE'
      ORDER BY s.version DESC LIMIT 1`, [...scope(projectId), slug])).rows[0];
  }

  async function current(q: Queryable, projectId: string, ref: StudioRef) {
    const row = await latest(q, projectId, ref.slug);
    if (!row) throw new Error('STUDIO_VERSION_NOT_FOUND');
    if (row.version !== ref.version || row.generation !== ref.generation) throw new Error('STUDIO_VERSION_CHANGED');
    const manifest = parseStudioIntegration(row.manifest);
    if (manifest.slug !== row.slug || studioManifestDigest(manifest) !== row.manifest_sha256) throw new Error('STUDIO_MANIFEST_INVALID');
    return { ...row, manifest };
  }

  async function audit(tx: Queryable, projectId: string, ref: StudioRef, event: Event, now: Date, evidence?: EventEvidence) {
    await tx.query(`INSERT INTO studio_integration_events (tenant_id,project_id,slug,version,generation,at,event,evidence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [tenantId, projectId, ref.slug, ref.version, ref.generation, now, event, evidence ?? null]);
  }

  async function advance(tx: Queryable, projectId: string, row: StudioVersion, status: StudioStatus, event: Event, now: Date,
    verification: StudioEvidence | null, testResult: StudioEvidence | null, evidence?: EventEvidence) {
    const generation = row.generation + 1;
    await tx.query(`UPDATE studio_integration_versions SET generation=$5,status=$6,verification=$7,test_result=$8,updated_at=$9
      WHERE tenant_id=$1 AND project_id=$2 AND slug=$3 AND version=$4`,
    [tenantId, projectId, row.slug, row.version, generation, status, verification, testResult, now]);
    await audit(tx, projectId, { ...row, generation }, event, now, evidence);
  }

  function checkProbe(row: StudioVersion, mode: ProbeMode, now: Date) {
    if (!supportsStudioProbe(row.manifest)) throw new Error('STUDIO_CONNECTOR_UNAVAILABLE');
    if (mode === 'verify' && (row.status === 'DRAFT' || row.status === 'VERIFIED')) return row.manifest;
    if (mode === 'test' && row.status === 'VERIFIED') {
      if (!freshStudioEvidence(row.verification, now)) throw new Error('STUDIO_EVIDENCE_EXPIRED');
      return row.manifest;
    }
    throw new Error('STUDIO_TRANSITION_FORBIDDEN');
  }

  async function recordProbe(projectId: string, ref: StudioRef, evidence: StudioEvidence, now: Date) {
    await db.transaction(async tx => {
      await lockProject(tx, projectId);
      const row = await current(tx, projectId, ref), manifest = checkProbe(row, evidence.mode, now);
      if (evidence.chainRef !== manifest.chainRef || !freshStudioEvidence(evidence, now)) throw new Error('STUDIO_EVIDENCE_INVALID');
      if (manifest.schemaVersion !== evidence.schemaVersion || (manifest.schemaVersion === 2 &&
        (evidence.schemaVersion !== 2 || manifest.adapter.kind !== 'builtin' || evidence.adapterId !== manifest.adapter.id
          || evidence.adapterVersion !== manifest.adapter.version || evidence.rpcUrl !== manifest.rpcUrl
          || (manifest.checkpoint !== undefined && evidence.checkpointHash !== manifest.checkpoint.hash)))) {
        throw new Error('STUDIO_EVIDENCE_INVALID');
      }
      if (evidence.mode === 'verify') {
        await advance(tx, projectId, row, 'VERIFIED', 'VERIFIED', now, evidence, null, evidence);
        return;
      }
      if (evidence.checkpointHash !== row.verification?.checkpointHash || evidence.rpcUrl !== row.verification.rpcUrl) {
        throw new Error('STUDIO_EVIDENCE_INVALID');
      }
      if (manifest.kind === 'vault' && (evidence.facts.vaultCodeSha256 !== row.verification.facts.vaultCodeSha256
        || evidence.facts.assetCodeSha256 !== row.verification.facts.assetCodeSha256)) throw new Error('STUDIO_VAULT_CODE_CHANGED');
      await advance(tx, projectId, row, 'VERIFIED', 'TESTED', now, row.verification, evidence, evidence);
    });
  }

  return {
    async list(projectId: string) {
      return (await db.query<StudioVersion>(`SELECT ${columns}, intake.at AS adapter_submitted_at FROM studio_integration_versions s
        JOIN developer_project_owners o USING (tenant_id,project_id)
        LEFT JOIN LATERAL (
          SELECT e.at FROM studio_integration_events e
          WHERE (e.tenant_id,e.project_id,e.slug,e.version)=(s.tenant_id,s.project_id,s.slug,s.version)
            AND e.event='SUBMITTED' AND e.evidence->>'kind'='ADAPTER_SOURCE'
          ORDER BY e.generation DESC LIMIT 1
        ) intake ON true
        WHERE s.tenant_id=$1 AND s.project_id=$2 AND o.account_id=$3 ORDER BY s.slug,s.version DESC`, scope(projectId))).rows;
    },
    async activity(projectId: string) {
      return (await db.query<StudioActivity>(`SELECT e.slug,e.version,e.generation,e.event,e.at
        FROM studio_integration_events e JOIN developer_project_owners o USING (tenant_id,project_id)
        WHERE e.tenant_id=$1 AND e.project_id=$2 AND o.account_id=$3
        ORDER BY e.at DESC,e.slug,e.version DESC,e.generation DESC LIMIT 100`, scope(projectId))).rows;
    },
    async create(projectId: string, input: unknown, now: Date, previous?: StudioRef) {
      const manifest = parseStudioIntegration(input);
      await db.transaction(async tx => {
        await lockProject(tx, projectId);
        const active = previous ? await current(tx, projectId, previous) : await latest(tx, projectId, manifest.slug);
        if (!previous && active) throw new Error('STUDIO_SLUG_EXISTS');
        if (previous && (manifest.slug !== previous.slug || active?.manifest.kind !== manifest.kind)) throw new Error('STUDIO_MANIFEST_INVALID');
        if (manifest.schemaVersion === 1 && active && (active.manifest.schemaVersion !== 1
          || active.status === 'CERTIFIED' || active.status === 'PUBLISHED')) throw new Error('STUDIO_TRANSITION_FORBIDDEN');
        const { rows: [count] } = await tx.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM studio_integration_versions WHERE tenant_id=$1 AND project_id=$2', [tenantId, projectId]);
        if ((count?.n ?? 0) >= MAX_PROJECT_VERSIONS) throw new Error('STUDIO_VERSION_LIMIT');
        if (manifest.schemaVersion === 1 && active && active.status !== 'REVOKED' && active.status !== 'SUSPENDED') {
          await advance(tx, projectId, active, 'SUSPENDED', 'SUSPENDED', now, null, null);
        }
        const version = (active?.version ?? 0) + 1;
        await tx.query(`INSERT INTO studio_integration_versions (tenant_id,project_id,slug,version,manifest,manifest_sha256,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, [tenantId, projectId, manifest.slug, version, manifest, studioManifestDigest(manifest), now]);
        await audit(tx, projectId, { slug: manifest.slug, version, generation: 0 }, 'CREATED', now);
      });
    },
    async probe(projectId: string, ref: StudioRef, mode: ProbeMode, now: () => Date,
      read: (manifest: StudioIntegration) => Promise<StudioEvidence>) {
      const manifest = checkProbe(await current(db, projectId, ref), mode, now());
      try {
        const evidence = await read(manifest);
        if (evidence.mode !== mode) throw new Error('STUDIO_EVIDENCE_INVALID');
        await recordProbe(projectId, ref, evidence, now());
      } catch (cause) {
        if (isContradiction(cause)) {
          await db.transaction(async tx => {
            await lockProject(tx, projectId);
            const row = await latest(tx, projectId, ref.slug);
            // Submit advances the generation once while preserving the same evidence. Successful probes replace evidence.
            const sameEvidence = row?.status === 'VERIFIED' && row.generation === ref.generation
              || row?.status === 'CERTIFICATION_PENDING' && row.generation === ref.generation + 1;
            if (row?.version === ref.version && sameEvidence) {
              await advance(tx, projectId, row, 'DRAFT', 'INVALIDATED', now(), null, null, { code: cause.message });
            }
          });
        }
        throw cause;
      }
    },
    async submit(projectId: string, ref: StudioRef, now: Date) {
      await db.transaction(async tx => {
        await lockProject(tx, projectId);
        const row = await current(tx, projectId, ref);
        if (row.status !== 'VERIFIED') throw new Error('STUDIO_TRANSITION_FORBIDDEN');
        if (!row.test_result) throw new Error('STUDIO_TEST_REQUIRED');
        if (!freshStudioEvidence(row.verification, now) || !freshStudioEvidence(row.test_result, now)) {
          throw new Error('STUDIO_EVIDENCE_EXPIRED');
        }
        await advance(tx, projectId, row, 'CERTIFICATION_PENDING', 'SUBMITTED', now, row.verification, row.test_result);
      });
    },
    async submitAdapter(projectId: string, ref: StudioRef, now: Date) {
      await db.transaction(async tx => {
        await lockProject(tx, projectId);
        const row = await current(tx, projectId, ref);
        if (row.status !== 'DRAFT' || row.generation !== 0 || row.manifest.schemaVersion !== 2 || row.manifest.adapter.kind !== 'external') {
          throw new Error('STUDIO_TRANSITION_FORBIDDEN');
        }
        await advance(tx, projectId, row, 'DRAFT', 'SUBMITTED', now, null, null,
          { kind: 'ADAPTER_SOURCE', manifestSha256: row.manifest_sha256 });
      });
    },
    async deactivate(projectId: string, ref: StudioRef, status: 'SUSPENDED' | 'REVOKED', now: Date) {
      await db.transaction(async tx => {
        await lockProject(tx, projectId);
        const row = await current(tx, projectId, ref);
        if (row.status === 'REVOKED' || row.status === status || row.status === 'CERTIFIED' || row.status === 'PUBLISHED'
          || (status === 'SUSPENDED' && row.status === 'DRAFT')
          || await studioCertificationOwnsVersion(tx, tenantId, projectId, row.slug, row.version)) {
          throw new Error('STUDIO_TRANSITION_FORBIDDEN');
        }
        await advance(tx, projectId, row, status, status, now, null, null);
      });
    },
  };
}
