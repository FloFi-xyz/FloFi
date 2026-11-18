// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ENTRY_SOURCES, FINOPS_ENVIRONMENTS, FINOPS_SCOPES, scopeIds, type ScopeId } from '../../admin/finops/economics';
import { modelScenario, parseScenario, SCENARIO_FIELDS, SCENARIO_PRESETS, scenarioKeys, type Scenario } from '../../admin/finops/scenario';
import { adminPost } from './admin-client';
import { Kpi } from './admin-ui';
import { useLocale } from '../../i18n/locale';
import { finopsCopy } from './finops-copy';

export type RelativeFilter = { range: string; from?: string; to?: string };
const ERRORS: Readonly<Record<string, string>> = {
  FINOPS_PERIOD_CONFLICT: 'A conflicting record overlaps this service, environment, and source. To correct an existing record, use its ID and the same billing period.',
  FINOPS_ENTRY_INVALID: 'Check the marked input and submit again.', FINOPS_PROVIDER_NO_COST_DATA: 'The provider returned no scoped cost records for these days.',
  FINOPS_PROVIDER_NOT_CONFIGURED: 'This provider is unavailable for the current tenant.', FINOPS_LEDGER_NOT_CONFIGURED: 'The billing ledger has not been provisioned.',
  FINOPS_SYNC_RANGE_TOO_LARGE: 'Choose no more than 92 closed days to synchronize.', FINOPS_SYNC_NO_CLOSED_DAYS: 'The selected period has no closed UTC day to synchronize.',
  FINOPS_PROVIDER_RETRY_LATER: 'The billing provider requested a wait. Try again later.',
  FINOPS_SYNC_RATE_LIMITED: 'Too many synchronization requests. Wait a minute before trying again.',
  FINOPS_SYNC_SUPERSEDED: 'A newer synchronization for this period finished first. Refresh to view its records.',
  FINOPS_EXPORT_UNAVAILABLE: 'The report is temporarily unavailable.',
};
const message = (code: string) => ERRORS[code] ?? 'The request could not be completed. Your saved records are preserved.';

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
      <div className="admin-form-row">{scenarioKeys.map(key => {
        const { label, max, step } = SCENARIO_FIELDS[key];
        return <label className="admin-field" key={key}>{copy(label)}
          <input type="number" min="0" max={max} step={step} value={input[key] ?? ''}
            onChange={event => setInput(previous => ({ ...previous, [key]: event.target.value }))}/>
        </label>;
      })}</div>
    </form>
    {assumptions && result ? <>
      <div className="admin-kpis" aria-label={copy("Estimated monthly results")}>
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
