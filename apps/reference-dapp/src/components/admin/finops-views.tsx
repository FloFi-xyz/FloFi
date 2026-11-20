// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FinOps & Unit Economics — presentation only. BUILD-FLOFI-UX-EDITOR-FINOPS-001 (CTO request): the same report, read as a financial management
 * dashboard — four headline indicators and the financial coverage first, then each domain's details, with methodology one click away. Every value is
 * the report's own (`readFinopsReport`): nothing is recalculated, rounded in storage, estimated or filled in. A missing value stays "Unavailable",
 * never zero; a partial total is said to be partial next to it. The investor report opens disclosures for printing.
 */
import { addDays, entryQuality, FINOPS_SCOPES, type PeriodFilter, type Quality, usdOf, decimal } from '../../admin/finops/economics';
import { inclusiveEnd, metricFx, metricPeriod, METRIC_LABELS, REPORT_LIMITATIONS, type FinopsReport, type MetricId } from '../../admin/finops/report';
import { brlOf, PTAX_REFERENCE, PTAX_SOURCE, type ReportFx, type ReportFxSet } from '../../admin/finops/report-fx';
import { Section, Status, TechnicalDetails } from './admin-ui';
import type { Language } from '../../i18n/language';
import { finopsCopy } from './finops-copy';
import { FinopsPeriodForm } from './finops-controls';
import type { ReactNode } from 'react';

export type FinopsMode = 'dashboard' | 'report';
const RANGE_NAMES: Record<PeriodFilter['preset'], string> = {
  current: 'Current month', previous: 'Previous month', '7d': 'Last 7 days', '30d': 'Last 30 days', custom: 'Custom dates',
};
const qualityTone = { VERIFIED: 'ok', PROVIDER_REPORTED: 'info', METERED: 'info', ESTIMATED: 'info', PARTIAL: 'warn', UNAVAILABLE: 'neutral' } as const;
/** The investor report prints every disclosure open; the dashboard keeps detail one click away. */
const openIn = (mode: FinopsMode) => mode === 'report' ? { open: true } : {};
const QUALITY_ORDER: readonly Quality[] = ['VERIFIED', 'PROVIDER_REPORTED', 'METERED', 'ESTIMATED', 'PARTIAL', 'UNAVAILABLE'];
const SURFACE = { WEB: 'Web', TELEGRAM: 'Telegram', WHATSAPP: 'WhatsApp', CHANNEL: 'Channel Core' } as const;
/** Indicators with a fixed calendar period of their own; every other one covers the selected reporting period. */
const FIXED_PERIOD: Partial<Record<MetricId, string>> = { monthToDate: 'Month to date', previousMonth: 'Previous month',
  monthlyChange: 'Closed days of the current month', projected: 'End-of-month projection' };

/** The selected period, the custom UTC dates only when they apply, and the period every "selected period" indicator below covers. */
export function FinopsFilters({ filter, action, language }: { filter: PeriodFilter; action: string; language: Language }) {
  const { copy } = finopsCopy(language);
  return <div className="admin-finops-no-print admin-finops-period-bar">
    <FinopsPeriodForm action={action} preset={filter.preset} from={filter.preset === 'custom' ? filter.period.from : undefined}
      to={filter.preset === 'custom' ? inclusiveEnd(filter.period) : undefined}
      options={Object.entries(RANGE_NAMES).map(([value, label]) => ({ value, label: copy(label) }))}/>
    <p className="admin-finops-period" aria-live="polite">{copy('Selected period')}: <strong>{copy(RANGE_NAMES[filter.preset])}</strong>
      {' · '}<span className="admin-finops-nowrap">{copy('{0} to {1} UTC', filter.period.from, inclusiveEnd(filter.period))}</span>{' · '}{copy('Amounts in USD')}</p>
    {filter.valid ? null : <p className="admin-alert" role="alert" data-tone="warn">{copy("The custom period must use two valid dates, at most 366 days, through today. Showing the current month.")}</p>}
  </div>;
}

function QualityBadge({ quality, language, title }: { quality: Quality; language: Language; title?: string }) {
  return <Status tone={qualityTone[quality]} title={title}>{finopsCopy(language).copy(quality)}</Status>;
}
/** An amount as the dashboard reads it (adaptive precision); the recorded value at full precision stays available beside it. */
export function Amount({ value, language, mode = 'dashboard', currency = 'USD', unit = false }: {
  value: string | number | null; language: Language; mode?: FinopsMode; currency?: string; unit?: boolean }) {
  const { display, money, copy } = finopsCopy(language);
  if (mode === 'report' || value === null) return <span className="admin-amount">{money(value, currency, unit)}</span>;
  const shown = display(value, currency);
  if (shown.text === shown.exact) return <span className="admin-amount">{shown.text}</span>;
  return <span className="admin-amount" title={copy('Recorded value: {0}', shown.exact)}>{shown.text}<span className="admin-sr"> ({copy('Recorded value: {0}', shown.exact)})</span></span>;
}
const UNIT_METRICS: ReadonlySet<MetricId> = new Set(['costPerActive', 'costPerChat', 'costPerSimulated', 'costPerCompleted', 'directSimulated', 'directCompleted']);
function BrlAmount({ value, fx, language, unit }: { value: string | null; fx: ReportFx | undefined; language: Language; unit?: boolean }) {
  if (value === null || !fx) return null;
  const { copy, money } = finopsCopy(language), amount = brlOf(value, fx);
  return <small className="admin-fx-amount">{amount === null ? copy('BRL conversion unavailable') : copy('Approx. {0}', money(amount, 'BRL', unit))}</small>;
}

export function FinopsExchangeReference({ rates, language }: { rates: ReportFxSet; language: Language }) {
  const { copy, count } = finopsCopy(language);
  const references = [
    { name: 'Current indicative rate', rate: rates.indicative },
    ...(rates.selected.policy === 'historical-period-close' && rates.selected.asOf !== rates.previous.asOf
      ? [{ name: 'Selected period reference', rate: rates.selected }] : []),
    { name: 'Previous month reference', rate: rates.previous },
  ];
  return <Section id="finops-fx" title={copy('Exchange-rate reference')}>
    <p className="admin-diff">{copy('USD is the accounting currency. BRL uses the latest published PTAX through the day before the report for open periods, or through the last day of a closed period. The quote may precede that cutoff by up to four days.')}</p>
    <p><a className="admin-finops-link" href={PTAX_REFERENCE}>{copy(PTAX_SOURCE)}</a></p>
    <dl className="admin-finops-basis">{references.map(({ name, rate }) => <div key={name}><dt>{copy(name)}</dt>
      <dd>{rate.policy === 'historical-period-close' ? copy('Historical period closing rate') + ' · ' : ''}
        {copy('Reference through {0}', rate.asOf)} · {rate.quote
          ? copy('{0} BRL per USD · {1} (São Paulo time)', count(Number(rate.quote.rate), 5), rate.quote.publishedAt)
          : copy('BRL conversion unavailable')}</dd></div>)}</dl>
  </Section>;
}
function periodNote(report: FinopsReport, key: MetricId, language: Language): string {
  const { copy } = finopsCopy(language);
  const period = metricPeriod(report, key), fixed = FIXED_PERIOD[key];
  if (period.from === period.to) return copy('No closed UTC days in the current month');
  return fixed ? `${copy(fixed)} · ${copy('{0} to {1} UTC', period.from, inclusiveEnd(period))}` : copy('Selected period');
}
/** One indicator: label, value, its quality and the period it covers; a partial or unavailable value says why next to it. */
function Indicator({ report, id, language, mode, headline = false }: { report: FinopsReport; id: MetricId; language: Language; mode: FinopsMode; headline?: boolean }) {
  const { copy } = finopsCopy(language);
  const metric = report.metrics[id];
  return <div className={headline ? 'admin-finops-metric admin-finops-headline' : 'admin-finops-metric'} data-tone={qualityTone[metric.quality]}>
    <span className="admin-finops-metric-label">{copy(METRIC_LABELS[id])}</span>
    <strong className="admin-finops-metric-value"><Amount value={metric.amount} language={language} mode={mode} unit={UNIT_METRICS.has(id)}/></strong>
    {mode === 'report' && <BrlAmount value={metric.amount} fx={metricFx(report.fx, id)} language={language} unit={UNIT_METRICS.has(id)}/>}
    <span className="admin-finops-metric-meta"><QualityBadge quality={metric.quality} language={language} title={copy(metric.source)}/>
      <span className="admin-finops-scope" data-scope={FIXED_PERIOD[id] ? 'fixed' : 'selected'}>{periodNote(report, id, language)}</span></span>
    {metric.quality === 'PARTIAL' ? <small className="admin-finops-partial">{copy('Partial: calculated from a known subset of the required inputs.')}</small>
      : metric.quality === 'UNAVAILABLE' ? <small className="admin-finops-reason">{copy(metric.source)}</small> : null}
  </div>;
}
function Indicators({ report, keys, language, mode, label }: { report: FinopsReport; keys: readonly MetricId[]; language: Language; mode: FinopsMode; label?: string }) {
  return <div className="admin-finops-metrics" role="group" aria-label={label}>{keys.map(key => <Indicator key={key} report={report} id={key} language={language} mode={mode}/>)}</div>;
}
/** How each indicator is calculated, one disclosure for the whole group (never repeated under every value). */
function Basis({ report, keys, language, mode }: { report: FinopsReport; keys: readonly MetricId[]; language: Language; mode: FinopsMode }) {
  const { copy } = finopsCopy(language);
  return <TechnicalDetails summary={copy('How these values are calculated')} {...openIn(mode)}>
    <dl className="admin-finops-basis">{keys.map(key => <div key={key}><dt>{copy(METRIC_LABELS[key])}</dt><dd>{copy(report.metrics[key].source)}</dd></div>)}</dl>
  </TechnicalDetails>;
}

const HEADLINE: readonly MetricId[] = ['monthToDate', 'projected', 'costPerCompleted', 'revenue'];
const OVERVIEW_SECONDARY: readonly MetricId[] = ['overall', 'previousMonth', 'monthlyChange', 'costPerChat', 'costPerSimulated', 'costPerActive'];

/** The cost sources the totals are made of, by quality: how much of FloFi's cost the figures actually cover. Counts only — no score. */
function CoverageSummary({ report, language }: { report: FinopsReport; language: Language }) {
  const { copy, count } = finopsCopy(language);
  // The same expense sources `consolidate` includes in the overall total (every non-revenue scope that is required or has a record).
  const sources = report.totals.filter(total => {
    const scope = FINOPS_SCOPES[total.id];
    return scope.category !== 'revenue' && (scope.required || total.amount !== null || total.updatedAt !== null);
  });
  const counts = new Map<Quality, number>();
  for (const source of sources) counts.set(source.quality, (counts.get(source.quality) ?? 0) + 1);
  const overall = report.metrics.overall.quality, ledger = report.ledger.status;
  const tone = overall === 'PARTIAL' || overall === 'UNAVAILABLE' || ledger !== 'available' ? 'warn' : overall === 'ESTIMATED' ? 'info' : 'ok';
  const range = copy('{0} to {1} UTC', report.period.from, inclusiveEnd(report.period));
  const [heading, detail] = ledger !== 'available' ? ['Cost coverage unavailable', ledger === 'missing'
      ? 'The billing ledger is not provisioned yet, so expense totals are unavailable (see Infrastructure Costs).'
      : 'The billing ledger cannot be read right now, so expense totals are unavailable (see Infrastructure Costs).']
    : overall === 'UNAVAILABLE' ? ['No recorded cost amounts for the selected period', 'Expense totals are unavailable until financial records with a USD amount exist for this period.']
    : overall === 'PARTIAL' ? ['Partial financial coverage for the selected period', 'Some cost sources have no complete record for the selected period. Totals add only the recorded amounts and are not the complete cost of operating FloFi.']
    : ['Cost coverage complete for the selected period', overall === 'ESTIMATED' ? 'Every required cost source has a record for the selected period; some are estimates, not billed amounts.'
      : 'Every required cost source has a complete record for the selected period.'];
  return <div className="admin-finops-coverage" data-tone={tone} role="status">
    <div><strong>{copy(heading)}</strong> <span className="admin-finops-nowrap">({range})</span>
      <p>{copy(detail)}</p></div>
    <ul className="admin-finops-quality-counts" aria-label={copy('Cost sources by data quality')}>
      {QUALITY_ORDER.filter(quality => counts.get(quality)).map(quality => <li key={quality}><QualityBadge quality={quality} language={language}/> {counts.get(quality) === 1 ? copy('1 cost source') : copy('{0} cost sources', count(counts.get(quality)!))}</li>)}
    </ul>
    <a className="admin-finops-link" href="#finops-coverage">{copy('How data quality is classified')}</a>
  </div>;
}

export function FinopsOverview({ report, language, mode = 'dashboard' }: { report: FinopsReport; language: Language; mode?: FinopsMode }) {
  const { copy } = finopsCopy(language);
  return <Section id="finops-overview" title={copy("Overview")} description={copy('{0} to {1} UTC', report.period.from, inclusiveEnd(report.period)) + ' · ' + copy('USD consolidated')}>
    <div className="admin-finops-metrics admin-finops-headlines" role="group" aria-label={copy('Headline indicators')}>
      {HEADLINE.map(key => <Indicator key={key} report={report} id={key} language={language} mode={mode} headline/>)}
    </div>
    <CoverageSummary report={report} language={language}/>
    <h3 className="admin-finops-subhead">{copy('Other cost indicators')}</h3>
    <Indicators report={report} keys={OVERVIEW_SECONDARY} language={language} mode={mode} label={copy('Other cost indicators')}/>
    <p className="admin-diff">{copy('AI costs, variable costs, margins and break-even are in their own sections below.')}</p>
    <Basis report={report} keys={[...HEADLINE, ...OVERVIEW_SECONDARY]} language={language} mode={mode}/>
  </Section>;
}

export function FinopsCostBreakdown({ report, language, mode = 'dashboard' }: { report: FinopsReport; language: Language; mode?: FinopsMode }) {
  const { copy, time } = finopsCopy(language);
  const amounts = report.totals.filter(total => total.id !== 'fee-revenue');
  // Services of one provider are read together (Neon, Railway…); every service keeps its own row, value, quality, sources and sync state.
  const providers = [...new Set(amounts.map(total => FINOPS_SCOPES[total.id].provider))];
  return <div className="admin-table-wrap"><table className="admin-table admin-finops-costs" aria-label={copy("Provider cost breakdown")}>
    <thead><tr><th>{copy("Provider and service")}</th><th>{copy("Category")}</th><th className="admin-num">{copy("Net USD")}</th><th>{copy("Data quality")}</th><th>{copy("Record sources")}</th><th>{copy("Last record")}</th><th>{copy("Last successful sync")}</th></tr></thead>
    {providers.map(provider => <tbody key={provider} className="admin-finops-group">{amounts.filter(total => FINOPS_SCOPES[total.id].provider === provider).map(total => {
      const scope = FINOPS_SCOPES[total.id], sync = report.sync.find(row => row.scope === total.id);
      const providerSync = report.integrations.providers.find(item => item.name === scope.provider || item.id === 'alchemy' && total.id === 'rpc');
      const lastSuccess = [providerSync?.lastSuccess, sync?.lastSuccess].filter(value => value != null).sort().at(-1) ?? null;
      const lastFailure = [providerSync?.configured && providerSync.errorCode ? providerSync.lastAttempt : null, sync?.lastFailed]
        .filter(value => value != null).sort().at(-1) ?? null;
      return <tr key={total.id}><th scope="row"><span className="admin-finops-provider">{scope.provider}</span><br/><small>{scope.name}</small></th><td>{copy(scope.category)}</td>
        <td className="admin-num"><Amount value={total.amount} language={language} mode={mode}/>
          {mode === 'report' && <BrlAmount value={total.amount} fx={report.fx?.selected} language={language}/>}</td>
        <td><QualityBadge quality={total.quality} language={language}/></td><td>{total.sources.join(', ') || '—'}</td>
        <td>{time(total.updatedAt)}</td><td>{time(lastSuccess)}
          {lastFailure && (!lastSuccess || lastFailure > lastSuccess)
            ? <p className="admin-diff">{copy('Latest sync failed {0}.', time(lastFailure))}</p> : null}
        </td></tr>;
    })}</tbody>)}
  </table></div>;
}

export function FinopsInfrastructure({ report, language, records = null }: { report: FinopsReport; language: Language;
  /** The financial record management (manual entry and CSV import), kept in this section without dominating the dashboard. */
  records?: ReactNode }) {
  const { copy, time, display } = finopsCopy(language);
  // The record table shows each recorded amount exactly, as stored; summaries above it round for reading.
  const exact = (value: string | number | null, currency = 'USD') => display(value, currency).exact;
  return <Section id="finops-infrastructure" title={copy("Infrastructure Costs")}
    description={copy("FloFi-scoped net charges for the selected UTC period. Operating expenses paid by users are excluded.")}>
    {report.ledger.status !== 'available' ? <p role="status" className="admin-alert" data-tone="warn">{report.ledger.status === 'missing' ?
      copy('Billing ledger unavailable. The schema compatibility release can serve the console while the owner provisions the verified migration.')
      : copy('The billing ledger is temporarily unavailable.')}</p> : null}
    {report.ledger.status === 'available' && !report.ledger.records.length ? <p className="admin-empty">{copy("No financial records for this period. Expense totals are unavailable.")}</p> : null}
    {report.ledger.status === 'available' && !report.ledger.complete ? <p role="status" className="admin-alert" data-tone="warn">{copy("The date range reached the record limit. Totals cover only the loaded records.")}</p> : null}
    <FinopsCostBreakdown report={report} language={language}/>
    {report.ledger.records.length > 0 ? <TechnicalDetails summary={copy("Financial records and reconciliation")}>
      <div className="admin-table-wrap"><table className="admin-table" aria-label={copy("Financial record ledger")}>
        <thead><tr><th>{copy("Record")}</th><th>{copy("Environment and period")}</th><th>{copy("Source")}</th><th>{copy("Net billed")}</th><th>{copy("Gross, credits, discounts, tax")}</th><th>USD</th><th>{copy("Quality")}</th><th>{copy("Updated")}</th></tr></thead>
        <tbody>{report.ledger.records.map(record => {
          const converted = usdOf(record), scope = FINOPS_SCOPES[record.scope];
          return <tr key={record.id}><th scope="row">#{record.id} · {scope.provider} / {scope.name}</th>
            <td>{record.environment}<br/>{copy('{0} to {1} UTC', record.period.from, inclusiveEnd(record.period))}</td>
            <td>{record.source}<br/>{record.reference}{record.notes ? <p>{record.notes}</p> : null}
              {record.source === 'USAGE' || record.source === 'ASSUMPTION'
                ? <p className="admin-diff">{copy('Excluded from recorded expenses (usage or estimate)')}</p>
                : !record.selected ? <p className="admin-diff">{copy("Superseded in totals")}</p> : null}</td>
            <td>{exact(record.net, record.currency)}</td>
            <td>{[record.gross, record.credits, record.discounts, record.taxes].map(value => value === null ? '—' : exact(value, record.currency)).join(' / ')}</td>
            <td>{exact(converted === null ? null : decimal(converted))}{record.fxSource ? <small><br/>{record.fxUsd} · {record.fxSource}</small> : null}</td>
            <td><QualityBadge language={language} quality={entryQuality(record)}/></td><td>{time(record.updatedAt)}</td></tr>;
        })}</tbody>
      </table></div>
    </TechnicalDetails> : null}
    {records}
  </Section>;
}

/** A labelled group of related figures (usage, reliability, costs): one compact list instead of a card per value. */
function FigureGroup({ title, rows, note }: { title: string; rows: readonly { readonly label: string; readonly value: ReactNode; readonly note?: ReactNode }[]; note?: ReactNode }) {
  return <section className="admin-finops-group-card" aria-label={title}><h3>{title}</h3>
    <dl>{rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd><span className="admin-finops-figure">{row.value}</span>{row.note ? <small>{row.note}</small> : null}</dd></div>)}</dl>
    {note ? <p className="admin-diff">{note}</p> : null}
  </section>;
}

export function FinopsAi({ report, language, mode = 'dashboard' }: { report: FinopsReport; language: Language; mode?: FinopsMode }) {
  const { copy, money, time, count: fmt } = finopsCopy(language);
  const { ai, metrics } = report;
  const estimate = ai?.costEstimate, calls = ai?.calls.requests ?? 0;
  const periodLabel = copy('{0} to {1} UTC', report.period.from, inclusiveEnd(report.period));
  const dailyMax = Math.max(0, ...ai?.daily.map(day => day.estimate ?? 0) ?? []);
  const amount = (value: string | number | null, unit = false) => <Amount value={value} language={language} mode={mode} unit={unit}/>;
  // Provider billing and the ledger record this cost, not telemetry: it stays visible when telemetry cannot be read.
  const recordedCost = { label: copy("Provider and ledger AI costs"), value: amount(metrics.aiCost.amount), note: <><QualityBadge language={language} quality={metrics.aiCost.quality} title={copy(metrics.aiCost.source)}/>
    {metrics.aiCost.quality === 'PARTIAL' ? <span className="admin-finops-partial"> {copy('Partial: calculated from a known subset of the required inputs.')}</span> : null}</> };
  return <Section id="finops-ai" title={copy("AI Economics")} description={periodLabel + ' · ' + copy('Server telemetry and scoped AI billing.')}>
    {ai ? <>
      {/* Limits that qualify every AI figure below stay warnings, never a footnote. */}
      {[ai.coverage.outsideRetention && copy('This range exceeds telemetry retention.'), ai.coverage.truncated && copy('The report reached its telemetry row limit.'),
        !ai.coverage.ledgerAvailable && copy('Detailed AI telemetry is unavailable until the FinOps ledger migration is applied.')].filter(Boolean)
        .map(text => <p key={String(text)} className="admin-alert" role="status" data-tone="warn">{text}</p>)}
      <div className="admin-finops-groups">
        <FigureGroup title={copy('Usage')} rows={[
          { label: copy("Recorded provider calls"), value: calls ? fmt(calls) : copy('Unavailable'), note: copy('PARTIAL · FinOps samples') },
          { label: copy("Observed chat interactions"), value: ai.chats.observed ? fmt(ai.chats.observed) : copy('Unavailable'), note: `${copy('PARTIAL')} · Web ${fmt(ai.chats.web)}, Channel Core ${fmt(ai.chats.channels)}` },
          { label: copy("Tool calls / failures"), value: ai.toolCalls || calls ? `${fmt(ai.toolCalls)} / ${fmt(ai.toolFailures)}` : copy('Unavailable'), note: copy('Copilot server interpretations') },
        ]} note={copy('Token usage by provider, model and surface is in the table below.')}/>
        <FigureGroup title={copy('Reliability')} rows={[
          { label: copy("Captured success / failure"), value: calls ? `${fmt(ai.calls.successes)} / ${fmt(calls - ai.calls.successes)}` : copy('Unavailable'),
            note: calls ? copy('{0}% success · PARTIAL', fmt(100 * ai.calls.successes / calls)) : copy('UNAVAILABLE') },
          { label: copy("Mean provider call latency"), value: ai.calls.meanLatency === null ? copy('Unavailable') : fmt(ai.calls.meanLatency) + ' ms', note: copy('Recorded calls') },
        ]} note={[
          copy('Last sample {0}. Input usage was reported for {1} of {2} captured calls ({3} missing). Output usage was reported for {4} ({5} missing).',
            time(ai.freshness), fmt(ai.calls.inputSamples), fmt(calls), fmt(calls - ai.calls.inputSamples), fmt(ai.calls.outputSamples), fmt(calls - ai.calls.outputSamples)),
          copy('Web counts are observed interpretations. Channel Core counts are observed server turns. MCP and Developer API have no model-call coverage here.'),
        ].join(' ')}/>
        <FigureGroup title={copy('Costs')} rows={[
          recordedCost,
          { label: copy("AI list-price estimate"), value: amount(estimate?.amount ?? null), note: copy(estimate?.quality ?? 'UNAVAILABLE') + ' · ' + copy('{0} priced calls', fmt(ai.calls.pricedRequests)) },
          { label: copy("Estimated cost per priced call"), value: amount(estimate?.amount && ai.calls.pricedRequests ? Number(estimate.amount) / ai.calls.pricedRequests : null, true),
            note: estimate?.amount ? copy('PARTIAL · Captured priced calls') : copy('UNAVAILABLE') },
        ]} note={copy('List-price estimates are reported separately from provider charges.')}/>
      </div>
      <TechnicalDetails summary={copy('How AI costs are estimated')} {...openIn(mode)}>
        <p>{copy('Pricing uses the provider’s response model and versioned USD standard rates where token dimensions are complete. Reasoning is included in billed output. These estimates are reported separately from provider charges.')}</p>
        <dl className="admin-finops-basis"><div><dt>{copy(METRIC_LABELS.aiCost)}</dt><dd>{copy(metrics.aiCost.source)}</dd></div></dl>
      </TechnicalDetails>
      {ai.models.length ? <div className="admin-table-wrap"><table className="admin-table admin-finops-compact" aria-label={copy('Measured AI usage by provider, model, and surface')}>
        <thead><tr><th>{copy("Provider and response model")}</th><th>{copy("Surface")}</th><th className="admin-num">{copy("Calls")}</th><th className="admin-num">{copy("Input")}</th><th className="admin-num">{copy("Output")}</th><th className="admin-num">{copy("Reasoning")}</th><th className="admin-num">{copy("Cached input")}</th><th className="admin-num">{copy("Estimated cost")}</th></tr></thead>
        <tbody>{ai.models.map(({ usage, estimate: total, pricedRequests }) =>
          <tr key={[usage.provider, usage.model, usage.surface].join(':')}><th scope="row">{usage.provider} / {usage.model || copy('Unknown response model')}</th>
            <td>{SURFACE[usage.surface]}</td><td className="admin-num">{fmt(usage.requests)}</td>
            {([['input_tokens', 'input_samples'], ['output_tokens', 'output_samples'], ['reasoning_tokens', 'reasoning_samples'], ['cached_input_tokens', 'cached_input_samples']] as const)
              .map(([field, samples]) => <td className="admin-num" key={field}>{usage[samples] ? copy('{0} ({1} samples)', fmt(usage[field]), fmt(usage[samples])) : copy('Unavailable')}</td>)}
            <td className="admin-num">{amount(total)} <QualityBadge language={language} quality={total === null ? 'UNAVAILABLE' : pricedRequests === usage.requests ? 'ESTIMATED' : 'PARTIAL'}/></td></tr>)}</tbody>
      </table></div> : <p className="admin-empty">{copy("No model-call samples were recorded in this period.")}</p>}
      {ai.daily.length > 0 ? <TechnicalDetails summary={copy("Daily AI estimate and request coverage")} {...openIn(mode)}>
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{copy("UTC day")}</th><th>{copy("Requests")}</th><th>{copy("Priced requests")}</th><th>{copy("List-price estimate")}</th></tr></thead>
          <tbody>{ai.daily.map(day => <tr key={day.day}><th scope="row">{day.day}</th><td>{fmt(day.requests)}</td><td>{fmt(day.pricedRequests)}</td>
            <td>{money(day.estimate)} <QualityBadge language={language} quality={day.estimate === null ? 'UNAVAILABLE' : day.pricedRequests === day.requests ? 'ESTIMATED' : 'PARTIAL'}/>
              {day.estimate !== null && dailyMax > 0 ? <meter aria-label={copy('{0} estimated AI cost', day.day)} title={money(day.estimate)} max={dailyMax} value={day.estimate}/> : null}
            </td></tr>)}</tbody>
        </table></div>
      </TechnicalDetails> : null}
      {ai.legacy.length && ai.models.length === 0 ? <TechnicalDetails summary={copy("Historical Copilot interpretations by configured model")} open>
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{copy("Configured model")}</th><th>{copy("Surface")}</th><th>{copy("Interpretations")}</th><th>{copy("Input tokens")}</th><th>{copy("Output tokens")}</th></tr></thead>
          <tbody>{ai.legacy.map(row => <tr key={[row.model, row.surface].join(':')}><th scope="row">{row.model || copy('Unavailable')}</th><td>{SURFACE[row.surface]}</td>
            <td>{fmt(row.requests)}</td><td>{row.usageSamples ? fmt(row.inputTokens) : copy('Unavailable')}</td><td>{row.usageSamples ? fmt(row.outputTokens) : copy('Unavailable')}</td></tr>)}</tbody>
        </table></div>
      </TechnicalDetails> : null}
    </> : <>
      <p className="admin-alert" role="status" data-tone="warn">{copy("AI telemetry is temporarily unavailable.")}</p>
      <div className="admin-finops-groups"><FigureGroup title={copy('Costs')} rows={[recordedCost]}/></div>
    </>}
  </Section>;
}

export function FinopsWorkflow({ report, language, mode = 'dashboard' }: { report: FinopsReport; language: Language; mode?: FinopsMode }) {
  const { copy, time, count: fmt } = finopsCopy(language);
  const { workflow, gas } = report;
  return <Section id="finops-workflow" title={copy("Workflow Economics")} description={copy('Canonical multi-step mainnet workflow runs. Status changes use the recorded date. Single-flow and legacy operations are outside this counting cohort.')}>
    {workflow ? <>
      <ol className="admin-finops-lifecycle" aria-label={copy('Workflow lifecycle')}>
        {([['Created', workflow.created], ['Started mode', workflow.advanced], ['Completed and reconciled', workflow.completed],
          ['Failed or halted', workflow.failed], ['Cancelled or expired', workflow.abandoned]] as const)
          .map(([label, value]) => <li key={label}><span>{copy(label)}</span><strong>{value === null ? copy('Unavailable') : fmt(value)}</strong></li>)}
      </ol>
      <p className="admin-diff">{copy('PARTIAL · canonical cohort')} · {copy('Last durable workflow update {0}. Complete approval, simulation and retry counts across surfaces are unavailable.', time(workflow.newest))}</p>
    </> : <p role="status" className="admin-alert" data-tone="warn">{copy("Workflow economics are temporarily unavailable.")}</p>}
    <h3 className="admin-finops-subhead">{copy('Cost per workflow')}</h3>
    <Indicators report={report} keys={['directSimulated', 'directCompleted', 'costPerCompleted']} language={language} mode={mode} label={copy('Cost per workflow')}/>
    <p className="admin-diff">{copy('Direct costs are workflow-linked costs only. The fully allocated cost divides every recorded operating cost of the period by the completed workflows.')}</p>
    <TechnicalDetails summary={copy('Gas payer evidence')} {...openIn(mode)}>
      <p className="admin-diff">{copy('Mainnet batch and user-operation groups use their last recorded update. Single-step and standalone transactions are outside this coverage. FloFi gas expense requires a reconciled debit or invoice.')}</p>
      {gas ? <dl className="admin-finops-basis">
        {([['Paid natively by the user', gas.ownerNative], ['Native gas fronted by a third-party relayer', gas.frontedByRelayer],
          ['FloFi sponsorship observed', gas.sponsorObserved], ['Gas payer evidence unresolved', gas.unresolved]] as const)
          .map(([label, number]) => <div key={label}><dt>{copy(label)}</dt><dd>{fmt(number)}</dd></div>)}
      </dl> : <p>{copy('Unavailable')}</p>}
    </TechnicalDetails>
    {workflow ? <TechnicalDetails summary={copy('Average steps and planned actions')} {...openIn(mode)}>
      <p>{copy('Average steps at creation')}: <strong>{workflow.averageSteps === null ? copy('Unavailable') : fmt(workflow.averageSteps)}</strong></p>
      {workflow.dimensions.length ? <div className="admin-table-wrap"><table className="admin-table admin-finops-compact" aria-label={copy('Planned actions in new canonical workflows')}>
        <thead><tr><th>{copy("Planned action")}</th><th>{copy("Network")}</th><th>{copy("Protocol")}</th><th className="admin-num">{copy("Count")}</th></tr></thead>
        <tbody>{workflow.dimensions.map(row => <tr key={[row.action, row.network, row.protocol].join(':')}><th scope="row">{row.action}</th>
          <td>{row.network}</td><td>{row.protocol}</td><td className="admin-num">{fmt(row.count)}</td></tr>)}</tbody>
      </table></div> : null}
    </TechnicalDetails> : null}
    <Basis report={report} keys={['directSimulated', 'directCompleted', 'costPerCompleted']} language={language} mode={mode}/>
  </Section>;
}

export function FinopsRevenue({ report, language, mode = 'dashboard' }: { report: FinopsReport; language: Language; mode?: FinopsMode }) {
  const { copy } = finopsCopy(language);
  const groups: readonly (readonly [string, readonly MetricId[]])[] = [['Collected revenue', ['revenue']], ['Operating costs', ['variable', 'infrastructure']],
    ['Margins', ['contribution', 'result']], ['Break-even', ['breakEvenRevenue']]];
  return <Section id="finops-revenue" title={copy("Revenue & Margins")} description={copy("Actual fee revenue is recognized through reconciled accounting records.")}>
    <div className="admin-finops-revenue">{groups.map(([title, keys]) => <section key={title} aria-label={copy(title)}><h3 className="admin-finops-subhead">{copy(title)}</h3>
      <Indicators report={report} keys={keys} language={language} mode={mode}/></section>)}</div>
    <p className="admin-diff">{copy("Gross transaction volume, fee-eligible volume, and expected fee revenue are unavailable. Deferred 10 bps obligations do not contribute to collected revenue.")}</p>
    <Basis report={report} keys={['revenue', 'variable', 'infrastructure', 'contribution', 'result', 'breakEvenRevenue']} language={language} mode={mode}/>
  </Section>;
}

export function FinopsCoverage({ language, mode = 'dashboard' }: { language: Language; mode?: FinopsMode }) {
  const { copy } = finopsCopy(language);
  return <Section id="finops-coverage" title={copy("Data quality and methodology")}>
    <dl className="admin-finops-assumptions">
      {Object.entries({ VERIFIED: 'Provider-confirmed billing or reconciled accounting record', PROVIDER_REPORTED: 'Cost reported by the provider\'s billing API, not yet reconciled with an invoice', METERED: 'Measured usage and an applicable rate',
        ESTIMATED: 'Model or stated assumption', PARTIAL: 'Known subset of the required inputs', UNAVAILABLE: 'Insufficient input or access' })
        .map(([key, label]) => <div key={key}><dt>{key}</dt><dd>{copy(label)}</dd></div>)}
    </dl>
    <TechnicalDetails summary={copy('Methodology: record precedence, reconciliation, currency, UTC periods, cohorts and revenue recognition')} {...openIn(mode)}>
      <ul>{REPORT_LIMITATIONS.map(text => <li key={text}>{copy(text)}</li>)}</ul>
    </TechnicalDetails>
  </Section>;
}

export function finopsFilterQuery(filter: PeriodFilter) {
  const search = new URLSearchParams({ range: filter.preset });
  if (filter.preset === 'custom') { search.set('from', filter.period.from); search.set('to', addDays(filter.period.to, -1)); }
  return search;
}
