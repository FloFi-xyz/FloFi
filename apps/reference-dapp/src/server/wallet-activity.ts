// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001 (History): a wallet's received and sent token movements, read-only, from the providers this
 * deployment already configures. No signer, no submission port, nothing persisted, no new mandatory provider:
 *
 *   Ethereum, Base, Arbitrum One   Alchemy's Transfers API (`alchemy_getAssetTransfers`) on the deployment's existing `GRYLOO_ALCHEMY_API_KEY`
 *                                  (sent only in a server-side Bearer header). Native (external) and ERC-20 movements on every one; native
 *                                  transfers made inside contracts ("internal") on Ethereum only — Base and Arbitrum One report them as missing
 *   Robinhood Chain                no indexed history source is configured: UNSUPPORTED (never an empty history). An RPC log scan would be
 *                                  unbounded and cannot see native transfers, so none is attempted
 *   Solana                         the deployment's Solana RPC: `getSignaturesForAddress` for the wallet and for its token accounts of verified
 *                                  mints (an incoming SPL / Token-2022 transfer names the token account, not the wallet), then each transaction
 *                                  (`getTransaction`, jsonParsed) for the wallet's own balance changes
 *
 * Bounded everywhere: a fixed page per network and direction, a bounded number of Solana token accounts and transactions, one time budget for
 * the whole read with each network isolated (one failure or timeout marks that network UNAVAILABLE and leaves the others), in-flight
 * deduplication and a short per-wallet cache. Only verified catalog assets are named (symbol and decimals from the catalog, never from the
 * provider); any other token is counted as hidden. A network the deployment does not enable is OFF. Test runs use the MOCKED loopback fixture
 * (`GRYLOO_WALLET_ACTIVITY_HARNESS=MOCKED_LOOPBACK_ONLY`), which a hosted deployment never serves.
 */
import { ARBITRUM_ONE, BASE_MAINNET, ETHEREUM_MAINNET, JUPITER_SOLANA_MAINNET, ROBINHOOD_CHAIN_MAINNET, SOLANA_MAINNET_TOKENS, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import { SOLANA_TOKEN_2022_PROGRAM } from './solana-token-amount.ts';
import type { SolanaRpc } from '@defi-workflow-engine/reference-compiler';
import { CATALOG_NETWORKS, type CatalogNetworkId } from './catalog-networks.ts';
import { createSolanaRpc, solanaRpcOverride } from './solana-rpc.ts';
import { loadSolanaCatalog } from './solana-asset-catalog.ts';
import { isHostedDeployment } from './deployment.ts';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { walletSessionKey } from './wallet-session.ts';
import { defaultMode, type PortfolioMode } from './wallet-portfolio.ts';
import type { SolanaAssetCatalog } from '../domain/solana-asset-catalog.ts';
import { classifyLegs, type ActivityCategory, type ActivityCoverage, type ActivityLeg, type ActivityNetworkId, type WalletActivityPage,
  type WalletTransfer } from '../domain/wallet-activity.ts';

type Env = Readonly<Record<string, string | undefined>>;
type EvmActivityNetwork = Exclude<CatalogNetworkId, 'robinhood'>;
export const ACTIVITY_PAGE = 20, SOLANA_SIGNATURES_PER_ADDRESS = 10, SOLANA_TRANSACTIONS_PER_PAGE = 12, SOLANA_MAX_TOKEN_ACCOUNTS = 6;
const BUDGET_MS = 10_000, CACHE_COMPLETE_MS = 30_000, CACHE_INCOMPLETE_MS = 5_000, CACHE_ENTRIES = 200, MAX_CURSOR = 4096;
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const codeOf = (error: unknown, fallback: string) => error instanceof Error && CODE.test(error.message) ? error.message : fallback;
const HASH = /^0x[0-9a-fA-F]{64}$/, ADDRESS = /^0x[0-9a-fA-F]{40}$/, HEX = /^0x[0-9a-fA-F]{1,64}$/, SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, PAGE_KEY = /^[A-Za-z0-9_\-:.=+/]{1,512}$/;
/** A Solana address stream not read yet on this page: it starts from its newest signature next time. */
const FROM_NEWEST = '*';

/** The Alchemy Transfers API subdomains of the EVM networks it serves for this deployment's key. */
const ALCHEMY: Readonly<Record<EvmActivityNetwork, string>> = Object.freeze({ ethereum: 'eth-mainnet', base: 'base-mainnet', 'arbitrum-one': 'arb-mainnet' });
/** Categories requested per network: "internal" is listed by the provider on Ethereum only. */
const CATEGORIES: Readonly<Record<EvmActivityNetwork, readonly string[]>> = Object.freeze({ ethereum: ['external', 'internal', 'erc20'], base: ['external', 'erc20'],
  'arbitrum-one': ['external', 'erc20'] });
const EXPLORER: Readonly<Record<CatalogNetworkId, string>> = Object.freeze({ ethereum: ETHEREUM_MAINNET.explorer, base: BASE_MAINNET.explorer, 'arbitrum-one': ARBITRUM_ONE.explorer,
  robinhood: ROBINHOOD_CHAIN_MAINNET.explorer });
const explorerTx = (base: string, hash: string) => `${base.replace(/\/$/, '')}/tx/${hash}`;
const ACTIVITY_NAME: Readonly<Record<ActivityNetworkId, string>> = Object.freeze({ ethereum: 'Ethereum', base: 'Base', 'arbitrum-one': 'Arbitrum One', robinhood: 'Robinhood Chain', solana: 'Solana' });

export type AlchemyCall = (network: EvmActivityNetwork, params: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<unknown>;
export type WalletActivityCache = Map<string, { readonly at: number; readonly ttlMs: number; readonly value: Promise<WalletActivityPage> }>;
export type WalletActivitySeams = {
  readonly mode?: (network: ActivityNetworkId) => Promise<PortfolioMode>;
  readonly alchemy?: AlchemyCall | null;
  readonly evmCatalog?: (network: EvmActivityNetwork) => Promise<AssetCatalog>;
  readonly solanaRpc?: () => SolanaRpc;
  readonly solanaCatalog?: () => Promise<SolanaAssetCatalog>;
  readonly now?: () => Date; readonly budgetMs?: number; readonly cache?: WalletActivityCache | null;
  /** The continuation MAC key (default: derived from the deployment's session secret) and the per-wallet read limiter (tests). */
  readonly cursorKey?: Uint8Array; readonly limiter?: Map<string, number[]>;
};

// ── Input and continuation ────────────────────────────────────────────────────────────────────
export type ActivityAccount = { readonly ecosystem: 'evm' | 'solana'; readonly address: string };
/** The wallet to read: EVM 0x + 40 hex (lower-cased), or a Solana base58 public key; anything else is refused. */
export function activityAccount(input: unknown): ActivityAccount {
  if (typeof input !== 'string') throw new Error('ACTIVITY_ACCOUNT_INVALID');
  if (ADDRESS.test(input) && !/^0x0{40}$/i.test(input)) return { ecosystem: 'evm', address: input.toLowerCase() };
  if (BASE58.test(input) && input !== JUPITER_SOLANA_MAINNET.programs.system) return { ecosystem: 'solana', address: input };
  throw new Error('ACTIVITY_ACCOUNT_INVALID');
}
/** Per stream (`<network>:<IN|OUT>` or `solana:<address>`): a provider continuation, or null once that stream is exhausted. */
type Streams = Readonly<Record<string, string | null>>;
/**
 * The continuation is opaque to the browser and bound to its wallet by a server-keyed MAC (a key derived from the deployment's session secret,
 * for this purpose only): it names no wallet in clear, cannot be forged to drive arbitrary provider reads, and is sent in a request header, never
 * in a URL (flofi-security review).
 */
export const activityCursorKey = (env: Env): Buffer => Buffer.from(hkdfSync('sha256', walletSessionKey(env), 'flofi', 'flofi/wallet-activity-cursor/v1', 32));
const cursorMac = (key: Uint8Array, account: string, body: string) => createHmac('sha256', key).update(`flofi.wallet-activity-cursor.v2\0${account}\0${body}`).digest().subarray(0, 18);
export function encodeCursor(account: string, streams: Streams, key: Uint8Array): string {
  const body = Buffer.from(JSON.stringify({ v: 2, s: streams })).toString('base64url');
  return `${body}.${cursorMac(key, account, body).toString('base64url')}`;
}
/** A continuation is bounded in size, authenticated for its wallet and validated; anything else is refused (never reinterpreted). */
export function decodeCursor(cursor: string | null | undefined, account: string, key: Uint8Array): Streams | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  const [body, mac, extra] = cursor.split('.');
  if (cursor.length > MAX_CURSOR || extra !== undefined || !body || !mac || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{24}$/.test(mac)) throw new Error('ACTIVITY_CURSOR_INVALID');
  const expected = cursorMac(key, account, body), given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('ACTIVITY_CURSOR_INVALID');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new Error('ACTIVITY_CURSOR_INVALID'); }
  const v = value as { v?: unknown; s?: unknown };
  if (!v || v.v !== 2 || !v.s || typeof v.s !== 'object' || Array.isArray(v.s)) throw new Error('ACTIVITY_CURSOR_INVALID');
  const streams: Record<string, string | null> = {};
  for (const [key, page] of Object.entries(v.s as Record<string, unknown>)) {
    if (!/^(ethereum|base|arbitrum-one):(IN|OUT)$|^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key) || !(page === null || page === FROM_NEWEST || typeof page === 'string' && (PAGE_KEY.test(page) || SIGNATURE.test(page))))
      throw new Error('ACTIVITY_CURSOR_INVALID');
    streams[key] = page;
  }
  return streams;
}

/**
 * Uncached reads per wallet and minute in this server instance: a page served from the cache (or joined in flight) does not count. Bounds what one
 * wallet can make the deployment's shared provider credentials do (flofi-security review); a refusal is a closed code the page shows as a retry.
 */
export const ACTIVITY_READS_PER_MINUTE = 12;
const recentReads = new Map<string, number[]>();
function admitRead(account: string, now: number, limiter: Map<string, number[]> = recentReads) {
  const recent = (limiter.get(account) ?? []).filter(at => now - at < 60_000);
  if (recent.length >= ACTIVITY_READS_PER_MINUTE) { limiter.set(account, recent); throw new Error('ACTIVITY_RATE_LIMITED'); }
  recent.push(now); limiter.set(account, recent);
  if (limiter.size > 2_000) limiter.delete(limiter.keys().next().value!);
}

/** Runs `work` within `ms`; on expiry its signal aborts, so no provider read of it starts afterwards (an Alchemy request in flight is cancelled). */
function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, code: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work(controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(new Error(code)); reject(new Error(code)); }, Math.max(ms, 0)); })])
    .finally(() => clearTimeout(timer));
}
const checkAborted = (signal: AbortSignal) => { if (signal.aborted) throw new Error('ACTIVITY_TIME_BUDGET_EXCEEDED'); };

// ── EVM (Alchemy Transfers API) ───────────────────────────────────────────────────────────────
/** The deployment's Alchemy transport: one fixed host per network, the key in a Bearer header (never in a URL or a log), read method only. */
export function alchemyTransport(env: Env): AlchemyCall | null {
  const key = env.GRYLOO_ALCHEMY_API_KEY;
  if (!key) return null;
  return async (network, params, signal) => {
    const response = await fetch(`https://${ALCHEMY[network]}.g.alchemy.com/v2`, { method: 'POST', cache: 'no-store', redirect: 'error',
      signal: signal ? AbortSignal.any([AbortSignal.timeout(8_000), signal]) : AbortSignal.timeout(8_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }) });
    if (response.status === 429) throw new Error('ACTIVITY_PROVIDER_RATE_LIMITED');
    if (Number(response.headers.get('content-length') ?? 0) > 2_097_152) throw new Error('ACTIVITY_PROVIDER_RESPONSE_TOO_LARGE');
    const text = await response.text();
    if (text.length > 2_097_152) throw new Error('ACTIVITY_PROVIDER_RESPONSE_TOO_LARGE');
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error('ACTIVITY_PROVIDER_INVALID'); }
    if (!response.ok || !body || typeof body !== 'object' || 'error' in body || !('result' in body)) throw new Error('ACTIVITY_PROVIDER_UNAVAILABLE');
    return (body as { result: unknown }).result;
  };
}
type AlchemyTransfer = { blockNum?: unknown; uniqueId?: unknown; hash?: unknown; from?: unknown; to?: unknown; category?: unknown;
  rawContract?: { value?: unknown; address?: unknown; decimal?: unknown } | null; metadata?: { blockTimestamp?: unknown } | null };
type ReadResult = { readonly legs: ActivityLeg[]; readonly hidden: number; readonly streams: Record<string, string | null>; readonly coverage: ActivityCoverage };

async function readEvm(network: EvmActivityNetwork, owner: string, alchemy: AlchemyCall, catalog: Promise<AssetCatalog>, previous: Streams | null, signal: AbortSignal): Promise<ReadResult> {
  const runtime = CATALOG_NETWORKS[network];
  const listed = await catalog;
  const native = listed.assets.find(asset => asset.kind === 'NATIVE');
  const tokens = new Map(listed.assets.filter(asset => asset.kind === 'ERC20' && asset.address).map(asset => [asset.address!.toLowerCase(), asset] as const));
  const legs: ActivityLeg[] = [], streams: Record<string, string | null> = {};
  let hidden = 0;
  for (const direction of ['IN', 'OUT'] as const) {
    const key = `${network}:${direction}`, before = previous ? previous[key] : undefined;
    // A stream already exhausted on an earlier page is not read again.
    if (before === null) { streams[key] = null; continue; }
    checkAborted(signal);
    const result = await alchemy(network, { fromBlock: '0x0', toBlock: 'latest', [direction === 'IN' ? 'toAddress' : 'fromAddress']: owner,
      category: CATEGORIES[network], withMetadata: true, excludeZeroValue: true, maxCount: `0x${ACTIVITY_PAGE.toString(16)}`, order: 'desc', ...before ? { pageKey: before } : {} }, signal);
    const value = result as { transfers?: unknown; pageKey?: unknown } | null;
    if (!value || !Array.isArray(value.transfers) || value.transfers.length > ACTIVITY_PAGE * 2) throw new Error('ACTIVITY_PROVIDER_INVALID');
    streams[key] = typeof value.pageKey === 'string' && PAGE_KEY.test(value.pageKey) ? value.pageKey : null;
    for (const raw of value.transfers as AlchemyTransfer[]) {
      const hash = typeof raw.hash === 'string' && HASH.test(raw.hash) ? raw.hash.toLowerCase() : null;
      const from = typeof raw.from === 'string' && ADDRESS.test(raw.from) ? raw.from.toLowerCase() : null;
      const to = typeof raw.to === 'string' && ADDRESS.test(raw.to) ? raw.to.toLowerCase() : null;
      const units = typeof raw.rawContract?.value === 'string' && HEX.test(raw.rawContract.value) ? BigInt(raw.rawContract.value) : null;
      if (!hash || (from !== owner && to !== owner) || units === null || units === 0n) continue;
      const category = raw.category === 'external' ? 'NATIVE' : raw.category === 'internal' ? 'INTERNAL' : raw.category === 'erc20' ? 'TOKEN' : null;
      if (!category) continue;
      let asset: WalletTransfer['asset'];
      if (category === 'TOKEN') {
        const address = typeof raw.rawContract?.address === 'string' && ADDRESS.test(raw.rawContract.address) ? raw.rawContract.address.toLowerCase() : null;
        const known = address ? tokens.get(address) : undefined;
        const decimals = typeof raw.rawContract?.decimal === 'string' && HEX.test(raw.rawContract.decimal) ? Number(BigInt(raw.rawContract.decimal)) : null;
        // Spam protection: a token outside the verified catalog, or whose decimals disagree with it, is counted and never named.
        if (!known || (decimals !== null && decimals !== known.decimals)) { hidden++; continue; }
        asset = { symbol: known.symbol, decimals: known.decimals, address: known.address!.toLowerCase(), logo: known.logoUrl };
      } else asset = { symbol: native?.symbol ?? 'ETH', decimals: native?.decimals ?? 18, address: null, logo: native?.logoUrl ?? null };
      const self = from === owner && to === owner;
      const unique = typeof raw.uniqueId === 'string' && raw.uniqueId.length <= 200 ? raw.uniqueId : `${hash}:${category}:${legs.length}`;
      legs.push({ id: `${runtime.chain}:${unique}`, network, networkName: runtime.name, chain: runtime.chain, direction: self ? 'SELF' : to === owner ? 'IN' : 'OUT', category, asset,
        amount: units.toString(), counterparty: self ? null : to === owner ? from : to, transaction: hash, explorerUrl: explorerTx(EXPLORER[network], hash),
        timestamp: typeof raw.metadata?.blockTimestamp === 'string' && !Number.isNaN(Date.parse(raw.metadata.blockTimestamp)) ? new Date(raw.metadata.blockTimestamp).toISOString() : null,
        block: typeof raw.blockNum === 'string' && HEX.test(raw.blockNum) ? BigInt(raw.blockNum).toString() : null, status: 'CONFIRMED', from, to });
    }
  }
  const covers: ActivityCategory[] = network === 'ethereum' ? ['NATIVE', 'INTERNAL', 'TOKEN'] : ['NATIVE', 'TOKEN'];
  return { legs, hidden, streams, coverage: { network, name: ACTIVITY_NAME[network], status: network === 'ethereum' ? 'COVERED' : 'PARTIAL',
    code: network === 'ethereum' ? null : 'ACTIVITY_INTERNAL_TRANSFERS_NOT_LISTED', covers, missing: network === 'ethereum' ? [] : ['INTERNAL'] } };
}

// ── Solana ───────────────────────────────────────────────────────────────────────────────────
const WSOL_MINT = SOLANA_MAINNET_TOKENS.SOL.mint;
type ParsedKey = { pubkey?: unknown };
type TokenBalance = { accountIndex?: unknown; mint?: unknown; owner?: unknown; programId?: unknown; uiTokenAmount?: { amount?: unknown; decimals?: unknown } };
type ParsedInstruction = { program?: unknown; parsed?: { type?: unknown; info?: Record<string, unknown> } };
type SolanaTransaction = { slot?: unknown; blockTime?: unknown; meta?: { err?: unknown; fee?: unknown; preBalances?: unknown; postBalances?: unknown;
  preTokenBalances?: unknown; postTokenBalances?: unknown; innerInstructions?: unknown } | null; transaction?: { message?: { accountKeys?: unknown; instructions?: unknown } } };
const integer = (value: unknown): bigint | null => typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : typeof value === 'string' && /^\d{1,30}$/.test(value) ? BigInt(value) : null;

async function readSolana(owner: string, rpc: SolanaRpc, catalog: Promise<SolanaAssetCatalog>, previous: Streams | null, signal: AbortSignal): Promise<ReadResult> {
  const verified = new Map((await catalog).assets.map(asset => [asset.mint, asset] as const));
  // The wallet's token accounts of verified mints: an incoming SPL / Token-2022 transfer names the token account, not the wallet.
  const accounts: { address: string; mint: string }[] = [];
  for (const programId of [JUPITER_SOLANA_MAINNET.programs.token, SOLANA_TOKEN_2022_PROGRAM]) {
    checkAborted(signal);
    const result = await rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const value = result && typeof result === 'object' ? (result as { value?: unknown }).value : undefined;
    if (!Array.isArray(value)) throw new Error('SOLANA_RPC_INVALID');
    for (const entry of value as { pubkey?: unknown; account?: { data?: { parsed?: { info?: { mint?: unknown; owner?: unknown } } } } }[]) {
      const info = entry.account?.data?.parsed?.info, mint = info?.mint;
      if (typeof entry.pubkey !== 'string' || !BASE58.test(entry.pubkey) || typeof mint !== 'string' || info?.owner !== owner) continue;
      if (verified.has(mint) || mint === WSOL_MINT) accounts.push({ address: entry.pubkey, mint });
    }
  }
  const ranked = accounts.sort((a, b) => Number(b.mint === SOLANA_MAINNET_TOKENS.USDC.mint) - Number(a.mint === SOLANA_MAINNET_TOKENS.USDC.mint)
    || Number(b.mint === SOLANA_MAINNET_TOKENS.USDT.mint) - Number(a.mint === SOLANA_MAINNET_TOKENS.USDT.mint) || a.address.localeCompare(b.address));
  const sources = [owner, ...ranked.slice(0, SOLANA_MAX_TOKEN_ACCOUNTS).map(account => account.address)];
  const found: { signature: string; slot: number; source: string; finalized: boolean }[] = [];
  const exhausted = new Set<string>();
  const streams: Record<string, string | null> = {};
  for (const source of sources) {
    const key = `solana:${source}`, before = previous ? previous[key] : undefined;
    if (before === null) { streams[key] = null; continue; }
    checkAborted(signal);
    const result = await rpc('getSignaturesForAddress', [source, { limit: SOLANA_SIGNATURES_PER_ADDRESS, commitment: 'confirmed', ...before && before !== FROM_NEWEST ? { before } : {} }]);
    if (!Array.isArray(result) || result.length > SOLANA_SIGNATURES_PER_ADDRESS) throw new Error('SOLANA_RPC_INVALID');
    if (result.length < SOLANA_SIGNATURES_PER_ADDRESS) exhausted.add(source);
    for (const item of result as { signature?: unknown; slot?: unknown; err?: unknown; confirmationStatus?: unknown }[]) {
      if (typeof item.signature !== 'string' || !SIGNATURE.test(item.signature) || typeof item.slot !== 'number') throw new Error('SOLANA_RPC_INVALID');
      // A failed transaction moved nothing but its fee: it is not activity.
      found.push({ signature: item.signature, slot: item.slot, source, finalized: item.confirmationStatus === 'finalized' && (item.err === null || item.err === undefined) });
    }
  }
  const unique = [...new Map(found.map(item => [item.signature, item] as const)).values()].sort((a, b) => b.slot - a.slot || a.signature.localeCompare(b.signature));
  const page = unique.slice(0, SOLANA_TRANSACTIONS_PER_PAGE);
  // Each address continues after the last of its signatures this page includes; signatures read but not shown are read again next time.
  for (const source of sources) {
    const key = `solana:${source}`;
    if (streams[key] === null) continue;
    const own = found.filter(item => item.source === source), shown = own.filter(item => page.some(p => p.signature === item.signature));
    streams[key] = shown.length === own.length ? exhausted.has(source) ? null : own.at(-1)?.signature ?? null
      : shown.at(-1)?.signature ?? (previous?.[key] ?? FROM_NEWEST);
  }
  const legs: ActivityLeg[] = [];
  let hidden = 0;
  for (const item of page) {
    checkAborted(signal);
    const tx = await rpc('getTransaction', [item.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]) as SolanaTransaction | null;
    if (!tx?.meta || tx.meta.err) continue;
    const keys = Array.isArray(tx.transaction?.message?.accountKeys) ? (tx.transaction!.message!.accountKeys as ParsedKey[]).map(k => typeof k.pubkey === 'string' ? k.pubkey : typeof k === 'string' ? k as string : '') : [];
    const instructions = [...Array.isArray(tx.transaction?.message?.instructions) ? tx.transaction!.message!.instructions as ParsedInstruction[] : [],
      ...Array.isArray(tx.meta.innerInstructions) ? (tx.meta.innerInstructions as { instructions?: unknown }[]).flatMap(inner => Array.isArray(inner.instructions) ? inner.instructions as ParsedInstruction[] : []) : []];
    const timestamp = typeof tx.blockTime === 'number' ? new Date(tx.blockTime * 1000).toISOString() : null;
    const base = { network: 'solana' as const, networkName: 'Solana', chain: JUPITER_SOLANA_MAINNET.chain, transaction: item.signature,
      explorerUrl: `${JUPITER_SOLANA_MAINNET.explorer.replace(/\/$/, '')}/tx/${item.signature}`, timestamp, block: String(item.slot), status: item.finalized ? 'FINALIZED' as const : 'CONFIRMED' as const };
    // Native SOL: the wallet's own balance change, without the fee it paid as fee payer.
    const index = keys.indexOf(owner), pre = Array.isArray(tx.meta.preBalances) ? integer(tx.meta.preBalances[index]) : null, post = Array.isArray(tx.meta.postBalances) ? integer(tx.meta.postBalances[index]) : null;
    if (index >= 0 && pre !== null && post !== null) {
      const delta = post - pre + (index === 0 ? integer(tx.meta.fee) ?? 0n : 0n);
      if (delta !== 0n) {
        const transfer = instructions.find(ix => ix.program === 'system' && ['transfer', 'transferWithSeed'].includes(String(ix.parsed?.type))
          && (delta > 0n ? ix.parsed?.info?.destination === owner : ix.parsed?.info?.source === owner));
        const counterparty = transfer ? String(delta > 0n ? transfer.parsed!.info!.source : transfer.parsed!.info!.destination) : null;
        legs.push({ ...base, id: `${base.chain}:${item.signature}:sol`, direction: delta > 0n ? 'IN' : 'OUT', category: 'NATIVE', asset: { symbol: 'SOL', decimals: 9, address: null, logo: null },
          amount: (delta > 0n ? delta : -delta).toString(), counterparty: counterparty && BASE58.test(counterparty) ? counterparty : null, from: null, to: null });
      }
    }
    // SPL and Token-2022: the wallet's per-mint balance change across all of its token accounts in this transaction.
    const balances = (list: unknown) => (Array.isArray(list) ? list as TokenBalance[] : []);
    const ownerOf = new Map<string, string>();
    for (const b of [...balances(tx.meta.preTokenBalances), ...balances(tx.meta.postTokenBalances)])
      if (typeof b.accountIndex === 'number' && typeof b.owner === 'string') ownerOf.set(keys[b.accountIndex] ?? '', b.owner);
    const deltas = new Map<string, { delta: bigint; decimals: number }>();
    for (const [sign, list] of [[-1n, tx.meta.preTokenBalances], [1n, tx.meta.postTokenBalances]] as const) for (const b of balances(list)) {
      const amount = integer(b.uiTokenAmount?.amount);
      if (b.owner !== owner || typeof b.mint !== 'string' || amount === null || typeof b.uiTokenAmount?.decimals !== 'number') continue;
      const current = deltas.get(b.mint) ?? { delta: 0n, decimals: b.uiTokenAmount.decimals };
      deltas.set(b.mint, { delta: current.delta + sign * amount, decimals: current.decimals });
    }
    for (const [mint, { delta, decimals }] of deltas) {
      if (delta === 0n) continue;
      const known = verified.get(mint);
      if (!known && mint !== WSOL_MINT || known && known.decimals !== decimals) { hidden++; continue; }
      const transfer = instructions.find(ix => (ix.program === 'spl-token' || ix.program === 'spl-token-2022') && ['transfer', 'transferChecked'].includes(String(ix.parsed?.type))
        && (delta > 0n ? ownerOf.get(String(ix.parsed?.info?.destination)) === owner : ownerOf.get(String(ix.parsed?.info?.source)) === owner || ix.parsed?.info?.authority === owner));
      const other = transfer ? delta > 0n ? ownerOf.get(String(transfer.parsed!.info!.source)) ?? String(transfer.parsed!.info!.authority ?? '') : ownerOf.get(String(transfer.parsed!.info!.destination)) ?? null : null;
      legs.push({ ...base, id: `${base.chain}:${item.signature}:${mint}`, direction: delta > 0n ? 'IN' : 'OUT', category: 'TOKEN',
        asset: { symbol: mint === WSOL_MINT ? 'WSOL' : known!.symbol, decimals, address: mint, logo: known?.logoUrl ?? null },
        amount: (delta > 0n ? delta : -delta).toString(), counterparty: other && BASE58.test(other) && other !== owner ? other : null, from: null, to: null });
    }
  }
  const limited = accounts.length > SOLANA_MAX_TOKEN_ACCOUNTS;
  return { legs, hidden, streams, coverage: { network: 'solana', name: 'Solana', status: limited ? 'PARTIAL' : 'COVERED', code: limited ? 'SOLANA_TOKEN_ACCOUNT_LIMIT' : null,
    covers: ['NATIVE', 'TOKEN'], missing: [] } };
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────
const off = (network: ActivityNetworkId): ActivityCoverage => ({ network, name: ACTIVITY_NAME[network], status: 'OFF', code: null, covers: [], missing: [] });
const unsupported = (network: ActivityNetworkId, code: string): ActivityCoverage => ({ network, name: ACTIVITY_NAME[network], status: 'UNSUPPORTED', code, covers: [], missing: ['NATIVE', 'TOKEN'] });
const unavailable = (network: ActivityNetworkId, code: string): ActivityCoverage => ({ network, name: ACTIVITY_NAME[network], status: 'UNAVAILABLE', code, covers: [], missing: [] });

const processCache: WalletActivityCache = new Map();
/** One page of the wallet's activity (newest first per network). Never throws for a network: each one reports its own coverage. */
export async function readWalletActivity(input: { readonly account: string; readonly cursor?: string | null }, env: Env = process.env, seams: WalletActivitySeams = {}): Promise<WalletActivityPage> {
  const account = activityAccount(input.account);
  const cursorKey = seams.cursorKey ?? activityCursorKey(env);
  const previous = decodeCursor(input.cursor, account.address, cursorKey);
  const cache = seams.cache === undefined ? env === process.env ? processCache : null : seams.cache;
  const key = `${account.address}|${input.cursor ?? ''}`, now = Date.now();
  const hit = cache?.get(key);
  if (hit && now - hit.at < hit.ttlMs) return hit.value;
  admitRead(account.address, now, seams.limiter ?? (env === process.env ? recentReads : new Map()));
  const value = readUncached(account, previous, env, seams, cursorKey);
  if (cache) {
    if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: now, ttlMs: CACHE_INCOMPLETE_MS, value });
    void value.then(page => { if (cache.get(key)?.value === value) cache.set(key, { at: now, ttlMs: page.coverage.some(c => c.status === 'UNAVAILABLE') ? CACHE_INCOMPLETE_MS : CACHE_COMPLETE_MS, value }); },
      () => { if (cache.get(key)?.value === value) cache.delete(key); });
  }
  return value;
}

async function readUncached(account: ActivityAccount, previous: Streams | null, env: Env, seams: WalletActivitySeams, cursorKey: Uint8Array): Promise<WalletActivityPage> {
  const nowDate = (seams.now ?? (() => new Date()))(), budget = seams.budgetMs ?? BUDGET_MS;
  const harness = env.GRYLOO_WALLET_ACTIVITY_HARNESS === 'MOCKED_LOOPBACK_ONLY' && !isHostedDeployment(env);
  if (harness) return mockedActivity(account, nowDate);
  const mode = seams.mode ?? ((network: ActivityNetworkId) => network === 'solana' ? defaultMode('solana', env) : defaultMode(network, env));
  const alchemy = seams.alchemy === undefined ? alchemyTransport(env) : seams.alchemy;
  const networks: readonly ActivityNetworkId[] = account.ecosystem === 'evm' ? ['ethereum', 'base', 'arbitrum-one', 'robinhood'] : ['solana'];
  const results = await Promise.all(networks.map(async (network): Promise<ReadResult | ActivityCoverage> => {
    let enabled: PortfolioMode;
    try { enabled = await mode(network); } catch { return unavailable(network, 'ACTIVITY_NETWORK_GATE_UNAVAILABLE'); }
    if (enabled === 'off') return off(network);
    // The loopback harness of a network has no recorded history: never presented as an empty one.
    if (enabled === 'harness') return unsupported(network, 'ACTIVITY_HARNESS_NOT_RECORDED');
    if (network === 'robinhood') return unsupported(network, 'ACTIVITY_SOURCE_NOT_CONFIGURED');
    try {
      if (network === 'solana') {
        const rpc = seams.solanaRpc ? seams.solanaRpc() : createSolanaRpc(solanaRpcOverride(env.GRYLOO_SOLANA_RPC_URL, 'SOLANA_RPC_CONFIGURATION_INVALID') ?? JUPITER_SOLANA_MAINNET.rpc, false);
        const catalog = seams.solanaCatalog ? seams.solanaCatalog() : loadSolanaCatalog();
        return await withDeadline(signal => readSolana(account.address, rpc, catalog, previous, signal), budget, 'ACTIVITY_TIME_BUDGET_EXCEEDED');
      }
      if (!alchemy) return unsupported(network, 'ACTIVITY_PROVIDER_NOT_CONFIGURED');
      const runtime = CATALOG_NETWORKS[network];
      const catalog = seams.evmCatalog ? seams.evmCatalog(network) : runtime.catalogFor('live')(runtime.chain);
      return await withDeadline(signal => readEvm(network, account.address, alchemy, catalog, previous, signal), budget, 'ACTIVITY_TIME_BUDGET_EXCEEDED');
    } catch (error) { return unavailable(network, codeOf(error, 'ACTIVITY_READ_FAILED')); }
  }));
  const legs: ActivityLeg[] = [], coverage: ActivityCoverage[] = [], streams: Record<string, string | null> = {};
  let hidden = 0;
  for (const result of results) {
    if ('legs' in result) { legs.push(...result.legs); coverage.push(result.coverage); hidden += result.hidden; Object.assign(streams, result.streams); }
    else coverage.push(result);
  }
  // A network unavailable on this page keeps its continuation, so the next page tries it again.
  if (previous) for (const [k, v] of Object.entries(previous)) if (!(k in streams) && coverage.some(c => c.status === 'UNAVAILABLE' && k.startsWith(`${c.network}:`))) streams[k] = v;
  const more = Object.values(streams).some(v => v !== null);
  return { account: account.address, transfers: classifyLegs(legs), coverage, cursor: more ? encodeCursor(account.address, streams, cursorKey) : null, hidden,
    provenance: 'PUBLIC_MAINNET', observedAt: nowDate.toISOString() };
}

/** Test data for the MOCKED loopback harness only (automated tests and local screenshots); a hosted deployment never serves it. */
function mockedActivity(account: ActivityAccount, now: Date): WalletActivityPage {
  const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const peer = account.ecosystem === 'evm' ? '0x2222222222222222222222222222222222222222' : 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
  const legs: ActivityLeg[] = account.ecosystem === 'evm' ? [
    { id: `${BASE_MAINNET.chain}:0x${'1'.repeat(64)}:log:4`, network: 'base', networkName: 'Base', chain: BASE_MAINNET.chain, direction: 'IN', category: 'TOKEN',
      asset: { symbol: 'USDC', decimals: 6, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', logo: null }, amount: '1000000', counterparty: peer,
      transaction: `0x${'1'.repeat(64)}`, explorerUrl: explorerTx(BASE_MAINNET.explorer, `0x${'1'.repeat(64)}`), timestamp: at(12), block: '23000001', status: 'CONFIRMED', from: peer, to: account.address },
    { id: `${ETHEREUM_MAINNET.chain}:0x${'2'.repeat(64)}:external`, network: 'ethereum', networkName: 'Ethereum', chain: ETHEREUM_MAINNET.chain, direction: 'OUT', category: 'NATIVE',
      asset: { symbol: 'ETH', decimals: 18, address: null, logo: null }, amount: '10000000000000000', counterparty: peer,
      transaction: `0x${'2'.repeat(64)}`, explorerUrl: explorerTx(ETHEREUM_MAINNET.explorer, `0x${'2'.repeat(64)}`), timestamp: at(90), block: '21000002', status: 'CONFIRMED', from: account.address, to: peer },
    { id: `${ARBITRUM_ONE.chain}:0x${'3'.repeat(64)}:log:1`, network: 'arbitrum-one', networkName: 'Arbitrum One', chain: ARBITRUM_ONE.chain, direction: 'OUT', category: 'TOKEN',
      asset: { symbol: 'USDC', decimals: 6, address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', logo: null }, amount: '2500000', counterparty: peer,
      transaction: `0x${'3'.repeat(64)}`, explorerUrl: explorerTx(ARBITRUM_ONE.explorer, `0x${'3'.repeat(64)}`), timestamp: at(60 * 26), block: '300000003', status: 'CONFIRMED', from: account.address, to: peer },
  ] : [
    { id: `${JUPITER_SOLANA_MAINNET.chain}:${'5'.repeat(88)}:sol`, network: 'solana', networkName: 'Solana', chain: JUPITER_SOLANA_MAINNET.chain, direction: 'IN', category: 'NATIVE',
      asset: { symbol: 'SOL', decimals: 9, address: null, logo: null }, amount: '250000000', counterparty: peer, transaction: '5'.repeat(88),
      explorerUrl: `${JUPITER_SOLANA_MAINNET.explorer}/tx/${'5'.repeat(88)}`, timestamp: at(30), block: '300000000', status: 'FINALIZED', from: null, to: null },
  ];
  const coverage: ActivityCoverage[] = account.ecosystem === 'evm'
    ? [{ network: 'ethereum', name: 'Ethereum', status: 'COVERED', code: null, covers: ['NATIVE', 'INTERNAL', 'TOKEN'], missing: [] },
      { network: 'base', name: 'Base', status: 'PARTIAL', code: 'ACTIVITY_INTERNAL_TRANSFERS_NOT_LISTED', covers: ['NATIVE', 'TOKEN'], missing: ['INTERNAL'] },
      { network: 'arbitrum-one', name: 'Arbitrum One', status: 'PARTIAL', code: 'ACTIVITY_INTERNAL_TRANSFERS_NOT_LISTED', covers: ['NATIVE', 'TOKEN'], missing: ['INTERNAL'] },
      unsupported('robinhood', 'ACTIVITY_SOURCE_NOT_CONFIGURED')]
    : [{ network: 'solana', name: 'Solana', status: 'COVERED', code: null, covers: ['NATIVE', 'TOKEN'], missing: [] }];
  return { account: account.address, transfers: classifyLegs(legs), coverage, cursor: null, hidden: 1, provenance: 'MOCKED', observedAt: now.toISOString() };
}
