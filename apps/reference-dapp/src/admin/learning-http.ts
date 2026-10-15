// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: `POST /admin/api/learning` — review and publication of FloFi's global Copilot glossary (OPERATOR only, CSRF-checked,
 * audited), on BUILD-ADMIN-001's authorization boundary (`adminMutation`). Nothing here reads or changes a user's private memory.
 *
 *   add       `{ action, term, target, language }`                 an operator candidate (PENDING; validated like every entry)
 *   starter   `{ action }`                                           the reviewed PT-BR/EN starter set as PENDING candidates (existing ones skipped)
 *   approve | reject | reopen  `{ action, candidateId, reason? }`  a decision (reject also retracts an APPROVED candidate; the database refuses
 *                                                                   any other transition)
 *   evaluate  `{ action }`                                           a dry-run evaluation of the document the next publication would contain
 *   publish   `{ action, expectedVersion, reason? }`               evaluates that document against the active version; only a passing evaluation
 *                                                                   appends version expectedVersion + 1 (the database checks it too)
 *   rollback  `{ action, expectedVersion, toVersion, reason? }`    re-evaluates an older version today; appends it again only if it still passes
 *   disable   `{ action, expectedVersion, reason? }`               appends an empty (NULL) version: no global glossary is served
 *   retention `{ action }`                                           runs the learning retention purge now
 *   purge-automatic `{ action }`                                     BUILD-CHAT-LEARNING-002: erases the automatic-learning data of identities the deployment's
 *                                                                   current basis no longer covers (e.g. after switching from legitimate interest to consent)
 *
 * Every evaluation is recorded, passed or not. Repetition by users never publishes anything: publication needs this operator action and a
 * passing deterministic evaluation.
 */
import { validateLexiconEntry } from '../domain/copilot-lexicon.ts';
import { evaluateKnowledge } from '../learning/evaluation.ts';
import { LEARNING_CORPUS_ID } from '../learning/eval-corpus.ts';
import { CANDIDATE_ID, KNOWLEDGE_LANGUAGES, KNOWLEDGE_SCHEMA, KnowledgeError, STARTER_CANDIDATES, validateKnowledgeDocument, type KnowledgeDocument,
  type KnowledgeLanguage } from '../learning/knowledge.ts';
import { learningConfig } from '../learning/config.ts';
import { createLearningStore, type Candidate, type LearningStore } from '../learning/store.ts';
import { adminMutation, codeOf, json, readJsonObject, type AdminHttpOptions } from './http.ts';

export const EVALUATION_WINDOW_MS = 600_000, EVALUATION_LIMIT = 30;
const versionOf = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function reasonOf(value: unknown): string | null | false {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && /^[^\p{Cc}]{1,200}$/u.test(value.trim()) ? value.trim() : false;
}
/**
 * The document a publication would contain: every APPROVED candidate (retracted and pending ones never), in its canonical form when it validates
 * (entries in code-unit term order, whatever the database collation returned), so exactly the evaluated bytes are the published bytes.
 */
export function proposedDocument(approved: readonly Candidate[]): unknown {
  return canonical({ schema: KNOWLEDGE_SCHEMA, entries: approved.map(c => ({ term: c.term, target: c.target, language: c.language, candidateId: c.candidateId })) });
}
/** A document's canonical form when it validates; otherwise unchanged (its evaluation then fails on the document check). */
const canonical = (document: unknown): unknown => { try { return validateKnowledgeDocument(document); } catch { return document; } };
const summary = (result: ReturnType<typeof evaluateKnowledge>) => ({ passed: result.passed, entries: result.entries, regressions: result.regressions.length,
  safetyViolations: result.safetyViolations.length, failedCases: result.cases.failed.length, failedProbes: result.probes.failed.length, documentCode: result.document.code });

export async function handleLearningAdmin(request: Request, options: AdminHttpOptions = {}): Promise<Response> {
  const allowed = await adminMutation(request, options, 'write');
  if (allowed instanceof Response) return allowed;
  const { context, request: base } = allowed, actor = context.principal.principalId, now = base.now;
  const store: LearningStore = createLearningStore(base.host.db, base.host.tenantId);
  const body = await readJsonObject(request);
  if (!body || typeof body.action !== 'string') return json(400, { ok: false, code: 'ADMIN_REQUEST_INVALID' });
  const reason = reasonOf(body.reason);
  if (reason === false) return json(400, { ok: false, code: 'ADMIN_LEARNING_REASON_INVALID' });
  const audit = (kind: string, outcome: 'OK' | 'REFUSED' | 'FAILED', code: string | null, target: string, detail: Record<string, string | number | boolean | null> | null = null) =>
    base.store.audit({ actor, kind, outcome, code, target, detail }).catch(() => undefined);
  /** Evaluations are CPU work: bounded per tenant like the live probe. */
  const evaluationAllowed = async () => (await base.store.countAudit('ADMIN_LEARNING_EVALUATED', new Date(now.getTime() - EVALUATION_WINDOW_MS)).catch(() => EVALUATION_LIMIT))
    < EVALUATION_LIMIT;
  const active = async (): Promise<{ readonly version: number; readonly document: KnowledgeDocument | null }> => {
    const row = await store.activeKnowledge();
    if (!row || row.document === null) return { version: row?.version ?? 0, document: null };
    try { return { version: row.version, document: validateKnowledgeDocument(row.document) }; } catch { return { version: row.version, document: null }; }
  };
  /** Evaluates `document`, records the evaluation (and its audit row), and returns it. */
  async function evaluate(purpose: 'DRY_RUN' | 'PUBLISH' | 'ROLLBACK', document: unknown, baseline: { version: number; document: KnowledgeDocument | null }) {
    const result = evaluateKnowledge(document, baseline.document, { version: baseline.version + 1 });
    const recorded = await store.recordEvaluation({ purpose, baseVersion: baseline.version || null, document, corpus: LEARNING_CORPUS_ID, passed: result.passed, result,
      createdBy: actor }, now);
    await audit('ADMIN_LEARNING_EVALUATED', result.passed ? 'OK' : 'REFUSED', result.passed ? null : 'LEARNING_EVALUATION_FAILED', `learning:evaluation:${recorded.evaluationId}`,
      { purpose, ...summary(result) });
    return { result, evaluationId: recorded.evaluationId };
  }

  try {
    switch (body.action) {
      case 'add': {
        const language = body.language as KnowledgeLanguage;
        if (!(KNOWLEDGE_LANGUAGES as readonly unknown[]).includes(language)) return json(400, { ok: false, code: 'KNOWLEDGE_LANGUAGE_INVALID' });
        const valid = validateLexiconEntry(body.term, body.target);
        if (!valid.ok) { await audit('ADMIN_LEARNING_CANDIDATE_ADDED', 'REFUSED', valid.code, 'learning:candidate'); return json(400, { ok: false, code: valid.code }); }
        const added = await store.addCandidate({ term: valid.term, target: valid.target, language }, actor, now);
        await audit('ADMIN_LEARNING_CANDIDATE_ADDED', 'OK', null, `learning:candidate:${added.candidateId}`, { target: added.target });
        return json(200, { ok: true, candidate: added });
      }
      case 'starter': {
        let added = 0;
        for (const entry of STARTER_CANDIDATES) {
          try { await store.addCandidate(entry, actor, now); added += 1; }
          catch (error) { if (codeOf(error, '') !== 'LEARNING_CANDIDATE_EXISTS') throw error; }
        }
        await audit('ADMIN_LEARNING_STARTER_LOADED', 'OK', null, 'learning:candidates', { added });
        return json(200, { ok: true, added });
      }
      case 'approve': case 'reject': case 'reopen': {
        const id = typeof body.candidateId === 'string' && CANDIDATE_ID.test(body.candidateId) ? body.candidateId : null;
        if (!id) return json(400, { ok: false, code: 'ADMIN_REQUEST_INVALID' });
        if (body.action === 'reject' && reason === null) return json(400, { ok: false, code: 'ADMIN_LEARNING_REASON_REQUIRED' });
        const state = body.action === 'approve' ? 'APPROVED' : body.action === 'reject' ? 'REJECTED' : 'PENDING';
        const kind = `ADMIN_LEARNING_CANDIDATE_${body.action === 'approve' ? 'APPROVED' : body.action === 'reject' ? 'REJECTED' : 'REOPENED'}`;
        try {
          const decided = await store.decide(id, state, actor, reason, now);
          await audit(kind, 'OK', null, `learning:candidate:${id}`, { target: decided.target, support: decided.support });
          return json(200, { ok: true, candidate: decided });
        } catch (error) {
          const code = codeOf(error, 'ADMIN_STORE_UNAVAILABLE');
          if (code === 'LEARNING_CANDIDATE_TRANSITION_INVALID' || code === 'LEARNING_CANDIDATE_NOT_FOUND') { await audit(kind, 'REFUSED', code, `learning:candidate:${id}`); return json(409, { ok: false, code }); }
          throw error;
        }
      }
      case 'evaluate': {
        if (!await evaluationAllowed()) return json(429, { ok: false, code: 'ADMIN_LEARNING_EVALUATION_RATE_LIMITED' });
        const { result, evaluationId } = await evaluate('DRY_RUN', proposedDocument(await store.approved()), await active());
        return json(200, { ok: true, evaluationId, evaluation: result });
      }
      case 'publish': case 'rollback': case 'disable': {
        const expected = versionOf(body.expectedVersion);
        if (expected === null) return json(400, { ok: false, code: 'ADMIN_LEARNING_VERSION_REQUIRED' });
        const current = await active();
        if (current.version !== expected) return json(409, { ok: false, code: 'LEARNING_KNOWLEDGE_VERSION_CONFLICT', activeVersion: current.version });
        if (body.action === 'disable') {
          const written = await store.appendKnowledge({ expectedVersion: expected, document: null, evaluationId: null, restoredFrom: null, createdBy: actor, reason }, now);
          await audit('ADMIN_LEARNING_DISABLED', 'OK', null, 'learning:knowledge', { version: written.version });
          return json(200, { ok: true, version: written.version });
        }
        let document: unknown = null, restoredFrom: number | null = null;
        if (body.action === 'publish') {
          const approved = await store.approved();
          if (!approved.length) return json(409, { ok: false, code: 'LEARNING_KNOWLEDGE_EMPTY' });
          document = proposedDocument(approved);
          const same = current.document && (() => { try { return JSON.stringify(validateKnowledgeDocument(document).entries) === JSON.stringify(current.document.entries); }
            catch { return false; } })();
          if (same) return json(409, { ok: false, code: 'LEARNING_KNOWLEDGE_UNCHANGED' });
        } else {
          const target = versionOf(body.toVersion), restored = target === null || target < 1 || target >= expected ? null : await store.knowledgeVersion(target);
          if (!restored) return json(400, { ok: false, code: 'ADMIN_LEARNING_VERSION_UNKNOWN' });
          restoredFrom = restored.version;
          if (restored.document === null) {
            const written = await store.appendKnowledge({ expectedVersion: expected, document: null, evaluationId: null, restoredFrom, createdBy: actor, reason }, now);
            await audit('ADMIN_LEARNING_ROLLED_BACK', 'OK', null, 'learning:knowledge', { version: written.version, restoredFrom });
            return json(200, { ok: true, version: written.version });
          }
          document = canonical(restored.document);
        }
        if (!await evaluationAllowed()) return json(429, { ok: false, code: 'ADMIN_LEARNING_EVALUATION_RATE_LIMITED' });
        const { result, evaluationId } = await evaluate(body.action === 'publish' ? 'PUBLISH' : 'ROLLBACK', document, current);
        const kind = body.action === 'publish' ? 'ADMIN_LEARNING_PUBLISHED' : 'ADMIN_LEARNING_ROLLED_BACK';
        if (!result.passed) {
          await audit(kind, 'REFUSED', 'LEARNING_EVALUATION_FAILED', 'learning:knowledge', { evaluationId, ...summary(result) });
          return json(409, { ok: false, code: 'LEARNING_EVALUATION_FAILED', evaluationId, evaluation: result });
        }
        // Exactly the evaluated document (the database also checks its SHA-256 against the passing evaluation).
        const written = await store.appendKnowledge({ expectedVersion: expected, document, evaluationId, restoredFrom, createdBy: actor, reason }, now);
        await audit(kind, 'OK', null, 'learning:knowledge', { version: written.version, evaluationId, entries: result.entries, restoredFrom });
        return json(200, { ok: true, version: written.version, evaluationId, evaluation: result });
      }
      case 'retention': {
        const purged = await store.purge(now);
        await audit('ADMIN_LEARNING_RETENTION', 'OK', null, 'learning:retention', purged);
        return json(200, { ok: true, purged });
      }
      case 'purge-automatic': {
        const config = learningConfig(options.env ?? process.env), mode = config.enabled ? config.automatic : 'OFF';
        const subjects = await store.purgeAutomatic(mode);
        await audit('ADMIN_LEARNING_AUTOMATIC_PURGED', 'OK', null, 'learning:automatic', { mode, subjects });
        return json(200, { ok: true, mode, subjects });
      }
      default: return json(400, { ok: false, code: 'ADMIN_REQUEST_INVALID' });
    }
  } catch (error) {
    const code = error instanceof KnowledgeError ? error.code : codeOf(error, 'ADMIN_STORE_UNAVAILABLE');
    const known = /^(LEARNING_|KNOWLEDGE_)/.test(code);
    return json(code === 'LEARNING_KNOWLEDGE_VERSION_CONFLICT' || code === 'LEARNING_CANDIDATE_EXISTS' ? 409 : known ? 400 : 503, { ok: false, code });
  }
}
