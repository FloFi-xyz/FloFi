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
  /** Wallet-execution review: a later bridge spends what earlier steps deliver to the same wallet, so the choice is made before step 1. */
  laterEvm: 'This workflow includes a bridge, and FloFi Wallet can’t sign bridges yet. Use MetaMask or another EVM wallet for this workflow.',
  laterSolana: 'This workflow includes a bridge, and FloFi Wallet can’t sign bridges yet. Use Phantom, Solflare or another Solana wallet for this workflow.',
} as const);
const BRIDGE_KINDS: ReadonlySet<string> = new Set(['router', 'universal']);

/** `laterSteps`: the step-by-step sequence's steps after the current one (their runtime kind and chain); empty outside a sequence. */
export function floFiWalletBridgeIssue(input: { readonly kind: string; readonly signerIsFloFiWallet: boolean; readonly groupedRun: boolean;
  readonly executing: boolean; readonly ecosystem: 'evm' | 'solana' | null | undefined;
  readonly laterSteps?: readonly { readonly kind: string | null; readonly chainId: string }[] }): string | null {
  if (input.groupedRun || input.executing || !input.signerIsFloFiWallet) return null;
  const solana = input.ecosystem === 'solana';
  if (BRIDGE_KINDS.has(input.kind)) return solana ? FLOFI_WALLET_BRIDGE_ISSUE.solana : FLOFI_WALLET_BRIDGE_ISSUE.evm;
  // A later bridge signed from the same ecosystem (its source chain) would be signed by the same FloFi Wallet.
  const later = (input.laterSteps ?? []).some(step => step.kind !== null && BRIDGE_KINDS.has(step.kind) && step.chainId.startsWith(solana ? 'solana:' : 'eip155:'));
  return later ? solana ? FLOFI_WALLET_BRIDGE_ISSUE.laterSolana : FLOFI_WALLET_BRIDGE_ISSUE.laterEvm : null;
}
