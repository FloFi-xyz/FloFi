// SPDX-License-Identifier: AGPL-3.0-only
/** The shared automation copy (`explain.ts`): summaries, recorded-fact explanations, FAQ answers and the deterministic schedule-change reading. */
import { describe, expect, it } from 'vitest';
import { portuguese } from '../i18n/pt';
import { AUTOMATION_FAQ, AUTOMATION_FAQ_TOPICS, automationFaq, ERROR_TEXT, explainRuleStatus, KIND_LABEL, matchAutomationFaq, OCCURRENCE_LABEL, OUTCOME_LABEL,
  parseScheduleChange, ruleSummary, STATE_LABEL, WEEKDAYS, type AutomationFaqTopic } from './explain';
import type { HistoryEntryView, OccurrenceView, RuleView } from './views';

const ACTION: NonNullable<RuleView['action']> = { network: 'base', networkLabel: 'Base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '50', slippageBps: 50, side: 'BUY',
  fundsClass: 'REAL_FUNDS' };
const rule = (patch: Partial<RuleView> = {}): RuleView => ({ ruleId: 'aut_aaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Weekly ETH', kind: 'SCHEDULED_DCA', state: 'ACTIVE',
  executionMode: 'CONFIRM_EACH_TIME', authorizationId: null, version: 1, timezone: 'Europe/Lisbon', schedule: { frequency: 'WEEKLY', weekday: 1, time: '09:00' }, condition: null,
  watch: null, limits: { maxAmountPerExecution: '50', maxAmountPerPeriod: null, maxOccurrencesPerPeriod: null, cooldownMinutes: 0, maxSlippageBps: 100 }, action: ACTION,
  source: null, nextEvaluationAt: '2026-11-16T09:00:00.000Z', lastEvaluationAt: '2026-11-09T09:00:00.000Z', lastOutcome: 'TRIGGERED', lastObservation: null, armed: null,
  attention: null, expiresAt: null, createdAt: '2026-11-01T10:00:00.000Z', pending: 0, ...patch });
const priceRule = (patch: Partial<RuleView> = {}) => rule({ name: 'ETH dip', kind: 'PRICE_TRIGGER', schedule: null, armed: true, lastOutcome: 'CONDITION_NOT_MET',
  condition: { type: 'PRICE_BELOW', asset: 'ETH', threshold: '3000', reference: null, percent: null, effectiveThreshold: '3000', checkEveryMinutes: 15 }, ...patch });
const entry = (at: string, outcome: string, detail: HistoryEntryView['detail'] = null, observation: HistoryEntryView['observation'] = null): HistoryEntryView =>
  ({ at, outcome, occurrenceId: null, observation, detail });
const occurrence = (patch: Partial<OccurrenceView> = {}): OccurrenceView => ({ occurrenceId: 'occ_aaaaaaaaaaaaaaaaaaaaaaaaaa', ruleId: 'aut_aaaaaaaaaaaaaaaaaaaaaaaaaa',
  ruleName: 'Weekly ETH', kind: 'SCHEDULE', state: 'PENDING_OWNER', dueAt: '2026-11-09T09:00:00.000Z', expiresAt: '2026-11-10T09:00:00.000Z', action: ACTION, observations: [],
  outcome: null, decidedAt: null, approval: null, notifications: [], ...patch });

describe('shared automation labels', () => {
  it('keeps the workspace’s labels, each with its Portuguese in the central catalog', () => {
    expect(WEEKDAYS[4]).toBe('Friday');
    expect(KIND_LABEL.SCHEDULED_DCA).toBe('Recurring buy');
    expect(OUTCOME_LABEL.MISSED).toBe('Missed while FloFi was unavailable');
    expect(ERROR_TEXT.AUTOMATION_VERSION_CONFLICT).toBe('This automation changed in another session. Refresh and try again.');
    for (const table of [STATE_LABEL, KIND_LABEL, OCCURRENCE_LABEL, OUTCOME_LABEL, ERROR_TEXT]) for (const value of Object.values(table))
      expect(Object.hasOwn(portuguese, value), value).toBe(true);
  });
});

describe('ruleSummary', () => {
  it('names kind, action, weekday, time, zone, state and mode (EN/PT)', () => {
    expect(ruleSummary(rule(), 'EN')).toBe('Recurring buy “Weekly ETH”: Prepare 50 USDC → WETH on Base · Every Monday at 09:00 (Europe/Lisbon) · Active · Ask me before every execution');
    const pt = ruleSummary(rule({ state: 'PAUSED', schedule: { frequency: 'WEEKLY', weekday: 5, time: '10:30' } }), 'PT');
    expect(pt).toContain('Compra recorrente “Weekly ETH”');
    expect(pt).toContain('sexta-feira às 10:30 (Europe/Lisbon)');
    expect(pt).toContain('Em pausa');
    expect(pt).toContain('Perguntar antes de cada execução');
    expect(ruleSummary(rule({ schedule: { frequency: 'DAILY', weekday: null, time: '07:15' } }), 'EN')).toContain('Every day at 07:15 (Europe/Lisbon)');
  });
  it('summarizes a price trigger by its condition and a daily watch by its assets', () => {
    expect(ruleSummary(priceRule(), 'EN')).toBe('Price trigger “ETH dip”: Prepare 50 USDC → WETH on Base · If ETH falls below $3,000 · checked every 15 min · Active · Ask me before every execution');
    expect(ruleSummary(rule({ kind: 'DAILY_WATCH', action: null, watch: { assets: ['ETH', 'BTC'] } }), 'EN')).toContain('Daily watch “Weekly ETH”: ETH / BTC · Notify me');
  });
  it('never presents a retired delegated rule’s mode as available (EN/PT)', () => {
    const delegated = rule({ executionMode: 'DELEGATED_WITH_LIMITS', authorizationId: 'dau_x', state: 'PAUSED' });
    expect(ruleSummary(delegated, 'EN')).toMatch(/· Automatic within limits \(retired on this deployment\)$/);
    expect(ruleSummary(delegated, 'PT')).toMatch(/· Automático dentro dos limites \(desativado neste ambiente\)$/);
  });
});

describe('explainRuleStatus (recorded facts only)', () => {
  it('says when an active rule is evaluated next and that it ran last time', () => {
    const r = explainRuleStatus(rule(), [entry('2026-11-09T09:00:00.000Z', 'TRIGGERED')], [occurrence()], 'EN');
    expect(r.lines[0]).toMatch(/^It is active\. Next evaluation: .*16.*Nov.*09:00 \(Europe\/Lisbon\)\.$/);
    expect(r.text).toContain('it ran: FloFi created a proposal for you.');
    expect(r.text).toMatch(/The proposal from .* is waiting for you until /);
  });
  it('explains MISSED with its recorded count (EN/PT)', () => {
    const history = [entry('2026-11-09T09:00:00.000Z', 'MISSED', { count: 3, policy: 'LATEST_WITHIN_GRACE' })];
    expect(explainRuleStatus(rule({ lastOutcome: 'MISSED' }), history, [], 'EN').text)
      .toContain('3 scheduled time(s) passed while FloFi was unavailable and were not proposed (only the latest one, within 6 hours, can still be).');
    expect(explainRuleStatus(rule({ lastOutcome: 'MISSED' }), history, [], 'PT').text).toContain('3 horário(s) agendado(s) passaram enquanto o FloFi estava indisponível');
  });
  it('explains LIMIT_BLOCKED with the recorded limit code, and names an unknown or missing one as recorded', () => {
    const at = '2026-11-09T09:00:00.000Z';
    expect(explainRuleStatus(rule(), [entry(at, 'LIMIT_BLOCKED', { code: 'LIMIT_PERIOD_COUNT' })], [], 'EN').text)
      .toContain('a limit blocked the proposal: it would exceed your maximum number of proposals for the period.');
    expect(explainRuleStatus(rule(), [entry(at, 'LIMIT_BLOCKED', { code: 'LIMIT_COOLDOWN' })], [], 'PT').text).toContain('um limite bloqueou a proposta: veio dentro do intervalo de espera');
    expect(explainRuleStatus(rule(), [entry(at, 'LIMIT_BLOCKED', { code: 'LIMIT_NEW_KIND' })], [], 'EN').text).toContain('a limit blocked the proposal (LIMIT_NEW_KIND).');
    expect(explainRuleStatus(rule(), [entry(at, 'LIMIT_BLOCKED')], [], 'EN').text).toContain('FloFi did not record which one');
    // An older blocker since the last proposal is still reported when the latest evaluation is not itself one.
    const older = explainRuleStatus(priceRule(), [entry('2026-11-09T10:00:00.000Z', 'CONDITION_NOT_MET'), entry(at, 'LIMIT_BLOCKED', { code: 'LIMIT_AMOUNT_PER_EXECUTION' }),
      entry('2026-11-08T09:00:00.000Z', 'TRIGGERED')], [], 'EN');
    expect(older.text).toContain('Earlier: ');
    expect(older.text).toContain('the amount is above your maximum per execution');
    expect(older.text).toContain('Last time it ran: ');
  });
  it('explains a paused rule (and a retired delegated one) without inventing a next evaluation', () => {
    const paused = explainRuleStatus(rule({ state: 'PAUSED', nextEvaluationAt: null, lastOutcome: null, lastEvaluationAt: null }), [entry('2026-11-09T09:00:00.000Z', 'AUTOMATION_PAUSED')], [], 'EN');
    expect(paused.lines[0]).toBe('This automation is paused: FloFi creates no proposals until you resume it, and resuming computes the next evaluation from that moment.');
    expect(paused.text).not.toMatch(/Next evaluation/);
    expect(paused.text).toContain('FloFi has not recorded any evaluation of this automation yet.');
    expect(explainRuleStatus(rule({ state: 'PAUSED', executionMode: 'DELEGATED_WITH_LIMITS', nextEvaluationAt: null }), [], [], 'PT').text).toContain('EXECUTOR_FUNDED_GAS_RETIRED');
  });
  it('explains an expired rule and an expired, never-opened proposal (conditionally: whether it was opened is not recorded here)', () => {
    const r = explainRuleStatus(rule({ state: 'EXPIRED', nextEvaluationAt: null, expiresAt: '2026-11-10T00:00:00.000Z' }), [],
      [occurrence({ state: 'EXPIRED', outcome: 'OCCURRENCE_EXPIRED' })], 'EN');
    expect(r.lines[0]).toMatch(/^This automation expired on .*: it will not run again\.$/);
    expect(r.text).toContain('expired. If you never opened it, nothing was sent and it does not count against your limits.');
    expect(explainRuleStatus(rule(), [], [occurrence({ state: 'EXPIRED', outcome: 'OCCURRENCE_EXPIRED', approval: { status: 'REVOKED', runs: [], runsComplete: true } })], 'EN').text)
      .toContain('expired after you opened it for review, without being loaded into your workflow.');
    expect(explainRuleStatus(rule(), [], [occurrence({ state: 'EXPIRED', outcome: 'AUTOMATION_REPLACED' })], 'PT').text).toContain('foi retirada quando a automação mudou');
    // A proposal the owner had already loaded into their workflow is never described as withdrawn; its run lines stay.
    for (const outcome of ['AUTOMATION_REPLACED', 'AUTOMATION_ARCHIVED', 'AUTOMATION_REBOUND', 'AUTOMATION_REBOUND_WITHDRAWN']) {
      const applied = occurrence({ state: 'EXPIRED', outcome, approval: { status: 'APPLIED', runs: [], runsComplete: true } });
      const en = explainRuleStatus(rule(), [], [applied], 'EN').text, pt = explainRuleStatus(rule(), [], [applied], 'PT').text;
      expect(en, outcome).not.toMatch(/withdrawn|retirad/i);
      expect(pt, outcome).not.toMatch(/withdrawn|retirad/i);
      expect(en).toMatch(/The proposal from .* was loaded into your workflow before the automation changed\./);
      expect(en).toContain('No run of it is recorded yet.');
      expect(pt).toMatch(/A proposta de .* foi carregada no seu fluxo antes de a automação mudar\./);
    }
    expect(explainRuleStatus(rule(), [], [occurrence({ state: 'DISMISSED', outcome: 'OWNER_DISMISSED' })], 'EN').text).toMatch(/You dismissed the proposal from /);
  });
  it('explains price-source failures and price steps from the history', () => {
    const observed = { asset: 'ETH', priceUsd: '3120.5', observedAt: '2026-11-09T09:00:00.000Z', source: 'CHAINLINK', evidence: 'PUBLIC_READ_ONLY' };
    expect(explainRuleStatus(priceRule(), [entry('2026-11-09T09:00:00.000Z', 'PRICE_SOURCE_TIMEOUT', { code: 'PRICE_SOURCE_TIMEOUT' })], [], 'EN').text)
      .toContain('FloFi had no usable fresh price (Price source timed out — ignored), so nothing changed.');
    expect(explainRuleStatus(priceRule(), [entry('2026-11-09T09:00:00.000Z', 'PRICE_STALE')], [], 'PT').text)
      .toContain('o FloFi não tinha um preço recente utilizável (Observação de preço demasiado antiga — ignorada)');
    expect(explainRuleStatus(priceRule(), [entry('2026-11-09T09:00:00.000Z', 'CONDITION_NOT_MET', null, observed)], [], 'EN').text)
      .toContain('the price condition was not met (observed ETH $3,120.50).');
    expect(explainRuleStatus(priceRule(), [entry('2026-11-09T09:00:00.000Z', 'COOLDOWN')], [], 'EN').text).toContain('the price crossed during the cooldown');
  });
  it('reads a price check that is unchanged since its recorded entry from the rule itself: its latest time and price, never the old price as current', () => {
    const old = { asset: 'ETH', priceUsd: '3120.5', observedAt: '2026-11-09T09:00:00.000Z', source: 'CHAINLINK', evidence: 'PUBLIC_READ_ONLY' };
    const latest = { ...old, priceUsd: '3050', observedAt: '2026-11-10T14:15:00.000Z' };
    const history = [entry('2026-11-09T09:00:00.000Z', 'CONDITION_NOT_MET', null, old)];
    const r = explainRuleStatus(priceRule({ lastEvaluationAt: '2026-11-10T14:15:00.000Z', lastObservation: latest }), history, [], 'EN');
    expect(r.lines[1]).toMatch(/^Latest evaluation: .*10.*Nov.*14:15.* — the price condition was not met \(observed ETH \$3,050\)\.$/);
    expect(r.lines[2]).toMatch(/^Recorded since .*9.*Nov.*09:00.* and still the case at the latest evaluation \(FloFi records a price check in the history only when its outcome changes\)\.$/);
    expect(r.text).not.toContain('3,120.50');
    expect(explainRuleStatus(priceRule({ lastEvaluationAt: '2026-11-10T14:15:00.000Z', lastObservation: latest }), history, [], 'PT').text)
      .toMatch(/Última avaliação: .*observado ETH \$3,050\).*\n.*Registrado desde .* e ainda era assim na última avaliação/s);
    // A changed outcome, an equal time or a scheduled rule keep the recorded entry as the latest fact.
    expect(explainRuleStatus(priceRule({ lastEvaluationAt: '2026-11-10T14:15:00.000Z', lastOutcome: 'PRICE_STALE', lastObservation: latest }), history, [], 'EN').lines[1])
      .toMatch(/^Latest recorded evaluation: .*observed ETH \$3,120\.50/);
    expect(explainRuleStatus(priceRule({ lastEvaluationAt: '2026-11-09T09:00:00.000Z', lastObservation: latest }), history, [], 'EN').lines[1]).toMatch(/^Latest recorded evaluation: /);
  });
  it('reports attention, notification failures and recorded run error codes as recorded', () => {
    const r = explainRuleStatus(rule({ attention: 'WORKFLOW_CHANGED' }), [entry('2026-11-09T09:00:00.000Z', 'WORKFLOW_CHANGED')], [occurrence({ state: 'COMPLETED',
      notifications: [{ channel: 'TELEGRAM', status: 'FAILED', code: 'CHANNEL_SEND_FAILED' }],
      approval: { status: 'APPLIED', runsComplete: true, runs: [{ executionId: 'exe_1', status: 'FAILED', reconciled: true, terminal: true, errorCode: 'INSUFFICIENT_INPUT',
        evidenceEnvironment: null, evidenceOutcome: null, evidenceBundleHash: null, needsObservation: false, attempts: [] }] } })], 'EN');
    expect(r.text).toContain('Its saved workflow changed after it was created: FloFi proposes nothing until you rebind it.');
    expect(r.text).toContain('A recorded run of it ended with INSUFFICIENT_INPUT (FAILED).');
    expect(r.text).toContain('Its TELEGRAM notification failed (CHANNEL_SEND_FAILED); the proposal itself was not affected.');
    const unread = explainRuleStatus(rule(), [], [occurrence({ state: 'COMPLETED', approval: { status: 'APPLIED', runs: [], runsComplete: false } })], 'EN');
    expect(unread.text).toContain('Its run status could not be read now — that is not evidence that nothing was sent.');
  });
  it('says which facts it did not read instead of guessing', () => {
    const none = explainRuleStatus(rule({ lastOutcome: null, lastEvaluationAt: null }), null, null, 'EN');
    expect(none.text).toContain('FloFi did not read this automation’s proposals here');
    expect(none.text).toContain('FloFi did not read this automation’s evaluation history here');
    expect(none.text).not.toMatch(/ran|blocked|missed/i);
    const fallback = explainRuleStatus(rule({ lastOutcome: 'LIMIT_BLOCKED' }), null, [], 'PT');
    expect(fallback.text).toContain('Última avaliação: ');
    expect(fallback.text).toContain('(o FloFi não registrou qual)');
    expect(fallback.text).toContain('Nenhuma proposta desta automação está registrada.');
  });
  it('explains an archived rule that a schedule change replaced', () => {
    const r = explainRuleStatus(rule({ state: 'ARCHIVED', nextEvaluationAt: null }), [entry('2026-11-09T09:00:00.000Z', 'AUTOMATION_REPLACED', { replacedBy: 'aut_b' })], [], 'EN');
    expect(r.lines.slice(0, 2)).toEqual(['This automation is archived: it will not run again.', 'It was replaced by a new automation with a changed schedule.']);
  });
});

describe('AUTOMATION_FAQ', () => {
  it('answers every topic in both languages, briefly', () => {
    for (const topic of AUTOMATION_FAQ_TOPICS) for (const language of ['EN', 'PT'] as const) {
      const answer = automationFaq(topic, language);
      expect(answer.length, `${topic} ${language}`).toBeGreaterThan(80);
      expect(answer.length, `${topic} ${language}`).toBeLessThanOrEqual(600);
    }
    expect(automationFaq('INSUFFICIENT_BALANCE', 'PT')).toBe(AUTOMATION_FAQ.INSUFFICIENT_BALANCE.PT);
  });
  it('states the code’s behaviour', () => {
    const balance = automationFaq('INSUFFICIENT_BALANCE', 'EN');
    expect(balance).toMatch(/does not check your balance/);
    expect(balance).toMatch(/still created/);
    expect(balance).toMatch(/fresh simulation/);
    expect(balance).toMatch(/24 hours.*6 hours/);
    expect(balance).toMatch(/never opened does not count against your limits/);
    expect(automationFaq('PRICE_DROP', 'EN')).toMatch(/whatever the price.*slippage.*price-trigger.*pause/s);
    expect(automationFaq('AUTHORIZATION', 'EN')).toMatch(/authorizes no spending.*own wallet/s);
    expect(automationFaq('DELEGATION_STATUS', 'EN')).toMatch(/EXECUTOR_FUNDED_GAS_RETIRED.*revoked/s);
    expect(automationFaq('SCHEDULE_CHANGE', 'EN')).toMatch(/cannot be edited in place.*new automation.*archives the old one/s);
    expect(automationFaq('PAUSE', 'PT')).toMatch(/não cria propostas.*Ao retomar/s);
    expect(automationFaq('WHY_NOT_RUN', 'EN')).toMatch(/paused.*6 hours.*limit.*rebind/s);
  });
  it.each<[string, AutomationFaqTopic | null]>([
    ['O que acontece se eu não tiver saldo?', 'INSUFFICIENT_BALANCE'], ['What happens if I don’t have enough balance?', 'INSUFFICIENT_BALANCE'],
    ['e se faltar USDC na carteira?', 'INSUFFICIENT_BALANCE'], ['what if I have no funds', 'INSUFFICIENT_BALANCE'],
    ['E se o preço cair?', 'PRICE_DROP'], ['Will it still buy if the price drops?', 'PRICE_DROP'],
    ['Preciso autorizar cada compra?', 'AUTHORIZATION'], ['Does it spend without asking me?', 'AUTHORIZATION'], ['ela assina sozinha?', 'AUTHORIZATION'],
    ['A execução automática ainda funciona?', 'DELEGATION_STATUS'], ['what about delegated execution?', 'DELEGATION_STATUS'],
    ['Muda para sexta-feira', 'SCHEDULE_CHANGE'], ['can I change the time to 10am?', 'SCHEDULE_CHANGE'], ['quero editar a automação', 'SCHEDULE_CHANGE'],
    ['como pausar?', 'PAUSE'], ['What happens when I pause it?', 'PAUSE'],
    ['por que não rodou?', 'WHY_NOT_RUN'], ['Por que a automação não executou ontem?', 'WHY_NOT_RUN'], ['why didn’t my DCA run?', 'WHY_NOT_RUN'],
    ['qual é o meu saldo?', null], ['olá', null], ['', null],
  ])('matches %j → %s', (text, topic) => expect(matchAutomationFaq(text)).toBe(topic));
});

describe('parseScheduleChange (deterministic, never invents a time)', () => {
  const weeklyMonday = { frequency: 'WEEKLY', weekday: 1, time: '09:00' } as const;
  it.each<[string, RuleView['schedule'], ReturnType<typeof parseScheduleChange>]>([
    ['muda para sexta', weeklyMonday, { frequency: 'WEEKLY', weekday: 5, time: '09:00' }],
    ['Muda para sexta-feira', weeklyMonday, { frequency: 'WEEKLY', weekday: 5, time: '09:00' }],
    ['toda segunda às 10h', { frequency: 'DAILY', weekday: null, time: '08:00' }, { frequency: 'WEEKLY', weekday: 1, time: '10:00' }],
    ['change it to Friday 9:30', weeklyMonday, { frequency: 'WEEKLY', weekday: 5, time: '09:30' }],
    ['diariamente', weeklyMonday, { frequency: 'DAILY', weekday: null, time: '09:00' }],
    ['every day at 7pm', weeklyMonday, { frequency: 'DAILY', weekday: null, time: '19:00' }],
    ['todos os dias às 7', weeklyMonday, { frequency: 'DAILY', weekday: null, time: '07:00' }],
    ['muda para as 18h30', weeklyMonday, { frequency: 'WEEKLY', weekday: 1, time: '18:30' }],
    ['quarta às 3 da tarde', weeklyMonday, { frequency: 'WEEKLY', weekday: 3, time: '15:00' }],
    ['muda de segunda para sexta', weeklyMonday, { frequency: 'WEEKLY', weekday: 5, time: '09:00' }],
    ['move it from Monday to Thursday at noon', weeklyMonday, { frequency: 'WEEKLY', weekday: 4, time: '12:00' }],
    ['semanalmente', weeklyMonday, { frequency: 'WEEKLY', weekday: 1, time: '09:00' }],
    ['sábado à meia-noite', weeklyMonday, { frequency: 'WEEKLY', weekday: 6, time: '00:00' }],
    ['toda sexta às 10h', null, { frequency: 'WEEKLY', weekday: 5, time: '10:00' }],
    // Clock forms with a dot, a comma or spoken minutes are read exactly.
    ['change it to Friday at 9.30pm', weeklyMonday, { frequency: 'WEEKLY', weekday: 5, time: '21:30' }],
    ['at 9.45', weeklyMonday, { frequency: 'WEEKLY', weekday: 1, time: '09:45' }],
    ['às 9,30', weeklyMonday, { frequency: 'WEEKLY', weekday: 1, time: '09:30' }],
    ['muda para sexta às 9 e meia', weeklyMonday, { frequency: 'WEEKLY', weekday: 5, time: '09:30' }],
    ['às 9 e 15', weeklyMonday, { frequency: 'WEEKLY', weekday: 1, time: '09:15' }],
    ['às 9 e meia da noite', weeklyMonday, { frequency: 'WEEKLY', weekday: 1, time: '21:30' }],
    ['muda para as 10h e quinze', weeklyMonday, { frequency: 'WEEKLY', weekday: 1, time: '10:15' }],
    // "todo dia" followed by a time is daily, not a day of the month.
    ['todo dia 9h', weeklyMonday, { frequency: 'DAILY', weekday: null, time: '09:00' }],
    ['todo dia às 9h', weeklyMonday, { frequency: 'DAILY', weekday: null, time: '09:00' }],
    ['every day 9am', weeklyMonday, { frequency: 'DAILY', weekday: null, time: '09:00' }],
    ['every day at 9', weeklyMonday, { frequency: 'DAILY', weekday: null, time: '09:00' }],
    // A plural weekday is that weekday; a greeting is no part of the day.
    ['change it to Fridays at 10am', weeklyMonday, { frequency: 'WEEKLY', weekday: 5, time: '10:00' }],
    ['às sextas às 10h', weeklyMonday, { frequency: 'WEEKLY', weekday: 5, time: '10:00' }],
    ['Boa tarde! Muda para sexta às 10h', weeklyMonday, { frequency: 'WEEKLY', weekday: 5, time: '10:00' }],
    ['Friday at 10 o’clock', weeklyMonday, { frequency: 'WEEKLY', weekday: 5, time: '10:00' }],
  ])('%j → %j', (text, current, expected) => expect(parseScheduleChange(text, current)).toEqual(expected));
  it.each<[string, RuleView['schedule']]>([
    ['de segunda a sexta', weeklyMonday],                                       // a range, not one weekday
    ['weekly', { frequency: 'DAILY', weekday: null, time: '09:00' }],           // which day? FloFi does not pick one
    ['todo dia 5', weeklyMonday],                                               // monthly: unsupported
    ['daily on Friday', weeklyMonday],                                          // contradictory
    ['muda para amanhã', weeklyMonday],                                         // nothing FloFi reads as a schedule
    ['pausa as 2 automações', weeklyMonday],                                    // "as 2" is no time
    ['muda para sexta', null],                                                  // no current time to keep, and none written
    ['muda das 9h para 10h ou 11h', weeklyMonday],                              // several times: ambiguous
    // Never a time the person did not write: unreadable or alternative times are refused, not replaced by 09:00.
    ['change to friday at 9 or 10', weeklyMonday], ['muda para sexta às 9h ou 10h', weeklyMonday], ['at 9.5', weeklyMonday], ['às 25h', weeklyMonday],
    ['muda para sexta 9 e meia', weeklyMonday], ['às 9 e 5', weeklyMonday], ['muda para sexta às nove', weeklyMonday], ['every night at 9', weeklyMonday],
    ['muda para sexta à tarde', weeklyMonday], ['half past 9 on Friday', weeklyMonday], ['muda para sexta 10', weeklyMonday], ['Friday 9 o’clock', weeklyMonday],
    // Day of the month: "todo dia 5" without a time unit, with a time after it, or "dia 15".
    ['todo dia 5 às 10h', weeklyMonday], ['muda para dia 15 às 10h', weeklyMonday], ['5 de março às 10h', weeklyMonday], ['on the 15th at 10am', weeklyMonday],
    ['every month on the 1st at 9am', weeklyMonday], ['March 5 at 10am', weeklyMonday],
    // Qualifiers FloFi would otherwise drop.
    ['every other Friday at 10am', weeklyMonday], ['weekdays at 8am', weeklyMonday], ['a cada 15 dias às 10h', weeklyMonday], ['quinzenalmente às 10h', weeklyMonday],
    ['muda para amanhã às 10', weeklyMonday], ['every 2 weeks', weeklyMonday], ['every 2 weeks on Friday', weeklyMonday], ['twice a week at 9am', weeklyMonday],
    ['duas vezes por semana às 9h', weeklyMonday], ['todos os dias úteis às 9h', weeklyMonday], ['fim de semana às 10h', weeklyMonday], ['weekend at 10am', weeklyMonday],
    ['todo dia exceto domingo às 9h', weeklyMonday], ['every day except Sunday at 9am', weeklyMonday], ['hoje às 10h', weeklyMonday], ['today at 10am', weeklyMonday],
    ['tomorrow at 10am', weeklyMonday], ['toda sexta a partir de amanhã', weeklyMonday], ['every Friday until December', weeklyMonday],
  ])('%j → null', (text, current) => expect(parseScheduleChange(text, current)).toBeNull());
});
