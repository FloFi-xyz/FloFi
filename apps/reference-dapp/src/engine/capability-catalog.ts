// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-001: discovery derived from the canonical profiles and registries — never a hand-written claim.
 *
 *  - networks and assets: the router pairs, Aave lending profiles, swap review contexts, Uniswap/Orca liquidity profiles and
 *    Solana token registries that authoring itself uses;
 *  - capabilities: each supported action × network composes its canonical example through the real reducer, then the
 *    execution capability registry is resolved on that exact IR. "Supported by code" is the registry's verdict; demonstrated
 *    evidence is the registry's ceiling (often none). Deployment enablement is added by the caller from the runtime.
 */
import { ETHEREUM_BASE_ASSETS, ARBITRUM_BASE_ASSETS, AAVE_V3_LENDING_PROFILES, executionCapabilityRegistry, LENDING_BASE_SEPOLIA, resolveNodeCapability, ROBINHOOD_BASE_ASSETS, BASE_BASE_ASSETS,
  resolveWorkflowCapability, SOLANA_DEVNET_CHAIN, SOLANA_DEVNET_TOKENS, SOLANA_MAINNET_CHAIN, SOLANA_MAINNET_TOKENS, SOLANA_TRANSFER_PROFILES, UNISWAP_LIQUIDITY_PROFILES,
  NATIVE_TRANSFER_PROFILES, ORCA_LIQUIDITY_PROFILES, ROBINHOOD_TESTNET_TRANSFER,
  type CapabilityDimension, type EvidenceMaturity, type ExecutionEnvironment } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext, createEthereumSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { ROUTER_PAIRS } from '@defi-workflow-engine/workflow-contracts';
import { composeStrategy, dappReviewContext, NETWORKS, strategyNetwork } from './strategy-engine';
import { STRATEGY_EXAMPLES } from './strategy-examples';
import { networkCatalog } from '../domain/asset-catalogs';
import { NETWORK_IDS, PUBLIC_NETWORK_IDS, PUBLIC_STRATEGY_ACTIONS, type NetworkId, type StrategyAction, type StrategySpec } from './strategy-spec';
import type { NetworkScope } from '../domain/network-scope';

/** CAIP-2 identity of each network, read from the registries that serve it. */
export const NETWORK_CHAINS: Readonly<Record<NetworkId, string>> = Object.freeze({
  'base': ROUTER_PAIRS[0]!.source.chainId, 'arbitrum-one': ROUTER_PAIRS[0]!.destination.chainId,
  'base-sepolia': ROUTER_PAIRS[1]!.source.chainId, 'arbitrum-sepolia': ROUTER_PAIRS[1]!.destination.chainId,
  'ethereum-sepolia': AAVE_V3_LENDING_PROFILES.find(p => p.network === 'Ethereum Sepolia')!.chain,
  'solana': SOLANA_MAINNET_CHAIN, 'solana-devnet': SOLANA_DEVNET_CHAIN,
  'robinhood': ROBINHOOD_BASE_ASSETS.chain, 'robinhood-testnet': ROBINHOOD_TESTNET_TRANSFER.chain, 'ethereum': ETHEREUM_BASE_ASSETS.chain,
});
const networkOfChain = (chain: string): NetworkId | null => NETWORK_IDS.find(id => NETWORK_CHAINS[id] === chain) ?? null;
/** A strategy of the public product: every network it names is a mainnet (so the Base Sepolia lending composition is not one). */
export const strategyInScope = (strategy: StrategySpec): boolean => [strategyNetwork(strategy), strategy.action === 'bridge' ? strategy.destinationNetwork : null]
  .every(network => network === null || PUBLIC_NETWORK_IDS.includes(network));
const actionsOn = (network: NetworkId): StrategyAction[] => [...new Set(STRATEGY_EXAMPLES.filter(e => strategyNetwork(e.strategy) === network ||
  e.strategy.action === 'bridge' && e.strategy.destinationNetwork === network).map(e => e.strategy.action))];

export type NetworkInfo = { readonly id: NetworkId; readonly name: string; readonly chainId: string; readonly class: 'MAINNET' | 'TESTNET' | 'DEVNET';
  readonly funds: 'REAL_FUNDS' | 'TEST_FUNDS'; readonly actions: readonly StrategyAction[] };
/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001: the networks of `scope`. The public product lists mainnets only (each with its public actions); engineering
 * certification lists every network the registries serve.
 */
const networksOf = (scope: NetworkScope): readonly NetworkId[] => scope === 'ENGINEERING' ? NETWORK_IDS : PUBLIC_NETWORK_IDS;
export function supportedNetworks(scope: NetworkScope): readonly NetworkInfo[] {
  return networksOf(scope).map(id => ({ id, name: NETWORKS[id].label, chainId: NETWORK_CHAINS[id], class: NETWORKS[id].class,
    funds: NETWORKS[id].class === 'MAINNET' ? 'REAL_FUNDS' : 'TEST_FUNDS', actions: actionsOn(id).filter(action => scope === 'ENGINEERING' || PUBLIC_STRATEGY_ACTIONS.includes(action)) }));
}

/** A null address is the chain's native currency, never an ERC-20 identity. */
export type AssetInfo = { readonly network: NetworkId; readonly chainId: string; readonly symbol: string; readonly address: string | null; readonly decimals: number;
  readonly actions: readonly StrategyAction[]; readonly sources: readonly string[] };
type Entry = { chain: string; symbol: string; address: string | null; decimals: number; action: StrategyAction; source: string };
function assetEntries(): Entry[] {
  const out: Entry[] = [];
  for (const pair of ROUTER_PAIRS) for (const t of [pair.source, pair.destination])
    out.push({ chain: t.chainId, symbol: t.symbol, address: t.address, decimals: t.decimals, action: 'bridge', source: `crosschain-router:${pair.id}` });
  for (const p of AAVE_V3_LENDING_PROFILES) for (const action of ['supply', 'borrow', 'repay', 'withdraw'] as const)
    out.push({ chain: p.chain, symbol: p.symbol, address: p.asset, decimals: p.decimals, action, source: `aave-v3:${p.network}` });
  for (const [label, context] of [['Base', dappReviewContext()], ['Base Sepolia', createBaseSepoliaReviewContext()], ['Ethereum Sepolia', createEthereumSepoliaReviewContext()]] as const)
    for (const symbol of ['USDC', 'WETH'] as const) {
      const a = context.assets[symbol].asset as { chainId: string; address: string; decimals: number };
      out.push({ chain: a.chainId, symbol, address: a.address, decimals: a.decimals, action: 'swap', source: `uniswap-v3-swap:${label}` });
    }
  for (const p of UNISWAP_LIQUIDITY_PROFILES) for (const t of [p.token0, p.token1])
    out.push({ chain: p.chain, symbol: t.symbol, address: t.address, decimals: t.decimals, action: 'add_liquidity', source: `uniswap-v3-liquidity:${p.network}` });
  for (const [chain, tokens, source] of [[SOLANA_MAINNET_CHAIN, SOLANA_MAINNET_TOKENS, 'jupiter:Solana'], [SOLANA_DEVNET_CHAIN, SOLANA_DEVNET_TOKENS, 'orca-whirlpools:Solana Devnet']] as const)
    for (const t of Object.values(tokens) as { symbol: string; mint: string; decimals: number }[])
      out.push({ chain, symbol: t.symbol, address: t.mint, decimals: t.decimals, action: 'swap', source });
  // BUILD-SOLANA-TRANSFER-UX-001: the verified transfer assets of each cluster (native SOL has a null address). Any other SPL mint is named by
  // address with its decimals and token program, and verified on chain.
  for (const profile of SOLANA_TRANSFER_PROFILES) for (const a of profile.assets)
    out.push({ chain: profile.chain, symbol: a.symbol, address: a.mint, decimals: a.decimals, action: 'transfer', source: `solana-transfer:${profile.network}` });
  for (const profile of ORCA_LIQUIDITY_PROFILES) for (const t of [profile.token0, profile.token1])
    out.push({ chain: profile.chain, symbol: t.symbol, address: t.mint, decimals: t.decimals, action: 'add_liquidity', source: `orca-whirlpools-liquidity:${profile.network}` });
  for (const profile of NATIVE_TRANSFER_PROFILES)
    out.push({ chain: profile.chain, symbol: 'ETH', address: null, decimals: 18, action: 'transfer', source: `native-transfer:${profile.network}` });
  // Discover the same currently loaded, validated catalog authoring reads. Without an official source, pinned assets alone
  // remain; no recorded catalog is substituted. Native currencies have transfer support only. Aave and Router membership above
  // remains narrower than catalog membership.
  for (const [catalog, name] of [[ROBINHOOD_BASE_ASSETS, 'robinhood'], [BASE_BASE_ASSETS, 'base'], [ARBITRUM_BASE_ASSETS, 'arbitrum-one'], [ETHEREUM_BASE_ASSETS, 'ethereum']] as const)
    for (const t of (networkCatalog(catalog.chain) ?? catalog).assets)
      for (const action of (t.kind === 'NATIVE' ? ['transfer'] as const : ['swap', 'add_liquidity', 'transfer'] as const).filter(action => actionsOn(name).includes(action)))
        out.push({ chain: catalog.chain, symbol: t.symbol, address: t.address, decimals: t.decimals, action, source: `${name}-catalog:${action}` });
  const aave = AAVE_V3_LENDING_PROFILES.find(p => p.network === 'Base Sepolia')!;
  out.push({ chain: aave.chain, symbol: aave.symbol, address: aave.asset, decimals: aave.decimals, action: 'lending_composition', source: 'lending-composition:Base Sepolia' });
  out.push({ chain: aave.chain, symbol: 'WETH', address: LENDING_BASE_SEPOLIA.weth, decimals: 18, action: 'lending_composition', source: 'lending-composition:Base Sepolia' });
  return out;
}
/** Every asset a strategy can name, grouped by chain and address (one symbol can be two tokens on one network). */
export function supportedAssets(scope: NetworkScope, network?: NetworkId): readonly AssetInfo[] {
  const merged = new Map<string, { network: NetworkId; chainId: string; symbol: string; address: string | null; decimals: number; actions: Set<StrategyAction>; sources: Set<string> }>();
  for (const e of assetEntries()) {
    const id = networkOfChain(e.chain);
    if (!id || (network && id !== network) || !networksOf(scope).includes(id)) continue;
    const key = `${e.chain}\0${e.address}`, item = merged.get(key) ?? { network: id, chainId: e.chain, symbol: e.symbol, address: e.address, decimals: e.decimals, actions: new Set(), sources: new Set() };
    item.actions.add(e.action); item.sources.add(e.source); merged.set(key, item);
  }
  return [...merged.values()].map(a => ({ network: a.network, chainId: a.chainId, symbol: a.symbol, address: a.address, decimals: a.decimals,
    actions: [...a.actions].sort(), sources: [...a.sources].sort() })).sort((a, b) => NETWORK_IDS.indexOf(a.network) - NETWORK_IDS.indexOf(b.network) || a.symbol.localeCompare(b.symbol));
}

export type CodeCapability = {
  readonly action: StrategyAction; readonly network: NetworkId; readonly destinationNetwork: NetworkId | null; readonly example: StrategySpec;
  readonly funds: 'REAL_FUNDS' | 'TEST_FUNDS'; readonly actionTypes: readonly string[]; readonly adapters: readonly string[];
  /** The registry's verdict for this network's public environment (PUBLIC_TESTNET or MAINNET). */
  readonly publicEnvironment: ExecutionEnvironment;
  readonly supportedByCode: Readonly<Record<CapabilityDimension, boolean>>;
  /** Owner-wallet execution implemented in code for that environment; a code fact, not a demonstration. */
  readonly ownerWalletExecutionImplemented: boolean;
  /** Highest evidence the registry records as demonstrated for this exact path; null = none demonstrated. */
  readonly demonstratedEvidence: EvidenceMaturity | null;
  /** Every registry environment the action's adapter declares on this chain (e.g. a mainnet path that is local-fork only). */
  readonly registryEnvironments: readonly ExecutionEnvironment[];
};
/** Code capabilities for each supported action × network of `scope`, from the registry resolved on the composed IR. */
export function codeCapabilities(scope: NetworkScope): readonly CodeCapability[] {
  return STRATEGY_EXAMPLES.filter(({ strategy }) => scope === 'ENGINEERING' || strategyInScope(strategy)).map(({ strategy }) => {
    const composed = composeStrategy(strategy);
    if (!composed.ok) throw new Error('CAPABILITY_EXAMPLE_INVALID');
    const network = strategyNetwork(strategy), environment = NETWORKS[network].environment;
    const financial = composed.workflow.nodes.filter(n => !n.actionType.startsWith('mock-'));
    const resolved = resolveWorkflowCapability(composed.workflow, { environment, runtime: {} });
    const nodes = financial.map(node => resolveNodeCapability(node, { environment }));
    const adapters = [...new Set(nodes.map(n => n.adapterId).filter((id): id is string => id !== null))];
    const environments = [...new Set(executionCapabilityRegistry.filter(row => financial.some(n => n.actionType === row.actionType && n.chainId === row.chainId) &&
      adapters.includes(row.adapterId)).map(row => row.environment))];
    return { action: strategy.action, network, destinationNetwork: strategy.action === 'bridge' ? strategy.destinationNetwork : null, example: strategy,
      funds: composed.fundsClass, actionTypes: [...new Set(financial.map(n => n.actionType))], adapters, publicEnvironment: environment,
      supportedByCode: resolved.capabilities, ownerWalletExecutionImplemented: resolved.executionSupported,
      demonstratedEvidence: resolved.executionSupported ? resolved.evidenceCeiling : null, registryEnvironments: environments };
  });
}
