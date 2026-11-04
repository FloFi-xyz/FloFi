// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-AUTOMATION-001: the Automations workspace — automated evaluation, owner-confirmed execution. The owner creates scheduled DCAs,
 * price triggers and daily market rounds, sees what FloFi is waiting on them for, and opens each proposal into FloFi's existing flow
 * (/approve → fresh simulation → Strategy Manifest Review → own wallet signature). Nothing here signs, submits or approves: every
 * server action re-verifies the owner's wallet session, and the only way forward from a proposal is the shared approval flow.
 */
import { cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { automationHistory, automationOverview, automationsAvailability, changeAutomationState, createAutomation, createTelegramLinkCode, dismissAutomationOccurrence,
  openAutomationOccurrence, prepareWatchProposal, rebindAutomation, unlinkTelegram } from '../app/automation-action';
import type { CapabilityView, HistoryEntryView, LinkCodeView, ObservationView, OccurrenceView, OverviewView, RouteCapability, RuleHistoryView, RuleView } from '../automations/views';
import type { Command } from '../domain/commands';
import type { WorkflowOwner } from '../domain/saved-workflow';
import { useLocale } from '../i18n/locale';
import { automationRunLabel } from './automation-run-status';
import { WalletProof, type useWalletProof } from './wallet-proof';
import type { ReviewView } from '../delegation/views';
import { AuthorizationReview, DelegatedAuthorizations, DelegatedCreate, DELEGATION_ERROR_TEXT, useDelegation } from './delegated-automations';
import { CanvasAutomation, type CanvasAutomationDraft } from './canvas-automation';
import { bindingViolation } from '../automations/limits';
import { validateAutomationInput, type AutomationInput, type ActionRequest } from '../automations/definition';
import { automationCapabilityIssue } from '../domain/copilot-automation';
import { DEFAULT_SLIPPAGE, DEFAULT_SLIPPAGE_BPS } from '../domain/slippage-policy';

export type AutomationNavigation = { readonly owner: WorkflowOwner | null; readonly proof: ReturnType<typeof useWalletProof>; readonly onPropose: (command: Command) => void;
  /** BUILD-AUTOMATION-002: "Automate this workflow" — the exact Canvas workflow, when the owner came from the Canvas. */
  readonly openChat?: () => void; readonly canvas?: CanvasAutomationDraft | null };
type Kind = RuleView['kind'];
type Asset = 'ETH' | 'BTC' | 'SOL';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const STATE_LABEL: Readonly<Record<string, string>> = { ACTIVE: 'Active', PAUSED: 'Paused', EXPIRED: 'Expired', ARCHIVED: 'Archived' };
const KIND_LABEL: Readonly<Record<Kind, string>> = { SCHEDULED_DCA: 'Scheduled DCA', PRICE_TRIGGER: 'Price trigger', DAILY_WATCH: 'Daily watch' };
const OCCURRENCE_LABEL: Readonly<Record<string, string>> = { PENDING_OWNER: 'Awaiting you', APPROVAL_CREATED: 'Opened for review', COMPLETED: 'Loaded into your workflow',
  DISMISSED: 'Dismissed', EXPIRED: 'Expired' };
const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  AUTOMATION_CREATED: 'Automation created', AUTOMATION_PAUSED: 'Paused', AUTOMATION_RESUMED: 'Resumed', AUTOMATION_ARCHIVED: 'Archived', AUTOMATION_EXPIRED: 'Automation expired',
  AUTOMATION_REBOUND: 'Rebound to the current workflow', TRIGGERED: 'Triggered — proposal created', WATCH_REPORTED: 'Market round reported',
  ARMED: 'Evaluated — condition not met (watching)', CONDITION_NOT_MET: 'Evaluated — condition not met', CONDITION_ALREADY_MET: 'Condition already met — waiting for a new crossing',
  CONDITION_STILL_MET: 'Condition still met — no new proposal', REARMED: 'Condition cleared — watching again', COOLDOWN: 'Crossing during the cooldown — no proposal',
  LIMIT_BLOCKED: 'Blocked by a limit — no proposal', MISSED: 'Missed while FloFi was unavailable', WORKFLOW_CHANGED: 'Saved workflow changed — rebind required',
  STRATEGY_STALE: 'No longer reproducible — rebind required', APPROVAL_REQUESTED: 'Opened for review', APPROVAL_APPLIED: 'Loaded into your workflow',
  OWNER_DISMISSED: 'Dismissed', OWNER_PREPARED_BUY: 'You started your own buy in the Editor', OWNER_PREPARED_SELL: 'You started your own sell in the Editor', DUPLICATE_TRIGGER: 'Duplicate trigger ignored',
  PRICE_STALE: 'Price observation too old — ignored', PRICE_SOURCE_OFF: 'No price source on this deployment', PRICE_SOURCE_TIMEOUT: 'Price source timed out — ignored',
  PRICE_SOURCE_UNREACHABLE: 'Price source unreachable — ignored', PRICE_SOURCE_ERROR: 'Price source error — ignored', PRICE_FEED_MISMATCH: 'Price feed failed verification — ignored',
  OCCURRENCE_EXPIRED: 'Expired', AUTOMATION_REBOUND_WITHDRAWN: 'Withdrawn by a rebind' };
const ERROR_TEXT: Readonly<Record<string, string>> = {
  WALLET_SESSION_REQUIRED: 'Verify wallet ownership to use automations.', AUTOMATIONS_NOT_ENABLED: 'Automations are not enabled on this deployment.',
  AUTOMATION_STORE_UNAVAILABLE: 'Automations are unavailable on this deployment right now.', AUTOMATION_SCHEMA_NOT_INSTALLED: 'Automations are unavailable on this deployment right now.',
  AUTOMATION_VERSION_CONFLICT: 'This automation changed in another session. Refresh and try again.', AUTOMATION_RULE_LIMIT: 'You have reached the maximum number of automations.',
  BTC_EXECUTION_ROUTE_UNAVAILABLE: 'FloFi has no BTC swap route yet. You can watch BTC and get alerts, but FloFi cannot prepare a BTC purchase.',
  OWNER_EXECUTION_NOT_IMPLEMENTED: 'FloFi cannot execute this action with your wallet yet.', MAINNET_HANDOFF_DISABLED_BY_POLICY: 'Real-funds automations are disabled on this deployment.',
  FLOW_NOT_ENABLED_IN_DEPLOYMENT: 'This action is not enabled on this deployment.', PUBLIC_RECORDING_OFF: 'This action is not enabled on this deployment.',
  LIMIT_AMOUNT_PER_EXECUTION: 'The amount is above your maximum per execution.', LIMIT_SLIPPAGE: 'The slippage is above your maximum slippage.',
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
  AUTOMATION_WALLET_NAMESPACE_MISMATCH: 'This network needs a wallet of another kind than the one you proved. Only your own wallet can approve its proposals.' };

const usd = (value: string) => { const [whole, fraction = ''] = value.split('.'); return `$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction.slice(0, 2).padEnd(2, '0')}` : ''}`; };
function changeOf(o: ObservationView): string | null {
  if (!('priceUsd' in o) || !o.previousPriceUsd) return null;
  const a = Number(o.priceUsd), b = Number(o.previousPriceUsd);
  if (!(a > 0 && b > 0)) return null;
  const pct = (a - b) / b * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
let zoneList: readonly string[] | null = null;
const zones = () => zoneList ??= (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC']; } })();

function When({ iso, zone }: { iso: string | null; zone: string }) {
  const { language } = useLocale();
  if (!iso) return <>—</>;
  let text: string;
  try { text = new Intl.DateTimeFormat(language === 'PT' ? 'pt-PT' : 'en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
  catch { text = iso; }
  return <time dateTime={iso}>{text}</time>;
}
function Observation({ o }: { o: ObservationView }) {
  const { t } = useLocale();
  if (!('priceUsd' in o)) return <span className="automation-observation">{o.asset} · {t('not observed')} ({o.code})</span>;
  const change = changeOf(o);
  return <span className="automation-observation"><strong>{o.asset}</strong> {usd(o.priceUsd)}{change && <> · {t('{0} since the last round', change)}</>} · {o.source === 'CHAINLINK' ? 'Chainlink' : t('fixture')}{o.evidence === 'MOCKED' ? ' · MOCKED' : ''}</span>;
}

function useAutomationText() {
  const { t } = useLocale();
  return useMemo(() => ({
    schedule: (r: Pick<RuleView, 'schedule' | 'timezone'>) => !r.schedule ? '' : r.schedule.frequency === 'DAILY' ? t('Every day at {0} ({1})', r.schedule.time, r.timezone)
      : t('Every {0} at {1} ({2})', t(WEEKDAYS[(r.schedule.weekday ?? 1) - 1]!), r.schedule.time, r.timezone),
    condition: (c: NonNullable<RuleView['condition']>) => c.type === 'PRICE_BELOW' ? t('If {0} falls below {1}', c.asset, usd(c.threshold!))
      : c.type === 'PRICE_ABOVE' ? t('If {0} rises above {1}', c.asset, usd(c.threshold!))
        : c.type === 'PERCENT_DROP' ? t('If {0} falls {1}% from {2} (at or below {3})', c.asset, c.percent!, usd(c.reference!), usd(c.effectiveThreshold))
          : t('If {0} rises {1}% from {2} (at or above {3})', c.asset, c.percent!, usd(c.reference!), usd(c.effectiveThreshold)),
    action: (a: RuleView['action']) => a ? t('Prepare {0} {1} → {2} on {3}', a.amount, a.inputAsset, a.outputAsset, t(a.networkLabel)) : t('Notify me only'),
    limits: (l: RuleView['limits']) => [
      l.maxAmountPerExecution ? t('Max {0} per execution', l.maxAmountPerExecution) : null,
      l.maxAmountPerPeriod ? t('Max {0} per {1}', l.maxAmountPerPeriod.amount, t(l.maxAmountPerPeriod.period.toLowerCase())) : null,
      l.maxOccurrencesPerPeriod ? t('At most {0} proposals per {1}', String(l.maxOccurrencesPerPeriod.count), t(l.maxOccurrencesPerPeriod.period.toLowerCase())) : null,
      l.cooldownMinutes ? t('Cooldown {0} min', String(l.cooldownMinutes)) : null,
      l.maxSlippageBps !== null ? t('Max slippage {0} bps', String(l.maxSlippageBps)) : null,
    ].filter((v): v is string => Boolean(v)),
    error: (code: string) => ERROR_TEXT[code] ? t(ERROR_TEXT[code]) : DELEGATION_ERROR_TEXT[code] ? t(DELEGATION_ERROR_TEXT[code]) : t('FloFi could not complete this ({0}).', code),
  }), [t]);
}

// ── Pending decisions ────────────────────────────────────────────────────────────────────────────────────────────────────────
function PendingCard({ o, rule, highlighted, capabilities, busy, run, onPropose, owner }: { o: OccurrenceView; rule: RuleView | undefined; highlighted: boolean;
  capabilities: CapabilityView; busy: boolean; run: (work: () => Promise<{ ok: boolean; code?: string }>, done?: string) => Promise<boolean>; onPropose: (command: Command) => void;
  owner: WorkflowOwner }) {
  const { t } = useLocale(), text = useAutomationText();
  const [trade, setTrade] = useState<{ asset: Asset; side: 'BUY' | 'SELL'; network: string; amount: string } | null>(null);
  const zone = rule?.timezone ?? 'UTC';
  async function review() {
    await run(async () => {
      const opened = await openAutomationOccurrence(owner, o.occurrenceId);
      if (opened.ok) window.location.assign(opened.value.approvalUrl);
      return opened;
    });
  }
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (!trade) return;
    await run(async () => {
      const prepared = await prepareWatchProposal(owner, o.occurrenceId, { ...trade, slippageBps: DEFAULT_SLIPPAGE_BPS });
      if (prepared.ok) onPropose(prepared.value.command);
      return prepared;
    }, 'Your own trade is in the Editor. Apply it, simulate and review before signing.');
  }
  const routes = (asset: string) => capabilities.routes.filter(r => r.asset === asset && r.executable);
  return <article className="automation-card automation-pending" id={`occurrence-${o.occurrenceId}`} data-highlighted={highlighted ? 'true' : undefined}
    aria-label={t('Proposal from {0}', o.ruleName)}>
    <header className="automation-card-head"><div><h3>{o.ruleName}</h3><p>{t(o.kind === 'WATCH' ? 'Daily watch' : o.kind === 'PRICE' ? 'Price trigger' : 'Scheduled DCA')} · {t(OCCURRENCE_LABEL[o.state] ?? o.state)}</p></div>
      <span className="automation-badge" data-state={o.state}>{t(OCCURRENCE_LABEL[o.state] ?? o.state)}</span></header>
    {o.kind === 'SCHEDULE' && <p>{t('Scheduled for')} <When iso={o.dueAt} zone={zone}/></p>}
    {o.observations.length > 0 && o.kind === 'PRICE' && rule?.condition && <p>{text.condition(rule.condition)} — {t('met')}: <Observation o={o.observations[0]!}/></p>}
    {o.kind === 'WATCH' ? <ul className="automation-watch">{o.observations.map(obs => <li key={obs.asset}><Observation o={obs}/>
      {'priceUsd' in obs && routes(obs.asset).length > 0 ? <span className="automation-row-actions">
        <button type="button" className="workspace-action" disabled={busy} onClick={() => setTrade({ asset: obs.asset as Asset, side: 'BUY', network: routes(obs.asset)[0]!.network, amount: '' })}>{t('Buy')}</button>
        <button type="button" className="workspace-action" disabled={busy} onClick={() => setTrade({ asset: obs.asset as Asset, side: 'SELL', network: routes(obs.asset)[0]!.network, amount: '' })}>{t('Sell')}</button></span>
        : 'priceUsd' in obs ? <span className="muted">{t(obs.asset === 'BTC' ? 'No BTC swap route in FloFi yet' : 'Not executable on this deployment')}</span> : null}</li>)}</ul>
      : <p className="automation-action-line"><strong>{text.action(o.action)}</strong>{o.action?.fundsClass === 'REAL_FUNDS' && <> · {t('REAL FUNDS')}</>}</p>}
    {trade && <form className="automation-inline-form" aria-label={`${t(trade.side === 'BUY' ? 'Buy' : 'Sell')} ${trade.asset}`} onSubmit={event => void prepare(event)}>
      <label>{t('Network')}<select aria-label={t('Network')} value={trade.network} onChange={e => setTrade({ ...trade, network: e.currentTarget.value })}>
        {routes(trade.asset).map(r => <option key={r.network} value={r.network}>{t(r.networkLabel)}</option>)}</select></label>
      <label>{t('Amount ({0})', trade.side === 'BUY' ? routes(trade.asset).find(r => r.network === trade.network)?.quote ?? '' : routes(trade.asset).find(r => r.network === trade.network)?.base ?? '')}
        <input inputMode="decimal" aria-label={t('Amount')} value={trade.amount} onChange={e => setTrade({ ...trade, amount: e.currentTarget.value.trim() })} required/></label>
      <div className="automation-row-actions"><button type="submit" className="workspace-action" disabled={busy}>{t('Prepare in the Editor')}</button>
        <button type="button" className="workspace-action" onClick={() => setTrade(null)}>{t('Cancel')}</button></div>
      <p className="muted">{t('This is your own new trade, not part of this automation: it goes to your Editor draft as an ordinary proposal, exactly as if you had composed it there. The automation adds no authority and no limits to it. Nothing is signed: apply it, simulate and review the Strategy Manifest first.')}</p>
    </form>}
    <p className="muted">{t('Waiting until')} <When iso={o.expiresAt} zone={zone}/>{o.notifications.map(n => <span key={n.channel}> · {t('Telegram')}: {t(n.status === 'QUEUED' ? 'sent to your chat' : 'not delivered')}</span>)}</p>
    <div className="automation-row-actions">
      {o.action && <button type="button" className="workspace-action primary-action" disabled={busy} onClick={() => void review()}>{t('Review in FloFi')}</button>}
      <button type="button" className="workspace-action" disabled={busy} onClick={() => void run(() => dismissAutomationOccurrence(owner, o.occurrenceId), 'Proposal dismissed.')}>
        {t(o.kind === 'WATCH' ? 'Ignore' : o.action ? 'Dismiss' : 'Acknowledge')}</button>
    </div>
    {o.action && <p className="muted automation-authority">{t('Nothing is authorized yet. Review opens FloFi’s approval: prove your wallet, run a fresh simulation, review the Strategy Manifest and sign with your own wallet.')}</p>}
  </article>;
}

// ── Rules ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function RuleCard({ rule, busy, run, owner, onHistory }: { rule: RuleView; busy: boolean; run: (work: () => Promise<{ ok: boolean; code?: string }>, done?: string) => Promise<boolean>;
  owner: WorkflowOwner; onHistory: () => void }) {
  const { t } = useLocale(), text = useAutomationText();
  const state = (action: 'PAUSE' | 'RESUME' | 'ARCHIVE', done: string) => void run(() => changeAutomationState(owner, rule.ruleId, rule.version, action), done);
  return <article className="automation-card automation-record" aria-label={t('Automation {0}', rule.name)}>
    <header className="automation-card-head"><div><h3>{rule.name}</h3><p>{t(KIND_LABEL[rule.kind])} · {t(rule.executionMode === 'DELEGATED_WITH_LIMITS' ? 'Automatic within limits' : 'Ask me before every execution')}</p></div>
      <span className="automation-badge" data-state={rule.state}>{t(STATE_LABEL[rule.state] ?? rule.state)}</span></header>
    <div className="automation-record-summary"><p>{rule.action ? text.action(rule.action) : rule.watch ? rule.watch.assets.join(' / ') : t('Notify me only')}</p><span>{t('Next evaluation')}: <When iso={rule.nextEvaluationAt} zone={rule.timezone}/></span>{rule.pending > 0 && <span className="automation-badge">{t('{0} pending proposal(s)', String(rule.pending))}</span>}</div>
    <details className="automation-record-details"><summary>{t('Details and management')}</summary>
    <dl className="automation-facts">
      {rule.schedule && <div><dt>{t('When')}</dt><dd>{text.schedule(rule)}</dd></div>}
      {rule.condition && <div><dt>{t('Condition')}</dt><dd>{text.condition(rule.condition)} · {t('checked every {0} min', String(rule.condition.checkEveryMinutes))}</dd></div>}
      {rule.watch && <div><dt>{t('Assets')}</dt><dd>{rule.watch.assets.join(' / ')} · {t('Notify me')}</dd></div>}
      {rule.kind !== 'DAILY_WATCH' && <div><dt>{t('Action')}</dt><dd>{rule.executionMode === 'DELEGATED_WITH_LIMITS' && !rule.action ? t('Multi-step workflow (see Automatic within limits)') : text.action(rule.action)}{rule.source && <> · {t('from saved workflow (version {0})', String(rule.source.version))}</>}</dd></div>}
      {rule.kind !== 'DAILY_WATCH' && text.limits(rule.limits).length > 0 && <div><dt>{t('Limits')}</dt><dd>{text.limits(rule.limits).join(' · ')}</dd></div>}
      <div><dt>{t('Next evaluation')}</dt><dd><When iso={rule.nextEvaluationAt} zone={rule.timezone}/></dd></div>
      {rule.lastObservation && <div><dt>{t('Last observation')}</dt><dd><Observation o={rule.lastObservation}/></dd></div>}
      {rule.lastOutcome && <div><dt>{t('Last evaluation')}</dt><dd>{t(OUTCOME_LABEL[rule.lastOutcome] ?? rule.lastOutcome)}</dd></div>}
      {rule.pending > 0 && <div><dt>{t('Waiting for you')}</dt><dd>{t('{0} pending proposal(s)', String(rule.pending))}</dd></div>}
      {rule.expiresAt && <div><dt>{t('Expires')}</dt><dd><When iso={rule.expiresAt} zone={rule.timezone}/></dd></div>}
    </dl>
    {rule.attention && <p className="automation-attention" role="status">{t(rule.attention === 'WORKFLOW_CHANGED' ? 'The saved workflow changed after this automation was created. FloFi proposes nothing until you rebind it to the current version.'
      : 'This action no longer reproduces with FloFi’s current engine. FloFi proposes nothing until you rebind it.')}
      {rule.executionMode === 'DELEGATED_WITH_LIMITS' ? <> {t('Re-authorize it under Automatic within limits.')}</>
        : <button type="button" className="workspace-action" disabled={busy} onClick={() => void run(() => rebindAutomation(owner, rule.ruleId, rule.version), 'Automation rebound.')}>{t('Rebind')}</button>}</p>}
    <div className="automation-row-actions">
      {rule.state === 'ACTIVE' && <button type="button" className="workspace-action" disabled={busy} onClick={() => state('PAUSE', 'Automation paused.')}>{t('Pause')}</button>}
      {rule.state === 'PAUSED' && <button type="button" className="workspace-action" disabled={busy} onClick={() => state('RESUME', 'Automation resumed.')}>{t('Resume')}</button>}
      {rule.state !== 'ARCHIVED' && <button type="button" className="workspace-action" disabled={busy} onClick={() => state('ARCHIVE', 'Automation archived.')}>{t('Archive')}</button>}
      <button type="button" className="workspace-action" onClick={onHistory}>{t('History')}</button>
    </div></details>
  </article>;
}

export function HistoryPanel({ history, onClose }: { history: RuleHistoryView; onClose: () => void }) {
  const { t } = useLocale();
  const zone = history.rule.timezone;
  return <section className="workspace-section automation-history" aria-label={t('History of {0}', history.rule.name)}>
    <div className="workspace-section-heading"><div><h2>{t('History of {0}', history.rule.name)}</h2></div>
      <button type="button" className="workspace-action" onClick={onClose}>{t('Close')}</button></div>
    <p className="muted">{t('Evaluations and proposals are not transaction evidence. Executions, reconciliation and evidence are in your runs.')}</p>
    <h3>{t('Proposals')}</h3>
    {history.occurrences.length ? <ul className="automation-history-list">{history.occurrences.map(o => <li key={o.occurrenceId}>
      <When iso={o.dueAt} zone={zone}/> · {t(OCCURRENCE_LABEL[o.state] ?? o.state)}{o.outcome && OUTCOME_LABEL[o.outcome] && o.outcome !== 'APPROVAL_APPLIED' ? <> · {t(OUTCOME_LABEL[o.outcome])}</> : null}
      {o.approval?.status === 'APPLIED' && o.approval.runsComplete === false && <> · {t('Run status could not be read now — not evidence that nothing was sent')}</>}
      {o.approval?.status === 'APPLIED' && o.approval.runsComplete !== false && o.approval.runs.length === 0 && <> · {t(o.approval.runsTruncated
        ? 'No run of this proposal among this wallet\'s recent runs — older runs were not checked' : 'No run of this exact proposal recorded yet')}</>}
      {o.approval?.runs.map(r => <span key={r.executionId}> · {t(automationRunLabel(r))}
        {r.evidenceEnvironment && <> ({t('evidence')}: {r.evidenceEnvironment})</>} · <a href={`/app/dashboard/runs/${encodeURIComponent(r.executionId)}`}>{t('Open run')}</a></span>)}
    </li>)}</ul> : <p className="muted">{t('No proposals yet.')}</p>}
    <h3>{t('Evaluations')}</h3>
    <ul className="automation-history-list">{history.entries.map((e: HistoryEntryView, i) => <li key={`${e.at}-${i}`}><When iso={e.at} zone={zone}/> · {t(OUTCOME_LABEL[e.outcome] ?? e.outcome)}
      {e.observation && <> · <Observation o={e.observation}/></>}{e.outcome === 'MISSED' && typeof e.detail?.count === 'number' ? <> · {t('{0} slot(s)', String(e.detail.count))}</> : null}
      {e.outcome === 'LIMIT_BLOCKED' && typeof e.detail?.code === 'string' ? <> · {t(ERROR_TEXT[e.detail.code] ?? e.detail.code)}</> : null}</li>)}</ul>
  </section>;
}

// ── Create ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Draft = { kind: Kind; name: string; source: 'ROUTE' | 'NONE'; side: 'BUY' | 'SELL'; asset: Asset; network: string; amount: string;
  slippageBps: string; frequency: 'DAILY' | 'WEEKLY'; weekday: string; time: string; timezone: string; condition: 'PRICE_BELOW' | 'PRICE_ABOVE' | 'PERCENT_DROP' | 'PERCENT_RISE';
  threshold: string; reference: string; percent: string; every: string; maxPerExecution: string; periodAmount: string; periodAmountPeriod: string; periodCount: string;
  periodCountPeriod: string; cooldown: string; maxSlippage: string; expires: string; watch: Asset[] };
const initialDraft = (): Draft => ({ kind: 'SCHEDULED_DCA', name: '', source: 'ROUTE', side: 'BUY', asset: 'ETH', network: '', amount: '', slippageBps: DEFAULT_SLIPPAGE,
  frequency: 'WEEKLY', weekday: '1', time: '09:00', timezone: browserZone(), condition: 'PRICE_BELOW', threshold: '', reference: '', percent: '', every: '15', maxPerExecution: '',
  periodAmount: '', periodAmountPeriod: 'WEEK', periodCount: '', periodCountPeriod: 'DAY', cooldown: '0', maxSlippage: '', expires: '', watch: ['BTC', 'ETH', 'SOL'] });
function inputOf(d: Draft): AutomationInput {
  const limits = { maxAmountPerExecution: d.maxPerExecution || (d.source === 'ROUTE' && d.amount ? d.amount : null),
    maxAmountPerPeriod: d.periodAmount ? { amount: d.periodAmount, period: d.periodAmountPeriod as 'DAY' | 'WEEK' | 'MONTH' } : null,
    maxOccurrencesPerPeriod: d.periodCount ? { count: Number(d.periodCount), period: d.periodCountPeriod as 'DAY' | 'WEEK' | 'MONTH' } : null, cooldownMinutes: Number(d.cooldown || '0'),
    maxSlippageBps: d.maxSlippage ? Number(d.maxSlippage) : null };
  const action: ActionRequest | null = d.source === 'NONE' ? null
    : { kind: 'ROUTE', asset: d.asset, side: d.side, network: d.network as Extract<ActionRequest, { kind: 'ROUTE' }>['network'], amount: d.amount, slippageBps: Number(d.slippageBps) };
  const schedule = { frequency: d.frequency, weekday: d.frequency === 'WEEKLY' ? Number(d.weekday) : null, time: d.time, timezone: d.timezone };
  const expiresAt = d.expires ? new Date(`${d.expires}T00:00:00Z`).toISOString().replace('.000Z', 'Z') : null;
  if (d.kind === 'DAILY_WATCH') return { version: 1, kind: d.kind, name: d.name, schedule, watch: { assets: d.watch }, expiresAt };
  if (d.kind === 'SCHEDULED_DCA') {
    if (!action) throw new Error('AUTOMATION_INPUT_INVALID');
    return { version: 1, kind: d.kind, name: d.name, schedule, action, limits, expiresAt };
  }
  const condition: Extract<AutomationInput, { kind: 'PRICE_TRIGGER' }>['condition'] = d.condition === 'PRICE_BELOW' || d.condition === 'PRICE_ABOVE' ? { type: d.condition, asset: d.asset, threshold: d.threshold, checkEveryMinutes: Number(d.every) }
    : { type: d.condition, asset: d.asset, reference: d.reference, percent: d.percent, checkEveryMinutes: Number(d.every) };
  return { version: 1, kind: d.kind, name: d.name, timezone: d.timezone, condition, action, limits, expiresAt };
}

export function CreateForm({ capabilities, owner, busy, run, initial, onCreated, initialStep = 1, onDraftChange, onStepChange }: { capabilities: CapabilityView; owner: WorkflowOwner; busy: boolean;
  run: (work: () => Promise<{ ok: boolean; code?: string }>, done?: string) => Promise<boolean>; initial?: Partial<Draft>; onCreated?: () => void; initialStep?: number; onDraftChange?: (draft: Draft) => void; onStepChange?: (step: number) => void }) {
  const { t } = useLocale(), text = useAutomationText();
  const [d, setD] = useState<Draft>(() => {
    const base = { ...initialDraft(), ...initial };
    return { ...base, watch: base.watch.filter(a => capabilities.observable.includes(a)),
      asset: initial?.asset ?? (base.kind === 'SCHEDULED_DCA' ? capabilities.routes.find(r => r.executable)?.asset : capabilities.observable[0]) ?? base.asset };
  });
  const [step, setStep] = useState(initialStep), [issue, setIssue] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const move = (next: number) => { setStep(next); onStepChange?.(next); setIssue(null); requestAnimationFrame(() => heading.current?.focus()); };
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => { const next = { ...d, [key]: value }; setD(next); onDraftChange?.(next); setIssue(null); };

  const routes = useMemo(() => capabilities.routes.filter(r => r.asset === d.asset), [capabilities, d.asset]);
  const route: RouteCapability | undefined = routes.find(r => r.network === d.network);
  useEffect(() => {
    if (!routes.some(r => r.network === d.network) && routes[0]) setD(prev => ({ ...prev, network: (routes.find(r => r.executable) ?? routes[0]!).network }));
  }, [d.network, routes]);
  const actionIssue = d.kind !== 'DAILY_WATCH' && d.source === 'ROUTE' && (!route || !route.executable);
  const summary = d.kind === 'PRICE_TRIGGER'
    ? `${d.asset} · ${t(d.condition === 'PRICE_BELOW' ? 'Price falls below' : d.condition === 'PRICE_ABOVE' ? 'Price rises above' : d.condition === 'PERCENT_DROP' ? 'Price falls by a percentage' : 'Price rises by a percentage')} ${d.condition.startsWith('PERCENT') ? `${d.percent}% · $${d.reference}` : `$${d.threshold}`} · ${t('checked every {0} min', d.every)} (${d.timezone})`
    : d.frequency === 'DAILY' ? t('Every day at {0} ({1})', d.time, d.timezone) : t('Every {0} at {1} ({2})', t(WEEKDAYS[Number(d.weekday) - 1]!), d.time, d.timezone);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === 1) { if (!actionIssue && (d.kind !== 'DAILY_WATCH' || d.watch.length)) move(2); return; }
    let input: AutomationInput;
    try { input = inputOf(d); } catch { setIssue('AUTOMATION_EXPIRY_INVALID'); return; }
    const valid = validateAutomationInput(input, Date.now());
    if (!valid.ok) { setIssue(valid.code); return; }
    const boundAction = valid.value.action;
    if (boundAction?.kind === 'ROUTE') {
      const limitIssue = bindingViolation(valid.value.definition.limits, { asset: d.side === 'BUY' ? route?.quote ?? '' : route?.base ?? '', amount: boundAction.amount }, boundAction.slippageBps);
      if (limitIssue) { setIssue(limitIssue); return; }
    }
    const blocked = automationCapabilityIssue(input, capabilities);
    if (blocked) { setIssue(blocked); return; }
    if (step === 2) { move(3); return; }
    if (await run(() => createAutomation(owner, input), 'Automation created. FloFi will ask you before every execution.')) onCreated?.();
  }
  const named = (control: ReactNode, label: string) => isValidElement<{ 'aria-label'?: string }>(control) && (control.type === 'input' || control.type === 'select') ? cloneElement(control, { 'aria-label': label }) : control;
  const field = (label: string, control: ReactNode, wide = false) => <label className={wide ? 'automation-field automation-field-wide' : 'automation-field'}>{label}{named(control, label)}</label>;
  const periodSelect = (value: string, onChange: (v: string) => void, label: string) => <select aria-label={t(label)} value={value} onChange={e => onChange(e.currentTarget.value)}>{['DAY', 'WEEK', 'MONTH'].map(p => <option key={p} value={p}>{t(p.toLowerCase())}</option>)}</select>;
  return <form className="automation-form automation-guided" aria-label={t('Create an automation')} onSubmit={event => void submit(event)}>
    <ol className="automation-stepper" aria-label={t('Creation steps')}>{['What', 'When', 'Review'].map((label, i) => <li key={label} aria-current={step === i + 1 ? 'step' : undefined}><span>{i + 1}</span>{t(label)}</li>)}</ol>
    <h3 ref={heading} tabIndex={-1}>{t(step === 1 ? 'What do you want to do?' : step === 2 ? 'When should it happen?' : 'Review and authorize')}</h3>
    {step === 1 && <>
      <p className="muted">{t(KIND_LABEL[d.kind])}</p>
      <div className="automation-grid">
        {field(t('Name'), <input value={d.name} maxLength={80} onChange={e => set('name', e.currentTarget.value)} required/>, true)}
        {d.kind === 'DAILY_WATCH' ? <fieldset className="automation-assets automation-field-wide"><legend>{t('Assets to check')}</legend>{(['BTC', 'ETH', 'SOL'] as const).map(a => <label key={a}><input type="checkbox" checked={d.watch.includes(a)} disabled={!capabilities.observable.includes(a)} onChange={e => set('watch', e.currentTarget.checked ? [...d.watch, a] : d.watch.filter(x => x !== a))}/>{a}</label>)}</fieldset> : <>
          {field(t(d.kind === 'PRICE_TRIGGER' ? 'Watched asset' : 'Asset'), <select value={d.asset} onChange={e => set('asset', e.currentTarget.value as Asset)}>{(['ETH', 'SOL', 'BTC'] as const).map(a => <option key={a} value={a} disabled={d.kind === 'PRICE_TRIGGER' && !capabilities.observable.includes(a)}>{a}</option>)}</select>)}
          {field(t('Prepare'), <select value={d.source} onChange={e => set('source', e.currentTarget.value as Draft['source'])}><option value="ROUTE">{t('A buy or a sell')}</option>{d.kind === 'PRICE_TRIGGER' && <option value="NONE">{t('Nothing — notify me only')}</option>}</select>)}

          {d.source === 'ROUTE' && <>
            {field(t('Side'), <select value={d.side} onChange={e => set('side', e.currentTarget.value as Draft['side'])}><option value="BUY">{t('Buy')}</option><option value="SELL">{t('Sell')}</option></select>)}
            {field(t('Network'), <select value={d.network} onChange={e => set('network', e.currentTarget.value)} disabled={!routes.length}>{routes.map(r => <option key={r.network} value={r.network} disabled={!r.executable}>{t(r.networkLabel)}{r.executable ? '' : ` — ${t('not available here')}`}</option>)}</select>)}
            {field(route ? t('Amount ({0})', d.side === 'BUY' ? route.quote : route.base) : t('Amount'), <input inputMode="decimal" value={d.amount} onChange={e => set('amount', e.currentTarget.value.trim())} required/>)}
          </>}
        </>}
      </div>
      {actionIssue && <p role="status">{text.error(d.asset === 'BTC' ? 'BTC_EXECUTION_ROUTE_UNAVAILABLE' : route?.reason ?? 'OWNER_EXECUTION_NOT_IMPLEMENTED')}</p>}
    </>}
    {step === 2 && <><div className="automation-grid">
      {d.kind !== 'PRICE_TRIGGER' ? <>
        {field(t('Repeat'), <select value={d.frequency} onChange={e => set('frequency', e.currentTarget.value as Draft['frequency'])}><option value="DAILY">{t('Every day')}</option><option value="WEEKLY">{t('Every week')}</option></select>)}
        {d.frequency === 'WEEKLY' && field(t('Day'), <select value={d.weekday} onChange={e => set('weekday', e.currentTarget.value)}>{WEEKDAYS.map((w, i) => <option key={w} value={String(i + 1)}>{t(w)}</option>)}</select>)}
        {field(t('Time'), <input type="time" value={d.time} onChange={e => set('time', e.currentTarget.value)} required/>)}
      </> : <>
        {field(t('Condition'), <select value={d.condition} onChange={e => set('condition', e.currentTarget.value as Draft['condition'])}><option value="PRICE_BELOW">{t('Price falls below')}</option><option value="PRICE_ABOVE">{t('Price rises above')}</option><option value="PERCENT_DROP">{t('Price falls by a percentage')}</option><option value="PERCENT_RISE">{t('Price rises by a percentage')}</option></select>)}
        {d.condition === 'PRICE_BELOW' || d.condition === 'PRICE_ABOVE' ? field(t('Threshold (USD)'), <input inputMode="decimal" value={d.threshold} onChange={e => set('threshold', e.currentTarget.value.trim())} required/>) : <>{field(t('Reference price (USD)'), <input inputMode="decimal" value={d.reference} onChange={e => set('reference', e.currentTarget.value.trim())} required/>)}{field(t('Percentage'), <input inputMode="decimal" value={d.percent} onChange={e => set('percent', e.currentTarget.value.trim())} required/>)}</>}
        {field(t('Check every'), <select value={d.every} onChange={e => set('every', e.currentTarget.value)}>{['5', '15', '30', '60', '240', '1440'].map(m => <option key={m} value={m}>{t('{0} minutes', m)}</option>)}</select>)}
      </>}
      {field(t('Time zone'), <><input list="automation-zones" aria-label={t('Time zone')} value={d.timezone} onChange={e => set('timezone', e.currentTarget.value.trim())} required/><datalist id="automation-zones">{zones().map(z => <option key={z} value={z}/>)}</datalist></>)}
    </div>
    <details className="automation-advanced"><summary>{t('Advanced settings')}</summary><div className="automation-grid">
      {d.kind !== 'DAILY_WATCH' && <>
        {d.source === 'ROUTE' && field(t('Slippage (bps)'), <input inputMode="numeric" value={d.slippageBps} onChange={e => set('slippageBps', e.currentTarget.value.trim())} required/>)}
        {field(t('Max per execution'), <input inputMode="decimal" value={d.maxPerExecution} placeholder={d.amount} onChange={e => set('maxPerExecution', e.currentTarget.value.trim())}/>)}
        {field(t('Max amount per period'), <span className="automation-pair"><input inputMode="decimal" aria-label={t('Max amount per period')} value={d.periodAmount} onChange={e => set('periodAmount', e.currentTarget.value.trim())}/>{periodSelect(d.periodAmountPeriod, v => set('periodAmountPeriod', v), 'Amount period')}</span>)}
        {field(t('Max proposals per period'), <span className="automation-pair"><input inputMode="numeric" aria-label={t('Max proposals per period')} value={d.periodCount} onChange={e => set('periodCount', e.currentTarget.value.trim())}/>{periodSelect(d.periodCountPeriod, v => set('periodCountPeriod', v), 'Proposal period')}</span>)}
        {field(t('Cooldown (minutes)'), <input inputMode="numeric" value={d.cooldown} onChange={e => set('cooldown', e.currentTarget.value.trim())}/>)}
        {field(t('Max slippage (bps)'), <input inputMode="numeric" value={d.maxSlippage} onChange={e => set('maxSlippage', e.currentTarget.value.trim())}/>)}
      </>}
      {field(t('Expires on'), <input type="date" value={d.expires} onChange={e => set('expires', e.currentTarget.value)}/>)}
    </div></details></>}
    {step >= 2 && <div className="automation-review-summary"><strong>{d.name}</strong><p>{summary}</p>
      <p>{d.kind === 'DAILY_WATCH' ? `${t('Assets')}: ${d.watch.join(', ')} · ${t('Notify me only')}` : d.source === 'NONE' ? t('Notify me only') : t('Prepare {0} {1} → {2} on {3}', d.amount, d.side === 'BUY' ? route?.quote ?? '' : route?.base ?? '', d.side === 'BUY' ? route?.base ?? '' : route?.quote ?? '', t(route?.networkLabel ?? d.network))}</p>
    </div>}
    {step === 3 && <>
      <p className="automation-execution"><strong>{t('Execution')}:</strong> {t('Ask me before every execution')}</p>
      <p>{t('Limits bound what FloFi proposes. They are not on-chain spending limits: every execution still needs your review and your wallet signature.')}</p>
      <dl className="automation-facts">
        {d.kind !== 'DAILY_WATCH' && <>
          <div><dt>{t('Max per execution')}</dt><dd>{d.maxPerExecution || (d.source === 'ROUTE' ? d.amount : t('Not set'))}</dd></div>
          <div><dt>{t('Max amount per period')}</dt><dd>{d.periodAmount ? `${d.periodAmount} / ${t(d.periodAmountPeriod.toLowerCase())}` : t('Not set')}</dd></div>
          <div><dt>{t('Max proposals per period')}</dt><dd>{d.periodCount ? `${d.periodCount} / ${t(d.periodCountPeriod.toLowerCase())}` : t('Not set')}</dd></div>
          <div><dt>{t('Cooldown (minutes)')}</dt><dd>{d.cooldown || '0'}</dd></div>
          {d.source === 'ROUTE' && <div><dt>{t('Slippage (bps)')}</dt><dd>{d.slippageBps}</dd></div>}
          <div><dt>{t('Max slippage (bps)')}</dt><dd>{d.maxSlippage || t('Not set')}</dd></div>
        </>}
        <div><dt>{t('Expires on')}</dt><dd>{d.expires ? `${d.expires} UTC` : t('No expiration')}</dd></div>
      </dl>
      <p className="muted">{t('Creation saves the automation. Proposals still require a fresh simulation, manifest review and your wallet authorization.')}</p>
    </>}
    {issue && <p role="alert">{ERROR_TEXT[issue] ? text.error(issue) : t(issue)}</p>}
    <div className="automation-row-actions">{step > 1 && <button type="button" className="workspace-action" disabled={busy} onClick={() => move(step - 1)}>{t('Back')}</button>}<button type="submit" className="workspace-action primary-action" disabled={busy || Boolean(actionIssue) || (d.kind === 'DAILY_WATCH' && !d.watch.length)}>{t(busy ? 'Creating automation…' : step === 3 ? 'Create automation' : 'Continue')}</button></div>
  </form>;
}

// ── Notifications ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function Notifications({ overview, owner, busy, run }: { overview: OverviewView; owner: WorkflowOwner; busy: boolean; run: (work: () => Promise<{ ok: boolean; code?: string }>, done?: string) => Promise<boolean> }) {
  const { t } = useLocale();
  const [code, setCode] = useState<LinkCodeView | null>(null);
  return <section className="workspace-section" aria-labelledby="automation-notifications">
    <div className="workspace-section-heading"><div><h2 id="automation-notifications">{t('Notifications')}</h2></div></div>
    <div className="automation-card">
      <p><strong>{t('In FloFi')}:</strong> {t('always on — proposals wait for you in this workspace.')}</p>
      {!overview.telegram.available ? <p><strong>{t('Telegram')}:</strong> {t('not available on this deployment.')}</p>
        : overview.telegram.linked ? <p><strong>{t('Telegram')}:</strong> {t('linked to your chat until')} <When iso={overview.telegram.linked.expiresAt} zone={browserZone()}/>
          {' '}<button type="button" className="workspace-action" disabled={busy} onClick={() => void run(() => unlinkTelegram(owner), 'Telegram unlinked.')}>{t('Unlink')}</button></p>
          : <><p><strong>{t('Telegram')}:</strong> {t('not linked.')} <button type="button" className="workspace-action" disabled={busy}
            onClick={() => void run(async () => { const r = await createTelegramLinkCode(owner); if (r.ok) setCode(r.value); return r; })}>{t('Connect Telegram')}</button></p>
            {code && <p role="status">{t('Send this message to the FloFi bot within 10 minutes:')} <code>{code.command}</code></p>}</>}
      <p className="muted">{t('A notification never authorizes anything. It only brings you back here, where your own wallet decides.')}</p>
    </div>
  </section>;
}

// ── Workspace ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The shell builds a new owner object on every render: effects key on the owner's identity, never on the object. */
function useStableOwner(owner: WorkflowOwner | null | undefined): WorkflowOwner | null {
  const key = owner ? `${owner.namespace}:${owner.address}` : null;
  return useMemo(() => owner ? { namespace: owner.namespace, address: owner.address } : null, [key]);
}

export function AutomationsWorkspace({ owner: ownerProp, proof, onPropose, openChat, canvas = null }: Partial<AutomationNavigation>) {
  const { t } = useLocale(), text = useAutomationText();
  const owner = useStableOwner(ownerProp);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<{ owner: string; value: OverviewView } | null>(null);
  const [access, setAccess] = useState<{ owner: string; required: boolean } | null>(null);
  const [creating, setCreating] = useState<Kind | null>(null);
  const [creationDraft, setCreationDraft] = useState<Partial<Draft>>({}), [creationStep, setCreationStep] = useState(1);
  const generation = useRef(0), refreshSequence = useRef(0), operationLock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<RuleHistoryView | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [mode, setMode] = useState<'CONFIRM' | 'DELEGATED'>('CONFIRM');
  const [review, setReview] = useState<ReviewView | null>(null);
  const proven = Boolean(owner && proof?.proven === owner.address);
  const delegation = useDelegation(enabled ? owner : null, proven);
  const refreshDelegation = delegation.refresh;
  const ownerKey = owner ? `${owner.namespace}:${owner.address}` : null;
  const overview = snapshot?.owner === ownerKey ? snapshot?.value : null;
  const verificationRequired = access?.owner === ownerKey && access.required;
  useEffect(() => { void automationsAvailability().then(a => setEnabled(a.enabled)).catch(() => setEnabled(false)); }, []);
  useEffect(() => { try { setHighlight(new URLSearchParams(window.location.search).get('occurrence')); } catch { /* no query */ } }, []);
  const refresh = useCallback(async () => {
    if (!owner) return;
    const request = generation.current, sequence = ++refreshSequence.current, key = `${owner.namespace}:${owner.address}`;
    const result = await automationOverview(owner).catch(() => ({ ok: false as const, code: 'AUTOMATION_UNAVAILABLE' }));
    if (request !== generation.current || sequence !== refreshSequence.current) return;
    if (result.ok) { setSnapshot({ owner: key, value: result.value }); setAccess({ owner: key, required: false }); setError(null); }
    else { if (result.code === 'WALLET_SESSION_REQUIRED') setSnapshot(null); setAccess({ owner: key, required: result.code === 'WALLET_SESSION_REQUIRED' }); if (result.code !== 'WALLET_SESSION_REQUIRED') setError(result.code); }
  }, [owner]);
  useEffect(() => {
    generation.current++; setSnapshot(null); setAccess(null); setHistory(null); setCreating(null); setCreationDraft({}); setCreationStep(1); setReview(null); setMode('CONFIRM'); setError(null); setNotice('');
    if (enabled && owner) void refresh();
    return () => { generation.current++; };
  }, [enabled, ownerKey, refresh]);
  useEffect(() => { if (enabled && owner && proof?.proven) void refresh(); }, [enabled, owner, proof?.proven, refresh]);
  useEffect(() => {
    if (!enabled || !owner) return;
    const timer = setInterval(() => { void refresh(); }, 30_000);
    const focused = () => { void refresh(); };
    window.addEventListener('focus', focused);
    return () => { clearInterval(timer); window.removeEventListener('focus', focused); };
  }, [enabled, owner, refresh]);
  const run = useCallback(async (work: () => Promise<{ ok: boolean; code?: string }>, done?: string) => {
    if (operationLock.current) return false;
    operationLock.current = true;
    setBusy(true); setNotice(''); setError(null);
    try {
      const request = generation.current;
      const result = await work();
      if (request !== generation.current) return false;
      if (!result.ok) { setError(result.code ?? 'AUTOMATION_UNAVAILABLE'); if (result.code === 'WALLET_SESSION_REQUIRED' && ownerKey) { setSnapshot(null); setAccess({ owner: ownerKey, required: true }); } return false; }
      if (done) setNotice(done);
      await refresh();
      await refreshDelegation();
      return true;
    } catch { setError('AUTOMATION_UNAVAILABLE'); return false; } finally { operationLock.current = false; setBusy(false); }
  }, [ownerKey, refresh, refreshDelegation]);
  const loadHistory = async (ruleId: string) => {
    if (!owner) return;
    const request = generation.current;
    const result = await automationHistory(owner, ruleId).catch(() => ({ ok: false as const, code: 'AUTOMATION_UNAVAILABLE' }));
    if (request !== generation.current) return;
    if (result.ok) setHistory(result.value); else setError(result.code);
  };
  const delegationReady = delegation.overview?.availability.enabled === true;
  const delegationBlocked = delegation.overview?.availability.executor ?? delegation.code;
  const rules = overview?.rules ?? [], byId = new Map(rules.map(r => [r.ruleId, r]));
  const live = rules.filter(r => r.state !== 'ARCHIVED'), archived = rules.filter(r => r.state === 'ARCHIVED');
  return <section className="automations" aria-label={t('Automations')}>
    <header className="secondary-workspace-heading"><h1>{t('Automations')}</h1>
      <p>{t('Build a routine, watch prices and review opportunities on your terms.')}</p>{overview && owner && <span className="automation-session">{t('Wallet session verified')} · <code>{owner.address.slice(0, 6)}…{owner.address.slice(-4)}</code></span>}</header>
    <p className="workspace-notice" role="status">{t(notice)}</p>
    {error && <div className="automation-read-error" role="alert"><p>{text.error(error)}</p><button type="button" className="workspace-action" onClick={() => void refresh()}>{t('Retry')}</button></div>}
    {enabled === null ? <p role="status">{t('Loading automations…')}</p>
      : !enabled ? <div className="workspace-empty"><h3>{t('Automations are not enabled on this deployment.')}</h3></div>
        : !owner ? <div className="workspace-empty"><p>{t('Connect a wallet from the header to use automations.')}</p></div>
          : verificationRequired ? <div className="workspace-empty"><p>{t('Verify wallet ownership to use automations.')}</p>{proof && <WalletProof namespace={owner.namespace} proof={{ ...proof, proven: null }}/>}</div>
            : !overview ? <div role="status"><p>{t(error ? 'Automations could not be loaded. Try again.' : 'Loading automations…')}</p>{error && <button type="button" className="workspace-action" onClick={() => void refresh()}>{t('Retry')}</button>}</div> : <>
              <section className="workspace-section automation-create-section" aria-labelledby="automation-create">
                <div className="workspace-section-heading"><div><h2 id="automation-create">{t('Create an automation')}</h2></div>{(creating || canvas) && !canvas && <button type="button" className="workspace-action" onClick={() => setCreating(null)}>{t('Close')}</button>}</div>
                {canvas ? <CanvasAutomation canvas={canvas} owner={owner} delegationReady={delegationReady} delegationBlocked={delegationBlocked ?? null}
                  onAuthorized={() => { void refresh(); void refreshDelegation(); }} confirm={route => <CreateForm key={JSON.stringify(route)} capabilities={overview.capabilities} owner={owner} busy={busy} run={run} onCreated={() => setCreating(null)} initial={{ name: canvas.name.slice(0, 80), source: 'ROUTE', asset: route.asset, side: route.side, network: route.network, amount: route.amount, slippageBps: String(route.slippageBps) }}/>}/>
                  : <>
                    {!creating ? <><div className="automation-choices">{(['SCHEDULED_DCA', 'PRICE_TRIGGER', 'DAILY_WATCH'] as const).map(kind => {
                      const available = kind === 'SCHEDULED_DCA' ? overview.capabilities.routes.some(r => r.executable) : overview.capabilities.observable.length > 0;
                      return <button key={kind} type="button" className="automation-choice" disabled={!available} onClick={() => { setMode('CONFIRM'); setCreationDraft({}); setCreationStep(1); setCreating(kind); }}><span className="automation-choice-icon" aria-hidden="true">{kind === 'SCHEDULED_DCA' ? '↻' : kind === 'PRICE_TRIGGER' ? '↗' : '◎'}</span><strong>{t(kind === 'SCHEDULED_DCA' ? 'Recurring buy' : kind === 'PRICE_TRIGGER' ? 'Price trigger' : 'Price watch')}</strong><span>{t(available ? kind === 'SCHEDULED_DCA' ? 'Prepare a trade on a regular schedule.' : kind === 'PRICE_TRIGGER' ? 'Respond when a watched price crosses your threshold.' : 'Get a regular price update. Decide what to do next.' : kind === 'SCHEDULED_DCA' ? 'Trade proposals are unavailable under this deployment’s policy.' : 'A verified price source is required on this deployment.')}</span></button>;
                    })}</div><div className="automation-chat-entry">{openChat && <button type="button" className="workspace-action" onClick={openChat}>{t('Create with FloFi Chat')}</button>}<span className="muted">{t('Describe your routine. Review it before saving.')}</span></div></>
                      : <><div className="delegation-mode" role="radiogroup" aria-label={t('Execution')}>
                        <label><input type="radio" name="automation-mode" checked={mode === 'CONFIRM'} onChange={() => setMode('CONFIRM')}/> {t('Ask every time')}</label>
                        <label><input type="radio" name="automation-mode" checked={mode === 'DELEGATED'} disabled={!proven || !delegationReady || Boolean(delegationBlocked) || creating === 'DAILY_WATCH'} onChange={() => setMode('DELEGATED')}/> {t('Automatic within limits')}</label>
                      </div>{(!delegationReady || delegationBlocked) && <p className="muted">{t('Automatic execution requires a supported bounded authorization and executor. It is unavailable for this session or deployment.')}</p>}
                        {mode === 'DELEGATED' && proven && delegationReady && !delegationBlocked ? <DelegatedCreate owner={owner} busy={busy} run={run} onReview={setReview}/>
                          : <CreateForm key={`${ownerKey}:${creating}`} capabilities={overview.capabilities} owner={owner} busy={busy} run={run} onCreated={() => setCreating(null)} initialStep={creationStep} onStepChange={setCreationStep} onDraftChange={setCreationDraft} initial={{ kind: creating, ...(creating === 'PRICE_TRIGGER' && !overview.capabilities.routes.some(r => r.executable) ? { source: 'NONE' as const } : {}), ...creationDraft }}/>}</>}
                  </>}
                <details className="automation-availability"><summary>{t('Availability and prices')}</summary><p>{t('Prices: {0}.', overview.capabilities.priceSource === 'chainlink' ? t('Chainlink feeds on Base (read-only)') : overview.capabilities.priceSource === 'fixture' ? t('test fixture (MOCKED)') : t('no price source on this deployment'))}</p>
                  {Array.from(new Set(overview.capabilities.routes.filter(r => !r.executable).map(r => r.reason).filter((reason): reason is string => Boolean(reason)))).map(reason => <p key={reason}>{text.error(reason)}</p>)}
                </details>
              </section>
              <section className="workspace-section" aria-labelledby="automation-pending">
                <div className="workspace-section-heading"><div><h2 id="automation-pending">{t('Waiting for you')}</h2><span className="workspace-count">{overview.pending.length}</span></div>
                  <button type="button" className="workspace-action" disabled={busy} onClick={() => void refresh()}>{t('Refresh')}</button></div>
                {overview.pending.length ? <div className="automation-list">{overview.pending.map(o => <PendingCard key={o.occurrenceId} o={o} rule={byId.get(o.ruleId)} highlighted={o.occurrenceId === highlight}
                  capabilities={overview.capabilities} busy={busy} run={run} onPropose={command => onPropose?.(command)} owner={owner}/>)}</div>
                  : <div className="workspace-empty"><p>{t('Nothing is waiting for you. FloFi will ask here when an automation is due or a condition is met.')}</p></div>}
              </section>
              <section className="workspace-section" aria-labelledby="automation-rules">
                <div className="workspace-section-heading"><div><h2 id="automation-rules">{t('Your automations')}</h2><span className="workspace-count">{live.length}</span></div></div>
                {live.length ? <div className="automation-list">{live.map(rule => <RuleCard key={rule.ruleId} rule={rule} busy={busy} run={run} owner={owner}
                  onHistory={() => void loadHistory(rule.ruleId)}/>)}</div>
                  : <div className="workspace-empty"><p>{t('No automations yet. Choose a routine above.')}</p></div>}
                {archived.length > 0 && <details className="automation-archived"><summary>{t('Archived ({0})', String(archived.length))}</summary>
                  <div className="automation-list">{archived.map(rule => <RuleCard key={rule.ruleId} rule={rule} busy={busy} run={run} owner={owner}
                    onHistory={() => void loadHistory(rule.ruleId)}/>)}</div></details>}
              </section>
              {history && <HistoryPanel history={history} onClose={() => setHistory(null)}/>}
              {delegationReady && <section className="workspace-section" aria-labelledby="automation-delegated">
                <div className="workspace-section-heading"><div><h2 id="automation-delegated">{t('Automatic within limits')}</h2>
                  <span className="workspace-count">{delegation.overview!.authorizations.length}</span></div>
                  <button type="button" className="workspace-action" disabled={busy} onClick={() => void refreshDelegation()}>{t('Refresh')}</button></div>
                {review && <AuthorizationReview key={review.challenge} review={review} owner={owner} busy={busy} run={run} onDone={() => setReview(null)}/>}
                <DelegatedAuthorizations overview={delegation.overview!} owner={owner} busy={busy} run={run} onReview={setReview}/>
              </section>}
              {overview.recent.length > 0 && <section className="workspace-section" aria-labelledby="automation-recent">
                <div className="workspace-section-heading"><div><h2 id="automation-recent">{t('Recent proposals')}</h2></div></div>
                <ul className="automation-history-list">{overview.recent.map(o => <li key={o.occurrenceId}>{o.ruleName} · <When iso={o.dueAt} zone={byId.get(o.ruleId)?.timezone ?? 'UTC'}/> · {t(OCCURRENCE_LABEL[o.state] ?? o.state)}
                  {o.approval?.status === 'APPLIED' && o.approval.runsComplete === false && <> · {t('Run status could not be read now — not evidence that nothing was sent')}</>}
                  {o.approval?.runs.map(r => <span key={r.executionId}> · {t(automationRunLabel(r))} · <a href={`/app/dashboard/runs/${encodeURIComponent(r.executionId)}`}>{t('Open run')}</a></span>)}</li>)}</ul>
              </section>}
              <details className="automation-notification-settings"><summary>{t('Notification settings')}</summary><Notifications overview={overview} owner={owner} busy={busy} run={run}/></details>
            </>}
  </section>;
}

/** The in-app notice of proposals waiting for the owner, shown on the product stages while there are any. */
export function AutomationInbox({ owner: ownerProp, proven, open }: { owner: WorkflowOwner | null; proven: boolean; open: () => void }) {
  const { t } = useLocale();
  const owner = useStableOwner(ownerProp);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!owner || !proven) { setCount(0); return; }
    let live = true;
    const load = async () => {
      const availability = await automationsAvailability().catch(() => ({ enabled: false }));
      if (!availability.enabled) return;
      const result = await automationOverview(owner).catch(() => null);
      if (live && result?.ok) setCount(result.value.pending.length);
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [owner, proven]);
  if (!count) return null;
  return <div className="automation-inbox" role="status"><span>{t(count === 1 ? '1 automation proposal is waiting for you.' : '{0} automation proposals are waiting for you.', String(count))}</span>
    <button type="button" className="workspace-action" onClick={open}>{t('Open Automations')}</button></div>;
}
