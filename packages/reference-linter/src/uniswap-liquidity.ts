// SPDX-License-Identifier: AGPL-3.0-only
import { CONCENTRATED_LIQUIDITY_ACTION, createConcentratedLiquidityNode, readConcentratedLiquidity, type ConcentratedLiquidityFields,
  type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { catalogPoolOn, UNISWAP_V3_BASE_SEPOLIA_LIQUIDITY, uniswapCatalogDeployment, uniswapLiquidityProfile,
  type UniswapPoolProfile } from '@defi-workflow-engine/action-registry';

/** The position asset of a Uniswap v3 position: one ERC-721 unit issued by the profile's NonfungiblePositionManager. */
export const uniswapPositionAsset = (profile: Pick<UniswapPoolProfile, 'chain' | 'positionManager'>) => Object.freeze({ chainId: profile.chain, address: profile.positionManager, decimals: 0 });
/** Base Sepolia's position asset (unchanged export). */
export const UNISWAP_POSITION_ASSET = uniswapPositionAsset(UNISWAP_V3_BASE_SEPOLIA_LIQUIDITY);
/**
 * A concentrated-liquidity node on a chain with a Uniswap v3 runtime: a fixed testnet profile (Base Sepolia, BUILD-ETHEREUM-001 Ethereum
 * Sepolia) or a catalog network whose pool follows the node's pair and tier (BUILD-RH-002 Robinhood Chain, BUILD-BASE-001 Base).
 */
export const isUniswapLiquidityNode = (node: { actionType: string; chainId: string }) =>
  node.actionType === CONCENTRATED_LIQUIDITY_ACTION && (uniswapLiquidityProfile(node.chainId) !== null || uniswapCatalogDeployment(node.chainId) !== null);

const fail = (code: string): never => { throw new Error(code); };
const sorted = (v: unknown): string => JSON.stringify(v, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item);
// Usable ticks: MIN/MAX_TICK ±887,272 rounded inward to the profile's tick spacing (±887,270 at 10, ±887,220 at 60).
const MAX_TICK = 887_272;

/**
 * The canonical concentrated-liquidity action resolved against its public EVM runtime: Uniswap v3 on Base Sepolia (the
 * verified USDC/WETH 0.05% pool) or Ethereum Sepolia (USDC/WETH 0.3%), selected by the node's chain. token0/token1 MUST follow the pool's order (USDC < WETH by address), ticks must
 * be usable on the pool's tick spacing, maxima are capped, minimums stay 0 in the IR (the binding minimums are derived from the
 * simulation and the slippage limit at Review), and the position recipient is always the executing owner (`null`).
 * BUILD-RH-002: on Robinhood Chain (BUILD-BASE-001: and Base) the pool is the node's own pair (in pool order) and a standard fee tier — the
 * CREATE2 pool of that network's pinned factory; whether both tokens are catalog assets, and the pool live, is verified against the
 * catalog and chain at simulation.
 */
export function validateUniswapLiquidityNode(node: SemanticWorkflow['nodes'][number]): ConcentratedLiquidityFields {
  const fixed = node.actionType === CONCENTRATED_LIQUIDITY_ACTION ? uniswapLiquidityProfile(node.chainId) : null;
  if (!fixed && !(node.actionType === CONCENTRATED_LIQUIDITY_ACTION && uniswapCatalogDeployment(node.chainId) !== null)) return fail('UNISWAP_LIQUIDITY_ACTION_INVALID');
  let fields: ConcentratedLiquidityFields;
  try { fields = readConcentratedLiquidity(node); } catch { return fail('UNISWAP_LIQUIDITY_DECLARATION_INVALID'); }
  const profile: UniswapPoolProfile = fixed ?? catalogPoolOf(node.chainId, fields);
  const t0 = profile.token0, t1 = profile.token1, usable = MAX_TICK - MAX_TICK % profile.tickSpacing;
  if (fields.token0.address === t1.address && fields.token1.address === t0.address) fail('UNISWAP_TOKEN_ORDER_INVALID');
  if (fields.token0.address !== t0.address || fields.token1.address !== t1.address || fields.token0.decimals !== t0.decimals || fields.token1.decimals !== t1.decimals)
    fail('UNISWAP_TOKEN_UNSUPPORTED');
  if (fields.protocols.length !== 1 || fields.protocols[0] !== profile.protocol) fail('UNISWAP_LIQUIDITY_PROVIDER_UNSUPPORTED');
  if (fields.feeTier !== profile.feeTier) fail('UNISWAP_FEE_TIER_UNSUPPORTED');
  if (fields.tickLower % profile.tickSpacing !== 0 || fields.tickUpper % profile.tickSpacing !== 0 || fields.tickLower < -usable ||
      fields.tickUpper > usable || fields.tickLower >= fields.tickUpper) fail('UNISWAP_LIQUIDITY_RANGE_INVALID');
  if (fields.slippageBps === null || fields.slippageBps < 1 || fields.slippageBps > profile.maximumSlippageBps) fail('UNISWAP_SLIPPAGE_OUT_OF_RANGE');
  if (BigInt(fields.amount0Max) > BigInt(t0.maximumAmount) || BigInt(fields.amount1Max) > BigInt(t1.maximumAmount)) fail('AMOUNT_OUT_OF_RANGE');
  if (fields.amount0Min !== '0' || fields.amount1Min !== '0' || fields.recipient !== null || sorted(fields.positionAsset) !== sorted(uniswapPositionAsset(profile)))
    fail('UNISWAP_LIQUIDITY_DECLARATION_INVALID');
  // Closed declaration: the node must be byte-equivalent to the canonical construction (Mode A, ABORT, no edges).
  let canonical: SemanticWorkflow['nodes'][number];
  try { canonical = createConcentratedLiquidityNode(node.nodeId, fields); } catch { return fail('UNISWAP_LIQUIDITY_DECLARATION_INVALID'); }
  if (sorted(node) !== sorted(canonical)) fail('UNISWAP_LIQUIDITY_DECLARATION_INVALID');
  return fields;
}
/** The catalog-network pool a node names (Robinhood Chain, Base): its two tokens on that chain, in pool order, at a standard fee tier. */
function catalogPoolOf(chain: string, fields: ConcentratedLiquidityFields): UniswapPoolProfile {
  const a = fields.token0, b = fields.token1;
  if (a.chainId !== chain || b.chainId !== chain || a.address === b.address) fail('UNISWAP_TOKEN_UNSUPPORTED');
  if (a.address > b.address) fail('UNISWAP_TOKEN_ORDER_INVALID');
  try { return catalogPoolOn(chain, { symbol: '', address: a.address, decimals: a.decimals }, { symbol: '', address: b.address, decimals: b.decimals }, fields.feeTier); }
  catch (cause) { return fail(cause instanceof Error && /^UNISWAP_[A-Z_]+$/.test(cause.message) ? cause.message : 'UNISWAP_LIQUIDITY_DECLARATION_INVALID'); }
}
/** One isolated position node; authoring templates may coexist but never connect to it. */
export function validateUniswapLiquidityWorkflow(workflow: SemanticWorkflow): ConcentratedLiquidityFields & { nodeId: string } {
  const nodes = workflow.nodes.filter(n => n.actionType === CONCENTRATED_LIQUIDITY_ACTION);
  const id = nodes[0]?.nodeId ?? '';
  if (nodes.length !== 1 || workflow.nodes.some(n => n.nodeId !== id && !n.actionType.startsWith('mock-')) ||
      workflow.resourceEdges.some(e => e.fromNodeId === id || e.toNodeId === id) ||
      workflow.nodes.some(n => n.dependencies.includes(id))) fail('UNISWAP_LIQUIDITY_ISOLATED_ONLY');
  return { ...validateUniswapLiquidityNode(nodes[0]!), nodeId: id };
}
