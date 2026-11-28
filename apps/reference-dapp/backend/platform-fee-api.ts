// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (completion): the API side of the FloFi platform fee.
 *
 *   recordReviewedFee  after a single flow's Review is bound (`review`, from any surface: the app, an approval page, a channel or the Developer
 *                      API), the fee basis of that exact reviewed workflow is recorded once (0038). Best effort and bounded: it never changes the
 *                      flow call's result; an execution without a recorded basis is never charged.
 *   status / settle    the owner's read of one execution's fee and the start of its collection (`settlement.ts`), bound to the verified wallet
 *                      session principal: only the execution's own wallet can read or pay its fee.
 *   sweep              the worker pass: accrues completed executions while collection is active, and reconciles every open collection attempt
 *                      from its transfers' durable records (whatever the switch says: what was submitted is always reconciled).
 * Nothing here signs, submits or moves funds: the owner's wallet signs each settlement transfer through the existing transfer flow.
 */
import type { Database, Logger } from '@defi-workflow-engine/cloud-runtime';
import { platformFeeActivation } from '../src/platform-fee/activation.ts';
import { feeAuthorizationsActive, loadFeeAuthorization, recordFeeAuthorization } from '../src/platform-fee/authorization.ts';
import { PLATFORM_FEE_BPS, PLATFORM_FEE_POLICY_ID } from '../src/platform-fee/policy.ts';
import type { ExecutionRef } from '../src/platform-fee/settlement.ts';
import { installSourceResolution } from './source-resolution.ts';

/**
 * The engine-backed modules (composition, ledger, settlement) are written for bundler resolution; on plain Node they load through the same
 * source-resolution hook the workers use, on first use only, so the API's startup and `check-schema` never depend on them.
 */
let engine: Promise<{ settlement: typeof import('../src/platform-fee/settlement.ts'); singleFlow: typeof import('../src/platform-fee/single-flow.ts');
  ledger: typeof import('../src/platform-fee/ledger.ts'); strategy: typeof import('../src/engine/strategy-engine.ts') }> | null = null;
const loadEngine = () => engine ??= (installSourceResolution(), Promise.all([import('../src/platform-fee/settlement.ts'), import('../src/platform-fee/single-flow.ts'),
  import('../src/platform-fee/ledger.ts'), import('../src/engine/strategy-engine.ts')]).then(([settlement, singleFlow, ledger, strategy]) => ({ settlement, singleFlow, ledger, strategy })));

type Env = Readonly<Record<string, string | undefined>>;
type FlowResult = { ok: true; value: unknown } | { ok: false; code: string };
export type PlatformFeeApiDeps = {
  readonly db: Database; readonly env: Env; readonly tenantId: string; readonly logger: Logger;
  /** The API's own flow call as a given principal (same validation, ownership and refusal rules as any app request). */
  /** The collector's own flow call as the owner (`internal`: the settlement guard lets the collector review and recover its own transfers). */
  readonly callFlow: (flow: string, method: string, args: readonly unknown[], principal: string | null, identity: unknown) => Promise<FlowResult>;
  /** A flow's durable record (read-only service). */
  readonly load: (flow: string, runId: string) => Promise<unknown>;
  /** The server's own invalidation of an unsigned settlement transfer it created (reduces authority only). */
  readonly invalidate: (flow: string, runId: string) => Promise<FlowResult>;
  /** The flow's own read-only observation of one transfer (chain reads; it never begins, signs or sends). */
  readonly observe: (flow: string, runId: string) => Promise<FlowResult>;
};

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, WORKFLOW_RUN_ID = /^wfr_[a-z2-7]{26}$/;
/** The execution a request names: exactly one of a single-flow run id or a workflow run id. */
export function executionRefOf(input: unknown): ExecutionRef | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>, keys = Object.keys(value);
  if (keys.length !== 1) return null;
  if (typeof value.runId === 'string' && RUN_ID.test(value.runId) && !value.runId.startsWith('wfr_')) return { runId: value.runId };
  if (typeof value.workflowRunId === 'string' && WORKFLOW_RUN_ID.test(value.workflowRunId)) return { workflowRunId: value.workflowRunId };
  return null;
}
const namespaceOf = (principal: string): 'eip155' | 'solana' => principal.startsWith('0x') ? 'eip155' : 'solana';

export function createPlatformFeeApi(deps: PlatformFeeApiDeps) {
  const { db, env, tenantId, logger } = deps;

  async function recordReviewedFee(flow: string, method: string, args: readonly unknown[], value: unknown, tenant: string): Promise<void> {
    if (method !== 'review') return;
    const runId = typeof (value as { id?: unknown } | null)?.id === 'string' ? (value as { id: string }).id : typeof args[0] === 'string' ? args[0] : null;
    if (!runId || !RUN_ID.test(runId)) return;
    try {
      // Only while collection is active: the Review the owner saw then showed the fee as charged. Nothing authorized otherwise is ever collected.
      if (!platformFeeActivation(env).collection.active || !await feeAuthorizationsActive(db)) return;
      const { settlement, singleFlow, strategy } = await loadEngine();
      const record = await deps.load(flow, runId), workflow = singleFlow.recordSemanticWorkflow(record);
      // A settlement transfer is never an execution of its own; a workflow step's run is covered by its workflow's authorization.
      if (!workflow || workflow.workflowId.startsWith(settlement.SETTLEMENT_WORKFLOW_PREFIX)) return;
      const workflowHash = strategy.semanticWorkflowHash(workflow);
      // A workflow step's own run (matched exactly as the workflow observes it: same flow and reviewed workflow hash) is covered by its workflow.
      if ((await db.query(`SELECT 1 FROM workflow_run_steps s JOIN workflow_runs w ON w.tenant_id = s.tenant_id AND w.run_id = s.run_id
        JOIN execution_runs r ON r.tenant_id = s.tenant_id AND r.run_id = $4 WHERE s.tenant_id = $1 AND s.flow = $2 AND s.workflow_hash = $3
        AND (r.owner_account IS NULL OR w.wallets->>'eip155' = r.owner_account) AND w.created_at <= r.created_at LIMIT 1`, [tenant, flow, workflowHash, runId])).rowCount) return;
      const basis = singleFlow.singleFlowFeeBasis(record, { final: false, flow });
      await db.transaction(async tx => { await tx.query("SET LOCAL statement_timeout = '2000'");
        await recordFeeAuthorization(tx, tenant, { runId }, basis, workflowHash); });
    } catch { logger.warn('platform_fee.authorization_not_recorded', { flow, action: method, code: 'PLATFORM_FEE_AUTHORIZATION_NOT_RECORDED' }); }
  }

  /** Whether `principal` is the execution's own wallet (single flow: its recorded owner or its record's owner; workflow run: one of its bound wallets). */
  async function owns(ref: ExecutionRef, principal: string): Promise<boolean> {
    if ('workflowRunId' in ref) {
      const row = (await db.query<{ wallets: Record<string, string> }>('SELECT wallets FROM workflow_runs WHERE tenant_id = $1 AND run_id = $2',
        [tenantId, ref.workflowRunId])).rows[0];
      return Boolean(row && Object.values(row.wallets).includes(principal));
    }
    const row = (await db.query<{ owner_account: string | null; flow: string }>('SELECT owner_account, flow FROM execution_runs WHERE tenant_id = $1 AND run_id = $2',
      [tenantId, ref.runId])).rows[0];
    if (!row) return false;
    if (row.owner_account) return row.owner_account === principal;
    const record = await deps.load(row.flow, ref.runId) as { review?: { owner?: unknown } } | null;
    return typeof record?.review?.owner === 'string' && record.review.owner === principal;
  }

  /** The owner's view of one execution's fee: what was authorized, what is owed, what was collected, and whether collection is open. */
  async function status(ref: ExecutionRef, principal: string): Promise<FlowResult> {
    if (!await owns(ref, principal)) return { ok: false, code: 'PLATFORM_FEE_EXECUTION_NOT_FOUND' };
    const activation = platformFeeActivation(env), migrated = await feeAuthorizationsActive(db);
    const { settlement } = await loadEngine();
    const [authorized, row] = migrated ? await Promise.all([loadFeeAuthorization(db, tenantId, ref), settlement.loadLedgerRow(db, tenantId, ref)]) : [null, null];
    return { ok: true, value: { policyId: PLATFORM_FEE_POLICY_ID, rateBps: PLATFORM_FEE_BPS,
      collection: { active: activation.collection.active && migrated, code: activation.collection.code ?? (migrated ? null : 'PLATFORM_FEE_AUTHORIZATIONS_NOT_MIGRATED') },
      authorized: authorized ? { status: authorized.status, lines: authorized.lines, basisSha256: authorized.basisSha256 } : null,
      ledger: row ? { state: row.state, lines: row.lines, transfers: row.collection?.transfers ?? [], transactions: row.collection?.transactions ?? [],
        code: row.collection?.code ?? null, attention: row.collection?.attention === true } : null } };
  }

  async function settle(ref: ExecutionRef, principal: string, identity: unknown): Promise<FlowResult> {
    if (!await owns(ref, principal)) return { ok: false, code: 'PLATFORM_FEE_EXECUTION_NOT_FOUND' };
    const { settlement } = await loadEngine();
    const result = await settlement.startSettlement(db, { env, call: (flow, method, args) => deps.callFlow(flow, method, args, principal, identity), load: deps.load }, tenantId, ref,
      { namespace: namespaceOf(principal), account: principal });
    if (!result.ok) { logger.info('platform_fee.settlement_refused', { code: result.code }); return result; }
    logger.info('platform_fee.settlement_open', { state: result.state, transfers: result.transfers.length });
    return { ok: true, value: result };
  }

  let lastAccrual = 0;
  /** Worker pass (idempotent, safe concurrently). Accrual at most once a minute and only while collection is active. */
  async function sweep(now = Date.now()): Promise<void> {
    if (!await feeAuthorizationsActive(db)) return;
    const activation = platformFeeActivation(env), { settlement, ledger } = await loadEngine();
    if (activation.collection.active && now - lastAccrual >= 60_000) {
      lastAccrual = now;
      const report = await ledger.accruePlatformFees(db, tenantId, activation, { apply: true, limit: 200 });
      if (report.recorded || report.deferred) logger.info('platform_fee.accrued', { recorded: report.recorded, deferred: report.deferred });
    }
    const reconciled = await settlement.reconcileSettlements(db, { env, load: deps.load, invalidate: (flow, method, args) => method === 'observe' ? deps.observe(flow, String(args[0])) : deps.invalidate(flow, String(args[0])) }, tenantId);
    if (reconciled.collected || reconciled.failed) logger.info('platform_fee.reconciled', { collected: reconciled.collected, failed: reconciled.failed, pending: reconciled.pending });
  }

  /**
   * A settlement transfer is driven only through the attempt the ledger opened: its Review, begin, handoff and recovery are refused on the generic flow
   * route unless it is a transfer of an open attempt (`internal` calls are the collector's own). A client workflow may not take the reserved id.
   */
  async function settlementRefusal(method: string, args: readonly unknown[], internal: boolean): Promise<string | null> {
    if (internal) return null;
    const workflowId = (args[0] as { workflowId?: unknown } | null)?.workflowId;
    if ((method === 'simulate' || method === 'prepare') && typeof workflowId === 'string' && workflowId.startsWith('flofi-fee-settlement.')) return 'WORKFLOW_ID_RESERVED';
    if (!['review', 'begin', 'handoff', 'recoverReview'].includes(method) || typeof args[0] !== 'string' || !RUN_ID.test(args[0])) return null;
    const run = (await db.query<{ workflow_id: string }>('SELECT workflow_id FROM execution_runs WHERE tenant_id = $1 AND run_id = $2', [tenantId, args[0]])).rows[0];
    if (!run?.workflow_id.startsWith('flofi-fee-settlement.')) return null;
    if (!await feeAuthorizationsActive(db)) return 'PLATFORM_FEE_SETTLEMENT_TRANSFER_CLOSED';
    const open = await db.query(`SELECT 1 FROM platform_fee_ledger WHERE tenant_id = $1 AND state = 'COLLECTION_PENDING'
      AND collection->'transfers' @> jsonb_build_array(jsonb_build_object('runId', $2::text))`, [tenantId, args[0]]);
    return open.rowCount ? (method === 'begin' || method === 'handoff' ? null : 'PLATFORM_FEE_SETTLEMENT_TRANSFER_CLOSED') : 'PLATFORM_FEE_SETTLEMENT_TRANSFER_CLOSED';
  }

  return { recordReviewedFee, status, settle, sweep, settlementRefusal };
}
export type PlatformFeeApi = ReturnType<typeof createPlatformFeeApi>;
