// SPDX-License-Identifier: AGPL-3.0-only
import { validateArtifact } from '@defi-workflow-engine/workflow-contracts/schemas';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { baseAssetRegistry, isBoundComposition } from '@defi-workflow-engine/action-registry';
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
    const typed = workflow.nodes.filter(node => node.inputs.some(p => p.kind === 'OUTPUT_REFERENCE'));
    // A registered bound composition is the one typed link a draft may hold beside other steps: the linked pair itself must be a
    // complete, valid composition; every other step is checked on its own below, as before.
    const consumer = typed.length === 1 && workflow.resourceEdges.length === 1 ? typed[0]! : null;
    const producer = consumer ? workflow.nodes.find(node => node.nodeId === consumer.dependencies[0]) : undefined;
    const pair = consumer && producer ? { ...workflow, nodes: [producer, consumer], resourceEdges: workflow.resourceEdges } : null;
    if (workflow.resourceEdges.length || typed.length) {
      if (!pair || !isBoundComposition(pair)) throw original;
      validateAuthoringWorkflow(pair, reviewContextForChain(producer!.chainId, context));
    }
    for (const node of workflow.nodes) {
      if (pair?.nodes.includes(node)) continue;
      validateAuthoringWorkflow({ ...workflow, nodes: [{ ...node, dependencies: [] }], resourceEdges: [] }, reviewContextForChain(node.chainId, node.chainId === 'eip155:8453' ? createReviewContext({ ...context, assets: baseAssetRegistry }) : context));
    }
    return workflow;
  }
}
