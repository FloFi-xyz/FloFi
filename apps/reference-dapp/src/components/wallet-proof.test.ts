// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, HookHarness } from '../test-utils/hook-harness';
import { PROOF_CHECK_TIMEOUT_MS, sameWallet, useWalletProof, walletProofMessage } from './wallet-proof';
import type { SolanaSession } from '../wallet/solana-wallet';

const f = vi.hoisted(() => ({ session: null as SolanaSession | null, connectWith: vi.fn(), choose: vi.fn(), signMessage: vi.fn(),
  challenge: vi.fn(), signIn: vi.fn(), status: vi.fn(), evmConnect: vi.fn(), evmStatus: vi.fn(), evmAccount: null as string | null,
  shell: true, directConnect: vi.fn(), preference: vi.fn(), switchClusterTo: vi.fn(),
  // The signed-in FloFi account as the page observes it (Privy); null: no Privy on this page.
  privy: null as { ready: boolean; userId: string | null } | null,
  // The EVM sign-in path: its challenge, verification and the injected wallet's requests (`personal_sign`), so the automatic path can prove it signs nothing.
  evmChallenge: vi.fn(), evmSignIn: vi.fn(), walletRequest: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
// `shell: false` is a page outside the product shell (`/connections`): no operational wallet sessions are provided there.
vi.mock('../state/jupiter-store', () => ({ useOptionalJupiter: () => f.shell ? { session: f.session, connectWith: f.connectWith, switchClusterTo: f.switchClusterTo } : null }));
vi.mock('../state/build009-wallet-store', () => ({ useOptionalBuild009Wallet: () => f.shell ? { account: f.evmAccount, connectWith: f.evmConnect } : null }));
vi.mock('./wallet-selector', () => ({ useWalletSelector: () => ({ choose: f.choose }) }));
vi.mock('../wallet/solana-wallet', () => ({ signSolanaMessage: f.signMessage, connectSolanaWallet: f.directConnect }));
vi.mock('../wallet/wallet-registry', () => ({ updateWalletPreference: f.preference }));
vi.mock('../app/wallet-session-action', () => ({ solanaSessionStatus: f.status, solanaSignInChallenge: f.challenge, solanaSignIn: f.signIn,
  walletSessionStatus: f.evmStatus, walletSignIn: f.evmSignIn, walletSignInChallenge: f.evmChallenge }));
vi.mock('../wallet/evm-discovery', () => ({ injected: () => ({ request: f.walletRequest }), chooseEvmWallet: () => ({ request: f.walletRequest }) }));
vi.mock('../accounts/privy-context', () => ({ useFloFiPrivy: () => f.privy }));

let host: HookHarness;
const owner = 'CtV2foUoy5uJaK5Wybz8Nf1xmC6TgDv93itdja7n9yvH';
const session = (chain: SolanaSession['chain']): SolanaSession => ({ chain,
  account: { address: owner, chains: [chain], features: ['solana:signTransaction', 'solana:signMessage'] },
  wallet: { name: 'Solflare', accounts: [], chains: [chain], features: {} } });
const read = () => host.render(() => useWalletProof('solana', 'solana:mainnet'));
beforeEach(() => {
  host = new HookHarness(); vi.resetAllMocks(); vi.stubGlobal('window', new EventTarget()); f.session = null; f.evmAccount = null; f.shell = true; f.privy = null;
  f.status.mockResolvedValue(null); f.evmStatus.mockResolvedValue(null);
  f.challenge.mockResolvedValue({ ok: true, value: { message: 'One-time sign-in challenge' } }); f.signMessage.mockResolvedValue('owner-proof-signature');
  f.signIn.mockResolvedValue({ ok: true, value: { account: owner } });
  // The operational wallet cannot move to the other cluster unless a test says so (it then asks for a wallet choice, as before).
  f.switchClusterTo.mockResolvedValue({ ok: false, code: 'JUPITER_SOLANA_WALLET_REQUIRED' });
});
afterEach(() => { host.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('approval proof shares the operational wallet session', () => {
  it('restores a proven EVM wallet case-insensitively, but never authorizes another selected account', async () => {
    const evm = '0x' + 'a'.repeat(40); f.evmAccount = evm.toUpperCase(); f.evmStatus.mockResolvedValue({ account: evm });
    const readEvm = () => host.render(() => useWalletProof('eip155'));
    readEvm(); await Promise.resolve(); await Promise.resolve(); expect(readEvm().proven).toBe(evm);
    f.evmAccount = '0x' + 'b'.repeat(40); expect(readEvm().proven).toBeNull();
    await Promise.resolve(); await Promise.resolve(); expect(readEvm().proven).toBeNull();
    expect(f.choose).not.toHaveBeenCalled(); expect(f.evmConnect).not.toHaveBeenCalled();
  });
  it('does not carry a proof into another namespace or accept a signature returned after the selected account changes', async () => {
    f.session = session('solana:mainnet'); const signing = deferred<{ ok: true; value: { account: string } }>(); f.signIn.mockReturnValueOnce(signing.promise);
    const pending = read().proveSolana(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const other = 'So11111111111111111111111111111111111111112';
    f.session = { ...session('solana:mainnet'), account: { ...session('solana:mainnet').account, address: other } }; read();
    signing.resolve({ ok: true, value: { account: owner } });
    expect((await pending).account).toBeNull(); expect(read().proven).toBeNull();
    expect(host.render(() => useWalletProof('eip155')).proven).toBeNull();
  });
  it('restores the valid server proof without a connection or signature request', async () => {
    f.session = session('solana:mainnet');
    f.status.mockResolvedValue({ account: owner, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    read(); await Promise.resolve(); await Promise.resolve();
    expect(read().proven).toBe(owner);
    expect(f.choose).not.toHaveBeenCalled(); expect(f.connectWith).not.toHaveBeenCalled(); expect(f.signMessage).not.toHaveBeenCalled();
  });
  it('never restores the previous wallet proof after the connected account changes or an old read finishes late', async () => {
    const old = deferred<{ account: string } | null>(); f.session = session('solana:mainnet'); f.status.mockReturnValueOnce(old.promise);
    read();
    const other = 'So11111111111111111111111111111111111111112';
    f.session = { ...session('solana:mainnet'), account: { ...session('solana:mainnet').account, address: other } };
    f.status.mockResolvedValue(null); read(); await Promise.resolve(); await Promise.resolve();
    old.resolve({ account: owner }); await Promise.resolve(); await Promise.resolve();
    expect(read().connected).toBe(other); expect(read().proven).toBeNull();
    expect(f.signMessage).not.toHaveBeenCalled();
  });
  it('clears expired proofs and rechecks the server when the page gains focus after logout', async () => {
    vi.useFakeTimers(); f.session = session('solana:mainnet');
    f.status.mockResolvedValue({ account: owner, expiresAt: new Date(Date.now() + 1000).toISOString() });
    read(); await Promise.resolve(); await Promise.resolve(); expect(read().proven).toBe(owner);
    f.status.mockResolvedValue(null); await vi.advanceTimersByTimeAsync(1000); expect(read().proven).toBeNull();
    f.status.mockResolvedValue({ account: owner, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await read().refresh(); expect(read().proven).toBe(owner);
    f.status.mockResolvedValue(null); window.dispatchEvent(new Event('focus')); await Promise.resolve(); await Promise.resolve();
    expect(read().proven).toBeNull(); expect(f.signMessage).not.toHaveBeenCalled();
  });
  it('fails closed when rechecking ownership is unavailable', async () => {
    f.status.mockResolvedValue({ account: owner }); await read().refresh(); expect(read().proven).toBe(owner);
    f.status.mockRejectedValue(new Error('offline')); await read().refresh(); expect(read().proven).toBeNull();
  });
  it('proves the already connected mainnet Solana wallet without reconnecting or opening Credentials', async () => {
    f.session = session('solana:mainnet');
    await read().proveSolana();
    expect(f.choose).not.toHaveBeenCalled(); expect(f.connectWith).not.toHaveBeenCalled();
    expect(f.signMessage).toHaveBeenCalledExactlyOnceWith(f.session, 'One-time sign-in challenge', 'WALLET');
    expect(f.signIn).toHaveBeenCalledExactlyOnceWith(owner, 'owner-proof-signature'); expect(read().proven).toBe(owner);
    expect(f.evmConnect).not.toHaveBeenCalled();
  });
  it('connects the selected Solana wallet through the operational store before proving it', async () => {
    const selected = session('solana:mainnet'); f.choose.mockResolvedValue({ key: 'Solflare' }); f.connectWith.mockResolvedValue(selected);
    await read().proveSolana();
    expect(f.choose).toHaveBeenCalledWith({ ecosystems: ['solana'], solanaChain: 'solana:mainnet', title: 'Choose a Solana wallet to prove ownership' });
    expect(f.connectWith).toHaveBeenCalledExactlyOnceWith('Solflare', 'solana:mainnet');
    expect(f.signMessage).toHaveBeenCalledWith(selected, 'One-time sign-in challenge', 'WALLET'); expect(f.evmConnect).not.toHaveBeenCalled();
  });
  it('never uses a Devnet session for a mainnet proposal and respects a cancelled wallet choice', async () => {
    f.session = session('solana:devnet'); f.choose.mockResolvedValue(null);
    await read().proveSolana();
    expect(f.switchClusterTo).toHaveBeenCalledExactlyOnceWith('solana:mainnet');
    expect(f.choose).toHaveBeenCalledOnce(); expect(f.connectWith).not.toHaveBeenCalled();
    expect(f.signMessage).not.toHaveBeenCalled(); expect(f.signIn).not.toHaveBeenCalled();
  });
  // BUILD-FLOFI-MAINNET-PRODUCT-001 (wallet E): the same wallet and account move to the proposal's cluster before any wallet chooser opens.
  it('moves the operational wallet to the proposal\'s cluster instead of asking for a wallet again', async () => {
    f.session = session('solana:devnet'); const moved = session('solana:mainnet'); f.switchClusterTo.mockResolvedValue({ ok: true, session: moved });
    await read().proveSolana();
    expect(f.choose).not.toHaveBeenCalled(); expect(f.connectWith).not.toHaveBeenCalled();
    expect(f.signMessage).toHaveBeenCalledExactlyOnceWith(moved, 'One-time sign-in challenge', 'WALLET'); expect(read().proven).toBe(owner);
  });
  // Wallet D: one sign-in serves every proof of that namespace (Save, Your workflows) — they re-read the session; nothing is signed twice.
  it('tells every other proof of the namespace about a sign-in, which re-reads the session instead of signing again', async () => {
    f.session = session('solana:mainnet');
    const other = new HookHarness(), readOther = () => other.render(() => useWalletProof('solana', 'solana:mainnet'));
    read(); readOther(); await Promise.resolve(); await Promise.resolve();
    expect(readOther().proven).toBeNull();
    f.status.mockResolvedValue({ account: owner });
    await read().proveSolana(); for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(readOther().proven).toBe(owner);
    expect(f.signMessage).toHaveBeenCalledOnce();
    other.unmount();
  });
  it('explains a failed proof in words, never a code (wallet F)', () => {
    expect(walletProofMessage('EVM_WALLET_NOT_FOUND', 'eip155')).toBe('No wallet answered. Unlock your wallet (for example MetaMask), make sure it is enabled for this site, and try again.');
    expect(walletProofMessage('WALLET_REQUEST_REJECTED', 'eip155')).toMatch(/^You declined the request in your wallet\. Nothing was signed\./);
    expect(walletProofMessage('WALLET_SOLANA_SIGN_MESSAGE_UNSUPPORTED', 'solana')).toBe('Your Solana wallet cannot sign FloFi\'s sign-in message. Choose another Solana wallet.');
    for (const code of ['WALLET_REQUEST_FAILED', 'WALLET_SIGN_IN_FAILED', 'EVM_WALLET_NOT_FOUND', 'JUPITER_SOLANA_WALLET_REQUIRED'])
      expect(walletProofMessage(code, null)).not.toMatch(/[A-Z]{3,}_[A-Z]/);
  });
  it('does not treat a saved authenticated address as an operational signing permission', async () => {
    f.status.mockResolvedValue({ account: owner });
    await read().refresh(); expect(read().proven).toBe(owner); expect(read().connected).toBeNull();
    f.choose.mockResolvedValue(null); await read().proveSolana();
    expect(f.choose).toHaveBeenCalledOnce(); expect(f.signMessage).not.toHaveBeenCalled(); expect(f.signIn).not.toHaveBeenCalled();
  });
});

/**
 * Session reuse on entering a wallet-gated page (Passkeys, Credentials → Automatic execution): the shell's proof reads the server-verified session
 * of exactly the connected wallet and the observed FloFi account. Until that read answers it exposes nothing and says it is `checking`; a read made
 * for another wallet or account never applies; nothing in this path asks any wallet for anything.
 */
describe('reusing the server-verified session of the connected wallet', () => {
  const A = '0x52908400098527886e0f7030069857d2e4169ee7', B = '0x' + 'b'.repeat(40);
  const later = (ms = 60_000) => new Date(Date.now() + ms).toISOString();
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  // The shell's proof: its namespace follows the connected owner (no wallet, no namespace), as in app-shell.
  const shell = () => host.render(() => useWalletProof(f.evmAccount ? 'eip155' : null));
  const nothingAsked = () => {
    expect(f.walletRequest).not.toHaveBeenCalled(); expect(f.evmChallenge).not.toHaveBeenCalled(); expect(f.evmSignIn).not.toHaveBeenCalled();
    expect(f.signMessage).not.toHaveBeenCalled(); expect(f.challenge).not.toHaveBeenCalled(); expect(f.signIn).not.toHaveBeenCalled();
    expect(f.choose).not.toHaveBeenCalled(); expect(f.evmConnect).not.toHaveBeenCalled(); expect(f.connectWith).not.toHaveBeenCalled();
  };

  it('is checking (and exposes no proof) until the server answers, then exposes the valid session without a click or signature', async () => {
    const read = deferred<{ account: string; expiresAt: string } | null>(); f.evmAccount = A; f.evmStatus.mockReturnValueOnce(read.promise);
    expect(shell()).toMatchObject({ checking: true, proven: null, connected: A });
    read.resolve({ account: A, expiresAt: later() }); await flush();
    expect(shell()).toMatchObject({ checking: false, proven: A });
    expect(f.evmStatus).toHaveBeenCalledOnce(); nothingAsked();
  });
  it('without a server-verified session the check ends with no proof (the explicit proof stays the only way)', async () => {
    f.evmAccount = A; shell(); await flush();
    expect(shell()).toMatchObject({ checking: false, proven: null }); nothingAsked();
  });
  it('never exposes an expired session, and withdraws a valid one at its expiry after reading the server again', async () => {
    f.evmAccount = A; f.evmStatus.mockResolvedValue({ account: A, expiresAt: new Date(Date.now() - 1).toISOString() });
    shell(); await flush(); expect(shell()).toMatchObject({ checking: false, proven: null });
    host.unmount(); host = new HookHarness(); vi.useFakeTimers();
    f.evmStatus.mockResolvedValue({ account: A, expiresAt: later(1_000) }); shell(); await flush(); expect(shell().proven).toBe(A);
    f.evmStatus.mockResolvedValue(null); const reads = f.evmStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000); expect(shell()).toMatchObject({ checking: false, proven: null });
    expect(f.evmStatus.mock.calls.length).toBeGreaterThan(reads); nothingAsked();
  });
  it('matches EVM addresses canonically (a checksummed connection is its lowercase session) and Solana addresses exactly', async () => {
    f.evmAccount = '0x52908400098527886E0F7030069857D2E4169EE7'; f.evmStatus.mockResolvedValue({ account: A, expiresAt: later() });
    shell(); await flush(); expect(shell().proven).toBe(A);
    f.evmAccount = B; expect(shell().proven).toBeNull(); await flush(); expect(shell()).toMatchObject({ checking: false, proven: null });
    expect(sameWallet('eip155', A, A.toUpperCase().replace('0X', '0x'))).toBe(true); expect(sameWallet('eip155', A, B)).toBe(false);
    expect(sameWallet('solana', owner, owner.toLowerCase())).toBe(false); expect(sameWallet('solana', owner, owner)).toBe(true);
    expect(sameWallet('eip155', null, A)).toBe(false); nothingAsked();
  });
  it('a case-only change of the same EVM address neither restarts the session read nor withdraws the proof (Solana stays exact)', async () => {
    const first = deferred<{ account: string; expiresAt: string } | null>(); f.evmAccount = A; f.evmStatus.mockReturnValueOnce(first.promise);
    expect(shell()).toMatchObject({ checking: true, proven: null });
    // The checksummed form of the same address while the first read is in flight: still that read, no second one.
    f.evmAccount = '0x52908400098527886E0F7030069857D2E4169EE7'; expect(shell()).toMatchObject({ checking: true, proven: null });
    first.resolve({ account: A, expiresAt: later() }); await flush();
    expect(shell()).toMatchObject({ checking: false, proven: A }); expect(f.evmStatus).toHaveBeenCalledOnce();
    f.evmAccount = A; expect(shell()).toMatchObject({ checking: false, proven: A }); await flush(); expect(f.evmStatus).toHaveBeenCalledOnce();
    // Solana base58 is case-sensitive: another casing is another wallet, read again and never proven by the first session.
    host.unmount(); host = new HookHarness(); f.evmAccount = null; f.session = session('solana:mainnet');
    f.status.mockResolvedValue({ account: owner, expiresAt: later() }); read(); await flush(); expect(read().proven).toBe(owner);
    const reads = f.status.mock.calls.length, lower = owner.toLowerCase();
    f.session = { ...session('solana:mainnet'), account: { ...session('solana:mainnet').account, address: lower } };
    expect(read()).toMatchObject({ checking: true, proven: null }); await flush();
    expect(f.status.mock.calls.length).toBe(reads + 1); expect(read().proven).toBeNull(); nothingAsked();
  });
  it('a slow read for wallet A that answers after the switch to wallet B never unlocks B', async () => {
    const forA = deferred<{ account: string; expiresAt: string } | null>(), forB = deferred<{ account: string; expiresAt: string } | null>();
    f.evmAccount = A; f.evmStatus.mockReturnValueOnce(forA.promise).mockReturnValueOnce(forB.promise); shell();
    f.evmAccount = B; expect(shell()).toMatchObject({ checking: true, proven: null });
    // Even an answer naming B, if it was asked for A, is not B's answer.
    forA.resolve({ account: B, expiresAt: later() }); await flush(); expect(shell()).toMatchObject({ checking: true, proven: null });
    forB.resolve(null); await flush(); expect(shell()).toMatchObject({ checking: false, proven: null }); nothingAsked();
  });
  it('another FloFi account in this page invalidates the proof at once and reads the session again; the first known account is adopted', async () => {
    f.evmAccount = A; f.privy = { ready: false, userId: null }; f.evmStatus.mockResolvedValue({ account: A, expiresAt: later() });
    shell(); await flush(); expect(shell().proven).toBe(A);
    // Privy finishing loading is not an account change: no second read, no flicker.
    const reads = f.evmStatus.mock.calls.length; f.privy = { ready: true, userId: 'did:privy:alice' }; expect(shell()).toMatchObject({ checking: false, proven: A });
    expect(f.evmStatus).toHaveBeenCalledTimes(reads);
    const again = deferred<{ account: string; expiresAt: string } | null>(); f.evmStatus.mockReturnValueOnce(again.promise);
    f.privy = { ready: true, userId: 'did:privy:bob' }; expect(shell()).toMatchObject({ checking: true, proven: null });
    again.resolve(null); await flush(); expect(shell()).toMatchObject({ checking: false, proven: null });
    // Signing out is a change too.
    f.evmStatus.mockResolvedValue({ account: A, expiresAt: later() }); await shell().refresh(); expect(shell().proven).toBe(A);
    f.privy = { ready: true, userId: null }; expect(shell()).toMatchObject({ checking: true, proven: null }); nothingAsked();
  });
  it('a disconnect withdraws the proof and ends the check', async () => {
    f.evmAccount = A; f.evmStatus.mockResolvedValue({ account: A, expiresAt: later() }); shell(); await flush(); expect(shell().proven).toBe(A);
    f.evmAccount = null; expect(shell()).toMatchObject({ checking: false, proven: null, connected: null }); nothingAsked();
  });
  it('a read that never answers stops `checking` after the bound (the explicit proof is offered); a late answer still applies', async () => {
    vi.useFakeTimers(); const slow = deferred<{ account: string; expiresAt: string } | null>(); f.evmAccount = A; f.evmStatus.mockReturnValueOnce(slow.promise);
    expect(shell().checking).toBe(true);
    await vi.advanceTimersByTimeAsync(PROOF_CHECK_TIMEOUT_MS - 1); expect(shell().checking).toBe(true);
    await vi.advanceTimersByTimeAsync(1); expect(shell()).toMatchObject({ checking: false, proven: null });
    slow.resolve({ account: A, expiresAt: later() }); await flush(); expect(shell().proven).toBe(A); nothingAsked();
  });
  it('an explicit proof attempt that supersedes the first read and is cancelled reads the session again (never stuck checking)', async () => {
    const first = deferred<{ account: string } | null>(); f.status.mockReturnValueOnce(first.promise); f.choose.mockResolvedValue(null);
    expect(read().checking).toBe(true);
    f.status.mockResolvedValue({ account: owner }); await read().proveSolana(); await Promise.resolve(); await Promise.resolve();
    expect(read()).toMatchObject({ checking: false, proven: owner });
    first.resolve(null); await Promise.resolve(); await Promise.resolve(); expect(read().proven).toBe(owner);
    expect(f.signMessage).not.toHaveBeenCalled(); expect(f.signIn).not.toHaveBeenCalled();
  });
  it('accepts an explicit proof only for the FloFi account it started under', async () => {
    f.session = session('solana:mainnet'); f.privy = { ready: true, userId: 'did:privy:alice' };
    const signing = deferred<{ ok: true; value: { account: string } }>(); f.signIn.mockReturnValueOnce(signing.promise);
    read(); await Promise.resolve(); await Promise.resolve();
    const pending = read().proveSolana(); for (let i = 0; i < 4; i++) await Promise.resolve();
    f.privy = { ready: true, userId: 'did:privy:bob' }; read();
    signing.resolve({ ok: true, value: { account: owner } });
    expect((await pending).account).toBeNull(); expect(read().proven).toBeNull();
  });
});

describe('a proof outside the product shell (/connections)', () => {
  it('renders without the operational stores and proves the explicitly chosen wallet through its own connection', async () => {
    f.shell = false;
    expect(read().connected).toBeNull();
    const selected = session('solana:mainnet'); f.choose.mockResolvedValue({ key: 'Solflare' }); f.directConnect.mockResolvedValue(selected);
    await read().proveSolana();
    expect(f.choose).toHaveBeenCalledOnce(); expect(f.directConnect).toHaveBeenCalledExactlyOnceWith('Solflare', 'solana:mainnet', 'WALLET');
    expect(f.preference).toHaveBeenCalledExactlyOnceWith({ solana: 'Solflare' }); expect(f.connectWith).not.toHaveBeenCalled();
    expect(f.signMessage).toHaveBeenCalledExactlyOnceWith(selected, 'One-time sign-in challenge', 'WALLET'); expect(read().proven).toBe(owner);
  });
  it('asks for a wallet choice and signs nothing when the owner cancels it', async () => {
    f.shell = false; f.choose.mockResolvedValue(null);
    await read().proveSolana(); await read().proveEvm();
    expect(f.choose).toHaveBeenCalledTimes(2); expect(f.directConnect).not.toHaveBeenCalled();
    expect(f.signMessage).not.toHaveBeenCalled(); expect(f.signIn).not.toHaveBeenCalled(); expect(read().error).toBeNull();
  });
});
