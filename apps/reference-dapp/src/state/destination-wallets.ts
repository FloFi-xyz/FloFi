// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: the owner's wallets a bridge can deliver to, read from what this page already knows — the wallets connected in
 * this session, the FloFi account's wallets (Privy embedded, and the account's linked wallets once the signed-in account is read) and the
 * public addresses saved in Credentials → Wallets — resolved by `resolveDestinationWallet`. Public addresses only; nothing here connects,
 * signs or sends, and nothing is written to the workflow by itself.
 */
import { useEffect, useMemo, useState } from 'react';
import { useFloFiPrivy } from '../accounts/privy-context';
import { accountState } from '../app/account-action';
import { resolveDestinationWallet, type DestinationCandidate, type DestinationEcosystem, type DestinationInventory, type DestinationResolution } from '../domain/destination-wallet';
import { useCredentials } from './credentials-store';
import { useOptionalJupiter } from './jupiter-store';

type AccountWallets = readonly { readonly ecosystem: DestinationEcosystem; readonly address: string; readonly providerName: string }[];
/**
 * The signed-in account's wallets (public data; a failure or a signed-out visitor is simply "none"), shared by this page's readers. Review P2: the
 * value belongs to ONE session — it is read again when the page observes another Privy user (or none), and after `ACCOUNT_WALLETS_FRESH_MS`, so a
 * sign-out and sign-in without a reload never fills another account's wallet. Never written to Web Storage.
 */
export const ACCOUNT_WALLETS_FRESH_MS = 60_000;
let accountRead: { readonly key: string; readonly at: number; readonly promise: Promise<AccountWallets> } | null = null;
const accountListeners = new Set<() => void>();
/**
 * Review (round 2): the account's wallets changed in this page (a wallet linked, removed or renamed in Settings → Wallets): the next read asks the
 * server again and every mounted reader re-reads now, so Simulate never binds a wallet the account no longer has.
 */
export function invalidateAccountWallets(): void { accountRead = null; for (const listener of accountListeners) listener(); }
function readAccountWallets(key: string, now = Date.now()): Promise<AccountWallets> {
  if (accountRead?.key === key && now - accountRead.at < ACCOUNT_WALLETS_FRESH_MS) return accountRead.promise;
  const promise = accountState().then(state => state.account?.wallets.map(wallet => ({ ecosystem: wallet.ecosystem, address: wallet.address,
    providerName: wallet.provider === 'privy' || wallet.provider === 'turnkey' ? 'FloFi Wallet' : wallet.providerName })) ?? [], () => []);
  accountRead = { key, at: now, promise };
  return promise;
}

/** The connected EVM wallet as the caller's wallet store reports it (callers already hold it). */
export type SessionEvmWallet = { readonly account: string | null; readonly provider?: { readonly name: string } | null } | null | undefined;
/**
 * BUILD-FLOFI-MAINNET-EXEC-002 review round 2: FloFi's own name for a browser wallet that does not name itself (also "Browser wallet 2" when
 * several are injected). It is product copy, so a component shows it translated (`localizedProvider`); a wallet's own name is never changed.
 */
export const BROWSER_WALLET = 'Browser wallet';
export function localizedProvider<T extends { readonly providerName: string }>(wallet: T, tr: (key: string) => string): T {
  const fallback = /^Browser wallet(?: (\d+))?$/.exec(wallet.providerName);
  return fallback ? { ...wallet, providerName: fallback[1] ? `${tr(BROWSER_WALLET)} ${fallback[1]}` : tr(BROWSER_WALLET) } : wallet;
}
export function useDestinationInventory(evm: SessionEvmWallet): DestinationInventory {
  const solana = useOptionalJupiter(), privy = useFloFiPrivy(), credentials = useCredentials();
  const [account, setAccount] = useState<AccountWallets>([]);
  const sessionKey = privy?.userId ?? 'signed-out';
  const [generation, setGeneration] = useState(0);
  useEffect(() => { const listener = () => setGeneration(n => n + 1); accountListeners.add(listener); return () => { accountListeners.delete(listener); }; }, []);
  useEffect(() => {
    let live = true;
    // Another session's wallets are dropped at once; this session's are read (or reused while fresh).
    setAccount([]);
    void readAccountWallets(sessionKey).then(wallets => { if (live) setAccount(wallets); });
    return () => { live = false; };
  }, [sessionKey, generation]);
  const solanaSession = solana?.session?.chain === 'solana:mainnet' ? solana.session : null;
  return useMemo(() => {
    const session: DestinationCandidate[] = [
      ...evm?.account ? [{ ecosystem: 'evm' as const, address: evm.account, providerName: evm.provider?.name ?? BROWSER_WALLET, source: 'SESSION' as const }] : [],
      ...solanaSession ? [{ ecosystem: 'solana' as const, address: solanaSession.account.address, providerName: solanaSession.wallet.name, source: 'SESSION' as const }] : []];
    const linked: DestinationCandidate[] = [
      ...(privy?.embedded ?? []).map(wallet => ({ ecosystem: wallet.ecosystem, address: wallet.address, providerName: 'FloFi Wallet', source: 'ACCOUNT' as const })),
      ...account.map(wallet => ({ ...wallet, source: 'ACCOUNT' as const }))];
    const saved = credentials.wallets.map(wallet => ({ ecosystem: wallet.ecosystem, address: wallet.address, providerName: wallet.providerName, source: 'SAVED' as const }));
    return { session, account: linked, saved };
  }, [evm?.account, evm?.provider?.name, solanaSession, privy?.embedded, account, credentials.wallets]);
}
/** The resolved destination wallet of each ecosystem (see `resolveDestinationWallet`). */
export function useDestinationWallets(evm: SessionEvmWallet): { readonly inventory: DestinationInventory; readonly evm: DestinationResolution; readonly solana: DestinationResolution } {
  const inventory = useDestinationInventory(evm);
  return useMemo(() => ({ inventory, evm: resolveDestinationWallet('evm', inventory), solana: resolveDestinationWallet('solana', inventory) }), [inventory]);
}
/** The address a resolution fills automatically (exactly one wallet at the first tier that has any), else null. */
export const resolvedAddress = (resolution: DestinationResolution): string | null => resolution.kind === 'RESOLVED' ? resolution.wallet.address : null;
