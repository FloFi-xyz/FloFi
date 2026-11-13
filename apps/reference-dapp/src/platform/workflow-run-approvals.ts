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
 *   authorize    the owner chose ONE wallet authorization for the whole workflow: one exact workflow grant per EVM network, signed by the run's
 *                wallet (BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001)
 *   cancel / resume   end a run that never submitted anything (or that halted), or resume a halted step that submitted nothing
 */
import type { Command } from '../domain/commands';
import type { Workflow } from '../domain/initial-workflow';
import type { WorkflowComposition } from '../engine/strategy-engine';
import type { WalletWorkflowReviewView } from '../delegation/views.ts';
import type { AuthorizationPlan } from '../workflow-runs/authorization-plan.ts';
import type { RunRecord } from '../workflow-runs/pg-store.ts';
import { assertRunWallets, authorizeUserFundedGroup, authorizeUserFundedGroupUpgrade, consentUserFundedGroupUpgrade, cancelRun, currentStep, ensureForClaim, observeRun, ownerAuthorizationPlan, permitUserFundedGroup, prepareUserFundedGroup,
  reportUserFundedBatch, resumeRun, runView, startConfirm, startUserFunded, type PreparedGroupView, type RunView, type StepProposal, type WorkflowRunDeps } from '../workflow-runs/service.ts';
import type { OwnerAnswer, WalletProfile } from '../workflow-runs/execution-groups.ts';
import { DELEGATED_AUTHORIZATION_SECONDS } from '../workflow-runs/state-machine.ts';
import type { ApprovalView } from './approvals.ts';
import type { HandoffRecord, WalletRef } from './handoff-store.ts';
import { refuse } from './refusal.ts';

/** The delegated half of a run's authorization (the delegation service's run operations), where delegation is enabled. */
export type RunDelegationOps = {
  /** BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the run's exact workflow grants (one per EVM chain) for the run's own EVM wallet. */
  readonly review: (owner: WalletRef, run: { readonly runId: string; readonly strategy: unknown; readonly workflowHash: string; readonly validitySeconds: number;
    readonly wallet: string }) => Promise<WalletWorkflowReviewView>;
  /** The wallet signatures of those grants (`[{ grantId, signature }]`): verified, then the run starts. */
  /** `retryOnly`: the run already left PENDING (a retry after a lost answer) — answered without verifying or storing anything. */
  readonly sign: (owner: WalletRef, runId: string, revision: number, signatures: unknown, retryOnly?: boolean) => Promise<{ readonly authorizationId: string }>;
  readonly revoke: (owner: WalletRef, runId: string) => Promise<void>;
};
export type WorkflowRunSurface = WorkflowRunDeps & { readonly delegationOps?: RunDelegationOps | null };
/**
 * The owner's view of their run on `/approve`: the run, the authorization plan for their own grants, the step loaded now (if any) and the wallet
 * that must sign it (a sequence may span EVM and Solana: each step is signed by the run's wallet of its own namespace).
 */
export type WorkflowRunClaim = { readonly run: RunView; readonly plan: AuthorizationPlan; readonly step: { readonly index: number; readonly count: number } | null;
  readonly stepWallet: string | null };
/** What the signing surface loads for a sequence: the current step's proposal (null when no step waits for the owner) and the run. */
export type SequentialProposal = { readonly view: ApprovalView & { readonly workflowRun: WorkflowRunClaim }; readonly command: Command | null;
  readonly workflow: Workflow | null; readonly workflowHash: string; readonly workflowId: string | null };

async function proposalOf(deps: WorkflowRunSurface, run: RunRecord, step: StepProposal | null, base: ApprovalView): Promise<SequentialProposal> {
  const fresh = await deps.store.byId(run.runId) ?? run;
  const network = step ? step.strategy.action === 'bridge' ? step.strategy.sourceNetwork : step.strategy.network : null;
  const workflowRun: WorkflowRunClaim = { run: await runView(deps, fresh, { outcomes: true, owner: true }), plan: await ownerAuthorizationPlan(deps, fresh),
    step: step ? { index: step.stepIndex, count: step.stepCount } : null,
    stepWallet: network ? fresh.wallets[network.startsWith('solana') ? 'solana' : 'eip155'] ?? null : null };
  return { view: { ...base, workflowRun }, command: step?.composition.command ?? null, workflow: step?.composition.workflow ?? null,
    workflowHash: step?.workflowHash ?? fresh.workflowHash, workflowId: step?.composition.workflow.workflowId ?? null };
}

/** After the handoff claim of a SEQUENTIAL proposal: its run, started at once when confirm-each-step is the owner's only mode. */
export async function claimSequential(deps: WorkflowRunSurface, h: HandoffRecord, workflow: WorkflowComposition, wallets: readonly WalletRef[], base: ApprovalView) {
  let run = await ensureForClaim(deps, h, workflow, wallets);
  if (run.state === 'PENDING' && run.mode === null) {
    const plan = await ownerAuthorizationPlan(deps, run);
    // BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the run starts at once only when confirming each step is the owner's only real choice (user-funded
    // groups with at least one grouped interaction, never more wallet interactions than confirming each step, leave the choice to the owner).
    if (plan.confirmEachStep.available && plan.recommended !== 'USER_FUNDED') run = await startConfirm(deps, run, wallets);
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
/** The run's status for its owner: observed as the worker observes it, and nothing is resolved or loaded (a poll never readies or loads a step). */
export async function statusSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], base: ApprovalView) {
  return proposalOf(deps, await observeRun(deps, run, wallets), null, base);
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
  if (run.mode === 'DELEGATED') { assertRunWallets(run, wallets); await (deps.delegationOps ?? refuse('DELEGATION_NOT_ENABLED')).revoke(run.owner, run.runId); return proposalOf(deps, await observeRun(deps, run, wallets), null, base); }
  return proposalOf(deps, await cancelRun(deps, run, wallets), null, base);
}
export async function resumeSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], base: ApprovalView) {
  const resumed = await resumeRun(deps, run, wallets);
  return proposalOf(deps, resumed, await currentStep(deps, resumed, wallets), base);
}
/** The run's ONE authorization Review (delegated mode): the exact workflow grants the owner's wallet signs, one per EVM network. */
export async function authorizationReviewSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[]): Promise<WalletWorkflowReviewView> {
  assertRunWallets(run, wallets);
  if (run.state !== 'PENDING' || run.mode !== null) refuse(run.mode === 'CONFIRM_EACH_STEP' ? 'WORKFLOW_RUN_CONFIRM_MODE_CHOSEN' : `WORKFLOW_RUN_${run.state}`);
  const plan = await ownerAuthorizationPlan(deps, run);
  if (!plan.delegatedSingleAuthorization.available) refuse(plan.delegatedSingleAuthorization.reason ?? 'DELEGATED_AUTHORITY_UNAVAILABLE');
  const ops = deps.delegationOps ?? refuse('DELEGATION_NOT_ENABLED');
  const wallet = run.wallets.eip155 ?? refuse('WALLET_SESSION_REQUIRED');
  return ops.review(run.owner, { runId: run.runId, strategy: run.strategy, workflowHash: run.workflowHash, validitySeconds: DELEGATED_AUTHORIZATION_SECONDS, wallet });
}
/** The owner's ONE authorization (the wallet signatures of the run's workflow grants): the run becomes DELEGATED and starts, with no further signature. */
export async function authorizeSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], revision: number, assertion: unknown, base: ApprovalView) {
  assertRunWallets(run, wallets);
  const ops = deps.delegationOps ?? refuse('DELEGATION_NOT_ENABLED');
  // BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the requester's policy and the plan are checked again at signing, not only at review (an
  // operator may have disabled the network since). A retry of an already-delegated run (its first response was lost) is answered by the
  // idempotent sign, which activates nothing again.
  if (run.mode !== 'DELEGATED') {
    const plan = await ownerAuthorizationPlan(deps, run);
    if (!plan.delegatedSingleAuthorization.available) refuse(plan.delegatedSingleAuthorization.reason ?? 'DELEGATED_AUTHORITY_UNAVAILABLE');
  }
  await ops.sign(run.owner, run.runId, revision, assertion, run.mode === 'DELEGATED');
  return proposalOf(deps, run, null, base);
}

// ── BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: user-funded execution groups (the owner's own wallet authorizes and pays) ────────────────
/** The owner chose user-funded execution: the groups are planned for the wallets their browser reported, then the run starts. */
export async function userFundedStartSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], profile: WalletProfile, base: ApprovalView) {
  const started = await startUserFunded(deps, run, wallets, profile);
  return proposalOf(deps, started, await currentStep(deps, started, wallets), base);
}
/**
 * What the owner's wallet signs for one group (exact calls, typed data or Solana transactions, with the fee ceiling and its payer). `wallet`: the
 * owner's EVM wallet as the preparing browser reported it (absent: unknown, never offered a token-paid fee that needs a typed-data permit).
 */
export async function userFundedPrepareSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], groupIndex: number,
  handout?: string, wallet?: 'INJECTED' | 'FLOFI_WALLET'): Promise<PreparedGroupView> {
  return prepareUserFundedGroup(deps, run, wallets, groupIndex, handout, wallet);
}
/** ADR-0010: the owner's USDC permit for a Circle-paid group; returns the operation's typed data the owner's wallet signs next. */
export async function userFundedPermitSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], groupIndex: number,
  permitSignature: string): Promise<PreparedGroupView> {
  return permitUserFundedGroup(deps, run, wallets, groupIndex, permitSignature);
}
/** Owner requirement (FloFi Wallet + Circle): the owner agreed in FloFi to the group's EIP-7702 upgrade (recorded before the wallet is asked). */
export async function userFundedConsentSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], groupIndex: number): Promise<PreparedGroupView> {
  return consentUserFundedGroupUpgrade(deps, run, wallets, groupIndex);
}
/** Owner requirement (FloFi Wallet + Circle): the owner's EIP-7702 upgrade authorization; returns the group at its permit stage. */
export async function userFundedUpgradeSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], groupIndex: number,
  signature: string): Promise<PreparedGroupView> {
  return authorizeUserFundedGroupUpgrade(deps, run, wallets, groupIndex, signature);
}
export async function userFundedAuthorizeSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], groupIndex: number, answer: OwnerAnswer, base: ApprovalView) {
  const moved = await authorizeUserFundedGroup(deps, run, wallets, groupIndex, answer);
  return proposalOf(deps, moved, null, base);
}
export async function userFundedReportSequential(deps: WorkflowRunSurface, run: RunRecord, wallets: readonly WalletRef[], groupIndex: number, hashes: readonly string[], base: ApprovalView,
  notSent = false) {
  const moved = await reportUserFundedBatch(deps, run, wallets, groupIndex, hashes, notSent);
  return proposalOf(deps, moved, null, base);
}
