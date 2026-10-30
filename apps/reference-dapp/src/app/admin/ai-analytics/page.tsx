// SPDX-License-Identifier: AGPL-3.0-only
import { copilotAnalytics } from '../../../admin/analytics/copilot';
import { adminPage } from '../../../admin/page-context';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { fmt } from '../../../components/admin/charts';

type Search = Promise<Record<string, string | string[] | undefined>>;
export default async function CopilotAnalyticsPage({ searchParams }: { searchParams: Search }) {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const params = await searchParams;
  let view;
  try { view = await copilotAnalytics(page.host, { days: typeof params.days === 'string' ? params.days : undefined, mode: typeof params.mode === 'string' ? params.mode : undefined }, page.now); }
  catch { return <AdminShell active="ai-analytics" context={page.context} title="AI Analytics"><p className="admin-alert" data-tone="bad">AI analytics are unavailable (COPILOT_METRICS_UNAVAILABLE).</p></AdminShell>; }
  return <AdminShell active="ai-analytics" context={page.context} title="AI Analytics" description="Durable daily counters for conversational planning and model tools.">
    <form className="admin-filters" method="get" action="/admin/ai-analytics" aria-label="AI analytics filters">
      <label htmlFor="ai-metrics-days">Period<select id="ai-metrics-days" name="days" defaultValue={String(view.days)}>
        <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option>
      </select></label>
      <label htmlFor="ai-metrics-mode">Data source<select id="ai-metrics-mode" name="mode" defaultValue={view.mode}>
        <option value="live">Live model</option><option value="replay">Replay</option>
      </select></label><button className="admin-button" type="submit">Apply</button>
    </form>
    <p className="admin-diff">UTC daily aggregates cover up to 90 days. Older records are removed on new observations or Admin reads. Server interpretations and channel turns are measured on the server. Browser turns are client reports and may be missing or forged.
      {' '}Proposals, clarifications and model success describe planning; execution and reconciliation are measured separately in Workflows. Replay is never included in live figures.</p>
    <div className="admin-kpis">
      {[['Model requests', view.interpretations], ['Model failures', view.interpretationFailures], ['Tool calls', view.toolCalls], ['Tool failures', view.toolFailures],
        ['Channel proposals', view.proposals], ['Browser proposal reports', view.browserProposals], ['Clarification turns', view.clarifications], ['Validation mismatches', view.mismatches]]
        .map(([label, value]) => <div key={String(label)} className="admin-kpi"><span>{label}</span><strong>{fmt(Number(value))}</strong></div>)}
    </div>
    <section className="admin-card" aria-labelledby="ai-usage"><header><h2 id="ai-usage">Model usage</h2>
      <p>Usage totals cover the rounds for which the provider returned usage. Requests with known input usage: {fmt(view.tokenSamples)} / {fmt(view.interpretations)}. No monetary cost is inferred.</p></header>
      <p>Input tokens: {fmt(view.inputTokens)} · Output tokens: {fmt(view.outputTokens)} · Reasoning tokens: {fmt(view.reasoningTokens)}</p>
    </section>
    <section className="admin-card" aria-labelledby="ai-observations"><header><h2 id="ai-observations">Planning observations</h2>
      <p>Rows retain surface and reporting provenance. Repeat and correction reports count turns whose open request contains those events; they are not distinct event counts.</p></header>
      {view.rows.length === 0 ? <p className="admin-empty">No persisted observations in this period. This does not establish that no requests occurred.</p> :
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Day</th><th>Surface / source</th><th>Observation</th><th>Outcome</th><th>Model</th>
          <th className="num">Count</th><th className="num">Mean latency</th><th className="num">Tools / failed</th><th className="num">Mismatches</th><th className="num">Repeat / correction reports</th><th className="num">Mean turns to proposal</th></tr></thead>
          <tbody>{view.rows.map(row => <tr key={[row.day, row.surface, row.provenance, row.kind, row.outcome, row.model].join(':')}>
            <td>{row.day}</td><td>{row.surface} / {row.provenance}</td><td>{row.kind}</td><td>{row.outcome}</td><td>{row.model || '—'}</td><td className="num">{fmt(row.events)}</td>
            <td className="num">{row.kind === 'INTERPRETATION' && row.events ? `${Math.round(row.duration_ms / row.events)} ms` : '—'}</td>
            <td className="num">{fmt(row.tool_calls)} / {fmt(row.tool_failures)}</td><td className="num">{fmt(row.mismatches)}</td>
            <td className="num">{fmt(row.repeated_question_reports)} / {fmt(row.correction_reports)}</td><td className="num">{row.proposals ? (row.turns_to_proposal / row.proposals).toFixed(1) : '—'}</td>
          </tr>)}</tbody></table></div>}
    </section>
  </AdminShell>;
}
