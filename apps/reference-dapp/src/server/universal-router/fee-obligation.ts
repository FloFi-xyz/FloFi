// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: FloFi's approved 0.1% fee per completed workflow.
 *
 * Established semantics (owner-approved commercial model):
 *   - rate: 10 bps (0.1%) of the workflow's source input notional
 *   - one obligation per completed workflow (not per internal step or provider hop)
 *   - charged only when the run reconciles successfully; FAILED / REFUNDED / DIVERGENT waive
 *   - network and provider fees remain separate and itemized
 *
 * This module records the durable obligation and discloses it at Review. It does not collect
 * funds: on-chain collection (Relay appFees, separate transfer, invoice) requires an explicit
 * owner settlement decision (see the build report).
 */
import type { UniversalRoute, UniversalToken } from '@defi-workflow-engine/workflow-contracts';
import type { UniversalVerdict } from './types.ts';

/** 10 basis points = 0.1%. */
export const FLOFI_WORKFLOW_FEE_BPS = 10;
export const FLOFI_WORKFLOW_FEE_DENOMINATOR = 10_000n;

export type FloFiFeePolicy = {
  readonly flofiFee: 'WORKFLOW_0_1_PCT';
  readonly flofiFeeRateBps: typeof FLOFI_WORKFLOW_FEE_BPS;
  readonly flofiFeeBasis: 'COMPLETED_WORKFLOW_INPUT';
  readonly flofiFeeCollection: 'OBLIGATION_RECORDED';
  readonly networkFeeUpperBound: string;
  readonly networkFeeSymbol: 'ETH' | 'SOL';
  readonly networkFeeDecimals: number;
};

export type FeeObligation = {
  readonly rateBps: typeof FLOFI_WORKFLOW_FEE_BPS;
  readonly basis: 'COMPLETED_WORKFLOW_INPUT';
  readonly notional: { readonly chainId: string; readonly token: string; readonly symbol: string; readonly decimals: number; readonly amount: string };
  readonly feeAmount: string;
  readonly status: 'OBLIGATED' | 'WAIVED';
  readonly collection: 'NOT_SETTLED';
  readonly reason: string | null;
};

export function flofiFeePolicy(networkFee: { readonly upperBound: string; readonly symbol: 'ETH' | 'SOL'; readonly decimals: number }): FloFiFeePolicy {
  return {
    flofiFee: 'WORKFLOW_0_1_PCT',
    flofiFeeRateBps: FLOFI_WORKFLOW_FEE_BPS,
    flofiFeeBasis: 'COMPLETED_WORKFLOW_INPUT',
    flofiFeeCollection: 'OBLIGATION_RECORDED',
    networkFeeUpperBound: networkFee.upperBound,
    networkFeeSymbol: networkFee.symbol,
    networkFeeDecimals: networkFee.decimals,
  };
}

const tokenKey = (token: UniversalToken): string => token.address ?? 'native';

/** floor(notional × 10 / 10_000) in native units of the input token. */
export function flofiFeeAmount(notional: string | bigint): string {
  const n = typeof notional === 'bigint' ? notional : BigInt(notional);
  if (n < 0n) throw new Error('FLOFI_FEE_NOTIONAL_INVALID');
  return ((n * BigInt(FLOFI_WORKFLOW_FEE_BPS)) / FLOFI_WORKFLOW_FEE_DENOMINATOR).toString();
}

/** Durable obligation for a terminal universal-bridge run. One per workflow; never collected here. */
export function feeObligationFor(route: UniversalRoute, verdict: UniversalVerdict): FeeObligation {
  const notional = {
    chainId: route.sourceChain,
    token: tokenKey(route.inputToken),
    symbol: route.inputToken.symbol,
    decimals: route.inputToken.decimals,
    amount: route.inputAmount,
  };
  if (verdict === 'RECONCILED') {
    return {
      rateBps: FLOFI_WORKFLOW_FEE_BPS,
      basis: 'COMPLETED_WORKFLOW_INPUT',
      notional,
      feeAmount: flofiFeeAmount(route.inputAmount),
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
    rateBps: FLOFI_WORKFLOW_FEE_BPS,
    basis: 'COMPLETED_WORKFLOW_INPUT',
    notional,
    feeAmount: '0',
    status: 'WAIVED',
    collection: 'NOT_SETTLED',
    reason,
  };
}
