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
import { CONDITION_LABELS, isOpen, LIFECYCLE_LABELS, LIFECYCLE_ORDER, OBSERVATION_LABELS, type AttentionEntry, type Lifecycle } from '../../../admin/support/lifecycle';
import { TechnicalDetails } from '../../../components/admin/admin-ui';
import { finopsCopy } from '../../../components/admin/finops-copy';
import { requestLanguage } from '../../../server/request-language';
import type { Language } from '../../../i18n/language';

const LIFECYCLE_TONE: Readonly<Record<Lifecycle, 'warn' | 'info' | undefined>> = { ACTIVE: 'warn', UNDER_INVESTIGATION: 'info', HISTORICAL: undefined, VERIFIED_RESOLVED: undefined };
const incidentHref = (runId: string) => `/admin/support/incident?id=${encodeURIComponent(`run:${runId}`)}`;
function LifecycleBadge({ lifecycle }: { lifecycle: Lifecycle }) {
  return <span className="admin-badge" data-tone={LIFECYCLE_TONE[lifecycle]}>{LIFECYCLE_LABELS[lifecycle]}</span>;
}
/** The most pressing lifecycle among an execution's runs (recovery runs are folded into the execution they recover). */
const worst = (runIds: readonly string[], byRun: ReadonlyMap<string, Lifecycle>): Lifecycle | null =>
  LIFECYCLE_ORDER.find(lifecycle => runIds.some(id => byRun.get(id) === lifecycle)) ?? null;

/** Runs from the shared attention model: outcome and lifecycle side by side, with why. */
function AttentionRows({ entries, language }: { entries: readonly AttentionEntry[]; language: Language }) {
  const { copy, time } = finopsCopy(language);
  return <div className="admin-table-wrap admin-table-scroll" tabIndex={0} role="region" aria-label={copy('Execution incidents')}><table className="admin-table">
    <thead><tr>{['Updated (UTC)', 'Flow', 'Environment', 'Transaction outcome', 'Incident', 'Diagnostics'].map(label => <th scope="col" key={label}>{copy(label)}</th>)}</tr></thead>
    <tbody>{entries.map(({ run, attention }) => <tr key={run.runId}>
      <td><time dateTime={run.updatedAt.toISOString()}>{time(run.updatedAt.toISOString())}</time></td><td>{run.flow}</td><td><code>{run.provenance}</code></td>
      <td>{attention.conditions.includes('RESULT_DIVERGED') ? <span className="admin-badge" data-tone="warn">{copy('Diverged from the review')}</span>
        : <OutcomeBadge outcome={attention.outcome}/>}</td>
      <td>{attention.lifecycle ? <span className="admin-badge" data-tone={LIFECYCLE_TONE[attention.lifecycle]}>{copy(LIFECYCLE_LABELS[attention.lifecycle])}</span> : '—'}
        {attention.observation ? <p className="admin-diff">{copy(OBSERVATION_LABELS[attention.observation])}</p> : null}</td>
      <td><a href={incidentHref(run.runId)}>{copy('Diagnose')} <code>{short(run.runId)}</code></a>
        <TechnicalDetails summary={copy('Details')}>
          <p>{attention.conditions.length ? attention.conditions.map(code => copy(CONDITION_LABELS[code])).join(' · ') : copy(attention.explanation)}</p>
          {run.errorCode ? <code>{run.errorCode}</code> : null}
          {attention.flagged ? <p>{copy('Original attention flag retained.')}</p> : null}
          {attention.ownerReviewPending ? <p>{copy('Owner review pending for future execution.')}</p> : null}
        </TechnicalDetails>
      </td>
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
  const [{ language }, view] = await Promise.all([requestLanguage(), workflowView(page.host, params, page.now)]);
  const { copy, count } = finopsCopy(language);
  if (!view.ok) return <AdminShell active="workflows" context={page.context} title="Workflows"><p className="admin-alert" data-tone="bad">Analytics are unavailable ({view.code}).</p></AdminShell>;
  const a = view.analytics, scoped = view.executions.filter(e => e.environment === view.environment && e.classification.started)
    .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
  const listed = scoped.filter(e => view.outcome === 'ALL' || e.classification.outcome === view.outcome);
  const shared = view.attention, byRun = shared ? view.lifecycleByRun : null;
  const open = shared?.entries.filter(e => isOpen(e.attention.lifecycle) && e.attention.realFunds) ?? [];
  const test = shared?.entries.filter(e => isOpen(e.attention.lifecycle) && !e.attention.realFunds) ?? [];
  const past = shared ? shared.entries.filter(e => e.attention.lifecycle === 'HISTORICAL' || e.attention.lifecycle === 'VERIFIED_RESOLVED') : [];
  const fallback = shared ? [] : scoped.filter(e => e.classification.attention).slice(0, 25);
  return <AdminShell active="workflows" context={page.context} title="Workflows"
    actions={<a className="admin-button" href="/admin/support">{copy('Open incident center')}</a>}>
    <AnalyticsFilters base="/admin/workflows" params={params} range={view.range} environment={view.environment} executedByEnvironment={a.executedByEnvironment}
      defaulted={view.environmentDefaulted}/>
    <DataNotes view={view}/>
    {shared ? <>
      <section className="admin-card" aria-labelledby="admin-attention" data-tone={open.length ? 'warn' : undefined}>
        <header><h2 id="admin-attention">{copy('Requiring attention')}</h2>
          <p>{copy('Mainnet and unknown environments')} · {shared.truncated ? copy('At least {0}', count(open.length)) : count(open.length)}</p></header>
        {open.length === 0 ? <p className="admin-empty">{copy(shared.truncated ? 'No matching records in the available results.' : 'No incidents match this view.')}</p>
          : <AttentionRows entries={open.slice(0, 25)} language={language}/>}
        {test.length ? <TechnicalDetails summary={copy('Test and mock incidents ({0})', count(test.length))}>
          <AttentionRows entries={test.slice(0, 25)} language={language}/>
        </TechnicalDetails> : null}
      </section>
      <section className="admin-card" aria-labelledby="admin-historical">
        <header><h2 id="admin-historical">{copy('Historical attention')}</h2>
          <p>{copy('{0} historical · {1} verified resolved', count(shared.counts.historical), count(shared.counts.resolved))}{shared.truncated ? ` · ${copy('Partial results')}` : ''}</p></header>
        {past.length === 0 ? <p className="admin-empty">{copy('No matching records in the available results.')}</p> : <TechnicalDetails summary={copy('Show {0} newest', count(Math.min(25, past.length)))}>
          <AttentionRows entries={past.slice(0, 25)} language={language}/></TechnicalDetails>}
      </section>
    </> : <section className="admin-card" aria-labelledby="admin-attention" data-tone={fallback.length ? 'warn' : undefined}>
      <header><h2 id="admin-attention">{copy('Requiring attention')}</h2></header>
      <p className="admin-alert" data-tone="warn" role="status">{copy('Execution incident data is unavailable.')}</p>
      {fallback.length > 0 ? <TechnicalDetails summary={copy('Execution records with raw attention flags')}><ExecutionRows executions={fallback} lifecycleByRun={null}/></TechnicalDetails> : null}
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
