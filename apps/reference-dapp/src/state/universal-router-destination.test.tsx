// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001 (incident: an Arbitrum One MetaMask owner, a cross-ecosystem bridge, "Connect the wallet that will
 * sign this workflow" on every Simulate): the universal router store reads the bridge's recipient through the shared `destinationRequirement`,
 * and a bridge whose receiving wallet is not resolved is refused BEFORE the source wallet is asked for its sign-in signature and before the
 * server is asked to simulate. Within one ecosystem (EVM → EVM) nothing more than the signing wallet is needed.
 *
 * MOCKED: the wallet stores, the server actions and the destination inventory are test doubles; nothing is connected, signed or sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DestinationResolution } from '../domain/destination-wallet';

const fixture = vi.hoisted(() => ({ workflow: { nodes: [] as unknown[], revision: 1 }, evm: { kind: 'NONE' } as DestinationResolution, solana: { kind: 'NONE' } as DestinationResolution,
  calls: [] as string[] }));
const record = (name: string) => () => { fixture.calls.push(name); return Promise.resolve({ ok: false, code: 'NOT_EXPECTED' }); };
vi.mock('./workflow-store', () => ({ useWorkflow: () => ({ runtimeWorkflow: fixture.workflow }) }));
vi.mock('./build009-wallet-store', () => ({ injected: () => null, useBuild009Wallet: () => ({ account: '0x90f5aa2a1b2c3d4e5f60718293a4b5c6d7e8d303', chainId: '0xa4b1',
  session: () => { fixture.calls.push('wallet.session'); return Promise.resolve({ account: '0x90f5aa2a1b2c3d4e5f60718293a4b5c6d7e8d303', chainId: '0xa4b1' }); },
  connect: () => { fixture.calls.push('wallet.connect'); return Promise.resolve(null); } }) }));
vi.mock('./jupiter-store', () => ({ useJupiter: () => ({ session: null, connect: () => Promise.resolve() }) }));
vi.mock('./settlement-sync', () => ({ useSettlementSync: () => undefined }));
vi.mock('./destination-wallets', () => ({ resolvedAddress: (r: DestinationResolution) => r.kind === 'RESOLVED' ? r.wallet.address : null,
  useDestinationWallets: () => ({ inventory: { session: [], account: [], saved: [] }, evm: fixture.evm, solana: fixture.solana }) }));
vi.mock('../app/wallet-session-action', () => ({ walletSessionStatus: record('walletSessionStatus'), walletSignInChallenge: record('walletSignInChallenge'),
  walletSignIn: record('walletSignIn'), solanaSessionStatus: record('solanaSessionStatus'), solanaSignInChallenge: record('solanaSignInChallenge'), solanaSignIn: record('solanaSignIn') }));
vi.mock('../app/universal-router-action', () => new Proxy({}, { get: (_target, name) => name === 'then' ? undefined : record(String(name)) }));

const { UniversalRouterProvider, useUniversalRouter } = await import('./universal-router-store');
const { createUniversalBridgeFromInput } = await import('../domain/universal-bridge-authoring');
type Router = ReturnType<typeof useUniversalRouter>;
function mount(): Router {
  let router: Router | null = null;
  function Probe() { router = useUniversalRouter(); return null; }
  renderToStaticMarkup(createElement(UniversalRouterProvider, { children: createElement(Probe) }));
  return router!;
}
const bridge = (source: 'arbitrum-one' | 'solana' | 'base', destination: 'solana' | 'base' | 'ethereum', recipient = '') => {
  fixture.workflow = { nodes: [createUniversalBridgeFromInput('bridge', { source, destination, inputAsset: 'USDC', outputAsset: 'USDC', amount: '5', recipient, slippage: '100', routing: 'BEST' })], revision: 1 };
};
const SOLANA = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2';
const phantom = { kind: 'RESOLVED', wallet: { ecosystem: 'solana', address: SOLANA, providerName: 'Phantom', source: 'SESSION' }, alternatives: [] } as const;

describe('BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001 universal router store destination gate', () => {
  beforeEach(() => { fixture.calls = []; fixture.evm = { kind: 'NONE' }; fixture.solana = { kind: 'NONE' }; });
  it('Arbitrum One → Solana with no Solana wallet: REQUIRED, and Simulate asks for no sign-in and no server simulation', async () => {
    bridge('arbitrum-one', 'solana');
    const router = mount();
    expect(router.owner).toBe('0x90f5aa2a1b2c3d4e5f60718293a4b5c6d7e8d303');
    expect(router.destination).toEqual({ kind: 'REQUIRED' });
    expect(router.destinationIssue).toBe('UNIVERSAL_DESTINATION_WALLET_REQUIRED');
    fixture.calls = [];
    await router.simulate();
    expect(fixture.calls).toEqual([]);
  });
  it('several Solana wallets: CHOOSE; the account still loading: LOADING — both refused before any sign-in', async () => {
    bridge('arbitrum-one', 'solana');
    fixture.solana = { kind: 'CHOOSE', candidates: [] };
    expect(mount().destinationIssue).toBe('UNIVERSAL_DESTINATION_WALLET_CHOICE_REQUIRED');
    fixture.solana = { kind: 'LOADING' };
    const router = mount();
    expect(router.destinationIssue).toBe('UNIVERSAL_DESTINATION_WALLETS_LOADING');
    fixture.calls = [];
    await router.simulate();
    expect(fixture.calls).toEqual([]);
  });
  it('a resolved Solana wallet (Phantom, or a Privy embedded one) fills the destination: no issue, and Simulate proceeds to the source sign-in', async () => {
    bridge('arbitrum-one', 'solana');
    fixture.solana = phantom;
    const router = mount();
    expect(router.destination).toEqual({ kind: 'RESOLVED', wallet: phantom.wallet });
    expect(router.destinationIssue).toBeNull();
    expect(router.destinationWallet).toBe(SOLANA);
    fixture.calls = [];
    await router.simulate();
    expect(fixture.calls[0]).toBe('wallet.session');
  });
  it('EVM → EVM (Base → Ethereum) needs only the signing wallet, whatever the destination inventory says', () => {
    bridge('base', 'ethereum');
    const router = mount();
    expect(router.destination).toEqual({ kind: 'OWNER' });
    expect(router.destinationIssue).toBeNull();
    expect(router.destinationWallet).toBeNull();
  });
  it('a typed Solana address is the recipient as written; nothing is resolved or blocked for it', () => {
    bridge('arbitrum-one', 'solana', SOLANA);
    const router = mount();
    expect(router.destination).toEqual({ kind: 'EXPLICIT', address: SOLANA });
    expect(router.destinationIssue).toBeNull();
  });
});
