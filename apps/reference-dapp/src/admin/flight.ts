// SPDX-License-Identifier: AGPL-3.0-only
/** Read-only Flight projections. Campaign issuance and email state remain owned by their existing stores. */
import type { AdminHost } from './host.ts';
import { decideAccess, type FlightCalendar } from '../flight/campaign.ts';
import { createFlightStore } from '../flight/store.ts';
import { createEmailOutbox, type EmailLimits, type EmailState } from '../flight/email/outbox.ts';
import type { EmailTemplate } from '../flight/email/templates.ts';

export const FLIGHT_PAGE_MAX = 100, FLIGHT_EXPORT_MAX = 10_000;
export type FlightEntryStatus = 'WAITING' | 'ELIGIBLE' | 'BOARDED';
export type FlightAdminFilters = {
  readonly search: string; readonly flight: 'FIRST' | 'NEXT' | null; readonly language: 'EN' | 'PT' | null;
  readonly group: number | 'NONE' | null; readonly from: string | null; readonly to: string | null;
  readonly status: FlightEntryStatus | null; readonly sort: 'asc' | 'desc'; readonly page: number; readonly pageSize: number;
};
export type FlightAdminEntry = {
  readonly entryId: string; readonly email: string; readonly joinedAt: string; readonly flight: 'FIRST' | 'NEXT'; readonly language: 'EN' | 'PT';
  readonly group: number | null; readonly boarding: FlightEntryStatus; readonly access: 'CLAIMED' | 'INVITE_REDEEMED' | 'INVITE_ISSUED' | 'PROOF_USED' | 'UNPROVEN';
  readonly lastEmail: { readonly template: EmailTemplate; readonly state: EmailState } | null;
  readonly card: 'FOUNDING' | 'PASSENGER' | null;
};
export type FlightAdminEntries = { readonly rows: readonly FlightAdminEntry[]; readonly total: number; readonly page: number; readonly pageSize: number };
export type FlightAdminSummary = {
  readonly first: number; readonly next: number; readonly last24Hours: number; readonly boarded: number; readonly listBoarded: number;
  readonly listAwaiting: number; readonly listEligible: number;
  readonly foundingIssued: number; readonly foundingAvailable: number; readonly passengerIssued: number;
  readonly languages: readonly { readonly language: string; readonly entries: number }[];
  readonly groups: readonly { readonly group: number | null; readonly flight: string; readonly entries: number; readonly opensAt: string | null }[];
  readonly daily: readonly { readonly day: string; readonly entries: number; readonly cumulative: number }[];
  readonly invites: readonly { readonly issuer: string; readonly issued: number; readonly used: number }[];
  readonly emails: readonly { readonly template: string; readonly state: string; readonly emails: number }[];
  readonly usage: { readonly day: number; readonly month: number }; readonly limits: { readonly daily: number; readonly monthly: number };
  /** The current outbox records provider acceptance, not delivery webhooks. Null is intentionally not a fabricated zero. */
  readonly delivered: null;
};

function invalid(): never { throw new Error('ADMIN_FLIGHT_FILTER_INVALID'); }
function date(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : invalid();
}
function choice<T extends string>(value: unknown, values: readonly T[]): T | null {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && values.includes(value as T) ? value as T : invalid();
}
/** Strict bounded filters, including literal email substring search (SQL wildcards have no special meaning). */
export function flightAdminFilters(input: unknown): FlightAdminFilters {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const p = input as Record<string, unknown>;
  if (Object.keys(p).some(k => !['search', 'flight', 'language', 'group', 'from', 'to', 'status', 'sort', 'page', 'pageSize'].includes(k))) return invalid();
  const search = p.search === undefined || p.search === null ? '' : p.search;
  if (typeof search !== 'string' || search.length > 254 || /\p{Cc}/u.test(search)) return invalid();
  let group: FlightAdminFilters['group'] = null;
  if (p.group !== undefined && p.group !== null && p.group !== '') {
    if (p.group === 'NONE') group = 'NONE';
    else if (typeof p.group === 'number' && Number.isInteger(p.group) && p.group >= 1 && p.group <= 999) group = p.group;
    else return invalid();
  }
  const page = p.page ?? 1, pageSize = p.pageSize ?? 25;
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 100_000) return invalid();
  if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > FLIGHT_PAGE_MAX) return invalid();
  const from = date(p.from), to = date(p.to);
  if (from && to && from > to) return invalid();
  return { search: search.trim().toLowerCase(), flight: choice(p.flight, ['FIRST', 'NEXT']), language: choice(p.language, ['EN', 'PT']), group, from, to,
    status: choice(p.status, ['WAITING', 'ELIGIBLE', 'BOARDED']), sort: choice(p.sort, ['asc', 'desc']) ?? 'desc', page, pageSize };
}

type EntryRow = { entry_id: string; email: string; joined_at: Date; flight: 'FIRST' | 'NEXT'; language: 'EN' | 'PT'; batch_no: number | null;
  boarded_at: Date | null; opens_at: Date | null; account_id: string | null; invite_issuer: 'FOUNDING' | 'CREATOR' | null;
  invite_issued: boolean; proof_used: boolean; card_kind: 'FOUNDING' | 'PASSENGER' | null; template: EmailTemplate | null; state: EmailState | null };

/** Neither account ids nor invite codes, token digests, provider ids or other access material leave this projection. */
function entry(row: EntryRow, now: number, calendar: FlightCalendar): FlightAdminEntry {
  const access = decideAccess({ now, passId: null, invite: row.invite_issuer, entry: { flight: row.flight, batch: row.batch_no,
    opensAt: row.opens_at?.getTime() ?? null }, calendar });
  return { entryId: row.entry_id, email: row.email, joinedAt: row.joined_at.toISOString(), flight: row.flight, language: row.language, group: row.batch_no,
    boarding: row.boarded_at || row.card_kind ? 'BOARDED' : access.kind === 'eligible' ? 'ELIGIBLE' : 'WAITING',
    access: row.invite_issuer ? 'INVITE_REDEEMED' : row.account_id ? 'CLAIMED' : row.proof_used ? 'PROOF_USED' : row.invite_issued ? 'INVITE_ISSUED' : 'UNPROVEN',
    lastEmail: row.template && row.state ? { template: row.template, state: row.state } : null, card: row.card_kind };
}

export function createFlightAdminStore(host: AdminHost, calendar: FlightCalendar, limits?: EmailLimits) {
  const { db, tenantId } = host, flightStore = createFlightStore(host, calendar), outbox = createEmailOutbox(host, limits);
  // Correlations are always scoped to the entry's tenant. An addressed invite alone never proves who redeemed it.
  const projection = `SELECT e.entry_id, e.email, e.joined_at, e.flight, e.language, e.batch_no, e.boarded_at, b.opens_at, c.account_id,
    (SELECT i.issuer FROM flight_invites i WHERE i.tenant_id = e.tenant_id AND i.redeemed_by = c.account_id LIMIT 1) AS invite_issuer,
    EXISTS (SELECT 1 FROM flight_invites i WHERE i.tenant_id = e.tenant_id AND i.recipient = e.email) AS invite_issued,
    EXISTS (SELECT 1 FROM flight_access_tokens t WHERE t.tenant_id = e.tenant_id AND t.entry_id = e.entry_id AND t.consumed_at IS NOT NULL) AS proof_used,
    (SELECT CASE WHEN p.founding_seat IS NULL THEN 'PASSENGER' ELSE 'FOUNDING' END FROM flight_passes p
      WHERE p.tenant_id = e.tenant_id AND (p.account_id = c.account_id OR (c.account_id IS NULL AND p.pass_id IN
        (SELECT m.pass_id FROM flight_emails m WHERE m.tenant_id = e.tenant_id AND m.recipient = e.email AND m.pass_id IS NOT NULL)))
      ORDER BY p.boarding_no LIMIT 1) AS card_kind,
    latest.template, latest.state
    FROM flight_list_entries e LEFT JOIN flight_batches b ON b.tenant_id = e.tenant_id AND b.batch_no = e.batch_no
    LEFT JOIN flight_access_claims c ON c.tenant_id = e.tenant_id AND c.entry_id = e.entry_id
    LEFT JOIN LATERAL (SELECT m.template, m.state FROM flight_emails m WHERE m.tenant_id = e.tenant_id AND m.recipient = e.email
      ORDER BY m.created_at DESC, m.email_id DESC LIMIT 1) latest ON true
    WHERE e.tenant_id = $1 AND ($2::text = '' OR strpos(e.email, $2) > 0)
      AND ($3::text IS NULL OR e.flight = $3) AND ($4::text IS NULL OR e.language = $4)
      AND ($5::text IS NULL OR ($5 = 'NONE' AND e.batch_no IS NULL) OR e.batch_no::text = $5)
      AND ($6::timestamptz IS NULL OR e.joined_at >= $6::timestamptz)
      AND ($7::timestamptz IS NULL OR e.joined_at < $7::timestamptz + interval '1 day')`;
  // SQL counterpart of decideAccess's list/invite eligibility, for filtering before LIMIT/OFFSET.
  const query = `WITH projected AS (${projection}), statuses AS (SELECT *, CASE
    WHEN boarded_at IS NOT NULL OR card_kind IS NOT NULL THEN 'BOARDED'
    WHEN $8::timestamptz >= $9::timestamptz AND (invite_issuer IS NOT NULL OR
      (flight = 'FIRST' AND $8::timestamptz >= coalesce(opens_at, $9::timestamptz))) THEN 'ELIGIBLE' ELSE 'WAITING' END AS boarding_status
    FROM projected) SELECT * FROM statuses WHERE ($10::text IS NULL OR boarding_status = $10)`;
  const params = (f: FlightAdminFilters, now: number) => [tenantId, f.search, f.flight, f.language, f.group === null ? null : String(f.group),
    f.from ? `${f.from}T00:00:00.000Z` : null, f.to ? `${f.to}T00:00:00.000Z` : null, new Date(now).toISOString(), new Date(calendar.boardingOpensAt).toISOString(), f.status];

  async function entries(filters: FlightAdminFilters, now: number): Promise<FlightAdminEntries> {
    const values = params(filters, now);
    const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM (${query}) filtered`, values)).rows[0]!.n);
    const rows = (await db.query<EntryRow>(`${query} ORDER BY joined_at ${filters.sort === 'asc' ? 'ASC' : 'DESC'}, entry_id ${filters.sort === 'asc' ? 'ASC' : 'DESC'}
      LIMIT $11 OFFSET $12`, [...values, filters.pageSize, (filters.page - 1) * filters.pageSize])).rows;
    return { rows: rows.map(row => entry(row, now, calendar)), total, page: filters.page, pageSize: filters.pageSize };
  }
  async function exportEntries(filters: FlightAdminFilters, now: number): Promise<readonly FlightAdminEntry[]> {
    const rows = (await db.query<EntryRow>(`${query} ORDER BY joined_at ${filters.sort === 'asc' ? 'ASC' : 'DESC'}, entry_id ${filters.sort === 'asc' ? 'ASC' : 'DESC'} LIMIT $11`,
      [...params(filters, now), FLIGHT_EXPORT_MAX + 1])).rows;
    if (rows.length > FLIGHT_EXPORT_MAX) throw new Error('ADMIN_FLIGHT_EXPORT_TOO_LARGE');
    return rows.map(row => entry(row, now, calendar));
  }
  async function summary(now: number): Promise<FlightAdminSummary> {
    const [counters, emailStatus, totals, languages, groups, days, invites, boarding] = await Promise.all([
      flightStore.counters(), outbox.status(now),
      db.query<{ first: string; next: string; last_day: string }>(`SELECT count(*) FILTER (WHERE flight = 'FIRST') AS first,
        count(*) FILTER (WHERE flight = 'NEXT') AS next, count(*) FILTER (WHERE joined_at >= $2::timestamptz - interval '24 hours' AND joined_at <= $2) AS last_day
        FROM flight_list_entries WHERE tenant_id = $1`, [tenantId, new Date(now).toISOString()]),
      db.query<{ language: string; entries: string }>('SELECT language, count(*) AS entries FROM flight_list_entries WHERE tenant_id = $1 GROUP BY language ORDER BY language', [tenantId]),
      db.query<{ flight: string; batch_no: number | null; entries: string; opens_at: Date | null }>(`SELECT e.flight, e.batch_no, count(*) AS entries, b.opens_at
        FROM flight_list_entries e LEFT JOIN flight_batches b ON b.tenant_id = e.tenant_id AND b.batch_no = e.batch_no WHERE e.tenant_id = $1
        GROUP BY e.flight, e.batch_no, b.opens_at ORDER BY e.flight, e.batch_no NULLS FIRST`, [tenantId]),
      db.query<{ day: string; entries: string; cumulative: string }>(`SELECT day, entries, sum(entries) OVER (ORDER BY day) AS cumulative FROM (
        SELECT (joined_at AT TIME ZONE 'UTC')::date::text AS day, count(*) AS entries FROM flight_list_entries WHERE tenant_id = $1
        GROUP BY 1) days ORDER BY day`, [tenantId]),
      db.query<{ issuer: string; issued: string; used: string }>('SELECT issuer, count(*) AS issued, count(redeemed_at) AS used FROM flight_invites WHERE tenant_id = $1 GROUP BY issuer ORDER BY issuer', [tenantId]),
      db.query<{ boarding_status: FlightEntryStatus; entries: string }>(`SELECT boarding_status, count(*) AS entries FROM (${query}) registrations GROUP BY boarding_status`,
        params(flightAdminFilters({}), now)),
    ]);
    const n = totals.rows[0]!;
    const count = (status: FlightEntryStatus) => Number(boarding.rows.find(row => row.boarding_status === status)?.entries ?? 0);
    return { first: Number(n.first), next: Number(n.next), last24Hours: Number(n.last_day), listBoarded: count('BOARDED'), boarded: counters.boarded,
      listAwaiting: count('WAITING') + count('ELIGIBLE'), listEligible: count('ELIGIBLE'),
      foundingIssued: counters.foundingTaken, foundingAvailable: counters.foundingLeft, passengerIssued: counters.boarded - counters.foundingTaken,
      languages: languages.rows.map(r => ({ language: r.language, entries: Number(r.entries) })),
      groups: groups.rows.map(r => ({ flight: r.flight, group: r.batch_no, entries: Number(r.entries), opensAt: r.opens_at?.toISOString() ?? null })),
      daily: days.rows.map(r => ({ day: r.day, entries: Number(r.entries), cumulative: Number(r.cumulative) })),
      invites: invites.rows.map(r => ({ issuer: r.issuer, issued: Number(r.issued), used: Number(r.used) })),
      emails: emailStatus.states, usage: emailStatus.usage, limits: { daily: emailStatus.limits.daily, monthly: emailStatus.limits.monthly }, delivered: null };
  }
  return { summary, entries, exportEntries };
}

/** RFC 4180 quoting plus spreadsheet formula neutralization, including leading whitespace/control characters. */
export function flightCsv(rows: readonly FlightAdminEntry[]): string {
  const cell = (value: string | number | null) => {
    const text = value === null ? '' : String(value), safe = /^[\s\p{Cc}]*[=+\-@]/u.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [['Email', 'Joined at (UTC)', 'Flight', 'Language', 'Boarding group', 'Boarding status', 'Proven access', 'Last email template', 'Last email state', 'Card'],
    ...rows.map(r => [r.email, r.joinedAt, r.flight, r.language, r.group, r.boarding, r.access, r.lastEmail?.template ?? null, r.lastEmail?.state ?? null, r.card])]
    .map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
