// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): how a network fee reads when the owner may pay it in a token — presentation only.
 *
 *   amounts   a native fee in wei reads as ETH, in lamports as SOL, a token fee in its own symbol and decimals — never a token amount as ETH.
 *             A fee (a ceiling, or what was paid) is rounded UP to at most 6 decimals, never shown below itself; a non-zero fee never reads 0.
 *   reasons   why the token-paid alternative (Circle) was not offered for a group whose owner lacks native gas, in plain words (the closed codes
 *             come from `user-funded/circle-gas.ts`; any other code reads as "not available here").
 */

/** A fee's amount as text: `unit` 'wei' | 'lamports' | 'token' (with `token`); anything else is shown raw with its unit, never as ETH. */
export function feeAmountText(amount: string, unit: string, token?: { readonly symbol: string; readonly decimals: number } | null, round: 'up' | 'down' = 'up'): string {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(amount)) return '—';
  const known = unit === 'wei' ? { symbol: 'ETH', decimals: 18 } : unit === 'lamports' ? { symbol: 'SOL', decimals: 9 }
    : unit === 'token' && token && Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 36 ? token : null;
  if (!known) return `${amount} ${unit}`;
  const v = BigInt(amount), d = known.decimals, keep = Math.min(6, d), step = 10n ** BigInt(d - keep), scale = 10n ** BigInt(d);
  const shown = round === 'up' ? (v + step - 1n) / step * step : v / step * step;
  if (v > 0n && shown === 0n) return `< ${keep ? `0.${'0'.repeat(keep - 1)}1` : '1'} ${known.symbol}`;
  const whole = shown / scale, fraction = d ? (shown % scale).toString().padStart(d, '0').slice(0, keep).replace(/0+$/, '') : '';
  return `${whole}${fraction ? `.${fraction}` : ''} ${known.symbol}`;
}

/** Plain words for why paying the fee in USDC through Circle is not available for a group (shown with the native-fee shortfall). */
export const CIRCLE_UNAVAILABLE_REASON: Readonly<Record<string, string>> = {
  CIRCLE_SMART_ACCOUNT_REQUIRED: 'this wallet is not a smart account on this network',
  CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED: 'Circle does not support this smart-account version on this network',
  CIRCLE_ACCOUNT_UNSUPPORTED: 'this smart-account type is not supported',
  CIRCLE_WALLET_UNSUPPORTED: 'FloFi Wallet cannot sign it',
  CIRCLE_WALLET_UNKNOWN: 'the wallet that would sign it was not identified',
  CIRCLE_BUNDLER_ENTRY_POINT_UNSUPPORTED: 'the service that relays it does not support this smart-account version on this network',
  CIRCLE_INSUFFICIENT_USDC: 'this wallet does not hold enough USDC for the steps and the fee',
  CIRCLE_PRICE_UNAVAILABLE: 'no verified ETH price is available right now',
  CIRCLE_PAYMASTER_UNVERIFIED: 'Circle\'s contract could not be verified on this network',
  CIRCLE_NATIVE_VALUE_UNCOVERED: 'this request also sends ETH that this wallet does not hold',
  USER_OPERATION_BUNDLER_UNAVAILABLE: 'the service that relays it is not available on this network',
  USER_FUNDED_SIMULATION_UNAVAILABLE: 'this network cannot simulate the whole request',
  USER_FUNDED_RPC_UNAVAILABLE: 'the network could not be read just now',
};
/** The plain reason for one closed code (a generic one for any code not listed). */
export const circleUnavailableReason = (code: string): string => CIRCLE_UNAVAILABLE_REASON[code.split(':')[0]!] ?? 'it is not available here';

/** Refusals of a Circle-paid request in plain words (the Editor's and /approve's refusal tables): each one is before anything is relayed. */
export const CIRCLE_REFUSAL: Readonly<Record<string, string>> = {
  CIRCLE_PERMIT_INVALID: 'Your USDC permit for the network fee could not be verified, so nothing was sent. Try again.',
  CIRCLE_PERMIT_EXPIRED: 'Another USDC permit from this wallet replaced the one for this network fee, so it can no longer pay it. Nothing was sent.',
  CIRCLE_PERMIT_CAP_EXCEEDED: 'The network fee rose above the USDC amount you approved, so nothing was sent. Ask again for a request with the new fee.',
  CIRCLE_PERMIT_REQUIRED: 'Sign the USDC permit for the network fee first. Nothing was sent.',
  CIRCLE_PERMIT_STAGE_INVALID: 'This request already moved on. Nothing was sent; load it again.',
  CIRCLE_PERMIT_MISMATCH: 'What your wallet would sign did not match the network fee FloFi showed, so your wallet was not asked. Nothing was sent.',
  CIRCLE_WALLET_UNSUPPORTED: 'FloFi Wallet cannot pay network fees in USDC. Add ETH on this network to this wallet, or use a wallet with a smart account. Nothing was sent.',
  CIRCLE_PAYMASTER_REFUSED: 'Circle declined to take this network fee in USDC just now. Nothing was sent; try again later, or add ETH on this network.',
  CIRCLE_INSUFFICIENT_USDC: 'This wallet does not hold enough USDC for the steps and the network fee. Nothing was sent.',
  CIRCLE_PAYMASTER_GAS_INVALID: 'The network fee of this request could not be bounded, so nothing was sent. Try again.',
  CIRCLE_OPERATION_INVALID: 'The prepared request did not match what you approved, so nothing was sent.',
  GAS_MECHANISM_CHANGED_REVIEW_REQUIRED: 'Who pays the network fee changed since your review (ETH arrived in or left this wallet). Nothing was sent; review again.',
  // Review C2: never (re)sent at or after its calls' deadline minus a margin; review C3: a bundler that cannot carry the account's operation.
  CIRCLE_OPERATION_DEADLINE_PASSED: 'FloFi did not send this request after its time window ended (it would only have failed and still cost you the network fee in USDC). It did not execute, and no network fee was taken.',
  USER_OPERATION_ENTRY_POINT_UNSUPPORTED: 'The service that relays this request does not support this smart-account version on this network, so nothing was sent. Load the request again to see how the network fee can be paid.',
};
/** The Circle refusals the browser itself raises before any wallet request: nothing was sent. */
export const CIRCLE_NOTHING_SENT: readonly string[] = Object.freeze(['CIRCLE_WALLET_UNSUPPORTED', 'CIRCLE_PERMIT_MISMATCH']);
