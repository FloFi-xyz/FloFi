// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001 on real disposable PostgreSQL (loopback only): the beta list, boarding groups, invites, evidence-bound pass
 * issuance, the 100 Founding seats under concurrent boarding (never reissued), retention and tenant isolation. Test data only, in a
 * database created and dropped by this suite.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTenant } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { FLIGHT_BOARDING_OPENS_AT, FLIGHT_LIST_CLOSES_AT, flightRoute } from './campaign';
import { createFlightStore, FLIGHT_RETENTION, JOIN_LIMITS, NO_CLIENT, type FlightStore } from './store';

type Node = SemanticWorkflow['nodes'][number];
let t: TestDatabase, store: FlightStore;
beforeAll(async () => { t = await createTestDatabase(); store = createFlightStore({ db: t.db, tenantId: 'default' }); });
afterAll(async () => { await t?.drop(); });

const BEFORE = FLIGHT_LIST_CLOSES_AT - 3 * 86_400_000, BOARDING = FLIGHT_BOARDING_OPENS_AT + 60_000;
const hex = (n: number) => randomBytes(n).toString('hex');
async function newAccount(): Promise<string> {
  const accountId = `acct_${hex(16)}`;
  await t.db.query('INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ($1, $2)', ['default', accountId]);
  return accountId;
}
const node = (nodeId: string, actionType: string, chainId: string, protocols: string[], destination?: string): Node => ({
  nodeId, actionType, actionSchemaVersion: '1.0.0', chainId, requiredCapabilities: [], adapterConstraints: { adapters: [], protocols },
  inputs: destination ? [{ name: 'asset-out', kind: 'ASSET', value: { chainId: destination, address: '0x0000000000000000000000000000000000000001', symbol: 'USDC', decimals: 6 } }] : [],
  expectedOutputs: [], dependencies: [], userConstraints: [], failurePolicy: 'HALT', requiredAuthorizationClass: 'WALLET', lockedParameters: [], editableBounds: [],
} as unknown as Node);
/** The approved 4-step card: Swap on Ethereum, Ethereum → Base, Base → Solana, Orca on Solana. */
const route4 = [node('n1', 'asset.swap.exact-input', 'eip155:1', ['uniswap']), node('n2', 'asset.bridge', 'eip155:1', ['across.direct'], 'eip155:8453'),
  node('n3', 'asset.bridge', 'eip155:8453', ['across.direct'], 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'),
  node('n4', 'asset.liquidity.concentrated', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', ['orca-whirlpools'])];
const swap = [node('s1', 'asset.swap.exact-input', 'eip155:8453', ['uniswap'])];

/** The server's record of a simulation: the route it projected from the workflow it simulated. */
async function simulated(accountId: string, workflowId: string, nodes: readonly Node[], now = BOARDING, target = store) {
  await target.recordSimulation({ accountId, runId: `run-${hex(6)}`, flow: 'crosschain-universal', workflowId, revision: 3, route: flightRoute(nodes)!, now });
}
const issue = (accountId: string, workflowId: string | null, extra: { emails?: string[]; now?: number; handle?: string | null; public?: boolean } = {}) =>
  store.issuePass({ accountId, emails: extra.emails ?? [], workflowId, handle: extra.handle ?? null, public: extra.public ?? false, now: extra.now ?? BOARDING });

describe('BUILD-FLOFI-FLIGHT-001 beta list', () => {
  it('persists a joined address once: a repeat is answered the same way and never counted twice', async () => {
    const before = (await store.counters()).onList;
    const first = await store.joinList({ email: 'ana@flofi-test.dev', language: 'EN', flight: 'FIRST', client: hex(32), now: BEFORE });
    const again = await store.joinList({ email: 'ana@flofi-test.dev', language: 'PT', flight: 'FIRST', client: hex(32), now: BEFORE });
    expect([first.status, again.status]).toEqual(['JOINED', 'ALREADY']);
    expect((await store.counters()).onList).toBe(before + 1);
    expect((await t.db.query(`SELECT flight, language, notice FROM flight_list_entries WHERE email = 'ana@flofi-test.dev'`)).rows)
      .toEqual([{ flight: 'FIRST', language: 'EN', notice: '2026-11-05' }]);
  });

  it('limits one client per hour without storing its address, and the database refuses a malformed address', async () => {
    const client = hex(32);
    const answers = [];
    for (let i = 0; i <= JOIN_LIMITS.perClientHour; i++) answers.push((await store.joinList({ email: `bot${i}@flofi-test.dev`, language: 'EN', flight: 'FIRST', client, now: BEFORE })).status);
    expect(answers.slice(0, -1).every(status => status === 'JOINED')).toBe(true);
    expect(answers.at(-1)).toBe('RATE_LIMITED');
    expect((await t.db.query(`SELECT count(*)::int AS n FROM flight_list_entries WHERE email = $1`, [`bot${JOIN_LIMITS.perClientHour}@flofi-test.dev`])).rows).toEqual([{ n: 0 }]);
    // The attempts table holds only the keyed digest, never an address.
    expect((await t.db.query(`SELECT DISTINCT length(client) AS l FROM flight_join_attempts`)).rows).toEqual([{ l: 64 }]);
    await expect(t.db.query(`INSERT INTO flight_list_entries (tenant_id, entry_id, email, flight, language, notice) VALUES ('default', $1, 'Not An Email', 'FIRST', 'EN', 'x')`,
      [`fle_${hex(16)}`])).rejects.toThrow();
  });

  it('counts a request without a client digest toward the deployment-wide limit, which then stops everyone', async () => {
    await store.joinList({ email: 'nodigest@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    expect((await t.db.query(`SELECT count(*)::int AS n FROM flight_join_attempts WHERE client = $1`, [NO_CLIENT])).rows).toEqual([{ n: 1 }]);
    // Fill the ten-minute window (test rows), then any client, with or without a digest, is told to come back later.
    await t.db.query(`INSERT INTO flight_join_attempts (tenant_id, client, attempted_at) SELECT 'default', md5(s::text) || md5(s::text), $1::timestamptz
      FROM generate_series(1, ${JOIN_LIMITS.globalTenMinutes}) s`, [new Date(BEFORE).toISOString()]);
    expect((await store.joinList({ email: 'late1@flofi-test.dev', language: 'EN', flight: 'FIRST', client: hex(32), now: BEFORE })).status).toBe('BUSY');
    expect((await store.joinList({ email: 'late2@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE })).status).toBe('BUSY');
    // Eleven minutes later the window has moved on.
    expect((await store.joinList({ email: 'late3@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE + 11 * 60_000 })).status).toBe('JOINED');
    await t.db.query('DELETE FROM flight_join_attempts'); // This test's rows only fill the window for this test.
  });
});

describe('BUILD-FLOFI-FLIGHT-001 access: list, boarding group, invite', () => {
  it('answers each state from real rows: not yet, list, group still closed, next flight and not listed', async () => {
    const listed = await newAccount(), grouped = await newAccount(), next = await newAccount(), stranger = await newAccount();
    await store.joinList({ email: 'listed@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    await store.joinList({ email: 'grouped@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE + 1 });
    await store.joinList({ email: 'next@flofi-test.dev', language: 'EN', flight: 'NEXT', client: null, now: FLIGHT_LIST_CLOSES_AT + 1 });
    await store.createBatch(3, Date.parse('2026-11-19T09:00:00-03:00'));
    await t.db.query(`UPDATE flight_list_entries SET batch_no = 3 WHERE email = 'grouped@flofi-test.dev'`);
    expect((await store.account({ accountId: listed, emails: ['listed@flofi-test.dev'], now: BEFORE })).access).toEqual({ kind: 'not_yet', opensAt: FLIGHT_BOARDING_OPENS_AT });
    expect((await store.account({ accountId: listed, emails: ['listed@flofi-test.dev'], now: BOARDING })).access).toEqual({ kind: 'eligible', origin: 'LIST' });
    expect((await store.account({ accountId: grouped, emails: ['grouped@flofi-test.dev'], now: BOARDING })).access)
      .toEqual({ kind: 'batch_closed', batch: 3, opensAt: Date.parse('2026-11-19T09:00:00-03:00') });
    expect((await store.account({ accountId: grouped, emails: ['grouped@flofi-test.dev'], now: Date.parse('2026-11-19T09:00:00-03:00') })).access.kind).toBe('eligible');
    expect((await store.account({ accountId: next, emails: ['next@flofi-test.dev'], now: BOARDING })).access).toEqual({ kind: 'not_listed' });
    expect((await store.account({ accountId: stranger, emails: [], now: BOARDING })).access).toEqual({ kind: 'not_listed' });
  });

  it('an invite is single use, never one’s own, one per account, and makes its holder eligible without the list', async () => {
    const [code, spare] = await store.issueCreatorInvites(2, BOARDING);
    const holder = await newAccount(), late = await newAccount();
    expect(await store.redeemInvite({ accountId: holder, code: 'FLF-2222-2222', now: BOARDING })).toBe('INVITE_INVALID');
    expect(await store.redeemInvite({ accountId: holder, code: code!, now: BOARDING })).toBe('REDEEMED');
    expect(await store.redeemInvite({ accountId: late, code: code!, now: BOARDING })).toBe('INVITE_USED');
    expect(await store.redeemInvite({ accountId: holder, code: spare!, now: BOARDING })).toBe('INVITE_ALREADY_HELD');
    expect((await store.account({ accountId: holder, emails: [], now: BOARDING })).access).toEqual({ kind: 'eligible', origin: 'CREATOR' });
    // A Founding member's invites: three, usable by others, never by the member.
    const founder = await newAccount();
    await t.db.query(`INSERT INTO flight_invites (tenant_id, code, issuer) VALUES ('default', 'FLF-ABCD-EFGH', 'CREATOR')`);
    expect(await store.redeemInvite({ accountId: founder, code: 'FLF-ABCD-EFGH', now: BOARDING })).toBe('REDEEMED');
    await simulated(founder, 'wf-founder', swap);
    const pass = await issue(founder, 'wf-founder');
    expect(pass.ok && pass.pass.foundingSeat).toBeTruthy();
    const invites = (await store.account({ accountId: founder, emails: [], now: BOARDING })).invites;
    expect(invites).toHaveLength(3);
    expect(await store.redeemInvite({ accountId: founder, code: invites[0]!.code, now: BOARDING })).toBe('ALREADY_BOARDED');
    expect(await store.redeemInvite({ accountId: late, code: invites[0]!.code, now: BOARDING })).toBe('REDEEMED');
    expect((await store.account({ accountId: late, emails: [], now: BOARDING })).access).toEqual({ kind: 'eligible', origin: 'INVITE' });
    expect((await store.account({ accountId: founder, emails: [], now: BOARDING })).invites.filter(i => i.redeemed)).toHaveLength(1);
  });
});

describe('BUILD-FLOFI-FLIGHT-001 boarding passes', () => {
  it('needs the server’s own record of a recent simulation of the workflow in Review; then issues once, with the route the server recorded', async () => {
    await store.joinList({ email: 'pilot@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    const pilot = await newAccount(), emails = ['pilot@flofi-test.dev'];
    expect(await issue(pilot, 'wf-pilot', { emails })).toEqual({ ok: false, code: 'FLIGHT_SIMULATION_NOT_FOUND' });
    // A simulation of another workflow, or one older than two hours, does not count for this one.
    await simulated(pilot, 'wf-other', swap);
    await simulated(pilot, 'wf-pilot', route4, BOARDING - 3 * 3_600_000);
    expect(await issue(pilot, 'wf-pilot', { emails })).toEqual({ ok: false, code: 'FLIGHT_SIMULATION_NOT_FOUND' });
    await simulated(pilot, 'wf-pilot', route4);
    const first = await issue(pilot, 'wf-pilot', { emails, handle: 'pilot_one', public: true });
    expect(first).toMatchObject({ ok: true, issued: true, pass: { origin: 'LIST', handle: 'pilot_one', public: true, route: {
      from: 'ETH', to: 'SOL', stepCount: 4, networkCount: 3, steps: [{ action: 'Swap', detail: 'Uniswap · Ethereum' }, { action: 'Bridge', detail: 'Ethereum → Base' },
        { action: 'Bridge', detail: 'Base → Solana' }, { action: 'Add liquidity', detail: 'Orca · Solana' }] } } });
    const again = await issue(pilot, null, { emails });
    expect(again.ok && !again.issued && first.ok && again.pass.passId === first.pass.passId).toBe(true);
    // Not eligible (not listed, no invite): no pass, whatever was simulated — answered before any lock (no issuance row is touched).
    const stranger = await newAccount(), issuance = async () => (await t.db.query('SELECT boarded FROM flight_issuance')).rows;
    await simulated(stranger, 'wf-s', swap);
    const before = await issuance();
    expect(await issue(stranger, 'wf-s')).toEqual({ ok: false, code: 'FLIGHT_NOT_ELIGIBLE' });
    expect(await issuance()).toEqual(before);
    // Without naming a workflow, the latest recorded simulation is the one.
    const later = await newAccount(), [code] = await store.issueCreatorInvites(1, BOARDING);
    await store.redeemInvite({ accountId: later, code: code!, now: BOARDING });
    await simulated(later, 'wf-a', route4, BOARDING - 60_000);
    await simulated(later, 'wf-b', swap, BOARDING - 1_000);
    expect(await issue(later, null)).toMatchObject({ ok: true, pass: { origin: 'CREATOR', route: { from: 'BASE', to: 'BASE', stepCount: 1 } } });
    // The database refuses evidence without a route object.
    await expect(t.db.query(`INSERT INTO flight_simulations (tenant_id, account_id, run_id, flow, workflow_id, revision, route) VALUES ('default', $1, 'r', 'f', 'w', 1, '[]')`,
      [later])).rejects.toThrow();
  });

  it('gives exactly the 100 Founding seats once each under concurrent boarding; everyone after boards as a passenger', async () => {
    // A fresh issuance (test data): earlier tests' passes and their numbers removed.
    await t.db.query(`DELETE FROM flight_invites WHERE issuer = 'FOUNDING'`);
    await t.db.query(`DELETE FROM flight_passes`);
    await t.db.query(`DELETE FROM flight_issuance`);
    const accounts = await Promise.all(Array.from({ length: 130 }, async () => {
      const accountId = await newAccount(), [code] = await store.issueCreatorInvites(1, BOARDING);
      await store.redeemInvite({ accountId, code: code!, now: BOARDING });
      await simulated(accountId, `wf-${accountId}`, swap);
      return accountId;
    }));
    const pool = t.open(20), racing = createFlightStore({ db: pool, tenantId: 'default' });
    try {
      // Every account asks twice at once: 260 concurrent requests for 130 passes.
      const results = await Promise.all(accounts.flatMap(accountId => [0, 1].map(() => racing.issuePass({ accountId, emails: [], workflowId: `wf-${accountId}`,
        handle: null, public: false, now: BOARDING }))));
      expect(results.every(result => result.ok)).toBe(true);
      expect(results.filter(result => result.ok && result.issued)).toHaveLength(130);
    } finally { await pool.close(); }
    const rows = (await t.db.query<{ seats: number; distinct_seats: number; min: number; max: number; passes: number; boarding: number }>(`SELECT
      count(founding_seat)::int AS seats, count(DISTINCT founding_seat)::int AS distinct_seats, min(founding_seat) AS min, max(founding_seat) AS max,
      count(*)::int AS passes, count(DISTINCT boarding_no)::int AS boarding FROM flight_passes`)).rows[0]!;
    expect(rows).toEqual({ seats: 100, distinct_seats: 100, min: 1, max: 100, passes: 130, boarding: 130 });
    expect(await store.counters()).toMatchObject({ boarded: 130, foundingTaken: 100, foundingLeft: 0 });
    // The issuance row can never record more than 100 Founding seats.
    await expect(t.db.query(`UPDATE flight_issuance SET founding = 101, boarded = 200`)).rejects.toThrow();
    expect((await t.db.query(`SELECT count(*)::int AS n FROM flight_invites WHERE issuer = 'FOUNDING'`)).rows).toEqual([{ n: 300 }]);
    // The table itself refuses a 101st seat or a repeated one.
    const extra = await newAccount();
    await expect(t.db.query(`INSERT INTO flight_passes (tenant_id, pass_id, account_id, origin, boarding_no, founding_seat, route, run_id)
      VALUES ('default', $1, $2, 'LIST', 9999, 101, '{}', 'r')`, [`flp_${hex(16)}`, extra])).rejects.toThrow();
    await expect(t.db.query(`INSERT INTO flight_passes (tenant_id, pass_id, account_id, origin, boarding_no, founding_seat, route, run_id)
      VALUES ('default', $1, $2, 'LIST', 9999, 7, '{}', 'r')`, [`flp_${hex(16)}`, extra])).rejects.toThrow();
    const late = (await store.account({ accountId: accounts[0]!, emails: [], now: BOARDING })).pass;
    expect(late?.seat).toMatch(/^#\d{3}$|^\d+E$/);
  });

  it('shows only passes their holders made public, newest first, five at most, and never an amount or account', async () => {
    const shown = await store.departures();
    expect(shown.length).toBeLessThanOrEqual(5);
    for (const departure of shown) expect(Object.keys(departure).sort()).toEqual(['from', 'handle', 'seat', 'steps', 'to']);
    const someone = (await t.db.query<{ account_id: string }>(`SELECT account_id FROM flight_passes ORDER BY boarding_no LIMIT 1`)).rows[0]!.account_id;
    await store.setHandle({ accountId: someone, handle: 'first_aboard', public: true });
    expect((await store.departures())[0]).toMatchObject({ handle: 'first_aboard', from: 'BASE', to: 'BASE', steps: 1, seat: '#001' });
    const passId = (await t.db.query<{ pass_id: string }>(`SELECT pass_id FROM flight_passes WHERE account_id = $1`, [someone])).rows[0]!.pass_id;
    expect(await store.hidePass(passId)).toBe(true);
    expect((await store.departures()).some(d => d.handle === 'first_aboard')).toBe(false);
  });

  it('erases on request: a list address by the operator, and everything of an account when the account is deleted', async () => {
    expect(await store.eraseEmail('ana@flofi-test.dev')).toBe(true);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM flight_list_entries WHERE email = 'ana@flofi-test.dev'`)).rows).toEqual([{ n: 0 }]);
    const holder = (await t.db.query<{ account_id: string }>(`SELECT account_id FROM flight_passes WHERE founding_seat = 2`)).rows[0]!.account_id;
    const redeemed = (await t.db.query<{ code: string }>(`SELECT code FROM flight_invites WHERE redeemed_by = $1`, [holder])).rows[0]!.code;
    await t.db.query(`DELETE FROM flofi_accounts WHERE tenant_id = 'default' AND account_id = $1`, [holder]);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM flight_passes WHERE account_id = $1`, [holder])).rows).toEqual([{ n: 0 }]);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM flight_simulations WHERE account_id = $1`, [holder])).rows).toEqual([{ n: 0 }]);
    // Its Founding invites stay usable (they were given out), no longer linked to anyone; the invite it used stays used, unlinked.
    expect((await t.db.query(`SELECT count(*)::int AS n FROM flight_invites WHERE issuer = 'FOUNDING' AND issuer_pass_id IS NULL`)).rows).toEqual([{ n: 3 }]);
    expect((await t.db.query(`SELECT redeemed_by, redeemed_at IS NOT NULL AS used FROM flight_invites WHERE code = $1`, [redeemed])).rows)
      .toEqual([{ redeemed_by: null, used: true }]);
    // Seat #002 and its boarding number are never issued again: the counters keep them, the next boarder gets the next number.
    expect(await store.counters()).toMatchObject({ boarded: 130, foundingTaken: 100, foundingLeft: 0 });
    const next = await newAccount(), [code] = await store.issueCreatorInvites(1, BOARDING);
    await store.redeemInvite({ accountId: next, code: code!, now: BOARDING });
    await simulated(next, 'wf-next', swap);
    expect(await issue(next, 'wf-next')).toMatchObject({ ok: true, pass: { boardingNo: 131, foundingSeat: null, seat: '131E' } });
    // The content-free counters hold codes only.
    const columns = (await t.db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'flight_daily_events' ORDER BY ordinal_position`)).rows;
    expect(columns.map(c => c.column_name)).toEqual(['tenant_id', 'day', 'event', 'detail', 'origin', 'events', 'updated_at']);
  });
});

describe('BUILD-FLOFI-FLIGHT-001 retention and tenants', () => {
  it('deletes expired join attempts, simulation evidence and counters whether or not anyone joins again; purge ends the lists', async () => {
    const now = BOARDING + 30 * 86_400_000, someone = await newAccount();
    await t.db.query(`INSERT INTO flight_join_attempts (tenant_id, client, attempted_at) VALUES ('default', $1, $2), ('default', $1, $3)`,
      [hex(32), new Date(now - FLIGHT_RETENTION.joinAttemptsMs - 1).toISOString(), new Date(now - 60_000).toISOString()]);
    await simulated(someone, 'wf-old', swap, now - FLIGHT_RETENTION.simulationsMs - 1);
    await simulated(someone, 'wf-new', swap, now - 60_000);
    await store.recordEvent('board_click', '', null, now - 401 * 86_400_000);
    await store.recordEvent('board_click', '', null, now);
    const pruned = await store.prune(now);
    expect(pruned.simulations).toBeGreaterThanOrEqual(1);
    expect(pruned.attempts).toBeGreaterThanOrEqual(1);
    expect(pruned.events).toBe(1);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM flight_join_attempts WHERE attempted_at < $1`, [new Date(now - FLIGHT_RETENTION.joinAttemptsMs).toISOString()])).rows)
      .toEqual([{ n: 0 }]);
    expect((await t.db.query(`SELECT workflow_id FROM flight_simulations WHERE account_id = $1`, [someone])).rows).toEqual([{ workflow_id: 'wf-new' }]);
    expect(await store.purgeLists()).toBeGreaterThan(0);
    expect((await t.db.query(`SELECT (SELECT count(*) FROM flight_list_entries)::int AS lists, (SELECT count(*) FROM flight_join_attempts)::int AS attempts,
      (SELECT count(*) FROM flight_simulations)::int AS simulations`)).rows).toEqual([{ lists: 0, attempts: 0, simulations: 0 }]);
  });

  it('keeps every tenant apart: its list, counters, invites, evidence, passes and departures', async () => {
    await ensureTenant(t.db, 'flight-other');
    const other = createFlightStore({ db: t.db, tenantId: 'flight-other' }), accountId = `acct_${hex(16)}`;
    await t.db.query('INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ($1, $2)', ['flight-other', accountId]);
    expect(await other.counters()).toEqual({ onList: 0, boarded: 0, foundingTaken: 0, foundingLeft: 100 });
    expect(await other.departures()).toEqual([]);
    await other.joinList({ email: 'other@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    expect((await store.account({ accountId: await newAccount(), emails: ['other@flofi-test.dev'], now: BOARDING })).access).toEqual({ kind: 'not_listed' });
    // A default-tenant invite is unknown to the other tenant; its own list and evidence board it with seat #001 of its own count.
    const [code] = await store.issueCreatorInvites(1, BOARDING);
    expect(await other.redeemInvite({ accountId, code: code!, now: BOARDING })).toBe('INVITE_INVALID');
    await simulated(accountId, 'wf-other-tenant', swap, BOARDING, other);
    expect(await other.issuePass({ accountId, emails: ['other@flofi-test.dev'], workflowId: 'wf-other-tenant', handle: null, public: false, now: BOARDING }))
      .toMatchObject({ ok: true, pass: { foundingSeat: 1, boardingNo: 1 } });
    expect(await store.counters()).toMatchObject({ boarded: 131, foundingTaken: 100 });
  });
});
