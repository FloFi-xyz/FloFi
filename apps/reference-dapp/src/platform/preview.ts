// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-DEVELOPER-001: the read-only simulation preview shared by every surface (moved from the MCP `simulate_strategy` handler
 * without change). It runs the existing flow's own simulation (`backend/preview.ts`) for exactly one composed step and returns
 * only the allowlisted projection (`projectSimulation`): nothing is persisted, signed or sent, and the result is never
 * authorizable.
 *
 * Simulations reach public chains and providers, so ONE per-instance concurrency cap protects them for MCP, the Developer API
 * and any later surface together (best effort, never a correctness rule). A surface may add its own budget (e.g. per account),
 * consulted after the busy check and before the slot is taken.
 */
import type { PreviewPlan, SimulationView } from '../mcp/simulation.ts';
import { previewPlan, projectSimulation } from '../mcp/simulation.ts';
import type { McpRuntime as EngineRuntime } from '../mcp/runtime.ts';
import type { Composition } from '../engine/strategy-engine';
import { PlatformRefusal, refuse } from './refusal.ts';
import { composeSingleStep, composeWorkflowOrRefuse } from './strategy.ts';
import type { NetworkScope } from '../domain/network-scope';
import { networkScope } from '../server/network-scope.ts';
import { UNIVERSAL_QUOTE_SUBJECTS as QUOTE_SUBJECTS } from '@defi-workflow-engine/workflow-contracts';

export const MAX_CONCURRENT_SIMULATIONS = 2;
let activeSimulations = 0;
/** Simulations running in this instance right now (all surfaces). */
export const activeSimulationCount = () => activeSimulations;

export type PreviewRequest = { readonly strategy: unknown; readonly workflowHash: string; readonly simulationSubject: string };
export type PreviewOptions = { readonly budget?: () => Promise<boolean>;
  /** BUILD-FLOFI-MAINNET-PRODUCT-001: the caller's network scope (default: this server's). */
  readonly scope?: NetworkScope };
export type SimulationPreview = { readonly composition: Composition; readonly plan: PreviewPlan; readonly view: SimulationView;
  /** The public account whose balances the preview read, or null when the flow reads none. Never an owner or an authorization. */
  readonly simulationSubject: string | null };

/**
 * Refusals: the composition's own code (with issues), `SIMULATE_ONE_STEP_AT_A_TIME`, the preview plan's code (e.g.
 * `SIMULATION_LOCAL_FORK_ONLY`), `SIMULATION_SUBJECT_INVALID`, `SIMULATION_BUSY`, `SIMULATION_RATE_LIMITED` (the caller's budget),
 * or the flow's own classified code.
 */
export async function simulatePreview(runtime: EngineRuntime, request: PreviewRequest, options: PreviewOptions = {}): Promise<SimulationPreview> {
  const c = composeSingleStep(request.strategy, request.workflowHash, 'SIMULATE_ONE_STEP_AT_A_TIME', options.scope ?? networkScope()), plan = previewPlan(c.strategy);
  if ('code' in plan) return refuse(plan.code);
  const evm = /^0x[0-9a-fA-F]{40}$/.test(request.simulationSubject);
  if (plan.subject === 'EVM' && !evm || plan.subject === 'SOLANA' && evm) return refuse('SIMULATION_SUBJECT_INVALID');
  if (activeSimulations >= MAX_CONCURRENT_SIMULATIONS) return refuse('SIMULATION_BUSY');
  if (options.budget && !await options.budget()) return refuse('SIMULATION_RATE_LIMITED');
  activeSimulations++;
  let preview;
  try {
    const subject = evm ? request.simulationSubject.toLowerCase() : request.simulationSubject;
    // BUILD-CROSSCHAIN-UNIVERSAL-001: a cross-ecosystem bridge needs a destination wallet; the preview uses the public quote subject (no key exists).
    const destination = plan.destinationSubject ? [QUOTE_SUBJECTS[plan.destinationSubject]] : [];
    preview = await runtime.preview(plan.flow, plan.subject === 'NONE' ? [c.workflow] : [c.workflow, subject, ...destination]);
  } finally { activeSimulations--; }
  if (!preview.ok) return refuse(preview.code);
  return { composition: c, plan, view: projectSimulation(plan.flow, preview.value), simulationSubject: plan.subject === 'NONE' ? null : request.simulationSubject };
}

export type WorkflowStepPreview = { readonly index: number; readonly workflowHash: string; readonly flow: string | null;
  readonly state: 'SIMULATED' | 'AWAITING_PRODUCER_SETTLEMENT' | 'FAILED'; readonly code: string | null;
  readonly amountFrom: readonly number[]; readonly simulationSubject: string | null; readonly subjectSource: 'REQUEST' | 'PUBLIC_QUOTE_SUBJECT' | 'NONE';
  readonly view: SimulationView | null };
/**
 * Preview an entire canonical sequence without asking the caller to manually split it. Every supported step uses its real flow
 * preview, with the same shared admission controls. These calls read today's state: a dependent step may lack the balance that a
 * preceding transaction will deliver. That is reported as pending settlement, never fabricated as a successful simulation. The
 * durable workflow runner re-simulates the exact received amount after reconciliation and before the next Manifest/signature.
 */
export async function simulateWorkflowPreview(runtime: EngineRuntime, request: PreviewRequest, options: PreviewOptions = {}) {
  const workflow = composeWorkflowOrRefuse(request.strategy, request.workflowHash, options.scope ?? networkScope());
  const steps: WorkflowStepPreview[] = [];
  for (const [index, composition] of workflow.steps.entries()) {
    const plan = previewPlan(composition.strategy), dependencies = workflow.bindings.filter(b => b.step === index).map(b => b.amountFrom);
    const evm = /^0x[0-9a-fA-F]{40}$/.test(request.simulationSubject);
    const subject = 'subject' in plan && plan.subject !== 'NONE'
      ? (plan.subject === 'EVM') === evm ? request.simulationSubject : QUOTE_SUBJECTS[plan.subject] : request.simulationSubject;
    const subjectSource = !('subject' in plan) || plan.subject === 'NONE' ? 'NONE' as const
      : subject === request.simulationSubject ? 'REQUEST' as const : 'PUBLIC_QUOTE_SUBJECT' as const;
    try {
      const preview = await simulatePreview(runtime, { strategy: composition.strategy, workflowHash: composition.workflowHash, simulationSubject: subject },
        { ...options.scope ? { scope: options.scope } : {}, ...index === 0 && options.budget ? { budget: options.budget } : {} });
      steps.push({ index, workflowHash: composition.workflowHash, flow: preview.plan.flow, state: 'SIMULATED', code: null, amountFrom: dependencies,
        simulationSubject: preview.simulationSubject, subjectSource, view: preview.view });
    } catch (cause) {
      const code = cause instanceof PlatformRefusal || cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? (cause as Error).message : 'SIMULATION_UNAVAILABLE';
      if (code === 'SIMULATION_BUSY' || code === 'SIMULATION_RATE_LIMITED') return refuse(code);
      const awaiting = dependencies.length > 0 && /INSUFFICIENT|BALANCE|NO_COLLATERAL|COLLATERAL_REQUIRED/.test(code);
      steps.push({ index, workflowHash: composition.workflowHash, flow: 'flow' in plan ? plan.flow : null,
        state: awaiting ? 'AWAITING_PRODUCER_SETTLEMENT' : 'FAILED', code, amountFrom: dependencies,
        simulationSubject: subjectSource === 'NONE' ? null : subject, subjectSource, view: null });
    }
  }
  return { workflowHash: workflow.workflowHash, fundsClass: workflow.fundsClass, stepCount: workflow.steps.length, steps,
    status: steps.every(step => step.state === 'SIMULATED') ? 'STEP_PREVIEWS_AVAILABLE' as const : 'INCOMPLETE' as const,
    executionSimulation: 'FRESH_PER_STEP_AFTER_PREVIOUS_RECONCILIATION' as const,
    authorizable: false as const, persisted: false as const };
}
