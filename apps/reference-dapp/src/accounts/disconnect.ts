// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: Disconnect (also "Sign out" and the drawer's "Logout") always ends at the sign-in page:
 * 1. the active wallet connection of this page is closed (MetaMask/Phantom/… sessions, FloFi's own wallet providers), and the remembered
 *    wallet choice is marked disconnected so nothing reconnects silently;
 * 2. FloFi's server revokes this browser's account session record, clears its cookie and this browser's wallet proofs — first, so the
 *    FloFi session ends even if a later step hangs;
 * 3. this browser logs out of Privy, waiting at most a few seconds (the sign-in page also ends any Privy session left behind);
 * 4. the page is replaced by `/login` (`location.replace`: the signed-in page leaves the history, and Back cannot restore it).
 * Nothing about the account, its wallets, keys, assets or history is deleted. Browser steps are bounded; server revocation is awaited
 * before leaving. A stalled server request can delay Disconnect, so leaving the page is never claimed as proof of server revocation.
 */
import { accountSignOut } from '../app/account-action';
import { updateWalletPreference } from '../wallet/wallet-registry';
import { forgetAccountWalletReconnect } from '../wallet/sign-in-wallet';
import type { FloFiPrivy } from './privy-context';

/** How long Disconnect waits for each browser-side step (wallet close, Privy logout) before moving on. */
export const DISCONNECT_STEP_MS = 4_000;
const bounded = (step: () => unknown) => Promise.race([Promise.resolve().then(step).catch(() => undefined),
  new Promise<undefined>(resolve => setTimeout(resolve, DISCONNECT_STEP_MS))]);

let leaving = false;
export async function disconnectToLogin(privy: Pick<FloFiPrivy, 'logout'> | null, closeWallet?: () => unknown): Promise<void> {
  if (leaving) return;
  leaving = true;
  await bounded(() => closeWallet?.());
  updateWalletPreference({ evmDisconnected: true, solanaDisconnected: true });
  // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: not even the account's own FloFi wallets reconnect until the next sign-in.
  forgetAccountWalletReconnect('evm', 'solana');
  const next = await accountSignOut().then(result => result.next, () => '/login');
  await bounded(() => privy?.logout());
  window.location.replace(next);
}
