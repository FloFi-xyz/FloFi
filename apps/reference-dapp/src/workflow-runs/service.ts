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
import { ENGINE_VERSION, evaluateGates, evaluateWorkflowGates, handoffFindings, type HandoffPolicy } from '../mcp/execution.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { executionRefusal } from '../server/execution-guard.ts';
import { executionExplorer } from '../domain/execution-lifecycle';
import { planNamespace, planNamespaces } from '../platform/approvals.ts';
import { strategyTestNetworks } from '../platform/strategy.ts';
import { TEST_NETWORK_NOT_AVAILABLE } from '../domain/network-scope';
import { networkScope } from '../server/network-scope.ts';
import type { GrantView } from '../delegation/authority.ts';
import { authorizationPlan, type AuthorizationPlan, type DelegationFacts } from './authorization-plan.ts';
import type { RunRecord, RunStepRecord, WorkflowRunStore } from './pg-store.ts';
import { advanceRun, type RunnerDeps } from './runner.ts';
import { stopRunFromCurrent } from './user-funded-pass.ts';
import { CONFIRM_RUN_SECONDS, MAYBE_SUBMITTED, WALLET_BATCH_OUTCOME_UNKNOWN, WALLET_BATCH_SETTLE_MS, walletBatchUnanswered } from './state-machine.ts';
import { planExecutionGroups, type UserFundedFacts, type WalletProfile } from './execution-groups.ts';
import { requirementOf, assetKey } from '../delegation/steps.ts';
import { evmStepBuildable, type AssetAmountFact, type EvmGroupCalls } from '../user-funded/evm-calls.ts';
import { plannedSteps, type PlannedStep } from '../user-funded/planned.ts';
import { authorizeGroup, EVM_PREPARED_TTL_MS, prepareGroup, solanaPreparedTtlMs, supersede, walletBatchId, type OwnerAnswer, type Prepared } from '../user-funded/groups.ts';
import { boundStrategy } from '../engine/workflow-bindings';
import type { GroupRecord } from './pg-store.ts';
import { bridgeProgressOf, type BridgeDeliveryState } from '../user-funded/bridge-delivery.ts';
import { presentedDeliveryState } from './run-step-phase.ts';

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
    deps.userFundedFacts ? { facts: deps.userFundedFacts, ...wallets ? { wallets } : {}, evmOwner: run.wallets.eip155 ?? null } : undefined);
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

const groupAt = (groups: readonly GroupRecord[], step: number) => groups.find(x => x.stepFrom <= step && step <= x.stepTo);
const isOwnerStepGroup = (g: GroupRecord | undefined) => g?.strategy === 'EVM_OWNER_STEP' || g?.strategy === 'SOLANA_OWNER_STEP';
/**
 * Why Resume would be refused for this run now, or null when the server accepts it: the ONE rule `resumeRun` enforces and `runView` shows as
 * `resumable`, so no surface offers a Resume the server refuses. Only a HALTED run inside its window; a user-funded run halted at a group FloFi
 * executes only while that group is BLOCKED and unsigned; any other (confirm mode, or an owner-step group) only while its current step is BLOCKED.
 */
export function resumeRefusal(run: RunRecord, steps: readonly RunStepRecord[], groups: readonly GroupRecord[], now: Date): string | null {
  // A user-funded run halted at an owner-step group (its step's own flow) resumes exactly as confirm mode; any other group is re-planned.
  const at = run.mode === 'USER_FUNDED' ? groupAt(groups, run.currentStep) : undefined;
  if (run.state === 'HALTED' && run.mode === 'USER_FUNDED' && !isOwnerStepGroup(at)) {
    if (run.expiresAt <= now) return 'WORKFLOW_RUN_EXPIRED';
    if (!at || at.state !== 'BLOCKED') return 'WORKFLOW_RUN_NOT_RESUMABLE';
    // Something the owner already signed (a user operation, a batch id, Solana signatures) is never replaced: it may still execute on chain,
    // and a replacement would run the same steps twice (the database refuses it too). The owner ends the run and, for a user operation,
    // revokes it from their own wallet.
    return at.authorization ? 'WORKFLOW_RUN_GROUP_SIGNED' : null;
  }
  if (run.state !== 'HALTED' || (run.mode !== 'CONFIRM_EACH_STEP' && !isOwnerStepGroup(at))) return `WORKFLOW_RUN_${run.state}`;
  if (run.expiresAt <= now) return 'WORKFLOW_RUN_EXPIRED';
  return steps.find(s => s.stepIndex === run.currentStep)?.state === 'BLOCKED' ? null : 'WORKFLOW_RUN_NOT_RESUMABLE';
}

/** The owner resumes a HALTED run whose stopped step submitted nothing (e.g. a flow that was disabled is enabled again). */
export async function resumeRun(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[]): Promise<RunRecord> {
  assertRunWallets(run, wallets);
  const groups = run.mode === 'USER_FUNDED' ? await deps.store.groups(run.runId) : [], steps = await deps.store.steps(run.runId);
  const refusal = resumeRefusal(run, steps, groups, deps.now());
  if (refusal) return refuse(refusal);
  const at = groupAt(groups, run.currentStep);
  if (at && !isOwnerStepGroup(at)) return resumeUserFunded(deps, run, at);
  const step = steps.find(s => s.stepIndex === run.currentStep)!;
  if (!await deps.store.transition(run.runId, { version: run.version, from: ['HALTED'] }, 'RUNNING', { code: null }, 'RUN_RESUMED')) refuse('WORKFLOW_RUN_CHANGED');
  // A step stopped before its resolution is re-gated from scratch; one stopped while READY keeps its resolved strategy and hash.
  await deps.store.stepTransition(run.runId, step.stepIndex, ['BLOCKED'], step.strategy ? 'READY' : 'PENDING', { code: null }, 'STEP_RESUMED');
  await advanceRun(runnerDeps(deps), run.runId);
  return (await deps.store.byId(run.runId))!;
}

// ── BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: user-funded execution groups ─────────────────────────────────────────────────────────
/**
 * A user-funded run halted at a group that was stopped BEFORE anything was sent (a refused due-time simulation, a delivery below what was
 * signed, an expired preparation): the group is planned again to be signed when due with the actual facts — a user operation becomes a
 * wallet batch the owner confirms then — and its steps wait again. Nothing already signed is reused (`resumeRefusal` checked it is unsigned).
 */
async function resumeUserFunded(deps: WorkflowRunDeps, run: RunRecord, g: GroupRecord): Promise<RunRecord> {
  if (!await deps.store.transition(run.runId, { version: run.version, from: ['HALTED'] }, 'RUNNING', { code: null }, 'RUN_RESUMED')) refuse('WORKFLOW_RUN_CHANGED');
  // Every wallet batch ever handed out for this group shares its EIP-5792 id and may still be in (or already sent by) the owner's wallet: the
  // resumed group keeps that history, so a batch the wallet sends under the id later is still recognised and reconciled.
  const history = g.strategy === 'EVM_WALLET_BATCH' ? supersede(g.prepared as Prepared | null) : [];
  // P0 universal execution: a group stopped by a refusal no retry can change (its RPC cannot simulate the Aave calls it needs, the action cannot
  // be batched on this deployment, …) continues through each step's own owner-signed flow — which re-checks, simulates and reviews every step
  // itself — instead of being planned as the same batch and refused again. Only when no batch was ever handed to the wallet for it: otherwise
  // that batch could still execute and the steps would run twice.
  const ownerSteps = g.code !== null && PERMANENT_DUE_REFUSALS.has(g.code) && history.length === 0;
  const strategy = ownerSteps ? g.namespace === 'solana' ? 'SOLANA_OWNER_STEP' as const : 'EVM_OWNER_STEP' as const
    : g.strategy === 'EVM_USER_OPERATION' ? 'EVM_WALLET_BATCH' as const : g.strategy === 'SOLANA_DURABLE_NONCE' ? 'SOLANA_SIGN_ALL' as const : g.strategy;
  await deps.store.groupTransition(run.runId, g.groupIndex, ['BLOCKED'], 'PLANNED', { strategy, signing: 'WHEN_DUE',
    prepared: history.length ? { kind: 'EVM_WALLET_BATCH', superseded: history } : null, authorization: null, validUntil: null, code: null }, 'GROUP_RESUMED');
  for (let i = g.stepFrom; i <= g.stepTo; i++) {
    const moved = await deps.store.stepTransition(run.runId, i, ['BLOCKED'], 'PENDING', { code: null }, 'STEP_RESUMED');
    // A grouped step waits for its group; an owner step runs through its own flow from PENDING, exactly as in confirm-each-step mode.
    if (moved && !ownerSteps) await deps.store.stepTransition(run.runId, i, ['PENDING'], 'DELEGATED', {});
  }
  await advanceRun(runnerDeps(deps), run.runId);
  return (await deps.store.byId(run.runId))!;
}
/**
 * P0 universal execution: refusals of a DUE group that no retry can change (what was delivered, what the deployment's RPC offers, what the
 * workflow says). Such a group is blocked and the run halted at once — the owner resumes it (each step then runs through its own owner-signed
 * flow) or ends it — instead of the run staying RUNNING (up to its expiry) while every attempt fails again.
 */
export const PERMANENT_DUE_REFUSALS: ReadonlySet<string> = new Set(['WORKFLOW_BINDING_NOTHING_RECEIVED', 'WORKFLOW_BINDING_NOTHING_GUARANTEED', 'WORKFLOW_BINDING_NOT_EXACT',
  'USER_FUNDED_SIMULATION_UNAVAILABLE', 'AAVE_BENEFICIARY_NOT_OWNER', 'WORKFLOW_SLIPPAGE_UNSUPPORTED', 'USER_FUNDED_GROUP_TOO_MANY_CALLS', 'USER_FUNDED_CHAIN_DISABLED',
  'USER_FUNDED_ACTION_NOT_BUILDABLE', 'USER_FUNDED_STEP_SHAPE_UNSUPPORTED', 'DELEGATION_ASSET_NOT_SUPPORTED', 'DELEGATION_TEMPLATE_NOT_IMPLEMENTED',
  // A transfer or swap of an asset no batch may move (a Stock Token, a token outside the catalog or with other decimals): a run grouped before
  // that rule existed meets it only here, and it never changes on retry; the step's own owner-signed flow reviews and sends it.
  'USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED', 'USER_FUNDED_SWAP_ASSET_UNSUPPORTED',
  // A native transfer to an address with code: the owner-signed transfer flow applies its own contract-recipient rule to it.
  'USER_FUNDED_TRANSFER_RECIPIENT_NOT_EOA',
  // What the chain's own contracts say (a token's code or decimals, a fee-on-transfer token) or the registry lacks (a router for the expiry guard).
  'TOKEN_METADATA_MISMATCH', 'CONTRACT_CODE_MISSING', 'SIMULATION_SWAP_OUTPUT_SHORT', 'USER_FUNDED_DEADLINE_UNAVAILABLE',
  // A batched Repay no longer below the owner's current variable debt (repaid elsewhere meanwhile): the signed amount is fixed and the debt only
  // grows by interest, so every retry refuses again. The owner-signed Repay flow re-reads the debt and reviews the step itself.
  'REPAY_PARTIAL_DEBT_REQUIRED',
  // P0 hotfix (E1): a bridge no batch may carry here (its pair, asset, provider, recipient or destination RPC; a route the deployment does not
  // offer is USER_FUNDED_ACTION_NOT_BUILDABLE above), or a deployment whose pinned contracts no longer match: the Router's own flow reviews it.
  'USER_FUNDED_BRIDGE_PROVIDER_UNSUPPORTED', 'USER_FUNDED_BRIDGE_PAIR_UNSUPPORTED', 'USER_FUNDED_BRIDGE_ASSET_UNSUPPORTED', 'USER_FUNDED_BRIDGE_DESTINATION_UNREADABLE',
  'USER_FUNDED_BRIDGE_RECIPIENT_NOT_OWNER', 'USER_OPERATION_BRIDGE_SIGNED_WHEN_DUE', 'ROUTER_UNEXPECTED_CONTRACT',
  'ROUTER_CONTRACT_CODE_MISSING']);
/**
 * Blocks a due group after a permanent refusal and halts the run (steps already executed keep their facts), then refuses with the code. Only
 * from exactly the PLANNED group this preparation read (its row version): a concurrent preparation that succeeded — its batch possibly already
 * in the owner's wallet — is never blocked, and neither its steps nor the run are touched then. The run halts from its CURRENT version (it may
 * have moved while the group was being prepared).
 *
 * HALTED even when this is the FIRST group and nothing ran (where any other stop with no progress is FAILED): the steps can still run through
 * their own owner-signed flows on Resume. The run's note then says it stopped before anything was sent, never that it partially completed.
 */
async function blockDueGroup(deps: WorkflowRunDeps, run: RunRecord, g: GroupRecord, code: string): Promise<never> {
  const stored = code.split(':')[0]!;
  if (!await deps.store.groupTransition(run.runId, g.groupIndex, ['PLANNED'], 'BLOCKED', { code: stored }, 'GROUP_STATE', g.version)) return refuse(code);
  for (let i = g.stepFrom; i <= g.stepTo; i++) await deps.store.stepTransition(run.runId, i, ['DELEGATED'], 'BLOCKED', { code: stored });
  const halted = await stopRunFromCurrent(deps, run.runId, 'HALTED', stored);
  const steps = await deps.store.steps(run.runId);
  deps.log('workflow_run.group_blocked', { run: run.runId, group: g.groupIndex, code: stored, halted: halted !== null,
    partial: steps.some(s => s.stepIndex < g.stepFrom && s.state === 'RECONCILED') });
  return refuse(code);
}
/**
 * The validity a prepared WALLET BATCH must still have to be handed to the owner's wallet again (time to review and confirm it before its
 * on-chain deadline reverts it). With less it is not prepared again until its validity has passed (USER_FUNDED_PREPARED_STILL_VALID): never two
 * live batches of one group. Other preparations are handed out while valid: a Solana group's whole validity is shorter than this, and a user
 * operation is relayed by FloFi itself.
 */
export const PREPARED_MIN_REMAINING_MS = 3 * 60_000;
/**
 * How long a NEW preparation of a group can stay executable by the owner's wallet: a wallet batch until its on-chain deadline, a Solana group at
 * most its longest blockhash window (one transaction). A user operation is prepared only while the run is open.
 */
const preparedHorizonMs = (strategy: GroupRecord['strategy']) => strategy === 'EVM_WALLET_BATCH' ? EVM_PREPARED_TTL_MS
  : strategy === 'SOLANA_SIGN_ALL' ? solanaPreparedTtlMs(1) : 0;
/** P0 workflow execution: the run's own EVM wallet is known here, so a step whose Aave beneficiary is another account is never grouped. */
/** Whether a step can join a user-funded batch: true, or the builder's own closed reason why not (shown as the group's downgrade). */
export const userFundedBuildable = (facts: UserFundedFacts, evmOwner?: string | null) => (st: Parameters<typeof evmStepBuildable>[0]): boolean | string =>
  st.namespace === 'solana' || (evmStepBuildable(st, facts.chains, evmOwner, facts.bridgeRoutes) ?? true);
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
  const grouped = planExecutionGroups(req.value, facts, profile, userFundedBuildable(facts, run.wallets.eip155));
  if (!grouped.ok) return refuse(grouped.code);
  await deps.store.startUserFunded(run.runId, grouped.groups, deps.now());
  await advanceRun(runnerDeps(deps), run.runId);
  return (await deps.store.byId(run.runId))!;
}
/**
 * Reconciled facts that fund a group's bound steps: received by the producer, minus what earlier consumers of it used — the SAME rule as
 * confirm mode (runner.ts): an earlier consumer's approved/signed amount is reserved unless its reconciled record proves it spent less, so
 * missing spend evidence can never unlock the owner's unrelated balance.
 */
function reconciledAvailable(steps: readonly RunStepRecord[], producer: number, asset: string, before: number): bigint {
  const received = (steps[producer]?.outcome?.received ?? []).filter(r => r.asset === asset).reduce((sum, r) => sum + BigInt(r.amount), 0n);
  const used = steps.filter(s => s.stepIndex > producer && s.stepIndex < before && s.bound).reduce((sum, s) => {
    const bound = [s.bound!, ...s.bound!.additional ?? []].filter(b => b.amountFrom === producer && assetKey({ chain: b.asset.chainId, address: b.asset.address }) === asset);
    if (!bound.length) return sum;
    const reserved = bound.reduce((t, b) => t + BigInt(b.used), 0n);
    const facts = (s.outcome?.spent ?? []).filter(x => x.asset === asset), spent = facts.reduce((t, x) => t + BigInt(x.amount), 0n);
    return sum + (facts.length && spent < reserved ? spent : reserved);
  }, 0n);
  return received > used ? received - used : 0n;
}
export type PreparedGroupView = { readonly groupIndex: number; readonly strategy: string; readonly chain: string; readonly feePayer: string; readonly validUntil: string | null;
  readonly prepared: Prepared;
  /**
   * Wallet batch only: the hand-out token of this group's batch. The browser that received the batch keeps it and presents it to be given the
   * same batch again, or to have it prepared again once it can no longer execute (`WALLET_BATCH_HANDED_OUT_ELSEWHERE` without it).
   */
  readonly handout: string | null };
/**
 * Final review (P1): one wallet batch is handed to ONE browser. Two devices or wallet instances of the same account share no EIP-5792 id
 * de-duplication, so the same batch (or a new preparation of it) handed to a second one could execute twice. The first preparation of a
 * batch group returns a random hand-out token and stores only its SHA-256 on the prepared artifact; handing the batch out again, or preparing
 * it again after its validity, needs that token. Another browser is refused WALLET_BATCH_HANDED_OUT_ELSEWHERE (the owner continues in the
 * browser that holds it, or ends the run once the batch can no longer execute). A preparation stored before this rule has no token bound.
 */
const HANDOUT = /^[A-Za-z0-9_-]{43}$/;
const handoutHashOf = (token: string) => createHash('sha256').update(token).digest('hex');
function handedTo(g: GroupRecord, handout: string | undefined): boolean {
  const bound = (g.prepared as { readonly handoutHash?: unknown } | null)?.handoutHash;
  if (typeof bound !== 'string') return true;
  if (handout === undefined || !HANDOUT.test(handout)) return false;
  const a = Buffer.from(handoutHashOf(handout), 'hex'), b = Buffer.from(bound, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
/** What the owner's browser is shown of a prepared artifact: never the hand-out token's hash. */
const publicPrepared = (prepared: Prepared): Prepared => Object.fromEntries(Object.entries(prepared).filter(([key]) => key !== 'handoutHash')) as Prepared;
/**
 * Builds what the owner's wallet signs for one group, from fresh chain facts: an UPFRONT group at any time while the run is open; a WHEN_DUE
 * group only once it is the current group (its delivery reconciled). Bound steps spend the reconciled facts (never an estimate).
 */
export async function prepareUserFundedGroup(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[], groupIndex: number,
  handout?: string): Promise<PreparedGroupView> {
  assertRunWallets(run, wallets);
  if (run.mode !== 'USER_FUNDED' || !['RUNNING', 'ATTENTION'].includes(run.state)) refuse(`WORKFLOW_RUN_${run.mode !== 'USER_FUNDED' ? 'NOT_USER_FUNDED' : run.state}`);
  const userFunded = deps.userFunded ?? refuse('USER_FUNDED_NOT_ENABLED');
  // Final review (P1): an operator pause stops EVERY hand-out to the owner's wallet — a batch prepared before the pause too, which the wallet
  // would send the moment the owner confirms. Answers for batches already handed out are still taken (groups.ts `authorizeGroup`).
  const paused = executionRefusal();
  if (paused) refuse(paused);
  const groups = await deps.store.groups(run.runId), steps = await deps.store.steps(run.runId);
  let g: GroupRecord = groups[groupIndex] ?? refuse('WORKFLOW_RUN_GROUP_NOT_FOUND');
  if (g.strategy === 'EVM_OWNER_STEP' || g.strategy === 'SOLANA_OWNER_STEP') refuse('WORKFLOW_RUN_GROUP_OWNER_STEP');
  const batch = g.strategy === 'EVM_WALLET_BATCH', now = deps.now();
  // Nothing is handed out once the run's window has passed (a batch already in the owner's wallet is still answered, until its deadline).
  if (run.expiresAt <= now) refuse('WORKFLOW_RUN_EXPIRED');
  // A batch already handed to a browser goes again, or is prepared again, only to that browser (`handedTo`).
  if (batch && g.state === 'PREPARED' && !handedTo(g, handout)) refuse('WALLET_BATCH_HANDED_OUT_ELSEWHERE');
  if (g.state === 'PREPARED' && g.validUntil && g.validUntil > now) {
    // P0 universal execution: a cached wallet batch is handed out only with enough validity left to review and confirm it before its on-chain
    // deadline. With less, it is NOT prepared again while it is still valid: two devices or wallet instances share no EIP-5792 id dedupe, so a
    // second, overlapping batch could execute too. The owner confirms the open request, or asks again once its validUntil has passed.
    if (batch && g.validUntil.getTime() <= now.getTime() + PREPARED_MIN_REMAINING_MS) refuse('USER_FUNDED_PREPARED_STILL_VALID');
    return { groupIndex, strategy: g.strategy, chain: g.chain, feePayer: g.feePayer, validUntil: g.validUntil.toISOString(),
      prepared: publicPrepared(g.prepared as Prepared), handout: batch ? handout ?? null : null };
  }
  // Nor in the settle margin after it (`WALLET_BATCH_SETTLE_MS`): the batch's on-chain deadline is its validity, and the chain's clock may run
  // behind FloFi's — a batch prepared again inside it could execute alongside the earlier one.
  if (batch && g.state === 'PREPARED' && g.validUntil && g.validUntil.getTime() + WALLET_BATCH_SETTLE_MS > now.getTime()) refuse('USER_FUNDED_PREPARED_STILL_VALID');
  // A new preparation never outlives the run: what the owner's wallet could still execute after the run's window (a wallet batch until its
  // on-chain deadline, Solana transactions until their blockhash expires) would be refused as expired after it ran.
  if (run.expiresAt.getTime() <= now.getTime() + preparedHorizonMs(g.strategy)) refuse('WORKFLOW_RUN_EXPIRED');
  // A wallet batch prepared before keeps every earlier preparation for reconciliation: they share one EIP-5792 id, so the wallet may hold one of them.
  const superseded = batch && ['PREPARED', 'EXPIRED', 'PLANNED'].includes(g.state) ? supersede(g.prepared as Prepared | null) : [];
  // A wallet batch already handed out (its validity passed: see above) STAYS PREPARED while it is prepared again, and is replaced only when the
  // new preparation succeeds (a compare-and-set on the row version): the wallet may send the earlier batch at any time — even after its
  // validity, when its on-chain deadline reverts it — and its answer must still be accepted and reconciled, whatever this preparation's outcome.
  const rewrite = batch && g.state === 'PREPARED' ? g : null;
  if (g.state === 'PREPARED' && !rewrite) g = await deps.store.groupTransition(run.runId, groupIndex, ['PREPARED'], 'EXPIRED', { code: 'USER_FUNDED_PREPARED_EXPIRED' })
    ?? refuse('WORKFLOW_RUN_CHANGED');
  // The earlier preparations stay on the PLANNED group (history only, no artifact): a preparation that fails now must not lose them.
  if (g.state === 'EXPIRED') g = await deps.store.groupTransition(run.runId, groupIndex, ['EXPIRED'], 'PLANNED',
    { prepared: superseded.length ? { kind: 'EVM_WALLET_BATCH', superseded } : null, validUntil: null, code: null }) ?? refuse('WORKFLOW_RUN_CHANGED');
  if (!rewrite && g.state !== 'PLANNED') refuse(`WORKFLOW_RUN_GROUP_${g.state}`);
  const due = run.currentStep === g.stepFrom;
  if (g.signing === 'WHEN_DUE' && !due) refuse('WORKFLOW_RUN_GROUP_NOT_DUE');
  // Only a user operation can be signed before it is due: FloFi relays it itself, when due. A wallet batch is SENT by the wallet the moment the
  // owner confirms (it would run out of order), and a Solana transaction's blockhash would expire long before its turn.
  if (!due && g.strategy !== 'EVM_USER_OPERATION') refuse('WORKFLOW_RUN_GROUP_NOT_DUE');
  const fresh = composeWorkflowBound(run.strategy, run.workflowHash);
  if (!fresh.ok) return refuse('WORKFLOW_RUN_STALE');
  const composed: WorkflowComposition = fresh;
  // A permanent refusal of a due group halts the run (resume or end), never leaves it waiting on a group that cannot be prepared — but only a
  // group never handed to a wallet: an earlier batch of it may still be sent (or have been sent, its answer lost), so that group stays offered.
  const blockable = due && !rewrite && g.prepared === null;
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
    if (available <= 0n) return blockable ? blockDueGroup(deps, run, g, 'WORKFLOW_BINDING_NOTHING_RECEIVED') : refuse('WORKFLOW_BINDING_NOTHING_RECEIVED');
    if (!guaranteed.has(b.amountFrom)) guaranteed.set(b.amountFrom, { asset, amount: available.toString() });
    if (g.namespace === 'solana') {
      const left = available - (allocated.get(share) ?? 0n);
      if (left <= 0n) return blockable ? blockDueGroup(deps, run, g, 'WORKFLOW_BINDING_NOTHING_RECEIVED') : refuse('WORKFLOW_BINDING_NOTHING_RECEIVED');
      const used = left < BigInt(b.cap) ? left : BigInt(b.cap);
      allocated.set(share, (allocated.get(share) ?? 0n) + used);
      const alone = composeWorkflowBound(boundStrategy(composed.steps[b.step]!.strategy, used, b.asset.decimals, b.inputAsset), undefined);
      if (!alone.ok || alone.steps.length !== 1) return refuse('WORKFLOW_STEP_STALE');
      composition = { ...composition, steps: composition.steps.map((c, i) => i === b.step ? alone.steps[0]! : c) };
    }
  }
  const req = requirementOf(composition);
  if (!req.ok) return refuse(req.code);
  // Final review (P1): every step of the group passes its own gates and review AGAIN now, exactly as a confirm-mode step does before it becomes
  // READY (runner.ts): a flow whose execution the operator turned off, or a policy that changed, after the run started is honored when its
  // group is prepared — FloFi never hands out a new wallet request, nor prepares what it would relay, for a step its own flow refuses today.
  const policy = deps.policyFor(run.requester.kind);
  for (let i = g.stepFrom; i <= g.stepTo; i++) {
    const step = composition.steps[i] ?? refuse('WORKFLOW_STEP_STALE');
    const gates = await evaluateGates(step, deps.runtime, policy);
    if (!gates.handoff.allowed) return refuse(gates.handoff.reason ?? 'WORKFLOW_STEP_NOT_EXECUTABLE');
    if (handoffFindings(step).blockers.length) return refuse('REVIEW_BLOCKED');
  }
  const r = await prepareGroup(userFunded, composition, req.value, { runId: run.runId, groupIndex, strategy: g.strategy, chain: g.chain, feePayer: g.feePayer,
    stepFrom: g.stepFrom, stepTo: g.stepTo }, { guaranteed, delayed: g.awaitsDelivery !== null && !due });
  if (!r.ok) return blockable && PERMANENT_DUE_REFUSALS.has(r.code.split(':')[0]!) ? blockDueGroup(deps, run, g, r.code) : refuse(r.code);
  // The exact validity, for the same reason (the preparation's own clock moved on while it read the chain). Nothing is stored or handed out.
  if (g.strategy !== 'EVM_USER_OPERATION' && r.value.validUntil >= run.expiresAt) return refuse('WORKFLOW_RUN_EXPIRED');
  // The browser that holds the batch keeps its token across preparations; a first preparation (or one stored before the rule) gets a new one.
  const token = batch ? rewrite && handout !== undefined && HANDOUT.test(handout) ? handout : randomBytes(32).toString('base64url') : null;
  const prepared: Prepared = { ...r.value.prepared, ...superseded.length ? { superseded } : {}, ...token ? { handoutHash: handoutHashOf(token) } : {} };
  const moved = (rewrite
    ? await deps.store.groupTransition(run.runId, groupIndex, ['PREPARED'], 'PREPARED', { prepared, validUntil: r.value.validUntil, code: null }, 'GROUP_PREPARED_AGAIN', rewrite.version)
    : await deps.store.groupTransition(run.runId, groupIndex, ['PLANNED'], 'PREPARED', { prepared, validUntil: r.value.validUntil, code: null }))
    ?? refuse('WORKFLOW_RUN_CHANGED');
  return { groupIndex, strategy: moved.strategy, chain: moved.chain, feePayer: moved.feePayer, validUntil: r.value.validUntil.toISOString(),
    prepared: publicPrepared(prepared), handout: token };
}
/**
 * The owner's wallet answered for one PREPARED group: a wallet batch id, a user-operation signature, or the signed Solana transactions. Verified
 * against the frozen prepared artifact (signer = the group's fee payer = the run's wallet), then the run advances (submits what is due). A batch
 * answered for a group FloFi stopped while that batch was unanswered is refused WALLET_BATCH_ANSWERED_AFTER_STOP and logged (`batchAnsweredAfterStop`).
 */
export async function authorizeUserFundedGroup(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[], groupIndex: number, answer: OwnerAnswer): Promise<RunRecord> {
  assertRunWallets(run, wallets);
  if (run.mode !== 'USER_FUNDED') refuse('WORKFLOW_RUN_NOT_USER_FUNDED');
  const g = (await deps.store.groups(run.runId))[groupIndex] ?? refuse('WORKFLOW_RUN_GROUP_NOT_FOUND');
  if (answeredOnce(g)) return answeredAgain(deps, run, g, answer);
  if (stoppedUnanswered(g)) {
    const verified = authorizeGroup(g.prepared as Prepared, answer, g.feePayer, deps.now());
    if (!verified.ok) return refuse(verified.code);
    return batchAnsweredAfterStop(deps, run, g, { batchId: String(verified.value.batchId) });
  }
  if (g.state !== 'PREPARED') refuse(`WORKFLOW_RUN_GROUP_${g.state}`);
  // A wallet batch's answer arrives AFTER the wallet sent it: refusing a late one would only lose track of a batch already on chain (the chain
  // decides at reconciliation). Every other artifact is still unsigned or unsent here, so its validity window applies.
  if (g.strategy !== 'EVM_WALLET_BATCH' && (!g.validUntil || g.validUntil <= deps.now())) refuse('USER_FUNDED_PREPARED_EXPIRED');
  const verified = authorizeGroup(g.prepared as Prepared, answer, g.feePayer, deps.now());
  if (!verified.ok) return refuse(verified.code);
  // Only onto exactly the artifact the answer was verified against (the row version read above): a concurrent re-preparation is never authorized
  // with an answer checked against another artifact. A concurrent answer that won (a retry racing its first attempt) is compared as a retry.
  // A stop that landed in between (the expiry pass blocked the group, or the owner ended the run, while its batch was unanswered) never drops
  // this answer silently behind WORKFLOW_RUN_CHANGED: it is refused and logged as an answer after the stop, exactly as when it is read stopped.
  const authorized = await deps.store.groupTransition(run.runId, groupIndex, ['PREPARED'], 'AUTHORIZED', { authorization: verified.value }, 'GROUP_AUTHORIZED', g.version);
  if (!authorized) {
    const latest = (await deps.store.groups(run.runId))[groupIndex];
    if (latest && answeredOnce(latest)) return answeredAgain(deps, run, latest, answer);
    if (latest && g.strategy === 'EVM_WALLET_BATCH' && stoppedUnanswered(latest))
      return batchAnsweredAfterStop(deps, run, latest, { batchId: String(verified.value.batchId) });
    return refuse('WORKFLOW_RUN_CHANGED');
  }
  await advanceRun(runnerDeps(deps), run.runId);
  return (await deps.store.byId(run.runId))!;
}
const ANSWERED: readonly string[] = ['AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'RECONCILED'];
/**
 * Whether an answer for this group was already recorded: it is in an answered state, or it is a wallet batch that carries its recorded answer in
 * any later state (FAILED on chain, BLOCKED after the wallet said it was not sent, SKIPPED when the run ended): a new answer for it is compared.
 */
const answeredOnce = (g: GroupRecord) => ANSWERED.includes(g.state) || (g.strategy === 'EVM_WALLET_BATCH' && g.authorization !== null);
/**
 * A retried answer for a group already answered (its first response was lost) changes nothing — when it is the SAME answer. A wallet batch
 * answered under a DIFFERENT id than the one recorded may be a second execution of the group (another device or wallet instance, which shares
 * no EIP-5792 id dedupe): it is refused and logged, never recorded or acknowledged as the recorded one — in EVERY state its recorded answer is
 * kept in, so a group that failed or was stopped never hides a second batch behind its state's refusal. The same answer for a group no longer
 * waiting on its wallet (FAILED, BLOCKED, SKIPPED) is still refused with that state, as before.
 */
async function answeredAgain(deps: WorkflowRunDeps, run: RunRecord, g: GroupRecord, answer: OwnerAnswer): Promise<RunRecord> {
  if (g.strategy === 'EVM_WALLET_BATCH') {
    const again = authorizeGroup(g.prepared as Prepared, answer, g.feePayer, deps.now());
    if (!again.ok) return refuse(again.code);
    if (again.value.batchId !== g.authorization?.batchId) return batchAnswerMismatch(deps, run, g, 'BATCH_ID');
  }
  if (!ANSWERED.includes(g.state)) return refuse(`WORKFLOW_RUN_GROUP_${g.state}`);
  return (await deps.store.byId(run.runId))!;
}
function batchAnswerMismatch(deps: WorkflowRunDeps, run: RunRecord, g: GroupRecord, differs: 'BATCH_ID' | 'HASHES'): never {
  deps.log('workflow_run.batch_answer_mismatch', { run: run.runId, group: g.groupIndex, state: g.state, differs });
  return refuse('WALLET_BATCH_ANSWER_MISMATCH');
}
/**
 * A wallet batch group FloFi already stopped while the batch it handed out was unanswered (`walletBatchUnanswered`): BLOCKED at the run's expiry
 * or SKIPPED when the run ended, both marked WALLET_BATCH_OUTCOME_UNKNOWN. An answer the owner's browser reports for it now cannot be recorded
 * (the group is closed: the run stopped, and a skipped group never changes again), yet it says the batch may well have executed.
 */
const stoppedUnanswered = (g: GroupRecord) => (g.state === 'BLOCKED' || g.state === 'SKIPPED') && g.code === WALLET_BATCH_OUTCOME_UNKNOWN && walletBatchUnanswered(g);
/**
 * The owner's browser answered (a batch id, its transactions, or the wallet's "not sent") for a group stopped while its batch was unanswered:
 * never dropped silently behind the group's state. Nothing is recorded; the answer is logged (whether its batch id is the one FloFi handed out,
 * how many transactions it reported) and refused WALLET_BATCH_ANSWERED_AFTER_STOP, so the owner is told the batch may have executed and to check
 * the wallet's activity.
 */
function batchAnsweredAfterStop(deps: WorkflowRunDeps, run: RunRecord, g: GroupRecord,
  answer: { readonly batchId?: string; readonly hashes?: number; readonly notSent?: boolean }): never {
  // Every preparation of a group carries the same EIP-5792 id (`walletBatchId`); a group that kept only earlier preparations has no request of its own.
  const requested = (g.prepared as { request?: { id?: unknown } } | null)?.request?.id;
  const handedOut = typeof requested === 'string' ? requested : walletBatchId(run.runId, g.groupIndex);
  deps.log('workflow_run.batch_answer_after_stop', { run: run.runId, group: g.groupIndex, state: g.state,
    batchIdMatches: answer.batchId === undefined ? null : answer.batchId.toLowerCase() === handedOut.toLowerCase(), hashes: answer.hashes ?? null,
    notSent: answer.notSent ?? null });
  return refuse('WALLET_BATCH_ANSWERED_AFTER_STOP');
}
/**
 * The owner's browser reports the transactions of a wallet batch (from `wallet_getCallsStatus`): only the hashes are taken; the chain decides.
 * `notSent`: the wallet reported the batch failed OFF chain (EIP-5792 status 400, no receipt): nothing was sent, so the group stops before
 * anything ran (BLOCKED) and the owner decides (end the run, or resume it). Either report for a group FloFi stopped while its batch was
 * unanswered is refused WALLET_BATCH_ANSWERED_AFTER_STOP and logged, never recorded (`batchAnsweredAfterStop`).
 */
export async function reportUserFundedBatch(deps: WorkflowRunDeps, run: RunRecord, wallets: readonly WalletRef[], groupIndex: number, hashes: readonly string[],
  notSent = false): Promise<RunRecord> {
  assertRunWallets(run, wallets);
  const groups = await deps.store.groups(run.runId);
  const g = groups[groupIndex] ?? refuse('WORKFLOW_RUN_GROUP_NOT_FOUND');
  if (g.strategy !== 'EVM_WALLET_BATCH') refuse('WORKFLOW_RUN_GROUP_NOT_BATCH');
  if (notSent === true) {
    if (stoppedUnanswered(g)) return batchAnsweredAfterStop(deps, run, g, { hashes: 0, notSent: true });
    if (g.state !== 'AUTHORIZED') refuse(`WORKFLOW_RUN_GROUP_${g.state}`);
    // Only the report whose write moved exactly the AUTHORIZED group this report read (its row version) stops its steps and the run. A concurrent
    // report of its transactions that won (SUBMITTED: they are on their way and must be reconciled) is never followed by blocked steps and a
    // terminal run that nothing would reconcile any more: this report is refused instead, and the browser reads the run again.
    // (Never a stop it lost to: a group read AUTHORIZED keeps its recorded answer in every later state — frozen by the schema — so it is never
    // `stoppedUnanswered`; the same holds for the transactions' write below.)
    if (!await deps.store.groupTransition(run.runId, groupIndex, ['AUTHORIZED'], 'BLOCKED', { code: 'EIP5792_BATCH_NOT_SENT' }, 'GROUP_STATE', g.version))
      return refuse('WORKFLOW_RUN_CHANGED');
    for (let i = g.stepFrom; i <= g.stepTo; i++) await deps.store.stepTransition(run.runId, i, ['DELEGATED'], 'BLOCKED', { code: 'EIP5792_BATCH_NOT_SENT' });
    const partial = (await deps.store.steps(run.runId)).some(s => s.stepIndex < g.stepFrom && s.state === 'RECONCILED');
    // From the run's CURRENT version (a status poll may have moved it since the caller read it), as `blockDueGroup` does.
    await stopRunFromCurrent(deps, run.runId, partial ? 'HALTED' : 'FAILED', 'EIP5792_BATCH_NOT_SENT');
    return (await deps.store.byId(run.runId))!;
  }
  if (!Array.isArray(hashes) || !hashes.length || hashes.length > 8 || hashes.some(h => typeof h !== 'string' || !/^0x[0-9a-f]{64}$/.test(h.toLowerCase()))) refuse('EIP5792_RESPONSE_INVALID');
  // A transaction already counted for another group of this run can never reconcile this one.
  const used = new Set(groups.filter(x => x.groupIndex !== groupIndex).flatMap(x => (x.submission as { hashes?: string[] } | null)?.hashes ?? []));
  if (hashes.some(h => used.has(h.toLowerCase()))) refuse('EIP5792_RESPONSE_INVALID');
  // One transaction reported twice is still one transaction (a wallet may repeat a receipt): never counted twice against the batch's calls.
  const reported = [...new Set(hashes.map(h => h.toLowerCase()))];
  if (stoppedUnanswered(g)) return batchAnsweredAfterStop(deps, run, g, { hashes: reported.length, notSent: false });
  const current = g.state !== 'AUTHORIZED' ? g : await deps.store.groupTransition(run.runId, groupIndex, ['AUTHORIZED'], 'SUBMITTED', { submission: { kind: 'EVM_WALLET_BATCH',
    batchId: String(g.authorization?.batchId ?? ''), hashes: reported, submittedAt: deps.now().toISOString() } }) ?? (await deps.store.groups(run.runId))[groupIndex]!;
  // A report for a group already answered (a retry, a concurrent report that won, or a group that since FAILED on chain, was BLOCKED because the
  // wallet said it was not sent, or SKIPPED) changes nothing — when its transactions are the SAME ones as recorded (none, for a batch the wallet
  // said it did not send). Different hashes under one group may be a second execution of it: refused and logged in every state, never recorded,
  // acknowledged silently or hidden behind the state's own refusal.
  if (current.state !== 'AUTHORIZED' && (current.authorization !== null || current.submission !== null)) {
    const recorded = [...(current.submission as { hashes?: readonly string[] } | null)?.hashes ?? []].sort().join();
    if (recorded !== [...reported].sort().join()) batchAnswerMismatch(deps, run, current, 'HASHES');
  }
  if (current.state !== 'SUBMITTED' && current.state !== 'UNCERTAIN' && current.state !== 'RECONCILED') refuse(`WORKFLOW_RUN_GROUP_${current.state}`);
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
  /**
   * P0 universal execution: how a HALTED run stopped (null otherwise): PARTIAL once a step reconciled; NOTHING_SENT only when its records prove
   * nothing reached a chain (a first due group refused for good); else STOPPED, which claims neither progress nor that nothing was sent.
   */
  readonly halted: 'PARTIAL' | 'NOTHING_SENT' | 'STOPPED' | null;
  /** Whether the server would accept Resume now (`resumeRefusal`: HALTED, inside its window, the stopped step or unsigned group resumable). */
  readonly resumable: boolean;
  readonly authority: 'NONE'; readonly note: string | null };
export type RunGroupView = { readonly index: number; readonly chain: string; readonly strategy: string; readonly signing: string; readonly steps: readonly [number, number];
  readonly state: string; readonly awaitsDelivery: number | null; readonly code: string | null; readonly validUntil: string | null;
  /** Always the run's own wallet on this network (S1). */
  readonly feePayer: string;
  /** The most this group can cost its owner in network fees (native units of `unit`), from the prepared artifact; null until prepared. */
  readonly maxFee: { readonly amount: string; readonly unit: string; readonly estimated: boolean; readonly sponsorship?: 'OFFERED' | 'REQUIRED' } | null;
  /** Network fees actually paid, from the chain (null until reconciled). */
  readonly gasPaid: { readonly amount: string; readonly unit: string; readonly payer: string; readonly sponsored?: true } | null;
  /** Transactions of the group (public hashes / signatures only, never bytes): what was sent and reconciled. Named like a step's `submissions`. */
  readonly submissions: readonly { readonly chain: string; readonly hash: string; readonly explorerUrl: string | null }[];
  /** A wallet batch's id (the owner's own wallet's handle, to read its receipts back after a reload); the owner's own view only, else null. */
  readonly batchId: string | null;
  /** Whether the owner already signed/answered this group (a signed user operation stays valid on chain until its nonce key is used). */
  readonly signed: boolean;
  /**
   * P0 workflow execution: what the prepared group does, per step, as the owner reads it before (and while) the wallet is asked — what each step
   * spends, a swap's quoted output and signed minimum, a borrow's exact delivery — plus the whole-batch simulation's Aave health factor after it.
   * The owner's own view only (a requester never sees amounts it was not shared), null until prepared.
   */
  readonly planned: { readonly steps: readonly ({ readonly index: number } & PlannedStep)[]; readonly calls: number; readonly approvals: number;
    readonly healthFactorAfter: string | null } | null;
  /**
   * P0 hotfix (E1): the delivery of the bridge step this group deposited, once its source side reconciled (null otherwise): AWAITING_DESTINATION
   * until the Across fill on `chain` is verified and final, NOT_OBSERVED past its fill deadline (observed again, never resent), DELIVERED,
   * REFUNDED. The fill's transaction only with shared status.
   */
  readonly delivery?: { readonly step: number; readonly chain: string; readonly state: BridgeDeliveryState;
    readonly fill: { readonly hash: string; readonly explorerUrl: string | null } | null } | null };

/**
 * Whether the run's own records PROVE nothing of it was ever sent: no step that may have reached a chain (`MAYBE_SUBMITTED`; in a user-funded run
 * a DELEGATED step only waits for its group), no group submitted, reconciled or failed, and no wallet batch ever handed to the owner's wallet (its
 * prepared artifact or batch id stays on the group: the wallet may have sent it). A user operation or Solana transactions signed but never
 * relayed by FloFi were not sent.
 */
function provenNothingSent(run: RunRecord, steps: readonly RunStepRecord[], groups: readonly GroupRecord[]): boolean {
  return !steps.some(s => MAYBE_SUBMITTED.includes(s.state) && !(run.mode === 'USER_FUNDED' && s.state === 'DELEGATED'))
    && !groups.some(g => ['SUBMITTED', 'UNCERTAIN', 'RECONCILED', 'FAILED'].includes(g.state)
      || (g.strategy === 'EVM_WALLET_BATCH' && (g.prepared !== null || g.authorization !== null)));
}
/**
 * The public status of a run. `outcomes` false (a requester the owner did not share status with) keeps every step's state but withholds its
 * transactions, amounts and evidence. Nothing returned is a key, calldata or a signature, and nothing here authorizes anything.
 */
/**
 * `owner`: the run's proven owner (the approval page). Any other reader is a requester: it never sees the owner's wallet address, batch id or
 * fee figures, even when the owner shares status (which shares step states, transaction hashes, amounts and evidence).
 */
export async function runView(deps: { readonly store: Pick<WorkflowRunStore, 'steps' | 'groups'>; readonly now?: () => Date }, run: RunRecord,
  options: { readonly outcomes: boolean; readonly origin?: string | null; readonly owner?: boolean }): Promise<RunView> {
  const owner = options.owner === true;
  const steps = await deps.store.steps(run.runId);
  const groupRecords = run.mode === 'USER_FUNDED' ? await deps.store.groups(run.runId) : [];
  const composed = composeWorkflowBound(run.strategy, run.workflowHash);
  const requirement = composed.ok && groupRecords.length ? requirementOf(composed) : null;
  const plannedOf = (g: GroupRecord): RunGroupView['planned'] => {
    const p = g.prepared as { group?: EvmGroupCalls; simulation?: { healthFactorAfter?: Readonly<Record<string, string>> } | null } | null;
    if (!p?.group || !requirement?.ok) return null;
    // A batch that reconciled against an earlier preparation shows what that one was signed for (the newer artifact never ran).
    const from = (g.outcome as { preparedFrom?: { steps: EvmGroupCalls['steps']; calls: number; approvals: number } } | null)?.preparedFrom;
    const shown = from ? { ...p.group, steps: from.steps } : p.group;
    return { steps: [...plannedSteps(requirement.value, shown)].map(([index, values]) => ({ index, ...values })), calls: from?.calls ?? p.group.calls.length,
      approvals: from?.approvals ?? p.group.calls.filter(c => c.kind === 'ERC20_APPROVE').length,
      healthFactorAfter: from ? null : Object.values(p.simulation?.healthFactorAfter ?? {})[0] ?? null };
  };
  const deliveryOf = (g: GroupRecord): NonNullable<RunGroupView['delivery']> | null => {
    const b = bridgeProgressOf(g.outcome);
    return b ? { step: b.step, chain: b.destinationChain, state: presentedDeliveryState(g, b.state),
      fill: options.outcomes && b.fill ? { hash: b.fill.transactionHash, explorerUrl: executionExplorer(b.destinationChain, b.fill.transactionHash, false) } : null } : null;
  };
  const groups: RunGroupView[] = groupRecords.map(g => {
    const fee = (g.prepared as { fee?: { maxCost?: string; unit?: string; estimated?: boolean; sponsorship?: 'OFFERED' | 'REQUIRED' | null } } | null)?.fee;
    const paid = (g.outcome as { gasPaid?: { amount: string; unit: string; payer: string; sponsored?: boolean } } | null)?.gasPaid ?? null;
    // Reconciled transactions first; before that, what was sent (a Solana group's signatures are known before sending: listed only once reconciled).
    // An owner-step group's outcome lists its steps' own {chain, hash} records; a relayed group lists hashes on its own chain.
    const recorded = (g.outcome as { transactions?: readonly unknown[] } | null)?.transactions
      ?? (g.strategy === 'SOLANA_SIGN_ALL' ? [] : (g.submission as { hashes?: readonly unknown[] } | null)?.hashes ?? []);
    const submissions = !options.outcomes ? [] : recorded.flatMap(t => {
      const entry = typeof t === 'string' ? { chain: g.chain, hash: t } : t && typeof t === 'object' && typeof (t as { hash?: unknown }).hash === 'string'
        ? { chain: typeof (t as { chain?: unknown }).chain === 'string' ? (t as { chain: string }).chain : g.chain, hash: (t as { hash: string }).hash } : null;
      return entry ? [{ ...entry, explorerUrl: executionExplorer(entry.chain, entry.hash, false) }] : [];
    });
    return { index: g.groupIndex, chain: g.chain, strategy: g.strategy, signing: g.signing, steps: [g.stepFrom, g.stepTo] as const, state: g.state, awaitsDelivery: g.awaitsDelivery,
      // Requesters see that the owner's wallet pays, never which wallet, its batch id or its fees; shared status adds hashes and the gas amount.
      code: g.code, validUntil: g.validUntil?.toISOString() ?? null, feePayer: owner ? g.feePayer : 'OWNER_WALLET',
      maxFee: owner && fee?.maxCost && fee.unit ? { amount: fee.maxCost, unit: fee.unit, estimated: fee.estimated !== false, ...fee.sponsorship ? { sponsorship: fee.sponsorship } : {} } : null,
      // ADR-0009: a fee FloFi's paymaster paid is shown as such (to the owner, its paymaster address; never the owner's wallet).
      gasPaid: options.outcomes && paid ? { amount: paid.amount, unit: paid.unit, payer: owner ? paid.payer : paid.sponsored ? 'FLOFI_PAYMASTER' : 'OWNER_WALLET',
        ...paid.sponsored ? { sponsored: true as const } : {} } : null,
      submissions,
      batchId: owner && g.strategy === 'EVM_WALLET_BATCH' ? typeof g.authorization?.batchId === 'string' ? g.authorization.batchId
        : g.state === 'PREPARED' ? String((g.prepared as { request?: { id?: string } } | null)?.request?.id ?? '') || null : null : null,
      signed: g.authorization !== null, planned: owner ? plannedOf(g) : null, delivery: deliveryOf(g) };
  });
  const views: RunStepView[] = steps.map(s => {
    const local = s.outcome?.evidence?.environment === 'MOCKED';
    const outcome = options.outcomes && s.outcome ? { executionId: s.outcome.executionId, kind: s.outcome.kind, status: s.outcome.status, evidence: s.outcome.evidence,
      submissions: s.outcome.transactions.map(t => ({ chain: t.chain, hash: t.hash, explorerUrl: executionExplorer(t.chain, t.hash, local) })),
      spent: s.outcome.spent, received: s.outcome.received,
      receiptUrl: options.origin && s.outcome.kind === 'OWNER_RUN' && s.state === 'RECONCILED' ? `${options.origin}/app/dashboard/runs/${encodeURIComponent(s.outcome.executionId)}` : null } : null;
    return { index: s.stepIndex, action: composed.ok ? composed.steps[s.stepIndex]?.strategy.action ?? 'unknown' : 'unknown', state: s.state, flow: s.flow,
      // A bound step's own hash encodes the amount it resolved to: withheld with the amounts when status is not shared.
      stepWorkflowHash: options.outcomes || !s.bound ? s.workflowHash : null, code: s.code, bound: options.outcomes ? s.bound : null, outcome };
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
  // A HALTED run is a partial completion only when a step reconciled. One whose first due group was refused for good stopped before anything
  // ran (blockDueGroup): it says so only when its own records prove nothing was sent, and never claims progress it did not make.
  // Decided here from the records every viewer depends on (a requester's view hides batch ids and plans): the Editor, /approve and the
  // channels word a HALTED run from this, never from what their own view happens to show.
  const halted = run.state !== 'HALTED' ? null : steps.some(s => s.state === 'RECONCILED') ? 'PARTIAL' as const
    : provenNothingSent(run, steps, groupRecords) ? 'NOTHING_SENT' as const : 'STOPPED' as const;
  // A PARTIAL run never claims nothing later was sent: a later step or group may have been submitted and failed on chain (its own outcome says).
  // A run stopped (at its expiry: user-funded-pass.ts) or ended while a wallet batch it handed out was never answered says that batch may have
  // executed (`walletBatchUnanswered`): never "stopped before any step completed" or "nothing was sent", which its records cannot prove.
  const unanswered = (run.state === 'CANCELLED' || run.state === 'HALTED')
    && (groupRecords.some(g => g.code === WALLET_BATCH_OUTCOME_UNKNOWN) || steps.some(s => s.code === WALLET_BATCH_OUTCOME_UNKNOWN));
  // "Never recorded", never "never reached FloFi": an answer may have arrived after the stop, been refused and logged
  // (WALLET_BATCH_ANSWERED_AFTER_STOP, `batchAnsweredAfterStop`).
  const mayHaveExecuted = 'A batch was handed to the owner\'s wallet and FloFi never recorded an answer for it: it may have executed before its on-chain '
    + 'deadline; check the wallet\'s activity.';
  const note = !options.outcomes ? 'The owner has not shared the transactions and evidence of this workflow with this conversation.'
    : halted === 'PARTIAL' && unanswered ? `Partially completed: the reconciled steps stay done. ${mayHaveExecuted} FloFi submits nothing more of it; the owner decides `
      + 'what happens next.'
      : halted === 'PARTIAL' ? 'Partially completed: the reconciled steps stay done and their funds rest in the owner\'s wallet. See the step that stopped for its outcome.'
        : halted !== null && unanswered ? `Stopped. ${mayHaveExecuted} FloFi submits nothing more of it; the owner decides what happens next.`
          : halted === 'NOTHING_SENT' ? 'Stopped before anything was sent. Until the run expires the owner can resume it (each stopped step then runs through its own flow); '
            + 'the owner can always end it.'
            : halted === 'STOPPED' ? 'Stopped before any step completed. FloFi submits nothing more of it; the owner decides what happens next.'
              : run.state === 'ATTENTION' ? 'A submitted step has no final outcome yet. FloFi keeps observing it and never resubmits it.'
                : unanswered ? `Ended. ${mayHaveExecuted}` : null;
  const resumable = resumeRefusal(run, steps, groupRecords, deps.now?.() ?? new Date()) === null;
  return { workflowRunId: run.runId, approvalId: run.handoffId, state: run.state, mode: run.mode, stepCount: run.stepCount, currentStep: run.currentStep, code: run.code,
    workflowHash: run.workflowHash, expiresAt: run.expiresAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null, createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(), stepsVisible: options.outcomes, steps: views, nextAction, groups, halted, resumable, authority: 'NONE', note };
}
