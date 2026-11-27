// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: FloFi's fee per completed workflow, for the universal bridge.
 *
 * Established semantics (owner-approved commercial model):
 *   - rate: the canonical platform fee (BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001: 80 bps, 0.80%, `platform-fee/policy.ts`) of the
 *     workflow's source input notional. A run keeps the rate its Review disclosed: a Review made under the earlier 10 bps policy records
 *     10 bps, never the newer rate (F15)
 *   - one obligation per completed workflow (not per internal step or provider hop)
 *   - charged only when the run reconciles successfully; FAILED / REFUNDED / DIVERGENT waive
 *   - network and provider fees remain separate and itemized
 *
 * This module records the durable obligation and discloses it at Review. It does not collect
 * funds: on-chain collection (Relay appFees, separate transfer, invoice) requires an explicit
 * owner settlement decision and a verified treasury (see the build report).
 */
import type { UniversalRoute, UniversalToken } from '@defi-workflow-engine/workflow-contracts';
import type { UniversalVerdict } from './types.ts';
import { PLATFORM_FEE_BPS } from '../../platform-fee/policy.ts';

/** The current rate: 80 basis points = 0.80%. */
export const FLOFI_WORKFLOW_FEE_BPS = PLATFORM_FEE_BPS;
/** The rate of Reviews made before BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (still valid on their own records). */
export const FLOFI_WORKFLOW_FEE_BPS_V1 = 10;
export const FLOFI_WORKFLOW_FEE_DENOMINATOR = 10_000n;
export type FloFiFeeRateBps = typeof FLOFI_WORKFLOW_FEE_BPS | typeof FLOFI_WORKFLOW_FEE_BPS_V1;
const label = (rate: FloFiFeeRateBps) => rate === FLOFI_WORKFLOW_FEE_BPS_V1 ? 'WORKFLOW_0_1_PCT' as const : 'WORKFLOW_0_80_PCT' as const;

export type FloFiFeePolicy = {
  readonly flofiFee: 'WORKFLOW_0_1_PCT' | 'WORKFLOW_0_80_PCT';
  readonly flofiFeeRateBps: FloFiFeeRateBps;
  readonly flofiFeeBasis: 'COMPLETED_WORKFLOW_INPUT';
  readonly flofiFeeCollection: 'OBLIGATION_RECORDED';
  readonly networkFeeUpperBound: string;
  readonly networkFeeSymbol: 'ETH' | 'SOL';
  readonly networkFeeDecimals: number;
};

export type FeeObligation = {
  readonly rateBps: FloFiFeeRateBps;
  readonly basis: 'COMPLETED_WORKFLOW_INPUT';
  readonly notional: { readonly chainId: string; readonly token: string; readonly symbol: string; readonly decimals: number; readonly amount: string };
  readonly feeAmount: string;
  readonly status: 'OBLIGATED' | 'WAIVED';
  readonly collection: 'NOT_SETTLED';
  readonly reason: string | null;
};

export function flofiFeePolicy(networkFee: { readonly upperBound: string; readonly symbol: 'ETH' | 'SOL'; readonly decimals: number }): FloFiFeePolicy {
  return {
    flofiFee: label(FLOFI_WORKFLOW_FEE_BPS),
    flofiFeeRateBps: FLOFI_WORKFLOW_FEE_BPS,
    flofiFeeBasis: 'COMPLETED_WORKFLOW_INPUT',
    flofiFeeCollection: 'OBLIGATION_RECORDED',
    networkFeeUpperBound: networkFee.upperBound,
    networkFeeSymbol: networkFee.symbol,
    networkFeeDecimals: networkFee.decimals,
  };
}

const tokenKey = (token: UniversalToken): string => token.address ?? 'native';

/** floor(notional × rate / 10_000) in native units of the input token (the current rate unless a reviewed one is given). */
export function flofiFeeAmount(notional: string | bigint, rateBps: FloFiFeeRateBps = FLOFI_WORKFLOW_FEE_BPS): string {
  const n = typeof notional === 'bigint' ? notional : BigInt(notional);
  if (n < 0n) throw new Error('FLOFI_FEE_NOTIONAL_INVALID');
  return ((n * BigInt(rateBps)) / FLOFI_WORKFLOW_FEE_DENOMINATOR).toString();
}
/** The rate a Review disclosed (its fee policy); an unreadable policy falls back to the earlier, lower rate (never a higher charge). */
export const reviewedFeeRate = (policy: { readonly flofiFeeRateBps?: unknown } | null | undefined): FloFiFeeRateBps =>
  policy?.flofiFeeRateBps === FLOFI_WORKFLOW_FEE_BPS ? FLOFI_WORKFLOW_FEE_BPS : FLOFI_WORKFLOW_FEE_BPS_V1;

/** Durable obligation for a terminal universal-bridge run. One per workflow; never collected here. */
export function feeObligationFor(route: UniversalRoute, verdict: UniversalVerdict, rateBps: FloFiFeeRateBps = FLOFI_WORKFLOW_FEE_BPS): FeeObligation {
  const notional = {
    chainId: route.sourceChain,
    token: tokenKey(route.inputToken),
    symbol: route.inputToken.symbol,
    decimals: route.inputToken.decimals,
    amount: route.inputAmount,
  };
  if (verdict === 'RECONCILED') {
    return {
      rateBps,
      basis: 'COMPLETED_WORKFLOW_INPUT',
      notional,
      feeAmount: flofiFeeAmount(route.inputAmount, rateBps),
      status: 'OBLIGATED',
      collection: 'NOT_SETTLED',
      reason: null,
    };
  }
  const reason = verdict === 'REFUNDED' ? 'WORKFLOW_REFUNDED'
    : verdict === 'FAILED' ? 'WORKFLOW_FAILED'
      : verdict === 'DIVERGENT' ? 'WORKFLOW_DIVERGENT'
        : 'WORKFLOW_NOT_COMPLETED';
  return {
    rateBps,
    basis: 'COMPLETED_WORKFLOW_INPUT',
    notional,
    feeAmount: '0',
    status: 'WAIVED',
    collection: 'NOT_SETTLED',
    reason,
  };
}
