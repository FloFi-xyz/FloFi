// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: the learning service — one verified principal's context for a Copilot turn, memory changes on that principal only,
 * content-free feedback, and opportunistic retention. Shared by the web chat (server actions) and Channel Core.
 *
 * Fail-soft by construction: any learning failure (no database, a schema window during a rolling deployment, a store error, an invalid stored
 * glossary) yields an UNAVAILABLE context with nothing learned, and the Copilot behaves exactly as without this build. Nothing here can change a
 * workflow, an approval or an execution; the only effects are rows in the learning tables.
 *
 * A subject row is created only when the user acts (accepts a "Remember" offer, changes a setting): merely reading a context never stores anything.
 *
 * BUILD-CHAT-LEARNING-002: `observe` stores what the Copilot observed in natural interaction (answers to FloFi's questions, corrections, applied
 * proposals, statements) — only when the deployment's basis and the identity's own choice permit it (`automatic.ts`), re-checked here whatever the
 * caller says — and learns a meaning only by the deterministic promotion rule. Under legitimate interest the first observation creates the subject.
 */
import { createHmac } from 'node:crypto';
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import type { LearningObservation } from '../domain/copilot-adaptation.ts';
import type { CopilotLearning, MemoryAction } from '../domain/copilot-conversation.ts';
import { parseLexicon, validateLexiconEntry, type LexiconEntry } from '../domain/copilot-lexicon.ts';
import type { CopilotLanguage } from '../domain/copilot-messages.ts';
import { fixedWindow } from '../platform/fixed-window.ts';
import { LEARNING_NOTICE_VERSION, type LearningConfig } from './config.ts';
import { contributorDigest, ownerLabel, subjectDigest, type LearningPrincipal } from './identity.ts';
import { knowledgeLexicon, validateKnowledgeDocument } from './knowledge.ts';
import { AUTOMATIC_RULES, automaticPermitted, evidenceWeight, type AutomaticSetting } from './automatic.ts';
import { createLearningStore, type FeedbackEvent, type LearningStore, type ObserveOutcome, type StoreObservation, type Subject } from './store.ts';

export type LearningScope = FeedbackEvent['scope'];
export type LearningHost = { readonly db: Database; readonly tenantId: string };
/** One turn's learning: the engine's context plus what the server needs to act on it. */
export type LearningSession = { readonly learning: CopilotLearning; readonly principal: LearningPrincipal | null; readonly subject: Subject | null;
  /** BUILD-CHAT-LEARNING-002: persistent automatic learning runs for this identity now. */ readonly permitted?: boolean };
/** BUILD-CHAT-LEARNING-002: where an observation was made, so a request is counted once and conversations are counted (random ids, never stored raw). */
export type ObservationContext = { readonly conversation: string; readonly request: number };
export const OBSERVATION_CONTEXT = Object.freeze({ conversation: /^[A-Za-z0-9_-]{16,80}$/, maxRequest: 1_000_000 });
export type LearningResult = { readonly ok: true } | { readonly ok: false; readonly code: LearningCode };
export type LearningCode = 'LEARNING_UNAVAILABLE' | 'LEARNING_IDENTITY_REQUIRED' | 'LEARNING_RATE_LIMITED' | 'LEARNING_MEMORY_FULL' | 'LEARNING_ENTRY_INVALID'
  | 'LEARNING_MEMORY_PAUSED' | 'LEARNING_AUTOMATIC_OFF';
/** Content-free feedback kinds, and the evidence each one is (none is ground truth about an interpretation). */
export const FEEDBACK_KINDS = Object.freeze({ INTERPRETED: 'SYSTEM', TURN: 'OBSERVED', CORRECTION: 'USER_ASSERTED', CLARIFICATION_ANSWERED: 'USER_ASSERTED',
  REPEATED_FAILURE: 'OBSERVED', PROPOSAL_APPLIED: 'OBSERVED', PROPOSAL_DISMISSED: 'OBSERVED', PROPOSAL_REVISED: 'OBSERVED', SUGGESTION_CONFIRMED: 'USER_ASSERTED',
  SUGGESTION_REJECTED: 'USER_ASSERTED', MEMORY_SAVED: 'USER_ASSERTED', MEMORY_FORGOTTEN: 'USER_ASSERTED', MEMORY_ERASED: 'USER_ASSERTED', MEMORY_USED: 'SYSTEM',
  KNOWLEDGE_USED: 'SYSTEM',
  // BUILD-CHAT-LEARNING-002: signals the engine classified (outcome = which signal, or why it was ignored), inferred readings used / confirmed / corrected
  // (outcome = ADAPTED | LEARNED | GLOBAL), what the store did with an observation (outcome = KIND_OUTCOME) and identities' choices (outcome = BASIS_ON|OFF).
  ADAPTATION: 'OBSERVED', CORRECTION_IGNORED: 'OBSERVED', INFERRED_USED: 'SYSTEM', INFERRED_CONFIRMED: 'OBSERVED', INFERRED_CORRECTED: 'OBSERVED', AUTOMATIC: 'SYSTEM',
  AUTOMATIC_CHOICE: 'USER_ASSERTED' } as const);
export type FeedbackKind = keyof typeof FEEDBACK_KINDS;
/** Kinds a client may report (the server records the others itself). */
export const CLIENT_FEEDBACK_KINDS: ReadonlySet<FeedbackKind> = new Set(['TURN', 'CORRECTION', 'CLARIFICATION_ANSWERED', 'REPEATED_FAILURE', 'PROPOSAL_APPLIED',
  'PROPOSAL_DISMISSED', 'PROPOSAL_REVISED', 'SUGGESTION_CONFIRMED', 'SUGGESTION_REJECTED', 'MEMORY_USED', 'KNOWLEDGE_USED', 'ADAPTATION', 'CORRECTION_IGNORED', 'INFERRED_USED',
  'INFERRED_CONFIRMED', 'INFERRED_CORRECTED']);
export const LEARNING_LIMITS = Object.freeze({ writes: [30, 3_600] as const, contributions: [20, 86_400] as const, events: [5_000, 3_600] as const,
  subjectEvents: [600, 3_600] as const, purgeEveryMs: 600_000, /** BUILD-CHAT-LEARNING-002 */ observations: [240, 3_600] as const });
const UNAVAILABLE: CopilotLearning = Object.freeze({ memory: 'UNAVAILABLE', owner: null, private: [], global: [], globalVersion: null, language: null });
/** BUILD-CHAT-LEARNING-002: the engine's context with FLOFI_LEARNING=session — in-conversation adaptation, nothing stored, nothing read. */
export const SESSION_LEARNING: CopilotLearning = Object.freeze({ memory: 'SESSION', owner: null, private: [], global: [], globalVersion: null, language: null, automatic: 'OFF' });
const KINDS: ReadonlySet<string> = new Set(['STATED', 'CLARIFIED', 'CORRECTED', 'CONFIRMED', 'CONTRADICTED']);
/** BUILD-CHAT-LEARNING-002: untrusted observations (a browser's report) → valid store observations (closed kinds, re-validated entries), at most 8. */
export function parseObservations(raw: unknown): StoreObservation[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, AUTOMATIC_RULES.maxObservations).flatMap((item): StoreObservation[] => {
    const record = item as Partial<Record<string, unknown>> | null;
    if (!record || typeof record !== 'object' || typeof record.kind !== 'string') return [];
    if (record.kind === 'LANGUAGE') return record.language === 'EN' || record.language === 'PT' ? [{ kind: 'LANGUAGE', language: record.language, stated: record.stated === true }] : [];
    if (!KINDS.has(record.kind)) return [];
    const valid = validateLexiconEntry(record.term, record.target);
    return valid.ok ? [{ kind: record.kind as Exclude<StoreObservation['kind'], 'LANGUAGE'>, term: valid.term, target: valid.target }] : [];
  });
}
const PURGED = Symbol.for('flofi.learning.purged');

export function createLearningService(input: { readonly config: Extract<LearningConfig, { enabled: true }>; readonly host: LearningHost; readonly now?: () => Date;
  readonly log?: (line: string) => void }) {
  const { config, host } = input, keys = config.keys, now = input.now ?? (() => new Date());
  const store: LearningStore = createLearningStore(host.db, host.tenantId), limits = fixedWindow(host.db, host.tenantId);
  const log = input.log ?? (line => console.warn(line));
  const warn = (code: string) => log(JSON.stringify({ event: 'flofi.learning', outcome: code }));

  /** The active global glossary (validated again on every read; an invalid stored version is not served). */
  async function global(): Promise<{ readonly entries: LexiconEntry[]; readonly version: number | null }> {
    if (!config.global) return { entries: [], version: null };
    const active = await store.activeKnowledge();
    if (!active || active.document === null) return { entries: [], version: active?.version ?? null };
    try { return { entries: knowledgeLexicon(validateKnowledgeDocument(active.document), active.version), version: active.version }; }
    catch { warn('LEARNING_KNOWLEDGE_INVALID'); return { entries: [], version: active.version }; }
  }
  const owner = (principal: LearningPrincipal) => ({ EN: ownerLabel(principal, 'EN'), PT: ownerLabel(principal, 'PT') });
  const subjectOf = (principal: LearningPrincipal, create: boolean): Promise<Subject | null> => store.subjectFor(principal.kind, subjectDigest(keys, principal), now(), create);
  const allowed = async (bucket: string, [limit, seconds]: readonly [number, number]) => limits.allow(bucket, limit, seconds, now());
  const maybePurge = async () => {
    const holder = globalThis as unknown as Record<symbol, number | undefined>;
    if (now().getTime() - (holder[PURGED] ?? 0) < LEARNING_LIMITS.purgeEveryMs) return;
    holder[PURGED] = now().getTime();
    await store.purge(now()).catch(() => warn('LEARNING_PURGE_FAILED'));
  };

  /**
   * BUILD-CHAT-LEARNING-002: whether saved meanings are used (consented and not paused; or, under legitimate interest, never consented and not
   * objected) and whether automatic learning runs now (permitted, and memory not paused by the user).
   */
  function memoryUse(subject: Subject | null, setting: AutomaticSetting | null): { readonly use: boolean; readonly automatic: boolean; readonly memory: CopilotLearning['memory'] } {
    const permitted = automaticPermitted(config.automatic, setting);
    const paused = !!subject && !subject.memoryEnabled && !!subject.memoryConsentAt;
    const use = !!subject && (subject.memoryEnabled || (permitted && !subject.memoryConsentAt));
    return { use, automatic: permitted && !paused, memory: paused ? 'PAUSED' : 'AVAILABLE' };
  }
  const service = {
    store,
    /** BUILD-CHAT-LEARNING-002: the deployment's basis for persistent automatic learning. */
    automaticMode: config.automatic,
    /** The learning context of one turn. Reads only; never fails (UNAVAILABLE on any error). */
    async session(principal: LearningPrincipal | null): Promise<LearningSession> {
      try {
        const shared = await global();
        if (!principal) return { learning: { memory: 'ANONYMOUS', owner: null, private: [], global: shared.entries, globalVersion: shared.version, language: null },
          principal: null, subject: null };
        const subject = await subjectOf(principal, false);
        const setting = subject ? await store.automaticSetting(subject.subjectId) : null, view = memoryUse(subject, setting);
        const rows = subject && view.use ? await store.memoriesWithOrigin(subject.subjectId) : [];
        const entries = (origin: (o: string) => boolean) => rows.filter(row => origin(row.origin)).map(row => ({ term: row.term, target: row.target }));
        const hint = subject && view.automatic ? await store.languageHint(subject.subjectId) : null;
        return { learning: { memory: view.memory, owner: owner(principal), private: parseLexicon(entries(o => o !== 'LEARNED'), 'PRIVATE'), global: shared.entries,
          globalVersion: shared.version, language: subject && view.use ? subject.language : null, learned: parseLexicon(entries(o => o === 'LEARNED'), 'LEARNED'),
          automatic: view.automatic ? 'ON' : 'OFF', languageHint: hint }, principal, subject, permitted: view.automatic };
      } catch { warn('LEARNING_CONTEXT_UNAVAILABLE'); return { learning: UNAVAILABLE, principal, subject: null }; }
    },
    /**
     * BUILD-CHAT-LEARNING-002: stores what the Copilot observed about the verified principal's own words, when permitted (re-checked here), within
     * its rate window, each request counted once. Never fails the caller: returns what the store did with each observation (nothing on any error).
     */
    async observe(principal: LearningPrincipal | null, observations: readonly LearningObservation[] | readonly StoreObservation[], context: ObservationContext,
      scope: LearningScope): Promise<readonly ObserveOutcome[]> {
      const valid = parseObservations(observations);
      if (!principal || config.automatic === 'OFF' || !valid.length || !OBSERVATION_CONTEXT.conversation.test(context.conversation)
        || !Number.isSafeInteger(context.request) || context.request < 0 || context.request > OBSERVATION_CONTEXT.maxRequest) return [];
      try {
        let subject = await subjectOf(principal, false);
        if (!memoryUse(subject, subject ? await store.automaticSetting(subject.subjectId) : null).automatic) return [];
        subject ??= await subjectOf(principal, true);
        if (!subject || !await allowed(`learning:observe:${subject.subjectId}`, LEARNING_LIMITS.observations)) return [];
        const digest = (label: string) => createHmac('sha256', keys.evidence).update(`${subject!.subjectId}:${label}`, 'utf8').digest();
        const digests = { request: digest(`${context.conversation}:${context.request}`), conversation: digest(context.conversation) };
        const outcomes: ObserveOutcome[] = [];
        for (const observation of valid) {
          const outcome = await store.observe(subject.subjectId, observation, digests, now());
          outcomes.push(outcome);
          // A newly learned meaning is contributed (generalized, pseudonymous) only with the separate contribution opt-in.
          if (outcome === 'LEARNED' && observation.kind !== 'LANGUAGE' && observation.kind !== 'CONTRADICTED' && subject.contributeEnabled
            && await allowed(`learning:contribute:${subject.subjectId}`, LEARNING_LIMITS.contributions))
            await store.contribute({ term: observation.term, target: observation.target, language: 'ANY' }, contributorDigest(keys, subject.subjectId), now())
              .catch(() => warn('LEARNING_CONTRIBUTION_FAILED'));
        }
        await service.record(scope, valid.map((observation, index) => ({ kind: 'AUTOMATIC' as const, outcome: `${observation.kind}_${outcomes[index]}` })), subject.subjectId);
        return outcomes;
      } catch { warn('LEARNING_OBSERVE_FAILED'); return []; }
    },
    /** Performs a memory action the engine described after the user's explicit statement or click, on the verified principal only. */
    async apply(principal: LearningPrincipal | null, action: MemoryAction, scope: LearningScope): Promise<LearningResult> {
      if (!principal) return { ok: false, code: 'LEARNING_IDENTITY_REQUIRED' };
      try {
        if (action.op === 'SAVE') {
          const valid = validateLexiconEntry(action.entry.term, action.entry.target);
          if (!valid.ok) return { ok: false, code: 'LEARNING_ENTRY_INVALID' };
          const existing = await subjectOf(principal, false);
          if (existing && !existing.memoryEnabled && existing.memoryConsentAt) return { ok: false, code: 'LEARNING_MEMORY_PAUSED' };
          const subject = existing ?? await subjectOf(principal, true);
          if (!subject || !await allowed(`learning:write:${subject.subjectId}`, LEARNING_LIMITS.writes)) return { ok: false, code: 'LEARNING_RATE_LIMITED' };
          if (await store.remember(subject.subjectId, { term: valid.term, target: valid.target }, LEARNING_NOTICE_VERSION, now()) === 'FULL')
            return { ok: false, code: 'LEARNING_MEMORY_FULL' };
          // A generalized, pseudonymous contribution only with its own, separate opt-in.
          if (subject.contributeEnabled && await allowed(`learning:contribute:${subject.subjectId}`, LEARNING_LIMITS.contributions))
            await store.contribute({ term: valid.term, target: valid.target, language: 'ANY' }, contributorDigest(keys, subject.subjectId), now()).catch(() => warn('LEARNING_CONTRIBUTION_FAILED'));
          await service.record(scope, [{ kind: 'MEMORY_SAVED' }]);
          return { ok: true };
        }
        const subject = await subjectOf(principal, action.op === 'LANGUAGE');
        if (!subject) return action.op === 'LANGUAGE' ? { ok: false, code: 'LEARNING_UNAVAILABLE' } : { ok: true };
        if (!await allowed(`learning:write:${subject.subjectId}`, LEARNING_LIMITS.writes)) return { ok: false, code: 'LEARNING_RATE_LIMITED' };
        if (action.op === 'FORGET') { await store.forget(subject.subjectId, action.term); await service.record(scope, [{ kind: 'MEMORY_FORGOTTEN' }]); }
        else if (action.op === 'LANGUAGE') {
          if (!subject.memoryEnabled && subject.memoryConsentAt) return { ok: false, code: 'LEARNING_MEMORY_PAUSED' };
          await store.setLanguage(subject.subjectId, action.language, LEARNING_NOTICE_VERSION, now());
        } else { await store.erase(subject.subjectId, contributorDigest(keys, subject.subjectId)); await service.record(scope, [{ kind: 'MEMORY_ERASED' }]); }
        return { ok: true };
      } catch { warn('LEARNING_WRITE_FAILED'); return { ok: false, code: 'LEARNING_UNAVAILABLE' }; }
    },
    /** The user's own memory, for their Memory panel or a channel's `memory` command: their entries and settings only. */
    async status(principal: LearningPrincipal) {
      const subject = await subjectOf(principal, false);
      const setting = subject ? await store.automaticSetting(subject.subjectId) : null, view = memoryUse(subject, setting);
      const rows = subject ? await store.memoriesWithOrigin(subject.subjectId) : [];
      const evidence = subject ? await store.evidence(subject.subjectId) : [];
      return { memoryEnabled: subject?.memoryEnabled ?? false, paused: view.memory === 'PAUSED', consented: !!subject?.memoryConsentAt,
        contributeEnabled: subject?.contributeEnabled ?? false, language: subject?.language ?? null,
        entries: parseLexicon(rows, 'PRIVATE').map(entry => { const row = rows.find(item => item.term === entry.term); return { ...entry, createdAt: row?.createdAt ?? null,
          origin: row?.origin ?? 'REMEMBERED' }; }),
        // BUILD-CHAT-LEARNING-002: the deployment's basis, the identity's own choice, whether it runs now, and what was observed but not learned.
        automatic: { mode: config.automatic, setting, permitted: view.automatic },
        pending: evidence.filter(row => !row.promotedAt && row.term !== '').slice(0, 32).map(row => ({ term: row.term, target: row.target, weight: evidenceWeight(row),
          lastSeenAt: row.lastSeenAt })),
        languageHint: evidence.find(row => row.term === '' && row.promotedAt)?.target.slice('language:'.length) ?? null };
    },
    /** Pauses/resumes memory, or opts in/out of contributing (opting out withdraws past contributions). */
    async settings(principal: LearningPrincipal, change: { readonly memory?: boolean; readonly contribute?: boolean; readonly automatic?: boolean }): Promise<LearningResult> {
      if (change.automatic !== undefined && config.automatic === 'OFF') return { ok: false, code: 'LEARNING_AUTOMATIC_OFF' };
      try {
        const subject = await subjectOf(principal, true);
        if (!subject || !await allowed(`learning:write:${subject.subjectId}`, LEARNING_LIMITS.writes)) return { ok: false, code: 'LEARNING_RATE_LIMITED' };
        if (change.memory !== undefined) await store.setMemoryEnabled(subject.subjectId, change.memory, LEARNING_NOTICE_VERSION, now());
        if (change.contribute !== undefined) await store.setContribute(subject.subjectId, change.contribute, contributorDigest(keys, subject.subjectId), LEARNING_NOTICE_VERSION, now());
        // BUILD-CHAT-LEARNING-002: the identity's choice, recorded with the deployment's basis and the current notice; off erases what it produced.
        if (change.automatic !== undefined && config.automatic !== 'OFF') {
          await store.setAutomatic(subject.subjectId, change.automatic, config.automatic, LEARNING_NOTICE_VERSION, now());
          await service.record('WEB', [{ kind: 'AUTOMATIC_CHOICE', outcome: `${config.automatic}_${change.automatic ? 'ON' : 'OFF'}` }]);
        }
        return { ok: true };
      } catch { warn('LEARNING_WRITE_FAILED'); return { ok: false, code: 'LEARNING_UNAVAILABLE' }; }
    },
    /** Erases everything about the principal (memories, settings, contributions). */
    async erase(principal: LearningPrincipal, scope: LearningScope): Promise<LearningResult> {
      return service.apply(principal, { op: 'FORGET_ALL' }, scope);
    },
    /** Marks the user's saved entries a turn used (their retention restarts). */
    async used(session: LearningSession, entries: readonly LexiconEntry[]): Promise<void> {
      const terms = entries.filter(entry => entry.source === 'PRIVATE' || entry.source === 'LEARNED').map(entry => entry.term);
      if (session.subject && terms.length) await store.touch(session.subject.subjectId, terms, now()).catch(() => warn('LEARNING_TOUCH_FAILED'));
    },
    /** Content-free feedback, bounded by a tenant-wide window (and a subject's, when known). Never fails the caller. */
    async record(scope: LearningScope, events: readonly ({ readonly kind: FeedbackKind } & Omit<FeedbackEvent, 'kind' | 'scope' | 'evidence'>)[], subjectId?: string | null) {
      try {
        const valid = events.filter(event => Object.hasOwn(FEEDBACK_KINDS, event.kind)).slice(0, 8);
        if (!valid.length || !await allowed(`learning:events:${scope.toLowerCase()}`, LEARNING_LIMITS.events)) return;
        if (subjectId && !await allowed(`learning:events:${subjectId}`, LEARNING_LIMITS.subjectEvents)) return;
        await store.record(valid.map(event => ({ ...event, scope, evidence: FEEDBACK_KINDS[event.kind] })), now());
        await maybePurge();
      } catch { warn('LEARNING_FEEDBACK_FAILED'); }
    },
    purge: () => store.purge(now()),
  };
  return service;
}
export type LearningService = ReturnType<typeof createLearningService>;
/** The reply language a channel or web turn should start from: the user's saved one, else the caller's default. */
export const startLanguage = (session: LearningSession, fallback: CopilotLanguage): CopilotLanguage => session.learning.language ?? fallback;
