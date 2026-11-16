// SPDX-License-Identifier: AGPL-3.0-only
/**
 * How a FloFi chat answer button looks: FloFi's next lifecycle step in the primary blue, an ordinary choice as a neutral chip, an undo, discard
 * or delete in the danger tone. Presentation only: the variant is read from which existing copy wrote the label (FloFi's lifecycle copy, the
 * Copilot's assist and memory copy, the interface catalog), in either language. The label, what the button sends, every handler and every state
 * transition stay exactly as they are. Anything not listed (a clarification answer, a token, a step, a network, a saved name, "No", "Not now")
 * is a secondary choice, so an unknown or model-written label is never presented as a primary or destructive action.
 */
import { conversationCopy } from './conversation-copy';
import { ASSIST_COPY } from './copilot-assist';
import { learningCopy } from './copilot-learning-copy';
import type { ConversationLanguage } from './conversation-lifecycle';
import { translate } from '../i18n/translate';

export type ChatActionVariant = 'primary' | 'secondary' | 'destructive';

const LANGUAGES: readonly ConversationLanguage[] = ['EN', 'PT'];
/** The step forward FloFi offers: review, add, confirm, execute, continue, apply, check, start new, connect, resume, accept its own offer. */
const PRIMARY = new Set(LANGUAGES.flatMap(language => {
  const c = conversationCopy(language), a = ASSIST_COPY[language];
  return [c.review, c.addAnother, c.confirmYes, c.executeYes, c.continueYes, c.continueAccept, c.applyEdit, c.checkStatus, c.startNew,
    a.resumeOption, a.confirmOption, a.recipientSaveOption, translate(language, 'Connect wallet')];
}));
/** Answers that undo, discard or delete something. */
const DESTRUCTIVE = new Set(LANGUAGES.flatMap(language => [conversationCopy(language).undo, conversationCopy(language).discardEdit,
  learningCopy(language).forgetAllOptions[0]]));
/** The wallet network switch FloFi offers in the chat ("Switch to Base" / "Mudar para Base", `app-shell.tsx`): its fixed prefix. */
const SWITCH_NETWORK = LANGUAGES.map(language => translate(language, 'Switch to {0}', ''));

export function chatActionVariant(option: string): ChatActionVariant {
  const label = option.trim();
  if (DESTRUCTIVE.has(label)) return 'destructive';
  if (PRIMARY.has(label) || SWITCH_NETWORK.some(prefix => label.length > prefix.length && label.startsWith(prefix))) return 'primary';
  return 'secondary';
}
