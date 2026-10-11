// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARBITRUM_BASE_ASSETS, ARBITRUM_ONE, ARBITRUM_TOKEN_LIST, ARBITRUM_TOKEN_LIST_LOGOS, BASE_BASE_ASSETS, ROBINHOOD_BASE_ASSETS,
  TOKEN_LIST_NETWORKS, arbitrumTokenListProvider, catalogAsset, contentSha256, createAssetCatalog, createAssetRegistry, discoverNetworkCapabilities,
  executionCapabilityRegistry, isArbitrumNetworkCatalog, parseArbitrumTokenList, routerProfileFor, tokenListNetwork, trustedAssetLogo, workflowAsset } from '../src/index.js';

/** FloFi-authored fixture: independently selected public contract facts, two exclusion cases and synthetic foreign-chain input. Not upstream list bytes. */
const fixture = readFileSync(new URL('./fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8');
const fetched = '2026-10-11T21:36:16.041Z';
const payload = () => JSON.parse(fixture) as { tokens: Record<string, unknown>[] };
const parse = (input: unknown) => parseArbitrumTokenList(typeof input === 'string' ? input : JSON.stringify(input), fetched);
const mutate = (fn: (records: Record<string, unknown>[]) => Record<string, unknown>[]) => ({ ...payload(), tokens: fn(payload().tokens) });
const catalog = parse(fixture);

describe('BUILD-ARB-001 canonical Arbitrum One profile', () => {
  it('binds MAINNET / REAL_FUNDS, ETH and the existing Router identity to one canonical record', () => {
    expect(ARBITRUM_ONE).toEqual({ name: 'Arbitrum One', chain: 'eip155:42161', chainId: 42161, chainHex: '0xa4b1', environment: 'MAINNET', funds: 'REAL_FUNDS',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io/', officialSource: 'https://docs.arbitrum.io/chain-info' });
    expect(Number(ARBITRUM_ONE.chain.split(':')[1])).toBe(ARBITRUM_ONE.chainId);
    expect(Number.parseInt(ARBITRUM_ONE.chainHex, 16)).toBe(ARBITRUM_ONE.chainId);
    expect(routerProfileFor('eip155:8453', ARBITRUM_ONE.chain)?.destination).toMatchObject({ network: ARBITRUM_ONE.name, chain: ARBITRUM_ONE.chain,
      chainId: ARBITRUM_ONE.chainId, chainHex: ARBITRUM_ONE.chainHex, rpc: ARBITRUM_ONE.rpc, explorer: ARBITRUM_ONE.explorer });
    expect(Object.isFrozen(ARBITRUM_ONE.nativeCurrency)).toBe(true);
  });
  it('registers exactly one chain-bound provider alongside Base, without a testnet catalog', () => {
    expect(arbitrumTokenListProvider).toMatchObject({ chain: ARBITRUM_ONE.chain, id: ARBITRUM_TOKEN_LIST.provider, source: 'https://tokens.uniswap.org' });
    expect(new Set(TOKEN_LIST_NETWORKS.map(profile => profile.pinned.chain)).size).toBe(TOKEN_LIST_NETWORKS.length);
    expect(TOKEN_LIST_NETWORKS.filter(profile => profile.pinned.chain === ARBITRUM_ONE.chain)).toHaveLength(1);
    expect(tokenListNetwork('eip155:8453')).not.toBeNull();
    expect(tokenListNetwork('eip155:84532')).toBeNull();
    expect(tokenListNetwork('eip155:421614')).toBeNull();
  });
});

describe('BUILD-ARB-001 shared curated catalog policy', () => {
  it('merges existing pins with valid target-chain entries and records provenance, exclusions and native ETH conventions', () => {
    expect(catalog.assets).toHaveLength(8);
    expect(catalog.assets.slice(0, 3)).toEqual(ARBITRUM_BASE_ASSETS.assets);
    expect(isArbitrumNetworkCatalog(catalog)).toBe(true);
    expect(catalog.provenance.at(-1)).toMatchObject({ provider: ARBITRUM_TOKEN_LIST.provider, source: ARBITRUM_TOKEN_LIST.url,
      contentSha256: contentSha256(fixture), officialRecords: 9, activeRecords: 7 });
    expect(catalogAsset(catalog, { symbol: 'FLUX' })).toBeNull();
    expect(catalogAsset(catalog, { symbol: '1INCH' })).toBeNull();
    expect(catalogAsset(catalog, { symbol: 'ETH' })?.id).toBe('eip155:42161/slip44:60');
    expect(workflowAsset(catalogAsset(catalog, { symbol: 'ETH' })!)).toEqual({ chainId: ARBITRUM_ONE.chain, nativeId: 'ETH', decimals: 18 });
    expect(catalogAsset(catalog, { symbol: 'USDC' })?.address).not.toBe(catalogAsset(catalog, { symbol: 'USDC.e' })?.address);
  });
  it('binds address identity and resolution to the requested chain even when symbols repeat', () => {
    const registry = createAssetRegistry([catalog, BASE_BASE_ASSETS, ROBINHOOD_BASE_ASSETS]);
    for (const chain of [ARBITRUM_ONE.chain, 'eip155:8453', 'eip155:4663']) {
      const weth = registry.resolve(chain, { symbol: 'weth' })!;
      expect(weth.chain).toBe(chain);
      expect(weth.id).toBe(`${chain}/erc20:${weth.address}`);
    }
    expect(new Set(registry.catalogs.map(c => registry.resolve(c.chain, { symbol: 'WETH' })!.address)).size).toBe(3);
    for (const symbol of ['cbBTC', 'FOREIGN', 'USDG', 'TSLA']) expect(registry.resolve(ARBITRUM_ONE.chain, { symbol })).toBeNull();
    expect(registry.resolve(ARBITRUM_ONE.chain, { address: BASE_BASE_ASSETS.assets[1]!.address! })).toBeNull();
    expect(() => createAssetRegistry([catalog, ARBITRUM_BASE_ASSETS])).toThrow('ASSET_REGISTRY_DUPLICATE_NETWORK');
  });
  it('fails closed on invalid or mismatched chain identity and decimals', () => {
    for (const chainId of ['42161', 42161.5, null]) expect(() => parse(mutate(t => [{ ...t[2], chainId }]))).toThrow('ARBITRUM_TOKEN_LIST_MALFORMED');
    expect(() => parse(mutate(t => [{ ...t[2], chainId: 421614 }]))).toThrow('ARBITRUM_TOKEN_LIST_EMPTY');
    for (const decimals of [-1, 37, 8.5, '18', null]) expect(() => parse(mutate(t => [{ ...t[2], decimals }]))).toThrow('ARBITRUM_TOKEN_LIST_DECIMALS_INVALID');
    for (const change of [{ chain: 'eip155:8453' }, { chainId: 8453 }]) expect(() => createAssetCatalog({ ...catalog,
      assets: catalog.assets.map((a, i) => i === 3 ? { ...a, ...change } : a) })).toThrow('ASSET_CHAIN_MISMATCH');
    expect(() => parse(mutate(t => [{ ...t[2], address: String(t[2]!.address).toLowerCase() }]))).toThrow('ARBITRUM_TOKEN_LIST_ADDRESS_INVALID');
  });
  it('fails the entire projection on duplicate or ambiguous assets, including excluded twins and pinned identity collisions', () => {
    expect(() => parse(mutate(t => [...t, { ...t[2], symbol: 'ARB2' }]))).toThrow('ARBITRUM_TOKEN_LIST_DUPLICATE_ASSET');
    expect(() => parse(mutate(t => [...t, { ...t[2], address: '0x0000000000000000000000000000000000000002', symbol: 'arb' }]))).toThrow('ARBITRUM_TOKEN_LIST_DUPLICATE_ASSET');
    expect(() => parse(mutate(t => [...t, { ...t[7], symbol: 'FLUX2' }]))).toThrow('ARBITRUM_TOKEN_LIST_DUPLICATE_ASSET');
    expect(() => parse(mutate(t => [...t.slice(2), { ...t[0], decimals: 18 }]))).toThrow('ARBITRUM_TOKEN_LIST_PINNED_ASSET_MISMATCH');
    expect(() => parse(mutate(t => [{ ...t[2], symbol: 'USDC' }]))).toThrow('ARBITRUM_TOKEN_LIST_PINNED_ASSET_MISMATCH');
  });
  it('accepts only the configured curated source shape and never substitutes a recorded list', () => {
    expect(() => parse({ ...payload(), name: 'Untrusted list' })).toThrow('ARBITRUM_TOKEN_LIST_MALFORMED');
    expect(() => parse('unavailable')).toThrow('ARBITRUM_TOKEN_LIST_MALFORMED');
    expect(() => parseArbitrumTokenList(fixture, 'invalid')).toThrow('ARBITRUM_TOKEN_LIST_FETCH_TIME_INVALID');
  });
  it('uses existing generic logo validation and drops unsupported/malformed URLs without changing asset identity', () => {
    const wbtc = catalogAsset(catalog, { symbol: 'WBTC' })!;
    expect(trustedAssetLogo(wbtc)).toBe(wbtc.logoUrl);
    expect(wbtc.logoUrl).toMatch(/^https:\/\/raw\.githubusercontent\.com\/trustwallet\/assets\//);
    expect(ARBITRUM_TOKEN_LIST_LOGOS.chain).toBe(ARBITRUM_ONE.chain);
    expect(catalogAsset(catalog, { symbol: 'ARB' })?.logoUrl).toBeNull();
    for (const logoURI of ['https://evil.example/logo.png', 'data:image/svg+xml,bad', 'https://assets.coingecko.com/coins/images/%2e%2e/logo.png',
      'https://assets.coingecko.com/coins/images/1/logo.png?redirect=evil', 'https://assets.coingecko.com/coins/images/1/logo.png#fragment']) {
      const parsed = parse(mutate(t => t.map(r => r.symbol === 'WBTC' ? { ...r, logoURI } : r)));
      expect(catalogAsset(parsed, { symbol: 'WBTC' })?.logoUrl).toBeNull();
      expect(workflowAsset(catalogAsset(parsed, { symbol: 'WBTC' })!)).toEqual(workflowAsset(wbtc));
    }
    expect(trustedAssetLogo({ ...wbtc, chain: 'eip155:4663' })).toBeNull();
    expect(trustedAssetLogo({ ...wbtc, source: { ...wbtc.source, provider: 'spam.endpoint' } })).toBeNull();
  });
});

describe('BUILD-ARB-001 capability discovery is not execution authority', () => {
  it('discovers all ten verified protocol capabilities by chain with runtime availability distinct from discovery evidence', () => {
    const rows = discoverNetworkCapabilities(ARBITRUM_ONE.chain);
    expect(rows.map(row => row.capability)).toEqual(['SWAP', 'TRANSFER_NATIVE', 'TRANSFER_ERC20', 'BRIDGE_IN', 'BRIDGE_OUT', 'LIQUIDITY', 'SUPPLY', 'BORROW', 'REPAY', 'WITHDRAW']);
    expect(rows.every(row => row.status === 'SUPPORTED' && row.evidence === 'PUBLIC_READ_ONLY')).toBe(true);
    expect(rows.filter(row => row.runtime === 'EXISTING').map(row => row.capability)).toEqual(['SWAP', 'TRANSFER_NATIVE', 'TRANSFER_ERC20', 'BRIDGE_IN', 'BRIDGE_OUT', 'LIQUIDITY']);
    expect(executionCapabilityRegistry.filter(row => row.chainId === ARBITRUM_ONE.chain && row.environment === 'MAINNET')
      .map(row => `${row.actionType}/${row.adapterId}`)).toEqual(['asset.bridge/flofi.router', 'asset.swap.exact-input/uniswap.v3', 'asset.transfer/evm.native-transfer', 'asset.transfer/evm.token-transfer', 'asset.liquidity.concentrated/uniswap.v3']);
    expect(discoverNetworkCapabilities('eip155:421614')).toEqual([]);
    expect(discoverNetworkCapabilities('arbitrum')).toEqual([]);
  });
});
