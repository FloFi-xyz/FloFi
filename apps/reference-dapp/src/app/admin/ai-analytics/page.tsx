// SPDX-License-Identifier: AGPL-3.0-only
import { copilotAnalytics } from '../../../admin/analytics/copilot';
import { adminPage } from '../../../admin/page-context';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { Kpi, Section, TechnicalDetails } from '../../../components/admin/admin-ui';
import { fmt } from '../../../components/admin/charts';
import { ANTHROPIC_CONSOLE, MODEL_PRICES_CHECKED } from '../../../server/copilot-providers';

type Search = Promise<Record<string, string | string[] | undefined>>;
const PROVIDER: Record<string, string> = { OPENAI: 'OpenAI', ANTHROPIC: 'Anthropic', REPLAY: 'Replay (no provider)' };
const SURFACE: Record<string, string> = { WEB: 'FloFi chat (web)', CHANNEL: 'Telegram / WhatsApp' };
const usd = (value: number) => value === 0 ? '$0.00' : value < 0.01 ? `< $0.01` : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * BUILD-ADMIN-001 / BUILD-ADMIN-AI-PROVIDERS-001: durable daily counters for conversational planning, now with usage and an estimated cost
 * per provider, model and surface. Measured tokens, estimated spending and provider billing are kept visibly apart.
 */
export default async function CopilotAnalyticsPage({ searchParams }: { searchParams: Search }) {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const params = await searchParams;
  let view;
  try { view = await copilotAnalytics(page.host, { days: typeof params.days === 'string' ? params.days : undefined, mode: typeof params.mode === 'string' ? params.mode : undefined }, page.now); }
  catch { return <AdminShell active="ai-analytics" context={page.context} title="AI Analytics"><p className="admin-alert" data-tone="bad">AI analytics are unavailable (COPILOT_METRICS_UNAVAILABLE).</p></AdminShell>; }
  const anthropic = view.usage.some(line => line.provider === 'ANTHROPIC');
  return <AdminShell active="ai-analytics" context={page.context} title="AI Analytics"
    description="How much the AI Copilot is used, how well it plans, and what it is estimated to cost — per provider, model and channel.">
    <form className="admin-filters admin-card" method="get" action="/admin/ai-analytics" aria-label="AI analytics filters">
      <label htmlFor="ai-metrics-days">Period<select id="ai-metrics-days" name="days" defaultValue={String(view.days)}>
        <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option>
      </select></label>
      <label htmlFor="ai-metrics-mode">Data source<select id="ai-metrics-mode" name="mode" defaultValue={view.mode}>
        <option value="live">Live model</option><option value="replay">Replay</option>
      </select></label><button className="admin-button" type="submit">Apply</button>
    </form>
    <div className="admin-kpis">
      {[['Model requests', view.interpretations], ['Model failures', view.interpretationFailures], ['Tool calls', view.toolCalls], ['Tool failures', view.toolFailures],
        ['Channel proposals', view.proposals], ['Browser proposal reports', view.browserProposals], ['Clarification turns', view.clarifications], ['Validation mismatches', view.mismatches]]
        .map(([label, value]) => <Kpi key={String(label)} label={String(label)} value={fmt(Number(value))}
          tone={label === 'Model failures' && Number(value) ? 'warn' : undefined}/>)}
    </div>

    <Section id="ai-provider-usage" title="Usage by provider and model" description={`Server-measured Copilot interpretations, ${view.days} days (UTC). One interpretation is one user turn: with tools it can make up to four provider calls (their tokens are summed); turns refused before any provider call (busy, invalid input) are counted as errors. Telegram and WhatsApp are counted together as channels.`}>
      <div className="admin-kpis" style={{ marginBottom: 14 }}>
        <Kpi label="Input tokens (measured)" value={fmt(view.inputTokens)}/>
        <Kpi label="Output tokens (measured)" value={fmt(view.outputTokens)}/>
        <Kpi label="Estimated cost" value={view.estimatedCostUsd === null ? '—' : usd(view.estimatedCostUsd)}
          note={[view.unpricedRequests ? `${fmt(view.unpricedRequests)} interpretations without a listed price` : null,
            view.unreportedRequests ? `${fmt(view.unreportedRequests)} without reported usage (not included)` : null].filter(Boolean).join(' · ') || 'list prices × measured tokens'}/>
      </div>
      {view.usage.length === 0 ? <p className="admin-empty">No model requests recorded in this period. This does not establish that none occurred.</p>
        : <div className="admin-table-wrap"><table className="admin-table" aria-label="Usage by provider and model">
          <thead><tr><th>Provider</th><th>Model</th><th>Channel</th><th className="num">Interpretations</th><th className="num">Errors</th><th className="num">Input tokens</th>
            <th className="num">Output tokens</th><th className="num">Mean latency</th><th className="num">Estimated cost</th></tr></thead>
          <tbody>{view.usage.map(line => <tr key={`${line.model}:${line.surface}`}>
            <td>{PROVIDER[line.provider]}</td><td><code>{line.model}</code></td><td>{SURFACE[line.surface]}</td>
            <td className="num">{fmt(line.requests)}</td><td className="num">{fmt(line.failures)}</td>
            <td className="num">{fmt(line.inputTokens)}{line.usageSamples < line.requests ? <span className="admin-diff" title="Requests that reported token usage"> ({fmt(line.usageSamples)} reported)</span> : null}</td>
            <td className="num">{fmt(line.outputTokens)}</td><td className="num">{line.meanLatencyMs === null ? '—' : `${fmt(line.meanLatencyMs)} ms`}</td>
            <td className="num">{line.estimatedCostUsd === null ? <span className="admin-diff">no listed price</span> : usd(line.estimatedCostUsd)}</td>
          </tr>)}</tbody></table></div>}
      <div className="admin-note" role="note" style={{ marginTop: 12 }}>
        <p><strong>Measured</strong> — requests, tokens and latency are counted by FloFi&rsquo;s server for each model request.</p>
        <p><strong>Estimated</strong> — cost is the provider&rsquo;s published list price (checked {MODEL_PRICES_CHECKED}) times measured tokens. It ignores credits, discounts,
          taxes and requests made outside FloFi, and no OpenAI price is listed yet. It is not an invoice.</p>
        <p><strong>Billing</strong> — confirmed spend and any promotional credit balance exist only in the provider&rsquo;s console:{' '}
          <a href={ANTHROPIC_CONSOLE.billing} target="_blank" rel="noreferrer noopener">Anthropic billing</a> ·{' '}
          <a href={ANTHROPIC_CONSOLE.usage} target="_blank" rel="noreferrer noopener">Anthropic usage</a>{anthropic ? '' : ' (no Anthropic requests in this period)'}.
          FloFi does not read credit balances.</p>
      </div>
    </Section>

    <Section id="ai-observations" title="Planning observations" description="Daily rows by surface, reporting source, outcome and model.">
      <p className="admin-diff">UTC daily aggregates cover up to 90 days. Older records are removed on new observations or Admin reads. Server interpretations and channel turns are measured on the server. Browser turns are client reports and may be missing or forged.
        {' '}Proposals, clarifications and model success describe planning; execution and reconciliation are measured separately in Workflows. Replay is never included in live figures.</p>
      {view.rows.length === 0 ? <p className="admin-empty">No persisted observations in this period. This does not establish that no requests occurred.</p> :
        <TechnicalDetails summary={`Daily rows (${fmt(view.rows.length)})`}>
          <p className="admin-diff">Repeat and correction reports count turns whose open request contains those events; they are not distinct event counts.
            Reasoning tokens (where a provider reports them): {fmt(view.reasoningTokens)}. Requests with known input usage: {fmt(view.tokenSamples)} / {fmt(view.interpretations)}.</p>
          <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Day</th><th>Surface / source</th><th>Observation</th><th>Outcome</th><th>Model</th>
            <th className="num">Count</th><th className="num">Mean latency</th><th className="num">Tools / failed</th><th className="num">Mismatches</th><th className="num">Repeat / correction reports</th><th className="num">Mean turns to proposal</th></tr></thead>
            <tbody>{view.rows.map(row => <tr key={[row.day, row.surface, row.provenance, row.kind, row.outcome, row.model].join(':')}>
              <td>{row.day}</td><td>{row.surface} / {row.provenance}</td><td>{row.kind}</td><td>{row.outcome}</td><td>{row.model || '—'}</td><td className="num">{fmt(row.events)}</td>
              <td className="num">{row.kind === 'INTERPRETATION' && row.events ? `${Math.round(row.duration_ms / row.events)} ms` : '—'}</td>
              <td className="num">{fmt(row.tool_calls)} / {fmt(row.tool_failures)}</td><td className="num">{fmt(row.mismatches)}</td>
              <td className="num">{fmt(row.repeated_question_reports)} / {fmt(row.correction_reports)}</td><td className="num">{row.proposals ? (row.turns_to_proposal / row.proposals).toFixed(1) : '—'}</td>
            </tr>)}</tbody></table></div>
        </TechnicalDetails>}
    </Section>
  </AdminShell>;
}
