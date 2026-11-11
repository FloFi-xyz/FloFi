// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: Flight FloFi persistence (migration 0020). Every write is one short transaction. Passes take their numbers from
 * the tenant's `flight_issuance` row under its row lock, and the tables enforce the limit (seat 1..100, unique; one pass per account), so
 * concurrent boardings never share a seat, never exceed 100, never give an account two passes, and a number freed by a deleted account
 * is never issued again. Errors are fixed codes; nothing here logs personal data.
 *
 * BUILD-FLOFI-FLIGHT-LAUNCH-001 (migration 0024): a list entry also reaches an account through a proven access link or code
 * (`flight_access_claims`), never by an unverified address; each card gets an unguessable public link id; issuing a card or joining a list
 * enqueues its email in the same transaction (the outbox delivers it, see email/); only a Founding seat earned straight from the beta list
 * carries invites (`carriesInvites`); and the public state has no aggregate count of people (`foundingOpen` is a yes/no).
 */
import { randomBytes } from 'node:crypto';
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { cardPublicIdFrom, carriesInvites, decideAccess, eventOrigin, FLIGHT_DEFAULT_CALENDAR, FLIGHT_EVENTS, FLIGHT_NOTICE_VERSION, FOUNDING_INVITES, FOUNDING_SEATS,
  foundingSeat, fullCalendar, inviteCodeFrom, passengerSeat, SIMULATION_EVIDENCE_MS, DEPARTURES_SHOWN, type FlightAccess, type FlightCalendar, type FlightEvent,
  normalizeEmail, type FlightOrigin, type FlightRoute } from './campaign.ts';
import { enqueueEmail } from './email/outbox.ts';

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
  /** The card's public link id (`/card/{id}`), or null for a card taken down. */
  readonly publicId: string | null;
};
/** What the public card page shows: no account, address, wallet or invite. */
export type PublicCard = { readonly publicId: string; readonly founding: boolean; readonly seat: string; readonly handle: string | null; readonly route: FlightRoute;
  readonly departedAt: string };
export type OwnInvite = { readonly code: string; readonly redeemed: boolean };
export type AccountFlight = { readonly access: FlightAccess; readonly pass: FlightPass | null; readonly invites: readonly OwnInvite[];
  readonly listed: 'FIRST' | 'NEXT' | null };
export type IssueResult = { readonly ok: true; readonly pass: FlightPass; readonly issued: boolean } | { readonly ok: false; readonly code:
  'FLIGHT_NOT_ELIGIBLE' | 'FLIGHT_SIMULATION_NOT_FOUND' };
export type RedeemResult = 'REDEEMED' | 'INVITE_INVALID' | 'INVITE_USED' | 'INVITE_OWN' | 'INVITE_ALREADY_HELD' | 'ALREADY_BOARDED' | 'INVITE_NOT_YET' | 'INVITE_IDENTITY_MISMATCH';

type PassRow = { pass_id: string; origin: FlightOrigin; boarding_no: number; founding_seat: number | null; handle: string | null; public: boolean;
  route: FlightRoute; departed_at: Date; public_id: string | null; removed_at: Date | null };
const passOf = (row: PassRow): FlightPass => ({ passId: row.pass_id, origin: row.origin, boardingNo: row.boarding_no, foundingSeat: row.founding_seat,
  seat: row.founding_seat ? foundingSeat(row.founding_seat) : passengerSeat(row.boarding_no), handle: row.handle, public: row.public, route: row.route,
  departedAt: row.departed_at.toISOString(), publicId: row.removed_at ? null : row.public_id });
const PASS_COLUMNS = 'pass_id, origin, boarding_no, founding_seat, handle, public, route, departed_at, public_id, removed_at';
const newPublicId = () => cardPublicIdFrom(randomBytes(12));

/** `calendar`: the deployment's campaign calendar (`flightCalendar` in host.ts), which decides when the access answers start. */
export function createFlightStore(host: FlightHost, given: FlightCalendar = FLIGHT_DEFAULT_CALENDAR,
  options: { readonly allowVerifiedEmail?: boolean } = {}) {
  const { db, tenantId } = host, calendar = fullCalendar(given);

  /**
   * The campaign's totals: the beta list, and the boarding numbers and Founding seats issued (a deleted account's stay issued). OPERATOR
   * ONLY (flight-admin `stats`): no public page, API, image or email shows an aggregate count of people (team decision, 9 Nov 2026).
   */
  async function counters(q: Queryable = db): Promise<FlightCounters> {
    const row = (await q.query<{ on_list: string; boarded: string; founding: string }>(`SELECT
      (SELECT count(*) FROM flight_list_entries WHERE tenant_id = $1 AND flight = 'FIRST') AS on_list,
      coalesce((SELECT boarded FROM flight_issuance WHERE tenant_id = $1), 0) AS boarded,
      coalesce((SELECT founding FROM flight_issuance WHERE tenant_id = $1), 0) AS founding`, [tenantId])).rows[0]!;
    const foundingTaken = Number(row.founding);
    return { onList: Number(row.on_list), boarded: Number(row.boarded), foundingTaken, foundingLeft: Math.max(0, FOUNDING_SEATS - foundingTaken) };
  }
  /** Whether Founding seats are still open: the only public fact about seats (a yes/no, never a number). */
  async function foundingOpen(q: Queryable = db): Promise<boolean> {
    const row = (await q.query<{ founding: number }>('SELECT founding FROM flight_issuance WHERE tenant_id = $1', [tenantId])).rows[0];
    return (row?.founding ?? 0) < FOUNDING_SEATS;
  }

  async function recordEvent(event: FlightEvent, detail: string, origin: FlightOrigin | null, now: number, q: Queryable = db): Promise<void> {
    if (!(FLIGHT_EVENTS[event] as readonly string[]).includes(detail)) throw new Error('FLIGHT_EVENT_INVALID');
    const day = at(now).slice(0, 10);
    await q.query(`INSERT INTO flight_daily_events (tenant_id, day, event, detail, origin, events, updated_at) VALUES ($1, $2::date, $3, $4, $5, 1, $6)
      ON CONFLICT (tenant_id, day, event, detail, origin) DO UPDATE SET events = flight_daily_events.events + 1, updated_at = EXCLUDED.updated_at`,
      [tenantId, day, event, detail, eventOrigin(origin), at(now)]);
  }

  /**
   * One person joins a list. A repeated address keeps its first entry, and the route answers both the same way (no public counter exists to
   * compare, so nothing reveals whether an address was already listed). A new entry enqueues its email in the same transaction, once: Email 1
   * (beta list) or Email 5 (next flight). `client` is a keyed digest of the request's network address (rate limit only), or null.
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
      const entryId = `fle_${randomBytes(16).toString('hex')}`;
      const inserted = await tx.query(`INSERT INTO flight_list_entries (tenant_id, entry_id, email, flight, language, notice)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, email) DO NOTHING`,
        [tenantId, entryId, input.email, input.flight, input.language, FLIGHT_NOTICE_VERSION]);
      if (inserted.rowCount) {
        await recordEvent('list_join', input.flight === 'FIRST' ? 'first' : 'next', null, input.now, tx);
        await enqueueEmail(tx, tenantId, input.flight === 'FIRST'
          ? { template: 'LIST_CONFIRMATION', recipient: input.email, language: input.language, trigger: 'list_join', dedupeKey: `list:${entryId}`, notBefore: input.now,
            expiresAt: calendar.boardingOpensAt, entryId }
          : { template: 'NEXT_FLIGHT', recipient: input.email, language: input.language, trigger: 'list_join', dedupeKey: `next:${entryId}`, notBefore: input.now,
            expiresAt: input.now + 7 * DAY_MS, entryId });
      }
      return { status: inserted.rowCount ? 'JOINED' as const : 'ALREADY' as const };
    });
  }

  async function departures(): Promise<Departure[]> {
    const rows = (await db.query<PassRow>(`SELECT ${PASS_COLUMNS} FROM flight_passes WHERE tenant_id = $1 AND public AND removed_at IS NULL ORDER BY departed_at DESC, boarding_no DESC
      LIMIT ${DEPARTURES_SHOWN}`, [tenantId])).rows;
    return rows.map(passOf).map(pass => ({ handle: pass.handle!, from: pass.route.from, to: pass.route.to, steps: pass.route.stepCount, seat: pass.seat }));
  }

  /**
   * On the person's explicit Board now, remember the list address their account already verified. Reads never claim an entry. A later
   * wallet sign-in reaches the same account's durable claim without another email prompt; an existing claim is never reassigned.
   */
  async function claimVerifiedEntry(input: { accountId: string; emails: readonly string[]; now: number }):
    Promise<'CLAIMED' | 'NONE' | 'CLAIMED_ELSEWHERE' | 'ACCOUNT_HAS_OTHER_ENTRY'> {
    return db.transaction(async tx => {
      if ((await tx.query('SELECT 1 FROM flight_access_claims WHERE tenant_id = $1 AND account_id = $2', [tenantId, input.accountId])).rowCount) return 'CLAIMED';
      if (!input.emails.length) return 'NONE';
      const entry = (await tx.query<{ entry_id: string }>(`SELECT e.entry_id FROM flight_list_entries e LEFT JOIN flight_batches b
        ON b.tenant_id = e.tenant_id AND b.batch_no = e.batch_no WHERE e.tenant_id = $1 AND e.email = ANY($2::text[]) AND e.boarded_at IS NULL
        ORDER BY (e.flight = 'FIRST') DESC, b.opens_at ASC NULLS FIRST, e.entry_id LIMIT 1 FOR UPDATE OF e`, [tenantId, [...input.emails]])).rows[0];
      if (!entry) return 'NONE';
      const owner = (await tx.query<{ account_id: string }>('SELECT account_id FROM flight_access_claims WHERE tenant_id = $1 AND entry_id = $2',
        [tenantId, entry.entry_id])).rows[0];
      if (owner) return owner.account_id === input.accountId ? 'CLAIMED' : 'CLAIMED_ELSEWHERE';
      const inserted = await tx.query(`INSERT INTO flight_access_claims (tenant_id, entry_id, account_id, claimed_at) VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING`, [tenantId, entry.entry_id, input.accountId, at(input.now)]);
      if (inserted.rowCount) return 'CLAIMED';
      const held = (await tx.query<{ entry_id: string }>('SELECT entry_id FROM flight_access_claims WHERE tenant_id = $1 AND account_id = $2',
        [tenantId, input.accountId])).rows[0];
      return held?.entry_id === entry.entry_id ? 'CLAIMED' : held ? 'ACCOUNT_HAS_OTHER_ENTRY' : 'CLAIMED_ELSEWHERE';
    });
  }

  /**
   * The account's place in the campaign: its pass, else what "Board now" answers. `emails` are the account's verified addresses; an
   * entry that already boarded (with this or another account, since deleted) gives nothing again.
   */
  async function account(input: { accountId: string; emails: readonly string[]; now: number }, q: Queryable = db): Promise<AccountFlight> {
    const pass = (await q.query<PassRow>(`SELECT ${PASS_COLUMNS} FROM flight_passes WHERE tenant_id = $1 AND account_id = $2`, [tenantId, input.accountId])).rows[0];
    const invite = (await q.query<{ issuer: 'FOUNDING' | 'CREATOR' }>('SELECT issuer FROM flight_invites WHERE tenant_id = $1 AND redeemed_by = $2 AND revoked_at IS NULL',
      [tenantId, input.accountId])).rows[0]?.issuer ?? null;
    // Open rollout retains legacy campaign eligibility reads. Closed beta requires a durable Flight claim.
    const entries = (await q.query<{ flight: 'FIRST' | 'NEXT'; batch_no: number | null; opens_at: Date | null }>(`SELECT e.flight, e.batch_no, b.opens_at
      FROM flight_list_entries e LEFT JOIN flight_batches b ON b.tenant_id = e.tenant_id AND b.batch_no = e.batch_no
      LEFT JOIN flight_access_claims c ON c.tenant_id = e.tenant_id AND c.entry_id = e.entry_id
      WHERE e.tenant_id = $1 AND (c.account_id = $2 OR (c.account_id IS NULL AND e.email = ANY($3::text[])
        AND NOT EXISTS (SELECT 1 FROM flight_access_claims held WHERE held.tenant_id = $1 AND held.account_id = $2)))
        AND e.boarded_at IS NULL ORDER BY (e.flight = 'FIRST') DESC, b.opens_at ASC NULLS FIRST LIMIT 1`,
      [tenantId, input.accountId, options.allowVerifiedEmail ? [...input.emails] : []])).rows;
    const entry = entries[0] ? { flight: entries[0].flight, batch: entries[0].batch_no, opensAt: entries[0].opens_at?.getTime() ?? null } : null;
    const access = decideAccess({ now: input.now, passId: pass?.pass_id ?? null, invite, entry, calendar });
    const invites = pass?.founding_seat ? (await q.query<{ code: string; redeemed_at: Date | null }>(`SELECT code, redeemed_at FROM flight_invites
      WHERE tenant_id = $1 AND issuer_pass_id = $2 ORDER BY created_at, code`, [tenantId, pass.pass_id])).rows.map(row => ({ code: row.code, redeemed: row.redeemed_at !== null })) : [];
    return { access, pass: pass ? passOf(pass) : null, invites, listed: entry?.flight ?? null };
  }

  /** Bind one unused invite to a signed-in account that holds no pass and no invite. Never someone's own Founding invite. */
  async function redeemInvite(input: { accountId: string; code: string; now: number; emails?: readonly string[] }): Promise<RedeemResult> {
    // Refuse before any read or write: early redemption never reserves or consumes an invite.
    if (input.now < calendar.boardingOpensAt) return 'INVITE_NOT_YET';
    return db.transaction(async tx => {
      if ((await tx.query('SELECT 1 FROM flight_passes WHERE tenant_id = $1 AND account_id = $2', [tenantId, input.accountId])).rowCount) return 'ALREADY_BOARDED';
      if ((await tx.query('SELECT 1 FROM flight_invites WHERE tenant_id = $1 AND redeemed_by = $2', [tenantId, input.accountId])).rowCount) return 'INVITE_ALREADY_HELD';
      const invite = (await tx.query<{ issuer: 'FOUNDING' | 'CREATOR'; redeemed_at: Date | null; owner: string | null; recipient: string | null; expires_at: Date | null; revoked_at: Date | null }>(`SELECT i.issuer, i.redeemed_at, i.recipient, i.expires_at, i.revoked_at, p.account_id AS owner
        FROM flight_invites i LEFT JOIN flight_passes p ON p.tenant_id = i.tenant_id AND p.pass_id = i.issuer_pass_id
        WHERE i.tenant_id = $1 AND i.code = $2 FOR UPDATE OF i`, [tenantId, input.code])).rows[0];
      if (!invite || invite.revoked_at || (invite.expires_at && invite.expires_at.getTime() <= input.now)) return 'INVITE_INVALID';
      if (invite.redeemed_at) return 'INVITE_USED';
      if (invite.owner === input.accountId) return 'INVITE_OWN';
      if (invite.recipient && !input.emails?.includes(invite.recipient)) return 'INVITE_IDENTITY_MISMATCH';
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
  /**
   * The account's latest recorded simulation (of `workflowId` when given) at most two hours old. `boardingOnly`: only one made once boarding
   * opened — a simulation from before the opening never issues a numbered card.
   */
  async function evidenceOf(input: { accountId: string; workflowId: string | null; now: number; boardingOnly?: boolean }, q: Queryable = db) {
    return (await q.query<{ run_id: string; route: FlightRoute }>(`SELECT run_id, route FROM flight_simulations WHERE tenant_id = $1 AND account_id = $2
      AND ($3::text IS NULL OR workflow_id = $3) AND simulated_at >= $4::timestamptz - make_interval(secs => $5) AND simulated_at >= $6::timestamptz
      ORDER BY simulated_at DESC LIMIT 1`,
      [tenantId, input.accountId, input.workflowId, at(input.now), SIMULATION_EVIDENCE_MS / 1000, input.boardingOnly ? at(calendar.boardingOpensAt) : at(0)])).rows[0] ?? null;
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
    if (!await evidenceOf({ ...input, boardingOnly: true })) return { ok: false as const, code: 'FLIGHT_SIMULATION_NOT_FOUND' as const };
    return db.transaction(async tx => {
      // The tenant's issuance row is the lock: every boarding waits here, then sees every pass committed before it.
      await tx.query('INSERT INTO flight_issuance (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);
      const issued = (await tx.query<{ boarded: number; founding: number }>('SELECT boarded, founding FROM flight_issuance WHERE tenant_id = $1 FOR UPDATE',
        [tenantId])).rows[0]!;
      // Serialize against link/code and verified-email claims before rechecking eligibility. A claim cannot move between this check
      // and marking the entry boarded, even when a different account has a verified copy of its address.
      await tx.query(`SELECT e.entry_id FROM flight_list_entries e WHERE e.tenant_id = $1 AND (e.email = ANY($2::text[])
        OR e.entry_id IN (SELECT entry_id FROM flight_access_claims WHERE tenant_id = $1 AND account_id = $3)) ORDER BY e.entry_id FOR UPDATE OF e`,
        [tenantId, [...input.emails], input.accountId]);
      const state = await account(input, tx);
      if (state.pass) return { ok: true as const, pass: state.pass, issued: false };
      if (state.access.kind !== 'eligible') return { ok: false as const, code: 'FLIGHT_NOT_ELIGIBLE' as const };
      const evidence = await evidenceOf({ ...input, boardingOnly: true }, tx);
      if (!evidence) return { ok: false as const, code: 'FLIGHT_SIMULATION_NOT_FOUND' as const };
      const next = { boarding_no: issued.boarded + 1, seat: issued.founding < FOUNDING_SEATS ? issued.founding + 1 : null };
      await tx.query('UPDATE flight_issuance SET boarded = $2, founding = $3 WHERE tenant_id = $1', [tenantId, next.boarding_no, next.seat ?? issued.founding]);
      // The person's list entries have boarded: deleting this account and signing in again (or another account with the same
      // address) never boards on them again.
      await tx.query(`UPDATE flight_list_entries e SET boarded_at = $4 WHERE tenant_id = $1 AND boarded_at IS NULL AND
        (entry_id IN (SELECT entry_id FROM flight_access_claims WHERE tenant_id = $1 AND account_id = $3) OR (email = ANY($2::text[])
          AND NOT EXISTS (SELECT 1 FROM flight_access_claims c WHERE c.tenant_id = e.tenant_id AND c.entry_id = e.entry_id AND c.account_id <> $3)
          AND NOT EXISTS (SELECT 1 FROM flight_access_claims held WHERE held.tenant_id = $1 AND held.account_id = $3)))`,
        [tenantId, [...input.emails], input.accountId, at(input.now)]);
      const passId = `flp_${randomBytes(16).toString('hex')}`, origin = state.access.origin;
      const row = (await tx.query<PassRow>(`INSERT INTO flight_passes (tenant_id, pass_id, account_id, origin, boarding_no, founding_seat, handle, public, route,
        run_id, departed_at, public_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12) RETURNING ${PASS_COLUMNS}`,
        [tenantId, passId, input.accountId, origin, next.boarding_no, next.seat, input.handle, input.public && input.handle !== null,
          JSON.stringify(evidence.route), evidence.run_id, at(input.now), newPublicId()])).rows[0]!;
      // Only a Founding seat earned straight from the beta list carries invites: an invited person never gets invites of their own.
      if (carriesInvites({ foundingSeat: next.seat, origin })) for (let created = 0; created < FOUNDING_INVITES;) {
        created += (await tx.query(`INSERT INTO flight_invites (tenant_id, code, issuer, issuer_pass_id, created_at, expires_at) VALUES ($1, $2, 'FOUNDING', $3, $4, $4::timestamptz + interval '30 days')
          ON CONFLICT (tenant_id, code) DO NOTHING`, [tenantId, inviteCodeFrom(randomBytes(8)), passId, at(input.now)])).rowCount;
      }
      await recordEvent('simulation_ok', next.seat !== null ? 'founding' : 'passenger', origin, input.now, tx);
      // Email 4a / 4b, once per card, to an address the person proved (a verified login address, else their claimed list entry). No
      // proven address, no email: the card stays in the account either way.
      const recipient = await cardRecipient(tx, input.accountId, input.emails);
      if (recipient) await enqueueEmail(tx, tenantId, { template: next.seat !== null ? 'CARD_FOUNDING' : 'CARD_PASSENGER', recipient: recipient.email,
        language: recipient.language, trigger: 'card_issued', dedupeKey: `card:${passId}`, notBefore: input.now, expiresAt: input.now + 7 * DAY_MS, passId });
      return { ok: true as const, pass: passOf(row), issued: true };
    });
  }

  /**
   * Where the card email goes: the bound list entry and its registered language, otherwise the account's verified login address (its
   * list entry's language when listed). Never an address the person did not prove (a creator invite's recipient may not be them).
   */
  async function cardRecipient(q: Queryable, accountId: string, emails: readonly string[]): Promise<{ email: string; language: 'EN' | 'PT' } | null> {
    const claimed = (await q.query<{ email: string; language: 'EN' | 'PT' }>(`SELECT e.email, e.language FROM flight_access_claims c JOIN flight_list_entries e
      ON e.tenant_id = c.tenant_id AND e.entry_id = c.entry_id WHERE c.tenant_id = $1 AND c.account_id = $2`, [tenantId, accountId])).rows[0];
    if (claimed) return claimed;
    if (emails.length) {
      const listed = (await q.query<{ email: string; language: 'EN' | 'PT' }>(`SELECT email, language FROM flight_list_entries WHERE tenant_id = $1 AND email = ANY($2::text[])
        ORDER BY (flight = 'FIRST') DESC, joined_at LIMIT 1`, [tenantId, [...emails]])).rows[0];
      return listed ?? { email: emails[0]!, language: 'EN' };
    }
    // An invite's recipient is not proven to be whoever redeemed the code (a code can be forwarded): no address, no email. The card stays
    // in the account.
    return null;
  }

  /**
   * The public card page (`/card/{id}`): the card's own facts only. A card taken down, or of a deleted account, is gone. Older cards (issued
   * before 0024) get their public id the first time their holder opens /board.
   */
  async function publicCard(publicId: string): Promise<PublicCard | null> {
    if (!/^[a-z2-7]{12}$/.test(publicId)) return null;
    const row = (await db.query<PassRow>(`SELECT ${PASS_COLUMNS} FROM flight_passes WHERE tenant_id = $1 AND public_id = $2 AND removed_at IS NULL`, [tenantId, publicId])).rows[0];
    if (!row) return null;
    const pass = passOf(row);
    return { publicId, founding: pass.foundingSeat !== null, seat: pass.seat, handle: pass.handle, route: pass.route, departedAt: pass.departedAt };
  }
  /** Give a card issued before 0024 its public id (idempotent). */
  async function ensurePublicId(accountId: string): Promise<FlightPass | null> {
    await db.query(`UPDATE flight_passes SET public_id = $3 WHERE tenant_id = $1 AND account_id = $2 AND public_id IS NULL AND removed_at IS NULL`,
      [tenantId, accountId, newPublicId()]);
    const row = (await db.query<PassRow>(`SELECT ${PASS_COLUMNS} FROM flight_passes WHERE tenant_id = $1 AND account_id = $2`, [tenantId, accountId])).rows[0];
    return row ? passOf(row) : null;
  }
  /** The card and its invites, for its email (by pass id; the outbox renders it at send time). */
  async function cardForEmail(passId: string): Promise<{ pass: FlightPass; invites: readonly string[] } | null> {
    const row = (await db.query<PassRow>(`SELECT ${PASS_COLUMNS} FROM flight_passes WHERE tenant_id = $1 AND pass_id = $2 AND removed_at IS NULL`, [tenantId, passId])).rows[0];
    if (!row || !row.public_id) return null;
    const invites = (await db.query<{ code: string }>(`SELECT code FROM flight_invites WHERE tenant_id = $1 AND issuer_pass_id = $2 ORDER BY created_at, code`,
      [tenantId, passId])).rows.map(r => r.code);
    return { pass: passOf(row), invites };
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
      if ((await db.query(`INSERT INTO flight_invites (tenant_id, code, issuer, created_at, expires_at) VALUES ($1, $2, 'CREATOR', $3, $3::timestamptz + interval '30 days') ON CONFLICT DO NOTHING`,
        [tenantId, code, at(now)])).rowCount) codes.push(code);
    }
    return codes;
  }
  /** Import an owner-reviewed Google Forms export. No email is queued here; Email 0 is a separate explicit command. */
  async function importGoogleForms(entries: readonly { readonly email: string; readonly signedUpAt: number; readonly language: 'EN' | 'PT' | null;
    readonly consent: boolean }[], now: number): Promise<{ readonly imported: number; readonly alreadyImported: number }> {
    // Validate the complete input before opening a transaction. Never infer an unknown timestamp or consent.
    for (const entry of entries) if (!normalizeEmail(entry.email) || !Number.isFinite(entry.signedUpAt) || entry.signedUpAt > now
      || entry.signedUpAt > calendar.listClosesAt || entry.email.length > 254) throw new Error('FLIGHT_IMPORT_INVALID');
    return db.transaction(async tx => {
      let imported = 0, alreadyImported = 0;
      // Stable order also prevents two overlapping imports from taking their address locks in opposite orders.
      for (const entry of [...entries].sort((a, b) => normalizeEmail(a.email)!.localeCompare(normalizeEmail(b.email)!))) {
        const email = normalizeEmail(entry.email)!;
        await tx.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [JOIN_LOCK_CLASS, `${tenantId}:import:${email}`]);
        const row = (await tx.query<{ entry_id: string }>(`INSERT INTO flight_list_entries (tenant_id, entry_id, email, flight, language, notice, joined_at)
          VALUES ($1, $2, $3, 'FIRST', $4, 'google-forms-original', $5)
          ON CONFLICT (tenant_id, email) DO UPDATE SET joined_at = least(flight_list_entries.joined_at, EXCLUDED.joined_at), flight = 'FIRST'
          RETURNING entry_id`, [tenantId, `fle_${randomBytes(16).toString('hex')}`, email, entry.language ?? 'EN', at(entry.signedUpAt)])).rows[0]!;
        const result = await tx.query(`INSERT INTO flight_early_list_imports (tenant_id, entry_id, original_email, signed_up_at, original_language, campaign_consent, imported_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id, entry_id) DO NOTHING`,
        [tenantId, row.entry_id, entry.email, at(entry.signedUpAt), entry.language, entry.consent, at(now)]);
        if (result.rowCount) imported++; else alreadyImported++;
      }
      return { imported, alreadyImported };
    });
  }
  /** Erase one address from both lists (a data subject's request). Returns whether an entry existed. */
  async function eraseEmail(email: string): Promise<boolean> {
    // The entry, and by cascade its access tokens, sessions, claim and emails; then every other email to the address and its invite addressing.
    return db.transaction(async tx => {
      const erased = (await tx.query('DELETE FROM flight_list_entries WHERE tenant_id = $1 AND email = $2', [tenantId, email])).rowCount > 0;
      const emails = (await tx.query('DELETE FROM flight_emails WHERE tenant_id = $1 AND recipient = $2', [tenantId, email])).rowCount > 0;
      const invites = (await tx.query('UPDATE flight_invites SET recipient = NULL WHERE tenant_id = $1 AND recipient = $2', [tenantId, email])).rowCount > 0;
      return erased || emails || invites;
    });
  }
  /**
   * The team invites one creator (Email 6): a CREATOR invite addressed to `email` (one per address) and its email, sent at `sendAt`. Returns
   * the code, or the existing one when this address was already invited (never a second invite or a second email).
   */
  async function inviteCreator(input: { email: string; language: 'EN' | 'PT'; sendAt: number; now: number }): Promise<{ code: string; created: boolean; state: 'AVAILABLE' | 'REDEEMED' | 'REVOKED' | 'EXPIRED' }> {
    return db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [JOIN_LOCK_CLASS, `${tenantId}:invite:${input.email}`]);
      const existing = (await tx.query<{ code: string; redeemed_at: Date | null; revoked_at: Date | null; expires_at: Date | null }>('SELECT code, redeemed_at, revoked_at, expires_at FROM flight_invites WHERE tenant_id = $1 AND recipient = $2', [tenantId, input.email])).rows[0];
      if (existing) return { code: existing.code, created: false, state: existing.redeemed_at ? 'REDEEMED' as const : existing.revoked_at ? 'REVOKED' as const
        : existing.expires_at && existing.expires_at.getTime() <= input.now ? 'EXPIRED' as const : 'AVAILABLE' as const };
      let code = '';
      for (let inserted = 0; !inserted;) {
        code = inviteCodeFrom(randomBytes(8));
        inserted = (await tx.query(`INSERT INTO flight_invites (tenant_id, code, issuer, created_at, recipient, expires_at) VALUES ($1, $2, 'CREATOR', $3, $4, $3::timestamptz + interval '30 days') ON CONFLICT DO NOTHING`,
          [tenantId, code, at(input.now), input.email])).rowCount;
      }
      await enqueueEmail(tx, tenantId, { template: 'CREATOR_INVITE', recipient: input.email, language: input.language, trigger: 'creator_invited',
        dedupeKey: `creator:${code.toLowerCase()}`, notBefore: input.sendAt, expiresAt: calendar.boardingOpensAt, inviteCode: code, batchKey: null });
      return { code, created: true, state: 'AVAILABLE' as const };
    });
  }
  /** Take a card's public page down (the person's request or moderation): the page, its images and the departures entry disappear. */
  async function removeCard(passOrPublicId: string, now: number): Promise<boolean> {
    return (await db.query(`UPDATE flight_passes SET removed_at = $3, public = false WHERE tenant_id = $1 AND (pass_id = $2 OR public_id = $2) AND removed_at IS NULL`,
      [tenantId, passOrPublicId, at(now)])).rowCount > 0;
  }
  /** Remove a handle from the public departures board (moderation). */
  async function hidePass(passId: string): Promise<boolean> {
    return (await db.query('UPDATE flight_passes SET handle = NULL, public = false WHERE tenant_id = $1 AND pass_id = $2', [tenantId, passId])).rowCount > 0;
  }
  /**
   * End of the beta: every list entry (both flights), every join attempt and all simulation evidence are deleted, with every email of the
   * outbox, access token, browser session, claim and access attempt (by cascade or here). Unsubscribed-address digests stay (an opt-out
   * is honored after the lists are gone); boarding cards stay with their accounts.
   */
  async function purgeLists(): Promise<number> {
    return db.transaction(async tx => {
      await tx.query('DELETE FROM flight_join_attempts WHERE tenant_id = $1', [tenantId]);
      await tx.query('DELETE FROM flight_simulations WHERE tenant_id = $1', [tenantId]);
      await tx.query('DELETE FROM flight_emails WHERE tenant_id = $1', [tenantId]);
      await tx.query('DELETE FROM flight_access_attempts WHERE tenant_id = $1', [tenantId]);
      await tx.query('UPDATE flight_invites SET recipient = NULL WHERE tenant_id = $1 AND recipient IS NOT NULL', [tenantId]);
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

  return { calendar, counters, foundingOpen, recordEvent, joinList, departures, claimVerifiedEntry, account, redeemInvite, recordSimulation, issuePass, setHandle, createBatch, assignBatch,
    exportBatch, issueCreatorInvites, inviteCreator, importGoogleForms, eraseEmail, hidePass, removeCard, publicCard, ensurePublicId, cardForEmail, purgeLists, stats, prune };
}
export type FlightStore = ReturnType<typeof createFlightStore>;
