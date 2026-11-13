// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: the network-fee bound an owner authorizes at Review, and the one rule every execution boundary
 * applies to it.
 *
 * An EVM request's network fee has two parts:
 *  - execution gas, capped by the transaction itself (`gas × maxFeePerGas`; `maxFeePerGas` already carries the 2× base-fee headroom);
 *  - on OP Stack networks (Base), the L1 data fee, which the transaction cannot cap: the sequencer charges it from the L1 base fee and
 *    blob base fee current at inclusion. Those move every L1 block (production 2026-11-13: ×2.24 in 54 seconds).
 *
 * Production 2026-11-13 refused every Base bridge within 15–54 seconds of its Review (`ROUTER_L1_FEES_CHANGED_REVIEW_REQUIRED`) because the
 * reviewed L1 bound was the instantaneous `getL1FeeUpperBound` with no headroom at all, and the execution boundary compared the L1 part
 * alone. The owner authorizes one figure — "Network fee, at most X" — so:
 *  - Review: the L1 part of X carries the same 2× headroom as the execution part (`l1FeeReviewBound`);
 *  - execution boundary: the request stands while the network fee it would cost at the current prices is within X
 *    (`networkFeeWithinAuthorization`); once it is not, the change exceeds what was authorized and a fresh Review is required;
 *  - reconciliation: the fee actually charged is checked against X (`chargedNetworkFeeWithinAuthorization`).
 * Wallet-controlled fields (gas limit, max fee, priority fee, nonce) are still compared exactly wherever they were before.
 */

/** Headroom applied to an L1 data fee estimate at Review, as the execution part's `maxFeePerGas = 2 × base fee + priority`. */
export const L1_FEE_REVIEW_HEADROOM = 2n;
/** The reviewed (authorized) L1 data fee bound for an estimate read at Review. */
export const l1FeeReviewBound = (estimate: bigint): bigint => estimate * L1_FEE_REVIEW_HEADROOM;

export type NetworkFeeAuthorization = {
  /** The reviewed transaction's gas limit and max fee per gas (what the wallet signs). */
  readonly gasLimit: bigint; readonly maxFeePerGas: bigint;
  /** The reviewed L1 data fee bound of this call (0 off OP Stack). */
  readonly l1FeeBound: bigint;
};
/** The network fee the owner authorized for one call: its execution cap plus its L1 bound. */
export const authorizedNetworkFee = (a: NetworkFeeAuthorization): bigint => a.gasLimit * a.maxFeePerGas + a.l1FeeBound;
/**
 * At the execution boundary: the call's network fee at the current gas price and the current L1 estimate is within the authorized
 * maximum. The current price must also be within the signed `maxFeePerGas` (callers check that first, as before).
 */
export function networkFeeWithinAuthorization(a: NetworkFeeAuthorization, current: { readonly gasPrice: bigint; readonly l1Fee: bigint }): boolean {
  if (current.gasPrice < 0n || current.l1Fee < 0n) return false;
  return a.gasLimit * current.gasPrice + current.l1Fee <= authorizedNetworkFee(a);
}
/** At reconciliation: the fee the network actually charged (gas used × effective price + L1 fee) is within the authorized maximum. */
export function chargedNetworkFeeWithinAuthorization(a: NetworkFeeAuthorization, charged: { readonly gasUsed: bigint; readonly effectiveGasPrice: bigint; readonly l1Fee: bigint }): boolean {
  return charged.gasUsed * charged.effectiveGasPrice + charged.l1Fee <= authorizedNetworkFee(a);
}
