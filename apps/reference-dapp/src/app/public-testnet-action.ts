// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { isAbsolute, join } from 'node:path';
import { createPublicTestnetService, publicRecordingEnabled,
  type PublicTestnetService, type PublicRun, type PublicBegin } from '../server/public-testnet-service';
import { baseSepoliaSwapRpc, ethereumSepoliaSwapRpc } from '../server/public-testnet-rpc';
import { cloudFlow, cloudFlowMode } from '../server/flow-runtime';
import { robinhoodCatalogFor, robinhoodMainnetMode, robinhoodMainnetRpc, robinhoodSwapRuntime } from '../server/robinhood-mainnet';
import { swapProfile } from '../domain/public-testnet-swap';

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
 * BUILD-RH-002: Robinhood Chain mainnet swaps (`rhs-` runs) on the same shared swap service, with the Robinhood runtime.
 * Live public reads need `GRYLOO_ROBINHOOD_MAINNET=live` in local development (hosted deployments use the cloud flow);
 * automated tests use only the loopback harness. The journal is `$GRYLOO_ROBINHOOD_JOURNAL/swap`.
 */
let robinhood: PublicTestnetService | null = null;
function robinhoodService(): PublicTestnetService {
  const mode = robinhoodMainnetMode(process.env);
  if (mode === 'off' || (mode === 'live' && process.env.NODE_ENV !== 'development')) throw new Error('ROBINHOOD_MAINNET_NOT_ENABLED');
  const dir = process.env.GRYLOO_ROBINHOOD_JOURNAL;
  if (!dir || !isAbsolute(dir)) throw new Error('ROBINHOOD_STORAGE_NOT_CONFIGURED');
  robinhood ??= createPublicTestnetService({ rpc: async () => { throw new Error('PUBLIC_NETWORK_UNAVAILABLE'); },
    rpcs: { 'eip155:4663': robinhoodMainnetRpc(mode, process.env) }, journalDir: join(dir, 'swap'), idPrefix: 'rhs',
    catalog: robinhoodSwapRuntime(mode, process.env, robinhoodCatalogFor(mode)) });
  return robinhood;
}
const isRobinhoodRun = (id: unknown) => typeof id === 'string' && id.startsWith('rhs-');
const isRobinhoodWorkflow = (workflow: SemanticWorkflow) =>
  swapProfile(workflow.nodes.find(node => node.actionType === 'asset.swap.exact-input')?.chainId)?.kind === 'CATALOG';
function code(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : 'PUBLIC_INTERNAL_ERROR';
}
async function run<T>(method: string, args: readonly unknown[], action: (service: PublicTestnetService) => T | Promise<T>, robinhoodRun = isRobinhoodRun(args[0])): Promise<PublicResult<T>> {
  // Cloud deployment: the remote Flofi API (BUILD-CLOUD-001) or the embedded PostgreSQL runtime (BUILD-CLOUD-PARITY-001).
  const cloud = await cloudFlow<T>(robinhoodRun ? 'robinhood-swap' : 'base-sepolia-swap', method, args);
  if (cloud) return cloud;
  try { return { ok: true, value: await action(robinhoodRun ? robinhoodService() : current()) }; }
  catch (error) { return { ok: false, code: code(error) }; }
}
const id = (value: unknown) => typeof value === 'string' && /^(pub|rhs)-[0-9a-f]{24}$/.test(value) ? value : (() => { throw new Error('INPUT_INVALID'); })();
export async function publicPrepare(workflow: SemanticWorkflow): Promise<PublicResult<PublicRun>> {
  return run('prepare', [workflow], service => service.prepare(workflow), isRobinhoodWorkflow(workflow));
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
/** BUILD-RH-002: whether this instance serves Robinhood Chain mainnet swaps (live or the MOCKED loopback harness). */
export async function robinhoodSwapAvailability(): Promise<boolean> {
  const cloud = await cloudFlowMode('robinhood-swap');
  if (cloud) return cloud !== 'off';
  const mode = robinhoodMainnetMode(process.env), dir = process.env.GRYLOO_ROBINHOOD_JOURNAL;
  return (mode === 'harness' || (mode === 'live' && process.env.NODE_ENV === 'development')) && Boolean(dir && isAbsolute(dir));
}
