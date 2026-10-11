// SPDX-License-Identifier: AGPL-3.0-only
import { createNativeTransferNode, createTokenTransferNode, readTransferNode, TRANSFER_ACTION, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { ETHEREUM_SEPOLIA_TRANSFER, ROBINHOOD_MAINNET_TRANSFER, ROBINHOOD_TESTNET_TRANSFER, formatAssetAmount, parseAssetAmount, transferAllowsRecipients,
  transferAllowsTokens, type NativeTransferProfile } from '@defi-workflow-engine/action-registry';
import { resolveNetworkAsset } from './asset-catalogs';
/**
 * The transfer networks: the native test-ETH self-transfers of RH-DEMO-001 Robinhood Testnet and BUILD-ETHEREUM-001 Ethereum
 * Sepolia, and (BUILD-RH-002) Robinhood Chain mainnet — native ETH or a catalog asset (USDG, WETH, Stock Tokens), to the
 * connected owner or an explicit recipient.
 */
export type TransferNetwork = 'Robinhood Chain Testnet' | 'Ethereum Sepolia' | 'Robinhood Chain';
/** `asset`: 'ETH' or a catalog symbol; `recipient`: the connected owner or an explicit lower-case address. */
export type RobinhoodTransferInput = { network: TransferNetwork; asset: string; amount: string; recipient: 'CONNECTED_OWNER' | string };
export const TRANSFER_NETWORKS: Readonly<Record<TransferNetwork, NativeTransferProfile>> = Object.freeze({
  'Robinhood Chain Testnet': ROBINHOOD_TESTNET_TRANSFER, 'Ethereum Sepolia': ETHEREUM_SEPOLIA_TRANSFER, 'Robinhood Chain': ROBINHOOD_MAINNET_TRANSFER });
const WEI = 10n ** 18n;
/** Exact decimal ETH to wei; at most 18 decimals and never above the profile's cap. */
export function parseTransferAmount(value: string, profile: NativeTransferProfile = ROBINHOOD_TESTNET_TRANSFER): string {
  if (typeof value !== 'string' || value.length > 40 || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value)) throw new Error('TRANSFER_AMOUNT_INVALID');
  const [whole, fraction = ''] = value.split('.');
  const wei = BigInt(whole!) * WEI + BigInt(fraction.padEnd(18, '0'));
  if (wei <= 0n || wei > BigInt(profile.maximumValueWei)) throw new Error('TRANSFER_AMOUNT_INVALID');
  return wei.toString();
}
export function formatEth(wei: string | bigint): string {
  const value = BigInt(wei), sign = value < 0n ? '-' : '', abs = value < 0n ? -value : value;
  const fraction = (abs % WEI).toString().padStart(18, '0').replace(/0+$/, '');
  return `${sign}${abs / WEI}${fraction ? '.' + fraction : ''}`;
}
/** The transfer profile of a network name; any other name (Ethereum Mainnet included) is unsupported. */
export function transferProfileFor(network: string): NativeTransferProfile {
  const profile = Object.hasOwn(TRANSFER_NETWORKS, network) ? TRANSFER_NETWORKS[network as TransferNetwork] : undefined;
  if (!profile) throw new Error('TRANSFER_PROFILE_UNSUPPORTED');
  return profile;
}
const RECIPIENT = /^0x[0-9a-fA-F]{40}$/;
export function createAuthoredTransfer(nodeId: string, input: RobinhoodTransferInput): SemanticWorkflow['nodes'][number] {
  const profile = transferProfileFor(input.network);
  const recipient = input.recipient === 'CONNECTED_OWNER' ? 'CONNECTED_OWNER' : typeof input.recipient === 'string' && RECIPIENT.test(input.recipient) ? input.recipient.toLowerCase() : null;
  if (!recipient || (recipient !== 'CONNECTED_OWNER' && !transferAllowsRecipients(profile))) throw new Error('TRANSFER_PROFILE_UNSUPPORTED');
  if (input.asset === 'ETH') return createNativeTransferNode(nodeId, { chain: profile.chain, amount: parseTransferAmount(input.amount, profile), recipient });
  if (!transferAllowsTokens(profile)) throw new Error('TRANSFER_PROFILE_UNSUPPORTED');
  const token = resolveNetworkAsset(profile.chain, { symbol: input.asset });
  if (!token) throw new Error('ASSET_CATALOG_UNAVAILABLE');
  if (token.kind !== 'ERC20') throw new Error('TRANSFER_PROFILE_UNSUPPORTED');
  let amount: string;
  try { amount = parseAssetAmount(input.amount, token.decimals); } catch { throw new Error('TRANSFER_AMOUNT_INVALID'); }
  return createTokenTransferNode(nodeId, { chain: profile.chain, amount, recipient,
    token: { address: token.address!, decimals: token.decimals, officialId: token.stock?.officialId ?? null } });
}
export function transferDetails(node: SemanticWorkflow['nodes'][number]): RobinhoodTransferInput | null {
  if (node.actionType !== TRANSFER_ACTION) return null;
  try {
    const read = readTransferNode(node);
    const network = (Object.keys(TRANSFER_NETWORKS) as TransferNetwork[]).find(name => TRANSFER_NETWORKS[name].chain === read.fields.chain);
    if (!network) return null;
    if (read.kind === 'NATIVE') return { network, asset: 'ETH', amount: formatEth(read.fields.amount), recipient: read.fields.recipient };
    const token = resolveNetworkAsset(read.fields.chain, { address: read.fields.token.address });
    // Presentation only: an unresolved asset keeps a neutral label rather than a guessed symbol.
    const symbol = token && (token.stock?.officialId ?? null) === read.fields.token.officialId ? token.symbol : read.fields.token.officialId ? 'Stock Token' : 'Token';
    return { network, asset: symbol, amount: formatAssetAmount(read.fields.amount, read.fields.token.decimals), recipient: read.fields.recipient };
  } catch { return null; }
}
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
/** Canvas card text: "0.000001 ETH · Robinhood Testnet", "3 AAPL → 0x1234…abcd · Robinhood Chain". Display only. */
export function transferCardLabel(node: SemanticWorkflow['nodes'][number]): string {
  const details = transferDetails(node);
  return details ? `${details.amount} ${details.asset}${details.recipient === 'CONNECTED_OWNER' ? '' : ` → ${shortAddress(details.recipient)}`} · ${details.network === 'Robinhood Chain Testnet' ? 'Robinhood Testnet' : details.network}` : '';
}
