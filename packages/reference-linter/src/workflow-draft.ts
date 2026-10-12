// SPDX-License-Identifier: AGPL-3.0-only
import { validateArtifact } from '@defi-workflow-engine/workflow-contracts/schemas';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { baseAssetRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext, reviewContextForChain, type ReviewContext } from './context.js';
import { validateAuthoringWorkflow } from './validation.js';

/** Authoring may compose independently valid actions with ordering dependencies.
 * This grants no simulation/execution authority: runtime validators remain strict.
 * Typed asset links still require their existing complete composition validator.
 */
export function validateWorkflowDraft(input: unknown, context: ReviewContext): SemanticWorkflow {
  const workflow = validateArtifact('semantic-workflow', input);
  try { return validateAuthoringWorkflow(workflow, context); }
  catch (original) {
    if (workflow.resourceEdges.length || workflow.nodes.some(node => node.inputs.some(p => p.kind === 'OUTPUT_REFERENCE'))) throw original;
    for (const node of workflow.nodes) {
      validateAuthoringWorkflow({ ...workflow, nodes: [{ ...node, dependencies: [] }], resourceEdges: [] }, reviewContextForChain(node.chainId, node.chainId === 'eip155:8453' ? createReviewContext({ ...context, assets: baseAssetRegistry }) : context));
    }
    return workflow;
  }
}
