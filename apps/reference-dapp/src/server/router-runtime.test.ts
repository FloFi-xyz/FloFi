// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { pacedReadRpc, routerMode, routerRpcUrl, routerRuntime, ROUTER_ARBITRUM_RPC_METHODS, ROUTER_BASE_RPC_METHODS } from './router-runtime';
import { chainBoundRpc, createBaseSepoliaReadRpc, readNotAnswered, readPacingFor } from './public-testnet-rpc';

describe('BUILD-ROUTER-001 router runtime', () => {
  it('is off unless explicitly enabled; the MOCKED harness always wins; owner execution is a separate opt-in', () => {
    expect(routerMode({})).toBe('off');
    expect(routerMode({ GRYLOO_ROUTER: 'live' })).toBe('live');
    expect(routerMode({ GRYLOO_ROUTER: 'live', GRYLOO_ROUTER_HARNESS: 'MOCKED_LOOPBACK_ONLY' })).toBe('harness');
    expect(routerRuntime('live', { GRYLOO_ROUTER: 'live' }).executionEnabled).toBe(false);
    expect(routerRuntime('live', { GRYLOO_ROUTER: 'live', GRYLOO_ROUTER_OWNER_EXECUTION: 'yes' }).executionEnabled).toBe(false);
    expect(routerRuntime('live', { GRYLOO_ROUTER: 'live', GRYLOO_ROUTER_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' })).toMatchObject({ executionEnabled: true, provenance: 'PUBLIC_MAINNET' });
    expect(routerRuntime('harness', {})).toMatchObject({ provenance: 'MOCKED' });
  });
  it('allowlists only read methods and accepts only HTTPS overrides without credentials', () => {
    for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign'])
      expect([...ROUTER_BASE_RPC_METHODS, ...ROUTER_ARBITRUM_RPC_METHODS]).not.toContain(method);
    expect(routerRpcUrl(undefined, 'https://mainnet.base.org')).toBe('https://mainnet.base.org');
    expect(routerRpcUrl('https://rpc.example.org/v1', 'x')).toBe('https://rpc.example.org/v1');
    for (const bad of ['http://rpc.example.org', 'https://user:pass@rpc.example.org', 'not a url']) expect(() => routerRpcUrl(bad, 'x')).toThrow('ROUTER_RPC_CONFIGURATION_INVALID');
  });
  it('paces reads through one queue and retries only transport failures', async () => {
    const calls: string[] = [], sleeps: number[] = [];
    let failures = 2;
    const rpc = pacedReadRpc(async method => { calls.push(method); if (method === 'flaky' && failures-- > 0) throw new Error('PUBLIC_RPC_UNAVAILABLE');
      if (method === 'reverted') throw new Error('PUBLIC_RPC_RESPONSE_INVALID'); return method; }, { sleep: async ms => { sleeps.push(ms); } });
    expect(await Promise.all([rpc('a', []), rpc('flaky', []), rpc('b', [])])).toEqual(['a', 'flaky', 'b']);
    expect(calls).toEqual(['a', 'flaky', 'flaky', 'flaky', 'b']);
    expect(sleeps.filter(ms => ms >= 500 && ms % 500 === 0)).toEqual([500, 1000]);
    await expect(rpc('reverted', [])).rejects.toThrow('PUBLIC_RPC_RESPONSE_INVALID');
    expect(calls.filter(c => c === 'reverted')).toHaveLength(1);
  });
});

describe('BUILD-FLOFI-EXECUTION-PERFORMANCE-001 dedicated read pacing', () => {
  it('is opt-in, only for operator endpoints; public endpoints keep one read at a time', async () => {
    expect(readPacingFor({}, true)).toEqual({});
    expect(readPacingFor({ GRYLOO_RPC_READ_PROFILE: 'dedicated' }, false)).toEqual({});
    expect(readPacingFor({ GRYLOO_RPC_READ_PROFILE: 'fast' }, true)).toEqual({});
    expect(readPacingFor({ GRYLOO_RPC_READ_PROFILE: 'dedicated' }, true)).toEqual({ minIntervalMs: 25, maxInFlight: 6 });
    expect(() => pacedReadRpc(async () => null, { maxInFlight: 9 })).toThrow('RPC_PACING_INVALID');
    let active = 0, peak = 0;
    const slow = async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 15)); active--; return '0x1'; };
    const serial = pacedReadRpc(slow, { minIntervalMs: 0 });
    await Promise.all([1, 2, 3, 4].map(() => serial('eth_call', [])));
    expect(peak).toBe(1);
  });
  it('dedicated: bounded concurrency, spaced starts, and a transport failure pauses every later start', async () => {
    // Fake timers move Date.now and setTimeout together, so the spacing the pacer enforces is measured exactly (no event-loop jitter).
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      let active = 0, peak = 0, failures = 1;
      const starts: { method: string; at: number }[] = [];
      const rpc = pacedReadRpc(async method => {
        starts.push({ method, at: Date.now() }); active++; peak = Math.max(peak, active);
        try {
          await new Promise(r => setTimeout(r, 30));
          if (method === 'flaky' && failures-- > 0) throw new Error('PUBLIC_RPC_UNAVAILABLE');
          if (method === 'refused') throw new Error('RPC_ERROR');
          return method;
        } finally { active--; }
      }, { minIntervalMs: 5, maxInFlight: 3 });
      const pending = Promise.all(['a', 'b', 'c', 'd', 'e', 'flaky'].map(m => rpc(m, [])));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual(['a', 'b', 'c', 'd', 'e', 'flaky']);
      expect(peak).toBe(3);
      const times = starts.map(s => s.at);
      expect(times.slice(1).every((t, i) => t - times[i]! >= 5)).toBe(true);
      // The retry of the failed transport call waited out the shared pause (500 ms after the failure), and nothing else started inside it.
      const failedAt = starts.find(s => s.method === 'flaky')!.at + 30, retry = starts.filter(s => s.method === 'flaky')[1]!.at;
      expect(retry - failedAt).toBeGreaterThanOrEqual(500);
      expect(starts.filter(s => s.at > failedAt && s.at < failedAt + 500)).toEqual([]);
      // A node answer (not a transport failure) is never retried.
      const before = starts.length, refused = rpc('refused', []);
      const outcome = refused.then(() => 'resolved', (error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await outcome).toBe('RPC_ERROR');
      expect(starts.length - before).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('BUILD-FLOFI-EXECUTION-PERFORMANCE-001 read failure classification', () => {
  const json = (error: { code: number; message: string }) => () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error }));
  it('classifies by evidence: an explicit revert is an answer; a lagging node, a rate limit or an outage is no answer', async () => {
    const cases: [() => Response, string, boolean][] = [
      [json({ code: 3, message: 'execution reverted' }), 'PUBLIC_RPC_RESPONSE_INVALID', false],
      [json({ code: -32603, message: 'execution reverted: SPL' }), 'PUBLIC_RPC_RESPONSE_INVALID', false],
      [json({ code: -32000, message: 'out of gas' }), 'PUBLIC_RPC_RESPONSE_INVALID', false],
      [json({ code: -32603, message: 'internal error' }), 'PUBLIC_RPC_UNAVAILABLE', true],
      [json({ code: -32016, message: 'over rate limit' }), 'PUBLIC_RPC_UNAVAILABLE', true],
      [json({ code: -32000, message: 'Too Many Requests' }), 'PUBLIC_RPC_UNAVAILABLE', true],
      [json({ code: -32000, message: 'header not found' }), 'PUBLIC_RPC_HISTORY_UNAVAILABLE', true],
      [json({ code: -32000, message: 'missing trie node abc' }), 'PUBLIC_RPC_HISTORY_UNAVAILABLE', true],
      [() => new Response('busy', { status: 503 }), 'PUBLIC_RPC_UNAVAILABLE', true],
    ];
    const answers = cases.map(([answer]) => answer);
    vi.stubGlobal('fetch', async () => answers.shift()!());
    try {
      const rpc = createBaseSepoliaReadRpc('https://rpc.example.org', ['eth_call']);
      for (const [, message, notAnswered] of cases) {
        const error = await rpc('eth_call', []).then(() => null, (cause: Error) => cause);
        expect([error?.message, readNotAnswered(error)]).toEqual([message, notAnswered]);
        expect(JSON.stringify(error)).not.toMatch(/execution reverted|trie node|over rate limit|Too Many Requests|header not found|out of gas|internal error/i);
      }
    } finally { vi.unstubAllGlobals(); }
  });
  it('the classification survives the paced and chain-bound transports, and an explicit revert is never retried as an outage', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls++; return json({ code: -32603, message: 'execution reverted' })(); });
    try {
      const rpc = chainBoundRpc(pacedReadRpc(createBaseSepoliaReadRpc('https://rpc.example.org', ['eth_call']), { sleep: async () => undefined }), 8453);
      const error = await rpc('eth_call', []).then(() => null, (cause: Error) => cause);
      expect(error).toMatchObject({ message: 'PUBLIC_RPC_RESPONSE_INVALID', rpcErrorCode: -32603, rpcReverted: true });
      expect(calls).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });
});
