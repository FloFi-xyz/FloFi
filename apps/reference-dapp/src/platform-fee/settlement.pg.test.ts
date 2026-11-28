// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (completion): actual platform fee collection against PostgreSQL at the certified schema 38, with the
 * transfer flows replaced by an in-memory double of their contract (simulate, review, invalidate and the durable record). Synthetic rows only;
 * nothing is signed or submitted: the double reports the outcomes a real transfer flow would record.
 *   §3.2 a direct single flow is accounted once (root runs only: never a workflow step's run, a recovery, or a settlement transfer);
 *   §3.3 a bridge inside a workflow is charged once, by its workflow;
 *   §3.5 the authorized basis is recorded once at Review/creation and caps the collection;
 *   §3.6 one attempt at a time under concurrent requests, collection only from a reconciled transfer to the treasury, unknown outcomes stay
 *        pending, an unsigned attempt expires only after its transfer was invalidated, failures are retryable without paying twice, a divergent
 *        transfer stops automatic retries; Admin collected revenue comes from transactions, not from accrued lines.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CERTIFIED_FORWARD_MIGRATIONS, forwardMigrationSqlUrl, loadMigrations, migrate, type Database } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { composeWorkflow, semanticWorkflowHash } from '../engine/strategy-engine';
import { platformFeeActivation } from './activation.ts';
import { feeAuthorizationsActive, loadFeeAuthorization, recordFeeAuthorization } from './authorization.ts';
import { accruePlatformFees, loadFeeTotals } from './ledger.ts';
import { workflowFeeBasis } from './principal';
import { reconcileSettlements, SETTLEMENT_UNSIGNED_TTL_MS, startSettlement, type SettlementDeps } from './settlement.ts';
import { singleFlowFeeBasis } from './single-flow.ts';

const NOW = new Date('2026-12-10T12:00:00.000Z'), DAY = 86_400_000, ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const OWNER = '0x' + 'ab'.repeat(20);
const TREASURY_EVM = '0x8ba1f109551bD432803012645Ac136ddd64DBA72', TREASURY_SOLANA = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const ENV = { FLOFI_PLATFORM_FEE_ACCOUNTING_FROM: new Date(Date.now() - 3 * DAY).toISOString(), FLOFI_PLATFORM_FEE_COLLECTION: 'on', FLOFI_PLATFORM_FEE_TREASURY_EVM: TREASURY_EVM,
  FLOFI_PLATFORM_FEE_TREASURY_SOLANA: TREASURY_SOLANA, FLOFI_PLATFORM_FEE_POLICY_APPROVAL: 'FIN-2026-11-28' };
const SWAP = { action: 'swap', network: 'ethereum', inputAsset: 'USDC', outputAsset: 'ETH', amount: '100', slippageBps: 100 };
const BRIDGE = { action: 'bridge', sourceNetwork: 'ethereum', destinationNetwork: 'robinhood', asset: 'ETH', amount: '0.04' };
const USDC = { chainId: 'eip155:1', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 };
let t: TestDatabase, db: Database, seq = 0;
const tag = () => (++seq).toString(16).padStart(32, '0');
const compose = (input: unknown) => { const w = composeWorkflow(input); if (!w.ok) throw new Error(w.code); return w; };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const b32 = () => [...randomBytes(26)].map(b => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32]).join('');

beforeAll(async () => {
  t = await createTestDatabase({ migrated: false }); db = t.db;
  const certificate = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
  const forward = await Promise.all(certificate.migrations.map(async m => ({ ...m, sql: await readFile(forwardMigrationSqlUrl(m), 'utf8') })));
  expect(await migrate(db, [...await loadMigrations(), ...forward])).toHaveLength(38);
});
afterAll(async () => { await t?.drop(); });

/** A single-flow run whose durable log ends with `record` (the projection reads that line), as a flow service would persist it. */
async function singleRun(record: unknown, seed: { flow?: string; status?: string; workflowId?: string; recoveryOf?: string; createdAt?: Date } = {}): Promise<string> {
  const runId = `ett-${tag()}`, flow = seed.flow ?? 'ethereum-swap', name = `${runId}.jsonl`, status = seed.status ?? 'RECONCILED', createdAt = seed.createdAt ?? ago(1);
  const bytes = Buffer.from(JSON.stringify(record) + '\n'), workflowId = seed.workflowId ?? `wf-${runId}`;
  await db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ('default', $1) ON CONFLICT DO NOTHING`, [workflowId]);
  await db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256) VALUES ('default', $1, $2, 'RUN', 1, 1, $3, $4)`,
    [flow, name, bytes.length, sha(bytes)]);
  await db.query(`INSERT INTO execution_log_segments (tenant_id, namespace, name, seq, bytes, segment_sha256, content_sha256) VALUES ('default', $1, $2, 0, $3, $4, $4)`,
    [flow, name, bytes, sha(bytes)]);
  await db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, owner_account, needs_observation, has_evidence,
      log_version, recovery_of, created_at, updated_at) VALUES ('default', $1, $2, $3, $4, $2, $5, 'PUBLIC_MAINNET', $6, false, $7, 1, $8, $9, $9)`,
  [runId, flow, name, workflowId, status, OWNER, status === 'RECONCILED', seed.recoveryOf ?? null, createdAt]);
  return runId;
}
const reviewed = (strategy: unknown) => ({ review: { workflow: compose(strategy).steps[0]!.workflow, account: OWNER }, verdict: 'RECONCILED' });

/** An in-memory double of the transfer flows' contract: what `simulate`, `review` and `invalidate` record, and the durable record `load` returns. */
function transferFlows() {
  const records = new Map<string, Record<string, unknown>>(), calls: string[] = [];
  let n = 0;
  const call: SettlementDeps['call'] = async (flow, method, args) => {
    calls.push(`${flow}.${method}`);
    if (method === 'simulate') {
      const workflow = args[0] as { nodes: { inputs: { name: string; value: unknown }[] }[] }, id = `ett-${(++n).toString(16).padStart(32, 'f')}`;
      const recipient = JSON.stringify(workflow).match(/0x[0-9a-f]{40}/g)!.find(a => a === TREASURY_EVM.toLowerCase());
      const record = { id, review: { workflow, recipient, account: args[1], commitment: '0x' + '1'.repeat(64), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() },
        authorization: null, attempt: null, verdict: 'PENDING' };
      records.set(id, record);
      return { ok: true, value: record };
    }
    const record = records.get(String(args[0]));
    if (!record) return { ok: false, code: 'TRANSFER_RUN_MISSING' };
    if (method === 'review') { record.authorization = (record.review as { commitment: string }).commitment; return { ok: true, value: record }; }
    if (method === 'recoverReview') {
      if (record.notSubmitted !== true) return { ok: false, code: 'TRANSFER_RECOVERY_NOT_ALLOWED' };
      const next = `ett-${(++n).toString(16).padStart(32, 'f')}`;
      const recovered = { ...structuredClone(record), id: next, recoveryOf: record.id, authorization: null, attempt: null, notSubmitted: undefined, verdict: 'PENDING' };
      records.set(next, recovered);
      return { ok: true, value: recovered };
    }
    // As the transfer flows: `invalidate` only unbinds the Review; `observe` cancels a PREPARED attempt it proves unsent.
    if (method === 'invalidate') { record.authorization = null; return { ok: true, value: record }; }
    if (method === 'observe') {
      const attempt = record.attempt as { state: string } | null;
      if (attempt?.state === 'PREPARED') Object.assign(record, { notSubmitted: true, attempt: { state: 'CANCELLED', transactionHash: null, reconciled: false } });
      return { ok: true, value: record };
    }
    return { ok: false, code: 'METHOD_NOT_FAKED' };
  };
  const load = async (_flow: string, runId: string) => structuredClone(records.get(runId) ?? null);
  /** What the owner's wallet and the transfer flow's own reconciliation would leave in the record. */
  const settle = (runId: string, outcome: 'RECONCILED' | 'UNKNOWN' | 'REJECTED' | 'DIVERGENT' | 'SIGNED') => {
    const record = records.get(runId)!, hash = '0x' + createHash('sha256').update(runId).digest('hex');
    if (outcome === 'RECONCILED') Object.assign(record, { verdict: 'RECONCILED', attempt: { state: 'CONFIRMED', transactionHash: hash, reconciled: true } });
    if (outcome === 'UNKNOWN') Object.assign(record, { attempt: { state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: null, reconciled: false } });
    if (outcome === 'SIGNED') Object.assign(record, { attempt: { state: 'PENDING', transactionHash: hash, reconciled: false } });
    if (outcome === 'REJECTED') Object.assign(record, { notSubmitted: true, attempt: { state: 'CANCELLED', transactionHash: null, reconciled: false } });
    if (outcome === 'DIVERGENT') Object.assign(record, { verdict: 'DIVERGENT', attempt: { state: 'CONFIRMED', transactionHash: hash, reconciled: true } });
    return hash;
  };
  return { call, load, settle, calls, records };
}
const ledger = async (runId: string) => (await db.query<{ state: string; version: string; lines: { fee: string }[]; collection: Record<string, unknown> | null }>(
  'SELECT state, version::text AS version, lines, collection FROM platform_fee_ledger WHERE run_id = $1', [runId])).rows[0];
const authorize = async (runId: string, record: { review: { workflow: unknown } }) =>
  recordFeeAuthorization(db, 'default', { runId }, singleFlowFeeBasis(record, { final: false }), semanticWorkflowHash(record.review.workflow as never));
const activation = platformFeeActivation(ENV);
const owner = { namespace: 'eip155' as const, account: OWNER };

describe('single-flow accounting and parent/child deduplication (§3.2/§3.3)', () => {
  it('accounts a root single flow once; never a workflow step run, a recovery or a settlement transfer', async () => {
    expect(await feeAuthorizationsActive(db)).toBe(true);
    const direct = await singleRun(reviewed(SWAP));
    // A universal bridge run that a workflow run's step owns: its parent's row covers it.
    const child = await singleRun(reviewed(BRIDGE), { flow: 'crosschain-universal' });
    const wfr = await workflowWithStep(child);
    const root = await singleRun({ review: reviewed(SWAP).review, verdict: 'PENDING' }, { status: 'REJECTED' });
    const recovery = await singleRun(reviewed(SWAP), { recoveryOf: root });
    const fee = await singleRun(reviewed(SWAP), { workflowId: 'flofi-fee-settlement.ett-x.1.0' });
    const open = await singleRun(reviewed(SWAP), { status: 'SIMULATED' });
    const reports = await Promise.all([1, 2].map(() => accruePlatformFees(db, 'default', activation, { apply: true, limit: 200 })));
    expect(reports.every(r => r.code === null)).toBe(true);
    expect(await ledger(direct)).toMatchObject({ state: 'DUE', lines: [{ fee: '800000' }] });
    // The recovery's reconciled outcome settles its root's row; the recovery itself has none.
    expect(await ledger(root)).toMatchObject({ state: 'DUE', lines: [{ fee: '800000' }] });
    for (const id of [child, recovery, fee, open]) expect(await ledger(id)).toBeUndefined();
    expect((await db.query('SELECT state FROM platform_fee_ledger WHERE workflow_run_id = $1', [wfr])).rows).toEqual([{ state: 'DUE' }]);
    expect(Number((await db.query(`SELECT count(*)::int AS n FROM platform_fee_ledger WHERE run_id = $1 OR workflow_run_id = $2`, [child, wfr])).rows[0]!.n)).toBe(1);
  });
});

async function workflowWithStep(childRunId: string, step1?: { readonly flow: string; readonly hash: string }): Promise<string> {
  const handoff = 'apr_' + b32(), id = 'wfr_' + b32();
  const strategy = { version: 2, steps: [SWAP, BRIDGE] }, w = compose(strategy);
  await db.query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind, requester_id, requester_context, client_id, client_name, secret_digest, strategy,
      workflow_hash, engine_version, network_environment, funds_class, plan, status, claimed_namespace, claimed_address, claimed_at, claim_expires_at, applied_at,
      run_ids, expires_at, created_at)
    VALUES ('default', $1, 'EDITOR_SESSION', 'editor-x', '{}', 'flofi-editor', 'x', $2, '{}', $3, 'fixture', 'MAINNET', 'REAL_FUNDS', '{"kind":"SEQUENTIAL","flow":null}',
      'APPLIED', 'eip155', $4, $5, $5, $5, '{}', $6, $5)`, [handoff, randomBytes(32), w.workflowHash, OWNER, ago(1), new Date(NOW.getTime() + DAY)]);
  await db.query(`INSERT INTO workflow_runs (tenant_id, run_id, handoff_id, requester_kind, requester_ref, owner_namespace, owner_account, wallets, strategy,
      workflow_hash, engine_version, step_count, mode, state, completed_at, expires_at, created_at, updated_at)
    VALUES ('default', $1, $2, 'EDITOR_SESSION', 'editor-x', 'eip155', $3, jsonb_build_object('eip155', $3::text), $4, $5, 'fixture', 2, 'CONFIRM_EACH_STEP', 'COMPLETED',
      $6, $7, $6, $6)`, [id, handoff, OWNER, JSON.stringify(strategy), w.workflowHash, ago(1), new Date(NOW.getTime() + DAY)]);
  const ETH = 'eip155:1/native:ETH';
  for (const [index, executionId] of [`ett-${tag()}`, childRunId].entries()) await db.query(`INSERT INTO workflow_run_steps (tenant_id, run_id, step_index, state, flow,
      strategy, workflow_hash, outcome) VALUES ('default', $1, $2, 'RECONCILED', $5, '{}', $3, $4)`, [id, index, index && step1 ? step1.hash : w.workflowHash,
    { kind: 'OWNER_RUN', executionId, flow: index ? 'crosschain-universal' : 'ethereum-swap', status: 'RECONCILED', transactions: [],
      evidence: { environment: 'PUBLIC_MAINNET', outcome: 'RECONCILED', bundleHash: null }, spent: [], received: index ? [] : [{ asset: ETH, amount: '40000000000000000' }],
      observedAt: ago(1).toISOString() }, index && step1 ? step1.flow : 'ethereum-swap']);
  // The workflow's authorized basis: one fee for the swap's principal; the bridge spends what the swap delivered.
  expect(workflowFeeBasis(w).lines).toEqual([{ ...USDC, principal: '100000000', fee: '800000' }]);
  return id;
}

describe('fee authorization (§3.5)', () => {
  it('is recorded once per execution, first record wins, and is immutable', async () => {
    const record = reviewed(SWAP), runId = await singleRun(record, { status: 'AUTHORIZED' });
    expect(await authorize(runId, record)).toBe('RECORDED');
    expect(await recordFeeAuthorization(db, 'default', { runId }, singleFlowFeeBasis(reviewed({ ...SWAP, amount: '999' }), { final: false }),
      semanticWorkflowHash(record.review.workflow as never))).toBe('EXISTS');
    expect((await loadFeeAuthorization(db, 'default', { runId }))?.lines).toEqual([{ ...USDC, principal: '100000000', fee: '800000' }]);
    await expect(db.query(`UPDATE platform_fee_authorizations SET rate_bps = 1 WHERE run_id = $1`, [runId])).rejects.toThrow(/PLATFORM_FEE_AUTHORIZATION_IMMUTABLE/);
  });
});

describe('fee collection (§3.1/§3.6/§3.7)', () => {
  async function due(strategy: unknown = SWAP) {
    const record = reviewed(strategy), runId = await singleRun(record);
    await authorize(runId, record);
    await accruePlatformFees(db, 'default', activation, { apply: true, limit: 200 });
    expect((await ledger(runId))?.state).toBe('DUE');
    return runId;
  }

  it('refuses while collection is not active or without a recorded authorization: never charged', async () => {
    const flows = transferFlows(), runId = await due();
    expect(await startSettlement(db, { env: { ...ENV, FLOFI_PLATFORM_FEE_COLLECTION: 'off' }, ...flows }, 'default', { runId }, owner))
      .toEqual({ ok: false, code: 'PLATFORM_FEE_COLLECTION_DISABLED' });
    const unauthorized = await singleRun(reviewed(SWAP));
    await accruePlatformFees(db, 'default', activation, { apply: true, limit: 200 });
    expect(await startSettlement(db, { env: ENV, ...flows }, 'default', { runId: unauthorized }, owner)).toEqual({ ok: false, code: 'PLATFORM_FEE_AUTHORIZATION_MISSING' });
    expect(flows.calls).toEqual([]);
  });

  it('one attempt under concurrent requests; collected only from the reconciled transfer to the treasury', async () => {
    const flows = transferFlows(), runId = await due();
    const results = await Promise.all([1, 2, 3].map(() => startSettlement(db, { env: ENV, ...flows }, 'default', { runId }, owner)));
    expect(results.every(r => r.ok && r.state === 'COLLECTION_PENDING')).toBe(true);
    const row = await ledger(runId), transfers = row!.collection!.transfers as { runId: string; amount: string; recipient: string }[];
    expect(row!.state).toBe('COLLECTION_PENDING');
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ amount: '800000', recipient: TREASURY_EVM.toLowerCase() });
    // Losers' transfers were invalidated: only the recorded one can ever be signed.
    const live = [...flows.records.values()].filter(r => r.authorization !== null);
    expect(live.map(r => r.id)).toEqual([transfers[0]!.runId]);
    // Signed, not yet reconciled; then an unknown outcome: the attempt stays pending, even past the unsigned timeout.
    flows.settle(transfers[0]!.runId, 'SIGNED');
    const later = { env: ENV, load: flows.load, invalidate: flows.call, now: () => new Date(Date.now() + SETTLEMENT_UNSIGNED_TTL_MS * 4) };
    expect(await reconcileSettlements(db, later, 'default')).toMatchObject({ pending: 1, collected: 0 });
    flows.settle(transfers[0]!.runId, 'UNKNOWN');
    expect(await reconcileSettlements(db, later, 'default')).toMatchObject({ pending: 1, collected: 0 });
    expect(await startSettlement(db, { env: ENV, ...flows }, 'default', { runId }, owner)).toMatchObject({ ok: true, state: 'COLLECTION_PENDING' });
    const hash = flows.settle(transfers[0]!.runId, 'RECONCILED');
    expect(await reconcileSettlements(db, later, 'default')).toMatchObject({ collected: 1 });
    expect(await ledger(runId)).toMatchObject({ state: 'COLLECTED', collection: { transactions: [{ amount: '800000', hash, runId: transfers[0]!.runId }] } });
    // Repeated passes and requests change nothing and never open another transfer.
    expect(await reconcileSettlements(db, later, 'default')).toMatchObject({ collected: 0 });
    expect(await startSettlement(db, { env: ENV, ...flows }, 'default', { runId }, owner)).toEqual({ ok: true, state: 'COLLECTED', transfers: [] });
    // Each concurrent request that found the row still DUE composed a transfer (the others returned the open attempt); none of the extra ones can be signed.
    expect(flows.calls.filter(c => c.endsWith('.simulate')).length).toBeLessThanOrEqual(3);
  });

  it('a rejected or abandoned attempt fails without charging and can be retried once its transfer can no longer be signed', async () => {
    const flows = transferFlows(), runId = await due();
    const first = await startSettlement(db, { env: ENV, ...flows }, 'default', { runId }, owner);
    if (!first.ok) throw new Error(first.code);
    flows.settle(first.transfers[0]!.runId, 'REJECTED');
    const deps = { env: ENV, load: flows.load, invalidate: flows.call };
    expect(await reconcileSettlements(db, deps, 'default')).toMatchObject({ failed: 1 });
    expect(await ledger(runId)).toMatchObject({ state: 'COLLECTION_FAILED', collection: { code: 'PLATFORM_FEE_SETTLEMENT_REJECTED', transactions: [] } });
    // Retry: a new attempt; the owner closes the browser without signing; after the timeout it is invalidated first, then failed.
    const second = await startSettlement(db, { env: ENV, ...flows }, 'default', { runId }, owner);
    if (!second.ok) throw new Error(second.code);
    expect((await ledger(runId))!.collection).toMatchObject({ attempt: 2 });
    expect(await reconcileSettlements(db, deps, 'default')).toMatchObject({ pending: 1 });
    expect(await reconcileSettlements(db, { ...deps, now: () => new Date(Date.now() + SETTLEMENT_UNSIGNED_TTL_MS + 60_000) }, 'default')).toMatchObject({ failed: 1 });
    expect(flows.records.get(second.transfers[0]!.runId)).toMatchObject({ authorization: null, attempt: null });
    expect(await ledger(runId)).toMatchObject({ state: 'COLLECTION_FAILED', collection: { code: 'PLATFORM_FEE_SETTLEMENT_UNSIGNED_EXPIRED' } });
    const third = await startSettlement(db, { env: ENV, ...flows }, 'default', { runId }, owner);
    if (!third.ok) throw new Error(third.code);
    flows.settle(third.transfers[0]!.runId, 'RECONCILED');
    expect(await reconcileSettlements(db, deps, 'default')).toMatchObject({ collected: 1 });
    expect(((await ledger(runId))!.collection!.transactions as unknown[])).toHaveLength(1);
  });

  it('a divergent transfer stops automatic retries; Admin collected revenue sums transactions only', async () => {
    const flows = transferFlows(), runId = await due();
    const started = await startSettlement(db, { env: ENV, ...flows }, 'default', { runId }, owner);
    if (!started.ok) throw new Error(started.code);
    flows.settle(started.transfers[0]!.runId, 'DIVERGENT');
    await reconcileSettlements(db, { env: ENV, load: flows.load, invalidate: flows.call }, 'default');
    expect(await ledger(runId)).toMatchObject({ state: 'COLLECTION_FAILED', collection: { attention: true, code: 'PLATFORM_FEE_SETTLEMENT_DIVERGENT' } });
    expect(await startSettlement(db, { env: ENV, ...flows }, 'default', { runId }, owner)).toEqual({ ok: false, code: 'PLATFORM_FEE_SETTLEMENT_ATTENTION' });
    const totals = await loadFeeTotals(db, 'default', { from: ago(30), to: new Date(NOW.getTime() + DAY) }, 'MAINNET');
    const collected = totals.collectedByAsset.find(a => a.chainId === USDC.chainId && a.address === USDC.address);
    // Two executions were collected above (0.80 USDC each); the accrued DUE estimate of the others is never in this figure.
    expect(collected?.fee).toBe('1600000');
    expect(totals.byState.COLLECTED).toBe(2);
  });

  it('a workflow step run not linked yet is never charged as a single flow; nothing authorized before activation is collected', async () => {
    const flows = transferFlows(), record = reviewed(SWAP), runId = await due(SWAP);
    const hash = semanticWorkflowHash(record.review.workflow as never);
    // A step whose own run is this one, matched as the workflow observes it (same flow and reviewed workflow hash), linked to another id so far.
    await workflowWithStep(`ett-${tag()}`, { flow: 'ethereum-swap', hash });
    expect(await startSettlement(db, { env: ENV, ...flows }, 'default', { runId }, owner)).toEqual({ ok: false, code: 'PLATFORM_FEE_COVERED_BY_WORKFLOW' });
    const later = { ...ENV, FLOFI_PLATFORM_FEE_ACCOUNTING_FROM: new Date(Date.now() + 60_000).toISOString() };
    expect(await startSettlement(db, { env: later, ...flows }, 'default', { runId }, owner)).toEqual({ ok: false, code: 'PLATFORM_FEE_ACCOUNTING_NOT_STARTED' });
  });

  it('refuses another wallet, a test network row and a request for an execution without a ledger row', async () => {
    // Another reviewed workflow than the step's above (an identical workflow of the same owner created after that step would be covered by it).
    const flows = transferFlows(), runId = await due({ ...SWAP, amount: '101' });
    expect(await startSettlement(db, { env: ENV, ...flows }, 'default', { runId }, { namespace: 'solana', account: TREASURY_SOLANA }))
      .toEqual({ ok: false, code: 'PLATFORM_FEE_SETTLEMENT_OTHER_WALLET' });
    expect(await startSettlement(db, { env: ENV, ...flows }, 'default', { runId: 'ett-' + 'e'.repeat(32) }, owner)).toEqual({ ok: false, code: 'PLATFORM_FEE_NOT_DUE' });
  });
});
