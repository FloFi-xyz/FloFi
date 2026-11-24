// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BETA-UX-INTELLIGENCE-001 (WS04, P0): dependency-aware data propagation between connected cards, for every supported action.
 *
 * A visible connection is a canonical dependency (`node.dependencies`, persisted with the workflow, identical in Chat, the Editor, MCP and the
 * channels). What a connected step can take from the step before it is decided here, from the canonical IR alone — never from a picture:
 *
 *   output       what a step delivers to the owner: its `asset-out` declaration (Swap, Bridge, catalog/Jupiter swaps), else its `amount-out`
 *                expected output, else what a Withdraw / Borrow draws to the wallet (`stepAssets`). A Transfer, a Supply, a Repay and a liquidity
 *                position deliver nothing the owner can spend again (a receipt, a debt reduction, a position id), and a Bridge or Transfer to an
 *                explicit recipient delivers to someone else: none of them funds a later step.
 *   inherited    a connected step whose spending asset is EXACTLY the upstream output (chain + address/native id + decimals). The sequence
 *                runtime (`workflow-sequence.ts`) then simulates it only after the upstream step reconciled and spends min(authored cap, the
 *                amount actually delivered) — the settled output, never a static estimate and never the whole wallet balance; two consumers
 *                never spend the same delivery twice (`fundingAllocations`).
 *   proposal     what connecting (or adding a card after) a step proposes for the consumer: the network and spending asset of the upstream
 *                output, and its amount from the upstream card's live estimate when one is known. Applied as an ordinary card draft through the
 *                consumer's own authoring command (never written into the IR silently), so the person sees it, can change it, and Apply re-validates it.
 *   mismatch     connected, but the consumer spends something else: shown with a plain reason; it still runs as an ordered, independent step.
 *
 * Pure: no React, wallet, quote or network. Nothing here signs, simulates or authorizes.
 */
import type { Asset } from '@defi-workflow-engine/workflow-contracts';
import { UNIVERSAL_NETWORKS, universalNetworkOfChain } from '@defi-workflow-engine/workflow-contracts';
import type { Workflow } from './initial-workflow';
import { sameSequenceAsset, sequenceOrder, stepAssets, type SequenceAsset } from './workflow-sequence';
import { CANVAS_BRIDGE_NETWORK_OPTIONS, type CanvasBridgeNetworks } from './canvas-action-setup';
import { defaultUniversalOutput, resolveUniversalAsset, UNIVERSAL_CANVAS_LABEL, universalKeyOfCanvasLabel } from './universal-bridge-authoring';
/** The Bridge picker's destination preference (Base first), used when a seeded destination must be chosen. */
const DESTINATION_ORDER: readonly string[] = ['Base', 'Arbitrum', 'Ethereum', 'Robinhood Chain', 'Solana'];

type Node = Workflow['nodes'][number];
const financial = (node: { readonly actionType: string }) => !node.actionType.startsWith('mock-');
/** Actions whose delivery is not a spendable asset in the owner's wallet (receipt, debt reduction, position, someone else's wallet). */
const NO_REUSABLE_OUTPUT: ReadonlySet<string> = new Set(['supply', 'repay', 'asset.transfer', 'vault.deposit',
  // Positions (and their two-token removals) are not one fungible delivery a single later input can bind to: explicit selection only.
  'asset.liquidity.concentrated', 'asset.liquidity.uniswap-v3', 'asset.liquidity.prepare']);

/** The asset a step delivers, as declared in its IR (the same declarations `followOnSelection` reads), or null. */
export function stepOutputAsset(node: Node): Asset | null {
  const declaration = node.inputs.find(input => input.kind === 'ASSET' && input.name === 'asset-out');
  if (declaration?.kind === 'ASSET') return declaration.value as Asset;
  return (node.expectedOutputs.find(item => item.outputId === 'amount-out')?.asset as Asset | undefined) ?? null;
}
export type StepOutput = { readonly kind: 'asset'; readonly asset: SequenceAsset; readonly label: string } | { readonly kind: 'none'; readonly reason: 'no-reusable-output' | 'other-recipient' };
/** What a step delivers that a later step may spend, by the sequence runtime's own identity rule. */
export function reusableOutput(node: Node): StepOutput {
  if (NO_REUSABLE_OUTPUT.has(node.actionType)) return { kind: 'none', reason: 'no-reusable-output' };
  const assets = stepAssets(node);
  if (!assets.output) return { kind: 'none', reason: 'no-reusable-output' };
  if (!assets.ownerReceives) return { kind: 'none', reason: 'other-recipient' };
  return { kind: 'asset', asset: assets.output, label: node.actionType };
}

export type StepProvenance =
  | { readonly state: 'independent' }
  | { readonly state: 'inherited'; readonly from: string; readonly fromIndex: number; readonly asset: SequenceAsset }
  | { readonly state: 'mismatch'; readonly from: string; readonly fromIndex: number; readonly reason: 'asset' | 'network' | 'no-reusable-output' | 'other-recipient' | 'consumer-draws' };
/**
 * How each connected step relates to the step(s) it is connected to: it uses an upstream output (inherited), it is connected but cannot use it
 * (mismatch, with the reason), or it is not connected (independent). Derived from the canonical graph only, so Chat and the Editor agree.
 */
export function stepProvenance(workflow: Workflow, nodeId: string): StepProvenance {
  const ordered = sequenceOrder(workflow), node = ordered.find(item => item.nodeId === nodeId);
  if (!node || !node.dependencies.length) return { state: 'independent' };
  const parents = node.dependencies.map(id => ordered.find(item => item.nodeId === id)).filter((item): item is Node => Boolean(item && financial(item)));
  if (!parents.length) return { state: 'independent' };
  const spends = stepAssets(node).inputs;
  // Withdraw and Borrow draw from Aave: they never spend (nor are capped by) an earlier delivery.
  const draws = node.actionType === 'withdraw' || node.actionType === 'borrow';
  let first: StepProvenance | null = null;
  for (const parent of parents) {
    const fromIndex = ordered.indexOf(parent), output = reusableOutput(parent);
    if (output.kind === 'none') { first ??= { state: 'mismatch', from: parent.nodeId, fromIndex, reason: output.reason }; continue; }
    if (draws) { first ??= { state: 'mismatch', from: parent.nodeId, fromIndex, reason: 'consumer-draws' }; continue; }
    const used = spends.find(input => sameSequenceAsset(input, output.asset));
    if (used) return { state: 'inherited', from: parent.nodeId, fromIndex, asset: output.asset };
    first ??= { state: 'mismatch', from: parent.nodeId, fromIndex, reason: spends.some(input => input.chainId === output.asset.chainId) ? 'asset' : 'network' };
  }
  return first ?? { state: 'independent' };
}
/**
 * One producer → consumer pair only (a consumer may have several parents): 'inherited' when the consumer spends exactly what this producer
 * delivers, 'mismatch' when it could but spends another asset/network, else why this producer's output cannot fund it.
 */
export function pairProvenance(producer: Node, consumer: Node): 'inherited' | 'mismatch' | 'no-reusable-output' | 'other-recipient' | 'consumer-draws' {
  const output = reusableOutput(producer);
  if (output.kind === 'none') return output.reason;
  if (consumer.actionType === 'withdraw' || consumer.actionType === 'borrow') return 'consumer-draws';
  return stepAssets(consumer).inputs.some(input => sameSequenceAsset(input, output.asset)) ? 'inherited' : 'mismatch';
}
/** The owner-facing explanation of a provenance (catalog messages; `{0}` is the upstream step number). */
export const PROVENANCE_MESSAGES: Readonly<Record<Exclude<StepProvenance['state'], 'independent'> | Extract<StepProvenance, { state: 'mismatch' }>['reason'], string>> = Object.freeze({
  // Never more than the card's own amount (workflow review): the runtime spends min(this amount, what step {0} actually delivered).
  inherited: 'Uses what step {0} delivers, up to this card\'s amount.',
  mismatch: 'Connected to step {0}.',
  asset: 'Connected to step {0}, but this step spends another asset. Choose the asset step {0} delivers to use its output.',
  network: 'Connected to step {0}, but this step runs on another network. Choose the network step {0} delivers on to use its output.',
  'no-reusable-output': 'Step {0} does not deliver an asset this step can spend; this step uses its own amount.',
  'other-recipient': 'Step {0} sends its output to another wallet; this step uses its own amount.',
  'consumer-draws': 'This step draws from Aave; it runs after step {0} with its own amount.',
});

/** A Bridge card's networks for spending `output` (source network and asset); null when no bridge network carries that asset. */
export function bridgeNetworksFor(output: SequenceAsset, current?: CanvasBridgeNetworks): { readonly networks: CanvasBridgeNetworks } | { readonly issue: 'network' | 'asset' } {
  const network = universalNetworkOfChain(output.chainId);
  const source = network ? UNIVERSAL_CANVAS_LABEL[network.key] : null;
  if (!network || !source || !(CANVAS_BRIDGE_NETWORK_OPTIONS.source as readonly string[]).includes(source)) return { issue: 'network' };
  const explicit = output.address === null ? network.native.symbol : `${output.address}@${output.decimals}`;
  let reference: string;
  try {
    const resolved = resolveUniversalAsset(network.key, explicit);
    if (resolved.asset.decimals !== output.decimals || (resolved.asset.kind === 'TOKEN') !== (output.address !== null)) return { issue: 'asset' };
    // A symbol is used only when it resolves back to the very same asset (otherwise the explicit address@decimals reference is kept).
    let symbolSame = false;
    try { symbolSame = JSON.stringify(resolveUniversalAsset(network.key, resolved.symbol).asset) === JSON.stringify(resolved.asset); } catch { symbolSame = false; }
    reference = symbolSame ? resolved.symbol : explicit;
  } catch { return { issue: 'asset' }; }
  // The destination stays the person's choice when it is a mainnet bridge network other than the new source; otherwise the picker's own order
  // (Base first), same ecosystem first, never a test network (bridge review).
  const destinations = CANVAS_BRIDGE_NETWORK_OPTIONS.destination as readonly string[];
  const universal = (label: string) => destinations.includes(label) && label !== source ? universalKeyOfCanvasLabel(label) : null;
  const keep = current && universal(current.destination) ? current.destination : null;
  const ordered = DESTINATION_ORDER.filter(label => universal(label));
  const destination = keep ?? ordered.find(label => UNIVERSAL_NETWORKS[universalKeyOfCanvasLabel(label)!].ecosystem === network.ecosystem) ?? ordered[0];
  if (!destination) return { issue: 'network' };
  // The received asset is named too (bridge review): the card shows and Apply authors the same pair; none means no default route for this asset.
  let outputAsset: string;
  try { outputAsset = defaultUniversalOutput(network.key, reference, universalKeyOfCanvasLabel(destination)!); } catch { return { issue: 'asset' }; }
  return { networks: { source: source as CanvasBridgeNetworks['source'], destination: destination as CanvasBridgeNetworks['destination'], inputAsset: reference, outputAsset } };
}

/** The unique terminal step of the draft (the one a newly added card follows), with what it delivers; null when there is no step. */
export function terminalStep(workflow: Workflow): { readonly node: Node; readonly output: StepOutput } | { readonly issue: 'ambiguous' } | null {
  const nodes = workflow.nodes.filter(financial);
  if (!nodes.length) return null;
  const sources = new Set([...nodes.flatMap(node => node.dependencies), ...workflow.resourceEdges.map(edge => edge.fromNodeId)]);
  const tails = nodes.filter(node => !sources.has(node.nodeId));
  if (tails.length !== 1) return { issue: 'ambiguous' };
  return { node: tails[0]!, output: reusableOutput(tails[0]!) };
}
/** A newly added Bridge card after the draft's terminal step: its networks from that step's output (WS04: Swap → Bridge). */
export function bridgeFollowOn(workflow: Workflow): { readonly networks?: CanvasBridgeNetworks; readonly issue?: 'network' | 'asset' | 'ambiguous' } | null {
  const tail = terminalStep(workflow);
  if (!tail) return null;
  if ('issue' in tail) return { issue: 'ambiguous' };
  if (tail.output.kind === 'none') return null;
  const result = bridgeNetworksFor(tail.output.asset);
  return 'issue' in result ? { issue: result.issue } : { networks: result.networks };
}

/**
 * The decimal amount a consumer is proposed when it inherits an upstream output: the upstream card's current live estimate of what it delivers
 * (`expected`, in the delivered asset's units), only while that estimate is for exactly this asset; null otherwise (the person enters the cap).
 * At execution the step spends min(this cap, the amount actually delivered).
 */
export function inheritedAmount(estimate: { readonly expected: string } | null | undefined, decimals: number, native = false): string | null {
  // A native coin (ETH, SOL) also pays the next step's network fee: its whole expected delivery is never proposed (swap review); the person enters it.
  if (native || !estimate || typeof estimate.expected !== 'string') return null;
  const value = estimate.expected.trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || /^0(\.0+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  // Never more precision than the asset carries (truncated down, so the cap never exceeds the estimate).
  const kept = fraction.slice(0, decimals).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole!;
}
