// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { UniswapTx } from '../server/uniswap-liquidity-service';
import { uniswapLiquidityChainHex, uniswapLiquidityWalletTransactionMatches } from './uniswap-liquidity-eip1193';

const tx: UniswapTx = { chainId: '0xa4b1', from: '0x' + '1'.repeat(40), to: '0xc36442b4a4522e871399cd717abdd847ab11fe88',
  data: '0x88316456', gas: '0xb71b0', value: '0x0', maxFeePerGas: '0x1e8480', maxPriorityFeePerGas: '0x0' };
const review = { chainId: 42161, owner: tx.from, calls: [{ step: 'MINT' as const, to: tx.to, data: tx.data, gasLimit: '750000' }],
  fees: { maxFeePerGas: '2000000', maxPriorityFeePerGas: '0' } };
describe('shared Uniswap owner-wallet envelope', () => {
  it('uses each reviewed chain profile; no Base or testnet fallback for Arbitrum', () => {
    for (const [chain, expected] of [[42161, '0xa4b1'], ['eip155:42161', '0xa4b1'], [8453, '0x2105'], [4663, '0x1237'],
      [84532, '0x14a34'], [11155111, '0xaa36a7']] as const) expect(uniswapLiquidityChainHex(chain)).toBe(expected);
    expect(uniswapLiquidityChainHex('eip155:1')).toBe('0x1'); expect(uniswapLiquidityChainHex(undefined)).toBeUndefined();
    expect(uniswapLiquidityWalletTransactionMatches(review, 'MINT', tx)).toBe(true);
  });
  it.each([
    { chainId: '0x2105' }, { from: '0x' + '2'.repeat(40) }, { to: '0x' + '3'.repeat(40) }, { data: '0x095ea7b3' },
    { value: '0x1' }, { gas: '0xb71b1' }, { maxFeePerGas: '0x1e8481' }, { maxPriorityFeePerGas: '0x1' }, { gas: 'invalid' },
  ])('refuses a response that changes the owner-reviewed envelope: %j', patch => {
    expect(uniswapLiquidityWalletTransactionMatches(review, 'MINT', { ...tx, ...patch } as UniswapTx)).toBe(false);
  });
  it('cannot substitute an approval for a reviewed mint', () => {
    expect(uniswapLiquidityWalletTransactionMatches(review, 'APPROVE_TOKEN0', tx)).toBe(false);
  });
});
