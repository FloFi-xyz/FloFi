// SPDX-License-Identifier: AGPL-3.0-only
import { automationAnalytics } from '../../../admin/analytics/automations';
import { networkInfo } from '../../../admin/analytics/networks';
import { param } from '../../../admin/analytics/view';
import { analyticsRange } from '../../../admin/analytics/workflows';
import { adminPage } from '../../../admin/page-context';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { fmt } from '../../../components/admin/charts';

type Search = Promise<Record<string, string | string[] | undefined>>;
type Count = { key: string; count: number };
const RULE_STATES: Record<string, string> = { ACTIVE: 'Active', PAUSED: 'Paused', EXPIRED: 'Expired', ARCHIVED: 'Archived' };
const OCCURRENCE_STATES: Record<string, string> = { PENDING_OWNER: 'Waiting for the owner', APPROVAL_CREATED: 'Approval link created (waiting)', COMPLETED: 'Added to the owner’s workflow',
  DISMISSED: 'Dismissed by the owner', EXPIRED: 'Expired unanswered', DELEGATED: 'Executed within limits (delegated)' };
const GROUPS: Record<string, { label: string; tone?: string }> = { COMPLETED: { label: '✓ Settled', tone: 'ok' }, BLOCKED: { label: 'Blocked before submission', tone: 'warn' },
  FAILED: { label: '✕ Failed', tone: 'bad' }, UNCERTAIN: { label: '? Uncertain', tone: 'warn' }, HALTED: { label: 'Halted (attention)', tone: 'warn' },
  IN_PROGRESS: { label: '… In progress' }, UNCLASSIFIED: { label: 'Unclassified', tone: 'warn' } };

function CountTable({ rows, labels, empty, keyLabel }: { rows: readonly Count[]; labels?: Record<string, string>; empty: string; keyLabel: string }) {
  if (!rows.length) return <p className="admin-empty">{empty}</p>;
  return <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{keyLabel}</th><th className="num">Count</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.key}><td>{labels?.[row.key] ?? <code>{row.key}</code>}</td><td className="num">{fmt(row.count)}</td></tr>)}</tbody></table></div>;
}

/** BUILD-ADMIN-001: automation rules, evaluations, owner confirmations and delegated executions, by their own state machines. */
export default async function AdminAutomationsPage({ searchParams }: { searchParams: Search }) {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const search = await searchParams, range = analyticsRange({ range: param(search.range), from: param(search.from), to: param(search.to) }, page.now);
  const data = await automationAnalytics(page.host.db, page.host.tenantId, range, page.now).catch(() => null);
  const presets = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']] as const;
  return <AdminShell active="automations" context={page.context} title="Automations"
    description="Rules are evaluated by the worker; every proposal still needs its owner, except delegated executions within signed limits.">
    <section className="admin-card" aria-label="Filters"><div className="admin-filters"><div className="admin-field">Time range (evaluations, occurrences, delegated executions)
      <nav className="admin-segmented">{presets.map(([id, label]) => <a key={id} href={`/admin/automations?range=${id}`} aria-current={range.preset === id ? 'true' : undefined}>{label}</a>)}</nav>
    </div></div></section>
    {!data ? <p className="admin-alert" data-tone="bad">Automation metrics are unavailable (ADMIN_ANALYTICS_UNAVAILABLE).</p>
      : !data.installed ? <p className="admin-note">The automation schema is not installed on this database.</p> : <>
      <div className="admin-kpis">
        <div className="admin-kpi"><span>Active rules</span><strong>{fmt(data.rules.byState.find(r => r.key === 'ACTIVE')?.count ?? 0)}</strong>
          <small>{fmt(data.rules.byState.find(r => r.key === 'PAUSED')?.count ?? 0)} paused · {fmt(data.rules.byState.find(r => r.key === 'EXPIRED')?.count ?? 0)} expired</small></div>
        <div className="admin-kpi"><span>Trigger evaluations</span><strong>{fmt(data.evaluations.total)}</strong><small>in range</small></div>
        <div className="admin-kpi"><span>Occurrences</span><strong>{fmt(data.occurrences.created)}</strong><small>proposals and reports in range</small></div>
        <div className="admin-kpi" data-tone={data.occurrences.pendingOwnerNow ? 'warn' : undefined}><span>Pending owner confirmation</span><strong>{fmt(data.occurrences.pendingOwnerNow)}</strong><small>open now</small></div>
        <div className="admin-kpi"><span>Delegated executions</span><strong>{fmt(data.delegated.created)}</strong><small>{fmt(data.delegated.openNow)} open now</small></div>
        <div className="admin-kpi" data-tone={data.delegated.attentionNow ? 'warn' : undefined}><span>Delegated needing attention</span><strong>{fmt(data.delegated.attentionNow)}</strong><small>uncertain, halted or flagged</small></div>
      </div>
      <div className="admin-grid admin-grid-3">
        <section className="admin-card"><header><h2>Rules (now)</h2></header>
          <CountTable rows={data.rules.byState} labels={RULE_STATES} empty="No automation rules." keyLabel="State"/>
          <p className="admin-diff">{fmt(data.rules.createdInRange)} created in range · {fmt(data.rules.needRebind)} need the owner to rebind (workflow changed).</p></section>
        <section className="admin-card"><header><h2>Active and paused, by kind</h2></header>
          <CountTable rows={data.rules.byKind} labels={{ SCHEDULED_DCA: 'Scheduled DCA', PRICE_TRIGGER: 'Price trigger', DAILY_WATCH: 'Daily watch' }} empty="None." keyLabel="Kind"/>
          <CountTable rows={data.rules.byMode} labels={{ CONFIRM_EACH_TIME: 'Owner confirms each time', DELEGATED_WITH_LIMITS: 'Automatic within limits' }} empty="" keyLabel="Mode"/></section>
        <section className="admin-card"><header><h2>Occurrences in range</h2></header>
          <CountTable rows={data.occurrences.byState} labels={OCCURRENCE_STATES} empty="No occurrences in range." keyLabel="State"/></section>
      </div>
      <div className="admin-grid admin-grid-2">
        <section className="admin-card"><header><h2>Evaluation outcomes</h2><p>closed scheduler codes, in range</p></header>
          <CountTable rows={data.evaluations.byOutcome} empty="No evaluations in range." keyLabel="Outcome"/></section>
        <section className="admin-card"><header><h2>Delegated executions</h2><p>in range, by state machine group</p></header>
          {!data.delegated.installed ? <p className="admin-note">The delegated-execution schema is not installed.</p> : <>
            {data.delegated.byGroup.length === 0 ? <p className="admin-empty">No delegated executions in range.</p> : <div className="admin-table-wrap"><table className="admin-table">
              <thead><tr><th>Group</th><th className="num">Executions</th></tr></thead>
              <tbody>{data.delegated.byGroup.map(row => <tr key={row.key}><td><span className="admin-badge" data-tone={GROUPS[row.key]?.tone}>{GROUPS[row.key]?.label ?? row.key}</span></td>
                <td className="num">{fmt(row.count)}</td></tr>)}</tbody></table></div>}
            <p className="admin-diff">{fmt(data.delegated.activeAuthorizations)} active delegated authorizations. Step submissions by chain:{' '}
              {data.delegated.stepsByChain.length ? data.delegated.stepsByChain.map((row, i) => <span key={row.key}>{i ? ' · ' : ''}{networkInfo(row.key).name} {fmt(row.count)}</span>) : 'none'}.
              Delegated records carry no provenance (mainnet/testnet/mocked) flag, so they are kept out of the network distribution and the standard totals.</p>
          </>}
        </section>
      </div>
      <section className="admin-card"><header><h2>Recent automation issues</h2><p>non-routine evaluation outcomes and delegated execution codes</p></header>
        {data.issues.length === 0 ? <p className="admin-empty">No automation issues in range.</p> : <div className="admin-table-wrap"><table className="admin-table">
          <thead><tr><th>Source</th><th>Code</th><th className="num">Count</th><th>Last seen (UTC)</th></tr></thead>
          <tbody>{data.issues.map(issue => <tr key={`${issue.source}:${issue.code}`}><td>{issue.source === 'EVALUATION' ? 'Evaluation' : 'Delegated execution'}</td>
            <td><code>{issue.code}</code></td><td className="num">{fmt(issue.count)}</td><td className="admin-mono">{issue.lastAt.replace('T', ' ').slice(0, 16)}</td></tr>)}</tbody>
        </table></div>}
        {data.notifications.length ? <p className="admin-diff">Notifications in range: {data.notifications.map((n, i) => <span key={n.key}>{i ? ' · ' : ''}{n.key} {fmt(n.count)}</span>)}.</p> : null}
      </section>
    </>}
  </AdminShell>;
}
