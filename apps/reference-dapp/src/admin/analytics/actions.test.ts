// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ADMIN-001: actions and networks come from each flow's canonical record, never from its flow name. */
import { describe, expect, it } from 'vitest';
import { actionKind, lastRecordLine, recordFacts } from './actions.ts';

const node = (actionType: string, chainId: string, extra: Record<string, unknown> = {}) => ({ nodeId: `n-${actionType}`, actionType, chainId, ...extra });
const bridge = node('asset.bridge', 'eip155:84532', { inputs: [{ name: 'amount-in', kind: 'QUANTITY', value: {} },
  { name: 'asset-out', kind: 'ASSET', value: { chainId: 'eip155:421614', address: '0x' + '1'.repeat(40), decimals: 6 } }] });

describe('BUILD-ADMIN-001 canonical action facts', () => {
  it('classifies action types', () => {
    expect(['asset.swap.exact-input', 'asset.bridge', 'asset.liquidity.concentrated', 'asset.liquidity.uniswap-v3', 'supply', 'borrow', 'repay', 'withdraw',
      'asset.transfer', 'payment.pix', 'payment.boleto', 'something.else'].map(actionKind))
      .toEqual(['SWAP', 'BRIDGE', 'LIQUIDITY', 'LIQUIDITY', 'LENDING', 'LENDING', 'LENDING', 'LENDING', 'TRANSFER', 'PAYMENT', 'PAYMENT', 'OTHER']);
  });
  it('reads the workflow wherever each record format keeps it', () => {
    expect(recordFacts('robinhood-transfer', { review: { workflow: { nodes: [node('asset.transfer', 'eip155:11155111')] } } }))
      .toEqual({ ok: true, children: [], actions: [{ i: 0, kind: 'TRANSFER', type: 'asset.transfer', chain: 'eip155:11155111' }] });
    expect(recordFacts('crosschain-router-testnet', { workflow: { nodes: [bridge] } }))
      .toEqual({ ok: true, children: [], actions: [{ i: 0, kind: 'BRIDGE', type: 'asset.bridge', chain: 'eip155:84532', to: 'eip155:421614' }] });
    const lending = recordFacts('lending-composition', { reviews: [{ workflow: { nodes: [node('supply', 'eip155:84532')] } },
      { workflow: { nodes: [node('supply', 'eip155:84532'), node('borrow', 'eip155:84532'), node('asset.swap.exact-input', 'eip155:84532')] } }] });
    expect(lending.ok && lending.actions.map(a => [a.i, a.kind])).toEqual([[0, 'LENDING'], [1, 'LENDING'], [2, 'SWAP']]);
    expect(recordFacts('pix-payment', { node: node('payment.pix', 'eip155:8453') })).toMatchObject({ ok: true, actions: [{ kind: 'PAYMENT', chain: 'eip155:8453' }] });
    expect(recordFacts('base-sepolia-swap', { workflow: { nodes: [node('mock-start', 'mock:local'), node('asset.swap.exact-input', 'eip155:84532')] } }))
      .toMatchObject({ ok: true, actions: [{ i: 0, kind: 'SWAP' }] });
  });
  it('names a Solana composition’s step runs so they are counted inside it', () => {
    const facts = recordFacts('solana-devnet-composition', { review: { workflow: { nodes: [node('asset.swap.exact-input', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'),
      node('asset.liquidity.concentrated', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')] } }, producerRunId: 'sdx-a', consumerRunIds: ['olp-b', 'olp-c'] });
    expect(facts).toEqual({ ok: true, children: ['sdx-a', 'olp-b', 'olp-c'], actions: [
      { i: 0, kind: 'SWAP', type: 'asset.swap.exact-input', chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', runs: ['sdx-a'] },
      { i: 1, kind: 'LIQUIDITY', type: 'asset.liquidity.concentrated', chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', runs: ['olp-b', 'olp-c'] }] });
  });
  it('refuses records it cannot read instead of guessing', () => {
    expect(recordFacts('x', null)).toEqual({ ok: false, code: 'RUN_RECORD_INVALID' });
    expect(recordFacts('x', { review: {} })).toEqual({ ok: false, code: 'RUN_WORKFLOW_MISSING' });
    expect(recordFacts('x', { workflow: { nodes: [{ actionType: 'asset.swap.exact-input', chainId: 'not a chain' }] } })).toEqual({ ok: false, code: 'RUN_ACTIONS_UNRECOGNIZED' });
    expect(recordFacts('x', { workflow: { nodes: [node('mock-start', 'mock:local')] } })).toEqual({ ok: false, code: 'RUN_ACTIONS_UNRECOGNIZED' });
  });
  it('reads the last JSONL record, like the projection', () => {
    expect(lastRecordLine(new TextEncoder().encode('{"a":1}\n{"a":2}\n'))).toEqual({ a: 2 });
    expect(() => lastRecordLine(new TextEncoder().encode('{"a":1}\n{"a":'))).toThrow();
  });
});
