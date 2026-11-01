// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { AccountWallet } from '../accounts/account-model';
import type { SavedWallet } from './credentials';
import { walletInventory, walletStatus, type ActiveWallet } from './wallet-inventory';

const EVM = '0x47d147fa3ba77fc74cba403961c80c4b2565f714', SOL = '6Crvh7FB483ZBHrYMwA1Q5oxcUu3EZXJxrTq4YasMei', MM = '0x4b212af0a923256961487ae72499ca79f920b3ce';
const account = (ecosystem: 'evm' | 'solana', address: string, origin: AccountWallet['origin'], provider = 'privy', label = `${ecosystem} wallet`): AccountWallet => ({
  id: `${ecosystem}:${address}`, ecosystem, address, origin, provider, providerName: provider === 'privy' ? 'FloFi wallet' : 'MetaMask',
  export: origin === 'external' ? 'none' : 'private-key', label, addedAt: '2026-11-01T00:00:00.000Z' });
const saved = (ecosystem: 'evm' | 'solana', address: string, providerKey: string, label = 'Main'): SavedWallet => ({ id: `${ecosystem}:${providerKey}:${address}`,
  ecosystem, address, providerKey, providerName: providerKey, label, lastNetwork: null, addedAt: '2026-11-01T00:00:00.000Z' });
const active = (ecosystem: 'evm' | 'solana', address: string, providerKey: string): ActiveWallet => ({ ecosystem, address, providerKey, providerName: providerKey, network: null });

describe('BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 one Wallets section (P1-03, T09)', () => {
  it('lists Privy EVM and Solana wallets and a connected Phantom once each, with their designation and an honest status', () => {
    const list = walletInventory({ account: [account('evm', EVM, 'generated'), account('solana', SOL, 'generated')], saved: [],
      active: [active('solana', '5vn2NJ' + '1'.repeat(36), 'Phantom')] });
    expect(list.map(entry => [entry.ecosystem, entry.designation, walletStatus(entry)])).toEqual([
      ['evm', 'privy', 'Not connected'], ['solana', 'privy', 'Not connected'], ['solana', 'external', 'Connected · not saved']]);
  });
  it('never lists the same account twice: a connected account wallet is one Active entry (EVM case-insensitively)', () => {
    const list = walletInventory({ account: [account('evm', EVM, 'generated')], saved: [], active: [active('evm', EVM.toUpperCase().replace('0X', '0x'), 'xyz.flofi.wallet:' + EVM)] });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ designation: 'privy', label: 'evm wallet', account: { address: EVM } });
    expect(walletStatus(list[0]!)).toBe('Active');
  });
  it('merges an account wallet with its device reference by identity, never by label, and keeps distinct providers distinct', () => {
    const list = walletInventory({ account: [account('evm', MM, 'external', 'io.metamask', 'MetaMask')],
      saved: [saved('evm', MM, 'io.metamask', 'Same label'), saved('evm', '0x' + '9'.repeat(40), 'io.rabby', 'MetaMask')], active: [] });
    expect(list).toHaveLength(2);
    expect(list.find(entry => entry.address === MM)).toMatchObject({ account: { origin: 'external' }, saved: { providerKey: 'io.metamask' }, designation: 'external' });
    expect(list.find(entry => entry.address !== MM)).toMatchObject({ account: null, designation: 'external' });
    expect(walletStatus(list.find(entry => entry.address === MM)!)).toBe('Not connected');
    expect(walletStatus(list.find(entry => entry.address !== MM)!)).toBe('Saved');
  });
  it('attaches an account wallet to the connected entry when the same address is saved under two providers', () => {
    const list = walletInventory({ account: [account('evm', MM, 'external', 'io.metamask')], saved: [saved('evm', MM, 'io.rabby'), saved('evm', MM, 'io.metamask')],
      active: [active('evm', MM, 'io.metamask')] });
    expect(list).toHaveLength(2);
    expect(list.filter(entry => entry.account)).toEqual([expect.objectContaining({ saved: expect.objectContaining({ providerKey: 'io.metamask' }), active: expect.any(Object) })]);
  });
  it('a connected FloFi wallet without an account record yet is still designated as Privy-managed', () => {
    const [entry] = walletInventory({ account: [], saved: [], active: [active('evm', EVM, 'xyz.flofi.wallet:' + EVM)], isFloFiProvider: wallet => wallet.providerKey.startsWith('xyz.flofi.wallet') });
    expect(entry).toMatchObject({ designation: 'privy', label: 'EVM Default' });
  });
});
