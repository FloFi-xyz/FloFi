// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001 (owner addendum): the one capability truth the authoring surfaces describe, generated from the shared registries instead
 * of hand-written lists.
 *
 *  - What can be authored, per action and network: `STRATEGY_EXAMPLES`, the one canonical example per supported action × network that MCP
 *    discovery composes through the real reducer and resolves against the execution capability registry (`engine/capability-catalog.ts`).
 *    The Canvas pickers read the same profile registries; `authoring-capabilities.test.ts` proves the three agree.
 *  - Networks: the network registry (names, environment, Copilot identifiers, official-catalog networks).
 *  - Lending assets and bridge routes: the examples, which a test binds to the Aave profile and Router registries.
 *
 * The natural-language Copilot reads its supported networks per action, its in-app capability text and the model's "What Flofi supports"
 * section from here, so a network or action added to the registries (and its canonical example) is described everywhere at once. Nothing
 * here grants authority or decides deployment enablement: the owner's Review and wallet signature remain the only way anything executes.
 */
import type { StrategyAction, StrategySpec } from '../engine/strategy-spec';
export type { StrategyAction };
import { STRATEGY_EXAMPLES } from '../engine/strategy-examples';
import { NETWORKS, networkIdentity, type CopilotNetworkId, type NetworkIdentity } from './network-registry';

export type AuthoringCapability = { readonly action: StrategyAction; readonly network: NetworkIdentity; readonly destination: NetworkIdentity | null;
  /** The example's asset where the action binds one (lending, bridge, transfer, composition); null where any supported pair may be used. */
  readonly asset: string | null; readonly outputAsset: string | null };

const identity = (key: string): NetworkIdentity => networkIdentity(key) ?? (() => { throw new Error(`CAPABILITY_NETWORK_UNKNOWN ${key}`); })();
function capabilityOf(strategy: StrategySpec): AuthoringCapability {
  const s = strategy as StrategySpec & { network?: string; sourceNetwork?: string; destinationNetwork?: string; asset?: string; outputAsset?: string };
  return Object.freeze({ action: strategy.action, network: identity(s.network ?? s.sourceNetwork!), destination: s.destinationNetwork ? identity(s.destinationNetwork) : null,
    asset: strategy.action === 'swap' || strategy.action === 'add_liquidity' ? null : s.asset ?? null, outputAsset: strategy.action === 'lending_composition' ? s.outputAsset ?? null : null });
}
/** Every supported action × network (× destination), in the canonical examples' order. */
export const AUTHORING_CAPABILITIES: readonly AuthoringCapability[] = Object.freeze(STRATEGY_EXAMPLES.map(example => capabilityOf(example.strategy)));

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
/** The networks an action can be authored on, in network registry order. */
export const capabilityNetworks = (action: StrategyAction): readonly NetworkIdentity[] =>
  NETWORKS.filter(network => AUTHORING_CAPABILITIES.some(capability => capability.action === action && capability.network === network));
/** The same networks as Copilot identifiers (networks the Copilot cannot name are left out). */
export const copilotNetworksFor = (action: StrategyAction): readonly CopilotNetworkId[] =>
  capabilityNetworks(action).map(network => network.copilot).filter((id): id is CopilotNetworkId => id !== null);
/** Aave lending offers: the one asset of each network, in first-example order. */
export const lendingOffers = (action: 'supply' | 'borrow' | 'repay' | 'withdraw' = 'supply'): readonly { readonly network: NetworkIdentity; readonly asset: string }[] =>
  AUTHORING_CAPABILITIES.filter(capability => capability.action === action && capability.asset !== null).map(capability => ({ network: capability.network, asset: capability.asset! }));
/** Cross-chain Router routes with their source token. */
export const bridgeOffers = (): readonly { readonly source: NetworkIdentity; readonly destination: NetworkIdentity; readonly asset: string }[] =>
  AUTHORING_CAPABILITIES.filter(capability => capability.action === 'bridge').map(capability => ({ source: capability.network, destination: capability.destination!, asset: capability.asset! }));
/** Networks whose swaps, transfers and pools take any asset of their validated official catalog. */
export const catalogCapabilityNetworks = (): readonly NetworkIdentity[] =>
  NETWORKS.filter(network => network.catalog && (['swap', 'transfer', 'add_liquidity'] as const)
    .every(action => AUTHORING_CAPABILITIES.some(capability => capability.network === network && capability.action === action)));

type Language = 'EN' | 'PT';
const join = (items: readonly string[], language: Language) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${language === 'PT' ? 'e' : 'and'} ${items.at(-1)}`;
/** Groups that may themselves contain "and" are separated by commas ("USDC on Base Sepolia and Base, and WBTC on Ethereum Sepolia"). */
const joinGroups = (groups: readonly string[], language: Language) => groups.length > 1 && groups.some(group => / (?:and|e) /.test(group))
  ? `${groups.slice(0, -1).join(', ')}, ${language === 'PT' ? 'e' : 'and'} ${groups.at(-1)}` : join(groups, language);
const names = (networks: readonly NetworkIdentity[], language: Language) => join(networks.map(network => network.name), language);
function lendingText(language: Language, mainnets = true): string {
  const byAsset = new Map<string, NetworkIdentity[]>();
  for (const offer of lendingOffers().filter(item => mainnets || item.network.environment !== 'MAINNET')) byAsset.set(offer.asset, [...byAsset.get(offer.asset) ?? [], offer.network]);
  return joinGroups([...byAsset].map(([asset, networks]) => language === 'PT' ? `${asset} na ${names(networks, 'PT')}` : `${asset} on ${names(networks, 'EN')}`), language);
}
const routes = () => bridgeOffers().map(route => `${route.source.name} → ${route.destination.name} (${route.asset})`);
const compositions = () => AUTHORING_CAPABILITIES.filter(capability => capability.action === 'lending_composition');
function compositionText(language: Language): string {
  return join(compositions().map(capability => language === 'PT'
    ? `Supply → Borrow → Swap do ${capability.asset} emprestado para ${capability.outputAsset} na ${capability.network.name}`
    : `Supply → Borrow → Swap the borrowed ${capability.asset} to ${capability.outputAsset} on ${capability.network.name}`), language);
}
/** The one step combination a workflow may hold (the composition refusal). */
export function compositionOnlyText(language: Language): string {
  return join(compositions().map(capability => language === 'PT'
    ? `Supply de ${capability.asset} → Borrow de ${capability.asset} → Swap do ${capability.asset} emprestado para ${capability.outputAsset} (Aave V3, ${capability.network.name})`
    : `Supply ${capability.asset} → Borrow ${capability.asset} → Swap the borrowed ${capability.asset} to ${capability.outputAsset} (Aave V3, ${capability.network.name})`), language);
}
const realFunds = () => unique(AUTHORING_CAPABILITIES.flatMap(capability => [capability.network, ...capability.destination ? [capability.destination] : []]))
  .filter(network => network.environment === 'MAINNET');

/** The Copilot's in-app answer to "what can you do", generated from the capability truth. Display copy only. */
export function capabilityText(language: Language): string {
  const catalog = catalogCapabilityNetworks();
  if (language === 'PT') return `O Flofi Copilot pode criar: swaps na ${names(capabilityNetworks('swap'), 'PT')}; transferências na ${names(capabilityNetworks('transfer'), 'PT')}; ` +
    `bridges pelo Cross-chain Router ${join(routes(), 'PT')}; Supply, Borrow, Repay e Withdraw na Aave V3 de ${lendingText('PT')}; liquidez na ` +
    `${names(capabilityNetworks('add_liquidity'), 'PT')}; e ${compositionText('PT')}. Na ${names(catalog, 'PT')}, swaps, transferências e liquidez aceitam qualquer token ` +
    `do catálogo oficial da rede, pelo símbolo ou pelo nome. Usam fundos reais: ${names(realFunds(), 'PT')}.`;
  return `Flofi Copilot can author: swaps on ${names(capabilityNetworks('swap'), 'EN')}; transfers on ${names(capabilityNetworks('transfer'), 'EN')}; ` +
    `Cross-chain Router bridges ${join(routes(), 'EN')}; Aave V3 Supply, Borrow, Repay and Withdraw of ${lendingText('EN')}; liquidity on ` +
    `${names(capabilityNetworks('add_liquidity'), 'EN')}; and ${compositionText('EN')}. On ${names(catalog, 'EN')}, swaps, transfers and liquidity take any token ` +
    `of the network's official catalog, by symbol or name. Real funds: ${names(realFunds(), 'EN')}.`;
}
/** The lending refusal: the one asset of each Aave network (`mainnets`: false leaves out real-funds networks, as CopilotIntent V1 does). */
export function lendingOnlyText(language: Language, mainnets: boolean): string {
  const text = lendingText(language, mainnets);
  return language === 'PT' ? `O Flofi suporta a Aave V3 apenas com ${text}.` : `Flofi supports Aave V3 with ${text} only.`;
}
/** Every Router route, for the bridge refusal. */
export const routeLabels = (): readonly string[] => bridgeOffers().map(route => `${route.source.name} → ${route.destination.name}`);
