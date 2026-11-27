// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 review fix: what a HALTED run's note (owner, MCP, channels) says about it. "Partially completed" only after a reconciled step; "stopped
 * before anything was sent" only when the run's own records prove it; otherwise neither claim (a halted delegated execution, a wallet batch
 * that was handed to the owner's wallet and may have been sent).
 */
import { describe, expect, it } from 'vitest';
import type { GroupRecord, RunRecord, RunStepRecord } from './pg-store.ts';
import { runView } from './service.ts';
import { haltedAs } from './state-machine.ts';

const OWNER = '0x' + '1a'.repeat(20);
const SWAP = { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 };
const halted = (mode: string) => ({ runId: 'wfr_' + 'b'.repeat(26), handoffId: 'apr_' + 'b'.repeat(26), mode, state: 'HALTED', stepCount: 3, currentStep: 0,
  code: 'USER_FUNDED_SIMULATION_UNAVAILABLE', strategy: { version: 2, steps: [SWAP, { ...SWAP, amount: '5' }, { ...SWAP, network: 'arbitrum-one' }] },
  workflowHash: '0x' + '1'.repeat(64), completedAt: null, expiresAt: new Date('2026-11-10T00:00:00Z'), createdAt: new Date('2026-11-09T00:00:00Z'),
  updatedAt: new Date('2026-11-09T00:00:00Z') }) as unknown as RunRecord;
const step = (stepIndex: number, state: string) => ({ runId: 'wfr_' + 'b'.repeat(26), stepIndex, state, flow: null, strategy: null, workflowHash: null, bound: null,
  claimedAt: null, outcome: null, code: null, version: 1, updatedAt: new Date('2026-11-09T00:00:00Z') }) as unknown as RunStepRecord;
const group = (groupIndex: number, stepFrom: number, stepTo: number, patch: Partial<GroupRecord>) => ({ runId: 'wfr_' + 'b'.repeat(26), groupIndex, namespace: 'eip155',
  chain: 'eip155:8453', feePayer: OWNER, stepFrom, stepTo, strategy: 'EVM_WALLET_BATCH', signing: 'WHEN_DUE', awaitsDelivery: null, state: 'PLANNED', code: null,
  validUntil: null, version: 1, prepared: null, authorization: null, submission: null, outcome: null, ...patch }) as unknown as GroupRecord;
const noteOf = async (run: RunRecord, steps: readonly RunStepRecord[], groups: readonly GroupRecord[] = []) =>
  (await runView({ store: { steps: async () => [...steps], groups: async () => [...groups] } }, run, { outcomes: true })).note;
const NOTHING_SENT = 'Stopped before anything was sent. Until the run expires the owner can resume it (each stopped step then runs through its own flow); the owner can always end it.';
const NO_STEP_DONE = 'Stopped before any step completed. FloFi submits nothing more of it; the owner decides what happens next.';

describe('P0 review fix: a HALTED run\'s note never claims progress, or a send, it cannot prove', () => {
  it('first group refused for good before anything was handed out: stopped before anything was sent (a later user operation signed upfront was never relayed)', async () => {
    const run = halted('USER_FUNDED');
    expect(await noteOf(run, [step(0, 'BLOCKED'), step(1, 'BLOCKED'), step(2, 'DELEGATED')],
      [group(0, 0, 1, { state: 'BLOCKED', code: 'USER_FUNDED_SIMULATION_UNAVAILABLE' }), group(1, 2, 2, { strategy: 'EVM_USER_OPERATION', signing: 'UPFRONT',
        state: 'AUTHORIZED', prepared: { kind: 'EVM_USER_OPERATION' }, authorization: { kind: 'EVM_USER_OPERATION' } })])).toBe(NOTHING_SENT);
  });
  it('a wallet batch once handed to the owner\'s wallet may have been sent: neither "nothing was sent" nor "partially completed"', async () => {
    const run = halted('USER_FUNDED');
    const steps = [step(0, 'BLOCKED'), step(1, 'BLOCKED'), step(2, 'DELEGATED')];
    expect(await noteOf(run, steps, [group(0, 0, 1, { state: 'BLOCKED', prepared: { kind: 'EVM_WALLET_BATCH', request: { id: '0x' + 'cd'.repeat(32) } } })])).toBe(NO_STEP_DONE);
    expect(await noteOf(run, steps, [group(0, 0, 1, { state: 'BLOCKED', authorization: { kind: 'EVM_WALLET_BATCH', batchId: '0x' + 'cd'.repeat(32) } })])).toBe(NO_STEP_DONE);
    expect(await noteOf(run, steps, [group(0, 0, 1, { state: 'FAILED' })])).toBe(NO_STEP_DONE);
  });
  it('a halted delegated execution (something irreversible ran in it) is never "nothing was sent"; a reconciled step is a partial completion', async () => {
    expect(await noteOf(halted('DELEGATED'), [step(0, 'BLOCKED'), step(1, 'DELEGATED'), step(2, 'DELEGATED')])).toBe(NO_STEP_DONE);
    expect(await noteOf(halted('CONFIRM_EACH_STEP'), [step(0, 'UNCERTAIN'), step(1, 'PENDING'), step(2, 'PENDING')])).toBe(NO_STEP_DONE);
    expect(await noteOf(halted('USER_FUNDED'), [step(0, 'RECONCILED'), step(1, 'BLOCKED'), step(2, 'DELEGATED')],
      [group(0, 0, 0, { state: 'RECONCILED' }), group(1, 1, 2, { state: 'BLOCKED' })])).toMatch(/^Partially completed: the reconciled steps stay done/);
  });
});

describe('P0 review fix: every surface words a HALTED run from the server\'s own decision', () => {
  const viewOf = async (outcomes: boolean, groups: readonly GroupRecord[]) => runView({ store: { steps: async () => [step(0, 'BLOCKED'), step(1, 'BLOCKED'), step(2, 'DELEGATED')],
    groups: async () => [...groups] } }, halted('USER_FUNDED'), { outcomes });
  it('a requester view hides the batch id and plan, yet still carries STOPPED for a group whose earlier batch was handed to the wallet', async () => {
    const history = group(0, 0, 1, { state: 'BLOCKED', prepared: { kind: 'EVM_WALLET_BATCH', superseded: [{ group: { calls: [] }, fromBlock: null }] } });
    for (const outcomes of [true, false]) {
      const view = await viewOf(outcomes, [history]);
      expect(view.halted, String(outcomes)).toBe('STOPPED');
      // The view alone (no batch id, no plan, BLOCKED) would read as "nothing sent": the server's decision wins.
      expect(haltedAs(view)).toBe('STOPPED');
      expect(haltedAs({ ...view, halted: null })).toBe('NOTHING_SENT');
    }
    expect((await viewOf(true, [group(0, 0, 1, { state: 'BLOCKED', code: 'USER_FUNDED_SIMULATION_UNAVAILABLE' })])).halted).toBe('NOTHING_SENT');
  });
  it('a run that is not HALTED carries no halted kind', async () => {
    const view = await runView({ store: { steps: async () => [step(0, 'DELEGATED')], groups: async () => [] } }, { ...halted('USER_FUNDED'), state: 'RUNNING' } as RunRecord, { outcomes: true });
    expect(view.halted).toBeNull();
  });
});

describe('round 4 F1: a run halted while a wallet batch it handed out was never answered says that batch may have executed', () => {
  const MAY_HAVE_EXECUTED = 'A batch was handed to the owner\'s wallet and FloFi never recorded an answer for it: it may have executed before its on-chain '
    + 'deadline; check the wallet\'s activity.';
  const unknownStep = (stepIndex: number) => ({ ...step(stepIndex, 'BLOCKED'), code: 'WALLET_BATCH_OUTCOME_UNKNOWN' }) as RunStepRecord;
  const unknownGroup = (groupIndex: number, stepFrom: number, stepTo: number) => group(groupIndex, stepFrom, stepTo, { state: 'BLOCKED', code: 'WALLET_BATCH_OUTCOME_UNKNOWN',
    prepared: { kind: 'EVM_WALLET_BATCH', request: { id: '0x' + 'cd'.repeat(32) } } });
  const expiredRun = { ...halted('USER_FUNDED'), code: 'WORKFLOW_RUN_EXPIRED' } as RunRecord;
  const viewOf = (steps: readonly RunStepRecord[], groups: readonly GroupRecord[], outcomes = true, run = expiredRun) =>
    runView({ store: { steps: async () => [...steps], groups: async () => [...groups] } }, run, { outcomes });

  it('nothing reconciled: STOPPED, and the note says the batch may have executed — never "stopped before any step completed" or "nothing was sent"', async () => {
    const view = await viewOf([unknownStep(0), unknownStep(1), step(2, 'DELEGATED')], [unknownGroup(0, 0, 1), group(1, 2, 2, {})]);
    expect(view).toMatchObject({ halted: 'STOPPED', note: `Stopped. ${MAY_HAVE_EXECUTED} FloFi submits nothing more of it; the owner decides what happens next.` });
    expect(view.note).not.toMatch(/before any step completed|nothing was sent|before anything was sent/i);
    expect(haltedAs(view)).toBe('STOPPED');
  });
  it('after a reconciled step: a partial completion that still says the later batch may have executed (its funds may have moved)', async () => {
    const view = await viewOf([step(0, 'RECONCILED'), unknownStep(1), unknownStep(2)], [group(0, 0, 0, { state: 'RECONCILED' }), unknownGroup(1, 1, 2)]);
    expect(view).toMatchObject({ halted: 'PARTIAL',
      note: `Partially completed: the reconciled steps stay done. ${MAY_HAVE_EXECUTED} FloFi submits nothing more of it; the owner decides what happens next.` });
    expect(view.note).not.toMatch(/funds rest in the owner's wallet/);
  });
  it('the code on the steps alone is enough (fail closed); a requester the owner did not share status with still sees only the consent note', async () => {
    expect((await viewOf([unknownStep(0), unknownStep(1), step(2, 'DELEGATED')], [group(0, 0, 1, { state: 'BLOCKED', prepared: { kind: 'EVM_WALLET_BATCH' } })])).note)
      .toBe(`Stopped. ${MAY_HAVE_EXECUTED} FloFi submits nothing more of it; the owner decides what happens next.`);
    expect((await viewOf([unknownStep(0), unknownStep(1), step(2, 'DELEGATED')], [unknownGroup(0, 0, 1)], false)).note)
      .toBe('The owner has not shared the transactions and evidence of this workflow with this conversation.');
  });
  it('a run stopped at its expiry before any batch was handed out never says "may have executed"', async () => {
    const plain = await viewOf([step(0, 'BLOCKED'), step(1, 'BLOCKED'), step(2, 'DELEGATED')], [group(0, 0, 1, { state: 'BLOCKED', code: 'WORKFLOW_RUN_EXPIRED' })]);
    expect(plain).toMatchObject({ halted: 'NOTHING_SENT' });
    expect(plain.note).not.toContain('may have executed');
  });
});

describe('KAN-20 (C.4): a Solana Batch Payment stopped because an earlier request landed, or can never be proven not to have, may have paid every recipient', () => {
  const MAY_HAVE_EXECUTED = 'A batch was handed to the owner\'s wallet and FloFi never recorded an answer for it: it may have executed before its on-chain '
    + 'deadline; check the wallet\'s activity.';
  const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', SOL_OWNER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', SIGNATURE = '5' + '1'.repeat(87);
  const PAY = { action: 'batch_payment', network: 'solana', asset: 'SOL', recipients: [{ recipient: SOL_OWNER, amount: '0.01' }] };
  const batchRun = (state: string, code: string) => ({ ...halted('USER_FUNDED'), state, code, stepCount: 3, strategy: PAY }) as unknown as RunRecord;
  const batchGroup = (patch: Partial<GroupRecord>) => group(0, 0, 2, { namespace: 'solana', chain: SOLANA, feePayer: SOL_OWNER, strategy: 'SOLANA_SIGN_ALL', signing: 'UPFRONT',
    state: 'BLOCKED', prepared: { kind: 'SOLANA_SIGN_ALL', atomic: true }, ...patch });
  const legs = (state: string, code: string) => [0, 1, 2].map(i => ({ ...step(i, state), code }) as RunStepRecord);
  const viewOf = (run: RunRecord, steps: readonly RunStepRecord[], groups: readonly GroupRecord[], outcomes = true) =>
    runView({ store: { steps: async () => [...steps], groups: async () => [...groups] } }, run, { outcomes });
  const STOPPED = `Stopped. ${MAY_HAVE_EXECUTED} FloFi submits nothing more of it; the owner decides what happens next.`;

  it('HALTED: never "stopped before any step completed" — the batch may have executed (LANDED, with its signature kept, and UNPROVABLE alike)', async () => {
    for (const [code, outcome] of [['BATCH_PAYMENT_EARLIER_REQUEST_LANDED', { earlierRequest: { settlement: 'LANDED', signature: SIGNATURE } }],
      ['BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE', { earlierRequest: { settlement: 'UNPROVABLE' } }]] as const) {
      const view = await viewOf(batchRun('HALTED', code), legs('BLOCKED', code), [batchGroup({ code, outcome })]);
      expect(view, code).toMatchObject({ halted: 'STOPPED', resumable: false, note: STOPPED });
      expect(view.note).not.toMatch(/before any step completed|nothing was sent|before anything was sent/i);
      // The code alone is enough (a group blocked before its outcome was kept); a requester the owner did not share status with sees only the consent note.
      expect((await viewOf(batchRun('HALTED', code), legs('BLOCKED', code), [batchGroup({ code })])).note, code).toBe(STOPPED);
      expect((await viewOf(batchRun('HALTED', code), legs('BLOCKED', code), [batchGroup({ code, outcome })], false)).note)
        .toBe('The owner has not shared the transactions and evidence of this workflow with this conversation.');
    }
  });
  it('after End (the group and legs SKIPPED, their code rewritten): its kept outcome still says it may have executed', async () => {
    const view = await viewOf(batchRun('CANCELLED', 'OWNER_CANCELLED'), legs('SKIPPED', 'OWNER_CANCELLED'),
      [batchGroup({ state: 'SKIPPED', code: 'OWNER_CANCELLED', outcome: { earlierRequest: { settlement: 'LANDED', signature: SIGNATURE } } })]);
    expect(view).toMatchObject({ halted: null, note: `Ended. ${MAY_HAVE_EXECUTED}` });
    // An ordinary ended batch (nothing handed out that may have landed) says nothing of the kind.
    expect((await viewOf(batchRun('CANCELLED', 'OWNER_CANCELLED'), legs('SKIPPED', 'OWNER_CANCELLED'), [batchGroup({ state: 'SKIPPED', code: 'OWNER_CANCELLED' })])).note).toBeNull();
  });
  it('a Solana batch halted for another reason keeps its own wording', async () => {
    const view = await viewOf(batchRun('HALTED', 'SOLANA_BATCH_PAYMENT_COMPUTE_LIMIT_EXCEEDED'), legs('BLOCKED', 'SOLANA_BATCH_PAYMENT_COMPUTE_LIMIT_EXCEEDED'),
      [batchGroup({ code: 'SOLANA_BATCH_PAYMENT_COMPUTE_LIMIT_EXCEEDED', prepared: null })]);
    expect(view.note).not.toContain('may have executed');
  });
});
