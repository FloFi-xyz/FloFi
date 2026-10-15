// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001 on PostgreSQL (migration 0013): the learning store and service — identity isolation (users, wallet namespaces, channel
 * senders, tenants), no storage on read, memory controls and erasure, contribution opt-in and withdrawal, caps and abuse limits under
 * concurrency, the evaluation-gated append-only glossary, content-free feedback, retention, and fail-soft behaviour without the schema.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { LEARNING_NOTICE_VERSION, learningConfig } from './config.ts';
import { evaluateKnowledge } from './evaluation.ts';
import { contributorDigest, subjectDigest, type LearningPrincipal } from './identity.ts';
import { KNOWLEDGE_SCHEMA, validateKnowledgeDocument } from './knowledge.ts';
import { createLearningService, LEARNING_LIMITS } from './service.ts';
import { createLearningStore, LEARNING_STORE_LIMITS } from './store.ts';

const config = (() => { const c = learningConfig({ FLOFI_LEARNING: 'enabled', FLOFI_LEARNING_SECRET: randomBytes(32).toString('hex') }); if (!c.enabled) throw new Error(c.reason); return c; })();
const NOW = new Date('2026-10-15T12:00:00.000Z');
const wallet = (n: string): LearningPrincipal => ({ kind: 'WALLET', namespace: 'eip155', account: '0x' + n.repeat(40).slice(0, 40) });
const solana = (account: string): LearningPrincipal => ({ kind: 'WALLET', namespace: 'solana', account });
const sender = (n: number): LearningPrincipal => ({ kind: 'CHANNEL', channel: 'TELEGRAM', business: '123456', sender: Buffer.alloc(32, n) });
const A = wallet('a'), B = wallet('b');
const ARB = { op: 'SAVE' as const, entry: { term: 'arb', target: 'network:ARBITRUM' as const, source: 'PRIVATE' as const } };
const opened: TestDatabase[] = [];
afterEach(async () => { await Promise.allSettled(opened.splice(0).map(t => t.drop())); }, 60_000);
async function setup(tenantId = 'default', clock = () => NOW) {
  const t = await createTestDatabase();
  opened.push(t);
  return { t, service: createLearningService({ config, host: { db: t.db, tenantId }, now: clock, log: () => undefined }), store: createLearningStore(t.db, tenantId) };
}
const count = async (t: TestDatabase, table: string) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
const doc = (entries: readonly [string, string][]) => ({ schema: KNOWLEDGE_SCHEMA, entries: entries.map(([term, target]) => ({ term, target, language: 'ANY', candidateId: null })) });

describe('BUILD-CHAT-LEARNING-001 identity isolation', () => {
  it('a meaning saved by A is read only through A’s verified identity — not by B, A’s Solana wallet, a channel sender or another tenant', async () => {
    const { t, service } = await setup();
    expect(await service.apply(A, ARB, 'WEB')).toEqual({ ok: true });
    const mine = await service.session(A);
    expect(mine.learning).toMatchObject({ memory: 'AVAILABLE', private: [{ term: 'arb', target: 'network:ARBITRUM', source: 'PRIVATE' }] });
    for (const other of [B, solana('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), sender(1)])
      expect((await service.session(other)).learning.private).toEqual([]);
    const elsewhere = createLearningService({ config, host: { db: t.db, tenantId: 'other' }, now: () => NOW, log: () => undefined });
    expect((await elsewhere.session(A)).learning.private).toEqual([]);
    // Pseudonymous: no address is stored anywhere in the learning tables.
    const dump = JSON.stringify((await t.db.query(`SELECT * FROM learning_subjects`)).rows) + JSON.stringify((await t.db.query(`SELECT * FROM learning_memories`)).rows);
    expect(dump).not.toContain('aaaaaaaaaa');
    expect((await t.db.query(`SELECT subject_digest FROM learning_subjects`)).rows[0]!.subject_digest).toEqual(subjectDigest(config.keys, A));
  });

  it('reading a context stores nothing; an anonymous session has no durable memory', async () => {
    const { t, service } = await setup();
    expect((await service.session(A)).learning).toMatchObject({ memory: 'AVAILABLE', private: [] });
    expect((await service.session(null)).learning).toMatchObject({ memory: 'ANONYMOUS', owner: null, private: [] });
    expect(await count(t, 'learning_subjects')).toBe(0);
    expect(await service.apply(null, ARB, 'WEB')).toEqual({ ok: false, code: 'LEARNING_IDENTITY_REQUIRED' });
  });

  it('identity switching in one browser: the EVM and Solana sessions keep separate memories', async () => {
    const { service } = await setup();
    const sol = solana('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
    await service.apply(A, ARB, 'WEB');
    await service.apply(sol, { op: 'SAVE', entry: { term: 'sol dev', target: 'network:SOLANA_DEVNET', source: 'PRIVATE' } }, 'WEB');
    expect((await service.session(A)).learning.private.map(e => e.term)).toEqual(['arb']);
    expect((await service.session(sol)).learning.private.map(e => e.term)).toEqual(['sol dev']);
  });
});

describe('BUILD-CHAT-LEARNING-001 memory controls', () => {
  it('forget, pause/resume and erase-all; a paused memory is neither used nor written', async () => {
    const { t, service } = await setup();
    await service.apply(A, ARB, 'WEB');
    await service.apply(A, { op: 'SAVE', entry: { term: 'grana', target: 'asset:USDC', source: 'PRIVATE' } }, 'WEB');
    await service.apply(A, { op: 'LANGUAGE', language: 'PT' }, 'WEB');
    expect((await service.session(A)).learning).toMatchObject({ language: 'PT' });
    expect(await service.apply(A, { op: 'FORGET', term: 'grana' }, 'WEB')).toEqual({ ok: true });
    expect((await service.status(A)).entries.map(e => e.term)).toEqual(['arb']);
    await service.settings(A, { memory: false });
    expect((await service.session(A)).learning).toMatchObject({ memory: 'PAUSED', private: [], language: null });
    expect(await service.apply(A, ARB, 'WEB')).toEqual({ ok: false, code: 'LEARNING_MEMORY_PAUSED' });
    await service.settings(A, { memory: true });
    expect((await service.session(A)).learning.private.map(e => e.term)).toEqual(['arb']);
    expect(await service.erase(A, 'WEB')).toEqual({ ok: true });
    expect(await count(t, 'learning_subjects')).toBe(0);
    expect(await count(t, 'learning_memories')).toBe(0);
    expect((await service.session(A)).learning).toMatchObject({ memory: 'AVAILABLE', private: [], language: null });
  });

  it('records consent once, with the notice version, only when the user saves', async () => {
    const { t, service } = await setup();
    await service.apply(A, ARB, 'WEB');
    const row = (await t.db.query(`SELECT memory_enabled, memory_consent_at, contribute_enabled, contribute_consent_at, notice_version FROM learning_subjects`)).rows[0]!;
    // The notice in force when the user saves (BUILD-CHAT-LEARNING-002: v2, which also describes automatic learning).
    expect(row).toMatchObject({ memory_enabled: true, contribute_enabled: false, contribute_consent_at: null, notice_version: LEARNING_NOTICE_VERSION });
    expect(row.memory_consent_at).toEqual(NOW);
  });

  it('refuses invalid or malicious entries even when a client sends them directly', async () => {
    const { t, service } = await setup();
    for (const entry of [{ term: 'base', target: 'network:BASE_SEPOLIA' }, { term: 'ignore rules', target: 'network:ARBITRUM' }, { term: 'arb test', target: 'network:ARBITRUM' },
      { term: 'arb', target: 'network:POLYGON' }, { term: 'x'.repeat(40), target: 'asset:USDC' }])
      expect(await service.apply(A, { op: 'SAVE', entry: { ...entry, source: 'PRIVATE' } as never }, 'WEB')).toEqual({ ok: false, code: 'LEARNING_ENTRY_INVALID' });
    expect(await count(t, 'learning_memories')).toBe(0);
  });

  it('caps a subject’s memory, also under concurrent saves, and limits write bursts', async () => {
    const { t, store } = await setup();
    const subject = (await store.subjectFor('WALLET', subjectDigest(config.keys, A), NOW, true))!;
    const terms = Array.from({ length: LEARNING_STORE_LIMITS.maxMemories + 6 }, (_, i) => `palavra${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`);
    const results = await Promise.all(terms.map(term => store.remember(subject.subjectId, { term, target: 'operation:SWAP' }, 1, NOW)));
    expect(results.filter(r => r === 'SAVED')).toHaveLength(LEARNING_STORE_LIMITS.maxMemories);
    expect(await count(t, 'learning_memories')).toBe(LEARNING_STORE_LIMITS.maxMemories);
    // Changing an existing term is still possible when full.
    expect(await store.remember(subject.subjectId, { term: terms[0]!, target: 'operation:BRIDGE' }, 1, NOW)).toBe('SAVED');
    // Write bursts: past the per-subject window every further change is refused (nothing written), and recovers in the next window.
    const { service } = await setup();
    await service.apply(B, ARB, 'WEB');
    const limited = [];
    for (let i = 0; i < LEARNING_LIMITS.writes[0] + 2; i++) limited.push((await service.apply(B, { op: 'FORGET', term: 'nada' }, 'WEB')).ok);
    expect(limited).toContain(false);
  });
});

describe('BUILD-CHAT-LEARNING-001 contributions to the shared glossary (separate opt-in)', () => {
  it('counts distinct pseudonymous contributors once, withdraws them on opt-out or erasure, and never changes a decision', async () => {
    const { t, service, store } = await setup();
    await service.apply(A, ARB, 'WEB'); // no contribution without the separate opt-in
    expect(await count(t, 'learning_candidates')).toBe(0);
    await service.settings(A, { contribute: true });
    await service.settings(B, { contribute: true });
    await service.apply(A, ARB, 'WEB');
    await service.apply(A, ARB, 'WEB');
    await service.apply(B, ARB, 'WEB');
    const [arb] = await store.candidates('PENDING');
    expect(arb).toMatchObject({ term: 'arb', target: 'network:ARBITRUM', origin: 'CONTRIBUTION', state: 'PENDING', support: 2 });
    await service.settings(A, { contribute: false });
    expect((await store.candidate(arb!.candidateId))!.support).toBe(1);
    await store.decide(arb!.candidateId, 'REJECTED', 'cli', 'mainnet abbreviation: suggestion only', NOW);
    await service.settings(A, { contribute: true });
    await service.apply(A, ARB, 'WEB');
    expect(await store.candidate(arb!.candidateId)).toMatchObject({ state: 'REJECTED', support: 2 });
    await service.erase(B, 'WEB');
    expect((await store.candidate(arb!.candidateId))!.support).toBe(1);
    const subjectA = (await store.subjectFor('WALLET', subjectDigest(config.keys, A), NOW, false))!;
    expect((await t.db.query(`SELECT count(*)::int AS n FROM learning_candidate_support WHERE contributor_digest = $1`, [contributorDigest(config.keys, subjectA.subjectId)]))
      .rows[0]!.n).toBe(1);
  });

  it('enforces the candidate state machine in the database', async () => {
    const { store } = await setup();
    const c = await store.addCandidate({ term: 'trocar', target: 'operation:SWAP', language: 'PT' }, 'cli', NOW);
    await expect(store.addCandidate({ term: 'trocar', target: 'operation:SWAP', language: 'PT' }, 'cli', NOW)).rejects.toThrow('LEARNING_CANDIDATE_EXISTS');
    expect(await store.decide(c.candidateId, 'APPROVED', 'cli', null, NOW)).toMatchObject({ state: 'APPROVED', decidedBy: 'cli' });
    expect(await store.decide(c.candidateId, 'REJECTED', 'cli', 'retracted', NOW)).toMatchObject({ state: 'REJECTED' });
    await expect(store.decide(c.candidateId, 'APPROVED', 'cli', null, NOW)).rejects.toThrow('LEARNING_CANDIDATE_TRANSITION_INVALID');
    expect(await store.decide(c.candidateId, 'PENDING', 'cli', 'reopened', NOW)).toMatchObject({ state: 'PENDING', decidedBy: null, decidedAt: null });
  });
});

describe('BUILD-CHAT-LEARNING-001 the evaluation-gated, append-only glossary', () => {
  it('publishes only with a passing evaluation of exactly that document; gapless; append-only; disable and rollback are new versions', async () => {
    const { t, service, store } = await setup();
    const good = validateKnowledgeDocument(doc([['eth sepolia', 'network:ETHEREUM_SEPOLIA']])), other = validateKnowledgeDocument(doc([['arb sep', 'network:ARBITRUM_SEPOLIA']]));
    const passing = await store.recordEvaluation({ purpose: 'PUBLISH', baseVersion: null, document: good, corpus: 'learning-corpus.v1', passed: true,
      result: evaluateKnowledge(good, null), createdBy: 'cli' }, NOW);
    const failing = await store.recordEvaluation({ purpose: 'PUBLISH', baseVersion: null, document: other, corpus: 'learning-corpus.v1', passed: false, result: {}, createdBy: 'cli' }, NOW);
    await expect(store.appendKnowledge({ expectedVersion: 0, document: other, evaluationId: failing.evaluationId, restoredFrom: null, createdBy: 'cli', reason: null }, NOW))
      .rejects.toThrow('LEARNING_EVALUATION_REQUIRED');
    await expect(store.appendKnowledge({ expectedVersion: 0, document: other, evaluationId: passing.evaluationId, restoredFrom: null, createdBy: 'cli', reason: null }, NOW))
      .rejects.toThrow('LEARNING_EVALUATION_REQUIRED'); // a passing evaluation of a DIFFERENT document
    const v1 = await store.appendKnowledge({ expectedVersion: 0, document: good, evaluationId: passing.evaluationId, restoredFrom: null, createdBy: 'cli', reason: 'first' }, NOW);
    expect(v1).toMatchObject({ version: 1, documentSha256: passing.documentSha256 });
    await expect(store.appendKnowledge({ expectedVersion: 0, document: null, evaluationId: null, restoredFrom: null, createdBy: 'cli', reason: null }, NOW))
      .rejects.toThrow('LEARNING_KNOWLEDGE_VERSION_CONFLICT');
    expect((await service.session(B)).learning).toMatchObject({ global: [{ term: 'eth sepolia', source: 'GLOBAL', version: 1 }], globalVersion: 1 });
    await store.appendKnowledge({ expectedVersion: 1, document: null, evaluationId: null, restoredFrom: null, createdBy: 'cli', reason: 'disable' }, NOW);
    expect((await service.session(B)).learning).toMatchObject({ global: [], globalVersion: 2 });
    for (const sql of [`UPDATE learning_knowledge_versions SET reason = 'x'`, `DELETE FROM learning_knowledge_versions`, `UPDATE learning_evaluations SET passed = true`,
      `DELETE FROM learning_evaluations`]) await expect(t.db.query(sql)).rejects.toThrow(/APPEND_ONLY_VIOLATION/);
  });

  it('an invalid stored document is never served (fail closed: no glossary), and the break-glass switch stops serving any', async () => {
    const { t, service, store } = await setup();
    const bad = { schema: KNOWLEDGE_SCHEMA, entries: [{ term: 'base', target: 'network:BASE_SEPOLIA', language: 'ANY', candidateId: null }] };
    const evaluation = await store.recordEvaluation({ purpose: 'PUBLISH', baseVersion: null, document: bad, corpus: 'learning-corpus.v1', passed: true, result: {}, createdBy: 'cli' }, NOW);
    await store.appendKnowledge({ expectedVersion: 0, document: bad, evaluationId: evaluation.evaluationId, restoredFrom: null, createdBy: 'cli', reason: null }, NOW);
    expect((await service.session(A)).learning).toMatchObject({ global: [], globalVersion: 1 });
    const good = validateKnowledgeDocument(doc([['eth sepolia', 'network:ETHEREUM_SEPOLIA']]));
    const passing = await store.recordEvaluation({ purpose: 'PUBLISH', baseVersion: 1, document: good, corpus: 'learning-corpus.v1', passed: true, result: {}, createdBy: 'cli' }, NOW);
    await store.appendKnowledge({ expectedVersion: 1, document: good, evaluationId: passing.evaluationId, restoredFrom: null, createdBy: 'cli', reason: null }, NOW);
    const off = learningConfig({ FLOFI_LEARNING: 'enabled', FLOFI_LEARNING_SECRET: 'b'.repeat(40), FLOFI_LEARNING_GLOBAL: 'disabled' });
    if (!off.enabled) throw new Error('config');
    expect((await createLearningService({ config: off, host: { db: t.db, tenantId: 'default' }, now: () => NOW, log: () => undefined }).session(A)).learning.global).toEqual([]);
  });
});

describe('BUILD-CHAT-LEARNING-001 feedback, retention and fail-soft', () => {
  it('records content-free events only (unknown kinds dropped, rows immutable)', async () => {
    const { t, service } = await setup();
    await service.record('WEB', [{ kind: 'TURN', outcome: 'PROPOSAL', language: 'PT', privateEntries: 1, globalEntries: 0, knowledgeVersion: null },
      { kind: 'NOT_A_KIND' as never }, { kind: 'PROPOSAL_APPLIED' }]);
    const rows = (await t.db.query(`SELECT scope, kind, evidence, outcome, language, private_entries FROM learning_feedback_events ORDER BY event_id`)).rows;
    expect(rows).toEqual([{ scope: 'WEB', kind: 'TURN', evidence: 'OBSERVED', outcome: 'PROPOSAL', language: 'PT', private_entries: 1 },
      { scope: 'WEB', kind: 'PROPOSAL_APPLIED', evidence: 'OBSERVED', outcome: null, language: null, private_entries: 0 }]);
    await expect(t.db.query(`UPDATE learning_feedback_events SET outcome = 'X1'`)).rejects.toThrow(/APPEND_ONLY_VIOLATION/);
  });

  it('erases what outlived its retention period, in bounded batches, and keeps the rest', async () => {
    const { t, store } = await setup();
    const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
    const keep = (await store.subjectFor('WALLET', subjectDigest(config.keys, A), NOW, true))!;
    await store.remember(keep.subjectId, { term: 'arb', target: 'network:ARBITRUM' }, 1, NOW);
    await store.remember(keep.subjectId, { term: 'velho', target: 'operation:SWAP' }, 1, days(366));
    await t.db.query(`UPDATE learning_memories SET touched_at = $1 WHERE term = 'velho'`, [days(366)]);
    await store.subjectFor('WALLET', subjectDigest(config.keys, B), days(31), true); // never consented, idle 31 days
    await store.subjectFor('CHANNEL', subjectDigest(config.keys, sender(9)), days(731), true);
    await store.record([{ scope: 'WEB', kind: 'TURN', evidence: 'OBSERVED' }], days(91));
    await store.record([{ scope: 'WEB', kind: 'TURN', evidence: 'OBSERVED' }], NOW);
    const c = await store.contribute({ term: 'trocar', target: 'operation:SWAP', language: 'PT' }, Buffer.alloc(32, 1), days(181));
    expect(c).toBe('COUNTED');
    await t.db.query(`INSERT INTO mcp_rate_limits (tenant_id, bucket, window_start, count) VALUES ('default', 'learning:write:x', $1, 1), ('default', 'channel:keep', $1, 1)`, [days(3)]);
    const purged = await store.purge(NOW);
    expect(purged).toEqual({ events: 1, memories: 1, evidence: 0, subjects: 2, support: 1, candidates: 1, rateWindows: 1 });
    expect((await t.db.query(`SELECT term FROM learning_memories`)).rows).toEqual([{ term: 'arb' }]);
    expect(await count(t, 'learning_subjects')).toBe(1);
    expect(await count(t, 'learning_feedback_events')).toBe(1);
    expect((await t.db.query(`SELECT bucket FROM mcp_rate_limits`)).rows).toEqual([{ bucket: 'channel:keep' }]);
  });

  it('fail-soft: on a database without migration 0013 (a rolling deployment window) the context is UNAVAILABLE and nothing throws', async () => {
    const t = await createTestDatabase({ migrated: false });
    opened.push(t);
    await migrate(t.db, (await loadMigrations()).slice(0, 12));
    const service = createLearningService({ config, host: { db: t.db, tenantId: 'default' }, now: () => NOW, log: () => undefined });
    expect((await service.session(A)).learning).toEqual({ memory: 'UNAVAILABLE', owner: null, private: [], global: [], globalVersion: null, language: null });
    expect(await service.apply(A, ARB, 'WEB')).toEqual({ ok: false, code: 'LEARNING_UNAVAILABLE' });
    await expect(service.record('WEB', [{ kind: 'TURN' }])).resolves.toBeUndefined();
  });
});
