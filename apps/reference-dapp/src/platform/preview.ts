// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-DEVELOPER-001: the read-only simulation preview shared by every surface (moved from the MCP `simulate_strategy` handler
 * without change). It runs the existing flow's own simulation (`backend/preview.ts`) for exactly one composed step and returns
 * only the allowlisted projection (`projectSimulation`): nothing is persisted, signed or sent, and the result is never
 * authorizable.
 *
 * Simulations reach public chains and providers, so ONE per-instance concurrency cap protects them for MCP, the Developer API
 * and any later surface together (best effort, never a correctness rule). A surface may add its own budget (e.g. per account),
 * consulted once a slot is granted (see `simulationAdmission`).
 */
import type { PreviewPlan, SimulationView } from '../mcp/simulation.ts';
import { previewPlan, projectJupiterMarketQuote, projectSimulation } from '../mcp/simulation.ts';
import type { McpRuntime as EngineRuntime } from '../mcp/runtime.ts';
import type { Composition } from '../engine/strategy-engine';
import { PlatformRefusal, refuse } from './refusal.ts';
import { composeSingleStep, composeWorkflowOrRefuse } from './strategy.ts';
import type { NetworkScope } from '../domain/network-scope';
import { networkScope } from '../server/network-scope.ts';
import { operationWalletAddress, resolveOperationWallet } from '../domain/wallet-inventory.ts';
import type { WalletRef } from './handoff-store.ts';
import { UNIVERSAL_QUOTE_SUBJECTS } from '@defi-workflow-engine/workflow-contracts';

/**
 * P0 catalog reliability (P0-E): three simultaneous read-only MCP simulations (an Arbitrum swap, a Base → Arbitrum bridge and a Base Aave supply)
 * met a cap of 2 slots per instance that refused the third at once with SIMULATION_BUSY, although alone it took ~5.7 s. A slot here is a wait on
 * the API (remote mode) or on the embedded backend, whose own previews are paced per flow and coalesced when identical (backend/app.ts), so:
 * - the default cap is 4 per instance, configurable with `FLOFI_SIMULATION_CONCURRENCY` (1–16; anything else keeps the default);
 * - a request that finds every slot taken waits in a short FIFO (at most `FLOFI_SIMULATION_WAIT_MS`, default 5 s, 0–15 s; at most 8 waiting)
 *   and is refused with SIMULATION_BUSY only when no slot frees in time or the queue is full.
 * The caller's own budget (e.g. MCP's per-account hourly limit) is consulted once a slot is granted when one is free at once, and BEFORE queueing
 * otherwise, so a caller whose budget is spent never occupies a waiting seat (a queued request that then times out with BUSY has spent one unit).
 * A caller whose own request ends while it waits (`options.signal`, e.g. the MCP request budget) leaves the queue at once and spends nothing.
 */
export const MAX_CONCURRENT_SIMULATIONS = 4;
export const SIMULATION_SLOT_WAIT_MS = 5_000;
const MAX_WAITING_SIMULATIONS = 8;
type Env = Readonly<Record<string, string | undefined>>;
const bounded = (raw: string | undefined, minimum: number, maximum: number, fallback: number) =>
  raw !== undefined && /^[0-9]{1,6}$/.test(raw) && Number(raw) >= minimum && Number(raw) <= maximum ? Number(raw) : fallback;
/** This instance's simulation admission: concurrent slots and the longest wait for one. */
export function simulationAdmission(env: Env = process.env): { readonly slots: number; readonly waitMs: number } {
  return { slots: bounded(env.FLOFI_SIMULATION_CONCURRENCY, 1, 16, MAX_CONCURRENT_SIMULATIONS), waitMs: bounded(env.FLOFI_SIMULATION_WAIT_MS, 0, 15_000, SIMULATION_SLOT_WAIT_MS) };
}
let activeSimulations = 0;
const waitingForSlot: (() => void)[] = [];
/** Simulations running in this instance right now (all surfaces). */
export const activeSimulationCount = () => activeSimulations;
/** Requests waiting for a simulation slot right now. */
export const waitingSimulationCount = () => waitingForSlot.length;
type Admission = 'GRANTED' | 'SIMULATION_BUSY' | 'SIMULATION_RATE_LIMITED' | 'SIMULATION_CANCELLED';
/** Takes a slot (now, or after a bounded wait) and consults the caller's budget; on any answer but GRANTED no slot is held. */
async function admitSimulation(budget: PreviewOptions['budget'], signal: AbortSignal | undefined): Promise<Admission> {
  if (signal?.aborted) return 'SIMULATION_CANCELLED';
  const { slots, waitMs } = simulationAdmission();
  if (activeSimulations < slots && !waitingForSlot.length) {
    activeSimulations++;
    let allowed: boolean;
    try { allowed = !budget || await budget(); } catch (error) { releaseSimulationSlot(); throw error; }
    if (signal?.aborted) { releaseSimulationSlot(); return 'SIMULATION_CANCELLED'; }
    if (!allowed) { releaseSimulationSlot(); return 'SIMULATION_RATE_LIMITED'; }
    return 'GRANTED';
  }
  if (waitMs === 0 || waitingForSlot.length >= MAX_WAITING_SIMULATIONS) return 'SIMULATION_BUSY';
  if (budget && !await budget()) return 'SIMULATION_RATE_LIMITED';
  if (signal?.aborted) return 'SIMULATION_CANCELLED';
  // Review fix: the budget await can take a database round trip. Everything seen before it is re-checked after it: a slot that freed meanwhile is
  // taken at once (nobody would ever hand it to a waiter otherwise), and the waiting bound is enforced on the queue as it is now.
  const now = simulationAdmission();
  if (activeSimulations < now.slots && !waitingForSlot.length) { activeSimulations++; return 'GRANTED'; }
  if (waitingForSlot.length >= MAX_WAITING_SIMULATIONS) return 'SIMULATION_BUSY';
  return new Promise<Admission>(resolve => {
    const leaveQueue = () => { const at = waitingForSlot.indexOf(grant); if (at >= 0) waitingForSlot.splice(at, 1); clearTimeout(timer); signal?.removeEventListener('abort', cancelled); };
    const grant = () => { leaveQueue(); activeSimulations++; resolve('GRANTED'); };
    const cancelled = () => { leaveQueue(); resolve('SIMULATION_CANCELLED'); };
    const timer = setTimeout(() => { leaveQueue(); resolve('SIMULATION_BUSY'); }, waitMs);
    signal?.addEventListener('abort', cancelled, { once: true });
    waitingForSlot.push(grant);
    dispatchWaiters();
  });
}
/** Hands every free slot to the next waiter (first come, first served): waiters exist only while every slot is taken. */
function dispatchWaiters(): void {
  while (activeSimulations < simulationAdmission().slots && waitingForSlot.length) waitingForSlot[0]!();
}
function releaseSimulationSlot(): void {
  activeSimulations--;
  // The next waiters take the freed slots (first come, first served) while the cap allows it.
  dispatchWaiters();
}

export type PreviewRequest = { readonly strategy: unknown; readonly workflowHash: string; readonly simulationSubject?: string;
  readonly simulationSubjects?: Partial<Record<'evm' | 'solana', string>> };
export type PreviewOptions = { readonly budget?: () => Promise<boolean>;
  /** Verified wallets for which this caller may read balances. They authorize no financial action. */
  readonly simulationWallets?: readonly WalletRef[] | (() => Promise<readonly WalletRef[]>);
  /** The caller's own request ended (P0-E review): a queued preview leaves the queue and a multi-step preview starts no further step. */
  readonly signal?: AbortSignal;
  /** BUILD-FLOFI-MAINNET-PRODUCT-001: the caller's network scope (default: this server's). */
  readonly scope?: NetworkScope };
export type SimulationPreview = { readonly composition: Composition; readonly plan: PreviewPlan; readonly view: SimulationView;
  /** The public account whose balances the preview read, or null when the flow reads none. Never an owner or an authorization. */
  readonly simulationSubject: string | null };

type WalletSubject = Exclude<PreviewPlan['subject'], 'NONE'>;
const subjectEcosystem = (subject: WalletSubject) => subject === 'SOLANA' ? 'solana' as const : 'evm' as const;
async function linkedSubject(subject: WalletSubject, wallets: PreviewOptions['simulationWallets']) {
  const ns = subject === 'SOLANA' ? 'solana' : 'eip155';
  const available = typeof wallets === 'function' ? await wallets() : wallets ?? [];
  return resolveOperationWallet(subjectEcosystem(subject), available.filter(wallet => wallet.namespace === ns).map(wallet => wallet.address));
}
const requiredSubjectCode = (subject: WalletSubject) => subject === 'SOLANA' ? 'SOLANA_WALLET_REQUIRED' : 'EVM_WALLET_REQUIRED';

type SubjectBinding = { readonly address: string | null; readonly source: WorkflowStepPreview['subjectSource'] };
async function previewSubject(plan: PreviewPlan, request: PreviewRequest, options: PreviewOptions, multi: boolean): Promise<SubjectBinding> {
  const required = plan.subject;
  if (required === 'NONE') return { address: null, source: 'NONE' };
  const ecosystem = subjectEcosystem(required), explicit = request.simulationSubjects?.[ecosystem];
  const supplied = explicit ?? request.simulationSubject;
  const address = operationWalletAddress(ecosystem, supplied);
  if (address) return { address, source: 'REQUEST' };
  const oppositeJupiterSubject = plan.flow === 'jupiter-swap' && operationWalletAddress('evm', supplied) !== null;
  if (explicit !== undefined || !multi && supplied !== undefined && !oppositeJupiterSubject) return refuse('SIMULATION_SUBJECT_INVALID');
  const linked = await linkedSubject(required, options.simulationWallets);
  if (linked.kind === 'RESOLVED') return { address: linked.address, source: 'ACCOUNT_WALLET' };
  if (plan.flow === 'jupiter-swap') return { address: null, source: 'PUBLIC_QUOTE_SUBJECT' };
  return refuse(requiredSubjectCode(required));
}

/**
 * Refusals: the composition's own code (with issues), `SIMULATE_ONE_STEP_AT_A_TIME`, the preview plan's code (e.g.
 * `SIMULATION_LOCAL_FORK_ONLY`), `SIMULATION_SUBJECT_INVALID`, `SIMULATION_BUSY`, `SIMULATION_RATE_LIMITED` (the caller's budget),
 * or the flow's own classified code.
 */
export async function simulatePreview(runtime: EngineRuntime, request: PreviewRequest, options: PreviewOptions = {}): Promise<SimulationPreview> {
  const c = composeSingleStep(request.strategy, request.workflowHash, 'SIMULATE_ONE_STEP_AT_A_TIME', options.scope ?? networkScope()), plan = previewPlan(c.strategy);
  if ('code' in plan) return refuse(plan.code);
  const binding = await previewSubject(plan, request, options, false);
  return previewBoundStep(runtime, c, plan, binding, request, options);
}

async function previewBoundStep(runtime: EngineRuntime, c: Composition, plan: PreviewPlan, binding: SubjectBinding,
  request: PreviewRequest, options: PreviewOptions): Promise<SimulationPreview> {
  let destination: string | null = null;
  if (plan.destinationSubject) {
    const explicit = request.simulationSubjects?.[subjectEcosystem(plan.destinationSubject)];
    if (explicit !== undefined) {
      destination = operationWalletAddress(subjectEcosystem(plan.destinationSubject), explicit);
      if (!destination) return refuse('SIMULATION_SUBJECT_INVALID');
    } else {
      const linked = await linkedSubject(plan.destinationSubject, options.simulationWallets);
      if (linked.kind !== 'RESOLVED') return refuse('UNIVERSAL_DESTINATION_WALLET_REQUIRED');
      destination = linked.address;
    }
  }
  const admission = await admitSimulation(options.budget, options.signal);
  if (admission !== 'GRANTED') return refuse(admission);
  const quote = binding.source === 'PUBLIC_QUOTE_SUBJECT', subject = binding.address;
  let preview;
  try {
    preview = quote ? await runtime.preview(plan.flow, [c.workflow, UNIVERSAL_QUOTE_SUBJECTS.SOLANA], 'QUOTE', options.signal)
      : await runtime.preview(plan.flow, subject ? [c.workflow, subject, ...destination ? [destination] : []] : [c.workflow], undefined, options.signal);
  } finally { releaseSimulationSlot(); }
  if (!preview.ok) return refuse(preview.code);
  return { composition: c, plan, view: quote ? projectJupiterMarketQuote(preview.value) : projectSimulation(plan.flow, preview.value), simulationSubject: subject };
}

export type WorkflowStepPreview = { readonly index: number; readonly workflowHash: string; readonly flow: string | null;
  readonly state: 'SIMULATED' | 'AWAITING_PRODUCER_SETTLEMENT' | 'NOT_COMPLETED' | 'FAILED'; readonly code: string | null;
  readonly amountFrom: readonly number[]; readonly simulationSubject: string | null; readonly subjectSource: 'REQUEST' | 'PUBLIC_QUOTE_SUBJECT' | 'ACCOUNT_WALLET' | 'NONE';
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
  let budget: Promise<boolean> | undefined;
  const consumeBudget = options.budget;
  const stepOptions = { ...options, ...consumeBudget ? { budget: () => budget ??= consumeBudget() } : {} };
  for (const [index, composition] of workflow.steps.entries()) {
    // The caller's request ended: no further step is started (its answer has already been given).
    if (options.signal?.aborted) return refuse('SIMULATION_CANCELLED');
    const plan = previewPlan(composition.strategy), dependencies = workflow.bindings.filter(b => b.step === index).map(b => b.amountFrom);
    let binding: SubjectBinding = { address: null, source: 'NONE' };
    try {
      if ('code' in plan) throw new PlatformRefusal(plan.code);
      binding = await previewSubject(plan, request, stepOptions, true);
      const preview = await previewBoundStep(runtime, composition, plan, binding, request, stepOptions);
      const marketOnly = binding.source === 'PUBLIC_QUOTE_SUBJECT';
      steps.push({ index, workflowHash: composition.workflowHash, flow: preview.plan.flow, state: marketOnly ? 'NOT_COMPLETED' : 'SIMULATED',
        code: marketOnly ? 'SOLANA_WALLET_REQUIRED' : null, amountFrom: dependencies,
        simulationSubject: binding.address, subjectSource: binding.source, view: preview.view });
    } catch (cause) {
      const code = cause instanceof PlatformRefusal || cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? (cause as Error).message : 'SIMULATION_UNAVAILABLE';
      if (code === 'SIMULATION_BUSY' || code === 'SIMULATION_RATE_LIMITED' || code === 'SIMULATION_CANCELLED') return refuse(code);
      // The whole request's deadline (or its client leaving) ends the preview: the caller answers it, no later step is started.
      if (code === 'MCP_REQUEST_TIMEOUT' || code === 'MCP_REQUEST_CANCELLED') throw cause;
      const awaiting = dependencies.length > 0 && /INSUFFICIENT|BALANCE|NO_COLLATERAL|COLLATERAL_REQUIRED/.test(code);
      // BUILD-FLOFI-E2E-RELIABILITY-001 (MCP review): a step whose read ran out of time did not fail — it did not finish.
      const unfinished = /^(MCP_UPSTREAM_TIMEOUT|CLOUD_PREVIEW_TIMEOUT|CLOUD_API_DEADLINE_EXCEEDED|UNIVERSAL_DESTINATION_WALLET_REQUIRED|SOLANA_WALLET_REQUIRED|EVM_WALLET_REQUIRED|SIMULATION_REQUIRES_OWNER_BROWSER)$/.test(code);
      steps.push({ index, workflowHash: composition.workflowHash, flow: 'flow' in plan ? plan.flow : null,
        state: awaiting ? 'AWAITING_PRODUCER_SETTLEMENT' : unfinished ? 'NOT_COMPLETED' : 'FAILED', code, amountFrom: dependencies,
        simulationSubject: binding.address, subjectSource: binding.source, view: null });
    }
  }
  return { workflowHash: workflow.workflowHash, fundsClass: workflow.fundsClass, stepCount: workflow.steps.length, steps,
    status: steps.every(step => step.state === 'SIMULATED') ? 'STEP_PREVIEWS_AVAILABLE' as const : 'INCOMPLETE' as const,
    executionSimulation: 'FRESH_PER_STEP_AFTER_PREVIOUS_RECONCILIATION' as const,
    authorizable: false as const, persisted: false as const };
}
