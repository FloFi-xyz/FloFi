// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: the learning tables (migration 0013) behind one PostgreSQL store. Every query is scoped to one tenant; every read is
 * bounded; private memory is read and written only by subject id, which callers obtain only from a verified identity (`identity.ts`). The
 * store never sees an address, a text or a key: subjects and contributors arrive as keyed digests.
 */
import { isUniqueViolation, type Database, type Queryable } from '@defi-workflow-engine/cloud-runtime';
import { LEXICON_LIMITS, type LexiconTarget } from '../domain/copilot-lexicon.ts';
import { typedId } from '../platform/ids.ts';

export type SubjectKind = 'WALLET' | 'CHANNEL';
export type LearningLanguage = 'EN' | 'PT';
export type Subject = { readonly subjectId: string; readonly kind: SubjectKind; readonly memoryEnabled: boolean; readonly contributeEnabled: boolean;
  readonly language: LearningLanguage | null; readonly memoryConsentAt: string | null; readonly contributeConsentAt: string | null; readonly noticeVersion: number | null };
export type MemoryRow = { readonly term: string; readonly target: string; readonly createdAt: string; readonly touchedAt: string };
export type CandidateState = 'PENDING' | 'APPROVED' | 'REJECTED';
export type Candidate = { readonly candidateId: string; readonly term: string; readonly target: string; readonly language: 'EN' | 'PT' | 'ANY';
  readonly origin: 'CONTRIBUTION' | 'OPERATOR'; readonly state: CandidateState; readonly support: number; readonly firstSeenAt: string; readonly lastSeenAt: string;
  readonly decidedBy: string | null; readonly decidedAt: string | null; readonly reason: string | null };
export type KnowledgeVersion = { readonly version: number; readonly document: unknown; readonly documentSha256: string | null; readonly evaluationId: string | null;
  readonly restoredFrom: number | null; readonly createdBy: string; readonly reason: string | null; readonly createdAt: string };
export type EvaluationRow = { readonly evaluationId: string; readonly at: string; readonly purpose: 'DRY_RUN' | 'PUBLISH' | 'ROLLBACK'; readonly baseVersion: number | null;
  readonly documentSha256: string; readonly corpus: string; readonly passed: boolean; readonly result: unknown; readonly createdBy: string };
export type FeedbackEvent = { readonly scope: 'WEB' | 'TELEGRAM' | 'WHATSAPP'; readonly kind: string; readonly evidence: 'OBSERVED' | 'USER_ASSERTED' | 'SYSTEM';
  readonly outcome?: string | null; readonly language?: LearningLanguage | null; readonly privateEntries?: number; readonly globalEntries?: number;
  readonly knowledgeVersion?: number | null };

export const LEARNING_RETENTION = Object.freeze({ eventsDays: 90, supportDays: 180, pendingCandidateDays: 180, memoryDays: 365, unconsentedSubjectDays: 30,
  subjectDays: 730, rateWindowDays: 2, batch: 1_000 });
export const LEARNING_STORE_LIMITS = Object.freeze({ maxMemories: LEXICON_LIMITS.maxPrivate, maxPendingContributions: 1_000, maxEventsPerWrite: 8, seenEveryMs: 3_600_000 });
const KIND = /^[A-Z][A-Z_]{2,40}$/, OUTCOME = /^[A-Z][A-Z0-9_]{1,60}$/, ACTOR = /^(adm_[a-z2-7]{26}|cli)$/, REASON = /^[^\p{Cc}]{1,200}$/u;

type SubjectRecord = { subject_id: string; kind: SubjectKind; memory_enabled: boolean; contribute_enabled: boolean; language: LearningLanguage | null;
  memory_consent_at: Date | null; contribute_consent_at: Date | null; notice_version: number | null; last_seen_at: Date };
const subject = (row: SubjectRecord): Subject => ({ subjectId: row.subject_id, kind: row.kind, memoryEnabled: row.memory_enabled, contributeEnabled: row.contribute_enabled,
  language: row.language, memoryConsentAt: row.memory_consent_at?.toISOString() ?? null, contributeConsentAt: row.contribute_consent_at?.toISOString() ?? null,
  noticeVersion: row.notice_version });
const SUBJECT_COLUMNS = 'subject_id, kind, memory_enabled, contribute_enabled, language, memory_consent_at, contribute_consent_at, notice_version, last_seen_at';
type CandidateRecord = { candidate_id: string; term: string; target: string; language: Candidate['language']; origin: Candidate['origin']; state: CandidateState; support: number;
  first_seen_at: Date; last_seen_at: Date; decided_by: string | null; decided_at: Date | null; reason: string | null };
const candidate = (row: CandidateRecord): Candidate => ({ candidateId: row.candidate_id, term: row.term, target: row.target, language: row.language, origin: row.origin,
  state: row.state, support: row.support, firstSeenAt: row.first_seen_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(), decidedBy: row.decided_by,
  decidedAt: row.decided_at?.toISOString() ?? null, reason: row.reason });
const CANDIDATE_COLUMNS = 'candidate_id, term, target, language, origin, state, support, first_seen_at, last_seen_at, decided_by, decided_at, reason';
type VersionRecord = { version: number; document: unknown; document_sha256: string | null; evaluation_id: string | null; restored_from: number | null; created_by: string;
  reason: string | null; created_at: Date };
const versionOf = (row: VersionRecord): KnowledgeVersion => ({ version: row.version, document: row.document, documentSha256: row.document_sha256, evaluationId: row.evaluation_id,
  restoredFrom: row.restored_from, createdBy: row.created_by, reason: row.reason, createdAt: row.created_at.toISOString() });
const VERSION_COLUMNS = 'version, document, document_sha256, evaluation_id::text, restored_from, created_by, reason, created_at';
const limitOf = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 ? Math.min(value, max) : Math.min(25, max);
/** Recounts the support of candidates (distinct contributors still on record). */
const recount = (tx: Queryable, tenantId: string, ids: readonly string[]) => ids.length ? tx.query(`UPDATE learning_candidates c SET support =
  (SELECT count(*) FROM learning_candidate_support s WHERE s.tenant_id = c.tenant_id AND s.candidate_id = c.candidate_id) WHERE c.tenant_id = $1 AND c.candidate_id = ANY($2)`,
  [tenantId, ids]) : Promise.resolve();

export function createLearningStore(db: Database, tenantId: string) {
  const store = {
    // ── Subjects and private memory ─────────────────────────────────────────────────────────────────────────────────────────────────
    /**
     * The subject of a digest, refreshing last_seen_at at most hourly. `create`: created on first use (no consent implied: both purposes start
     * off); otherwise null when there is none (reading a context never stores anything).
     */
    async subjectFor(kind: SubjectKind, digest: Buffer, now: Date, create: boolean): Promise<Subject | null> {
      if (digest.length !== 32) throw new Error('LEARNING_SUBJECT_INVALID');
      const found = await db.query<SubjectRecord>(`SELECT ${SUBJECT_COLUMNS} FROM learning_subjects WHERE tenant_id = $1 AND subject_digest = $2`, [tenantId, digest]);
      if (found.rows[0]) {
        if (found.rows[0].kind !== kind) throw new Error('LEARNING_SUBJECT_INVALID');
        if (now.getTime() - found.rows[0].last_seen_at.getTime() > LEARNING_STORE_LIMITS.seenEveryMs)
          await db.query(`UPDATE learning_subjects SET last_seen_at = $3 WHERE tenant_id = $1 AND subject_id = $2`, [tenantId, found.rows[0].subject_id, now]);
        return subject(found.rows[0]);
      }
      if (!create) return null;
      await db.query(`INSERT INTO learning_subjects (tenant_id, subject_id, kind, subject_digest, created_at, updated_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $5, $5)
        ON CONFLICT (tenant_id, subject_digest) DO NOTHING`, [tenantId, typedId('lsb'), kind, digest, now]);
      const { rows } = await db.query<SubjectRecord>(`SELECT ${SUBJECT_COLUMNS} FROM learning_subjects WHERE tenant_id = $1 AND subject_digest = $2`, [tenantId, digest]);
      if (!rows[0] || rows[0].kind !== kind) throw new Error('LEARNING_SUBJECT_INVALID');
      return subject(rows[0]);
    },
    async memories(subjectId: string): Promise<MemoryRow[]> {
      const { rows } = await db.query<{ term: string; target: string; created_at: Date; touched_at: Date }>(`SELECT term, target, created_at, touched_at FROM learning_memories
        WHERE tenant_id = $1 AND subject_id = $2 ORDER BY term LIMIT $3`, [tenantId, subjectId, LEARNING_STORE_LIMITS.maxMemories]);
      return rows.map(row => ({ term: row.term, target: row.target, createdAt: row.created_at.toISOString(), touchedAt: row.touched_at.toISOString() }));
    },
    /**
     * Saves one meaning after the user's explicit "Remember": records the memory consent (when not already given) and upserts the entry, under
     * the subject's row lock so the per-subject cap holds under concurrency. 'FULL' when the cap is reached (an existing term may still change).
     */
    async remember(subjectId: string, entry: { readonly term: string; readonly target: LexiconTarget }, noticeVersion: number, now: Date): Promise<'SAVED' | 'FULL'> {
      return db.transaction(async tx => {
        const locked = await tx.query(`UPDATE learning_subjects SET memory_enabled = true, memory_consent_at = coalesce(memory_consent_at, $3),
          notice_version = coalesce(notice_version, $4), updated_at = $3, last_seen_at = $3 WHERE tenant_id = $1 AND subject_id = $2 RETURNING subject_id`,
        [tenantId, subjectId, now, noticeVersion]);
        if (!locked.rows[0]) throw new Error('LEARNING_SUBJECT_INVALID');
        const { rows } = await tx.query<{ n: number; same: boolean }>(`SELECT count(*)::int AS n, bool_or(term = $3) AS same FROM learning_memories
          WHERE tenant_id = $1 AND subject_id = $2`, [tenantId, subjectId, entry.term]);
        if (!rows[0]?.same && (rows[0]?.n ?? 0) >= LEARNING_STORE_LIMITS.maxMemories) return 'FULL';
        await tx.query(`INSERT INTO learning_memories (tenant_id, subject_id, term, target, created_at, touched_at) VALUES ($1, $2, $3, $4, $5, $5)
          ON CONFLICT (tenant_id, subject_id, term) DO UPDATE SET target = EXCLUDED.target, touched_at = EXCLUDED.touched_at`, [tenantId, subjectId, entry.term, entry.target, now]);
        return 'SAVED';
      });
    },
    async forget(subjectId: string, term: string): Promise<boolean> {
      const { rowCount } = await db.query(`DELETE FROM learning_memories WHERE tenant_id = $1 AND subject_id = $2 AND term = $3`, [tenantId, subjectId, term]);
      return rowCount === 1;
    },
    /** Marks entries a turn used (their retention restarts). Bounded to the subject's own terms. */
    async touch(subjectId: string, terms: readonly string[], now: Date): Promise<void> {
      if (!terms.length) return;
      await db.query(`UPDATE learning_memories SET touched_at = $4 WHERE tenant_id = $1 AND subject_id = $2 AND term = ANY($3) AND touched_at < $4 - interval '1 day'`,
        [tenantId, subjectId, terms.slice(0, LEXICON_LIMITS.maxGlossary), now]);
    },
    /** The saved reply language (null clears it). Saving one is a memory: it records the memory consent like `remember`. */
    async setLanguage(subjectId: string, language: LearningLanguage | null, noticeVersion: number, now: Date): Promise<void> {
      const { rowCount } = await db.query(language === null
        ? `UPDATE learning_subjects SET language = NULL, updated_at = $3 WHERE tenant_id = $1 AND subject_id = $2`
        : `UPDATE learning_subjects SET language = $5, memory_enabled = true, memory_consent_at = coalesce(memory_consent_at, $3), notice_version = coalesce(notice_version, $4),
            updated_at = $3 WHERE tenant_id = $1 AND subject_id = $2`, language === null ? [tenantId, subjectId, now] : [tenantId, subjectId, now, noticeVersion, language]);
      if (rowCount !== 1) throw new Error('LEARNING_SUBJECT_INVALID');
    },
    /** Pauses or resumes private memory (entries are kept, but not used, while paused). Resuming records consent if none was given. */
    async setMemoryEnabled(subjectId: string, enabled: boolean, noticeVersion: number, now: Date): Promise<void> {
      const { rowCount } = await db.query(`UPDATE learning_subjects SET memory_enabled = $3, memory_consent_at = CASE WHEN $3 THEN coalesce(memory_consent_at, $4) ELSE memory_consent_at END,
        notice_version = CASE WHEN $3 THEN coalesce(notice_version, $5) ELSE notice_version END, updated_at = $4 WHERE tenant_id = $1 AND subject_id = $2`,
      [tenantId, subjectId, enabled, now, noticeVersion]);
      if (rowCount !== 1) throw new Error('LEARNING_SUBJECT_INVALID');
    },
    /**
     * Opts in to, or out of, contributing generalized meanings to the shared glossary. Opting out also withdraws this contributor's past support
     * (`contributor` is their keyed digest), so nothing they contributed keeps counting.
     */
    async setContribute(subjectId: string, enabled: boolean, contributor: Buffer, noticeVersion: number, now: Date): Promise<void> {
      await db.transaction(async tx => {
        const { rowCount } = await tx.query(`UPDATE learning_subjects SET contribute_enabled = $3,
          contribute_consent_at = CASE WHEN $3 THEN coalesce(contribute_consent_at, $4) ELSE contribute_consent_at END,
          notice_version = CASE WHEN $3 THEN coalesce(notice_version, $5) ELSE notice_version END, updated_at = $4 WHERE tenant_id = $1 AND subject_id = $2`,
        [tenantId, subjectId, enabled, now, noticeVersion]);
        if (rowCount !== 1) throw new Error('LEARNING_SUBJECT_INVALID');
        if (!enabled) await withdrawSupport(tx, contributor);
      });
    },
    /** Erases everything about a subject: every memory and setting (cascade) and the contributor's support. Returns whether a subject existed. */
    async erase(subjectId: string, contributor: Buffer): Promise<boolean> {
      return db.transaction(async tx => {
        await withdrawSupport(tx, contributor);
        const { rowCount } = await tx.query(`DELETE FROM learning_subjects WHERE tenant_id = $1 AND subject_id = $2`, [tenantId, subjectId]);
        return rowCount === 1;
      });
    },

    // ── Content-free feedback ──────────────────────────────────────────────────────────────────────────────────────────────────────
    async record(events: readonly FeedbackEvent[], now: Date): Promise<number> {
      const valid = events.slice(0, LEARNING_STORE_LIMITS.maxEventsPerWrite).filter(e => KIND.test(e.kind) && (e.outcome == null || OUTCOME.test(e.outcome)));
      if (!valid.length) return 0;
      const values: unknown[] = [], rows: string[] = [];
      for (const e of valid) {
        const at = values.length;
        values.push(tenantId, now, e.scope, e.kind, e.evidence, e.outcome ?? null, e.language ?? null, Math.min(64, Math.max(0, e.privateEntries ?? 0)),
          Math.min(64, Math.max(0, e.globalEntries ?? 0)), e.knowledgeVersion ?? null);
        rows.push(`(${Array.from({ length: 10 }, (_, i) => `$${at + i + 1}`).join(', ')})`);
      }
      const { rowCount } = await db.query(`INSERT INTO learning_feedback_events (tenant_id, at, scope, kind, evidence, outcome, language, private_entries, global_entries,
        knowledge_version) VALUES ${rows.join(', ')}`, values);
      return rowCount;
    },

    // ── Global glossary candidates ─────────────────────────────────────────────────────────────────────────────────────────────────
    /**
     * A user's opt-in contribution of one generalized meaning: the candidate (created PENDING) and this contributor's support, once. Never
     * changes a decided candidate's state. 'FULL' when too many contributions await review.
     */
    async contribute(entry: { readonly term: string; readonly target: LexiconTarget; readonly language: Candidate['language'] }, contributor: Buffer, now: Date):
      Promise<'COUNTED' | 'ALREADY' | 'FULL'> {
      return db.transaction(async tx => {
        let id = (await tx.query<{ candidate_id: string }>(`SELECT candidate_id FROM learning_candidates WHERE tenant_id = $1 AND term = $2 AND target = $3`,
          [tenantId, entry.term, entry.target])).rows[0]?.candidate_id;
        if (!id) {
          const pending = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM learning_candidates WHERE tenant_id = $1 AND state = 'PENDING' AND origin = 'CONTRIBUTION'`,
            [tenantId])).rows[0]?.n ?? 0;
          if (pending >= LEARNING_STORE_LIMITS.maxPendingContributions) return 'FULL';
          id = typedId('lkc');
          await tx.query(`INSERT INTO learning_candidates (tenant_id, candidate_id, term, target, language, origin, first_seen_at, last_seen_at)
            VALUES ($1, $2, $3, $4, $5, 'CONTRIBUTION', $6, $6) ON CONFLICT (tenant_id, term, target) DO NOTHING`, [tenantId, id, entry.term, entry.target, entry.language, now]);
          id = (await tx.query<{ candidate_id: string }>(`SELECT candidate_id FROM learning_candidates WHERE tenant_id = $1 AND term = $2 AND target = $3`,
            [tenantId, entry.term, entry.target])).rows[0]!.candidate_id;
        }
        const added = await tx.query(`INSERT INTO learning_candidate_support (tenant_id, candidate_id, contributor_digest, at) VALUES ($1, $2, $3, $4)
          ON CONFLICT DO NOTHING`, [tenantId, id, contributor, now]);
        if (!added.rowCount) return 'ALREADY';
        await tx.query(`UPDATE learning_candidates SET support = support + 1, last_seen_at = $3 WHERE tenant_id = $1 AND candidate_id = $2`, [tenantId, id, now]);
        return 'COUNTED';
      });
    },
    /** An operator's own candidate (created PENDING; it still needs a decision and a passing evaluation). */
    async addCandidate(entry: { readonly term: string; readonly target: LexiconTarget; readonly language: Candidate['language'] }, actor: string, now: Date): Promise<Candidate> {
      if (!ACTOR.test(actor)) throw new Error('LEARNING_ACTOR_INVALID');
      try {
        const { rows } = await db.query<CandidateRecord>(`INSERT INTO learning_candidates (tenant_id, candidate_id, term, target, language, origin, created_by, first_seen_at, last_seen_at)
          VALUES ($1, $2, $3, $4, $5, 'OPERATOR', $6, $7, $7) RETURNING ${CANDIDATE_COLUMNS}`, [tenantId, typedId('lkc'), entry.term, entry.target, entry.language, actor, now]);
        return candidate(rows[0]!);
      } catch (error) { if (isUniqueViolation(error)) throw new Error('LEARNING_CANDIDATE_EXISTS', { cause: error }); throw error; }
    },
    async candidate(candidateId: string): Promise<Candidate | null> {
      const { rows } = await db.query<CandidateRecord>(`SELECT ${CANDIDATE_COLUMNS} FROM learning_candidates WHERE tenant_id = $1 AND candidate_id = $2`, [tenantId, candidateId]);
      return rows[0] ? candidate(rows[0]) : null;
    },
    /** Moves a candidate along its state machine (the database refuses any other transition). */
    async decide(candidateId: string, state: CandidateState, actor: string, reason: string | null, now: Date): Promise<Candidate> {
      if (!ACTOR.test(actor) || (reason !== null && !REASON.test(reason))) throw new Error('LEARNING_DECISION_INVALID');
      try {
        const { rows } = await db.query<CandidateRecord>(`UPDATE learning_candidates SET state = $3, decided_by = CASE WHEN $3 = 'PENDING' THEN NULL ELSE $4 END,
          decided_at = CASE WHEN $3 = 'PENDING' THEN NULL ELSE $5::timestamptz END, reason = $6 WHERE tenant_id = $1 AND candidate_id = $2 RETURNING ${CANDIDATE_COLUMNS}`,
        [tenantId, candidateId, state, actor, now, reason]);
        if (!rows[0]) throw new Error('LEARNING_CANDIDATE_NOT_FOUND');
        return candidate(rows[0]);
      } catch (error) {
        if (error instanceof Error && /LEARNING_CANDIDATE_TRANSITION_INVALID/.test(error.message)) throw new Error('LEARNING_CANDIDATE_TRANSITION_INVALID', { cause: error });
        throw error;
      }
    },
    async candidates(state: CandidateState | null, limit = 50): Promise<Candidate[]> {
      const { rows } = await db.query<CandidateRecord>(`SELECT ${CANDIDATE_COLUMNS} FROM learning_candidates WHERE tenant_id = $1 AND ($2::text IS NULL OR state = $2)
        ORDER BY state, support DESC, last_seen_at DESC, candidate_id LIMIT $3`, [tenantId, state, limitOf(limit, 200)]);
      return rows.map(candidate);
    },
    /** Every APPROVED candidate (bounded by the glossary size): what the next published version may contain. */
    async approved(): Promise<Candidate[]> {
      const { rows } = await db.query<CandidateRecord>(`SELECT ${CANDIDATE_COLUMNS} FROM learning_candidates WHERE tenant_id = $1 AND state = 'APPROVED'
        ORDER BY term LIMIT $2`, [tenantId, LEXICON_LIMITS.maxGlobal + 1]);
      return rows.map(candidate);
    },

    // ── Published versions and evaluations ─────────────────────────────────────────────────────────────────────────────────────────
    async activeKnowledge(): Promise<KnowledgeVersion | null> {
      const { rows } = await db.query<VersionRecord>(`SELECT ${VERSION_COLUMNS} FROM learning_knowledge_versions WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`, [tenantId]);
      return rows[0] ? versionOf(rows[0]) : null;
    },
    async knowledgeVersion(version: number): Promise<KnowledgeVersion | null> {
      if (!Number.isSafeInteger(version) || version < 1) return null;
      const { rows } = await db.query<VersionRecord>(`SELECT ${VERSION_COLUMNS} FROM learning_knowledge_versions WHERE tenant_id = $1 AND version = $2`, [tenantId, version]);
      return rows[0] ? versionOf(rows[0]) : null;
    },
    async knowledgeHistory(limit = 25): Promise<KnowledgeVersion[]> {
      const { rows } = await db.query<VersionRecord>(`SELECT ${VERSION_COLUMNS} FROM learning_knowledge_versions WHERE tenant_id = $1 ORDER BY version DESC LIMIT $2`,
        [tenantId, limitOf(limit, 100)]);
      return rows.map(versionOf);
    },
    /** Records an evaluation; the document's SHA-256 is computed here, from its jsonb text, exactly as the version admission check computes it. */
    async recordEvaluation(input: { readonly purpose: EvaluationRow['purpose']; readonly baseVersion: number | null; readonly document: unknown; readonly corpus: string;
      readonly passed: boolean; readonly result: unknown; readonly createdBy: string }, now: Date): Promise<{ readonly evaluationId: string; readonly documentSha256: string }> {
      if (!ACTOR.test(input.createdBy)) throw new Error('LEARNING_ACTOR_INVALID');
      const { rows } = await db.query<{ evaluation_id: string; document_sha256: string }>(`INSERT INTO learning_evaluations (tenant_id, at, purpose, base_version, document_sha256,
          corpus, passed, result, created_by) VALUES ($1, $2, $3, $4, encode(sha256(convert_to($5::jsonb::text, 'UTF8')), 'hex'), $6, $7, $8::jsonb, $9)
        RETURNING evaluation_id::text, document_sha256`, [tenantId, now, input.purpose, input.baseVersion, JSON.stringify(input.document), input.corpus, input.passed,
        JSON.stringify(input.result), input.createdBy]);
      return { evaluationId: rows[0]!.evaluation_id, documentSha256: rows[0]!.document_sha256 };
    },
    async evaluations(limit = 25): Promise<EvaluationRow[]> {
      const { rows } = await db.query<{ evaluation_id: string; at: Date; purpose: EvaluationRow['purpose']; base_version: number | null; document_sha256: string; corpus: string;
        passed: boolean; result: unknown; created_by: string }>(`SELECT evaluation_id::text, at, purpose, base_version, document_sha256, corpus, passed, result, created_by
        FROM learning_evaluations WHERE tenant_id = $1 ORDER BY at DESC, evaluation_id DESC LIMIT $2`, [tenantId, limitOf(limit, 100)]);
      return rows.map(row => ({ evaluationId: row.evaluation_id, at: row.at.toISOString(), purpose: row.purpose, baseVersion: row.base_version, documentSha256: row.document_sha256,
        corpus: row.corpus, passed: row.passed, result: row.result, createdBy: row.created_by }));
    },
    /**
     * Appends version expectedVersion + 1. A document needs the id of a PASSING evaluation of exactly that document (the database checks the
     * SHA-256 of its jsonb text); null disables the glossary. ADMIN-style optimistic concurrency: a concurrent writer gets a version conflict.
     */
    async appendKnowledge(input: { readonly expectedVersion: number; readonly document: unknown | null; readonly evaluationId: string | null;
      readonly restoredFrom: number | null; readonly createdBy: string; readonly reason: string | null }, now: Date): Promise<KnowledgeVersion> {
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error('LEARNING_KNOWLEDGE_VERSION_CONFLICT');
      if (!ACTOR.test(input.createdBy) || (input.reason !== null && !REASON.test(input.reason))) throw new Error('LEARNING_DECISION_INVALID');
      try {
        const { rows } = await db.query<VersionRecord>(`INSERT INTO learning_knowledge_versions (tenant_id, version, document, document_sha256, evaluation_id, restored_from,
            created_by, reason, created_at) VALUES ($1, $2, $3::jsonb, CASE WHEN $3::jsonb IS NULL THEN NULL ELSE encode(sha256(convert_to($3::jsonb::text, 'UTF8')), 'hex') END,
            $4::bigint, $5, $6, $7, $8) RETURNING ${VERSION_COLUMNS}`, [tenantId, input.expectedVersion + 1, input.document === null ? null : JSON.stringify(input.document),
          input.evaluationId, input.restoredFrom, input.createdBy, input.reason, now]);
        return versionOf(rows[0]!);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (isUniqueViolation(error) || message.includes('LEARNING_KNOWLEDGE_VERSION_CONFLICT')) throw new Error('LEARNING_KNOWLEDGE_VERSION_CONFLICT', { cause: error });
        if (message.includes('LEARNING_EVALUATION_REQUIRED')) throw new Error('LEARNING_EVALUATION_REQUIRED', { cause: error });
        throw error;
      }
    },

    // ── Aggregates for the admin console (counts only: no term of a private memory, no subject) ────────────────────────────────────────
    async metrics(since: Date): Promise<LearningMetrics> {
      const [subjects, memories, events, candidates] = await Promise.all([
        db.query<{ kind: SubjectKind; memory: number; contribute: number; total: number }>(`SELECT kind, count(*) FILTER (WHERE memory_enabled)::int AS memory,
          count(*) FILTER (WHERE contribute_enabled)::int AS contribute, count(*)::int AS total FROM learning_subjects WHERE tenant_id = $1 GROUP BY kind`, [tenantId]),
        db.query<{ n: number; subjects: number }>(`SELECT count(*)::int AS n, count(DISTINCT subject_id)::int AS subjects FROM learning_memories WHERE tenant_id = $1`, [tenantId]),
        db.query<{ scope: string; kind: string; outcome: string | null; n: number }>(`SELECT scope, kind, outcome, count(*)::int AS n FROM learning_feedback_events
          WHERE tenant_id = $1 AND at >= $2 GROUP BY scope, kind, outcome ORDER BY n DESC LIMIT 400`, [tenantId, since]),
        db.query<{ state: CandidateState; n: number }>(`SELECT state, count(*)::int AS n FROM learning_candidates WHERE tenant_id = $1 GROUP BY state`, [tenantId]),
      ]);
      return { subjects: subjects.rows, memories: memories.rows[0] ?? { n: 0, subjects: 0 }, events: events.rows,
        candidates: Object.fromEntries(candidates.rows.map(row => [row.state, row.n])) as Partial<Record<CandidateState, number>> };
    },

    // ── Retention (bounded batches; run opportunistically and from the admin console) ───────────────────────────────────────────────
    async purge(now: Date): Promise<Readonly<Record<string, number>>> {
      const days = (n: number) => new Date(now.getTime() - n * 86_400_000), batch = LEARNING_RETENTION.batch;
      const counts: Record<string, number> = {};
      counts.events = (await db.query(`DELETE FROM learning_feedback_events WHERE tenant_id = $1 AND event_id IN (SELECT event_id FROM learning_feedback_events
        WHERE tenant_id = $1 AND at < $2 ORDER BY at LIMIT $3)`, [tenantId, days(LEARNING_RETENTION.eventsDays), batch])).rowCount;
      counts.memories = (await db.query(`DELETE FROM learning_memories WHERE tenant_id = $1 AND (subject_id, term) IN (SELECT subject_id, term FROM learning_memories
        WHERE tenant_id = $1 AND touched_at < $2 ORDER BY touched_at LIMIT $3)`, [tenantId, days(LEARNING_RETENTION.memoryDays), batch])).rowCount;
      counts.subjects = (await db.query(`DELETE FROM learning_subjects s WHERE s.tenant_id = $1 AND s.subject_id IN (SELECT subject_id FROM learning_subjects x
        WHERE x.tenant_id = $1 AND ((x.last_seen_at < $2 AND NOT x.memory_enabled AND NOT x.contribute_enabled AND x.language IS NULL
          AND NOT EXISTS (SELECT 1 FROM learning_memories m WHERE m.tenant_id = x.tenant_id AND m.subject_id = x.subject_id)) OR x.last_seen_at < $3)
        ORDER BY x.last_seen_at LIMIT $4)`, [tenantId, days(LEARNING_RETENTION.unconsentedSubjectDays), days(LEARNING_RETENTION.subjectDays), batch])).rowCount;
      await db.transaction(async tx => {
        const expired = await tx.query<{ candidate_id: string }>(`DELETE FROM learning_candidate_support WHERE tenant_id = $1 AND (candidate_id, contributor_digest) IN (
          SELECT candidate_id, contributor_digest FROM learning_candidate_support WHERE tenant_id = $1 AND at < $2 ORDER BY at LIMIT $3) RETURNING candidate_id`,
        [tenantId, days(LEARNING_RETENTION.supportDays), batch]);
        counts.support = expired.rowCount;
        await recount(tx, tenantId, [...new Set(expired.rows.map(row => row.candidate_id))]);
      });
      counts.candidates = (await db.query(`DELETE FROM learning_candidates WHERE tenant_id = $1 AND candidate_id IN (SELECT candidate_id FROM learning_candidates
        WHERE tenant_id = $1 AND state = 'PENDING' AND origin = 'CONTRIBUTION' AND last_seen_at < $2 ORDER BY last_seen_at LIMIT $3)`,
      [tenantId, days(LEARNING_RETENTION.pendingCandidateDays), batch])).rowCount;
      counts.rateWindows = (await db.query(`DELETE FROM mcp_rate_limits WHERE tenant_id = $1 AND bucket LIKE 'learning:%' AND window_start < $2`,
        [tenantId, days(LEARNING_RETENTION.rateWindowDays)])).rowCount;
      return counts;
    },
  };
  /** Removes a contributor's support everywhere and recounts the candidates it touched. */
  async function withdrawSupport(tx: Queryable, contributor: Buffer): Promise<void> {
    const removed = await tx.query<{ candidate_id: string }>(`DELETE FROM learning_candidate_support WHERE tenant_id = $1 AND contributor_digest = $2 RETURNING candidate_id`,
      [tenantId, contributor]);
    await recount(tx, tenantId, [...new Set(removed.rows.map(row => row.candidate_id))]);
  }
  return store;
}
export type LearningStore = ReturnType<typeof createLearningStore>;
export type LearningMetrics = { readonly subjects: readonly { readonly kind: SubjectKind; readonly memory: number; readonly contribute: number; readonly total: number }[];
  readonly memories: { readonly n: number; readonly subjects: number };
  readonly events: readonly { readonly scope: string; readonly kind: string; readonly outcome: string | null; readonly n: number }[];
  readonly candidates: Partial<Record<CandidateState, number>> };
