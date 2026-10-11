// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-RH-002: the canonical exact-input swap over a network's official asset catalog (Robinhood Chain: Stock Tokens, USDG and WETH;
 * BUILD-BASE-001: Base, its pinned assets and the validated token list). The same `asset.swap.exact-input` action and ports as every EVM swap; assets are bound by
 * chain + address + decimals and, for an issuer-registered asset (a Robinhood Stock Token), by its official id as well, so
 * a contract or registry change can never silently keep the authored meaning. Pool, fee tier, quote and multiplier
 * state are observations bound at Simulate/Review, never intent.
 */
import { canonicalJson } from './canonical.js';
import type { SemanticWorkflow } from './semantic-workflow.js';

type Node = SemanticWorkflow['nodes'][number];
export const CATALOG_SWAP_ACTION = 'asset.swap.exact-input';
/** Networks whose swaps are authored from the official asset catalog (Robinhood Chain; BUILD-BASE-001 Base). */
export const CATALOG_SWAP_CHAINS: readonly string[] = Object.freeze(['eip155:4663', 'eip155:8453', 'eip155:42161']);
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', BASE_WETH = '0x4200000000000000000000000000000000000006';
/**
 * BUILD-BASE-001: Base's reference pair. USDC ⇄ WETH on Base keeps its BUILD-002 declaration (the reference registry swap, authored by
 * `createSwapNode`) so every existing Base swap keeps its IR and hash; only other catalog pairs are catalog swaps. Base USDC and WETH keep
 * their reference input bounds (1,000,000 USDC and 1,000 WETH, `baseAssetRegistry.maximumAmountUnits`) in every Base pair.
 */
export const CATALOG_SWAP_REFERENCE_PAIRS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({ 'eip155:8453': Object.freeze([BASE_USDC, BASE_WETH] as const) });
const REFERENCE_BOUNDS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  'eip155:8453': Object.freeze({ [BASE_USDC]: '1000000000000', [BASE_WETH]: '1000000000000000000000' }) });
export const CATALOG_SWAP_MAXIMUM_SLIPPAGE_BPS = 300;
export type CatalogAssetRef = { readonly chain: string; readonly address: string; readonly decimals: number; readonly officialId: string | null };
export type CatalogSwapFields = { readonly chain: string; readonly input: CatalogAssetRef; readonly output: CatalogAssetRef;
  readonly amount: string; readonly slippageBps: number };
const ADDRESS = /^0x[0-9a-f]{40}$/, UNITS = /^[1-9][0-9]{0,77}$/, OFFICIAL_ID = /^0x[0-9a-f]{64}$/;
function fail(code: string): never { throw new Error(code); }
/** At most one billion whole units of the input asset (a network's reference asset keeps its reference bound); amounts are exact native units. */
export const catalogSwapMaximumUnits = (decimals: number, chain?: string, address?: string) =>
  (chain !== undefined && address !== undefined ? REFERENCE_BOUNDS[chain]?.[address] : undefined) ?? (10n ** BigInt(decimals + 9)).toString();
type SwapLike = { readonly actionType: string; readonly chainId: string; readonly inputs?: readonly { readonly name: string; readonly kind: string; readonly value: unknown }[] };
const addressOf = (value: unknown): string | null => value && typeof value === 'object' && 'address' in value && typeof value.address === 'string' ? value.address : null;
/** A swap of exactly a chain's reference pair (Base USDC ⇄ WETH), in either direction. */
export function isReferencePairSwap(node: SwapLike): boolean {
  const pair = CATALOG_SWAP_REFERENCE_PAIRS[node.chainId];
  if (node.actionType !== CATALOG_SWAP_ACTION || !pair || !node.inputs) return false;
  const amount = node.inputs.find(p => p.name === 'amount-in'), out = node.inputs.find(p => p.name === 'asset-out');
  const from = amount?.kind === 'QUANTITY' && amount.value && typeof amount.value === 'object' && 'asset' in amount.value ? addressOf(amount.value.asset) : null;
  const to = out?.kind === 'ASSET' ? addressOf(out.value) : null;
  return from !== null && to !== null && from !== to && pair.includes(from) && pair.includes(to);
}
export const isCatalogSwapNode = (node: SwapLike) =>
  node.actionType === CATALOG_SWAP_ACTION && CATALOG_SWAP_CHAINS.includes(node.chainId) && !isReferencePairSwap(node);

function asset(ref: CatalogAssetRef, chain: string): CatalogAssetRef {
  if (!ref || ref.chain !== chain || typeof ref.address !== 'string' || !ADDRESS.test(ref.address) || !Number.isSafeInteger(ref.decimals) ||
      ref.decimals < 0 || ref.decimals > 36 || (ref.officialId !== null && (typeof ref.officialId !== 'string' || !OFFICIAL_ID.test(ref.officialId))))
    fail('CATALOG_SWAP_ASSET_INVALID');
  return { chain, address: ref.address, decimals: ref.decimals, officialId: ref.officialId };
}
export function createCatalogSwapNode(nodeId: string, fields: CatalogSwapFields): Node {
  if (!CATALOG_SWAP_CHAINS.includes(fields.chain)) fail('CATALOG_SWAP_NETWORK_UNSUPPORTED');
  const input = asset(fields.input, fields.chain), output = asset(fields.output, fields.chain);
  if (input.address === output.address) fail('CATALOG_SWAP_PAIR_INVALID');
  // The reference pair is the BUILD-002 reference swap, never a catalog swap (one declaration per intent).
  const reference = CATALOG_SWAP_REFERENCE_PAIRS[fields.chain];
  if (reference && reference.includes(input.address) && reference.includes(output.address)) fail('CATALOG_SWAP_REFERENCE_PAIR');
  const maximum = catalogSwapMaximumUnits(input.decimals, fields.chain, input.address);
  if (typeof fields.amount !== 'string' || !UNITS.test(fields.amount) || BigInt(fields.amount) > BigInt(maximum))
    fail('CATALOG_SWAP_AMOUNT_INVALID');
  if (!Number.isSafeInteger(fields.slippageBps) || fields.slippageBps < 1 || fields.slippageBps > CATALOG_SWAP_MAXIMUM_SLIPPAGE_BPS) fail('CATALOG_SWAP_SLIPPAGE_INVALID');
  const inAsset = { chainId: input.chain, address: input.address, decimals: input.decimals };
  const outAsset = { chainId: output.chain, address: output.address, decimals: output.decimals };
  const quantity = { asset: inAsset, amount: fields.amount };
  return { nodeId, actionType: CATALOG_SWAP_ACTION, actionSchemaVersion: '1.0.0', chainId: fields.chain,
    requiredCapabilities: ['swap.direct-transaction'], adapterConstraints: { adapters: [], protocols: ['uniswap'] },
    inputs: [{ name: 'amount-in', kind: 'QUANTITY', value: quantity }, { name: 'asset-out', kind: 'ASSET', value: outAsset },
      ...input.officialId ? [{ name: 'asset-in-official-id', kind: 'IDENTIFIER' as const, value: input.officialId }] : [],
      ...output.officialId ? [{ name: 'asset-out-official-id', kind: 'IDENTIFIER' as const, value: output.officialId }] : []],
    expectedOutputs: [{ outputId: 'amount-out', asset: outAsset, minimumAmount: '0' }], dependencies: [],
    userConstraints: [{ kind: 'MAXIMUM_INPUT', quantity }, { kind: 'MAXIMUM_SLIPPAGE_BPS', maximumBps: fields.slippageBps }],
    failurePolicy: 'ABORT', requiredAuthorizationClass: 'MODE_A', lockedParameters: [],
    editableBounds: [{ parameterName: 'amount-in', asset: inAsset, minimumAmount: '1', maximumAmount: maximum }] };
}
/** Closed declaration: the node must be exactly the canonical construction of its own fields. */
export function readCatalogSwapNode(node: Node): CatalogSwapFields {
  if (!isCatalogSwapNode(node)) fail('CATALOG_SWAP_NODE_INVALID');
  const amount = node.inputs.find(p => p.name === 'amount-in'), out = node.inputs.find(p => p.name === 'asset-out');
  const inId = node.inputs.find(p => p.name === 'asset-in-official-id'), outId = node.inputs.find(p => p.name === 'asset-out-official-id');
  const slip = node.userConstraints.find(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS');
  if (amount?.kind !== 'QUANTITY' || !('address' in amount.value.asset) || out?.kind !== 'ASSET' || !('address' in out.value) ||
      slip?.kind !== 'MAXIMUM_SLIPPAGE_BPS' || (inId && inId.kind !== 'IDENTIFIER') || (outId && outId.kind !== 'IDENTIFIER')) fail('CATALOG_SWAP_NODE_INVALID');
  const fields: CatalogSwapFields = { chain: node.chainId, amount: amount.value.amount, slippageBps: slip.maximumBps,
    input: { chain: amount.value.asset.chainId, address: amount.value.asset.address, decimals: amount.value.asset.decimals,
      officialId: inId?.kind === 'IDENTIFIER' ? inId.value : null },
    output: { chain: out.value.chainId, address: out.value.address, decimals: out.value.decimals, officialId: outId?.kind === 'IDENTIFIER' ? outId.value : null } };
  const rebuilt = createCatalogSwapNode(node.nodeId, fields);
  if (canonicalJson(node) !== canonicalJson(rebuilt)) fail('CATALOG_SWAP_DECLARATION_INVALID');
  return fields;
}
