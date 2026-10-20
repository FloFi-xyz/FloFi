// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests only. No production route imports this module.
import { vi } from 'vitest';
import type { SolanaSession } from '../wallet/solana-wallet';

type StandardApi = { register(wallet: unknown): unknown };
/**
 * BUILD-SOLANA-TRANSFER-UX-001: signing refuses a session whose Wallet Standard provider is not (or no longer) registered. A Node test has
 * no extension, so the session's wallet registers through the standard handshake (either order), exactly as an extension registers itself.
 */
export function registeredSolanaSession<T extends SolanaSession>(session: T): T {
  if (typeof window === 'undefined') vi.stubGlobal('window', new EventTarget());
  const register = (api: StandardApi) => api.register(session.wallet);
  window.addEventListener('wallet-standard:app-ready', event => register((event as CustomEvent<StandardApi>).detail));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
  return session;
}
