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
