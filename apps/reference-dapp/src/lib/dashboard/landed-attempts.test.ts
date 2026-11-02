// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #149 (P0 financial truth): the Dashboard derives a run's status from its recorded attempts through the canonical lifecycle,
 * never says "Not started / nothing was sent" once an approval landed, and never calls a landed approval the completed action.
 */
import { describe, expect, it } from 'vitest';
import { canonicalRunLifecycle } from '../../domain/canonical-execution-status';
import { landedAttempts } from '../../domain/landed-attempts';
import { projectDashboardRun } from './run-mapping';
import { projectDashboardRecord } from './record-projection';
import type { DashboardAttempt, DashboardRun, DashboardRunDetail } from './types';
import { reviewFixture, reviewOwner } from '../../test-utils/review-fixture';

const hash = (c: string) => '0x' + c.repeat(64);
let n = 0;
const attempt = (step: string, state: string, patch: Partial<DashboardAttempt> = {}): DashboardAttempt =>
  ({ attemptId: `a-${++n}`, step, state, transactionHash: ['CONFIRMED', 'PENDING', 'REVERTED'].includes(state) ? hash('a') : null, reconciled: false, ...patch });
const run = (flow: string, status: string, attempts?: DashboardAttempt[], patch: Partial<DashboardRun> = {}): DashboardRun => ({ runId: 'r-1', workflowId: 'w', flow, status,
  provenance: 'PUBLIC_MAINNET', ownerAccount: reviewOwner, errorCode: null, needsObservation: false, attentionRequired: false, hasEvidence: false, createdAt: null, updatedAt: null,
  ...attempts ? { attempts } : {}, ...patch });

describe('Issue #149: Dashboard landed-attempt truth', () => {
  it('Aave supply: a reconciled approval with no supply attempt is partially completed, never "Not started" and never the supply', () => {
    // The supply projector keeps AUTHORIZED once the approval reconciled and before the supply is requested.
    const view = projectDashboardRun(run('base-aave', 'AUTHORIZED', [attempt('APPROVAL', 'CONFIRMED', { reconciled: true })]));
    expect(view).toMatchObject({ status: 'Partially completed', landed: 'Approval confirmed · main action not sent' });
    expect(view.message).toBe('Only the token approval is confirmed onchain. An approval moves no funds by itself, and the main action has not completed.');
    expect(view.message).not.toMatch(/nothing was sent/);
    expect(view.attention).toContain('Review the incomplete action');
    // The summary alone (attempts not read) is unchanged: the read is what proves the approval.
    expect(projectDashboardRun(run('base-aave', 'AUTHORIZED')).status).toBe('Not started');
  });

  it('Uniswap liquidity: approvals landed; the mint awaiting the wallet, failed or never sent is said as such', () => {
    const approvals = () => [attempt('APPROVE_TOKEN0', 'CONFIRMED', { reconciled: true }), attempt('APPROVE_TOKEN1', 'CONFIRMED', { reconciled: true })];
    expect(projectDashboardRun(run('base-liquidity', 'AUTHORIZED', approvals()))).toMatchObject({ status: 'Partially completed', landed: 'Approval confirmed · main action not sent' });
    // The projector shows the open MINT attempt's state as the run status.
    expect(projectDashboardRun(run('base-liquidity', 'PREPARED', [...approvals(), attempt('MINT', 'PREPARED')])))
      .toMatchObject({ status: 'In progress', landed: 'Approval confirmed · main action awaiting wallet confirmation' });
    expect(projectDashboardRun(run('base-liquidity', 'AUTHORIZED', [...approvals(), attempt('MINT', 'REVERTED')])))
      .toMatchObject({ status: 'Partially completed', landed: 'Approval confirmed · main action failed' });
    expect(projectDashboardRun(run('base-liquidity', 'PENDING', [...approvals(), attempt('MINT', 'PENDING')])))
      .toMatchObject({ status: 'In progress', landed: 'Approval confirmed · main action pending confirmation' });
    expect(projectDashboardRun(run('base-liquidity', 'SUBMISSION_RESULT_UNKNOWN', [...approvals(), attempt('MINT', 'SUBMISSION_RESULT_UNKNOWN')])))
      .toMatchObject({ status: 'Unresolved', landed: 'Approval confirmed · main action unresolved' });
  });

  it('production example: a Base swap whose only attempt is a confirmed approval shows the landed approval, not "Not started"', () => {
    // flow base-swap: attempts [approval CONFIRMED with txHash], no swap attempt, no outcome. The swap projector's status is the last
    // attempt's state (CONFIRMED); an older summary may still read AUTHORIZED. Neither reads as not started, completed or the swap.
    for (const status of ['CONFIRMED', 'AUTHORIZED', 'SIMULATED']) {
      const view = projectDashboardRun(run('base-swap', status, [attempt('APPROVAL', 'CONFIRMED', { transactionHash: hash('b'), reconciled: false })]));
      expect(view, status).toMatchObject({ title: 'Swap', status: 'Partially completed', landed: 'Approval confirmed · main action not sent' });
      expect(['Not started', 'Completed', 'Completed with attention']).not.toContain(view.status);
    }
    // The swap itself confirmed, outcome not reconciled yet: never completion.
    expect(projectDashboardRun(run('base-swap', 'CONFIRMED', [attempt('APPROVAL', 'CONFIRMED'), attempt('SWAP', 'CONFIRMED')])))
      .toMatchObject({ status: 'Needs attention', landed: 'Confirmed onchain · workflow outcome not reconciled yet' });
    expect(projectDashboardRun(run('base-swap', 'RECONCILED', [attempt('APPROVAL', 'CONFIRMED'), attempt('SWAP', 'CONFIRMED', { reconciled: true })])))
      .toMatchObject({ status: 'Completed', landed: null });
  });

  it('lending: steps confirmed before a refreshed Review are earlier completed actions, not a run that never started', () => {
    // The lending composition returns to SIMULATED after a refreshed Review, with its reconciled supply already onchain.
    const view = projectDashboardRun(run('lending-composition', 'SIMULATED',
      [attempt('POOL_APPROVAL', 'CONFIRMED', { reconciled: true }), attempt('SUPPLY', 'CONFIRMED', { reconciled: true })]));
    expect(view).toMatchObject({ status: 'Partially completed', landed: 'Confirmed onchain · workflow outcome not reconciled yet' });
    expect(projectDashboardRun(run('lending-composition', 'PAUSED', [attempt('POOL_APPROVAL', 'CONFIRMED', { reconciled: true }), attempt('SUPPLY', 'CANCELLED')])))
      .toMatchObject({ status: 'Partially completed', landed: 'Approval confirmed · main action not submitted' });
    expect(projectDashboardRun(run('lending-composition', 'REVERTED', [attempt('SUPPLY', 'CONFIRMED', { reconciled: true }), attempt('BORROW', 'REVERTED')])))
      .toMatchObject({ status: 'Partially completed', landed: 'Earlier actions confirmed onchain · a later action is not complete' });
  });

  it('a request declined after a confirmed approval is partially completed; declined with nothing landed stays not submitted', () => {
    expect(projectDashboardRun(run('base-aave', 'CANCELLED', [attempt('APPROVAL', 'CONFIRMED', { reconciled: true }), attempt('SUPPLY', 'CANCELLED')])))
      .toMatchObject({ status: 'Partially completed', landed: 'Approval confirmed · main action not submitted' });
    expect(projectDashboardRun(run('base-aave', 'CANCELLED', [attempt('APPROVAL', 'CANCELLED')]))).toMatchObject({ status: 'Transaction not submitted', landed: null });
    expect(projectDashboardRun(run('base-aave', 'AUTHORIZED', [attempt('APPROVAL', 'REFUSED')]))).toMatchObject({ status: 'Transaction not submitted', landed: null });
  });

  it('a prepared wallet request awaits the wallet; simulated-only runs with no attempts still say nothing was sent', () => {
    expect(projectDashboardRun(run('base-aave', 'PREPARED', [attempt('APPROVAL', 'PREPARED')]))).toMatchObject({ status: 'In progress', landed: null });
    const simulated = projectDashboardRun(run('base-aave', 'SIMULATED', []));
    expect(simulated).toMatchObject({ status: 'Not started', landed: null, message: 'Simulated or reviewed only: no wallet request was made, so nothing was sent.' });
  });

  it('fails closed when the attempts of a not-started-looking run could not be read', () => {
    const view = projectDashboardRun(run('base-aave', 'AUTHORIZED', undefined, { attemptsUnavailable: true }));
    expect(view.status).toBe('Unresolved');
    expect(view.message).not.toMatch(/nothing was sent\.$/);
    expect(view.attention).toContain('Execution status unresolved');
  });

  it('a saved run whose projected progress reads idle still shows the landed approval its attempts prove', () => {
    const fixture = reviewFixture(), base = 'run' in fixture.source.state ? fixture.source.state.run : null;
    const saved = run('base-sepolia-swap', 'CONFIRMED', [attempt('APPROVAL', 'CONFIRMED')], { runId: 'owned-run', provenance: 'PUBLIC_TESTNET' });
    const detail: DashboardRunDetail = { run: saved, attempts: [...saved.attempts!], evidence: [], evidenceUnavailable: false, recordUnavailable: false,
      record: { ...base, quote: { ...base?.quote, executionId: 'owned-run' }, attempts: [{ step: 'swap', account: reviewOwner, state: 'CONFIRMED', txHash: hash('c') }], outcome: null } };
    const progress = projectDashboardRecord(detail, fixture.context)!;
    expect(progress).not.toBeNull();
    // A projector that saw no request (an idle lifecycle) never outranks the read model's proof that the approval landed.
    expect(projectDashboardRun(saved, { ...progress, state: 'idle', started: false })).toMatchObject({ status: 'Partially completed', landed: 'Approval confirmed · main action not sent' });
    // The same idle projection without attempt evidence keeps its own (UX-005) reading.
    expect(projectDashboardRun({ ...saved, attempts: [] }, { ...progress, state: 'idle', started: false }).status).toBe('Not started');
  });

  it('agrees with the canonical lifecycle for every status × attempt history (one meaning on every surface)', () => {
    const histories: DashboardAttempt[][] = [[], [attempt('APPROVAL', 'CONFIRMED', { reconciled: true })], [attempt('APPROVAL', 'CONFIRMED'), attempt('SWAP', 'PREPARED')],
      [attempt('APPROVAL', 'CONFIRMED'), attempt('SWAP', 'REFUSED')], [attempt('APPROVAL', 'CONFIRMED'), attempt('SWAP', 'PENDING')],
      [attempt('APPROVAL', 'CONFIRMED'), attempt('SWAP', 'REVERTED')], [attempt('APPROVAL', 'CONFIRMED'), attempt('SWAP', 'CONFIRMED')],
      [attempt('SWAP', 'SUBMISSION_RESULT_UNKNOWN')], [attempt('SWAP', 'NOT_SUBMITTED')], [attempt('APPROVE_TOKEN0', 'CONFIRMED'), attempt('MINT', 'RECONCILIATION_REQUIRED')]];
    const statuses = ['SIMULATED', 'AUTHORIZED', 'PREPARED', 'QUOTED', 'CONFIRMED', 'CANCELLED', 'NOT_SUBMITTED', 'REVERTED', 'FAILED', 'PARTIALLY_COMPLETED',
      'PENDING', 'RECONCILED', 'PAUSED', 'EXECUTING', 'RECOVERY_REQUIRED', 'UNKNOWN', 'COMPLETED'];
    for (const status of statuses) for (const attempts of histories) for (const hasEvidence of [false, true]) for (const needsObservation of [false, true]) {
      const summary = run('base-swap', status, attempts, { hasEvidence, needsObservation }), lifecycle = canonicalRunLifecycle(summary), view = projectDashboardRun(summary);
      const label = `${status} ${attempts.map(a => `${a.step}:${a.state}`).join(',')} evidence=${hasEvidence} observing=${needsObservation}`;
      expect(view.status === 'Not started', label).toBe(lifecycle.status === 'NOT_STARTED');
      expect(['Completed', 'Completed with attention'].includes(view.status), label).toBe(lifecycle.completed);
      if (lifecycle.status === 'PARTIALLY_COMPLETED') expect(view.status, label).toBe('Partially completed');
      if (lifecycle.status === 'REJECTED') expect(view.status, label).toBe('Transaction not submitted');
      if (['AUTHORIZATION_PENDING', 'SUBMITTED', 'HASH_KNOWN', 'SETTLEMENT_PENDING'].includes(lifecycle.status)) expect(view.status, label).toBe('In progress');
      if (lifecycle.status === 'INCONCLUSIVE') expect(['Unresolved', 'Needs attention'], label).toContain(view.status);
      // A landed attempt is always visible, and a landed approval alone is never the completed action.
      const landed = landedAttempts(attempts);
      if (landed.landed && !lifecycle.completed) expect(view.landed, label).toBe(landed.label);
      if (landed.approvalOnly && !lifecycle.completed) expect(view.status, label).not.toMatch(/^Completed|Not started/);
    }
  });
});
