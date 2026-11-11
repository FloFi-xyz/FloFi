// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness';
import { createFlightStore, type FlightStore } from '../src/flight/store';
import { FLIGHT_DEFAULT_CALENDAR } from '../src/flight/campaign';
import { createEmailOutbox } from '../src/flight/email/outbox';
import { parseGoogleFormsCsv, runFlightCommand, type FlightAdminContext } from './flight-admin';

let database: TestDatabase, store: FlightStore, context: FlightAdminContext, directory: string;
const now = FLIGHT_DEFAULT_CALENDAR.boardingOpensAt - 2 * 86_400_000;
beforeAll(async () => {
  database = await createTestDatabase();
  store = createFlightStore({ db: database.db, tenantId: 'default' });
  context = { outbox: createEmailOutbox({ db: database.db, tenantId: 'default' }), entryOf: async () => null, revoke: null, sendDue: { disabled: 'TEST_NO_EMAIL_DELIVERY' } };
  directory = await mkdtemp(join(tmpdir(), 'flofi-flight-admin-cli-'));
});
afterAll(async () => { await database?.drop(); if (directory) await rm(directory, { recursive: true, force: true }); });

describe('Flight operator CLI on disposable PostgreSQL; never imports or sends to production', () => {
  it('dry-runs a Forms CSV, preserves timestamp and source when applied, and separately reserves Email 0 exactly once', async () => {
    const file = join(directory, 'original.csv');
    await writeFile(file, 'email,submitted_at,language,consent\nOriginal@Example.com,2026-10-01T10:30:00-03:00,PT,true\n', { mode: 0o600 });
    expect(await runFlightCommand('import-google-forms', { file }, store, now, context)).toEqual({ dryRun: true, entries: 1, consented: 1 });
    expect((await database.db.query('SELECT count(*)::int AS n FROM flight_list_entries')).rows).toEqual([{ n: 0 }]);
    expect(await runFlightCommand('import-google-forms', { file, apply: true }, store, now, context)).toEqual({ imported: 1, alreadyImported: 0 });
    expect(await runFlightCommand('import-google-forms', { file, apply: true }, store, now, context)).toEqual({ imported: 0, alreadyImported: 1 });
    expect((await database.db.query(`SELECT e.email, e.joined_at, i.original_email, i.signed_up_at, i.source, i.original_language
      FROM flight_list_entries e JOIN flight_early_list_imports i USING (tenant_id, entry_id)`)).rows)
      .toEqual([{ email: 'original@example.com', joined_at: new Date('2026-10-01T13:30:00Z'), original_email: 'Original@Example.com',
        signed_up_at: new Date('2026-10-01T13:30:00Z'), source: 'GOOGLE_FORMS', original_language: 'PT' }]);
    expect((await database.db.query('SELECT count(*)::int AS n FROM flight_emails')).rows).toEqual([{ n: 0 }]);
    expect(await runFlightCommand('email-early-list', { apply: true }, store, now, context)).toEqual({ enqueued: 1 });
    expect(await runFlightCommand('email-early-list', { apply: true }, store, now, context)).toEqual({ enqueued: 0 });
    expect((await database.db.query('SELECT template, state, attempts FROM flight_emails')).rows)
      .toEqual([{ template: 'EARLY_LIST', state: 'PENDING', attempts: 0 }]);
  });

  it('validates the full CSV before mutation and refuses missing consent, ambiguous or rolled-over timestamps', async () => {
    for (const csv of [
      'email,submitted_at,language,consent\na@example.com,2026-10-01T12:00:00,EN,true',
      'email,submitted_at,language,consent\na@example.com,2026-02-30T12:00:00Z,EN,true',
      'email,submitted_at,language,consent\na@example.com,2026-10-01T12:00:00Z,EN,',
    ]) expect(() => parseGoogleFormsCsv(csv)).toThrow('CSV_ROW_INVALID');
    const file = join(directory, 'invalid.csv');
    await writeFile(file, 'email,submitted_at,language,consent\nvalid@example.com,2026-10-01T12:00:00Z,EN,true\ninvalid,2026-10-01T12:00:00Z,EN,true\n');
    await expect(runFlightCommand('import-google-forms', { file, apply: true }, store, now, context)).rejects.toThrow('CSV_ROW_INVALID');
    expect((await database.db.query("SELECT count(*)::int AS n FROM flight_list_entries WHERE email = 'valid@example.com'")).rows).toEqual([{ n: 0 }]);
  });

  it('exports generated invite secrets only to a new private CSV and keeps repeat commands idempotent without resending SENT', async () => {
    const file = join(directory, 'invited.csv'), out = join(directory, 'private-invites.csv');
    await writeFile(file, 'email,language\nCreator@Example.com,PT\n', { mode: 0o600 });
    expect(await runFlightCommand('creator-invites', { file }, store, now, context)).toEqual({ dryRun: true, recipients: 1 });
    expect((await database.db.query('SELECT count(*)::int AS n FROM flight_invites')).rows).toEqual([{ n: 0 }]);
    const result = await runFlightCommand('creator-invites', { file, apply: true, out }, store, now, context);
    expect(result).toEqual({ invited: 1, alreadyInvited: 0, out });
    const csv = await readFile(out, 'utf8'), code = csv.match(/FLF-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/)![0];
    expect(csv).toContain('"email","language","code","state"');
    expect(csv).toContain('"creator@example.com","PT"');
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain(code);
    expect(JSON.stringify(result)).not.toContain('creator@example.com');
    await expect(runFlightCommand('creator-invites', { file, apply: true, out }, store, now, context)).rejects.toThrow('OUT_FILE_EXISTS');
    // Record prior delivery as an isolated fixture; no provider is called by the CLI.
    await database.db.query(`UPDATE flight_emails SET state = 'SENT', sent_at = $1, reserved_at = $1, attempts = 1 WHERE template = 'CREATOR_INVITE'`, [new Date(now)]);
    expect(await runFlightCommand('creator-invites', { file, apply: true, out: join(directory, 'repeat.csv') }, store, now, context))
      .toMatchObject({ invited: 0, alreadyInvited: 1 });
    expect((await database.db.query("SELECT template_version, state, attempts FROM flight_emails WHERE template = 'CREATOR_INVITE'")).rows)
      .toEqual([{ template_version: 3, state: 'SENT', attempts: 1 }]);
  });
});
