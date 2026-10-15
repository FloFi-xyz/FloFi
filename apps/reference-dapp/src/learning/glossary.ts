// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: the glossary of one Copilot V2 request, for the web chat and Channel Core alike: the entries matched in its open request
 * (`replaySegment`: the user turns since FloFi's last proposal, answer or refusal), this conversation's own aliases first, then the verified
 * identity's saved meanings, then FloFi's global glossary; bounded and rendered as data (`server/copilot-glossary.ts`).
 */
import { glossaryEntries, LEXICON_LIMITS, type LexiconEntry } from '../domain/copilot-lexicon.ts';
import { renderGlossary } from '../server/copilot-glossary.ts';
import { replaySegment } from '../server/copilot-service.ts';
import type { LearningSession } from './service.ts';

export function requestGlossary(session: LearningSession, messages: readonly { readonly role: string; readonly text: string }[], aliases: readonly LexiconEntry[]):
  { readonly glossary: string | null; readonly entries: readonly LexiconEntry[] } {
  const segment = replaySegment(messages.map(message => ({ role: message.role, content: message.text }))).join('\n');
  const entries = [...glossaryEntries(segment, aliases), ...glossaryEntries(segment, [...session.learning.private, ...session.learning.global])]
    .filter((entry, index, all) => all.findIndex(e => e.term === entry.term) === index).slice(0, LEXICON_LIMITS.maxGlossary);
  return { glossary: renderGlossary(entries, session.learning.language), entries };
}
