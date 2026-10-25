// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeRelayDepositLog, encodeErc20ApproveExact, encodeRelayDepositErc20, encodeRelayDepositLog, encodeRelayDepositNative, relayOrderId,
  relaySolanaDepositInstruction, verifyRelayOrder, RELAY_EVM_DEPOSITORY, RELAY_SOLANA_DEPOSITORY, RELAY_SOLANA_DEPOSITORY_PROGRAM, RELAY_SOLANA_DISCRIMINATORS,
  RELAY_SOLANA_VAULT, SOLANA_TOKEN_PROGRAM_ID, type RelayOrderData, type RelayOrderExpectation } from '../src/universal-relay.js';

/** Live Relay quotes recorded read-only on 2026-10-25 (random addresses, no keys). */
const dir = new URL('../../../apps/reference-dapp/src/server/testdata/universal/', import.meta.url);
type Fixture = { request: Record<string, unknown>; response: { requestId: string; steps: { id: string; items: { data: Record<string, any> }[] }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  protocol: { v2: { orderId: string; orderData: RelayOrderData; paymentDetails: { chainId: string; depository: string; currency: string; amount: string } } };
  details: { currencyOut: { amount: string; minimumAmount: string } } } };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`relay-${name}.json`, dir), 'utf8')) as Fixture;
const NAMES = ['sol-base', 'base-sol', 'rh-sol', 'arb-rh-eth', 'eth-sol-native', 'arb-sol', 'sol-arb-native'] as const;
const vmOf = (slug: string) => slug === 'solana' ? 'solana-vm' as const : 'ethereum-vm' as const;
const step = (f: Fixture, id: string) => f.response.steps.find(s => s.id === id)?.items[0]!.data;
const expectation = (f: Fixture, patch: Partial<RelayOrderExpectation> = {}): RelayOrderExpectation => {
  const o = f.response.protocol.v2.orderData, input = o.inputs[0]!, payment = o.output.payments[0]!;
  return { orderId: f.response.protocol.v2.orderId, sourceSlug: input.payment.chainId, destinationSlug: o.output.chainId, inputCurrency: input.payment.currency,
    outputCurrency: payment.currency, amount: input.payment.amount, owner: String(f.request.user), recipient: String(f.request.recipient), slippageBps: 200,
    nowSeconds: o.output.deadline - 7 * 86_400 + 60, vmOf, ...patch };
};
/** A tampered order with a correct hash: proves every field check holds on its own, not only through the hash. */
const rehash = (f: Fixture, change: (o: RelayOrderData) => RelayOrderData) => {
  const orderData = change(structuredClone(f.response.protocol.v2.orderData));
  return { orderData, orderId: relayOrderId(orderData, vmOf) };
};

describe('Relay order hash (EIP-712 hashStruct, settlement-sdk getOrderId)', () => {
  it.each(NAMES)('reproduces the live orderId of %s', name => {
    const f = fixture(name);
    expect(relayOrderId(f.response.protocol.v2.orderData, vmOf)).toBe(f.response.protocol.v2.orderId);
  });
  it('any changed field changes the order id; unknown fields are refused', () => {
    const f = fixture('sol-base'), o = f.response.protocol.v2.orderData;
    expect(relayOrderId({ ...o, output: { ...o.output, payments: [{ ...o.output.payments[0]!, minimumAmount: '1' }] } }, vmOf)).not.toBe(f.response.protocol.v2.orderId);
    expect(() => relayOrderId({ ...o, extra: 1 } as unknown as RelayOrderData, vmOf)).toThrow('RELAY_ORDER_SHAPE_UNSUPPORTED');
  });
});

describe('Relay deposits are rebuilt byte for byte', () => {
  it('EVM token deposits: approval of exactly the amount to the Depository, then depositErc20(owner, token, amount, orderId)', () => {
    for (const name of ['base-sol', 'rh-sol', 'eth-sol-native', 'arb-sol'] as const) {
      const f = fixture(name), v2 = f.response.protocol.v2, owner = String(f.request.user).toLowerCase();
      const approve = step(f, 'approve')!, deposit = step(f, 'deposit')!;
      expect(v2.paymentDetails.depository).toBe(RELAY_EVM_DEPOSITORY);
      expect(approve.data).toBe(encodeErc20ApproveExact(RELAY_EVM_DEPOSITORY, BigInt(v2.paymentDetails.amount)));
      expect(approve.to).toBe(v2.paymentDetails.currency);
      expect(deposit.to).toBe(RELAY_EVM_DEPOSITORY);
      expect(deposit.value).toBe('0');
      expect(deposit.data).toBe(encodeRelayDepositErc20(owner, v2.paymentDetails.currency, BigInt(v2.paymentDetails.amount), v2.orderId));
    }
  });
  it('EVM native deposit: depositNative(owner, orderId) carrying exactly the amount', () => {
    const f = fixture('arb-rh-eth'), v2 = f.response.protocol.v2, deposit = step(f, 'deposit')!;
    expect(f.response.steps.map(s => s.id)).toEqual(['deposit']);
    expect(deposit.to).toBe(RELAY_EVM_DEPOSITORY);
    expect(deposit.value).toBe(v2.paymentDetails.amount);
    expect(deposit.data).toBe(encodeRelayDepositNative(String(f.request.user).toLowerCase(), v2.orderId));
  });
  it('Solana deposits: every account derived by FloFi; discriminator, amount and order id in the data', () => {
    expect(RELAY_SOLANA_DEPOSITORY).toBe('Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc');
    expect(RELAY_SOLANA_VAULT).toBe('7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ');
    expect(RELAY_SOLANA_DISCRIMINATORS).toEqual({ depositToken: '0b9c60da27a3b413', depositNative: '0d9e0ddf5fd51c06' });
    for (const [name, mint] of [['sol-base', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'], ['sol-arb-native', null]] as const) {
      const f = fixture(name), v2 = f.response.protocol.v2, provided = step(f, 'deposit')!.instructions as { programId: string; keys: unknown[]; data: string }[];
      expect(provided).toHaveLength(1);
      const built = relaySolanaDepositInstruction({ owner: String(f.request.user), mint, tokenProgram: mint ? SOLANA_TOKEN_PROGRAM_ID : null,
        amount: BigInt(v2.paymentDetails.amount), orderId: v2.orderId });
      expect(provided[0]!.programId).toBe(RELAY_SOLANA_DEPOSITORY_PROGRAM);
      expect(built.programId).toBe(RELAY_SOLANA_DEPOSITORY_PROGRAM);
      expect(built.accounts).toEqual(provided[0]!.keys);
      expect(Buffer.from(built.data).toString('hex')).toBe(provided[0]!.data);
    }
  });
  it('deposit events decode and round-trip; a real Robinhood Chain native deposit log decodes to its order id', () => {
    const real = { address: RELAY_EVM_DEPOSITORY, topics: ['0x8032066556caf3967d8fec4ad22a2d9e1e9576556b2903a0fcd5b1fd201e3477'],
      data: '0x000000000000000000000000aeab7faf78269e23319fbb84bba689693436c0930000000000000000000000000000000000000000000000000054e8ec6221c00068a7d2b9b309f0b458e10f2448d0cba83a7df144cfbf9b323db7d8c9bca23832' };
    expect(decodeRelayDepositLog(real)).toEqual({ kind: 'NATIVE', from: '0xaeab7faf78269e23319fbb84bba689693436c093', token: null, amount: 23_900_000_000_000_000n,
      id: '0x68a7d2b9b309f0b458e10f2448d0cba83a7df144cfbf9b323db7d8c9bca23832' });
    const event = { kind: 'ERC20' as const, from: '0x' + '1'.repeat(40), token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: 20_000_000n, id: '0x' + 'ab'.repeat(32) };
    expect(decodeRelayDepositLog(encodeRelayDepositLog(event))).toEqual(event);
    expect(decodeRelayDepositLog({ ...encodeRelayDepositLog(event), address: '0x' + '2'.repeat(40) })).toBeNull();
  });
});

describe('Relay order verification', () => {
  it.each(NAMES)('accepts the live %s order against its own intent', name => {
    const f = fixture(name), verified = verifyRelayOrder(f.response.protocol.v2.orderData, expectation(f));
    expect(verified.minimumOutput).toBe(f.response.details.currencyOut.minimumAmount);
    expect(verified.expectedOutput).toBe(f.response.protocol.v2.orderData.output.payments[0]!.expectedAmount);
  });
  it('refuses a wrong recipient, currency, amount, chain or refund target even under a matching hash', () => {
    const f = fixture('base-sol'), other = 'G5na5MqdhnEdMkgkN5RhUnwqGe8sYAuJpUhXWAFxsDFm';
    expect(() => verifyRelayOrder(f.response.protocol.v2.orderData, expectation(f, { recipient: 'HjcWJor6kDs1WtUp9CqaxiC3pq3pZyToQU7rPU5kbbqi' }))).toThrow('RELAY_ORDER_RECIPIENT_MISMATCH');
    expect(() => verifyRelayOrder(f.response.protocol.v2.orderData, expectation(f, { orderId: '0x' + '00'.repeat(32) }))).toThrow('RELAY_ORDER_ID_MISMATCH');
    expect(() => verifyRelayOrder(f.response.protocol.v2.orderData, expectation(f, { amount: '19999999' }))).toThrow('RELAY_ORDER_INPUT_MISMATCH');
    expect(() => verifyRelayOrder(f.response.protocol.v2.orderData, expectation(f, { outputCurrency: '11111111111111111111111111111111' }))).toThrow('RELAY_ORDER_OUTPUT_CURRENCY_MISMATCH');
    expect(() => verifyRelayOrder(f.response.protocol.v2.orderData, expectation(f, { destinationSlug: 'base' }))).toThrow();
    const refund = rehash(f, o => ({ ...o, inputs: [{ ...o.inputs[0]!, refunds: [{ ...o.inputs[0]!.refunds[0]!, recipient: '0x' + '9'.repeat(40) }] }] }));
    expect(() => verifyRelayOrder(refund.orderData, expectation(f, { orderId: refund.orderId }))).toThrow('RELAY_ORDER_REFUND_RECIPIENT_UNEXPECTED');
    expect(other).toBe(f.response.protocol.v2.orderData.output.payments[0]!.recipient);
  });
  it('refuses order fees, destination calls, a minimum outside the slippage bound and a past deadline', () => {
    const f = fixture('sol-base');
    const fees = rehash(f, o => ({ ...o, fees: [{ recipientChainId: 'base', recipient: '0x' + '7'.repeat(40), currencyChainId: 'base', currency: o.output.payments[0]!.currency, amount: '1' }] }));
    expect(() => verifyRelayOrder(fees.orderData, expectation(f, { orderId: fees.orderId }))).toThrow('RELAY_ORDER_FEES_UNEXPECTED');
    const calls = rehash(f, o => ({ ...o, output: { ...o.output, calls: ['0x1234'] } }));
    expect(() => verifyRelayOrder(calls.orderData, expectation(f, { orderId: calls.orderId }))).toThrow('RELAY_ORDER_DESTINATION_CALLS_UNSUPPORTED');
    // extraData is only Relay's `(address fillContract)` on EVM chains, and empty on Solana; anything else is refused.
    const extra = rehash(f, o => ({ ...o, output: { ...o.output, extraData: o.output.extraData + 'ff' } }));
    expect(() => verifyRelayOrder(extra.orderData, expectation(f, { orderId: extra.orderId }))).toThrow('RELAY_ORDER_EXTRA_DATA_UNEXPECTED');
    const solanaRefund = rehash(f, o => ({ ...o, inputs: [{ ...o.inputs[0]!, refunds: o.inputs[0]!.refunds.map(r => r.chainId === 'solana' ? { ...r, extraData: '0x' + '0'.repeat(24) + '1'.repeat(40) } : r) }] }));
    expect(() => verifyRelayOrder(solanaRefund.orderData, expectation(f, { orderId: solanaRefund.orderId }))).toThrow('RELAY_ORDER_EXTRA_DATA_UNEXPECTED');
    expect(() => verifyRelayOrder(f.response.protocol.v2.orderData, expectation(f, { slippageBps: 50 }))).toThrow('RELAY_ORDER_MINIMUM_BELOW_SLIPPAGE');
    const deadline = f.response.protocol.v2.orderData.output.deadline;
    expect(() => verifyRelayOrder(f.response.protocol.v2.orderData, expectation(f, { nowSeconds: deadline - 60 }))).toThrow('RELAY_ORDER_DEADLINE_INVALID');
  });
});
