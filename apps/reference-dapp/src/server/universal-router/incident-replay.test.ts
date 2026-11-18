// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FINOPS-AUTOMATED-SYNC-002 P0: closed replay of the 2026-11-18 Base delivery (Relay FILLED, FloFi stuck at
 * SOURCE_CONFIRMED with UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE). The fixture is derived from public chain data read once; this suite
 * makes no network call. A Relay executor called RelayRouter v3.2, which paid an EIP-7702 recipient by an internal call. Every identifier
 * (recipient, order id, hashes, block) is substituted in the fixture; selector, calldata layout, frames, gas and value are as observed.
 */
import { describe, expect, it } from 'vitest';
import { UNIVERSAL_ROUTER_DEPLOYMENT } from '@defi-workflow-engine/action-registry';
import { failoverReadRpc } from '../bridge-read-rpc.ts';
import type { Rpc } from '../public-testnet-service.ts';
import { verifyEvmCredit } from './evm-chain.ts';
import incident from '../testdata/universal/relay-native-fill-base-2026-11-18.json' with { type: 'json' };

const DELIVERED = 487_592_054_186_956n;
const base = UNIVERSAL_ROUTER_DEPLOYMENT.evm['eip155:8453']!;
type Overrides = { parity?: unknown; call?: unknown; refuse?: readonly string[] };
/** A geth callTracer frame as the tests mutate it. */
type CallFrame = { type: string; from: string; to: string; value: string; input: string; error?: string; calls?: CallFrame[] };
const clone = <T>(value: T): T => structuredClone(value);

function replay(overrides: Overrides = {}): Rpc & { calls: string[] } {
  const calls: string[] = [];
  const rpc = (async (method: string, params: readonly unknown[]) => {
    calls.push(method);
    if (overrides.refuse?.includes(method)) throw Error('PUBLIC_RPC_RESPONSE_INVALID');
    switch (method) {
      case 'eth_chainId': return '0x2105';
      case 'eth_getTransactionReceipt': return params[0] === incident.transaction.hash ? clone(incident.receipt) : null;
      case 'eth_getTransactionByHash': return params[0] === incident.transaction.hash ? clone(incident.transaction) : null;
      case 'eth_getBlockByNumber': return params[0] === incident.block.number ? clone(incident.block) : null;
      case 'eth_getCode': return incident.recipientCode;
      case 'trace_transaction': return 'parity' in overrides ? overrides.parity : clone(incident.parityTrace);
      case 'debug_traceTransaction': return 'call' in overrides ? overrides.call : clone(incident.callTrace);
      default: throw Error('UNEXPECTED_METHOD ' + method);
    }
  }) as Rpc & { calls: string[] };
  rpc.calls = calls;
  return rpc;
}
const check = (rpc: Rpc, overrides: { recipient?: string; minimum?: bigint; orderId?: string; settlement?: boolean } = {}) =>
  verifyEvmCredit(rpc, { hash: incident.transaction.hash, chainId: 8453, recipient: overrides.recipient ?? incident.recipient, token: null,
    minimum: overrides.minimum ?? 1n, orderId: overrides.orderId ?? incident.orderId,
    nativeAuthority: { solver: '0xf70da97812cb96acdf810712aa562db8dfa3dbef', ...overrides.settlement === false ? {} : { settlement: base.relaySettlement } } });

describe('2026-11-18 incident replay: contract-mediated native delivery on Base', () => {
  it('records the verified facts of the incident transaction pair', () => {
    expect(incident.transaction).toMatchObject({ from: '0x6d0a66df5f4a32be3656f63750e0253eb59d9399', to: base.relaySettlement!.router, value: '0x1bb765f2f63cc' });
    expect(incident.transaction.input.startsWith('0xcd6e13f7') && incident.transaction.input.endsWith(incident.orderId.slice(2))).toBe(true);
    // The Arbitrum deposit committed the same order id (RelayDepository.depositNative(depositor, id)).
    expect(incident.source).toMatchObject({ to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', value: '0x1c6bf52634000' });
    expect(incident.source.input).toBe('0x49290c1c' + incident.recipient.slice(2).padStart(64, '0') + incident.orderId.slice(2));
    expect(incident.recipientCode.startsWith('0xef0100')).toBe(true);
  });

  it('the pre-fix rule (no settlement authority for the Relay executor) could never bind the order', async () => {
    expect(await check(replay(), { settlement: false })).toEqual({ ok: false, reason: 'UNBOUND_NATIVE' });
  });

  it('proves the net credit from the Parity trace', async () => {
    const rpc = replay();
    expect(await check(rpc)).toMatchObject({ ok: true, amount: DELIVERED, orderBound: true, blockNumber: Number(incident.block.number), blockHash: incident.block.hash });
    expect(rpc.calls).not.toContain('debug_traceTransaction');
  });

  it('proves the same credit from the geth callTracer when trace_transaction is unavailable', async () => {
    const rpc = replay({ refuse: ['trace_transaction'] });
    expect(await check(rpc)).toMatchObject({ ok: true, amount: DELIVERED, orderBound: true });
    expect(rpc.calls).toContain('debug_traceTransaction');
  });

  it('fails closed when no trace namespace is available (public Base RPC refuses both)', async () => {
    expect(await check(replay({ refuse: ['trace_transaction', 'debug_traceTransaction'] }))).toEqual({ ok: false, reason: 'UNVERIFIABLE_NATIVE' });
  });

  it.each([
    ['a different recipient', { recipient: '0x2222222222222222222222222222222222222222' }, 'NO_CREDIT'],
    ['a minimum above the delivery', { minimum: DELIVERED + 1n }, 'BELOW_MINIMUM'],
    ['a different order', { orderId: '0x' + '11'.repeat(32) }, 'UNBOUND_NATIVE'],
  ] as const)('refuses %s', async (_name, overrides, reason) => {
    expect(await check(replay(), overrides)).toEqual({ ok: false, reason });
  });

  it.each([
    ['a reverted recipient frame', (t: CallFrame) => { t.calls![1]!.error = 'execution reverted'; }, 'NO_CREDIT'],
    ['a root frame of another transaction', (t: CallFrame) => { t.value = '0x1'; }, 'UNVERIFIABLE_NATIVE'],
    ['a forwarded credit', (t: CallFrame) => {
      Object.assign(t.calls![1]!, { calls: [{ type: 'CALL', from: incident.recipient, to: '0x2222222222222222222222222222222222222222', value: '0x1bb765f2f63cc', input: '0x' }] });
    }, 'NO_CREDIT'],
  ])('refuses a callTracer response with %s', async (_name, mutate, reason) => {
    const call = clone(incident.callTrace) as CallFrame;
    mutate(call);
    expect(await check(replay({ refuse: ['trace_transaction'], call }))).toEqual({ ok: false, reason });
  });

  it('a Parity trace bound to another block fails closed instead of falling back to the callTracer', async () => {
    const parity = clone(incident.parityTrace).map(frame => ({ ...frame, blockHash: '0x' + '22'.repeat(32) }));
    const rpc = replay({ parity });
    expect(await check(rpc)).toEqual({ ok: false, reason: 'UNVERIFIABLE_NATIVE' });
    expect(rpc.calls).not.toContain('debug_traceTransaction');
    // An empty Parity answer (method not served) is unavailability, not a contradiction.
    expect(await check(replay({ parity: [] }))).toMatchObject({ ok: true, amount: DELIVERED });
  });

  it('refuses a value-moving callTracer frame without a value', async () => {
    const call = clone(incident.callTrace) as CallFrame;
    delete (call.calls![1] as Partial<CallFrame>).value;
    expect(await check(replay({ refuse: ['trace_transaction'], call }))).toEqual({ ok: false, reason: 'UNVERIFIABLE_NATIVE' });
  });

  it('failover reaches a trace-capable fallback without moving ordinary reads off the primary', async () => {
    const primary = replay({ refuse: ['trace_transaction', 'debug_traceTransaction'] }), fallback = replay();
    const rpc = failoverReadRpc([primary, fallback], 8453);
    expect(await check(rpc)).toMatchObject({ ok: true, amount: DELIVERED });
    expect(fallback.calls.filter(method => !['eth_chainId', 'trace_transaction'].includes(method))).toEqual([]);
  });
});
