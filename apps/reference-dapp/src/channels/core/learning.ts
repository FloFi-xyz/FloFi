// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: what Channel Core needs from learning, as an interface the channel wiring implements (`channels/runtime.ts` adapts the
 * learning service). Channel Core stays provider-neutral and keeps its layering: it never imports the learning store, the database or the
 * Copilot service. A channel sender is a learning identity of its own — (channel, business, keyed sender digest) — never a wallet and never a
 * sender on another channel.
 */
import type { CopilotLearning, MemoryAction } from '../../domain/copilot-conversation';
import type { LexiconEntry } from '../../domain/copilot-lexicon';

export type ChannelLearningPrincipal = { readonly kind: 'CHANNEL'; readonly channel: string; readonly business: string; readonly sender: Buffer };
export type ChannelLearningSession = { readonly learning: CopilotLearning; readonly subjectId: string | null; readonly used: (entries: readonly LexiconEntry[]) => Promise<void> };
export type ChannelLearningEvent = { readonly kind: string; readonly outcome?: string | null; readonly language?: 'EN' | 'PT' | null; readonly privateEntries?: number;
  readonly globalEntries?: number; readonly knowledgeVersion?: number | null };
export interface ChannelLearning {
  /** The sender's learning context for one turn (never fails: UNAVAILABLE on any problem). */
  readonly session: (principal: ChannelLearningPrincipal) => Promise<ChannelLearningSession>;
  /** The rendered glossary data for one interpreter request, and how many of its lines are the sender's own / global. */
  readonly glossary: (session: ChannelLearningSession, messages: readonly { readonly role: string; readonly text: string }[], aliases: readonly LexiconEntry[]) =>
    { readonly glossary: string | null; readonly privateEntries: number; readonly globalEntries: number };
  readonly apply: (principal: ChannelLearningPrincipal, action: MemoryAction) => Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
  readonly status: (principal: ChannelLearningPrincipal) => Promise<{ readonly entries: readonly { readonly term: string; readonly target: string }[]; readonly paused: boolean }>;
  readonly settings: (principal: ChannelLearningPrincipal, change: { readonly memory: boolean }) => Promise<{ readonly ok: boolean }>;
  /** Erases everything FloFi remembers for the sender (memory, settings, contributions). */
  readonly erase: (principal: ChannelLearningPrincipal) => Promise<unknown>;
  /** Content-free feedback (closed kinds and codes, counts), bounded by the implementation. */
  readonly record: (events: readonly ChannelLearningEvent[], subjectId: string | null) => Promise<void>;
}
