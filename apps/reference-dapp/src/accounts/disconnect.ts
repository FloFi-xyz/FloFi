// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: Disconnect (also "Sign out" and the drawer's "Logout") always ends at the sign-in page:
 * 1. the active wallet connection of this page is closed (MetaMask/Phantom/… sessions, FloFi's own wallet providers), and the remembered
 *    wallet choice is marked disconnected so nothing reconnects silently;
 * 2. this browser logs out of Privy;
 * 3. FloFi's server revokes this browser's account session record, clears its cookie and this browser's wallet proofs;
 * 4. the page is replaced by `/login` (`location.replace`: the signed-in page leaves the history, and Back cannot restore it).
 * Nothing about the account, its wallets, keys, assets or history is deleted. Every step runs even if an earlier one fails.
 */
import { accountSignOut } from '../app/account-action';
import { updateWalletPreference } from '../wallet/wallet-registry';
import type { FloFiPrivy } from './privy-context';

let leaving = false;
export async function disconnectToLogin(privy: Pick<FloFiPrivy, 'logout'> | null, closeWallet?: () => unknown): Promise<void> {
  if (leaving) return;
  leaving = true;
  try { await closeWallet?.(); } catch { /* the wallet may already be gone */ }
  updateWalletPreference({ evmDisconnected: true, solanaDisconnected: true });
  await privy?.logout().catch(() => undefined);
  const next = await accountSignOut().then(result => result.next, () => '/login');
  window.location.replace(next);
}
