// SPDX-License-Identifier: AGPL-3.0-only

import { AAVE_V3_MARKETS, ARBITRUM_BASE_ASSETS, BASE_BASE_ASSETS, ETHEREUM_BASE_ASSETS, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as ORCA,
  ROBINHOOD_BASE_ASSETS, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { supplyReserves } from '../app/supply-action';
import { deploymentPriceSource } from '../automations/config';
import { observationFresh, type PriceFeedAsset, type PriceObservation, type PriceSource } from '../automations/price-source';
import { positionsWalletKey, type PositionAsset, type PositionScan, type PositionWallet } from '../domain/defi-positions';
import { usdAmount } from '../domain/usd-estimate';
import { CATALOG_NETWORKS, type CatalogNetworkId } from './catalog-networks';
import { createAdmissionLimiter } from './admission-limiter';
import { isHostedDeployment } from './deployment';
import { aavePositions, POSITION_EVM_METHODS, uniswapPositions, UNISWAP_POSITION_DEPLOYMENTS, type ValuePositionAsset } from './defi-positions-evm';
import { orcaPositions } from './defi-positions-solana';
import { cloudFlowMode } from './flow-runtime';
import { createSolanaRpc, solanaRpcOverride } from './solana-rpc';
import { ORCA_MAINNET_HARNESS_RPC } from './orca-mainnet-harness';
import { recordLiquidityOutcome } from './liquidity-lifecycle-telemetry';
import { positionScanCache, type CachedPositionScan } from './defi-positions-cache';
import { CANONICAL_STABLECOINS, defaultMode, EVM_NETWORKS } from './wallet-portfolio';

const registeredAssets: Readonly<Record<CatalogNetworkId, readonly CanonicalAsset[]>> = {
  ethereum: ETHEREUM_BASE_ASSETS.assets, base: BASE_BASE_ASSETS.assets,
  'arbitrum-one': ARBITRUM_BASE_ASSETS.assets, robinhood: ROBINHOOD_BASE_ASSETS.assets,
};
const SOLANA_SETUP = { protocol: 'Orca Whirlpools', network: ORCA.network, chain: ORCA.chain } as const;
const CACHE_LIMIT = 200, COMPLETE_TTL_MS = 30_000, PARTIAL_TTL_MS = 5_000, BUDGET_MS = 12_000;
const limiter = createAdmissionLimiter({ windowMs: 60_000, maxConcurrent: 2, maxPerWindow: 16 });
type CachedScan = CachedPositionScan;
/** The shared per-wallet scan cache (server/defi-positions-cache.ts), which position actions reach without importing this module. */
const cache: Map<string, CachedScan> = positionScanCache;
let processPriceSource: PriceSource | null | undefined;

function snapshotState(source: Pick<PositionScan, 'protocol' | 'network' | 'chain'>, status: PositionScan['status']): PositionScan {
  return { ...source, status, provenance: null, observedAt: null, positions: [] };
}
function budget<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error('POSITION_SCAN_TIMEOUT'));
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
  });
}
function rpcBeforeDeadline<R extends string>(rpc: (method: R, params: readonly unknown[]) => Promise<unknown>, signal: AbortSignal) {
  return (method: R, params: readonly unknown[]) => {
    if (signal.aborted) return Promise.reject(new Error('POSITION_SCAN_TIMEOUT'));
    return budget(rpc(method, params), signal);
  };
}

async function usdObservations(now: Date, requested: ReadonlySet<PriceFeedAsset>): Promise<{ readonly source: PriceSource; readonly observations: ReadonlyMap<PriceFeedAsset, PriceObservation> } | null> {
  try {
    processPriceSource ??= deploymentPriceSource(process.env);
    const source = processPriceSource;
    // The dashboard only displays live, verified feeds. Tests can exercise the pure valuation helper with an explicit observation.
    if (source?.id !== 'chainlink') return null;
    const readings = await Promise.all(source.assets.filter(asset => requested.has(asset)).map(async asset => ({ asset, result: await source.observe(asset, now).catch(() => null) })));
    return { source, observations: new Map(readings.flatMap(({ asset, result }) => result?.ok ? [[asset, result.observation]] : [])) };
  } catch { return null; }
}

export function valuePositionAmounts(asset: Omit<PositionAsset, 'valuation'>, observation: PriceObservation | undefined, maxAgeMs: number, now: Date): PositionAsset {
  if (!observation || observation.source !== 'CHAINLINK' || observation.evidence !== 'PUBLIC_READ_ONLY' || !observationFresh(observation, now, maxAgeMs) ||
      asset.units === null || asset.units === '0') return { ...asset, valuation: null };
  const usd = usdAmount(asset.units, asset.decimals, observation.priceUsd);
  return { ...asset, valuation: usd === null ? null : { usd, observedAt: observation.observedAt,
    expiresAt: new Date(Date.parse(observation.observedAt) + maxAgeMs).toISOString() } };
}
function priceFeed(chain: string, asset: PositionAsset): PriceFeedAsset | undefined {
  if (chain === ORCA.chain && asset.address === ORCA.token0.mint && asset.decimals === ORCA.token0.decimals) return 'SOL';
  if (Object.values(UNISWAP_POSITION_DEPLOYMENTS).some(deployment => deployment.chain === chain &&
      asset.address === deployment.weth && asset.decimals === 18)) return 'ETH';
  const stablecoin = CANONICAL_STABLECOINS.get(`${chain}:${asset.address}`);
  return stablecoin?.decimals === asset.decimals ? stablecoin.asset : undefined;
}
function attachPrices(scans: readonly PositionScan[], prices: Awaited<ReturnType<typeof usdObservations>>, now: Date): readonly PositionScan[] {
  if (!prices) return scans;
  return scans.map(scan => scan.provenance !== 'PUBLIC_MAINNET' ? scan : { ...scan, positions: scan.positions.map(position => ({
    ...position, assets: position.assets.map(asset => {
      const feed = priceFeed(scan.chain, asset);
      return valuePositionAmounts(asset, feed ? prices.observations.get(feed) : undefined, prices.source.maxAgeMs, now);
    }),
  })) });
}

const unvalued: ValuePositionAsset = asset => ({ ...asset, valuation: null });
async function scanOne(source: Pick<PositionScan, 'protocol' | 'network' | 'chain'>, signal: AbortSignal, work: () => Promise<PositionScan>): Promise<PositionScan> {
  try { return await budget(work(), signal); }
  catch { return snapshotState(source, 'UNAVAILABLE'); }
}

function evmScans(owner: string, now: Date, signal: AbortSignal): readonly Promise<PositionScan>[] {
  return EVM_NETWORKS.flatMap(id => {
    const network = CATALOG_NETWORKS[id], context = { network: network.name, chain: network.chain };
    const aave = { ...context, protocol: 'Aave V3' } as const, uniswap = { ...context, protocol: 'Uniswap V3' } as const;
    const lending = AAVE_V3_MARKETS.some(market => market.chain === network.chain);
    return [
      scanOne(aave, signal, async () => {
        if (!lending) return snapshotState(aave, 'UNSUPPORTED');
        const result = await supplyReserves(network.chain, owner);
        if (!result.ok) return snapshotState(aave, /NOT_ENABLED|NETWORK_UNAVAILABLE/.test(result.code) ? 'NETWORK_UNAVAILABLE' : 'UNAVAILABLE');
        if (result.value.chain !== network.chain || !result.value.provenance || (result.value.provenance === 'MOCKED' && isHostedDeployment(process.env)))
          return snapshotState(aave, 'UNAVAILABLE');
        return { ...aave, ...aavePositions(result.value, unvalued), provenance: result.value.provenance };
      }),
      scanOne(uniswap, signal, async () => {
        const mode = await defaultMode(id, process.env);
        if (mode === 'off') return snapshotState(uniswap, 'NETWORK_UNAVAILABLE');
        const rpc = rpcBeforeDeadline(network.rpc(mode, process.env, POSITION_EVM_METHODS), signal);
        // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the network's validated catalog decides which pools FloFi can manage; if it cannot be read in time,
        // positions are still shown but no operation is offered.
        const catalog = await budget(network.catalogFor(mode)(network.chain), signal).catch(() => null);
        return { ...uniswap, ...await uniswapPositions(rpc, UNISWAP_POSITION_DEPLOYMENTS[id], owner, now, registeredAssets[id], unvalued, mode === 'live',
          { network: network.name, catalog }), provenance: mode === 'live' ? 'PUBLIC_MAINNET' : 'MOCKED' };
      }),
    ];
  });
}
type Env = Readonly<Record<string, string | undefined>>;
/**
 * Where the Dashboard reads Orca positions on Solana mainnet-beta (`cloud`: the deployment's `orca-liquidity-mainnet` mode, null in local mode):
 * the configured (or public) mainnet RPC when that flow is live. BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a local server running the MOCKED Orca
 * mainnet harness (`GRYLOO_ORCA_MAINNET_HARNESS=MOCKED_LOOPBACK_ONLY`, the same switch as the app's Orca mainnet runtime) reads only the loopback
 * copy of the pool, as MOCKED, never a public endpoint; a hosted deployment never reads the harness. Null: no position read here.
 */
export function solanaPositionSource(env: Env, cloud: string | null): { readonly endpoint: string; readonly loopback: boolean; readonly provenance: 'PUBLIC_MAINNET' | 'MOCKED' } | null {
  const harness = env.GRYLOO_ORCA_MAINNET_HARNESS === 'MOCKED_LOOPBACK_ONLY';
  if (cloud === null && harness) return isHostedDeployment(env) ? null : { endpoint: ORCA_MAINNET_HARNESS_RPC, loopback: true, provenance: 'MOCKED' };
  if ((cloud ?? (env.GRYLOO_ORCA_MAINNET === 'live' ? 'live' : 'off')) !== 'live') return null;
  return { endpoint: solanaRpcOverride(env.GRYLOO_SOLANA_RPC_URL, 'POSITION_SOLANA_RPC_CONFIGURATION_INVALID') ?? ORCA.rpc, loopback: false, provenance: 'PUBLIC_MAINNET' };
}
async function solanaScan(owner: string, now: Date, signal: AbortSignal): Promise<PositionScan> {
  const source = solanaPositionSource(process.env, await cloudFlowMode('orca-liquidity-mainnet'));
  if (!source) return snapshotState(SOLANA_SETUP, 'NETWORK_UNAVAILABLE');
  const transport = createSolanaRpc(source.endpoint, source.loopback);
  const rpc = rpcBeforeDeadline((method, params) => {
    if (method !== 'getGenesisHash' && method !== 'getTokenAccountsByOwner' && method !== 'getMultipleAccounts')
      return Promise.reject(new Error('POSITION_SOLANA_METHOD_DENIED'));
    return transport(method, params);
  }, signal);
  return { ...SOLANA_SETUP, ...await orcaPositions(rpc, owner, now, unvalued), provenance: source.provenance };
}

/** BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: content-free discovery outcomes per liquidity network (bucketed counts; no address or position id). */
function discoveryOutcomes(scans: readonly PositionScan[]): void {
  for (const scan of scans) {
    if (scan.protocol === 'Aave V3' || scan.status === 'UNSUPPORTED' || scan.status === 'NETWORK_UNAVAILABLE') continue;
    const protocol = scan.protocol === 'Orca Whirlpools' ? 'ORCA' as const : 'UNISWAP_V3' as const, provenance = scan.provenance ?? 'UNKNOWN';
    if (scan.status !== 'UNAVAILABLE')
      recordLiquidityOutcome({ outcome: 'POSITIONS_DISCOVERED', protocol, network: scan.network, count: scan.positions.filter(position => position.liquidity).length, provenance });
    if (scan.status !== 'COMPLETE') recordLiquidityOutcome({ outcome: 'INSPECTION_UNAVAILABLE', protocol, network: scan.network, code: `POSITION_SCAN_${scan.status}`, provenance });
  }
}
async function readPositions(owner: PositionWallet): Promise<readonly PositionScan[]> {
  const started = new Date();
  const signal = AbortSignal.timeout(BUDGET_MS);
  const scans = await Promise.all(owner.namespace === 'eip155' ? evmScans(owner.address, started, signal)
    : [scanOne(SOLANA_SETUP, signal, () => solanaScan(owner.address, started, signal))]);
  discoveryOutcomes(scans);
  const requested = new Set<PriceFeedAsset>();
  for (const scan of scans) {
    if (scan.provenance !== 'PUBLIC_MAINNET') continue;
    for (const asset of scan.positions.flatMap(position => position.assets)) {
      if (asset.units === null || asset.units === '0') continue;
      const feed = priceFeed(scan.chain, asset);
      if (feed) requested.add(feed);
    }
  }
  if (!requested.size || signal.aborted) return scans;
  const prices = await budget(usdObservations(new Date(), requested), signal).catch(() => null);
  return attachPrices(scans, prices, new Date());
}

/**
 * Callers check ownership first: the Dashboard's owner-checked route, and (BUILD-FLOFI-UNIVERSAL-CHANNELS-001) MCP `get_portfolio` for wallets an
 * OAuth account linked after `/connections` disclosed position reads. Short, bounded, wallet-scoped cache, including inflight deduplication.
 */
export function readWalletPositions(owner: PositionWallet): Promise<readonly PositionScan[]> {
  const key = positionsWalletKey(owner), now = Date.now(), existing = cache.get(key);
  if (existing && existing.expires > now) return existing.read;
  const release = limiter.acquire();
  if (!release) return Promise.reject(new Error('POSITION_SCAN_BUSY'));
  const read = readPositions(owner).finally(release);
  const entry = { read, startedAt: now, expires: now + BUDGET_MS };
  cache.set(key, entry);
  void read.then(scans => {
    entry.expires = Date.now() + (scans.every(scan => scan.status === 'COMPLETE' || scan.status === 'UNSUPPORTED') ? COMPLETE_TTL_MS : PARTIAL_TTL_MS);
  }, () => { if (cache.get(key) === entry) cache.delete(key); });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return read;
}
/** Re-exported for the Dashboard's own callers and tests. */
export { forgetWalletPositions } from './defi-positions-cache';
