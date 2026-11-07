// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002, invariant S1: FloFi never pays, advances, sponsors or reimburses network gas for a user's workflow.
 * Every submission FloFi broadcasts or relays names the account that pays its fees, and that account must be the owner wallet the run
 * bound — never a FloFi-controlled key (the delegated executor's AWS KMS session address, a harness session key, a relayer) and never
 * another user's wallet. The check is pure and runs before any bytes leave the process; a refusal is closed and final for that submission.
 */
export type GasPayerClaim = {
  /** What is about to be sent. */
  readonly kind: 'EVM_TRANSACTION' | 'EVM_USER_OPERATION' | 'EVM_WALLET_BATCH' | 'SOLANA_TRANSACTION';
  /** The account charged for the fees: an EVM transaction's `from`, a user operation's `sender` (no paymaster), a Solana transaction's fee payer. */
  readonly feePayer: string;
  /** The owner wallet of the run on that namespace. */
  readonly ownerWallet: string;
  /** Any sponsorship field: a 4337 `paymasterAndData`, an EIP-5792 `paymasterService` capability, a relayer. Must be empty. */
  readonly sponsorship?: string | null;
  /** Addresses this deployment controls (executor/session keys); the fee payer must not be one of them. */
  readonly flofiControlled?: readonly string[];
};
export const GAS_PAYER_CODES = Object.freeze({
  notOwner: 'GAS_PAYER_NOT_OWNER', flofiControlled: 'EXECUTOR_GAS_PAYER_REFUSED', sponsored: 'GAS_SPONSORSHIP_REFUSED', invalid: 'GAS_PAYER_UNKNOWN',
});
const norm = (kind: GasPayerClaim['kind'], address: string) => kind === 'SOLANA_TRANSACTION' ? address : address.toLowerCase();
/** Throws unless the owner wallet pays, nobody sponsors, and no FloFi-controlled address is involved. */
export function assertUserFundedSubmission(claim: GasPayerClaim): void {
  if (typeof claim.feePayer !== 'string' || !claim.feePayer || typeof claim.ownerWallet !== 'string' || !claim.ownerWallet) throw new Error(GAS_PAYER_CODES.invalid);
  if (claim.sponsorship !== undefined && claim.sponsorship !== null && claim.sponsorship !== '' && claim.sponsorship !== '0x') throw new Error(GAS_PAYER_CODES.sponsored);
  const payer = norm(claim.kind, claim.feePayer);
  if ((claim.flofiControlled ?? []).some(a => norm(claim.kind, a) === payer)) throw new Error(GAS_PAYER_CODES.flofiControlled);
  if (payer !== norm(claim.kind, claim.ownerWallet)) throw new Error(GAS_PAYER_CODES.notOwner);
}
/** The evidence line every reconciled user-funded submission carries: who paid and how much (native units of the chain). */
export type GasPaidFact = { readonly payer: string; readonly amount: string; readonly unit: 'wei' | 'lamports'; readonly source: 'RECEIPT' | 'USER_OPERATION_EVENT' | 'SOLANA_META' };
