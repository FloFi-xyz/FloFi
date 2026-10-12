// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { isAbsolute, join } from 'node:path';
import { createPublicTestnetService, publicRecordingEnabled,
  type PublicTestnetService, type PublicRun, type PublicBegin } from '../server/public-testnet-service';
import { baseSepoliaSwapRpc, ethereumSepoliaSwapRpc } from '../server/public-testnet-rpc';
import { cloudFlow, cloudFlowMode } from '../server/flow-runtime';
import { CATALOG_NETWORKS, catalogNetworkOfChain, catalogNetworkOfRun, catalogNetworkOfWorkflow, localCatalogNetworkMode, type CatalogNetworkId,
  type CatalogNetworkRuntime } from '../server/catalog-networks';

export type PublicResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };
let service: PublicTestnetService | null = null;
let serviceDir: string | null = null;
function current(): PublicTestnetService {
  if (!publicRecordingEnabled(process.env)) throw new Error('PUBLIC_RECORDING_OFF');
  const dir = process.env.GRYLOO_PUBLIC_TESTNET_JOURNAL!;
  // Base Sepolia and Ethereum Sepolia each have their own chain-bound read client; the authored chain selects one.
  if (!service || serviceDir !== dir) { service = createPublicTestnetService({ rpc: baseSepoliaSwapRpc(process.env.GRYLOO_BASE_SEPOLIA_RPC_URL), rpcs: { 'eip155:11155111': ethereumSepoliaSwapRpc(process.env.GRYLOO_ETHEREUM_SEPOLIA_RPC_URL) }, journalDir: dir }); serviceDir = dir; }
  return service;
}
/**
 * BUILD-RH-002 / BUILD-BASE-001: catalog-network mainnet swaps (Robinhood Chain `rhs-`, Base `bas-`) on the same shared swap service, each
 * with its own runtime from the catalog-network registry. Live public reads need the network's `GRYLOO_<NETWORK>_MAINNET=live` in local
 * development (hosted deployments use the cloud flow); automated tests use only the loopback harness. Journal: `$<journal root>/swap`.
 */
const catalogServices = new Map<CatalogNetworkId, PublicTestnetService>();
function catalogService(network: CatalogNetworkRuntime): PublicTestnetService {
  const mode = localCatalogNetworkMode(network, process.env);
  if (mode === 'off') throw new Error(network.disabledCode);
  const dir = process.env[network.journalEnv];
  if (!dir || !isAbsolute(dir)) throw new Error(network.storageCode);
  let service = catalogServices.get(network.id);
  if (!service) {
    service = createPublicTestnetService({ rpc: async () => { throw new Error('PUBLIC_NETWORK_UNAVAILABLE'); },
      rpcs: { [network.chain]: network.rpc(mode, process.env) }, journalDir: join(dir, 'swap'), idPrefix: network.prefixes.swap,
      catalog: network.swapRuntime(mode, process.env, network.catalogFor(mode)) });
    catalogServices.set(network.id, service);
  }
  return service;
}
function code(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : 'PUBLIC_INTERNAL_ERROR';
}
async function run<T>(method: string, args: readonly unknown[], action: (service: PublicTestnetService) => T | Promise<T>,
  network: CatalogNetworkRuntime | null = catalogNetworkOfRun(args[0], 'swap')): Promise<PublicResult<T>> {
  // Cloud deployment: the remote Flofi API (BUILD-CLOUD-001) or the embedded PostgreSQL runtime (BUILD-CLOUD-PARITY-001).
  const cloud = await cloudFlow<T>(network ? network.flows.swap : 'base-sepolia-swap', method, args);
  if (cloud) return cloud;
  try { return { ok: true, value: await action(network ? catalogService(network) : current()) }; }
  catch (error) { return { ok: false, code: code(error) }; }
}
const id = (value: unknown) => typeof value === 'string' && /^(pub|rhs|bas|ars)-[0-9a-f]{24}$/.test(value) ? value : (() => { throw new Error('INPUT_INVALID'); })();
export async function publicPrepare(workflow: SemanticWorkflow, account?: string): Promise<PublicResult<PublicRun>> {
  // The authored swap's chain selects the deployment: a catalog network (Base's USDC ⇄ WETH reference swap included), else the testnets.
  return run('prepare', account ? [workflow, account] : [workflow], service => service.prepare(workflow, account), catalogNetworkOfWorkflow(workflow, 'asset.swap.exact-input'));
}
export async function publicRefresh(executionId: string): Promise<PublicResult<PublicRun>> {
  return run('refresh', [executionId], service => service.refresh(id(executionId)));
}
export async function publicReview(executionId: string, manifestHash: string): Promise<PublicResult<PublicRun>> {
  return run('review', [executionId, manifestHash], service => service.review(id(executionId), manifestHash));
}
export async function publicBegin(executionId: string, account: string): Promise<PublicResult<PublicBegin>> {
  return run('begin', [executionId, account], service => service.begin(id(executionId), account));
}
export async function publicReport(executionId: string, attemptId: string,
  result: { kind: 'HASH'; txHash: string } | { kind: 'REJECTED' | 'UNKNOWN' }): Promise<PublicResult<PublicRun>> {
  return run('report', [executionId, attemptId, result], service => service.report(id(executionId), attemptId, result));
}
export async function publicObserve(executionId: string): Promise<PublicResult<PublicRun>> {
  return run('observe', [executionId], service => service.observe(id(executionId)));
}
export async function publicStatus(executionId: string): Promise<PublicResult<PublicRun>> {
  return run('status', [executionId], service => service.load(id(executionId)));
}
export async function publicAvailability(): Promise<boolean> {
  const cloud = await cloudFlowMode('base-sepolia-swap');
  if (cloud) return cloud === 'live';
  return publicRecordingEnabled(process.env);
}
/** BUILD-RH-002 / BUILD-BASE-001: whether this instance serves a catalog network's mainnet swaps (live or the MOCKED loopback harness). */
export async function catalogSwapAvailability(chain: string): Promise<boolean> {
  const network = catalogNetworkOfChain(chain);
  if (!network) return false;
  const cloud = await cloudFlowMode(network.flows.swap);
  if (cloud) return cloud !== 'off';
  const dir = process.env[network.journalEnv];
  return localCatalogNetworkMode(network, process.env) !== 'off' && Boolean(dir && isAbsolute(dir));
}
/** BUILD-RH-002: whether this instance serves Robinhood Chain mainnet swaps (live or the MOCKED loopback harness). */
export async function robinhoodSwapAvailability(): Promise<boolean> { return catalogSwapAvailability(CATALOG_NETWORKS.robinhood.chain); }
