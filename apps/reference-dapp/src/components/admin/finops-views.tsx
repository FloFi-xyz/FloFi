// SPDX-License-Identifier: AGPL-3.0-only

import { addDays, entryQuality, FINOPS_SCOPES, type PeriodFilter, type Quality, usdOf, decimal } from '../../admin/finops/economics';
import { inclusiveEnd, metricPeriod, METRIC_LABELS, REPORT_LIMITATIONS, type FinopsReport, type MetricId } from '../../admin/finops/report';
import { Kpi, Section, Status, TechnicalDetails } from './admin-ui';
import type { Language } from '../../i18n/language';
import { finopsCopy } from './finops-copy';

const RANGE_NAMES: Record<PeriodFilter['preset'], string> = {
  current: 'Current month', previous: 'Previous month', '7d': 'Last 7 days', '30d': 'Last 30 days', custom: 'Custom dates',
};
const qualityTone = { VERIFIED: 'ok', METERED: 'info', ESTIMATED: 'info', PARTIAL: 'warn', UNAVAILABLE: 'neutral' } as const;
const SURFACE = { WEB: 'Web', TELEGRAM: 'Telegram', WHATSAPP: 'WhatsApp', CHANNEL: 'Channel Core' } as const;
export function FinopsFilters({ filter, action, language }: { filter: PeriodFilter; action: string; language: Language }) {
  const { copy } = finopsCopy(language);
  return <div className="admin-finops-no-print">
    <form className="admin-filters admin-card" action={action} method="get" aria-label={copy("Financial reporting period")}>
      <label>{copy("Period")}<select name="range" aria-label={copy("Period")} defaultValue={filter.preset}>{Object.entries(RANGE_NAMES).map(([value, label]) => <option key={value} value={value}>{copy(label)}</option>)}</select></label>
      <label>{copy("Custom start (UTC)")}<input type="date" name="from" defaultValue={filter.preset === 'custom' ? filter.period.from : undefined}/></label>
      <label>{copy("Custom last day (UTC)")}<input type="date" name="to" defaultValue={filter.preset === 'custom' ? inclusiveEnd(filter.period) : undefined}/></label>
      <button className="admin-button" type="submit">{copy("Apply period")}</button>
    </form>
    {filter.valid ? null : <p className="admin-alert" role="alert" data-tone="warn">{copy("The custom period must use two valid dates, at most 366 days, through today. Showing the current month.")}</p>}
  </div>;
}
const OVERVIEW: MetricId[] = ['monthToDate', 'previousMonth', 'projected', 'overall', 'aiCost', 'variable', 'costPerActive', 'costPerChat',
  'costPerSimulated', 'costPerCompleted', 'revenue', 'contribution', 'result', 'breakEvenRevenue'];
function QualityBadge({ quality, title }: { quality: Quality; title?: string }) {
  return <Status tone={qualityTone[quality]} title={title}>{quality}</Status>;
}
function IndicatorCards({ report, keys, language }: { report: FinopsReport; keys: readonly MetricId[]; language: Language }) {
  const { copy, money } = finopsCopy(language);
  return <div className="admin-kpis">{keys.map(key => {
    const metric = report.metrics[key], period = metricPeriod(report, key);
    return <Kpi key={key} label={copy(METRIC_LABELS[key])} value={money(metric.amount)} tone={qualityTone[metric.quality]}
      note={metric.quality + ' · ' + copy('{0} to {1} UTC', period.from, inclusiveEnd(period)) + ' · ' + copy(metric.source)}/>;
  })}</div>;
}

export function FinopsOverview({ report, language }: { report: FinopsReport; language: Language }) {
  const { copy } = finopsCopy(language);
  return <Section id="finops-overview" title={copy("Overview")} description={copy('{0} to {1} UTC', report.period.from, inclusiveEnd(report.period)) + ' · ' + copy('USD consolidated')}>
    <IndicatorCards report={report} language={language} keys={OVERVIEW}/>
  </Section>;
}

export function FinopsCostBreakdown({ report, language }: { report: FinopsReport; language: Language }) {
  const { copy, money, time } = finopsCopy(language);
  const amounts = report.totals.filter(total => total.id !== 'fee-revenue');
  return <div className="admin-table-wrap"><table className="admin-table" aria-label={copy("Provider cost breakdown")}>
    <thead><tr><th>{copy("Provider and service")}</th><th>{copy("Category")}</th><th>{copy("Net USD")}</th><th>{copy("Data quality")}</th><th>{copy("Record sources")}</th><th>{copy("Last record")}</th><th>{copy("Last successful sync")}</th></tr></thead>
    <tbody>{amounts.map(total => {
      const scope = FINOPS_SCOPES[total.id], sync = report.sync.find(row => row.scope === total.id);
      return <tr key={total.id}><th scope="row">{scope.provider}<br/><small>{scope.name}</small></th><td>{scope.category}</td>
        <td>{money(total.amount)}</td><td><QualityBadge quality={total.quality}/></td><td>{total.sources.join(', ') || '—'}</td>
        <td>{time(total.updatedAt)}</td><td>{time(sync?.lastSuccess ?? null)}
          {sync?.lastFailed && (!sync.lastSuccess || sync.lastFailed > sync.lastSuccess) ? <p className="admin-diff">{copy('Latest sync failed {0}.', time(sync.lastFailed))}</p> : null}
        </td></tr>;
    })}</tbody>
  </table></div>;
}

export function FinopsInfrastructure({ report, language }: { report: FinopsReport; language: Language }) {
  const { copy, money, time } = finopsCopy(language);
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
              {!record.selected ? <p className="admin-diff">{copy("Superseded in totals")}</p> : null}</td>
            <td>{money(record.net, record.currency)}</td>
            <td>{[record.gross, record.credits, record.discounts, record.taxes].map(value => value === null ? '—' : money(value, record.currency)).join(' / ')}</td>
            <td>{money(converted === null ? null : decimal(converted))}{record.fxSource ? <small><br/>{record.fxUsd} · {record.fxSource}</small> : null}</td>
            <td><QualityBadge quality={entryQuality(record)}/></td><td>{time(record.updatedAt)}</td></tr>;
        })}</tbody>
      </table></div>
    </TechnicalDetails> : null}
  </Section>;
}

export function FinopsAi({ report, language }: { report: FinopsReport; language: Language }) {
  const { copy, money, time, count: fmt } = finopsCopy(language);
  const { ai, metrics } = report;
  const estimate = ai?.costEstimate, calls = ai?.calls.requests ?? 0;
  const periodLabel = copy('{0} to {1} UTC', report.period.from, inclusiveEnd(report.period));
  const dailyMax = Math.max(0, ...ai?.daily.map(day => day.estimate ?? 0) ?? []);
  return <Section id="finops-ai" title={copy("AI Economics")} description={periodLabel + ' · ' + copy('Server telemetry and scoped AI billing.')}>
    {ai ? <>
      <div className="admin-kpis">
        <Kpi label={copy("Recorded provider calls")} value={calls ? fmt(calls) : copy('Unavailable')} note={copy('PARTIAL · FinOps samples')}/>
        <Kpi label={copy("Captured success / failure")} value={calls ? `${fmt(ai.calls.successes)} / ${fmt(calls - ai.calls.successes)}` : copy('Unavailable')}
          note={calls ? copy('{0}% success · PARTIAL', fmt(100 * ai.calls.successes / calls)) : 'UNAVAILABLE'}/>
        <Kpi label={copy("Mean provider call latency")} value={ai.calls.meanLatency === null ? copy('Unavailable') : fmt(ai.calls.meanLatency) + ' ms'} note={copy('Recorded calls')}/>
        <Kpi label={copy("Observed chat interactions")} value={ai.chats.observed ? fmt(ai.chats.observed) : copy('Unavailable')} note={`PARTIAL · Web ${fmt(ai.chats.web)}, Channel Core ${fmt(ai.chats.channels)}`}/>
        <Kpi label={copy("Tool calls / failures")} value={ai.toolCalls || calls ? `${fmt(ai.toolCalls)} / ${fmt(ai.toolFailures)}` : copy('Unavailable')} note={copy('Copilot server interpretations')}/>
        <Kpi label={copy("Provider and ledger AI costs")} value={money(metrics.aiCost.amount)} note={metrics.aiCost.quality}/>
        <Kpi label={copy("AI list-price estimate")} value={money(estimate?.amount ?? null)} note={(estimate?.quality ?? 'UNAVAILABLE') + ' · ' + copy('{0} priced calls', fmt(ai.calls.pricedRequests))}/>
        <Kpi label={copy("Estimated cost per priced call")} value={money(estimate?.amount && ai.calls.pricedRequests ? Number(estimate.amount) / ai.calls.pricedRequests : null)}
          note={estimate?.amount ? copy('PARTIAL · Captured priced calls') : 'UNAVAILABLE'}/>
      </div>
      <p className="admin-diff">{[
        copy('Last sample {0}. Input usage was reported for {1} of {2} captured calls ({3} missing). Output usage was reported for {4} ({5} missing).',
          time(ai.freshness), fmt(ai.calls.inputSamples), fmt(calls), fmt(calls - ai.calls.inputSamples), fmt(ai.calls.outputSamples), fmt(calls - ai.calls.outputSamples)),
        copy('Web counts are observed interpretations. Channel Core counts are observed server turns. MCP and Developer API have no model-call coverage here.'),
        ai.coverage.outsideRetention && copy('This range exceeds telemetry retention.'),
        ai.coverage.truncated && copy('The report reached its telemetry row limit.'),
        !ai.coverage.ledgerAvailable && copy('Detailed AI telemetry is unavailable until the FinOps ledger migration is applied.'),
      ].filter(Boolean).join(' ')}</p>
      <p className="admin-diff">{copy('Pricing uses the provider’s response model and versioned USD standard rates where token dimensions are complete. Reasoning is included in billed output. These estimates are reported separately from provider charges.')}</p>
      {ai.models.length ? <div className="admin-table-wrap"><table className="admin-table" aria-label={copy('Measured AI usage by provider, model, and surface')}>
        <thead><tr><th>{copy("Provider and response model")}</th><th>{copy("Surface")}</th><th>{copy("Calls")}</th><th>{copy("Input")}</th><th>{copy("Output")}</th><th>{copy("Reasoning")}</th><th>{copy("Cached input")}</th><th>{copy("Estimated cost")}</th></tr></thead>
        <tbody>{ai.models.map(({ usage, estimate: total, pricedRequests }) =>
          <tr key={[usage.provider, usage.model, usage.surface].join(':')}><th scope="row">{usage.provider} / {usage.model || copy('Unknown response model')}</th>
            <td>{SURFACE[usage.surface]}</td><td>{fmt(usage.requests)}</td>
            {([['input_tokens', 'input_samples'], ['output_tokens', 'output_samples'], ['reasoning_tokens', 'reasoning_samples'], ['cached_input_tokens', 'cached_input_samples']] as const)
              .map(([field, samples]) => <td key={field}>{usage[samples] ? copy('{0} ({1} samples)', fmt(usage[field]), fmt(usage[samples])) : copy('Unavailable')}</td>)}
            <td>{money(total)} <QualityBadge quality={total === null ? 'UNAVAILABLE' : pricedRequests === usage.requests ? 'ESTIMATED' : 'PARTIAL'}/></td></tr>)}</tbody>
      </table></div> : <p className="admin-empty">{copy("No model-call samples were recorded in this period.")}</p>}
      {ai.daily.length > 0 ? <TechnicalDetails summary={copy("Daily AI estimate and request coverage")} open>
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{copy("UTC day")}</th><th>{copy("Requests")}</th><th>{copy("Priced requests")}</th><th>{copy("List-price estimate")}</th></tr></thead>
          <tbody>{ai.daily.map(day => <tr key={day.day}><th scope="row">{day.day}</th><td>{fmt(day.requests)}</td><td>{fmt(day.pricedRequests)}</td>
            <td>{money(day.estimate)} <QualityBadge quality={day.estimate === null ? 'UNAVAILABLE' : day.pricedRequests === day.requests ? 'ESTIMATED' : 'PARTIAL'}/>
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
    </> : <p className="admin-alert" role="status" data-tone="warn">{copy("AI telemetry is temporarily unavailable.")}</p>}
  </Section>;
}

export function FinopsWorkflow({ report, language }: { report: FinopsReport; language: Language }) {
  const { copy, time, count: fmt } = finopsCopy(language);
  const { workflow } = report;
  return <Section id="finops-workflow" title={copy("Workflow Economics")} description={copy('Canonical multi-step mainnet workflow runs. Status changes use the recorded date. Single-flow and legacy operations are outside this counting cohort.')}>
    {workflow ? <>
      <div className="admin-kpis">
        {([['Created', workflow.created], ['Started mode', workflow.advanced], ['Completed and reconciled', workflow.completed],
          ['Failed or halted', workflow.failed], ['Cancelled or expired', workflow.abandoned], ['Average steps at creation', workflow.averageSteps]] as const)
          .map(([label, value]) => <Kpi key={label} label={copy(label)} value={value === null ? copy('Unavailable') : fmt(value)} note={copy('PARTIAL · canonical cohort')}/>)}
      </div>
      <p className="admin-diff">{copy('Last durable workflow update {0}. Complete approval, simulation and retry counts across surfaces are unavailable.', time(workflow.newest))}</p>
      {workflow.dimensions.length ? <div className="admin-table-wrap"><table className="admin-table" aria-label={copy('Planned actions in new canonical workflows')}>
        <thead><tr><th>{copy("Planned action")}</th><th>{copy("Network")}</th><th>{copy("Protocol")}</th><th>{copy("Count")}</th></tr></thead>
        <tbody>{workflow.dimensions.map(row => <tr key={[row.action, row.network, row.protocol].join(':')}><th scope="row">{row.action}</th>
          <td>{row.network}</td><td>{row.protocol}</td><td>{fmt(row.count)}</td></tr>)}</tbody>
      </table></div> : null}
    </> : <p role="status" className="admin-alert" data-tone="warn">{copy("Workflow economics are temporarily unavailable.")}</p>}
    <IndicatorCards report={report} language={language} keys={['directSimulated', 'directCompleted', 'costPerCompleted']}/>
  </Section>;
}

export function FinopsRevenue({ report, language }: { report: FinopsReport; language: Language }) {
  const { copy } = finopsCopy(language);
  return <Section id="finops-revenue" title={copy("Revenue & Margins")} description={copy("Actual fee revenue is recognized through reconciled accounting records.")}>
    <IndicatorCards report={report} language={language} keys={['revenue', 'variable', 'contribution', 'infrastructure', 'result', 'breakEvenRevenue']}/>
    <p className="admin-diff">{copy("Gross transaction volume, fee-eligible volume, and expected fee revenue are unavailable. Deferred 10 bps obligations do not contribute to collected revenue.")}</p>
  </Section>;
}

export function FinopsCoverage({ language }: { language: Language }) {
  const { copy } = finopsCopy(language);
  return <Section id="finops-coverage" title={copy("Data quality and methodology")}>
    <dl className="admin-finops-assumptions">
      {Object.entries({ VERIFIED: 'Provider-confirmed billing or reconciled accounting record', METERED: 'Measured usage and an applicable rate',
        ESTIMATED: 'Model or stated assumption', PARTIAL: 'Known subset of the required inputs', UNAVAILABLE: 'Insufficient input or access' })
        .map(([key, label]) => <div key={key}><dt>{key}</dt><dd>{copy(label)}</dd></div>)}
    </dl>
    <ul>{REPORT_LIMITATIONS.map(text => <li key={text}>{copy(text)}</li>)}</ul>
  </Section>;
}

export function finopsFilterQuery(filter: PeriodFilter) {
  const search = new URLSearchParams({ range: filter.preset });
  if (filter.preset === 'custom') { search.set('from', filter.period.from); search.set('to', addDays(filter.period.to, -1)); }
  return search;
}
