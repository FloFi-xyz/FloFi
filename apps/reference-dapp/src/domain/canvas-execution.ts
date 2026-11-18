// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001 (Live Canvas): how the EXISTING Canvas cards and connections look while their workflow executes —
 * a presentation-only projection of the authoritative execution state the Editor already holds, keyed by the workflow's own node ids.
 *
 *   one runtime        the current runtime's lifecycle (`execution-lifecycle.ts`): its steps ARE the workflow's composer nodes (`step.id` is the
 *                      node id), phased by `lifecycleStepPhase` exactly as Execute, the FloFi Assistant and the Dashboard phase them
 *   step by step       the Editor's sequence (`workflow-store.tsx`): a completed step is the reconciled record of that node; the current step's
 *                      phase is its runtime's lifecycle (its step projection keeps the node id)
 *   whole workflow     the shared workflow run (`RunView`): step i is the i-th node of `sequenceOrder` — the order `editor/workflow-strategy.ts`
 *                      builds the run's strategy from — accepted only for the exact workflow id and revision that was authorized, with the
 *                      same number of steps
 *
 * Nothing is inferred from time, animation, card order or position: a node whose state is not proven by its record stays neutral. Green is
 * only ever a reconciled step (`phaseCompletesStep`): a submitted transaction, a confirmed approval, a source-chain confirmation or a bridge
 * delivery still awaiting reconciliation stays blue. Pure: it reads records and returns presentation, and never signs, submits, retries,
 * polls or reconciles anything.
 */
import { EXECUTION_PHASE_LABEL, phaseCompletesStep, type ExecutionPhase } from './execution-phase';
import type { ExecutionLifecycle, LifecycleStep } from './execution-lifecycle';
import { lifecycleStepPhase, phaseText, stepReconciled, type PhaseText } from './workflow-progress';
import { runStepPhase } from '../workflow-runs/run-step-phase';
import { WALLET_BATCH_OUTCOME_UNKNOWN } from '../workflow-runs/state-machine';
import { isFinalExecutionResult } from './execution-result';

/** The visual state of one card. Presentation only: it is never written back to any execution record. */
export const CANVAS_EXECUTION_VISUALS = ['waiting', 'active', 'wallet', 'authorize', 'pending', 'done', 'attention', 'failed'] as const;
export type CanvasExecutionVisual = (typeof CANVAS_EXECUTION_VISUALS)[number];
/** The visual state of one connection (a workflow dependency or resource edge). */
export type CanvasEdgeVisual = 'waiting' | 'active' | 'done' | 'attention' | 'failed';
export type CanvasNodeExecution = { readonly visual: CanvasExecutionVisual; readonly phase: ExecutionPhase | null; readonly text: PhaseText };
export type CanvasExecution = {
  /** Which record colors the Canvas (`lifecycle:<runKey>`, `sequence:<workflowId>`, `run:<workflowRunId>`): a new record never inherits another's colors. */
  readonly key: string;
  readonly workflowId: string; readonly revision: number;
  readonly nodes: Readonly<Record<string, CanvasNodeExecution>>;
  /** Something of this workflow was handed to a wallet or a chain (or is recorded as such): the cards show their execution state. */
  readonly started: boolean;
  /** The executing record is final (its run ended): no step is in flight, waiting for the owner or still being observed. */
  readonly settled: boolean;
  /** The current runtime run (`ExecutionLifecycle.runKey`) whose steps this execution includes, if any: Execute keeps the Canvas for that run only. */
  readonly runKeys: readonly string[];
};

type CanvasWorkflow = { readonly workflowId: string; readonly revision: number; readonly nodes: readonly { readonly nodeId: string }[] };
const FAILED_OPS = ['failed', 'cancelled', 'expired', 'not-submitted'];
/** Requests that provably never left: the owner declined, the request expired or was refused before sending. Intervention, not a chain failure. */
const NOTHING_SENT_OPS = ['cancelled', 'expired', 'not-submitted'];
const WAITING: CanvasNodeExecution = Object.freeze({ visual: 'waiting', phase: null, text: Object.freeze({ key: 'Waiting', args: Object.freeze([]) }) });
const text = (key: string, args: readonly string[] = []): PhaseText => ({ key, args });

/** A phase's visual. Never green before RECONCILED/COMPLETED; amber for an outcome that needs observation or the owner; blue while in flight. */
export function visualOfPhase(phase: ExecutionPhase | null): CanvasExecutionVisual {
  if (!phase || phase === 'PREPARED') return 'waiting';
  if (phaseCompletesStep(phase)) return 'done';
  if (phase === 'FAILED') return 'failed';
  if (phase === 'OUTCOME_UNKNOWN') return 'attention';
  if (phase === 'SENT_TO_WALLET') return 'wallet';
  // The owner's next authorization, in FloFi first (nothing is in the wallet yet).
  if (phase === 'AWAITING_AUTHORIZATION') return 'authorize';
  // SUBMITTED, CONFIRMED_AT_SOURCE, AWAITING_DESTINATION, DESTINATION_OBSERVED: sent, not yet reconciled.
  return 'pending';
}

/** One lifecycle step (a card) from its runtime's own operations. */
export function lifecycleNodeExecution(live: ExecutionLifecycle, step: LifecycleStep): CanvasNodeExecution {
  const phase = lifecycleStepPhase(step, stepReconciled(live, step.id));
  if (!phase) return WAITING;
  const words = phaseText(phase, step);
  if (phase === 'FAILED') {
    // A request the wallet declined, or that expired or was refused before it was sent, failed nothing on chain: it waits for the owner (amber),
    // with the lifecycle's own words. A reverted or failed transaction is a confirmed failure (red).
    const failing = step.operations.filter(op => FAILED_OPS.includes(op.state));
    const nothingSent = failing.length > 0 && failing.every(op => !op.hash && (NOTHING_SENT_OPS.includes(op.state) || op.label === 'Wallet request declined'));
    return { visual: nothingSent ? 'attention' : 'failed', phase, text: nothingSent ? text(step.label, step.labelArgs ?? []) : words };
  }
  // A request being prepared or handed over right now (after the owner's click) is active, not merely "prepared".
  if (phase === 'PREPARED' && step.operations.some(op => op.state === 'preparing' || op.state === 'submitting'))
    return { visual: 'active', phase, text: text(step.operations.some(op => op.state === 'submitting') ? 'Submitting' : 'Preparing request') };
  return { visual: visualOfPhase(phase), phase, text: words };
}

const ids = (workflow: CanvasWorkflow) => new Set(workflow.nodes.map(node => node.nodeId));
const IN_FLIGHT: readonly CanvasExecutionVisual[] = ['active', 'wallet', 'authorize', 'pending'];
const open = (nodes: Readonly<Record<string, CanvasNodeExecution>>) => Object.values(nodes).some(node => IN_FLIGHT.includes(node.visual) || node.phase === 'OUTCOME_UNKNOWN');

/**
 * The Canvas execution of the current runtime's lifecycle, or null when that record is not THIS Canvas workflow's (another workflow or revision,
 * a detached run, a saved run whose original workflow is unavailable) or nothing of it was requested yet.
 */
export function lifecycleCanvasExecution(workflow: CanvasWorkflow, live: ExecutionLifecycle | null | undefined): CanvasExecution | null {
  if (!live?.started || live.matchesWorkflow === false || live.detached || live.planUnavailable || !live.runKey || !live.steps.length) return null;
  const known = ids(workflow);
  if (!live.steps.every(step => known.has(step.id))) return null;
  const nodes: Record<string, CanvasNodeExecution> = {};
  for (const step of live.steps) nodes[step.id] = lifecycleNodeExecution(live, step);
  return { key: `lifecycle:${live.runKey}`, workflowId: workflow.workflowId, revision: workflow.revision, nodes, started: true,
    settled: isFinalExecutionResult(live) && !open(nodes), runKeys: [live.runKey] };
}

type SequenceLike = { readonly steps: readonly { readonly nodeId: string }[]; readonly cursor: number; readonly completed: readonly unknown[]; readonly finished: boolean };
/**
 * A step-by-step workflow: its completed steps (reconciled records) are done; its current step is its runtime's lifecycle when that lifecycle is
 * the current step's own (its single step is the current node); every other step waits. Null until a step was requested or completed.
 */
export function sequenceCanvasExecution(workflow: CanvasWorkflow, sequence: SequenceLike | null | undefined, live: ExecutionLifecycle | null | undefined): CanvasExecution | null {
  if (!sequence?.steps.length) return null;
  const known = ids(workflow);
  if (!sequence.steps.every(step => known.has(step.nodeId))) return null;
  const current = !sequence.finished ? sequence.steps[sequence.cursor] : undefined;
  const ownLive = live?.started && live.matchesWorkflow !== false && !live.detached && !live.planUnavailable && current && live.steps.length === 1 && live.steps[0]!.id === current.nodeId ? live : null;
  if (!sequence.completed.length && !ownLive) return null;
  const nodes: Record<string, CanvasNodeExecution> = {};
  sequence.steps.forEach((step, index) => {
    nodes[step.nodeId] = index < sequence.completed.length ? { visual: 'done', phase: 'RECONCILED', text: text('Reconciled') }
      : ownLive && step.nodeId === current?.nodeId ? lifecycleNodeExecution(ownLive, ownLive.steps[0]!) : WAITING;
  });
  // A step-by-step workflow between steps is not a result: it is final once every step completed, or its current run ended needing attention.
  return { key: `sequence:${workflow.workflowId}`, workflowId: workflow.workflowId, revision: workflow.revision, nodes, started: true,
    settled: sequence.finished || Boolean(ownLive && isFinalExecutionResult(ownLive) && ownLive.state === 'attention' && !open(nodes)), runKeys: ownLive?.runKey ? [ownLive.runKey] : [] };
}

/** The run view fields this projection reads (client-safe; `workflow-runs/service.ts` `RunView`). */
export type RunLike = {
  readonly workflowRunId: string; readonly state: string; readonly mode: string | null; readonly stepCount: number;
  /** The run's own next owner action and current step (RunView), so a card asks for the owner only when the run does. */
  readonly currentStep?: number; readonly nextAction?: string;
  readonly steps: readonly { readonly index: number; readonly state: string; readonly code: string | null }[];
  readonly groups: readonly { readonly index: number; readonly steps: readonly [number, number]; readonly chain: string; readonly state: string; readonly signed: boolean;
    readonly code: string | null; readonly delivery?: { readonly step: number; readonly chain: string; readonly state: string } | null }[];
};
/** Group states (USER_FUNDED) whose own words say where the group's steps stand. */
const GROUP_VISUAL: Readonly<Record<string, readonly [CanvasExecutionVisual, string, ExecutionPhase | null]>> = {
  AUTHORIZED: ['pending', 'Confirmed in your wallet', 'SUBMITTED'], SUBMITTED: ['pending', 'Sent to the network', 'SUBMITTED'], EXPIRED: ['attention', 'Expired', null],
  UNCERTAIN: ['attention', 'Outcome pending', 'OUTCOME_UNKNOWN'],
};
const OPEN_RUN = ['PENDING', 'RUNNING', 'ATTENTION'];
const TERMINAL_RUN = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'];
/** States whose own words already say what the wallet answered or the chain decided (the Editor panel's `ANSWERED_STATES`). */
const ANSWERED: readonly string[] = ['AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'RECONCILED', 'FAILED'];
/**
 * A step or group whose wallet batch was handed to the owner's wallet and never answered (WALLET_BATCH_OUTCOME_UNKNOWN): it may have executed. It is
 * never shown as "not run" or "stopped before submission" — the Editor panel's rule (`batchUnanswered`, editor-workflow-run.tsx).
 */
const batchUnanswered = (item: { readonly state: string; readonly code: string | null } | undefined) => Boolean(item && item.code === WALLET_BATCH_OUTCOME_UNKNOWN && !ANSWERED.includes(item.state));
const UNANSWERED_TEXT = "Its batch may have executed before it expired; check your wallet's activity";
const UNRECORDED_TEXT = "Your wallet may already have sent this batch. Check your wallet's activity before ending the workflow: ending it does not stop a batch already on chain.";
/**
 * One whole-workflow run step, in the Editor run panel's own words (`stepText`, `GROUP_STATE`): a prepared group reads "Waiting for your wallet"
 * whatever this tab is doing; `unrecorded` (this browser handed the group's batch to the wallet and has no recorded answer) reads as possibly
 * executed; an owner step on its signing page is in progress (never "confirm in wallet" for hours); the owner's authorization is asked for only
 * where the run itself waits for it (`nextAction` on its current step).
 */
export function runNodeExecution(run: RunLike, step: RunLike['steps'][number], unrecorded = false): CanvasNodeExecution {
  const phased = runStepPhase(run, step);
  if (phased) return { visual: visualOfPhase(phased.phase), phase: phased.phase,
    text: phased.network && EXECUTION_PHASE_LABEL[phased.phase].includes('{0}') ? text(EXECUTION_PHASE_LABEL[phased.phase], [phased.network]) : phaseText(phased.phase) };
  const group = run.mode === 'USER_FUNDED' ? run.groups.find(g => g.steps[0] <= step.index && step.index <= g.steps[1]) : undefined;
  if (step.state !== 'RECONCILED' && (batchUnanswered(step) || !ANSWERED.includes(step.state) && batchUnanswered(group)))
    return { visual: 'attention', phase: 'OUTCOME_UNKNOWN', text: text(UNANSWERED_TEXT) };
  if (unrecorded && group?.state === 'PREPARED' && !ANSWERED.includes(step.state))
    return { visual: 'attention', phase: 'OUTCOME_UNKNOWN', text: text(UNRECORDED_TEXT) };
  const current = run.currentStep === step.index && OPEN_RUN.includes(run.state);
  switch (step.state) {
    case 'FAILED': return { visual: 'failed', phase: 'FAILED', text: text('Failed') };
    case 'UNCERTAIN': return { visual: 'attention', phase: 'OUTCOME_UNKNOWN', text: text('Outcome pending') };
    case 'BLOCKED': return { visual: 'attention', phase: null, text: text('Stopped before submission') };
    case 'AWAITING_OWNER': return { visual: 'pending', phase: 'SUBMITTED', text: text('In your wallet') };
    case 'DELEGATED': {
      if (!group) return { visual: 'pending', phase: 'SUBMITTED', text: text('Authorized') };
      const known = GROUP_VISUAL[group.state];
      if (known) return { visual: known[0], phase: known[2], text: text(known[1]) };
      if (group.signed) return { visual: 'pending', phase: 'SUBMITTED', text: text('Signed in your wallet') };
      if (!OPEN_RUN.includes(run.state)) return { visual: 'attention', phase: null, text: text('Not signed') };
      if (group.state === 'PREPARED') return { visual: 'wallet', phase: 'SENT_TO_WALLET', text: text('Waiting for your wallet') };
      // A group that is due waits for the owner's authorization in FloFi; a later one is signed only when it is due.
      if (run.nextAction === 'OWNER_SIGNS_GROUP' && run.groups.some(g => g === group && g.steps[0] <= (run.currentStep ?? -1) && (run.currentStep ?? -1) <= g.steps[1]))
        return { visual: 'authorize', phase: 'AWAITING_AUTHORIZATION', text: text('Waiting for your authorization') };
      return { visual: 'waiting', phase: null, text: text('Not signed yet') };
    }
    case 'READY': case 'PENDING': {
      if (group?.state === 'PREPARED') return { visual: 'wallet', phase: 'SENT_TO_WALLET', text: text('Waiting for your wallet') };
      // The run waits for the owner on this very step (its own signing page, or its group's authorization).
      if (current && (run.nextAction === 'OWNER_SIGNS_STEP' || run.nextAction === 'OWNER_SIGNS_GROUP'))
        return { visual: 'authorize', phase: 'AWAITING_AUTHORIZATION', text: text('Waiting for your authorization') };
      return step.state === 'READY' ? { visual: 'waiting', phase: null, text: text('Ready for your signature') } : WAITING;
    }
    case 'SKIPPED': return { visual: 'waiting', phase: null, text: text('Not run') };
    default: return WAITING;
  }
}

/**
 * The whole-workflow run of THIS Canvas workflow. `authorizedFor`: the workflow id and revision the run was authorized for (the Editor's stored
 * record); a run of any other identity or revision, or whose step count differs from this workflow's sequence, colors nothing.
 */
export function runCanvasExecution(workflow: CanvasWorkflow, order: readonly { readonly nodeId: string }[], run: RunLike | null | undefined,
  authorizedFor: { readonly workflowId: string; readonly revision: number } | null | undefined, unrecorded = false): CanvasExecution | null {
  if (!run || !authorizedFor || authorizedFor.workflowId !== workflow.workflowId || authorizedFor.revision !== workflow.revision) return null;
  if (run.stepCount !== order.length || run.steps.length !== order.length) return null;
  const nodes: Record<string, CanvasNodeExecution> = {};
  for (const step of run.steps) {
    const node = order[step.index];
    if (!node) return null;
    nodes[node.nodeId] = runNodeExecution(run, step, unrecorded);
  }
  const started = Object.values(nodes).some(node => node.visual !== 'waiting') || run.state !== 'PENDING';
  return { key: `run:${run.workflowRunId}`, workflowId: workflow.workflowId, revision: workflow.revision, nodes, started,
    settled: TERMINAL_RUN.includes(run.state) && !open(nodes), runKeys: [] };
}

/**
 * A connection's state from its two ends' records: green once the dependency (its source step) is reconciled, blue while the target it unlocks
 * is in flight, red/amber when the source failed or its outcome is unknown. A connection is never colored from position or order.
 */
export function edgeExecution(execution: CanvasExecution | null | undefined, source: string, target: string): CanvasEdgeVisual {
  const from = execution?.nodes[source]?.visual, to = execution?.nodes[target]?.visual;
  if (!from) return 'waiting';
  if (from === 'failed') return 'failed';
  if (from === 'attention') return 'attention';
  if (from === 'done') return to && IN_FLIGHT.includes(to) ? 'active' : 'done';
  return 'waiting';
}

/** The execution this Canvas shows, if any: only a record of the exact workflow and revision on it. */
export function canvasExecutionFor(execution: CanvasExecution | null | undefined, workflow: { readonly workflowId: string; readonly revision: number }): CanvasExecution | null {
  return execution && execution.started && execution.workflowId === workflow.workflowId && execution.revision === workflow.revision ? execution : null;
}

/** The short label a card's execution badge reads (catalog key and parameters); the full phase words are its accessible description. */
export const CANVAS_VISUAL_LABEL: Readonly<Record<CanvasExecutionVisual, string>> = Object.freeze({
  waiting: 'Waiting', active: 'Executing', wallet: 'Confirm in wallet', authorize: 'Your authorization', pending: 'In progress', done: 'Completed', attention: 'Needs attention', failed: 'Failed',
});
