// SPDX-License-Identifier: AGPL-3.0-only
import { adminPage } from '../../../admin/page-context';
import { CATEGORIES, CATEGORY_LABELS, explainCode } from '../../../admin/support/codes';
import { incidentStatus, STATUS_LABELS, type Note } from '../../../admin/support/diagnostics';
import { FEATURE_LABELS, INCIDENT_LIFECYCLE_LABELS, SEVERITY_LABELS, type Incident } from '../../../admin/support/incidents';
import { OBSERVATION_LABELS } from '../../../admin/support/lifecycle';
import { ELIGIBILITY_LABELS, ELIGIBILITY_ORDER, RECOVERY_ACTIONS, type EligibilityState } from '../../../admin/support/registry';
import { countIncidents, HISTORY_ROWS, inIncidentScope, supportFilters, supportView } from '../../../admin/support/view';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { Kpi, Section, Status, TechnicalDetails, type Tone } from '../../../components/admin/admin-ui';
import { fmt } from '../../../components/admin/charts';
import { SupportSearch } from '../../../components/admin/support-console';
import { finopsCopy } from '../../../components/admin/finops-copy';
import { requestLanguage } from '../../../server/request-language';
import type { Language } from '../../../i18n/language';

type Search = Promise<Record<string, string | string[] | undefined>>;
const ELIGIBILITY_TONE: Record<EligibilityState, Tone> = { RECOVERABLE_NOW: 'ok', REQUIRES_CONFIRMATION: 'info', WAITING_EXTERNAL: 'neutral', USER_ACTION: 'info',
  ENGINEERING: 'bad', INVESTIGATION: 'warn', NONE: 'neutral' };
const SEVERITY_TONE: Record<Incident['severity'], Tone> = { HIGH: 'bad', MEDIUM: 'warn', LOW: 'neutral' };
const FUNDS: Record<Incident['funds'], string> = { NONE: 'No funds involved', POSSIBLE: 'Funds may be involved', TEST_ONLY: 'Test or mocked funds only',
  UNKNOWN: 'Funds: unknown' };
const ENVIRONMENT: Record<string, string> = { MAINNET: 'Mainnet', TESTNET: 'Testnet / Devnet', MOCKED: 'Mocked (local)' };
const SOURCE_LABELS: Record<string, string> = { EXECUTION: 'Executions', BACKGROUND_TASK: 'Background tasks', WORKFLOW_RUN: 'Multi-step workflows',
  DELEGATED_EXECUTION: 'Delegated executions', PLATFORM: 'System Health', AI_COPILOT: 'AI Copilot' };
const incidentHref = (id: string) => `/admin/support/incident?id=${encodeURIComponent(id)}`;
const LIFECYCLE_TONE: Record<Incident['lifecycle'], Tone> = { ACTIVE: 'warn', UNDER_INVESTIGATION: 'info', HISTORICAL: 'neutral', VERIFIED_RESOLVED: 'ok', FINAL: 'neutral' };
const LIFECYCLE_OPTIONS = [['OPEN', 'Open (active + under investigation)'], ['ACTIVE', 'Active'], ['UNDER_INVESTIGATION', 'Under investigation'],
  ['HISTORICAL', 'Historical attention'], ['VERIFIED_RESOLVED', 'Verified resolved'], ['FINAL', 'Final failures (informational)'], ['ALL', 'All']] as const;
const EVIDENCE = { ARCHIVED: 'Evidence archived', RECORDED: 'Evidence recorded', NO_BUNDLE: 'No Evidence Bundle', UNAVAILABLE: 'Evidence status unavailable' } as const;

function IncidentList({ incidents, notes, language }: { incidents: readonly Incident[]; notes: ReadonlyMap<string, readonly Note[]>; language: Language }) {
  const { copy, time } = finopsCopy(language);
  return <ul className="admin-incidents">{incidents.map(incident => {
    const status = incidentStatus(notes.get(incident.id) ?? []);
    const check = incident.transactionCheck;
    return <li key={incident.id} className="admin-incident" data-severity={incident.severity}>
      <div>
        <div className="admin-incident-meta">
          <Status tone={SEVERITY_TONE[incident.severity]}>{copy(SEVERITY_LABELS[incident.severity])}</Status>
          <span>{copy(CATEGORY_LABELS[incident.category])}</span><span aria-hidden="true">·</span><span>{copy(FEATURE_LABELS[incident.feature])}</span>
          {incident.environment || incident.provenance ? <><span aria-hidden="true">·</span><span>{incident.environment ? copy(ENVIRONMENT[incident.environment]!)
            : <>Provenance <code>{incident.provenance}</code></>}{incident.networks.length ? ` (${incident.networks.join(', ')})` : ''}</span></> : null}
        </div>
        <h3><a href={incidentHref(incident.id)}>{copy(incident.title)}</a></h3>
        <p>{copy(incident.summary)}</p>
        <div className="admin-incident-meta"><code>{incident.component}</code><span>{copy(incident.outcome)}</span>
          {incident.funds !== 'NONE' ? <strong>{copy(FUNDS[incident.funds])}</strong> : null}
          {incident.evidence ? <span>{copy(EVIDENCE[incident.evidence])}</span> : null}</div>
        <div className="admin-incident-meta">
          <span>{copy('Record updated {0}', time(incident.at))}</span>
          {check ? <span>{check.verifiedAt ? copy('Last nonce evidence verified {0}', time(check.verifiedAt)) : copy('No independent verification recorded')}</span> : null}
          {check?.checkedAt && check.checkedAt !== check.verifiedAt ? <span>{copy('Last check {0}', time(check.checkedAt))}</span> : null}
        </div>
      </div>
      <div className="admin-incident-side">
        <Status tone={LIFECYCLE_TONE[incident.lifecycle]}>{copy(INCIDENT_LIFECYCLE_LABELS[incident.lifecycle])}</Status>
        <Status tone={ELIGIBILITY_TONE[incident.eligibility]}>{copy(check?.state ? OBSERVATION_LABELS[check.state] : ELIGIBILITY_LABELS[incident.eligibility])}</Status>
        {status !== 'NEW' ? <span className="admin-diff">{copy(STATUS_LABELS[status])}</span> : null}
        <a className="admin-button" data-size="sm" href={incidentHref(incident.id)} aria-label={copy('Diagnose: {0}, {1}', copy(incident.title), incident.component)}>{copy('Diagnose')}</a>
      </div>
      <p className="admin-incident-next">{copy(incident.recommended)}</p>
    </li>; })}</ul>;
}

/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: Support & Recovery — current incidents derived from durable state, lookups, recovery history and
 * engineering escalations. Every count here is a count of real records; nothing is estimated.
 */
export default async function SupportPage({ searchParams }: { searchParams: Search }) {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const raw = await searchParams, params = Object.fromEntries(Object.entries(raw).flatMap(([k, v]) => typeof v === 'string' ? [[k, v]] : []));
  const filters = supportFilters(params);
  const [{ language }, view] = await Promise.all([requestLanguage(), supportView(process.env, page.host, page.now, filters)]);
  const { copy, count, time } = finopsCopy(language);
  const { counts, historyCounts, attention } = view;
  const unavailable = view.sources.filter(source => !source.ok), truncated = view.sources.filter(source => source.truncated);
  const escalations = view.all.filter(incident => incident.eligibility === 'ENGINEERING' && (incident.lifecycle === 'ACTIVE' || incident.lifecycle === 'UNDER_INVESTIGATION'));
  const defaultFilters = supportFilters({});
  const filtered = Object.entries(filters).some(([key, value]) => value !== defaultFilters[key as keyof typeof filters]);
  const scoped = countIncidents(view.all.filter(incident => inIncidentScope(incident, filters.network)));
  const select = (id: string, label: string, name: keyof typeof filters, options: readonly (readonly [string, string])[]) =>
    <label htmlFor={id}>{copy(label)}<select id={id} name={name} defaultValue={filters[name]}>{options.map(([value, text]) =>
      <option key={value} value={value}>{copy(text)}</option>)}</select></label>;
  const notesUnavailable = !view.notesOk || attention !== null && !attention.notesOk;
  const matchingUnavailable = unavailable.length > 0 || notesUnavailable && (filters.status !== 'ALL' || filters.lifecycle === 'UNDER_INVESTIGATION' || filters.lifecycle === 'ACTIVE');
  const activeView = filters.observation === 'WAITING_EXTERNAL' && filters.network === 'PRODUCTION' ? 'waiting'
    : filters.lifecycle === 'OPEN' ? filters.network === 'TESTNET' ? 'testnet' : filters.network === 'PRODUCTION' ? 'OPEN' : null : filters.lifecycle;
  const advancedFilters = (['status', 'severity', 'category', 'feature', 'range', 'eligibility'] as const)
    .some(key => filters[key] !== defaultFilters[key]);
  const views = [
    ['OPEN', 'Production incidents', '?lifecycle=OPEN'],
    ['UNDER_INVESTIGATION', 'Under investigation', '?lifecycle=UNDER_INVESTIGATION'],
    ['waiting', 'Awaiting external evidence', '?lifecycle=OPEN&observation=WAITING_EXTERNAL'],
    ['HISTORICAL', 'Historical attention', '?lifecycle=HISTORICAL'],
    ['VERIFIED_RESOLVED', 'Verified resolved', '?lifecycle=VERIFIED_RESOLVED'],
    ['testnet', 'Testnet audit', '?lifecycle=OPEN&network=TESTNET'],
  ] as const;
  return <AdminShell active="support" context={page.context} title="Support & Recovery"
    actions={<><a className="admin-button" href="#support-search">{copy('Find an execution')}</a>
      <a className="admin-button" href={'/admin/support?' + new URLSearchParams(params)}>{copy('Refresh')}</a></>}>
    {unavailable.length ? <p className="admin-alert" data-tone="bad" role="alert">{copy('Incident feed incomplete. Unavailable sources: {0}', unavailable.map(source => copy(SOURCE_LABELS[source.source]!)).join(', '))}</p> : null}
    {truncated.length ? <p className="admin-alert" data-tone="warn" role="status">{copy('Incident results are partial. Read limits reached: {0}', truncated.map(source => copy(SOURCE_LABELS[source.source]!)).join(', '))}</p> : null}
    {notesUnavailable ? <p className="admin-alert" data-tone="warn" role="status">{copy('Some investigation notes are unavailable.')}</p> : null}

    <nav className="admin-segmented" aria-label={copy('Incident views')}>
      {views.map(([id, label, query]) => <a key={id} href={'/admin/support' + query} aria-current={id === activeView ? 'true' : undefined}>{copy(label)}</a>)}
    </nav>

    <Section id="support-incidents" title={copy('Incident explorer')} description={copy('Checked {0}', time(view.checkedAt))}>
      <div className="admin-incident-summary">
        <span>{copy('Matching records')} <strong>{matchingUnavailable ? copy('Unavailable') : truncated.length ? copy('At least {0}', count(view.incidents.length)) : count(view.incidents.length)}</strong></span>
        <span>{copy('Open in this scope')} <strong>{unavailable.length ? copy('Unavailable') : truncated.length ? copy('At least {0}', count(scoped.open)) : count(scoped.open)}</strong></span>
      </div>
      <TechnicalDetails summary={copy('Filter incidents')} open={advancedFilters || filtered && activeView === null || undefined}>
        <form className="admin-filters" method="get" action="/admin/support#support-incidents" aria-label={copy('Incident filters')}>
          {select('support-f-lifecycle', 'Lifecycle', 'lifecycle', LIFECYCLE_OPTIONS)}
          {select('support-f-status', 'Notes', 'status', [['ALL', 'Any'], ...Object.entries(STATUS_LABELS)])}
          {select('support-f-severity', 'Severity', 'severity', [['ALL', 'Any'], ...Object.entries(SEVERITY_LABELS)])}
          {select('support-f-category', 'Error category', 'category', [['ALL', 'Any'], ...CATEGORIES.map(c => [c, CATEGORY_LABELS[c]] as const)])}
          {select('support-f-feature', 'Affected feature', 'feature', [['ALL', 'Any'], ...Object.entries(FEATURE_LABELS)])}
          {select('support-f-network', 'Network', 'network', [['PRODUCTION', 'Production and unknown'], ['ALL', 'All environments'], ['MAINNET', 'Mainnet'], ['TESTNET', 'Testnet / Devnet'], ['MOCKED', 'Mocked (local)']])}
          {select('support-f-range', 'Last updated', 'range', [['all', 'Any time'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']])}
          {select('support-f-eligibility', 'Recovery eligibility', 'eligibility', [['ALL', 'Any'], ...ELIGIBILITY_ORDER.filter(s => s !== 'NONE').map(s => [s, ELIGIBILITY_LABELS[s]] as const)])}
          {select('support-f-observation', 'Observation', 'observation', [['ALL', 'Any'], ['WAITING_EXTERNAL', 'Awaiting external evidence']])}
          <button className="admin-button" type="submit">{copy('Apply')}</button>
          {filtered ? <a className="admin-button" href="/admin/support#support-incidents">{copy('Clear')}</a> : null}
        </form>
      </TechnicalDetails>
      {view.incidents.length === 0 ? <p className="admin-empty" role="status">{copy(matchingUnavailable || truncated.length ? 'No matching records in the available results.' : 'No incidents match this view.')}</p>
        : <IncidentList incidents={view.incidents.slice(0, 100)} notes={view.notes} language={language}/>}
      {view.incidents.length > 100 ? <p className="admin-diff">{copy('Showing the first 100. Use filters to narrow the results.')}</p> : null}
    </Section>

    <Section id="support-search" title={copy('Find a user’s execution')} description={copy('Exact identifier. Each lookup is audited.')}>
      <SupportSearch csrf={page.context.csrf}/>
    </Section>

    <TechnicalDetails summary={copy('Incident and recovery statistics')} className="admin-ops-disclosure">
      <div className="admin-kpis">
        {([
          ['Open incidents', counts.open], ['Under investigation', counts.underInvestigation], ['High severity', counts.high],
          ['Recoverable here', counts.recoverable], ['Guided recovery', counts.guided], ['User action required', counts.userAction],
          ['Engineering fix required', counts.engineering], ['Investigation required', counts.investigation], ['Waiting or retrying', counts.waiting],
          ['Historical attention', counts.historical], ['Verified resolved', counts.resolved], ['Final failures (informational)', counts.final],
        ] as const).map(([label, value]) => <Kpi key={label} label={copy(label)}
          value={unavailable.length ? copy('Unavailable') : truncated.length ? copy('At least {0}', count(value)) : count(value)}/>)}
        <Kpi label={copy('Raw execution flags')} value={attention ? count(attention.flaggedTotal) : copy('Unavailable')}/>
        {historyCounts ? <>
          <Kpi label="Recoveries with task completed (30 d)" value={fmt(historyCounts.resolved)}/>
          <Kpi label="Pending verification" value={fmt(historyCounts.pending)}/>
          <Kpi label="Stopped again" value={fmt(historyCounts.stoppedAgain)} tone={historyCounts.stoppedAgain ? 'bad' : undefined}/>
          <Kpi label="Inconclusive" value={fmt(historyCounts.inconclusive)}/>
          <Kpi label="Refused attempts" value={fmt(historyCounts.refused)}/>
        </> : <p className="admin-alert" data-tone="warn">Recovery history could not be read.</p>}
      </div>
      <p className="admin-diff">{copy('Totals cover all environments. Investigation requires an audit note. Resolved incidents require durable evidence.')}</p>
    </TechnicalDetails>

    <Section id="support-actions" title="Recovery actions available" description="The complete list of what the Admin can run. Anything not listed needs the user, a deployment or engineering.">
      <ul>{Object.values(RECOVERY_ACTIONS).map(action => <li key={action.id}><strong>{action.name}</strong> — {action.description} <span className="admin-diff">{action.fundsInvolved}</span></li>)}
        <li><strong>Restore a known-good AI configuration</strong> — in <a href="/admin/ai-settings">AI Settings</a> (versioned, audited there).</li></ul>
      <TechnicalDetails summary="What is deliberately not possible here">
        <p>The Admin cannot sign, submit, approve allowances, transfer funds, change a workflow’s parameters, retry a transaction submission, retry a delegated execution or an
          automation evaluation, mark an unknown outcome as success or failure, edit feature flags or run SQL or code. Every action above re-queues an existing idempotent
          background task under the execution’s original identity; the outcome is whatever the worker then observes.</p>
      </TechnicalDetails>
    </Section>

    <Section id="support-history" title="Recovery history" description={`Recovery attempts in the last 30 days, newest first (up to ${HISTORY_ROWS}), who ran them, and their verified result now.`}>
      {!view.history ? <p className="admin-alert" data-tone="warn">Recovery history could not be read.</p>
        : view.history.length === 0 ? <p className="admin-empty">No recovery attempts in the last 30 days.</p>
        : <div className="admin-table-wrap"><table className="admin-table" aria-label="Recovery history">
          <thead><tr><th>When (UTC)</th><th>Action</th><th>Execution</th><th>By</th><th>Result</th><th>Operator’s reason (not evidence)</th></tr></thead>
          <tbody>{view.history.map(entry => <tr key={entry.eventId}>
            <td className="admin-mono">{entry.at.replace('T', ' ').slice(0, 16)}</td>
            <td>{entry.action && entry.action in RECOVERY_ACTIONS ? RECOVERY_ACTIONS[entry.action as keyof typeof RECOVERY_ACTIONS].name : <code>{entry.action ?? '—'}</code>}
              {entry.operationId ? <div className="admin-diff"><code>{entry.operationId}</code></div> : null}</td>
            <td>{entry.runId ? <a href={incidentHref(`run:${entry.runId}`)}><code>{entry.runId}</code></a> : '—'}</td>
            <td><code>{entry.actor.slice(0, 12)}…</code></td>
            <td>{entry.outcome !== 'OK' ? <Status tone="neutral">{entry.outcome === 'REFUSED' ? 'Refused' : 'Failed'} — {entry.code}</Status>
              : entry.verification ? <Status tone={entry.verification.status === 'RESOLVED' ? 'ok' : entry.verification.status === 'STOPPED_AGAIN' ? 'bad'
                : entry.verification.status === 'INCONCLUSIVE' ? 'warn' : 'info'}>{entry.verification.status === 'RESOLVED' ? 'Task completed'
                : entry.verification.status === 'STOPPED_AGAIN' ? 'Stopped again' : entry.verification.status === 'INCONCLUSIVE' ? 'Inconclusive' : 'Pending verification'}</Status>
              : <Status tone="warn">Not verifiable</Status>}
              {/* BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (ADMIN-01): why it stopped again (the task's own stop code), never a claim about settlement. */}
              {entry.verification?.status === 'STOPPED_AGAIN' && entry.verification.code ? (() => { const stop = explainCode(entry.verification.code)!;
                return <div className="admin-diff"><code>{stop.code}</code>{' · '}{stop.label}</div>; })() : null}</td>
            <td>{entry.reason ?? (entry.outcome === 'OK' && entry.reasonState === 'REMOVED' ? <span className="admin-diff">Removed (retention or erasure)</span> : '—')}</td>
          </tr>)}</tbody></table></div>}
      {view.history && historyCounts && historyCounts.total > view.history.length ? <p className="admin-diff">Showing the newest {fmt(view.history.length)} of {fmt(historyCounts.total)} attempts;
        the counts above cover all of them.</p> : null}
    </Section>

    <Section id="support-escalation" title="Engineering escalation" description="Incidents that need a code change, a migration or a deployment configuration change. The Admin cannot fix these."
      tone={escalations.length ? 'warn' : undefined}>
      {escalations.length === 0 ? <p className="admin-empty">{unavailable.length || truncated.length ? 'No engineering escalations in the available records.' : 'No current incident is classified as needing engineering.'}</p>
        : <IncidentList incidents={escalations.slice(0, 50)} notes={view.notes} language={language}/>}
      <p className="admin-diff" style={{ marginTop: 8 }}>When you escalate, add an “Escalation” note on the incident so the hand-off is recorded with it.</p>
    </Section>
  </AdminShell>;
}
