// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (WS-ATTRIBUTION, KAN-25): the durable channel an execution started from.
 *
 * Written once, from trusted server-side context only, into `execution_origins` (migration 0037; dormant until the database holds its exact
 * certified identity):
 *   - a workflow run, when it is created from its approval handoff: the handoff's immutable requester kind and client id (an Editor handoff is
 *     `web_editor`, or `web_chat` when the in-place Authorize that created the run carried a verified Chat initiation reference);
 *   - a single flow created by FloFi's /app server actions (the proxy's authoritative `x-flofi-pathname`, never a client field): `web_chat` when
 *     the call carried a Chat initiation reference this server issued to the request's own FloFi account (`server/chat-initiation.ts`, verified
 *     on the server, fail closed), `web_editor` otherwise;
 *   - a single flow created on an approval page (`/approve`, `/mcp/approve`): the approval's requester, at creation, when the run's reviewed
 *     workflow hashes exactly to that approval's and the request's authenticated wallet is its claimant (`approval-page-origin.ts`), whatever the
 *     owner's sharing choice; and, as before, when that approval binds the run (`HandoffStore.bindRuns`).
 * The first record wins (the signing surface never overwrites where an execution started); nothing here ever updates or deletes an origin.
 * `web` is the legacy value: FloFi Web rows recorded before Chat and the Editor were separated (or by a BFF of that build during a rolling
 * deployment). Recording never blocks or fails an execution.
 */
import type { Queryable } from '@defi-workflow-engine/cloud-runtime';
import { CERTIFIED_FORWARD_MIGRATIONS, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { cimdClientId } from '../mcp/oauth/cimd.ts';
import { typedId } from '../platform/ids.ts';

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
    // The Editor's own handoff. A Chat-started run is told apart only by the verified reference of the request that created it (`ensureForClaim`).
    case 'EDITOR_SESSION': return 'web_editor';
    case 'DEVELOPER_PROJECT': return 'developer_api';
    case 'AUTOMATION_RULE': return 'automation';
    case 'CHANNEL_CONVERSATION': return TELEGRAM_CLIENT.test(clientId) ? 'telegram' : 'unknown';
    case 'MCP_ACCOUNT': {
      // Total: a client id the CIMD check cannot even parse (it decodes percent-escapes) is an unidentified client, never an exception.
      try {
        const check = cimdClientId(clientId, Object.keys(CIMD_ORIGINS));
        return check.ok ? CIMD_ORIGINS[check.url.hostname] ?? 'mcp_other' : 'mcp_other';
      } catch { return 'mcp_other'; }
    }
    default: return 'unknown';
  }
}

/** Which FloFi page a server action was posted to, by the proxy's authoritative path: the app page, an approval page, or nothing recordable. */
export type ActionPage = 'APP' | 'APPROVAL';
/**
 * flofi-security review: the path is the proxy's own (`x-flofi-pathname`, set on every product page and stripped from every pass-through request),
 * but the browser chooses which page a server action is posted to. A web record is therefore the weakest origin: an approval that later binds the
 * run (an exact reviewed workflow hash after its claim) takes precedence over it in the Admin counts (`channels.ts`).
 */
export function pageOfPath(pathname: string | null | undefined): ActionPage | null {
  if (typeof pathname !== 'string') return null;
  if (pathname === '/app' || pathname.startsWith('/app/')) return 'APP';
  return pathname === '/approve' || pathname === '/mcp/approve' ? 'APPROVAL' : null;
}
/**
 * The server-derived surface of a creating call (`simulate`/`prepare`), as FloFi's own server tells its API. `WEB_APP` is the legacy value a BFF
 * built before Chat and the Editor were separated sends (recorded as `web`); this build sends `WEB_CHAT` or `WEB_EDITOR` for the app page.
 */
export type ExecutionSurface = 'WEB_CHAT' | 'WEB_EDITOR' | 'WEB_APP' | 'APPROVAL_PAGE';
export type OriginWallet = { readonly namespace: 'eip155' | 'solana'; readonly address: string };
/** What the BFF tells the API about where a creating call came from: the surface and, on an approval page, the wallets the request proved. */
export type OriginContext = { readonly surface: ExecutionSurface; readonly wallets?: readonly OriginWallet[] };
/** The BFF → API headers carrying it (set only by FloFi's own server, on the API_AUTH_TOKEN-authenticated call; the browser never reaches the API). */
export const EXECUTION_SURFACE_HEADER = 'x-flofi-execution-surface';
export const ORIGIN_WALLETS_HEADER = 'x-flofi-origin-wallets';
const SURFACE_VALUES: Readonly<Record<ExecutionSurface, string>> = { WEB_CHAT: 'web-chat', WEB_EDITOR: 'web-editor', WEB_APP: 'web-app', APPROVAL_PAGE: 'approval-page' };
const EVM_WALLET = /^eip155:(0x[0-9a-fA-F]{40})$/, SOLANA_WALLET = /^solana:([1-9A-HJ-NP-Za-km-z]{32,44})$/;
/** A wallet as `namespace:address` (EVM lower-cased, as run owners are stored), or null. */
export function originWalletOf(value: string): OriginWallet | null {
  const evm = EVM_WALLET.exec(value);
  if (evm) return { namespace: 'eip155', address: evm[1]!.toLowerCase() };
  const solana = SOLANA_WALLET.exec(value);
  return solana ? { namespace: 'solana', address: solana[1]! } : null;
}
export function originContextHeaders(context: OriginContext | null | undefined): Record<string, string> {
  if (!context || !Object.hasOwn(SURFACE_VALUES, context.surface)) return {};
  const wallets = context.surface === 'APPROVAL_PAGE' ? (context.wallets ?? []).flatMap(w => { const valid = originWalletOf(`${w.namespace}:${w.address}`);
    return valid ? [`${valid.namespace}:${valid.address}`] : []; }).slice(0, 2) : [];
  return { [EXECUTION_SURFACE_HEADER]: SURFACE_VALUES[context.surface], ...wallets.length ? { [ORIGIN_WALLETS_HEADER]: wallets.join(',') } : {} };
}
/** The context of an API request (closed values only; anything else is no context, never an error: recording is best effort). */
export function originContextOf(headers: Readonly<Record<string, unknown>>): OriginContext | null {
  const raw = headers[EXECUTION_SURFACE_HEADER];
  const surface = (Object.keys(SURFACE_VALUES) as ExecutionSurface[]).find(key => SURFACE_VALUES[key] === raw);
  if (!surface) return null;
  if (surface !== 'APPROVAL_PAGE') return { surface };
  const listed = headers[ORIGIN_WALLETS_HEADER], parts = typeof listed === 'string' ? listed.split(',') : [];
  const wallets = parts.length <= 2 ? parts.map(part => originWalletOf(part.trim())).filter((w): w is OriginWallet => w !== null) : [];
  return { surface, wallets };
}
/** The FloFi Web origins: `web_chat`, `web_editor` and the legacy combined `web`. */
export const WEB_ORIGINS: ReadonlySet<ExecutionOrigin> = new Set(['web_chat', 'web_editor', 'web']);
/** The origin and evidence a web surface records at creation (the approval page has none of its own: its approval decides). */
export const WEB_SURFACE_ORIGINS: Readonly<Record<Exclude<ExecutionSurface, 'APPROVAL_PAGE'>, { readonly origin: ExecutionOrigin; readonly evidence: string }>> = {
  WEB_CHAT: { origin: 'web_chat', evidence: 'WEB_CHAT_INITIATION' }, WEB_EDITOR: { origin: 'web_editor', evidence: 'WEB_EDITOR_SERVER_ACTION' },
  WEB_APP: { origin: 'web', evidence: 'WEB_APP_SERVER_ACTION' } };
/** The evidence of a single flow attributed at creation to the approval whose page created it (§8.2). */
export const APPROVAL_PAGE_EVIDENCE = 'APPROVAL_PAGE_CREATION';

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

/**
 * Records the origin of every listed single-flow run an approval bound (best effort, first record wins). Never throws. flofi-admin-analytics review:
 * a run recorded as FloFi Web at creation (`web_chat`, `web_editor` or the legacy `web`: the page a server action was posted to is the browser's
 * choice) that an MCP, channel, developer or automation approval binds is corrected durably, once, to that approval's channel (an append-only
 * correction row naming the recorded value), so a later approval purge never flips it. The origin row itself never changes.
 */
export async function recordBoundOrigins(db: Queryable, tenantId: string, runIds: readonly string[], requester: { readonly kind: string; readonly clientId: string },
  report: (code: string) => void = () => undefined): Promise<void> {
  const origin = originOfRequester(requester.kind, requester.clientId);
  for (const runId of runIds) {
    try {
      const recorded = await recordExecutionOrigin(db, tenantId, { runId }, origin, 'APPROVAL_BINDING', 'APPROVAL_RUN_BINDING');
      if (recorded !== 'EXISTS' || WEB_ORIGINS.has(origin) || origin === 'unknown') continue;
      await db.query(`INSERT INTO execution_origin_corrections (tenant_id, correction_id, run_id, origin, previous_origin, approval_ref, reason_code)
        SELECT $1, $2, $3, $4, o.origin, 'auto:approval-binding', 'APPROVAL_BINDING_SUPERSEDES_WEB'
        FROM execution_origins o WHERE o.tenant_id = $1 AND o.run_id = $3 AND o.origin IN ('web', 'web_chat', 'web_editor') AND o.basis = 'CREATION'
          AND NOT EXISTS (SELECT 1 FROM execution_origin_corrections c WHERE c.tenant_id = $1 AND c.run_id = $3)`, [tenantId, typedId('eoc'), runId, origin]);
    } catch { report('EXECUTION_ORIGIN_NOT_RECORDED'); }
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
