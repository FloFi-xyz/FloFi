// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001 (beta incident: Google could not be linked to an existing Web3 account): the Sign-in methods page is never
// a dead end. Server actions are doubles; nothing is linked, signed in or moved here.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FloFiPrivyContext, type FloFiPrivy } from '../../accounts/privy-client';
import type { SignInMethodsState } from '../../app/account-action';
import { SignInMethodsScreen } from './sign-in-methods';

vi.mock('../../app/account-action', () => ({ cancelAccountMove: vi.fn(), completeAccountMove: vi.fn(), linkReadiness: vi.fn(), signInMethodsState: vi.fn(),
  startAccountMove: vi.fn(), syncSignInMethods: vi.fn() }));

const privy = { ready: true, authenticated: true, userId: 'did:privy:x', embedded: [], linkWithOAuth: vi.fn(), onLinkResult: () => () => undefined,
  onLogin: () => () => undefined, onLoginError: () => () => undefined, getAccessToken: async () => null } as unknown as FloFiPrivy;
const wallet: SignInMethodsState = { signedIn: true, methods: [{ kind: 'eip155', hint: '0x1234…abcd' }], fresh: true, privy: true, retirement: ['WALLET'] as never,
  move: null, emailLink: true };
const render = (state: SignInMethodsState) => renderToStaticMarkup(<FloFiPrivyContext.Provider value={privy}><SignInMethodsScreen initial={state}/></FloFiPrivyContext.Provider>);

describe('Sign-in methods for a wallet-first account', () => {
  it('offers Add Google once the account has its Privy link', () => {
    expect(render(wallet)).toContain('Add Google');
  });
  it('an account without a Privy link is told how to enable linking (confirm it is you), never shown nothing', () => {
    const html = render({ ...wallet, privy: false });
    expect(html).not.toContain('Add Google');
    expect(html).toContain('To add Google or email, first confirm it’s you with a sign-in method this account already has.');
    expect(html).toContain('href="/login?reauth=1&amp;returnTo=%2Faccount%2Fsign-in-methods"');
  });
});
