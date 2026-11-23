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
 * BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001 (security review): a read that failed is not "no wallets" (`failed`), and is never cached.
 * BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001: why it failed (`TIMEOUT`, `UNAVAILABLE`: the server could not read the signed-in account,
 * `MALFORMED`: the answer did not have the account's shape, `NETWORK`: the request itself failed), after FloFi's own bounded retry.
 */
export type AccountReadFailure = 'TIMEOUT' | 'UNAVAILABLE' | 'MALFORMED' | 'NETWORK';
export type AccountRead = { readonly wallets: AccountWallets; readonly failed: false } | { readonly wallets: AccountWallets; readonly failed: true; readonly reason: AccountReadFailure };
/**
 * The signed-in account's wallets (public data; a signed-out visitor simply has none), shared by this page's readers. Review P2: the value
 * belongs to ONE session — it is read again when the page observes another Privy user (or none), and after `ACCOUNT_WALLETS_FRESH_MS`, so a
 * sign-out and sign-in without a reload never fills another account's wallet. Never written to Web Storage.
 */
export const ACCOUNT_WALLETS_FRESH_MS = 60_000;
/** How long a destination waits for Privy to restore a signed-in session before it stops counting Privy's wallets as "still loading". */
export const PRIVY_RESTORE_WAIT_MS = 10_000;
/**
 * Wallet-execution review: an account read that never answers ends as a failed read (no wallets known), never an endless "checking".
 * BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001: per attempt. A failed attempt (timeout, a server that could not read the account, a malformed
 * answer, a network error) is tried once more after `ACCOUNT_WALLETS_RETRY_DELAY_MS`: `ACCOUNT_WALLETS_ATTEMPTS` attempts in all, so a read
 * settles within about 22 s. The read only reads public account data; nothing written, connected or signed is ever retried.
 */
export const ACCOUNT_WALLETS_READ_TIMEOUT_MS = 10_000;
export const ACCOUNT_WALLETS_ATTEMPTS = 2;
export const ACCOUNT_WALLETS_RETRY_DELAY_MS = 2_000;
/** The most wallets an account answer may carry (FloFi's own account limits are far lower): anything above is not an account's shape. */
const ACCOUNT_WALLETS_MAX = 64;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/, SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A wallet's display name: 1–64 characters, no control character. */
const displayName = (value: string) => value.length >= 1 && value.length <= 64 && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
class AccountReadError extends Error { constructor(readonly reason: AccountReadFailure) { super(`ACCOUNT_WALLETS_${reason}`); } }
/**
 * BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001: the account's wallets from an `accountState()` answer, checked before anything is mapped. Not
 * an object, an account without a wallet list, more than `ACCOUNT_WALLETS_MAX` entries, or ANY entry without a known ecosystem, a public
 * address of that ecosystem and a provider name is `MALFORMED` as a whole — never a partial list, which could leave one wallet and fill it
 * automatically while the account really holds two. A signed-out visitor (`account: null`) has none; a server that could not read the
 * signed-in account is `UNAVAILABLE`.
 */
export function accountWalletsFrom(state: unknown): AccountWallets {
  if (!state || typeof state !== 'object') throw new AccountReadError('MALFORMED');
  const { account, accountUnavailable } = state as { account?: unknown; accountUnavailable?: unknown };
  if (accountUnavailable === true) throw new AccountReadError('UNAVAILABLE');
  if (account === null) return [];
  const wallets = account && typeof account === 'object' ? (account as { wallets?: unknown }).wallets : undefined;
  if (!Array.isArray(wallets) || wallets.length > ACCOUNT_WALLETS_MAX) throw new AccountReadError('MALFORMED');
  return wallets.map(entry => {
    const wallet = entry && typeof entry === 'object' ? entry as { ecosystem?: unknown; address?: unknown; provider?: unknown; providerName?: unknown } : {};
    const { ecosystem, address, provider, providerName } = wallet;
    if ((ecosystem !== 'evm' && ecosystem !== 'solana') || typeof address !== 'string' || !(ecosystem === 'evm' ? EVM_ADDRESS : SOLANA_ADDRESS).test(address)
      || typeof provider !== 'string' || typeof providerName !== 'string' || !displayName(providerName)) throw new AccountReadError('MALFORMED');
    return { ecosystem, address, providerName: provider === 'privy' || provider === 'turnkey' ? 'FloFi Wallet' : providerName };
  });
}
/**
 * One account read with FloFi's bounded retry: at most `attempts` attempts (never more than 3), each limited to `timeoutMs`; attempt n+1 starts
 * `delayMs × n` after attempt n failed. `stale()` ends it early once its answer can no longer be used (another session, an invalidation):
 * nothing is retried for a reader that is gone. Pure and injectable for tests; the page uses `accountState`.
 */
export async function fetchAccountWallets(read: () => Promise<unknown>, options: { readonly attempts?: number; readonly timeoutMs?: number; readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>; readonly stale?: () => boolean } = {}): Promise<AccountRead> {
  const attempts = Math.max(1, Math.min(options.attempts ?? ACCOUNT_WALLETS_ATTEMPTS, 3)), timeoutMs = options.timeoutMs ?? ACCOUNT_WALLETS_READ_TIMEOUT_MS;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let reason: AccountReadFailure = 'NETWORK';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new AccountReadError('TIMEOUT')), timeoutMs); });
    try { return { failed: false, wallets: accountWalletsFrom(await Promise.race([read(), timeout])) }; }
    catch (error) { reason = error instanceof AccountReadError ? error.reason : 'NETWORK'; }
    finally { clearTimeout(timer); }
    if (attempt === attempts || options.stale?.()) break;
    await sleep((options.delayMs ?? ACCOUNT_WALLETS_RETRY_DELAY_MS) * attempt);
    if (options.stale?.()) break;
  }
  return { failed: true, reason, wallets: [] };
}
/** One Privy wait per page (every reader agrees on whether Privy is still restoring), started by the first reader. */
let privyWaitEnds: number | null = null;
let accountRead: { readonly key: string; readonly at: number; readonly promise: Promise<AccountRead> } | null = null;
const accountListeners = new Set<() => void>();
/** Whether this page's latest account read failed: the browser coming back online then reads again once (no polling, no loop). */
let lastReadFailed = false, onlineHooked = false;
function hookOnline(): void {
  if (onlineHooked || typeof window === 'undefined') return;
  onlineHooked = true;
  window.addEventListener('online', () => { if (lastReadFailed) { lastReadFailed = false; invalidateAccountWallets(); } });
}
/**
 * Review (round 2): the account's wallets changed in this page (a wallet linked, removed or renamed in Settings → Wallets): the next read asks the
 * server again and every mounted reader re-reads now, so Simulate never binds a wallet the account no longer has.
 * BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001: also the owner's explicit "Try again" after a failed read, and the browser coming back online.
 */
export function invalidateAccountWallets(): void { accountRead = null; for (const listener of accountListeners) listener(); }
/** The owner's explicit retry after FloFi's own attempts failed (same as an invalidation: one new bounded read for every reader). */
export const retryAccountWallets = invalidateAccountWallets;
function readAccountWallets(key: string, now = Date.now()): Promise<AccountRead> {
  if (accountRead?.key === key && now - accountRead.at < ACCOUNT_WALLETS_FRESH_MS) return accountRead.promise;
  const entry: { key: string; at: number; promise: Promise<AccountRead> } = { key, at: now, promise: Promise.resolve({ failed: false, wallets: [] }) };
  // A read superseded by another session's or by an invalidation stops retrying; its answer reaches no reader of another session (each reader
  // checks its own session before using it).
  entry.promise = fetchAccountWallets(accountState, { stale: () => accountRead !== entry }).then(read => {
    // A failure is forgotten at once: the next reader asks again instead of reusing "no wallets" for a minute.
    if (accountRead === entry) { lastReadFailed = read.failed; if (read.failed) accountRead = null; }
    return read;
  });
  accountRead = entry;
  return entry.promise;
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
  const [account, setAccount] = useState<AccountWallets>([]), [accountFailed, setAccountFailed] = useState(false);
  const sessionKey = privy?.userId ?? 'signed-out';
  const [generation, setGeneration] = useState(0);
  // BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001: which read the account wallets answer (`null`: still reading). While Privy itself has not
  // restored the session (after a reload) its embedded wallets are not listed yet either; that wait is bounded so a Privy that never loads
  // leaves the owner the other tiers and a typed address, never an endless "checking".
  const [answered, setAnswered] = useState<string | null>(null);
  const [privyWait, setPrivyWait] = useState(() => privyWaitEnds === null || Date.now() < privyWaitEnds);
  useEffect(() => {
    privyWaitEnds ??= Date.now() + PRIVY_RESTORE_WAIT_MS;
    const timer = setTimeout(() => setPrivyWait(false), Math.max(0, privyWaitEnds - Date.now()));
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => { hookOnline(); const listener = () => setGeneration(n => n + 1); accountListeners.add(listener); return () => { accountListeners.delete(listener); }; }, []);
  const readKey = `${sessionKey}:${generation}`;
  // Security review: while Privy is still restoring a session (after a reload) the signed-in person is not known yet, so nothing is read (or
  // cached) under "signed out" meanwhile; the read starts once Privy answers, or once the bounded wait ends.
  const restoring = Boolean(privy && !privy.ready && privyWait);
  useEffect(() => {
    let live = true;
    // Another session's wallets are dropped at once; this session's are read (or reused while fresh).
    setAccount([]); setAccountFailed(false); setAnswered(null);
    if (restoring) return () => { live = false; };
    void readAccountWallets(sessionKey).then(read => { if (live) { setAccount(read.wallets); setAccountFailed(read.failed); setAnswered(readKey); } });
    return () => { live = false; };
  }, [sessionKey, generation, readKey, restoring]);
  const loading = answered !== readKey || restoring;
  const solanaSession = solana?.session?.chain === 'solana:mainnet' ? solana.session : null;
  return useMemo(() => {
    const session: DestinationCandidate[] = [
      ...evm?.account ? [{ ecosystem: 'evm' as const, address: evm.account, providerName: evm.provider?.name ?? BROWSER_WALLET, source: 'SESSION' as const }] : [],
      ...solanaSession ? [{ ecosystem: 'solana' as const, address: solanaSession.account.address, providerName: solanaSession.wallet.name, source: 'SESSION' as const }] : []];
    const linked: DestinationCandidate[] = [
      ...(privy?.embedded ?? []).map(wallet => ({ ecosystem: wallet.ecosystem, address: wallet.address, providerName: 'FloFi Wallet', source: 'ACCOUNT' as const })),
      ...account.map(wallet => ({ ...wallet, source: 'ACCOUNT' as const }))];
    const saved = credentials.wallets.map(wallet => ({ ecosystem: wallet.ecosystem, address: wallet.address, providerName: wallet.providerName, source: 'SAVED' as const }));
    return { session, account: linked, saved, loading, accountUnavailable: accountFailed };
  }, [evm?.account, evm?.provider?.name, solanaSession, privy?.embedded, account, credentials.wallets, loading, accountFailed]);
}
/** The resolved destination wallet of each ecosystem (see `resolveDestinationWallet`). */
export function useDestinationWallets(evm: SessionEvmWallet): { readonly inventory: DestinationInventory; readonly evm: DestinationResolution; readonly solana: DestinationResolution } {
  const inventory = useDestinationInventory(evm);
  return useMemo(() => ({ inventory, evm: resolveDestinationWallet('evm', inventory), solana: resolveDestinationWallet('solana', inventory) }), [inventory]);
}
/** The address a resolution fills automatically (exactly one wallet at the first tier that has any), else null. */
export const resolvedAddress = (resolution: DestinationResolution): string | null => resolution.kind === 'RESOLVED' ? resolution.wallet.address : null;
