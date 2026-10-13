// SPDX-License-Identifier: AGPL-3.0-only
import { compositionBindingFor, projectCompositionProducer, readBoundComposition, SOLANA_DEVNET_SWAP_LIQUIDITY, type BoundComposition } from '@defi-workflow-engine/action-registry';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { validateSolanaSwapWorkflow } from './solana-swap.js';
import { validateSolanaLiquidityWorkflow } from './solana-liquidity.js';

const fail = (code: string): never => { throw new Error(code); };
const financial = (workflow: SemanticWorkflow) => workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
/**
 * Exactly two financial steps of a registered composition pair where the consumer depends on the producer, however that
 * link is declared. Unlinked steps keep the isolated validators' answers.
 */
export function isSolanaCompositionCandidate(workflow: SemanticWorkflow): boolean {
  const [a, b, ...rest] = financial(workflow);
  const linked = (producer: typeof a, consumer: typeof a) => Boolean(producer && consumer && consumer.dependencies.includes(producer.nodeId) && compositionBindingFor(producer, consumer));
  return Boolean(a && b && !rest.length && (linked(a, b) || linked(b, a)));
}
/**
 * The Solana Devnet Swap → Orca liquidity composition. The graph is closed (composition-bindings.ts), and each step must be
 * exactly what its existing isolated validator already accepts on its own: the swap byte for byte, the position with the
 * owner's authored maxima. A bound token needs a positive cap; the other pool token keeps an explicit maximum.
 */
export function validateSolanaCompositionWorkflow(workflow: SemanticWorkflow): BoundComposition {
  const composed = readBoundComposition(workflow);
  if (composed.binding.id !== SOLANA_DEVNET_SWAP_LIQUIDITY.id) fail('COMPOSITION_UNSUPPORTED');
  validateSolanaSwapWorkflow(projectCompositionProducer(workflow));
  const position = validateSolanaLiquidityWorkflow({ ...workflow, nodes: [composed.isolatedConsumer], resourceEdges: [] });
  if ((composed.source.token === 0 ? position.amount0Max : position.amount1Max) === '0') fail('SOLANA_COMPOSITION_CAP_REQUIRED');
  return composed;
}
