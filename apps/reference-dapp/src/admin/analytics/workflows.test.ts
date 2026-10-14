// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: counting semantics. One multichain workflow counts once; its executed actions count on their own networks with an
 * exclusive action-level denominator (shares sum to 100 %); a bridge counts on its source and is shown as an arrival on its destination;
 * re-simulations, recovery runs and composition step runs never add executions; environments are never mixed.
 */
import { describe, expect, it } from 'vitest';
import type { FactAction } from './actions.ts';
import type { AttemptFact } from './classify.ts';
import { analyticsRange, bucketStart, bucketsOf, executionsOf, summarize, type Coverage, type LoadedRun } from './workflows.ts';

const now = new Date('2026-10-14T12:00:00.000Z'), range = analyticsRange({ range: '7d' }, now);
const BASE = 'eip155:8453', ARB = 'eip155:42161', BASE_SEP = 'eip155:84532', ARB_SEP = 'eip155:421614', SOL_DEV = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const done: AttemptFact = { step: 'X', state: 'CONFIRMED', hash: true, reconciled: true };
let n = 0;
function run(over: Partial<LoadedRun> & { actions?: FactAction[] | null }): LoadedRun {
  const { actions, ...rest } = over, id = rest.runId ?? `run-${++n}`;
  return { runId: id, workflowId: `wf-${id}`, flow: 'base-swap', status: 'RECONCILED', provenance: 'PUBLIC_MAINNET', recoveryOf: null, errorCode: null, needsObservation: false,
    attentionRequired: false, hasEvidence: true, createdAt: new Date('2026-10-13T10:00:00Z'), updatedAt: new Date('2026-10-13T10:05:00Z'), attempts: [done],
    journalAuthorized: true, fact: actions === null ? null : { state: 'INDEXED', code: null, actions: actions ?? [{ i: 0, kind: 'SWAP', type: 'asset.swap.exact-input', chain: BASE }],
      compositionOf: null }, ...rest };
}
const all = { action: 'ALL', outcome: 'ALL' } as const;

describe('BUILD-ADMIN-001 workflow analytics', () => {
  it('a multichain workflow counts once; each executed action counts on its own network; shares total 100%', () => {
    const multichain = run({ flow: 'lending-composition', attempts: [{ ...done, step: 'SUPPLY' }, { ...done, step: 'BORROW' }, { ...done, step: 'SWAP' }],
      actions: [{ i: 0, kind: 'LENDING', type: 'supply', chain: BASE }, { i: 1, kind: 'LENDING', type: 'borrow', chain: BASE },
        { i: 2, kind: 'SWAP', type: 'asset.swap.exact-input', chain: BASE }] });
    const bridge = run({ flow: 'crosschain-router', actions: [{ i: 0, kind: 'BRIDGE', type: 'asset.bridge', chain: BASE, to: ARB }] });
    const swapOnArb = run({ flow: 'arbitrum-swap', actions: [{ i: 0, kind: 'SWAP', type: 'asset.swap.exact-input', chain: ARB }] });
    const a = summarize(executionsOf([multichain, bridge, swapOnArb]), range, 'MAINNET', all);
    expect(a.funnel.executed).toBe(3);
    expect(a.workflows).toEqual({ executed: 3, completed: 3 });
    expect(a.networks.totalActions).toBe(5);
    const byChain = Object.fromEntries(a.networks.rows.map(row => [row.chain, row]));
    expect(byChain[BASE]).toMatchObject({ name: 'Base', actions: 4, share: 0.8, COMPLETED: 4, workflowsInvolved: 2, asDestination: 0 });
    // The bridge counts once, on Base; Arbitrum One shows it as an arrival and as a participating workflow, never as a second action.
    expect(byChain[ARB]).toMatchObject({ name: 'Arbitrum One', actions: 1, share: 0.2, asDestination: 1, workflowsInvolved: 2, workflowsCompleted: 2 });
    expect(a.networks.rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 10);
    expect(a.bridgeRoutes).toEqual([expect.objectContaining({ from: expect.objectContaining({ chain: BASE }), to: expect.objectContaining({ chain: ARB }), actions: 1, COMPLETED: 1 })]);
    expect(a.utilization.find(u => u.kind === 'LENDING')).toMatchObject({ executions: 1, executedActions: 2, completedActions: 2 });
    expect(a.topByKind.find(t => t.kind === 'SWAP')!.networks.map(x => [x.network.name, x.actions])).toEqual([['Base', 1], ['Arbitrum One', 1]]);
  });

  it('re-simulations, retries, recoveries and reconciliation passes never inflate successes', () => {
    const wf = 'wf-retried';
    const resimulated = [1, 2, 3].map(() => run({ workflowId: wf, status: 'SIMULATED', attempts: [], hasEvidence: false, journalAuthorized: false }));
    const failed = run({ workflowId: wf, status: 'DIVERGENT', hasEvidence: false, attempts: [{ step: 'SWAP', state: 'REVERTED', hash: true, reconciled: false }] });
    const retried = run({ workflowId: wf, status: 'RECONCILED' });
    const original = run({ runId: 'orig', workflowId: 'wf-recovered', status: 'INCONCLUSIVE', hasEvidence: false, attempts: [{ step: 'SWAP', state: 'HASH', hash: true, reconciled: false }],
      createdAt: new Date('2026-10-12T10:00:00Z') });
    const recovery = run({ workflowId: 'wf-recovered', recoveryOf: 'orig', status: 'RECONCILED', createdAt: new Date('2026-10-12T11:00:00Z') });
    const executions = executionsOf([...resimulated, failed, retried, original, recovery]);
    expect(executions.length).toBe(6); // 3 never-started simulations + 2 executions of one workflow + 1 recovered execution
    const a = summarize(executions, range, 'MAINNET', all);
    expect(a.funnel).toMatchObject({ simulated: 6, started: 3, executed: 3, completed: 2 });
    expect(a.outcomes).toMatchObject({ COMPLETED: 2, FAILED: 1, UNCERTAIN: 0 });
    expect(a.workflows).toEqual({ executed: 2, completed: 2 });
    expect(executions.find(e => e.rootId === 'orig')!.runIds).toEqual(['orig', recovery.runId]);
    expect(a.rates).toEqual({ denominator: 3, success: 2 / 3, failure: 1 / 3 });
  });

  it('a composition’s step runs are counted inside it, with per-step outcomes', () => {
    const swap = run({ runId: 'sdx-1', flow: 'solana-devnet-swap', provenance: 'PUBLIC_DEVNET', workflowId: 'wf-comp',
      actions: [{ i: 0, kind: 'SWAP', type: 'asset.swap.exact-input', chain: SOL_DEV }] });
    const lp = run({ runId: 'olp-1', flow: 'orca-liquidity', provenance: 'PUBLIC_DEVNET', workflowId: 'wf-comp', status: 'DIVERGENT', hasEvidence: false,
      attempts: [{ step: 'OPEN', state: 'REVERTED', hash: true, reconciled: false }], actions: null });
    const composition = run({ runId: 'solcomp-1', flow: 'solana-devnet-composition', provenance: 'PUBLIC_DEVNET', workflowId: 'wf-comp', status: 'PARTIAL', attempts: [],
      hasEvidence: false, actions: [{ i: 0, kind: 'SWAP', type: 'asset.swap.exact-input', chain: SOL_DEV, runs: ['sdx-1'] },
        { i: 1, kind: 'LIQUIDITY', type: 'asset.liquidity.concentrated', chain: SOL_DEV, runs: ['olp-1'] }] });
    const executions = executionsOf([swap, lp, composition]);
    expect(executions.map(e => e.rootId)).toEqual(['solcomp-1']);
    expect(executions[0]!.actions!.map(a => [a.kind, a.outcome, a.executed])).toEqual([['SWAP', 'COMPLETED', true], ['LIQUIDITY', 'FAILED', true]]);
    const a = summarize(executions, range, 'TESTNET', all);
    expect(a.funnel.executed).toBe(1);
    expect(a.outcomes.PARTIAL).toBe(1);
    expect(a.networks.rows).toEqual([expect.objectContaining({ name: 'Solana Devnet', actions: 2, COMPLETED: 1, FAILED: 1, workflowsInvolved: 1, workflowsCompleted: 0 })]);
    // The action/outcome filters narrow the network section only.
    expect(summarize(executions, range, 'TESTNET', { action: 'LIQUIDITY', outcome: 'ALL' }).networks.totalActions).toBe(1);
    expect(summarize(executions, range, 'TESTNET', { action: 'ALL', outcome: 'COMPLETED' }).networks.rows[0]).toMatchObject({ actions: 1, COMPLETED: 1 });
  });

  it('attributes an execution to the range its root started in: a recovery of an earlier run is never counted again', () => {
    // The root started before the range (not loaded); its recovery happened inside it. A later recovery of an in-range root is folded in.
    const lateRecovery = run({ runId: 'rec-of-old', workflowId: 'wf-old', recoveryOf: 'old-root', status: 'RECONCILED', createdAt: new Date('2026-10-13T09:00:00Z') });
    const root = run({ runId: 'new-root', workflowId: 'wf-new', status: 'INCONCLUSIVE', hasEvidence: false, attempts: [{ step: 'SWAP', state: 'HASH', hash: true, reconciled: false }] });
    const afterRange = run({ runId: 'rec-after', workflowId: 'wf-new', recoveryOf: 'new-root', status: 'RECONCILED', createdAt: new Date('2026-10-15T09:00:00Z') });
    const executions = executionsOf([lateRecovery, root, afterRange]);
    expect(executions.map(e => [e.rootId, e.runIds, e.classification.outcome])).toEqual([['new-root', ['new-root', 'rec-after'], 'COMPLETED']]);
  });

  it('a step retried inside one run is one action, decided by its latest live attempt', () => {
    const retried = (attempts: AttemptFact[], status = 'EXECUTING') => executionsOf([run({ flow: 'lending-composition', status, hasEvidence: false, attempts,
      actions: [{ i: 0, kind: 'LENDING', type: 'supply', chain: BASE }] })])[0]!.actions![0]!;
    const reverted: AttemptFact = { step: 'SUPPLY', state: 'REVERTED', hash: true, reconciled: false };
    expect(retried([reverted, { step: 'SUPPLY', state: 'PENDING', hash: true, reconciled: false }])).toMatchObject({ executed: true, outcome: 'IN_PROGRESS' });
    expect(retried([reverted, { step: 'SUPPLY', state: 'CANCELLED', hash: false, reconciled: false }], 'FAILED')).toMatchObject({ executed: true, outcome: 'FAILED' });
    expect(retried([reverted, { ...done, step: 'SUPPLY' }], 'COMPLETED')).toMatchObject({ executed: true, outcome: 'COMPLETED' });
    expect(retried([{ step: 'SUPPLY', state: 'CANCELLED', hash: false, reconciled: false }], 'AUTHORIZED')).toMatchObject({ executed: false });
    const a = summarize(executionsOf([run({ flow: 'lending-composition', status: 'COMPLETED', attempts: [reverted, { ...done, step: 'SUPPLY' }],
      actions: [{ i: 0, kind: 'LENDING', type: 'supply', chain: BASE }] })]), range, 'MAINNET', all);
    expect(a.networks.totalActions).toBe(1);
  });

  it('says what it cannot count: unindexed compositions, unattributable actions, and a truncated range drawn only where covered', () => {
    const composition = run({ runId: 'solcomp-x', flow: 'solana-devnet-composition', provenance: 'PUBLIC_DEVNET', status: 'CONSUMING', attempts: [], hasEvidence: false, actions: null });
    const partial = run({ provenance: 'PUBLIC_DEVNET', fact: { state: 'INDEXED', code: null, compositionOf: null, skipped: 2,
      actions: [{ i: 0, kind: 'SWAP', type: 'asset.swap.exact-input', chain: SOL_DEV }] } });
    const a = summarize(executionsOf([composition, partial]), range, 'TESTNET', all);
    expect([a.compositionsWithoutRecord, a.skippedActions, a.networks.totalActions]).toEqual([1, 2, 1]);
    const coverage: Coverage = { truncated: true, runsInRange: 25_000, coveredFrom: new Date('2026-10-12T15:00:00Z') };
    const t = summarize(executionsOf([run({})]), range, 'MAINNET', all, coverage);
    expect(t).toMatchObject({ truncated: true, coverage });
    expect(t.series[0]!.at).toBe(Date.parse('2026-10-12T00:00:00Z'));
    expect(t.networkTrend.points[0]!.at).toBe(Date.parse('2026-10-12T00:00:00Z'));
    expect(summarize(executionsOf([run({})]), range, 'MAINNET', all).series[0]!.at).toBe(Date.parse('2026-10-07T00:00:00Z'));
  });

  it('counts runs that never started as simulated (authorized only when the classifier says so), in their own environment, without loading them', () => {
    const idle = [{ flow: 'base-swap', provenance: 'PUBLIC_MAINNET', status: 'SIMULATED', journalAuthorized: false, hasAttempts: false, count: 40 },
      { flow: 'base-swap', provenance: 'PUBLIC_MAINNET', status: 'SIMULATED', journalAuthorized: true, hasAttempts: false, count: 3 },
      { flow: 'base-swap', provenance: 'PUBLIC_MAINNET', status: 'PREPARED', journalAuthorized: false, hasAttempts: true, count: 2 },
      { flow: 'base-swap', provenance: 'PUBLIC_MAINNET', status: 'PREPARED', journalAuthorized: false, hasAttempts: false, count: 5 },
      { flow: 'base-swap', provenance: 'PUBLIC_TESTNET', status: 'SIMULATED', journalAuthorized: false, hasAttempts: false, count: 7 },
      { flow: 'base-swap', provenance: 'SOMETHING_NEW', status: 'SIMULATED', journalAuthorized: false, hasAttempts: false, count: 1 }];
    const a = summarize(executionsOf([run({})]), range, 'MAINNET', all, undefined, idle);
    expect(a.funnel).toMatchObject({ simulated: 51, authorized: 1 + 3 + 2, started: 1, executed: 1 });
    expect(a.unknownProvenance).toBe(1);
    expect(summarize([], range, 'TESTNET', all, undefined, idle).funnel).toMatchObject({ simulated: 7, authorized: 0, executed: 0 });
  });

  it('never mixes mainnet, testnet/devnet and mocked activity', () => {
    const executions = executionsOf([run({ provenance: 'PUBLIC_MAINNET' }), run({ provenance: 'PUBLIC_TESTNET', actions: [{ i: 0, kind: 'SWAP', type: 'asset.swap.exact-input', chain: BASE_SEP }] }),
      run({ provenance: 'PUBLIC_DEVNET', actions: [{ i: 0, kind: 'SWAP', type: 'asset.swap.exact-input', chain: SOL_DEV }] }),
      run({ provenance: 'MOCKED', actions: [{ i: 0, kind: 'BRIDGE', type: 'asset.bridge', chain: BASE_SEP, to: ARB_SEP }] })]);
    const mainnet = summarize(executions, range, 'MAINNET', all), testnet = summarize(executions, range, 'TESTNET', all), mocked = summarize(executions, range, 'MOCKED', all);
    expect(mainnet.executedByEnvironment).toEqual({ MAINNET: 1, TESTNET: 2, MOCKED: 1 });
    expect(mainnet.networks.rows.map(r => r.name)).toEqual(['Base']);
    expect(testnet.networks.rows.map(r => r.name).sort()).toEqual(['Base Sepolia', 'Solana Devnet']);
    expect(mocked.networks.rows.map(r => r.name)).toEqual(['Base Sepolia', 'Arbitrum Sepolia']);
    expect(mocked.funnel.executed).toBe(1);
  });

  it('counts executions without an indexed record, but never assigns them a network', () => {
    const a = summarize(executionsOf([run({ flow: 'crosschain-router-testnet', provenance: 'PUBLIC_TESTNET', actions: null }),
      run({ provenance: 'PUBLIC_TESTNET', fact: { state: 'UNINDEXABLE', code: 'RUN_LOG_TOO_LARGE', actions: [], compositionOf: null } })]), range, 'TESTNET', all);
    expect(a.funnel.executed).toBe(2);
    expect(a.networks.totalActions).toBe(0);
    expect(a.networks.withoutRecordCodes).toEqual(expect.arrayContaining([{ code: 'NOT_INDEXED', count: 1 }, { code: 'RUN_LOG_TOO_LARGE', count: 1 }]));
    expect(a.utilization.find(u => u.kind === 'BRIDGE')).toMatchObject({ executions: 1, executionsWithoutRecord: 1, executedActions: 0 });
  });

  it('parses ranges and buckets', () => {
    expect(analyticsRange({ range: '24h' }, now)).toMatchObject({ preset: '24h', bucket: 'hour', invalid: false });
    expect(analyticsRange({ range: '30d' }, now)).toMatchObject({ preset: '30d', bucket: 'day' });
    expect(analyticsRange({}, now)).toMatchObject({ preset: '7d', invalid: false });
    expect(analyticsRange({ range: 'forever' }, now)).toMatchObject({ preset: '7d', invalid: true });
    const custom = analyticsRange({ range: 'custom', from: '2026-09-01', to: '2026-09-30' }, now);
    expect(custom).toMatchObject({ preset: 'custom', bucket: 'day', from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') });
    expect(analyticsRange({ range: 'custom', from: '2025-01-01', to: '2026-09-30' }, now)).toMatchObject({ preset: '7d', invalid: true });
    expect(analyticsRange({ range: 'custom', from: '2026-09-30', to: '2026-09-01' }, now)).toMatchObject({ invalid: true });
    expect(analyticsRange({ range: 'custom', from: '2026-01-01', to: '2026-06-30' }, now).bucket).toBe('week');
    expect(bucketsOf(analyticsRange({ range: '24h' }, now)).length).toBe(24); // hour-aligned: exactly 24 hourly buckets
    expect(bucketsOf(analyticsRange({ range: '24h' }, new Date('2026-10-14T12:30:00Z'))).length).toBe(25); // a partial first hour adds one
    expect(bucketStart(new Date('2026-10-14T11:59:00Z'), 'hour')).toBe(Date.parse('2026-10-14T11:00:00Z'));
    expect(bucketStart(new Date('2026-10-14T11:59:00Z'), 'week')).toBe(Date.parse('2026-10-12T00:00:00Z'));
    const a = summarize(executionsOf([run({})]), range, 'MAINNET', all);
    expect(a.series.find(p => p.at === Date.parse('2026-10-13T00:00:00Z'))).toMatchObject({ COMPLETED: 1 });
    expect(a.series.reduce((sum, p) => sum + p.COMPLETED, 0)).toBe(1);
  });
});
