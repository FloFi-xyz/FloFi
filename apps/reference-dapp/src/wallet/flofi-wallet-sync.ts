// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Keeps the product page's FloFi wallet entries in step with the FloFi account (BUILD-FLOFI-AUTH-WALLETS-001 spec §6, §7; Privy since
 * BUILD-FLOFI-PRIVY-UX-001).
 *
 * The server says which Privy-managed wallets the signed-in account holds (public addresses only); each signs through Privy
 * (flofi-privy-signer.ts). The legacy FloFi Wallet window (Turnkey) is configured only for exporting wallets created there before Privy.
 * Each EVM address gets its own EIP-1193 provider, registered directly in EVM discovery (never announced, never passive); each Solana
 * address its own Wallet Standard wallet, registered directly in the Solana registry. An address that left the account is retired: its
 * sessions see a disconnect, so a Review bound to it is retired too. Inside a frame (an embedding chat or MCP host) FloFi Wallet is not
 * offered: its window could not keep a link to this page or its own storage there, so it fails closed instead.
 */
import { floFiEvmBroadcast, floFiEvmFees, floFiEvmPendingNonce, floFiWalletHandoff, floFiWalletInfo, type FloFiWalletInfo } from '../app/flofi-wallet-action';
import { configureFloFiWallet, markFloFiAccount } from './flofi-wallet-channel';
import { requestThroughPrivy } from './flofi-privy-signer';
import { createFloFiEvmProvider, retireFloFiEvmProvider, type FloFiEvmDeps, type FloFiEvmProvider } from './flofi-evm-provider';
import { createFloFiSolanaWallet, FLOFI_WALLET_NAME, retireFloFiSolanaWallet, type FloFiSolanaWallet } from './flofi-solana-wallet';
import { isFloFiWalletKey, registerManagedEvmProvider } from './evm-discovery';
import { registerSolanaWallet } from './solana-wallet';
import type { WalletChoice } from './wallet-registry';

const evm = new Map<string, { readonly provider: FloFiEvmProvider; readonly unregister: () => void }>();
const solana = new Map<string, { readonly wallet: FloFiSolanaWallet; readonly unregister: () => void }>();
const MIN_INTERVAL_MS = 15_000;
let inflight: Promise<void> | null = null, last = 0;
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const evmDeps: FloFiEvmDeps = { request: requestThroughPrivy, pendingNonce: floFiEvmPendingNonce, fees: floFiEvmFees, broadcast: floFiEvmBroadcast,
  connected: markFloFiAccount };
const framed = () => { try { return window.top !== window.self; } catch { return true; } };

function apply(info: FloFiWalletInfo): void {
  // The legacy FloFi Wallet window exists only for exporting pre-Privy wallets; it never signs.
  configureFloFiWallet(info?.walletOrigin ? { walletOrigin: info.walletOrigin, handoff: floFiWalletHandoff } : null);
  const wallets = info?.wallets ?? [];
  const evmAddresses = wallets.filter(wallet => wallet.ecosystem === 'evm').map(wallet => wallet.address.toLowerCase());
  const solanaAddresses = wallets.filter(wallet => wallet.ecosystem === 'solana').map(wallet => wallet.address);
  for (const [address, entry] of [...evm]) if (!evmAddresses.includes(address)) { entry.unregister(); retireFloFiEvmProvider(entry.provider); evm.delete(address); }
  for (const [address, entry] of [...solana]) if (!solanaAddresses.includes(address)) { entry.unregister(); void retireFloFiSolanaWallet(entry.wallet); solana.delete(address); }
  for (const address of evmAddresses) if (!evm.has(address)) {
    const provider = createFloFiEvmProvider(address, evmDeps);
    evm.set(address, { provider, unregister: registerManagedEvmProvider(provider, { address,
      name: evmAddresses.length > 1 ? `${FLOFI_WALLET_NAME} ${short(address)}` : FLOFI_WALLET_NAME }) });
  }
  for (const address of solanaAddresses) if (!solana.has(address)) {
    const wallet = createFloFiSolanaWallet(address, solanaAddresses.length > 1 ? `${FLOFI_WALLET_NAME} ${short(address)}` : FLOFI_WALLET_NAME,
      { request: requestThroughPrivy, connected: markFloFiAccount });
    solana.set(address, { wallet, unregister: registerSolanaWallet(wallet) });
  }
}
/** Reads the account's FloFi Wallet state and updates the registered entries. At most one read at a time; `force` skips the throttle. */
export function syncFloFiWallets(options: { readonly force?: boolean } = {}): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (framed()) { apply(null); return Promise.resolve(); }
  if (inflight) return inflight;
  if (!options.force && Date.now() - last < MIN_INTERVAL_MS) return Promise.resolve();
  last = Date.now();
  inflight = floFiWalletInfo().then(result => { if (result.ok) apply(result.value); }, () => undefined).finally(() => { inflight = null; });
  return inflight;
}
/** Whether a selector choice is one of FloFi Wallet's own entries. */
export function isFloFiWalletChoice(choice: Pick<WalletChoice, 'ecosystem' | 'key'>): boolean {
  return choice.ecosystem === 'evm' ? isFloFiWalletKey(choice.key) : [...solana.values()].some(entry => entry.wallet.name === choice.key);
}
