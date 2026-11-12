// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 universal execution — mixed workflows run END TO END on PostgreSQL through the real approval service, run store, runner and worker loop,
 * on MOCKED loopback chain doubles (Arbitrum One and Base identities with a modelled Aave V3 Pool and Uniswap v3 pair; evidence MOCKED, nothing
 * reaches a network, nothing is signed or paid by FloFi). The owner's wallet sends each EIP-5792 batch from its own account (the double executes
 * exactly the prepared calls); an owner-step group (Uniswap liquidity, a bridge) is the owner's own flow run, recorded by the harness's flow
 * runtime double as FloFi's flow would record it after the owner's signature.
 *
 *   1. Arbitrum Swap → Supply → Uniswap liquidity → Withdraw → Transfer: batch, owner step, batch (when due); the swap's reconciled output funds
 *      the Supply inside its batch and what is LEFT of it funds the liquidity step; the Withdraw's exact amount funds the Transfer.
 *   2. Arbitrum Swap → Bridge to Base → Base Supply + Transfer of the delivery: the bridge spends the swap's reconciled output; the Base batch is
 *      prepared only once the delivery reconciled, and its two steps share exactly what was delivered (never the owner's other balance).
 *   3. Arbitrum Repay → Withdraw → Swap of the withdrawal: ONE wallet batch on an existing position.
 */
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { claimApproval } from '../platform/index.ts';
import { workflowRunContinue, workflowRunUserFundedAuthorize, workflowRunUserFundedPrepare, workflowRunUserFundedReport,
  workflowRunUserFundedStart } from '../platform/approve.ts';
import { ownedRun } from '../platform/workflow-run-approvals.ts';
import { ARBITRUM_MAINNET_SWAP, BASE_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { delegationAavePool, delegationAaveReserve } from '../delegation/profiles.ts';
import { evmCallsOf, type EvmGroupCalls } from '../user-funded/evm-calls.ts';
import { workflowRunHarness, type RunHarness } from './workflow-run.test-harness.ts';

const ARB = 'eip155:42161', BASE = 'eip155:8453', RECIPIENT = '0x4444444444444444444444444444444444444444';
const A_USDC = ARBITRUM_MAINNET_SWAP.usdc.toLowerCase(), A_WETH = ARBITRUM_MAINNET_SWAP.weth.toLowerCase();
const B_USDC = BASE_MAINNET_SWAP.usdc.toLowerCase(), B_WETH = BASE_MAINNET_SWAP.weth.toLowerCase();
/** A modelled Aave V3 market on a chain: its registered Pool and the WETH / USDC reserves (prices in USD, 8 decimals; LTV and threshold in bps). */
function market(chain: string, weth: string, usdc: string) {
  const pool = delegationAavePool(chain, [chain])!, reserve = (asset: string) => delegationAaveReserve(chain, pool, asset)! as ReturnType<typeof delegationAaveReserve> & {
    asset: string; aToken: string; variableDebtToken: string };
  return { pool, reserve, reserves: [{ ...reserve(weth), price: 2_500n * 10n ** 8n, ltvBps: 8_000n, liquidationThresholdBps: 8_300n, decimals: 18 },
    { ...reserve(usdc), price: 10n ** 8n, ltvBps: 7_500n, liquidationThresholdBps: 7_800n, decimals: 6 }] };
}
const ARB_MARKET = market(ARB, A_WETH, A_USDC), BASE_MARKET = market(BASE, B_WETH, B_USDC);
const METAMASK = { eip155: { wallet: 'INJECTED', atomic: { [ARB]: 'supported', [BASE]: 'supported' }, typedData: true } };
type Batch = { group: EvmGroupCalls; request: { calls: { to: string; data: string }[]; atomicRequired: boolean; from: string; id: string } };

/** One user-funded run on fresh doubles: the requester hands the workflow over, the owner claims it and chooses user-funded execution. */
async function start(db: Awaited<ReturnType<typeof createTestDatabase>>['db'], flows: readonly string[], networks: string, strategy: (owner: string) => unknown) {
  let clock: () => Date = () => new Date();
  const now = () => Math.floor(clock().getTime() / 1000);
  const arb = createEvmDouble(42161, now, { profile: ARBITRUM_MAINNET_SWAP, aave: { pool: ARB_MARKET.pool, reserves: ARB_MARKET.reserves } });
  const base = createEvmDouble(8453, now, { profile: BASE_MAINNET_SWAP, aave: { pool: BASE_MARKET.pool, reserves: BASE_MARKET.reserves } });
  const h = await workflowRunHarness(db, { flows: flows as never, policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: networks }, userFundedChains: [ARB, BASE],
    userFundedRpc: c => c === ARB ? arb.rpc : c === BASE ? base.rpc : null });
  clock = h.d.now;
  const owner = h.d.evmOwner.address.toLowerCase(), wallets = [h.evm, h.sol];
  for (const chain of [arb, base]) chain.control.fundNative(owner, 10n ** 17n);
  const approval = await h.request(strategy(owner));
  await claimApproval(h.surface, approval.secret, wallets, true, h.d.now());
  const started = await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, METAMASK);
  return { h, arb, base, owner, wallets, approval, started };
}
/** The owner's wallet answers a prepared batch: it sends exactly the prepared calls from its own account (one transaction), then FloFi reconciles. */
async function ownerSendsBatch(h: RunHarness, chain: ReturnType<typeof createEvmDouble>, approvalId: string, wallets: RunHarness['evm'][], groupIndex: number) {
  const prepared = await workflowRunUserFundedPrepare(h.surface, approvalId, wallets, groupIndex);
  const p = prepared.prepared as unknown as Batch;
  // What the wallet is asked to sign: ONE atomic EIP-5792 request, from the owner, carrying exactly the group's calls in order.
  expect(p.request).toMatchObject({ atomicRequired: true, from: h.d.evmOwner.address.toLowerCase() });
  expect(p.request).not.toHaveProperty('capabilities');
  expect(p.request.calls.map(c => [c.to.toLowerCase(), c.data])).toEqual(evmCallsOf(p.group).map(c => [c.target.toLowerCase(), c.data]));
  const hash = chain.control.walletBatch(h.d.evmOwner.address, evmCallsOf(p.group));
  await workflowRunUserFundedAuthorize(h.surface, approvalId, wallets, groupIndex, { kind: 'EVM_WALLET_BATCH', batchId: p.request.id });
  await workflowRunUserFundedReport(h.surface, approvalId, wallets, groupIndex, [hash]);
  return p;
}

describe('P0 universal execution: mixed workflows end to end through the real run engine (PostgreSQL, MOCKED chains)', () => {
  it('Arbitrum Swap → Supply → Uniswap liquidity → Withdraw → Transfer: batch, owner step, batch; reconciled amounts fund every bound step', async () => {
    const t = await createTestDatabase();
    try {
      const { h, arb, owner, wallets, approval, started } = await start(t.db, ['arbitrum-swap', 'arbitrum-liquidity', 'arbitrum-aave', 'arbitrum-mainnet-transfer'], 'arbitrum-one',
        o => ({ version: 2, steps: [
          { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 },
          { action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: '0.0005', beneficiary: o },
          { action: 'add_liquidity', network: 'arbitrum-one', maxAmounts: { USDC: '1', WETH: '0.001' }, range: { unit: 'full' } },
          { action: 'withdraw', network: 'arbitrum-one', asset: 'WETH', amount: '0.0003' },
          { action: 'transfer', network: 'arbitrum-one', asset: 'WETH', amount: '0.0003', recipient: RECIPIENT }],
        bindings: [{ step: 1, amountFrom: 0 }, { step: 2, amountFrom: 0 }, { step: 4, amountFrom: 3 }] }));
      arb.control.fundToken(owner, A_USDC, 10_000_000n);
      const run0 = started.view.workflowRun!.run;
      expect(run0.groups.map(g => [g.strategy, g.signing, g.steps])).toEqual([['EVM_WALLET_BATCH', 'UPFRONT', [0, 1]], ['EVM_OWNER_STEP', 'WHEN_DUE', [2, 2]],
        ['EVM_WALLET_BATCH', 'WHEN_DUE', [3, 4]]]);

      // Group 0 (one wallet confirmation): approve USDC, swap 3 USDC (deadline-checked), approve WETH, supply min(0.0005, swap's signed minimum).
      const g0 = await ownerSendsBatch(h, arb, approval.approvalId, wallets, 0);
      expect(g0.group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE', 'ERC20_APPROVE', 'AAVE_V3_SUPPLY']);
      expect(g0.group.calls[1]).toMatchObject({ amountIn: '3000000', quotedAmountOut: '1200000000000000', amountOutMinimum: '1194000000000000' });
      expect(g0.group.calls[3]).toMatchObject({ kind: 'AAVE_V3_SUPPLY', asset: A_WETH, amount: '500000000000000' });
      let run = await ownedRun(h.runs, approval.approvalId, wallets);
      let steps = await h.store.steps(run.runId);
      expect(run).toMatchObject({ state: 'RUNNING', currentStep: 2 });
      expect(steps[0]!.outcome).toMatchObject({ kind: 'USER_FUNDED_GROUP', received: [{ asset: `${ARB}/erc20:${A_WETH}`, amount: '1200000000000000' }] });
      expect(steps[1]!.bound).toMatchObject({ amountFrom: 0, used: '500000000000000' });

      // Group 1 (the liquidity step's own flow): its WETH is what the swap ACTUALLY delivered minus what the Supply took — 0.0012 − 0.0005 =
      // 0.0007 WETH, below its 0.001 cap — never the cap, never the owner's other WETH.
      const liquidity = await workflowRunContinue(h.surface, approval.approvalId, wallets);
      expect(liquidity.view.workflowRun!.step).toEqual({ index: 2, count: 5 });
      steps = await h.store.steps(run.runId);
      expect(steps[2]).toMatchObject({ state: 'AWAITING_OWNER', flow: 'arbitrum-liquidity', bound: { amountFrom: 0, received: '1200000000000000', used: '700000000000000' } });
      expect((steps[2]!.strategy as { maxAmounts: Record<string, string> }).maxAmounts).toEqual({ USDC: '1', WETH: '0.0007' });
      h.flows.ownerExecutes('arbitrum-liquidity', h.evm.address, liquidity.workflow, 'RECONCILED');
      await h.drain(run.runId);
      run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'RUNNING', currentStep: 3 });

      // Group 2 (signed when due): the deadline guard, the Withdraw, and the Transfer of exactly what the Withdraw delivers.
      const g2 = await ownerSendsBatch(h, arb, approval.approvalId, wallets, 2);
      expect(g2.group.calls.map(c => c.kind)).toEqual(['DEADLINE_GUARD', 'AAVE_V3_WITHDRAW', 'ERC20_TRANSFER']);
      expect(g2.group.calls[2]).toMatchObject({ token: A_WETH, to: RECIPIENT, amount: '300000000000000' });
      await h.drain(run.runId);
      run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'COMPLETED', mode: 'USER_FUNDED' });
      expect((await h.store.groups(run.runId)).map(g => g.state)).toEqual(['RECONCILED', 'RECONCILED', 'RECONCILED']);
      steps = await h.store.steps(run.runId);
      expect(steps.map(s => [s.state, s.outcome?.kind])).toEqual([['RECONCILED', 'USER_FUNDED_GROUP'], ['RECONCILED', 'USER_FUNDED_GROUP'], ['RECONCILED', 'OWNER_RUN'],
        ['RECONCILED', 'USER_FUNDED_GROUP'], ['RECONCILED', 'USER_FUNDED_GROUP']]);
      expect(steps[3]!.outcome).toMatchObject({ received: [{ asset: `${ARB}/erc20:${A_WETH}`, amount: '300000000000000' }] });
      expect(steps[4]!.outcome).toMatchObject({ spent: [{ asset: `${ARB}/erc20:${A_WETH}`, amount: '300000000000000' }] });
      // On the chain: the recipient got exactly the withdrawn WETH; 0.0002 WETH stays supplied; FloFi sent nothing and paid for nothing.
      expect(arb.control.tokenBalance(A_WETH, RECIPIENT)).toBe(300_000_000_000_000n);
      expect(arb.control.accountData(owner).collateral).toBe(200_000_000_000_000n * 2_500n * 10n ** 8n / 10n ** 18n);
      expect(arb.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });

  it('Arbitrum Swap → Bridge to Base → Base Supply + Transfer: the bridge spends the swap\'s reconciled output; the Base batch shares the delivery', async () => {
    const t = await createTestDatabase();
    try {
      const { h, arb, base, owner, wallets, approval, started } = await start(t.db, ['arbitrum-swap', 'crosschain-router-arbitrum-to-base', 'base-aave', 'base-mainnet-transfer'],
        'arbitrum-one,base', o => ({ version: 2, steps: [
          { action: 'swap', network: 'arbitrum-one', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.0019', slippageBps: 50 },
          { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base', asset: 'USDC', amount: '5' },
          { action: 'supply', network: 'base', asset: 'USDC', amount: '3', beneficiary: o },
          { action: 'transfer', network: 'base', asset: 'USDC', amount: '5', recipient: RECIPIENT }],
        bindings: [{ step: 1, amountFrom: 0 }, { step: 2, amountFrom: 1 }, { step: 3, amountFrom: 1 }] }));
      arb.control.fundToken(owner, A_WETH, 10n ** 16n);
      const run0 = started.view.workflowRun!.run;
      expect(run0.groups.map(g => [g.strategy, g.signing, g.steps, g.chain])).toEqual([['EVM_WALLET_BATCH', 'UPFRONT', [0, 0], ARB], ['EVM_OWNER_STEP', 'WHEN_DUE', [1, 1], ARB],
        ['EVM_WALLET_BATCH', 'WHEN_DUE', [2, 3], BASE]]);
      const groups0 = await h.store.groups((await ownedRun(h.runs, approval.approvalId, wallets)).runId);
      expect(groups0[2]).toMatchObject({ awaitsDelivery: 1 });
      // The Base group cannot be prepared (or signed) before the delivery it spends reconciled.
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 2)).rejects.toThrow('WORKFLOW_RUN_GROUP_NOT_DUE');

      // Group 0: swap 0.0019 WETH → 4.75 USDC on Arbitrum (one wallet confirmation).
      const g0 = await ownerSendsBatch(h, arb, approval.approvalId, wallets, 0);
      expect(g0.group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE']);
      let run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect((await h.store.steps(run.runId))[0]!.outcome).toMatchObject({ received: [{ asset: `${ARB}/erc20:${A_USDC}`, amount: '4750000' }] });

      // Group 1: the bridge's own flow, for what the swap actually delivered (4.75 USDC, below its 5 USDC cap).
      const bridge = await workflowRunContinue(h.surface, approval.approvalId, wallets);
      expect(bridge.view.workflowRun!.step).toEqual({ index: 1, count: 4 });
      let steps = await h.store.steps(run.runId);
      expect(steps[1]).toMatchObject({ state: 'AWAITING_OWNER', flow: 'crosschain-router-arbitrum-to-base', bound: { amountFrom: 0, received: '4750000', used: '4750000' } });
      expect(steps[1]!.strategy).toMatchObject({ action: 'bridge', amount: '4.75' });
      // The bridge flow reconciles a delivery of 4.7 USDC to the owner on Base (the double models the arrival in the owner's Base wallet).
      h.flows.ownerExecutes('crosschain-router-arbitrum-to-base', h.evm.address, bridge.workflow, 'RECONCILED', {
        spent: [{ asset: `${ARB}/erc20:${A_USDC}`, amount: '4750000' }], received: [{ asset: `${BASE}/erc20:${B_USDC}`, amount: '4700000' }] });
      base.control.fundToken(owner, B_USDC, 4_700_000n);
      await h.drain(run.runId);
      run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'RUNNING', currentStep: 2 });

      // Group 2 on Base, due now: Supply min(3, 4.7) = 3 USDC, then Transfer min(5, what is LEFT: 1.7) = 1.7 USDC — one wallet confirmation.
      const g2 = await ownerSendsBatch(h, base, approval.approvalId, wallets, 2);
      expect(g2.group.chain).toBe(BASE);
      expect(g2.group.calls.map(c => c.kind)).toEqual(['DEADLINE_GUARD', 'ERC20_APPROVE', 'AAVE_V3_SUPPLY', 'ERC20_TRANSFER']);
      expect(g2.group.calls[2]).toMatchObject({ asset: B_USDC, amount: '3000000' });
      expect(g2.group.calls[3]).toMatchObject({ token: B_USDC, to: RECIPIENT, amount: '1700000' });
      await h.drain(run.runId);
      run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'COMPLETED', mode: 'USER_FUNDED' });
      steps = await h.store.steps(run.runId);
      expect(steps.map(s => [s.state, s.outcome?.kind])).toEqual([['RECONCILED', 'USER_FUNDED_GROUP'], ['RECONCILED', 'OWNER_RUN'], ['RECONCILED', 'USER_FUNDED_GROUP'],
        ['RECONCILED', 'USER_FUNDED_GROUP']]);
      expect(steps[2]!.bound).toMatchObject({ amountFrom: 1, received: '4700000', used: '3000000' });
      expect(steps[3]!.bound).toMatchObject({ amountFrom: 1, received: '4700000', used: '1700000' });
      // The delivery was spent exactly, and nothing of the owner's (or anyone's) other balance: Base USDC back to zero, recipient paid 1.7.
      expect(base.control.tokenBalance(B_USDC, owner)).toBe(0n);
      expect(base.control.tokenBalance(B_USDC, RECIPIENT)).toBe(1_700_000n);
      expect(arb.control.sends() + base.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });

  it('a bridge whose flow proves no delivery to the owner on Base: the due Base batch is never offered, the run HALTS keeping what executed', async () => {
    const t = await createTestDatabase();
    try {
      const { h, arb, base, owner, wallets, approval } = await start(t.db, ['arbitrum-swap', 'crosschain-router-arbitrum-to-base', 'base-aave', 'base-mainnet-transfer'], 'arbitrum-one,base',
        o => ({ version: 2, steps: [
          { action: 'swap', network: 'arbitrum-one', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.0019', slippageBps: 50 },
          { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base', asset: 'USDC', amount: '5' },
          { action: 'supply', network: 'base', asset: 'USDC', amount: '3', beneficiary: o },
          { action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: RECIPIENT }],
        bindings: [{ step: 1, amountFrom: 0 }, { step: 2, amountFrom: 1 }, { step: 3, amountFrom: 1 }] }));
      arb.control.fundToken(owner, A_WETH, 10n ** 16n);
      // The owner holds unrelated USDC on Base: a delivery that was never proven must not be "funded" from it.
      base.control.fundToken(owner, B_USDC, 50_000_000n);
      await ownerSendsBatch(h, arb, approval.approvalId, wallets, 0);
      const bridge = await workflowRunContinue(h.surface, approval.approvalId, wallets);
      // The bridge flow reconciled its source side, but its record identifies no delivery on Base (nothing a binding can match).
      h.flows.ownerExecutes('crosschain-router-arbitrum-to-base', h.evm.address, bridge.workflow, 'RECONCILED', { spent: [{ asset: `${ARB}/erc20:${A_USDC}`, amount: '4750000' }], received: [] });
      let run = await ownedRun(h.runs, approval.approvalId, wallets);
      await h.drain(run.runId);
      run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'RUNNING', currentStep: 2 });
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 2)).rejects.toThrow('WORKFLOW_BINDING_NOTHING_RECEIVED');
      run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'HALTED', code: 'WORKFLOW_BINDING_NOTHING_RECEIVED' });
      expect((await h.store.groups(run.runId)).map(g => [g.state, g.prepared === null])).toEqual([['RECONCILED', false], ['RECONCILED', true], ['BLOCKED', true]]);
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED', 'BLOCKED', 'BLOCKED']);
      // Nothing was supplied or sent from the owner's unrelated USDC; no transaction reached the Base double.
      expect(base.control.tokenBalance(B_USDC, owner)).toBe(50_000_000n);
      expect(base.control.tokenBalance(B_USDC, RECIPIENT)).toBe(0n);
      expect(base.control.accountData(owner).collateral).toBe(0n);
    } finally { await t.drop(); }
  });

  it('Arbitrum Repay → Withdraw → Swap of the withdrawal: ONE wallet batch on an existing position, reconciled step by step', async () => {
    const t = await createTestDatabase();
    try {
      const { h, arb, owner, wallets, approval, started } = await start(t.db, ['arbitrum-swap', 'arbitrum-aave'], 'arbitrum-one', o => ({ version: 2, steps: [
        { action: 'repay', network: 'arbitrum-one', asset: 'USDC', amount: '0.4', beneficiary: o },
        { action: 'withdraw', network: 'arbitrum-one', asset: 'WETH', amount: '0.0005' },
        { action: 'swap', network: 'arbitrum-one', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.001', slippageBps: 50 }],
      bindings: [{ step: 2, amountFrom: 1 }] }));
      // The owner's existing position, opened from their own wallet outside this run: 0.002 WETH supplied, 1 USDC borrowed.
      arb.control.fundToken(owner, A_WETH, 2_000_000_000_000_000n);
      arb.control.walletBatch(owner, evmCallsOf({ chain: ARB, chainId: 42161, owner, steps: [], calls: [
        { kind: 'ERC20_APPROVE', token: A_WETH, spender: ARB_MARKET.pool, amount: '2000000000000000' },
        { kind: 'AAVE_V3_SUPPLY', pool: ARB_MARKET.pool, asset: A_WETH, amount: '2000000000000000' },
        { kind: 'AAVE_V3_BORROW', pool: ARB_MARKET.pool, asset: A_USDC, amount: '1000000' }] }));
      expect(arb.control.accountData(owner).debt).toBe(100_000_000n);
      expect(started.view.workflowRun!.run.groups.map(g => [g.strategy, g.signing, g.steps])).toEqual([['EVM_WALLET_BATCH', 'UPFRONT', [0, 2]]]);

      const g0 = await ownerSendsBatch(h, arb, approval.approvalId, wallets, 0);
      // Approve exactly the repayment, repay 0.4 USDC, withdraw 0.0005 WETH, approve exactly the withdrawal, swap it (the swap carries the deadline).
      expect(g0.group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'AAVE_V3_REPAY', 'AAVE_V3_WITHDRAW', 'ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE']);
      expect(g0.group.calls[4]).toMatchObject({ tokenIn: A_WETH, tokenOut: A_USDC, amountIn: '500000000000000' });
      expect(g0.request.calls).toHaveLength(5);
      await h.drain();
      const run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'COMPLETED', mode: 'USER_FUNDED' });
      const steps = await h.store.steps(run.runId);
      expect(steps.map(s => [s.state, s.outcome?.spent, s.outcome?.received])).toEqual([
        ['RECONCILED', [{ asset: `${ARB}/erc20:${A_USDC}`, amount: '400000' }], []],
        ['RECONCILED', [], [{ asset: `${ARB}/erc20:${A_WETH}`, amount: '500000000000000' }]],
        ['RECONCILED', [{ asset: `${ARB}/erc20:${A_WETH}`, amount: '500000000000000' }], [{ asset: `${ARB}/erc20:${A_USDC}`, amount: '1250000' }]]]);
      // The swap was bound to the withdrawal: it spent exactly what the withdrawal delivered (0.0005 of its 0.001 cap), recorded as such.
      expect(steps[2]!.bound).toMatchObject({ amountFrom: 1, used: '500000000000000' });
      expect(steps[2]!.strategy).toMatchObject({ action: 'swap', amount: '0.0005' });
      expect(arb.control.accountData(owner).debt).toBe(60_000_000n);
      expect(arb.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });
});
