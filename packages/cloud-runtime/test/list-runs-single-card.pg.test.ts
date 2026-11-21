// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): an owner's history lists their single-card attempts — one-step
 * EDITOR_SESSION workflow runs (certified migration 0032) — beside their execution records, so History's existing Archive/Delete reach them.
 * REAL disposable PostgreSQL; every row is a synthetic fixture (no chain, no provider, no production data). Proven here: only the owner's own
 * eip155 one-step Editor runs are listed (never multi-step runs, other requesters, another owner, a Solana owner or another tenant); archived
 * attempts are hidden unless archived entries are asked for; flow-scoped and operator reads are unchanged; the summary claims nothing the run
 * row does not prove; the (updated_at, run_id) keyset pages across both kinds without skipping or repeating an entry, ties included; and the
 * query answers on the shipped schema, on exact schema 31 (no one-step run can exist) and on schema 32, without 0033.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { CERTIFIED_FORWARD_MIGRATIONS, createOwnerHistory, createPostgresLogStore, createRunQueries, ensureTenant, loadMigrations, migrate, type Database,
  type Migration, type Projector, type RunSummary } from '../src/index.js';
import { bytes, createTestDatabase, type TestDatabase } from './pg-harness.js';

const owner = '0x' + '11'.repeat(20), stranger = '0x' + '22'.repeat(20), solanaOwner = 'So11111111111111111111111111111111111111112';
const HASH = '0x' + '1'.repeat(64);
const CERTIFICATE = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
const opened: TestDatabase[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(t => t.drop())); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex').slice(0, 26).replace(/[0189]/g, 'a')}`;

async function fixture(version: number): Promise<Migration> {
  const identity = CERTIFICATE.migrations.find(m => m.version === version)!;
  const sql = await readFile(new URL(`./fixtures/${String(version).padStart(4, '0')}_${identity.name}.sql`, import.meta.url), 'utf8');
  expect(sha(sql)).toBe(identity.sha256);
  return { ...identity, sql };
}
/** A database at exactly `head` (31 or 32): the v28 build's history plus the certified 0029–0032 fixtures, as their operator commands apply them. */
async function schema(head: 31 | 32): Promise<TestDatabase> {
  const t = await createTestDatabase({ migrated: false }); opened.push(t);
  const list = [...(await loadMigrations()).slice(0, 28), await fixture(29), await fixture(30), await fixture(31), ...head === 32 ? [await fixture(32)] : []];
  expect(await migrate(t.db, list)).toHaveLength(head);
  return t;
}
async function shipped(): Promise<TestDatabase> { const t = await createTestDatabase(); opened.push(t); return t; }

/** One execution record of `account` (the projected `execution_runs` row the existing history lists), as the owner-history suite seeds it. */
async function execution(db: Database, runId: string, account = owner, tenantId = 'default') {
  await ensureTenant(db, tenantId);
  const projector: Projector = () => ({ run: { runId, workflowId: `workflow-${runId}`, flow: 'base-swap', status: 'SIMULATED', provenance: 'MOCKED', ownerAccount: account,
    recoveryOf: null, errorCode: null, needsObservation: false, hasEvidence: false, attempts: [], journal: [] }, work: [] });
  const store = createPostgresLogStore({ db, tenantId, namespace: 'base-swap', projector });
  await store.create(`${runId}.jsonl`, bytes(JSON.stringify({ quote: { executionId: runId, ownerReview: { account } }, workflow: { workflowId: `workflow-${runId}` },
    reviewedManifestHash: null, attempts: [], outcome: null }) + '\n'));
  return runId;
}
type Requester = 'EDITOR_SESSION' | 'MCP_ACCOUNT' | 'DEVELOPER_PROJECT' | 'CHANNEL_CONVERSATION' | 'AUTOMATION_RULE';
const swapStep = { index: 0, action: 'swap', network: 'arbitrum', destinationNetwork: null, nodeIds: ['n1'], kind: 'SWAP', protocol: 'uniswap-v3',
  fundsClass: 'REAL_FUNDS', environment: 'MAINNET', flow: 'arbitrum-swap', workflowHash: HASH };
/**
 * A workflow run of `steps` steps with its step rows (0015) and its parent approval handoff, exactly as the workflow-run store creates one. The
 * parent handoff is always an Editor one (MCP and Developer handoffs need their own grants or approvals); the run's own `requester_kind`,
 * which the listing reads, is the requester under test.
 */
async function workflowRun(db: Database, input: { steps?: number; requester?: Requester; account?: string; namespace?: 'eip155' | 'solana'; tenant?: string;
  plan?: unknown; updatedAt?: string } = {}): Promise<string> {
  const tenantId = input.tenant ?? 'default', account = input.account ?? owner, namespace = input.namespace ?? 'eip155', steps = input.steps ?? 1;
  await ensureTenant(db, tenantId);
  const handoffId = id('apr'), runId = id('wfr'), requester = input.requester ?? 'EDITOR_SESSION';
  await db.query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind, requester_id, account_id, client_id, client_name, secret_digest, strategy,
      workflow_hash, engine_version, network_environment, funds_class, plan, status, expires_at)
    VALUES ($1, $2, $3, $4, NULL, 'flofi-editor', 'Editor', $5, '{}', $6, 'flofi-engine-2', 'MAINNET', 'REAL_FUNDS', $7::jsonb, 'PENDING', now() + interval '1 hour')`,
  [tenantId, handoffId, 'EDITOR_SESSION', 'acct_' + 'a'.repeat(32), randomBytes(32), HASH,
    JSON.stringify(input.plan ?? { kind: 'SEQUENTIAL', steps: Array.from({ length: steps }, (_, index) => ({ ...swapStep, index })) })]);
  await db.query(`INSERT INTO workflow_runs (tenant_id, run_id, handoff_id, requester_kind, requester_ref, owner_namespace, owner_account, wallets, strategy, workflow_hash,
      engine_version, step_count, state, expires_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, '{}', $9, 'flofi-engine-2', $10, 'PENDING', now() + interval '1 day', COALESCE($11::timestamptz, now()), COALESCE($11::timestamptz, now()))`,
  [tenantId, runId, handoffId, requester, 'acct_' + 'a'.repeat(32), namespace, account, JSON.stringify({ [namespace]: account }), HASH, steps, input.updatedAt ?? null]);
  for (let i = 0; i < steps; i++) await db.query(`INSERT INTO workflow_run_steps (tenant_id, run_id, step_index, state) VALUES ($1, $2, $3, 'PENDING')`, [tenantId, runId, i]);
  return runId;
}
/** Drives a run through 0015's unchanged transition trigger (every move is one the engine makes). */
const move = (db: Database, runId: string, set: string) => db.query(`UPDATE workflow_runs SET ${set}, version = version + 1 WHERE run_id = $1`, [runId]);
const ids = (items: readonly RunSummary[]) => items.map(item => item.runId);
async function every(db: Database, limit: number, filter: Parameters<ReturnType<typeof createRunQueries>['listRuns']>[2]): Promise<string[]> {
  const queries = createRunQueries(db, 'default'), out: string[] = [];
  let cursor: string | null = null, pages = 0;
  do {
    const page = await queries.listRuns(cursor, limit, filter);
    expect(page.items.length).toBeLessThanOrEqual(limit);
    out.push(...ids(page.items)); cursor = page.next;
    expect(++pages).toBeLessThan(100);
  } while (cursor);
  return out;
}

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: single-card attempts in the owner history (PostgreSQL)', { timeout: 120_000 }, () => {
  it('lists only the owner\'s own one-step Editor runs beside their execution records, projected without claiming evidence or reconciliation', async () => {
    const t = await schema(32);
    const record = await execution(t.db, 'record-1');
    const pending = await workflowRun(t.db);
    const cancelled = await workflowRun(t.db);
    await move(t.db, cancelled, `state = 'CANCELLED', code = 'OWNER_CANCELLED'`);
    const halted = await workflowRun(t.db);
    await move(t.db, halted, `state = 'RUNNING', mode = 'USER_FUNDED'`);
    await move(t.db, halted, `state = 'HALTED', code = 'WALLET_BATCH_OUTCOME_UNKNOWN'`);
    const completed = await workflowRun(t.db);
    await move(t.db, completed, `state = 'RUNNING', mode = 'USER_FUNDED'`);
    await move(t.db, completed, `state = 'COMPLETED', completed_at = now()`);
    // Never listed for this owner: a multi-step Editor run, every other requester's one-step run, another owner's, a Solana owner's, another tenant's.
    const multi = await workflowRun(t.db, { steps: 2 });
    const others = await Promise.all((['MCP_ACCOUNT', 'DEVELOPER_PROJECT', 'CHANNEL_CONVERSATION', 'AUTOMATION_RULE'] as const).map(requester => workflowRun(t.db, { requester })));
    const strangers = await workflowRun(t.db, { account: stranger });
    const solana = await workflowRun(t.db, { account: solanaOwner, namespace: 'solana' });
    const foreign = await workflowRun(t.db, { tenant: 'another' });

    const queries = createRunQueries(t.db, 'default');
    const page = await queries.listRuns(null, 100, { owner });
    expect(new Set(ids(page.items))).toEqual(new Set([record, pending, cancelled, halted, completed]));
    for (const excluded of [multi, ...others, strangers, solana, foreign]) expect(ids(page.items)).not.toContain(excluded);
    const rows = Object.fromEntries((await t.db.query<{ run_id: string; version: string; created_at: Date; updated_at: Date }>(
      'SELECT run_id, version::text, created_at, updated_at FROM workflow_runs')).rows.map(r => [r.run_id, r]));
    const byId = Object.fromEntries(page.items.map(item => [item.runId, item]));
    const expected = (runId: string, status: string, errorCode: string | null, attentionRequired: boolean): RunSummary => ({ runId, workflowId: '', flow: 'arbitrum-swap',
      status, provenance: 'WORKFLOW_RUN', ownerAccount: owner, errorCode, needsObservation: false, attentionRequired, hasEvidence: false,
      version: Number(rows[runId]!.version), createdAt: rows[runId]!.created_at.toISOString(), updatedAt: rows[runId]!.updated_at.toISOString() });
    expect(byId[pending]).toEqual(expected(pending, 'PENDING', null, false));
    expect(byId[cancelled]).toEqual(expected(cancelled, 'CANCELLED', 'OWNER_CANCELLED', false));
    expect(byId[halted]).toEqual(expected(halted, 'HALTED', 'WALLET_BATCH_OUTCOME_UNKNOWN', true));
    expect(byId[completed]).toEqual(expected(completed, 'COMPLETED', null, false));
    expect(byId[record]).toMatchObject({ provenance: 'MOCKED', flow: 'base-swap', workflowId: 'workflow-record-1' });
    // The other owner sees their own attempt and nothing of this owner's; a Solana owner never gets a workflow-run row.
    expect(ids((await queries.listRuns(null, 100, { owner: stranger })).items)).toEqual([strangers]);
    expect((await queries.listRuns(null, 100, { owner: solanaOwner })).items).toEqual([]);
    // Unchanged: flow-scoped reads (composition reconciliation, MCP, the per-flow stores) and operator reads list execution records only.
    expect(ids((await queries.listRuns(null, 100, { owner, flow: 'base-swap', includeArchived: true })).items)).toEqual([record]);
    expect(ids((await queries.listRuns(null, 100, {})).items)).toEqual([record]);
    // An attempt has no execution detail: getRun still reads execution records only (the API answers 404 for a wfr_ id).
    expect(await queries.getRun(pending)).toBeNull();
  });

  it('names the action only from the plan\'s single step; anything else is the fixed workflow-run', async () => {
    const t = await schema(32), queries = createRunQueries(t.db, 'default');
    const plans = {
      transfer: { kind: 'SEQUENTIAL', steps: [{ ...swapStep, action: 'transfer', flow: 'base-mainnet-transfer' }] },
      noFlow: { kind: 'SEQUENTIAL', steps: [{ ...swapStep, flow: null }] },
      twoSteps: { kind: 'SEQUENTIAL', steps: [swapStep, { ...swapStep, index: 1 }] },
      malformed: { kind: 'SEQUENTIAL', steps: [{ ...swapStep, flow: 'Arbitrum Swap; DROP' }] },
      object: { kind: 'SEQUENTIAL', steps: { 0: swapStep } },
      none: { kind: 'SEQUENTIAL' },
    };
    const runs = Object.fromEntries(await Promise.all(Object.entries(plans).map(async ([name, plan]) => [name, await workflowRun(t.db, { plan })] as const)));
    const flows = Object.fromEntries((await queries.listRuns(null, 100, { owner })).items.map(item => [item.runId, item.flow]));
    expect(Object.fromEntries(Object.entries(runs).map(([name, runId]) => [name, flows[runId]]))).toEqual({ transfer: 'base-mainnet-transfer', noFlow: 'workflow-run',
      twoSteps: 'workflow-run', malformed: 'workflow-run', object: 'workflow-run', none: 'workflow-run' });
  });

  it('hides an archived attempt unless archived entries are asked for, and keeps the run itself unchanged', async () => {
    const t = await schema(32), queries = createRunQueries(t.db, 'default');
    const kept = await workflowRun(t.db), archived = await workflowRun(t.db);
    await move(t.db, archived, `state = 'CANCELLED', code = 'OWNER_CANCELLED'`);
    const before = (await t.db.query('SELECT * FROM workflow_runs WHERE run_id = $1', [archived])).rows;
    expect(await createOwnerHistory(t.db, 'default').change(owner, 'WORKFLOW_RUN', archived, 'ARCHIVE')).toEqual({ ok: true, disposition: 'ARCHIVED' });
    expect(ids((await queries.listRuns(null, 100, { owner })).items)).toEqual([kept]);
    expect(new Set(ids((await queries.listRuns(null, 100, { owner, includeArchived: true })).items))).toEqual(new Set([kept, archived]));
    // Archiving hides the entry only: the run row (and its append-only history) is untouched, and another owner's archive hides nothing here.
    expect((await t.db.query('SELECT * FROM workflow_runs WHERE run_id = $1', [archived])).rows).toEqual(before);
    await t.db.query(`INSERT INTO owner_history_visibility (tenant_id, owner_account, kind, record_id) VALUES ('default', $1, 'WORKFLOW_RUN', $2)`, [stranger, kept]);
    // An archive of the same id under another kind does not hide a workflow run either.
    await t.db.query(`INSERT INTO owner_history_visibility (tenant_id, owner_account, kind, record_id) VALUES ('default', $1, 'EXECUTION_RUN', $2)`, [owner, kept]);
    expect(ids((await queries.listRuns(null, 100, { owner })).items)).toEqual([kept]);
  });

  it('pages both kinds on one (updated_at, run_id) keyset: stable, complete, no repeats, ties broken by run_id', async () => {
    const t = await schema(32);
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 12, minute)).toISOString();
    const records = await Promise.all(Array.from({ length: 7 }, (_, i) => execution(t.db, `record-${i}`)));
    // Interleaved timestamps; minutes 2 and 4 are shared by an execution record AND an attempt (and minute 4 by two attempts).
    for (const [i, minute] of [0, 2, 4, 6, 8, 10, 12].entries()) await t.db.query('UPDATE execution_runs SET updated_at = $2 WHERE run_id = $1', [records[i], at(minute)]);
    const attempts: string[] = [];
    for (const minute of [1, 2, 4, 4, 7, 13]) attempts.push(await workflowRun(t.db, { updatedAt: at(minute) }));
    // Noise that must never surface on any page.
    await workflowRun(t.db, { steps: 3, updatedAt: at(5) }); await workflowRun(t.db, { account: stranger, updatedAt: at(5) });
    await workflowRun(t.db, { requester: 'CHANNEL_CONVERSATION', updatedAt: at(5) });

    const queries = createRunQueries(t.db, 'default');
    const full = (await queries.listRuns(null, 100, { owner })).items;
    expect(new Set(ids(full))).toEqual(new Set([...records, ...attempts]));
    // Newest first; within one timestamp the run id decides (the database's own order, read back here, is what every page must follow).
    for (let i = 1; i < full.length; i++) expect(Date.parse(full[i - 1]!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(full[i]!.updatedAt));
    const { rows: order } = await t.db.query<{ run_id: string }>(`SELECT run_id FROM (SELECT run_id, updated_at FROM execution_runs
      UNION ALL SELECT run_id, updated_at FROM workflow_runs WHERE run_id = ANY($1)) x ORDER BY updated_at DESC, run_id DESC`, [attempts]);
    expect(ids(full)).toEqual(order.map(r => r.run_id));
    for (const limit of [1, 2, 3, 4, 5, 13]) {
      const paged = await every(t.db, limit, { owner });
      expect(paged, `limit ${limit}`).toEqual(ids(full));
      expect(new Set(paged).size).toBe(paged.length);
    }
    // Deterministic: the same cursor always returns the same next page.
    const first = await queries.listRuns(null, 4, { owner });
    expect(await queries.listRuns(first.next, 4, { owner })).toEqual(await queries.listRuns(first.next, 4, { owner }));
    // A tampered cursor is still refused.
    await expect(queries.listRuns('not a cursor', 4, { owner })).rejects.toThrow('CURSOR_INVALID');
    // Archived entries leave the page sequence cleanly too.
    await createOwnerHistory(t.db, 'default').change(owner, 'WORKFLOW_RUN', attempts[2]!, 'ARCHIVE');
    await createOwnerHistory(t.db, 'default').change(owner, 'EXECUTION_RUN', records[1]!, 'ARCHIVE');
    const visible = ids(full).filter(runId => runId !== attempts[2] && runId !== records[1]);
    for (const limit of [1, 3, 5]) expect(await every(t.db, limit, { owner })).toEqual(visible);
    expect(await every(t.db, 3, { owner, includeArchived: true })).toEqual(ids(full));
  });

  it.each([['shipped', shipped], ['exact schema 31', () => schema(31)]] as const)('answers on the %s database, where no one-step run can exist (no 0032, no 0033)', async (_, open) => {
    const t = await open();
    const record = await execution(t.db, 'record-1');
    // Multi-step Editor runs exist on every schema; they were never listed and still are not.
    const multi = await workflowRun(t.db, { steps: 2 });
    // The database itself refuses a one-step run before 0032 (the Editor keeps its own per-flow single-card path there). Release certification
    // (FLOFI_TEST_CERTIFIED_AHEAD=1, never in CI) migrates the shipped database one certified release ahead, to 32, where it is accepted.
    const head = (await t.db.query<{ version: number }>('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]!.version;
    if (head < 32) await expect(workflowRun(t.db, { steps: 1 })).rejects.toThrow(/workflow_runs_step_count_check/);
    const queries = createRunQueries(t.db, 'default');
    const listed = head < 32 ? [record] : expect.arrayContaining([record]);
    expect(ids((await queries.listRuns(null, 100, { owner })).items)).toEqual(listed);
    expect(ids((await queries.listRuns(null, 100, { owner, includeArchived: true })).items)).toEqual(listed);
    expect(ids((await queries.listRuns(null, 100, { owner })).items)).not.toContain(multi);
    expect(await every(t.db, 1, { owner })).toEqual(listed);
    expect(ids((await queries.listRuns(null, 100, { owner: stranger })).items)).toEqual([]);
    expect(multi).toMatch(/^wfr_/);
  });
});
