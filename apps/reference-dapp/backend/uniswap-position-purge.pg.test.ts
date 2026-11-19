// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: owner-requested deletion of Uniswap v3 position-management runs, end to end on REAL disposable PostgreSQL.
 * Records come from the production position runtime (the cloud `base-liquidity` storage, projector and leases); the chain is MOCKED and the only
 * "wallet" is the test calling `chain.wallet.send`. Before the certified 0031 every position run is refused (the fail-safe of today); the operator
 * command applies 0031 only on exact schema 30 and never the FinOps 0029/0030 itself; after it, only a never-authorized simulation is deleted —
 * through the authenticated owner-history route — and every authorized, invalidated, prepared, submitted or reconciled run stays.
 */
import { afterEach, expect, it } from 'vitest';
import { createLogger } from '@defi-workflow-engine/cloud-runtime';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { catalogPoolOn, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import { editorReducer, initialEditor } from '../src/domain/editor.ts';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../src/domain/asset-catalogs.ts';
import { createUniswapLiquidityChain, managedPositionWorkflow, UNI_MOCK_CODE_PINS, UNI_OWNER } from '../e2e/uniswap-liquidity-harness.ts';
import { baseAsset, baseCatalog } from '../src/server/base-mainnet.test-harness.ts';
import { createUniswapLiquidityService } from '../src/server/uniswap-liquidity-service.ts';
import { runAdminCommand } from '../src/admin/cli-commands.ts';
import { createBackend } from './app.ts';

const catalog = baseCatalog();
const USDC = baseAsset(catalog, 'USDC'), CBBTC = baseAsset(catalog, 'cbBTC');
const token = (asset: CanonicalAsset) => asset as { symbol: string; address: string; decimals: number };
const PROFILE = catalogPoolOn('eip155:8453', token(USDC), token(CBBTC), 500);
const TICK = PROFILE.token0.address === USDC.address ? -69_082 : 69_082;
const LOWER = Math.floor((TICK - 2_000) / 10) * 10, UPPER = Math.ceil((TICK + 2_000) / 10) * 10;
const OWNER = { namespace: 'eip155' as const, address: UNI_OWNER };
const SEND = ['eth_sendTransaction', 'eth_sendRawTransaction', 'sendTransaction'];
function positionWorkflow(): SemanticWorkflow {
  const result = editorReducer(initialEditor(), { type: 'ADD_CRYPTO_ACTION', source: 'CANVAS', baseRevision: 0, input: { selection: { action: 'pool', network: 'Base',
    from: 'USDC', to: 'cbBTC' }, amount: '100', secondAmount: '0.001', slippage: '100', fee: 500, rangeUnit: 'TICK', lower: String(LOWER), upper: String(UPPER) } },
  createBaseSepoliaReviewContext());
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
}

let t: TestDatabase | undefined;
afterEach(async () => { await t?.drop(); t = undefined; resetNetworkCatalogs(); });

it('deletes only a never-authorized position simulation after the certified 0031; every started or settled run is kept', { timeout: 180_000 }, async () => {
  registerNetworkCatalog(catalog);
  t = await createTestDatabase();
  const ahead = process.env.FLOFI_TEST_CERTIFIED_AHEAD === '1';
  const options = { db: t.db, env: {}, tenantId: 'default', holderId: 'position-purge-test', evidenceStore: null,
    logger: createLogger({ service: 'position-purge-test', sink: () => undefined }) };
  const backend = createBackend(options);
  const chain = createUniswapLiquidityChain({ profile: PROFILE, tick: TICK, usdc: 1_000_000_000n, weth: 1_000_000_000n });
  const methods: string[] = [];
  const rpc = (method: string, params: readonly unknown[]) => { methods.push(method); return chain.rpc(method, params); };
  // The production position runtime on the backend's real PostgreSQL storage for the `base-liquidity` flow (projection, leases, intents).
  const service = createUniswapLiquidityService({ storage: backend.storage('base-liquidity', 'default'), rpc: async () => { throw new Error('UNUSED'); },
    rpcs: { 'eip155:8453': rpc }, provenance: 'MOCKED', now: chain.clock, mockedCodePins: UNI_MOCK_CODE_PINS,
    catalog: { chain: 'eip155:8453', catalogFor: async () => catalog, codePins: chain.catalogPins } });
  const w = positionWorkflow();
  const seed = () => chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
  const remove = (id: string, owner = OWNER) => backend.callHistory('change', ['EXECUTION_RUN', id, 'DELETE'], owner);

  // 1. Never authorized (simulated, then refreshed): the only deletable kind.
  const feeBearing = seed(); chain.accrueFees(feeBearing, 1_234n, 5_678n);
  const collect = { operation: 'COLLECT' as const, tokenId: feeBearing, partBps: null, close: false };
  const unstarted = await service.positionSimulate(managedPositionWorkflow(w, collect), UNI_OWNER, collect);
  await service.positionRefresh(unstarted.id);
  // 2. Authorized, then invalidated by the owner: an earlier snapshot carries the authorization.
  const half = { operation: 'DECREASE' as const, tokenId: seed(), partBps: 5_000, close: false }, wHalf = managedPositionWorkflow(w, half);
  const invalidated = await service.positionSimulate(wHalf, UNI_OWNER, half);
  await service.positionReview(invalidated.id, invalidated.review.commitment, wHalf);
  await service.positionInvalidate(invalidated.id);
  // 3. Settled: the full lifecycle, submitted by the scripted wallet and reconciled.
  const close = { operation: 'EXIT' as const, tokenId: seed(), partBps: null, close: true }, wClose = managedPositionWorkflow(w, close);
  const settled = await service.positionSimulate(wClose, UNI_OWNER, close);
  await service.positionReview(settled.id, settled.review.commitment, wClose);
  const begun = await service.positionBegin(settled.id, UNI_OWNER, wClose);
  await service.positionHandoff(settled.id);
  await service.positionReport(settled.id, { kind: 'HASH', hash: chain.wallet.send(begun.transaction) });
  expect((await service.observeAny(settled.id)).verdict).toBe('RECONCILED');
  // 4. Prepared (after the settled run: an active attempt holds the owner's nonce): authorized, claimed and the nonce reserved, nothing sent.
  const exit = { operation: 'EXIT' as const, tokenId: seed(), partBps: null, close: false }, wExit = managedPositionWorkflow(w, exit);
  const prepared = await service.positionSimulate(wExit, UNI_OWNER, exit);
  await service.positionReview(prepared.id, prepared.review.commitment, wExit);
  await service.positionBegin(prepared.id, UNI_OWNER, wExit);
  // 5. An ordinary mint simulation of the same service keeps 0016's behaviour (deletable before and after 0031).
  const mint = await service.simulate(w, UNI_OWNER);

  const kept = [invalidated.id, prepared.id, settled.id];
  if (!ahead) {
    // Schema 28: no position run is deletable (an explicit, fail-safe refusal); the mint simulation is, as before.
    for (const id of [unstarted.id, ...kept]) expect(await remove(id), id).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
    // The operator command never applies the FinOps migrations on its own.
    await expect(runAdminCommand('position-purge-migrate', {}, t.db, 'default')).rejects.toThrow('POSITION_PURGE_REQUIRES_SCHEMA_30');
    expect(await runAdminCommand('finops-migrate', {}, t.db, 'default')).toEqual({ applied: [29] });
    await expect(runAdminCommand('position-purge-migrate', {}, t.db, 'default')).rejects.toThrow('POSITION_PURGE_REQUIRES_SCHEMA_30');
    expect(await runAdminCommand('finops-sync-migrate', {}, t.db, 'default')).toEqual({ applied: [30] });
    for (const id of [unstarted.id, ...kept]) expect(await remove(id), id).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
    expect(await runAdminCommand('position-purge-migrate', {}, t.db, 'default')).toEqual({ applied: [31] });
  }
  // Reruns (and the FinOps commands on schema 31) apply nothing.
  expect(await runAdminCommand('position-purge-migrate', {}, t.db, 'default')).toEqual({ applied: [] });
  expect(await runAdminCommand('finops-sync-migrate', {}, t.db, 'default')).toEqual({ applied: [] });
  expect(await runAdminCommand('finops-migrate', {}, t.db, 'default')).toEqual({ applied: [] });

  // Another owner can never delete (or learn about) this owner's run.
  expect(await remove(unstarted.id, { namespace: 'eip155', address: '0x' + '66'.repeat(20) })).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
  for (const id of kept) expect(await remove(id), id).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
  expect(await remove(unstarted.id)).toMatchObject({ ok: true, disposition: 'DELETED' });
  expect(await remove(mint.id)).toMatchObject({ ok: true, disposition: 'DELETED' });
  expect(await backend.callHistory('disposition', ['EXECUTION_RUN', unstarted.id], OWNER)).toEqual({ ok: true, disposition: 'DELETED' });
  // A new process can neither load nor recreate the deleted identity; the kept runs load unchanged.
  const otherProcess = createBackend({ ...options, db: t.open(), holderId: 'new-process' });
  await expect(otherProcess.service('base-liquidity', 'default', true).load(unstarted.id)).rejects.toThrow();
  await expect(service.loadAny(unstarted.id)).rejects.toThrow();
  expect((await service.loadAny(settled.id)).verdict).toBe('RECONCILED');
  expect((await service.loadAny(prepared.id)).attempts).toHaveLength(1);
  const rows = await t.db.query<{ run_id: string; status: string }>(`SELECT run_id, status FROM execution_runs WHERE run_id = ANY($1) ORDER BY run_id`, [kept]);
  expect(rows.rows.map(r => r.run_id)).toEqual([...kept].sort());
  // Nothing was ever sent by FloFi: only the scripted wallet sent the one settled transaction.
  expect(methods.some(m => SEND.includes(m))).toBe(false);
});
