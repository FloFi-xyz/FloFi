// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002 test harness: a MOCKED Robinhood Chain (4663) in memory and the official Stock Token catalog from the
 * committed read-only capture (packages/action-registry/test/fixtures). Nothing here reaches a network, signs or sends:
 * a test plays the owner's wallet by mutating the in-memory state and recording a receipt. Runtime code is synthetic, so
 * the code pins are replaced by the pins of that synthetic code (allowed only for MOCKED provenance).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { catalogAsset, parseRobinhoodStockTokenRegistry, robinhoodNetworkCatalog, uniswapV3PoolAddress, UNISWAP_V3_ROBINHOOD as UNI,
  type AssetCatalog, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import type { CatalogSwapRuntime, Rpc } from './public-testnet-service.ts';

export const OFFICIAL_REGISTRY_TEXT = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/robinhood-rhj-assets-2026-10-11.json', import.meta.url), 'utf8');
export const officialCatalog = (text = OFFICIAL_REGISTRY_TEXT, fetchedAt = '2026-10-11T02:00:00.000Z'): AssetCatalog =>
  robinhoodNetworkCatalog(parseRobinhoodStockTokenRegistry(text, fetchedAt));
export const asset = (catalog: AssetCatalog, symbol: string): CanonicalAsset => catalogAsset(catalog, { symbol }) ?? (() => { throw new Error('NO_ASSET ' + symbol); })();

const sha = (code: string) => createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
/** Synthetic runtime code per contract role; pins are their SHA-256. */
export const MOCK_CODE = Object.freeze({ factory: '0x60016001', router: '0x60026002', quoter: '0x60036003', positionManager: '0x60046004',
  weth: '0x60056005', usdg: '0x60066006', stockTokenProxy: '0x60076007', pool: '0x60086008' });
export const MOCK_CODE_PINS = Object.freeze(Object.fromEntries(Object.entries(MOCK_CODE).map(([name, code]) => [name, sha(code)])) as Record<keyof typeof MOCK_CODE, string>);

export const word = (value: bigint) => '0x' + BigInt.asUintN(256, value).toString(16).padStart(64, '0');
export const addressWord = (value: string) => '0x' + value.toLowerCase().slice(2).padStart(64, '0');
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type MockPool = { readonly fee: number; readonly liquidity: bigint;
  /** Output units per 1e18 input units, for each direction keyed by input address. */ readonly rate: Readonly<Record<string, bigint>> };
export type MockStock = { uid?: string; multiplierWad: bigint; scheduledWad?: bigint; effectiveAt?: number; beacon?: string; code?: string };
export type MockTx = { from: string; to: string; data: string; value: string };
/**
 * The mutable chain: head block, token balances and allowances, native balances, Stock Token multiplier state, pools keyed
 * by their locally derived address. `apply` executes an owner transaction (approve, ERC-20 transfer, exact-input swap) the
 * way the real contracts would for these tests, records a receipt and advances the head.
 */
export function createRobinhoodMockChain(catalog: AssetCatalog, options: { readonly now: () => number }) {
  const state = {
    chainHex: '0x1237', head: 1_000, hashes: new Map<number, string>(),
    balances: new Map<string, bigint>(), allowances: new Map<string, bigint>(), native: new Map<string, bigint>(), nonces: new Map<string, number>(),
    stocks: new Map<string, MockStock>(), pools: new Map<string, { token0: string; token1: string } & MockPool>(),
    code: new Map<string, string>(), receipts: new Map<string, Record<string, unknown>>(), transactions: new Map<string, Record<string, unknown>>(),
    gasPrice: 10_000_000n, gasUsed: 120_000n, blockTime: new Map<number, number>(), codeOverride: new Map<string, string>(),
  };
  const key = (token: string, owner: string) => `${token.toLowerCase()}:${owner.toLowerCase()}`;
  const allowanceKey = (token: string, owner: string, spender: string) => `${token.toLowerCase()}:${owner.toLowerCase()}:${spender.toLowerCase()}`;
  const blockHash = (n: number) => { if (!state.hashes.has(n)) state.hashes.set(n, '0x' + createHash('sha256').update('rh-block-' + n).digest('hex')); return state.hashes.get(n)!; };
  for (const [role, address] of [['factory', UNI.factory], ['router', UNI.router], ['quoter', UNI.quoter], ['positionManager', UNI.positionManager],
    ['weth', UNI.weth], ['usdg', UNI.usdg]] as const) state.code.set(address, MOCK_CODE[role]);
  for (const stock of catalog.assets.filter(a => a.stock)) {
    state.code.set(stock.address!, MOCK_CODE.stockTokenProxy);
    state.stocks.set(stock.address!, { multiplierWad: BigInt(stock.stock!.multiplierWad) });
  }
  const tokenDecimals = (token: string) => catalog.assets.find(a => a.address === token.toLowerCase())?.decimals ?? 18;
  function addPool(a: string, b: string, pool: MockPool) {
    const address = uniswapV3PoolAddress(UNI.factory, UNI.poolInitCodeHash, a, b, pool.fee);
    const [token0, token1] = [a.toLowerCase(), b.toLowerCase()].sort() as [string, string];
    state.pools.set(address, { token0, token1, ...pool });
    state.code.set(address, MOCK_CODE.pool);
    return address;
  }
  const quote = (tokenIn: string, tokenOut: string, amount: bigint, fee: number) => {
    const address = uniswapV3PoolAddress(UNI.factory, UNI.poolInitCodeHash, tokenIn, tokenOut, fee), pool = state.pools.get(address);
    if (!pool || pool.liquidity === 0n) throw new Error('execution reverted');
    return amount * pool.rate[tokenIn.toLowerCase()]! / 10n ** 18n;
  };
  const readWord = (data: string, index: number) => BigInt('0x' + data.slice(10 + index * 64, 10 + (index + 1) * 64));
  const readAddress = (data: string, index: number) => '0x' + data.slice(10 + index * 64 + 24, 10 + (index + 1) * 64);
  function call(to: string, data: string): string {
    to = to.toLowerCase();
    const selector = data.slice(0, 10);
    if ([UNI.router, UNI.quoter, UNI.positionManager].includes(to)) {
      if (selector === '0xc45a0155') return addressWord(UNI.factory);
      if (selector === '0x4aa4a4fc') return addressWord(UNI.weth);
    }
    if (to === UNI.quoter && selector === '0xc6a5026a') {
      const out = quote(readAddress(data, 0), readAddress(data, 1), readWord(data, 2), Number(readWord(data, 3)));
      return word(out) + word(0n).slice(2) + word(1n).slice(2) + word(90_000n).slice(2);
    }
    const pool = state.pools.get(to);
    if (pool) {
      if (selector === '0xc45a0155') return addressWord(UNI.factory);
      if (selector === '0x0dfe1681') return addressWord(pool.token0);
      if (selector === '0xd21220a7') return addressWord(pool.token1);
      if (selector === '0xddca3f43') return word(BigInt(pool.fee));
      if (selector === '0xd0c93a7c') return word(BigInt(UNI.feeTiers.find(t => t.fee === pool.fee)!.tickSpacing));
      if (selector === '0x1a686502') return word(pool.liquidity);
      if (selector === '0x3850c7bd') return word(79228162514264337593543950336n) + word(0n).slice(2).repeat(6);
    }
    const stock = state.stocks.get(to);
    if (stock) {
      const asset = catalog.assets.find(a => a.address === to)!;
      if (selector === '0xf514ce36') return stock.uid ?? asset.stock!.officialId;
      if (selector === '0xa60bf13d') return word(stock.multiplierWad);
      if (selector === '0xdc767007') return word(stock.scheduledWad ?? stock.multiplierWad);
      if (selector === '0x97a4064f') return word(BigInt(stock.effectiveAt ?? 0));
    }
    if (selector === '0x313ce567') return word(BigInt(tokenDecimals(to)));
    if (selector === '0x70a08231') return word(state.balances.get(key(to, readAddress(data, 0))) ?? 0n);
    if (selector === '0xdd62ed3e') return word(state.allowances.get(allowanceKey(to, readAddress(data, 0), readAddress(data, 1))) ?? 0n);
    if (selector === '0xa9059cbb') return word(1n);
    if (selector === '0x04e45aaf') return word(0n);
    throw new Error('execution reverted');
  }
  const rpc: Rpc = async (method, params) => {
    const block = state.head, time = Math.floor(options.now() / 1000);
    if (!state.blockTime.has(block)) state.blockTime.set(block, time);
    if (method === 'eth_chainId') return state.chainHex;
    if (method === 'eth_blockNumber') return '0x' + block.toString(16);
    if (method === 'eth_gasPrice') return '0x' + state.gasPrice.toString(16);
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'latest' ? block : Number(BigInt(params[0] as string));
      const txs = [...state.receipts.values()].filter(r => r.blockNumber === '0x' + n.toString(16)).map(r => r.transactionHash);
      return { number: '0x' + n.toString(16), hash: blockHash(n), timestamp: '0x' + (state.blockTime.get(n) ?? time).toString(16), baseFeePerGas: '0x989680', transactions: txs };
    }
    if (method === 'eth_getCode') return state.codeOverride.get(String(params[0]).toLowerCase()) ?? state.code.get(String(params[0]).toLowerCase()) ?? '0x';
    if (method === 'eth_getStorageAt') {
      const stock = state.stocks.get(String(params[0]).toLowerCase());
      return stock && params[1] === UNI.beaconSlot ? addressWord(stock.beacon ?? UNI.stockTokenBeacon) : word(0n);
    }
    if (method === 'eth_getBalance') return '0x' + (state.native.get(String(params[0]).toLowerCase()) ?? 0n).toString(16);
    if (method === 'eth_getTransactionCount') return '0x' + (state.nonces.get(String(params[0]).toLowerCase()) ?? 0).toString(16);
    if (method === 'eth_estimateGas') return '0x' + state.gasUsed.toString(16);
    if (method === 'eth_call') { const request = params[0] as { to: string; data: string }; return call(request.to, request.data); }
    if (method === 'eth_getTransactionReceipt') return state.receipts.get(String(params[0])) ?? null;
    if (method === 'eth_getTransactionByHash') return state.transactions.get(String(params[0])) ?? null;
    if (method === 'eth_getLogs') return [];
    throw new Error('UNEXPECTED_METHOD ' + method);
  };
  /** Plays the owner's wallet: executes one owner transaction against the mock state and returns its hash. */
  function apply(tx: MockTx): string {
    const from = tx.from.toLowerCase(), to = tx.to.toLowerCase(), data = tx.data, selector = data.slice(0, 10);
    const nonce = state.nonces.get(from) ?? 0, hash = '0x' + createHash('sha256').update(`rh-tx-${from}-${nonce}-${data}`).digest('hex');
    const logs: Record<string, unknown>[] = [];
    const move = (token: string, a: string, b: string, amount: bigint) => {
      const before = state.balances.get(key(token, a)) ?? 0n;
      if (before < amount) throw new Error('execution reverted: balance');
      state.balances.set(key(token, a), before - amount);
      state.balances.set(key(token, b), (state.balances.get(key(token, b)) ?? 0n) + amount);
      logs.push({ address: token, topics: [TRANSFER_TOPIC, addressWord(a), addressWord(b)], data: word(amount) });
    };
    if (selector === '0x095ea7b3') state.allowances.set(allowanceKey(to, from, readAddress(data, 0)), readWord(data, 1));
    else if (selector === '0xa9059cbb') move(to, from, readAddress(data, 0), readWord(data, 1));
    else if (selector === '0x04e45aaf' && to === UNI.router) {
      const tokenIn = readAddress(data, 0), tokenOut = readAddress(data, 1), fee = Number(readWord(data, 2)), recipient = readAddress(data, 3);
      const amountIn = readWord(data, 4), minimum = readWord(data, 5), out = quote(tokenIn, tokenOut, amountIn, fee);
      if (out < minimum) throw new Error('execution reverted: Too little received');
      const allowance = state.allowances.get(allowanceKey(tokenIn, from, UNI.router)) ?? 0n;
      if (allowance < amountIn) throw new Error('execution reverted: STF');
      state.allowances.set(allowanceKey(tokenIn, from, UNI.router), allowance - amountIn);
      const pool = uniswapV3PoolAddress(UNI.factory, UNI.poolInitCodeHash, tokenIn, tokenOut, fee);
      move(tokenIn, from, pool, amountIn);
      state.balances.set(key(tokenOut, pool), (state.balances.get(key(tokenOut, pool)) ?? 0n) + out);
      move(tokenOut, pool, recipient, out);
    } else if (data === '0x') {
      const value = BigInt(tx.value);
      state.native.set(from, (state.native.get(from) ?? 0n) - value);
      state.native.set(to, (state.native.get(to) ?? 0n) + value);
    } else throw new Error('UNSUPPORTED_MOCK_TRANSACTION');
    const fee = state.gasUsed * state.gasPrice;
    state.native.set(from, (state.native.get(from) ?? 0n) - fee);
    state.nonces.set(from, nonce + 1);
    state.head += 1;
    const blockNumber = '0x' + state.head.toString(16);
    state.blockTime.set(state.head, Math.floor(options.now() / 1000));
    state.transactions.set(hash, { hash, from, to, input: data, value: tx.value, chainId: state.chainHex, type: '0x2', nonce: '0x' + nonce.toString(16), blockHash: blockHash(state.head) });
    state.receipts.set(hash, { transactionHash: hash, status: '0x1', blockNumber, blockHash: blockHash(state.head), from, to, gasUsed: '0x' + state.gasUsed.toString(16),
      effectiveGasPrice: '0x' + state.gasPrice.toString(16), gasUsedForL1: '0x0', logs });
    return hash;
  }
  return { rpc, state, addPool, apply, fund: (token: string, owner: string, amount: bigint) => state.balances.set(key(token, owner), amount),
    fundNative: (owner: string, amount: bigint) => state.native.set(owner.toLowerCase(), amount), balance: (token: string, owner: string) => state.balances.get(key(token, owner)) ?? 0n };
}
export type RobinhoodMockChain = ReturnType<typeof createRobinhoodMockChain>;
/** The catalog runtime of the MOCKED harness: synthetic code pins, a fixed catalog (or a failing registry), owner execution as given. */
export function mockCatalogRuntime(catalog: AssetCatalog | (() => Promise<AssetCatalog>), executionEnabled = true): CatalogSwapRuntime {
  return { provenance: 'MOCKED', executionEnabled, codePins: MOCK_CODE_PINS,
    catalogFor: typeof catalog === 'function' ? catalog : async () => catalog };
}
