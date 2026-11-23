// SPDX-License-Identifier: AGPL-3.0-only
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { defineIntegrationPackage, integrationEndpoint, type IntegrationPackage } from '@defi-workflow-engine/developer-sdk';
import type { AdminContext } from '../admin/guard.ts';
import { recordAudit } from '../admin/store.ts';
import {
  ACTIVE_STUDIO_PUBLICATIONS, STUDIO_ACCOUNT_ID as ACCOUNT_ID, STUDIO_PROJECT_ID as PROJECT_ID, studioCertificationInstalled,
  studioDigest as digest, studioEvidenceDigest as evidenceDigest, studioMetadataCapability as metadataCapability,
  type StudioMetadataCapability as Capability, type StudioVisibility as Visibility,
} from '../platform/studio-catalog.ts';
import { probeStudioIntegration } from './integration-probe.ts';
import { studioManifestDigest } from './integration-manifest.ts';

export { listPublishedStudioIntegrations, studioCertificationInstalled, type PublishedStudioIntegration } from '../platform/studio-catalog.ts';
const SLUG = /^[a-z][a-z0-9-]{1,49}$/;
const REVISION = /^(0|[1-9][0-9]{0,18})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const EVIDENCE_TTL = 86_400_000;
const DECISION_ACTIONS = ['approve', 'reject', 'publish', 'rollback', 'suspend', 'revoke'] as const;

type Target = { readonly projectId: string; readonly slug: string; readonly version: number; readonly generation: number };
export type StudioDecision = Target & { readonly reason: string; readonly catalogRevision: string } & (
  | { readonly action: 'approve'; readonly reference: string; readonly rpcUrl: string }
  | { readonly action: 'publish' | 'rollback'; readonly visibility: Visibility; readonly audience: readonly string[] }
  | { readonly action: 'reject' | 'suspend' | 'revoke' }
);
type Proposal = { manifest: unknown; manifest_sha256: string; generation: number; status: string;
  verification: unknown; test_result: unknown; owner: string; adapter_submitted: boolean };
type Certified = { decision: 'CERTIFIED' | 'REJECTED'; source_generation: number; manifest_sha256: string;
  adapter_sha256: string; evidence_sha256: string; evidence: unknown; capabilities: Capability[]; reason: string };
type Publication = { version: number; action: 'PUBLISH' | 'ROLLBACK' | 'SUSPEND'; revision: string; visibility: Visibility | null };
type Evidence = { schemaVersion: number; mode: 'verify' | 'test'; source: 'PROPOSAL_RPC';
  chainRef: string; rpcUrl: string; observedAt: string; adapterId: string; adapterVersion: number; checkpointHash: string | null;
  facts: Record<string, string | boolean> };

const fail = (code: string): never => { throw new Error(code); };
const invalid = () => fail('STUDIO_CERTIFICATION_REQUEST_INVALID');
/** Called under the developer project lock by the proposal store. A reviewed version uses the admin lifecycle. */
export async function studioCertificationOwnsVersion(db: Queryable, tenantId: string, projectId: string, slug: string, version: number) {
  if (!await studioCertificationInstalled(db)) return false;
  return Boolean((await db.query(`SELECT 1 FROM studio_certifications
    WHERE tenant_id=$1 AND project_id=$2 AND slug=$3 AND version=$4 AND decision='CERTIFIED'`, [tenantId, projectId, slug, version])).rowCount);
}

const validInteger = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 2_147_483_647;

function audienceEntry(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.startsWith('account:')) return ACCOUNT_ID.test(value.slice(8));
  return value.startsWith('project:') && PROJECT_ID.test(value.slice(8));
}

export function parseStudioDecision(body: Record<string, unknown>): StudioDecision {
  const { action, projectId, slug, version, generation, reason, catalogRevision } = body;
  if (!DECISION_ACTIONS.includes(action as typeof DECISION_ACTIONS[number]) || typeof projectId !== 'string' || !PROJECT_ID.test(projectId)
    || typeof slug !== 'string' || !SLUG.test(slug) || !validInteger(version, 1) || !validInteger(generation, 0)
    || typeof reason !== 'string' || reason.length < 1 || reason.length > 500 || reason.trim() !== reason || /[\p{Cc}\p{Cf}]/u.test(reason)
    || typeof catalogRevision !== 'string' || !REVISION.test(catalogRevision)) return invalid();
  const base = { projectId, slug, version, generation, reason, catalogRevision };
  const common = ['action', 'projectId', 'slug', 'version', 'generation', 'reason', 'catalogRevision'];
  const closed = (fields: string[]) => {
    if (Object.keys(body).length !== common.length + fields.length || Object.keys(body).some(key => !common.includes(key) && !fields.includes(key))) invalid();
  };
  switch (action) {
    case 'approve': {
      closed(['reference', 'rpcUrl']);
      return { ...base, action, reference: integrationEndpoint(body.reference), rpcUrl: integrationEndpoint(body.rpcUrl) };
    }
    case 'publish':
    case 'rollback': {
      closed(['visibility', 'audience']);
      const { visibility, audience } = body;
      if (visibility !== 'PUBLIC' && visibility !== 'PRIVATE' || !Array.isArray(audience) || audience.length > 16
        || !audience.every(audienceEntry) || new Set(audience).size !== audience.length
        || (visibility === 'PRIVATE') !== (audience.length > 0)) return invalid();
      return { ...base, action, visibility, audience: [...audience].sort() };
    }
    case 'reject':
    case 'suspend':
    case 'revoke':
      closed([]);
      return { ...base, action };
    default: return invalid();
  }
}

/**
 * Retained certification evidence is append-only and outlives the owner's account, so it keeps an RPC endpoint's origin and a digest of
 * the full URL, never a path that may embed a provider key. The proposal's own copy (schema 0035) is deleted with the owner's account.
 */
function retainedEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(retainedEvidence);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]): [string, unknown][] => key === 'rpcUrl' && typeof item === 'string'
    ? [['rpcOrigin', new URL(item).origin], ['rpcUrlSha256', digest(item)]] : [[key, retainedEvidence(item)]]));
}

const scope = (tenantId: string, target: Target) => [tenantId, target.projectId, target.slug, target.version] as const;
const sameHost = (a: string, b: string) => new URL(a).hostname === new URL(b).hostname;

async function readProposal(q: Queryable, tenantId: string, target: Target, requireLatest: boolean): Promise<Proposal> {
  // Take the same lock as the owner store, then read the proposal in a new statement snapshot.
  if (!(await q.query(`SELECT 1 FROM developer_projects WHERE tenant_id=$1 AND project_id=$2 AND status='ACTIVE' FOR UPDATE`,
    [tenantId, target.projectId])).rowCount) return fail('STUDIO_CERTIFICATION_VERSION_UNAVAILABLE');
  const { rows: [row] } = await q.query<Proposal>(`SELECT s.manifest,s.manifest_sha256,s.generation,s.status,s.verification,s.test_result,o.account_id AS owner,
    EXISTS(SELECT 1 FROM studio_integration_events e WHERE e.tenant_id=s.tenant_id AND e.project_id=s.project_id AND e.slug=s.slug
      AND e.version=s.version AND e.event='SUBMITTED' AND e.evidence->>'kind'='ADAPTER_SOURCE'
      AND e.evidence->>'manifestSha256'=s.manifest_sha256) AS adapter_submitted
    FROM studio_integration_versions s JOIN developer_projects p USING (tenant_id,project_id)
    JOIN developer_project_owners o USING (tenant_id,project_id)
    WHERE s.tenant_id=$1 AND s.project_id=$2 AND s.slug=$3 AND s.version=$4 AND p.status='ACTIVE'
    AND (NOT $5::boolean OR NOT EXISTS (
      SELECT 1 FROM studio_integration_versions n WHERE n.tenant_id=s.tenant_id AND n.project_id=s.project_id AND n.slug=s.slug AND n.version>s.version
    ))`, [...scope(tenantId, target), requireLatest]);
  if (!row) return fail('STUDIO_CERTIFICATION_VERSION_UNAVAILABLE');
  if (row.generation !== target.generation) return fail('STUDIO_CERTIFICATION_VERSION_CHANGED');
  return row;
}

function proposalPackage(row: Proposal): IntegrationPackage {
  const manifest = defineIntegrationPackage(row.manifest);
  if (studioManifestDigest(manifest) !== row.manifest_sha256) return fail('STUDIO_MANIFEST_INVALID');
  return manifest;
}

type Reviewer = { readonly accountId: string; readonly expiresAt: Date };
function requireFreshReviewer(reviewer: Reviewer, now: Date) {
  if (reviewer.expiresAt <= now) return fail('STUDIO_CERTIFICATION_OPERATOR_REQUIRED');
}

async function requireReviewer(q: Queryable, tenantId: string, actor: AdminContext, clock: () => Date): Promise<Reviewer> {
  const principalId = actor.principal.principalId;
  const { rows: [principal] } = await q.query<{ account: string }>(`SELECT account FROM admin_principals
    WHERE tenant_id=$1 AND principal_id=$2 AND role='OPERATOR' AND state='ACTIVE' FOR SHARE`, [tenantId, principalId]);
  if (!principal || principal.account !== actor.principal.account) return fail('STUDIO_CERTIFICATION_OPERATOR_REQUIRED');
  const { rows: [session] } = await q.query<{ expires_at: Date }>(`SELECT expires_at FROM admin_sessions
    WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3 AND ended_at IS NULL FOR SHARE`, [tenantId, principalId, actor.sessionId]);
  if (!session) return fail('STUDIO_CERTIFICATION_OPERATOR_REQUIRED');
  const { rows: [identity] } = await q.query<{ account_id: string }>(`SELECT account_id FROM flofi_account_identities
    WHERE tenant_id=$1 AND kind='EIP155' AND subject=$2 FOR SHARE`, [tenantId, principal.account]);
  if (!identity) return fail('STUDIO_CERTIFICATION_REVIEWER_UNBOUND');
  const reviewer = { accountId: identity.account_id, expiresAt: session.expires_at };
  requireFreshReviewer(reviewer, clock());
  return reviewer;
}

async function requireIndependentAccount(q: Queryable, tenantId: string, actor: AdminContext, reviewer: string, owner: string) {
  if (owner === reviewer || (await q.query(`SELECT 1 FROM flofi_account_wallets WHERE tenant_id=$1 AND account_id=$2
    AND ecosystem='EVM' AND address=$3`, [tenantId, owner, actor.principal.account])).rowCount)
    return fail('STUDIO_CERTIFICATION_SELF_REVIEW');
}

function evidenceFor(value: unknown, manifest: IntegrationPackage, mode: Evidence['mode'], now: Date): Evidence {
  const ev = value as Partial<Evidence> | null;
  if (!ev || ev.schemaVersion !== 2 || ev.mode !== mode || ev.source !== 'PROPOSAL_RPC' || manifest.adapter.kind !== 'builtin'
    || ev.adapterId !== manifest.adapter.id || ev.adapterVersion !== manifest.adapter.version || ev.chainRef !== manifest.chainRef
    || ev.rpcUrl !== manifest.rpcUrl || !ev.facts
    || typeof ev.facts !== 'object' || Array.isArray(ev.facts) || typeof ev.observedAt !== 'string') return fail('STUDIO_CERTIFICATION_EVIDENCE_INVALID');
  const checkpointMatches = manifest.adapter.id === 'svm-rpc'
    ? typeof ev.checkpointHash === 'string' && `solana:${ev.checkpointHash.slice(0, 32)}` === manifest.chainRef
    : ev.checkpointHash === manifest.checkpoint?.hash;
  if (!checkpointMatches) return fail('STUDIO_CERTIFICATION_EVIDENCE_INVALID');
  const age = now.getTime() - Date.parse(ev.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > EVIDENCE_TTL) return fail('STUDIO_CERTIFICATION_EVIDENCE_EXPIRED');
  return ev as Evidence;
}

function sameVaultIdentity(a: Evidence, b: Evidence) {
  if (typeof a.facts.vaultCodeSha256 !== 'string' || !DIGEST.test(a.facts.vaultCodeSha256)
    || typeof a.facts.assetCodeSha256 !== 'string' || !DIGEST.test(a.facts.assetCodeSha256)
    || ['vaultCodeSha256', 'assetCodeSha256', 'asset', 'assetDecimals', 'shareDecimals'].some(key => a.facts[key] !== b.facts[key]))
    return fail('STUDIO_CERTIFICATION_VAULT_CHANGED');
}

async function publication(q: Queryable, tenantId: string, target: Target) {
  return (await q.query<Publication>(`SELECT version,action,revision::text,visibility FROM studio_publication_events
    WHERE tenant_id=$1 AND project_id=$2 AND slug=$3 AND action<>'REVOKE' ORDER BY revision DESC LIMIT 1`, scope(tenantId, target).slice(0, 3))).rows[0];
}

async function isRevoked(q: Queryable, tenantId: string, target: Target) {
  return Boolean((await q.query(`SELECT 1 FROM studio_publication_events
    WHERE tenant_id=$1 AND project_id=$2 AND slug=$3 AND version=$4 AND action='REVOKE'`, scope(tenantId, target))).rowCount);
}

type Probe = (manifest: IntegrationPackage, mode: 'test', now: Date) => Promise<unknown>;
export async function decideStudioCertification(db: Database, tenantId: string, actor: AdminContext, decision: StudioDecision,
  clock = () => new Date(), probe: Probe = probeStudioIntegration) {
  const reviewDecision = decision.action === 'approve' || decision.action === 'reject';
  const target = scope(tenantId, decision);
  let independent: Evidence | null = null;
  if (decision.action === 'approve') {
    // Refuse stale or self reviews before issuing any outbound request. Recheck both after the request.
    const row = await db.transaction(async tx => {
      const reviewer = await requireReviewer(tx, tenantId, actor, clock);
      const found = await readProposal(tx, tenantId, decision, true);
      await requireIndependentAccount(tx, tenantId, actor, reviewer.accountId, found.owner);
      requireFreshReviewer(reviewer, clock());
      return found;
    });
    const manifest = proposalPackage(row), now = clock();
    metadataCapability(manifest);
    if (row.status !== 'CERTIFICATION_PENDING') return fail('STUDIO_CERTIFICATION_TRANSITION_FORBIDDEN');
    evidenceFor(row.verification, manifest, 'verify', now);
    evidenceFor(row.test_result, manifest, 'test', now);
    if (sameHost(decision.rpcUrl, manifest.rpcUrl!) || sameHost(decision.reference, manifest.rpcUrl!))
      return fail('STUDIO_CERTIFICATION_REFERENCE_NOT_INDEPENDENT');
    const independentManifest = { ...manifest, rpcUrl: decision.rpcUrl };
    independent = evidenceFor(await probe(independentManifest, 'test', now), independentManifest, 'test', clock());
  }
  return db.transaction(async tx => {
    const reviewer = await requireReviewer(tx, tenantId, actor, clock);
    const row = await readProposal(tx, tenantId, decision, reviewDecision || decision.action === 'publish');
    await requireIndependentAccount(tx, tenantId, actor, reviewer.accountId, row.owner);
    const manifest = proposalPackage(row);
    const head = await publication(tx, tenantId, decision);
    if ((head?.revision ?? '0') !== decision.catalogRevision) return fail('STUDIO_CERTIFICATION_VERSION_CHANGED');
    const existing = (await tx.query<Certified>(`SELECT * FROM studio_certifications
      WHERE tenant_id=$1 AND project_id=$2 AND slug=$3 AND version=$4`, target)).rows[0];
    const now = clock();
    requireFreshReviewer(reviewer, now);
    let result: string;
    if (reviewDecision) {
      if (existing || row.status !== 'CERTIFICATION_PENDING' && !(decision.action === 'reject' && row.adapter_submitted && row.status === 'DRAFT'))
        return fail('STUDIO_CERTIFICATION_TRANSITION_FORBIDDEN');
      const capabilities: Capability[] = [];
      const evidence: Record<string, unknown> = { verification: row.verification, tests: row.test_result, adapterSubmitted: row.adapter_submitted };
      if (decision.action === 'approve') {
        const capability = metadataCapability(manifest);
        const verified = evidenceFor(row.verification, manifest, 'verify', now);
        const tested = evidenceFor(row.test_result, manifest, 'test', now);
        const corroboration = evidenceFor(independent, { ...manifest, rpcUrl: decision.rpcUrl }, 'test', now);
        if (verified.checkpointHash !== tested.checkpointHash || verified.checkpointHash !== corroboration.checkpointHash)
          return fail('STUDIO_CERTIFICATION_EVIDENCE_INVALID');
        if (capability === 'vault.read') {
          sameVaultIdentity(verified, tested);
          sameVaultIdentity(verified, corroboration);
        }
        capabilities.push(capability);
        evidence.corroboration = { evidence: corroboration, reference: decision.reference };
      }
      result = decision.action === 'approve' ? 'CERTIFIED' : 'REJECTED';
      const retained = retainedEvidence(evidence);
      await tx.query(`INSERT INTO studio_certifications
        (tenant_id,project_id,slug,version,source_generation,decision,manifest_sha256,adapter_sha256,evidence_sha256,evidence,
         capabilities,actor,reason,decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [...target, row.generation, result, row.manifest_sha256, digest(manifest.adapter), evidenceDigest(retained), retained,
        capabilities, actor.principal.principalId, decision.reason, now]);
    } else {
      if (!existing || existing.decision !== 'CERTIFIED' || existing.manifest_sha256 !== row.manifest_sha256
        || existing.adapter_sha256 !== digest(manifest.adapter) || existing.evidence_sha256 !== evidenceDigest(existing.evidence)
        || await isRevoked(tx, tenantId, decision)) return fail('STUDIO_CERTIFICATION_TRANSITION_FORBIDDEN');
      const publishing = decision.action === 'publish' || decision.action === 'rollback';
      if (publishing) {
        if (row.status !== 'CERTIFICATION_PENDING' || row.generation !== existing.source_generation
          || existing.capabilities[0] !== metadataCapability(manifest)
          || decision.action === 'rollback' && (!head || head.version <= decision.version))
          return fail('STUDIO_CERTIFICATION_TRANSITION_FORBIDDEN');
        // A tenant can publish one authoritative package per chain or deployment identity. Publication writers share this lock.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`studio-catalog:${tenantId}`]);
        await requireUniquePublication(tx, tenantId, decision, manifest);
        await requireAudience(tx, tenantId, decision.audience);
      }
      if (decision.action === 'suspend' && (head?.version !== decision.version || head.action === 'SUSPEND'))
        return fail('STUDIO_CERTIFICATION_TRANSITION_FORBIDDEN');
      const action = decision.action.toUpperCase();
      await tx.query(`INSERT INTO studio_publication_events
        (tenant_id,project_id,slug,version,action,visibility,audience,actor,reason,changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [...target, action, publishing ? decision.visibility : null, publishing ? decision.audience : [], actor.principal.principalId, decision.reason, now]);
      result = { publish: 'PUBLISHED', rollback: 'PUBLISHED', suspend: 'SUSPENDED', revoke: 'REVOKED' }[decision.action];
    }
    await recordAudit(tx, tenantId, { actor: actor.principal.principalId, kind: `ADMIN_STUDIO_${decision.action.toUpperCase()}`,
      outcome: 'OK', target: `${decision.projectId}:${decision.slug}:${decision.version}`, detail: { status: result, manifestSha256: row.manifest_sha256 } });
    requireFreshReviewer(reviewer, clock());
    return { status: result };
  });
}

async function requireAudience(q: Queryable, tenantId: string, audience: readonly string[]) {
  if (!audience.length) return;
  const { rows: [valid] } = await q.query<{ count: number }>(`SELECT (
    (SELECT count(*) FROM flofi_accounts WHERE tenant_id=$1 AND 'account:'||account_id=ANY($2::text[]))
    + (SELECT count(*) FROM developer_projects WHERE tenant_id=$1 AND status='ACTIVE' AND 'project:'||project_id=ANY($2::text[]))
    )::int AS count`, [tenantId, audience]);
  if (valid?.count !== audience.length) return fail('STUDIO_CERTIFICATION_AUDIENCE_UNAVAILABLE');
}

async function requireUniquePublication(q: Queryable, tenantId: string, decision: Target, manifest: IntegrationPackage) {
  const conflict = await q.query(`${ACTIVE_STUDIO_PUBLICATIONS}
    SELECT 1 FROM active WHERE (project_id,slug)<>($2,$3)
      AND manifest->>'kind'=$4 AND manifest->>'chainRef'=$5 AND manifest->>'deploymentRef' IS NOT DISTINCT FROM $6 LIMIT 1`,
  [tenantId, decision.projectId, decision.slug, manifest.kind, manifest.chainRef, manifest.deploymentRef ?? null]);
  if (conflict.rowCount) return fail('STUDIO_CERTIFICATION_CATALOG_CONFLICT');
}

export type StudioReviewRow = { readonly project_id: string; readonly slug: string; readonly version: number; readonly generation: number;
  readonly manifest: Record<string, unknown>; readonly manifest_sha256: string; readonly verification: unknown; readonly test_result: unknown;
  readonly status: 'CERTIFICATION_PENDING' | 'ADAPTER_SUBMITTED' | 'CERTIFIED' | 'REJECTED' | 'PUBLISHED' | 'SUSPENDED' | 'REVOKED';
  readonly catalog_revision: string; readonly published_version: number | null; readonly latest_version: number; readonly decision_reason: string | null };
const RESOLVED_STATUS = `CASE WHEN r.revoked THEN 'REVOKED'
      WHEN h.version=s.version AND h.action='SUSPEND' THEN 'SUSPENDED'
      WHEN c.decision='CERTIFIED' AND (s.status<>'CERTIFICATION_PENDING' OR c.source_generation<>s.generation OR p.status<>'ACTIVE') THEN 'SUSPENDED'
      WHEN h.version=s.version AND h.action IS NOT NULL AND s.status='CERTIFICATION_PENDING' AND c.source_generation=s.generation THEN 'PUBLISHED'
      WHEN c.decision IS NOT NULL THEN c.decision
      WHEN s.status='DRAFT' THEN 'ADAPTER_SUBMITTED' ELSE 'CERTIFICATION_PENDING' END`;
const REVIEW_JOINS = `FROM studio_integration_versions s JOIN developer_projects p USING (tenant_id,project_id)
    LEFT JOIN studio_certifications c USING (tenant_id,project_id,slug,version)
    LEFT JOIN LATERAL (
      SELECT version,revision,action,visibility,reason FROM studio_publication_events e WHERE e.tenant_id=s.tenant_id AND e.project_id=s.project_id
        AND e.slug=s.slug AND e.action<>'REVOKE' ORDER BY revision DESC LIMIT 1
    ) h ON true
    LEFT JOIN LATERAL (
      SELECT true AS revoked,reason FROM studio_publication_events e WHERE e.tenant_id=s.tenant_id AND e.project_id=s.project_id
        AND e.slug=s.slug AND e.version=s.version AND e.action='REVOKE'
    ) r ON true`;
const DECISION_REASON = `coalesce(r.reason,CASE WHEN h.version=s.version THEN h.reason END,c.reason)`;

export async function studioCertificationQueue(db: Queryable, tenantId: string): Promise<StudioReviewRow[]> {
  return (await db.query<StudioReviewRow>(`SELECT q.project_id,q.slug,q.version,q.generation,q.manifest,q.manifest_sha256,q.verification,q.test_result,
    q.status,q.catalog_revision,q.published_version,q.latest_version,q.decision_reason FROM (
    SELECT s.project_id,s.slug,s.version,s.generation,s.manifest,s.manifest_sha256,s.verification,s.test_result,s.updated_at,
    ${RESOLVED_STATUS} AS status,coalesce(h.revision::text,'0') AS catalog_revision,h.version AS published_version,n.latest_version,
    c.decision IS NULL AND s.manifest->>'schemaVersion'='2' AND n.latest_version=s.version AS awaiting_review,
    ${DECISION_REASON} AS decision_reason ${REVIEW_JOINS}
    CROSS JOIN LATERAL (SELECT max(v.version) AS latest_version FROM studio_integration_versions v
      WHERE v.tenant_id=s.tenant_id AND v.project_id=s.project_id AND v.slug=s.slug) n
    WHERE s.tenant_id=$1 AND p.status='ACTIVE' AND (c.decision IS NOT NULL OR s.status='CERTIFICATION_PENDING'
      OR s.status='DRAFT' AND EXISTS (SELECT 1 FROM studio_integration_events e WHERE e.tenant_id=s.tenant_id AND e.project_id=s.project_id
        AND e.slug=s.slug AND e.version=s.version AND e.event='SUBMITTED' AND e.evidence->>'kind'='ADAPTER_SOURCE'
        AND e.evidence->>'manifestSha256'=s.manifest_sha256))
    ) q ORDER BY q.awaiting_review DESC,CASE WHEN q.awaiting_review THEN q.updated_at END,
      q.updated_at DESC,q.project_id,q.slug,q.version DESC LIMIT 100`, [tenantId])).rows;
}

export type StudioOwnerCertificationStatus = {
  readonly slug: string; readonly version: number;
  readonly status: Exclude<StudioReviewRow['status'], 'CERTIFICATION_PENDING' | 'ADAPTER_SUBMITTED'>;
  readonly reason: string; readonly visibility: Visibility | null;
};

export async function listStudioOwnerCertificationStatus(db: Queryable, tenantId: string, accountId: string, projectId: string) {
  if (!ACCOUNT_ID.test(accountId) || !PROJECT_ID.test(projectId) || !await studioCertificationInstalled(db)) return [];
  return (await db.query<StudioOwnerCertificationStatus>(`SELECT rows.slug,rows.version,rows.status,rows.reason,
    CASE WHEN rows.status='PUBLISHED' THEN rows.visibility END AS visibility FROM (
      SELECT s.slug,s.version,${RESOLVED_STATUS} AS status,${DECISION_REASON} AS reason,h.visibility ${REVIEW_JOINS}
      WHERE s.tenant_id=$1 AND s.project_id=$2 AND c.decision IS NOT NULL AND EXISTS (
        SELECT 1 FROM developer_project_owners o WHERE o.tenant_id=s.tenant_id AND o.project_id=s.project_id AND o.account_id=$3
      )
    ) rows ORDER BY rows.slug,rows.version DESC`, [tenantId, projectId, accountId])).rows;
}
