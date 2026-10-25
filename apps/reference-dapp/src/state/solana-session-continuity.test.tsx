// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001 (wallets B and C): the shared Solana session across wallet-side events, reloads and workflows. A MOCKED Wallet
 * Standard wallet stands in for Phantom; how the real extension behaves on lock, account switch and site disconnect is verified by the owner.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSolanaSwapNode } from '../domain/jupiter-authoring';
import { setActiveNetworkScope } from '../domain/network-scope';
import { HookHarness } from '../test-utils/hook-harness';
import { solanaWallets } from '../wallet/solana-wallet';
import { JupiterProvider, useJupiter } from './jupiter-store';

const f = vi.hoisted(() => ({ workflow: null as unknown }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
vi.mock('../components/wallet-selector', () => ({ useWalletSelector: () => ({ open: false, choose: async () => null }) }));
vi.mock('./workflow-store', () => ({ useWorkflow: () => ({ state: { workflow: f.workflow } }) }));
const { action } = vi.hoisted(() => ({ action: () => ({ info: vi.fn(async () => ({ ok: true, value: { executionEnabled: false } })), any: vi.fn(async () => ({ ok: false, code: 'UNUSED' })) }) }));
vi.mock('../app/jupiter-action', () => { const a = action(); return { jupiterInfo: a.info, jupiterSimulate: a.any, jupiterReview: a.any, jupiterInvalidate: a.any,
  jupiterBegin: a.any, jupiterWalletFailure: a.any, jupiterSubmit: a.any, jupiterObserve: a.any, jupiterStatus: a.any }; });
vi.mock('../app/solana-devnet-action', () => { const a = action(); return { solanaDevnetInfo: a.info, solanaDevnetSimulate: a.any, solanaDevnetReview: a.any,
  solanaDevnetInvalidate: a.any, solanaDevnetBegin: a.any, solanaDevnetWalletFailure: a.any, solanaDevnetSubmit: a.any, solanaDevnetObserve: a.any, solanaDevnetStatus: a.any }; });

const PREFERENCE = 'flofi.wallet.preference.v1';
const chains = ['solana:mainnet', 'solana:devnet'];
const A = { address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgA91', chains, features: ['solana:signTransaction', 'solana:signMessage'] };
const evmWorkflow = { workflowId: 'w', revision: 1, nodes: [{ nodeId: 'n1', actionType: 'swap', chainId: 'eip155:8453', parameters: {} }], edges: [] };
const devnetWorkflow = { workflowId: 'w', revision: 1, nodes: [createSolanaSwapNode('n1', { network: 'Solana Devnet', from: 'devUSDC', to: 'SOL', amount: '1', slippage: '50' })], edges: [] };

function storage() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } }; }
type Target = EventTarget & { localStorage: ReturnType<typeof storage> };
/** One browser for the file; each test registers its own wallet (as an extension does) and unregisters it afterwards. */
const target = Object.assign(new EventTarget(), { localStorage: storage(), setTimeout, clearTimeout }) as Target;
let wallet: ReturnType<typeof phantom>, unregister = () => {};
/** A Wallet Standard wallet: `silent` answers only while the site is authorized and unlocked, and every change is broadcast. */
function phantom() {
  const listeners = new Set<(event: unknown) => void>(), calls: string[] = [];
  const state = { authorized: true, unlocked: true, accounts: [A] as typeof A[] };
  const self = { name: 'Phantom', chains, get accounts() { return state.accounts; }, features: {
    'standard:connect': { connect: async (input?: { silent?: boolean }) => { calls.push(input?.silent ? 'silent' : 'prompt');
      return { accounts: state.authorized && state.unlocked ? state.accounts : [] }; } },
    'standard:disconnect': { disconnect: async () => { calls.push('disconnect'); state.authorized = false; } },
    'standard:events': { on: (_event: string, listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
    'solana:signTransaction': { signTransaction: async () => [] } } };
  return { self, state, calls, emit: (accounts: typeof A[]) => { for (const l of [...listeners]) l({ accounts }); }, listeners };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function mount() {
  const host = new HookHarness(); let store!: ReturnType<typeof useJupiter>;
  function Probe() { store = useJupiter(); return null; }
  const read = () => { host.render(() => renderToStaticMarkup(<JupiterProvider><Probe/></JupiterProvider>)); return store; };
  // The first render starts the silent restore; the second commits its result (and the session's own event subscription).
  read(); await settle(); read(); await settle();
  return { host, read };
}
const preference = () => JSON.parse(target.localStorage.getItem(PREFERENCE) ?? '{}') as Record<string, unknown>;
beforeAll(() => { vi.stubGlobal('window', target); solanaWallets(); });
afterAll(() => { vi.unstubAllGlobals(); });
beforeEach(() => {
  wallet = phantom();
  target.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (api: { register(w: unknown): () => void }) => { unregister = api.register(wallet.self); } }));
  target.localStorage.removeItem(PREFERENCE);
  target.localStorage.setItem(PREFERENCE, JSON.stringify({ solana: 'Phantom', solanaDisconnected: false }));
  f.workflow = evmWorkflow;
});
afterEach(() => { unregister(); setActiveNetworkScope(null); });

describe('the Solana session follows the wallet, never a guess (wallets B and C)', () => {
  it('a wallet-side drop ends the session without recording an owner Disconnect, and the account comes back silently when the wallet reports it', async () => {
    setActiveNetworkScope('PUBLIC_MAINNET');
    const { host, read } = await mount();
    expect(read().session).toMatchObject({ chain: 'solana:mainnet', account: { address: A.address } });
    const revision = read().revision;
    // Phantom locks, or the owner switches to an account not connected to FloFi: the wallet reports no account.
    wallet.state.unlocked = false; wallet.emit([]); await settle();
    expect(read().session).toBeNull();
    expect(read().revision).toBeGreaterThan(revision);
    expect(preference().solanaDisconnected).toBe(false);
    // Unlocked again / switched back: the wallet reports the account; FloFi asks silently (never a prompt) and adopts what the wallet authorizes.
    wallet.state.unlocked = true; wallet.emit([A]); await settle();
    expect(read().session).toMatchObject({ chain: 'solana:mainnet', account: { address: A.address } });
    expect(wallet.calls.filter(c => c !== 'silent')).toEqual([]);
    host.unmount();
    // A reload restores it silently too.
    const again = await mount();
    expect(again.read().session?.account.address).toBe(A.address);
    expect(wallet.calls.filter(c => c !== 'silent')).toEqual([]);
    again.host.unmount();
  });
  it('never undoes the owner\'s Disconnect: not when the wallet reports accounts, not after a reload', async () => {
    setActiveNetworkScope('PUBLIC_MAINNET');
    const { host, read } = await mount();
    expect(read().session).not.toBeNull();
    await read().disconnect(); await settle();
    expect(read().session).toBeNull();
    expect(preference().solanaDisconnected).toBe(true);
    wallet.state.authorized = true; wallet.emit([A]); await settle();
    expect(read().session).toBeNull();
    host.unmount();
    const before = wallet.calls.length, again = await mount();
    expect(again.read().session).toBeNull();
    expect(wallet.calls.slice(before)).toEqual([]);
    again.host.unmount();
  });
  it('a wallet that no longer authorizes FloFi stays disconnected: the wallet decides, nothing prompts', async () => {
    setActiveNetworkScope('PUBLIC_MAINNET');
    const { host, read } = await mount();
    // The owner removes FloFi in the wallet's connected-apps list: the wallet reports no account, and answers a silent request with none.
    const silent = () => wallet.calls.filter(c => c === 'silent').length, before = silent();
    wallet.state.authorized = false; wallet.emit([]); await settle();
    expect(read().session).toBeNull(); await settle();
    expect(read().session).toBeNull();
    expect(silent()).toBeGreaterThan(before);
    expect(wallet.calls.every(c => c === 'silent')).toBe(true);
    host.unmount();
  });
  it('restores on mainnet-beta in the public product and never moves the wallet to Devnet, even for a legacy Devnet workflow', async () => {
    setActiveNetworkScope('PUBLIC_MAINNET');
    f.workflow = devnetWorkflow;
    const { host, read } = await mount();
    expect(read().session?.chain).toBe('solana:mainnet');
    expect(read().owner).toBeNull();
    host.unmount();
  });
  it('keeps the workflow\'s cluster in engineering certification', async () => {
    setActiveNetworkScope('ENGINEERING');
    f.workflow = devnetWorkflow;
    const { host, read } = await mount();
    expect(read().session?.chain).toBe('solana:devnet');
    host.unmount();
  });
});
