// SPDX-License-Identifier: AGPL-3.0-only
import { adminPage } from '../../../admin/page-context';
import { CATEGORIES, CATEGORY_LABELS } from '../../../admin/support/codes';
import { incidentStatus, STATUS_LABELS, type Note } from '../../../admin/support/diagnostics';
import { FEATURE_LABELS, SEVERITY_LABELS, type Incident } from '../../../admin/support/incidents';
import { ELIGIBILITY_LABELS, ELIGIBILITY_ORDER, RECOVERY_ACTIONS, type EligibilityState } from '../../../admin/support/registry';
import { HISTORY_ROWS, supportFilters, supportView } from '../../../admin/support/view';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { Kpi, Section, Status, TechnicalDetails, type Tone } from '../../../components/admin/admin-ui';
import { fmt } from '../../../components/admin/charts';
import { SupportSearch } from '../../../components/admin/support-console';

type Search = Promise<Record<string, string | string[] | undefined>>;
const when = (iso: string) => iso.replace('T', ' ').slice(0, 16) + ' UTC';
const ELIGIBILITY_TONE: Record<EligibilityState, Tone> = { RECOVERABLE_NOW: 'ok', REQUIRES_CONFIRMATION: 'info', WAITING_EXTERNAL: 'neutral', USER_ACTION: 'info',
  ENGINEERING: 'bad', INVESTIGATION: 'warn', NONE: 'neutral' };
const SEVERITY_TONE: Record<Incident['severity'], Tone> = { HIGH: 'bad', MEDIUM: 'warn', LOW: 'neutral' };
const FUNDS: Record<Incident['funds'], string> = { NONE: 'No funds involved', POSSIBLE: 'Funds may be involved', TEST_ONLY: 'Test or mocked funds only',
  UNKNOWN: 'Funds: unknown' };
const ENVIRONMENT: Record<string, string> = { MAINNET: 'Mainnet', TESTNET: 'Testnet / Devnet', MOCKED: 'Mocked (local)' };
const SOURCE_LABELS: Record<string, string> = { EXECUTION: 'Executions', BACKGROUND_TASK: 'Background tasks', WORKFLOW_RUN: 'Multi-step workflows',
  DELEGATED_EXECUTION: 'Delegated executions', PLATFORM: 'System Health', AI_COPILOT: 'AI Copilot' };
const incidentHref = (id: string) => `/admin/support/incident?id=${encodeURIComponent(id)}`;

function IncidentList({ incidents, notes }: { incidents: readonly Incident[]; notes: ReadonlyMap<string, readonly Note[]> }) {
  return <ul className="admin-incidents">{incidents.map(incident => {
    const status = incidentStatus(notes.get(incident.id) ?? []);
    return <li key={incident.id} className="admin-incident" data-severity={incident.severity}>
      <div>
        <div className="admin-incident-meta">
          <Status tone={SEVERITY_TONE[incident.severity]}>{SEVERITY_LABELS[incident.severity]}</Status>
          <span>{CATEGORY_LABELS[incident.category]}</span><span aria-hidden="true">·</span><span>{FEATURE_LABELS[incident.feature]}</span>
          {incident.environment || incident.provenance ? <><span aria-hidden="true">·</span><span>{incident.environment ? ENVIRONMENT[incident.environment]
            : <>Provenance <code>{incident.provenance}</code></>}{incident.networks.length ? ` (${incident.networks.join(', ')})` : ''}</span></> : null}
        </div>
        <h3><a href={incidentHref(incident.id)}>{incident.title}</a></h3>
        <p>{incident.summary}</p>
        <div className="admin-incident-meta"><span>{when(incident.at)}</span><span aria-hidden="true">·</span><code>{incident.component}</code>
          <span aria-hidden="true">·</span><span>Outcome: {incident.outcome}</span>{incident.funds !== 'NONE' ? <><span aria-hidden="true">·</span><strong>{FUNDS[incident.funds]}</strong></> : null}</div>
      </div>
      <div className="admin-incident-side">
        <Status tone={ELIGIBILITY_TONE[incident.eligibility]}>{ELIGIBILITY_LABELS[incident.eligibility]}</Status>
        {status !== 'NEW' ? <span className="admin-diff">{STATUS_LABELS[status]}</span> : null}
        <a className="admin-button" data-size="sm" href={incidentHref(incident.id)} aria-label={`Diagnose: ${incident.title}, ${incident.component}`}>Diagnose</a>
      </div>
      <p className="admin-incident-next"><strong>Recommended:</strong> {incident.recommended}</p>
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
  const filters = supportFilters(params), view = await supportView(process.env, page.host, page.now, filters);
  const { counts, historyCounts } = view, unavailable = view.sources.filter(source => !source.ok), truncated = view.sources.filter(source => source.truncated);
  const escalations = view.all.filter(incident => incident.eligibility === 'ENGINEERING');
  const filtered = Object.entries(filters).some(([key, value]) => value !== (key === 'range' ? 'all' : 'ALL'));
  const select = (id: string, label: string, name: keyof typeof filters, options: readonly (readonly [string, string])[]) =>
    <label htmlFor={id}>{label}<select id={id} name={name} defaultValue={filters[name]}>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>;
  return <AdminShell active="support" context={page.context} title="Support & Recovery"
    description="Find real incidents, understand what happened, and run a safe, pre-approved recovery when one applies — without a deployment."
    actions={<a className="admin-button" href="/admin/support">Refresh</a>}>
    {unavailable.length ? <p className="admin-alert" data-tone="bad" role="alert">Some sources could not be read, so incidents from them are missing:{' '}
      {unavailable.map(source => `${SOURCE_LABELS[source.source]} (${source.code})`).join(', ')}. The list below is incomplete.</p> : null}
    {truncated.length ? <p className="admin-alert" data-tone="warn">More records exist than were read: {truncated.map(source => SOURCE_LABELS[source.source]).join(', ')}
      {' '}reached their read limit, so some incidents are not listed.</p> : null}
    {!view.notesOk ? <p className="admin-alert" data-tone="warn">Incident notes could not be read: every incident shows as New and the Status filter is not reliable.</p> : null}

    <Section id="support-overview" title="Overview" description={`Current incidents derived from FloFi’s durable state, checked ${when(view.checkedAt)}. Counts combine
      mainnet, test networks and mocked runs; each incident shows its environment, and only mainnet (or unrecognised) runs are marked as possibly involving real funds.`}>
      <div className="admin-kpis">
        <Kpi label="Open incidents" value={fmt(counts.open)} tone={counts.open ? 'warn' : undefined}/>
        <Kpi label="High severity" value={fmt(counts.high)} tone={counts.high ? 'bad' : undefined}/>
        <a className="admin-kpi-link" href="/admin/support?eligibility=RECOVERABLE_NOW#support-incidents"><Kpi label="Recoverable here" value={fmt(counts.recoverable)}
          note={counts.guided ? `+ ${fmt(counts.guided)} guided restore in AI Settings` : 'registered action applies'}/></a>
        <a className="admin-kpi-link" href="/admin/support?eligibility=USER_ACTION#support-incidents"><Kpi label="User action required" value={fmt(counts.userAction)}/></a>
        <a className="admin-kpi-link" href="#support-escalation"><Kpi label="Engineering fix required" value={fmt(counts.engineering)} tone={counts.engineering ? 'warn' : undefined}/></a>
        <a className="admin-kpi-link" href="/admin/support?eligibility=INVESTIGATION#support-incidents"><Kpi label="Investigation required" value={fmt(counts.investigation)}/></a>
        <Kpi label="Waiting for external system" value={fmt(counts.waiting)}/>
      </div>
      <div className="admin-kpis" style={{ marginTop: 12 }}>
        {historyCounts ? <>
          <Kpi label="Recoveries with task completed (30 d)" value={fmt(historyCounts.resolved)}/>
          <Kpi label="Pending verification" value={fmt(historyCounts.pending)}/>
          <Kpi label="Stopped again" value={fmt(historyCounts.stoppedAgain)} tone={historyCounts.stoppedAgain ? 'bad' : undefined}/>
          <Kpi label="Inconclusive" value={fmt(historyCounts.inconclusive)}/>
          <Kpi label="Refused attempts" value={fmt(historyCounts.refused)}/>
        </> : <p className="admin-alert" data-tone="warn">Recovery history could not be read.</p>}
      </div>
      <TechnicalDetails summary="What these numbers mean">
        <p>An incident is a condition the database shows right now (for example a transaction check that stopped). It disappears when the condition does —
          after a recovery, or when the worker finishes on its own. Recovery counts are audited attempts from the last 30 days, each verified against the current task and
          execution state. Failed executions are listed for the last 30 days; stopped background tasks for 90 days.</p>
      </TechnicalDetails>
    </Section>

    <Section id="support-search" title="Find a user’s execution" description="Look up one record by an exact identifier. Every lookup is audited; free text is not searched.">
      <SupportSearch csrf={page.context.csrf}/>
      <p className="admin-diff" style={{ marginTop: 8 }}>Wallet lookups need the OPERATOR role. Results never show full wallet addresses, keys or transcripts.</p>
    </Section>

    <Section id="support-incidents" title="Incident explorer" description={`${fmt(view.incidents.length)} of ${fmt(counts.open)} open incidents${filtered ? ' match the filters' : ''}, most severe first.`}>
      <form className="admin-filters" method="get" action="/admin/support#support-incidents" aria-label="Incident filters" style={{ marginBottom: 14 }}>
        {select('support-f-status', 'Status', 'status', [['ALL', 'Any'], ...Object.entries(STATUS_LABELS)])}
        {select('support-f-severity', 'Severity', 'severity', [['ALL', 'Any'], ...Object.entries(SEVERITY_LABELS)])}
        {select('support-f-category', 'Error category', 'category', [['ALL', 'Any'], ...CATEGORIES.map(c => [c, CATEGORY_LABELS[c]] as const)])}
        {select('support-f-feature', 'Affected feature', 'feature', [['ALL', 'Any'], ...Object.entries(FEATURE_LABELS)])}
        {select('support-f-network', 'Network', 'network', [['ALL', 'Any'], ['MAINNET', 'Mainnet'], ['TESTNET', 'Testnet / Devnet'], ['MOCKED', 'Mocked (local)']])}
        {select('support-f-range', 'Last updated', 'range', [['all', 'Any time'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']])}
        {select('support-f-eligibility', 'Recovery eligibility', 'eligibility', [['ALL', 'Any'], ...ELIGIBILITY_ORDER.filter(s => s !== 'NONE').map(s => [s, ELIGIBILITY_LABELS[s]] as const)])}
        <button className="admin-button" type="submit">Apply</button>{filtered ? <a className="admin-button" href="/admin/support#support-incidents">Clear</a> : null}
      </form>
      {view.incidents.length === 0 ? <p className="admin-empty">{filtered ? 'No incidents match these filters.' : 'No matching incidents were found.'} This does not mean every component is
        healthy: it means none of the conditions Support checks is present in the readable sources{unavailable.length ? ' (some sources are unavailable — see above)' : ''}.</p>
        : <IncidentList incidents={view.incidents.slice(0, 100)} notes={view.notes}/>}
      {view.incidents.length > 100 ? <p className="admin-diff">Showing the first 100; narrow the filters to see the rest.</p> : null}
    </Section>

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
          <thead><tr><th>When (UTC)</th><th>Action</th><th>Execution</th><th>By</th><th>Result</th><th>Reason</th></tr></thead>
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
              : <Status tone="warn">Not verifiable</Status>}</td>
            <td>{entry.reason ?? '—'}</td>
          </tr>)}</tbody></table></div>}
      {view.history && historyCounts && historyCounts.total > view.history.length ? <p className="admin-diff">Showing the newest {fmt(view.history.length)} of {fmt(historyCounts.total)} attempts;
        the counts above cover all of them.</p> : null}
    </Section>

    <Section id="support-escalation" title="Engineering escalation" description="Incidents that need a code change, a migration or a deployment configuration change. The Admin cannot fix these."
      tone={escalations.length ? 'warn' : undefined}>
      {escalations.length === 0 ? <p className="admin-empty">No current incident is classified as needing engineering.</p>
        : <IncidentList incidents={escalations.slice(0, 50)} notes={view.notes}/>}
      <p className="admin-diff" style={{ marginTop: 8 }}>When you escalate, add an “Escalation” note on the incident so the hand-off is recorded with it.</p>
    </Section>
  </AdminShell>;
}
