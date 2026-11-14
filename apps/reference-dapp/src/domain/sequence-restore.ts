// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD AAVE-V3-EXPANSION-001: completed sequence steps survive a refresh without trusting the browser.
 *
 * The sequence runtime records a completed step (its node, the runtime kind and that runtime's durable run id) when the step's own run is
 * final and reconciled. That pointer is kept in browser storage only as a pointer. After a reload a step counts as completed again only once
 * its runtime's durable server record proves it: the record is final and reconciled, belongs to this workflow and node, and — for a step whose
 * output funds a later step — its delivered amount is recomputed from the record (`deliveredByRecord`), never read from storage. The first
 * step that cannot be proven ends the restored history, so a completed financial action is never offered again and nothing unproven is ever
 * treated as done. Pure apart from the injected reader.
 */
import { deliveredByRecord, fundingAllocations, stepNodeKey, type CompletedStep, type WorkflowSequence } from './workflow-sequence';
import type { Workflow } from './initial-workflow';

/**
 * Runtimes whose durable record can be read back by run id alone (the Swap → Supply composition's runtimes among them). P0 hotfix (execution
 * continuity): the certified Router too, so a reload after Swap → Bridge re-proves the bridge from its reconciled record instead of offering it
 * again (its reader asks each Router network for the run id; a record it cannot read withholds the step, never offers it as new). P0 hotfix
 * (2026-11-13, FIX 2): the universal Router too — a reconciled Swap → universal Bridge reloaded after the bridge settled re-proves the bridge from
 * its own record (verdict, workflow, owner, proven `received`) instead of making it the current step again.
 */
export const RESTORABLE_RUNTIMES: readonly string[] = Object.freeze(['public', 'supply', 'solana-swap', 'router', 'universal']);
export const SEQUENCE_RUN_STORAGE_KEY = 'flofi:sequence-run:v1:';
export type StoredCompletion = { readonly nodeId: string; readonly node: string; readonly kind: string; readonly runKey: string; readonly received: string | null };
/** Reads a runtime's durable record by its run id (null when it cannot be read); `sourceChain` is the step's input chain when known. */
export type RecordReader = (kind: string, runKey: string, sourceChain?: string | null) => Promise<unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const RUN_KEY = /^[A-Za-z0-9._:-]{8,160}$/;
const sameEcosystem = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.split(':')[0] === b.split(':')[0];
/** The pointers worth re-proving: well-formed, in order, from a runtime whose record can be read back. */
export function storedCompletions(value: unknown, workflowId: string): readonly StoredCompletion[] {
  if (!isObject(value) || value.workflowId !== workflowId || !Array.isArray(value.completed)) return [];
  const out: StoredCompletion[] = [];
  for (const item of value.completed.slice(0, 64)) {
    if (!isObject(item) || typeof item.nodeId !== 'string' || typeof item.node !== 'string' || typeof item.kind !== 'string' || !RESTORABLE_RUNTIMES.includes(item.kind) ||
        typeof item.runKey !== 'string' || !RUN_KEY.test(item.runKey) || !(item.received === null || typeof item.received === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(item.received))) break;
    out.push({ nodeId: item.nodeId, node: item.node, kind: item.kind, runKey: item.runKey, received: item.received as string | null });
  }
  return out;
}
/** A runtime's durable record is final, reconciled and is the run of this workflow's node. */
export function completedByRecord(kind: string, record: unknown, workflowId: string, nodeId: string): boolean {
  if (!isObject(record)) return false;
  const final = kind === 'public' ? isObject(record.outcome) && !record.divergence : ['supply', 'solana-swap', 'router', 'universal'].includes(kind) && record.verdict === 'RECONCILED';
  const workflow = isObject(record.workflow) ? record.workflow : isObject(record.review) && isObject(record.review.workflow) ? record.review.workflow : null;
  return final && Boolean(workflow) && workflow!.workflowId === workflowId && Array.isArray(workflow!.nodes) &&
    workflow!.nodes.some(node => isObject(node) && node.nodeId === nodeId);
}
/** The wallet that executed a step, from the runtime's own durable record (lower-case EVM address or Solana key); null when not recorded. */
export function ownerByRecord(kind: string, record: unknown): string | null {
  if (!isObject(record)) return null;
  const value = kind === 'public' && Array.isArray(record.attempts) && isObject(record.attempts.at(-1)) ? (record.attempts.at(-1) as Record<string, unknown>).account
    : kind === 'supply' && isObject(record.review) ? record.review.account : kind === 'solana-swap' && isObject(record.review) ? record.review.owner
    : kind === 'router' ? record.owner
    // A universal route's owner deposited on the source chain. Review (round 2): across ecosystems the funds land with the wallet the Review bound
    // as recipient (the owner's wallet of the other ecosystem, possibly resolved from the account or Credentials): a later step that spends that
    // delivery continues only with that wallet (never "nobody", which skipped the wallet-continuity check).
    : kind === 'universal' && isObject(record.review) && isObject(record.review.route)
      ? sameEcosystem(record.review.route.sourceChain, record.review.route.destinationChain) ? record.owner : record.review.recipient : null;
  return typeof value === 'string' && value ? /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value : null;
}
/**
 * The longest prefix of `stored` that the runtimes' durable records prove for this exact workflow and sequence. Allocations, owners and delivered
 * amounts are recomputed; a delivered amount that differs from the pointer's, or that a later step needs but the record does not prove, stops
 * the restoration there. `unreadable` is true when it stopped because a record could not be read (retry; never treat the step as new).
 */
export async function proveCompletions(stored: readonly StoredCompletion[], workflow: Workflow, sequence: WorkflowSequence | null,
  read: RecordReader): Promise<{ readonly proven: CompletedStep[]; readonly unreadable: boolean }> {
  const proven: CompletedStep[] = [];
  if (!sequence) return { proven, unreadable: false };
  for (const [index, item] of stored.entries()) {
    const step = sequence.steps[index], node = step && workflow.nodes.find(candidate => candidate.nodeId === step.nodeId);
    if (!step || !node || step.nodeId !== item.nodeId || stepNodeKey(node) !== item.node) break;
    let record: unknown;
    try { record = await read(item.kind, item.runKey, step.input?.chainId ?? null); } catch { return { proven, unreadable: true }; }
    if (record === null || record === undefined) return { proven, unreadable: true };
    if (!completedByRecord(item.kind, record, workflow.workflowId, item.nodeId)) break;
    const received = deliveredByRecord(item.kind, record, step.output), owner = ownerByRecord(item.kind, record);
    const funds = sequence.steps.some(later => later.funding.some(funding => funding.fundedBy === index));
    if ((item.received !== null && received !== item.received) || (funds && received === null)) break;
    proven.push({ nodeId: item.nodeId, node: item.node, received, runKey: item.runKey, kind: item.kind, ...owner ? { owner } : {}, allocations: fundingAllocations(step, proven) });
  }
  return { proven, unreadable: false };
}
