// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-P1 pool conversational reliability: the pool facts a conversational liquidity range is computed from, and the deterministic conversion of
 * a percentage or a price range into the ticks the IR stores. Pure: no network, no wallet. The surface reads a pool's price through its existing
 * read-only service (Orca SOL/USDC on Solana mainnet-beta, a catalog network's Uniswap v3 pool) and hands the result to the engine with the time it
 * was read; nothing here invents, caches or estimates a price. The model never supplies a price or a tick: it only reports the user's words.
 */
import { catalogPoolOn, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY, type UniswapPoolProfile } from '@defi-workflow-engine/action-registry';
import { orcaPriceFromSqrtPrice, orcaSqrtPriceAtTick, uniswapAlignPriceRange, uniswapBandAroundSqrtPriceIn, uniswapPriceAtSqrt, uniswapPriceAtTick,
  type UniswapPriceOrientation } from '@defi-workflow-engine/reference-compiler';
import { priceBoundsAround, validPoolPrice } from './pool-price-bounds';
import { solanaLiquidityTicks } from './solana-liquidity-authoring';

/** Which pool a price is needed for: the identity the surface reads (and the engine checks again before using the answer). */
export type PoolRef =
  | { readonly kind: 'ORCA'; readonly network: 'SOLANA'; readonly pool: string }
  | { readonly kind: 'UNISWAP_V3'; readonly chain: string; readonly pool: string; readonly tokenA: string; readonly tokenB: string; readonly fee: number };
/**
 * One read of a pool, as the surface reports it: `at` is the Solana slot or EVM block it was read at, `readAt` when (epoch ms). A failed read
 * keeps its closed code, so FloFi can say what could not be confirmed. Orca reports its verified price (USDC per SOL, as the Canvas uses it);
 * Uniswap its raw Q96 square-root price. `tick` is the pool's current tick.
 */
export type PoolPriceRead = { readonly ref: PoolRef; readonly readAt: number } & (
  | { readonly ok: true; readonly tick: number; readonly at: number; readonly price?: string; readonly sqrtPrice?: string }
  | { readonly ok: false; readonly code: string });
type GoodRead = Extract<PoolPriceRead, { ok: true }>;
/** A price older than this is not used: the surface reads it again for the turn that needs it. */
export const POOL_PRICE_MAX_AGE_MS = 120_000;
export const ORCA_MAINNET_POOL: PoolRef = Object.freeze({ kind: 'ORCA', network: 'SOLANA', pool: ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY.pool.address });
export const poolRefKey = (ref: PoolRef): string => ref.kind === 'ORCA' ? `orca:${ref.network}:${ref.pool}` : `uniswap-v3:${ref.chain}:${ref.pool}:${ref.fee}`;
/** The newest read of exactly this pool that is still fresh at `now`, or null. A read from the future (a skewed clock) is not trusted. */
export function poolReadFor(ref: PoolRef, reads: readonly PoolPriceRead[] | undefined, now: number): PoolPriceRead | null {
  const key = poolRefKey(ref);
  const fresh = (reads ?? []).filter(read => poolRefKey(read.ref) === key && read.readAt <= now + 5_000 && now - read.readAt <= POOL_PRICE_MAX_AGE_MS);
  const read = fresh.sort((a, b) => b.readAt - a.readAt)[0] ?? null;
  // A read reported as successful but without a usable price is a failed read (never a partial one).
  return read?.ok && !usable(read) ? { ref: read.ref, readAt: read.readAt, ok: false, code: 'COPILOT_POOL_READ_INVALID' } : read;
}
function usable(read: GoodRead): boolean {
  if (!Number.isSafeInteger(read.tick) || !Number.isSafeInteger(read.at)) return false;
  return read.ref.kind === 'ORCA' ? typeof read.price === 'string' && validPoolPrice(read.price) : typeof read.sqrtPrice === 'string' && /^[1-9][0-9]{0,48}$/.test(read.sqrtPrice);
}
/** Codes of a read that found no usable pool (as opposed to a price that could not be read right now). */
const POOL_MISSING = /^(?:UNISWAP_POOL_MISMATCH|UNISWAP_CONTRACT_CODE_MISSING|UNISWAP_POOL_UNINITIALIZED|UNISWAP_UNEXPECTED_CONTRACT|UNISWAP_FEE_TIER_UNSUPPORTED|ORCA_POOL_INVALID|ORCA_LIQUIDITY_POOL_INVALID)$/;
export const poolMissing = (code: string): boolean => POOL_MISSING.test(code);

/** Where the current pool price sits relative to a range, as a person reads it (prices rise to the right). */
export type RangePosition = 'BELOW' | 'INSIDE' | 'ABOVE';
/** A range ready for the exact grammar, with what the person should see before approving it. */
export type ResolvedRange = { readonly tickLower: number; readonly tickUpper: number;
  /** The effective prices of the aligned ticks (quote per base), and the reference price the range was computed from, if one was read. */
  readonly lowerPrice: string; readonly upperPrice: string; readonly reference: string | null; readonly position: RangePosition | null;
  /** The token the position would hold alone when the current price is outside the range. */ readonly onlyToken: string | null;
  /** Catalog pools read the other way round than Review: the same ticks priced in the pool's order (token0 per token1), as Review shows them. */
  readonly poolOrder?: { readonly lowerPrice: string; readonly upperPrice: string; readonly unit: string } };

// ── Orca SOL/USDC (Solana mainnet-beta) ─────────────────────────────────────────────────────────────────────────────────────────────
const orca = ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY;
const orcaPrice = (tick: number) => orcaPriceFromSqrtPrice(orcaSqrtPriceAtTick(tick), orca.token0.decimals, orca.token1.decimals);
/** The verified Orca mainnet price (USDC per SOL) of a read; a read without a valid price is unusable. */
export function orcaReadPrice(read: GoodRead): string {
  if (!read.price || !validPoolPrice(read.price) || !Number.isSafeInteger(read.tick)) throw new Error('COPILOT_POOL_PRICE_UNAVAILABLE');
  return read.price;
}
/** Orca's own tick rule: a current tick below tickLower holds only SOL (price below the range); at or above tickUpper only USDC. */
function orcaPosition(read: GoodRead | null, tickLower: number, tickUpper: number) {
  if (!read) return { position: null, onlyToken: null };
  const position: RangePosition = read.tick < tickLower ? 'BELOW' : read.tick >= tickUpper ? 'ABOVE' : 'INSIDE';
  return { position, onlyToken: position === 'BELOW' ? orca.token0.symbol : position === 'ABOVE' ? orca.token1.symbol : null };
}
/**
 * ±`percent` around the verified Orca mainnet price — exactly the Canvas range control (`priceBoundsAround`), so Chat and Canvas author the same
 * `PRICE` bounds and therefore the same aligned ticks. Throws a closed code for an invalid percentage or price.
 */
export function orcaPercentRange(read: GoodRead, percent: string): ResolvedRange & { readonly lower: string; readonly upper: string } {
  const value = percentValue(percent), price = orcaReadPrice(read);
  const bounds = priceBoundsAround(price, -value, value);
  return { ...orcaPriceRange(bounds.lower, bounds.upper, read), lower: bounds.lower, upper: bounds.upper, reference: price };
}
/** An explicit USDC-per-SOL range on the mainnet pool, aligned outward exactly as the exact grammar will align it. */
export function orcaPriceRange(lower: string, upper: string, read: GoodRead | null): ResolvedRange {
  let ticks: { tickLower: number; tickUpper: number };
  try { ticks = solanaLiquidityTicks({ rangeUnit: 'PRICE', lower, upper, network: 'Solana' }); } catch { throw new Error('COPILOT_RANGE_CONVERSION_INVALID'); }
  return { ...ticks, lowerPrice: orcaPrice(ticks.tickLower), upperPrice: orcaPrice(ticks.tickUpper), reference: read ? orcaReadPrice(read) : null,
    ...orcaPosition(read, ticks.tickLower, ticks.tickUpper) };
}
/** Explicit Orca ticks (already validated by the authoring) with their prices and position. */
export function orcaTickRange(tickLower: number, tickUpper: number, read: GoodRead | null): ResolvedRange {
  return { tickLower, tickUpper, lowerPrice: orcaPrice(tickLower), upperPrice: orcaPrice(tickUpper), reference: read ? orcaReadPrice(read) : null,
    ...orcaPosition(read, tickLower, tickUpper) };
}

// ── Uniswap v3 on a catalog network (Base, Arbitrum One, Ethereum, Robinhood Chain) ─────────────────────────────────────────────────────
type PoolToken = { readonly symbol: string; readonly address: string; readonly decimals: number };
/**
 * A catalog pool as the conversation shows it: its registry profile (pool address, token order, tick spacing) and the direction its price is read
 * in — the other token priced in a US-dollar stablecoin when exactly one side is one (USDC per WETH), otherwise the pool's own order
 * (token0 per token1, as Review shows it).
 */
export type CatalogPoolView = { readonly profile: UniswapPoolProfile; readonly orientation: UniswapPriceOrientation; readonly quote: string; readonly base: string;
  readonly ref: Extract<PoolRef, { kind: 'UNISWAP_V3' }> };
const USD_STABLE = new Set(['USDC', 'USDT', 'USDG', 'DAI', 'USDBC', 'USDS', 'PYUSD', 'USDC.E', 'USDT0']);
export function catalogPoolView(chain: string, tokenA: PoolToken, tokenB: PoolToken, fee: number): CatalogPoolView {
  const profile = catalogPoolOn(chain, tokenA, tokenB, fee);
  const stable0 = USD_STABLE.has(profile.token0.symbol.toUpperCase()), stable1 = USD_STABLE.has(profile.token1.symbol.toUpperCase());
  const orientation: UniswapPriceOrientation = stable1 && !stable0 ? 'TOKEN1_PER_TOKEN0' : 'TOKEN0_PER_TOKEN1';
  const [quote, base] = orientation === 'TOKEN1_PER_TOKEN0' ? [profile.token1.symbol, profile.token0.symbol] : [profile.token0.symbol, profile.token1.symbol];
  return { profile, orientation, quote, base,
    ref: { kind: 'UNISWAP_V3', chain: profile.chain, pool: profile.pool, tokenA: tokenA.address.toLowerCase(), tokenB: tokenB.address.toLowerCase(), fee: profile.feeTier } };
}
const priceAt = (view: CatalogPoolView, tick: number) => uniswapPriceAtTick(tick, view.profile.token0.decimals, view.profile.token1.decimals, view.orientation);
/** The person's lower and upper price of a tick range: in token0-per-token1 a higher tick is a lower price. */
function catalogBounds(view: CatalogPoolView, tickLower: number, tickUpper: number) {
  return view.orientation === 'TOKEN1_PER_TOKEN0' ? { lowerPrice: priceAt(view, tickLower), upperPrice: priceAt(view, tickUpper) }
    : { lowerPrice: priceAt(view, tickUpper), upperPrice: priceAt(view, tickLower) };
}
/** The same ticks in the pool's own order (token0 per token1), when the person reads the price the other way round. */
function poolOrder(view: CatalogPoolView, tickLower: number, tickUpper: number) {
  if (view.orientation === 'TOKEN0_PER_TOKEN1') return {};
  const { profile } = view, at = (tick: number) => uniswapPriceAtTick(tick, profile.token0.decimals, profile.token1.decimals, 'TOKEN0_PER_TOKEN1');
  return { poolOrder: { lowerPrice: at(tickUpper), upperPrice: at(tickLower), unit: `${profile.token0.symbol} per ${profile.token1.symbol}` } };
}
/** Uniswap's own tick rule (tick < tickLower → token0 only; tick ≥ tickUpper → token1 only), told in the person's price direction. */
function catalogPosition(view: CatalogPoolView, read: GoodRead | null, tickLower: number, tickUpper: number) {
  if (!read) return { position: null, onlyToken: null };
  const side = read.tick < tickLower ? 'TOKEN0' : read.tick >= tickUpper ? 'TOKEN1' : null;
  if (!side) return { position: 'INSIDE' as const, onlyToken: null };
  const rising = view.orientation === 'TOKEN1_PER_TOKEN0';
  const position: RangePosition = side === 'TOKEN0' ? rising ? 'BELOW' : 'ABOVE' : rising ? 'ABOVE' : 'BELOW';
  return { position, onlyToken: side === 'TOKEN0' ? view.profile.token0.symbol : view.profile.token1.symbol };
}
/** The raw Q96 square-root price of a Uniswap read; a read without one is unusable. */
function sqrtOf(read: GoodRead): bigint {
  if (!read.sqrtPrice || !/^[1-9][0-9]{0,48}$/.test(read.sqrtPrice) || !Number.isSafeInteger(read.tick)) throw new Error('COPILOT_POOL_PRICE_UNAVAILABLE');
  return BigInt(read.sqrtPrice);
}
const catalogReference = (view: CatalogPoolView, read: GoodRead | null) => read
  ? uniswapPriceAtSqrt(sqrtOf(read), view.profile.token0.decimals, view.profile.token1.decimals, view.orientation) : null;
const conversion = <T>(run: () => T): T => { try { return run(); } catch { throw new Error('COPILOT_RANGE_CONVERSION_INVALID'); } };
/** ±`percent` around the pool's verified price, in the person's price direction, aligned outward to the pool's tick spacing. */
export function catalogPercentRange(view: CatalogPoolView, read: GoodRead, percent: string): ResolvedRange {
  const bps = Math.round(percentValue(percent) * 100);
  const ticks = conversion(() => uniswapBandAroundSqrtPriceIn(sqrtOf(read), bps, view.profile.tickSpacing, view.orientation));
  return { ...ticks, ...catalogBounds(view, ticks.tickLower, ticks.tickUpper), reference: catalogReference(view, read), ...catalogPosition(view, read, ticks.tickLower, ticks.tickUpper),
    ...poolOrder(view, ticks.tickLower, ticks.tickUpper) };
}
/** An explicit price range (quote per base), aligned outward to the pool's tick spacing. */
export function catalogPriceRange(view: CatalogPoolView, lower: string, upper: string, read: GoodRead | null): ResolvedRange {
  const ticks = conversion(() => uniswapAlignPriceRange(lower, upper, view.profile.token0.decimals, view.profile.token1.decimals, view.profile.tickSpacing, view.orientation));
  return { ...ticks, ...catalogBounds(view, ticks.tickLower, ticks.tickUpper), reference: catalogReference(view, read), ...catalogPosition(view, read, ticks.tickLower, ticks.tickUpper),
    ...poolOrder(view, ticks.tickLower, ticks.tickUpper) };
}
/** Explicit ticks (validated by the authoring) with their prices and position. */
export function catalogTickRange(view: CatalogPoolView, tickLower: number, tickUpper: number, read: GoodRead | null): ResolvedRange {
  return { tickLower, tickUpper, ...conversion(() => catalogBounds(view, tickLower, tickUpper)), reference: catalogReference(view, read),
    ...catalogPosition(view, read, tickLower, tickUpper), ...conversion(() => poolOrder(view, tickLower, tickUpper)) };
}

/** A percentage of the conversational grammar: 0.01–90 with at most two decimals (the Canvas control's bounds). */
export function percentValue(percent: string): number {
  if (!/^(?:0|[1-9][0-9]?)(?:\.[0-9]{1,2})?$/.test(percent)) throw new Error('COPILOT_RANGE_OUT_OF_RANGE');
  const value = Number(percent), bps = Math.round(value * 100);
  if (!Number.isFinite(value) || bps < 1 || bps > 9_000) throw new Error('COPILOT_RANGE_OUT_OF_RANGE');
  return value;
}
