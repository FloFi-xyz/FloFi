// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ROUTER-001 runtime configuration, shared by the in-process server action and the cloud backend flow.
 * Read-only RPC clients (allowlisted methods; no send, sign or wallet method can exist), provider transports and the
 * explicit gates:
 *  - `GRYLOO_ROUTER=live`: read-only quotes, simulation and Review on Base mainnet / Arbitrum One;
 *  - `GRYLOO_ROUTER_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`: additionally allows `begin` (the owner's wallet still signs
 *    and sends every transaction; Flofi never does) — the same real-funds deployment opt-in as the Jupiter mainnet flow;
 *  - `GRYLOO_ROUTER_HARNESS=MOCKED_LOOPBACK_ONLY`: the loopback MOCKED harness (tests); it always wins over `live`.
 * BUILD-JOURNEY-001, the same router on public testnets (Base Sepolia → Arbitrum Sepolia, test USDC), a separate flow:
 *  - `GRYLOO_ROUTER_TESTNET=live`: quotes, simulation, Review and owner-wallet execution (like every other testnet flow);
 *    `GRYLOO_ROUTER_TESTNET_EXECUTION=DISABLED` keeps it Simulate/Review-only;
 *  - `GRYLOO_ROUTER_TESTNET_HARNESS=MOCKED_LOOPBACK_ONLY`: its loopback MOCKED harness (tests only).
 * BUILD-BASE-001, Base bridge IN from Arbitrum One (`arbitrum-to-base`, Arbitrum USDC → Base USDC): the reverse of the Base ↔ Arbitrum
 * deployment, so it follows the Router's own gates (`GRYLOO_ROUTER`, `GRYLOO_ROUTER_OWNER_EXECUTION`, `GRYLOO_ROUTER_HARNESS`) as its own flow
 * and storage.
 */
import { ETHEREUM_ROUTER_DEPLOYMENTS, ETHEREUM_ROUTER_NETWORKS, type EthereumRouterNetwork, CROSSCHAIN_ROUTER_ARBITRUM_BASE, CROSSCHAIN_ROUTER_ARBITRUM_ROBINHOOD, CROSSCHAIN_ROUTER_BASE_ARBITRUM as profile, CROSSCHAIN_ROUTER_BASE_ROBINHOOD, CROSSCHAIN_ROUTER_BASE_SEPOLIA_ARBITRUM_SEPOLIA as TESTNET,
  CROSSCHAIN_ROUTER_ROBINHOOD_ARBITRUM, CROSSCHAIN_ROUTER_ROBINHOOD_BASE, type RouterProfile } from '@defi-workflow-engine/action-registry';
import { ethereumMainnetMode, ethereumOwnerExecutionEnabled } from './ethereum-mainnet.ts';
import { robinhoodMainnetMode, robinhoodOwnerExecutionEnabled, robinhoodRpcUrl } from './robinhood-mainnet.ts';
import { chainBoundRpc } from './public-testnet-rpc.ts';
import { bridgeReadRpc } from './bridge-read-rpc.ts';
import type { RoutingProvider } from '@defi-workflow-engine/workflow-contracts';
import { createBaseSepoliaReadRpc, pacedReadRpc } from './public-testnet-rpc.ts';
import type { Rpc } from './public-testnet-service.ts';
import { createRouteProviders, createRouterHttp, type RouteProvider } from './router-providers.ts';
import { ROUTER_MOCK_ACROSS_API, ROUTER_MOCK_ARBITRUM_RPC_URL, ROUTER_MOCK_BASE_RPC_URL, ROUTER_MOCK_CODE_PINS, ROUTER_MOCK_LIFI_API, ROUTER_TESTNET_MOCK } from './router-mock.ts';
import type { RouterCodePins, RouterProvenance } from './router-service.ts';

export type RouterMode = 'live' | 'harness' | 'off';
/**
 * BUILD-JOURNEY-001: which router deployment a call addresses. Each network is its own flow and durable namespace.
 * BUILD-RH-002: the four Robinhood Chain routes (real funds), each its own deployment, flow and storage.
 */
export const ROBINHOOD_ROUTER_NETWORKS = Object.freeze(['base-to-robinhood', 'robinhood-to-base', 'arbitrum-to-robinhood', 'robinhood-to-arbitrum'] as const);
export type RobinhoodRouterNetwork = typeof ROBINHOOD_ROUTER_NETWORKS[number];
/** BUILD-BASE-001: the Router's further Base routes, each its own deployment, flow and storage under the Router's gates. */
export const BASE_ROUTER_NETWORKS = Object.freeze(['arbitrum-to-base'] as const);
export type BaseRouterNetwork = typeof BASE_ROUTER_NETWORKS[number];
export type RouterNetwork = EthereumRouterNetwork | 'mainnet' | 'testnet' | RobinhoodRouterNetwork | BaseRouterNetwork;
export const ROUTER_NETWORKS: readonly RouterNetwork[] = Object.freeze(['mainnet', 'testnet', ...ROBINHOOD_ROUTER_NETWORKS, ...BASE_ROUTER_NETWORKS, ...ETHEREUM_ROUTER_NETWORKS]);
const BASE_ROUTER_PROFILES: Readonly<Record<BaseRouterNetwork, RouterProfile>> = Object.freeze({ 'arbitrum-to-base': CROSSCHAIN_ROUTER_ARBITRUM_BASE });
export const isBaseRouterNetwork = (network: RouterNetwork): network is BaseRouterNetwork => (BASE_ROUTER_NETWORKS as readonly string[]).includes(network);
export const ROBINHOOD_ROUTER_PROFILES: Readonly<Record<RobinhoodRouterNetwork, RouterProfile>> = Object.freeze({
  'base-to-robinhood': CROSSCHAIN_ROUTER_BASE_ROBINHOOD, 'robinhood-to-base': CROSSCHAIN_ROUTER_ROBINHOOD_BASE,
  'arbitrum-to-robinhood': CROSSCHAIN_ROUTER_ARBITRUM_ROBINHOOD, 'robinhood-to-arbitrum': CROSSCHAIN_ROUTER_ROBINHOOD_ARBITRUM });
export const isRobinhoodRouterNetwork = (network: RouterNetwork): network is RobinhoodRouterNetwork => (ROBINHOOD_ROUTER_NETWORKS as readonly string[]).includes(network);
const isEthereumRouterNetwork = (network: RouterNetwork): network is EthereumRouterNetwork => (ETHEREUM_ROUTER_NETWORKS as readonly string[]).includes(network);
/** The router profile a network key serves. */
export const routerNetworkProfile = (network: RouterNetwork): RouterProfile => isEthereumRouterNetwork(network) ? ETHEREUM_ROUTER_DEPLOYMENTS[network] : isRobinhoodRouterNetwork(network) ? ROBINHOOD_ROUTER_PROFILES[network]
  : isBaseRouterNetwork(network) ? BASE_ROUTER_PROFILES[network] : network === 'testnet' ? TESTNET : profile;
type Env = Readonly<Record<string, string | undefined>>;
export const ROUTER_BASE_RPC_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getBalance',
  'eth_getTransactionCount', 'eth_maxPriorityFeePerGas', 'eth_gasPrice', 'eth_estimateGas', 'eth_simulateV1', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getStorageAt', 'eth_getLogs']);
export const ROUTER_ARBITRUM_RPC_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getLogs',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getStorageAt']);
export function routerMode(env: Env): RouterMode {
  if (env.GRYLOO_ROUTER_HARNESS === 'MOCKED_LOOPBACK_ONLY') return 'harness';
  return env.GRYLOO_ROUTER === 'live' ? 'live' : 'off';
}
export function routerTestnetMode(env: Env): RouterMode {
  if (env.GRYLOO_ROUTER_TESTNET_HARNESS === 'MOCKED_LOOPBACK_ONLY') return 'harness';
  return env.GRYLOO_ROUTER_TESTNET === 'live' ? 'live' : 'off';
}
/** Robinhood routes follow the Robinhood Chain mainnet gates (`GRYLOO_ROBINHOOD_MAINNET`, its loopback harness), like every Robinhood capability. */
export const routerNetworkMode = (network: RouterNetwork, env: Env): RouterMode => isEthereumRouterNetwork(network) ? (ethereumMainnetMode(env) === 'live' && routerMode(env) === 'live' ? 'live' : 'off') : isRobinhoodRouterNetwork(network) ? robinhoodMainnetMode(env)
  : network === 'testnet' ? routerTestnetMode(env) : routerMode(env);
/** The Router's own real-funds owner-execution opt-in (Base ↔ Arbitrum); the MOCKED harness always allows it (loopback only). */
const routerOwnerExecutionEnabled = (mode: 'live' | 'harness', env: Env) => mode === 'harness' || env.GRYLOO_ROUTER_OWNER_EXECUTION === 'MAINNET_OWNER_APPROVED';
/** Optional HTTPS override (e.g. a keyed provider for rate limits); anything else is a configuration error. */
export function routerRpcUrl(override: string | undefined, fallback: string): string {
  if (override === undefined || override === '') return fallback;
  let url: URL;
  try { url = new URL(override); } catch { throw new Error('ROUTER_RPC_CONFIGURATION_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('ROUTER_RPC_CONFIGURATION_INVALID');
  return url.href;
}
// BUILD-CLOUD-PARITY-001: shared with every Base Sepolia read client (moved to public-testnet-rpc.ts; same behavior).
export { pacedReadRpc };
export type RouterRuntime = { readonly sourceRpc: Rpc; readonly destinationRpc: Rpc; readonly providers: Readonly<Record<RoutingProvider, RouteProvider>>;
  readonly provenance: RouterProvenance; readonly executionEnabled: boolean; readonly mockedCodePins?: RouterCodePins; readonly profile: RouterProfile };
export function routerRuntime(mode: 'live' | 'harness', env: Env): RouterRuntime {
  const http = createRouterHttp();
  if (mode === 'harness') return { sourceRpc: createBaseSepoliaReadRpc(ROUTER_MOCK_BASE_RPC_URL, ROUTER_BASE_RPC_METHODS),
    destinationRpc: createBaseSepoliaReadRpc(ROUTER_MOCK_ARBITRUM_RPC_URL, ROUTER_ARBITRUM_RPC_METHODS),
    providers: createRouteProviders({ http, lifiApi: ROUTER_MOCK_LIFI_API, acrossApi: ROUTER_MOCK_ACROSS_API }), provenance: 'MOCKED', executionEnabled: true,
    mockedCodePins: ROUTER_MOCK_CODE_PINS, profile };
  return { sourceRpc: bridgeReadRpc(profile.source.chainId, routerRpcUrl(env.GRYLOO_BASE_RPC_URL, profile.source.rpc), ROUTER_BASE_RPC_METHODS, env, Boolean(env.GRYLOO_BASE_RPC_URL)),
    destinationRpc: bridgeReadRpc(profile.destination.chainId, routerRpcUrl(env.GRYLOO_ARBITRUM_RPC_URL, profile.destination.rpc), ROUTER_ARBITRUM_RPC_METHODS, env,
      Boolean(env.GRYLOO_ARBITRUM_RPC_URL)),
    providers: createRouteProviders({ http, ...env.ACROSS_API_KEY ? { acrossApiKey: env.ACROSS_API_KEY } : {}, ...env.ACROSS_INTEGRATOR_ID ? { acrossIntegratorId: env.ACROSS_INTEGRATOR_ID } : {},
      ...env.LIFI_API_KEY ? { lifiApiKey: env.LIFI_API_KEY } : {} }),
    provenance: 'PUBLIC_MAINNET', executionEnabled: env.GRYLOO_ROUTER_OWNER_EXECUTION === 'MAINNET_OWNER_APPROVED', profile };
}
/**
 * BUILD-JOURNEY-001: Base Sepolia → Arbitrum Sepolia with test USDC. Public read-only RPCs (optionally keyed HTTPS overrides; the
 * Base Sepolia one is shared with the Uniswap liquidity flow) and the providers' testnet endpoints. Owner-wallet execution is
 * on by default, as for the other testnet flows; Flofi still never signs or sends.
 */
export function routerTestnetRuntime(mode: 'live' | 'harness', env: Env): RouterRuntime {
  const http = createRouterHttp();
  if (mode === 'harness') return { sourceRpc: createBaseSepoliaReadRpc(ROUTER_TESTNET_MOCK.baseRpc, ROUTER_BASE_RPC_METHODS),
    destinationRpc: createBaseSepoliaReadRpc(ROUTER_TESTNET_MOCK.arbitrumRpc, ROUTER_ARBITRUM_RPC_METHODS),
    providers: createRouteProviders({ http, profile: TESTNET, lifiApi: ROUTER_TESTNET_MOCK.lifiApi, acrossApi: ROUTER_TESTNET_MOCK.acrossApi }),
    provenance: 'MOCKED', executionEnabled: true, mockedCodePins: ROUTER_TESTNET_MOCK.codePins, profile: TESTNET };
  return { sourceRpc: pacedReadRpc(createBaseSepoliaReadRpc(routerRpcUrl(env.GRYLOO_BASE_SEPOLIA_RPC_URL, TESTNET.source.rpc), ROUTER_BASE_RPC_METHODS)),
    destinationRpc: pacedReadRpc(createBaseSepoliaReadRpc(routerRpcUrl(env.GRYLOO_ARBITRUM_SEPOLIA_RPC_URL, TESTNET.destination.rpc), ROUTER_ARBITRUM_RPC_METHODS)),
    providers: createRouteProviders({ http, profile: TESTNET, ...env.LIFI_API_KEY ? { lifiApiKey: env.LIFI_API_KEY } : {} }),
    provenance: 'PUBLIC_TESTNET', executionEnabled: env.GRYLOO_ROUTER_TESTNET_EXECUTION !== 'DISABLED', profile: TESTNET };
}
/**
 * BUILD-RH-002: a Robinhood Chain route. Source and destination read clients are chain-bound (Base, Arbitrum One or Robinhood Chain;
 * optional HTTPS overrides `GRYLOO_BASE_RPC_URL`, `GRYLOO_ARBITRUM_RPC_URL`, `GRYLOO_ROBINHOOD_RPC_URL`). Owner execution needs the
 * Robinhood real-funds opt-in. The MOCKED harness has no public endpoint: its loopback chains are injected by tests.
 */
export function robinhoodRouterRuntime(network: RobinhoodRouterNetwork, mode: 'live' | 'harness', env: Env): RouterRuntime {
  return pairRouterRuntime(ROBINHOOD_ROUTER_PROFILES[network], mode, env, robinhoodOwnerExecutionEnabled(mode, env), 8561);
}
/** BUILD-BASE-001: a Base route of the Router (Arbitrum One → Base) under the Router's own gates; its MOCKED loopback chains are injected by tests. */
export function baseRouterRuntime(network: BaseRouterNetwork, mode: 'live' | 'harness', env: Env): RouterRuntime {
  return pairRouterRuntime(BASE_ROUTER_PROFILES[network], mode, env, routerOwnerExecutionEnabled(mode, env), 8562);
}
/** One verified route between two chains with chain-bound read clients (Base, Arbitrum One or Robinhood Chain; optional HTTPS overrides). */
function pairRouterRuntime(route: RouterProfile, mode: 'live' | 'harness', env: Env, executionEnabled: boolean, harnessPort: number): RouterRuntime {
  const http = createRouterHttp();
  const url = (chainId: number) => mode === 'harness' ? `http://127.0.0.1:${harnessPort}/router/${chainId}` : chainId === 4663 ? robinhoodRpcUrl(env.GRYLOO_ROBINHOOD_RPC_URL)
    : routerRpcUrl(chainId === 1 ? env.GRYLOO_ETHEREUM_RPC_URL : chainId === 8453 ? env.GRYLOO_BASE_RPC_URL : env.GRYLOO_ARBITRUM_RPC_URL,
      (route.source.chainId === chainId ? route.source : route.destination).rpc);
  const client = (chainId: number, methods: readonly string[]) => mode === 'harness' ? chainBoundRpc(createBaseSepoliaReadRpc(url(chainId), methods), chainId)
    : bridgeReadRpc(chainId, url(chainId), methods, env, Boolean(chainId === 4663 ? env.GRYLOO_ROBINHOOD_RPC_URL : chainId === 1 ? env.GRYLOO_ETHEREUM_RPC_URL
      : chainId === 8453 ? env.GRYLOO_BASE_RPC_URL : env.GRYLOO_ARBITRUM_RPC_URL));
  return { sourceRpc: client(route.source.chainId, ROUTER_BASE_RPC_METHODS), destinationRpc: client(route.destination.chainId, ROUTER_ARBITRUM_RPC_METHODS),
    providers: createRouteProviders({ http, profile: route, ...mode === 'live' && env.ACROSS_API_KEY ? { acrossApiKey: env.ACROSS_API_KEY } : {},
      ...mode === 'live' && env.ACROSS_INTEGRATOR_ID ? { acrossIntegratorId: env.ACROSS_INTEGRATOR_ID } : {}, ...mode === 'live' && env.LIFI_API_KEY ? { lifiApiKey: env.LIFI_API_KEY } : {},
      ...mode === 'harness' ? { lifiApi: `http://127.0.0.1:${harnessPort}/lifi`, acrossApi: `http://127.0.0.1:${harnessPort}/across` } : {} }),
    provenance: mode === 'harness' ? 'MOCKED' : 'PUBLIC_MAINNET', executionEnabled, profile: route };
}
export const routerNetworkRuntime = (network: RouterNetwork, mode: 'live' | 'harness', env: Env): RouterRuntime =>
  isEthereumRouterNetwork(network) ? ethereumRouterRuntime(network, mode, env) : isRobinhoodRouterNetwork(network) ? robinhoodRouterRuntime(network, mode, env) : isBaseRouterNetwork(network) ? baseRouterRuntime(network, mode, env)
    : network === 'testnet' ? routerTestnetRuntime(mode, env) : routerRuntime(mode, env);

/** Same Router and receipt reconciler, with independent deployment-wide Ethereum and Router opt-ins. */
function ethereumRouterRuntime(network: EthereumRouterNetwork, mode: 'live' | 'harness', env: Env): RouterRuntime {
  if (mode !== 'live') throw new Error('ETHEREUM_MAINNET_NOT_ENABLED');
  const enabled = ethereumMainnetMode(env) === 'live' && ethereumOwnerExecutionEnabled(mode, env) && routerOwnerExecutionEnabled(mode, env);
  return pairRouterRuntime(ETHEREUM_ROUTER_DEPLOYMENTS[network], mode, env, enabled, 8565);
}
