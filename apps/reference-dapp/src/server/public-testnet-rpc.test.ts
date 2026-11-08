// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLOWS } from '../../backend/flows.ts';
import { baseSepoliaSwapRpc, createBaseSepoliaReadRpc, pacedReadRpc, READ_ABANDONED } from './public-testnet-rpc.ts';
import type { Rpc } from './public-testnet-service.ts';

afterEach(() => { vi.restoreAllMocks(); });
/** A provider double: answers each POST from `replies` in order (a number is an HTTP status without a body). */
function provider(replies: (number | Record<string, unknown>)[]) {
  const hosts: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    hosts.push(new URL(String(input)).host);
    const reply = replies.shift() ?? 503;
    return typeof reply === 'number' ? new Response('busy', { status: reply }) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...reply }), { status: 200 });
  });
  return hosts;
}

describe('BUILD-CLOUD-PARITY-001 Base Sepolia read clients on shared serverless egress', () => {
  it('classifies pruned historical state and RPC rate limits separately from an execution revert', async () => {
    provider([{ error: { code: -32000, message: 'missing trie node fixture (path ) state 0x1 is not available, not found' } }]);
    await expect(createBaseSepoliaReadRpc('https://fixture.invalid', ['eth_call'])('eth_call', [])).rejects.toThrow('PUBLIC_RPC_HISTORY_UNAVAILABLE');
    provider([{ error: { code: -32011, message: 'request limit reached' } }]);
    await expect(createBaseSepoliaReadRpc('https://fixture.invalid', ['eth_getLogs'])('eth_getLogs', [])).rejects.toThrow('PUBLIC_RPC_UNAVAILABLE');
  });
  it('the live Uniswap liquidity client retries a dropped read and returns the answer', async () => {
    const hosts = provider([429, { result: '0x2dc6c0' }]);
    await expect(FLOWS['uniswap-liquidity'].transport('live', {}).rpc('eth_blockNumber', [])).resolves.toBe('0x2dc6c0');
    expect(hosts).toEqual(['sepolia.base.org', 'sepolia.base.org']);
  });
  it('the live swap client retries a dropped read, stays bound to chain 84532 and honours the shared override', async () => {
    provider([503, { result: '0x14a34' }]);
    await expect(FLOWS['base-sepolia-swap'].transport('live', {}).rpc('eth_chainId', [])).resolves.toBe('0x14a34');
    const hosts = provider([{ result: '0x1' }]);
    await expect(baseSepoliaSwapRpc('https://base-sepolia.keyed.example/v2/k')('eth_chainId', [])).rejects.toThrow('WRONG_PROVIDER_CHAIN');
    expect(hosts).toEqual(['base-sepolia.keyed.example']);
  });
  it('an answer the node gave is never retried, and bounded retries end in a classified failure', async () => {
    const hosts = provider([{ error: { code: -32000, message: 'execution reverted' } }]);
    await expect(FLOWS['uniswap-liquidity'].transport('live', {}).rpc('eth_call', [])).rejects.toThrow('PUBLIC_RPC_RESPONSE_INVALID');
    expect(hosts).toHaveLength(1);
    expect(() => baseSepoliaSwapRpc('http://plain.example')).toThrow('PUBLIC_RPC_CONFIGURATION_INVALID');
  });
});

describe('P0 catalog reliability: an abandoned caller never holds the shared paced queue', () => {
  const instant = async () => undefined;
  it.each([1, 3])('drops queued reads whose caller is gone (maxInFlight %i) and serves the next caller at once', async maxInFlight => {
    const sent: string[] = [];
    let release: () => void = () => undefined;
    const slow = new Promise<void>(resolve => { release = resolve; });
    const node: Rpc = async method => { sent.push(method); if (method === 'first') await slow; return method; };
    const rpc = pacedReadRpc(node, { minIntervalMs: 0, sleep: instant, maxInFlight });
    const gone = new AbortController(), other = new AbortController();
    const first = rpc('first', [], { signal: other.signal });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(sent).toEqual(['first']);
    const queued = Promise.allSettled([rpc('a', [], { signal: gone.signal }), rpc('b', [], { signal: gone.signal }), rpc('c', [], { signal: gone.signal })]);
    const live = rpc('live', []);
    gone.abort(); release();
    await expect(first).resolves.toBe('first');
    for (const read of await queued) expect(read).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: READ_ABANDONED }) });
    await expect(live).resolves.toBe('live');
    // Only reads a caller still waited for were sent (with maxInFlight > 1 some may already have started before the abort).
    expect(sent.filter(m => m === 'live')).toEqual(['live']);
    if (maxInFlight === 1) expect(sent).toEqual(['first', 'live']);
  });
  it('stops retrying a rate-limited read once its caller is gone, without waiting out the backoff', async () => {
    let calls = 0;
    const node: Rpc = async () => { calls++; throw new Error('PUBLIC_RPC_UNAVAILABLE'); };
    const gone = new AbortController();
    const rpc = pacedReadRpc(node, { minIntervalMs: 0 });
    const started = Date.now();
    const read = rpc('eth_call', [], { signal: gone.signal });
    setTimeout(() => gone.abort(), 50);
    await expect(read).rejects.toThrow(/PUBLIC_RPC_UNAVAILABLE|RPC_READ_ABANDONED/);
    // Six retries would back off for 31.5 s, and the first pause alone is 500 ms: the abandoned read ends right after its caller leaves.
    expect(Date.now() - started).toBeLessThan(400);
    expect(calls).toBeLessThanOrEqual(2);
  });
  it('the node client cancels a read in flight when its caller stops waiting', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const gone = new AbortController(), started = Date.now();
    // A client timeout far beyond the test's patience: only the caller's cancellation can end this read quickly.
    const read = createBaseSepoliaReadRpc('https://fixture.invalid', ['eth_call'], 60_000)('eth_call', [], { signal: gone.signal });
    setTimeout(() => gone.abort(), 20);
    await expect(read).rejects.toThrow(READ_ABANDONED);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
