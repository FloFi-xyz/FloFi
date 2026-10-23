// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: how many separate authorizations a workflow needs, in each mode, BEFORE anything executes. Pure: a function of the
 * canonical workflow, the deployment facts and (once the owner proved a wallet) the owner's delegated grants.
 *
 *   CONFIRM_EACH_STEP               every step is an ordinary run of its own flow: a fresh simulation, the Review and the owner's wallet
 *                                   confirmation per step (a flow may ask for more, e.g. a token approval before a swap)
 *   DELEGATED_SINGLE_AUTHORIZATION  ONE passkey assertion over the Universal Workflow Authorization for the whole workflow, after the
 *                                   one-time enrollment of a Credential grant per chain (one wallet signature each, once). Available only when
 *                                   every step is delegation-capable, this deployment can sign delegated steps, and (for a known owner) every
 *                                   step resolves to an ACTIVE grant anchored to one passkey
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
export type DelegationFacts = { readonly mode: CapabilityMode; readonly unavailable: string | null } | null;
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
  readonly delegatedSingleAuthorization: { readonly available: boolean; readonly reason: string | null; readonly passkeyAssertions: 1;
    readonly enrollments: readonly { readonly chain: string; readonly network: string; readonly mechanism: Mechanism; readonly active: boolean | null }[];
    readonly ownerKnown: boolean };
  readonly recommended: 'DELEGATED_SINGLE_AUTHORIZATION' | 'CONFIRM_EACH_STEP' | null;
  readonly steps: readonly StepAuthorization[];
  readonly bindings: readonly { readonly step: number; readonly amountFrom: number; readonly confirmEachStep: 'DEPENDENT_AMOUNT_SOURCE_NOT_IMPLEMENTED';
    readonly delegated: 'RECONCILED_RECEIVED_AMOUNT' }[];
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
  for (const step of req.value.steps) { const c = stepCapability(step, delegation.mode); if (!c.ok) return { ok: false, code: c.code }; }
  return { ok: true, code: null };
}

/** The authorization plan of a composed workflow. `grants` (with `now`) are the proven owner's own grants; omit them before a wallet proof. */
export function authorizationPlan(workflow: WorkflowComposition, gates: Pick<Gates, 'supportedByCode' | 'enabledByDeployment' | 'enabledByPolicy' | 'handoff'> & { readonly plan: { readonly steps: readonly { readonly flow: string | null; readonly network: string; readonly action: string }[] } },
  delegation: DelegationFacts, owner?: { readonly grants: readonly GrantView[]; readonly now: number }): AuthorizationPlan {
  const perStep = gates.supportedByCode.steps;
  const req = requirementOf(workflow);
  const mode: CapabilityMode = delegation?.mode ?? 'PRODUCTION';
  const graph = req.ok && owner ? resolveAuthorityGraph(req.value, owner.grants, mode, owner.now) : null;
  const steps: StepAuthorization[] = workflow.steps.map((c, index) => {
    const planStep = gates.plan.steps[index], facts = perStep?.[index];
    const ownerExecution = facts ? { supported: facts.execute, enabled: facts.deploymentEnabled, reason: facts.reason }
      : { supported: gates.supportedByCode.execute, enabled: gates.enabledByDeployment.enabled, reason: gates.supportedByCode.reason ?? gates.enabledByDeployment.reason };
    const requirement = req.ok ? req.value.steps[index] : undefined;
    const capability = requirement ? stepCapability(requirement, mode) : null;
    const bound = graph?.bindings.find(b => b.stepIndex === index) ?? null, failure = graph && !graph.ok ? graph.failures.find(f => f.stepIndex === index) ?? null : null;
    return { index, action: c.strategy.action, network: planStep?.network ?? '', flow: planStep?.flow ?? null, ownerExecution,
      delegation: { capable: capability?.ok === true, mechanism: capability ? capability.mechanism : null, code: capability ? capability.ok ? null : capability.code
        : req.ok ? null : req.code, grantId: bound?.grantId ?? null, coverage: owner ? failure?.code ?? (bound ? null : 'DELEGATED_AUTHORITY_UNAVAILABLE') : null } };
  });
  // A sequence reports each mode on its own (a delegated-only workflow is supported by code overall, yet not in confirm mode).
  const runsOff = gates.enabledByDeployment.reason === 'WORKFLOW_RUNS_NOT_ENABLED' ? 'WORKFLOW_RUNS_NOT_ENABLED' : null;
  const modes = gates.supportedByCode.modes;
  const confirmReason = modes ? runsOff ?? modes.confirmEachStep ?? gates.enabledByPolicy.reason
    : gates.supportedByCode.reason ?? gates.enabledByDeployment.reason ?? gates.enabledByPolicy.reason;
  const namespaces = [...new Set(steps.map(s => s.network.startsWith('solana') ? 'solana' as const : 'eip155' as const))].sort();
  // Every distinct chain × mechanism a delegated run needs a grant for (one wallet signature each, once, in Credentials).
  const enrollments = req.ok ? [...new Map(req.value.steps.flatMap(s => {
    const c = stepCapability(s, mode);
    return c.mechanism ? [[`${s.chain}|${c.mechanism}`, { chain: s.chain, network: NETWORKS[s.network].label, mechanism: c.mechanism,
      active: owner ? steps[s.index]!.delegation.grantId !== null : null }]] as const : [];
  })).values()] : [];
  const notCapable = steps.find(s => !s.delegation.capable);
  const passkeys = graph?.ok && owner ? new Set(graph.bindings.map(b => owner.grants.find(g => g.grantId === b.grantId)?.passkeyId)).size : null;
  const delegatedReason = runsOff ?? (!delegation ? 'DELEGATION_NOT_ENABLED' : delegation.unavailable) ?? (notCapable ? notCapable.delegation.code ?? 'DELEGATED_AUTHORITY_UNAVAILABLE'
    : gates.enabledByPolicy.reason ?? (graph && !graph.ok ? 'CREDENTIAL_ENROLLMENT_REQUIRED' : passkeys !== null && passkeys > 1 ? 'CREDENTIALS_USE_DIFFERENT_PASSKEYS' : null));
  const bindingCodes = workflow.bindings.map(b => ({ step: b.step, amountFrom: b.amountFrom, confirmEachStep: 'DEPENDENT_AMOUNT_SOURCE_NOT_IMPLEMENTED' as const,
    delegated: 'RECONCILED_RECEIVED_AMOUNT' as const }));
  const confirmAvailable = confirmReason === null, delegatedAvailable = delegatedReason === null;
  const notes = ['One authorization is not one transaction: every step still submits its own transactions and pays its own network fees.',
    'Each step starts only after the previous step reconciled on chain.'];
  if (namespaces.length > 1) notes.push('This workflow uses an EVM wallet and a Solana wallet: both must be proven before it starts.');
  if (bindingCodes.length) notes.push('A dependent step spends what an earlier step actually delivered (after reconciliation), capped by its own amount.');
  return { stepCount: workflow.steps.length,
    confirmEachStep: { available: confirmAvailable, reason: confirmReason, walletConfirmationsAtLeast: workflow.steps.length, walletNamespaces: namespaces },
    delegatedSingleAuthorization: { available: delegatedAvailable, reason: delegatedReason, passkeyAssertions: 1, enrollments, ownerKnown: owner !== undefined },
    recommended: delegatedAvailable && owner ? 'DELEGATED_SINGLE_AUTHORIZATION' : confirmAvailable ? 'CONFIRM_EACH_STEP' : delegatedAvailable ? 'DELEGATED_SINGLE_AUTHORIZATION' : null,
    steps, bindings: bindingCodes, notes };
}
