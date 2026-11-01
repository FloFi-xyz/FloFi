// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001 runtime configuration, shared by the in-process server actions and the cloud backend flow.
 * Read-only RPC clients (allowlisted methods; no send or sign method on any EVM client; Solana `sendTransaction` exists only on the
 * owner-signed submit path), provider transports and the explicit deployment gates:
 *  - `GRYLOO_UNIVERSAL_ROUTER=live`: route discovery, quotes, simulation and Review on the five mainnets (read-only);
 *  - `GRYLOO_UNIVERSAL_ROUTER_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`: additionally allows `begin` — the owner's wallet still signs every
 *    transaction (EVM: the wallet sends; Solana: FloFi broadcasts the verified owner-signed bytes once). Real funds;
 *  - `GRYLOO_UNIVERSAL_ROUTER_HARNESS=MOCKED_LOOPBACK_ONLY`: the loopback MOCKED harness (tests); it always wins over `live`.
 * Optional HTTPS RPC overrides reuse the existing variables (`GRYLOO_BASE_RPC_URL`, `GRYLOO_ARBITRUM_RPC_URL`, `GRYLOO_ETHEREUM_RPC_URL`,
 * `GRYLOO_ROBINHOOD_RPC_URL`, `GRYLOO_SOLANA_RPC_URL`); optional provider keys `RELAY_API_KEY`, `LIFI_API_KEY` stay server-side.
 */
import { UNIVERSAL_ROUTER_DEPLOYMENT, type UniversalRouterDeployment } from '@defi-workflow-engine/action-registry';
import type { SolanaRpc } from '@defi-workflow-engine/reference-compiler';
import { chainBoundRpc, createBaseSepoliaReadRpc } from '../public-testnet-rpc.ts';
import type { Rpc } from '../public-testnet-service.ts';
import { robinhoodRpcUrl } from '../robinhood-mainnet.ts';
import { routerRpcUrl } from '../router-runtime.ts';
import { bridgeReadRpc } from '../bridge-read-rpc.ts';
import { createSolanaRpc, solanaRpcOverride } from '../solana-rpc.ts';
import { createUniversalHttp, type UniversalHttp } from './http.ts';
import { mockedUniversalDeployment, UNIVERSAL_HARNESS_PORT } from './mock-deployment.ts';
import type { UniversalProvenance } from './types.ts';

export type UniversalRouterMode = 'live' | 'harness' | 'off';
type Env = Readonly<Record<string, string | undefined>>;
export function universalRouterMode(env: Env): UniversalRouterMode {
  if (env.GRYLOO_UNIVERSAL_ROUTER_HARNESS === 'MOCKED_LOOPBACK_ONLY') return 'harness';
  return env.GRYLOO_UNIVERSAL_ROUTER === 'live' ? 'live' : 'off';
}
export const universalOwnerExecutionEnabled = (mode: 'live' | 'harness', env: Env) => mode === 'harness' || env.GRYLOO_UNIVERSAL_ROUTER_OWNER_EXECUTION === 'MAINNET_OWNER_APPROVED';
export const UNIVERSAL_EVM_RPC_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getBalance',
  'eth_getTransactionCount', 'eth_maxPriorityFeePerGas', 'eth_gasPrice', 'eth_estimateGas', 'eth_simulateV1', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs']);
export type UniversalRouterTransport = { readonly evmRpcs: Readonly<Record<string, Rpc>>; readonly solanaRpc: SolanaRpc; readonly http: UniversalHttp;
  readonly apis: { readonly relay?: string; readonly lifi?: string; readonly mayan?: string; readonly across?: string } };
export type UniversalRouterRuntime = UniversalRouterTransport & { readonly provenance: UniversalProvenance; readonly executionEnabled: boolean;
  readonly mockedDeployment?: UniversalRouterDeployment; readonly keys: { readonly relay?: string; readonly lifi?: string } };
const overrideOf = (env: Env, chainId: number) => chainId === 1 ? env.GRYLOO_ETHEREUM_RPC_URL : chainId === 8453 ? env.GRYLOO_BASE_RPC_URL : env.GRYLOO_ARBITRUM_RPC_URL;
export function universalRouterTransport(mode: 'live' | 'harness', env: Env): UniversalRouterTransport {
  const D = UNIVERSAL_ROUTER_DEPLOYMENT, loop = `http://127.0.0.1:${UNIVERSAL_HARNESS_PORT}`;
  const evmRpcs = Object.fromEntries(Object.values(D.evm).map(d => {
    const url = mode === 'harness' ? `${loop}/evm/${d.chainId}` : d.chainId === 4663 ? robinhoodRpcUrl(env.GRYLOO_ROBINHOOD_RPC_URL) : routerRpcUrl(overrideOf(env, d.chainId), d.rpc);
    const client = createBaseSepoliaReadRpc(url, UNIVERSAL_EVM_RPC_METHODS);
    return [d.chain, mode === 'harness' ? chainBoundRpc(client, d.chainId) : bridgeReadRpc(d.chainId, url, UNIVERSAL_EVM_RPC_METHODS, env,
      Boolean(d.chainId === 4663 ? env.GRYLOO_ROBINHOOD_RPC_URL : overrideOf(env, d.chainId)))];
  }));
  const solanaRpc = createSolanaRpc(mode === 'harness' ? `${loop}/solana` : solanaRpcOverride(env.GRYLOO_SOLANA_RPC_URL, 'UNIVERSAL_RPC_CONFIGURATION_INVALID') ?? D.solana.rpc,
    mode === 'harness');
  return { evmRpcs, solanaRpc, http: createUniversalHttp(),
    apis: mode === 'harness' ? { relay: `${loop}/relay`, lifi: `${loop}/lifi`, mayan: `${loop}/mayan`, across: `${loop}/across` } : {} };
}
export function universalRouterRuntime(mode: 'live' | 'harness', env: Env, transport: UniversalRouterTransport = universalRouterTransport(mode, env)): UniversalRouterRuntime {
  return { ...transport, provenance: mode === 'harness' ? 'MOCKED' : 'PUBLIC_MAINNET', executionEnabled: universalOwnerExecutionEnabled(mode, env),
    ...mode === 'harness' ? { mockedDeployment: mockedUniversalDeployment() } : {},
    keys: mode === 'live' ? { ...env.RELAY_API_KEY ? { relay: env.RELAY_API_KEY } : {}, ...env.LIFI_API_KEY ? { lifi: env.LIFI_API_KEY } : {} } : {} };
}
