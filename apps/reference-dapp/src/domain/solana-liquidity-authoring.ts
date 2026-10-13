// SPDX-License-Identifier: AGPL-3.0-only
import { CONCENTRATED_LIQUIDITY_ACTION, createConcentratedLiquidityNode, readConcentratedLiquidity, readConcentratedLiquiditySource, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY as profile, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY, orcaLiquidityProfile, type OrcaLiquidityProfile } from '@defi-workflow-engine/action-registry';
import { orcaAlignPriceRange, orcaPriceFromSqrtPrice, orcaSqrtPriceAtTick } from '@defi-workflow-engine/reference-compiler';
import { formatTokenAmount, parseTokenAmount, type SolanaSwapInput } from './jupiter-authoring';

/**
 * Chat and canvas author the same canonical `asset.liquidity.concentrated` node. The network selects the runtime below
 * the IR: Solana Devnet → Orca Whirlpools (the verified SOL/devUSDC test pool); Solana (mainnet-beta, BUILD-SOLANA-MAINNET-001) → the verified
 * Orca SOL/USDC 0.30% pool (real funds). A price range is aligned to usable ticks deterministically (lower bound down, upper bound up), so the
 * IR always stores immutable ticks.
 */
export type SolanaLiquidityNetwork = 'Solana Devnet' | 'Solana';
/** `maxDevUsdc` is the pool's token B maximum: devUSDC on Solana Devnet, USDC on Solana mainnet-beta. */
export type SolanaLiquidityInput = { network: SolanaLiquidityNetwork; maxSol: string; maxDevUsdc: string;
  /** Prices in token B per SOL (`PRICE`) or tick indexes (`TICK`). */
  rangeUnit: 'PRICE' | 'TICK'; lower: string; upper: string; slippage: string };
export const SOLANA_LIQUIDITY_DEFAULT_SLIPPAGE = '100';
/** The Orca liquidity profile of a Solana liquidity network. */
export const solanaLiquidityProfileOf = (network: SolanaLiquidityNetwork): OrcaLiquidityProfile => network === 'Solana' ? ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY : profile;
const amount = (text: string, decimals: number) => text === '0' ? '0' : parseTokenAmount(text, decimals);
export function solanaLiquidityTicks(input: Pick<SolanaLiquidityInput, 'rangeUnit' | 'lower' | 'upper'> & { network?: SolanaLiquidityNetwork }): { tickLower: number; tickUpper: number } {
  const runtime = solanaLiquidityProfileOf(input.network ?? 'Solana Devnet');
  if (input.rangeUnit === 'PRICE') return orcaAlignPriceRange(input.lower.trim(), input.upper.trim(), runtime.pool.tickSpacing, runtime.token0.decimals, runtime.token1.decimals);
  if (!/^-?(0|[1-9][0-9]{0,5})$/.test(input.lower.trim()) || !/^-?(0|[1-9][0-9]{0,5})$/.test(input.upper.trim())) throw new Error('SOLANA_LIQUIDITY_RANGE_INVALID');
  const tickLower = Number(input.lower.trim()), tickUpper = Number(input.upper.trim());
  if (tickLower >= tickUpper || tickLower % runtime.pool.tickSpacing || tickUpper % runtime.pool.tickSpacing) throw new Error('SOLANA_LIQUIDITY_RANGE_INVALID');
  return { tickLower, tickUpper };
}
export function createSolanaLiquidityNode(nodeId: string, input: SolanaLiquidityInput): SemanticWorkflow['nodes'][number] {
  if (input.network !== 'Solana Devnet' && input.network !== 'Solana') throw new Error('SOLANA_CLUSTER_UNSUPPORTED');
  const runtime = solanaLiquidityProfileOf(input.network);
  if (!/^[1-9][0-9]{0,3}$/.test(input.slippage) || Number(input.slippage) > runtime.maximumSlippageBps) throw new Error('SOLANA_SLIPPAGE_OUT_OF_RANGE');
  const amount0Max = amount(input.maxSol, runtime.token0.decimals), amount1Max = amount(input.maxDevUsdc, runtime.token1.decimals);
  if (amount0Max === '0' && amount1Max === '0') throw new Error('SOLANA_LIQUIDITY_ZERO');
  if (BigInt(amount0Max) > BigInt(runtime.token0.maximumAmount) || BigInt(amount1Max) > BigInt(runtime.token1.maximumAmount)) throw new Error('AMOUNT_OUT_OF_RANGE');
  const { tickLower, tickUpper } = solanaLiquidityTicks(input);
  const token = (t: OrcaLiquidityProfile['token0']) => ({ chainId: runtime.chain, address: t.mint, decimals: t.decimals });
  return createConcentratedLiquidityNode(nodeId, { chain: runtime.chain, token0: token(runtime.token0), token1: token(runtime.token1), amount0Max, amount1Max,
    amount0Min: '0', amount1Min: '0', tickLower, tickUpper, feeTier: runtime.feeTier, slippageBps: Number(input.slippage), protocols: [runtime.protocol], recipient: null,
    positionAsset: { chainId: runtime.chain, address: runtime.programs.whirlpool, decimals: 0 } });
}
export type SolanaLiquidityDetails = { network: SolanaLiquidityNetwork;
  /** The pool's token B symbol: devUSDC (Devnet) or USDC (mainnet-beta). */ tokenB: string; maxSol: string; maxDevUsdc: string; tickLower: number; tickUpper: number; lowerPrice: string;
  upperPrice: string; slippage: string; provider: string;
  /** Set when the position is bound to a swap's output: that token's maximum is the cap on the actual reconciled swap output. */
  source: { nodeId: string; token: 0 | 1; fullOutput: boolean } | null };
/** The bound token's cap that means "100% of the swap output": the Devnet token maximum (the swap output is the real limit). */
export const fullOutputCap = (token: 0 | 1) => formatTokenAmount(token === 0 ? profile.token0.maximumAmount : profile.token1.maximumAmount, token === 0 ? profile.token0.decimals : profile.token1.decimals);
export function solanaLiquidityDetails(node: SemanticWorkflow['nodes'][number] | { readonly actionType: string; readonly chainId: string }): SolanaLiquidityDetails | null {
  const runtime = orcaLiquidityProfile(node.chainId);
  if (node.actionType !== CONCENTRATED_LIQUIDITY_ACTION || !runtime) return null;
  try {
    // Display reads a bound position too (the runtime readers stay strict and reject it outside its composition).
    const { node: isolated, source } = readConcentratedLiquiditySource(node as SemanticWorkflow['nodes'][number]);
    const f = readConcentratedLiquidity(isolated);
    if (f.token0.address !== runtime.token0.mint || f.token1.address !== runtime.token1.mint || f.protocols.join() !== runtime.protocol) return null;
    const price = (tick: number) => orcaPriceFromSqrtPrice(orcaSqrtPriceAtTick(tick), runtime.token0.decimals, runtime.token1.decimals);
    return { network: runtime.network, tokenB: runtime.token1.symbol, maxSol: formatTokenAmount(f.amount0Max, runtime.token0.decimals), maxDevUsdc: formatTokenAmount(f.amount1Max, runtime.token1.decimals),
      tickLower: f.tickLower, tickUpper: f.tickUpper, lowerPrice: price(f.tickLower), upperPrice: price(f.tickUpper), slippage: String(f.slippageBps ?? ''),
      provider: runtime.providerLabel, source: source ? { nodeId: source.nodeId, token: source.token,
        fullOutput: (source.token === 0 ? f.amount0Max : f.amount1Max) === (source.token === 0 ? runtime.token0.maximumAmount : runtime.token1.maximumAmount) } : null };
  } catch { return null; }
}
/** Editing input that reproduces the node exactly (ticks are already aligned). */
export function solanaLiquidityInputOf(details: SolanaLiquidityDetails): SolanaLiquidityInput {
  return { network: details.network, maxSol: details.maxSol, maxDevUsdc: details.maxDevUsdc, rangeUnit: 'TICK', lower: String(details.tickLower), upper: String(details.tickUpper),
    slippage: details.slippage };
}
const N = '([0-9]+(?:\\.[0-9]+)?)', T = '(-?[0-9]+)';
export const SOLANA_LIQUIDITY_PATTERN = new RegExp(`^(?:add|provide|create) (?:orca )?liquidity (?:with )?${N} (?:test )?SOL and ${N} (?:test USDC|devUSDC|USDC) ` +
  `(?:from ${N} to ${N} devUSDC per SOL|ticks ${T} to ${T}) on Solana Devnet(?: (?:with )?slippage ([0-9]+) bps)?$`, 'i');
/** "Add liquidity 0.01 SOL and 0.30 devUSDC from 20.12 to 24.59 devUSDC per SOL on Solana Devnet [slippage 100 bps]". */
export function parseSolanaLiquidityChat(text: string): SolanaLiquidityInput | null {
  const match = SOLANA_LIQUIDITY_PATTERN.exec(text.trim());
  if (!match) return null;
  const price = match[3] !== undefined;
  return { network: 'Solana Devnet', maxSol: match[1]!, maxDevUsdc: match[2]!, rangeUnit: price ? 'PRICE' : 'TICK', lower: price ? match[3]! : match[5]!,
    upper: price ? match[4]! : match[6]!, slippage: match[7] ?? SOLANA_LIQUIDITY_DEFAULT_SLIPPAGE };
}

/**
 * The position funded by a Solana Devnet swap's output, as one sentence: a new swap ("swap 0.1 SOL to devUSDC on Solana Devnet slippage 50 bps then
 * add liquidity all swapped devUSDC and 0.05 SOL from 20.1 to 24.5 devUSDC per SOL slippage 100 bps") or an existing swap step ("add liquidity all
 * devUSDC from node-002 and 0.05 SOL … on Solana Devnet slippage 100 bps"). `all` is 100% of the actual reconciled output (the token's Devnet maximum
 * as the cap); a number caps it. The other token always has an explicit maximum. `bound` is the swapped token.
 */
export type SolanaCompositionChat = { swap: SolanaSwapInput | null; from: string | null; bound: 'SOL' | 'devUSDC'; liquidity: SolanaLiquidityInput };
const TOKEN = '(SOL|devUSDC)', CAP = '(all|[0-9]+(?:\\.[0-9]+)?)', RANGE = `(?:from ${N} to ${N} devUSDC per SOL|ticks ${T} to ${T})`;
const NEW_SWAP = new RegExp(`^swap ${N} ${TOKEN} to ${TOKEN} on Solana Devnet slippage ([0-9]+) bps then add liquidity ${CAP} swapped ${TOKEN} and ${N} ${TOKEN} ${RANGE}` +
  ` slippage ([0-9]+) bps$`, 'i');
const FROM_STEP = new RegExp(`^add liquidity ${CAP} ${TOKEN} from (node-[0-9]{3,16}) and ${N} ${TOKEN} ${RANGE} on Solana Devnet slippage ([0-9]+) bps$`, 'i');
const devnetToken = (text: string): 'SOL' | 'devUSDC' => text.toUpperCase() === 'SOL' ? 'SOL' : 'devUSDC';
export function parseSolanaCompositionChat(text: string): SolanaCompositionChat | null {
  const input = text.trim(), created = NEW_SWAP.exec(input), linked = created ? null : FROM_STEP.exec(input);
  if (!created && !linked) return null;
  // Groups after the swap: cap, bound token, other maximum, other token, price bounds or tick bounds, slippage.
  const g = created ? created.slice(5) : [linked![1], linked![2], linked![4], linked![5], ...linked!.slice(6)];
  const [cap, boundText, other, otherText, lowPrice, highPrice, lowTick, highTick, slippage] = g as string[];
  const bound = devnetToken(boundText!), otherToken = devnetToken(otherText!);
  if (bound === otherToken) throw new Error('INVALID_ASSET_PAIR');
  if (created && (devnetToken(created[2]!) === devnetToken(created[3]!) || devnetToken(created[3]!) !== bound)) throw new Error('COMPOSITION_TOKEN_MISMATCH');
  const boundMax = cap!.toLowerCase() === 'all' ? fullOutputCap(bound === 'SOL' ? 0 : 1) : cap!;
  const price = lowPrice !== undefined;
  const liquidity: SolanaLiquidityInput = { network: 'Solana Devnet', maxSol: bound === 'SOL' ? boundMax : other!, maxDevUsdc: bound === 'SOL' ? other! : boundMax,
    rangeUnit: price ? 'PRICE' : 'TICK', lower: price ? lowPrice! : lowTick!, upper: price ? highPrice! : highTick!, slippage: slippage! };
  const swap: SolanaSwapInput | null = created ? { network: 'Solana Devnet', from: devnetToken(created[2]!), to: devnetToken(created[3]!), amount: created[1]!, slippage: created[4]! } : null;
  return { swap, from: linked ? linked[3]! : null, bound, liquidity };
}
