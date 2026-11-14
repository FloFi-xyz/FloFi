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
  CIRCLE_ACCOUNT_NONCE_PENDING: 'this wallet has a transaction still pending on this network',
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
  // The server refused the authorization: the preparation expired and the group is planned again, so authorizing again prepares it with the fee
  // as it is paid now (shown before the wallet is asked). The Editor, whose whole-workflow Review bound the mechanism, words its own path.
  GAS_MECHANISM_CHANGED_REVIEW_REQUIRED: 'How the network fee is paid changed since it was shown to you: your ETH on this network now covers it, or no longer does. Nothing was sent. Authorize again to see the request with the fee as it is paid now.',
  // Review C2: never (re)sent at or after its calls' deadline minus a margin; review C3: a bundler that cannot carry the account's operation.
  CIRCLE_OPERATION_DEADLINE_PASSED: 'FloFi did not send this request after its time window ended (it would only have failed and still cost you the network fee in USDC). It did not execute, and no network fee was taken.',
  USER_OPERATION_ENTRY_POINT_UNSUPPORTED: 'The service that relays this request does not support this smart-account version on this network, so nothing was sent. Load the request again to see how the network fee can be paid.',
  // Owner requirement (FloFi Wallet + Circle): the EIP-7702 upgrade of a FloFi Wallet address inside its first Circle-paid operation.
  CIRCLE_UPGRADE_DECLINED: 'You did not agree to the smart-account upgrade, so nothing was signed or sent. Add ETH on this network to pay the network fee instead.',
  CIRCLE_UPGRADE_CONSENT_REQUIRED: 'Agree to the smart-account upgrade first. Nothing was signed or sent.',
  CIRCLE_AUTHORIZATION_INVALID: 'The smart-account upgrade signature could not be verified, so nothing was sent. Try again.',
  CIRCLE_AUTHORIZATION_STALE: 'This wallet changed since your review (another transaction or upgrade), so the upgrade was not used and nothing was sent. Load the request again.',
  CIRCLE_AUTHORIZATION_STAGE_INVALID: 'This request already moved on. Nothing was sent; load it again.',
  CIRCLE_UPGRADE_NOT_PREPARED: 'This request has no smart-account upgrade to agree to. Nothing was signed or sent.',
  // "Not now" on the consent card: refused for a request already signed in part, or one that is not a FloFi Wallet group's Circle fee.
  CIRCLE_DECLINE_ALREADY_SIGNED: 'You already signed part of this request, so FloFi keeps it as it is. Nothing more was signed or sent.',
  CIRCLE_DECLINE_NOT_APPLICABLE: 'This request has no network fee in USDC to decline. Nothing was signed or sent.',
  // Final review (P1): FloFi Wallet is asked once per signature of a prepared request (the single-use claim); a cancel there, or an answer that
  // never arrived, spends it. A new preparation is a new request (its own claim): the way forward is to let this one expire and continue.
  FLOFI_WALLET_ALREADY_SIGNED: 'FloFi Wallet was already asked for this signature once (if you cancelled it there, nothing was signed), so FloFi does not ask it again for this request. Nothing was sent. This request expires within a few minutes; then continue, and FloFi prepares a new one for you to sign.',
  FLOFI_WALLET_SIGNATURE_UNKNOWN: 'FloFi Wallet may have signed, but FloFi did not receive the signature, so nothing was sent. This request expires within a few minutes; then continue, and FloFi prepares a new one for you to sign.',
};
/**
 * Review UX1: the Editor's whole-workflow Review bound who pays group 1's network fee (ETH, or USDC through Circle). The run prepared it with the
 * other mechanism (the owner's ETH now covers the fee, or no longer does): nothing switches silently, and this run cannot be reviewed again in
 * place, so the way forward is to end it (nothing of it was signed) and review the workflow again.
 */
export const EDITOR_MECHANISM_CHANGED = 'How the network fee is paid changed since your review: your ETH on this network now covers it, or no longer does. Nothing was sent. End this workflow and review it again to see how the fee is paid now.';
/**
 * Final review (P3): the same change, found by Authorize before the first group was prepared (the Review's mechanism travels with it): nothing of
 * the run was stored or asked of the wallet, and the run was ended at once, so the way forward is only to review again.
 */
export const EDITOR_MECHANISM_CHANGED_NOT_STARTED = 'How the network fee is paid changed since your review: your ETH on this network now covers it, or no longer does. Nothing was signed or sent, and this workflow was not started. Review it again to see how the fee is paid now.';
/**
 * Review UX1: the USDC cap of a Circle-paid request rose above the one the owner accepted (both are computed from the live gas price and the
 * verified ETH/USD price, so any upward move between Review and Authorize raises it). Never a refusal and never applied silently: the new cap is
 * shown beside the reviewed one and the owner confirms it before the wallet is asked (the Editor's confirm-update step, like a lower minimum).
 * A cap at or below the accepted one needs no confirmation (the owner pays at most what they accepted).
 */
export const CIRCLE_FEE_CAP_ROSE_CONFIRM = 'CIRCLE_FEE_CAP_ROSE_CONFIRM';
/** The confirm-update line of a Circle fee: {0} the new cap, {1} the reviewed one (rose), or the cap alone when this tab never showed one. */
export const CIRCLE_FEE_CONFIRM: Readonly<Record<'ROSE' | 'NEW', string>> = {
  ROSE: 'Network fee, at most {0} — paid from your USDC through Circle (reviewed {1}: the network fee or the ETH price moved since your review)',
  NEW: 'Network fee, at most {0} — paid from your USDC through Circle',
};
/**
 * Review B1/LQ1 (ADR-0010 §2, `gas-abstraction/native-later.ts`): one visible warning per chain, before the first signature, when a later step
 * there needs the native coin for its network fee after an earlier step whose fee may be paid in a token: {0} the network, {1} ETH or SOL, {2}
 * the later steps ("step 3 (Add liquidity)"). It never cancels the design and never claims the owner's balance.
 */
export const NATIVE_LATER: Readonly<Record<'ONE' | 'MANY' | 'STEP', string>> = {
  ONE: 'A later step on {0} needs {1} for its network fee: {2}. Add {1} before starting, or the run will stop there.',
  MANY: 'Later steps on {0} need {1} for their network fee: {2}. Add {1} before starting, or the run will stop there.',
  STEP: 'step {0} ({1})',
};
/** The warning in the reader's language: `tr` translates, `action` names a step's action (translated). */
export function nativeLaterMessage(warning: { readonly network: string; readonly symbol: string; readonly steps: readonly { readonly index: number; readonly action: string }[] },
  tr: (key: string, ...parameters: string[]) => string, action: (action: string) => string): string {
  const steps = warning.steps.map(step => tr(NATIVE_LATER.STEP, String(step.index + 1), action(step.action))).join(', ');
  return tr(warning.steps.length === 1 ? NATIVE_LATER.ONE : NATIVE_LATER.MANY, tr(warning.network), warning.symbol, steps);
}
/** The Circle refusals the browser itself raises before any wallet request: nothing was sent. */
export const CIRCLE_NOTHING_SENT: readonly string[] = Object.freeze(['CIRCLE_WALLET_UNSUPPORTED', 'CIRCLE_PERMIT_MISMATCH', 'CIRCLE_UPGRADE_DECLINED']);

/**
 * Owner requirement (FloFi Wallet + Circle): FloFi's own consent card (`components/circle-consent-card.tsx`), shown on /approve before FloFi Wallet
 * is asked anything for a group whose network fee would be paid in USDC through Circle. Privy shows no confirmation screen for an EIP-7702
 * authorization, so this card is the owner's explicit confirmation of the upgrade (the signing gate refuses the authorization until it was
 * recorded). `{0}`: the network. The first use upgrades the address (three signatures); once upgraded, the card asks about the fee alone (two).
 */
export const CIRCLE_UPGRADE_CONSENT: Readonly<Record<'TITLE' | 'WHAT' | 'UNCHANGED' | 'STAYS' | 'SIGNATURES' | 'AGREE', string>> = {
  TITLE: 'Upgrade this FloFi Wallet address to pay the network fee in USDC',
  WHAT: 'The upgrade is an EIP-7702 delegation of this FloFi Wallet address on {0} to the open-source Simple7702Account contract, so the network fee can be paid in USDC.',
  UNCHANGED: 'Your address, balances and control do not change.',
  STAYS: 'The upgrade stays until you replace it.',
  SIGNATURES: 'Three signatures follow this first time: the upgrade, a USDC permit, then the operation.',
  AGREE: 'Upgrade and continue',
};
export const CIRCLE_FEE_CONSENT: Readonly<Record<'TITLE' | 'WHAT' | 'SIGNATURES' | 'AGREE', string>> = {
  TITLE: 'Pay this network fee in USDC through Circle',
  WHAT: 'Your ETH on {0} does not cover this network fee. FloFi Wallet can pay it from your USDC through Circle instead.',
  SIGNATURES: 'Two signatures follow: a USDC permit, then the operation.',
  AGREE: 'Pay in USDC and continue',
};
/**
 * Owner requirement (FloFi Wallet + Circle), the Editor's step-by-step Review (`EditorExecutionReview.circleOnApproval`): where paying the fee in USDC
 * with FloFi Wallet is really available (a user-funded run approved on /approve), and that every step run here pays its network fee in ETH.
 */
export const CIRCLE_ON_APPROVAL = 'Paying the network fee in USDC through Circle with FloFi Wallet is available when a workflow is approved through a FloFi approval link (/approve) and authorized in groups. Here each step runs on its own and pays its network fee in ETH.';
/** Both cards' way out, what it does, and what /approve says once it was chosen (`{0}`: the step number). */
export const CIRCLE_CONSENT_DECLINE: Readonly<Record<'ACTION' | 'NOTE' | 'DONE', string>> = {
  ACTION: 'Not now',
  NOTE: 'Choosing Not now signs nothing: the step continues through its own review, which pays its network fee in ETH.',
  DONE: 'Nothing was signed. Step {0} continues through its own review, which pays its network fee in ETH.',
};
