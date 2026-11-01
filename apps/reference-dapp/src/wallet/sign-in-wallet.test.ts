// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountWalletReconnectAllowed, forgetAccountWalletReconnect, rememberSignIn, walletPreferenceAfterSignIn } from './sign-in-wallet';
import { floFiWalletKey } from './evm-discovery';
import { walletPreference } from './wallet-registry';

const disconnected = { evm: 'io.metamask', solana: 'Phantom', evmDisconnected: true, solanaDisconnected: true };
function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
beforeEach(() => { vi.stubGlobal('window', { localStorage: memoryStorage() }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 a verified sign-in re-allows only what the person just used (P1-06, T06/T08)', () => {
  it('a MetaMask sign-in clears only the EVM Disconnect mark and is not hidden by an earlier FloFi wallet choice', () => {
    expect(walletPreferenceAfterSignIn('eip155', disconnected)).toEqual({ evmDisconnected: false });
    expect(walletPreferenceAfterSignIn('eip155', { ...disconnected, evm: floFiWalletKey('0x' + 'a'.repeat(40)) })).toEqual({ evmDisconnected: false, evm: null });
  });
  it('a Solana wallet sign-in clears only the Solana mark', () => {
    expect(walletPreferenceAfterSignIn('solana', disconnected)).toEqual({ solanaDisconnected: false });
  });
  it('Google, email or Apple keep every Disconnect mark: another person\'s external wallet on a shared browser never reconnects', () => {
    for (const method of ['google', 'email', 'apple'] as const) expect(walletPreferenceAfterSignIn(method, disconnected)).toEqual({});
  });
  it('any verified sign-in allows the account\'s own FloFi wallets once; an explicit Disconnect ends that until the next sign-in', () => {
    window.localStorage.setItem('flofi.wallet.preference.v1', JSON.stringify(disconnected));
    expect(accountWalletReconnectAllowed('evm')).toBe(false);
    rememberSignIn('google');
    expect(walletPreference()).toMatchObject({ evmDisconnected: true, solanaDisconnected: true });
    expect([accountWalletReconnectAllowed('evm'), accountWalletReconnectAllowed('solana')]).toEqual([true, true]);
    forgetAccountWalletReconnect('evm');
    expect([accountWalletReconnectAllowed('evm'), accountWalletReconnectAllowed('solana')]).toEqual([false, true]);
  });
});
