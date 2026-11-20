// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { addDays, ENTRY_SOURCES, FINOPS_ENVIRONMENTS, FINOPS_SCOPES, scopeIds, type ScopeId } from '../../admin/finops/economics';
import { modelScenario, parseScenario, SCENARIO_FIELDS, SCENARIO_PRESETS, scenarioKeys, type Scenario } from '../../admin/finops/scenario';
import { adminPost } from './admin-client';
import { Kpi, Status } from './admin-ui';
import { useLocale } from '../../i18n/locale';
import { finopsCopy } from './finops-copy';
import type { FinopsReport } from '../../admin/finops/report';
import { FINANCIAL_CONNECTION_GUIDANCE, FINANCIAL_CONNECTION_LABELS, FINANCIAL_LIMITATION_LABELS, FINANCIAL_SYNC_ERROR_LABELS,
  type FinancialConnection } from '../../admin/finops/sync-labels';

export type RelativeFilter = { range: string; from?: string; to?: string };
const ERRORS: Readonly<Record<string, string>> = {
  FINOPS_PERIOD_CONFLICT: 'A conflicting record overlaps this service, environment, and source. To correct an existing record, use its ID and the same billing period.',
  FINOPS_ENTRY_INVALID: 'Check the marked input and submit again.', FINOPS_PROVIDER_NO_COST_DATA: 'The provider returned no scoped cost records for these days.',
  FINOPS_PROVIDER_NOT_CONFIGURED: 'This provider is unavailable for the current tenant.', FINOPS_LEDGER_NOT_CONFIGURED: 'The billing ledger has not been provisioned.',
  FINOPS_SYNC_RANGE_TOO_LARGE: 'Choose no more than 92 closed days to synchronize.', FINOPS_SYNC_NO_CLOSED_DAYS: 'The selected period has no closed UTC day to synchronize.',
  FINOPS_PROVIDER_RETRY_LATER: 'The billing provider requested a wait. Try again later.',
  FINOPS_SYNC_RATE_LIMITED: 'Too many synchronization requests. Wait a minute before trying again.',
  FINOPS_SYNC_SUPERSEDED: 'A newer synchronization for this period finished first. Refresh to view its records.',
  ...FINANCIAL_SYNC_ERROR_LABELS,
  FINOPS_EXPORT_UNAVAILABLE: 'The report is temporarily unavailable.',
};
const message = (code: string) => ERRORS[code] ?? 'The request could not be completed. Your saved records are preserved.';

/**
 * BUILD-FLOFI-UX-EDITOR-FINOPS-001: the existing reporting period form (GET range/from/to, UTC, same boundaries), compact: the custom start and
 * last day appear only when "Custom dates" is chosen. Nothing is queried until Apply period submits the same parameters as before.
 */
export function FinopsPeriodForm({ action, preset, from, to, options }: { action: string; preset: string; from?: string | undefined; to?: string | undefined;
  options: readonly { readonly value: string; readonly label: string }[] }) {
  const { copy } = finopsCopy(useLocale().language);
  const [range, setRange] = useState(preset);
  const select = useRef<HTMLSelectElement>(null);
  // A browser may restore the select's value on Back: the dates follow what the select really shows.
  useEffect(() => { if (select.current && select.current.value !== preset) setRange(select.current.value); }, [preset]);
  const custom = range === 'custom';
  return <form className="admin-filters admin-finops-period-form" action={action} method="get" aria-label={copy("Financial reporting period")}>
    <label>{copy("Period")}<select ref={select} name="range" aria-label={copy("Period")} defaultValue={preset} onChange={event => setRange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    <fieldset className="admin-finops-custom-dates" hidden={!custom} disabled={!custom}>
      <legend className="admin-sr">{copy('Custom dates')}</legend>
      <label>{copy("Custom start (UTC)")}<input type="date" name="from" defaultValue={from} required={custom}/></label>
      <label>{copy("Custom last day (UTC)")}<input type="date" name="to" defaultValue={to} required={custom}/></label>
    </fieldset>
    <button className="admin-button" type="submit">{copy("Apply period")}</button>
  </form>;
}

const STATUS_TONE: Readonly<Record<FinancialConnection, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'>> = {
  SYNCHRONIZING: 'info', MANUAL_ONLY: 'neutral', UNCONFIGURED: 'neutral', NOT_ENTITLED: 'warn', ERROR: 'bad',
  STALE: 'warn', SYNCHRONIZED: 'ok', USAGE_SYNCHRONIZED: 'ok', AWAITING_SYNC: 'info',
};

export function FinopsIntegrations({ integrations, csrf }: { integrations: FinopsReport['integrations']; csrf?: string }) {
  const { copy, time, count, display } = finopsCopy(useLocale().language), router = useRouter();
  const [requested, setRequested] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false), requestInFlight = useRef(false);
  const active = integrations.providers.some(provider => provider.active);
  useEffect(() => {
    if (!active && !requested) return;
    // Refresh from durable storage while a job runs. Calls to external billing
    // APIs are made exclusively by the worker.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, 25_000);
    const afterRequest = requested ? window.setTimeout(() => setRequested(false), 100_000) : undefined;
    return () => { window.clearInterval(timer); window.clearTimeout(afterRequest); };
  }, [active, requested, router]);
  async function queue(provider: string) {
    if (!csrf || requestInFlight.current) return;
    requestInFlight.current = true; setBusy(true); setFeedback(null);
    try {
      const response = await adminPost<{ queued: string[]; deferred: string[] }>('/admin/api/finops/import', { action: 'queue-sync', provider }, csrf);
      if (!response.ok) { setFeedback({ error: true, text: copy(message(response.code)) }); return; }
      setFeedback({ error: false, text: copy('{0} queued, {1} already scheduled or in progress.', count(response.queued.length), count(response.deferred.length)) });
      setRequested(response.queued.length > 0);
      router.refresh();
    } finally {
      requestInFlight.current = false; setBusy(false);
    }
  }
  if (!integrations.available) return <p role="status">{copy('Automatic synchronization is awaiting database activation.')}</p>;
  return <>
    {csrf && <div className="admin-actions"><button type="button" className="admin-button" disabled={busy || !integrations.providers.some(provider => provider.configured)}
      onClick={() => void queue('all')}>{copy('Sync all')}</button></div>}
    {feedback && <p className="admin-alert" role={feedback.error ? 'alert' : 'status'} data-tone={feedback.error ? 'bad' : 'ok'}>{feedback.text}</p>}
    <p className="admin-diff">{copy('Metered usage and estimates are shown separately from recorded costs.')}</p>
    <div className="admin-table-wrap"><table className="admin-table admin-finops-integrations" aria-label={copy('Financial integrations')}>
      <thead><tr>{['Provider', 'Connection', 'Financial data', 'Current-period cost', ...(csrf ? ['Actions'] : [])]
        .map(label => <th key={label} scope="col" className={label === 'Current-period cost' ? 'admin-num' : undefined}>{copy(label)}</th>)}</tr></thead>
      <tbody>{integrations.providers.map(provider => {
        const recent = provider.coverage[0];
        // A confirmed-empty period is a coverage gap, not a synchronized period. It stays listed under the historical coverage.
        const synchronized = provider.coverage.filter(coverage => coverage.quality !== 'UNAVAILABLE').length;
        // A failed historical period records its closed error code as the gap's limitation.
        const limitation = (code: string) => copy(FINANCIAL_LIMITATION_LABELS[code] ?? FINANCIAL_SYNC_ERROR_LABELS[code] ?? code);
        const measurements = (value: number) => value === 1 ? copy('1 usage measurement') : copy('{0} usage measurements', count(value));
        const status = provider.connection;
        const error = provider.configured ? provider.errorCode : null;
        const accessError = error === 'FINOPS_PROVIDER_FORBIDDEN' || error === 'FINOPS_PROVIDER_NOT_ENTITLED' || error === 'FINOPS_PROVIDER_ACCESS_DENIED';
        const providerGuidance = FINANCIAL_CONNECTION_GUIDANCE[provider.id];
        const guidance = error === 'FINOPS_PROVIDER_SCOPE_MISMATCH' ? 'Verify the provider scope on the worker before retrying.'
          : accessError ? providerGuidance ?? 'Review billing access or record an invoice.'
            : status === 'UNCONFIGURED' || status === 'MANUAL_ONLY' ? providerGuidance : null;
        // BUILD-FLOFI-UX-EDITOR-FINOPS-001: provider, connection, data available, recorded cost and the action first; the sync times, data quality,
        // historical coverage and the provider's own message one click away (a problem is still said by the connection state itself).
        return <tr key={provider.id} data-status={status}><th scope="row">{copy(provider.name)}</th>
          <td><Status tone={STATUS_TONE[status]}>{copy(FINANCIAL_CONNECTION_LABELS[status])}</Status>
            {(error || guidance) && <p className="admin-diff">{[error ? message(error) : null, guidance].filter(Boolean).map(line => copy(line!)).join(' ')}</p>}</td>
          <td>{synchronized === 1 ? copy('1 synchronized period') : synchronized > 0 ? copy('{0} synchronized periods', count(synchronized)) : copy('No synchronized period')}
            {recent?.limitations.length ? <p className="admin-diff">{copy('Coverage limitations')}: {recent.limitations.map(limitation).join(' · ')}</p> : null}
          <details className="admin-finops-row-details"><summary>{copy('Sync details')}</summary><dl>
            <div><dt>{copy('Last successful sync')}</dt><dd>{time(provider.lastSuccess)}</dd></div>
            <div><dt>{copy('Next scheduled sync')}</dt><dd>{time(provider.nextSync)}</dd></div>
            {/* Its limitations are already stated under the financial data, never twice. */}
            <div><dt>{copy('Data quality')}</dt><dd>{recent ? copy(recent.quality) : copy('Unavailable')}</dd></div>
            <div><dt>{copy('Historical coverage')}</dt><dd>{provider.coverage.length > 0 ? <><ul>{provider.coverage.map(coverage => <li key={coverage.period.from}>
                {copy('{0} to {1} UTC', coverage.period.from, addDays(coverage.period.to, -1))} · {copy(coverage.quality)} · {measurements(coverage.meterCount)}
                {coverage.quality === 'UNAVAILABLE' && coverage.limitations.length ? ' · ' + coverage.limitations.map(limitation).join(' · ') : null}</li>)}</ul>
              {provider.meters.length > 0 && <ul>{provider.meters.slice(0, 100).map((meter, index) =>
                <li key={index}>{meter.service} · {meter.metric} · {meter.amount} {meter.unit}{meter.basis ? ' · ' + meter.basis : ''}</li>)}</ul>}</> : copy('No synchronized period')}</dd></div>
          </dl></details></td>
          <td className="admin-num">{(() => { const shown = display(provider.cost.amount);
            return <span className="admin-amount" title={shown.text === shown.exact ? undefined : copy('Recorded value: {0}', shown.exact)}>{shown.text}
              {shown.text === shown.exact ? null : <span className="admin-sr"> ({copy('Recorded value: {0}', shown.exact)})</span>}</span>; })()}
            {provider.cost.amount !== null && <p className="admin-diff">{copy(provider.cost.quality)}</p>}</td>
          {csrf && <td><button type="button" className="admin-button" data-size="sm" disabled={busy || provider.active || !provider.configured}
            onClick={() => void queue(provider.id)}>{copy('Sync now')}</button></td>}
        </tr>;
      })}</tbody>
    </table></div>
  </>;
}

function EntryFields() {
  const { copy } = finopsCopy(useLocale().language);
  return <>
    <div className="admin-form-row">
      <label className="admin-field">{copy("FloFi provider and service")}<select name="scope" required>
        {scopeIds.map(id => <option key={id} value={id}>{FINOPS_SCOPES[id].provider} / {FINOPS_SCOPES[id].name}</option>)}
      </select></label>
      <label className="admin-field">{copy("Environment")}<select name="environment" required>{FINOPS_ENVIRONMENTS.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="admin-field">{copy("Start date (UTC)")}<input required name="start" type="date"/></label>
      <label className="admin-field">{copy("End date, exclusive (UTC)")}<input required name="end" type="date"/></label>
      <label className="admin-field">{copy("Verification source")}<select name="source" required>
        {ENTRY_SOURCES.map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label className="admin-field">{copy("Coverage")}<select name="coverage" required defaultValue="PARTIAL"><option value="PARTIAL">{copy("Partial or pending")}</option>
        <option value="FULL">{copy("Entire service period confirmed")}</option></select></label>
      <label className="admin-field">{copy("Billing currency")}<input name="currency" type="text" defaultValue="USD" pattern="[A-Z]{3}" maxLength={3} required/></label>
      <label className="admin-field">{copy("Net amount")}<input name="net" type="text" inputMode="decimal" maxLength={20} required/></label>
      <label className="admin-field">{copy("Invoice or measurement reference")}<input name="reference" type="text" maxLength={80} required/></label>
    </div>
    <details className="admin-details">
      <summary>{copy("Charge components, currency conversion, or correction")}</summary>
      <div className="admin-details-body admin-form-row">
        {([['gross', 'Gross charges'], ['credits', 'Credits'], ['discounts', 'Discounts'], ['taxes', 'Taxes'],
          ['fxUsd', 'USD per unit of billing currency']] as const).map(([name, label]) => <label key={name} className="admin-field">{copy(label)}
          <input type="text" name={name} inputMode="decimal" maxLength={20}/></label>)}
        <label className="admin-field">{copy("Conversion source and date")}<input type="text" name="fxSource" maxLength={80}/></label>
        <label className="admin-field">{copy("Replace current entry ID")}<input type="text" name="replaceId" inputMode="numeric" maxLength={19}/></label>
      </div>
    </details>
    <label className="admin-field">{copy("Notes (optional)")}<textarea name="notes" maxLength={400}/></label>
  </>;
}

export function FinopsImports({ csrf, adapters, filter }: { csrf: string; adapters: readonly ScopeId[]; filter: RelativeFilter }) {
  const { copy, count } = finopsCopy(useLocale().language);
  const router = useRouter(), working = useRef(false);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  async function send(body: Record<string, unknown>) {
    if (working.current) return;
    working.current = true; setBusy(true); setStatus(null);
    try {
      const result = await adminPost<{ inserted: number; duplicate: number; field?: string }>('/admin/api/finops/import', body, csrf);
      if (!result.ok) {
        const field = 'field' in result && typeof result.field === 'string' ? ' (' + result.field + ')' : '';
        setStatus({ error: true, text: copy(message(result.code)) + field });
      } else {
        setStatus({ error: false, text: copy('{0} saved, {1} already recorded.', count(result.inserted), count(result.duplicate)) });
        router.refresh();
      }
    } finally { working.current = false; setBusy(false); }
  }
  function manual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { replaceId, ...entry } = Object.fromEntries(new FormData(event.currentTarget));
    void send({ action: 'manual', entry, ...replaceId ? { replaceId } : {} });
  }
  function csv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send({ action: 'csv', csv: new FormData(event.currentTarget).get('csv') });
  }
  return <div className="admin-form">
    <p className="admin-diff">{copy("Record only FloFi’s allocation from shared invoices. Invoice and accounting entries require checked evidence. Keep customer data, credentials, and full invoices out of notes.")}</p>
    <details className="admin-details">
      <summary>{copy("Enter a financial record")}</summary>
      <form className="admin-details-body admin-form" onSubmit={manual}>
        <EntryFields/>
        <div><button type="submit" className="admin-button" disabled={busy}>{copy("Save financial record")}</button></div>
      </form>
    </details>
    <details className="admin-details">
      <summary>{copy("Import CSV")}</summary>
      <form className="admin-details-body admin-form" onSubmit={csv}>
        <p className="admin-diff">{copy("Paste up to 100 rows with these headers. Optional headers are gross, credits, discounts, taxes, fxUsd, fxSource, and notes.")}</p>
        <label className="admin-field">{copy("CSV data")}<textarea name="csv" required maxLength={14000}
          placeholder="scope,environment,start,end,source,reference,currency,net,coverage"/></label>
        <div><button type="submit" className="admin-button" disabled={busy}>{copy("Import financial records")}</button></div>
      </form>
    </details>
    {adapters.length > 0 ? <div className="admin-actions">{adapters.map(scope => <button className="admin-button" type="button" key={scope} disabled={busy}
      onClick={() => void send({ ...filter, action: 'sync', scope })}>{copy('Synchronize {0} for this period', FINOPS_SCOPES[scope].provider)}</button>)}</div> :
      <p className="admin-diff">{copy("Live billing synchronization is unavailable. You can record or import provider invoices.")}</p>}
    {busy ? <p role="status">{copy("Saving financial data…")}</p> : null}
    {status ? <p className="admin-alert" role={status.error ? 'alert' : 'status'} data-tone={status.error ? 'bad' : 'ok'}>{status.text}</p> : null}
  </div>;
}

const SCENARIO_GROUPS: readonly (readonly [string, readonly (keyof Scenario)[]])[] = [
  ['User and activity assumptions', ['users', 'chats']], ['Workflow and completion assumptions', ['workflows', 'completion']],
  ['Revenue assumptions', ['eligibleVolume', 'fee']], ['Variable costs', ['ai', 'workflowCost']], ['Gas sponsorship assumptions', ['gas']],
  ['Fixed infrastructure costs', ['infrastructure']]];

function Assumptions({ values }: { values: Scenario }) {
  const { copy, count } = finopsCopy(useLocale().language);
  return <dl className="admin-finops-assumptions">{scenarioKeys.map(key => <div key={key}><dt>{copy(SCENARIO_FIELDS[key].label)}</dt><dd>{count(values[key])}</dd></div>)}</dl>;
}

export function FinopsScenario({ investor }: { investor?: { csrf: string; filter: RelativeFilter } }) {
  const { copy, money, count } = finopsCopy(useLocale().language);
  const [input, setInput] = useState<Record<string, string>>({}), [exporting, setExporting] = useState(false), [error, setError] = useState<string | null>(null);
  const exportLock = useRef(false);
  const assumptions = parseScenario(input), result = assumptions ? modelScenario(assumptions) : null;
  async function exportCsv() {
    if (!investor || exportLock.current) return;
    exportLock.current = true; setExporting(true); setError(null);
    try {
      const response = await fetch('/admin/api/finops/export', { method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-flofi-admin-csrf': investor.csrf },
        body: JSON.stringify({ ...investor.filter, ...assumptions ? { scenario: input } : {} }) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/csv')) throw new Error('FINOPS_EXPORT_UNAVAILABLE');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url; link.download = 'flofi-finops-report.csv'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError(copy(ERRORS.FINOPS_EXPORT_UNAVAILABLE!)); }
    finally { exportLock.current = false; setExporting(false); }
  }
  return <div className="admin-form">
    <form className="admin-form admin-finops-no-print" onSubmit={event => event.preventDefault()}>
      <p className="admin-diff">{copy("ESTIMATED · Enter monthly assumptions to compare with the records above. Workflow unit costs exclude AI and sponsored gas.")}</p>
      <div className="admin-actions" aria-label={copy("Active user scenarios")}>{SCENARIO_PRESETS.map(users => <button type="button" className="admin-button" key={users}
        onClick={() => setInput(previous => ({ ...previous, users: String(users) }))} aria-pressed={input.users === String(users)}>{copy('{0} users', count(users))}</button>)}</div>
      {/* BUILD-FLOFI-UX-EDITOR-FINOPS-001: the same assumptions, grouped by what they describe (inputs only; results are below and marked ESTIMATED). */}
      <div className="admin-finops-scenario-groups">{SCENARIO_GROUPS.map(([title, keys]) => <fieldset key={title} className="admin-finops-scenario-group">
        <legend>{copy(title)}</legend>
        {keys.map(key => {
          const { label, max, step } = SCENARIO_FIELDS[key];
          return <label className="admin-field" key={key}>{copy(label)}
            <input type="number" min="0" max={max} step={step} value={input[key] ?? ''}
              onChange={event => setInput(previous => ({ ...previous, [key]: event.target.value }))}/>
          </label>;
        })}</fieldset>)}</div>
    </form>
    {assumptions && result ? <>
      <h3 className="admin-finops-subhead">{copy('Estimated monthly results')} <Status tone="info">ESTIMATED</Status></h3>
      <p className="admin-diff">{copy('Scenario outputs from the assumptions above — not recorded financial performance.')}</p>
      <div className="admin-kpis admin-finops-estimates" aria-label={copy("Estimated monthly results")}>
        {([['Monthly chats', count(result.chats)], ['Initiated workflows', count(result.workflows)], ['Completed workflows', count(result.completed)],
          ['Fee-eligible volume', money(result.eligibleVolume)], ['AI expenditure', money(result.ai)], ['Workflow expenditure', money(result.workflow)],
          ['Sponsored gas', money(result.gas)], ['Operating costs', money(result.total)], ['Collected fee revenue', money(result.revenue)],
          ['Contribution margin', money(result.contribution)], ['Infrastructure-adjusted result', money(result.result)],
          ['Break-even active users', result.breakEvenUsers === null ? copy('Unreachable at these assumptions') : count(result.breakEvenUsers)],
          ['Break-even workflow volume', result.breakEvenWorkflows === null ? copy('Unavailable') : count(result.breakEvenWorkflows)]] as const)
          .map(([label, value]) => <Kpi key={label} label={copy(label)} value={value} note="ESTIMATED"/>)}
      </div>
      <div className="admin-table-wrap"><table className="admin-table" aria-label={copy("Estimated outcomes at each growth scenario")}>
        <thead><tr><th>{copy("Active users")}</th><th>{copy("Workflows")}</th><th>{copy("Revenue")}</th><th>{copy("Operating costs")}</th><th>{copy("Operating result")}</th></tr></thead>
        <tbody>{SCENARIO_PRESETS.map(users => {
          const model = modelScenario({ ...assumptions, users });
          return <tr key={users}><th scope="row">{count(users)}</th><td>{count(model.workflows)}</td><td>{money(model.revenue)}</td>
            <td>{money(model.total)}</td><td>{money(model.result)}</td></tr>;
        })}</tbody>
      </table></div>
      {investor ? <Assumptions values={assumptions}/> : null}
    </> : <p className="admin-empty">{copy("All scenario assumptions are required to calculate an estimate.")}</p>}
    {investor ? <div className="admin-actions admin-finops-no-print">
      <button className="admin-button" type="button" onClick={() => void exportCsv()} disabled={exporting}>{copy(exporting ? 'Preparing CSV…' : 'Download investor CSV')}</button>
      <button className="admin-button" type="button" onClick={() => window.print()}>{copy("Print or save PDF")}</button>
    </div> : null}
    {error ? <p role="alert" className="admin-alert" data-tone="bad">{error}</p> : null}
  </div>;
}
