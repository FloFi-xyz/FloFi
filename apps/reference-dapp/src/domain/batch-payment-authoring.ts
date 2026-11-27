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
import { formatAssetAmount, isChecksumAddress, parseAssetAmount, transferAllowsRecipients, transferAllowsTokens, transferEnvironment } from '@defi-workflow-engine/action-registry';
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
/** EIP-55, the Send card's rule: a single-case address carries no checksum; a mixed-case one must be its exact checksum encoding (a mistyped letter fails). */
export function batchRecipientValid(value: unknown): value is string {
  if (typeof value !== 'string' || !RECIPIENT.test(value)) return false;
  const body = value.slice(2);
  return body === body.toLowerCase() || body === body.toUpperCase() || isChecksumAddress(value);
}
const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
/** A well-formed decimal with more fraction digits than the asset has (named, never "enter a positive amount"). */
const tooPrecise = (value: unknown, decimals: number) => typeof value === 'string' && (DECIMAL.exec(value)?.[2]?.length ?? 0) > decimals;
/** A well-formed ETH amount above the network's per-payment maximum. */
function aboveNativeMaximum(value: unknown, maximumWei: bigint): boolean {
  const m = typeof value === 'string' ? DECIMAL.exec(value) : null;
  if (!m || (m[2]?.length ?? 0) > 18) return false;
  return BigInt(m[1]!) * 10n ** 18n + BigInt((m[2] ?? '').padEnd(18, '0') || '0') > maximumWei;
}

/** The canonical node of a Batch Payment input, or a closed refusal. */
export function createAuthoredBatchPayment(nodeId: string, input: BatchPaymentInput): Node {
  if (!input || typeof input !== 'object' || !Array.isArray(input.payments)) throw new Error('BATCH_PAYMENT_FIELDS_INVALID');
  if (!(BATCH_PAYMENT_NETWORKS as readonly string[]).includes(input.network)) throw new Error('BATCH_PAYMENT_NETWORK_UNSUPPORTED');
  if (input.payments.length < BATCH_PAYMENT_MIN_RECIPIENTS) throw new Error('BATCH_PAYMENT_TOO_FEW_RECIPIENTS');
  if (input.payments.length > BATCH_PAYMENT_MAX_RECIPIENTS) throw new Error('BATCH_PAYMENT_TOO_MANY_RECIPIENTS');
  const profile = transferProfileFor(input.network);
  const recipients = input.payments.map(p => {
    if (!p || !batchRecipientValid(p.recipient)) throw new Error('BATCH_PAYMENT_RECIPIENT_INVALID');
    return p.recipient.toLowerCase();
  });
  const symbol = authoringAssetSymbol(profile.chain, input.asset);
  if (symbol === 'ETH') {
    const payments = input.payments.map((p, i) => {
      let amount: string;
      try { amount = parseTransferAmount(p.amount, profile); }
      catch { throw new Error(aboveNativeMaximum(p.amount, BigInt(profile.maximumValueWei)) ? 'BATCH_PAYMENT_AMOUNT_ABOVE_MAXIMUM' : 'BATCH_PAYMENT_AMOUNT_INVALID'); }
      return { recipient: recipients[i]!, amount };
    });
    return createBatchPaymentNode(nodeId, { chain: profile.chain, asset: { kind: 'NATIVE' }, payments });
  }
  if (!transferAllowsTokens(profile)) throw new Error('BATCH_PAYMENT_TOKEN_UNSUPPORTED');
  const token = resolveNetworkAsset(profile.chain, { symbol });
  if (!token) throw new Error('ASSET_CATALOG_UNAVAILABLE');
  if (token.kind !== 'ERC20') throw new Error('BATCH_PAYMENT_ASSET_UNSUPPORTED');
  // A Stock Token is paid only through its own transfer flow: FloFi's atomic batches never carry one.
  if (token.stock || (token as { assetClass?: string }).assetClass === 'STOCK_TOKEN') throw new Error('BATCH_PAYMENT_ASSET_UNSUPPORTED');
  const payments = input.payments.map((p, i) => {
    let amount: string;
    try { amount = parseAssetAmount(p.amount, token.decimals); }
    catch { throw new Error(tooPrecise(p.amount, token.decimals) ? 'BATCH_PAYMENT_AMOUNT_TOO_PRECISE' : 'BATCH_PAYMENT_AMOUNT_INVALID'); }
    if (!/^[1-9][0-9]*$/.test(amount)) throw new Error('BATCH_PAYMENT_AMOUNT_INVALID');
    return { recipient: recipients[i]!, amount };
  });
  return createBatchPaymentNode(nodeId, { chain: profile.chain, asset: { kind: 'TOKEN', address: token.address!, decimals: token.decimals, officialId: null }, payments });
}

/** The neutral label of a token the network's catalog does not resolve (yet): presentation only, never a symbol FloFi authors with. */
export const UNRESOLVED_BATCH_ASSET = 'Token';
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
    return { network, asset: token?.symbol ?? UNRESOLVED_BATCH_ASSET, fields, decimals, total: formatAssetAmount(batchPaymentTotal(fields.payments).toString(), decimals),
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
/**
 * FE-BATCH-07: the card's Asset choices always include the draft's own asset (a catalog token outside the shortcuts, or the neutral label while
 * the catalog loads), so the select never shows another asset (ETH) than the one the draft pays. An empty asset (none chosen yet) adds nothing.
 */
export function batchPaymentAssetChoices(network: EvmTransferNetwork, current: string): readonly string[] {
  const options = batchPaymentAssetOptions(network);
  return current && !options.includes(current) ? [...options, current] : options;
}
/**
 * FE-BATCH-07: a network change keeps the asset only where the new network offers it; otherwise the asset is cleared (never silently ETH: the amounts
 * typed for one asset are never carried over to another), and the card asks the person to choose one.
 */
export function batchPaymentNetworkChange(draft: BatchPaymentInput, network: EvmTransferNetwork): BatchPaymentInput {
  return { ...draft, network, asset: draft.asset && batchPaymentAssetOptions(network).includes(draft.asset) ? draft.asset : '' };
}
/** The chain of a Batch Payment network name (its catalog is what the card's asset choices and amounts resolve against); null for any other name. */
export function batchPaymentChain(network: string): string | null {
  return (BATCH_PAYMENT_NETWORKS as readonly string[]).includes(network) ? TRANSFER_NETWORKS[network as EvmTransferNetwork]?.chain ?? null : null;
}
/** A new card's draft: Base (else the first Batch Payment network), USDC where offered (else the first choice), two empty recipients. */
export function defaultBatchPaymentDraft(): BatchPaymentInput {
  const network = BATCH_PAYMENT_NETWORKS.includes('Base' as EvmTransferNetwork) ? 'Base' as EvmTransferNetwork : BATCH_PAYMENT_NETWORKS[0]!;
  const assets = batchPaymentAssetOptions(network);
  return { network, asset: assets.includes('USDC') ? 'USDC' : assets[0] ?? 'ETH',
    payments: Array.from({ length: BATCH_PAYMENT_MIN_RECIPIENTS }, () => ({ recipient: '', amount: '' })) };
}
/** FE-BATCH-09: the exact values Apply submits (each recipient and amount trimmed); the card validates these same values. */
export function normalizeBatchPaymentDraft(input: BatchPaymentInput): BatchPaymentInput {
  return { network: input.network, asset: typeof input.asset === 'string' ? input.asset.trim() : input.asset,
    payments: Array.isArray(input.payments) ? input.payments.map(p => ({ recipient: typeof p?.recipient === 'string' ? p.recipient.trim() : p?.recipient, amount: typeof p?.amount === 'string' ? p.amount.trim() : p?.amount })) : input.payments };
}
/**
 * The saved Batch Payment of a node as the card's draft input (decimal amounts, the catalog symbol) and `key`, its own declaration (chain, asset,
 * every recipient and base-unit amount): a draft edits exactly that declaration and is dropped once the node no longer declares it (an undo, a chat
 * edit, a removed step). The key ignores the catalog label and the node's links, so a catalog loading or a new connection never drops a draft.
 */
export function savedBatchPayment(node: { readonly nodeId: string; readonly actionType: string } | undefined): { readonly input: BatchPaymentInput; readonly key: string } | null {
  const details = node ? batchPaymentDetails(node as Node) : null;
  return details ? { input: { network: details.network, asset: details.asset, payments: details.payments }, key: JSON.stringify(details.fields) } : null;
}

/**
 * A draft of a saved step started while the network's catalog did not name the step's token yet (`UNRESOLVED_BATCH_ASSET`) pays that same token once
 * the catalog names it (the same network: the same step's asset); any other draft is returned as it is.
 */
export function batchDraftWithSavedAsset(draft: BatchPaymentInput, saved: BatchPaymentInput): BatchPaymentInput {
  return draft.asset === UNRESOLVED_BATCH_ASSET && saved.asset !== UNRESOLVED_BATCH_ASSET && draft.network === saved.network ? { ...draft, asset: saved.asset } : draft;
}

/** The asset a draft pays, resolved as `createAuthoredBatchPayment` resolves it (native ETH, or a catalog ERC-20 that is not a Stock Token); null otherwise. */
type DraftAsset = { readonly native: true; readonly profile: ReturnType<typeof transferProfileFor> } | { readonly native: false; readonly decimals: number };
function draftAsset(input: BatchPaymentInput): DraftAsset | null {
  if (!input || !(BATCH_PAYMENT_NETWORKS as readonly string[]).includes(input.network) || typeof input.asset !== 'string' || !input.asset) return null;
  try {
    const profile = transferProfileFor(input.network), symbol = authoringAssetSymbol(profile.chain, input.asset);
    if (symbol === 'ETH') return { native: true, profile };
    if (!transferAllowsTokens(profile)) return null;
    const token = resolveNetworkAsset(profile.chain, { symbol });
    if (!token || token.kind !== 'ERC20' || token.stock || (token as { assetClass?: string }).assetClass === 'STOCK_TOKEN') return null;
    return { native: false, decimals: token.decimals };
  } catch { return null; }
}
/** One amount in the asset's base units (positive, within the network's per-payment ETH maximum); null when it is not a valid amount. */
function draftUnits(asset: DraftAsset, amount: unknown): bigint | null {
  if (typeof amount !== 'string') return null;
  try {
    const units = asset.native ? parseTransferAmount(amount, asset.profile) : parseAssetAmount(amount, asset.decimals);
    return /^[1-9][0-9]*$/.test(units) ? BigInt(units) : null;
  } catch { return null; }
}
/**
 * FE-BATCH-11: the exact total of a draft's amounts (decimal, in the asset), whatever its recipients say: null until every amount is a valid amount
 * of a resolved asset. An exact integer sum of base units, formatted as `batchPaymentDetails` formats a saved step's total; never a float.
 */
export function batchPaymentDraftTotal(input: BatchPaymentInput): string | null {
  const normalized = normalizeBatchPaymentDraft(input), asset = draftAsset(normalized);
  if (!asset || !Array.isArray(normalized.payments) || !normalized.payments.length) return null;
  let total = 0n;
  for (const p of normalized.payments) {
    const units = draftUnits(asset, p?.amount);
    if (units === null) return null;
    total += units;
  }
  return asset.native ? formatEth(total) : formatAssetAmount(total.toString(), asset.decimals);
}
const RESERVED_RECIPIENT = /^0x0{38}[0-9a-f]{2}$/;
/**
 * FE-BATCH-10: which fields of each row are not valid yet (for `aria-invalid`): a recipient that is missing, not a valid (checksummed) address, a
 * reserved address or repeated in another row; an amount that is missing or not a valid amount of the resolved asset (unknown while no asset
 * resolves). Presentation only: Apply still runs the full check.
 */
function draftRowIssues(input: BatchPaymentInput): readonly BatchPaymentRowIssue[] {
  if (!Array.isArray(input?.payments)) return [];
  const asset = draftAsset(input), seen = new Map<string, number>();
  for (const p of input.payments) if (typeof p?.recipient === 'string' && p.recipient) seen.set(p.recipient.toLowerCase(), (seen.get(p.recipient.toLowerCase()) ?? 0) + 1);
  return input.payments.map(p => {
    const recipient = typeof p?.recipient === 'string' ? p.recipient : '';
    return { recipient: !batchRecipientValid(recipient) || RESERVED_RECIPIENT.test(recipient.toLowerCase()) || (seen.get(recipient.toLowerCase()) ?? 0) > 1,
      amount: asset ? draftUnits(asset, p?.amount) === null : false };
  });
}

/** One row's fields that are not valid yet (true: invalid). */
export type BatchPaymentRowIssue = { readonly recipient: boolean; readonly amount: boolean };
/**
 * What the Canvas card shows about its draft (FE-BATCH-09: always the trimmed values Apply submits): the exact total (FE-BATCH-11: whenever every amount
 * is valid, whatever the recipients say), the count, one plain-words problem and, while the draft is invalid, which row fields are (FE-BATCH-10).
 */
export type BatchPaymentDraftCheck = { readonly valid: boolean; readonly count: number; readonly total: string | null; readonly problem: string | null; readonly code: string | null;
  readonly rows?: readonly BatchPaymentRowIssue[] };
const DRAFT_PROBLEM: Readonly<Record<string, string>> = {
  BATCH_PAYMENT_TOO_FEW_RECIPIENTS: 'Add at least 2 recipients.',
  BATCH_PAYMENT_TOO_MANY_RECIPIENTS: 'A Batch Payment pays at most 8 recipients.',
  BATCH_PAYMENT_RECIPIENT_INVALID: 'Enter a valid 0x address for every recipient (a mixed-case address must match its checksum).',
  BATCH_PAYMENT_DUPLICATE_RECIPIENT: 'An address appears more than once. Remove the repeated recipient: payments are never merged.',
  BATCH_PAYMENT_AMOUNT_INVALID: 'Enter a positive amount for every recipient.',
  BATCH_PAYMENT_AMOUNT_ABOVE_MAXIMUM: 'An ETH amount is above the per-payment maximum FloFi sends on this network. Lower it or split the payment.',
  BATCH_PAYMENT_AMOUNT_TOO_PRECISE: 'An amount has more decimal places than this asset allows.',
  BATCH_PAYMENT_NETWORK_UNSUPPORTED: 'Batch Payment is available on Base, Arbitrum One, Ethereum and Robinhood Chain.',
};
const ASSET_PROBLEM = 'Choose an asset available for Batch Payment on this network.';
export function checkBatchPaymentDraft(draft: BatchPaymentInput): BatchPaymentDraftCheck {
  const input = draft && typeof draft === 'object' ? normalizeBatchPaymentDraft(draft) : draft;
  const count = Array.isArray(input?.payments) ? input.payments.length : 0;
  const invalid = (code: string, problem: string): BatchPaymentDraftCheck => ({ valid: false, count, total: batchPaymentDraftTotal(input), code, problem, rows: draftRowIssues(input) });
  // FE-BATCH-07: no asset chosen (a network change cleared one the new network does not offer): that is the problem until the person picks one.
  if (input && typeof input === 'object' && !input.asset) return invalid('BATCH_PAYMENT_ASSET_REQUIRED', ASSET_PROBLEM);
  try {
    const details = batchPaymentDetails(createAuthoredBatchPayment('batch-payment-draft', input));
    return details ? { valid: true, count, total: details.total, problem: null, code: null, rows: input.payments.map(() => ({ recipient: false, amount: false })) }
      : invalid('BATCH_PAYMENT_ASSET_UNSUPPORTED', ASSET_PROBLEM);
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : 'BATCH_PAYMENT_FIELDS_INVALID';
    return invalid(code, DRAFT_PROBLEM[code] ?? (/ASSET|TOKEN|CATALOG/.test(code) ? ASSET_PROBLEM : 'Check the recipients and amounts.'));
  }
}
