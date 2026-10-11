// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { isAbsolute, join } from 'node:path';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { createUniswapLiquidityService, type UniswapLiquidityService, type UniswapWalletDiagnostic } from '../server/uniswap-liquidity-service';
import { baseSepoliaLiquidityRpc, createBaseSepoliaReadRpc, ethereumSepoliaSwapRpc, UNISWAP_LIQUIDITY_RPC_METHODS } from '../server/public-testnet-rpc';
import { UNI_MOCK_CODE_PINS, UNI_MOCK_RPC_URL } from '../server/uniswap-liquidity-mock';
import { cloudFlow, cloudFlowMode } from '../server/flow-runtime';
import { CATALOG_NETWORKS, catalogNetworkOfChain, catalogNetworkOfRun, catalogNetworkOfWorkflow, localCatalogNetworkMode, type CatalogNetworkId,
  type CatalogNetworkRuntime } from '../server/catalog-networks';

/**
 * BUILD-UNISWAP-LIQUIDITY-PUBLIC: Uniswap v3 liquidity on Base Sepolia with test tokens. Simulation and Review are read-only;
 * each approval and the mint need the owner's Review, Execute click and wallet signature. Flofi never signs or sends.
 * Deployed: forwards the identical contract to the Flofi API (PostgreSQL, workers). Local: the same service on files.
 */
type Mode = 'live' | 'harness' | 'off';
function localMode(): Mode {
  if (process.env.GRYLOO_UNISWAP_LIQUIDITY_HARNESS === 'MOCKED_LOOPBACK_ONLY') return 'harness';
  return process.env.GRYLOO_UNISWAP_LIQUIDITY_TESTNET === 'live' ? 'live' : 'off';
}
let service: UniswapLiquidityService | null = null;
function current(): UniswapLiquidityService {
  const mode = localMode();
  if (mode === 'off') throw new Error('UNISWAP_LIQUIDITY_PUBLIC_TESTNET_NOT_ENABLED');
  const journalDir = process.env.GRYLOO_UNISWAP_LIQUIDITY_JOURNAL;
  if (!journalDir || !isAbsolute(journalDir)) throw new Error('UNISWAP_LIQUIDITY_STORAGE_NOT_CONFIGURED');
  service ??= createUniswapLiquidityService({ storage: createFileExecutionStorage(journalDir, 'UNISWAP_LIQUIDITY_BUSY'),
    rpc: mode === 'harness' ? createBaseSepoliaReadRpc(UNI_MOCK_RPC_URL, UNISWAP_LIQUIDITY_RPC_METHODS) : baseSepoliaLiquidityRpc(process.env.GRYLOO_BASE_SEPOLIA_RPC_URL),
    // BUILD-ETHEREUM-001: live Ethereum Sepolia reads use their own chain-bound client; the MOCKED harness is Base Sepolia only.
    ...mode === 'live' ? { rpcs: { 'eip155:11155111': ethereumSepoliaSwapRpc(process.env.GRYLOO_ETHEREUM_SEPOLIA_RPC_URL, UNISWAP_LIQUIDITY_RPC_METHODS) } } : {},
    provenance: mode === 'harness' ? 'MOCKED' : 'PUBLIC_TESTNET', executionEnabled: process.env.GRYLOO_UNISWAP_LIQUIDITY_EXECUTION !== 'DISABLED',
    ...mode === 'harness' ? { mockedCodePins: UNI_MOCK_CODE_PINS } : {} });
  return service;
}
/**
 * BUILD-RH-002 / BUILD-BASE-001: catalog-network (real funds) positions on catalog pairs — Robinhood Chain `rhlp-`, Base `balp-` — at
 * `$<journal root>/liquidity`: `GRYLOO_<NETWORK>_MAINNET=live` in local development (hosted deployments use the cloud flow) or the loopback
 * harness; owner execution additionally needs `GRYLOO_<NETWORK>_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`.
 */
const catalogServices = new Map<CatalogNetworkId, UniswapLiquidityService>();
function catalogService(network: CatalogNetworkRuntime): UniswapLiquidityService {
  const mode = localCatalogNetworkMode(network, process.env);
  if (mode === 'off') throw new Error(network.disabledCode);
  const journalDir = process.env[network.journalEnv];
  if (!journalDir || !isAbsolute(journalDir)) throw new Error('UNISWAP_LIQUIDITY_STORAGE_NOT_CONFIGURED');
  let service = catalogServices.get(network.id);
  if (!service) {
    service = createUniswapLiquidityService({ storage: createFileExecutionStorage(join(journalDir, 'liquidity'), 'UNISWAP_LIQUIDITY_BUSY'),
      rpc: async () => { throw new Error('UNISWAP_NETWORK_UNAVAILABLE'); }, rpcs: { [network.chain]: network.rpc(mode, process.env, network.liquidityRpcMethods) },
      provenance: mode === 'harness' ? 'MOCKED' : 'PUBLIC_MAINNET', executionEnabled: network.ownerExecutionEnabled(mode, process.env),
      catalog: { chain: network.chain, catalogFor: network.catalogFor(mode) } });
    catalogServices.set(network.id, service);
  }
  return service;
}
/** The catalog network a call addresses: its run's namespace, a named chain, or the chain of its workflow's position. */
const catalogCall = (args: readonly unknown[]) => typeof args[0] === 'string' ? catalogNetworkOfRun(args[0], 'liquidity') ?? catalogNetworkOfChain(args[0])
  : catalogNetworkOfWorkflow(args[0], 'asset.liquidity.concentrated');
async function run<T>(method: string, args: readonly unknown[], action: (service: UniswapLiquidityService) => Promise<T>,
  explicit?: CatalogNetworkRuntime): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  const network = explicit ?? catalogCall(args);
  // Cloud deployment: the remote Flofi API (BUILD-CLOUD-001) or the embedded PostgreSQL runtime (BUILD-CLOUD-PARITY-001).
  const cloud = await cloudFlow<T>(network ? network.flows.liquidity : 'uniswap-liquidity', method, args);
  if (cloud) return cloud;
  try { return { ok: true, value: await action(network ? catalogService(network) : current()) }; }
  catch (cause) { const code = cause instanceof Error ? cause.message : ''; return { ok: false, code: /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : 'UNISWAP_LIQUIDITY_SERVICE_UNAVAILABLE' }; }
}
export async function uniswapLiquidityMode(): Promise<Mode> {
  return await cloudFlowMode('uniswap-liquidity') ?? localMode();
}
export async function uniswapLiquidityInfo() { return run('info', [], async s => ({ executionEnabled: s.executionEnabled })); }
/** BUILD-RH-002 / BUILD-BASE-001: whether this instance serves a catalog network's positions (live or the MOCKED loopback harness). */
export async function catalogLiquidityMode(chain: string): Promise<Mode> {
  const network = catalogNetworkOfChain(chain);
  if (!network) return 'off';
  const cloud = await cloudFlowMode(network.flows.liquidity);
  if (cloud) return cloud;
  return localCatalogNetworkMode(network, process.env);
}
/** A catalog network's owner-execution switch. */
export async function catalogLiquidityInfo(chain: string) {
  const network = catalogNetworkOfChain(chain);
  if (!network) return { ok: false as const, code: 'UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED' };
  return run('info', [], async s => ({ executionEnabled: s.executionEnabled }), network);
}
/** The current price of one catalog-network pool (its two catalog token addresses and fee tier). */
export async function catalogLiquidityPrice(chain: string, pair: { tokenA: string; tokenB: string; fee: number }) {
  const network = catalogNetworkOfChain(chain);
  if (!network) return { ok: false as const, code: 'UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED' };
  return run('price', [network.chain, pair], s => s.price(network.chain, pair), network);
}
export async function robinhoodLiquidityMode(): Promise<Mode> { return catalogLiquidityMode(CATALOG_NETWORKS.robinhood.chain); }
export async function robinhoodLiquidityInfo() { return catalogLiquidityInfo(CATALOG_NETWORKS.robinhood.chain); }
export async function uniswapLiquidityPrice(chain?: 'eip155:84532' | 'eip155:11155111') { return run('price', chain ? [chain] : [], s => s.price(chain)); }
/** BUILD-RH-002: the current price of one Robinhood Chain pool (its two catalog token addresses and fee tier). */
export async function robinhoodLiquidityPrice(pair: { tokenA: string; tokenB: string; fee: number }) { return catalogLiquidityPrice(CATALOG_NETWORKS.robinhood.chain, pair); }
export async function uniswapLiquiditySimulate(workflow: SemanticWorkflow, owner: string) { return run('simulate', [workflow, owner], s => s.simulate(workflow, owner)); }
export async function uniswapLiquidityRefresh(id: string) { return run('refresh', [id], s => s.refresh(id)); }
export async function uniswapLiquidityReview(id: string, commitment: string, workflow: SemanticWorkflow) { return run('review', [id, commitment, workflow], s => s.review(id, commitment, workflow)); }
export async function uniswapLiquidityInvalidate(id: string) { return run('invalidate', [id], s => s.invalidate(id)); }
export async function uniswapLiquidityBegin(id: string, owner: string, workflow: SemanticWorkflow) { return run('begin', [id, owner, workflow], s => s.begin(id, owner, workflow)); }
export async function uniswapLiquidityHandoff(id: string) { return run('handoff', [id], s => s.handoff(id)); }
export async function uniswapLiquidityReport(id: string, result: { kind: 'HASH'; hash: string } | { kind: 'UNKNOWN' | 'REJECTED'; code?: string }) {
  return run('report', [id, result], s => s.report(id, result));
}
export async function uniswapLiquidityWalletFailure(id: string, diagnostic: UniswapWalletDiagnostic) { return run('walletFailure', [id, diagnostic], s => s.walletFailure(id, diagnostic)); }
export async function uniswapLiquidityObserve(id: string) { return run('observe', [id], s => s.observe(id)); }
export async function uniswapLiquidityStatus(id: string) { return run('status', [id], s => s.load(id)); }
