// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD AAVE-V3-EXPANSION-001: multi-reserve Aave accounts. A borrow, repay or withdrawal of one reserve by an account that also uses other
 * reserves of the same market is previewed from Aave's account aggregates, after every other position is matched to its registered reserve
 * and the aggregates are recomputed independently. Pure state fixtures; no network.
 */
import { describe, expect, it } from 'vitest';
import { aaveReserveProfile } from '@defi-workflow-engine/action-registry';
import { aaveAccountTotals, assertAccountPositions, assertAccountTotals, borrowHealthFactor, compileSupplyCalls, estimateBorrow, estimateRepay, estimateWithdraw,
  inIsolationMode, lendingProfile, reserveFlags, supplyCall, type AavePosition, type BorrowState, type SupplyState } from '../src/index.js';
import { createSupplyNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';

const RAY = 10n ** 27n, UINT_MAX = ((1n << 256n) - 1n).toString();
const WETH = aaveReserveProfile('eip155:8453', '0x4200000000000000000000000000000000000006');
const USDC = aaveReserveProfile('eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
const GHO = aaveReserveProfile('eip155:8453', '0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee');
const OWNER = '0x' + '2'.repeat(40);
type Config = { ltv?: bigint; lt?: bigint; decimals: number; borrowing?: boolean; frozen?: boolean; siloed?: boolean; debtCeiling?: bigint };
const config = (c: Config) => ((c.ltv ?? 0n) | ((c.lt ?? 0n) << 16n) | (BigInt(c.decimals) << 48n) | (1n << 56n) | ((c.frozen ? 1n : 0n) << 57n) |
  ((c.borrowing ?? true ? 1n : 0n) << 58n) | ((c.siloed ? 1n : 0n) << 62n) | ((c.debtCeiling ?? 0n) << 212n)).toString();
const bit = (id: number, kind: 'borrow' | 'collateral') => (kind === 'borrow' ? 1n : 2n) << (2n * BigInt(id));
function position(p: typeof USDC, fields: { supplied?: string; debt?: string; price: string; collateral?: boolean; ltv: bigint; lt: bigint; debtCeiling?: bigint; siloed?: boolean }): AavePosition {
  const reserveConfiguration = config({ ltv: fields.ltv, lt: fields.lt, decimals: p.decimals, debtCeiling: fields.debtCeiling, siloed: fields.siloed });
  return { reserveId: String(p.reserveId), asset: p.asset, decimals: String(p.decimals), collateral: fields.collateral ?? true, borrowing: BigInt(fields.debt ?? '0') > 0n,
    supplied: fields.supplied ?? '0', debt: fields.debt ?? '0', price: fields.price, ltvBps: fields.ltv.toString(), liquidationThresholdBps: fields.lt.toString(),
    debtCeiling: (fields.debtCeiling ?? 0n).toString(), siloed: Boolean(fields.siloed), reserveConfiguration };
}
/** Aave's own account view for a target reserve plus `positions`, computed as GenericLogic does (E-Mode 0). */
function account(target: { supplied: bigint; collateral: boolean; debt: bigint; price: bigint; config: string }, positions: AavePosition[], profile = WETH) {
  const flags = reserveFlags(target.config), scale = 10n ** BigInt(profile.decimals);
  const totals = aaveAccountTotals([{ collateral: target.collateral, supplied: target.supplied, debt: target.debt, price: target.price, scale, ltv: flags.ltv, liquidationThreshold: flags.liquidationThreshold },
    ...positions.map(p => ({ collateral: p.collateral, supplied: BigInt(p.supplied), debt: BigInt(p.debt), price: BigInt(p.price), scale: 10n ** BigInt(p.decimals),
      ltv: BigInt(p.ltvBps), liquidationThreshold: BigInt(p.liquidationThresholdBps) }))]);
  const capacity = (totals.collateralBase * totals.ltvBps + 5000n) / 10000n - totals.debtBase;
  const user = positions.reduce((bits, p) => bits | (p.collateral ? bit(Number(p.reserveId), 'collateral') : 0n) | (p.borrowing ? bit(Number(p.reserveId), 'borrow') : 0n),
    (target.collateral ? bit(profile.reserveId, 'collateral') : 0n) | (target.debt ? bit(profile.reserveId, 'borrow') : 0n));
  const borrow: BorrowState = { collateralBase: totals.collateralBase.toString(), debtBase: totals.debtBase.toString(), availableBorrowBase: (capacity > 0n ? capacity : 0n).toString(),
    liquidationThresholdBps: totals.liquidationThresholdBps.toString(), ltvBps: totals.ltvBps.toString(),
    healthFactor: borrowHealthFactor(totals.collateralBase.toString(), totals.liquidationThresholdBps.toString(), totals.debtBase.toString()),
    price: target.price.toString(), baseCurrencyUnit: '100000000', reserveConfiguration: target.config, userConfiguration: user.toString(), liquidity: (10n ** 30n).toString(),
    debt: target.debt.toString(), scaledDebt: target.debt.toString(), debtIndex: RAY.toString(), variableDebtToken: profile.variableDebtToken, eMode: '0', debtTotalSupply: '0', codeHash: '0x00',
    ...positions.length ? { positions } : {} };
  const state: SupplyState = { block: 100, blockHash: '0x' + '1'.repeat(64), account: OWNER, allowance: '0', balance: '0', nativeBalance: (10n ** 18n).toString(), nonce: '1', gasPrice: '1',
    scaledPosition: target.supplied.toString(), position: target.supplied.toString(), index: RAY.toString(), deploymentHash: '0x00', observedAt: '2026-11-05T00:00:00.000Z',
    reserveConfiguration: target.config, borrow };
  return state;
}
const WETH_CONFIG = config({ ltv: 8000n, lt: 8300n, decimals: 18 });
const usdcCollateral = position(USDC, { supplied: '1000000000', price: '100000000', ltv: 7500n, lt: 7800n });

describe('BUILD AAVE-V3-EXPANSION-001 multi-reserve accounts', () => {
  it('borrows WETH against USDC supplied as collateral in another reserve (18 vs 6 decimals)', () => {
    const state = account({ supplied: 0n, collateral: false, debt: 0n, price: 3000n * 10n ** 8n, config: WETH_CONFIG }, [usdcCollateral]);
    assertAccountPositions(state.borrow!, WETH, 'X');
    assertAccountTotals(state.position, state.borrow!, WETH);
    expect(state.borrow).toMatchObject({ collateralBase: '100000000000', ltvBps: '7500', liquidationThresholdBps: '7800', healthFactor: UINT_MAX });
    // 0.01 WETH at 3000 USD: 30 USD of debt (8-decimal base currency, rounded up), health factor 1000 × 0.78 / 30 = 26.
    expect(estimateBorrow('10000000000000000', state.borrow!, WETH)).toEqual({ borrowValueBase: '3000000000', debtAfterBase: '3000000000', healthFactorAfter: '26000000000000000000' });
    // Above capacity or below Flofi's minimum health factor of 2.0: refused.
    expect(() => estimateBorrow('30000000000000000000', state.borrow!, WETH)).toThrow('BORROW_ABOVE_CAPACITY');
    // 0.2 WETH (600 USD) is within the 750 USD capacity but leaves HF 1.3.
    expect(() => estimateBorrow('200000000000000000', state.borrow!, WETH)).toThrow('BORROW_UNSAFE_HEALTH_FACTOR');
  });
  it('fails closed when the other positions do not describe exactly the account bits, a registered reserve or Aave\'s aggregates', () => {
    const state = account({ supplied: 0n, collateral: false, debt: 0n, price: 3000n * 10n ** 8n, config: WETH_CONFIG }, [usdcCollateral]);
    const { positions, ...single } = state.borrow!;
    expect(() => estimateBorrow('1000', single as BorrowState, WETH)).toThrow('BORROW_STATE_UNSUPPORTED');
    expect(() => estimateBorrow('1000', { ...state.borrow!, positions: [{ ...positions![0]!, reserveId: '5' }] }, WETH)).toThrow('BORROW_STATE_UNSUPPORTED');
    expect(() => estimateBorrow('1000', { ...state.borrow!, positions: [{ ...positions![0]!, asset: '0x' + '9'.repeat(40) }] }, WETH)).toThrow('BORROW_STATE_UNSUPPORTED');
    expect(() => estimateBorrow('1000', { ...state.borrow!, positions: [{ ...positions![0]!, decimals: '18' }] }, WETH)).toThrow('BORROW_STATE_UNSUPPORTED');
    expect(() => estimateBorrow('1000', { ...state.borrow!, positions: [{ ...positions![0]!, price: '0' }] }, WETH)).toThrow('BORROW_STATE_UNSUPPORTED');
    expect(() => estimateBorrow('1000', { ...state.borrow!, eMode: '1' }, WETH)).toThrow();
    expect(() => assertAccountTotals(state.position, { ...state.borrow!, collateralBase: '100000001000' }, WETH)).toThrow('BORROW_STATE_INVALID');
    expect(() => assertAccountTotals(state.position, { ...state.borrow!, liquidationThresholdBps: '7900' }, WETH)).toThrow('BORROW_STATE_INVALID');
  });
  it('refuses isolation-mode collateral and siloed-borrowing conflicts', () => {
    const isolated = position(USDC, { supplied: '1000000000', price: '100000000', ltv: 7500n, lt: 7800n, debtCeiling: 100000n });
    const iso = account({ supplied: 0n, collateral: false, debt: 0n, price: 3000n * 10n ** 8n, config: WETH_CONFIG }, [isolated]);
    expect(inIsolationMode(iso.borrow!, WETH)).toBe(true);
    expect(() => estimateBorrow('10000000000000000', iso.borrow!, WETH)).toThrow('BORROW_ISOLATION_MODE_UNSUPPORTED');
    const ghoDebt = position(GHO, { debt: '10000000000000000000', price: '100000000', collateral: false, ltv: 0n, lt: 0n });
    const siloedTarget = account({ supplied: 0n, collateral: false, debt: 0n, price: 3000n * 10n ** 8n, config: config({ ltv: 8000n, lt: 8300n, decimals: 18, siloed: true }) }, [usdcCollateral, ghoDebt]);
    expect(() => estimateBorrow('10000000000000000', siloedTarget.borrow!, WETH)).toThrow('BORROW_SILOED_CONFLICT');
    const siloedOther = account({ supplied: 0n, collateral: false, debt: 0n, price: 3000n * 10n ** 8n, config: WETH_CONFIG }, [usdcCollateral, { ...ghoDebt, siloed: true,
      reserveConfiguration: config({ ltv: 0n, lt: 0n, decimals: 18, siloed: true }) }]);
    expect(() => estimateBorrow('10000000000000000', siloedOther.borrow!, WETH)).toThrow('BORROW_SILOED_CONFLICT');
  });
  it('refuses a Borrow of a frozen reserve or one with borrowing disabled, without collateral or above the borrow cap', () => {
    const base = { supplied: 0n, collateral: false, debt: 0n, price: 3000n * 10n ** 8n };
    expect(() => estimateBorrow('1000', account({ ...base, config: config({ ltv: 8000n, lt: 8300n, decimals: 18, frozen: true }) }, [usdcCollateral]).borrow!, WETH)).toThrow('BORROW_RESERVE_UNAVAILABLE');
    expect(() => estimateBorrow('1000', account({ ...base, config: config({ ltv: 8000n, lt: 8300n, decimals: 18, borrowing: false }) }, [usdcCollateral]).borrow!, WETH)).toThrow('BORROW_RESERVE_UNAVAILABLE');
    const capped = (BigInt(WETH_CONFIG) | (1n << 80n)).toString();
    expect(() => estimateBorrow('2000000000000000000', account({ ...base, config: capped }, [usdcCollateral]).borrow!, WETH)).toThrow('BORROW_CAP_EXCEEDED');
    const nothing = account({ ...base, config: WETH_CONFIG }, [position(USDC, { supplied: '1000000000', price: '100000000', ltv: 7500n, lt: 7800n, collateral: false, debt: '1' })]);
    expect(() => estimateBorrow('1000', nothing.borrow!, WETH)).toThrow();
  });
  it('repays part of a WETH debt while the account also owes another reserve: the post-repay health factor includes the other debt', () => {
    const usdcBoth = position(USDC, { supplied: '1000000000', debt: '100000000', price: '100000000', ltv: 7500n, lt: 7800n });
    const state = account({ supplied: 0n, collateral: false, debt: 10n ** 17n, price: 3000n * 10n ** 8n, config: WETH_CONFIG }, [usdcBoth]);
    expect(state.borrow).toMatchObject({ debtBase: '40000000000', collateralBase: '100000000000' });
    // 0.05 WETH of 0.1 WETH: 150 USD of WETH debt remains plus 100 USD of USDC debt → HF = 1000 × 0.78 / 250.
    expect(estimateRepay('50000000000000000', state.borrow!, WETH)).toEqual({ debtAfter: '50000000000000000', debtAfterBase: '25000000000', healthFactorAfter: '3120000000000000000' });
    expect(() => estimateRepay(String(10n ** 17n), state.borrow!, WETH)).toThrow('REPAY_PARTIAL_DEBT_REQUIRED');
    const { positions: _ignored, ...single } = state.borrow!; void _ignored;
    expect(() => estimateRepay('1000', single as BorrowState, WETH)).toThrow('REPAY_STATE_UNSUPPORTED');
  });
  it('withdraws WETH collateral with the collateral-weighted liquidation threshold of the remaining reserves', () => {
    const usdcBoth = position(USDC, { supplied: '1000000000', debt: '500000000', price: '100000000', ltv: 7500n, lt: 7800n });
    const state = account({ supplied: 10n ** 18n, collateral: true, debt: 0n, price: 3000n * 10n ** 8n, config: WETH_CONFIG }, [usdcBoth]);
    expect(state.borrow).toMatchObject({ collateralBase: '400000000000', liquidationThresholdBps: '8175', ltvBps: '7875', debtBase: '50000000000' });
    // Withdraw 0.5 WETH: 1500 + 1000 USD of collateral remain, weighted LT 81%, against 500 USD of debt → HF 4.05.
    expect(estimateWithdraw('500000000000000000', state, WETH)).toEqual({ collateralAfter: '500000000000000000', collateralAfterBase: '250000000000',
      healthFactorAfter: '4050000000000000000', walletAfter: '500000000000000000' });
    // 0.95 WETH would leave 1150 USD of collateral at a weighted 78.65% against 500 USD: HF 1.81.
    expect(() => estimateWithdraw('950000000000000000', state, WETH)).toThrow('WITHDRAW_UNSAFE_HEALTH_FACTOR');
  });
  it('withdraws a supplied reserve that is not collateral without changing the health factor', () => {
    const usdcBoth = position(USDC, { supplied: '1000000000', debt: '100000000', price: '100000000', ltv: 7500n, lt: 7800n });
    const state = account({ supplied: 10n ** 18n, collateral: false, debt: 0n, price: 3000n * 10n ** 8n, config: WETH_CONFIG }, [usdcBoth]);
    expect(estimateWithdraw('400000000000000000', state, WETH)).toMatchObject({ healthFactorAfter: state.borrow!.healthFactor, collateralAfter: '600000000000000000' });
  });
  it('every accepted Supply has an exit: a reserve supplied without collateral, or an isolated reserve, can be withdrawn (lending review)', () => {
    // Single-reserve account, WETH supplied but not enabled as collateral (e.g. Aave did not enable it automatically): HF stays unchanged.
    const plain = account({ supplied: 10n ** 18n, collateral: false, debt: 0n, price: 3000n * 10n ** 8n, config: WETH_CONFIG }, []);
    expect(plain.borrow).toMatchObject({ collateralBase: '0', userConfiguration: '0', healthFactor: UINT_MAX });
    expect(estimateWithdraw('400000000000000000', plain, WETH)).toMatchObject({ collateralAfter: '600000000000000000', collateralAfterBase: '0', healthFactorAfter: UINT_MAX });
    // An isolated reserve (debt ceiling) used as collateral: withdrawable while the health factor stays above FloFi's minimum.
    const isolatedConfig = config({ ltv: 8000n, lt: 8300n, decimals: 18, debtCeiling: 1_000_000n });
    const isolated = account({ supplied: 10n ** 18n, collateral: true, debt: 0n, price: 3000n * 10n ** 8n, config: isolatedConfig }, []);
    expect(estimateWithdraw('500000000000000000', isolated, WETH)).toMatchObject({ collateralAfter: '500000000000000000' });
  });
  it('compiles exact calls for the authored reserve and refuses a chain-only or foreign-asset resolution', () => {
    const flow = (asset: { chainId: string; address: string; decimals: number }): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'w', revision: 0,
      nodes: [createSupplyNode('s', { chain: 'eip155:8453', asset, amount: '1000', beneficiary: OWNER })], resourceEdges: [] });
    expect(compileSupplyCalls(flow({ chainId: 'eip155:8453', address: WETH.asset, decimals: 18 }), OWNER, '0').map(tx => [tx.to, tx.data])).toEqual([
      [WETH.asset, supplyCall('approve(address,uint256)', WETH.pool, 1000n)], [WETH.pool, supplyCall('supply(address,uint256,address,uint16)', WETH.asset, 1000n, OWNER, 0n)]]);
    expect(() => compileSupplyCalls(flow({ chainId: 'eip155:8453', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18 }), OWNER, '0')).toThrow('SUPPLY_DEPLOYMENT_UNSUPPORTED');
    expect(() => compileSupplyCalls(flow({ chainId: 'eip155:8453', address: WETH.asset, decimals: 6 }), OWNER, '0')).toThrow('SUPPLY_DEPLOYMENT_UNSUPPORTED');
    expect(lendingProfile('eip155:8453', 'X', { address: WETH.asset.toUpperCase().replace('0X', '0x'), decimals: 18 })).toBe(WETH);
    expect(() => lendingProfile('eip155:8453', 'X', { decimals: 18 })).toThrow('X');
  });
});
