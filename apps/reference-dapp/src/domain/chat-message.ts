// SPDX-License-Identifier: AGPL-3.0-only
import type { ConversationLanguage, ConversationReview } from './conversation-lifecycle';

/**
 * One FloFi chat message (`state/flofi-conversation.ts` writes them; `components/copilot-panel.tsx` shows them). Presentation only: a message
 * is never authority for any workflow, Review, wallet or execution fact.
 */
export type ChatMessage = {
  readonly id: number; readonly role: 'you' | 'system' | 'ai' | 'flofi'; readonly text: string;
  readonly notes?: readonly string[]; readonly options?: readonly string[];
  /** FloFi's lifecycle copy is written in this language; other `system` copy is translated by the interface. */
  readonly language?: ConversationLanguage;
  readonly review?: ConversationReview; readonly question?: string;
  /** A catalog message's values (`{0}`, `{1}`…): the interface renders `text` through the catalog with them, in its current language. */
  readonly params?: readonly string[];
  /**
   * P0 hotfix (locale contract): FloFi's deterministic messages are rendered from the same copy key and values in BOTH languages when they are
   * written, so the chat shows each in the CURRENT interface language (`shownMessage`) — switching language never leaves the other one behind.
   * Model-written text is not here (it stays as written, and the catalog translates what it knows).
   */
  readonly variants?: Readonly<Record<ConversationLanguage, ChatContent>>;
};
/** One rendering of a FloFi message. */
export type ChatContent = Pick<ChatMessage, 'text' | 'notes' | 'options' | 'question' | 'review'>;
/** The message as the interface shows it now: a message rendered in both languages follows the CURRENT language; any other stays as written. */
export function shownMessage(message: ChatMessage, language: ConversationLanguage): ChatMessage {
  const variant = message.variants?.[language];
  return variant ? { ...message, ...variant, language } : message;
}
/** How a deterministic message is written in one language: its text, and optionally its notes, options, question and Review. */
export type Rendering = string | readonly [string, Partial<ChatContent>?];
