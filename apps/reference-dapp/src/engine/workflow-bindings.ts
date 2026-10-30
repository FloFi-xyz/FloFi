// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: typed amount bindings between the steps of a v2 workflow.
 *
 * A binding `{ step: c, amountFrom: p }` makes step c's input amount depend on step p's actual outcome. Step c's own `amount` becomes
 * the cap, and the amount used at execution is min(cap, actual reconciled amount of step c's input asset that step p delivered to the
 * owner). This is the rule FloFi's Solana composition already applies to a swap → position. Pure: the identities come from each
 * step's own canonical IR, never from labels, so a binding between two different tokens that share a symbol (Base Sepolia Circle
 * USDC vs Aave USDC) is refused.
 *
 *   consumer   a step that spends exactly one asset from the owner's wallet (its MAXIMUM_INPUT constraint): swap, bridge, supply,
 *              repay, transfer
 *   producer   a step that delivers one asset to the owner's wallet: swap and bridge (`asset-out`, a bridge only without an explicit
 *              recipient), withdraw and borrow (the asset itself)
 *
 * Bindings are part of the canonical workflow: the sequence hash covers them, and a workflow without bindings keeps its existing hash.
 */
import type { Composition } from './strategy-engine';
import type { SchemaIssue, StrategyAction, StrategySpec } from './strategy-spec';
import { orcaLiquidityProfile, uniswapLiquidityProfile, SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { resolveNetworkAsset } from '../domain/asset-catalogs';

export type WorkflowBindingInput = { readonly step: number; readonly amountFrom: number };
export type AssetIdentity = { readonly chainId: string; readonly address: string; readonly decimals: number };
/** A validated binding with the bound asset's identity and the consumer's cap (native units of that asset). */
export type WorkflowBinding = WorkflowBindingInput & { readonly asset: AssetIdentity; readonly cap: string;
  /** A liquidity consumer has two inputs; this is the exact canonical maxAmounts key selected by token identity. */
  readonly inputAsset?: string };
type Node = Composition['workflow']['nodes'][number];
type Quantity = { readonly asset: { readonly chainId: string; readonly address?: string; readonly nativeId?: string; readonly decimals: number }; readonly amount: string };

const CONSUMERS: ReadonlySet<StrategyAction> = new Set(['swap', 'bridge', 'supply', 'repay', 'transfer', 'add_liquidity']);
const PRODUCERS: ReadonlySet<StrategyAction> = new Set(['swap', 'bridge', 'withdraw', 'borrow']);
/** Native identifiers are internal binding keys only. They never become a token contract or transfer recipient. */
const identity = (asset: Quantity['asset'] | undefined): AssetIdentity | null => {
  if (!asset || !Number.isInteger(asset.decimals)) return null;
  const address = typeof asset.address === 'string' ? asset.address : asset.nativeId === 'ETH' && asset.chainId.startsWith('eip155:') && asset.decimals === 18
    ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' : asset.nativeId === 'SOL' && asset.chainId.startsWith('solana:') && asset.decimals === 9 ? SOLANA_MAINNET_TOKENS.SOL.mint : null;
  return address ? { chainId: asset.chainId, address: asset.chainId.startsWith('eip155:') ? address.toLowerCase() : address, decimals: asset.decimals } : null;
};
export const sameAsset = (a: AssetIdentity, b: AssetIdentity): boolean => a.chainId === b.chainId && a.address === b.address && a.decimals === b.decimals;
const financial = (c: Composition): readonly Node[] => c.workflow.nodes.filter(n => !n.actionType.startsWith('mock-'));

/** Every wallet input of an isolated step; position deposits remain distinct exact token identities. */
export function stepInputs(c: Composition): readonly (AssetIdentity & { readonly amount: string; readonly inputAsset?: string })[] {
  if (!CONSUMERS.has(c.strategy.action)) return [];
  const nodes = financial(c);
  if (nodes.length !== 1) return [];
  const limits = nodes[0]!.userConstraints.filter(u => u.kind === 'MAXIMUM_INPUT') as unknown as { quantity: Quantity }[];
  return limits.flatMap(({ quantity }) => {
    const asset = identity(quantity.asset);
    if (!asset || !/^[1-9][0-9]{0,77}$/.test(quantity.amount)) return [];
    if (c.strategy.action !== 'add_liquidity') return [{ ...asset, amount: quantity.amount }];
    const orca = orcaLiquidityProfile(asset.chainId), uniswap = uniswapLiquidityProfile(asset.chainId);
    const symbol = resolveNetworkAsset(asset.chainId, { address: asset.address })?.symbol
      ?? (orca && [orca.token0, orca.token1].find(t => t.mint === asset.address && t.decimals === asset.decimals)?.symbol)
      ?? (uniswap && [uniswap.token0, uniswap.token1].find(t => t.address.toLowerCase() === asset.address && t.decimals === asset.decimals)?.symbol);
    const inputAsset = symbol && Object.keys(c.strategy.maxAmounts).find(key => key === symbol);
    return inputAsset ? [{ ...asset, amount: quantity.amount, inputAsset }] : [];
  });
}

/** What one composed step spends from the owner's wallet: its single MAXIMUM_INPUT, for a consumer action. */
export function stepInput(c: Composition): (AssetIdentity & { readonly amount: string }) | null {
  const inputs = stepInputs(c);
  return inputs.length === 1 ? inputs[0]! : null;
}
/** What one composed step delivers to the owner's own wallet, for a producer action. */
export function stepOutput(c: Composition): AssetIdentity | null {
  const s = c.strategy;
  if (!PRODUCERS.has(s.action) || (s.action === 'bridge' && s.recipient)) return null;
  const nodes = financial(c);
  if (nodes.length !== 1) return null;
  const node = nodes[0]!;
  if (s.action === 'swap' || s.action === 'bridge') {
    const out = node.inputs.find(i => i.kind === 'ASSET' && i.name === 'asset-out');
    return identity(out?.value as Quantity['asset'] | undefined);
  }
  const limit = node.userConstraints.find(u => u.kind === 'MAXIMUM_INPUT') as unknown as { quantity: Quantity } | undefined;
  return identity(limit?.quantity.asset);
}

export type BindingCheck = { readonly ok: true; readonly bindings: readonly WorkflowBinding[] }
  | { readonly ok: false; readonly code: string; readonly issues: readonly SchemaIssue[] };
/** Validates raw bindings against the composed steps (order, one binding per consumer, action shapes, exact token identity). */
export function validateBindings(steps: readonly Composition[], raw: readonly WorkflowBindingInput[] | undefined): BindingCheck {
  if (!raw?.length) return { ok: true, bindings: [] };
  const out: WorkflowBinding[] = [], seen = new Set<string>();
  for (const [i, b] of raw.entries()) {
    const fail = (code: string, field = ''): BindingCheck => ({ ok: false, code, issues: [{ path: `/bindings/${i}${field}`, rule: code }] });
    if (!Number.isInteger(b.step) || !Number.isInteger(b.amountFrom) || b.step < 1 || b.step >= steps.length || b.amountFrom < 0 || b.amountFrom >= b.step)
      return fail('WORKFLOW_BINDING_INVALID');
    const consumer = steps[b.step]!, producer = steps[b.amountFrom]!;
    const inputs = stepInputs(consumer);
    if (!inputs.length) return fail('WORKFLOW_BINDING_CONSUMER_UNSUPPORTED', '/step');
    const output = stepOutput(producer);
    if (!output) return fail('WORKFLOW_BINDING_PRODUCER_UNSUPPORTED', '/amountFrom');
    const input = inputs.find(candidate => sameAsset(candidate, output));
    if (!input) return fail('WORKFLOW_BINDING_ASSET_MISMATCH');
    const key = `${b.step}:${input.chainId}:${input.address}`;
    if (seen.has(key)) return fail('WORKFLOW_BINDING_INVALID');
    seen.add(key);
    out.push({ step: b.step, amountFrom: b.amountFrom, asset: { chainId: input.chainId, address: input.address, decimals: input.decimals }, cap: input.amount,
      ...input.inputAsset ? { inputAsset: input.inputAsset } : {} });
  }
  return { ok: true, bindings: out.sort((a, b) => a.step - b.step || a.amountFrom - b.amountFrom) };
}
/** The canonical form a strategy and the sequence hash carry: `{step, amountFrom}` by consumer step. */
export const canonicalBindings = (bindings: readonly WorkflowBindingInput[]): WorkflowBindingInput[] =>
  [...bindings].map(b => ({ step: b.step, amountFrom: b.amountFrom })).sort((a, b) => a.step - b.step || a.amountFrom - b.amountFrom);

/** min(cap, received): the amount a bound step actually uses (native units). Zero means there is nothing to spend. */
export function boundAmount(cap: string | bigint, received: string | bigint): bigint {
  const c = BigInt(cap), r = BigInt(received);
  if (c <= 0n || r < 0n) throw new Error('WORKFLOW_BINDING_AMOUNT_INVALID');
  return r < c ? r : c;
}
/** Native units → the decimal string a strategy carries (no exponent, no trailing zeros). */
export function decimalOf(native: bigint, decimals: number): string {
  if (native < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('WORKFLOW_BINDING_AMOUNT_INVALID');
  const text = native.toString().padStart(decimals + 1, '0'), whole = text.slice(0, text.length - decimals), fraction = text.slice(text.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
/** The consumer step's strategy with its amount set to the resolved bound amount. Every other field is unchanged. */
export function boundStrategy(spec: StrategySpec, native: bigint, decimals: number, inputAsset?: string): StrategySpec {
  if (!CONSUMERS.has(spec.action) || native <= 0n) throw new Error('WORKFLOW_BINDING_AMOUNT_INVALID');
  if (spec.action === 'add_liquidity') {
    if (!inputAsset || !Object.hasOwn(spec.maxAmounts, inputAsset)) throw new Error('WORKFLOW_BINDING_ASSET_MISMATCH');
    return { ...spec, maxAmounts: { ...spec.maxAmounts, [inputAsset]: decimalOf(native, decimals) } };
  }
  return { ...spec, amount: decimalOf(native, decimals) } as StrategySpec;
}
