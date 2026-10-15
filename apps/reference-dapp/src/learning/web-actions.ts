// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: the web chat's learning requests, without the Next.js request plumbing (`app/learning-action.ts` and
 * `app/copilot-action.ts` only pass the verified session principals and the untrusted browser input). Every browser input is parsed strictly
 * here; every memory change is on the principal the server verified.
 */
import type { CopilotLearning, MemoryAction } from '../domain/copilot-conversation.ts';
import { glossaryEntries, parseLexicon, validateLexiconEntry, type LexiconEntry } from '../domain/copilot-lexicon.ts';
import { renderGlossary } from '../server/copilot-glossary.ts';
import { replaySegment } from '../server/copilot-service.ts';
import { pickPrincipal, type LearningNamespace } from '../server/learning-web.ts';
import type { WalletPrincipal } from '../server/session-principal.ts';
import { LEARNING_NOTICE_VERSION } from './config.ts';
import { CLIENT_FEEDBACK_KINDS, type FeedbackKind, type LearningCode, type LearningService, type LearningSession } from './service.ts';

type Service = LearningService | 'OFF' | 'UNAVAILABLE';
export type LearningStatusView = { readonly enabled: false } | {
  readonly enabled: true;
  /** The wallets this browser has proven (choosable), and the one this memory belongs to (null: anonymous). */
  readonly identities: readonly LearningNamespace[]; readonly identity: { readonly namespace: LearningNamespace; readonly short: string } | null;
  /** The engine's context for this browser's next turns. */ readonly learning: CopilotLearning;
  readonly memoryEnabled: boolean; readonly paused: boolean; readonly contributeEnabled: boolean;
  readonly entries: readonly { readonly term: string; readonly target: string; readonly createdAt: string | null }[];
  readonly noticeVersion: number;
};
export type LearningActionResult = { readonly ok: true } | { readonly ok: false; readonly code: LearningCode | 'LEARNING_REQUEST_INVALID' | 'LEARNING_OFF' };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const UNAVAILABLE: CopilotLearning = Object.freeze({ memory: 'UNAVAILABLE', owner: null, private: [], global: [], globalVersion: null, language: null });

export async function statusView(service: Service, principals: readonly WalletPrincipal[], preferred: LearningNamespace | null): Promise<LearningStatusView> {
  if (service === 'OFF') return { enabled: false };
  const identities = [...new Set(principals.map(p => p.namespace))], principal = pickPrincipal(principals, preferred);
  const identity = principal?.kind === 'WALLET' ? { namespace: principal.namespace, short: `${principal.account.slice(0, 6)}…${principal.account.slice(-4)}` } : null;
  const empty = { memoryEnabled: false, paused: false, contributeEnabled: false, entries: [], noticeVersion: LEARNING_NOTICE_VERSION };
  if (service === 'UNAVAILABLE') return { enabled: true, identities, identity, learning: UNAVAILABLE, ...empty };
  const session = await service.session(principal);
  if (!principal || session.learning.memory === 'UNAVAILABLE') return { enabled: true, identities, identity, learning: session.learning, ...empty };
  try {
    const status = await service.status(principal);
    return { enabled: true, identities, identity, learning: session.learning, memoryEnabled: status.memoryEnabled, paused: status.paused,
      contributeEnabled: status.contributeEnabled, entries: status.entries.map(e => ({ term: e.term, target: e.target, createdAt: e.createdAt })), noticeVersion: LEARNING_NOTICE_VERSION };
  } catch { return { enabled: true, identities, identity, learning: UNAVAILABLE, ...empty }; }
}

/** A memory action from the browser (what the engine described after the user's click), parsed strictly. */
export function parseMemoryAction(raw: unknown): MemoryAction | null {
  if (!plain(raw)) return null;
  if (raw.op === 'SAVE' && plain(raw.entry) && Object.keys(raw).length === 2) {
    const valid = validateLexiconEntry(raw.entry.term, raw.entry.target);
    return valid.ok ? { op: 'SAVE', entry: { term: valid.term, target: valid.target, source: 'PRIVATE' } } : null;
  }
  if (raw.op === 'FORGET' && typeof raw.term === 'string' && Object.keys(raw).length === 2 && raw.term.length <= 64) return { op: 'FORGET', term: raw.term.trim().toLowerCase() };
  if (raw.op === 'FORGET_ALL' && Object.keys(raw).length === 1) return { op: 'FORGET_ALL' };
  if (raw.op === 'LANGUAGE' && (raw.language === 'EN' || raw.language === 'PT') && Object.keys(raw).length === 2) return { op: 'LANGUAGE', language: raw.language };
  return null;
}
export async function applyAction(service: Service, principals: readonly WalletPrincipal[], preferred: LearningNamespace | null, raw: unknown): Promise<LearningActionResult> {
  if (service === 'OFF') return { ok: false, code: 'LEARNING_OFF' };
  if (service === 'UNAVAILABLE') return { ok: false, code: 'LEARNING_UNAVAILABLE' };
  const action = parseMemoryAction(raw);
  if (!action) return { ok: false, code: 'LEARNING_REQUEST_INVALID' };
  return service.apply(pickPrincipal(principals, preferred), action, 'WEB');
}
export async function applySettings(service: Service, principals: readonly WalletPrincipal[], preferred: LearningNamespace | null, raw: unknown): Promise<LearningActionResult> {
  if (service === 'OFF') return { ok: false, code: 'LEARNING_OFF' };
  if (service === 'UNAVAILABLE') return { ok: false, code: 'LEARNING_UNAVAILABLE' };
  const principal = pickPrincipal(principals, preferred);
  if (!principal) return { ok: false, code: 'LEARNING_IDENTITY_REQUIRED' };
  if (!plain(raw) || !Object.keys(raw).every(key => key === 'memory' || key === 'contribute') || !Object.values(raw).every(value => typeof value === 'boolean') ||
    !Object.keys(raw).length) return { ok: false, code: 'LEARNING_REQUEST_INVALID' };
  return service.settings(principal, raw as { memory?: boolean; contribute?: boolean });
}

export type ClientEvent = { readonly kind: FeedbackKind; readonly outcome: string | null; readonly language: 'EN' | 'PT' | null; readonly privateEntries: number;
  readonly globalEntries: number; readonly knowledgeVersion: number | null };
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 64 ? value : 0;
/** Content-free events a browser may report (closed kinds, closed codes, small counts); anything else is dropped. At most 8. */
export function parseClientEvents(raw: unknown): ClientEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).flatMap(item => {
    if (!plain(item) || typeof item.kind !== 'string' || !CLIENT_FEEDBACK_KINDS.has(item.kind as FeedbackKind)) return [];
    const outcome = typeof item.outcome === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(item.outcome) ? item.outcome : null;
    const version = typeof item.knowledgeVersion === 'number' && Number.isSafeInteger(item.knowledgeVersion) && item.knowledgeVersion >= 1 ? item.knowledgeVersion : null;
    return [{ kind: item.kind as FeedbackKind, outcome, language: item.language === 'EN' || item.language === 'PT' ? item.language : null,
      privateEntries: count(item.privateEntries), globalEntries: count(item.globalEntries), knowledgeVersion: version }];
  });
}

/** The interpret request's learning options: which proven wallet, and this conversation's own aliases (validated; only ever a hint). */
export function parseInterpretOptions(raw: unknown): { readonly identity: LearningNamespace | null; readonly aliases: LexiconEntry[] } {
  if (!plain(raw)) return { identity: null, aliases: [] };
  return { identity: raw.identity === 'eip155' || raw.identity === 'solana' ? raw.identity : null, aliases: parseLexicon(raw.aliases, 'SESSION') };
}
/** The glossary for one V2 request: entries matched in its open request (`replaySegment`), the user's own first, rendered as data. */
export function requestGlossary(service: LearningService, session: LearningSession, messages: readonly { readonly role: string; readonly text: string }[],
  aliases: readonly LexiconEntry[]): { readonly glossary: string | null; readonly entries: readonly LexiconEntry[] } {
  const segment = replaySegment(messages.map(message => ({ role: message.role, content: message.text }))).join('\n');
  const entries = [...glossaryEntries(segment, aliases), ...service.glossary(segment, session)].filter((entry, index, all) => all.findIndex(e => e.term === entry.term) === index)
    .slice(0, 8);
  return { glossary: renderGlossary(entries, session.learning.language), entries };
}
