// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { HookHarness } from '../../test-utils/hook-harness';
import type { PortfolioHolding, PortfolioNetwork, WalletPortfolio, WalletPortfolioResult } from '../../domain/wallet-portfolio';
import { PortfolioWidget } from './portfolio-widget';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../../test-utils/hook-harness')).hookMocks }));
// The widget's server action is never reached: every test injects its own `load`.
vi.mock('../../app/portfolio-action', () => ({ walletPortfolio: async () => ({ ok: false, code: 'PORTFOLIO_UNAVAILABLE' }) }));
// The real translator, with this widget's catalog available whether or not the central catalog registers it yet.
vi.mock('../../i18n/pt', async original => ({ portuguese: { ...(await import('../../i18n/pt-portfolio')).portuguesePortfolio,
  ...(await original<typeof import('../../i18n/pt')>()).portuguese } }));
const locale = vi.hoisted(() => ({ language: 'EN' as 'EN' | 'PT' }));
vi.mock('../../i18n/locale', async original => {
  const actual = await original<typeof import('../../i18n/locale')>();
  return { ...actual, useLocale: () => ({ language: locale.language, setLanguage: () => undefined,
    t: (value: unknown, ...parameters: (string | number)[]) => actual.translate(locale.language, value, ...parameters) }) };
});

const OWNER = '0x' + 'ab'.repeat(20), OTHER = '0x' + 'cd'.repeat(20);
const network = (id: PortfolioNetwork['id'], name: string, status: PortfolioNetwork['status'], extra: Partial<PortfolioNetwork> = {}): PortfolioNetwork => ({
  id, name, chain: id === 'base' ? 'eip155:8453' : id === 'ethereum' ? 'eip155:1' : id === 'arbitrum-one' ? 'eip155:42161' : 'eip155:4663', chainId: 8453, ecosystem: 'evm', status,
  provenance: status === 'NOT_ENABLED' ? null : 'PUBLIC_MAINNET', observedAt: status === 'READ' ? '2026-11-02T12:00:00.000Z' : null, block: status === 'READ' ? '38123456' : null,
  slot: null, tokens: status === 'READ' ? 'ALL' : null, uncheckedTokens: 0, code: status === 'READ' ? null : status === 'NOT_ENABLED' ? 'NETWORK_NOT_ENABLED' : 'PUBLIC_RPC_UNAVAILABLE', ...extra });
const ETH: PortfolioHolding = { networkId: 'base', network: 'Base', chain: 'eip155:8453', symbol: 'ETH', name: 'Ether', address: null, decimals: 18,
  units: '1500000000000000000', displayUnits: '1500000000000000000', displayBasis: 'RAW', unavailableCode: null, native: true, provenance: 'PUBLIC_MAINNET', price: { usd: '3000.5', source: 'CHAINLINK', observedAt: '2026-11-02T11:59:00.000Z' },
  valueUsd: '4500.75', logo: null };
const USDC: PortfolioHolding = { ...ETH, symbol: 'USDC', name: 'USD Coin', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, units: '1234560000', displayUnits: '1234560000', native: false,
  price: null, valueUsd: null };
function snapshot(extra: Partial<WalletPortfolio> = {}): WalletPortfolio {
  return { format: 'flofi.wallet-portfolio.v2', observedAt: '2026-11-02T12:00:00.000Z', accounts: [{ ecosystem: 'evm', address: OWNER }],
    networks: [network('ethereum', 'Ethereum', 'NOT_ENABLED'), network('base', 'Base', 'READ'), network('arbitrum-one', 'Arbitrum One', 'NOT_ENABLED'),
      network('robinhood', 'Robinhood Chain', 'UNAVAILABLE')],
    holdings: [ETH, USDC], pricedTotalUsd: '4500.75', unpricedCount: 1, unlisted: 0, priceSource: 'CHAINLINK', mocked: false, ...extra };
}

let host: HookHarness;
type Props = Parameters<typeof PortfolioWidget>[0];
const view = (props: Props) => host.render(() => renderToStaticMarkup(PortfolioWidget(props) as ReactElement));
/** The host element whose props match, found through the widget's own function components (handlers stay callable). */
function find(node: unknown, match: (props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, match); if (found) return found; } return null; }
  if (!node || typeof node !== 'object' || !('props' in node)) return null;
  const element = node as { type: unknown; props: Record<string, unknown> };
  if (typeof element.type === 'string' && match(element.props)) return element.props;
  return find(typeof element.type === 'function' ? (element.type as (props: unknown) => unknown)(element.props) : element.props.children, match);
}
const click = (props: Props, match: (props: Record<string, unknown>) => boolean) => {
  const target = host.render(() => find(PortfolioWidget(props), match));
  expect(target).not.toBeNull();
  (target!.onClick as () => void)();
};
const disclosure = (props: Record<string, unknown>) => props['aria-controls'] === 'dashboard-portfolio-details';
const labelled = (text: string) => (props: Record<string, unknown>) => props.type === 'button' && props.children === text;
async function settle() { for (let i = 0; i < 5; i++) await Promise.resolve(); }
const loader = (...results: WalletPortfolioResult[]) => vi.fn(async () => results.length > 1 ? results.shift()! : results[0]!);

beforeEach(() => { host = new HookHarness(); locale.language = 'EN'; });
afterEach(() => host.unmount());

describe('Dashboard wallet portfolio widget', () => {
  it('shows a compact priced card that expands into identity, networks and an Assets table', async () => {
    const load = loader({ ok: true, portfolio: snapshot() }), props: Props = { evm: OWNER, solana: null, load };
    const loading = view(props);
    expect(loading).toContain('Reading wallet balances…'); expect(loading).not.toMatch(/\$|<table/);
    await settle();
    expect(load).toHaveBeenCalledWith({ evm: OWNER, solana: null });
    const compact = view(props);
    expect(compact).toContain('Wallet portfolio'); expect(compact).toContain('Priced holdings'); expect(compact).toContain('≈ $4,500.75');
    expect(compact).toContain('1 of 2 holdings priced'); expect(compact).toContain('ETH <span class="numeric">100%</span>');
    expect(compact).toContain('Some networks could not be read.'); expect(compact).toContain('aria-expanded="false"');
    expect(compact).toContain('aria-controls="dashboard-portfolio-details"'); expect(compact).toContain('Show details');
    expect(compact).not.toContain('<table'); expect(compact).not.toContain('Collapse');
    click(props, disclosure);
    const expanded = view(props);
    expect(expanded).toContain('aria-expanded="true"'); expect(expanded).toContain('Hide details');
    expect(expanded).toContain('EVM wallet'); expect(expanded).toContain(`title="${OWNER}"`); expect(expanded).toContain('0xabab…abab'); expect(expanded).toContain('Copy address');
    expect(expanded).toContain('Block 38123456'); expect(expanded).toContain('Unavailable'); expect(expanded).toContain('Not enabled on this deployment: Ethereum, Arbitrum One');
    expect(expanded).toMatch(/<table[^>]*>.*<th scope="col">Asset<\/th><th scope="col">Network<\/th>.*Balance.*Price.*Value/);
    expect(expanded).toContain('1.5</td>'); expect(expanded).toContain('$3,000.50'); expect(expanded).toContain('$4,500.75');
    expect(expanded).toContain('1,234.56</td>'); expect(expanded).toMatch(/1,234\.56<\/td><td class="[^"]*">—<\/td><td class="[^"]*">—<\/td>/);
    expect(expanded).toMatch(/Prices: Chainlink USD feeds on Base, observed [^<]*2026[^<]*11:59[^<]* UTC\. Values are estimates, not quotes\./);
    expect(expanded).toContain('Only assets with a verified Chainlink USD feed on this deployment are priced.');
    expect(expanded).toContain('Your FloFi executions are in Your workflows.');
    expect(expanded).not.toMatch(/role="tab"|>Transactions<|>DeFi<|>Perpetuals</);
    click(props, labelled('Collapse'));
    expect(view(props)).toContain('aria-expanded="false"');
  });
  it('renders in Portuguese with Portuguese number formatting', async () => {
    locale.language = 'PT';
    const props: Props = { evm: OWNER, solana: null, load: loader({ ok: true, portfolio: snapshot() }) };
    view(props); await settle();
    const compact = view(props);
    expect(compact).toContain('Portfólio da carteira'); expect(compact).toContain('≈ US$ 4.500,75'); expect(compact).toContain('1 de 2 ativos com preço');
    expect(compact).toContain('Ver detalhes');
    click(props, disclosure);
    const expanded = view(props);
    expect(expanded).toContain('Ativos'); expect(expanded).toContain('Saldo'); expect(expanded).toContain('Rede principal'); expect(expanded).toContain('Carteira EVM');
    expect(expanded).toContain('1.234,56</td>'); expect(expanded).toContain('1,5</td>'); expect(expanded).toContain('Recolher');
    expect(expanded).toContain('Não habilitadas nesta implantação: Ethereum, Arbitrum One');
  });
  it('shows a balance by the token’s own rules with its raw amount kept apart, and an uninterpretable balance as unavailable, never a number', async () => {
    const SCALED: PortfolioHolding = { ...USDC, networkId: 'solana', network: 'Solana', chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', symbol: 'xAAPL', name: 'Apple xStock',
      address: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', decimals: 8, units: '300000000', displayUnits: '450000000', displayBasis: 'SCALED_UI_AMOUNT' };
    const ODD: PortfolioHolding = { ...SCALED, symbol: 'ODD', name: 'Odd token', address: 'Odd1111111111111111111111111111111111111111', units: '777', displayUnits: null,
      displayBasis: 'RAW', unavailableCode: 'SOLANA_TOKEN_EXTENSION_UNSUPPORTED' };
    const props: Props = { evm: null, solana: 'So1ana1111111111111111111111111111111111111', load: loader({ ok: true, portfolio: snapshot({ holdings: [SCALED, ODD],
      pricedTotalUsd: null, unpricedCount: 2, accounts: [{ ecosystem: 'solana', address: 'So1ana1111111111111111111111111111111111111' }] }) }) };
    view(props); await settle();
    expect(view(props)).toContain('4.5 xAAPL · ODD: balance unavailable');
    click(props, disclosure);
    const expanded = view(props);
    expect(expanded).toMatch(/title="On-chain amount: 3"[^>]*>4\.5<small[^>]*>Scaled by the token multiplier<\/small><\/td>/);
    expect(expanded).toMatch(/data-code="SOLANA_TOKEN_EXTENSION_UNSUPPORTED"><span>Unavailable<\/span><small>This token uses a Token-2022 extension FloFi cannot interpret/);
    expect(expanded).not.toContain('>777<'); expect(expanded).not.toContain('0.00000777');
    host = new HookHarness(); locale.language = 'PT';
    view(props); await settle(); click(props, disclosure);
    const pt = view(props);
    expect(pt).toContain('Ajustado pelo multiplicador do token'); expect(pt).toContain('Quantidade on-chain: 3'); expect(pt).toContain('Indisponível');
  });
  it('shows an unavailable state with Retry, and Retry reads again', async () => {
    const load = loader({ ok: false, code: 'PORTFOLIO_UNAVAILABLE' }, { ok: true, portfolio: snapshot() }), props: Props = { evm: OWNER, solana: null, load };
    view(props); await settle();
    const failed = view(props);
    expect(failed).toContain('Wallet balances are unavailable right now.'); expect(failed).toContain('role="alert"'); expect(failed).not.toContain('$');
    click(props, labelled('Retry'));
    view(props); await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(view(props)).toContain('≈ $4,500.75');
  });
  it('treats a failed request as unavailable, never as an empty wallet', async () => {
    const props: Props = { evm: OWNER, solana: null, load: vi.fn(async () => { throw new Error('network'); }) };
    view(props); await settle();
    const html = view(props);
    expect(html).toContain('Wallet balances are unavailable right now.'); expect(html).not.toContain('No balances found');
  });
  it('shows no USD figure at all where the deployment has no price source', async () => {
    const props: Props = { evm: OWNER, solana: null, load: loader({ ok: true, portfolio: snapshot({ holdings: [{ ...ETH, price: null, valueUsd: null }, USDC],
      pricedTotalUsd: null, unpricedCount: 2, priceSource: null }) }) };
    view(props); await settle();
    const compact = view(props);
    expect(compact).toContain('Holdings: 2'); expect(compact).toContain('1,234.56 USDC · 1.5 ETH'); expect(compact).toContain('USD values are unavailable on this deployment.');
    click(props, disclosure);
    const expanded = view(props);
    expect(expanded).not.toContain('$'); expect(expanded).not.toContain('Priced holdings');
    expect(expanded).toContain('USD values are unavailable on this deployment.');
  });
  it('labels test data and fixture prices as MOCKED', async () => {
    const fixture = { ...ETH, provenance: 'MOCKED' as const, price: { ...ETH.price!, source: 'FIXTURE' as const } };
    const props: Props = { evm: OWNER, solana: null, load: loader({ ok: true, portfolio: snapshot({ holdings: [fixture], unpricedCount: 0, priceSource: 'FIXTURE', mocked: true,
      networks: [network('base', 'Base', 'READ', { provenance: 'MOCKED' })] }) }) };
    view(props); await settle();
    expect(view(props)).toContain('Test data (MOCKED)');
    click(props, disclosure);
    const expanded = view(props);
    expect(expanded).toContain('Prices: test fixture (MOCKED), observed'); expect(expanded).not.toContain('Chainlink');
  });
  it('separates an empty wallet, unlisted tokens and a deployment with no enabled network', async () => {
    const empty: Props = { evm: OWNER, solana: null, load: loader({ ok: true, portfolio: snapshot({ holdings: [], pricedTotalUsd: null, unpricedCount: 0, unlisted: 2 }) }) };
    view(empty); await settle();
    expect(view(empty)).toContain('No balances found on the networks read.');
    click(empty, disclosure);
    expect(view(empty)).toContain('2 unlisted tokens not shown');
    host = new HookHarness();
    const none: Props = { evm: OWNER, solana: null, load: loader({ ok: true, portfolio: snapshot({ holdings: [], pricedTotalUsd: null, unpricedCount: 0,
      networks: [network('base', 'Base', 'NOT_ENABLED')] }) }) };
    view(none); await settle();
    const html = view(none);
    expect(html).toContain('No network is enabled for balance reads on this deployment.'); expect(html).not.toContain('aria-expanded');
    host = new HookHarness();
    const down: Props = { evm: OWNER, solana: null, load: loader({ ok: true, portfolio: snapshot({ holdings: [], pricedTotalUsd: null, unpricedCount: 0,
      networks: [network('base', 'Base', 'UNAVAILABLE')] }) }) };
    view(down); await settle();
    const unavailable = view(down);
    expect(unavailable).toContain('Wallet balances are unavailable right now.'); expect(unavailable).toContain('>Refresh</button>');
    expect(unavailable).not.toContain('No balances found');
  });
  it('asks for a wallet without reading anything, and never shows one wallet’s figures for another', async () => {
    const idle = vi.fn(async (): Promise<WalletPortfolioResult> => ({ ok: true, portfolio: snapshot() }));
    const disconnected = view({ evm: null, solana: null, load: idle });
    await settle();
    expect(disconnected).toContain('Connect a wallet to see its balances.'); expect(idle).not.toHaveBeenCalled();
    const load = vi.fn(async (): Promise<WalletPortfolioResult> => ({ ok: true, portfolio: snapshot() }));
    view({ evm: OWNER, solana: null, load }); await settle();
    expect(view({ evm: OWNER, solana: null, load })).toContain('≈ $4,500.75');
    const switched = view({ evm: OTHER, solana: null, load });
    expect(switched).toContain('Reading wallet balances…'); expect(switched).not.toContain('$4,500.75');
    await settle();
    expect(load).toHaveBeenLastCalledWith({ evm: OTHER, solana: null });
  });
});
