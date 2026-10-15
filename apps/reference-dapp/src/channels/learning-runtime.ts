// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: learning for the channel entry points that run turns (provider webhooks, the scheduled dispatch). Kept out of
 * `runtime.ts` so the approval-side paths that share it (the /approve contributor, the status ping) stay model-free, transitively.
 */
import { learningConfig, sessionAdaptation } from '../learning/config.ts';
import { requestGlossary } from '../learning/glossary.ts';
import { createLearningService, FEEDBACK_KINDS, SESSION_LEARNING, type FeedbackKind, type LearningScope, type LearningService, type LearningSession } from '../learning/service.ts';
import type { ChannelLearning, ChannelLearningSession } from './core/learning.ts';
import type { ChannelHost } from './runtime.ts';

type Env = Readonly<Record<string, string | undefined>>;
/**
 * BUILD-CHAT-LEARNING-001: Channel Core's learning for one provider (`core/learning.ts`), backed by the learning service on the channel host's
 * database; null when learning is off, or for a provider outside the two shipped channels (whose scope learning does not record).
 */
export function channelLearning(env: Env, host: ChannelHost, channel: string, service: LearningService | null = channelLearningService(env, host)): ChannelLearning | null {
  const scope: LearningScope | null = channel === 'TELEGRAM' ? 'TELEGRAM' : channel === 'WHATSAPP' ? 'WHATSAPP' : null;
  if (!scope) return null;
  // BUILD-CHAT-LEARNING-002: FLOFI_LEARNING=session — the sender's conversation adapts; nothing is read, stored or recorded.
  if (!service) return sessionAdaptation(env) ? sessionOnlyLearning() : null;
  const sessions = new WeakMap<ChannelLearningSession, LearningSession>();
  return {
    async session(principal) {
      const session = await service.session(principal);
      const view: ChannelLearningSession = { learning: session.learning, subjectId: session.subject?.subjectId ?? null, used: entries => service.used(session, entries) };
      sessions.set(view, session);
      return view;
    },
    glossary(view, messages, aliases, adapted = []) {
      const session = sessions.get(view);
      if (!session) return { glossary: null, privateEntries: 0, globalEntries: 0 };
      const { glossary, entries } = requestGlossary(session, messages, aliases, adapted);
      return { glossary, privateEntries: entries.filter(e => e.source !== 'GLOBAL').length, globalEntries: entries.filter(e => e.source === 'GLOBAL').length };
    },
    apply: (principal, action) => service.apply(principal, action, scope),
    async status(principal) { const status = await service.status(principal); return { entries: status.entries, paused: status.paused }; },
    // BUILD-CHAT-LEARNING-002: on a channel, MEMORY ON / OFF is also the sender's choice about automatic learning (consent, or objection), where the
    // deployment runs it; turning it off erases what it learned.
    async settings(principal, change) {
      const memory = await service.settings(principal, { memory: change.memory });
      if (!memory.ok || service.automaticMode === 'OFF') return memory;
      return service.settings(principal, { automatic: change.memory });
    },
    erase: principal => service.erase(principal, scope),
    record: (events, subjectId) => service.record(scope, events.flatMap(event => Object.hasOwn(FEEDBACK_KINDS, event.kind) ? [{ ...event, kind: event.kind as FeedbackKind }] : []),
      subjectId),
    observe: (principal, observations, context) => service.observe(principal, observations, context, scope),
  };
}
/** BUILD-CHAT-LEARNING-002: in-conversation adaptation only: every sender gets the session-only context; every write is a no-op. */
function sessionOnlyLearning(): ChannelLearning {
  const session: LearningSession = { learning: SESSION_LEARNING, principal: null, subject: null };
  return {
    session: async () => ({ learning: SESSION_LEARNING, subjectId: null, used: async () => undefined }),
    glossary: (_view, messages, aliases, adapted = []) => ({ glossary: requestGlossary(session, messages, aliases, adapted).glossary, privateEntries: 0, globalEntries: 0 }),
    apply: async () => ({ ok: false, code: 'LEARNING_OFF' }), status: async () => ({ entries: [], paused: false }), settings: async () => ({ ok: false }),
    erase: async () => undefined, record: async () => undefined, observe: async () => undefined,
  };
}
/** The learning service on the channel host's database, or null when learning is off. */
export function channelLearningService(env: Env, host: ChannelHost): LearningService | null {
  const config = learningConfig(env);
  return config.enabled ? createLearningService({ config, host }) : null;
}
