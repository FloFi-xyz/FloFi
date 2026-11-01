// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { walletPreferenceAfterSignIn } from './sign-in-wallet';
import { floFiWalletKey } from './evm-discovery';

const disconnected = { evm: 'io.metamask', solana: 'Phantom', evmDisconnected: true, solanaDisconnected: true };
describe('BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 a verified sign-in re-allows silent wallet restore (P1-06, T06/T08)', () => {
  it('clears the Disconnect marks so the wallet just used is read back silently (never a prompt)', () => {
    expect(walletPreferenceAfterSignIn('eip155', disconnected)).toEqual({ evmDisconnected: false, solanaDisconnected: false });
    expect(walletPreferenceAfterSignIn('google', disconnected)).toEqual({ evmDisconnected: false, solanaDisconnected: false });
  });
  it('a MetaMask sign-in is not hidden by an earlier FloFi wallet choice; other methods keep the remembered choice', () => {
    const floFi = { ...disconnected, evm: floFiWalletKey('0x' + 'a'.repeat(40)) };
    expect(walletPreferenceAfterSignIn('eip155', floFi)).toEqual({ evmDisconnected: false, solanaDisconnected: false, evm: null });
    expect(walletPreferenceAfterSignIn('email', floFi)).toEqual({ evmDisconnected: false, solanaDisconnected: false });
  });
});
