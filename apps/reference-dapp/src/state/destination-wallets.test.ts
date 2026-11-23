// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001 (P2, Privy recovery): the signed-in FloFi account's wallets (Privy embedded EVM and Solana, and
 * the account's linked wallets) as a bridge destination reads them — one bounded retry with backoff and a timeout per attempt, a strict shape
 * check before anything is mapped, failures never cached and never shown as "no wallets", answers of another session (sign-out, another user)
 * discarded, consumers updated when a read recovers, and the owner's explicit "Try again".
 *
 * MOCKED: `accountState` (the server action), Privy's browser state, Credentials and the Solana session are test doubles; nothing is read
 * from Privy or a server, connected, signed or sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, HookHarness } from '../test-utils/hook-harness';
import { resolveDestinationWallet, type DestinationInventory } from '../domain/destination-wallet';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const f = vi.hoisted(() => ({ privy: null as null | { ready: boolean; userId: string | null; embedded: readonly { ecosystem: 'evm' | 'solana'; address: string }[] },
  calls: 0, answers: [] as (() => Promise<unknown>)[], saved: [] as { ecosystem: 'evm' | 'solana'; address: string; providerName: string }[] }));
vi.mock('../accounts/privy-context', () => ({ useFloFiPrivy: () => f.privy }));
vi.mock('../app/account-action', () => ({ accountState: () => { f.calls += 1; const next = f.answers.shift(); return next ? next() : new Promise(() => undefined); } }));
vi.mock('./credentials-store', () => ({ useCredentials: () => ({ wallets: f.saved }) }));
vi.mock('./jupiter-store', () => ({ useOptionalJupiter: () => null }));

const EVM_A = '0x' + 'a1'.repeat(20), EVM_B = '0x' + 'b2'.repeat(20);
const SOL_A = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2', SOL_B = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
const view = (wallets: readonly Record<string, unknown>[]) => ({ availability: 'AVAILABLE', privy: null, account: { accountId: 'acct_' + 'a'.repeat(32), wallets } });
const wallet = (ecosystem: 'evm' | 'solana', address: string, provider = 'privy', providerName = 'Privy') => ({ ecosystem, address, provider, providerName,
  id: `${ecosystem}:${address}`, origin: 'CREATED', export: 'NONE', label: '', addedAt: '2026-11-23T00:00:00.000Z' });
const answer = (value: unknown) => () => Promise.resolve(value);
const fail = (error = new Error('fetch failed')) => () => Promise.reject(error);

const m = await import('./destination-wallets');
beforeEach(() => {
  // The page-wide cache starts empty for every case (an invalidation forgets the previous case's read).
  m.invalidateAccountWallets();
  f.privy = { ready: true, userId: 'did:privy:alice', embedded: [] }; f.calls = 0; f.answers = []; f.saved = [];
});
afterEach(() => { vi.useRealTimers(); });

describe('accountWalletsFrom: the answer is checked before anything is mapped', () => {
  it('maps a valid account (Privy embedded EVM + Solana named FloFi Wallet, an external wallet by its own name); a signed-out answer has none', () => {
    expect(m.accountWalletsFrom(view([wallet('evm', EVM_A), wallet('solana', SOL_A), wallet('solana', SOL_B, 'app.phantom', 'Phantom')]))).toEqual([
      { ecosystem: 'evm', address: EVM_A, providerName: 'FloFi Wallet' }, { ecosystem: 'solana', address: SOL_A, providerName: 'FloFi Wallet' },
      { ecosystem: 'solana', address: SOL_B, providerName: 'Phantom' }]);
    expect(m.accountWalletsFrom({ availability: 'AVAILABLE', privy: null, account: null })).toEqual([]);
    expect(m.accountWalletsFrom(view([]))).toEqual([]);
  });
  it('refuses as a whole (never a partial list) anything that is not the account shape, and a server that could not read the account', () => {
    const malformed = [null, 'x', 42, {}, { account: {} }, { account: { wallets: {} } }, view([{}]), view([wallet('evm', SOL_A)]), view([wallet('solana', EVM_A)]),
      view([{ ...wallet('evm', EVM_A), ecosystem: 'bitcoin' }]), view([{ ...wallet('evm', EVM_A), providerName: 'x\u0000y' }]), view([{ ...wallet('evm', EVM_A), provider: 7 }]),
      view([wallet('evm', EVM_A), { ...wallet('solana', SOL_A), address: 'not-base58-0OIl' }]), view(Array.from({ length: 65 }, () => wallet('evm', EVM_A)))];
    for (const value of malformed) expect(() => m.accountWalletsFrom(value), JSON.stringify(value)?.slice(0, 80)).toThrow('ACCOUNT_WALLETS_MALFORMED');
    expect(() => m.accountWalletsFrom({ availability: 'AVAILABLE', account: null, accountUnavailable: true })).toThrow('ACCOUNT_WALLETS_UNAVAILABLE');
  });
});

describe('fetchAccountWallets: one bounded retry, a timeout per attempt', () => {
  const sleeps: number[] = [];
  const sleep = (ms: number) => { sleeps.push(ms); return Promise.resolve(); };
  beforeEach(() => { sleeps.length = 0; });
  it('a transient failure (network, server could not read the account, malformed answer) is tried once more and the recovered read is used', async () => {
    for (const first of [fail(), answer({ account: null, accountUnavailable: true }), answer({ account: { wallets: 'x' } })]) {
      const reads = [first, answer(view([wallet('solana', SOL_A)]))];
      const read = vi.fn(() => reads.shift()!());
      expect(await m.fetchAccountWallets(read, { sleep })).toEqual({ failed: false, wallets: [{ ecosystem: 'solana', address: SOL_A, providerName: 'FloFi Wallet' }] });
      expect(read).toHaveBeenCalledTimes(2);
    }
    expect(sleeps).toEqual([2_000, 2_000, 2_000]);
  });
  it('stops after its attempts with the reason; never more than three attempts whatever is asked', async () => {
    const read = vi.fn(fail());
    expect(await m.fetchAccountWallets(read, { sleep })).toEqual({ failed: true, reason: 'NETWORK', wallets: [] });
    expect(read).toHaveBeenCalledTimes(m.ACCOUNT_WALLETS_ATTEMPTS);
    const unavailable = vi.fn(answer({ account: null, accountUnavailable: true }));
    expect(await m.fetchAccountWallets(unavailable, { sleep, attempts: 50 })).toEqual({ failed: true, reason: 'UNAVAILABLE', wallets: [] });
    expect(unavailable).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2_000, 2_000, 4_000]);
    const malformed = vi.fn(answer('<html>'));
    expect(await m.fetchAccountWallets(malformed, { sleep })).toMatchObject({ failed: true, reason: 'MALFORMED' });
  });
  it('an attempt that never answers ends at its timeout; its late answer is ignored and the retry answers', async () => {
    vi.useFakeTimers();
    const late = deferred<unknown>();
    const reads = [() => late.promise, answer(view([wallet('evm', EVM_B, 'io.metamask', 'MetaMask')]))];
    const read = vi.fn(() => reads.shift()!());
    const result = m.fetchAccountWallets(read, { sleep, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    late.resolve(view([wallet('evm', EVM_A)]));
    expect(await result).toEqual({ failed: false, wallets: [{ ecosystem: 'evm', address: EVM_B, providerName: 'MetaMask' }] });
    const never = vi.fn(() => new Promise<unknown>(() => undefined));
    const timedOut = m.fetchAccountWallets(never, { sleep, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await timedOut).toEqual({ failed: true, reason: 'TIMEOUT', wallets: [] });
  });
  it('a read nobody can use any more (another session, an invalidation) is not retried', async () => {
    const read = vi.fn(fail());
    expect(await m.fetchAccountWallets(read, { sleep, stale: () => true })).toMatchObject({ failed: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });
});

describe('useDestinationInventory: Privy and the account, across sessions', () => {
  let harness: HookHarness;
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); };
  const render = () => harness.render(() => m.useDestinationInventory({ account: EVM_A, provider: { name: 'MetaMask' } }));
  const solana = (inventory: DestinationInventory) => resolveDestinationWallet('solana', inventory);
  beforeEach(() => { vi.useFakeTimers(); harness = new HookHarness(); });
  afterEach(() => harness.unmount());

  it('Google/email account with embedded EVM + Solana: loading while read (never "missing"), then the Solana wallet resolves', async () => {
    f.privy = { ready: true, userId: 'did:privy:alice', embedded: [] };
    const read = deferred<unknown>(); f.answers = [() => read.promise];
    let inventory = render();
    expect(inventory.loading).toBe(true);
    expect(solana(inventory)).toEqual({ kind: 'LOADING' });
    read.resolve(view([wallet('evm', EVM_B), wallet('solana', SOL_A)]));
    await flush(); inventory = render();
    expect(inventory.loading).toBe(false);
    expect(solana(inventory)).toMatchObject({ kind: 'RESOLVED', wallet: { address: SOL_A, providerName: 'FloFi Wallet', source: 'ACCOUNT' } });
  });
  it('a transient failure is retried while still "checking", and the recovered read updates the destination (no new sign-in)', async () => {
    f.answers = [fail(), answer(view([wallet('solana', SOL_A)]))];
    render();
    await flush(); let inventory = render();
    expect(inventory.loading).toBe(true);
    expect(solana(inventory)).toEqual({ kind: 'LOADING' });
    await vi.advanceTimersByTimeAsync(m.ACCOUNT_WALLETS_RETRY_DELAY_MS); await flush(); inventory = render();
    expect(f.calls).toBe(2);
    expect(inventory).toMatchObject({ loading: false, accountUnavailable: false });
    expect(solana(inventory)).toMatchObject({ kind: 'RESOLVED', wallet: { address: SOL_A } });
  });
  it('a definitive failure is UNAVAILABLE (not NONE), an embedded wallet is offered to CHOOSE (never filled), and Try again recovers', async () => {
    f.privy = { ready: true, userId: 'did:privy:alice', embedded: [{ ecosystem: 'solana', address: SOL_B }] };
    f.answers = [answer('<html>'), answer('<html>')];
    render();
    await flush(); await vi.advanceTimersByTimeAsync(m.ACCOUNT_WALLETS_RETRY_DELAY_MS); await flush(); let inventory = render();
    expect(inventory).toMatchObject({ loading: false, accountUnavailable: true });
    expect(solana(inventory)).toMatchObject({ kind: 'CHOOSE', candidates: [{ address: SOL_B }] });
    f.privy = { ...f.privy, embedded: [] };
    inventory = render();
    expect(solana(inventory)).toEqual({ kind: 'UNAVAILABLE' });
    // The owner's Try again: one new bounded read; every consumer sees "checking", then the recovered wallets.
    f.answers = [answer(view([wallet('solana', SOL_A)]))];
    m.retryAccountWallets(); inventory = render();
    expect(inventory.loading).toBe(true);
    await flush(); inventory = render();
    expect(inventory).toMatchObject({ loading: false, accountUnavailable: false });
    expect(solana(inventory)).toMatchObject({ kind: 'RESOLVED', wallet: { address: SOL_A } });
  });
  it('the browser coming back online after a failed read reads once more', async () => {
    const listeners: (() => void)[] = [];
    vi.stubGlobal('window', { addEventListener: (type: string, listener: () => void) => { if (type === 'online') listeners.push(listener); } });
    try {
      f.answers = [fail(), fail()];
      render(); await flush(); await vi.advanceTimersByTimeAsync(m.ACCOUNT_WALLETS_RETRY_DELAY_MS); await flush();
      expect(render().accountUnavailable).toBe(true);
      f.answers = [answer(view([wallet('solana', SOL_A)]))];
      for (const listener of listeners) listener();
      render(); await flush();
      expect(f.calls).toBe(3);
      expect(solana(render())).toMatchObject({ kind: 'RESOLVED' });
      for (const listener of listeners) listener();
      expect(f.calls).toBe(3);
    } finally { vi.unstubAllGlobals(); }
  });
  it('sign-out during the read: its late answer never fills the signed-out page', async () => {
    const read = deferred<unknown>(); f.answers = [() => read.promise, answer({ availability: 'AVAILABLE', privy: null, account: null })];
    render();
    f.privy = { ready: true, userId: null, embedded: [] };
    render(); await flush(); render();
    read.resolve(view([wallet('solana', SOL_A)]));
    await flush(); const inventory = render();
    expect(inventory.account).toEqual([]);
    expect(solana(inventory)).toEqual({ kind: 'NONE' });
  });
  it('another user during the read: only the new user’s answer is used; the previous user’s late answer is dropped', async () => {
    const alice = deferred<unknown>(); f.answers = [() => alice.promise, answer(view([wallet('solana', SOL_B, 'app.phantom', 'Phantom')]))];
    render();
    f.privy = { ready: true, userId: 'did:privy:bob', embedded: [] };
    render(); await flush();
    alice.resolve(view([wallet('solana', SOL_A)]));
    await flush();
    const inventory = render();
    expect(inventory.account.map(entry => entry.address)).toEqual([SOL_B]);
    expect(solana(inventory)).toMatchObject({ kind: 'RESOLVED', wallet: { address: SOL_B, providerName: 'Phantom' } });
  });
  it('several Solana wallets on the account (embedded and linked): CHOOSE, never a silent pick; reload restores without reading as signed out', async () => {
    f.privy = { ready: false, userId: null, embedded: [] };
    f.answers = [answer(view([wallet('solana', SOL_A), wallet('solana', SOL_B, 'app.phantom', 'Phantom')]))];
    let inventory = render();
    // Privy still restoring after a reload: nothing is read (or cached) as "signed out".
    expect(inventory.loading).toBe(true); expect(f.calls).toBe(0);
    f.privy = { ready: true, userId: 'did:privy:alice', embedded: [{ ecosystem: 'solana', address: SOL_A }] };
    render(); await flush(); inventory = render();
    expect(f.calls).toBe(1);
    expect(solana(inventory)).toMatchObject({ kind: 'CHOOSE' });
    expect(resolveDestinationWallet('evm', inventory)).toMatchObject({ kind: 'RESOLVED', wallet: { address: EVM_A, source: 'SESSION' } });
  });
});
