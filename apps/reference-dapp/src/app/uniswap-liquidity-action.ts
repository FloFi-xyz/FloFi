// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { isAbsolute, join } from 'node:path';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { createUniswapLiquidityService, type UniswapLiquidityService, type UniswapWalletDiagnostic } from '../server/uniswap-liquidity-service';
import { baseSepoliaLiquidityRpc, createBaseSepoliaReadRpc, ethereumSepoliaSwapRpc, UNISWAP_LIQUIDITY_RPC_METHODS } from '../server/public-testnet-rpc';
import { UNI_MOCK_CODE_PINS, UNI_MOCK_RPC_URL } from '../server/uniswap-liquidity-mock';
import { cloudFlow, cloudFlowMode } from '../server/flow-runtime';
import { robinhoodCatalogFor, robinhoodMainnetMode, robinhoodMainnetRpc, robinhoodOwnerExecutionEnabled, ROBINHOOD_LIQUIDITY_RPC_METHODS } from '../server/robinhood-mainnet';

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
 * BUILD-RH-002: Robinhood Chain (real funds) positions on official catalog pairs, `rhlp-` runs at `$GRYLOO_ROBINHOOD_JOURNAL/liquidity`:
 * `GRYLOO_ROBINHOOD_MAINNET=live` in local development (hosted deployments use the cloud flow) or the loopback harness; owner execution
 * additionally needs `GRYLOO_ROBINHOOD_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`.
 */
let robinhoodService: UniswapLiquidityService | null = null;
function robinhood(): UniswapLiquidityService {
  const mode = robinhoodMainnetMode(process.env);
  if (mode === 'off' || (mode === 'live' && process.env.NODE_ENV !== 'development')) throw new Error('ROBINHOOD_MAINNET_NOT_ENABLED');
  const journalDir = process.env.GRYLOO_ROBINHOOD_JOURNAL;
  if (!journalDir || !isAbsolute(journalDir)) throw new Error('UNISWAP_LIQUIDITY_STORAGE_NOT_CONFIGURED');
  robinhoodService ??= createUniswapLiquidityService({ storage: createFileExecutionStorage(join(journalDir, 'liquidity'), 'UNISWAP_LIQUIDITY_BUSY'),
    rpc: async () => { throw new Error('UNISWAP_NETWORK_UNAVAILABLE'); }, rpcs: { 'eip155:4663': robinhoodMainnetRpc(mode, process.env, ROBINHOOD_LIQUIDITY_RPC_METHODS) },
    provenance: mode === 'harness' ? 'MOCKED' : 'PUBLIC_MAINNET', executionEnabled: robinhoodOwnerExecutionEnabled(mode, process.env),
    catalog: { catalogFor: robinhoodCatalogFor(mode) } });
  return robinhoodService;
}
/** A call addresses Robinhood Chain when it names an `rhlp-` run, chain 4663, or a workflow whose position is on 4663. */
const robinhoodCall = (args: readonly unknown[]) => typeof args[0] === 'string' ? args[0].startsWith('rhlp-') || args[0] === 'eip155:4663'
  : Boolean(args[0] && typeof args[0] === 'object' && Array.isArray((args[0] as SemanticWorkflow).nodes) &&
    (args[0] as SemanticWorkflow).nodes.some(node => node.actionType === 'asset.liquidity.concentrated' && node.chainId === 'eip155:4663'));
async function run<T>(method: string, args: readonly unknown[], action: (service: UniswapLiquidityService) => Promise<T>, network?: 'robinhood'): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  const onRobinhood = network === 'robinhood' || robinhoodCall(args);
  // Cloud deployment: the remote Flofi API (BUILD-CLOUD-001) or the embedded PostgreSQL runtime (BUILD-CLOUD-PARITY-001).
  const cloud = await cloudFlow<T>(onRobinhood ? 'robinhood-liquidity' : 'uniswap-liquidity', method, args);
  if (cloud) return cloud;
  try { return { ok: true, value: await action(onRobinhood ? robinhood() : current()) }; }
  catch (cause) { const code = cause instanceof Error ? cause.message : ''; return { ok: false, code: /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : 'UNISWAP_LIQUIDITY_SERVICE_UNAVAILABLE' }; }
}
export async function uniswapLiquidityMode(): Promise<Mode> {
  return await cloudFlowMode('uniswap-liquidity') ?? localMode();
}
export async function uniswapLiquidityInfo() { return run('info', [], async s => ({ executionEnabled: s.executionEnabled })); }
/** BUILD-RH-002: whether this instance serves Robinhood Chain positions (live or the MOCKED loopback harness), and its owner-execution switch. */
export async function robinhoodLiquidityMode(): Promise<Mode> {
  const cloud = await cloudFlowMode('robinhood-liquidity');
  if (cloud) return cloud;
  const mode = robinhoodMainnetMode(process.env);
  return mode === 'harness' || (mode === 'live' && process.env.NODE_ENV === 'development') ? mode : 'off';
}
export async function robinhoodLiquidityInfo() { return run('info', [], async s => ({ executionEnabled: s.executionEnabled }), 'robinhood'); }
export async function uniswapLiquidityPrice(chain?: 'eip155:84532' | 'eip155:11155111') { return run('price', chain ? [chain] : [], s => s.price(chain)); }
/** BUILD-RH-002: the current price of one Robinhood Chain pool (its two catalog token addresses and fee tier). */
export async function robinhoodLiquidityPrice(pair: { tokenA: string; tokenB: string; fee: number }) {
  return run('price', ['eip155:4663', pair], s => s.price('eip155:4663', pair), 'robinhood');
}
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
