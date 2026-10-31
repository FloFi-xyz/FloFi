// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001 integration on real PostgreSQL. The identity provider is a disposable RSA key served as a JWKS by an
 * in-process transport; the wallet provider is an in-process stand-in for the Turnkey client with the same interface. MOCKED provider
 * evidence only: this proves FloFi's own verification, isolation and authorization rules, not the live providers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness';
import { createAccountStore } from './account-store';
import { createAccountService } from './account-service';
import { clearJwksCache, oidcConfig } from './oidc';
import { newOidcFlow, type AccountSessionToken } from './account-session';
import type { TurnkeyServer } from './turnkey-server';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = (async () => new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] }))) as unknown as typeof fetch;
const env = { FLOFI_PUBLIC_ORIGIN: 'https://flofi.xyz', FLOFI_APPLE_CLIENT_ID: 'xyz.flofi.web' };
const apple = oidcConfig('apple', env)!;
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
function idToken(sub: string, nonce: string, at: number) {
  const input = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ iss: 'https://appleid.apple.com', aud: apple.clientId, sub, nonce, iat: at, exp: at + 600, email: `${sub}@example.com`, email_verified: 'true' })}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}
const KEY = '02' + 'd'.repeat(64), EVM = '0x' + 'e'.repeat(40), OTHER = '0x' + 'f'.repeat(40), SOL = 'So11111111111111111111111111111111111111112';

/** An in-process stand-in for the provider: one organization per identity, wallets per organization. */
function fakeTurnkey() {
  const orgs = new Map<string, { user: string; accounts: { walletId: string; address: string; format: 'ADDRESS_FORMAT_ETHEREUM' | 'ADDRESS_FORMAT_SOLANA' }[]; keys: { privateKeyId: string; address: string }[] }>();
  const logins: { organization: string; sessionKey: string }[] = [];
  let next = 1;
  const server = {
    browser: () => ({ apiBaseUrl: 'https://api.turnkey.com', exportIframeUrl: 'https://export.turnkey.com', importIframeUrl: 'https://import.turnkey.com' }),
    initEmailOtp: async () => 'otp-00000001',
    verifyEmailOtp: async (_: string, code: string) => code === '123456' ? 'verification.token.value' : Promise.reject(new Error('TURNKEY_ACTIVITY_NOT_COMPLETED')),
    findOrganization: async () => null,
    createOrganization: async () => { const id = `org-0000-000${next++}`; orgs.set(id, { user: `user-${id}`, accounts: [], keys: [] }); return { organization: id, user: `user-${id}` }; },
    emailLogin: async (organization: string, _: string, sessionKey: string) => { logins.push({ organization, sessionKey }); return 'h.e30.s'; },
    oidcLogin: async (organization: string, _: string, sessionKey: string) => { logins.push({ organization, sessionKey }); return 'h.e30.s'; },
    walletAccounts: async (organization: string) => orgs.get(organization)?.accounts ?? [],
    wallets: async (organization: string) => [...new Set((orgs.get(organization)?.accounts ?? []).map(account => account.walletId))].map(walletId => ({ walletId, imported: false })),
    privateKeys: async (organization: string) => (orgs.get(organization)?.keys ?? []).map(key => ({ privateKeyId: key.privateKeyId, imported: true,
      addresses: [{ format: key.address.startsWith('0x') ? 'ADDRESS_FORMAT_ETHEREUM' : 'ADDRESS_FORMAT_SOLANA', address: key.address }] })),
  } satisfies TurnkeyServer;
  return { server, orgs, logins };
}

let t: TestDatabase, provider: ReturnType<typeof fakeTurnkey>, clock: Date;
const service = () => createAccountService({ store: createAccountStore(t.db, 'default'), turnkey: provider.server, now: () => clock, transport: jwks });
async function appleSignIn(sub: string, current: AccountSessionToken | null = null, intent: 'sign-in' | 'link' = 'sign-in') {
  const flow = newOidcFlow('apple', KEY, intent, '/app');
  return service().completeOidc(apple, flow, { idToken: idToken(sub, flow.nonce, Math.floor(clock.getTime() / 1000)) }, current);
}
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => t?.drop());
beforeEach(async () => { await t.db.query('TRUNCATE flofi_accounts CASCADE'); provider = fakeTurnkey(); clock = new Date(); clearJwksCache(); });

describe('account service', () => {
  it('signs a new Apple user in, creates their own provider organization and opens a session for this browser key only', async () => {
    const outcome = await appleSignIn('ana');
    expect(outcome).toMatchObject({ created: true, onboarding: 'pending', managedError: null, managed: { organizationId: 'org-0000-0001', sessionKey: KEY } });
    expect(provider.logins).toEqual([{ organization: 'org-0000-0001', sessionKey: KEY }]);
    const again = await appleSignIn('ana');
    expect(again).toMatchObject({ created: false, session: { accountId: outcome.session.accountId } });
    expect(provider.orgs.size).toBe(1);
  });
  it('rejects an ID token whose nonce commits to another browser key', async () => {
    const flow = newOidcFlow('apple', KEY, 'sign-in', '/app'), other = newOidcFlow('apple', '03' + 'a'.repeat(64), 'sign-in', '/app');
    await expect(service().completeOidc(apple, flow, { idToken: idToken('ana', other.nonce, Math.floor(clock.getTime() / 1000)) }, null)).rejects.toThrow('OIDC_NONCE_MISMATCH');
  });
  it('verifies email codes with the provider and never signs in on a rejected code', async () => {
    const flow = { otpId: 'otp-00000001', email: 'bruno@example.com', sessionKey: KEY, intent: 'sign-in' as const, returnTo: '/app' };
    await expect(service().completeEmail(flow, '000000', null)).rejects.toThrow('EMAIL_CODE_REJECTED');
    await expect(service().completeEmail(flow, '12ab56', null)).rejects.toThrow('EMAIL_CODE_INVALID');
    expect((await t.db.query('SELECT count(*)::int AS n FROM flofi_accounts')).rows).toEqual([{ n: 0 }]);
    expect(await service().completeEmail(flow, '123456', null)).toMatchObject({ created: true, managed: { sessionKey: KEY } });
  });
  it('signs a Web3 wallet in as its own account, recorded as a non-exportable external wallet', async () => {
    const outcome = await service().completeWallet({ namespace: 'eip155', address: EVM.toUpperCase().replace('0X', '0x') }, { key: 'io.metamask', name: 'MetaMask' }, 'sign-in', null);
    expect(outcome).toMatchObject({ created: true, managed: null });
    const view = await service().view(outcome.session);
    expect(view?.wallets).toEqual([expect.objectContaining({ address: EVM, origin: 'external', export: 'none', provider: 'io.metamask' })]);
    await expect(service().authorizeExport(outcome.session, `evm:${EVM}`, 'private-key')).rejects.toThrow('EXPORT_NOT_SUPPORTED');
  });
  it('saves managed wallets only when the provider confirms they belong to this person', async () => {
    const ana = await appleSignIn('ana'), bruno = await appleSignIn('bruno');
    provider.orgs.get('org-0000-0001')!.accounts.push({ walletId: 'wallet-0000-0001', address: '0x' + 'AB'.repeat(20), format: 'ADDRESS_FORMAT_ETHEREUM' },
      { walletId: 'wallet-0000-0001', address: SOL, format: 'ADDRESS_FORMAT_SOLANA' });
    provider.orgs.get('org-0000-0002')!.keys.push({ privateKeyId: 'key-0000-0001', address: OTHER });
    const saved = await service().saveManagedWallets(ana.session, [`evm:0x${'ab'.repeat(20)}`, `solana:${SOL}`]);
    expect(saved.map(wallet => [wallet.origin, wallet.export])).toEqual([['generated', 'recovery-phrase'], ['generated', 'recovery-phrase']]);
    // Bruno cannot save Ana's addresses, and Ana cannot save Bruno's imported key.
    await expect(service().saveManagedWallets(bruno.session, [`evm:0x${'ab'.repeat(20)}`])).rejects.toThrow('ACCOUNT_WALLET_NOT_OWNED');
    await expect(service().saveManagedWallets(ana.session, [`evm:${OTHER}`])).rejects.toThrow('ACCOUNT_WALLET_NOT_OWNED');
    expect(await service().saveManagedWallets(bruno.session, [`evm:${OTHER}`])).toEqual([expect.objectContaining({ origin: 'imported', export: 'private-key' })]);
    await expect(service().saveManagedWallets(ana.session, ['evm:not-an-address'])).rejects.toThrow('ACCOUNT_WALLET_INVALID');
  });
  it('authorizes export only for the owner, a supported kind and a recent sign-in', async () => {
    const ana = await appleSignIn('ana'), bruno = await appleSignIn('bruno');
    provider.orgs.get('org-0000-0001')!.accounts.push({ walletId: 'wallet-0000-0001', address: SOL, format: 'ADDRESS_FORMAT_SOLANA' });
    provider.orgs.get('org-0000-0002')!.keys.push({ privateKeyId: 'key-0000-0001', address: OTHER });
    await service().saveManagedWallets(ana.session, [`solana:${SOL}`]);
    await service().saveManagedWallets(bruno.session, [`evm:${OTHER}`]);
    expect(await service().authorizeExport(ana.session, `solana:${SOL}`, 'recovery-phrase')).toEqual({ organizationId: 'org-0000-0001', kind: 'recovery-phrase',
      resource: 'wallet-0000-0001', address: SOL, keyFormat: 'SOLANA', source: 'wallet' });
    expect(await service().authorizeExport(ana.session, `solana:${SOL}`, 'private-key')).toMatchObject({ source: 'wallet-account', resource: SOL });
    expect(await service().authorizeExport(bruno.session, `evm:${OTHER}`, 'private-key')).toMatchObject({ source: 'private-key', resource: 'key-0000-0001', keyFormat: 'HEXADECIMAL' });
    // An imported key has no recovery phrase, and none is ever derived from it.
    await expect(service().authorizeExport(bruno.session, `evm:${OTHER}`, 'recovery-phrase')).rejects.toThrow('EXPORT_NOT_SUPPORTED');
    await expect(service().authorizeExport(bruno.session, `solana:${SOL}`, 'private-key')).rejects.toThrow('ACCOUNT_WALLET_NOT_FOUND');
    clock = new Date(clock.getTime() + 11 * 60_000);
    await expect(service().authorizeExport(ana.session, `solana:${SOL}`, 'private-key')).rejects.toThrow('ACCOUNT_REAUTHENTICATION_REQUIRED');
  });
  it('links identities only with a fresh session and never moves one from another account', async () => {
    const ana = await appleSignIn('ana'), wallet = await service().completeWallet({ namespace: 'solana', address: SOL }, { key: 'Phantom', name: 'Phantom' }, 'sign-in', null);
    await expect(service().linkExternalWallet(ana.session, { namespace: 'solana', address: SOL }, { key: 'Phantom', name: 'Phantom' })).rejects.toThrow('ACCOUNT_IDENTITY_LINKED_ELSEWHERE');
    expect(await service().linkExternalWallet(ana.session, { namespace: 'eip155', address: EVM }, { key: 'io.metamask', name: 'MetaMask' })).toMatchObject({ origin: 'external' });
    await expect(service().linkExternalWallet(ana.session, null, { key: 'x', name: 'x' })).rejects.toThrow('WALLET_SESSION_REQUIRED');
    await expect(appleSignIn('carla', wallet.session, 'link')).resolves.toMatchObject({ session: { accountId: wallet.session.accountId } });
    clock = new Date(clock.getTime() + 11 * 60_000);
    await expect(appleSignIn('dora', ana.session, 'link')).rejects.toThrow('ACCOUNT_REAUTHENTICATION_REQUIRED');
  });
  it('keeps FloFi sign-in working when the wallet provider is not configured, and says so', async () => {
    const plain = createAccountService({ store: createAccountStore(t.db, 'default'), turnkey: null, now: () => clock, transport: jwks });
    const flow = newOidcFlow('apple', KEY, 'sign-in', '/app');
    expect(await plain.completeOidc(apple, flow, { idToken: idToken('ana', flow.nonce, Math.floor(clock.getTime() / 1000)) }, null))
      .toMatchObject({ created: true, managed: null, managedError: 'MANAGED_WALLETS_NOT_CONFIGURED' });
    await expect(plain.startEmail('ana@example.com')).rejects.toThrow('EMAIL_SIGN_IN_NOT_CONFIGURED');
  });
});
