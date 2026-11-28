// SPDX-License-Identifier: AGPL-3.0-only
import type { ConversationLanguage, ConversationReview } from './conversation-lifecycle';
import type { AwaitingAmount } from './amount-shortcuts';

/**
 * One FloFi chat message (`state/flofi-conversation.ts` writes them; `components/copilot-panel.tsx` shows them). Presentation only: a message
 * is never authority for any workflow, Review, wallet or execution fact.
 */
export type ChatMessage = {
  readonly id: number; readonly role: 'you' | 'system' | 'ai' | 'flofi'; readonly text: string;
  readonly notes?: readonly string[]; readonly options?: readonly string[];
  /** BUILD-FLOFI-UNIFIED-COPILOT-001: a FloFi page that answers a "where/how" question (a relative path from the platform guide). */
  readonly link?: { readonly path: string; readonly label: string };
  /** BUILD-FLOFI-UNIFIED-COPILOT-001: the options are the user's own saved names (rendered and sent untranslated). */
  readonly verbatim?: boolean;
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
  /**
   * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (A09): written in the person's conversational language (`language`), not the interface's — FloFi
   * answers in the language the person writes in — so it stays in that language whatever the interface shows.
   */
  readonly fixedLanguage?: true;
  /**
   * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (UX-02): this message is FloFi's structured question for an amount (the engine's open draft when it was
   * written). The panel offers balance shortcuts under it only while it is the latest message and the engine still waits for exactly this.
   */
  readonly awaitingAmount?: AwaitingAmount;
};
/** One rendering of a FloFi message. */
export type ChatContent = Pick<ChatMessage, 'text' | 'notes' | 'options' | 'question' | 'review'>;
/**
 * The message as the interface shows it now: a message rendered in both languages follows the CURRENT language, unless it was written in the
 * person's own conversational language (`fixedLanguage`), which it keeps; any other stays as written.
 */
export function shownMessage(message: ChatMessage, language: ConversationLanguage): ChatMessage {
  const shown = message.fixedLanguage && message.language ? message.language : language, variant = message.variants?.[shown];
  return variant ? { ...message, ...variant, language: shown } : message;
}
/** How a deterministic message is written in one language: its text, and optionally its notes, options, question and Review. */
export type Rendering = string | readonly [string, Partial<ChatContent>?];
