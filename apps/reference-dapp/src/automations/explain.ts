// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Automation management copy shared by the Automations workspace, the Copilot (web), Telegram and MCP. Everything here is FloFi-authored and
 * deterministic, built only from FloFi's own records (the browser-safe shapes of `views.ts`) — never from model prose. Pure: no state,
 * component, server action, network, clock or signing import (`boundaries.test.ts`).
 *
 * English labels translate through the central catalog (`i18n/translate.ts`; Portuguese in `i18n/pt-automations.ts` and its siblings), exactly as
 * the workspace's `t(...)` does. The explanations, answers and the schedule-change reading below carry their own EN/PT text.
 *
 *   labels               OUTCOME_LABEL, ERROR_TEXT, STATE_LABEL, KIND_LABEL, OCCURRENCE_LABEL, WEEKDAYS (moved from the workspace unchanged)
 *   ruleSummary          one line: kind, name, action, schedule or condition, state and execution mode
 *   explainRuleStatus    why a rule ran, did not run, or when it is evaluated next — only from recorded facts; a missing fact is named, never guessed
 *   AUTOMATION_FAQ       short answers that state what the code does (EN/PT), `automationFaq` and the keyword matcher `matchAutomationFaq`
 *   parseScheduleChange  a deterministic EN/PT reading of a schedule change ("muda para sexta", "change it to Friday 9:30"); it fails closed —
 *                        a word it did not read and that is no filler, a symbol or emoji, or a reading out of place ("in 2h", "from 9am",
 *                        "no Friday") refuses the change — and never invents a time or a day
 */
import { translate } from '../i18n/translate.ts';
import type { Language } from '../i18n/language.ts';
import type { HistoryEntryView, ObservationView, OccurrenceView, RuleView, SchedulePatchView } from './views.ts';

export type { Language } from '../i18n/language.ts';
type Kind = RuleView['kind'];

// ── Labels (English catalog keys; the workspace renders them with `t(...)`) ───────────────────────────────────────────────────────────
/** ISO weekdays 1 = Monday … 7 = Sunday (index = weekday − 1). */
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export const STATE_LABEL: Readonly<Record<string, string>> = { ACTIVE: 'Active', PAUSED: 'Paused', EXPIRED: 'Expired', ARCHIVED: 'Archived' };
// P0 approved UX (board 12): plain names for the three routines.
export const KIND_LABEL: Readonly<Record<Kind, string>> = { SCHEDULED_DCA: 'Recurring buy', PRICE_TRIGGER: 'Price trigger', DAILY_WATCH: 'Daily watch' };
export const OCCURRENCE_LABEL: Readonly<Record<string, string>> = { PENDING_OWNER: 'Awaiting you', APPROVAL_CREATED: 'Opened for review', COMPLETED: 'Loaded into your workflow',
  DISMISSED: 'Dismissed', EXPIRED: 'Expired' };
export const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  AUTOMATION_CREATED: 'Automation created', AUTOMATION_PAUSED: 'Paused', AUTOMATION_RESUMED: 'Resumed', AUTOMATION_ARCHIVED: 'Archived', AUTOMATION_EXPIRED: 'Automation expired',
  AUTOMATION_REBOUND: 'Rebound to the current workflow', TRIGGERED: 'Triggered — proposal created', WATCH_REPORTED: 'Market round reported',
  ARMED: 'Evaluated — condition not met (watching)', CONDITION_NOT_MET: 'Evaluated — condition not met', CONDITION_ALREADY_MET: 'Condition already met — waiting for a new crossing',
  CONDITION_STILL_MET: 'Condition still met — no new proposal', REARMED: 'Condition cleared — watching again', COOLDOWN: 'Crossing during the cooldown — no proposal',
  LIMIT_BLOCKED: 'Blocked by a limit — no proposal', MISSED: 'Missed while FloFi was unavailable', WORKFLOW_CHANGED: 'Saved workflow changed — rebind required',
  STRATEGY_STALE: 'No longer reproducible — rebind required', APPROVAL_REQUESTED: 'Opened for review', APPROVAL_APPLIED: 'Loaded into your workflow',
  OWNER_DISMISSED: 'Dismissed', OWNER_PREPARED_BUY: 'You started your own buy in the Editor', OWNER_PREPARED_SELL: 'You started your own sell in the Editor', DUPLICATE_TRIGGER: 'Duplicate trigger ignored',
  PRICE_STALE: 'Price observation too old — ignored', PRICE_SOURCE_OFF: 'No price source on this deployment', PRICE_SOURCE_TIMEOUT: 'Price source timed out — ignored',
  PRICE_SOURCE_UNREACHABLE: 'Price source unreachable — ignored', PRICE_SOURCE_ERROR: 'Price source error — ignored', PRICE_FEED_MISMATCH: 'Price feed failed verification — ignored',
  OCCURRENCE_EXPIRED: 'Expired', AUTOMATION_REBOUND_WITHDRAWN: 'Withdrawn by a rebind',
  // Schedule change by replacement (the old rule's history and withdrawn proposals; the new rule's history).
  AUTOMATION_REPLACED: 'Replaced by a new automation with a changed schedule', AUTOMATION_REPLACEMENT: 'Created to replace an earlier automation (schedule changed)' };
export const ERROR_TEXT: Readonly<Record<string, string>> = {
  WALLET_SESSION_REQUIRED: 'Verify wallet ownership to use automations.', AUTOMATIONS_NOT_ENABLED: 'Automations are not enabled on this deployment.',
  AUTOMATION_STORE_UNAVAILABLE: 'Automations are unavailable on this deployment right now.', AUTOMATION_SCHEMA_NOT_INSTALLED: 'Automations are unavailable on this deployment right now.',
  AUTOMATION_VERSION_CONFLICT: 'This automation changed in another session. Refresh and try again.', AUTOMATION_RULE_LIMIT: 'You have reached the maximum number of automations.',
  BTC_EXECUTION_ROUTE_UNAVAILABLE: 'FloFi has no BTC swap route yet. You can watch BTC and get alerts, but FloFi cannot prepare a BTC purchase.',
  OWNER_EXECUTION_NOT_IMPLEMENTED: 'FloFi cannot execute this action with your wallet yet.', MAINNET_HANDOFF_DISABLED_BY_POLICY: 'Real-funds automations are disabled on this deployment.',
  FLOW_NOT_ENABLED_IN_DEPLOYMENT: 'This action is not enabled on this deployment.', PUBLIC_RECORDING_OFF: 'This action is not enabled on this deployment.',
  LIMIT_AMOUNT_PER_EXECUTION: 'The amount is above your maximum per execution.', LIMIT_SLIPPAGE: 'The max price difference is above your limit.',
  LIMIT_PERIOD_AMOUNT: 'This would exceed your maximum amount for the period.', LIMIT_PERIOD_COUNT: 'This would exceed your maximum number of proposals for the period.',
  PRICE_ASSET_NOT_OBSERVABLE: 'FloFi cannot observe this asset’s price on this deployment.', AUTOMATION_INPUT_INVALID: 'Check the fields and try again.',
  AUTOMATION_SCHEDULE_INVALID: 'Check the schedule and the time zone.', AUTOMATION_CONDITION_INVALID: 'Check the price condition.', AUTOMATION_AMOUNT_INVALID: 'Enter an amount above zero.',
  AUTOMATION_EXPIRY_INVALID: 'The expiry must be in the future (at most two years).', AUTOMATION_NAME_INVALID: 'Use 1–80 characters for the name.',
  AUTOMATION_WORKFLOW_NOT_REPRESENTABLE: 'Choose a saved workflow with exactly one supported EVM swap to automate.',
  AUTOMATION_WORKFLOW_CHANGED: 'The saved workflow changed. Rebind the automation before reviewing.', AUTOMATION_PAUSED: 'Resume the automation first.',
  AUTOMATION_OCCURRENCE_EXPIRED: 'This proposal has expired.', AUTOMATION_OCCURRENCE_DISMISSED: 'This proposal was dismissed.', STRATEGY_STALE: 'This proposal is no longer reproducible.',
  AUTOMATION_OCCURRENCE_COMPLETED: 'You already added this proposal to your workflow.', AUTOMATION_OCCURRENCE_CHANGED: 'This proposal changed. Refresh and try again.',
  AUTOMATION_ACTION_ASSET_MISMATCH: 'The action must trade the asset the condition watches.', HANDOFF_RATE_LIMITED: 'Too many reviews opened recently. Try again later.',
  HANDOFF_PENDING_LIMIT: 'Too many open reviews for this automation. Finish or dismiss one first.', AUTOMATION_LINK_RATE_LIMITED: 'Too many codes requested. Try again later.',
  AUTOMATION_CHAT_NOTIFICATIONS_UNAVAILABLE: 'Telegram notifications are not available on this deployment.',
  AUTOMATION_WALLET_NAMESPACE_MISMATCH: 'This network needs a wallet of another kind than the one you proved. Only your own wallet can approve its proposals.',
  // Schedule change by replacement (`service.ts` replace).
  AUTOMATION_SCHEDULE_UNCHANGED: 'This automation already runs on that schedule.',
  AUTOMATION_REPLACE_UNSUPPORTED: 'FloFi cannot change the schedule of this automation. Create a new one instead.' };

// ── Shared text pieces (the workspace renders the same keys) ─────────────────────────────────────────────────────────────────────────
const say = (language: Language, en: string, pt: string) => language === 'PT' ? pt : en;
const labelOf = (language: Language, table: Readonly<Record<string, string>>, code: string) => table[code] ? translate(language, table[code]!) : code;
export const usd = (value: string) => { const [whole, fraction = ''] = value.split('.'); return `$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction.slice(0, 2).padEnd(2, '0')}` : ''}`; };
/** An instant on the rule's own clock (the workspace's `When` format), with the zone named; the raw value if it cannot be formatted. */
export function formatWhen(iso: string, timezone: string, language: Language): string {
  try {
    return `${new Intl.DateTimeFormat(language === 'PT' ? 'pt-BR' : 'en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      .format(new Date(iso))} (${timezone})`;
  } catch { return iso; }
}
export const scheduleText = (rule: Pick<RuleView, 'schedule' | 'timezone'>, language: Language): string => !rule.schedule ? ''
  : rule.schedule.frequency === 'DAILY' ? translate(language, 'Every day at {0} ({1})', rule.schedule.time, rule.timezone)
    : translate(language, 'Every {0} at {1} ({2})', translate(language, WEEKDAYS[(rule.schedule.weekday ?? 1) - 1]!), rule.schedule.time, rule.timezone);
export const conditionText = (c: NonNullable<RuleView['condition']>, language: Language): string => c.type === 'PRICE_BELOW' ? translate(language, 'If {0} falls below {1}', c.asset, usd(c.threshold!))
  : c.type === 'PRICE_ABOVE' ? translate(language, 'If {0} rises above {1}', c.asset, usd(c.threshold!))
    : c.type === 'PERCENT_DROP' ? translate(language, 'If {0} falls {1}% from {2} (at or below {3})', c.asset, c.percent!, usd(c.reference!), usd(c.effectiveThreshold))
      : translate(language, 'If {0} rises {1}% from {2} (at or above {3})', c.asset, c.percent!, usd(c.reference!), usd(c.effectiveThreshold));
export const actionText = (a: RuleView['action'], language: Language): string => a
  ? translate(language, 'Prepare {0} {1} → {2} on {3}', a.amount, a.inputAsset, a.outputAsset, translate(language, a.networkLabel)) : translate(language, 'Notify me only');

/** One FloFi-authored line: kind and name, then what it prepares, when, its state and its execution mode. */
export function ruleSummary(rule: RuleView, language: Language): string {
  const what = rule.kind === 'DAILY_WATCH' ? `${(rule.watch?.assets ?? []).join(' / ')} · ${translate(language, 'Notify me')}`
    : rule.executionMode === 'DELEGATED_WITH_LIMITS' && !rule.action ? translate(language, 'Multi-step workflow (see Automatic within limits)') : actionText(rule.action, language);
  const when = rule.schedule ? scheduleText(rule, language)
    : rule.condition ? `${conditionText(rule.condition, language)} · ${translate(language, 'checked every {0} min', String(rule.condition.checkEveryMinutes))}` : '';
  // Delegated execution is retired (EXECUTOR_FUNDED_GAS_RETIRED): an existing delegated rule is never presented as an available mode.
  const mode = translate(language, rule.executionMode === 'DELEGATED_WITH_LIMITS' ? 'Automatic within limits (retired on this deployment)' : 'Ask me before every execution');
  return `${translate(language, KIND_LABEL[rule.kind])} “${rule.name}”: ${[what, when, labelOf(language, STATE_LABEL, rule.state), mode].filter(Boolean).join(' · ')}`;
}

// ── Why it ran, did not run, or runs next ────────────────────────────────────────────────────────────────────────────────────────────
export type AutomationExplanation = { readonly lines: readonly string[]; readonly text: string };
/** Price observations FloFi could not use (`evaluator.ts` priced(): the source's closed code, or PRICE_STALE / PRICE_SOURCE_OFF). */
const PRICE_FAILURE = /^PRICE_(?:STALE|SOURCE_[A-Z_]+|FEED_MISMATCH|ASSET_UNSUPPORTED)$/;
/** Owner and lifecycle events in a rule's history: not evaluations. */
const MANAGEMENT = new Set(['AUTOMATION_CREATED', 'AUTOMATION_PAUSED', 'AUTOMATION_RESUMED', 'AUTOMATION_ARCHIVED', 'AUTOMATION_EXPIRED', 'AUTOMATION_REBOUND',
  'AUTOMATION_REPLACED', 'AUTOMATION_REPLACEMENT', 'APPROVAL_REQUESTED', 'APPROVAL_APPLIED', 'OWNER_DISMISSED', 'OWNER_PREPARED_BUY', 'OWNER_PREPARED_SELL']);
/** Evaluations that produced something for the owner. */
const PRODUCED = new Set(['TRIGGERED', 'WATCH_REPORTED']);
/** Evaluations that explain a missing proposal. */
const blocking = (outcome: string) => outcome === 'MISSED' || outcome === 'LIMIT_BLOCKED' || outcome === 'WORKFLOW_CHANGED' || outcome === 'STRATEGY_STALE'
  || outcome === 'COOLDOWN' || PRICE_FAILURE.test(outcome);
/** `limits.ts` occurrenceViolation codes, as a reason. */
const LIMIT_REASON: Readonly<Record<string, readonly [string, string]>> = {
  LIMIT_AMOUNT_PER_EXECUTION: ['the amount is above your maximum per execution', 'o valor está acima do seu máximo por execução'],
  LIMIT_SLIPPAGE: ['the max price difference is above your limit', 'a diferença máxima de preço está acima do seu limite'],
  LIMIT_COOLDOWN: ['it came within the cooldown after the previous proposal', 'veio dentro do intervalo de espera depois da proposta anterior'],
  LIMIT_PERIOD_COUNT: ['it would exceed your maximum number of proposals for the period', 'excederia o seu número máximo de propostas no período'],
  LIMIT_PERIOD_AMOUNT: ['it would exceed your maximum amount for the period', 'excederia o seu valor máximo no período'],
  LIMIT_PERIOD_ASSET_MISMATCH: ['the period’s recorded amounts are in another asset, so FloFi could not add them up', 'os valores registrados no período estão em outro ativo, então o FloFi não pôde somá-los'],
};
const observedPrice = (o: ObservationView | null | undefined) => o && 'priceUsd' in o ? `${o.asset} ${usd(o.priceUsd)}` : null;

/** One recorded outcome as a sentence (without its time). Unknown codes are named as recorded, never interpreted. */
function outcomeSentence(language: Language, outcome: string, detail: Readonly<Record<string, unknown>> | null, observation: ObservationView | null): string {
  const pt = language === 'PT', price = observedPrice(observation);
  switch (outcome) {
    case 'TRIGGERED': return say(language, 'it ran: FloFi created a proposal for you.', 'rodou: o FloFi criou uma proposta para você.');
    case 'WATCH_REPORTED': return say(language, 'it ran: FloFi reported the market round.', 'rodou: o FloFi enviou a ronda de mercado.');
    case 'MISSED': {
      const n = typeof detail?.count === 'number' ? detail.count : null;
      return n === null ? say(language, 'scheduled times passed while FloFi was unavailable and were not proposed (only the latest one, within 6 hours, can still be).',
        'horários agendados passaram enquanto o FloFi estava indisponível e não foram propostos (só o mais recente, dentro de 6 horas, ainda pode ser).')
        : say(language, `${n} scheduled time(s) passed while FloFi was unavailable and were not proposed (only the latest one, within 6 hours, can still be).`,
          `${n} horário(s) agendado(s) passaram enquanto o FloFi estava indisponível e não foram propostos (só o mais recente, dentro de 6 horas, ainda pode ser).`);
    }
    case 'LIMIT_BLOCKED': {
      const code = typeof detail?.code === 'string' ? detail.code : null, reason = code ? LIMIT_REASON[code] : undefined;
      if (!code) return say(language, 'a limit blocked the proposal (FloFi did not record which one).', 'um limite bloqueou a proposta (o FloFi não registrou qual).');
      return reason ? say(language, `a limit blocked the proposal: ${reason[0]}.`, `um limite bloqueou a proposta: ${reason[1]}.`)
        : say(language, `a limit blocked the proposal (${code}).`, `um limite bloqueou a proposta (${code}).`);
    }
    case 'WORKFLOW_CHANGED': return say(language, 'its saved workflow changed, so FloFi proposed nothing; rebind the automation to continue.',
      'o fluxo salvo mudou, então o FloFi não propôs nada; volte a associar a automação para continuar.');
    case 'STRATEGY_STALE': return say(language, 'its action no longer reproduces with FloFi’s current engine, so FloFi proposed nothing; rebind the automation to continue.',
      'a ação já não se reproduz com o motor atual do FloFi, então o FloFi não propôs nada; volte a associar a automação para continuar.');
    case 'ARMED': case 'CONDITION_NOT_MET': return price ? say(language, `the price condition was not met (observed ${price}).`, `a condição de preço não foi atingida (observado ${price}).`)
      : say(language, 'the price condition was not met.', 'a condição de preço não foi atingida.');
    case 'CONDITION_ALREADY_MET': return say(language, 'the condition was already met when the automation started or resumed; FloFi waits for the price to leave it and cross again.',
      'a condição já estava atingida quando a automação começou ou foi retomada; o FloFi espera o preço sair dela e cruzá-la de novo.');
    case 'CONDITION_STILL_MET': return say(language, 'the condition was still met after the last crossing; FloFi proposes again only after it clears and is crossed again.',
      'a condição continuava atingida depois do último cruzamento; o FloFi só propõe de novo depois que ela se desfizer e for cruzada outra vez.');
    case 'REARMED': return say(language, 'the condition cleared; FloFi is watching for the next crossing.', 'a condição se desfez; o FloFi está observando o próximo cruzamento.');
    case 'COOLDOWN': return say(language, 'the price crossed during the cooldown, so no proposal was made.', 'o preço cruzou durante o intervalo de espera, então nenhuma proposta foi feita.');
    case 'DUPLICATE_TRIGGER': return say(language, 'that trigger had already been handled; the duplicate was ignored.', 'esse gatilho já tinha sido tratado; o duplicado foi ignorado.');
    case 'NOT_DUE': return say(language, 'nothing was due yet at that evaluation.', 'nada estava previsto ainda naquela avaliação.');
    case 'AUTOMATION_CREATED': return say(language, 'the automation was created.', 'a automação foi criada.');
    case 'AUTOMATION_PAUSED': return say(language, 'you paused it.', 'você a pausou.');
    case 'AUTOMATION_RESUMED': return say(language, 'you resumed it.', 'você a retomou.');
    case 'AUTOMATION_ARCHIVED': return say(language, 'it was archived.', 'ela foi arquivada.');
    case 'AUTOMATION_EXPIRED': return say(language, 'it reached its expiry.', 'ela chegou ao vencimento.');
    case 'AUTOMATION_REBOUND': return say(language, 'you rebound it to the current workflow.', 'você a associou de novo ao fluxo atual.');
    case 'AUTOMATION_REPLACED': return say(language, 'it was replaced by a new automation with a changed schedule.', 'ela foi substituída por uma nova automação com o agendamento alterado.');
    case 'AUTOMATION_REPLACEMENT': return say(language, 'it was created to replace an earlier automation (schedule changed).', 'ela foi criada para substituir uma automação anterior (agendamento alterado).');
    case 'APPROVAL_REQUESTED': return say(language, 'you opened a proposal for review.', 'você abriu uma proposta para revisão.');
    case 'APPROVAL_APPLIED': return say(language, 'a proposal was loaded into your workflow.', 'uma proposta foi carregada no seu fluxo.');
    case 'OWNER_DISMISSED': return say(language, 'you dismissed a proposal.', 'você recusou uma proposta.');
    case 'OWNER_PREPARED_BUY': case 'OWNER_PREPARED_SELL': return say(language, 'you started your own trade in the Editor.', 'você iniciou uma operação sua no Editor.');
  }
  if (PRICE_FAILURE.test(outcome)) return say(language, `FloFi had no usable fresh price (${labelOf(language, OUTCOME_LABEL, outcome)}), so nothing changed.`,
    `o FloFi não tinha um preço recente utilizável (${labelOf(language, OUTCOME_LABEL, outcome)}), então nada mudou.`);
  return pt ? `resultado registrado: ${labelOf(language, OUTCOME_LABEL, outcome)}.` : `recorded outcome: ${labelOf(language, OUTCOME_LABEL, outcome)}.`;
}
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const at = (language: Language, iso: string | null, timezone: string) => iso ? `${formatWhen(iso, timezone, language)} — ` : '';

function stateLines(rule: RuleView, history: readonly HistoryEntryView[] | null, language: Language): string[] {
  const delegated = rule.executionMode === 'DELEGATED_WITH_LIMITS';
  const retired = say(language, 'Its automatic execution is retired on this deployment (EXECUTOR_FUNDED_GAS_RETIRED), so it cannot be resumed.',
    'A execução automática dela foi desativada neste ambiente (EXECUTOR_FUNDED_GAS_RETIRED), então ela não pode ser retomada.');
  switch (rule.state) {
    case 'ARCHIVED': {
      const replaced = history?.find(e => e.outcome === 'AUTOMATION_REPLACED');
      return [say(language, 'This automation is archived: it will not run again.', 'Esta automação está arquivada: não vai rodar de novo.'),
        ...replaced ? [say(language, 'It was replaced by a new automation with a changed schedule.', 'Ela foi substituída por uma nova automação com o agendamento alterado.')] : []];
    }
    case 'EXPIRED': return [rule.expiresAt
      ? say(language, `This automation expired on ${formatWhen(rule.expiresAt, rule.timezone, language)}: it will not run again.`,
        `Esta automação venceu em ${formatWhen(rule.expiresAt, rule.timezone, language)}: não vai rodar de novo.`)
      : say(language, 'This automation expired: it will not run again.', 'Esta automação venceu: não vai rodar de novo.')];
    case 'PAUSED': return [say(language, 'This automation is paused: FloFi creates no proposals until you resume it, and resuming computes the next evaluation from that moment.',
      'Esta automação está em pausa: o FloFi não cria propostas até você retomá-la, e ao retomar a próxima avaliação é calculada a partir desse momento.'), ...delegated ? [retired] : []];
    case 'ACTIVE': {
      const lines: string[] = [];
      if (rule.attention === 'WORKFLOW_CHANGED') lines.push(say(language, 'Its saved workflow changed after it was created: FloFi proposes nothing until you rebind it.',
        'O fluxo salvo mudou depois de ela ser criada: o FloFi não propõe nada até você voltar a associá-la.'));
      if (rule.attention === 'STRATEGY_STALE') lines.push(say(language, 'Its action no longer reproduces with FloFi’s current engine: FloFi proposes nothing until you rebind it.',
        'A ação já não se reproduz com o motor atual do FloFi: o FloFi não propõe nada até você voltar a associá-la.'));
      if (delegated) lines.push(say(language, 'It uses automatic execution, which is retired on this deployment (EXECUTOR_FUNDED_GAS_RETIRED).',
        'Ela usa execução automática, que foi desativada neste ambiente (EXECUTOR_FUNDED_GAS_RETIRED).'));
      lines.push(rule.nextEvaluationAt
        ? say(language, `It is active. Next evaluation: ${formatWhen(rule.nextEvaluationAt, rule.timezone, language)}.`,
          `Ela está ativa. Próxima avaliação: ${formatWhen(rule.nextEvaluationAt, rule.timezone, language)}.`)
        : say(language, 'It is active, but FloFi has no next evaluation recorded for it.', 'Ela está ativa, mas o FloFi não tem uma próxima avaliação registrada para ela.'));
      return lines;
    }
  }
}

function evaluationLines(rule: RuleView, history: readonly HistoryEntryView[] | null, language: Language): string[] {
  if (history === null) {
    // Without the history only the rule's own last outcome is a fact.
    if (!rule.lastOutcome) return [];
    return [`${say(language, 'Last evaluation', 'Última avaliação')}: ${at(language, rule.lastEvaluationAt, rule.timezone)}${outcomeSentence(language, rule.lastOutcome, null, rule.lastObservation)}`];
  }
  const entries = [...history].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).filter(e => !MANAGEMENT.has(e.outcome));
  if (!entries.length) return rule.lastOutcome && rule.lastEvaluationAt
    ? [`${say(language, 'Last evaluation', 'Última avaliação')}: ${at(language, rule.lastEvaluationAt, rule.timezone)}${outcomeSentence(language, rule.lastOutcome, null, rule.lastObservation)}`]
    : [say(language, 'FloFi has not recorded any evaluation of this automation yet.', 'O FloFi ainda não registrou nenhuma avaliação desta automação.')];
  const latest = entries[0]!;
  // A price check is recorded in the history only when its outcome changes (`evaluator.ts` priced): a later check with the same outcome lives on
  // the rule itself (`lastEvaluationAt`, `lastObservation`), so the latest check and its price come from there, never the older recorded price.
  const unchanged = rule.kind === 'PRICE_TRIGGER' && rule.lastEvaluationAt !== null && rule.lastOutcome === latest.outcome
    && Date.parse(rule.lastEvaluationAt) > Date.parse(latest.at);
  const lines = unchanged ? [`${say(language, 'Latest evaluation', 'Última avaliação')}: ${at(language, rule.lastEvaluationAt, rule.timezone)}${
    outcomeSentence(language, latest.outcome, latest.detail, rule.lastObservation)}`,
  say(language, `Recorded since ${formatWhen(latest.at, rule.timezone, language)} and still the case at the latest evaluation (FloFi records a price check in the history only when its outcome changes).`,
    `Registrado desde ${formatWhen(latest.at, rule.timezone, language)} e ainda era assim na última avaliação (o FloFi só registra uma verificação de preço no histórico quando o resultado muda).`)]
    : [`${say(language, 'Latest recorded evaluation', 'Última avaliação registrada')}: ${at(language, latest.at, rule.timezone)}${
      outcomeSentence(language, latest.outcome, latest.detail, latest.observation)}`];
  // The latest fact that blocked a proposal since the last one produced, when it is not the latest entry itself.
  const lastProduced = entries.findIndex(e => PRODUCED.has(e.outcome));
  const blocker = entries.slice(1, lastProduced === -1 ? undefined : lastProduced).find(e => blocking(e.outcome));
  if (blocker && !blocking(latest.outcome)) lines.push(`${say(language, 'Earlier', 'Antes')}: ${at(language, blocker.at, rule.timezone)}${outcomeSentence(language, blocker.outcome, blocker.detail, blocker.observation)}`);
  if (lastProduced > 0) lines.push(`${say(language, 'Last time it ran', 'Última vez que rodou')}: ${at(language, entries[lastProduced]!.at, rule.timezone)}${
    outcomeSentence(language, entries[lastProduced]!.outcome, entries[lastProduced]!.detail, entries[lastProduced]!.observation)}`);
  return lines;
}

function occurrenceLines(o: OccurrenceView, timezone: string, language: Language): string[] {
  const due = formatWhen(o.dueAt, timezone, language), lines: string[] = [];
  switch (o.state) {
    case 'PENDING_OWNER': lines.push(say(language, `The proposal from ${due} is waiting for you until ${formatWhen(o.expiresAt, timezone, language)}.`,
      `A proposta de ${due} está esperando por você até ${formatWhen(o.expiresAt, timezone, language)}.`)); break;
    case 'APPROVAL_CREATED': lines.push(say(language, `The proposal from ${due} is open for your review until ${formatWhen(o.expiresAt, timezone, language)}.`,
      `A proposta de ${due} está aberta para a sua revisão até ${formatWhen(o.expiresAt, timezone, language)}.`)); break;
    case 'COMPLETED': lines.push(say(language, `The proposal from ${due} was loaded into your workflow.`, `A proposta de ${due} foi carregada no seu fluxo.`)); break;
    case 'DISMISSED': lines.push(say(language, `You dismissed the proposal from ${due}.`, `Você recusou a proposta de ${due}.`)); break;
    case 'DELEGATED': lines.push(say(language, `The occurrence from ${due} was handed to the automatic executor, which is retired on this deployment (EXECUTOR_FUNDED_GAS_RETIRED).`,
      `A ocorrência de ${due} foi entregue ao executor automático, que foi desativado neste ambiente (EXECUTOR_FUNDED_GAS_RETIRED).`)); break;
    case 'EXPIRED': {
      const withdrawn = o.outcome === 'AUTOMATION_ARCHIVED' || o.outcome === 'AUTOMATION_REPLACED' || o.outcome === 'AUTOMATION_REBOUND' || o.outcome === 'AUTOMATION_REBOUND_WITHDRAWN';
      // An APPLIED handoff on a lapsed or withdrawn occurrence was used: the owner loaded it before the automation changed or the proposal
      // expired, so it is never described as withdrawn (the run lines below say what happened). Without an approval read, whether it was ever
      // opened is not known here, so the limit fact is stated conditionally.
      lines.push(o.approval?.status === 'APPLIED' ? withdrawn
        ? say(language, `The proposal from ${due} was loaded into your workflow before the automation changed.`,
          `A proposta de ${due} foi carregada no seu fluxo antes de a automação mudar.`)
        : say(language, `The proposal from ${due} was loaded into your workflow before it expired.`, `A proposta de ${due} foi carregada no seu fluxo antes de expirar.`)
        : withdrawn ? say(language, `The proposal from ${due} was withdrawn when the automation changed (${labelOf(language, OUTCOME_LABEL, o.outcome!)}).`,
          `A proposta de ${due} foi retirada quando a automação mudou (${labelOf(language, OUTCOME_LABEL, o.outcome!)}).`)
          : o.approval ? say(language, `The proposal from ${due} expired after you opened it for review, without being loaded into your workflow.`,
            `A proposta de ${due} expirou depois de você abri-la para revisão, sem ser carregada no seu fluxo.`)
            : say(language, `The proposal from ${due} expired. If you never opened it, nothing was sent and it does not count against your limits.`,
              `A proposta de ${due} expirou. Se você nunca a abriu, nada foi enviado e ela não conta para os seus limites.`));
      break;
    }
  }
  const approval = o.approval;
  if (approval) {
    for (const run of approval.runs.slice(0, 3)) if (run.errorCode) lines.push(say(language, `A recorded run of it ended with ${run.errorCode} (${run.status}).`,
      `Uma execução registrada dela terminou com ${run.errorCode} (${run.status}).`));
    if (approval.status === 'APPLIED' && !approval.runsComplete) lines.push(say(language, 'Its run status could not be read now — that is not evidence that nothing was sent.',
      'O estado das execuções dela não pôde ser lido agora — isso não é evidência de que nada foi enviado.'));
    else if (approval.status === 'APPLIED' && !approval.runs.length) lines.push(approval.runsTruncated
      ? say(language, 'No run of it is among this wallet’s recent runs; older runs were not checked.', 'Nenhuma execução dela está entre as execuções recentes desta carteira; as mais antigas não foram verificadas.')
      : say(language, 'No run of it is recorded yet.', 'Nenhuma execução dela foi registrada ainda.'));
  }
  for (const n of o.notifications) {
    if (n.status === 'FAILED') lines.push(say(language, `Its ${n.channel} notification failed${n.code ? ` (${n.code})` : ''}; the proposal itself was not affected.`,
      `A notificação por ${n.channel} falhou${n.code ? ` (${n.code})` : ''}; a proposta em si não foi afetada.`));
    if (n.status === 'SKIPPED') lines.push(say(language, `Its ${n.channel} notification was skipped${n.code ? ` (${n.code})` : ''}.`,
      `A notificação por ${n.channel} foi ignorada${n.code ? ` (${n.code})` : ''}.`));
  }
  return lines;
}

/**
 * Why `rule` ran, did not run, or when it is evaluated next, from recorded facts only: its state, next evaluation, attention, last outcome,
 * its history (MISSED count, LIMIT_BLOCKED code, price-source failures, trigger steps) and its latest proposal (pending, expired, dismissed,
 * withdrawn, recorded runs and their error codes, notification failures). Pass the rule's own records (`history(ruleId)`: `entries` and
 * `occurrences`); an empty list is read as "none recorded". `history` / `occurrences` null means they were not read: the explanation says so
 * instead of guessing.
 */
export function explainRuleStatus(rule: RuleView, history: readonly HistoryEntryView[] | null, occurrences: readonly OccurrenceView[] | null, language: Language): AutomationExplanation {
  const lines = [...stateLines(rule, history, language), ...evaluationLines(rule, history, language)].map(capitalized);
  if (occurrences === null) lines.push(say(language, 'FloFi did not read this automation’s proposals here, so it cannot say whether one was created, opened or expired.',
    'O FloFi não leu aqui as propostas desta automação, então não pode dizer se alguma foi criada, aberta ou expirou.'));
  else {
    const latest = [...occurrences].filter(o => o.ruleId === rule.ruleId).sort((a, b) => Date.parse(b.dueAt) - Date.parse(a.dueAt))[0];
    lines.push(...latest ? occurrenceLines(latest, rule.timezone, language)
      : [say(language, 'No proposal of this automation is recorded.', 'Nenhuma proposta desta automação está registrada.')]);
  }
  if (history === null) lines.push(say(language, 'FloFi did not read this automation’s evaluation history here, so it cannot say what happened at each evaluation.',
    'O FloFi não leu aqui o histórico de avaliações desta automação, então não pode dizer o que aconteceu em cada avaliação.'));
  return { lines, text: lines.join('\n') };
}

// ── Answers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const AUTOMATION_FAQ_TOPICS = ['INSUFFICIENT_BALANCE', 'PRICE_DROP', 'AUTHORIZATION', 'DELEGATION_STATUS', 'SCHEDULE_CHANGE', 'PAUSE', 'WHY_NOT_RUN'] as const;
export type AutomationFaqTopic = (typeof AUTOMATION_FAQ_TOPICS)[number];
/** Each answer states current behaviour, at most 600 characters (`explain.test.ts`). */
export const AUTOMATION_FAQ: Readonly<Record<AutomationFaqTopic, { readonly EN: string; readonly PT: string }>> = Object.freeze({
  // No balance is read when a rule is created (`service.ts` create), evaluated (`evaluator.ts` scheduled/priced: trigger, attention and limits
  // only) or opened (`service.ts` open: a no-authority approval link). The owner's fresh simulation/estimate on /approve is what refuses it
  // (INSUFFICIENT_INPUT / INSUFFICIENT_GAS_FUNDS, copy in `domain/build-estimate.ts`). An open proposal lapses per OCCURRENCE_TTL (`evaluator.ts`:
  // a DCA at its next slot, at most 24 h; a price trigger after 6 h), and an expired proposal that was never opened is not counted against the
  // limits (`limits.ts` header; `pg-store.ts` COUNTED requires a handoff for EXPIRED).
  INSUFFICIENT_BALANCE: {
    EN: 'FloFi does not check your balance when you create an automation, when it evaluates it or when you open a proposal, so the proposal is still created when it is due. Nothing is sent: when you review it, FloFi runs a fresh simulation with your wallet, and an insufficient balance blocks it there. If you do nothing, the proposal expires (a recurring buy within 24 hours, a price trigger after 6 hours). An expired proposal you never opened does not count against your limits.',
    PT: 'O FloFi não verifica o seu saldo quando você cria uma automação, quando ele a avalia ou quando você abre uma proposta, então a proposta é criada mesmo assim no horário. Nada é enviado: quando você a revisa, o FloFi faz uma nova simulação com a sua carteira, e o saldo insuficiente a bloqueia ali. Se você não fizer nada, a proposta expira (uma compra recorrente em até 24 horas, um gatilho de preço após 6 horas). Uma proposta expirada que você nunca abriu não conta para os seus limites.' },
  // A SCHEDULED_DCA evaluates on its slot only (`evaluator.ts` scheduled: no price read); the swap carries its slippage bound (`definition.ts`
  // RouteAction.slippageBps, checked against limits.maxSlippageBps). Price conditions are PRICE_TRIGGER rules. Pausing stops new occurrences.
  PRICE_DROP: {
    EN: 'A recurring buy proposes the purchase at its scheduled time whatever the price: it does not wait for a lower price, and the swap is bounded by the max price difference (slippage) you set. Buying only when the price falls is a separate price-trigger automation, for example “if ETH falls below $3,000”. To stop future recurring buys, pause the automation: a paused automation creates no new proposals. Every proposal still needs your review and your wallet signature.',
    PT: 'Uma compra recorrente propõe a compra no horário agendado, seja qual for o preço: ela não espera um preço mais baixo, e a troca respeita a diferença máxima de preço (slippage) que você definiu. Comprar só quando o preço cai é outra automação, um gatilho de preço, por exemplo “se o ETH cair abaixo de $3.000”. Para parar as próximas compras recorrentes, pause a automação: uma automação pausada não cria novas propostas. Cada proposta continua precisando da sua revisão e da assinatura da sua carteira.' },
  // CONFIRM_EACH_TIME is the only mode an owner's input can express (`definition.ts` EXECUTION_MODE); create/resume store a rule and evaluate it,
  // never an authorization; `open` mints a no-authority link and /approve requires wallet proof, a fresh simulation, the Review and the signature.
  AUTHORIZATION: {
    EN: 'Your automations ask you before every execution. Saving or activating one authorizes no spending: when it is due, FloFi only prepares a proposal. To go ahead you open it, FloFi runs a fresh simulation, you review the Strategy Manifest and you confirm with your own wallet. Nothing is signed or sent without that confirmation, every time.',
    PT: 'As suas automações perguntam antes de cada execução. Salvar ou ativar uma automação não autoriza nenhum gasto: no horário, o FloFi só prepara uma proposta. Para seguir em frente, você a abre, o FloFi faz uma nova simulação, você revisa o Strategy Manifest e confirma com a sua própria carteira. Nada é assinado nem enviado sem essa confirmação, todas as vezes.' },
  // `delegation/operations.ts` EXECUTOR_FUNDED_OPERATIONS refuse new delegated authority (EXECUTOR_FUNDED_GAS_RETIRED); reads and revocation stay;
  // `service.ts` setState refuses RESUME of a delegated rule with the same code, while pause and archive stay available.
  DELEGATION_STATUS: {
    EN: 'Automatic execution within limits (delegated execution) is retired on this deployment (EXECUTOR_FUNDED_GAS_RETIRED): FloFi creates no new delegated automation or authorization, and a delegated automation cannot be resumed. Authority you granted earlier can still be viewed and revoked, and its automations can still be paused or archived. Automations that ask you before every execution are unaffected.',
    PT: 'A execução automática dentro de limites (execução delegada) foi desativada neste ambiente (EXECUTOR_FUNDED_GAS_RETIRED): o FloFi não cria novas automações nem autorizações delegadas, e uma automação delegada não pode ser retomada. A autoridade que você concedeu antes ainda pode ser vista e revogada, e as automações dela ainda podem ser pausadas ou arquivadas. As automações que perguntam antes de cada execução não são afetadas.' },
  // The database refuses any change to a rule's definition (AUTOMATION_RULE_IMMUTABLE, migrations 0010/0011); `service.ts` replace creates the new
  // rule and archives the old one in one transaction after the owner's explicit confirmation, withdrawing the old rule's open proposals.
  SCHEDULE_CHANGE: {
    EN: 'An automation’s schedule cannot be edited in place: FloFi keeps each automation’s definition unchanged. Changing the day or time replaces it: after you confirm, FloFi creates a new automation with the new schedule and the same action, limits and expiry, and archives the old one in the same step. Proposals still waiting from the old one are withdrawn, a paused automation stays paused, and the new one still asks you before every execution.',
    PT: 'O agendamento de uma automação não pode ser editado no lugar: o FloFi mantém a definição de cada automação inalterada. Mudar o dia ou a hora a substitui: depois de você confirmar, o FloFi cria uma nova automação com o novo agendamento e a mesma ação, limites e vencimento, e arquiva a antiga no mesmo passo. As propostas que ainda esperavam pela antiga são retiradas, uma automação pausada continua pausada, e a nova continua perguntando antes de cada execução.' },
  // `evaluator.ts` evaluates ACTIVE rules only; `service.ts` open refuses a paused rule's proposals (AUTOMATION_PAUSED); setState RESUME computes
  // nextEvaluationAt from now (no catch-up) and `pg-store.ts` re-arms a price condition.
  PAUSE: {
    EN: 'A paused automation creates no proposals: FloFi does not evaluate it, and times or price crossings during the pause are never proposed later. Proposals already waiting cannot be opened until you resume, and they still expire on time. Resuming computes the next evaluation from that moment; a price trigger then waits for a new crossing. Archiving ends an automation for good.',
    PT: 'Uma automação pausada não cria propostas: o FloFi não a avalia, e horários ou cruzamentos de preço durante a pausa nunca são propostos depois. As propostas que já esperavam não podem ser abertas até você retomar, e continuam expirando no prazo. Ao retomar, a próxima avaliação é calculada a partir desse momento; um gatilho de preço passa a esperar um novo cruzamento. Arquivar encerra uma automação de vez.' },
  WHY_NOT_RUN: {
    EN: 'Common reasons an automation made no proposal: it is paused, expired or archived; its time had not come; FloFi was unavailable and the time was missed (only the latest one, within 6 hours, can still propose); a limit blocked it (amount, count or cooldown); the price condition was not met or no fresh price was available; or its saved workflow changed and needs a rebind. A proposal that was made may also have expired before you opened it. Ask about one automation to see its recorded history.',
    PT: 'Motivos comuns para uma automação não fazer proposta: ela está pausada, vencida ou arquivada; o horário ainda não tinha chegado; o FloFi estava indisponível e o horário foi perdido (só o mais recente, dentro de 6 horas, ainda pode propor); um limite a bloqueou (valor, quantidade ou intervalo); a condição de preço não foi atingida ou não havia preço recente; ou o fluxo salvo mudou e precisa ser associado de novo. Uma proposta feita também pode ter expirado antes de você abri-la. Pergunte sobre uma automação para ver o histórico registrado.' },
});
export const automationFaq = (topic: AutomationFaqTopic, language: Language): string => AUTOMATION_FAQ[topic][language === 'PT' ? 'PT' : 'EN'];

/** Lower case, accents folded (`não` → `nao`, `às` → `as`), whitespace collapsed. */
export const foldText = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'").toLowerCase().replace(/\s+/g, ' ').trim();
/** Weekday words, singular or plural ("on Fridays", "às sextas"): a plural is still that one weekday, never dropped. */
const WEEKDAY_WORDS: readonly (readonly [string, number])[] = [
  ['mondays?|mon|segundas?(?:[- ]feiras?)?', 1], ['tuesdays?|tues?|tercas?(?:[- ]feiras?)?', 2], ['wednesdays?|wed|quartas?(?:[- ]feiras?)?', 3],
  ['thursdays?|thu(?:rs?)?|quintas?(?:[- ]feiras?)?', 4], ['fridays?|fri|sextas?(?:[- ]feiras?)?', 5], ['saturdays?|sat|sabados?', 6], ['sundays?|sun|domingos?', 7]];
const ANY_WEEKDAY = new RegExp(`\\b(?:${WEEKDAY_WORDS.map(([w]) => w).join('|')})\\b`);
const CHANGE_VERB = /\b(?:muda|mude|mudar|mudo|altera|altere|alterar|troca|troque|trocar|passa|passe|passar|move|mova|mover|change|switch|reschedule|update|edit|editar|edita|reagenda|reagendar)\b/;
/** Ordered by precedence: the first topic whose test passes. */
const FAQ_MATCHERS: readonly (readonly [AutomationFaqTopic, (t: string) => boolean])[] = [
  ['WHY_NOT_RUN', t => /\b(?:por ?que|pq)\b.*\bnao\b.*\b(?:rodou|roda|executou|funcionou|disparou|comprou|correu|aconteceu|ativou|criou)\b/.test(t)
    || /\bnao (?:rodou|executou|disparou|funcionou|comprou)\b/.test(t)
    || /\bwhy\b.*\b(?:didn'?t|did not|hasn'?t|has not|wasn'?t|was not|isn'?t|is not|no)\b.*\b(?:run|ran|execute|executed|trigger|triggered|fire|fired|buy|bought|work|worked|propos)/.test(t)
    || /\b(?:didn'?t|did not|never) (?:run|execute|trigger|fire)\b/.test(t)],
  ['DELEGATION_STATUS', t => /\bdelega|\bautomatic (?:execution|mode)|\bwithin limits\b|\bexecucao automatica|\bautomatic[oa] dentro|\bdentro (?:de|dos) limites\b|\bexecutor\b/.test(t)],
  ['INSUFFICIENT_BALANCE', t => /\b(?:saldo|balance|fundos?|funds?|dinheiro|money|usdc)\b/.test(t)
    && (/\b(?:sem|nao|insuficiente|insufficient|not enough|don'?t have|do not have|lack|falta|faltar|acabar|acabou|zero|empty|without|low)\b/.test(t)
      || /\bno (?:balance|funds?|money|usdc)\b/.test(t))],
  ['SCHEDULE_CHANGE', t => CHANGE_VERB.test(t) && (/\b(?:dia|hora|horario|agenda|agendamento|schedule|time|day|semana|week|diari|daily|weekly|semanal)/.test(t)
    || ANY_WEEKDAY.test(t) || /\b\d{1,2}\s*(?:[:h]|am\b|pm\b)/.test(t)) || /\b(?:editar|edit) (?:a |the |uma |an )?automa/.test(t)],
  ['PRICE_DROP', t => /\b(?:preco|price|cotacao|valor|mercado|market)\b/.test(t) && /\b(?:cai|cair|caiu|caindo|queda|desce|descer|baixa|baixar|drop|drops|dropped|fall|falls|fell|dip|dips|down|crash)/.test(t)],
  ['AUTHORIZATION', t => /\b(?:autoriz|authori[sz]|confirm|assin(?:a|ar|o|e|ou|atura)\b|sign(?:s|ed|ing|ature)?\b|aprova|approv|permiss)/.test(t)
    || /\b(?:sozinh|by itself|on its own|without (?:me|my|asking)|sem (?:me )?(?:perguntar|pedir)|gasta|spend)/.test(t)],
  ['PAUSE', t => /\b(?:pausa|pausar|pause|paused|pausada|retoma|retomar|resume|resumed|suspend|suspender|parar|para de|stop)\b/.test(t)],
];
/** The FAQ topic a person's question is about (EN/PT keywords, accents folded), or null. Deterministic; no model involved. */
export function matchAutomationFaq(text: string): AutomationFaqTopic | null {
  const t = foldText(text);
  if (!t) return null;
  return FAQ_MATCHERS.find(([, test]) => test(t))?.[0] ?? null;
}

// ── Schedule change ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The patch `replace` (`service.ts`) and `replaceAutomationSchedule` (`app/automation-action.ts`) take. */
export type ScheduleChange = SchedulePatchView;
type Mention<T> = { readonly index: number; readonly end: number; readonly value: T };
const pad = (n: number) => String(n).padStart(2, '0');
/**
 * Portuguese weekday abbreviations ("seg", "qua", "qui", "sex", "sáb", "dom", with or without a dot): read in a schedule change only, never by
 * the FAQ matcher. "ter" is not one: it is also the verb "to have" ("muda para ter a automação às 10h"), so Tuesday is read only as "terça".
 */
const PT_WEEKDAY_ABBREVIATIONS: Readonly<Partial<Record<number, string>>> = { 1: 'seg', 3: 'qua', 4: 'qui', 5: 'sex', 6: 'sab', 7: 'dom' };
const WEEKDAY_READINGS: readonly (readonly [string, number])[] = WEEKDAY_WORDS.map(([words, day]) => {
  const abbreviation = PT_WEEKDAY_ABBREVIATIONS[day];
  return [abbreviation ? `${words}|${abbreviation}` : words, day] as const;
});
const WEEKDAY_ALTERNATION = WEEKDAY_READINGS.map(([w]) => w).join('|');
function weekdayMentions(t: string): Mention<number>[] {
  const found: Mention<number>[] = [];
  for (const [words, day] of WEEKDAY_READINGS) for (const m of t.matchAll(new RegExp(`\\b(?:${words})\\b`, 'g'))) found.push({ index: m.index, end: m.index + m[0].length, value: day });
  return found.sort((a, b) => a.index - b.index);
}
/** A time anchor: "às" (folded "as"), "at", "@". ("a partir das 10h", from 10h on, is a bound and refused in UNSUPPORTED.) */
const AT = `(?:\\b(?:as|at)|@)`;
/**
 * "às 10" / "at 9" when an end, a punctuation mark, a weekday or a linking word follows — and never when the hour goes on with more of a time
 * FloFi did not read ("at 9.5", "às 9 e 5", "às 9 e meio": refused below rather than read as 9:00).
 */
const AT_HOUR = new RegExp(`${AT}\\s*([01]?\\d|2[0-3])(?::([0-5]\\d))?(?![.,]\\d|\\s*(?:e|and)\\b)(?:\\s*(?:horas?|hrs?|o'?clock))?(?=\\s*(?:$|[.,;!?)]|(?:${
  WEEKDAY_ALTERNATION}|da|de|do|no|na|em|on|in|every|each|toda|todo|todos|todas|ou|or|por|pelo|pela|please)\\b))`, 'g');
/** Spoken minutes after an hour ("e meia", "e dez", "e quarenta e cinco"); two digits ("e 15") are read as written, a single digit ("e 5") is not. */
const SPOKEN_MINUTES: Readonly<Record<string, string>> = { meia: '30', cinco: '05', dez: '10', quinze: '15', vinte: '20', 'vinte e cinco': '25', trinta: '30',
  'trinta e cinco': '35', quarenta: '40', 'quarenta e cinco': '45', cinquenta: '50', 'cinquenta e cinco': '55' };
/** The minutes of an "<hour> e <minutes>" form: the longest spoken form first, and never one that goes on ("e vinte e seis" is not read as :20). */
const MINUTES = `(${Object.keys(SPOKEN_MINUTES).sort((a, b) => b.length - a.length).join('|')}|[0-5]\\d)(?:\\s*min(?:utos?)?)?\\b(?!\\s+(?:e|and)\\s)`;
/**
 * Spelled clock forms rewritten as H:MM before reading, only where they are certainly a time: "às 9.30", "at 9,45", "9.30pm", "9,30h",
 * "1:30 p. m.", "às 9 e meia", "às 9 e 15", "às 9 e quarenta e cinco", "às 9 horas e trinta minutos", "9h e quinze", "meio-dia e 15",
 * "meia-noite e meia". Greetings ("boa tarde") are dropped so they are never read as a part of the day.
 */
function clockForms(t: string): string {
  const minutes = (minute: string) => SPOKEN_MINUTES[minute] ?? minute;
  return t.replace(/\b(?:bom dia|boa tarde|boa noite|good morning|good afternoon|good evening|good night)\b/g, ' ')
    .replace(/(\d)\s*([ap])\s*\.\s*m\s*\.?(?![a-z])/g, '$1$2m')
    .replace(new RegExp(`(${AT}\\s*)([01]?\\d|2[0-3])[.,]([0-5]\\d)(?![\\d.,])`, 'g'), '$1$2:$3')
    .replace(/\b([01]?\d|2[0-3])[.,]([0-5]\d)(?=\s*(?:[ap]\.?m\.?(?![a-z])|h\b|hs\b|hrs?\b|horas?\b|(?:da|de) (?:manha|tarde|noite)\b|in the (?:morning|afternoon|evening)\b))/g, '$1:$2')
    .replace(new RegExp(`(${AT}\\s*)([01]?\\d|2[0-3])\\s*(?:h|horas?)?\\s+e\\s+${MINUTES}`, 'g'),
      (_, prefix: string, hour: string, minute: string) => `${prefix}${hour}:${minutes(minute)}`)
    .replace(new RegExp(`\\b([01]?\\d|2[0-3])\\s*(?:h|horas?)\\s+e\\s+${MINUTES}`, 'g'), (_, hour: string, minute: string) => `${hour}:${minutes(minute)}`)
    .replace(new RegExp(`\\b(meio[- ]dia|meia[- ]noite)\\s+e\\s+${MINUTES}`, 'g'), (_, word: string, minute: string) => `${word.startsWith('meio') ? '12' : '00'}:${minutes(minute)}`)
    .replace(/\s+/g, ' ').trim();
}
/** Explicit times only: 09:30, 9h30, 10:00h, 10h, 7pm, 3 da tarde, às 10, at 9, às 10 horas, meio-dia, midnight (after `clockForms`). A bare number is never a time. */
function timeMentions(t: string): Mention<string>[] {
  const found: Mention<string>[] = [];
  const add = (m: RegExpMatchArray, hour: number, minute: number) => {
    if (hour > 23 || minute > 59 || found.some(f => m.index! < f.end && f.index < m.index! + m[0].length)) return;
    found.push({ index: m.index!, end: m.index! + m[0].length, value: `${pad(hour)}:${pad(minute)}` });
  };
  for (const m of t.matchAll(/\b(1[0-2]|0?[1-9])(?:[:h]([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/g)) {
    const h = Number(m[1]) % 12;
    add(m, m[3]!.startsWith('p') ? h + 12 : h, Number(m[2] ?? 0));
  }
  for (const m of t.matchAll(/\b(1[0-2]|0?[1-9])(?:[:h]([0-5]\d))?\s*(?:h\s*|horas?\s*)?(?:da|de|in the) (manha|tarde|noite|morning|afternoon|evening|night)\b/g)) {
    const h = Number(m[1]), period = m[3]!, morning = /manha|morning/.test(period);
    // "12 da noite" is midnight and "12 da tarde" noon; "12 da manhã" is ambiguous and refused.
    if (morning && h === 12) continue;
    add(m, morning ? h : h < 12 ? h + 12 : /noite|night/.test(period) ? 0 : 12, Number(m[2] ?? 0));
  }
  // "10:00h" / "10:00 horas" carry their unit with them.
  for (const m of t.matchAll(/\b([01]?\d|2[0-3])\s*[:h]\s*([0-5]\d)(?:\s*(?:hs?|hrs?|horas?)\b|\b)/g)) add(m, Number(m[1]), Number(m[2]));
  for (const m of t.matchAll(/\b([01]?\d|2[0-3])\s*(?:h|hs|hrs?)\b/g)) add(m, Number(m[1]), 0);
  // "às 10" / "at 9" only when an end, a punctuation mark, a weekday or a linking word follows ("as 2 automações" is no time).
  for (const m of t.matchAll(AT_HOUR)) add(m, Number(m[1]), Number(m[2] ?? 0));
  for (const m of t.matchAll(/\b(?:meio[- ]dia|noon|midday)\b/g)) add(m, 12, 0);
  for (const m of t.matchAll(/\b(?:meia[- ]noite|midnight)\b/g)) add(m, 0, 0);
  return found.sort((a, b) => a.index - b.index);
}
/**
 * The frequency words FloFi reads. "every single day", "all days" and "todas as noites / manhãs" are read as daily only together with a time
 * the person wrote (and, for nights or mornings, a time that is one: "todas as noites às 9" is refused, never read as 09:00 or 21:00).
 */
type Frequency = 'DAILY' | 'WEEKLY' | 'EVERY_DAY_AT' | 'NIGHTS' | 'MORNINGS';
const FREQUENCY_WORDS: readonly (readonly [RegExp, Frequency])[] = [
  [/\b(?:diariamente|diaria|diario|todo (?:o )?dia|todos os dias|cada dia|every ?day|each day|daily)\b/g, 'DAILY'],
  [/\b(?:semanal|semanalmente|toda semana|todas as semanas|cada semana|every week|each week|weekly)\b/g, 'WEEKLY'],
  [/\b(?:every single day|all days)\b/g, 'EVERY_DAY_AT'], [/\btodas as noites\b/g, 'NIGHTS'], [/\btodas as manhas\b/g, 'MORNINGS'],
];
function frequencyMentions(t: string): Mention<Frequency>[] {
  const found: Mention<Frequency>[] = [];
  for (const [words, frequency] of FREQUENCY_WORDS) for (const m of t.matchAll(words)) found.push({ index: m.index, end: m.index + m[0].length, value: frequency });
  return found;
}
/** Whether a frequency holds with the time read (undefined: no time was written). */
function frequencyFits(frequency: Frequency, time: string | undefined): boolean {
  if (frequency === 'DAILY' || frequency === 'WEEKLY') return true;
  if (time === undefined) return false;
  const hour = Number(time.slice(0, 2));
  return frequency === 'NIGHTS' ? hour >= 18 : frequency === 'MORNINGS' ? hour >= 5 && hour < 12 : true;
}
/**
 * One value from the mentions of a weekday or of a time: a single mention that is no source ("from Friday", "das 10h"), or — only in an
 * explicit change "from X to Y" / "de X para Y" with a change verb, nothing else between them, X the current value and Y another one — Y.
 * Anything else is null: a repeated or ranged value ("de segunda a segunda", "de 9h às 9h", "monday to monday"), a source alone ("muda de
 * sexta") or a source that is not the current value (FloFi does not move a schedule from a day or time it is not on).
 */
function resolve<T>(t: string, mentions: readonly Mention<T>[], sources: ReadonlySet<Mention<unknown>>, current: T | null | undefined): T | null | undefined {
  const [first, second] = mentions;
  if (!first) return undefined;
  if (!second) return sources.has(first) ? null : first.value;
  return mentions.length === 2 && CHANGE_VERB.test(t) && sources.has(first) && !sources.has(second) && first.value === current && second.value !== current
    && /^\s*(?:to|para|pra|pro)(?:\s+(?:o|os|a|as|the))?\s*$/.test(t.slice(first.end, second.index)) ? second.value : null;
}
const MONTHS = 'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|january|february|march|april|may|june|july|august|september|october|november|december';
/** Month names that are no ordinary word (EN "may" and "march" count only next to a day number). */
const MONTHS_ALONE = 'janeiro|fevereiro|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|january|february|april|june|july|august|september|october|november|december';
/**
 * Schedules FloFi does not support, and qualifiers a daily or weekly reading would silently drop: monthly and dated schedules, "every other" /
 * "every N", fortnightly, several times per period, weekdays-only and weekends, exceptions, one-off and relative dates, start and end dates.
 * (The FILLER check below refuses every other unread word as well; these name the common cases.)
 */
const UNSUPPORTED = new RegExp([
  '\\b(?:mensal|mensalmente|todo mes|cada mes|monthly|every month|each month)\\b',
  '\\b\\d{1,2}(?:st|nd|rd|th)\\b', '\\d\\s*[\\u00ba\\u00aa]', '\\bon the \\d', '\\b\\d{1,2}[/-]\\d{1,2}\\b',
  `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:de\\s+|of\\s+)?(?:${MONTHS})\\b`, `\\b(?:${MONTHS})\\s+\\d{1,2}(?!\\d)`, `\\b(?:${MONTHS_ALONE})\\b`,
  // "every 2h", "cada 6h", "a cada 12h": an interval, also when the number is glued to its unit.
  '\\b(?:every|each|a cada|cada)\\s+(?:\\d|(?:other|second|third|alternate|two|three|four|five|six|seven|eight|nine|ten|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|outra|outro|hours?|horas?|minutes?|minutos?)\\b)',
  '\\b(?:biweekly|bi-weekly|fortnight\\w*|quinzen\\w*|bimestral|bimensal|trimestral|quarterly|semestral|yearly|annual\\w*|anual\\w*|hourly|de hora em hora)\\b',
  '\\b(?:twice|thrice|once|vez|vezes|times)\\b', '\\b(?:semana|dia) sim\\b', '\\balternad\\w*', '\\bintercalad\\w*',
  '\\b(?:weekdays?|week[- ]days?|weekends?|week[- ]ends?|workdays?|work[- ]days?|business days?|dias? uteis|dia util|dias? de semana|fins? de semana|fim de semana|finais de semana|final de semana)\\b',
  '\\b(?:exceto|excepto|except|excluding|exclude|menos|salvo|tirando|sem ser|but not)\\b',
  '\\b(?:hoje|amanha|ontem|today|tomorrow|tonight|yesterday|until|till|desde|starting|beginning)\\b', '\\bate (?:o )?dia\\b',
  '\\bnext (?:week|month|year)\\b', '\\b(?:semana|mes|ano) que vem\\b', '\\bproxim[ao] (?:semana|mes|ano)\\b', '\\ba partir d[aeo]s?\\b',
  // One-off or temporary changes ("friday this time", "for now"), "o dia todo" (all day long) and "para na sexta" (parar: stop on Friday).
  '\\b(?:this|that|next|one) time\\b', '\\bfor now\\b', '\\bdia (?:todo|inteiro)\\b', '\\b(?:para|pra) n[ao]s?\\b',
  // Approximate times ("~9am", "≈ 10h"): never read as exact.
  '[~\\u2248\\u00b1]',
].join('|'));
/**
 * What is left of a time once the times FloFi read are taken out: if any of it remains, the person wrote a time FloFi cannot read exactly, and
 * no other time (the current one included) may stand in for it — "at 9.5", "25h", "às 9 e 5", "às nove", "à noite", "half past 9",
 * "sexta 10", "9 ou 10".
 */
const UNREAD_TIME = new RegExp([
  '\\d\\s*[.,:]\\s*\\d', '\\d\\s*(?:h|hs|hrs?|horas?|hours?|min|minutos?|minutes?|[ap]\\.?m\\.?)(?![a-z])', `${AT}\\s*\\d`, '\\d\\s+(?:or|ou)\\s+\\d',
  '\\b(?:as|at)\\s+(?:uma|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\b',
  `\\b(?:${WEEKDAY_ALTERNATION}|daily|diariamente|diaria|diario|todos os dias|everyday|weekly|semanal|semanalmente)\\b,?\\s+\\d`,
  "\\b(?:meia|quinze|quarto|quarter|half|o'?clock|manha|tarde|noite|madrugada|morning|afternoon|evening|night)\\b",
].join('|'));
/** A weekday named as one date rather than a weekly day: "this friday", "esta sexta", "next friday", "última sexta". */
const ONE_DATE = /\b(?:this|that|next|last|coming|esta|este|essa|esse|isso|nesta|neste|nessa|nesse|proxim[ao]s?|ultim[ao]s?)\s+$/;
/**
 * The only words a schedule change may contain besides what FloFi read (a time, a weekday, a frequency): words with no schedule meaning,
 * accents folded, plus the phrase "por favor". Any other word or number left over — "last", "second", "next", "que vem", "por 3 semanas",
 * "before", "UTC", "around", "lá pelas", an amount or an asset — refuses the change: FloFi asks for the day and time instead of dropping it.
 */
const FILLER: ReadonlySet<string> = new Set([
  'change', 'move', 'switch', 'reschedule', 'update', 'edit', 'make', 'set', 'put', 'it', 'this', 'that', 'the', 'a', 'an', 'my', 'please', 'instead', 'now', 'then',
  'ok', 'okay', 'to', 'for', 'on', 'at', 'in', 'from', 'every', 'each', 'schedule', 'time', 'day', 'automation', 'dca',
  'muda', 'mude', 'mudar', 'mudo', 'altera', 'altere', 'alterar', 'troca', 'troque', 'trocar', 'passa', 'passe', 'passar', 'coloca', 'coloque', 'colocar', 'mova', 'mover',
  'edita', 'edite', 'editar', 'reagenda', 'reagende', 'reagendar', 'agenda', 'agende', 'agendar', 'para', 'pra', 'pro', 'o', 'os', 'as', 'ao', 'na', 'no', 'nas', 'nos',
  'em', 'de', 'da', 'do', 'das', 'dos', 'horario', 'hora', 'dia', 'essa', 'esse', 'isso', 'minha', 'meu', 'agora', 'entao', 'toda', 'todo', 'todas', 'todos', 'cada',
  'automacao', 'agendamento']);
/** `t` with the mentioned spans blanked out. */
const blank = (t: string, mentions: readonly Mention<unknown>[]) => mentions.reduce((rest, m) => rest.slice(0, m.index) + ' '.repeat(m.end - m.index) + rest.slice(m.end), t);
/**
 * The only marks a schedule change may contain besides what FloFi read: clause marks, and "@" right before a time ("friday @ 10am"). Any other
 * symbol or emoji — "+2h", "-1h", ">9am", "≥ 9h", "9h/9h", "9h-9h", "≠ friday", "❌ friday", "sexta 🕙", "friday 🌅" — refuses the change:
 * FloFi never drops what it cannot read.
 */
const MARKS: ReadonlySet<string> = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '(', ')', '@']);
type MentionKind = 'TIME' | 'DAY' | 'FREQUENCY';
type Token = { readonly kind: MentionKind; readonly mention: Mention<unknown> } | { readonly kind: 'WORD'; readonly text: string } | { readonly kind: 'MARK'; readonly text: string };
/**
 * `t` as what FloFi read (each time, weekday and frequency) and the words and marks between them, in order — or null when two readings overlap,
 * a word (any script) or number is no FILLER, or a symbol is no MARK.
 */
function tokenize(t: string, mentions: readonly (readonly [MentionKind, Mention<unknown>])[]): Token[] | null {
  const text = t.replace(/\bpor favor\b/g, phrase => ' '.repeat(phrase.length));
  const found: Token[] = [];
  let at = 0;
  const between = (end: number) => [...text.slice(at, end).matchAll(/[\p{L}\p{N}]+|\S/gu)].every(([piece]) => {
    const word = /^[\p{L}\p{N}]/u.test(piece);
    found.push(word ? { kind: 'WORD', text: piece } : { kind: 'MARK', text: piece });
    return word ? FILLER.has(piece) : MARKS.has(piece);
  });
  for (const [kind, mention] of [...mentions].sort((a, b) => a[1].index - b[1].index)) {
    if (mention.index < at || !between(mention.index)) return null;
    found.push({ kind, mention });
    at = mention.end;
  }
  return between(text.length) ? found : null;
}
/** Skipped when looking at what stands before a weekday or a frequency ("para o sábado", "todos os sábados", "às sextas"). */
const ARTICLES: ReadonlySet<string> = new Set(['o', 'os', 'a', 'as', 'the']);
/** Words that make the weekday or time right after them the one the schedule moves FROM ("from Monday", "de segunda", "das 9h"). */
const SOURCE_WORDS: ReadonlySet<string> = new Set(['from', 'de', 'da', 'do', 'das', 'dos']);
/** Clock anchors before a time: "às 10h", "at 9:30", "à meia-noite", "ao meio-dia", "@ 10am". */
const TIME_ANCHORS: ReadonlySet<string> = new Set(['as', 'at', 'a', 'ao', '@']);
/** What may stand right before an unanchored time besides a clause start, its weekday or its frequency: the target word ("to 10am", "para 10h"). */
const TIME_LEADS: ReadonlySet<string> = new Set(['to', 'para', 'pra', 'pro']);
/** Words that make the time after them a duration or an offset, even with a clock anchor ("in 2h", "for 2h", "em 2 horas e meia"). */
const DURATION_WORDS: ReadonlySet<string> = new Set(['in', 'for', 'em']);
/**
 * What may stand before a weekday (articles skipped) besides a clause start, a time or a frequency: "para sexta", "on Friday", "set it for
 * Friday", "toda sexta", "todas as sextas", "nas sextas", "no sábado", "ao sábado".
 */
const DAY_LEADS: ReadonlySet<string> = new Set(['to', 'para', 'pra', 'pro', 'for', 'on', 'every', 'each', 'cada', 'toda', 'todo', 'todas', 'todos', 'na', 'nas', 'no', 'nos', 'ao']);
/** What may stand before a frequency (articles skipped) besides a clause start, a time or a weekday: "muda para diário", "make it daily". */
const FREQUENCY_LEADS: ReadonlySet<string> = new Set(['to', 'para', 'pra', 'pro', 'it']);
/** Words that stand only before a weekday (articles skipped): "every Friday", "toda sexta", "todas as sextas", "on Friday", "nas sextas". */
const BEFORE_A_DAY: ReadonlySet<string> = new Set(['every', 'each', 'cada', 'toda', 'todo', 'todas', 'todos', 'on', 'na', 'nas', 'nos']);
/** "no" stands only right before a Portuguese masculine weekday ("no sábado", "no domingo"): before anything else it is the English negation ("no Friday", "no 10am"). */
const NO_DAY = /^(?:sabados?|domingos?|sab|dom)$/;
/** Words after which a mark ends a clause ("ok, sexta às 10h"); after any other word a mark starts nothing ("now, 2h", "for: 2h"). */
const CLAUSE_WORDS: ReadonlySet<string> = new Set(['ok', 'okay', 'please']);
/**
 * Where each reading stands, in a closed set of positions — fail closed: any other position refuses the change. A time stands after a clock
 * anchor (às/at/à/ao/@), a clause start, a target word (to/para/pra/pro), its weekday or its frequency — never after "in", "for" or "em" (a
 * duration or an offset: "in 2h", "em 2h30"), "every" / "cada" (an interval: "every 2h") or "no" (a negation: "no 10am"). A weekday stands
 * after a clause start, a target word, "on" / "for", "every" / "toda" / "todas as", "na" / "nas" / "nos" / "no" (Portuguese masculine only) or
 * "ao", a time or a frequency. A clause starts at the start of the text or at a mark after a reading or after "ok" / "please". "from" stands
 * only before a weekday or a time, and no preposition ends a clause. A weekday or a time right after "from" / "de" / "da" / "do" / "das" /
 * "dos" is a SOURCE (what the schedule moves from), returned so `resolve` can refuse it outside "from <current> to <new>"; a frequency is
 * never one. Returns the sources, or null when a position is not one of these.
 */
function sourcesIn(t: string, tokens: readonly Token[]): ReadonlySet<Mention<unknown>> | null {
  const sources = new Set<Mention<unknown>>();
  const word = (j: number, words: ReadonlySet<string>) => { const token = tokens[j]; return token !== undefined && 'text' in token && words.has(token.text); };
  const reading = (j: number, ...kinds: readonly MentionKind[]) => { const kind = tokens[j]?.kind; return kind !== undefined && (kinds as readonly string[]).includes(kind); };
  const clause = (j: number) => {
    if (j < 0) return true;
    if (tokens[j]?.kind !== 'MARK' || word(j, TIME_ANCHORS)) return false;
    let k = j - 1;
    while (tokens[k]?.kind === 'MARK') k--;
    return k < 0 || reading(k, 'TIME', 'DAY', 'FREQUENCY') || (tokens[k]?.kind === 'WORD' && word(k, CLAUSE_WORDS));
  };
  const back = (i: number) => { let j = i - 1; while (tokens[j]?.kind === 'WORD' && word(j, ARTICLES)) j--; return j; };
  const ahead = (i: number) => { let j = i + 1; while (tokens[j]?.kind === 'WORD' && word(j, ARTICLES)) j++; return j; };
  for (const [i, token] of tokens.entries()) {
    if (token.kind === 'MARK') {
      if (token.text === '@' && !reading(i + 1, 'TIME')) return null;
      continue;
    }
    if (token.kind === 'WORD') {
      if (token.text === 'from' && !reading(ahead(i), 'TIME', 'DAY')) return null;
      if (BEFORE_A_DAY.has(token.text) && !reading(ahead(i), 'DAY')) return null;
      if ((SOURCE_WORDS.has(token.text) || DURATION_WORDS.has(token.text)) && (i + 1 === tokens.length || tokens[i + 1]!.kind === 'MARK')) return null;
      const right = tokens[i + 1];
      if (token.text === 'no' && !(right?.kind === 'DAY' && NO_DAY.test(t.slice(right.mention.index, right.mention.end)))) return null;
      continue;
    }
    if (token.kind === 'TIME') {
      const anchored = /^(?:as|at|@)/.test(t.slice(token.mention.index, token.mention.end)), byAnchor = !anchored && word(i - 1, TIME_ANCHORS);
      const lead = byAnchor ? i - 2 : i - 1;
      if (word(lead, SOURCE_WORDS)) sources.add(token.mention);
      else if (word(lead, DURATION_WORDS)) return null;
      else if (!(anchored || byAnchor || clause(lead) || word(lead, TIME_LEADS) || reading(lead, 'DAY', 'FREQUENCY'))) return null;
      continue;
    }
    const lead = back(i);
    if (word(lead, SOURCE_WORDS)) {
      if (token.kind === 'FREQUENCY') return null;
      sources.add(token.mention);
      continue;
    }
    const day = token.kind === 'DAY';
    if (!(clause(lead) || word(lead, day ? DAY_LEADS : FREQUENCY_LEADS) || reading(lead, 'TIME', day ? 'FREQUENCY' : 'DAY'))) return null;
  }
  return sources;
}
/**
 * The schedule a person asked for, read deterministically from their words: `{ frequency, weekday, time }`, or null. It FAILS CLOSED by
 * construction: after reading the weekday, the time and the frequency, every word left must be a FILLER word (no schedule meaning) and every
 * symbol one of the MARKS, and each reading must stand where it can only mean the new schedule (`sourcesIn`); anything else — a qualifier, a
 * time zone, an approximation, a date, an amount, a duration ("in 2h"), an interval ("every 2h", "de 2h em 2h"), a bound or source ("from 9am",
 * "muda de sexta"), a range ("de segunda a segunda"), a negation ("no Friday"), a symbol or an emoji — makes it null, so FloFi asks for the day
 * and time instead. A weekday makes it WEEKLY; "daily" / "todos os dias" makes it DAILY. Anything not said is kept from `current`: a time that
 * was not written is never invented (the current time stays), and "weekly" with no weekday keeps the current one (or, from a daily schedule,
 * is null: FloFi does not pick a day). With no current schedule, every part must be said. A time FloFi cannot read exactly, a choice of times
 * ("9 or 10"), several weekdays and any qualifier it would drop make it null: never a time or a day the person did not write. An explicit
 * "from X to Y" is read only when X is the current weekday or time.
 */
export function parseScheduleChange(text: string, current: RuleView['schedule']): ScheduleChange | null {
  const t = clockForms(foldText(text));
  if (!t || UNSUPPORTED.test(t)) return null;
  const times = timeMentions(t);
  // A day number that is no time FloFi read is a day of the month ("todo dia 5", "dia 15 às 10h"): unsupported. "todo dia 9h" is a time.
  for (const m of t.matchAll(/\b(?:dias?|days?)\s+(\d{1,2})(?!\d)/g)) if (!times.some(time => time.index === m.index + m[0].length - m[1]!.length)) return null;
  // A time offered as one of several ("at 9 or 10", "9h ou 10h") is ambiguous.
  if (times.some(m => /^\s*(?:or|ou)\b/.test(t.slice(m.end)) || /\b(?:or|ou)\s*$/.test(t.slice(0, m.index)))) return null;
  if (UNREAD_TIME.test(blank(t, times))) return null;
  const days = weekdayMentions(t), frequencies = frequencyMentions(t);
  if (days.some(d => ONE_DATE.test(t.slice(0, d.index)))) return null;
  // Fail closed: every word was read above or is a filler, every symbol is a mark, and every reading stands where it means the new schedule.
  const tokens = tokenize(t, [...times.map(m => ['TIME', m] as const), ...days.map(m => ['DAY', m] as const), ...frequencies.map(m => ['FREQUENCY', m] as const)]);
  const sources = tokens && sourcesIn(t, tokens);
  if (!sources) return null;
  const daily = frequencies.some(f => f.value !== 'WEEKLY'), weekly = frequencies.some(f => f.value === 'WEEKLY');
  const day = resolve(t, days, sources, current?.frequency === 'WEEKLY' ? current.weekday : null), time = resolve(t, times, sources, current?.time);
  if (day === null || time === null || (daily && (day !== undefined || weekly))) return null;
  if (!frequencies.every(f => frequencyFits(f.value, time))) return null;
  if (!daily && !weekly && day === undefined && time === undefined) return null;
  const chosen = time ?? current?.time;
  if (!chosen) return null;
  if (daily) return { frequency: 'DAILY', weekday: null, time: chosen };
  if (day !== undefined) return { frequency: 'WEEKLY', weekday: day, time: chosen };
  if (weekly) return current?.frequency === 'WEEKLY' && current.weekday ? { frequency: 'WEEKLY', weekday: current.weekday, time: chosen } : null;
  // A time-only change keeps the current frequency and weekday.
  return current ? { frequency: current.frequency, weekday: current.weekday, time: chosen } : null;
}
