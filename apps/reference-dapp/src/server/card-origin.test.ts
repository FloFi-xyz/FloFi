// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-PRIVY-UX-001: Mercado Pago's SDK runs only on the card origin. The card host serves nothing but the card page and its static
// assets, the product host never serves that page, the page's policy lets only the product frame it, and the two sides exchange only
// strictly shaped messages (the provider's one-time token and the email, then the result).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { cspNonce } from '../accounts/account-csp';
import { cardOrigin, cardPagePolicy, FLOFI_PRODUCTION_CARD_ORIGIN, isCardAsset, isCardPath, reservedCardHosts } from './card-origin';
import { parseCardFrameMessage, parseCardParentMessage } from '../components/card-frame-protocol';
import { proxy } from '../proxy';

const hosted = { FLOFI_PUBLIC_ORIGIN: 'https://app.flofi.example', FLOFI_CARD_ORIGIN: 'https://cards.flofi.example' };
const directives = (policy: string) => new Map(policy.split('; ').map(entry => { const [name, ...values] = entry.split(' '); return [name, values.join(' ')]; }));

describe('card origin configuration', () => {
  it('needs an https origin other than the product’s; plain http only for the loopback card suite off hosted deployments', () => {
    expect(cardOrigin(hosted)).toEqual({ origin: 'https://cards.flofi.example', host: 'cards.flofi.example', appOrigin: 'https://app.flofi.example', appHost: 'app.flofi.example' });
    for (const bad of [{ FLOFI_CARD_ORIGIN: '' }, { FLOFI_CARD_ORIGIN: 'https://app.flofi.example' }, { FLOFI_CARD_ORIGIN: 'https://cards.flofi.example/path' },
      { FLOFI_CARD_ORIGIN: 'https://user:pw@cards.flofi.example' }, { FLOFI_CARD_ORIGIN: 'http://cards.flofi.example' }, { FLOFI_CARD_ORIGIN: 'not a url' }])
      expect(cardOrigin({ ...hosted, ...bad }), JSON.stringify(bad)).toBeNull();
    expect(cardOrigin({ FLOFI_CARD_ORIGIN: hosted.FLOFI_CARD_ORIGIN })).toBeNull(); // no product origin
    const loopback = { FLOFI_PUBLIC_ORIGIN: 'http://127.0.0.1:3119', FLOFI_CARD_ORIGIN: 'http://localhost:3119' };
    expect(cardOrigin(loopback)).toBeNull();
    expect(cardOrigin({ ...loopback, GRYLOO_CARD_E2E: 'MOCKED_LOOPBACK_ONLY' })).toMatchObject({ origin: 'http://localhost:3119', appOrigin: 'http://127.0.0.1:3119' });
    expect(cardOrigin({ ...loopback, GRYLOO_CARD_E2E: 'MOCKED_LOOPBACK_ONLY', VERCEL: '1' })).toBeNull();
    // Production has exactly one card origin.
    const production = { FLOFI_PUBLIC_ORIGIN: 'https://flofi.xyz', VERCEL: '1', VERCEL_ENV: 'production' };
    expect(cardOrigin({ ...production, FLOFI_CARD_ORIGIN: FLOFI_PRODUCTION_CARD_ORIGIN })).toMatchObject({ origin: 'https://cards.flofi.xyz' });
    expect(cardOrigin({ ...production, FLOFI_CARD_ORIGIN: 'https://cards.example.com' })).toBeNull();
    expect([...reservedCardHosts({})]).toEqual(['cards.flofi.xyz']);
    expect(isCardPath('/card-entry')).toBe(true);
    for (const path of ['/card-entry/', '/card-entryx', '/app', '/']) expect(isCardPath(path)).toBe(false);
    for (const path of ['/_next/static/chunks/a.js', '/fonts/x.woff2', '/favicon.ico']) expect(isCardAsset(path)).toBe(true);
    expect(isCardAsset('/brand/logo.svg')).toBe(false);
  });
  it('lets only the product frame the card page, which runs its own scripts and what they load and talks only to Mercado Pago', () => {
    const nonce = cspNonce(), policy = directives(cardPagePolicy(nonce, cardOrigin(hosted)!));
    expect(policy.get('script-src')).toBe(`'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(policy.get('script-src-attr')).toBe("'none'");
    expect(policy.get('connect-src')).toBe("'self' https://api.mercadopago.com https://api-static.mercadopago.com https://secure-fields.mercadopago.com");
    expect(policy.get('frame-ancestors')).toBe('https://app.flofi.example');
    expect(policy.get('form-action')).toBe("'none'");
    expect(() => cardPagePolicy('bad', cardOrigin(hosted)!)).toThrow('CSP_NONCE_INVALID');
  });
});

describe('proxy routing of the card host', () => {
  async function route(url: string, init: { method?: string; headers?: Record<string, string> } = {}, overrides: Record<string, string> = {}) {
    const previous = { ...process.env }, applied = { ...hosted, ...overrides };
    Object.assign(process.env, applied);
    try {
      const target = new URL(url);
      return proxy(new NextRequest(url, { method: init.method ?? 'GET', headers: { host: target.host, ...init.headers } }));
    } finally { for (const key of Object.keys(applied)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); }
  }
  it('serves only the card page and its static assets on the card host, and never that page on the product host', async () => {
    const page = await route('https://cards.flofi.example/card-entry');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/^script-src 'self' 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic'; .*frame-ancestors https:\/\/app\.flofi\.example$/);
    expect(page.headers.get('cache-control')).toBe('no-store');
    for (const path of ['/', '/app', '/login', '/approve', '/onboarding/wallets', '/api/mcp', '/wallet', '/brand/logo.svg'])
      expect((await route(`https://cards.flofi.example${path}`)).status, path).toBe(404);
    expect((await route('https://cards.flofi.example/card-entry', { method: 'POST', headers: { 'next-action': 'abc' } })).status).toBe(404);
    expect((await route('https://cards.flofi.example/_next/static/chunks/a.js')).status).toBe(200);
    expect((await route('https://app.flofi.example/card-entry')).status).toBe(404);
  });
  it('fails closed: without a valid card origin the card host serves nothing, and the production card host is always reserved', async () => {
    for (const broken of [{ FLOFI_CARD_ORIGIN: 'http://cards.flofi.example' }, { FLOFI_CARD_ORIGIN: 'https://cards.flofi.example/x' }])
      for (const path of ['/card-entry', '/app', '/']) expect((await route(`https://cards.flofi.example${path}`, {}, broken)).status, path).toBe(404);
    expect((await route('https://cards.flofi.xyz/app', {}, { FLOFI_CARD_ORIGIN: '' })).status).toBe(404);
    expect((await route('https://cards.flofi.xyz/card-entry', {}, { FLOFI_CARD_ORIGIN: '' })).status).toBe(404);
  });
});

describe('card frame messages', () => {
  it('accept only the exact shapes: a one-time token and an email from the frame, a result from the product', () => {
    expect(parseCardFrameMessage({ type: 'flofi-card-token', token: 'harness_abc123', email: 'a@b.co' })).toEqual({ type: 'flofi-card-token', token: 'harness_abc123', email: 'a@b.co' });
    for (const type of ['flofi-card-ready', 'flofi-card-unavailable', 'flofi-card-cancel']) expect(parseCardFrameMessage({ type })).toEqual({ type });
    for (const bad of [null, 'x', {}, { type: 'flofi-card-token', token: 'harness_abc123' }, { type: 'flofi-card-token', token: 'harness_abc123', email: 'a@b.co', pan: '4235647728025682' },
      { type: 'flofi-card-token', token: '4235 6477 2802 5682', email: 'a@b.co' }, { type: 'flofi-card-token', token: 'harness_abc123', email: 'no-at' },
      { type: 'flofi-card-ready', extra: 1 }, { type: 'other' }]) expect(parseCardFrameMessage(bad), JSON.stringify(bad)).toBeNull();
    expect(parseCardParentMessage({ type: 'flofi-card-result', ok: true })).toEqual({ type: 'flofi-card-result', ok: true });
    expect(parseCardParentMessage({ type: 'flofi-card-result', ok: false, error: 'Nothing was saved.' })).toEqual({ type: 'flofi-card-result', ok: false, error: 'Nothing was saved.' });
    for (const bad of [{ type: 'flofi-card-result' }, { type: 'flofi-card-result', ok: 'yes' }, { type: 'flofi-card-result', ok: false, error: 'x'.repeat(201) },
      { type: 'flofi-card-result', ok: true, html: '<b>' }]) expect(parseCardParentMessage(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('the card SDK loader', () => {
  it('is imported only by the card origin’s page component, never by anything the product origin renders', () => {
    const root = join(__dirname, '..'), files: string[] = [];
    const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path); else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
    } };
    walk(root);
    const importers = files.filter(file => /from '[./]*\/?(components\/)?card-secure-fields'/.test(readFileSync(file, 'utf8'))).map(file => relative(root, file));
    expect(importers).toEqual(['components/card-entry-frame.tsx']);
    const frameUsers = files.filter(file => /card-entry-frame'/.test(readFileSync(file, 'utf8'))).map(file => relative(root, file));
    expect(frameUsers).toEqual(['app/(card)/card-entry/page.tsx']);
  });
});
