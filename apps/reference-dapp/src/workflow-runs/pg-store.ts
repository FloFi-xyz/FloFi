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
import { CERTIFIED_FORWARD_MIGRATIONS, SHIPPED_MIGRATIONS, type Database, type Queryable, type Row } from '@defi-workflow-engine/cloud-runtime';
import type { StrategyInput, StrategySpec } from '../engine/strategy-spec';
import type { ApprovalRequesterKind, RequesterScope, WalletRef } from '../platform/handoff-store.ts';
import { WALLET_BATCH_OUTCOME_UNKNOWN, WALLET_REQUEST_REJECTED, WORKFLOW_RUN_ADVANCE_KIND, canEndWorkflow, groupInFlight, walletBatchUnanswered, type RunMode,
  type RunState, type StepState } from './state-machine.ts';
import type { ExecutionGroup, GroupStrategy, SigningTime } from './execution-groups.ts';
import { plannedGroupCode } from './owner-step-circle.ts';
import type { TokenFeePaid } from '../user-funded/gas-payer.ts';
import { revenueOriginsActive, type ExecutionOrigin } from './execution-origins.ts';

export type WalletSet = Readonly<Partial<Record<WalletRef['namespace'], string>>>;
/** How a bound step's amount was resolved (native units of `asset`). */
export type BoundResolution = { readonly amountFrom: number; readonly asset: { readonly chainId: string; readonly address: string; readonly decimals: number };
  readonly cap: string; readonly received: string; readonly used: string;
  /** Position inputs can be funded by two distinct reconciled producer assets. */ readonly additional?: readonly BoundResolution[] };
/** Public reconciled facts of one step (never calldata, keys or signatures). */
export type StepOutcome = {
  /** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: USER_FUNDED_GROUP — the step ran inside an owner-authorized execution group (`executionId` = `<run>:g<k>`). */
  readonly kind: 'OWNER_RUN' | 'DELEGATED_STEP' | 'USER_FUNDED_GROUP'; readonly executionId: string; readonly flow: string | null; readonly status: string;
  readonly transactions: readonly { readonly chain: string; readonly hash: string }[];
  readonly evidence: { readonly environment: string; readonly outcome: string; readonly bundleHash: string | null } | null;
  readonly spent: readonly { readonly asset: string; readonly amount: string }[];
  readonly received: readonly import('./received-amounts.ts').FlowAmount[];
  readonly observedAt: string;
  /** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: network fees actually paid for the group this step ran in, and by whom (always the owner's wallet). */
  readonly gasPaid?: { readonly payer: string; readonly amount: string; readonly unit: 'wei' | 'lamports'; readonly source: string; readonly group: number;
    /** ADR-0010: the payer fronted the native fee and the OWNER paid it back in a token (proven from the same receipt). */
    readonly paidInToken?: TokenFeePaid } };
export type OwnerStepOutcome = StepOutcome & { readonly kind: 'OWNER_RUN'; readonly flow: string };
export const OWNER_EXECUTION_CLAIMED = 'WORKFLOW_STEP_EXECUTION_ALREADY_CLAIMED';
/** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: one execution group of a USER_FUNDED run (migration 0023). */
export const GROUP_STATES = ['PLANNED', 'PREPARED', 'AUTHORIZED', 'SUBMITTED', 'RECONCILED', 'FAILED', 'UNCERTAIN', 'BLOCKED', 'SKIPPED', 'EXPIRED'] as const;
export type GroupState = (typeof GROUP_STATES)[number];
export type GroupRecord = {
  readonly runId: string; readonly groupIndex: number; readonly namespace: 'eip155' | 'solana'; readonly chain: string; readonly feePayer: string;
  readonly stepFrom: number; readonly stepTo: number; readonly strategy: GroupStrategy; readonly signing: SigningTime; readonly awaitsDelivery: number | null;
  readonly state: GroupState; readonly prepared: Readonly<Record<string, unknown>> | null; readonly authorization: Readonly<Record<string, unknown>> | null;
  readonly submission: Readonly<Record<string, unknown>> | null; readonly outcome: Readonly<Record<string, unknown>> | null; readonly code: string | null;
  readonly validUntil: Date | null; readonly version: number; readonly updatedAt: Date };
export type GroupPatch = { readonly strategy?: GroupStrategy; readonly signing?: SigningTime; readonly prepared?: Readonly<Record<string, unknown>> | null;
  readonly authorization?: Readonly<Record<string, unknown>> | null; readonly submission?: Readonly<Record<string, unknown>>; readonly outcome?: Readonly<Record<string, unknown>>;
  readonly code?: string | null; readonly validUntil?: Date | null };
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
  readonly strategy: StrategyInput; readonly workflowHash: string; readonly engineVersion: string; readonly stepCount: number; readonly expiresAt: Date;
  /** BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001: the channel the run started from (its handoff's requester), recorded once with the run (0037). */
  readonly origin?: ExecutionOrigin;
  /** The closed code of the server-side record that origin came from (default: the approval's requester). */
  readonly originEvidence?: string };
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
const groupOf = (r: Row): GroupRecord => ({ runId: String(r.run_id), groupIndex: Number(r.group_index), namespace: r.namespace as GroupRecord['namespace'],
  chain: String(r.chain), feePayer: String(r.fee_payer), stepFrom: Number(r.step_from), stepTo: Number(r.step_to), strategy: r.strategy as GroupStrategy,
  signing: r.signing as SigningTime, awaitsDelivery: r.awaits_delivery === null || r.awaits_delivery === undefined ? null : Number(r.awaits_delivery), state: r.state as GroupState,
  prepared: (r.prepared ?? null) as GroupRecord['prepared'], authorization: (r.owner_authorization ?? null) as GroupRecord['authorization'],
  submission: (r.submission ?? null) as GroupRecord['submission'], outcome: (r.outcome ?? null) as GroupRecord['outcome'], code: str(r.code),
  validUntil: maybeDate(r.valid_until), version: Number(r.version), updatedAt: date(r.updated_at) });
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
  /** One step's compare-and-set inside a transaction that already holds the run lock. */
  const stepUpdate = async (tx: Queryable, runId: string, stepIndex: number, from: readonly StepState[], to: StepState, patch: StepPatch, kind: string, claimHeld = false)
    : Promise<RunStepRecord | null> => {
    if (patch.outcome?.kind === 'OWNER_RUN' && !claimHeld) refuse('WORKFLOW_STEP_OWNER_OUTCOME_REQUIRES_CLAIM');
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
  };
  /** One group's compare-and-set inside a transaction that already holds the run lock. */
  const groupUpdate = async (tx: Queryable, runId: string, groupIndex: number, from: readonly GroupState[], to: GroupState, patch: GroupPatch, kind: string,
    expectVersion: number | null): Promise<GroupRecord | null> => {
    const has = (k: keyof GroupPatch) => Object.prototype.hasOwnProperty.call(patch, k);
    const row = (await tx.query(`UPDATE workflow_run_groups SET state = $5, version = version + 1, strategy = COALESCE($6, strategy), signing = COALESCE($7, signing),
        prepared = CASE WHEN $8::boolean THEN $9::jsonb ELSE prepared END, owner_authorization = CASE WHEN $10::boolean THEN $11::jsonb ELSE owner_authorization END,
        submission = COALESCE($12::jsonb, submission), outcome = COALESCE($13::jsonb, outcome), code = CASE WHEN $14::boolean THEN $15 ELSE code END,
        valid_until = CASE WHEN $16::boolean THEN $17::timestamptz ELSE valid_until END
      WHERE tenant_id = $1 AND run_id = $2 AND group_index = $3 AND state = ANY($4::text[]) AND ($18::bigint IS NULL OR version = $18::bigint) RETURNING *`,
    [tenantId, runId, groupIndex, [...from], to, patch.strategy ?? null, patch.signing ?? null, has('prepared'), json(patch.prepared), has('authorization'), json(patch.authorization),
      json(patch.submission), json(patch.outcome), has('code'), patch.code ?? null, has('validUntil'), patch.validUntil ?? null, expectVersion])).rows[0];
    if (!row) return null;
    await event(tx, runId, null, kind, patch.code ?? null, { group: groupIndex, state: to,
      ...patch.submission ? { hashes: (patch.submission as { hashes?: unknown }).hashes ?? null } : {} });
    return groupOf(row);
  };

  return {
    tenantId,
    /**
     * The run of an approval handoff, created once with all its steps PENDING (the same transaction); a repeated claim returns the existing
     * run unchanged. The caller has already verified the claim (wallet proof, requester rule, re-composition to the same hash).
     */
    create: async (input: NewRun, now: Date) => {
      // Decided before the transaction: a failed check inside it would abort the run's own transaction.
      const recordOrigin = input.origin !== undefined && await revenueOriginsActive(db);
      return db.transaction(async tx => {
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
        // BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001: the run's origin, in the creating transaction (0037 only). Its own savepoint: an origin that
        // cannot be written never rolls the run back (attribution is analytics, never a precondition of an execution).
        if (input.origin && recordOrigin) {
          await tx.query('SAVEPOINT execution_origin');
          try {
            await tx.query(`INSERT INTO execution_origins (tenant_id, workflow_run_id, origin, basis, evidence) VALUES ($1, $2, $3, 'CREATION', $4)
              ON CONFLICT DO NOTHING`, [tenantId, input.runId, input.origin, input.originEvidence ?? 'APPROVAL_REQUESTER']);
            await tx.query('RELEASE SAVEPOINT execution_origin');
          } catch { await tx.query('ROLLBACK TO SAVEPOINT execution_origin'); }
        }
      }
      return runOf((await tx.query('SELECT * FROM workflow_runs WHERE tenant_id = $1 AND handoff_id = $2', [tenantId, input.handoffId])).rows[0]!);
      });
    },
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
    async loadedBoundSteps(wallet: string, flow: string, createdAt: Date): Promise<readonly RunStepRecord[]> {
      return (await db.query(`SELECT s.* FROM workflow_runs r JOIN workflow_run_steps s USING (tenant_id, run_id)
        WHERE r.tenant_id = $1
          AND r.wallets->>(CASE WHEN left($2::text, 2) = '0x' THEN 'eip155' ELSE 'solana' END) = $2
          AND s.flow = $3 AND (s.bound IS NOT NULL OR s.flow = 'crosschain-universal')
          AND r.mode IN ('CONFIRM_EACH_STEP', 'USER_FUNDED') AND s.claimed_at <= $4::timestamptz + interval '1 second'
          AND (r.current_step = s.step_index AND r.state IN ('RUNNING', 'ATTENTION') AND s.state IN ('AWAITING_OWNER', 'UNCERTAIN')
            OR $4::timestamptz <= LEAST(r.expires_at, s.updated_at))`, [tenantId, wallet, flow, createdAt])).rows.map(stepOf);
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
        return stepUpdate(tx, runId, stepIndex, from, to, patch, kind);
      });
    },
    /** One wallet execution belongs to one workflow step. Its observed or final outcome is also the durable claim. */
    async settleOwnerStep(runId: string, stepIndex: number, to: 'RECONCILED' | 'FAILED' | 'UNCERTAIN', outcome: OwnerStepOutcome,
      code: string | null): Promise<'RECORDED' | 'CLAIMED' | 'MOVED'> {
      return db.transaction(async tx => {
        // The lookup after the advisory lock must see the other transaction's committed step, even with a different session default.
        await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        const run = await lockRun(tx, runId);
        if (!run || !['RUNNING', 'ATTENTION'].includes(run.state) || run.currentStep !== stepIndex) return 'MOVED';
        const { rows: [step] } = await tx.query<{ state: 'AWAITING_OWNER' | 'UNCERTAIN'; code: string | null; execution_id: string | null }>(`
          SELECT state, code, outcome->>'executionId' AS execution_id FROM workflow_run_steps
          WHERE tenant_id = $1 AND run_id = $2 AND step_index = $3 AND flow = $4 AND state IN ('AWAITING_OWNER', 'UNCERTAIN')`, [tenantId, runId, stepIndex, outcome.flow]);
        if (!step) return 'MOVED';
        if (step.execution_id && step.execution_id !== outcome.executionId) return 'CLAIMED';
        if (to === 'UNCERTAIN' && step.state === 'UNCERTAIN' && step.execution_id === outcome.executionId && step.code === code) return 'RECORDED';
        const key = JSON.stringify(['flofi.workflow-owner-execution', tenantId, outcome.flow, outcome.executionId]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
        const { rows: [claim] } = await tx.query(`SELECT 1 FROM workflow_run_steps
          WHERE tenant_id = $1 AND state IN ('RECONCILED', 'FAILED', 'UNCERTAIN') AND outcome->>'kind' = 'OWNER_RUN'
            AND COALESCE(outcome->>'flow', flow) = $2 AND outcome->>'executionId' = $3 AND (run_id,step_index) <> ($4,$5)
          LIMIT 1`, [tenantId, outcome.flow, outcome.executionId, runId, stepIndex]);
        if (claim) {
          // Persist the contest even if the candidate later drops out of the bounded scan. No subsequent status read can reopen signing.
          if (step.state !== 'UNCERTAIN' || step.code !== OWNER_EXECUTION_CLAIMED)
            await stepUpdate(tx, runId, stepIndex, [step.state], 'UNCERTAIN', { code: OWNER_EXECUTION_CLAIMED }, 'STEP_STATE');
          return 'CLAIMED';
        }
        return await stepUpdate(tx, runId, stepIndex, [step.state], to, { outcome, code }, 'STEP_STATE', true) ? 'RECORDED' : 'MOVED';
      });
    },
    /**
     * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): the owner's browser reports that the wallet REJECTED this group's batch
     * (EIP-1193 4001). Recorded as an append-only fact, never a state change (the owner may still authorize the same request again while it is
     * valid): only for a wallet batch still PREPARED, unanswered, and exactly the preparation the report names (its EIP-5792 id and preparation
     * time). The report proves nothing on its own; `user-funded/decline-proof.ts` checks it against the chain before anything relies on it.
     */
    recordDecline: (runId: string, groupIndex: number, requestId: string, preparedAt: string) => db.transaction(async tx => {
      const run = await lockRun(tx, runId) ?? refuse('WORKFLOW_RUN_NOT_FOUND');
      if (run.state !== 'RUNNING' || run.mode !== 'USER_FUNDED') refuse(`WORKFLOW_RUN_${run.state}`);
      const row = (await tx.query('SELECT * FROM workflow_run_groups WHERE tenant_id = $1 AND run_id = $2 AND group_index = $3 FOR UPDATE', [tenantId, runId, groupIndex])).rows[0];
      const g = row ? groupOf(row) : refuse('WORKFLOW_RUN_GROUP_NOT_FOUND');
      const prepared = (g.prepared ?? {}) as { readonly request?: { readonly id?: unknown }; readonly preparedAt?: unknown };
      if (g.state !== 'PREPARED' || g.strategy !== 'EVM_WALLET_BATCH' || g.authorization !== null || prepared.request?.id !== requestId || prepared.preparedAt !== preparedAt)
        refuse('WORKFLOW_RUN_DECLINE_NOT_THIS_REQUEST');
      // One fact per preparation (security review): a repeated report records nothing more.
      const known = (await tx.query(`SELECT 1 FROM workflow_run_events WHERE tenant_id = $1 AND run_id = $2 AND kind = 'GROUP_WALLET_DECLINED'
        AND detail->>'group' = $3 AND detail->>'requestId' = $4 AND detail->>'preparedAt' = $5 LIMIT 1`, [tenantId, runId, String(groupIndex), requestId, preparedAt])).rows.length > 0;
      if (!known) await event(tx, runId, null, 'GROUP_WALLET_DECLINED', 'WALLET_REQUEST_REJECTED', { group: groupIndex, requestId, preparedAt });
      return g;
    }),
    /**
     * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (security review): a wallet answer (a batch id, transactions or "not sent") arrived for a group
     * that ended as a verified rejection. Kept as an append-only fact under the run's lock (any state): the attempt is then never deletable.
     */
    recordAnswerAfterStop: (runId: string, groupIndex: number, detail: { readonly batchIdReported: boolean; readonly hashes: number | null; readonly notSent: boolean | null }) =>
      db.transaction(async tx => {
        if (!await lockRun(tx, runId)) refuse('WORKFLOW_RUN_NOT_FOUND');
        await event(tx, runId, null, 'GROUP_ANSWER_AFTER_STOP', 'WALLET_BATCH_ANSWERED_AFTER_STOP', { group: groupIndex, ...detail });
      }),
    /** Cancellation and skipping are atomic under the same run lock used by step loading and delegated activation. */
    cancel: (runId: string, version: number, code: string, now: Date = new Date(), options: {
      /**
       * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): groups whose rejected batch the server proved, from the chain, was never
       * sent (`user-funded/decline-proof.ts`). Applied only to exactly that preparation, still unanswered under this lock: the group and its steps
       * say WALLET_REQUEST_REJECTED (nothing was sent) instead of an unknown outcome, and the proof is kept as an append-only fact. Anything else
       * is cancelled exactly as before.
       */
      readonly verifiedDeclines?: ReadonlyMap<number, VerifiedDecline>;
      /** End the run only if every unanswered wallet batch is one of `verifiedDeclines` here, under the lock; otherwise refuse and change nothing. */
      readonly onlyIfDeclineVerified?: boolean } = {}) => db.transaction(async tx => {
      const run = await lockRun(tx, runId) ?? refuse('WORKFLOW_RUN_NOT_FOUND');
      if (run.version !== version) refuse('WORKFLOW_RUN_CHANGED');
      if (!['PENDING', 'RUNNING', 'HALTED'].includes(run.state)) refuse(`WORKFLOW_RUN_${run.state}`);
      if (run.mode === 'DELEGATED') refuse('WORKFLOW_RUN_REVOKE_REQUIRED');
      const steps = (await tx.query('SELECT * FROM workflow_run_steps WHERE tenant_id = $1 AND run_id = $2 ORDER BY step_index FOR UPDATE', [tenantId, runId])).rows.map(stepOf);
      if (!canEndWorkflow(run, steps)) refuse('WORKFLOW_RUN_STEP_IN_FLIGHT');
      const row = (await tx.query(`UPDATE workflow_runs SET state = 'CANCELLED', code = $3, version = version + 1
        WHERE tenant_id = $1 AND run_id = $2 RETURNING *`, [tenantId, runId, code])).rows[0]!;
      // BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: a user-funded run ends only while no group may be in flight (signed but not reconciled).
      const outcomeOf = new Map<number, string>();
      if (run.mode === 'USER_FUNDED') {
        const groups = (await tx.query('SELECT * FROM workflow_run_groups WHERE tenant_id = $1 AND run_id = $2 ORDER BY group_index FOR UPDATE', [tenantId, runId])).rows.map(groupOf);
        // The same rule the owner's "End workflow" uses (`groupInFlight`): FloFi never relays a skipped user operation or Solana signature, and
        // the owner is shown how to revoke a signed operation.
        if (groups.some(g => groupInFlight(g, now))) refuse('WORKFLOW_RUN_GROUP_IN_FLIGHT');
        if (options.onlyIfDeclineVerified) {
          const unanswered = groups.filter(g => g.state === 'PREPARED' && walletBatchUnanswered(g));
          const matches = (g: GroupRecord) => { const v = options.verifiedDeclines?.get(g.groupIndex), p = (g.prepared ?? {}) as { request?: { id?: unknown }; preparedAt?: unknown };
            return Boolean(v && p.request?.id === v.requestId && p.preparedAt === v.preparedAt); };
          if (!unanswered.length || !unanswered.every(matches)) refuse('WORKFLOW_RUN_DECLINE_NOT_PROVEN');
        }
        for (const g of groups) if (['PLANNED', 'PREPARED', 'EXPIRED', 'BLOCKED', 'AUTHORIZED'].includes(g.state)) {
          // A wallet batch handed to the owner's wallet whose answer never reached FloFi is past its validity here (else it would be in flight),
          // yet it may have executed before its on-chain deadline: it is still SKIPPED (nothing more of it is sent or taken), but its group and
          // steps say the outcome is unknown, never a plain "not run" (the run's note tells the owner to check the wallet's activity).
          const verified = options.verifiedDeclines?.get(g.groupIndex);
          const prepared = (g.prepared ?? {}) as { readonly request?: { readonly id?: unknown }; readonly preparedAt?: unknown };
          const declined = Boolean(verified && g.state === 'PREPARED' && walletBatchUnanswered(g) && prepared.request?.id === verified.requestId
            && prepared.preparedAt === verified.preparedAt);
          const skipped = declined ? WALLET_REQUEST_REJECTED : walletBatchUnanswered(g) ? WALLET_BATCH_OUTCOME_UNKNOWN : code;
          if (skipped !== code) for (let i = g.stepFrom; i <= g.stepTo; i++) outcomeOf.set(i, skipped);
          if (declined) await event(tx, runId, null, 'GROUP_DECLINE_VERIFIED', WALLET_REQUEST_REJECTED, { group: g.groupIndex, requestId: verified!.requestId,
            preparedAt: verified!.preparedAt, ownerNonce: verified!.ownerNonce, fromBlock: verified!.fromBlock, toBlock: verified!.toBlock });
          await tx.query(`UPDATE workflow_run_groups SET state = 'SKIPPED', code = $4, version = version + 1 WHERE tenant_id = $1 AND run_id = $2 AND group_index = $3`,
            [tenantId, runId, g.groupIndex, skipped]);
          await event(tx, runId, null, 'GROUP_STATE', skipped, { group: g.groupIndex, state: 'SKIPPED' });
        }
      }
      for (const step of steps) if (['PENDING', 'READY', 'BLOCKED'].includes(step.state) || (run.mode === 'USER_FUNDED' && step.state === 'DELEGATED')) {
        const skipped = outcomeOf.get(step.stepIndex) ?? code;
        await tx.query(`UPDATE workflow_run_steps SET state = 'SKIPPED', code = $4, version = version + 1
          WHERE tenant_id = $1 AND run_id = $2 AND step_index = $3`, [tenantId, runId, step.stepIndex, skipped]);
        await event(tx, runId, step.stepIndex, 'STEP_STATE', skipped, { state: 'SKIPPED' });
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
    /**
     * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the owner chose user-funded execution. One transaction under the run's lock: the run must still be
     * PENDING without a mode and unexpired; any unsigned delegated authorization of it is revoked; the run becomes RUNNING in mode
     * USER_FUNDED; its execution groups are inserted PLANNED (the database checks each group's fee payer is the run's own wallet, S1); the
     * steps of every group FloFi executes outside the step's own flow become DELEGATED (observed by the run), the others stay PENDING.
     */
    startUserFunded: (runId: string, groups: readonly ExecutionGroup[], now: Date) => db.transaction(async tx => {
      const run = await lockRun(tx, runId) ?? refuse('WORKFLOW_RUN_NOT_FOUND');
      if (run.mode === 'USER_FUNDED' && run.state !== 'PENDING') return run;
      if (run.state !== 'PENDING' || run.mode !== null) refuse(`WORKFLOW_RUN_${run.mode === 'CONFIRM_EACH_STEP' ? 'CONFIRM_MODE_CHOSEN' : run.state}`);
      if (run.expiresAt <= now) refuse('WORKFLOW_RUN_EXPIRED');
      if (!groups.length || groups[0]!.stepFrom !== 0 || groups.at(-1)!.stepTo !== run.stepCount - 1
        || groups.some((g, i) => g.index !== i || (i > 0 && g.stepFrom !== groups[i - 1]!.stepTo + 1))) refuse('WORKFLOW_GROUPS_INVALID');
      const pending = (await tx.query(`SELECT authorization_id FROM delegated_authorizations WHERE tenant_id = $1 AND workflow_run_id = $2 AND state <> 'REVOKED' FOR UPDATE`,
        [tenantId, runId])).rows.map(r => String(r.authorization_id));
      for (const authorizationId of pending) {
        await tx.query(`UPDATE delegated_authorization_revisions SET state = 'REVOKED' WHERE tenant_id = $1 AND authorization_id = $2 AND state IN ('ACTIVE', 'PENDING_SIGNATURE')`,
          [tenantId, authorizationId]);
        await tx.query(`UPDATE delegated_authorizations SET state = 'REVOKED', active_revision = NULL, revoked_at = $3, revoke_code = 'WORKFLOW_RUN_USER_FUNDED_MODE_CHOSEN',
          version = version + 1 WHERE tenant_id = $1 AND authorization_id = $2`, [tenantId, authorizationId, now]);
      }
      const row = (await tx.query(`UPDATE workflow_runs SET state = 'RUNNING', mode = 'USER_FUNDED', version = version + 1 WHERE tenant_id = $1 AND run_id = $2 RETURNING *`,
        [tenantId, runId])).rows[0]!;
      for (const g of groups) {
        const feePayer = run.wallets[g.namespace] ?? refuse(g.namespace === 'solana' ? 'SOLANA_WALLET_PROOF_REQUIRED' : 'EVM_WALLET_PROOF_REQUIRED');
        // Final review (P3): a FloFi Wallet owner-step group whose fee Circle may pay is planned CIRCLE_ASK_FIRST (owner-step-circle.ts).
        await tx.query(`INSERT INTO workflow_run_groups (tenant_id, run_id, group_index, namespace, chain, fee_payer, step_from, step_to, strategy, signing, awaits_delivery,
            state, code, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PLANNED', $13, $12, $12)`,
        [tenantId, runId, g.index, g.namespace, g.chain, feePayer, g.stepFrom, g.stepTo, g.strategy, g.signing, g.awaitsDelivery, now, plannedGroupCode(g)]);
        if (g.strategy !== 'EVM_OWNER_STEP' && g.strategy !== 'SOLANA_OWNER_STEP')
          await tx.query(`UPDATE workflow_run_steps SET state = 'DELEGATED', version = version + 1 WHERE tenant_id = $1 AND run_id = $2 AND step_index BETWEEN $3 AND $4
            AND state = 'PENDING'`, [tenantId, runId, g.stepFrom, g.stepTo]);
      }
      await event(tx, runId, null, 'MODE_CHOSEN', null, { mode: 'USER_FUNDED', groups: groups.map(g => ({ index: g.index, strategy: g.strategy, steps: [g.stepFrom, g.stepTo] })),
        revokedUnsignedAuthorizations: pending.length });
      await enqueue(tx, runId);
      return runOf(row);
    }),
    async groups(runId: string): Promise<readonly GroupRecord[]> {
      return (await db.query('SELECT * FROM workflow_run_groups WHERE tenant_id = $1 AND run_id = $2 ORDER BY group_index', [tenantId, runId])).rows.map(groupOf);
    },
    /**
     * Compare-and-set on one group: from one of `from`, under the run lock (serialized with cancellation and step moves). Null when elsewhere.
     * `expectVersion`: also only from exactly that row version (a same-state rewrite, e.g. a wallet batch re-prepared while it stays PREPARED,
     * must never overwrite a concurrent rewrite it did not see).
     */
    async groupTransition(runId: string, groupIndex: number, from: readonly GroupState[], to: GroupState, patch: GroupPatch, kind = 'GROUP_STATE',
      expectVersion: number | null = null): Promise<GroupRecord | null> {
      return db.transaction(async tx => {
        const run = await lockRun(tx, runId);
        if (!run || run.state === 'CANCELLED') return null;
        return groupUpdate(tx, runId, groupIndex, from, to, patch, kind, expectVersion);
      });
    },
    /**
     * Final review (P3): several group and step transitions of ONE run as one unit, under the run lock — all of them, or none. `work` sees the
     * run's steps and groups and makes its transitions through `scope` (each a compare-and-set, exactly as `stepTransition`/`groupTransition`);
     * returning null rolls every one of them back. Null too when the run is gone or cancelled. Used where a group and its steps must never be
     * seen apart (a FloFi Wallet owner-step group switched to one Circle-paid operation, and given back).
     */
    async atomically<T>(runId: string, work: (scope: RunScope) => Promise<T | null>): Promise<T | null> {
      try {
        return await db.transaction(async tx => {
          const run = await lockRun(tx, runId);
          if (!run || run.state === 'CANCELLED') return null;
          const scope: RunScope = {
            run,
            appendEvent: (kind, code, detail) => event(tx, runId, null, kind, code, detail).then(() => undefined),
            steps: async id => (await tx.query('SELECT * FROM workflow_run_steps WHERE tenant_id = $1 AND run_id = $2 ORDER BY step_index', [tenantId, id])).rows.map(stepOf),
            groups: async id => (await tx.query('SELECT * FROM workflow_run_groups WHERE tenant_id = $1 AND run_id = $2 ORDER BY group_index', [tenantId, id])).rows.map(groupOf),
            stepTransition: (id, stepIndex, from, to, patch, kind = 'STEP_STATE') => id === runId ? stepUpdate(tx, id, stepIndex, from, to, patch, kind) : Promise.resolve(null),
            groupTransition: (id, groupIndex, from, to, patch, kind = 'GROUP_STATE', expectVersion = null) =>
              id === runId ? groupUpdate(tx, id, groupIndex, from, to, patch, kind, expectVersion) : Promise.resolve(null),
          };
          const result = await work(scope);
          if (result === null) throw ROLLED_BACK;
          return result;
        });
      } catch (cause) {
        if (cause === ROLLED_BACK) return null;
        throw cause;
      }
    },
    /** Schedules (or keeps) the run's advance work item. */
    advanceLater: (runId: string, delayMs = 0) => enqueue(db, runId, delayMs),
    /** BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: whether this database accepts a run of ONE step (migration 0032; `singleStepRunsSupported`). */
    singleStepRuns: () => singleStepRunsSupported(db),
    /** Open runs whose advance item is missing (defense in depth; the sweep re-arms them). */
    async openWithoutWork(limit = 50): Promise<readonly string[]> {
      return (await db.query(`SELECT r.run_id FROM workflow_runs r WHERE r.tenant_id = $1 AND r.state IN ('RUNNING', 'ATTENTION', 'PENDING')
          AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.tenant_id = r.tenant_id AND w.kind = $2 AND w.dedupe_key = r.run_id AND w.state IN ('READY', 'LEASED'))
        ORDER BY r.updated_at LIMIT $3`, [tenantId, WORKFLOW_RUN_ADVANCE_KIND, Math.min(Math.max(1, limit), 500)])).rows.map(r => String(r.run_id));
    },
  };
}
export type WorkflowRunStore = ReturnType<typeof createPgWorkflowRunStore>;
/** A rejected wallet batch the server proved, from the chain, was never sent (`user-funded/decline-proof.ts`), for exactly one preparation. */
export type VerifiedDecline = { readonly requestId: string; readonly preparedAt: string; readonly ownerNonce: string; readonly fromBlock: string; readonly toBlock: string };

/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: migration 0032 (`single_step_runs`) widens `workflow_runs.step_count` from 2..8 to 1..8, so the
 * Editor can run ONE financial card through the user-funded execution groups (one atomic wallet batch). It is certified for the v28 build and
 * applied by an operator command, never by the deployment's own migration (docs/deploy/RELEASE-SINGLE-STEP-RUNS-0032.md). Until the database
 * holds exactly that migration — the certified (or, once shipped, the shipped) identity, version, name and SHA-256 — a single card keeps its
 * own flow: nothing offers a run the database would refuse. Any read failure answers false (fail closed to today's path).
 */
export const SINGLE_STEP_RUNS_VERSION = 32;
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion, owner requirement): single-card runs start only where an attempt the wallet
 * rejected can also be deleted — migration 0033 (`purge_unsubmitted_workflow_run`) must be active together with 0032.
 */
export const WORKFLOW_RUN_PURGE_VERSION = 33;
/** Whether the ledger holds exactly the certified identity (version, name and SHA-256) of migration `version`; false on any doubt or error. */
async function certifiedMigrationActive(db: Queryable, version: number, name: string): Promise<boolean> {
  const identity = SHIPPED_MIGRATIONS.find(m => m.version === version) ?? CERTIFIED_FORWARD_MIGRATIONS.flatMap(c => c.migrations).find(m => m.version === version);
  if (!identity || identity.name !== name) return false;
  try {
    const row = (await db.query('SELECT version, name, sha256 FROM schema_migrations WHERE version = $1', [version])).rows[0];
    return Boolean(row && Number(row.version) === identity.version && row.name === identity.name && row.sha256 === identity.sha256);
  } catch { return false; }
}
export async function singleStepRunsSupported(db: Queryable): Promise<boolean> {
  return await certifiedMigrationActive(db, SINGLE_STEP_RUNS_VERSION, 'single_step_runs') && await certifiedMigrationActive(db, WORKFLOW_RUN_PURGE_VERSION, 'workflow_run_purge');
}
/** What `WorkflowRunStore.atomically` hands its work: one run's reads and compare-and-sets, all inside one transaction under the run lock. */
export type RunScope = {
  readonly run: RunRecord;
  readonly appendEvent: (kind: string, code: string, detail: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly steps: (runId: string) => Promise<readonly RunStepRecord[]>;
  readonly groups: (runId: string) => Promise<readonly GroupRecord[]>;
  readonly stepTransition: (runId: string, stepIndex: number, from: readonly StepState[], to: StepState, patch: StepPatch, kind?: string) => Promise<RunStepRecord | null>;
  readonly groupTransition: (runId: string, groupIndex: number, from: readonly GroupState[], to: GroupState, patch: GroupPatch, kind?: string,
    expectVersion?: number | null) => Promise<GroupRecord | null>;
};
/** The sentinel that rolls an `atomically` transaction back (never escapes the store). */
const ROLLED_BACK = Symbol('ROLLED_BACK');
