// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001 migration 0015 on PostgreSQL: the database refuses exactly what the TypeScript state machines refuse (every from/to pair
 * of runs and steps), never lets a bound fact change, never deletes run history, and a delegated authorization or execution has exactly one
 * source (an automation rule/occurrence or a workflow run) that never changes.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { typedId } from '../platform/ids.ts';
import { canMoveRun, canMoveStep, RUN_STATES, STEP_STATES, TERMINAL_RUN, TERMINAL_STEP, type RunState, type StepState } from './state-machine.ts';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
const OWNER = '0x' + 'ab'.repeat(20), HASH = '0x' + '1'.repeat(64);
const id = (prefix: string) => typedId(prefix);
const ok = (work: Promise<unknown>) => work.then(() => true, () => false);

/** A handoff and a run in `state` (mode/completion fields consistent with it), with one step in `stepState`. */
async function runIn(state: RunState, stepState: StepState = 'PENDING') {
  const handoffId = id('apr'), runId = id('wfr');
  await t.db.query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind, requester_id, client_id, client_name, secret_digest, strategy, workflow_hash,
      engine_version, network_environment, funds_class, plan, status, expires_at)
    VALUES ('default', $1, 'CHANNEL_CONVERSATION', 'cnv_migrationtest', 'telegram-test', 'Telegram', $2, '{}', $3, 'flofi-engine-2', 'PUBLIC_TESTNET', 'TEST_FUNDS',
      '{"kind":"SEQUENTIAL"}', 'PENDING', now() + interval '1 hour')`, [handoffId, randomBytes(32), HASH]);
  const mode = ['PENDING', 'CANCELLED', 'EXPIRED'].includes(state) ? null : 'CONFIRM_EACH_STEP';
  await t.db.query(`INSERT INTO workflow_runs (tenant_id, run_id, handoff_id, requester_kind, requester_ref, owner_namespace, owner_account, wallets, strategy, workflow_hash,
      engine_version, step_count, mode, state, completed_at, expires_at) VALUES ('default', $1, $2, 'CHANNEL_CONVERSATION', 'cnv_migrationtest', 'eip155', $3, '{}', '{}',
      $4, 'flofi-engine-2', 2, $5, $6, $7, now() + interval '1 day')`, [runId, handoffId, OWNER, HASH, mode, state, state === 'COMPLETED' ? new Date() : null]);
  const strategy = ['READY', 'AWAITING_OWNER', 'RECONCILED', 'FAILED', 'UNCERTAIN'].includes(stepState);
  await t.db.query(`INSERT INTO workflow_run_steps (tenant_id, run_id, step_index, state, flow, strategy, workflow_hash, claimed_at, outcome)
    VALUES ('default', $1, 0, $2, $3, $4, $5, $6, $7)`, [runId, stepState, strategy ? 'base-sepolia-swap' : null, strategy ? '{}' : null, strategy ? HASH : null,
    ['AWAITING_OWNER', 'UNCERTAIN', 'RECONCILED', 'FAILED'].includes(stepState) ? new Date() : null, stepState === 'RECONCILED' ? '{}' : null]);
  await t.db.query(`INSERT INTO workflow_run_steps (tenant_id, run_id, step_index, state) VALUES ('default', $1, 1, 'PENDING')`, [runId]);
  return runId;
}

describe('BUILD-CHAT-E2E-001 migration 0015 (PostgreSQL)', () => {
  it('a run moves exactly as `canMoveRun` allows; terminal runs never change', async () => {
    for (const from of RUN_STATES) for (const to of RUN_STATES) {
      if (from === to) continue;
      const runId = await runIn(from);
      const accepted = await ok(t.db.query(`UPDATE workflow_runs SET state = $2, version = version + 1, mode = COALESCE(mode, 'CONFIRM_EACH_STEP'),
          completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE completed_at END WHERE run_id = $1`, [runId, to]));
      expect([from, to, accepted]).toEqual([from, to, !TERMINAL_RUN.includes(from) && canMoveRun(from, to)]);
    }
  });

  it('a step moves exactly as `canMoveStep` allows; terminal steps never change', async () => {
    for (const from of STEP_STATES) for (const to of STEP_STATES) {
      if (from === to) continue;
      const runId = await runIn('RUNNING', from);
      const accepted = await ok(t.db.query(`UPDATE workflow_run_steps SET state = $2, version = version + 1,
          flow = COALESCE(flow, 'base-sepolia-swap'), strategy = COALESCE(strategy, '{}'), workflow_hash = COALESCE(workflow_hash, $3),
          claimed_at = COALESCE(claimed_at, now()), outcome = CASE WHEN $2 = 'RECONCILED' THEN COALESCE(outcome, '{}') ELSE outcome END
        WHERE run_id = $1 AND step_index = 0`, [runId, to, HASH]));
      expect([from, to, accepted]).toEqual([from, to, !TERMINAL_STEP.includes(from) && canMoveStep(from, to)]);
    }
  });

  it('bound facts never change: owner, wallets, workflow, the chosen mode, the completion fact, a resolved step and its claim; nothing is deleted', async () => {
    const runId = await runIn('RUNNING', 'AWAITING_OWNER');
    for (const change of [`owner_account = '0x${'cd'.repeat(20)}'`, `wallets = '{"solana":"x"}'`, `workflow_hash = '0x${'2'.repeat(64)}'`, `strategy = '{"x":1}'`,
      `mode = 'DELEGATED', authorization_id = 'dau_${'a'.repeat(26)}'`, 'current_step = 2', `expires_at = now() + interval '30 days'`, 'version = version'])
      expect(await ok(t.db.query(`UPDATE workflow_runs SET ${change}, version = version + 1 WHERE run_id = $1`, [runId])), change).toBe(false);
    for (const change of [`strategy = '{"y":2}'`, `workflow_hash = '0x${'3'.repeat(64)}'`, `flow = 'jupiter-swap'`, 'claimed_at = now() + interval \'1 minute\''])
      expect(await ok(t.db.query(`UPDATE workflow_run_steps SET ${change}, version = version + 1 WHERE run_id = $1 AND step_index = 0`, [runId])), change).toBe(false);
    // Advancing the current step forward is allowed; going back is not.
    expect(await ok(t.db.query(`UPDATE workflow_runs SET current_step = 1, version = version + 1 WHERE run_id = $1`, [runId]))).toBe(true);
    expect(await ok(t.db.query(`UPDATE workflow_runs SET current_step = 0, version = version + 1 WHERE run_id = $1`, [runId]))).toBe(false);
    const completed = await runIn('RUNNING');
    await t.db.query(`UPDATE workflow_runs SET state = 'COMPLETED', completed_at = now(), version = version + 1 WHERE run_id = $1`, [completed]);
    expect(await ok(t.db.query(`UPDATE workflow_runs SET completed_at = now() + interval '1 hour', version = version + 1 WHERE run_id = $1`, [completed]))).toBe(false);
    await t.db.query(`INSERT INTO workflow_run_events (tenant_id, run_id, kind) VALUES ('default', $1, 'RUN_CREATED')`, [runId]);
    for (const sql of ['DELETE FROM workflow_run_events WHERE run_id = $1', `UPDATE workflow_run_events SET kind = 'X_Y_Z' WHERE run_id = $1`,
      'DELETE FROM workflow_run_steps WHERE run_id = $1', 'DELETE FROM workflow_runs WHERE run_id = $1'])
      expect(await ok(t.db.query(sql, [runId])), sql).toBe(false);
    // A completion fact requires the COMPLETED state and vice versa; a mode is required once running; DELEGATED requires its authorization.
    for (const sql of [`UPDATE workflow_runs SET completed_at = now(), version = version + 1 WHERE run_id = $1`,
      `UPDATE workflow_runs SET state = 'COMPLETED', version = version + 1 WHERE run_id = $1`])
      expect(await ok(t.db.query(sql, [await runIn('RUNNING')])), sql).toBe(false);
  });

  it('a delegated authorization and execution have exactly one source, which never changes', async () => {
    const runId = await runIn('PENDING');
    // Neither source, or both, is refused (the exclusive-source check); a workflow run with its own owner is accepted.
    for (const [rule, run] of [[null, null], ['aut_' + 'a'.repeat(26), runId]] as const)
      expect(await ok(t.db.query(`INSERT INTO delegated_authorizations (tenant_id, authorization_id, owner_namespace, owner_account, rule_id, workflow_run_id, state)
        VALUES ('default', $1, 'eip155', $2, $3, $4, 'PENDING_SIGNATURE')`, [id('dau'), OWNER, rule, run]))).toBe(false);
    const authorizationId = id('dau');
    await t.db.query(`INSERT INTO delegated_authorizations (tenant_id, authorization_id, owner_namespace, owner_account, workflow_run_id, state)
      VALUES ('default', $1, 'eip155', $2, $3, 'PENDING_SIGNATURE')`, [authorizationId, OWNER, runId]);
    // One lineage per run; another owner cannot name the run.
    expect(await ok(t.db.query(`INSERT INTO delegated_authorizations (tenant_id, authorization_id, owner_namespace, owner_account, workflow_run_id, state)
      VALUES ('default', $1, 'eip155', $2, $3, 'PENDING_SIGNATURE')`, [id('dau'), OWNER, runId]))).toBe(false);
    expect(await ok(t.db.query(`INSERT INTO delegated_authorizations (tenant_id, authorization_id, owner_namespace, owner_account, workflow_run_id, state)
      VALUES ('default', $1, 'eip155', $2, $3, 'PENDING_SIGNATURE')`, [id('dau'), '0x' + 'cd'.repeat(20), await runIn('PENDING')]))).toBe(false);
    // The source is immutable (the column-scoped trigger); the existing transition rules still apply to everything else.
    expect(await ok(t.db.query(`UPDATE delegated_authorizations SET workflow_run_id = $2, version = version + 1 WHERE authorization_id = $1`,
      [authorizationId, await runIn('PENDING')]))).toBe(false);
    expect(await ok(t.db.query(`UPDATE delegated_authorizations SET state = 'REVOKED', revoked_at = now(), version = version + 1 WHERE authorization_id = $1`,
      [authorizationId]))).toBe(true);
  });
});
