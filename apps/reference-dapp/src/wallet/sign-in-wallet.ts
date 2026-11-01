// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-05, P1-06, P1-02): what a completed sign-in changes about this browser's remembered wallet choice.
 *
 * Disconnect marks both ecosystems disconnected so nothing reconnects silently afterwards (src/accounts/disconnect.ts). Before this build,
 * nothing ever cleared those marks again except a manual "Connect Wallet": a person who disconnected, then signed in with MetaMask through
 * Privy (MetaMask had just authorized this site), still saw "Wallet not connected" in /app and had to connect a second time.
 *
 * The rule now (BUILD-FLOFI-PRIVY-UX-001 §6 "no automatic reconnection" is kept for every wallet the person did not just sign in with):
 *  - an EVM wallet sign-in (`eip155`) clears only the EVM mark: the wallet just used is read back silently (`eth_accounts`); a previously
 *    remembered FloFi wallet no longer hides it. The Solana mark is kept.
 *  - a Solana wallet sign-in clears only the Solana mark; the EVM mark is kept.
 *  - Google, email or Apple keep both marks: no external wallet (for example another person's MetaMask on a shared browser) reconnects.
 *  - every verified sign-in allows the signed-in account's OWN FloFi (Privy) wallets to connect once (`AccountWalletAutoConnect`), even
 *    after a Disconnect, until the person disconnects again. Those are the only wallets FloFi lists for that account.
 * Nothing here opens a wallet prompt or authorizes anything: every transaction is still simulated, reviewed and confirmed in the wallet.
 */
import type { SessionMethod } from '../accounts/account-model';
import { isFloFiWalletKey } from './evm-discovery';
import { updateWalletPreference, walletPreference, type WalletEcosystem, type WalletPreference } from './wallet-registry';

export function walletPreferenceAfterSignIn(method: SessionMethod, current: WalletPreference): Partial<WalletPreference> {
  if (method === 'eip155') return { evmDisconnected: false, ...isFloFiWalletKey(current.evm) ? { evm: null } : {} };
  if (method === 'solana') return { solanaDisconnected: false };
  return {};
}

const ACCOUNT_RECONNECT_KEY = 'flofi.wallet.account-reconnect.v1';
type AccountReconnect = Readonly<Record<WalletEcosystem, boolean>>;
function storage(): Storage | null { try { return typeof window === 'undefined' ? null : window.localStorage ?? null; } catch { return null; } }
function readAccountReconnect(): AccountReconnect {
  try {
    const value = JSON.parse(storage()?.getItem(ACCOUNT_RECONNECT_KEY) ?? 'null') as Partial<Record<WalletEcosystem, unknown>> | null;
    return { evm: value?.evm === true, solana: value?.solana === true };
  } catch { return { evm: false, solana: false }; }
}
/** Whether the account's own FloFi wallet of this ecosystem may connect although the ecosystem is marked disconnected (set by a sign-in). */
export function accountWalletReconnectAllowed(ecosystem: WalletEcosystem): boolean { return readAccountReconnect()[ecosystem]; }
/** An explicit Disconnect (header, Credentials, a wallet's own disconnect in FloFi) ends that allowance until the next sign-in. */
export function forgetAccountWalletReconnect(...ecosystems: readonly WalletEcosystem[]): void {
  const current = readAccountReconnect();
  try { storage()?.setItem(ACCOUNT_RECONNECT_KEY, JSON.stringify({ ...current, ...Object.fromEntries(ecosystems.map(ecosystem => [ecosystem, false])) })); }
  catch { /* a convenience only: without it the FloFi wallet simply waits for Connect Wallet */ }
}
/** Applies a verified sign-in to this browser (a convenience: storage failures change nothing else). */
export function rememberSignIn(method: SessionMethod): void {
  updateWalletPreference(walletPreferenceAfterSignIn(method, walletPreference()));
  try { storage()?.setItem(ACCOUNT_RECONNECT_KEY, JSON.stringify({ evm: true, solana: true })); } catch { /* see above */ }
}
