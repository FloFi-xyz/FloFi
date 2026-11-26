// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the Canvas cards' execution states come from authoritative records only, keyed by node id. */
import { describe, expect, it } from 'vitest';
import { projectExecutionLifecycle, type ExecutionLifecycle, type ExecutionLifecycleSource, type LifecycleOperation, type LifecycleState, type LifecycleStep } from './execution-lifecycle';
import { canvasExecutionFor, edgeExecution, lifecycleCanvasExecution, runCanvasExecution, sequenceCanvasExecution, shellCanvasExecution, visualOfPhase, type RunLike } from './canvas-execution';
import { EXECUTION_PHASES } from './execution-phase';
import { reviewFixture } from '../test-utils/review-fixture';

const hash = `0x${'a'.repeat(64)}`, other = `0x${'b'.repeat(64)}`;
const workflow = { workflowId: 'wf-1', revision: 3, nodes: [{ nodeId: 'swap' }, { nodeId: 'bridge' }, { nodeId: 'transfer' }] };
const order = workflow.nodes;
function op(id: string, nodeId: string, state: LifecycleState, extra: Partial<LifecycleOperation> = {}): LifecycleOperation {
  return { id, nodeId, title: id, state, label: '', hash: ['waiting', 'wallet', 'preparing', 'not-submitted', 'cancelled'].includes(state) ? null : hash, chain: 'eip155:8453',
    explorer: null, fee: null, approval: false, intent: false, wallet: true, ...extra };
}
const step = (id: string, operations: LifecycleOperation[], label = ''): LifecycleStep => ({ id, number: 1, action: 'Swap', input: '1 ETH', pair: null, network: 'Base',
  provider: null, tokens: [], state: 'waiting', label, operations });
function lifecycle(steps: LifecycleStep[], extra: Partial<ExecutionLifecycle> = {}, reconciled: readonly string[] = []): ExecutionLifecycle {
  return { started: true, restored: false, local: false, matchesWorkflow: true, steps, active: null, completed: 0, label: '', message: '', state: 'active', runKey: 'run-1',
    fingerprint: '', busy: false, stepEvidence: Object.fromEntries(steps.map(s => [s.id, { reconciled: reconciled.includes(s.id) }])), ...extra } as unknown as ExecutionLifecycle;
}
const visuals = (execution: ReturnType<typeof lifecycleCanvasExecution>) => execution && Object.fromEntries(Object.entries(execution.nodes).map(([id, node]) => [id, node.visual]));

describe('Live Canvas: phases → visual states', () => {
  it('never shows green before a reconciled step, and every phase has a visual', () => {
    for (const phase of EXECUTION_PHASES) expect(visualOfPhase(phase)).toBeTruthy();
    expect(EXECUTION_PHASES.filter(phase => visualOfPhase(phase) === 'done')).toEqual(['RECONCILED', 'COMPLETED']);
    expect(visualOfPhase('SUBMITTED')).toBe('pending'); expect(visualOfPhase('CONFIRMED_AT_SOURCE')).toBe('pending');
    expect(visualOfPhase('AWAITING_DESTINATION')).toBe('pending'); expect(visualOfPhase('DESTINATION_OBSERVED')).toBe('pending');
    expect(visualOfPhase('SENT_TO_WALLET')).toBe('wallet'); expect(visualOfPhase('AWAITING_AUTHORIZATION')).toBe('authorize');
    expect(visualOfPhase('OUTCOME_UNKNOWN')).toBe('attention'); expect(visualOfPhase('FAILED')).toBe('failed');
    expect(visualOfPhase(null)).toBe('waiting'); expect(visualOfPhase('PREPARED')).toBe('waiting');
  });
});

describe('Live Canvas: one runtime executing the workflow (lifecycle steps are the workflow nodes)', () => {
  it('a card with several requests (approval + swap) turns green only when its whole operation is reconciled', () => {
    const approving = lifecycle([step('swap', [op('approval', 'swap', 'wallet', { approval: true }), op('swap', 'swap', 'waiting')]), step('bridge', []), step('transfer', [])]);
    expect(visuals(lifecycleCanvasExecution(workflow, approving))).toEqual({ swap: 'wallet', bridge: 'waiting', transfer: 'waiting' });
    // The approval landed, the swap itself is not sent yet: the step waits for the owner, never green.
    const approved = lifecycle([step('swap', [op('approval', 'swap', 'confirmed', { approval: true }), op('swap', 'swap', 'waiting')]), step('bridge', []), step('transfer', [])]);
    expect(lifecycleCanvasExecution(workflow, approved)!.nodes.swap).toMatchObject({ visual: 'authorize', phase: 'AWAITING_AUTHORIZATION' });
    const submitted = lifecycle([step('swap', [op('approval', 'swap', 'confirmed', { approval: true }), op('swap', 'swap', 'submitted')]), step('bridge', []), step('transfer', [])]);
    expect(lifecycleCanvasExecution(workflow, submitted)!.nodes.swap!.visual).toBe('pending');
    // Every receipt confirmed but the step is not reconciled yet: still in progress.
    const confirmed = lifecycle([step('swap', [op('approval', 'swap', 'confirmed', { approval: true }), op('swap', 'swap', 'confirmed')]), step('bridge', []), step('transfer', [])]);
    expect(lifecycleCanvasExecution(workflow, confirmed)!.nodes.swap).toMatchObject({ visual: 'pending', phase: 'CONFIRMED_AT_SOURCE' });
    const reconciled = lifecycle(confirmed.steps, {}, ['swap']);
    expect(lifecycleCanvasExecution(workflow, reconciled)!.nodes.swap).toMatchObject({ visual: 'done', phase: 'RECONCILED' });
  });
  it('parallel steps of one runtime keep their own states (no sequential order is imposed)', () => {
    const live = lifecycle([step('swap', [op('swap', 'swap', 'pending')]), step('bridge', [op('deposit', 'bridge', 'wallet')]), step('transfer', [op('send', 'transfer', 'confirmed')])], {}, ['transfer']);
    expect(visuals(lifecycleCanvasExecution(workflow, live))).toEqual({ swap: 'pending', bridge: 'wallet', transfer: 'done' });
  });
  it('a bridge is never green while its destination delivery is pending, even with the source deposit confirmed', () => {
    const live = lifecycle([step('bridge', [op('deposit', 'bridge', 'confirmed'), op('destination', 'bridge', 'settling', { wallet: false, hash: null, chain: 'eip155:42161' })])]);
    const execution = lifecycleCanvasExecution({ ...workflow, nodes: [{ nodeId: 'bridge' }] }, live)!;
    expect(execution.nodes.bridge).toMatchObject({ visual: 'pending', phase: 'AWAITING_DESTINATION', text: { key: 'Waiting for delivery on {0}' } });
    expect(execution.settled).toBe(false);
  });
  it('a declined or expired wallet request (nothing sent) needs the owner (amber); a reverted transaction is a confirmed failure (red)', () => {
    const declined = lifecycle([step('swap', [op('swap', 'swap', 'failed', { hash: null, label: 'Wallet request declined' })], 'Wallet request declined')]);
    expect(lifecycleCanvasExecution(workflow, declined)!.nodes.swap).toMatchObject({ visual: 'attention', text: { key: 'Wallet request declined' } });
    const expired = lifecycle([step('swap', [op('swap', 'swap', 'expired', { hash: null })], 'Transaction expired')]);
    expect(lifecycleCanvasExecution(workflow, expired)!.nodes.swap!.visual).toBe('attention');
    const reverted = lifecycle([step('swap', [op('swap', 'swap', 'failed')], 'Failed')]);
    expect(lifecycleCanvasExecution(workflow, reverted)!.nodes.swap).toMatchObject({ visual: 'failed', phase: 'FAILED' });
  });
  it('an unknown outcome is amber; a partial execution keeps every step’s actual outcome (a failure never resets a completed step)', () => {
    const live = lifecycle([step('swap', [op('swap', 'swap', 'confirmed')]), step('bridge', [op('deposit', 'bridge', 'uncertain')]), step('transfer', [op('send', 'transfer', 'failed')])], { state: 'uncertain' }, ['swap']);
    const execution = lifecycleCanvasExecution(workflow, live)!;
    expect(visuals(execution)).toEqual({ swap: 'done', bridge: 'attention', transfer: 'failed' });
    // An outcome still being observed is never captioned as a result.
    expect(execution.settled).toBe(false);
    const ended = lifecycleCanvasExecution(workflow, lifecycle([step('swap', [op('swap', 'swap', 'confirmed')]), step('bridge', [op('deposit', 'bridge', 'failed')])], { state: 'attention' }, ['swap']))!;
    expect(ended.settled).toBe(true); expect(ended.runKeys).toEqual(['run-1']);
  });
  it('a request being prepared or submitted after the owner’s click is active; a restored run is shown from its record alone', () => {
    const live = lifecycle([step('swap', [op('swap', 'swap', 'preparing')])]);
    expect(lifecycleCanvasExecution(workflow, live)!.nodes.swap).toMatchObject({ visual: 'active', text: { key: 'Preparing request' } });
    const restored = lifecycle([step('swap', [op('swap', 'swap', 'confirmed')]), step('bridge', [op('deposit', 'bridge', 'pending')])], { restored: true }, ['swap']);
    expect(visuals(lifecycleCanvasExecution(workflow, restored))).toEqual({ swap: 'done', bridge: 'pending' });
  });
  it('colors nothing for another workflow, a detached run, a saved run without its plan, an unstarted run or nodes absent from the Canvas', () => {
    const base = lifecycle([step('swap', [op('swap', 'swap', 'pending')])]);
    expect(lifecycleCanvasExecution(workflow, { ...base, matchesWorkflow: false })).toBeNull();
    expect(lifecycleCanvasExecution(workflow, { ...base, detached: true })).toBeNull();
    expect(lifecycleCanvasExecution(workflow, { ...base, planUnavailable: true })).toBeNull();
    expect(lifecycleCanvasExecution(workflow, { ...base, started: false })).toBeNull();
    expect(lifecycleCanvasExecution(workflow, lifecycle([step('elsewhere', [op('swap', 'elsewhere', 'pending')])]))).toBeNull();
    expect(lifecycleCanvasExecution(workflow, null)).toBeNull();
  });
  it('a record is shown only on the exact workflow id and revision it was computed for', () => {
    const execution = lifecycleCanvasExecution(workflow, lifecycle([step('swap', [op('swap', 'swap', 'pending')])]));
    expect(canvasExecutionFor(execution, workflow)).toBe(execution);
    expect(canvasExecutionFor(execution, { ...workflow, revision: 4 })).toBeNull();
    expect(canvasExecutionFor(execution, { ...workflow, workflowId: 'wf-2' })).toBeNull();
  });
  it('maps the real owner-bound swap projection (approval confirmed, swap not sent) without ever reading it as completed', () => {
    const f = reviewFixture(), run = 'run' in f.source.state ? f.source.state.run : null;
    const live = projectExecutionLifecycle(f.workflow, f.context, { kind: 'public', state: { ...f.source.state,
      run: { ...run, quote: { ...run!.quote, chainId: 42161, ownerReview: { account: f.wallet.account, nonce: '7' } }, outcome: null,
        attempts: [{ step: 'approval', state: 'CONFIRMED', txHash: hash, nativeAfter: null, receipt: { gasCostWei: '1' } }] } } } as unknown as ExecutionLifecycleSource);
    const execution = lifecycleCanvasExecution(f.workflow, live)!;
    const node = f.workflow.nodes.find(n => !n.actionType.startsWith('mock-'))!.nodeId;
    expect(execution.nodes[node]).toMatchObject({ visual: 'authorize', phase: 'AWAITING_AUTHORIZATION' });
    const swapped = projectExecutionLifecycle(f.workflow, f.context, { kind: 'public', state: { ...f.source.state, run: { ...run, outcome: null,
      attempts: [{ step: 'approval', state: 'CONFIRMED', txHash: hash, nativeAfter: '1' }, { step: 'swap', state: 'SUBMITTED', txHash: other }] } } } as unknown as ExecutionLifecycleSource);
    expect(lifecycleCanvasExecution(f.workflow, swapped)!.nodes[node]!.visual).not.toBe('done');
  });
});

describe('Live Canvas: a step-by-step workflow (Swap → Bridge → Transfer)', () => {
  const seq = (completed: number, finished = false) => ({ steps: order, cursor: Math.min(completed, order.length - 1), completed: Array.from({ length: completed }, () => ({})), finished });
  const current = (nodeId: string, state: LifecycleState) => lifecycle([step(nodeId, [op('request', nodeId, state)])]);
  it('progresses neutral → blue → green on the same cards, one step at a time', () => {
    expect(sequenceCanvasExecution(workflow, seq(0), null)).toBeNull();
    expect(visuals(sequenceCanvasExecution(workflow, seq(0), current('swap', 'pending')))).toEqual({ swap: 'pending', bridge: 'waiting', transfer: 'waiting' });
    expect(visuals(sequenceCanvasExecution(workflow, seq(1), current('bridge', 'wallet')))).toEqual({ swap: 'done', bridge: 'wallet', transfer: 'waiting' });
    expect(visuals(sequenceCanvasExecution(workflow, seq(2), current('transfer', 'submitted')))).toEqual({ swap: 'done', bridge: 'done', transfer: 'pending' });
    const finished = sequenceCanvasExecution(workflow, seq(3, true), null)!;
    expect(visuals(finished)).toEqual({ swap: 'done', bridge: 'done', transfer: 'done' });
    expect(finished.settled).toBe(true);
  });
  it('the previous step’s run never colors the next card (a lifecycle of another node is ignored)', () => {
    expect(visuals(sequenceCanvasExecution(workflow, seq(1), current('swap', 'confirmed')))).toEqual({ swap: 'done', bridge: 'waiting', transfer: 'waiting' });
  });
});

describe('Live Canvas: a whole-workflow run', () => {
  const group = (state: string, signed = false, delivery: RunLike['groups'][number]['delivery'] = null): RunLike['groups'][number] =>
    ({ index: 0, steps: [0, 2], chain: 'eip155:8453', state, signed, code: null, delivery });
  const run = (states: string[], groups: RunLike['groups'] = [group('PLANNED')], extra: Partial<RunLike> = {}): RunLike => ({ workflowRunId: 'wfr_1', state: 'RUNNING', mode: 'USER_FUNDED',
    stepCount: states.length, steps: states.map((state, index) => ({ index, state, code: null })), groups, ...extra });
  const authorized = { workflowId: 'wf-1', revision: 3 };
  it('maps step i to the i-th node of the sequence order and follows the run state', () => {
    const r = runCanvasExecution(workflow, order, run(['RECONCILED', 'DELEGATED', 'PENDING'], [group('SUBMITTED', true)]), authorized)!;
    // A step still PENDING in the run's own record has not been sent: it stays neutral whatever its group shows.
    expect(visuals(r)).toEqual({ swap: 'done', bridge: 'pending', transfer: 'waiting' });
    // A prepared group reads as the panel says it: waiting for the owner's wallet.
    const waiting = runCanvasExecution(workflow, order, run(['DELEGATED', 'DELEGATED', 'DELEGATED'], [group('PREPARED')]), authorized)!;
    expect(visuals(waiting)).toEqual({ swap: 'wallet', bridge: 'wallet', transfer: 'wallet' }); expect(waiting.nodes.swap!.text.key).toBe('Waiting for your wallet');
    // A batch this browser handed to the wallet without a recorded answer may already be executing: never "waiting" for the owner.
    const handed = runCanvasExecution(workflow, order, run(['DELEGATED', 'DELEGATED', 'DELEGATED'], [group('PREPARED')]), authorized, true)!;
    expect(visuals(handed)).toEqual({ swap: 'attention', bridge: 'attention', transfer: 'attention' }); expect(handed.nodes.swap!.phase).toBe('OUTCOME_UNKNOWN');
    // A due group asks for the owner's authorization in FloFi; an owner step on its signing page is in progress (never "confirm in wallet" for hours).
    const due = runCanvasExecution(workflow, order, run(['RECONCILED', 'DELEGATED', 'DELEGATED'], [{ ...group('RECONCILED', true), steps: [0, 0] }, { ...group('PLANNED'), index: 1, steps: [1, 2] }],
      { currentStep: 1, nextAction: 'OWNER_SIGNS_GROUP' }), authorized)!;
    expect(visuals(due)).toEqual({ swap: 'done', bridge: 'authorize', transfer: 'authorize' });
    const owner = runCanvasExecution(workflow, order, run(['RECONCILED', 'AWAITING_OWNER', 'PENDING'], [], { mode: 'CONFIRM_EACH_STEP', currentStep: 1, nextAction: 'WAITING_FOR_RECONCILIATION' }), authorized)!;
    expect(visuals(owner)).toEqual({ swap: 'done', bridge: 'pending', transfer: 'waiting' });
    const ready = runCanvasExecution(workflow, order, run(['RECONCILED', 'READY', 'PENDING'], [], { mode: 'CONFIRM_EACH_STEP', currentStep: 1, nextAction: 'OWNER_SIGNS_STEP' }), authorized)!;
    expect(visuals(ready)).toEqual({ swap: 'done', bridge: 'authorize', transfer: 'waiting' });
    // A signed group whose reconciliation could not complete is an outcome still being observed (amber), never blue progress.
    const uncertain = runCanvasExecution(workflow, order, run(['DELEGATED', 'DELEGATED', 'DELEGATED'], [group('UNCERTAIN', true)], { state: 'ATTENTION' }), authorized)!;
    expect(visuals(uncertain)).toEqual({ swap: 'attention', bridge: 'attention', transfer: 'attention' });
    // A later group signed only when due asks nothing of the wallet yet.
    const later = runCanvasExecution(workflow, order, run(['RECONCILED', 'DELEGATED', 'DELEGATED'], [{ ...group('RECONCILED', true), steps: [0, 0] }, { ...group('PLANNED'), index: 1, steps: [1, 2] }]), authorized)!;
    expect(visuals(later)).toEqual({ swap: 'done', bridge: 'waiting', transfer: 'waiting' }); expect(later.nodes.bridge!.text.key).toBe('Not signed yet');
    const done = runCanvasExecution(workflow, order, run(['RECONCILED', 'RECONCILED', 'RECONCILED'], [group('RECONCILED', true)], { state: 'COMPLETED' }), authorized)!;
    expect(visuals(done)).toEqual({ swap: 'done', bridge: 'done', transfer: 'done' }); expect(done.settled).toBe(true);
  });
  it('a batched bridge awaiting its destination delivery stays blue; past its deadline it is amber; failures stay red beside reconciled steps', () => {
    const awaiting = runCanvasExecution(workflow, order, run(['RECONCILED', 'DELEGATED', 'PENDING'], [group('SUBMITTED', true, { step: 1, chain: 'eip155:42161', state: 'AWAITING_DESTINATION' })]), authorized)!;
    expect(awaiting.nodes.bridge).toMatchObject({ visual: 'pending', phase: 'AWAITING_DESTINATION', text: { key: 'Waiting for delivery on {0}', args: ['Arbitrum One'] } });
    const late = runCanvasExecution(workflow, order, run(['RECONCILED', 'UNCERTAIN', 'PENDING'], [group('UNCERTAIN', true, { step: 1, chain: 'eip155:42161', state: 'NOT_OBSERVED' })]), authorized)!;
    expect(late.nodes.bridge!.visual).toBe('attention');
    const failed = runCanvasExecution(workflow, order, run(['RECONCILED', 'FAILED', 'SKIPPED'], [group('FAILED', true)], { state: 'FAILED' }), authorized)!;
    expect(visuals(failed)).toEqual({ swap: 'done', bridge: 'failed', transfer: 'waiting' });
  });
  it('a batch handed to the wallet and never answered may have executed: never "not run" or "stopped before submission"', () => {
    for (const state of ['SKIPPED', 'BLOCKED', 'DELEGATED']) {
      const r = { ...run(['RECONCILED', state, state], [{ ...group('RECONCILED', true), steps: [0, 0] }, { ...group(state === 'DELEGATED' ? 'BLOCKED' : state, false), index: 1, steps: [1, 2], code: 'WALLET_BATCH_OUTCOME_UNKNOWN' }], { state: state === 'SKIPPED' ? 'CANCELLED' : 'HALTED' }),
        steps: [{ index: 0, state: 'RECONCILED', code: null }, { index: 1, state, code: 'WALLET_BATCH_OUTCOME_UNKNOWN' }, { index: 2, state, code: null }] };
      const e = runCanvasExecution(workflow, order, r, authorized)!;
      expect(visuals(e)).toEqual({ swap: 'done', bridge: 'attention', transfer: 'attention' });
      expect(e.nodes.bridge).toMatchObject({ phase: 'OUTCOME_UNKNOWN', text: { key: "Its batch may have executed before it expired; check your wallet's activity" } });
      expect(edgeExecution(e, 'swap', 'bridge')).toBe('done'); expect(edgeExecution(e, 'bridge', 'transfer')).toBe('attention');
      // An ended (CANCELLED) run is FloFi's final record: a result with its amber steps, never "live"; a HALTED run can still resume.
      expect(e.settled).toBe(state === 'SKIPPED');
    }
  });
  it('steps of a prepared group read as waiting for the wallet, whatever their own state', () => {
    const r = runCanvasExecution(workflow, order, run(['READY', 'PENDING', 'PENDING'], [group('PREPARED')], { mode: 'USER_FUNDED' }), authorized)!;
    expect(visuals(r)).toEqual({ swap: 'wallet', bridge: 'wallet', transfer: 'wallet' });
  });
  it('colors nothing for another workflow or revision, an unauthorized view or a different number of steps', () => {
    const r = run(['RECONCILED', 'DELEGATED', 'PENDING']);
    expect(runCanvasExecution(workflow, order, r, { workflowId: 'wf-1', revision: 2 })).toBeNull();
    expect(runCanvasExecution(workflow, order, r, { workflowId: 'wf-2', revision: 3 })).toBeNull();
    expect(runCanvasExecution(workflow, order, r, null)).toBeNull();
    expect(runCanvasExecution(workflow, order.slice(0, 2), r, authorized)).toBeNull();
  });
  it('the shell shows its own authorized run first, else the step-by-step sequence, else the lifecycle; a stale run never wins', () => {
    const r = run(['RECONCILED', 'DELEGATED', 'PENDING'], [group('SUBMITTED', true)]);
    const live = lifecycle([step('swap', [op('swap', 'swap', 'pending')]), step('bridge', []), step('transfer', [])]);
    const sequence = { steps: order, cursor: 1, completed: [{}], finished: false };
    const records = { run: r, order, authorizedFor: authorized, unrecorded: false, sequence: null, live };
    expect(shellCanvasExecution(workflow, records)!.key).toBe('run:wfr_1');
    expect(visuals(shellCanvasExecution(workflow, records))).toEqual({ swap: 'done', bridge: 'pending', transfer: 'waiting' });
    // The Editor's "handed to the wallet, answer unrecorded" reaches the cards.
    expect(shellCanvasExecution(workflow, { ...records, run: run(['DELEGATED', 'DELEGATED', 'DELEGATED'], [group('PREPARED')]), unrecorded: true })!.nodes.swap!.phase).toBe('OUTCOME_UNKNOWN');
    // A run authorized for another revision (or not this tab's) colors nothing: the records after it are shown instead.
    expect(shellCanvasExecution(workflow, { ...records, authorizedFor: { workflowId: 'wf-1', revision: 2 } })!.key).toBe('lifecycle:run-1');
    expect(shellCanvasExecution(workflow, { ...records, run: null, sequence })!.key).toBe('sequence:wf-1');
    expect(shellCanvasExecution(workflow, { ...records, run: null })!.key).toBe('lifecycle:run-1');
    expect(shellCanvasExecution(workflow, { ...records, run: null, live: lifecycle(live.steps, { matchesWorkflow: false }) })).toBeNull();
    expect(shellCanvasExecution(workflow, { ...records, run: null, live: null })).toBeNull();
  });
});

describe('Live Canvas: connections', () => {
  const live = lifecycle([step('swap', [op('swap', 'swap', 'confirmed')]), step('bridge', [op('deposit', 'bridge', 'pending')]), step('transfer', [])], {}, ['swap']);
  const execution = lifecycleCanvasExecution(workflow, live);
  it('follow their dependency’s record: green once satisfied, blue while the step it unlocks runs, neutral otherwise', () => {
    expect(edgeExecution(execution, 'swap', 'bridge')).toBe('active');
    expect(edgeExecution(execution, 'bridge', 'transfer')).toBe('waiting');
    expect(edgeExecution(lifecycleCanvasExecution(workflow, lifecycle([step('swap', [op('swap', 'swap', 'confirmed')]), step('bridge', [])], {}, ['swap'])), 'swap', 'bridge')).toBe('done');
    expect(edgeExecution(null, 'swap', 'bridge')).toBe('waiting');
  });
  it('are red or amber only when their dependency failed or its outcome is unknown', () => {
    const failed = lifecycleCanvasExecution(workflow, lifecycle([step('swap', [op('swap', 'swap', 'failed')]), step('bridge', [])]));
    expect(edgeExecution(failed, 'swap', 'bridge')).toBe('failed');
    const unknown = lifecycleCanvasExecution(workflow, lifecycle([step('swap', [op('swap', 'swap', 'uncertain')]), step('bridge', [])]));
    expect(edgeExecution(unknown, 'swap', 'bridge')).toBe('attention');
  });
});

describe('execution UX regression fixes: a reconciled card shows the actual received amount', () => {
  it('carries the amount the reconciled record observed (never the estimate), and nothing before reconciliation', async () => {
    const { runDetailFixture } = await import('../test-utils/run-detail-fixture');
    const { lifecycleNodeExecution } = await import('./canvas-execution');
    const done = runDetailFixture('completed').view.progress!, pending = runDetailFixture('pending').view.progress!;
    expect(lifecycleNodeExecution(done, done.steps[0]!)).toMatchObject({ visual: 'done', received: { amount: '0.0243', unit: 'WETH', label: 'You received' } });
    // A bridge's destination delivery goes to the reviewed recipient: "Delivered", never "You received" (the receipt's rule).
    const bridge = runDetailFixture('bridge-completed').view.progress!;
    expect(lifecycleNodeExecution(bridge, bridge.steps[0]!).received).toEqual({ amount: '4.89', unit: 'USDC', label: 'Delivered' });
    expect(lifecycleNodeExecution(pending, pending.steps[0]!)).not.toHaveProperty('received');
    // A step whose record observed no received amount carries none (the card keeps its own wording; nothing is guessed).
    const unobserved = { ...done, evidence: { ...done.evidence!, operations: {} } };
    expect(lifecycleNodeExecution(unobserved, unobserved.steps[0]!)).not.toHaveProperty('received');
  });
});
