// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-05, P1-06): what a completed sign-in changes about this browser's remembered wallet choice.
 *
 * Disconnect marks both ecosystems disconnected so nothing reconnects silently afterwards (src/accounts/disconnect.ts). Before this build,
 * nothing ever cleared those marks again except a manual "Connect Wallet": a person who disconnected, then signed in with MetaMask through
 * Privy (MetaMask had just authorized this site), still saw "Wallet not connected" in /app and had to connect a second time.
 *
 * A sign-in the person just completed, verified by FloFi's server, is that explicit act. It re-allows FloFi's silent reads of wallets this
 * browser already authorized (`eth_accounts`, Wallet Standard silent connect) and of the account's own FloFi wallets. It opens no wallet
 * prompt, connects nothing by itself and authorizes nothing: every transaction is still simulated, reviewed and confirmed in the wallet.
 * For a wallet sign-in (`eip155`), a previously chosen FloFi wallet no longer hides the external wallet the person just signed in with.
 */
import type { SessionMethod } from '../accounts/account-model';
import { isFloFiWalletKey } from './evm-discovery';
import { updateWalletPreference, walletPreference, type WalletPreference } from './wallet-registry';

export function walletPreferenceAfterSignIn(method: SessionMethod, current: WalletPreference): Partial<WalletPreference> {
  return { evmDisconnected: false, solanaDisconnected: false, ...method === 'eip155' && isFloFiWalletKey(current.evm) ? { evm: null } : {} };
}
/** Applies `walletPreferenceAfterSignIn` to this browser (a convenience: storage failures change nothing else). */
export function rememberSignIn(method: SessionMethod): void {
  updateWalletPreference(walletPreferenceAfterSignIn(method, walletPreference()));
}
