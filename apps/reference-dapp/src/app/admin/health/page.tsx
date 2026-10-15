// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { copilotSettingsView } from '../../../admin/copilot-view';
import { healthReport } from '../../../admin/health';
import { adminPage } from '../../../admin/page-context';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { fmt } from '../../../components/admin/charts';

const ago = (seconds: number | null) => seconds === null ? '—' : seconds < 120 ? `${seconds} s` : seconds < 7200 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 3600)} h`;
const at = (iso: string | null) => iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : 'never';
function Status({ ok, warn, children }: { ok: boolean; warn?: boolean; children: ReactNode }) {
  return <span className="admin-badge" data-tone={!ok ? 'bad' : warn ? 'warn' : 'ok'}>{!ok ? '✕ ' : warn ? '! ' : '✓ '}{children}</span>;
}

/** BUILD-ADMIN-001: what the console can observe about FloFi's services right now. */
export default async function AdminHealthPage() {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const [report, copilot] = await Promise.all([healthReport(process.env, page.host, page.now), copilotSettingsView(process.env, page.host)]);
  const { database, api, queue, runs, scheduler } = report;
  return <AdminShell active="health" context={page.context} title="System Health" description={`Checked ${at(report.checkedAt)}. Reload to check again.`}>
    <div className="admin-grid admin-grid-2">
      <section className="admin-card"><header><h2>Database</h2></header>
        {database.ok ? <table className="admin-table"><tbody>
          <tr><th scope="row">Reachable</th><td><Status ok warn={database.value.latencyMs > 500}>{database.value.latencyMs} ms</Status></td></tr>
          <tr><th scope="row">Schema</th><td><Status ok={database.value.appliedMigrations === database.value.shippedMigrations}>
            {database.value.appliedMigrations} of {database.value.shippedMigrations} shipped migrations</Status></td></tr>
          <tr><th scope="row">Tenant</th><td><code>{database.value.tenantId}</code></td></tr>
        </tbody></table> : <Status ok={false}>{database.code}</Status>}
      </section>
      <section className="admin-card"><header><h2>Railway API</h2></header>
        {api.readiness === null ? <p className="admin-note">This deployment runs flows in-process (no API_BASE_URL), so there is no remote API to check.</p>
          : api.readiness.ok ? <Status ok warn={api.readiness.value.latencyMs > 1500}>/readyz {api.readiness.value.status} · {api.readiness.value.latencyMs} ms</Status>
          : <Status ok={false}>{api.readiness.code}</Status>}
        <p className="admin-diff">Readiness is the API&rsquo;s own public check (database reachable and schema current). Flow enablement lives in the API and worker
          environment, which this console does not read.</p>
      </section>
      <section className="admin-card"><header><h2>Worker and durable work queue</h2></header>
        {queue.ok ? <><table className="admin-table"><tbody>
          <tr><th scope="row">Last completed work item</th><td>{at(queue.value.lastCompletedAt)}</td></tr>
          <tr><th scope="row">Completed / dead (24 h)</th><td>{fmt(queue.value.done24h)} / <Status ok warn={queue.value.dead24h > 0}>{fmt(queue.value.dead24h)} dead</Status></td></tr>
          <tr><th scope="row">Ready / overdue (&gt; 5 min)</th><td>{fmt(queue.value.ready)} / <Status ok warn={queue.value.overdue > 0}>{fmt(queue.value.overdue)} overdue
            {queue.value.oldestOverdueSeconds !== null ? `, oldest ${ago(queue.value.oldestOverdueSeconds)}` : ''}</Status></td></tr>
          <tr><th scope="row">Leased / expired leases</th><td>{fmt(queue.value.leased)} / <Status ok warn={queue.value.expiredLeases > 0}>{fmt(queue.value.expiredLeases)}</Status></td></tr>
        </tbody></table>
          {queue.value.byKind.length ? <p className="admin-diff">{queue.value.byKind.map((k, i) => <span key={k.kind}>{i ? ' · ' : ''}<code>{k.kind}</code> {fmt(k.ready)} ready{k.dead24h ? `, ${fmt(k.dead24h)} dead` : ''}</span>)}</p> : null}
          <p className="admin-diff">Worker liveness is inferred from durable activity; an idle platform also shows no recent completions.</p></>
          : <Status ok={false}>{queue.code}</Status>}
      </section>
      <section className="admin-card"><header><h2>Executions under observation</h2></header>
        {runs.ok ? <table className="admin-table"><tbody>
          <tr><th scope="row">Awaiting reconciliation</th><td>{fmt(runs.value.observing)}{runs.value.oldestObservationSeconds !== null ? ` · oldest updated ${ago(runs.value.oldestObservationSeconds)} ago` : ''}</td></tr>
          <tr><th scope="row">Flagged for attention (all time)</th><td><Status ok warn={runs.value.attention > 0}>{fmt(runs.value.attention)}</Status></td></tr>
        </tbody></table> : <Status ok={false}>{runs.code}</Status>}
      </section>
      <section className="admin-card"><header><h2>Automation scheduler</h2></header>
        {scheduler.ok ? !scheduler.value.installed ? <p className="admin-note">Automations are not installed on this database.</p> : <table className="admin-table"><tbody>
          <tr><th scope="row">Last evaluation</th><td>{at(scheduler.value.lastEvaluationAt)}</td></tr>
          <tr><th scope="row">Active rules overdue (&gt; 5 min)</th><td><Status ok warn={scheduler.value.overdueRules > 0}>{fmt(scheduler.value.overdueRules)}</Status></td></tr>
        </tbody></table> : <Status ok={false}>{scheduler.code}</Status>}
        <p className="admin-diff">Overdue active rules mean no scheduler is evaluating them (the worker needs FLOFI_AUTOMATIONS=enabled).</p>
      </section>
      <section className="admin-card"><header><h2>Copilot</h2></header>
        <table className="admin-table"><tbody>
          <tr><th scope="row">Mode</th><td><Status ok={copilot.mode !== 'unavailable'} warn={copilot.mode === 'off'}>{copilot.mode}</Status></td></tr>
          <tr><th scope="row">Settings</th><td>{copilot.activeCode ? <Status ok={false}>{copilot.activeCode}</Status>
            : copilot.activeSource === 'RUNTIME' ? `Runtime v${copilot.activeVersion}` : 'Environment bootstrap'}</td></tr>
        </tbody></table>
        <p className="admin-diff"><a href="/admin/ai-settings">AI Settings</a> shows each channel&rsquo;s effective model.</p>
      </section>
    </div>
    <section className="admin-card"><header><h2>Recent incidents</h2><p>work items that exhausted their observation budget (never resubmitted)</p></header>
      {report.incidents.length === 0 ? <p className="admin-empty">No dead work items.</p> : <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>When (UTC)</th><th>Work kind</th><th>Code</th><th>Run</th></tr></thead>
        <tbody>{report.incidents.map((incident, i) => <tr key={i}><td className="admin-mono">{incident.at.replace('T', ' ').slice(0, 16)}</td><td><code>{incident.kind}</code></td>
          <td><code>{incident.code}</code></td><td>{incident.run ? <code>{incident.run}…</code> : '—'}</td></tr>)}</tbody>
      </table></div>}
    </section>
  </AdminShell>;
}
