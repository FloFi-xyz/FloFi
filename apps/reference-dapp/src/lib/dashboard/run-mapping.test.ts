// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { currentDashboardRun, dashboardRunIndex, dashboardRunTitle, projectDashboardRun, toDashboardRun } from './run-mapping';
import { projectDashboardRecord } from './record-projection';
import type { DashboardRun, DashboardRunDetail } from './types';
import { reviewFixture, reviewOwner } from '../../test-utils/review-fixture';
import type { ExecutionLifecycle } from '../../domain/execution-lifecycle';

const hash = '0x' + 'a'.repeat(64);
const run = (status = 'PENDING'): DashboardRun => ({ runId: 'owned-run', workflowId: 'recorded-workflow', flow: 'base-sepolia-swap', status,
  provenance: 'PUBLIC_TESTNET', ownerAccount: reviewOwner, errorCode: null, needsObservation: false, attentionRequired: false, hasEvidence: false,
  createdAt: null, updatedAt: null });
function detail(state = 'PENDING'): DashboardRunDetail {
  const fixture = reviewFixture(), base = 'run' in fixture.source.state ? fixture.source.state.run : null;
  return { run: run(state), attempts: [], evidence: [], evidenceUnavailable: false, recordUnavailable: false,
    record: { ...base, quote: { ...base?.quote, executionId: 'owned-run' }, attempts: [{ step: 'swap', account: reviewOwner, state, txHash: state === 'REJECTED' ? null : hash }], outcome: null } };
}
describe('Dashboard consumes existing execution truth', () => {
  it('drops unrelated owners and malformed run IDs; preserves missing timestamps and values', () => {
    expect(toDashboardRun({ ...run(), ownerAccount: '0x' + '2'.repeat(40) }, reviewOwner)).toBeNull();
    expect(toDashboardRun({ ...run(), runId: '../other' }, reviewOwner)).toBeNull();
    expect(toDashboardRun(run(), reviewOwner.toUpperCase())).toMatchObject({ createdAt: null, updatedAt: null, hasEvidence: false });
  });
  it.each(['UNKNOWN', 'INCONCLUSIVE', 'DIVERGENT', 'SUBMISSION_RESULT_UNKNOWN', 'NOT_FOUND', 'UNRECOGNIZED'])('%s remains unresolved', status => {
    expect(projectDashboardRun(run(status)).status).toBe('Unresolved');
  });
  it('cannot call a summary confirmation full completion, or guess the extent of a failed run', () => {
    expect(projectDashboardRun(run('CONFIRMED')).status).toBe('Needs attention');
    expect(projectDashboardRun(run('FAILED')).status).toBe('Needs attention');
    expect(projectDashboardRun(run('PARTIALLY_COMPLETED')).status).toBe('Partially completed');
  });
  it('keeps simulated/authorized records distinct from execution history completion', () => {
    expect(projectDashboardRun(run('AUTHORIZED')).status).toBe('Not started');
    expect(currentDashboardRun('Workflow', { started: false } as ExecutionLifecycle)).toBeNull();
  });
  it('exposes a real reconciled outcome and evidence flag without inventing amounts or counts', () => {
    const view = projectDashboardRun({ ...run('RECONCILED'), hasEvidence: true });
    expect(view).toMatchObject({ status: 'Completed', reconciled: true, completed: null, total: null, networks: [], run: { hasEvidence: true } });
    expect(view.progress).toBeNull();
    expect(projectDashboardRun({ ...run('RECONCILED'), needsObservation: true }).status).toBe('Unresolved');
  });
  it('uses UX-005 final statuses for confirmed, reverted, declined and unknown requests', () => {
    const context = reviewFixture().context;
    for (const [state, expected] of [['CONFIRMED', 'Completed'], ['REVERTED', 'Failed'], ['REJECTED', 'Transaction not submitted'], ['UNKNOWN', 'Unresolved']] as const) {
      const value = detail(state), progress = projectDashboardRecord(value, context);
      expect(progress).not.toBeNull();
      expect(projectDashboardRun(value.run, progress).status).toBe(expected);
    }
  });
  it('keeps confirmed earlier actions visible in a partial outcome', () => {
    const progress = projectDashboardRecord(detail('CONFIRMED'), reviewFixture().context)!;
    const earlier = progress.steps[0]!;
    const failed = { ...earlier, id: 'second-step', state: 'failed' as const, operations: earlier.operations.map(operation => ({ ...operation, id: 'later', state: 'failed' as const, label: 'Failed' })) };
    const partial = { ...progress, state: 'attention' as const, completed: 1, steps: [earlier, failed] };
    expect(projectDashboardRun(run('FAILED'), partial)).toMatchObject({ status: 'Partially completed', completed: 1, total: 2 });
  });
  it('filters immediately on wallet switch/disconnect and deduplicates the current cloud run', () => {
    const progress = projectDashboardRecord(detail('CONFIRMED'), reviewFixture().context)!;
    const current = currentDashboardRun('Current workflow', progress)!;
    expect(dashboardRunIndex(reviewOwner, [run()], current)).toHaveLength(1);
    expect(dashboardRunIndex('0x' + '2'.repeat(40), [run()], current)).toEqual([]);
    expect(dashboardRunIndex(null, [run()], current)).toEqual([]);
    expect(current).toMatchObject({ current: true, run: { hasEvidence: true, updatedAt: null } });
  });
  it('restoration alone does not claim recovery or reconciliation', () => {
    const progress = projectDashboardRecord(detail('CONFIRMED'), reviewFixture().context)!;
    expect(currentDashboardRun('Workflow', { ...progress, restored: true })).toMatchObject({ recovered: false, reconciled: false });
    const actual = { ...progress, stepEvidence: { [progress.steps[0]!.id]: { label: 'Reconciled', message: 'Recorded recovery', reconciled: true, recovered: true, restored: true, comparisons: [] } } };
    expect(currentDashboardRun('Workflow', actual)).toMatchObject({ recovered: true, reconciled: true });
    expect(currentDashboardRun('Workflow', { ...progress, planUnavailable: true })).toMatchObject({ status: 'Needs attention', completed: null, total: null });
  });
  it('does not infer actual values or fees from the simulation and rejects a mismatched detail owner/ID', () => {
    const value = detail('CONFIRMED'), context = reviewFixture().context;
    const progress = projectDashboardRecord(value, context)!;
    expect(progress.evidence?.knownCosts).toEqual([]);
    expect(progress.evidence?.operations.swap?.values).toEqual([]);
    expect(projectDashboardRecord({ ...value, run: { ...value.run, runId: 'other-run' } }, context)).toBeNull();
    expect(projectDashboardRecord({ ...value, run: { ...value.run, ownerAccount: 'other-owner' } }, context)).toBeNull();
    expect(projectDashboardRecord({ ...value, record: { workflow: { nodes: [] } } }, context)).toBeNull();
  });
});

it('never presents PREPARED, refused or canceled summary records as an on-chain transfer', () => {
  expect(projectDashboardRun(run('PREPARED')).status).toBe('Not started');
  for (const status of ['CANCELLED', 'REJECTED']) expect(projectDashboardRun(run(status)).status).toBe('Transaction not submitted');
});

it('BUILD-FLOFI-CHAT-E2E-FIX-002: a run that never made a wallet request says nothing was sent, never "needs attention"', () => {
  for (const status of ['PREPARED', 'QUOTED', 'AUTHORIZED']) {
    const view = projectDashboardRun({ ...run(status), errorCode: 'UNIVERSAL_QUOTE_EXPIRED', attentionRequired: true });
    expect(view.status).toBe('Not started');
    expect(view.message).toBe('The simulation or Review recorded an issue before any wallet request, so nothing was sent.');
    expect(view.attention).toEqual([]);
  }
  expect(projectDashboardRun(run('PREPARED')).message).toBe('Simulated or reviewed only: no wallet request was made, so nothing was sent.');
  // A run that did reach the network keeps its attention.
  expect(projectDashboardRun({ ...run('FAILED'), errorCode: 'X' }).attention.length).toBeGreaterThan(0);
});

// BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (EXEC-02): the history says what a bridge's DESTINATION_OBSERVED record proves — the delivery observed on the
// destination, final settlement still being verified, no signature needed — and never that it completed.
describe('a bridge whose delivery is observed on the destination', () => {
  const bridge = (over: Partial<DashboardRun> = {}): DashboardRun => ({ ...run('DESTINATION_OBSERVED'), flow: 'crosschain-router', provenance: 'PUBLIC_MAINNET',
    needsObservation: true, errorCode: 'ROUTER_AWAITING_FINALITY', ...over });
  it('is in progress with the destination-observed explanation, also with its confirmed source attempts', () => {
    const message = 'The funds have been observed on the destination chain. FloFi is still verifying final settlement. No additional wallet signature is required.';
    expect(projectDashboardRun(bridge())).toMatchObject({ status: 'In progress', message });
    const attempts = [{ attemptId: 'a', step: 'APPROVAL', state: 'CONFIRMED', transactionHash: hash, reconciled: true },
      { attemptId: 'd', step: 'DEPOSIT', state: 'CONFIRMED', transactionHash: hash.replace('a', 'b'), reconciled: true }] as unknown as NonNullable<DashboardRun['attempts']>;
    expect(projectDashboardRun(bridge({ attempts }))).toMatchObject({ status: 'In progress', message });
  });
  it('a flagged record keeps its attention wording', () => {
    expect(projectDashboardRun(bridge({ attentionRequired: true })).message).not.toContain('observed on the destination chain');
  });
});

describe('BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 position-management runs in History', () => {
  const attempt = (step: string) => ({ attemptId: `r.${step.toLowerCase()}.1`, step, state: 'CONFIRMED', transactionHash: '0x' + '1'.repeat(64), reconciled: true });
  it('names a collect, a withdrawal or an exit by its operation; an open, a mint or a run with no attempt keeps the flow title', () => {
    expect(dashboardRunTitle({ flow: 'base-liquidity', attempts: [attempt('COLLECT')] })).toBe('Collect fees');
    expect(dashboardRunTitle({ flow: 'arbitrum-liquidity', attempts: [attempt('DECREASE')] })).toBe('Remove liquidity');
    expect(dashboardRunTitle({ flow: 'orca-liquidity-mainnet', attempts: [attempt('DECREASE_PARTIAL')] })).toBe('Remove liquidity');
    expect(dashboardRunTitle({ flow: 'robinhood-liquidity', attempts: [attempt('EXIT')] })).toBe('Exit liquidity position');
    expect(dashboardRunTitle({ flow: 'base-liquidity', attempts: [attempt('APPROVE_TOKEN0'), attempt('MINT')] })).toBe('Liquidity workflow');
    expect(dashboardRunTitle({ flow: 'orca-liquidity-mainnet', attempts: [attempt('OPEN')] })).toBe('Liquidity workflow');
    expect(dashboardRunTitle({ flow: 'ethereum-liquidity' })).toBe('Liquidity workflow');
    // Another action's step names never retitle it.
    expect(dashboardRunTitle({ flow: 'base-aave', attempts: [attempt('EXIT')] })).toBe('Aave workflow');
  });
});

// BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): a single-card attempt the owner history lists is a `wfr_` workflow run whose
// summary carries the run's own state (`packages/cloud-runtime/src/queries.ts`). It is worded by that state alone, never by the execution groups.
describe('single-card attempts (workflow runs) in History', () => {
  const attempt = (status: string, over: Partial<DashboardRun> = {}): DashboardRun => ({ runId: 'wfr_' + 'a'.repeat(26), workflowId: '', flow: 'arbitrum-swap', status,
    provenance: 'WORKFLOW_RUN', ownerAccount: reviewOwner, errorCode: null, needsObservation: false, attentionRequired: false, hasEvidence: false,
    createdAt: '2026-11-20T12:00:00.000Z', updatedAt: '2026-11-20T12:01:00.000Z', ...over });
  const editor = 'Check execution status in the Editor\'s execution view', unknown = 'FloFi has not established the final workflow outcome.';
  it.each<[string, Partial<DashboardRun>, Partial<ReturnType<typeof projectDashboardRun>>]>([
    ['COMPLETED', {}, { status: 'Completed', message: 'The run records a reconciled outcome.', attention: [], reconciled: true }],
    ['COMPLETED', { errorCode: 'SOME_RECORDED_ISSUE' }, { status: 'Completed with attention', attention: ['A recorded issue needs review'], reconciled: true }],
    ['PENDING', {}, { status: 'In progress', message: 'The recorded execution is still awaiting its final outcome.', attention: [editor], reconciled: false }],
    ['RUNNING', {}, { status: 'In progress', attention: [editor], reconciled: false }],
    ['ATTENTION', { attentionRequired: true }, { status: 'Needs attention', message: unknown, attention: ['This execution record needs attention', editor] }],
    ['HALTED', { attentionRequired: true, errorCode: 'WALLET_BATCH_OUTCOME_UNKNOWN' }, { status: 'Needs attention', message: unknown,
      attention: ['This execution record needs attention', editor] }],
    // 0015: a run expires only from PENDING, before any mode, authorization or step started.
    ['EXPIRED', { errorCode: 'WORKFLOW_RUN_EXPIRED' }, { status: 'Not started', message: 'The run has no recorded execution start.', attention: [] }],
    // Whether a wallet request was sent is not knowable from the summary: never "not submitted", never "declined".
    ['CANCELLED', { errorCode: 'OWNER_CANCELLED' }, { status: 'Needs attention', message: unknown, attention: ['The request was cancelled'] }],
    ['FAILED', { errorCode: 'SUBMISSION_REVERTED' }, { status: 'Needs attention', message: unknown, attention: ['Review the incomplete action'] }],
    ['SOMETHING_NEW', {}, { status: 'Unresolved', message: unknown, attention: ['Execution status unresolved'] }],
  ])('%s %j', (status, over, expected) => {
    const view = projectDashboardRun(attempt(status, over));
    expect(view).toMatchObject({ ...expected, landed: null, networks: [], completed: null, total: null, recovered: false, progress: null, current: false });
    // Never an execution claim the run row does not prove.
    expect(view.status).not.toBe('Transaction not submitted');
    expect([view.message, ...view.attention].join(' ')).not.toMatch(/nothing was sent|not submitted|declined|Evidence|Open the run/i);
  });
  it('is titled by its single step\'s flow; an unknown step keeps the generic title', () => {
    expect(projectDashboardRun(attempt('COMPLETED')).title).toBe('Swap');
    expect(projectDashboardRun(attempt('COMPLETED', { flow: 'base-mainnet-transfer' })).title).toBe('Send');
    expect(projectDashboardRun(attempt('COMPLETED', { flow: 'crosschain-router' })).title).toBe('Bridge');
    expect(projectDashboardRun(attempt('COMPLETED', { flow: 'workflow-run' })).title).toBe('Financial operation');
  });
  it('is read from the listing like any owned summary, and never another owner\'s; an execution record with the same words keeps its own wording', () => {
    const summary = { ...attempt('CANCELLED'), ownerAccount: reviewOwner.toUpperCase().replace('0X', '0x') };
    expect(toDashboardRun(summary, reviewOwner)).toMatchObject({ runId: 'wfr_' + 'a'.repeat(26), provenance: 'WORKFLOW_RUN', status: 'CANCELLED' });
    expect(toDashboardRun({ ...summary, ownerAccount: '0x' + '2'.repeat(40) }, reviewOwner)).toBeNull();
    expect(dashboardRunIndex(reviewOwner, [attempt('COMPLETED'), run('CANCELLED')], null).map(view => view.status)).toEqual(['Completed', 'Transaction not submitted']);
    // A saved run's projected progress (never the case for an attempt, which has no detail) keeps the existing projection.
    const progress = projectDashboardRecord(detail('CONFIRMED'), reviewFixture().context)!;
    expect(projectDashboardRun(attempt('PENDING'), progress).status).toBe('Completed');
  });
});
