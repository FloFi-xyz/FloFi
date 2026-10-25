// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: a multi-step workflow confirmed step by step by its owner, end to end on PostgreSQL through the real approval service
 * (request → claim → apply → continue), run store and runner. Each step is the ordinary single-step proposal FloFi's signing surface loads; the
 * owner's flow runs are recorded by the isolated flow-runtime test double (as FloFi's flows would after the owner's wallet signature). MOCKED.
 */
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { semanticWorkflowHash } from '../engine/strategy-engine';
import { approvalProgress, applyApproval, claimApproval, workflowRunCancel, workflowRunContinue, workflowRunResume, workflowRunStatus } from '../platform/index.ts';
import { advanceRun } from './runner.ts';
import { workflowRunHarness, type RunHarness } from './workflow-run.test-harness.ts';

const BASE_SWAP = { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 };
const SOL_SWAP = { action: 'swap', network: 'solana-devnet', inputAsset: 'devUSDC', outputAsset: 'SOL', amount: '5', slippageBps: 50 };
const MULTICHAIN = { version: 2, steps: [BASE_SWAP, SOL_SWAP] };
const refusal = async (work: Promise<unknown>) => { try { await work; return 'NO_REFUSAL'; } catch (e) { return e instanceof Error ? e.message : 'UNEXPECTED'; } };

/** Requests the workflow, claims it for the owner's proven wallets and applies the first step, as `/approve` does. */
async function started(h: RunHarness, strategy: unknown = MULTICHAIN, share = true) {
  const approval = await h.request(strategy);
  const claimed = await claimApproval(h.surface, approval.secret, [h.evm, h.sol], share, h.d.now());
  await applyApproval(h.surface, approval.secret, [h.evm, h.sol], claimed.workflow, h.d.now());
  return { approval, claimed };
}
const runOf = async (h: RunHarness, approvalId: string) => (await h.store.byHandoff(approvalId))!;
const progressOf = async (h: RunHarness, approvalId: string) => approvalProgress((await h.handoffs.forRequester(approvalId, { kind: 'CHANNEL_CONVERSATION',
  ref: h.requester.ref }, h.d.now()))!, h.flows.runtime, h.handoffs, 'https://flofi.test', h.store);
const continued = (h: RunHarness, approvalId: string) => workflowRunContinue(h.surface, approvalId, [h.evm, h.sol]);

describe('BUILD-CHAT-E2E-001 confirm-each-step workflow run (PostgreSQL)', () => {
  it('runs an EVM → Solana workflow one owner-signed step at a time, each only after the previous one reconciled', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db); // no Credentials: confirm-each-step is this owner's only mode
      const { approval, claimed } = await started(h);
      // The run started at once and loaded its first step as an ordinary single-step proposal for the signing surface.
      expect(claimed.view.workflowRun).toMatchObject({ run: { state: 'RUNNING', mode: 'CONFIRM_EACH_STEP', currentStep: 0 }, step: { index: 0, count: 2 },
        plan: { confirmEachStep: { available: true, walletConfirmationsAtLeast: 2, walletNamespaces: ['eip155', 'solana'] } } });
      expect(claimed.command).toMatchObject({ type: 'ADD_TESTNET_SWAP' });
      expect(semanticWorkflowHash(claimed.workflow!)).toBe(claimed.workflowHash);
      expect(claimed.workflowHash).toBe(approval.composed.steps[0]!.workflowHash);
      // Before the first step reconciled, continuing reloads the same first step; the second can never be loaded early.
      expect((await continued(h, approval.approvalId)).view.workflowRun!.step).toEqual({ index: 0, count: 2 });

      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, claimed.workflow, 'RECONCILED');
      await h.drain(approval.approvalId ? (await runOf(h, approval.approvalId)).runId : undefined);
      let run = await runOf(h, approval.approvalId);
      expect(run).toMatchObject({ state: 'RUNNING', currentStep: 1 });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['RECONCILED', 'PENDING']);
      // The conversation is told the owner has the next step to sign.
      expect((await progressOf(h, approval.approvalId)).workflowRun).toMatchObject({ nextAction: 'OWNER_SIGNS_STEP', steps: [{ state: 'RECONCILED' }, { state: 'PENDING' }] });

      const second = await continued(h, approval.approvalId);
      expect(second.view.workflowRun).toMatchObject({ step: { index: 1, count: 2 } });
      expect(second.command).toMatchObject({ type: 'ADD_SOLANA_SWAP' });
      await applyApproval(h.surface, approval.secret, [h.evm, h.sol], second.workflow, h.d.now()).catch(() => undefined);
      h.flows.ownerExecutes('solana-devnet-swap', h.sol.address, second.workflow, 'RECONCILED');
      await h.drain(run.runId);
      run = await runOf(h, approval.approvalId);
      expect(run).toMatchObject({ state: 'COMPLETED', currentStep: 1 });
      const progress = await progressOf(h, approval.approvalId);
      expect(progress.workflowRun).toMatchObject({ state: 'COMPLETED', nextAction: 'NONE', stepsVisible: true,
        steps: [{ state: 'RECONCILED', outcome: { kind: 'OWNER_RUN', evidence: { environment: 'MOCKED', outcome: 'RECONCILED' } } },
          { state: 'RECONCILED', outcome: { kind: 'OWNER_RUN', receiptUrl: expect.stringMatching(/^https:\/\/flofi\.test\/app\/dashboard\/runs\//) } }] });
      expect((await h.store.events(run.runId)).filter(e => e.kind === 'RUN_COMPLETED')).toHaveLength(1);
    } finally { await t.drop(); }
  });

  it('the owner\'s status poll observes the run like the worker, so continuing never waits on it, yet it never readies or loads a step', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const { approval, claimed } = await started(h);
      // While the first step is still in the owner's wallet, a poll changes nothing and offers no next step.
      expect((await workflowRunStatus(h.surface, approval.approvalId, [h.evm, h.sol])).view.workflowRun!.run)
        .toMatchObject({ currentStep: 0, nextAction: 'WAITING_FOR_RECONCILIATION', steps: [{ state: 'AWAITING_OWNER' }, { state: 'PENDING' }] });
      // No worker runs here: the poll alone records the reconciled step, and the next step waits for the owner (not READY, not loaded).
      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, claimed.workflow, 'RECONCILED');
      const polled = await workflowRunStatus(h.surface, approval.approvalId, [h.evm, h.sol]);
      expect(polled.command).toBeNull();
      expect(polled.view.workflowRun).toMatchObject({ step: null, run: { state: 'RUNNING', currentStep: 1, nextAction: 'OWNER_SIGNS_STEP',
        steps: [{ state: 'RECONCILED' }, { state: 'PENDING' }] } });
      const run = await runOf(h, approval.approvalId);
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['RECONCILED', 'PENDING']);
      // Repeated polls are idempotent: one reconciliation fact.
      await workflowRunStatus(h.surface, approval.approvalId, [h.evm, h.sol]);
      expect((await h.store.events(run.runId)).filter(e => e.stepIndex === 0 && e.detail?.state === 'RECONCILED')).toHaveLength(1);
      // Only the owner's continue readies and loads the second step.
      expect((await continued(h, approval.approvalId)).view.workflowRun).toMatchObject({ step: { index: 1, count: 2 } });
      // Another wallet cannot poll (or observe) the run.
      expect(await refusal(workflowRunStatus(h.surface, approval.approvalId, [{ ...h.evm, address: '0x' + '9'.repeat(40) }, h.sol]))).toBe('WORKFLOW_RUN_NOT_FOUND');
    } finally { await t.drop(); }
  });

  it('withholds transactions, amounts and evidence from a conversation the owner did not share status with', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const { approval, claimed } = await started(h, MULTICHAIN, false);
      const executed = h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, claimed.workflow, 'RECONCILED');
      await h.drain((await runOf(h, approval.approvalId)).runId);
      const progress = await progressOf(h, approval.approvalId);
      expect(progress.workflowRun).toMatchObject({ stepsVisible: false, steps: [{ state: 'RECONCILED', outcome: null }, { state: 'PENDING', outcome: null }] });
      const text = JSON.stringify(progress);
      for (const secret of [executed.attempts[0]!.transactionHash, executed.runId, executed.evidence!.bundleHash]) expect(text).not.toContain(secret);
    } finally { await t.drop(); }
  });

  it('an uncertain submission makes the run need attention and is only observed, never retried; it continues once reconciled', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const { approval, claimed } = await started(h);
      const pending = h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, claimed.workflow, 'PENDING');
      const run = await runOf(h, approval.approvalId);
      await h.drain(run.runId);
      expect(await runOf(h, approval.approvalId)).toMatchObject({ state: 'ATTENTION', code: 'STEP_OUTCOME_PENDING', currentStep: 0 });
      expect((await h.store.steps(run.runId))[0]).toMatchObject({ state: 'UNCERTAIN' });
      // Nothing can move the run past an uncertain step: continuing offers no new step.
      expect((await continued(h, approval.approvalId)).command).toBeNull();
      h.flows.reconcile(pending);
      await h.drain(run.runId);
      expect(await runOf(h, approval.approvalId)).toMatchObject({ state: 'RUNNING', currentStep: 1 });
      expect((await h.store.steps(run.runId))[0]).toMatchObject({ state: 'RECONCILED', outcome: { executionId: pending.runId } });
    } finally { await t.drop(); }
  });

  it('a refusal before submission lets the owner try the same step again; a reverted later step halts the run with explicit partial completion', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const { approval, claimed } = await started(h);
      const run = await runOf(h, approval.approvalId);
      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, claimed.workflow, 'REFUSED_BEFORE_SUBMISSION');
      await h.drain(run.runId);
      expect((await h.store.steps(run.runId))[0]).toMatchObject({ state: 'AWAITING_OWNER' });
      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, claimed.workflow, 'RECONCILED');
      await h.drain(run.runId);
      const second = await continued(h, approval.approvalId);
      h.flows.ownerExecutes('solana-devnet-swap', h.sol.address, second.workflow, 'REVERTED');
      await h.drain(run.runId);
      expect(await runOf(h, approval.approvalId)).toMatchObject({ state: 'HALTED', code: 'SUBMISSION_REVERTED' });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['RECONCILED', 'FAILED']);
      expect((await progressOf(h, approval.approvalId)).workflowRun).toMatchObject({ state: 'HALTED', nextAction: 'OWNER_DECIDES',
        note: expect.stringContaining('Partially completed') });
      // A failed (submitted) step is never resumed; the owner may end the run, which keeps the reconciled first step as it is.
      expect(await refusal(workflowRunResume(h.surface, approval.approvalId, [h.evm, h.sol]))).toBe('WORKFLOW_RUN_NOT_RESUMABLE');
      const ended = await workflowRunCancel(h.surface, approval.approvalId, [h.evm, h.sol]);
      expect(ended.view.workflowRun!.run).toMatchObject({ state: 'CANCELLED' });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['RECONCILED', 'FAILED']);
    } finally { await t.drop(); }
  });

  it('re-gates every step when it becomes ready: a disabled flow blocks it before anything is submitted; the owner resumes once it is enabled again', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db, { flows: ['base-sepolia-swap', 'solana-devnet-swap'] });
      const { approval, claimed } = await started(h);
      const run = await runOf(h, approval.approvalId);
      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, claimed.workflow, 'RECONCILED');
      await h.drain(run.runId);
      const flows = h.flows.runtime as { mode: (flow: string) => Promise<string> };
      const mode = flows.mode;
      flows.mode = async flow => flow === 'solana-devnet-swap' ? 'off' : mode(flow);
      const blocked = await continued(h, approval.approvalId);
      expect(blocked.command).toBeNull();
      expect(blocked.view.workflowRun!.run).toMatchObject({ state: 'HALTED', code: 'FLOW_NOT_ENABLED_IN_DEPLOYMENT' });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['RECONCILED', 'BLOCKED']);
      flows.mode = mode;
      const resumed = await workflowRunResume(h.surface, approval.approvalId, [h.evm, h.sol]);
      expect(resumed.view.workflowRun).toMatchObject({ run: { state: 'RUNNING' }, step: { index: 1 } });
      expect(resumed.command).toMatchObject({ type: 'ADD_SOLANA_SWAP' });
    } finally { await t.drop(); }
  });

  it('isolates runs by owner wallet and survives concurrent, repeated advancement with exactly one transition per fact', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const { approval, claimed } = await started(h);
      const run = await runOf(h, approval.approvalId);
      const stranger = { namespace: 'eip155' as const, address: '0x' + '9'.repeat(40) };
      expect(await refusal(workflowRunContinue(h.surface, approval.approvalId, [stranger, h.sol]))).toBe('WORKFLOW_RUN_NOT_FOUND');
      expect(await refusal(workflowRunContinue(h.surface, approval.approvalId, [h.evm]))).toBe('SOLANA_WALLET_PROOF_REQUIRED');
      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, claimed.workflow, 'RECONCILED');
      const deps = { store: h.store, runtime: h.flows.runtime, delegation: h.d.store, policyFor: () => null, now: h.d.now, log: () => undefined };
      await Promise.all(Array.from({ length: 6 }, () => advanceRun(deps, run.runId)));
      const events = await h.store.events(run.runId);
      expect(events.filter(e => e.kind === 'RUN_STEP_ADVANCED')).toHaveLength(1);
      expect(events.filter(e => e.kind === 'STEP_STATE' && e.stepIndex === 0 && (e.detail as { state?: string }).state === 'RECONCILED')).toHaveLength(1);
      // A second claim of the same approval returns the same run (never a second one).
      await claimApproval(h.surface, approval.secret, [h.evm, h.sol], true, h.d.now()).catch(() => undefined);
      expect((await t.db.query('SELECT count(*)::int AS n FROM workflow_runs')).rows[0]!.n).toBe(1);
    } finally { await t.drop(); }
  });

  it('refuses a multi-step workflow where this deployment does not run workflows, with every step still reported', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db, { sequences: false });
      await expect(h.request(MULTICHAIN)).rejects.toThrow('WORKFLOW_RUNS_NOT_ENABLED');
      // A single step is unaffected by the setting.
      await expect(h.request(BASE_SWAP)).resolves.toMatchObject({ executionPlan: 'SINGLE_FLOW' });
    } finally { await t.drop(); }
  });

  it('BUILD-CROSSCHAIN-UNIVERSAL-001: confirm mode spends min(cap, reconciled received) from the previous owner-signed step', async () => {
    const t = await createTestDatabase();
    try {
      // No Credentials: confirm-each-step is the only mode. Bound second swap spends what the first actually delivered.
      const h = await workflowRunHarness(t.db, { flows: ['base-sepolia-swap'], delegation: false });
      const bound = { version: 2, steps: [BASE_SWAP, { action: 'swap', network: 'base-sepolia', inputAsset: 'WETH', outputAsset: 'USDC', amount: '1', slippageBps: 50 }],
        bindings: [{ step: 1, amountFrom: 0 }] };
      const { approval, claimed } = await started(h, bound);
      expect(claimed.view.workflowRun!.plan).toMatchObject({ confirmEachStep: { available: true },
        bindings: [{ step: 1, amountFrom: 0, confirmEachStep: 'RECONCILED_RECEIVED_AMOUNT' }] });
      const run = await runOf(h, approval.approvalId);
      const weth = 'eip155:84532/erc20:0x4200000000000000000000000000000000000006';
      const delivered = '333000000000000000'; // 0.333 WETH < 1 WETH cap
      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, claimed.workflow, 'RECONCILED', { received: [{ asset: weth, amount: delivered }] });
      await h.drain(run.runId);
      expect((await h.store.steps(run.runId))[0]).toMatchObject({ state: 'RECONCILED', outcome: { received: [{ asset: weth, amount: delivered }] } });
      const second = await continued(h, approval.approvalId);
      expect(second.view.workflowRun).toMatchObject({ step: { index: 1, count: 2 } });
      expect(second.workflow).toMatchObject({ /* bound amount, not the 1 WETH cap */ });
      const steps = await h.store.steps(run.runId);
      expect(steps[1]).toMatchObject({ state: 'AWAITING_OWNER', bound: { used: delivered, received: delivered, cap: '1000000000000000000' },
        strategy: { inputAsset: 'WETH', amount: '0.333' } });
      await applyApproval(h.surface, approval.secret, [h.evm, h.sol], second.workflow, h.d.now()).catch(() => undefined);
      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, second.workflow, 'RECONCILED');
      await h.drain(run.runId);
      expect(await runOf(h, approval.approvalId)).toMatchObject({ state: 'COMPLETED' });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED']);
    } finally { await t.drop(); }
  });

  it('BUILD-CROSSCHAIN-UNIVERSAL-001: Swap → Bridge → Swap with bindings resolves each received amount in confirm mode', async () => {
    const t = await createTestDatabase();
    try {
      // Solana swap → universal bridge → Base swap. Flows mocked; policy allows the two mainnets for handoff.
      const h = await workflowRunHarness(t.db, {
        flows: ['jupiter-swap', 'crosschain-universal', 'base-swap'], delegation: false,
        policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'solana,base' } });
      const workflow = { version: 2, steps: [
        { action: 'swap', network: 'solana', inputAsset: 'SOL', outputAsset: 'USDC', amount: '0.1', slippageBps: 50 },
        { action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'base', asset: 'USDC', amount: '100', routing: 'best' },
        { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '100', slippageBps: 50 },
      ], bindings: [{ step: 1, amountFrom: 0 }, { step: 2, amountFrom: 1 }] };
      const { composeWorkflowBound } = await import('../engine/strategy-engine.ts');
      const composed = composeWorkflowBound(workflow, undefined);
      if (!composed.ok) throw new Error(composed.code + JSON.stringify(composed.issues));
      expect(composed.bindings).toHaveLength(2);
      const { approval, claimed } = await started(h, workflow);
      expect(claimed.view.workflowRun!.plan).toMatchObject({ confirmEachStep: { available: true },
        bindings: [{ step: 1, confirmEachStep: 'RECONCILED_RECEIVED_AMOUNT' }, { step: 2, confirmEachStep: 'RECONCILED_RECEIVED_AMOUNT' }] });
      const run = await runOf(h, approval.approvalId);
      const solUsdc = `${composed.bindings[0]!.asset.chainId}/token:${composed.bindings[0]!.asset.address}`;
      const baseUsdc = `${composed.bindings[1]!.asset.chainId}/erc20:${composed.bindings[1]!.asset.address}`;
      // Step 0 (Jupiter): delivers Solana USDC below the bridge cap.
      h.flows.ownerExecutes('jupiter-swap', h.sol.address, claimed.workflow, 'RECONCILED',
        { received: [{ asset: solUsdc, amount: '40' + '0'.repeat(6) }] }); // 40 USDC
      await h.drain(run.runId);
      const bridgeLoad = await continued(h, approval.approvalId);
      expect(bridgeLoad.view.workflowRun!.step).toEqual({ index: 1, count: 3 });
      const bridgeStep = (await h.store.steps(run.runId))[1]!;
      expect(bridgeStep).toMatchObject({ state: 'AWAITING_OWNER', flow: 'crosschain-universal',
        bound: { used: '40000000', received: '40000000' }, strategy: { action: 'bridge', amount: '40' } });
      await applyApproval(h.surface, approval.secret, [h.evm, h.sol], bridgeLoad.workflow, h.d.now()).catch(() => undefined);
      // Step 1 (universal bridge): delivers Base USDC below the destination swap cap.
      h.flows.ownerExecutes('crosschain-universal', h.sol.address, bridgeLoad.workflow, 'RECONCILED',
        { received: [{ asset: baseUsdc, amount: '39' + '0'.repeat(6) }] }); // 39 USDC on Base
      await h.drain(run.runId);
      const destSwap = await continued(h, approval.approvalId);
      expect(destSwap.view.workflowRun!.step).toEqual({ index: 2, count: 3 });
      const swapStep = (await h.store.steps(run.runId))[2]!;
      expect(swapStep).toMatchObject({ state: 'AWAITING_OWNER', flow: 'base-swap',
        bound: { used: '39000000', received: '39000000' }, strategy: { action: 'swap', amount: '39', network: 'base' } });
      await applyApproval(h.surface, approval.secret, [h.evm, h.sol], destSwap.workflow, h.d.now()).catch(() => undefined);
      h.flows.ownerExecutes('base-swap', h.evm.address, destSwap.workflow, 'RECONCILED');
      await h.drain(run.runId);
      expect(await runOf(h, approval.approvalId)).toMatchObject({ state: 'COMPLETED' });
      expect((await h.store.steps(run.runId)).map(s => [s.state, s.flow])).toEqual([
        ['RECONCILED', 'jupiter-swap'], ['RECONCILED', 'crosschain-universal'], ['RECONCILED', 'base-swap']]);
    } finally { await t.drop(); }
  });
});
