// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-BETA-UX-INTELLIGENCE-001 (WS01): mounts the account wallet lifecycle (`account-wallet-lifecycle.ts`) on every product page, beside
 * `AccountWalletAutoConnect`, so Dashboard, Chat and the Editor see the account's wallets without a visit to Credentials. Off where the
 * auto-connect is off (an embedding frame, an approval page, engineering certification) and on deployments without Privy.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { syncPrivyWallets } from '../app/account-action';
import { currentFloFiPrivy, useFloFiPrivy, type FloFiPrivy } from '../accounts/privy-context';
import { syncFloFiWallets } from '../wallet/flofi-wallet-sync';
import { disconnectToLogin } from '../accounts/disconnect';
import { activeNetworkScope } from '../domain/network-scope';
import { cancelWalletLifecycle, markPrivyUnavailable, observePrivySession, PRIVY_READY_TIMEOUT_MS, runWalletLifecycle, subscribeWalletLifecycle, walletLifecycle, type LifecycleDeps,
  type WalletLifecycle } from './account-wallet-lifecycle';

const framed = () => { try { return typeof window !== 'undefined' && window.top !== window.self; } catch { return true; } };
function lifecycleDeps(privy: FloFiPrivy): LifecycleDeps {
  return {
    privy: { userId: privy.userId, embedded: privy.embedded, getAccessToken: () => privy.getAccessToken(), createWallet: ecosystem => privy.createWallet(ecosystem) },
    sync: async token => {
      const result = await syncPrivyWallets(token);
      return result.ok ? { ok: true, value: { wallets: result.value.wallets.map(wallet => ({ ecosystem: wallet.ecosystem, address: wallet.address })), method: result.value.method,
        heldElsewhere: result.value.heldElsewhere } } : result;
    },
    refresh: () => syncFloFiWallets({ force: true }),
    // The Privy session this run was started for must still be the page's current one before each side effect.
    live: () => currentFloFiPrivy()?.userId === privy.userId,
    exclusive: <T,>(name: string, run: () => Promise<T>): Promise<T> => typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(name, run) as Promise<T> : run(),
  };
}

export function AccountWalletProvisioner({ disabled = false }: { disabled?: boolean }) {
  const privy = useFloFiPrivy();
  // Never inside an embedding frame (as `syncFloFiWallets`): a host page must not provision the person's wallets.
  const off = disabled || !privy || activeNetworkScope() === 'ENGINEERING' || framed();
  const ready = privy?.ready ?? false, authenticated = privy?.authenticated ?? false, userId = privy?.userId ?? null;
  useEffect(() => { if (off) cancelWalletLifecycle(); else observePrivySession(privy ? { ready, authenticated, userId } : null); }, [off, privy, ready, authenticated, userId]);
  useEffect(() => {
    if (off || ready) return;
    const timer = setTimeout(markPrivyUnavailable, PRIVY_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [off, ready]);
  useEffect(() => {
    if (off || !privy || !ready || !authenticated || !userId) return;
    void runWalletLifecycle(lifecycleDeps(privy));
    // Once per Privy user per page: a new embedded wallet list (created by this run) must not start another run.
  }, [off, ready, authenticated, userId]);
  return null;
}

/** The page's wallet lifecycle and the person's Try again (re-reads, re-provisions what is still missing, re-syncs). */
export function useAccountWalletLifecycle(): WalletLifecycle & { readonly retry: () => void } {
  const lifecycle = useSyncExternalStore(subscribeWalletLifecycle, walletLifecycle, walletLifecycle);
  const privy = useFloFiPrivy();
  const retry = useCallback(() => {
    // A Privy session that belongs to another FloFi account cannot be repaired here: sign in again (ends both sessions).
    if (lifecycle.code === 'PRIVY_ACCOUNT_MISMATCH') { void disconnectToLogin(privy); return; }
    if (lifecycle.code === 'PRIVY_UNAVAILABLE' || !privy?.ready) { window.location.reload(); return; }
    if (privy.authenticated && privy.userId) void runWalletLifecycle(lifecycleDeps(privy), true);
  }, [privy, lifecycle.code]);
  return { ...lifecycle, retry };
}
