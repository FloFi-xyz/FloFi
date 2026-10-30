// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: durable workflow runs on PostgreSQL (migration 0015). Concurrency comes from the database, never process memory:
 *
 *   - a run is created once per approval handoff (`UNIQUE (tenant_id, handoff_id)`), so a repeated claim finds the same run;
 *   - every run and step transition is a compare-and-set (run: version + allowed source states; step: allowed source states), and the
 *     triggers of 0015 refuse any backwards move, any change of a bound fact and any deletion;
 *   - choosing the mode is one transaction under the run's row lock: confirm-each-step revokes any unsigned delegated authorization of the
 *     run in the same transaction; a delegated activation (inside the delegation store's own transaction) requires the run still PENDING;
 *   - advancing is a deduplicated durable work item (`workflow-run.advance`, one open item per run).
 *
 * Every query names the tenant; owner reads name the owner too. Nothing stored here is key material, calldata or a signature.
 */
import type { Database, Queryable, Row } from '@defi-workflow-engine/cloud-runtime';
import type { StrategyInput, StrategySpec } from '../engine/strategy-spec';
import type { ApprovalRequesterKind, RequesterScope, WalletRef } from '../platform/handoff-store.ts';
import { WORKFLOW_RUN_ADVANCE_KIND, canEndWorkflow, type RunMode, type RunState, type StepState } from './state-machine.ts';

export type WalletSet = Readonly<Partial<Record<WalletRef['namespace'], string>>>;
/** How a bound step's amount was resolved (native units of `asset`). */
export type BoundResolution = { readonly amountFrom: number; readonly asset: { readonly chainId: string; readonly address: string; readonly decimals: number };
  readonly cap: string; readonly received: string; readonly used: string;
  /** Position inputs can be funded by two distinct reconciled producer assets. */ readonly additional?: readonly BoundResolution[] };
/** Public reconciled facts of one step (never calldata, keys or signatures). */
export type StepOutcome = {
  readonly kind: 'OWNER_RUN' | 'DELEGATED_STEP'; readonly executionId: string; readonly flow: string | null; readonly status: string;
  readonly transactions: readonly { readonly chain: string; readonly hash: string }[];
  readonly evidence: { readonly environment: string; readonly outcome: string; readonly bundleHash: string | null } | null;
  readonly spent: readonly { readonly asset: string; readonly amount: string }[]; readonly received: readonly { readonly asset: string; readonly amount: string }[];
  readonly observedAt: string };
export type RunRecord = {
  readonly runId: string; readonly handoffId: string; readonly requester: RequesterScope; readonly owner: WalletRef; readonly wallets: WalletSet;
  readonly strategy: StrategyInput; readonly workflowHash: string; readonly engineVersion: string; readonly stepCount: number; readonly mode: RunMode | null;
  readonly state: RunState; readonly currentStep: number; readonly authorizationId: string | null; readonly code: string | null; readonly completedAt: Date | null;
  readonly expiresAt: Date; readonly version: number; readonly createdAt: Date; readonly updatedAt: Date };
export type RunStepRecord = {
  readonly runId: string; readonly stepIndex: number; readonly state: StepState; readonly flow: string | null; readonly strategy: StrategySpec | null;
  readonly workflowHash: string | null; readonly bound: BoundResolution | null; readonly claimedAt: Date | null; readonly outcome: StepOutcome | null;
  readonly code: string | null; readonly version: number; readonly updatedAt: Date };
export type RunEvent = { readonly stepIndex: number | null; readonly kind: string; readonly code: string | null; readonly detail: Readonly<Record<string, unknown>> | null; readonly at: Date };
export type NewRun = { readonly runId: string; readonly handoffId: string; readonly requester: RequesterScope; readonly owner: WalletRef; readonly wallets: WalletSet;
  readonly strategy: StrategyInput; readonly workflowHash: string; readonly engineVersion: string; readonly stepCount: number; readonly expiresAt: Date };
export type RunPatch = { readonly currentStep?: number; readonly mode?: RunMode; readonly authorizationId?: string; readonly code?: string | null; readonly completedAt?: Date };
export type StepPatch = { readonly flow?: string; readonly strategy?: StrategySpec; readonly workflowHash?: string; readonly bound?: BoundResolution;
  readonly claimedAt?: Date; readonly outcome?: StepOutcome; readonly code?: string | null };

const date = (v: unknown) => v instanceof Date ? v : new Date(String(v));
const maybeDate = (v: unknown) => v === null || v === undefined ? null : date(v);
const str = (v: unknown) => v === null || v === undefined ? null : String(v);
const json = (v: unknown) => v === null || v === undefined ? null : JSON.stringify(v, (_k, x: unknown) => typeof x === 'bigint' ? x.toString() : x);
const refuse = (code: string): never => { throw new Error(code); };

const runOf = (r: Row): RunRecord => ({ runId: String(r.run_id), handoffId: String(r.handoff_id),
  requester: { kind: r.requester_kind as ApprovalRequesterKind, ref: String(r.requester_ref) },
  owner: { namespace: r.owner_namespace as WalletRef['namespace'], address: String(r.owner_account) }, wallets: (r.wallets ?? {}) as WalletSet,
  strategy: r.strategy as StrategyInput, workflowHash: String(r.workflow_hash), engineVersion: String(r.engine_version), stepCount: Number(r.step_count),
  mode: (r.mode ?? null) as RunMode | null, state: r.state as RunState, currentStep: Number(r.current_step), authorizationId: str(r.authorization_id), code: str(r.code),
  completedAt: maybeDate(r.completed_at), expiresAt: date(r.expires_at), version: Number(r.version), createdAt: date(r.created_at), updatedAt: date(r.updated_at) });
const stepOf = (r: Row): RunStepRecord => ({ runId: String(r.run_id), stepIndex: Number(r.step_index), state: r.state as StepState, flow: str(r.flow),
  strategy: (r.strategy ?? null) as StrategySpec | null, workflowHash: str(r.workflow_hash), bound: (r.bound ?? null) as BoundResolution | null,
  claimedAt: maybeDate(r.claimed_at), outcome: (r.outcome ?? null) as StepOutcome | null, code: str(r.code), version: Number(r.version), updatedAt: date(r.updated_at) });

export function createPgWorkflowRunStore(db: Database, tenantId: string) {
  const event = (tx: Queryable, runId: string, stepIndex: number | null, kind: string, code: string | null = null, detail: Readonly<Record<string, unknown>> | null = null) =>
    tx.query(`INSERT INTO workflow_run_events (tenant_id, run_id, step_index, kind, code, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [tenantId, runId, stepIndex, kind, code, json(detail)]);
  const enqueue = (tx: Queryable, runId: string, delayMs = 0) => tx.query(`INSERT INTO work_items (tenant_id, kind, dedupe_key, run_id, payload, state, available_at)
      VALUES ($1, $2, $3, NULL, $4::jsonb, 'READY', now() + make_interval(secs => $5::double precision / 1000))
      ON CONFLICT (tenant_id, kind, dedupe_key) WHERE state IN ('READY', 'LEASED') DO NOTHING`,
  [tenantId, WORKFLOW_RUN_ADVANCE_KIND, runId, JSON.stringify({ runId }), Math.max(0, Math.round(delayMs))]);
  const lockRun = async (tx: Queryable, runId: string) => {
    const row = (await tx.query('SELECT * FROM workflow_runs WHERE tenant_id = $1 AND run_id = $2 FOR UPDATE', [tenantId, runId])).rows[0];
    return row ? runOf(row) : null;
  };

  return {
    tenantId,
    /**
     * The run of an approval handoff, created once with all its steps PENDING (the same transaction); a repeated claim returns the existing
     * run unchanged. The caller has already verified the claim (wallet proof, requester rule, re-composition to the same hash).
     */
    create: (input: NewRun, now: Date) => db.transaction(async tx => {
      const inserted = (await tx.query(`INSERT INTO workflow_runs (tenant_id, run_id, handoff_id, requester_kind, requester_ref, owner_namespace, owner_account, wallets, strategy,
          workflow_hash, engine_version, step_count, state, expires_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, 'PENDING', $13, $14, $14)
        ON CONFLICT (tenant_id, handoff_id) DO NOTHING RETURNING run_id`,
      [tenantId, input.runId, input.handoffId, input.requester.kind, input.requester.ref, input.owner.namespace, input.owner.address, json(input.wallets),
        json(input.strategy), input.workflowHash, input.engineVersion, input.stepCount, input.expiresAt, now])).rows[0];
      if (inserted) {
        for (let i = 0; i < input.stepCount; i++) await tx.query(`INSERT INTO workflow_run_steps (tenant_id, run_id, step_index, state, created_at, updated_at)
          VALUES ($1, $2, $3, 'PENDING', $4, $4)`, [tenantId, input.runId, i, now]);
        await event(tx, input.runId, null, 'RUN_CREATED', null, { stepCount: input.stepCount, workflowHash: input.workflowHash });
      }
      return runOf((await tx.query('SELECT * FROM workflow_runs WHERE tenant_id = $1 AND handoff_id = $2', [tenantId, input.handoffId])).rows[0]!);
    }),
    async byId(runId: string): Promise<RunRecord | null> {
      const row = (await db.query('SELECT * FROM workflow_runs WHERE tenant_id = $1 AND run_id = $2', [tenantId, runId])).rows[0];
      return row ? runOf(row) : null;
    },
    async byHandoff(handoffId: string): Promise<RunRecord | null> {
      const row = (await db.query('SELECT * FROM workflow_runs WHERE tenant_id = $1 AND handoff_id = $2', [tenantId, handoffId])).rows[0];
      return row ? runOf(row) : null;
    },
    /** The runs one of these wallets owns (most recent first). */
    async forOwner(owner: WalletRef, limit = 20): Promise<readonly RunRecord[]> {
      return (await db.query(`SELECT * FROM workflow_runs WHERE tenant_id = $1 AND owner_namespace = $2 AND owner_account = $3
        AND NOT EXISTS (SELECT 1 FROM owner_history_visibility h WHERE h.tenant_id=workflow_runs.tenant_id AND h.owner_account=workflow_runs.owner_account AND h.kind='WORKFLOW_RUN' AND h.record_id=workflow_runs.run_id)
        ORDER BY created_at DESC, run_id LIMIT $4`,
        [tenantId, owner.namespace, owner.address, Math.min(Math.max(1, limit), 100)])).rows.map(runOf);
    },
    async steps(runId: string): Promise<readonly RunStepRecord[]> {
      return (await db.query('SELECT * FROM workflow_run_steps WHERE tenant_id = $1 AND run_id = $2 ORDER BY step_index', [tenantId, runId])).rows.map(stepOf);
    },
    async events(runId: string, limit = 100): Promise<readonly RunEvent[]> {
      return (await db.query(`SELECT * FROM workflow_run_events WHERE tenant_id = $1 AND run_id = $2 ORDER BY event_id DESC LIMIT $3`,
        [tenantId, runId, Math.min(Math.max(1, limit), 500)])).rows.reverse().map(r => ({ stepIndex: r.step_index === null ? null : Number(r.step_index),
        kind: String(r.kind), code: str(r.code), detail: (r.detail ?? null) as Record<string, unknown> | null, at: date(r.at) }));
    },
    /** Compare-and-set on the run: from one of `from` at exactly `version`. Null when the run moved on (re-read it). */
    async transition(runId: string, expected: { readonly version: number; readonly from: readonly RunState[] }, to: RunState, patch: RunPatch,
      kind = 'RUN_STATE'): Promise<RunRecord | null> {
      return db.transaction(async tx => {
        const row = (await tx.query(`UPDATE workflow_runs SET state = $5, version = version + 1, current_step = COALESCE($6, current_step), mode = COALESCE($7, mode),
            authorization_id = COALESCE($8, authorization_id), code = CASE WHEN $9::boolean THEN $10 ELSE code END, completed_at = COALESCE($11, completed_at)
          WHERE tenant_id = $1 AND run_id = $2 AND version = $3 AND state = ANY($4::text[]) RETURNING *`,
        [tenantId, runId, expected.version, [...expected.from], to, patch.currentStep ?? null, patch.mode ?? null, patch.authorizationId ?? null,
          patch.code !== undefined, patch.code ?? null, patch.completedAt ?? null])).rows[0];
        if (!row) return null;
        await event(tx, runId, null, kind, patch.code ?? null, { state: to, ...patch.currentStep !== undefined ? { currentStep: patch.currentStep } : {} });
        return runOf(row);
      });
    },
    /** Compare-and-set on one step: from one of `from`. Null when the step is elsewhere. */
    async stepTransition(runId: string, stepIndex: number, from: readonly StepState[], to: StepState, patch: StepPatch, kind = 'STEP_STATE'): Promise<RunStepRecord | null> {
      return db.transaction(async tx => {
        // Serialize step loading with cancellation. A stale continue/worker cannot load a cancelled run.
        const run = await lockRun(tx, runId);
        if (!run || run.state === 'CANCELLED') return null;
        const row = (await tx.query(`UPDATE workflow_run_steps SET state = $5, version = version + 1, flow = COALESCE($6, flow), strategy = COALESCE($7::jsonb, strategy),
            workflow_hash = COALESCE($8, workflow_hash), bound = COALESCE($9::jsonb, bound), claimed_at = COALESCE($10, claimed_at), outcome = COALESCE($11::jsonb, outcome),
            code = CASE WHEN $12::boolean THEN $13 ELSE code END
          WHERE tenant_id = $1 AND run_id = $2 AND step_index = $3 AND state = ANY($4::text[]) RETURNING *`,
        [tenantId, runId, stepIndex, [...from], to, patch.flow ?? null, json(patch.strategy), patch.workflowHash ?? null, json(patch.bound), patch.claimedAt ?? null,
          json(patch.outcome), patch.code !== undefined, patch.code ?? null])).rows[0];
        if (!row) return null;
        await event(tx, runId, stepIndex, kind, patch.code ?? null, { state: to, ...patch.workflowHash ? { workflowHash: patch.workflowHash } : {},
          ...patch.outcome ? { transactions: patch.outcome.transactions.map(t => t.hash) } : {} });
        return stepOf(row);
      });
    },
    /** Cancellation and skipping are atomic under the same run lock used by step loading and delegated activation. */
    cancel: (runId: string, version: number, code: string) => db.transaction(async tx => {
      const run = await lockRun(tx, runId) ?? refuse('WORKFLOW_RUN_NOT_FOUND');
      if (run.version !== version) refuse('WORKFLOW_RUN_CHANGED');
      if (!['PENDING', 'RUNNING', 'HALTED'].includes(run.state)) refuse(`WORKFLOW_RUN_${run.state}`);
      if (run.mode === 'DELEGATED') refuse('WORKFLOW_RUN_REVOKE_REQUIRED');
      const steps = (await tx.query('SELECT * FROM workflow_run_steps WHERE tenant_id = $1 AND run_id = $2 ORDER BY step_index FOR UPDATE', [tenantId, runId])).rows.map(stepOf);
      if (!canEndWorkflow(run, steps)) refuse('WORKFLOW_RUN_STEP_IN_FLIGHT');
      const row = (await tx.query(`UPDATE workflow_runs SET state = 'CANCELLED', code = $3, version = version + 1
        WHERE tenant_id = $1 AND run_id = $2 RETURNING *`, [tenantId, runId, code])).rows[0]!;
      for (const step of steps) if (['PENDING', 'READY', 'BLOCKED'].includes(step.state)) {
        await tx.query(`UPDATE workflow_run_steps SET state = 'SKIPPED', code = $4, version = version + 1
          WHERE tenant_id = $1 AND run_id = $2 AND step_index = $3`, [tenantId, runId, step.stepIndex, code]);
        await event(tx, runId, step.stepIndex, 'STEP_STATE', code, { state: 'SKIPPED' });
      }
      await event(tx, runId, null, 'RUN_CANCELLED', code, { state: 'CANCELLED' });
      return runOf(row);
    }),
    /**
     * The owner chose to confirm each step: one transaction under the run's lock. The run must still be PENDING without a mode; any unsigned
     * delegated authorization of this run is revoked in the same transaction (it can never be signed later); the run starts RUNNING.
     */
    startConfirm: (runId: string, now: Date) => db.transaction(async tx => {
      const run = await lockRun(tx, runId) ?? refuse('WORKFLOW_RUN_NOT_FOUND');
      if (run.mode === 'CONFIRM_EACH_STEP' && run.state !== 'PENDING') return run;
      if (run.state !== 'PENDING' || run.mode !== null) refuse(`WORKFLOW_RUN_${run.state}`);
      if (run.expiresAt <= now) refuse('WORKFLOW_RUN_EXPIRED');
      const pending = (await tx.query(`SELECT authorization_id FROM delegated_authorizations WHERE tenant_id = $1 AND workflow_run_id = $2 AND state <> 'REVOKED' FOR UPDATE`,
        [tenantId, runId])).rows.map(r => String(r.authorization_id));
      for (const authorizationId of pending) {
        await tx.query(`UPDATE delegated_authorization_revisions SET state = 'REVOKED' WHERE tenant_id = $1 AND authorization_id = $2 AND state IN ('ACTIVE', 'PENDING_SIGNATURE')`,
          [tenantId, authorizationId]);
        await tx.query(`UPDATE delegated_authorizations SET state = 'REVOKED', active_revision = NULL, revoked_at = $3, revoke_code = 'WORKFLOW_RUN_CONFIRM_MODE_CHOSEN',
          version = version + 1 WHERE tenant_id = $1 AND authorization_id = $2`, [tenantId, authorizationId, now]);
      }
      const row = (await tx.query(`UPDATE workflow_runs SET state = 'RUNNING', mode = 'CONFIRM_EACH_STEP', version = version + 1 WHERE tenant_id = $1 AND run_id = $2 RETURNING *`,
        [tenantId, runId])).rows[0]!;
      await event(tx, runId, null, 'MODE_CHOSEN', null, { mode: 'CONFIRM_EACH_STEP', revokedUnsignedAuthorizations: pending.length });
      await enqueue(tx, runId);
      return runOf(row);
    }),
    /**
     * Inside the delegation store's activation transaction (after the passkey assertion verified): the run must still be PENDING without a
     * mode; it becomes DELEGATED and RUNNING, every step DELEGATED, and the delegated execution's work item is enqueued with it.
     */
    async activateDelegatedWithin(tx: Queryable, runId: string, authorizationId: string, executeKind: string): Promise<void> {
      const run = await lockRun(tx, runId) ?? refuse('WORKFLOW_RUN_NOT_FOUND');
      if (run.state !== 'PENDING' || run.mode !== null) refuse(`WORKFLOW_RUN_${run.mode === 'CONFIRM_EACH_STEP' ? 'CONFIRM_MODE_CHOSEN' : run.state}`);
      await tx.query(`UPDATE workflow_runs SET state = 'RUNNING', mode = 'DELEGATED', authorization_id = $3, version = version + 1 WHERE tenant_id = $1 AND run_id = $2`,
        [tenantId, runId, authorizationId]);
      await tx.query(`UPDATE workflow_run_steps SET state = 'DELEGATED', version = version + 1 WHERE tenant_id = $1 AND run_id = $2 AND state = 'PENDING'`, [tenantId, runId]);
      await event(tx, runId, null, 'MODE_CHOSEN', null, { mode: 'DELEGATED', authorizationId });
      await tx.query(`INSERT INTO work_items (tenant_id, kind, dedupe_key, run_id, payload, state, available_at) VALUES ($1, $2, $3, NULL, $4::jsonb, 'READY', now())
        ON CONFLICT (tenant_id, kind, dedupe_key) WHERE state IN ('READY', 'LEASED') DO NOTHING`,
      [tenantId, executeKind, runId, JSON.stringify({ workflowRunId: runId, authorizationId })]);
      await enqueue(tx, runId);
    },
    /** Schedules (or keeps) the run's advance work item. */
    advanceLater: (runId: string, delayMs = 0) => enqueue(db, runId, delayMs),
    /** Open runs whose advance item is missing (defense in depth; the sweep re-arms them). */
    async openWithoutWork(limit = 50): Promise<readonly string[]> {
      return (await db.query(`SELECT r.run_id FROM workflow_runs r WHERE r.tenant_id = $1 AND r.state IN ('RUNNING', 'ATTENTION', 'PENDING')
          AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.tenant_id = r.tenant_id AND w.kind = $2 AND w.dedupe_key = r.run_id AND w.state IN ('READY', 'LEASED'))
        ORDER BY r.updated_at LIMIT $3`, [tenantId, WORKFLOW_RUN_ADVANCE_KIND, Math.min(Math.max(1, limit), 500)])).rows.map(r => String(r.run_id));
    },
  };
}
export type WorkflowRunStore = ReturnType<typeof createPgWorkflowRunStore>;
