// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): the server's chain proof that a wallet batch the owner's wallet rejected was
 * never sent. It is proven only past the batch's on-chain deadline, for an unsponsored, native-value-free batch prepared once, when the owner's
 * nonce never moved and no Transfer / Approval / UserOperationEvent names the owner since the preparation block; any doubt is "not proven".
 */
import { describe, expect, it } from 'vitest';
import { erc4337, erc7710 } from '@defi-workflow-engine/reference-compiler';
import { APPROVAL_TOPIC, CHAIN_DEADLINE_MARGIN_S, declineProofFacts, MAX_SCAN_BLOCKS, proveDeclinedBatchUnsent, SCAN_CHUNK_BLOCKS } from './decline-proof.ts';
import { TRANSFER_TOPIC } from './evm-reconcile.ts';

const OWNER = '0x' + 'ab'.repeat(20), OWNER_TOPIC = '0x' + '0'.repeat(24) + 'ab'.repeat(20);
const SETTLED = new Date('2026-11-21T10:00:00.000Z'), AFTER = new Date('2026-11-21T10:00:01.000Z');
/** The batch's on-chain deadline (unix seconds): the swap's own SwapRouter02 deadline. */
const DEADLINE = 1_795_250_000n;
const prepared = (over: Record<string, unknown> = {}) => ({ kind: 'EVM_WALLET_BATCH', owner: OWNER, fromBlock: '1000', ownerNonce: '7',
  group: { calls: [{ kind: 'ERC20_APPROVE' }, { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', deadline: DEADLINE.toString() }] },
  request: { id: '0x' + '12'.repeat(32), atomicRequired: true, calls: [{ to: '0x' + '56'.repeat(20), value: '0x0', data: '0x095ea7b3' }, { to: '0x' + '68'.repeat(20), value: '0x0', data: '0x5ae401dc' }] }, ...over });
type Filter = { fromBlock: string; toBlock: string; topics: (string | null)[] };
/**
 * A read-only transport double: nonces, the head block (number, hash, timestamp) and the logs answering each filter (every call recorded).
 * `headTime`: the head's own block timestamp (default well past the deadline). `reorged`: the scanned head is replaced by another block afterwards.
 */
function chain(o: { latest?: bigint; pending?: bigint; head?: bigint; headTime?: bigint; reorged?: boolean; anchorHash?: string; logs?: (f: Filter) => unknown[]; fail?: string;
  nonceAfterScan?: bigint } = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  let scans = 0;
  const t = { rpc: async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    if (method === o.fail) throw new Error('ECONNRESET');
    if (method === 'eth_getBlockByNumber') {
      if (o.anchorHash && params[0] === '0x3e8') return { number: '0x3e8', hash: o.anchorHash, timestamp: '0x1' };
      const head = o.head ?? 1500n, replaced = o.reorged && params[0] !== 'latest';
      return { number: '0x' + head.toString(16), hash: '0x' + (replaced ? 'ee' : 'bb').repeat(32), timestamp: '0x' + (o.headTime ?? DEADLINE + 3_600n).toString(16) };
    }
    if (method === 'eth_getTransactionCount') {
      const n = scans > 0 && o.nonceAfterScan !== undefined ? o.nonceAfterScan : params[1] === 'pending' ? o.pending ?? o.latest ?? 7n : o.latest ?? 7n;
      return '0x' + n.toString(16);
    }
    if (method === 'eth_getLogs') { scans++; return o.logs?.(params[0] as Filter) ?? []; }
    throw new Error('MOCK_METHOD_DENIED');
  } };
  return { t: t as never, calls };
}

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: proof that a rejected wallet batch was never sent', () => {
  it('uses the canonical event topics', () => {
    expect(APPROVAL_TOPIC).toBe('0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925');
    expect(TRANSFER_TOPIC).toBe(erc7710.keccakHex('Transfer(address,address,uint256)'));
  });

  it('proven: deadline passed, nonce unchanged (latest and pending, before and after the scan), no owner log since the preparation block', async () => {
    const { t, calls } = chain();
    expect(await proveDeclinedBatchUnsent(t, prepared(), SETTLED, AFTER)).toEqual({ proven: true, ownerNonce: '7', fromBlock: '1000', toBlock: '1500' });
    const filters = calls.filter(c => c.method === 'eth_getLogs').map(c => (c.params[0] as Filter).topics);
    expect(filters).toEqual([[TRANSFER_TOPIC, OWNER_TOPIC], [APPROVAL_TOPIC, OWNER_TOPIC], [TRANSFER_TOPIC, null, OWNER_TOPIC], [erc4337.USER_OPERATION_EVENT_TOPIC, null, OWNER_TOPIC]]);
    expect(calls.filter(c => c.method === 'eth_getTransactionCount').map(c => c.params[1])).toEqual(['latest', 'pending', 'latest', 'pending']);
    // Read-only: nothing is ever sent.
    expect(calls.every(c => ['eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getLogs'].includes(c.method))).toBe(true);
    // The scanned head is read again by its own number after the scan (a reorg would change its hash).
    expect(calls.filter(c => c.method === 'eth_getBlockByNumber').map(c => c.params[0])).toEqual(['latest', '0x' + (1500n).toString(16)]);
  });

  it('scans the whole range in bounded chunks, and never claims a range wider than the limit', async () => {
    const head = 1000n + SCAN_CHUNK_BLOCKS * 2n + 5n, { t, calls } = chain({ head });
    expect((await proveDeclinedBatchUnsent(t, prepared(), SETTLED, AFTER)).proven).toBe(true);
    const ranges = [...new Set(calls.filter(c => c.method === 'eth_getLogs').map(c => `${(c.params[0] as Filter).fromBlock}-${(c.params[0] as Filter).toBlock}`))];
    expect(ranges).toEqual([`0x${(1000n).toString(16)}-0x${(1000n + SCAN_CHUNK_BLOCKS - 1n).toString(16)}`,
      `0x${(1000n + SCAN_CHUNK_BLOCKS).toString(16)}-0x${(1000n + 2n * SCAN_CHUNK_BLOCKS - 1n).toString(16)}`, `0x${(1000n + 2n * SCAN_CHUNK_BLOCKS).toString(16)}-0x${head.toString(16)}`]);
    expect(await proveDeclinedBatchUnsent(chain({ head: 1000n + MAX_SCAN_BLOCKS + 1n }).t, prepared(), SETTLED, AFTER)).toEqual({ proven: false, reason: 'DECLINE_PROOF_RANGE_TOO_WIDE' });
  });

  it('not proven before the deadline: by FloFi\'s clock, and above all by the chain\'s own head (an RPC that lags or an L2 catching up)', async () => {
    expect(await proveDeclinedBatchUnsent(chain().t, prepared(), SETTLED, new Date(SETTLED.getTime() - 1))).toEqual({ proven: false, reason: 'DECLINE_PROOF_NOT_SETTLED' });
    // FloFi's clock says it is over, yet the chain's head is still before the deadline plus the margin: blocks able to execute it may still come.
    for (const headTime of [DEADLINE - 5n, DEADLINE, DEADLINE + CHAIN_DEADLINE_MARGIN_S])
      expect(await proveDeclinedBatchUnsent(chain({ headTime }).t, prepared(), SETTLED, AFTER)).toEqual({ proven: false, reason: 'DECLINE_PROOF_NOT_SETTLED' });
    expect((await proveDeclinedBatchUnsent(chain({ headTime: DEADLINE + CHAIN_DEADLINE_MARGIN_S + 1n }).t, prepared(), SETTLED, AFTER)).proven).toBe(true);
    // The earliest deadline of the batch counts (a guard before a later swap deadline).
    const guarded = prepared({ group: { calls: [{ kind: 'DEADLINE_GUARD', deadline: (DEADLINE - 600n).toString() }, { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', deadline: DEADLINE.toString() }] } });
    expect((await proveDeclinedBatchUnsent(chain({ headTime: DEADLINE - 600n + CHAIN_DEADLINE_MARGIN_S + 1n }).t, guarded, SETTLED, AFTER)).proven).toBe(true);
  });

  it('not proven when the scanned head was replaced while the range was scanned (a reorg)', async () => {
    expect(await proveDeclinedBatchUnsent(chain({ reorged: true }).t, prepared(), SETTLED, AFTER)).toEqual({ proven: false, reason: 'DECLINE_PROOF_CHAIN_REORG' });
  });

  it('fallback verifies the original preparation block and scans only later blocks through the safe head', async () => {
    const anchorHash = '0x' + 'cc'.repeat(32), p = prepared({ fromBlockHash: anchorHash });
    const { t, calls } = chain({ anchorHash });
    expect(await proveDeclinedBatchUnsent(t, p, SETTLED, AFTER, true)).toMatchObject({ proven: true });
    expect(calls.filter(c => c.method === 'eth_getBlockByNumber').map(c => c.params[0])).toEqual(['safe', '0x5dc', '0x3e8']);
    expect(calls.filter(c => c.method === 'eth_getLogs').every(c => (c.params[0] as Filter).fromBlock === '0x3e9')).toBe(true);
    expect(await proveDeclinedBatchUnsent(t, prepared(), SETTLED, AFTER, true)).toEqual({ proven: false, reason: 'DECLINE_PROOF_NOT_RECORDED' });
    expect(await proveDeclinedBatchUnsent(chain({ anchorHash: '0x' + 'ee'.repeat(32) }).t, p, SETTLED, AFTER, true))
      .toEqual({ proven: false, reason: 'DECLINE_PROOF_CHAIN_REORG' });
  });

  it('not proven when the owner transacted: a mined or pending transaction, or one appearing while the range was scanned', async () => {
    expect((await proveDeclinedBatchUnsent(chain({ latest: 8n }).t, prepared(), SETTLED, AFTER))).toEqual({ proven: false, reason: 'DECLINE_PROOF_OWNER_TRANSACTED' });
    expect((await proveDeclinedBatchUnsent(chain({ latest: 7n, pending: 8n }).t, prepared(), SETTLED, AFTER))).toEqual({ proven: false, reason: 'DECLINE_PROOF_OWNER_TRANSACTED' });
    expect((await proveDeclinedBatchUnsent(chain({ nonceAfterScan: 8n }).t, prepared(), SETTLED, AFTER))).toEqual({ proven: false, reason: 'DECLINE_PROOF_OWNER_TRANSACTED' });
  });

  it('not proven when any owner log exists since the preparation: tokens or allowance moved, tokens received, or a user operation of the owner', async () => {
    for (const topic of [[TRANSFER_TOPIC, OWNER_TOPIC], [APPROVAL_TOPIC, OWNER_TOPIC], [TRANSFER_TOPIC, null, OWNER_TOPIC], [erc4337.USER_OPERATION_EVENT_TOPIC, null, OWNER_TOPIC]]) {
      const { t } = chain({ logs: f => JSON.stringify(f.topics) === JSON.stringify(topic) ? [{ address: '0x' + '99'.repeat(20) }] : [] });
      expect(await proveDeclinedBatchUnsent(t, prepared(), SETTLED, AFTER)).toEqual({ proven: false, reason: 'DECLINE_PROOF_OWNER_ACTIVITY' });
    }
  });

  it('never proven for a batch the proof cannot cover: sponsored, prepared again, native value, nothing recorded, another kind, unknown owner', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ sponsorship: { grantId: 'g' } }, 'DECLINE_PROOF_SPONSORED'],
      [{ superseded: [{ group: {}, fromBlock: '900' }] }, 'DECLINE_PROOF_PREPARED_AGAIN'],
      [{ request: { id: '0x' + '12'.repeat(32), calls: [{ to: '0x' + '56'.repeat(20), value: '0x1', data: '0x' }] } }, 'DECLINE_PROOF_NATIVE_VALUE'],
      [{ ownerNonce: undefined }, 'DECLINE_PROOF_NOT_RECORDED'],
      [{ fromBlock: 12 }, 'DECLINE_PROOF_NOT_RECORDED'],
      [{ kind: 'EVM_USER_OPERATION' }, 'DECLINE_PROOF_NOT_A_WALLET_BATCH'],
      [{ owner: 'not-an-address' }, 'DECLINE_PROOF_OWNER_UNKNOWN'],
      [{ request: { ...prepared().request, atomicRequired: false } }, 'DECLINE_PROOF_NOT_ATOMIC'],
      [{ group: { calls: [{ kind: 'ERC20_APPROVE' }, { kind: 'WETH9_WITHDRAW' }] } }, 'DECLINE_PROOF_CALL_UNPROVABLE'],
      [{ group: { calls: [{ kind: 'ERC20_APPROVE' }] } }, 'DECLINE_PROOF_CALL_UNPROVABLE'],
      [{ group: { calls: [{ kind: 'ERC20_APPROVE' }, { kind: 'AAVE_V3_SUPPLY' }] } }, 'DECLINE_PROOF_NO_DEADLINE'],
      [{ group: { calls: [{ kind: 'ERC20_APPROVE' }, { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE' }] } }, 'DECLINE_PROOF_NO_DEADLINE'],
    ];
    for (const [over, reason] of cases) {
      expect(declineProofFacts(prepared(over))).toEqual({ reason });
      const { t, calls } = chain();
      expect(await proveDeclinedBatchUnsent(t, prepared(over), SETTLED, AFTER)).toEqual({ proven: false, reason });
      expect(calls).toEqual([]);
    }
  });

  it('fails closed on any unreadable answer or a missing transport', async () => {
    for (const fail of ['eth_getTransactionCount', 'eth_getBlockByNumber', 'eth_getLogs'])
      expect(await proveDeclinedBatchUnsent(chain({ fail }).t, prepared(), SETTLED, AFTER)).toEqual({ proven: false, reason: 'DECLINE_PROOF_RPC_UNAVAILABLE' });
    expect(await proveDeclinedBatchUnsent(chain({ logs: () => 'oops' as never }).t, prepared(), SETTLED, AFTER)).toEqual({ proven: false, reason: 'DECLINE_PROOF_RPC_UNAVAILABLE' });
    expect(await proveDeclinedBatchUnsent(null, prepared(), SETTLED, AFTER)).toEqual({ proven: false, reason: 'DECLINE_PROOF_RPC_UNAVAILABLE' });
    expect(await proveDeclinedBatchUnsent(chain({ head: 999n }).t, prepared(), SETTLED, AFTER)).toEqual({ proven: false, reason: 'DECLINE_PROOF_CHAIN_BEHIND' });
  });
});
