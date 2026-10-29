// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AAVE_V3_BASE, AAVE_V3_LENDING_PROFILES, BASE_BASE_ASSETS, BASE_FEATURED_ASSETS, BASE_MAINNET, BASE_MAINNET_TRANSFER, BASE_TOKEN_LIST,
  CROSSCHAIN_ROUTER_ARBITRUM_BASE, CROSSCHAIN_ROUTER_BASE_ARBITRUM, ROBINHOOD_BASE_ASSETS, UNISWAP_V3_BASE, UNISWAP_V3_ROBINHOOD_CATALOG, aaveEnvironment, aaveLendingProfile,
  baseAddChainParameters, baseLiquidityPool, catalogAsset, catalogLiquidityPool, catalogPoolOn, contentSha256, createAssetRegistry, executionCapabilityRegistry,
  featuredAssets, isBaseNetworkCatalog, mergeAssetCatalogs, nativeTransferProfile, parseBaseTokenList, robinhoodLiquidityPool, routerProfileFor, searchAssets,
  transferAllowsRecipients, transferAllowsTokens, transferEnvironment, transferL1FeeOracle, uniswapCatalogDeployment, uniswapV3PoolAddress,
  workflowAsset } from '../src/index.js';

/**
 * A FloFi-authored fixture in the token-list format: Base assets whose address, name, symbol and decimals were read directly from chain
 * on 2026-10-11, plus the two entries whose declared decimals differ from their contract (FLUX, WMTX) and one out-of-grammar symbol
 * (1INCH). Four entries (cbBTC, AERO, DEGEN, ZORA) carry the `logoURI` the live list gave them: URL references only, no image bytes. It
 * is not the official list (GPL-3.0, read at runtime only; see the discovery §2.4).
 */
const FIXTURE = readFileSync(new URL('./fixtures/base-token-list-fixture.json', import.meta.url), 'utf8');
const FETCHED = '2026-10-11T03:00:00.000Z';
type Entry = { chainId: number; address: string; name: string; symbol: string; decimals: number; logoURI?: unknown };
const payload = () => JSON.parse(FIXTURE) as { name: string; timestamp: string; version: unknown; tokens: Entry[] };
const parse = (value: unknown) => parseBaseTokenList(typeof value === 'string' ? value : JSON.stringify(value), FETCHED);
const withTokens = (change: (tokens: Entry[]) => unknown[]) => { const data = payload(); return { ...data, tokens: change(data.tokens) }; };
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';

describe('BUILD-BASE-001 Base network identity', () => {
  it('is Base mainnet 8453 (0x2105, eip155:8453), real funds, from the official network table', () => {
    expect(BASE_MAINNET).toMatchObject({ name: 'Base', chain: 'eip155:8453', chainId: 8453, chainHex: '0x2105', environment: 'MAINNET',
      rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', officialSource: 'https://docs.base.org/get-started/connect-to-base' });
    expect(Number.parseInt(BASE_MAINNET.chainHex, 16)).toBe(BASE_MAINNET.chainId);
    expect(baseAddChainParameters()).toEqual({ chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] });
    expect(Object.isFrozen(BASE_MAINNET)).toBe(true);
  });
  it('declares Base mainnet capability rows for every supported action, with no demonstrated evidence', () => {
    const rows = executionCapabilityRegistry.filter(row => row.chainId === 'eip155:8453' && row.environment === 'MAINNET');
    // BUILD-CROSSCHAIN-UNIVERSAL-001: plus the universal router's row (owner wallet, Review, no evidence ceiling).
    expect(rows.map(row => `${row.actionType}/${row.adapterId}`).sort()).toEqual(['asset.bridge/flofi.router', 'asset.bridge/flofi.router.universal', 'asset.liquidity.concentrated/uniswap.v3',
      'asset.swap.exact-input/uniswap.v3', 'asset.swap.exact-input/weth9.wrap', 'asset.transfer/evm.native-transfer', 'asset.transfer/evm.token-transfer', 'borrow/aave-v3', 'repay/aave-v3',
      'supply/aave-v3', 'withdraw/aave-v3'].sort());
    expect(rows.every(row => row.evidenceMaturity === null && row.requirements.includes('INJECTED_WALLET') && row.authorizationModes.join() === 'A')).toBe(true);
    // The historical Base fork and observation rows are unchanged.
    expect(executionCapabilityRegistry.find(row => row.chainId === 'eip155:8453' && row.environment === 'LOCAL_FORK' && row.actionType === 'asset.swap.exact-input')?.evidenceMaturity)
      .toBe('FORK_REPRODUCED');
    expect(executionCapabilityRegistry.find(row => row.chainId === 'eip155:8453' && row.environment === 'MOCK' && row.adapterId === 'uniswap.v3' &&
      row.actionType === 'asset.swap.exact-input')?.capabilities.EXECUTE).toBe(false);
  });
});

describe('BUILD-BASE-001 Base asset catalog (Uniswap Labs Default Token List policy)', () => {
  const catalog = parse(FIXTURE);
  it('merges the code-pinned ETH/USDC/WETH with every policy-conforming Base entry of the source', () => {
    expect(catalog.chain).toBe('eip155:8453');
    expect(isBaseNetworkCatalog(catalog)).toBe(true);
    // 18 Base records: USDC and WETH stay pinned, 1INCH is outside the symbol grammar → 15 listed + 3 pinned.
    expect(catalog.assets).toHaveLength(18);
    expect(catalog.assets.slice(0, 3).map(asset => asset.symbol)).toEqual(['ETH', 'USDC', 'WETH']);
    expect(catalog.assets.slice(0, 3)).toEqual(BASE_BASE_ASSETS.assets);
    // BUILD-BASE-001 (intentional change, owner addendum): a reviewed-prefix `logoURI` is kept as presentation metadata; pinned assets keep none.
    expect(Object.fromEntries(catalog.assets.filter(asset => asset.logoUrl !== null).map(asset => [asset.symbol, asset.logoUrl]))).toEqual({
      cbBTC: 'https://assets.coingecko.com/coins/images/40143/standard/cbbtc.webp', AERO: 'https://basescan.org/token/images/aerodrome_32.png',
      DEGEN: 'https://assets.coingecko.com/coins/images/34515/large/android-chrome-512x512.png?1706198225',
      ZORA: 'https://coin-images.coingecko.com/coins/images/54693/large/zora.jpg?1741094751' });
    expect(catalog.assets.slice(3).every(asset => asset.assetClass === 'TOKEN' && asset.kind === 'ERC20' && asset.stock === null &&
      asset.source.provider === BASE_TOKEN_LIST.provider && asset.source.officialId === null)).toBe(true);
    expect(catalog.provenance.at(-1)).toEqual({ provider: 'uniswap.default-token-list', source: 'https://tokens.uniswap.org', fetchedAt: FETCHED,
      contentSha256: contentSha256(FIXTURE), officialRecords: 18, activeRecords: 17 });
    // Other chains' entries are not Base assets.
    expect(catalog.assets.some(asset => asset.address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(false);
  });
  it('keeps USDC and WETH as featured shortcuts only; search reaches a non-featured asset (cbBTC) by symbol and by name', () => {
    expect(featuredAssets(catalog).map(asset => asset.symbol)).toEqual([...BASE_FEATURED_ASSETS]);
    const cbbtc = catalogAsset(catalog, { symbol: 'cbBTC' })!;
    expect(cbbtc).toMatchObject({ id: `eip155:8453/erc20:${CBBTC}`, address: CBBTC, decimals: 8, name: 'Coinbase Wrapped BTC' });
    expect(BASE_FEATURED_ASSETS).not.toContain('cbBTC');
    // Symbols resolve case-insensitively and only within this network.
    expect(catalogAsset(catalog, { symbol: 'CBBTC' })).toBe(cbbtc);
    expect(catalogAsset(catalog, { symbol: 'cbbtc' })).toBe(cbbtc);
    expect(catalogAsset(catalog, { address: '0xCBB7C0000AB88B473B1F5AFD9EF808440EED33BF' })).toBe(cbbtc);
    expect(searchAssets(catalog, 'cbbtc')[0]).toBe(cbbtc);
    expect(searchAssets(catalog, 'coinbase').map(asset => asset.symbol)).toEqual(['cbBTC', 'cbETH']);
    expect(searchAssets(catalog, 'Aerodrome')[0]?.symbol).toBe('AERO');
    expect(searchAssets(catalog, 'usd').map(asset => asset.symbol)).toEqual(expect.arrayContaining(['USDC', 'USDbC', 'USDT']));
    expect(searchAssets(catalog, 'zzzz-no-such-token')).toEqual([]);
    expect(searchAssets(catalog, '', { limit: 5 })).toHaveLength(5);
    expect(workflowAsset(cbbtc)).toEqual({ chainId: 'eip155:8453', address: CBBTC, decimals: 8 });
  });
  it('excludes, and counts, a symbol outside the FloFi grammar instead of renaming it', () => {
    expect(catalogAsset(catalog, { symbol: '1INCH' })).toBeNull();
    expect(catalogAsset(catalog, { address: '0xc5fecc3a29fb57b5024eec8a2239d4621e111cbe' })).toBeNull();
  });
  it('carries declared decimals as listed (FLUX 18, WMTX 18) — the chain disagrees, so Simulate re-reads decimals() and fails closed', () => {
    expect(catalogAsset(catalog, { symbol: 'FLUX' })?.decimals).toBe(18);
    expect(catalogAsset(catalog, { symbol: 'WMTX' })?.decimals).toBe(18);
  });
  it('is deterministic: the same bytes give the same frozen catalog and identities', () => {
    expect(parse(FIXTURE)).toEqual(catalog);
    expect(Object.isFrozen(catalog.assets[5])).toBe(true);
    expect(new Set(catalog.assets.map(asset => asset.id)).size).toBe(catalog.assets.length);
  });
  it('fails the whole catalog closed on a duplicate address or a case-insensitive duplicate symbol', () => {
    expect(() => parse(withTokens(t => [...t, { ...t[2]!, symbol: 'CBBTC2' }]))).toThrow('BASE_TOKEN_LIST_DUPLICATE_ASSET');
    expect(() => parse(withTokens(t => [...t, { ...t[2]!, address: '0x000000000000000000000000000000000000dEaD', symbol: 'CBBTC' }]))).toThrow('BASE_TOKEN_LIST_DUPLICATE_ASSET');
    // An excluded (out-of-grammar) twin still makes an address ambiguous.
    expect(() => parse(withTokens(t => [...t, { ...t[2]!, symbol: '1CBBTC' }]))).toThrow('BASE_TOKEN_LIST_DUPLICATE_ASSET');
  });
  it('fails closed on a bad checksum, invalid decimals, a malformed name or symbol, or a malformed record', () => {
    expect(() => parse(withTokens(t => [{ ...t[2]!, address: t[2]!.address.toLowerCase() }, ...t.slice(3)]))).toThrow('BASE_TOKEN_LIST_ADDRESS_INVALID');
    expect(() => parse(withTokens(t => [{ ...t[2]!, address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33bF' }]))).toThrow('BASE_TOKEN_LIST_ADDRESS_INVALID');
    for (const decimals of [-1, 37, 6.5, '6'] as unknown[])
      expect(() => parse(withTokens(t => [{ ...t[2]!, decimals }]))).toThrow('BASE_TOKEN_LIST_DECIMALS_INVALID');
    expect(() => parse(withTokens(t => [{ ...t[2]!, name: 'Bad\u0007Name' }]))).toThrow('BASE_TOKEN_LIST_NAME_INVALID');
    expect(() => parse(withTokens(t => [{ ...t[2]!, name: '' }]))).toThrow('BASE_TOKEN_LIST_NAME_INVALID');
    expect(() => parse(withTokens(t => [{ ...t[2]!, symbol: '' }]))).toThrow('BASE_TOKEN_LIST_SYMBOL_INVALID');
    expect(() => parse(withTokens(t => [...t, 'not-an-object']))).toThrow('BASE_TOKEN_LIST_MALFORMED');
    expect(() => parse(withTokens(t => [...t, { ...t[3]!, chainId: '8453' }]))).toThrow('BASE_TOKEN_LIST_MALFORMED');
  });
  it('refuses a payload that is not the expected list, empty, oversized or not JSON', () => {
    expect(() => parse({ ...payload(), name: 'Some Other List' })).toThrow('BASE_TOKEN_LIST_MALFORMED');
    expect(() => parse({ ...payload(), tokens: [] })).toThrow('BASE_TOKEN_LIST_MALFORMED');
    expect(() => parse({ ...payload(), version: { major: 1 } })).toThrow('BASE_TOKEN_LIST_MALFORMED');
    expect(() => parse('{"name":')).toThrow('BASE_TOKEN_LIST_MALFORMED');
    expect(() => parse('x'.repeat(BASE_TOKEN_LIST.maximumBytes + 1))).toThrow('BASE_TOKEN_LIST_UNAVAILABLE');
    expect(() => parseBaseTokenList(FIXTURE, 'not-a-time')).toThrow('BASE_TOKEN_LIST_FETCH_TIME_INVALID');
    // Only other-chain entries (or only pinned and excluded ones): no listed Base asset, so no catalog.
    expect(() => parse(withTokens(t => t.filter(e => e.chainId !== 8453 || ['USDC', 'WETH', '1INCH'].includes(e.symbol))))).toThrow('BASE_TOKEN_LIST_EMPTY');
  });
  it('never lets the list rebind a pinned asset: another identity for USDC, WETH or ETH fails the catalog closed', () => {
    expect(() => parse(withTokens(t => t.map(e => e.symbol === 'USDC' && e.chainId === 8453 ? { ...e, decimals: 18 } : e)))).toThrow('BASE_TOKEN_LIST_PINNED_ASSET_MISMATCH');
    // A listed 'USDC' that is not Circle USDC (the real entry absent), and a case-insensitive twin of the listed USDC.
    expect(() => parse(withTokens(t => t.filter(e => !(e.symbol === 'USDC' && e.chainId === 8453)).map(e => e.symbol === 'USDbC' ? { ...e, symbol: 'USDC' } : e))))
      .toThrow('BASE_TOKEN_LIST_PINNED_ASSET_MISMATCH');
    expect(() => parse(withTokens(t => t.map(e => e.symbol === 'USDbC' ? { ...e, symbol: 'usdc' } : e)))).toThrow('BASE_TOKEN_LIST_DUPLICATE_ASSET');
    expect(() => parse(withTokens(t => [...t, { chainId: 8453, address: '0x000000000000000000000000000000000000dEaD', name: 'Fake Ether', symbol: 'ETH', decimals: 18 }])))
      .toThrow('BASE_TOKEN_LIST_PINNED_ASSET_MISMATCH');
  });
  it('is one network catalog in the cross-network registry; another network\'s catalog is never merged into Base', () => {
    const registry = createAssetRegistry([catalog, ROBINHOOD_BASE_ASSETS]);
    expect(registry.resolve('eip155:8453', { symbol: 'cbBTC' })?.address).toBe(CBBTC);
    expect(registry.resolve('eip155:4663', { symbol: 'cbBTC' })).toBeNull();
    expect(() => mergeAssetCatalogs([catalog, ROBINHOOD_BASE_ASSETS])).toThrow('ASSET_CHAIN_MISMATCH');
    expect(() => createAssetRegistry([catalog, BASE_BASE_ASSETS])).toThrow('ASSET_REGISTRY_DUPLICATE_NETWORK');
    expect(isBaseNetworkCatalog(ROBINHOOD_BASE_ASSETS)).toBe(false);
    expect(isBaseNetworkCatalog(BASE_BASE_ASSETS)).toBe(true);
  });
});

describe('BUILD-BASE-001 Uniswap v3 on Base', () => {
  it('pins the official deployment and derives pools locally from the factory (CREATE2), as verified on chain', () => {
    expect(UNISWAP_V3_BASE).toMatchObject({ chain: 'eip155:8453', factory: '0x33128a8fc17869897dce68ed026d694621f6fdfd', router: '0x2626664c2603336e57b271c5c0b26f421741e481',
      quoter: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a', positionManager: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', weth: BASE_BASE_ASSETS.assets[2]!.address,
      usdc: BASE_BASE_ASSETS.assets[1]!.address, l1DataFee: true, gasPriceOracle: '0x420000000000000000000000000000000000000f' });
    // USDC/WETH 0.05% equals the factory's getPool answer read at discovery (and the BUILD-002 observation pool).
    expect(uniswapV3PoolAddress(UNISWAP_V3_BASE.factory, UNISWAP_V3_BASE.poolInitCodeHash, UNISWAP_V3_BASE.usdc, UNISWAP_V3_BASE.weth, 500))
      .toBe('0xd0b53d9277642d899df5c87a3966a349a798f224');
    expect(uniswapV3PoolAddress(UNISWAP_V3_BASE.factory, UNISWAP_V3_BASE.poolInitCodeHash, UNISWAP_V3_BASE.usdc, UNISWAP_V3_BASE.weth, 3000))
      .toBe('0x6c561b446416e1a00e8e93e221854d6ea4171372');
  });
  it('builds a Base pool in pool order with the tier\'s spacing and the OP Stack L1-fee oracle; unknown tiers and identical tokens fail closed', () => {
    const usdc = { symbol: 'USDC', address: UNISWAP_V3_BASE.usdc, decimals: 6 }, weth = { symbol: 'WETH', address: UNISWAP_V3_BASE.weth, decimals: 18 };
    const pool = baseLiquidityPool(usdc, weth, 500);
    // WETH (0x4200…) sorts below USDC (0x8335…): on Base mainnet WETH is token0.
    expect([pool.token0.symbol, pool.token1.symbol]).toEqual(['WETH', 'USDC']);
    expect(pool).toMatchObject({ chain: 'eip155:8453', pool: '0xd0b53d9277642d899df5c87a3966a349a798f224', feeTier: 500, tickSpacing: 10, gasPriceOracle: UNISWAP_V3_BASE.gasPriceOracle,
      positionManager: UNISWAP_V3_BASE.positionManager, environment: 'MAINNET', codeSha256: { pool: null } });
    expect(baseLiquidityPool(weth, usdc, 500)).toEqual(pool);
    expect(catalogPoolOn('eip155:8453', usdc, weth, 500)).toEqual(pool);
    expect(() => baseLiquidityPool(usdc, weth, 2500)).toThrow('UNISWAP_FEE_TIER_UNSUPPORTED');
    expect(() => baseLiquidityPool(usdc, usdc, 500)).toThrow('UNISWAP_TOKEN_UNSUPPORTED');
    expect(() => catalogPoolOn('eip155:84532', usdc, weth, 500)).toThrow('UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED');
    expect(uniswapCatalogDeployment(8453)?.chain).toBe('eip155:8453');
    expect(uniswapCatalogDeployment('eip155:84532')).toBeNull();
  });
  it('keeps the Robinhood Chain pool builder byte-identical (shared builder, no L1 fee)', () => {
    const usdg = { symbol: 'USDG', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 }, weth = { symbol: 'WETH', address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', decimals: 18 };
    const pool = robinhoodLiquidityPool(usdg, weth, 100);
    expect(JSON.stringify(pool)).toBe(JSON.stringify(catalogLiquidityPool(UNISWAP_V3_ROBINHOOD_CATALOG, usdg, weth, 100)));
    expect(Object.keys(pool)).toEqual(['network', 'chain', 'chainId', 'chainHex', 'protocol', 'adapterId', 'providerLabel', 'rpc', 'explorer', 'officialSource', 'factory',
      'positionManager', 'pool', 'gasPriceOracle', 'token0', 'token1', 'codeSha256', 'feeTier', 'tickSpacing', 'maximumSlippageBps', 'defaultSlippageBps',
      'reviewTtlSeconds', 'mintDeadlineSeconds', 'weth', 'poolInitCodeHash', 'environment']);
    expect(pool).toMatchObject({ pool: '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca', gasPriceOracle: null, explorer: 'https://robinhoodchain.blockscout.com/', maximumSlippageBps: 300,
      defaultSlippageBps: 100, reviewTtlSeconds: 60, mintDeadlineSeconds: 900 });
  });
});

describe('BUILD-BASE-001 Aave, transfer and router profiles on Base', () => {
  it('binds Aave V3 Base to the verified USDC reserve, chosen by chain, as a mainnet profile', () => {
    expect(aaveLendingProfile('eip155:8453')).toBe(AAVE_V3_BASE);
    expect(AAVE_V3_LENDING_PROFILES.filter(profile => profile.chain === 'eip155:8453')).toEqual([AAVE_V3_BASE]);
    expect(AAVE_V3_BASE).toMatchObject({ pool: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5', provider: '0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d', reserveId: 4,
      asset: BASE_BASE_ASSETS.assets[1]!.address, decimals: 6, symbol: 'USDC', aToken: '0x4e65fe4dba92790696d040ac24aa414708f5c0ab',
      variableDebtToken: '0x59dca05b6c26dbd64b5381374aaac5cd05644c28', oracle: '0x2cc0fc26ed4563a5ce5e8bdcfe1a2878676ae156', l1DataFee: true, faucet: null });
    expect(aaveEnvironment(AAVE_V3_BASE)).toBe('MAINNET');
    expect(aaveEnvironment(AAVE_V3_LENDING_PROFILES[0]!)).toBe('PUBLIC_TESTNET');
  });
  it('transfers on Base mainnet: native and catalog tokens, explicit recipients, the OP Stack L1-fee oracle', () => {
    expect(nativeTransferProfile('eip155:8453')).toBe(BASE_MAINNET_TRANSFER);
    expect(transferAllowsRecipients(BASE_MAINNET_TRANSFER) && transferAllowsTokens(BASE_MAINNET_TRANSFER)).toBe(true);
    expect(transferEnvironment(BASE_MAINNET_TRANSFER)).toBe('MAINNET');
    expect(transferL1FeeOracle(BASE_MAINNET_TRANSFER)).toBe('0x420000000000000000000000000000000000000f');
    // Every other transfer profile has no separate L1 fee (testnets, Robinhood Chain): their Reviews are unchanged.
    for (const chain of ['eip155:46630', 'eip155:11155111', 'eip155:4663']) expect(transferL1FeeOracle(nativeTransferProfile(chain))).toBeNull();
  });
  it('routes Arbitrum USDC → Base USDC on the existing router with the verified Arbitrum and Base pins', () => {
    const route = routerProfileFor('eip155:42161', 'eip155:8453')!;
    expect(route).toBe(CROSSCHAIN_ROUTER_ARBITRUM_BASE);
    expect(route).toMatchObject({ id: 'arbitrum-usdc-to-base-usdc', adapterId: 'flofi.router', underlyingProtocol: 'across', environment: 'MAINNET',
      source: { chainId: 42161, token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', spokePool: '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a',
        lifiDiamond: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', l1DataFee: false },
      destination: { chainId: 8453, token: BASE_BASE_ASSETS.assets[1]!.address, symbol: 'USDC', spokePool: CROSSCHAIN_ROUTER_BASE_ARBITRUM.source.spokePool } });
    // The reverse of Base → Arbitrum: the same pins on swapped sides.
    expect(route.codeSha256).toEqual({ baseSpokePool: CROSSCHAIN_ROUTER_BASE_ARBITRUM.codeSha256.arbitrumSpokePool, baseLifiDiamond: '72211202d3d54f9e8b4590855d8f8390f1fad2d55c2472a3e488b58ccb61c2e9',
      baseLifiFeeForwarder: CROSSCHAIN_ROUTER_BASE_ARBITRUM.codeSha256.baseLifiFeeForwarder, baseUsdc: CROSSCHAIN_ROUTER_BASE_ARBITRUM.codeSha256.arbitrumUsdc,
      arbitrumSpokePool: CROSSCHAIN_ROUTER_BASE_ARBITRUM.codeSha256.baseSpokePool, arbitrumUsdc: CROSSCHAIN_ROUTER_BASE_ARBITRUM.codeSha256.baseUsdc });
    // The existing Base → Arbitrum pair is unchanged.
    expect(routerProfileFor('eip155:8453', 'eip155:42161')).toBe(CROSSCHAIN_ROUTER_BASE_ARBITRUM);
  });
});
