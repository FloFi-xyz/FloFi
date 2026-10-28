// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
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
