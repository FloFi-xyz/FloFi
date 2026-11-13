// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { authorizedNetworkFee, chargedNetworkFeeWithinAuthorization, l1FeeReviewBound, networkFeeWithinAuthorization } from '../src/network-fee.js';

describe('BUILD-FLOFI-MAINNET-EXEC-002 authorized network fee', () => {
  // Production 2026-11-13 (Base deposit): gas limit ≈ 160 000, max fee 2 × base fee; L1 estimate 14 907 506 315 wei at Review,
  // 33 462 843 872 wei 54 seconds later (× 2.24). The old rule refused because 33 462 843 872 > 14 907 506 315.
  const reviewedL1 = 14_907_506_315n, later = 33_462_843_872n;
  const authorization = { gasLimit: 160_000n, maxFeePerGas: 2n * 6_000_000n + 1_000_000n, l1FeeBound: l1FeeReviewBound(reviewedL1) };
  it('the Review bound carries 2× headroom on the L1 part', () => {
    expect(l1FeeReviewBound(reviewedL1)).toBe(29_815_012_630n);
    expect(authorizedNetworkFee(authorization)).toBe(160_000n * 13_000_000n + 29_815_012_630n);
  });
  it('an L1 spike that the authorized maximum still covers keeps the request (the production case)', () => {
    expect(networkFeeWithinAuthorization(authorization, { gasPrice: 7_000_000n, l1Fee: later })).toBe(true);
  });
  it('a fee beyond the authorized maximum is refused, whichever part moved', () => {
    expect(networkFeeWithinAuthorization(authorization, { gasPrice: 13_000_000n, l1Fee: authorization.l1FeeBound + 1n })).toBe(false);
    expect(networkFeeWithinAuthorization({ ...authorization, l1FeeBound: 0n }, { gasPrice: 13_000_000n, l1Fee: 1n })).toBe(false);
    expect(networkFeeWithinAuthorization(authorization, { gasPrice: -1n, l1Fee: 0n })).toBe(false);
  });
  it('the fee actually charged is checked against the same maximum', () => {
    expect(chargedNetworkFeeWithinAuthorization(authorization, { gasUsed: 120_000n, effectiveGasPrice: 7_000_000n, l1Fee: later })).toBe(true);
    expect(chargedNetworkFeeWithinAuthorization(authorization, { gasUsed: 160_000n, effectiveGasPrice: 13_000_000n, l1Fee: authorization.l1FeeBound + 1n })).toBe(false);
  });
});
