// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 workflow execution (the owner's production report, 2026-11-08): Swap 3 USDC → WETH, Supply the swap's WETH to Aave V3 and Borrow 0.8 USDC
 * on Arbitrum One, prepared as ONE user-funded EIP-5792 wallet batch — exact calls from the registered profiles, approvals only where the
 * owner's current allowance does not already cover the spend, the whole batch simulated before signing (each swap at or above its signed
 * minimum, the owner's Aave health factor at least 2.0 after the borrow), then executed by the owner's own account and reconciled from the chain.
 *
 * MOCKED loopback chain double (Arbitrum One identities, a modelled Aave V3 Pool); nothing reaches a network and nothing is signed.
 */
import { describe, expect, it } from 'vitest';
import { erc7710 } from '@defi-workflow-engine/reference-compiler';
import { ARBITRUM_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { guarded } from '../delegation/chains.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { delegationAavePool, delegationAaveReserve } from '../delegation/profiles.ts';
import { workflowRequirement } from '../delegation/steps.ts';
import { composeWorkflowBound } from '../engine/strategy-engine.ts';
import { evmCallsOf, evmStepBuildable, type EvmGroupCalls } from './evm-calls.ts';
import { reconcileWalletBatch } from './evm-reconcile.ts';
import { prepareGroup, reconcileEvmGroup, supersede, type Prepared, type UserFundedDeps } from './groups.ts';
import { simulationFailureKind, type BatchSimulation } from './batch-simulation.ts';

const CHAIN = 'eip155:42161', CHAINS = [CHAIN], OWNER = '0x1111111111111111111111111111111111111111';
const USDC = ARBITRUM_MAINNET_SWAP.usdc, WETH = ARBITRUM_MAINNET_SWAP.weth, ROUTER = ARBITRUM_MAINNET_SWAP.router;
const POOL = delegationAavePool(CHAIN, CHAINS)!;
const reserve = (asset: string) => delegationAaveReserve(CHAIN, POOL, asset)!;
// Oracle prices in the base currency (8 decimals): ETH 2,500 USD (the double quotes 1 USDC = 0.0004 WETH), USDC 1 USD.
const RESERVES = [{ ...reserve(WETH), price: 2_500n * 10n ** 8n, ltvBps: 8_000n, liquidationThresholdBps: 8_300n, decimals: 18 },
  { ...reserve(USDC), price: 10n ** 8n, ltvBps: 7_500n, liquidationThresholdBps: 7_800n, decimals: 6 }];

function strategy(borrow = '0.8', supply = '0.0013') {
  return { version: 2, steps: [{ action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 },
    { action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: supply, beneficiary: OWNER },
    { action: 'borrow', network: 'arbitrum-one', asset: 'USDC', amount: borrow, beneficiary: OWNER }], bindings: [{ step: 1, amountFrom: 0 }] };
}
function setup(options: { borrow?: string; simulation?: boolean } = {}) {
  const chain = createEvmDouble(42161, undefined, { profile: ARBITRUM_MAINNET_SWAP, aave: { pool: POOL, reserves: RESERVES } });
  if (options.simulation === false) chain.control.disableSimulation();
  chain.control.fundToken(OWNER, USDC, 10_000_000n); chain.control.fundNative(OWNER, 10n ** 17n);
  const s = strategy(options.borrow);
  const requirement = workflowRequirement(s), composition = composeWorkflowBound(s as never, undefined);
  if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
  const transport = guarded(CHAIN, 'read', 'MOCKED', chain.rpc);
  const deps: UserFundedDeps = { chains: CHAINS, evm: c => c === CHAIN ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date('2026-11-08T21:00:00Z') };
  const prepare = () => prepareGroup(deps, composition, requirement.value, { runId: 'wfr_test', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: CHAIN, feePayer: OWNER,
    stepFrom: 0, stepTo: 2 });
  return { chain, requirement: requirement.value, transport, prepare, deps };
}
type BatchPrepared = { group: EvmGroupCalls; request: { calls: { to: string; data: string }[]; atomicRequired: boolean }; simulation: BatchSimulation | null;
  fee: { estimatedGas: string; payer: string }; fromBlock: string };

describe('P0: Arbitrum One Swap → Supply (the swap\'s WETH) → Borrow as ONE owner wallet batch', () => {
  it('every step is buildable for the owner\'s own wallet, and an Aave step for another beneficiary is refused at planning', () => {
    const { requirement } = setup();
    expect(requirement.steps.map(s => evmStepBuildable(s, CHAINS, OWNER))).toEqual([null, null, null]);
    expect(evmStepBuildable(requirement.steps[1]!, CHAINS, '0x2222222222222222222222222222222222222222')).toBe('AAVE_BENEFICIARY_NOT_OWNER');
    expect(evmStepBuildable({ ...requirement.steps[0]!, slippageBps: 301 }, CHAINS, OWNER)).toBe('WORKFLOW_SLIPPAGE_UNSUPPORTED');
  });

  it('prepares the 5 exact calls, simulates the whole batch (health factor ≥ 2) and reconciles each step from the chain', async () => {
    const { chain, transport, prepare } = setup();
    const r = await prepare();
    if (!r.ok) throw new Error(r.code);
    const p = r.value.prepared as unknown as BatchPrepared;
    expect(p.group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE', 'ERC20_APPROVE', 'AAVE_V3_SUPPLY', 'AAVE_V3_BORROW']);
    const swap = p.group.calls[1] as { amountIn: string; amountOutMinimum: string; quotedAmountOut: string };
    const supply = p.group.calls[3] as { amount: string }, borrow = p.group.calls[4] as { amount: string };
    // 3 USDC quotes 0.0012 WETH; the supply spends exactly the swap's signed minimum (below the 0.0013 cap); the borrow is exactly 0.8 USDC.
    expect(swap).toMatchObject({ amountIn: '3000000', quotedAmountOut: '1200000000000000' });
    expect(BigInt(swap.amountOutMinimum)).toBe((1_200_000_000_000_000n * 9_950n + 9_999n) / 10_000n);
    expect(supply.amount).toBe(swap.amountOutMinimum);
    expect(borrow.amount).toBe('800000');
    expect(p.group.calls[0]).toMatchObject({ token: USDC, spender: ROUTER, amount: '3000000' });
    expect(p.group.calls[2]).toMatchObject({ token: WETH, spender: POOL, amount: swap.amountOutMinimum });
    // One atomic request, no capabilities (no paymaster, no sponsor): the owner's own account sends it and pays its fee.
    expect(p.request).toMatchObject({ atomicRequired: true });
    expect(p.request).not.toHaveProperty('capabilities');
    expect(p.fee.payer).toBe(OWNER);
    // The whole batch was simulated before anything was offered: every call succeeded, the swap met its minimum, and the owner's Aave
    // health factor after the borrow (read from the Pool after the supply) is at least 2.0.
    expect(chain.control.simulations()).toBe(1);
    expect(p.simulation?.gasUsed).toHaveLength(5);
    expect(BigInt(p.simulation!.outputs[1]!)).toBeGreaterThanOrEqual(BigInt(swap.amountOutMinimum));
    const hf = BigInt(p.simulation!.healthFactorAfter[POOL.toLowerCase()]!);
    expect(hf).toBeGreaterThanOrEqual(2n * 10n ** 18n);
    expect(BigInt(p.fee.estimatedGas)).toBe(p.simulation!.gasUsed.reduce((sum, g) => sum + BigInt(g), 0n) + 30_000n);
    // The simulation changed nothing on chain.
    expect(chain.control.tokenBalance(USDC, OWNER)).toBe(10_000_000n);
    expect(chain.control.accountData(OWNER).debt).toBe(0n);

    // The owner's wallet executes exactly these calls (one transaction from its own account); FloFi reconciles every step from the chain.
    const hash = chain.control.walletBatch(OWNER, evmCallsOf(p.group));
    const reconciled = await reconcileWalletBatch(transport, p.group, [hash], p.fromBlock);
    if (reconciled.status !== 'RECONCILED') throw new Error(JSON.stringify(reconciled));
    expect(reconciled.steps).toEqual([
      { stepIndex: 0, spent: [{ asset: `${CHAIN}/erc20:${USDC}`, amount: '3000000' }], received: [{ asset: `${CHAIN}/erc20:${WETH}`, amount: '1200000000000000' }] },
      { stepIndex: 1, spent: [{ asset: `${CHAIN}/erc20:${WETH}`, amount: swap.amountOutMinimum }], received: [] },
      { stepIndex: 2, spent: [], received: [{ asset: `${CHAIN}/erc20:${USDC}`, amount: '800000' }] }]);
    expect(reconciled.gasPaid.payer).toBe(OWNER);
    // What the swap delivered above its signed minimum stayed in the owner's wallet.
    expect(chain.control.tokenBalance(WETH, OWNER)).toBe(1_200_000_000_000_000n - BigInt(swap.amountOutMinimum));
    expect(chain.control.accountData(OWNER).hf).toBe(hf);
  });

  it('an allowance that already covers a spend is never approved again (Scenario D); a too-small one is reset to 0 first', async () => {
    const covered = setup();
    covered.chain.control.setAllowance(USDC, OWNER, ROUTER, 10n ** 12n);
    covered.chain.control.setAllowance(WETH, OWNER, POOL, 10n ** 30n);
    const a = await covered.prepare();
    if (!a.ok) throw new Error(a.code);
    expect((a.value.prepared as unknown as BatchPrepared).group.calls.map(c => c.kind)).toEqual(['UNISWAP_V3_EXACT_INPUT_SINGLE', 'AAVE_V3_SUPPLY', 'AAVE_V3_BORROW']);
    const short = setup();
    short.chain.control.setAllowance(USDC, OWNER, ROUTER, 1n);
    const b = await short.prepare();
    if (!b.ok) throw new Error(b.code);
    expect((b.value.prepared as unknown as BatchPrepared).group.calls.slice(0, 3)).toEqual([
      { kind: 'ERC20_APPROVE', token: USDC, spender: ROUTER, amount: '0' }, { kind: 'ERC20_APPROVE', token: USDC, spender: ROUTER, amount: '3000000' },
      expect.objectContaining({ kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE' })]);
    expect(erc7710.workflowCallData({ kind: 'ERC20_APPROVE', token: USDC, spender: ROUTER, amount: 0n }, OWNER).data.endsWith('0'.repeat(64))).toBe(true);
  });

  it('a borrow that would leave the health factor below 2.0 is refused before anything is offered (Scenario G)', async () => {
    // 1.4 USDC against ~2.99 USD of WETH collateral: Aave itself would allow it (LTV 80%), FloFi's owner-signed Borrow minimum does not.
    const { chain, prepare } = setup({ borrow: '1.4' });
    const r = await prepare();
    expect(r).toMatchObject({ ok: false, code: 'BORROW_UNSAFE_HEALTH_FACTOR', stepIndex: 2 });
    expect(chain.control.sends()).toBe(0);
  });

  it('a borrow beyond the collateral is refused by the simulation with the failing step (nothing is signed blind)', async () => {
    const { prepare } = setup({ borrow: '5' });
    expect(await prepare()).toMatchObject({ ok: false, code: 'SIMULATION_REVERTED', stepIndex: 2 });
  });

  it('without eth_simulateV1 on the RPC, a batch that touches Aave is refused with a closed code instead of being signed blind', async () => {
    const { prepare } = setup({ simulation: false });
    expect(await prepare()).toMatchObject({ ok: false, code: 'USER_FUNDED_SIMULATION_UNAVAILABLE', stepIndex: 1 });
  });

  it('a batch the wallet sent before the group was prepared again (its answer lost, then expired) reconciles against the preparation it came from', async () => {
    const { chain, prepare, deps } = setup();
    const first = await prepare();
    if (!first.ok) throw new Error(first.code);
    const a = first.value.prepared as unknown as BatchPrepared;
    // The wallet executes the first preparation; FloFi never learns it (the answer was lost) and, after expiry, prepares the group again
    // under the SAME EIP-5792 id from a moved price: a new quote, a new signed minimum, so a different artifact.
    const hash = chain.control.walletBatch(OWNER, evmCallsOf(a.group));
    chain.control.setPrice(390_000_000_000_000n);
    const second = await prepare();
    if (!second.ok) throw new Error(second.code);
    const b = second.value.prepared as unknown as BatchPrepared;
    expect((b.group.calls[1] as { amountOutMinimum: string }).amountOutMinimum).not.toBe((a.group.calls[1] as { amountOutMinimum: string }).amountOutMinimum);
    // Without the earlier preparation, the first batch's transaction would fail the group although every step ran on chain.
    expect(await reconcileEvmGroup(deps, second.value.prepared, { hashes: [hash] })).toMatchObject({ status: 'FAILED', code: 'RECONCILIATION_CALLS_MISMATCH' });
    // The re-preparation keeps the replaced artifact; the batch reconciles against it, with the minimums signed then.
    const kept: Prepared = { ...second.value.prepared, superseded: supersede(first.value.prepared) };
    const r = await reconcileEvmGroup(deps, kept, { hashes: [hash] });
    if (r.status !== 'RECONCILED') throw new Error(JSON.stringify(r));
    expect(r.steps.map(s => s.stepIndex)).toEqual([0, 1, 2]);
    expect(r.steps[1]!.spent).toEqual([{ asset: `${CHAIN}/erc20:${WETH}`, amount: (a.group.calls[1] as { amountOutMinimum: string }).amountOutMinimum }]);
    // A transaction that is neither preparation's batch still fails closed.
    const other = chain.control.walletBatch(OWNER, [erc7710.workflowCallData({ kind: 'ERC20_APPROVE', token: USDC, spender: ROUTER, amount: 1n }, OWNER)]);
    expect(await reconcileEvmGroup(deps, kept, { hashes: [other] })).toMatchObject({ status: 'FAILED' });
    // At most a bounded history is kept.
    let chained: Prepared = first.value.prepared;
    for (let i = 0; i < 12; i++) chained = { ...second.value.prepared, superseded: supersede(chained) };
    expect((chained.superseded as unknown[]).length).toBe(8);
  });

  it('only a method-level refusal means the RPC cannot simulate; a lagging node is a transient RPC failure', () => {
    for (const m of ['the method eth_simulateV1 does not exist/is not available', 'Method not found', 'unknown method eth_simulateV1', 'eth_simulateV1 is not supported',
      'DELEGATION_RPC_METHOD_FORBIDDEN']) expect(simulationFailureKind(m)).toBe('UNSUPPORTED');
    for (const m of ['header not found', 'block not found', 'unknown block']) expect(simulationFailureKind(m)).toBe('LAGGING');
    expect(simulationFailureKind('execution reverted')).toBe('OTHER');
  });
});
