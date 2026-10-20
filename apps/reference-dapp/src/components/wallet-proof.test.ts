// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookHarness } from '../test-utils/hook-harness';
import { useWalletProof } from './wallet-proof';
import type { SolanaSession } from '../wallet/solana-wallet';

const f = vi.hoisted(() => ({ session: null as SolanaSession | null, connectWith: vi.fn(), choose: vi.fn(), signMessage: vi.fn(),
  challenge: vi.fn(), signIn: vi.fn(), status: vi.fn(), evmConnect: vi.fn(), evmStatus: vi.fn(), shell: true, directConnect: vi.fn(), preference: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
// `shell: false` is a page outside the product shell (`/connections`): no operational wallet sessions are provided there.
vi.mock('../state/jupiter-store', () => ({ useOptionalJupiter: () => f.shell ? { session: f.session, connectWith: f.connectWith } : null }));
vi.mock('../state/build009-wallet-store', () => ({ useOptionalBuild009Wallet: () => f.shell ? { account: null, connectWith: f.evmConnect } : null }));
vi.mock('./wallet-selector', () => ({ useWalletSelector: () => ({ choose: f.choose }) }));
vi.mock('../wallet/solana-wallet', () => ({ signSolanaMessage: f.signMessage, connectSolanaWallet: f.directConnect }));
vi.mock('../wallet/wallet-registry', () => ({ updateWalletPreference: f.preference }));
vi.mock('../app/wallet-session-action', () => ({ solanaSessionStatus: f.status, solanaSignInChallenge: f.challenge, solanaSignIn: f.signIn,
  walletSessionStatus: f.evmStatus, walletSignIn: vi.fn(), walletSignInChallenge: vi.fn() }));

let host: HookHarness;
const owner = 'CtV2foUoy5uJaK5Wybz8Nf1xmC6TgDv93itdja7n9yvH';
const session = (chain: SolanaSession['chain']): SolanaSession => ({ chain,
  account: { address: owner, chains: [chain], features: ['solana:signTransaction', 'solana:signMessage'] },
  wallet: { name: 'Solflare', accounts: [], chains: [chain], features: {} } });
const read = () => host.render(() => useWalletProof('solana', 'solana:mainnet'));
beforeEach(() => {
  host = new HookHarness(); vi.resetAllMocks(); vi.stubGlobal('window', new EventTarget()); f.session = null; f.shell = true;
  f.status.mockResolvedValue(null); f.evmStatus.mockResolvedValue(null);
  f.challenge.mockResolvedValue({ ok: true, value: { message: 'One-time sign-in challenge' } }); f.signMessage.mockResolvedValue('owner-proof-signature');
  f.signIn.mockResolvedValue({ ok: true, value: { account: owner } });
});
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); });

describe('approval proof shares the operational wallet session', () => {
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
    expect(f.choose).toHaveBeenCalledOnce(); expect(f.connectWith).not.toHaveBeenCalled();
    expect(f.signMessage).not.toHaveBeenCalled(); expect(f.signIn).not.toHaveBeenCalled();
  });
  it('does not treat a saved authenticated address as an operational signing permission', async () => {
    f.status.mockResolvedValue({ account: owner });
    await read().refresh(); expect(read().proven).toBe(owner); expect(read().connected).toBeNull();
    f.choose.mockResolvedValue(null); await read().proveSolana();
    expect(f.choose).toHaveBeenCalledOnce(); expect(f.signMessage).not.toHaveBeenCalled(); expect(f.signIn).not.toHaveBeenCalled();
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
