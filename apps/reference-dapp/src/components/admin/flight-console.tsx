// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { FlightAdminEntries, FlightAdminSummary, FlightAdminFilters } from '../../admin/flight';
import { adminPost } from './admin-client';

const DEFAULT_FILTERS: FlightAdminFilters = { search: '', flight: null, language: null, group: null, from: null, to: null,
  status: null, sort: 'desc', page: 1, pageSize: 25 };
const BOARDING = { WAITING: 'Waiting', ELIGIBLE: 'Eligible', BOARDED: 'Boarded' };
const ACCESS = { CLAIMED: 'Account linked', INVITE_REDEEMED: 'Invite redeemed', INVITE_ISSUED: 'Invite issued', PROOF_USED: 'Email proof used', UNPROVEN: 'Not proven' };
const STATES = ['PENDING', 'SENT', 'HELD', 'FAILED', 'UNKNOWN'] as const;
const fmt = (n: number) => n.toLocaleString('en-US');
const at = (value: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value));
const errorMessage = (code: string) => ({ ADMIN_SESSION_REQUIRED: 'Your admin session ended. Sign in again.',
  ADMIN_ROLE_INSUFFICIENT: 'Only an OPERATOR can view or export subscriber addresses.', ADMIN_CSRF_INVALID: 'Reload this page to refresh your session.',
  ADMIN_FLIGHT_FILTER_INVALID: 'Check the filters and date range.', ADMIN_FLIGHT_EXPORT_TOO_LARGE: 'Narrow the filters to at most 10,000 entries before exporting.' }[code]
  ?? `Flight data could not be loaded (${code}).`);

export function FlightConsole({ csrf, operator }: { csrf: string; operator: boolean }) {
  const [summary, setSummary] = useState<FlightAdminSummary | null>(null), [summaryError, setSummaryError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false), [updated, setUpdated] = useState<string | null>(null);
  // Filters and subscriber results stay in memory: email search is never written to a URL or browser storage.
  const [filters, setFilters] = useState(DEFAULT_FILTERS), [applied, setApplied] = useState(DEFAULT_FILTERS);
  const [entries, setEntries] = useState<FlightAdminEntries | null>(null), [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [exporting, setExporting] = useState(false);
  const listRequest = useRef(0);

  async function loadSummary(signal?: AbortSignal) {
    setRefreshing(true); setSummaryError(null);
    try {
      const response = await fetch('/admin/api/flight', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: signal ?? null });
      const result = await response.json();
      if (!response.ok || !result.ok) { setSummary(null); setSummaryError(errorMessage(result.code ?? 'ADMIN_RESPONSE_INVALID')); }
      else { setSummary(result.summary); setUpdated(new Date().toISOString()); }
    } catch { if (!signal?.aborted) { setSummary(null); setSummaryError(errorMessage('ADMIN_REQUEST_FAILED')); } }
    finally { if (!signal?.aborted) setRefreshing(false); }
  }
  useEffect(() => { const abort = new AbortController(); void loadSummary(abort.signal); return () => abort.abort(); }, []);

  async function loadEntries(next: FlightAdminFilters) {
    const id = ++listRequest.current;
    setBusy(true); setListError(null); setEntries(null); setApplied(next);
    const result = await adminPost<{ entries: FlightAdminEntries }>('/admin/api/flight/entries', next, csrf);
    if (id !== listRequest.current) return;
    setBusy(false);
    if (!result.ok) setListError(errorMessage(result.code)); else setEntries(result.entries);
  }
  function apply(event: FormEvent) { event.preventDefault(); void loadEntries({ ...filters, page: 1 }); }
  async function exportCsv() {
    setExporting(true); setListError(null);
    try {
      const response = await fetch('/admin/api/flight/export', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-flofi-admin-csrf': csrf }, body: JSON.stringify(applied) });
      if (!response.ok) { const result = await response.json(); setListError(errorMessage(result.code ?? 'ADMIN_RESPONSE_INVALID')); return; }
      const url = URL.createObjectURL(await response.blob()), anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'flight-subscribers.csv'; document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch { setListError(errorMessage('ADMIN_REQUEST_FAILED')); }
    finally { setExporting(false); }
  }
  return <div className="admin-flight-console">
    <div className="admin-actions">
      <button className="admin-button" type="button" disabled={refreshing} onClick={() => { void loadSummary(); if (entries) void loadEntries(applied); }}>Refresh data</button>
      <span className="admin-diff" role="status">{refreshing ? 'Loading campaign…' : updated ? `Updated ${at(updated)} UTC` : ''}</span>
    </div>
    {summaryError && <p className="admin-alert" role="alert" data-tone="bad">{summaryError}</p>}
    {summary && <>
      <section aria-label="Campaign totals" className="admin-kpis">
        {[['FIRST registrations', summary.first], ['NEXT registrations', summary.next], ['Registered in last 24 hours', summary.last24Hours],
          ['People boarded', summary.boarded], ['List awaiting boarding', summary.listAwaiting], ['List eligible to board', summary.listEligible],
          ['Founding cards issued', summary.foundingIssued], ['Founding seats available', summary.foundingAvailable],
          ['Passenger cards issued', summary.passengerIssued]].map(([label, value]) => <div key={label} className="admin-kpi"><span>{label}</span><strong>{fmt(value as number)}</strong></div>)}
      </section>
      <div className="admin-grid admin-grid-2">
        <section className="admin-card"><header><h2>Registrations by day</h2><p>UTC calendar days · cumulative registrations</p></header>
          <div className="admin-table-wrap admin-flight-history"><table className="admin-table"><thead><tr><th>Day</th><th>New</th><th>Cumulative</th></tr></thead>
            <tbody>{summary.daily.map(row => <tr key={row.day}><td>{row.day}</td><td>{fmt(row.entries)}</td><td>{fmt(row.cumulative)}</td></tr>)}</tbody></table></div>
          {!summary.daily.length && <p>No registrations yet.</p>}
        </section>
        <section className="admin-card"><header><h2>Language and boarding groups</h2></header>
          <p>{['PT', 'EN'].map((language, index) => <span key={language}>{index ? ' · ' : ''}{language}: {fmt(summary.languages.find(row => row.language === language)?.entries ?? 0)}</span>)}</p>
          <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Flight</th><th>Group</th><th>Registrations</th><th>Opens (UTC)</th></tr></thead>
            <tbody>{summary.groups.map(row => <tr key={`${row.flight}-${row.group}`}><td>{row.flight}</td><td>{row.group ?? 'Unassigned'}</td><td>{fmt(row.entries)}</td><td>{row.opensAt ? at(row.opensAt) : 'Campaign default'}</td></tr>)}</tbody></table></div>
        </section>
      </div>
      <section className="admin-card"><header><h2>Invitations</h2><p>Issued and redeemed records; an issued invitation does not prove access.</p></header>
        <table className="admin-table"><thead><tr><th>Issuer</th><th>Issued</th><th>Used</th></tr></thead><tbody>
          {['CREATOR', 'FOUNDING'].map(issuer => { const row = summary.invites.find(item => item.issuer === issuer); return <tr key={issuer}><td>{issuer}</td><td>{fmt(row?.issued ?? 0)}</td><td>{fmt(row?.used ?? 0)}</td></tr>; })}
        </tbody></table>
      </section>
      <section className="admin-card"><header><h2>Email outbox</h2><p>SENT means provider acceptance. Inbox delivery is unverified; no delivery webhook is recorded.</p></header>
        <p>Reserved quota: {fmt(summary.usage.day)} / {fmt(summary.limits.daily)} today · {fmt(summary.usage.month)} / {fmt(summary.limits.monthly)} this month.</p>
        <p className="admin-diff">These counters cover FloFi reservations. Other sends from the same Resend account also consume its provider quota.</p>
        <p className="admin-diff">{STATES.map((state, index) => <span key={state}>{index ? ' · ' : ''}{state}: {fmt(summary.emails.filter(row => row.state === state).reduce((n, row) => n + row.emails, 0))}</span>)} · DELIVERED: unverified</p>
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Template</th><th>State</th><th>Messages</th></tr></thead>
          <tbody>{summary.emails.map(row => <tr key={`${row.template}-${row.state}`}><td>{row.template}</td><td>{row.state}</td><td>{fmt(row.emails)}</td></tr>)}</tbody></table></div>
        {!summary.emails.length && <p>No email records.</p>}
      </section>
    </>}
    {!operator ? <p className="admin-alert">Subscriber addresses and CSV exports require an OPERATOR session.</p> :
      <section className="admin-card" aria-labelledby="flight-subscribers"><header><h2 id="flight-subscribers">Subscribers</h2><p>Authorized views and exports are audited. Dates and periods use UTC.</p></header>
        <form onSubmit={apply} className="admin-form" aria-label="Subscriber filters">
          <div className="admin-form-row">
            <label className="admin-field">Email search<input type="text" name="email-search" autoComplete="off" maxLength={254} value={filters.search} onChange={e => setFilters({ ...filters, search: e.target.value })}/></label>
            <label className="admin-field">Flight<select aria-label="Flight" value={filters.flight ?? ''} onChange={e => setFilters({ ...filters, flight: e.target.value as 'FIRST' | 'NEXT' || null })}><option value="">All flights</option><option>FIRST</option><option>NEXT</option></select></label>
            <label className="admin-field">Language<select aria-label="Language" value={filters.language ?? ''} onChange={e => setFilters({ ...filters, language: e.target.value as 'EN' | 'PT' || null })}><option value="">All languages</option><option>PT</option><option>EN</option></select></label>
            <label className="admin-field">Boarding group<select aria-label="Boarding group" value={filters.group ?? ''} onChange={e => setFilters({ ...filters, group: e.target.value === '' ? null : e.target.value === 'NONE' ? 'NONE' : Number(e.target.value) })}>
              <option value="">All groups</option><option value="NONE">Unassigned</option>{Array.from(new Set(summary?.groups.flatMap(row => row.group === null ? [] : [row.group]) ?? [])).sort((a, b) => a - b).map(group => <option key={group} value={group}>{group}</option>)}
            </select></label>
            <label className="admin-field">From<input type="date" value={filters.from ?? ''} onChange={e => setFilters({ ...filters, from: e.target.value || null })}/></label>
            <label className="admin-field">Through<input type="date" value={filters.to ?? ''} onChange={e => setFilters({ ...filters, to: e.target.value || null })}/></label>
            <label className="admin-field">Boarding status<select aria-label="Boarding status" value={filters.status ?? ''} onChange={e => setFilters({ ...filters, status: e.target.value as FlightAdminFilters['status'] || null })}><option value="">All statuses</option>{Object.entries(BOARDING).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="admin-field">Registration order<select aria-label="Registration order" value={filters.sort} onChange={e => setFilters({ ...filters, sort: e.target.value as 'asc' | 'desc' })}><option value="desc">Newest first</option><option value="asc">Oldest first</option></select></label>
            <label className="admin-field">Rows per page<select aria-label="Rows per page" value={filters.pageSize} onChange={e => setFilters({ ...filters, pageSize: Number(e.target.value) })}>{[25, 50, 100].map(size => <option key={size}>{size}</option>)}</select></label>
          </div>
          <div className="admin-actions"><button className="admin-button" data-variant="primary" type="submit" disabled={busy}>Search subscribers</button>
            <button className="admin-button" type="button" disabled={busy} onClick={() => { setFilters(DEFAULT_FILTERS); void loadEntries(DEFAULT_FILTERS); }}>Clear filters</button>
            <button className="admin-button" type="button" disabled={!entries || busy || exporting} onClick={() => void exportCsv()}>{exporting ? 'Exporting…' : 'Export filtered CSV'}</button></div>
        </form>
        {listError && <p role="alert" className="admin-alert" data-tone="bad">{listError}</p>}
        <p role="status">{busy ? 'Loading subscribers…' : entries ? `${fmt(entries.total)} matching registrations` : 'Search to load subscriber addresses.'}</p>
        {entries && <>
          <div className="admin-table-wrap"><table className="admin-table"><caption className="admin-sr">Flight subscribers</caption>
            <thead><tr><th>Email</th><th>Registered (UTC)</th><th>Flight</th><th>Language</th><th>Group</th><th>Boarding</th><th>Access proof</th><th>Last email</th><th>Card</th></tr></thead>
            <tbody>{entries.rows.map(row => <tr key={row.entryId}><td className="admin-flight-email">{row.email}</td><td>{at(row.joinedAt)}</td><td>{row.flight}</td><td>{row.language}</td><td>{row.group ?? 'Unassigned'}</td><td>{BOARDING[row.boarding]}</td><td>{ACCESS[row.access]}</td><td>{row.lastEmail ? `${row.lastEmail.template} · ${row.lastEmail.state}` : 'None'}</td><td>{row.card ?? (row.boarding === 'BOARDED' ? 'Unavailable' : 'Not issued')}</td></tr>)}</tbody>
          </table></div>
          <nav className="admin-actions" aria-label="Subscriber pages">
            <button className="admin-button" type="button" disabled={busy || entries.page <= 1} onClick={() => void loadEntries({ ...applied, page: entries.page - 1 })}>Previous</button>
            <span>Page {entries.page} of {Math.max(1, Math.ceil(entries.total / entries.pageSize))}</span>
            <button className="admin-button" type="button" disabled={busy || entries.page * entries.pageSize >= entries.total} onClick={() => void loadEntries({ ...applied, page: entries.page + 1 })}>Next</button>
          </nav>
        </>}
      </section>}
  </div>;
}
