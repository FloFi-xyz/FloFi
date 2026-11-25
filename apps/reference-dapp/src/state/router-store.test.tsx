// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (final wallet-execution review): the Router store's simulation that FloFi starts by itself — a
 * single card falling back to its own flow after its Review — is non-interactive. It never opens the wallet selector (`wallet.connect()`) and
 * never asks for the EIP-4361 sign-in (`personal_sign`): without a connected wallet or a FloFi session it ends with the store's existing inline
 * error. The owner's own Simulate click asks for both exactly as before. Every server action and the wallet are doubles (no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HookHarness } from '../test-utils/hook-harness';
import { createRouterNode } from '../domain/router-authoring';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const OWNER = '0x' + 'ab'.repeat(20);
const f = vi.hoisted(() => ({
  /** `wallet.session()`: the connected account, or none. */
  connected: null as { account: string; chainId: string } | null,
  /** What the wallet selector returns when it is opened. */
  selected: null as { account: string; chainId: string } | null,
  /** FloFi's HttpOnly wallet session (`walletSessionStatus`), or none. */
  floFiSession: null as { account: string; expiresAt: string } | null,
  nodes: [] as SemanticWorkflow['nodes'],
  status: null as { owner: string; review: { intent: { sourceChain: string; destinationChain: string } } } | null,
  calls: { connect: 0, challenge: 0, signIn: 0, simulate: 0, personalSign: 0 },
}));
vi.mock('../i18n/locale', () => ({ useLocale: () => ({ t: (text: string) => text }) }));
vi.mock('./workflow-store', () => ({ useWorkflow: () => ({ runtimeWorkflow: { schemaVersion: '1.0.0', workflowId: 'wf-router', revision: 1, nodes: f.nodes, resourceEdges: [] } }) }));
vi.mock('./settlement-sync', () => ({ useSettlementSync: () => undefined }));
vi.mock('./wallet-request-lifecycle', () => ({ watchWalletResponse: vi.fn(), walletResultStorage: () => null, rememberWalletReport: vi.fn(), forgetWalletReport: vi.fn(),
  readWalletReports: () => [], walletReportRecorded: () => false }));
vi.mock('./build009-wallet-store', () => ({
  useBuild009Wallet: () => ({ account: f.connected?.account ?? null, chainId: f.connected?.chainId ?? null, session: async () => f.connected,
    connect: async () => { f.calls.connect++; return f.selected; }, switchTo: async () => undefined }),
  injected: () => ({ request: async ({ method }: { method: string }) => { if (method === 'personal_sign') { f.calls.personalSign++; return '0x' + '11'.repeat(65); } throw new Error('DENIED'); } }),
}));
vi.mock('../app/wallet-session-action', () => ({
  walletSessionStatus: async () => f.floFiSession,
  walletSignInChallenge: async () => { f.calls.challenge++; return { ok: true, value: { message: 'FloFi sign-in' } }; },
  walletSignIn: async (account: string) => { f.calls.signIn++; return { ok: true, value: { account, expiresAt: '2999-01-01T00:00:00.000Z' } }; },
  walletSignOut: async () => undefined,
}));
vi.mock('../app/router-action', () => {
  const refused = async () => ({ ok: false, code: 'ROUTER_TEST_DOUBLE' });
  return { crossChainRouterMode: async () => 'off', routerInfo: refused, routerRuns: async () => ({ ok: true, value: [] }),
    routerStatus: async () => f.status ? { ok: true, value: f.status } : refused(), routerBegin: refused,
    routerHandoff: refused, routerInvalidate: refused, routerObserve: refused, routerRefresh: refused, routerReport: refused, routerReview: refused, routerWalletFailure: refused,
    routerSimulate: async () => { f.calls.simulate++; return { ok: false, code: 'ROUTER_SIMULATION_DOUBLE' }; } };
});
const { RouterProvider, useRouter } = await import('./router-store');

let host: HookHarness, store: ReturnType<typeof useRouter>;
function Probe() { store = useRouter(); return null; }
const read = () => host.render(() => renderToStaticMarkup(<RouterProvider><Probe/></RouterProvider>));
async function settle(rounds = 10) { for (let i = 0; i < rounds; i++) { await new Promise(resolve => setTimeout(resolve, 0)); read(); } }
async function act(action: () => Promise<void>) { await action(); await settle(); }

beforeEach(() => {
  host = new HookHarness();
  f.connected = null; f.selected = null; f.floFiSession = null; f.calls = { connect: 0, challenge: 0, signIn: 0, simulate: 0, personalSign: 0 };
  f.nodes = [createRouterNode('bridge', { source: 'Base', destination: 'Arbitrum', token: 'USDC', amount: '1', recipient: '', slippage: '100', routing: 'AUTO' })];
  f.status = null;
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined } });
});
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); });

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the Router store simulation FloFi starts by itself never prompts', () => {
  it('no connected wallet: the non-interactive simulation never opens the wallet selector; the owner\'s own click does', async () => {
    read(); await settle();
    await act(() => store.simulate({ interactive: false }));
    expect(store.error).toBe('ROUTER_WALLET_REQUIRED');
    expect(f.calls).toEqual({ connect: 0, challenge: 0, signIn: 0, simulate: 0, personalSign: 0 });
    await act(() => store.simulate());
    expect(f.calls.connect).toBe(1);
    expect(store.error).toBe('ROUTER_WALLET_REQUIRED');
  });

  it('a connected wallet without a FloFi session: never asked to sign in automatically; the owner\'s own click signs in once, then simulates', async () => {
    f.connected = { account: OWNER, chainId: '0x2105' };
    read(); await settle();
    await act(() => store.simulate({ interactive: false }));
    expect(store.error).toBe('WALLET_SESSION_REQUIRED');
    expect(f.calls).toEqual({ connect: 0, challenge: 0, signIn: 0, simulate: 0, personalSign: 0 });
    await act(() => store.simulate());
    expect(f.calls).toMatchObject({ connect: 0, challenge: 1, personalSign: 1, signIn: 1, simulate: 1 });
  });

  it('a connected wallet with this account\'s FloFi session: the non-interactive simulation adopts it and simulates read-only, with no prompt', async () => {
    f.connected = { account: OWNER, chainId: '0x2105' };
    read(); await settle();
    f.floFiSession = { account: OWNER, expiresAt: '2999-01-01T00:00:00.000Z' };
    await act(() => store.simulate({ interactive: false }));
    expect(f.calls).toEqual({ connect: 0, challenge: 0, signIn: 0, simulate: 1, personalSign: 0 });
    expect(store.error).toBe('ROUTER_SIMULATION_DOUBLE');
  });
});

describe('Router network selection', () => {
  it('an idle store defaults to mainnet presentation and never asks for permission or simulates an unauthored pair', async () => {
    f.nodes = [];
    read(); await settle();
    expect(store.network).toBe('mainnet');
    await act(() => store.simulate());
    expect(store.error).toBe('ROUTER_PAIR_UNSUPPORTED');
    expect(f.calls.simulate).toBe(0);
    expect(f.calls.connect).toBe(0);
  });
  it.each([
    ['an unknown pair', 'eip155:10', 'eip155:8453'],
    ['another registered pair', 'eip155:1', 'eip155:42161'],
  ])('does not adopt a saved run reporting %s', async (_label, sourceChain, destinationChain) => {
    f.floFiSession = { account: OWNER, expiresAt: '2999-01-01T00:00:00.000Z' };
    f.status = { owner: OWNER, review: { intent: { sourceChain, destinationChain } } };
    read(); await settle();
    await act(() => store.open('xroute-' + '11'.repeat(16)));
    expect(store.record).toBeNull();
    expect(store.recovered).toBe(false);
  });
});
