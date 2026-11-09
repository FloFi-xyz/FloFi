// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 universal execution: a USER_FUNDED run whose LATER group cannot be prepared when it becomes due, on PostgreSQL through the real approval
 * service, run store, runner and worker loop (MOCKED Arbitrum One chain double; nothing reaches a network, nothing is signed by FloFi).
 *
 *   Swap → Supply (one wallet batch) → Uniswap liquidity (its own owner-signed flow) → Supply (a wallet batch, due after the liquidity step)
 *
 * When the last group is due, the deployment's RPC no longer offers `eth_simulateV1`, so its Aave batch can never be offered. Before this fix
 * the run stayed RUNNING (up to its expiry) and every attempt failed again. Now the group is blocked and the run HALTED at once, keeping what
 * already executed; Resume continues that group through the Supply's own owner-signed flow (which simulates and reviews it itself).
 */
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { claimApproval } from '../platform/index.ts';
import { workflowRunContinue, workflowRunResume, workflowRunUserFundedAuthorize, workflowRunUserFundedPrepare, workflowRunUserFundedReport,
  workflowRunUserFundedStart } from '../platform/approve.ts';
import { ownedRun } from '../platform/workflow-run-approvals.ts';
import { ARBITRUM_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { delegationAavePool, delegationAaveReserve } from '../delegation/profiles.ts';
import { evmCallsOf, type EvmGroupCalls } from '../user-funded/evm-calls.ts';
import { runView } from './service.ts';
import { workflowRunHarness } from './workflow-run.test-harness.ts';

const CHAIN = 'eip155:42161', CHAINS = [CHAIN];
const USDC = ARBITRUM_MAINNET_SWAP.usdc, WETH = ARBITRUM_MAINNET_SWAP.weth;
const POOL = delegationAavePool(CHAIN, CHAINS)!;
const reserve = (asset: string) => delegationAaveReserve(CHAIN, POOL, asset)!;
const RESERVES = [{ ...reserve(WETH), price: 2_500n * 10n ** 8n, ltvBps: 8_000n, liquidationThresholdBps: 8_300n, decimals: 18 },
  { ...reserve(USDC), price: 10n ** 8n, ltvBps: 7_500n, liquidationThresholdBps: 7_800n, decimals: 6 }];
const METAMASK = { eip155: { wallet: 'INJECTED', atomic: { [CHAIN]: 'supported' }, typedData: true } };

describe('P0: a due group that can never be batched halts the run at once, and resumes step by step', () => {
  it('USER_FUNDED_SIMULATION_UNAVAILABLE at due time: run HALTED (executed steps kept), Resume runs the Supply through its own flow, run COMPLETED', async () => {
    const t = await createTestDatabase();
    try {
      let clock: () => Date = () => new Date();
      const chain = createEvmDouble(42161, () => Math.floor(clock().getTime() / 1000), { profile: ARBITRUM_MAINNET_SWAP, aave: { pool: POOL, reserves: RESERVES } });
      const h = await workflowRunHarness(t.db, { flows: ['arbitrum-swap', 'arbitrum-liquidity', 'arbitrum-aave'], policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'arbitrum-one' },
        userFundedChains: CHAINS, userFundedRpc: c => c === CHAIN ? chain.rpc : null });
      clock = h.d.now;
      const owner = h.d.evmOwner.address.toLowerCase(), wallets = [h.evm, h.sol];
      chain.control.fundToken(owner, USDC, 10_000_000n); chain.control.fundNative(owner, 10n ** 17n);
      const approval = await h.request({ version: 2, steps: [
        { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 },
        { action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: '0.0005', beneficiary: owner },
        { action: 'add_liquidity', network: 'arbitrum-one', maxAmounts: { USDC: '1', WETH: '0.0004' }, range: { unit: 'full' } },
        { action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: '0.0003', beneficiary: owner }] });
      await claimApproval(h.surface, approval.secret, wallets, true, h.d.now());
      const started = await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, METAMASK);
      expect(started.view.workflowRun!.run.groups.map(g => [g.strategy, g.steps])).toEqual([['EVM_WALLET_BATCH', [0, 1]], ['EVM_OWNER_STEP', [2, 2]], ['EVM_WALLET_BATCH', [3, 3]]]);

      // Group 0: one batch (swap → supply), executed by the owner's wallet and reconciled from the chain.
      const prepared = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const hash = chain.control.walletBatch(owner, evmCallsOf((prepared.prepared as unknown as { group: EvmGroupCalls }).group));
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: '0x' + 'c1'.repeat(16) });
      await workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, [hash]);
      // Group 1: the liquidity step through its own owner-signed flow.
      const liquidity = await workflowRunContinue(h.surface, approval.approvalId, wallets);
      expect(liquidity.view.workflowRun!.step).toEqual({ index: 2, count: 4 });
      h.flows.ownerExecutes('arbitrum-liquidity', h.evm.address, liquidity.workflow, 'RECONCILED');
      await h.drain();
      let run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'RUNNING', currentStep: 3 });

      // Group 2 is due, but the RPC no longer simulates batches: the Aave batch can never be offered. The run halts at once.
      chain.control.disableSimulation();
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 2)).rejects.toThrow('USER_FUNDED_SIMULATION_UNAVAILABLE');
      run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'HALTED', code: 'USER_FUNDED_SIMULATION_UNAVAILABLE' });
      expect((await h.store.groups(run.runId)).map(g => [g.state, g.code])).toEqual([['RECONCILED', null], ['RECONCILED', null], ['BLOCKED', 'USER_FUNDED_SIMULATION_UNAVAILABLE']]);
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED', 'RECONCILED', 'BLOCKED']);
      // Nothing was offered to the wallet for it: still exactly one batch on chain.
      expect(chain.control.accountData(owner).collateral).toBeGreaterThan(0n);
      expect((await runView({ store: h.store }, run, { outcomes: true, owner: true })).note).toMatch(/^Partially completed: the reconciled steps stay done/);

      // Resume: the blocked group continues through the Supply's own owner-signed flow (it simulates and reviews the step itself).
      await workflowRunResume(h.surface, approval.approvalId, wallets);
      expect((await h.store.groups(run.runId))[2]).toMatchObject({ state: 'PLANNED', strategy: 'EVM_OWNER_STEP', signing: 'WHEN_DUE' });
      const supply = await workflowRunContinue(h.surface, approval.approvalId, wallets);
      expect(supply.view.workflowRun!.step).toEqual({ index: 3, count: 4 });
      h.flows.ownerExecutes('arbitrum-aave', h.evm.address, supply.workflow, 'RECONCILED');
      // The test clock is fixed: the owner's next status poll (or the worker's next pass) is one more advance.
      await h.drain(run.runId);
      run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'COMPLETED', mode: 'USER_FUNDED' });
      expect((await h.store.steps(run.runId)).map(s => [s.state, s.outcome?.kind])).toEqual([['RECONCILED', 'USER_FUNDED_GROUP'], ['RECONCILED', 'USER_FUNDED_GROUP'],
        ['RECONCILED', 'OWNER_RUN'], ['RECONCILED', 'OWNER_RUN']]);
    } finally { await t.drop(); }
  });

  it('a due Repay no longer below the owner\'s debt (repaid elsewhere meanwhile) halts at once (REPAY_PARTIAL_DEBT_REQUIRED); Resume uses the Repay flow', async () => {
    const t = await createTestDatabase();
    try {
      let clock: () => Date = () => new Date();
      const chain = createEvmDouble(42161, () => Math.floor(clock().getTime() / 1000), { profile: ARBITRUM_MAINNET_SWAP, aave: { pool: POOL, reserves: RESERVES } });
      const h = await workflowRunHarness(t.db, { flows: ['arbitrum-liquidity', 'arbitrum-aave'], policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'arbitrum-one' },
        userFundedChains: CHAINS, userFundedRpc: c => c === CHAIN ? chain.rpc : null });
      clock = h.d.now;
      const owner = h.d.evmOwner.address.toLowerCase(), wallets = [h.evm, h.sol];
      chain.control.fundToken(owner, WETH, 2_000_000_000_000_000n); chain.control.fundToken(owner, USDC, 10_000_000n); chain.control.fundNative(owner, 10n ** 17n);
      const approval = await h.request({ version: 2, steps: [
        { action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: '0.002', beneficiary: owner },
        { action: 'borrow', network: 'arbitrum-one', asset: 'USDC', amount: '1', beneficiary: owner },
        { action: 'add_liquidity', network: 'arbitrum-one', maxAmounts: { USDC: '1', WETH: '0.0004' }, range: { unit: 'full' } },
        { action: 'repay', network: 'arbitrum-one', asset: 'USDC', amount: '0.8', beneficiary: owner }] });
      await claimApproval(h.surface, approval.secret, wallets, true, h.d.now());
      const started = await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, METAMASK);
      expect(started.view.workflowRun!.run.groups.map(g => [g.strategy, g.steps])).toEqual([['EVM_WALLET_BATCH', [0, 1]], ['EVM_OWNER_STEP', [2, 2]], ['EVM_WALLET_BATCH', [3, 3]]]);
      // Group 0: Supply → Borrow 1 USDC in one batch, executed and reconciled. Group 1: the liquidity step through its own flow.
      const prepared = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const hash = chain.control.walletBatch(owner, evmCallsOf((prepared.prepared as unknown as { group: EvmGroupCalls }).group));
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: '0x' + 'c3'.repeat(16) });
      await workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, [hash]);
      const liquidity = await workflowRunContinue(h.surface, approval.approvalId, wallets);
      h.flows.ownerExecutes('arbitrum-liquidity', h.evm.address, liquidity.workflow, 'RECONCILED');
      await h.drain();
      let run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'RUNNING', currentStep: 3 });
      expect(chain.control.accountData(owner).debt).toBe(100_000_000n);

      // Meanwhile the owner repaid 0.5 USDC from their own wallet, outside FloFi: the 0.8 USDC Repay is no longer below the 0.5 USDC debt.
      const usdc = reserve(USDC) as ReturnType<typeof reserve> & { aToken: string; variableDebtToken: string };
      chain.control.walletBatch(owner, evmCallsOf({ chain: CHAIN, chainId: 42161, owner, steps: [], calls: [
        { kind: 'ERC20_APPROVE', token: USDC, spender: POOL, amount: '500000' },
        { kind: 'AAVE_V3_REPAY', pool: POOL, asset: USDC, amount: '500000', aToken: usdc.aToken, variableDebtToken: usdc.variableDebtToken }] }));
      expect(chain.control.accountData(owner).debt).toBe(50_000_000n);
      // Every attempt would refuse again (the signed amount is fixed): the group is blocked and the run halted at once, keeping what executed.
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 2)).rejects.toThrow('REPAY_PARTIAL_DEBT_REQUIRED');
      run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'HALTED', code: 'REPAY_PARTIAL_DEBT_REQUIRED' });
      expect((await h.store.groups(run.runId)).map(g => [g.state, g.code])).toEqual([['RECONCILED', null], ['RECONCILED', null], ['BLOCKED', 'REPAY_PARTIAL_DEBT_REQUIRED']]);
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED', 'RECONCILED', 'BLOCKED']);
      // Resume: the Repay runs through its own owner-signed flow, which reads the debt again and reviews the step itself.
      await workflowRunResume(h.surface, approval.approvalId, wallets);
      expect((await h.store.groups(run.runId))[2]).toMatchObject({ state: 'PLANNED', strategy: 'EVM_OWNER_STEP', signing: 'WHEN_DUE', prepared: null });
      const repay = await workflowRunContinue(h.surface, approval.approvalId, wallets);
      expect(repay.view.workflowRun!.step).toEqual({ index: 3, count: 4 });
    } finally { await t.drop(); }
  });
});

describe('P0 review fixes: a wallet batch handed to the wallet is never lost, and a first group that can never be batched halts too', () => {
  async function setup() {
    const t = await createTestDatabase();
    let clock: () => Date = () => new Date();
    const chain = createEvmDouble(42161, () => Math.floor(clock().getTime() / 1000), { profile: ARBITRUM_MAINNET_SWAP, aave: { pool: POOL, reserves: RESERVES } });
    const h = await workflowRunHarness(t.db, { flows: ['arbitrum-swap', 'arbitrum-aave'], policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'arbitrum-one' },
      userFundedChains: CHAINS, userFundedRpc: c => c === CHAIN ? chain.rpc : null });
    clock = h.d.now;
    const owner = h.d.evmOwner.address.toLowerCase(), wallets = [h.evm, h.sol];
    chain.control.fundToken(owner, USDC, 10_000_000n); chain.control.fundNative(owner, 10n ** 17n);
    const approval = await h.request({ version: 2, steps: [
      { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 },
      { action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: '0.0005', beneficiary: owner }] });
    await claimApproval(h.surface, approval.secret, wallets, true, h.d.now());
    const started = await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, METAMASK);
    expect(started.view.workflowRun!.run.groups.map(g => [g.strategy, g.steps])).toEqual([['EVM_WALLET_BATCH', [0, 1]]]);
    return { t, chain, h, owner, wallets, approval };
  }
  type Artifact = { group: EvmGroupCalls; request: { id: string }; superseded?: readonly { group: EvmGroupCalls }[] };

  it('a re-preparation inside the last 3 minutes that fails leaves the batch PREPARED: the batch the wallet already sent is still recorded and reconciled', async () => {
    const { t, chain, h, owner, wallets, approval } = await setup();
    try {
      const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const first = p1.prepared as unknown as Artifact;
      // The owner's wallet sent P1; its answer never reached FloFi.
      const hash = chain.control.walletBatch(owner, evmCallsOf(first.group));
      // 8 minutes later (2 left: below the 3-minute hand-out margin) the page asks again, and the RPC no longer simulates: the new preparation fails.
      h.d.advance(8 * 60_000);
      chain.control.disableSimulation();
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0)).rejects.toThrow('USER_FUNDED_SIMULATION_UNAVAILABLE');
      let run = await ownedRun(h.runs, approval.approvalId, wallets);
      // Not blocked (a batch of this group is in the wallet's hands), not reset: still the PREPARED P1, so its answer is accepted.
      expect(run).toMatchObject({ state: 'RUNNING' });
      const [g] = await h.store.groups(run.runId);
      expect(g).toMatchObject({ state: 'PREPARED', validUntil: new Date(p1.validUntil!) });
      expect(g!.prepared).toEqual(p1.prepared);
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: first.request.id });
      await workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, [hash]);
      await h.drain(run.runId);
      run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'COMPLETED', mode: 'USER_FUNDED' });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED']);
    } finally { await t.drop(); }
  });

  it('a re-preparation inside the last 3 minutes replaces the batch in place (same id, version-checked) and the EARLIER batch the wallet sends is reconciled', async () => {
    const { t, chain, h, owner, wallets, approval } = await setup();
    try {
      const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const first = p1.prepared as unknown as Artifact;
      const run0 = await ownedRun(h.runs, approval.approvalId, wallets);
      const before = (await h.store.groups(run0.runId))[0]!;
      h.d.advance(8 * 60_000);
      const p2 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const second = p2.prepared as unknown as Artifact;
      expect(new Date(p2.validUntil!).getTime()).toBeGreaterThan(new Date(p1.validUntil!).getTime());
      expect(second.request.id).toBe(first.request.id);
      expect(second.superseded?.[0]?.group).toEqual(first.group);
      const after = (await h.store.groups(run0.runId))[0]!;
      expect(after).toMatchObject({ state: 'PREPARED' });
      // A rewrite that did not see this one (the row version it read is stale) changes nothing.
      expect(await h.store.groupTransition(run0.runId, 0, ['PREPARED'], 'PREPARED', { prepared: before.prepared, validUntil: before.validUntil }, 'GROUP_STATE', before.version)).toBeNull();
      expect((await h.store.groups(run0.runId))[0]!.prepared).toEqual(after.prepared);
      // The owner confirms the prompt that was still open for P1 (its on-chain deadline has not passed): that batch executes and is reconciled as P1.
      const hash = chain.control.walletBatch(owner, evmCallsOf(first.group));
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: first.request.id });
      await workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, [hash]);
      await h.drain(run0.runId);
      expect(await ownedRun(h.runs, approval.approvalId, wallets)).toMatchObject({ state: 'COMPLETED' });
      expect((await h.store.steps(run0.runId)).map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED']);
    } finally { await t.drop(); }
  });

  it('the FIRST group refused for good (no eth_simulateV1) halts the run at once; Resume runs its steps through their own owner-signed flows', async () => {
    const { t, chain, h, wallets, approval } = await setup();
    try {
      chain.control.disableSimulation();
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0)).rejects.toThrow('USER_FUNDED_SIMULATION_UNAVAILABLE');
      const run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'HALTED', code: 'USER_FUNDED_SIMULATION_UNAVAILABLE' });
      expect((await h.store.groups(run.runId)).map(g => [g.state, g.code])).toEqual([['BLOCKED', 'USER_FUNDED_SIMULATION_UNAVAILABLE']]);
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['BLOCKED', 'BLOCKED']);
      // HALTED (resumable step by step), but nothing ran: what the owner and a requester are told says exactly that, never "partially completed".
      for (const owner of [true, false]) expect(await runView({ store: h.store }, run, { outcomes: true, owner })).toMatchObject({ nextAction: 'OWNER_DECIDES',
        note: 'Stopped before anything was sent. Until the run expires the owner can resume it (each stopped step then runs through its own flow); the owner can always end it.' });
      await workflowRunResume(h.surface, approval.approvalId, wallets);
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'PLANNED', strategy: 'EVM_OWNER_STEP', signing: 'WHEN_DUE', prepared: null });
      expect(await ownedRun(h.runs, approval.approvalId, wallets)).toMatchObject({ state: 'RUNNING', currentStep: 0 });
      const swap = await workflowRunContinue(h.surface, approval.approvalId, wallets);
      expect(swap.view.workflowRun!.step).toEqual({ index: 0, count: 2 });
    } finally { await t.drop(); }
  });
});
