// SPDX-License-Identifier: AGPL-3.0-only
import { CONCENTRATED_LIQUIDITY_ACTION, createConcentratedLiquidityNode, readConcentratedLiquidity, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { formatAssetAmount, parseAssetAmount, robinhoodLiquidityPool, UNISWAP_V3_ROBINHOOD, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { validateUniswapLiquidityNode } from '@defi-workflow-engine/reference-linter';
import { uniswapQuotePriceAtTick } from '@defi-workflow-engine/reference-compiler';
import { resolveNetworkAsset, ROBINHOOD_CHAIN, ROBINHOOD_NETWORK } from './asset-catalogs';

/**
 * BUILD-RH-002: Robinhood Chain concentrated liquidity through Uniswap v3 — any two official catalog ERC-20s (USDG, WETH, Stock Tokens)
 * at a standard fee tier, authored as the same canonical `asset.liquidity.concentrated` node as the testnet pools. The pool is the
 * CREATE2 pool of the pinned factory for that pair and tier; Simulate verifies both identities against the official registry and the
 * chain (Stock Token beacon, uid and multiplier) and that the pool is live. Real funds: the owner's wallet signs every request.
 */
type Node = SemanticWorkflow['nodes'][number];
export const ROBINHOOD_LIQUIDITY_FEE_TIERS: readonly number[] = Object.freeze(UNISWAP_V3_ROBINHOOD.feeTiers.map(tier => tier.fee));
/** 0.3%, the tier of the live Stock Token / USDG pools observed at discovery; the owner may name another. */
export const ROBINHOOD_LIQUIDITY_DEFAULT_FEE = 3000;
export const ROBINHOOD_LIQUIDITY_DEFAULT_SLIPPAGE = '100';
export type RobinhoodLiquidityInput = { readonly network: typeof ROBINHOOD_NETWORK; readonly tokenA: string; readonly tokenB: string;
  /** Maximum deposits in whole units of each token ('0' = one-sided). */ readonly amountA: string; readonly amountB: string; readonly fee: number;
  /** `FULL`: the widest usable range of the fee tier; `TICK`: explicit ticks on its spacing. */ readonly rangeUnit: 'FULL' | 'TICK';
  readonly lower?: string; readonly upper?: string; readonly slippage: string };
const MAX_TICK = 887_272;
const spacingOf = (fee: number) => UNISWAP_V3_ROBINHOOD.feeTiers.find(tier => tier.fee === fee)?.tickSpacing ?? null;
/** The widest usable range of a fee tier (±887,220 at 0.3%). */
export function robinhoodFullRange(fee: number): { tickLower: number; tickUpper: number } {
  const spacing = spacingOf(fee);
  if (!spacing) throw new Error('UNISWAP_FEE_TIER_UNSUPPORTED');
  const usable = MAX_TICK - MAX_TICK % spacing;
  return { tickLower: -usable, tickUpper: usable };
}
const erc20 = (symbol: string): CanonicalAsset => {
  const asset = resolveNetworkAsset(ROBINHOOD_CHAIN, { symbol });
  if (!asset) throw new Error('ASSET_CATALOG_UNAVAILABLE');
  if (asset.kind !== 'ERC20' || !asset.address) throw new Error('UNISWAP_TOKEN_UNSUPPORTED');
  return asset;
};
const units = (text: string, decimals: number) => {
  const trimmed = text.trim();
  if (trimmed === '0') return '0';
  try { return parseAssetAmount(trimmed, decimals); } catch { throw new Error('AMOUNT_OUT_OF_RANGE'); }
};
export function createRobinhoodLiquidityNode(nodeId: string, input: RobinhoodLiquidityInput): Node {
  if (input.network !== ROBINHOOD_NETWORK) throw new Error('UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED');
  const a = erc20(input.tokenA), b = erc20(input.tokenB);
  if (a.address === b.address) throw new Error('INVALID_ASSET_PAIR');
  const pool = robinhoodLiquidityPool({ symbol: a.symbol, address: a.address!, decimals: a.decimals }, { symbol: b.symbol, address: b.address!, decimals: b.decimals }, input.fee);
  if (!/^[1-9][0-9]{0,3}$/.test(input.slippage) || Number(input.slippage) > pool.maximumSlippageBps) throw new Error('UNISWAP_SLIPPAGE_OUT_OF_RANGE');
  const amountA = units(input.amountA, a.decimals), amountB = units(input.amountB, b.decimals);
  if (amountA === '0' && amountB === '0') throw new Error('UNISWAP_LIQUIDITY_ZERO');
  const aFirst = pool.token0.address === a.address;
  let range: { tickLower: number; tickUpper: number };
  if (input.rangeUnit === 'FULL') range = robinhoodFullRange(input.fee);
  else {
    const lower = input.lower?.trim() ?? '', upper = input.upper?.trim() ?? '';
    if (input.rangeUnit !== 'TICK' || !/^-?(0|[1-9][0-9]{0,5})$/.test(lower) || !/^-?(0|[1-9][0-9]{0,5})$/.test(upper)) throw new Error('UNISWAP_LIQUIDITY_RANGE_INVALID');
    range = { tickLower: Number(lower), tickUpper: Number(upper) };
    if (range.tickLower >= range.tickUpper || range.tickLower % pool.tickSpacing || range.tickUpper % pool.tickSpacing) throw new Error('UNISWAP_LIQUIDITY_RANGE_INVALID');
  }
  const token = (t: typeof pool.token0) => ({ chainId: pool.chain, address: t.address, decimals: t.decimals });
  const node = createConcentratedLiquidityNode(nodeId, { chain: pool.chain, token0: token(pool.token0), token1: token(pool.token1),
    amount0Max: aFirst ? amountA : amountB, amount1Max: aFirst ? amountB : amountA, amount0Min: '0', amount1Min: '0', ...range, feeTier: input.fee,
    slippageBps: Number(input.slippage), protocols: [pool.protocol], recipient: null, positionAsset: { chainId: pool.chain, address: pool.positionManager, decimals: 0 } });
  validateUniswapLiquidityNode(node);
  return node;
}
export type RobinhoodLiquidityDetails = { readonly network: typeof ROBINHOOD_NETWORK; readonly tokenA: string; readonly tokenB: string;
  readonly amountA: string; readonly amountB: string; readonly fee: number; readonly tickLower: number; readonly tickUpper: number; readonly fullRange: boolean;
  /** token0 per token1 at the range edges (the LOWER price comes from tickUpper), and the pair that price is quoted in. */
  readonly lowerPrice: string; readonly upperPrice: string; readonly priceUnit: string;
  readonly slippage: string; readonly provider: 'Uniswap v3'; readonly pool: string };
/** The side shown first: a base asset (USDG, then WETH) against a Stock Token, otherwise pool order. */
const BASE_FIRST = ['USDG', 'WETH'];
/** Presentation only. A token the current catalog no longer resolves keeps a neutral label rather than a guessed symbol. */
export function robinhoodLiquidityDetails(node: Node | { readonly actionType: string; readonly chainId: string }): RobinhoodLiquidityDetails | null {
  if (node.actionType !== CONCENTRATED_LIQUIDITY_ACTION || node.chainId !== ROBINHOOD_CHAIN) return null;
  try {
    const f = readConcentratedLiquidity(node as Node);
    const symbolOf = (address: string) => resolveNetworkAsset(ROBINHOOD_CHAIN, { address })?.symbol ?? 'Token';
    const s0 = symbolOf(f.token0.address), s1 = symbolOf(f.token1.address);
    const a0 = formatAssetAmount(f.amount0Max, f.token0.decimals), a1 = formatAssetAmount(f.amount1Max, f.token1.decimals);
    const zeroFirst = BASE_FIRST.indexOf(s1) < 0 ? true : BASE_FIRST.indexOf(s0) < 0 ? false : BASE_FIRST.indexOf(s0) <= BASE_FIRST.indexOf(s1);
    const full = robinhoodFullRange(f.feeTier);
    const pool = robinhoodLiquidityPool({ symbol: s0, ...f.token0 }, { symbol: s1, ...f.token1 }, f.feeTier);
    return { network: ROBINHOOD_NETWORK, tokenA: zeroFirst ? s0 : s1, tokenB: zeroFirst ? s1 : s0, amountA: zeroFirst ? a0 : a1, amountB: zeroFirst ? a1 : a0,
      fee: f.feeTier, tickLower: f.tickLower, tickUpper: f.tickUpper, fullRange: f.tickLower === full.tickLower && f.tickUpper === full.tickUpper,
      lowerPrice: uniswapQuotePriceAtTick(f.tickUpper, f.token0.decimals, f.token1.decimals, 8), upperPrice: uniswapQuotePriceAtTick(f.tickLower, f.token0.decimals, f.token1.decimals, 8),
      priceUnit: `${s0} per ${s1}`, slippage: String(f.slippageBps ?? ''), provider: 'Uniswap v3', pool: pool.pool };
  } catch { return null; }
}
/** Editing input that reproduces the node exactly. */
export function robinhoodLiquidityInputOf(details: RobinhoodLiquidityDetails): RobinhoodLiquidityInput {
  return { network: ROBINHOOD_NETWORK, tokenA: details.tokenA, tokenB: details.tokenB, amountA: details.amountA, amountB: details.amountB, fee: details.fee,
    ...details.fullRange ? { rangeUnit: 'FULL' as const } : { rangeUnit: 'TICK' as const, lower: String(details.tickLower), upper: String(details.tickUpper) }, slippage: details.slippage };
}
const N = '([0-9]+(?:\\.[0-9]+)?)', SYMBOL = '([A-Za-z][A-Za-z0-9.]{0,15})';
export const ROBINHOOD_LIQUIDITY_PATTERN = new RegExp(`^(?:add|provide|create) (?:uniswap )?liquidity (?:with )?${N} ${SYMBOL} and ${N} ${SYMBOL} on Robinhood(?: Chain)?` +
  `(?: (?:fee|at) (0\\.01|0\\.05|0\\.3|1)%)?(?: (?:full range|ticks (-?[0-9]+) to (-?[0-9]+)))?(?: (?:with )?slippage ([0-9]+) bps)?$`, 'i');
const FEE_BY_PERCENT: Readonly<Record<string, number>> = { '0.01': 100, '0.05': 500, '0.3': 3000, '1': 10000 };
/** "Add liquidity 100 USDG and 0.4 TSLA on Robinhood [fee 0.3%] [full range | ticks -887220 to 887220] [slippage 100 bps]". */
export function parseRobinhoodLiquidityChat(text: string): RobinhoodLiquidityInput | null {
  const m = ROBINHOOD_LIQUIDITY_PATTERN.exec(text.trim());
  if (!m) return null;
  const ticks = m[6] !== undefined;
  return { network: ROBINHOOD_NETWORK, amountA: m[1]!, tokenA: m[2]!.toUpperCase(), amountB: m[3]!, tokenB: m[4]!.toUpperCase(),
    fee: m[5] ? FEE_BY_PERCENT[m[5]]! : ROBINHOOD_LIQUIDITY_DEFAULT_FEE, rangeUnit: ticks ? 'TICK' : 'FULL', ...ticks ? { lower: m[6]!, upper: m[7]! } : {},
    slippage: m[8] ?? ROBINHOOD_LIQUIDITY_DEFAULT_SLIPPAGE };
}
