// SPDX-License-Identifier: Apache-2.0
import { SOLANA_MAINNET_TRANSFER, type SolanaTransferAsset } from './solana-transfer.js';
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02): Batch Payment on Solana mainnet-beta, executed as ONE atomic owner-signed v0
 * transaction (no address lookup tables) whose legs are each byte-identical to a reviewed single Solana transfer: System `Transfer` for SOL, ATA
 * `CreateIdempotent` + `TransferChecked` for SPL tokens. Mainnet only (no Devnet batch). Only the registry's fully verified transfer assets are
 * advertised: SOL, USDC and USDT (classic SPL Token); Token-2022 and arbitrary mints are refused.
 *
 * Bounds (measured with the repository codec; the compiler refuses before signing whenever any is exceeded, it never splits or trims a batch):
 *   transaction  1,232 bytes, with 96 reserved for a wallet guard (Phantom's observed Lighthouse append is 93 bytes for an SPL batch)
 *   accounts     64 account locks; instruction trace 64 (top level plus CPIs), 8 reserved for wallet-guard instructions
 *   compute      simulation-measured; the probe ceiling is min(1,400,000, N x 200,000) (each payment keeps the single-transfer ceiling)
 */
export const SOLANA_BATCH_PAYMENT = Object.freeze({
  adapterId: 'solana.batch-payment', chain: SOLANA_MAINNET_TRANSFER.chain, minimumRecipients: 2, maximumRecipients: 8,
  /** The runtime's per-transaction compute maximum. */
  maximumTransactionComputeUnits: 1_400_000,
  /** The reviewed single-transfer ceiling (200,000), granted to every payment of the batch. */
  perPaymentComputeUnits: SOLANA_MAINNET_TRANSFER.maximumComputeUnits,
  maximumTransactionBytes: 1_232, walletGuardReserveBytes: 96,
  maximumAccounts: 64, maximumInstructionTrace: 64, walletGuardInstructionReserve: 8,
  /** A reviewed batch is valid for about 50 seconds: the blockhash lifetime minus the send budget of one transaction. */
  reviewTtlSeconds: 50,
});
/** The compute probe ceiling for a batch of `recipients` payments: never above the runtime maximum. */
export const solanaBatchPaymentComputeCap = (recipients: number): number =>
  Math.min(SOLANA_BATCH_PAYMENT.maximumTransactionComputeUnits, recipients * SOLANA_BATCH_PAYMENT.perPaymentComputeUnits);
/** Only registry assets with fully verified semantics: SOL (`null` mint), USDC, USDT (classic SPL Token). Any other mint is null. */
export const solanaBatchPaymentAsset = (mint: string | null): SolanaTransferAsset | null => SOLANA_MAINNET_TRANSFER.assets.find(a => a.mint === mint) ?? null;
