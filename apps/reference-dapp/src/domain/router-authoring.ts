// SPDX-License-Identifier: AGPL-3.0-only
import { createRouterBridgeNode, isRouterBridgeNode, readRouterBridgeNode, routerPair, ROUTER_PAIRS, type RoutingProvider, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { ETHEREUM_ROUTER_DEPLOYMENTS, type EthereumRouterNetwork, CROSSCHAIN_ROUTER_ARBITRUM_BASE, CROSSCHAIN_ROUTER_ARBITRUM_ROBINHOOD, CROSSCHAIN_ROUTER_BASE_ARBITRUM, CROSSCHAIN_ROUTER_BASE_ROBINHOOD, CROSSCHAIN_ROUTER_BASE_SEPOLIA_ARBITRUM_SEPOLIA,
  CROSSCHAIN_ROUTER_ROBINHOOD_ARBITRUM, CROSSCHAIN_ROUTER_ROBINHOOD_BASE, type RouterProfile } from '@defi-workflow-engine/action-registry';
import { authoringAssetSymbol } from './asset-catalogs';
import { catalogNetworkOfChatName, networkIdentity } from './network-registry';
import { formatTokenAmount, parseTokenAmount } from './jupiter-authoring';

/**
 * BUILD-ROUTER-001: chat and canvas author the same canonical `asset.bridge` node routed by the Cross-chain Router.
 * The owner chooses chains, token, amount, recipient (blank = the connected wallet, bound at Review), slippage and the
 * routing policy. The policy is intent (which providers may be asked, in which order); the route itself is chosen at
 * quote time and shown at Review — never silently afterwards.
 * BUILD-JOURNEY-001: the chain pair also selects the network — Base → Arbitrum One (real funds) or Base Sepolia →
 * Arbitrum Sepolia (test USDC, the permissionless journey).
 * BUILD-RH-002: Robinhood Chain in and out — Base or Arbitrum USDC → Robinhood USDG, and USDG → USDC (real funds). The source token
 * is the pair's own; the destination asset is shown explicitly because it differs.
 * BUILD-BASE-001: Base bridge IN from Arbitrum One — Arbitrum USDC → Base USDC (real funds), the reverse of the Base → Arbitrum pair.
 */
export type RouterRouting = 'AUTO' | 'LIFI' | 'ACROSS';
export type RouterSource = 'Ethereum' | 'Base' | 'Base Sepolia' | 'Arbitrum' | 'Robinhood Chain';
export type RouterDestination = 'Ethereum' | 'Arbitrum' | 'Arbitrum Sepolia' | 'Robinhood Chain' | 'Base';
export type RouterNetwork = EthereumRouterNetwork | 'mainnet' | 'testnet' | 'base-to-robinhood' | 'robinhood-to-base' | 'arbitrum-to-robinhood' | 'robinhood-to-arbitrum' | 'arbitrum-to-base';
export type RouterBridgeInput = { source: RouterSource; destination: RouterDestination; token: string; amount: string;
  /** '' = the connected wallet. */ recipient: string; slippage: string; routing: RouterRouting };
export const ROUTER_ROUTING: Readonly<Record<RouterRouting, readonly RoutingProvider[]>> = Object.freeze({ AUTO: ['lifi', 'across'], LIFI: ['lifi'], ACROSS: ['across'] });
export const ROUTER_ROUTING_LABEL: Readonly<Record<RouterRouting, string>> = Object.freeze({
  AUTO: 'Automatic: LI.FI first, Across direct if LI.FI has no reconcilable route', LIFI: 'LI.FI only', ACROSS: 'Across direct only' });
export const ROUTER_DEFAULT_SLIPPAGE = String(CROSSCHAIN_ROUTER_BASE_ARBITRUM.defaultSlippageBps);
const pairOf = (id: string) => ROUTER_PAIRS.find(pair => pair.id === id)!;
type RouterOption = { source: RouterSource; destination: RouterDestination; sourceLabel: string; destinationLabel: string; pair: (typeof ROUTER_PAIRS)[number];
  profile: RouterProfile; funds: string; environment: 'mainnet' | 'testnet' };
const robinhoodOption = (source: RouterSource, destination: RouterDestination, sourceLabel: string, destinationLabel: string, profile: RouterProfile): RouterOption =>
  Object.freeze({ source, destination, sourceLabel, destinationLabel, pair: pairOf(profile.id), profile, environment: 'mainnet' as const,
    funds: `Real funds: ${sourceLabel} and ${destinationLabel}. ${profile.source.symbol} on ${sourceLabel} arrives as ${profile.destination.symbol} on ${destinationLabel}.` });
/** One entry per supported network: its labels, its canonical pair and its deployment profile. */
export const ROUTER_NETWORK_OPTIONS = Object.freeze({
  mainnet: Object.freeze({ source: 'Base' as const, destination: 'Arbitrum' as const, sourceLabel: 'Base', destinationLabel: 'Arbitrum One', pair: ROUTER_PAIRS[0]!,
    profile: CROSSCHAIN_ROUTER_BASE_ARBITRUM, funds: 'Real funds: Base mainnet and Arbitrum One.', environment: 'mainnet' as const }),
  testnet: Object.freeze({ source: 'Base Sepolia' as const, destination: 'Arbitrum Sepolia' as const, sourceLabel: 'Base Sepolia', destinationLabel: 'Arbitrum Sepolia',
    pair: ROUTER_PAIRS[1]!, profile: CROSSCHAIN_ROUTER_BASE_SEPOLIA_ARBITRUM_SEPOLIA, funds: 'Test USDC on public testnets: Base Sepolia and Arbitrum Sepolia. No real funds.',
    environment: 'testnet' as const }),
  'base-to-robinhood': robinhoodOption('Base', 'Robinhood Chain', 'Base', 'Robinhood Chain', CROSSCHAIN_ROUTER_BASE_ROBINHOOD),
  'robinhood-to-base': robinhoodOption('Robinhood Chain', 'Base', 'Robinhood Chain', 'Base', CROSSCHAIN_ROUTER_ROBINHOOD_BASE),
  'arbitrum-to-robinhood': robinhoodOption('Arbitrum', 'Robinhood Chain', 'Arbitrum One', 'Robinhood Chain', CROSSCHAIN_ROUTER_ARBITRUM_ROBINHOOD),
  'robinhood-to-arbitrum': robinhoodOption('Robinhood Chain', 'Arbitrum', 'Robinhood Chain', 'Arbitrum One', CROSSCHAIN_ROUTER_ROBINHOOD_ARBITRUM),
  'arbitrum-to-base': Object.freeze({ source: 'Arbitrum' as const, destination: 'Base' as const, sourceLabel: 'Arbitrum One', destinationLabel: 'Base',
    pair: pairOf(CROSSCHAIN_ROUTER_ARBITRUM_BASE.id), profile: CROSSCHAIN_ROUTER_ARBITRUM_BASE, funds: 'Real funds: Arbitrum One and Base mainnet.', environment: 'mainnet' as const }),
  ...Object.fromEntries(Object.entries(ETHEREUM_ROUTER_DEPLOYMENTS).map(([key, profile]) => [key,
    robinhoodOption(profile.source.network === 'Arbitrum One' ? 'Arbitrum' : profile.source.network as RouterSource,
      profile.destination.network === 'Arbitrum One' ? 'Arbitrum' : profile.destination.network as RouterDestination,
      profile.source.network, profile.destination.network, profile)])) as Record<EthereumRouterNetwork, RouterOption>,
}) satisfies Readonly<Record<RouterNetwork, RouterOption>>;
/**
 * BUILD-BASE-001: the code a route reports while its deployment gate is off (as `app/router-action.ts` refuses it): the testnet Router, a
 * Robinhood Chain route (`GRYLOO_ROBINHOOD_MAINNET`), or the Router itself (`GRYLOO_ROUTER`: Base → Arbitrum One and Arbitrum One → Base).
 */
export const routerDisabledCode = (network: RouterNetwork): string => network in ETHEREUM_ROUTER_DEPLOYMENTS ? 'ETHEREUM_MAINNET_NOT_ENABLED' : network === 'testnet' ? 'ROUTER_TESTNET_NOT_ENABLED'
  : [ROUTER_NETWORK_OPTIONS[network].source, ROUTER_NETWORK_OPTIONS[network].destination].includes('Robinhood Chain') ? 'ROBINHOOD_MAINNET_NOT_ENABLED' : 'ROUTER_NOT_ENABLED';
/** The router networks (pairs) of a wallet environment: Base ⇄ Arbitrum and the Robinhood routes on mainnet, the test pair on testnet. */
export const routerNetworksOf = (environment: 'mainnet' | 'testnet'): readonly RouterNetwork[] =>
  (Object.keys(ROUTER_NETWORK_OPTIONS) as RouterNetwork[]).filter(network => ROUTER_NETWORK_OPTIONS[network].environment === environment);
export function routerNetworkOfInput(input: Pick<RouterBridgeInput, 'source' | 'destination'>): RouterNetwork | null {
  return (Object.keys(ROUTER_NETWORK_OPTIONS) as RouterNetwork[]).find(n => ROUTER_NETWORK_OPTIONS[n].source === input.source &&
    ROUTER_NETWORK_OPTIONS[n].destination === input.destination) ?? null;
}
/**
 * BUILD-RH-002: the chain choices of an environment's routes for the Canvas pickers — every source, and the destinations that form a
 * supported pair with `source` (Base → Arbitrum One or Robinhood Chain; Arbitrum → Robinhood Chain or Base; Robinhood Chain → Base or Arbitrum).
 */
export function routerChainChoices(environment: 'mainnet' | 'testnet', source?: RouterSource): { sources: RouterSource[]; destinations: RouterDestination[] } {
  const options = routerNetworksOf(environment).map(n => ROUTER_NETWORK_OPTIONS[n]);
  return { sources: [...new Set(options.map(o => o.source))], destinations: [...new Set(options.filter(o => source === undefined || o.source === source).map(o => o.destination))] };
}
/** The assets of a chosen route: the pair's own source and destination tokens (USDC → USDG into Robinhood Chain), or null when unsupported. */
export function routerTokensOf(networks: Pick<RouterBridgeInput, 'source' | 'destination'>): { token: string; destinationToken: string } | null {
  const network = routerNetworkOfInput(networks);
  return network ? { token: ROUTER_NETWORK_OPTIONS[network].pair.source.symbol, destinationToken: ROUTER_NETWORK_OPTIONS[network].pair.destination.symbol } : null;
}
/** Re-targets an input to other chains; the token follows the chosen pair (an unsupported pair keeps it and fails at node creation). */
export function routerInputForNetworks(input: RouterBridgeInput, networks: Pick<RouterBridgeInput, 'source' | 'destination'>): RouterBridgeInput {
  return { ...input, source: networks.source, destination: networks.destination, token: routerTokensOf(networks)?.token ?? input.token };
}
const routingOf = (providers: readonly string[]): RouterRouting | null =>
  (Object.keys(ROUTER_ROUTING) as RouterRouting[]).find(k => ROUTER_ROUTING[k].join() === providers.join()) ?? null;

export function createRouterNode(nodeId: string, input: RouterBridgeInput): SemanticWorkflow['nodes'][number] {
  const network = routerNetworkOfInput(input);
  if (!network) throw new Error('ROUTER_PAIR_UNSUPPORTED');
  const source = ROUTER_NETWORK_OPTIONS[network].pair.source;
  let symbol: string;
  try { symbol = networkIdentity(source.chainId)?.catalog ? authoringAssetSymbol(source.chainId, input.token) : input.token; }
  catch { throw new Error('ROUTER_PAIR_UNSUPPORTED'); }
  if (symbol !== source.symbol) throw new Error('ROUTER_PAIR_UNSUPPORTED');
  const pair = ROUTER_NETWORK_OPTIONS[network].pair;
  if (!Object.hasOwn(ROUTER_ROUTING, input.routing)) throw new Error('ROUTER_PROVIDER_POLICY_INVALID');
  if (!/^[1-9][0-9]{0,3}$/.test(input.slippage)) throw new Error('ROUTER_SLIPPAGE_OUT_OF_RANGE');
  const recipient = input.recipient.trim();
  if (recipient !== '' && !/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error('ROUTER_RECIPIENT_INVALID');
  return createRouterBridgeNode(nodeId, { sourceChain: pair.source.chainId, destinationChain: pair.destination.chainId, inputToken: pair.source.address,
    outputToken: pair.destination.address, amount: parseTokenAmount(input.amount.trim(), pair.source.decimals),
    recipient: recipient === '' ? 'CONNECTED_OWNER' : recipient.toLowerCase(), slippageBps: Number(input.slippage), providers: ROUTER_ROUTING[input.routing] });
}
export type RouterDetails = RouterBridgeInput & { units: string; recipientLabel: string; network: RouterNetwork;
  /** The asset delivered on the destination chain (it may differ from the source token: USDC → USDG). */ destinationToken: string };
export function routerDetails(node: SemanticWorkflow['nodes'][number] | { readonly actionType: string }): RouterDetails | null {
  if (!('adapterConstraints' in node) || !isRouterBridgeNode(node)) return null;
  try {
    const f = readRouterBridgeNode({ ...node, dependencies: [] }), routing = routingOf(f.providers), pair = routerPair(f.sourceChain, f.inputToken, f.destinationChain, f.outputToken);
    const network = (Object.keys(ROUTER_NETWORK_OPTIONS) as RouterNetwork[]).find(n => ROUTER_NETWORK_OPTIONS[n].pair.id === pair?.id);
    if (!routing || !pair || !network) return null;
    const option = ROUTER_NETWORK_OPTIONS[network];
    return { source: option.source, destination: option.destination, token: pair.source.symbol, destinationToken: pair.destination.symbol,
      amount: formatTokenAmount(f.amount, pair.source.decimals), units: f.amount,
      recipient: f.recipient === 'CONNECTED_OWNER' ? '' : f.recipient, recipientLabel: f.recipient === 'CONNECTED_OWNER' ? 'your connected wallet' : f.recipient,
      slippage: String(f.slippageBps), routing, network };
  } catch { return null; }
}
/** The router network of a workflow's bridge node, or null when the workflow has none. */
export function routerNetworkOf(workflow: { readonly nodes: readonly (SemanticWorkflow['nodes'][number] | { readonly actionType: string })[] }): RouterNetwork | null {
  for (const node of workflow.nodes) { const details = routerDetails(node); if (details) return details.network; }
  return null;
}
/** Editing input that reproduces the node exactly. */
export const routerInputOf = (d: RouterDetails): RouterBridgeInput =>
  ({ source: d.source, destination: d.destination, token: d.token, amount: d.amount, recipient: d.recipient, slippage: d.slippage, routing: d.routing });
const routerChatNetworks = [...new Set(Object.values(ROUTER_NETWORK_OPTIONS).flatMap(option => [option.sourceLabel, option.destinationLabel]))]
  .map(label => `(?:${networkIdentity(label)?.chatName?.source ?? label})`).join('|');
export const ROUTER_CHAT_PATTERN = new RegExp(String.raw`^(?:bridge|move|manda|traga) ([0-9]+(?:\.[0-9]+)?) ([^\x00-\x1f\x7f]{1,160}?) (?:from|da|de|do) (${routerChatNetworks}) (?:to|para) (?:a |o )?(${routerChatNetworks})(?: (?:to|recipient) (0x[0-9a-fA-F]{40}))?(?: via (LI\.FI|LIFI|Across|auto))?(?: (?:with )?slippage ([0-9]+) bps)?$`, 'i');
const chainName = (text: string) => {
  const identity = catalogNetworkOfChatName(text) ?? Object.values(ROUTER_NETWORK_OPTIONS)
    .flatMap(option => [option.sourceLabel, option.destinationLabel]).map(networkIdentity)
    .find(network => network?.name.toLowerCase() === text.toLowerCase());
  const option = Object.values(ROUTER_NETWORK_OPTIONS).find(option => networkIdentity(option.sourceLabel) === identity);
  return option?.source ?? Object.values(ROUTER_NETWORK_OPTIONS).find(option => networkIdentity(option.destinationLabel) === identity)?.destination;
};
/**
 * "Bridge 5 USDC from Base [Sepolia] to Arbitrum [Sepolia] [to 0x…] [via LI.FI|Across|auto] [slippage 50 bps]"; BUILD-RH-002 adds
 * "Bridge 100 USDC from Base to Robinhood" and "Bridge 50 USDG from Robinhood to Arbitrum". The pair must exist and the token must be
 * its source token (USDC into Robinhood, USDG out); mixed networks and any other combination are refused. BUILD-ARB-001 adds shared
 * "move ... from ... to ..." and "manda/traga ... da ... para ..." aliases; all retain the same pair validation and defaults.
 */
export function parseRouterChat(text: string): RouterBridgeInput | null {
  const m = ROUTER_CHAT_PATTERN.exec(text.trim());
  if (!m) return null;
  const input = { source: chainName(m[3]!) as RouterSource, destination: chainName(m[4]!) as RouterDestination };
  const network = routerNetworkOfInput(input);
  if (!network) return null;
  const source = ROUTER_NETWORK_OPTIONS[network].pair.source;
  let token: string;
  try { token = networkIdentity(source.chainId)?.catalog ? authoringAssetSymbol(source.chainId, m[2]!) : m[2]!.toUpperCase(); } catch { return null; }
  if (source.symbol !== token) return null;
  const via = (m[6] ?? 'auto').toLowerCase();
  return { ...input, token, amount: m[1]!, recipient: m[5]?.toLowerCase() ?? '', slippage: m[7] ?? ROUTER_DEFAULT_SLIPPAGE,
    routing: via === 'across' ? 'ACROSS' : via === 'auto' ? 'AUTO' : 'LIFI' };
}
