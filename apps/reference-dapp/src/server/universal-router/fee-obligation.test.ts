// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { feeObligationFor, flofiFeeAmount, flofiFeePolicy, FLOFI_WORKFLOW_FEE_BPS, FLOFI_WORKFLOW_FEE_BPS_V1, reviewedFeeRate } from './fee-obligation.ts';
import { PLATFORM_FEE_BPS } from '../../platform-fee/policy.ts';
import type { UniversalRoute } from '@defi-workflow-engine/workflow-contracts';

const route = {
  sourceChain: 'eip155:8453', destinationChain: 'solana:mainnet',
  inputToken: { chainId: 'eip155:8453', kind: 'TOKEN', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC' },
  inputAmount: '100000000',
} as unknown as UniversalRoute;

describe('FloFi fee obligation on the universal bridge (BUILD-CROSSCHAIN-UNIVERSAL-001, rate from BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001)', () => {
  it('computes floor(notional × 80 / 10_000) from the canonical platform policy and discloses it', () => {
    expect(FLOFI_WORKFLOW_FEE_BPS).toBe(80);
    expect(FLOFI_WORKFLOW_FEE_BPS).toBe(PLATFORM_FEE_BPS);
    expect(flofiFeeAmount('100000000')).toBe('800000'); // 0.80% of 100 USDC (6 dp)
    expect(flofiFeeAmount(1n)).toBe('0'); // dust floors to zero
    expect(flofiFeePolicy({ upperBound: '1', symbol: 'ETH', decimals: 18 })).toMatchObject({
      flofiFee: 'WORKFLOW_0_80_PCT', flofiFeeRateBps: 80, flofiFeeBasis: 'COMPLETED_WORKFLOW_INPUT', flofiFeeCollection: 'OBLIGATION_RECORDED' });
  });

  it('obligates on RECONCILED and waives FAILED / REFUNDED / DIVERGENT without inventing collection', () => {
    expect(feeObligationFor(route, 'RECONCILED')).toMatchObject({
      rateBps: 80, status: 'OBLIGATED', feeAmount: '800000', collection: 'NOT_SETTLED', reason: null,
      notional: { amount: '100000000', symbol: 'USDC', chainId: 'eip155:8453' } });
    for (const verdict of ['FAILED', 'REFUNDED', 'DIVERGENT'] as const) {
      expect(feeObligationFor(route, verdict)).toMatchObject({ status: 'WAIVED', feeAmount: '0', collection: 'NOT_SETTLED' });
    }
  });

  it('F15: a run keeps the rate its Review disclosed — a Review made under the 10 bps policy never records 80 bps', () => {
    expect(reviewedFeeRate({ flofiFeeRateBps: 80 })).toBe(80);
    expect(reviewedFeeRate({ flofiFeeRateBps: 10 })).toBe(FLOFI_WORKFLOW_FEE_BPS_V1);
    // An unreadable policy falls back to the lower rate: never a higher charge than disclosed.
    expect(reviewedFeeRate({ flofiFeeRateBps: 999 })).toBe(10);
    expect(reviewedFeeRate(null)).toBe(10);
    expect(feeObligationFor(route, 'RECONCILED', reviewedFeeRate({ flofiFeeRateBps: 10 }))).toMatchObject({ rateBps: 10, feeAmount: '100000' });
  });
});
