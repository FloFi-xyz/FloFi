// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: chat, Canvas, MCP and channels author the same canonical universal bridge node (`flofi.router.universal`).
 *
 * The owner chooses the source network, source asset, destination network, destination asset, amount, recipient and slippage, and either
 * lets FloFi pick the route transparently (`BEST`: the executable route with the highest guaranteed minimum) or pins a provider. Assets
 * resolve through FloFi's own catalogs (pinned and server-validated official catalogs on EVM networks, the verified Solana token list), or
 * as an explicit contract/mint written `<address>@<decimals>` (decimals and code are verified on chain at Simulate). Nothing is guessed:
 * an unknown or ambiguous asset is refused; a destination asset FloFi chooses by default is stated in the composition notes and shown at
 * Review before anything is authorized.
 */
import { SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { createUniversalBridgeNode, isSolanaPublicKey, isUniversalBridgeNode, readUniversalBridgeNode, UNIVERSAL_NETWORKS, universalNetworkOfChain, type UniversalAssetRef,
  type UniversalBridgeFields, type UniversalNetworkKey, type UniversalRouteSelection, type UniversalRoutingProvider, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { resolveNetworkAsset } from './asset-catalogs';
import { formatTokenAmount, parseTokenAmount } from './jupiter-authoring';

export type UniversalBridgeRouting = 'BEST' | 'RELAY' | 'LIFI' | 'MAYAN' | 'ACROSS';
/** Every value is a string so the Canvas form, chat and the editor command validate the same closed shape. */
export type UniversalBridgeInput = { source: UniversalNetworkKey; destination: UniversalNetworkKey; inputAsset: string; outputAsset: string; amount: string;
  /** '' = the connected wallet (same ecosystem) or the connected destination wallet (across ecosystems), bound at Review. */ recipient: string;
  slippage: string; routing: UniversalBridgeRouting };
export const UNIVERSAL_BRIDGE_ROUTING: Readonly<Record<UniversalBridgeRouting, { providers: readonly UniversalRoutingProvider[]; selection: UniversalRouteSelection }>> = Object.freeze({
  BEST: { providers: ['relay', 'lifi', 'mayan', 'across'], selection: 'BEST_MINIMUM_OUTPUT' }, RELAY: { providers: ['relay'], selection: 'PREFERENCE_ORDER' },
  LIFI: { providers: ['lifi'], selection: 'PREFERENCE_ORDER' }, MAYAN: { providers: ['mayan'], selection: 'PREFERENCE_ORDER' }, ACROSS: { providers: ['across'], selection: 'PREFERENCE_ORDER' } });
export const UNIVERSAL_BRIDGE_ROUTING_LABEL: Readonly<Record<UniversalBridgeRouting, string>> = Object.freeze({
  BEST: 'Automatic: the executable route with the highest guaranteed minimum', RELAY: 'Relay only', LIFI: 'LI.FI only (quotes; execution not available yet)',
  MAYAN: 'Mayan only (quotes; execution not available yet)', ACROSS: 'Across only (certified Router pairs)' });
export const UNIVERSAL_BRIDGE_DEFAULT_SLIPPAGE = '50';
export const UNIVERSAL_BRIDGE_NETWORKS: readonly { readonly key: UniversalNetworkKey; readonly label: string }[] = Object.freeze(
  (Object.keys(UNIVERSAL_NETWORKS) as UniversalNetworkKey[]).map(key => Object.freeze({ key, label: UNIVERSAL_NETWORKS[key].name })));
const fail = (code: string): never => { throw new Error(code); };
const STABLE_USD = ['USDC', 'USDG'];

export type ResolvedUniversalAsset = { readonly asset: UniversalAssetRef; readonly symbol: string };
/** An asset of a network by symbol (catalogs, case-insensitive), its native coin, or `<address>@<decimals>`. Unknown references are refused. */
export function resolveUniversalAsset(key: UniversalNetworkKey, reference: string): ResolvedUniversalAsset {
  const network = UNIVERSAL_NETWORKS[key];
  if (typeof reference !== 'string' || !reference.trim()) return fail('UNIVERSAL_ASSET_REQUIRED');
  const text = reference.trim(), explicit = /^([^@\s]+)@([0-9]{1,2})$/.exec(text);
  if (explicit) {
    const address = explicit[1]!, decimals = Number(explicit[2]);
    if (network.ecosystem === 'EVM' ? !/^0x[0-9a-fA-F]{40}$/.test(address) : !isSolanaPublicKey(address)) return fail('UNIVERSAL_ASSET_ADDRESS_INVALID');
    const known = network.ecosystem === 'EVM' ? resolveNetworkAsset(network.chain, { address: address.toLowerCase() })
      : Object.values(SOLANA_MAINNET_TOKENS).find(t => t.mint === address) ?? null;
    if (known && known.decimals !== decimals) return fail('UNIVERSAL_ASSET_DECIMALS_MISMATCH');
    return { asset: { kind: 'TOKEN', address: network.ecosystem === 'EVM' ? address.toLowerCase() : address, decimals }, symbol: known?.symbol ?? 'TOKEN' };
  }
  const symbol = text.toUpperCase();
  if (symbol === network.native.symbol) return { asset: { kind: 'NATIVE', decimals: network.native.decimals }, symbol: network.native.symbol };
  if (network.ecosystem === 'SOLANA') {
    const token = Object.values(SOLANA_MAINNET_TOKENS).find(t => t.symbol === symbol && !t.native);
    return token ? { asset: { kind: 'TOKEN', address: token.mint, decimals: token.decimals }, symbol: token.symbol } : fail('UNIVERSAL_ASSET_UNKNOWN');
  }
  const asset = resolveNetworkAsset(network.chain, { symbol: text });
  if (!asset) return fail('UNIVERSAL_ASSET_UNKNOWN');
  return asset.address === null ? { asset: { kind: 'NATIVE', decimals: asset.decimals }, symbol: asset.symbol }
    : { asset: { kind: 'TOKEN', address: asset.address, decimals: asset.decimals }, symbol: asset.symbol };
}
/**
 * The destination asset FloFi proposes when the owner names none (always stated in the notes and shown at Review): the same asset when the
 * destination has it; the dollar stablecoin of the destination for USDC/USDG (Robinhood Chain's is USDG); the destination's native coin for
 * a native coin (SOL ⇄ ETH). Anything else requires the owner to name the destination asset.
 */
export function defaultUniversalOutput(source: UniversalNetworkKey, inputSymbol: string, destination: UniversalNetworkKey): string {
  const symbol = inputSymbol.toUpperCase(), dst = UNIVERSAL_NETWORKS[destination];
  if (STABLE_USD.includes(symbol)) return destination === 'robinhood' ? 'USDG' : 'USDC';
  if (symbol === UNIVERSAL_NETWORKS[source].native.symbol) return dst.native.symbol;
  try { resolveUniversalAsset(destination, symbol); return symbol; } catch { return fail('UNIVERSAL_OUTPUT_ASSET_REQUIRED'); }
}
/** The canonical fields of a universal bridge input (amount parsed with the input asset's decimals). */
export function universalBridgeFields(input: UniversalBridgeInput): UniversalBridgeFields {
  const source = UNIVERSAL_NETWORKS[input.source] ?? fail('UNIVERSAL_SOURCE_NETWORK_UNSUPPORTED'), destination = UNIVERSAL_NETWORKS[input.destination] ?? fail('UNIVERSAL_DESTINATION_NETWORK_UNSUPPORTED');
  if (source.key === destination.key) fail('UNIVERSAL_SAME_NETWORK');
  const inAsset = resolveUniversalAsset(input.source, input.inputAsset), outAsset = resolveUniversalAsset(input.destination, input.outputAsset);
  let amount: string;
  try { amount = parseTokenAmount(input.amount, inAsset.asset.decimals); } catch { return fail('UNIVERSAL_AMOUNT_INVALID'); }
  if (!/^[1-9][0-9]*$/.test(input.slippage)) fail('UNIVERSAL_SLIPPAGE_OUT_OF_RANGE');
  const routing = UNIVERSAL_BRIDGE_ROUTING[input.routing] ?? fail('UNIVERSAL_ROUTING_INVALID');
  const cross = source.ecosystem !== destination.ecosystem, recipient = input.recipient.trim();
  return { sourceChain: source.chain, destinationChain: destination.chain, inputAsset: inAsset.asset, outputAsset: outAsset.asset, amount,
    recipient: recipient === '' ? cross ? 'CONNECTED_DESTINATION_WALLET' : 'CONNECTED_OWNER' : recipient, slippageBps: Number(input.slippage),
    providers: [...routing.providers], selection: routing.selection };
}
export function createUniversalBridgeFromInput(nodeId: string, input: UniversalBridgeInput) { return createUniversalBridgeNode(nodeId, universalBridgeFields(input)); }

export type UniversalBridgeDetails = { readonly source: UniversalNetworkKey; readonly destination: UniversalNetworkKey; readonly sourceLabel: string; readonly destinationLabel: string;
  readonly inputSymbol: string; readonly outputSymbol: string; readonly inputDecimals: number; readonly outputDecimals: number; readonly amount: string;
  readonly amountUnits: string; readonly recipient: string; readonly slippage: string; readonly routing: UniversalBridgeRouting; readonly fields: UniversalBridgeFields };
const symbolOf = (key: UniversalNetworkKey, asset: UniversalAssetRef) => {
  const network = UNIVERSAL_NETWORKS[key];
  if (asset.kind === 'NATIVE') return network.native.symbol;
  if (network.ecosystem === 'SOLANA') return Object.values(SOLANA_MAINNET_TOKENS).find(t => t.mint === asset.address)?.symbol ?? `${asset.address}@${asset.decimals}`;
  return resolveNetworkAsset(network.chain, { address: asset.address })?.symbol ?? `${asset.address}@${asset.decimals}`;
};
const routingOf = (fields: UniversalBridgeFields): UniversalBridgeRouting =>
  (Object.keys(UNIVERSAL_BRIDGE_ROUTING) as UniversalBridgeRouting[]).find(k => UNIVERSAL_BRIDGE_ROUTING[k].selection === fields.selection &&
    UNIVERSAL_BRIDGE_ROUTING[k].providers.join() === fields.providers.join()) ?? 'BEST';
/** Readable details of a universal bridge node (labels, symbols, the decimal amount), or null for any other node. */
export function universalBridgeDetails(node: SemanticWorkflow['nodes'][number] | { readonly actionType: string }): UniversalBridgeDetails | null {
  if (!('adapterConstraints' in node) || !isUniversalBridgeNode(node)) return null;
  let fields: UniversalBridgeFields;
  try { fields = readUniversalBridgeNode({ ...node, dependencies: [] } as unknown as SemanticWorkflow['nodes'][number]); } catch { return null; }
  const source = universalNetworkOfChain(fields.sourceChain)!.key, destination = universalNetworkOfChain(fields.destinationChain)!.key;
  return { source, destination, sourceLabel: UNIVERSAL_NETWORKS[source].name, destinationLabel: UNIVERSAL_NETWORKS[destination].name,
    inputSymbol: symbolOf(source, fields.inputAsset), outputSymbol: symbolOf(destination, fields.outputAsset), inputDecimals: fields.inputAsset.decimals,
    outputDecimals: fields.outputAsset.decimals, amount: formatTokenAmount(fields.amount, fields.inputAsset.decimals), amountUnits: fields.amount,
    recipient: fields.recipient === 'CONNECTED_OWNER' || fields.recipient === 'CONNECTED_DESTINATION_WALLET' ? '' : fields.recipient, slippage: String(fields.slippageBps),
    routing: routingOf(fields), fields };
}
export const universalInputOf = (d: UniversalBridgeDetails): UniversalBridgeInput => ({ source: d.source, destination: d.destination, inputAsset: d.inputSymbol,
  outputAsset: d.outputSymbol, amount: d.amount, recipient: d.recipient, slippage: d.slippage, routing: d.routing });
/** The universal bridge node of a workflow, if it is one. */
export const universalBridgeOfWorkflow = (workflow: SemanticWorkflow) => workflow.nodes.length === 1 ? universalBridgeDetails(workflow.nodes[0]!) : null;

/** The Canvas Bridge card's network labels (the certified Router's labels, plus Solana). */
export const UNIVERSAL_CANVAS_LABEL: Readonly<Record<UniversalNetworkKey, string>> = Object.freeze({ solana: 'Solana', base: 'Base', 'arbitrum-one': 'Arbitrum', ethereum: 'Ethereum',
  robinhood: 'Robinhood Chain' });
export const universalKeyOfCanvasLabel = (label: string): UniversalNetworkKey | null =>
  (Object.keys(UNIVERSAL_CANVAS_LABEL) as UniversalNetworkKey[]).find(key => UNIVERSAL_CANVAS_LABEL[key] === label) ?? null;
/** A Canvas pair the certified Router does not serve but the universal router does (today: Solana in or out of any EVM mainnet), or null. */
export function universalCanvasPair(networks: { readonly source: string; readonly destination: string }): { source: UniversalNetworkKey; destination: UniversalNetworkKey } | null {
  const source = universalKeyOfCanvasLabel(networks.source), destination = universalKeyOfCanvasLabel(networks.destination);
  return source && destination && source !== destination && (source === 'solana' || destination === 'solana') ? { source, destination } : null;
}
/** The universal bridge a new Canvas Bridge card authors for such a pair: the source network's dollar stablecoin and the stated default destination asset. */
export function universalCanvasInput(pair: { source: UniversalNetworkKey; destination: UniversalNetworkKey }, amount: string): UniversalBridgeInput {
  const inputAsset = pair.source === 'robinhood' ? 'USDG' : 'USDC';
  return { source: pair.source, destination: pair.destination, inputAsset, outputAsset: defaultUniversalOutput(pair.source, inputAsset, pair.destination), amount, recipient: '',
    slippage: UNIVERSAL_BRIDGE_DEFAULT_SLIPPAGE, routing: 'BEST' };
}
