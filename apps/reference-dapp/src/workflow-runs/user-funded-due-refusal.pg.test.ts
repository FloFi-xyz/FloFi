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
});
