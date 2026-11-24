// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BETA-UX-INTELLIGENCE-001 (WS01, P0): the signed-in account's FloFi wallets are discovered, recovered or provisioned on the product
 * page itself — never only on Credentials or the onboarding page.
 *
 * Before: embedded wallets were created only when the person clicked "Create wallet" on /onboarding/wallets (which can be skipped), and the
 * product page only read the wallets FloFi's server already listed. An email or Google account that skipped that page, or whose save never
 * finished, saw "Wallet not connected" in Dashboard, Chat and the Editor until it visited Credentials / Add wallets.
 *
 * Now, once per page and Privy user (an account switch starts over, so one person's wallet state never reaches another):
 *  1. the server saves every embedded wallet Privy's API lists for this account's OWN Privy user (`syncPrivyWallets`: verified access token,
 *     linked Privy user only; an address another account holds is never moved) — a returning user recovers the same addresses;
 *  2. for an account that signed in with Google, Apple or email (a managed login), an ecosystem with no wallet at all — none at Privy, none
 *     saved on the account (generated, imported, legacy or a linked external wallet) — gets ONE embedded wallet from Privy (`createWallet`);
 *     a wallet Privy already holds is saved, never duplicated (`PRIVY_WALLET_LIMIT` is recovered by the next sync);
 *  3. the page's FloFi wallet entries are refreshed (`syncFloFiWallets`), so `AccountWalletAutoConnect` connects the account's own wallet.
 * An account that signed in with an external wallet (MetaMask, Phantom…) is never provisioned: its own wallet stays its wallet.
 *
 * Creating or saving a wallet shares a public address and authorizes nothing: no signature is requested, no session signer, delegated action
 * or key is added, and every transaction is still simulated, reviewed and confirmed in Privy's own screen. Keys never leave Privy.
 *
 * The lifecycle the header and the wallet consumers read: `authenticating` (Privy has not loaded), `initializing` (reading, recovering or
 * provisioning), `ready`, `failed` (with `retry`), and `signed-out` (truly no account session). "Wallet not connected" is shown only for
 * `signed-out`, `ready` without a connection, or a deployment without accounts.
 */
import type { SessionMethod } from '../accounts/account-model';
import type { PrivyEmbedded } from '../accounts/privy-context';
import type { WalletEcosystem } from '../wallet/wallet-registry';

export type WalletLifecycleStatus = 'idle' | 'authenticating' | 'initializing' | 'ready' | 'failed' | 'signed-out';
export type WalletLifecycle = { readonly status: WalletLifecycleStatus; readonly code: string | null; readonly userId: string | null;
  /** Ecosystems this page provisioned for the account (shown once: "Your wallet is ready"). */ readonly provisioned: readonly WalletEcosystem[] };
export type SavedWallet = { readonly ecosystem: WalletEcosystem; readonly address: string };
type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };
export type WalletSyncValue = { readonly wallets: readonly SavedWallet[]; readonly method: SessionMethod };
export type LifecycleDeps = {
  readonly privy: { readonly userId: string | null; readonly embedded: readonly PrivyEmbedded[]; getAccessToken(): Promise<string | null>;
    createWallet(ecosystem: WalletEcosystem): Promise<{ readonly address: string }> };
  readonly sync: (token: string) => Promise<Result<WalletSyncValue>>;
  readonly refresh: () => Promise<void>;
};

export const PROVISIONED_ECOSYSTEMS: readonly WalletEcosystem[] = Object.freeze(['evm', 'solana']);
const MANAGED: ReadonlySet<SessionMethod> = new Set<SessionMethod>(['google', 'apple', 'email']);
/** Codes meaning this browser holds no FloFi account session: the person is signed out, not failing. */
const SIGNED_OUT: ReadonlySet<string> = new Set(['ACCOUNT_SESSION_REQUIRED', 'FLOFI_WALLET_ACCOUNT_REQUIRED', 'ACCOUNTS_UNAVAILABLE', 'PRIVY_ACCOUNT_NOT_LINKED']);

/**
 * The ecosystems to provision: only for a managed login, only those where neither Privy (client view) nor the account (server, which already
 * saved every embedded wallet Privy's API lists) holds any wallet. Pure.
 */
export function provisioningPlan(method: SessionMethod, embedded: readonly PrivyEmbedded[], saved: readonly SavedWallet[]): readonly WalletEcosystem[] {
  if (!MANAGED.has(method)) return [];
  return PROVISIONED_ECOSYSTEMS.filter(ecosystem => !embedded.some(wallet => wallet.ecosystem === ecosystem) && !saved.some(wallet => wallet.ecosystem === ecosystem));
}

/**
 * One run of steps 1–3. Never throws: a failure is a lifecycle state with its code. Each ecosystem is provisioned independently, so a Solana
 * failure never undoes or hides a ready EVM wallet (the page still refreshes, and the failure is reported for `retry`).
 */
export async function initializeAccountWallets(deps: LifecycleDeps): Promise<Pick<WalletLifecycle, 'status' | 'code' | 'provisioned'>> {
  const token = await deps.privy.getAccessToken().catch(() => null);
  if (!token) return { status: 'signed-out', code: 'PRIVY_SESSION_REQUIRED', provisioned: [] };
  const first = await deps.sync(token).catch(() => ({ ok: false as const, code: 'ACCOUNT_WALLET_SAVE_FAILED' }));
  if (!first.ok) return SIGNED_OUT.has(first.code) ? { status: 'signed-out', code: first.code, provisioned: [] } : { status: 'failed', code: first.code, provisioned: [] };
  const plan = provisioningPlan(first.value.method, deps.privy.embedded, first.value.wallets);
  const provisioned: WalletEcosystem[] = [];
  let failure: string | null = null;
  for (const ecosystem of plan) {
    try { await deps.privy.createWallet(ecosystem); provisioned.push(ecosystem); }
    catch (cause) {
      const code = cause instanceof Error ? cause.message : 'PRIVY_WALLET_CREATE_FAILED';
      // Privy already holds this person's wallet (an earlier attempt, another tab): the next sync saves it. Never a second wallet.
      if (code !== 'PRIVY_WALLET_LIMIT') failure ??= code;
    }
  }
  if (plan.length) {
    const again = await deps.privy.getAccessToken().catch(() => null);
    const second = again ? await deps.sync(again).catch(() => ({ ok: false as const, code: 'ACCOUNT_WALLET_SAVE_FAILED' })) : { ok: false as const, code: 'PRIVY_SESSION_REQUIRED' };
    if (!second.ok) failure ??= second.code;
    else for (const ecosystem of plan) if (!second.value.wallets.some(wallet => wallet.ecosystem === ecosystem)) failure ??= 'ACCOUNT_WALLET_SAVE_FAILED';
  }
  await deps.refresh().catch(() => undefined);
  return failure ? { status: 'failed', code: failure, provisioned } : { status: 'ready', code: null, provisioned };
}

// The page's one lifecycle, keyed by the Privy user it describes (never another user's state).
const IDLE: WalletLifecycle = Object.freeze({ status: 'idle', code: null, userId: null, provisioned: Object.freeze([]) as readonly WalletEcosystem[] });
let current: WalletLifecycle = IDLE;
let running: { readonly userId: string; readonly promise: Promise<void> } | null = null;
let generation = 0;
const listeners = new Set<() => void>();
function set(next: WalletLifecycle) { current = next; for (const listener of [...listeners]) listener(); }
export const walletLifecycle = (): WalletLifecycle => current;
export function subscribeWalletLifecycle(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** Privy's own state, before any account read: loading, or no Privy session. A different user forgets the previous one's state at once. */
export function observePrivySession(privy: { readonly ready: boolean; readonly authenticated: boolean; readonly userId: string | null } | null): void {
  if (!privy || !privy.ready) { if (current.status === 'idle' || current.status === 'signed-out') set({ ...IDLE, status: privy ? 'authenticating' : 'idle' }); return; }
  if (!privy.authenticated || !privy.userId) { generation++; running = null; if (current.status !== 'signed-out' || current.userId !== null) set({ ...IDLE, status: 'signed-out' }); return; }
  if (current.userId !== null && current.userId !== privy.userId) { generation++; running = null; set({ ...IDLE, status: 'authenticating' }); }
}
/**
 * Runs the lifecycle for `deps.privy.userId` once per page (`force`: the person's Try again). Concurrent callers join the run in flight; a run
 * whose user is no longer current is discarded, never applied.
 */
export function runWalletLifecycle(deps: LifecycleDeps, force = false): Promise<void> {
  const userId = deps.privy.userId;
  if (!userId) return Promise.resolve();
  if (running?.userId === userId) return running.promise;
  if (!force && current.userId === userId && (current.status === 'ready' || current.status === 'failed' || current.status === 'signed-out')) return Promise.resolve();
  const ticket = ++generation;
  set({ status: 'initializing', code: null, userId, provisioned: [] });
  const promise = initializeAccountWallets(deps).then(result => {
    if (ticket === generation) set({ ...result, userId });
  }).finally(() => { if (running?.promise === promise) running = null; });
  running = { userId, promise };
  return promise;
}
/** Tests only: a new page. */
export function resetWalletLifecycleForTests(): void { current = IDLE; running = null; generation++; listeners.clear(); }
/** Privy did not load in time (`PRIVY_READY_TIMEOUT_MS`): reported with its recovery instead of an endless "setting up". */
export function markPrivyUnavailable(): void {
  if (current.status === 'authenticating' || current.status === 'idle') set({ ...IDLE, status: 'failed', code: 'PRIVY_UNAVAILABLE' });
}
export const PRIVY_READY_TIMEOUT_MS = 20_000;
/**
 * What the header's wallet slot shows when no wallet is connected yet: a neutral "setting up" status while FloFi is still reading or creating
 * the account's wallets (never "Wallet not connected" then), the failure with its recovery, or the ordinary disconnected state. `privyLoading`:
 * Privy is mounted on this page and has not finished loading; `signedIn`: the server-verified presence of a FloFi session (null: unknown).
 */
export function walletSlotState(lifecycle: Pick<WalletLifecycle, 'status' | 'code'>, signedIn: boolean | null, privyLoading: boolean): 'initializing' | 'failed' | 'disconnected' {
  // Privy not loading only matters to a signed-in browser; a signed-out visitor keeps the ordinary Connect Wallet.
  if (lifecycle.status === 'failed') return lifecycle.code === 'PRIVY_UNAVAILABLE' && signedIn !== true ? 'disconnected' : 'failed';
  if (lifecycle.status === 'initializing') return 'initializing';
  // Privy is still loading for a browser the server knows is signed in: the wallet is being restored, not missing.
  if (privyLoading && signedIn === true && lifecycle.status !== 'signed-out' && lifecycle.status !== 'ready') return 'initializing';
  return 'disconnected';
}
