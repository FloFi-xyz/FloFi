// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001 (owner addendum): the network and capability sections of the Copilot model instructions, generated from the same truth as
 * the in-app capability text (`domain/authoring-capabilities.ts`: the canonical examples and the network registry) and MCP discovery
 * (`engine/capability-catalog.ts` `supportedAssets`, for the tokens of networks without an official catalog). The model reads them only to
 * classify a request; FloFi still decides support deterministically for every proposal, so nothing here is authority.
 */
import { COPILOT_FEE_TIERS } from '../domain/copilot-intent';
import { COPILOT_POOLS } from '../domain/copilot-authoring';
import { AUTHORING_CAPABILITIES, bridgeOffers, universalNames, catalogCapabilityNetworks, copilotCapabilityNetworks, lendingAmountScopeText, lendingOffers } from '../domain/authoring-capabilities';
import { declaredNetworkSymbols } from '../domain/asset-catalogs';
import { COPILOT_NETWORK_IDS, networkIdentity, networkOfCopilot, type NetworkIdentity } from '../domain/network-registry';
import { ROUTER_NETWORK_OPTIONS } from '../domain/router-authoring';
import { supportedAssets } from '../engine/capability-catalog';
import type { NetworkId, StrategyAction } from '../engine/strategy-spec';
import type { NetworkScope } from '../domain/network-scope';
import { networkScope } from './network-scope.ts';

const join = (items: readonly string[], word = 'and') => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`;
const names = (networks: readonly NetworkIdentity[]) => join(networks.map(network => network.name));
/** The Copilot identifiers of the networks something can be authored on (as a source or a destination), by environment. */
const ids = (environment: 'MAINNET' | 'TESTNET') => join(COPILOT_NETWORK_IDS.map(id => networkOfCopilot(id))
  .filter(network => network.environment === environment && AUTHORING_CAPABILITIES.some(c => c.network === network || c.destination === network))
  .map(network => `${network.copilot} (${network.name})`));
/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001: the model is told what the deployment's scope offers. The public product describes mainnets only (FloFi still
 * decides deterministically and refuses a test network, `domain/network-scope.ts`); engineering certification keeps every network.
 */
const inScope = (scope: NetworkScope) => (network: NetworkIdentity | null) => scope === 'ENGINEERING' || network?.environment === 'MAINNET';
const scoped = (scope: NetworkScope, action: StrategyAction) => copilotCapabilityNetworks(action).filter(inScope(scope));
/** A Router route with its source token, and the token it arrives as when that differs (from the Router registry). */
function routeText(route: ReturnType<typeof bridgeOffers>[number]): string {
  const option = Object.values(ROUTER_NETWORK_OPTIONS).find(candidate => networkIdentity(candidate.sourceLabel) === route.source && networkIdentity(candidate.destinationLabel) === route.destination);
  const arrives = option && option.pair.destination.symbol !== route.asset ? ` (arrives as ${option.pair.destination.symbol})` : '';
  return `${route.asset} from ${route.source.name} to ${route.destination.name}${arrives}`;
}
/** The symbols MCP discovery lists for an action on a network without an official catalog. */
const tokensOf = (network: NetworkIdentity, action: StrategyAction) => supportedAssets('ENGINEERING', network.key as NetworkId).filter(asset => asset.actions.includes(action)).map(asset => asset.symbol);
/** A few example symbols of a catalog network: its pinned ERC-20s, then its declared shortcuts (stable: no loaded catalog is read). */
const examples = (network: NetworkIdentity): string => declaredNetworkSymbols(network.chain).slice(0, 5).join(', ');

/** Rule 8: which network identifiers mean real funds and which are test networks (the public product runs none of the latter). */
export const copilotNetworkRule = (scope: NetworkScope = networkScope()): string => scope === 'ENGINEERING'
  ? `${ids('MAINNET')} are mainnets with real funds. ${ids('TESTNET')} are test networks.`
  : `${ids('MAINNET')} are mainnets with real funds. ${ids('TESTNET')} are test networks: Flofi runs on mainnets only and declines them.`;
/** The transfer networks, for the UNSUPPORTED rule. */
export const copilotTransferScope = (scope: NetworkScope = networkScope()): string => names(scoped(scope, 'transfer'));

/** "What Flofi supports": one line per action, every network and route from the capability truth. */
export function copilotSupportsSection(scope: NetworkScope = networkScope()): string {
  const catalog = catalogCapabilityNetworks().filter(inScope(scope)), plain = (action: StrategyAction) => scoped(scope, action).filter(network => !network.catalog);
  const catalogLine = (action: StrategyAction) => catalog.filter(network => scoped(scope, action).includes(network));
  const swap = [...plain('swap').map(network => `${join(tokensOf(network, 'swap'))} on ${network.name}`),
    `any two tokens of the official catalog on ${names(catalogLine('swap'))} (for example ${catalogLine('swap').map(network => `${examples(network)} on ${network.name}`).join('; ')})`];
  const lending = new Map<string, NetworkIdentity[]>();
  for (const offer of lendingOffers().filter(offer => inScope(scope)(offer.network))) lending.set(offer.asset, [...lending.get(offer.asset) ?? [], offer.network]);
  const pools = plain('add_liquidity').map(network => {
    const pool = network.chain.startsWith('solana:') ? { name: 'Orca', ...COPILOT_POOLS.ORCA } : { name: 'Uniswap v3', ...COPILOT_POOLS.UNISWAP_V3 };
    return `${pool.name} ${join(tokensOf(network, 'add_liquidity'), '/')} on ${network.name} (price range in ${pool.quote} per ${pool.base}, or ticks)`;
  });
  const catalogPools = `Uniswap v3 with any two catalog tokens on ${names(catalogLine('add_liquidity'))} (fee tier ${join(COPILOT_FEE_TIERS.map(String), 'or')} percent; full range or ticks)`;
  const composition = AUTHORING_CAPABILITIES.filter(capability => capability.action === 'lending_composition' && inScope(scope)(capability.network)).map(capability =>
    `Supply ${capability.asset} on Aave, then Borrow ${capability.asset}, then Swap the borrowed ${capability.asset} to ${capability.outputAsset}, on ${capability.network.name}`);
  return [
    'What Flofi supports (generated from Flofi\'s capability registry; anything else is UNSUPPORTED):',
    `- SWAP: ${swap.join('; ')}.`,
    `- TRANSFER: ETH or any official catalog token on ${names(scoped(scope, 'transfer').filter(network => network.chain.startsWith('eip155:')))}, to the connected wallet or an explicit 0x address. ` +
      (scope === 'ENGINEERING' ? 'Solana: SOL, USDC or USDT; Solana Devnet: SOL or devUSDC.' : 'Solana: SOL, USDC or USDT.') +
      ' Solana transfers require an explicit recipient wallet public key in base58, kept case-sensitive. Never substitute the connected wallet.',
    `- BRIDGE (Cross-chain Router): ${join(bridgeOffers().filter(route => inScope(scope)(route.source) && inScope(scope)(route.destination)).map(routeText), 'or')}; optional LI.FI or Across preference and recipient.`,
    `- BRIDGE (universal Cross-chain Router): any asset Flofi knows, between any two of ${universalNames('EN')} (mainnets, real funds), including Solana in or out; ` +
      'put the source token in asset and the independently requested destination token in outputAsset (null only if unstated), and both networks. ' +
      'Recipient: an explicit 0x address for an EVM destination; for a Solana destination use the exact case-sensitive base58 public key if stated; null otherwise.',
    `- SUPPLY, BORROW, REPAY, WITHDRAW on Aave V3: ${[...lending].map(([asset, networks]) => `${asset} on ${names(networks)}`).join('; ')}; nothing else. ${lendingAmountScopeText('EN')}`,
    `- LIQUIDITY: ${[...pools, catalogPools].join('; ')}.`,
    '- AUTOMATION: SCHEDULED_DCA, PRICE_TRIGGER (USD below/above), DAILY_WATCH using the existing owner-confirmed Automation domain.',
    composition.length ? `- COMPOSITION: only ${join(composition, 'or')}.` : '- COMPOSITION: none.',
  ].join('\n');
}
