// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: Flight FloFi persistence (migration 0020). Every write is one short transaction. Passes take their numbers from
 * the tenant's `flight_issuance` row under its row lock, and the tables enforce the limit (seat 1..100, unique; one pass per account), so
 * concurrent boardings never share a seat, never exceed 100, never give an account two passes, and a number freed by a deleted account
 * is never issued again. Errors are fixed codes; nothing here logs personal data.
 */
import { randomBytes } from 'node:crypto';
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { decideAccess, eventOrigin, FLIGHT_EVENTS, FLIGHT_NOTICE_VERSION, FOUNDING_INVITES, FOUNDING_SEATS, foundingSeat, inviteCodeFrom,
  passengerSeat, SIMULATION_EVIDENCE_MS, DEPARTURES_SHOWN, type FlightAccess, type FlightEvent, type FlightOrigin, type FlightRoute } from './campaign.ts';

export type FlightHost = { readonly db: Database; readonly tenantId: string };
const at = (ms: number) => new Date(ms).toISOString();
const DAY_MS = 86_400_000;

/**
 * Limits of the public list form: per client digest per hour, and for the whole deployment per ten minutes. A request without a client
 * digest is counted under NO_CLIENT, so it always counts toward the deployment-wide limit (it has no per-client limit of its own).
 */
export const JOIN_LIMITS = { perClientHour: 30, globalTenMinutes: 3000 } as const; // 30: mobile carriers share one IPv4 among many people (CGNAT).
export const NO_CLIENT = '0'.repeat(64);
const JOIN_LOCK_CLASS = 734_003_221; // Advisory lock class (int4): one list request at a time per client digest.
/** How long each kind of campaign record is kept (the privacy notice's periods). */
export const FLIGHT_RETENTION = { joinAttemptsMs: DAY_MS, simulationsMs: SIMULATION_EVIDENCE_MS, eventDays: 400 } as const;

export type FlightCounters = { readonly onList: number; readonly boarded: number; readonly foundingTaken: number; readonly foundingLeft: number };
export type Departure = { readonly handle: string; readonly from: string; readonly to: string; readonly steps: number; readonly seat: string };
export type FlightPass = {
  readonly passId: string; readonly origin: FlightOrigin; readonly boardingNo: number; readonly foundingSeat: number | null; readonly seat: string;
  readonly handle: string | null; readonly public: boolean; readonly route: FlightRoute; readonly departedAt: string;
};
export type OwnInvite = { readonly code: string; readonly redeemed: boolean };
export type AccountFlight = { readonly access: FlightAccess; readonly pass: FlightPass | null; readonly invites: readonly OwnInvite[];
  readonly listed: 'FIRST' | 'NEXT' | null };
export type IssueResult = { readonly ok: true; readonly pass: FlightPass; readonly issued: boolean } | { readonly ok: false; readonly code:
  'FLIGHT_NOT_ELIGIBLE' | 'FLIGHT_SIMULATION_NOT_FOUND' };
export type RedeemResult = 'REDEEMED' | 'INVITE_INVALID' | 'INVITE_USED' | 'INVITE_OWN' | 'INVITE_ALREADY_HELD' | 'ALREADY_BOARDED';

type PassRow = { pass_id: string; origin: FlightOrigin; boarding_no: number; founding_seat: number | null; handle: string | null; public: boolean;
  route: FlightRoute; departed_at: Date };
const passOf = (row: PassRow): FlightPass => ({ passId: row.pass_id, origin: row.origin, boardingNo: row.boarding_no, foundingSeat: row.founding_seat,
  seat: row.founding_seat ? foundingSeat(row.founding_seat) : passengerSeat(row.boarding_no), handle: row.handle, public: row.public, route: row.route,
  departedAt: row.departed_at.toISOString() });
const PASS_COLUMNS = 'pass_id, origin, boarding_no, founding_seat, handle, public, route, departed_at';

export function createFlightStore(host: FlightHost) {
  const { db, tenantId } = host;

  /** The public counters: the beta list, and the boarding numbers and Founding seats issued (a deleted account's stay issued). */
  async function counters(q: Queryable = db): Promise<FlightCounters> {
    const row = (await q.query<{ on_list: string; boarded: string; founding: string }>(`SELECT
      (SELECT count(*) FROM flight_list_entries WHERE tenant_id = $1 AND flight = 'FIRST') AS on_list,
      coalesce((SELECT boarded FROM flight_issuance WHERE tenant_id = $1), 0) AS boarded,
      coalesce((SELECT founding FROM flight_issuance WHERE tenant_id = $1), 0) AS founding`, [tenantId])).rows[0]!;
    const foundingTaken = Number(row.founding);
    return { onList: Number(row.on_list), boarded: Number(row.boarded), foundingTaken, foundingLeft: Math.max(0, FOUNDING_SEATS - foundingTaken) };
  }

  async function recordEvent(event: FlightEvent, detail: string, origin: FlightOrigin | null, now: number, q: Queryable = db): Promise<void> {
    if (!(FLIGHT_EVENTS[event] as readonly string[]).includes(detail)) throw new Error('FLIGHT_EVENT_INVALID');
    const day = at(now).slice(0, 10);
    await q.query(`INSERT INTO flight_daily_events (tenant_id, day, event, detail, origin, events, updated_at) VALUES ($1, $2::date, $3, $4, $5, 1, $6)
      ON CONFLICT (tenant_id, day, event, detail, origin) DO UPDATE SET events = flight_daily_events.events + 1, updated_at = EXCLUDED.updated_at`,
      [tenantId, day, event, detail, eventOrigin(origin), at(now)]);
  }

  /**
   * One person joins a list. A repeated address keeps its first entry, and the route answers both the same way. (The public "on the
   * list" counter is exact, so comparing it before and after submitting an address can still hint whether that address was new; the
   * rate limits bound such probing.) `client` is a keyed digest of the request's network address (rate limit only), or null.
   */
  async function joinList(input: { email: string; language: 'EN' | 'PT'; flight: 'FIRST' | 'NEXT'; client: string | null; now: number }):
    Promise<{ readonly status: 'JOINED' | 'ALREADY' | 'RATE_LIMITED' | 'BUSY' }> {
    return db.transaction(async tx => {
      const now = at(input.now), client = input.client ?? NO_CLIENT;
      // Concurrent requests of one client are counted one after another, so none slips past its limit.
      if (client !== NO_CLIENT) await tx.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [JOIN_LOCK_CLASS, client]);
      await tx.query(`DELETE FROM flight_join_attempts WHERE tenant_id = $1 AND attempted_at < $2::timestamptz - interval '1 day'`, [tenantId, now]);
      const recent = (await tx.query<{ client: string; global: string }>(`SELECT
        count(*) FILTER (WHERE client = $2) AS client,
        count(*) FILTER (WHERE attempted_at > $3::timestamptz - interval '10 minutes') AS global
        FROM flight_join_attempts WHERE tenant_id = $1 AND attempted_at > $3::timestamptz - interval '1 hour'`, [tenantId, client, now])).rows[0]!;
      if (client !== NO_CLIENT && Number(recent.client) >= JOIN_LIMITS.perClientHour) return { status: 'RATE_LIMITED' as const };
      if (Number(recent.global) >= JOIN_LIMITS.globalTenMinutes) return { status: 'BUSY' as const };
      await tx.query('INSERT INTO flight_join_attempts (tenant_id, client, attempted_at) VALUES ($1, $2, $3)', [tenantId, client, now]);
      // joined_at is the database's own time: the joining order the operator assigns groups by never depends on the campaign clock.
      const inserted = await tx.query(`INSERT INTO flight_list_entries (tenant_id, entry_id, email, flight, language, notice)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, email) DO NOTHING`,
        [tenantId, `fle_${randomBytes(16).toString('hex')}`, input.email, input.flight, input.language, FLIGHT_NOTICE_VERSION]);
      if (inserted.rowCount) await recordEvent('list_join', input.flight === 'FIRST' ? 'first' : 'next', null, input.now, tx);
      return { status: inserted.rowCount ? 'JOINED' as const : 'ALREADY' as const };
    });
  }

  async function departures(): Promise<Departure[]> {
    const rows = (await db.query<PassRow>(`SELECT ${PASS_COLUMNS} FROM flight_passes WHERE tenant_id = $1 AND public ORDER BY departed_at DESC, boarding_no DESC
      LIMIT ${DEPARTURES_SHOWN}`, [tenantId])).rows;
    return rows.map(passOf).map(pass => ({ handle: pass.handle!, from: pass.route.from, to: pass.route.to, steps: pass.route.stepCount, seat: pass.seat }));
  }

  /**
   * The account's place in the campaign: its pass, else what "Board now" answers. `emails` are the account's verified addresses; an
   * entry that already boarded (with this or another account, since deleted) gives nothing again.
   */
  async function account(input: { accountId: string; emails: readonly string[]; now: number }, q: Queryable = db): Promise<AccountFlight> {
    const pass = (await q.query<PassRow>(`SELECT ${PASS_COLUMNS} FROM flight_passes WHERE tenant_id = $1 AND account_id = $2`, [tenantId, input.accountId])).rows[0];
    const invite = (await q.query<{ issuer: 'FOUNDING' | 'CREATOR' }>('SELECT issuer FROM flight_invites WHERE tenant_id = $1 AND redeemed_by = $2',
      [tenantId, input.accountId])).rows[0]?.issuer ?? null;
    const entries = input.emails.length ? (await q.query<{ flight: 'FIRST' | 'NEXT'; batch_no: number | null; opens_at: Date | null }>(`SELECT e.flight, e.batch_no, b.opens_at
      FROM flight_list_entries e LEFT JOIN flight_batches b ON b.tenant_id = e.tenant_id AND b.batch_no = e.batch_no
      WHERE e.tenant_id = $1 AND e.email = ANY($2::text[]) AND e.boarded_at IS NULL ORDER BY (e.flight = 'FIRST') DESC, b.opens_at ASC NULLS FIRST LIMIT 1`,
      [tenantId, [...input.emails]])).rows : [];
    const entry = entries[0] ? { flight: entries[0].flight, batch: entries[0].batch_no, opensAt: entries[0].opens_at?.getTime() ?? null } : null;
    const access = decideAccess({ now: input.now, passId: pass?.pass_id ?? null, invite, entry });
    const invites = pass?.founding_seat ? (await q.query<{ code: string; redeemed_at: Date | null }>(`SELECT code, redeemed_at FROM flight_invites
      WHERE tenant_id = $1 AND issuer_pass_id = $2 ORDER BY created_at, code`, [tenantId, pass.pass_id])).rows.map(row => ({ code: row.code, redeemed: row.redeemed_at !== null })) : [];
    return { access, pass: pass ? passOf(pass) : null, invites, listed: entry?.flight ?? null };
  }

  /** Bind one unused invite to a signed-in account that holds no pass and no invite. Never someone's own Founding invite. */
  async function redeemInvite(input: { accountId: string; code: string; now: number }): Promise<RedeemResult> {
    return db.transaction(async tx => {
      if ((await tx.query('SELECT 1 FROM flight_passes WHERE tenant_id = $1 AND account_id = $2', [tenantId, input.accountId])).rowCount) return 'ALREADY_BOARDED';
      if ((await tx.query('SELECT 1 FROM flight_invites WHERE tenant_id = $1 AND redeemed_by = $2', [tenantId, input.accountId])).rowCount) return 'INVITE_ALREADY_HELD';
      const invite = (await tx.query<{ issuer: 'FOUNDING' | 'CREATOR'; redeemed_at: Date | null; owner: string | null }>(`SELECT i.issuer, i.redeemed_at, p.account_id AS owner
        FROM flight_invites i LEFT JOIN flight_passes p ON p.tenant_id = i.tenant_id AND p.pass_id = i.issuer_pass_id
        WHERE i.tenant_id = $1 AND i.code = $2 FOR UPDATE OF i`, [tenantId, input.code])).rows[0];
      if (!invite) return 'INVITE_INVALID';
      if (invite.redeemed_at) return 'INVITE_USED';
      if (invite.owner === input.accountId) return 'INVITE_OWN';
      await tx.query('UPDATE flight_invites SET redeemed_by = $3, redeemed_at = $4 WHERE tenant_id = $1 AND code = $2', [tenantId, input.code, input.accountId, at(input.now)]);
      await recordEvent('invite_redeem', '', invite.issuer === 'FOUNDING' ? 'INVITE' : 'CREATOR', input.now, tx);
      return 'REDEEMED';
    });
  }

  /**
   * Evidence of a successful server-side simulation by an eligible, signed-in account (kept two hours): the run and the route the
   * server itself projected from the workflow it simulated (`flightRoute`), so a browser can neither forge it nor add steps to it.
   */
  async function recordSimulation(input: { accountId: string; runId: string; flow: string; workflowId: string; revision: number;
    route: FlightRoute; now: number }): Promise<void> {
    await db.transaction(async tx => {
      await tx.query(`DELETE FROM flight_simulations WHERE tenant_id = $1 AND simulated_at < $2::timestamptz - make_interval(secs => $3)`,
        [tenantId, at(input.now), SIMULATION_EVIDENCE_MS / 1000]);
      await tx.query(`INSERT INTO flight_simulations (tenant_id, account_id, run_id, flow, workflow_id, revision, route, simulated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) ON CONFLICT (tenant_id, account_id, run_id) DO NOTHING`,
        [tenantId, input.accountId, input.runId, input.flow, input.workflowId, input.revision, JSON.stringify(input.route), at(input.now)]);
    });
  }
  /** The account's latest recorded simulation (of `workflowId` when given) at most two hours old. */
  async function evidenceOf(input: { accountId: string; workflowId: string | null; now: number }, q: Queryable = db) {
    return (await q.query<{ run_id: string; route: FlightRoute }>(`SELECT run_id, route FROM flight_simulations WHERE tenant_id = $1 AND account_id = $2
      AND ($3::text IS NULL OR workflow_id = $3) AND simulated_at >= $4::timestamptz - make_interval(secs => $5) ORDER BY simulated_at DESC LIMIT 1`,
      [tenantId, input.accountId, input.workflowId, at(input.now), SIMULATION_EVIDENCE_MS / 1000])).rows[0] ?? null;
  }

  /**
   * Issue the account's boarding pass from its latest recorded simulation (of `workflowId`, the one in Review, when given): the
   * account must be eligible and the simulation at most two hours old; the pass carries the route the server recorded. Idempotent: an
   * account that already has a pass gets it back. Ineligible requests are answered before any lock is taken.
   */
  async function issuePass(input: { accountId: string; emails: readonly string[]; workflowId: string | null; handle: string | null; public: boolean;
    now: number }): Promise<IssueResult> {
    const early = await account(input);
    if (early.pass) return { ok: true as const, pass: early.pass, issued: false };
    if (early.access.kind !== 'eligible') return { ok: false as const, code: 'FLIGHT_NOT_ELIGIBLE' as const };
    if (!await evidenceOf(input)) return { ok: false as const, code: 'FLIGHT_SIMULATION_NOT_FOUND' as const };
    return db.transaction(async tx => {
      // The tenant's issuance row is the lock: every boarding waits here, then sees every pass committed before it.
      await tx.query('INSERT INTO flight_issuance (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);
      const issued = (await tx.query<{ boarded: number; founding: number }>('SELECT boarded, founding FROM flight_issuance WHERE tenant_id = $1 FOR UPDATE',
        [tenantId])).rows[0]!;
      const state = await account(input, tx);
      if (state.pass) return { ok: true as const, pass: state.pass, issued: false };
      if (state.access.kind !== 'eligible') return { ok: false as const, code: 'FLIGHT_NOT_ELIGIBLE' as const };
      const evidence = await evidenceOf(input, tx);
      if (!evidence) return { ok: false as const, code: 'FLIGHT_SIMULATION_NOT_FOUND' as const };
      const next = { boarding_no: issued.boarded + 1, seat: issued.founding < FOUNDING_SEATS ? issued.founding + 1 : null };
      await tx.query('UPDATE flight_issuance SET boarded = $2, founding = $3 WHERE tenant_id = $1', [tenantId, next.boarding_no, next.seat ?? issued.founding]);
      // The person's list entries have boarded: deleting this account and signing in again (or another account with the same
      // address) never boards on them again.
      if (input.emails.length) await tx.query(`UPDATE flight_list_entries SET boarded_at = $3 WHERE tenant_id = $1 AND email = ANY($2::text[]) AND boarded_at IS NULL`,
        [tenantId, [...input.emails], at(input.now)]);
      const passId = `flp_${randomBytes(16).toString('hex')}`, origin = state.access.origin;
      const row = (await tx.query<PassRow>(`INSERT INTO flight_passes (tenant_id, pass_id, account_id, origin, boarding_no, founding_seat, handle, public, route,
        run_id, departed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11) RETURNING ${PASS_COLUMNS}`,
        [tenantId, passId, input.accountId, origin, next.boarding_no, next.seat, input.handle, input.public && input.handle !== null,
          JSON.stringify(evidence.route), evidence.run_id, at(input.now)])).rows[0]!;
      if (next.seat !== null) for (let created = 0; created < FOUNDING_INVITES;) {
        created += (await tx.query(`INSERT INTO flight_invites (tenant_id, code, issuer, issuer_pass_id, created_at) VALUES ($1, $2, 'FOUNDING', $3, $4)
          ON CONFLICT (tenant_id, code) DO NOTHING`, [tenantId, inviteCodeFrom(randomBytes(8)), passId, at(input.now)])).rowCount;
      }
      await recordEvent('simulation_ok', next.seat !== null ? 'founding' : 'passenger', origin, input.now, tx);
      return { ok: true as const, pass: passOf(row), issued: true };
    });
  }

  /** The pass holder's own choice: their X handle and whether it appears on the public departures board. */
  async function setHandle(input: { accountId: string; handle: string | null; public: boolean }): Promise<FlightPass | null> {
    const row = (await db.query<PassRow>(`UPDATE flight_passes SET handle = $3, public = $4 WHERE tenant_id = $1 AND account_id = $2 RETURNING ${PASS_COLUMNS}`,
      [tenantId, input.accountId, input.handle, input.public && input.handle !== null])).rows[0];
    return row ? passOf(row) : null;
  }

  // Operator commands (backend/flight-admin.ts): never reachable from a browser.
  async function createBatch(batchNo: number, opensAt: number): Promise<void> {
    if (!Number.isSafeInteger(batchNo) || batchNo < 1 || batchNo > 999 || !Number.isFinite(opensAt)) throw new Error('FLIGHT_BATCH_INVALID');
    await db.query(`INSERT INTO flight_batches (tenant_id, batch_no, opens_at) VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, batch_no) DO UPDATE SET opens_at = EXCLUDED.opens_at`, [tenantId, batchNo, at(opensAt)]);
  }
  /** Put the earliest `count` beta-list entries that have no group yet into `batchNo` (in joining order). */
  async function assignBatch(batchNo: number, count: number): Promise<number> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) throw new Error('FLIGHT_BATCH_COUNT_INVALID');
    return (await db.query(`UPDATE flight_list_entries SET batch_no = $2 WHERE tenant_id = $1 AND entry_id IN (SELECT entry_id FROM flight_list_entries
      WHERE tenant_id = $1 AND flight = 'FIRST' AND batch_no IS NULL ORDER BY joined_at, entry_id LIMIT $3)`, [tenantId, batchNo, count])).rowCount;
  }
  /** The addresses of one boarding group (or of the entries with no group: `null`), for the team's "your group boards" emails. */
  async function exportBatch(batchNo: number | null, flight: 'FIRST' | 'NEXT' = 'FIRST'): Promise<{ email: string; language: string }[]> {
    return (await db.query<{ email: string; language: string }>(`SELECT email, language FROM flight_list_entries WHERE tenant_id = $1 AND flight = $2
      AND batch_no IS NOT DISTINCT FROM $3 ORDER BY joined_at, entry_id`, [tenantId, flight, batchNo])).rows;
  }
  async function issueCreatorInvites(count: number, now: number): Promise<string[]> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 500) throw new Error('FLIGHT_INVITE_COUNT_INVALID');
    const codes: string[] = [];
    while (codes.length < count) {
      const code = inviteCodeFrom(randomBytes(8));
      if ((await db.query(`INSERT INTO flight_invites (tenant_id, code, issuer, created_at) VALUES ($1, $2, 'CREATOR', $3) ON CONFLICT DO NOTHING`,
        [tenantId, code, at(now)])).rowCount) codes.push(code);
    }
    return codes;
  }
  /** Erase one address from both lists (a data subject's request). Returns whether an entry existed. */
  async function eraseEmail(email: string): Promise<boolean> {
    return (await db.query('DELETE FROM flight_list_entries WHERE tenant_id = $1 AND email = $2', [tenantId, email])).rowCount > 0;
  }
  /** Remove a handle from the public departures board (moderation). */
  async function hidePass(passId: string): Promise<boolean> {
    return (await db.query('UPDATE flight_passes SET handle = NULL, public = false WHERE tenant_id = $1 AND pass_id = $2', [tenantId, passId])).rowCount > 0;
  }
  /** End of the beta: every list entry (both flights), every join attempt and all simulation evidence are deleted. */
  async function purgeLists(): Promise<number> {
    return db.transaction(async tx => {
      await tx.query('DELETE FROM flight_join_attempts WHERE tenant_id = $1', [tenantId]);
      await tx.query('DELETE FROM flight_simulations WHERE tenant_id = $1', [tenantId]);
      return (await tx.query('DELETE FROM flight_list_entries WHERE tenant_id = $1', [tenantId])).rowCount;
    });
  }
  async function stats(): Promise<Record<string, unknown>> {
    const base = await counters();
    const lists = (await db.query<{ flight: string; batch_no: number | null; entries: string }>(`SELECT flight, batch_no, count(*) AS entries FROM flight_list_entries
      WHERE tenant_id = $1 GROUP BY flight, batch_no ORDER BY flight, batch_no NULLS FIRST`, [tenantId])).rows.map(r => ({ ...r, entries: Number(r.entries) }));
    const batches = (await db.query<{ batch_no: number; opens_at: Date }>('SELECT batch_no, opens_at FROM flight_batches WHERE tenant_id = $1 ORDER BY batch_no', [tenantId]))
      .rows.map(r => ({ batch: r.batch_no, opensAt: r.opens_at.toISOString() }));
    const invites = (await db.query<{ issuer: string; total: string; redeemed: string }>(`SELECT issuer, count(*) AS total, count(redeemed_at) AS redeemed FROM flight_invites
      WHERE tenant_id = $1 GROUP BY issuer ORDER BY issuer`, [tenantId])).rows.map(r => ({ issuer: r.issuer, total: Number(r.total), redeemed: Number(r.redeemed) }));
    const events = (await db.query<{ day: string; event: string; detail: string; origin: string; events: string }>(`SELECT day::text, event, detail, origin, events
      FROM flight_daily_events WHERE tenant_id = $1 ORDER BY day DESC, event, detail, origin LIMIT 400`, [tenantId])).rows.map(r => ({ ...r, events: Number(r.events) }));
    return { ...base, lists, batches, invites, events };
  }
  /**
   * The privacy notice's retention periods, whether or not anyone joins or simulates: join attempts after one day, simulation evidence
   * after two hours, content-free counters after 13 months. Run by the page (at most every few minutes) and by the operator CLI.
   */
  async function prune(now: number): Promise<{ readonly attempts: number; readonly simulations: number; readonly events: number }> {
    return db.transaction(async tx => ({
      attempts: (await tx.query(`DELETE FROM flight_join_attempts WHERE tenant_id = $1 AND attempted_at < $2::timestamptz`,
        [tenantId, at(now - FLIGHT_RETENTION.joinAttemptsMs)])).rowCount,
      simulations: (await tx.query(`DELETE FROM flight_simulations WHERE tenant_id = $1 AND simulated_at < $2::timestamptz`,
        [tenantId, at(now - FLIGHT_RETENTION.simulationsMs)])).rowCount,
      events: (await tx.query(`DELETE FROM flight_daily_events WHERE tenant_id = $1 AND day < $2::date`,
        [tenantId, at(now - FLIGHT_RETENTION.eventDays * DAY_MS).slice(0, 10)])).rowCount,
    }));
  }

  return { counters, recordEvent, joinList, departures, account, redeemInvite, recordSimulation, issuePass, setHandle, createBatch, assignBatch,
    exportBatch, issueCreatorInvites, eraseEmail, hidePass, purgeLists, stats, prune };
}
export type FlightStore = ReturnType<typeof createFlightStore>;
