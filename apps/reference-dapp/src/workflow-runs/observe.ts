// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: what an owner-signed step's own flow runs say about it, read server-side AS the step's wallet through the deployment's
 * runtime (the same reads `sharedRuns` makes for a single proposal). A step's runs are the runs of its flow, of its wallet, created after the
 * owner loaded the step, whose reviewed workflow hashes EXACTLY to the step's resolved hash. Only the flow's reconciled evidence can make a
 * step RECONCILED; a read-model flag never does. The verdict:
 *
 *   RECONCILED            a run reconciled (its evidence outcome is RECONCILED and the run has no error or pending observation)
 *   UNCERTAIN             a run submitted something whose outcome is not known yet (the flow keeps observing; nothing is retried here)
 *   FAILED                a run's submission reconciled as a failure (an error after a transaction hash): irreversible, no retry
 *   OPEN                  nothing submitted yet (no run, a run before signature, or runs that failed before any submission — the owner
 *                         may try again in the same signing surface, which is the flow's own behaviour)
 *
 * Several reconciled runs mean the owner executed the same step twice by their own explicit action: the earliest is the step's outcome and
 * the duplicate is reported (never hidden).
 */
import type { FlowName } from '../../backend/flows.ts';
import type { Workflow } from '../domain/initial-workflow';
import { semanticWorkflowHash } from '../engine/strategy-engine';
import type { McpRuntime as EngineRuntime } from '../mcp/runtime.ts';
import type { StepOutcome } from './pg-store.ts';

export type StepVerdict = { readonly verdict: 'RECONCILED'; readonly outcome: StepOutcome; readonly duplicates: readonly string[] }
  | { readonly verdict: 'UNCERTAIN'; readonly executionId: string; readonly code: string }
  | { readonly verdict: 'FAILED'; readonly outcome: StepOutcome; readonly code: string }
  | { readonly verdict: 'OPEN'; readonly lastError: string | null; readonly runs: number }
  | { readonly verdict: 'UNAVAILABLE'; readonly code: string };

type Attempt = { readonly transactionHash?: unknown; readonly state?: unknown };
const MAX_CANDIDATES = 16;
/** The workflow a flow record reviewed, wherever the flow keeps it (review, workflow, or the first of several reviews). */
function reviewedWorkflows(record: unknown): unknown[] {
  const r = record && typeof record === 'object' ? record as { review?: { workflow?: unknown }; workflow?: unknown; reviews?: { workflow?: unknown }[] } : {};
  return [r.review?.workflow, r.workflow, Array.isArray(r.reviews) ? r.reviews[0]?.workflow : undefined].filter(w => w && typeof w === 'object');
}
const hashes = (attempts: readonly unknown[]) => attempts.map(a => (a as Attempt).transactionHash).filter((h): h is string => typeof h === 'string' && h.length > 0);

/** Observes one owner-signed step. `chain` is the step's CAIP-2 chain (for the public transaction facts). */
export async function observeOwnerStep(runtime: EngineRuntime, input: { readonly flow: string; readonly wallet: string; readonly workflowHash: string;
  readonly claimedAt: Date; readonly chain: string; readonly now: Date }): Promise<StepVerdict> {
  if (!runtime.runs || !runtime.record) return { verdict: 'UNAVAILABLE', code: 'WORKFLOW_RUN_OBSERVATION_UNAVAILABLE' };
  const flow = input.flow as FlowName, since = input.claimedAt.getTime() - 1_000;
  const listed = await runtime.runs(flow, input.wallet);
  if (!listed.ok) return { verdict: 'UNAVAILABLE', code: listed.code };
  const candidates = listed.value.filter(r => r.flow === flow && Date.parse(r.updatedAt) >= since).slice(0, MAX_CANDIDATES);
  type Seen = { runId: string; createdAt: number; status: string; errorCode: string | null; needsObservation: boolean; submitted: readonly string[];
    evidence: { environment: string; outcome: string; bundleHash: string } | null };
  const seen: Seen[] = [];
  for (const candidate of candidates) {
    const run = await runtime.run(candidate.runId, input.wallet);
    if (!run.ok) return { verdict: 'UNAVAILABLE', code: run.code };
    if (!run.value || run.value.flow !== flow || Date.parse(run.value.createdAt) < since) continue;
    const record = await runtime.record(flow, candidate.runId, input.wallet);
    if (!record.ok) return { verdict: 'UNAVAILABLE', code: record.code };
    if (!reviewedWorkflows(record.value).some(w => { try { return semanticWorkflowHash(w as Workflow) === input.workflowHash; } catch { return false; } })) continue;
    let evidence: Seen['evidence'] = null;
    if (run.value.hasEvidence) {
      const e = await runtime.evidence(flow, candidate.runId, input.wallet);
      if (!e.ok) return { verdict: 'UNAVAILABLE', code: e.code };
      if (e.value) evidence = { environment: e.value.environment, outcome: e.value.outcome, bundleHash: e.value.bundleHash };
    }
    seen.push({ runId: run.value.runId, createdAt: Date.parse(run.value.createdAt), status: run.value.status, errorCode: run.value.errorCode,
      needsObservation: run.value.needsObservation, submitted: hashes(Array.isArray(run.value.attempts) ? run.value.attempts : []), evidence });
  }
  seen.sort((a, b) => a.createdAt - b.createdAt || (a.runId < b.runId ? -1 : 1));
  const outcomeOf = (s: Seen): StepOutcome => ({ kind: 'OWNER_RUN', executionId: s.runId, flow: input.flow, status: s.status,
    transactions: s.submitted.map(hash => ({ chain: input.chain, hash })), evidence: s.evidence, spent: [], received: [], observedAt: input.now.toISOString() });
  // The same rule as `sharedRuns`: only reconciled evidence of an error-free, fully observed run is a reconciled step.
  const reconciled = seen.filter(s => !s.needsObservation && s.errorCode === null && s.evidence?.outcome === 'RECONCILED' && Boolean(s.evidence.bundleHash)
    && ['RECONCILED', 'COMPLETED'].includes(s.status));
  if (reconciled.length) return { verdict: 'RECONCILED', outcome: outcomeOf(reconciled[0]!), duplicates: reconciled.slice(1).map(s => s.runId) };
  const pending = seen.find(s => s.needsObservation);
  if (pending) return { verdict: 'UNCERTAIN', executionId: pending.runId, code: 'STEP_OUTCOME_PENDING' };
  // A run that failed AFTER submitting something reconciled as a failure: irreversible (fees were paid), never retried by the run.
  const failed = seen.find(s => s.errorCode !== null && s.submitted.length > 0);
  if (failed) return { verdict: 'FAILED', outcome: outcomeOf(failed), code: failed.errorCode! };
  const last = seen.at(-1);
  return { verdict: 'OPEN', lastError: last?.errorCode ?? null, runs: seen.length };
}
