// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: a multi-step workflow confirmed step by step by its owner, end to end on PostgreSQL through the real approval service
 * (request → claim → apply → continue), run store and runner. Each step is the ordinary single-step proposal FloFi's signing surface loads; the
 * owner's flow runs are recorded by the isolated flow-runtime test double (as FloFi's flows would after the owner's wallet signature). MOCKED.
 */
import { randomBytes } from 'node:crypto';
import { createLogger } from '@defi-workflow-engine/cloud-runtime';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createBackend } from '../../backend/app.ts';
import { createPgDeveloperStore } from '../developer/pg-store.ts';
import { validateSavedWorkflow } from '../domain/saved-workflow';
import { composeWorkflowBound, semanticWorkflowHash } from '../engine/strategy-engine';
import { ENGINE_VERSION, workflowPlan } from '../mcp/execution.ts';
import { approvalLinkScheme, approvalProgress, applyApproval, assembleApprovalSurface, claimApproval, requestApproval, typedId,
  workflowRunCancel, workflowRunContinue, workflowRunResume, workflowRunStatus } from '../platform/index.ts';
import { advanceRun } from './runner.ts';
import { loadedOwnerStepDeliveryRefusal } from './external-step.ts';
import { baseAsset, baseCatalog } from '../server/base-mainnet.test-harness';
import { createDurablePublicTestnetService } from '../server/public-testnet-service';
import { createRobinhoodMockChain, mockCatalogRuntime } from '../server/robinhood-mainnet.test-harness';
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
  it('conserves one producer delivery across multiple bound consumers after restart', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db, { flows: ['base-sepolia-swap'], delegation: false });
      const consumer = { ...BASE_SWAP, inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.004' };
      const strategy = { version: 2, steps: [BASE_SWAP, consumer, consumer], bindings: [{ step: 1, amountFrom: 0 }, { step: 2, amountFrom: 0 }] };
      const { approval, claimed } = await started(h, strategy);
      const run = await runOf(h, approval.approvalId);
      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, claimed.workflow, 'RECONCILED',
        { received: [{ asset: 'eip155:84532/erc20:0x4200000000000000000000000000000000000006', amount: '6000000000000000' }] });
      await h.drain(run.runId);
      const second = await continued(h, approval.approvalId);
      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, second.workflow, 'RECONCILED',
        { spent: [{ asset: 'eip155:84532/erc20:0x4200000000000000000000000000000000000006', amount: '4000000000000000' }] });
      await h.drain(run.runId);
      await continued(h, approval.approvalId);
      expect((await h.store.steps(run.runId))[2]).toMatchObject({ strategy: { amount: '0.002' }, bound: { used: '2000000000000000' } });
    } finally { await t.drop(); }
  });
  it('runs a mainnet swap then a token-funded liquidity position with a fresh canonical Review after reconciliation', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db, { flows: ['base-swap', 'base-liquidity'], delegation: false,
        policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base' } });
      const strategy = { version: 2, steps: [{ ...BASE_SWAP, network: 'base' },
        { action: 'add_liquidity', network: 'base', maxAmounts: { USDC: '5', WETH: '0.01' }, range: { unit: 'full' }, slippageBps: 100 }],
        bindings: [{ step: 1, amountFrom: 0 }] };
      const { approval, claimed } = await started(h, strategy);
      const run = await runOf(h, approval.approvalId);
      expect((await continued(h, approval.approvalId)).view.workflowRun!.step!.index).toBe(0);
      // This is durable mocked observation evidence, never a public transaction.
      h.flows.ownerExecutes('base-swap', h.evm.address, claimed.workflow, 'RECONCILED',
        { received: [{ asset: 'eip155:8453/erc20:0x4200000000000000000000000000000000000006', amount: '4000000000000000' }] });
      await h.drain(run.runId);
      const second = await continued(h, approval.approvalId);
      const step = (await h.store.steps(run.runId))[1]!;
      expect(step).toMatchObject({ state: 'AWAITING_OWNER', flow: 'base-liquidity', strategy: { action: 'add_liquidity', maxAmounts: { USDC: '5', WETH: '0.004' } },
        bound: { cap: '10000000000000000', received: '4000000000000000', used: '4000000000000000' } });
      expect(semanticWorkflowHash(second.workflow!)).toBe(step.workflowHash);
      expect(step.workflowHash).not.toBe(approval.composed.steps[1]!.workflowHash);
      await applyApproval(h.surface, approval.secret, [h.evm, h.sol], second.workflow, h.d.now()).catch(() => undefined);
      h.flows.ownerExecutes('base-liquidity', h.evm.address, second.workflow, 'RECONCILED');
      await h.drain(run.runId);
      expect(await runOf(h, approval.approvalId)).toMatchObject({ state: 'COMPLETED' });
    } finally { await t.drop(); }
  });

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
      const evidence = pending.evidence;
      pending.evidence = null;
      await h.drain(run.runId);
      expect((await h.store.steps(run.runId))[0]).toMatchObject({ state: 'UNCERTAIN', code: 'STEP_RECONCILIATION_EVIDENCE_UNAVAILABLE' });
      expect((await continued(h, approval.approvalId)).command).toBeNull();
      pending.evidence = evidence;
      await h.drain(run.runId);
      expect(await runOf(h, approval.approvalId)).toMatchObject({ state: 'RUNNING', currentStep: 1 });
      expect((await h.store.steps(run.runId))[0]).toMatchObject({ state: 'RECONCILED', outcome: { executionId: pending.runId } });
    } finally { await t.drop(); }
  });

  it('ends a pinned developer Router refusal only when every attempt is durably recorded as unsent', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db, { flows: ['base-swap', 'crosschain-router'], delegation: false,
        policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base,arbitrum-one' } });
      const strategy = { version: 2, steps: [{ ...BASE_SWAP, network: 'base' },
        { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', amount: '5' },
        { ...BASE_SWAP, network: 'base' }] };
      const composed = composeWorkflowBound(strategy, undefined);
      if (!composed.ok) throw new Error(composed.code);
      const developer = createPgDeveloperStore(t.db, h.d.tenantId);
      const projectId = await developer.createProject('External Router fixture', h.d.now());
      const stored = await developer.createStrategy({ strategyId: typedId('str'), projectId, environment: 'production', strategy: composed.strategy,
        workflowHash: composed.workflowHash, engineVersion: ENGINE_VERSION, fundsClass: 'REAL_FUNDS', networkEnvironment: 'MAINNET',
        plan: workflowPlan(composed, { run: true }) }, h.d.now());
      const runtime = { ...h.flows.runtime, mode: async () => 'live' as const };
      const scheme = approvalLinkScheme('flofi_dhs_', randomBytes(32), ['DEVELOPER_PROJECT']);
      const surface = assembleApprovalSurface([{ scheme, profiles: { DEVELOPER_PROJECT: { policy: h.policy,
        claimPolicy: async () => ({ ok: true as const }) } } }], h.handoffs, runtime, { ...h.runs, runtime });
      const approval = await requestApproval({ ...h.deps(), runtime, scheme }, { kind: 'DEVELOPER_PROJECT', ref: `${projectId}.production`,
        clientId: projectId, displayName: 'External Router fixture', context: { strategyId: stored.strategyId } }, stored.strategy, stored.workflowHash, { ownerStepsOnly: true });
      if (!approval.ok) throw new Error(approval.code);
      const { approvalId, approvalUrl } = approval.value, secret = decodeURIComponent(new URL(approvalUrl).hash.slice(1));
      const first = await claimApproval(surface, secret, [h.evm], true, h.d.now());
      await applyApproval(surface, secret, [h.evm], first.workflow, h.d.now());
      const { runId } = await runOf(h, approvalId);
      const prior = h.flows.ownerExecutes('base-swap', h.evm.address, first.workflow, 'RECONCILED');
      await h.drain(runId);
      const second = await workflowRunContinue(surface, approvalId, [h.evm]);
      expect(second.view.workflowRun!.step).toMatchObject({ index: 1 });

      // The mainnet-shaped fixture records no wallet transaction. The durable handoff precedes the wallet answer.
      const execution = h.flows.ownerExecutes('crosschain-router', h.evm.address, second.workflow, 'REFUSED_BEFORE_SUBMISSION');
      Object.assign(execution, { status: 'SUBMITTING', needsObservation: true, errorCode: null });
      await h.drain(runId);
      expect((await h.store.steps(runId))[1]).toMatchObject({ state: 'UNCERTAIN', outcome: { executionId: execution.runId } });
      const cancelled = { state: 'CANCELLED', step: 'DEPOSIT', transactionHash: null, replacementHash: null, receipt: null, reconciled: false, note: 'ROUTER_REJECTED' };
      const refused = { format: 'flofi.router-run.v1', verdict: 'PENDING', phase: 'PREPARED', authorization: null, source: null, destination: null, refund: null,
        evidence: null, error: 'ROUTER_REJECTED', attempts: [cancelled] };
      Object.assign(execution, { status: 'REJECTED', needsObservation: false, errorCode: 'ROUTER_REJECTED',
        recordExtras: { ...refused, attempts: [{ ...cancelled, state: 'NOT_FOUND' }, cancelled] } });
      await h.drain(runId);
      expect(await runOf(h, approvalId)).toMatchObject({ state: 'ATTENTION', currentStep: 1 });
      expect((await workflowRunContinue(surface, approvalId, [h.evm])).workflow).toBeNull();

      execution.recordExtras = refused;
      await h.drain(runId);
      expect(await runOf(h, approvalId)).toMatchObject({ state: 'HALTED', currentStep: 1, code: 'ROUTER_REJECTED' });
      expect(await h.store.steps(runId)).toMatchObject([
        { state: 'RECONCILED', outcome: { executionId: prior.runId } },
        { state: 'FAILED', code: 'ROUTER_REJECTED', outcome: { executionId: execution.runId, transactions: [], evidence: null } },
        { state: 'PENDING', outcome: null },
      ]);
      expect((await workflowRunContinue(surface, approvalId, [h.evm])).workflow).toBeNull();
    } finally { await t.drop(); }
  });

  it('keeps a final native bridge pending until reconciled and shares both chain transactions and the actual delivery', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db, { flows: ['arbitrum-swap', 'crosschain-universal'], delegation: false,
        policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'arbitrum-one,base' } });
      const bridge = { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base', asset: 'ETH', outputAsset: 'ETH', amount: '0.0005' };
      const strategy = { version: 2, steps: [{ ...BASE_SWAP, network: 'arbitrum-one', outputAsset: 'ETH', amount: '1' }, bridge],
        bindings: [{ step: 1, amountFrom: 0 }] };
      const { approval, claimed } = await started(h, strategy);
      const run = await runOf(h, approval.approvalId);
      h.flows.ownerExecutes('arbitrum-swap', h.evm.address, claimed.workflow, 'RECONCILED',
        { received: [{ asset: 'eip155:42161/native:ETH', amount: '600000000000000' }] });
      await h.drain(run.runId);
      const second = await continued(h, approval.approvalId);
      expect(second.view.workflowRun!.step).toMatchObject({ index: 1 });
      const pending = h.flows.ownerExecutes('crosschain-universal', h.evm.address, second.workflow, 'PENDING');
      const fill = '0x' + '76'.repeat(32), amount = '487592918967244';
      pending.status = 'IN_FLIGHT';
      pending.errorCode = 'UNIVERSAL_DESTINATION_PENDING';
      pending.recordExtras = { verdict: 'PENDING', lastHint: { status: 'FILLED', destinationTxHashes: [fill] } };
      await h.drain(run.runId);
      expect((await progressOf(h, approval.approvalId)).workflowRun).toMatchObject({ state: 'ATTENTION', steps: [
        { state: 'RECONCILED' }, { state: 'UNCERTAIN', code: 'UNIVERSAL_DESTINATION_PENDING', outcome: null }] });
      pending.errorCode = 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE';
      await h.drain(run.runId);
      expect((await progressOf(h, approval.approvalId)).workflowRun).toMatchObject({ state: 'ATTENTION',
        code: 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE', steps: [
          { state: 'RECONCILED' }, { state: 'UNCERTAIN', code: 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE', outcome: null }] });
      expect((await continued(h, approval.approvalId)).command).toBeNull();

      h.flows.reconcile(pending);
      pending.errorCode = null;
      pending.recordExtras = { verdict: 'RECONCILED', destination: { chainId: 'eip155:8453', transactionHash: fill, final: true },
        receivedAmounts: [{ asset: 'eip155:8453/native:ETH', amount }] };
      await h.drain(run.runId);
      const status = (await workflowRunStatus(h.surface, approval.approvalId, [h.evm, h.sol])).view.workflowRun!.run;
      expect(status).toMatchObject({ state: 'COMPLETED', steps: [{ state: 'RECONCILED' }, { state: 'RECONCILED', outcome: {
        submissions: [{ chain: 'eip155:42161', hash: pending.attempts[0]!.transactionHash }, { chain: 'eip155:8453', hash: fill }],
        received: [{ asset: 'eip155:8453/native:ETH', amount }], evidence: { outcome: 'RECONCILED' },
      } }] });
      expect((await progressOf(h, approval.approvalId)).workflowRun?.steps[1]?.outcome?.submissions).toEqual(status.steps[1]!.outcome!.submissions);
      expect((await h.store.events(run.runId)).filter(e => e.kind === 'RUN_COMPLETED')).toHaveLength(1);
    } finally { await t.drop(); }
  });

  it.each(['RECONCILED', 'REFUNDED'] as const)('a native bridge %s before a swap settles the run according to its delivery evidence', async verdict => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db, { flows: ['base-swap', 'crosschain-universal'], delegation: false,
        policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'arbitrum-one,base' } });
      const sourceChain = 'eip155:42161', destinationChain = 'eip155:8453', amount = '487592918967244';
      const bridge = { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base', asset: 'ETH', outputAsset: 'ETH', amount: '0.0005' };
      const swap = { ...BASE_SWAP, network: 'base', inputAsset: 'ETH', outputAsset: 'USDC', amount: '0.0005' };
      const { approval, claimed } = await started(h, { version: 2, steps: [bridge, swap], bindings: [{ step: 1, amountFrom: 0 }] });
      const run = await runOf(h, approval.approvalId);
      const execution = h.flows.ownerExecutes('crosschain-universal', h.evm.address, claimed.workflow, 'PENDING');
      await h.drain(run.runId);
      expect((await continued(h, approval.approvalId)).command).toBeNull();

      const hash = '0x' + '54'.repeat(32);
      if (verdict === 'REFUNDED') {
        Object.assign(execution, { status: 'REFUNDED', needsObservation: false, recordExtras: { verdict, refund: { transactionHash: hash, chainId: sourceChain } } });
        await h.drain(run.runId);
        const view = (await progressOf(h, approval.approvalId)).workflowRun!;
        expect(view).toMatchObject({ state: 'FAILED', code: 'BRIDGE_REFUNDED', steps: [{ state: 'FAILED', outcome: { received: [],
          submissions: [{ chain: sourceChain, hash: execution.attempts[0]!.transactionHash }, { chain: sourceChain, hash }] } }, { state: 'PENDING' }] });
        expect((await continued(h, approval.approvalId)).command).toBeNull();
      } else {
        h.flows.reconcile(execution);
        execution.recordExtras = { verdict, received: amount, destination: { chainId: destinationChain, transactionHash: hash, final: true },
          review: { workflow: claimed.workflow, recipient: h.evm.address, route: { sourceChain, destinationChain, inputAmount: '500000000000000',
            inputToken: { chainId: sourceChain, kind: 'NATIVE', address: null }, outputToken: { chainId: destinationChain, kind: 'NATIVE', address: null } } } };
        await h.drain(run.runId);
        const next = await continued(h, approval.approvalId);
        expect(next.view.workflowRun!.step).toMatchObject({ index: 1 });
        expect((await h.store.steps(run.runId))[1]).toMatchObject({ bound: { used: amount }, strategy: { amount: '0.000487592918967244' } });
        h.flows.ownerExecutes('base-swap', h.evm.address, next.workflow, 'RECONCILED');
        await h.drain(run.runId);
        expect((await progressOf(h, approval.approvalId)).workflowRun).toMatchObject({ state: 'COMPLETED', steps: [{ state: 'RECONCILED' }, { state: 'RECONCILED' }] });
      }
    } finally { await t.drop(); }
  });

  it('recovers a failed step already recorded before the worker stopped without re-observing a submission', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const { approval, claimed } = await started(h);
      const run = await runOf(h, approval.approvalId);
      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, claimed.workflow, 'RECONCILED');
      await h.drain(run.runId);
      await continued(h, approval.approvalId);
      // Model the durable checkpoint after the step write and before the parent's compare-and-set.
      await h.store.stepTransition(run.runId, 1, ['AWAITING_OWNER'], 'FAILED', { code: 'SUBMISSION_REVERTED' });
      expect(await runOf(h, approval.approvalId)).toMatchObject({ state: 'RUNNING', currentStep: 1 });
      const runtime = { ...h.flows.runtime, runs: async () => { throw new Error('TERMINAL_STEP_MUST_NOT_BE_OBSERVED'); } };
      const deps = { store: h.store, runtime, delegation: h.d.store, policyFor: () => null, now: h.d.now, log: () => undefined };
      await Promise.all([advanceRun(deps, run.runId), advanceRun(deps, run.runId)]);
      expect(await runOf(h, approval.approvalId)).toMatchObject({ state: 'HALTED', code: 'SUBMISSION_REVERTED' });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['RECONCILED', 'FAILED']);
      expect((await h.store.events(run.runId)).filter(e => e.kind === 'RUN_STATE' && e.detail?.state === 'HALTED')).toHaveLength(1);
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

  it.each(['proven', 'unproven', 'legacy bound'] as const)('BUILD-CROSSCHAIN-UNIVERSAL-001: Swap → Bridge → Swap with bindings resolves each received amount in confirm mode (%s Relay ERC-20 delivery)', async proof => {
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
      // Step 1 (universal bridge): delivers 39 USDC on Base, below the destination swap cap. BUILD-FLOFI-MAINNET-BRIDGE-RECONCILIATION-003: the
      // flow's own reconciled record is read by the real universal parser; an ERC-20 delivery funds a later step only with the Relay order
      // proof (RELAY_EVM_TOKEN_V1) the destination verifier now persists. Without it the run never funds the destination swap.
      const bridgeRun = h.flows.ownerExecutes('crosschain-universal', h.sol.address, bridgeLoad.workflow, 'RECONCILED');
      const baseChain = composed.bindings[1]!.asset.chainId, solChain = composed.bindings[0]!.asset.chainId;
      bridgeRun.recordExtras = { format: 'flofi.universal-bridge-run.v1', verdict: 'RECONCILED', received: '39000000',
        destination: { chainId: baseChain, transactionHash: '0x' + '39'.repeat(32), final: true, amount: '39000000',
          ...proof === 'proven' ? { orderProof: 'RELAY_EVM_TOKEN_V1' } : { orderBound: true } },
        review: { workflow: bridgeLoad.workflow, recipient: h.evm.address, route: { sourceChain: solChain, destinationChain: baseChain, inputAmount: '40000000',
          inputToken: { chainId: solChain, kind: 'TOKEN', address: composed.bindings[0]!.asset.address },
          outputToken: { chainId: baseChain, kind: 'TOKEN', address: composed.bindings[1]!.asset.address } } } };
      if (proof === 'legacy bound') {
        // Persist the outcome and READY binding the pre-proof runner could have written, using the real store transitions.
        const asset = composed.bindings[1]!.asset, received = '39000000', flow = 'base-swap';
        await h.store.settleOwnerStep(run.runId, 1, 'RECONCILED', { kind: 'OWNER_RUN', executionId: bridgeRun.runId, flow: 'crosschain-universal',
          status: 'RECONCILED', transactions: [], evidence: null, spent: [], received: [{ asset: `${baseChain}/erc20:${asset.address}`, amount: received }],
          observedAt: h.d.now().toISOString() }, null);
        const before = await runOf(h, approval.approvalId);
        await h.store.transition(run.runId, { version: before.version, from: ['RUNNING'] }, 'RUNNING', { currentStep: 2 });
        const destination = composeWorkflowBound({ ...workflow.steps[2], amount: '39' }, undefined);
        if (!destination.ok) throw new Error(destination.code);
        const { strategy, workflow: reviewed, workflowHash } = destination.steps[0]!;
        await h.store.stepTransition(run.runId, 2, ['PENDING'], 'READY', { flow, strategy, workflowHash,
          bound: { amountFrom: 1, asset, cap: composed.bindings[1]!.cap, received, used: received } });
        await expect(continued(h, approval.approvalId)).rejects.toThrow('WORKFLOW_BINDING_NOTHING_RECEIVED');
        const claimedAt = new Date();
        await h.store.stepTransition(run.runId, 2, ['READY'], 'AWAITING_OWNER', { claimedAt });
        const input = { tenantId: h.d.tenantId, flow, owner: h.evm.address, createdAt: claimedAt, workflowId: reviewed.workflowId,
          load: async () => ({ review: { workflow: reviewed } }) };
        await expect(loadedOwnerStepDeliveryRefusal(t.db, input)).resolves.toBe('WORKFLOW_BINDING_NOTHING_RECEIVED');
        await expect(loadedOwnerStepDeliveryRefusal(t.db, { ...input, createdAt: new Date(claimedAt.getTime() - 2_000) })).resolves.toBeNull();
        await expect(loadedOwnerStepDeliveryRefusal(t.db, { ...input, tenantId: 'other-tenant' })).resolves.toBeNull();
        await expect(loadedOwnerStepDeliveryRefusal(t.db, { ...input, owner: '0x' + '12'.repeat(20) })).resolves.toBeNull();
        await expect(loadedOwnerStepDeliveryRefusal(t.db, { ...input, load: async () => ({ review: { workflow: { ...reviewed, revision: reviewed.revision + 1 } } }) })).resolves.toBeNull();
        // A Base Swap review intentionally has no projected owner until begin. Refuse before it can bind a wallet and issue a request.
        const catalog = baseCatalog(), chain = createRobinhoodMockChain(catalog, { network: 'base', now: Date.now });
        const usdc = baseAsset(catalog, 'USDC').address!, weth = baseAsset(catalog, 'WETH').address!;
        chain.addPool(usdc, weth, { fee: 3000, liquidity: 10n ** 20n, rate: { [usdc]: 4n * 10n ** 26n, [weth]: 2_500_000n } });
        chain.fund(usdc, h.evm.address, 50_000_000n);
        chain.fundNative(h.evm.address, 10n ** 18n);
        const backend = createBackend({ db: t.db, tenantId: h.d.tenantId, holderId: 'legacy-relay-binding', evidenceStore: null,
          env: { GRYLOO_BASE_MAINNET_HARNESS: 'MOCKED_LOOPBACK_ONLY' }, rpc: { 'base-swap': chain.rpc }, catalog: async () => catalog,
          logger: createLogger({ service: 'legacy-relay-binding', sink: () => undefined }) });
        const swap = createDurablePublicTestnetService({ rpc: chain.rpc, rpcs: { [baseChain]: chain.rpc }, storage: backend.storage(flow, h.d.tenantId),
          idPrefix: 'bas', catalog: mockCatalogRuntime(catalog) });
        const quote = (await swap.prepare(validateSavedWorkflow(reviewed), h.evm.address)).quote, id = quote.executionId;
        await swap.review(id, quote.manifestHash);
        const args = [id, h.evm.address];
        expect((await t.db.query('SELECT owner_account, status FROM execution_runs WHERE run_id = $1', [id])).rows)
          .toEqual([{ owner_account: null, status: 'AUTHORIZED' }]);
        await expect(backend.callFlow(flow, 'begin', args, h.d.tenantId, h.evm.address)).resolves.toEqual({ ok: false, code: 'WORKFLOW_BINDING_NOTHING_RECEIVED' });
        expect((await swap.load(id)).attempts).toEqual([]);
        return;
      }
      await h.drain(run.runId);
      if (proof === 'unproven') {
        // Fail closed: the bridge is final but proves no amount a later step may spend, so the destination swap is never funded or offered.
        expect((await h.store.steps(run.runId)).map(step => [step.state, step.bound?.used ?? null, step.outcome?.received ?? null])).toEqual([
          ['RECONCILED', null, [{ asset: solUsdc, amount: '40000000' }]], ['RECONCILED', '40000000', []], ['BLOCKED', null, null]]);
        expect((await progressOf(h, approval.approvalId)).workflowRun).toMatchObject({ state: 'HALTED', code: 'WORKFLOW_BINDING_NOTHING_RECEIVED' });
        expect((await continued(h, approval.approvalId)).command).toBeNull();
        return;
      }
      // The internal order-proof marker never leaks into the published run status (MCP, Developer API, channels).
      expect((await progressOf(h, approval.approvalId)).workflowRun!.steps[1]!.outcome!.received)
        .toEqual([{ asset: `${baseChain}/erc20:${composed.bindings[1]!.asset.address}`, amount: '39000000' }]);
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
