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
import { CONDITION_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER, type AttentionEntry, type Lifecycle } from '../../../admin/support/lifecycle';

const LIFECYCLE_TONE: Readonly<Record<Lifecycle, 'warn' | 'info' | undefined>> = { ACTIVE: 'warn', UNDER_INVESTIGATION: 'info', HISTORICAL: undefined, VERIFIED_RESOLVED: undefined };
const incidentHref = (runId: string) => `/admin/support/incident?id=${encodeURIComponent(`run:${runId}`)}`;
function LifecycleBadge({ lifecycle }: { lifecycle: Lifecycle }) {
  return <span className="admin-badge" data-tone={LIFECYCLE_TONE[lifecycle]}>{LIFECYCLE_LABELS[lifecycle]}</span>;
}
/** The most pressing lifecycle among an execution's runs (recovery runs are folded into the execution they recover). */
const worst = (runIds: readonly string[], byRun: ReadonlyMap<string, Lifecycle>): Lifecycle | null =>
  LIFECYCLE_ORDER.find(lifecycle => runIds.some(id => byRun.get(id) === lifecycle)) ?? null;

/** Runs from the shared attention model: outcome and lifecycle side by side, with why. */
function AttentionRows({ entries }: { entries: readonly AttentionEntry[] }) {
  return <div className="admin-table-wrap"><table className="admin-table">
    <thead><tr><th>Updated (UTC)</th><th>Flow</th><th>Environment</th><th>Transaction outcome</th><th>Incident</th><th>Why</th><th>Error code</th><th>Run</th></tr></thead>
    <tbody>{entries.map(({ run, attention }) => <tr key={run.runId}>
      <td className="admin-mono">{when(run.updatedAt)}</td><td><code>{run.flow}</code></td><td><code>{run.provenance}</code></td>
      <td><OutcomeBadge outcome={attention.outcome}/></td>
      <td>{attention.lifecycle ? <LifecycleBadge lifecycle={attention.lifecycle}/> : '—'}{attention.flagged ? <span className="admin-diff"> · flag kept</span> : null}</td>
      <td>{attention.conditions.length ? attention.conditions.map(code => CONDITION_LABELS[code]).join('; ') : attention.explanation}
        {attention.ownerReviewPending ? <span className="admin-diff"> · owner review pending (not an incident)</span> : null}</td>
      <td>{run.errorCode ? <code>{run.errorCode}</code> : '—'}</td>
      <td><a href={incidentHref(run.runId)} aria-label={`Diagnose run ${short(run.runId)}`}><code>{short(run.runId)}</code></a></td>
    </tr>)}</tbody>
  </table></div>;
}

type Search = Promise<Record<string, string | string[] | undefined>>;
const LIMIT = 100;
const when = (date: Date) => date.toISOString().replace('T', ' ').slice(0, 16);
const short = (id: string) => id.length > 16 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;

function ExecutionRows({ executions, lifecycleByRun }: { executions: readonly Execution[]; lifecycleByRun: ReadonlyMap<string, Lifecycle> | null }) {
  return <div className="admin-table-wrap"><table className="admin-table">
    <thead><tr><th>Started (UTC)</th><th>Flow</th><th>Actions</th><th>Networks</th><th>Outcome</th><th>Error code</th><th>Run</th></tr></thead>
    <tbody>{executions.map(e => {
      const chains = e.actions ? [...new Set(e.actions.flatMap(a => a.to ? [a.chain, a.to] : [a.chain]))] : [];
      const lifecycle = lifecycleByRun ? worst(e.runIds, lifecycleByRun) : null;
      return <tr key={e.rootId}>
        <td className="admin-mono">{when(e.createdAt)}</td><td><code>{e.flow}</code></td>
        <td>{e.actions ? e.actions.map(a => ACTION_LABELS[a.kind]).join(' → ') : <span className="admin-diff" title={e.factCode ?? ''}>not indexed</span>}</td>
        <td>{chains.length ? chains.map(chain => networkInfo(chain).name).join(', ') : '—'}</td>
        <td><OutcomeBadge outcome={e.classification.outcome}/>
          {lifecycleByRun ? lifecycle ? <> <LifecycleBadge lifecycle={lifecycle}/></> : null
            : e.classification.attention ? <> <span className="admin-badge" data-tone="warn">attention</span></> : null}
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
  const shared = view.attention, byRun = shared ? view.lifecycleByRun : null;
  const open = shared ? shared.entries.filter(e => e.attention.lifecycle === 'ACTIVE' || e.attention.lifecycle === 'UNDER_INVESTIGATION') : [];
  const past = shared ? shared.entries.filter(e => e.attention.lifecycle === 'HISTORICAL' || e.attention.lifecycle === 'VERIFIED_RESOLVED') : [];
  const fallback = shared ? [] : scoped.filter(e => e.classification.attention).slice(0, 25);
  return <AdminShell active="workflows" context={page.context} title="Workflows" description="Every started execution, how it ended, and — separately — whether an incident about it is active, historical or resolved.">
    <AnalyticsFilters base="/admin/workflows" params={params} range={view.range} environment={view.environment} executedByEnvironment={a.executedByEnvironment}
      defaulted={view.environmentDefaulted}/>
    <DataNotes view={view}/>
    {shared ? <>
      <section className="admin-card" aria-labelledby="admin-attention" data-tone={open.length ? 'warn' : undefined}>
        <header><h2 id="admin-attention">Requiring attention</h2>
          <p>Active and under-investigation incidents · all environments, all time — the same count as System Health and Support &amp; Recovery
            ({fmt(open.length)}{shared.truncated ? ', at least' : ''}) · newest 25</p></header>
        {open.length === 0 ? <p className="admin-empty">No execution has an active incident.</p> : <AttentionRows entries={open.slice(0, 25)}/>}
      </section>
      <section className="admin-card" aria-labelledby="admin-historical">
        <header><h2 id="admin-historical">Historical attention</h2>
          <p>Flagged earlier, no active condition now · {fmt(shared.counts.historical)} historical (not verified), {fmt(shared.counts.resolved)} verified resolved · the original flag is kept</p></header>
        {past.length === 0 ? <p className="admin-empty">No historical attention flags.</p> : <details><summary>Show {fmt(Math.min(25, past.length))} newest</summary>
          <AttentionRows entries={past.slice(0, 25)}/></details>}
      </section>
    </> : <section className="admin-card" aria-labelledby="admin-attention" data-tone={fallback.length ? 'warn' : undefined}>
      <header><h2 id="admin-attention">Requiring attention</h2><p>The attention model could not be read: showing the outcome classifier and the raw flag in this range, which
        mixes historical flags with active incidents · newest 25</p></header>
      {fallback.length === 0 ? <p className="admin-empty">Nothing requires attention in this range.</p> : <ExecutionRows executions={fallback} lifecycleByRun={null}/>}
    </section>}
    <section className="admin-card" aria-labelledby="admin-flows">
      <header><h2 id="admin-flows">By flow</h2><p>{ENVIRONMENT_LABELS[view.environment]} · executed workflows</p></header>
      {a.flows.length === 0 ? <p className="admin-empty">No executed workflows in this range.</p> : <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>Flow</th><th className="num">Executed</th>{OUTCOME_KEYS.map(key => <th key={key} className="num">{OUTCOME_META[key].glyph} {OUTCOME_META[key].label}</th>)}
          <th className="num">Unclassified</th></tr></thead>
        <tbody>{a.flows.map(f => <tr key={f.flow}><td><code>{f.flow}</code></td><td className="num">{fmt(f.executions)}</td>
          {OUTCOME_KEYS.map(key => <td key={key} className="num">{fmt(f[key])}</td>)}<td className="num">{fmt(f.UNCLASSIFIED)}</td></tr>)}</tbody>
      </table></div>}
    </section>
    <section className="admin-card" aria-labelledby="admin-executions">
      <header><h2 id="admin-executions">Executions</h2><p>Newest {Math.min(LIMIT, listed.length)} of {fmt(listed.length)} started</p></header>
      <nav className="admin-segmented" aria-label="Outcome" style={{ marginBottom: 12 }}>
        {OUTCOME_FILTERS.map(outcome => <a key={outcome} href={withParams('/admin/workflows', params, { outcome: outcome === 'ALL' ? null : outcome })}
          aria-current={view.outcome === outcome ? 'true' : undefined}>{outcome === 'ALL' ? 'All' : OUTCOME_META[outcome].label}</a>)}
      </nav>
      {listed.length === 0 ? <p className="admin-empty">No started executions match.</p> : <ExecutionRows executions={listed.slice(0, LIMIT)} lifecycleByRun={byRun}/>}
      <p className="admin-diff">One row per execution: recovery runs are folded into the execution they recover, and composition step runs into their composition.</p>
    </section>
  </AdminShell>;
}
