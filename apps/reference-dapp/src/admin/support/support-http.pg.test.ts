// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: the Support & Recovery API and its reads on a disposable loopback database, exactly as served
 * (`handleSupport`), with real admin sign-in sessions. Covers discovery from persisted rows, incomplete telemetry, tenant isolation, VIEWER and
 * CSRF refusals, idempotent and concurrent recoveries, stale previews, a worker already processing, pending confirmations, finalized
 * executions, non-retryable stops, the retry limit, verification, audit completeness, redaction and query bounds.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createTestWallet } from '../../../../../packages/reference-reconciler/test/test-wallet.ts';
import { runAdminCommand } from '../cli-commands.ts';
import { adminConfig } from '../config.ts';
import { handleAdminChallenge, handleAdminSignIn, type AdminHttpOptions } from '../http.ts';
import { adminCsrfToken, readAdminSession } from '../session.ts';
import { supportSearch } from './diagnostics.ts';
import { periodFingerprinter, type Fingerprinter } from './privacy.ts';
import { discoverIncidents, LIMITS } from './incidents.ts';
import { ATTENTION_LIMIT } from './lifecycle.ts';
import { executeRecovery, previewRecovery, recoveryHistory } from './recovery.ts';
import { RETRY_LIMIT } from './registry.ts';
import { handleSupport } from './support-http.ts';
import { incidentDetail, supportView, supportFilters } from './view.ts';
import { healthReport } from '../health.ts';
import { healthAttention } from '../attention.ts';
import { workflowView } from '../analytics/view.ts';
import { loadExecutionAttention } from './lifecycle.ts';

const ORIGIN = 'https://admin.flofi.example', DOMAIN = 'admin.flofi.example';
const adminEnv = { FLOFI_ADMIN: 'enabled', FLOFI_ADMIN_SESSION_SECRET: randomBytes(32).toString('hex') };
const key = (() => { const c = adminConfig(adminEnv); if (!c.enabled) throw new Error(c.code); return c.key; })();
// BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001: lookups are fingerprinted under the current quarter's key (created on first use).
const fingerprinter: Fingerprinter = value => periodFingerprinter(t.db, 'default', key, () => new Date())(value);
let t: TestDatabase;
const options = (): AdminHttpOptions => ({ env: adminEnv, host: { db: t.db, tenantId: 'default' }, now: () => new Date() });
const host = () => ({ db: t.db, tenantId: 'default' });
type Session = { cookie: string; csrf: string; principalId: string };
/** The response fields these tests read (the API returns closed JSON objects). */
type Body = { ok: boolean; code?: string; reason?: string | null; canExecute?: boolean; operationId: string; workItemId: string; replayed?: boolean;
  attentionCleared?: boolean; verification?: { status: string }; preview: { stateToken: string; eligibility: Record<string, unknown> } };
async function adminSession(role: 'VIEWER' | 'OPERATOR'): Promise<Session> {
  const wallet = createTestWallet();
  await runAdminCommand('grant', { wallet: wallet.address, role }, t.db, 'default');
  const headers = (cookie = '') => ({ host: DOMAIN, 'x-forwarded-proto': 'https', origin: ORIGIN, 'content-type': 'application/json', cookie });
  const challenge = await handleAdminChallenge(new Request(`${ORIGIN}/admin/api/session/challenge`, { method: 'POST', headers: headers(),
    body: JSON.stringify({ address: wallet.address, chainId: 1 }) }), options());
  const challengeCookie = challenge.headers.getSetCookie()[0]!.split(';')[0]!, { message } = await challenge.json() as { message: string };
  const signedIn = await handleAdminSignIn(new Request(`${ORIGIN}/admin/api/session`, { method: 'POST', headers: headers(challengeCookie),
    body: JSON.stringify({ address: wallet.address, chainId: 1, signature: wallet.signMessage(message) }) }), options());
  const cookie = signedIn.headers.getSetCookie().map(c => c.split(';')[0]!).find(c => c.startsWith('flofi_admin_session='))!;
  const reference = readAdminSession(key, cookie.slice('flofi_admin_session='.length), new Date(), DOMAIN)!;
  return { cookie, csrf: adminCsrfToken(key, reference.sessionId), principalId: reference.principalId };
}
async function call(session: Session, body: Record<string, unknown>, extra: { csrf?: string | null; origin?: string } = {}) {
  const headers: Record<string, string> = { host: DOMAIN, 'x-forwarded-proto': 'https', origin: extra.origin ?? ORIGIN, 'content-type': 'application/json', cookie: session.cookie };
  const csrf = extra.csrf === undefined ? session.csrf : extra.csrf;
  if (csrf !== null) headers['x-flofi-admin-csrf'] = csrf;
  const response = await handleSupport(new Request(`${ORIGIN}/admin/api/support`, { method: 'POST', headers, body: JSON.stringify(body) }), options());
  return { status: response.status, body: await response.json() as Body };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
type Seed = { runId: string; flow?: string; status?: string; tenant?: string; needsObservation?: boolean; attention?: boolean; hasEvidence?: boolean; owner?: string;
  workflowId?: string; updatedAt?: Date; attempts?: { state: string; hash?: string | null; reconciled?: boolean }[];
  work?: { kind: string; state: 'READY' | 'LEASED' | 'DONE' | 'DEAD'; lastError?: string }[]; provenance?: string; errorCode?: string | null; evidenceArchived?: boolean };
async function seed(run: Seed) {
  const tenant = run.tenant ?? 'default', flow = run.flow ?? 'base-swap', name = `${run.runId}.jsonl`, workflowId = run.workflowId ?? `wf-${run.runId}`, bytes = Buffer.from('{}\n');
  await t.db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [tenant, workflowId]);
  await t.db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256) VALUES ($1, $2, $3, 'RUN', 1, 1, $4, $5)`,
    [tenant, flow, name, bytes.length, sha('{}\n')]);
  const updated = run.updatedAt ?? new Date(Date.now() - 2 * 3_600_000);
  await t.db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, owner_account, needs_observation, attention_required,
      has_evidence, log_version, created_at, updated_at, error_code) VALUES ($1, $2, $3, $4, $5, $3, $6, $12, $7, $8, $9, $10, 1, $11, $11, $13)`,
  [tenant, run.runId, flow, name, workflowId, run.status ?? 'SUBMISSION_RESULT_UNKNOWN', run.owner ?? null, run.needsObservation ?? true, run.attention ?? true,
    run.hasEvidence ?? false, updated, run.provenance ?? 'PUBLIC_TESTNET', run.errorCode ?? null]);
  for (const [i, attempt] of (run.attempts ?? [{ state: 'SUBMISSION_RESULT_UNKNOWN' }]).entries())
    await t.db.query(`INSERT INTO execution_attempts (tenant_id, attempt_id, run_id, step, state, transaction_hash, reconciled) VALUES ($1, $2, $3, 'SWAP', $4, $5, $6)`,
      [tenant, `${run.runId}.${i}`, run.runId, attempt.state, attempt.hash ?? null, attempt.reconciled ?? false]);
  if (run.evidenceArchived) await t.db.query(`INSERT INTO evidence_objects (tenant_id, run_id, bundle_hash, content_sha256, byte_length, media_type, store_id, object_key, environment, outcome)
    VALUES ($1, $2, $3, $4, 10, 'application/json', 'test-store', $5, 'TESTNET_EXECUTED', 'RECONCILED')`, [tenant, run.runId, `0x${sha(`bundle:${run.runId}`)}`, sha(run.runId),
    `evidence/${run.runId}.json`]);
  for (const item of run.work ?? [{ kind: 'reconcile', state: 'DEAD', lastError: 'OBSERVATION_BUDGET_EXHAUSTED' }]) {
    const done = item.state === 'DONE' || item.state === 'DEAD', leased = item.state === 'LEASED';
    await t.db.query(`INSERT INTO work_items (tenant_id, kind, dedupe_key, run_id, payload, state, deliveries, last_error, completed_at, lease_owner, lease_token, lease_expires_at)
      VALUES ($1, $2, $3 || ':' || $4, $4, jsonb_build_object('namespace', $3::text, 'runId', $4::text), $5, 500, $6, $7, $8, $9, $10)`,
    [tenant, item.kind, flow, run.runId, item.state, item.lastError ?? null, done ? new Date() : null, leased ? 'worker-x' : null, leased ? randomUUID() : null,
      leased ? new Date(Date.now() + 60_000) : null]);
  }
}
const preview = (s: Session, runId: string, recovery = 'execution.resume-observation') => call(s, { action: 'preview', recovery, runId });
const recover = (s: Session, runId: string, stateToken: string, over: Record<string, unknown> = {}) => call(s, { action: 'recover', recovery: 'execution.resume-observation', runId,
  stateToken, idempotencyKey: randomUUID(), reason: 'Provider outage resolved', ...over });
const openItems = async (runId: string) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM work_items WHERE run_id = $1 AND state IN ('READY', 'LEASED')`, [runId])).rows[0]!.n;
const audits = async (kind: string) => (await t.db.query<{ outcome: string; code: string | null; actor: string; target: string | null; detail: Record<string, unknown> | null }>(
  `SELECT outcome, code, actor, target, detail FROM admin_audit_events WHERE kind = $1 ORDER BY event_id`, [kind])).rows;

let operator: Session, viewer: Session;
beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.query(`INSERT INTO tenants (tenant_id) VALUES ('other')`);
  [operator, viewer] = [await adminSession('OPERATOR'), await adminSession('VIEWER')];
});
afterAll(async () => { await t?.drop(); });

describe('discovery and diagnostics from persisted data', () => {
  it('derives incidents from real rows, isolates tenants and reports incomplete telemetry honestly', async () => {
    await seed({ runId: 'sup-discover-1' });
    await seed({ runId: 'sup-other-tenant', tenant: 'other' });
    await seed({ runId: 'sup-healthy', attention: false, work: [{ kind: 'reconcile', state: 'READY' }], updatedAt: new Date() });
    const { incidents, sources } = await discoverIncidents(t.db, 'default', new Date());
    expect(sources.every(source => source.ok)).toBe(true);
    expect(incidents.find(i => i.id === 'run:sup-discover-1')).toMatchObject({ kind: 'OBSERVATION_STOPPED', eligibility: 'RECOVERABLE_NOW', outcomeKnown: false });
    expect(incidents.some(i => i.id === 'run:sup-other-tenant')).toBe(false);
    expect(incidents.some(i => i.id === 'run:sup-healthy')).toBe(false);
    // No journal at all: earlier steps are only inferred from the attempt, never shown as observed; the submission stays unknown.
    const detail = await incidentDetail({}, host(), new Date(), 'run:sup-discover-1');
    expect(detail.type).toBe('run');
    if (detail.type !== 'run') return;
    expect(Object.fromEntries(detail.milestones.map(m => [m.key, m.evidence]))).toMatchObject({ created: 'OBSERVED', validated: 'INFERRED', submitted: 'UNKNOWN', result: 'UNKNOWN', final: 'UNKNOWN' });
    // Another tenant's run cannot be previewed or recovered from this deployment.
    expect((await preview(operator, 'sup-other-tenant')).body).toEqual({ ok: false, code: 'SUPPORT_RUN_NOT_FOUND' });
  });

  it('a stopped delegated task is listed but never offered a retry', async () => {
    await t.db.query(`INSERT INTO work_items (tenant_id, kind, dedupe_key, payload, state, deliveries, last_error, completed_at)
      VALUES ('default', 'delegation.execute', 'occ-1', '{}', 'DEAD', 500, 'OBSERVATION_BUDGET_EXHAUSTED', now())`);
    const incident = (await discoverIncidents(t.db, 'default', new Date())).incidents.find(i => i.kind === 'TASK_STOPPED' && i.component === 'delegation.execute');
    expect(incident).toMatchObject({ actions: [], severity: 'HIGH' });
  });
});

describe('authorization and request integrity', () => {
  it('a VIEWER can preview but never recover or write notes; refusals are audited', async () => {
    await seed({ runId: 'sup-viewer' });
    const p = await preview(viewer, 'sup-viewer');
    expect(p.body).toMatchObject({ ok: true, canExecute: false, preview: { eligibility: { eligible: true } } });
    expect(await recover(viewer, 'sup-viewer', p.body.preview.stateToken)).toEqual({ status: 403, body: { ok: false, code: 'ADMIN_ROLE_INSUFFICIENT' } });
    expect((await call(viewer, { action: 'note', incidentId: 'run:sup-viewer', kind: 'FINDING', text: 'looked at it' })).status).toBe(403);
    expect(await openItems('sup-viewer')).toBe(0);
    expect((await audits('ADMIN_PERMISSION_DENIED')).some(a => a.actor === viewer.principalId && a.target === 'support:recover')).toBe(true);
  });
  it('refuses a missing CSRF token or a foreign origin before anything else', async () => {
    await seed({ runId: 'sup-csrf-2' });
    const token2 = (await preview(operator, 'sup-csrf-2')).body.preview.stateToken;
    expect((await call(operator, { action: 'recover', recovery: 'execution.resume-observation', runId: 'sup-csrf-2', stateToken: token2, idempotencyKey: randomUUID(), reason: 'x y z' },
      { csrf: null })).body).toEqual({ ok: false, code: 'ADMIN_CSRF_INVALID' });
    expect((await call(operator, { action: 'recover', recovery: 'execution.resume-observation', runId: 'sup-csrf-2', stateToken: token2, idempotencyKey: randomUUID(), reason: 'x y z' },
      { origin: 'https://evil.example' })).body).toEqual({ ok: false, code: 'ADMIN_ORIGIN_INVALID' });
    expect(await openItems('sup-csrf-2')).toBe(0);
  });
  it('refuses unregistered actions, malformed requests and a missing reason', async () => {
    await seed({ runId: 'sup-shape' });
    const token = (await preview(operator, 'sup-shape')).body.preview.stateToken;
    expect((await call(operator, { action: 'recover', recovery: 'delegation.execute', runId: 'sup-shape', stateToken: token, idempotencyKey: randomUUID(), reason: 'abc' })).body)
      .toEqual({ ok: false, code: 'ADMIN_REQUEST_INVALID' });
    expect((await call(operator, { action: 'retry', kind: 'reconcile', runId: 'sup-shape' })).body).toEqual({ ok: false, code: 'ADMIN_REQUEST_INVALID' });
    expect((await recover(operator, 'sup-shape', token, { reason: '' })).body).toEqual({ ok: false, code: 'SUPPORT_REASON_REQUIRED' });
    expect((await recover(operator, 'sup-shape', token, { reason: '<b>x</b>' })).body).toEqual({ ok: false, code: 'SUPPORT_REASON_REQUIRED' });
    expect((await recover(operator, 'sup-shape', token, { reason: 'bidi \u202e text' })).body).toEqual({ ok: false, code: 'SUPPORT_REASON_REQUIRED' });
    // Unregistered names are never copied into the audit record.
    expect((await audits('SUPPORT_RECOVERY')).filter(a => a.detail?.runId === 'sup-shape').map(a => a.detail?.action)).toContain('UNREGISTERED');
    expect(await openItems('sup-shape')).toBe(0);
  });
});

describe('atomic, idempotent and verified recovery', () => {
  it('recovers once, audits every fact, and replays the same request without repeating it', async () => {
    await seed({ runId: 'sup-idem' });
    const token = (await preview(operator, 'sup-idem')).body.preview.stateToken, idempotencyKey = randomUUID();
    const first = await recover(operator, 'sup-idem', token, { idempotencyKey });
    expect(first.body).toMatchObject({ ok: true, replayed: false, attentionCleared: true, verification: { status: 'PENDING_VERIFICATION', taskState: 'READY' } });
    expect(first.body.operationId).toMatch(/^rop_[a-z2-7]{26}$/);
    const second = await recover(operator, 'sup-idem', token, { idempotencyKey });
    expect(second.body).toMatchObject({ ok: true, replayed: true, operationId: first.body.operationId, workItemId: first.body.workItemId });
    expect(await openItems('sup-idem')).toBe(1);
    const item = (await t.db.query(`SELECT kind, dedupe_key, payload FROM work_items WHERE id = $1`, [first.body.workItemId])).rows[0];
    expect(item).toEqual({ kind: 'reconcile', dedupe_key: 'base-swap:sup-idem', payload: { namespace: 'base-swap', runId: 'sup-idem' } }); // the original identity
    expect((await t.db.query(`SELECT attention_required FROM execution_runs WHERE run_id = 'sup-idem'`)).rows[0]).toEqual({ attention_required: false });
    const ok = (await audits('SUPPORT_RECOVERY')).filter(a => a.outcome === 'OK' && a.detail?.runId === 'sup-idem');
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ actor: operator.principalId, target: 'run:sup-idem', detail: { operationId: first.body.operationId, action: 'execution.resume-observation',
      runId: 'sup-idem', idempotencyKey, workItemId: first.body.workItemId, workKind: 'reconcile', attentionCleared: true, eligibility: 'ELIGIBLE',
      precondition: 'DEAD:OBSERVATION_BUDGET_EXHAUSTED', runStatus: 'SUBMISSION_RESULT_UNKNOWN' } });
    // BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001: the reason is no longer copied into the append-only skeleton; it is referenced and digested,
    // and lives in the separately governed text store (written in the same transaction).
    expect(ok[0]!.detail).not.toHaveProperty('reason');
    expect(ok[0]!.detail).toMatchObject({ reasonRef: expect.stringMatching(/^stx_[a-z2-7]{26}$/), reasonDigest: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(JSON.stringify(ok[0])).not.toContain('Provider outage resolved');
    expect((await t.db.query(`SELECT purpose, body, run_id FROM admin_support_texts WHERE text_id = $1`, [ok[0]!.detail!.reasonRef])).rows[0])
      .toEqual({ purpose: 'RECOVERY_REASON', body: 'Provider outage resolved', run_id: 'sup-idem' });
    // A reused key for a different execution is refused, not replayed.
    await seed({ runId: 'sup-idem-b' });
    const tokenB = (await preview(operator, 'sup-idem-b')).body.preview.stateToken;
    expect((await recover(operator, 'sup-idem-b', tokenB, { idempotencyKey })).body).toMatchObject({ ok: false, code: 'SUPPORT_IDEMPOTENCY_KEY_REUSED' });
  });
  it('concurrent requests for the same execution queue exactly one task', async () => {
    await seed({ runId: 'sup-race' });
    const token = (await preview(operator, 'sup-race')).body.preview.stateToken;
    const results = await Promise.all(Array.from({ length: 6 }, () => recover(operator, 'sup-race', token)));
    expect(results.filter(r => r.body.ok)).toHaveLength(1);
    expect(results.filter(r => !r.body.ok).every(r => ['SUPPORT_PREVIEW_STALE', 'SUPPORT_ALREADY_SCHEDULED'].includes(r.body.code ?? ''))).toBe(true);
    expect(await openItems('sup-race')).toBe(1);
  });
  it('refuses a stale preview when the execution changed in between', async () => {
    await seed({ runId: 'sup-stale' });
    const token = (await preview(operator, 'sup-stale')).body.preview.stateToken;
    await t.db.query(`UPDATE execution_runs SET log_version = 2, status = 'PENDING' WHERE run_id = 'sup-stale'`); // a new snapshot landed
    expect((await recover(operator, 'sup-stale', token)).body).toMatchObject({ ok: false, code: 'SUPPORT_PREVIEW_STALE' });
    expect(await openItems('sup-stale')).toBe(0);
    expect((await audits('SUPPORT_RECOVERY')).some(a => a.outcome === 'REFUSED' && a.code === 'SUPPORT_PREVIEW_STALE' && a.detail?.runId === 'sup-stale')).toBe(true);
  });
  it('waits while a worker is already processing, or while a check is still pending', async () => {
    await seed({ runId: 'sup-leased', work: [{ kind: 'reconcile', state: 'LEASED' }] });
    expect((await preview(operator, 'sup-leased')).body.preview.eligibility).toMatchObject({ eligible: false, state: 'WAITING_EXTERNAL', code: 'SUPPORT_ALREADY_SCHEDULED' });
    await seed({ runId: 'sup-pending', attention: false, attempts: [{ state: 'PENDING', hash: `0x${'2'.repeat(64)}` }], work: [{ kind: 'reconcile', state: 'READY' }] });
    const p = (await preview(operator, 'sup-pending')).body.preview;
    expect(p.eligibility).toMatchObject({ eligible: false, code: 'SUPPORT_ALREADY_SCHEDULED' });
    expect((await recover(operator, 'sup-pending', p.stateToken)).body).toMatchObject({ ok: false, code: 'SUPPORT_ALREADY_SCHEDULED' });
    expect(await openItems('sup-pending')).toBe(1);
  });
  it('never acts on a finalized execution or a permanently stopped task', async () => {
    await seed({ runId: 'sup-final', status: 'RECONCILED', needsObservation: false, attention: true, attempts: [{ state: 'CONFIRMED', hash: `0x${'3'.repeat(64)}` }] });
    expect((await preview(operator, 'sup-final')).body.preview.eligibility).toMatchObject({ eligible: false, state: 'NONE', code: 'SUPPORT_NOTHING_TO_RECOVER' });
    await seed({ runId: 'sup-corrupt', work: [{ kind: 'reconcile', state: 'DEAD', lastError: 'BASE_SWAP_STATE_CORRUPT' }] });
    const p = (await preview(operator, 'sup-corrupt')).body.preview;
    expect(p.eligibility).toMatchObject({ eligible: false, state: 'ENGINEERING' });
    expect((await recover(operator, 'sup-corrupt', p.stateToken)).body).toMatchObject({ ok: false, code: 'SUPPORT_STOP_REASON_NOT_RETRYABLE' });
  });
  it('never clears a flag its own stopped task did not set', async () => {
    await seed({ runId: 'sup-flag-only', work: [{ kind: 'reconcile', state: 'DONE' }] });
    const p = (await preview(operator, 'sup-flag-only')).body.preview;
    expect(p.eligibility).toMatchObject({ eligible: false, code: 'SUPPORT_CONDITION_NOT_REGISTERED' });
    expect((await recover(operator, 'sup-flag-only', p.stateToken)).body).toMatchObject({ ok: false, code: 'SUPPORT_CONDITION_NOT_REGISTERED' });
    expect((await t.db.query(`SELECT attention_required FROM execution_runs WHERE run_id = 'sup-flag-only'`)).rows[0]).toEqual({ attention_required: true });
  });
  it('a lookup is a POST through the API: OPERATOR finds by execution id, VIEWER cannot look up wallets', async () => {
    expect((await call(operator, { action: 'search', q: 'sup-idem' })).body).toMatchObject({ ok: true, kind: 'EXECUTION_OR_WORKFLOW', hits: [{ id: 'sup-idem' }] });
    expect(await call(viewer, { action: 'search', q: `0x${'cd'.repeat(20)}` })).toEqual({ status: 403, body: { ok: false, code: 'SUPPORT_SEARCH_WALLET_NOT_PERMITTED' } });
    expect((await call(operator, { action: 'search', q: 'free text' })).body).toEqual({ ok: false, code: 'SUPPORT_SEARCH_INVALID' });
  });
  it('a recovery that committed is never reported as failed when its read-back fails', async () => {
    await seed({ runId: 'sup-readback' });
    const p = (await previewRecovery(host(), 'sup-readback', 'execution.resume-observation', new Date()))!;
    // The same database, except that the post-commit verification read fails (a transient connection error).
    const flaky = { ...t.db, query: ((sql: string, values?: readonly unknown[]) => sql.includes('AS item_state,') ? Promise.reject(new Error('CONNECTION_RESET'))
      : t.db.query(sql, values)) as typeof t.db.query, transaction: t.db.transaction.bind(t.db) };
    const result = await executeRecovery({ db: flaky, tenantId: 'default' }, operator.principalId, { runId: 'sup-readback', action: 'execution.resume-observation',
      stateToken: p.stateToken, idempotencyKey: randomUUID(), reason: 'Read-back test' }, new Date());
    expect(result).toMatchObject({ replayed: false, verification: { status: 'INCONCLUSIVE', code: 'SUPPORT_VERIFICATION_UNAVAILABLE' } });
    expect(await openItems('sup-readback')).toBe(1);
    expect((await audits('SUPPORT_RECOVERY')).filter(a => a.detail?.runId === 'sup-readback').map(a => a.outcome)).toEqual(['OK']);
  });
  it('keeps the attention flag while another stopped task still holds it', async () => {
    await seed({ runId: 'sup-two', work: [{ kind: 'reconcile', state: 'DEAD', lastError: 'OBSERVATION_BUDGET_EXHAUSTED' },
      { kind: 'evidence.archive', state: 'DEAD', lastError: 'WORK_PAYLOAD_INVALID' }] });
    const token = (await preview(operator, 'sup-two')).body.preview.stateToken;
    expect((await recover(operator, 'sup-two', token)).body).toMatchObject({ ok: true, attentionCleared: false });
    expect((await t.db.query(`SELECT attention_required FROM execution_runs WHERE run_id = 'sup-two'`)).rows[0]).toEqual({ attention_required: true });
  });
  it('verifies outcomes honestly and enforces the retry limit', async () => {
    await seed({ runId: 'sup-verify' });
    for (let i = 0; i < RETRY_LIMIT; i++) {
      const token = (await preview(operator, 'sup-verify')).body.preview.stateToken;
      const result = await recover(operator, 'sup-verify', token);
      expect(result.body).toMatchObject({ ok: true });
      // The worker gives up again: the recovery did not resolve the problem.
      await t.db.query(`UPDATE work_items SET state = 'DEAD', completed_at = now(), last_error = 'OBSERVATION_BUDGET_EXHAUSTED' WHERE id = $1`, [result.body.workItemId]);
      await t.db.query(`UPDATE execution_runs SET attention_required = true WHERE run_id = 'sup-verify'`);
    }
    const history = await recoveryHistory(host(), new Date(), { runId: 'sup-verify' });
    expect(history.filter(h => h.outcome === 'OK').map(h => h.verification?.status)).toEqual(Array(RETRY_LIMIT).fill('STOPPED_AGAIN'));
    expect((await preview(operator, 'sup-verify')).body.preview.eligibility).toMatchObject({ eligible: false, code: 'SUPPORT_RETRY_LIMIT_REACHED', state: 'ENGINEERING' });
  });
  it('changes nothing but one background task: no attempt, journal or submission is created', async () => {
    await seed({ runId: 'sup-noside' });
    type Counts = { a: number; j: number; w: number; k: string | null };
    const before = await t.db.query<Counts>(`SELECT (SELECT count(*) FROM execution_attempts)::int AS a, (SELECT count(*) FROM journal_entries)::int AS j,
      (SELECT count(*) FROM work_items)::int AS w, (SELECT string_agg(DISTINCT kind, ',') FROM work_items WHERE state = 'READY' AND run_id = 'sup-noside') AS k`);
    const token = (await preview(operator, 'sup-noside')).body.preview.stateToken;
    expect((await recover(operator, 'sup-noside', token)).body.ok).toBe(true);
    const after = await t.db.query<Counts>(`SELECT (SELECT count(*) FROM execution_attempts)::int AS a, (SELECT count(*) FROM journal_entries)::int AS j,
      (SELECT count(*) FROM work_items)::int AS w, (SELECT string_agg(DISTINCT kind, ',') FROM work_items WHERE state = 'READY' AND run_id = 'sup-noside') AS k`);
    expect(after.rows[0]).toEqual({ ...before.rows[0]!, w: before.rows[0]!.w + 1, k: 'reconcile' });
  });
  it('retries evidence archiving under the same rules', async () => {
    await seed({ runId: 'sup-evidence', status: 'RECONCILED', needsObservation: false, hasEvidence: true, attempts: [{ state: 'CONFIRMED', hash: `0x${'4'.repeat(64)}` }],
      work: [{ kind: 'evidence.archive', state: 'DEAD', lastError: 'OBSERVATION_BUDGET_EXHAUSTED' }] });
    const p = (await preview(operator, 'sup-evidence', 'execution.retry-evidence-archive')).body.preview;
    expect(p.eligibility).toEqual({ eligible: true });
    const result = await call(operator, { action: 'recover', recovery: 'execution.retry-evidence-archive', runId: 'sup-evidence', stateToken: p.stateToken,
      idempotencyKey: randomUUID(), reason: 'Evidence store fixed' });
    expect(result.body).toMatchObject({ ok: true, attentionCleared: true, verification: { status: 'PENDING_VERIFICATION' } });
    expect((await t.db.query(`SELECT kind FROM work_items WHERE id = $1`, [result.body.workItemId])).rows[0]).toEqual({ kind: 'evidence.archive' });
  });
});

describe('search, notes, redaction and bounds', () => {
  it('audits searches by type and fingerprint only, restricts wallet lookups and never returns full addresses', async () => {
    const wallet = `0x${'ab'.repeat(20)}`;
    await seed({ runId: 'sup-wallet', owner: wallet, attention: false, work: [] });
    expect(await supportSearch(host(), { principalId: viewer.principalId, role: 'VIEWER' }, wallet, new Date(), fingerprinter)).toEqual({ ok: false, code: 'SUPPORT_SEARCH_WALLET_NOT_PERMITTED' });
    const found = await supportSearch(host(), { principalId: operator.principalId, role: 'OPERATOR' }, wallet.toUpperCase().replace('0X', '0x'), new Date(), fingerprinter);
    expect(found).toMatchObject({ ok: true, kind: 'WALLET', hits: [{ type: 'run', id: 'sup-wallet' }] });
    expect(JSON.stringify(found)).not.toContain(wallet.slice(2));
    const searches = await audits('SUPPORT_SEARCH');
    expect(JSON.stringify(searches)).not.toContain(wallet.slice(2));
    expect(searches.at(-1)).toMatchObject({ outcome: 'OK', detail: { type: 'WALLET', results: 1 } });
    expect(searches.at(-1)!.detail!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(await supportSearch(host(), { principalId: operator.principalId, role: 'OPERATOR' }, 'free text query', new Date(), fingerprinter)).toEqual({ ok: false, code: 'SUPPORT_SEARCH_INVALID' });
  });
  it('bounds lookups and incident sources', async () => {
    for (let i = 0; i < 30; i++) await seed({ runId: `sup-bound-${i}`, workflowId: 'wf-bounded', attention: false, needsObservation: false, status: 'SIMULATED', attempts: [], work: [] });
    const result = await supportSearch(host(), { principalId: operator.principalId, role: 'OPERATOR' }, 'wf-bounded', new Date(), fingerprinter);
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.ok && result.hits.length).toBe(25);
    expect(ATTENTION_LIMIT + LIMITS.recent).toBeLessThanOrEqual(1000);
  });
  it('stores bounded plain-text notes for OPERATORs only', async () => {
    expect((await call(operator, { action: 'note', incidentId: 'run:sup-idem', kind: 'ESCALATION', text: 'Escalated: provider bug' })).body).toEqual({ ok: true });
    expect((await call(operator, { action: 'note', incidentId: 'run:sup-idem', kind: 'FINDING', text: '<img src=x onerror=alert(1)>' })).body).toEqual({ ok: false, code: 'SUPPORT_NOTE_INVALID' });
    expect((await call(operator, { action: 'note', incidentId: 'DROP TABLE', kind: 'FINDING', text: 'valid text' })).body).toEqual({ ok: false, code: 'ADMIN_REQUEST_INVALID' });
    // BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001: the skeleton keeps a reference and a digest; the text is in the governed store (same transaction).
    const notes = (await audits('SUPPORT_NOTE')).map(a => a.detail);
    expect(notes).toEqual([{ incidentId: 'run:sup-idem', noteKind: 'ESCALATION', textRef: expect.stringMatching(/^stx_[a-z2-7]{26}$/),
      textDigest: expect.stringMatching(/^[0-9a-f]{32}$/) }]);
    expect(JSON.stringify(notes)).not.toContain('provider bug');
    expect((await t.db.query(`SELECT purpose, body, run_id, incident_id FROM admin_support_texts WHERE text_id = $1`, [notes[0]!.textRef])).rows)
      .toEqual([{ purpose: 'SUPPORT_NOTE', body: 'Escalated: provider bug', run_id: 'sup-idem', incident_id: 'run:sup-idem' }]);
  });
});

describe('BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001 addendum: one attention model across the Admin', () => {
  const hash = (seedText: string) => `0x${sha(seedText)}`;
  const reconciled = (id: string) => [{ state: 'CONFIRMED', hash: hash(id), reconciled: true }];
  /** The 2026-11-14 production distribution (12 flagged runs), as database rows; each run's stopped-task history is part of the fixture. */
  async function seedProductionShape(tenant: string) {
    for (let i = 0; i < 6; i++) await seed({ tenant, runId: `lc-tn-${i}`, flow: 'base-sepolia-swap', status: 'RECONCILED', needsObservation: false, hasEvidence: true,
      evidenceArchived: true, attempts: reconciled(`tn${i}`) });
    await seed({ tenant, runId: 'lc-dv-0', flow: 'solana-devnet-swap', status: 'RECONCILED', provenance: 'PUBLIC_DEVNET', needsObservation: false, hasEvidence: true,
      evidenceArchived: true, attempts: reconciled('dv0') });
    await seed({ tenant, runId: 'lc-dv-1', flow: 'orca-liquidity', status: 'RECONCILED', provenance: 'PUBLIC_DEVNET', needsObservation: false, hasEvidence: false,
      attempts: reconciled('dv1') });
    await seed({ tenant, runId: 'lc-dv-2', flow: 'solana-devnet-composition', status: 'COMPLETED', provenance: 'PUBLIC_DEVNET', needsObservation: false, hasEvidence: true,
      attempts: reconciled('dv2'), work: [{ kind: 'evidence.archive', state: 'DEAD', lastError: 'OBSERVATION_BUDGET_EXHAUSTED' }] });
    await seed({ tenant, runId: 'lc-jup', flow: 'jupiter-swap', status: 'RECONCILED', provenance: 'PUBLIC_MAINNET', errorCode: 'JUPITER_SEMANTIC_EDIT_REQUIRES_REVIEW',
      needsObservation: false, hasEvidence: true, evidenceArchived: true, attempts: reconciled('jup') });
    await seed({ tenant, runId: 'xuni-379461c2e3f1807a0dc0455342a51d21', flow: 'crosschain-universal', status: 'SUBMISSION_RESULT_UNKNOWN', provenance: 'PUBLIC_MAINNET',
      errorCode: 'UNIVERSAL_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION', attempts: [{ state: 'SUBMISSION_RESULT_UNKNOWN' }] });
    await seed({ tenant, runId: 'xroute-a09617c2bb8ac5469cab1fc955a3fd32', flow: 'crosschain-router-arbitrum-to-base', status: 'SUBMISSION_RESULT_UNKNOWN',
      provenance: 'PUBLIC_MAINNET', errorCode: 'ROUTER_TRANSACTION_NOT_OBSERVED', attempts: [{ state: 'SUBMISSION_RESULT_UNKNOWN' }] });
  }
  const state = async (tenant: string) => JSON.stringify(await Promise.all([
    t.db.query(`SELECT run_id, status, error_code, needs_observation, attention_required, has_evidence, updated_at, log_version FROM execution_runs WHERE tenant_id = $1 ORDER BY run_id`, [tenant]),
    t.db.query(`SELECT id, kind, state, deliveries, last_error, completed_at, available_at FROM work_items WHERE tenant_id = $1 ORDER BY id`, [tenant]),
    t.db.query(`SELECT run_id, bundle_hash FROM evidence_objects WHERE tenant_id = $1 ORDER BY run_id`, [tenant]),
    t.db.query(`SELECT attempt_id, state, transaction_hash, reconciled FROM execution_attempts WHERE tenant_id = $1 ORDER BY attempt_id`, [tenant]),
    t.db.query(`SELECT count(*)::int AS n FROM admin_audit_events`)]).then(results => results.map(r => r.rows)));

  it('9/10/11/14/15. Overview, System Health, Workflows and Support report the same counts, isolate tenants and write nothing', async () => {
    await t.db.query(`INSERT INTO tenants (tenant_id) VALUES ('lifecycle')`);
    await seedProductionShape('lifecycle');
    await seed({ tenant: 'other', runId: 'lc-foreign', provenance: 'PUBLIC_MAINNET' }); // another tenant's active incident
    const h = { db: t.db, tenantId: 'lifecycle' }, now = new Date(), before = await state('lifecycle'), foreignBefore = await state('other');

    const shared = await loadExecutionAttention(t.db, 'lifecycle', now);
    const expected = { active: 3, underInvestigation: 0, historical: 1, resolved: 8, activeRealFunds: 2, observationExhausted: 2, unknownOutcome: 2, evidence: 1, ownerReviewPending: 1 };
    expect(shared).toMatchObject({ flaggedTotal: 12, truncated: false, notesOk: true, counts: expected });
    const byRun = new Map(shared.entries.map(e => [e.run.runId, e.attention]));
    expect(byRun.get('xuni-379461c2e3f1807a0dc0455342a51d21')).toMatchObject({ lifecycle: 'ACTIVE', conditions: ['OBSERVATION_EXHAUSTED', 'OUTCOME_UNKNOWN'] });
    expect(byRun.get('xroute-a09617c2bb8ac5469cab1fc955a3fd32')).toMatchObject({ lifecycle: 'ACTIVE', conditions: ['OBSERVATION_EXHAUSTED', 'OUTCOME_UNKNOWN'] });
    expect(byRun.get('lc-dv-2')).toMatchObject({ lifecycle: 'ACTIVE', conditions: ['EVIDENCE_ARCHIVE_STOPPED'] });
    expect(byRun.get('lc-dv-1')).toMatchObject({ lifecycle: 'HISTORICAL' });
    expect(byRun.get('lc-jup')).toMatchObject({ lifecycle: 'VERIFIED_RESOLVED', ownerReviewPending: true });
    expect(byRun.has('lc-foreign')).toBe(false);

    // System Health and the Overview's attention list.
    const report = await healthReport({}, h, now, fetch);
    expect(report.runs).toMatchObject({ ok: true, value: { flagged: 12, attention: expected } });
    expect(healthAttention(report).find(item => item.key === 'attention')).toMatchObject({ title: '3 execution runs with an active incident', tone: 'bad' });
    // Workflows: the same lifecycle per run, and the range figure counts the mainnet executions with an open incident.
    const wf = await workflowView(h, { env: 'MAINNET' }, now);
    expect(wf.ok).toBe(true);
    if (!wf.ok) return;
    expect(wf.attention?.counts).toEqual(shared.counts);
    expect(Object.fromEntries(wf.lifecycleByRun)).toEqual(Object.fromEntries(shared.entries.flatMap(e => e.attention.lifecycle ? [[e.run.runId, e.attention.lifecycle]] : [])));
    expect(wf.analytics.attention).toBe(2);
    // Support & Recovery: the open list holds exactly the three active executions; historical and resolved ones are kept, separately.
    const support = await supportView({}, h, now, supportFilters({}));
    expect(support.attention?.counts).toEqual(shared.counts);
    const executions = support.all.filter(i => i.source === 'EXECUTION');
    expect(executions.filter(i => i.lifecycle === 'ACTIVE').map(i => i.resource.id).sort())
      .toEqual(['lc-dv-2', 'xroute-a09617c2bb8ac5469cab1fc955a3fd32', 'xuni-379461c2e3f1807a0dc0455342a51d21']);
    expect(executions.filter(i => i.lifecycle === 'HISTORICAL').length).toBe(1);
    expect(executions.filter(i => i.lifecycle === 'VERIFIED_RESOLVED').length).toBe(8);
    expect(support.incidents.every(i => i.lifecycle === 'ACTIVE' || i.lifecycle === 'UNDER_INVESTIGATION')).toBe(true);
    expect(executions.find(i => i.resource.id === 'lc-jup')).toMatchObject({ kind: 'ATTENTION_HISTORICAL', eligibility: 'NONE', actions: [] });
    expect((await supportView({}, h, now, supportFilters({ lifecycle: 'HISTORICAL' }))).incidents.map(i => i.resource.id)).toEqual(['lc-dv-1']);

    // Nothing was written: flags, statuses, error codes, tasks, evidence, attempts and the audit trail are exactly as before; the other tenant too.
    expect(await state('lifecycle')).toBe(before);
    expect(await state('other')).toBe(foreignBefore);
  });

  it('separates older unflagged testnet divergence from production and surfaces an unavailable execution read', async () => {
    const tenantId = 'incident-scopes', now = new Date(), h = { db: t.db, tenantId };
    await t.db.query('INSERT INTO tenants (tenant_id) VALUES ($1)', [tenantId]);
    await seed({ tenant: tenantId, runId: 'old-test-divergence', flow: 'uniswap-liquidity', provenance: 'PUBLIC_TESTNET',
      status: 'DIVERGENT', attention: false, needsObservation: false, updatedAt: new Date(now.getTime() - 60 * 86_400_000),
      attempts: [{ state: 'RECONCILIATION_REQUIRED', hash: hash('test-divergence') }], work: [] });
    await seed({ tenant: tenantId, runId: 'production-open', provenance: 'PUBLIC_MAINNET' });
    const production = await supportView({}, h, now, supportFilters({}));
    expect(production.incidents.filter(i => i.source === 'EXECUTION').map(i => i.resource.id)).toEqual(['production-open']);
    expect(production.attention?.counts).toMatchObject({ active: 2, activeRealFunds: 1 });
    const audit = await supportView({}, h, now, supportFilters({ network: 'TESTNET' }));
    expect(audit.incidents).toMatchObject([{ kind: 'RESULT_DIVERGED', lifecycle: 'ACTIVE', outcome: 'Diverged from the review', funds: 'TEST_ONLY' }]);
    const unreadable = await discoverIncidents(t.db, tenantId, now, Promise.resolve(null));
    expect(unreadable.sources.find(s => s.source === 'EXECUTION')).toMatchObject({ ok: false, code: 'EXECUTION_ATTENTION_UNAVAILABLE' });
    expect(unreadable.attention).toBeNull();
  });

  it('12/13. an OPERATOR acknowledgement marks an incident under investigation; a VIEWER cannot; the note never changes the execution', async () => {
    await seed({ runId: 'lc-ack', provenance: 'PUBLIC_MAINNET', flow: 'crosschain-universal', errorCode: 'UNIVERSAL_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION' });
    const row = async () => (await t.db.query(`SELECT status, error_code, needs_observation, attention_required, updated_at FROM execution_runs WHERE run_id = 'lc-ack'`)).rows[0];
    const before = await row();
    expect((await incidentDetail({}, host(), new Date(), 'run:lc-ack'))).toMatchObject({ incident: { lifecycle: 'ACTIVE' } });
    expect((await call(viewer, { action: 'note', incidentId: 'run:lc-ack', kind: 'ACKNOWLEDGEMENT', text: 'Checking the source chain' })).status).toBe(403);
    expect((await incidentDetail({}, host(), new Date(), 'run:lc-ack'))).toMatchObject({ incident: { lifecycle: 'ACTIVE' } });
    expect((await call(operator, { action: 'note', incidentId: 'run:lc-ack', kind: 'ACKNOWLEDGEMENT', text: 'Checking the source chain' })).body).toEqual({ ok: true });
    expect((await incidentDetail({}, host(), new Date(), 'run:lc-ack'))).toMatchObject({ incident: { lifecycle: 'UNDER_INVESTIGATION', kind: 'OBSERVATION_STOPPED',
      outcome: 'Outcome unknown' } });
    // A later "resolution" note cannot resolve it: the durable state still shows the condition.
    expect((await call(operator, { action: 'note', incidentId: 'run:lc-ack', kind: 'RESOLUTION', text: 'Looks fine to me' })).body).toEqual({ ok: true });
    const detail = await incidentDetail({}, host(), new Date(), 'run:lc-ack');
    expect(detail).toMatchObject({ incident: { lifecycle: 'ACTIVE' } });
    expect(await row()).toEqual(before);
    expect(await openItems('lc-ack')).toBe(0);
    // The lifecycle audit is append-only.
    await expect(t.db.query(`UPDATE admin_audit_events SET detail = '{}'::jsonb WHERE kind = 'SUPPORT_NOTE'`)).rejects.toThrow();
    await expect(t.db.query(`DELETE FROM admin_audit_events WHERE kind = 'SUPPORT_NOTE'`)).rejects.toThrow();
    expect((await audits('SUPPORT_NOTE')).filter(a => a.detail?.incidentId === 'run:lc-ack').map(a => a.detail?.noteKind)).toEqual(['ACKNOWLEDGEMENT', 'RESOLUTION']);
  });
});
