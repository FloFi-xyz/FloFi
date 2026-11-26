// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02): authoring of the canonical Batch Payment (`asset.transfer.batch`): one source wallet, one EVM
 * mainnet, one asset (native ETH or a catalog ERC-20), several explicit recipients, each its own exact amount. The same authoring serves the Canvas card,
 * the chat, MCP, the channels and the Developer API (through the engine's `ADD_BATCH_PAYMENT` command).
 *
 * Each payment is exactly one transfer of the network's own transfer profile (`batchPaymentLegs`): the execution is those transfers, as one atomic
 * wallet authorization. Amounts are exact decimal strings turned into integer base units here (never floats); the total is their exact integer sum.
 * A Stock Token is refused (FloFi's atomic batches never carry one), as are a network whose transfer profile pays no explicit recipient, the zero
 * address, a duplicate recipient and an amount that is zero or above the profile's per-transfer maximum.
 */
import { BATCH_PAYMENT_MAX_RECIPIENTS, BATCH_PAYMENT_MIN_RECIPIENTS, createBatchPaymentNode, isBatchPaymentNode, readBatchPaymentNode, batchPaymentTotal,
  type BatchPaymentFields, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { formatAssetAmount, parseAssetAmount, transferAllowsRecipients, transferAllowsTokens, transferEnvironment } from '@defi-workflow-engine/action-registry';
import { authoringAssetSymbol, declaredNetworkSymbols, resolveNetworkAsset } from './asset-catalogs';
import { ownDeclaration } from './node-declaration';
import { formatEth, parseTransferAmount, transferProfileFor, TRANSFER_NETWORKS, type EvmTransferNetwork, type RobinhoodTransferInput } from './robinhood-transfer-authoring';

type Node = SemanticWorkflow['nodes'][number];
export { BATCH_PAYMENT_MAX_RECIPIENTS, BATCH_PAYMENT_MIN_RECIPIENTS };
/** The networks a Batch Payment may name: the EVM mainnet transfer profiles that pay explicit recipients (never a testnet, never Solana). */
export const BATCH_PAYMENT_NETWORKS: readonly EvmTransferNetwork[] = Object.freeze((Object.keys(TRANSFER_NETWORKS) as EvmTransferNetwork[]).filter(network => {
  const profile = TRANSFER_NETWORKS[network];
  return profile !== undefined && transferEnvironment(profile) === 'MAINNET' && transferAllowsRecipients(profile);
}));
export type BatchPaymentLineInput = { readonly recipient: string; readonly amount: string };
/** `asset`: 'ETH' or a symbol / whole name of the network's validated catalog; amounts are decimal strings in that asset. */
export type BatchPaymentInput = { readonly network: EvmTransferNetwork; readonly asset: string; readonly payments: readonly BatchPaymentLineInput[] };
const RECIPIENT = /^0x[0-9a-fA-F]{40}$/;

/** The canonical node of a Batch Payment input, or a closed refusal. */
export function createAuthoredBatchPayment(nodeId: string, input: BatchPaymentInput): Node {
  if (!input || typeof input !== 'object' || !Array.isArray(input.payments)) throw new Error('BATCH_PAYMENT_FIELDS_INVALID');
  if (!(BATCH_PAYMENT_NETWORKS as readonly string[]).includes(input.network)) throw new Error('BATCH_PAYMENT_NETWORK_UNSUPPORTED');
  if (input.payments.length < BATCH_PAYMENT_MIN_RECIPIENTS) throw new Error('BATCH_PAYMENT_TOO_FEW_RECIPIENTS');
  if (input.payments.length > BATCH_PAYMENT_MAX_RECIPIENTS) throw new Error('BATCH_PAYMENT_TOO_MANY_RECIPIENTS');
  const profile = transferProfileFor(input.network);
  const recipients = input.payments.map(p => {
    if (!p || typeof p.recipient !== 'string' || !RECIPIENT.test(p.recipient)) throw new Error('BATCH_PAYMENT_RECIPIENT_INVALID');
    return p.recipient.toLowerCase();
  });
  const symbol = authoringAssetSymbol(profile.chain, input.asset);
  if (symbol === 'ETH') {
    const payments = input.payments.map((p, i) => {
      let amount: string;
      try { amount = parseTransferAmount(p.amount, profile); } catch { throw new Error('BATCH_PAYMENT_AMOUNT_INVALID'); }
      return { recipient: recipients[i]!, amount };
    });
    return createBatchPaymentNode(nodeId, { chain: profile.chain, asset: { kind: 'NATIVE' }, payments });
  }
  if (!transferAllowsTokens(profile)) throw new Error('BATCH_PAYMENT_TOKEN_UNSUPPORTED');
  const token = resolveNetworkAsset(profile.chain, { symbol });
  if (!token) throw new Error('ASSET_CATALOG_UNAVAILABLE');
  if (token.kind !== 'ERC20') throw new Error('BATCH_PAYMENT_ASSET_UNSUPPORTED');
  // A Stock Token is paid only through its own transfer flow: FloFi's atomic batches never carry one.
  if (token.stock) throw new Error('BATCH_PAYMENT_ASSET_UNSUPPORTED');
  const payments = input.payments.map((p, i) => {
    let amount: string;
    try { amount = parseAssetAmount(p.amount, token.decimals); } catch { throw new Error('BATCH_PAYMENT_AMOUNT_INVALID'); }
    if (!/^[1-9][0-9]*$/.test(amount)) throw new Error('BATCH_PAYMENT_AMOUNT_INVALID');
    return { recipient: recipients[i]!, amount };
  });
  return createBatchPaymentNode(nodeId, { chain: profile.chain, asset: { kind: 'TOKEN', address: token.address!, decimals: token.decimals, officialId: null }, payments });
}

/** The Batch Payment a node declares, for presentation and parity (decimal amounts, the asset's catalog symbol); null for any other node. */
export type BatchPaymentDetails = BatchPaymentInput & { readonly fields: BatchPaymentFields; readonly total: string; readonly decimals: number };
export function batchPaymentDetails(node: Node): BatchPaymentDetails | null {
  node = ownDeclaration(node);
  if (!isBatchPaymentNode(node)) return null;
  try {
    const fields = readBatchPaymentNode({ ...node, dependencies: [] });
    const network = (Object.keys(TRANSFER_NETWORKS) as EvmTransferNetwork[]).find(name => TRANSFER_NETWORKS[name]?.chain === fields.chain);
    if (!network) return null;
    if (fields.asset.kind === 'NATIVE') return { network, asset: 'ETH', fields, decimals: 18, total: formatEth(batchPaymentTotal(fields.payments)),
      payments: fields.payments.map(p => ({ recipient: p.recipient, amount: formatEth(p.amount) })) };
    const { address, decimals } = fields.asset;
    const token = resolveNetworkAsset(fields.chain, { address });
    // Presentation only: an unresolved asset keeps a neutral label rather than a guessed symbol.
    return { network, asset: token?.symbol ?? 'Token', fields, decimals, total: formatAssetAmount(batchPaymentTotal(fields.payments).toString(), decimals),
      payments: fields.payments.map(p => ({ recipient: p.recipient, amount: formatAssetAmount(p.amount, decimals) })) };
  } catch { return null; }
}

/**
 * The ordered transfer legs of a Batch Payment: payment i is exactly the transfer `{network, asset, amount_i, recipient_i}` (the same authoring
 * input a single Send card has), so each leg composes to the existing verified transfer declaration of that network.
 */
export function batchPaymentLegs(input: BatchPaymentInput): readonly RobinhoodTransferInput[] {
  return input.payments.map(p => ({ network: input.network, asset: input.asset, amount: p.amount, recipient: p.recipient.toLowerCase() }));
}

/**
 * The Canvas card's asset choices on a Batch Payment network: native ETH, then the network's declared catalog ERC-20s that are not Stock Tokens
 * (presentation shortcuts only: whatever is chosen is still resolved and validated by `createAuthoredBatchPayment`).
 */
export function batchPaymentAssetOptions(network: EvmTransferNetwork): readonly string[] {
  const profile = TRANSFER_NETWORKS[network];
  if (!profile || !(BATCH_PAYMENT_NETWORKS as readonly string[]).includes(network)) return [];
  const tokens = transferAllowsTokens(profile) ? declaredNetworkSymbols(profile.chain).filter(symbol => {
    const asset = resolveNetworkAsset(profile.chain, { symbol });
    return asset?.kind === 'ERC20' && !asset.stock;
  }) : [];
  return ['ETH', ...new Set(tokens)];
}

/** What the Canvas card shows about its draft: the exact total (null until every line is valid), the count and one plain-words problem. */
export type BatchPaymentDraftCheck = { readonly valid: boolean; readonly count: number; readonly total: string | null; readonly problem: string | null; readonly code: string | null };
const DRAFT_PROBLEM: Readonly<Record<string, string>> = {
  BATCH_PAYMENT_TOO_FEW_RECIPIENTS: 'Add at least 2 recipients.',
  BATCH_PAYMENT_TOO_MANY_RECIPIENTS: 'A Batch Payment pays at most 8 recipients.',
  BATCH_PAYMENT_RECIPIENT_INVALID: 'Enter a valid 0x address for every recipient.',
  BATCH_PAYMENT_DUPLICATE_RECIPIENT: 'An address appears more than once. Remove the repeated recipient: payments are never merged.',
  BATCH_PAYMENT_AMOUNT_INVALID: 'Enter a positive amount for every recipient.',
  BATCH_PAYMENT_NETWORK_UNSUPPORTED: 'Batch Payment is available on Base, Arbitrum One, Ethereum and Robinhood Chain.',
};
const ASSET_PROBLEM = 'Choose an asset available for Batch Payment on this network.';
export function checkBatchPaymentDraft(input: BatchPaymentInput): BatchPaymentDraftCheck {
  const count = Array.isArray(input?.payments) ? input.payments.length : 0;
  try {
    const details = batchPaymentDetails(createAuthoredBatchPayment('batch-payment-draft', input));
    return details ? { valid: true, count, total: details.total, problem: null, code: null }
      : { valid: false, count, total: null, problem: ASSET_PROBLEM, code: 'BATCH_PAYMENT_ASSET_UNSUPPORTED' };
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : 'BATCH_PAYMENT_FIELDS_INVALID';
    return { valid: false, count, total: null, code, problem: DRAFT_PROBLEM[code] ?? (/ASSET|TOKEN|CATALOG/.test(code) ? ASSET_PROBLEM : 'Check the recipients and amounts.') };
  }
}
