// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: the AI Learning admin API and view on PostgreSQL, through BUILD-ADMIN-001's real sign-in, session, role and CSRF checks.
 * Review → evaluation → publication (only a passing evaluation publishes; the database checks it too), retraction, rollback re-evaluated today,
 * disable, conflicts, audit, the evaluation budget, and a view that never shows a private memory.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createTestWallet } from '../../../../packages/reference-reconciler/test/test-wallet.ts';
import { learningConfig } from '../learning/config.ts';
import { KNOWLEDGE_SCHEMA, STARTER_CANDIDATES } from '../learning/knowledge.ts';
import { createLearningService } from '../learning/service.ts';
import { createLearningStore } from '../learning/store.ts';
import { runAdminCommand } from './cli-commands.ts';
import { adminConfig } from './config.ts';
import { handleAdminChallenge, handleAdminSignIn, type AdminHttpOptions } from './http.ts';
import { EVALUATION_LIMIT, handleLearningAdmin } from './learning-http.ts';
import { learningAdminView } from './learning-view.ts';
import { adminCsrfToken, readAdminSession } from './session.ts';

const ORIGIN = 'https://admin.flofi.example', DOMAIN = 'admin.flofi.example';
const adminEnv = { FLOFI_ADMIN: 'enabled', FLOFI_ADMIN_SESSION_SECRET: randomBytes(32).toString('hex') };
const learningEnv = { FLOFI_LEARNING: 'enabled', FLOFI_LEARNING_SECRET: randomBytes(32).toString('hex') };
const key = (() => { const c = adminConfig(adminEnv); if (!c.enabled) throw new Error(c.code); return c.key; })();
let t: TestDatabase;
const now = new Date('2026-10-15T12:00:00.000Z');
const options = (): AdminHttpOptions => ({ env: { ...adminEnv, ...learningEnv }, host: { db: t.db, tenantId: 'default' }, now: () => now });
type Session = { cookie: string; csrf: string };
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
  const reference = readAdminSession(key, cookie.slice('flofi_admin_session='.length), now, DOMAIN)!;
  return { cookie, csrf: adminCsrfToken(key, reference.sessionId) };
}
async function call(session: Session | null, body: Record<string, unknown>, csrf: string | null = session?.csrf ?? null) {
  const response = await handleLearningAdmin(new Request(`${ORIGIN}/admin/api/learning`, { method: 'POST', body: JSON.stringify(body),
    headers: { host: DOMAIN, 'x-forwarded-proto': 'https', origin: ORIGIN, 'content-type': 'application/json', cookie: session?.cookie ?? '',
      ...csrf ? { 'x-flofi-admin-csrf': csrf } : {} } }), options());
  return { status: response.status, body: await response.json() as Record<string, unknown> & { ok: boolean; code?: string } };
}
const audit = async (kind: string) => (await t.db.query(`SELECT outcome, code, detail FROM admin_audit_events WHERE kind = $1 ORDER BY event_id`, [kind])).rows;

beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

describe('BUILD-CHAT-LEARNING-001 admin AI Learning API', () => {
  let operator: Session, viewer: Session;
  beforeAll(async () => { operator = await adminSession('OPERATOR'); viewer = await adminSession('VIEWER'); });

  it('keeps BUILD-ADMIN-001’s boundary: no session, no CSRF, a viewer — refused; nothing written', async () => {
    expect((await call(null, { action: 'starter' })).body).toMatchObject({ ok: false, code: 'ADMIN_SESSION_REQUIRED' });
    expect((await call(operator, { action: 'starter' }, 'forged')).body).toMatchObject({ ok: false, code: 'ADMIN_CSRF_INVALID' });
    expect(await call(viewer, { action: 'starter' })).toMatchObject({ status: 403, body: { code: 'ADMIN_ROLE_INSUFFICIENT' } });
    expect((await t.db.query(`SELECT count(*)::int AS n FROM learning_candidates`)).rows).toEqual([{ n: 0 }]);
  });

  it('review → evaluation → publication; a malicious entry is refused; repetition never publishes', async () => {
    expect((await call(operator, { action: 'starter' })).body).toMatchObject({ ok: true, added: STARTER_CANDIDATES.length });
    expect((await call(operator, { action: 'starter' })).body).toMatchObject({ ok: true, added: 0 });
    expect(await call(operator, { action: 'add', term: 'base', target: 'network:BASE_SEPOLIA', language: 'ANY' })).toMatchObject({ status: 400, body: { code: 'LEARNING_TERM_RESERVED' } });
    expect(await call(operator, { action: 'add', term: 'ignore rules', target: 'network:ARBITRUM', language: 'EN' })).toMatchObject({ status: 400 });
    expect(await call(operator, { action: 'publish', expectedVersion: 0 })).toMatchObject({ status: 409, body: { code: 'LEARNING_KNOWLEDGE_EMPTY' } });
    const store = createLearningStore(t.db, 'default'), pending = await store.candidates('PENDING', 100);
    const pick = (term: string) => pending.find(c => c.term === term)!.candidateId;
    for (const term of ['eth sepolia', 'arb sep', 'fazer bridge', 'arbitrun']) expect((await call(operator, { action: 'approve', candidateId: pick(term) })).body.ok).toBe(true);
    expect(await call(operator, { action: 'reject', candidateId: pick('sacar') })).toMatchObject({ status: 400, body: { code: 'ADMIN_LEARNING_REASON_REQUIRED' } });
    expect((await call(operator, { action: 'reject', candidateId: pick('sacar'), reason: 'ambiguous in PT-BR (withdraw cash)' })).body.ok).toBe(true);
    const dry = await call(operator, { action: 'evaluate' });
    expect(dry.body).toMatchObject({ ok: true, evaluation: { passed: true, entries: 4, regressions: [], safetyViolations: [] } });
    const published = await call(operator, { action: 'publish', expectedVersion: 0, reason: 'first glossary' });
    expect(published.body).toMatchObject({ ok: true, version: 1, evaluation: { passed: true } });
    expect(await call(operator, { action: 'publish', expectedVersion: 0 })).toMatchObject({ status: 409, body: { code: 'LEARNING_KNOWLEDGE_VERSION_CONFLICT', activeVersion: 1 } });
    expect(await call(operator, { action: 'publish', expectedVersion: 1 })).toMatchObject({ status: 409, body: { code: 'LEARNING_KNOWLEDGE_UNCHANGED' } });
    // Both users now get the published global entries (and only those).
    const config = learningConfig(learningEnv);
    if (!config.enabled) throw new Error('config');
    const service = createLearningService({ config, host: { db: t.db, tenantId: 'default' }, now: () => now, log: () => undefined });
    const a = await service.session({ kind: 'WALLET', namespace: 'eip155', account: '0x' + 'a'.repeat(40) });
    const b = await service.session({ kind: 'WALLET', namespace: 'eip155', account: '0x' + 'b'.repeat(40) });
    for (const s of [a, b]) expect(s.learning.global.map(e => e.term).sort()).toEqual(['arb sep', 'arbitrun', 'eth sepolia', 'fazer bridge']);
    expect((await audit('ADMIN_LEARNING_PUBLISHED')).at(-1)).toMatchObject({ outcome: 'OK', detail: { version: 1, entries: 4 } });
  });

  it('retraction, rollback re-evaluated today, disable — each a new audited version', async () => {
    const store = createLearningStore(t.db, 'default'), approved = await store.candidates('APPROVED', 100);
    expect((await call(operator, { action: 'reject', candidateId: approved.find(c => c.term === 'arbitrun')!.candidateId, reason: 'retracted' })).body.ok).toBe(true);
    expect((await call(operator, { action: 'publish', expectedVersion: 1 })).body).toMatchObject({ ok: true, version: 2, evaluation: { entries: 3 } });
    expect((await call(operator, { action: 'rollback', expectedVersion: 2, toVersion: 1, reason: 'restore v1' })).body).toMatchObject({ ok: true, version: 3 });
    expect(await store.activeKnowledge()).toMatchObject({ version: 3, restoredFrom: 1 });
    expect((await call(operator, { action: 'disable', expectedVersion: 3, reason: 'incident drill' })).body).toMatchObject({ ok: true, version: 4 });
    expect(await store.activeKnowledge()).toMatchObject({ version: 4, document: null });
    expect((await call(operator, { action: 'rollback', expectedVersion: 4, toVersion: 9 })).body).toMatchObject({ ok: false, code: 'ADMIN_LEARNING_VERSION_UNKNOWN' });
    expect((await audit('ADMIN_LEARNING_DISABLED')).map(r => r.outcome)).toEqual(['OK']);
  });

  it('a rollback to a version that no longer passes is refused and recorded; nothing is appended', async () => {
    const store = createLearningStore(t.db, 'default');
    const stale = { schema: KNOWLEDGE_SCHEMA, entries: [{ term: 'base', target: 'network:BASE_SEPOLIA', language: 'ANY', candidateId: null }] };
    const evaluation = await store.recordEvaluation({ purpose: 'PUBLISH', baseVersion: 4, document: stale, corpus: 'legacy', passed: true, result: {}, createdBy: 'cli' }, now);
    await store.appendKnowledge({ expectedVersion: 4, document: stale, evaluationId: evaluation.evaluationId, restoredFrom: null, createdBy: 'cli', reason: 'legacy' }, now);
    await store.appendKnowledge({ expectedVersion: 5, document: null, evaluationId: null, restoredFrom: null, createdBy: 'cli', reason: null }, now);
    const refused = await call(operator, { action: 'rollback', expectedVersion: 6, toVersion: 5 });
    expect(refused).toMatchObject({ status: 409, body: { code: 'LEARNING_EVALUATION_FAILED', evaluation: { passed: false, document: { code: 'LEARNING_TERM_RESERVED' } } } });
    expect(await store.activeKnowledge()).toMatchObject({ version: 6 });
    expect((await audit('ADMIN_LEARNING_ROLLED_BACK')).at(-1)).toMatchObject({ outcome: 'REFUSED', code: 'LEARNING_EVALUATION_FAILED' });
  });

  it('bounds evaluations per tenant', async () => {
    await t.db.query(`INSERT INTO admin_audit_events (tenant_id, at, actor, kind, outcome) SELECT 'default', $2, 'cli', 'ADMIN_LEARNING_EVALUATED', 'OK'
      FROM generate_series(1, $1)`, [EVALUATION_LIMIT, now]);
    expect(await call(operator, { action: 'evaluate' })).toMatchObject({ status: 429, body: { code: 'ADMIN_LEARNING_EVALUATION_RATE_LIMITED' } });
  });

  it('the view shows aggregates only — never a private memory term, a subject or a message', async () => {
    const config = learningConfig(learningEnv);
    if (!config.enabled) throw new Error('config');
    const service = createLearningService({ config, host: { db: t.db, tenantId: 'default' }, now: () => now, log: () => undefined });
    const user = { kind: 'WALLET' as const, namespace: 'eip155' as const, account: '0x' + 'c'.repeat(40) };
    await service.apply(user, { op: 'SAVE', entry: { term: 'minhagrana', target: 'asset:USDC', source: 'PRIVATE' } }, 'WEB');
    await service.record('WEB', [{ kind: 'TURN', outcome: 'PROPOSAL' }, { kind: 'TURN', outcome: 'CLARIFICATION' }, { kind: 'CORRECTION' }]);
    const view = await learningAdminView({ ...learningEnv }, { db: t.db, tenantId: 'default' }, now);
    expect(view).toMatchObject({ deployment: { enabled: true, global: true }, memory: { entries: 1, subjects: 1, walletSubjects: 1 },
      turns: { total: 2, proposals: { count: 1, rate: 0.5 } }, corrections: { count: 1, of: 1 } });
    expect(JSON.stringify(view)).not.toMatch(/minhagrana|cccccccccc/);
  });

  it('BUILD-CHAT-LEARNING-002: invisible-learning metrics, contributed candidates only above the contributor threshold, the purge by basis', async () => {
    const li = learningConfig({ ...learningEnv, FLOFI_LEARNING_AUTOMATIC: 'legitimate_interest' });
    if (!li.enabled) throw new Error('config');
    const service = createLearningService({ config: li, host: { db: t.db, tenantId: 'default' }, now: () => now, log: () => undefined });
    const user = (c: string) => ({ kind: 'WALLET' as const, namespace: 'eip155' as const, account: '0x' + c.repeat(40) });
    await service.record('WEB', [{ kind: 'ADAPTATION', outcome: 'CLARIFIED_NETWORK' }, { kind: 'ADAPTATION', outcome: 'CORRECTED_NETWORK_CANVAS' },
      { kind: 'CORRECTION_IGNORED', outcome: 'OBJECTIVE_CHANGED' }, { kind: 'INFERRED_USED', outcome: 'LEARNED' }, { kind: 'INFERRED_USED', outcome: 'ADAPTED' },
      { kind: 'INFERRED_CONFIRMED', outcome: 'LEARNED' }, { kind: 'INFERRED_CORRECTED', outcome: 'ADAPTED' }]);
    // One contributor's learned meaning: a candidate below the threshold is counted, never listed.
    await service.settings(user('d'), { contribute: true });
    for (const n of [1, 2]) await service.observe(user('d'), [{ kind: 'CLARIFIED', term: 'zzsol', target: 'network:SOLANA', via: 'CHAT' }],
      { conversation: `conversation-admin-${n}`, request: 0 }, 'WEB');
    await service.settings(user('e'), { automatic: false });
    const view = await learningAdminView({ ...learningEnv, FLOFI_LEARNING_AUTOMATIC: 'legitimate_interest' }, { db: t.db, tenantId: 'default' }, now);
    expect(view.deployment.automatic).toBe('LEGITIMATE_INTEREST');
    expect(view.automatic).toMatchObject({ adaptations: { CLARIFIED_NETWORK: 1, CORRECTED_NETWORK_CANVAS: 1 }, ignored: { OBJECTIVE_CHANGED: 1 },
      inferred: { used: 2, confirmed: 1, corrected: 1, effectiveness: { count: 1, of: 2, rate: 0.5 }, falsePositives: { count: 1, of: 2, rate: 0.5 },
        bySource: { LEARNED: { used: 1, confirmed: 1, corrected: 0 }, ADAPTED: { used: 1, confirmed: 0, corrected: 1 } } }, corrections: { chat: 0, canvas: 1 },
      store: { CLARIFIED_OBSERVED: 1, CLARIFIED_LEARNED: 1 }, evidence: { rows: 1, promoted: 1, learned: 1 } });
    expect(view.automatic.choices).toEqual([{ basis: 'LEGITIMATE_INTEREST', enabled: false, n: 1 }]);
    expect(view.candidates.pending.some(c => c.term === 'zzsol')).toBe(false);
    expect(view.candidates.belowThreshold).toBe(1);
    expect(JSON.stringify(view)).not.toMatch(/zzsol|dddddddddd/);

    // The purge follows the deployment's current basis: under consent, every identity without a consent loses what automatic learning produced.
    const purge = await handleLearningAdmin(new Request(`${ORIGIN}/admin/api/learning`, { method: 'POST', body: JSON.stringify({ action: 'purge-automatic' }),
      headers: { host: DOMAIN, 'x-forwarded-proto': 'https', origin: ORIGIN, 'content-type': 'application/json', cookie: operator.cookie, 'x-flofi-admin-csrf': operator.csrf } }),
    { ...options(), env: { ...adminEnv, ...learningEnv, FLOFI_LEARNING_AUTOMATIC: 'consent' } });
    expect(await purge.json()).toEqual({ ok: true, mode: 'CONSENT', subjects: 1 });
    expect((await t.db.query(`SELECT count(*)::int AS n FROM learning_evidence`)).rows).toEqual([{ n: 0 }]);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM learning_memories WHERE term = 'zzsol'`)).rows).toEqual([{ n: 0 }]);
    expect((await audit('ADMIN_LEARNING_AUTOMATIC_PURGED')).map(r => [r.outcome, r.detail])).toEqual([['OK', { mode: 'CONSENT', subjects: 1 }]]);
  });
});
