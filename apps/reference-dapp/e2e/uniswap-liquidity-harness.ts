// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MOCKED in-process Base Sepolia chain with a Uniswap v3 USDC/WETH 0.05% pool, Position Manager and two ERC-20s, for
 * the liquidity unit, PostgreSQL and loopback browser suites. No network. Read methods answer exactly the calls the
 * service makes; the only transaction path is `wallet.send` — the owner's browser wallet in a real deployment.
 * Every block keeps a state snapshot so historical reads (receipt block and parent) behave like an archive node.
 * BUILD-RH-002: `profile` may be a Robinhood Chain pool (any catalog pair and fee tier); `stocks` makes a token a Stock Token (official
 * beacon proxy code, beacon slot, uid and multiplier reads) and `catalogPins` are the synthetic pins of its USDG/WETH/Stock Token code.
 */
import { ARBITRUM_ONE, UNISWAP_V3_ETHEREUM, UNISWAP_V3_ARBITRUM, UNISWAP_V3_BASE, UNISWAP_V3_BASE_SEPOLIA_LIQUIDITY, UNISWAP_V3_ROBINHOOD, type UniswapPoolProfile } from '@defi-workflow-engine/action-registry';
import { markConcentratedLiquidityManagement, readConcentratedLiquidityManagement, type ConcentratedLiquidityManagement,
  type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { uniMockCode, uniMockCodePin, UNI_MOCK_CATALOG_PINS, UNI_MOCK_CATALOG_TOKEN_CODE, UNI_MOCK_CODE_PINS, UNI_MOCK_STOCK_PROXY_CODE } from '../src/server/uniswap-liquidity-mock.ts';
import { UNISWAP_SELECTORS as SEL, UNISWAP_TOPICS as TOPIC, UNISWAP_POSITION_SELECTORS as PSEL, UNISWAP_POSITION_TOPICS as PTOPIC, decodeUniswapApprove,
  decodeUniswapBurn, decodeUniswapCollect, decodeUniswapDecreaseLiquidity, decodeUniswapMint, decodeUniswapMulticall, sqrtRatioAtTick, uniswapAmountsForLiquidity,
  uniswapComposition } from '@defi-workflow-engine/reference-compiler';

export const UNI_OWNER = '0x5555555555555555555555555555555555555555';
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the workflow of one operation on a position — the position's pool node marked with exactly that request,
 * as MANAGE_LIQUIDITY_POSITION authors it (any earlier marker is replaced).
 */
export function managedPositionWorkflow<W extends SemanticWorkflow>(workflow: W, request: { tokenId: string; operation: ConcentratedLiquidityManagement['operation'];
  partBps: number | null; close: boolean }): W {
  return { ...workflow, nodes: workflow.nodes.map(node => node.actionType !== 'asset.liquidity.concentrated' ? node
    : markConcentratedLiquidityManagement(readConcentratedLiquidityManagement(node).node,
      { positionId: request.tokenId, operation: request.operation, partBps: request.partBps, close: request.close })) };
}
export { UNI_MOCK_CODE_PINS };

type Snapshot = { balances: Record<string, Record<string, bigint>>; allowances: Record<string, bigint>; native: Record<string, bigint>; nonces: Record<string, bigint>;
  owners: Record<string, string>; positions: Record<string, MockPosition>; sqrtPriceX96: bigint; tick: number };
/**
 * A position as the NonfungiblePositionManager keeps it. `owed*` are the checkpointed tokensOwed `positions()` reports; `pending*` are fees the
 * pool accrued since the last checkpoint (BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001): only a collect or decrease pokes them into `owed*`, exactly
 * like the real manager, so a test can prove FloFi never treats a stale `tokensOwed` read as everything collectable.
 */
type MockPosition = { liquidity: bigint; tickLower: number; tickUpper: number; owed0: bigint; owed1: bigint; pending0: bigint; pending1: bigint };
type Inner = { readonly to: string; readonly input: string };
type WalletFees = { gas?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };
type MinedTx = { hash: string; from: string; to: string; input: string; nonce: bigint; block: number; status: 0 | 1; logs: unknown[]; gasUsed: bigint; inner?: Inner; fees?: WalletFees };
/** MetaMask Delegation Framework v1.3.0 on Base Sepolia, as observed in 0x8248b684…5ccc. */
export const UNI_DELEGATION_MANAGER = '0xdb9b1e94b5b69df7e401ddbede43491141047db3';
export const UNI_DELEGATOR_IMPL = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
export const UNI_RELAYER = '0xc066ac5d385419b1a8c43a0e146fa439837a8b8c';
const REDEEMED_TOPIC = '0x40dadaa36c6c2e3d7317e24757451ffb2d603d875f0ad5e92c5dd156573b1873';
/**
 * redeemDelegations([context], [mode 0], [encodeSingle(target, 0, data)]) — the exact single-redemption layout MetaMask
 * sends (verified byte-identical against the real Base Sepolia transaction in owner-submission.test.ts).
 */
export function encodeSingleRedemption(context: string, target: string, data: string): string {
  const word = (n: bigint) => n.toString(16).padStart(64, '0');
  const pad = (hex: string) => hex + '0'.repeat((64 - (hex.length % 64)) % 64);
  const bytesArray = (hex: string) => word(1n) + word(32n) + word(BigInt(hex.length / 2)) + pad(hex);
  const contexts = bytesArray(context.slice(2)), modeOffset = 96 + contexts.length / 2;
  return '0xcef6d209' + word(96n) + word(BigInt(modeOffset)) + word(BigInt(modeOffset + 64)) + contexts + word(1n) + word(0n) +
    bytesArray(target.slice(2) + word(0n) + data.slice(2));
}
const w = (n: bigint) => (n & ((1n << 256n) - 1n)).toString(16).padStart(64, '0');
const aw = (a: string) => a.slice(2).padStart(64, '0');
const hx = (n: number | bigint) => '0x' + n.toString(16);
const clone = (s: Snapshot): Snapshot => structuredClone(s);

export function createUniswapLiquidityChain(options: { owner?: string; usdc?: bigint; weth?: bigint; eth?: bigint; tick?: number; nonce?: bigint; simulateV1?: boolean;
  /** The owner's EOA is already EIP-7702-delegated to the MetaMask delegator (code `0xef0100‖impl`). */ delegatedOwner?: boolean;
  /** BUILD-ETHEREUM-001: the liquidity profile the chain stands in for (Base Sepolia by default). */ profile?: UniswapPoolProfile;
  /** BUILD-RH-002: Stock Token sides of a Robinhood Chain pool, keyed by address. */
  stocks?: Readonly<Record<string, { uid: string; multiplierWad: bigint; scheduledWad?: bigint; effectiveAt?: number }>>;
  /**
   * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the catalog's pinned base assets (USDC, WETH, USDG) carry the side-independent synthetic code
   * `UNI_MOCK_CATALOG_TOKEN_CODE`, so `catalogPins` equals `UNI_MOCK_CATALOG_PINS`, the pins the in-process MOCKED harness runtime uses for any pool.
   */
  catalogTokenCode?: boolean } = {}) {
  const profile: UniswapPoolProfile = options.profile ?? UNISWAP_V3_BASE_SEPOLIA_LIQUIDITY;
  const t0 = profile.token0.address, t1 = profile.token1.address, NPM = profile.positionManager, POOL = profile.pool;
  const stocks = new Map(Object.entries(options.stocks ?? {}).map(([address, stock]) => [address, { ...stock }]));
  const pinnedAssets: readonly (readonly [string, keyof typeof UNI_MOCK_CATALOG_TOKEN_CODE])[] = [[UNISWAP_V3_ROBINHOOD.usdg, 'usdg'], [UNISWAP_V3_ROBINHOOD.weth, 'weth'],
    [UNISWAP_V3_BASE.usdc, 'usdc'], [UNISWAP_V3_BASE.weth, 'weth'], [UNISWAP_V3_ETHEREUM.usdc, 'usdc'], [UNISWAP_V3_ETHEREUM.weth, 'weth'],
    [UNISWAP_V3_ARBITRUM.usdc, 'usdc'], [UNISWAP_V3_ARBITRUM.weth, 'weth']];
  const CODE: Readonly<Record<string, string>> = { ...uniMockCode(profile), ...Object.fromEntries([...stocks.keys()].map(address => [address, UNI_MOCK_STOCK_PROXY_CODE])),
    ...options.catalogTokenCode ? Object.fromEntries(pinnedAssets.filter(([address]) => [t0, t1].includes(address)).map(([address, key]) => [address, UNI_MOCK_CATALOG_TOKEN_CODE[key]])) : {} };
  /** Synthetic pins of the catalog's base assets and Stock Token proxy, as a MOCKED Robinhood Chain service accepts them. */
  const catalogPins = options.catalogTokenCode ? { ...UNI_MOCK_CATALOG_PINS } : { stockTokenProxy: uniMockCodePin(UNI_MOCK_STOCK_PROXY_CODE),
    ...[t0, t1].includes(UNISWAP_V3_ROBINHOOD.usdg) ? { usdg: uniMockCodePin(CODE[UNISWAP_V3_ROBINHOOD.usdg]!) } : {},
    ...[t0, t1].includes(UNISWAP_V3_ROBINHOOD.weth) ? { weth: uniMockCodePin(CODE[UNISWAP_V3_ROBINHOOD.weth]!) } : {},
    // BUILD-BASE-001: Base's pinned USDC and WETH (listed Base tokens carry no pin: code presence and decimals() only).
    ...[t0, t1].includes(UNISWAP_V3_BASE.usdc) ? { usdc: uniMockCodePin(CODE[UNISWAP_V3_BASE.usdc]!) } : {},
    ...[t0, t1].includes(UNISWAP_V3_BASE.weth) ? { weth: uniMockCodePin(CODE[UNISWAP_V3_BASE.weth]!) } : {},
    ...[t0, t1].includes(UNISWAP_V3_ETHEREUM.usdc) ? { usdc: uniMockCodePin(CODE[UNISWAP_V3_ETHEREUM.usdc]!) } : {},
    ...[t0, t1].includes(UNISWAP_V3_ETHEREUM.weth) ? { weth: uniMockCodePin(CODE[UNISWAP_V3_ETHEREUM.weth]!) } : {},
    ...[t0, t1].includes(UNISWAP_V3_ARBITRUM.usdc) ? { usdc: uniMockCodePin(CODE[UNISWAP_V3_ARBITRUM.usdc]!) } : {},
    ...[t0, t1].includes(UNISWAP_V3_ARBITRUM.weth) ? { weth: uniMockCodePin(CODE[UNISWAP_V3_ARBITRUM.weth]!) } : {} };
  const owner = options.owner ?? UNI_OWNER;
  const tick = options.tick ?? 225_600;
  let head = 1_000;
  let timestamp = Math.floor(Date.now() / 1000);
  const state: Snapshot = { balances: { [t0]: { [owner]: options.usdc ?? 50_000_000n, [POOL]: 210_000_000n }, [t1]: { [owner]: options.weth ?? 10n ** 17n, [POOL]: 10n ** 18n } },
    allowances: {}, native: { [owner]: options.eth ?? 10n ** 17n }, nonces: { [owner]: options.nonce ?? 7n }, owners: {}, positions: {},
    sqrtPriceX96: sqrtRatioAtTick(tick) + 123_456_789n, tick };
  const history = new Map<number, Snapshot>([[head, clone(state)]]);
  const mined = new Map<string, MinedTx>(), blocks = new Map<number, string[]>();
  const pendingTxs: { hash: string; from: string; to: string; input: string; nonce: bigint; inner?: Inner; fees?: WalletFees }[] = [];
  let nextTokenId = 9_001n, hashSeq = 0;
  const gasPrice = 1_000_000n, baseFee = 500_000n;
  const postingGas = profile.chain === ARBITRUM_ONE.chain ? 20_000n : 0n;
  const counters = { simulate: 0, sends: 0 };
  /** Base Flashblocks-style preconfirmation: receipt reads left that return a zero block hash for a block not sealed yet. */
  const preconfirmed = new Map<string, number>();
  const unsealed = (n: number) => [...preconfirmed.entries()].some(([hash, left]) => left > 0 && mined.get(hash)?.block === n);
  const allowanceKey = (token: string, from: string, spender: string) => `${token}:${from}:${spender}`;
  const at = (blockTag: unknown): Snapshot => {
    if (blockTag === 'latest' || blockTag === 'pending' || blockTag === undefined) return state;
    const n = Number(BigInt(blockTag as string));
    if (n >= head) return state;
    for (let b = n; b >= 1_000; b--) { const s = history.get(b); if (s) return s; }
    throw new Error('MOCK_MISSING_TRIE_NODE');
  };
  /** One contract call against a snapshot; mutating calls change `s` (used for simulation and execution). */
  function execute(s: Snapshot, from: string, to: string, data: string, time: number): { ok: boolean; ret: string; logs: unknown[]; gas: bigint } {
    const sel = data.slice(0, 10), log = (address: string, topics: string[], body: string) => ({ address, topics, data: '0x' + body });
    if ((to === t0 || to === t1) && sel === SEL.approve) {
      const { spender, amount } = decodeUniswapApprove(data);
      s.allowances[allowanceKey(to, from, spender)] = amount;
      return { ok: true, ret: '0x' + w(1n), logs: [log(to, [TOPIC.approval, '0x' + aw(from), '0x' + aw(spender)], w(amount))], gas: 46_000n };
    }
    if (to === NPM && sel === SEL.mint) {
      const p = decodeUniswapMint(data);
      if (BigInt(time) > p.deadline || p.token0 !== t0 || p.token1 !== t1 || p.fee !== profile.feeTier) return { ok: false, ret: '0x', logs: [], gas: 30_000n };
      let c;
      try { c = uniswapComposition(s.sqrtPriceX96, s.tick, p.tickLower, p.tickUpper, p.amount0Desired, p.amount1Desired); } catch { return { ok: false, ret: '0x', logs: [], gas: 30_000n }; }
      if (c.amount0 < p.amount0Min || c.amount1 < p.amount1Min) return { ok: false, ret: '0x', logs: [], gas: 60_000n };
      for (const [token, amount] of [[t0, c.amount0], [t1, c.amount1]] as const) {
        if (amount === 0n) continue;
        const key = allowanceKey(token, from, NPM);
        if ((s.allowances[key] ?? 0n) < amount || (s.balances[token]![from] ?? 0n) < amount) return { ok: false, ret: '0x', logs: [], gas: 80_000n };
      }
      const logs: unknown[] = [];
      for (const [token, amount] of [[t0, c.amount0], [t1, c.amount1]] as const) {
        if (amount === 0n) continue;
        s.allowances[allowanceKey(token, from, NPM)]! -= amount;
        s.balances[token]![from]! -= amount; s.balances[token]![POOL] = (s.balances[token]![POOL] ?? 0n) + amount;
      }
      const tokenId = nextTokenId++;
      s.owners[tokenId.toString()] = p.recipient;
      s.positions[tokenId.toString()] = { liquidity: c.liquidity, tickLower: p.tickLower, tickUpper: p.tickUpper, owed0: 0n, owed1: 0n, pending0: 0n, pending1: 0n };
      logs.push(log(POOL, [TOPIC.poolMint, '0x' + aw(NPM), '0x' + w(BigInt(p.tickLower)), '0x' + w(BigInt(p.tickUpper))], aw(NPM) + w(c.liquidity) + w(c.amount0) + w(c.amount1)));
      if (c.amount0 > 0n) logs.push(log(t0, [TOPIC.transfer, '0x' + aw(from), '0x' + aw(POOL)], w(c.amount0)));
      if (c.amount1 > 0n) logs.push(log(t1, [TOPIC.transfer, '0x' + aw(from), '0x' + aw(POOL)], w(c.amount1)));
      logs.push(log(NPM, [TOPIC.transfer, '0x' + w(0n), '0x' + aw(p.recipient), '0x' + w(tokenId)], ''));
      logs.push(log(NPM, [TOPIC.increaseLiquidity, '0x' + w(tokenId)], w(c.liquidity) + w(c.amount0) + w(c.amount1)));
      return { ok: true, ret: '0x' + w(tokenId) + w(c.liquidity) + w(c.amount0) + w(c.amount1), logs, gas: 480_000n };
    }
    if (to === NPM && ([PSEL.decreaseLiquidity, PSEL.collect, PSEL.burn, PSEL.multicall] as readonly string[]).includes(sel)) {
      // Position management runs on a copy and is applied only when every call succeeds (multicall is atomic).
      const copy = clone(s), logs: unknown[] = [], results: string[] = [];
      const calls = sel === PSEL.multicall ? (() => { try { return decodeUniswapMulticall(data); } catch { return null; } })() : [data];
      if (!calls) return { ok: false, ret: '0x', logs: [], gas: 30_000n };
      let gas = 21_000n;
      for (const call of calls) {
        const r = managePosition(copy, from, call, time, (address, topics, body) => logs.push(log(address, topics, body)));
        if (!r) return { ok: false, ret: '0x', logs: [], gas: gas + 30_000n };
        results.push(r.ret); gas += r.gas;
      }
      Object.assign(s, copy);
      const ret = sel === PSEL.multicall ? '0x' + bytesArray(results) : results[0]!;
      return { ok: true, ret, logs, gas };
    }
    return { ok: false, ret: '0x', logs: [], gas: 21_000n };
  }
  /** decreaseLiquidity / collect / burn with the manager's rules: owner only, deadline, slippage minimums, poke before collect, "Not cleared" burn. */
  function managePosition(s: Snapshot, from: string, data: string, time: number, emit: (address: string, topics: string[], body: string) => void):
    { ret: string; gas: bigint } | null {
    const sel = data.slice(0, 10), tw = (tick: number) => '0x' + w(BigInt(tick));
    const poke = (id: string, p: MockPosition) => {
      if (p.liquidity === 0n) return;
      emit(POOL, [PTOPIC.poolBurn, '0x' + aw(NPM), tw(p.tickLower), tw(p.tickUpper)], w(0n) + w(0n) + w(0n));
      p.owed0 += p.pending0; p.owed1 += p.pending1; p.pending0 = 0n; p.pending1 = 0n;
      void id;
    };
    try {
      if (sel === PSEL.decreaseLiquidity) {
        const d = decodeUniswapDecreaseLiquidity(data), id = d.tokenId.toString(), p = s.positions[id];
        if (!p || s.owners[id] !== from || BigInt(time) > d.deadline || d.liquidity > p.liquidity) return null;
        const out = uniswapAmountsForLiquidity(s.sqrtPriceX96, p.tickLower, p.tickUpper, d.liquidity);
        if (out.amount0 < d.amount0Min || out.amount1 < d.amount1Min) return null;
        emit(POOL, [PTOPIC.poolBurn, '0x' + aw(NPM), tw(p.tickLower), tw(p.tickUpper)], w(d.liquidity) + w(out.amount0) + w(out.amount1));
        p.owed0 += p.pending0 + out.amount0; p.owed1 += p.pending1 + out.amount1; p.pending0 = 0n; p.pending1 = 0n;
        p.liquidity -= d.liquidity;
        emit(NPM, [PTOPIC.decreaseLiquidity, '0x' + w(d.tokenId)], w(d.liquidity) + w(out.amount0) + w(out.amount1));
        return { ret: '0x' + w(out.amount0) + w(out.amount1), gas: 160_000n };
      }
      if (sel === PSEL.collect) {
        const c = decodeUniswapCollect(data), id = c.tokenId.toString(), p = s.positions[id];
        if (!p || s.owners[id] !== from) return null;
        poke(id, p);
        const a0 = p.owed0 < c.amount0Max ? p.owed0 : c.amount0Max, a1 = p.owed1 < c.amount1Max ? p.owed1 : c.amount1Max;
        for (const [token, amount] of [[t0, a0], [t1, a1]] as const) {
          if (amount === 0n) continue;
          if ((s.balances[token]![POOL] ?? 0n) < amount) return null;
          s.balances[token]![POOL]! -= amount; s.balances[token]![c.recipient] = (s.balances[token]![c.recipient] ?? 0n) + amount;
        }
        emit(POOL, [PTOPIC.poolCollect, '0x' + aw(NPM), tw(p.tickLower), tw(p.tickUpper)], aw(c.recipient) + w(a0) + w(a1));
        if (a0 > 0n) emit(t0, [TOPIC.transfer, '0x' + aw(POOL), '0x' + aw(c.recipient)], w(a0));
        if (a1 > 0n) emit(t1, [TOPIC.transfer, '0x' + aw(POOL), '0x' + aw(c.recipient)], w(a1));
        p.owed0 -= a0; p.owed1 -= a1;
        emit(NPM, [PTOPIC.collect, '0x' + w(c.tokenId)], aw(c.recipient) + w(a0) + w(a1));
        return { ret: '0x' + w(a0) + w(a1), gas: 130_000n };
      }
      if (sel === PSEL.burn) {
        const tokenId = decodeUniswapBurn(data), id = tokenId.toString(), p = s.positions[id];
        if (!p || s.owners[id] !== from || p.liquidity !== 0n || p.owed0 !== 0n || p.owed1 !== 0n) return null;
        delete s.positions[id]; delete s.owners[id];
        emit(NPM, [TOPIC.transfer, '0x' + aw(from), '0x' + w(0n), '0x' + w(tokenId)], '');
        return { ret: '0x', gas: 50_000n };
      }
    } catch { return null; }
    return null;
  }
  function bytesArray(items: readonly string[]): string {
    let head = w(BigInt(items.length)), tail = '', offset = BigInt(items.length * 32);
    for (const item of items) {
      const body = item.slice(2), padded = body + '0'.repeat((64 - (body.length % 64)) % 64);
      head += w(offset); tail += w(BigInt(body.length / 2)) + padded; offset += BigInt(32 + padded.length / 2);
    }
    return w(32n) + head + tail;
  }
  /** OP Stack L1 data fee: the GasPriceOracle's current upper bound and what the sequencer charges at inclusion (both move every L1 block). */
  const l1 = { estimate: 3_000_000_000n, charged: 1_000_000_000n };
  function read(s: Snapshot, to: string, data: string): string {
    const sel = data.slice(0, 10), arg = (i: number) => '0x' + data.slice(10 + i * 64 + 24, 10 + (i + 1) * 64);
    if (to === NPM && sel === SEL.factory) return '0x' + aw(profile.factory);
    if (to === NPM && sel === SEL.weth9) return '0x' + aw(profile.weth ?? t1);
    if (to === '0x00000000000000000000000000000000000000c8' && sel === '0x77d488a2') return '0x' + w(postingGas) + w(baseFee) + w(10_000_000_000n);
    const stock = stocks.get(to);
    if (stock && sel === '0xf514ce36') return stock.uid;
    if (stock && sel === '0xa60bf13d') return '0x' + w(stock.multiplierWad);
    if (stock && sel === '0xdc767007') return '0x' + w(stock.scheduledWad ?? stock.multiplierWad);
    if (stock && sel === '0x97a4064f') return '0x' + w(BigInt(stock.effectiveAt ?? 0));
    if (to === profile.factory && sel === SEL.getPool) return '0x' + aw(arg(0) === t0 && arg(1) === t1 ? POOL : '0x' + '0'.repeat(40));
    if (to === profile.factory && sel === SEL.feeAmountTickSpacing) return '0x' + w(BigInt(profile.feeTier) === BigInt('0x' + data.slice(10)) ? BigInt(profile.tickSpacing) : 0n);
    if (to === POOL && sel === SEL.factory) return '0x' + aw(profile.factory);
    if (to === POOL && sel === SEL.token0) return '0x' + aw(t0);
    if (to === POOL && sel === SEL.token1) return '0x' + aw(t1);
    if (to === POOL && sel === SEL.fee) return '0x' + w(BigInt(profile.feeTier));
    if (to === POOL && sel === SEL.tickSpacing) return '0x' + w(BigInt(profile.tickSpacing));
    if (to === POOL && sel === SEL.liquidity) return '0x' + w(448_000_000_000n);
    if (to === POOL && sel === SEL.slot0) return '0x' + w(s.sqrtPriceX96) + w(BigInt(s.tick)) + w(1n) + w(1n) + w(1n) + w(0n) + w(1n);
    if ((to === t0 || to === t1) && sel === SEL.decimals) return '0x' + w(BigInt(to === t0 ? profile.token0.decimals : profile.token1.decimals));
    if ((to === t0 || to === t1) && sel === SEL.balanceOf) return '0x' + w(s.balances[to]![arg(0)] ?? 0n);
    if ((to === t0 || to === t1) && sel === SEL.allowance) return '0x' + w(s.allowances[allowanceKey(to, arg(0), arg(1))] ?? 0n);
    if (to === NPM && sel === SEL.balanceOf) return '0x' + w(BigInt(Object.values(s.owners).filter(o => o === arg(0)).length));
    // ERC721Enumerable tokenOfOwnerByIndex(address,uint256) (BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 discovery): the owner's ids in mint order.
    if (to === NPM && sel === '0x2f745c59') {
      const owned = Object.entries(s.owners).filter(([, o]) => o === arg(0)).map(([id]) => BigInt(id)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      const index = BigInt('0x' + data.slice(74, 138));
      if (index >= BigInt(owned.length)) throw new Error('MOCK_REVERT');
      return '0x' + w(owned[Number(index)]!);
    }
    if (to === NPM && sel === SEL.ownerOf) { const id = BigInt('0x' + data.slice(10)).toString(); if (!s.owners[id]) throw new Error('MOCK_REVERT'); return '0x' + aw(s.owners[id]!); }
    if (to === NPM && sel === SEL.positions) {
      const p = s.positions[BigInt('0x' + data.slice(10)).toString()];
      if (!p) throw new Error('MOCK_REVERT');
      return '0x' + w(0n) + w(0n) + aw(t0) + aw(t1) + w(BigInt(profile.feeTier)) + w(BigInt(p.tickLower)) + w(BigInt(p.tickUpper)) + w(p.liquidity) + w(0n) + w(0n) +
        w(p.owed0) + w(p.owed1);
    }
    if (profile.gasPriceOracle && to === profile.gasPriceOracle && sel === SEL.l1FeeUpperBound) return '0x' + w(l1.estimate);
    throw new Error('MOCK_UNEXPECTED_CALL_' + to + '_' + sel);
  }
  const blockOf = (n: number, full: boolean) => ({ number: hx(n), hash: '0x' + n.toString(16).padStart(64, 'b'), timestamp: hx(n === head ? timestamp : timestamp - (head - n) * 2),
    baseFeePerGas: hx(baseFee), transactions: full ? (blocks.get(n) ?? []).map(h => txView(mined.get(h)!)) : blocks.get(n) ?? [] });
  const txView = (tx: MinedTx | (typeof pendingTxs)[number]) => ({ hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, nonce: hx(tx.nonce), value: '0x0',
    chainId: profile.chainHex, type: '0x2', gas: tx.fees?.gas ?? hx('gasUsed' in tx ? tx.gasUsed : 0n),
    maxFeePerGas: tx.fees?.maxFeePerGas ?? hx(gasPrice), maxPriorityFeePerGas: tx.fees?.maxPriorityFeePerGas ?? '0x0',
    blockNumber: 'block' in tx ? hx(tx.block) : null });
  function mine(txs: (typeof pendingTxs)[number][], options: { revert?: boolean } = {}) {
    head += 1; timestamp += 2;
    const hashes: string[] = [];
    for (const tx of txs) {
      // A delegated redemption executes the inner call as the owner; the relayer pays gas and consumes its own nonce.
      const result = options.revert ? { ok: false, ret: '0x', logs: [], gas: 50_000n } : tx.inner
        ? (() => { const r = execute(state, owner, tx.inner!.to, tx.inner!.input, timestamp);
          return r.ok ? { ...r, logs: [...r.logs, { address: UNI_DELEGATION_MANAGER, topics: [REDEEMED_TOPIC, '0x' + aw(owner), '0x' + aw(tx.from)], data: '0x' + w(32n) }] } : r; })()
        : execute(state, tx.from, tx.to, tx.input, timestamp);
      state.nonces[tx.from] = (state.nonces[tx.from] ?? 0n) + 1n;
      state.native[tx.from] = (state.native[tx.from] ?? 0n) - (result.gas + postingGas) * gasPrice;
      const logs = result.ok ? result.logs.map((l, i) => ({ ...(l as object), logIndex: hx(i) })) : [];
      mined.set(tx.hash, { ...tx, block: head, status: result.ok ? 1 : 0, logs, gasUsed: result.gas + postingGas });
      hashes.push(tx.hash);
    }
    blocks.set(head, hashes);
    history.set(head, clone(state));
  }
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    if (['eth_sendTransaction', 'eth_sendRawTransaction', 'sendTransaction'].includes(method)) throw new Error('MOCK_SEND_FORBIDDEN_USE_WALLET');
    switch (method) {
      case 'eth_chainId': return profile.chainHex;
      case 'eth_blockNumber': return hx(head);
      case 'eth_getBlockByNumber': { const n = params[0] === 'latest' ? head : Number(BigInt(params[0] as string)); return n > head || params[0] !== 'latest' && unsealed(n) ? null : blockOf(n, params[1] === true); }
      case 'eth_getCode': {
        const s = (params[0] as string).toLowerCase();
        if (s === UNI_DELEGATION_MANAGER) return '0x60076007';
        if (s === owner && options.delegatedOwner) return '0xef0100' + UNI_DELEGATOR_IMPL.slice(2);
        return CODE[s] ?? '0x';
      }
      case 'eth_getStorageAt': return '0x' + (stocks.has((params[0] as string).toLowerCase()) && params[1] === UNISWAP_V3_ROBINHOOD.beaconSlot
        ? aw(UNISWAP_V3_ROBINHOOD.stockTokenBeacon) : w(0n));
      case 'eth_getBalance': return hx(at(params[1]).native[(params[0] as string).toLowerCase()] ?? 0n);
      case 'eth_getTransactionCount': {
        const who = (params[0] as string).toLowerCase(), base = at(params[1]).nonces[who] ?? 0n;
        return hx(params[1] === 'pending' ? base + BigInt(pendingTxs.filter(p => p.from === who).length) : base);
      }
      case 'eth_maxPriorityFeePerGas': return hx(gasPrice - baseFee);
      case 'eth_gasPrice': return hx(gasPrice);
      case 'eth_estimateGas': {
        const c = params[0] as { from: string; to: string; data: string };
        const result = execute(clone(at(params[1])), c.from, c.to, c.data, timestamp + 2);
        if (!result.ok) throw new Error('MOCK_ESTIMATE_REVERTED');
        return hx(result.gas + postingGas);
      }
      case 'eth_call': {
        const r = params[0] as { to: string; data: string; from?: string };
        if (r.to.toLowerCase() === NPM && ([PSEL.decreaseLiquidity, PSEL.collect, PSEL.burn, PSEL.multicall] as readonly string[]).includes(r.data.slice(0, 10).toLowerCase())) {
          const result = execute(clone(at(params[1])), (r.from ?? '0x' + '0'.repeat(40)).toLowerCase(), NPM, r.data.toLowerCase(), timestamp + 2);
          if (!result.ok) throw new Error('MOCK_REVERT');
          return result.ret;
        }
        return read(at(params[1]), r.to.toLowerCase(), r.data.toLowerCase());
      }
      case 'eth_simulateV1': {
        if (options.simulateV1 === false) throw new Error('MOCK_METHOD_NOT_FOUND');
        counters.simulate += 1;
        const spec = params[0] as { blockStateCalls: { calls: { from: string; to: string; data: string }[] }[] };
        const s = clone(at(params[1]));
        return [{ number: hx(head + 1), calls: spec.blockStateCalls[0]!.calls.map(c => {
          const r = execute(s, c.from.toLowerCase(), c.to.toLowerCase(), c.data.toLowerCase(), timestamp + 2);
          return { status: r.ok ? '0x1' : '0x0', returnData: r.ret, gasUsed: hx(r.gas), logs: r.logs };
        }) }];
      }
      case 'eth_getTransactionReceipt': {
        const tx = mined.get(params[0] as string), left = tx ? preconfirmed.get(tx.hash) ?? 0 : 0;
        if (tx && left > 0) preconfirmed.set(tx.hash, left - 1);
        return tx ? { transactionHash: tx.hash, status: hx(tx.status), blockNumber: hx(tx.block), blockHash: left > 0 ? '0x' + '0'.repeat(64) : blockOf(tx.block, false).hash,
          from: tx.from, to: tx.to, transactionIndex: hx(BigInt([...mined.values()].filter(other => other.block === tx.block).indexOf(tx))),
          gasUsed: hx(tx.gasUsed), effectiveGasPrice: hx(gasPrice), ...profile.gasPriceOracle ? { l1Fee: hx(l1.charged) } : {}, logs: tx.logs } : null;
      }
      case 'eth_getTransactionByHash': { const tx = mined.get(params[0] as string) ?? pendingTxs.find(p => p.hash === params[0]); return tx ? txView(tx) : null; }
    }
    throw new Error('MOCK_UNEXPECTED_RPC_' + method);
  };
  const newHash = () => '0x' + (++hashSeq).toString(16).padStart(64, 'e');
  /** The owner's browser wallet: the ONLY place a transaction is sent. */
  const wallet = {
    send(tx: { from: string; to: string; data: string; chainId: string } & WalletFees, mode: { hold?: boolean; revert?: boolean } = {}): string {
      if (tx.from !== owner || tx.chainId !== profile.chainHex) throw new Error('MOCK_WRONG_SIGNER');
      counters.sends += 1;
      const queued = { hash: newHash(), from: owner, to: tx.to.toLowerCase(), input: tx.data.toLowerCase(), fees: tx,
        nonce: (state.nonces[owner] ?? 0n) + BigInt(pendingTxs.length) };
      if (mode.hold) { pendingTxs.push(queued); return queued.hash; }
      mine([queued], mode); return queued.hash;
    },
    /** The same wallet request fulfilled by MetaMask as a relayed type-2, depth-1 redemption (owner nonce unchanged). */
    sendDelegated(tx: { from: string; to: string; data: string; chainId: string }, mode: { hold?: boolean; preconfirmedReads?: number } = {}): string {
      if (tx.from !== owner || tx.chainId !== profile.chainHex || !options.delegatedOwner) throw new Error('MOCK_WRONG_SIGNER');
      counters.sends += 1;
      const inner = { to: tx.to.toLowerCase(), input: tx.data.toLowerCase() };
      const queued = { hash: newHash(), from: UNI_RELAYER, to: UNI_DELEGATION_MANAGER, input: encodeSingleRedemption('0x' + 'ab'.repeat(96), inner.to, inner.input),
        nonce: (state.nonces[UNI_RELAYER] ?? 0n) + BigInt(pendingTxs.filter(p => p.from === UNI_RELAYER).length), inner };
      if (mode.hold) { pendingTxs.push(queued); return queued.hash; }
      mine([queued]);
      if (mode.preconfirmedReads) preconfirmed.set(queued.hash, mode.preconfirmedReads);
      return queued.hash;
    },
    /** Mine every held transaction (optionally replacing one by a same-call speed-up or a cancellation). */
    release(change?: { kind: 'SPEED_UP' | 'CANCEL'; hash: string }): string | null {
      let replacement: string | null = null;
      const txs = pendingTxs.splice(0).map(p => {
        if (change?.hash !== p.hash) return p;
        replacement = newHash();
        return change.kind === 'SPEED_UP' ? { ...p, hash: replacement } : { ...p, hash: replacement, to: owner, input: '0x' };
      });
      mine(txs); return replacement;
    },
  };
  return { rpc, wallet, owner, counters, mined, catalogPins,
    /** The L1 base fee / blob base fee moved: the oracle's current bound and (optionally) the fee charged at inclusion change. */
    setL1Fee(change: { estimate?: bigint; charged?: bigint }) { Object.assign(l1, change); },
    /** A Stock Token's issuer changes its multiplier state (a corporate action). */
    setStock(address: string, patch: Partial<{ uid: string; multiplierWad: bigint; scheduledWad: bigint; effectiveAt: number }>) { Object.assign(stocks.get(address)!, patch); },
    /** Wall clock aligned with the chain head (the service rejects stale or future heads). */
    clock: () => new Date(timestamp * 1000 + 1_000),
    /** Another market participant moves the pool price (a swap): `ticks` up or down. */
    movePrice(ticks: number) { state.tick += ticks; state.sqrtPriceX96 = sqrtRatioAtTick(state.tick) + 1n; head += 1; timestamp += 2; history.set(head, clone(state)); },
    advance(seconds: number) { const blocksAhead = Math.max(1, Math.floor(seconds / 2)); head += blocksAhead; timestamp += seconds; history.set(head, clone(state)); },
    /**
     * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a position that exists on chain without FloFi (opened in another interface), funded by the pool.
     * Returns its token id.
     */
    seedPosition(input: { owner?: string; tickLower: number; tickUpper: number; liquidity: bigint; owed0?: bigint; owed1?: bigint }): string {
      const tokenId = (nextTokenId++).toString();
      state.owners[tokenId] = (input.owner ?? owner).toLowerCase();
      state.positions[tokenId] = { liquidity: input.liquidity, tickLower: input.tickLower, tickUpper: input.tickUpper, owed0: input.owed0 ?? 0n, owed1: input.owed1 ?? 0n,
        pending0: 0n, pending1: 0n };
      // The pool holds the position's principal (at any price inside or around the range) and what it already owes.
      const reserve = uniswapAmountsForLiquidity(sqrtRatioAtTick(input.tickLower), input.tickLower, input.tickUpper, input.liquidity).amount0;
      const reserve1 = uniswapAmountsForLiquidity(sqrtRatioAtTick(input.tickUpper), input.tickLower, input.tickUpper, input.liquidity).amount1;
      state.balances[t0]![POOL] = (state.balances[t0]![POOL] ?? 0n) + reserve + (input.owed0 ?? 0n);
      state.balances[t1]![POOL] = (state.balances[t1]![POOL] ?? 0n) + reserve1 + (input.owed1 ?? 0n);
      head += 1; timestamp += 2; history.set(head, clone(state));
      return tokenId;
    },
    /** Swaps through the pool accrue fees to a position that `positions()` does not show until a poke (collect or decrease). */
    accrueFees(tokenId: string, fee0: bigint, fee1: bigint) {
      const p = state.positions[tokenId]!;
      p.pending0 += fee0; p.pending1 += fee1;
      state.balances[t0]![POOL] = (state.balances[t0]![POOL] ?? 0n) + fee0; state.balances[t1]![POOL] = (state.balances[t1]![POOL] ?? 0n) + fee1;
      head += 1; timestamp += 2; history.set(head, clone(state));
    },
    /** The NFT moves to another wallet outside FloFi. */
    transferPosition(tokenId: string, to: string) { state.owners[tokenId] = to.toLowerCase(); head += 1; timestamp += 2; history.set(head, clone(state)); },
    /** The owner approves outside Flofi. */
    externalAllowance(token: 'token0' | 'token1', amount: bigint) { state.allowances[allowanceKey(token === 'token0' ? t0 : t1, owner, NPM)] = amount; history.set(head, clone(state)); },
    get snapshot() { return state; } };
}
export type UniswapLiquidityChain = ReturnType<typeof createUniswapLiquidityChain>;
