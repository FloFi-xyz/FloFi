// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-AUTH-WALLETS-001: the sign-in and wallet onboarding policy is strict, scoped to those pages and fails closed.
import { describe, expect, it } from 'vitest';
import { createECDH } from 'node:crypto';
import { ACCOUNT_PAGE_PATHS, accountPagePolicy, cspNonce, isAccountPage } from './account-csp';
import { config } from '../proxy';

const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
const provider = { FLOFI_TURNKEY_ORGANIZATION_ID: '11111111-2222-4333-8444-555555555555',
  FLOFI_TURNKEY_API_PUBLIC_KEY: ecdh.getPublicKey('hex', 'compressed'), FLOFI_TURNKEY_API_PRIVATE_KEY: ecdh.getPrivateKey('hex').padStart(64, '0') };
const directives = (policy: string) => new Map(policy.split('; ').map(entry => { const [name, ...values] = entry.split(' '); return [name, values.join(' ')]; }));

describe('account page Content Security Policy', () => {
  it('runs only nonce-bearing scripts and what they load, talks only to FloFi and is never framed', () => {
    const nonce = cspNonce(), policy = directives(accountPagePolicy(nonce, provider));
    // 'unsafe-eval' is for the shared Ajv validators' code generation (account-csp.ts); no inline script, host or scheme is allowed.
    expect(policy.get('script-src')).toBe(`'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`);
    expect(policy.get('script-src')).not.toMatch(/unsafe-inline|unsafe-hashes|\*|https?:|data:|blob:/);
    expect(policy.get('default-src')).toBe("'self'");
    expect(policy.get('connect-src')).toBe("'self'");
    expect(policy.get('object-src')).toBe("'none'");
    expect(policy.get('base-uri')).toBe("'none'");
    expect(policy.get('form-action')).toBe("'self'");
    expect(policy.get('frame-ancestors')).toBe("'none'");
    expect(policy.get('worker-src')).toBe("'none'");
  });

  it('frames only the validated provider iframe origins, and nothing without a provider', () => {
    expect(directives(accountPagePolicy(cspNonce(), provider)).get('frame-src')).toBe('https://import.turnkey.com https://export.turnkey.com');
    expect(directives(accountPagePolicy(cspNonce(), {})).get('frame-src')).toBe("'none'");
    // An iframe origin the provider configuration refuses (not https *.turnkey.com) disables the provider, so nothing is framed.
    expect(directives(accountPagePolicy(cspNonce(), { ...provider, FLOFI_TURNKEY_IMPORT_IFRAME_URL: 'https://import.evil.example' })).get('frame-src')).toBe("'none'");
    // The offline browser suite's loopback harness is accepted only in its explicit MOCKED mode, and never on a hosted deployment.
    const e2e = { ...provider, FLOFI_TURNKEY_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_TURNKEY_IMPORT_IFRAME_URL: 'http://127.0.0.1:8573', FLOFI_TURNKEY_EXPORT_IFRAME_URL: 'http://127.0.0.1:8572' };
    expect(directives(accountPagePolicy(cspNonce(), e2e)).get('frame-src')).toBe('http://127.0.0.1:8573 http://127.0.0.1:8572');
    expect(directives(accountPagePolicy(cspNonce(), { ...e2e, VERCEL: '1' })).get('frame-src')).toBe("'none'");
  });

  it('uses a fresh 128-bit nonce per request and refuses a malformed one', () => {
    const nonces = new Set(Array.from({ length: 64 }, cspNonce));
    expect(nonces.size).toBe(64);
    for (const nonce of nonces) expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
    for (const bad of ['', 'abc', "x' 'unsafe-inline", `${cspNonce()}; script-src *`]) expect(() => accountPagePolicy(bad, provider)).toThrow('CSP_NONCE_INVALID');
  });

  it('applies to sign-in and wallet onboarding only, and the proxy matches exactly those pages besides /mcp/approve', () => {
    for (const path of ['/login', '/onboarding', '/onboarding/wallets']) expect(isAccountPage(path)).toBe(true);
    for (const path of ['/', '/app', '/app/credentials', '/approve', '/mcp/approve', '/loginx', '/onboardingx', '/docs']) expect(isAccountPage(path)).toBe(false);
    expect(config.matcher).toEqual(['/mcp/approve', ...ACCOUNT_PAGE_PATHS]);
  });
});
