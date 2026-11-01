// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: FloFi Wallet unlock, organization binding and export authorization on real PostgreSQL, with FloFi's REAL
 * Turnkey server client talking to the shared MOCKED emulator (e2e/turnkey-emulator.ts). The test plays the wallet page: it holds the
 * wallet key, encrypts the code to the provider's target and builds and signs the provider's messages itself. MOCKED provider evidence only.
 *
 * Since BUILD-FLOFI-PRIVY-UX-001 FloFi Wallet (Turnkey) is the legacy, export-only home of wallets created there before Privy: accounts and
 * their legacy organizations are set up directly (the store, and the emulator's organizations as the provider holds them), an unlock works
 * only for an account whose organization already exists, and nothing is ever created at the provider.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createECDH, createPrivateKey, createSign, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { encryptOtpCodeToBundle } from '@turnkey/crypto';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness';
import { createAccountStore, type NewWallet } from './account-store';
import { createWalletService, type PendingEmailUnlock } from './wallet-service';
import { newWalletSession, type WalletSession } from './wallet-session';
import { clearJwksCache, oidcConfig } from './oidc';
import { newOidcFlow, type AccountSessionToken } from './account-session';
import { createTurnkeyServer, loginSignatureMessage, turnkeyConfig } from './turnkey-server';
import { createTurnkeyEmulator, E2E_SIGN_IN_CODE, E2E_WALLET_CODE } from '../../e2e/turnkey-emulator';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = (async () => new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] }))) as unknown as typeof fetch;
const env = { FLOFI_PUBLIC_ORIGIN: 'https://flofi.xyz', FLOFI_APPLE_CLIENT_ID: 'xyz.flofi.web', FLOFI_WALLET_APPLE_CLIENT_ID: 'xyz.flofi.wallet' };
const apple = oidcConfig('apple', env)!, walletApple = oidcConfig('apple', env, 'https://wallet.flofi.xyz')!;
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
function idToken(aud: string, sub: string, nonce: string, at: number) {
  const input = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ iss: 'https://appleid.apple.com', aud, sub, nonce, iat: at, exp: at + 600, email: `${sub}@example.com`, email_verified: 'true', jti: randomUUID() })}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}
/** A P-256 key the way the wallet page holds one: public half (compressed hex) and a raw (r‖s) signer. */
function walletKey() {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const point = ecdh.getPublicKey(), key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: ecdh.getPrivateKey().toString('base64url'),
    x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
  const raw = (message: string) => sign('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }).toString('hex');
  const stamp = (body: string) => Buffer.from(JSON.stringify({ publicKey: ecdh.getPublicKey('hex', 'compressed'), scheme: 'SIGNATURE_SCHEME_TK_API_P256',
    signature: sign('sha256', Buffer.from(body), key).toString('hex') })).toString('base64url');
  return { public: ecdh.getPublicKey('hex', 'compressed'), raw, stamp };
}

/** Every provider route FloFi's server called in this test (path after `/public/v1/`). */
let calls: string[];
let t: TestDatabase, clock: Date, emulator: ReturnType<typeof createTurnkeyEmulator>, turnkey: ReturnType<typeof createTurnkeyServer>;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => t?.drop());
beforeEach(async () => {
  await t.db.query('TRUNCATE flofi_accounts, flofi_account_email_challenges, flofi_account_used_proofs CASCADE');
  clock = new Date(); clearJwksCache(); calls = [];
  const parent = createECDH('prime256v1'); parent.generateKeys();
  const organization = randomUUID();
  emulator = createTurnkeyEmulator({ parentPublicKey: parent.getPublicKey('hex', 'compressed'), parentOrg: organization, otpSignerPrivateKey: randomBytes(32).toString('hex') });
  const transport = (async (url: string, init: RequestInit) => { calls.push(new URL(url).pathname.replace(/^\/public\/v1\//, '')); return emulator.transport(url, init); }) as unknown as typeof fetch;
  turnkey = createTurnkeyServer(turnkeyConfig({ FLOFI_TURNKEY_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_TURNKEY_ORGANIZATION_ID: organization,
    FLOFI_TURNKEY_API_PUBLIC_KEY: parent.getPublicKey('hex', 'compressed'), FLOFI_TURNKEY_API_PRIVATE_KEY: parent.getPrivateKey('hex').padStart(64, '0'),
    FLOFI_TURNKEY_API_BASE_URL: 'http://127.0.0.1:9', FLOFI_TURNKEY_OTP_SIGNER_PUBLIC_KEY: emulator.otpSignerPublicKey })!, transport, async () => undefined);
});
const store = () => createAccountStore(t.db, 'default');
const wallets = () => createWalletService({ store: store(), turnkey, now: () => clock, transport: jwks });
const token = ({ accountId, sessionId, method, authenticatedAt, expiresAt }: AccountSessionToken): AccountSessionToken => ({ accountId, sessionId, method, authenticatedAt, expiresAt });
/** An account created with this verified email (as email sign-in did before Privy). */
const emailAccount = async (email: string) => token(await store().signIn({ kind: 'email', subject: email, label: email }, clock));
const appleAccount = async (sub: string) => token(await store().signIn({ kind: 'apple', subject: sub, label: `${sub}@example.com` }, clock));
/** A FloFi Wallet (Turnkey) organization created before Privy, as the provider (MOCKED emulator) holds it: that identity is its only root user. */
function legacyOrganization(root: { readonly email: string } | { readonly apple: string }) {
  const organization = `org-${randomBytes(6).toString('hex')}`, user = `user-${randomBytes(6).toString('hex')}`;
  emulator.orgs.set(organization, { id: organization, user, email: 'email' in root ? root.email : null,
    oidc: 'apple' in root ? `https://appleid.apple.com|${root.apple}` : null, sessions: new Map(), wallets: [], keys: [] });
  return { organization, user };
}
/** Nothing was ever created at the provider: no sub-organization, wallet or key activity. */
const nothingCreated = () => expect(calls.filter(path => /create|import/.test(path))).toEqual([]);
/** The wallet page's email unlock, end to end: code to the account's own address, encrypted with the wallet key, messages built locally. */
async function emailUnlock(session: WalletSession, key = walletKey(), code = E2E_WALLET_CODE) {
  const started = await wallets().startEmailUnlock(session, key.public);
  const bundle = await encryptOtpCodeToBundle(code, started.targetBundle, key.public, emulator.otpSignerPublicKey);
  const verified = await wallets().verifyEmailUnlock(session, started.challengeId, bundle);
  const login = key.raw(loginSignatureMessage(verified.tokenId, key.public));
  return { started, verified, key, finish: () => wallets().finishEmailUnlock(session, verified.pending, login) };
}
/** Whether the provider accepts a request stamped by `key` in `organization` (i.e. a live provider session for that key). */
function providerAccepts(key: ReturnType<typeof walletKey>, organization: string): boolean {
  const body = JSON.stringify({ type: 'ACTIVITY_TYPE_EXPORT_WALLET', timestampMs: String(Date.now()), organizationId: organization,
    parameters: { walletId: 'wallet-any', targetPublicKey: '04' + 'c'.repeat(128) } });
  return emulator.request('submit/export_wallet', body, key.stamp(body))[0] === 200;
}

describe('FloFi Wallet email unlock (legacy, export only)', () => {
  it('opens a provider session for the wallet key only, on the organization the person already had before Privy', async () => {
    const ana = await emailAccount('ana@example.com'), session = newWalletSession(ana, clock), legacy = legacyOrganization({ email: 'ana@example.com' });
    const unlock = await emailUnlock(session);
    expect(unlock.started.email).toBe('ana@example.com');
    expect(unlock.verified).toMatchObject({ email: 'ana@example.com', signup: false });
    expect(unlock.verified.pending.signup).toBe(false);
    expect(await unlock.finish()).toMatchObject({ key: unlock.key.public });
    expect((await store().account(ana.accountId))!.organization).toEqual({ provider: 'turnkey', organization: legacy.organization, user: legacy.user, login: 'email' });
    expect(emulator.orgs.size).toBe(1);
    expect(providerAccepts(unlock.key, legacy.organization)).toBe(true);
    expect(providerAccepts(walletKey(), legacy.organization)).toBe(false);
    nothingCreated();
  });
  it('never signs anyone up: without an existing organization the unlock fails with LEGACY_WALLET_EXPORT_ONLY and creates nothing', async () => {
    // A FloFi account created through Privy, which never had a FloFi Wallet (Turnkey) organization.
    const privy = token(await store().signInPrivy({ privyUser: 'did:privy:cnew0000ana', identities: [{ kind: 'email', subject: 'ana@example.com', label: 'ana@example.com' }],
      method: 'email' }, clock));
    const session = newWalletSession(privy, clock), key = walletKey();
    const started = await wallets().startEmailUnlock(session, key.public);
    const bundle = await encryptOtpCodeToBundle(E2E_WALLET_CODE, started.targetBundle, key.public, emulator.otpSignerPublicKey);
    await expect(wallets().verifyEmailUnlock(session, started.challengeId, bundle)).rejects.toThrow('LEGACY_WALLET_EXPORT_ONLY');
    expect(emulator.orgs.size).toBe(0);
    expect((await store().account(privy.accountId))!.organization).toBeNull();
    nothingCreated();
    expect(calls).not.toContain('submit/otp_login');
  });
  it('never completes a sign-up unlock, even one sealed before Privy with a valid login signature', async () => {
    const ana = await emailAccount('ana@example.com'), session = newWalletSession(ana, clock), legacy = legacyOrganization({ email: 'ana@example.com' });
    const unlock = await emailUnlock(session);
    const signup: PendingEmailUnlock = { ...unlock.verified.pending, signup: true };
    await expect(wallets().finishEmailUnlock(session, signup, unlock.key.raw(loginSignatureMessage(signup.tokenId, unlock.key.public)))).rejects.toThrow('EMAIL_CHALLENGE_EXPIRED');
    expect(providerAccepts(unlock.key, legacy.organization)).toBe(false);
    expect((await store().account(ana.accountId))!.organization).toBeNull();
    expect(calls).not.toContain('submit/otp_login');
    nothingCreated();
  });
  it('a new unlock ends the previous provider session (invalidateExisting) and keeps the one organization', async () => {
    const ana = await emailAccount('ana@example.com'), session = newWalletSession(ana, clock), legacy = legacyOrganization({ email: 'ana@example.com' });
    const first = await emailUnlock(session); await first.finish();
    const second = await emailUnlock(session);
    expect(second.verified.signup).toBe(false);
    await second.finish();
    expect((await store().account(ana.accountId))!.organization!.organization).toBe(legacy.organization);
    expect(emulator.orgs.size).toBe(1);
    expect(providerAccepts(second.key, legacy.organization)).toBe(true);
    expect(providerAccepts(first.key, legacy.organization)).toBe(false);
    nothingCreated();
  });
  it('never sends anything to the provider with a signature over another message or by another key', async () => {
    const ana = await emailAccount('ana@example.com'), session = newWalletSession(ana, clock), legacy = legacyOrganization({ email: 'ana@example.com' });
    const unlock = await emailUnlock(session), intruder = walletKey();
    const pending = unlock.verified.pending;
    // A signature over a login for another session key (what a server-chosen message could smuggle in).
    await expect(wallets().finishEmailUnlock(session, pending, unlock.key.raw(loginSignatureMessage(pending.tokenId, intruder.public))))
      .rejects.toThrow('TURNKEY_CLIENT_SIGNATURE_INVALID');
    // The right message, signed by another key.
    await expect(wallets().finishEmailUnlock(session, pending, intruder.raw(loginSignatureMessage(pending.tokenId, unlock.key.public))))
      .rejects.toThrow('TURNKEY_CLIENT_SIGNATURE_INVALID');
    expect(calls).not.toContain('submit/otp_login');
    expect(emulator.orgs.get(legacy.organization)!.sessions.size).toBe(0);
    expect((await store().account(ana.accountId))!.organization).toBeNull();
  });
  it('keeps each unlock challenge to its own account and refuses wrong codes', async () => {
    const ana = await emailAccount('ana@example.com'), bruno = await emailAccount('bruno@example.com');
    legacyOrganization({ email: 'ana@example.com' }); legacyOrganization({ email: 'bruno@example.com' });
    const anaSession = newWalletSession(ana, clock), brunoSession = newWalletSession(bruno, clock);
    const key = walletKey(), started = await wallets().startEmailUnlock(anaSession, key.public);
    const bundle = await encryptOtpCodeToBundle(E2E_WALLET_CODE, started.targetBundle, key.public, emulator.otpSignerPublicKey);
    // Bruno's wallet session cannot use Ana's unlock challenge.
    await expect(wallets().verifyEmailUnlock(brunoSession, started.challengeId, bundle)).rejects.toThrow('EMAIL_CHALLENGE_EXPIRED');
    // A sign-in code (6 digits) does not unlock FloFi Wallet.
    const wrong = await encryptOtpCodeToBundle(E2E_SIGN_IN_CODE, started.targetBundle, key.public, emulator.otpSignerPublicKey);
    await expect(wallets().verifyEmailUnlock(anaSession, started.challengeId, wrong)).rejects.toThrow('EMAIL_CODE_REJECTED');
    // An unlock never takes an address from the browser: the code always goes to the account's own email.
    expect((await wallets().startEmailUnlock(brunoSession, walletKey().public)).email).toBe('bruno@example.com');
  });
  it('has its own budget of 5 unlock codes per hour, apart from any other code for the address', async () => {
    const ana = await emailAccount('ana@example.com'), session = newWalletSession(ana, clock);
    legacyOrganization({ email: 'ana@example.com' });
    for (let request = 0; request < 5; request++) await wallets().startEmailUnlock(session, walletKey().public);
    await expect(wallets().startEmailUnlock(session, walletKey().public)).rejects.toThrow('EMAIL_RATE_LIMITED');
    // The unlock budget is recorded under its own key (`wallet-unlock:<address>`), so the address's own budget is untouched.
    expect(await store().emailChallengeAllowed('ana@example.com', clock)).toBe(true);
  });
  it('ends with the account session: a revoked session cannot start or finish an unlock', async () => {
    const ana = await emailAccount('ana@example.com'), session = newWalletSession(ana, clock), legacy = legacyOrganization({ email: 'ana@example.com' });
    const unlock = await emailUnlock(session);
    await store().revokeSession(ana);
    await expect(unlock.finish()).rejects.toThrow('ACCOUNT_SESSION_REQUIRED');
    await expect(wallets().startEmailUnlock(session, walletKey().public)).rejects.toThrow('ACCOUNT_SESSION_REQUIRED');
    expect(emulator.orgs.get(legacy.organization)!.sessions.size).toBe(0);
  });
});

describe('FloFi Wallet Google/Apple unlock and organization binding (legacy, export only)', () => {
  it('unlocks with the same Apple identity as the account, through FloFi Wallet’s own client, for the wallet key the nonce commits to', async () => {
    const ana = await appleAccount('ana'), session = newWalletSession(ana, clock), key = walletKey(), legacy = legacyOrganization({ apple: 'ana' });
    const flow = newOidcFlow('apple', key.public, 'link', '/app', ana), at = Math.floor(clock.getTime() / 1000);
    // A sign-in token (the product client's audience) never unlocks FloFi Wallet.
    await expect(wallets().completeOidcUnlock(session, walletApple, flow, { idToken: idToken(apple.clientId, 'ana', flow.nonce, at) })).rejects.toThrow();
    // Another person's Apple account cannot unlock Ana's FloFi Wallet.
    await expect(wallets().completeOidcUnlock(session, walletApple, flow, { idToken: idToken(walletApple.clientId, 'mallory', flow.nonce, at) })).rejects.toThrow('WALLET_UNLOCK_IDENTITY_MISMATCH');
    const unlocked = await wallets().completeOidcUnlock(session, walletApple, flow, { idToken: idToken(walletApple.clientId, 'ana', flow.nonce, at) });
    expect(unlocked.key).toBe(key.public);
    expect((await store().account(ana.accountId))!.organization).toEqual({ provider: 'turnkey', organization: legacy.organization, user: legacy.user, login: 'apple' });
    expect(providerAccepts(key, legacy.organization)).toBe(true);
    expect(emulator.orgs.size).toBe(1);
    nothingCreated();
  });
  it('never creates an organization for an Apple account that had none: LEGACY_WALLET_EXPORT_ONLY', async () => {
    const ana = await appleAccount('ana'), session = newWalletSession(ana, clock), key = walletKey();
    const flow = newOidcFlow('apple', key.public, 'link', '/app', ana), at = Math.floor(clock.getTime() / 1000);
    await expect(wallets().completeOidcUnlock(session, walletApple, flow, { idToken: idToken(walletApple.clientId, 'ana', flow.nonce, at) })).rejects.toThrow('LEGACY_WALLET_EXPORT_ONLY');
    expect(emulator.orgs.size).toBe(0);
    expect((await store().account(ana.accountId))!.organization).toBeNull();
    expect(calls).not.toContain('submit/oauth_login');
    nothingCreated();
  });
  it('unlocks only with the account’s primary identity, never with one linked later, even when the provider knows that one', async () => {
    const ana = await appleAccount('ana');
    clock = new Date(clock.getTime() + 60_000);
    // Later, an email is linked (for example by someone holding a fresh session) that has its own organization at the provider.
    await store().linkIdentity(ana.accountId, { kind: 'email', subject: 'mallory@example.com', label: 'mallory@example.com' }, clock);
    legacyOrganization({ email: 'mallory@example.com' });
    const session = newWalletSession(ana, clock);
    expect((await wallets().context(session)).methods).toEqual(['apple']);
    await expect(wallets().startEmailUnlock(session, walletKey().public)).rejects.toThrow('WALLET_UNLOCK_METHOD_UNAVAILABLE');
    expect((await store().account(ana.accountId))!.organization).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('FloFi Wallet root on a wallet-first account', () => {
  it('never lets a Google, Apple or email identity linked later become the root of an account created with a Web3 wallet', async () => {
    const created = token(await store().signIn({ kind: 'eip155', subject: '0x' + 'b'.repeat(40), label: null }, clock));
    clock = new Date(clock.getTime() + 60_000);
    await store().linkIdentity(created.accountId, { kind: 'email', subject: 'linked@example.com', label: 'linked@example.com' }, clock);
    legacyOrganization({ email: 'linked@example.com' });
    expect((await store().account(created.accountId))!.identities.map(identity => identity.kind)).toEqual(['eip155', 'email']);
    const session = newWalletSession(created, clock);
    expect((await wallets().context(session)).methods).toEqual([]);
    await expect(wallets().startEmailUnlock(session, walletKey().public)).rejects.toThrow('WALLET_UNLOCK_METHOD_UNAVAILABLE');
    expect((await store().account(created.accountId))!.organization).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('FloFi Wallet export authorization (legacy wallets only)', () => {
  const SOLANA = 'So11111111111111111111111111111111111111112', EVM = `0x${'e'.repeat(40)}`, PRIVY_EVM = `0x${'d'.repeat(40)}`, EXTERNAL_EVM = `0x${'f'.repeat(40)}`;
  const legacyWallet = (ecosystem: 'evm' | 'solana', address: string, origin: 'generated' | 'imported', resource: string): NewWallet => ({ ecosystem, address, origin,
    provider: 'turnkey', providerName: 'FloFi wallet', providerResource: resource, label: ecosystem === 'evm' ? 'EVM wallet' : 'Solana wallet' });
  it('needs an unlock in the last 5 minutes and a legacy wallet saved to this account', async () => {
    // Ana's account and her FloFi Wallet (Turnkey) wallet date from before Privy; she now signs in through Privy, to the same account.
    const before = await emailAccount('ana@example.com'), legacy = legacyOrganization({ email: 'ana@example.com' });
    await store().saveWallet(before.accountId, legacyWallet('solana', SOLANA, 'generated', 'wallet-ana-0001'), clock);
    const ana = token(await store().signInPrivy({ privyUser: 'did:privy:cana00000001', identities: [{ kind: 'email', subject: 'ana@example.com', label: 'ana@example.com' }],
      method: 'email' }, clock));
    expect(ana.accountId).toBe(before.accountId);
    const session = newWalletSession(ana, clock), unlock = await emailUnlock(session);
    await unlock.finish();
    const at = Math.floor(clock.getTime() / 1000), unlocked = { ...session, unlockedKey: unlock.key.public, unlockedAt: at, unlockedUntil: at + 1800 };
    expect(await wallets().exportGrant(unlocked, `solana:${SOLANA}`, 'recovery-phrase'))
      .toEqual({ organizationId: legacy.organization, kind: 'recovery-phrase', resource: 'wallet-ana-0001', address: SOLANA, keyFormat: 'SOLANA', source: 'wallet' });
    await expect(wallets().exportGrant(session, `solana:${SOLANA}`, 'recovery-phrase')).rejects.toThrow('WALLET_UNLOCK_REQUIRED');
    clock = new Date(clock.getTime() + 301_000);
    await expect(wallets().exportGrant(unlocked, `solana:${SOLANA}`, 'recovery-phrase')).rejects.toThrow('WALLET_UNLOCK_REQUIRED');
    clock = new Date(clock.getTime() - 301_000);
    await expect(wallets().exportGrant(unlocked, `evm:${EVM}`, 'private-key')).rejects.toThrow('ACCOUNT_WALLET_NOT_FOUND');
    nothingCreated();
  });
  it('lists and exports legacy wallets only, each with its own export kind; Privy and external wallets are never FloFi Wallet’s', async () => {
    const ana = await emailAccount('ana@example.com'), legacy = legacyOrganization({ email: 'ana@example.com' });
    await store().saveWallet(ana.accountId, legacyWallet('evm', EVM, 'generated', 'wallet-ana-0002'), clock);
    await store().saveWallet(ana.accountId, legacyWallet('solana', SOLANA, 'imported', 'key-ana-00003'), clock);
    await store().saveWallet(ana.accountId, { ecosystem: 'evm', address: PRIVY_EVM, origin: 'generated', provider: 'privy', providerName: 'FloFi wallet',
      providerResource: 'privywallet01', label: 'Privy wallet' }, clock);
    await store().saveWallet(ana.accountId, { ecosystem: 'evm', address: EXTERNAL_EVM, origin: 'external', provider: 'io.metamask', providerName: 'MetaMask',
      providerResource: null, label: 'MetaMask' }, clock);
    const session = newWalletSession(ana, clock), unlock = await emailUnlock(session);
    await unlock.finish();
    const at = Math.floor(clock.getTime() / 1000), unlocked = { ...session, unlockedKey: unlock.key.public, unlockedAt: at, unlockedUntil: at + 1800 };
    expect((await wallets().context(unlocked)).wallets.map(wallet => wallet.id).sort()).toEqual([`evm:${EVM}`, `solana:${SOLANA}`]);
    // A Turnkey-generated wallet keeps its recovery phrase and exports a single account's key; an imported key exports that key.
    expect(await wallets().exportGrant(unlocked, `evm:${EVM}`, 'private-key'))
      .toEqual({ organizationId: legacy.organization, kind: 'private-key', resource: EVM, address: EVM, keyFormat: 'HEXADECIMAL', source: 'wallet-account' });
    expect(await wallets().exportGrant(unlocked, `solana:${SOLANA}`, 'private-key'))
      .toEqual({ organizationId: legacy.organization, kind: 'private-key', resource: 'key-ana-00003', address: SOLANA, keyFormat: 'SOLANA', source: 'private-key' });
    await expect(wallets().exportGrant(unlocked, `solana:${SOLANA}`, 'recovery-phrase')).rejects.toThrow('EXPORT_NOT_SUPPORTED');
    await expect(wallets().exportGrant(unlocked, `evm:${EVM}`, 'seed')).rejects.toThrow('EXPORT_KIND_INVALID');
    for (const address of [PRIVY_EVM, EXTERNAL_EVM]) for (const kind of ['private-key', 'recovery-phrase'])
      await expect(wallets().exportGrant(unlocked, `evm:${address}`, kind)).rejects.toThrow('ACCOUNT_WALLET_NOT_FOUND');
    nothingCreated();
  });
  it('never exports without the account’s own organization, or another account’s legacy wallet', async () => {
    const ana = await emailAccount('ana@example.com'), bruno = await emailAccount('bruno@example.com');
    await store().saveWallet(bruno.accountId, legacyWallet('solana', SOLANA, 'generated', 'wallet-bru-0001'), clock);
    const at = Math.floor(clock.getTime() / 1000), key = walletKey().public;
    const anaUnlocked = { ...newWalletSession(ana, clock), unlockedKey: key, unlockedAt: at, unlockedUntil: at + 1800 };
    await expect(wallets().exportGrant(anaUnlocked, `solana:${SOLANA}`, 'recovery-phrase')).rejects.toThrow('MANAGED_ORGANIZATION_MISSING');
    await store().setWalletOrganization(ana.accountId, { provider: 'turnkey', ...legacyOrganization({ email: 'ana@example.com' }), login: 'email' }, clock);
    await expect(wallets().exportGrant(anaUnlocked, `solana:${SOLANA}`, 'recovery-phrase')).rejects.toThrow('ACCOUNT_WALLET_NOT_FOUND');
  });
});
