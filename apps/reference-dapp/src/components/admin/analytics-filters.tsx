// SPDX-License-Identifier: AGPL-3.0-only
import { ENVIRONMENT_LABELS, ENVIRONMENTS, type AnalyticsEnvironment } from '../../admin/analytics/networks';
import { withParams, type AnalyticsParams } from '../../admin/analytics/view';
import type { AnalyticsRange } from '../../admin/analytics/workflows';
import { fmt } from './charts';

const PRESETS = [{ id: '24h', label: '24 hours' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }] as const;
const day = (date: Date) => date.toISOString().slice(0, 10);

/** BUILD-ADMIN-001: time range and environment, as links and a GET form (no client script). Environments are never combined. */
export function AnalyticsFilters({ base, params, range, environment, executedByEnvironment, defaulted }: { base: string; params: AnalyticsParams; range: AnalyticsRange;
  environment: AnalyticsEnvironment; executedByEnvironment: Readonly<Record<AnalyticsEnvironment, number>>; defaulted: boolean }) {
  const keep = { env: params.env ?? null, action: params.action ?? null, outcome: params.outcome ?? null };
  return <section className="admin-card" aria-label="Filters">
    <div className="admin-filters">
      <div className="admin-field">Time range
        <nav className="admin-segmented" aria-label="Time range">
          {PRESETS.map(preset => <a key={preset.id} href={withParams(base, keep, { range: preset.id })} aria-current={range.preset === preset.id ? 'true' : undefined}>{preset.label}</a>)}
          <a href={withParams(base, keep, { range: 'custom', from: day(range.from), to: day(new Date(range.to.getTime() - 1)) })}
            aria-current={range.preset === 'custom' ? 'true' : undefined}>Custom</a>
        </nav>
      </div>
      {range.preset === 'custom' ? <form method="get" action={base} className="admin-filters" aria-label="Custom range">
        {Object.entries(keep).map(([name, value]) => value ? <input key={name} type="hidden" name={name} value={value}/> : null)}
        <input type="hidden" name="range" value="custom"/>
        <label htmlFor="admin-range-from">From (UTC)<input id="admin-range-from" type="date" name="from" defaultValue={day(range.from)}/></label>
        <label htmlFor="admin-range-to">To (UTC, inclusive)<input id="admin-range-to" type="date" name="to" defaultValue={day(new Date(range.to.getTime() - 1))}/></label>
        <button type="submit" className="admin-button">Apply</button>
      </form> : null}
      <div className="admin-field">Environment
        <nav className="admin-segmented" aria-label="Environment">
          {ENVIRONMENTS.map(env => <a key={env} href={withParams(base, { ...params }, { env })} aria-current={environment === env ? 'true' : undefined}>
            {ENVIRONMENT_LABELS[env]} · {fmt(executedByEnvironment[env])}</a>)}
        </nav>
      </div>
    </div>
    <p className="admin-diff" style={{ marginTop: 10 }}>
      {range.from.toISOString().slice(0, 16).replace('T', ' ')} → {range.to.toISOString().slice(0, 16).replace('T', ' ')} UTC · {ENVIRONMENT_LABELS[environment]} only
      {defaulted ? ' (chosen automatically: the first environment with executions in this range)' : ''}. Counts beside each environment are executed workflows.
      {range.invalid ? ' The requested range was invalid, so the last 7 days are shown.' : ''}
    </p>
  </section>;
}
