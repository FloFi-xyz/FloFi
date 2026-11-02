// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { AssetCatalog, CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { base58Decode, base58Encode, type SolanaRpc } from '@defi-workflow-engine/reference-compiler';
import type { PriceSource } from '../automations/price-source.ts';
import type { SolanaAssetCatalog } from '../domain/solana-asset-catalog.ts';
import type { PortfolioNetworkId } from '../domain/wallet-portfolio.ts';
import type { Rpc } from './public-testnet-service.ts';
import { CATALOG_NETWORKS, type CatalogNetworkId } from './catalog-networks.ts';
import { decodeAggregate3, encodeAggregate3, MULTICALL3, PORTFOLIO_CHUNK, PORTFOLIO_MAX_TOKENS, portfolioAccounts, readWalletPortfolio, type PortfolioCache,
  type PortfolioMode, type WalletPortfolioSeams } from './wallet-portfolio.ts';

// Everything here is a closed, in-process fake: no test reaches a public RPC, token list or price feed.
const OWNER = '0x' + 'ab'.repeat(20), NOW = new Date('2026-11-02T12:00:00.000Z');
const SOL_OWNER = base58Encode(new Uint8Array(32).fill(7)), USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112', UNLISTED_MINT = base58Encode(new Uint8Array(32).fill(9));
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const address = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const WETH = address(0xe1), USDC = address(0xc1), DAI = address(0xd1), FAKE_WETH = address(0xf1);

function asset(network: CatalogNetworkId, symbol: string, token: string | null, decimals: number, assetClass: CanonicalAsset['assetClass'] = 'TOKEN'): CanonicalAsset {
  const { chain, chainId, name } = CATALOG_NETWORKS[network];
  return { id: token ? `${chain}/erc20:${token}` : `${chain}/slip44:60`, chain, chainId, network: name, kind: token ? 'ERC20' : 'NATIVE',
    assetClass: token ? assetClass : 'NATIVE', symbol, name: `${symbol} token`, address: token, decimals, logoUrl: null,
    source: { provider: 'test', url: 'test', officialId: null }, stock: null };
}
function catalog(network: CatalogNetworkId, tokens: readonly CanonicalAsset[]): AssetCatalog {
  const { chain, chainId, name } = CATALOG_NETWORKS[network];
  return { format: 'flofi.asset-catalog.v1', chain, chainId, network: name, assets: [asset(network, 'ETH', null, 18), ...tokens], featured: [], provenance: [] };
}
const defaultTokens = (network: CatalogNetworkId) => [asset(network, 'WETH', WETH, 18, 'WRAPPED_NATIVE'), asset(network, 'USDC', USDC, 6, 'STABLECOIN'),
  asset(network, 'DAI', DAI, 18, 'STABLECOIN')];

/** An independent ABI reader of the request (so the module's encoder is checked, not reused). */
function readAggregate3Request(data: string): { target: string; callData: string }[] {
  expect(data.slice(0, 10)).toBe('0x82ad56cb');
  const body = data.slice(10), at = (byte: number) => Number(BigInt('0x' + body.slice(byte * 2, byte * 2 + 64)));
  const array = at(0), count = at(array), base = array + 32;
  return Array.from({ length: count }, (_, i) => {
    const tuple = base + at(base + i * 32), bytes = tuple + at(tuple + 64), length = at(bytes);
    expect(at(tuple + 32)).toBe(1); // allowFailure
    return { target: '0x' + body.slice(tuple * 2 + 24, tuple * 2 + 64), callData: '0x' + body.slice((bytes + 32) * 2, (bytes + 32) * 2 + length * 2) };
  });
}
const word = (value: bigint) => value.toString(16).padStart(64, '0');
function aggregate3Response(results: readonly ({ ok: boolean; data: string })[]): string {
  const tuples = results.map(r => { const bytes = r.data.slice(2); return word(r.ok ? 1n : 0n) + word(0x40n) + word(BigInt(bytes.length / 2)) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0'); });
  let offset = tuples.length * 32;
  const offsets = tuples.map(t => { const o = offset; offset += t.length / 2; return word(BigInt(o)); });
  return '0x' + word(0x20n) + word(BigInt(results.length)) + offsets.join('') + tuples.join('');
}

type EvmChain = { chainId: number; native: bigint; balances: Record<string, bigint | 'revert'>; multicall?: boolean; failOn?: string; never?: boolean };
function evmRpc(chain: EvmChain, log: { method: string; params: readonly unknown[] }[] = []): Rpc {
  return async (method, params) => {
    log.push({ method, params });
    if (chain.never) return new Promise(() => undefined);
    if (method === chain.failOn) throw new Error('PUBLIC_RPC_UNAVAILABLE');
    if (method === 'eth_chainId') return '0x' + chain.chainId.toString(16);
    if (method === 'eth_blockNumber') return '0x1234';
    if (method === 'eth_getCode') { expect(params).toEqual([MULTICALL3, '0x1234']); return chain.multicall === false ? '0x' : '0x6080604052'; }
    if (method === 'eth_getBalance') { expect(params).toEqual([OWNER, '0x1234']); return '0x' + chain.native.toString(16); }
    if (method === 'eth_call') {
      const [call, block] = params as [{ to: string; data: string }, string];
      expect(call.to).toBe(MULTICALL3); expect(block).toBe('0x1234');
      return aggregate3Response(readAggregate3Request(call.data).map(({ target, callData }) => {
        if (callData === '0x4d2301cc' + OWNER.slice(2).padStart(64, '0')) { expect(target).toBe(MULTICALL3); return { ok: true, data: '0x' + word(chain.native) }; }
        expect(callData).toBe('0x70a08231' + OWNER.slice(2).padStart(64, '0'));
        const balance = chain.balances[target];
        return balance === 'revert' ? { ok: false, data: '0x' } : { ok: true, data: '0x' + word(balance ?? 0n) };
      }));
    }
    throw new Error('PUBLIC_RPC_METHOD_DENIED');
  };
}
function prices(values: Partial<Record<'ETH' | 'SOL' | 'BTC', string>>, id: 'fixture' | 'chainlink' = 'fixture'): PriceSource & { observed: string[] } {
  const observed: string[] = [];
  return { id, maxAgeMs: 60_000, assets: ['ETH', 'BTC', 'SOL'], observed, observe: async asset => {
    observed.push(asset);
    const priceUsd = values[asset];
    return priceUsd ? { ok: true, observation: { asset, priceUsd, observedAt: '2026-11-02T11:59:00.000Z', receivedAt: NOW.toISOString(),
      source: id === 'fixture' ? 'FIXTURE' : 'CHAINLINK', evidence: id === 'fixture' ? 'MOCKED' : 'PUBLIC_READ_ONLY', provenance: {} } } : { ok: false, code: 'PRICE_STALE' };
  } };
}
function seams(options: { modes?: Partial<Record<PortfolioNetworkId, PortfolioMode>>; chains?: Partial<Record<CatalogNetworkId, EvmChain>>;
  catalogs?: Partial<Record<CatalogNetworkId, AssetCatalog | Error>>; solana?: SolanaRpc; solanaCatalog?: SolanaAssetCatalog | Error;
  prices?: PriceSource | null; log?: { method: string; params: readonly unknown[] }[]; budgetMs?: number; cache?: PortfolioCache; gates?: boolean }): WalletPortfolioSeams {
  return { ...options.gates ? {} : { mode: async (id: PortfolioNetworkId) => options.modes?.[id] ?? 'off' }, now: () => NOW, prices: options.prices ?? null, budgetMs: options.budgetMs ?? 5_000, cache: options.cache ?? null,
    evmRpc: id => evmRpc(options.chains?.[id] ?? { chainId: CATALOG_NETWORKS[id].chainId, native: 0n, balances: {} }, options.log),
    evmCatalog: async id => { const value = options.catalogs?.[id] ?? catalog(id, defaultTokens(id)); if (value instanceof Error) throw value; return value; },
    solanaRpc: () => options.solana ?? (async () => { throw new Error('SOLANA_RPC_UNAVAILABLE'); }),
    solanaCatalog: async () => { const value = options.solanaCatalog ?? solanaCatalog(); if (value instanceof Error) throw value; return value; } };
}
const base = (balances: EvmChain['balances'], native = 0n, extra: Partial<EvmChain> = {}): EvmChain => ({ chainId: 8453, native, balances, ...extra });

describe('wallet portfolio: EVM reads through one Multicall3 aggregate', () => {
  it('reads native and listed balances at one block, omits zero balances and values only ETH/WETH at the verified price', async () => {
    const log: { method: string; params: readonly unknown[] }[] = [];
    const portfolio = await readWalletPortfolio({ evm: OWNER.toUpperCase().replace('0X', '0x'), solana: null }, {}, seams({ modes: { base: 'live' }, log,
      chains: { base: base({ [WETH]: 5n * 10n ** 17n, [USDC]: 100_000_000n, [DAI]: 0n }, 15n * 10n ** 17n) }, prices: prices({ ETH: '3000.5' }, 'chainlink') }));
    expect(portfolio.accounts).toEqual([{ ecosystem: 'evm', address: OWNER }]);
    expect(log.map(entry => entry.method)).toEqual(['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call']);
    const baseNetwork = portfolio.networks.find(network => network.id === 'base')!;
    expect(baseNetwork).toMatchObject({ status: 'READ', provenance: 'PUBLIC_MAINNET', block: '4660', tokens: 'ALL', uncheckedTokens: 0, code: null, chainId: 8453 });
    expect(portfolio.networks.filter(network => network.id !== 'base').map(network => [network.id, network.status]))
      .toEqual([['ethereum', 'NOT_ENABLED'], ['arbitrum-one', 'NOT_ENABLED'], ['robinhood', 'NOT_ENABLED']]);
    expect(portfolio.holdings.map(h => [h.symbol, h.units, h.valueUsd])).toEqual([['ETH', '1500000000000000000', '4500.75'],
      ['WETH', '500000000000000000', '1500.25'], ['USDC', '100000000', null]]);
    expect(portfolio.holdings.find(h => h.symbol === 'USDC')!.price).toBeNull();
    expect(portfolio.holdings[0]!.price).toEqual({ usd: '3000.5', source: 'CHAINLINK', observedAt: '2026-11-02T11:59:00.000Z' });
    expect(portfolio).toMatchObject({ pricedTotalUsd: '6001.00', unpricedCount: 1, unlisted: 0, priceSource: 'CHAINLINK', mocked: false });
    expect(log.every(entry => ['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call', 'eth_getBalance'].includes(entry.method))).toBe(true);
  });
  it('shows a Stock Token in underlying shares (its official ERC-8056 multiplier), never priced', async () => {
    const STOCK = address(0xa1);
    const stock = { ...asset('base', 'AAPL', STOCK, 18), stock: { multiplierWad: '2000000000000000000' } as unknown as CanonicalAsset['stock'] };
    const portfolio = await readWalletPortfolio({ evm: OWNER, solana: null }, {}, seams({ modes: { base: 'live' }, catalogs: { base: catalog('base', [stock]) },
      chains: { base: base({ [STOCK]: 3n * 10n ** 18n }) }, prices: prices({ ETH: '3000' }) }));
    expect(portfolio.holdings.map(h => [h.symbol, h.units, h.price])).toEqual([['AAPL', '6000000000000000000', null]]);
  });
  it('never prices a stablecoin, or a token that only shares the WETH symbol, and shows no total without a price source', async () => {
    const tokens = [asset('base', 'USDC', USDC, 6, 'STABLECOIN'), asset('base', 'WETH', FAKE_WETH, 18, 'TOKEN')];
    const priced = await readWalletPortfolio({ evm: OWNER, solana: null }, {}, seams({ modes: { base: 'live' }, catalogs: { base: catalog('base', tokens) },
      chains: { base: base({ [USDC]: 5_000_000n, [FAKE_WETH]: 10n ** 18n }) }, prices: prices({ ETH: '3000' }) }));
    expect(priced.holdings.map(h => [h.symbol, h.valueUsd, h.price])).toEqual([['USDC', null, null], ['WETH', null, null]]);
    expect(priced).toMatchObject({ pricedTotalUsd: null, unpricedCount: 2, priceSource: 'FIXTURE', mocked: false });
    const none = await readWalletPortfolio({ evm: OWNER, solana: null }, {}, seams({ modes: { base: 'live' }, chains: { base: base({ [WETH]: 10n ** 18n }, 10n ** 18n) } }));
    expect(none).toMatchObject({ pricedTotalUsd: null, priceSource: null, unpricedCount: 2, mocked: false });
    expect(none.holdings.every(h => h.price === null && h.valueUsd === null)).toBe(true);
  });
  it('labels a fixture price and a loopback harness balance as MOCKED test data', async () => {
    const fixture = await readWalletPortfolio({ evm: OWNER, solana: null }, {}, seams({ modes: { base: 'live' }, chains: { base: base({}, 10n ** 18n) }, prices: prices({ ETH: '2000' }) }));
    expect(fixture).toMatchObject({ priceSource: 'FIXTURE', mocked: true, pricedTotalUsd: '2000.00' });
    expect(fixture.holdings[0]!.price!.source).toBe('FIXTURE');
    const harness = await readWalletPortfolio({ evm: OWNER, solana: null }, {}, seams({ modes: { base: 'harness' }, chains: { base: base({}, 10n ** 18n) } }));
    expect(harness.networks.find(n => n.id === 'base')!.provenance).toBe('MOCKED');
    expect(harness.holdings[0]!.provenance).toBe('MOCKED');
    expect(harness.mocked).toBe(true);
  });
  it('isolates each network: one failure is UNAVAILABLE, the others are still read', async () => {
    const portfolio = await readWalletPortfolio({ evm: OWNER, solana: null }, {}, seams({ modes: { base: 'live', 'arbitrum-one': 'live', ethereum: 'live' },
      chains: { base: base({}, 1n, { failOn: 'eth_blockNumber' }), 'arbitrum-one': { chainId: 42161, native: 2n * 10n ** 18n, balances: {} },
        ethereum: { chainId: 8453, native: 1n, balances: {} } } }));
    const status = Object.fromEntries(portfolio.networks.map(n => [n.id, [n.status, n.code]]));
    expect(status).toEqual({ base: ['UNAVAILABLE', 'PUBLIC_RPC_UNAVAILABLE'], 'arbitrum-one': ['READ', null], ethereum: ['UNAVAILABLE', 'WRONG_PROVIDER_CHAIN'],
      robinhood: ['NOT_ENABLED', 'NETWORK_NOT_ENABLED'] });
    expect(portfolio.holdings.map(h => [h.network, h.symbol, h.units])).toEqual([['Arbitrum One', 'ETH', '2000000000000000000']]);
  });
  it('reads the native balance alone where Multicall3 is absent or the catalog is unavailable, and says so', async () => {
    const log: { method: string; params: readonly unknown[] }[] = [];
    const portfolio = await readWalletPortfolio({ evm: OWNER, solana: null }, {}, seams({ modes: { base: 'live', robinhood: 'live' }, log,
      chains: { base: base({ [WETH]: 10n ** 18n }, 3n, { multicall: false }), robinhood: { chainId: 4663, native: 4n, balances: {} } },
      catalogs: { robinhood: new Error('STOCK_REGISTRY_UNAVAILABLE') } }));
    expect(portfolio.networks.find(n => n.id === 'base')).toMatchObject({ status: 'READ', tokens: 'NATIVE_ONLY', uncheckedTokens: 3, code: 'MULTICALL_UNAVAILABLE' });
    expect(portfolio.networks.find(n => n.id === 'robinhood')).toMatchObject({ status: 'READ', tokens: 'NATIVE_ONLY', code: 'STOCK_REGISTRY_UNAVAILABLE' });
    expect(portfolio.holdings.map(h => [h.network, h.symbol, h.units])).toEqual([['Base', 'ETH', '3'], ['Robinhood Chain', 'ETH', '4']]);
    expect(log.filter(entry => entry.method === 'eth_getBalance')).toHaveLength(1);
  });
  it('reports a token whose balance call failed as unchecked, never as zero', async () => {
    const portfolio = await readWalletPortfolio({ evm: OWNER, solana: null }, {}, seams({ modes: { base: 'live' }, chains: { base: base({ [WETH]: 'revert', [USDC]: 7n }) } }));
    expect(portfolio.networks[1]).toMatchObject({ id: 'base', tokens: 'PARTIAL', uncheckedTokens: 1, code: 'PORTFOLIO_TOKEN_UNCHECKED' });
    expect(portfolio.holdings.map(h => h.symbol)).toEqual(['USDC']);
  });
  it('chunks large catalogs and caps the tokens checked per network, counting the rest as unchecked', async () => {
    const many = Array.from({ length: PORTFOLIO_MAX_TOKENS + 5 }, (_, i) => asset('base', `T${i}`, address(0x1000 + i), 18));
    const log: { method: string; params: readonly unknown[] }[] = [];
    const portfolio = await readWalletPortfolio({ evm: OWNER, solana: null }, {}, seams({ modes: { base: 'live' }, log, catalogs: { base: catalog('base', many) },
      chains: { base: base({ [address(0x1000 + 130)]: 9n }) } }));
    expect(log.filter(entry => entry.method === 'eth_call')).toHaveLength(Math.ceil(PORTFOLIO_MAX_TOKENS / PORTFOLIO_CHUNK));
    expect(portfolio.networks[1]).toMatchObject({ tokens: 'PARTIAL', uncheckedTokens: 5, code: 'PORTFOLIO_TOKEN_LIMIT' });
    expect(portfolio.holdings.map(h => [h.symbol, h.units])).toEqual([['T130', '9']]);
  });
  it('bounds the read: a network that does not answer within the budget is UNAVAILABLE', async () => {
    const portfolio = await readWalletPortfolio({ evm: OWNER, solana: null }, {}, { ...seams({ modes: { base: 'live' }, chains: { base: base({}, 1n, { never: true }) }, budgetMs: 30 }),
      now: () => new Date() });
    expect(portfolio.networks[1]).toMatchObject({ id: 'base', status: 'UNAVAILABLE', code: 'PORTFOLIO_READ_TIMEOUT' });
    expect(portfolio.holdings).toEqual([]);
  });
  it('round-trips the aggregate3 ABI and rejects malformed or out-of-bounds responses', () => {
    const calls = [{ target: MULTICALL3, data: '0x4d2301cc' + '0'.repeat(64) }, { target: WETH, data: '0x70a08231' + '1'.repeat(64) }];
    expect(readAggregate3Request(encodeAggregate3(calls))).toEqual(calls.map(c => ({ target: c.target, callData: c.data })));
    const response = aggregate3Response([{ ok: true, data: '0x' + word(5n) }, { ok: false, data: '0x08c379a0' }]);
    expect(decodeAggregate3(response, 2)).toEqual([{ success: true, data: '0x' + word(5n) }, { success: false, data: '0x08c379a0' }]);
    expect(() => decodeAggregate3(response, 3)).toThrow('PORTFOLIO_MULTICALL_INVALID');
    expect(() => decodeAggregate3(response.slice(0, -64), 2)).toThrow('PORTFOLIO_MULTICALL_INVALID');
    expect(() => decodeAggregate3('0x' + word(0x20n) + word(2n) + word(0xffffn) + word(0n), 2)).toThrow('PORTFOLIO_MULTICALL_INVALID');
    expect(() => decodeAggregate3('nope', 0)).toThrow('PORTFOLIO_MULTICALL_INVALID');
  });
});

// ── Solana ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function tokenAccount(mint: string, owner: string, amount: bigint, state = 1): string {
  const data = new Uint8Array(165);
  data.set(base58Decode(mint), 0); data.set(base58Decode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true); data[108] = state;
  return Buffer.from(data).toString('base64');
}
const rpcAccount = (program: string, data: string, lamports = 2_039_280) => ({ pubkey: base58Encode(new Uint8Array(32).fill(3)),
  account: { data: [data, 'base64'], executable: false, lamports, owner: program, rentEpoch: 0, space: 165 } });
function solanaCatalog(): SolanaAssetCatalog {
  return { assets: [{ symbol: 'SOL', name: 'Solana', mint: WSOL_MINT, decimals: 9, native: true, logoUrl: null },
    { symbol: 'USDC', name: 'USD Coin', mint: USDC_MINT, decimals: 6, native: false, logoUrl: null }], fetchedAt: NOW.toISOString(), source: 'test', contentSha256: '', excludedRecords: 0 };
}
function solanaRpc(options: { genesis?: string; lamports?: number; classic?: unknown[]; token2022?: unknown[] | Error; calls?: string[] }): SolanaRpc {
  return async (method, params) => {
    options.calls?.push(method);
    if (method === 'getGenesisHash') return options.genesis ?? MAINNET_GENESIS;
    if (method === 'getMultipleAccounts') {
      expect(params[0]).toEqual([SOL_OWNER]);
      return { context: { slot: 400_000_001 }, value: [options.lamports === undefined ? null : { data: ['', 'base64'], executable: false, lamports: options.lamports, owner: '11111111111111111111111111111111', rentEpoch: 0 }] };
    }
    if (method === 'getTokenAccountsByOwner') {
      const program = (params[1] as { programId: string }).programId;
      expect(params[0]).toBe(SOL_OWNER);
      const list = program === TOKEN_PROGRAM ? options.classic ?? [] : options.token2022 ?? [];
      if (list instanceof Error) throw list;
      return { context: { slot: 400_000_001 }, value: list };
    }
    throw new Error('SOLANA_RPC_METHOD_DENIED');
  };
}

describe('wallet portfolio: Solana reads the owner and its token accounts', () => {
  it('shows SOL, verified mints and wrapped SOL, counts unlisted mints, omits zero balances and prices SOL/WSOL only', async () => {
    const calls: string[] = [];
    const rpc = solanaRpc({ calls, lamports: 2_000_000_000, classic: [
      rpcAccount(TOKEN_PROGRAM, tokenAccount(USDC_MINT, SOL_OWNER, 30_000_000n)), rpcAccount(TOKEN_PROGRAM, tokenAccount(USDC_MINT, SOL_OWNER, 20_000_000n)),
      rpcAccount(TOKEN_PROGRAM, tokenAccount(WSOL_MINT, SOL_OWNER, 1_000_000_000n)), rpcAccount(TOKEN_PROGRAM, tokenAccount(UNLISTED_MINT, SOL_OWNER, 5n)),
      rpcAccount(TOKEN_PROGRAM, tokenAccount(base58Encode(new Uint8Array(32).fill(11)), SOL_OWNER, 0n))] });
    const portfolio = await readWalletPortfolio({ evm: null, solana: SOL_OWNER }, {}, seams({ modes: { solana: 'live' }, solana: rpc, prices: prices({ SOL: '150' }, 'chainlink') }));
    expect(calls).toEqual(['getGenesisHash', 'getMultipleAccounts', 'getTokenAccountsByOwner', 'getTokenAccountsByOwner']);
    expect(portfolio.networks).toEqual([{ id: 'solana', name: 'Solana', chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', chainId: null, ecosystem: 'solana', status: 'READ',
      provenance: 'PUBLIC_MAINNET', observedAt: NOW.toISOString(), block: null, slot: 400_000_001, tokens: 'ALL', uncheckedTokens: 0, code: null }]);
    expect(portfolio.holdings.map(h => [h.symbol, h.address, h.units, h.valueUsd])).toEqual([['SOL', null, '2000000000', '300.00'],
      ['USDC', USDC_MINT, '50000000', null], ['WSOL', WSOL_MINT, '1000000000', '150.00']]);
    expect(portfolio).toMatchObject({ unlisted: 1, pricedTotalUsd: '450.00', unpricedCount: 1, priceSource: 'CHAINLINK', mocked: false });
  });
  // BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001 review: a Token-2022 mint may scale its displayed amount (scaled-UI / interest-bearing extensions this
  // read does not apply), so its balances are counted as not checked — never shown as a raw amount.
  it('counts Token-2022 balances as not checked (never shown unscaled), and skips and counts an account whose layout cannot be decoded', async () => {
    const PYUSD = base58Encode(new Uint8Array(32).fill(13)), malformed = Buffer.from(new Uint8Array(170)).toString('base64');
    const listed: SolanaAssetCatalog = { ...solanaCatalog(), assets: [...solanaCatalog().assets, { symbol: 'PYUSD', name: 'PayPal USD', mint: PYUSD, decimals: 6, native: false, logoUrl: null }] };
    const portfolio = await readWalletPortfolio({ evm: null, solana: SOL_OWNER }, {}, seams({ modes: { solana: 'live' }, solanaCatalog: listed,
      solana: solanaRpc({ lamports: 0, token2022: [rpcAccount(TOKEN_2022, tokenAccount(PYUSD, SOL_OWNER, 7_000_000n)), rpcAccount(TOKEN_2022, malformed)] }) }));
    expect(portfolio.holdings).toEqual([]);
    expect(portfolio.networks[0]).toMatchObject({ tokens: 'PARTIAL', uncheckedTokens: 2, code: 'SOLANA_TOKEN_ACCOUNT_UNREADABLE' });
  });
  it('keeps SOL when one token program fails, and refuses a response for another owner', async () => {
    const partial = await readWalletPortfolio({ evm: null, solana: SOL_OWNER }, {}, seams({ modes: { solana: 'live' },
      solana: solanaRpc({ lamports: 5, classic: [rpcAccount(TOKEN_PROGRAM, tokenAccount(USDC_MINT, SOL_OWNER, 1n))], token2022: new Error('SOLANA_RPC_RATE_LIMITED') }) }));
    expect(partial.networks[0]).toMatchObject({ status: 'READ', tokens: 'PARTIAL', code: 'SOLANA_RPC_RATE_LIMITED' });
    expect(partial.holdings.map(h => h.symbol)).toEqual(['SOL', 'USDC']);
    const foreign = await readWalletPortfolio({ evm: null, solana: SOL_OWNER }, {}, seams({ modes: { solana: 'live' },
      solana: solanaRpc({ lamports: 5, classic: [rpcAccount(TOKEN_PROGRAM, tokenAccount(USDC_MINT, UNLISTED_MINT, 1n))], token2022: [] }) }));
    expect(foreign.networks[0]).toMatchObject({ tokens: 'PARTIAL', code: 'SOLANA_TOKEN_ACCOUNT_MISMATCH' });
    expect(foreign.holdings.map(h => h.symbol)).toEqual(['SOL']);
  });
  it('never shows a mint it cannot identify when the verified list is unavailable, and refuses another cluster', async () => {
    const portfolio = await readWalletPortfolio({ evm: null, solana: SOL_OWNER }, {}, seams({ modes: { solana: 'live' }, solanaCatalog: new Error('SOLANA_TOKEN_CATALOG_UNAVAILABLE'),
      solana: solanaRpc({ lamports: 5, classic: [rpcAccount(TOKEN_PROGRAM, tokenAccount(USDC_MINT, SOL_OWNER, 1n))] }) }));
    expect(portfolio.networks[0]).toMatchObject({ tokens: 'NATIVE_ONLY', uncheckedTokens: 1, code: 'SOLANA_TOKEN_CATALOG_UNAVAILABLE' });
    expect(portfolio.holdings.map(h => h.symbol)).toEqual(['SOL']);
    expect(portfolio.unlisted).toBe(0);
    const devnet = await readWalletPortfolio({ evm: null, solana: SOL_OWNER }, {}, seams({ modes: { solana: 'live' }, solana: solanaRpc({ genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' }) }));
    expect(devnet.networks[0]).toMatchObject({ status: 'UNAVAILABLE', code: 'SOLANA_WRONG_CLUSTER' });
  });
  it('reads both ecosystems side by side, each from its own wallet', async () => {
    const portfolio = await readWalletPortfolio({ evm: OWNER, solana: SOL_OWNER }, {}, seams({ modes: { base: 'live', solana: 'harness' },
      chains: { base: base({}, 10n ** 18n) }, solana: solanaRpc({ lamports: 10 }), prices: prices({ ETH: '3000', SOL: '100' }) }));
    expect(portfolio.accounts.map(a => a.ecosystem)).toEqual(['evm', 'solana']);
    expect(portfolio.holdings.map(h => [h.network, h.symbol, h.provenance, h.valueUsd])).toEqual([['Base', 'ETH', 'PUBLIC_MAINNET', '3000.00'], ['Solana', 'SOL', 'MOCKED', '0.00']]);
    expect(portfolio.mocked).toBe(true);
  });
});

describe('wallet portfolio: input, enablement and cache', () => {
  it('validates addresses strictly and lowercases EVM addresses', () => {
    expect(portfolioAccounts({ evm: '0x' + 'AB'.repeat(20), solana: null })).toEqual([{ ecosystem: 'evm', address: OWNER }]);
    for (const evm of ['0x123', 'ab'.repeat(20), '0x' + 'g'.repeat(40), '0x' + '0'.repeat(40), 42]) expect(() => portfolioAccounts({ evm, solana: null })).toThrow('PORTFOLIO_EVM_ADDRESS_INVALID');
    for (const solana of ['0OIl' + 'a'.repeat(40), 'abc', base58Encode(new Uint8Array(31).fill(5)), '11111111111111111111111111111111'])
      expect(() => portfolioAccounts({ evm: null, solana })).toThrow('PORTFOLIO_SOLANA_ADDRESS_INVALID');
    expect(() => portfolioAccounts({ evm: null, solana: null })).toThrow('PORTFOLIO_NO_ACCOUNT');
    expect(() => portfolioAccounts(null)).toThrow('PORTFOLIO_INPUT_INVALID');
    expect(() => portfolioAccounts([OWNER])).toThrow('PORTFOLIO_INPUT_INVALID');
  });
  it('reads nothing and observes no price where no network is enabled', async () => {
    const log: { method: string; params: readonly unknown[] }[] = [], source = prices({ ETH: '3000', SOL: '100' });
    const portfolio = await readWalletPortfolio({ evm: OWNER, solana: SOL_OWNER }, {}, seams({ log, prices: source }));
    expect(portfolio.networks.every(network => network.status === 'NOT_ENABLED')).toBe(true);
    expect(portfolio).toMatchObject({ holdings: [], pricedTotalUsd: null, unpricedCount: 0 });
    expect(log).toEqual([]); expect(source.observed).toEqual([]);
  });
  it('the default enablement follows the deployment gates and never reads a harness on a hosted deployment', async () => {
    const network = async (env: Record<string, string>) => (await readWalletPortfolio({ evm: OWNER, solana: null }, env,
      seams({ gates: true, chains: { base: base({}, 1n) } }))).networks.find(n => n.id === 'base')!;
    expect(await network({})).toMatchObject({ status: 'NOT_ENABLED' });
    expect(await network({ GRYLOO_BASE_MAINNET_HARNESS: 'MOCKED_LOOPBACK_ONLY' })).toMatchObject({ status: 'READ', provenance: 'MOCKED' });
    expect(await network({ GRYLOO_BASE_MAINNET_HARNESS: 'MOCKED_LOOPBACK_ONLY', FLOFI_DEPLOYMENT: 'hosted', DATABASE_URL: '' })).toMatchObject({ status: 'NOT_ENABLED' });
  });
  it('coalesces repeated reads of the same wallet through the cache', async () => {
    const log: { method: string; params: readonly unknown[] }[] = [], cache: PortfolioCache = new Map();
    const options = seams({ modes: { base: 'live' }, log, cache, chains: { base: base({}, 1n) } });
    const [first, second] = await Promise.all([readWalletPortfolio({ evm: OWNER, solana: null }, {}, options), readWalletPortfolio({ evm: OWNER, solana: null }, {}, options)]);
    await readWalletPortfolio({ evm: OWNER, solana: null }, {}, options);
    expect(second).toBe(first);
    expect(log.filter(entry => entry.method === 'eth_chainId')).toHaveLength(1);
    expect([...cache.values()][0]!.ttlMs).toBe(30_000);
  });
});
