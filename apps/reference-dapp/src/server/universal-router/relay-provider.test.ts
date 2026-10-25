// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { relayOrderId, RELAY_EVM_DEPOSITORY, type RelayOrderData } from '@defi-workflow-engine/reference-compiler';
import { UNIVERSAL_NETWORKS, universalRouteCommitment, type UniversalNetworkKey, type UniversalToken } from '@defi-workflow-engine/workflow-contracts';
import { normalizeRelayQuote, normalizeRelayStatus, relayQuoteBody, relayRefusal, type UniversalQuoteRequest } from './relay-provider.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;
/** Live Relay quotes recorded read-only on 2026-10-25 (random addresses, Relay's default 200 bps slippage). */
const fixture = (name: string): { request: Record<string, string | number>; response: Raw } =>
  JSON.parse(readFileSync(new URL(`../testdata/universal/relay-${name}.json`, import.meta.url), 'utf8'));
const TOKENS: Record<string, Omit<UniversalToken, 'chainId'>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { kind: 'TOKEN', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC' },
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { kind: 'TOKEN', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC' },
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { kind: 'TOKEN', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6, symbol: 'USDC' },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { kind: 'TOKEN', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, symbol: 'USDC' },
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': { kind: 'TOKEN', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, symbol: 'USDG' },
};
const KEY: Record<number, UniversalNetworkKey> = { 792703809: 'solana', 8453: 'base', 42161: 'arbitrum-one', 1: 'ethereum', 4663: 'robinhood' };
const token = (key: UniversalNetworkKey, currency: string): UniversalToken => {
  const network = UNIVERSAL_NETWORKS[key];
  if (currency === '0x0000000000000000000000000000000000000000' || currency === '11111111111111111111111111111111')
    return { chainId: network.chain, kind: 'NATIVE', address: null, decimals: network.native.decimals, symbol: network.native.symbol };
  return { chainId: network.chain, ...TOKENS[currency]! };
};
function requestOf(name: string, patch: Partial<UniversalQuoteRequest> = {}): { raw: Raw; request: UniversalQuoteRequest } {
  const f = fixture(name), src = KEY[f.request.originChainId as number]!, dst = KEY[f.request.destinationChainId as number]!;
  const deadline = f.response.protocol.v2.orderData.output.deadline as number;
  return { raw: f.response, request: { source: UNIVERSAL_NETWORKS[src], destination: UNIVERSAL_NETWORKS[dst], inputToken: token(src, String(f.request.originCurrency)),
    outputToken: token(dst, String(f.request.destinationCurrency)), amount: String(f.request.amount), owner: String(f.request.user), recipient: String(f.request.recipient),
    slippageBps: 200, nowMs: (deadline - 7 * 86_400 + 30) * 1000, reviewTtlSeconds: 120,
    inputTokenProgram: src === 'solana' && String(f.request.originCurrency) !== '11111111111111111111111111111111' ? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' : null, ...patch } };
}
const NAMES = ['sol-base', 'base-sol', 'rh-sol', 'arb-rh-eth', 'eth-sol-native', 'arb-sol', 'sol-arb-native'];
const vmOf = (slug: string) => slug === 'solana' ? 'solana-vm' as const : 'ethereum-vm' as const;
const clone = <T,>(value: T): T => structuredClone(value);

describe('BUILD-CROSSCHAIN-UNIVERSAL-001 Relay adapter (recorded live quotes)', () => {
  it.each(NAMES)('normalizes the live %s quote into a verified universal route', name => {
    const { raw, request } = requestOf(name), route = normalizeRelayQuote(raw, request);
    const order = raw.protocol.v2.orderData.output.payments[0];
    expect(route).toMatchObject({ provider: 'relay', protocol: 'relay-depository', inputAmount: request.amount, expectedOutput: order.expectedAmount,
      minimumOutput: order.minimumAmount, depositor: request.source.ecosystem === 'EVM' ? request.owner.toLowerCase() : request.owner,
      order: { kind: 'RELAY_V2', orderId: raw.protocol.v2.orderId }, destination: { additionalAuthorization: 'NONE' }, quote: { id: raw.requestId } });
    expect(route.fees.find(f => f.kind === 'SOURCE_NETWORK_FEE')).toMatchObject({ included: false, token: 'native', chainId: request.source.chain });
    expect(route.fees.filter(f => f.included).every(f => f.kind.startsWith('RELAYER_'))).toBe(true);
    expect(universalRouteCommitment(route)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Date.parse(route.quote.expiresAt) - request.nowMs).toBe(120_000);
  });
  it('EVM token routes carry FloFi\'s own exact approval to the Depository; native routes carry no approval and value = amount', () => {
    const token = normalizeRelayQuote(...Object.values(requestOf('base-sol')) as [Raw, UniversalQuoteRequest]);
    expect(token.source).toMatchObject({ ecosystem: 'EVM', approval: { spender: RELAY_EVM_DEPOSITORY, amount: '20000000' }, deposit: { to: RELAY_EVM_DEPOSITORY, value: '0' } });
    const native = normalizeRelayQuote(...Object.values(requestOf('arb-rh-eth')) as [Raw, UniversalQuoteRequest]);
    expect(native.source).toMatchObject({ ecosystem: 'EVM', approval: null, deposit: { value: '10000000000000000' } });
  });
  it('a cross-asset route keeps both assets (Base USDC → Solana SOL is quoted as Ethereum USDC → SOL here)', () => {
    const route = normalizeRelayQuote(...Object.values(requestOf('eth-sol-native')) as [Raw, UniversalQuoteRequest]);
    expect([route.inputToken.symbol, route.outputToken.kind, route.outputToken.decimals]).toEqual(['USDC', 'NATIVE', 9]);
  });
  it('sends FloFi\'s slippage, refunds to the owner and no app fee or deposit-address flow', () => {
    expect(relayQuoteBody(requestOf('sol-base', { slippageBps: 50 }).request)).toEqual({ user: 'qwjYpMzHkNQ6rNuMWaLshaxouXKLAmEDvRcgHLiQMwJ',
      recipient: '0x639b2563d7b015df363568bef260034eea9c274f', originChainId: 792703809, destinationChainId: 8453, originCurrency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      destinationCurrency: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '20000000', tradeType: 'EXACT_INPUT', refundTo: 'qwjYpMzHkNQ6rNuMWaLshaxouXKLAmEDvRcgHLiQMwJ',
      slippageTolerance: '50', useDepositAddress: false });
  });
});

describe('N — tampered or mismatched quotes are refused before Review', () => {
  const refuse = (name: string, mutate: (raw: Raw, request: UniversalQuoteRequest) => [Raw, UniversalQuoteRequest] | void, code: string, patch: Partial<UniversalQuoteRequest> = {}) => {
    const { raw, request } = requestOf(name, patch), r = clone(raw), out = mutate(r, request) ?? [r, request];
    expect(() => normalizeRelayQuote(out[0], out[1])).toThrow(code);
  };
  const rehash = (raw: Raw, change: (o: RelayOrderData) => void) => {
    change(raw.protocol.v2.orderData); raw.protocol.v2.orderId = relayOrderId(raw.protocol.v2.orderData, vmOf);
  };
  it('wrong chain or wrong recipient', () => {
    refuse('base-sol', () => undefined, 'RELAY_PAYMENT_MISMATCH', { source: UNIVERSAL_NETWORKS['arbitrum-one'] });
    refuse('base-sol', () => undefined, 'RELAY_ORDER_RECIPIENT_MISMATCH', { recipient: 'HjcWJor6kDs1WtUp9CqaxiC3pq3pZyToQU7rPU5kbbqi' });
    refuse('sol-base', raw => rehash(raw, o => { (o.output.payments[0] as { recipient: string }).recipient = '0x' + '9'.repeat(40); }), 'RELAY_ORDER_RECIPIENT_MISMATCH');
  });
  it('a modified quote (order changed under the old id, or the summary disagreeing with the order)', () => {
    refuse('sol-base', raw => { raw.protocol.v2.orderData.output.payments[0].minimumAmount = '1'; }, 'RELAY_ORDER_ID_MISMATCH');
    refuse('sol-base', raw => { raw.details.currencyOut.minimumAmount = '19974198'; }, 'RELAY_OUTPUT_MISMATCH');
    refuse('sol-base', raw => { raw.details.currencyIn.currency.decimals = 9; }, 'RELAY_INPUT_MISMATCH');
  });
  it('changed calldata, an unexpected spender or an extra step', () => {
    refuse('base-sol', raw => { raw.steps[1].items[0].data.data = raw.steps[1].items[0].data.data.slice(0, -2) + '00'; }, 'RELAY_TRANSACTION_MISMATCH');
    refuse('base-sol', raw => { raw.steps[0].items[0].data.data = '0x095ea7b3' + '0'.repeat(24) + '7'.repeat(40) + raw.steps[0].items[0].data.data.slice(74); }, 'RELAY_TRANSACTION_MISMATCH');
    refuse('base-sol', raw => { raw.steps[1].items[0].data.to = '0x' + '7'.repeat(40); }, 'RELAY_TRANSACTION_MISMATCH');
    refuse('arb-rh-eth', raw => { raw.steps[0].items[0].data.value = '1'; }, 'RELAY_TRANSACTION_MISMATCH');
    refuse('base-sol', raw => { raw.steps.push({ ...raw.steps[1], id: 'swap' }); }, 'RELAY_STEPS_UNSUPPORTED');
    refuse('sol-base', raw => { raw.steps[0].items[0].data.instructions[0].keys[5].pubkey = 'G5na5MqdhnEdMkgkN5RhUnwqGe8sYAuJpUhXWAFxsDFm'; }, 'RELAY_TRANSACTION_MISMATCH');
    refuse('sol-base', raw => { raw.steps[0].items[0].data.instructions.push(raw.steps[0].items[0].data.instructions[0]); }, 'RELAY_TRANSACTION_MISMATCH');
  });
  it('an invalid minimum output, an app fee or order fees', () => {
    refuse('sol-base', () => undefined, 'RELAY_ORDER_MINIMUM_BELOW_SLIPPAGE', { slippageBps: 100 });
    refuse('sol-base', raw => { raw.fees.app.amount = '5'; }, 'RELAY_APP_FEE_UNEXPECTED');
    refuse('sol-base', raw => rehash(raw, o => { (o as { fees: unknown[] }).fees = [{ recipientChainId: 'base', recipient: '0x' + '7'.repeat(40), currencyChainId: 'base',
      currency: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '1' }]; }), 'RELAY_ORDER_FEES_UNEXPECTED');
  });
  it('maps Relay refusals to stable codes', () => {
    expect(relayRefusal('Insufficient liquidity for this route')).toBe('RELAY_NO_ROUTE');
    expect(relayRefusal('Amount is too low')).toBe('RELAY_AMOUNT_TOO_LOW');
    expect(() => normalizeRelayQuote({ __httpStatus: 400, __body: { message: 'No routes found' } }, requestOf('sol-base').request)).toThrow('RELAY_NO_ROUTE');
  });
});

describe('Relay status is a hint', () => {
  it('maps the live status shapes', () => {
    expect(normalizeRelayStatus({ status: 'success', inTxHashes: ['0xBBA1d02a894953c42241a7d4aebb84580f0b74f8ef88424c32bb7368328016c7'],
      txHashes: ['0x1a6a791ff66eb365f4d2ec1ec04f866a1cd363f3b0630a66d9d6c3e44b2ca0e0'], failReason: 'N/A' })).toMatchObject({ status: 'FILLED',
      sourceTxHashes: ['0xbba1d02a894953c42241a7d4aebb84580f0b74f8ef88424c32bb7368328016c7'], destinationTxHashes: ['0x1a6a791ff66eb365f4d2ec1ec04f866a1cd363f3b0630a66d9d6c3e44b2ca0e0'],
      refundTxHashes: [], failReason: null });
    expect(normalizeRelayStatus({ status: 'refund', txHashes: ['asu6iZbXnGKdy8tSB5wuH9gix4jBjjWcBz1AQ5t2ksRHPfh9tNtTJt8CQRvFEqisfbkZURJCsFMs12AtjDq5XMn'],
      failReason: 'EXECUTION_REVERTED' })).toMatchObject({ status: 'REFUNDED', destinationTxHashes: [], failReason: 'EXECUTION_REVERTED' });
    expect(normalizeRelayStatus({ status: 'waiting' }).status).toBe('WAITING');
    expect(normalizeRelayStatus({ __httpStatus: 404, __body: {} }).status).toBe('NOT_FOUND');
  });
});
