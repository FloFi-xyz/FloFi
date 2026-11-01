// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-AUTH-WALLETS-001 / BUILD-FLOFI-PRIVY-UX-001: the sign-in and wallet onboarding policy is strict, scoped to those pages and fails
// closed; beyond FloFi it allows only Privy's own origins (src/accounts/privy-hosts.ts).
import { describe, expect, it } from 'vitest';
import { ACCOUNT_PAGE_PATHS, accountPagePolicy, cspNonce, isAccountPage, isProductPage, productPagePolicy } from './account-csp';
import { config } from '../proxy';
import { proxy } from '../proxy';
import { NextRequest } from 'next/server';

const directives = (policy: string) => new Map(policy.split('; ').map(entry => { const [name, ...values] = entry.split(' '); return [name, values.join(' ')]; }));

describe('account page Content Security Policy', () => {
  it('runs only nonce-bearing scripts and what they load, talks only to FloFi and Privy and is never framed', () => {
    const nonce = cspNonce(), policy = directives(accountPagePolicy(nonce));
    // 'unsafe-eval' is for the shared Ajv validators' code generation (account-csp.ts); no inline script, other host, scheme or
    // 'strict-dynamic' is allowed: a script inserted at runtime must still come from FloFi itself.
    expect(policy.get('script-src')).toBe(`'self' 'nonce-${nonce}' 'unsafe-eval'`);
    expect(policy.get('script-src-attr')).toBe("'none'");
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

describe('product page Content Security Policy (BUILD-FLOFI-PRIVY-UX-001: every product page hosts the Privy signer)', () => {
  it('protects the whole product origin, including public, admin and unknown/error paths', () => {
    for (const path of ['/', '/docs', '/privacy', '/admin', '/admin/login', '/admin/access', '/unknown-page', '/favicon.ico']) {
      const response = proxy(new NextRequest(`https://flofi.xyz${path}`, { headers: { host: 'flofi.xyz', 'x-flofi-pathname': '/mcp/approve' } }));
      const policy = directives(response.headers.get('content-security-policy')!);
      expect(policy.get('script-src'), path).toMatch(/^'self' 'nonce-[A-Za-z0-9+/]{22}==' 'unsafe-eval'$/);
      expect(policy.get('script-src-attr'), path).toBe("'none'");
      expect(policy.get('base-uri'), path).toBe("'none'");
      expect(policy.get('frame-ancestors'), path).toBe("'none'");
      expect(response.headers.get('x-middleware-request-content-security-policy'), path).toBe(response.headers.get('content-security-policy'));
      expect(response.headers.get('x-middleware-request-x-flofi-pathname'), path).toBe(path);
    }
  });
  it('runs only FloFi’s own scripts, talks only to FloFi and Privy, and keeps each page’s framing rule', () => {
    const nonce = cspNonce(), workspace = directives(productPagePolicy(nonce, { frameAncestors: null }, {}));
    expect(workspace.get('script-src')).toBe(`'self' 'nonce-${nonce}' 'unsafe-eval'`);
    expect(workspace.get('script-src-attr')).toBe("'none'");
    expect(workspace.get('object-src')).toBe("'none'");
    expect(workspace.get('base-uri')).toBe("'none'");
    expect(workspace.get('connect-src')).toBe("'self' https://auth.privy.io https://*.rpc.privy.systems wss://*.rpc.privy.systems https://rpc.mainnet.chain.robinhood.com wss://www.walletlink.org");
    expect(workspace.has('frame-ancestors')).toBe(false);
    // No payment SDK, analytics or other third party: Mercado Pago runs only on the card origin (src/server/card-origin.ts).
    expect(productPagePolicy(nonce, { frameAncestors: null }, {})).not.toMatch(/mercadopago|strict-dynamic|unsafe-inline/);
    expect(directives(productPagePolicy(nonce, { frameAncestors: "'none'" }, {})).get('frame-ancestors')).toBe("'none'");
    expect(() => productPagePolicy("x' 'unsafe-inline", { frameAncestors: null }, {})).toThrow('CSP_NONCE_INVALID');
  });
  it('allows Privy’s bot-protection loader only on /login and only when the deployment declares it', () => {
    const nonce = cspNonce();
    expect(directives(accountPagePolicy(nonce, { FLOFI_PRIVY_BOT_PROTECTION: 'turnstile' }, { signIn: true })).get('script-src'))
      .toBe(`'self' 'nonce-${nonce}' 'unsafe-eval' https://challenges.cloudflare.com`);
    // Never on the private-key import screen (or any other onboarding page) or the product.
    expect(directives(accountPagePolicy(nonce, { FLOFI_PRIVY_BOT_PROTECTION: 'turnstile' })).get('script-src')).toBe(`'self' 'nonce-${nonce}' 'unsafe-eval'`);
    expect(directives(productPagePolicy(nonce, { frameAncestors: null }, { FLOFI_PRIVY_BOT_PROTECTION: 'turnstile' })).get('script-src')).toBe(`'self' 'nonce-${nonce}' 'unsafe-eval'`);
    const hcaptcha = directives(accountPagePolicy(nonce, { FLOFI_PRIVY_BOT_PROTECTION: 'hcaptcha' }, { signIn: true }));
    expect(hcaptcha.get('script-src')).toBe(`'self' 'nonce-${nonce}' 'unsafe-eval' https://hcaptcha.com https://*.hcaptcha.com`);
    expect(hcaptcha.get('connect-src')).toMatch(/https:\/\/hcaptcha\.com https:\/\/\*\.hcaptcha\.com$/);
    for (const value of ['yes', 'recaptcha', '']) expect(directives(accountPagePolicy(nonce, { FLOFI_PRIVY_BOT_PROTECTION: value }, { signIn: true })).get('script-src')).toBe(`'self' 'nonce-${nonce}' 'unsafe-eval'`);
  });
  it('covers every page of the product layout and nothing else', () => {
    for (const path of ['/app', '/app/credentials', '/app/dashboard/runs/x', '/approve', '/connections', '/mcp/approve', '/__engineering']) expect(isProductPage(path), path).toBe(true);
    for (const path of ['/', '/login', '/onboarding/wallets', '/docs', '/privacy', '/admin', '/apps', '/approved', '/card-entry']) expect(isProductPage(path), path).toBe(false);
  });
});
