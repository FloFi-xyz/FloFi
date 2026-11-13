// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 workflow execution: the Editor's whole-workflow Review — what ONE workflow run of the Canvas workflow would ask the owner's own wallet, before
 * anything is created, signed or sent. Read-only: no handoff, run, preparation or signature is stored.
 *
 *   plan        the shared run's execution groups (`planExecutionGroups`) for the owner's REAL wallet capabilities (EIP-5792 `atomic` per chain as the
 *               browser read it from the wallet, Wallet Standard multi-sign), never assumed
 *   first group when it is a wallet batch: its exact calls built now from fresh on-chain quotes (approvals only where the owner's current allowance
 *               does not cover the spend), the whole batch simulated in order (each swap at or above its signed minimum, the owner's Aave health
 *               factor ≥ 2.0 after a borrow) and its fee estimate — the same builder the run uses when the owner authorizes (`prepareGroup`)
 *   counts      wallet prompts, signatures, on-chain transactions, batched calls and network switches, kept separate and never rounded down
 *
 * The owner's later Authorize starts the shared run (`src/workflow-runs`) and prepares again from fresh facts; the wallet shows exactly what it
 * signs. Nothing here is authority: Review values are a preview, bound to their workflow hash, owner, network and validity.
 */
import { requirementOf } from '../delegation/steps.ts';
import { composeWorkflowBound, NETWORKS } from '../engine/strategy-engine.ts';
import type { NetworkId } from '../engine/strategy-spec';
import { userFundedPreferred } from '../workflow-runs/authorization-plan.ts';
import { userFundedBuildable } from '../workflow-runs/service.ts';
import { planExecutionGroups, type ExecutionGroup, type GroupStrategy, type UserFundedFacts, type WalletProfile } from '../workflow-runs/execution-groups.ts';
import { prepareGroup, type NativeFeeShortfall, type UserFundedDeps } from '../user-funded/groups.ts';
import type { BatchSimulation } from '../user-funded/batch-simulation.ts';
import type { EvmGroupCalls, UserCall } from '../user-funded/evm-calls.ts';
import { amountOf, plannedSteps, type ReviewAmount } from '../user-funded/planned.ts';
import { editorWorkflowStrategy } from './workflow-strategy.ts';

export type { ReviewAmount };
export type ReviewStep = {
  readonly index: number; readonly action: string; readonly network: string; readonly chain: string; readonly provider: string | null;
  /** What the step spends. `basis`: EXACT (authored), GUARANTEED_MINIMUM (an earlier step's signed minimum in the same batch) or
   *  RECONCILED_ACTUAL (what an earlier group actually delivered, capped by the authored amount; known when that group reconciled). */
  readonly spend: ReviewAmount | null; readonly basis: 'EXACT' | 'GUARANTEED_MINIMUM' | 'RECONCILED_ACTUAL'; readonly boundTo: number | null;
  /** A swap's quoted output and its signed minimum; a borrow's exact delivery. Null when quoted only when the step's group is due. */
  readonly expected: ReviewAmount | null; readonly minimum: ReviewAmount | null;
  /** A transfer's recipient, in full (the authored one, or the owner's own wallet); null for every other action. */
  readonly recipient: string | null;
  /**
   * P0 hotfix (E1): a bridge's destination network (the label), where `expected`/`minimum` arrive — the deposit's exact output, to the owner's
   * own wallet — and whose delivery the run waits for before it completes. Null for every other action.
   */
  readonly destination?: string | null;
};
export type ReviewGroup = {
  readonly index: number; readonly chain: string; readonly network: string; readonly strategy: GroupStrategy; readonly steps: readonly [number, number];
  readonly signing: 'UPFRONT' | 'WHEN_DUE'; readonly interactions: number; readonly setup: readonly string[]; readonly downgrades: readonly string[];
  /** Prepared now (the first group): the exact calls the wallet will show, the simulation and the fee estimate. */
  readonly calls: readonly { readonly kind: UserCall['kind']; readonly step: number }[] | null;
  readonly approvals: number | null;
  /** `sponsorship` (ADR-0009): FloFi's paymaster offers to pay this batch's network fee when the wallet supports it (OFFERED), or must (REQUIRED). */
  readonly fee: { readonly estimatedWei: string; readonly maxWei: string; readonly payer: string; readonly sponsorship?: 'OFFERED' | 'REQUIRED' | null } | null;
  readonly healthFactorAfter: string | null;
};
export type ReviewCounts = {
  /** Wallet prompts the owner answers (one per group interaction); `atLeast` when a step's own flow may ask once more (e.g. a token approval). */
  readonly walletPrompts: number; readonly atLeast: boolean;
  /** Cryptographic signatures the wallet produces (a Solana request signs one per transaction; an EVM batch is one). */
  readonly signatures: number;
  /** Transactions that land on chain (an atomic EVM batch is one transaction carrying several calls). */
  readonly transactions: number;
  /** Calls inside the prepared batches (approvals included). */
  readonly batchedCalls: number;
  readonly networkSwitches: number; readonly oneTimeSetup: readonly string[];
};
export type EditorExecutionReview = {
  readonly workflowHash: string; readonly stepCount: number; readonly owner: string; readonly reviewedAt: string;
  /** Until when the prepared values stand (the batch's quotes); null when nothing was prepared. */
  readonly validUntil: string | null;
  /**
   * ONE_WALLET_CONFIRMATION   every step in one wallet interaction (one atomic batch)
   * GROUPED                   every group is a wallet-grouped interaction (a later one is signed when it becomes due)
   * STEP_BY_STEP              at least one step runs through its own flow (no batching for this wallet, network or action): see `reasons`
   */
  readonly mode: 'ONE_WALLET_CONFIRMATION' | 'GROUPED' | 'STEP_BY_STEP';
  readonly groups: readonly ReviewGroup[]; readonly steps: readonly ReviewStep[]; readonly counts: ReviewCounts;
  /** Closed codes: why fewer wallet interactions are not possible here (downgrades of every group, deduplicated). */
  readonly reasons: readonly string[];
  /** The first group could not be prepared (e.g. BORROW_UNSAFE_HEALTH_FACTOR): nothing would be offered to the wallet. */
  readonly refusal: { readonly code: string; readonly step: number | null;
    /** P0 (board 07): the server's own numbers for a native-fee shortfall, read-only, for the blocker screen and the assistant. */
    readonly evidence?: NativeFeeShortfall } | null;
};
export type ReviewResult = { readonly ok: true; readonly value: EditorExecutionReview } | { readonly ok: false; readonly code: string; readonly step?: number };

const GROUPED: readonly GroupStrategy[] = ['EVM_WALLET_BATCH', 'EVM_USER_OPERATION', 'SOLANA_SIGN_ALL'];
/** Steps that spend nothing from the wallet and deliver exactly their amount to the owner. */
const DELIVERS: ReadonlySet<string> = new Set(['borrow', 'withdraw']);
/** The address a transfer pays: the authored recipient (EVM lower-cased), else the owner's own wallet (exactly as the call builder resolves it). */
const recipientOf = (strategy: { readonly recipient?: unknown }, owner: string | null) =>
  typeof strategy.recipient === 'string' && strategy.recipient ? (/^0x[0-9a-fA-F]{40}$/.test(strategy.recipient) ? strategy.recipient.toLowerCase() : strategy.recipient) : owner;
const PROVIDERS: Readonly<Record<string, string>> = { 'uniswap.v3': 'Uniswap V3', 'aave-v3': 'Aave V3', 'jupiter.swap-v2': 'Jupiter' };
function counts(groups: readonly ExecutionGroup[], prepared: ReadonlyMap<number, number>, networkSwitches: number, oneTimeSetup: readonly string[]): ReviewCounts {
  let walletPrompts = 0, signatures = 0, transactions = 0, batchedCalls = 0, atLeast = false;
  for (const g of groups) {
    const steps = g.stepTo - g.stepFrom + 1;
    walletPrompts += g.interactions;
    if (g.strategy === 'EVM_WALLET_BATCH' || g.strategy === 'EVM_USER_OPERATION') {
      signatures += 1; transactions += 1;
      // Before preparation a batch is counted as its steps' exact calls without approvals (a minimum: approvals are added only where needed).
      batchedCalls += prepared.get(g.index) ?? steps;
    } else if (g.strategy === 'SOLANA_SIGN_ALL' || g.strategy === 'SOLANA_DURABLE_NONCE') { signatures += steps; transactions += steps; }
    else { signatures += steps; transactions += steps; atLeast = true; }
  }
  return { walletPrompts, atLeast, signatures, transactions, batchedCalls, networkSwitches, oneTimeSetup };
}

/**
 * The Review of the Canvas workflow for `owner` and the wallet capabilities the browser read (`profile`), on this deployment's user-funded facts.
 * Refusals are closed codes: the Editor's own (EDITOR_WORKFLOW_*), USER_FUNDED_NOT_ENABLED, the composition's, WORKFLOW_STEPS_EMPTY.
 */
export async function reviewEditorExecution(input: { readonly workflow: unknown; readonly owner: string; readonly profile: WalletProfile;
  readonly facts: UserFundedFacts; readonly deps: UserFundedDeps | null; readonly now: Date;
  /**
   * P0 hotfix: why a BRIDGE step's own flow refuses to execute on this deployment today (its live mode, its owner-execution opt-in), or null.
   * The run's start and every group preparation re-check these gates; the Review asks the same question, so it never promises one wallet
   * confirmation that Authorize would then refuse. Absent: not consulted (tests and callers without an engine runtime).
   */
  readonly stepRefusal?: ((step: Parameters<typeof requirementOf>[0]['steps'][number], index: number) => Promise<string | null>) | undefined }): Promise<ReviewResult> {
  const owner = input.owner.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner)) return { ok: false, code: 'EVM_WALLET_REQUIRED' };
  if (!input.facts.enabled || !input.deps) return { ok: false, code: input.facts.code ?? 'USER_FUNDED_NOT_ENABLED' };
  const converted = editorWorkflowStrategy(input.workflow);
  if (!converted.ok) return converted;
  const composed = composeWorkflowBound(converted.strategy, converted.workflowHash);
  if (!composed.ok) return { ok: false, code: composed.code };
  const req = requirementOf(composed);
  if (!req.ok) return { ok: false, code: req.code };
  const closed = new Map<number, string>();
  if (input.stepRefusal) for (const step of req.value.steps) {
    if (step.action !== 'bridge') continue;
    const code = await input.stepRefusal(composed.steps[step.index]!, step.index);
    if (code) closed.set(step.index, code);
  }
  const buildable = userFundedBuildable(input.facts, owner);
  const plan = planExecutionGroups(req.value, input.facts, input.profile, st => closed.has(st.index) ? 'USER_FUNDED_BRIDGE_FLOW_CLOSED' : buildable(st));
  if (!plan.ok) return { ok: false, code: plan.code };
  const preparedCalls = new Map<number, number>();
  let validUntil: string | null = null, refusal: EditorExecutionReview['refusal'] = null;
  const groups: ReviewGroup[] = [];
  const planned = new Map<number, Pick<ReviewStep, 'spend' | 'expected' | 'minimum'>>();
  for (const g of plan.groups) {
    let calls: ReviewGroup['calls'] = null, approvals: number | null = null, fee: ReviewGroup['fee'] = null, healthFactorAfter: string | null = null;
    // Only the first group is due now: it is prepared exactly as the run will prepare it. A later group is quoted when it becomes due.
    if (g.index === 0 && g.strategy === 'EVM_WALLET_BATCH') {
      const r = await prepareGroup(input.deps, composed, req.value, { runId: 'editor-review', groupIndex: 0, strategy: g.strategy, chain: g.chain, feePayer: owner,
        stepFrom: g.stepFrom, stepTo: g.stepTo, preview: true });
      if (!r.ok) refusal = { code: r.code, step: r.stepIndex ?? null, ...r.evidence ? { evidence: r.evidence } : {} };
      else {
        const p = r.value.prepared as unknown as { group: EvmGroupCalls; simulation: BatchSimulation | null;
          fee: { estimatedGas: string; maxFeePerGas: string; maxCost: string; payer: string; l1FeeUpperBound?: string; sponsorship?: 'OFFERED' | 'REQUIRED' | null } };
        validUntil = r.value.validUntil.toISOString();
        calls = p.group.calls.map((c, i) => ({ kind: c.kind, step: p.group.steps.find(s => s.calls.includes(i))?.stepIndex ?? g.stepFrom }));
        approvals = p.group.calls.filter(c => c.kind === 'ERC20_APPROVE').length;
        preparedCalls.set(g.index, p.group.calls.length);
        // The estimate is the execution gas at about the current price plus the L1 data fee bound (OP Stack only; 0 elsewhere).
        fee = { estimatedWei: (BigInt(p.fee.estimatedGas) * BigInt(p.fee.maxFeePerGas) / 2n + BigInt(p.fee.l1FeeUpperBound ?? '0')).toString(), maxWei: p.fee.maxCost, payer: p.fee.payer,
          sponsorship: p.fee.sponsorship ?? null };
        healthFactorAfter = p.simulation ? Object.values(p.simulation.healthFactorAfter)[0] ?? null : null;
        for (const [index, values] of plannedSteps(req.value, p.group)) planned.set(index, values);
      }
    }
    groups.push({ index: g.index, chain: g.chain, network: NETWORKS[req.value.steps[g.stepFrom]!.network].label, strategy: g.strategy, steps: [g.stepFrom, g.stepTo],
      signing: g.signing, interactions: g.interactions, setup: g.setup, downgrades: g.downgrades, calls, approvals, fee, healthFactorAfter });
  }
  const steps: ReviewStep[] = req.value.steps.map(step => {
    const g = plan.groups.find(x => x.stepFrom <= step.index && step.index <= x.stepTo)!;
    const basis = g.steps.find(s => s.index === step.index)?.amount ?? 'EXACT', boundTo = g.steps.find(s => s.index === step.index)?.boundTo ?? null;
    const own = planned.get(step.index), input = step.inputs[0];
    return { index: step.index, action: step.action, network: NETWORKS[step.network].label, chain: step.chain, provider: step.adapterId ? PROVIDERS[step.adapterId] ?? null : null,
      basis, boundTo, spend: own?.spend ?? (input && !DELIVERS.has(step.action) ? amountOf(input.amount, input) : null),
      expected: own?.expected ?? (DELIVERS.has(step.action) && input ? amountOf(input.amount, input) : null), minimum: own?.minimum ?? null,
      recipient: step.action === 'transfer' ? recipientOf(step.strategy as { readonly recipient?: unknown }, step.namespace === 'eip155' ? owner : null) : null,
      ...step.action === 'bridge' ? { destination: NETWORKS[(step.strategy as { readonly destinationNetwork: NetworkId }).destinationNetwork]?.label ?? null } : {} };
  });
  // Grouping is offered under the run's own rule (`userFundedPreferred`, which its claim applies too: otherwise the claim starts confirming each
  // step, and the grouped Authorize could not start): never more wallet interactions than confirming each step, whose step count is only a lower
  // bound (a step's own flow may add a token approval; a batch folds approvals in and carries an on-chain expiry). Every group here is a
  // grouped interaction, so a tie never forces step-by-step. Nothing claims FEWER: the counts are shown as they are.
  const everyGroupBatched = plan.groups.every(g => GROUPED.includes(g.strategy));
  const allGrouped = everyGroupBatched && userFundedPreferred(plan.groups, plan.interactions, req.value.steps.length);
  const mode = !allGrouped ? 'STEP_BY_STEP' : plan.interactions.single ? 'ONE_WALLET_CONFIRMATION' : 'GROUPED';
  return { ok: true, value: { workflowHash: converted.workflowHash, stepCount: req.value.steps.length, owner, reviewedAt: input.now.toISOString(), validUntil, mode, groups, steps,
    counts: counts(plan.groups, preparedCalls, plan.interactions.networkSwitches, plan.interactions.oneTimeSetup),
    // USER_FUNDED_NOT_FEWER_INTERACTIONS is no longer emitted: groups that are all grouped interactions never need more prompts than their steps.
    reasons: [...new Set(plan.groups.flatMap(g => g.downgrades))].filter(code => code !== 'WALLET_CAPABILITIES_ASSUMED'),
    refusal } };
}
