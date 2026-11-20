// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-RELIABILITY-GLOBAL-PRECISION-001: the Uniswap v3 liquidity runtime's reading of the shared network-fee rule at reconciliation
 * (mints and position operations). The rule itself is `@defi-workflow-engine/workflow-contracts` network-fee.ts.
 */
import { authorizedNetworkFee, chargedNetworkFeeWithinAuthorization, type NetworkFeeAuthorization } from '@defi-workflow-engine/workflow-contracts';
/**
 * The overrun note of a confirmed transaction whose charged network fee (execution + uncapped L1) ended above the authorized maximum, or null.
 * `charged` null: not the owner's own transaction (a relayer-paid delegated redemption), whose fee the owner did not pay.
 */
export function overrunNote(authorized: NetworkFeeAuthorization, charged: { gasUsed: bigint; effectiveGasPrice: bigint; l1Fee: bigint } | null): string | null {
  if (!charged || chargedNetworkFeeWithinAuthorization(authorized, charged)) return null;
  return `UNISWAP_NETWORK_FEE_ABOVE_AUTHORIZED:${charged.gasUsed * charged.effectiveGasPrice + charged.l1Fee}:${authorizedNetworkFee(authorized)}`;
}
