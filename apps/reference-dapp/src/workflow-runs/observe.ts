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
 * Several reconciled runs can match the same wallet and workflow hash. The runner considers them oldest first and atomically claims one
 * execution for this step. An execution already claimed by another step cannot supply this step's output.
 */
import type { FlowName } from '../../backend/flows.ts';
import type { Workflow } from '../domain/initial-workflow';
import { semanticWorkflowHash } from '../engine/strategy-engine';
import type { McpRuntime as EngineRuntime } from '../mcp/runtime.ts';
import type { OwnerStepOutcome, StepOutcome } from './pg-store.ts';
import { amountsFromOwnerRecord } from './received-amounts.ts';

export type StepVerdict = { readonly verdict: 'RECONCILED'; readonly outcomes: readonly OwnerStepOutcome[] }
  | { readonly verdict: 'UNCERTAIN'; readonly outcome: OwnerStepOutcome; readonly code: string }
  | { readonly verdict: 'FAILED'; readonly outcome: OwnerStepOutcome; readonly code: string }
  | { readonly verdict: 'OPEN'; readonly lastError: string | null; readonly runs: number }
  | { readonly verdict: 'UNAVAILABLE'; readonly code: string };

type Attempt = { readonly transactionHash?: unknown; readonly state?: unknown };
const MAX_CANDIDATES = 16;
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const completionStatus = (status: string) => status === 'RECONCILED' || status === 'COMPLETED';
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** The workflow a flow record reviewed, wherever the flow keeps it (review, workflow, or the first of several reviews). */
function reviewedWorkflows(record: unknown): unknown[] {
  const r = record && typeof record === 'object' ? record as { review?: { workflow?: unknown }; workflow?: unknown; reviews?: { workflow?: unknown }[] } : {};
  return [r.review?.workflow, r.workflow, Array.isArray(r.reviews) ? r.reviews[0]?.workflow : undefined].filter(w => w && typeof w === 'object');
}
const hashes = (attempts: readonly unknown[]) => attempts.map(a => (a as Attempt).transactionHash).filter((h): h is string => typeof h === 'string' && h.length > 0);
type Transaction = StepOutcome['transactions'][number];

/** A terminal bridge's verified delivery or refund is a separate transaction, often on a different chain from its wallet attempts. */
function bridgeSettlement(flow: FlowName, value: unknown, sourceChain: string): Transaction | null {
  const universal = flow === 'crosschain-universal';
  if (!universal && flow !== 'crosschain-router' && !flow.startsWith('crosschain-router-')) return null;
  const record = object(value);
  const refunded = record?.verdict === 'REFUNDED';
  if (!refunded && record?.verdict !== 'RECONCILED') return null;
  const settlement = object(refunded ? record?.refund : record?.destination);
  if (!settlement || !refunded && (universal ? settlement.final !== true : settlement.safe !== true)) return null;
  const chain = universal ? settlement.chainId : refunded ? sourceChain : object(object(record?.review)?.intent)?.destinationChain;
  const hash = settlement.transactionHash;
  if (typeof chain !== 'string' || typeof hash !== 'string') return null;
  if (/^eip155:[1-9][0-9]*$/.test(chain) && /^0x[0-9a-f]{64}$/.test(hash)
      || /^solana:[1-9A-HJ-NP-Za-km-z]+$/.test(chain) && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(hash)) return { chain, hash };
  return null;
}

/** Observes one owner-signed step. `chain` is the step's CAIP-2 chain (for the public transaction facts). */
export async function observeOwnerStep(runtime: EngineRuntime, input: { readonly flow: string; readonly wallet: string; readonly workflowHash: string;
  readonly claimedAt: Date; readonly chain: string; readonly now: Date; readonly pinnedExecutionId?: string;
  /** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the run's own wallets by namespace — a bridge delivery to any other recipient funds no later step. */
  readonly ownerWallets?: Readonly<Partial<Record<'eip155' | 'solana', string>>> }): Promise<StepVerdict> {
  if (!runtime.runs || !runtime.record) return { verdict: 'UNAVAILABLE', code: 'WORKFLOW_RUN_OBSERVATION_UNAVAILABLE' };
  const flow = input.flow as FlowName, since = input.claimedAt.getTime() - 1_000;
  let candidates: readonly { runId: string }[];
  if (input.pinnedExecutionId) candidates = [{ runId: input.pinnedExecutionId }];
  else {
    const listed = await runtime.runs(flow, input.wallet);
    if (!listed.ok) return { verdict: 'UNAVAILABLE', code: listed.code };
    candidates = listed.value.filter(r => r.flow === flow && Date.parse(r.updatedAt) >= since).slice(0, MAX_CANDIDATES);
  }
  type Seen = { refunded: boolean; runId: string; createdAt: number; status: string; errorCode: string | null; needsObservation: boolean; submitted: readonly string[];
    evidence: { environment: string; outcome: string; bundleHash: string } | null; settlement: Transaction | null; spent: StepOutcome['spent']; received: StepOutcome['received'] };
  const seen: Seen[] = [];
  for (const candidate of candidates) {
    const run = await runtime.run(candidate.runId, input.wallet);
    if (!run.ok) return { verdict: 'UNAVAILABLE', code: run.code };
    if (!run.value || run.value.runId !== candidate.runId || run.value.flow !== flow || Date.parse(run.value.createdAt) < since) continue;
    const record = await runtime.record(flow, candidate.runId, input.wallet);
    if (!record.ok) return { verdict: 'UNAVAILABLE', code: record.code };
    if (!reviewedWorkflows(record.value).some(w => { try { return semanticWorkflowHash(w as Workflow) === input.workflowHash; } catch { return false; } })) continue;
    let evidence: Seen['evidence'] = null;
    if (run.value.hasEvidence) {
      const e = await runtime.evidence(flow, candidate.runId, input.wallet);
      if (!e.ok && !completionStatus(run.value.status)) return { verdict: 'UNAVAILABLE', code: e.code };
      if (e.ok && e.value) evidence = { environment: e.value.environment, outcome: e.value.outcome, bundleHash: e.value.bundleHash };
    }
    const amounts = amountsFromOwnerRecord(record.value);
    const verdict = object(record.value)?.verdict;
    // A delivery to someone other than the run's own wallet on that network is not the owner's to spend in a later step.
    const ownerOfDestination = amounts.recipientChain && input.ownerWallets ? input.ownerWallets[amounts.recipientChain.startsWith('solana:') ? 'solana' : 'eip155'] : undefined;
    const foreign = amounts.recipient !== undefined && ownerOfDestination !== undefined
      && (amounts.recipientChain?.startsWith('solana:') ? amounts.recipient !== ownerOfDestination : amounts.recipient.toLowerCase() !== ownerOfDestination.toLowerCase());
    seen.push({ refunded: verdict === 'REFUNDED', runId: run.value.runId, createdAt: Date.parse(run.value.createdAt), status: run.value.status, errorCode: run.value.errorCode,
      needsObservation: run.value.needsObservation, submitted: hashes(Array.isArray(run.value.attempts) ? run.value.attempts : []), evidence,
      settlement: bridgeSettlement(flow, record.value, input.chain),
      spent: amounts.spent, received: foreign ? [] : amounts.received });
  }
  if (input.pinnedExecutionId && !seen.length) return { verdict: 'UNAVAILABLE', code: 'WORKFLOW_RUN_OBSERVATION_UNAVAILABLE' };
  seen.sort((a, b) => a.createdAt - b.createdAt || (a.runId < b.runId ? -1 : 1));
  const outcomeOf = (s: Seen, settlement: Transaction | null = null): OwnerStepOutcome => {
    const transactions = [...new Set(s.submitted)].map(hash => ({ chain: input.chain, hash }));
    if (settlement && !transactions.some(tx => tx.chain === settlement.chain && tx.hash === settlement.hash)) transactions.push(settlement);
    return { kind: 'OWNER_RUN', executionId: s.runId, flow: input.flow, status: s.status, transactions, evidence: s.evidence,
      spent: s.spent, received: s.received, observedAt: input.now.toISOString() };
  };
  const pendingOutcome = (s: Seen): OwnerStepOutcome => ({ kind: 'OWNER_RUN', executionId: s.runId, flow: input.flow,
    status: s.status, transactions: [], evidence: null, spent: [], received: [], observedAt: input.now.toISOString() });
  // The same rule as `sharedRuns`: only reconciled evidence of an error-free, fully observed run is a reconciled step.
  const reconciled = seen.filter(s => !s.refunded && !s.needsObservation && s.errorCode === null && s.evidence?.outcome === 'RECONCILED' && Boolean(s.evidence.bundleHash && s.evidence.environment)
    && completionStatus(s.status));
  if (reconciled.length) return { verdict: 'RECONCILED', outcomes: reconciled.map(s => outcomeOf(s, s.settlement)) };
  const pending = seen.find(s => s.needsObservation);
  if (pending) return { verdict: 'UNCERTAIN', outcome: pendingOutcome(pending), code: pending.errorCode && CODE.test(pending.errorCode) ? pending.errorCode : 'STEP_OUTCOME_PENDING' };
  // A reported completion without readable evidence still represents a potentially executed action. Never reopen its signing proposal.
  const unproven = seen.find(s => completionStatus(s.status));
  if (unproven) return { verdict: 'UNCERTAIN', outcome: pendingOutcome(unproven), code: 'STEP_RECONCILIATION_EVIDENCE_UNAVAILABLE' };
  // BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: a bridge whose provider refunded the deposit delivered nothing: the step failed (it is never left open).
  const refunded = seen.find(s => s.refunded && !s.needsObservation && s.submitted.length > 0);
  if (refunded) return { verdict: 'FAILED', outcome: outcomeOf(refunded, refunded.settlement), code: 'BRIDGE_REFUNDED' };
  // A run that failed AFTER submitting something reconciled as a failure: irreversible (fees were paid), never retried by the run.
  const failed = seen.find(s => s.errorCode !== null && s.submitted.length > 0);
  if (failed) return { verdict: 'FAILED', outcome: outcomeOf(failed), code: failed.errorCode! };
  const last = seen.at(-1);
  return { verdict: 'OPEN', lastError: last?.errorCode ?? null, runs: seen.length };
}
