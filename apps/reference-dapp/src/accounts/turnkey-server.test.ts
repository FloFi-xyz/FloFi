// SPDX-License-Identifier: AGPL-3.0-only
// The parent-API stamp is verified with node:crypto against the configured public key; the provider is an in-process transport.
import { describe, expect, it } from 'vitest';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { apiKeyStamp, createTurnkeyServer, turnkeyConfig } from './turnkey-server';

const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
const apiPrivateKey = ecdh.getPrivateKey('hex').padStart(64, '0'), apiPublicKey = ecdh.getPublicKey('hex', 'compressed');
const env = { FLOFI_TURNKEY_ORGANIZATION_ID: '11111111-2222-4333-8444-555555555555', FLOFI_TURNKEY_API_PUBLIC_KEY: apiPublicKey, FLOFI_TURNKEY_API_PRIVATE_KEY: apiPrivateKey };
const config = turnkeyConfig(env)!;
type Call = { path: string; body: Record<string, unknown>; stamp: string };
function provider(answer: (call: Call) => unknown, calls: Call[] = []) {
  return Object.assign((async (url: string, init: RequestInit) => {
    const call = { path: new URL(url).pathname, body: JSON.parse(String(init.body)) as Record<string, unknown>, stamp: (init.headers as Record<string, string>)['X-Stamp']! };
    calls.push(call);
    return new Response(JSON.stringify(answer(call)));
  }) as unknown as typeof fetch, { calls });
}
const completed = (result: object) => ({ activity: { id: 'activity-0001', status: 'ACTIVITY_STATUS_COMPLETED', result } });

describe('Turnkey parent API stamp', () => {
  it('signs the exact body with the configured P-256 key in the provider format', () => {
    const body = JSON.stringify({ organizationId: config.organizationId }), stamp = JSON.parse(Buffer.from(apiKeyStamp(config, body), 'base64url').toString());
    expect(stamp).toMatchObject({ publicKey: apiPublicKey, scheme: 'SIGNATURE_SCHEME_TK_API_P256' });
    const point = ecdh.getPublicKey();
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(body), key, Buffer.from(stamp.signature, 'hex'))).toBe(true);
    expect(verify('sha256', Buffer.from(body + ' '), key, Buffer.from(stamp.signature, 'hex'))).toBe(false);
  });
  it('fails closed on a mismatched key pair or an unofficial provider host', () => {
    const other = createECDH('prime256v1'); other.generateKeys();
    expect(() => apiKeyStamp({ apiPublicKey: other.getPublicKey('hex', 'compressed'), apiPrivateKey }, '{}')).toThrow('TURNKEY_API_KEY_MISMATCH');
    expect(turnkeyConfig({})).toBeNull();
    expect(turnkeyConfig({ ...env, FLOFI_TURNKEY_API_BASE_URL: 'https://api.evil.example' })).toBeNull();
    expect(turnkeyConfig({ ...env, FLOFI_TURNKEY_EXPORT_IFRAME_URL: 'http://127.0.0.1:9' })).toBeNull();
    expect(turnkeyConfig({ ...env, FLOFI_TURNKEY_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_TURNKEY_API_BASE_URL: 'http://127.0.0.1:9' })?.apiBaseUrl).toBe('http://127.0.0.1:9');
    expect(turnkeyConfig({ ...env, FLOFI_TURNKEY_E2E: 'MOCKED_LOOPBACK_ONLY', VERCEL: '1' })).toBeNull();
    expect(turnkeyConfig({ ...env, FLOFI_TURNKEY_API_PRIVATE_KEY: 'zz' })).toBeNull();
    expect(Object.values(createTurnkeyServer(config).browser()).join(' ')).not.toContain(apiPrivateKey);
  });
});

describe('Turnkey activities', () => {
  it('sends the email code through the provider and binds verification to the browser key', async () => {
    const transport = provider(call => call.path.endsWith('init_otp') ? completed({ initOtpResult: { otpId: 'otp-00000001' } })
      : completed({ verifyOtpResult: { verificationToken: 'verification.token.value' } }));
    const server = createTurnkeyServer(config, transport);
    expect(await server.initEmailOtp('ana@example.com')).toBe('otp-00000001');
    expect(await server.verifyEmailOtp('otp-00000001', '123456', '02' + 'a'.repeat(64))).toBe('verification.token.value');
    expect(transport.calls.map(call => [call.path, call.body.type, call.body.organizationId])).toEqual([
      ['/public/v1/submit/init_otp', 'ACTIVITY_TYPE_INIT_OTP_V2', config.organizationId], ['/public/v1/submit/verify_otp', 'ACTIVITY_TYPE_VERIFY_OTP', config.organizationId]]);
    expect(transport.calls[1]!.body.parameters).toMatchObject({ otpId: 'otp-00000001', otpCode: '123456', publicKey: '02' + 'a'.repeat(64) });
  });
  it('creates a sub-organization whose only root user is the person (no FloFi key)', async () => {
    const transport = provider(() => completed({ createSubOrganizationResultV7: { subOrganizationId: 'org-0000-0001', rootUserIds: ['user-0000-0001'] } }));
    expect(await createTurnkeyServer(config, transport).createOrganization('flofi-acct', { provider: 'Google', oidcToken: 'h.p.s', email: 'ana@example.com' }))
      .toEqual({ organization: 'org-0000-0001', user: 'user-0000-0001' });
    const parameters = transport.calls[0]!.body.parameters as { rootUsers: { apiKeys: unknown[]; authenticators: unknown[]; oauthProviders: unknown[] }[]; rootQuorumThreshold: number };
    expect(parameters.rootQuorumThreshold).toBe(1);
    expect(parameters.rootUsers).toHaveLength(1);
    expect(parameters.rootUsers[0]).toMatchObject({ apiKeys: [], authenticators: [], oauthProviders: [{ providerName: 'Google', oidcToken: 'h.p.s' }] });
  });
  it('polls pending activities and never reads consensus, rejection or failure as success', async () => {
    let polls = 0;
    const transport = provider(call => call.path.endsWith('get_activity') ? (++polls < 2 ? { activity: { id: 'activity-0001', status: 'ACTIVITY_STATUS_PENDING' } }
      : completed({ oauthLoginResult: { session: 'session.jwt.value' } })) : { activity: { id: 'activity-0001', status: 'ACTIVITY_STATUS_CREATED' } });
    expect(await createTurnkeyServer(config, transport, async () => undefined).oidcLogin('org-0000-0001', 'h.p.s', '02' + 'a'.repeat(64))).toBe('session.jwt.value');
    // The browser's provider session key lives 15 minutes, for the browser's own key only.
    expect(transport.calls[0]!.body.parameters).toEqual({ oidcToken: 'h.p.s', publicKey: '02' + 'a'.repeat(64), expirationSeconds: '900' });
    for (const status of ['ACTIVITY_STATUS_CONSENSUS_NEEDED', 'ACTIVITY_STATUS_REJECTED', 'ACTIVITY_STATUS_FAILED']) {
      const stuck = provider(() => ({ activity: { id: 'activity-0001', status, result: { oauthLoginResult: { session: 'session.jwt.value' } } } }));
      await expect(createTurnkeyServer(config, stuck, async () => undefined).oidcLogin('org-0000-0001', 'h.p.s', '02' + 'a'.repeat(64))).rejects.toThrow('TURNKEY_ACTIVITY_NOT_COMPLETED');
    }
    const unauthorized = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(createTurnkeyServer(config, unauthorized).walletAccounts('org-0000-0001')).rejects.toThrow('TURNKEY_UNAUTHORIZED');
  });
  it('reads only public wallet metadata', async () => {
    const transport = provider(call => call.path.endsWith('list_wallet_accounts')
      ? { accounts: [{ walletId: 'wallet-0001', address: '0xAbC0000000000000000000000000000000000001', addressFormat: 'ADDRESS_FORMAT_ETHEREUM' },
        { walletId: 'wallet-0001', address: 'bc1q', addressFormat: 'ADDRESS_FORMAT_BITCOIN' }] }
      : { privateKeys: [{ privateKeyId: 'key-00000001', imported: true, addresses: [{ format: 'ADDRESS_FORMAT_SOLANA', address: 'So11111111111111111111111111111111111111112' }] }] });
    const server = createTurnkeyServer(config, transport);
    expect(await server.walletAccounts('org-0000-0001')).toEqual([{ walletId: 'wallet-0001', address: '0xAbC0000000000000000000000000000000000001', format: 'ADDRESS_FORMAT_ETHEREUM' }]);
    expect(await server.privateKeys('org-0000-0001')).toEqual([{ privateKeyId: 'key-00000001', imported: true, addresses: [{ format: 'ADDRESS_FORMAT_SOLANA', address: 'So11111111111111111111111111111111111111112' }] }]);
  });
});
