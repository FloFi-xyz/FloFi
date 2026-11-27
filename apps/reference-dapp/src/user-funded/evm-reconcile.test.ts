// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (review SEC-2): which wallet transactions carry a prepared batch. An EIP-7702 self-call
 * `execute(bytes32,bytes)` counts only in the default batch mode (all calls, or none): in ERC-7579 'try' mode a failed call does not undo the
 * others, and a native ETH payment leaves no log that could show it failed, so such a call is a calls mismatch, never "paid". A self-call that is
 * not an `execute` at all (another account's own encoding) keeps the existing fallback: its bytes must still hold every call.
 *
 * Pure checks plus a loopback transport stub (MOCKED; nothing reaches a network and nothing is signed).
 */
import { describe, expect, it } from 'vitest';
import { erc4337 } from '@defi-workflow-engine/reference-compiler';
import { guarded } from '../delegation/chains.ts';
import { evmCallsOf, type EvmGroupCalls } from './evm-calls.ts';
import { batchCarriesCalls, reconcileWalletBatch } from './evm-reconcile.ts';

const CHAIN = 'eip155:8453', OWNER = '0x' + '11'.repeat(20), A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), ROUTER = '0x' + '2626'.repeat(10);
const ETH = `${CHAIN}/native:ETH`;
/** An ETH Batch Payment of two recipients, as prepared: the deadline guard, then one native transfer per recipient. */
const group: EvmGroupCalls = { chain: CHAIN, chainId: 8453, owner: OWNER, calls: [{ kind: 'DEADLINE_GUARD', router: ROUTER, deadline: '1800000000' },
  { kind: 'NATIVE_TRANSFER', to: A, amount: '1000000000000000' }, { kind: 'NATIVE_TRANSFER', to: B, amount: '2000000000000000' }],
  steps: [{ stepIndex: 0, calls: [1], spend: { asset: ETH, amount: '1000000000000000' }, guaranteed: null, quoted: null, recipient: A },
    { stepIndex: 1, calls: [2], spend: { asset: ETH, amount: '2000000000000000' }, guaranteed: null, quoted: null, recipient: B }] };
const calls = evmCallsOf(group);
const atomic = erc4337.batchCallData(calls);
/** The same `execute` with another ERC-7579 mode word (call type 0x01 batch; `exec` 0x01 is 'try': a failed call does not revert the batch). */
const withMode = (callData: string, mode: string) => callData.slice(0, 10) + mode + callData.slice(10 + 64);
const TRY_MODE = '01' + '01' + '00'.repeat(30);

describe('SEC-2: a wallet batch counts only as the prepared atomic batch', () => {
  it('the default batch mode carrying exactly the calls matches; the same calls in try mode, or an execute FloFi cannot decode, never do', () => {
    expect(batchCarriesCalls(OWNER, [{ to: OWNER, input: atomic }], calls)).toBe(true);
    const tried = withMode(atomic, TRY_MODE);
    // Every target, value and calldata is still inside the bytes: the substring fallback alone would have accepted it.
    for (const c of calls) expect(tried.includes(c.data.slice(2))).toBe(true);
    expect(batchCarriesCalls(OWNER, [{ to: OWNER, input: tried }], calls)).toBe(false);
    // Single-call mode, a batch with a selector or payload in its mode word, and bytes that do not decode are refused as well.
    expect(batchCarriesCalls(OWNER, [{ to: OWNER, input: withMode(atomic, '00'.repeat(32)) }], calls)).toBe(false);
    expect(batchCarriesCalls(OWNER, [{ to: OWNER, input: withMode(atomic, '01' + '00'.repeat(5) + 'deadbeef' + '00'.repeat(22)) }], calls)).toBe(false);
    expect(batchCarriesCalls(OWNER, [{ to: OWNER, input: erc4337.EXECUTE_SELECTOR + calls.map(c => c.data.slice(2)).join('') }], calls)).toBe(false);
  });

  it('an `execute` FloFi cannot decode is refused even when its bytes hold every call\'s target, value and calldata (the old fallback would accept it)', () => {
    // The real atomic encoding, words 0x-free: [mode][offset of `executions`][its length][offset of the array][array length][element offsets]…
    const at = (index: number) => 10 + index * 64, set = (hex: string, index: number, value: string) => hex.slice(0, at(index)) + value + hex.slice(at(index) + 64);
    expect(atomic.slice(at(1), at(2))).toBe((0x40).toString(16).padStart(64, '0'));
    expect(atomic.slice(at(4), at(5))).toBe(calls.length.toString(16).padStart(64, '0'));
    const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
    // What the substring fallback checked: every target and value as a word, every calldata as bytes.
    const fallbackAccepts = (input: string) => calls.every(c => input.includes(word(c.target.toLowerCase())) && (c.value === 0n || input.includes(word(c.value.toString(16))))
      && (c.data === '0x' || input.includes(c.data.slice(2).toLowerCase())));
    expect(fallbackAccepts(atomic)).toBe(true);
    // Corrupted offsets: the outer `executions` offset, then the first element's offset, each pointed past the end of the call data.
    for (const corrupt of [set(atomic, 1, 'f'.repeat(64)), set(atomic, 5, 'f'.repeat(64))]) {
      expect(corrupt.startsWith(erc4337.EXECUTE_SELECTOR)).toBe(true);
      expect(() => erc4337.decodeBatchCallData(corrupt)).toThrow();
      expect(fallbackAccepts(corrupt)).toBe(true);
      expect(batchCarriesCalls(OWNER, [{ to: OWNER, input: corrupt }], calls)).toBe(false);
    }
  });

  it('keeps the existing cases: one transaction per call compared field by field, and another account encoding that holds every call', () => {
    const split = calls.map(c => ({ to: c.target, input: c.data, value: '0x' + c.value.toString(16) }));
    expect(batchCarriesCalls(OWNER, split, calls)).toBe(true);
    expect(batchCarriesCalls(OWNER, split.slice(0, 2), calls)).toBe(false);
    // `executeBatch((address,uint256,bytes)[])` (Simple7702Account / Coinbase Smart Wallet) is not an ERC-7579 `execute`: the fallback still applies.
    const other = erc4337.simple7702CallData(calls);
    expect(other.startsWith(erc4337.EXECUTE_SELECTOR)).toBe(false);
    expect(batchCarriesCalls(OWNER, [{ to: OWNER, input: other }], calls)).toBe(true);
    // A redirected payment is inside the bytes, so it can never match.
    const redirected = erc4337.simple7702CallData([calls[0]!, { ...calls[1]!, target: '0x' + 'cc'.repeat(20) }, calls[2]!]);
    expect(batchCarriesCalls(OWNER, [{ to: OWNER, input: redirected }], calls)).toBe(false);
  });

  it('an ETH Batch Payment the wallet sent in try mode never reconciles as paid, even with a successful receipt and no logs', async () => {
    const chain = (input: string) => guarded(CHAIN, 'read', 'MOCKED', async (method, params) => {
      const hash = String(params[0]);
      if (method === 'eth_getTransactionReceipt') return { transactionHash: hash, status: '0x1', from: OWNER, to: OWNER, gasUsed: '0x5208', effectiveGasPrice: '0x1',
        blockNumber: '0x10', blockHash: '0x' + 'ab'.repeat(32), logs: [], l1Fee: '0x0' };
      if (method === 'eth_getTransactionByHash') return { hash, from: OWNER, to: OWNER, input, value: '0x0' };
      throw new Error(`UNEXPECTED_${method}`);
    });
    const hash = '0x' + '77'.repeat(32);
    expect(await reconcileWalletBatch(chain(withMode(atomic, TRY_MODE)), group, [hash], '1')).toEqual({ status: 'MISMATCH', code: 'RECONCILIATION_CALLS_MISMATCH',
      gasPaid: null, transactions: [hash] });
    // The atomic batch with the same receipt reconciles each payment at its exact amount (it succeeded, so every call did).
    expect(await reconcileWalletBatch(chain(atomic), group, [hash], '1')).toMatchObject({ status: 'RECONCILED', steps: [
      { stepIndex: 0, spent: [{ asset: ETH, amount: '1000000000000000' }], received: [] }, { stepIndex: 1, spent: [{ asset: ETH, amount: '2000000000000000' }], received: [] }] });
  });
});
