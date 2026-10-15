// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the console's charts — plain server-rendered SVG/HTML (no chart library, no client script). Networks keep a fixed color
 * per network family (`--a-s1`…`--a-s5`, validated for both themes; anything else is "Other"), so a color follows the network, never its
 * rank. Outcomes use the reserved status colors and always carry a glyph and a label. Every mark has a native tooltip; every chart sits
 * next to the numbers it draws.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { NetworkInfo } from '../../admin/analytics/networks';

export const OUTCOME_KEYS = ['COMPLETED', 'FAILED', 'PARTIAL', 'UNCERTAIN', 'IN_PROGRESS'] as const;
export type OutcomeKey = (typeof OUTCOME_KEYS)[number];
export const OUTCOME_META: Readonly<Record<OutcomeKey, { label: string; glyph: string; color: string; tone: string }>> = {
  COMPLETED: { label: 'Completed', glyph: '✓', color: 'var(--a-st-good)', tone: 'ok' },
  FAILED: { label: 'Failed', glyph: '✕', color: 'var(--a-st-critical)', tone: 'bad' },
  PARTIAL: { label: 'Partial', glyph: '◐', color: 'var(--a-st-serious)', tone: 'warn' },
  UNCERTAIN: { label: 'Uncertain', glyph: '?', color: 'var(--a-st-warning)', tone: 'warn' },
  IN_PROGRESS: { label: 'In progress', glyph: '…', color: 'var(--a-st-neutral)', tone: '' },
};
export const seriesColor = (slot: number | null) => slot ? `var(--a-s${slot})` : 'var(--a-other)';
export const fmt = (n: number) => n.toLocaleString('en-US');
export const pct = (value: number | null, digits = 1) => value === null ? '—' : `${(value * 100).toFixed(digits)}%`;

/** A network's local mark from FloFi's registry, else a monogram. */
export function NetworkMark({ network }: { network: Pick<NetworkInfo, 'name' | 'mark' | 'family'> }) {
  if (network.mark) return <span className="admin-network-icon"><img src={network.mark} alt="" width={20} height={20}/></span>;
  const hueOf = [...network.family].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return <span className="admin-network-icon"><span className="brand-mark-monogram" style={{ '--mark-hue': String(hueOf) } as CSSProperties} aria-hidden="true">
    {network.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'}</span></span>;
}
export function OutcomeLegend({ keys = OUTCOME_KEYS }: { keys?: readonly OutcomeKey[] }) {
  return <ul className="admin-legend" aria-label="Outcome legend">{keys.map(key => <li key={key}>
    <span className="admin-swatch" style={{ background: OUTCOME_META[key].color }}/>{OUTCOME_META[key].glyph} {OUTCOME_META[key].label}</li>)}</ul>;
}
export function OutcomeBadge({ outcome }: { outcome: string }) {
  const meta = OUTCOME_META[outcome as OutcomeKey];
  if (meta) return <span className="admin-badge" data-tone={meta.tone || undefined}>{meta.glyph} {meta.label}</span>;
  const label: Record<string, string> = { NOT_EXECUTED: 'Not executed', NOT_STARTED: 'Not started', UNCLASSIFIED: 'Unclassified' };
  return <span className="admin-badge" data-tone={outcome === 'UNCLASSIFIED' ? 'warn' : undefined}>{label[outcome] ?? outcome}</span>;
}

export type DonutSegment = { readonly key: string; readonly label: string; readonly value: number; readonly color: string };
/** Part-to-whole at a glance (≤ 6 segments, the caller folds the tail into "Other"), with a 2px surface gap between segments. */
export function Donut({ segments, total, caption }: { segments: readonly DonutSegment[]; total: number; caption: string }) {
  const r = 70, c = 2 * Math.PI * r, gap = segments.filter(s => s.value > 0).length > 1 ? 2 : 0;
  let offset = 0;
  return <figure className="admin-chart" style={{ margin: 0 }}>
    <svg viewBox="0 0 200 200" width="200" height="200" role="img" aria-label={caption}>
      <circle cx="100" cy="100" r={r} fill="none" stroke="var(--a-soft)" strokeWidth="26"/>
      {total > 0 ? segments.filter(s => s.value > 0).map(segment => {
        const length = (segment.value / total) * c, dash = Math.max(length - gap, 0.5);
        const element = <circle key={segment.key} cx="100" cy="100" r={r} fill="none" stroke={segment.color} strokeWidth="26"
          strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset} transform="rotate(-90 100 100)">
          <title>{`${segment.label}: ${fmt(segment.value)} (${pct(segment.value / total)})`}</title></circle>;
        offset += length;
        return element;
      }) : null}
      <text x="100" y="96" textAnchor="middle" style={{ fontSize: 26, fontWeight: 600, fill: 'var(--a-ink)' }}>{fmt(total)}</text>
      <text x="100" y="118" textAnchor="middle">executed actions</text>
    </svg>
    <figcaption className="admin-diff" style={{ textAlign: 'center' }}>{caption}</figcaption>
  </figure>;
}

export type StackedRow = { readonly key: string; readonly label: ReactNode; readonly title: string; readonly counts: Readonly<Partial<Record<OutcomeKey, number>>>;
  readonly total: number; readonly suffix?: ReactNode };
/** Horizontal bars, one per row, stacked by outcome; the value sits outside the bar end. */
export function StackedBars({ rows, label }: { rows: readonly StackedRow[]; label: string }) {
  const max = Math.max(1, ...rows.map(row => row.total));
  return <div className="admin-bars" role="list" aria-label={label}>{rows.map(row => <div key={row.key} className="admin-bar-row" role="listitem">
    <div className="admin-bar-label">{row.label}</div>
    <div className="admin-bar-track" style={{ width: `${Math.max(2, (row.total / max) * 100)}%`, gap: 2 }} title={row.title}>
      {OUTCOME_KEYS.filter(key => (row.counts[key] ?? 0) > 0).map(key => <span key={key} style={{ flex: row.counts[key], background: OUTCOME_META[key].color }}
        title={`${OUTCOME_META[key].label}: ${fmt(row.counts[key]!)}`}/>)}
    </div>
    <div className="admin-bar-value">{fmt(row.total)}{row.suffix}</div>
  </div>)}</div>;
}

/** Columns over time, stacked by outcome (one y-axis, hairline solid grid, ≤ 24px columns, 2px surface gaps). */
export function StackedColumns({ points, bucket, label }: { points: readonly ({ at: number } & Partial<Record<OutcomeKey, number>>)[]; bucket: 'hour' | 'day' | 'week';
  label: string }) {
  const width = 760, height = 200, left = 36, bottom = 22, top = 8, plot = height - bottom - top;
  const totals = points.map(p => OUTCOME_KEYS.reduce((n, key) => n + (p[key] ?? 0), 0)), max = Math.max(1, ...totals);
  const step = niceStep(max), ceiling = Math.ceil(max / step) * step, slot = (width - left) / Math.max(1, points.length), bar = Math.min(24, Math.max(2, slot - 4));
  const every = Math.max(1, Math.ceil(points.length / 8));
  const tick = (at: number) => { const d = new Date(at); return bucket === 'hour' ? `${String(d.getUTCHours()).padStart(2, '0')}:00` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
  return <figure className="admin-chart" style={{ margin: 0 }}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} preserveAspectRatio="none" style={{ width: '100%', height: 200 }}>
      {Array.from({ length: Math.round(ceiling / step) + 1 }, (_, i) => i * step).map(value => {
        const y = top + plot - (value / ceiling) * plot;
        return <g key={value}><line x1={left} x2={width} y1={y} y2={y} stroke="var(--a-line)" strokeWidth="1"/>
          <text x={left - 6} y={y + 4} textAnchor="end">{compact(value)}</text></g>;
      })}
      {points.map((point, i) => {
        let y = top + plot;
        const x = left + i * slot + (slot - bar) / 2, parts = OUTCOME_KEYS.filter(key => (point[key] ?? 0) > 0);
        return <g key={point.at}>
          <title>{`${new Date(point.at).toISOString().slice(0, bucket === 'hour' ? 13 : 10).replace('T', ' ')}${bucket === 'hour' ? ':00' : ''} UTC — ${fmt(totals[i]!)} executions${
            parts.map(key => ` · ${OUTCOME_META[key].label} ${point[key]}`).join('')}`}</title>
          <rect x={left + i * slot} y={top} width={slot} height={plot} fill="transparent"/>
          {parts.map((key, index) => {
            const h = ((point[key] ?? 0) / ceiling) * plot, gapped = index < parts.length - 1 ? Math.max(h - 2, 0.5) : h;
            y -= h;
            return <rect key={key} x={x} y={y + (h - gapped)} width={bar} height={gapped} fill={OUTCOME_META[key].color} rx={index === parts.length - 1 ? 3 : 0}/>;
          })}
          {i % every === 0 ? <text x={left + i * slot + slot / 2} y={height - 6} textAnchor="middle">{tick(point.at)}</text> : null}
        </g>;
      })}
      <line x1={left} x2={width} y1={top + plot} y2={top + plot} stroke="var(--a-axis)" strokeWidth="1"/>
    </svg>
  </figure>;
}

/** Up to five network lines over time (2px lines, end markers with a surface ring); "Other" folds the rest. */
export function TrendLines({ series, points, bucket, label }: { series: readonly { key: string; name: string; color: string }[];
  points: readonly { at: number; counts: readonly number[]; other: number }[]; bucket: 'hour' | 'day' | 'week'; label: string }) {
  const width = 760, height = 200, left = 36, bottom = 22, top = 10, plot = height - bottom - top;
  const all = [...series, ...points.some(p => p.other > 0) ? [{ key: 'other', name: 'Other', color: 'var(--a-other)' }] : []];
  const values = (index: number) => points.map(p => index < series.length ? p.counts[index] ?? 0 : p.other);
  const max = Math.max(1, ...all.flatMap((_, i) => values(i))), step = niceStep(max), ceiling = Math.ceil(max / step) * step;
  const x = (i: number) => left + (points.length <= 1 ? (width - left) / 2 : (i / (points.length - 1)) * (width - left - 8));
  const y = (v: number) => top + plot - (v / ceiling) * plot, every = Math.max(1, Math.ceil(points.length / 8));
  const tick = (at: number) => { const d = new Date(at); return bucket === 'hour' ? `${String(d.getUTCHours()).padStart(2, '0')}:00` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
  return <figure className="admin-chart" style={{ margin: 0 }}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} style={{ width: '100%', height: 200 }}>
      {Array.from({ length: Math.round(ceiling / step) + 1 }, (_, i) => i * step).map(value => <g key={value}>
        <line x1={left} x2={width} y1={y(value)} y2={y(value)} stroke="var(--a-line)" strokeWidth="1"/><text x={left - 6} y={y(value) + 4} textAnchor="end">{compact(value)}</text></g>)}
      {points.map((point, i) => i % every === 0 ? <text key={point.at} x={x(i)} y={height - 6} textAnchor="middle">{tick(point.at)}</text> : null)}
      {all.map((line, index) => { const v = values(index), last = v.length - 1;
        return <g key={line.key}>
          <polyline fill="none" stroke={line.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={v.map((value, i) => `${x(i)},${y(value)}`).join(' ')}/>
          {v.map((value, i) => <circle key={i} cx={x(i)} cy={y(value)} r={i === last ? 4 : 6} fill={i === last ? line.color : 'transparent'}
            stroke={i === last ? 'var(--a-paper)' : 'none'} strokeWidth="2"><title>{`${line.name} · ${new Date(points[i]!.at).toISOString().slice(0, 10)}: ${fmt(value)}`}</title></circle>)}
        </g>; })}
    </svg>
    <ul className="admin-legend">{all.map(line => <li key={line.key}><span className="admin-swatch" style={{ background: line.color }}/>{line.name}</li>)}</ul>
  </figure>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function niceStep(max: number): number {
  const raw = max / 4, magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1))), n = raw / magnitude;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * magnitude);
}
const compact = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(value % 1_000 ? 1 : 0)}K` : String(value);
