// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ARBITRUM_MAINNET_SWAP as ARB, BASE_MAINNET_SWAP as BASE, NATIVE_ETH, swapWalletRequestMatches } from './public-testnet-swap';

/** BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the browser's last check before the wallet is asked (native value, target, chain, owner). */
describe('swapWalletRequestMatches', () => {
  const owner = '0x1111111111111111111111111111111111111111', amountIn = '1000000000000000', value = '0x' + BigInt(amountIn).toString(16);
  const tx = (to: string, v: string, chainId: string = BASE.chainHex) => ({ chainId, from: owner, to, value: v });
  it('native ETH in: the router, carrying exactly the amount; never zero, never more, never WETH as the target', () => {
    const q = { amountIn, inputToken: NATIVE_ETH, native: 'INPUT' as const };
    expect(swapWalletRequestMatches(q, 'swap', tx(BASE.router, value), BASE, owner)).toBe(true);
    expect(swapWalletRequestMatches(q, 'swap', tx(BASE.router, '0x0'), BASE, owner)).toBe(false);
    expect(swapWalletRequestMatches(q, 'swap', tx(BASE.router, value + '0'), BASE, owner)).toBe(false);
    expect(swapWalletRequestMatches(q, 'swap', tx(BASE.weth, value), BASE, owner)).toBe(false);
    expect(swapWalletRequestMatches(q, 'swap', tx(BASE.router, value, ARB.chainHex), BASE, owner)).toBe(false);
  });
  it('native ETH out and ERC-20 swaps send no value; the approval goes to the input token only', () => {
    const q = { amountIn: '5000000', inputToken: BASE.usdc, native: 'OUTPUT' as const };
    expect(swapWalletRequestMatches(q, 'approval', tx(BASE.usdc, '0x0'), BASE, owner)).toBe(true);
    expect(swapWalletRequestMatches(q, 'swap', tx(BASE.router, '0x0'), BASE, owner)).toBe(true);
    expect(swapWalletRequestMatches(q, 'swap', tx(BASE.router, '0x1'), BASE, owner)).toBe(false);
    expect(swapWalletRequestMatches(q, 'swap', { ...tx(BASE.router, '0x0'), from: '0x2222222222222222222222222222222222222222' }, BASE, owner)).toBe(false);
  });
  it('wrap goes to WETH9 with exactly the amount; unwrap to WETH9 with nothing', () => {
    expect(swapWalletRequestMatches({ amountIn, inputToken: NATIVE_ETH, native: 'INPUT', conversion: 'WRAP' }, 'swap', tx(BASE.weth, value), BASE, owner)).toBe(true);
    expect(swapWalletRequestMatches({ amountIn, inputToken: NATIVE_ETH, native: 'INPUT', conversion: 'WRAP' }, 'swap', tx(BASE.router, value), BASE, owner)).toBe(false);
    expect(swapWalletRequestMatches({ amountIn, inputToken: BASE.weth, native: 'OUTPUT', conversion: 'UNWRAP' }, 'swap', tx(BASE.weth, '0x0'), BASE, owner)).toBe(true);
    expect(swapWalletRequestMatches({ amountIn, inputToken: BASE.weth, native: 'OUTPUT', conversion: 'UNWRAP' }, 'swap', tx(BASE.weth, value), BASE, owner)).toBe(false);
  });
});
