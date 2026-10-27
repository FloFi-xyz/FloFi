// SPDX-License-Identifier: AGPL-3.0-only
/** REAL PostgreSQL + actual backend flow; network/financial data are explicitly MOCKED and no transaction is submitted. */
import { afterEach, expect, it } from 'vitest';
import { createLogger } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness';
import { baseCatalog } from '../src/server/base-mainnet.test-harness';
import { createRobinhoodMockChain, mockCatalogRuntime } from '../src/server/robinhood-mainnet.test-harness';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../src/domain/asset-catalogs';
import { composeStrategy } from '../src/engine/strategy-engine';
import { createBackend } from './app';
import { createDurablePublicTestnetService } from '../src/server/public-testnet-service';
import { validateSavedWorkflow, WORKFLOW_OWNER_HEADER } from '../src/domain/saved-workflow';
import { readFileSync } from 'node:fs';
import { parseArbitrumTokenList } from '@defi-workflow-engine/action-registry';

let t: TestDatabase | undefined;
afterEach(async () => { await t?.drop(); resetNetworkCatalogs(); });
const owner = { namespace: 'eip155' as const, address: '0x' + '11'.repeat(20) };
it('prepares an actual durable Swap, deletes its unused run through the authenticated backend route, and a new process cannot load/recreate it', async () => {
  t = await createTestDatabase();
  const catalog = parseArbitrumTokenList(readFileSync(new URL('../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8'), new Date().toISOString());
  const chain = createRobinhoodMockChain(catalog, { now: Date.now }); registerNetworkCatalog(catalog);
  const stable = catalog.assets.find(a => a.symbol === 'USDC')!, weth = catalog.assets.find(a => a.symbol === 'WETH')!;
  chain.addPool(stable.address!, weth.address!, { fee: 3000, liquidity: 10n ** 20n, rate: { [stable.address!]: 4n * 10n ** 26n, [weth.address!]: 2_500_000n } });
  chain.fund(stable.address!, owner.address, 10_000_000n); chain.fundNative(owner.address, 10n ** 18n);
  const methods: string[] = [];
  const options = { db: t.db, env: {}, tenantId: 'default', holderId: 'owner-history-test', evidenceStore: null,
    logger: createLogger({ service: 'owner-history-test', sink: () => undefined }), catalog: async () => catalog,
    rpc: { 'arbitrum-swap': async (method: string, params: readonly unknown[]) => { methods.push(method); return chain.rpc(method, params); } } };
  const backend = createBackend(options), spec = composeStrategy({ action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1' });
  if (!spec.ok) throw Error(spec.code);
  // The production financial engine and backend's real projection/lease storage; only synthetic contract code pins are substituted.
  const financial = createDurablePublicTestnetService({ rpc: chain.rpc, rpcs: { [catalog.chain]: chain.rpc }, idPrefix: 'ars',
    storage: backend.storage('arbitrum-swap', 'default'), catalog: mockCatalogRuntime(catalog) });
  const record = await financial.prepare(validateSavedWorkflow(spec.workflow), owner.address), runId = record.quote.executionId;
  expect(record.attempts).toEqual([]); expect(record.reviewedManifestHash).toBeNull();
  expect(record.quote.ownerReview?.account).toBe(owner.address);
  expect((await t.db.query('SELECT owner_account FROM execution_runs WHERE run_id=$1', [runId])).rows).toEqual([{ owner_account: owner.address }]);
  const path = '/v1/owner-history/change', route = backend.routes.find(r => r.name === 'owner-history')!;
  const request = { method: 'POST', path, query: new URLSearchParams(), headers: { [WORKFLOW_OWNER_HEADER]: 'eip155:' + owner.address },
    body: { args: ['EXECUTION_RUN', runId, 'DELETE'] }, requestId: 'owner-delete-test' };
  expect((await route.handler(request, route.pattern.exec(path)!)).body).toMatchObject({ ok: true, disposition: 'DELETED' });
  const remaining = await t.db.query(`SELECT (SELECT count(*)::int FROM execution_runs) AS runs,
    (SELECT count(*)::int FROM execution_logs WHERE kind='RUN') AS logs,(SELECT count(*)::int FROM execution_log_segments s JOIN execution_logs l USING(tenant_id,namespace,name) WHERE l.kind='RUN') AS segments`);
  expect(remaining.rows).toEqual([{ runs: 0, logs: 0, segments: 0 }]);
  const otherProcess = createBackend({ ...options, db: t.open(), holderId: 'new-process' });
  expect(await otherProcess.callHistory('disposition', ['EXECUTION_RUN', runId], owner)).toEqual({ ok: true, disposition: 'DELETED' });
  await expect(otherProcess.service('arbitrum-swap', 'default', true).load(runId)).rejects.toThrow();
  expect(methods.some(m => ['eth_sendTransaction','eth_sendRawTransaction','sendTransaction'].includes(m))).toBe(false);
  expect(chain.state.transactions.size).toBe(0);
});

it('never assigns an owner to a historic unowned Base simulation to make it deletable', async () => {
  t = await createTestDatabase();
  const catalog = baseCatalog(), chain = createRobinhoodMockChain(catalog, { network: 'base', now: Date.now }); registerNetworkCatalog(catalog);
  const stable = catalog.assets.find(a => a.symbol === 'USDC')!, weth = catalog.assets.find(a => a.symbol === 'WETH')!;
  chain.addPool(stable.address!, weth.address!, { fee: 3000, liquidity: 10n ** 20n, rate: { [stable.address!]: 4n * 10n ** 26n, [weth.address!]: 2_500_000n } });
  const backend = createBackend({ db: t.db, env: {}, tenantId: 'default', holderId: 'unowned-test', evidenceStore: null,
    logger: createLogger({ service: 'owner-history-test', sink: () => undefined }) });
  const spec = composeStrategy({ action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1' });
  if (!spec.ok) throw Error(spec.code);
  const financial = createDurablePublicTestnetService({ rpc: chain.rpc, rpcs: { [catalog.chain]: chain.rpc }, idPrefix: 'bas',
    storage: backend.storage('base-swap', 'default'), catalog: mockCatalogRuntime(catalog) });
  const record = await financial.prepare(validateSavedWorkflow(spec.workflow), owner.address);
  expect((await t.db.query('SELECT owner_account FROM execution_runs')).rows).toEqual([{ owner_account: null }]);
  expect(await backend.callHistory('change', ['EXECUTION_RUN',record.quote.executionId,'DELETE'], owner)).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
  expect((await t.db.query('SELECT count(*)::int AS n FROM execution_runs')).rows).toEqual([{ n: 1 }]);
});
