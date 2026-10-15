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
 */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import type { CopilotLearning, MemoryAction } from '../domain/copilot-conversation.ts';
import { glossaryEntries, parseLexicon, validateLexiconEntry, type LexiconEntry } from '../domain/copilot-lexicon.ts';
import type { CopilotLanguage } from '../domain/copilot-messages.ts';
import { fixedWindow } from '../platform/fixed-window.ts';
import { LEARNING_NOTICE_VERSION, type LearningConfig } from './config.ts';
import { contributorDigest, ownerLabel, subjectDigest, type LearningPrincipal } from './identity.ts';
import { knowledgeLexicon, validateKnowledgeDocument } from './knowledge.ts';
import { createLearningStore, type FeedbackEvent, type LearningStore, type Subject } from './store.ts';

export type LearningScope = FeedbackEvent['scope'];
export type LearningHost = { readonly db: Database; readonly tenantId: string };
/** One turn's learning: the engine's context plus what the server needs to act on it. */
export type LearningSession = { readonly learning: CopilotLearning; readonly principal: LearningPrincipal | null; readonly subject: Subject | null };
export type LearningResult = { readonly ok: true } | { readonly ok: false; readonly code: LearningCode };
export type LearningCode = 'LEARNING_UNAVAILABLE' | 'LEARNING_IDENTITY_REQUIRED' | 'LEARNING_RATE_LIMITED' | 'LEARNING_MEMORY_FULL' | 'LEARNING_ENTRY_INVALID'
  | 'LEARNING_MEMORY_PAUSED';
/** Content-free feedback kinds, and the evidence each one is (none is ground truth about an interpretation). */
export const FEEDBACK_KINDS = Object.freeze({ INTERPRETED: 'SYSTEM', TURN: 'OBSERVED', CORRECTION: 'USER_ASSERTED', CLARIFICATION_ANSWERED: 'USER_ASSERTED',
  REPEATED_FAILURE: 'OBSERVED', PROPOSAL_APPLIED: 'OBSERVED', PROPOSAL_DISMISSED: 'OBSERVED', PROPOSAL_REVISED: 'OBSERVED', SUGGESTION_CONFIRMED: 'USER_ASSERTED',
  SUGGESTION_REJECTED: 'USER_ASSERTED', MEMORY_SAVED: 'USER_ASSERTED', MEMORY_FORGOTTEN: 'USER_ASSERTED', MEMORY_ERASED: 'USER_ASSERTED', MEMORY_USED: 'SYSTEM',
  KNOWLEDGE_USED: 'SYSTEM' } as const);
export type FeedbackKind = keyof typeof FEEDBACK_KINDS;
/** Kinds a client may report (the server records the others itself). */
export const CLIENT_FEEDBACK_KINDS: ReadonlySet<FeedbackKind> = new Set(['TURN', 'CORRECTION', 'CLARIFICATION_ANSWERED', 'REPEATED_FAILURE', 'PROPOSAL_APPLIED',
  'PROPOSAL_DISMISSED', 'PROPOSAL_REVISED', 'SUGGESTION_CONFIRMED', 'SUGGESTION_REJECTED', 'MEMORY_USED', 'KNOWLEDGE_USED']);
export const LEARNING_LIMITS = Object.freeze({ writes: [30, 3_600] as const, contributions: [20, 86_400] as const, events: [5_000, 3_600] as const,
  subjectEvents: [600, 3_600] as const, purgeEveryMs: 600_000 });
const UNAVAILABLE: CopilotLearning = Object.freeze({ memory: 'UNAVAILABLE', owner: null, private: [], global: [], globalVersion: null, language: null });
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

  const service = {
    store,
    /** The learning context of one turn. Reads only; never fails (UNAVAILABLE on any error). */
    async session(principal: LearningPrincipal | null): Promise<LearningSession> {
      try {
        const shared = await global();
        if (!principal) return { learning: { memory: 'ANONYMOUS', owner: null, private: [], global: shared.entries, globalVersion: shared.version, language: null },
          principal: null, subject: null };
        const subject = await subjectOf(principal, false);
        const memory: CopilotLearning['memory'] = !subject || subject.memoryEnabled || !subject.memoryConsentAt ? 'AVAILABLE' : 'PAUSED';
        const own = subject?.memoryEnabled ? parseLexicon((await store.memories(subject.subjectId)).map(row => ({ term: row.term, target: row.target })), 'PRIVATE') : [];
        return { learning: { memory, owner: owner(principal), private: own, global: shared.entries, globalVersion: shared.version,
          language: subject?.memoryEnabled ? subject.language : null }, principal, subject };
      } catch { warn('LEARNING_CONTEXT_UNAVAILABLE'); return { learning: UNAVAILABLE, principal, subject: null }; }
    },
    /** The glossary entries a model request may show for the open request (`text`), the user's own first. */
    glossary: (text: string, session: LearningSession): LexiconEntry[] => glossaryEntries(text, [...session.learning.private, ...session.learning.global]),
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
      const entries = subject ? await store.memories(subject.subjectId) : [];
      return { memoryEnabled: subject?.memoryEnabled ?? false, paused: !!subject && !subject.memoryEnabled && !!subject.memoryConsentAt,
        contributeEnabled: subject?.contributeEnabled ?? false, language: subject?.language ?? null, entries: parseLexicon(entries, 'PRIVATE').map(entry => ({ ...entry,
          createdAt: entries.find(row => row.term === entry.term)?.createdAt ?? null })) };
    },
    /** Pauses/resumes memory, or opts in/out of contributing (opting out withdraws past contributions). */
    async settings(principal: LearningPrincipal, change: { readonly memory?: boolean; readonly contribute?: boolean }): Promise<LearningResult> {
      try {
        const subject = await subjectOf(principal, true);
        if (!subject || !await allowed(`learning:write:${subject.subjectId}`, LEARNING_LIMITS.writes)) return { ok: false, code: 'LEARNING_RATE_LIMITED' };
        if (change.memory !== undefined) await store.setMemoryEnabled(subject.subjectId, change.memory, LEARNING_NOTICE_VERSION, now());
        if (change.contribute !== undefined) await store.setContribute(subject.subjectId, change.contribute, contributorDigest(keys, subject.subjectId), LEARNING_NOTICE_VERSION, now());
        return { ok: true };
      } catch { warn('LEARNING_WRITE_FAILED'); return { ok: false, code: 'LEARNING_UNAVAILABLE' }; }
    },
    /** Erases everything about the principal (memories, settings, contributions). */
    async erase(principal: LearningPrincipal, scope: LearningScope): Promise<LearningResult> {
      return service.apply(principal, { op: 'FORGET_ALL' }, scope);
    },
    /** Marks the user's saved entries a turn used (their retention restarts). */
    async used(session: LearningSession, entries: readonly LexiconEntry[]): Promise<void> {
      const terms = entries.filter(entry => entry.source === 'PRIVATE').map(entry => entry.term);
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
