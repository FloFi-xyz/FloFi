// SPDX-License-Identifier: AGPL-3.0-only
/** Provider transports are test doubles; these tests exercise the actual discovery adapters and tool contract, never public APIs. */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UNIVERSAL_QUOTE_SUBJECTS } from '@defi-workflow-engine/workflow-contracts';
import { channelCopilotToolkit } from './channel-copilot-toolkit.ts';
import { registerFixtureCatalogs, resetNetworkCatalogs } from '../domain/intelligence/intelligence.test-harness';
import type { UniversalHttp } from './universal-router/http.ts';

beforeAll(registerFixtureCatalogs);
afterAll(resetNetworkCatalogs);
const context = { card: null, language: 'EN' as const };
const args = { sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'USDC', amount: '10' };

describe('authenticated channel read-only provider boundary', () => {
  it('returns real-adapter provider outcomes, with public quote subjects and server-only optional credentials', async () => {
    const key = randomBytes(24).toString('hex'), calls: { url: string; body: unknown; headers: unknown }[] = [];
    const answer = async (url: string, body: unknown, headers?: unknown) => {
      calls.push({ url, body, headers });
      if (url.includes('across')) return { inputAmount: '10000000',
        inputToken: { chainId: 8453, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
        outputToken: { chainId: 42161, address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },
        expectedOutputAmount: '9995000', minOutputAmount: '9990000', expectedFillTime: 2 };
      if (url.includes('li.quest')) return { routes: [] };
      if (url.includes('mayan')) return { quotes: [] };
      return { __httpStatus: 400, __body: { message: 'No routes found' } };
    };
    const http: UniversalHttp = { get: (url, headers) => answer(url, null, headers), post: answer };
    const toolkit = channelCopilotToolkit({ RELAY_API_KEY: key, LIFI_API_KEY: key }, { http, prepareCatalogs: async () => undefined })!;
    const result = await toolkit.run('find_routes', JSON.stringify(args), context);
    expect(result).toMatchObject({ outcome: 'OK', output: { ok: true, quoteSubjects: 'PUBLIC_QUOTE_SUBJECT', status: 'LIVE_QUOTE',
      candidates: expect.arrayContaining([expect.objectContaining({ provider: 'across', status: 'LIVE_QUOTE', expectedOutput: '9.995', guaranteedOutput: '9.99', executable: false })]) } });
    expect(calls).toHaveLength(4);
    const relay = calls.find(c => c.url.includes('relay'))!;
    expect(relay.body).toMatchObject({ user: UNIVERSAL_QUOTE_SUBJECTS.EVM, recipient: UNIVERSAL_QUOTE_SUBJECTS.EVM });
    expect(relay.headers).toEqual({ 'x-api-key': key });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toMatch(/0x[0-9a-fA-F]{40}|transaction|calldata|signature/i);
    expect(calls.every(c => c.url.startsWith('https://'))).toBe(true);
    expect(await toolkit.run('execute', '{}', context)).toMatchObject({ outcome: 'TOOL_NOT_ALLOWED' });
  });

  it('rejects public testnets and owner-supplied tool fields before reaching a provider', async () => {
    let calls = 0;
    const http: UniversalHttp = { get: async () => { calls++; return {}; }, post: async () => { calls++; return {}; } };
    const toolkit = channelCopilotToolkit({ VERCEL: '1', FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS' }, { http, prepareCatalogs: async () => undefined })!;
    expect(await toolkit.run('find_routes', JSON.stringify({ ...args, sourceNetwork: 'base-sepolia' }), context)).toMatchObject({ outcome: 'TEST_NETWORK_NOT_AVAILABLE' });
    expect(await toolkit.run('find_routes', JSON.stringify({ ...args, owner: UNIVERSAL_QUOTE_SUBJECTS.EVM }), context)).toMatchObject({ outcome: 'TOOL_ARGUMENTS_INVALID' });
    expect(calls).toBe(0);
    expect(channelCopilotToolkit({ FLOFI_COPILOT_TOOLS: 'off' })).toBeNull();
  });
});
