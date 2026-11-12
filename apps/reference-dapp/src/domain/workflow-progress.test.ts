// SPDX-License-Identifier: AGPL-3.0-only
/** P0 hotfix (execution continuity): one progress truth for the whole workflow, from durable records only. */
import { describe, expect, it } from 'vitest';
import { projectExecutionLifecycle, type ExecutionLifecycle, type ExecutionLifecycleSource } from './execution-lifecycle';
import { projectExecutionStepEvidence } from './execution-step-evidence';
import { reviewFixture } from '../test-utils/review-fixture';
import { createRouterNode } from './router-authoring';
import { initialEditor } from './editor';
import type { SequencePresentation } from './sequence-presentation';
import { lifecycleStepPhase, operationPhase, phaseText, runReconciled, STEPS_COMPLETED, workflowProgressView } from './workflow-progress';
import { portugueseExecutionContinuity } from '../i18n/pt-execution-continuity';
import { translate } from '../i18n/locale';

const hash = `0x${'a'.repeat(64)}`, other = `0x${'b'.repeat(64)}`;
const source = (kind: ExecutionLifecycleSource['kind'], state: unknown) => ({ kind, state }) as ExecutionLifecycleSource;
/** The Arbitrum swap of production 2026-11-12: owner-bound (its Review binds the owner), approval then swap. */
function ownerBoundSwap(attempts: unknown[], outcome: unknown = null): ExecutionLifecycle {
  const f = reviewFixture(), run = 'run' in f.source.state ? f.source.state.run : null;
  return projectExecutionLifecycle(f.workflow, f.context, source('public', { ...f.source.state,
    run: { ...run, quote: { ...run!.quote, chainId: 42161, ownerReview: { account: f.wallet.account, nonce: '7' } }, outcome, attempts } }));
}
const bridgeWorkflow = () => ({ ...initialEditor().workflow, revision: 1, resourceEdges: [], nodes: [createRouterNode('bridge', { source: 'Base Sepolia', destination: 'Arbitrum Sepolia', token: 'USDC', amount: '2', recipient: '', slippage: '50', routing: 'AUTO' })] });
function bridge(phase: string, verdict: string, attempts: unknown[]): ExecutionLifecycle {
  const workflow = bridgeWorkflow();
  return projectExecutionLifecycle(workflow, reviewFixture().context, source('router', { busy: false, signing: false, recovered: false, record: { id: 'xroute-1', workflow, provenance: 'PUBLIC_TESTNET', phase, verdict,
    destination: verdict === 'RECONCILED' ? { transactionHash: other, transferAmount: '1990000' } : null,
    review: { nodeId: workflow.nodes[0]!.nodeId, intent: { sourceChain: 'eip155:84532', destinationChain: 'eip155:421614' }, route: { inputToken: { symbol: 'USDC' }, routingProvider: 'across' },
      calls: [{ purpose: 'APPROVAL' }, { purpose: 'BRIDGE_DEPOSIT' }] }, attempts } }));
}
const sequence = (states: SequencePresentation['steps'][number]['state'][], finished = false): SequencePresentation => ({ total: states.length, current: Math.min(states.filter(s => s === 'COMPLETED').length + 1, states.length), finished,
  steps: states.map((state, index) => ({ number: index + 1, action: index === 0 ? 'Swap' : 'Bridge', amount: null, detail: null, network: index === 0 ? 'Arbitrum One' : 'Arbitrum One → Base', state,
    funding: null, delivered: state === 'COMPLETED' ? index === 0 ? '2.5 USDC' : '1.99 USDC' : null })) });

describe('P0 hotfix (execution continuity): one progress truth', () => {
  it('an approval whose receipt confirmed is confirmed (never "Pending confirmation"); the step waits for the owner and does not count', () => {
    const live = ownerBoundSwap([{ step: 'approval', state: 'CONFIRMED', txHash: hash, nativeAfter: null, receipt: { gasCostWei: '1' } }]);
    const step = live.steps[0]!;
    expect(step.operations.map(op => [op.id, op.state])).toEqual([['approval', 'confirmed'], ['swap', 'waiting']]);
    expect(operationPhase(step.operations[0]!)).toBe('CONFIRMED_AT_SOURCE');
    expect(lifecycleStepPhase(step, false)).toBe('AWAITING_AUTHORIZATION');
    const view = workflowProgressView({ sequence: sequence(['CURRENT', 'NEXT']), live })!;
    expect(view).toMatchObject({ completed: 0, total: 2, current: 1, finished: false, attention: false });
    expect(view.steps.map(s => [s.phase, s.text.key])).toEqual([['AWAITING_AUTHORIZATION', 'Waiting for your authorization'], [null, 'Not started']]);
  });
  it('a swap confirmed on its network and not reconciled yet is CONFIRMED_AT_SOURCE ("Confirmed on Arbitrum"); it counts only once reconciled', () => {
    const attempts = [{ step: 'approval', state: 'CONFIRMED', txHash: hash, nativeAfter: '1' }, { step: 'swap', state: 'CONFIRMED', txHash: other }];
    const confirmed = ownerBoundSwap(attempts);
    expect(confirmed.steps[0]!.operations[1]).toMatchObject({ state: 'pending', phase: 'CONFIRMED_AT_SOURCE', label: 'Confirmed on {0}', labelArgs: ['Arbitrum'] });
    const during = workflowProgressView({ sequence: sequence(['CURRENT', 'NEXT']), live: confirmed })!;
    expect(during.steps[0]).toMatchObject({ phase: 'CONFIRMED_AT_SOURCE', text: { key: 'Confirmed on {0}', args: ['Arbitrum'] } });
    expect(during.completed).toBe(0);
    const reconciled = ownerBoundSwap(attempts, { inputSpent: '100000000', outputReceived: '2500000' });
    expect(workflowProgressView({ sequence: sequence(['CURRENT', 'NEXT']), live: reconciled })).toMatchObject({ completed: 1, total: 2, current: 2 });
  });
  it('a run whose receipts all confirmed but whose step is not reconciled never shows Reconciled nor counts as completed', () => {
    const f = reviewFixture(), run = 'run' in f.source.state ? f.source.state.run : null;
    const attempts = [{ step: 'approval', state: 'CONFIRMED', txHash: hash, nativeAfter: '1', reconciled: false }, { step: 'swap', state: 'CONFIRMED', txHash: other, reconciled: false }];
    // As the production state projects it (state/execution-lifecycle.ts): the lifecycle with its step evidence.
    const src = source('public', { ...f.source.state, run: { ...run, outcome: null, attempts } }), projected = projectExecutionLifecycle(f.workflow, f.context, src);
    const live: ExecutionLifecycle = { ...projected, stepEvidence: projectExecutionStepEvidence(src, projected) };
    expect(live.state).toBe('complete');
    expect(live.stepEvidence?.[live.steps[0]!.id]?.reconciled).toBe(false);
    // A sequence step does not hand over to the next one either.
    expect(runReconciled(live)).toBe(false);
    for (const view of [workflowProgressView({ sequence: null, live })!, workflowProgressView({ sequence: sequence(['CURRENT', 'NEXT']), live })!]) {
      expect(view.steps[0]!.phase).toBe('CONFIRMED_AT_SOURCE');
      expect(view.completed).toBe(0);
      expect(view.finished).toBe(false);
    }
    // Once FloFi reads the outcome from the chain, the step is reconciled, counts, and the sequence may hand over.
    const read = source('public', { ...f.source.state, run: { ...run, outcome: { inputSpent: '100000000', outputReceived: '2500000', evidence: { outcome: 'RECONCILED' } }, attempts } });
    const done = projectExecutionLifecycle(f.workflow, f.context, read), reconciled: ExecutionLifecycle = { ...done, stepEvidence: projectExecutionStepEvidence(read, done) };
    expect(runReconciled(reconciled)).toBe(true);
    expect(workflowProgressView({ sequence: null, live: reconciled })).toMatchObject({ completed: 1, total: 1, finished: true });
  });
  it('a bridge deposit confirmed at the source with its fill pending is AWAITING_DESTINATION ("Waiting for delivery on Arbitrum Sepolia")', () => {
    const live = bridge('IN_FLIGHT', 'PENDING', [{ step: 'APPROVAL', state: 'CONFIRMED', transactionHash: hash, reconciled: true }, { step: 'DEPOSIT', state: 'CONFIRMED', transactionHash: other, reconciled: true }]);
    const destination = live.steps[0]!.operations.at(-1)!;
    expect(destination).toMatchObject({ id: 'destination', state: 'pending', phase: 'AWAITING_DESTINATION', label: 'Waiting for delivery on {0}', labelArgs: ['Arbitrum Sepolia'] });
    expect(live.steps[0]).toMatchObject({ label: 'Waiting for delivery on {0}', labelArgs: ['Arbitrum Sepolia'] });
    const view = workflowProgressView({ sequence: sequence(['COMPLETED', 'CURRENT']), live })!;
    expect(view.steps.map(s => s.phase)).toEqual(['RECONCILED', 'AWAITING_DESTINATION']);
    expect(view.steps[1]!.text).toEqual({ key: 'Waiting for delivery on {0}', args: ['Arbitrum Sepolia'] });
    expect(view).toMatchObject({ completed: 1, total: 2, current: 2, finished: false });
  });
  it('the count reaches N of N only after the last reconciliation; a finished sequence is COMPLETED with every step and its delivery', () => {
    const reconciled = bridge('RECONCILED', 'RECONCILED', [{ step: 'APPROVAL', state: 'CONFIRMED', transactionHash: hash, reconciled: true }, { step: 'DEPOSIT', state: 'CONFIRMED', transactionHash: other, reconciled: true }]);
    expect(workflowProgressView({ sequence: sequence(['COMPLETED', 'CURRENT']), live: reconciled })).toMatchObject({ completed: 2, total: 2, finished: true, current: null });
    const done = workflowProgressView({ sequence: sequence(['COMPLETED', 'COMPLETED'], true), live: reconciled })!;
    expect(done).toMatchObject({ completed: 2, total: 2, finished: true, current: null, attention: false });
    expect(done.steps.map(s => [s.phase, s.delivered])).toEqual([['RECONCILED', '2.5 USDC'], ['RECONCILED', '1.99 USDC']]);
  });
  it('between steps (the next step not requested yet) the next step is PREPARED once its own simulation is ready, else not started', () => {
    expect(workflowProgressView({ sequence: sequence(['COMPLETED', 'CURRENT']), live: null })!.steps[1]!.phase).toBeNull();
    expect(workflowProgressView({ sequence: sequence(['COMPLETED', 'CURRENT']), live: null, prepared: true })).toMatchObject({ completed: 1, total: 2, current: 2,
      steps: [{ phase: 'RECONCILED' }, { phase: 'PREPARED', text: { key: 'Prepared', args: [] } }] });
  });
  it('a failed or unknown outcome needs attention and never counts; a run of another workflow is never this workflow\'s progress', () => {
    const unknown = ownerBoundSwap([{ step: 'approval', state: 'CONFIRMED', txHash: hash, nativeAfter: '1' }, { step: 'swap', state: 'UNKNOWN', txHash: null }]);
    expect(workflowProgressView({ sequence: sequence(['CURRENT', 'NEXT']), live: unknown })).toMatchObject({ completed: 0, attention: true, steps: [{ phase: 'OUTCOME_UNKNOWN' }, { phase: null }] });
    expect(workflowProgressView({ sequence: null, live: { ...unknown, matchesWorkflow: false } })).toBeNull();
    // A one-runtime workflow (no sequence) counts its own steps.
    expect(workflowProgressView({ sequence: null, live: unknown })).toMatchObject({ total: 1, completed: 0, attention: true });
  });
  it('words a phase with the network as a parameter, translated through the catalog (EN and PT)', () => {
    expect(phaseText(null)).toEqual({ key: 'Not started', args: [] });
    expect(translate('PT', STEPS_COMPLETED, 1, 2)).toBe('1 de 2 etapas concluídas');
    expect(translate('EN', STEPS_COMPLETED, 1, 2)).toBe('1 of 2 steps completed');
    expect(translate('PT', 'Waiting for delivery on {0}', 'Base')).toBe('Aguardando a entrega na Base');
    for (const key of [STEPS_COMPLETED, 'Waiting for delivery', 'Confirmed on {0}']) expect(portugueseExecutionContinuity[key] ?? translate('PT', key)).not.toBe(key);
  });
});
