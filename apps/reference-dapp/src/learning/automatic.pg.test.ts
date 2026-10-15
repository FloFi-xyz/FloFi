// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-002 on PostgreSQL (migration 0014): persistent automatic learning. Consent and objection per legal basis, learning and retrieval
 * across sessions only when permitted, repeated evidence before anything is learned, conflicts, identity/channel/tenant isolation, deletion (forget,
 * erase — also by an older build's plain DELETE — withdrawal, retention, the operator purge), demotion of a corrected meaning, the language hint,
 * closed values only, and fail-soft behaviour on a database without 0014.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { emptyConversation, startTurn, type CopilotLearning } from '../domain/copilot-conversation.ts';
import type { LearningObservation } from '../domain/copilot-adaptation.ts';
import { learningConfig, type AutomaticMode } from './config.ts';
import type { LearningPrincipal } from './identity.ts';
import { createLearningService, SESSION_LEARNING } from './service.ts';
import { createLearningStore } from './store.ts';

const SECRET = randomBytes(32).toString('hex');
const configFor = (automatic: AutomaticMode) => {
  const c = learningConfig({ FLOFI_LEARNING: 'enabled', FLOFI_LEARNING_SECRET: SECRET,
    FLOFI_LEARNING_AUTOMATIC: automatic === 'OFF' ? 'off' : automatic === 'CONSENT' ? 'consent' : 'legitimate_interest' });
  if (!c.enabled) throw new Error(c.reason);
  return c;
};
const NOW = new Date('2026-10-15T12:00:00.000Z'), DAY = 86_400_000;
const wallet = (n: string): LearningPrincipal => ({ kind: 'WALLET', namespace: 'eip155', account: '0x' + n.repeat(40).slice(0, 40) });
const A = wallet('a'), B = wallet('b'), A_SOLANA: LearningPrincipal = { kind: 'WALLET', namespace: 'solana', account: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' };
const SENDER: LearningPrincipal = { kind: 'CHANNEL', channel: 'TELEGRAM', business: '123456', sender: Buffer.alloc(32, 7) };
const CLARIFIED = (term: string, target: string): LearningObservation => ({ kind: 'CLARIFIED', term, target: target as never, via: 'CHAT' });
const SOL_DEV = CLARIFIED('sol dev', 'network:SOLANA_DEVNET');
const SOL_DEV_AS = (kind: 'CONFIRMED' | 'CONTRADICTED'): LearningObservation => ({ kind, term: 'sol dev', target: 'network:SOLANA_DEVNET', via: 'CHAT' });
const conversation = (n: number) => `conversation-${String(n).padStart(8, '0')}`;
const opened: TestDatabase[] = [];
afterEach(async () => { await Promise.allSettled(opened.splice(0).map(t => t.drop())); }, 60_000);
async function setup(mode: AutomaticMode, tenantId = 'default', clock: () => Date = () => NOW) {
  const t = await createTestDatabase();
  opened.push(t);
  const service = (m: AutomaticMode = mode, tenant = tenantId) => createLearningService({ config: configFor(m), host: { db: t.db, tenantId: tenant }, now: clock, log: () => undefined });
  return { t, service: service(), withMode: service, store: createLearningStore(t.db, tenantId) };
}
const rows = async (t: TestDatabase, sql: string, values: unknown[] = []) => (await t.db.query(sql, values)).rows;
const learned = (learning: CopilotLearning) => (learning.learned ?? []).map(e => `${e.term}→${e.target}`);

describe('BUILD-CHAT-LEARNING-002 consent and objection per legal basis', () => {
  it('off: nothing observed is ever stored, and the choice cannot be recorded', async () => {
    const { t, service } = await setup('OFF');
    expect(await service.observe(A, [SOL_DEV], { conversation: conversation(1), request: 0 }, 'WEB')).toEqual([]);
    expect(await service.settings(A, { automatic: true })).toEqual({ ok: false, code: 'LEARNING_AUTOMATIC_OFF' });
    expect((await service.session(A)).learning.automatic).toBe('OFF');
    expect(await rows(t, `SELECT count(*)::int AS n FROM learning_subjects`)).toEqual([{ n: 0 }]);
    expect(await rows(t, `SELECT count(*)::int AS n FROM learning_evidence`)).toEqual([{ n: 0 }]);
  });

  it('consent: nothing until the identity turns it on (recorded with basis, notice and time); withdrawal erases what it produced', async () => {
    const { t, service, store } = await setup('CONSENT');
    expect((await service.session(A)).learning).toMatchObject({ memory: 'AVAILABLE', automatic: 'OFF' });
    expect(await service.observe(A, [SOL_DEV], { conversation: conversation(1), request: 0 }, 'WEB')).toEqual([]);
    expect(await rows(t, `SELECT count(*)::int AS n FROM learning_subjects`)).toEqual([{ n: 0 }]);
    // A meaning saved earlier with BUILD-CHAT-LEARNING-001's "Remember" (consent v1) is kept through everything below.
    expect(await service.apply(A, { op: 'SAVE', entry: { term: 'grana', target: 'asset:USDC', source: 'PRIVATE' } }, 'WEB')).toEqual({ ok: true });
    expect(await service.settings(A, { automatic: true })).toEqual({ ok: true });
    expect(await rows(t, `SELECT enabled, basis, notice_version, decided_at FROM learning_automatic_settings`)).toEqual([
      { enabled: true, basis: 'CONSENT', notice_version: 2, decided_at: NOW }]);
    expect((await service.session(A)).learning.automatic).toBe('ON');
    expect(await service.observe(A, [SOL_DEV], { conversation: conversation(1), request: 0 }, 'WEB')).toEqual(['OBSERVED']);
    expect(await service.observe(A, [SOL_DEV], { conversation: conversation(2), request: 0 }, 'WEB')).toEqual(['LEARNED']);
    expect((await store.memoriesWithOrigin(String((await rows(t, `SELECT subject_id FROM learning_subjects`))[0]!.subject_id)))
      .map(row => `${row.term}:${row.origin}`)).toEqual(['grana:REMEMBERED', 'sol dev:LEARNED']);
    expect(await service.settings(A, { automatic: false })).toEqual({ ok: true });
    expect(await rows(t, `SELECT term, target FROM learning_memories`)).toEqual([{ term: 'grana', target: 'asset:USDC' }]);
    expect(await rows(t, `SELECT count(*)::int AS n FROM learning_evidence`)).toEqual([{ n: 0 }]);
    expect(await service.observe(A, [SOL_DEV], { conversation: conversation(3), request: 0 }, 'WEB')).toEqual([]);
    // A consent recorded under the old notice (v1) does not cover automatic learning.
    await t.db.query(`UPDATE learning_automatic_settings SET enabled = true, notice_version = 1`);
    expect((await service.session(A)).learning.automatic).toBe('OFF');
  });

  it('legitimate interest: learned unless the identity objected; an objection erases and is honoured afterwards; a paused memory is not learned', async () => {
    const { t, service } = await setup('LEGITIMATE_INTEREST');
    expect((await service.session(A)).learning.automatic).toBe('ON');
    expect(await service.observe(A, [SOL_DEV], { conversation: conversation(1), request: 0 }, 'WEB')).toEqual(['OBSERVED']);
    expect(await rows(t, `SELECT kind, memory_enabled, memory_consent_at FROM learning_subjects`)).toEqual([{ kind: 'WALLET', memory_enabled: false, memory_consent_at: null }]);
    expect(await service.observe(A, [SOL_DEV], { conversation: conversation(2), request: 0 }, 'WEB')).toEqual(['LEARNED']);
    // Used without any consent row: the meaning is LEARNED (inferred: a test network grounds; it is labelled as learned).
    expect(learned((await service.session(A)).learning)).toEqual(['sol dev→network:SOLANA_DEVNET']);
    expect(await service.settings(A, { automatic: false })).toEqual({ ok: true });
    expect(await rows(t, `SELECT enabled, basis FROM learning_automatic_settings`)).toEqual([{ enabled: false, basis: 'LEGITIMATE_INTEREST' }]);
    expect(await rows(t, `SELECT count(*)::int AS n FROM learning_memories`)).toEqual([{ n: 0 }]);
    expect(await service.observe(A, [SOL_DEV], { conversation: conversation(3), request: 0 }, 'WEB')).toEqual([]);
    expect((await service.session(A)).learning).toMatchObject({ automatic: 'OFF', learned: [] });
    // A user who consented to memory and then paused it is neither learned from nor served.
    expect(await service.apply(B, { op: 'SAVE', entry: { term: 'grana', target: 'asset:USDC', source: 'PRIVATE' } }, 'WEB')).toEqual({ ok: true });
    expect(await service.settings(B, { memory: false })).toEqual({ ok: true });
    expect((await service.session(B)).learning).toMatchObject({ memory: 'PAUSED', automatic: 'OFF', private: [] });
    expect(await service.observe(B, [SOL_DEV], { conversation: conversation(4), request: 0 }, 'WEB')).toEqual([]);
  });
});

describe('BUILD-CHAT-LEARNING-002 repeated evidence, retrieval across sessions, conflicts', () => {
  it('one observation is never enough; the same request counts once; two requests learn; a later session uses it as an inferred meaning', async () => {
    const { t, service } = await setup('LEGITIMATE_INTEREST');
    const context = { conversation: conversation(1), request: 3 };
    expect(await service.observe(A, [SOL_DEV], context, 'WEB')).toEqual(['OBSERVED']);
    expect(await service.observe(A, [SOL_DEV], context, 'WEB')).toEqual(['DUPLICATE']);
    expect(learned((await service.session(A)).learning)).toEqual([]);
    expect(await service.observe(A, [SOL_DEV_AS('CONFIRMED')], { ...context, request: 4 }, 'WEB')).toEqual(['LEARNED']);
    const session = await service.session(A);
    expect(session.learning.learned).toEqual([{ term: 'sol dev', target: 'network:SOLANA_DEVNET', source: 'LEARNED' }]);
    expect(await rows(t, `SELECT clarified, confirmed, conversations FROM learning_evidence`)).toEqual([{ clarified: 1, confirmed: 1, conversations: 1 }]);
    // The engine uses it: the next conversation reads "sol dev" without asking, and says so.
    const turn = startTurn(emptyConversation(), 'Swap 0.1 SOL to devUSDC on sol dev', { workflow: { nodes: [] } as never, context: {} as never, wallet: null, walletChainId: null,
      pending: null, facts: {} as never, learning: session.learning });
    expect(turn.kind).toBe('REMOTE');
    // Content-free outcome events only: no term, no subject.
    const events = await rows(t, `SELECT kind, outcome FROM learning_feedback_events ORDER BY event_id`);
    expect(events).toEqual([{ kind: 'AUTOMATIC', outcome: 'CLARIFIED_OBSERVED' }, { kind: 'AUTOMATIC', outcome: 'CLARIFIED_DUPLICATE' },
      { kind: 'AUTOMATIC', outcome: 'CONFIRMED_LEARNED' }]);
    expect(JSON.stringify(events)).not.toMatch(/sol dev/);
  });

  it('conflicting evidence never learns; a dominant meaning does; a statement replaces everything else for the word', async () => {
    const { t, service } = await setup('LEGITIMATE_INTEREST');
    const said = (n: number, observation: LearningObservation) => service.observe(A, [observation], { conversation: conversation(n), request: 0 }, 'WEB');
    await said(1, CLARIFIED('arbi', 'network:ARBITRUM'));
    expect(await said(2, CLARIFIED('arbi', 'network:BASE'))).toEqual(['OBSERVED']);      // 1 against 1: insufficient
    expect(await said(3, CLARIFIED('arbi', 'network:BASE'))).toEqual(['CONFLICT']);      // 2 against 1: twice as much, but only 1 more
    expect(await rows(t, `SELECT count(*)::int AS n FROM learning_memories`)).toEqual([{ n: 0 }]);
    expect(await said(4, CLARIFIED('arbi', 'network:BASE'))).toEqual(['LEARNED']);       // 3 against 1: dominant and 2 more
    expect(await rows(t, `SELECT term, target FROM learning_memories`)).toEqual([{ term: 'arbi', target: 'network:BASE' }]);
    expect(await said(6, { kind: 'STATED', term: 'arbi', target: 'network:ARBITRUM', via: 'CHAT' })).toEqual(['LEARNED']);
    expect(await rows(t, `SELECT term, target FROM learning_memories`)).toEqual([{ term: 'arbi', target: 'network:ARBITRUM' }]);
    expect(await rows(t, `SELECT target, stated FROM learning_evidence WHERE term = 'arbi'`)).toEqual([{ target: 'network:ARBITRUM', stated: 1 }]);
    // A stated meaning is the user's own: it is saved (PRIVATE), and inference never replaces it.
    expect((await service.session(A)).learning.private).toEqual([{ term: 'arbi', target: 'network:ARBITRUM', source: 'PRIVATE' }]);
    for (let n = 7; n < 14; n++) await said(n, CLARIFIED('arbi', 'network:BASE'));
    expect(await rows(t, `SELECT target FROM learning_memories`)).toEqual([{ target: 'network:ARBITRUM' }]);
  });

  it('a correction of a learned meaning removes it at once; a stated or remembered one is kept', async () => {
    const { t, service } = await setup('LEGITIMATE_INTEREST');
    await service.observe(A, [SOL_DEV], { conversation: conversation(1), request: 0 }, 'WEB');
    await service.observe(A, [SOL_DEV], { conversation: conversation(2), request: 0 }, 'WEB');
    expect(await service.observe(A, [SOL_DEV_AS('CONTRADICTED')], { conversation: conversation(3), request: 0 }, 'WEB')).toEqual(['DEMOTED']);
    expect(await rows(t, `SELECT count(*)::int AS n FROM learning_memories`)).toEqual([{ n: 0 }]);
    expect(await rows(t, `SELECT count(*)::int AS n FROM learning_evidence`)).toEqual([{ n: 0 }]);
    await service.observe(A, [{ kind: 'STATED', term: 'arb', target: 'network:ARBITRUM', via: 'CHAT' }], { conversation: conversation(4), request: 0 }, 'WEB');
    expect(await service.observe(A, [{ kind: 'CONTRADICTED', term: 'arb', target: 'network:ARBITRUM', via: 'CANVAS' }], { conversation: conversation(5), request: 0 }, 'WEB'))
      .toEqual(['KEPT']);
    expect(await service.apply(A, { op: 'SAVE', entry: { term: 'grana', target: 'asset:USDC', source: 'PRIVATE' } }, 'WEB')).toEqual({ ok: true });
    await service.observe(A, [CLARIFIED('grana', 'asset:USDC')], { conversation: conversation(6), request: 0 }, 'WEB');
    expect(await service.observe(A, [CLARIFIED('grana', 'asset:USDC')], { conversation: conversation(7), request: 0 }, 'WEB')).toEqual(['ALREADY']);
    expect(await service.observe(A, [{ kind: 'CONTRADICTED', term: 'grana', target: 'asset:USDC', via: 'CHAT' }], { conversation: conversation(8), request: 0 }, 'WEB'))
      .toEqual(['KEPT']);
    expect((await rows(t, `SELECT term FROM learning_memories ORDER BY term`)).map(r => r.term)).toEqual(['arb', 'grana']);
  });

  it('the starting language needs three conversations, unmistakably in it, and dominance', async () => {
    const { service } = await setup('LEGITIMATE_INTEREST');
    const pt = (n: number) => service.observe(A, [{ kind: 'LANGUAGE', language: 'PT' }], { conversation: conversation(n), request: 0 }, 'WEB');
    expect(await pt(1)).toEqual(['OBSERVED']);
    expect(await pt(1)).toEqual(['DUPLICATE']);
    expect(await pt(2)).toEqual(['OBSERVED']);
    expect(await pt(3)).toEqual(['LEARNED']);
    expect((await service.session(A)).learning.languageHint).toBe('PT');
    await service.observe(A, [{ kind: 'LANGUAGE', language: 'EN' }], { conversation: conversation(4), request: 0 }, 'WEB');
    expect((await service.session(A)).learning.languageHint).toBe('PT');
    // A stated reply language is a setting of its own (not evidence).
    expect(await service.observe(A, [{ kind: 'LANGUAGE', language: 'EN', stated: true }], { conversation: conversation(5), request: 0 }, 'WEB')).toEqual(['LEARNED']);
    expect((await service.session(A)).learning.language).toBe('EN');
  });
});

describe('BUILD-CHAT-LEARNING-002 isolation, bounds and closed values', () => {
  it('evidence and learned meanings belong to one verified identity: never another wallet, the same person’s other wallet, a chat sender or another tenant', async () => {
    const { t, service, withMode } = await setup('LEGITIMATE_INTEREST');
    for (const n of [1, 2]) await service.observe(A, [SOL_DEV], { conversation: conversation(n), request: 0 }, 'WEB');
    expect(learned((await service.session(A)).learning)).toEqual(['sol dev→network:SOLANA_DEVNET']);
    for (const other of [B, A_SOLANA, SENDER]) expect((await service.session(other)).learning.learned).toEqual([]);
    expect((await withMode('LEGITIMATE_INTEREST', 'other').session(A)).learning.learned).toEqual([]);
    // Pseudonymous: no address, no conversation id, no raw request id is stored.
    const dump = JSON.stringify(await rows(t, `SELECT * FROM learning_evidence`)) + JSON.stringify(await rows(t, `SELECT * FROM learning_subjects`));
    expect(dump).not.toMatch(/aaaaaaaaaa|conversation-/);
  });

  it('only closed-vocabulary meanings of validated words are ever stored; a browser cannot smuggle amounts, addresses or slippage', async () => {
    const { t, service } = await setup('LEGITIMATE_INTEREST');
    const forged = [{ kind: 'CLARIFIED', term: '10 usdc', target: 'network:ARBITRUM' }, { kind: 'CLARIFIED', term: 'arb', target: 'amount:10' },
      { kind: 'CLARIFIED', term: '0xabc', target: 'network:BASE' }, { kind: 'CLARIFIED', term: 'arb', target: 'network:ARBITRUM', amount: '5' },
      { kind: 'CLARIFIED', term: 'base', target: 'network:BASE_SEPOLIA' }, { kind: 'APPROVE', term: 'arb', target: 'network:ARBITRUM' },
      { kind: 'CLARIFIED', term: 'slippage', target: 'operation:SWAP' }] as unknown as LearningObservation[];
    const outcomes = await service.observe(A, forged, { conversation: conversation(1), request: 0 }, 'WEB');
    expect(outcomes).toEqual(['OBSERVED']);   // only "arb → Arbitrum One" is a valid observation (extra fields are dropped)
    expect(await rows(t, `SELECT term, target FROM learning_evidence`)).toEqual([{ term: 'arb', target: 'network:ARBITRUM' }]);
    await expect(t.db.query(`INSERT INTO learning_evidence (tenant_id, subject_id, term, target) SELECT tenant_id, subject_id, 'x y', 'amount:10' FROM learning_subjects`))
      .rejects.toThrow(/learning_evidence_target_check|check constraint/);
    expect(await service.observe(A, [SOL_DEV], { conversation: 'short', request: 0 }, 'WEB')).toEqual([]);
    expect(await service.observe(A, [SOL_DEV], { conversation: conversation(2), request: -1 }, 'WEB')).toEqual([]);
  });

  it('bounded: at most four meanings per word and 128 rows per identity (the oldest unlearned evidence makes room)', async () => {
    const { t, store, service } = await setup('LEGITIMATE_INTEREST');
    await service.observe(A, [SOL_DEV], { conversation: conversation(1), request: 0 }, 'WEB');
    const subject = (await rows(t, `SELECT subject_id FROM learning_subjects`))[0]!.subject_id as string;
    const digest = (n: number) => ({ request: Buffer.alloc(32, n), conversation: Buffer.alloc(32, n) });
    let n = 2;
    for (const target of ['network:ARBITRUM', 'network:BASE', 'network:SOLANA', 'network:ROBINHOOD', 'network:ETHEREUM'] as const)
      await store.observe(subject, { kind: 'CLARIFIED', term: 'zzq', target }, digest(n++), new Date(NOW.getTime() + n * 1000));
    expect((await rows(t, `SELECT target FROM learning_evidence WHERE term = 'zzq' ORDER BY target`)).map(r => r.target))
      .toEqual(['network:BASE', 'network:ETHEREUM', 'network:ROBINHOOD', 'network:SOLANA']);
    for (let i = 0; i < 140; i++)
      await store.observe(subject, { kind: 'CLARIFIED', term: `w${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`, target: 'operation:SWAP' },
        digest(200 + (i % 50)), new Date(NOW.getTime() + (100 + i) * 1000));
    expect(await rows(t, `SELECT count(*)::int AS n FROM learning_evidence WHERE subject_id = $1`, [subject])).toEqual([{ n: 128 }]);
  });
});

describe('BUILD-CHAT-LEARNING-002 deletion, retention and rollback', () => {
  it('forget removes a word’s meaning and its evidence; erase — even an older build’s plain DELETE of the subject — removes every observation and choice', async () => {
    const { t, service } = await setup('LEGITIMATE_INTEREST');
    for (const n of [1, 2]) await service.observe(A, [SOL_DEV, CLARIFIED('arb', 'network:ARBITRUM')], { conversation: conversation(n), request: 0 }, 'WEB');
    expect(await service.apply(A, { op: 'FORGET', term: 'sol dev' }, 'WEB')).toEqual({ ok: true });
    expect((await rows(t, `SELECT DISTINCT term FROM learning_evidence`)).map(r => r.term)).toEqual(['arb']);
    expect(await service.erase(A, 'WEB')).toEqual({ ok: true });
    for (const table of ['learning_subjects', 'learning_memories', 'learning_evidence', 'learning_automatic_settings'])
      expect(await rows(t, `SELECT count(*)::int AS n FROM ${table}`)).toEqual([{ n: 0 }]);
    // What a v13 process (Release A of this build) does on STOP / delete-all: the foreign keys erase the 0014 rows too.
    for (const n of [3, 4]) await service.observe(B, [SOL_DEV], { conversation: conversation(n), request: 0 }, 'WEB');
    await service.settings(B, { automatic: true });
    await t.db.query(`DELETE FROM learning_subjects`);
    expect(await rows(t, `SELECT (SELECT count(*) FROM learning_evidence)::int AS e, (SELECT count(*) FROM learning_automatic_settings)::int AS s`)).toEqual([{ e: 0, s: 0 }]);
  });

  it('retention: unlearned evidence expires after 90 days, evidence behind a forgotten meaning goes, an objection is kept; the operator purge follows the basis', async () => {
    let now = NOW;
    const { t, store, withMode } = await setup('LEGITIMATE_INTEREST', 'default', () => now);
    const li = withMode('LEGITIMATE_INTEREST');
    await li.observe(A, [SOL_DEV], { conversation: conversation(1), request: 0 }, 'WEB');            // unlearned
    for (const n of [2, 3]) await li.observe(B, [CLARIFIED('arb', 'network:ARBITRUM')], { conversation: conversation(n), request: 0 }, 'WEB');
    await li.settings(A_SOLANA, { automatic: false });                                                // an objection, nothing else
    await t.db.query(`DELETE FROM learning_memories WHERE term = 'arb'`);                             // e.g. forgotten through an older build
    now = new Date(NOW.getTime() + 91 * DAY);
    await t.db.query(`UPDATE learning_subjects SET last_seen_at = $1`, [new Date(NOW.getTime() + 90 * DAY)]);
    const purged = await store.purge(now);
    expect(purged.evidence).toBe(2);
    expect(await rows(t, `SELECT count(*)::int AS n FROM learning_evidence`)).toEqual([{ n: 0 }]);
    expect(await rows(t, `SELECT enabled FROM learning_automatic_settings`)).toEqual([{ enabled: false }]);
    // The operator purge: after switching from legitimate interest to consent, data of identities without consent is erased.
    for (const n of [4, 5]) await li.observe(A, [SOL_DEV], { conversation: conversation(n), request: 0 }, 'WEB');
    await withMode('CONSENT').settings(B, { automatic: true });
    for (const n of [6, 7]) await withMode('CONSENT').observe(B, [SOL_DEV], { conversation: conversation(n), request: 0 }, 'WEB');
    expect(await store.purgeAutomatic('CONSENT')).toBe(1);
    expect((await rows(t, `SELECT count(DISTINCT subject_id)::int AS n FROM learning_evidence`))[0]!.n).toBe(1);
    expect(await rows(t, `SELECT count(*)::int AS n FROM learning_memories`)).toEqual([{ n: 1 }]);
  });
});

describe('BUILD-CHAT-LEARNING-002 fail-soft and session-only', () => {
  it('on a database without 0014 (a rolling deployment window) nothing throws: the context is unavailable and observations are dropped', async () => {
    const t = await createTestDatabase({ migrated: false });
    opened.push(t);
    await migrate(t.db, (await loadMigrations()).slice(0, 13));
    const service = createLearningService({ config: configFor('LEGITIMATE_INTEREST'), host: { db: t.db, tenantId: 'default' }, now: () => NOW, log: () => undefined });
    // 0013's private memory still works (a v13 table); reading the identity's automatic choice does not, so its context is unavailable.
    expect(await service.apply(A, { op: 'SAVE', entry: { term: 'grana', target: 'asset:USDC', source: 'PRIVATE' } }, 'WEB')).toEqual({ ok: true });
    expect((await service.session(A)).learning.memory).toBe('UNAVAILABLE');
    expect(await service.observe(A, [SOL_DEV], { conversation: conversation(1), request: 0 }, 'WEB')).toEqual([]);
    expect(await service.settings(A, { automatic: true })).toEqual({ ok: false, code: 'LEARNING_UNAVAILABLE' });
  });

  it('session-only adaptation needs no database and stores nothing', () => {
    expect(SESSION_LEARNING).toMatchObject({ memory: 'SESSION', automatic: 'OFF', private: [], global: [] });
    expect(learningConfig({ FLOFI_LEARNING: 'session' })).toEqual({ enabled: false, reason: 'SESSION_ONLY' });
    expect(learningConfig({ FLOFI_LEARNING: 'enabled', FLOFI_LEARNING_SECRET: SECRET, FLOFI_LEARNING_AUTOMATIC: 'always' })).toEqual({ enabled: false, reason: 'INVALID' });
  });
});
