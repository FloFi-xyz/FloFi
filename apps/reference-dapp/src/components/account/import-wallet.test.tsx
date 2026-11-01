// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: the dedicated import screen — Wallet name, Private key, Import wallet — whose key field never posts anywhere:
 * no form action or method, a password field with autocomplete and spell-check off, and a server action that has no parameter for a key.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccountState } from '../../app/account-action';
import { FloFiPrivyContext, type FloFiPrivy } from '../../accounts/privy-client';
import { ImportWallet, maskedTextSupported, privateKeyShapeValid } from './import-wallet';

vi.mock('../../app/account-action', () => ({ savePrivyWallet: vi.fn() }));
const availability = { accounts: true, google: true, apple: false, email: true, wallet: true, managedWallets: true, legacyWallets: false };
const state = { availability, privy: null, account: { accountId: `acct_${'a'.repeat(32)}`, method: 'google', identities: [], onboarding: 'pending', wallets: [], managedLogin: null,
  privy: true, authenticatedAt: '2026-10-31T00:00:00.000Z', expiresAt: '2026-10-31T12:00:00.000Z' } } as AccountState;
const privy = { ready: true, authenticated: true } as unknown as FloFiPrivy;
const render = (ecosystem: 'evm' | 'solana', value: FloFiPrivy | null = privy) =>
  renderToStaticMarkup(<FloFiPrivyContext.Provider value={value}><ImportWallet state={state} ecosystem={ecosystem}/></FloFiPrivyContext.Provider>);

describe('Import key screen', () => {
  it('has exactly Wallet name, Private key and Import wallet, and nothing that could submit the key anywhere', () => {
    const html = render('evm');
    expect(html).toContain('Import your EVM wallet');
    expect(html).toContain('>Wallet name</label>');
    expect(html).toContain('>Private key</label>');
    expect(html).toContain('>Import wallet</button>');
    const form = /<form[^>]*>/.exec(html)![0];
    expect(form).not.toMatch(/\saction=|\smethod=/);
    expect(form).toMatch(/autocomplete="off"/i);
    const key = /<input[^>]*type="password"[^>]*>/.exec(html)![0];
    expect(key).toMatch(/autocomplete="off"/i);
    expect(key).toMatch(/spellcheck="false"/i);
    expect(key).not.toMatch(/\sname=|\svalue=/);
    // Truthful about the boundary: the key passes through this page’s code in the browser, and never reaches FloFi’s servers.
    expect(html).toContain('It passes briefly through this page’s code on the way and is never sent to FloFi’s servers, stored or logged.');
    expect(html).not.toContain('FloFi never receives');
    expect(render('solana')).toContain('Import your Solana wallet');
  });
  it('is unavailable (and says so) without a ready Privy session', () => {
    const html = render('evm', null);
    expect(html).toContain('Importing isn’t available right now.');
    expect(/<input[^>]*type="password"[^>]*>/.exec(html)![0]).toContain('disabled=""');
  });
  it('masks the key as a text field where the browser can (never a saved password), and stays a password field elsewhere', () => {
    expect(maskedTextSupported({ supports: (property, value) => property === '-webkit-text-security' && value === 'disc' })).toBe(true);
    expect(maskedTextSupported({ supports: () => false })).toBe(false);
    expect(maskedTextSupported({ supports: () => { throw new Error('no'); } })).toBe(false);
    expect(maskedTextSupported(undefined)).toBe(false);
  });
  it('accepts only a key of the right shape before Privy is asked', () => {
    expect(privateKeyShapeValid('evm', `0x${'ab'.repeat(32)}`)).toBe(true);
    expect(privateKeyShapeValid('evm', 'ab'.repeat(32))).toBe(true);
    expect(privateKeyShapeValid('evm', `0x${'ab'.repeat(31)}`)).toBe(false);
    expect(privateKeyShapeValid('evm', 'word '.repeat(12).trim())).toBe(false);
    expect(privateKeyShapeValid('solana', '4'.repeat(88))).toBe(true);
    expect(privateKeyShapeValid('solana', '0OIl'.repeat(22))).toBe(false);
    expect(privateKeyShapeValid('solana', `0x${'ab'.repeat(32)}`)).toBe(false);
  });
  it('saves the wallet with a server action that takes a token, an address and a name — never a key', async () => {
    const { savePrivyWallet } = await vi.importActual<typeof import('../../app/account-action')>('../../app/account-action');
    expect(savePrivyWallet.length).toBeLessThanOrEqual(4);
    expect(String(savePrivyWallet)).not.toMatch(/privateKey|secret|seed/i);
  });
});
