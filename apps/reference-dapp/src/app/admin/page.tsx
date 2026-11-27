// SPDX-License-Identifier: AGPL-3.0-only
import { ACTION_KINDS, ACTION_LABELS } from '../../admin/analytics/actions';
import { channelPeriod, loadChannelCounts } from '../../admin/analytics/channels';
import { ENVIRONMENT_LABELS, type NetworkInfo } from '../../admin/analytics/networks';
import { param, withParams, workflowView, type AnalyticsParams } from '../../admin/analytics/view';
import { OUTCOME_FILTERS, type WorkflowAnalytics } from '../../admin/analytics/workflows';
import { adminPage } from '../../admin/page-context';
import { copilotStatus, healthAttention, healthStatus } from '../../admin/attention';
import { copilotSettingsView } from '../../admin/copilot-view';
import { finopsPeriod } from '../../admin/finops/economics';
import { readFinopsReport, type FinopsReport } from '../../admin/finops/report';
import { healthReport } from '../../admin/health';
import { loadExecutionAttention } from '../../admin/support/lifecycle';
import { AnalyticsFilters } from '../../components/admin/analytics-filters';
import { AdminShell, AdminUnavailable } from '../../components/admin/admin-shell';
import { ChannelCounts } from '../../components/admin/channel-counts';
import { DataNotes } from '../../components/admin/data-notes';
import { AttentionList, Kpi, Section, StatusTile, TechnicalDetails } from '../../components/admin/admin-ui';
import { Amount } from '../../components/admin/finops-views';
import { finopsCopy } from '../../components/admin/finops-copy';
import { requestLanguage } from '../../server/request-language';
import type { Language } from '../../i18n/language';
import { Donut, fmt, NetworkMark, OUTCOME_KEYS, OUTCOME_META, OutcomeLegend, pct, seriesColor, StackedBars, StackedColumns, TrendLines,
  type DonutSegment } from '../../components/admin/charts';

type Search = Promise<Record<string, string | string[] | undefined>>;
const OUTCOME_LABEL: Record<string, string> = { ALL: 'All outcomes', COMPLETED: 'Completed', FAILED: 'Failed', PARTIAL: 'Partial', IN_PROGRESS: 'In progress', UNCERTAIN: 'Uncertain' };

function NetworkName({ network, environment }: { network: NetworkInfo; environment?: string | undefined }) {
  return <span className="admin-bar-label"><NetworkMark network={network}/><span title={network.chain}>{network.name}</span>
    {environment ? <span className="admin-badge">{environment}</span> : null}</span>;
}

/** Folds the network rows into ≤ 5 named segments (one per color slot, in rank order) plus "Other". */
function donutSegments(rows: WorkflowAnalytics['networks']['rows']): { segments: DonutSegment[]; named: Set<string> } {
  const used = new Set<number>(), named = new Set<string>(), segments: DonutSegment[] = [];
  let other = 0;
  for (const row of rows.filter(r => r.actions > 0)) {
    if (row.slot !== null && !used.has(row.slot) && segments.length < 5) { used.add(row.slot); named.add(row.chain);
      segments.push({ key: row.chain, label: row.name, value: row.actions, color: seriesColor(row.slot) }); }
    else other += row.actions;
  }
  if (other) segments.push({ key: 'other', label: 'Other networks', value: other, color: seriesColor(null) });
  return { segments, named };
}

/** BUILD-ADMIN-AI-PROVIDERS-001 (Admin UX): status at a glance, then what needs attention, each linking to where it is handled. */
function Glance({ health, copilot, language }: { health: Awaited<ReturnType<typeof healthReport>> | null; copilot: Awaited<ReturnType<typeof copilotSettingsView>> | null; language: Language }) {
  const { copy, count } = finopsCopy(language);
  const items = health ? healthAttention(health).filter(item => !['attention', 'attention-partial', 'runs'].includes(item.key)) : [];
  const system = health ? healthStatus(health, items) : { tone: 'warn' as const, value: 'Unavailable', detail: 'The health checks could not run' };
  const ai = copilot ? copilotStatus(copilot) : { tone: 'warn' as const, value: 'Unavailable', detail: 'AI settings could not be read', items: [] };
  const runs = health?.runs ?? null, open = runs?.ok ? runs.value.attention.activeRealFunds : null;
  return <Section id="admin-glance" title={copy('Status at a glance')}>
    <div className="admin-tiles">
      <StatusTile label={copy('System health')} tone={system.tone} value={copy(system.value)} href="/admin/health"/>
      <StatusTile label={copy('Active execution incidents')} tone={open === null || open || runs?.ok && runs.value.truncated ? 'warn' : 'ok'}
        value={open === null ? copy('Unavailable') : runs?.ok && runs.value.truncated ? copy('At least {0}', count(open)) : count(open)}
        href="/admin/support?lifecycle=OPEN" detail={copy('Mainnet and unknown environments')}/>
      <StatusTile label={copy('AI Copilot')} tone={ai.tone} value={copy(ai.value)} href="/admin/ai-settings"/>
    </div>
    {items.length || ai.items.length ? <TechnicalDetails summary={copy('Service and AI checks')}>
      <AttentionList items={[...items, ...ai.items]} allClear={copy('No service warnings.')}/>
    </TechnicalDetails> : null}
  </Section>;
}

function FinanceSummary({ report, language }: { report: FinopsReport | null; language: Language }) {
  const { copy } = finopsCopy(language);
  return <Section id="admin-finance" title={copy('Financial overview')} description={copy('Current month · UTC')}
    actions={<a className="admin-button" href="/admin/finops">{copy('Open FinOps')}</a>}>
    {report ? <div className="admin-table-wrap"><table className="admin-table">
      <thead><tr><th scope="col">{copy('Metric')}</th><th scope="col">{copy('Data quality')}</th><th scope="col" className="num">USD</th></tr></thead>
      <tbody>{([['Recorded expenses', report.metrics.monthToDate], ['Reconciled revenue', report.metrics.revenue]] as const).map(([label, metric]) =>
        <tr key={label}><th scope="row">{copy(label)}</th><td>{copy(metric.quality)}</td>
          <td className="num"><Amount value={metric.amount} language={language}/></td></tr>)}</tbody>
    </table></div> : <p className="admin-alert" data-tone="warn" role="status">{copy('Financial data unavailable.')}</p>}
  </Section>;
}

/** BUILD-ADMIN-001: the operational overview — executions, outcomes, activity, network distribution, utilization and fee observability. */
export default async function AdminOverviewPage({ searchParams }: { searchParams: Search }) {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const search = await searchParams;
  const params: AnalyticsParams = Object.fromEntries((['range', 'from', 'to', 'env', 'action', 'outcome', 'channels'] as const).flatMap(key => {
    const value = param(search[key]); return value ? [[key, value]] : []; }));
  // BUILD-ADMIN-AI-PROVIDERS-001 (Admin UX): the same probes System Health and AI Settings show, summarized first ("is everything normal?").
  // One read of the shared execution-attention model feeds both the glance (all time) and the range figures, so they cannot disagree.
  const shared = loadExecutionAttention(page.host.db, page.host.tenantId, page.now).catch(() => null);
  // BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-25): completed executions by channel, every environment at once (the page's own is shown).
  const channelsPeriod = channelPeriod(params.channels, page.now);
  const [{ language }, view, health, copilot, finance, channels] = await Promise.all([requestLanguage(), workflowView(page.host, params, page.now, shared),
    healthReport(process.env, page.host, page.now, fetch, shared).catch(() => null), copilotSettingsView(process.env, page.host).catch(() => null),
    readFinopsReport(page.host, finopsPeriod(page.now, {}).period, page.now).catch(() => null),
    loadChannelCounts(page.host, { period: channelsPeriod })]);
  const { copy, count } = finopsCopy(language);
  const glance = <Glance health={health} copilot={copilot} language={language}/>;
  const financial = <FinanceSummary report={finance} language={language}/>;
  if (!view.ok) return <AdminShell active="overview" context={page.context} title="Overview">{glance}{financial}<p className="admin-alert" data-tone="bad" role="alert">{copy('Workflow analytics unavailable.')} <code>{view.code}</code></p></AdminShell>;
  const a = view.analytics, env = ENVIRONMENT_LABELS[view.environment];
  const { segments, named } = donutSegments(a.networks.rows);
  const trendSeries: { key: string; name: string; color: string; index: number }[] = [];
  const usedSlots = new Set<number>();
  a.networkTrend.series.forEach((network, index) => { if (network.slot !== null && !usedSlots.has(network.slot)) { usedSlots.add(network.slot);
    trendSeries.push({ key: network.chain, name: network.name, color: seriesColor(network.slot), index }); } });
  const trendPoints = a.networkTrend.points.map(point => ({ at: point.at, counts: trendSeries.map(s => point.counts[s.index] ?? 0),
    other: point.other + point.counts.reduce((n, v, i) => trendSeries.some(s => s.index === i) ? n : n + v, 0) }));
  const networkRows = a.networks.rows.filter(row => row.actions > 0 || row.asDestination > 0);
  const filtered = view.action !== 'ALL' || view.outcome !== 'ALL';
  return <AdminShell active="overview" context={page.context} title="Overview" actions={<>
    <a className="admin-button" data-variant="primary" href="/admin/support">{copy('Open incident center')}</a>
    <a className="admin-button" href="/admin/workflows">{copy('View workflows')}</a>
  </>}>
    {glance}
    <h2 className="admin-section-title">{copy('Workflow activity')}</h2>
    <AnalyticsFilters base="/admin" params={params} range={view.range} environment={view.environment} executedByEnvironment={a.executedByEnvironment} defaulted={view.environmentDefaulted}/>
    <DataNotes view={view}/>

    <section aria-labelledby="admin-kpis"><h2 id="admin-kpis" className="admin-sr">Key figures</h2>
      <div className="admin-kpis">
        <Kpi label={copy('Executed workflows')} value={count(a.funnel.executed)} note={copy('{0} distinct workflows', count(a.workflows.executed))}/>
        <Kpi label={copy('Completed & reconciled')} value={count(a.outcomes.COMPLETED)} tone="ok" note={copy('{0} distinct workflows', count(a.workflows.completed))}/>
        <Kpi label={copy('Failed (confirmed)')} value={count(a.outcomes.FAILED)} tone={a.outcomes.FAILED ? 'bad' : undefined}/>
      </div>
      <p className="admin-diff">{copy('Execution activity includes submissions reported by the wallet whose outcome is still uncertain.')}</p>
    </section>
    <ChannelCounts result={channels} period={channelsPeriod} environment={view.environment} params={params} language={language}/>
    {financial}

    <TechnicalDetails summary={copy('Execution metrics and trends')} className="admin-ops-disclosure" open={filtered || undefined}>
      <div className="admin-kpis">
        <Kpi label={copy('Partial')} value={count(a.outcomes.PARTIAL)} tone={a.outcomes.PARTIAL ? 'warn' : undefined}/>
        <Kpi label={copy('In progress')} value={count(a.outcomes.IN_PROGRESS)} note={a.awaitingSignature ? copy('{0} awaiting a wallet signature', count(a.awaitingSignature)) : undefined}/>
        <Kpi label={copy('Incidents in this period')} value={view.attention ? `${view.attention.truncated ? '≥ ' : ''}${count(a.attention)}` : copy('Unavailable')}
          note={copy('{0} outcome unknown', count(a.outcomes.UNCERTAIN))}/>
        <Kpi label={copy('Success rate')} value={pct(a.rates.success)} note={a.rates.denominator ? copy('of {0} finished', count(a.rates.denominator)) : copy('No finished executions')}/>
        <Kpi label={copy('Failure rate')} value={pct(a.rates.failure)} note={copy('Confirmed failures only')}/>
      </div>
    <div className="admin-grid admin-grid-2">
      <section className="admin-card" aria-labelledby="admin-funnel">
        <header><h2 id="admin-funnel">Execution funnel</h2><p>{env} · one row per execution (re-simulations never start)</p></header>
        <StackedBars label="Execution funnel" rows={[
          { key: 'simulated', label: 'Simulated', title: 'Runs created by a simulation', total: a.funnel.simulated, counts: { IN_PROGRESS: a.funnel.simulated } },
          { key: 'authorized', label: 'Reviewed & authorized', title: 'Reached explicit review authorization', total: a.funnel.authorized, counts: { IN_PROGRESS: a.funnel.authorized } },
          { key: 'started', label: 'Execution started', title: 'The owner’s wallet was asked to sign', total: a.funnel.started, counts: { IN_PROGRESS: a.funnel.started } },
          { key: 'executed', label: 'Submitted or uncertain', title: 'Reported submission or an uncertain wallet result', total: a.funnel.executed, counts: { IN_PROGRESS: a.funnel.executed } },
          { key: 'completed', label: 'Completed & reconciled', title: 'Reconciled verdict, nothing left to observe', total: a.funnel.completed, counts: { COMPLETED: a.funnel.completed } },
        ]}/>
        <p className="admin-diff" style={{ marginTop: 10 }}>{view.savedInRange === null ? 'Saved workflows could not be counted.' : `${fmt(view.savedInRange)} workflows saved in this range (all environments).`}
          {' '}Unsaved Canvas drafts stay in the browser and are not recorded server-side. {fmt(a.notExecuted)} started executions ended with nothing on chain
          (declined in the wallet, expired or cancelled).</p>
      </section>
      <section className="admin-card" aria-labelledby="admin-activity">
        <header><h2 id="admin-activity">Execution activity</h2><p>Executed workflows per {view.range.bucket} (UTC), by outcome</p></header>
        <StackedColumns label="Executed workflows over time" bucket={view.range.bucket} points={a.series}/>
        <OutcomeLegend/>
      </section>
    </div>

    <section className="admin-card" aria-labelledby="admin-networks">
      <header><h2 id="admin-networks">Network distribution</h2><p>{env} · executed actions (a multichain workflow contributes each action to its own network)</p></header>
      <form method="get" action="/admin" className="admin-filters" aria-label="Network distribution filters" style={{ marginBottom: 14 }}>
        {(['range', 'from', 'to', 'channels'] as const).map(key => params[key] ? <input key={key} type="hidden" name={key} value={params[key]}/> : null)}
        <input type="hidden" name="env" value={view.environment}/>
        <label htmlFor="admin-filter-action">Action type
          <select id="admin-filter-action" name="action" defaultValue={view.action}>
            <option value="ALL">All action types</option>{ACTION_KINDS.map(kind => <option key={kind} value={kind}>{ACTION_LABELS[kind]}</option>)}
          </select></label>
        <label htmlFor="admin-filter-outcome">Execution status
          <select id="admin-filter-outcome" name="outcome" defaultValue={view.outcome}>
            {OUTCOME_FILTERS.map(outcome => <option key={outcome} value={outcome}>{OUTCOME_LABEL[outcome]}</option>)}
          </select></label>
        <button type="submit" className="admin-button">Apply</button>
        {filtered ? <a className="admin-button" href={withParams('/admin', params, { action: null, outcome: null })}>Clear</a> : null}
      </form>
      {a.networks.totalActions === 0 ? <p className="admin-empty">No executed actions match these filters{a.networks.executionsWithoutRecord ? ` (${fmt(a.networks.executionsWithoutRecord)} executions have no indexed record yet)` : ''}.</p>
        : <>
          <div className="admin-donut-layout">
            <Donut segments={segments} total={a.networks.totalActions} caption={`Share of executed actions by network (${env}); totals 100%`}/>
            <div className="admin-table-wrap"><table className="admin-table">
              <thead><tr><th>Network</th><th className="num">Executed actions</th><th className="num">Share</th></tr></thead>
              <tbody>{a.networks.rows.filter(row => row.actions > 0).map(row => <tr key={row.chain}>
                <td><span className="admin-bar-label"><span className="admin-swatch" style={{ background: seriesColor(named.has(row.chain) ? row.slot : null) }}/>
                  <NetworkName network={row} environment={view.environment === 'MOCKED' ? 'Mocked' : row.registryEnvironment === 'MAINNET' ? 'Mainnet' : row.registryEnvironment ? 'Testnet' : undefined}/></span></td>
                <td className="num">{fmt(row.actions)}</td><td className="num">{pct(row.share)}</td></tr>)}</tbody>
            </table></div>
          </div>
          <h3 style={{ marginTop: 18 }}>Activity and outcomes by network</h3>
          <StackedBars label="Executed actions by network and outcome" rows={networkRows.filter(row => row.actions > 0).map(row => ({ key: row.chain,
            label: <NetworkName network={row}/>, title: `${row.name}: ${fmt(row.actions)} executed actions`, total: row.actions,
            counts: { COMPLETED: row.COMPLETED, FAILED: row.FAILED, PARTIAL: row.PARTIAL, UNCERTAIN: row.UNCERTAIN, IN_PROGRESS: row.IN_PROGRESS + row.UNCLASSIFIED },
            suffix: <> · {pct(row.share)}</> }))}/>
          <OutcomeLegend/>
          <h3 style={{ marginTop: 18 }}>Workflow participation by network</h3>
          <p className="admin-diff">A workflow can involve several networks (a bridge involves its destination too), so these columns overlap and are not a distribution.</p>
          <div className="admin-table-wrap"><table className="admin-table">
            <thead><tr><th>Network</th><th className="num">Workflows involved</th><th className="num">Completed workflows</th><th className="num">Bridge arrivals</th>
              {OUTCOME_KEYS.map(key => <th key={key} className="num" title={OUTCOME_META[key].label}>{OUTCOME_META[key].glyph} {OUTCOME_META[key].label}</th>)}</tr></thead>
            <tbody>{networkRows.map(row => <tr key={row.chain}><td><NetworkName network={row}/></td><td className="num">{fmt(row.workflowsInvolved)}</td>
              <td className="num">{fmt(row.workflowsCompleted)}</td><td className="num">{fmt(row.asDestination)}</td>
              {OUTCOME_KEYS.map(key => <td key={key} className="num">{fmt(key === 'IN_PROGRESS' ? row.IN_PROGRESS + row.UNCLASSIFIED : row[key])}</td>)}</tr>)}</tbody>
          </table></div>
          <div className="admin-grid admin-grid-2" style={{ marginTop: 18 }}>
            <div><h3>Bridge routes</h3>
              {a.bridgeRoutes.length === 0 ? <p className="admin-empty">No executed bridges match these filters.</p> : <div className="admin-table-wrap"><table className="admin-table">
                <thead><tr><th>Source → destination</th><th className="num">Bridges</th><th className="num">✓</th><th className="num">✕</th><th className="num">Other</th></tr></thead>
                <tbody>{a.bridgeRoutes.map(route => <tr key={`${route.from.chain}>${route.to?.chain}`}>
                  <td><span className="admin-bar-label"><NetworkMark network={route.from}/>{route.from.name} → {route.to ? <><NetworkMark network={route.to}/>{route.to.name}</> : 'unknown'}</span></td>
                  <td className="num">{fmt(route.actions)}</td><td className="num">{fmt(route.COMPLETED)}</td><td className="num">{fmt(route.FAILED)}</td>
                  <td className="num">{fmt(route.PARTIAL + route.UNCERTAIN + route.IN_PROGRESS + route.UNCLASSIFIED)}</td></tr>)}</tbody>
              </table></div>}
              <p className="admin-diff">Each bridge counts once, on its source network; its destination is shown here and as a bridge arrival.</p>
            </div>
            <div><h3>Top networks by action type</h3>
              <div className="admin-table-wrap"><table className="admin-table">
                <thead><tr><th>Action</th><th>Top networks (executed actions)</th></tr></thead>
                <tbody>{a.topByKind.map(entry => <tr key={entry.kind}><td>{ACTION_LABELS[entry.kind]}</td>
                  <td>{entry.networks.length ? entry.networks.map((n, i) => <span key={n.network.chain}>{i ? ' · ' : ''}{n.network.name} {fmt(n.actions)}</span>) : '—'}</td></tr>)}</tbody>
              </table></div>
            </div>
          </div>
          <h3 style={{ marginTop: 18 }}>Network adoption over time</h3>
          <TrendLines label="Executed actions per network over time" bucket={view.range.bucket} series={trendSeries} points={trendPoints}/>
        </>}
    </section>

    <div className="admin-grid admin-grid-2">
      <section className="admin-card" aria-labelledby="admin-utilization">
        <header><h2 id="admin-utilization">Utilization by action type</h2><p>{env} · executed actions</p></header>
        <div className="admin-table-wrap"><table className="admin-table">
          <thead><tr><th>Action type</th><th className="num">Executions</th><th className="num">Executed actions</th><th className="num">✓ Completed</th><th className="num">✕ Failed</th></tr></thead>
          <tbody>{a.utilization.filter(u => u.executions || u.executedActions).map(u => <tr key={u.kind}><td>{ACTION_LABELS[u.kind]}</td>
            <td className="num">{fmt(u.executions)}{u.executionsWithoutRecord ? <span className="admin-diff" title="Attributed by flow: no indexed record"> ({fmt(u.executionsWithoutRecord)}†)</span> : null}</td>
            <td className="num">{fmt(u.executedActions)}</td><td className="num">{fmt(u.completedActions)}</td><td className="num">{fmt(u.failedActions)}</td></tr>)}</tbody>
        </table></div>
        {a.utilization.every(u => !u.executions) ? <p className="admin-empty">No executed workflows in this range.</p> : null}
        <p className="admin-diff">Executions an owner started from an automation proposal are standard, owner-signed executions and are counted here; the{' '}
          <a href="/admin/automations">Automations</a> page shows how many FloFi has linked to their proposal (a verified lower bound). Delegated executions are
          separate records and are not counted here. † attributed by flow only (no indexed canonical record), counted as executions but not as actions.</p>
      </section>
      <section className="admin-card" aria-labelledby="admin-fees">
        <header><h2 id="admin-fees">Platform fee observability</h2><p>Intended model: 0.1% per completed workflow</p></header>
        <div className="admin-table-wrap"><table className="admin-table"><tbody>
          <tr><th scope="row">Completed workflows eligible under the intended model</th><td className="num">{fmt(a.fees.eligibleCompleted)} <span className="admin-badge">{env}</span></td></tr>
          <tr><th scope="row">Fee model</th><td>0.1% per completed workflow (obligation recorded; collection not settled)</td></tr>
          <tr><th scope="row">Fees charged on-chain</th><td><span className="admin-badge" data-tone="warn">Not settled — owner decision required</span></td></tr>
          <tr><th scope="row">Fees reconciled / collected</th><td><span className="admin-badge" data-tone="warn">Obligation only</span></td></tr>
          <tr><th scope="row">Revenue by network and period</th><td><span className="admin-badge">Unavailable until collection settles</span></td></tr>
        </tbody></table></div>
        {a.fees.byNetwork.length ? <p className="admin-diff" style={{ marginTop: 8 }}>Eligible by first-action network: {a.fees.byNetwork.map((n, i) =>
          <span key={n.network.chain}>{i ? ' · ' : ''}{n.network.name} {fmt(n.completed)}</span>)}</p> : null}
        <p className="admin-diff">Completed workflows are eligible for the approved 0.1% obligation (universal bridge runs record it on reconciliation and waive FAILED/REFUNDED).
          On-chain collection is not settled: Relay is still called without appFees; Jupiter refuses a platform fee. Owner settlement options are listed in the universal-bridge build report.</p>
      </section>
    </div>

    <section className="admin-card" aria-labelledby="admin-errors">
      <header><h2 id="admin-errors">Recent errors</h2><p>{env} · closed error codes of started executions</p></header>
      {a.errors.length === 0 ? <p className="admin-empty">No recorded error codes in this range.</p> : <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>Code</th><th className="num">Executions</th><th>Flows</th><th>Last seen (UTC)</th></tr></thead>
        <tbody>{a.errors.map(e => <tr key={e.code}><td><code>{e.code}</code></td><td className="num">{fmt(e.count)}</td><td>{e.flows.join(', ')}</td>
          <td className="admin-mono">{e.lastAt.replace('T', ' ').slice(0, 16)}</td></tr>)}</tbody>
      </table></div>}
      <p className="admin-diff"><a href={withParams('/admin/workflows', params, {})}>Open Workflows</a> for the executions behind these figures. System incidents are on <a href="/admin/health">System Health</a>.</p>
    </section>
    </TechnicalDetails>
  </AdminShell>;
}
