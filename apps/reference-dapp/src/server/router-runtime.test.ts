// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { pacedReadRpc, routerMode, routerRpcUrl, routerRuntime, ROUTER_ARBITRUM_RPC_METHODS, ROUTER_BASE_RPC_METHODS } from './router-runtime';
import { readPacingFor } from './public-testnet-rpc';

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
    let active = 0, peak = 0;
    const starts: number[] = [];
    let failures = 1;
    const rpc = pacedReadRpc(async method => {
      starts.push(Date.now()); active++; peak = Math.max(peak, active);
      try {
        await new Promise(r => setTimeout(r, 30));
        if (method === 'flaky' && failures-- > 0) throw new Error('PUBLIC_RPC_UNAVAILABLE');
        if (method === 'refused') throw new Error('RPC_ERROR');
        return method;
      } finally { active--; }
    }, { minIntervalMs: 5, maxInFlight: 3 });
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e', 'flaky'].map(m => rpc(m, [])));
    expect(results).toEqual(['a', 'b', 'c', 'd', 'e', 'flaky']);
    expect(peak).toBe(3);
    expect(starts.slice(1).every((t, i) => t - starts[i]! >= 4)).toBe(true);
    // A node answer (not a transport failure) is never retried.
    const before = starts.length;
    await expect(rpc('refused', [])).rejects.toThrow('RPC_ERROR');
    expect(starts.length - before).toBe(1);
  });
});
