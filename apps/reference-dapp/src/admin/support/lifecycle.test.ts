// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001 (addendum): the shared attention lifecycle. Every case uses database-shaped facts (the shape
 * `loadRunsFacts` returns) and is deterministic. The production snapshot of 2026-11-14 (12 flagged runs) is reproduced as fixtures whose
 * stopped-task history is stated explicitly, because that history decides the classification — not the execution status.
 */
import { describe, expect, it } from 'vitest';
import { explainCode, retryableStopReason } from './codes.ts';
import { identifierShaped } from './diagnostics.ts';
import type { ExecutionSnapshot } from './executions.ts';
import { executionIncident, submissionOf } from './incidents.ts';
import { countAttention, investigationOf, OWNER_REVIEW_CODE, runAttention } from './lifecycle.ts';
import { RECOVERY_ACTIONS, stateToken, type RunRecoveryFacts, type StoppedKind, type WorkFact } from './registry.ts';

const now = new Date('2026-11-14T12:00:00.000Z'), hour = 3_600_000, day = 24 * hour;
const task = (kind: string, state: WorkFact['state'], lastError: string | null = null, id = '7', deliveries = 500): WorkFact =>
  ({ id, kind, state, lastError, deliveries, createdAt: new Date(now.getTime() - 9 * day), completedAt: state === 'DONE' || state === 'DEAD' ? new Date(now.getTime() - 2 * day) : null });
const stopped = (kind: string, newestState: WorkFact['state'] = 'DEAD', lastError = 'OBSERVATION_BUDGET_EXHAUSTED', count = 1): StoppedKind =>
  ({ kind, count, lastError, lastStoppedAt: new Date(now.getTime() - 2 * day), newestState });
type Shape = { runId: string; flow: string; status: string; provenance: string; errorCode?: string | null; needsObservation?: boolean; attention?: boolean; hasEvidence?: boolean;
  evidenceArchived?: boolean; attempts?: ExecutionSnapshot['attempts']; latest?: RunRecoveryFacts['latest']; stoppedKinds?: StoppedKind[] };
function shape(s: Shape): { run: ExecutionSnapshot; facts: RunRecoveryFacts } {
  const run: ExecutionSnapshot = { runId: s.runId, workflowId: `wf-${s.runId}`, flow: s.flow, status: s.status, provenance: s.provenance, errorCode: s.errorCode ?? null,
    needsObservation: s.needsObservation ?? false, attentionRequired: s.attention ?? true, hasEvidence: s.hasEvidence ?? false, createdAt: new Date(now.getTime() - 12 * day),
    updatedAt: new Date(now.getTime() - 2 * day), attempts: s.attempts ?? [{ step: 'SWAP', state: 'CONFIRMED', hash: true, reconciled: true }], journalAuthorized: true, chains: [] };
  const latest = s.latest ?? {};
  const facts: RunRecoveryFacts = { runId: s.runId, flow: s.flow, status: s.status, needsObservation: run.needsObservation, attentionRequired: run.attentionRequired,
    hasEvidence: run.hasEvidence, evidenceArchived: s.evidenceArchived ?? false, logVersion: 9, latest,
    unresolvedDeadKinds: Object.values(latest).filter(t => t.state === 'DEAD').map(t => t.kind), recentRecoveries: 0, stoppedKinds: s.stoppedKinds ?? [] };
  return { run, facts };
}
const classify = (s: Shape, investigation: Parameters<typeof runAttention>[2] = null) => { const { run, facts } = shape(s); return runAttention(run, facts, investigation, now); };
const confirmed = [{ step: 'SWAP', state: 'CONFIRMED', hash: true, reconciled: true }] as const;

/** Execution A and B as recorded in production (ids, flows, codes, provenance, 500-delivery DEAD reconcile jobs, no evidence). */
const EXECUTION_A: Shape = { runId: 'xuni-379461c2e3f1807a0dc0455342a51d21', flow: 'crosschain-universal', status: 'SUBMISSION_RESULT_UNKNOWN', provenance: 'PUBLIC_MAINNET',
  errorCode: 'UNIVERSAL_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION', needsObservation: true, hasEvidence: false,
  attempts: [{ step: 'DEPOSIT', state: 'SUBMISSION_RESULT_UNKNOWN', hash: false, reconciled: false }],
  latest: { reconcile: task('reconcile', 'DEAD', 'OBSERVATION_BUDGET_EXHAUSTED', '901') }, stoppedKinds: [stopped('reconcile')] };
const EXECUTION_B: Shape = { runId: 'xroute-a09617c2bb8ac5469cab1fc955a3fd32', flow: 'crosschain-router-arbitrum-to-base', status: 'SUBMISSION_RESULT_UNKNOWN',
  provenance: 'PUBLIC_MAINNET', errorCode: 'ROUTER_TRANSACTION_NOT_OBSERVED', needsObservation: true, hasEvidence: false,
  attempts: [{ step: 'DEPOSIT', state: 'SUBMISSION_RESULT_UNKNOWN', hash: false, reconciled: false }],
  latest: { reconcile: task('reconcile', 'DEAD', 'OBSERVATION_BUDGET_EXHAUSTED', '902') }, stoppedKinds: [stopped('reconcile')] };

describe('BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001 attention lifecycle', () => {
  it('1. a terminal execution with a historical flag is historical — or verified resolved only with incident-specific evidence', () => {
    // The stopped check was superseded by a reconciled verdict with an Evidence Bundle, every submitted attempt reconciled: verified.
    const verified = classify({ runId: 'r1', flow: 'base-sepolia-swap', status: 'RECONCILED', provenance: 'PUBLIC_TESTNET', hasEvidence: true, evidenceArchived: true,
      attempts: [...confirmed], latest: { reconcile: task('reconcile', 'DEAD') }, stoppedKinds: [stopped('reconcile')] });
    expect(verified).toMatchObject({ lifecycle: 'VERIFIED_RESOLVED', conditions: [], resolution: ['OUTCOME_RECONCILED_AFTER_STOP'], flagged: true, outcome: 'COMPLETED' });
    // Same terminal status without an Evidence Bundle: no active condition, but nothing proves the stop was addressed.
    const historical = classify({ runId: 'r2', flow: 'base-sepolia-swap', status: 'RECONCILED', provenance: 'PUBLIC_TESTNET', hasEvidence: false,
      latest: { reconcile: task('reconcile', 'DEAD') }, stoppedKinds: [stopped('reconcile')] });
    expect(historical).toMatchObject({ lifecycle: 'HISTORICAL', conditions: [], resolution: [] });
    expect(historical.stopped[0]).toMatchObject({ status: 'NOT_REQUIRED', basis: null });
    expect(historical.explanation).toMatch(/not a verified resolution/);
    // Flagged with no stopped task recorded at all: the cause cannot be reconstructed, so never "verified".
    expect(classify({ runId: 'r3', flow: 'solana-devnet-swap', status: 'COMPLETED', provenance: 'PUBLIC_DEVNET', hasEvidence: true })).toMatchObject({ lifecycle: 'HISTORICAL' });
    // A later run of the same task completed.
    expect(classify({ runId: 'r4', flow: 'base-sepolia-swap', status: 'RECONCILED', provenance: 'PUBLIC_TESTNET', hasEvidence: true, evidenceArchived: true,
      latest: { 'evidence.archive': task('evidence.archive', 'DONE', null, '12') }, stoppedKinds: [stopped('evidence.archive', 'DONE')] }))
      .toMatchObject({ lifecycle: 'VERIFIED_RESOLVED', resolution: ['TASK_COMPLETED_AFTER_STOP'] });
  });

  it('2. a terminal execution with a genuinely unresolved independent incident stays active', () => {
    const archive = classify({ runId: 'r5', flow: 'solana-devnet-swap', status: 'COMPLETED', provenance: 'PUBLIC_DEVNET', hasEvidence: true, evidenceArchived: false,
      latest: { 'evidence.archive': task('evidence.archive', 'DEAD', 'EVIDENCE_STORE_NOT_CONFIGURED') }, stoppedKinds: [stopped('evidence.archive', 'DEAD', 'EVIDENCE_STORE_NOT_CONFIGURED')] });
    expect(archive).toMatchObject({ lifecycle: 'ACTIVE', outcome: 'COMPLETED', conditions: ['EVIDENCE_ARCHIVE_STOPPED'] });
    // Another task kind tied to the run stopped and was never superseded.
    expect(classify({ runId: 'r6', flow: 'base-sepolia-swap', status: 'RECONCILED', provenance: 'PUBLIC_TESTNET', hasEvidence: true, evidenceArchived: true,
      stoppedKinds: [stopped('notification.deliver', 'DEAD', 'WORK_HANDLER_FAILED')] })).toMatchObject({ lifecycle: 'ACTIVE', conditions: ['TASK_STOPPED'] });
    // Active does not require the flag: an unflagged run whose outcome is unknown is active.
    expect(classify({ runId: 'r7', flow: 'base-swap', status: 'INCONCLUSIVE', provenance: 'PUBLIC_MAINNET', attention: false })).toMatchObject({ lifecycle: 'ACTIVE',
      conditions: ['OUTCOME_UNKNOWN'], flagged: false, realFunds: true });
    // A stopped task queued again is still active until it finishes.
    expect(classify({ runId: 'r8', flow: 'base-sepolia-swap', status: 'RECONCILED', provenance: 'PUBLIC_TESTNET', hasEvidence: true,
      latest: { 'evidence.archive': task('evidence.archive', 'READY', null, '13') }, stoppedKinds: [stopped('evidence.archive', 'READY')] }))
      .toMatchObject({ lifecycle: 'ACTIVE', conditions: ['RETRY_PENDING'] });
  });

  it('3. a reconciled transaction with an unrelated owner review requirement: the review is reported apart and is neither an incident nor a resolution', () => {
    const jupiter: Shape = { runId: 'jup-mainnet', flow: 'jupiter-swap', status: 'RECONCILED', provenance: 'PUBLIC_MAINNET', errorCode: 'JUPITER_SEMANTIC_EDIT_REQUIRES_REVIEW',
      hasEvidence: true, evidenceArchived: false };
    expect(OWNER_REVIEW_CODE.test('JUPITER_SEMANTIC_EDIT_REQUIRES_REVIEW')).toBe(true);
    // With no stopped task recorded: historical — the terminal status and the evidence flag alone do not verify anything.
    const unknownCause = classify(jupiter);
    expect(unknownCause).toMatchObject({ lifecycle: 'HISTORICAL', ownerReviewPending: true, conditions: [] });
    expect(unknownCause.explanation).toMatch(/owner edited the workflow after review/);
    // With a stopped archive: active because of the archive, not because of the review code.
    expect(classify({ ...jupiter, latest: { 'evidence.archive': task('evidence.archive', 'DEAD') }, stoppedKinds: [stopped('evidence.archive')] }))
      .toMatchObject({ lifecycle: 'ACTIVE', conditions: ['EVIDENCE_ARCHIVE_STOPPED'], ownerReviewPending: true });
    expect(explainCode('JUPITER_SEMANTIC_EDIT_REQUIRES_REVIEW')).toMatchObject({ label: 'Owner review required', remedy: 'USER' });
  });

  it('4/7. an uncertain execution without a transaction hash or evidence stays unresolved — never failed, never resolved', () => {
    const noHash = shape({ runId: 'r9', flow: 'base-swap', status: 'SUBMISSION_RESULT_UNKNOWN', provenance: 'PUBLIC_MAINNET', attention: false, needsObservation: false,
      attempts: [{ step: 'SWAP', state: 'SUBMISSION_RESULT_UNKNOWN', hash: false, reconciled: false }] });
    expect(runAttention(noHash.run, noHash.facts, null, now)).toMatchObject({ lifecycle: 'ACTIVE', outcome: 'UNCERTAIN', conditions: ['OUTCOME_UNKNOWN'] });
    expect(submissionOf(noHash.run)).toBe('UNKNOWN');
    expect(executionIncident(noHash.run, noHash.facts, now)).toMatchObject({ kind: 'OUTCOME_UNCERTAIN', outcome: 'Outcome unknown', outcomeKnown: false, lifecycle: 'ACTIVE' });
  });

  it('5/6. the two exhausted mainnet reconciliations (500 deliveries) are active, high severity and only recoverable by an operator-run read-only check', () => {
    for (const execution of [EXECUTION_A, EXECUTION_B]) {
      const { run, facts } = shape(execution), attention = runAttention(run, facts, null, now);
      expect(attention).toMatchObject({ lifecycle: 'ACTIVE', outcome: 'UNCERTAIN', realFunds: true, conditions: ['OBSERVATION_EXHAUSTED', 'OUTCOME_UNKNOWN'] });
      expect(facts.latest.reconcile!.deliveries).toBe(500);
      const incident = executionIncident(run, facts, now, attention)!;
      expect(incident).toMatchObject({ kind: 'OBSERVATION_STOPPED', severity: 'HIGH', funds: 'POSSIBLE', submitted: 'UNKNOWN', outcomeKnown: false, category: 'CROSS_CHAIN' });
      expect(incident.outcome).not.toMatch(/fail|complet/i);
      // The registered action re-observes only; it is eligible, and nothing here runs it (deriving an incident never writes).
      expect(RECOVERY_ACTIONS['execution.resume-observation'].check(facts)).toEqual({ eligible: true });
      expect(incident.actions).toEqual([{ id: 'execution.resume-observation', eligible: true, reason: null }]);
    }
    // A nonce consumed by a different transaction is not proof that the intended transaction executed or failed.
    expect(explainCode(EXECUTION_A.errorCode)).toMatchObject({ label: 'Nonce used by a different transaction', remedy: 'UNKNOWN', userAction: null });
    expect(explainCode(EXECUTION_B.errorCode)).toMatchObject({ label: 'Transaction not observed', remedy: 'UNKNOWN', userAction: null });
    expect(explainCode('ROUTER_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION')!.meaning).toMatch(/outcome stays unknown/);
  });

  it('8. conflicting or inconclusive evidence is never resolved, even after its check completed', () => {
    const inconclusive = classify({ runId: 'r10', flow: 'base-swap', status: 'INCONCLUSIVE', provenance: 'PUBLIC_MAINNET', needsObservation: false,
      latest: { reconcile: task('reconcile', 'DONE', null, '30') }, stoppedKinds: [stopped('reconcile', 'DONE')] });
    expect(inconclusive).toMatchObject({ lifecycle: 'ACTIVE', conditions: ['OUTCOME_UNKNOWN'] });
    // A completed re-run is not resolution evidence on its own (a check completes whatever the verdict).
    expect(inconclusive.stopped[0]).toMatchObject({ status: 'NOT_REQUIRED', basis: null });
    expect(classify({ runId: 'r11', flow: 'base-swap', status: 'DIVERGENT', provenance: 'PUBLIC_MAINNET', stoppedKinds: [stopped('reconcile', 'DONE')],
      attempts: [{ step: 'SWAP', state: 'CONFIRMED', hash: true, reconciled: false }] })).toMatchObject({ outcome: 'FAILED' });
  });

  it('9. the production snapshot: active versus historical counts come from durable evidence, not from the status', () => {
    const testnet = (i: number, over: Partial<Shape> = {}): Shape => ({ runId: `tn-${i}`, flow: 'base-sepolia-swap', status: 'RECONCILED', provenance: 'PUBLIC_TESTNET',
      hasEvidence: true, evidenceArchived: true, latest: { reconcile: task('reconcile', 'DEAD') }, stoppedKinds: [stopped('reconcile')], ...over });
    const snapshot: Shape[] = [
      ...[0, 1, 2, 3, 4, 5].map(i => testnet(i)),                                                                                  // RECONCILED · PUBLIC_TESTNET × 6
      testnet(6, { runId: 'dv-0', provenance: 'PUBLIC_DEVNET', flow: 'solana-devnet-swap' }), testnet(7, { runId: 'dv-1', provenance: 'PUBLIC_DEVNET', flow: 'orca-liquidity',
        hasEvidence: false }),                                                                                                     // RECONCILED · PUBLIC_DEVNET × 2
      { runId: 'dv-2', flow: 'solana-devnet-composition', status: 'COMPLETED', provenance: 'PUBLIC_DEVNET', hasEvidence: true, evidenceArchived: false,
        latest: { 'evidence.archive': task('evidence.archive', 'DEAD') }, stoppedKinds: [stopped('evidence.archive')] },               // COMPLETED · PUBLIC_DEVNET × 1
      { runId: 'jup-mainnet', flow: 'jupiter-swap', status: 'RECONCILED', provenance: 'PUBLIC_MAINNET', errorCode: 'JUPITER_SEMANTIC_EDIT_REQUIRES_REVIEW',
        hasEvidence: true, evidenceArchived: true, latest: { reconcile: task('reconcile', 'DEAD') }, stoppedKinds: [stopped('reconcile')] },     // RECONCILED · PUBLIC_MAINNET × 1
      EXECUTION_A, EXECUTION_B,                                                                                                    // SUBMISSION_RESULT_UNKNOWN · PUBLIC_MAINNET × 2
    ];
    const attention = snapshot.map(s => classify(s));
    expect(attention.every(a => a.flagged)).toBe(true);
    expect(countAttention(attention)).toMatchObject({ active: 3, underInvestigation: 0, historical: 1, resolved: 8, activeRealFunds: 2, observationExhausted: 2,
      unknownOutcome: 2, evidence: 1, ownerReviewPending: 1 });
    // Ten terminal statuses, but one of them still has an unresolved evidence-archive stop: it is active and says why.
    expect(attention.find(a => a.runId === 'dv-2')).toMatchObject({ lifecycle: 'ACTIVE', outcome: 'COMPLETED', conditions: ['EVIDENCE_ARCHIVE_STOPPED'] });
    expect(attention.find(a => a.runId === 'dv-1')).toMatchObject({ lifecycle: 'HISTORICAL' });
    expect(attention.find(a => a.runId === 'jup-mainnet')).toMatchObject({ lifecycle: 'VERIFIED_RESOLVED', ownerReviewPending: true });
  });

  it('11/15. classification is pure: inputs are not mutated, recovery eligibility and state tokens are unchanged by the stopped-task history', () => {
    const { run, facts } = shape(EXECUTION_A);
    const frozen = structuredClone({ run, facts });
    runAttention(run, facts, null, now); executionIncident(run, facts, now);
    expect({ run, facts }).toEqual(frozen);
    const withoutHistory = { ...facts, stoppedKinds: [] };
    expect(stateToken(withoutHistory, 'execution.resume-observation')).toBe(stateToken(facts, 'execution.resume-observation'));
    expect(RECOVERY_ACTIONS['execution.resume-observation'].check(withoutHistory)).toEqual(RECOVERY_ACTIONS['execution.resume-observation'].check(facts));
  });

  it('under investigation needs an explicit review note; a resolution note never overrides an active condition', () => {
    expect(investigationOf('ACKNOWLEDGEMENT')).toBe('ACKNOWLEDGED');
    expect(investigationOf('ESCALATION')).toBe('ACKNOWLEDGED');
    expect(investigationOf('RESOLUTION')).toBe('RESOLUTION_NOTED');
    expect(investigationOf(null)).toBeNull();
    expect(classify(EXECUTION_A, 'ACKNOWLEDGED').lifecycle).toBe('UNDER_INVESTIGATION');
    const noted = classify(EXECUTION_A, 'RESOLUTION_NOTED');
    expect(noted.lifecycle).toBe('ACTIVE');
    expect(noted.explanation).toMatch(/still shows the condition/);
    // A note never turns a historical flag into an active incident or a verified resolution.
    expect(classify({ runId: 'h', flow: 'base-swap', status: 'RECONCILED', provenance: 'PUBLIC_TESTNET' }, 'ACKNOWLEDGED').lifecycle).toBe('HISTORICAL');
  });

  it('runs still observed normally, or never flagged, have no lifecycle', () => {
    const observing = shape({ runId: 'o', flow: 'base-swap', status: 'PENDING', provenance: 'PUBLIC_MAINNET', attention: false, needsObservation: true,
      latest: { reconcile: task('reconcile', 'READY', null, '40') } });
    expect(runAttention(observing.run, observing.facts, null, now)).toMatchObject({ lifecycle: null, awaitingObservation: true });
    expect(classify({ runId: 'n', flow: 'base-swap', status: 'RECONCILED', provenance: 'PUBLIC_MAINNET', attention: false }).lifecycle).toBeNull();
  });

  it('review fixes: stale notes, flagged runs still observed, missing facts, recovered runs, unknown statuses and permanent stop reasons', () => {
    // A note written before the latest stop was about an earlier occurrence: it does not mark the new stop under investigation.
    const { run, facts } = shape(EXECUTION_A);
    expect(runAttention(run, facts, 'ACKNOWLEDGED', now, new Date(now.getTime() - 3 * day)).lifecycle).toBe('ACTIVE');
    expect(runAttention(run, facts, 'ACKNOWLEDGED', now, new Date(now.getTime() - day)).lifecycle).toBe('UNDER_INVESTIGATION');
    // A flagged run that still needs observation is never historical: the sweeper never re-arms a flagged run, so no open check = not scheduled.
    const observed = { runId: 'f1', flow: 'base-swap', status: 'HASH', provenance: 'PUBLIC_MAINNET', needsObservation: true,
      latest: { reconcile: task('reconcile', 'DONE', null, '50') }, stoppedKinds: [stopped('reconcile', 'DONE')] };
    const recent = shape(observed);
    expect(runAttention({ ...recent.run, updatedAt: new Date(now.getTime() - 60_000) }, recent.facts, null, now)).toMatchObject({ lifecycle: 'ACTIVE',
      conditions: ['OBSERVATION_NOT_SCHEDULED'] });
    expect(classify({ ...observed, runId: 'f2', latest: { reconcile: task('reconcile', 'READY', null, '51') }, stoppedKinds: [stopped('reconcile', 'READY')] }))
      .toMatchObject({ lifecycle: 'ACTIVE', conditions: ['RETRY_PENDING'] });
    // Facts that cannot be read never make a flagged run historical or resolved.
    expect(runAttention(shape({ runId: 'f3', flow: 'base-swap', status: 'RECONCILED', provenance: 'PUBLIC_MAINNET' }).run, undefined, null, now))
      .toMatchObject({ lifecycle: 'ACTIVE', conditions: ['FACTS_UNAVAILABLE'] });
    // A run recovered through Support (flag cleared) keeps its lifecycle through its stopped-task history.
    const recovered: Shape = { runId: 'f4', flow: 'base-sepolia-swap', status: 'RECONCILED', provenance: 'PUBLIC_TESTNET', attention: false, hasEvidence: true,
      evidenceArchived: true, latest: { 'evidence.archive': task('evidence.archive', 'DONE', null, '60') }, stoppedKinds: [stopped('evidence.archive', 'DONE')] };
    expect(classify(recovered)).toMatchObject({ lifecycle: 'VERIFIED_RESOLVED', flagged: false });
    expect(classify({ ...recovered, evidenceArchived: false, latest: { 'evidence.archive': task('evidence.archive', 'READY', null, '61') },
      stoppedKinds: [stopped('evidence.archive', 'READY')] })).toMatchObject({ lifecycle: 'ACTIVE', conditions: ['RETRY_PENDING'] });
    // An unrecognised status is never verified resolved, even when every stop has evidence.
    const unknown: Shape = { runId: 'f5', flow: 'base-swap', status: 'SETTLING_V2', provenance: 'PUBLIC_MAINNET', hasEvidence: false, attempts: [],
      latest: { reconcile: task('reconcile', 'DONE', null, '62') }, stoppedKinds: [stopped('reconcile', 'DONE')] };
    expect(classify(unknown)).toMatchObject({ lifecycle: 'ACTIVE', outcome: 'NOT_STARTED', conditions: ['UNCLASSIFIED_STATUS'] }); // not recognised: never final
    expect(classify({ ...recovered, runId: 'f5b', status: 'SETTLING_V2', attention: true })).toMatchObject({ lifecycle: 'ACTIVE', conditions: ['UNCLASSIFIED_STATUS'] });
    // A check that stopped for a permanent reason is not superseded by the reconciled verdict.
    expect(classify({ runId: 'f6', flow: 'base-sepolia-swap', status: 'RECONCILED', provenance: 'PUBLIC_TESTNET', hasEvidence: true, evidenceArchived: true,
      latest: { reconcile: task('reconcile', 'DEAD', 'WORK_PAYLOAD_INVALID') }, stoppedKinds: [stopped('reconcile', 'DEAD', 'WORK_PAYLOAD_INVALID')] }))
      .toMatchObject({ lifecycle: 'HISTORICAL', resolution: [] });
  });

  it('review fixes: the new code explanations never widen what the registry may retry', () => {
    for (const code of ['SWAP_TRANSACTION_PENDING', 'ROUTER_TRANSACTION_PENDING', 'UNIVERSAL_TRANSACTION_PENDING', 'UNIVERSAL_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION',
      'ROUTER_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION', 'ROUTER_TRANSACTION_NOT_OBSERVED', 'UNIVERSAL_TRANSACTION_NOT_OBSERVED', 'JUPITER_SEMANTIC_EDIT_REQUIRES_REVIEW',
      'UNIVERSAL_WALLET_CHANGED_REVIEW_REQUIRED', 'ROUTER_STATE_CORRUPT_TRANSACTION_PENDING']) expect([code, retryableStopReason(code)]).toEqual([code, false]);
    expect(retryableStopReason('OBSERVATION_BUDGET_EXHAUSTED')).toBe(true);
    expect(explainCode('ROUTER_STATE_CORRUPT_TRANSACTION_PENDING')).toMatchObject({ remedy: 'CODE' });
  });

  it('review fixes: free-text screening refuses Brazilian document and phone formats and IP addresses, and keeps dates and record ids', () => {
    for (const text of ['cliente CPF 123.456.789-09', 'CNPJ 12.345.678/0001-90', 'RG 12.345.678-9', 'ligar (11) 98765-4321', 'tel 11 3456-7890', 'from 192.168.10.20'])
      expect([text, identifierShaped(text)]).toEqual([text, true]);
    for (const text of ['Provider outage resolved on 2026-11-14 at 14:30', 'Escalated run xuni-379461c2e3f1807a0dc0455342a51d21', 'Retry 3 of 3, step 2', 'v1.2 release'])
      expect([text, identifierShaped(text)]).toEqual([text, false]);
  });

  it('wallet-execution review: a divergent verdict is never verified resolved; proven non-execution is; an uncertain status stays unknown while retried', () => {
    // H1: the check stopped, a later check completed, but the verdict is DIVERGENT (funds moved differently from the review).
    const divergent: Shape = { runId: 'w1', flow: 'crosschain-universal', status: 'DIVERGENT', provenance: 'PUBLIC_MAINNET', needsObservation: false,
      attempts: [{ step: 'DEPOSIT', state: 'RECONCILIATION_REQUIRED', hash: true, reconciled: false }],
      latest: { reconcile: task('reconcile', 'DONE', null, '70') }, stoppedKinds: [stopped('reconcile', 'DONE')] };
    const d = classify(divergent);
    expect(d).toMatchObject({ lifecycle: 'ACTIVE', conditions: ['RESULT_DIVERGED'], resolution: [] });
    const dShape = shape(divergent), dIncident = executionIncident(dShape.run, dShape.facts, now)!;
    expect(dIncident).toMatchObject({ kind: 'RESULT_DIVERGED', severity: 'HIGH', eligibility: 'INVESTIGATION', actions: [], lifecycle: 'ACTIVE' });
    // M1: the router's deposit-deadline verdict (FAILED, NOT_FOUND attempt, no hash) is the service's proof that nothing landed.
    const expired: Shape = { runId: 'w2', flow: 'crosschain-router-arbitrum-to-base', status: 'FAILED', provenance: 'PUBLIC_MAINNET', needsObservation: false,
      errorCode: 'ROUTER_SUBMISSION_EXPIRED_NOT_EXECUTED', attempts: [{ step: 'DEPOSIT', state: 'NOT_FOUND', hash: false, reconciled: false }],
      latest: { reconcile: task('reconcile', 'DONE', null, '71') }, stoppedKinds: [stopped('reconcile', 'DONE')] };
    expect(classify(expired)).toMatchObject({ lifecycle: 'VERIFIED_RESOLVED', resolution: ['NOT_EXECUTED_PROVEN'] });
    const eShape = shape(expired);
    expect(executionIncident(eShape.run, eShape.facts, now)).toMatchObject({ outcome: 'Not executed — expired before it could land (service verdict)', actions: [] });
    // The same code on a legacy approval whose status is still SUBMISSION_RESULT_UNKNOWN proves nothing.
    expect(classify({ ...expired, runId: 'w3', status: 'SUBMISSION_RESULT_UNKNOWN', attempts: [{ step: 'APPROVAL', state: 'NOT_FOUND', hash: false, reconciled: false }] }))
      .toMatchObject({ lifecycle: 'ACTIVE', conditions: ['OUTCOME_UNKNOWN'] });
    // L2: after a Support resume clears the flag, Executions A and B stay "outcome unknown" (high on mainnet) while the re-queued check runs.
    const resumed: Shape = { ...EXECUTION_A, attention: false, latest: { reconcile: task('reconcile', 'READY', null, '72') }, stoppedKinds: [stopped('reconcile', 'READY')] };
    const r = shape(resumed);
    expect(runAttention(r.run, r.facts, null, now)).toMatchObject({ lifecycle: 'ACTIVE', conditions: ['RETRY_PENDING', 'OUTCOME_UNKNOWN'] });
    expect(executionIncident(r.run, r.facts, now)).toMatchObject({ kind: 'OUTCOME_UNCERTAIN', severity: 'HIGH', eligibility: 'WAITING_EXTERNAL', outcome: 'Outcome unknown',
      outcomeKnown: false });
    // L1: an unflagged run with a stopped check whose re-run finished one pass but still needs observation is not historical.
    const pass: Shape = { runId: 'w4', flow: 'base-swap', status: 'PENDING', provenance: 'PUBLIC_MAINNET', attention: false, needsObservation: true,
      attempts: [{ step: 'SWAP', state: 'PENDING', hash: true, reconciled: false }], latest: { reconcile: task('reconcile', 'DONE', null, '73') }, stoppedKinds: [stopped('reconcile', 'DONE')] };
    const p1 = shape(pass);
    expect(runAttention({ ...p1.run, updatedAt: new Date(now.getTime() - 60_000) }, p1.facts, null, now)).toMatchObject({ lifecycle: 'ACTIVE', conditions: ['RETRY_PENDING'] });
    // M4: neighbouring uncertainty codes never advise starting again.
    for (const code of ['UNIVERSAL_NONCE_COLLISION_PENDING', 'ROUTER_RECEIPT_NOT_CANONICAL', 'ROUTER_REPORTED_REJECTED_UNPROVEN'])
      expect(explainCode(code)).toMatchObject({ remedy: 'UNKNOWN', userAction: null });
    expect(explainCode('ROUTE_STALE')).toMatchObject({ label: 'Quote or route problem' });
  });
});
