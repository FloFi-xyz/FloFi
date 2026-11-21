// SPDX-License-Identifier: AGPL-3.0-only
/**
 * REAL PostgreSQL + actual backend flow; network/financial data are explicitly MOCKED and no transaction is submitted.
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): the second part drives the REAL workflow-run store (creation, mode, groups,
 * preparation, the wallet's rejection, cancellation, expiry, blocks) and deletes single-card attempts through owner history under the certified
 * 0033; the application's chain proof of a rejection (`decline-proof.ts`) is represented by the verified decline it hands the store.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { CERTIFIED_FORWARD_MIGRATIONS, createLogger, createOwnerHistory, createPostgresWorkQueue, ensureTenant, loadMigrations, migrate, type Database,
  type Migration } from '@defi-workflow-engine/cloud-runtime';
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
import { createPgWorkflowRunStore, type GroupRecord, type StepOutcome, type VerifiedDecline, type WorkflowRunStore } from '../src/workflow-runs/pg-store';
import type { ExecutionGroup } from '../src/workflow-runs/execution-groups';
import { stopRunFromCurrent } from '../src/workflow-runs/user-funded-pass';
import { sweepWorkflowRuns } from '../src/workflow-runs/worker';
import { createPgHandoffStore } from '../src/platform/handoff-store';
import { typedId } from '../src/platform/ids';
import { decidePrivacyRequest, openPrivacyRequest, privacyAccess, privacyErase, walletSubject } from '../src/admin/privacy-ops';

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
  const rollback = createBackend({ ...options, env: { FLOFI_OWNER_HISTORY: 'read-only' } });
  expect(await rollback.callHistory('change', ['EXECUTION_RUN',runId,'DELETE'], owner)).toEqual({ ok: false, code: 'HISTORY_READ_ONLY' });
  expect(await rollback.callHistory('change', ['EXECUTION_RUN',runId,'ARCHIVE'], owner)).toEqual({ ok: false, code: 'HISTORY_READ_ONLY' });
  expect(await rollback.callHistory('disposition', ['EXECUTION_RUN',runId], owner)).toEqual({ ok: true, disposition: 'VISIBLE' });
  expect((await t.db.query('SELECT count(*)::int AS n FROM execution_runs WHERE run_id=$1', [runId])).rows).toEqual([{ n: 1 }]);
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

it('refuses saved-workflow replay and recreation after deletion through the authenticated backend', async () => {
  t = await createTestDatabase();
  const options = { db: t.db, env: {}, tenantId: 'default', holderId: 'history-save-test', evidenceStore: null,
    logger: createLogger({ service: 'history-save-test', sink: () => undefined }) };
  const backend = createBackend(options);
  const spec = composeStrategy({ action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1' });
  if (!spec.ok) throw Error(spec.code);
  const path = '/v1/workflows/save', route = backend.routes.find(r => r.name === 'workflows')!;
  const request = { method: 'POST', path, query: new URLSearchParams(), headers: { [WORKFLOW_OWNER_HEADER]: 'eip155:' + owner.address,
    'idempotency-key': 'workflow-history-replay-test' }, body: { args: [{ workflow: spec.workflow, name: 'Disposable draft', expectedVersion: 0 }] },
    requestId: 'workflow-history-replay-test' };
  const match = route.pattern.exec(path)!;
  const saved = await route.handler(request, match);
  expect(saved.body).toMatchObject({ ok: true, value: { workflowId: spec.workflow.workflowId, version: 1 } });
  expect(await route.handler(request, match)).toEqual(saved);
  expect(await backend.callHistory('change', ['SAVED_WORKFLOW', spec.workflow.workflowId, 'DELETE'], owner)).toMatchObject({ ok: true, disposition: 'DELETED' });
  expect((await route.handler(request, match)).body).toEqual({ ok: false, code: 'WORKFLOW_NOT_FOUND' });
  expect((await route.handler({ ...request, headers: { ...request.headers, 'idempotency-key': 'workflow-history-fresh-test' } }, match)).body)
    .toEqual({ ok: false, code: 'WORKFLOW_NOT_FOUND' });
  expect((await t.db.query('SELECT workflow_id FROM saved_workflows')).rows).toEqual([]);
});

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: owner deletion of a single-card attempt that never reached a chain (0033)', { timeout: 180_000 }, () => {
  const OWNER = owner.address, STRANGER = '0x' + '22'.repeat(20), ACCOUNT = 'acct_' + 'a'.repeat(32), HASH = '0x' + 'ab'.repeat(32);
  const CHAIN = 'eip155:42161', T0 = new Date(Date.now() - 3_600_000);
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const GROUP: ExecutionGroup = { index: 0, namespace: 'eip155', chain: CHAIN, steps: [], stepFrom: 0, stepTo: 0, strategy: 'EVM_WALLET_BATCH', signing: 'UPFRONT',
    awaitsDelivery: null, interactions: 1, setup: [], downgrades: [], feePayer: 'OWNER_WALLET' };
  const REFUSED = { ok: false, code: 'RUN_DELETE_REFUSED' };
  const refused = (reason: 'EXECUTION_ACTIVITY' | 'AUTHORIZATION' | 'DEPENDENCY') => ({ ...REFUSED, reason });
  const DELETED = { ok: true, disposition: 'DELETED' };
  const databases: TestDatabase[] = [];
  afterEach(async () => { await Promise.all(databases.splice(0).map(d => d.drop())); });

  /** A database exactly as the operator release leaves it: the shipped migrations, then the certified 0029–`upTo` fixtures. */
  async function database(upTo: 32 | 33): Promise<TestDatabase> {
    const d = await createTestDatabase({ migrated: false }); databases.push(d);
    const certificate = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
    const ahead: Migration[] = await Promise.all(certificate.migrations.filter(m => m.version <= upTo).map(async m => {
      const sql = await readFile(new URL(`../../../packages/cloud-runtime/test/fixtures/${String(m.version).padStart(4, '0')}_${m.name}.sql`, import.meta.url), 'utf8');
      expect(createHash('sha256').update(sql).digest('hex')).toBe(m.sha256);
      return { ...m, sql };
    }));
    await migrate(d.db, [...await loadMigrations(), ...ahead]);
    await ensureTenant(d.db, 'default');
    return d;
  }
  /** An approval handoff the owner claimed (the Editor's, unless another requester is named), and its run of `steps` steps from the REAL store. */
  async function attempt(db: Database, store: WorkflowRunStore, options: { requester?: 'EDITOR_SESSION' | 'CHANNEL_CONVERSATION'; steps?: number;
    expiresAt?: Date } = {}) {
    const handoffId = typedId('apr'), runId = typedId('wfr'), digest = randomBytes(32), requester = options.requester ?? 'EDITOR_SESSION';
    await db.query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind, requester_id, account_id, client_id, client_name, secret_digest, strategy,
        workflow_hash, engine_version, network_environment, funds_class, plan, status, claimed_namespace, claimed_address, claimed_at, claim_expires_at, expires_at)
      VALUES ($1, $2, $3, $4, NULL, 'flofi-editor', 'Editor', $5, '{}', $6, 'flofi-engine-2', 'MAINNET', 'REAL_FUNDS', '{"kind":"SEQUENTIAL"}', 'CLAIMED',
        'eip155', $7, $8, $8::timestamptz + interval '15 minutes', $8::timestamptz + interval '15 minutes')`,
    [store.tenantId, handoffId, requester, ACCOUNT, digest, HASH, OWNER, T0]);
    const run = await store.create({ runId, handoffId, requester: { kind: requester, ref: ACCOUNT }, owner, wallets: { eip155: OWNER },
      strategy: { action: 'swap', network: 'arbitrum-one', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.0006' } as never, workflowHash: HASH,
      engineVersion: 'flofi-engine-2', stepCount: options.steps ?? 1, expiresAt: options.expiresAt ?? at(3_600_000) }, T0);
    return { runId: run.runId, handoffId, digest };
  }
  /** The artifact an EVM wallet batch group is prepared with (the shape `prepareGroup` stores), its request id the group's own EIP-5792 id. */
  const prepared = (runId: string, preparedAt: Date) => ({ kind: 'EVM_WALLET_BATCH', chainId: 42161, owner: OWNER, group: { chainId: 42161, owner: OWNER },
    request: { version: '2.0.0', id: '0x' + createHash('sha256').update(`flofi:user-funded-batch:${runId}:0`).digest('hex'), chainId: '0xa4b1', from: OWNER,
      atomicRequired: true, calls: [{ to: '0x' + '82'.repeat(20), value: '0x0', data: '0x095ea7b3' }, { to: '0x' + '68'.repeat(20), value: '0x0', data: '0x04e45aaf' }] },
    fromBlock: '1000', ownerNonce: '7', simulation: { ok: true }, fee: { payer: OWNER, unit: 'wei', estimatedGas: '210000', maxFeePerGas: '20000000',
      maxCost: '4200000000000', l1FeeUpperBound: '0', estimated: true, sponsorship: null }, preparedAt: preparedAt.toISOString(), handoutHash: 'a'.repeat(43) });
  const PREPARED_AT = at(60_000), VALID_UNTIL = at(660_000), SETTLED = at(900_000);
  /** User-funded mode chosen, then its one wallet batch prepared and handed out (the real store's writes). */
  async function preparedAttempt(db: Database, store: WorkflowRunStore) {
    const a = await attempt(db, store);
    await store.startUserFunded(a.runId, [GROUP], T0);
    const artifact = prepared(a.runId, PREPARED_AT);
    expect(await store.groupTransition(a.runId, 0, ['PLANNED'], 'PREPARED', { prepared: artifact, validUntil: VALID_UNTIL, code: null })).not.toBeNull();
    return { ...a, artifact, requestId: artifact.request.id, preparedAt: artifact.preparedAt };
  }
  const verified = (a: { requestId: string; preparedAt: string }, overrides: Partial<VerifiedDecline> = {}): ReadonlyMap<number, VerifiedDecline> =>
    new Map([[0, { requestId: a.requestId, preparedAt: a.preparedAt, ownerNonce: '7', fromBlock: '1000', toBlock: '1012', ...overrides }]]);
  const version = async (store: WorkflowRunStore, runId: string) => (await store.byId(runId))!.version;
  /** The owner rejected the batch, and the server proved it was never sent: the store ends the run with the proof (shape WALLET_REJECTED_VERIFIED). */
  async function rejectedAttempt(db: Database, store: WorkflowRunStore, declines = 1) {
    const a = await preparedAttempt(db, store);
    for (let i = 0; i < declines; i++) await store.recordDecline(a.runId, 0, a.requestId, a.preparedAt);
    await store.cancel(a.runId, await version(store, a.runId), 'OWNER_CANCELLED', SETTLED, { verifiedDeclines: verified(a) });
    return a;
  }
  /** The block a user-funded pass applies to a group (user-funded-pass.ts `block`): group, step, then the run stops from its current version. */
  async function block(store: WorkflowRunStore, runId: string, g: GroupRecord, code: string, to: 'FAILED' | 'HALTED') {
    expect(await store.groupTransition(runId, 0, [g.state], 'BLOCKED', { code }, 'GROUP_STATE', g.version)).not.toBeNull();
    await store.stepTransition(runId, 0, ['DELEGATED'], 'BLOCKED', { code });
    expect(await stopRunFromCurrent({ store }, runId, to, code)).not.toBeNull();
  }
  const counts = async (db: Database, runId: string, handoffId: string) => (await db.query(`SELECT
      (SELECT count(*)::int FROM workflow_runs WHERE run_id = $1) AS runs, (SELECT count(*)::int FROM workflow_run_steps WHERE run_id = $1) AS steps,
      (SELECT count(*)::int FROM workflow_run_groups WHERE run_id = $1) AS groups, (SELECT count(*)::int FROM workflow_run_events WHERE run_id = $1) AS events,
      (SELECT count(*)::int FROM mcp_handoffs WHERE handoff_id = $2) AS handoffs, (SELECT count(*)::int FROM work_items WHERE dedupe_key = $1) AS work,
      (SELECT count(*)::int FROM workflow_run_purge_audit WHERE run_id = $1) AS tombstones`, [runId, handoffId])).rows[0];
  const GONE = { runs: 0, steps: 0, groups: 0, events: 0, handoffs: 0, work: 0, tombstones: 1 };
  const tombstone = async (db: Database, runId: string) => (await db.query(`SELECT shape, final_state, event_count, owner_account, owner_namespace
    FROM workflow_run_purge_audit WHERE run_id = $1`, [runId])).rows;
  /** Polls until another backend waits on a row lock (the racing statement really is blocked behind the held transaction). */
  async function blocked(db: Database, waiting = 1): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if ((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0]!.n >= waiting) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('NOT_BLOCKED');
  }
  /** One held transaction on its own connection, with the REAL store (and its locks) running inside it until `release`. */
  function held(d: TestDatabase, work: (store: WorkflowRunStore, tx: Database) => Promise<unknown>) {
    const connection = d.open(1);
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { ready = resolve; });
    const done = connection.transaction(async tx => {
      const scoped = { query: tx.query.bind(tx), transaction: (inner: (q: typeof tx) => Promise<unknown>) => inner(tx) } as unknown as Database;
      await work(createPgWorkflowRunStore(scoped, 'default'), scoped);
      ready();
      await gate;
    }).finally(() => connection.close());
    return { started, release, done };
  }

  it('deletes both shapes from the real store, completely and idempotently; the approval link and the run can never come back', async () => {
    const d = await database(33), db = d.db, store = createPgWorkflowRunStore(db, 'default'), history = createOwnerHistory(db, 'default');
    const backend = createBackend({ db, env: {}, tenantId: 'default', holderId: 'workflow-run-history', evidenceStore: null,
      logger: createLogger({ service: 'workflow-run-history', sink: () => undefined }) });
    // NO_WALLET_REQUEST (1): ended by the owner before choosing a mode.
    const pending = await attempt(db, store);
    await store.cancel(pending.runId, await version(store, pending.runId), 'OWNER_CANCELLED', at(30_000));
    // NO_WALLET_REQUEST (2): never started; the sweep expired it.
    const expiring = await attempt(db, store, { expiresAt: at(120_000) });
    expect((await sweepWorkflowRuns(store, db, 'default', at(180_000))).expired).toBe(1);
    expect((await store.byId(expiring.runId))!.state).toBe('EXPIRED');
    // NO_WALLET_REQUEST (3): user-funded mode chosen (its advance work item queued), ended before anything was prepared.
    const planned = await attempt(db, store);
    await store.startUserFunded(planned.runId, [GROUP], T0);
    await store.cancel(planned.runId, await version(store, planned.runId), 'OWNER_CANCELLED', at(30_000));
    expect((await db.query(`SELECT state FROM work_items WHERE kind = 'workflow-run.advance' AND dedupe_key = $1`, [planned.runId])).rows).toEqual([{ state: 'READY' }]);
    // NO_WALLET_REQUEST (4): user-funded, blocked at the run's expiry before anything was prepared, so the run FAILED.
    const failed = await attempt(db, store);
    await store.startUserFunded(failed.runId, [GROUP], T0);
    await block(store, failed.runId, (await store.groups(failed.runId))[0]!, 'WORKFLOW_RUN_EXPIRED', 'FAILED');
    // NO_WALLET_REQUEST (5): its preparation refused for good when due (nothing prepared), so the run HALTED; then ended by the owner.
    const halted = await attempt(db, store);
    await store.startUserFunded(halted.runId, [GROUP], T0);
    await block(store, halted.runId, (await store.groups(halted.runId))[0]!, 'INSUFFICIENT_BALANCE', 'HALTED');
    await store.cancel(halted.runId, await version(store, halted.runId), 'OWNER_CANCELLED', at(30_000));
    // WALLET_REJECTED_VERIFIED: prepared once, rejected twice by the wallet, proven never sent, ended.
    const rejected = await rejectedAttempt(db, store, 2);
    expect((await store.groups(rejected.runId))[0]).toMatchObject({ state: 'SKIPPED', code: 'WALLET_REQUEST_REJECTED' });

    for (const a of [pending, expiring, planned, failed, halted]) {
      expect(await history.change(OWNER, 'WORKFLOW_RUN', a.runId, 'DELETE'), a.runId).toEqual(DELETED);
      expect(await counts(db, a.runId, a.handoffId), a.runId).toEqual(GONE);
    }
    expect(await tombstone(db, pending.runId)).toEqual([{ shape: 'NO_WALLET_REQUEST', final_state: 'CANCELLED', event_count: 3, owner_account: OWNER, owner_namespace: 'eip155' }]);
    expect(await tombstone(db, expiring.runId)).toMatchObject([{ shape: 'NO_WALLET_REQUEST', final_state: 'EXPIRED', event_count: 2 }]);
    expect(await tombstone(db, planned.runId)).toMatchObject([{ shape: 'NO_WALLET_REQUEST', final_state: 'CANCELLED', event_count: 5 }]);
    expect(await tombstone(db, failed.runId)).toMatchObject([{ shape: 'NO_WALLET_REQUEST', final_state: 'FAILED', event_count: 5 }]);
    expect(await tombstone(db, halted.runId)).toMatchObject([{ shape: 'NO_WALLET_REQUEST', final_state: 'CANCELLED', event_count: 8 }]);
    // The rejected attempt through the authenticated backend route, as History calls it.
    const path = '/v1/owner-history/change', route = backend.routes.find(r => r.name === 'owner-history')!;
    expect((await route.handler({ method: 'POST', path, query: new URLSearchParams(), headers: { [WORKFLOW_OWNER_HEADER]: 'eip155:' + OWNER },
      body: { args: ['WORKFLOW_RUN', rejected.runId, 'DELETE'] }, requestId: 'workflow-run-delete' }, route.pattern.exec(path)!)).body).toEqual(DELETED);
    expect(await counts(db, rejected.runId, rejected.handoffId)).toEqual(GONE);
    expect(await tombstone(db, rejected.runId)).toMatchObject([{ shape: 'WALLET_REJECTED_VERIFIED', final_state: 'CANCELLED', event_count: 9 }]);
    expect((await db.query('SELECT count(*)::int AS n FROM workflow_run_purge_permits')).rows).toEqual([{ n: 0 }]);

    // Idempotent: a repeat answers DELETED and records no second event; History shows it DELETED; it can no longer be archived.
    expect(await history.change(OWNER, 'WORKFLOW_RUN', pending.runId, 'DELETE')).toEqual(DELETED);
    expect(await backend.callHistory('change', ['WORKFLOW_RUN', rejected.runId, 'DELETE'], owner)).toEqual(DELETED);
    expect((await db.query(`SELECT record_id, count(*)::int AS n FROM owner_history_events WHERE kind = 'WORKFLOW_RUN' AND action = 'DELETED' GROUP BY record_id`)).rows)
      .toHaveLength(6);
    expect((await db.query(`SELECT max(n)::int AS n FROM (SELECT count(*) AS n FROM owner_history_events WHERE kind = 'WORKFLOW_RUN' GROUP BY record_id) x`)).rows)
      .toEqual([{ n: 1 }]);
    expect(await history.disposition(OWNER, 'WORKFLOW_RUN', rejected.runId)).toEqual(DELETED);
    expect(await backend.callHistory('disposition', ['WORKFLOW_RUN', pending.runId], owner)).toEqual(DELETED);
    expect(await history.change(OWNER, 'WORKFLOW_RUN', pending.runId, 'ARCHIVE')).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    expect(await history.change(STRANGER, 'WORKFLOW_RUN', pending.runId, 'DELETE')).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    expect(await history.disposition(STRANGER, 'WORKFLOW_RUN', pending.runId)).toEqual({ ok: true, disposition: 'VISIBLE' });
    expect(await store.forOwner(owner)).toEqual([]);
    // The approval link is unclaimable, and no run can be created for the deleted handoff again (its foreign key).
    expect(await createPgHandoffStore(db, 'default').claim(rejected.digest, owner, new Date(), 900, () => ({ ok: true, share: false }) as never, ['EDITOR_SESSION']))
      .toMatchObject({ ok: false, code: 'HANDOFF_NOT_FOUND' });
    await expect(store.create({ runId: typedId('wfr'), handoffId: rejected.handoffId, requester: { kind: 'EDITOR_SESSION', ref: ACCOUNT }, owner,
      wallets: { eip155: OWNER }, strategy: {} as never, workflowHash: HASH, engineVersion: 'flofi-engine-2', stepCount: 1, expiresAt: at(3_600_000) }, T0))
      .rejects.toThrow(/foreign key/);
  });

  it('keeps every attempt that may have reached a chain, was authorized, or is not exactly one of the two shapes', async () => {
    const d = await database(33), db = d.db, store = createPgWorkflowRunStore(db, 'default'), history = createOwnerHistory(db, 'default');
    const remove = (runId: string) => history.change(OWNER, 'WORKFLOW_RUN', runId, 'DELETE');
    const kept: Record<string, { runId: string; expected: unknown }> = {};
    const keep = (name: string, runId: string, expected: unknown) => { kept[name] = { runId, expected }; };

    // A prepared batch ended without any rejection: its outcome is unknown (WALLET_BATCH_OUTCOME_UNKNOWN).
    const unknown = await preparedAttempt(db, store);
    await store.cancel(unknown.runId, await version(store, unknown.runId), 'OWNER_CANCELLED', SETTLED);
    expect((await store.groups(unknown.runId))[0]!.code).toBe('WALLET_BATCH_OUTCOME_UNKNOWN');
    keep('outcome unknown', unknown.runId, refused('EXECUTION_ACTIVITY'));
    // A rejection reported but never proven (the store ends it unknown); one "proven" for another request (the store refuses to apply it).
    const unproven = await preparedAttempt(db, store);
    await store.recordDecline(unproven.runId, 0, unproven.requestId, unproven.preparedAt);
    await store.cancel(unproven.runId, await version(store, unproven.runId), 'OWNER_CANCELLED', SETTLED);
    keep('decline without proof', unproven.runId, refused('EXECUTION_ACTIVITY'));
    const otherRequest = await preparedAttempt(db, store);
    await store.recordDecline(otherRequest.runId, 0, otherRequest.requestId, otherRequest.preparedAt);
    await store.cancel(otherRequest.runId, await version(store, otherRequest.runId), 'OWNER_CANCELLED', SETTLED,
      { verifiedDeclines: verified(otherRequest, { requestId: '0x' + '99'.repeat(32) }) });
    keep('proof for another request', otherRequest.runId, refused('EXECUTION_ACTIVITY'));
    // Forged in the database (no application writes these): the rejected codes without the verification event, or with one for another request
    // or another preparation, or a verification that does not match the recorded nonce or block.
    const forge = async (verification: Record<string, unknown> | null) => {
      const a = await preparedAttempt(db, store);
      await store.recordDecline(a.runId, 0, a.requestId, a.preparedAt);
      await db.transaction(async tx => {
        await tx.query(`UPDATE workflow_runs SET state = 'CANCELLED', code = 'OWNER_CANCELLED', version = version + 1 WHERE run_id = $1`, [a.runId]);
        if (verification) await tx.query(`INSERT INTO workflow_run_events (tenant_id, run_id, kind, code, detail) VALUES ('default', $1, 'GROUP_DECLINE_VERIFIED',
          'WALLET_REQUEST_REJECTED', $2::jsonb)`, [a.runId, JSON.stringify({ group: 0, requestId: a.requestId, preparedAt: a.preparedAt, ownerNonce: '7', fromBlock: '1000',
          toBlock: '1012', ...verification })]);
        await tx.query(`UPDATE workflow_run_groups SET state = 'SKIPPED', code = 'WALLET_REQUEST_REJECTED', version = version + 1 WHERE run_id = $1`, [a.runId]);
        await tx.query(`INSERT INTO workflow_run_events (tenant_id, run_id, kind, code, detail) VALUES ('default', $1, 'GROUP_STATE', 'WALLET_REQUEST_REJECTED',
          '{"group":0,"state":"SKIPPED"}')`, [a.runId]);
        await tx.query(`UPDATE workflow_run_steps SET state = 'SKIPPED', code = 'WALLET_REQUEST_REJECTED', version = version + 1 WHERE run_id = $1`, [a.runId]);
        await tx.query(`INSERT INTO workflow_run_events (tenant_id, run_id, step_index, kind, code, detail) VALUES ('default', $1, 0, 'STEP_STATE', 'WALLET_REQUEST_REJECTED',
          '{"state":"SKIPPED"}')`, [a.runId]);
        await tx.query(`INSERT INTO workflow_run_events (tenant_id, run_id, kind, code, detail) VALUES ('default', $1, 'RUN_CANCELLED', 'OWNER_CANCELLED',
          '{"state":"CANCELLED"}')`, [a.runId]);
      });
      return a.runId;
    };
    keep('forged: no verification', await forge(null), refused('EXECUTION_ACTIVITY'));
    keep('forged: verification for another request', await forge({ requestId: '0x' + '99'.repeat(32) }), refused('EXECUTION_ACTIVITY'));
    keep('forged: verification for another preparation', await forge({ preparedAt: at(1).toISOString() }), refused('EXECUTION_ACTIVITY'));
    keep('forged: verification for another nonce', await forge({ ownerNonce: '8' }), refused('EXECUTION_ACTIVITY'));
    keep('forged: verification from a later block', await forge({ fromBlock: '1001' }), refused('EXECUTION_ACTIVITY'));
    keep('forged: verification ending before it starts', await forge({ toBlock: '999' }), refused('EXECUTION_ACTIVITY'));
    keep('forged: verification with an extra fact', await forge({ note: 'x' }), refused('EXECUTION_ACTIVITY'));

    // Authorized (the wallet answered), submitted, reconciled into a completed run, failed after submission.
    const answer = { kind: 'EVM_WALLET_BATCH', batchId: '0x' + '42'.repeat(32) };
    const authorized = await preparedAttempt(db, store);
    await store.groupTransition(authorized.runId, 0, ['PREPARED'], 'AUTHORIZED', { authorization: answer });
    keep('authorized', authorized.runId, refused('AUTHORIZATION'));
    const submit = async () => {
      const a = await preparedAttempt(db, store);
      await store.groupTransition(a.runId, 0, ['PREPARED'], 'AUTHORIZED', { authorization: answer });
      await store.groupTransition(a.runId, 0, ['AUTHORIZED'], 'SUBMITTED', { submission: { hashes: ['0x' + '51'.repeat(32)], at: at(70_000).toISOString() } });
      return a.runId;
    };
    keep('submitted', await submit(), refused('EXECUTION_ACTIVITY'));
    const completed = await submit();
    const outcome = { kind: 'USER_FUNDED_GROUP', executionId: `${completed}:g0`, flow: null, status: 'RECONCILED', transactions: [{ chain: CHAIN, hash: '0x' + '51'.repeat(32) }],
      evidence: null, spent: [], received: [], observedAt: at(80_000).toISOString() } as StepOutcome;
    await store.groupTransition(completed, 0, ['SUBMITTED'], 'RECONCILED', { outcome: { status: 'RECONCILED' } });
    await store.stepTransition(completed, 0, ['DELEGATED'], 'RECONCILED', { strategy: { action: 'swap' } as never, workflowHash: HASH, outcome });
    const running = (await store.byId(completed))!;
    await store.transition(completed, { version: running.version, from: ['RUNNING'] }, 'COMPLETED', { completedAt: at(80_000), code: null }, 'RUN_COMPLETED');
    keep('completed', completed, refused('EXECUTION_ACTIVITY'));
    const failedOnChain = await submit();
    await store.groupTransition(failedOnChain, 0, ['SUBMITTED'], 'FAILED', { outcome: { status: 'FAILED' }, code: 'SUBMISSION_REVERTED' });
    await stopRunFromCurrent({ store }, failedOnChain, 'FAILED', 'SUBMISSION_REVERTED');
    expect((await store.byId(failedOnChain))!.state).toBe('FAILED');
    keep('failed after submission', failedOnChain, refused('EXECUTION_ACTIVITY'));
    // Halted with an unanswered batch (blocked past its validity), and a run still RUNNING.
    const halted = await preparedAttempt(db, store);
    await block(store, halted.runId, (await store.groups(halted.runId))[0]!, 'WALLET_BATCH_OUTCOME_UNKNOWN', 'HALTED');
    keep('halted, outcome unknown', halted.runId, refused('EXECUTION_ACTIVITY'));
    const open = await attempt(db, store);
    await store.startUserFunded(open.runId, [GROUP], T0);
    keep('running', open.runId, REFUSED);
    // Re-prepared (an earlier preparation may sit in the wallet under the same id), and a Circle permit signed: both then "proven" rejected.
    const again = await preparedAttempt(db, store);
    const second = { ...prepared(again.runId, at(700_000)), superseded: [] };
    await store.groupTransition(again.runId, 0, ['PREPARED'], 'PREPARED', { prepared: second, validUntil: at(1_300_000), code: null }, 'GROUP_PREPARED_AGAIN');
    await store.recordDecline(again.runId, 0, second.request.id, second.preparedAt);
    await store.cancel(again.runId, await version(store, again.runId), 'OWNER_CANCELLED', at(1_500_000),
      { verifiedDeclines: verified({ requestId: second.request.id, preparedAt: second.preparedAt }) });
    expect((await store.groups(again.runId))[0]!.code).toBe('WALLET_REQUEST_REJECTED');
    keep('re-prepared', again.runId, refused('EXECUTION_ACTIVITY'));
    const permit = await preparedAttempt(db, store);
    await store.groupTransition(permit.runId, 0, ['PREPARED'], 'PREPARED', { prepared: permit.artifact }, 'GROUP_PERMIT_SIGNED');
    await store.recordDecline(permit.runId, 0, permit.requestId, permit.preparedAt);
    await store.cancel(permit.runId, await version(store, permit.runId), 'OWNER_CANCELLED', SETTLED, { verifiedDeclines: verified(permit) });
    keep('circle permit signed', permit.runId, refused('AUTHORIZATION'));
    // A sponsored batch and one with native value, both "proven" rejected (the application never proves either).
    const variant = async (artifact: (base: ReturnType<typeof prepared>) => Record<string, unknown>) => {
      const a = await attempt(db, store);
      await store.startUserFunded(a.runId, [GROUP], T0);
      const base = prepared(a.runId, PREPARED_AT), changed = artifact(base);
      await store.groupTransition(a.runId, 0, ['PLANNED'], 'PREPARED', { prepared: changed, validUntil: VALID_UNTIL, code: null });
      await store.recordDecline(a.runId, 0, base.request.id, base.preparedAt);
      await store.cancel(a.runId, await version(store, a.runId), 'OWNER_CANCELLED', SETTLED, { verifiedDeclines: verified({ requestId: base.request.id, preparedAt: base.preparedAt }) });
      return a.runId;
    };
    keep('sponsored', await variant(b => ({ ...b, sponsorship: { grant: 'spg_x', required: false } })), refused('EXECUTION_ACTIVITY'));
    keep('native value', await variant(b => ({ ...b, request: { ...b.request, calls: [{ ...b.request.calls[0]!, value: '0x1' }] } })), refused('EXECUTION_ACTIVITY'));
    // Not a single Editor card: two steps; another requester kind (a channel conversation).
    const twoSteps = await attempt(db, store, { steps: 2 });
    await store.cancel(twoSteps.runId, await version(store, twoSteps.runId), 'OWNER_CANCELLED', at(30_000));
    keep('two steps', twoSteps.runId, REFUSED);
    const channel = await attempt(db, store, { requester: 'CHANNEL_CONVERSATION' });
    await store.cancel(channel.runId, await version(store, channel.runId), 'OWNER_CANCELLED', at(30_000));
    keep('channel requester', channel.runId, REFUSED);
    // An event of a kind this migration does not name, on an otherwise deletable attempt.
    const unnamed = await attempt(db, store);
    await store.cancel(unnamed.runId, await version(store, unnamed.runId), 'OWNER_CANCELLED', at(30_000));
    await db.query(`INSERT INTO workflow_run_events (tenant_id, run_id, kind, detail) VALUES ('default', $1, 'SOMETHING_NEW', '{}')`, [unnamed.runId]);
    keep('unknown event kind', unnamed.runId, REFUSED);

    const before = (await db.query('SELECT count(*)::int AS n FROM workflow_run_events')).rows;
    for (const [name, { runId, expected }] of Object.entries(kept)) {
      expect(await remove(runId), name).toEqual(expected);
      expect((await db.query('SELECT count(*)::int AS n FROM workflow_runs WHERE run_id = $1', [runId])).rows, name).toEqual([{ n: 1 }]);
    }
    expect((await db.query('SELECT count(*)::int AS n FROM workflow_run_events')).rows).toEqual(before);
    expect((await db.query('SELECT count(*)::int AS n FROM workflow_run_purge_audit')).rows).toEqual([{ n: 0 }]);
    // Archive stays available for every kept attempt.
    expect(await history.change(OWNER, 'WORKFLOW_RUN', completed, 'ARCHIVE')).toEqual({ ok: true, disposition: 'ARCHIVED' });
    expect(await history.disposition(OWNER, 'WORKFLOW_RUN', completed)).toEqual({ ok: true, disposition: 'ARCHIVED' });
  });

  it('refuses while anything can still act on it or an operator record covers it, and never across owners or tenants', async () => {
    const d = await database(33), db = d.db, store = createPgWorkflowRunStore(db, 'default'), history = createOwnerHistory(db, 'default');
    const remove = (runId: string, who = OWNER) => history.change(who, 'WORKFLOW_RUN', runId, 'DELETE');
    const cancelled = async () => {
      const a = await attempt(db, store);
      await store.startUserFunded(a.runId, [GROUP], T0);
      await store.cancel(a.runId, await version(store, a.runId), 'OWNER_CANCELLED', at(30_000));
      return a;
    };
    // A worker holds the run's advance item: refused until the lease ends.
    const leased = await cancelled();
    await db.query(`UPDATE work_items SET state = 'LEASED', lease_owner = 'worker-1', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '1 minute',
      deliveries = deliveries + 1 WHERE kind = 'workflow-run.advance' AND dedupe_key = $1`, [leased.runId]);
    expect(await remove(leased.runId)).toEqual(refused('DEPENDENCY'));
    await db.query(`UPDATE work_items SET state = 'DONE', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, completed_at = now() WHERE dedupe_key = $1`, [leased.runId]);
    expect(await remove(leased.runId)).toEqual(DELETED);
    expect(await counts(db, leased.runId, leased.handoffId)).toEqual(GONE);
    // Another open work item naming the run; a live approval signing session on its handoff.
    const queued = await cancelled();
    await db.query(`INSERT INTO work_items (tenant_id, kind, dedupe_key, payload, state) VALUES ('default', 'support.recheck', 'recheck-1', $1::jsonb, 'READY')`,
      [JSON.stringify({ workflowRunId: queued.runId })]);
    expect(await remove(queued.runId)).toEqual(refused('DEPENDENCY'));
    const session = await cancelled();
    await db.query(`UPDATE mcp_handoffs SET signing_digest = $2, signing_expires_at = now() + interval '5 minutes' WHERE handoff_id = $1`, [session.handoffId, randomBytes(32)]);
    expect(await remove(session.runId)).toEqual(refused('DEPENDENCY'));
    // Legal holds (on the run, on its handoff, on the tenant) and a Support text about the run: refused without a reason, until released.
    const hold = async (scope: 'RUN' | 'TENANT', value: string | null) => {
      const holdId = typedId('lgh');
      await db.query(`INSERT INTO privacy_legal_holds (tenant_id, hold_id, scope, scope_value, reason_code, approval_ref) VALUES ('default', $1, $2, $3, 'LITIGATION', 'ticket-1')`,
        [holdId, scope, value]);
      return () => db.query(`UPDATE privacy_legal_holds SET released_at = now(), release_approval_ref = 'ticket-2' WHERE hold_id = $1`, [holdId]);
    };
    const onRun = await cancelled(), onHandoff = await cancelled();
    const releaseRun = await hold('RUN', onRun.runId), releaseHandoff = await hold('RUN', onHandoff.handoffId);
    expect(await remove(onRun.runId)).toEqual(REFUSED);
    expect(await remove(onHandoff.runId)).toEqual(REFUSED);
    await releaseRun(); await releaseHandoff();
    const releaseTenant = await hold('TENANT', null);
    expect(await remove(onRun.runId)).toEqual(REFUSED);
    await releaseTenant();
    expect(await remove(onRun.runId)).toEqual(DELETED);
    expect(await remove(onHandoff.runId)).toEqual(DELETED);
    const noted = await cancelled();
    await db.query(`INSERT INTO admin_support_texts (tenant_id, text_id, purpose, body, salt, incident_id, created_by, expires_at)
      VALUES ('default', $1, 'SUPPORT_NOTE', 'Owner asked about this attempt.', $2, $3, 'cli', now() + interval '30 days')`, [typedId('stx'), randomBytes(32), `wfr:${noted.runId}`]);
    expect(await remove(noted.runId)).toEqual(REFUSED);
    // Another owner, another tenant: not found (nothing learned), and nothing deleted.
    const mine = await cancelled();
    expect(await remove(mine.runId, STRANGER)).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    await ensureTenant(db, 'other');
    expect(await createOwnerHistory(db, 'other').change(OWNER, 'WORKFLOW_RUN', mine.runId, 'DELETE')).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    expect(await createOwnerHistory(db, 'other').disposition(OWNER, 'WORKFLOW_RUN', mine.runId)).toEqual({ ok: true, disposition: 'VISIBLE' });
    expect((await db.query('SELECT count(*)::int AS n FROM workflow_runs WHERE run_id = ANY($1)', [[queued.runId, session.runId, noted.runId, mine.runId]])).rows)
      .toEqual([{ n: 4 }]);
    expect(await remove(mine.runId)).toEqual(DELETED);
  });

  it('serializes with concurrent deletions, cancellations and group transitions: whichever commits first wins, never both', async () => {
    const d = await database(33), db = d.db, store = createPgWorkflowRunStore(db, 'default');
    // Two connections deleting at once: one deletion, one tombstone, one History event; both answer DELETED.
    const twice = await attempt(db, store);
    await store.cancel(twice.runId, await version(store, twice.runId), 'OWNER_CANCELLED', at(30_000));
    const results = await Promise.all([createOwnerHistory(d.open(), 'default').change(OWNER, 'WORKFLOW_RUN', twice.runId, 'DELETE'),
      createOwnerHistory(d.open(), 'default').change(OWNER, 'WORKFLOW_RUN', twice.runId, 'DELETE')]);
    expect(results).toEqual([DELETED, DELETED]);
    expect(await counts(db, twice.runId, twice.handoffId)).toEqual(GONE);
    expect((await db.query(`SELECT count(*)::int AS n FROM owner_history_events WHERE record_id = $1`, [twice.runId])).rows).toEqual([{ n: 1 }]);

    // A cancellation commits first (the deletion waits on the run's lock): the deletion then sees the ended attempt and deletes it.
    const cancelFirst = await attempt(db, store);
    const cancelling = held(d, async s => s.cancel(cancelFirst.runId, await version(store, cancelFirst.runId), 'OWNER_CANCELLED', at(30_000)));
    await cancelling.started;
    const deleting = createOwnerHistory(db, 'default').change(OWNER, 'WORKFLOW_RUN', cancelFirst.runId, 'DELETE');
    await blocked(db);
    cancelling.release(); await cancelling.done;
    expect(await deleting).toEqual(DELETED);
    expect(await counts(db, cancelFirst.runId, cancelFirst.handoffId)).toEqual(GONE);

    // The deletion commits first: a cancellation and a group transition waiting on the run's lock then find no run and write nothing.
    const deleteFirst = await attempt(db, store);
    await store.startUserFunded(deleteFirst.runId, [GROUP], T0);
    await store.cancel(deleteFirst.runId, await version(store, deleteFirst.runId), 'OWNER_CANCELLED', at(30_000));
    const purging = held(d, async (_s, tx) => expect((await tx.query<{ result: unknown }>('SELECT purge_unsubmitted_workflow_run($1, $2, $3) AS result',
      ['default', OWNER, deleteFirst.runId])).rows[0]!.result).toEqual(DELETED));
    await purging.started;
    const late = store.cancel(deleteFirst.runId, await version(store, deleteFirst.runId), 'OWNER_CANCELLED', at(40_000)).then(() => 'CANCELLED', (e: Error) => e.message);
    const transition = store.groupTransition(deleteFirst.runId, 0, ['SKIPPED'], 'PLANNED', {});
    await blocked(db, 2);
    purging.release(); await purging.done;
    expect(await late).toBe('WORKFLOW_RUN_NOT_FOUND');
    expect(await transition).toBeNull();
    expect(await counts(db, deleteFirst.runId, deleteFirst.handoffId)).toEqual(GONE);

    // The wallet's late answer (a group transition) commits before the owner's verified end: the end refuses (in flight), the deletion refuses.
    const answered = await preparedAttempt(db, store);
    await store.recordDecline(answered.runId, 0, answered.requestId, answered.preparedAt);
    const answering = held(d, s => s.groupTransition(answered.runId, 0, ['PREPARED'], 'AUTHORIZED', { authorization: { kind: 'EVM_WALLET_BATCH', batchId: answered.requestId } }));
    await answering.started;
    const ending = store.cancel(answered.runId, await version(store, answered.runId), 'OWNER_CANCELLED', SETTLED, { verifiedDeclines: verified(answered) })
      .then(() => 'CANCELLED', (e: Error) => e.message);
    await blocked(db);
    answering.release(); await answering.done;
    expect(await ending).toBe('WORKFLOW_RUN_GROUP_IN_FLIGHT');
    expect(await createOwnerHistory(db, 'default').change(OWNER, 'WORKFLOW_RUN', answered.runId, 'DELETE')).toEqual(refused('AUTHORIZATION'));
    // The owner's verified end commits first: the late answer finds an ended run and writes nothing; the deletion then deletes it.
    const ended = await preparedAttempt(db, store);
    await store.recordDecline(ended.runId, 0, ended.requestId, ended.preparedAt);
    const endingFirst = held(d, async s => s.cancel(ended.runId, await version(store, ended.runId), 'OWNER_CANCELLED', SETTLED, { verifiedDeclines: verified(ended) }));
    await endingFirst.started;
    const answer = store.groupTransition(ended.runId, 0, ['PREPARED'], 'AUTHORIZED', { authorization: { kind: 'EVM_WALLET_BATCH', batchId: ended.requestId } });
    await blocked(db);
    endingFirst.release(); await endingFirst.done;
    expect(await answer).toBeNull();
    expect(await createOwnerHistory(db, 'default').change(OWNER, 'WORKFLOW_RUN', ended.runId, 'DELETE')).toEqual(DELETED);
    expect(await counts(db, ended.runId, ended.handoffId)).toEqual(GONE);
  });

  it('never races the workflow-run worker: a leased advance item keeps the attempt; a deletion in progress hides the item from a claim (SKIP LOCKED)', async () => {
    const d = await database(33), db = d.db, store = createPgWorkflowRunStore(db, 'default');
    const queue = createPostgresWorkQueue({ db, ownerId: 'worker-1', tenantId: 'default' });
    const own = <T extends { readonly dedupeKey: string }>(items: readonly T[], runId: string) => items.filter(i => i.dedupeKey === runId);
    // The worker claimed the attempt's advance item first: deletion refuses while the lease is held, and succeeds once the worker settled it.
    const leased = await rejectedAttempt(db, store);
    const claimed = own(await queue.claim(10, ['workflow-run.advance']), leased.runId);
    expect(claimed).toHaveLength(1);
    expect(await createOwnerHistory(db, 'default').change(OWNER, 'WORKFLOW_RUN', leased.runId, 'DELETE')).toEqual(refused('DEPENDENCY'));
    expect(await counts(db, leased.runId, leased.handoffId)).toMatchObject({ runs: 1, tombstones: 0 });
    expect(await queue.complete(claimed[0]!)).toBe(true);
    expect(await createOwnerHistory(db, 'default').change(OWNER, 'WORKFLOW_RUN', leased.runId, 'DELETE')).toEqual(DELETED);
    expect(await counts(db, leased.runId, leased.handoffId)).toEqual(GONE);
    // A deletion in progress holds the attempt's advance item: a concurrent claim skips it, and after the commit there is nothing to claim.
    const purging = await rejectedAttempt(db, store);
    const holding = held(d, async (_s, tx) => expect((await tx.query<{ result: unknown }>('SELECT purge_unsubmitted_workflow_run($1, $2, $3) AS result',
      ['default', OWNER, purging.runId])).rows[0]!.result).toEqual(DELETED));
    await holding.started;
    expect(own(await queue.claim(10, ['workflow-run.advance']), purging.runId)).toEqual([]);
    holding.release(); await holding.done;
    expect(await counts(db, purging.runId, purging.handoffId)).toEqual(GONE);
    expect(own(await queue.claim(10, ['workflow-run.advance']), purging.runId)).toEqual([]);
  });

  it('schema 32 without 0033 keeps refusing every workflow-run deletion; Archive and History reads work as before', async () => {
    const d = await database(32), db = d.db, store = createPgWorkflowRunStore(db, 'default'), history = createOwnerHistory(db, 'default');
    const a = await attempt(db, store);
    await store.cancel(a.runId, await version(store, a.runId), 'OWNER_CANCELLED', at(30_000));
    expect(await history.change(OWNER, 'WORKFLOW_RUN', a.runId, 'DELETE')).toEqual(REFUSED);
    expect(await history.change(STRANGER, 'WORKFLOW_RUN', a.runId, 'DELETE')).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    expect(await history.disposition(OWNER, 'WORKFLOW_RUN', a.runId)).toEqual({ ok: true, disposition: 'VISIBLE' });
    expect(await history.change(OWNER, 'WORKFLOW_RUN', a.runId, 'ARCHIVE')).toEqual({ ok: true, disposition: 'ARCHIVED' });
    expect(await history.disposition(OWNER, 'WORKFLOW_RUN', a.runId)).toEqual({ ok: true, disposition: 'ARCHIVED' });
    await expect(db.query('DELETE FROM workflow_runs WHERE run_id = $1', [a.runId])).rejects.toThrow('WORKFLOW_RUN_RECORD_APPEND_ONLY');
    expect((await db.query(`SELECT to_regclass('workflow_run_purge_audit') AS t`)).rows).toEqual([{ t: null }]);
  });

  it('privacy access and erasure still find Support texts about a deleted attempt, through its tombstone', async () => {
    const d = await database(33), db = d.db, store = createPgWorkflowRunStore(db, 'default'), key = randomBytes(32);
    const a = await attempt(db, store);
    await store.cancel(a.runId, await version(store, a.runId), 'OWNER_CANCELLED', at(30_000));
    expect(await createOwnerHistory(db, 'default').change(OWNER, 'WORKFLOW_RUN', a.runId, 'DELETE')).toEqual(DELETED);
    // Notes an operator wrote afterwards about the deleted attempt (as an incident and by run id).
    for (const [incident, runId] of [[`wfr:${a.runId}`, null], [null, a.runId]] as const)
      await db.query(`INSERT INTO admin_support_texts (tenant_id, text_id, purpose, body, salt, run_id, incident_id, created_by, expires_at)
        VALUES ('default', $1, 'SUPPORT_NOTE', 'Owner asked about a deleted attempt.', $2, $3, $4, 'cli', now() + interval '30 days')`, [typedId('stx'), randomBytes(32), runId, incident]);
    const request = async (kind: 'ACCESS' | 'ERASURE') => {
      const { requestId } = await openPrivacyRequest(db, 'default', kind, { kind: 'WALLET', ref: walletSubject(key, OWNER).ref }) as { requestId: string };
      await decidePrivacyRequest(db, 'default', requestId, 'APPROVED', 'IDENTITY_VERIFIED', 'ticket-7');
      return requestId;
    };
    // A kept attempt (still open) and a note keyed by its approval handoff id (data-privacy review: matched like a run id).
    const kept = await attempt(db, store);
    await db.query(`INSERT INTO admin_support_texts (tenant_id, text_id, purpose, body, salt, run_id, incident_id, created_by, expires_at)
      VALUES ('default', $1, 'SUPPORT_NOTE', 'Owner asked about a kept attempt.', $2, $3, NULL, 'cli', now() + interval '30 days')`, [typedId('stx'), randomBytes(32), kept.handoffId]);
    const access = await privacyAccess(db, 'default', await request('ACCESS'), key, OWNER, false);
    expect(access.supportTexts as unknown[]).toHaveLength(3);
    // Single-card workflow runs and the tombstones of deleted attempts are reported (counts and identities only).
    expect(access.workflowRuns).toEqual([{ state: 'PENDING', stepCount: 1, count: 1 }]);
    expect(access.deletedWorkflowRunAttempts).toEqual([{ runId: a.runId, shape: 'NO_WALLET_REQUEST', finalState: 'CANCELLED', createdAt: expect.any(String),
      deletedAt: expect.any(String) }]);
    expect(await privacyErase(db, 'default', await request('ERASURE'), key, OWNER)).toMatchObject({ supportTextsErased: 3, keptByLegalHold: 0,
      workflowRunRecordsNotInScope: true, deletedAttemptTombstonesRetained: true });
    expect((await db.query('SELECT count(*)::int AS n FROM admin_support_texts')).rows).toEqual([{ n: 0 }]);
  });
});
