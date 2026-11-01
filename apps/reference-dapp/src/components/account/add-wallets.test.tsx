// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: "Add your wallets" — EVM and Solana cards with Create wallet and Import key, addresses shown inside their card,
 * Continue only once a wallet exists, no informational FloFi Wallet card, and an honest state whenever creating is not possible.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccountState } from '../../app/account-action';
import type { AccountView, AccountWallet } from '../../accounts/account-model';
import { FloFiPrivyContext, type FloFiPrivy } from '../../accounts/privy-client';
import { AddWallets, walletReadiness } from './add-wallets';

vi.mock('../../app/account-action', () => ({ savePrivyWallet: vi.fn(), syncPrivyWallets: vi.fn(), setAccountOnboarding: vi.fn(), accountSignOut: vi.fn() }));
const availability = { accounts: true, google: true, apple: false, email: true, wallet: true, managedWallets: true, legacyWallets: false };
const wallet = (ecosystem: 'evm' | 'solana', address: string, origin: AccountWallet['origin'], provider = 'privy'): AccountWallet => ({ id: `${ecosystem}:${address}`, ecosystem,
  address, origin, provider, providerName: 'FloFi wallet', export: provider === 'turnkey' && origin === 'generated' ? 'recovery-phrase' : origin === 'external' ? 'none' : 'private-key',
  label: origin === 'imported' ? 'My key' : 'EVM wallet', addedAt: '2026-10-31T00:00:00.000Z' });
const account = (wallets: AccountWallet[], privy = true): AccountView => ({ accountId: `acct_${'a'.repeat(32)}`, method: 'google', identities: [], onboarding: 'pending',
  wallets, managedLogin: null, privy, authenticatedAt: '2026-10-31T00:00:00.000Z', expiresAt: '2026-10-31T12:00:00.000Z' });
const ready = { ready: true, authenticated: true, userId: 'did:privy:cmuser0000000000000000001', embedded: [] } as unknown as FloFiPrivy;
const render = (state: AccountState, privy: FloFiPrivy | null = ready) => renderToStaticMarkup(<FloFiPrivyContext.Provider value={privy}><AddWallets state={state}/></FloFiPrivyContext.Provider>);
const EVM = '0x' + '1'.repeat(40), SOL = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';

describe('Add your wallets', () => {
  it('shows EVM and Solana cards with Create wallet and Import key, and no informational FloFi Wallet card', () => {
    const html = render({ availability, account: account([]), privy: null });
    for (const ecosystem of ['evm', 'solana']) {
      const card = html.slice(html.indexOf(`data-ecosystem="${ecosystem}"`), html.indexOf('</section>', html.indexOf(`data-ecosystem="${ecosystem}"`)));
      expect(card).toContain('Create wallet');
      expect(card).toContain(`href="/onboarding/wallets/import/${ecosystem}"`);
    }
    expect(html).not.toContain('Your wallets open in FloFi Wallet');
    expect(html).not.toContain('data-managed-wallet');
    expect(html).not.toMatch(/turnkey/i);
    // No wallet yet: Continue is disabled.
    expect(html).toMatch(/<button type="button" class="[^"]*" disabled="">Continue<\/button>/);
  });
  it('shows each created or imported address inside its own card and enables Continue', () => {
    const html = render({ availability, account: account([wallet('evm', EVM, 'generated'), wallet('solana', SOL, 'imported')]), privy: null });
    const evmCard = html.slice(html.indexOf('data-ecosystem="evm"'), html.indexOf('data-ecosystem="solana"'));
    const solanaCard = html.slice(html.indexOf('data-ecosystem="solana"'));
    expect(evmCard).toContain(`data-wallet-address="${EVM}"`);
    expect(evmCard).toContain('Wallet created');
    expect(evmCard).not.toContain(SOL);
    expect(solanaCard).toContain(`data-wallet-address="${SOL}"`);
    expect(solanaCard).toContain('Imported');
    expect(html).toMatch(/<button type="button" class="[^"]*">Continue<\/button>/);
  });
  it('BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-01, T10): one shortened address per wallet with a copy button, no row above the cards', () => {
    const html = render({ availability, account: account([wallet('evm', EVM, 'generated'), wallet('solana', SOL, 'generated')]), privy: null });
    for (const [ecosystem, address] of [['evm', EVM], ['solana', SOL]] as const) {
      const start = html.indexOf(`data-ecosystem="${ecosystem}"`), card = html.slice(start, html.indexOf('</section>', start));
      // The full address appears only as data/title (what Copy copies), never as visible text; the short form is shown once.
      expect(card.split(`>${address}<`)).toHaveLength(1);
      expect(card.match(/<code /g)).toHaveLength(1);
      expect(card).toContain(`>${address.slice(0, 6)}…${address.slice(-4)}</code>`);
      expect(card).toMatch(/<button type="button" class="[^"]*" aria-label="Copy EVM wallet address" title="Copy address">/);
      expect(card).not.toContain('<ul');
    }
    expect(html).not.toContain('wallet created: ');
  });
  it('says honestly why creating is not possible, instead of spinning', () => {
    expect(walletReadiness({ availability: { ...availability, managedWallets: false }, account: account([]), privy: null }, ready)).toBe('not-configured');
    expect(walletReadiness({ availability, account: account([]), privy: null }, null)).toBe('not-configured');
    expect(walletReadiness({ availability, account: account([], false), privy: null }, ready)).toBe('sign-in-again');
    expect(walletReadiness({ availability, account: account([]), privy: null }, { ready: false, authenticated: false })).toBe('connecting');
    expect(walletReadiness({ availability, account: account([]), privy: null }, { ready: false, authenticated: false }, true)).toBe('unavailable');
    expect(walletReadiness({ availability, account: account([]), privy: null }, { ready: true, authenticated: false })).toBe('sign-in-again');
    expect(walletReadiness({ availability, account: account([]), privy: null }, ready)).toBe('ready');
    const html = render({ availability: { ...availability, managedWallets: false }, account: account([]), privy: null });
    expect(html).toContain('Creating and importing wallets isn&#x27;t available on this deployment yet.');
    expect(html).toMatch(/disabled="" aria-busy="false"><strong>/);
  });
  it('lists a legacy FloFi Wallet (Turnkey) wallet with its address, as legacy', () => {
    const html = render({ availability, account: account([wallet('evm', EVM, 'generated', 'turnkey')]), privy: null });
    expect(html).toContain(EVM);
    expect(html).toContain('Legacy FloFi Wallet');
  });
});
