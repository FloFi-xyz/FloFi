// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: the generic network and token visual identity. Reviewed local marks for code-pinned assets (by chain and address) and on
 * networks without an official catalog; a catalog asset's provider logo only when its provider's rule accepts it for that exact asset
 * (owner addendum: Robinhood Stock Tokens, Base list tokens), with a deterministic monogram as the fallback; otherwise the monogram.
 * Network marks are always local. Presentation never changes the workflow IR or its hash.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { BASE_BASE_ASSETS, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { assetIdentity, monogramText, networkMark, type VisualMark } from './asset-identity';
import { ProviderLogo } from '../components/brand-icon';
import { HookHarness } from '../test-utils/hook-harness';
import { composeStrategy, semanticWorkflowHash } from '../engine/strategy-engine';
import { NETWORKS, catalogNetworkOfChatName, catalogNetworksNamed, networkIdentity } from './network-registry';
import { baseAsset, baseCatalog } from '../server/base-mainnet.test-harness';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const registerAll = () => { registerNetworkCatalog(baseCatalog()); registerNetworkCatalog(officialCatalog()); };
beforeAll(registerAll);
afterEach(registerAll);
afterAll(() => resetNetworkCatalogs());
const mark = (symbol: string, network?: string, address?: string) => assetIdentity({ symbol, network, address }).mark;
const CDN = 'https://cdn.robinhood.com/ncw_assets/logos/';
/** The same catalog with one asset's presentation metadata replaced (identity untouched). */
const withLogo = (catalog: AssetCatalog, symbol: string, logoUrl: string | null): AssetCatalog =>
  ({ ...catalog, assets: catalog.assets.map(asset => asset.symbol === symbol ? { ...asset, logoUrl } : asset) });

describe('BUILD-BASE-001 network and asset visual identity', () => {
  it('shows local marks only for the code-pinned assets of a catalog network', () => {
    const usdc = BASE_BASE_ASSETS.assets.find(a => a.symbol === 'USDC')!;
    expect(mark('USDC', 'Base')).toEqual({ kind: 'image', src: '/brand/crypto/usdc.png' });
    expect(mark('USDC', 'eip155:8453', usdc.address!)).toEqual({ kind: 'image', src: '/brand/crypto/usdc.png' });
    expect(mark('WETH', 'Base')).toEqual({ kind: 'image', src: '/brand/crypto/ethereum.svg' });
    expect(mark('ETH', 'Base')).toEqual({ kind: 'image', src: '/brand/crypto/ethereum.svg' });
    expect(mark('WETH', 'Robinhood Chain')).toEqual({ kind: 'image', src: '/brand/crypto/ethereum.svg' });
  });
  it('shows a Robinhood Stock Token\'s validated official logo, featured or not, through the same resolver', () => {
    const catalog = officialCatalog();
    for (const symbol of ['TSLA', 'AMZN', 'CRM']) {
      const address = baseAsset(catalog, symbol).address!;
      for (const value of [mark(symbol, 'Robinhood Chain'), mark(symbol, 'eip155:4663', address), mark(symbol.toLowerCase(), 'Robinhood Chain')])
        expect(value).toEqual({ kind: 'logo', src: `${CDN}${address}.png`, fallback: expect.objectContaining({ kind: 'monogram', text: symbol.slice(0, 2) }) });
    }
  });
  it('shows a Base list logo only when the provider supplied a trusted one; otherwise a deterministic monogram', () => {
    const cbbtc = mark('cbBTC', 'Base');
    expect(cbbtc).toEqual({ kind: 'logo', src: 'https://assets.coingecko.com/coins/images/40143/standard/cbbtc.webp',
      fallback: expect.objectContaining({ kind: 'monogram', text: 'CB' }) });
    expect(mark('cbBTC', 'Base', baseAsset(baseCatalog(), 'cbBTC').address!)).toEqual(cbbtc);
    expect(mark('DEGEN', 'Base')).toMatchObject({ kind: 'logo', src: 'https://assets.coingecko.com/coins/images/34515/large/android-chrome-512x512.png?1706198225' });
    // No provider logo (TOSHI), a token-list entry whose symbol is a known brand (USDT), the code-pinned USDG: never a symbol-inferred image.
    expect(mark('TOSHI', 'Base')).toMatchObject({ kind: 'monogram', text: 'TO' });
    expect(mark('USDT', 'Base')).toMatchObject({ kind: 'monogram', text: 'US' });
    expect(mark('USDG', 'Robinhood Chain')).toMatchObject({ kind: 'monogram', text: 'US' });
  });
  it('never shows an untrusted logo, even on an altered catalog object', () => {
    registerNetworkCatalog(withLogo(baseCatalog(), 'cbBTC', 'https://evil.example/cbbtc.png'));
    expect(mark('cbBTC', 'Base')).toMatchObject({ kind: 'monogram', text: 'CB' });
    const official = officialCatalog(), amzn = baseAsset(official, 'AMZN');
    registerNetworkCatalog(withLogo(official, 'TSLA', amzn.logoUrl));
    expect(mark('TSLA', 'Robinhood Chain')).toMatchObject({ kind: 'monogram', text: 'TS' });
    expect(mark('AMZN', 'Robinhood Chain')).toMatchObject({ kind: 'logo', src: amzn.logoUrl });
  });
  it('never lets a symbol cross networks: the same or a similar symbol elsewhere keeps its own identity', () => {
    // Robinhood Chain's TSLA logo is not reachable from Base, from a network without a catalog, or with no network at all.
    for (const network of ['Base', 'Base Sepolia', 'Arbitrum One', undefined]) expect(mark('TSLA', network).kind).toBe('monogram');
    for (const network of ['Robinhood Chain', 'Base Sepolia', undefined]) expect(mark('cbBTC', network).kind).toBe('monogram');
    // Same symbol, another identity: another hue.
    expect((mark('AERO', 'Base') as { fallback: { hue: number } }).fallback.hue).not.toBe((mark('AERO', 'Robinhood Chain') as { hue: number }).hue);
    expect(mark('tsla', 'Robinhood Chain')).toEqual(mark('TSLA', 'Robinhood Chain'));
  });
  it('replaces a missing, broken or blocked logo with its deterministic monogram', () => {
    const logo = mark('TSLA', 'Robinhood Chain') as Extract<VisualMark, { kind: 'logo' }>;
    const host = new HookHarness();
    const first = host.render(() => ProviderLogo({ mark: logo })) as ReactElement<{ onError: () => void }>;
    const html = renderToStaticMarkup(first);
    expect(html).toContain(`src="${logo.src}"`);
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('data-mark="logo"');
    expect(html).not.toMatch(/<svg|dangerouslySetInnerHTML/);
    first.props.onError();
    const after = host.render(() => ProviderLogo({ mark: logo })) as ReactElement;
    expect(renderToStaticMarkup(after)).toBe(`<span class="brand-icon-fallback brand-mark-monogram" data-mark="monogram" style="--mark-hue:${logo.fallback.hue}" aria-hidden="true">TS</span>`);
  });
  it('presentation metadata never reaches the workflow: the IR and its hash are identical with, without or with another logo', () => {
    const strategies = [{ action: 'swap', network: 'robinhood', inputAsset: 'USDG', outputAsset: 'TSLA', amount: '50', slippageBps: 50 },
      { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'cbBTC', amount: '100', slippageBps: 50 }] as const;
    const compose = () => strategies.map(strategy => {
      const composed = composeStrategy(strategy);
      if (!composed.ok) throw new Error(composed.code);
      return { json: JSON.stringify(composed.workflow), hash: semanticWorkflowHash(composed.workflow) };
    });
    const withLogos = compose();
    expect(withLogos.every(item => !/logo|cdn\.robinhood|coingecko/i.test(item.json))).toBe(true);
    registerNetworkCatalog(withLogo(officialCatalog(), 'TSLA', null)); registerNetworkCatalog(withLogo(baseCatalog(), 'cbBTC', null));
    expect(compose()).toEqual(withLogos);
    registerNetworkCatalog(withLogo(baseCatalog(), 'cbBTC', 'https://coin-images.coingecko.com/coins/images/1/large/other.png?1'));
    expect(compose()).toEqual(withLogos);
  });
  it('keeps the existing marks on networks without an official catalog, and a neutral monogram otherwise', () => {
    expect(mark('USDC', 'Base Sepolia')).toEqual({ kind: 'image', src: '/brand/crypto/usdc.png' });
    expect(mark('SOL', 'Solana')).toEqual({ kind: 'image', src: '/brand/crypto/solana.svg' });
    expect(mark('devUSDC')).toEqual({ kind: 'image', src: '/brand/crypto/usdc.png' });
    expect(mark('XYZ')).toMatchObject({ kind: 'monogram', text: 'XY' });
  });
  it('resolves network marks by chain, name or alias, always to a reviewed local mark', () => {
    for (const value of ['Base', 'eip155:8453', 'Base (8453)', 'base']) expect(networkMark(value)).toEqual({ kind: 'image', src: '/brand/crypto/base.svg' });
    expect(networkMark('Arbitrum')).toEqual(networkMark('Arbitrum One'));
    expect(networkMark('Polygon')).toMatchObject({ kind: 'monogram', text: 'PO' });
    for (const network of NETWORKS) expect(network.mark === null || network.mark.startsWith('/brand/')).toBe(true);
    // Local (`image`) marks are always FloFi's own files; only a provider `logo` points elsewhere.
    for (const symbol of ['USDC', 'WETH', 'cbBTC', 'TSLA', 'SOL']) for (const network of ['Base', 'Robinhood Chain', 'Solana', undefined]) {
      const value = mark(symbol, network);
      if (value.kind === 'image') expect(value.src).toMatch(/^\/brand\//);
    }
    expect(monogramText('cbBTC')).toBe('CB'); expect(monogramText('1INCH')).toBe('1I'); expect(monogramText('—')).toBe('?');
  });
  it('names catalog networks from text or an untrusted intent, for loading their catalogs only', () => {
    expect(catalogNetworksNamed('swap 1 USDC to cbBTC on Base').map(n => n.key)).toEqual(['base']);
    expect(catalogNetworksNamed('swap on Base Sepolia').map(n => n.key)).toEqual([]);
    expect(catalogNetworksNamed('database of robinhoods').map(n => n.key)).toEqual([]);
    expect(catalogNetworksNamed('anything', { action: { network: 'ROBINHOOD' } }).map(n => n.key)).toEqual(['robinhood']);
    expect(catalogNetworkOfChatName('Robinhood Chain')?.key).toBe('robinhood');
    expect(catalogNetworkOfChatName('Robinhood Testnet')).toBeNull();
    expect(networkIdentity('eip155:4663')?.environment).toBe('MAINNET');
  });
});
