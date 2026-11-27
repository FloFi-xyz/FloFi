// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: the canonical Batch Payment node. The ordered manifest is its closed declaration (so the semantic hash
 * binds every recipient, amount, the order, the asset and the chain); amounts are exact integers; a recipient is never paid twice, merged or dropped.
 */
import { describe, expect, it } from 'vitest';
import { BATCH_PAYMENT_ACTION, BATCH_PAYMENT_MAX_RECIPIENTS, batchPaymentTotal, createBatchPaymentNode, readBatchPaymentNode, type BatchPaymentFields } from '../src/batch-payment.js';
import { hashArtifactValue } from '../src/canonical.js';
import { validateArtifact } from '../src/schemas.js';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
const USDC = { kind: 'TOKEN' as const, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, officialId: null };
const fields: BatchPaymentFields = { chain: 'eip155:8453', asset: USDC, payments: [{ recipient: A, amount: '25000000' }, { recipient: B, amount: '50000000' }, { recipient: C, amount: '75000000' }] };
const workflow = (node: ReturnType<typeof createBatchPaymentNode>) => ({ schemaVersion: '1.0.0', workflowId: 'w', revision: 1, nodes: [node], resourceEdges: [] });
const hash = (f: BatchPaymentFields) => hashArtifactValue('semantic-workflow', workflow(createBatchPaymentNode('node-002', f)));

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 Batch Payment node', () => {
  it('declares every payment, the exact integer total as its maximum input, and reads back exactly', () => {
    const node = createBatchPaymentNode('node-002', fields);
    expect(node).toMatchObject({ actionType: BATCH_PAYMENT_ACTION, chainId: 'eip155:8453', requiredAuthorizationClass: 'MODE_A', failurePolicy: 'ABORT',
      adapterConstraints: { adapters: [{ id: 'evm.batch-payment', version: '1.0.0' }], protocols: ['erc20'] },
      userConstraints: [{ kind: 'MAXIMUM_INPUT', quantity: { asset: { chainId: 'eip155:8453', address: USDC.address, decimals: 6 }, amount: '150000000' } }] });
    expect(readBatchPaymentNode(node)).toEqual(fields);
    expect(() => validateArtifact('semantic-workflow', workflow(node))).not.toThrow();
    const native = createBatchPaymentNode('n', { ...fields, asset: { kind: 'NATIVE' } });
    expect(native.adapterConstraints.protocols).toEqual(['native']);
    expect(readBatchPaymentNode(native).asset).toEqual({ kind: 'NATIVE' });
  });

  it('binds the whole ordered manifest: any recipient, amount, order, asset or chain change is another hash', () => {
    const base = hash(fields);
    const [a, b, c] = fields.payments as [BatchPaymentFields['payments'][number], BatchPaymentFields['payments'][number], BatchPaymentFields['payments'][number]];
    for (const changed of [{ ...fields, payments: [b, a, c] }, { ...fields, payments: [a, b, { ...c, amount: '75000001' }] }, { ...fields, payments: [a, b, { ...c, recipient: '0x' + 'd'.repeat(40) }] },
      { ...fields, payments: [a, b] }, { ...fields, asset: { kind: 'NATIVE' as const } }, { ...fields, chain: 'eip155:42161' }])
      expect(hash(changed)).not.toBe(base);
    expect(hash({ ...fields })).toBe(base);
  });

  it('totals exactly in integer units, beyond any float precision', () => {
    const big = '123456789012345678901234567890';
    expect(batchPaymentTotal([{ recipient: A, amount: big }, { recipient: B, amount: '1' }])).toBe(BigInt(big) + 1n);
    expect(() => batchPaymentTotal([{ recipient: A, amount: (2n ** 256n - 1n).toString() }, { recipient: B, amount: '1' }])).toThrow('BATCH_PAYMENT_TOTAL_OUT_OF_RANGE');
  });

  it('refuses a duplicate recipient (never merged), a zero or malformed address, a zero amount and an out-of-range count', () => {
    expect(() => createBatchPaymentNode('n', { ...fields, payments: [{ recipient: A, amount: '1' }, { recipient: A, amount: '2' }] })).toThrow('BATCH_PAYMENT_DUPLICATE_RECIPIENT');
    expect(() => createBatchPaymentNode('n', { ...fields, payments: [{ recipient: '0x' + '0'.repeat(40), amount: '1' }, { recipient: B, amount: '2' }] })).toThrow('BATCH_PAYMENT_RECIPIENT_INVALID');
    expect(() => createBatchPaymentNode('n', { ...fields, payments: [{ recipient: '0x' + 'A'.repeat(40), amount: '1' }, { recipient: B, amount: '2' }] })).toThrow('BATCH_PAYMENT_RECIPIENT_INVALID');
    // DEV-BP-5: the precompile range 0x…01..0x…ff is never a payee (nobody holds its key); the first address past it is an ordinary recipient.
    for (const reserved of ['01', '02', '09', '0a', '7f', 'ff'])
      expect(() => createBatchPaymentNode('n', { ...fields, payments: [{ recipient: '0x' + '0'.repeat(38) + reserved, amount: '1' }, { recipient: B, amount: '2' }] }), reserved)
        .toThrow('BATCH_PAYMENT_RECIPIENT_INVALID');
    expect(() => createBatchPaymentNode('n', { ...fields, payments: [{ recipient: '0x' + '0'.repeat(37) + '100', amount: '1' }, { recipient: B, amount: '2' }] })).not.toThrow();
    for (const amount of ['0', '01', '1.5', '-1', ''])
      expect(() => createBatchPaymentNode('n', { ...fields, payments: [{ recipient: A, amount }, { recipient: B, amount: '2' }] }), amount).toThrow('BATCH_PAYMENT_AMOUNT_INVALID');
    expect(() => createBatchPaymentNode('n', { ...fields, payments: [{ recipient: A, amount: '1' }] })).toThrow('BATCH_PAYMENT_TOO_FEW_RECIPIENTS');
    // Distinct ordinary addresses (0x0101…01, 0x0202…02, …): the earlier fixture 0x…01..0x…09 is the precompile range, now refused as a recipient.
    const many = Array.from({ length: BATCH_PAYMENT_MAX_RECIPIENTS + 1 }, (_, i) => ({ recipient: '0x' + (i + 1).toString(16).padStart(2, '0').repeat(20), amount: '1' }));
    expect(() => createBatchPaymentNode('n', { ...fields, payments: many })).toThrow('BATCH_PAYMENT_TOO_MANY_RECIPIENTS');
    expect(() => createBatchPaymentNode('n', { ...fields, payments: many.slice(0, BATCH_PAYMENT_MAX_RECIPIENTS) })).not.toThrow();
    expect(() => createBatchPaymentNode('n', { ...fields, chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' })).toThrow('BATCH_PAYMENT_FIELDS_INVALID');
    // An official id names an issuer-registered asset (a Robinhood Chain Stock Token): never carried by a Batch Payment, whichever channel wrote the IR.
    expect(() => createBatchPaymentNode('n', { ...fields, chain: 'eip155:4663', asset: { ...USDC, decimals: 18, officialId: '0x' + 'ab'.repeat(32) } })).toThrow('BATCH_PAYMENT_ASSET_UNSUPPORTED');
  });

  it('refuses any declaration beyond its own: a hidden extra payment, a mixed asset, a lock, a dependency or another authorization class', () => {
    const node = createBatchPaymentNode('n', fields);
    const hidden = { ...node, inputs: [...node.inputs, { name: 'payment-04-recipient', kind: 'ACCOUNT' as const, value: { chainId: 'eip155:8453', address: '0x' + 'e'.repeat(40) } },
      { name: 'payment-04-amount', kind: 'QUANTITY' as const, value: { asset: { chainId: 'eip155:8453', address: USDC.address, decimals: 6 }, amount: '1' } }] };
    // A hidden payment changes the total the node declares: the closed declaration no longer reproduces.
    expect(() => readBatchPaymentNode(hidden)).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    const mixed = { ...node, inputs: node.inputs.map(p => p.name === 'payment-02-amount' ? { ...p, value: { asset: { chainId: 'eip155:8453', nativeId: 'ETH', decimals: 18 }, amount: '1' } } as typeof p : p) };
    expect(() => readBatchPaymentNode(mixed)).toThrow('BATCH_PAYMENT_ASSET_MIXED');
    expect(() => readBatchPaymentNode({ ...node, lockedParameters: [{ name: 'payment-01-amount' } as never] })).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    expect(() => readBatchPaymentNode({ ...node, dependencies: ['x'] })).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    expect(() => readBatchPaymentNode({ ...node, requiredAuthorizationClass: 'NONE' })).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    expect(() => readBatchPaymentNode({ ...node, userConstraints: [] })).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
  });
});
