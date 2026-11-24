// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelWalletLifecycle, initializeAccountWallets, observePrivySession, provisioningPlan, resetWalletLifecycleForTests, runWalletLifecycle, walletLifecycle, walletSlotState,
  markPrivyUnavailable, type LifecycleDeps, type SavedWallet } from './account-wallet-lifecycle';
import type { SessionMethod } from '../accounts/account-model';
import type { PrivyEmbedded } from '../accounts/privy-context';

const EVM = '0x00000000000000000000000000000000000000a1', SOL = 'So1anaAddre55111111111111111111111111111111';
/** A Privy user and FloFi's server, in memory: the server saves whatever Privy holds for the user (as `syncPrivyWallets` does). */
function world(options: { method?: SessionMethod; held?: PrivyEmbedded[]; saved?: SavedWallet[]; userId?: string; create?: (ecosystem: 'evm' | 'solana') => Promise<{ address: string }> } = {}) {
  const held: PrivyEmbedded[] = [...options.held ?? []];
  const saved: SavedWallet[] = [...options.saved ?? []];
  const createWallet = vi.fn(options.create ?? (async (ecosystem: 'evm' | 'solana') => {
    if (held.some(wallet => wallet.ecosystem === ecosystem && !wallet.imported)) throw new Error('PRIVY_WALLET_LIMIT');
    const address = ecosystem === 'evm' ? EVM : SOL; held.push({ ecosystem, address, imported: false }); return { address };
  }));
  const sync = vi.fn(async () => {
    for (const wallet of held) if (!saved.some(entry => entry.ecosystem === wallet.ecosystem && entry.address === wallet.address)) saved.push({ ecosystem: wallet.ecosystem, address: wallet.address });
    return { ok: true as const, value: { wallets: [...saved], method: options.method ?? 'email' } };
  });
  const refresh = vi.fn(async () => undefined);
  const deps: LifecycleDeps = { privy: { userId: options.userId ?? 'did:privy:one', get embedded() { return [...held]; }, getAccessToken: async () => 'token', createWallet }, sync, refresh };
  return { deps, createWallet, sync, refresh, saved, held };
}
afterEach(() => resetWalletLifecycleForTests());

describe('provisioningPlan', () => {
  it('provisions only managed logins, only ecosystems without any wallet', () => {
    expect(provisioningPlan('email', [], [])).toEqual(['evm', 'solana']);
    expect(provisioningPlan('google', [{ ecosystem: 'evm', address: EVM, imported: false }], [])).toEqual(['solana']);
    expect(provisioningPlan('apple', [], [{ ecosystem: 'solana', address: SOL }])).toEqual(['evm']);
    // An external wallet login keeps its own wallet; nothing is created for it.
    expect(provisioningPlan('eip155', [], [])).toEqual([]);
    expect(provisioningPlan('solana', [], [])).toEqual([]);
  });
  it('an imported or linked wallet counts as the ecosystem wallet (never a duplicate beside it)', () => {
    expect(provisioningPlan('email', [{ ecosystem: 'evm', address: EVM, imported: true }], [{ ecosystem: 'solana', address: SOL }])).toEqual([]);
  });
});

describe('initializeAccountWallets', () => {
  it('a new email user receives an EVM and a Solana wallet, saved and registered on the page without Credentials', async () => {
    const w = world();
    expect(await initializeAccountWallets(w.deps)).toEqual({ status: 'ready', code: null, provisioned: ['evm', 'solana'] });
    expect(w.createWallet).toHaveBeenCalledTimes(2);
    expect(w.saved.map(wallet => wallet.ecosystem)).toEqual(['evm', 'solana']);
    expect(w.refresh).toHaveBeenCalledTimes(1);
  });
  it('a returning user recovers the same addresses and nothing is created', async () => {
    const w = world({ held: [{ ecosystem: 'evm', address: EVM, imported: false }, { ecosystem: 'solana', address: SOL, imported: false }] });
    expect(await initializeAccountWallets(w.deps)).toEqual({ status: 'ready', code: null, provisioned: [] });
    expect(w.createWallet).not.toHaveBeenCalled();
    expect(w.saved).toEqual([{ ecosystem: 'evm', address: EVM }, { ecosystem: 'solana', address: SOL }]);
  });
  it('an external-wallet sign-in is unaffected (sync only, no creation)', async () => {
    const w = world({ method: 'eip155' });
    expect((await initializeAccountWallets(w.deps)).status).toBe('ready');
    expect(w.createWallet).not.toHaveBeenCalled();
  });
  it('a wallet Privy already holds (stale client view) is saved, never duplicated', async () => {
    const w = world();
    // The client has not seen Privy's wallet yet; the server (Privy API) has: the plan reads the server list.
    w.saved.push({ ecosystem: 'evm', address: EVM });
    expect((await initializeAccountWallets(w.deps)).provisioned).toEqual(['solana']);
    expect(w.createWallet).toHaveBeenCalledWith('solana');
  });
  it('PRIVY_WALLET_LIMIT recovers through the next sync instead of failing', async () => {
    const w = world({ create: async ecosystem => { if (ecosystem === 'evm') { w.held.push({ ecosystem, address: EVM, imported: false }); throw new Error('PRIVY_WALLET_LIMIT'); }
      w.held.push({ ecosystem, address: SOL, imported: false }); return { address: SOL }; } });
    expect(await initializeAccountWallets(w.deps)).toEqual({ status: 'ready', code: null, provisioned: ['solana'] });
  });
  it('a provisioning failure is reported with its code, while the ecosystem that succeeded stays ready and registered', async () => {
    const w = world({ create: async ecosystem => { if (ecosystem === 'solana') throw new Error('PRIVY_WALLET_CREATE_FAILED'); w.held.push({ ecosystem, address: EVM, imported: false }); return { address: EVM }; } });
    expect(await initializeAccountWallets(w.deps)).toEqual({ status: 'failed', code: 'PRIVY_WALLET_CREATE_FAILED', provisioned: ['evm'] });
    expect(w.saved).toEqual([{ ecosystem: 'evm', address: EVM }]);
    expect(w.refresh).toHaveBeenCalled();
  });
  it('no FloFi session is signed-out, not a failure', async () => {
    const w = world();
    w.deps = { ...w.deps, sync: async () => ({ ok: false, code: 'ACCOUNT_SESSION_REQUIRED' }) };
    expect((await initializeAccountWallets(w.deps)).status).toBe('signed-out');
    expect(w.createWallet).not.toHaveBeenCalled();
  });
  it('a server failure is failed (recoverable), and nothing is created', async () => {
    const w = world();
    w.deps = { ...w.deps, sync: async () => ({ ok: false, code: 'PRIVY_UNAVAILABLE' }) };
    expect(await initializeAccountWallets(w.deps)).toEqual({ status: 'failed', code: 'PRIVY_UNAVAILABLE', provisioned: [] });
    expect(w.createWallet).not.toHaveBeenCalled();
  });
});

describe('wallet-execution review fixes', () => {
  it('a creation that never answers ends in failed (bounded), never an endless "setting up"', async () => {
    vi.useFakeTimers();
    try {
      const w = world({ create: () => new Promise(() => undefined) });
      const run = initializeAccountWallets(w.deps);
      await vi.advanceTimersByTimeAsync(130_000);
      expect(await run).toMatchObject({ status: 'failed', code: 'WALLET_OPERATION_TIMEOUT' });
    } finally { vi.useRealTimers(); }
  });
  it('Try again replaces a hung run instead of joining it', async () => {
    const hung = world();
    hung.deps = { ...hung.deps, sync: () => new Promise(() => undefined) };
    void runWalletLifecycle(hung.deps);
    expect(walletLifecycle().status).toBe('initializing');
    const fresh = world();
    await runWalletLifecycle(fresh.deps, true);
    expect(walletLifecycle()).toMatchObject({ status: 'ready', userId: 'did:privy:one' });
  });
  it('a Privy wallet held by another FloFi account is reported once, with nothing created', async () => {
    const w = world();
    w.deps = { ...w.deps, sync: async () => ({ ok: true, value: { wallets: [], method: 'email', heldElsewhere: 1 } }) };
    expect(await initializeAccountWallets(w.deps)).toMatchObject({ status: 'failed', code: 'ACCOUNT_WALLET_LINKED_ELSEWHERE' });
    expect(w.createWallet).not.toHaveBeenCalled();
  });
  it('a page where the provisioner is off (approval, frame) never says "setting up"', () => {
    expect(walletSlotState({ status: 'idle', code: null }, true, true)).toBe('disconnected');
  });
});

describe('channels review fix', () => {
  it('switching the provisioner off (navigating into an approval page) stops a run before it creates anything, and shows nothing', async () => {
    const w = world();
    let first = true;
    const sync = w.deps.sync;
    w.deps = { ...w.deps, sync: async token => { const result = await sync(token); if (first) { first = false; cancelWalletLifecycle(); } return result; } };
    await runWalletLifecycle(w.deps);
    expect(w.createWallet).not.toHaveBeenCalled();
    expect(walletLifecycle().status).toBe('idle');
  });
});

describe('security review fixes', () => {
  it('a Privy user switch after the first sync stops the run before any wallet is created under the next session', async () => {
    const w = world();
    let first = true;
    const sync = w.deps.sync;
    w.deps = { ...w.deps, sync: async token => { const result = await sync(token); if (first) { first = false; observePrivySession({ ready: true, authenticated: true, userId: 'did:privy:other' }); } return result; } };
    await runWalletLifecycle(w.deps);
    expect(w.createWallet).not.toHaveBeenCalled();
    expect(w.refresh).not.toHaveBeenCalled();
    expect(walletLifecycle().userId).toBeNull();
  });
  it('a run whose own liveness check fails creates nothing', async () => {
    const w = world();
    expect(await initializeAccountWallets({ ...w.deps, live: () => false })).toMatchObject({ status: 'signed-out', code: 'PRIVY_SESSION_CHANGED' });
    expect(w.createWallet).not.toHaveBeenCalled();
  });
  it('runs under the per-user cross-tab lock', async () => {
    const w = world(), names: string[] = [];
    await runWalletLifecycle({ ...w.deps, exclusive: async (name, run) => { names.push(name); return run(); } });
    expect(names).toEqual(['flofi-wallet-provision:did:privy:one']);
  });
  it('an account-service outage is a failure with Try again, not the signed-out state', async () => {
    const w = world();
    expect(await initializeAccountWallets({ ...w.deps, sync: async () => ({ ok: false, code: 'ACCOUNTS_UNAVAILABLE' }) })).toMatchObject({ status: 'failed', code: 'ACCOUNTS_UNAVAILABLE' });
  });
});

describe('page lifecycle', () => {
  it('runs once per Privy user; concurrent callers join; Try again re-runs', async () => {
    const w = world();
    await Promise.all([runWalletLifecycle(w.deps), runWalletLifecycle(w.deps)]);
    await runWalletLifecycle(w.deps);
    expect(w.sync).toHaveBeenCalledTimes(2); // one run: first sync + post-create sync
    expect(walletLifecycle()).toMatchObject({ status: 'ready', userId: 'did:privy:one' });
    await runWalletLifecycle(w.deps, true);
    expect(w.sync).toHaveBeenCalledTimes(3);
    expect(w.createWallet).toHaveBeenCalledTimes(2);
  });
  it('an account switch forgets the previous user at once and discards its run', async () => {
    let release: (() => void) | undefined;
    const slow = world({ userId: 'did:privy:one' });
    slow.deps = { ...slow.deps, sync: () => new Promise(resolve => { release = () => resolve({ ok: true, value: { wallets: [{ ecosystem: 'evm', address: EVM }, { ecosystem: 'solana', address: SOL }], method: 'email' } }); }) };
    const run = runWalletLifecycle(slow.deps);
    expect(walletLifecycle().status).toBe('initializing');
    observePrivySession({ ready: true, authenticated: true, userId: 'did:privy:two' });
    expect(walletLifecycle()).toMatchObject({ status: 'authenticating', userId: null });
    for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
    release!(); await run;
    expect(walletLifecycle().userId).toBeNull(); // the first user's result never lands on the second user's page
    const other = world({ userId: 'did:privy:two' });
    await runWalletLifecycle(other.deps);
    expect(walletLifecycle()).toMatchObject({ status: 'ready', userId: 'did:privy:two' });
  });
  it('logging out clears the lifecycle', async () => {
    await runWalletLifecycle(world().deps);
    observePrivySession({ ready: true, authenticated: false, userId: null });
    expect(walletLifecycle()).toMatchObject({ status: 'signed-out', userId: null });
  });
  it('Privy that never loads is reported, not an endless spinner', () => {
    observePrivySession({ ready: false, authenticated: false, userId: null });
    markPrivyUnavailable();
    expect(walletLifecycle()).toMatchObject({ status: 'failed', code: 'PRIVY_UNAVAILABLE' });
  });
});

describe('walletSlotState (no false "Wallet not connected")', () => {
  it('initializing while reading or provisioning, and while Privy loads for a signed-in browser', () => {
    expect(walletSlotState({ status: 'initializing', code: null }, true, false)).toBe('initializing');
    expect(walletSlotState({ status: 'authenticating', code: null }, true, true)).toBe('initializing');
  });
  it('disconnected only when truly disconnected', () => {
    expect(walletSlotState({ status: 'ready', code: null }, true, false)).toBe('disconnected');
    expect(walletSlotState({ status: 'signed-out', code: null }, false, false)).toBe('disconnected');
    expect(walletSlotState({ status: 'idle', code: null }, false, true)).toBe('disconnected');
    expect(walletSlotState({ status: 'idle', code: null }, null, true)).toBe('disconnected');
  });
  it('failed offers recovery; a slow Privy only matters to a signed-in browser', () => {
    expect(walletSlotState({ status: 'failed', code: 'PRIVY_WALLET_CREATE_FAILED' }, true, false)).toBe('failed');
    expect(walletSlotState({ status: 'failed', code: 'PRIVY_UNAVAILABLE' }, false, true)).toBe('disconnected');
    expect(walletSlotState({ status: 'failed', code: 'PRIVY_UNAVAILABLE' }, true, true)).toBe('failed');
  });
});
