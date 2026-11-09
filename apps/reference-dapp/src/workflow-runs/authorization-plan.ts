// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: how many separate authorizations a workflow needs, in each mode, BEFORE anything executes. Pure: a function of the
 * canonical workflow, the deployment facts and (once the owner proved a wallet) the owner's delegated grants.
 *
 *   CONFIRM_EACH_STEP               every step is an ordinary run of its own flow: a fresh simulation, the Review and the owner's wallet
 *                                   confirmation per step (a flow may ask for more, e.g. a token approval before a swap)
 *   USER_FUNDED                     BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: execution groups (`execution-groups.ts`) — consecutive steps on one
 *                                   chain authorized with ONE wallet interaction (an EIP-5792 atomic batch, an ERC-4337 user operation of the
 *                                   owner's own smart account, a Solana sign-all request), the rest through their own flows. The owner's
 *                                   wallet pays every network fee; the count is per wallet and per network, never rounded down
 *   DELEGATED_SINGLE_AUTHORIZATION  BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001, RETIRED by BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: its executor
 *                                   (the shared AWS KMS address) sent every step and paid its gas (invariant S1). Always unavailable with
 *                                   EXECUTOR_FUNDED_GAS_RETIRED; the field stays so existing clients render the refusal honestly
 *
 * One authorization is not one transaction and not zero gas: the owner's wallet pays its own network fees on every chain.
 */
import { resolveAuthorityGraph, type GrantView } from '../delegation/authority.ts';
import { stepCapability, type CapabilityMode, type Mechanism } from '../delegation/capabilities.ts';
import { requirementOf } from '../delegation/steps.ts';
import { NETWORKS, type WorkflowComposition } from '../engine/strategy-engine';
import type { Gates } from '../mcp/execution.ts';
import { planExecutionGroups, type ExecutionGroup, type InteractionSummary, type UserFundedFacts, type WalletProfile } from './execution-groups.ts';
import { evmStepBuildable } from '../user-funded/evm-calls.ts';

/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: why `DELEGATED_SINGLE_AUTHORIZATION` is never available any more — its executor (the shared AWS KMS
 * address) would send every step and pay its network fees (invariant S1). Kept as a closed reason so older clients render it honestly.
 */
export const EXECUTOR_FUNDED_GAS_RETIRED = 'EXECUTOR_FUNDED_GAS_RETIRED';
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
  /**
   * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: execution groups the owner's own wallets authorize — the fewest wallet interactions this workflow can
   * safely have with these wallets on this deployment — and pay for (`feePayer`: always the owner's wallet; FloFi never funds gas).
   * `wallets: 'ASSUMED'` before `/approve` (capabilities of the supported wallet families), `'REPORTED'` with the owner's real wallets.
   */
  readonly userFunded: { readonly available: boolean; readonly reason: string | null; readonly groups: readonly ExecutionGroup[];
    readonly interactions: InteractionSummary | null; readonly feePayer: 'OWNER_WALLET'; readonly wallets: 'ASSUMED' | 'REPORTED' };
  readonly recommended: 'USER_FUNDED' | 'DELEGATED_SINGLE_AUTHORIZATION' | 'CONFIRM_EACH_STEP' | null;
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
export function delegableByCode(...args: [workflow: WorkflowComposition, delegation: DelegationFacts]): { readonly ok: boolean; readonly code: string | null } {
  void args;
  // BUILD-FLOFI-UNIVERSAL-WORKFLOW-002, invariant S1: a delegated run is executed by FloFi's executor, whose session address sends and pays for
  // every redemption. User gas is never FloFi-funded, so the mode is retired on every deployment (user-funded execution groups replace it).
  return { ok: false, code: EXECUTOR_FUNDED_GAS_RETIRED };
}

/** The authorization plan of a composed workflow. `grants` (with `now`) are the proven owner's own grants; omit them before a wallet proof. */
export function authorizationPlan(workflow: WorkflowComposition, gates: Pick<Gates, 'supportedByCode' | 'enabledByDeployment' | 'enabledByPolicy' | 'handoff'> & { readonly plan: { readonly steps: readonly { readonly flow: string | null; readonly network: string; readonly action: string }[] } },
  delegation: DelegationFacts, owner?: { readonly grants: readonly GrantView[]; readonly now: number },
  userFunded?: { readonly facts: UserFundedFacts; readonly wallets?: WalletProfile; readonly evmOwner?: string | null }): AuthorizationPlan {
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
  // BUILD-FLOFI-UNIVERSAL-WORKFLOW-002, invariant S1: the executor-funded mode is retired whatever the workflow.
  const delegatedReason = runsOff ?? EXECUTOR_FUNDED_GAS_RETIRED;
  const bindingCodes = workflow.bindings.map(b => ({ step: b.step, amountFrom: b.amountFrom, confirmEachStep: 'RECONCILED_RECEIVED_AMOUNT' as const,
    delegated: 'SIGNED_GUARANTEED_MINIMUM' as const }));
  const confirmAvailable = confirmReason === null, delegatedAvailable = delegatedReason === null;
  // User-funded groups: every step must pass its own gates exactly as in confirm mode (an owner-step group IS a confirm-mode step).
  const facts = userFunded?.facts ?? null;
  const grouped = req.ok && facts ? planExecutionGroups(req.value, facts, userFunded?.wallets, st => st.namespace === 'solana' || (evmStepBuildable(st, facts.chains, userFunded?.evmOwner) ?? true)) : null;
  const userFundedReason = runsOff ?? (!facts ? 'USER_FUNDED_NOT_ENABLED' : !req.ok ? req.code : grouped && !grouped.ok ? grouped.code : confirmReason);
  const groupsPlan = grouped && grouped.ok ? grouped : null;
  const userFundedAvailable = userFundedReason === null && groupsPlan !== null;
  // Recommended: fewer wallet interactions than confirming each step (never claimed when it is not fewer).
  const fewer = groupsPlan !== null && groupsPlan.interactions.upfront + groupsPlan.interactions.whenDue < workflow.steps.length;
  // The notes describe the modes actually offered: group wording only where user-funded groups are available here.
  const notes = ['Your own wallet pays every network fee; FloFi never pays, advances or reimburses gas.',
    ...userFundedAvailable ? ['One wallet interaction is not one transaction: a batch executes several steps in one transaction on one network; each network needs its own wallet authorization.',
      'Each group starts only after the previous one reconciled on chain.'] : ['Each step starts only after the previous step reconciled on chain.']];
  if (namespaces.length > 1) notes.push('This workflow uses an EVM wallet and a Solana wallet: both must be proven before it starts.');
  if (bindingCodes.length) notes.push(userFundedAvailable
    ? 'A dependent step in the same group spends the earlier step\'s signed guaranteed minimum, fixed when you sign (anything above it stays in your wallet); '
      + 'a dependent step in a later group spends what was actually delivered after reconciliation, capped by its own amount, and is signed when it becomes due.'
    : 'A dependent step spends what an earlier step actually delivered (after reconciliation), capped by its own amount.');
  return { stepCount: workflow.steps.length,
    confirmEachStep: { available: confirmAvailable, reason: confirmReason, walletConfirmationsAtLeast: workflow.steps.length, walletNamespaces: namespaces },
    delegatedSingleAuthorization: { available: delegatedAvailable, reason: delegatedReason, walletSignatures: Math.max(1, enrollments.length), passkeyAssertions: 0, enrollments,
      ownerKnown: owner !== undefined },
    userFunded: { available: userFundedAvailable, reason: userFundedAvailable ? null : userFundedReason ?? 'USER_FUNDED_UNAVAILABLE', groups: groupsPlan?.groups ?? [],
      // P0 universal execution: counts made with ASSUMED wallet capabilities (an MCP client, a channel, a claim before the owner's browser read
      // the wallet) are lower bounds: never "single", always "at least". Only the owner's reported wallet makes a count exact.
      interactions: groupsPlan ? userFunded?.wallets ? groupsPlan.interactions : { ...groupsPlan.interactions, single: false, atLeast: true } : null,
      feePayer: 'OWNER_WALLET', wallets: userFunded?.wallets ? 'REPORTED' : 'ASSUMED' },
    recommended: userFundedAvailable && fewer ? 'USER_FUNDED' : confirmAvailable ? 'CONFIRM_EACH_STEP' : userFundedAvailable ? 'USER_FUNDED' : null,
    steps, bindings: bindingCodes, notes };
}
