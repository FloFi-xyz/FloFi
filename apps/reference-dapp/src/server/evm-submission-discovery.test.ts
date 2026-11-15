// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { discoverEvmNonce, sameEvmIntent } from './evm-submission-discovery';
const attempt = { nonce: '60', preparedAtBlock: 100, tx: { from: '0x' + '1'.repeat(40) } };
const tx = { from: attempt.tx.from, nonce: '0x3c', to: '0x' + '2'.repeat(40), input: '0x095ea7b3', value: '0x0', chainId: '0x2105', hash: '0x' + 'a'.repeat(64) };
it.each([null, { transactions: [] }, { transactions: ['hashes-only'] }])('does not equate an incomplete pending view with no submission (%j)', async block => {
  const rpc = vi.fn(async (method: string) => method === 'eth_blockNumber' ? '0x65' : method === 'eth_getTransactionCount' ? '0x3c' : block);
  expect(await discoverEvmNonce(rpc, attempt)).toMatchObject({ consumed: false, pendingTx: null });
  expect(rpc.mock.calls.every(([m]) => !/send|sign/i.test(m))).toBe(true);
});
it('returns a specific transient observation failure when historical nonce reads fail', async () => {
  const rpc = vi.fn(async (method: string) => { if (method === 'eth_blockNumber') return '0x65'; throw Error('PUBLIC_RPC_UNAVAILABLE'); });
  await expect(discoverEvmNonce(rpc, attempt)).rejects.toThrow('PUBLIC_RPC_UNAVAILABLE');
  expect(rpc.mock.calls).toHaveLength(2);
});
it('requires exact wallet, chain, nonce, calldata, value and target for a pending match', () => {
  const expected = { chainId: tx.chainId, from: tx.from, to: tx.to, data: tx.input, value: tx.value };
  expect(sameEvmIntent(tx, expected, attempt.nonce)).toBe(true);
  for (const field of ['from', 'chainId', 'nonce', 'input', 'value', 'to']) expect(sameEvmIntent({ ...tx, [field]: '0x99' }, expected, attempt.nonce)).toBe(false);
});

// BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001 (P0): a recorded, final consumer is re-verified by hash instead of a binary search per observation.
describe('recorded conflicting transaction (fast path)', () => {
  const hash = '0x' + 'c1'.repeat(32), blockHash = '0x' + 'b1'.repeat(32);
  const known = { ...attempt, conflictingTransactionHash: hash };
  const chain = (over: { finalized?: number; nonce?: string; canonical?: string; block?: number } = {}) => vi.fn(async (method: string, params: readonly unknown[]) => {
    const block = over.block ?? 150;
    switch (method) {
      case 'eth_getTransactionByHash': return { ...tx, hash, nonce: over.nonce ?? '0x3c', blockNumber: '0x' + block.toString(16), blockHash };
      case 'eth_getTransactionReceipt': return { transactionHash: hash, blockHash, status: '0x1' };
      case 'eth_getBlockByNumber': return params[0] === 'finalized' ? { number: '0x' + (over.finalized ?? 200).toString(16) } : { hash: over.canonical ?? blockHash };
      case 'eth_blockNumber': return '0xc8';
      case 'eth_getTransactionCount': return '0x3d';
      default: throw Error('UNEXPECTED_' + method);
    }
  });
  it('returns the recorded consumer with four reads when it is canonical and final', async () => {
    const rpc = chain();
    expect(await discoverEvmNonce(rpc, known)).toMatchObject({ consumed: true, tx: { hash } });
    expect(rpc.mock.calls.map(([m]) => m).sort()).toEqual(['eth_getBlockByNumber', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
    expect(rpc.mock.calls.some(([m]) => m === 'eth_getTransactionCount')).toBe(false);
  });
  it.each([['not final', { finalized: 140 }], ['another nonce', { nonce: '0x3d' }], ['not canonical', { canonical: '0x' + 'ee'.repeat(32) }],
    ['mined before preparation', { block: 90 }], ['mined in the prepared block', { block: 100 }]])('falls back to the full search when the recorded consumer is %s', async (_label, over) => {
    const rpc = chain(over);
    await discoverEvmNonce(rpc, known).catch(() => undefined);
    expect(rpc.mock.calls.some(([m]) => m === 'eth_getTransactionCount')).toBe(true);
  });
  it('falls back (never fails) when the fast-path reads fail', async () => {
    const rpc = vi.fn(async (method: string) => { if (method === 'eth_getTransactionByHash') throw Error('PUBLIC_RPC_UNAVAILABLE'); return method === 'eth_blockNumber' ? '0x65' : '0x3c'; });
    expect(await discoverEvmNonce(rpc, known).catch(e => (e as Error).message)).toBeDefined();
    expect(rpc.mock.calls.some(([m]) => m === 'eth_getTransactionCount')).toBe(true);
  });
});
