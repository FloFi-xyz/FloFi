// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-AUTOMATION-002: what each step of a canonical FloFi workflow needs from delegated authority — derived deterministically from the
 * same composition (StrategySpec → Semantic Workflow IR → workflow hash) every FloFi surface uses. No second workflow representation:
 * a step requirement is read from the step's own IR nodes (action type, chain, verified asset identities, exact native amounts, slippage)
 * and from the capability registry's adapter for that node. UI labels never enter here.
 */
import { orcaLiquidityProfile, resolveNodeCapability, uniswapLiquidityProfile } from '@defi-workflow-engine/action-registry';
import { resolveNetworkAsset } from '../domain/asset-catalogs';
import { composeWorkflowBound, NETWORKS, strategyNetwork, type Composition, type WorkflowComposition } from '../engine/strategy-engine';
import { NETWORK_CHAINS } from '../engine/capability-catalog';
import type { NetworkId, StrategyAction, StrategyInput, StrategySpec } from '../engine/strategy-spec';

export type Namespace = 'eip155' | 'solana';
/** A token on one chain: its CAIP-2 chain, contract/mint address, decimals and the strategy's symbol (display only). */
export type AssetRef = { readonly chain: string; readonly address: string; readonly decimals: number; readonly symbol: string };
export type AssetAmount = AssetRef & { readonly amount: bigint };
export const assetKey = (a: Pick<AssetRef, 'chain' | 'address'>): string => a.chain.startsWith('eip155:') && a.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  ? `${a.chain}/native:ETH` : `${a.chain}/${a.chain.startsWith('solana:') ? 'token' : 'erc20'}:${a.address}`;

export type StepRequirement = {
  readonly index: number; readonly strategy: StrategySpec; readonly network: NetworkId; readonly chain: string; readonly namespace: Namespace;
  readonly action: StrategyAction; readonly actionTypes: readonly string[]; readonly adapterId: string | null;
  /** What the owner's account spends in this step (exact native units, from the IR's MAXIMUM_INPUT / amount inputs). */
  readonly inputs: readonly AssetAmount[];
  /** What the step returns to the owner (identity only; the amount is a simulation fact). */
  readonly outputs: readonly AssetRef[];
  readonly slippageBps: number | null; readonly destinationChain: string | null; readonly fundsClass: 'TEST_FUNDS' | 'REAL_FUNDS';
  /** The step's own IR hash (what an existing flow reviews for it). */
  readonly stepHash: string;
};
export type WorkflowRequirement = { readonly workflowHash: string; readonly strategy: StrategyInput; readonly steps: readonly StepRequirement[];
  readonly chains: readonly string[]; readonly actionTypes: readonly string[]; readonly fundsClass: 'TEST_FUNDS' | 'REAL_FUNDS';
  /** BUILD-CHAT-E2E-001: typed amount dependencies; a bound step's input amount is its cap until the producer step reconciled. */
  readonly bindings: WorkflowComposition['bindings'] };

type Node = Composition['workflow']['nodes'][number];
type Quantity = { readonly asset: { readonly chainId: string; readonly address?: string; readonly nativeId?: string; readonly decimals: number }; readonly amount: string };
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: a native asset (ETH on an EVM chain, SOL on Solana) has no contract; it gets the same internal identity
 * the typed bindings use (`engine/workflow-bindings.ts`): the 0xeeee… marker for ETH, the wrapped-SOL mint for SOL. Never a transfer target.
 */
const NATIVE_IDENTITY = (asset: Quantity['asset']): string | null => asset.nativeId === 'ETH' && asset.chainId.startsWith('eip155:') && asset.decimals === 18
  ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' : asset.nativeId === 'SOL' && asset.chainId.startsWith('solana:') && asset.decimals === 9
    ? 'So11111111111111111111111111111111111111112' : null;
/** P0 universal execution: a bridge's own authored assets (its input, and its output when it names another one), never a fixed label. */
const SYMBOLS = (s: StrategySpec): readonly string[] => s.action === 'swap' ? [s.inputAsset, s.outputAsset] : s.action === 'bridge' ? [s.asset, s.outputAsset ?? s.asset]
  : s.action === 'add_liquidity' ? Object.keys(s.maxAmounts) : s.action === 'lending_composition' ? ['USDC', 'WETH'] : [s.asset];
const EXPLICIT_TOKEN = /^(?:0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})@[0-9]{1,2}$/;
/**
 * The symbol the owner reads for an asset of a step: the network catalog's symbol for its exact address (or the registered liquidity pool's
 * token), else the authored symbol. An authored explicit token (`address@decimals`) without a catalog entry reads as its shortened address.
 */
function displaySymbol(asset: Quantity['asset'], authored: string): string {
  if (asset.nativeId === 'ETH' || asset.nativeId === 'SOL') return asset.nativeId;
  const address = typeof asset.address === 'string' ? asset.address : null;
  if (address) {
    const evm = asset.chainId.startsWith('eip155:'), key = evm ? address.toLowerCase() : address;
    const orca = orcaLiquidityProfile(asset.chainId), uniswap = uniswapLiquidityProfile(asset.chainId);
    const known = resolveNetworkAsset(asset.chainId, { address: key })?.symbol
      ?? (orca && [orca.token0, orca.token1].find(token => token.mint === key && token.decimals === asset.decimals)?.symbol)
      ?? (uniswap && [uniswap.token0, uniswap.token1].find(token => token.address.toLowerCase() === key && token.decimals === asset.decimals)?.symbol);
    if (known) return known;
  }
  if (!EXPLICIT_TOKEN.test(authored)) return authored;
  const token = authored.split('@')[0]!;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
function ref(asset: Quantity['asset'], symbol: string): AssetRef {
  const address = typeof asset.address === 'string' ? asset.address : NATIVE_IDENTITY(asset);
  if (typeof address !== 'string' || !Number.isInteger(asset.decimals)) throw new Error('DELEGATION_STEP_ASSET_INVALID');
  return { chain: asset.chainId, address: asset.chainId.startsWith('eip155:') ? address.toLowerCase() : address, decimals: asset.decimals, symbol };
}
function stepOf(composition: Composition, index: number): StepRequirement {
  const strategy = composition.strategy, network = strategyNetwork(strategy), symbols = SYMBOLS(strategy);
  const nodes = composition.workflow.nodes.filter((n: Node) => !n.actionType.startsWith('mock-'));
  if (!nodes.length) throw new Error('DELEGATION_STEP_EMPTY');
  const environment = NETWORKS[network].environment;
  const adapters = [...new Set(nodes.map((n: Node) => resolveNodeCapability(n, { environment }).adapterId))];
  const inputs: AssetAmount[] = [], outputs: AssetRef[] = [];
  for (const node of nodes) {
    // The spend of a node is its MAXIMUM_INPUT constraints (what the owner's account may pay); outputs are its ASSET inputs.
    for (const c of node.userConstraints) if (c.kind === 'MAXIMUM_INPUT') {
      const q = c.quantity as Quantity, symbol = inputs.length < symbols.length ? symbols[inputs.length]! : symbols[0]!;
      inputs.push({ ...ref(q.asset, strategy.action === 'add_liquidity' ? symbolOfAddress(strategy, q.asset) : displaySymbol(q.asset, symbol)), amount: BigInt(q.amount) });
    }
    for (const input of node.inputs) if (input.kind === 'ASSET') {
      const asset = input.value as Quantity['asset'];
      outputs.push(ref(asset, displaySymbol(asset, symbols[1] ?? symbols[0]!)));
    }
  }
  const slippage = nodes.flatMap((n: Node) => n.userConstraints).find(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS') as { maximumBps?: number } | undefined;
  const chain = nodes[0]!.chainId;
  if (NETWORK_CHAINS[network] !== chain) throw new Error('DELEGATION_STEP_CHAIN_MISMATCH');
  return { index, strategy, network, chain, namespace: chain.startsWith('solana:') ? 'solana' : 'eip155', action: strategy.action,
    actionTypes: [...new Set(nodes.map((n: Node) => n.actionType))], adapterId: adapters.length === 1 ? adapters[0]! : null, inputs, outputs,
    slippageBps: typeof slippage?.maximumBps === 'number' ? slippage.maximumBps : null,
    destinationChain: strategy.action === 'bridge' ? NETWORK_CHAINS[strategy.destinationNetwork] : null,
    fundsClass: NETWORKS[network].class === 'MAINNET' || (strategy.action === 'bridge' && NETWORKS[strategy.destinationNetwork].class === 'MAINNET') ? 'REAL_FUNDS' : 'TEST_FUNDS',
    stepHash: composition.workflowHash };
}
function symbolOfAddress(strategy: StrategySpec, asset: Quantity['asset']): string {
  // Liquidity deposits name both pool assets: each deposit is labelled by its own address (catalog or registered pool token), never guessed
  // from its decimals (two tokens with the same decimals, or a non-USDC 6-decimal token, would otherwise read as the other asset).
  if (strategy.action !== 'add_liquidity') return '';
  const keys = Object.keys(strategy.maxAmounts), resolved = displaySymbol(asset, '');
  const authored = keys.find(k => k.toUpperCase() === resolved.toUpperCase());
  if (authored) return authored;
  return resolved || (asset.decimals === 6 ? keys.find(k => k.includes('USDC')) ?? keys[0]! : keys.find(k => !k.includes('USDC')) ?? keys[0]!);
}

/**
 * BUILD-CHAT-E2E-001: step `index` of `requirement` with its input narrowed to `used` (a bound step, once its producer reconciled). Only a
 * smaller-or-equal amount of the very same asset is accepted: the cap the owner authorized is never exceeded.
 */
export function narrowedStep(requirement: WorkflowRequirement, index: number, used: bigint): StepRequirement {
  const step = requirement.steps[index], input = step?.inputs[0];
  if (!step || step.inputs.length !== 1 || !input || used <= 0n || used > input.amount) throw new Error('WORKFLOW_BINDING_AMOUNT_INVALID');
  return { ...step, inputs: [{ ...input, amount: used }] };
}

/** The delegated-authority requirements of a canonical workflow, bound to the hash the caller expects. */
export function workflowRequirement(strategy: unknown, expectedHash?: string): { readonly ok: true; readonly value: WorkflowRequirement } | { readonly ok: false; readonly code: string } {
  const composed = composeWorkflowBound(strategy, expectedHash);
  if (!composed.ok) return { ok: false, code: composed.code };
  return requirementOf(composed);
}
export function requirementOf(composed: WorkflowComposition): { readonly ok: true; readonly value: WorkflowRequirement } | { readonly ok: false; readonly code: string } {
  try {
    const steps = composed.steps.map((c, i) => stepOf(c, i));
    const chains = [...new Set(steps.flatMap(s => [s.chain, ...s.destinationChain ? [s.destinationChain] : []]))];
    return { ok: true, value: { workflowHash: composed.workflowHash, strategy: composed.strategy, steps, chains,
      actionTypes: [...new Set(steps.flatMap(s => s.actionTypes))], fundsClass: composed.fundsClass, bindings: composed.bindings } };
  } catch (cause) {
    return { ok: false, code: cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'DELEGATION_STEP_INVALID' };
  }
}
