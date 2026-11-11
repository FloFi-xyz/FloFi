// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: how a USER_FUNDED run advances, one execution group at a time (`execution-groups.ts`). Safe to run any
 * number of times, concurrently, after any crash: every move is a compare-and-set on the run, the group or the step, and every submission
 * is the exact artifact the owner authorized (a resend is the same bytes / the same user operation, never a new one).
 *
 *   owner-step group      exactly the confirm-each-step rules for its step (its own flow, the owner's wallet confirms, observed and reconciled)
 *   PLANNED               waits for its owner (signed when due, or upfront at the start): nothing is ever prepared or signed by FloFi
 *   PREPARED              waits for the owner's wallet; past its validity it is EXPIRED and prepared again on request — except a wallet batch,
 *                         which the wallet itself sends when the owner confirms: it is never dropped silently (a late answer is still taken)
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
import { assetKey } from '../delegation/steps.ts';
import { advanceSolanaSubmission, checkUserOperation, reconcileEvmGroup, reconcileSolanaGroup, relayUserOperation, solanaSubmission, type Prepared, type Reconciled,
  type UserFundedDeps } from '../user-funded/groups.ts';
import type { EvmGroupCalls } from '../user-funded/evm-calls.ts';
import type { BoundResolution, GroupRecord, RunRecord, RunStepRecord, StepOutcome, WorkflowRunStore } from './pg-store.ts';
import { ADVANCE_RETRY_MS, TERMINAL_RUN, type RunState } from './state-machine.ts';
import { executionRefusal } from '../server/execution-guard.ts';

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
/** A code stored on a group, its steps and its run: the runs/steps/events grammar (a detail after `:` is dropped, never the whole code). */
const stored = (code: string) => { const head = code.split(':')[0]!; return /^[A-Z][A-Z0-9_]{2,80}$/.test(head) ? head : 'USER_FUNDED_GROUP_REFUSED'; };
const ownerStep = (g: GroupRecord) => g.strategy === 'EVM_OWNER_STEP' || g.strategy === 'SOLANA_OWNER_STEP';

/** The strategy a grouped step actually executed (its bound amount fixed to what it spent), for its RECONCILED record. */
function executedStrategy(composed: WorkflowComposition, index: number, spent: string | null) {
  const base = composed.steps[index]!.strategy, binding = composed.bindings.find(b => b.step === index);
  return binding && spent ? boundStrategy(base, BigInt(spent), binding.asset.decimals, binding.inputAsset) : base;
}

export async function userFundedPass(deps: UserFundedPassDeps, run: RunRecord): Promise<Pass> {
  if (run.state === 'PENDING' || run.state === 'CANCELLED' || run.state === 'EXPIRED') return settled(run);
  await syncOwnerGroups(deps, run.runId);
  const groups = await deps.store.groups(run.runId), steps = await deps.store.steps(run.runId);
  if (TERMINAL_RUN.includes(run.state) || run.state === 'HALTED') return settled(run);
  const k = run.currentStep, g = groups.find(x => x.stepFrom <= k && k <= x.stepTo);
  if (!g) return settled(run);
  if (ownerStep(g)) { const pass = await deps.confirmPass(run); await syncOwnerGroups(deps, run.runId); return pass; }
  const now = deps.now();
  const block = async (refusal: string): Promise<Pass> => {
    const code = stored(refusal);
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
      // A wallet batch may already be on its way: the wallet sends it the moment the owner confirms, whenever that is. It stays PREPARED (its
      // late answer is accepted; a new preparation keeps the same EIP-5792 id) instead of being dropped and offered again as new.
      if (g.validUntil && g.validUntil <= now && g.strategy !== 'EVM_WALLET_BATCH') {
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
  // A pause holds an authorized group durably for an operator's resume; it never converts a pause into a permanent execution failure.
  const paused = executionRefusal() ?? await deps.userFunded?.submissionRefusal?.({
    namespace: g.chain.startsWith('solana:') ? 'solana' : 'eip155', address: g.feePayer }, run.owner);
  if (paused) return settled(run, SUBMIT_RETRY_MS, false, paused);
  if (!deps.userFunded) return settled(run, ADVANCE_RETRY_MS, false, 'USER_FUNDED_NOT_ENABLED');
  if (g.strategy === 'SOLANA_SIGN_ALL') {
    const submitted = await deps.store.groupTransition(run.runId, g.groupIndex, ['AUTHORIZED'], 'SUBMITTED', { submission: solanaSubmission(authorization, deps.now()) });
    return { ...settled(run, 1_000), progressed: submitted !== null };
  }
  // EVM_USER_OPERATION, due now (its previous group reconciled, which for a delayed group means the delivery reconciled). The due-time
  // simulation runs first (nothing is relayed if it refuses); then the submission is RECORDED, and only the one process whose write won
  // relays it — a status poll and the worker can never both send, and a lost relay is resent by reconciliation (same signed bytes).
  const r = await checkUserOperation(deps.userFunded, prepared, authorization, g.feePayer);
  if (!r.ok) {
    if (TRANSIENT.has(r.code)) return settled(run, SUBMIT_RETRY_MS, false, r.code);
    return block(r.code);
  }
  const submitted = await deps.store.groupTransition(run.runId, g.groupIndex, ['AUTHORIZED'], 'SUBMITTED', { submission: r.value });
  if (!submitted) return { ...settled(run, SUBMIT_RETRY_MS), progressed: true };
  const relayed = await relayUserOperation(deps.userFunded, prepared, authorization, run.owner);
  deps.log(relayed.ok ? 'workflow_run.user_operation_relayed' : 'workflow_run.user_operation_relay_retry', { run: run.runId, group: g.groupIndex, code: relayed.ok ? null : relayed.code });
  return { ...settled(run, SUBMIT_RETRY_MS), progressed: true };
}

async function submittedGroup(deps: UserFundedPassDeps, run: RunRecord, g: GroupRecord, steps: readonly RunStepRecord[]): Promise<Pass> {
  if (!deps.userFunded) return settled(run, ADVANCE_RETRY_MS, false, 'USER_FUNDED_NOT_ENABLED');
  const prepared = g.prepared as Prepared, submission = g.submission!;
  let r: Reconciled;
  try {
    if (g.strategy === 'SOLANA_SIGN_ALL') {
      const step = await advanceSolanaSubmission(deps.userFunded, prepared, g.authorization!, g.feePayer, run.owner);
      if (step.state === 'SENT' || step.state === 'WAITING') return settled(run, 2_000, false, step.code);
      if (step.state === 'EXPIRED' || step.state === 'FAILED') r = await reconcileSolanaGroup(deps.userFunded, prepared, { ...submission, hashes: (submission.hashes as string[]).slice(0, step.index! + (step.state === 'FAILED' ? 1 : 0)) },
        g.chain, g.feePayer).then(x => x.status === 'RECONCILED' ? { status: 'FAILED' as const, code: step.code!, gasPaid: x.gasPaid, transactions: x.transactions, steps: x.steps } : x);
      else r = await reconcileSolanaGroup(deps.userFunded, prepared, submission, g.chain, g.feePayer);
    } else r = await reconcileEvmGroup(deps.userFunded, prepared, submission, g.authorization, run.owner);
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
    // The artifact the batch was actually sent from (an earlier preparation, when it reconciled against one), else the group's own.
    const group = r.group ?? (prepared as { group?: EvmGroupCalls }).group, stepCalls = group?.steps.find(s => s.stepIndex === index);
    if (stepCalls) return stepCalls.spend.amount;
    const sol = (prepared.transactions as readonly { stepIndex: number; spend: { amount: string } }[] | undefined)?.find(t => t.stepIndex === index);
    return sol?.spend.amount ?? null;
  };
  // A grouped step bound to an earlier output records what it was signed to spend from it, exactly as a confirm-mode step does: a later
  // consumer of the same delivery (in a later group or confirmed step by step) is funded only by what is left of it.
  const receivedOf = (producer: number, asset: string) => [...steps[producer]?.outcome?.received ?? [], ...facts.find(f => f.stepIndex === producer)?.received ?? []]
    .filter(x => x.asset === asset).reduce((sum, x) => sum + BigInt(x.amount), 0n);
  const boundOf = (index: number): BoundResolution | null => {
    const spent = spentOf(index), all = composed.bindings.filter(b => b.step === index);
    if (!spent || !all.length) return null;
    const resolutions = all.map(b => ({ amountFrom: b.amountFrom, asset: b.asset, cap: b.cap,
      received: receivedOf(b.amountFrom, assetKey({ chain: b.asset.chainId, address: b.asset.address })).toString(), used: spent }));
    return { ...resolutions[0]!, ...resolutions.length > 1 ? { additional: resolutions.slice(1) } : {} };
  };
  for (let i = g.stepFrom; i <= g.stepTo; i++) {
    const done = facts.some(f => f.stepIndex === i);
    const strategy = executedStrategy(composed, i, spentOf(i)), alone = composeWorkflowBound(strategy, undefined);
    const bound = steps[i]!.bound ? null : boundOf(i);
    const resolved = { ...alone.ok ? { strategy, workflowHash: alone.workflowHash } : {}, ...bound ? { bound } : {} };
    if (r.status === 'RECONCILED' || done)
      await deps.store.stepTransition(run.runId, i, ['DELEGATED', 'UNCERTAIN'], 'RECONCILED', { outcome: outcomeOf(i, 'RECONCILED'), code: null, ...resolved });
    else if (steps[i]!.state === 'DELEGATED' || steps[i]!.state === 'UNCERTAIN')
      await deps.store.stepTransition(run.runId, i, ['DELEGATED', 'UNCERTAIN'], 'FAILED', { outcome: outcomeOf(i, 'FAILED'), code: r.status === 'FAILED' ? stored(r.code) : null });
  }
  // Reconciled against an earlier preparation (the one the wallet sent): what ITS steps were signed to spend and receive, for the owner's view.
  const preparedFrom = r.group ? { preparedFrom: { steps: r.group.steps, calls: r.group.calls.length,
    approvals: r.group.calls.filter(c => c.kind === 'ERC20_APPROVE').length } } : {};
  const groupOutcome = { status: r.status, transactions: r.transactions, gasPaid: r.gasPaid, steps: facts, observedAt, ...preparedFrom };
  if (r.status === 'RECONCILED') {
    await deps.store.groupTransition(run.runId, g.groupIndex, ['SUBMITTED', 'UNCERTAIN'], 'RECONCILED', { outcome: groupOutcome, code: null });
    deps.log('workflow_run.group_reconciled', { run: run.runId, group: g.groupIndex, gasPaid: r.gasPaid.amount });
    return afterGroup(deps, (await deps.store.byId(run.runId))!, g);
  }
  await deps.store.groupTransition(run.runId, g.groupIndex, ['SUBMITTED', 'UNCERTAIN'], 'FAILED', { outcome: groupOutcome, code: stored(r.code) });
  const partial = facts.length > 0 || steps.some(s => s.stepIndex < g.stepFrom && s.state === 'RECONCILED');
  const fresh = (await deps.store.byId(run.runId))!;
  const moved = await deps.store.transition(run.runId, { version: fresh.version, from: ['RUNNING', 'ATTENTION'] }, partial ? 'HALTED' : 'FAILED', { code: stored(r.code) });
  deps.log('workflow_run.group_failed', { run: run.runId, group: g.groupIndex, code: r.code });
  return moved ? settled(moved) : { ...settled(fresh), progressed: true };
}

/**
 * Bookkeeping only: an owner-step group (one or more steps, each through its own flow) becomes FAILED when one of its steps failed, and
 * RECONCILED only once EVERY step reconciled; its steps' own flows carry the evidence.
 */
async function syncOwnerGroups(deps: UserFundedPassDeps, runId: string): Promise<void> {
  const groups = await deps.store.groups(runId), steps = await deps.store.steps(runId);
  for (const og of groups.filter(x => ownerStep(x) && x.state === 'PLANNED')) {
    const mine = steps.filter(s => s.stepIndex >= og.stepFrom && s.stepIndex <= og.stepTo);
    const failed = mine.some(s => s.state === 'FAILED'), all = mine.length === og.stepTo - og.stepFrom + 1 && mine.every(s => s.state === 'RECONCILED' && s.outcome);
    if (!failed && !all) continue;
    const state = failed ? 'FAILED' : 'RECONCILED';
    await deps.store.groupTransition(runId, og.groupIndex, ['PLANNED'], state, { outcome: { status: state,
      transactions: mine.flatMap(s => s.outcome?.transactions ?? []), steps: mine.filter(s => s.outcome).map(s => s.stepIndex) } });
  }
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
