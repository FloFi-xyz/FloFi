// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #149 (cross-channel parity): a channel's route discovery applies the web's `GRYLOO_UNIVERSAL_ROUTER` gate. Provider transports are
 * test doubles and catalogs are fixtures: nothing here reaches a public provider.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerFixtureCatalogs, resetNetworkCatalogs } from '../domain/intelligence/intelligence.test-harness';
import type { UniversalHttp } from '../server/universal-router/http.ts';
import { universalRouterMode } from '../server/universal-router/runtime.ts';

// The web path in local mode (no cloud runtime), and no catalog download on either path.
vi.mock('../server/flow-runtime.ts', () => ({ cloudFlow: async () => null }));
vi.mock('../server/authoring-catalogs.ts', () => ({ authoringCatalogPreparer: () => async () => undefined }));
const { channelRouteDiscoveryMode, channelRouteToolkit } = await import('./route-discovery');
const { copilotToolkit } = await import('../server/copilot-toolkit');

beforeAll(registerFixtureCatalogs);
afterAll(resetNetworkCatalogs);
const context = { card: null, language: 'EN' as const };
const args = JSON.stringify({ sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'USDC', amount: '10' });
const across = { inputAmount: '10000000', inputToken: { chainId: 8453, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  outputToken: { chainId: 42161, address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 }, expectedOutputAmount: '9995000', minOutputAmount: '9990000', expectedFillTime: 2 };
function providers() {
  const calls: string[] = [];
  const answer = async (url: string) => { calls.push(url); return url.includes('across') ? across : url.includes('li.quest') ? { routes: [] } : url.includes('mayan') ? { quotes: [] }
    : { __httpStatus: 400, __body: { message: 'No routes found' } }; };
  const http: UniversalHttp = { get: url => answer(url), post: url => answer(url) };
  return { calls, http };
}
const ENVS: Readonly<Record<string, string | undefined>>[] = [{}, { GRYLOO_UNIVERSAL_ROUTER: 'live' }, { GRYLOO_UNIVERSAL_ROUTER: 'off' }, { GRYLOO_UNIVERSAL_ROUTER: 'LIVE' },
  { GRYLOO_UNIVERSAL_ROUTER: ' live' }, { GRYLOO_UNIVERSAL_ROUTER_HARNESS: 'MOCKED_LOOPBACK_ONLY' }, { GRYLOO_UNIVERSAL_ROUTER: 'live', GRYLOO_UNIVERSAL_ROUTER_HARNESS: 'MOCKED_LOOPBACK_ONLY' },
  { GRYLOO_UNIVERSAL_ROUTER_HARNESS: 'mocked', GRYLOO_UNIVERSAL_ROUTER: 'live' }, { GRYLOO_UNIVERSAL_ROUTER_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' }];

describe('Issue #149: Channel Core route discovery gate', () => {
  it('reads the deployment gate exactly as the web does (universalRouterMode)', () => {
    for (const env of ENVS) expect(channelRouteDiscoveryMode(env), JSON.stringify(env)).toBe(universalRouterMode(env));
  });

  it('gate off: the channel refuses discovery exactly as the web chat does, and no provider is asked', async () => {
    for (const env of [{}, { GRYLOO_UNIVERSAL_ROUTER: 'off' }, { GRYLOO_UNIVERSAL_ROUTER_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' }]) for (const tool of ['find_routes', 'get_quote']) {
      const { calls, http } = providers();
      const channel = await channelRouteToolkit(env, { http, prepareCatalogs: async () => undefined })!.run(tool, args, context);
      const web = await copilotToolkit(env)!.run(tool, args, context);
      expect(channel, `${tool} ${JSON.stringify(env)}`).toMatchObject({ output: { ok: false, code: 'UNIVERSAL_ROUTER_NOT_ENABLED' } });
      expect(channel).toEqual(web);
      expect(calls).toEqual([]);
    }
  });

  it('gate on: the channel discovers routes through the authenticated read-only toolkit (public quote subjects)', async () => {
    const { calls, http } = providers();
    const result = await channelRouteToolkit({ GRYLOO_UNIVERSAL_ROUTER: 'live' }, { http, prepareCatalogs: async () => undefined })!.run('find_routes', args, context);
    expect(result).toMatchObject({ outcome: 'OK', output: { ok: true, quoteSubjects: 'PUBLIC_QUOTE_SUBJECT',
      candidates: expect.arrayContaining([expect.objectContaining({ provider: 'across', status: 'LIVE_QUOTE' })]) } });
    expect(calls.length).toBe(4);
    expect(calls.every(url => url.startsWith('https://'))).toBe(true);
  });

  it('harness: the MOCKED loopback harness serves the web only; a channel never reaches public providers from it', async () => {
    const { calls, http } = providers();
    const result = await channelRouteToolkit({ GRYLOO_UNIVERSAL_ROUTER: 'live', GRYLOO_UNIVERSAL_ROUTER_HARNESS: 'MOCKED_LOOPBACK_ONLY' },
      { http, prepareCatalogs: async () => undefined })!.run('find_routes', args, context);
    expect(result).toMatchObject({ output: { ok: false, code: 'ROUTE_DISCOVERY_UNAVAILABLE' } });
    expect(calls).toEqual([]);
  });

  it('keeps every other tool, and the operator break-glass, unchanged', async () => {
    expect(channelRouteToolkit({ FLOFI_COPILOT_TOOLS: 'off', GRYLOO_UNIVERSAL_ROUTER: 'live' })).toBeNull();
    expect(channelRouteToolkit({ FLOFI_COPILOT_TOOLS: 'off' })).toBeNull();
    const off = channelRouteToolkit({}, { prepareCatalogs: async () => undefined })!, on = channelRouteToolkit({ GRYLOO_UNIVERSAL_ROUTER: 'live' }, { prepareCatalogs: async () => undefined })!;
    expect(off.definitions).toEqual(on.definitions);
    const resolve = JSON.stringify({ network: 'base', reference: 'USDC' });
    expect(await off.run('resolve_asset', resolve, context)).toEqual(await on.run('resolve_asset', resolve, context));
    expect(await off.run('execute', '{}', context)).toMatchObject({ outcome: 'TOOL_NOT_ALLOWED' });
  });

  it('both authenticated channel entry points (webhook turns and dispatched turns) build their toolkit through the gate', () => {
    for (const file of ['http.ts', 'dispatch-http.ts']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source, file).toContain('toolkit: channelRouteToolkit(env)');
      expect(source, file).not.toMatch(/channelCopilotToolkit\(/);
    }
  });
});
