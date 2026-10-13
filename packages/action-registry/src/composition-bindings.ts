// SPDX-License-Identifier: Apache-2.0
import { CONCENTRATED_LIQUIDITY_ACTION, EXACT_INPUT_SWAP_ACTION, bindConcentratedLiquidityNode, createConcentratedLiquidityNode, readConcentratedLiquidity,
  readConcentratedLiquiditySource, readExactInputSwap, type ConcentratedLiquiditySource, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { ORCA_WHIRLPOOLS_DEVNET } from './solana-devnet.js';
import { ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY } from './orca-liquidity-devnet.js';

/**
 * Bound compositions: two existing isolated actions in sequence, where the producer's actual reconciled output caps one
 * input of the consumer. A composition is executable only when its exact pair is registered here; registration names
 * the flow that runs it and never grants authority by itself. Each step still runs on its own existing isolated runtime,
 * through a deterministic single-node projection of the composed workflow, with its own Review and wallet signature.
 */
type Node = SemanticWorkflow['nodes'][number];
type DeepReadonly<T> = T extends readonly (infer E)[] ? readonly DeepReadonly<E>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
/** Authoring state is deeply readonly; every helper here accepts it and never mutates a node. */
type AnyNode = Node | DeepReadonly<Node>;
type WorkflowLike = { readonly workflowId?: string; readonly revision?: number; readonly schemaVersion?: string; readonly nodes: readonly AnyNode[];
  readonly resourceEdges?: readonly DeepReadonly<SemanticWorkflow['resourceEdges'][number]>[] };
export type CompositionBinding = {
  readonly id: string; readonly chain: string; readonly network: string; readonly flow: string; readonly label: string;
  readonly producer: { readonly actionType: string; readonly protocol: string; readonly outputId: string; readonly label: string };
  readonly consumer: { readonly actionType: string; readonly protocol: string; readonly label: string };
};
/** Solana Devnet: an Orca Whirlpools exact-input swap whose output funds one side of an Orca Whirlpools position on the same pool. */
export const SOLANA_DEVNET_SWAP_LIQUIDITY: CompositionBinding = Object.freeze({
  id: 'solana-devnet.orca-swap.orca-liquidity', chain: ORCA_WHIRLPOOLS_DEVNET.chain, network: ORCA_WHIRLPOOLS_DEVNET.network, flow: 'solana-devnet-composition',
  label: 'Swap → Add liquidity',
  producer: Object.freeze({ actionType: EXACT_INPUT_SWAP_ACTION, protocol: ORCA_WHIRLPOOLS_DEVNET.protocol, outputId: 'amount-out', label: 'Swap' }),
  consumer: Object.freeze({ actionType: CONCENTRATED_LIQUIDITY_ACTION, protocol: ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY.protocol, label: 'Add liquidity' }),
});
export const COMPOSITION_BINDINGS: readonly CompositionBinding[] = Object.freeze([SOLANA_DEVNET_SWAP_LIQUIDITY]);

const fail = (code: string): never => { throw new Error(code); };
const financial = (node: { readonly actionType: string }) => !node.actionType.startsWith('mock-');
const provider = (node: AnyNode, actionType: string, protocol: string, chain: string) => node.actionType === actionType && node.chainId === chain &&
  node.adapterConstraints.adapters.length === 0 && node.adapterConstraints.protocols.length === 1 && node.adapterConstraints.protocols[0] === protocol;
const sameToken = (a: { address: string; decimals: number; chainId: string }, b: { address: string; decimals: number; chainId: string }) =>
  a.address === b.address && a.decimals === b.decimals && a.chainId === b.chainId;
/** The consumer token the producer's output becomes, by exact token identity; null when it is neither pool token. */
function tokenFor(producer: AnyNode, consumer: AnyNode): 0 | 1 | null {
  let output, pool;
  try { output = readExactInputSwap(producer as never).output; pool = readConcentratedLiquidity(readConcentratedLiquiditySource(consumer as never).node); }
  catch { return null; }
  return sameToken(output, pool.token0) ? 0 : sameToken(output, pool.token1) ? 1 : null;
}

/** For authoring: whether linking `producer` → `consumer` forms a registered composition, and which consumer token the link binds. */
export function compositionBindingFor(producer: AnyNode, consumer: AnyNode): { readonly binding: CompositionBinding; readonly token: 0 | 1 } | null {
  for (const binding of COMPOSITION_BINDINGS) {
    if (!provider(producer, binding.producer.actionType, binding.producer.protocol, binding.chain) ||
        !provider(consumer, binding.consumer.actionType, binding.consumer.protocol, binding.chain)) continue;
    const token = tokenFor(producer, consumer);
    if (token !== null) return { binding, token };
  }
  return null;
}

export type BoundComposition = { readonly binding: CompositionBinding; readonly producer: Node; readonly consumer: Node; readonly source: ConcentratedLiquiditySource;
  /** The consumer exactly as an isolated runtime declares it, with the owner's authored cap for the bound token. */
  readonly isolatedConsumer: Node };
/**
 * The closed shape of a bound composition: exactly two financial nodes of a registered pair; the producer depends on
 * nothing; the consumer depends only on the producer through its single typed source input and the one matching resource
 * edge; the producer's output token is the bound consumer token; authoring templates may coexist but never connect to
 * either financial node. Anything else is not a bound composition.
 */
export function readBoundComposition(workflow: WorkflowLike): BoundComposition {
  const nodes = workflow.nodes.filter(financial), edges = workflow.resourceEdges ?? [];
  if (nodes.length !== 2) return fail('COMPOSITION_GRAPH_INVALID');
  const consumer = nodes.find(node => node.dependencies.length === 1), producer = nodes.find(node => node !== consumer);
  if (!consumer || !producer || producer.dependencies.length !== 0 || consumer.dependencies[0] !== producer.nodeId) return fail('COMPOSITION_GRAPH_INVALID');
  const match = compositionBindingFor(producer, consumer);
  if (!match) return fail('COMPOSITION_UNSUPPORTED');
  let split: ReturnType<typeof readConcentratedLiquiditySource>;
  try { split = readConcentratedLiquiditySource(consumer as never); } catch { return fail('COMPOSITION_GRAPH_INVALID'); }
  const source = split.source;
  if (!source || source.nodeId !== producer.nodeId || source.outputId !== match.binding.producer.outputId || source.token !== match.token) return fail('COMPOSITION_GRAPH_INVALID');
  const ids = new Set([producer.nodeId, consumer.nodeId]);
  const touching = edges.filter(edge => ids.has(edge.fromNodeId) || ids.has(edge.toNodeId));
  const edge = touching[0];
  if (touching.length !== 1 || edge?.fromNodeId !== producer.nodeId || edge.outputId !== source.outputId || edge.toNodeId !== consumer.nodeId ||
      edge.inputName !== consumer.inputs.at(-1)?.name || workflow.nodes.some(node => !financial(node) && node.dependencies.some(id => ids.has(id))))
    return fail('COMPOSITION_GRAPH_INVALID');
  return { binding: match.binding, producer: producer as Node, consumer: consumer as Node, source, isolatedConsumer: split.node as Node };
}
/** True when the workflow is exactly a registered bound composition (no throw). */
export function isBoundComposition(workflow: WorkflowLike): boolean {
  try { readBoundComposition(workflow); return true; } catch { return false; }
}

/** The bound node for an isolated consumer, or the isolated consumer again (used by the editor to link and unlink). */
export function bindCompositionConsumer(consumer: AnyNode, producer: AnyNode): Node {
  const match = compositionBindingFor(producer, consumer) ?? fail('COMPOSITION_UNSUPPORTED');
  return bindConcentratedLiquidityNode(consumer as never, { token: match.token, nodeId: producer.nodeId, outputId: match.binding.producer.outputId }) as Node;
}
export const unbindCompositionConsumer = (consumer: AnyNode): Node => readConcentratedLiquiditySource(consumer as never).node as Node;

const single = (workflow: WorkflowLike, node: AnyNode): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: workflow.workflowId ?? fail('COMPOSITION_GRAPH_INVALID'),
  revision: workflow.revision ?? fail('COMPOSITION_GRAPH_INVALID'), nodes: [node as Node], resourceEdges: [] });
/** The producer step as its existing isolated runtime receives it: the same node bytes, alone. */
export function projectCompositionProducer(workflow: WorkflowLike): SemanticWorkflow {
  return single(workflow, readBoundComposition(workflow).producer);
}
/**
 * The consumer step as its existing isolated runtime receives it: the same node with the bound token's maximum set to
 * min(owner cap, reconciled producer output). Only a verified, reconciled amount may be passed here.
 */
export function projectCompositionConsumer(workflow: WorkflowLike, reconciledOutput: string): SemanticWorkflow {
  const composed = readBoundComposition(workflow);
  if (typeof reconciledOutput !== 'string' || !/^[1-9][0-9]{0,77}$/.test(reconciledOutput)) return fail('COMPOSITION_BOUND_AMOUNT_INVALID');
  const fields = readConcentratedLiquidity(composed.isolatedConsumer as never);
  const key = composed.source.token === 0 ? 'amount0Max' : 'amount1Max', cap = BigInt(fields[key]), received = BigInt(reconciledOutput);
  const bound = received < cap ? received : cap;
  return single(workflow, createConcentratedLiquidityNode(composed.consumer.nodeId, { ...fields, [key]: bound.toString() }) as Node);
}
/** The owner's authored cap of the bound token (raw units). */
export function compositionCap(workflow: WorkflowLike): string {
  const composed = readBoundComposition(workflow), fields = readConcentratedLiquidity(composed.isolatedConsumer as never);
  return composed.source.token === 0 ? fields.amount0Max : fields.amount1Max;
}
