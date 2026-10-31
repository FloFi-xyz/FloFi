// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-AUTH-WALLETS-001 / BUILD-FLOFI-PRIVY-UX-001: the sign-in and wallet onboarding policy is strict, scoped to those pages and fails
// closed; beyond FloFi it allows only Privy's own origins (src/accounts/privy-hosts.ts).
import { describe, expect, it } from 'vitest';
import { ACCOUNT_PAGE_PATHS, accountPagePolicy, cspNonce, isAccountPage } from './account-csp';
import { config } from '../proxy';

const directives = (policy: string) => new Map(policy.split('; ').map(entry => { const [name, ...values] = entry.split(' '); return [name, values.join(' ')]; }));

describe('account page Content Security Policy', () => {
  it('runs only nonce-bearing scripts and what they load, talks only to FloFi and Privy and is never framed', () => {
    const nonce = cspNonce(), policy = directives(accountPagePolicy(nonce));
    // 'unsafe-eval' is for the shared Ajv validators' code generation (account-csp.ts); no inline script, host or scheme is allowed.
    expect(policy.get('script-src')).toBe(`'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`);
    expect(policy.get('script-src')).not.toMatch(/unsafe-inline|unsafe-hashes|\*|https?:|data:|blob:/);
    expect(policy.get('default-src')).toBe("'self'");
    expect(policy.get('connect-src')).toBe("'self' https://auth.privy.io https://*.rpc.privy.systems wss://*.rpc.privy.systems https://rpc.mainnet.chain.robinhood.com wss://www.walletlink.org");
    expect(policy.get('connect-src')).not.toMatch(/walletconnect|turnkey|\*\.privy\.io|https:(?:\s|$)/);
    expect(policy.get('object-src')).toBe("'none'");
    expect(policy.get('base-uri')).toBe("'none'");
    expect(policy.get('form-action')).toBe("'self'");
    expect(policy.get('frame-ancestors')).toBe("'none'");
    expect(policy.get('worker-src')).toBe("'self'");
    expect(policy.get('img-src')).toBe("'self' data: blob: https://auth.privy.io");
  });

  it('frames only Privy’s isolated wallet frame and, when the owner enables it, Privy’s bot check — never FloFi Wallet or anything else', () => {
    const policy = directives(accountPagePolicy(cspNonce()));
    expect(policy.get('frame-src')).toBe('https://auth.privy.io https://challenges.cloudflare.com https://hcaptcha.com https://*.hcaptcha.com');
    expect(policy.get('child-src')).toBe(policy.get('frame-src'));
  });
  it('uses a fresh 128-bit nonce per request and refuses a malformed one', () => {
    const nonces = new Set(Array.from({ length: 64 }, cspNonce));
    expect(nonces.size).toBe(64);
    for (const nonce of nonces) expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
    for (const bad of ['', 'abc', "x' 'unsafe-inline", `${cspNonce()}; script-src *`]) expect(() => accountPagePolicy(bad)).toThrow('CSP_NONCE_INVALID');
  });

  it('applies to sign-in and wallet onboarding only', () => {
    for (const path of ['/login', '/onboarding', '/onboarding/wallets']) expect(isAccountPage(path)).toBe(true);
    for (const path of ['/', '/app', '/app/credentials', '/approve', '/mcp/approve', '/loginx', '/onboardingx', '/docs']) expect(isAccountPage(path)).toBe(false);
    expect(ACCOUNT_PAGE_PATHS).toEqual(['/login', '/onboarding', '/onboarding/:path*']);
    // The proxy sees every request except Next.js's immutable build output, so the wallet host can refuse everything else (wallet-origin.test.ts).
    expect(config.matcher).toEqual(['/((?!_next/static|_next/image).*)']);
  });
});
