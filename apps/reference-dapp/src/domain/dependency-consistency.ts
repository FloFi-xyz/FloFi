// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (A01/A07): a Canvas step that spends an earlier step's delivery (the sequence runtime's funding rule,
 * `workflow-sequence.ts`) must agree with that earlier step before it is simulated or reviewed. Its amount is copied once (from the earlier card's
 * live estimate, or typed); nothing recomputes it when the earlier step changes, so a dependent amount can silently go stale:
 *
 *   UPSTREAM_CHANGED  the earlier step's declaration (amount, asset, network, route) changed after the dependent amount was set: the person sets
 *                     the dependent amount again (any edit of that step records the earlier step it now follows)
 *   ABOVE_UPSTREAM    the dependent amount is above what the earlier step is now estimated to deliver (its live estimate, or a Withdraw / Borrow's
 *                     exact amount): the card would claim to spend more than arrives
 *
 * Execution never relied on either (every resolver spends min(cap, actual delivery) and never the wallet's other balance); this keeps the Canvas,
 * Simulation and Review from presenting a financially inconsistent workflow as valid. `bases` is the Editor's own record of which earlier step
 * each dependent amount was set against (not part of the canonical workflow, whose v1 IR is frozen): a record that is missing (a reopened or
 * restored workflow) is never guessed as stale; only the estimate check applies until the step is edited again.
 *
 * Pure: no React, wallet, quote or network. The estimate reader is the caller's (the Canvas's live quotes); nothing here signs or simulates.
 */
import type { Workflow } from './initial-workflow';
import { compositionWorkflow, sameSequenceAsset, sequenceOrder, stepAssets, type WorkflowSequence } from './workflow-sequence';

type Node = Workflow['nodes'][number];
/** By dependent step node id: the fingerprint of the earlier step's declaration when the dependent amount was set. */
export type DependencyBases = Readonly<Record<string, string>>;

/** What a step declares about its output (action, network, inputs, limits, route): an edit of any of them changes it. FNV-1a, 64 bits. */
export function producerBasis(node: Pick<Node, 'actionType' | 'chainId' | 'inputs' | 'userConstraints' | 'adapterConstraints'>): string {
  const text = JSON.stringify([node.actionType, node.chainId, node.inputs, node.userConstraints, node.adapterConstraints]);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}

/**
 * Which earlier step funds each step that spends ONE asset, by node id: the sequence runtime's own rule (the latest earlier step that delivers
 * exactly that asset to the owner). Lint-free, so the editor reducer can keep its record in step with every edit; a composition funds nothing.
 */
export function fundingProducers(workflow: Workflow): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (compositionWorkflow(workflow)) return out;
  const ordered = sequenceOrder(workflow), assets = ordered.map(node => stepAssets(node));
  for (const [index, node] of ordered.entries()) {
    const inputs = assets[index]!.inputs.filter(input => input.amount !== '0');
    if (inputs.length !== 1) continue;
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      const producer = assets[earlier]!;
      if (producer.output && producer.ownerReceives && sameSequenceAsset(producer.output, inputs[0]!)) { out.set(node.nodeId, ordered[earlier]!.nodeId); break; }
    }
  }
  return out;
}

/**
 * The record after an accepted edit from `before` to `after`: a dependent step that is new, whose own declaration changed, that is now funded by
 * another step, or that has no record yet is recorded against its earlier step as it is now; every other record is kept (so an edit of the
 * earlier step alone leaves its dependents stale); steps that are no longer funded are dropped.
 */
export function nextDependencyBases(before: Workflow, after: Workflow, bases: DependencyBases | undefined): DependencyBases | undefined {
  const producers = fundingProducers(after), out: Record<string, string> = {};
  const previous = fundingProducers(before);
  for (const [consumer, producer] of producers) {
    const node = after.nodes.find(item => item.nodeId === producer), was = before.nodes.find(item => item.nodeId === consumer);
    const now = after.nodes.find(item => item.nodeId === consumer);
    if (!node || !now) continue;
    const kept = bases?.[consumer];
    const unchanged = was !== undefined && producerBasis(was) === producerBasis(now) && previous.get(consumer) === producer;
    out[consumer] = kept !== undefined && unchanged ? kept : producerBasis(node);
  }
  return Object.keys(out).length ? Object.freeze(out) : undefined;
}

export type ProducerEstimate = { readonly expected: string };
export type DependencyState =
  | { readonly kind: 'consistent' }
  | { readonly kind: 'stale'; readonly step: number; readonly from: number; readonly reason: 'UPSTREAM_CHANGED' | 'ABOVE_UPSTREAM' };
const unitsOf = (text: string, decimals: number): bigint | null => {
  const value = text.trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  // Never more precision than the asset carries (truncated down, as the Canvas proposes an inherited amount).
  return BigInt(whole! + fraction.slice(0, decimals).padEnd(decimals, '0'));
};
/** What the earlier step is estimated to deliver in the dependent step's units: its live estimate, or a Withdraw / Borrow's own exact amount. */
function deliveredUnits(node: Node | undefined, decimals: number, estimate: ProducerEstimate | null): bigint | null {
  if (node && (node.actionType === 'withdraw' || node.actionType === 'borrow')) {
    const limit = node.userConstraints.find(constraint => constraint.kind === 'MAXIMUM_INPUT') as { quantity?: { amount?: unknown } } | undefined;
    return typeof limit?.quantity?.amount === 'string' && /^[1-9][0-9]*$/.test(limit.quantity.amount) ? BigInt(limit.quantity.amount) : null;
  }
  return estimate && typeof estimate.expected === 'string' ? unitsOf(estimate.expected, decimals) : null;
}
/**
 * Each funded step's dependency state, by node id (see the module comment). `estimateOf` is the earlier step's current live estimate (null: none
 * is known now, and only the record is judged). A step funded by two deliveries (a position) is not judged here.
 */
export function dependencyStates(workflow: Workflow, sequence: WorkflowSequence | null, bases: DependencyBases | undefined,
  estimateOf: (nodeId: string) => ProducerEstimate | null): ReadonlyMap<string, DependencyState> {
  const out = new Map<string, DependencyState>();
  for (const step of sequence?.steps ?? []) {
    if (step.fundedBy === null || step.funding.length !== 1 || !step.input) continue;
    const producer = sequence!.steps[step.fundedBy]!, node = workflow.nodes.find(item => item.nodeId === producer.nodeId);
    const where = { step: step.index + 1, from: producer.index + 1 }, basis = bases?.[step.nodeId];
    const delivered = deliveredUnits(node, step.input.decimals, estimateOf(producer.nodeId));
    if (basis !== undefined && node && basis !== producerBasis(node)) out.set(step.nodeId, { kind: 'stale', ...where, reason: 'UPSTREAM_CHANGED' });
    else if (delivered !== null && BigInt(step.input.amount) > delivered) out.set(step.nodeId, { kind: 'stale', ...where, reason: 'ABOVE_UPSTREAM' });
    else out.set(step.nodeId, { kind: 'consistent' });
  }
  return out;
}
/** The first stale step (in sequence order), or null: Simulation and Review are held back until it is resolved. */
export function firstDependencyIssue(states: ReadonlyMap<string, DependencyState>): Extract<DependencyState, { kind: 'stale' }> | null {
  let first: Extract<DependencyState, { kind: 'stale' }> | null = null;
  for (const state of states.values()) if (state.kind === 'stale' && (!first || state.step < first.step)) first = state;
  return first;
}
