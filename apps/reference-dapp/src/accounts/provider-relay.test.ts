// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { relayDecision } from './provider-relay';
import type { AccountWallet } from './account-model';

const now = new Date('2026-10-31T12:00:00.000Z'), at = Math.floor(now.getTime() / 1000);
const session = { accountId: 'acct_' + 'a'.repeat(32), sessionId: 'b'.repeat(32), method: 'google' as const, authenticatedAt: at - 60, expiresAt: at + 3600 };
const organization = { organizationId: 'org-0000-0001', userId: 'user-0000-0001' };
const provider = { apiBaseUrl: 'https://api.turnkey.com', exportIframeUrl: 'https://export.turnkey.com', importIframeUrl: 'https://import.turnkey.com' };
const SOL = 'So11111111111111111111111111111111111111112';
const wallets: AccountWallet[] = [{ id: `solana:${SOL}`, ecosystem: 'solana', address: SOL, origin: 'generated', provider: 'turnkey', providerName: 'FloFi wallet',
  export: 'recovery-phrase', label: 'Solana wallet', addedAt: now.toISOString() }];
const store = { wallets: async () => wallets, managedResource: async () => ({ origin: 'generated' as const, resource: 'wallet-0000-0001' }) };
const stamp = 'e'.repeat(64);
const decide = (path: string, body: object, overrides: Record<string, unknown> = {}) =>
  relayDecision({ path, body: JSON.stringify(body), stamp, session, organization, provider, store, now, ...overrides });
const activity = (type: string, parameters: object, organizationId = organization.organizationId) => ({ type, timestampMs: '1', organizationId, parameters });

describe('provider relay', () => {
  it('forwards an allowlisted, stamped request in the account’s own organization', async () => {
    expect(await decide('submit/create_wallet', activity('ACTIVITY_TYPE_CREATE_WALLET', { walletName: 'w', accounts: [] })))
      .toEqual({ ok: true, url: 'https://api.turnkey.com/public/v1/submit/create_wallet' });
  });
  it.each([
    ['no account session', 'submit/create_wallet', activity('ACTIVITY_TYPE_CREATE_WALLET', {}), { session: null }, 'ACCOUNT_SESSION_REQUIRED'],
    ['no provider organization', 'submit/create_wallet', activity('ACTIVITY_TYPE_CREATE_WALLET', {}), { organization: null }, 'MANAGED_SESSION_REQUIRED'],
    ['an unlisted activity (signing)', 'submit/sign_transaction', activity('ACTIVITY_TYPE_SIGN_TRANSACTION_V2', {}), {}, 'PROVIDER_ROUTE_NOT_ALLOWED'],
    ['an unlisted activity (delegation)', 'submit/create_policy', activity('ACTIVITY_TYPE_CREATE_POLICY_V3', {}), {}, 'PROVIDER_ROUTE_NOT_ALLOWED'],
    ['another organization', 'submit/create_wallet', activity('ACTIVITY_TYPE_CREATE_WALLET', {}, 'org-9999-9999'), {}, 'PROVIDER_ORGANIZATION_MISMATCH'],
    ['a mismatched type', 'submit/create_wallet', activity('ACTIVITY_TYPE_EXPORT_WALLET', {}), {}, 'PROVIDER_ACTIVITY_MISMATCH'],
    ['another user’s import', 'submit/init_import_private_key', activity('ACTIVITY_TYPE_INIT_IMPORT_PRIVATE_KEY', { userId: 'user-9999' }), {}, 'PROVIDER_USER_MISMATCH'],
    ['no stamp', 'submit/create_wallet', activity('ACTIVITY_TYPE_CREATE_WALLET', {}), { stamp: null }, 'PROVIDER_STAMP_REQUIRED'],
    ['no provider configured', 'submit/create_wallet', activity('ACTIVITY_TYPE_CREATE_WALLET', {}), { provider: null }, 'MANAGED_WALLETS_NOT_CONFIGURED'],
  ])('refuses %s', async (_, path, body, overrides, code) => {
    expect(await decide(path, body, overrides)).toMatchObject({ ok: false, code });
  });
  it('allows export only after a recent sign-in, for a managed wallet saved to this account', async () => {
    const exportWallet = activity('ACTIVITY_TYPE_EXPORT_WALLET', { walletId: 'wallet-0000-0001', targetPublicKey: '04aa' });
    expect(await decide('submit/export_wallet', exportWallet)).toMatchObject({ ok: true });
    expect(await decide('submit/export_wallet_account', activity('ACTIVITY_TYPE_EXPORT_WALLET_ACCOUNT', { address: SOL, targetPublicKey: '04aa' }))).toMatchObject({ ok: true });
    expect(await decide('submit/export_wallet', activity('ACTIVITY_TYPE_EXPORT_WALLET', { walletId: 'wallet-someone-else', targetPublicKey: '04aa' })))
      .toMatchObject({ ok: false, code: 'EXPORT_NOT_SUPPORTED' });
    // A generated wallet is never exported through the imported-key route.
    expect(await decide('submit/export_private_key', activity('ACTIVITY_TYPE_EXPORT_PRIVATE_KEY', { privateKeyId: 'wallet-0000-0001', targetPublicKey: '04aa' })))
      .toMatchObject({ ok: false, code: 'EXPORT_NOT_SUPPORTED' });
    expect(await decide('submit/export_wallet', exportWallet, { session: { ...session, authenticatedAt: at - 601 } }))
      .toMatchObject({ ok: false, code: 'ACCOUNT_REAUTHENTICATION_REQUIRED' });
  });
});
