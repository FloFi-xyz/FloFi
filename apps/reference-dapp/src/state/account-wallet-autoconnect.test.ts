// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { accountWalletBlocked, accountWalletChoice, prefersExternalWallet } from './account-wallet-autoconnect';
import { floFiWalletKey, isFloFiWalletKey } from '../wallet/evm-discovery';
import type { WalletChoice } from '../wallet/wallet-registry';

const choice = (key: string): WalletChoice => ({ id: `evm:${key}`, ecosystem: 'evm', key, name: key, icon: null });
const a = choice(floFiWalletKey('0x' + 'a'.repeat(40))), b = choice(floFiWalletKey('0x' + 'b'.repeat(40))), metaMask = choice('io.metamask');
const floFi = (entry: WalletChoice) => isFloFiWalletKey(entry.key);

describe('BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 the account FloFi wallet is ready without a second Connect (P1-02, T01–T04)', () => {
  it('connects the account\'s single FloFi wallet, never an external wallet', () => {
    expect(accountWalletChoice([metaMask, a], floFi, null)).toBe(a);
    expect(accountWalletChoice([metaMask], floFi, null)).toBeNull();
  });
  it('restores the remembered FloFi wallet after a reload, and never guesses between several', () => {
    expect(accountWalletChoice([a, b], floFi, b.key)).toBe(b);
    expect(accountWalletChoice([a, b], floFi, null)).toBeNull();
  });
  it('never replaces an external wallet the person chose last (its store restores it)', () => {
    expect(prefersExternalWallet('io.metamask', isFloFiWalletKey)).toBe(true);
    expect(prefersExternalWallet(a.key, isFloFiWalletKey)).toBe(false);
    expect(prefersExternalWallet(null, isFloFiWalletKey)).toBe(false);
  });
  it('stays off after an explicit Disconnect unless a sign-in since then re-allowed the account\'s own FloFi wallet', () => {
    const preference = { evm: null, solana: null, evmDisconnected: true, solanaDisconnected: false };
    expect(accountWalletBlocked('evm', preference, false)).toBe(true);
    expect(accountWalletBlocked('evm', preference, true)).toBe(false);
    expect(accountWalletBlocked('solana', preference, false)).toBe(false);
  });
});
