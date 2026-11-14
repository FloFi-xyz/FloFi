// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003: the 0x Gasless API v2 transport, strict answers and the pre-sign checklist, against 0x's official
 * OpenAPI examples (read-only copies) and an in-process fetch double. No request leaves the process.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eip712, erc7710 } from '@defi-workflow-engine/reference-compiler';
import { createZeroExHttp } from './transport.ts';
import { createZeroExGaslessClient } from './client.ts';
import { EXECUTE_METATXN_SELECTOR, METATXN_FIRST_ACTIONS, METATXN_TRANSFER_FROM_SELECTOR, OWNER_OF_SELECTOR, parseGaslessChains, parseGaslessQuote,
  gaslessReferenceFloor, parseGaslessStatus, PERMIT2, PREV_SELECTOR, readGenuineSettlers, SETTLER_REGISTRY, verifyGaslessQuote, zeroExErrorCode,
  type GaslessCheckContext } from './quote.ts';
import { createBaseSepoliaReadRpc } from '../public-testnet-rpc.ts';

const examples = JSON.parse(readFileSync(new URL('../testdata/zeroex/gasless-official-examples.json', import.meta.url), 'utf8')) as { quote: Record<string, unknown>;
  submitResponse: Record<string, unknown>; status: Record<string, unknown> };
const KEY = 'fixture-key-123';
type Seen = { url: URL; init: RequestInit };
function fetchDouble(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => { seen.push({ url, init }); return respond(url, init); }) as unknown as typeof fetch;
  return { fetcher, seen };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('0x transport: pinned host, bounded, server-side key', () => {
  it('reaches only https://api.0x.org (or the loopback harness) with the API key and v2 headers, no redirects, no cache', async () => {
    const { fetcher, seen } = fetchDouble(() => json(200, { chains: [{ chainId: 4663, chainName: 'Robinhood' }], zid: '0x1' }));
    const http = createZeroExHttp({ apiUrl: 'https://api.0x.org/', apiKey: KEY }, fetcher);
    await http.get('/gasless/chains', {});
    expect(seen[0]!.url.toString()).toBe('https://api.0x.org/gasless/chains');
    expect(seen[0]!.init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store',
      headers: { '0x-api-key': KEY, '0x-version': 'v2', Accept: 'application/json' } });
    for (const apiUrl of ['https://evil.example/', 'http://api.0x.org/', 'https://api.0x.org:8443/', 'https://user:pw@api.0x.org/', 'http://localhost:8561/', 'https://api.0x.org/v1'])
      expect(() => createZeroExHttp({ apiUrl, apiKey: KEY }, fetcher)).toThrow('ZEROX_PROVIDER_URL_INVALID');
    expect(() => createZeroExHttp({ apiUrl: 'http://127.0.0.1:8561/', apiKey: KEY }, fetcher)).not.toThrow();
    await expect(http.get('/swap/permit2/quote', {})).rejects.toThrow('ZEROX_PROVIDER_URL_INVALID');
    await expect(http.get('/gasless/quote', { taker: 'a b' })).rejects.toThrow('ZEROX_PROVIDER_URL_INVALID');
    expect(seen).toHaveLength(1);
  });
  it.each([
    [() => json(429, {}), 'ZEROX_PROVIDER_RATE_LIMITED'],
    [() => json(500, { name: 'INTERNAL_SERVER_ERROR', message: 'x', data: { zid: '0x1' } }), 'ZEROX_PROVIDER_HTTP_500'],
    [() => new Response('<html>', { status: 200 }), 'ZEROX_PROVIDER_RESPONSE_INVALID'],
    [() => new Response('x'.repeat(1_000_001), { status: 200 }), 'ZEROX_PROVIDER_RESPONSE_TOO_LARGE'],
    [() => { throw new TypeError('fetch failed'); }, 'ZEROX_PROVIDER_UNAVAILABLE'],
    [() => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }), 'ZEROX_PROVIDER_HTTP_302'],
  ])('fails closed (%#) with a closed code', async (respond, code) => {
    const { fetcher } = fetchDouble(respond);
    await expect(createZeroExHttp({ apiUrl: 'https://api.0x.org/', apiKey: KEY }, fetcher).get('/gasless/chains', {})).rejects.toThrow(code);
  });
  it('review PI4: reads the body incrementally and stops at the cap (a chunked body with no content-length is never buffered whole)', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(65_536).fill(0x20);
    const endless = () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(chunk); } }), { status: 200 });
    const { fetcher } = fetchDouble(endless);
    await expect(createZeroExHttp({ apiUrl: 'https://api.0x.org/', apiKey: KEY }, fetcher).get('/gasless/chains', {})).rejects.toThrow('ZEROX_PROVIDER_RESPONSE_TOO_LARGE');
    // 1,000,000 bytes is 16 chunks of 64 KiB: the reader cancels on the first chunk past the cap (the stream may have queued one more).
    expect(pulled).toBeLessThanOrEqual(18);
    // A body within the cap, split in chunks, still parses (bytes, not characters, are counted: 'é' is two bytes).
    const parts = [new TextEncoder().encode('{"chains":[{"chainId":4663,"chainName":"Robinhood é"}],'), new TextEncoder().encode('"zid":"0x1"}')];
    const split = fetchDouble(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }), { status: 200 }));
    expect((await createZeroExHttp({ apiUrl: 'https://api.0x.org/', apiKey: KEY }, split.fetcher).get('/gasless/chains', {})).body)
      .toEqual({ chains: [{ chainId: 4663, chainName: 'Robinhood é' }], zid: '0x1' });
  });
  it('returns 0x\'s 4xx envelope to the caller and never echoes the key', async () => {
    const { fetcher } = fetchDouble(() => json(400, { name: 'TOKEN_NOT_SUPPORTED', message: 'no', data: { zid: '0x1', token: PERMIT2 } }));
    const answer = await createZeroExHttp({ apiUrl: 'https://api.0x.org/', apiKey: KEY }, fetcher).get('/gasless/chains', {});
    expect(answer.status).toBe(400);
    expect(JSON.stringify(answer)).not.toContain(KEY);
  });
});

describe('0x client: definitive answers only', () => {
  const client = (respond: (url: URL, init: RequestInit) => Response) => createZeroExGaslessClient(createZeroExHttp({ apiUrl: 'https://api.0x.org/', apiKey: KEY }, fetchDouble(respond).fetcher));
  const submission = { chainId: 4663, trade: { type: 'settler_metatransaction' as const, eip712: { types: {}, domain: {}, message: {}, primaryType: 'X' },
    signature: { signatureType: 2 as const, v: 27 as const, r: '0x' + '1'.repeat(64), s: '0x' + '2'.repeat(64) } } };
  it('reads the official submit and status answers', async () => {
    expect(await client(() => json(201, examples.submitResponse)).submit(submission)).toEqual({ kind: 'ACCEPTED', tradeHash: examples.submitResponse.tradeHash });
    expect(await client(() => json(200, examples.status)).status('0x' + 'a'.repeat(64), 1)).toMatchObject({ status: 'confirmed', reason: null,
      transactions: ['0x36b42bc0ec313cfb9bf5122fbda933cbcce5f557bc3b7197b52223b05d7e596f'] });
    expect(await client(() => json(404, { name: 'META_TRANSACTION_STATUS_NOT_FOUND', message: 'x', data: { zid: '0x1' } })).status('0x' + 'a'.repeat(64), 1)).toBeNull();
  });
  it('treats TRADE_ALREADY_SUBMITTED as observation, a closed 4xx as a refusal, and anything else as unknown (thrown)', async () => {
    expect(await client(() => json(400, { name: 'TRADE_ALREADY_SUBMITTED', message: 'x', data: { zid: '0x1', tradeHash: '0x' + 'B'.repeat(64) } })).submit(submission))
      .toEqual({ kind: 'ALREADY_SUBMITTED', tradeHash: '0x' + 'b'.repeat(64) });
    expect(await client(() => json(400, { name: 'INVALID_SIGNATURE', message: 'x', data: { zid: '0x1' } })).submit(submission)).toEqual({ kind: 'REFUSED', code: 'ZEROX_SIGNATURE_REFUSED' });
    await expect(client(() => json(400, { name: 'SOMETHING_NEW', message: 'x', data: { zid: '0x1' } })).submit(submission)).rejects.toThrow('ZEROX_PROVIDER_HTTP_400');
    await expect(client(() => json(503, {})).submit(submission)).rejects.toThrow('ZEROX_PROVIDER_HTTP_503');
    await expect(client(() => json(201, { tradeHash: 'nope' })).submit(submission)).rejects.toThrow('ZEROX_PROVIDER_RESPONSE_INVALID');
  });
  it('asks /gasless/chains and remembers only a positive answer', async () => {
    let calls = 0;
    const c = client(() => { calls++; return json(200, { chains: [{ chainId: 4663, chainName: 'Robinhood' }], zid: '0x1' }); });
    expect(await c.supports(4663)).toBe(true);
    expect(await c.supports(4663)).toBe(true);
    expect(calls).toBe(1);
    expect(await client(() => json(200, { chains: [{ chainId: 1, chainName: 'Ethereum' }], zid: '0x1' })).supports(4663)).toBe(false);
  });
});

describe('strict answers', () => {
  it('parses the official quote example and the published chains example (string ids)', () => {
    const parsed = parseGaslessQuote(examples.quote);
    expect(parsed).toMatchObject({ liquidityAvailable: true, sellAmount: '300000000', minBuyAmount: '292116101', approval: { type: 'permit' } });
    expect(parseGaslessQuote({ liquidityAvailable: false, zid: '0x1' })).toEqual({ liquidityAvailable: false, zid: '0x1' });
    expect(parseGaslessChains({ chains: [{ chainName: 'Ethereum', chainId: '1' }, { chainName: 'Robinhood', chainId: 4663 }], zid: '0x1' })).toEqual([1, 4663]);
  });
  it('refuses malformed answers instead of guessing', () => {
    expect(() => parseGaslessQuote({ ...examples.quote, sellAmount: '1.5' })).toThrow('ZEROX_PROVIDER_RESPONSE_INVALID');
    expect(() => parseGaslessQuote({ ...examples.quote, liquidityAvailable: 'yes' })).toThrow('ZEROX_PROVIDER_RESPONSE_INVALID');
    expect(() => parseGaslessStatus({ status: 'expired', transactions: [], zid: '0x1' })).toThrow('ZEROX_PROVIDER_RESPONSE_INVALID');
    expect(() => parseGaslessStatus({ status: 'failed', transactions: [], zid: '0x1' })).toThrow('ZEROX_PROVIDER_RESPONSE_INVALID');
    expect(parseGaslessStatus({ status: 'failed', reason: 'order_expired', transactions: [], zid: '0x1' })).toMatchObject({ status: 'failed', reason: 'order_expired' });
  });
  it('maps 0x\'s closed error names to closed ZEROX_* codes shaped for the estimate copy', () => {
    const env = (name: string) => ({ name, message: 'x', data: { zid: '0x1' } });
    expect(zeroExErrorCode(403, env('XSTOCKS_NOT_AUTHORIZED'))).toBe('ZEROX_STOCK_TOKEN_NOT_AUTHORIZED');
    expect(zeroExErrorCode(422, env('SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE'))).toBe('ZEROX_TOKEN_NOT_AUTHORIZED');
    expect(zeroExErrorCode(400, env('SELL_AMOUNT_TOO_SMALL'))).toBe('ZEROX_SELL_AMOUNT_TOO_LOW');
    expect(zeroExErrorCode(400, env('TOKEN_PAIR_NOT_SUPPORTED'))).toBe('ZEROX_PAIR_NO_ROUTE');
    expect(zeroExErrorCode(400, { name: 'TOKEN_NOT_SUPPORTED' })).toBe('ZEROX_PROVIDER_HTTP_400');
  });
});

describe('the pre-sign checklist on 0x\'s official example (Ethereum, chainId 1)', () => {
  const taker = '0x70a9f34f9b34c64957b9c401a97bfed35b95049e', settler = '0x7c39a136ea20b3483e402ea031c1f3c019bab24b';
  const request = { chainId: 1, taker, sellToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', buyToken: '0xdac17f958d2ee523a2206206994597c13d831ec7', sellAmount: '300000000', slippageBps: 30 };
  // The published example's permit expires ~50 minutes before its trade: the clock is set where both are still signable.
  // FloFi's own Uniswap v3 quote of the same swap (USDC → USDT about 1:1): minimum 299.1 USDT at 30 bps, so 0x's floor is 299.1 − 7.112169 fees.
  const reference = { source: 'uniswap-v3' as const, pool: '0x3416cf6c708da44db2624d63ea0aaef7113527c6', fee: 100, expectedOut: '300000000', minimumOut: '299100000' };
  const context: GaslessCheckContext = { settlers: { current: settler, previous: null }, reference, nowMs: 1_718_667_000_000, minimumLifetimeMs: 45_000,
    maximumLifetimeSeconds: 3_600 };
  const funded: Record<string, unknown> = { ...examples.quote, issues: { ...examples.quote.issues as object, balance: null } };
  const verify = (quote: unknown, ctx: Partial<GaslessCheckContext> = {}, req: Partial<typeof request> = {}) =>
    verifyGaslessQuote(parseGaslessQuote(quote), '0x' + '0'.repeat(64), { ...request, ...req }, { ...context, ...ctx });
  type Trade = { trade: { eip712: { message: Record<string, unknown> } } };
  const withMessage = (change: (message: Record<string, unknown>) => void, rehash = false) => {
    const copy = structuredClone(funded) as Record<string, unknown> & Trade & { trade: { hash: string } }; change(copy.trade.eip712.message);
    // A provider that re-signs its own tampered payload: the digest matches, so only the field checks can refuse it.
    if (rehash) copy.trade.hash = eip712.hashTypedData(copy.trade.eip712 as unknown as eip712.TypedData);
    return copy;
  };
  it('recognises the selectors it binds', () => {
    expect(METATXN_TRANSFER_FROM_SELECTOR).toBe('0x0dfeb419');
    expect(EXECUTE_METATXN_SELECTOR).toBe('0xfd3ad6d4');
    expect(OWNER_OF_SELECTOR).toBe('0x6352211e');
  });
  it('accepts the official trade and permit: both digests recomputed, every field bound', () => {
    const binding = verify(funded);
    expect(binding).toMatchObject({ settler, settlerSource: 'ownerOf', sellAmount: '300000000', minBuyAmount: '292116101',
      gasFee: { token: request.buyToken, amount: '6962116' }, zeroExFee: { amount: '150053' }, approval: { type: 'permit', value: '300000000', unlimited: false },
      trade: { hash: '0x3ff032fa3a970a3f2b763afce093fd133ced63c0b097ab12ae1441b42de4a167', deadline: 1_718_670_104 } });
    expect(binding.sources).toEqual(['SolidlyV3']);
    // Review Z3: FloFi's own reference is kept beside 0x's figures, with the floor 0x's minimum had to reach (both fees are in USDT, the buy token).
    expect(binding.reference).toEqual({ ...reference, floor: (299_100_000 - 6_962_116 - 150_053).toString() });
  });
  it('Z3: refuses a quote whose minimum is below FloFi\'s own slippage minimum net of 0x\'s disclosed fees (ZEROX_QUOTE_WORSE_THAN_REFERENCE)', () => {
    // Uniswap would pay 301 USDT (minimum 300.097): net of 7.112169 USDT of fees the floor is 292.984831 > 0x's 292.116101.
    expect(() => verify(funded, { reference: { ...reference, expectedOut: '301000000', minimumOut: '300097000' } })).toThrow('ZEROX_QUOTE_WORSE_THAN_REFERENCE');
    // Exactly at the floor is accepted; one unit above it is not.
    const atFloor = (292_116_101 + 6_962_116 + 150_053).toString();
    expect(verify(funded, { reference: { ...reference, minimumOut: atFloor } }).reference.floor).toBe('292116101');
    expect(() => verify(funded, { reference: { ...reference, minimumOut: (BigInt(atFloor) + 1n).toString() } })).toThrow('ZEROX_QUOTE_WORSE_THAN_REFERENCE');
    // A reference that is not one (no pool, a minimum above its expected output) is unverifiable, never skipped.
    expect(() => verify(funded, { reference: { ...reference, pool: 'none' } })).toThrow('ZEROX_TRADE_UNVERIFIABLE');
    expect(() => verify(funded, { reference: { ...reference, minimumOut: '300000001' } })).toThrow('ZEROX_TRADE_UNVERIFIABLE');
  });
  it('Z3: a fee in the sell token removes its share of the input at FloFi\'s reference; never below zero', () => {
    const ref = { ...reference, expectedOut: '1000', minimumOut: '995' }, sell = { token: request.sellToken, amount: '1000' };
    expect(gaslessReferenceFloor(ref, sell, request.buyToken, [{ token: request.sellToken, amount: '100' }, null])).toBe(995n * 900n / 1000n);
    expect(gaslessReferenceFloor(ref, sell, request.buyToken, [{ token: request.sellToken, amount: '100' }, { token: request.buyToken, amount: '5' }])).toBe(895n - 5n);
    expect(gaslessReferenceFloor(ref, sell, request.buyToken, [{ token: request.buyToken, amount: '2000' }])).toBe(0n);
    expect(gaslessReferenceFloor(ref, sell, request.buyToken, [{ token: request.sellToken, amount: '1000' }])).toBe(0n);
    expect(() => gaslessReferenceFloor(ref, sell, request.buyToken, [{ token: PERMIT2, amount: '1' }])).toThrow('ZEROX_TRADE_UNVERIFIABLE');
  });
  it.each([
    ['0x reports a balance issue (the example as published)', () => verify(examples.quote), 'ZEROX_INSUFFICIENT_BALANCE'],
    ['the gas fee is absent', () => verify({ ...funded, fees: { ...funded.fees as object, gasFee: null } }), 'ZEROX_SPONSORED_QUOTE_REFUSED'],
    ['the gas fee is in a third token', () => verify({ ...funded, fees: { ...funded.fees as object, gasFee: { amount: '1', token: PERMIT2, type: 'gas' } } }), 'ZEROX_SPONSORED_QUOTE_REFUSED'],
    ['an integrator fee appears', () => verify({ ...funded, fees: { ...funded.fees as object, integratorFee: { amount: '1', token: request.sellToken, type: 'volume' } } }), 'ZEROX_TRADE_UNVERIFIABLE'],
    ['the trade hash is not the digest of the trade', () => verify({ ...funded, trade: { ...funded.trade as object, hash: '0x' + '1'.repeat(64) } }), 'ZEROX_TRADE_HASH_MISMATCH'],
    ['the Settler is not the registry\'s', () => verify(funded, { settlers: { current: '0x' + '2'.repeat(40), previous: null } }), 'ZEROX_SETTLER_MISMATCH'],
    ['the permitted amount differs', () => verify(funded, {}, { sellAmount: '299999999' }), 'ZEROX_QUOTE_MISMATCH'],
    ['the deadline already passed', () => verify(funded, { nowMs: 1_718_670_104_000 }), 'ZEROX_QUOTE_EXPIRED'],
    ['the minimum is below FloFi\'s slippage minimum', () => verify(funded, {}, { slippageBps: 1 }), 'ZEROX_MINIMUM_BELOW_SLIPPAGE'],
    ['the recipient is not the owner', () => verify(funded, {}, { taker: '0x' + '3'.repeat(40) }), 'ZEROX_TRADE_UNVERIFIABLE'],
    ['the first action is not the permit transfer', () => verify(withMessage(m => { (m.slippageAndActions as { actions: string[] }).actions[0] = '0x38c9c147'; })), 'ZEROX_TRADE_HASH_MISMATCH'],
    ['a re-hashed trade whose first action is not the permit transfer', () => verify(withMessage(m => {
      (m.slippageAndActions as { actions: string[] }).actions[0] = '0x38c9c147' + '0'.repeat(64); }, true)), 'ZEROX_TRADE_UNVERIFIABLE'],
    ['a re-hashed trade with a zeroed slippage struct', () => verify(withMessage(m => {
      m.slippageAndActions = { ...m.slippageAndActions as object, recipient: '0x' + '0'.repeat(40), buyToken: '0x' + '0'.repeat(40), minAmountOut: '0' }; }, true)), 'ZEROX_TRADE_UNVERIFIABLE'],
    ['a re-hashed trade for another spender', () => verify(withMessage(m => { m.spender = '0x' + '4'.repeat(40); }, true)), 'ZEROX_SETTLER_MISMATCH'],
    ['the chain differs', () => verify(funded, {}, { chainId: 4663 }), 'ZEROX_TRADE_UNVERIFIABLE'],
    ['the permit approves the Settler instead of Permit2', () => {
      const copy = structuredClone(funded) as Record<string, unknown> & { approval: { eip712: { message: Record<string, unknown> } } };
      copy.approval.eip712.message.spender = settler; return verify(copy); }, 'ZEROX_APPROVAL_MISMATCH'],
    ['an unknown approval type is offered', () => verify({ ...funded, approval: { ...funded.approval as object, type: 'executeMetaTransaction::approve' } }), 'ZEROX_GASLESS_APPROVAL_UNAVAILABLE'],
    ['an allowance is missing and no gasless approval exists', () => verify({ ...funded, approval: null }), 'ZEROX_GASLESS_APPROVAL_UNAVAILABLE'],
    ['the sell token is taxed', () => verify({ ...funded, tokenMetadata: { buyToken: { buyTaxBps: '0', sellTaxBps: '0' }, sellToken: { buyTaxBps: '0', sellTaxBps: '100' } } }), 'ZEROX_TRADE_UNVERIFIABLE'],
    ['liquidity is unavailable', () => verify({ liquidityAvailable: false, zid: '0x1' }), 'ZEROX_NO_LIQUIDITY'],
  ])('refuses when %s', (_name, run, code) => {
    expect(run).toThrow(code);
  });

  // Review PI3: 0x-settler's ISettlerActions.sol — "VIP actions should always start with `recipient` address and the `permit` from the taker".
  const officialFirst = ((funded as unknown as Trade).trade.eip712.message.slippageAndActions as { actions: string[] }).actions[0]!;
  const permitWords = officialFirst.slice(74, 330), word = (n: bigint) => n.toString(16).padStart(64, '0');
  const pool = '0x' + '00'.repeat(12) + '88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
  const METATXN_UNISWAPV3_VIP = erc7710.selectorOf('METATXN_UNISWAPV3_VIP(address,((address,uint256),uint256,uint256),bytes,uint256)');
  /** The taker-submitted `TRANSFER_FROM(recipient, permit, sig)`: not witness-aware, never a MetaTxn first action. */
  const TRANSFER_FROM = erc7710.selectorOf('TRANSFER_FROM(address,((address,uint256),uint256,uint256),bytes)');
  /** METATXN_UNISWAPV3_VIP(recipient, permit, bytes path, uint256 amountOutMin), ABI-encoded: 7 head words, then the path. */
  const uniswapV3Vip = (recipientWord: string, permit = permitWords) => {
    const path = request.sellToken.slice(2) + '0001f4' + request.buyToken.slice(2), padded = path.padEnd(Math.ceil(path.length / 64) * 64, '0');
    return METATXN_UNISWAPV3_VIP + recipientWord.slice(2) + permit +
      word(7n * 32n) + word(292_116_101n) + word(BigInt(path.length / 2)) + padded;
  };
  const withFirst = (first: string) => verify(withMessage(m => { (m.slippageAndActions as { actions: string[] }).actions[0] = first; }, true));
  it('PI3: the selectors are computed from the canonical METATXN_* signatures of ISettlerActions.sol', () => {
    expect(Object.values(METATXN_FIRST_ACTIONS)).toEqual([
      'METATXN_TRANSFER_FROM(address,((address,uint256),uint256,uint256))',
      'METATXN_RFQ_VIP(address,((address,uint256),uint256,uint256),((address,uint256),uint256,uint256),address,bytes)',
      'METATXN_UNISWAPV4_VIP(address,((address,uint256),uint256,uint256),uint8,bool,uint256,uint256,bytes,uint256)',
      'METATXN_BALANCERV3_VIP(address,((address,uint256),uint256,uint256),bool,uint256,uint256,bytes,uint256)',
      'METATXN_PANCAKE_INFINITY_VIP(address,((address,uint256),uint256,uint256),uint8,bool,uint256,uint256,bytes,uint256)',
      'METATXN_UNISWAPV3_VIP(address,((address,uint256),uint256,uint256),bytes,uint256)',
      'METATXN_CURVE_TRICRYPTO_VIP(address,((address,uint256),uint256,uint256),uint80,uint256)',
      'METATXN_EKUBOV3_VIP(address,((address,uint256),uint256,uint256),bool,uint256,uint256,bytes,uint256)']);
    expect(Object.keys(METATXN_FIRST_ACTIONS)).toContain(METATXN_TRANSFER_FROM_SELECTOR);
    expect(new Set(Object.keys(METATXN_FIRST_ACTIONS)).size).toBe(8);
    // The official example's first action is METATXN_TRANSFER_FROM of exactly the permit, paid to the Settler.
    expect(officialFirst.slice(0, 10)).toBe(METATXN_TRANSFER_FROM_SELECTOR);
  });
  it('PI3: accepts METATXN_TRANSFER_FROM of exactly the permit to the Settler, and a VIP first action whose permit words are the signed permit', () => {
    expect(withFirst(officialFirst).settler).toBe(settler);
    // A METATXN_UNISWAPV3_VIP straight from the owner's permit into the pool (0x's custody optimisation) is the same authorisation.
    const binding = withFirst(uniswapV3Vip(pool));
    expect(binding).toMatchObject({ settler, sellAmount: '300000000', minBuyAmount: '292116101' });
    expect(withFirst(uniswapV3Vip('0x' + settler.slice(2).padStart(64, '0'))).settler).toBe(settler);
  });
  it.each([
    ['a VIP whose permit amount is not the signed one', () => uniswapV3Vip(pool, permitWords.slice(0, 64) + word(300_000_001n) + permitWords.slice(128))],
    ['a VIP whose permit token is not the sell token', () => uniswapV3Vip(pool, '0'.repeat(24) + request.buyToken.slice(2) + permitWords.slice(64))],
    ['a VIP whose permit nonce is not the signed one', () => uniswapV3Vip(pool, permitWords.slice(0, 128) + word(1n) + permitWords.slice(192))],
    ['a VIP whose permit deadline is not the signed one', () => uniswapV3Vip(pool, permitWords.slice(0, 192) + word(1n))],
    ['a VIP with a zero recipient', () => uniswapV3Vip('0x' + '0'.repeat(64))],
    ['a VIP whose recipient word is not an address', () => uniswapV3Vip('0x' + 'f'.repeat(64))],
    ['a VIP truncated to the permit (no route)', () => uniswapV3Vip(pool).slice(0, 330)],
    ['a VIP that is not whole ABI words', () => uniswapV3Vip(pool) + 'ab'],
    ['METATXN_TRANSFER_FROM paid elsewhere than the Settler', () => officialFirst.slice(0, 10) + pool.slice(2) + permitWords],
    ['METATXN_TRANSFER_FROM with trailing words', () => officialFirst + word(1n)],
    ['the taker-submitted TRANSFER_FROM (not witness-aware)', () => TRANSFER_FROM + officialFirst.slice(10)],
    ['an unknown selector with the right permit words', () => '0xdeadbeef' + officialFirst.slice(10)],
  ])('PI3: refuses %s', (_name, first) => {
    expect(() => withFirst(first())).toThrow('ZEROX_TRADE_UNVERIFIABLE');
  });
});

describe('review PI2: the Settler registry read through FloFi\'s production read client', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const SETTLER = '0x5ce929ddb01804bff35b2f5c77b735bdb094aac8', PREVIOUS = '0x7c39a136ea20b3483e402ea031c1f3c019bab24b';
  /** A JSON-RPC node behind the real `createBaseSepoliaReadRpc` (global fetch stubbed: nothing leaves the process). */
  function node(answers: { ownerOf: string | 'revert'; prev: string | 'revert' | 'invalid-params' }) {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const { method, params } = JSON.parse(String(init.body)) as { method: string; params: [{ to?: string; data?: string } | string, string] };
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
      const error = (code: number, message: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }), { status: 200 });
      if (method === 'eth_getCode') return ok('0x6080');
      const data = (params[0] as { data: string }).data, answer = data.startsWith(OWNER_OF_SELECTOR) ? answers.ownerOf : data.startsWith(PREV_SELECTOR) ? answers.prev : 'revert';
      expect((params[0] as { to: string }).to).toBe(SETTLER_REGISTRY);
      if (answer === 'revert') return error(3, 'execution reverted');
      if (answer === 'invalid-params') return error(-32602, 'invalid params');
      return ok('0x' + answer.slice(2).padStart(64, '0'));
    });
    return createBaseSepoliaReadRpc('http://127.0.0.1:9/', ['eth_getCode', 'eth_call']);
  }
  it('reads a revert of prev(3) (no dwell period) as no previous Settler', async () => {
    expect(await readGenuineSettlers(node({ ownerOf: SETTLER, prev: 'revert' }), 'latest')).toEqual({ current: SETTLER, previous: null });
    expect(await readGenuineSettlers(node({ ownerOf: SETTLER, prev: PREVIOUS }), 'latest')).toEqual({ current: SETTLER, previous: PREVIOUS });
  });
  it('reads a revert of ownerOf(3) as the MetaTxn Settler paused, and never takes another node error for a revert', async () => {
    await expect(readGenuineSettlers(node({ ownerOf: 'revert', prev: PREVIOUS }), 'latest')).rejects.toThrow('ZEROX_SETTLER_PAUSED');
    await expect(readGenuineSettlers(node({ ownerOf: SETTLER, prev: 'invalid-params' }), 'latest')).rejects.toThrow('PUBLIC_RPC_RESPONSE_INVALID');
  });
});

describe('the Robinhood Chain gasless runtime', () => {
  it('is off by default, and never lets a live deployment reach a loopback double or the harness reach api.0x.org', async () => {
    const { robinhoodGaslessRuntime } = await import('../robinhood-mainnet.ts');
    expect(robinhoodGaslessRuntime('live', {})).toEqual({ config: { enabled: false, code: 'ZEROX_GASLESS_NOT_ENABLED' }, client: null });
    expect(robinhoodGaslessRuntime('live', { FLOFI_ZEROX_GASLESS: 'enabled' }).config).toEqual({ enabled: false, code: 'ZEROX_API_KEY_NOT_CONFIGURED' });
    const live = { FLOFI_ZEROX_GASLESS: 'enabled', FLOFI_ZEROX_API_KEY: KEY };
    expect(robinhoodGaslessRuntime('live', live).config).toMatchObject({ enabled: true, apiUrl: 'https://api.0x.org', loopback: false });
    expect(robinhoodGaslessRuntime('live', live).client).not.toBeNull();
    expect(robinhoodGaslessRuntime('harness', live).config).toEqual({ enabled: false, code: 'ZEROX_CONFIGURATION_INVALID' });
    const loopback = { ...live, FLOFI_ZEROX_API_URL: 'http://127.0.0.1:8561' };
    expect(robinhoodGaslessRuntime('live', loopback).config).toEqual({ enabled: false, code: 'ZEROX_CONFIGURATION_INVALID' });
    expect(robinhoodGaslessRuntime('harness', loopback).config).toMatchObject({ enabled: true, loopback: true });
  });
});
