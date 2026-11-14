// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002, invariant S1: every submission FloFi broadcasts or relays names the account that pays its fees, and that
 * account must be the owner wallet the run bound — never a FloFi-controlled key (the delegated executor's AWS KMS session address, a harness
 * session key, a relayer) and never another user's wallet. The check is pure and runs before any bytes leave the process; a refusal is closed
 * and final for that submission.
 *
 * BUILD-FLOFI-MAINNET-EXEC-002 (ADR-0009) narrows the original "FloFi never sponsors" rule to exactly one exception, and only where the operator
 * configured it: an owner wallet batch whose network fee a pinned ERC-4337 paymaster pays through FloFi's paymaster proxy (`src/gas-sponsorship`).
 * There the owner's wallet still signs and sends; the proxy sponsors only the exact reviewed calls of that owner, within a per-operation cap and a
 * daily budget; reconciliation proves the payer is the pinned paymaster (`GasPaidFact.sponsored`). Nothing FloFi relays itself is ever sponsored:
 * this check still refuses any sponsorship field on a relayed submission.
 *
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010) adds token-paid network fees, where the OWNER still pays — in a token, inside what the
 * owner signs — and a pinned third party only fronts the native fee: Circle's paymaster (`paymasterAndData` naming the pinned Circle paymaster,
 * charged back in USDC under the owner's capped permit), Pimlico's hosted Kora (fee payer = the pinned Kora signer, paid back by an SPL transfer
 * the owner signs in the same transaction) and 0x Gasless (0x's relayer sends the owner-signed trade and takes its cost out of the trade). Such
 * a claim must carry `tokenFee`: the mechanism, the pinned relayer set, the relayer this submission names, and a positive token amount the owner
 * pays (zero would be a sponsorship, refused). Every other claim keeps the original rule: the owner wallet pays, nobody sponsors.
 */
export type GasPayerClaim = {
  /** What is about to be sent. */
  readonly kind: 'EVM_TRANSACTION' | 'EVM_USER_OPERATION' | 'EVM_WALLET_BATCH' | 'SOLANA_TRANSACTION' | 'EVM_GASLESS_INTENT';
  /** The account charged for the fees: an EVM transaction's `from`, a user operation's `sender` (no paymaster), a Solana transaction's fee payer. */
  readonly feePayer: string;
  /** The owner wallet of the run on that namespace. */
  readonly ownerWallet: string;
  /** Any sponsorship field: a 4337 `paymasterAndData`, an EIP-5792 `paymasterService` capability, a relayer. Must be empty. */
  readonly sponsorship?: string | null;
  /** Addresses this deployment controls (executor/session keys); the fee payer must not be one of them. */
  readonly flofiControlled?: readonly string[];
  /** ADR-0010: the owner pays the fee in a token through a pinned relayer (Circle paymaster, Kora signer, 0x). Absent: native, owner-paid. */
  readonly tokenFee?: TokenFeeClaim;
};
/**
 * ADR-0010 token-paid fee. `relayer`: the pinned party that fronts the native fee for this submission — the Circle paymaster named in
 * `paymasterAndData` (EVM_USER_OPERATION), the Kora signer that is the transaction's fee payer (SOLANA_TRANSACTION), or 0x's Settler the trade is
 * signed for (EVM_GASLESS_INTENT). `amount`: what the owner pays for it in `token` base units (a cap or the exact quote) — never zero.
 */
export type TokenFeeClaim = { readonly mechanism: 'CIRCLE_USDC_PAYMASTER' | 'PIMLICO_KORA_SPL_FEE' | 'ZEROX_GASLESS_SWAP'; readonly relayer: string;
  readonly pinnedRelayers: readonly string[]; readonly token: string; readonly amount: string };
const TOKEN_FEE_KIND: Readonly<Record<TokenFeeClaim['mechanism'], GasPayerClaim['kind']>> = Object.freeze({
  CIRCLE_USDC_PAYMASTER: 'EVM_USER_OPERATION', PIMLICO_KORA_SPL_FEE: 'SOLANA_TRANSACTION', ZEROX_GASLESS_SWAP: 'EVM_GASLESS_INTENT',
});
export const GAS_PAYER_CODES = Object.freeze({
  notOwner: 'GAS_PAYER_NOT_OWNER', flofiControlled: 'EXECUTOR_GAS_PAYER_REFUSED', sponsored: 'GAS_SPONSORSHIP_REFUSED', invalid: 'GAS_PAYER_UNKNOWN',
  tokenFeeInvalid: 'TOKEN_GAS_CLAIM_INVALID', relayerNotPinned: 'TOKEN_GAS_RELAYER_NOT_PINNED',
});
const norm = (kind: GasPayerClaim['kind'], address: string) => kind === 'SOLANA_TRANSACTION' ? address : address.toLowerCase();
/** Throws unless the owner wallet pays, nobody sponsors, and no FloFi-controlled address is involved. */
export function assertUserFundedSubmission(claim: GasPayerClaim): void {
  if (typeof claim.feePayer !== 'string' || !claim.feePayer || typeof claim.ownerWallet !== 'string' || !claim.ownerWallet) throw new Error(GAS_PAYER_CODES.invalid);
  if (claim.tokenFee !== undefined) return assertTokenFeeSubmission(claim, claim.tokenFee);
  if (claim.kind === 'EVM_GASLESS_INTENT') throw new Error(GAS_PAYER_CODES.tokenFeeInvalid);
  if (claim.sponsorship !== undefined && claim.sponsorship !== null && claim.sponsorship !== '' && claim.sponsorship !== '0x') throw new Error(GAS_PAYER_CODES.sponsored);
  const payer = norm(claim.kind, claim.feePayer);
  if ((claim.flofiControlled ?? []).some(a => norm(claim.kind, a) === payer)) throw new Error(GAS_PAYER_CODES.flofiControlled);
  if (payer !== norm(claim.kind, claim.ownerWallet)) throw new Error(GAS_PAYER_CODES.notOwner);
}
/**
 * ADR-0010: a token-paid claim. The relayer must be one of the pinned ones and never a FloFi-controlled key; the owner must pay a positive amount;
 * the claim kind must be the mechanism's own; and the submission must actually name that relayer — Circle: `sponsorship` (paymasterAndData) starts
 * with the paymaster and `feePayer` is the owner's account (the sender); Kora: `feePayer` IS the Kora signer; 0x: `feePayer` IS 0x (its relayer
 * sends) and nothing else is sponsored.
 */
function assertTokenFeeSubmission(claim: GasPayerClaim, fee: TokenFeeClaim): void {
  const key = (a: string) => norm(claim.kind, a);
  if (TOKEN_FEE_KIND[fee.mechanism] !== claim.kind || typeof fee.relayer !== 'string' || !fee.relayer || !Array.isArray(fee.pinnedRelayers) ||
      typeof fee.token !== 'string' || !fee.token || typeof fee.amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(fee.amount)) throw new Error(GAS_PAYER_CODES.tokenFeeInvalid);
  const relayer = key(fee.relayer);
  if (!fee.pinnedRelayers.some(r => typeof r === 'string' && key(r) === relayer)) throw new Error(GAS_PAYER_CODES.relayerNotPinned);
  if ((claim.flofiControlled ?? []).some(a => key(a) === relayer || key(a) === key(claim.feePayer))) throw new Error(GAS_PAYER_CODES.flofiControlled);
  if (relayer === key(claim.ownerWallet)) throw new Error(GAS_PAYER_CODES.tokenFeeInvalid);
  if (fee.mechanism === 'CIRCLE_USDC_PAYMASTER') {
    const data = typeof claim.sponsorship === 'string' ? claim.sponsorship.toLowerCase() : '';
    if (!/^0x[0-9a-f]{40}/.test(data) || data.slice(0, 42) !== relayer) throw new Error(GAS_PAYER_CODES.sponsored);
    if (key(claim.feePayer) !== key(claim.ownerWallet)) throw new Error(GAS_PAYER_CODES.notOwner);
    return;
  }
  if (claim.sponsorship !== undefined && claim.sponsorship !== null && claim.sponsorship !== '' && claim.sponsorship !== '0x') throw new Error(GAS_PAYER_CODES.sponsored);
  if (key(claim.feePayer) !== relayer) throw new Error(GAS_PAYER_CODES.notOwner);
}
/** What the owner paid for the fee in a token (ADR-0010), beside the native amount the relayer fronted. */
export type TokenFeePaid = { readonly mechanism: TokenFeeClaim['mechanism']; readonly token: string; readonly symbol: string; readonly decimals: number;
  readonly amount: string; readonly payee: string };
/** The evidence line every reconciled user-funded submission carries: who paid and how much (native units of the chain). */
export type GasPaidFact = { readonly payer: string; readonly amount: string; readonly unit: 'wei' | 'lamports'; readonly source: 'RECEIPT' | 'USER_OPERATION_EVENT' | 'SOLANA_META';
  /** ADR-0009: the network fee was paid by FloFi's pinned paymaster (`payer`), not the owner; absent: the owner paid. */
  readonly sponsored?: true;
  /**
   * ADR-0010: `payer` fronted the native fee (`amount`, native units) and the OWNER paid it back in a token — this amount, proven from the same
   * transaction's logs. Never together with `sponsored`.
   */
  readonly paidInToken?: TokenFeePaid };
