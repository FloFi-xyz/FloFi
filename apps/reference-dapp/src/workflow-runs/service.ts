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
import { planExecutionGroups, type UserFundedFacts, type WalletProfile } from './execution-groups.ts';
import { requirementOf, assetKey } from '../delegation/steps.ts';
import { evmStepBuildable, type AssetAmountFact } from '../user-funded/evm-calls.ts';
import { authorizeGroup, prepareGroup, type OwnerAnswer, type Prepared } from '../user-funded/groups.ts';
import { boundStrategy } from '../engine/workflow-bindings';
import type { GroupRecord } from './pg-store.ts';

type Env = Readonly<Record<string, string | undefined>>;
/** Workflow runs are opt-in per deployment (default off: a multi-step handoff is then refused with WORKFLOW_RUNS_NOT_ENABLED). */
export const workflowRunsEnabled = (env: Env): boolean => env.FLOFI_WORKFLOW_RUNS === 'enabled';

export type WorkflowRunDeps = Omit<RunnerDeps, 'policyFor'> & {
  readonly policyFor: (kind: ApprovalRequesterKind) => HandoffPolicy;
  readonly delegationFacts: DelegationFacts;
  /** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: what user-funded execution this deployment offers (absent: not enabled). */
  readonly userFundedFacts?: UserFundedFacts;
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
export async function ownerAuthorizationPlan(deps: WorkflowRunDeps, run: RunRecord, wallets?: WalletProfile): Promise<AuthorizationPlan> {
  const workflow = composeWorkflowBound(run.strategy, run.workflowHash);
  if (!workflow.ok) return refuse('WORKFLOW_RUN_STALE');
  const gates = await evaluateWorkflowGates(workflow, deps.runtime, deps.policyFor(run.requester.kind));
  const grants = deps.delegationFacts && deps.grantsOf ? await deps.grantsOf(run.owner) : null;
  return authorizationPlan(workflow, gates, deps.delegationFacts, grants ? { grants, now: deps.now().getTime() } : undefined,
    deps.userFundedFacts ? { facts: deps.userFundedFacts, ...wallets ? { wallets } : {} } : undefined);
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
  // BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: a user-funded run loads only its owner-step groups' steps here (grouped steps are DELEGATED).
  if (run.mode !== 'CONFIRM_EACH_STEP' && run.mode !== 'USER_FUNDED') return null;
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
  return deps.store.cancel(run.runId, run.version, code, deps.now());
}

/** The owner resumes a HALTED run whose stopped step submitted nothing (e.g. a flow that was disabled is enabled again). */
export async function resumeRun(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[]): Promise<RunRecord> {
  assertRunWallets(run, wallets);
  // A user-funded run halted at an owner-step group (its step's own flow) resumes exactly as confirm mode; any other group is re-planned.
  const at = run.mode === 'USER_FUNDED' ? (await deps.store.groups(run.runId)).find(x => x.stepFrom <= run.currentStep && run.currentStep <= x.stepTo) : null;
  const ownerStepGroup = at?.strategy === 'EVM_OWNER_STEP' || at?.strategy === 'SOLANA_OWNER_STEP';
  if (run.state === 'HALTED' && run.mode === 'USER_FUNDED' && !ownerStepGroup) return resumeUserFunded(deps, run);
  if (run.state !== 'HALTED' || (run.mode !== 'CONFIRM_EACH_STEP' && !ownerStepGroup)) refuse(`WORKFLOW_RUN_${run.state}`);
  if (run.expiresAt <= deps.now()) refuse('WORKFLOW_RUN_EXPIRED');
  const step = (await deps.store.steps(run.runId))[run.currentStep];
  if (!step || step.state !== 'BLOCKED') refuse('WORKFLOW_RUN_NOT_RESUMABLE');
  if (!await deps.store.transition(run.runId, { version: run.version, from: ['HALTED'] }, 'RUNNING', { code: null }, 'RUN_RESUMED')) refuse('WORKFLOW_RUN_CHANGED');
  // A step stopped before its resolution is re-gated from scratch; one stopped while READY keeps its resolved strategy and hash.
  await deps.store.stepTransition(run.runId, step!.stepIndex, ['BLOCKED'], step!.strategy ? 'READY' : 'PENDING', { code: null }, 'STEP_RESUMED');
  await advanceRun(runnerDeps(deps), run.runId);
  return (await deps.store.byId(run.runId))!;
}

// ── BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: user-funded execution groups ─────────────────────────────────────────────────────────
/**
 * A user-funded run halted at a group that was stopped BEFORE anything was sent (a refused due-time simulation, a delivery below what was
 * signed, an expired preparation): the group is planned again to be signed when due with the actual facts — a user operation becomes a
 * wallet batch the owner confirms then — and its steps wait again. Nothing already signed is reused.
 */
async function resumeUserFunded(deps: WorkflowRunDeps, run: RunRecord): Promise<RunRecord> {
  if (run.expiresAt <= deps.now()) refuse('WORKFLOW_RUN_EXPIRED');
  const g = (await deps.store.groups(run.runId)).find(x => x.stepFrom <= run.currentStep && run.currentStep <= x.stepTo);
  if (!g || g.state !== 'BLOCKED') refuse('WORKFLOW_RUN_NOT_RESUMABLE');
  // Something the owner already signed (a user operation, a batch id, Solana signatures) is never replaced: it may still execute on chain,
  // and a replacement would run the same steps twice (the database refuses it too). The owner ends the run and, for a user operation,
  // revokes it from their own wallet.
  if (g!.authorization) refuse('WORKFLOW_RUN_GROUP_SIGNED');
  if (!await deps.store.transition(run.runId, { version: run.version, from: ['HALTED'] }, 'RUNNING', { code: null }, 'RUN_RESUMED')) refuse('WORKFLOW_RUN_CHANGED');
  const strategy = g!.strategy === 'EVM_USER_OPERATION' ? 'EVM_WALLET_BATCH' as const : g!.strategy === 'SOLANA_DURABLE_NONCE' ? 'SOLANA_SIGN_ALL' as const : g!.strategy;
  await deps.store.groupTransition(run.runId, g!.groupIndex, ['BLOCKED'], 'PLANNED', { strategy, signing: 'WHEN_DUE', prepared: null, authorization: null, validUntil: null, code: null },
    'GROUP_RESUMED');
  for (let i = g!.stepFrom; i <= g!.stepTo; i++) {
    const moved = await deps.store.stepTransition(run.runId, i, ['BLOCKED'], 'PENDING', { code: null }, 'STEP_RESUMED');
    if (moved) await deps.store.stepTransition(run.runId, i, ['PENDING'], 'DELEGATED', {});
  }
  await advanceRun(runnerDeps(deps), run.runId);
  return (await deps.store.byId(run.runId))!;
}
const userFundedBuildable = (facts: UserFundedFacts) => (st: Parameters<typeof evmStepBuildable>[0]) => st.namespace === 'solana' || evmStepBuildable(st, facts.chains) === null;
/**
 * The owner chose user-funded execution with the wallets their browser reported (EIP-5792 capabilities, Wallet Standard features): the run's
 * groups are planned for exactly those wallets and stored with the mode, in one transaction (the database checks every group's fee payer is
 * the run's own wallet). Nothing is prepared or signed here.
 */
export async function startUserFunded(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[], profile: WalletProfile): Promise<RunRecord> {
  assertRunWallets(run, wallets);
  const facts = deps.userFundedFacts ?? refuse('USER_FUNDED_NOT_ENABLED');
  const plan = await ownerAuthorizationPlan(deps, run, profile);
  if (!plan.userFunded.available) refuse(plan.userFunded.reason ?? 'USER_FUNDED_UNAVAILABLE');
  const composed = composeWorkflowBound(run.strategy, run.workflowHash);
  if (!composed.ok) return refuse('WORKFLOW_RUN_STALE');
  const req = requirementOf(composed);
  if (!req.ok) return refuse(req.code);
  const grouped = planExecutionGroups(req.value, facts, profile, userFundedBuildable(facts));
  if (!grouped.ok) return refuse(grouped.code);
  await deps.store.startUserFunded(run.runId, grouped.groups, deps.now());
  await advanceRun(runnerDeps(deps), run.runId);
  return (await deps.store.byId(run.runId))!;
}
/** Reconciled facts that fund a group's bound steps: received by each earlier producer, minus what earlier consumers already used. */
function reconciledAvailable(steps: readonly RunStepRecord[], producer: number, asset: string, before: number): bigint {
  const received = (steps[producer]?.outcome?.received ?? []).filter(r => r.asset === asset).reduce((sum, r) => sum + BigInt(r.amount), 0n);
  const used = steps.filter(s => s.stepIndex > producer && s.stepIndex < before).reduce((sum, s) => {
    const bound = [s.bound, ...s.bound?.additional ?? []].filter(b => b && b.amountFrom === producer && assetKey({ chain: b.asset.chainId, address: b.asset.address }) === asset);
    const spent = (s.outcome?.spent ?? []).filter(x => x.asset === asset).reduce((t, x) => t + BigInt(x.amount), 0n);
    return sum + (bound.length ? spent : 0n);
  }, 0n);
  return received > used ? received - used : 0n;
}
export type PreparedGroupView = { readonly groupIndex: number; readonly strategy: string; readonly chain: string; readonly feePayer: string; readonly validUntil: string | null;
  readonly prepared: Prepared };
/**
 * Builds what the owner's wallet signs for one group, from fresh chain facts: an UPFRONT group at any time while the run is open; a WHEN_DUE
 * group only once it is the current group (its delivery reconciled). Bound steps spend the reconciled facts (never an estimate).
 */
export async function prepareUserFundedGroup(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[], groupIndex: number): Promise<PreparedGroupView> {
  assertRunWallets(run, wallets);
  if (run.mode !== 'USER_FUNDED' || !['RUNNING', 'ATTENTION'].includes(run.state)) refuse(`WORKFLOW_RUN_${run.mode !== 'USER_FUNDED' ? 'NOT_USER_FUNDED' : run.state}`);
  const userFunded = deps.userFunded ?? refuse('USER_FUNDED_NOT_ENABLED');
  const groups = await deps.store.groups(run.runId), steps = await deps.store.steps(run.runId);
  let g: GroupRecord = groups[groupIndex] ?? refuse('WORKFLOW_RUN_GROUP_NOT_FOUND');
  if (g.strategy === 'EVM_OWNER_STEP' || g.strategy === 'SOLANA_OWNER_STEP') refuse('WORKFLOW_RUN_GROUP_OWNER_STEP');
  if (g.state === 'PREPARED' && g.validUntil && g.validUntil > deps.now()) return { groupIndex, strategy: g.strategy, chain: g.chain, feePayer: g.feePayer,
    validUntil: g.validUntil.toISOString(), prepared: g.prepared as Prepared };
  if (g.state === 'PREPARED') g = await deps.store.groupTransition(run.runId, groupIndex, ['PREPARED'], 'EXPIRED', { code: 'USER_FUNDED_PREPARED_EXPIRED' }) ?? refuse('WORKFLOW_RUN_CHANGED');
  if (g.state === 'EXPIRED') g = await deps.store.groupTransition(run.runId, groupIndex, ['EXPIRED'], 'PLANNED', { prepared: null, validUntil: null, code: null }) ?? refuse('WORKFLOW_RUN_CHANGED');
  if (g.state !== 'PLANNED') refuse(`WORKFLOW_RUN_GROUP_${g.state}`);
  const due = run.currentStep === g.stepFrom;
  if (g.signing === 'WHEN_DUE' && !due) refuse('WORKFLOW_RUN_GROUP_NOT_DUE');
  // Only a user operation can be signed before it is due: FloFi relays it itself, when due. A wallet batch is SENT by the wallet the moment the
  // owner confirms (it would run out of order), and a Solana transaction's blockhash would expire long before its turn.
  if (!due && g.strategy !== 'EVM_USER_OPERATION') refuse('WORKFLOW_RUN_GROUP_NOT_DUE');
  const fresh = composeWorkflowBound(run.strategy, run.workflowHash);
  if (!fresh.ok) return refuse('WORKFLOW_RUN_STALE');
  const composed: WorkflowComposition = fresh;
  // Bound steps of a due group: their amounts are resolved now from reconciled facts, and Solana steps are re-composed with them.
  const guaranteed = new Map<number, AssetAmountFact>();
  // One delivery funds its consumers in this group IN ORDER: each takes min(cap, what is left), never the whole delivery again (EVM builders
  // draw down the `guaranteed` seed themselves; Solana steps are re-composed here with their share).
  const allocated = new Map<string, bigint>();
  let composition = composed;
  for (const b of composed.bindings.filter(b => b.step >= g.stepFrom && b.step <= g.stepTo && b.amountFrom < g.stepFrom).sort((x, y) => x.step - y.step)) {
    if (!due) refuse('WORKFLOW_BINDING_RESOLVED_WHEN_DUE');
    const asset = assetKey({ chain: b.asset.chainId, address: b.asset.address }), share = `${b.amountFrom}:${asset}`;
    const available = reconciledAvailable(steps, b.amountFrom, asset, g.stepFrom);
    if (available <= 0n) refuse('WORKFLOW_BINDING_NOTHING_RECEIVED');
    if (!guaranteed.has(b.amountFrom)) guaranteed.set(b.amountFrom, { asset, amount: available.toString() });
    if (g.namespace === 'solana') {
      const left = available - (allocated.get(share) ?? 0n);
      if (left <= 0n) refuse('WORKFLOW_BINDING_NOTHING_RECEIVED');
      const used = left < BigInt(b.cap) ? left : BigInt(b.cap);
      allocated.set(share, (allocated.get(share) ?? 0n) + used);
      const alone = composeWorkflowBound(boundStrategy(composed.steps[b.step]!.strategy, used, b.asset.decimals, b.inputAsset), undefined);
      if (!alone.ok || alone.steps.length !== 1) return refuse('WORKFLOW_STEP_STALE');
      composition = { ...composition, steps: composition.steps.map((c, i) => i === b.step ? alone.steps[0]! : c) };
    }
  }
  const req = requirementOf(composition);
  if (!req.ok) return refuse(req.code);
  const r = await prepareGroup(userFunded, composition, req.value, { runId: run.runId, groupIndex, strategy: g.strategy, chain: g.chain, feePayer: g.feePayer,
    stepFrom: g.stepFrom, stepTo: g.stepTo }, { guaranteed, delayed: g.awaitsDelivery !== null && !due });
  if (!r.ok) return refuse(r.code);
  const moved = await deps.store.groupTransition(run.runId, groupIndex, ['PLANNED'], 'PREPARED', { prepared: r.value.prepared, validUntil: r.value.validUntil, code: null })
    ?? refuse('WORKFLOW_RUN_CHANGED');
  return { groupIndex, strategy: moved.strategy, chain: moved.chain, feePayer: moved.feePayer, validUntil: r.value.validUntil.toISOString(), prepared: r.value.prepared };
}
/**
 * The owner's wallet answered for one PREPARED group: a wallet batch id, a user-operation signature, or the signed Solana transactions. Verified
 * against the frozen prepared artifact (signer = the group's fee payer = the run's wallet), then the run advances (submits what is due).
 */
export async function authorizeUserFundedGroup(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[], groupIndex: number, answer: OwnerAnswer): Promise<RunRecord> {
  assertRunWallets(run, wallets);
  if (run.mode !== 'USER_FUNDED') refuse('WORKFLOW_RUN_NOT_USER_FUNDED');
  const g = (await deps.store.groups(run.runId))[groupIndex] ?? refuse('WORKFLOW_RUN_GROUP_NOT_FOUND');
  // A retried answer for a group already authorized (its first response was lost) changes nothing.
  if (['AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'RECONCILED'].includes(g.state)) return (await deps.store.byId(run.runId))!;
  if (g.state !== 'PREPARED') refuse(`WORKFLOW_RUN_GROUP_${g.state}`);
  // A wallet batch's answer arrives AFTER the wallet sent it: refusing a late one would only lose track of a batch already on chain (the chain
  // decides at reconciliation). Every other artifact is still unsigned or unsent here, so its validity window applies.
  if (g.strategy !== 'EVM_WALLET_BATCH' && (!g.validUntil || g.validUntil <= deps.now())) refuse('USER_FUNDED_PREPARED_EXPIRED');
  const verified = authorizeGroup(g.prepared as Prepared, answer, g.feePayer, deps.now());
  if (!verified.ok) return refuse(verified.code);
  const authorized = await deps.store.groupTransition(run.runId, groupIndex, ['PREPARED'], 'AUTHORIZED', { authorization: verified.value }, 'GROUP_AUTHORIZED');
  if (!authorized) refuse('WORKFLOW_RUN_CHANGED');
  await advanceRun(runnerDeps(deps), run.runId);
  return (await deps.store.byId(run.runId))!;
}
/**
 * The owner's browser reports the transactions of a wallet batch (from `wallet_getCallsStatus`): only the hashes are taken; the chain decides.
 * `notSent`: the wallet reported the batch failed OFF chain (EIP-5792 status 400, no receipt): nothing was sent, so the group stops before
 * anything ran (BLOCKED) and the owner decides (end the run, or resume it).
 */
export async function reportUserFundedBatch(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[], groupIndex: number, hashes: readonly string[],
  notSent = false): Promise<RunRecord> {
  assertRunWallets(run, wallets);
  const groups = await deps.store.groups(run.runId);
  const g = groups[groupIndex] ?? refuse('WORKFLOW_RUN_GROUP_NOT_FOUND');
  if (g.strategy !== 'EVM_WALLET_BATCH') refuse('WORKFLOW_RUN_GROUP_NOT_BATCH');
  if (notSent === true) {
    if (g.state !== 'AUTHORIZED') refuse(`WORKFLOW_RUN_GROUP_${g.state}`);
    await deps.store.groupTransition(run.runId, groupIndex, ['AUTHORIZED'], 'BLOCKED', { code: 'EIP5792_BATCH_NOT_SENT' });
    for (let i = g.stepFrom; i <= g.stepTo; i++) await deps.store.stepTransition(run.runId, i, ['DELEGATED'], 'BLOCKED', { code: 'EIP5792_BATCH_NOT_SENT' });
    const partial = (await deps.store.steps(run.runId)).some(s => s.stepIndex < g.stepFrom && s.state === 'RECONCILED');
    await deps.store.transition(run.runId, { version: run.version, from: ['RUNNING', 'ATTENTION'] }, partial ? 'HALTED' : 'FAILED', { code: 'EIP5792_BATCH_NOT_SENT' });
    return (await deps.store.byId(run.runId))!;
  }
  if (!Array.isArray(hashes) || !hashes.length || hashes.length > 8 || hashes.some(h => typeof h !== 'string' || !/^0x[0-9a-f]{64}$/.test(h.toLowerCase()))) refuse('EIP5792_RESPONSE_INVALID');
  // A transaction already counted for another group of this run can never reconcile this one.
  const used = new Set(groups.filter(x => x.groupIndex !== groupIndex).flatMap(x => (x.submission as { hashes?: string[] } | null)?.hashes ?? []));
  if (hashes.some(h => used.has(h.toLowerCase()))) refuse('EIP5792_RESPONSE_INVALID');
  if (g.state === 'AUTHORIZED') await deps.store.groupTransition(run.runId, groupIndex, ['AUTHORIZED'], 'SUBMITTED', { submission: { kind: 'EVM_WALLET_BATCH',
    batchId: String(g.authorization?.batchId ?? ''), hashes: hashes.map(h => h.toLowerCase()), submittedAt: deps.now().toISOString() } });
  else if (g.state !== 'SUBMITTED' && g.state !== 'UNCERTAIN' && g.state !== 'RECONCILED') refuse(`WORKFLOW_RUN_GROUP_${g.state}`);
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
  readonly nextAction: 'OWNER_CHOOSES_MODE' | 'OWNER_SIGNS_STEP' | 'OWNER_SIGNS_GROUP' | 'OWNER_CONFIRMS_BATCH' | 'WAITING_FOR_RECONCILIATION' | 'OWNER_DECIDES' | 'NONE';
  /** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: a USER_FUNDED run's execution groups (public facts only; never a signature or transaction bytes). */
  readonly groups: readonly RunGroupView[];
  readonly authority: 'NONE'; readonly note: string | null };
export type RunGroupView = { readonly index: number; readonly chain: string; readonly strategy: string; readonly signing: string; readonly steps: readonly [number, number];
  readonly state: string; readonly awaitsDelivery: number | null; readonly code: string | null; readonly validUntil: string | null;
  /** Always the run's own wallet on this network (S1). */
  readonly feePayer: string;
  /** The most this group can cost its owner in network fees (native units of `unit`), from the prepared artifact; null until prepared. */
  readonly maxFee: { readonly amount: string; readonly unit: string; readonly estimated: boolean } | null;
  /** Network fees actually paid, from the chain (null until reconciled). */
  readonly gasPaid: { readonly amount: string; readonly unit: string; readonly payer: string } | null;
  readonly transactions: readonly { readonly chain: string; readonly hash: string; readonly explorerUrl: string | null }[];
  /** A wallet batch's id (the owner's own wallet's handle, to read its receipts back after a reload); null otherwise. */
  readonly batchId: string | null;
  /** Whether the owner already signed/answered this group (a signed user operation stays valid on chain until its nonce key is used). */
  readonly signed: boolean };

/**
 * The public status of a run. `outcomes` false (a requester the owner did not share status with) keeps every step's state but withholds its
 * transactions, amounts and evidence. Nothing returned is a key, calldata or a signature, and nothing here authorizes anything.
 */
export async function runView(deps: { readonly store: Pick<WorkflowRunStore, 'steps' | 'groups'> }, run: RunRecord, options: { readonly outcomes: boolean; readonly origin?: string | null }): Promise<RunView> {
  const steps = await deps.store.steps(run.runId);
  const groupRecords = run.mode === 'USER_FUNDED' ? await deps.store.groups(run.runId) : [];
  const groups: RunGroupView[] = groupRecords.map(g => {
    const fee = (g.prepared as { fee?: { maxCost?: string; unit?: string; estimated?: boolean } } | null)?.fee;
    const paid = (g.outcome as { gasPaid?: { amount: string; unit: string; payer: string } } | null)?.gasPaid ?? null;
    const hashes = options.outcomes ? ((g.outcome as { transactions?: string[] } | null)?.transactions ?? (g.submission as { hashes?: string[] } | null)?.hashes ?? []) : [];
    return { index: g.groupIndex, chain: g.chain, strategy: g.strategy, signing: g.signing, steps: [g.stepFrom, g.stepTo] as const, state: g.state, awaitsDelivery: g.awaitsDelivery,
      // A requester the owner did not share status with sees that the owner's wallet pays, never which wallet (nor its batch id or fees).
      code: g.code, validUntil: g.validUntil?.toISOString() ?? null, feePayer: options.outcomes ? g.feePayer : 'OWNER_WALLET',
      maxFee: options.outcomes && fee?.maxCost && fee.unit ? { amount: fee.maxCost, unit: fee.unit, estimated: fee.estimated !== false } : null,
      gasPaid: options.outcomes && paid ? { amount: paid.amount, unit: paid.unit, payer: paid.payer } : null,
      transactions: hashes.map(hash => ({ chain: g.chain, hash, explorerUrl: executionExplorer(g.chain, hash, false) })),
      batchId: options.outcomes && g.strategy === 'EVM_WALLET_BATCH' ? typeof g.authorization?.batchId === 'string' ? g.authorization.batchId
        : g.state === 'PREPARED' ? String((g.prepared as { request?: { id?: string } } | null)?.request?.id ?? '') || null : null : null,
      signed: g.authorization !== null };
  });
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
  const group = groupRecords.find(g => g.stepFrom <= run.currentStep && run.currentStep <= g.stepTo);
  const ownerGroup = group && (group.strategy === 'EVM_OWNER_STEP' || group.strategy === 'SOLANA_OWNER_STEP');
  const nextAction = run.state === 'PENDING' ? 'OWNER_CHOOSES_MODE' : run.state === 'HALTED' ? 'OWNER_DECIDES'
    : ['RUNNING', 'ATTENTION'].includes(run.state)
      ? (run.mode === 'CONFIRM_EACH_STEP' || (run.mode === 'USER_FUNDED' && ownerGroup)) && (current?.state === 'READY' || current?.state === 'PENDING') ? 'OWNER_SIGNS_STEP'
        : run.mode === 'USER_FUNDED' && group && !ownerGroup && ['PLANNED', 'PREPARED'].includes(group.state) ? 'OWNER_SIGNS_GROUP'
          : run.mode === 'USER_FUNDED' && group?.state === 'AUTHORIZED' && group.strategy === 'EVM_WALLET_BATCH' ? 'OWNER_CONFIRMS_BATCH'
            : 'WAITING_FOR_RECONCILIATION' : 'NONE';
  const note = !options.outcomes ? 'The owner has not shared the transactions and evidence of this workflow with this conversation.'
    : run.state === 'HALTED' ? 'Partially completed: the reconciled steps stay done and their funds rest in the owner\'s wallet. Nothing later was submitted.'
      : run.state === 'ATTENTION' ? 'A submitted step has no final outcome yet. FloFi keeps observing it and never resubmits it.' : null;
  return { workflowRunId: run.runId, approvalId: run.handoffId, state: run.state, mode: run.mode, stepCount: run.stepCount, currentStep: run.currentStep, code: run.code,
    workflowHash: run.workflowHash, expiresAt: run.expiresAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null, createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(), stepsVisible: options.outcomes, steps: views, nextAction, groups, authority: 'NONE', note };
}
