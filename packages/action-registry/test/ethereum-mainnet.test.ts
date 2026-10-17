// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ETHEREUM_BASE_ASSETS, ETHEREUM_MAINNET, ETHEREUM_SEPOLIA, BASE_BASE_ASSETS, catalogAsset, createAssetRegistry,
  parseEthereumTokenList, searchAssets, toChecksumAddress, trustedAssetLogo, workflowAsset } from '../src/index.js';

// FloFi-authored public contract facts and synthetic conflicts; no upstream list bytes.
const token = (symbol = 'LINK', address = '0x514910771af9ca656af840dff83e8264ecf986ca', decimals = 18) =>
  ({ chainId: 1, symbol, name: symbol === 'LINK' ? 'Chainlink' : symbol, address: toChecksumAddress(address), decimals,
    logoURI: 'https://assets.coingecko.com/coins/images/877/link.png' });
const list = (tokens: unknown[]) => JSON.stringify({ name: 'Uniswap Labs Default', timestamp: '2026-10-17T00:00:00.000Z', version: { major: 1, minor: 0, patch: 0 }, tokens });
const parse = (tokens: unknown[]) => parseEthereumTokenList(list(tokens), '2026-10-17T00:00:00.000Z');

describe('Ethereum mainnet identity and validated catalog', () => {
  it('keeps Mainnet, Sepolia, ETH native and WETH distinct', () => {
    expect(ETHEREUM_MAINNET).toMatchObject({ chain: 'eip155:1', chainId: 1, chainHex: '0x1', environment: 'MAINNET', funds: 'REAL_FUNDS' });
    expect(ETHEREUM_MAINNET.chain).not.toBe(ETHEREUM_SEPOLIA.chain);
    const eth = catalogAsset(ETHEREUM_BASE_ASSETS, { symbol: 'ETH' })!, weth = catalogAsset(ETHEREUM_BASE_ASSETS, { symbol: 'WETH' })!;
    expect(workflowAsset(eth)).toEqual({ chainId: 'eip155:1', nativeId: 'ETH', decimals: 18 });
    expect(weth).toMatchObject({ kind: 'ERC20', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18 });
  });
  it('discovers non-featured assets and numeric-leading symbols by symbol, name, address and full chain identity', () => {
    const catalog = parse([token(), token('1INCH', '0x111111111117dc0aa78b770fa6a738034120c302')]);
    const link = catalogAsset(catalog, { symbol: 'LINK' })!;
    for (const query of ['link', 'Chainlink', link.address!, link.id]) expect(searchAssets(catalog, query)).toContainEqual(link);
    expect(catalogAsset(catalog, { symbol: '1INCH' })).not.toBeNull();
    expect(searchAssets(catalog, 'eip155:8453/erc20:' + link.address)).toEqual([]);
    const registry = createAssetRegistry([catalog, BASE_BASE_ASSETS]);
    expect(registry.resolve('eip155:8453', { address: link.address! })).toBeNull();
    expect(registry.resolve('eip155:1', { symbol: 'USDC' })?.address).not.toBe(registry.resolve('eip155:8453', { symbol: 'USDC' })?.address);
    expect(trustedAssetLogo(link)).toBe(link.logoUrl);
    expect(trustedAssetLogo({ ...link, chain: 'eip155:11155111' })).toBeNull();
  });
  it('excludes both reviewed LIT ambiguities while other duplicate identities fail closed', () => {
    const catalog = parse([token(), token('LIT', '0xb59490ab09a0f526cc7305822ac65f2ab12f9723'), token('LIT', '0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2')]);
    expect(catalogAsset(catalog, { symbol: 'LIT' })).toBeNull();
    expect(catalogAsset(catalog, { symbol: 'LINK' })).not.toBeNull();
    expect(() => parse([token(), token('LINK2')])).toThrow('ETHEREUM_TOKEN_LIST_DUPLICATE_ASSET');
    expect(() => parse([token(), token('link', '0x0000000000000000000000000000000000000002')])).toThrow('ETHEREUM_TOKEN_LIST_DUPLICATE_ASSET');
  });
  it('rejects pinned identity conflicts, malformed decimals and testnet substitutions', () => {
    expect(() => parse([token('USDC')])).toThrow('ETHEREUM_TOKEN_LIST_PINNED_ASSET_MISMATCH');
    expect(() => parse([token('LINK', undefined, 37)])).toThrow('ETHEREUM_TOKEN_LIST_DECIMALS_INVALID');
    expect(() => parse([{ ...token(), chainId: 11155111 }])).toThrow('ETHEREUM_TOKEN_LIST_EMPTY');
  });
});
