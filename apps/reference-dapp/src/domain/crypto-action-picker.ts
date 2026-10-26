// SPDX-License-Identifier: AGPL-3.0-only
import { AAVE_V3_LENDING_PROFILES, ASSET_SYMBOL, transferAllowsTokens, UNISWAP_LIQUIDITY_PROFILES, baseAssetRegistry, SOLANA_SWAP_RUNTIMES, ORCA_LIQUIDITY_PROFILES, SOLANA_TRANSFER_PROFILES } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext, createEthereumSepoliaReviewContext, createReviewContext } from '@defi-workflow-engine/reference-linter';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createAuthoredTransfer, transferDetails, TRANSFER_NETWORKS, type TransferNetwork } from './robinhood-transfer-authoring';
import { classifyWalletEnvironment, type WalletEnvironment } from '../wallet/environment';
import type { Workflow } from './initial-workflow';
import { createSwapNode, swapDetails } from './swap-authoring';
import { createSolanaSwapNode, solanaSwapDetails, type SolanaSwapInput } from './jupiter-authoring';
import { createUniswapLiquidityNode, uniswapLiquidityDetails } from './uniswap-liquidity-authoring';
import { createSolanaLiquidityNode, solanaLiquidityDetails } from './solana-liquidity-authoring';
import { createAuthoredSupply, createAuthoredBorrow, createAuthoredRepay, createAuthoredWithdraw, supplyDetails, borrowDetails, repayDetails, withdrawDetails, lendingProfileFor } from './supply-authoring';
import { BASE_CHAIN, BASE_NETWORK, ROBINHOOD_CHAIN, ROBINHOOD_NETWORK, authoringAssetSymbol, featuredNetworkSymbols, featuredStockSymbols, resolveNetworkAsset } from './asset-catalogs';
import { CATALOG_SWAP_NETWORKS, catalogSwapDetails, createCatalogSwapAuthoringNode, type CatalogSwapNetwork } from './catalog-swap-authoring';
import { networkIdentity } from './network-registry';
import { DEFAULT_SLIPPAGE, DEFAULT_SLIPPAGE_BPS } from './slippage-policy';
import { CATALOG_LIQUIDITY_NETWORKS, createCatalogLiquidityNode, catalogLiquidityDetails, robinhoodFullRange, ROBINHOOD_LIQUIDITY_DEFAULT_FEE, type CatalogLiquidityNetwork } from './robinhood-liquidity-authoring';

export type CryptoAction = 'swap' | 'pool' | 'supply' | 'borrow' | 'repay' | 'withdraw' | 'transfer';
/** One network for the entire action. Assets never carry separate network selections. */
export type CryptoSelection = { action: CryptoAction; network: string; from: string; to?: string };
export type CryptoSelections = Readonly<Record<string, CryptoSelection>>;
/**
 * `catalog`: the network's assets come from its official asset catalog (BUILD-RH-002 Robinhood Chain, BUILD-BASE-001 Base). `tokens` are
 * then the shortcuts shown as chips; any other catalog asset is reached through search and stays valid only while it resolves.
 */
export type CryptoPickerProfile = { network: string; chain: string; provider: string; tokens: readonly string[]; pair?: readonly [string, string]; catalog?: true };
const mainnetContext = createReviewContext({ registryId: 'reference.registry', capabilityId: 'swap.direct-transaction', actionId: 'asset.swap.exact-input', assets: baseAssetRegistry });
export function cryptoReviewContext(network: string) { return network === 'Base Sepolia' ? createBaseSepoliaReviewContext() : network === 'Ethereum Sepolia' ? createEthereumSepoliaReviewContext() : mainnetContext; }
/** BUILD-BASE-001: Base is a catalog network — USDC and WETH are its shortcuts; search reaches the validated catalog. */
const baseCatalog = (provider: string): CryptoPickerProfile => ({ network: BASE_NETWORK, chain: BASE_CHAIN, provider,
  get tokens() { return featuredNetworkSymbols(BASE_CHAIN); }, catalog: true });
const evm: readonly CryptoPickerProfile[] = [
  baseCatalog('Uniswap'),
  ...UNISWAP_LIQUIDITY_PROFILES.map(profile => ({ network: profile.network, chain: profile.chain, provider: 'Uniswap', tokens: ['USDC', 'WETH'] })),
];
/** Base's reference pair keeps its BUILD-002 declaration (`createSwapNode`); every other Base pair is a catalog swap. */
const isBaseReferencePair = (selection: CryptoSelection) => selection.network === BASE_NETWORK && ['USDC', 'WETH'].includes(selection.from) &&
  ['USDC', 'WETH'].includes(selection.to ?? '') && selection.from !== selection.to;
/** Robinhood Chain shortcuts: its stablecoin and wrapped ETH, then the featured Stock Tokens. Search reaches the full catalog. */
const robinhoodSwap: CryptoPickerProfile = { network: ROBINHOOD_NETWORK, chain: ROBINHOOD_CHAIN, provider: 'Uniswap',
  get tokens() { return ['USDG', 'WETH', ...featuredStockSymbols()]; }, catalog: true };
const swaps: readonly CryptoPickerProfile[] = [...evm, ...SOLANA_SWAP_RUNTIMES.map(runtime => ({ network: runtime.network, chain: runtime.chain, provider: runtime.providerLabel, tokens: Object.keys(runtime.tokens) })),
  robinhoodSwap, ...Object.entries(CATALOG_SWAP_NETWORKS).filter(([network]) => network !== BASE_NETWORK && network !== ROBINHOOD_NETWORK)
    .map(([network, chain]): CryptoPickerProfile => ({ network, chain, provider: 'Uniswap', get tokens() { return featuredNetworkSymbols(chain); }, catalog: true }))];
/** Swaps and pools on a catalog network take ERC-20s only (native ETH is wrapped first); transfers may also send ETH. */
const erc20Only = (action: CryptoAction) => action === 'swap' || action === 'pool';
/** A token of a profile: a shortcut, or (catalog networks) any ERC-20 the current catalog resolves. */
function profileHasToken(profile: CryptoPickerProfile, symbol: string | undefined, action: CryptoAction): boolean {
  if (!symbol) return false;
  if (profile.tokens.includes(symbol)) return !profile.catalog || !erc20Only(action) || resolveNetworkAsset(profile.chain, { symbol })?.kind !== 'NATIVE';
  if (!profile.catalog || !ASSET_SYMBOL.test(symbol)) return false;
  const asset = resolveNetworkAsset(profile.chain, { symbol });
  return Boolean(asset && (!erc20Only(action) || asset.kind === 'ERC20'));
}
const pools: readonly CryptoPickerProfile[] = [
  // BUILD-BASE-001: any two Base catalog ERC-20s at a standard tier (the canonical, owner-executable position), replacing the fork-only pair.
  baseCatalog('Uniswap v3'),
  ...UNISWAP_LIQUIDITY_PROFILES.map(profile => ({ network: profile.network, chain: profile.chain, provider: 'Uniswap v3', tokens: [profile.token0.symbol, profile.token1.symbol], pair: [profile.token0.symbol, profile.token1.symbol] as const })),
  // Orca Whirlpools: Solana Devnet (SOL/devUSDC test pool) and, BUILD-SOLANA-MAINNET-001, Solana mainnet-beta (SOL/USDC 0.30%, real funds).
  ...ORCA_LIQUIDITY_PROFILES.map(profile => ({ network: profile.network, chain: profile.chain, provider: profile.providerLabel,
    tokens: [profile.token0.symbol, profile.token1.symbol], pair: [profile.token0.symbol, profile.token1.symbol] as const })),
  // BUILD-RH-002: any two Robinhood Chain catalog ERC-20s (USDG, WETH, Stock Tokens); the pool follows the pair and fee tier.
  { network: ROBINHOOD_NETWORK, chain: ROBINHOOD_CHAIN, provider: 'Uniswap v3', get tokens() { return ['USDG', 'WETH', ...featuredStockSymbols()]; }, catalog: true },
  ...Object.entries(CATALOG_LIQUIDITY_NETWORKS).filter(([network]) => network !== BASE_NETWORK && network !== ROBINHOOD_NETWORK)
    .map(([network, chain]): CryptoPickerProfile => ({ network, chain, provider: 'Uniswap v3', get tokens() { return featuredNetworkSymbols(chain); }, catalog: true })),
];
const transfers: readonly CryptoPickerProfile[] = Object.entries(TRANSFER_NETWORKS).map(([network, profile]): CryptoPickerProfile => profile.chain === ROBINHOOD_CHAIN
  // BUILD-RH-002: Robinhood Chain transfers native ETH and catalog assets; non-shortcut assets come from the official catalog.
  ? { network, chain: profile.chain, provider: 'Send', get tokens() { return ['ETH', 'USDG', 'WETH', ...featuredStockSymbols()]; }, catalog: true }
  // BUILD-BASE-001: Base likewise (ETH, then its shortcuts; search reaches the validated token list).
  : transferAllowsTokens(profile) ? { network, chain: profile.chain, provider: 'Send', get tokens() { return ['ETH', ...featuredNetworkSymbols(profile.chain)]; }, catalog: true }
  : { network, chain: profile.chain, provider: 'Native transfer', tokens: ['ETH'] })
  // BUILD-SOLANA-TRANSFER-UX-001: Solana mainnet-beta (SOL, USDC, USDT, real funds) and Devnet (SOL, devUSDC) on the same Send card.
  .concat(SOLANA_TRANSFER_PROFILES.map(profile => ({ network: profile.network, chain: profile.chain, provider: 'Send', tokens: profile.assets.map(asset => asset.symbol) })));
const lending: readonly CryptoPickerProfile[] = AAVE_V3_LENDING_PROFILES.map(profile => ({ network: profile.network, chain: profile.chain, provider: 'Aave V3', tokens: [profile.symbol] }));
export function cryptoProfiles(action: CryptoAction): readonly CryptoPickerProfile[] { return action === 'swap' ? swaps : action === 'pool' ? pools : action === 'transfer' ? transfers : lending; }
export function cryptoNetworks(action: CryptoAction, environment: WalletEnvironment) {
  return cryptoProfiles(action).filter(profile => environment !== 'unknown' && classifyWalletEnvironment(profile.chain) === environment);
}
export function cryptoProfile(selection: CryptoSelection) { return cryptoProfiles(selection.action).find(profile => profile.network === selection.network); }
export function validCryptoSelection(selection: CryptoSelection): boolean {
  if (!selection || !['swap', 'pool', 'supply', 'borrow', 'repay', 'withdraw', 'transfer'].includes(selection.action) || Object.keys(selection).some(key => !['action', 'network', 'from', 'to'].includes(key))) return false;
  const profile = cryptoProfile(selection);
  if (!profile || !profileHasToken(profile, selection.from, selection.action)) return false;
  if (selection.action === 'pool' && profile.pair) return selection.from === profile.pair[0] && selection.to === profile.pair[1];
  return erc20Only(selection.action) ? Boolean(selection.to && selection.to !== selection.from && profileHasToken(profile, selection.to, 'swap')) : selection.to === undefined;
}
export function selectCryptoNetwork(action: CryptoAction, network: string, current?: CryptoSelection): CryptoSelection {
  const profile = cryptoProfiles(action).find(entry => entry.network === network);
  if (!profile) throw new Error('ACTION_NETWORK_UNSUPPORTED');
  const from = profile.pair?.[0] ?? (current && profile.tokens.includes(current.from) ? current.from : profile.tokens[0]!);
  // A Robinhood Chain pool starts as USDG against the first featured Stock Token (the live Stock Token / USDG pools), never USDG/WETH by accident;
  // a Base pool starts as USDC/WETH.
  const pooled = action === 'pool' && profile.catalog ? profile.chain !== ROBINHOOD_CHAIN ? profile.tokens.find(token => token !== from)
    : (from === 'USDG' ? featuredStockSymbols()[0] : 'USDG') : undefined;
  const to = profile.pair?.[1] ?? (erc20Only(action) ? current?.to && current.to !== from && profile.tokens.includes(current.to) ? current.to : pooled ?? profile.tokens.find(token => token !== from) : undefined);
  return { action, network, from, ...(to ? { to } : {}) };
}
/** A test token and its mainnet asset, as one step moves between its network family's environments; any other token keeps its symbol. */
const TOKEN_COUNTERPARTS: readonly (readonly [string, string])[] = [['devUSDC', 'USDC']];
function counterpartToken(symbol: string, profile: CryptoPickerProfile, action: CryptoAction): string | null {
  if (profileHasToken(profile, symbol, action)) return symbol;
  const mapped = TOKEN_COUNTERPARTS.find(pair => pair.includes(symbol))?.find(token => token !== symbol);
  return mapped && profileHasToken(profile, mapped, action) ? mapped : null;
}
/**
 * BUILD-SOLANA-MAINNET-001: the same step on its own network family's counterpart in `environment` (Base Sepolia ↔ Base, Solana Devnet ↔
 * Solana, Robinhood Chain Testnet ↔ Robinhood Chain), each token kept or mapped to its explicit test/mainnet counterpart. Null when the family
 * has no such network there or a token has no counterpart: the step then stays as it is (blocked) instead of moving to another chain or asset.
 */
export function counterpartSelection(selection: CryptoSelection, environment: WalletEnvironment): CryptoSelection | null {
  const available = cryptoNetworks(selection.action, environment);
  if (available.some(profile => profile.network === selection.network)) return selection;
  const family = networkIdentity(cryptoProfile(selection)?.chain)?.family;
  const profile = family ? available.find(candidate => networkIdentity(candidate.chain)?.family === family) : undefined;
  if (!profile) return null;
  const from = counterpartToken(selection.from, profile, selection.action);
  const to = selection.to === undefined ? undefined : counterpartToken(selection.to, profile, selection.action);
  if (!from || to === null) return null;
  const next: CryptoSelection = { action: selection.action, network: profile.network, from, ...(to === undefined ? {} : { to }) };
  return validCryptoSelection(next) ? next : null;
}
/**
 * BUILD-SOLANA-MAINNET-001 (requirement C): the Swap card's arrow exchanges From and To on the same network; the new From is the spending
 * asset. Null for anything that is not a two-token swap, or when the reversed pair is not available on that network. The amount the owner typed
 * stays the owner's input (now in the new From token, re-validated against its decimals and limits); an estimated output is never used.
 */
export function invertCryptoSelection(selection: CryptoSelection): CryptoSelection | null {
  if (selection.action !== 'swap' || !selection.to || selection.to === selection.from) return null;
  const inverted: CryptoSelection = { action: 'swap', network: selection.network, from: selection.to, to: selection.from };
  return validCryptoSelection(inverted) ? inverted : null;
}
export function cryptoTokenOptions(selection: CryptoSelection, side: 'source' | 'destination') {
  const profile = cryptoProfile(selection);
  if (selection.action === 'pool' && !profile?.catalog) return [side === 'source' ? profile?.pair?.[0] : profile?.pair?.[1]].filter((token): token is string => Boolean(token));
  const current = side === 'source' ? selection.from : selection.to;
  // A catalog asset chosen through search stays visible next to the shortcuts.
  return profile?.catalog && current && !profile.tokens.includes(current) ? [...profile.tokens, current] : profile?.tokens ?? [];
}
export function selectCryptoToken(selection: CryptoSelection, side: 'source' | 'destination', token: string): CryptoSelection {
  const found = cryptoProfile(selection);
  if (found?.catalog) {
    try { token = authoringAssetSymbol(found.chain, token); }
    catch (cause) {
      if (cause instanceof Error && cause.message === 'ASSET_REFERENCE_AMBIGUOUS') throw cause;
      throw new Error('ACTION_TOKEN_UNSUPPORTED', { cause });
    }
  }
  // BUILD-BASE-001: on a catalog network a searched asset is valid for transfers too (their source asset), not only swaps and pools.
  const searchable = found?.catalog && (erc20Only(selection.action) || (selection.action === 'transfer' && side === 'source'));
  if (!found || (!cryptoTokenOptions(selection, side).includes(token) && !(searchable && profileHasToken(found, token, selection.action))))
    throw new Error('ACTION_TOKEN_UNSUPPORTED');
  if (selection.action === 'transfer' && found.catalog && side === 'source') return { ...selection, from: token };
  if (!erc20Only(selection.action) || (selection.action === 'pool' && !found.catalog)) return selection;
  const profile = found;
  const next = side === 'source' ? { ...selection, from: token } : { ...selection, to: token };
  if (next.from === next.to) {
    if (side === 'source') next.to = selection.from !== token ? selection.from : profile.tokens.find(asset => asset !== token)!;
    else next.from = selection.to !== token ? selection.to! : profile.tokens.find(asset => asset !== token)!;
  }
  return next;
}
type Node = Workflow['nodes'][number];
export function cryptoSelectionOf(node: Node): CryptoSelection | null {
  const network = [...swaps, ...pools, ...lending, ...transfers].find(profile => profile.chain === node.chainId)?.network;
  if (!network) return null;
  const transfer = transferDetails(node as Parameters<typeof transferDetails>[0]);
  // A Solana SPL token named by mint (decimals/program stated) is shown on its card but not re-picked from the shortcut list.
  if (transfer) return transfer.asset === 'Token' || transfer.asset === 'Stock Token' || transfer.decimals !== undefined ? null : { action: 'transfer', network, from: transfer.asset };
  if (node.actionType === 'asset.swap.exact-input') {
    const catalog = catalogSwapDetails(node);
    if (catalog) return catalog.fromAsset && catalog.toAsset ? { action: 'swap', network, from: catalog.from, to: catalog.to } : null;
    const solana = solanaSwapDetails(node);
    const evmSwap = node.chainId.startsWith('eip155:') ? swapDetails(node, cryptoReviewContext(network)) : null;
    return solana ? { action: 'swap', network, from: solana.from, to: solana.to } : evmSwap ? { action: 'swap', network, from: evmSwap.from, to: evmSwap.to } : null;
  }
  const catalogPool = catalogLiquidityDetails(node);
  if (catalogPool) return catalogPool.tokenA === 'Token' || catalogPool.tokenB === 'Token' ? null : { action: 'pool', network, from: catalogPool.tokenA, to: catalogPool.tokenB };
  // The BUILD-006 fork-only Base position (`asset.liquidity.uniswap-v3`) is a legacy declaration: the network picker never edits or converts it.
  if (uniswapLiquidityDetails(node) || solanaLiquidityDetails(node)) return selectCryptoNetwork('pool', network);
  if (['supply', 'borrow', 'repay', 'withdraw', 'transfer'].includes(node.actionType) && AAVE_V3_LENDING_PROFILES.some(profile => profile.chain === node.chainId)) return selectCryptoNetwork(node.actionType as CryptoAction, network);
  return null;
}
export function canSelectCryptoAssets(node: Node, workflow: Workflow) {
  return Boolean(cryptoSelectionOf(node) && !node.lockedParameters.length && !node.inputs.some(input => input.kind === 'OUTPUT_REFERENCE') &&
    !workflow.resourceEdges.some(edge => edge.fromNodeId === node.nodeId || edge.toNodeId === node.nodeId));
}
export type CryptoActionInput = { selection: CryptoSelection; amount: string; secondAmount?: string; beneficiary?: string; slippage: string;
  /** Catalog-network pools only (BUILD-RH-002 Robinhood Chain, BUILD-BASE-001 Base): the Uniswap v3 fee tier (0.3% when absent). */ fee?: number;
  /** Transfer only (BUILD-RH-002): an explicit recipient address; the connected owner when absent. */ recipient?: string;
  rangeUnit?: 'PRICE' | 'TICK'; lower?: string; upper?: string };
/**
 * The tick range a new or re-networked pool starts with: Solana Devnet's and Ethereum Sepolia's full ranges, a catalog network's full range
 * at its default fee tier (BUILD-BASE-001: Base as well as Robinhood Chain — never Base Sepolia's 0.05% ticks, which a 0.3% pool cannot
 * use), else Base Sepolia's.
 */
export function defaultPoolRange(network: string): { readonly rangeUnit: 'TICK'; readonly lower: string; readonly upper: string } {
  const full = (tick: number) => ({ rangeUnit: 'TICK' as const, lower: String(-tick), upper: String(tick) });
  if (network === 'Solana Devnet' || network === 'Solana') return full(443584);
  if (network === 'Ethereum Sepolia') return full(887220);
  const catalog = networkIdentity(network);
  return catalog?.catalog ? full(robinhoodFullRange(ROBINHOOD_LIQUIDITY_DEFAULT_FEE, catalog.chain).tickUpper) : full(887270);
}
export function createCryptoActionNode(id: string, input: CryptoActionInput): SemanticWorkflow['nodes'][number] {
  const { amount, slippage } = input;
  const identity = networkIdentity(input.selection.network);
  const selection = identity?.catalog ? { ...input.selection, from: authoringAssetSymbol(identity.chain, input.selection.from),
    ...input.selection.to === undefined ? {} : { to: authoringAssetSymbol(identity.chain, input.selection.to) } } : input.selection;
  if (!validCryptoSelection(selection)) throw new Error('ACTION_ASSETS_UNSUPPORTED');
  if (selection.action === 'swap') {
    if (selection.network === 'Solana' || selection.network === 'Solana Devnet') return createSolanaSwapNode(id, { network: selection.network, from: selection.from, to: selection.to, amount, slippage } as SolanaSwapInput);
    if (Object.hasOwn(CATALOG_SWAP_NETWORKS, selection.network) && !isBaseReferencePair(selection))
      return createCatalogSwapAuthoringNode(id, { network: selection.network as CatalogSwapNetwork, from: selection.from, to: selection.to!, amount, slippage });
    return createSwapNode(id, selection.from === 'USDC' ? 'USDC_TO_WETH' : 'WETH_TO_USDC', amount, slippage, cryptoReviewContext(selection.network));
  }
  if (selection.action === 'pool' && Object.hasOwn(CATALOG_LIQUIDITY_NETWORKS, selection.network)) {
    const network = selection.network as CatalogLiquidityNetwork, fee = input.fee ?? ROBINHOOD_LIQUIDITY_DEFAULT_FEE, full = robinhoodFullRange(fee, CATALOG_LIQUIDITY_NETWORKS[network]);
    // No explicit range, or exactly the tier's full range, is the full range.
    const ranged = input.lower !== undefined && input.upper !== undefined && !(Number(input.lower) === full.tickLower && Number(input.upper) === full.tickUpper);
    if (ranged && input.rangeUnit !== 'TICK') throw new Error('LIQUIDITY_RANGE_INVALID');
    return createCatalogLiquidityNode(id, { network, tokenA: selection.from, tokenB: selection.to!, amountA: amount, amountB: input.secondAmount ?? '0', fee,
      ...ranged ? { rangeUnit: 'TICK' as const, lower: input.lower!, upper: input.upper! } : { rangeUnit: 'FULL' as const }, slippage });
  }
  if (selection.action === 'pool') {
    const range = { rangeUnit: input.rangeUnit ?? 'TICK', lower: input.lower ?? defaultPoolRange(selection.network).lower, upper: input.upper ?? defaultPoolRange(selection.network).upper, slippage };
    if (selection.network === 'Solana Devnet' || selection.network === 'Solana') return createSolanaLiquidityNode(id, { ...range, network: selection.network, maxSol: amount, maxDevUsdc: input.secondAmount ?? '0' });
    if (selection.network === 'Base Sepolia' || selection.network === 'Ethereum Sepolia') return createUniswapLiquidityNode(id, { ...range, network: selection.network, maxUsdc: amount, maxWeth: input.secondAmount ?? '0' });
    throw new Error('ACTION_NETWORK_UNSUPPORTED');
  }
  if (selection.action === 'transfer') return createAuthoredTransfer(id, { network: selection.network as TransferNetwork, asset: selection.from, amount, recipient: input.recipient ?? 'CONNECTED_OWNER' });
  const profile = lendingProfileFor(selection.network, selection.from);
  const lendingInput = { network: profile.network, asset: profile.symbol, amount, beneficiary: input.beneficiary ?? '' };
  return selection.action === 'supply' ? createAuthoredSupply(id, lendingInput) : selection.action === 'borrow' ? createAuthoredBorrow(id, lendingInput) : selection.action === 'repay' ? createAuthoredRepay(id, lendingInput) : createAuthoredWithdraw(id, { network: profile.network, asset: profile.symbol, amount, recipient: 'CONNECTED_OWNER' });
}
export function cryptoInputOf(node: Node): CryptoActionInput | null {
  const selection = cryptoSelectionOf(node);
  if (!selection) return null;
  const catalogSwap = catalogSwapDetails(node);
  if (catalogSwap) return { selection, amount: catalogSwap.amount, slippage: String(catalogSwap.slippage) };
  const catalogPool = catalogLiquidityDetails(node);
  if (catalogPool) return { selection, amount: catalogPool.amountA, secondAmount: catalogPool.amountB, rangeUnit: 'TICK', lower: String(catalogPool.tickLower),
    upper: String(catalogPool.tickUpper), slippage: catalogPool.slippage, fee: catalogPool.fee };
  const solana = solanaSwapDetails(node), uni = uniswapLiquidityDetails(node), orca = solanaLiquidityDetails(node);
  const evmSwap = selection.action === 'swap' && !solana ? swapDetails(node, cryptoReviewContext(selection.network)) : null;
  if (solana || evmSwap) return { selection, amount: (solana ?? evmSwap)!.amount, slippage: solana?.slippage ?? String(evmSwap!.slippage ?? DEFAULT_SLIPPAGE_BPS) };
  if (uni || orca) return { selection, amount: uni?.maxUsdc ?? orca!.maxSol, secondAmount: uni?.maxWeth ?? orca!.maxDevUsdc, rangeUnit: 'TICK', lower: String((uni ?? orca)!.tickLower), upper: String((uni ?? orca)!.tickUpper), slippage: (uni ?? orca)!.slippage };
  const transfer = transferDetails(node as Parameters<typeof transferDetails>[0]);
  if (transfer) return { selection, amount: transfer.amount, slippage: DEFAULT_SLIPPAGE, ...transfer.recipient !== 'CONNECTED_OWNER' ? { recipient: transfer.recipient } : {} };
  const lending = supplyDetails(node as SemanticWorkflow['nodes'][number]) ?? borrowDetails(node as SemanticWorkflow['nodes'][number]) ?? repayDetails(node as SemanticWorkflow['nodes'][number]) ?? withdrawDetails(node as SemanticWorkflow['nodes'][number]);
  return lending ? { selection, amount: lending.amount, slippage: DEFAULT_SLIPPAGE, ...('beneficiary' in lending ? { beneficiary: lending.beneficiary } : {}) } : null;
}
