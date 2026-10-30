// SPDX-License-Identifier: AGPL-3.0-only
import { createNativeTransferNode, createTokenTransferNode, isSolanaTransferNode, readTransferNode, TRANSFER_ACTION, type SemanticWorkflow, type SolanaTokenProgram } from '@defi-workflow-engine/workflow-contracts';
import { NATIVE_TRANSFER_PROFILES, ROBINHOOD_TESTNET_TRANSFER, formatAssetAmount, parseAssetAmount, transferAllowsRecipients,
  transferAllowsTokens, type NativeTransferProfile } from '@defi-workflow-engine/action-registry';
import { authoringAssetSymbol, resolveNetworkAsset } from './asset-catalogs';
import { createSolanaTransferNodeFrom, solanaTransferDetails } from './solana-transfer-authoring';
/**
 * The transfer networks: the native test-ETH self-transfers of RH-DEMO-001 Robinhood Testnet and BUILD-ETHEREUM-001 Ethereum
 * Sepolia, and (BUILD-RH-002) Robinhood Chain mainnet — native ETH or a catalog asset (USDG, WETH, Stock Tokens), to the
 * connected owner or an explicit recipient. BUILD-BASE-001: Base mainnet on the same terms (ETH or a Base catalog token; the OP Stack L1 fee
 * is part of the reviewed fee budget).
 */
export type EvmTransferNetwork = NativeTransferProfile['network'];
/**
 * BUILD-SOLANA-TRANSFER-UX-001: the same Send authoring (Canvas card, chat grammar, Copilot, channels and MCP) also covers Solana mainnet-beta and
 * Devnet, whose transfers are their own canonical declaration (System Program / SPL TransferChecked) with an always-explicit recipient.
 */
export const SOLANA_TRANSFER_NETWORKS = ['Solana', 'Solana Devnet'] as const;
export type TransferNetwork = EvmTransferNetwork | typeof SOLANA_TRANSFER_NETWORKS[number];
export const isSolanaTransferNetwork = (network: string): network is typeof SOLANA_TRANSFER_NETWORKS[number] => (SOLANA_TRANSFER_NETWORKS as readonly string[]).includes(network);
/**
 * `asset`: 'ETH' or a catalog symbol (Solana: SOL, USDC, USDT, devUSDC or an SPL mint address); `recipient`: the connected owner or an explicit
 * address (Solana: always an explicit wallet address). `decimals`/`program`: only for a Solana SPL mint named by address.
 */
export type RobinhoodTransferInput = { network: TransferNetwork; asset: string; amount: string; recipient: 'CONNECTED_OWNER' | string; decimals?: string; program?: SolanaTokenProgram };
export const TRANSFER_NETWORKS: Readonly<Record<EvmTransferNetwork, NativeTransferProfile>> = Object.freeze(Object.fromEntries(NATIVE_TRANSFER_PROFILES.map(profile => [profile.network, profile])) as Record<EvmTransferNetwork, NativeTransferProfile>);
const WEI = 10n ** 18n;
/** Exact decimal ETH to wei; at most 18 decimals and never above the profile's cap. */
export function parseTransferAmount(value: string, profile: NativeTransferProfile = ROBINHOOD_TESTNET_TRANSFER): string {
  if (typeof value !== 'string' || value.length > 80 || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value)) throw new Error('TRANSFER_AMOUNT_INVALID');
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
  const profile = Object.hasOwn(TRANSFER_NETWORKS, network) ? TRANSFER_NETWORKS[network as EvmTransferNetwork] : undefined;
  if (!profile) throw new Error('TRANSFER_PROFILE_UNSUPPORTED');
  return profile;
}
const RECIPIENT = /^0x[0-9a-fA-F]{40}$/;
export function createAuthoredTransfer(nodeId: string, input: RobinhoodTransferInput): SemanticWorkflow['nodes'][number] {
  if (isSolanaTransferNetwork(input.network)) {
    // A Solana transfer never defaults to the signing wallet: the destination is always explicit.
    if (input.recipient === 'CONNECTED_OWNER' || !input.recipient) throw new Error('SOLANA_TRANSFER_RECIPIENT_REQUIRED');
    return createSolanaTransferNodeFrom(nodeId, { network: input.network, asset: input.asset, amount: input.amount, recipient: input.recipient,
      ...input.decimals === undefined ? {} : { decimals: input.decimals }, ...input.program === undefined ? {} : { program: input.program } });
  }
  if (input.decimals !== undefined || input.program !== undefined) throw new Error('TRANSFER_PROFILE_UNSUPPORTED');
  const profile = transferProfileFor(input.network);
  const recipient = input.recipient === 'CONNECTED_OWNER' ? 'CONNECTED_OWNER' : typeof input.recipient === 'string' && RECIPIENT.test(input.recipient) ? input.recipient.toLowerCase() : null;
  if (!recipient || (recipient !== 'CONNECTED_OWNER' && !transferAllowsRecipients(profile))) throw new Error('TRANSFER_PROFILE_UNSUPPORTED');
  const symbol = transferAllowsTokens(profile) ? authoringAssetSymbol(profile.chain, input.asset) : input.asset;
  if (symbol === 'ETH') return createNativeTransferNode(nodeId, { chain: profile.chain, amount: parseTransferAmount(input.amount, profile), recipient });
  if (!transferAllowsTokens(profile)) throw new Error('TRANSFER_PROFILE_UNSUPPORTED');
  const token = resolveNetworkAsset(profile.chain, { symbol });
  if (!token) throw new Error('ASSET_CATALOG_UNAVAILABLE');
  if (token.kind !== 'ERC20') throw new Error('TRANSFER_PROFILE_UNSUPPORTED');
  let amount: string;
  try { amount = parseAssetAmount(input.amount, token.decimals); } catch { throw new Error('TRANSFER_AMOUNT_INVALID'); }
  return createTokenTransferNode(nodeId, { chain: profile.chain, amount, recipient,
    token: { address: token.address!, decimals: token.decimals, officialId: token.stock?.officialId ?? null } });
}
export function transferDetails(node: SemanticWorkflow['nodes'][number]): RobinhoodTransferInput | null {
  if (node.actionType !== TRANSFER_ACTION) return null;
  if (isSolanaTransferNode(node)) {
    const solana = solanaTransferDetails(node);
    return solana ? { network: solana.network, asset: solana.asset, amount: solana.amount, recipient: solana.recipient,
      ...solana.decimals === undefined ? {} : { decimals: solana.decimals }, ...solana.program === undefined ? {} : { program: solana.program } } : null;
  }
  try {
    const read = readTransferNode({ ...node, dependencies: [] });
    const network = (Object.keys(TRANSFER_NETWORKS) as EvmTransferNetwork[]).find(name => TRANSFER_NETWORKS[name]?.chain === read.fields.chain);
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
  const asset = details && isSolanaTransferNetwork(details.network) && details.decimals !== undefined ? shortAddress(details.asset) : details?.asset;
  return details ? `${details.amount} ${asset}${details.recipient === 'CONNECTED_OWNER' ? '' : ` → ${shortAddress(details.recipient)}`} · ${details.network === 'Robinhood Chain Testnet' ? 'Robinhood Testnet' : details.network}` : '';
}
