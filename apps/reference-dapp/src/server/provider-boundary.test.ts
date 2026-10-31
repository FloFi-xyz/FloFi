// SPDX-License-Identifier: AGPL-3.0-only
// The card and payment provider secrets stay on the server: no browser module can import a provider adapter or read its keys.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(join(dir, entry.name)) : /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
const source = files(SRC).map(path => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }));
const browser = source.filter(file => /^\s*(?:\/\/[^\n]*\n\s*)*['"]use client['"]/.test(file.text) || /^(?:components|state|wallet)\//.test(file.path));
const PROVIDER_MODULES = ['card-binding', 'card-provider', 'mercado-pago-card-provider', 'woovi-pix-adapter', 'payment-adapter', 'payment-execution', 'payment-service',
  'payment-flow-service', 'payment-runtime', 'payment-webhook'];

describe('provider credentials never reach the browser', () => {
  it('lets browser modules import provider modules for types only', () => {
    expect(browser.length).toBeGreaterThan(40);
    const offending = browser.flatMap(file => [...file.text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)]
      .filter(match => PROVIDER_MODULES.some(name => match[1]!.endsWith(`/server/${name}`) || match[1]!.endsWith(`/server/${name}.ts`)))
      .map(match => `${file.path}: ${match[0]}`));
    expect(offending).toEqual([]);
  });
  it('names the server-only provider secrets only in server modules', () => {
    const named = source.filter(file => /MERCADO_PAGO_ACCESS_TOKEN|WOOVI_APP_ID/.test(file.text)).map(file => file.path).sort();
    // The Woovi fake names the variable for isolated server tests; it is never a browser module (checked below).
    expect(named).toEqual(['server/card-provider.ts', 'server/mercado-pago-card-provider.ts', 'server/woovi-pix-adapter.ts', 'test-utils/woovi-fake.ts']);
    // BUILD-FLOFI-PRIVY-UX-001: Privy's app id is public (NEXT_PUBLIC_PRIVY_APP_ID, handed to its React provider); its server secret never is.
    expect(browser.filter(file => /accessToken|appId|api\.woovi|api\.mercadopago\.com\/v1/.test(file.text) && file.path !== 'accounts/privy-client.tsx').map(file => file.path)).toEqual([]);
    expect(source.filter(file => /PRIVY_APP_SECRET/.test(file.text)).map(file => file.path)).toEqual(['accounts/privy-server.ts']);
    expect(browser.filter(file => /appSecret|PRIVY_APP_SECRET|PRIVY_VERIFICATION_KEY/.test(file.text)).map(file => file.path)).toEqual([]);
  });
});
