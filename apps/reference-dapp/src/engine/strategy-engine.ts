// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-001: the server-safe deterministic engine facade.
 *
 * It composes the functions the DApp already uses — no new authoring semantics:
 *   StrategySpec → the existing typed `Command` (the canvas/chat command set) → `editorReducer` from the initial editor state
 *   with the DApp's own ReviewContext → canonical Semantic Workflow IR (+ `semanticWorkflowHash`) → `lintWorkflow`,
 *   `resolveWorkflowCapability`, `describeProposal`, `summarize`, `workflowSteps`.
 * Pure: no React, network, storage, wallet, clock or model. The same spec always yields the same IR and hash, and that IR is
 * byte-identical to what the DApp authors for the equivalent chat sentence (tested). Nothing here can quote, simulate,
 * authorize, sign or submit; a composed workflow authorizes nothing.
 */
import { baseAssetRegistry, referenceRegistry, resolveWorkflowCapability, UNIVERSAL_ROUTER_DEPLOYMENT, type CapabilityBlocker, type EvidenceMaturity,
  type ExecutionEnvironment } from '@defi-workflow-engine/action-registry';
import { createReviewContext, lintWorkflow, reviewContextForChain, type ReviewContext } from '@defi-workflow-engine/reference-linter';
import { createHash } from 'node:crypto';
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import { capabilityBlockMessage } from '../domain/capability-view';
import { summarize, type Command } from '../domain/commands';
import { editorReducer, initialEditor, type EditorState } from '../domain/editor';
import type { Workflow } from '../domain/initial-workflow';
import { createSolanaSwapNode } from '../domain/jupiter-authoring';
import { createAuthoredLending } from '../domain/lending-authoring';
import { describeProposal } from '../domain/proposal';
import { createRouterNode, routerNetworkOfInput, ROUTER_NETWORK_OPTIONS, type RouterBridgeInput, type RouterDestination, type RouterSource } from '../domain/router-authoring';
import { createUniversalBridgeFromInput, defaultUniversalOutput, resolveUniversalAsset, universalAssetReference, type UniversalBridgeInput, type UniversalBridgeRouting } from '../domain/universal-bridge-authoring';
import { isSolanaPublicKey, UNIVERSAL_NETWORKS, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
import { networkIdentity } from '../domain/network-registry';
import { authoringAssetSymbol } from '../domain/asset-catalogs';
import { createCryptoActionNode, type CryptoActionInput } from '../domain/crypto-action-picker';
import { createAuthoredTransfer, type RobinhoodTransferInput } from '../domain/robinhood-transfer-authoring';
import { solanaTransferProfileFor } from '../domain/solana-transfer-authoring';
import { solanaTransferAsset } from '@defi-workflow-engine/action-registry';
import { ROBINHOOD_LIQUIDITY_DEFAULT_FEE, ROBINHOOD_LIQUIDITY_DEFAULT_SLIPPAGE } from '../domain/robinhood-liquidity-authoring';
import { createSolanaLiquidityNode, SOLANA_LIQUIDITY_DEFAULT_SLIPPAGE } from '../domain/solana-liquidity-authoring';
import { createAuthoredBorrow, createAuthoredRepay, createAuthoredSupply, createAuthoredWithdraw, lendingProfileFor } from '../domain/supply-authoring';
import { createSwapNode, type Direction } from '../domain/swap-authoring';
import { DEFAULT_SLIPPAGE_BPS, defaultSlippageWithin, formatSlippage } from '../domain/slippage-policy';
import { createUniswapLiquidityNode, uniswapLiquidityProfileFor, type UniswapLiquidityNetwork } from '../domain/uniswap-liquidity-authoring';
import { workflowSteps, type WorkflowStep } from '../domain/workflow-steps';
import { isStrategyInput, isStrategySpec, isStrategyWorkflow, strategyInputIssues, strategySpecIssues, NETWORK_IDS, type NetworkId, type SchemaIssue, type StrategyInput,
  type StrategySpec } from './strategy-spec';
import { canonicalBindings, validateBindings, type WorkflowBinding, type WorkflowBindingInput } from './workflow-bindings';

/** The DApp's initial ReviewContext (`app/page.tsx`): Base mainnet assets from the reference registry. */
export function dappReviewContext(): ReviewContext {
  return createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id,
    actionId: referenceRegistry.actions[0]!.id, assets: baseAssetRegistry });
}
/** The context the DApp derives for a workflow (`state/workflow-store.tsx`): a testnet swap's own chain, else the initial one. */
export function reviewContextOf(workflow: Workflow): ReviewContext {
  const swapChain = workflow.nodes.find(n => n.actionType === 'asset.swap.exact-input' && (n.chainId === 'eip155:84532' || n.chainId === 'eip155:11155111'))?.chainId;
  return swapChain ? reviewContextForChain(swapChain, dappReviewContext()) : dappReviewContext();
}
/** The canonical `semanticWorkflowHash`, computed exactly as the flows compute it for Review and the Manifest. */
export function semanticWorkflowHash(workflow: Workflow): string {
  return hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow)));
}

/** Network facts the facade needs; labels are the authoring modules' own network names. */
export const NETWORKS: Readonly<Record<NetworkId, { readonly label: string; readonly class: 'MAINNET' | 'TESTNET' | 'DEVNET'; readonly environment: ExecutionEnvironment }>> = Object.freeze(
  Object.fromEntries(NETWORK_IDS.map(key => {
    const identity = networkIdentity(key)!;
    return [key, { label: identity.name, class: key === 'solana-devnet' ? 'DEVNET' : identity.environment,
      environment: identity.environment === 'MAINNET' ? 'MAINNET' : 'PUBLIC_TESTNET' }];
  })) as Record<NetworkId, { label: string; class: 'MAINNET' | 'TESTNET' | 'DEVNET'; environment: ExecutionEnvironment }>);
/**
 * BUILD-BASE-001: the catalog networks (official asset catalog: Robinhood Chain, Base) by strategy id → their authoring network name. Their
 * swaps, positions and transfers are the Canvas's catalog actions; Base's USDC ⇄ WETH swap keeps its BUILD-002 command (hash continuity).
 */
const catalogNetworkName = (network: NetworkId): string | null => { const identity = networkIdentity(network); return identity?.catalog ? identity.name : null; };
const referencePair = (spec: { readonly network: NetworkId; readonly inputAsset: string; readonly outputAsset: string }) => spec.network === 'base' &&
  new Set([spec.inputAsset, spec.outputAsset].map(s => s.toUpperCase())).size === 2 && [spec.inputAsset, spec.outputAsset].every(s => ['USDC', 'WETH'].includes(s.toUpperCase()));
/** The router's chain names of a bridge's networks (BUILD-RH-002: Robinhood Chain in and out of Base and Arbitrum One). */
const ROUTER_CHAIN = Object.freeze(Object.fromEntries(Object.values(ROUTER_NETWORK_OPTIONS).flatMap(option => [
  [networkIdentity(option.sourceLabel)!.key, option.source], [networkIdentity(option.destinationLabel)!.key, option.destination],
])));
const routerChains = (spec: Extract<StrategySpec, { action: 'bridge' }>) =>
  ({ source: ROUTER_CHAIN[spec.sourceNetwork] as RouterSource, destination: ROUTER_CHAIN[spec.destinationNetwork] as RouterDestination });
const ROUTING = { auto: 'AUTO', lifi: 'LIFI', across: 'ACROSS' } as const;
type BridgeSpec = Extract<StrategySpec, { action: 'bridge' }>;
const isUniversalKey = (network: string): network is UniversalNetworkKey => Object.hasOwn(UNIVERSAL_NETWORKS, network);
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: a bridge stays on the certified BUILD-ROUTER-001 Router when it is exactly one of its pairs (its source
 * token, its destination token, an EVM recipient) under its own policy (auto, lifi or across): the same command and workflow hash as before.
 * Every other mainnet bridge — Solana in or out, another asset, `best` or `relay` routing — is a universal bridge.
 */
export function isUniversalBridgeSpec(spec: BridgeSpec): boolean {
  if (!isUniversalKey(spec.sourceNetwork) || !isUniversalKey(spec.destinationNetwork) || spec.sourceNetwork === spec.destinationNetwork) return false;
  if (spec.routing === 'best' || spec.routing === 'relay') return true;
  const chains = routerChains(spec), network = chains.source && chains.destination ? routerNetworkOfInput(chains) : null;
  if (!network) return true;
  const pair = ROUTER_NETWORK_OPTIONS[network].pair;
  return bridgeSymbol(spec.sourceNetwork, spec.asset) !== pair.source.symbol ||
    spec.outputAsset !== undefined && bridgeSymbol(spec.destinationNetwork, spec.outputAsset) !== pair.destination.symbol || spec.recipient !== undefined && !/^0x/i.test(spec.recipient);
}
/** A bridge asset's canonical symbol (a catalog name resolves to its symbol); an unresolvable reference is kept as written for the decision. */
function bridgeSymbol(network: NetworkId, reference: string): string {
  const identity = networkIdentity(network);
  try { return (identity?.catalog ? authoringAssetSymbol(identity.chain, reference) : reference).toUpperCase(); } catch { return reference.toUpperCase(); }
}
const UNIVERSAL_ROUTING: Readonly<Record<NonNullable<BridgeSpec['routing']>, UniversalBridgeRouting>> = { auto: 'BEST', best: 'BEST', relay: 'RELAY', lifi: 'LIFI', across: 'ACROSS' };
/**
 * Defaults FloFi applies when a spec omits slippage: the same values the Copilot planners and profiles use. BUILD-FLOFI-PRODUCT-UX-001: the shared
 * product default (1%, `slippage-policy.ts`), within the route's own limit; an explicit `slippageBps` is always kept as written.
 */
export function defaultSlippageBps(spec: StrategySpec): number | null {
  switch (spec.action) {
    case 'bridge': return defaultSlippageWithin(isUniversalBridgeSpec(spec) ? UNIVERSAL_ROUTER_DEPLOYMENT.maximumSlippageBps
      : ROUTER_NETWORK_OPTIONS[routerNetworkOfInput(routerChains(spec)) ?? 'mainnet'].profile.maximumSlippageBps);
    case 'swap': case 'lending_composition': return DEFAULT_SLIPPAGE_BPS;
    case 'add_liquidity': return spec.network === 'solana-devnet' || spec.network === 'solana' ? Number(SOLANA_LIQUIDITY_DEFAULT_SLIPPAGE)
      : catalogNetworkName(spec.network) ? Number(ROBINHOOD_LIQUIDITY_DEFAULT_SLIPPAGE) : uniswapLiquidityProfileFor(NETWORKS[spec.network].label).defaultSlippageBps;
    default: return null;
  }
}
/** Primary network of a spec (the bridge's source). */
export const strategyNetwork = (spec: StrategySpec): NetworkId => spec.action === 'bridge' ? spec.sourceNetwork : spec.network;

/** The spec with every default made explicit and addresses lower-cased: its canonical form. */
export function normalizeStrategy(spec: StrategySpec): { readonly strategy: StrategySpec; readonly notes: readonly string[] } {
  const notes: string[] = [], lower = (value: string) => value.toLowerCase();
  const symbol = (network: NetworkId, reference: string) => {
    const identity = networkIdentity(network);
    return identity?.catalog ? authoringAssetSymbol(identity.chain, reference) : reference;
  };
  const slippage = 'slippageBps' in spec && spec.slippageBps !== undefined ? spec.slippageBps : defaultSlippageBps(spec);
  if (!('slippageBps' in spec && spec.slippageBps !== undefined) && slippage !== null) notes.push(`Default slippage ${formatSlippage(slippage)} applied.`);
  switch (spec.action) {
    case 'bridge': {
      if (isUniversalBridgeSpec(spec)) {
        const source = spec.sourceNetwork as UniversalNetworkKey, destination = spec.destinationNetwork as UniversalNetworkKey;
        // Catalog networks resolve names and symbols exactly as every other action does (same refusals for unknown or unloaded assets).
        const asset = universalAssetReference(source, spec.asset), input = resolveUniversalAsset(source, asset);
        const outputAsset = spec.outputAsset !== undefined ? universalAssetReference(destination, spec.outputAsset) : defaultUniversalOutput(source, input.symbol, destination);
        const output = resolveUniversalAsset(destination, outputAsset);
        const cross = UNIVERSAL_NETWORKS[source].ecosystem !== UNIVERSAL_NETWORKS[destination].ecosystem;
        if (spec.outputAsset === undefined) notes.push(`No destination asset given: ${output.symbol} on ${UNIVERSAL_NETWORKS[destination].name} is proposed and shown at Review.`);
        if (spec.routing === undefined || spec.routing === 'auto') notes.push('Default routing best applied: every provider is asked; the executable route with the highest guaranteed minimum is chosen and shown at Review.');
        if (spec.recipient === undefined) notes.push(cross ? `No recipient given: the ${UNIVERSAL_NETWORKS[destination].ecosystem === 'SOLANA' ? 'Solana' : 'EVM'} wallet you connect in the FloFi app receives the funds (bound at Review).`
          : 'No recipient given: the wallet that signs in the FloFi app receives the funds (bound at Review).');
        const evmDestination = UNIVERSAL_NETWORKS[destination].ecosystem === 'EVM';
        if (spec.recipient !== undefined && (evmDestination ? !/^0x[0-9a-fA-F]{40}$/.test(spec.recipient) : !isSolanaPublicKey(spec.recipient))) throw new Error('UNIVERSAL_RECIPIENT_INVALID');
        const recipient = spec.recipient === undefined ? undefined : evmDestination ? lower(spec.recipient) : spec.recipient;
        return { notes, strategy: { version: 1, action: 'bridge', sourceNetwork: spec.sourceNetwork, destinationNetwork: spec.destinationNetwork, asset,
          outputAsset, amount: spec.amount, routing: spec.routing === undefined || spec.routing === 'auto' ? 'best' : spec.routing, slippageBps: slippage!,
          ...recipient === undefined ? {} : { recipient } } };
      }
      if (spec.routing === undefined) notes.push('Default routing auto applied: LI.FI first, direct Across only if LI.FI has no reconcilable route.');
      if (spec.recipient === undefined) notes.push('No recipient given: the wallet that signs in the FloFi app receives the funds (bound at Review).');
      return { notes, strategy: { version: 1, action: 'bridge', sourceNetwork: spec.sourceNetwork, destinationNetwork: spec.destinationNetwork, asset: symbol(spec.sourceNetwork, spec.asset), amount: spec.amount,
        routing: spec.routing ?? 'auto', slippageBps: slippage!, ...spec.recipient === undefined ? {} : { recipient: lower(spec.recipient) } } };
    }
    case 'swap': return { notes, strategy: { version: 1, action: 'swap', network: spec.network, inputAsset: symbol(spec.network, spec.inputAsset), outputAsset: symbol(spec.network, spec.outputAsset), amount: spec.amount, slippageBps: slippage! } };
    case 'supply': case 'borrow': case 'repay':
      return { notes, strategy: { version: 1, action: spec.action, network: spec.network, asset: symbol(spec.network, spec.asset), amount: spec.amount, beneficiary: lower(spec.beneficiary) } };
    case 'withdraw': return { notes, strategy: { version: 1, action: 'withdraw', network: spec.network, asset: symbol(spec.network, spec.asset), amount: spec.amount } };
    case 'add_liquidity': {
      // BUILD-RH-002: a catalog-network position (Robinhood Chain, BUILD-BASE-001 Base) names its fee tier (default 0.3%); other networks have one pool each.
      const catalog = catalogNetworkName(spec.network) !== null;
      const feeTier = catalog ? spec.feeTier ?? ROBINHOOD_LIQUIDITY_DEFAULT_FEE : spec.feeTier;
      if (catalog && spec.feeTier === undefined) notes.push(`Default fee tier ${ROBINHOOD_LIQUIDITY_DEFAULT_FEE / 10_000}% applied.`);
      const amounts = Object.entries(spec.maxAmounts).map(([reference, amount]) => [symbol(spec.network, reference), amount] as const);
      if (new Set(amounts.map(([asset]) => asset)).size !== amounts.length) throw new Error('INVALID_ASSET_PAIR');
      return { notes, strategy: { version: 1, action: 'add_liquidity', network: spec.network, maxAmounts: Object.fromEntries(amounts),
        range: spec.range.unit === 'full' ? { unit: 'full' } : { unit: spec.range.unit, lower: spec.range.lower, upper: spec.range.upper },
        ...feeTier === undefined ? {} : { feeTier }, slippageBps: slippage! } };
    }
    case 'transfer': {
      // BUILD-SOLANA-TRANSFER-UX-001: a Solana transfer always names its destination wallet (kept case-sensitive); a mint states decimals and program.
      if (spec.network === 'solana' || spec.network === 'solana-devnet') {
        if (spec.recipient === undefined) throw new Error('SOLANA_TRANSFER_RECIPIENT_REQUIRED');
        if (/^0x/i.test(spec.recipient)) throw new Error('SOLANA_TRANSFER_RECIPIENT_INVALID');
        // A verified asset is canonical by symbol, whether named by symbol or by its mint (stated decimals/program must then match it).
        const profile = solanaTransferProfileFor(NETWORKS[spec.network].label as 'Solana' | 'Solana Devnet'), known = solanaTransferAsset(profile, spec.asset);
        if (known && known.mint === spec.asset && (spec.decimals !== undefined && spec.decimals !== known.decimals || spec.tokenProgram !== undefined && spec.tokenProgram !== known.program))
          throw new Error('SOLANA_TRANSFER_MINT_DECIMALS_MISMATCH');
        if (known && known.mint !== spec.asset && (spec.decimals !== undefined || spec.tokenProgram !== undefined)) throw new Error('SOLANA_TRANSFER_TOKEN_FIELDS_UNEXPECTED');
        if (!known && (spec.decimals === undefined || spec.tokenProgram === undefined)) throw new Error('SOLANA_TRANSFER_TOKEN_FIELDS_REQUIRED');
        const asset = known?.symbol ?? spec.asset;
        if (known) return { notes, strategy: { version: 1, action: 'transfer', network: spec.network, asset, amount: spec.amount, recipient: spec.recipient } };
        return { notes, strategy: { version: 1, action: 'transfer', network: spec.network, asset, amount: spec.amount, recipient: spec.recipient,
          ...spec.decimals === undefined ? {} : { decimals: spec.decimals }, ...spec.tokenProgram === undefined ? {} : { tokenProgram: spec.tokenProgram } } };
      }
      if (spec.decimals !== undefined || spec.tokenProgram !== undefined) throw new Error('TRANSFER_PROFILE_UNSUPPORTED');
      if (spec.recipient !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(spec.recipient)) throw new Error('TRANSFER_RECIPIENT_INVALID');
      if (spec.recipient === undefined) notes.push('No recipient given: the wallet that signs in the FloFi app receives the transfer (bound at Review).');
      return { notes, strategy: { version: 1, action: 'transfer', network: spec.network, asset: symbol(spec.network, spec.asset), amount: spec.amount,
        ...spec.recipient === undefined ? {} : { recipient: lower(spec.recipient) } } };
    }
    case 'lending_composition': return { notes, strategy: { version: 1, action: 'lending_composition', network: 'base-sepolia', asset: 'USDC', supplyAmount: spec.supplyAmount,
      borrowAmount: spec.borrowAmount, outputAsset: 'WETH', slippageBps: slippage!, owner: lower(spec.owner) } };
  }
}

type Built = { readonly command: Command; readonly check: () => unknown };
class Refusal extends Error {}
const refuse = (code: string): never => { throw new Refusal(code); };
const base = { source: 'CHAT', baseRevision: 0 } as const;
/**
 * A normalized spec → the existing authoring command, plus the builder the reducer will run (called first so a refusal keeps
 * its specific code, as `parseLocalCommand` does). Unsupported combinations are refused, never mapped to something nearby.
 */
function build(spec: StrategySpec, context: ReviewContext): Built {
  const slippage = 'slippageBps' in spec ? String(spec.slippageBps) : '';
  switch (spec.action) {
    case 'bridge': {
      if (isUniversalBridgeSpec(spec)) {
        const source = spec.sourceNetwork as UniversalNetworkKey, destination = spec.destinationNetwork as UniversalNetworkKey;
        const input: UniversalBridgeInput = { source, destination, inputAsset: spec.asset,
          outputAsset: spec.outputAsset ?? defaultUniversalOutput(source, resolveUniversalAsset(source, spec.asset).symbol, destination), amount: spec.amount,
          recipient: spec.recipient ?? '', slippage, routing: UNIVERSAL_ROUTING[spec.routing ?? 'best'] };
        return { command: { ...base, type: 'ADD_UNIVERSAL_BRIDGE', input }, check: () => createUniversalBridgeFromInput('node-preview', input) };
      }
      if (spec.routing === 'best' || spec.routing === 'relay' || spec.outputAsset !== undefined) refuse('ROUTER_PAIR_UNSUPPORTED');
      const input: RouterBridgeInput = { ...routerChains(spec), token: spec.asset, amount: spec.amount, recipient: spec.recipient ?? '', slippage,
        routing: ROUTING[(spec.routing ?? 'auto') as keyof typeof ROUTING] };
      return { command: { ...base, type: 'ADD_ROUTER_BRIDGE', input }, check: () => createRouterNode('node-preview', input) };
    }
    case 'swap': {
      if (spec.inputAsset === spec.outputAsset) refuse('INVALID_ASSET_PAIR');
      // BUILD-RH-002: Robinhood Chain swaps the official catalog (USDG, WETH, Stock Tokens), exactly as the Canvas Stocks card and chat author it.
      // BUILD-BASE-001: so does Base (its validated token list), except the USDC ⇄ WETH reference swap below.
      const catalogName = catalogNetworkName(spec.network);
      if (catalogName && !referencePair(spec)) {
        const input: CryptoActionInput = { selection: { action: 'swap', network: catalogName, from: spec.inputAsset, to: spec.outputAsset }, amount: spec.amount, slippage };
        return { command: { ...base, type: 'ADD_CRYPTO_ACTION', input }, check: () => createCryptoActionNode('node-preview', input) };
      }
      if (spec.network === 'solana' || spec.network === 'solana-devnet') {
        const input = { network: NETWORKS[spec.network].label as 'Solana' | 'Solana Devnet', from: spec.inputAsset as never, to: spec.outputAsset as never, amount: spec.amount, slippage };
        return { command: { ...base, type: 'ADD_SOLANA_SWAP', input }, check: () => createSolanaSwapNode('node-preview', input) };
      }
      const pair = `${spec.inputAsset.toUpperCase()}>${spec.outputAsset.toUpperCase()}`;
      const direction: Direction = pair === 'USDC>WETH' ? 'USDC_TO_WETH' : pair === 'WETH>USDC' ? 'WETH_TO_USDC' : refuse('SWAP_ASSET_PAIR_UNSUPPORTED');
      const type = spec.network === 'base' ? 'ADD_SWAP' : spec.network === 'base-sepolia' ? 'ADD_TESTNET_SWAP' : 'ADD_ETHEREUM_SEPOLIA_SWAP';
      const swapContext = spec.network === 'base' ? context : reviewContextForChain(spec.network === 'base-sepolia' ? 'eip155:84532' : 'eip155:11155111', context);
      return { command: { ...base, type, direction, amount: spec.amount, slippage }, check: () => createSwapNode('node-preview', direction, spec.amount, slippage, swapContext) };
    }
    case 'supply': case 'borrow': case 'repay': {
      const profile = lendingProfileFor(NETWORKS[spec.network].label, spec.asset);
      const input = { network: profile.network, asset: profile.symbol, amount: spec.amount, beneficiary: spec.beneficiary };
      const create = spec.action === 'supply' ? createAuthoredSupply : spec.action === 'borrow' ? createAuthoredBorrow : createAuthoredRepay;
      return { command: { ...base, type: spec.action === 'supply' ? 'ADD_SUPPLY' : spec.action === 'borrow' ? 'ADD_BORROW' : 'ADD_REPAY', input }, check: () => create('node-preview', input) };
    }
    case 'withdraw': {
      const profile = lendingProfileFor(NETWORKS[spec.network].label, spec.asset);
      const input = { network: profile.network, asset: profile.symbol, amount: spec.amount, recipient: 'CONNECTED_OWNER' as const };
      return { command: { ...base, type: 'ADD_WITHDRAW', input }, check: () => createAuthoredWithdraw('node-preview', input) };
    }
    case 'add_liquidity': {
      const amounts = spec.maxAmounts, keys = Object.keys(amounts).sort().join();
      const poolNetwork = catalogNetworkName(spec.network);
      if (poolNetwork) {
        // Any two official catalog assets at a standard fee tier: the full range, or explicit ticks (a price range would need the pool's live price).
        if (spec.range.unit === 'price') refuse('LIQUIDITY_RANGE_UNIT_UNSUPPORTED');
        const [tokenA, tokenB] = Object.keys(amounts) as [string, string];
        const input: CryptoActionInput = { selection: { action: 'pool', network: poolNetwork, from: tokenA, to: tokenB }, amount: amounts[tokenA]!,
          secondAmount: amounts[tokenB]!, slippage, fee: spec.feeTier ?? ROBINHOOD_LIQUIDITY_DEFAULT_FEE,
          ...spec.range.unit === 'tick' ? { rangeUnit: 'TICK' as const, lower: spec.range.lower, upper: spec.range.upper } : {} };
        return { command: { ...base, type: 'ADD_CRYPTO_ACTION', input }, check: () => createCryptoActionNode('node-preview', input) };
      }
      if (spec.range.unit === 'full') refuse('LIQUIDITY_RANGE_UNIT_UNSUPPORTED');
      if (spec.feeTier !== undefined) refuse('LIQUIDITY_FEE_TIER_UNSUPPORTED');
      const range = spec.range as Extract<typeof spec.range, { lower: string }>;
      const rangeUnit = range.unit === 'price' ? 'PRICE' as const : 'TICK' as const, { lower, upper } = range;
      if (spec.network === 'solana-devnet' || spec.network === 'solana') {
        const devnet = spec.network === 'solana-devnet', quote = devnet ? 'devUSDC' : 'USDC';
        if (keys !== ['SOL', quote].sort().join()) refuse('LIQUIDITY_ASSET_PAIR_UNSUPPORTED');
        const input = { network: devnet ? 'Solana Devnet' as const : 'Solana' as const, maxSol: amounts.SOL!, maxDevUsdc: amounts[quote]!, rangeUnit, lower, upper, slippage };
        return { command: { ...base, type: 'ADD_SOLANA_LIQUIDITY', input }, check: () => createSolanaLiquidityNode('node-preview', input) };
      }
      if (keys !== 'USDC,WETH') refuse('LIQUIDITY_ASSET_PAIR_UNSUPPORTED');
      const input = { network: NETWORKS[spec.network].label as UniswapLiquidityNetwork, maxUsdc: amounts.USDC!, maxWeth: amounts.WETH!, rangeUnit, lower, upper, slippage };
      return { command: { ...base, type: 'ADD_UNISWAP_LIQUIDITY', input }, check: () => createUniswapLiquidityNode('node-preview', input) };
    }
    case 'lending_composition': {
      const input = { supply: spec.supplyAmount, borrow: spec.borrowAmount, slippage, owner: spec.owner };
      return { command: { ...base, type: 'AUTHOR_LENDING', input }, check: () => createAuthoredLending('lending-preview', 1, input) };
    }
    case 'transfer': {
      const solana = spec.network === 'solana' || spec.network === 'solana-devnet';
      const input: RobinhoodTransferInput = solana ? { network: NETWORKS[spec.network].label as 'Solana' | 'Solana Devnet', asset: spec.asset, amount: spec.amount,
        recipient: spec.recipient ?? refuse('SOLANA_TRANSFER_RECIPIENT_REQUIRED'), ...spec.decimals === undefined ? {} : { decimals: String(spec.decimals) },
        ...spec.tokenProgram === undefined ? {} : { program: spec.tokenProgram } }
        : { network: (spec.network === 'ethereum-sepolia' || spec.network === 'robinhood-testnet' ? NETWORKS[spec.network].label
          : catalogNetworkName(spec.network) ?? refuse('TRANSFER_PROFILE_UNSUPPORTED')) as RobinhoodTransferInput['network'],
          asset: spec.asset, amount: spec.amount, recipient: spec.recipient ?? 'CONNECTED_OWNER' };
      return { command: { ...base, type: 'ADD_RH_TRANSFER', input }, check: () => createAuthoredTransfer('node-preview', input) };
    }
  }
}

export type ComposeFailure = { readonly ok: false; readonly code: string; readonly issues: readonly SchemaIssue[] };
export type Composition = {
  readonly ok: true; readonly strategy: StrategySpec; readonly command: Command; readonly workflow: Workflow; readonly workflowHash: string;
  readonly context: ReviewContext; readonly steps: readonly WorkflowStep[]; readonly explanation: readonly string[]; readonly summary: string;
  readonly notes: readonly string[]; readonly fundsClass: 'TEST_FUNDS' | 'REAL_FUNDS';
};
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const codeOf = (cause: unknown, fallback: string) => cause instanceof Error && CODE.test(cause.message) ? cause.message : fallback;

/**
 * Untrusted structured intent → the canonical IR revision the DApp would author for it, or a closed refusal code. The
 * reducer starts from the DApp's initial editor state (revision 0), so a composition is always revision 1.
 */
export function composeStrategy(input: unknown): Composition | ComposeFailure {
  if (!isStrategySpec(input)) return { ok: false, code: 'STRATEGY_SCHEMA_INVALID', issues: strategySpecIssues(input) };
  let normalized: ReturnType<typeof normalizeStrategy>;
  try { normalized = normalizeStrategy(input); } catch (cause) { return { ok: false, code: codeOf(cause, 'STRATEGY_UNSUPPORTED'), issues: [] }; }
  const { strategy, notes } = normalized, context = dappReviewContext(), initial: EditorState = initialEditor();
  let built: Built;
  try { built = build(strategy, context); built.check(); }
  catch (cause) { return { ok: false, code: cause instanceof Refusal ? cause.message : codeOf(cause, 'STRATEGY_UNSUPPORTED'), issues: [] }; }
  const after = editorReducer(initial, built.command, context);
  if (after.error) return { ok: false, code: CODE.test(after.error) ? after.error : after.error.split(':')[0]!.trim() || 'STRATEGY_UNSUPPORTED', issues: [] };
  const workflow = after.workflow, workflowContext = reviewContextOf(workflow), steps = workflowSteps(workflow, workflowContext);
  const real = steps.some(step => step.testFunds === false);
  return { ok: true, strategy, command: built.command, workflow, workflowHash: semanticWorkflowHash(workflow), context: workflowContext, steps,
    explanation: describeProposal(initial, after, built.command, context), summary: summarize(workflow, workflowContext), notes,
    fundsClass: real ? 'REAL_FUNDS' : 'TEST_FUNDS' };
}

/** Composition bound to a hash the caller saw earlier: a different hash is a stale or altered strategy, never silently replaced. */
export function composeBound(input: unknown, expectedHash: string | undefined): Composition | ComposeFailure {
  const composed = composeStrategy(input);
  if (composed.ok && expectedHash !== undefined && expectedHash !== composed.workflowHash) return { ok: false, code: 'STRATEGY_WORKFLOW_HASH_MISMATCH', issues: [] };
  return composed;
}

/**
 * BUILD-MCP-002: a step-list workflow (`version: 2`, or a v1 strategy as its one step). Each step is the ordinary single-action
 * composition with its own isolated IR and hash. One step: the workflow IS that step (same canonical strategy, same hash — a v1
 * strategy and a one-step workflow are indistinguishable). Several steps: the canonical strategy is the v2 list of normalized steps
 * and the workflow hash covers the ordered step hashes. The exact Base Sepolia supply → borrow → swap shape is FloFi's existing
 * lending composition and is composed as such (one step, one executor).
 */
export type WorkflowComposition = {
  readonly ok: true; readonly strategy: StrategyInput; readonly workflowHash: string; readonly steps: readonly Composition[];
  readonly fundsClass: 'TEST_FUNDS' | 'REAL_FUNDS'; readonly notes: readonly string[];
  /** BUILD-CHAT-E2E-001: typed amount dependencies between steps (empty: every step has its own fixed amount). */
  readonly bindings: readonly WorkflowBinding[];
};
/**
 * The hash of an ordered list of step hashes (several steps only). BUILD-CHAT-E2E-001: bindings, when present, are part of it;
 * without bindings the hash is byte-for-byte the BUILD-MCP-002 one.
 */
export function workflowSequenceHash(stepHashes: readonly string[], bindings: readonly WorkflowBindingInput[] = []): string {
  const body = bindings.length ? { contract: 'flofi-strategy-workflow', version: 2, steps: stepHashes, bindings: canonicalBindings(bindings) }
    : { contract: 'flofi-strategy-workflow', version: 2, steps: stepHashes };
  return '0x' + createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
const sameAccount = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Supply → borrow → swap of exactly the borrowed USDC to WETH, all on Base Sepolia for one account: the existing lending composition. */
function collapseLending(steps: readonly StrategySpec[]): readonly StrategySpec[] {
  if (steps.length !== 3) return steps;
  const [supply, borrow, swap] = steps;
  if (supply?.action !== 'supply' || borrow?.action !== 'borrow' || swap?.action !== 'swap') return steps;
  if (supply.network !== 'base-sepolia' || borrow.network !== 'base-sepolia' || swap.network !== 'base-sepolia' || supply.asset !== 'USDC' || borrow.asset !== 'USDC' ||
      swap.inputAsset !== 'USDC' || swap.outputAsset !== 'WETH' || swap.amount !== borrow.amount || !sameAccount(supply.beneficiary, borrow.beneficiary)) return steps;
  return [{ version: 1, action: 'lending_composition', network: 'base-sepolia', asset: 'USDC', supplyAmount: supply.amount, borrowAmount: borrow.amount, outputAsset: 'WETH',
    ...swap.slippageBps === undefined ? {} : { slippageBps: swap.slippageBps }, owner: supply.beneficiary }];
}
export function composeWorkflow(input: unknown): WorkflowComposition | ComposeFailure {
  if (!isStrategyInput(input)) return { ok: false, code: 'STRATEGY_SCHEMA_INVALID', issues: strategyInputIssues(input) };
  const rawBindings = isStrategyWorkflow(input) ? input.bindings ?? [] : [];
  // A bound workflow is a general sequence: its step indexes are what its bindings name, so it is never collapsed.
  const specs = isStrategyWorkflow(input) ? rawBindings.length ? input.steps.map(step => ({ ...step, version: 1 }) as StrategySpec)
    : collapseLending(input.steps.map(step => ({ ...step, version: 1 }) as StrategySpec)) : [input];
  const steps: Composition[] = [];
  for (const [index, spec] of specs.entries()) {
    const composed = composeStrategy(spec);
    if (!composed.ok) return { ...composed, issues: composed.issues.map(issue => ({ path: specs.length > 1 || isStrategyWorkflow(input) ? `/steps/${index}${issue.path === '/' ? '' : issue.path}` : issue.path, rule: issue.rule })) };
    steps.push(composed);
  }
  const fundsClass = steps.some(c => c.fundsClass === 'REAL_FUNDS') ? 'REAL_FUNDS' : 'TEST_FUNDS';
  if (steps.length === 1) return { ok: true, strategy: steps[0]!.strategy, workflowHash: steps[0]!.workflowHash, steps, fundsClass, notes: steps[0]!.notes, bindings: [] };
  const checked = validateBindings(steps, rawBindings);
  if (!checked.ok) return { ok: false, code: checked.code, issues: checked.issues };
  const bindings = checked.bindings;
  return { ok: true, strategy: { version: 2, steps: steps.map(c => c.strategy), ...bindings.length ? { bindings: canonicalBindings(bindings) } : {} },
    workflowHash: workflowSequenceHash(steps.map(c => c.workflowHash), bindings), steps, fundsClass, bindings,
    notes: [...steps.flatMap((c, i) => c.notes.map(note => `Step ${i + 1}: ${note}`)),
      ...bindings.map(b => `Step ${b.step + 1} spends what step ${b.amountFrom + 1} actually delivers (after reconciliation), up to its own amount.`)] };
}
export function composeWorkflowBound(input: unknown, expectedHash: string | undefined): WorkflowComposition | ComposeFailure {
  const composed = composeWorkflow(input);
  if (composed.ok && expectedHash !== undefined && expectedHash !== composed.workflowHash) return { ok: false, code: 'STRATEGY_WORKFLOW_HASH_MISMATCH', issues: [] };
  return composed;
}

export type FindingLevel = 'BLOCK' | 'WARNING' | 'INFORMATION';
export type StrategyFinding = { readonly level: FindingLevel; readonly code: string; readonly source: 'LINTER' | 'CAPABILITY' | 'STRATEGY';
  readonly nodeId: string | null; readonly message: string };
export type StrategyReview = {
  readonly environment: ExecutionEnvironment; readonly findings: readonly StrategyFinding[];
  readonly capability: { readonly executionImplementedForOwnerWallet: boolean; readonly evidenceCeiling: EvidenceMaturity | null;
    readonly blockers: readonly (CapabilityBlocker & { readonly message: string })[] };
};
// Blockers that only the owner's own steps in the FloFi app clear (connect, simulate, review, authorize): information, not defects.
const OWNER_STEPS = new Set(['WALLET_NOT_CONNECTED', 'WRONG_WALLET_CHAIN', 'ARTIFACTS_MISSING', 'ARTIFACTS_STALE', 'SIMULATION_REQUIRED', 'AUTHORIZATION_REQUIRED']);

/**
 * The deterministic Strategy Review Engine (§9.1) over a composition: the linter, the capability registry for the network's
 * public environment, and strategy-level warnings. It never approves anything; the owner's Review in the FloFi app does.
 */
export function reviewComposition(composed: Composition): StrategyReview {
  const environment = NETWORKS[strategyNetwork(composed.strategy)].environment, findings: StrategyFinding[] = [];
  for (const f of lintWorkflow(composed.workflow, composed.context).findings)
    findings.push({ level: f.severity === 'BLOCK' ? 'BLOCK' : 'WARNING', code: f.code, source: 'LINTER', nodeId: f.nodeId, message: f.message });
  const capability = resolveWorkflowCapability(composed.workflow, { environment, runtime: {} });
  const required = new Set(capability.nodes.filter(n => !n.actionType.startsWith('mock-')).map(n => n.nodeId));
  const blockers = capability.blockers.map(b => ({ ...b, message: capabilityBlockMessage(b, capability.nodes.find(n => n.nodeId === b.nodeId)) }));
  for (const b of blockers) {
    if (!required.has(b.nodeId)) continue;
    findings.push({ level: OWNER_STEPS.has(b.code) ? 'INFORMATION' : 'BLOCK', code: b.code, source: 'CAPABILITY', nodeId: b.nodeId, message: b.message });
  }
  const s = composed.strategy;
  if (composed.fundsClass === 'REAL_FUNDS') findings.push({ level: 'WARNING', code: 'REAL_FUNDS', source: 'STRATEGY', nodeId: null,
    message: 'This strategy uses a mainnet: real funds. Nothing executes without the owner\'s Review and wallet signature in the FloFi app.' });
  if ((s.action === 'bridge' || s.action === 'transfer') && s.recipient) findings.push({ level: 'WARNING', code: 'EXPLICIT_RECIPIENT', source: 'STRATEGY', nodeId: null,
    message: `Funds are delivered to ${s.recipient}, not necessarily the signing wallet. Confirm this address belongs to the intended recipient.` });
  if ((s.action === 'supply' || s.action === 'borrow' || s.action === 'repay') && s.beneficiary) findings.push({ level: 'WARNING', code: 'EXPLICIT_BENEFICIARY', source: 'STRATEGY', nodeId: null,
    message: `The Aave position of ${s.beneficiary} is affected (onBehalfOf). Confirm it is the intended account; the signer may differ.` });
  if (s.action === 'lending_composition') findings.push({ level: 'WARNING', code: 'DEBT_REMAINS', source: 'STRATEGY', nodeId: null,
    message: 'Debt remains after the swap. If the swap fails, the borrowed USDC and the debt remain; there is no automatic repayment.' });
  findings.push({ level: 'INFORMATION', code: 'OWNER_APPROVAL_REQUIRED', source: 'STRATEGY', nodeId: null,
    message: 'This review authorizes nothing. Execution needs a fresh simulation, the owner\'s Review and the owner\'s wallet signature in the FloFi app.' });
  return { environment, findings, capability: { executionImplementedForOwnerWallet: capability.executionSupported, evidenceCeiling: capability.evidenceCeiling, blockers } };
}
