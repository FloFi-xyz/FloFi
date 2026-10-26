// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: the workflow run operations every surface shares — `/approve` (the owner, with proven wallets), MCP and channels (the
 * requester, with authority NONE). Nothing here signs, submits or holds a key.
 *
 *   ensureForClaim   at the claim of a SEQUENTIAL handoff: every wallet namespace the workflow needs must be proven in this browser; the run is
 *                    created once per handoff with those wallets bound (a repeated claim returns the same run, and only for the same wallets)
 *   startConfirm     the owner chose to confirm each step (or no other mode exists for them): the run starts and its first step is resolved
 *   currentStep      the step the owner signs now, as the ordinary single-step proposal FloFi's signing surface loads (re-composed now, to the
 *                    exact hash the run resolved); loading it marks it AWAITING_OWNER, so only runs of its flow created afterwards count
 *   view             the run's public status: steps, states, transaction hashes, explorer links, reconciled amounts, evidence and the
 *                    authorization plan. A requester sees step outcomes only when the owner shares status (the existing consent rule)
 */
import type { ApprovalRequesterKind, HandoffRecord, WalletRef } from '../platform/handoff-store.ts';
import { composeWorkflowBound, type WorkflowComposition } from '../engine/strategy-engine';
import type { StrategySpec } from '../engine/strategy-spec';
import { ENGINE_VERSION, evaluateWorkflowGates, type HandoffPolicy } from '../mcp/execution.ts';
import { executionExplorer } from '../domain/execution-lifecycle';
import { planNamespace, planNamespaces } from '../platform/approvals.ts';
import { strategyTestNetworks } from '../platform/strategy.ts';
import { TEST_NETWORK_NOT_AVAILABLE } from '../domain/network-scope';
import { networkScope } from '../server/network-scope.ts';
import type { GrantView } from '../delegation/authority.ts';
import { authorizationPlan, type AuthorizationPlan, type DelegationFacts } from './authorization-plan.ts';
import type { RunRecord, RunStepRecord, WorkflowRunStore } from './pg-store.ts';
import { advanceRun, type RunnerDeps } from './runner.ts';
import { CONFIRM_RUN_SECONDS } from './state-machine.ts';

type Env = Readonly<Record<string, string | undefined>>;
/** Workflow runs are opt-in per deployment (default off: a multi-step handoff is then refused with WORKFLOW_RUNS_NOT_ENABLED). */
export const workflowRunsEnabled = (env: Env): boolean => env.FLOFI_WORKFLOW_RUNS === 'enabled';

export type WorkflowRunDeps = Omit<RunnerDeps, 'policyFor'> & {
  readonly policyFor: (kind: ApprovalRequesterKind) => HandoffPolicy;
  readonly delegationFacts: DelegationFacts;
  /** The proven owner's delegated grants (for the owner's authorization plan), when delegation is enabled. */
  readonly grantsOf?: (owner: WalletRef) => Promise<readonly GrantView[]>;
  readonly newId: (prefix: 'wfr') => string;
};
const refuse = (code: string): never => { throw new Error(code); };
const runnerDeps = (deps: WorkflowRunDeps): RunnerDeps => ({ ...deps, policyFor: run => deps.policyFor(run.requester.kind) });
const proofCode = (namespace: WalletRef['namespace']) => namespace === 'solana' ? 'SOLANA_WALLET_PROOF_REQUIRED' : 'EVM_WALLET_PROOF_REQUIRED';
/** Every wallet a run bound must be proven by this request (the same wallets, never a substitute). */
export function assertRunWallets(run: RunRecord, wallets: readonly WalletRef[]): void {
  for (const [namespace, address] of Object.entries(run.wallets) as [WalletRef['namespace'], string][])
    if (!wallets.some(w => w.namespace === namespace && w.address === address)) refuse(wallets.some(w => w.namespace === namespace) ? 'WORKFLOW_RUN_OWNER_MISMATCH' : proofCode(namespace));
}

/** The run of a claimed SEQUENTIAL handoff (created once; only for the same proven wallets). */
export async function ensureForClaim(deps: WorkflowRunDeps, h: HandoffRecord, workflow: WorkflowComposition, wallets: readonly WalletRef[]): Promise<RunRecord> {
  if (h.plan.kind !== 'SEQUENTIAL' || workflow.steps.length < 2 || workflow.workflowHash !== h.workflowHash) refuse('WORKFLOW_RUN_NOT_SEQUENTIAL');
  const bound: Partial<Record<WalletRef['namespace'], string>> = {};
  for (const namespace of planNamespaces(h.plan)) bound[namespace] = (wallets.find(w => w.namespace === namespace) ?? refuse(proofCode(namespace))).address;
  const primary = planNamespace(h.plan), owner = { namespace: primary, address: bound[primary]! };
  if (h.claimed && (h.claimed.namespace !== owner.namespace || h.claimed.address !== owner.address)) refuse('WORKFLOW_RUN_OWNER_MISMATCH');
  const now = deps.now();
  const run = await deps.store.create({ runId: deps.newId('wfr'), handoffId: h.handoffId, requester: { kind: h.requesterKind, ref: h.requesterRef }, owner, wallets: bound,
    strategy: workflow.strategy, workflowHash: workflow.workflowHash, engineVersion: ENGINE_VERSION, stepCount: workflow.steps.length,
    expiresAt: new Date(now.getTime() + CONFIRM_RUN_SECONDS * 1000) }, now);
  assertRunWallets(run, wallets);
  return run;
}

/** The owner's authorization plan for this run (their own grants decide whether one passkey authorization can cover it). */
export async function ownerAuthorizationPlan(deps: WorkflowRunDeps, run: RunRecord): Promise<AuthorizationPlan> {
  const workflow = composeWorkflowBound(run.strategy, run.workflowHash);
  if (!workflow.ok) return refuse('WORKFLOW_RUN_STALE');
  const gates = await evaluateWorkflowGates(workflow, deps.runtime, deps.policyFor(run.requester.kind));
  const grants = deps.delegationFacts && deps.grantsOf ? await deps.grantsOf(run.owner) : null;
  return authorizationPlan(workflow, gates, deps.delegationFacts, grants ? { grants, now: deps.now().getTime() } : undefined);
}

/** Confirm each step: the run starts (any unsigned delegated authorization of it is revoked) and its first step is resolved. */
export async function startConfirm(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[]): Promise<RunRecord> {
  assertRunWallets(run, wallets);
  const plan = await ownerAuthorizationPlan(deps, run);
  if (!plan.confirmEachStep.available) refuse(plan.confirmEachStep.reason ?? 'WORKFLOW_RUN_CONFIRM_UNAVAILABLE');
  await deps.store.startConfirm(run.runId, deps.now());
  await advanceRun(runnerDeps(deps), run.runId);
  return (await deps.store.byId(run.runId))!;
}

export type StepProposal = { readonly stepIndex: number; readonly stepCount: number; readonly strategy: StrategySpec; readonly workflowHash: string;
  readonly composition: WorkflowComposition['steps'][number] };
/**
 * The step the owner signs now (confirm mode), as the ordinary single-step proposal; null when no step waits for the owner (the previous one
 * has not reconciled yet, or the run ended). Loading a READY step marks it AWAITING_OWNER (once; a reload returns the same step).
 */
export async function currentStep(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[]): Promise<StepProposal | null> {
  assertRunWallets(run, wallets);
  if (run.mode !== 'CONFIRM_EACH_STEP') return null;
  await advanceRun(runnerDeps(deps), run.runId);
  const fresh = (await deps.store.byId(run.runId))!;
  if (fresh.state !== 'RUNNING' && fresh.state !== 'ATTENTION') return null;
  let step = (await deps.store.steps(run.runId))[fresh.currentStep];
  if (!step || !step.strategy || !step.workflowHash || !['READY', 'AWAITING_OWNER'].includes(step.state)) return null;
  // The exact step the run resolved, re-composed now: a different hash is a stale step, never silently replaced.
  const composed = composeWorkflowBound(step.strategy, step.workflowHash);
  if (!composed.ok || composed.steps.length !== 1) return refuse('WORKFLOW_STEP_STALE');
  // BUILD-FLOFI-MAINNET-PRODUCT-001: a run started on a test network before FloFi became Mainnet-only signs no further step in the public product.
  if (networkScope() !== 'ENGINEERING' && strategyTestNetworks(composed).length) return refuse(TEST_NETWORK_NOT_AVAILABLE);
  if (step.state === 'READY') step = await deps.store.stepTransition(run.runId, step.stepIndex, ['READY'], 'AWAITING_OWNER', { claimedAt: deps.now() }, 'STEP_LOADED')
    ?? (await deps.store.steps(run.runId))[fresh.currentStep]!;
  if (step.state !== 'AWAITING_OWNER') return null;
  // The worker observes the step's own flow runs from now on (deduplicated: one open advance item per run).
  await deps.store.advanceLater(run.runId, 5_000);
  return { stepIndex: step.stepIndex, stepCount: fresh.stepCount, strategy: step.strategy!, workflowHash: step.workflowHash!, composition: composed.steps[0]! };
}

/**
 * The run as its owner's status poll sees it: observed exactly as the worker observes it (no policy, so a poll never makes a step READY and never
 * loads one; nothing is signed or submitted). A reconciled step therefore shows at once, and the owner never waits on the worker to continue.
 */
export async function observeRun(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[]): Promise<RunRecord> {
  assertRunWallets(run, wallets);
  await advanceRun({ ...deps, policyFor: () => null }, run.runId);
  return (await deps.store.byId(run.runId)) ?? run;
}

/** The owner ends a run that cannot continue (HALTED), or one that never submitted anything; remaining steps are SKIPPED. */
export async function cancelRun(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[], code = 'OWNER_CANCELLED'): Promise<RunRecord> {
  assertRunWallets(run, wallets);
  return deps.store.cancel(run.runId, run.version, code);
}

/** The owner resumes a HALTED run whose stopped step submitted nothing (e.g. a flow that was disabled is enabled again). */
export async function resumeRun(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[]): Promise<RunRecord> {
  assertRunWallets(run, wallets);
  if (run.state !== 'HALTED' || run.mode !== 'CONFIRM_EACH_STEP') refuse(`WORKFLOW_RUN_${run.state}`);
  if (run.expiresAt <= deps.now()) refuse('WORKFLOW_RUN_EXPIRED');
  const step = (await deps.store.steps(run.runId))[run.currentStep];
  if (!step || step.state !== 'BLOCKED') refuse('WORKFLOW_RUN_NOT_RESUMABLE');
  if (!await deps.store.transition(run.runId, { version: run.version, from: ['HALTED'] }, 'RUNNING', { code: null }, 'RUN_RESUMED')) refuse('WORKFLOW_RUN_CHANGED');
  // A step stopped before its resolution is re-gated from scratch; one stopped while READY keeps its resolved strategy and hash.
  await deps.store.stepTransition(run.runId, step!.stepIndex, ['BLOCKED'], step!.strategy ? 'READY' : 'PENDING', { code: null }, 'STEP_RESUMED');
  await advanceRun(runnerDeps(deps), run.runId);
  return (await deps.store.byId(run.runId))!;
}

export type RunStepView = { readonly index: number; readonly action: string; readonly state: string; readonly flow: string | null; readonly stepWorkflowHash: string | null;
  readonly code: string | null; readonly bound: RunStepRecord['bound'];
  readonly outcome: { readonly executionId: string; readonly kind: string; readonly status: string; readonly evidence: { readonly environment: string; readonly outcome: string;
      readonly bundleHash: string | null } | null;
    /** Transaction hashes / signatures the step submitted (public references only; never transaction bytes). */
    readonly submissions: readonly { readonly chain: string; readonly hash: string; readonly explorerUrl: string | null }[];
    readonly spent: readonly { readonly asset: string; readonly amount: string }[]; readonly received: readonly { readonly asset: string; readonly amount: string }[];
    readonly receiptUrl: string | null } | null };
export type RunView = { readonly workflowRunId: string; readonly approvalId: string; readonly state: string; readonly mode: string | null; readonly stepCount: number;
  readonly currentStep: number; readonly code: string | null; readonly workflowHash: string; readonly expiresAt: string; readonly completedAt: string | null;
  readonly createdAt: string; readonly updatedAt: string; readonly stepsVisible: boolean; readonly steps: readonly RunStepView[];
  readonly nextAction: 'OWNER_CHOOSES_MODE' | 'OWNER_SIGNS_STEP' | 'WAITING_FOR_RECONCILIATION' | 'OWNER_DECIDES' | 'NONE';
  readonly authority: 'NONE'; readonly note: string | null };

/**
 * The public status of a run. `outcomes` false (a requester the owner did not share status with) keeps every step's state but withholds its
 * transactions, amounts and evidence. Nothing returned is a key, calldata or a signature, and nothing here authorizes anything.
 */
export async function runView(deps: { readonly store: Pick<WorkflowRunStore, 'steps'> }, run: RunRecord, options: { readonly outcomes: boolean; readonly origin?: string | null }): Promise<RunView> {
  const steps = await deps.store.steps(run.runId);
  const composed = composeWorkflowBound(run.strategy, run.workflowHash);
  const views: RunStepView[] = steps.map(s => {
    const local = s.outcome?.evidence?.environment === 'MOCKED';
    const outcome = options.outcomes && s.outcome ? { executionId: s.outcome.executionId, kind: s.outcome.kind, status: s.outcome.status, evidence: s.outcome.evidence,
      submissions: s.outcome.transactions.map(t => ({ chain: t.chain, hash: t.hash, explorerUrl: executionExplorer(t.chain, t.hash, local) })),
      spent: s.outcome.spent, received: s.outcome.received,
      receiptUrl: options.origin && s.outcome.kind === 'OWNER_RUN' && s.state === 'RECONCILED' ? `${options.origin}/app/dashboard/runs/${encodeURIComponent(s.outcome.executionId)}` : null } : null;
    return { index: s.stepIndex, action: composed.ok ? composed.steps[s.stepIndex]?.strategy.action ?? 'unknown' : 'unknown', state: s.state, flow: s.flow,
      stepWorkflowHash: s.workflowHash, code: s.code, bound: options.outcomes ? s.bound : null, outcome };
  });
  const current = steps[run.currentStep];
  // A confirm-mode step whose predecessor reconciled is the owner's to sign (it is resolved when they open it); one in flight waits for its chain.
  const nextAction = run.state === 'PENDING' ? 'OWNER_CHOOSES_MODE' : run.state === 'HALTED' ? 'OWNER_DECIDES'
    : ['RUNNING', 'ATTENTION'].includes(run.state) ? run.mode === 'CONFIRM_EACH_STEP' && (current?.state === 'READY' || current?.state === 'PENDING') ? 'OWNER_SIGNS_STEP'
      : 'WAITING_FOR_RECONCILIATION' : 'NONE';
  const note = !options.outcomes ? 'The owner has not shared the transactions and evidence of this workflow with this conversation.'
    : run.state === 'HALTED' ? 'Partially completed: the reconciled steps stay done and their funds rest in the owner\'s wallet. Nothing later was submitted.'
      : run.state === 'ATTENTION' ? 'A submitted step has no final outcome yet. FloFi keeps observing it and never resubmits it.' : null;
  return { workflowRunId: run.runId, approvalId: run.handoffId, state: run.state, mode: run.mode, stepCount: run.stepCount, currentStep: run.currentStep, code: run.code,
    workflowHash: run.workflowHash, expiresAt: run.expiresAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null, createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(), stepsVisible: options.outcomes, steps: views, nextAction, authority: 'NONE', note };
}
