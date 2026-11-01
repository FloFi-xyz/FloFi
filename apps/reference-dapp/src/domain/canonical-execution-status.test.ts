// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { CANONICAL_EXECUTION_STATUSES, canonicalRunLifecycle } from './canonical-execution-status';
import { projectDashboardRun } from '../lib/dashboard/run-mapping';
import type { DashboardRun } from '../lib/dashboard/types';

const run = (status: string, patch: Partial<DashboardRun> = {}): DashboardRun => ({ runId: 'r', workflowId: 'w', flow: 'base-swap', status, provenance: 'PUBLIC_MAINNET',
  ownerAccount: '0x1111111111111111111111111111111111111111', errorCode: null, needsObservation: false, attentionRequired: false, hasEvidence: false,
  createdAt: null, updatedAt: null, ...patch });
const STATUSES = ['QUOTED', 'SIMULATED', 'REVIEWED', 'AUTHORIZED', 'PREPARED', 'RESERVED', 'SUBMITTING', 'SIGNED', 'HASH', 'PENDING', 'CONFIRMED', 'SOURCE_CONFIRMED',
  'IN_FLIGHT', 'DESTINATION_OBSERVED', 'SETTLING', 'RECONCILED', 'PARTIAL', 'PARTIALLY_COMPLETED', 'REVERTED', 'FAILED', 'CANCELLED', 'REJECTED', 'UNKNOWN', 'SOMETHING_NEW'];

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
  });
  it('agrees with the Dashboard on completion, refusal, failure and uncertainty (the same durable summary, one meaning)', () => {
    for (const status of STATUSES) for (const needsObservation of [false, true]) for (const attentionRequired of [false, true]) {
      const summary = run(status, { needsObservation, attentionRequired }), lifecycle = canonicalRunLifecycle(summary), dashboard = projectDashboardRun(summary).status;
      expect(['Completed', 'Completed with attention'].includes(dashboard), `${status} ${needsObservation}`).toBe(lifecycle.completed);
      if (lifecycle.status === 'REJECTED') expect(dashboard).toBe('Transaction not submitted');
      if (lifecycle.status === 'RECONCILED_WITH_ATTENTION') expect(dashboard).toBe('Completed with attention');
      if (lifecycle.status === 'PARTIALLY_COMPLETED') expect(dashboard).toBe('Partially completed');
      if (['HASH_KNOWN', 'SETTLEMENT_PENDING', 'SUBMITTED'].includes(lifecycle.status)) expect(dashboard).toBe('In progress');
      if (lifecycle.status === 'INCONCLUSIVE') expect(['Unresolved', 'Needs attention']).toContain(dashboard);
    }
  });
  it('reads the latest attempt: a prepared attempt awaits the wallet; a pending one without a hash is submitted, with one is hash-known', () => {
    expect(canonicalRunLifecycle({ status: 'AUTHORIZED', attempts: [{ state: 'PREPARED' }] }).status).toBe('AUTHORIZATION_PENDING');
    expect(canonicalRunLifecycle({ status: 'PENDING', attempts: [{ state: 'PENDING' }] }).status).toBe('SUBMITTED');
    expect(canonicalRunLifecycle({ status: 'PENDING', attempts: [{ state: 'PENDING', transactionHash: '0xabc' }] }).status).toBe('HASH_KNOWN');
    expect(canonicalRunLifecycle({ status: 'PREPARED', errorCode: 'X_SUBMISSION_EXPIRED_NOT_EXECUTED' }).status).toBe('INCONCLUSIVE');
  });
});
