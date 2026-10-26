// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness';
import { workflowRunHarness } from './workflow-run.test-harness';
import { ensureForClaim, cancelRun, startConfirm } from './service';
import { claimApproval, workflowRunCancel } from '../platform/index';
import { canEndWorkflow } from './state-machine';
const strategy = { version: 2, steps: [
  { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 100 },
  { action: 'swap', network: 'solana-devnet', inputAsset: 'devUSDC', outputAsset: 'SOL', amount: '5', slippageBps: 100 },
] };
async function setup() {
  const t = await createTestDatabase(), h = await workflowRunHarness(t.db), approval = await h.request(strategy);
  const handoff = (await h.handoffs.forRequester(approval.approvalId, { kind: 'CHANNEL_CONVERSATION', ref: h.requester.ref }, h.d.now()))!;
  const run = await ensureForClaim(h.runs, handoff, approval.composed, [h.evm, h.sol]);
  return { t, h, approval, run };
}
describe('workflow cancellation (atomic, PostgreSQL)', () => {
  it('ends PENDING once, rejects stale versions and wallet mismatches, and skips only unsubmitted steps', async () => {
    const { t, h, run } = await setup();
    try {
      await expect(cancelRun(h.runs, run, [h.evm])).rejects.toThrow('SOLANA_WALLET_PROOF_REQUIRED');
      await expect(cancelRun(h.runs, run, [{ ...h.evm, address: '0x' + '9'.repeat(40) }, h.sol])).rejects.toThrow('WORKFLOW_RUN_OWNER_MISMATCH');
      const attempts = await Promise.allSettled([cancelRun(h.runs, run, [h.evm, h.sol]), cancelRun(h.runs, run, [h.evm, h.sol])]);
      expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['SKIPPED', 'SKIPPED']);
      expect((await h.store.events(run.runId)).filter(e => e.kind === 'RUN_CANCELLED')).toHaveLength(1);
    } finally { await t.drop(); }
  });
  it('serializes cancellation against loading: either cancelled with skipped work, or awaiting owner and refused', async () => {
    const { t, h, run } = await setup();
    try {
      const running = await startConfirm(h.runs, run, [h.evm, h.sol]);
      await Promise.allSettled([h.store.stepTransition(run.runId, 0, ['READY'], 'AWAITING_OWNER', { claimedAt: h.d.now() }), cancelRun(h.runs, running, [h.evm, h.sol])]);
      const fresh = (await h.store.byId(run.runId))!, steps = await h.store.steps(run.runId);
      if (fresh.state === 'CANCELLED') {
        expect(steps.map(s => s.state)).toEqual(['SKIPPED', 'SKIPPED']);
        expect(await h.store.stepTransition(run.runId, 0, ['READY'], 'AWAITING_OWNER', {})).toBeNull();
      } else { expect(fresh.state).toBe('RUNNING'); expect(steps[0]!.state).toBe('AWAITING_OWNER'); }
    } finally { await t.drop(); }
  });
  it('ends a partially completed RUNNING workflow without losing reconciled evidence or transactions', async () => {
    const { t, h, approval } = await setup();
    try {
      const claimed = await claimApproval(h.surface, approval.secret, [h.evm, h.sol], true, h.d.now());
      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, claimed.workflow, 'RECONCILED');
      const run = (await h.store.byHandoff(approval.approvalId))!;
      await h.drain(run.runId);
      const before = (await h.store.steps(run.runId))[0]!;
      const result = await workflowRunCancel(h.surface, approval.approvalId, [h.evm, h.sol]);
      expect(result.view.workflowRun!.run.state).toBe('CANCELLED');
      expect((await h.store.steps(run.runId))[0]).toEqual(before);
      expect((await h.store.steps(run.runId))[1]!.state).toBe('SKIPPED');
    } finally { await t.drop(); }
  });
  it('never cancels uncertain, awaiting-owner or delegated work, even if the run is HALTED', async () => {
    for (const stepState of ['AWAITING_OWNER', 'UNCERTAIN'] as const) {
      const { t, h, run } = await setup();
      try {
        let fresh = await startConfirm(h.runs, run, [h.evm, h.sol]);
        await h.store.stepTransition(run.runId, 0, ['READY'], 'AWAITING_OWNER', { claimedAt: h.d.now() });
        if (stepState === 'UNCERTAIN') await h.store.stepTransition(run.runId, 0, ['AWAITING_OWNER'], 'UNCERTAIN', {});
        fresh = (await h.store.transition(run.runId, { version: fresh.version, from: ['RUNNING'] }, 'HALTED', {}))!;
        await expect(cancelRun(h.runs, fresh, [h.evm, h.sol])).rejects.toThrow('WORKFLOW_RUN_STEP_IN_FLIGHT');
        expect((await h.store.byId(run.runId))!.state).toBe('HALTED');
      } finally { await t.drop(); }
    }
  });
  it('the UI eligibility excludes all terminal states and treats revocation separately', () => {
    for (const state of ['PENDING', 'RUNNING', 'HALTED']) expect(canEndWorkflow({ state, mode: null }, [{ state: 'RECONCILED' }, { state: 'PENDING' }])).toBe(true);
    for (const state of ['ATTENTION', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']) expect(canEndWorkflow({ state, mode: null }, [])).toBe(false);
    expect(canEndWorkflow({ state: 'RUNNING', mode: 'DELEGATED' }, [])).toBe(false);
  });
});
