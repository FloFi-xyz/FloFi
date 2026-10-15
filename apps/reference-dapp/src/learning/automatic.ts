// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-002: when persistent automatic learning may run for an identity, and when its evidence becomes a learned meaning. Pure and
 * deterministic, so the rule is the same in every process and can be explained to the user, an operator and counsel:
 *
 *   permitted   the deployment's basis (`FLOFI_LEARNING_AUTOMATIC`) and the identity's own choice: consent → only after the identity turned it on
 *               under the current notice; legitimate interest → unless the identity objected; off → never.
 *   promotion   a meaning the user STATED is learned at once (their latest statement for a word replaces any other). Otherwise a meaning needs a
 *               weight of at least 2 (each answer to FloFi's question, correction or confirmation counts 1, each from a different request), at
 *               least twice the combined weight of every other meaning observed for the same word, and at least 2 more than it; anything less is
 *               insufficient or a conflict, and nothing is learned.
 *   language    the starting language of an identity's conversations needs 3 conversations unmistakably in it, and 3× any other.
 */
import type { AutomaticMode } from './config.ts';

export const AUTOMATIC_NOTICE_VERSION = 2;
export const AUTOMATIC_RULES = Object.freeze({ promoteWeight: 2, dominance: 2, margin: 2, languageConversations: 3, languageDominance: 3, maxEvidence: 128, maxTargetsPerTerm: 4,
  evidenceDays: 90, counterCap: 1_000, maxObservations: 8 });
export type AutomaticBasis = Exclude<AutomaticMode, 'OFF'>;
export type AutomaticSetting = { readonly enabled: boolean; readonly basis: AutomaticBasis; readonly noticeVersion: number; readonly decidedAt: string };
export type EvidenceCounts = { readonly target: string; readonly stated: number; readonly clarified: number; readonly corrected: number; readonly confirmed: number;
  readonly conversations: number };

/** Whether persistent automatic learning runs for an identity now. */
export function automaticPermitted(mode: AutomaticMode, setting: AutomaticSetting | null): boolean {
  if (mode === 'OFF') return false;
  if (mode === 'CONSENT') return !!setting && setting.enabled && setting.basis === 'CONSENT' && setting.noticeVersion >= AUTOMATIC_NOTICE_VERSION;
  return setting === null || setting.enabled;
}
export const evidenceWeight = (row: EvidenceCounts): number => 2 * row.stated + row.clarified + row.corrected + row.confirmed;
export type TermDecision = { readonly target: string | null; readonly reason: 'STATED' | 'REPEATED' | 'INSUFFICIENT' | 'CONFLICT' };
/** The meaning one word has for an identity, from every meaning observed for it. */
export function decideTerm(rows: readonly EvidenceCounts[]): TermDecision {
  const stated = rows.filter(row => row.stated > 0);
  if (stated.length === 1) return { target: stated[0]!.target, reason: 'STATED' };
  if (stated.length > 1) return { target: null, reason: 'CONFLICT' };
  const ranked = [...rows].sort((a, b) => evidenceWeight(b) - evidenceWeight(a) || (a.target < b.target ? -1 : 1));
  const best = ranked[0];
  if (!best || evidenceWeight(best) < AUTOMATIC_RULES.promoteWeight) return { target: null, reason: 'INSUFFICIENT' };
  const weight = evidenceWeight(best), others = ranked.slice(1).reduce((total, row) => total + evidenceWeight(row), 0);
  return weight < others * AUTOMATIC_RULES.dominance || weight - others < AUTOMATIC_RULES.margin ? { target: null, reason: 'CONFLICT' } : { target: best.target, reason: 'REPEATED' };
}
/** The starting language of an identity's conversations, or null. */
export function decideLanguage(rows: readonly EvidenceCounts[]): 'EN' | 'PT' | null {
  const ranked = [...rows].sort((a, b) => b.conversations - a.conversations);
  const best = ranked[0], other = ranked[1]?.conversations ?? 0;
  if (!best || best.conversations < AUTOMATIC_RULES.languageConversations || other * AUTOMATIC_RULES.languageDominance > best.conversations) return null;
  return best.target === 'language:PT' ? 'PT' : best.target === 'language:EN' ? 'EN' : null;
}
