// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 browser fixtures for managing Uniswap v3 positions on the MOCKED Base mainnet loopback harness
 * (e2e/base-mainnet-serve.ts `/__harness/uniswap`, 127.0.0.1:8562). Positions are seeded as if opened in another interface; the browser discovers
 * them on the Dashboard and prepares, simulates and recovers their runs through the real server actions (the in-process MOCKED runtime).
 *
 * The product never authorizes or executes a MOCKED result (release-financial-provenance.spec.ts), so the owner's Review authorization and the one
 * wallet request are made here, through a runtime built exactly as the app's MOCKED harness action builds it (same journal, same loopback chain,
 * same synthetic pins, same harness clock, the Base liquidity read allowlist) — the continuation suite's pattern. The only transaction path is the
 * harness's scripted owner wallet (`send`); nothing reaches a public network, nothing is signed with a real key, and none of this is mainnet evidence.
 */
import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { BASE_LIQUIDITY_RPC_METHODS, BASE_MAINNET_HARNESS, createBaseCatalogLoader } from '../src/server/base-mainnet';
import { chainBoundRpc, createBaseSepoliaReadRpc } from '../src/server/public-testnet-rpc';
import { createUniswapLiquidityService, type UniswapLiquidityService, type UniswapWalletDiagnostic } from '../src/server/uniswap-liquidity-service';
import { UNI_MOCK_CATALOG_PINS, UNI_MOCK_CODE_PINS } from '../src/server/uniswap-liquidity-mock';
import type { SeededPosition } from './base-mainnet-serve';

const HARNESS = 'http://127.0.0.1:8562';
export const BASE_CHAIN_HEX = '0x2105';
/** The position run pointer the browser keeps (src/state/uniswap-position-store.tsx). */
export const POSITION_RUN_KEY = 'flofi:uniswap-position:run';

/** The run journal of the app's in-process MOCKED Base liquidity runtime (`$GRYLOO_BASE_JOURNAL/liquidity`), refused unless it is this run's own. */
function journal(): string {
  const root = process.env.GRYLOO_BASE_JOURNAL;
  if (process.env.FLOFI_LIQUIDITY_POSITIONS_E2E !== 'MOCKED_LOOPBACK_ONLY' || process.env.GRYLOO_BASE_MAINNET_E2E !== 'MOCKED_LOOPBACK_ONLY'
    || !root?.startsWith(join(tmpdir(), 'gryloo-base-001-'))) throw new Error('MOCK_JOURNAL_DENIED');
  return join(root, 'liquidity');
}
export async function positionsControl<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${HARNESS}/__harness/uniswap`, { method: 'POST', body: JSON.stringify(body) });
  const value = await response.json() as { result?: T; error?: string; reason?: string };
  if (!response.ok || value.error) throw new Error(`MOCK_HARNESS_ERROR ${value.reason ?? value.error ?? response.status}`);
  return value.result as T;
}
export type SeededPositions = { readonly tokenIds: string[]; readonly pool: string; readonly positionManager: string; readonly token0: string; readonly token1: string };
/** A fresh journal and a fresh MOCKED Base chain whose positions belong to `owner` (opened outside FloFi). */
export async function resetBasePositions(owner: string, positions: readonly SeededPosition[]): Promise<SeededPositions> {
  const dir = journal();
  await rm(dir, { recursive: true, force: true });
  await rm(`${dir}.clock`, { force: true });
  return positionsControl<SeededPositions>({ action: 'reset', owner: owner.toLowerCase(), positions });
}
/** `seconds` pass on the MOCKED chain (new blocks) and on the app server's harness clock together; the browser's clock is not moved. */
export async function advanceBasePositions(seconds: number): Promise<void> {
  const dir = journal();
  await positionsControl({ action: 'advance', seconds });
  const prior = Number(await readFile(`${dir}.clock`, 'utf8').catch(() => '0')) || 0;
  await writeFile(`${dir}.clock`, String(prior + seconds * 1000));
}
export const harnessSends = () => positionsControl<number>({ action: 'sends' });
export type HarnessPosition = { owner: string | null; liquidity: string; owed0: string; owed1: string; pending0: string; pending1: string } | null;
export const harnessPosition = (tokenId: string) => positionsControl<HarnessPosition>({ action: 'position', tokenId });
export const harnessBalances = () => positionsControl<{ token0: string; token1: string }>({ action: 'balances' });

/** The runtime the app's server actions run in MOCKED harness mode (src/app/uniswap-liquidity-action.ts `catalogService`). */
export function ownerRuntime(): UniswapLiquidityService {
  const dir = journal();
  // The same bounded offset the app's harness clock accepts (0–24 h).
  const offset = () => { try { const value = Number(readFileSync(`${dir}.clock`, 'utf8')); return Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000 ? value : 0; } catch { return 0; } };
  const rpc = chainBoundRpc(createBaseSepoliaReadRpc(BASE_MAINNET_HARNESS.rpc, BASE_LIQUIDITY_RPC_METHODS), 8453);
  return createUniswapLiquidityService({ storage: createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY'),
    rpc: async () => { throw new Error('UNISWAP_NETWORK_UNAVAILABLE'); }, rpcs: { 'eip155:8453': rpc }, provenance: 'MOCKED', executionEnabled: true,
    catalog: { chain: 'eip155:8453', catalogFor: createBaseCatalogLoader({ mode: 'harness' }), codePins: UNI_MOCK_CATALOG_PINS },
    mockedCodePins: UNI_MOCK_CODE_PINS, now: () => new Date(Date.now() + offset()) });
}
/**
 * The owner's explicit authorization of the run's current Review, then its ONE wallet request (prepare → durable hand-off → the scripted owner
 * wallet), observed until reconciled. `decline`: the owner refuses that request in the wallet instead (nothing is sent; the run records it).
 */
export async function ownerManages(service: UniswapLiquidityService, id: string, workflow: SemanticWorkflow, owner: string, options: { decline?: boolean } = {}) {
  const run = await service.positionStatus(id);
  await service.positionReview(id, run.review.commitment, workflow);
  const begun = await service.positionBegin(id, owner.toLowerCase(), workflow);
  await service.positionHandoff(id);
  if (options.decline) {
    const diagnostic: UniswapWalletDiagnostic = { invoked: true, code: 'UNISWAP_REJECTED', rejectionCode: 4001,
      calls: [{ method: 'eth_sendTransaction', submission: true, error: { code: 4001, message: 'Owner rejected test request' } }] };
    return { begun, record: await service.positionWalletFailure(id, diagnostic) };
  }
  await service.positionReport(id, { kind: 'HASH', hash: await positionsControl<string>({ action: 'send', tx: begun.transaction }) });
  return { begun, record: await service.positionObserve(id) };
}
