// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Dashboard wallet portfolio: a read-only snapshot of the connected wallet's balances on the mainnets this deployment enables.
 * No signer, no submission port, no session, nothing persisted: it reads public chain state and the verified USD price source only.
 *
 *  - Networks: Ethereum, Base, Arbitrum One and Robinhood Chain for an EVM wallet; Solana mainnet-beta for a Solana wallet. A network is read
 *    only where the deployment enables it — its cloud flow's gate (`GRYLOO_<NETWORK>_MAINNET=live`, Jupiter/Solana transfer for Solana) or,
 *    in local development, the same local gate; the loopback harness is `MOCKED` test data. Test networks are never part of a portfolio.
 *  - Assets: only the network's validated official catalog (the same catalogs authoring uses; Solana: the Jupiter verified list). EVM
 *    balances are one Multicall3 `aggregate3` per ≤ 120 listed tokens at one pinned block (native balance included); a network without
 *    Multicall3 reads its native balance only. Solana reads the owner account and its SPL/Token-2022 accounts; mints outside the verified
 *    list are counted (`unlisted`), never shown or valued.
 *  - Prices: the deployment's verified price source only (`automations/config.ts` `deploymentPriceSource`: Chainlink USD feeds on Base, or
 *    a MOCKED fixture in tests), for ETH/WETH and SOL/WSOL (`domain/usd-estimate.ts` `priceAssetOf`), and only for the native asset or the
 *    canonical wrapped native (never a token that merely shares the symbol). A stablecoin is never assumed to be $1.
 *  - Each network is isolated (one failure leaves the others), the whole read has a time budget, and results are cached briefly per wallet.
 */
import { CATALOG_NETWORKS, type CatalogNetworkId } from './catalog-networks.ts';
import { JUPITER_SOLANA_MAINNET, SOLANA_MAINNET_TOKENS, type AssetCatalog, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { decodeRpcAccount, decodeSplTokenAccount, readSolanaAccounts, verifySolanaCluster, type SolanaRpc } from '@defi-workflow-engine/reference-compiler';
import { isSolanaPublicKey } from '@defi-workflow-engine/workflow-contracts';
import { cloudFlowMode } from './flow-runtime.ts';
import { isHostedDeployment } from './deployment.ts';
import { createSolanaRpc, solanaRpcOverride } from './solana-rpc.ts';
import { loadSolanaCatalog } from './solana-asset-catalog.ts';
import type { Rpc } from './public-testnet-service.ts';
import { deploymentPriceSource } from '../automations/config.ts';
import type { PriceObservation, PriceSource } from '../automations/price-source.ts';
import { priceAssetOf, usdAmount, type PriceAsset } from '../domain/usd-estimate.ts';
import type { SolanaAssetCatalog, SolanaCatalogAsset } from '../domain/solana-asset-catalog.ts';
import { normalizeEvmAddress, sumUsd, type PortfolioAccount, type PortfolioHolding, type PortfolioNetwork, type PortfolioNetworkId,
  type PortfolioPriceSource, type PortfolioProvenance, type PortfolioTokenCoverage, type WalletPortfolio } from '../domain/wallet-portfolio.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type PortfolioMode = 'live' | 'harness' | 'off';
type ReadMode = Exclude<PortfolioMode, 'off'>;

/** Multicall3: the same address on every EVM chain that has it; its presence is checked on chain before use. */
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const SELECTOR = Object.freeze({ aggregate3: '82ad56cb', getEthBalance: '4d2301cc', balanceOf: '70a08231' });
/** The EVM catalog mainnets, in display order. */
export const EVM_NETWORKS: readonly CatalogNetworkId[] = Object.freeze(['ethereum', 'base', 'arbitrum-one', 'robinhood']);
/** Listed tokens per `aggregate3` call, and the most listed tokens checked per network (the rest are reported as unchecked). */
export const PORTFOLIO_CHUNK = 120, PORTFOLIO_MAX_TOKENS = 600;
/** Read methods only: nothing here can sign, send or simulate. */
export const PORTFOLIO_EVM_RPC_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call', 'eth_getBalance']);
const SOLANA_TOKEN_PROGRAMS = Object.freeze([
  { id: JUPITER_SOLANA_MAINNET.programs.token, token2022: false },
  { id: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', token2022: true },
]);
const WSOL_MINT = SOLANA_MAINNET_TOKENS.SOL.mint;
/** Loopback MOCKED harnesses of the Solana mainnet flows (tests only; never a public provider). */
const SOLANA_HARNESS_RPC = Object.freeze({ jupiter: 'http://127.0.0.1:8551/rpc', transfer: 'http://127.0.0.1:8552/transfer-rpc' });
const BUDGET_MS = 12_000, CACHE_COMPLETE_MS = 30_000, CACHE_INCOMPLETE_MS = 5_000, CACHE_ENTRIES = 200;
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const codeOf = (error: unknown, fallback: string) => error instanceof Error && CODE.test(error.message) ? error.message : fallback;

export type PortfolioCache = Map<string, { readonly at: number; readonly ttlMs: number; readonly value: Promise<WalletPortfolio> }>;
export type WalletPortfolioSeams = {
  /** The deployment's enablement of a network (default: its cloud flow's gate, else the local gate). */
  readonly mode?: (network: PortfolioNetworkId) => Promise<PortfolioMode>;
  readonly evmRpc?: (network: CatalogNetworkId, mode: ReadMode) => Rpc;
  readonly evmCatalog?: (network: CatalogNetworkId, mode: ReadMode) => Promise<AssetCatalog>;
  readonly solanaRpc?: (mode: ReadMode) => SolanaRpc;
  readonly solanaCatalog?: (mode: ReadMode) => Promise<SolanaAssetCatalog>;
  /** The verified price source (default: the deployment's, built once per process); null: none. */
  readonly prices?: PriceSource | null;
  readonly now?: () => Date;
  readonly budgetMs?: number;
  /** Result cache (default: the process cache for the process environment; none for any other environment). */
  readonly cache?: PortfolioCache | null;
};

// ── Input ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The wallet accounts to read, validated strictly: EVM 0x + 40 hex (lowercased), Solana base58 that decodes to 32 bytes. */
export function portfolioAccounts(input: unknown): readonly PortfolioAccount[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('PORTFOLIO_INPUT_INVALID');
  const { evm, solana } = input as { evm?: unknown; solana?: unknown };
  const accounts: PortfolioAccount[] = [];
  if (evm !== null && evm !== undefined) {
    const address = normalizeEvmAddress(evm);
    if (!address || /^0x0{40}$/.test(address)) throw new Error('PORTFOLIO_EVM_ADDRESS_INVALID');
    accounts.push({ ecosystem: 'evm', address });
  }
  if (solana !== null && solana !== undefined) {
    if (!isSolanaPublicKey(solana) || solana === JUPITER_SOLANA_MAINNET.programs.system) throw new Error('PORTFOLIO_SOLANA_ADDRESS_INVALID');
    accounts.push({ ecosystem: 'solana', address: solana });
  }
  if (!accounts.length) throw new Error('PORTFOLIO_NO_ACCOUNT');
  return accounts;
}

// ── Deployment gates ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function localSolanaMode(env: Env): PortfolioMode {
  if (env.GRYLOO_JUPITER_HARNESS === 'MOCKED_LOOPBACK_ONLY' || env.GRYLOO_SOLANA_TRANSFER_HARNESS === 'MOCKED_LOOPBACK_ONLY') return 'harness';
  return env.GRYLOO_JUPITER === 'live' || env.GRYLOO_SOLANA_TRANSFER === 'live' ? 'live' : 'off';
}
/** The flows that carry each network's deployment gate; the first enabled one decides. A hosted deployment never reads a harness. */
async function defaultMode(network: PortfolioNetworkId, env: Env): Promise<PortfolioMode> {
  let mode: PortfolioMode;
  if (network === 'solana') {
    const modes = await Promise.all((['jupiter-swap', 'solana-transfer'] as const).map(flow => cloudFlowMode(flow, env)));
    mode = modes.every(m => m === null) ? localSolanaMode(env) : modes.find(m => m && m !== 'off') ?? 'off';
  } else {
    const runtime = CATALOG_NETWORKS[network];
    mode = (await cloudFlowMode(runtime.flows.swap, env)) ?? runtime.mode(env);
  }
  return mode === 'harness' && isHostedDeployment(env) ? 'off' : mode;
}

// ── Time budget ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function withDeadline<T>(work: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), Math.max(ms, 0)); })])
    .finally(() => clearTimeout(timer));
}

// ── Multicall3 (hand-encoded ABI; exact and bounded) ─────────────────────────────────────────────────────────────────────────────
const word = (value: bigint) => value.toString(16).padStart(64, '0');
const addressWord = (address: string) => address.slice(2).toLowerCase().padStart(64, '0');
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;
function quantity(value: unknown, code = 'PORTFOLIO_RPC_RESPONSE_INVALID'): bigint {
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw new Error(code);
  return BigInt(value);
}
/** `aggregate3((address target, bool allowFailure, bytes callData)[])`, every call allowed to fail. */
export function encodeAggregate3(calls: readonly { readonly target: string; readonly data: string }[]): string {
  const tuples = calls.map(call => {
    const bytes = call.data.slice(2), length = bytes.length / 2;
    return addressWord(call.target) + word(1n) + word(0x60n) + word(BigInt(length)) + bytes.padEnd(Math.ceil(length / 32) * 64, '0');
  });
  let offset = tuples.length * 32;
  const offsets = tuples.map(tuple => { const at = offset; offset += tuple.length / 2; return word(BigInt(at)); });
  return `0x${SELECTOR.aggregate3}${word(0x20n)}${word(BigInt(calls.length))}${offsets.join('')}${tuples.join('')}`;
}
/** `(bool success, bytes returnData)[]`, bounds-checked; anything malformed fails the whole call (its balances are then unchecked). */
export function decodeAggregate3(hex: unknown, count: number): { readonly success: boolean; readonly data: string }[] {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex) || (hex.length - 2) % 64 !== 0) throw new Error('PORTFOLIO_MULTICALL_INVALID');
  const body = hex.slice(2), size = body.length / 2;
  const at = (offset: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % 32 !== 0 || offset + 32 > size) throw new Error('PORTFOLIO_MULTICALL_INVALID');
    return BigInt(`0x${body.slice(offset * 2, offset * 2 + 64)}`);
  };
  const small = (value: bigint) => { if (value > BigInt(size)) throw new Error('PORTFOLIO_MULTICALL_INVALID'); return Number(value); };
  const array = small(at(0));
  if (small(at(array)) !== count) throw new Error('PORTFOLIO_MULTICALL_INVALID');
  const base = array + 32;
  return Array.from({ length: count }, (_, i) => {
    const tuple = base + small(at(base + i * 32)), success = at(tuple);
    if (success > 1n) throw new Error('PORTFOLIO_MULTICALL_INVALID');
    const data = tuple + small(at(tuple + 32)), length = small(at(data)), start = (data + 32) * 2;
    if (start + length * 2 > body.length) throw new Error('PORTFOLIO_MULTICALL_INVALID');
    return { success: success === 1n, data: `0x${body.slice(start, start + length * 2)}` };
  });
}
/** A single uint256 return value, else null (a call that failed or returned anything else is unchecked, never zero). */
const uint256 = (result: { readonly success: boolean; readonly data: string } | undefined) =>
  result?.success && /^0x[0-9a-fA-F]{64}$/.test(result.data) ? BigInt(result.data) : null;

// ── EVM networks ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
type NetworkRead = { readonly network: PortfolioNetwork; readonly holdings: readonly HoldingDraft[]; readonly unlisted: number };
type HoldingDraft = Omit<PortfolioHolding, 'price' | 'valueUsd'> & { readonly priceAsset: PriceAsset | null };
const ASSET_ORDER: Readonly<Record<CanonicalAsset['assetClass'], number>> = { NATIVE: 0, WRAPPED_NATIVE: 1, STABLECOIN: 2, STOCK_TOKEN: 3, TOKEN: 3 };
/** The listed ERC-20s, featured and base assets first (so a capped catalog still checks the common ones). */
function listedTokens(catalog: AssetCatalog): CanonicalAsset[] {
  const featured = new Map(catalog.featured.map((id, i) => [id, i] as const));
  return catalog.assets.map((asset, index) => ({ asset, index })).filter(({ asset }) => asset.kind === 'ERC20' && asset.address !== null)
    .sort((a, b) => (featured.get(a.asset.id) ?? 1e6) - (featured.get(b.asset.id) ?? 1e6) ||
      ASSET_ORDER[a.asset.assetClass] - ASSET_ORDER[b.asset.assetClass] || a.index - b.index).map(({ asset }) => asset);
}
/** Only the native asset and the canonical wrapped native follow a price feed; a token that merely shares the symbol never does. */
const evmPriceAsset = (asset: Pick<CanonicalAsset, 'kind' | 'assetClass' | 'symbol'>) =>
  asset.kind === 'NATIVE' || asset.assetClass === 'WRAPPED_NATIVE' ? priceAssetOf(asset.symbol) : null;

async function readEvmNetwork(id: CatalogNetworkId, mode: ReadMode, owner: string, env: Env, seams: WalletPortfolioSeams, now: () => Date): Promise<NetworkRead> {
  const runtime = CATALOG_NETWORKS[id], provenance: PortfolioProvenance = mode === 'harness' ? 'MOCKED' : 'PUBLIC_MAINNET';
  const rpc = seams.evmRpc ? seams.evmRpc(id, mode) : runtime.rpc(mode, env, PORTFOLIO_EVM_RPC_METHODS);
  const catalog = (seams.evmCatalog ? seams.evmCatalog(id, mode) : runtime.catalogFor(mode)(runtime.chain))
    .then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, code: codeOf(error, runtime.catalogUnavailableCode) }));
  const chainId = await rpc('eth_chainId', []);
  if (quantity(chainId) !== BigInt(runtime.chainId)) throw new Error('WRONG_PROVIDER_CHAIN');
  const block = quantity(await rpc('eth_blockNumber', [])), at = `0x${block.toString(16)}`;
  const code = await rpc('eth_getCode', [MULTICALL3, at]);
  const multicall = typeof code === 'string' && /^0x[0-9a-fA-F]+$/.test(code) && code.length > 2;
  const listed = await catalog;
  const nativeAsset = listed.ok ? listed.value.assets.find(asset => asset.kind === 'NATIVE') : undefined;
  const tokens = listed.ok ? listedTokens(listed.value) : [];
  const checked = multicall ? tokens.slice(0, PORTFOLIO_MAX_TOKENS) : [];
  const balances = new Map<string, bigint>();
  let native: bigint | null = null, unchecked = tokens.length - checked.length, failure: string | null = listed.ok ? null : listed.code;
  if (!multicall) failure ??= 'MULTICALL_UNAVAILABLE';
  for (let start = 0; multicall && (start === 0 || start < checked.length); start += PORTFOLIO_CHUNK) {
    const chunk = checked.slice(start, start + PORTFOLIO_CHUNK), first = start === 0;
    const calls = [...first ? [{ target: MULTICALL3, data: `0x${SELECTOR.getEthBalance}${addressWord(owner)}` }] : [],
      ...chunk.map(token => ({ target: token.address!, data: `0x${SELECTOR.balanceOf}${addressWord(owner)}` }))];
    try {
      const results = decodeAggregate3(await rpc('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, at]), calls.length);
      if (first) native = uint256(results[0]);
      chunk.forEach((token, i) => { const value = uint256(results[i + (first ? 1 : 0)]); if (value === null) unchecked++; else balances.set(token.address!, value); });
    } catch (error) {
      unchecked += chunk.length;
      failure ??= codeOf(error, 'PORTFOLIO_MULTICALL_FAILED');
    }
  }
  // The native balance never depends on Multicall3: read it directly when the aggregate could not.
  if (native === null) native = quantity(await rpc('eth_getBalance', [owner, at]));
  const coverage: PortfolioTokenCoverage = !listed.ok || !multicall || (tokens.length > 0 && unchecked >= tokens.length) ? 'NATIVE_ONLY' : unchecked > 0 ? 'PARTIAL' : 'ALL';
  if (coverage === 'PARTIAL') failure ??= tokens.length > checked.length ? 'PORTFOLIO_TOKEN_LIMIT' : 'PORTFOLIO_TOKEN_UNCHECKED';
  const base = { networkId: id, network: runtime.name, chain: runtime.chain, provenance } as const;
  const holdings: HoldingDraft[] = [];
  if (native > 0n) {
    const asset = nativeAsset ?? { kind: 'NATIVE' as const, assetClass: 'NATIVE' as const, symbol: 'ETH', name: 'Ether', decimals: 18, logoUrl: null };
    holdings.push({ ...base, symbol: asset.symbol, name: asset.name, address: null, decimals: asset.decimals, units: native.toString(), native: true,
      logo: asset.logoUrl, priceAsset: evmPriceAsset(asset) });
  }
  for (const token of checked) {
    const units = balances.get(token.address!);
    if (units && units > 0n) holdings.push({ ...base, symbol: token.symbol, name: token.name, address: token.address, decimals: token.decimals,
      units: units.toString(), native: false, logo: token.logoUrl, priceAsset: evmPriceAsset(token) });
  }
  return { holdings, unlisted: 0, network: { id, name: runtime.name, chain: runtime.chain, chainId: runtime.chainId, ecosystem: 'evm', status: 'READ', provenance,
    observedAt: now().toISOString(), block: block.toString(), slot: null, tokens: coverage, uncheckedTokens: unchecked, code: coverage === 'ALL' ? null : failure } };
}

// ── Solana ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SOLANA_NAME = 'Solana';
/** Harness: the code-pinned mainnet tokens only (no public catalog read from a test run). */
function pinnedSolanaCatalog(): SolanaAssetCatalog {
  const names: Readonly<Record<string, string>> = { SOL: 'Solana', USDC: 'USD Coin', USDT: 'Tether USD' };
  return { assets: Object.values(SOLANA_MAINNET_TOKENS).map(token => ({ symbol: token.symbol, name: names[token.symbol] ?? token.symbol, mint: token.mint,
    decimals: token.decimals, native: token.native, logoUrl: null })), fetchedAt: new Date(0).toISOString(), source: 'pinned', contentSha256: '', excludedRecords: 0 };
}
function solanaReadRpc(mode: ReadMode, env: Env): SolanaRpc {
  if (mode === 'harness') {
    const url = env.GRYLOO_JUPITER_HARNESS === 'MOCKED_LOOPBACK_ONLY' ? SOLANA_HARNESS_RPC.jupiter : SOLANA_HARNESS_RPC.transfer;
    return createSolanaRpc(url, true);
  }
  return createSolanaRpc(solanaRpcOverride(env.GRYLOO_SOLANA_RPC_URL, 'SOLANA_RPC_CONFIGURATION_INVALID') ?? JUPITER_SOLANA_MAINNET.rpc, false);
}
/**
 * Non-zero token balances per mint, summed over the owner's accounts of one token program. An account the RPC attributes to another program
 * or owner fails the whole program (the response is not trusted); an account whose layout cannot be decoded is skipped and counted.
 */
async function solanaTokenBalances(rpc: SolanaRpc, owner: string, program: { readonly id: string; readonly token2022: boolean }):
  Promise<{ readonly balances: Map<string, bigint>; readonly unreadable: number }> {
  const result = await rpc('getTokenAccountsByOwner', [owner, { programId: program.id }, { encoding: 'base64', commitment: 'confirmed' }]);
  const value = result && typeof result === 'object' ? (result as { value?: unknown }).value : undefined;
  if (!Array.isArray(value)) throw new Error('SOLANA_RPC_INVALID');
  const balances = new Map<string, bigint>();
  let unreadable = 0;
  for (const entry of value) {
    const account = decodeRpcAccount(entry && typeof entry === 'object' ? (entry as { account?: unknown }).account ?? null : null);
    if (!account || account.owner !== program.id) throw new Error('SOLANA_TOKEN_ACCOUNT_MISMATCH');
    let decoded: ReturnType<typeof decodeSplTokenAccount>;
    try { decoded = decodeSplTokenAccount(account.data, program.token2022); } catch { unreadable++; continue; }
    if (decoded.owner !== owner) throw new Error('SOLANA_TOKEN_ACCOUNT_MISMATCH');
    if (decoded.state === 0 || decoded.amount === 0n) continue;
    balances.set(decoded.mint, (balances.get(decoded.mint) ?? 0n) + decoded.amount);
  }
  return { balances, unreadable };
}
async function readSolanaNetwork(mode: ReadMode, owner: string, env: Env, seams: WalletPortfolioSeams, now: () => Date): Promise<NetworkRead> {
  const provenance: PortfolioProvenance = mode === 'harness' ? 'MOCKED' : 'PUBLIC_MAINNET';
  const rpc = seams.solanaRpc ? seams.solanaRpc(mode) : solanaReadRpc(mode, env);
  const catalog = (seams.solanaCatalog ? seams.solanaCatalog(mode) : mode === 'harness' ? Promise.resolve(pinnedSolanaCatalog()) : loadSolanaCatalog())
    .then(value => ({ ok: true as const, value }), () => ({ ok: false as const }));
  await verifySolanaCluster(rpc, JUPITER_SOLANA_MAINNET.genesisHash);
  const { slot, accounts } = await readSolanaAccounts(rpc, [owner]);
  const lamports = accounts[0]?.lamports ?? 0n;
  const balances = new Map<string, bigint>();
  let failedPrograms = 0, unreadable = 0, failure: string | null = null;
  for (const program of SOLANA_TOKEN_PROGRAMS) {
    try {
      const read = await solanaTokenBalances(rpc, owner, program);
      for (const [mint, amount] of read.balances) balances.set(mint, (balances.get(mint) ?? 0n) + amount);
      unreadable += read.unreadable;
    } catch (error) { failedPrograms++; failure ??= codeOf(error, 'SOLANA_TOKEN_ACCOUNTS_UNAVAILABLE'); }
  }
  const listed = await catalog;
  const verified = new Map<string, SolanaCatalogAsset>(listed.ok ? listed.value.assets.filter(asset => !asset.native).map(asset => [asset.mint, asset] as const) : []);
  const base = { networkId: 'solana', network: SOLANA_NAME, chain: JUPITER_SOLANA_MAINNET.chain, provenance } as const;
  const holdings: HoldingDraft[] = [];
  if (lamports > 0n) holdings.push({ ...base, symbol: 'SOL', name: 'Solana', address: null, decimals: 9, units: lamports.toString(), native: true, logo: null, priceAsset: 'SOL' });
  let unlisted = 0, unidentified = 0;
  for (const [mint, amount] of balances) {
    // Wrapped SOL is the canonical SPL form of SOL; it keeps its own name so it never reads as native SOL twice.
    const asset = mint === WSOL_MINT ? { symbol: 'WSOL', name: 'Wrapped SOL', decimals: 9, logoUrl: verified.get(mint)?.logoUrl ?? null } : verified.get(mint);
    if (!listed.ok && mint !== WSOL_MINT) { unidentified++; continue; }
    if (!asset) { unlisted++; continue; }
    holdings.push({ ...base, symbol: asset.symbol, name: asset.name, address: mint, decimals: asset.decimals, units: amount.toString(), native: false,
      logo: asset.logoUrl, priceAsset: mint === WSOL_MINT ? 'SOL' : null });
  }
  const coverage: PortfolioTokenCoverage = failedPrograms === SOLANA_TOKEN_PROGRAMS.length || !listed.ok ? 'NATIVE_ONLY'
    : failedPrograms || unreadable ? 'PARTIAL' : 'ALL';
  if (!listed.ok) failure ??= 'SOLANA_TOKEN_CATALOG_UNAVAILABLE';
  if (unreadable) failure ??= 'SOLANA_TOKEN_ACCOUNT_UNREADABLE';
  return { holdings, unlisted, network: { id: 'solana', name: SOLANA_NAME, chain: JUPITER_SOLANA_MAINNET.chain, chainId: null, ecosystem: 'solana', status: 'READ',
    provenance, observedAt: now().toISOString(), block: null, slot, tokens: coverage, uncheckedTokens: unidentified + unreadable,
    code: coverage === 'ALL' ? null : failure } };
}

// ── Prices ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let processPrices: PriceSource | null | undefined;
function priceSourceOf(env: Env, seams: WalletPortfolioSeams): PriceSource | null {
  if (seams.prices !== undefined) return seams.prices;
  try {
    if (env !== process.env) return deploymentPriceSource(env);
    if (processPrices === undefined) processPrices = deploymentPriceSource(env);
    return processPrices;
  } catch { return null; }
}
const sourceOf = (prices: PriceSource | null): PortfolioPriceSource | null => prices?.id === 'chainlink' ? 'CHAINLINK' : prices?.id === 'fixture' ? 'FIXTURE' : null;

// ── The snapshot ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const unreadNetwork = (id: PortfolioNetworkId, status: 'UNAVAILABLE' | 'NOT_ENABLED', code: string, provenance: PortfolioProvenance | null): PortfolioNetwork => {
  const runtime = id === 'solana' ? null : CATALOG_NETWORKS[id];
  return { id, name: runtime?.name ?? SOLANA_NAME, chain: runtime?.chain ?? JUPITER_SOLANA_MAINNET.chain, chainId: runtime?.chainId ?? null,
    ecosystem: runtime ? 'evm' : 'solana', status, provenance, observedAt: null, block: null, slot: null, tokens: null, uncheckedTokens: 0, code };
};
async function readSnapshot(accounts: readonly PortfolioAccount[], env: Env, seams: WalletPortfolioSeams): Promise<WalletPortfolio> {
  const now = seams.now ?? (() => new Date()), started = now().getTime(), budget = seams.budgetMs ?? BUDGET_MS;
  const remaining = () => started + budget - now().getTime();
  const evm = accounts.find(account => account.ecosystem === 'evm')?.address ?? null;
  const solana = accounts.find(account => account.ecosystem === 'solana')?.address ?? null;
  const ids: PortfolioNetworkId[] = [...evm ? EVM_NETWORKS : [], ...solana ? ['solana' as const] : []];
  const resolveMode = seams.mode ?? ((id: PortfolioNetworkId) => defaultMode(id, env));
  const modes = await withDeadline(Promise.all(ids.map(id => resolveMode(id).catch((): PortfolioMode => 'off'))), remaining(), 'PORTFOLIO_READ_TIMEOUT')
    .catch(() => ids.map((): PortfolioMode => 'off'));
  // Prices are observed alongside the balance reads, only for the feeds an enabled network can use.
  const prices = priceSourceOf(env, seams), observedAt = now();
  const wanted = new Set<PriceAsset>([...ids.some((id, i) => id !== 'solana' && modes[i] !== 'off') ? ['ETH' as const] : [],
    ...ids.some((id, i) => id === 'solana' && modes[i] !== 'off') ? ['SOL' as const] : []]);
  const observing = Promise.all([...wanted].filter(asset => prices?.assets.includes(asset)).map(async asset =>
    [asset, await prices!.observe(asset, observedAt).then(result => result.ok ? result.observation : null, () => null)] as const));
  const reads = await Promise.all(ids.map(async (id, i): Promise<NetworkRead> => {
    const mode = modes[i]!;
    if (mode === 'off') return { network: unreadNetwork(id, 'NOT_ENABLED', 'NETWORK_NOT_ENABLED', null), holdings: [], unlisted: 0 };
    const work = id === 'solana' ? readSolanaNetwork(mode, solana!, env, seams, now) : readEvmNetwork(id, mode, evm!, env, seams, now);
    try { return await withDeadline(work, remaining(), 'PORTFOLIO_READ_TIMEOUT'); }
    catch (error) {
      return { network: unreadNetwork(id, 'UNAVAILABLE', codeOf(error, 'PORTFOLIO_NETWORK_UNAVAILABLE'), mode === 'harness' ? 'MOCKED' : 'PUBLIC_MAINNET'), holdings: [], unlisted: 0 };
    }
  }));
  const observed = new Map<PriceAsset, PriceObservation>((await withDeadline(observing, remaining(), 'PRICE_TIMEOUT').catch(() => []))
    .flatMap(([asset, observation]) => observation ? [[asset, observation] as const] : []));
  const holdings: PortfolioHolding[] = reads.flatMap(read => read.holdings).map(({ priceAsset, ...holding }) => {
    const observation = priceAsset ? observed.get(priceAsset) : undefined;
    const valueUsd = observation ? usdAmount(holding.units, holding.decimals, observation.priceUsd) : null;
    return { ...holding, price: observation && valueUsd !== null ? { usd: observation.priceUsd, source: observation.source, observedAt: observation.observedAt } : null,
      valueUsd: observation ? valueUsd : null };
  });
  const networks = reads.map(read => read.network), priceSource = sourceOf(prices);
  return { format: 'flofi.wallet-portfolio.v1', observedAt: now().toISOString(), accounts, networks, holdings,
    pricedTotalUsd: sumUsd(holdings.map(holding => holding.valueUsd)), unpricedCount: holdings.filter(holding => holding.valueUsd === null).length,
    unlisted: reads.reduce((sum, read) => sum + read.unlisted, 0), priceSource,
    mocked: networks.some(network => network.status === 'READ' && network.provenance === 'MOCKED') || holdings.some(holding => holding.price?.source === 'FIXTURE') };
}

const processCache: PortfolioCache = new Map();
/**
 * The wallet's portfolio snapshot. Throws only a closed input code (PORTFOLIO_INPUT_INVALID, PORTFOLIO_EVM_ADDRESS_INVALID,
 * PORTFOLIO_SOLANA_ADDRESS_INVALID, PORTFOLIO_NO_ACCOUNT); every network or price failure is reported inside the snapshot.
 */
export async function readWalletPortfolio(input: { readonly evm: string | null; readonly solana: string | null }, env: Env = process.env,
  seams: WalletPortfolioSeams = {}): Promise<WalletPortfolio> {
  const accounts = portfolioAccounts(input);
  const cache = seams.cache !== undefined ? seams.cache : env === process.env ? processCache : null;
  if (!cache) return readSnapshot(accounts, env, seams);
  const key = accounts.map(account => `${account.ecosystem}:${account.address}`).join('|'), at = Date.now();
  const hit = cache.get(key);
  if (hit && at - hit.at < hit.ttlMs) return hit.value;
  const value = readSnapshot(accounts, env, seams);
  cache.set(key, { at, ttlMs: CACHE_INCOMPLETE_MS, value });
  value.then(portfolio => {
    // A complete snapshot is reused for 30 s; one with an unread network only coalesces bursts, so Retry reads again soon.
    if (cache.get(key)?.value === value && portfolio.networks.every(network => network.status !== 'UNAVAILABLE')) cache.set(key, { at, ttlMs: CACHE_COMPLETE_MS, value });
  }, () => { if (cache.get(key)?.value === value) cache.delete(key); });
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return value;
}
