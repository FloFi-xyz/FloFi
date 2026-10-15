// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: run classification follows each flow's recorded vocabulary. A simulated or merely reviewed run never counts as executed;
 * a submitted hash alone is never success; a service's own "nothing landed" verdict is trusted; unknown statuses stay UNCLASSIFIED.
 */
import { describe, expect, it } from 'vitest';
import { classifyRun, executed, type AttemptFact, type RunFact } from './classify.ts';

const attempt = (state: string, hash = false, reconciled = false, step = 'SWAP'): AttemptFact => ({ step, state, hash, reconciled });
const run = (status: string, attempts: AttemptFact[] = [], over: Partial<RunFact> = {}): RunFact => ({ flow: 'base-sepolia-swap', status, needsObservation: false,
  attentionRequired: false, hasEvidence: false, journalAuthorized: false, attempts, ...over });
const outcome = (fact: RunFact) => { const c = classifyRun(fact); return [c.outcome, c.started, c.submitted, executed(c)]; };

describe('BUILD-ADMIN-001 run classification', () => {
  it('a simulation or an authorization alone is not an execution', () => {
    expect(outcome(run('SIMULATED'))).toEqual(['NOT_STARTED', false, false, false]);
    expect(classifyRun(run('SIMULATED')).authorized).toBe(false);
    expect(classifyRun(run('AUTHORIZED')).authorized).toBe(true);
    expect(outcome(run('AUTHORIZED'))).toEqual(['NOT_STARTED', false, false, false]);
    expect(outcome(run('PREPARED', [attempt('PREPARED')]))).toEqual(['NOT_STARTED', false, false, false]);
    expect(classifyRun(run('SIMULATED', [], { journalAuthorized: true })).authorized).toBe(true);
    expect(classifyRun(run('PREPARED', [], { flow: 'crosschain-router-testnet' })).authorized).toBe(false);
  });
  it('success needs a reconciled verdict with nothing left to observe, never a hash alone', () => {
    expect(outcome(run('HASH', [attempt('HASH', true)]))).toEqual(['IN_PROGRESS', true, true, true]);
    expect(outcome(run('CONFIRMED', [attempt('CONFIRMED', true)]))).toEqual(['IN_PROGRESS', true, true, true]);
    expect(outcome(run('RECONCILED', [attempt('CONFIRMED', true, true)], { hasEvidence: true }))).toEqual(['COMPLETED', true, true, true]);
    expect(outcome(run('RECONCILED', [attempt('CONFIRMED', true, true)], { needsObservation: true }))).toEqual(['IN_PROGRESS', true, true, true]);
    expect(outcome(run('SUBMITTING', [attempt('SUBMITTING')]))).toEqual(['IN_PROGRESS', true, false, false]);
  });
  it('confirmed failures, partial and uncertain outcomes', () => {
    expect(outcome(run('DIVERGENT', [attempt('REVERTED', true)]))).toEqual(['FAILED', true, true, true]);
    expect(outcome(run('REFUNDED', [attempt('CONFIRMED', true)], { flow: 'crosschain-router-testnet' }))).toEqual(['FAILED', true, true, true]);
    expect(outcome(run('FAILED', [], { flow: 'crosschain-router' }))).toEqual(['NOT_EXECUTED', false, false, false]);
    expect(outcome(run('PARTIALLY_COMPLETED', [attempt('CONFIRMED', true, true, 'SUPPLY'), attempt('REVERTED', true, false, 'BORROW')], { flow: 'lending-composition' })))
      .toEqual(['PARTIAL', true, true, true]);
    expect(classifyRun(run('PARTIALLY_COMPLETED', [attempt('CONFIRMED', true, true)])).attention).toBe(true);
    expect(outcome(run('INCONCLUSIVE', [attempt('CONFIRMED', true)]))).toEqual(['UNCERTAIN', true, true, true]);
    expect(outcome(run('SUBMISSION_RESULT_UNKNOWN', [attempt('SUBMISSION_RESULT_UNKNOWN')], { needsObservation: true }))).toEqual(['IN_PROGRESS', true, true, true]);
    expect(outcome(run('SUBMISSION_RESULT_UNKNOWN', [attempt('SUBMISSION_RESULT_UNKNOWN')], { needsObservation: true, attentionRequired: true })))
      .toEqual(['UNCERTAIN', true, true, true]);
    expect(outcome(run('RECOVERY_REQUIRED', [attempt('HASH', true)], { flow: 'crosschain-router' }))).toEqual(['UNCERTAIN', true, true, true]);
  });
  it('trusts a service verdict that nothing landed: declined, expired or cancelled', () => {
    expect(outcome(run('REJECTED', [attempt('REJECTED')]))).toEqual(['NOT_EXECUTED', true, false, false]);
    expect(outcome(run('EXPIRED', [attempt('EXPIRED', true)], { flow: 'solana-devnet-swap' }))).toEqual(['NOT_EXECUTED', true, true, false]);
    expect(outcome(run('NOT_EXECUTED', [attempt('CANCELLED')]))).toEqual(['NOT_EXECUTED', false, false, false]);
  });
  it('router, lending and payment phases', () => {
    expect(outcome(run('IN_FLIGHT', [attempt('CONFIRMED', true, false, 'SOURCE')], { flow: 'crosschain-router-testnet' }))).toEqual(['IN_PROGRESS', true, true, true]);
    expect(outcome(run('PAUSED', [attempt('CONFIRMED', true, true, 'SUPPLY')], { flow: 'lending-composition' }))).toEqual(['IN_PROGRESS', true, true, true]);
    expect(outcome(run('COMPLETED', [attempt('CONFIRMED', true, true, 'SUPPLY')], { flow: 'lending-composition', hasEvidence: true }))).toEqual(['COMPLETED', true, true, true]);
    expect(outcome(run('PAYMENT_SETTLED', [attempt('CONFIRMED', true, true, 'SOURCE')], { flow: 'pix-payment', hasEvidence: true }))).toEqual(['COMPLETED', true, true, true]);
    // A multi-step run between steps (an earlier step confirmed, the next one only prepared) is still in progress.
    expect(outcome(run('PREPARED', [attempt('CONFIRMED', true, true, 'APPROVAL'), attempt('PREPARED', false, false, 'SUPPLY')], { flow: 'aave-supply' })))
      .toEqual(['IN_PROGRESS', true, true, true]);
  });
  it('a Solana composition starts and submits through its phases (its steps carry the attempts)', () => {
    const composition = (status: string) => run(status, [], { flow: 'solana-devnet-composition' });
    expect(outcome(composition('AUTHORIZED'))).toEqual(['NOT_STARTED', false, false, false]);
    expect(outcome(composition('PRODUCING'))).toEqual(['IN_PROGRESS', true, false, false]);
    expect(outcome(composition('BOUND'))).toEqual(['IN_PROGRESS', true, true, true]);
    expect(outcome(composition('COMPLETED'))).toEqual(['COMPLETED', true, true, true]);
    expect(outcome(composition('PARTIAL'))).toEqual(['PARTIAL', true, true, true]);
    expect(outcome(composition('ATTENTION'))).toEqual(['UNCERTAIN', true, true, true]);
    expect(outcome(composition('NOT_EXECUTED'))).toEqual(['NOT_EXECUTED', false, false, false]);
  });
  it('reports an unknown status as UNCLASSIFIED, needing attention, never as success', () => {
    const c = classifyRun(run('SOMETHING_NEW', [attempt('HASH', true)]));
    expect([c.outcome, c.attention, executed(c)]).toEqual(['UNCLASSIFIED', true, true]);
  });
});
