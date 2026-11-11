// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ session: null as { accountId: string; sessionId: string; method?: 'eip155' | 'solana'; loginWallet?: string } | null,
  wallets: [] as { namespace: 'eip155' | 'solana'; address: string }[], require: vi.fn(), host: vi.fn() }));
vi.mock('../accounts/account-host.ts', () => ({ accountHost: async () => ({}), currentAccountSession: async () => h.session }));
vi.mock('./session-principal.ts', () => ({ currentWalletPrincipals: async () => h.wallets }));
vi.mock('../flight/host.ts', () => ({ flightCalendar: () => ({ listClosesAt: 1, boardingOpensAt: 2 }), flightNow: async () => 3 }));
vi.mock('./platform-state-host.ts', () => ({ platformStateHost: () => h.host() }));
vi.mock('../flight/beta-access.ts', async importOriginal => ({ ...await importOriginal<typeof import('../flight/beta-access.ts')>(),
  createBetaAccessStore: () => ({ require: h.require }) }));
import { isFlightRecoveryMethod, requireFlightAccess, requireFlightOwner, withFlightAccess, withFlightOwner } from './flight-access';
import { currentBetaIdentity } from '../flight/beta-context';
beforeEach(() => { vi.clearAllMocks(); h.session = null; h.wallets = []; h.host.mockResolvedValue({}); h.require.mockResolvedValue({ ok: true }); });
describe('server request authorization before private work', () => {
  it('keeps rollout inert only when unset/open and refuses malformed flags before any storage', async () => {
    expect(await requireFlightAccess(undefined, {})).toBeNull();
    for (const value of ['', 'true', 'closed']) await expect(requireFlightAccess(undefined, { FLOFI_BETA_ACCESS: value })).rejects.toThrow('BETA_ACCESS_CLOSED');
    expect(h.host).not.toHaveBeenCalled();
  });
  it('keeps owner recovery available after closed/revoked product access without inventing a Flight grant', async () => {
    expect(isFlightRecoveryMethod('status')).toBe(true);
    expect(isFlightRecoveryMethod('report')).toBe(true);
    expect(isFlightRecoveryMethod('begin')).toBe(false);
    expect(await requireFlightOwner({})).toBeNull();
    await expect(requireFlightOwner({ FLOFI_BETA_ACCESS: 'beta' })).rejects.toThrow('BETA_SIGN_IN_REQUIRED');
    h.session = { accountId: 'acct_a', sessionId: 'session_a' };
    expect(await requireFlightOwner({ FLOFI_BETA_ACCESS: 'closed' })).toEqual(h.session);
    expect(await requireFlightOwner({ FLOFI_BETA_ACCESS: 'beta' })).toEqual(h.session);
    expect(h.require).not.toHaveBeenCalled();
    vi.stubEnv('FLOFI_BETA_ACCESS', 'closed');
    try { expect(await withFlightOwner(async () => currentBetaIdentity())).toEqual(h.session); }
    finally { vi.unstubAllEnvs(); }
  });
  it('requires a server account session; an authenticated account with no Flight grant also fails', async () => {
    await expect(requireFlightAccess(undefined, { FLOFI_BETA_ACCESS: 'beta' })).rejects.toThrow('BETA_SIGN_IN_REQUIRED');
    h.session = { accountId: 'acct_a', sessionId: 'session_a' }; h.require.mockResolvedValue({ ok: false, code: 'BETA_ACCESS_DENIED' });
    await expect(requireFlightAccess(undefined, { FLOFI_BETA_ACCESS: 'beta' })).rejects.toThrow('BETA_ACCESS_DENIED');
  });
  it('refuses an independently proven wallet that is not bound to the authorized account, including local authoring', async () => {
    h.session = { accountId: 'acct_a', sessionId: 'session_a' };
    h.wallets = [{ namespace: 'eip155', address: '0x' + 'b'.repeat(40) }];
    h.require.mockImplementation(async input => input.principal ? { ok: false, code: 'BETA_WALLET_NOT_LINKED' } : { ok: true });
    await expect(requireFlightAccess(undefined, { FLOFI_BETA_ACCESS: 'beta' })).rejects.toThrow('BETA_WALLET_NOT_LINKED');
    expect(h.require).toHaveBeenLastCalledWith({ ...h.session, now: 3, sessionNow: expect.any(Number), principal: h.wallets[0] });
  });
  it('requires the exact Privy login wallet even if another wallet is selected', async () => {
    const loginWallet = '0x' + 'a'.repeat(40);
    const selected = { namespace: 'eip155' as const, address: '0x' + 'b'.repeat(40) };
    h.session = { accountId: 'acct_a', sessionId: 'session_a', method: 'eip155' };
    const env = { FLOFI_BETA_ACCESS: 'beta' };
    await expect(requireFlightAccess(selected, env)).rejects.toThrow('BETA_WALLET_REQUIRED');
    expect(h.require).not.toHaveBeenCalled();
    h.session = { ...h.session, loginWallet };
    h.require.mockResolvedValue({ ok: false, code: 'BETA_WALLET_NOT_LINKED' });
    await expect(requireFlightAccess(selected, env)).rejects.toThrow('BETA_WALLET_NOT_LINKED');
    expect(h.require).toHaveBeenCalledExactlyOnceWith({ accountId: 'acct_a', sessionId: 'session_a', now: 3,
      sessionNow: expect.any(Number), principal: { namespace: 'eip155', address: loginWallet } });
  });
  it('rechecks the selected wallet and propagates exact request identity without leaking concurrent scope', async () => {
    vi.stubEnv('FLOFI_BETA_ACCESS', 'beta');
    try {
      h.session = { accountId: 'acct_a', sessionId: 'session_a' };
      const wallet = { namespace: 'solana' as const, address: 'a'.repeat(32) };
      expect(await requireFlightAccess(wallet)).toEqual(h.session);
      expect(h.require).toHaveBeenLastCalledWith({ ...h.session, now: 3, sessionNow: expect.any(Number), principal: wallet });
      expect(await withFlightAccess(async () => currentBetaIdentity())).toEqual(h.session);
      expect(currentBetaIdentity()).toBeNull();
      h.require.mockResolvedValue({ ok: false, code: 'BETA_SESSION_REQUIRED' }); const work = vi.fn();
      await expect(withFlightAccess(work)).rejects.toThrow('BETA_SESSION_REQUIRED'); expect(work).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});
