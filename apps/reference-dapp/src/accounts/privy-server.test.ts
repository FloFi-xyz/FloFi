// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: FloFi's Privy server side, through the official `@privy-io/node` SDK itself. Access tokens are real ES256 JWTs
 * signed with a key generated for this test (Privy's format: issuer `privy.io`, audience the app id, subject the user DID, `sid`); the SDK
 * verifies them against that key's PEM (`PRIVY_VERIFICATION_KEY`) and reads users through an injected transport. No network is used.
 */
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPrivyServer, officialPrivyApi, privyBrowserConfig, privyConfig, readPrivyUser, type PrivyServerConfig } from './privy-server';
import { createAccountService } from './account-service';
import type { AccountStore } from './account-store';

// A disposable app secret generated for this run (never a real Privy secret).
const APP_ID = 'cmflofitestapp0000000001', SECRET = randomBytes(24).toString('hex');
const USER = 'did:privy:cmuser000000000000000000001';
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' }), other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(claims: Record<string, unknown>, key = keys.privateKey, header: Record<string, unknown> = { alg: 'ES256', typ: 'JWT' }): string {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64(header)}.${b64({ iss: 'privy.io', aud: APP_ID, sub: USER, sid: 'cmsession00000000000000001', iat: now, exp: now + 3600, ...claims })}`;
  const signature = createSign('SHA256').update(body).sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${body}.${signature}`;
}
const config: PrivyServerConfig = { appId: APP_ID, appSecret: SECRET, apiUrl: 'https://api.privy.io', verificationKey: PEM, apple: false, e2e: false };
const user = (linked: readonly Record<string, unknown>[], id = USER) => ({ id, created_at: 1, has_accepted_terms: false, is_guest: false, mfa_methods: [], linked_accounts: linked });
const google = { type: 'google_oauth', subject: '109876543210987654321', email: 'Ana@Example.com', name: 'Ana', verified_at: 10, first_verified_at: 10, latest_verified_at: 20 };
const email = { type: 'email', address: 'ana@example.com', verified_at: 5, first_verified_at: 5, latest_verified_at: 30 };
const metamask = { type: 'wallet', chain_type: 'ethereum', address: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01', wallet_client: 'unknown', wallet_client_type: 'metamask',
  connector_type: 'injected', verified_at: 1, first_verified_at: 1, latest_verified_at: 2 };
const embeddedEvm = { type: 'wallet', id: 'privywalletevm0000000001', chain_type: 'ethereum', chain_id: 'eip155:1', address: '0x1111111111111111111111111111111111111111',
  wallet_client: 'privy', wallet_client_type: 'privy', connector_type: 'embedded', imported: false, delegated: false, wallet_index: 0, recovery_method: 'privy',
  user_can_sign: true, verified_at: 3, first_verified_at: 3, latest_verified_at: 3 };
const importedSolana = { ...embeddedEvm, id: 'privywalletsol0000000001', chain_type: 'solana', chain_id: 'solana:mainnet', address: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV',
  public_key: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', imported: true };

function server(answer: (url: URL, init: RequestInit) => Response, overrides: Partial<PrivyServerConfig> = {}) {
  const seen: { url: string; authorization: string | null; app: string | null }[] = [];
  const transport = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), headers = new Headers(init.headers);
    seen.push({ url: url.href, authorization: headers.get('authorization'), app: headers.get('privy-app-id') });
    return answer(url, init);
  }) as typeof fetch;
  const effective = { ...config, ...overrides };
  return { privy: createPrivyServer(effective, officialPrivyApi(effective, transport)), seen };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('Privy configuration', () => {
  it('needs the app id and the server secret, and never offers the loopback emulator on a hosted deployment', () => {
    expect(privyConfig({})).toBeNull();
    expect(privyConfig({ NEXT_PUBLIC_PRIVY_APP_ID: APP_ID })).toBeNull();
    expect(privyConfig({ NEXT_PUBLIC_PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: SECRET })).toMatchObject({ appId: APP_ID, apiUrl: 'https://api.privy.io', e2e: false, apple: false });
    expect(privyConfig({ NEXT_PUBLIC_PRIVY_APP_ID: 'bad id!', PRIVY_APP_SECRET: SECRET })).toBeNull();
    expect(privyConfig({ NEXT_PUBLIC_PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: 'short' })).toBeNull();
    // Another API host only for the MOCKED loopback suite, only on loopback http, never on a hosted deployment.
    expect(privyConfig({ NEXT_PUBLIC_PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: SECRET, PRIVY_API_URL: 'http://127.0.0.1:8581' })).toBeNull();
    expect(privyConfig({ NEXT_PUBLIC_PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: SECRET, PRIVY_API_URL: 'http://127.0.0.1:8581', FLOFI_PRIVY_E2E: 'MOCKED_LOOPBACK_ONLY' }))
      .toMatchObject({ apiUrl: 'http://127.0.0.1:8581', e2e: true });
    expect(privyConfig({ NEXT_PUBLIC_PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: SECRET, PRIVY_API_URL: 'https://evil.example', FLOFI_PRIVY_E2E: 'MOCKED_LOOPBACK_ONLY' })).toBeNull();
    expect(privyConfig({ NEXT_PUBLIC_PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: SECRET, FLOFI_PRIVY_E2E: 'MOCKED_LOOPBACK_ONLY', VERCEL: '1' })).toBeNull();
    expect(privyConfig({ NEXT_PUBLIC_PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: SECRET, FLOFI_PRIVY_E2E: 'yes' })).toBeNull();
    expect(privyConfig({ NEXT_PUBLIC_PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: SECRET, PRIVY_VERIFICATION_KEY: 'not a key' })).toBeNull();
    expect(privyConfig({ NEXT_PUBLIC_PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: SECRET, PRIVY_VERIFICATION_KEY: PEM.trim().replace(/\n/g, '\\n') })?.verificationKey).toBe(PEM);
  });
  it('gives the browser public values only (never the secret or the verification key)', () => {
    const browser = privyBrowserConfig({ NEXT_PUBLIC_PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: SECRET, PRIVY_VERIFICATION_KEY: PEM, FLOFI_PRIVY_APPLE_LOGIN: 'enabled' });
    expect(browser).toEqual({ appId: APP_ID, apple: true, e2e: false });
    expect(JSON.stringify(browser)).not.toContain(SECRET);
  });
});

describe('Privy access tokens (verified by @privy-io/node)', () => {
  const { privy } = server(() => json({}, 500));
  it('accepts a token for this app signed by Privy’s key and returns the user DID', async () => {
    await expect(privy.verify(token({}))).resolves.toMatchObject({ userId: USER, sessionId: 'cmsession00000000000000001' });
  });
  it('refuses forged, expired, foreign, malformed and wrong-issuer tokens', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const bad of [token({}, other.privateKey), token({ exp: now - 10 }), token({ aud: 'cmanotherapp000000000001' }), token({ iss: 'evil.io' }),
      token({ sub: 'did:privy:x' }), token({}, keys.privateKey, { alg: 'none', typ: 'JWT' }), 'not.a.jwt', '', 'a'.repeat(5000), null, 42]) {
      await expect(privy.verify(bad)).rejects.toThrow('PRIVY_TOKEN_INVALID');
    }
  });
  it('spends one sign-in proof for all valid signature representations of the same signed token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { privy } = server(() => json(user([{ ...email, latest_verified_at: now }])));
    const original = token({}), [header, payload, signature] = original.split('.') as [string, string, string];
    // A 64-byte ES256 signature has four unused bits in its last base64url character. The verifier accepts aliases with those bits set.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', index = alphabet.indexOf(signature.at(-1)!);
    const alias = `${header}.${payload}.${signature.slice(0, -1)}${alphabet[(index & 48) | 1]}`;
    // ECDSA also permits (r, n - s): a different signature with the same signed content, generated without the signing key.
    const bytes = Buffer.from(signature, 'base64url'), order = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
    const s = BigInt(`0x${bytes.subarray(32).toString('hex')}`);
    const flipped = Buffer.concat([bytes.subarray(0, 32), Buffer.from((order - s).toString(16).padStart(64, '0'), 'hex')]);
    const malleated = `${header}.${payload}.${flipped.toString('base64url')}`;
    expect(new Set([original, alias, malleated]).size).toBe(3);
    for (const valid of [original, alias, malleated]) await expect(privy.verify(valid)).resolves.toMatchObject({ userId: USER });
    // The proof store double models PostgreSQL's unique digest; no SDK verification is mocked.
    const proofs = new Set<string>();
    let sessions = 0;
    const store = {
      consumeProof: async (digest: string) => { if (proofs.has(digest)) return false; proofs.add(digest); return true; },
      signInPrivy: async () => { sessions++; return { accountId: `acct_${'a'.repeat(32)}`, sessionId: 'b'.repeat(32), method: 'email' as const,
        authenticatedAt: now, expiresAt: now + 3600, created: true, skipped: 0 }; },
      wallets: async () => [], account: async () => null,
    } satisfies Pick<AccountStore, 'consumeProof' | 'signInPrivy' | 'wallets' | 'account'>;
    const service = createAccountService({ store: store as unknown as AccountStore, privy });
    // An invalid signature cannot consume the valid token's proof.
    await expect(service.completePrivy(token({}, other.privateKey))).rejects.toThrow('PRIVY_TOKEN_INVALID');
    expect(proofs.size).toBe(0);
    await expect(service.completePrivy(original)).resolves.toMatchObject({ session: { method: 'email' } });
    for (const replay of [original, alias, malleated]) await expect(service.completePrivy(replay)).rejects.toThrow('PRIVY_SIGN_IN_STALE');
    expect(proofs.size).toBe(1);
    expect(sessions).toBe(1);
  });
});

describe('Privy users (read with the app secret, never from the browser)', () => {
  it('reads the user with the app credentials and maps verified identities and embedded wallets', async () => {
    const { privy, seen } = server(url => url.pathname === `/v1/users/${USER}` ? json(user([google, email, metamask, embeddedEvm, importedSolana])) : json({}, 404));
    const result = await privy.user(USER);
    expect(seen[0]).toMatchObject({ url: `https://api.privy.io/v1/users/${USER}`, app: APP_ID });
    expect(seen[0]!.authorization).toBe(`Basic ${Buffer.from(`${APP_ID}:${SECRET}`).toString('base64')}`);
    expect(result.identities).toEqual([
      { kind: 'google', subject: '109876543210987654321', label: 'ana@example.com' },
      { kind: 'email', subject: 'ana@example.com', label: 'ana@example.com' },
      { kind: 'eip155', subject: '0xabcdef0123456789abcdef0123456789abcdef01', label: null },
    ]);
    // The most recently verified sign-in method (the email code, latest_verified_at 30), and when Privy verified it.
    expect(result.method).toBe('email');
    expect(result.verifiedAt).toBe(30);
    expect(result.wallets).toEqual([
      { ecosystem: 'evm', address: '0x1111111111111111111111111111111111111111', imported: false, delegated: false, walletId: 'privywalletevm0000000001' },
      { ecosystem: 'solana', address: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', imported: true, delegated: false, walletId: 'privywalletsol0000000001' },
    ]);
  });
  it('counts an Apple identity only once this deployment enabled Apple (FloFi’s own Apple Services ID in Privy)', () => {
    const apple = { type: 'apple_oauth', subject: '001234.abcdef.0123', email: 'ana@privaterelay.appleid.com', verified_at: 40, latest_verified_at: 40 };
    expect(readPrivyUser(user([apple, google]), USER)).toMatchObject({ identities: [{ kind: 'google' }], method: 'google', verifiedAt: 20 });
    expect(readPrivyUser(user([apple, google]), USER, { apple: true })).toMatchObject({ identities: [{ kind: 'apple' }, { kind: 'google' }], method: 'apple', verifiedAt: 40 });
    expect(readPrivyUser(user([apple]), USER)).toEqual({ id: USER, identities: [], method: null, wallets: [], verifiedAt: null });
  });
  it('maps provider failures to stable codes', async () => {
    await expect(server(() => json({ error: 'nope' }, 404)).privy.user(USER)).rejects.toThrow('PRIVY_USER_NOT_FOUND');
    await expect(server(() => json({ error: 'nope' }, 401)).privy.user(USER)).rejects.toThrow('PRIVY_NOT_AUTHORIZED');
    await expect(server(() => { throw new TypeError('fetch failed'); }).privy.user(USER)).rejects.toThrow('PRIVY_UNAVAILABLE');
    await expect(server(() => json(user([google], 'did:privy:cmsomeoneelse0000000000001'))).privy.user(USER)).rejects.toThrow('PRIVY_RESPONSE_INVALID');
    await expect(server(() => json({})).privy.user('did:privy:x')).rejects.toThrow('PRIVY_TOKEN_INVALID');
  });
  it('is strict: an embedded wallet is never a sign-in identity, an external wallet never a managed wallet, and malformed entries are ignored', () => {
    const parsed = readPrivyUser(user([
      { ...embeddedEvm, connector_type: 'injected' },               // claims privy client but not embedded: ignored
      { ...metamask, wallet_client_type: 'privy' },                 // claims privy client: not an external identity
      { ...metamask, address: 'not-an-address' },
      { type: 'google_oauth', subject: 'bad subject!' },
      { type: 'email', address: 'not-an-email' },
      { type: 'phone', number: '+15555550123', verified_at: 99, latest_verified_at: 99 },
      { ...embeddedEvm, chain_type: 'bitcoin-segwit' },
    ]), USER);
    expect(parsed).toEqual({ id: USER, identities: [], method: null, wallets: [], verifiedAt: null });
  });
});
