// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The MCP surface of FloFi's automations: READ-ONLY. `list_automation_types` states what automations are and how they are authorized (static,
 * FloFi's own copy); `get_automation_status` reads the owner's own rules through the Automations BFF read path — `overview`, or one rule's
 * `history` — and explains them with the shared, FloFi-authored copy of `automations/explain.ts`.
 *
 * Owners are wallets (`{namespace, address}`): an OAuth account's proven, revocable wallet links (`/connections`), or a static developer
 * credential's operator-granted EVM wallets. Each read is made AS exactly one of them, with exactly those wallets as the verified principals
 * (`automationOperation` refuses any other owner), so another owner's rule answers NOT FOUND exactly like an id that does not exist.
 *
 * The port has no other method: nothing here creates, pauses, resumes, archives, replaces, rebinds, dismisses or opens an automation, mints an
 * approval link, reads a balance or signs anything. Those are the owner's, in the FloFi app.
 */
import { AUTOMATION_KINDS, EXECUTION_MODE, type AutomationKind } from '../automations/definition.ts';
import { AUTOMATION_FAQ_TOPICS, automationFaq, explainRuleStatus, KIND_LABEL, OUTCOME_LABEL, ruleSummary, STATE_LABEL, type Language } from '../automations/explain.ts';
import type { OverviewView, RuleHistoryView, RuleView } from '../automations/views.ts';
import { platformAnswer } from '../domain/intelligence/platform-guide.ts';
import { translate } from '../i18n/translate.ts';
import { refuse } from '../platform/refusal.ts';
import type { McpWalletOwner } from './config.ts';
import { budgetTransport, DeadlineError, isDeadlineError, MCP_UPSTREAM_TIMEOUTS, withinBudget, type RequestBudget } from './deadline.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type AutomationRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };
/**
 * The read-only automation port of one MCP request. `principals` are the wallets the caller may read as; `owner` must be one of them. Injectable
 * (`GatewayOptions.automations`) so tests need no PostgreSQL and no network.
 */
export type AutomationReadPort = {
  readonly overview: (owner: McpWalletOwner, principals: readonly McpWalletOwner[]) => Promise<AutomationRead<OverviewView>>;
  readonly history: (owner: McpWalletOwner, ruleId: string, principals: readonly McpWalletOwner[]) => Promise<AutomationRead<RuleHistoryView>>;
};
/** The id `typedId('aut')` gives a rule (`automations/runtime.ts`). */
export const AUTOMATION_RULE_ID = '^aut_[a-z2-7]{26}$';

/**
 * The deployment's port: the Automations BFF read path (`server/automation-operation.ts`) — in process on an embedded runtime, forwarded to the
 * API (`POST /v1/automations/overview|history` with the owner in the server-to-server header) on the remote one. Remote reads also stop with the
 * request's budget. Loaded on first use: an MCP request that reads no automation never loads the automation service.
 */
export function deploymentAutomationReader(env: Env, budget?: RequestBudget): AutomationReadPort {
  const seams = (principals: readonly McpWalletOwner[]) => ({ principals: async () => principals, env, ...budget ? { transport: budgetTransport(budget) } : {} });
  const operation = async () => (await import('../server/automation-operation.ts')).automationOperation;
  return {
    overview: async (owner, principals) => (await operation())<OverviewView>('overview', [], owner, seams(principals)),
    history: async (owner, ruleId, principals) => (await operation())<RuleHistoryView>('history', [ruleId], owner, seams(principals)),
  };
}

// ── list_automation_types (static) ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** The Automations workspace's own description of each kind (catalog keys; Portuguese in the central catalog). */
const KIND_DESCRIPTION: Readonly<Record<AutomationKind, string>> = Object.freeze({ SCHEDULED_DCA: 'Prepares a buy of a fixed amount every week or every day.',
  PRICE_TRIGGER: 'Prepares a buy or a sell when the price reaches the value you chose.', DAILY_WATCH: 'Tells you regularly how the assets you choose are doing.' });
export const AUTOMATION_MANAGEMENT: Readonly<Record<Language, string>> = Object.freeze({
  EN: 'Creating, activating, pausing, resuming, archiving or changing an automation is done only by its owner in the FloFi app (Automations page), with the owner\'s own confirmation. This MCP server cannot create, change, pause, resume, archive or approve automations, and it never moves funds or signs.',
  PT: 'Criar, ativar, pausar, retomar, arquivar ou alterar uma automação é feito apenas pelo dono no app da FloFi (página Automações), com a confirmação do próprio dono. Este servidor MCP não pode criar, alterar, pausar, retomar, arquivar nem aprovar automações, e nunca move fundos nem assina.',
});
/** What FloFi's automations are and how each occurrence is authorized. No user data, no network. */
export function automationTypes(language: Language) {
  return {
    kinds: AUTOMATION_KINDS.map(kind => ({ kind, label: translate(language, KIND_LABEL[kind]), description: translate(language, KIND_DESCRIPTION[kind]) })),
    executionMode: { mode: EXECUTION_MODE, label: translate(language, 'Ask me before every execution'), description: automationFaq('AUTHORIZATION', language) },
    delegatedExecution: { available: false as const, reason: 'EXECUTOR_FUNDED_GAS_RETIRED' as const, description: automationFaq('DELEGATION_STATUS', language) },
    faq: AUTOMATION_FAQ_TOPICS.map(topic => ({ topic, answer: automationFaq(topic, language) })),
    // The Automations page, as FloFi's platform guide names it (a relative path on FloFi's own website).
    management: AUTOMATION_MANAGEMENT[language], link: platformAnswer('AUTOMATIONS', language, 'MCP').link,
  };
}

// ── get_automation_status ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const label = (language: Language, table: Readonly<Record<string, string>>, code: string | null) => code === null ? null : table[code] ? translate(language, table[code]!) : code;
/** One rule as FloFi's own records state it, with FloFi's explanation. Never an approval link, a balance or another owner's data. */
function ruleStatus(owner: McpWalletOwner, rule: RuleView, history: RuleHistoryView | null, language: Language) {
  return { ruleId: rule.ruleId, name: rule.name, kind: rule.kind, kindLabel: translate(language, KIND_LABEL[rule.kind]), state: rule.state,
    stateLabel: label(language, STATE_LABEL, rule.state), executionMode: rule.executionMode, owner: { namespace: owner.namespace, address: owner.address },
    summary: ruleSummary(rule, language), nextEvaluationAt: rule.nextEvaluationAt, lastEvaluationAt: rule.lastEvaluationAt, lastOutcome: rule.lastOutcome,
    lastOutcomeLabel: label(language, OUTCOME_LABEL, rule.lastOutcome), attention: rule.attention, pendingProposals: rule.pending, expiresAt: rule.expiresAt,
    // Overview: the rule's own history and proposals were not read, and the explanation says so instead of guessing.
    explanation: explainRuleStatus(rule, history?.entries ?? null, history?.occurrences ?? null, language).text };
}
type Read<T> = { readonly owner: McpWalletOwner; readonly result: AutomationRead<T> };
const INCOMPLETE_NOTE: Readonly<Record<Language, string>> = Object.freeze({
  EN: 'Some linked wallets could not be read now: their automations are UNKNOWN (not "none"). Read get_automation_status again.',
  PT: 'Algumas carteiras vinculadas não puderam ser lidas agora: as automações delas são DESCONHECIDAS (não "nenhuma"). Leia get_automation_status de novo.',
});

/**
 * The owner's automations (or one of them, `ruleId`), read as each of `owners`. A read that failed makes the result INCOMPLETE — said explicitly,
 * never an empty list; the request's own deadline during a read makes the whole status UNKNOWN (the tool's STATUS_READ timeout). One rule that no
 * owner has is `AUTOMATION_NOT_FOUND` whether it does not exist or belongs to someone else.
 */
export async function automationStatus(port: AutomationReadPort, owners: readonly McpWalletOwner[], ruleId: string | undefined, language: Language,
  budget?: RequestBudget) {
  const read = async <T>(owner: McpWalletOwner, call: () => Promise<AutomationRead<T>>): Promise<Read<T>> => {
    try { return { owner, result: await withinBudget(budget, MCP_UPSTREAM_TIMEOUTS.read, () => call()) }; }
    catch (error) { return { owner, result: { ok: false, code: isDeadlineError(error) ? error.code : 'AUTOMATION_UNAVAILABLE' } }; }
  };
  const reads: readonly Read<OverviewView | RuleHistoryView>[] = await Promise.all(owners.map(owner => ruleId === undefined
    ? read<OverviewView | RuleHistoryView>(owner, () => port.overview(owner, owners)) : read<OverviewView | RuleHistoryView>(owner, () => port.history(owner, ruleId, owners))));
  const ended = budget?.ended();
  if (ended || reads.some(r => !r.result.ok && (r.result.code === 'MCP_REQUEST_TIMEOUT' || r.result.code === 'MCP_REQUEST_CANCELLED')))
    throw new DeadlineError(ended === 'CLIENT_CLOSED' || reads.some(r => !r.result.ok && r.result.code === 'MCP_REQUEST_CANCELLED') ? 'MCP_REQUEST_CANCELLED' : 'MCP_REQUEST_TIMEOUT');
  const failed = reads.filter(r => !r.result.ok && !(ruleId !== undefined && r.result.code === 'AUTOMATION_NOT_FOUND'))
    .map(r => ({ owner: { namespace: r.owner.namespace, address: r.owner.address }, code: r.result.ok ? 'AUTOMATION_UNAVAILABLE' : r.result.code }));
  // A deployment without automations answers every owner the same way: that is its state, not an incomplete read.
  if (failed.length === owners.length && failed.every(f => f.code === 'AUTOMATIONS_NOT_ENABLED')) refuse('AUTOMATIONS_NOT_ENABLED');
  const rules = reads.flatMap(r => !r.result.ok ? [] : ruleId === undefined
    ? (r.result.value as OverviewView).rules.map(rule => ruleStatus(r.owner, rule, null, language))
    : [ruleStatus(r.owner, (r.result.value as RuleHistoryView).rule, r.result.value as RuleHistoryView, language)]);
  if (ruleId !== undefined && rules.length) return { status: 'COMPLETE' as const, complete: true, rules: rules.slice(0, 1), failedReads: [] };
  if (ruleId !== undefined && !failed.length) return refuse('AUTOMATION_NOT_FOUND');
  return { status: failed.length ? 'INCOMPLETE' as const : 'COMPLETE' as const, complete: !failed.length, rules, failedReads: failed,
    ...failed.length ? { note: INCOMPLETE_NOTE[language] } : {} };
}
