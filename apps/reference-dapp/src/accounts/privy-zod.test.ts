// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: pnpm-workspace.yaml gives Privy's `@privy-io/api-base@1.12.0` zod 4.6.6 instead of its declared ^3.25.76
 * (GHSA-mrhx-c7xc-m3w5, high; no fixed 3.x exists). api-base builds one schema (`APIError`, with z.object / z.string().optional() /
 * z.nativeEnum); this loads the installed package exactly as Privy's SDK does and checks that schema still parses and refuses under zod 4.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolved from Privy's React SDK, which depends on it (the app itself does not).
const fromPrivy = createRequire(createRequire(import.meta.url).resolve('@privy-io/react-auth'));
const apiBase = fromPrivy.resolve('@privy-io/api-base');
const zodOfApiBase = createRequire(apiBase).resolve('zod');

describe('@privy-io/api-base with the zod override', () => {
  it('resolves zod 4.6.6, and its APIError schema accepts Privy error bodies and refuses malformed ones', async () => {
    let root = dirname(zodOfApiBase);
    while (!JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name?.startsWith('zod')) root = dirname(root);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('4.6.6');
    const { APIError, PrivyErrorCode } = await import(pathToFileURL(apiBase.replace(/cjs[/\\]index\.js$/, 'esm/index.mjs')).href) as {
      APIError: { safeParse(value: unknown): { success: boolean } }; PrivyErrorCode: Record<string, string> };
    const code = Object.values(PrivyErrorCode)[0];
    expect(APIError.safeParse({ error: 'Not found' }).success).toBe(true);
    expect(APIError.safeParse({ error: 'Invalid', cause: 'field', code }).success).toBe(true);
    for (const bad of [{}, { error: 1 }, { error: 'x', cause: 2 }, { error: 'x', code: 'not-a-privy-code' }, null]) expect(APIError.safeParse(bad).success).toBe(false);
  });
});
