// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002 test harness: a MOCKED Robinhood Chain (4663) in memory and the official Stock Token catalog from the
 * committed read-only capture (packages/action-registry/test/fixtures). Nothing here reaches a network, signs or sends:
 * a test plays the owner's wallet by mutating the in-memory state and recording a receipt. Runtime code is synthetic, so
 * the code pins are replaced by the pins of that synthetic code (allowed only for MOCKED provenance).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { catalogAsset, parseRobinhoodStockTokenRegistry, robinhoodNetworkCatalog, uniswapV3PoolAddress, UNISWAP_V3_ETHEREUM, UNISWAP_V3_ARBITRUM, UNISWAP_V3_BASE, UNISWAP_V3_ROBINHOOD,
  type AssetCatalog, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { decodeNativeSwap, erc7710, fromHex } from '@defi-workflow-engine/reference-compiler';
import type { CatalogSwapRuntime, Rpc } from './public-testnet-service.ts';

export const OFFICIAL_REGISTRY_TEXT = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/robinhood-rhj-assets-2026-10-11.json', import.meta.url), 'utf8');
export const officialCatalog = (text = OFFICIAL_REGISTRY_TEXT, fetchedAt = '2026-10-11T02:00:00.000Z'): AssetCatalog =>
  robinhoodNetworkCatalog(parseRobinhoodStockTokenRegistry(text, fetchedAt));
export const asset = (catalog: AssetCatalog, symbol: string): CanonicalAsset => catalogAsset(catalog, { symbol }) ?? (() => { throw new Error('NO_ASSET ' + symbol); })();

const sha = (code: string) => createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
/** Synthetic runtime code per contract role; pins are their SHA-256. */
export const MOCK_CODE = Object.freeze({ factory: '0x60016001', router: '0x60026002', quoter: '0x60036003', positionManager: '0x60046004',
  weth: '0x60056005', usdg: '0x60066006', stockTokenProxy: '0x60076007', pool: '0x60086008',
  /** BUILD-BASE-001: Base's pinned USDC, and the (unpinned) code of every listed Base token. */ usdc: '0x60096009', listed: '0x600a600a' });
export const MOCK_CODE_PINS = Object.freeze(Object.fromEntries(Object.entries(MOCK_CODE).map(([name, code]) => [name, sha(code)])) as Record<keyof typeof MOCK_CODE, string>);

export const word = (value: bigint) => '0x' + BigInt.asUintN(256, value).toString(16).padStart(64, '0');
export const addressWord = (value: string) => '0x' + value.toLowerCase().slice(2).padStart(64, '0');
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const SCALED_TRANSFER_TOPIC = '0x37e7f0db430edc9dd31bc66f25f8449353aa0818f503b906747dd8f286cd3802';
export const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
/** BUILD-FLOFI-BRIDGE-LIVE-FIX-003: WETH9 `Deposit` / `Withdrawal` (Base, Ethereum); Arbitrum-style WETH logs a Transfer mint/burn instead. */
export const DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
export const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
export const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const ZERO = '0x' + '0'.repeat(40);
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: the MetaMask Delegation Framework v1.3.0 contracts a relayed redemption touches, and the log shapes of
 * the real MetaMask relay recorded in testdata/metamask-delegated-depth1-approval.base-sepolia.json (LimitedCalls `IncreasedCount`, the call's
 * own logs, the manager's `RedeemedDelegation(rootDelegator, redeemer, delegation)`). Synthetic chain state; no real relay is reached.
 */
export const MOCK_DELEGATION_MANAGER = '0xdb9b1e94b5b69df7e401ddbede43491141047db3', MOCK_DELEGATOR_IMPL = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
const LIMITED_CALLS = '0x04658b29f6b82ed55274221a06fc97d318e25416', INCREASED_COUNT_TOPIC = '0x449da07f2c06c9d1a6b19d2454ffe749e8cf991d22f686e076a1a4844c5ff370';
/** The recorded relay's second caveat enforcer (exact target ‖ value ‖ calldata terms) and its open delegate. */
const EXACT_EXECUTION = '0x146713078d39ecc1f5338309c28405ccf85abfbb', ANY_DELEGATE = '0x0000000000000000000000000000000000000a11';
const DELEGATION_ABI: erc7710.AbiType = { tuple: ['address', 'address', 'bytes32', { array: { tuple: ['address', 'bytes', 'bytes'] } }, 'uint256', 'bytes'] };
const REDEEMED_TOPIC = '0x40dadaa36c6c2e3d7317e24757451ffb2d603d875f0ad5e92c5dd156573b1873';
/** `redeemDelegations(bytes[] contexts, bytes32[] modes, bytes[] executionCallDatas)` of one single-call (default mode) execution of `target.data`. */
export function encodeSingleRedemption(context: string, target: string, data: string): string {
  const w = (n: bigint) => n.toString(16).padStart(64, '0');
  const pad = (hex: string) => hex + '0'.repeat((64 - (hex.length % 64)) % 64);
  const bytesArray = (hex: string) => w(1n) + w(32n) + w(BigInt(hex.length / 2)) + pad(hex);
  const contexts = bytesArray(context.slice(2)), modeOffset = 96 + contexts.length / 2;
  return '0xcef6d209' + w(96n) + w(BigInt(modeOffset)) + w(BigInt(modeOffset + 64)) + contexts + w(1n) + w(0n) + bytesArray(target.slice(2).toLowerCase() + w(0n) + data.slice(2));
}
export type MockRelay = { readonly relayer: string; /** Logs of another contract the relayed transaction also emits (a shape FloFi must refuse). */ readonly extraLogs?: readonly Record<string, unknown>[];
  /** false: the owner's delegation has no LimitedCalls(1) caveat, so the relay could redeem it again (a shape FloFi must refuse). */ readonly singleUse?: boolean };
/**
 * The owner's open root delegation as MetaMask's relay redeems it (testdata/metamask-delegated-depth1-approval.base-sepolia.json): any redeemer,
 * LimitedCalls(1) and an exact-execution caveat for `target.data`; returns the `RedeemedDelegation` data and the delegation hash.
 */
function relayedDelegation(owner: string, target: string, data: string, salt: bigint, singleUse: boolean) {
  const hex32 = (n: bigint) => n.toString(16).padStart(64, '0');
  const caveats = [...singleUse ? [{ enforcer: LIMITED_CALLS, terms: '0x' + hex32(1n), args: '0x' }] : [],
    { enforcer: EXACT_EXECUTION, terms: '0x' + target.slice(2).toLowerCase() + hex32(0n) + data.slice(2), args: '0x' }];
  const delegation = { delegate: ANY_DELEGATE, delegator: owner, authority: erc7710.ROOT_AUTHORITY, caveats, salt };
  const encoded = erc7710.hexOf(erc7710.abiEncode([DELEGATION_ABI], [[delegation.delegate, owner, delegation.authority,
    caveats.map(c => [c.enforcer, c.terms, c.args]), salt, '0x' + '11'.repeat(65)]]));
  return { data: encoded, hash: erc7710.delegationHash(delegation) };
}
/** Tokens whose `transferFrom` also logs the spent allowance, `Approval(owner, spender, remaining)` (OpenZeppelin ERC20, e.g. Arbitrum aeWETH, ARB). */
export type MockApply = { readonly extraLogs?: readonly Record<string, unknown>[] };

export type MockPool = { readonly fee: number; readonly liquidity: bigint;
  /** Output units per 1e18 input units, for each direction keyed by input address. */ readonly rate: Readonly<Record<string, bigint>> };
export type MockStock = { uid?: string; multiplierWad: bigint; scheduledWad?: bigint; effectiveAt?: number; beacon?: string; code?: string };
export type MockTx = { from: string; to: string; data: string; value: string; gas?: string; maxFeePerGas?: string };
/**
 * The mutable chain: head block, token balances and allowances, native balances, Stock Token multiplier state, pools keyed
 * by their locally derived address. `apply` executes an owner transaction (approve, ERC-20 transfer, exact-input swap) the
 * way the real contracts would for these tests, records a receipt and advances the head.
 */
export function createRobinhoodMockChain(catalog: AssetCatalog, options: { readonly now: () => number;
  /** BUILD-BASE-001: the catalog network this chain plays (default Robinhood Chain): its Uniswap deployment, pinned tokens and OP Stack L1 fee. */
  readonly network?: 'robinhood' | 'base' }) {
  const options_ = options;
  const base = options.network === 'base', eth = catalog.chain === 'eip155:1', arb = catalog.chain === 'eip155:42161';
  const UNI = { ...UNISWAP_V3_ROBINHOOD, ...base ? { factory: UNISWAP_V3_BASE.factory, router: UNISWAP_V3_BASE.router, quoter: UNISWAP_V3_BASE.quoter,
    positionManager: UNISWAP_V3_BASE.positionManager, weth: UNISWAP_V3_BASE.weth, poolInitCodeHash: UNISWAP_V3_BASE.poolInitCodeHash } : arb ? UNISWAP_V3_ARBITRUM : eth ? UNISWAP_V3_ETHEREUM : {} };
  const state = {
    chainHex: eth ? '0x1' : base ? '0x2105' : arb ? '0xa4b1' : '0x1237', head: 1_000, hashes: new Map<number, string>(),
    /** OP Stack (Base): the L1 data fee the GasPriceOracle bounds and every receipt carries. */ l1Fee: base ? 25_000_000_000n : 0n,
    balances: new Map<string, bigint>(), allowances: new Map<string, bigint>(), native: new Map<string, bigint>(), nonces: new Map<string, number>(),
    stocks: new Map<string, MockStock>(), pools: new Map<string, { token0: string; token1: string } & MockPool>(),
    code: new Map<string, string>(), receipts: new Map<string, Record<string, unknown>>(), transactions: new Map<string, Record<string, unknown>>(),
    gasPrice: 10_000_000n, gasUsed: 120_000n, blockTime: new Map<number, number>(), codeOverride: new Map<string, string>(),
    /** BUILD-BASE-001: a token whose `decimals()` differs from its catalog entry (a wrong list record). */ decimalsOverride: new Map<string, number>(),
    /** BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: tokens whose `transferFrom` logs the remaining allowance (see MockApply). */ transferFromApproval: new Set<string>(),
    /** Balances, native balances and nonces as they were at the end of each past block (historical reads). */
    snapshots: new Map<number, { balances: Map<string, bigint>; native: Map<string, bigint>; nonces: Map<string, number> }>(),
  };
  /** The state a read at `tag` sees: the live state at the head, the snapshot of that block before it. */
  const at = (tag: unknown) => {
    const n = tag === undefined || tag === 'latest' || tag === 'pending' ? state.head : Number(BigInt(tag as string));
    return n >= state.head ? state : state.snapshots.get(n) ?? (() => { throw new Error('MOCK_HISTORY_UNAVAILABLE ' + n); })();
  };
  const snapshot = () => state.snapshots.set(state.head, { balances: new Map(state.balances), native: new Map(state.native), nonces: new Map(state.nonces) });
  const key = (token: string, owner: string) => `${token.toLowerCase()}:${owner.toLowerCase()}`;
  const allowanceKey = (token: string, owner: string, spender: string) => `${token.toLowerCase()}:${owner.toLowerCase()}:${spender.toLowerCase()}`;
  const blockHash = (n: number) => { if (!state.hashes.has(n)) state.hashes.set(n, '0x' + createHash('sha256').update('rh-block-' + n).digest('hex')); return state.hashes.get(n)!; };
  const roles: readonly (readonly [keyof typeof MOCK_CODE, string])[] = [['factory', UNI.factory], ['router', UNI.router], ['quoter', UNI.quoter],
    ['positionManager', UNI.positionManager], ['weth', UNI.weth], base || arb || eth ? ['usdc', eth ? UNISWAP_V3_ETHEREUM.usdc : arb ? UNISWAP_V3_ARBITRUM.usdc : UNISWAP_V3_BASE.usdc] : ['usdg', UNI.usdg]];
  for (const [role, address] of roles) state.code.set(address, MOCK_CODE[role]);
  if (base || arb || eth) for (const listed of catalog.assets.filter(a => a.kind === 'ERC20' && a.address && !state.code.has(a.address))) state.code.set(listed.address!, MOCK_CODE.listed);
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
  function call(to: string, data: string, view: { balances: Map<string, bigint> } = state): string {
    to = to.toLowerCase();
    if (data === '0x') return '0x';
    const selector = data.slice(0, 10);
    if (selector === '0x095ea7b3') return word(1n);
    if (selector === '0x5ae401dc') {
      if (readWord(data, 0) <= BigInt(Math.floor(options.now() / 1000))) throw new Error('execution reverted: deadline');
      return word(32n) + word(1n).slice(2) + word(32n).slice(2) + word(32n).slice(2) + word(1n).slice(2);
    }
    if (([UNI.router, UNI.quoter, UNI.positionManager] as readonly string[]).includes(to)) {
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
    if (base && to === '0x420000000000000000000000000000000000000f' && selector === '0xf1c7a58b') return word(state.l1Fee);
    if (selector === '0x313ce567') return word(BigInt(state.decimalsOverride.get(to) ?? tokenDecimals(to)));
    if (selector === '0x70a08231') return word(view.balances.get(key(to, readAddress(data, 0))) ?? 0n);
    if (selector === '0xdd62ed3e') return word(state.allowances.get(allowanceKey(to, readAddress(data, 0), readAddress(data, 1))) ?? 0n);
    if (selector === '0xa9059cbb') return word(1n);
    if (selector === '0x04e45aaf') return word(0n);
    // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: WETH deposit()/withdraw(uint256) return nothing.
    if (to === UNI.weth && (selector === '0xd0e30db0' || selector === '0x2e1a7d4d')) return '0x';
    throw new Error('execution reverted');
  }
  const rpc: Rpc = async (method, params) => {
    const block = state.head, time = Math.floor(options.now() / 1000);
    if (!state.blockTime.has(block)) state.blockTime.set(block, time);
    if (method === 'eth_chainId') return state.chainHex;
    if (method === 'eth_blockNumber') return '0x' + block.toString(16);
    if (method === 'eth_gasPrice') return '0x' + state.gasPrice.toString(16);
    if (method === 'eth_maxPriorityFeePerGas') return '0x' + (state.gasPrice / 10n).toString(16);
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'latest' ? block : Number(BigInt(params[0] as string));
      const txs = [...state.receipts.values()].filter(r => r.blockNumber === '0x' + n.toString(16)).map(r => r.transactionHash);
      return { number: '0x' + n.toString(16), hash: blockHash(n), timestamp: '0x' + (state.blockTime.get(n) ?? time).toString(16), baseFeePerGas: '0x989680', transactions: params[1] === true ? txs.map(hash => state.transactions.get(String(hash))) : txs };
    }
    if (method === 'eth_getCode') return state.codeOverride.get(String(params[0]).toLowerCase()) ?? state.code.get(String(params[0]).toLowerCase()) ?? '0x';
    if (method === 'eth_getStorageAt') {
      const stock = state.stocks.get(String(params[0]).toLowerCase());
      return stock && params[1] === UNI.beaconSlot ? addressWord(stock.beacon ?? UNI.stockTokenBeacon) : word(0n);
    }
    if (method === 'eth_getBalance') return '0x' + (at(params[1]).native.get(String(params[0]).toLowerCase()) ?? 0n).toString(16);
    if (method === 'eth_getTransactionCount') {
      const owner = String(params[0]).toLowerCase(), queued = params[1] === 'pending' ? mempool.filter(tx => tx.from.toLowerCase() === owner).length : 0;
      return '0x' + ((at(params[1]).nonces.get(owner) ?? 0) + queued).toString(16);
    }
    if (method === 'eth_estimateGas') return '0x' + state.gasUsed.toString(16);
    if (method === 'eth_call') { const request = params[0] as { to: string; data: string }; return call(request.to, request.data, at(params[1])); }
    if (method === 'eth_getTransactionReceipt') return state.receipts.get(String(params[0])) ?? null;
    if (method === 'eth_getTransactionByHash') return state.transactions.get(String(params[0])) ?? null;
    if (method === 'eth_getLogs') {
      // Exact filter semantics over the recorded receipts: address, positional topics, inclusive block range.
      const filter = params[0] as { address?: unknown; topics?: unknown[]; fromBlock?: string; toBlock?: string; blockHash?: unknown };
      // Only the filter shapes FloFi sends; anything else fails loudly instead of matching nothing.
      if (filter.blockHash !== undefined || filter.address !== undefined && typeof filter.address !== 'string' ||
          (filter.topics ?? []).some(topic => topic !== null && typeof topic !== 'string')) throw new Error('MOCK_GETLOGS_FILTER_UNSUPPORTED');
      const from = filter.fromBlock ? Number(BigInt(filter.fromBlock)) : block, to = !filter.toBlock || filter.toBlock === 'latest' ? block : Number(BigInt(filter.toBlock));
      return [...state.receipts.values()].filter(r => Number(BigInt(r.blockNumber as string)) >= from && Number(BigInt(r.blockNumber as string)) <= to)
        .flatMap(r => (r.logs as Record<string, unknown>[]).map((log, logIndex): Record<string, unknown> => ({ ...log, transactionHash: r.transactionHash, blockNumber: r.blockNumber,
          blockHash: r.blockHash, logIndex: '0x' + logIndex.toString(16), removed: false })))
        .filter(log => (!filter.address || String(log.address).toLowerCase() === String(filter.address).toLowerCase()) &&
          (filter.topics ?? []).every((topic, index) => topic === null || (log.topics as string[])[index] === topic));
    }
    throw new Error('UNEXPECTED_METHOD ' + method);
  };
  /** HOTFIX-WORKFLOW-CONCURRENCY-001: transactions the wallet broadcast that no block includes yet (the account's 'pending' nonce counts them). */
  const mempool: MockTx[] = [];
  const innerData = (tx: MockTx) => tx.data.startsWith('0x5ae401dc') ? '0x' + tx.data.slice(10 + 5 * 64, 10 + 5 * 64 + Number(BigInt('0x' + tx.data.slice(10 + 4 * 64, 10 + 5 * 64))) * 2) : tx.data;
  const hashOf = (from: string, nonce: number, data: string) => '0x' + createHash('sha256').update(`rh-tx-${from}-${nonce}-${data}`).digest('hex');
  /** Plays the owner's wallet: executes one owner transaction against the mock state in a new block and returns its hash. */
  function apply(tx: MockTx, options: MockApply = {}): string { snapshot(); state.head += 1; return include(tx, undefined, options.extraLogs); }
  /**
   * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: plays a MetaMask relayer. The owner's account must carry the DeleGator designator; the relayer
   * sends a type-2 `redeemDelegations` of exactly the owner's call to the Delegation Manager, which executes it from the owner's account. The
   * relayer pays the fee and uses its own nonce; the owner's nonce and native balance are untouched.
   */
  function relay(tx: MockTx, options: MockRelay & { readonly reverted?: boolean }): string {
    if (!state.code.has(MOCK_DELEGATION_MANAGER)) state.code.set(MOCK_DELEGATION_MANAGER, '0x600b600b');
    snapshot(); state.head += 1;
    if (!options.reverted) return include(tx, options);
    // A redemption that reverted: the relayer's nonce and fee are spent, nothing else changes and nothing is logged.
    const sender = options.relayer.toLowerCase(), nonce = state.nonces.get(sender) ?? 0, outer = encodeSingleRedemption('0x' + '00'.repeat(64), tx.to, tx.data);
    const hash = hashOf(sender, nonce, outer), blockNumber = '0x' + state.head.toString(16);
    state.nonces.set(sender, nonce + 1); state.native.set(sender, (state.native.get(sender) ?? 0n) - state.gasUsed * state.gasPrice);
    state.blockTime.set(state.head, Math.floor(options_.now() / 1000));
    state.transactions.set(hash, { hash, from: sender, to: MOCK_DELEGATION_MANAGER, input: outer, value: '0x0', chainId: state.chainHex, type: '0x2', nonce: '0x' + nonce.toString(16),
      blockHash: blockHash(state.head), blockNumber, gas: '0x' + (state.gasUsed * 3n).toString(16), maxFeePerGas: '0x' + (state.gasPrice * 3n).toString(16) });
    state.receipts.set(hash, { transactionHash: hash, status: '0x0', blockNumber, blockHash: blockHash(state.head), from: sender, to: MOCK_DELEGATION_MANAGER,
      gasUsed: '0x' + state.gasUsed.toString(16), effectiveGasPrice: '0x' + state.gasPrice.toString(16), ...base ? { l1Fee: '0x' + state.l1Fee.toString(16) } : { gasUsedForL1: '0x0' }, logs: [] });
    return hash;
  }
  /** Plays the owner's wallet broadcasting without inclusion: the hash is known, the transaction waits in the mempool. */
  function queue(tx: MockTx): string {
    const from = tx.from.toLowerCase();
    const nonce = (state.nonces.get(from) ?? 0) + mempool.filter(t => t.from.toLowerCase() === from).length;
    mempool.push(tx);
    return hashOf(from, nonce, innerData(tx));
  }
  /** Includes every mempool transaction, in broadcast (nonce) order, in ONE new block. */
  function mineQueued(): string[] { snapshot(); state.head += 1; return mempool.splice(0).map(tx => include(tx)); }
  function include(tx: MockTx, relayed?: MockRelay, extraLogs: readonly Record<string, unknown>[] = []): string {
    const from = tx.from.toLowerCase(), to = tx.to.toLowerCase(), data = innerData(tx), selector = data.slice(0, 10);
    const relayer = relayed?.relayer.toLowerCase(), sender = relayer ?? from;
    if (relayed && (state.codeOverride.get(from) ?? '0x') !== '0xef0100' + MOCK_DELEGATOR_IMPL.slice(2)) throw new Error('execution reverted: not a DeleGator account');
    const outer = relayed ? encodeSingleRedemption('0x' + '00'.repeat(64), to, tx.data) : tx.data;
    const nonce = state.nonces.get(sender) ?? 0, hash = relayed ? hashOf(sender, nonce, outer) : hashOf(from, nonce, data);
    const logs: Record<string, unknown>[] = [];
    const delegation = relayed ? relayedDelegation(from, to, tx.data, BigInt(nonce) + 1n, relayed.singleUse !== false) : null;
    if (relayed && relayed.singleUse !== false) logs.push({ address: LIMITED_CALLS, topics: [INCREASED_COUNT_TOPIC, addressWord(MOCK_DELEGATION_MANAGER), addressWord(sender), delegation!.hash],
      data: word(1n) + word(1n).slice(2) });
    const move = (token: string, a: string, b: string, amount: bigint) => {
      const before = state.balances.get(key(token, a)) ?? 0n;
      if (before < amount) throw new Error('execution reverted: balance');
      state.balances.set(key(token, a), before - amount);
      state.balances.set(key(token, b), (state.balances.get(key(token, b)) ?? 0n) + amount);
      logs.push({ address: token, topics: [TRANSFER_TOPIC, addressWord(a), addressWord(b)], data: word(amount) });
      // Robinhood Stock Tokens (ERC-8056) also emit the scaled transfer next to Transfer.
      const stock = state.stocks.get(token.toLowerCase());
      if (stock) logs.push({ address: token, topics: [SCALED_TRANSFER_TOPIC, addressWord(a), addressWord(b)], data: word(amount) + word(amount * stock.multiplierWad / 10n ** 18n).slice(2) });
    };
    // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: WETH's wrap/unwrap in the network's own log dialect, and SwapRouter02's native-ETH multicalls.
    const wethDialect = base || eth ? 'WETH9' : 'MINT_BURN';
    const wrapLog = (holder: string, amount: bigint) => logs.push(wethDialect === 'WETH9' ? { address: UNI.weth, topics: [DEPOSIT_TOPIC, addressWord(holder)], data: word(amount) }
      : { address: UNI.weth, topics: [TRANSFER_TOPIC, addressWord(ZERO), addressWord(holder)], data: word(amount) });
    const unwrapLog = (holder: string, amount: bigint) => logs.push(wethDialect === 'WETH9' ? { address: UNI.weth, topics: [WITHDRAWAL_TOPIC, addressWord(holder)], data: word(amount) }
      : { address: UNI.weth, topics: [TRANSFER_TOPIC, addressWord(holder), addressWord(ZERO)], data: word(amount) });
    const credit = (holder: string, amount: bigint) => state.native.set(holder, (state.native.get(holder) ?? 0n) + amount);
    const debit = (holder: string, amount: bigint) => { const before = state.native.get(holder) ?? 0n; if (before < amount) throw new Error('execution reverted: native balance'); state.native.set(holder, before - amount); };
    const value = BigInt(tx.value || '0x0');
    let native: ReturnType<typeof decodeNativeSwap> | null = null;
    if (to === UNI.router && tx.data.startsWith('0x5ae401dc')) { try { native = decodeNativeSwap(fromHex(tx.data), UNI.weth); } catch { native = null; } }
    if (native?.native === 'INPUT' && value === 0n) native = null; // a WETH ERC-20 swap: the router pulls WETH, it wraps nothing
    if (to === UNI.weth && selector === '0xd0e30db0') {
      debit(from, value); state.balances.set(key(UNI.weth, from), (state.balances.get(key(UNI.weth, from)) ?? 0n) + value); wrapLog(from, value);
    } else if (to === UNI.weth && selector === '0x2e1a7d4d') {
      const amount = readWord(data, 0), before = state.balances.get(key(UNI.weth, from)) ?? 0n;
      if (before < amount || value !== 0n) throw new Error('execution reverted: withdraw');
      state.balances.set(key(UNI.weth, from), before - amount); unwrapLog(from, amount); credit(from, amount);
    } else if (native) {
      if (native.deadline <= BigInt(Math.floor(options.now() / 1000))) throw new Error('execution reverted: deadline');
      const tokenIn = native.native === 'INPUT' ? UNI.weth : native.tokenIn, tokenOut = native.native === 'OUTPUT' ? UNI.weth : native.tokenOut;
      const out = quote(tokenIn, tokenOut, native.amountIn, native.fee), pool = uniswapV3PoolAddress(UNI.factory, UNI.poolInitCodeHash, tokenIn, tokenOut, native.fee);
      if (out < native.amountOutMinimum) throw new Error('execution reverted: Too little received');
      const [delta0, delta1] = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? [native.amountIn, -out] : [-out, native.amountIn];
      const swapLog = (recipient: string) => logs.push({ address: pool, topics: [SWAP_TOPIC, addressWord(UNI.router), addressWord(recipient)],
        data: word(delta0) + word(delta1).slice(2) + word(79228162514264337593543950336n).slice(2) + word(state.pools.get(pool)!.liquidity).slice(2) + word(0n).slice(2) });
      if (native.native === 'INPUT') {
        if (value !== native.amountIn) throw new Error('execution reverted: value');
        debit(from, value); credit(UNI.router, value);
        // The router wraps exactly msg.value and pays the pool; the pool pays the recipient.
        debit(UNI.router, value); state.balances.set(key(UNI.weth, UNI.router), (state.balances.get(key(UNI.weth, UNI.router)) ?? 0n) + value); wrapLog(UNI.router, value);
        move(UNI.weth, UNI.router, pool, value);
        state.balances.set(key(tokenOut, pool), (state.balances.get(key(tokenOut, pool)) ?? 0n) + out);
        move(tokenOut, pool, native.recipient, out); swapLog(native.recipient);
      } else {
        if (value !== 0n) throw new Error('execution reverted: value');
        const allowance = state.allowances.get(allowanceKey(tokenIn, from, UNI.router)) ?? 0n;
        if (allowance < native.amountIn) throw new Error('execution reverted: STF');
        state.allowances.set(allowanceKey(tokenIn, from, UNI.router), allowance - native.amountIn);
        if (state.transferFromApproval.has(tokenIn.toLowerCase())) logs.push({ address: tokenIn, topics: [APPROVAL_TOPIC, addressWord(from), addressWord(UNI.router)], data: word(allowance - native.amountIn) });
        move(tokenIn, from, pool, native.amountIn);
        state.balances.set(key(UNI.weth, pool), (state.balances.get(key(UNI.weth, pool)) ?? 0n) + out);
        move(UNI.weth, pool, UNI.router, out); swapLog(UNI.router);
        // unwrapWETH9(amountMinimum, recipient): the router's whole WETH balance, in native ETH, to the recipient.
        const held = state.balances.get(key(UNI.weth, UNI.router)) ?? 0n;
        state.balances.set(key(UNI.weth, UNI.router), 0n); unwrapLog(UNI.router, held); credit(native.recipient, held);
      }
    } else if (selector === '0x095ea7b3') {
      state.allowances.set(allowanceKey(to, from, readAddress(data, 0)), readWord(data, 1));
      // ERC-20 `Approval(owner, spender, value)`, as every listed token emits it.
      logs.push({ address: to, topics: [APPROVAL_TOPIC, addressWord(from), addressWord(readAddress(data, 0))], data: word(readWord(data, 1)) });
    }
    else if (selector === '0xa9059cbb') move(to, from, readAddress(data, 0), readWord(data, 1));
    else if (selector === '0x04e45aaf' && to === UNI.router) {
      const tokenIn = readAddress(data, 0), tokenOut = readAddress(data, 1), fee = Number(readWord(data, 2)), recipient = readAddress(data, 3);
      const amountIn = readWord(data, 4), minimum = readWord(data, 5), out = quote(tokenIn, tokenOut, amountIn, fee);
      if (out < minimum) throw new Error('execution reverted: Too little received');
      const allowance = state.allowances.get(allowanceKey(tokenIn, from, UNI.router)) ?? 0n;
      if (allowance < amountIn) throw new Error('execution reverted: STF');
      state.allowances.set(allowanceKey(tokenIn, from, UNI.router), allowance - amountIn);
      const pool = uniswapV3PoolAddress(UNI.factory, UNI.poolInitCodeHash, tokenIn, tokenOut, fee);
      if (state.transferFromApproval.has(tokenIn.toLowerCase())) logs.push({ address: tokenIn, topics: [APPROVAL_TOPIC, addressWord(from), addressWord(UNI.router)], data: word(allowance - amountIn) });
      move(tokenIn, from, pool, amountIn);
      state.balances.set(key(tokenOut, pool), (state.balances.get(key(tokenOut, pool)) ?? 0n) + out);
      move(tokenOut, pool, recipient, out);
      // Uniswap V3 Swap(sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick): the pool's signed deltas, token0 first.
      const [delta0, delta1] = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? [amountIn, -out] : [-out, amountIn];
      logs.push({ address: pool, topics: [SWAP_TOPIC, addressWord(UNI.router), addressWord(recipient)],
        data: word(delta0) + word(delta1).slice(2) + word(79228162514264337593543950336n).slice(2) + word(state.pools.get(pool)!.liquidity).slice(2) + word(0n).slice(2) });
    } else if (data === '0x') {
      state.native.set(from, (state.native.get(from) ?? 0n) - value);
      state.native.set(to, (state.native.get(to) ?? 0n) + value);
    } else throw new Error('UNSUPPORTED_MOCK_TRANSACTION');
    if (relayed) logs.push({ address: MOCK_DELEGATION_MANAGER, topics: [REDEEMED_TOPIC, addressWord(from), addressWord(sender)], data: delegation!.data }, ...relayed.extraLogs ?? []);
    logs.push(...extraLogs);
    const fee = state.gasUsed * state.gasPrice + state.l1Fee;
    state.native.set(sender, (state.native.get(sender) ?? 0n) - fee);
    state.nonces.set(sender, nonce + 1);
    const blockNumber = '0x' + state.head.toString(16), outerTo = relayed ? MOCK_DELEGATION_MANAGER : to;
    state.blockTime.set(state.head, Math.floor(options.now() / 1000));
    state.transactions.set(hash, { hash, from: sender, to: outerTo, input: outer, value: relayed ? '0x0' : tx.value, chainId: state.chainHex, type: '0x2', nonce: '0x' + nonce.toString(16),
      blockHash: blockHash(state.head), blockNumber, gas: relayed ? '0x' + (state.gasUsed * 3n).toString(16) : tx.gas ?? '0x' + (state.gasUsed * 2n).toString(16),
      maxFeePerGas: relayed ? '0x' + (state.gasPrice * 3n).toString(16) : tx.maxFeePerGas ?? '0x' + (state.gasPrice * 2n).toString(16) });
    state.receipts.set(hash, { transactionHash: hash, status: '0x1', blockNumber, blockHash: blockHash(state.head), from: sender, to: outerTo, gasUsed: '0x' + state.gasUsed.toString(16),
      effectiveGasPrice: '0x' + state.gasPrice.toString(16), ...base ? { l1Fee: '0x' + state.l1Fee.toString(16) } : { gasUsedForL1: '0x0' }, logs });
    return hash;
  }
  /** Advances the head by `n` empty blocks (confirmations), keeping historical reads exact. */
  const mine = (n = 1) => { for (let i = 0; i < n; i++) { snapshot(); state.head += 1; state.blockTime.set(state.head, Math.floor(options.now() / 1000)); } };
  return { rpc, state, addPool, apply, relay, queue, mineQueued, mine, fund: (token: string, owner: string, amount: bigint) => state.balances.set(key(token, owner), amount),
    fundNative: (owner: string, amount: bigint) => state.native.set(owner.toLowerCase(), amount), balance: (token: string, owner: string) => state.balances.get(key(token, owner)) ?? 0n };
}
export type RobinhoodMockChain = ReturnType<typeof createRobinhoodMockChain>;
/** The catalog runtime of the MOCKED harness: synthetic code pins, a fixed catalog (or a failing registry), owner execution as given. */
export function mockCatalogRuntime(catalog: AssetCatalog | (() => Promise<AssetCatalog>), executionEnabled = true): CatalogSwapRuntime {
  return { provenance: 'MOCKED', executionEnabled, codePins: MOCK_CODE_PINS,
    catalogFor: typeof catalog === 'function' ? catalog : async () => catalog };
}
