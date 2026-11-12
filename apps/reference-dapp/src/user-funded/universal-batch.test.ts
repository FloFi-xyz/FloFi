// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 universal execution: Aave V3 Repay and Withdraw in the owner's own user-funded wallet batch, composed with the other batch actions — exact
 * calls from the registered reserve profiles, the owner-signed lending flows' own rules (a PARTIAL repayment of the owner's variable debt; a
 * health factor of at least 2.0 after a withdrawal, proven by the whole-batch simulation), approvals only where the current allowance does not
 * cover the spend, and reconciliation from the chain (Aave's debt-token and aToken burns are protocol legs, never an unexpected owner outflow).
 *
 * MOCKED loopback chain double (Arbitrum One identities, a modelled Aave V3 Pool); nothing reaches a network and nothing is signed.
 */
import { describe, expect, it, vi } from 'vitest';
import { catalogAsset, createAssetCatalog, erc20AssetId } from '@defi-workflow-engine/action-registry';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import { ARBITRUM_MAINNET_SWAP, BASE_MAINNET_SWAP, BASE_SEPOLIA, ETHEREUM_MAINNET_SWAP, ETHEREUM_SEPOLIA_SWAP, ROBINHOOD_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness.ts';
import { guarded, type ChainTransport } from '../delegation/chains.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { delegationAavePool, delegationAaveReserve } from '../delegation/profiles.ts';
import { workflowRequirement } from '../delegation/steps.ts';
import { composeWorkflowBound } from '../engine/strategy-engine.ts';
import { planExecutionGroups } from '../workflow-runs/execution-groups.ts';
import { buildEvmGroupCalls, DEPENDENT_CALL_GAS, evmCallsOf, evmStepBuildable, type EvmGroupCalls } from './evm-calls.ts';
import { reconcileWalletBatch } from './evm-reconcile.ts';
import { prepareGroup, type UserFundedDeps } from './groups.ts';
import type { BatchSimulation } from './batch-simulation.ts';

const CHAIN = 'eip155:42161', CHAINS = [CHAIN], OWNER = '0x1111111111111111111111111111111111111111', NOW = '2026-11-09T03:00:00Z';
const USDC = ARBITRUM_MAINNET_SWAP.usdc, WETH = ARBITRUM_MAINNET_SWAP.weth;
const POOL = delegationAavePool(CHAIN, CHAINS)!;
const reserve = (asset: string) => delegationAaveReserve(CHAIN, POOL, asset)! as ReturnType<typeof delegationAaveReserve> & { aToken: string; variableDebtToken: string };
const RESERVES = [{ ...reserve(WETH), price: 2_500n * 10n ** 8n, ltvBps: 8_000n, liquidationThresholdBps: 8_300n, decimals: 18 },
  { ...reserve(USDC), price: 10n ** 8n, ltvBps: 7_500n, liquidationThresholdBps: 7_800n, decimals: 6 }];
type BatchPrepared = { group: EvmGroupCalls; request: { calls: { to: string; data: string }[]; atomicRequired: boolean }; simulation: BatchSimulation | null;
  fee: { estimatedGas: string; payer: string }; fromBlock: string };
type Strategy = { version: 2; steps: Record<string, unknown>[]; bindings?: { step: number; amountFrom: number }[] };

/** A chain where the owner already supplied 0.002 WETH (5 USD of collateral at 2,500 USD) and borrowed 1 USDC through an earlier batch. */
async function openPosition() {
  const chain = createEvmDouble(42161, () => Math.floor(Date.parse(NOW) / 1000), { profile: ARBITRUM_MAINNET_SWAP, aave: { pool: POOL, reserves: RESERVES } });
  chain.control.fundToken(OWNER, WETH, 2_000_000_000_000_000n); chain.control.fundToken(OWNER, USDC, 5_000_000n); chain.control.fundNative(OWNER, 10n ** 17n);
  const transport = guarded(CHAIN, 'read', 'MOCKED', chain.rpc);
  const deps: UserFundedDeps = { chains: CHAINS, evm: c => c === CHAIN ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(NOW) };
  const prepare = async (s: Strategy) => {
    const requirement = workflowRequirement(s), composition = composeWorkflowBound(s as never, undefined);
    if (!requirement.ok) throw new Error(`REQUIREMENT:${requirement.code}`);
    if (!composition.ok) throw new Error(`COMPOSITION:${JSON.stringify(composition)}`);
    const r = await prepareGroup(deps, composition, requirement.value, { runId: `wfr_${s.steps.length}`, groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: CHAIN,
      feePayer: OWNER, stepFrom: 0, stepTo: s.steps.length - 1 });
    return { r, requirement: requirement.value };
  };
  const opened = await prepare({ version: 2, steps: [{ action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: '0.002', beneficiary: OWNER },
    { action: 'borrow', network: 'arbitrum-one', asset: 'USDC', amount: '1', beneficiary: OWNER }] });
  if (!opened.r.ok) throw new Error(opened.r.code);
  chain.control.walletBatch(OWNER, evmCallsOf((opened.r.value.prepared as unknown as BatchPrepared).group));
  expect(chain.control.accountData(OWNER).debt).toBe(100_000_000n);
  return { chain, transport, prepare };
}
const repay = (amount: string) => ({ action: 'repay', network: 'arbitrum-one', asset: 'USDC', amount, beneficiary: OWNER });
const withdraw = (amount: string) => ({ action: 'withdraw', network: 'arbitrum-one', asset: 'WETH', amount });

describe('P0 universal execution: Aave Repay and Withdraw in the owner\'s own wallet batch', () => {
  it('both are buildable for the owner\'s own position on an opted-in market, and planned into ONE wallet batch with the other actions', () => {
    const s: Strategy = { version: 2, steps: [repay('0.4'), withdraw('0.0005'), { action: 'swap', network: 'arbitrum-one', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.0005', slippageBps: 50 }] };
    const requirement = workflowRequirement(s);
    if (!requirement.ok) throw new Error(requirement.code);
    expect(requirement.value.steps.map(st => evmStepBuildable(st, CHAINS, OWNER))).toEqual([null, null, null]);
    // A repayment of someone else's debt is refused at planning, never put in a batch that would fail at Authorize.
    const other = workflowRequirement({ version: 2, steps: [{ ...repay('0.4'), beneficiary: '0x2222222222222222222222222222222222222222' }] });
    if (!other.ok) throw new Error(other.code);
    expect(evmStepBuildable(other.value.steps[0]!, CHAINS, OWNER)).toBe('AAVE_BENEFICIARY_NOT_OWNER');
    const plan = planExecutionGroups(requirement.value, { enabled: true, code: null, chains: CHAINS, bundlerChains: [], solanaNonceAccounts: false },
      { eip155: { wallet: 'INJECTED', atomic: { [CHAIN]: 'supported' }, typedData: true } });
    if (!plan.ok) throw new Error(plan.code);
    expect(plan.groups.map(g => [g.strategy, g.stepFrom, g.stepTo, g.interactions])).toEqual([['EVM_WALLET_BATCH', 0, 2, 1]]);
    expect(plan.interactions).toMatchObject({ upfront: 1, whenDue: 0, single: true, atLeast: false });
  });

  it('Repay → Withdraw → Swap: exact calls, the whole batch simulated (health factor ≥ 2 after the withdrawal), reconciled from the chain', async () => {
    const { chain, transport, prepare } = await openPosition();
    const { r } = await prepare({ version: 2, steps: [repay('0.4'), withdraw('0.0005'),
      { action: 'swap', network: 'arbitrum-one', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.0005', slippageBps: 50 }] });
    if (!r.ok) throw new Error(r.code);
    const p = r.value.prepared as unknown as BatchPrepared;
    // The repayment needs its exact approval; the withdrawal needs none (it burns the owner's aTokens); the swap approves exactly its input.
    expect(p.group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'AAVE_V3_REPAY', 'AAVE_V3_WITHDRAW', 'ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE']);
    expect(p.group.calls[0]).toMatchObject({ token: USDC, spender: POOL, amount: '400000' });
    expect(p.group.calls[1]).toMatchObject({ pool: POOL, asset: USDC, amount: '400000', aToken: reserve(USDC).aToken.toLowerCase() });
    expect(p.group.calls[2]).toMatchObject({ pool: POOL, asset: WETH, amount: '500000000000000' });
    expect(p.request).toMatchObject({ atomicRequired: true });
    expect(p.request).not.toHaveProperty('capabilities');
    const hf = BigInt(p.simulation!.healthFactorAfter[POOL.toLowerCase()]!);
    expect(hf).toBeGreaterThanOrEqual(2n * 10n ** 18n);
    // Nothing changed on chain until the owner's wallet sends it.
    expect(chain.control.accountData(OWNER).debt).toBe(100_000_000n);

    const hash = chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    const reconciled = await reconcileWalletBatch(transport, p.group, [hash], p.fromBlock);
    if (reconciled.status !== 'RECONCILED') throw new Error(JSON.stringify(reconciled));
    expect(reconciled.steps).toEqual([
      { stepIndex: 0, spent: [{ asset: `${CHAIN}/erc20:${USDC}`, amount: '400000' }], received: [] },
      { stepIndex: 1, spent: [], received: [{ asset: `${CHAIN}/erc20:${WETH}`, amount: '500000000000000' }] },
      { stepIndex: 2, spent: [{ asset: `${CHAIN}/erc20:${WETH}`, amount: '500000000000000' }], received: [{ asset: `${CHAIN}/erc20:${USDC}`, amount: '1250000' }] }]);
    expect(reconciled.gasPaid.payer).toBe(OWNER);
    expect(chain.control.accountData(OWNER).debt).toBe(60_000_000n);
    expect(chain.control.accountData(OWNER).hf).toBe(hf);
  });

  it('a repayment of the whole debt (or more) is refused at preparation: partial repayments only, as the owner-signed Repay flow requires', async () => {
    const { chain, prepare } = await openPosition();
    expect((await prepare({ version: 2, steps: [repay('1')] })).r).toMatchObject({ ok: false, code: 'REPAY_PARTIAL_DEBT_REQUIRED', stepIndex: 0 });
    expect((await prepare({ version: 2, steps: [repay('2')] })).r).toMatchObject({ ok: false, code: 'REPAY_PARTIAL_DEBT_REQUIRED', stepIndex: 0 });
    // What the same batch borrows first counts as debt it may repay part of; an earlier repayment in the batch counts against a later one.
    const later = await prepare({ version: 2, steps: [{ action: 'borrow', network: 'arbitrum-one', asset: 'USDC', amount: '0.5', beneficiary: OWNER }, repay('1.2')] });
    expect(later.r.ok).toBe(true);
    expect((await prepare({ version: 2, steps: [repay('0.6'), repay('0.6')] })).r).toMatchObject({ ok: false, code: 'REPAY_PARTIAL_DEBT_REQUIRED', stepIndex: 1 });
    expect(chain.control.sends()).toBe(0);
  });

  it('a withdrawal that would leave the health factor below 2.0 is refused by the whole-batch simulation before anything is offered', async () => {
    // 0.0012 WETH out of 0.002 leaves 2 USD of collateral at 83% against 1 USD of debt: health factor 1.66 (Aave would allow it; FloFi does not).
    const { chain, prepare } = await openPosition();
    expect((await prepare({ version: 2, steps: [withdraw('0.0012')] })).r).toMatchObject({ ok: false, code: 'WITHDRAW_UNSAFE_HEALTH_FACTOR', stepIndex: 0 });
    // The same withdrawal after repaying enough of the debt in the same batch is safe, and is offered.
    const safe = await prepare({ version: 2, steps: [repay('0.5'), withdraw('0.0012')] });
    expect(safe.r.ok).toBe(true);
    // More than the position is refused by the simulation with its step.
    expect((await prepare({ version: 2, steps: [withdraw('0.003')] })).r).toMatchObject({ ok: false, code: 'SIMULATION_REVERTED', stepIndex: 0 });
    expect(chain.control.sends()).toBe(0);
  });

  it('without eth_simulateV1, a batch that repays or withdraws is refused with a closed code instead of being signed blind', async () => {
    const { chain, prepare } = await openPosition();
    chain.control.disableSimulation();
    expect((await prepare({ version: 2, steps: [withdraw('0.0001')] })).r).toMatchObject({ ok: false, code: 'USER_FUNDED_SIMULATION_UNAVAILABLE', stepIndex: 0 });
    expect((await prepare({ version: 2, steps: [repay('0.1')] })).r).toMatchObject({ ok: false, code: 'USER_FUNDED_SIMULATION_UNAVAILABLE', stepIndex: 0 });
  });

  it('a repayment the chain executed for less than its amount (someone else repaid first) never reconciles as the signed step', async () => {
    const { chain, transport, prepare } = await openPosition();
    const { r } = await prepare({ version: 2, steps: [repay('0.9')] });
    if (!r.ok) throw new Error(r.code);
    const p = r.value.prepared as unknown as BatchPrepared;
    // Another account repays 0.5 USDC of the owner's debt before the owner's batch lands: Aave then pulls only the remaining 0.5.
    chain.control.fundToken('0x3333333333333333333333333333333333333333', USDC, 1_000_000n);
    chain.control.setAllowance(USDC, '0x3333333333333333333333333333333333333333', POOL, 1_000_000n);
    chain.control.walletBatch('0x3333333333333333333333333333333333333333', evmCallsOf({ ...p.group, owner: '0x3333333333333333333333333333333333333333',
      calls: [{ ...p.group.calls.at(-1)!, amount: '500000' } as never] }).map(c => ({ ...c, data: c.data.replace('3'.repeat(40), '1'.repeat(40)) })));
    const hash = chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    expect(await reconcileWalletBatch(transport, p.group, [hash], p.fromBlock)).toMatchObject({ status: 'MISMATCH', code: 'RECONCILIATION_AMOUNT_MISMATCH' });
  });
});

describe('P0 universal execution: the L1 data fee an OP Stack chain (Base) charges the owner', () => {
  it('is part of the fee ceiling the owner\'s balance must cover, and of the gas paid reconciled from the receipt', async () => {
    const { BASE_MAINNET_SWAP } = await import('../domain/public-testnet-swap.ts');
    const BASE = 'eip155:8453', chain = createEvmDouble(8453, () => Math.floor(Date.parse(NOW) / 1000), { profile: BASE_MAINNET_SWAP });
    chain.control.fundToken(OWNER, BASE_MAINNET_SWAP.usdc, 10_000_000n); chain.control.fundNative(OWNER, 10n ** 17n);
    const transport = guarded(BASE, 'read', 'MOCKED', chain.rpc);
    const deps: UserFundedDeps = { chains: [BASE], evm: c => c === BASE ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(NOW) };
    const s = { version: 2, steps: [{ action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '2', slippageBps: 50 },
      { action: 'transfer', network: 'base', asset: 'WETH', amount: '0.0007', recipient: '0x4444444444444444444444444444444444444444' }], bindings: [{ step: 1, amountFrom: 0 }] };
    const requirement = workflowRequirement(s), composition = composeWorkflowBound(s as never, undefined);
    if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
    const r = await prepareGroup(deps, composition, requirement.value, { runId: 'wfr_base', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: BASE, feePayer: OWNER, stepFrom: 0, stepTo: 1 });
    if (!r.ok) throw new Error(r.code);
    const p = r.value.prepared as unknown as BatchPrepared & { fee: { maxCost: string; maxFeePerGas: string; l1FeeUpperBound: string } };
    const l1 = BigInt(p.fee.l1FeeUpperBound);
    expect(l1).toBeGreaterThan(0n);
    expect(BigInt(p.fee.maxCost)).toBe(BigInt(p.fee.estimatedGas) * BigInt(p.fee.maxFeePerGas) + l1);
    const hash = chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    const reconciled = await reconcileWalletBatch(transport, p.group, [hash], p.fromBlock);
    if (reconciled.status !== 'RECONCILED') throw new Error(JSON.stringify(reconciled));
    const receipt = await chain.rpc('eth_getTransactionReceipt', [hash]) as { gasUsed: string; effectiveGasPrice: string; l1Fee: string };
    expect(BigInt(receipt.l1Fee)).toBeGreaterThan(0n);
    expect(reconciled.gasPaid).toEqual({ payer: OWNER, unit: 'wei', source: 'RECEIPT',
      amount: (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) + BigInt(receipt.l1Fee)).toString() });
    // An owner who can pay the execution gas but not the L1 data fee on top is refused before anything is signed.
    chain.control.fundNative(OWNER, BigInt(p.fee.maxCost) - l1);
    expect(await prepareGroup(deps, composition, requirement.value, { runId: 'wfr_base2', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: BASE, feePayer: OWNER, stepFrom: 0, stepTo: 1 }))
      .toMatchObject({ ok: false, code: 'USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE' });
  });
});

describe('P0 universal execution: a wallet batch never executes a stale swap quote', () => {
  it('each batched swap carries the preparation\'s deadline on chain: a prompt confirmed after it reverts, and nothing is spent', async () => {
    let seconds = Math.floor(Date.parse(NOW) / 1000);
    const chain = createEvmDouble(42161, () => seconds, { profile: ARBITRUM_MAINNET_SWAP, aave: { pool: POOL, reserves: RESERVES } });
    chain.control.fundToken(OWNER, USDC, 10_000_000n); chain.control.fundNative(OWNER, 10n ** 17n);
    const transport = guarded(CHAIN, 'read', 'MOCKED', chain.rpc);
    const deps: UserFundedDeps = { chains: CHAINS, evm: c => c === CHAIN ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(seconds * 1000) };
    const s = { version: 2, steps: [{ action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 }] };
    const requirement = workflowRequirement(s), composition = composeWorkflowBound(s as never, undefined);
    if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
    const r = await prepareGroup(deps, composition, requirement.value, { runId: 'wfr_deadline', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: CHAIN, feePayer: OWNER, stepFrom: 0, stepTo: 0 });
    if (!r.ok) throw new Error(r.code);
    const p = r.value.prepared as unknown as BatchPrepared;
    const swap = p.group.calls.at(-1) as { kind: string; deadline?: string };
    // The deadline is the preparation's validity (10 minutes), in the SwapRouter02 multicall the wallet executes.
    expect(swap).toMatchObject({ kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', deadline: String(seconds + 600) });
    expect(evmCallsOf(p.group).at(-1)!.data.slice(0, 10)).toBe('0x5ae401dc');
    expect(BigInt((r.value.validUntil as Date).getTime())).toBe(BigInt((seconds + 600) * 1000));
    // Confirmed in time: it executes and reconciles.
    const inTime = chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    expect((await reconcileWalletBatch(transport, p.group, [inTime], p.fromBlock)).status).toBe('RECONCILED');
    // The same prompt confirmed after the deadline (the wallet kept it open): the router refuses it; the owner keeps every token.
    const before = chain.control.tokenBalance(USDC, OWNER);
    seconds += 601;
    const late = chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    expect(chain.control.receipt(late)).toMatchObject({ status: 0, reason: 'Transaction too old' });
    expect(chain.control.tokenBalance(USDC, OWNER)).toBe(before);
    expect((await reconcileWalletBatch(transport, p.group, [late], p.fromBlock)).status).toBe('REVERTED');
  });
});

describe('P0 universal execution: any catalog ERC-20 swap joins a wallet batch, on every catalog network', () => {
  const plannedWith = (strategy: Record<string, unknown>, chain: string) => {
    const r = workflowRequirement(strategy);
    if (!r.ok) throw new Error(r.code);
    const plan = planExecutionGroups(r.value, { enabled: true, code: null, chains: [chain], bundlerChains: [], solanaNonceAccounts: false },
      { eip155: { wallet: 'INJECTED', atomic: { [chain]: 'supported' }, typedData: true } });
    if (!plan.ok) throw new Error(plan.code);
    return { requirement: r.value, plan };
  };
  it('Robinhood Chain WETH → USDG → transfer: one wallet batch (it never was: a swap there needed the delegation framework)', async () => {
    const { ROBINHOOD_MAINNET_SWAP } = await import('../domain/public-testnet-swap.ts');
    const RH = 'eip155:4663', usdg = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
    const s = { version: 2, steps: [{ action: 'swap', network: 'robinhood', inputAsset: 'WETH', outputAsset: 'USDG', amount: '0.001', slippageBps: 100 },
      { action: 'transfer', network: 'robinhood', asset: 'USDG', amount: '2', recipient: '0x4444444444444444444444444444444444444444' }], bindings: [{ step: 1, amountFrom: 0 }] };
    const { requirement, plan } = plannedWith(s, RH);
    expect(plan.groups.map(g => [g.strategy, g.stepFrom, g.stepTo])).toEqual([['EVM_WALLET_BATCH', 0, 1]]);
    // The double models the registered Robinhood deployment with USDG as its 6-decimal side.
    const chain = createEvmDouble(4663, () => Math.floor(Date.parse(NOW) / 1000), { profile: { ...ROBINHOOD_MAINNET_SWAP, usdc: usdg } });
    chain.control.fundToken(OWNER, ROBINHOOD_MAINNET_SWAP.weth, 10n ** 16n); chain.control.fundNative(OWNER, 10n ** 17n);
    const transport = guarded(RH, 'read', 'MOCKED', chain.rpc);
    const deps: UserFundedDeps = { chains: [RH], evm: c => c === RH ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(NOW) };
    const composition = composeWorkflowBound(s as never, undefined);
    if (!composition.ok) throw new Error('STRATEGY_INVALID');
    const r = await prepareGroup(deps, composition, requirement, { runId: 'wfr_rh', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: RH, feePayer: OWNER, stepFrom: 0, stepTo: 1 });
    if (!r.ok) throw new Error(r.code);
    const p = r.value.prepared as unknown as BatchPrepared;
    expect(p.group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE', 'ERC20_TRANSFER']);
    expect(p.group.calls[1]).toMatchObject({ router: ROBINHOOD_MAINNET_SWAP.router.toLowerCase(), tokenIn: ROBINHOOD_MAINNET_SWAP.weth, tokenOut: usdg });
    const hash = chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    expect((await reconcileWalletBatch(transport, p.group, [hash], p.fromBlock)).status).toBe('RECONCILED');
  });
  it('takes the best existing fee tier, offers nothing without a pool, and leaves native ETH to its own flow', async () => {
    const s = (extra: Record<string, unknown> = {}) => ({ version: 2, steps: [{ action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3',
      slippageBps: 50, ...extra }] });
    const prepareOn = async (strategy: Record<string, unknown>, deployedTiers: readonly number[]) => {
      const chain = createEvmDouble(42161, () => Math.floor(Date.parse(NOW) / 1000), { profile: ARBITRUM_MAINNET_SWAP, deployedTiers });
      chain.control.fundToken(OWNER, USDC, 10_000_000n); chain.control.fundNative(OWNER, 10n ** 17n);
      const transport = guarded(CHAIN, 'read', 'MOCKED', chain.rpc);
      const deps: UserFundedDeps = { chains: CHAINS, evm: c => c === CHAIN ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(NOW) };
      const requirement = workflowRequirement(strategy), composition = composeWorkflowBound(strategy as never, undefined);
      if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
      return prepareGroup(deps, composition, requirement.value, { runId: 'wfr_tier', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: CHAIN, feePayer: OWNER, stepFrom: 0, stepTo: 0 });
    };
    // Only the 0.3% pool exists for this pair: the batch swaps there (the old builder always used 0.05%).
    const only3000 = await prepareOn(s(), [3000]);
    if (!only3000.ok) throw new Error(only3000.code);
    expect((only3000.value.prepared as unknown as BatchPrepared).group.calls.at(-1)).toMatchObject({ kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', fee: 3000 });
    // Several pools: every one is quoted and the best output wins (equal quotes keep the first, lowest-fee tier).
    const both = await prepareOn(s(), [500, 3000]);
    if (!both.ok) throw new Error(both.code);
    expect((both.value.prepared as unknown as BatchPrepared).group.calls.at(-1)).toMatchObject({ fee: 500 });
    // No canonical pool at any tier: nothing is offered.
    expect(await prepareOn(s(), [])).toMatchObject({ ok: false, code: 'QUOTE_UNAVAILABLE', stepIndex: 0 });
    // Native ETH in or out runs through the owner-signed catalog swap (its own group), with the reason.
    const native = workflowRequirement({ version: 2, steps: [{ action: 'swap', network: 'arbitrum-one', inputAsset: 'ETH', outputAsset: 'USDC', amount: '0.001' }] });
    if (!native.ok) throw new Error(native.code);
    expect(evmStepBuildable(native.value.steps[0]!, CHAINS, OWNER)).toBe('USER_FUNDED_NATIVE_SWAP_UNSUPPORTED');
  });

  it('skips a fee tier only on the chain\'s own answer (a revert, a zero quote, no pool); a rate-limited or malformed read refuses, never a worse tier', async () => {
    const s = { version: 2, steps: [{ action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 }] };
    type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
    /** Pools exist at 0.05% and 0.3%; `rpc` answers every read of the preparation, with the chain double's own answers available as `chain`. */
    const prepareWith = async (rpc: (method: string, params: readonly unknown[], chain: Rpc) => Promise<unknown>) => {
      const chain = createEvmDouble(42161, () => Math.floor(Date.parse(NOW) / 1000), { profile: ARBITRUM_MAINNET_SWAP, deployedTiers: [500, 3000] });
      chain.control.fundToken(OWNER, USDC, 10_000_000n); chain.control.fundNative(OWNER, 10n ** 17n);
      const transport = guarded(CHAIN, 'read', 'MOCKED', (method, params) => rpc(method, params, chain.rpc));
      const deps: UserFundedDeps = { chains: CHAINS, evm: c => c === CHAIN ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(NOW) };
      const requirement = workflowRequirement(s), composition = composeWorkflowBound(s as never, undefined);
      if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
      return prepareGroup(deps, composition, requirement.value, { runId: 'wfr_quote', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: CHAIN, feePayer: OWNER, stepFrom: 0, stepTo: 0 });
    };
    const quoteTier = (method: string, params: readonly unknown[]) => {
      const data = method === 'eth_call' ? String((params[0] as { data?: unknown }).data) : '';
      // quoteExactInputSingle((tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96)): the fee is the fourth word.
      return data.startsWith('0xc6a5026a') ? Number(BigInt('0x' + data.slice(10 + 3 * 64, 10 + 4 * 64))) : null;
    };
    /** The 0.3% pool quotes 1% less than the 0.05% one, whose quote is answered by `best` instead of the chain. */
    const quotes = (best: (() => unknown) | null) => async (method: string, params: readonly unknown[], chain: Rpc) => {
      const tier = quoteTier(method, params);
      if (tier === 500 && best) return best();
      if (tier !== 3000) return chain(method, params);
      const raw = String(await chain(method, params));
      return '0x' + (BigInt(raw.slice(0, 66)) * 99n / 100n).toString(16).padStart(64, '0') + raw.slice(66);
    };
    const feeOf = (r: Awaited<ReturnType<typeof prepareWith>>) => {
      if (!r.ok) throw new Error(r.code);
      return ((r.value.prepared as unknown as BatchPrepared).group.calls.at(-1) as { fee: number }).fee;
    };
    // Both pools answer: the 0.05% pool's better output wins.
    expect(feeOf(await prepareWith(quotes(null)))).toBe(500);
    // The best tier's quote is rate limited (the provider's message passed through): refused, never the 1% worse 0.3% pool.
    expect(await prepareWith(quotes(() => { throw new Error('over rate limit'); }))).toMatchObject({ ok: false, code: 'USER_FUNDED_RPC_UNAVAILABLE', stepIndex: 0 });
    // A malformed answer says nothing about the pool either.
    expect(await prepareWith(quotes(() => null))).toMatchObject({ ok: false, code: 'USER_FUNDED_RPC_UNAVAILABLE', stepIndex: 0 });
    // The chain itself answered for that pool: it reverted (no liquidity for this size) or quoted nothing. That tier is skipped.
    for (const revert of ['execution reverted', 'execution reverted: SPL', 'VM Exception while processing transaction: revert'])
      expect(feeOf(await prepareWith(quotes(() => { throw new Error(revert); })))).toBe(3000);
    expect(feeOf(await prepareWith(quotes(() => '0x' + '0'.repeat(256))))).toBe(3000);
    // The pool existence read is held to the same rule: a failed or malformed eth_getCode refuses instead of skipping that tier.
    const tokens = [USDC, WETH].map(a => a.toLowerCase());
    const poolCode = (answer: () => unknown) => (method: string, params: readonly unknown[], chain: Rpc) =>
      method === 'eth_getCode' && !tokens.includes(String(params[0]).toLowerCase()) ? Promise.resolve().then(answer) : chain(method, params);
    expect(await prepareWith(poolCode(() => { throw new Error('over rate limit'); }))).toMatchObject({ ok: false, code: 'USER_FUNDED_RPC_UNAVAILABLE', stepIndex: 0 });
    expect(await prepareWith(poolCode(() => null))).toMatchObject({ ok: false, code: 'USER_FUNDED_RPC_UNAVAILABLE', stepIndex: 0 });
  });
});

describe('P0 universal execution: a batch with Aave calls and no swap still expires on chain', () => {
  it('starts with a deadline guard (the registered router\'s multicall(deadline, [])): confirmed in time it executes, confirmed late it reverts whole', async () => {
    let seconds = Math.floor(Date.parse(NOW) / 1000);
    const chain = createEvmDouble(42161, () => seconds, { profile: ARBITRUM_MAINNET_SWAP, aave: { pool: POOL, reserves: RESERVES } });
    chain.control.fundToken(OWNER, WETH, 2_000_000_000_000_000n); chain.control.fundNative(OWNER, 10n ** 17n);
    const transport = guarded(CHAIN, 'read', 'MOCKED', chain.rpc);
    const deps: UserFundedDeps = { chains: CHAINS, evm: c => c === CHAIN ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(seconds * 1000) };
    const s = { version: 2, steps: [{ action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: '0.002', beneficiary: OWNER },
      { action: 'borrow', network: 'arbitrum-one', asset: 'USDC', amount: '1', beneficiary: OWNER }] };
    const requirement = workflowRequirement(s), composition = composeWorkflowBound(s as never, undefined);
    if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
    const prepare = () => prepareGroup(deps, composition, requirement.value, { runId: 'wfr_guard', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: CHAIN, feePayer: OWNER, stepFrom: 0, stepTo: 1 });
    const r = await prepare();
    if (!r.ok) throw new Error(r.code);
    const p = r.value.prepared as unknown as BatchPrepared;
    expect(p.group.calls.map(c => c.kind)).toEqual(['DEADLINE_GUARD', 'ERC20_APPROVE', 'AAVE_V3_SUPPLY', 'AAVE_V3_BORROW']);
    expect(p.group.calls[0]).toEqual({ kind: 'DEADLINE_GUARD', router: ARBITRUM_MAINNET_SWAP.router.toLowerCase(), deadline: String(seconds + 600) });
    // The guard belongs to no step; each step's calls are the Aave calls.
    expect(p.group.steps.map(st => st.calls)).toEqual([[1, 2], [3]]);
    // Confirmed after the deadline: the guard reverts the whole atomic batch; nothing is supplied or borrowed.
    seconds += 601;
    const hash = chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    expect(chain.control.receipt(hash)).toMatchObject({ status: 0, reason: 'Transaction too old' });
    expect(chain.control.accountData(OWNER)).toMatchObject({ collateral: 0n, debt: 0n });
    expect((await reconcileWalletBatch(transport, p.group, [hash], p.fromBlock)).status).toBe('REVERTED');
    // In time, it executes and reconciles step by step (the guard moves nothing).
    seconds -= 601;
    const ok = chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    const reconciled = await reconcileWalletBatch(transport, p.group, [ok], p.fromBlock);
    expect(reconciled).toMatchObject({ status: 'RECONCILED', steps: [{ stepIndex: 0 }, { stepIndex: 1, received: [{ asset: `${CHAIN}/erc20:${USDC}`, amount: '1000000' }] }] });
  });
});

describe('P0 universal execution: a batch of transfers only still expires on chain (never paid after the run stopped counting it)', () => {
  const A = '0x4444444444444444444444444444444444444444', B = '0x5555555555555555555555555555555555555555';
  it('starts with the deadline guard: confirmed late it reverts whole and no recipient is paid; in time each transfer executes and reconciles', async () => {
    let seconds = Math.floor(Date.parse(NOW) / 1000);
    const chain = createEvmDouble(42161, () => seconds, { profile: ARBITRUM_MAINNET_SWAP });
    chain.control.fundToken(OWNER, USDC, 10_000_000n); chain.control.fundToken(OWNER, WETH, 10n ** 16n); chain.control.fundNative(OWNER, 10n ** 17n);
    const transport = guarded(CHAIN, 'read', 'MOCKED', chain.rpc);
    const deps: UserFundedDeps = { chains: CHAINS, evm: c => c === CHAIN ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(seconds * 1000) };
    const s = { version: 2, steps: [{ action: 'transfer', network: 'arbitrum-one', asset: 'USDC', amount: '1', recipient: A },
      { action: 'transfer', network: 'arbitrum-one', asset: 'WETH', amount: '0.001', recipient: B }] };
    const requirement = workflowRequirement(s), composition = composeWorkflowBound(s as never, undefined);
    if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
    const r = await prepareGroup(deps, composition, requirement.value, { runId: 'wfr_transfers', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: CHAIN, feePayer: OWNER,
      stepFrom: 0, stepTo: 1 });
    if (!r.ok) throw new Error(r.code);
    const p = r.value.prepared as unknown as BatchPrepared;
    // The guard's deadline is the group's validity: past `validUntil` the run treats the batch as no longer executable, and so does the chain.
    expect(p.group.calls.map(c => c.kind)).toEqual(['DEADLINE_GUARD', 'ERC20_TRANSFER', 'ERC20_TRANSFER']);
    expect(p.group.calls[0]).toEqual({ kind: 'DEADLINE_GUARD', router: ARBITRUM_MAINNET_SWAP.router.toLowerCase(), deadline: String(seconds + 600) });
    expect(BigInt((r.value.validUntil as Date).getTime())).toBe(BigInt((seconds + 600) * 1000));
    // The guard belongs to no step: each step's call index moved by one. The wallet is asked to execute the guard first.
    expect(p.group.steps.map(st => [st.stepIndex, st.calls, st.recipient])).toEqual([[0, [1], A], [1, [2], B]]);
    expect(p.request.calls.map(c => c.data.slice(0, 10))).toEqual(['0x5ae401dc', '0xa9059cbb', '0xa9059cbb']);
    expect(p.simulation!.gasUsed).toHaveLength(3);
    // Confirmed after the deadline (the wallet kept the prompt open): the whole atomic batch reverts; nobody is paid, the owner keeps everything.
    seconds += 601;
    const late = chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    expect(chain.control.receipt(late)).toMatchObject({ status: 0, reason: 'Transaction too old' });
    expect([chain.control.tokenBalance(USDC, A), chain.control.tokenBalance(WETH, B)]).toEqual([0n, 0n]);
    expect([chain.control.tokenBalance(USDC, OWNER), chain.control.tokenBalance(WETH, OWNER)]).toEqual([10_000_000n, 10n ** 16n]);
    expect((await reconcileWalletBatch(transport, p.group, [late], p.fromBlock)).status).toBe('REVERTED');
    // Confirmed in time: both transfers execute and reconcile step by step (the guard moves nothing).
    seconds -= 601;
    const inTime = chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    expect(await reconcileWalletBatch(transport, p.group, [inTime], p.fromBlock)).toMatchObject({ status: 'RECONCILED', steps: [
      { stepIndex: 0, spent: [{ asset: `${CHAIN}/erc20:${USDC}`, amount: '1000000' }], received: [] },
      { stepIndex: 1, spent: [{ asset: `${CHAIN}/erc20:${WETH}`, amount: '1000000000000000' }], received: [] }] });
    expect([chain.control.tokenBalance(USDC, A), chain.control.tokenBalance(WETH, B)]).toEqual([1_000_000n, 10n ** 15n]);
  });

  it('without eth_simulateV1, the first TRANSFER is pre-checked (never the guard, which always succeeds in time): a reverting one is never offered', async () => {
    const seconds = Math.floor(Date.parse(NOW) / 1000);
    const s = { version: 2, steps: [{ action: 'transfer', network: 'arbitrum-one', asset: 'USDC', amount: '1', recipient: A },
      { action: 'transfer', network: 'arbitrum-one', asset: 'WETH', amount: '0.001', recipient: B }] };
    const requirement = workflowRequirement(s), composition = composeWorkflowBound(s as never, undefined);
    if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
    const TRANSFER_GAS = 51_234n, GUARD_GAS = 22_222n;
    /** An RPC without eth_simulateV1 whose eth_estimateGas runs the one call on the double's state, as a node does: the guard succeeds before
     *  its deadline; an ERC-20 transfer reverts when the sender holds less than its amount. Every estimated call is recorded. */
    const prepareWith = async (usdc: bigint) => {
      const chain = createEvmDouble(42161, () => seconds, { profile: ARBITRUM_MAINNET_SWAP });
      chain.control.fundToken(OWNER, USDC, usdc); chain.control.fundToken(OWNER, WETH, 10n ** 16n); chain.control.fundNative(OWNER, 10n ** 17n);
      chain.control.disableSimulation();
      const estimated: { to: string; data: string }[] = [];
      const transport = guarded(CHAIN, 'read', 'MOCKED', async (method, params) => {
        if (method !== 'eth_estimateGas') return chain.rpc(method, params);
        const call = params[0] as { from: string; to: string; data: string };
        estimated.push({ to: call.to.toLowerCase(), data: call.data });
        if (call.data.startsWith('0x5ae401dc')) {
          if (BigInt(seconds) > BigInt('0x' + call.data.slice(10, 74))) throw new Error('execution reverted: Transaction too old');
          return '0x' + GUARD_GAS.toString(16);
        }
        if (!call.data.startsWith('0xa9059cbb')) throw new Error(`UNEXPECTED_ESTIMATE_${call.data.slice(0, 10)}`);
        if (chain.control.tokenBalance(call.to, call.from) < BigInt('0x' + call.data.slice(74, 138))) throw new Error('execution reverted: ERC20: transfer amount exceeds balance');
        return '0x' + TRANSFER_GAS.toString(16);
      });
      const deps: UserFundedDeps = { chains: CHAINS, evm: c => c === CHAIN ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(seconds * 1000) };
      const r = await prepareGroup(deps, composition, requirement.value, { runId: 'wfr_nosim_transfers', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: CHAIN,
        feePayer: OWNER, stepFrom: 0, stepTo: 1 });
      return { r, chain, transport, estimated };
    };
    // The owner holds 0.5 USDC: the first transfer (1 USDC) would revert, so the batch is refused at its step and nothing reaches the wallet.
    const short = await prepareWith(500_000n);
    expect(short.r).toMatchObject({ ok: false, code: 'SIMULATION_REVERTED', stepIndex: 0 });
    expect(short.estimated).toEqual([{ to: USDC.toLowerCase(), data: expect.stringMatching(/^0xa9059cbb/) }]);
    expect([short.chain.control.simulations(), short.chain.control.sends()]).toEqual([0, 0]);
    // Funded: offered with the guard first; the fee estimate is the transfer's own estimate plus the guard's and the second transfer's allowances.
    const funded = await prepareWith(10_000_000n);
    if (!funded.r.ok) throw new Error(funded.r.code);
    const p = funded.r.value.prepared as unknown as BatchPrepared;
    expect(p.simulation).toBeNull();
    expect(p.group.calls.map(c => c.kind)).toEqual(['DEADLINE_GUARD', 'ERC20_TRANSFER', 'ERC20_TRANSFER']);
    expect(p.request.calls.map(c => c.data.slice(0, 10))).toEqual(['0x5ae401dc', '0xa9059cbb', '0xa9059cbb']);
    expect(funded.estimated).toEqual([{ to: USDC.toLowerCase(), data: evmCallsOf(p.group)[1]!.data }]);
    expect(BigInt(p.fee.estimatedGas)).toBe(TRANSFER_GAS + DEPENDENT_CALL_GAS.DEADLINE_GUARD + DEPENDENT_CALL_GAS.ERC20_TRANSFER + 30_000n);
    const hash = funded.chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    expect((await reconcileWalletBatch(funded.transport, p.group, [hash], p.fromBlock)).status).toBe('RECONCILED');
    expect([funded.chain.control.tokenBalance(USDC, A), funded.chain.control.tokenBalance(WETH, B)]).toEqual([1_000_000n, 10n ** 15n]);
  });

  it('a native transfer gets the guard on every user-funded EVM chain (each registers a router); a user operation (no deadline) is built as before', async () => {
    const requirement = workflowRequirement({ version: 2, steps: [{ action: 'transfer', network: 'arbitrum-one', asset: 'ETH', amount: '0.001', recipient: A }] });
    if (!requirement.ok) throw new Error(requirement.code);
    const deadline = Math.floor(Date.parse(NOW) / 1000) + 600, step = requirement.value.steps[0]!;
    // A native value transfer reads only its recipient's code (an EOA here: no code).
    const eoa = (chain: string): ChainTransport => ({ chain, provenance: 'MOCKED', rpc: async (method, params) => {
      if (method === 'eth_getCode' && String(params[0]) === A) return '0x';
      throw new Error(`UNEXPECTED_${method}`);
    } });
    const routers: [string, string][] = [[ETHEREUM_MAINNET_SWAP.chainRef, ETHEREUM_MAINNET_SWAP.router], [BASE_MAINNET_SWAP.chainRef, BASE_MAINNET_SWAP.router],
      [CHAIN, ARBITRUM_MAINNET_SWAP.router], [ROBINHOOD_MAINNET_SWAP.chainRef, ROBINHOOD_MAINNET_SWAP.router],
      // The loopback test pair profiles (harnesses only) carry it through their registered router too.
      [BASE_SEPOLIA.chainRef, BASE_SEPOLIA.router], [ETHEREUM_SEPOLIA_SWAP.chainRef, ETHEREUM_SEPOLIA_SWAP.router]];
    for (const [chain, router] of routers) {
      const onChain = { ...requirement.value, steps: [{ ...step, chain }] };
      const bounded = await buildEvmGroupCalls(onChain, 0, 0, { chains: [chain], owner: OWNER, transport: () => eoa(chain), deadline });
      if (!bounded.ok) throw new Error(`${chain}:${bounded.code}`);
      expect(bounded.value.calls).toEqual([{ kind: 'DEADLINE_GUARD', router: router.toLowerCase(), deadline: String(deadline) },
        { kind: 'NATIVE_TRANSFER', to: A, amount: '1000000000000000' }]);
      expect(bounded.value.steps.map(st => st.calls)).toEqual([[1]]);
      const unbounded = await buildEvmGroupCalls(onChain, 0, 0, { chains: [chain], owner: OWNER, transport: () => eoa(chain) });
      if (!unbounded.ok) throw new Error(`${chain}:${unbounded.code}`);
      expect(unbounded.value.calls).toEqual([{ kind: 'NATIVE_TRANSFER', to: A, amount: '1000000000000000' }]);
      expect(unbounded.value.steps.map(st => st.calls)).toEqual([[0]]);
    }
  });

  it('P2: a batched native transfer pays the owner or a recipient without code only — a contract or an EIP-7702 delegation is refused on every chain', async () => {
    const CONTRACT = '0x6666666666666666666666666666666666666666', DELEGATED = '0x7777777777777777777777777777777777777777';
    const code: Record<string, string> = { [A]: '0x', [CONTRACT]: '0x6080604052', [DELEGATED]: '0xef0100' + '8'.repeat(40) };
    const reads: string[] = [];
    const reading = (chain: string, answer: (address: string) => unknown): ChainTransport => ({ chain, provenance: 'MOCKED', rpc: async (method, params) => {
      if (method !== 'eth_getCode' || params[1] !== 'latest') throw new Error(`UNEXPECTED_${method}`);
      reads.push(String(params[0]));
      return answer(String(params[0]));
    } });
    const build = (chain: string, recipients: readonly string[], transport: ChainTransport | null) => {
      const requirement = workflowRequirement({ version: 2, steps: recipients.map(recipient => ({ action: 'transfer', network: 'arbitrum-one', asset: 'ETH', amount: '0.001', recipient })) });
      if (!requirement.ok) throw new Error(requirement.code);
      const onChain = { ...requirement.value, steps: requirement.value.steps.map(st => ({ ...st, chain })) };
      return buildEvmGroupCalls(onChain, 0, recipients.length - 1, { chains: [chain], owner: OWNER, transport: () => transport });
    };
    // Every user-funded EVM chain, with or without the owner-signed flow's contractRecipients profile flag (Ethereum, Arbitrum One have it).
    for (const chain of [ETHEREUM_MAINNET_SWAP.chainRef, BASE_MAINNET_SWAP.chainRef, CHAIN, ROBINHOOD_MAINNET_SWAP.chainRef]) {
      reads.length = 0;
      // An EOA recipient is read once (a second step to it reuses the read) and built.
      const paid = await build(chain, [A, A], reading(chain, a => code[a]));
      if (!paid.ok) throw new Error(`${chain}:${paid.code}`);
      expect(paid.value.calls).toEqual([{ kind: 'NATIVE_TRANSFER', to: A, amount: '1000000000000000' }, { kind: 'NATIVE_TRANSFER', to: A, amount: '1000000000000000' }]);
      expect(reads).toEqual([A]);
      // Contract code or an EIP-7702 delegation designator: refused at that step (the owner-signed flow then applies its own rules).
      expect(await build(chain, [CONTRACT], reading(chain, a => code[a]))).toEqual({ ok: false, stepIndex: 0, code: 'USER_FUNDED_TRANSFER_RECIPIENT_NOT_EOA' });
      expect(await build(chain, [A, DELEGATED], reading(chain, a => code[a]))).toEqual({ ok: false, stepIndex: 1, code: 'USER_FUNDED_TRANSFER_RECIPIENT_NOT_EOA' });
      // The owner itself needs no read (no transport at all).
      const self = await build(chain, [OWNER], null);
      if (!self.ok) throw new Error(`${chain}:${self.code}`);
      expect(self.value.calls).toEqual([{ kind: 'NATIVE_TRANSFER', to: OWNER, amount: '1000000000000000' }]);
      // An unreadable recipient is a transient refusal, never a built transfer.
      for (const answer of [() => { throw new Error('DELEGATION_RPC_UNAVAILABLE'); }, () => null, () => '0xzz'])
        expect(await build(chain, [A], reading(chain, answer))).toEqual({ ok: false, stepIndex: 0, code: 'USER_FUNDED_RPC_UNAVAILABLE' });
      expect(await build(chain, [A], null)).toEqual({ ok: false, stepIndex: 0, code: 'USER_FUNDED_RPC_UNAVAILABLE' });
    }
  });
});

describe('P0 universal execution: Base Swap → Supply → Borrow as one batch (the browser e2e chain)', () => {
  it('prepares the 5 calls (plus the swap deadline), simulates the health factor and reconciles on the Base double', async () => {
    const { BASE_MAINNET_SWAP } = await import('../domain/public-testnet-swap.ts');
    const BASE = 'eip155:8453', pool = delegationAavePool(BASE, [BASE])!;
    const r = (asset: string) => delegationAaveReserve(BASE, pool, asset)!;
    const reserves = [{ ...r(BASE_MAINNET_SWAP.weth), price: 2_500n * 10n ** 8n, ltvBps: 8_000n, liquidationThresholdBps: 8_300n, decimals: 18 },
      { ...r(BASE_MAINNET_SWAP.usdc), price: 10n ** 8n, ltvBps: 7_500n, liquidationThresholdBps: 7_800n, decimals: 6 }];
    const chain = createEvmDouble(8453, () => Math.floor(Date.parse(NOW) / 1000), { profile: BASE_MAINNET_SWAP, aave: { pool, reserves } });
    chain.control.fundToken(OWNER, BASE_MAINNET_SWAP.usdc, 10_000_000n); chain.control.fundNative(OWNER, 10n ** 17n);
    const transport = guarded(BASE, 'read', 'MOCKED', chain.rpc);
    const deps: UserFundedDeps = { chains: [BASE], evm: c => c === BASE ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(NOW) };
    const s = { version: 2, steps: [{ action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 },
      { action: 'supply', network: 'base', asset: 'WETH', amount: '0.0013', beneficiary: OWNER },
      { action: 'borrow', network: 'base', asset: 'USDC', amount: '0.8', beneficiary: OWNER }], bindings: [{ step: 1, amountFrom: 0 }] };
    const requirement = workflowRequirement(s), composition = composeWorkflowBound(s as never, undefined);
    if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
    const prepared = await prepareGroup(deps, composition, requirement.value, { runId: 'wfr_base_aave', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: BASE, feePayer: OWNER,
      stepFrom: 0, stepTo: 2 });
    if (!prepared.ok) throw new Error(prepared.code);
    const p = prepared.value.prepared as unknown as BatchPrepared;
    expect(p.group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE', 'ERC20_APPROVE', 'AAVE_V3_SUPPLY', 'AAVE_V3_BORROW']);
    expect(BigInt(p.simulation!.healthFactorAfter[pool.toLowerCase()]!)).toBeGreaterThanOrEqual(2n * 10n ** 18n);
    const hash = chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    expect((await reconcileWalletBatch(transport, p.group, [hash], p.fromBlock)).status).toBe('RECONCILED');
  });
});

describe('P0 universal execution: a batched catalog swap trusts the chain, never the listing, and proves what the owner received', () => {
  const SWAP = { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 };
  const QUOTE_SELECTOR = '0xc6a5026a', BALANCE_OF_SELECTOR = '0x70a08231';
  /** A MOCKED Arbitrum One chain (its registered catalog deployment) whose reads are recorded, and the preparation of `s` as one wallet batch. */
  const arbitrum = () => {
    const chain = createEvmDouble(42161, () => Math.floor(Date.parse(NOW) / 1000), { profile: ARBITRUM_MAINNET_SWAP });
    chain.control.fundToken(OWNER, USDC, 10_000_000n); chain.control.fundNative(OWNER, 10n ** 17n);
    const reads: string[] = [];
    const transport = guarded(CHAIN, 'read', 'MOCKED', async (method, params) => {
      reads.push(method === 'eth_call' ? String((params[0] as { data: string }).data).slice(0, 10) : method);
      return chain.rpc(method, params);
    });
    const deps: UserFundedDeps = { chains: CHAINS, evm: c => c === CHAIN ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(NOW) };
    const prepare = (s: Strategy) => {
      const requirement = workflowRequirement(s), composition = composeWorkflowBound(s as never, undefined);
      if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
      return prepareGroup(deps, composition, requirement.value, { runId: 'wfr_verify', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: CHAIN, feePayer: OWNER,
        stepFrom: 0, stepTo: s.steps.length - 1 });
    };
    return { chain, transport, reads, prepare };
  };

  it('a token whose decimals() on chain differ from its catalog entry is refused before anything is quoted, simulated or offered', async () => {
    for (const [token, decimals] of [[USDC, 18], [WETH, 6]] as const) {
      const { chain, reads, prepare } = arbitrum();
      chain.control.setDecimals(token, decimals);
      expect(await prepare({ version: 2, steps: [SWAP] })).toMatchObject({ ok: false, code: 'TOKEN_METADATA_MISMATCH', stepIndex: 0 });
      expect(reads).not.toContain(QUOTE_SELECTOR);
      expect(chain.control.simulations()).toBe(0);
      expect(chain.control.sends()).toBe(0);
    }
    // The same swap on a chain that reports the catalog's decimals is offered; each token is read once (code, then decimals()).
    const { reads, prepare } = arbitrum();
    expect((await prepare({ version: 2, steps: [SWAP] })).ok).toBe(true);
    expect(reads.filter(r => r === '0x313ce567')).toHaveLength(2);
  });

  it('a catalog token address without code is refused (CONTRACT_CODE_MISSING), nothing quoted', async () => {
    const { chain, reads, prepare } = arbitrum();
    chain.control.setCode(WETH, '0x');
    expect(await prepare({ version: 2, steps: [SWAP] })).toMatchObject({ ok: false, code: 'CONTRACT_CODE_MISSING', stepIndex: 0 });
    expect(reads).not.toContain(QUOTE_SELECTOR);
    expect(chain.control.simulations()).toBe(0);
  });

  it('Robinhood Chain: a listed token that is not one of its pinned assets is never batched (only its pinned assets and Stock Tokens exist there)', () => {
    const RH = 'eip155:4663';
    const r = workflowRequirement({ version: 2, steps: [{ action: 'swap', network: 'robinhood', inputAsset: 'WETH', outputAsset: 'USDG', amount: '0.001', slippageBps: 100 }] });
    if (!r.ok) throw new Error(r.code);
    const step = r.value.steps[0]!;
    // An official Robinhood catalog that also lists a non-Stock ERC-20 (USDG's shape, another address) beside the pinned WETH and USDG.
    const official = officialCatalog(), usdg = catalogAsset(official, { symbol: 'USDG' })!, listed = '0x' + '7a'.repeat(20);
    registerNetworkCatalog(createAssetCatalog({ chain: RH, network: official.network, provenance: official.provenance,
      assets: [...official.assets, { ...usdg, id: erc20AssetId(RH, listed), address: listed, symbol: 'RHX', name: 'Listed token', source: { ...usdg.source, officialId: null } }] }));
    try {
      expect(evmStepBuildable({ ...step, outputs: [{ ...step.outputs[0]!, address: listed }] }, [RH], OWNER)).toBe('USER_FUNDED_SWAP_ASSET_UNSUPPORTED');
      expect(evmStepBuildable({ ...step, inputs: [{ ...step.inputs[0]!, address: listed, decimals: 6 }] }, [RH], OWNER)).toBe('USER_FUNDED_SWAP_ASSET_UNSUPPORTED');
      // The pinned pair itself is still batched.
      expect(evmStepBuildable(step, [RH], OWNER)).toBeNull();
    } finally { resetNetworkCatalogs(); }
  });

  /** Swap 3 USDC → WETH (50 bps slippage), then transfer the swap's WETH (its signed minimum, below the 0.0013 cap) to someone else. */
  const BOUND: Strategy = { version: 2, steps: [SWAP, { action: 'transfer', network: 'arbitrum-one', asset: 'WETH', amount: '0.0013',
    recipient: '0x4444444444444444444444444444444444444444' }], bindings: [{ step: 1, amountFrom: 0 }] };

  it('a transfer fee hidden inside the slippage headroom (10 bps < 50 bps) on a swap output a bound transfer spends is refused; a normal token passes', async () => {
    // A normal token: offered; the balance reads exist only in the simulation, never in the batch the wallet sends; it executes and reconciles.
    const normal = arbitrum();
    normal.chain.control.fundToken(OWNER, WETH, 10n ** 16n);
    const r = await normal.prepare(BOUND);
    if (!r.ok) throw new Error(r.code);
    const p = r.value.prepared as unknown as BatchPrepared;
    expect(p.group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE', 'ERC20_TRANSFER']);
    expect(p.request.calls).toHaveLength(3);
    expect(p.request.calls.some(c => c.data.startsWith(BALANCE_OF_SELECTOR))).toBe(false);
    expect(p.simulation!.gasUsed).toHaveLength(3);
    const swap = p.group.calls[1] as { amountOutMinimum: string; quotedAmountOut: string };
    const minimum = BigInt(swap.amountOutMinimum), quoted = BigInt(swap.quotedAmountOut);
    expect(p.group.calls[2]).toMatchObject({ kind: 'ERC20_TRANSFER', amount: swap.amountOutMinimum });
    const hash = normal.chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    expect((await reconcileWalletBatch(normal.transport, p.group, [hash], p.fromBlock)).status).toBe('RECONCILED');

    // At today's price the pool sends the full quote: with a 10 bps fee the owner still receives MORE than the signed minimum, so a receipt
    // check against the minimum passes it. Exact receipt of what the pool sent refuses it (and a fee above the headroom, 100 bps, alike).
    expect(quoted - quoted * 10n / 10_000n).toBeGreaterThanOrEqual(minimum);
    for (const bps of [10n, 100n]) {
      const fee = arbitrum();
      fee.chain.control.fundToken(OWNER, WETH, 10n ** 16n);
      fee.chain.control.setTransferFeeBps(WETH, bps);
      expect(await fee.prepare(BOUND)).toMatchObject({ ok: false, code: 'SIMULATION_SWAP_OUTPUT_SHORT', stepIndex: 0 });
      expect(fee.chain.control.simulations()).toBe(1);
      expect(fee.chain.control.sends()).toBe(0);
      expect(fee.chain.control.tokenBalance(WETH, OWNER)).toBe(10n ** 16n);
    }

    // Why: the batch a minimum-based check would have offered on the 10 bps chain is these same calls (a transfer fee changes no quote). On
    // chain it may legally execute with the pool sending exactly the minimum; the owner then receives minimum × 99.9% and the bound transfer
    // of the minimum takes the difference from the owner's unrelated WETH.
    const harm = arbitrum();
    harm.chain.control.fundToken(OWNER, WETH, 10n ** 16n);
    const offered = await harm.prepare(BOUND);
    if (!offered.ok) throw new Error(offered.code);
    const q = offered.value.prepared as unknown as BatchPrepared;
    expect(evmCallsOf(q.group)).toEqual(evmCallsOf(p.group));
    const price = minimum * 1_000_000n / 3_000_000n;
    expect(3_000_000n * price / 1_000_000n).toBe(minimum);
    harm.chain.control.setPrice(price); harm.chain.control.setTransferFeeBps(WETH, 10n);
    const harmed = harm.chain.control.walletBatch(OWNER, evmCallsOf(q.group));
    expect(harm.chain.control.tokenBalance(WETH, OWNER)).toBe(10n ** 16n - minimum * 10n / 10_000n);
    expect((await reconcileWalletBatch(harm.transport, q.group, [harmed], q.fromBlock)).status).toBe('MISMATCH');
  });

  it('with the simulation, a fee-on-transfer swap output is refused even when nothing in the batch spends it (exact receipt, fail closed)', async () => {
    const fee = arbitrum();
    fee.chain.control.setTransferFeeBps(WETH, 10n);
    expect(await fee.prepare({ version: 2, steps: [SWAP] })).toMatchObject({ ok: false, code: 'SIMULATION_SWAP_OUTPUT_SHORT', stepIndex: 0 });
    expect(fee.chain.control.simulations()).toBe(1);
    expect(fee.chain.control.sends()).toBe(0);
  });

  it('without eth_simulateV1, a swap output spent by a later bound call is refused at the consuming step; a swap whose output stays is offered', async () => {
    // What reached the owner cannot be proven without the simulation, so the bound batch is refused whatever the token (fee-free included).
    for (const bps of [0n, 10n]) {
      const { chain, prepare } = arbitrum();
      chain.control.disableSimulation();
      chain.control.fundToken(OWNER, WETH, 10n ** 16n);
      chain.control.setTransferFeeBps(WETH, bps);
      expect(await prepare(BOUND)).toMatchObject({ ok: false, code: 'USER_FUNDED_SIMULATION_UNAVAILABLE', stepIndex: 1 });
      expect(chain.control.simulations()).toBe(0);
      expect(chain.control.sends()).toBe(0);
      expect(chain.control.tokenBalance(WETH, OWNER)).toBe(10n ** 16n);
    }
    // The swap alone is still offered without the simulation: the router enforces its minimum on chain; a fee-on-transfer output only reduces
    // what the owner keeps, and reconciliation records the amount that actually arrived.
    const { chain, transport, prepare } = arbitrum();
    chain.control.disableSimulation();
    chain.control.setTransferFeeBps(WETH, 10n);
    const r = await prepare({ version: 2, steps: [SWAP] });
    if (!r.ok) throw new Error(r.code);
    const p = r.value.prepared as unknown as BatchPrepared;
    expect(p.simulation).toBeNull();
    expect(p.group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE']);
    const quoted = BigInt((p.group.calls[1] as { quotedAmountOut: string }).quotedAmountOut), arrived = quoted - quoted * 10n / 10_000n;
    const hash = chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    const reconciled = await reconcileWalletBatch(transport, p.group, [hash], p.fromBlock);
    if (reconciled.status !== 'RECONCILED') throw new Error(JSON.stringify(reconciled));
    expect(reconciled.steps[0]!.received).toEqual([{ asset: `${CHAIN}/erc20:${WETH}`, amount: arrived.toString() }]);
    expect(chain.control.tokenBalance(WETH, OWNER)).toBe(arrived);
  });
});

describe('P0 universal execution: a batched ERC-20 transfer trusts the catalog and the chain, never the label', () => {
  const A = '0x4444444444444444444444444444444444444444', RH = 'eip155:4663';
  const transfer = (asset: string, amount: string, network = 'arbitrum-one') => ({ action: 'transfer', network, asset, amount, recipient: A });
  const stepOf = (s: Strategy) => {
    const r = workflowRequirement(s);
    if (!r.ok) throw new Error(r.code);
    return r.value.steps[0]!;
  };

  it('only a token a batched swap may spend is batched; a Stock Token, a token outside the catalog or other decimals run through their own flow', () => {
    const usdc = stepOf({ version: 2, steps: [transfer('USDC', '1')] }), input = usdc.inputs[0]!;
    expect(evmStepBuildable(usdc, CHAINS, OWNER)).toBeNull();
    // A native value transfer moves no token: unchanged.
    expect(evmStepBuildable(stepOf({ version: 2, steps: [transfer('ETH', '0.001')] }), CHAINS, OWNER)).toBeNull();
    // An address the network's catalog does not list, or the catalog token scaled with other decimals than its catalog entry's.
    expect(evmStepBuildable({ ...usdc, inputs: [{ ...input, address: '0x' + '7a'.repeat(20) }] }, CHAINS, OWNER)).toBe('USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED');
    expect(evmStepBuildable({ ...usdc, inputs: [{ ...input, decimals: 18 }] }, CHAINS, OWNER)).toBe('USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED');
    // A loopback test pair profile batches its registered USDC/WETH only (as its swaps do).
    const sepolia = { ...usdc, chain: BASE_SEPOLIA.chainRef };
    expect(evmStepBuildable({ ...sepolia, inputs: [{ ...input, chain: BASE_SEPOLIA.chainRef, address: BASE_SEPOLIA.usdc.toLowerCase() }] }, [BASE_SEPOLIA.chainRef], OWNER)).toBeNull();
    expect(evmStepBuildable({ ...sepolia, inputs: [{ ...input, chain: BASE_SEPOLIA.chainRef, address: '0x' + '7a'.repeat(20) }] }, [BASE_SEPOLIA.chainRef], OWNER))
      .toBe('USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED');
    // Robinhood Chain: a Stock Token transfer is refused (its own flow checks it); a listed token that is not one of its pinned assets is too.
    const official = officialCatalog(), usdgAsset = catalogAsset(official, { symbol: 'USDG' })!, listed = '0x' + '7a'.repeat(20);
    registerNetworkCatalog(createAssetCatalog({ chain: RH, network: official.network, provenance: official.provenance,
      assets: [...official.assets, { ...usdgAsset, id: erc20AssetId(RH, listed), address: listed, symbol: 'RHX', name: 'Listed token', source: { ...usdgAsset.source, officialId: null } }] }));
    try {
      const stock = stepOf({ version: 2, steps: [transfer('AAPL', '3', 'robinhood')] });
      expect(catalogAsset(official, { address: stock.inputs[0]!.address })).toMatchObject({ assetClass: 'STOCK_TOKEN' });
      expect(evmStepBuildable(stock, [RH], OWNER)).toBe('USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED');
      const usdg = stepOf({ version: 2, steps: [transfer('USDG', '2', 'robinhood')] });
      expect(evmStepBuildable(usdg, [RH], OWNER)).toBeNull();
      expect(evmStepBuildable({ ...usdg, inputs: [{ ...usdg.inputs[0]!, address: listed }] }, [RH], OWNER)).toBe('USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED');
      // A Stock Token transfer is never planned into a wallet batch.
      const r = workflowRequirement({ version: 2, steps: [transfer('USDG', '2', 'robinhood'), transfer('AAPL', '3', 'robinhood')] });
      if (!r.ok) throw new Error(r.code);
      const plan = planExecutionGroups(r.value, { enabled: true, code: null, chains: [RH], bundlerChains: [], solanaNonceAccounts: false },
        { eip155: { wallet: 'INJECTED', atomic: { [RH]: 'supported' }, typedData: true } }, st => evmStepBuildable(st, [RH], OWNER) ?? true);
      if (!plan.ok) throw new Error(plan.code);
      expect(plan.groups.filter(g => g.strategy === 'EVM_WALLET_BATCH' && g.stepFrom <= 1 && g.stepTo >= 1)).toEqual([]);
    } finally { resetNetworkCatalogs(); }
  });

  it('the token is verified on chain before the batch is built: no code, other decimals() or a failed read refuse; nothing is simulated or offered', async () => {
    const s: Strategy = { version: 2, steps: [transfer('USDC', '1'), transfer('USDC', '2'), transfer('WETH', '0.001')] };
    type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
    const prepareOn = async (tweak: (chain: ReturnType<typeof createEvmDouble>) => void, answer?: (method: string, params: readonly unknown[], chain: Rpc) => Promise<unknown>) => {
      const chain = createEvmDouble(42161, () => Math.floor(Date.parse(NOW) / 1000), { profile: ARBITRUM_MAINNET_SWAP });
      chain.control.fundToken(OWNER, USDC, 10_000_000n); chain.control.fundToken(OWNER, WETH, 10n ** 16n); chain.control.fundNative(OWNER, 10n ** 17n);
      tweak(chain);
      const reads: string[] = [];
      const transport = guarded(CHAIN, 'read', 'MOCKED', async (method, params) => {
        reads.push(method === 'eth_call' ? String((params[0] as { data: string }).data).slice(0, 10) : method);
        return answer ? answer(method, params, chain.rpc) : chain.rpc(method, params);
      });
      const deps: UserFundedDeps = { chains: CHAINS, evm: c => c === CHAIN ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(NOW) };
      const requirement = workflowRequirement(s), composition = composeWorkflowBound(s as never, undefined);
      if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
      const r = await prepareGroup(deps, composition, requirement.value, { runId: 'wfr_transfer_verify', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: CHAIN, feePayer: OWNER,
        stepFrom: 0, stepTo: 2 });
      return { r, chain, reads };
    };
    // Tokens that are what the catalog says: offered; each is read once (its code, then decimals()), however many transfers spend it.
    const fine = await prepareOn(() => undefined);
    if (!fine.r.ok) throw new Error(fine.r.code);
    expect((fine.r.value.prepared as unknown as BatchPrepared).group.calls.map(c => c.kind)).toEqual(['DEADLINE_GUARD', 'ERC20_TRANSFER', 'ERC20_TRANSFER', 'ERC20_TRANSFER']);
    expect(fine.reads.filter(r => r === '0x313ce567')).toHaveLength(2);
    expect(fine.reads.filter(r => r === 'eth_getCode')).toHaveLength(2);
    // No code at the catalog address, or decimals() that contradict the catalog: refused at the step that spends it, before any simulation.
    for (const [tweak, code, stepIndex] of [[(c: ReturnType<typeof createEvmDouble>) => c.control.setCode(USDC, '0x'), 'CONTRACT_CODE_MISSING', 0],
      [(c: ReturnType<typeof createEvmDouble>) => c.control.setCode(WETH, '0x'), 'CONTRACT_CODE_MISSING', 2],
      [(c: ReturnType<typeof createEvmDouble>) => c.control.setDecimals(USDC, 18), 'TOKEN_METADATA_MISMATCH', 0],
      [(c: ReturnType<typeof createEvmDouble>) => c.control.setDecimals(WETH, 6), 'TOKEN_METADATA_MISMATCH', 2]] as const) {
      const refused = await prepareOn(tweak);
      expect(refused.r).toMatchObject({ ok: false, code, stepIndex });
      expect(refused.chain.control.simulations()).toBe(0);
      expect(refused.chain.control.sends()).toBe(0);
    }
    // A read that fails or answers garbage says nothing about the token: USER_FUNDED_RPC_UNAVAILABLE, never a mismatch and never offered.
    const failing = (what: 'eth_getCode' | '0x313ce567', answer: () => unknown) => (method: string, params: readonly unknown[], chain: Rpc) =>
      (method === what || method === 'eth_call' && String((params[0] as { data: string }).data) === what) ? Promise.resolve().then(answer) : chain(method, params);
    for (const what of ['eth_getCode', '0x313ce567'] as const)
      for (const answer of [() => { throw new Error('over rate limit'); }, () => null]) {
        const refused = await prepareOn(() => undefined, failing(what, answer));
        expect(refused.r).toMatchObject({ ok: false, code: 'USER_FUNDED_RPC_UNAVAILABLE', stepIndex: 0 });
        expect(refused.chain.control.simulations()).toBe(0);
      }
  });
});

describe('P0 universal execution: a wallet batch without a swap (Aave calls, transfers) never silently loses its on-chain expiry', () => {
  it('without a registered router to carry the deadline guard, the wallet batch is refused (USER_FUNDED_DEADLINE_UNAVAILABLE)', async () => {
    const s = { version: 2, steps: [{ action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: '0.002', beneficiary: OWNER },
      { action: 'borrow', network: 'arbitrum-one', asset: 'USDC', amount: '1', beneficiary: OWNER }] };
    const requirement = workflowRequirement(s);
    if (!requirement.ok) throw new Error(requirement.code);
    const transport: ChainTransport = { chain: CHAIN, provenance: 'MOCKED', rpc: async method => {
      if (method === 'eth_call') return '0x' + '0'.repeat(64);
      // The two native transfers' recipients below are EOAs (no code).
      if (method === 'eth_getCode') return '0x';
      throw new Error(`UNEXPECTED_${method}`);
    } };
    const deps = { chains: CHAINS, owner: OWNER, transport: () => transport };
    // Every registered Aave market today (Ethereum, Base, Arbitrum One) has a registered router, so the case is reached by removing Arbitrum
    // One's catalog swap deployment from a fresh module graph (the builder then resolves no router for the chain).
    vi.resetModules();
    vi.doMock('../domain/public-testnet-swap.ts', async importOriginal => {
      const real = await importOriginal<typeof import('../domain/public-testnet-swap.ts')>();
      return { ...real, ARBITRUM_MAINNET_SWAP: { ...real.ARBITRUM_MAINNET_SWAP, router: '' } };
    });
    try {
      const { buildEvmGroupCalls } = await import('./evm-calls.ts');
      expect(await buildEvmGroupCalls(requirement.value, 0, 1, { ...deps, deadline: Math.floor(Date.parse(NOW) / 1000) + 600 }))
        .toEqual({ ok: false, stepIndex: 0, code: 'USER_FUNDED_DEADLINE_UNAVAILABLE' });
      // Without a deadline (a user operation, bounded otherwise) the same calls build as before.
      const unbounded = await buildEvmGroupCalls(requirement.value, 0, 1, deps);
      if (!unbounded.ok) throw new Error(unbounded.code);
      expect(unbounded.value.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'AAVE_V3_SUPPLY', 'AAVE_V3_BORROW']);
      // A batch of transfers only is held to the same rule: no guard, no batch.
      const transfers = workflowRequirement({ version: 2, steps: [{ action: 'transfer', network: 'arbitrum-one', asset: 'ETH', amount: '0.001', recipient: '0x' + '4'.repeat(40) },
        { action: 'transfer', network: 'arbitrum-one', asset: 'ETH', amount: '0.002', recipient: '0x' + '5'.repeat(40) }] });
      if (!transfers.ok) throw new Error(transfers.code);
      expect(await buildEvmGroupCalls(transfers.value, 0, 1, { ...deps, deadline: Math.floor(Date.parse(NOW) / 1000) + 600 }))
        .toEqual({ ok: false, stepIndex: 0, code: 'USER_FUNDED_DEADLINE_UNAVAILABLE' });
      const plain = await buildEvmGroupCalls(transfers.value, 0, 1, deps);
      if (!plain.ok) throw new Error(plain.code);
      expect(plain.value.calls.map(c => c.kind)).toEqual(['NATIVE_TRANSFER', 'NATIVE_TRANSFER']);
    } finally { vi.doUnmock('../domain/public-testnet-swap.ts'); vi.resetModules(); }
  });
});
