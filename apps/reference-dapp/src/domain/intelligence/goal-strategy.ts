// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001: a goal plan as FloFi's canonical strategy contract — one v1 strategy, or a v2 step list whose funded steps carry
 * typed bindings (`{ step, amountFrom }`: the step spends what the earlier step actually delivered, capped by its own amount). MCP, the Developer
 * contract and the parity tests compose it with the same deterministic engine (`composeWorkflow`) as every other strategy; nothing here
 * composes, quotes or authorizes by itself. A supply needs its beneficiary (Aave credits that account): the caller passes the owner's address
 * the user gave, or the plan asks for it — FloFi never substitutes one.
 */
import type { StrategyInput, StrategySpec } from '../../engine/strategy-spec';
import type { GoalStep } from './goal-planner';

export type GoalStrategy = { readonly ok: true; readonly strategy: StrategyInput } | { readonly ok: false; readonly code: 'GOAL_BENEFICIARY_REQUIRED' };
/** One plan step as a v1 strategy. Bridges: BEST is the universal router; otherwise the certified route's default routing. */
export function goalStepStrategy(step: GoalStep, beneficiary: string | null): StrategySpec | null {
  switch (step.action) {
    case 'swap': return { action: 'swap', network: step.network, inputAsset: step.inputAsset, outputAsset: step.outputAsset!, amount: step.amount } as StrategySpec;
    case 'bridge': return { action: 'bridge', sourceNetwork: step.network, destinationNetwork: step.destinationNetwork!, asset: step.inputAsset, amount: step.amount,
      ...step.routing === 'BEST' ? { routing: 'best', ...step.outputAsset ? { outputAsset: step.outputAsset } : {} } : { routing: 'auto' } } as StrategySpec;
    case 'supply': return beneficiary ? { action: 'supply', network: step.network, asset: step.inputAsset, amount: step.amount, beneficiary: beneficiary.toLowerCase() } as StrategySpec : null;
  }
}
/** The whole plan as one strategy input (v1 for one step, v2 with bindings for several). */
export function goalStrategy(steps: readonly GoalStep[], beneficiary: string | null): GoalStrategy {
  const specs = steps.map(step => goalStepStrategy(step, beneficiary));
  if (specs.some(spec => spec === null)) return { ok: false, code: 'GOAL_BENEFICIARY_REQUIRED' };
  if (specs.length === 1) return { ok: true, strategy: { version: 1, ...specs[0]! } as StrategySpec };
  const bindings = steps.flatMap((step, index) => step.fundedBy === null ? [] : [{ step: index, amountFrom: step.fundedBy }]);
  return { ok: true, strategy: { version: 2, steps: specs as StrategySpec[], ...bindings.length ? { bindings } : {} } as StrategyInput };
}
