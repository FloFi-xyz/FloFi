// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (WS-REVENUE): the canonical FloFi platform fee.
 *
 * One fee per successfully completed workflow execution: 80 basis points (0.80%) of the execution's feeable principal, the capital the
 * owner independently introduced into the workflow. Integer arithmetic only (native units of each asset, floor division, so the fee is
 * never rounded up). Gas, provider and protocol fees are never part of the basis; neither is collateral, a position's value or a borrowed
 * amount. Every surface and the ledger read this module; nothing else carries a rate.
 *
 * This module defines what is owed. Whether it is collected is a separate, fail-closed activation decision (`activation.ts`).
 */
import type { StrategyAction } from '../engine/strategy-spec';

/** 80 basis points = 0.80%. */
export const PLATFORM_FEE_BPS = 80;
export const PLATFORM_FEE_DENOMINATOR = 10_000n;
/**
 * The identity of the fee policy an execution was authorized under. Any change to the rate, the basis or the applicability table
 * below is a new identity, and an execution authorized under another identity must be reviewed again (`policyChanged`).
 */
export const PLATFORM_FEE_POLICY_ID = 'flofi-platform-fee/v2-80bps';
/**
 * The first instant this policy applies to (an execution created earlier was reviewed under an earlier one). Accounting never starts before it
 * (`activation.ts`), so an execution is only ever accounted under the policy in force when it was created. A new policy changes the id AND this
 * instant together; executions created before the new instant are then never accounted under the new policy (F15).
 */
export const PLATFORM_FEE_POLICY_EFFECTIVE_FROM = new Date('2026-11-27T00:00:00.000Z');
/** The rate as the product shows it: "0.80%" (English) / "0,80%" (Portuguese). */
export const PLATFORM_FEE_PERCENT_LABEL = '0.80%';
export const PLATFORM_FEE_PERCENT_LABEL_PT = '0,80%';

/** floor(principal × 80 / 10 000), in the principal's native units. */
export function platformFeeAmount(principal: string | bigint): bigint {
  const n = typeof principal === 'bigint' ? principal : /^(0|[1-9][0-9]{0,77})$/.test(principal) ? BigInt(principal) : -1n;
  if (n < 0n) throw new Error('PLATFORM_FEE_PRINCIPAL_INVALID');
  return (n * BigInt(PLATFORM_FEE_BPS)) / PLATFORM_FEE_DENOMINATOR;
}

/**
 * How each action's wallet input counts towards the principal.
 *   FEEABLE         the owner's own capital enters the workflow (swap, bridge, supply, a transfer or a Batch Payment leg)
 *   NOT_APPLICABLE  no approved accounting policy yet: repay (debt service), borrow and withdraw (no wallet input; their output is
 *                   capital the workflow did not receive from the owner's wallet), liquidity management and the Base Sepolia
 *                   lending composition. Never charged; their outputs still cover later steps, so nothing downstream is charged twice.
 * Stock-token swaps are NOT_APPLICABLE as well (classified per asset in `principal.ts`).
 */
export const ACTION_FEE_POLICY: Readonly<Record<StrategyAction, 'FEEABLE' | 'NOT_APPLICABLE'>> = Object.freeze({
  swap: 'FEEABLE', bridge: 'FEEABLE', supply: 'FEEABLE', transfer: 'FEEABLE', batch_payment: 'FEEABLE',
  repay: 'NOT_APPLICABLE', borrow: 'NOT_APPLICABLE', withdraw: 'NOT_APPLICABLE', add_liquidity: 'NOT_APPLICABLE', lending_composition: 'NOT_APPLICABLE',
});

/** Whether an execution authorized under `authorizedPolicyId` must be reviewed again because the fee policy changed since. */
export const policyChanged = (authorizedPolicyId: string | null | undefined): boolean =>
  typeof authorizedPolicyId === 'string' && authorizedPolicyId !== PLATFORM_FEE_POLICY_ID;
