// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialWorkflow, freeze, type Workflow } from '../domain/initial-workflow';
import { setActiveNetworkScope } from '../domain/network-scope';
import { createRouterNode } from '../domain/router-authoring';
import { TopBar } from './top-bar';
import { HeaderSettings } from './header-settings';
import { NavigationDrawer } from './navigation-drawer';
import { WORKFLOW_STAGES } from '../domain/product-shell';
import { BUILD_ENTRY } from '../domain/build-entry';
import { translate } from '../i18n/locale';
import { portuguese } from '../i18n/pt';

const fixture = vi.hoisted(() => ({ workflow: null as unknown as Workflow, diagnosticsAvailable: false }));
const wallet = vi.hoisted(() => ({ account: null as string | null, chainId: null as string | null,
  busy: false, restoring: false, providerError: null, error: null, connect: vi.fn(), switchTo: vi.fn(), reset: vi.fn() }));
vi.mock('../state/workflow-store', () => ({ useWorkflow: () => ({ state: { workflow: fixture.workflow } }) }));
vi.mock('./header-settings', async importOriginal => {
  const actual = await importOriginal<typeof import('./header-settings')>();
  return { HeaderSettings: vi.fn(actual.HeaderSettings) };
});
vi.mock('./navigation-drawer', async importOriginal => {
  const actual = await importOriginal<typeof import('./navigation-drawer')>();
  return { NavigationDrawer: vi.fn(actual.NavigationDrawer) };
});
vi.mock('../state/build009-wallet-store', async () => {
  const { walletChainLabel } = await import('../wallet/evm-networks');
  return { useBuild009Wallet: () => wallet, chainName: walletChainLabel,
    BASE_HEX: '0x2105', ARBITRUM_HEX: '0xa4b1', BASE_SEPOLIA_HEX: '0x14a34', ROBINHOOD_TESTNET_HEX: '0xb626' };
});
vi.mock('../state/mode-a-store', () => ({ useModeA: () => ({ info: fixture.diagnosticsAvailable ? { available: true, environment: 'MOCKED' } : null, wallet: null }) }));
vi.mock('../state/mode-b-store', () => ({ useModeB: () => ({ info: fixture.diagnosticsAvailable ? { available: true } : null, wallet: null }) }));
// The shared environment hook also reads these inactive execution providers.
vi.mock('../state/liquidity-store', () => ({ useLiquidity: () => ({}) }));
vi.mock('../state/composition-store', () => ({ useComposition: () => ({}) }));
vi.mock('../state/lending-store', () => ({ useLending: () => ({ record: null, recovered: false, retired: false }) }));
vi.mock('../state/bridge-swap-store', () => ({ useBridgeSwap: () => ({ run: null, recovered: false }) }));
vi.mock('../state/router-store', () => ({ useRouter: () => ({ record: null, recovered: false, network: 'testnet' }) }));
vi.mock('../state/jupiter-store', () => ({ useJupiter: () => ({ record: null, recovered: false, owner: null, network: 'Solana', session: null, busy: false, restoring: false, disconnect: vi.fn() }) }));
// Header → Connect Wallet goes through the canonical selector hook; rendering never opens it or touches a wallet.
vi.mock('../state/wallet-connection', () => ({ useWalletConnection: () => ({ connect: wallet.connect, error: null, solanaChain: 'solana:devnet' }) }));

beforeEach(() => {
  fixture.workflow = initialWorkflow();
  fixture.diagnosticsAvailable = false;
  wallet.account = null; wallet.chainId = null;
  wallet.busy = false;
  vi.clearAllMocks();
});
afterEach(() => setActiveNetworkScope(null));


describe('product shell rendering', () => {
  it.each(['Build', 'Simulate', 'Execute'] as const)('keeps available fork diagnostics out of normal %s and preserves the engineering disclosure', tab => {
    fixture.diagnosticsAvailable = true;
    const normal = renderToStaticMarkup(createElement(TopBar, { tab, setTab: vi.fn() }));
    expect(normal).not.toMatch(/Technical connection details|Local fork|Chain 31337|Wallet permissions · local fork/);
    const engineering = renderToStaticMarkup(createElement(TopBar, { tab, setTab: vi.fn(), engineering: true }));
    expect(engineering).toContain('Technical connection details');
    expect(engineering).toContain('Chain 31337');
    expect(wallet.connect).not.toHaveBeenCalled();
    expect(wallet.switchTo).not.toHaveBeenCalled();
  });

  it('places the closed navigation trigger before the approved FloFi logo', () => {
    const html = renderToStaticMarkup(createElement(TopBar, { tab: 'Build', setTab: vi.fn() }));
    expect(html.indexOf('aria-label="Open navigation"')).toBeLessThan(html.indexOf('class="flofi-logo"'));
    expect(html).toContain('data-open="false" aria-hidden="true" inert=""');
    expect(wallet.connect).not.toHaveBeenCalled();
    expect(wallet.switchTo).not.toHaveBeenCalled();
  });

  // BUILD-FLOFI-MAINNET-PRODUCT-001: FloFi is Mainnet-only, so the header has no Mainnet/Testnet selector, whatever network the wallet is on.
  it.each([
    { chain: '0x2105', connected: true }, { chain: '0x14a34', connected: true }, { chain: '0x2105', connected: false },
  ])('has no environment selector for a wallet on $chain (connected=$connected), and never changes the wallet', ({ chain, connected }) => {
    wallet.account = connected ? '0x1111111111111111111111111111111111111111' : null;
    wallet.chainId = chain;
    const html = renderToStaticMarkup(createElement(TopBar, { tab: 'Dashboard', setTab: vi.fn() }));
    expect(html).not.toMatch(/data-environment=|aria-label="Environment"|role="combobox"|Testnet|role="listbox"/);
    expect(wallet.switchTo).not.toHaveBeenCalled();
    expect(wallet.connect).not.toHaveBeenCalled();
  });

  it.each([false, true])('boxes the wallet and renders Settings collapsed when connected=%s', connected => {
    if (connected) { wallet.account = '0x1111111111111111111111111111111111111111'; wallet.chainId = '0x14a34'; }
    const html = renderToStaticMarkup(createElement(TopBar, { tab: 'Build', setTab: vi.fn() }));
    expect(html).toMatch(/class="header-wallet" role="group" aria-label="Wallet connection">[\s\S]*?<\/div><div class="header-settings-control"><button type="button" class="header-settings"/);
    expect(html.replace(/<[^>]*>/g, '')).toContain(connected ? '0x1111…1111' : 'Wallet not connected');
    if (connected) {
      expect(html).toContain('<span class="numeric wallet-address">0x1111…1111</span>');
      expect(html).not.toContain('EVM Default:');
      // P0 approved UX (board 03b): the wallet identity names its network ("0x90f5…d303 · Base").
      expect(html).toContain('<span class="wallet-network"> · Base Sepolia</span>');
      expect(html).not.toContain('header-wallet-provider');
      // Board 16: on mainnet the visible label is the network's name, never its chain id (the hover title keeps the technical label).
      wallet.chainId = '0x2105';
      const mainnet = renderToStaticMarkup(createElement(TopBar, { tab: 'Build', setTab: vi.fn() }));
      expect(mainnet).toContain('<span class="wallet-network"> · Base</span>');
      expect(mainnet.replace(/title="[^"]*"/g, '')).not.toMatch(/\(8453\)/);
    }
    expect(html).not.toContain('>Disconnect</button>');
    if (!connected) expect(html).toContain('>Connect Wallet</button>');
    expect(vi.mocked(HeaderSettings).mock.calls.at(-1)?.[0]).toMatchObject({ onDisconnect: wallet.reset, disconnectDisabled: !connected });
    expect(vi.mocked(NavigationDrawer).mock.calls.at(-1)?.[0]).toMatchObject({ onDisconnect: wallet.reset, disconnectDisabled: !connected });
    expect(html).toMatch(/class="header-settings" aria-label="Settings" title="Settings" aria-expanded="false"><svg[\s\S]*?<\/svg><\/button>/);
    expect(html).not.toMatch(/role="dialog"|role="menu"|aria-haspopup="listbox"/);
    expect(wallet.connect).not.toHaveBeenCalled();
    expect(wallet.reset).not.toHaveBeenCalled();
    expect(wallet.switchTo).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves busy disabling for wallet actions when connected=%s', connected => {
    wallet.busy = true;
    if (connected) { wallet.account = '0x1111111111111111111111111111111111111111'; wallet.chainId = '0x14a34'; }
    const html = renderToStaticMarkup(createElement(TopBar, { tab: 'Build', setTab: vi.fn() }));
    if (!connected) expect(html).toMatch(/<button type="button" disabled=""[^>]*>Connect Wallet<\/button>/);
    expect(vi.mocked(HeaderSettings).mock.calls.at(-1)?.[0]).toMatchObject({ onDisconnect: wallet.reset, disconnectDisabled: true });
    expect(vi.mocked(NavigationDrawer).mock.calls.at(-1)?.[0]).toMatchObject({ onDisconnect: wallet.reset, disconnectDisabled: true });
  });

  // P0 approved UX (board 03b): no Dashboard | Chat | Editor tabs in the top bar (the ☰ drawer is the one navigation); its center holds what the
  // shell gives it — the Editor stepper on the Editor's sections — and the drawer marks the Editor current on each of them.
  it.each(WORKFLOW_STAGES)('holds the Editor stepper in the center on its %s section, with no stage tabs and without wallet actions', stage => {
    const setTab = vi.fn();
    const html = renderToStaticMarkup(createElement(TopBar, { tab: stage, setTab, center: createElement('span', { 'data-stepper': 'yes' }) }));
    expect(html).not.toContain('aria-label="Workflow stages"');
    expect(html).not.toMatch(/class="tabs"|>(Dashboard|Chat|Editor)<\/button>/);
    expect(html).toContain('<div class="top-bar-center"><span data-stepper="yes"></span></div>');
    expect(vi.mocked(NavigationDrawer).mock.calls.at(-1)?.[0]).toMatchObject({ section: stage });
    expect(html).not.toMatch(/Draft · Untitled workflow|Current stage ·|workspace-title|stage-guidance/);
    expect(setTab).not.toHaveBeenCalled();
    expect(wallet.connect).not.toHaveBeenCalled();
    expect(wallet.switchTo).not.toHaveBeenCalled();
    expect(wallet.reset).not.toHaveBeenCalled();
  });

  it('names the connected provider beside the address without changing the address text', () => {
    wallet.account = '0x1111111111111111111111111111111111111111'; wallet.chainId = '0x14a34';
    Object.assign(wallet, { provider: { key: 'io.rabby', name: 'Rabby Wallet', icon: 'data:image/svg+xml;base64,PHN2Zy8+' } });
    const html = renderToStaticMarkup(createElement(TopBar, { tab: 'Build', setTab: vi.fn() }));
    expect(html).toContain('<span class="header-wallet-provider" title="Rabby Wallet">');
    expect(html).toContain('<span class="sr-only">Rabby Wallet</span>');
    expect(html).toMatch(/class="build009-wallet-info wallet-connection"[^>]*title="Rabby Wallet · 0x1111111111111111111111111111111111111111 · Base Sepolia"><span class="wallet-status-dot" aria-hidden="true"><\/span><span class="numeric wallet-address">0x1111…1111<\/span>/);
    expect(html).not.toContain('EVM Default:');
    expect(wallet.connect).not.toHaveBeenCalled();
    Object.assign(wallet, { provider: undefined });
  });

  it('shows the actual connected network and the canonical Journey network separately', () => {
    setActiveNetworkScope('PUBLIC_MAINNET');
    fixture.workflow = freeze({ ...initialWorkflow(), revision: 3, nodes: [createRouterNode('bridge', {
      source: 'Base Sepolia', destination: 'Arbitrum Sepolia', token: 'USDC', amount: '1', recipient: '', slippage: '50', routing: 'AUTO',
    })] });
    wallet.account = '0x1111111111111111111111111111111111111111'; wallet.chainId = '0x2105';
    const html = renderToStaticMarkup(createElement(TopBar, { tab: 'Simulate', setTab: vi.fn() }));
    expect(html.replace(/<[^>]*>/g, '')).toContain('0x1111…1111');
    expect(html).not.toContain('EVM Default:');
    expect(html).toContain('title="EVM · 0x1111111111111111111111111111111111111111 · Base (8453)"');
    // P0 approved UX (board 04): the passive "Workflow network" label is gone (the Canvas header chip names the network); the Mainnet-only product
    // still never offers a switch into a test network, and no attention strip is invented.
    expect(html).not.toContain('Workflow network:');
    expect(html).not.toContain('Switch to Base Sepolia');
    expect(html).not.toContain('network-attention');
    expect(wallet.switchTo).not.toHaveBeenCalled();
  });

  it('an empty canvas never shows a invented workflow network', () => {
    fixture.workflow = initialWorkflow();
    wallet.account = '0x1111111111111111111111111111111111111111'; wallet.chainId = '0x2105';
    const html = renderToStaticMarkup(createElement(TopBar, { tab: 'Build', setTab: vi.fn() }));
    expect(html).not.toContain('Workflow network:');
    expect(html).toContain('<span class="numeric wallet-address">0x1111…1111</span>');
  });

  // P0 approved UX (board 03b): the top bar keeps the brand, the wallet and Settings; Dashboard, Chat (New workflow) and the Editor are reached
  // from the drawer only, with no stage numbers and no standalone Simulate or Execute tab.
  it('keeps the brand and no navigation tabs on the Dashboard', () => {
    const html = renderToStaticMarkup(createElement(TopBar, { tab: 'Dashboard', setTab: vi.fn() }));
    expect(html).not.toMatch(/<nav aria-label="Workflow stages"|>(Dashboard|Chat|Editor)<\/button>/);
    expect(html).toContain('<div class="top-bar-center"></div>');
    expect(html).not.toContain('stage-number');
    expect(html).not.toContain('data-build-stage');
    expect(html).toContain('class="flofi-logo" role="img" aria-label="FloFi"');
    expect(html).toContain('src="/brand/flofi-symbol-light.svg"');
    expect(html).toContain('src="/brand/flofi-symbol-dark.svg"');
    expect(html).not.toContain('/brand/flofi-logo.png');
    expect(html).not.toContain('Compose · Verify · Execute');
    expect(html).not.toContain('Workflow workspace');
    expect(wallet.connect).not.toHaveBeenCalled();
    expect(wallet.switchTo).not.toHaveBeenCalled();
    expect(wallet.reset).not.toHaveBeenCalled();
  });

  it.each([
    { tab: BUILD_ENTRY, section: 'Chat' }, { tab: 'Build', section: 'Build' }, { tab: 'Simulate', section: 'Simulate' }, { tab: 'Execute', section: 'Execute' },
    { tab: 'Dashboard', section: 'Dashboard' },
  ] as const)('gives the drawer New workflow in the chat-first workspace and the $section section on $tab, without wallet activity', ({ tab, section }) => {
    const html = renderToStaticMarkup(createElement(TopBar, { tab, setTab: vi.fn(), entry: true }));
    expect(html).not.toMatch(/<nav aria-label="Workflow stages"|class="tabs"/);
    const props = vi.mocked(NavigationDrawer).mock.calls.at(-1)![0];
    expect(props.section).toBe(section);
    expect(typeof props.onChat).toBe('function');
    expect(wallet.connect).not.toHaveBeenCalled();
    expect(wallet.switchTo).not.toHaveBeenCalled();
    expect(wallet.reset).not.toHaveBeenCalled();
  });

  it('keeps Disconnect in Settings only on the compact signing surface (Log out lives in the drawer elsewhere)', () => {
    renderToStaticMarkup(createElement(TopBar, { tab: 'Build', setTab: vi.fn() }));
    expect(vi.mocked(HeaderSettings).mock.calls.at(-1)?.[0]).toMatchObject({ showDisconnect: false });
    renderToStaticMarkup(createElement(TopBar, { tab: 'Build', setTab: vi.fn(), compact: true }));
    expect(vi.mocked(HeaderSettings).mock.calls.at(-1)?.[0]).toMatchObject({ showDisconnect: true });
  });

  it('renders the Chat and Editor labels from the Portuguese catalog', () => {
    expect(translate('PT', 'Chat')).toBe('Chat');
    expect(translate('PT', 'Editor')).toBe('Editor');
    expect(Object.hasOwn(portuguese, 'Chat') && Object.hasOwn(portuguese, 'Editor')).toBe(true);
  });

  it('uses the existing Build lifecycle transition from the drawer without wallet activity', () => {
    const setTab = vi.fn();
    renderToStaticMarkup(createElement(TopBar, { tab: 'Execute', pathname: '/', setTab }));
    const props = vi.mocked(NavigationDrawer).mock.calls.at(-1)![0];
    expect(props.section).toBe('Execute');
    props.onBuild();
    expect(setTab).toHaveBeenCalledExactlyOnceWith('Build');
    expect(props.onChat).toBeUndefined();
    expect(wallet.reset).not.toHaveBeenCalled();
    expect(wallet.connect).not.toHaveBeenCalled();
  });

  // BUILD-FLOFI-CHAT-EDITOR-UX-001: the drawer agrees with the top bar: Chat where the entry is offered, current on it.
  it('gives the drawer the Chat entry and section where the top bar offers Chat', () => {
    const setTab = vi.fn();
    renderToStaticMarkup(createElement(TopBar, { tab: BUILD_ENTRY, pathname: '/app', setTab, entry: true }));
    const props = vi.mocked(NavigationDrawer).mock.calls.at(-1)![0];
    expect(props.section).toBe('Chat');
    props.onChat?.();
    expect(setTab).toHaveBeenCalledExactlyOnceWith(BUILD_ENTRY);
    props.onBuild();
    expect(setTab).toHaveBeenLastCalledWith('Build');
    expect(wallet.reset).not.toHaveBeenCalled();
    expect(wallet.connect).not.toHaveBeenCalled();
  });

});
