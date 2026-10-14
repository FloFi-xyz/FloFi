// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Presentation only: why a Solana request ended before submission, in the owner's terms. Every case here means FloFi broadcast
 * nothing for the attempt (the run records `notSubmitted`), so starting again from a fresh Simulate → Review → Execute cannot
 * repeat a transaction. A declined request is presented by the shared "declined" result instead.
 */
import { LIGHTHOUSE_PROGRAM, walletAppendedInstructions, type SolanaWalletChange } from '@defi-workflow-engine/reference-compiler';

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const programName = (program: string) => program === LIGHTHOUSE_PROGRAM ? 'Lighthouse' : program === COMPUTE_BUDGET ? 'Compute Budget' : `${program.slice(0, 4)}…${program.slice(-4)}`;
/** A catalog message and its values; render it with `tr(text, ...args)` so the exact catalog entry is used in every language. */
export type SolanaRefusalReason = { text: string; args: string[] };
const reason = (text: string, ...args: string[]): SolanaRefusalReason => ({ text, args });

export function solanaNotSubmittedReason(code: string | null | undefined, change?: SolanaWalletChange | null): SolanaRefusalReason | null {
  if (!code || /_WALLET_REJECTED$/.test(code)) return null;
  if (/_TRANSACTION_CHANGED$/.test(code)) {
    if (change && walletAppendedInstructions(change)) return reason('Your wallet added {0} instruction(s) from {1} to the transaction you reviewed before signing it. FloFi sends only the exact transaction you reviewed, so it did not send this one and nothing reached Solana. Simulate again for a fresh Review.',
      String(change.added.length), change.addedPrograms.map(programName).join(', '));
    return reason('Your wallet returned a different transaction than the one you reviewed. FloFi did not send it, and nothing reached Solana. Simulate again for a fresh Review.');
  }
  if (/_(QUOTE|REVIEW)_STALE$/.test(code)) return reason('The reviewed quote expired before your wallet returned the signature. FloFi did not send the transaction, and nothing reached Solana. Simulate again for a fresh quote and Review.');
  if (/_SIGNATURE_INVALID$/.test(code)) return reason('The signature your wallet returned does not match the reviewed transaction and account. FloFi did not send it, and nothing reached Solana. Simulate again for a fresh Review.');
  if (/_WRONG_CLUSTER$/.test(code)) return reason('Your wallet is connected to a different Solana cluster than this workflow. Nothing was sent. Switch the wallet’s network, then simulate again.');
  if (/_WALLET_NOT_SUBMITTED$/.test(code)) return reason('No signed transaction was returned before this request was recovered. Nothing was sent. Simulate again for a fresh Review.');
  return reason('Your wallet did not return a usable signed transaction ({0}). FloFi sent nothing, and nothing reached Solana. Simulate again for a fresh Review.', code);
}
