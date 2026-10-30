// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: the sequential workflow runner. `advanceRun` moves one run as far as durable facts allow, and is safe to call any
 * number of times, concurrently, after any crash: it re-reads the run, and every move is a compare-and-set.
 *
 * CONFIRM_EACH_STEP (owner-signed steps)
 *   PENDING step      the previous step is RECONCILED (or this is the first step): re-compose the step alone with the current engine and
 *                     re-check its own deployment and policy gates and review blockers now → READY (resolved strategy, hash, flow) or
 *                     BLOCKED (nothing was submitted; the run HALTS after an earlier reconciled step, else FAILS)
 *   READY             waiting for the owner to load it in FloFi (`/approve`), which makes it AWAITING_OWNER; past the run window → BLOCKED
 *   AWAITING_OWNER    observe the step's own flow runs (`observe.ts`): RECONCILED → next step (or COMPLETED, written once); UNCERTAIN → the
 *                     run needs ATTENTION and keeps observing (no retry); FAILED (reconciled failure) → HALTED/FAILED; OPEN → keep waiting
 * DELEGATED (one passkey authorization, executed by the BUILD-AUTOMATION-002 executor)
 *   the run mirrors its ONE delegated execution: each executor step's reconciliation becomes the run step's public outcome; SETTLED →
 *   COMPLETED; BLOCKED → FAILED; HALTED → HALTED; UNCERTAIN → ATTENTION. The executor alone signs and submits.
 *
 * Nothing here signs, submits, retries a submission or chooses a wallet. Bound amounts are resolved only from reconciled facts.
 */
import type { NetworkId, StrategySpec } from '../engine/strategy-spec';
import { composeWorkflowBound, type WorkflowComposition } from '../engine/strategy-engine';
import { NETWORK_CHAINS } from '../engine/capability-catalog';
import { boundAmount, boundStrategy } from '../engine/workflow-bindings';
import { assetKey } from '../delegation/steps.ts';
import type { DelegationStore, ExecutionRecord, StepRecord as DelegatedStepRecord } from '../delegation/pg-store.ts';
import { evaluateGates, handoffFindings, type HandoffPolicy } from '../mcp/execution.ts';
import type { McpRuntime as EngineRuntime } from '../mcp/runtime.ts';
import { observeOwnerStep } from './observe.ts';
import type { BoundResolution, RunRecord, RunStepRecord, StepOutcome, WorkflowRunStore } from './pg-store.ts';
import { ADVANCE_RETRY_MS, TERMINAL_RUN, type RunState } from './state-machine.ts';

export type RunnerDeps = {
  readonly store: WorkflowRunStore; readonly runtime: EngineRuntime;
  /**
   * The requester kind's handoff policy, re-applied to every step before it becomes READY. Null where this process cannot know it (a worker):
   * the step then stays PENDING until its owner continues in FloFi, where the web tier resolves it with the surface's own policy.
   */
  readonly policyFor: (run: RunRecord) => HandoffPolicy | null;
  /** Delegated executions (null where delegation is not enabled; a DELEGATED run then waits and reports it). */
  readonly delegation: Pick<DelegationStore, 'executionForRun' | 'steps'> | null;
  readonly now: () => Date;
  readonly log: (event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void;
};
export type AdvanceOutcome = { readonly runId: string; readonly state: RunState | 'NOT_FOUND'; readonly code: string | null; readonly retryMs: number | null };
const MAX_PASSES = 16;
/** READY steps wait for the owner; they are re-checked slowly, only to apply the run window. */
const READY_RECHECK_MS = 5 * 60_000;
const OPEN_RECHECK_MS = 60_000;

const namespaceOf = (network: string): 'eip155' | 'solana' => network.startsWith('solana') ? 'solana' : 'eip155';
const networkOf = (s: StrategySpec): NetworkId => s.action === 'bridge' ? s.sourceNetwork : s.network;

/** Advances one run. Returns when nothing more can happen now; `retryMs` says when to look again (null: only an owner action can). */
export async function advanceRun(deps: RunnerDeps, runId: string): Promise<AdvanceOutcome> {
  let last: AdvanceOutcome = { runId, state: 'NOT_FOUND', code: null, retryMs: null };
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const run = await deps.store.byId(runId);
    if (!run) return last;
    const result = run.mode === 'DELEGATED' ? await delegatedPass(deps, run) : await confirmPass(deps, run);
    last = { runId, state: result.state, code: result.code, retryMs: result.retryMs };
    if (!result.progressed) return last;
  }
  return { ...last, retryMs: last.retryMs ?? ADVANCE_RETRY_MS };
}

type Pass = { readonly state: RunState; readonly code: string | null; readonly retryMs: number | null; readonly progressed: boolean };
const settled = (run: RunRecord, retryMs: number | null = null, progressed = false): Pass => ({ state: run.state, code: run.code, retryMs, progressed });

/** The run stops before step `k` (nothing of step k was submitted): HALTED after an earlier reconciled step, else FAILED. */
async function stopBefore(deps: RunnerDeps, run: RunRecord, steps: readonly RunStepRecord[], k: number, code: string): Promise<Pass> {
  const step = steps[k]!;
  if (step.state !== 'BLOCKED') await deps.store.stepTransition(run.runId, k, ['PENDING', 'READY'], 'BLOCKED', { code });
  const partial = steps.some(s => s.stepIndex < k && s.state === 'RECONCILED');
  const moved = await deps.store.transition(run.runId, { version: run.version, from: ['RUNNING', 'ATTENTION'] }, partial ? 'HALTED' : 'FAILED', { code });
  deps.log('workflow_run.stopped', { run: run.runId, step: k, code, partial });
  return moved ? settled(moved) : { ...settled(run), progressed: true };
}

async function confirmPass(deps: RunnerDeps, run: RunRecord): Promise<Pass> {
  if (TERMINAL_RUN.includes(run.state) || run.state === 'HALTED') return settled(run);
  const now = deps.now();
  if (run.state === 'PENDING') {
    if (run.expiresAt <= now) { const moved = await deps.store.transition(run.runId, { version: run.version, from: ['PENDING'] }, 'EXPIRED', { code: 'WORKFLOW_RUN_EXPIRED' });
      return moved ? settled(moved) : { ...settled(run), progressed: true }; }
    return settled(run);
  }
  const steps = await deps.store.steps(run.runId), k = run.currentStep, step = steps[k];
  if (!step) return settled(run);
  switch (step.state) {
    case 'PENDING': {
      // Only a step that has not started is re-composed: an in-flight step is always observed from its own stored facts.
      const composed = composeWorkflowBound(run.strategy, run.workflowHash);
      if (!composed.ok) return stopBefore(deps, run, steps, k, 'WORKFLOW_RUN_STALE');
      if (k > 0 && steps[k - 1]!.state !== 'RECONCILED') return stopBefore(deps, run, steps, k, 'WORKFLOW_RUN_ORDER_INVALID');
      if (run.expiresAt <= now) return stopBefore(deps, run, steps, k, 'WORKFLOW_RUN_EXPIRED');
      // BUILD-CROSSCHAIN-UNIVERSAL-001: confirm mode resolves bound amounts from the producer step's reconciled received facts
      // (the same min(cap, received) rule delegated runs already apply).
      const bindings = composed.bindings.filter(b => b.step === k);
      let strategy = composed.steps[k]!.strategy;
      let bound: BoundResolution | null = null;
      const resolutions: BoundResolution[] = [];
      for (const binding of bindings) {
        const producer = steps[binding.amountFrom]!;
        if (producer.state !== 'RECONCILED' || !producer.outcome) return stopBefore(deps, run, steps, k, 'WORKFLOW_BINDING_PRODUCER_NOT_RECONCILED');
        const key = assetKey({ chain: binding.asset.chainId, address: binding.asset.address });
        const received = producer.outcome.received.filter(r => r.asset === key).reduce((sum, r) => sum + BigInt(r.amount), 0n);
        // One reconciled delivery is a finite funding budget across all its consumers. Reserve an earlier consumer's approved maximum
        // unless its reconciled record proves it spent less; missing spend evidence must never unlock the owner's unrelated balance.
        const consumed = steps.filter(previous => previous.stepIndex < k && previous.bound).reduce((sum, previous) => {
          const prior = [previous.bound!, ...previous.bound!.additional ?? []].filter(resolution => resolution.amountFrom === binding.amountFrom &&
            assetKey({ chain: resolution.asset.chainId, address: resolution.asset.address }) === key);
          if (!prior.length) return sum;
          const reserved = prior.reduce((total, resolution) => total + BigInt(resolution.used), 0n);
          const facts = previous.outcome?.spent.filter(fact => fact.asset === key) ?? [];
          const spent = facts.reduce((total, fact) => total + BigInt(fact.amount), 0n);
          return sum + (facts.length && spent < reserved ? spent : reserved);
        }, 0n);
        const used = boundAmount(binding.cap, received > consumed ? received - consumed : 0n);
        if (used <= 0n) return stopBefore(deps, run, steps, k, 'WORKFLOW_BINDING_NOTHING_RECEIVED');
        strategy = boundStrategy(strategy, used, binding.asset.decimals, binding.inputAsset);
        resolutions.push({ amountFrom: binding.amountFrom, asset: binding.asset, cap: binding.cap, received: received.toString(), used: used.toString() });
      }
      if (resolutions[0]) bound = { ...resolutions[0], ...resolutions.length > 1 ? { additional: resolutions.slice(1) } : {} };
      const policy = deps.policyFor(run);
      if (!policy) return settled(run);
      // The step alone, re-composed now (with the resolved amount when bound), must pass its own gates and review today.
      const alone = composeWorkflowBound(strategy, undefined);
      if (!alone.ok || alone.steps.length !== 1) return stopBefore(deps, run, steps, k, 'WORKFLOW_STEP_STALE');
      const gates = await evaluateGates(alone.steps[0]!, deps.runtime, policy);
      if (!gates.handoff.allowed) return stopBefore(deps, run, steps, k, gates.handoff.reason ?? 'WORKFLOW_STEP_NOT_EXECUTABLE');
      if (handoffFindings(alone.steps[0]!).blockers.length) return stopBefore(deps, run, steps, k, 'REVIEW_BLOCKED');
      const namespace = namespaceOf(networkOf(strategy));
      if (!run.wallets[namespace]) return stopBefore(deps, run, steps, k, namespace === 'solana' ? 'SOLANA_WALLET_PROOF_REQUIRED' : 'EVM_WALLET_PROOF_REQUIRED');
      const ready = await deps.store.stepTransition(run.runId, k, ['PENDING'], 'READY', {
        flow: gates.plan.flow!, strategy, workflowHash: alone.workflowHash, ...(bound ? { bound } : {}) });
      deps.log('workflow_run.step_ready', { run: run.runId, step: k, ...(bound ? { boundUsed: bound.used } : {}) });
      return { ...settled(run), progressed: ready !== null };
    }
    case 'READY':
      if (run.expiresAt <= now) return stopBefore(deps, run, steps, k, 'WORKFLOW_RUN_EXPIRED');
      return settled(run, READY_RECHECK_MS);
    case 'AWAITING_OWNER': case 'UNCERTAIN': {
      const network = networkOf(step.strategy!), wallet = run.wallets[namespaceOf(network)];
      if (!wallet) return { ...settled(run, ADVANCE_RETRY_MS), code: 'WORKFLOW_RUN_WALLET_MISSING' };
      const verdict = await observeOwnerStep(deps.runtime, { flow: step.flow!, wallet, workflowHash: step.workflowHash!, claimedAt: step.claimedAt!,
        chain: NETWORK_CHAINS[network], now });
      if (verdict.verdict === 'UNAVAILABLE') return { ...settled(run, ADVANCE_RETRY_MS), code: verdict.code };
      // Nothing submitted yet: the owner may still be reviewing or signing; look again a little later.
      if (verdict.verdict === 'OPEN') return settled(run, OPEN_RECHECK_MS);
      if (verdict.verdict === 'UNCERTAIN') {
        if (step.state === 'AWAITING_OWNER') await deps.store.stepTransition(run.runId, k, ['AWAITING_OWNER'], 'UNCERTAIN', { code: verdict.code });
        if (run.state === 'RUNNING') await deps.store.transition(run.runId, { version: run.version, from: ['RUNNING'] }, 'ATTENTION', { code: verdict.code });
        return { state: 'ATTENTION', code: verdict.code, retryMs: ADVANCE_RETRY_MS, progressed: false };
      }
      if (verdict.verdict === 'FAILED') {
        await deps.store.stepTransition(run.runId, k, ['AWAITING_OWNER', 'UNCERTAIN'], 'FAILED', { outcome: verdict.outcome, code: verdict.code });
        const partial = steps.some(s => s.stepIndex < k && s.state === 'RECONCILED');
        const moved = await deps.store.transition(run.runId, { version: run.version, from: ['RUNNING', 'ATTENTION'] }, partial ? 'HALTED' : 'FAILED', { code: verdict.code });
        return moved ? settled(moved) : { ...settled(run), progressed: true };
      }
      const reconciled = await deps.store.stepTransition(run.runId, k, ['AWAITING_OWNER', 'UNCERTAIN'], 'RECONCILED', { outcome: verdict.outcome, code: null });
      if (verdict.duplicates.length) deps.log('workflow_run.duplicate_owner_run', { run: run.runId, step: k, duplicates: verdict.duplicates.length });
      return reconciled ? afterReconciled(deps, run, k) : { ...settled(run), progressed: true };
    }
    case 'RECONCILED': return afterReconciled(deps, run, k);
    default: return settled(run);
  }
}

/** Step `k` reconciled: the run moves to the next step, or completes (the completion fact is written once, with the transition). */
async function afterReconciled(deps: RunnerDeps, run: RunRecord, k: number): Promise<Pass> {
  const last = k + 1 >= run.stepCount;
  const moved = await deps.store.transition(run.runId, { version: run.version, from: ['RUNNING', 'ATTENTION'] }, last ? 'COMPLETED' : 'RUNNING',
    last ? { completedAt: deps.now(), code: null } : { currentStep: k + 1, code: null }, last ? 'RUN_COMPLETED' : 'RUN_STEP_ADVANCED');
  if (moved) deps.log(last ? 'workflow_run.completed' : 'workflow_run.advanced', { run: run.runId, step: k });
  return moved ? { ...settled(moved), progressed: !last } : { ...settled(run), progressed: true };
}

/** The public outcome of a delegated step (submissions, spent, received, provenance), and its resolved strategy. */
function delegatedOutcome(e: ExecutionRecord, s: DelegatedStepRecord, now: Date): StepOutcome {
  const amounts = (xs: unknown) => ((xs ?? []) as { asset: string; amount: string }[]).map(x => ({ asset: String(x.asset), amount: String(x.amount) }));
  const provenance = (s.reconciliation?.evidence as { provenance?: string } | undefined)?.provenance ?? null;
  return { kind: 'DELEGATED_STEP', executionId: e.executionId, flow: null, status: s.state,
    transactions: ((s.submission?.hashes ?? []) as unknown[]).filter((h): h is string => typeof h === 'string').map(hash => ({ chain: s.chain, hash })),
    evidence: provenance ? { environment: provenance === 'MOCKED' ? 'MOCKED' : 'PUBLIC_UNVERIFIED', outcome: s.state, bundleHash: null } : null,
    spent: amounts(s.reconciliation?.spent), received: amounts(s.reconciliation?.received), observedAt: now.toISOString() };
}
function resolvedStrategy(composed: WorkflowComposition, k: number, s: DelegatedStepRecord) {
  const base = composed.steps[k]!.strategy, binding = composed.bindings.find(b => b.step === k);
  if (!binding) return base;
  const spent = ((s.plan?.plan as { spend?: { amount: string }[] } | undefined)?.spend ?? [])[0]?.amount;
  return spent ? boundStrategy(base, BigInt(spent), binding.asset.decimals, binding.inputAsset) : base;
}

async function delegatedPass(deps: RunnerDeps, run: RunRecord): Promise<Pass> {
  if (TERMINAL_RUN.includes(run.state)) return settled(run);
  if (!deps.delegation) return { ...settled(run, ADVANCE_RETRY_MS), code: 'DELEGATION_NOT_ENABLED' };
  const e = await deps.delegation.executionForRun(run.runId);
  if (!e) return settled(run, ADVANCE_RETRY_MS);
  const composed = composeWorkflowBound(run.strategy, run.workflowHash);
  if (!composed.ok) return settled(run, ADVANCE_RETRY_MS);
  const now = deps.now(), mine = await deps.store.steps(run.runId);
  let progressed = false;
  for (const s of await deps.delegation.steps(e.executionId)) {
    const step = mine[s.stepIndex];
    if (!step) continue;
    const outcome = delegatedOutcome(e, s, now);
    if (s.state === 'RECONCILED' && step.state !== 'RECONCILED') {
      const strategy = resolvedStrategy(composed, s.stepIndex, s), alone = composeWorkflowBound(strategy, undefined);
      progressed = await deps.store.stepTransition(run.runId, s.stepIndex, ['DELEGATED', 'UNCERTAIN'], 'RECONCILED', { outcome, code: null,
        ...alone.ok ? { strategy, workflowHash: alone.workflowHash } : {} }) !== null || progressed;
    } else if (s.state === 'REVERTED' && step.state !== 'FAILED') {
      progressed = await deps.store.stepTransition(run.runId, s.stepIndex, ['DELEGATED', 'UNCERTAIN'], 'FAILED', { outcome, code: s.code ?? 'SUBMISSION_REVERTED' }) !== null || progressed;
    } else if (s.state === 'UNCERTAIN' && step.state === 'DELEGATED') {
      progressed = await deps.store.stepTransition(run.runId, s.stepIndex, ['DELEGATED'], 'UNCERTAIN', { code: s.code ?? 'SUBMISSION_UNCERTAIN' }) !== null || progressed;
    } else if (s.state === 'BLOCKED' && step.state === 'DELEGATED') {
      progressed = await deps.store.stepTransition(run.runId, s.stepIndex, ['DELEGATED'], 'BLOCKED', { code: s.code ?? 'DELEGATED_STEP_BLOCKED' }) !== null || progressed;
    }
  }
  const current = (await deps.store.byId(run.runId))!;
  const reconciledSteps = (await deps.store.steps(run.runId)).filter(s => s.state === 'RECONCILED').length;
  const at = Math.min(Math.max(e.currentStep, current.currentStep), current.stepCount - 1);
  const target: RunState | null = e.state === 'SETTLED' && reconciledSteps === current.stepCount ? 'COMPLETED' : e.state === 'BLOCKED' ? 'FAILED'
    : e.state === 'FAILED' ? reconciledSteps > 0 ? 'HALTED' : 'FAILED' : e.state === 'HALTED' ? 'HALTED' : e.state === 'UNCERTAIN' ? 'ATTENTION' : 'RUNNING';
  if (target === current.state && at === current.currentStep) return { ...settled(current, target === 'RUNNING' || target === 'ATTENTION' ? ADVANCE_RETRY_MS : null), progressed };
  // A run that failed for good never starts its remaining steps: they are SKIPPED (a HALTED run keeps them for its owner's decision).
  if (target === 'FAILED') for (const s of await deps.store.steps(run.runId)) if (s.state === 'DELEGATED' || s.state === 'PENDING')
    await deps.store.stepTransition(run.runId, s.stepIndex, ['DELEGATED', 'PENDING'], 'SKIPPED', { code: e.code ?? 'WORKFLOW_RUN_FAILED' });
  const moved = await deps.store.transition(run.runId, { version: current.version, from: [current.state] }, target,
    target === 'COMPLETED' ? { completedAt: now, code: null } : { currentStep: at, code: e.code }, target === 'COMPLETED' ? 'RUN_COMPLETED' : 'RUN_DELEGATED_STATE');
  if (moved?.state === 'COMPLETED') deps.log('workflow_run.completed', { run: run.runId, mode: 'DELEGATED' });
  return moved ? settled(moved, moved.state === 'RUNNING' || moved.state === 'ATTENTION' ? ADVANCE_RETRY_MS : null) : { ...settled(current), progressed: true };
}
