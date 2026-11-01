// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-EXECUTION-PERFORMANCE-001: the conversational discovery window across the cloud boundary, including an API from before it. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ calls: [] as unknown[][], answer: [] as unknown[] }));
vi.mock('./flow-runtime.ts', () => ({ cloudFlow: async (_flow: string, _method: string, args: unknown[]) => { f.calls.push(args); return f.answer.shift() ?? null; } }));
const { readBridgeDiscovery } = await import('./bridge-discovery');

const request = { source: 'base', destination: 'arbitrum-one', inputToken: { kind: 'NATIVE' }, outputToken: { kind: 'NATIVE' }, amount: '1000000000000000', slippageBps: 50 };
const ok = { ok: true, value: { format: 'flofi.universal-discovery.v1' } };
beforeEach(() => { f.calls = []; f.answer = []; });

describe('BUILD-FLOFI-EXECUTION-PERFORMANCE-001 discovery window across the cloud boundary', () => {
  it('chat sends the window name; an older API that refuses the extra argument is asked once more with the request alone', async () => {
    f.answer = [{ ok: false, code: 'ARGUMENTS_INVALID' }, ok];
    expect(await readBridgeDiscovery(request, {}, undefined, 'CONVERSATIONAL')).toEqual(ok);
    expect(f.calls).toEqual([[request, 'CONVERSATIONAL'], [request]]);
  });
  it('the standard window sends the request alone and is never retried; other refusals are not retried either', async () => {
    f.answer = [{ ok: false, code: 'ARGUMENTS_INVALID' }];
    expect(await readBridgeDiscovery(request, {})).toEqual({ ok: false, code: 'ARGUMENTS_INVALID' });
    expect(f.calls).toEqual([[request]]);
    f.calls = []; f.answer = [{ ok: false, code: 'UNIVERSAL_SERVICE_UNAVAILABLE' }];
    expect(await readBridgeDiscovery(request, {}, undefined, 'CONVERSATIONAL')).toEqual({ ok: false, code: 'UNIVERSAL_SERVICE_UNAVAILABLE' });
    expect(f.calls).toEqual([[request, 'CONVERSATIONAL']]);
  });
});
