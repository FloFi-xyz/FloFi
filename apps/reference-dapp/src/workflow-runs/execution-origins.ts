// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (WS-ATTRIBUTION, KAN-25): the durable channel an execution started from.
 *
 * Written once, from trusted server-side context only, into `execution_origins` (migration 0037; dormant until the database holds its exact
 * certified identity):
 *   - a workflow run, when it is created from its approval handoff: the handoff's immutable requester kind and client id;
 *   - a single flow created by FloFi's /app server actions: the proxy's authoritative request path (`x-flofi-pathname`, never a client field);
 *   - a single flow created on an approval page: when that approval binds the run (`HandoffStore.bindRuns`), the approval's requester.
 * The first record wins (the signing surface never overwrites where an execution started); nothing here ever updates or deletes an origin.
 * Chat and the Editor are the same /app page and call the same server actions: no server-side record tells them apart, so a new web execution is
 * `web`, never `web_chat` or `web_editor` (those values are reserved for a future trusted signal). Recording never blocks or fails an execution.
 */
import type { Queryable } from '@defi-workflow-engine/cloud-runtime';
import { CERTIFIED_FORWARD_MIGRATIONS, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { cimdClientId } from '../mcp/oauth/cimd.ts';

export const EXECUTION_ORIGINS = ['web_chat', 'web_editor', 'web', 'legacy_web', 'mcp_chatgpt', 'mcp_claude', 'mcp_other', 'telegram', 'developer_api',
  'automation', 'unknown'] as const;
export type ExecutionOrigin = (typeof EXECUTION_ORIGINS)[number];
export const isExecutionOrigin = (value: unknown): value is ExecutionOrigin => typeof value === 'string' && (EXECUTION_ORIGINS as readonly string[]).includes(value);
export type OriginBasis = 'CREATION' | 'APPROVAL_BINDING' | 'BACKFILL';
export type OriginTarget = { readonly runId: string } | { readonly workflowRunId: string };

/** Migration 0037: execution origins and the platform fee ledger. */
export const REVENUE_ORIGINS_VERSION = 37;
export const REVENUE_ORIGINS_NAME = 'execution_origins_platform_fees';

/** The CIMD hosts that name a channel (same rule as the Admin channel counts and native signing's return). */
const CIMD_ORIGINS: Readonly<Record<string, ExecutionOrigin>> = { 'chatgpt.com': 'mcp_chatgpt', 'claude.ai': 'mcp_claude' };
const TELEGRAM_CLIENT = /^telegram:[1-9][0-9]{4,15}$/;

/** The origin of an approval handoff, from its immutable requester kind and client id only (pure). A self-declared client name is never read. */
export function originOfRequester(requesterKind: string, clientId: string): ExecutionOrigin {
  switch (requesterKind) {
    case 'EDITOR_SESSION': return 'web';
    case 'DEVELOPER_PROJECT': return 'developer_api';
    case 'AUTOMATION_RULE': return 'automation';
    case 'CHANNEL_CONVERSATION': return TELEGRAM_CLIENT.test(clientId) ? 'telegram' : 'unknown';
    case 'MCP_ACCOUNT': {
      const check = cimdClientId(clientId, Object.keys(CIMD_ORIGINS));
      return check.ok ? CIMD_ORIGINS[check.url.hostname] ?? 'mcp_other' : 'mcp_other';
    }
    default: return 'unknown';
  }
}

/** The surface of a server action request, from the proxy's authoritative path: the FloFi app page, or nothing recordable. */
export type ExecutionSurface = 'WEB_APP';
/** The BFF → API header carrying it (set only by FloFi's own server, on the API_AUTH_TOKEN-authenticated call; value `web-app`). */
export const EXECUTION_SURFACE_HEADER = 'x-flofi-execution-surface';
export const surfaceOfPath = (pathname: string | null | undefined): ExecutionSurface | null =>
  typeof pathname === 'string' && (pathname === '/app' || pathname.startsWith('/app/')) ? 'WEB_APP' : null;

const active = new WeakMap<object, true>();
/** Whether the database holds exactly the certified 0037 (version, name and SHA-256). Remembered once true; false on any doubt or error. */
export async function revenueOriginsActive(db: Queryable): Promise<boolean> {
  if (active.has(db)) return true;
  const identity = SHIPPED_MIGRATIONS.find(m => m.version === REVENUE_ORIGINS_VERSION)
    ?? CERTIFIED_FORWARD_MIGRATIONS.flatMap(c => c.migrations).find(m => m.version === REVENUE_ORIGINS_VERSION);
  if (!identity || identity.name !== REVENUE_ORIGINS_NAME) return false;
  try {
    const row = (await db.query('SELECT version, name, sha256 FROM schema_migrations WHERE version = $1', [REVENUE_ORIGINS_VERSION])).rows[0];
    const ok = Boolean(row && Number(row.version) === identity.version && row.name === identity.name && row.sha256 === identity.sha256);
    if (ok) active.set(db, true);
    return ok;
  } catch { return false; }
}

const EVIDENCE = /^[A-Z][A-Z0-9_]{2,63}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * Inserts the origin of one execution unless one is already recorded (first record wins). `INACTIVE` without 0037; `EXISTS` when an origin was
 * already there (or the execution row does not exist yet, which the caller treats the same: nothing written).
 */
export async function recordExecutionOrigin(db: Queryable, tenantId: string, target: OriginTarget, origin: ExecutionOrigin, basis: OriginBasis,
  evidence: string): Promise<'RECORDED' | 'EXISTS' | 'INACTIVE'> {
  if (!isExecutionOrigin(origin) || !EVIDENCE.test(evidence)) throw new Error('EXECUTION_ORIGIN_INVALID');
  const runId = 'runId' in target ? target.runId : null, workflowRunId = 'workflowRunId' in target ? target.workflowRunId : null;
  if (!RUN_ID.test(runId ?? workflowRunId ?? '')) throw new Error('EXECUTION_ORIGIN_INVALID');
  if (!await revenueOriginsActive(db)) return 'INACTIVE';
  const table = runId ? 'execution_runs' : 'workflow_runs';
  const { rowCount } = await db.query(`INSERT INTO execution_origins (tenant_id, run_id, workflow_run_id, origin, basis, evidence)
    SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (SELECT 1 FROM ${table} WHERE tenant_id = $1 AND run_id = $7)
    ON CONFLICT DO NOTHING`, [tenantId, runId, workflowRunId, origin, basis, evidence, runId ?? workflowRunId]);
  return rowCount ? 'RECORDED' : 'EXISTS';
}

/** Records the origin of every listed single-flow run an approval bound (best effort, first record wins). Never throws. */
export async function recordBoundOrigins(db: Queryable, tenantId: string, runIds: readonly string[], requester: { readonly kind: string; readonly clientId: string },
  report: (code: string) => void = () => undefined): Promise<void> {
  const origin = originOfRequester(requester.kind, requester.clientId);
  for (const runId of runIds) {
    try { await recordExecutionOrigin(db, tenantId, { runId }, origin, 'APPROVAL_BINDING', 'APPROVAL_RUN_BINDING'); }
    catch { report('EXECUTION_ORIGIN_NOT_RECORDED'); }
  }
}

/** One execution's effective origin: the latest approved correction, else the recorded origin. */
export type EffectiveOrigin = { readonly origin: ExecutionOrigin; readonly basis: OriginBasis | 'CORRECTION' };
/** The effective origins of the given executions (no row for an execution without a record). Tenant-scoped, read-only. */
export async function effectiveOrigins(db: Queryable, tenantId: string, ids: { readonly runIds: readonly string[]; readonly workflowRunIds: readonly string[] }):
  Promise<{ readonly runs: ReadonlyMap<string, EffectiveOrigin>; readonly workflowRuns: ReadonlyMap<string, EffectiveOrigin> }> {
  const runs = new Map<string, EffectiveOrigin>(), workflowRuns = new Map<string, EffectiveOrigin>();
  if (!(ids.runIds.length || ids.workflowRunIds.length) || !await revenueOriginsActive(db)) return { runs, workflowRuns };
  const { rows } = await db.query<{ run_id: string | null; workflow_run_id: string | null; origin: string; basis: string }>(`
    SELECT o.run_id, o.workflow_run_id, coalesce(c.origin, o.origin) AS origin, CASE WHEN c.origin IS NULL THEN o.basis ELSE 'CORRECTION' END AS basis
    FROM execution_origins o
    LEFT JOIN LATERAL (SELECT x.origin FROM execution_origin_corrections x WHERE x.tenant_id = o.tenant_id
      AND (x.run_id = o.run_id OR x.workflow_run_id = o.workflow_run_id) ORDER BY x.created_at DESC, x.correction_id DESC LIMIT 1) c ON true
    WHERE o.tenant_id = $1 AND (o.run_id = ANY($2::text[]) OR o.workflow_run_id = ANY($3::text[]))`, [tenantId, [...ids.runIds], [...ids.workflowRunIds]]);
  for (const row of rows) {
    if (!isExecutionOrigin(row.origin)) continue;
    const value = { origin: row.origin, basis: row.basis as EffectiveOrigin['basis'] };
    if (row.run_id) runs.set(row.run_id, value); else if (row.workflow_run_id) workflowRuns.set(row.workflow_run_id, value);
  }
  return { runs, workflowRuns };
}
