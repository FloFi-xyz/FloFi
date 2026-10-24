// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-DEVELOPER-001: strategy composition, validation and review on the deterministic engine facade, shared by every surface
 * (moved from the MCP tool handlers of BUILD-MCP-001/002 without change). A strategy is a v1 single action or a v2 step list; one
 * step is exactly the v1 composition (same canonical strategy, same workflow hash). Nothing here quotes, simulates, authorizes,
 * signs or submits.
 */
import { composeWorkflowBound, reviewComposition, type Composition, type StrategyFinding, type WorkflowComposition } from '../engine/strategy-engine';
import { TEST_NETWORK_IDS, type NetworkId, type StrategySpec } from '../engine/strategy-spec';
import { mainnetCounterpart, TEST_NETWORK_NOT_AVAILABLE, type NetworkScope } from '../domain/network-scope';
import { networkScope } from '../server/network-scope.ts';
import { refuse } from './refusal.ts';

/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001: the test networks a composed workflow names (every step's network, a bridge's source and destination), and
 * the mainnet of each one's family. The public product composes, validates, reviews, simulates and hands off mainnet workflows only.
 */
export function strategyTestNetworks(workflow: Pick<WorkflowComposition, 'steps'>): readonly { readonly network: NetworkId; readonly mainnet: string | null; readonly path: string }[] {
  const found: { network: NetworkId; mainnet: string | null; path: string }[] = [];
  workflow.steps.forEach((step, index) => {
    const spec = step.strategy as StrategySpec & { network?: NetworkId; sourceNetwork?: NetworkId; destinationNetwork?: NetworkId };
    const prefix = workflow.steps.length > 1 ? `/steps/${index}` : '';
    for (const field of ['network', 'sourceNetwork', 'destinationNetwork'] as const) {
      const network = spec[field];
      if (network && TEST_NETWORK_IDS.includes(network)) found.push({ network, mainnet: mainnetCounterpart(network)?.key ?? null, path: `${prefix}/${field}` });
    }
  });
  return found;
}
/** The composed workflow (v1 strategy or v2 step list), bound to `workflowHash` when given; a refusal carries the schema issues. */
export function composeWorkflowOrRefuse(strategy: unknown, workflowHash: string | undefined, scope: NetworkScope = networkScope()): WorkflowComposition {
  const result = composeWorkflowBound(strategy, workflowHash);
  if (!result.ok) return refuse(result.code, { issues: result.issues });
  const test = scope === 'ENGINEERING' ? [] : strategyTestNetworks(result);
  // A test-network strategy is never mapped to its mainnet: that would turn test funds into real funds. The client names the mainnet itself.
  return test.length ? refuse(TEST_NETWORK_NOT_AVAILABLE, { issues: test.map(t => ({ path: t.path, rule: 'mainnetOnly' })),
    networks: [...new Set(test.map(t => t.network))], mainnets: [...new Set(test.map(t => t.mainnet).filter((m): m is string => m !== null))] }) : result;
}
/** The single-step composition, or a refusal naming the per-step alternative (for operations that work on one action). */
export function composeSingleStep(strategy: unknown, workflowHash: string | undefined, multiStepCode: string, scope: NetworkScope = networkScope()): Composition {
  const workflow = composeWorkflowOrRefuse(strategy, workflowHash, scope);
  return workflow.steps.length === 1 ? workflow.steps[0]! : refuse(multiStepCode, { stepCount: workflow.steps.length });
}
export const reviewCounts = (findings: readonly { level: string }[]) => ({ block: findings.filter(f => f.level === 'BLOCK').length,
  warning: findings.filter(f => f.level === 'WARNING').length, information: findings.filter(f => f.level === 'INFORMATION').length });
/** The public view of a composition's workflow steps. */
export const stepViews = (c: Composition) => c.steps.map(s => ({ index: s.index, nodeId: s.nodeId, kind: s.kind, protocol: s.protocol, network: s.network,
  testFunds: s.testFunds, failurePolicy: s.failurePolicy, authorizationClass: s.authorization, detail: s.detail }));

export type StrategyValidation =
  | { readonly valid: false; readonly code: string; readonly issues: readonly { readonly path: string; readonly rule: string }[] }
  | { readonly valid: true; readonly workflowHash: string; readonly fundsClass: WorkflowComposition['fundsClass']; readonly notes: readonly string[];
      readonly stepCount: number; readonly reviewSummary: { readonly block: number; readonly warning: number } };
/** Authoring rules plus, when given, the workflow hash the caller saw: never a refusal, always a verdict. */
export function validateStrategy(strategy: unknown, workflowHash: string | undefined, scope: NetworkScope = networkScope()): StrategyValidation {
  const result = composeWorkflowBound(strategy, workflowHash);
  if (!result.ok) return { valid: false, code: result.code, issues: result.issues };
  const test = scope === 'ENGINEERING' ? [] : strategyTestNetworks(result);
  if (test.length) return { valid: false, code: TEST_NETWORK_NOT_AVAILABLE, issues: test.map(t => ({ path: t.path, rule: 'mainnetOnly' })) };
  const findings = result.steps.flatMap(c => reviewComposition(c).findings), counts = reviewCounts(findings);
  return { valid: true, workflowHash: result.workflowHash, fundsClass: result.fundsClass, notes: result.notes, stepCount: result.steps.length,
    reviewSummary: { block: counts.block, warning: counts.warning } };
}

export type StepReview = { readonly index: number; readonly workflowHash: string; readonly environment: ReturnType<typeof reviewComposition>['environment'];
  readonly summary: ReturnType<typeof reviewCounts>; readonly findings: readonly StrategyFinding[]; readonly capability: ReturnType<typeof reviewComposition>['capability'] };
/** The deterministic Strategy Review of every step, and the counts over all of them. It explains; it never approves. */
export function reviewWorkflow(workflow: WorkflowComposition): { readonly steps: readonly StepReview[]; readonly summary: ReturnType<typeof reviewCounts> } {
  const reviews = workflow.steps.map(c => reviewComposition(c));
  return { summary: reviewCounts(reviews.flatMap(r => r.findings)),
    steps: reviews.map((review, index) => ({ index, workflowHash: workflow.steps[index]!.workflowHash, environment: review.environment,
      summary: reviewCounts(review.findings), findings: review.findings, capability: review.capability })) };
}
