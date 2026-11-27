// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (FE-BATCH-03): a Batch Payment card's run is its payments (one atomic group), so the whole-workflow run's
 * steps map to the Canvas cards through each card's leg range, and a batch card shows the aggregate of its legs: waiting while every leg waits, done
 * only once every leg reconciled, failed or needing attention as soon as one leg is. Presentation only; never green before every payment reconciled.
 */
import { describe, expect, it } from 'vitest';
import { aggregateNodeExecution, runCanvasExecution, shellCanvasExecution, type CanvasNodeExecution, type RunLike } from './canvas-execution';

const workflow = { workflowId: 'wf-batch', revision: 4, nodes: [{ nodeId: 'swap' }, { nodeId: 'batch' }] };
const authorized = { workflowId: 'wf-batch', revision: 4 };
/** A swap (one step) then a Batch Payment of three payments (steps 1..3). */
const order = [{ nodeId: 'swap' }, { nodeId: 'batch', legs: 3 }];
const group = (state: string, steps: readonly [number, number], index = 0, signed = false): RunLike['groups'][number] =>
  ({ index, steps, chain: 'eip155:8453', state, signed, code: null, delivery: null });
const run = (states: string[], groups: RunLike['groups'], extra: Partial<RunLike> = {}): RunLike => ({ workflowRunId: 'wfr_batch', state: 'RUNNING', mode: 'USER_FUNDED',
  stepCount: states.length, steps: states.map((state, index) => ({ index, state, code: null })), groups, ...extra });
const visuals = (execution: ReturnType<typeof runCanvasExecution>) => execution && Object.fromEntries(Object.entries(execution.nodes).map(([id, node]) => [id, node.visual]));

describe('Live Canvas: a whole-workflow run with a Batch Payment card (FE-BATCH-03)', () => {
  it('maps the run steps to the cards through their leg ranges (four steps, two cards)', () => {
    const r = runCanvasExecution(workflow, order, run(['RECONCILED', 'DELEGATED', 'DELEGATED', 'DELEGATED'],
      [{ ...group('RECONCILED', [0, 0], 0, true) }, group('PREPARED', [1, 3], 1)]), authorized)!;
    expect(visuals(r)).toEqual({ swap: 'done', batch: 'wallet' });
    expect(r.nodes.batch!.text.key).toBe('Waiting for your wallet');
    // The step count must be the cards' legs: the old one-step-per-card mapping (two steps) colors nothing.
    expect(runCanvasExecution(workflow, order, run(['RECONCILED', 'DELEGATED'], [group('PREPARED', [0, 1])]), authorized)).toBeNull();
    expect(runCanvasExecution(workflow, [{ nodeId: 'swap' }, { nodeId: 'batch' }], run(['RECONCILED', 'DELEGATED', 'DELEGATED', 'DELEGATED'], [group('PREPARED', [0, 3])]), authorized)).toBeNull();
    expect(runCanvasExecution(workflow, [{ nodeId: 'swap' }, { nodeId: 'batch', legs: 0 }], run(['RECONCILED'], [group('PREPARED', [0, 0])]), authorized)).toBeNull();
  });

  it('a lone Batch Payment card is done only once every payment reconciled', () => {
    const lone = { workflowId: 'wf-batch', revision: 4, nodes: [{ nodeId: 'batch' }] }, legs = [{ nodeId: 'batch', legs: 3 }];
    const waiting = runCanvasExecution(lone, legs, run(['PENDING', 'PENDING', 'PENDING'], [group('PLANNED', [0, 2])], { state: 'PENDING' }), authorized)!;
    expect(visuals(waiting)).toEqual({ batch: 'waiting' });
    expect(waiting.started).toBe(false);
    const partly = runCanvasExecution(lone, legs, run(['RECONCILED', 'DELEGATED', 'DELEGATED'], [group('SUBMITTED', [0, 2], 0, true)]), authorized)!;
    expect(visuals(partly)).toEqual({ batch: 'pending' });
    const done = runCanvasExecution(lone, legs, run(['RECONCILED', 'RECONCILED', 'RECONCILED'], [group('RECONCILED', [0, 2], 0, true)], { state: 'COMPLETED' }), authorized)!;
    expect(visuals(done)).toEqual({ batch: 'done' });
    expect(done.settled).toBe(true);
    const failed = runCanvasExecution(lone, legs, run(['RECONCILED', 'FAILED', 'SKIPPED'], [group('FAILED', [0, 2], 0, true)], { state: 'FAILED' }), authorized)!;
    expect(visuals(failed)).toEqual({ batch: 'failed' });
    const uncertain = runCanvasExecution(lone, legs, run(['DELEGATED', 'UNCERTAIN', 'DELEGATED'], [group('UNCERTAIN', [0, 2], 0, true)], { state: 'ATTENTION' }), authorized)!;
    expect(visuals(uncertain)).toEqual({ batch: 'attention' });
    // The same record through the shell's projection (its `order` carries the legs).
    expect(visuals(shellCanvasExecution(lone, { run: run(['RECONCILED', 'RECONCILED', 'RECONCILED'], [group('RECONCILED', [0, 2], 0, true)], { state: 'COMPLETED' }), order: legs,
      authorizedFor: authorized, unrecorded: false, sequence: null, live: null }) as ReturnType<typeof runCanvasExecution>)).toEqual({ batch: 'done' });
  });

  it('aggregates legs: failed, then attention, then all done, then all waiting, then the leg that most needs the owner', () => {
    const leg = (visual: CanvasNodeExecution['visual'], key = visual): CanvasNodeExecution => ({ visual, phase: null, text: { key, args: [] } });
    expect(aggregateNodeExecution([]).visual).toBe('waiting');
    expect(aggregateNodeExecution([leg('done'), leg('failed'), leg('attention')]).visual).toBe('failed');
    expect(aggregateNodeExecution([leg('done'), leg('attention'), leg('pending')]).visual).toBe('attention');
    expect(aggregateNodeExecution([leg('done'), leg('done')]).visual).toBe('done');
    expect(aggregateNodeExecution([leg('waiting'), leg('waiting')]).visual).toBe('waiting');
    expect(aggregateNodeExecution([leg('pending'), leg('authorize'), leg('waiting')]).visual).toBe('authorize');
    expect(aggregateNodeExecution([leg('done'), leg('pending')]).visual).toBe('pending');
    // Some reconciled while others wait is never "Completed".
    expect(aggregateNodeExecution([leg('done'), leg('waiting')])).toMatchObject({ visual: 'pending', text: { key: 'In progress' } });
  });
});
