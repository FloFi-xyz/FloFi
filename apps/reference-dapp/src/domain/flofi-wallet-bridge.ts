// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001 (incident 9, observed in production on 2026-11-25): FloFi Wallet signs only the flows it can bind
 * (`SIGNING_FLOWS` in `wallet/flofi-signing.ts`: transfers, single swaps, Jupiter and Circle-paid workflow groups). A Router or universal
 * bridge on its own flow reached FloFi Wallet's request and was refused there (`FLOFI_WALLET_FLOW_NOT_SUPPORTED`), after Simulate and
 * Review. This says so first, in the stage's existing "this wallet cannot authorize it" state.
 *
 * Never on a grouped workflow run (a Circle-paid group is signed by FloFi Wallet through its own path), never while that bridge is
 * already executing (its progress is never replaced), and only when FloFi Wallet is the wallet that would sign.
 */
export const FLOFI_WALLET_BRIDGE_ISSUE = Object.freeze({
  evm: 'FloFi Wallet can’t sign bridges yet. Use MetaMask or another EVM wallet for this bridge.',
  solana: 'FloFi Wallet can’t sign bridges yet. Use Phantom, Solflare or another Solana wallet for this bridge.',
} as const);

export function floFiWalletBridgeIssue(input: { readonly kind: string; readonly signerIsFloFiWallet: boolean; readonly groupedRun: boolean;
  readonly executing: boolean; readonly ecosystem: 'evm' | 'solana' | null | undefined }): string | null {
  if (input.groupedRun || input.executing || !input.signerIsFloFiWallet || (input.kind !== 'router' && input.kind !== 'universal')) return null;
  return input.ecosystem === 'solana' ? FLOFI_WALLET_BRIDGE_ISSUE.solana : FLOFI_WALLET_BRIDGE_ISSUE.evm;
}
