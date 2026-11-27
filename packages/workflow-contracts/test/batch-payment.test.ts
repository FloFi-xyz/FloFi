// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: the canonical Batch Payment node. The ordered manifest is its closed declaration (so the semantic hash
 * binds every recipient, amount, the order, the asset and the chain); amounts are exact integers; a recipient is never paid twice, merged or dropped.
 */
import { describe, expect, it } from 'vitest';
import { BATCH_PAYMENT_ACTION, BATCH_PAYMENT_MAX_RECIPIENTS, BATCH_PAYMENT_SOLANA_ADAPTER, SOLANA_BATCH_PAYMENT_RESERVED_RECIPIENTS, batchPaymentTotal, createBatchPaymentNode,
  createSolanaBatchPaymentNode, isBatchPaymentNode, isSolanaBatchPaymentNode, readAnyBatchPaymentNode, readBatchPaymentNode, readSolanaBatchPaymentNode, solanaBatchPaymentTotal,
  type BatchPaymentFields, type SolanaBatchPaymentFields } from '../src/batch-payment.js';
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

  it('KAN-20 EVM invariance: the canonical EVM node hashes are pinned to the values computed from the build before the Solana family existed', () => {
    // Computed from the untouched build (a7b4519 over fed320e) before any Solana batch code was added: any change to the EVM node bytes fails here.
    expect(hash(fields)).toBe('0x07660e181e2d0d8f9ce8e37aad4cab736a5a7101589f86aa73f73076e88e517d');
    expect(hash({ ...fields, asset: { kind: 'NATIVE' } })).toBe('0xa070eb8b8672e24c8434ed6a2b01d3734d4926087355f030293c22c371d75530');
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
    // DEV-BP-5 (widened in the final security review to 0x…fff, which holds P256VERIFY at 0x…0100): the reserved range is never a payee (nobody holds its
    // key); the first address past it is an ordinary recipient.
    for (const reserved of ['01', '02', '09', '0a', '7f', 'ff'])
      expect(() => createBatchPaymentNode('n', { ...fields, payments: [{ recipient: '0x' + '0'.repeat(38) + reserved, amount: '1' }, { recipient: B, amount: '2' }] }), reserved)
        .toThrow('BATCH_PAYMENT_RECIPIENT_INVALID');
    expect(() => createBatchPaymentNode('n', { ...fields, payments: [{ recipient: '0x' + '0'.repeat(36) + '1000', amount: '1' }, { recipient: B, amount: '2' }] })).not.toThrow();
    for (const amount of ['0', '01', '1.5', '-1', ''])
      expect(() => createBatchPaymentNode('n', { ...fields, payments: [{ recipient: A, amount }, { recipient: B, amount: '2' }] }), amount).toThrow('BATCH_PAYMENT_AMOUNT_INVALID');
    expect(() => createBatchPaymentNode('n', { ...fields, payments: [{ recipient: A, amount: '1' }] })).toThrow('BATCH_PAYMENT_TOO_FEW_RECIPIENTS');
    // Distinct ordinary addresses (0x0101…01, 0x0202…02, …): the earlier fixture 0x…01..0x…09 is the precompile range, now refused as a recipient.
    const many = Array.from({ length: BATCH_PAYMENT_MAX_RECIPIENTS + 1 }, (_, i) => ({ recipient: '0x' + (i + 1).toString(16).padStart(2, '0').repeat(20), amount: '1' }));
    expect(() => createBatchPaymentNode('n', { ...fields, payments: many })).toThrow('BATCH_PAYMENT_TOO_MANY_RECIPIENTS');
    expect(() => createBatchPaymentNode('n', { ...fields, payments: many.slice(0, BATCH_PAYMENT_MAX_RECIPIENTS) })).not.toThrow();
    expect(() => createBatchPaymentNode('n', { ...fields, chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' })).toThrow('BATCH_PAYMENT_FIELDS_INVALID');
    // The reserved system range 0x…000–0x…fff holds precompiles (P256VERIFY at 0x…0100): nobody holds a key there, so funds would be lost.
    for (const reserved of ['0x' + '0'.repeat(38) + '02', '0x' + '0'.repeat(37) + '100', '0x' + '0'.repeat(37) + 'fff'])
      expect(() => createBatchPaymentNode('n', { ...fields, payments: [{ recipient: reserved, amount: '1' }, { recipient: B, amount: '2' }] }), reserved).toThrow('BATCH_PAYMENT_RECIPIENT_INVALID');
    expect(() => createBatchPaymentNode('n', { ...fields, payments: [{ recipient: '0x' + '0'.repeat(36) + '1000', amount: '1' }, { recipient: B, amount: '2' }] })).not.toThrow();
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

describe('KAN-20 Solana Batch Payment node (parallel family; the EVM node above is unchanged)', () => {
  const CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  // Shape-valid base58 keys (the compiler decodes and curve-checks them; the contracts check shape, reserved keys and duplicates only).
  const R1 = '7cVfgArCheMR6Cs4t6vz5rfnqd56vZq4ndaBrY5xkxXy', R2 = 'GdnSyH3YtwcxFvQrVVJMm1JhTS4QVX7MFsX56uJLUfiZ', R3 = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const SPL: SolanaBatchPaymentFields = { chain: CHAIN, asset: { kind: 'SPL_TOKEN', mint: USDC_MINT, decimals: 6, program: 'spl-token' },
    payments: [{ recipient: R1, amount: '1000000' }, { recipient: R2, amount: '2500000' }, { recipient: R3, amount: '1' }] };
  const SOL: SolanaBatchPaymentFields = { chain: CHAIN, asset: { kind: 'NATIVE' }, payments: [{ recipient: R1, amount: '10000000' }, { recipient: R2, amount: '20000000' }] };
  const solHash = (f: SolanaBatchPaymentFields) => hashArtifactValue('semantic-workflow', workflow(createSolanaBatchPaymentNode('node-002', f)));
  const withPayments = (f: SolanaBatchPaymentFields, payments: SolanaBatchPaymentFields['payments']) => ({ ...f, payments });

  it('declares every payment, the token program and the exact total, and reads back exactly (SOL and USDC)', () => {
    const node = createSolanaBatchPaymentNode('node-002', SPL);
    expect(node).toMatchObject({ actionType: BATCH_PAYMENT_ACTION, chainId: CHAIN, requiredCapabilities: [BATCH_PAYMENT_SOLANA_ADAPTER], requiredAuthorizationClass: 'MODE_A',
      failurePolicy: 'ABORT', adapterConstraints: { adapters: [{ id: 'solana.batch-payment', version: '1.0.0' }], protocols: ['spl-token'] },
      userConstraints: [{ kind: 'MAXIMUM_INPUT', quantity: { asset: { chainId: CHAIN, address: USDC_MINT, decimals: 6 }, amount: '3500001' } }] });
    expect(node.inputs.map(p => p.name)).toEqual(['payment-01-recipient', 'payment-01-amount', 'payment-02-recipient', 'payment-02-amount', 'payment-03-recipient',
      'payment-03-amount', 'token-program']);
    expect(node.inputs.at(-1)).toEqual({ name: 'token-program', kind: 'IDENTIFIER', value: 'spl-token' });
    expect(isSolanaBatchPaymentNode(node)).toBe(true);
    expect(isBatchPaymentNode(node)).toBe(true);
    expect(readSolanaBatchPaymentNode(node)).toEqual(SPL);
    expect(readAnyBatchPaymentNode(node)).toEqual({ family: 'SOLANA', ...SPL });
    expect(() => validateArtifact('semantic-workflow', workflow(node))).not.toThrow();
    const native = createSolanaBatchPaymentNode('node-002', SOL);
    expect(native.adapterConstraints.protocols).toEqual(['native']);
    expect(native.inputs.some(p => p.name === 'token-program')).toBe(false);
    expect(native.userConstraints[0]).toEqual({ kind: 'MAXIMUM_INPUT', quantity: { asset: { chainId: CHAIN, nativeId: 'SOL', decimals: 9 }, amount: '30000000' } });
    expect(readSolanaBatchPaymentNode(native)).toEqual(SOL);
    expect(() => validateArtifact('semantic-workflow', workflow(native))).not.toThrow();
    // The EVM family is untouched: its node is not a Solana batch and still reads through its own reader.
    const evm = createBatchPaymentNode('node-002', fields);
    expect(isSolanaBatchPaymentNode(evm)).toBe(false);
    expect(readAnyBatchPaymentNode(evm)).toEqual({ family: 'EVM', ...readBatchPaymentNode(evm) });
  });

  it('binds the whole ordered manifest: order, recipient, amount, asset and program change the hash', () => {
    const base = solHash(SPL);
    const [a, b, c] = SPL.payments as [BatchPaymentFields['payments'][number], BatchPaymentFields['payments'][number], BatchPaymentFields['payments'][number]];
    for (const changed of [withPayments(SPL, [b, a, c]), withPayments(SPL, [a, b, { ...c, amount: '2' }]), withPayments(SPL, [a, b]),
      { ...SPL, asset: { kind: 'SPL_TOKEN' as const, mint: USDC_MINT, decimals: 6, program: 'token-2022' as const } }, { ...SPL, asset: { kind: 'NATIVE' as const } },
      withPayments(SPL, [a, b, { ...c, recipient: '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T' }])])
      expect(solHash(changed)).not.toBe(base);
    expect(solHash({ ...SPL })).toBe(base);
  });

  it('refuses every reserved address, the mint itself, a non-base58 key and an exact duplicate; case variants are distinct keys', () => {
    expect(SOLANA_BATCH_PAYMENT_RESERVED_RECIPIENTS).toHaveLength(39);
    expect(new Set(SOLANA_BATCH_PAYMENT_RESERVED_RECIPIENTS).size).toBe(39);
    for (const reserved of SOLANA_BATCH_PAYMENT_RESERVED_RECIPIENTS)
      expect(() => createSolanaBatchPaymentNode('n', withPayments(SPL, [{ recipient: reserved, amount: '1' }, { recipient: R2, amount: '1' }])), reserved).toThrow('BATCH_PAYMENT_RECIPIENT_INVALID');
    expect(() => createSolanaBatchPaymentNode('n', withPayments(SPL, [{ recipient: USDC_MINT, amount: '1' }, { recipient: R2, amount: '1' }]))).toThrow('BATCH_PAYMENT_RECIPIENT_INVALID');
    for (const bad of ['0x' + 'a'.repeat(40), R1.slice(0, 31), R1 + 'A', R1.replace('7', '0'), R1.replace('7', 'l'), ` ${R1}`, `${R1} `, ''])
      expect(() => createSolanaBatchPaymentNode('n', withPayments(SPL, [{ recipient: bad, amount: '1' }, { recipient: R2, amount: '1' }])), bad).toThrow('BATCH_PAYMENT_RECIPIENT_INVALID');
    expect(() => createSolanaBatchPaymentNode('n', withPayments(SPL, [{ recipient: R1, amount: '1' }, { recipient: R1, amount: '2' }]))).toThrow('BATCH_PAYMENT_DUPLICATE_RECIPIENT');
    // Base58 is case-sensitive: these two spellings are two different keys, both accepted and kept verbatim (never lower-cased).
    const upper = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', lower = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const cased = createSolanaBatchPaymentNode('n', withPayments(SPL, [{ recipient: upper, amount: '1' }, { recipient: lower, amount: '2' }]));
    expect(readSolanaBatchPaymentNode(cased).payments.map(p => p.recipient)).toEqual([upper, lower]);
  });

  it('refuses amounts outside u64, a total that overflows u64, an out-of-range count and wrapped SOL', () => {
    const max = (2n ** 64n - 1n).toString();
    expect(solanaBatchPaymentTotal([{ recipient: R1, amount: max }])).toBe(2n ** 64n - 1n);
    for (const amount of ['0', '01', '1.5', '-1', '', (2n ** 64n).toString(), '1'.repeat(21)])
      expect(() => createSolanaBatchPaymentNode('n', withPayments(SOL, [{ recipient: R1, amount }, { recipient: R2, amount: '1' }])), amount).toThrow('BATCH_PAYMENT_AMOUNT_INVALID');
    expect(() => createSolanaBatchPaymentNode('n', withPayments(SOL, [{ recipient: R1, amount: max }, { recipient: R2, amount: '1' }]))).toThrow('BATCH_PAYMENT_TOTAL_OUT_OF_RANGE');
    expect(() => solanaBatchPaymentTotal([{ recipient: R1, amount: max }, { recipient: R2, amount: '1' }])).toThrow('BATCH_PAYMENT_TOTAL_OUT_OF_RANGE');
    expect(createSolanaBatchPaymentNode('n', withPayments(SOL, [{ recipient: R1, amount: (2n ** 64n - 2n).toString() }, { recipient: R2, amount: '1' }])).userConstraints[0]!.quantity.amount).toBe(max);
    expect(() => createSolanaBatchPaymentNode('n', withPayments(SOL, [{ recipient: R1, amount: '1' }]))).toThrow('BATCH_PAYMENT_TOO_FEW_RECIPIENTS');
    const keys = ['4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', R1, R2, R3, 'CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq', 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
      'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy', 'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH', '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'];
    const many = keys.map(recipient => ({ recipient, amount: '1' }));
    expect(() => createSolanaBatchPaymentNode('n', withPayments(SOL, many))).toThrow('BATCH_PAYMENT_TOO_MANY_RECIPIENTS');
    expect(() => createSolanaBatchPaymentNode('n', withPayments(SOL, many.slice(0, BATCH_PAYMENT_MAX_RECIPIENTS)))).not.toThrow();
    for (const mint of ['So11111111111111111111111111111111111111112', '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP'])
      expect(() => createSolanaBatchPaymentNode('n', { ...SPL, asset: { kind: 'SPL_TOKEN', mint, decimals: 9, program: 'spl-token' } }), mint).toThrow('BATCH_PAYMENT_ASSET_UNSUPPORTED');
  });

  it('refuses the other family: an EVM asset or chain on the Solana node and a Solana asset on the EVM node', () => {
    expect(() => createSolanaBatchPaymentNode('n', { ...SPL, asset: USDC as never })).toThrow('BATCH_PAYMENT_FIELDS_INVALID');
    expect(() => createSolanaBatchPaymentNode('n', { ...SPL, chain: 'eip155:8453' })).toThrow('BATCH_PAYMENT_FIELDS_INVALID');
    expect(() => createSolanaBatchPaymentNode('n', { ...SPL, chain: 'solana:devnet' })).toThrow('BATCH_PAYMENT_FIELDS_INVALID');
    expect(() => createBatchPaymentNode('n', { ...fields, asset: SPL.asset as never })).toThrow('BATCH_PAYMENT_FIELDS_INVALID');
    for (const asset of [{ ...SPL.asset, decimals: 19 }, { ...SPL.asset, decimals: -1 }, { ...SPL.asset, program: 'erc20' }, { ...SPL.asset, mint: '0x' + 'a'.repeat(40) }])
      expect(() => createSolanaBatchPaymentNode('n', { ...SPL, asset: asset as never }), JSON.stringify(asset)).toThrow('BATCH_PAYMENT_FIELDS_INVALID');
    // An EVM adapter on a Solana chain, and the Solana adapter on an EVM chain, are not a Solana batch declaration.
    const solana = createSolanaBatchPaymentNode('n', SOL), evm = createBatchPaymentNode('n', fields);
    const evmAdapter = { ...solana, requiredCapabilities: ['evm.batch-payment'], adapterConstraints: { adapters: [{ id: 'evm.batch-payment', version: '1.0.0' }], protocols: ['native'] } };
    expect(() => readSolanaBatchPaymentNode(evmAdapter)).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    expect(() => readAnyBatchPaymentNode(evmAdapter)).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    expect(() => readBatchPaymentNode(evmAdapter)).toThrow(/^BATCH_PAYMENT_/);
    const solanaAdapter = { ...evm, requiredCapabilities: ['solana.batch-payment'], adapterConstraints: { adapters: [{ id: 'solana.batch-payment', version: '1.0.0' }], protocols: ['erc20'] } };
    expect(() => readSolanaBatchPaymentNode(solanaAdapter)).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    expect(() => readAnyBatchPaymentNode(solanaAdapter)).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    expect(() => readSolanaBatchPaymentNode({ ...solana, adapterConstraints: { ...solana.adapterConstraints, adapters: [...solana.adapterConstraints.adapters, { id: 'x', version: '1.0.0' }] } }))
      .toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
  });

  it('refuses any declaration beyond its own: token-program missing or extra, a 9th slot, a mixed asset, locks, dependencies, constraints', () => {
    const spl = createSolanaBatchPaymentNode('n', SPL), sol = createSolanaBatchPaymentNode('n', SOL);
    expect(() => readSolanaBatchPaymentNode({ ...spl, inputs: spl.inputs.filter(p => p.name !== 'token-program') })).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    expect(() => readSolanaBatchPaymentNode({ ...spl, inputs: spl.inputs.map(p => p.name === 'token-program' ? { ...p, value: 'erc20' } as typeof p : p) })).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    expect(() => readSolanaBatchPaymentNode({ ...sol, inputs: [...sol.inputs, { name: 'token-program', kind: 'IDENTIFIER' as const, value: 'spl-token' }] })).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    const eight = createSolanaBatchPaymentNode('n', withPayments(SOL, ['4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', R1, R2, R3, 'CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq',
      'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH', 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy', 'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH'].map(recipient => ({ recipient, amount: '1' }))));
    const ninth = { ...eight, inputs: [...eight.inputs, { name: 'payment-09-recipient', kind: 'ACCOUNT' as const, value: { chainId: CHAIN, address: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1' } },
      { name: 'payment-09-amount', kind: 'QUANTITY' as const, value: { asset: { chainId: CHAIN, nativeId: 'SOL', decimals: 9 }, amount: '1' } }] };
    expect(() => readSolanaBatchPaymentNode(ninth)).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    const mixed = { ...spl, inputs: spl.inputs.map(p => p.name === 'payment-02-amount' ? { ...p, value: { asset: { chainId: CHAIN, nativeId: 'SOL', decimals: 9 }, amount: '1' } } as typeof p : p) };
    expect(() => readSolanaBatchPaymentNode(mixed)).toThrow('BATCH_PAYMENT_ASSET_MIXED');
    expect(() => readSolanaBatchPaymentNode({ ...sol, inputs: sol.inputs.map(p => p.name === 'payment-01-recipient' ? { ...p, value: { chainId: 'eip155:1', address: R1 } } as typeof p : p) }))
      .toThrow('BATCH_PAYMENT_PORTS_INVALID');
    expect(() => readSolanaBatchPaymentNode({ ...sol, lockedParameters: [{ name: 'payment-01-amount' } as never] })).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    expect(() => readSolanaBatchPaymentNode({ ...sol, dependencies: ['x'] })).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    expect(() => readSolanaBatchPaymentNode({ ...sol, requiredAuthorizationClass: 'NONE' })).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    expect(() => readSolanaBatchPaymentNode({ ...sol, userConstraints: [] })).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    expect(() => readSolanaBatchPaymentNode({ ...sol, actionType: 'asset.transfer' })).toThrow('BATCH_PAYMENT_PORTS_INVALID');
  });
});
