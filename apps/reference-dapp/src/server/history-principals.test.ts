// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: signed in → history available, never another person's history.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { headers } from 'next/headers';
import { accountHost, currentAccountSession, type AccountHost } from '../accounts/account-host.ts';
import { accountWalletPrincipals, historyPrincipals, memoryPrincipals } from './history-principals.ts';
import { EMBEDDED_APPROVAL_PATH } from './embedded-approval.ts';

vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('../accounts/account-host.ts', () => ({ accountHost: vi.fn(), currentAccountSession: vi.fn() }));

const evm = '0x' + 'a'.repeat(40), other = '0x' + 'b'.repeat(40), solana = 'So11111111111111111111111111111111111111112';
const session = { accountId: 'acct_' + '1'.repeat(32), sessionId: 's', method: 'email', authenticatedAt: 1, expiresAt: 2 } as unknown as Awaited<ReturnType<typeof currentAccountSession>>;
const walletAddresses = vi.fn();
const host = { store: { walletAddresses } } as unknown as AccountHost;

beforeEach(() => {
  vi.mocked(headers).mockResolvedValue(new Headers({ 'x-flofi-pathname': '/app/dashboard' }) as never);
  vi.mocked(accountHost).mockResolvedValue(host);
  vi.mocked(currentAccountSession).mockResolvedValue(session);
  walletAddresses.mockReset().mockResolvedValue([{ namespace: 'eip155', address: evm }, { namespace: 'solana', address: solana }]);
});

describe('history principals', () => {
  it('lists the wallets of the verified account session, read from the store for that account', async () => {
    expect(await accountWalletPrincipals({})).toEqual([{ namespace: 'eip155', address: evm }, { namespace: 'solana', address: solana }]);
    expect(walletAddresses).toHaveBeenCalledWith(session!.accountId);
  });
  it('grants nothing without a database, without a verified session, or inside the embedded approval route', async () => {
    vi.mocked(accountHost).mockResolvedValueOnce(null);
    expect(await accountWalletPrincipals({})).toEqual([]);
    vi.mocked(currentAccountSession).mockResolvedValueOnce(null);
    expect(await accountWalletPrincipals({})).toEqual([]);
    vi.mocked(headers).mockResolvedValueOnce(new Headers({ 'x-flofi-pathname': EMBEDDED_APPROVAL_PATH }) as never);
    expect(await accountWalletPrincipals({})).toEqual([]);
    expect(walletAddresses).not.toHaveBeenCalled();
  });
  it('combines wallets proven in this browser with the account wallets, once each', async () => {
    const all = await historyPrincipals({ proven: async () => [{ namespace: 'eip155', address: other }, { namespace: 'eip155', address: evm }],
      account: async () => [{ namespace: 'eip155', address: evm }, { namespace: 'solana', address: solana }] });
    expect(all).toEqual([{ namespace: 'eip155', address: other }, { namespace: 'eip155', address: evm }, { namespace: 'solana', address: solana }]);
  });
  it('fails closed per source: an account read failure keeps only the proven wallets, and the reverse', async () => {
    expect(await historyPrincipals({ proven: async () => [{ namespace: 'eip155', address: other }], account: async () => { throw new Error('DOWN'); } }))
      .toEqual([{ namespace: 'eip155', address: other }]);
    expect(await historyPrincipals({ proven: async () => { throw new Error('BAD_COOKIE'); }, account: async () => [] })).toEqual([]);
  });
  it('memory never guesses a wallet: the wallet proven here, else the account\'s only wallet of that ecosystem', async () => {
    const solanaOther = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    expect(await memoryPrincipals({ proven: async () => [{ namespace: 'eip155', address: other }],
      account: async () => [{ namespace: 'eip155', address: evm }, { namespace: 'solana', address: solana }] }))
      .toEqual([{ namespace: 'eip155', address: other }, { namespace: 'solana', address: solana }]);
    // Two account wallets in one ecosystem and none proven: no memory identity there (never the first one by address).
    expect(await memoryPrincipals({ proven: async () => [], account: async () => [{ namespace: 'eip155', address: evm }, { namespace: 'eip155', address: other },
      { namespace: 'solana', address: solana }, { namespace: 'solana', address: solanaOther }] })).toEqual([]);
    expect(await memoryPrincipals({ proven: async () => { throw new Error('BAD_COOKIE'); }, account: async () => { throw new Error('DOWN'); } })).toEqual([]);
  });
});
