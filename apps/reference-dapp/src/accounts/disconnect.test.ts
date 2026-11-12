// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Flight transition): Disconnect marks the page as leaving BEFORE the server ends the session, so the product gate's re-render
 * (no session any more) does not hand the page off to /board in the middle of Privy logout; Disconnect still ends on sign-in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock('../app/account-action', () => ({ accountSignOut: vi.fn(async () => {
  const { pageExitInProgress } = await import('./page-exit');
  h.order.push(`signOut (page leaving: ${String(pageExitInProgress())})`);
  return { next: '/login' };
}) }));
vi.mock('../wallet/wallet-registry', () => ({ walletPreference: () => ({ evm: null, solana: null }), updateWalletPreference: () => undefined }));
vi.mock('../wallet/sign-in-wallet', () => ({ forgetAccountWalletReconnect: () => undefined }));
vi.mock('../wallet/evm-discovery', () => ({ isFloFiWalletKey: () => false }));
import { pageExitInProgress } from './page-exit';
import { disconnectToLogin } from './disconnect';

afterEach(() => { vi.unstubAllGlobals(); });
describe('Disconnect and the Flight hand-off', () => {
  it('marks the page as leaving before the session ends, then replaces it with sign-in', async () => {
    const replace = vi.fn(), logout = vi.fn(async () => { h.order.push('Privy logout'); });
    vi.stubGlobal('window', { location: { replace } });
    expect(pageExitInProgress()).toBe(false);
    await disconnectToLogin({ logout });
    expect(h.order).toEqual(['signOut (page leaving: true)', 'Privy logout']);
    expect(replace).toHaveBeenCalledWith('/login');
    expect(pageExitInProgress()).toBe(true);
  });
});
