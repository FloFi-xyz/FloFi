// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: how many separate authorizations a workflow needs, in each mode, BEFORE anything executes. Pure: a function of the
 * canonical workflow, the deployment facts and (once the owner proved a wallet) the owner's delegated grants.
 *
 *   CONFIRM_EACH_STEP               every step is an ordinary run of its own flow: a fresh simulation, the Review and the owner's wallet
 *                                   confirmation per step (a flow may ask for more, e.g. a token approval before a swap)
 *   DELEGATED_SINGLE_AUTHORIZATION  BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: ONE wallet authorization for the whole workflow — the
 *                                   owner's EIP-712 signature of one exact workflow grant per EVM chain (`delegation/workflow-grants.ts`): exactly
 *                                   this run's calls, each usable once, enforced on-chain. No reusable Credential and no passkey. One-time setup:
 *                                   the wallet's own MetaMask smart-account (EIP-7702) upgrade. Available only when every step is
 *                                   delegation-capable and EVM, every dependent amount has an on-chain guarantee on the same chain, and this
 *                                   deployment can sign delegated steps
 *
 * One authorization is not one transaction and not zero gas: each step still submits its own transactions and pays its own network fees.
 * A workflow whose steps are only partly delegable runs in CONFIRM_EACH_STEP; modes are never mixed within one run.
 */
import { resolveAuthorityGraph, type GrantView } from '../delegation/authority.ts';
import { stepCapability, type CapabilityMode, type Mechanism } from '../delegation/capabilities.ts';
import { requirementOf } from '../delegation/steps.ts';
import { NETWORKS, type WorkflowComposition } from '../engine/strategy-engine';
import type { Gates } from '../mcp/execution.ts';

/** The deployment's delegated-execution facts (null: delegation is not enabled on this deployment). */
/** `mainnetChains`: public mainnets the deployment opted into delegated templates (BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001); absent or empty: none. */
export type DelegationFacts = { readonly mode: CapabilityMode; readonly unavailable: string | null; readonly mainnetChains?: readonly string[] } | null;
export type StepAuthorization = {
  readonly index: number; readonly action: string; readonly network: string; readonly flow: string | null;
  readonly ownerExecution: { readonly supported: boolean; readonly enabled: boolean; readonly reason: string | null };
  readonly delegation: { readonly capable: boolean; readonly mechanism: Mechanism | null; readonly code: string | null; readonly grantId: string | null;
    readonly coverage: string | null };
};
export type AuthorizationPlan = {
  readonly stepCount: number;
  readonly confirmEachStep: { readonly available: boolean; readonly reason: string | null; readonly walletConfirmationsAtLeast: number;
    readonly walletNamespaces: readonly ('eip155' | 'solana')[] };
  /** `walletSignatures`: one EIP-712 signature per EVM chain, all requested together before anything executes; `passkeyAssertions`: none. */
  readonly delegatedSingleAuthorization: { readonly available: boolean; readonly reason: string | null; readonly walletSignatures: number; readonly passkeyAssertions: 0;
    /** One-time setup per chain: the wallet's MetaMask EIP-7702 smart account (`active` is unknown until the wallet signs). */
    readonly enrollments: readonly { readonly chain: string; readonly network: string; readonly mechanism: Mechanism; readonly active: boolean | null }[];
    readonly ownerKnown: boolean };
  readonly recommended: 'DELEGATED_SINGLE_AUTHORIZATION' | 'CONFIRM_EACH_STEP' | null;
  readonly steps: readonly StepAuthorization[];
  readonly bindings: readonly { readonly step: number; readonly amountFrom: number; readonly confirmEachStep: 'RECONCILED_RECEIVED_AMOUNT';
    /** Delegated: the producer's on-chain guaranteed output (a swap's signed minimum), fixed when the owner signs; any surplus stays in the wallet. */
    readonly delegated: 'SIGNED_GUARANTEED_MINIMUM' }[];
  readonly notes: readonly string[];
};
/**
 * Whether a delegated run of this workflow is possible on this deployment by code alone (owner-independent): delegation enabled with a signer,
 * and every step delegation-capable. The owner's grants decide the rest at `/approve`, after the wallet proof.
 */
export function delegableByCode(workflow: WorkflowComposition, delegation: DelegationFacts): { readonly ok: boolean; readonly code: string | null } {
  if (!delegation) return { ok: false, code: 'DELEGATION_NOT_ENABLED' };
  if (delegation.unavailable) return { ok: false, code: delegation.unavailable };
  const req = requirementOf(workflow);
  if (!req.ok) return { ok: false, code: req.code };
  for (const step of req.value.steps) { const c = stepCapability(step, delegation.mode, delegation.mainnetChains); if (!c.ok) return { ok: false, code: c.code }; }
  return { ok: true, code: null };
}

/** The authorization plan of a composed workflow. `grants` (with `now`) are the proven owner's own grants; omit them before a wallet proof. */
export function authorizationPlan(workflow: WorkflowComposition, gates: Pick<Gates, 'supportedByCode' | 'enabledByDeployment' | 'enabledByPolicy' | 'handoff'> & { readonly plan: { readonly steps: readonly { readonly flow: string | null; readonly network: string; readonly action: string }[] } },
  delegation: DelegationFacts, owner?: { readonly grants: readonly GrantView[]; readonly now: number }): AuthorizationPlan {
  const perStep = gates.supportedByCode.steps;
  const req = requirementOf(workflow);
  const mode: CapabilityMode = delegation?.mode ?? 'PRODUCTION', mainnet = delegation?.mainnetChains ?? [];
  // Workflow grants are compiled per run at authorization: no owner grant has to exist beforehand.
  const graph = null as null | ReturnType<typeof resolveAuthorityGraph>;
  const steps: StepAuthorization[] = workflow.steps.map((c, index) => {
    const planStep = gates.plan.steps[index], facts = perStep?.[index];
    const ownerExecution = facts ? { supported: facts.execute, enabled: facts.deploymentEnabled, reason: facts.reason }
      : { supported: gates.supportedByCode.execute, enabled: gates.enabledByDeployment.enabled, reason: gates.supportedByCode.reason ?? gates.enabledByDeployment.reason };
    const requirement = req.ok ? req.value.steps[index] : undefined;
    const capability = requirement ? stepCapability(requirement, mode, mainnet) : null;
    const bound = graph?.bindings.find(b => b.stepIndex === index) ?? null, failure = graph && !graph.ok ? graph.failures.find(f => f.stepIndex === index) ?? null : null;
    return { index, action: c.strategy.action, network: planStep?.network ?? '', flow: planStep?.flow ?? null, ownerExecution,
      delegation: { capable: capability?.ok === true, mechanism: capability ? capability.mechanism : null, code: capability ? capability.ok ? null : capability.code
        : req.ok ? null : req.code, grantId: bound?.grantId ?? null, coverage: failure?.code ?? null } };
  });
  // A sequence reports each mode on its own (a delegated-only workflow is supported by code overall, yet not in confirm mode).
  const runsOff = gates.enabledByDeployment.reason === 'WORKFLOW_RUNS_NOT_ENABLED' ? 'WORKFLOW_RUNS_NOT_ENABLED' : null;
  const modes = gates.supportedByCode.modes;
  const confirmReason = modes ? runsOff ?? modes.confirmEachStep ?? gates.enabledByPolicy.reason
    : gates.supportedByCode.reason ?? gates.enabledByDeployment.reason ?? gates.enabledByPolicy.reason;
  const namespaces = [...new Set(steps.map(s => s.network.startsWith('solana') ? 'solana' as const : 'eip155' as const))].sort();
  // Every distinct chain a delegated run signs one workflow grant on (one-time setup there: the MetaMask EIP-7702 smart account).
  const enrollments = req.ok ? [...new Map(req.value.steps.flatMap(s => {
    const c = stepCapability(s, mode, mainnet);
    return c.mechanism ? [[`${s.chain}|${c.mechanism}`, { chain: s.chain, network: NETWORKS[s.network].label, mechanism: c.mechanism, active: null }]] as const : [];
  })).values()] : [];
  const notCapable = steps.find(s => !s.delegation.capable);
  // A dependent amount must have an on-chain guarantee on its own chain (a swap's signed minimum or a borrow's exact amount), never an estimate.
  const inexact = req.ok ? req.value.bindings.find(b => {
    const producer = req.value.steps[b.amountFrom], consumer = req.value.steps[b.step];
    return !producer || !consumer || producer.chain !== consumer.chain || !['swap', 'borrow'].includes(producer.action) || consumer.action === 'borrow';
  }) : undefined;
  const solana = req.ok && req.value.steps.some(s => s.namespace !== 'eip155');
  // What the grant planner would refuse anyway (delegation/workflow-grants.ts), reported before the owner opens the review.
  const steep = req.ok && req.value.steps.some(s => s.action === 'swap' && (s.slippageBps ?? 0) > 300);
  const callsPerChain = new Map<string, number>();
  if (req.ok) for (const s of req.value.steps) callsPerChain.set(s.chain, (callsPerChain.get(s.chain) ?? 0) + (s.action === 'borrow' ? 1 : 2));
  const crowded = [...callsPerChain.values()].some(n => n > 16);
  const delegatedReason = runsOff ?? (!delegation ? 'DELEGATION_NOT_ENABLED' : delegation.unavailable) ?? (notCapable ? notCapable.delegation.code ?? 'DELEGATED_AUTHORITY_UNAVAILABLE'
    : solana ? 'WORKFLOW_GRANT_NAMESPACE_UNSUPPORTED' : inexact ? 'WORKFLOW_BINDING_NOT_EXACT' : steep ? 'WORKFLOW_SLIPPAGE_UNSUPPORTED'
    : crowded ? 'WORKFLOW_GRANT_TOO_MANY_CALLS' : gates.enabledByPolicy.reason ?? null);
  const bindingCodes = workflow.bindings.map(b => ({ step: b.step, amountFrom: b.amountFrom, confirmEachStep: 'RECONCILED_RECEIVED_AMOUNT' as const,
    delegated: 'SIGNED_GUARANTEED_MINIMUM' as const }));
  const confirmAvailable = confirmReason === null, delegatedAvailable = delegatedReason === null;
  const notes = ['One authorization is not one transaction: every step still submits its own transactions and pays its own network fees.',
    'Each step starts only after the previous step reconciled on chain.'];
  if (namespaces.length > 1) notes.push('This workflow uses an EVM wallet and a Solana wallet: both must be proven before it starts.');
  if (bindingCodes.length) notes.push('Confirm each step: a dependent step spends what an earlier step actually delivered (after reconciliation), capped by its own amount. '
    + 'Authorize once: it spends the earlier step\'s signed guaranteed minimum, fixed when you sign; anything received above it stays in your wallet.');
  return { stepCount: workflow.steps.length,
    confirmEachStep: { available: confirmAvailable, reason: confirmReason, walletConfirmationsAtLeast: workflow.steps.length, walletNamespaces: namespaces },
    delegatedSingleAuthorization: { available: delegatedAvailable, reason: delegatedReason, walletSignatures: Math.max(1, enrollments.length), passkeyAssertions: 0, enrollments,
      ownerKnown: owner !== undefined },
    recommended: delegatedAvailable && owner ? 'DELEGATED_SINGLE_AUTHORIZATION' : confirmAvailable ? 'CONFIRM_EACH_STEP' : delegatedAvailable ? 'DELEGATED_SINGLE_AUTHORIZATION' : null,
    steps, bindings: bindingCodes, notes };
}
