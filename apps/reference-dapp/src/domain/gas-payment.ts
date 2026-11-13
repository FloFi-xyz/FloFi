// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): how a Review words who pays the network fee and in which token, for the 0x Gasless swap
 * on Robinhood Chain. Presentation only: every amount is the reviewed record's own. The fee is never called "free" or "sponsored": the owner pays
 * it, in the swap's own token, and 0x takes it out of the trade. Protocol details (Settler, Permit2, trade hash, route sources) belong under
 * Technical details; the essentials stay visible.
 */

/** The label of the visible fee line of a 0x Gasless swap. Fee lines keep "network fee" in their label (the compact chat card matches it). */
export const INCLUDED_NETWORK_FEE_LABEL = 'Network fee (included in the swap)';
export const ZEROX_FEE_LABEL = '0x fee (included in the swap)';
export const SIGNATURES_LABEL = 'Signatures';
/** Whether a fee line is a network fee taken out of the swap itself (visible in every Review, never added to what is paid on top). */
export const isIncludedNetworkFee = (line: { readonly label: string; readonly treatment?: string }) =>
  line.treatment === 'INCLUDED' && line.label === INCLUDED_NETWORK_FEE_LABEL;

/** Why paying the network fee in tokens through 0x is not available for this swap: one sentence per closed reason, in plain words. */
const GASLESS_UNAVAILABLE: Readonly<Record<string, string>> = Object.freeze({
  ZEROX_GASLESS_NOT_ENABLED: 'Paying the network fee in tokens is not enabled on this FloFi server.',
  ZEROX_API_KEY_NOT_CONFIGURED: 'Paying the network fee in tokens is not enabled on this FloFi server.',
  ZEROX_CONFIGURATION_INVALID: 'Paying the network fee in tokens is not enabled on this FloFi server.',
  TOKEN_GAS_NOT_CONFIGURED: 'Paying the network fee in tokens is not enabled on this FloFi server.',
  ZEROX_GASLESS_CHAIN_UNSUPPORTED: 'Paying the network fee in tokens is not available on this network right now.',
  ZEROX_GASLESS_NATIVE_SELL_UNSUPPORTED: 'A swap that sells ETH cannot pay its network fee in tokens.',
  ZEROX_GASLESS_NATIVE_BUY_UNSUPPORTED: 'A swap into native ETH cannot pay its network fee in tokens yet. Swap into WETH instead.',
  ZEROX_GASLESS_APPROVAL_UNAVAILABLE: 'This token cannot be approved with a signature, and approving it needs ETH.',
  ZEROX_OWNER_NOT_EOA: 'This wallet is a smart account, which this fee option does not support.',
  ZEROX_SMART_WALLET_NOT_SUPPORTED: 'This wallet is a smart account, which this fee option does not support.',
  ZEROX_NO_LIQUIDITY: 'The provider has no liquidity for this pair and amount.',
  ZEROX_PAIR_NO_ROUTE: 'The provider has no route for this pair and amount.',
  ZEROX_SELL_AMOUNT_TOO_LOW: 'The amount is below the provider minimum for this option.',
  ZEROX_TOKEN_NOT_SUPPORTED: 'The provider does not support this token.',
  ZEROX_TOKEN_NOT_AUTHORIZED: 'The provider does not offer this token to FloFi.',
  ZEROX_STOCK_TOKEN_NOT_AUTHORIZED: 'The provider does not offer Stock Tokens to FloFi.',
  ZEROX_TAKER_NOT_AUTHORIZED: 'The provider does not accept this wallet.',
  ZEROX_INSUFFICIENT_BALANCE: 'The wallet balance is lower than this amount.',
  ZEROX_SPONSORED_QUOTE_REFUSED: 'The provider quote did not charge the network fee to this swap, so FloFi refused it.',
  ZEROX_QUOTE_EXPIRED: 'The provider quote expired too quickly to review and sign.',
  ZEROX_QUOTE_WORSE_THAN_REFERENCE: 'The provider quote pays less than FloFi\'s own Uniswap quote for this swap, beyond the provider\'s fees, so FloFi refused it.',
});
export function gaslessUnavailableReason(code: string): string {
  if (Object.hasOwn(GASLESS_UNAVAILABLE, code)) return GASLESS_UNAVAILABLE[code]!;
  if (/^ZEROX_PROVIDER_|_UNAVAILABLE$/.test(code)) return 'The provider did not answer. Try again shortly.';
  return 'FloFi could not verify the provider quote for this swap.';
}

/**
 * A gasless attempt as the shared transaction lifecycle reads it (signatures in the wallet, relayed to 0x, settled on chain, failed, declined).
 * Review CH2: a FAILED attempt is a final failure only once the server marked it `final` (the signed trade's deadline passed with its Permit2
 * nonce unused: it can never execute). Before that, 0x's "failed" (or a reverted candidate) is a hint the chain may still contradict, so it
 * reads as uncertain — kept under observation, never offered as a reason to swap again. REFUSED is 0x's definitive refusal of the submission:
 * nothing reached the chain, so it is "not submitted", never a failed action.
 */
export function gaslessLifecycleState(state: string, reconciled: boolean, final: boolean): string | null {
  switch (state) {
    case 'SIGNING': return 'PREPARED';
    case 'SUBMITTING': case 'SUBMITTED': return 'HASH';
    case 'UNKNOWN': return 'UNKNOWN';
    case 'PENDING': return 'PENDING';
    case 'CONFIRMED': return reconciled ? 'CONFIRMED' : 'PENDING';
    case 'FAILED': return final ? 'FAILED' : 'UNKNOWN';
    case 'REFUSED': return 'NOT_SUBMITTED';
    case 'REJECTED': return 'REJECTED';
    default: return null;
  }
}
/** The gasless states a page keeps following (read-only observe; nothing is signed or submitted again). */
const GASLESS_FOLLOWED: readonly string[] = Object.freeze(['SUBMITTING', 'SUBMITTED', 'UNKNOWN', 'PENDING']);
/**
 * Whether a gasless attempt may still settle on chain: relayed (or possibly relayed) to 0x and not settled, or a failure that is not final yet.
 * Such an attempt is observed until it settles, and no other swap is simulated for the page's run meanwhile (review CH2).
 */
export const gaslessUnsettled = (attempt: { readonly state: string; readonly final?: boolean } | undefined): boolean =>
  !!attempt && (GASLESS_FOLLOWED.includes(attempt.state) || attempt.state === 'FAILED' && attempt.final !== true);
