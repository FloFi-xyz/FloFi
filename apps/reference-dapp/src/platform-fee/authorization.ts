// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (completion, F16): the authorized platform fee basis (`platform_fee_authorizations`, migration 0038).
 *
 * The fee a Review disclosed is recorded once, when the owner authorizes that exact revision of the execution, and never updated:
 *   - a workflow run, in the transaction that creates it from its approved Review (its workflow hash is the revision);
 *   - a single flow, when its Review is bound (the reviewed workflow's hash is the revision).
 * A collector charges at most these lines per exact asset (`settledFee`), never an asset that is not listed, and nothing at all for an execution
 * without a row. The basis is computed on the server from the server-held reviewed workflow with the canonical policy module, the same function
 * every Review uses to display it, and its SHA-256 lets the disclosure, the record and the collection be reconciled.
 */
import { createHash } from 'node:crypto';
import { CERTIFIED_FORWARD_MIGRATIONS, SHIPPED_MIGRATIONS, type Queryable } from '@defi-workflow-engine/cloud-runtime';
import type { FeeBasis, FeeLine } from './principal';

export const FEE_AUTHORIZATIONS_VERSION = 38;
export const FEE_AUTHORIZATIONS_NAME = 'platform_fee_authorizations';

export type FeeAuthorizationTarget = { readonly runId: string } | { readonly workflowRunId: string };
export type FeeAuthorization = {
  readonly policyId: string; readonly rateBps: number; readonly status: FeeBasis['status']; readonly lines: readonly FeeLine[];
  readonly basisSha256: string; readonly workflowHash: string; readonly authorizedAt: Date;
};

/** Canonical bytes of a basis: policy, rate, status and the per-asset lines in their canonical order (the order `workflowFeeBasis` returns). */
export function feeBasisDigest(basis: { readonly policyId: string; readonly rateBps: number; readonly status: string; readonly lines: readonly FeeLine[] }): string {
  const lines = basis.lines.map(l => [l.chainId, l.address, l.decimals, l.principal, l.fee]);
  return createHash('sha256').update(JSON.stringify([basis.policyId, basis.rateBps, basis.status, lines])).digest('hex');
}

const active = new WeakMap<object, true>();
/** Whether the database holds exactly the certified 0038 (version, name and SHA-256). Remembered once true; false on any doubt or error. */
export async function feeAuthorizationsActive(db: Queryable): Promise<boolean> {
  if (active.has(db)) return true;
  const identity = SHIPPED_MIGRATIONS.find(m => m.version === FEE_AUTHORIZATIONS_VERSION)
    ?? CERTIFIED_FORWARD_MIGRATIONS.flatMap(c => c.migrations).find(m => m.version === FEE_AUTHORIZATIONS_VERSION);
  if (!identity || identity.name !== FEE_AUTHORIZATIONS_NAME) return false;
  try {
    const row = (await db.query('SELECT version, name, sha256 FROM schema_migrations WHERE version = $1', [FEE_AUTHORIZATIONS_VERSION])).rows[0];
    const ok = Boolean(row && Number(row.version) === identity.version && row.name === identity.name && row.sha256 === identity.sha256);
    if (ok) active.set(db, true);
    return ok;
  } catch { return false; }
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, HASH = /^0x[0-9a-f]{64}$/;
/**
 * Records the authorized basis of one execution unless one is already recorded (first record wins: a repeated or concurrent call, a retried request
 * or a later Review of a recovery run never replaces what the owner first authorized). `INACTIVE` without 0038; `EXISTS` when a row was already
 * there (or the execution row does not exist yet). Never records an UNSUPPORTED basis's lines (there are none) and never a malformed revision.
 */
export async function recordFeeAuthorization(db: Queryable, tenantId: string, target: FeeAuthorizationTarget, basis: FeeBasis, workflowHash: string):
  Promise<'RECORDED' | 'EXISTS' | 'INACTIVE'> {
  const runId = 'runId' in target ? target.runId : null, workflowRunId = 'workflowRunId' in target ? target.workflowRunId : null;
  if (!RUN_ID.test(runId ?? workflowRunId ?? '') || !HASH.test(workflowHash)) throw new Error('PLATFORM_FEE_AUTHORIZATION_INVALID');
  if (basis.status === 'FEEABLE' ? !basis.lines.length : basis.lines.length) throw new Error('PLATFORM_FEE_AUTHORIZATION_INVALID');
  if (!await feeAuthorizationsActive(db)) return 'INACTIVE';
  const table = runId ? 'execution_runs' : 'workflow_runs';
  const { rowCount } = await db.query(`INSERT INTO platform_fee_authorizations (tenant_id, run_id, workflow_run_id, policy_id, rate_bps, status, lines,
      basis_sha256, workflow_hash)
    SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9 WHERE EXISTS (SELECT 1 FROM ${table} WHERE tenant_id = $1 AND run_id = $10)
    ON CONFLICT DO NOTHING`, [tenantId, runId, workflowRunId, basis.policyId, basis.rateBps, basis.status, JSON.stringify(basis.lines), feeBasisDigest(basis),
    workflowHash, runId ?? workflowRunId]);
  return rowCount ? 'RECORDED' : 'EXISTS';
}

type Row = { policy_id: string; rate_bps: number; status: FeeBasis['status']; lines: FeeLine[]; basis_sha256: string; workflow_hash: string; authorized_at: Date };
/** The authorized basis of one execution, or null (none recorded, or 0038 absent). A row whose lines do not hash to its digest is refused. */
export async function loadFeeAuthorization(db: Queryable, tenantId: string, target: FeeAuthorizationTarget): Promise<FeeAuthorization | null> {
  if (!await feeAuthorizationsActive(db)) return null;
  const column = 'runId' in target ? 'run_id' : 'workflow_run_id', id = 'runId' in target ? target.runId : target.workflowRunId;
  const row = (await db.query<Row>(`SELECT policy_id, rate_bps, status, lines, basis_sha256, workflow_hash, authorized_at FROM platform_fee_authorizations
    WHERE tenant_id = $1 AND ${column} = $2`, [tenantId, id])).rows[0];
  if (!row) return null;
  const authorization = { policyId: row.policy_id, rateBps: row.rate_bps, status: row.status, lines: row.lines, basisSha256: row.basis_sha256,
    workflowHash: row.workflow_hash, authorizedAt: row.authorized_at };
  if (feeBasisDigest(authorization) !== row.basis_sha256) throw new Error('PLATFORM_FEE_AUTHORIZATION_CORRUPT');
  return authorization;
}
