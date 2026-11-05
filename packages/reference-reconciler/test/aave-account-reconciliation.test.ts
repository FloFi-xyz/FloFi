// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD AAVE-V3-EXPANSION-001 (lending review): reconciliation of non-USDC reserves and multi-reserve accounts proves Aave's aggregates at each
 * block from that block's verified positions. Account-weighted LTV/threshold and collateral values legitimately change with the collateral mix
 * and with oracle prices, so a correct transaction is never DIVERGENT for that; the target reserve's own effects stay exact. Pure fixtures.
 */
import { describe, expect, it } from 'vitest';
import { aaveReserveProfile } from '@defi-workflow-engine/action-registry';
import { aaveAccountTotals, borrowHealthFactor, reserveFlags, type AavePosition, type BorrowState, type SupplyState } from '@defi-workflow-engine/reference-compiler';
import { verifyBorrowEffects, verifyWithdrawEffects } from '../src/index.js';

const RAY = 10n ** 27n;
const WETH = aaveReserveProfile('eip155:8453', '0x4200000000000000000000000000000000000006');
const USDC = aaveReserveProfile('eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
const config = (ltv: bigint, lt: bigint, decimals: number) => (ltv | (lt << 16n) | (BigInt(decimals) << 48n) | (1n << 56n) | (1n << 58n)).toString();
const WETH_CONFIG = config(8000n, 8300n, 18);
const usdcPosition = (supplied: string, debt: string): AavePosition => ({ reserveId: String(USDC.reserveId), asset: USDC.asset, decimals: '6', collateral: true, borrowing: BigInt(debt) > 0n,
  supplied, debt, price: '100000000', ltvBps: '7500', liquidationThresholdBps: '7800', debtCeiling: '0', siloed: false, reserveConfiguration: config(7500n, 7800n, 6) });
/** One block's state of a WETH (reserve 0) + USDC (reserve 4) account, with Aave's aggregates computed the way GenericLogic does. */
function block(n: number, weth: { supplied: bigint; collateral: boolean; debt: bigint; price: bigint; balance: bigint }, usdc: AavePosition): SupplyState {
  const flags = reserveFlags(WETH_CONFIG), totals = aaveAccountTotals([
    { collateral: weth.collateral, supplied: weth.supplied, debt: weth.debt, price: weth.price, scale: 10n ** 18n, ltv: flags.ltv, liquidationThreshold: flags.liquidationThreshold },
    { collateral: usdc.collateral, supplied: BigInt(usdc.supplied), debt: BigInt(usdc.debt), price: BigInt(usdc.price), scale: 10n ** 6n, ltv: 7500n, liquidationThreshold: 7800n }]);
  const capacity = (totals.collateralBase * totals.ltvBps + 5000n) / 10000n - totals.debtBase;
  const user = (weth.collateral ? 2n : 0n) | (weth.debt ? 1n : 0n) | (2n << 8n) | (BigInt(usdc.debt) ? 1n << 8n : 0n);
  const borrow: BorrowState = { collateralBase: totals.collateralBase.toString(), debtBase: totals.debtBase.toString(), availableBorrowBase: (capacity > 0n ? capacity : 0n).toString(),
    liquidationThresholdBps: totals.liquidationThresholdBps.toString(), ltvBps: totals.ltvBps.toString(),
    healthFactor: borrowHealthFactor(totals.collateralBase.toString(), totals.liquidationThresholdBps.toString(), totals.debtBase.toString()), price: weth.price.toString(),
    baseCurrencyUnit: '100000000', reserveConfiguration: WETH_CONFIG, userConfiguration: user.toString(), liquidity: (10n ** 30n).toString(), debt: weth.debt.toString(),
    scaledDebt: weth.debt.toString(), debtIndex: RAY.toString(), variableDebtToken: WETH.variableDebtToken, eMode: '0', debtTotalSupply: '0', codeHash: '0x00', positions: [usdc] };
  return { block: n, blockHash: '0x' + n.toString(16).padStart(64, '0'), account: '0x' + '2'.repeat(40), allowance: '0', balance: weth.balance.toString(), nativeBalance: '1', nonce: '1',
    gasPrice: '1', scaledPosition: weth.supplied.toString(), position: weth.supplied.toString(), index: RAY.toString(), deploymentHash: '0x00', observedAt: '2026-11-05T00:00:00.000Z',
    reserveConfiguration: WETH_CONFIG, borrow };
}
const ETH = 10n ** 18n, PRICE = 3000n * 10n ** 8n;

describe('BUILD AAVE-V3-EXPANSION-001 account-mode reconciliation', () => {
  it('reconciles a correct WETH withdrawal although the account-weighted liquidation threshold changes', () => {
    const usdc = usdcPosition('1000000000', '500000000');
    const pre = block(10, { supplied: ETH, collateral: true, debt: 0n, price: PRICE, balance: 0n }, usdc);
    const post = block(11, { supplied: ETH / 2n, collateral: true, debt: 0n, price: PRICE, balance: ETH / 2n }, usdc);
    expect([pre.borrow!.liquidationThresholdBps, post.borrow!.liquidationThresholdBps]).toEqual(['8175', '8100']);
    expect(verifyWithdrawEffects(String(ETH / 2n), pre, post, WETH)).toMatchObject({ walletDelta: String(ETH / 2n), collateralDelta: String(-ETH / 2n) });
  });
  it('still refuses a withdrawal whose own effects differ: wallet delta, other positions or account aggregates', () => {
    const usdc = usdcPosition('1000000000', '500000000');
    const pre = block(10, { supplied: ETH, collateral: true, debt: 0n, price: PRICE, balance: 0n }, usdc);
    const post = block(11, { supplied: ETH / 2n, collateral: true, debt: 0n, price: PRICE, balance: ETH / 2n }, usdc);
    expect(() => verifyWithdrawEffects(String(ETH / 2n), pre, { ...post, balance: String(ETH / 4n) }, WETH)).toThrow('WITHDRAW_WALLET_BALANCE_MISMATCH');
    expect(() => verifyWithdrawEffects(String(ETH / 2n), pre, { ...post, borrow: { ...post.borrow!, collateralBase: '1' } }, WETH)).toThrow();
    expect(() => verifyWithdrawEffects(String(ETH / 2n), pre, { ...post, borrow: { ...post.borrow!, positions: [{ ...usdc, collateral: false }] } }, WETH)).toThrow('WITHDRAW_ACCOUNT_MISMATCH');
  });
  it('reconciles a WETH borrow when the oracle price moves in the same block, proving the aggregates at each block', () => {
    const usdc = usdcPosition('10000000000', '0');
    const pre = block(10, { supplied: 0n, collateral: false, debt: 0n, price: PRICE, balance: 0n }, usdc);
    // ETH moves 0.6% in the borrow's block: a correct borrow is not a mismatch.
    const post = block(11, { supplied: 0n, collateral: false, debt: ETH / 10n, price: PRICE * 1006n / 1000n, balance: ETH / 10n }, usdc);
    expect(verifyBorrowEffects(String(ETH / 10n), pre, post, WETH)).toMatchObject({ walletDelta: String(ETH / 10n), debtDelta: String(ETH / 10n) });
    expect(() => verifyBorrowEffects(String(ETH / 10n), pre, { ...post, borrow: { ...post.borrow!, debtBase: '1' } }, WETH)).toThrow();
    expect(() => verifyBorrowEffects(String(ETH / 10n), pre, { ...post, balance: '1' }, WETH)).toThrow('BORROW_WALLET_BALANCE_MISMATCH');
  });
});
