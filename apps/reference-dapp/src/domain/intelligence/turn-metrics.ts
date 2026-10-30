// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001: one content-free analytics record per Copilot turn, for every surface (FloFi's chat, Channel Core). It counts,
 * from the engine's own ledger, how a request progressed — clarifications, questions repeated about a field FloFi had already asked, corrections,
 * user turns until a proposal — and whether the model's interpretation became a proposal as interpreted (an inferred-versus-validated mismatch is
 * an actionable intent FloFi's validation stopped). Codes and counters only: never text, values, assets, networks, amounts or identities.
 * Model usage (tokens per round, tool calls) is the interpretation record's (`flofi.copilot.interpret`); no cost is computed without a price source.
 */
import type { CopilotConversation, CopilotReply } from '../copilot-conversation';

export type CopilotSurface = 'WEB' | 'CHANNEL';
export type TurnMetrics = { readonly event: 'flofi.copilot.turn'; readonly version: 1; readonly surface: CopilotSurface; readonly outcome: CopilotReply['kind'];
  readonly code: string | null; readonly interpreted: string | null; readonly mismatch: boolean; readonly clarifications: number; readonly repeatedQuestions: number;
  readonly corrections: number; readonly turnsInRequest: number; readonly proposalSteps: number };
const ACTIONABLE = new Set(['ACTION', 'COMPOSITION', 'GOAL', 'EDIT', 'REPEAT', 'REMOVE', 'INSERT', 'POSITION', 'AUTOMATION']);
const OUTCOMES = new Set(['PROPOSAL', 'AUTOMATION_PROPOSAL', 'ANSWER', 'CLARIFICATION', 'UNSUPPORTED', 'FAILED', 'MEMORY']);
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
/** `interpreted`: the model intent's kind, `LOCAL` for a turn FloFi answered itself, null when the model failed. */
export function turnMetrics(before: CopilotConversation, reply: CopilotReply, next: CopilotConversation, interpreted: string | null, surface: CopilotSurface): TurnMetrics {
  const ledger = next.ledger ?? before.ledger, command = reply.command;
  return { event: 'flofi.copilot.turn', version: 1, surface, outcome: reply.kind, code: reply.code && CODE.test(reply.code) ? reply.code : null,
    interpreted: interpreted && /^[A-Z_]{2,40}$/.test(interpreted) ? interpreted : null,
    mismatch: interpreted !== null && ACTIONABLE.has(interpreted) && (reply.kind === 'UNSUPPORTED' || reply.kind === 'FAILED' || reply.kind === 'CLARIFICATION'),
    clarifications: reply.kind === 'CLARIFICATION' ? next.clarifications : before.clarifications, repeatedQuestions: ledger?.repeats ?? 0,
    corrections: ledger?.corrected.length ?? 0, turnsInRequest: (before.ledger?.turns ?? 0) + 1,
    proposalSteps: !command ? 0 : command.type === 'ADD_SEQUENCE' ? command.steps.length : 1 };
}
const count = (value: unknown, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
/** Strict re-validation of a record a client sent: the exact keys and shapes above, or null. */
export function parseTurnMetrics(value: unknown): TurnMetrics | null {
  const v = value as Record<string, unknown>;
  const keys = ['event', 'version', 'surface', 'outcome', 'code', 'interpreted', 'mismatch', 'clarifications', 'repeatedQuestions', 'corrections', 'turnsInRequest', 'proposalSteps'];
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== [...keys].sort().join()) return null;
  if (v.event !== 'flofi.copilot.turn' || v.version !== 1 || (v.surface !== 'WEB' && v.surface !== 'CHANNEL') || !OUTCOMES.has(v.outcome as string)) return null;
  if (!(v.code === null || typeof v.code === 'string' && CODE.test(v.code)) || !(v.interpreted === null || typeof v.interpreted === 'string' && /^[A-Z_]{2,40}$/.test(v.interpreted))) return null;
  if (typeof v.mismatch !== 'boolean' || !count(v.clarifications, 16) || !count(v.repeatedQuestions, 64) || !count(v.corrections, 16) || !count(v.turnsInRequest, 64) ||
    !count(v.proposalSteps, 8)) return null;
  return v as unknown as TurnMetrics;
}
