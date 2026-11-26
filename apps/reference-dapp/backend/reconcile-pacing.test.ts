// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { backoffMs } from '@defi-workflow-engine/cloud-runtime';
import { reconcileDelayMs, SETTLEMENT_CADENCE_MS, SETTLEMENT_WINDOW_MS, SETTLING_OUTCOMES, TRANSIENT_RETRY_MS } from './reconcile-pacing.ts';
import { ADVANCE_RETRY_MS } from '../src/workflow-runs/state-machine.ts';

const createdAt = new Date('2026-11-25T12:00:00Z'), mid = () => 0.5;
const at = (ms: number) => createdAt.getTime() + ms;

describe('reconcile pacing (execution reconciliation regression)', () => {
  it('observes a settling bridge at the settlement cadence however many deliveries it already had', () => {
    for (const outcome of SETTLING_OUTCOMES) for (const deliveries of [1, 5, 8, 12, 40]) {
      const delay = reconcileDelayMs({ outcome, deliveries, createdAt, now: at(20 * 60_000), random: mid });
      expect(delay).toBe(Math.min(backoffMs(deliveries, mid), SETTLEMENT_CADENCE_MS));
      expect(delay).toBeLessThanOrEqual(SETTLEMENT_CADENCE_MS);
    }
  });
  it('a delivery awaiting finality after many observations no longer waits for the ten-minute backoff', () => {
    expect(backoffMs(12, mid)).toBe(600_000);
    expect(reconcileDelayMs({ outcome: 'DESTINATION_OBSERVED', phase: 'DESTINATION_OBSERVED', deliveries: 12, createdAt, now: at(15 * 60_000), random: mid })).toBe(15_000);
    // Jitter stays within ±20 %.
    expect(reconcileDelayMs({ outcome: 'DESTINATION_OBSERVED', deliveries: 12, createdAt, now: at(60_000), random: () => 0 })).toBe(12_000);
    expect(reconcileDelayMs({ outcome: 'DESTINATION_OBSERVED', deliveries: 12, createdAt, now: at(60_000), random: () => 1 })).toBe(18_000);
  });
  it('the window starts at the source confirmation when that is later than the work item (a long wallet prompt or unknown submission first)', () => {
    const confirmed = new Date(at(90 * 60_000)).toISOString();
    expect(reconcileDelayMs({ outcome: 'CONFIRMED', phase: 'IN_FLIGHT', settlingSince: confirmed, deliveries: 30, createdAt, now: at(100 * 60_000), random: mid })).toBe(15_000);
    expect(reconcileDelayMs({ outcome: 'CONFIRMED', phase: 'IN_FLIGHT', settlingSince: confirmed, deliveries: 30, createdAt, now: at(151 * 60_000), random: mid })).toBe(backoffMs(30, mid));
    // An unparseable confirmation time falls back to the work item's creation.
    expect(reconcileDelayMs({ outcome: 'CONFIRMED', settlingSince: 'not-a-date', deliveries: 30, createdAt, now: at(61 * 60_000), random: mid })).toBe(backoffMs(30, mid));
  });
  it('a refund wait (RECOVERY_REQUIRED) keeps the backoff, so the observation budget lasts for it', () => {
    expect(reconcileDelayMs({ outcome: 'CONFIRMED', phase: 'RECOVERY_REQUIRED', deliveries: 9, createdAt, now: at(60_000), random: mid })).toBe(backoffMs(9, mid));
  });
  it('a transient network failure inside the window is retried within a minute, never after the long backoff', () => {
    expect(reconcileDelayMs({ outcome: 'TEMPORARY_FAILURE', deliveries: 24, createdAt, now: at(6 * 60_000), random: mid })).toBe(TRANSIENT_RETRY_MS);
    expect(reconcileDelayMs({ outcome: 'TEMPORARY_FAILURE', deliveries: 1, createdAt, now: at(60_000), random: mid })).toBe(backoffMs(1, mid));
    expect(reconcileDelayMs({ outcome: 'TEMPORARY_FAILURE', deliveries: 24, createdAt, now: at(SETTLEMENT_WINDOW_MS), random: mid })).toBe(backoffMs(24, mid));
  });
  it('keeps the backoff for an unknown submission, a missing outcome and past the settlement window', () => {
    for (const outcome of ['UNDETERMINED', 'NOT_SUBMITTED', 'REVERTED', null, undefined])
      expect(reconcileDelayMs({ outcome, deliveries: 9, createdAt, now: at(60_000), random: mid })).toBe(backoffMs(9, mid));
    expect(reconcileDelayMs({ outcome: 'DESTINATION_OBSERVED', deliveries: 9, createdAt, now: at(SETTLEMENT_WINDOW_MS), random: mid })).toBe(backoffMs(9, mid));
  });
  it('PR #254 follow-up: a bridge in a multi-step workflow is paced the same way (no ten-minute wait on any path)', () => {
    // A step-by-step sequence runs each bridge as its own Router or universal run: the same flow records this worker observes, so the settlement
    // cadence above is theirs. A whole-workflow run's bridge step is observed by the workflow-run worker on every advance, at a fixed interval
    // that is never the doubling backoff.
    expect(ADVANCE_RETRY_MS).toBeLessThanOrEqual(20_000);
    expect(ADVANCE_RETRY_MS).toBeLessThan(backoffMs(12, mid));
    for (const flowOutcome of ['CONFIRMED', 'DESTINATION_OBSERVED'])
      expect(reconcileDelayMs({ outcome: flowOutcome, phase: flowOutcome === 'CONFIRMED' ? 'IN_FLIGHT' : 'DESTINATION_OBSERVED', deliveries: 20, createdAt, now: at(7 * 60_000), random: mid }))
        .toBe(SETTLEMENT_CADENCE_MS);
  });
  it('spends at most 300 of the 500-delivery observation budget inside the window', () => {
    expect(SETTLEMENT_WINDOW_MS / (SETTLEMENT_CADENCE_MS * 0.8)).toBeLessThanOrEqual(300);
  });
});
