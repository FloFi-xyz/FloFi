// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-BRIDGE-RECONCILIATION-003 (Workstream B): direct coverage of the read-only Live Quote transport. Independent reads of
 * one indicative quote share a JSON-RPC batch envelope; an envelope the provider does not answer exactly is never partially trusted, a
 * per-item outage is retried alone, an answer (revert) is never retried, the method allowlist and chain binding still hold inside a batch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogQuoteReadRpc, measureQuoteRpc } from './public-testnet-rpc.ts';

afterEach(() => { vi.restoreAllMocks(); });
type Item = { jsonrpc: '2.0'; id: number; method: string; params: unknown[] };
type Answer = { result: unknown } | { error: { code: number; message: string } };
/**
 * A provider double that records every HTTP envelope. `answer` replies to one item; `envelope` may rewrite a whole batch reply (an HTTP
 * status number replaces it, an array is sent as is) to model incompatible providers.
 */
function provider(answer: (item: Item) => Answer, envelope?: (items: Item[], replies: unknown[]) => unknown[] | number) {
  const sent: (Item | Item[])[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Item | Item[];
    sent.push(body);
    if (!Array.isArray(body)) return Response.json({ jsonrpc: '2.0', id: body.id, ...answer(body) });
    const replies = body.map(item => ({ jsonrpc: '2.0', id: item.id, ...answer(item) }));
    const shaped = envelope ? envelope(body, replies) : replies;
    return typeof shaped === 'number' ? new Response('refused', { status: shaped }) : Response.json(shaped);
  });
  return sent;
}
const echo = (item: Item): Answer => ({ result: `${item.method}:${String(item.params[0] ?? '')}` });
const calls = (rpc: ReturnType<typeof createCatalogQuoteReadRpc>, n: number, method = 'eth_call') =>
  Array.from({ length: n }, (_, i) => rpc(method, [`r${i}`]));
const FAST = { minIntervalMs: 0 } as const;

describe('createCatalogQuoteReadRpc batching', () => {
  it('coalesces independent reads into one envelope and maps answers by id even when the provider reorders them', async () => {
    const sent = provider(echo, (_items, replies) => [...replies].reverse());
    const rpc = createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST);
    const logged: unknown[] = [];
    const answers = await measureQuoteRpc(() => Promise.all(calls(rpc, 4)), metrics => logged.push(metrics));
    expect(answers).toEqual(['eth_call:r0', 'eth_call:r1', 'eth_call:r2', 'eth_call:r3']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([0, 1, 2, 3].map(i => ({ jsonrpc: '2.0', id: i + 1, method: 'eth_call', params: [`r${i}`] })));
    expect(logged).toEqual([expect.objectContaining({ logical_calls: 4, wire_calls: 4, requests: 1, batch_requests: 1, fallbacks: 0 })]);
  });

  it('sends a lone read as a plain JSON-RPC request', async () => {
    const sent = provider(echo);
    const rpc = createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST);
    await expect(rpc('eth_getCode', ['0xabc'])).resolves.toBe('eth_getCode:0xabc');
    expect(sent).toHaveLength(1);
    expect(Array.isArray(sent[0])).toBe(false);
  });

  it('caps public Base envelopes at 5 items (its per-item rate limit) and other networks at 16', async () => {
    const base = provider(echo);
    await Promise.all(calls(createCatalogQuoteReadRpc('https://base.fixture.invalid', 8453, FAST), 7));
    expect(base.map(envelope => Array.isArray(envelope) ? envelope.length : 1)).toEqual([5, 2]);
    vi.restoreAllMocks();
    const ethereum = provider(echo);
    await Promise.all(calls(createCatalogQuoteReadRpc('https://eth.fixture.invalid', 1, FAST), 20));
    expect(ethereum.map(envelope => Array.isArray(envelope) ? envelope.length : 1)).toEqual([16, 4]);
    vi.restoreAllMocks();
    // A dedicated (operator) endpoint is not subject to the public Base item limit.
    const dedicated = provider(echo);
    await Promise.all(calls(createCatalogQuoteReadRpc('https://base.fixture.invalid', 8453, { minIntervalMs: 0, maxInFlight: 6 }), 7));
    expect(dedicated.map(envelope => Array.isArray(envelope) ? envelope.length : 1)).toEqual([7]);
  });
});

describe('createCatalogQuoteReadRpc fails closed on incompatible envelopes', () => {
  const incompatible: [string, (items: Item[], replies: unknown[]) => unknown[] | number][] = [
    ['an HTTP 400 refusal of batches', () => 400],
    ['a missing item', (_items, replies) => replies.slice(1)],
    ['a duplicated id', (_items, replies) => [replies[0], replies[0], ...replies.slice(2)]],
    ['an id outside the request', (_items, replies) => [...replies.slice(1), { jsonrpc: '2.0', id: 99, result: '0xbad' }]],
    // Every expected id is present: only whole-envelope validation (not a count) refuses the stray item.
    ['an extra stray item beside complete answers', (_items, replies) => [...replies, { jsonrpc: '2.0', id: 99, result: '0xbad' }]],
    ['a malformed item beside complete answers', (_items, replies) => [...replies, null]],
    ['an item with both result and error', (_items, replies) => [{ ...replies[0] as object, error: { code: 1, message: 'x' } }, ...replies.slice(1)]],
    ['a non-2.0 item', (_items, replies) => [{ ...replies[0] as object, jsonrpc: '1.0' }, ...replies.slice(1)]],
  ];
  it.each(incompatible)('%s: no item of the envelope is used; every read is answered solo, then batching pauses', async (_name, shape) => {
    const sent = provider(echo, (items, replies) => shape(items, replies.map(reply => ({ ...reply as object, result: '0xfrom-bad-envelope' }))));
    const rpc = createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST);
    const logged: { fallbacks: number }[] = [];
    const answers = await measureQuoteRpc(() => Promise.all(calls(rpc, 3)), metrics => logged.push(metrics));
    expect(answers).toEqual(['eth_call:r0', 'eth_call:r1', 'eth_call:r2']);
    expect(sent.filter(Array.isArray)).toHaveLength(1);
    expect(sent.filter(envelope => !Array.isArray(envelope))).toHaveLength(3);
    expect(logged[0]!.fallbacks).toBe(3);
    // The provider was marked incompatible: later reads go solo without another batch attempt.
    await Promise.all(calls(rpc, 2));
    expect(sent.filter(Array.isArray)).toHaveLength(1);
  });

  it('a whole-envelope error object (HTTP 200, not an array) is never matched to items: each read is answered solo', async () => {
    const sent = provider(echo, () => ({ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'rate limit' } }) as unknown as unknown[]);
    const rpc = createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST);
    expect(await Promise.all(calls(rpc, 3))).toEqual(['eth_call:r0', 'eth_call:r1', 'eth_call:r2']);
    expect(sent.filter(Array.isArray)).toHaveLength(1);
    expect(sent.filter(envelope => !Array.isArray(envelope))).toHaveLength(3);
  });

  it('resumes batching once the 30 s incompatibility pause has passed', async () => {
    let refuse = true;
    const sent = provider(echo, (_items, replies) => refuse ? 400 : replies);
    const rpc = createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST);
    const start = Date.now(), clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(start);
    await Promise.all(calls(rpc, 2));
    refuse = false;
    clock.mockReturnValue(start + 29_000);
    await Promise.all(calls(rpc, 2));
    expect(sent.filter(Array.isArray)).toHaveLength(1);
    clock.mockReturnValue(start + 30_001);
    await Promise.all(calls(rpc, 2));
    expect(sent.filter(Array.isArray)).toHaveLength(2);
  });

  it('a per-item missing-history answer is retried alone and counted as a fallback', async () => {
    let lagging = true;
    const sent = provider(item => item.params[0] === 'r1' && lagging ? (lagging = false, { error: { code: -32000, message: 'header not found' } }) : echo(item));
    const rpc = createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST);
    const logged: { fallbacks: number }[] = [];
    expect(await measureQuoteRpc(() => Promise.all(calls(rpc, 2)), metrics => logged.push(metrics))).toEqual(['eth_call:r0', 'eth_call:r1']);
    expect(logged[0]!.fallbacks).toBe(1);
    expect(sent.filter(envelope => !Array.isArray(envelope)).map(envelope => (envelope as Item).params[0])).toEqual(['r1']);
  });

  it('retries only an item the provider did not answer (rate limit), and never retries a revert', async () => {
    let limited = true;
    const sent = provider(item => {
      if (item.params[0] === 'r1' && limited) { limited = false; return { error: { code: -32005, message: 'rate limit' } }; }
      if (item.params[0] === 'r2') return { error: { code: 3, message: 'execution reverted' } };
      return echo(item);
    });
    const rpc = createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST);
    const [r0, r1, r2] = await Promise.allSettled(calls(rpc, 3));
    expect(r0).toEqual({ status: 'fulfilled', value: 'eth_call:r0' });
    expect(r1).toEqual({ status: 'fulfilled', value: 'eth_call:r1' });
    expect(r2).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'PUBLIC_RPC_RESPONSE_INVALID', rpcReverted: true }) });
    // One batch, then the rate-limited item alone; the reverted item is never sent again.
    expect(sent.filter(envelope => !Array.isArray(envelope)).map(envelope => (envelope as Item).params[0])).toEqual(['r1']);
  });

  it('rejects every read of an envelope the provider never answered (outage), never inventing an amount', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('busy', { status: 503 }));
    const rpc = createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST);
    const results = await Promise.allSettled(calls(rpc, 3));
    for (const result of results) expect(result).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'PUBLIC_RPC_UNAVAILABLE' }) });
  });
});

describe('createCatalogQuoteReadRpc keeps the read-only and chain boundaries', () => {
  it.each(['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'eth_getLogs', 'eth_estimateGas'])('refuses %s before any request', async method => {
    const sent = provider(echo);
    await expect(createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST)(method, [])).rejects.toThrow('PUBLIC_RPC_METHOD_DENIED');
    expect(sent).toHaveLength(0);
  });

  it('never puts a denied method into a shared envelope beside allowed reads', async () => {
    const sent = provider(echo);
    const rpc = createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST);
    const [read, send, other] = await Promise.allSettled([rpc('eth_call', ['r0']), rpc('eth_sendRawTransaction', ['0xsigned']), rpc('eth_call', ['r1'])]);
    expect(send).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'PUBLIC_RPC_METHOD_DENIED' }) });
    expect([read, other]).toEqual([{ status: 'fulfilled', value: 'eth_call:r0' }, { status: 'fulfilled', value: 'eth_call:r1' }]);
    expect(JSON.stringify(sent)).not.toContain('eth_sendRawTransaction');
  });

  it('binds eth_chainId inside a batch: a provider on another chain is refused', async () => {
    provider(item => item.method === 'eth_chainId' ? { result: '0x2105' } : echo(item));
    const rpc = createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST);
    const [chain, read] = await Promise.allSettled([rpc('eth_chainId', []), rpc('eth_call', ['r0'])]);
    expect(chain).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'WRONG_PROVIDER_CHAIN' }) });
    expect(read).toEqual({ status: 'fulfilled', value: 'eth_call:r0' });
    provider(item => item.method === 'eth_chainId' ? { result: '0x1' } : echo(item));
    await expect(createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST)('eth_chainId', [])).resolves.toBe('0x1');
  });

  it('a caller that leaves before its envelope is sent is never sent, and other callers are unaffected', async () => {
    const sent = provider(echo);
    const rpc = createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST);
    const gone = new AbortController(), staying = new AbortController();
    gone.abort();
    const results = await Promise.allSettled([rpc('eth_call', ['gone0'], { signal: gone.signal }), rpc('eth_call', ['gone1'], { signal: gone.signal }),
      rpc('eth_call', ['stay0'], { signal: staying.signal }), rpc('eth_call', ['stay1'], { signal: staying.signal })]);
    expect(results.slice(0, 2).every(result => result.status === 'rejected')).toBe(true);
    expect(results.slice(2)).toEqual([{ status: 'fulfilled', value: 'eth_call:stay0' }, { status: 'fulfilled', value: 'eth_call:stay1' }]);
    expect(JSON.stringify(sent)).not.toContain('gone');
  });

  it('keeps reads of different callers (cancellation scopes) in separate envelopes', async () => {
    const sent = provider(echo);
    const rpc = createCatalogQuoteReadRpc('https://quote.fixture.invalid', 1, FAST);
    const first = new AbortController(), second = new AbortController();
    await Promise.all([rpc('eth_call', ['a0'], { signal: first.signal }), rpc('eth_call', ['a1'], { signal: first.signal }),
      rpc('eth_call', ['b0'], { signal: second.signal }), rpc('eth_call', ['b1'], { signal: second.signal })]);
    expect(sent.map(envelope => (envelope as Item[]).map(item => item.params[0]))).toEqual([['a0', 'a1'], ['b0', 'b1']]);
  });
});
