// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARBITRUM_TOKEN_LIST_LOGOS, ASSET_LOGO_RULES, BASE_TOKEN_LIST_LOGOS, ROBINHOOD_STOCK_TOKEN_LOGOS, acceptAssetLogo, catalogAsset, catalogAssetsByName, parseBaseTokenList,
  parseRobinhoodStockTokenRegistry, robinhoodNetworkCatalog, trustedAssetLogo, type CanonicalAsset } from '../src/index.js';

/**
 * BUILD-BASE-001 (owner addendum): `CanonicalAsset.logoUrl` is presentation metadata kept only under its provider's own rule, re-checked
 * wherever it is rendered; and a catalog name resolves an asset only when it is the whole name of exactly one asset of that catalog.
 */
const BASE_FIXTURE = readFileSync(new URL('./fixtures/base-token-list-fixture.json', import.meta.url), 'utf8');
const ROBINHOOD_FIXTURE = readFileSync(new URL('./fixtures/robinhood-rhj-assets-2026-10-11.json', import.meta.url), 'utf8');
const base = parseBaseTokenList(BASE_FIXTURE, '2026-10-11T03:00:00.000Z');
const robinhood = robinhoodNetworkCatalog(parseRobinhoodStockTokenRegistry(ROBINHOOD_FIXTURE, '2026-10-11T02:00:00.000Z'));
const asset = (catalog: typeof base, symbol: string) => catalogAsset(catalog, { symbol })!;
const withLogo = (logo: unknown) => {
  const data = JSON.parse(BASE_FIXTURE) as { tokens: Record<string, unknown>[] };
  data.tokens = data.tokens.map(token => token.symbol === 'TOSHI' ? { ...token, logoURI: logo } : token);
  return asset(parseBaseTokenList(JSON.stringify(data), '2026-10-11T03:00:00.000Z'), 'TOSHI');
};

describe('BUILD-BASE-001 trusted asset logos', () => {
  it('Robinhood Stock Tokens keep their official, address-derived logo (featured and non-featured alike)', () => {
    for (const symbol of ['TSLA', 'AMZN', 'AAPL', 'CRM']) {
      const stock = asset(robinhood, symbol);
      expect(stock.logoUrl).toBe(`https://cdn.robinhood.com/ncw_assets/logos/${stock.address}.png`);
      expect(trustedAssetLogo(stock)).toBe(stock.logoUrl);
    }
    // The code-pinned USDG, WETH and ETH have no provider logo (FloFi's reviewed local marks are used for those it ships).
    expect(robinhood.assets.filter(item => item.assetClass !== 'STOCK_TOKEN').every(item => item.logoUrl === null)).toBe(true);
  });
  it('a Base list logo is kept under a reviewed image prefix; pinned assets and logo-less entries keep none', () => {
    expect(trustedAssetLogo(asset(base, 'cbBTC'))).toBe('https://assets.coingecko.com/coins/images/40143/standard/cbbtc.webp');
    expect(trustedAssetLogo(asset(base, 'ZORA'))).toBe('https://coin-images.coingecko.com/coins/images/54693/large/zora.jpg?1741094751');
    expect(trustedAssetLogo(asset(base, 'AERO'))).toBe('https://basescan.org/token/images/aerodrome_32.png');
    for (const symbol of ['ETH', 'USDC', 'WETH', 'TOSHI']) expect(trustedAssetLogo(asset(base, symbol))).toBeNull();
  });
  it('drops every other Base logo value without failing the catalog', () => {
    for (const logo of ['https://evil.example/toshi.png', 'http://assets.coingecko.com/coins/images/1/large/a.png',
      'https://assets.coingecko.com.evil.example/coins/images/1/large/a.png', 'https://user:pw@assets.coingecko.com/coins/images/1/large/a.png',
      'https://assets.coingecko.com:8443/coins/images/1/large/a.png', 'https://assets.coingecko.com/coins/images/1/large/a.png#x',
      'https://assets.coingecko.com/coins/images/1/large/a.png?size=large', 'https://assets.coingecko.com/coins/images/../../x.png',
      'https://assets.coingecko.com/coins/images/%2e%2e/x.png', 'https://assets.coingecko.com/coins/images/1//a.png',
      'https://ASSETS.coingecko.com/coins/images/1/large/a.png', 'https://raw.githubusercontent.com/someone/else/a.png',
      'ipfs://QmToshi', 'data:image/svg+xml,<svg onload=alert(1)>', 'javascript:alert(1)', `https://assets.coingecko.com/coins/images/${'a'.repeat(600)}.png`,
      42, { url: 'https://assets.coingecko.com/coins/images/1/large/a.png' }, null]) expect(withLogo(logo).logoUrl, String(logo)).toBeNull();
    expect(withLogo('https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/assets/0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4/logo.png').logoUrl)
      .toBe('https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/assets/0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4/logo.png');
  });
  it('re-checks the provider rule wherever a logo is rendered: an altered or transplanted URL is never trusted', () => {
    const tsla = asset(robinhood, 'TSLA'), amzn = asset(robinhood, 'AMZN'), cbbtc = asset(base, 'cbBTC');
    // Another Stock Token's official URL on TSLA, or an arbitrary URL, is not TSLA's logo.
    expect(trustedAssetLogo({ ...tsla, logoUrl: amzn.logoUrl })).toBeNull();
    expect(trustedAssetLogo({ ...tsla, logoUrl: 'https://evil.example/tsla.png' })).toBeNull();
    // Rules are per provider and chain: a Base asset cannot carry a Robinhood CDN logo, nor a Stock Token a Base list logo.
    expect(trustedAssetLogo({ ...cbbtc, logoUrl: tsla.logoUrl })).toBeNull();
    expect(trustedAssetLogo({ ...tsla, logoUrl: cbbtc.logoUrl })).toBeNull();
    expect(trustedAssetLogo({ ...cbbtc, chain: tsla.chain })).toBeNull();
    expect(trustedAssetLogo({ ...cbbtc, source: { ...cbbtc.source, provider: 'someone.else' } })).toBeNull();
    expect(ASSET_LOGO_RULES).toEqual([ROBINHOOD_STOCK_TOKEN_LOGOS, BASE_TOKEN_LIST_LOGOS, ARBITRUM_TOKEN_LIST_LOGOS]);
    expect(acceptAssetLogo(tsla.logoUrl, ROBINHOOD_STOCK_TOKEN_LOGOS, null)).toBeNull();
  });
});

describe('BUILD-BASE-001 catalog names', () => {
  it('resolves a whole display or catalog name, case- and spacing-insensitively, within one catalog only', () => {
    const symbols = (catalog: typeof base, name: string) => catalogAssetsByName(catalog, name).map((item: CanonicalAsset) => item.symbol);
    expect(symbols(robinhood, 'Tesla')).toEqual(['TSLA']);
    expect(symbols(robinhood, '  tesla ')).toEqual(['TSLA']);
    expect(symbols(robinhood, 'Tesla • Robinhood Token')).toEqual(['TSLA']);
    expect(symbols(robinhood, 'Salesforce')).toEqual(['CRM']);
    expect(symbols(base, 'coinbase  wrapped btc')).toEqual(['cbBTC']);
    // Never a fragment, never another network's asset: "Coinbase" is the whole name of Robinhood Chain's COIN, but only a fragment on Base.
    for (const name of ['Coinbase', 'Wrapped', 'Coinbase Wrapped', '', '   ']) expect(symbols(base, name)).toEqual([]);
    for (const name of ['Tes', 'Tesla Inc', 'Robinhood Token', '']) expect(symbols(robinhood, name)).toEqual([]);
    expect(symbols(robinhood, 'Coinbase')).toEqual(['COIN']);
    expect(symbols(base, 'Tesla')).toEqual([]);
    expect(symbols(robinhood, 'Coinbase Wrapped BTC')).toEqual([]);
  });
  it('returns every holder of a shared name so the caller asks instead of choosing', () => {
    const data = JSON.parse(BASE_FIXTURE) as { tokens: Record<string, unknown>[] };
    data.tokens = data.tokens.map(token => token.symbol === 'DEGEN' ? { ...token, name: 'Aerodrome' } : token);
    const catalog = parseBaseTokenList(JSON.stringify(data), '2026-10-11T03:00:00.000Z');
    expect(catalogAssetsByName(catalog, 'aerodrome').map(item => item.symbol).sort()).toEqual(['AERO', 'DEGEN']);
  });
});
