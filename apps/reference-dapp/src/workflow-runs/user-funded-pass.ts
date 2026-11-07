// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: how a USER_FUNDED run advances, one execution group at a time (`execution-groups.ts`). Safe to run any
 * number of times, concurrently, after any crash: every move is a compare-and-set on the run, the group or the step, and every submission
 * is the exact artifact the owner authorized (a resend is the same bytes / the same user operation, never a new one).
 *
 *   owner-step group      exactly the confirm-each-step rules for its step (its own flow, the owner's wallet confirms, observed and reconciled)
 *   PLANNED               waits for its owner (signed when due, or upfront at the start): nothing is ever prepared or signed by FloFi
 *   PREPARED              waits for the owner's wallet; past its validity it is EXPIRED and prepared again on request
 *   AUTHORIZED            wallet batch: the wallet already sent it; FloFi waits for the hashes the owner's browser reports.
 *                         user operation: due when the previous group reconciled; simulated by the bundler, then relayed (owner-paid).
 *                         Solana: every signature is recorded, then each transaction is sent after its predecessor confirmed.
 *   SUBMITTED/UNCERTAIN   reconciled from the chain only; per-step spent/received and the gas the owner paid become the steps' outcomes
 *
 * A group that cannot start (a refused simulation, a signer mismatch, a delivery below what was signed) is BLOCKED before anything is sent:
 * the run HALTS after earlier reconciled steps (funds rest in the owner's wallet), else FAILS. A reverted group FAILS its steps.
 */
import { composeWorkflowBound, type WorkflowComposition } from '../engine/strategy-engine';
import { boundStrategy } from '../engine/workflow-bindings';
import { advanceSolanaSubmission, reconcileEvmGroup, reconcileSolanaGroup, solanaSubmission, submitUserOperation, type Prepared, type Reconciled, type UserFundedDeps } from '../user-funded/groups.ts';
import type { EvmGroupCalls } from '../user-funded/evm-calls.ts';
import type { GroupRecord, RunRecord, RunStepRecord, StepOutcome, WorkflowRunStore } from './pg-store.ts';
import { ADVANCE_RETRY_MS, TERMINAL_RUN, type RunState } from './state-machine.ts';

export type Pass = { readonly state: RunState; readonly code: string | null; readonly retryMs: number | null; readonly progressed: boolean };
export type UserFundedPassDeps = {
  readonly store: WorkflowRunStore; readonly userFunded: UserFundedDeps | null; readonly now: () => Date;
  readonly log: (event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void;
  /** The confirm-each-step pass (owner-step groups run exactly as confirm mode). */
  readonly confirmPass: (run: RunRecord) => Promise<Pass>;
};
const OWNER_WAIT_MS = 5 * 60_000, SUBMIT_RETRY_MS = 15_000;
const TRANSIENT = new Set(['USER_FUNDED_RPC_UNAVAILABLE', 'USER_FUNDED_SOLANA_RPC_UNAVAILABLE', 'USER_OPERATION_BUNDLER_UNAVAILABLE', 'DELEGATION_RPC_UNAVAILABLE',
  'SOLANA_RPC_UNAVAILABLE', 'SOLANA_RPC_RATE_LIMITED']);
const settled = (run: RunRecord, retryMs: number | null = null, progressed = false, code: string | null = run.code): Pass => ({ state: run.state, code, retryMs, progressed });
const ownerStep = (g: GroupRecord) => g.strategy === 'EVM_OWNER_STEP' || g.strategy === 'SOLANA_OWNER_STEP';

/** The strategy a grouped step actually executed (its bound amount fixed to what it spent), for its RECONCILED record. */
function executedStrategy(composed: WorkflowComposition, index: number, spent: string | null) {
  const base = composed.steps[index]!.strategy, binding = composed.bindings.find(b => b.step === index);
  return binding && spent ? boundStrategy(base, BigInt(spent), binding.asset.decimals, binding.inputAsset) : base;
}

export async function userFundedPass(deps: UserFundedPassDeps, run: RunRecord): Promise<Pass> {
  if (TERMINAL_RUN.includes(run.state) || run.state === 'HALTED' || run.state === 'PENDING') return settled(run);
  const groups = await deps.store.groups(run.runId), steps = await deps.store.steps(run.runId);
  const k = run.currentStep, g = groups.find(x => x.stepFrom <= k && k <= x.stepTo);
  if (!g) return settled(run);
  if (ownerStep(g)) {
    // Bookkeeping only: an owner-step group is RECONCILED/FAILED with its step (whose own flow carries the evidence).
    const step = steps[g.stepFrom]!;
    if (g.state === 'PLANNED' && (step.state === 'RECONCILED' || step.state === 'FAILED') && step.outcome)
      await deps.store.groupTransition(run.runId, g.groupIndex, ['PLANNED'], step.state, { outcome: { status: step.state, transactions: step.outcome.transactions, steps: [k] } });
    return deps.confirmPass(run);
  }
  const now = deps.now();
  const block = async (code: string): Promise<Pass> => {
    await deps.store.groupTransition(run.runId, g.groupIndex, ['PLANNED', 'PREPARED', 'AUTHORIZED'], 'BLOCKED', { code });
    for (let i = g.stepFrom; i <= g.stepTo; i++) await deps.store.stepTransition(run.runId, i, ['DELEGATED'], 'BLOCKED', { code });
    const partial = steps.some(s => s.stepIndex < g.stepFrom && s.state === 'RECONCILED');
    const moved = await deps.store.transition(run.runId, { version: run.version, from: ['RUNNING', 'ATTENTION'] }, partial ? 'HALTED' : 'FAILED', { code });
    deps.log('workflow_run.group_blocked', { run: run.runId, group: g.groupIndex, code, partial });
    return moved ? settled(moved) : { ...settled(run), progressed: true };
  };
  if (['PLANNED', 'PREPARED', 'AUTHORIZED'].includes(g.state) && run.expiresAt <= now && g.state !== 'AUTHORIZED') return block('WORKFLOW_RUN_EXPIRED');
  switch (g.state) {
    case 'PLANNED': return settled(run, OWNER_WAIT_MS, false, 'OWNER_SIGNS_GROUP');
    case 'PREPARED':
      if (g.validUntil && g.validUntil <= now) {
        const expired = await deps.store.groupTransition(run.runId, g.groupIndex, ['PREPARED'], 'EXPIRED', { code: 'USER_FUNDED_PREPARED_EXPIRED' });
        if (expired) await deps.store.groupTransition(run.runId, g.groupIndex, ['EXPIRED'], 'PLANNED', { prepared: null, validUntil: null, code: null });
        return { ...settled(run, OWNER_WAIT_MS, false, 'OWNER_SIGNS_GROUP'), progressed: expired !== null };
      }
      return settled(run, OWNER_WAIT_MS, false, 'OWNER_SIGNS_GROUP');
    case 'AUTHORIZED': return authorizedGroup(deps, run, g, block);
    case 'SUBMITTED': case 'UNCERTAIN': return submittedGroup(deps, run, g, steps);
    case 'RECONCILED': return afterGroup(deps, run, g);
    case 'BLOCKED': case 'FAILED': case 'SKIPPED': case 'EXPIRED': return settled(run);
  }
}

async function authorizedGroup(deps: UserFundedPassDeps, run: RunRecord, g: GroupRecord, block: (code: string) => Promise<Pass>): Promise<Pass> {
  const prepared = g.prepared as Prepared, authorization = g.authorization!;
  if (g.strategy === 'EVM_WALLET_BATCH') return settled(run, SUBMIT_RETRY_MS, false, 'OWNER_REPORTS_BATCH');
  if (!deps.userFunded) return settled(run, ADVANCE_RETRY_MS, false, 'USER_FUNDED_NOT_ENABLED');
  if (g.strategy === 'SOLANA_SIGN_ALL') {
    const submitted = await deps.store.groupTransition(run.runId, g.groupIndex, ['AUTHORIZED'], 'SUBMITTED', { submission: solanaSubmission(authorization, deps.now()) });
    return { ...settled(run, 1_000), progressed: submitted !== null };
  }
  // EVM_USER_OPERATION, due now (its previous group reconciled, which for a delayed group means the delivery reconciled).
  const r = await submitUserOperation(deps.userFunded, prepared, authorization, g.feePayer);
  if (!r.ok) {
    if (TRANSIENT.has(r.code)) return settled(run, SUBMIT_RETRY_MS, false, r.code);
    return block(r.code);
  }
  const submitted = await deps.store.groupTransition(run.runId, g.groupIndex, ['AUTHORIZED'], 'SUBMITTED', { submission: r.value });
  deps.log('workflow_run.user_operation_relayed', { run: run.runId, group: g.groupIndex });
  return { ...settled(run, SUBMIT_RETRY_MS), progressed: submitted !== null };
}

async function submittedGroup(deps: UserFundedPassDeps, run: RunRecord, g: GroupRecord, steps: readonly RunStepRecord[]): Promise<Pass> {
  if (!deps.userFunded) return settled(run, ADVANCE_RETRY_MS, false, 'USER_FUNDED_NOT_ENABLED');
  const prepared = g.prepared as Prepared, submission = g.submission!;
  let r: Reconciled;
  try {
    if (g.strategy === 'SOLANA_SIGN_ALL') {
      const step = await advanceSolanaSubmission(deps.userFunded, prepared, g.authorization!, g.feePayer);
      if (step.state === 'SENT' || step.state === 'WAITING') return settled(run, 2_000, false, step.code);
      if (step.state === 'EXPIRED' || step.state === 'FAILED') r = await reconcileSolanaGroup(deps.userFunded, prepared, { ...submission, hashes: (submission.hashes as string[]).slice(0, step.index! + (step.state === 'FAILED' ? 1 : 0)) },
        g.chain, g.feePayer).then(x => x.status === 'RECONCILED' ? { status: 'FAILED' as const, code: step.code!, gasPaid: x.gasPaid, transactions: x.transactions, steps: x.steps } : x);
      else r = await reconcileSolanaGroup(deps.userFunded, prepared, submission, g.chain, g.feePayer);
    } else r = await reconcileEvmGroup(deps.userFunded, prepared, submission);
  } catch (cause) {
    const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'RECONCILIATION_FAILED';
    if (g.state === 'SUBMITTED') await deps.store.groupTransition(run.runId, g.groupIndex, ['SUBMITTED'], 'UNCERTAIN', { code });
    if (run.state === 'RUNNING') await deps.store.transition(run.runId, { version: run.version, from: ['RUNNING'] }, 'ATTENTION', { code });
    return { state: 'ATTENTION', code, retryMs: ADVANCE_RETRY_MS, progressed: false };
  }
  if (r.status === 'PENDING') return settled(run, SUBMIT_RETRY_MS);
  const composed = composeWorkflowBound(run.strategy, run.workflowHash);
  if (!composed.ok) return settled(run, ADVANCE_RETRY_MS, false, 'WORKFLOW_RUN_STALE');
  const observedAt = deps.now().toISOString(), chain = g.chain;
  const facts = r.status === 'RECONCILED' ? r.steps : r.steps ?? [];
  const evidence = { environment: 'PUBLIC_UNVERIFIED', outcome: r.status, bundleHash: null };
  const gasPaid = r.gasPaid ? { ...r.gasPaid, group: g.groupIndex } : undefined;
  const outcomeOf = (index: number, status: string): StepOutcome => {
    const f = facts.find(x => x.stepIndex === index);
    return { kind: 'USER_FUNDED_GROUP', executionId: `${run.runId}:g${g.groupIndex}`, flow: null, status, transactions: r.transactions.map(hash => ({ chain, hash })), evidence,
      spent: f?.spent ?? [], received: f?.received ?? [], observedAt, ...gasPaid ? { gasPaid } : {} };
  };
  const spentOf = (index: number) => {
    const group = (prepared as { group?: EvmGroupCalls }).group, stepCalls = group?.steps.find(s => s.stepIndex === index);
    if (stepCalls) return stepCalls.spend.amount;
    const sol = (prepared.transactions as readonly { stepIndex: number; spend: { amount: string } }[] | undefined)?.find(t => t.stepIndex === index);
    return sol?.spend.amount ?? null;
  };
  for (let i = g.stepFrom; i <= g.stepTo; i++) {
    const done = facts.some(f => f.stepIndex === i);
    const strategy = executedStrategy(composed, i, spentOf(i)), alone = composeWorkflowBound(strategy, undefined);
    const resolved = alone.ok ? { strategy, workflowHash: alone.workflowHash } : {};
    if (r.status === 'RECONCILED' || done)
      await deps.store.stepTransition(run.runId, i, ['DELEGATED', 'UNCERTAIN'], 'RECONCILED', { outcome: outcomeOf(i, 'RECONCILED'), code: null, ...resolved });
    else if (steps[i]!.state === 'DELEGATED' || steps[i]!.state === 'UNCERTAIN')
      await deps.store.stepTransition(run.runId, i, ['DELEGATED', 'UNCERTAIN'], 'FAILED', { outcome: outcomeOf(i, 'FAILED'), code: r.status === 'FAILED' ? r.code : null });
  }
  const groupOutcome = { status: r.status, transactions: r.transactions, gasPaid: r.gasPaid, steps: facts, observedAt };
  if (r.status === 'RECONCILED') {
    await deps.store.groupTransition(run.runId, g.groupIndex, ['SUBMITTED', 'UNCERTAIN'], 'RECONCILED', { outcome: groupOutcome, code: null });
    deps.log('workflow_run.group_reconciled', { run: run.runId, group: g.groupIndex, gasPaid: r.gasPaid.amount });
    return afterGroup(deps, (await deps.store.byId(run.runId))!, g);
  }
  await deps.store.groupTransition(run.runId, g.groupIndex, ['SUBMITTED', 'UNCERTAIN'], 'FAILED', { outcome: groupOutcome, code: r.code });
  const partial = facts.length > 0 || steps.some(s => s.stepIndex < g.stepFrom && s.state === 'RECONCILED');
  const fresh = (await deps.store.byId(run.runId))!;
  const moved = await deps.store.transition(run.runId, { version: fresh.version, from: ['RUNNING', 'ATTENTION'] }, partial ? 'HALTED' : 'FAILED', { code: r.code });
  deps.log('workflow_run.group_failed', { run: run.runId, group: g.groupIndex, code: r.code });
  return moved ? settled(moved) : { ...settled(fresh), progressed: true };
}

/** A reconciled group: the run moves past its last step, or completes (written once). */
async function afterGroup(deps: UserFundedPassDeps, run: RunRecord, g: GroupRecord): Promise<Pass> {
  if (run.currentStep > g.stepTo) return settled(run);
  const last = g.stepTo + 1 >= run.stepCount;
  const moved = await deps.store.transition(run.runId, { version: run.version, from: ['RUNNING', 'ATTENTION'] }, last ? 'COMPLETED' : 'RUNNING',
    last ? { completedAt: deps.now(), code: null } : { currentStep: g.stepTo + 1, code: null }, last ? 'RUN_COMPLETED' : 'RUN_STEP_ADVANCED');
  if (moved) deps.log(last ? 'workflow_run.completed' : 'workflow_run.advanced', { run: run.runId, step: g.stepTo, mode: 'USER_FUNDED' });
  return moved ? { ...settled(moved), progressed: !last } : { ...settled(run), progressed: true };
}
