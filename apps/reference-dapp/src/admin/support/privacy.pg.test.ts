// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001 (P1) on disposable PostgreSQL: the separately governed support text, period-scoped lookup keys,
 * retention (inactive by default, dry run, approval-gated), legal holds and data-subject requests. Nothing here touches a real database.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { recordAudit } from '../store.ts';
import { runAdminCommand, type AdminCommandIo } from '../cli-commands.ts';
import { listNotes, supportSearch } from './diagnostics.ts';
import { candidateFingerprints, lookupPeriod, periodFingerprinter, readSupportTexts, verifySupportText, writeSupportText } from './privacy.ts';

let t: TestDatabase;
const adminKey = randomBytes(32), otherKey = randomBytes(32), WALLET = '0x' + 'c4'.repeat(20), OTHER_WALLET = '0x' + 'd5'.repeat(20);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const io = (now = new Date(), wallet = WALLET, key = adminKey): AdminCommandIo => ({ env: {}, adminKey: () => key, wallet: async () => wallet, now: () => now });
const cli = (command: Parameters<typeof runAdminCommand>[0], values: Record<string, string | boolean>, tenant = 'default', at = io()) => runAdminCommand(command, values, t.db, tenant, at);
const host = (tenantId = 'default') => ({ db: t.db, tenantId });
async function run(runId: string, owner: string, tenant = 'default') {
  await t.db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [tenant, `wf-${runId}`]);
  await t.db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256) VALUES ($1, 'base-swap', $2, 'RUN', 1, 1, 3, $3)`,
    [tenant, `${runId}.jsonl`, sha('{}\n')]);
  await t.db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, owner_account, needs_observation, has_evidence, log_version)
    VALUES ($1, $2, 'base-swap', $3, $4, 'base-swap', 'SUBMISSION_RESULT_UNKNOWN', 'PUBLIC_TESTNET', $5, true, false, 1)`, [tenant, runId, `${runId}.jsonl`, `wf-${runId}`, owner]);
}
/** A note exactly as the Support endpoint writes it: text row and audit skeleton in one transaction. */
async function note(runId: string, body: string, at: Date, retentionDays = 365, tenant = 'default') {
  return t.db.transaction(async tx => {
    const stored = await writeSupportText(tx, tenant, { purpose: 'SUPPORT_NOTE', body, runId, incidentId: `run:${runId}`, actor: 'adm_' + 'a'.repeat(26), now: at, retentionDays });
    await recordAudit(tx, tenant, { actor: 'adm_' + 'a'.repeat(26), kind: 'SUPPORT_NOTE', outcome: 'OK', target: `run:${runId}`,
      detail: { incidentId: `run:${runId}`, noteKind: 'FINDING', textRef: stored.textRef, textDigest: stored.textDigest } });
    return stored;
  });
}
const count = async (sql: string, params: unknown[] = []) => (await t.db.query<{ n: number }>(sql, params)).rows[0]!.n;
const longAgo = new Date(Date.now() - 800 * 86_400_000);

beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.query(`INSERT INTO tenants (tenant_id) VALUES ('other')`);
  await run('priv-a', WALLET); await run('priv-b', WALLET); await run('priv-c', OTHER_WALLET); await run('priv-x', WALLET, 'other');
});
afterAll(async () => { await t?.drop(); });

describe('separately governed support text', () => {
  it('writes text and skeleton atomically: a failing audit insert leaves no text behind', async () => {
    const before = await count(`SELECT count(*)::int AS n FROM admin_support_texts`);
    await expect(t.db.transaction(async tx => {
      await writeSupportText(tx, 'default', { purpose: 'SUPPORT_NOTE', body: 'orphan', runId: 'priv-a', incidentId: 'run:priv-a', actor: 'cli', now: new Date(), retentionDays: 365 });
      await recordAudit(tx, 'default', { actor: 'not a valid actor', kind: 'SUPPORT_NOTE', outcome: 'OK' });
    })).rejects.toThrow();
    expect(await count(`SELECT count(*)::int AS n FROM admin_support_texts`)).toBe(before);
  });
  it('keeps the audit skeleton append-only and the text immutable', async () => {
    const stored = await note('priv-a', 'Immutable finding', new Date());
    await expect(t.db.query(`UPDATE admin_audit_events SET detail = '{}' WHERE kind = 'SUPPORT_NOTE'`)).rejects.toThrow(/APPEND_ONLY_VIOLATION/);
    await expect(t.db.query(`DELETE FROM admin_audit_events WHERE kind = 'SUPPORT_NOTE'`)).rejects.toThrow(/APPEND_ONLY_VIOLATION/);
    await expect(t.db.query(`UPDATE admin_support_texts SET body = 'changed' WHERE text_id = $1`, [stored.textRef])).rejects.toThrow(/ADMIN_SUPPORT_TEXT_IMMUTABLE/);
    expect(await verifySupportText(t.db, 'default', stored.textRef, stored.textDigest)).toBe('MATCH');
    expect(await verifySupportText(t.db, 'default', stored.textRef, '0'.repeat(32))).toBe('MISMATCH');
  });
  it('reads texts per tenant only, and shows legacy inline notes unchanged', async () => {
    const stored = await note('priv-x', 'Other tenant text', new Date(), 365, 'other');
    expect((await readSupportTexts(t.db, 'default', [stored.textRef])).size).toBe(0);
    expect((await readSupportTexts(t.db, 'other', [stored.textRef])).get(stored.textRef)).toBe('Other tenant text');
    await recordAudit(t.db, 'default', { actor: 'cli', kind: 'SUPPORT_NOTE', outcome: 'OK', target: 'run:priv-b', detail: { incidentId: 'run:priv-b', noteKind: 'FINDING', text: 'Legacy inline' } });
    const notes = await listNotes(host(), new Date(), ['run:priv-b']);
    expect(notes[0]).toMatchObject({ text: 'Legacy inline', textState: 'LEGACY' });
  });
});

describe('retention: inactive by default, dry run first, approval-gated, legal holds respected', () => {
  it('reports without deleting and refuses to apply without an approved activation', async () => {
    const expired = await note('priv-a', 'Expired finding', longAgo, 30);
    const report = await cli('retention-report', {}) as { report: { dryRun: boolean; policies: { SUPPORT_TEXT: { wouldDelete: number; basis: string } } } };
    expect(report.report).toMatchObject({ dryRun: true, policies: { SUPPORT_TEXT: { basis: 'PROPOSED_NOT_ACTIVE' } } });
    expect(report.report.policies.SUPPORT_TEXT.wouldDelete).toBeGreaterThanOrEqual(1);
    await expect(cli('retention-apply', { policy: 'SUPPORT_TEXT' })).rejects.toThrow('RETENTION_NOT_ACTIVATED');
    expect((await readSupportTexts(t.db, 'default', [expired.textRef])).size).toBe(1);
  });
  it('a legal hold blocks deletion in the database and in the procedure; after release and activation the text is removed and the skeleton stays', async () => {
    const expired = await note('priv-b', 'Held finding', longAgo, 30);
    const { hold } = await cli('legal-hold', { scope: 'RUN', value: 'priv-b', 'reason-code': 'DISPUTE_PENDING', 'approval-ref': 'LEGAL-2026-001' }) as { hold: { holdId: string } };
    await expect(t.db.query(`DELETE FROM admin_support_texts WHERE text_id = $1`, [expired.textRef])).rejects.toThrow(/ADMIN_SUPPORT_TEXT_LEGAL_HOLD/);
    await expect(t.db.query(`DELETE FROM privacy_legal_holds`)).rejects.toThrow(/PRIVACY_LEGAL_HOLD_PERMANENT/);
    await expect(cli('retention-activate', { policy: 'SUPPORT_TEXT', days: '10', 'approval-ref': 'X' })).rejects.toThrow('RETENTION_DAYS_INVALID');
    await cli('retention-activate', { policy: 'SUPPORT_TEXT', days: '365', 'approval-ref': 'LEGAL-2026-RET-1' });
    await expect(cli('retention-activate', { policy: 'SUPPORT_TEXT', days: '365', 'approval-ref': 'LEGAL-2026-RET-2' })).rejects.toThrow('RETENTION_ALREADY_ACTIVE');
    const skeletonsBefore = await count(`SELECT count(*)::int AS n FROM admin_audit_events WHERE kind = 'SUPPORT_NOTE'`);
    const applied = await cli('retention-apply', { policy: 'SUPPORT_TEXT' }) as { applied: { removed: number; keptByLegalHold: number } };
    expect(applied.applied.keptByLegalHold).toBeGreaterThanOrEqual(1);
    expect((await readSupportTexts(t.db, 'default', [expired.textRef])).size).toBe(1); // held
    await cli('legal-hold-release', { hold: hold.holdId, 'approval-ref': 'LEGAL-2026-002' });
    await cli('retention-apply', { policy: 'SUPPORT_TEXT' });
    expect((await readSupportTexts(t.db, 'default', [expired.textRef])).size).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM admin_audit_events WHERE kind = 'SUPPORT_NOTE'`)).toBe(skeletonsBefore); // skeleton intact
    expect(await verifySupportText(t.db, 'default', expired.textRef, expired.textDigest)).toBe('REMOVED');
    const notes = await listNotes(host(), new Date(Date.now()), ['run:priv-b']);
    expect(notes.find(n => n.textState === 'REMOVED')).toMatchObject({ text: null, kind: 'FINDING' });
    // Recent text (within its period) is untouched; the audit of the application carries counts only.
    const fresh = await note('priv-a', 'Fresh finding', new Date());
    await cli('retention-apply', { policy: 'SUPPORT_TEXT' });
    expect((await readSupportTexts(t.db, 'default', [fresh.textRef])).size).toBe(1);
    const applications = (await t.db.query(`SELECT detail FROM admin_audit_events WHERE kind = 'PRIVACY_RETENTION_APPLIED'`)).rows;
    expect(JSON.stringify(applications)).not.toMatch(/finding/i);
    await cli('retention-revoke', { policy: 'SUPPORT_TEXT' });
    await expect(cli('retention-apply', { policy: 'SUPPORT_TEXT' })).rejects.toThrow('RETENTION_NOT_ACTIVATED');
  });
  it('retention never reaches another tenant', async () => {
    const other = await note('priv-x', 'Other expired', longAgo, 30, 'other');
    await cli('retention-activate', { policy: 'SUPPORT_TEXT', days: '365', 'approval-ref': 'LEGAL-2026-RET-3' });
    await cli('retention-apply', { policy: 'SUPPORT_TEXT' });
    expect((await readSupportTexts(t.db, 'other', [other.textRef])).size).toBe(1);
    await cli('retention-revoke', { policy: 'SUPPORT_TEXT' });
  });
});

describe('period-scoped lookup fingerprints', () => {
  const operator = { principalId: 'adm_' + 'b'.repeat(26), role: 'OPERATOR' as const };
  it('fingerprints per quarter, never stores the wallet or the raw key, and fails closed without a key', async () => {
    const q1 = new Date('2025-02-10T00:00:00Z'), q4 = new Date();
    const a = await periodFingerprinter(t.db, 'default', adminKey, () => q1)(WALLET), b = await periodFingerprinter(t.db, 'default', adminKey, () => q4)(WALLET);
    expect(a).toMatchObject({ period: '2025-Q1', fpv: 2, fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(b.period).toBe(lookupPeriod(q4));
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect((await periodFingerprinter(t.db, 'default', adminKey, () => q1)(WALLET)).fingerprint).toBe(a.fingerprint);
    const found = await supportSearch(host(), operator, WALLET, q4, periodFingerprinter(t.db, 'default', adminKey, () => q4));
    expect(found).toMatchObject({ ok: true, kind: 'WALLET' });
    const audit = (await t.db.query(`SELECT detail FROM admin_audit_events WHERE kind = 'SUPPORT_SEARCH' ORDER BY event_id DESC LIMIT 1`)).rows[0]!.detail;
    expect(audit).toMatchObject({ type: 'WALLET', fpv: 2, period: b.period, fingerprint: b.fingerprint, results: 2 });
    const keys = (await t.db.query(`SELECT wrapped_key FROM admin_lookup_keys`)).rows.map(r => (r.wrapped_key as Buffer).toString('hex'));
    const everything = JSON.stringify((await t.db.query(`SELECT * FROM admin_audit_events`)).rows) + keys.join();
    expect(everything).not.toContain(WALLET.slice(2));
    expect(everything).not.toContain(adminKey.toString('hex'));
    const broken = async () => { throw new Error('SUPPORT_LOOKUP_KEY_UNAVAILABLE'); };
    expect(await supportSearch(host(), operator, WALLET, q4, broken)).toEqual({ ok: false, code: 'SUPPORT_SEARCH_UNAVAILABLE' });
  });
  it('destroying an expired quarter key (approval-gated) makes that quarter unlinkable; the current quarter stays; keys cannot be revived or deleted', async () => {
    const report = await cli('retention-report', {}) as { report: { policies: { LOOKUP_KEYS: { wouldDestroy: string[] } } } };
    expect(report.report.policies.LOOKUP_KEYS.wouldDestroy.some(k => k.startsWith('2025-Q1:'))).toBe(true);
    await expect(cli('retention-apply', { policy: 'LOOKUP_KEYS' })).rejects.toThrow('RETENTION_NOT_ACTIVATED');
    await cli('legal-hold', { scope: 'LOOKUP_PERIOD', value: '2025-Q1', 'reason-code': 'INVESTIGATION_OPEN', 'approval-ref': 'SEC-2026-7' });
    await cli('retention-activate', { policy: 'LOOKUP_KEYS', days: '365', 'approval-ref': 'LEGAL-2026-KEYS' });
    expect(await cli('retention-apply', { policy: 'LOOKUP_KEYS' })).toMatchObject({ applied: { removed: 0, keptByLegalHold: 1 } });
    const held = (await t.db.query<{ hold_id: string }>(`SELECT hold_id FROM privacy_legal_holds WHERE scope = 'LOOKUP_PERIOD' AND released_at IS NULL`)).rows[0]!.hold_id;
    await cli('legal-hold-release', { hold: held, 'approval-ref': 'SEC-2026-8' });
    expect(await cli('retention-apply', { policy: 'LOOKUP_KEYS' })).toMatchObject({ applied: { removed: 1 } });
    const prints = await candidateFingerprints(t.db, 'default', adminKey, WALLET);
    expect(prints.unavailablePeriods.some(p => p.startsWith('2025-Q1:'))).toBe(true);
    expect([...prints.v2.keys()].some(p => p.startsWith(lookupPeriod(new Date())))).toBe(true);
    await expect(t.db.query(`UPDATE admin_lookup_keys SET destroyed_at = NULL, destroy_reason = NULL, wrapped_key = $1 WHERE period = '2025-Q1'`, [randomBytes(60)]))
      .rejects.toThrow(/ADMIN_LOOKUP_KEY_IMMUTABLE|check constraint/);
    await expect(t.db.query(`DELETE FROM admin_lookup_keys`)).rejects.toThrow(/ADMIN_LOOKUP_KEY_PERMANENT/);
    await expect(periodFingerprinter(t.db, 'default', adminKey, () => new Date('2025-02-11T00:00:00Z'))(WALLET)).rejects.toThrow('SUPPORT_LOOKUP_KEY_DESTROYED');
    await cli('retention-revoke', { policy: 'LOOKUP_KEYS' });
  });
  it('a rotated admin secret cannot unwrap earlier keys and starts a new key for the quarter', async () => {
    const now = new Date(), rotated = await periodFingerprinter(t.db, 'default', otherKey, () => now)(WALLET);
    const original = await periodFingerprinter(t.db, 'default', adminKey, () => now)(WALLET);
    expect(rotated.kid).not.toBe(original.kid);
    expect(rotated.fingerprint).not.toBe(original.fingerprint);
    expect((await candidateFingerprints(t.db, 'default', otherKey, WALLET)).unavailablePeriods.length).toBeGreaterThan(0);
  });
});

describe('data-subject requests', () => {
  it('ACCESS: wallet stored only as a keyed fingerprint; approval required; reports runs, texts and matching lookups', async () => {
    const { request } = await cli('privacy-request', { kind: 'ACCESS', 'subject-kind': 'WALLET' }) as { request: { requestId: string } };
    const row = (await t.db.query<{ subject_ref: string; state: string }>(`SELECT subject_ref, state FROM privacy_requests WHERE request_id = $1`, [request.requestId])).rows[0]!;
    expect(row.state).toBe('RECEIVED');
    expect(JSON.stringify(row)).not.toContain(WALLET.slice(2));
    await expect(cli('privacy-access', { request: request.requestId, 'wallet-stdin': true })).rejects.toThrow('PRIVACY_REQUEST_STATE_INVALID');
    await cli('privacy-decide', { request: request.requestId, decision: 'APPROVED', code: 'IDENTITY_VERIFIED', 'approval-ref': 'DPO-2026-11' });
    await expect(cli('privacy-access', { request: request.requestId, 'wallet-stdin': true }, 'default', io(new Date(), OTHER_WALLET))).rejects.toThrow('PRIVACY_SUBJECT_MISMATCH');
    const { access } = await cli('privacy-access', { request: request.requestId, 'wallet-stdin': true, 'include-text': true }) as { access: { executionRuns: { n: number }[];
      supportTexts: { body?: string }[]; supportLookups: unknown[] } };
    expect(access.executionRuns.reduce((n, r) => n + r.n, 0)).toBe(2); // this tenant only
    expect(access.supportTexts.length).toBeGreaterThan(0);
    expect(access.supportLookups.length).toBeGreaterThan(0);
    expect((await t.db.query(`SELECT state FROM privacy_requests WHERE request_id = $1`, [request.requestId])).rows[0]!.state).toBe('COMPLETED');
    await expect(t.db.query(`UPDATE privacy_requests SET state = 'APPROVED' WHERE request_id = $1`, [request.requestId])).rejects.toThrow(/PRIVACY_REQUEST_TRANSITION_INVALID/);
  });
  it('ERASURE: removes the subject’s unheld texts only, keeps skeletons and execution records, and audits counts only', async () => {
    const mine = await note('priv-a', 'About this wallet', new Date()), others = await note('priv-c', 'About another wallet', new Date());
    await cli('legal-hold', { scope: 'RUN', value: 'priv-b', 'reason-code': 'CHARGEBACK_REVIEW', 'approval-ref': 'LEGAL-2026-009' });
    const held = await note('priv-b', 'Held for dispute', new Date());
    const { request } = await cli('privacy-request', { kind: 'ERASURE', 'subject-kind': 'WALLET' }) as { request: { requestId: string } };
    await expect(cli('privacy-erase', { request: request.requestId, 'wallet-stdin': true })).rejects.toThrow('PRIVACY_REQUEST_STATE_INVALID');
    await cli('privacy-decide', { request: request.requestId, decision: 'APPROVED', code: 'NO_RETENTION_PURPOSE', 'approval-ref': 'DPO-2026-12' });
    const runsBefore = await count(`SELECT count(*)::int AS n FROM execution_runs`), skeletons = await count(`SELECT count(*)::int AS n FROM admin_audit_events WHERE kind = 'SUPPORT_NOTE'`);
    const { erasure } = await cli('privacy-erase', { request: request.requestId, 'wallet-stdin': true }) as { erasure: Record<string, unknown> };
    expect(erasure).toMatchObject({ auditSkeletonRetained: true, executionRecordsNotInScope: true, lookupFingerprintsRetainedUntilQuarterKeyDestroyed: true });
    expect(erasure.keptByLegalHold).toBeGreaterThanOrEqual(1);
    const left = await readSupportTexts(t.db, 'default', [mine.textRef, others.textRef, held.textRef]);
    expect([left.has(mine.textRef), left.has(others.textRef), left.has(held.textRef)]).toEqual([false, true, true]);
    expect(await count(`SELECT count(*)::int AS n FROM execution_runs`)).toBe(runsBefore);
    expect(await count(`SELECT count(*)::int AS n FROM admin_audit_events WHERE kind = 'SUPPORT_NOTE'`)).toBe(skeletons);
    const audit = JSON.stringify((await t.db.query(`SELECT detail FROM admin_audit_events WHERE kind LIKE 'PRIVACY_%'`)).rows);
    expect(audit).not.toContain(WALLET.slice(2));
    expect(audit).not.toMatch(/About this wallet/);
  });
  it('review fixes: erasure reaches notes about a run the owner purged; the decision code cannot change at completion; TRUNCATE is refused', async () => {
    // A purged run: only its purge-audit row (0016) still names the owner.
    await t.db.query(`INSERT INTO execution_purge_audit (tenant_id, run_id, owner_account, namespace, log_name, log_sha256, log_version, segment_count, journal_count)
      VALUES ('default', 'priv-purged', $1, 'base-swap', 'priv-purged.jsonl', $2, 1, 1, 0)`, [WALLET, sha('{}\n')]);
    const purged = await note('priv-purged', 'About a purged run', new Date());
    const { request } = await cli('privacy-request', { kind: 'ERASURE', 'subject-kind': 'WALLET' }) as { request: { requestId: string } };
    await cli('privacy-decide', { request: request.requestId, decision: 'APPROVED', code: 'NO_RETENTION_PURPOSE', 'approval-ref': 'DPO-2026-15' });
    await expect(t.db.query(`UPDATE privacy_requests SET state = 'COMPLETED', completed_at = now(), decision_code = 'CHANGED_LATER' WHERE request_id = $1`,
      [request.requestId])).rejects.toThrow(/PRIVACY_REQUEST_TRANSITION_INVALID/);
    await cli('privacy-erase', { request: request.requestId, 'wallet-stdin': true });
    expect((await readSupportTexts(t.db, 'default', [purged.textRef])).size).toBe(0);
    for (const table of ['admin_support_texts', 'admin_lookup_keys', 'privacy_legal_holds', 'privacy_requests', 'privacy_retention_activations'])
      await expect(t.db.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/PRIVACY_TRUNCATE_REFUSED/);
  });
  it('review fix: an approved period shorter than the one configured at write time governs', async () => {
    const written = new Date(Date.now() - 200 * 86_400_000), text = await note('priv-a', 'Written under a 365-day schedule', written, 365);
    await cli('retention-activate', { policy: 'SUPPORT_TEXT', days: '180', 'approval-ref': 'LEGAL-2026-RET-180' });
    await cli('retention-apply', { policy: 'SUPPORT_TEXT' });
    expect((await readSupportTexts(t.db, 'default', [text.textRef])).size).toBe(0);
    await cli('retention-revoke', { policy: 'SUPPORT_TEXT' });
  });
  it('rejected requests and other kinds close with a code; another tenant’s request is invisible', async () => {
    const { request } = await cli('privacy-request', { kind: 'CORRECTION', 'subject-kind': 'ADMIN_PRINCIPAL', principal: 'adm_' + 'a'.repeat(26) }) as { request: { requestId: string } };
    await expect(cli('privacy-complete', { request: request.requestId, code: 'CORRECTING_NOTE_ADDED' }, 'other')).rejects.toThrow('PRIVACY_REQUEST_NOT_FOUND');
    await cli('privacy-decide', { request: request.requestId, decision: 'APPROVED', code: 'ACCURACY_CLAIM', 'approval-ref': 'DPO-2026-13' });
    expect(await cli('privacy-complete', { request: request.requestId, code: 'CORRECTING_NOTE_ADDED' })).toMatchObject({ request: { state: 'COMPLETED' } });
    const rejected = await cli('privacy-request', { kind: 'ERASURE', 'subject-kind': 'WALLET' }) as { request: { requestId: string } };
    await cli('privacy-decide', { request: rejected.request.requestId, decision: 'REJECTED', code: 'LEGAL_RETENTION_PURPOSE', 'approval-ref': 'DPO-2026-14' });
    await expect(cli('privacy-erase', { request: rejected.request.requestId, 'wallet-stdin': true })).rejects.toThrow('PRIVACY_REQUEST_STATE_INVALID');
  });
});
