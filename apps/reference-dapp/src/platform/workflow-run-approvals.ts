// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: `/approve` for a multi-step workflow (an approval handoff whose plan is SEQUENTIAL). The handoff is the workflow's one
 * approval; its durable workflow run (`src/workflow-runs`) sequences the steps. Every operation here acts for the run's owner wallets only
 * (proven by this request's HttpOnly sign-in cookies, never a client-supplied address) and grants no transaction authority:
 *
 *   claim        the claimed handoff's run is created (or found) for the proven wallets; when the owner has no choice to make (confirm each
 *                step is the only available mode) it starts at once; the step to sign now is returned as the ordinary single-step proposal
 *                the signing surface loads — its own fresh simulation, Review and wallet signature follow, unchanged
 *   continue     the next step, once the previous one reconciled (also after a reload or in another browser, by approval id + wallet proof)
 *   start        the owner chose to confirm each step
 *   authorize    the owner chose ONE passkey authorization for the whole workflow (BUILD-AUTOMATION-002's Universal Workflow Authorization)
 *   cancel / resume   end a run that never submitted anything (or that halted), or resume a halted step that submitted nothing
 */
import type { Command } from '../domain/commands';
import type { Workflow } from '../domain/initial-workflow';
import type { WorkflowComposition } from '../engine/strategy-engine';
import type { ReviewView } from '../delegation/views.ts';
import type { AuthorizationPlan } from '../workflow-runs/authorization-plan.ts';
import type { RunRecord } from '../workflow-runs/pg-store.ts';
import { assertRunWallets, cancelRun, currentStep, ensureForClaim, ownerAuthorizationPlan, resumeRun, runView, startConfirm, type RunView, type StepProposal,
  type WorkflowRunDeps } from '../workflow-runs/service.ts';
import { DELEGATED_AUTHORIZATION_SECONDS } from '../workflow-runs/state-machine.ts';
import type { ApprovalView } from './approvals.ts';
import type { HandoffRecord, WalletRef } from './handoff-store.ts';
import { refuse } from './refusal.ts';

/** The delegated half of a run's authorization (the delegation service's run operations), where delegation is enabled. */
export type RunDelegationOps = {
  readonly review: (owner: WalletRef, run: { readonly runId: string; readonly strategy: unknown; readonly workflowHash: string; readonly validitySeconds: number }) => Promise<ReviewView>;
  readonly sign: (owner: WalletRef, runId: string, revision: number, assertion: unknown) => Promise<{ readonly authorizationId: string }>;
  readonly revoke: (owner: WalletRef, runId: string) => Promise<void>;
};
export type WorkflowRunSurface = WorkflowRunDeps & { readonly delegationOps?: RunDelegationOps | null };
export type WorkflowRunClaim = { readonly run: RunView; readonly plan: AuthorizationPlan; readonly step: { readonly index: number; readonly count: number } | null };
/** What the signing surface loads for a sequence: the current step's proposal (null when no step waits for the owner) and the run. */
export type SequentialProposal = { readonly view: ApprovalView & { readonly workflowRun: WorkflowRunClaim }; readonly command: Command | null;
  readonly workflow: Workflow | null; readonly workflowHash: string; readonly workflowId: string | null };

async function proposalOf(deps: WorkflowRunSurface, run: RunRecord, step: StepProposal | null, base: ApprovalView): Promise<SequentialProposal> {
  const fresh = await deps.store.byId(run.runId) ?? run;
  const workflowRun: WorkflowRunClaim = { run: await runView(deps, fresh, { outcomes: true }), plan: await ownerAuthorizationPlan(deps, fresh),
    step: step ? { index: step.stepIndex, count: step.stepCount } : null };
  return { view: { ...base, workflowRun }, command: step?.composition.command ?? null, workflow: step?.composition.workflow ?? null,
    workflowHash: step?.workflowHash ?? fresh.workflowHash, workflowId: step?.composition.workflow.workflowId ?? null };
}

/** After the handoff claim of a SEQUENTIAL proposal: its run, started at once when confirm-each-step is the owner's only mode. */
export async function claimSequential(deps: WorkflowRunSurface, h: HandoffRecord, workflow: WorkflowComposition, wallets: readonly WalletRef[], base: ApprovalView) {
  let run = await ensureForClaim(deps, h, workflow, wallets);
  if (run.state === 'PENDING' && run.mode === null) {
    const plan = await ownerAuthorizationPlan(deps, run);
    if (!plan.delegatedSingleAuthorization.available && plan.confirmEachStep.available) run = await startConfirm(deps, run, wallets);
  }
  return proposalOf(deps, run, await currentStep(deps, run, wallets), base);
}
/** The run of an approval, for its owner wallets only. */
export async function ownedRun(deps: WorkflowRunSurface, approvalId: string, wallets: readonly WalletRef[]): Promise<RunRecord> {
  if (!/^apr_[a-z2-7]{26}$/.test(approvalId)) return refuse('WORKFLOW_RUN_NOT_FOUND');
  const run = await deps.store.byHandoff(approvalId) ?? refuse('WORKFLOW_RUN_NOT_FOUND');
  try { assertRunWallets(run, wallets); } catch (cause) { return refuse(cause instanceof Error && /_PROOF_REQUIRED$/.test(cause.message) ? cause.message : 'WORKFLOW_RUN_NOT_FOUND'); }
  return run;
}
/** The step the owner signs now (after the previous one reconciled), or the run's status when none waits. */
export async function continueSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], base: ApprovalView) {
  return proposalOf(deps, run, await currentStep(deps, run, wallets), base);
}
export async function startSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], base: ApprovalView) {
  const started = await startConfirm(deps, run, wallets);
  return proposalOf(deps, started, await currentStep(deps, started, wallets), base);
}
export async function cancelSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], base: ApprovalView) {
  // A delegated run is stopped by revoking its authorization; the executor then blocks before anything new is submitted.
  if (run.mode === 'DELEGATED') { assertRunWallets(run, wallets); await (deps.delegationOps ?? refuse('DELEGATION_NOT_ENABLED')).revoke(run.owner, run.runId); return proposalOf(deps, run, null, base); }
  return proposalOf(deps, await cancelRun(deps, run, wallets), null, base);
}
export async function resumeSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], base: ApprovalView) {
  const resumed = await resumeRun(deps, run, wallets);
  return proposalOf(deps, resumed, await currentStep(deps, resumed, wallets), base);
}
/** The Universal Workflow Authorization Review of this run (delegated mode): the envelope the owner's passkey signs ONCE. */
export async function authorizationReviewSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[]): Promise<ReviewView> {
  assertRunWallets(run, wallets);
  if (run.state !== 'PENDING' || run.mode !== null) refuse(run.mode === 'CONFIRM_EACH_STEP' ? 'WORKFLOW_RUN_CONFIRM_MODE_CHOSEN' : `WORKFLOW_RUN_${run.state}`);
  const plan = await ownerAuthorizationPlan(deps, run);
  if (!plan.delegatedSingleAuthorization.available) refuse(plan.delegatedSingleAuthorization.reason ?? 'DELEGATED_AUTHORITY_UNAVAILABLE');
  const ops = deps.delegationOps ?? refuse('DELEGATION_NOT_ENABLED');
  return ops.review(run.owner, { runId: run.runId, strategy: run.strategy, workflowHash: run.workflowHash, validitySeconds: DELEGATED_AUTHORIZATION_SECONDS });
}
/** The owner's ONE passkey signature: the run becomes DELEGATED and its execution starts, with no further signature of any kind. */
export async function authorizeSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], revision: number, assertion: unknown, base: ApprovalView) {
  assertRunWallets(run, wallets);
  const ops = deps.delegationOps ?? refuse('DELEGATION_NOT_ENABLED');
  await ops.sign(run.owner, run.runId, revision, assertion);
  return proposalOf(deps, run, null, base);
}
