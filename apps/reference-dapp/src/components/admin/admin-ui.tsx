// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-AI-PROVIDERS-001 (Admin UX): the console's shared building blocks (server components, no client script). They keep every page
 * visually consistent and make the same promises everywhere: a status is always text plus a symbol (never color alone), a warning is never
 * collapsed away, and technical detail lives in a clearly labelled "Technical details" disclosure instead of the main reading path.
 */
import type { ReactNode } from 'react';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
const GLYPH: Record<Tone, string> = { ok: '✓', warn: '!', bad: '✕', info: 'i', neutral: '•' };

/** A status as text and symbol (color is supplementary). */
export function Status({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string | undefined }) {
  return <span className="admin-badge" data-tone={tone === 'neutral' ? undefined : tone} title={title}><span aria-hidden="true">{GLYPH[tone]}</span> {children}</span>;
}

/** A titled card. `id` names the heading so the section is a labelled region. */
export function Section({ id, title, description, actions, children, tone }: { id: string; title: string; description?: ReactNode; actions?: ReactNode;
  children: ReactNode; tone?: Tone | undefined }) {
  return <section className="admin-card" aria-labelledby={id} data-tone={tone}>
    <header><div><h2 id={id}>{title}</h2>{description ? <p>{description}</p> : null}</div>{actions ? <div className="admin-actions">{actions}</div> : null}</header>
    {children}
  </section>;
}

/** Secondary, technical information an operator can open on demand. Never used for a warning. */
export function TechnicalDetails({ summary = 'Technical details', children, open }: { summary?: string; children: ReactNode; open?: boolean }) {
  return <details className="admin-details" open={open}><summary>{summary}</summary><div className="admin-details-body">{children}</div></details>;
}

export function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string | undefined; tone?: string | undefined }) {
  return <div className="admin-kpi" data-tone={tone}><span>{label}</span><strong>{value}</strong>{note ? <small>{note}</small> : null}</div>;
}

export type AttentionItem = { readonly key: string; readonly tone: Tone; readonly title: string; readonly detail?: ReactNode; readonly href?: string; readonly action?: string };
/**
 * "What requires my attention?" — a short list of things to look at, most severe first, each linking to where it is handled. With nothing
 * to report it says so plainly (`allClear`).
 */
export function AttentionList({ items, allClear, label = 'Needs attention' }: { items: readonly AttentionItem[]; allClear: string; label?: string }) {
  const order: Record<Tone, number> = { bad: 0, warn: 1, info: 2, neutral: 3, ok: 4 };
  const sorted = [...items].sort((a, b) => order[a.tone] - order[b.tone]);
  if (!sorted.some(item => item.tone === 'bad' || item.tone === 'warn')) return <p className="admin-allclear" role="status"><span aria-hidden="true">✓</span> {allClear}</p>;
  return <ul className="admin-attention" aria-label={label}>
    {sorted.map(item => <li key={item.key} data-tone={item.tone}>
      <span className="admin-attention-glyph" aria-hidden="true">{GLYPH[item.tone]}</span>
      <div><strong>{item.title}</strong>{item.detail ? <span>{item.detail}</span> : null}</div>
      {item.href ? <a className="admin-button" data-size="sm" href={item.href}>{item.action ?? 'Open'}</a> : null}
    </li>)}
  </ul>;
}

/** One status tile of a "status at a glance" row: what it is, how it is, and where to go. */
export function StatusTile({ label, tone, value, detail, href }: { label: string; tone: Tone; value: string; detail?: ReactNode; href: string }) {
  return <a className="admin-tile" href={href} data-tone={tone}>
    <span className="admin-tile-label">{label}</span>
    <strong><span aria-hidden="true">{GLYPH[tone]}</span> {value}</strong>
    {detail ? <small>{detail}</small> : null}
  </a>;
}
