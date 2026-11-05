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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AAVE_V3_LENDING_PROFILES, AAVE_V3_MARKETS, BASE_BASE_ASSETS, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import { networkCatalog, registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { ETH_TOKEN_MARK, GLYPH_MARKS, PINNED_ASSET_CATALOGS, assetIdentity, monogramText, networkFallback, networkMark, type MonogramMark,
  type VisualMark } from './asset-identity';
import { LocalMark, NetworkBrandIcon, ProviderLogo, TokenBrandIcon } from '../components/brand-icon';
import { HookHarness } from '../test-utils/hook-harness';
import { composeStrategy, semanticWorkflowHash } from '../engine/strategy-engine';
import { CATALOG_NETWORK_IDENTITIES, NETWORKS, catalogNetworkOfChatName, catalogNetworksNamed, networkIdentity } from './network-registry';
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
    // AAVE-V3-CARD-CATALOG-FIX-001: ETH and WETH now use the crisp square ETH token mark (was the tall `ethereum.svg` illustration).
    expect(mark('WETH', 'Base')).toEqual({ kind: 'image', src: ETH_TOKEN_MARK });
    expect(mark('ETH', 'Base')).toEqual({ kind: 'image', src: ETH_TOKEN_MARK });
    expect(mark('WETH', 'Robinhood Chain')).toEqual({ kind: 'image', src: ETH_TOKEN_MARK });
    expect(ETH_TOKEN_MARK).toBe('/brand/crypto/tokens/eth.svg');
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

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));
const CRYPTO = `${PUBLIC}brand/crypto/`;
/** A mark's file exists under `public/` (local marks only ever name FloFi's own files). */
const servedFile = (src: string) => src.startsWith('/brand/') && !src.includes('..') && existsSync(`${PUBLIC}${src.slice(1)}`);
const SPOOF = `0x${'d'.repeat(40)}`;
const MAINNET_RESERVES = AAVE_V3_MARKETS.flatMap(market => market.reserves.map(reserve => ({ market, reserve })));
const svgFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? svgFiles(`${directory}${entry.name}/`) : entry.name.endsWith('.svg') ? [`${directory}${entry.name}`] : []);
const viewBox = (svg: string) => /<svg\b[^>]*\bviewBox="([^"]+)"/.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number) ?? [];
const rootAttribute = (svg: string, name: string) => new RegExp(`<svg\\b[^>]*\\s${name}="([^"]+)"`).exec(svg)?.[1];

describe('AAVE-V3-CARD-CATALOG-FIX-001 token marks in Canvas cards and catalogs', () => {
  it('shows a reviewed mark for the pinned ETH, WETH and USDC of every catalog network, by address or by symbol, with or without its catalog', () => {
    resetNetworkCatalogs();
    // Every catalog network (Ethereum included) has a pinned catalog, and every pinned catalog feeds the reviewed marks.
    expect(new Set(PINNED_ASSET_CATALOGS.map(catalog => catalog.chain))).toEqual(new Set(CATALOG_NETWORK_IDENTITIES.map(network => network.chain)));
    for (const network of CATALOG_NETWORK_IDENTITIES) {
      const pinned = networkCatalog(network.chain)!.assets.filter(asset => ['ETH', 'WETH', 'USDC'].includes(asset.symbol));
      expect(pinned.length, network.name).toBeGreaterThanOrEqual(2);
      for (const asset of pinned) for (const value of [mark(asset.symbol, network.chain, asset.address ?? undefined), mark(asset.symbol, network.name)]) {
        expect(value, `${asset.symbol} on ${network.name}`).toMatchObject({ kind: 'image' });
        expect(servedFile((value as { src: string }).src), `${asset.symbol} on ${network.name}`).toBe(true);
      }
    }
    registerAll();
    for (const network of ['Ethereum', 'Base', 'Arbitrum One']) {
      expect(mark('ETH', network)).toEqual({ kind: 'image', src: ETH_TOKEN_MARK });
      expect(mark('WETH', network)).toEqual({ kind: 'image', src: ETH_TOKEN_MARK });
      expect(mark('USDC', network)).toEqual({ kind: 'image', src: '/brand/crypto/usdc.png' });
    }
  });
  it('resolves every registered Aave V3 mainnet reserve by chain and address to a served image or a non-empty monogram', () => {
    expect(new Set(AAVE_V3_MARKETS.map(market => market.network))).toEqual(new Set(['Ethereum', 'Base', 'Arbitrum One']));
    for (const loaded of [false, true]) {
      if (loaded) registerAll(); else resetNetworkCatalogs();
      for (const { market, reserve } of MAINNET_RESERVES) {
        const identity = assetIdentity({ symbol: reserve.symbol, network: market.chain, address: reserve.asset }), name = `${reserve.symbol} on ${market.network}`;
        expect(identity.fallback.text, name).toMatch(/^[A-Z0-9]{1,2}$/);
        if (identity.mark.kind === 'image') expect(servedFile(identity.mark.src), name).toBe(true);
        else if (identity.mark.kind === 'logo') { expect(loaded, name).toBe(true); expect(identity.mark.src).toMatch(/^https:\/\//); expect(identity.mark.fallback).toEqual(identity.fallback); }
        else { expect(identity.mark).toEqual(identity.fallback); expect(identity.mark.text, name).not.toBe('?'); }
      }
    }
    resetNetworkCatalogs();
    const reserveMark = (network: string, label: string) => {
      const { market, reserve } = MAINNET_RESERVES.find(item => item.market.network === network && item.reserve.symbol === label)!;
      return mark(label, market.chain, reserve.asset.toUpperCase().replace('0X', '0x'));
    };
    for (const [network, label, file] of [['Ethereum', 'DAI', 'dai'], ['Ethereum', 'LINK', 'link'], ['Ethereum', 'AAVE', 'aave'], ['Ethereum', 'WBTC', 'wbtc'],
      ['Ethereum', 'UNI', 'uni'], ['Ethereum', 'CRV', 'crv'], ['Ethereum', 'MKR', 'mkr'], ['Ethereum', 'SNX', 'snx'], ['Ethereum', 'BAL', 'bal'], ['Ethereum', '1INCH', '1inch'],
      ['Ethereum', 'KNC', 'knc'], ['Arbitrum One', 'DAI', 'dai'], ['Arbitrum One', 'LINK', 'link'], ['Arbitrum One', 'WBTC', 'wbtc'], ['Arbitrum One', 'AAVE', 'aave'],
      ['Base', 'AAVE', 'aave']] as const) expect(reserveMark(network, label), `${label} on ${network}`).toEqual({ kind: 'image', src: `/brand/crypto/tokens/${file}.svg` });
    expect(reserveMark('Ethereum', 'USDT')).toEqual({ kind: 'image', src: '/brand/crypto/usdt.svg' });
    expect(reserveMark('Arbitrum One', 'USDT')).toEqual({ kind: 'image', src: '/brand/crypto/usdt.svg' });
    // A reserve without a reviewed CC0 mark keeps its monogram; nothing is invented.
    expect(reserveMark('Ethereum', 'LDO')).toMatchObject({ kind: 'monogram', text: 'LD' });
    expect(reserveMark('Ethereum', 'GHO')).toMatchObject({ kind: 'monogram', text: 'GH' });
  });
  it('never gives a reserve or pinned mark to an unregistered address with the same symbol, nor by symbol alone', () => {
    for (const loaded of [false, true]) {
      if (loaded) registerAll(); else resetNetworkCatalogs();
      for (const { market, reserve } of MAINNET_RESERVES) {
        const spoof = assetIdentity({ symbol: reserve.symbol, network: market.chain, address: SPOOF });
        expect(spoof.mark, `${reserve.symbol} spoof on ${market.network}`).toEqual(spoof.fallback);
        // The same address on another market's chain is another token.
        for (const other of AAVE_V3_MARKETS.filter(item => item.chain !== market.chain && !item.reserves.some(candidate => candidate.asset === reserve.asset))) {
          const elsewhere = assetIdentity({ symbol: reserve.symbol, network: other.chain, address: reserve.asset });
          if (elsewhere.mark.kind === 'image') expect(elsewhere.mark.src).not.toMatch(/\/tokens\/(?!eth\.svg)/);
        }
      }
      for (const symbol of ['USDC', 'WETH', 'ETH', 'USDT', 'DAI', 'AAVE']) for (const network of ['Ethereum', 'Base', 'Arbitrum One'])
        expect(mark(symbol, network, SPOOF), `${symbol} spoof on ${network}`).toMatchObject({ kind: 'monogram', text: monogramText(symbol) });
    }
    // Symbol-only lookups never reach a reserve mark: before its catalog loads, Ethereum DAI is an unresolved symbol (a monogram).
    resetNetworkCatalogs();
    expect(mark('DAI', 'Ethereum')).toMatchObject({ kind: 'monogram', text: 'DA' });
    expect(mark('AAVE', 'Arbitrum One')).toMatchObject({ kind: 'monogram', text: 'AA' });
    expect(AAVE_V3_LENDING_PROFILES.some(profile => profile.asset === SPOOF)).toBe(false);
  });
  it('keeps an address-bound monogram identical before and after the network catalog loads', () => {
    const toshi = baseAsset(baseCatalog(), 'TOSHI').address!, cbbtc = baseAsset(baseCatalog(), 'cbBTC').address!;
    resetNetworkCatalogs();
    const before = { toshi: assetIdentity({ symbol: 'TOSHI', network: 'Base', address: toshi }), cbbtc: assetIdentity({ symbol: 'cbBTC', network: 'eip155:8453', address: cbbtc }),
      spoof: assetIdentity({ symbol: 'USDC', network: 'Base', address: SPOOF }) };
    expect(before.toshi.mark).toMatchObject({ kind: 'monogram', text: 'TO' });
    expect(before.cbbtc.mark).toMatchObject({ kind: 'monogram', text: 'CB' });
    registerAll();
    const after = { toshi: assetIdentity({ symbol: 'TOSHI', network: 'Base', address: toshi }), cbbtc: assetIdentity({ symbol: 'cbBTC', network: 'eip155:8453', address: cbbtc }),
      spoof: assetIdentity({ symbol: 'USDC', network: 'Base', address: SPOOF }) };
    expect(after.toshi.mark).toEqual(before.toshi.mark);
    expect(after.spoof.mark).toEqual(before.spoof.mark);
    // Once loaded, cbBTC shows its provider logo, whose fallback is exactly the monogram shown before; the address case does not matter.
    expect(after.cbbtc.mark).toEqual({ kind: 'logo', src: expect.stringMatching(/^https:\/\/assets\.coingecko\.com\//), fallback: before.cbbtc.mark });
    expect(assetIdentity({ symbol: 'cbBTC', network: 'Base', address: cbbtc.toUpperCase().replace('0X', '0x') })).toEqual(after.cbbtc);
    for (const key of ['toshi', 'cbbtc', 'spoof'] as const) expect(after[key].fallback, key).toEqual(before[key].fallback);
  });
  it('gives the Ethereum network a crisp badge distinct from the ETH token mark', () => {
    for (const value of ['Ethereum', 'eip155:1', 'Ethereum Sepolia']) expect(networkMark(value)).toEqual({ kind: 'image', src: '/brand/crypto/ethereum-network.svg' });
    expect(networkMark('Ethereum')).not.toEqual(mark('ETH', 'Ethereum'));
    for (const network of NETWORKS) if (network.mark) expect(servedFile(network.mark), network.name).toBe(true);
    // The tall pastel illustration is no longer a token or network mark.
    expect(NETWORKS.some(network => network.mark === '/brand/crypto/ethereum.svg')).toBe(false);
    for (const symbol of ['ETH', 'WETH']) for (const network of [...NETWORKS.map(n => n.name), undefined]) expect(mark(symbol, network)).not.toMatchObject({ src: '/brand/crypto/ethereum.svg' });
  });
  it('replaces a local mark that cannot be loaded with the same deterministic monogram, for tokens and networks', () => {
    resetNetworkCatalogs();
    const { market, reserve } = MAINNET_RESERVES.find(item => item.market.network === 'Ethereum' && item.reserve.symbol === 'DAI')!;
    const icon = TokenBrandIcon({ symbol: 'DAI', network: 'Ethereum', address: reserve.asset }) as ReactElement<{ mark: VisualMark; fallback: MonogramMark }>;
    expect(icon.props.mark).toEqual({ kind: 'image', src: '/brand/crypto/tokens/dai.svg' });
    expect(icon.props.fallback).toEqual(assetIdentity({ symbol: 'DAI', network: market.chain, address: reserve.asset }).fallback);
    const host = new HookHarness();
    const first = host.render(() => LocalMark({ src: '/brand/crypto/tokens/dai.svg', fallback: icon.props.fallback })) as ReactElement<{ onError: () => void }>;
    const html = renderToStaticMarkup(first);
    expect(html).toContain('src="/brand/crypto/tokens/dai.svg"'); expect(html).toContain('data-mark="image"'); expect(html).toContain('class="brand-icon"');
    expect(html).not.toContain('data-shape');
    first.props.onError();
    const after = host.render(() => LocalMark({ src: '/brand/crypto/tokens/dai.svg', fallback: icon.props.fallback })) as ReactElement;
    expect(renderToStaticMarkup(after)).toBe(`<span class="brand-icon-fallback brand-mark-monogram" data-mark="monogram" style="--mark-hue:${icon.props.fallback.hue}" aria-hidden="true">DA</span>`);
    // Networks: the same contract, and a transparent glyph is marked for its inset.
    const network = NetworkBrandIcon({ network: 'Ethereum' }) as ReactElement<{ mark: VisualMark; fallback: MonogramMark }>;
    expect(network.props).toEqual({ mark: networkMark('Ethereum'), fallback: networkFallback('Ethereum') });
    expect(network.props.fallback).toMatchObject({ kind: 'monogram', text: 'ET' });
    expect(renderToStaticMarkup(new HookHarness().render(() => LocalMark({ src: '/brand/crypto/solana.svg', fallback: networkFallback('Solana') })) as ReactElement)).toContain('data-shape="glyph"');
    expect([...GLYPH_MARKS].every(servedFile)).toBe(true);
    // Backward compatible: symbol only, network only, an empty address.
    expect((TokenBrandIcon({ symbol: 'USDC' }) as ReactElement<{ mark: VisualMark }>).props.mark).toEqual({ kind: 'image', src: '/brand/crypto/usdc.png' });
    expect((TokenBrandIcon({ symbol: 'WETH', network: 'Base', address: null }) as ReactElement<{ mark: VisualMark }>).props.mark).toEqual({ kind: 'image', src: ETH_TOKEN_MARK });
  });
  it('vendors only plain, square, recorded SVG marks', () => {
    const sources = readFileSync(`${CRYPTO}sources.md`, 'utf8'), files = svgFiles(CRYPTO);
    for (const file of files) {
      const svg = readFileSync(file, 'utf8'), name = file.slice(CRYPTO.length);
      expect(svg, name).not.toMatch(/<script|<foreignObject|<iframe|<!ENTITY|javascript:|@import|<\?xml-stylesheet/i);
      expect(svg, name).not.toMatch(/\son[a-z]+\s*=/i);
      for (const [, reference] of svg.matchAll(/\s(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) expect(reference, name).toMatch(/^#/);
      for (const [, reference] of svg.matchAll(/url\(\s*['"]?([^)'"]*)/gi)) expect(reference, name).toMatch(/^#/);
    }
    // Every reviewed CC0 mark and the Ethereum network badge: square, with explicit equal width and height, recorded with its served SHA-256.
    const reviewed = files.filter(file => file.includes('/tokens/') || file.endsWith('/ethereum-network.svg') || file.endsWith('/usdt.svg'));
    expect(reviewed.map(file => file.slice(CRYPTO.length)).sort()).toEqual(['ethereum-network.svg', 'tokens/1inch.svg', 'tokens/aave.svg', 'tokens/bal.svg', 'tokens/crv.svg',
      'tokens/dai.svg', 'tokens/eth.svg', 'tokens/knc.svg', 'tokens/link.svg', 'tokens/mkr.svg', 'tokens/snx.svg', 'tokens/uni.svg', 'tokens/wbtc.svg', 'usdt.svg']);
    for (const file of reviewed) {
      const svg = readFileSync(file, 'utf8'), name = file.slice(CRYPTO.length), [x, y, width, height] = viewBox(svg);
      expect([x, y], name).toEqual([0, 0]); expect(width, name).toBeGreaterThan(0); expect(width, name).toBe(height);
      if (name !== 'usdt.svg') { expect(rootAttribute(svg, 'width'), name).toBe(String(width)); expect(rootAttribute(svg, 'height'), name).toBe(String(height)); }
      expect(sources, name).toContain(`\`${name}\``);
      expect(sources, name).toContain(createHash('sha256').update(readFileSync(file)).digest('hex'));
    }
    // Every SVG the resolver serves as a token or network mark is square, except a reviewed transparent glyph (drawn inset).
    resetNetworkCatalogs();
    const served = new Set([...MAINNET_RESERVES.map(({ market, reserve }) => mark(reserve.symbol, market.chain, reserve.asset)),
      ...PINNED_ASSET_CATALOGS.flatMap(catalog => catalog.assets.map(asset => mark(asset.symbol, catalog.chain, asset.address ?? undefined))),
      ...['SOL', 'WSOL', 'USDT', 'devUSDC'].map(symbol => mark(symbol)), ...NETWORKS.map(network => networkMark(network.chain))]
      .flatMap(value => value.kind === 'image' ? [value.src] : []));
    expect(served.has(ETH_TOKEN_MARK)).toBe(true);
    for (const src of served) {
      expect(servedFile(src), src).toBe(true);
      if (!src.endsWith('.svg') || GLYPH_MARKS.has(src)) continue;
      const [, , width, height] = viewBox(readFileSync(`${PUBLIC}${src.slice(1)}`, 'utf8'));
      expect(width, src).toBe(height);
    }
  });
});
