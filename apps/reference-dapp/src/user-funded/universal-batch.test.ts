// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 universal execution: Aave V3 Repay and Withdraw in the owner's own user-funded wallet batch, composed with the other batch actions — exact
 * calls from the registered reserve profiles, the owner-signed lending flows' own rules (a PARTIAL repayment of the owner's variable debt; a
 * health factor of at least 2.0 after a withdrawal, proven by the whole-batch simulation), approvals only where the current allowance does not
 * cover the spend, and reconciliation from the chain (Aave's debt-token and aToken burns are protocol legs, never an unexpected owner outflow).
 *
 * MOCKED loopback chain double (Arbitrum One identities, a modelled Aave V3 Pool); nothing reaches a network and nothing is signed.
 */
import { describe, expect, it } from 'vitest';
import { ARBITRUM_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { guarded } from '../delegation/chains.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { delegationAavePool, delegationAaveReserve } from '../delegation/profiles.ts';
import { workflowRequirement } from '../delegation/steps.ts';
import { composeWorkflowBound } from '../engine/strategy-engine.ts';
import { planExecutionGroups } from '../workflow-runs/execution-groups.ts';
import { evmCallsOf, evmStepBuildable, type EvmGroupCalls } from './evm-calls.ts';
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
