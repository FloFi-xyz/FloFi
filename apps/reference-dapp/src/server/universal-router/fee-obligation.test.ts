// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { feeObligationFor, flofiFeeAmount, flofiFeePolicy, FLOFI_WORKFLOW_FEE_BPS } from './fee-obligation.ts';
import type { UniversalRoute } from '@defi-workflow-engine/workflow-contracts';

const route = {
  sourceChain: 'eip155:8453', destinationChain: 'solana:mainnet',
  inputToken: { chainId: 'eip155:8453', kind: 'TOKEN', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC' },
  inputAmount: '100000000',
} as unknown as UniversalRoute;

describe('BUILD-CROSSCHAIN-UNIVERSAL-001 FloFi 0.1% fee obligation', () => {
  it('computes floor(notional × 10 / 10_000) and discloses the approved policy', () => {
    expect(FLOFI_WORKFLOW_FEE_BPS).toBe(10);
    expect(flofiFeeAmount('100000000')).toBe('100000'); // 0.1% of 100 USDC (6 dp)
    expect(flofiFeeAmount(1n)).toBe('0'); // dust floors to zero
    expect(flofiFeePolicy({ upperBound: '1', symbol: 'ETH', decimals: 18 })).toMatchObject({
      flofiFee: 'WORKFLOW_0_1_PCT', flofiFeeRateBps: 10, flofiFeeBasis: 'COMPLETED_WORKFLOW_INPUT', flofiFeeCollection: 'OBLIGATION_RECORDED' });
  });

  it('obligates on RECONCILED and waives FAILED / REFUNDED / DIVERGENT without inventing collection', () => {
    expect(feeObligationFor(route, 'RECONCILED')).toMatchObject({
      status: 'OBLIGATED', feeAmount: '100000', collection: 'NOT_SETTLED', reason: null,
      notional: { amount: '100000000', symbol: 'USDC', chainId: 'eip155:8453' } });
    for (const verdict of ['FAILED', 'REFUNDED', 'DIVERGENT'] as const) {
      expect(feeObligationFor(route, verdict)).toMatchObject({ status: 'WAIVED', feeAmount: '0', collection: 'NOT_SETTLED' });
    }
  });
});
