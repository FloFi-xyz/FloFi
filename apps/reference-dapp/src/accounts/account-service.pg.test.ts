// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001 integration on real PostgreSQL: FloFi's own account rules behind Privy sign-in and Privy wallets. Privy's API is
 * an in-memory stand-in for `verifyAccessToken` / `users._get` (the official SDK's verification itself is covered by privy-server.test.ts),
 * so these tests prove what FloFi decides with Privy's answers: which account a sign-in reaches, that nothing is merged or moved, and that
 * only the account's own Privy user's embedded wallets are saved. MOCKED provider evidence only.
 */
import { beforeEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness';
import { createAccountStore } from './account-store';
import { createAccountService } from './account-service';
import { createPrivyServer, type PrivyApi, type PrivyServerConfig } from './privy-server';

const APP = 'cmflofitestapp0000000001';
const config: PrivyServerConfig = { appId: APP, appSecret: 'x'.repeat(32), apiUrl: 'https://api.privy.io', verificationKey: null, apple: false, e2e: false };
type Linked = Record<string, unknown>;
const did = (n: number) => `did:privy:cmuser${String(n).padStart(19, '0')}`;
/** Privy's verification time of an identity: `at` seconds after a moment shortly before the test clock (orders methods; stays recent). */
const verified = (at: number) => Math.floor(clock.getTime() / 1000) - 100 + at;
const google = (subject: string, at = 10): Linked => ({ type: 'google_oauth', subject, email: `${subject}@gmail.com`, latest_verified_at: verified(at), verified_at: verified(at) });
const email = (address: string, at = 10): Linked => ({ type: 'email', address, latest_verified_at: verified(at), verified_at: verified(at) });
const external = (address: string, at = 10): Linked => ({ type: 'wallet', chain_type: 'ethereum', address, wallet_client_type: 'metamask', connector_type: 'injected',
  latest_verified_at: verified(at), verified_at: verified(at) });
const embedded = (address: string, options: { solana?: boolean; imported?: boolean; id?: string } = {}): Linked => ({ type: 'wallet', id: options.id ?? `w${address.slice(-23)}`,
  chain_type: options.solana ? 'solana' : 'ethereum', address, wallet_client_type: 'privy', connector_type: 'embedded', imported: options.imported === true, delegated: false,
  verified_at: 1, latest_verified_at: 1 });
const EVM_1 = '0x' + '1'.repeat(40), EVM_2 = '0x' + '2'.repeat(40), EVM_X = '0x' + 'a'.repeat(40), SOL_1 = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';

let t: TestDatabase, clock: Date;
const users = new Map<string, Linked[]>();
/**
 * Privy's two answers: a token is `h.<base64url DID>.s<n>` issued now (each one unique, as Privy's are), or `h.<DID>.t<seconds>` issued at
 * that time; unknown or malformed ones are refused like a bad signature.
 */
const api: PrivyApi = {
  verifyAccessToken: async token => {
    const [head, body = '', tail = ''] = token.split('.'), user = head === 'h' ? Buffer.from(body, 'base64url').toString() : '';
    if (!users.has(user)) throw new Error('Authentication token is invalid');
    const issuedAt = tail.startsWith('t') ? Number(tail.slice(1)) : Math.floor(clock.getTime() / 1000);
    return { app_id: APP, user_id: user, session_id: 'sid', issued_at: issuedAt, expiration: Math.floor(Date.now() / 1000) + 3600 };
  },
  getUser: async id => ({ id, linked_accounts: users.get(id) ?? [] }),
};
let issued = 0;
const tokenOf = (id: string, issuedAtSeconds?: number) => `h.${Buffer.from(id).toString('base64url')}.${issuedAtSeconds === undefined ? `s${++issued}` : `t${issuedAtSeconds}`}`;
const store = () => createAccountStore(t.db, 'default');
const service = () => createAccountService({ store: store(), privy: createPrivyServer(config, api), now: () => clock });
const signIn = (id: string) => service().completePrivy(tokenOf(id));
const identities = async (accountId: string) => (await t.db.query<{ kind: string; subject: string }>(
  'SELECT kind, subject FROM flofi_account_identities WHERE account_id=$1 ORDER BY kind, subject', [accountId])).rows;

beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
beforeEach(async () => {
  clock = new Date();
  users.clear();
  await t.db.query('DELETE FROM flofi_accounts WHERE tenant_id=$1', ['default']);
});

describe('Privy sign-in reaches exactly one FloFi account', () => {
  it('creates an account for a new Privy user, with its verified Google identity, and returns to it afterwards', async () => {
    users.set(did(1), [google('g-1')]);
    const first = await signIn(did(1));
    expect(first).toMatchObject({ created: true, onboarding: 'pending', session: { method: 'google' } });
    expect(await identities(first.session.accountId)).toEqual([{ kind: 'GOOGLE', subject: 'g-1' }, { kind: 'PRIVY', subject: did(1) }]);
    const again = await signIn(did(1));
    expect(again).toMatchObject({ created: false, session: { accountId: first.session.accountId } });
    expect(again.session.sessionId).not.toBe(first.session.sessionId);
    // The view hides the Privy DID itself and says the account is linked to Privy.
    const view = await service().view(again.session);
    expect(view).toMatchObject({ privy: true, identities: [{ kind: 'google', label: 'g-1@gmail.com' }] });
  });

  it('preserves every pre-Privy account: the same Google subject, verified email or external wallet reaches it', async () => {
    const byGoogle = await store().signIn({ kind: 'google', subject: 'g-old', label: null });
    const byEmail = await store().signIn({ kind: 'email', subject: 'old@example.com', label: 'old@example.com' });
    const byWallet = await store().signIn({ kind: 'eip155', subject: EVM_X, label: null });
    users.set(did(2), [google('g-old')]); users.set(did(3), [email('old@example.com')]); users.set(did(4), [external('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')]);
    expect(await signIn(did(2))).toMatchObject({ created: false, session: { accountId: byGoogle.accountId, method: 'google' } });
    expect(await signIn(did(3))).toMatchObject({ created: false, session: { accountId: byEmail.accountId, method: 'email' } });
    expect(await signIn(did(4))).toMatchObject({ created: false, session: { accountId: byWallet.accountId, method: 'eip155' } });
    expect(await identities(byWallet.accountId)).toEqual([{ kind: 'EIP155', subject: EVM_X }, { kind: 'PRIVY', subject: did(4) }]);
  });

  it('never matches across kinds: a Google account’s email does not reach the account that verified that address by code', async () => {
    const byEmail = await store().signIn({ kind: 'email', subject: 'g-5@gmail.com', label: 'g-5@gmail.com' });
    users.set(did(5), [google('g-5')]);
    const outcome = await signIn(did(5));
    expect(outcome.created).toBe(true);
    expect(outcome.session.accountId).not.toBe(byEmail.accountId);
  });

  it('refuses a sign-in that matches two accounts, and merges, moves or creates nothing', async () => {
    const a = await store().signIn({ kind: 'google', subject: 'g-a', label: null });
    const b = await store().signIn({ kind: 'email', subject: 'b@example.com', label: 'b@example.com' });
    users.set(did(6), [google('g-a'), email('b@example.com')]);
    await expect(signIn(did(6))).rejects.toThrow('ACCOUNT_IDENTITY_CONFLICT');
    expect(await identities(a.accountId)).toEqual([{ kind: 'GOOGLE', subject: 'g-a' }]);
    expect(await identities(b.accountId)).toEqual([{ kind: 'EMAIL', subject: 'b@example.com' }]);
    expect((await t.db.query("SELECT count(*)::int AS n FROM flofi_account_identities WHERE kind='PRIVY'")).rows).toEqual([{ n: 0 }]);
  });

  it('refuses a second Privy user for an account already linked to one (no identity takeover)', async () => {
    users.set(did(7), [google('g-7')]);
    const owner = await signIn(did(7));
    users.set(did(8), [google('g-7')]);
    await expect(signIn(did(8))).rejects.toThrow('ACCOUNT_PRIVY_USER_MISMATCH');
    expect(await identities(owner.session.accountId)).toEqual([{ kind: 'GOOGLE', subject: 'g-7' }, { kind: 'PRIVY', subject: did(7) }]);
  });

  it('leaves an identity another account holds with that account when the Privy user later verifies it too', async () => {
    users.set(did(9), [google('g-9')]);
    const mine = await signIn(did(9));
    const other = await store().signIn({ kind: 'email', subject: 'shared@example.com', label: 'shared@example.com' });
    users.set(did(9), [google('g-9'), email('shared@example.com', 50)]);
    const again = await signIn(did(9));
    expect(again.session.accountId).toBe(mine.session.accountId);
    expect(await identities(other.accountId)).toEqual([{ kind: 'EMAIL', subject: 'shared@example.com' }]);
    expect(await identities(mine.session.accountId)).toEqual([{ kind: 'GOOGLE', subject: 'g-9' }, { kind: 'PRIVY', subject: did(9) }]);
  });

  it('never treats an embedded wallet as a sign-in identity, and refuses users with no accepted sign-in method', async () => {
    const holder = await store().signIn({ kind: 'eip155', subject: EVM_1, label: null });
    users.set(did(10), [embedded(EVM_1), { type: 'phone', number: '+15555550123', latest_verified_at: 99 }]);
    await expect(signIn(did(10))).rejects.toThrow('PRIVY_LOGIN_METHOD_UNSUPPORTED');
    expect(await identities(holder.accountId)).toEqual([{ kind: 'EIP155', subject: EVM_1 }]);
  });

  it('signs in only with a token Privy just issued, and only once', async () => {
    users.set(did(14), [email('once@example.com')]);
    const token = tokenOf(did(14));
    const first = await service().completePrivy(token);
    await expect(service().completePrivy(token)).rejects.toThrow('PRIVY_SIGN_IN_STALE');
    const old = Math.floor(clock.getTime() / 1000) - 11 * 60;
    await expect(service().completePrivy(tokenOf(did(14), old))).rejects.toThrow('PRIVY_SIGN_IN_STALE');
    expect((await service().completePrivy(tokenOf(did(14)))).session.accountId).toBe(first.session.accountId);
    expect((await t.db.query("SELECT count(*)::int AS n FROM flofi_account_sessions WHERE revoked_at IS NULL")).rows).toEqual([{ n: 2 }]);
  });

  it('opens no session from a silently refreshed token of an old Privy login, and dates a session from Privy’s last verification', async () => {
    // An hour-old Privy login whose access token was just refreshed: nothing is opened (the token is new, the login is not).
    users.set(did(15), [google('g-15', -3600)]);
    await expect(signIn(did(15))).rejects.toThrow('PRIVY_SIGN_IN_STALE');
    // A verification time from the future, or none at all, counts as old too.
    users.set(did(15), [google('g-15', 400)]);
    await expect(signIn(did(15))).rejects.toThrow('PRIVY_SIGN_IN_STALE');
    users.set(did(15), [{ type: 'google_oauth', subject: 'g-15', email: 'g-15@gmail.com' }]);
    await expect(signIn(did(15))).rejects.toThrow('PRIVY_SIGN_IN_STALE');
    expect((await t.db.query('SELECT count(*)::int AS n FROM flofi_account_sessions')).rows).toEqual([{ n: 0 }]);
    // A real sign-in at Privy (a new verification) opens a session that counts as recent, from that verification.
    users.set(did(15), [google('g-15')]);
    const fresh = await signIn(did(15));
    expect(fresh.session.authenticatedAt).toBe(verified(10));
    await service().deleteAccount(fresh.session);
  });

  it('removes email-code challenges older than a day at every sign-in (they hold a plaintext email)', async () => {
    await t.db.query(`INSERT INTO flofi_account_email_challenges (tenant_id, challenge_id, email, provider_challenge, browser_binding, created_at, expires_at)
      VALUES ('default', $1, 'old@example.com', 'otp-12345678', $2, $3::timestamptz - interval '2 days', $3::timestamptz - interval '2 days' + interval '10 minutes'),
             ('default', $4, 'new@example.com', 'otp-87654321', $2, $3, $3::timestamptz + interval '10 minutes')`,
    ['a'.repeat(32), '02' + 'b'.repeat(64), clock, 'c'.repeat(32)]);
    users.set(did(16), [google('g-16')]);
    await signIn(did(16));
    expect((await t.db.query('SELECT email FROM flofi_account_email_challenges ORDER BY email')).rows).toEqual([{ email: 'new@example.com' }]);
  });

  it('refuses an unverifiable token and writes nothing', async () => {
    await expect(service().completePrivy(tokenOf(did(99)))).rejects.toThrow('PRIVY_TOKEN_INVALID');
    await expect(service().completePrivy('not a token')).rejects.toThrow('PRIVY_TOKEN_INVALID');
    expect((await t.db.query('SELECT count(*)::int AS n FROM flofi_accounts')).rows).toEqual([{ n: 0 }]);
  });

  it('serializes concurrent first sign-ins of one Privy user into one account', async () => {
    users.set(did(11), [email('race@example.com')]);
    const [one, two] = await Promise.all([signIn(did(11)), signIn(did(11))]);
    expect(one.session.accountId).toBe(two.session.accountId);
    expect((await t.db.query('SELECT count(*)::int AS n FROM flofi_accounts')).rows).toEqual([{ n: 1 }]);
  });

  it('never links two Privy users to one existing account, even when they sign in at the same time through different identities', async () => {
    const before = await store().signIn({ kind: 'email', subject: 'both@example.com', label: 'both@example.com' });
    await store().linkIdentity(before.accountId, { kind: 'google', subject: 'g-12', label: null });
    users.set(did(12), [email('both@example.com')]);
    users.set(did(13), [google('g-12')]);
    const results = await Promise.allSettled([signIn(did(12)), signIn(did(13))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.flatMap(result => result.status === 'rejected' ? [(result.reason as Error).message] : [])).toEqual(['ACCOUNT_PRIVY_USER_MISMATCH']);
    expect((await t.db.query("SELECT count(*)::int AS n FROM flofi_account_identities WHERE kind='PRIVY' AND account_id=$1", [before.accountId])).rows).toEqual([{ n: 1 }]);
  });
});

describe('Privy wallets are saved only for the account’s own Privy user', () => {
  it('saves a created and an imported wallet with the Privy wallet id and a private-key export only', async () => {
    users.set(did(20), [google('g-20'), embedded(EVM_1, { id: 'privywalletevm0000000020' })]);
    const { session } = await signIn(did(20));
    users.set(did(20), [google('g-20'), embedded(EVM_1, { id: 'privywalletevm0000000020' }), embedded(SOL_1, { solana: true, imported: true })]);
    const created = await service().savePrivyWallet(session, tokenOf(did(20)), { ecosystem: 'evm', address: EVM_1.toUpperCase().replace('0X', '0x') });
    expect(created).toMatchObject({ ecosystem: 'evm', address: EVM_1, origin: 'generated', provider: 'privy', export: 'private-key', label: 'EVM wallet' });
    const imported = await service().savePrivyWallet(session, tokenOf(did(20)), { ecosystem: 'solana', address: SOL_1, label: '  My  Phantom key ' });
    expect(imported).toMatchObject({ ecosystem: 'solana', origin: 'imported', provider: 'privy', export: 'private-key', label: 'My Phantom key' });
    expect((await t.db.query("SELECT provider_resource FROM flofi_account_wallets WHERE address=$1", [EVM_1])).rows).toEqual([{ provider_resource: 'privywalletevm0000000020' }]);
    // Idempotent: saving the same wallet again changes nothing.
    expect(await service().savePrivyWallet(session, tokenOf(did(20)), { ecosystem: 'evm', address: EVM_1 })).toMatchObject({ id: created.id, label: 'EVM wallet' });
  });

  it('refuses another Privy user’s token, a wallet that is not one of the user’s embedded wallets, a bad name, and an unlinked account', async () => {
    users.set(did(21), [google('g-21'), embedded(EVM_1), external(EVM_X)]);
    users.set(did(22), [google('g-22'), embedded(EVM_2)]);
    const { session } = await signIn(did(21));
    await expect(service().savePrivyWallet(session, tokenOf(did(22)), { ecosystem: 'evm', address: EVM_2 })).rejects.toThrow('PRIVY_ACCOUNT_MISMATCH');
    await expect(service().savePrivyWallet(session, tokenOf(did(21)), { ecosystem: 'evm', address: EVM_X })).rejects.toThrow('ACCOUNT_WALLET_NOT_OWNED');
    await expect(service().savePrivyWallet(session, tokenOf(did(21)), { ecosystem: 'evm', address: EVM_2 })).rejects.toThrow('ACCOUNT_WALLET_NOT_OWNED');
    await expect(service().savePrivyWallet(session, tokenOf(did(21)), { ecosystem: 'evm', address: EVM_1, label: 'x'.repeat(41) })).rejects.toThrow('ACCOUNT_WALLET_LABEL_INVALID');
    await expect(service().savePrivyWallet(session, tokenOf(did(21)), { ecosystem: 'bitcoin', address: EVM_1 })).rejects.toThrow('ACCOUNT_WALLET_INVALID');
    const legacy = await store().signIn({ kind: 'google', subject: 'g-legacy', label: null });
    await expect(service().savePrivyWallet(legacy, tokenOf(did(21)), { ecosystem: 'evm', address: EVM_1 })).rejects.toThrow('PRIVY_ACCOUNT_NOT_LINKED');
    // Only the user's own embedded wallet was saved (by sign-in's recovery); never the external, foreign or refused ones.
    expect((await t.db.query('SELECT account_id, address, provider FROM flofi_account_wallets')).rows).toEqual([{ account_id: session.accountId, address: EVM_1, provider: 'privy' }]);
  });

  it('never moves a wallet another account holds, and never replaces this account’s existing record of the same address', async () => {
    const other = await store().signIn({ kind: 'email', subject: 'x@example.com', label: 'x@example.com' });
    await store().saveWallet(other.accountId, { ecosystem: 'evm', address: EVM_1, origin: 'external', provider: 'io.metamask', providerName: 'MetaMask', providerResource: null, label: 'MetaMask' });
    users.set(did(23), [google('g-23'), embedded(EVM_1, { imported: true })]);
    const { session } = await signIn(did(23));
    await expect(service().savePrivyWallet(session, tokenOf(did(23)), { ecosystem: 'evm', address: EVM_1 })).rejects.toThrow('ACCOUNT_WALLET_LINKED_ELSEWHERE');
    // This account already lists EVM_2 as an external wallet; the person then imports its key into Privy.
    await store().saveWallet(session.accountId, { ecosystem: 'evm', address: EVM_2, origin: 'external', provider: 'io.rabby', providerName: 'Rabby', providerResource: null, label: 'Rabby' });
    users.set(did(23), [google('g-23'), embedded(EVM_1, { imported: true }), embedded(EVM_2, { imported: true })]);
    expect(await service().savePrivyWallet(session, tokenOf(did(23)), { ecosystem: 'evm', address: EVM_2 })).toMatchObject({ origin: 'external', provider: 'io.rabby' });
    expect((await t.db.query('SELECT account_id FROM flofi_account_wallets WHERE address=$1', [EVM_1])).rows).toEqual([{ account_id: other.accountId }]);
  });

  it('recovers wallets whose save never finished, at sign-in and on demand, and reports wallets held elsewhere', async () => {
    users.set(did(24), [google('g-24')]);
    const { session } = await signIn(did(24));
    // Created at Privy, but the browser closed before FloFi saved it.
    users.set(did(24), [google('g-24'), embedded(EVM_1)]);
    expect((await signIn(did(24))).session.accountId).toBe(session.accountId);
    expect((await store().wallets(session.accountId)).map(wallet => wallet.address)).toEqual([EVM_1]);
    const other = await store().signIn({ kind: 'email', subject: 'y@example.com', label: 'y@example.com' });
    await store().saveWallet(other.accountId, { ecosystem: 'evm', address: EVM_2, origin: 'external', provider: 'io.metamask', providerName: 'MetaMask', providerResource: null, label: 'MetaMask' });
    users.set(did(24), [google('g-24'), embedded(EVM_1), embedded(EVM_2, { imported: true }), embedded(SOL_1, { solana: true })]);
    const synced = await service().syncPrivyWallets(session, tokenOf(did(24)));
    expect(synced.heldElsewhere).toBe(1);
    expect(synced.wallets.map(wallet => `${wallet.ecosystem}:${wallet.origin}`).sort()).toEqual(['evm:generated', 'solana:generated']);
    await expect(service().syncPrivyWallets(session, tokenOf(did(23)))).rejects.toThrow();
  });

  it('keeps legacy FloFi Wallet (Turnkey) wallets exactly as they were when the account starts using Privy', async () => {
    const legacy = await store().signIn({ kind: 'email', subject: 'legacy@example.com', label: 'legacy@example.com' });
    await store().setWalletOrganization(legacy.accountId, { provider: 'turnkey', organization: 'org-12345678', user: 'user-12345678', login: 'email' });
    await store().saveWallet(legacy.accountId, { ecosystem: 'evm', address: EVM_X, origin: 'generated', provider: 'turnkey', providerName: 'FloFi wallet',
      providerResource: 'wallet-12345678', label: 'EVM wallet' });
    const before = (await t.db.query('SELECT * FROM flofi_account_wallets WHERE address=$1', [EVM_X])).rows;
    users.set(did(25), [email('legacy@example.com'), embedded(EVM_1)]);
    const outcome = await signIn(did(25));
    expect(outcome.session.accountId).toBe(legacy.accountId);
    expect((await t.db.query('SELECT * FROM flofi_account_wallets WHERE address=$1', [EVM_X])).rows).toEqual(before);
    const view = await service().view(outcome.session);
    expect(view?.wallets.map(wallet => `${wallet.provider}:${wallet.origin}:${wallet.export}`).sort()).toEqual(['privy:generated:private-key', 'turnkey:generated:recovery-phrase']);
    expect(view?.managedLogin).toBe('email');
    expect((await service().privyWallets(outcome.session)).map(wallet => wallet.address)).toEqual([EVM_1]);
    // A background sync never changes the legacy record, even once Privy lists the same address (its key imported into Privy)…
    users.set(did(25), [email('legacy@example.com'), embedded(EVM_1), embedded(EVM_X, { imported: true, id: 'privywalletlegacy0000001' })]);
    await service().syncPrivyWallets(outcome.session, tokenOf(did(25)));
    expect((await t.db.query('SELECT * FROM flofi_account_wallets WHERE address=$1', [EVM_X])).rows).toEqual(before);
    // …only the person's explicit Import key does: the same address and name become that Privy wallet, now signable and exported from Privy.
    const adopted = await service().savePrivyWallet(outcome.session, tokenOf(did(25)), { ecosystem: 'evm', address: EVM_X, label: 'Imported again' });
    expect(adopted).toMatchObject({ address: EVM_X, label: 'EVM wallet', provider: 'privy', origin: 'imported', export: 'private-key' });
    expect((await service().privyWallets(outcome.session)).map(wallet => wallet.address).sort()).toEqual([EVM_1, EVM_X].sort());
    expect((await store().account(legacy.accountId))?.organization).toMatchObject({ provider: 'turnkey', organization: 'org-12345678' });
  });

  it('refuses a wallet name that looks like part of a key, so no key fragment reaches the database', async () => {
    users.set(did(28), [google('g-28'), embedded(EVM_1)]);
    const { session } = await signIn(did(28));
    for (const label of ['a'.repeat(40), '0x' + 'ab'.repeat(19), '4NdmBQtrMJVYVfKf2PJy9NZUZdT', 'Main ' + 'f'.repeat(24)])
      await expect(service().savePrivyWallet(session, tokenOf(did(28)), { ecosystem: 'evm', address: EVM_1, label })).rejects.toThrow('ACCOUNT_WALLET_LABEL_KEY_SHAPED');
    await expect(store().renameWallet(session.accountId, 'evm', EVM_1, '0x' + 'cd'.repeat(19))).rejects.toThrow('ACCOUNT_WALLET_LABEL_KEY_SHAPED');
    expect((await t.db.query("SELECT count(*)::int AS n FROM flofi_account_wallets WHERE label ~ '[0-9a-fA-F]{20}|[1-9A-HJ-NP-Za-km-z]{24}'")).rows).toEqual([{ n: 0 }]);
    expect(await service().savePrivyWallet(session, tokenOf(did(28)), { ecosystem: 'evm', address: EVM_1, label: 'Trading 2026' })).toMatchObject({ address: EVM_1 });
    await store().renameWallet(session.accountId, 'evm', EVM_1, 'Trading 2026');
  });

  it('never links one of the account’s own FloFi (Privy) wallets as an external wallet or a sign-in identity', async () => {
    users.set(did(27), [google('g-27'), embedded(EVM_2)]);
    const { session } = await signIn(did(27));
    expect((await service().view(session))?.wallets.map(wallet => wallet.address)).toEqual([EVM_2]);
    await expect(service().linkExternalWallet(session, { namespace: 'eip155', address: EVM_2 }, { key: 'io.metamask', name: 'MetaMask' }))
      .rejects.toThrow('ACCOUNT_WALLET_IS_FLOFI_WALLET');
    expect((await identities(session.accountId)).map(identity => identity.kind).sort()).toEqual(['GOOGLE', 'PRIVY']);
    expect(await service().linkExternalWallet(session, { namespace: 'eip155', address: EVM_X }, { key: 'io.metamask', name: 'MetaMask' }))
      .toMatchObject({ address: EVM_X, origin: 'external', provider: 'io.metamask' });
  });

  it('deletes an account and all its data (Privy identity, sign-ins, sessions, wallets) only after a recent sign-in', async () => {
    users.set(did(26), [google('g-26'), email('ana26@example.com'), embedded(EVM_2)]);
    const { session } = await signIn(did(26));
    expect((await service().view(session))?.wallets.map(wallet => wallet.address)).toEqual([EVM_2]);
    clock = new Date(clock.getTime() + 11 * 60_000);
    await expect(service().deleteAccount(session)).rejects.toThrow('ACCOUNT_REAUTHENTICATION_REQUIRED');
    clock = new Date(session.authenticatedAt * 1000);
    await service().deleteAccount(session);
    for (const table of ['flofi_accounts', 'flofi_account_identities', 'flofi_account_sessions', 'flofi_account_wallets'])
      expect((await t.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows, table).toEqual([{ n: 0 }]);
    // The same Privy user signing in again gets a new, empty account (its Privy wallet is listed again by the sign-in sync).
    expect(await signIn(did(26))).toMatchObject({ created: true });
  });
});
