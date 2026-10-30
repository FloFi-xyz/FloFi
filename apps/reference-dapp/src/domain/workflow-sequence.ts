// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-CHAT-E2E-FIX-002: a workflow of several independent owner-wallet actions (e.g. Swap on Base → Bridge Base → Arbitrum) executed as an
 * ordered SEQUENCE of single-action steps, each through the existing runtime of its own action and network.
 *
 * Every owner-wallet runtime FloFi has (public catalog swap, certified Router, universal Router, Jupiter, Aave, …) serves exactly one action
 * (`*_ISOLATED_ONLY`), so before this module a two-action workflow could neither be simulated nor executed: its runtime was chosen from one
 * action, and the linter refused the whole workflow. Pure: no React, wallet, network or quote.
 *
 *   order       financial actions in dependency order (an authored `dependencies` edge), else the order they were authored in
 *   projection  step k alone: the canonical workflow with only that node (same workflow id and revision), which its runtime simulates, reviews,
 *               authorizes and reconciles exactly as a one-action workflow. Nothing about the step is changed or guessed
 *   funding     step k is FUNDED BY the latest earlier step that delivers exactly k's input asset (chain + address + decimals; a native coin
 *               has no address) to the owner's own wallet. A funded step is simulated only after its producer reconciled, and spends
 *               min(authored amount, amount the producer actually delivered) — FloFi's existing binding rule (`engine/workflow-bindings.ts`)
 *   independent a step that no earlier step funds spends its authored amount; it is still simulated and signed in order, after the step before it
 *
 * Only a whole sequence of steps each runtime can serve on its own is a sequence. A workflow one of FloFi's composition runtimes serves as a
 * whole (Supply → Borrow → Swap, the Solana Swap → Orca position, the engineering graphs, anything with resource edges) keeps its existing path.
 */
import { NATIVE_ETH } from './public-testnet-swap';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import { formatAssetAmount, SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { isBoundComposition } from '@defi-workflow-engine/action-registry';
import { createConcentratedLiquidityNode, readConcentratedLiquidity, isLendingComposition, workflowDependencyOrder, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import type { Workflow } from './initial-workflow';
import { editorReducer } from './editor';
import { canvasAmountCommand } from './canvas-action-setup';

type Node = Workflow['nodes'][number];
export type SequenceAsset = { readonly chainId: string; readonly address: string | null; readonly decimals: number };
export type SequenceFunding = { readonly input: SequenceAsset & { readonly amount: string }; readonly fundedBy: number };
export type SequenceStep = {
  /** 0-based position in the sequence. */ readonly index: number; readonly nodeId: string; readonly chainId: string;
  /** What the step spends from the owner's wallet (the IR's single MAXIMUM_INPUT), in native units. */
  readonly input: (SequenceAsset & { readonly amount: string }) | null;
  /** What the step delivers, and whether to the owner's own wallet (a bridge to an explicit recipient funds nobody). */
  readonly output: SequenceAsset | null; readonly ownerReceives: boolean;
  /** The earlier step whose delivered output this step spends, or null for an independent step. */ readonly fundedBy: number | null;
  /** All token deposits funded by earlier steps (a position may consume two distinct assets). */ readonly funding: readonly SequenceFunding[];
  /** The step alone, as its runtime receives it before any funding bound. */ readonly projection: Workflow;
};
export type WorkflowSequence = { readonly steps: readonly SequenceStep[] };
/** One step that already executed: the exact node it executed and what its reconciled record proves it delivered (null: not provable). */
export type CompletedStep = { readonly nodeId: string; readonly node: string; readonly received: string | null; readonly runKey: string | null;
  readonly allocations?: readonly { readonly fundedBy: number; readonly input: SequenceAsset; readonly used: string }[] };

const financial = (workflow: Workflow) => workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const UNITS = /^(0|[1-9][0-9]{0,77})$/;
function assetOf(value: unknown): SequenceAsset | null {
  if (!isObject(value) || typeof value.chainId !== 'string' || !Number.isSafeInteger(value.decimals)) return null;
  const address = typeof value.address === 'string' && value.address ? value.chainId.startsWith('eip155:') ? value.address.toLowerCase()
    : value.chainId.startsWith('solana:') && value.address === SOLANA_MAINNET_TOKENS.SOL.mint && value.decimals === 9 ? null : value.address : null;
  return { chainId: value.chainId, address, decimals: value.decimals as number };
}
export const sameSequenceAsset = (a: SequenceAsset, b: SequenceAsset) => a.chainId === b.chainId && a.address === b.address && a.decimals === b.decimals;

/** What a node spends (its single MAXIMUM_INPUT) and delivers (`asset-out`, to the owner unless an explicit recipient is set). */
export function stepAssets(node: Node): Pick<SequenceStep, 'input' | 'output' | 'ownerReceives'> & { readonly inputs: readonly (SequenceAsset & { readonly amount: string })[] } {
  const limits = node.userConstraints.filter(constraint => constraint.kind === 'MAXIMUM_INPUT') as unknown as readonly { readonly quantity: { readonly asset: unknown; readonly amount: unknown } }[];
  const spent = limits.length === 1 ? assetOf(limits[0]!.quantity.asset) : null, amount = limits.length === 1 ? limits[0]!.quantity.amount : null;
  const out = node.inputs.find(input => input.name === 'asset-out' && input.kind === 'ASSET');
  const recipient = node.inputs.find(input => input.name === 'recipient')?.value;
  const inputs = limits.flatMap(limit => { const asset = assetOf(limit.quantity.asset), units = limit.quantity.amount;
    return asset && typeof units === 'string' && UNITS.test(units) ? [{ ...asset, amount: units }] : []; });
  const lendingOutput = node.actionType === 'withdraw' || node.actionType === 'borrow' ? spent : null;
  return { input: spent && typeof amount === 'string' && UNITS.test(amount) ? { ...spent, amount } : null, inputs, output: assetOf(out?.value) ?? lendingOutput,
    ownerReceives: recipient === undefined || recipient === 'CONNECTED_OWNER' || recipient === 'CONNECTED_DESTINATION_WALLET' };
}
/** Financial actions in the Canvas order (`composerActions`: dependency order, else the order they were authored in). */
export function sequenceOrder(workflow: Workflow): readonly Node[] {
  try { return workflowDependencyOrder(workflow.nodes).filter(node => !node.actionType.startsWith('mock-')) as readonly Node[]; }
  catch { return financial(workflow); } // A broken dependency is the linter's to refuse; never reorder around it.
}
/** The step alone, as a one-action workflow of the same identity and revision. */
export function stepProjection(workflow: Workflow, node: Node): Workflow {
  return { ...workflow, nodes: [{ ...node, dependencies: [] }], resourceEdges: [] } as Workflow;
}
/** A workflow one of FloFi's existing composition runtimes executes as a whole (never split into steps). */
export function compositionWorkflow(workflow: Workflow): boolean {
  return workflow.resourceEdges.length > 0 || isLendingComposition(workflow as unknown as SemanticWorkflow) || isBoundComposition(workflow as unknown as SemanticWorkflow) ||
    workflow.nodes.some(node => node.nodeId === 'build009-bridge' || node.actionType === 'asset.liquidity.prepare');
}
/**
 * The workflow's sequence, or null when it is not one (one action, an existing composition, or a step its runtime cannot take alone). `lint` is
 * the authoring linter (it throws on an invalid workflow): every step must pass it alone, as its runtime receives it.
 */
export function workflowSequence(workflow: Workflow, lint: (workflow: Workflow) => unknown): WorkflowSequence | null {
  const ordered = sequenceOrder(workflow);
  if (ordered.length < 2 || compositionWorkflow(workflow)) return null;
  const steps: SequenceStep[] = [];
  for (const [index, node] of ordered.entries()) {
    const projection = stepProjection(workflow, node);
    try { lint(projection); } catch { return null; }
    const assets = stepAssets(node);
    const funding: SequenceFunding[] = [];
    for (const input of assets.inputs) {
      if (input.amount === '0') continue;
      for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
        const producer = steps[earlier]!;
        if (producer.output && producer.ownerReceives && sameSequenceAsset(producer.output, input)) { funding.push({ input, fundedBy: earlier }); break; }
      }
    }
    steps.push({ index, nodeId: node.nodeId, chainId: node.chainId, ...assets,
      input: funding[0]?.input ?? assets.input, fundedBy: funding[0]?.fundedBy ?? null, funding, projection });
  }
  return { steps };
}
/**
 * The owner-wallet runtimes a sequence step may use: each one reads its workflow from the store's `runtimeWorkflow`, so it serves the current step
 * alone. Others (positions, the Solana composition, fork and engineering paths) are not offered in a sequence: the owner is told which step.
 */
export const SEQUENCE_RUNTIMES: readonly string[] = Object.freeze(['public', 'router', 'universal', 'solana-swap', 'solana-transfer', 'transfer', 'supply', 'uniswap-pool', 'solana-pool']);
/** Runtimes whose reconciled record proves the delivered amount a funded later step spends (`deliveredByRecord`). */
export const DELIVERY_READABLE: readonly string[] = Object.freeze(['public', 'router', 'universal', 'solana-swap', 'supply']);
/** The canonical form of a node, to prove an executed step is still exactly what the workflow holds. */
export const stepNodeKey = (node: Node) => JSON.stringify(node);
/**
 * Completed steps that still describe this workflow, in order. A change to an executed step (or a different order) ends that history here:
 * the run's records stay in the owner's history, but this workflow is no longer that sequence.
 */
export function validCompletions(sequence: WorkflowSequence | null, workflow: Workflow, completed: readonly CompletedStep[]): readonly CompletedStep[] {
  if (!sequence) return [];
  const kept: CompletedStep[] = [];
  for (const [index, done] of completed.entries()) {
    const step = sequence.steps[index], node = step && workflow.nodes.find(item => item.nodeId === step.nodeId);
    if (!step || !node || step.nodeId !== done.nodeId || stepNodeKey(node) !== done.node) break;
    kept.push(done);
  }
  return kept;
}
/** The amount a funded step spends: min(authored cap, delivered); null when the step is independent or its funding is not provable. */
export function boundAmount(step: SequenceStep, completed: readonly CompletedStep[]): string | null {
  if (step.fundedBy === null || !step.input) return null;
  const available = availableFunding({ fundedBy: step.fundedBy, input: step.input }, completed);
  return available === null ? null : BigInt(available) < BigInt(step.input.amount) ? available : step.input.amount;
}
/** Every completed consumer reserves its bound maximum; a producer's delivery cannot fund that same maximum twice. */
function availableFunding(funding: SequenceFunding, completed: readonly CompletedStep[]): string | null {
  const delivered = completed[funding.fundedBy]?.received;
  if (delivered === null || delivered === undefined || !UNITS.test(delivered)) return null;
  const allocated = completed.flatMap(done => done.allocations ?? []).filter(item => item.fundedBy === funding.fundedBy && sameSequenceAsset(item.input, funding.input))
    .reduce((sum, item) => sum + BigInt(item.used), 0n);
  return (BigInt(delivered) > allocated ? BigInt(delivered) - allocated : 0n).toString();
}
export function fundingAllocations(step: SequenceStep, completed: readonly CompletedStep[]): NonNullable<CompletedStep['allocations']> {
  return step.funding.flatMap(funding => {
    const available = availableFunding(funding, completed);
    if (available === null) return [];
    return [{ fundedBy: funding.fundedBy, input: funding.input, used: (BigInt(available) < BigInt(funding.input.amount) ? available : funding.input.amount) }];
  });
}
/**
 * The workflow the step's runtime receives: its projection, with a funded step's amount bound to what its producer delivered (re-authored through
 * the card's own amount command, so the runtime sees an ordinary validated amount). A bound of zero, or one the step's authoring refuses, is null:
 * the step cannot run and the sequence says why.
 */
export function boundProjection(step: SequenceStep, amount: string | null, context: ReviewContext, completed?: readonly CompletedStep[]): Workflow | null {
  if (step.projection.nodes[0]?.actionType === 'asset.liquidity.concentrated') {
    if (!step.funding.length) return step.projection;
    try {
      const node = step.projection.nodes[0]!, fields = readConcentratedLiquidity(node as SemanticWorkflow['nodes'][number]);
      for (const [index, funding] of step.funding.entries()) {
        const received = completed ? availableFunding(funding, completed) : index === 0 ? amount : null;
        if (received === null || !UNITS.test(received)) return null;
        const used = BigInt(received) < BigInt(funding.input.amount) ? received : funding.input.amount;
        if (used === '0') return null;
        const token = sameSequenceAsset(assetOf(fields.token0)!, funding.input) ? 0 :
          sameSequenceAsset(assetOf(fields.token1)!, funding.input) ? 1 : null;
        if (token === null) return null;
        if (token === 0) fields.amount0Max = used; else fields.amount1Max = used;
      }
      const changed = createConcentratedLiquidityNode(node.nodeId, fields);
      return { ...step.projection, nodes: [{ ...node, inputs: changed.inputs, userConstraints: changed.userConstraints }] } as Workflow;
    } catch { return null; }
  }
  if (amount === null || !step.input || amount === step.input.amount) return step.projection;
  if (amount === '0') return null;
  const decimal = formatAssetAmount(amount, step.input.decimals);
  try {
    const state = { workflow: step.projection, error: null };
    const command = canvasAmountCommand(state, null, { [step.nodeId]: decimal }, step.nodeId, context);
    const next = editorReducer(state, command, context);
    return next.error ? null : next.workflow;
  } catch { return null; }
}

/** What a step's reconciled record proves it delivered, in native units of `output`; null when nothing is proven for exactly that asset. */
export function deliveredByRecord(kind: string, record: unknown, output: SequenceAsset | null): string | null {
  if (!output || !isObject(record)) return null;
  const same = (chainId: unknown, address: unknown) => typeof chainId === 'string' && chainId === output.chainId &&
    (output.address === null ? address === null || address === undefined || chainId.startsWith('solana:') && output.decimals === 9 && address === SOLANA_MAINNET_TOKENS.SOL.mint
      : typeof address === 'string' && (output.chainId.startsWith('eip155:') ? address.toLowerCase() : address) === output.address);
  if (kind === 'public' && isObject(record.quote) && isObject(record.outcome)) {
    const quote = record.quote, units = record.outcome.outputReceived;
    // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a native-ETH output (EIP-7528 marker) is the native asset — never WETH9 — and funds only a native-ETH input.
    return same(`eip155:${String(quote.chainId)}`, quote.outputToken === NATIVE_ETH ? null : quote.outputToken) && typeof units === 'string' && UNITS.test(units) ? units : null;
  }
  if (kind === 'universal' && record.verdict === 'RECONCILED' && isObject(record.review) && isObject(record.review.route)) {
    const token = record.review.route.outputToken, units = record.received;
    return isObject(token) && same(token.chainId, token.kind === 'NATIVE' ? null : token.address) && typeof units === 'string' && UNITS.test(units) ? units : null;
  }
  if (kind === 'router' && record.verdict === 'RECONCILED' && isObject(record.destination)) {
    const fill = record.destination, units = fill.transferAmount;
    const intent = isObject(record.review) && isObject(record.review.intent) ? record.review.intent : null;
    return intent && same(intent.destinationChain, fill.outputToken) && typeof units === 'string' && UNITS.test(units) ? units : null;
  }
  if (kind === 'solana-swap' && record.verdict === 'RECONCILED' && isObject(record.review) && isObject(record.review.output) && Array.isArray(record.observations)) {
    const observation = record.observations.at(-1), token = record.review.output;
    const units = isObject(observation) && observation.verdict === 'RECONCILED' ? observation.outputReceived : null;
    return same(record.review.chain, token.mint) && token.decimals === output.decimals && typeof units === 'string' && UNITS.test(units) ? units : null;
  }
  if (kind === 'supply' && record.verdict === 'RECONCILED' && isObject(record.review) && (record.review.borrow || record.review.withdraw) && Array.isArray(record.observations)) {
    const observation = record.observations.at(-1), units = isObject(observation) && observation.verdict === 'RECONCILED' ? observation.walletDelta : null;
    return same(record.review.chain, record.review.asset) && typeof units === 'string' && UNITS.test(units) ? units : null;
  }
  return null;
}
