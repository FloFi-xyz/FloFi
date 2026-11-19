// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the exact wallet envelope of a Uniswap position-management request. */
import { describe, expect, it } from 'vitest';
import { uniswapPositionWalletTransactionMatches } from './uniswap-position-eip1193';

const NPM = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', OWNER = '0x5555555555555555555555555555555555555555';
const CALL = { step: 'DECREASE' as const, to: NPM, data: '0xac9650d8' + '00'.repeat(64), gasLimit: '300000' };
const review = { chainId: 8453, owner: OWNER, operation: 'DECREASE' as const, contracts: { positionManager: NPM }, calls: [CALL],
  fees: { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' } };
const tx = { nonce: '0x7', chainId: '0x2105', from: OWNER, to: NPM, data: CALL.data, value: '0x0' as const, gas: '0x493e0',
  maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0xf4240' };

describe('uniswapPositionWalletTransactionMatches', () => {
  it('accepts exactly the reviewed request', () => {
    expect(uniswapPositionWalletTransactionMatches(review, tx, '7')).toBe(true);
  });
  it('refuses any widened field: network, sender, value, target, call data, gas limit, fee caps or an extra field', () => {
    const widened: Record<string, unknown>[] = [
      { chainId: '0xa4b1' }, { chainId: '0x1' }, { from: '0x6666666666666666666666666666666666666666' }, { value: '0x1' },
      { to: '0x7777777777777777777777777777777777777777' }, { data: tx.data.slice(0, -2) + '01' }, { data: tx.data.toUpperCase().replace('0X', '0x') },
      { gas: '0x493e1' }, { maxFeePerGas: '0x77359401' }, { maxPriorityFeePerGas: '0xf4241' }, { gasPrice: '0x1' }, { gas: 'not-hex' },
    ];
    for (const patch of widened) expect(uniswapPositionWalletTransactionMatches(review, { ...tx, ...patch } as typeof tx, '7'), JSON.stringify(patch)).toBe(false);
  });
  it('refuses a request at any nonce other than the one the server reserved for the attempt, or without one', () => {
    expect(uniswapPositionWalletTransactionMatches(review, tx, '8')).toBe(false);
    expect(uniswapPositionWalletTransactionMatches(review, { ...tx, nonce: '0x8' }, '7')).toBe(false);
    const { nonce: _nonce, ...withoutNonce } = tx; void _nonce;
    expect(uniswapPositionWalletTransactionMatches(review, withoutNonce, '7')).toBe(false);
    expect(uniswapPositionWalletTransactionMatches(review, { ...tx, nonce: '7' }, '7')).toBe(false);
  });
  it('refuses a Review that is not one Position Manager request of its own operation', () => {
    expect(uniswapPositionWalletTransactionMatches({ ...review, calls: [] }, tx, '7')).toBe(false);
    expect(uniswapPositionWalletTransactionMatches({ ...review, calls: [CALL, CALL] }, tx, '7')).toBe(false);
    expect(uniswapPositionWalletTransactionMatches({ ...review, operation: 'EXIT' }, tx, '7')).toBe(false);
    expect(uniswapPositionWalletTransactionMatches({ ...review, contracts: { positionManager: '0x7777777777777777777777777777777777777777' } }, tx, '7')).toBe(false);
    expect(uniswapPositionWalletTransactionMatches({ ...review, chainId: 84532 }, tx, '7')).toBe(false);
  });
});
