// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARBITRUM_BASE_ASSETS, BASE_BASE_ASSETS, ROBINHOOD_BASE_ASSETS, assetDisplayName, catalogAsset, contentSha256, createAssetCatalog,
  createAssetRegistry, featuredAssets, formatAssetAmount, isChecksumAddress, toChecksumAddress, mergeAssetCatalogs, parseAssetAmount, parseMultiplier, searchAssets,
  workflowAsset } from '../src/asset-registry.js';
import { ROBINHOOD_FEATURED_STOCKS, parseRobinhoodStockTokenRegistry, parseTradingCapabilities, robinhoodNetworkCatalog, underlyingShares } from '../src/robinhood-stock-tokens.js';
import { UNISWAP_V3_ROBINHOOD, uniswapV3PoolAddress } from '../src/uniswap-v3-robinhood.js';

/** The official `GET https://api.robinhood.com/rhj/assets` payload captured read-only on 2026-10-11 (discovery §2). */
const OFFICIAL = readFileSync(new URL('./fixtures/robinhood-rhj-assets-2026-10-11.json', import.meta.url), 'utf8');
const FETCHED = '2026-10-11T02:00:00.000Z';
const payload = () => JSON.parse(OFFICIAL) as { assets: Record<string, unknown>[] };
const parse = (value: unknown) => parseRobinhoodStockTokenRegistry(typeof value === 'string' ? value : JSON.stringify(value), FETCHED);
const mutate = (index: number, patch: Record<string, unknown>) => { const data = payload(); data.assets[index] = { ...data.assets[index], ...patch }; return data; };
const indexOf = (symbol: string) => payload().assets.findIndex(asset => asset.tokenSymbol === symbol);

describe('official Robinhood Stock Token catalog', () => {
  const stocks = parse(OFFICIAL);
  const catalog = robinhoodNetworkCatalog(stocks);
  it('validates the complete official catalog: 194 active Stock Tokens, not limited to five', () => {
    expect(stocks.assets).toHaveLength(194);
    expect(stocks.assets.length).toBeGreaterThan(ROBINHOOD_FEATURED_STOCKS.length);
    expect(stocks.assets.every(asset => asset.assetClass === 'STOCK_TOKEN' && asset.chain === 'eip155:4663' && asset.decimals === 18)).toBe(true);
    expect(stocks.provenance[0]).toEqual({ provider: 'robinhood.rhj-assets', source: 'https://api.robinhood.com/rhj/assets', fetchedAt: FETCHED,
      contentSha256: contentSha256(OFFICIAL), officialRecords: 194, activeRecords: 194 });
    expect(contentSha256(OFFICIAL)).toBe('f8c058b28cd8697494ff1c40574014492953fc4594b622601dcf66e6fc1944df');
  });
  it('keeps AAPL, TSLA, NVDA, MSFT and AMZN as featured shortcuts only', () => {
    expect(featuredAssets(catalog).map(asset => asset.symbol)).toEqual(['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN']);
    expect(catalog.assets).toHaveLength(197);
    expect(catalog.assets.filter(asset => asset.assetClass === 'STOCK_TOKEN')).toHaveLength(194);
  });
  it('binds each Stock Token to its official uid, contract, decimals and multiplier', () => {
    const tsla = catalogAsset(catalog, { symbol: 'TSLA' })!;
    expect(tsla).toMatchObject({ id: 'eip155:4663/erc20:0x322f0929c4625ed5bad873c95208d54e1c003b2d', address: '0x322f0929c4625ed5bad873c95208d54e1c003b2d',
      decimals: 18, kind: 'ERC20', logoUrl: 'https://cdn.robinhood.com/ncw_assets/logos/0x322f0929c4625ed5bad873c95208d54e1c003b2d.png' });
    expect(tsla.stock).toMatchObject({ officialId: '0x00000000000000000000000000000000cfece3244ea34bb29414dd9488b32d9f', multiplier: '1.000000000000000000',
      multiplierWad: '1000000000000000000', pendingMultiplier: null, pendingEffectiveTime: null, isin: expect.any(String) });
    const aapl = catalogAsset(catalog, { officialId: '0x00000000000000000000000000000000c2425be3658540dd8e2424cbf3c5c649' })!;
    expect(aapl.symbol).toBe('AAPL');
    expect(aapl.stock!.multiplierWad).toBe('1000566080061092436');
    expect(catalogAsset(catalog, { address: '0xAF3D76F1834A1D425780943C99EA8A608F8A93F9' })?.symbol).toBe('AAPL');
    expect(assetDisplayName(aapl)).toBe('Apple');
  });
  it('searches the complete catalog by symbol and company name and resolves non-featured Stock Tokens', () => {
    expect(searchAssets(catalog, 'crwd', { assetClass: 'STOCK_TOKEN' })[0]?.symbol).toBe('CRWD');
    expect(searchAssets(catalog, 'salesforce')[0]?.symbol).toBe('CRM');
    expect(searchAssets(catalog, 'Palantir').map(asset => asset.symbol)).toContain('PLTR');
    const all = searchAssets(catalog, '', { assetClass: 'STOCK_TOKEN', limit: 200 });
    expect(all).toHaveLength(194);
    expect(searchAssets(catalog, 'zzzz-no-such-company')).toEqual([]);
    expect(searchAssets(catalog, 'a', { limit: 7 })).toHaveLength(7);
    const pltr = catalogAsset(catalog, { symbol: 'pltr' })!;
    expect(ROBINHOOD_FEATURED_STOCKS).not.toContain('PLTR');
    expect(workflowAsset(pltr)).toEqual({ chainId: 'eip155:4663', address: pltr.address, decimals: 18 });
  });
  it('normalizes the live per-session trading capabilities and the documented underlier flags', () => {
    expect(catalogAsset(catalog, { symbol: 'TSLA' })!.stock!.trading).toMatchObject({ format: 'SESSIONS', acquirable: true, disposable: true, fractionalRestricted: false });
    expect(catalogAsset(catalog, { symbol: 'WYFI' })!.stock!.trading).toMatchObject({ acquirable: true, fractionalRestricted: true });
    expect(parseTradingCapabilities({ fractionalTradability: 'tradable', allDayTradability: '', extendedHoursFractionalTradability: true }))
      .toMatchObject({ format: 'UNDERLIER_FLAGS', acquirable: true, fractionalRestricted: false });
    expect(parseTradingCapabilities({ fractionalTradability: 'position_closing_only', allDayTradability: null }))
      .toMatchObject({ acquirable: false, disposable: true });
    expect(parseTradingCapabilities(undefined)).toMatchObject({ format: 'ABSENT', acquirable: false });
    expect(() => parseTradingCapabilities({ market: { whole: 'MAYBE' } })).toThrow('STOCK_TRADING_CAPABILITIES_INVALID');
    expect(() => parseTradingCapabilities({ somethingElse: true })).toThrow('STOCK_TRADING_CAPABILITIES_INVALID');
  });
  it('parses decimals and multipliers exactly and converts raw amounts to underlying shares', () => {
    expect(parseMultiplier('1.000566080061092436')).toBe(1000566080061092436n);
    expect(parseMultiplier('4.000000000000000000')).toBe(4n * 10n ** 18n);
    for (const bad of ['1', '1.0', '0.000000000000000000', '-1.000000000000000000', '1e18', 1, null]) expect(() => parseMultiplier(bad)).toThrow('ASSET_MULTIPLIER_INVALID');
    expect(underlyingShares('2000000000000000000', '1000566080061092436')).toBe('2001132160122184872');
    expect(parseAssetAmount('50', 6)).toBe('50000000');
    expect(parseAssetAmount('0.000000000000000001', 18)).toBe('1');
    expect(() => parseAssetAmount('0.0000001', 6)).toThrow('AMOUNT_PRECISION');
    expect(() => parseAssetAmount('1e3', 6)).toThrow('INVALID_AMOUNT');
    expect(formatAssetAmount('1500000', 6)).toBe('1.5');
  });
});

describe('fail-closed registry parsing', () => {
  const tsla = indexOf('TSLA');
  it.each([
    ['not JSON', '{oops', 'STOCK_REGISTRY_MALFORMED'],
    ['no assets array', { data: [] }, 'STOCK_REGISTRY_MALFORMED'],
    ['empty assets', { assets: [] }, 'STOCK_REGISTRY_MALFORMED'],
    ['empty body', '', 'STOCK_REGISTRY_UNAVAILABLE'],
  ])('%s', (_name, value, code) => expect(() => parse(value)).toThrow(code));
  it.each([
    ['uid not 32-byte lowercase hex', { id: '0x1234' }, 'STOCK_REGISTRY_ID_INVALID'],
    ['lowercase symbol', { tokenSymbol: 'tsla' }, 'STOCK_REGISTRY_SYMBOL_INVALID'],
    ['empty name', { tokenName: '' }, 'STOCK_REGISTRY_NAME_INVALID'],
    ['unknown status', { status: 'LISTED' }, 'STOCK_REGISTRY_STATUS_INVALID'],
    ['bad checksum', { deployments: [{ contractAddress: '0x322F0929c4625eD5bAd873c95208D54E1c003b2D', chainId: 4663 }] }, 'STOCK_REGISTRY_DEPLOYMENT_INVALID'],
    ['no Robinhood deployment', { deployments: [{ contractAddress: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', chainId: 1 }] }, 'STOCK_REGISTRY_DEPLOYMENT_AMBIGUOUS'],
    ['two Robinhood deployments', { deployments: [{ contractAddress: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', chainId: 4663 },
      { contractAddress: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', chainId: 4663 }] }, 'STOCK_REGISTRY_DEPLOYMENT_AMBIGUOUS'],
    ['decimals other than 18', { tokenDecimals: 6 }, 'STOCK_REGISTRY_DECIMALS_INVALID'],
    ['malformed multiplier', { currentMultiplier: '1.5' }, 'ASSET_MULTIPLIER_INVALID'],
    ['pending multiplier without time', { pendingMultiplier: '2.000000000000000000' }, 'STOCK_REGISTRY_PENDING_MULTIPLIER_INVALID'],
    ['time without pending multiplier', { pendingMultiplierEffectiveTime: '2026-10-20T13:30:00Z' }, 'STOCK_REGISTRY_PENDING_MULTIPLIER_INVALID'],
    ['bad ISIN', { isin: 'NOT-AN-ISIN' }, 'STOCK_REGISTRY_ISIN_INVALID'],
  ])('refuses a %s', (_name, patch, code) => expect(() => parse(mutate(tsla, patch))).toThrow(code));
  it('records a pending multiplier with its official effective time', () => {
    const pending = parse(mutate(tsla, { pendingMultiplier: '2.000000000000000000', pendingMultiplierEffectiveTime: '2026-10-20T13:30:00Z' }));
    expect(catalogAsset(pending, { symbol: 'TSLA' })!.stock).toMatchObject({ pendingMultiplier: '2.000000000000000000',
      pendingMultiplierWad: '2000000000000000000', pendingEffectiveTime: '2026-10-20T13:30:00.000Z' });
  });
  it('refuses duplicate or ambiguous assets anywhere in the official payload', () => {
    const data = payload(), aapl = data.assets[indexOf('AAPL')]!;
    expect(() => parse(mutate(tsla, { tokenSymbol: 'AAPL' }))).toThrow('STOCK_REGISTRY_DUPLICATE_ASSET');
    expect(() => parse(mutate(tsla, { id: aapl.id }))).toThrow('STOCK_REGISTRY_DUPLICATE_ASSET');
    expect(() => parse(mutate(tsla, { deployments: aapl.deployments }))).toThrow('STOCK_REGISTRY_DUPLICATE_ASSET');
    // An inactive twin still makes the symbol ambiguous.
    expect(() => parse(mutate(tsla, { tokenSymbol: 'AAPL', status: 'ASSET_STATUS_INACTIVE' }))).toThrow('STOCK_REGISTRY_DUPLICATE_ASSET');
    // A Stock Token may never shadow a base asset of the network.
    expect(() => robinhoodNetworkCatalog(parse(mutate(tsla, { tokenSymbol: 'USDG' })))).toThrow('ASSET_CATALOG_DUPLICATE');
  });
  it('excludes inactive assets from the active catalog and drops untrusted logos without failing', () => {
    const result = parse(mutate(tsla, { status: 'ASSET_STATUS_INACTIVE' }));
    expect(result.assets).toHaveLength(193);
    expect(catalogAsset(result, { symbol: 'TSLA' })).toBeNull();
    expect(result.provenance[0]).toMatchObject({ officialRecords: 194, activeRecords: 193 });
    expect(featuredAssets(robinhoodNetworkCatalog(result)).map(asset => asset.symbol)).toEqual(['AAPL', 'NVDA', 'MSFT', 'AMZN']);
    expect(catalogAsset(parse(mutate(tsla, { logoUrl: 'https://evil.example/x.png' })), { symbol: 'TSLA' })!.logoUrl).toBeNull();
  });
  it('ignores unknown extra fields rather than projecting them', () => {
    const result = parse(mutate(tsla, { somethingNew: { nested: true } }));
    expect(JSON.stringify(catalogAsset(result, { symbol: 'TSLA' }))).not.toContain('somethingNew');
  });
});

describe('generic network asset registry', () => {
  const registry = createAssetRegistry([robinhoodNetworkCatalog(parse(OFFICIAL)), BASE_BASE_ASSETS, ARBITRUM_BASE_ASSETS]);
  it('projects Robinhood, Base and Arbitrum through the same canonical model', () => {
    expect(registry.resolve('eip155:4663', { symbol: 'USDG' })).toMatchObject({ assetClass: 'STABLECOIN', decimals: 6,
      address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', id: 'eip155:4663/erc20:0x5fc5360d0400a0fd4f2af552add042d716f1d168' });
    expect(registry.resolve('eip155:4663', { symbol: 'ETH' })).toMatchObject({ kind: 'NATIVE', address: null, id: 'eip155:4663/slip44:60' });
    expect(registry.resolve('eip155:8453', { symbol: 'USDC' })?.address).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(registry.resolve('eip155:42161', { symbol: 'USDC' })?.address).toBe('0xaf88d065e77c8cc2239327c5edb3a432268e5831');
    // A symbol never crosses networks: Base has no TSLA and Robinhood has no USDC.
    expect(registry.resolve('eip155:8453', { symbol: 'TSLA' })).toBeNull();
    expect(registry.resolve('eip155:4663', { symbol: 'USDC' })).toBeNull();
    expect(registry.resolve('eip155:1', { symbol: 'USDC' })).toBeNull();
  });
  it('refuses a second catalog for a network and any cross-network or malformed entry', () => {
    expect(() => createAssetRegistry([BASE_BASE_ASSETS, BASE_BASE_ASSETS])).toThrow('ASSET_REGISTRY_DUPLICATE_NETWORK');
    expect(() => mergeAssetCatalogs([ROBINHOOD_BASE_ASSETS, BASE_BASE_ASSETS])).toThrow('ASSET_CHAIN_MISMATCH');
    const usdg = ROBINHOOD_BASE_ASSETS.assets.find(asset => asset.symbol === 'USDG')!;
    expect(() => createAssetCatalog({ chain: 'eip155:4663', network: 'Robinhood Chain', provenance: [], assets: [usdg, { ...usdg, symbol: 'USDX' }] }))
      .toThrow('ASSET_CATALOG_DUPLICATE');
    expect(() => createAssetCatalog({ chain: 'eip155:4663', network: 'Robinhood Chain', provenance: [], assets: [{ ...usdg, id: 'eip155:4663/erc20:0xdead' }] }))
      .toThrow('ASSET_CATALOG_INVALID');
  });
  it('checks EIP-55 checksums', () => {
    expect(isChecksumAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')).toBe(true);
    expect(isChecksumAddress('0x5fc5360d0400a0fd4f2af552add042d716f1d168')).toBe(false);
    expect(isChecksumAddress('0x5Fc5360D0400a0Fd4f2af552ADD042D716F1d168')).toBe(false);
    // LLY's official address has no uppercase letter in its EIP-55 encoding.
    expect(isChecksumAddress('0x8005d266423c7ea827372c9c864491e5786600ea')).toBe(true);
    expect(toChecksumAddress('0x322f0929c4625ed5bad873c95208d54e1c003b2d')).toBe('0x322F0929c4625eD5bAd873c95208D54E1c003b2d');
  });
});

describe('Robinhood Uniswap v3 pool identity', () => {
  const P = UNISWAP_V3_ROBINHOOD;
  it('derives the canonical pools observed onchain from the factory and init-code hash', () => {
    expect(uniswapV3PoolAddress(P.factory, P.poolInitCodeHash, '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', P.usdg, 3000))
      .toBe('0xf4acdaeeb7022862a763c9b1b885e11191c889e3');
    expect(uniswapV3PoolAddress(P.factory, P.poolInitCodeHash, P.weth, P.usdg, 100)).toBe('0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca');
    expect(uniswapV3PoolAddress(P.factory, P.poolInitCodeHash, P.usdg, P.weth, 100)).toBe('0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca');
    expect(() => uniswapV3PoolAddress(P.factory, P.poolInitCodeHash, P.usdg, P.usdg, 100)).toThrow('POOL_IDENTITY_INVALID');
  });
});
