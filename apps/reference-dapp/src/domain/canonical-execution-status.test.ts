// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { CANONICAL_EXECUTION_STATUSES, canonicalRunLifecycle } from './canonical-execution-status';
import { projectDashboardRun } from '../lib/dashboard/run-mapping';
import type { DashboardRun } from '../lib/dashboard/types';

const run = (status: string, patch: Partial<DashboardRun> = {}): DashboardRun => ({ runId: 'r', workflowId: 'w', flow: 'base-swap', status, provenance: 'PUBLIC_MAINNET',
  ownerAccount: '0x1111111111111111111111111111111111111111', errorCode: null, needsObservation: false, attentionRequired: false, hasEvidence: false,
  createdAt: null, updatedAt: null, ...patch });
const STATUSES = ['QUOTED', 'SIMULATED', 'REVIEWED', 'AUTHORIZED', 'PREPARED', 'RESERVED', 'SUBMITTING', 'SIGNED', 'HASH', 'PENDING', 'CONFIRMED', 'SOURCE_CONFIRMED',
  'IN_FLIGHT', 'DESTINATION_OBSERVED', 'SETTLING', 'RECONCILED', 'PARTIAL', 'PARTIALLY_COMPLETED', 'REVERTED', 'FAILED', 'CANCELLED', 'REJECTED', 'UNKNOWN',
  'SUBMISSION_RESULT_UNKNOWN', 'SOURCE_SUBMITTED', 'REFUNDED', 'NOT_SUBMITTED', 'RECONCILIATION_REQUIRED', 'NOT_EXECUTED', 'EXPIRED', 'PAUSED',
  'DIVERGENT', 'RECOVERY_REQUIRED', 'NOT_FOUND', 'INCONCLUSIVE', 'COMPLETED', 'SETTLED', 'SOMETHING_NEW',
  // Pix payment states and composition phases the flows record.
  'DRAFT', 'PAYMENT_PENDING', 'PAYMENT_SETTLED', 'EXECUTING', 'PRODUCING', 'BOUND', 'CONSUMING', 'ATTENTION'];

describe('BUILD-FLOFI-EXECUTION-PERFORMANCE-001 canonical execution status', () => {
  it('only a reconciled outcome is completed; a hash, a confirmation or an origin-side bridge record never is', () => {
    for (const status of STATUSES) for (const needsObservation of [false, true]) for (const attentionRequired of [false, true]) {
      const lifecycle = canonicalRunLifecycle(run(status, { needsObservation, attentionRequired }));
      expect(CANONICAL_EXECUTION_STATUSES).toContain(lifecycle.status);
      expect(lifecycle.completed).toBe(status === 'RECONCILED' && !needsObservation);
      if (lifecycle.completed) expect(lifecycle.final).toBe(true);
    }
    expect(canonicalRunLifecycle(run('HASH')).status).toBe('HASH_KNOWN');
    expect(canonicalRunLifecycle(run('CONFIRMED')).status).toBe('CONFIRMED_ONCHAIN');
    expect(canonicalRunLifecycle(run('SOURCE_CONFIRMED')).status).toBe('SETTLEMENT_PENDING');
    expect(canonicalRunLifecycle(run('SOMETHING_NEW')).status).toBe('INTERVENTION_REQUIRED');
    expect(canonicalRunLifecycle(run('SUBMISSION_RESULT_UNKNOWN'))).toMatchObject({ status: 'INCONCLUSIVE', final: false });
    expect(canonicalRunLifecycle(run('SOURCE_SUBMITTED')).status).toBe('SUBMITTED');
    expect(canonicalRunLifecycle(run('REFUNDED'))).toMatchObject({ status: 'FAILED', final: true, completed: false });
    expect(canonicalRunLifecycle(run('NOT_SUBMITTED')).status).toBe('REJECTED');
    expect(canonicalRunLifecycle(run('PARTIAL', { needsObservation: true }))).toMatchObject({ status: 'PARTIALLY_COMPLETED', final: false });
    expect(canonicalRunLifecycle(run('NOT_EXECUTED'))).toMatchObject({ status: 'REJECTED', final: true });
    expect(canonicalRunLifecycle(run('DIVERGENT')).status).toBe('INTERVENTION_REQUIRED');
    expect(canonicalRunLifecycle(run('NOT_FOUND')).status).toBe('INCONCLUSIVE');
    expect(canonicalRunLifecycle(run('COMPLETED'))).toMatchObject({ status: 'CONFIRMED_ONCHAIN', completed: false });
  });
  it('agrees with the Dashboard on completion, refusal, failure and uncertainty (the same durable summary, one meaning)', () => {
    for (const status of STATUSES) for (const needsObservation of [false, true]) for (const attentionRequired of [false, true]) for (const hasEvidence of [false, true])
    for (const errorCode of [null, 'PAYMENT_WALLET_RESULT_UNKNOWN']) {
      const summary = run(status, { needsObservation, attentionRequired, hasEvidence, errorCode }), lifecycle = canonicalRunLifecycle(summary);
      const dashboard = projectDashboardRun(summary).status, label = `${status} observing=${needsObservation} evidence=${hasEvidence} ${errorCode}`;
      expect(['Completed', 'Completed with attention'].includes(dashboard), label).toBe(lifecycle.completed);
      // Neither ever says "not started" (nothing sent) when the other knows something may have been sent.
      expect(lifecycle.status === 'NOT_STARTED', label).toBe(dashboard === 'Not started');
      if (lifecycle.status === 'REJECTED') expect(dashboard).toBe('Transaction not submitted');
      if (lifecycle.status === 'RECONCILED_WITH_ATTENTION') expect(dashboard).toBe('Completed with attention');
      if (lifecycle.status === 'PARTIALLY_COMPLETED') expect(dashboard).toBe('Partially completed');
      if (['HASH_KNOWN', 'SETTLEMENT_PENDING', 'SUBMITTED'].includes(lifecycle.status)) expect(dashboard).toBe('In progress');
      if (lifecycle.status === 'FAILED' || lifecycle.status === 'REVERTED') expect(dashboard).toBe('Needs attention');
      if (lifecycle.status === 'INCONCLUSIVE') expect(['Unresolved', 'Needs attention']).toContain(dashboard);
    }
  });
  it('reads the latest attempt: a prepared attempt awaits the wallet; a pending one without a hash is submitted, with one is hash-known', () => {
    expect(canonicalRunLifecycle({ status: 'AUTHORIZED', attempts: [{ state: 'PREPARED' }] }).status).toBe('AUTHORIZATION_PENDING');
    expect(canonicalRunLifecycle({ status: 'PENDING', attempts: [{ state: 'PENDING' }] }).status).toBe('SUBMITTED');
    expect(canonicalRunLifecycle({ status: 'PENDING', attempts: [{ state: 'PENDING', transactionHash: '0xabc' }] }).status).toBe('HASH_KNOWN');
    expect(canonicalRunLifecycle({ status: 'PREPARED', errorCode: 'X_SUBMISSION_EXPIRED_NOT_EXECUTED' }).status).toBe('INCONCLUSIVE');
    // A multi-step run between steps: the approval is confirmed onchain, so it is never "not started" (nothing sent).
    expect(canonicalRunLifecycle({ status: 'AUTHORIZED', attempts: [{ state: 'CONFIRMED', transactionHash: '0xabc' }] }).status).toBe('CONFIRMED_ONCHAIN');
    expect(canonicalRunLifecycle({ status: 'PAUSED', attempts: [{ state: 'CONFIRMED' }, { state: 'CANCELLED' }] }).status).toBe('CONFIRMED_ONCHAIN');
    expect(canonicalRunLifecycle({ status: 'NOT_SUBMITTED', attempts: [{ state: 'CONFIRMED' }, { state: 'NOT_SUBMITTED' }] }))
      .toMatchObject({ status: 'PARTIALLY_COMPLETED', final: true, completed: false });
    // A hash is claimed only when one is recorded.
    expect(canonicalRunLifecycle({ status: 'PENDING' }).status).toBe('SUBMITTED');
    expect(canonicalRunLifecycle({ status: 'SOURCE_SUBMITTED', attempts: [{ state: 'SUBMITTED', transactionHash: '0xabc' }] }).status).toBe('HASH_KNOWN');
  });
  it('never says "nothing was sent" once the wallet was asked: a submission in flight or with an unknown result is INCONCLUSIVE (Pix keeps AUTHORIZED)', () => {
    // The Pix flow keeps the run AUTHORIZED while its attempt is being submitted or its wallet result is unknown.
    expect(canonicalRunLifecycle({ status: 'AUTHORIZED', errorCode: 'PAYMENT_WALLET_RESULT_UNKNOWN',
      attempts: [{ state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: null, reconciled: false }] })).toMatchObject({ status: 'INCONCLUSIVE', final: false });
    expect(canonicalRunLifecycle({ status: 'AUTHORIZED', attempts: [{ state: 'SUBMITTING' }] }).status).toBe('INCONCLUSIVE');
    // Without attempts (the Dashboard's summaries), the recorded error alone is enough.
    expect(canonicalRunLifecycle({ status: 'AUTHORIZED', errorCode: 'PAYMENT_WALLET_RESULT_UNKNOWN' }).status).toBe('INCONCLUSIVE');
    expect(projectDashboardRun(run('AUTHORIZED', { errorCode: 'PAYMENT_WALLET_RESULT_UNKNOWN' })).status).toBe('Unresolved');
    expect(canonicalRunLifecycle({ status: 'AUTHORIZED', attempts: [{ state: 'REFUSED' }] })).toMatchObject({ status: 'REJECTED', final: true });
    expect(canonicalRunLifecycle({ status: 'AUTHORIZED', attempts: [{ state: 'SUBMITTED', transactionHash: '0xabc' }] }).status).toBe('HASH_KNOWN');
    expect(canonicalRunLifecycle({ status: 'AUTHORIZED', attempts: [{ state: 'WHATEVER_NEXT' }] }).status).toBe('INTERVENTION_REQUIRED');
    expect(canonicalRunLifecycle({ status: 'AUTHORIZED', attempts: [] }).status).toBe('NOT_STARTED');
  });
  it('reads Pix and composition states as the flows record them; a settled label is completed only with recorded evidence', () => {
    expect(canonicalRunLifecycle({ status: 'PAYMENT_PENDING' }).status).toBe('SETTLEMENT_PENDING');
    expect(canonicalRunLifecycle({ status: 'PAYMENT_SETTLED' })).toMatchObject({ status: 'SETTLEMENT_PENDING', completed: false });
    expect(canonicalRunLifecycle({ status: 'PAYMENT_SETTLED', hasEvidence: true })).toMatchObject({ status: 'RECONCILED', final: true, completed: true });
    expect(canonicalRunLifecycle({ status: 'PAYMENT_SETTLED', hasEvidence: true, needsObservation: true }).completed).toBe(false);
    expect(canonicalRunLifecycle({ status: 'COMPLETED', hasEvidence: true })).toMatchObject({ status: 'RECONCILED', completed: true });
    expect(canonicalRunLifecycle({ status: 'COMPLETED', hasEvidence: true, errorCode: 'X' }).status).toBe('RECONCILED_WITH_ATTENTION');
    expect(projectDashboardRun(run('PAYMENT_SETTLED', { hasEvidence: true })).status).toBe('Completed');
    expect(canonicalRunLifecycle({ status: 'DRAFT' }).status).toBe('NOT_STARTED');
    // Working phases follow the latest attempt; without one, nothing is claimed either way.
    expect(canonicalRunLifecycle({ status: 'EXECUTING', attempts: [{ state: 'PENDING' }] }).status).toBe('SUBMITTED');
    expect(canonicalRunLifecycle({ status: 'CONSUMING', attempts: [{ state: 'CONFIRMED' }, { state: 'PREPARED' }] }).status).toBe('AUTHORIZATION_PENDING');
    expect(canonicalRunLifecycle({ status: 'BOUND', attempts: [{ state: 'CONFIRMED' }] }).status).toBe('CONFIRMED_ONCHAIN');
    expect(canonicalRunLifecycle({ status: 'PRODUCING' }).status).toBe('INCONCLUSIVE');
    expect(canonicalRunLifecycle({ status: 'ATTENTION' }).status).toBe('INTERVENTION_REQUIRED');
  });
});
