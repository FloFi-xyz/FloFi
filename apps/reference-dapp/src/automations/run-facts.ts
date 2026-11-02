// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #149: the recorded facts the Automations History needs to say what really happened in a run started from a proposal — whether it
 * was only simulated, refused, submitted, confirmed onchain or reconciled — read from the owner's own durable run (its attempts and its
 * observation flag), never from a provider answer. A read only: nothing here signs, submits, claims, applies, observes or decides anything.
 */
import type { EngineRuntime } from '../platform/index.ts';
import type { RunAttemptView } from './views.ts';

/** One read of each run per view: the shared-runs lookup reads the run, and its attempts come from that same answer (no second read). */
export function onceEachRun(runtime: EngineRuntime): EngineRuntime {
  const reads = new Map<string, ReturnType<EngineRuntime['run']>>();
  return { ...runtime, run: (runId, owner) => {
    const key = `${owner}\n${runId}`;
    if (!reads.has(key)) reads.set(key, runtime.run(runId, owner));
    return reads.get(key)!;
  } };
}

const text = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : null;
/**
 * The run's public attempt facts (step, state, whether a hash is recorded as the hash itself, reconciled) and whether FloFi still observes it.
 * `null` when the run cannot be read: the History then says only what the run summary proves.
 */
export async function recordedRunFacts(reads: Pick<EngineRuntime, 'run'>, executionId: string, owner: string):
  Promise<{ readonly needsObservation: boolean | null; readonly attempts: readonly RunAttemptView[] | null }> {
  const read = await reads.run(executionId, owner).catch(() => null);
  const run = read?.ok ? read.value : null;
  if (!run || run.runId !== executionId) return { needsObservation: null, attempts: null };
  const attempts = (Array.isArray(run.attempts) ? run.attempts : []).slice(0, 64).flatMap((a): RunAttemptView[] => {
    const row = a && typeof a === 'object' ? a as Record<string, unknown> : {}, step = text(row.step), state = text(row.state);
    return step && state ? [{ step, state, transactionHash: text(row.transactionHash), reconciled: row.reconciled === true }] : [];
  });
  return { needsObservation: run.needsObservation === true, attempts };
}
