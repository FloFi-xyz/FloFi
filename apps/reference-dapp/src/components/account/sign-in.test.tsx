// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-AUTH-WALLETS-001 / BUILD-FLOFI-PRIVY-UX-001: every sign-in method this deployment cannot run is disabled with its reason;
// nothing is simulated. Google, Email and Web3 Wallet run through Privy; Apple appears only once configured.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccountState } from '../../app/account-action';
import { FloFiPrivyContext, type FloFiPrivy } from '../../accounts/privy-client';
import { SignInScreen } from './sign-in';

vi.mock('../../app/account-action', () => ({ privySignIn: vi.fn() }));

const none = { accounts: false, google: false, apple: false, email: false, wallet: false, managedWallets: false, legacyWallets: false };
const state = (availability: Partial<typeof none>): AccountState => ({ availability: { ...none, ...availability }, account: null, privy: null });
const privy = { ready: true, authenticated: false, userId: null, embedded: [], onLogin: () => () => undefined, onLoginError: () => () => undefined } as unknown as FloFiPrivy;
const render = (value: AccountState, configured = true) => renderToStaticMarkup(<FloFiPrivyContext.Provider value={configured ? privy : null}>
  <SignInScreen state={value} initialError={null} returnTo="/app"/></FloFiPrivyContext.Provider>);
/** Each method button's label and whether it is disabled, with its title. */
function methods(html: string): Record<string, { disabled: boolean; title: string | null }> {
  const group = html.slice(html.indexOf('aria-label="Sign-in methods"'));
  return Object.fromEntries(group.slice(0, group.indexOf('</div>')).split('<button ').slice(1).map(button => {
    const tag = button.slice(0, button.indexOf('>'));
    return [/<\/svg><span>([^<]+)/.exec(button)![1], { disabled: / disabled=""/.test(tag), title: /title="([^"]*)"/.exec(tag)?.[1] ?? null }];
  }));
}
const all = { accounts: true, google: true, email: true, wallet: true, managedWallets: true };

describe('sign-in availability', () => {
  it('without accounts on this deployment, every method is disabled and the builder stays open without an account', () => {
    const html = render(state({}), false);
    expect(methods(html)).toEqual({ Google: { disabled: true, title: 'Not available on this deployment yet' }, Email: { disabled: true, title: 'Not available on this deployment yet' },
      'Web3 Wallet': { disabled: true, title: 'Not available on this deployment yet' } });
    expect(html).toContain('Accounts aren&#x27;t available on this deployment yet.');
    expect(html).toMatch(/href="\/app">Continue to FloFi<\/a>/);
    expect(html).toMatch(/href="\/app">Explore the builder without an account<\/a>/);
    expect(html).not.toContain('FloFi stores your sign-in identities');
  });

  it('with accounts but without Privy, sign-in says it is not configured and disables every method', () => {
    const html = render(state({ accounts: true }), false);
    expect(Object.values(methods(html)).every(method => method.disabled)).toBe(true);
    expect(html).toContain('Sign-in isn&#x27;t configured on this deployment yet.');
    expect(html).toContain('Methods shown as unavailable are not configured on this deployment yet.');
  });

  it('with Privy configured, Google, Email and Web3 Wallet are offered; Apple only once it is enabled', () => {
    const html = render(state(all));
    expect(methods(html)).toEqual({ Google: { disabled: false, title: null }, Email: { disabled: false, title: null }, 'Web3 Wallet': { disabled: false, title: null } });
    expect(html).not.toContain('not configured on this deployment');
    expect(html).toContain('FloFi stores your sign-in identities');
    expect(methods(render(state({ ...all, apple: true }))).Apple).toEqual({ disabled: false, title: null });
  });

  it('never mentions the previous wallet provider', () => {
    expect(render(state(all))).not.toMatch(/turnkey/i);
  });
});
