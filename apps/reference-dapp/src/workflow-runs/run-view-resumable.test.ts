// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Review fixes R4/R5/R6: what a run's view promises. `resumable` is exactly the server's own Resume rule (no surface offers a Resume the server
 * refuses); a partially completed run never claims nothing later was submitted; a run ended while a batch it handed to the owner's wallet was
 * never answered says that batch may have executed.
 */
import { describe, expect, it } from 'vitest';
import type { GroupRecord, RunRecord, RunStepRecord } from './pg-store.ts';
import { resumeRun, runView, type WorkflowRunDeps } from './service.ts';

const OWNER = '0x' + '1a'.repeat(20), NOW = new Date('2026-11-09T12:00:00Z');
const SWAP = { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 };
const runOf = (mode: string, state: string, expiresAt = new Date(NOW.getTime() + 3_600_000)) => ({ runId: 'wfr_' + 'r'.repeat(26), handoffId: 'apr_' + 'r'.repeat(26), mode,
  state, stepCount: 2, currentStep: 0, code: 'X_STOPPED', strategy: { version: 2, steps: [SWAP, { ...SWAP, amount: '5' }] }, workflowHash: '0x' + '1'.repeat(64),
  wallets: { eip155: OWNER }, owner: { namespace: 'eip155', address: OWNER }, version: 4, completedAt: null, expiresAt, createdAt: NOW, updatedAt: NOW }) as unknown as RunRecord;
const step = (stepIndex: number, state: string, strategy: unknown = null) => ({ runId: 'wfr_' + 'r'.repeat(26), stepIndex, state, flow: null, strategy, workflowHash: null,
  bound: null, claimedAt: null, outcome: null, code: null, version: 1, updatedAt: NOW }) as unknown as RunStepRecord;
const group = (patch: Partial<GroupRecord>) => ({ runId: 'wfr_' + 'r'.repeat(26), groupIndex: 0, namespace: 'eip155', chain: 'eip155:8453', feePayer: OWNER, stepFrom: 0,
  stepTo: 1, strategy: 'EVM_WALLET_BATCH', signing: 'WHEN_DUE', awaitsDelivery: null, state: 'BLOCKED', code: null, validUntil: null, version: 2, prepared: null,
  authorization: null, submission: null, outcome: null, ...patch }) as unknown as GroupRecord;
const storeOf = (steps: readonly RunStepRecord[], groups: readonly GroupRecord[]) => ({ steps: async () => [...steps], groups: async () => [...groups] });

/** Every shape of run the Resume rule distinguishes, with whether the server accepts Resume for it. */
const CASES: readonly [string, RunRecord, readonly RunStepRecord[], readonly GroupRecord[], boolean][] = [
  ['user-funded, halted at an unsigned BLOCKED group', runOf('USER_FUNDED', 'HALTED'), [step(0, 'BLOCKED'), step(1, 'BLOCKED')], [group({})], true],
  ['user-funded, the same past its window', runOf('USER_FUNDED', 'HALTED', new Date(NOW.getTime() - 1)), [step(0, 'BLOCKED'), step(1, 'BLOCKED')], [group({})], false],
  ['user-funded, the halted group is signed', runOf('USER_FUNDED', 'HALTED'), [step(0, 'BLOCKED'), step(1, 'BLOCKED')],
    [group({ authorization: { kind: 'EVM_WALLET_BATCH', batchId: '0x' + 'cd'.repeat(32) } })], false],
  ['user-funded, the current group is not BLOCKED', runOf('USER_FUNDED', 'HALTED'), [step(0, 'DELEGATED'), step(1, 'DELEGATED')], [group({ state: 'PLANNED' })], false],
  ['user-funded, halted at an owner-step group whose step is BLOCKED', runOf('USER_FUNDED', 'HALTED'), [step(0, 'BLOCKED'), step(1, 'PENDING')],
    [group({ strategy: 'EVM_OWNER_STEP', state: 'PLANNED' })], true],
  ['user-funded, owner-step group whose step is not BLOCKED', runOf('USER_FUNDED', 'HALTED'), [step(0, 'UNCERTAIN'), step(1, 'PENDING')],
    [group({ strategy: 'EVM_OWNER_STEP', state: 'PLANNED' })], false],
  ['confirm mode, a BLOCKED step', runOf('CONFIRM_EACH_STEP', 'HALTED'), [step(0, 'BLOCKED', SWAP), step(1, 'PENDING')], [], true],
  ['confirm mode, past its window', runOf('CONFIRM_EACH_STEP', 'HALTED', NOW), [step(0, 'BLOCKED', SWAP), step(1, 'PENDING')], [], false],
  ['confirm mode, the step is not BLOCKED', runOf('CONFIRM_EACH_STEP', 'HALTED'), [step(0, 'FAILED'), step(1, 'PENDING')], [], false],
  ['a halted delegated execution', runOf('DELEGATED', 'HALTED'), [step(0, 'BLOCKED'), step(1, 'DELEGATED')], [], false],
  ['a running run', runOf('CONFIRM_EACH_STEP', 'RUNNING'), [step(0, 'BLOCKED', SWAP), step(1, 'PENDING')], [], false],
  ['an ended run', runOf('USER_FUNDED', 'CANCELLED'), [step(0, 'SKIPPED'), step(1, 'SKIPPED')], [group({ state: 'SKIPPED' })], false],
];

describe('review fix R5: `resumable` is exactly the server\'s own Resume rule', () => {
  for (const [name, run, steps, groups, expected] of CASES) it(`${name}: ${expected ? 'resumable' : 'not resumable'}`, async () => {
    for (const outcomes of [true, false]) expect((await runView({ store: storeOf(steps, groups), now: () => NOW }, run, { outcomes })).resumable).toBe(expected);
    // The server itself: Resume passes every rule exactly when the view says so (here its compare-and-set then loses: WORKFLOW_RUN_CHANGED).
    const deps = { store: { ...storeOf(steps, groups), transition: async () => null }, now: () => NOW } as unknown as WorkflowRunDeps;
    const refusal = await resumeRun(deps, run, [{ namespace: 'eip155', address: OWNER }]).then(() => 'ACCEPTED', (e: Error) => e.message);
    expect(refusal === 'WORKFLOW_RUN_CHANGED', refusal).toBe(expected);
  });
});

describe('review fixes R4/R6: a run\'s note claims nothing it cannot prove', () => {
  it('a partial completion points to the step that stopped, never "nothing later was submitted" (a later group may have been sent and failed on chain)', async () => {
    const view = await runView({ store: storeOf([step(0, 'RECONCILED'), step(1, 'FAILED')], [group({ stepTo: 0, state: 'RECONCILED' }),
      group({ groupIndex: 1, stepFrom: 1, stepTo: 1, state: 'FAILED' })]), now: () => NOW }, runOf('USER_FUNDED', 'HALTED'), { outcomes: true });
    expect(view).toMatchObject({ halted: 'PARTIAL', resumable: false,
      note: 'Partially completed: the reconciled steps stay done and their funds rest in the owner\'s wallet. See the step that stopped for its outcome.' });
    expect(view.note).not.toMatch(/nothing later/i);
  });
  it('a run ended while a batch it handed out was never answered says the batch may have executed; any other ended run says nothing of it', async () => {
    const ended = runOf('USER_FUNDED', 'CANCELLED'), skipped = [step(0, 'SKIPPED'), step(1, 'SKIPPED')];
    const unknown = [group({ state: 'SKIPPED', code: 'WALLET_BATCH_OUTCOME_UNKNOWN', prepared: { kind: 'EVM_WALLET_BATCH' } })];
    for (const owner of [true, false]) expect((await runView({ store: storeOf(skipped, unknown) }, ended, { outcomes: true, owner })).note).toBe('Ended. A batch was handed to '
      + 'the owner\'s wallet and FloFi never recorded an answer for it: it may have executed before its on-chain deadline; check the wallet\'s activity.');
    expect((await runView({ store: storeOf(skipped, unknown) }, ended, { outcomes: false })).note).toBe('The owner has not shared the transactions and evidence of this workflow '
      + 'with this conversation.');
    expect((await runView({ store: storeOf(skipped, [group({ state: 'SKIPPED', code: 'OWNER_CANCELLED' })]) }, ended, { outcomes: true })).note).toBeNull();
  });
});
