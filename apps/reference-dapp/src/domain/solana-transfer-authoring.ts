// SPDX-License-Identifier: AGPL-3.0-only
import { createSolanaTransferNode, isSolanaTransferNode, readSolanaTransferNode, type SemanticWorkflow, type SolanaTokenProgram } from '@defi-workflow-engine/workflow-contracts';
import { SOLANA_DEVNET_TRANSFER, SOLANA_MAINNET_TRANSFER, solanaTransferAsset, solanaTransferProfile, type SolanaTransferProfile } from '@defi-workflow-engine/action-registry';
import { formatTokenAmount, parseTokenAmount, type SolanaNetwork } from './jupiter-authoring';

/**
 * BUILD-SOLANA-TRANSFER-UX-001: Canvas, Copilot, chat and MCP all author the same canonical Solana transfer. `asset` is a verified symbol of the
 * cluster (SOL, USDC, USDT on mainnet; SOL and devUSDC on Devnet) or an SPL mint address, which then needs its decimals and token program;
 * the chain verifies all three at Simulate. The recipient is always explicit and never defaults to the signing wallet.
 */
export type SolanaTransferInput = { network: SolanaNetwork; asset: string; amount: string; recipient: string; decimals?: string; program?: SolanaTokenProgram };
export type SolanaTransferDetails = SolanaTransferInput & { symbol: string; label: string; mint: string | null; verified: boolean; units: string; decimalsValue: number;
  programValue: 'native' | SolanaTokenProgram };
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const solanaTransferProfileFor = (network: SolanaNetwork): SolanaTransferProfile => network === 'Solana Devnet' ? SOLANA_DEVNET_TRANSFER : SOLANA_MAINNET_TRANSFER;
/** The assets the Canvas offers on a cluster, by symbol (any other SPL mint is entered by address). */
export const solanaTransferSymbols = (network: SolanaNetwork) => solanaTransferProfileFor(network).assets.map(asset => asset.symbol);
export function createSolanaTransferNodeFrom(nodeId: string, input: SolanaTransferInput): SemanticWorkflow['nodes'][number] {
  const profile = solanaTransferProfileFor(input.network), recipient = input.recipient.trim();
  if (!recipient) throw new Error('SOLANA_TRANSFER_RECIPIENT_REQUIRED');
  if (!BASE58.test(recipient)) throw new Error('SOLANA_TRANSFER_RECIPIENT_INVALID');
  const reference = input.asset.trim(), known = solanaTransferAsset(profile, reference);
  if (known && (input.decimals !== undefined && Number(input.decimals) !== known.decimals || input.program !== undefined && input.program !== known.program))
    throw new Error('SOLANA_TRANSFER_MINT_DECIMALS_MISMATCH');
  if (known && known.program === 'native') return createSolanaTransferNode(nodeId, { chain: profile.chain, amount: parseTokenAmount(input.amount, 9), recipient, token: null });
  if (known) return createSolanaTransferNode(nodeId, { chain: profile.chain, amount: parseTokenAmount(input.amount, known.decimals), recipient,
    token: { mint: known.mint!, decimals: known.decimals, program: known.program as SolanaTokenProgram } });
  if (!BASE58.test(reference)) throw new Error('SOLANA_TRANSFER_ASSET_UNSUPPORTED');
  // Another SPL token is named by mint; its decimals and program are stated by the author and verified against the chain at Simulate.
  if (!input.decimals || !/^(0|[1-9][0-9]?)$/.test(input.decimals) || Number(input.decimals) > 18) throw new Error('SOLANA_TRANSFER_DECIMALS_REQUIRED');
  if (input.program !== 'spl-token' && input.program !== 'token-2022') throw new Error('SOLANA_TRANSFER_TOKEN_PROGRAM_REQUIRED');
  const decimals = Number(input.decimals);
  return createSolanaTransferNode(nodeId, { chain: profile.chain, amount: parseTokenAmount(input.amount, decimals), recipient, token: { mint: reference, decimals, program: input.program } });
}
export function solanaTransferDetails(node: SemanticWorkflow['nodes'][number] | { readonly actionType: string; readonly chainId: string; readonly adapterConstraints?: unknown }): SolanaTransferDetails | null {
  if (!('adapterConstraints' in node) || !node.adapterConstraints || !isSolanaTransferNode(node as SemanticWorkflow['nodes'][number])) return null;
  try {
    const fields = readSolanaTransferNode({ ...(node as SemanticWorkflow['nodes'][number]), dependencies: [] });
    const profile = solanaTransferProfile(fields.chain);
    if (!profile) return null;
    const network = profile.network, known = solanaTransferAsset(profile, fields.token?.mint ?? 'SOL');
    const decimals = fields.token?.decimals ?? 9, symbol = fields.token ? known?.symbol ?? 'SPL token' : 'SOL';
    return { network, asset: fields.token ? known?.symbol ?? fields.token.mint : 'SOL', amount: formatTokenAmount(fields.amount, decimals), recipient: fields.recipient,
      ...fields.token && !known ? { decimals: String(fields.token.decimals), program: fields.token.program } : {},
      symbol, label: fields.token ? known?.label ?? `${fields.token.mint.slice(0, 4)}…${fields.token.mint.slice(-4)}` : known?.label ?? 'SOL', mint: fields.token?.mint ?? null,
      verified: !fields.token || Boolean(known), units: fields.amount, decimalsValue: decimals, programValue: fields.token?.program ?? 'native' };
  } catch { return null; }
}
export const shortSolanaAddress = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;
/** "send 0.5 SOL to <address> on Solana [Devnet]" (also transfer / pay). Only verified symbols or an explicit mint; the recipient is required. */
export const SOLANA_TRANSFER_PATTERN = /^(?:send|transfer|pay|enviar?|transferir)\s+([0-9]+(?:[.,][0-9]+)?)\s+(SOL|USDC|USDT|devUSDC)\s+(?:to|para)\s+([1-9A-HJ-NP-Za-km-z]{32,44})(?:\s+(?:on|na|em)\s+Solana(\s+Devnet)?)?\s*[.!]?$/i;
export function parseSolanaTransferChat(text: string): SolanaTransferInput | null {
  const match = SOLANA_TRANSFER_PATTERN.exec(text.trim());
  if (!match) return null;
  const devnet = Boolean(match[4]), symbol = match[2]!.toUpperCase();
  // devUSDC exists only on Devnet: on mainnet it stays an unsupported asset instead of becoming real USDC.
  const asset = symbol === 'DEVUSDC' ? 'devUSDC' : devnet && symbol === 'USDC' ? 'devUSDC' : symbol;
  return { network: devnet ? 'Solana Devnet' : 'Solana', asset, amount: match[1]!.replace(',', '.'), recipient: match[3]! };
}
