// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-STUDIO-UNIVERSAL-002: the certified Studio metadata catalog, read by the Developer API, MCP and the product shell from
 * this one module. It only reads. Results are tenant-scoped, and PRIVATE entries resolve per request from verified server principals
 * (never from client input). Every row is checked again against its certified manifest, adapter and evidence digests before it is
 * returned. Published metadata grants no financial authority: execution still needs a compiled, reviewed runtime profile, a fresh
 * simulation, the owner's Review and the owner's wallet signature.
 */
import { createHash } from 'node:crypto';
import { executionCapabilityRegistry } from '@defi-workflow-engine/action-registry';
import { CERTIFIED_FORWARD_MIGRATIONS, type Queryable } from '@defi-workflow-engine/cloud-runtime';
import { defineIntegrationPackage, type IntegrationPackage } from '@defi-workflow-engine/developer-sdk';
import { isTestNetwork } from '../domain/network-scope.ts';
import { studioManifestDigest } from '../studio/integration-manifest.ts';
import { assertSafeOutput } from './output-guard.ts';

const migration = CERTIFIED_FORWARD_MIGRATIONS.flatMap(entry => entry.migrations).find(entry => entry.name === 'studio_certification');
export const STUDIO_ACCOUNT_ID = /^acct_[a-f0-9]{32}$/;
/** The `typedId('prj')` format (ids.ts). */
export const STUDIO_PROJECT_ID = /^prj_[a-z2-7]{26}$/;

export type StudioMetadataCapability = 'network.read' | 'vault.read';
export type StudioVisibility = 'PUBLIC' | 'PRIVATE';
export type PublishedStudioIntegration = {
  readonly projectId: string; readonly slug: string; readonly version: number; readonly revision: string; readonly manifestSha256: string;
  readonly name: string; readonly kind: IntegrationPackage['kind']; readonly architecture: IntegrationPackage['architecture'];
  readonly chainRef: string; readonly deploymentRef?: string; readonly capabilities: readonly StudioMetadataCapability[];
  readonly visibility: StudioVisibility;
};

export const studioDigest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return Object.fromEntries(entries.map(([key, item]) => [key, sortedJson(item)]));
}
export const studioEvidenceDigest = (value: unknown) => studioDigest(sortedJson(value));

export async function studioCertificationInstalled(db: Queryable): Promise<boolean> {
  if (!migration) return false;
  return (await db.query('SELECT 1 FROM schema_migrations WHERE version=$1 AND name=$2 AND sha256=$3',
    [migration.version, migration.name, migration.sha256])).rowCount === 1;
}

const canonicalNetwork = (chain: string) => executionCapabilityRegistry.some(item => item.chainId === chain);
/** The single metadata capability a package may be certified for. Existing FloFi networks are never re-certified through Studio. */
export function studioMetadataCapability(manifest: IntegrationPackage): StudioMetadataCapability {
  const fail = (): never => { throw new Error('STUDIO_CERTIFICATION_UNSUPPORTED'); };
  if (manifest.environment !== 'mainnet' || !manifest.chainRef || !manifest.rpcUrl || manifest.adapter.kind !== 'builtin'
    || manifest.dependencies.length !== 0 || isTestNetwork(manifest.chainRef) || manifest.adapter.id === 'cosmos-rpc'
    || manifest.kind === 'network' && canonicalNetwork(manifest.chainRef)) return fail();
  const capability = manifest.kind === 'vault' ? 'vault.read' : 'network.read';
  if (!manifest.capabilities.includes(capability)) return fail();
  return capability;
}

/** The current publication head of every package, joined to its certified, unrevoked and unchanged version. */
export const ACTIVE_STUDIO_PUBLICATIONS = `WITH heads AS (
  SELECT DISTINCT ON (project_id,slug) project_id,slug,version,action,revision,visibility,audience
  FROM studio_publication_events WHERE tenant_id=$1 AND action<>'REVOKE' ORDER BY project_id,slug,revision DESC
), active AS (
  SELECT h.*,s.manifest,s.manifest_sha256,c.adapter_sha256,c.evidence_sha256,c.evidence,c.capabilities
  FROM heads h
  JOIN studio_integration_versions s ON s.tenant_id=$1 AND s.project_id=h.project_id AND s.slug=h.slug AND s.version=h.version
  JOIN studio_certifications c ON c.tenant_id=s.tenant_id AND c.project_id=s.project_id AND c.slug=s.slug AND c.version=s.version
  JOIN developer_projects p ON p.tenant_id=s.tenant_id AND p.project_id=s.project_id
  WHERE h.action<>'SUSPEND' AND p.status='ACTIVE' AND s.status='CERTIFICATION_PENDING'
    AND s.generation=c.source_generation AND c.decision='CERTIFIED' AND s.manifest_sha256=c.manifest_sha256
    AND NOT EXISTS(SELECT 1 FROM studio_publication_events r WHERE r.tenant_id=s.tenant_id AND r.project_id=s.project_id
      AND r.slug=s.slug AND r.version=s.version AND r.action='REVOKE')
)`;

type CatalogRow = { project_id: string; slug: string; version: number; revision: string; manifest: unknown; manifest_sha256: string;
  adapter_sha256: string; evidence_sha256: string; evidence: unknown; capabilities: StudioMetadataCapability[]; visibility: StudioVisibility };

/** The account and project IDs are verified server principals. Public results omit RPC URLs, sources and private audience membership. */
export async function listPublishedStudioIntegrations(db: Queryable, tenantId: string,
  requester: { readonly accountId?: string; readonly projectId?: string } = {}): Promise<PublishedStudioIntegration[]> {
  if (!await studioCertificationInstalled(db)) return [];
  const account = requester.accountId && STUDIO_ACCOUNT_ID.test(requester.accountId) ? requester.accountId : null;
  const project = requester.projectId && STUDIO_PROJECT_ID.test(requester.projectId) ? requester.projectId : null;
  const { rows } = await db.query<CatalogRow>(`${ACTIVE_STUDIO_PUBLICATIONS}
    SELECT project_id,slug,version,revision::text,manifest,manifest_sha256,adapter_sha256,evidence_sha256,evidence,capabilities,visibility
    FROM active WHERE visibility='PUBLIC' OR (
      EXISTS(SELECT 1 FROM flofi_accounts WHERE tenant_id=$1 AND account_id=$2 AND 'account:'||account_id=ANY(audience))
      OR EXISTS(SELECT 1 FROM developer_projects p WHERE p.tenant_id=$1 AND p.project_id=$3 AND p.status='ACTIVE'
        AND 'project:'||p.project_id=ANY(audience))
    ) ORDER BY project_id,slug LIMIT 250`, [tenantId, account, project]);
  return rows.flatMap(row => {
    try {
      const manifest = defineIntegrationPackage(row.manifest);
      if (studioManifestDigest(manifest) !== row.manifest_sha256 || studioDigest(manifest.adapter) !== row.adapter_sha256
        || studioEvidenceDigest(row.evidence) !== row.evidence_sha256 || row.capabilities[0] !== studioMetadataCapability(manifest)) return [];
      const entry: PublishedStudioIntegration = { projectId: row.project_id, slug: row.slug, version: row.version, revision: row.revision,
        manifestSha256: row.manifest_sha256, name: manifest.name, kind: manifest.kind, architecture: manifest.architecture,
        chainRef: manifest.chainRef!, ...(manifest.deploymentRef ? { deploymentRef: manifest.deploymentRef } : {}),
        capabilities: row.capabilities, visibility: row.visibility };
      // Publisher-chosen text that a surface's output guard would refuse drops only this entry, never the caller's whole discovery response.
      assertSafeOutput(entry);
      return [entry];
    } catch { return []; }
  });
}
