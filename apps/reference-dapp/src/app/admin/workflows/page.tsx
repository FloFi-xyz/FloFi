// SPDX-License-Identifier: AGPL-3.0-only
import { ACTION_LABELS } from '../../../admin/analytics/actions';
import { ENVIRONMENT_LABELS, networkInfo } from '../../../admin/analytics/networks';
import { param, withParams, workflowView, type AnalyticsParams } from '../../../admin/analytics/view';
import { OUTCOME_FILTERS, type Execution } from '../../../admin/analytics/workflows';
import { adminPage } from '../../../admin/page-context';
import { AnalyticsFilters } from '../../../components/admin/analytics-filters';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { DataNotes } from '../../../components/admin/data-notes';
import { fmt, OUTCOME_KEYS, OUTCOME_META, OutcomeBadge } from '../../../components/admin/charts';

type Search = Promise<Record<string, string | string[] | undefined>>;
const LIMIT = 100;
const when = (date: Date) => date.toISOString().replace('T', ' ').slice(0, 16);
const short = (id: string) => id.length > 16 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;

function ExecutionRows({ executions }: { executions: readonly Execution[] }) {
  return <div className="admin-table-wrap"><table className="admin-table">
    <thead><tr><th>Started (UTC)</th><th>Flow</th><th>Actions</th><th>Networks</th><th>Outcome</th><th>Error code</th><th>Run</th></tr></thead>
    <tbody>{executions.map(e => {
      const chains = e.actions ? [...new Set(e.actions.flatMap(a => a.to ? [a.chain, a.to] : [a.chain]))] : [];
      return <tr key={e.rootId}>
        <td className="admin-mono">{when(e.createdAt)}</td><td><code>{e.flow}</code></td>
        <td>{e.actions ? e.actions.map(a => ACTION_LABELS[a.kind]).join(' → ') : <span className="admin-diff" title={e.factCode ?? ''}>not indexed</span>}</td>
        <td>{chains.length ? chains.map(chain => networkInfo(chain).name).join(', ') : '—'}</td>
        <td><OutcomeBadge outcome={e.classification.outcome}/>
          {e.classification.attention ? <> <span className="admin-badge" data-tone="warn">attention</span></> : null}
          {e.executed ? null : e.classification.started ? <span className="admin-diff"> not submitted</span> : null}</td>
        <td>{e.errorCode ? <code>{e.errorCode}</code> : '—'}</td>
        <td><code title={e.runIds.join(', ')}>{short(e.rootId)}</code>{e.runIds.length > 1 ? <span className="admin-diff"> +{e.runIds.length - 1} recovery</span> : null}</td>
      </tr>; })}</tbody>
  </table></div>;
}

/** BUILD-ADMIN-001: executions behind the overview — by flow, those needing attention, and the latest ones. No wallet address is shown. */
export default async function AdminWorkflowsPage({ searchParams }: { searchParams: Search }) {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const search = await searchParams;
  const params: AnalyticsParams = Object.fromEntries((['range', 'from', 'to', 'env', 'outcome'] as const).flatMap(key => {
    const value = param(search[key]); return value ? [[key, value]] : []; }));
  const view = await workflowView(page.host, params, page.now);
  if (!view.ok) return <AdminShell active="workflows" context={page.context} title="Workflows"><p className="admin-alert" data-tone="bad">Analytics are unavailable ({view.code}).</p></AdminShell>;
  const a = view.analytics, scoped = view.executions.filter(e => e.environment === view.environment && e.classification.started)
    .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
  const listed = scoped.filter(e => view.outcome === 'ALL' || e.classification.outcome === view.outcome);
  const attention = scoped.filter(e => e.classification.attention).slice(0, 25);
  return <AdminShell active="workflows" context={page.context} title="Workflows" description="Started executions, their outcomes and what needs attention.">
    <AnalyticsFilters base="/admin/workflows" params={params} range={view.range} environment={view.environment} executedByEnvironment={a.executedByEnvironment}
      defaulted={view.environmentDefaulted}/>
    <DataNotes view={view}/>
    <section className="admin-card" aria-labelledby="admin-flows">
      <header><h2 id="admin-flows">By flow</h2><p>{ENVIRONMENT_LABELS[view.environment]} · executed workflows</p></header>
      {a.flows.length === 0 ? <p className="admin-empty">No executed workflows in this range.</p> : <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>Flow</th><th className="num">Executed</th>{OUTCOME_KEYS.map(key => <th key={key} className="num">{OUTCOME_META[key].glyph} {OUTCOME_META[key].label}</th>)}
          <th className="num">Unclassified</th></tr></thead>
        <tbody>{a.flows.map(f => <tr key={f.flow}><td><code>{f.flow}</code></td><td className="num">{fmt(f.executions)}</td>
          {OUTCOME_KEYS.map(key => <td key={key} className="num">{fmt(f[key])}</td>)}<td className="num">{fmt(f.UNCLASSIFIED)}</td></tr>)}</tbody>
      </table></div>}
    </section>
    <section className="admin-card" aria-labelledby="admin-attention">
      <header><h2 id="admin-attention">Requiring attention</h2><p>Uncertain, partial, unclassified or flagged by the worker · newest 25</p></header>
      {attention.length === 0 ? <p className="admin-empty">Nothing requires attention in this range.</p> : <ExecutionRows executions={attention}/>}
    </section>
    <section className="admin-card" aria-labelledby="admin-executions">
      <header><h2 id="admin-executions">Executions</h2><p>Newest {Math.min(LIMIT, listed.length)} of {fmt(listed.length)} started</p></header>
      <nav className="admin-segmented" aria-label="Outcome" style={{ marginBottom: 12 }}>
        {OUTCOME_FILTERS.map(outcome => <a key={outcome} href={withParams('/admin/workflows', params, { outcome: outcome === 'ALL' ? null : outcome })}
          aria-current={view.outcome === outcome ? 'true' : undefined}>{outcome === 'ALL' ? 'All' : OUTCOME_META[outcome].label}</a>)}
      </nav>
      {listed.length === 0 ? <p className="admin-empty">No started executions match.</p> : <ExecutionRows executions={listed.slice(0, LIMIT)}/>}
      <p className="admin-diff">One row per execution: recovery runs are folded into the execution they recover, and composition step runs into their composition.</p>
    </section>
  </AdminShell>;
}
