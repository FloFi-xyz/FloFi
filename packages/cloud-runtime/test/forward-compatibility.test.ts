// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-DB-COMPAT-001: the forward-compatibility manifest and the schema decision rule, without a database. The PostgreSQL behavior
 * (real ledgers, the real 0012, locks, runners, processes) is proven by `forward-compatibility.pg.test.ts` and the backend suite.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, CERTIFIED_FORWARD_MIGRATIONS, forwardMigrationSqlUrl, schemaCompatibility, schemaCompatibilityState, SHIPPED_MIGRATIONS, type Database,
  type ForwardCompatibilityCertificate, type MigrationIdentity } from '../src/index.js';
import * as baseline from './baseline/migrations-fa7816b.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const ADMIN = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.migrations.some(m => m.name === 'admin_control_plane'))!;
/** The build the 0012 certificate was assessed for (v11), and 0012 itself as it will be released. */
const PREVIOUS = SHIPPED_MIGRATIONS.slice(0, ADMIN.base.version), V12 = ADMIN.migrations[0]!;
const code = (run: () => unknown) => { try { return { value: run() }; } catch (error) { return { error: (error as Error).message }; } };
const edit = (m: MigrationIdentity, change: Partial<MigrationIdentity>): MigrationIdentity => ({ ...m, ...change });
const fakeLedger = (rows: readonly MigrationIdentity[]) => ({ query: async () => ({ rows: rows.map(r => ({ ...r })), rowCount: rows.length }) }) as unknown as Database;

describe('BUILD-DB-COMPAT-001 forward-compatibility manifest', () => {
  it('is deeply frozen, well formed, unambiguous and anchored to this repository’s shipped history', async () => {
    expect(Object.isFrozen(CERTIFIED_FORWARD_MIGRATIONS)).toBe(true);
    const bases = new Set<string>();
    for (const certificate of CERTIFIED_FORWARD_MIGRATIONS) {
      expect([certificate, certificate.base, certificate.migrations, ...certificate.migrations].every(Object.isFrozen)).toBe(true);
      // The base is a migration this repository actually shipped, byte for byte.
      expect(SHIPPED_MIGRATIONS[certificate.base.version - 1]).toEqual(certificate.base);
      expect(bases.has(JSON.stringify(certificate.base))).toBe(false);
      bases.add(JSON.stringify(certificate.base));
      expect(certificate.migrations.length).toBeGreaterThan(0);
      certificate.migrations.forEach((m, index) => {
        expect(m.version).toBe(certificate.base.version + index + 1);
        expect(m.name).toMatch(/^[a-z0-9_]+$/);
        expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
        // Once a certified migration ships, it must be exactly what the earlier release certified: otherwise every build deployed with
        // that certificate would refuse the database the moment it is applied.
        if (m.version <= SHIPPED_MIGRATIONS.length) expect(SHIPPED_MIGRATIONS[m.version - 1]).toEqual(m);
      });
      // Until it ships, the exact SQL is stored with the certificate, so the PostgreSQL suites prove the certificate on the real bytes.
      for (const m of certificate.migrations.filter(m => m.version > SHIPPED_MIGRATIONS.length)) {
        const fixture = forwardMigrationSqlUrl(m);
        expect(sha256(await readFile(fixture, 'utf8'))).toBe(m.sha256);
      }
      // The reviewed assessment exists where the certificate says.
      const [path, anchor] = certificate.assessment.split('#');
      const doc = await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
      const anchors = doc.split('\n').filter(line => /^#{1,6} /.test(line))
        .map(line => line.replace(/^#+ /, '').trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-'));
      expect(anchors).toContain(anchor);
    }
  });

  it('certifies the exact 0012 released by BUILD-ADMIN-001 for the build before it, and every later build ships or certifies it', async () => {
    expect(ADMIN.base).toEqual({ version: 11, name: 'delegated_execution', sha256: '0c6572af43ffe278df7724241ae30b1d1c15ab59b85941e2266b1b3294220202' });
    expect(ADMIN.migrations).toEqual([{ version: 12, name: 'admin_control_plane', sha256: '25556fbfd8e45acf0e692fc340eee56fa2f064f4106225960d63e3da9c303af2' }]);
    // The fixture the PostgreSQL suites apply is those exact bytes (copied from BUILD-ADMIN-001 at 53b1a8b, never shipped from here).
    expect(sha256(await readFile(new URL('./fixtures/0012_admin_control_plane.sql', import.meta.url), 'utf8'))).toBe(V12.sha256);
    // This build is either the certified v11 build or already ships 0012 itself: no build in between can refuse it.
    const head = SHIPPED_MIGRATIONS.at(-1)!;
    expect(SHIPPED_MIGRATIONS.length >= V12.version || JSON.stringify(head) === JSON.stringify(ADMIN.base)).toBe(true);
  });

  it('BUILD-CHAT-LEARNING-001: certifies the exact 0013 for the v12 build; every later build ships or certifies it', async () => {
    const learning = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.migrations.some(m => m.name === 'copilot_learning'))!;
    expect(learning.base).toEqual({ version: 12, name: 'admin_control_plane', sha256: '25556fbfd8e45acf0e692fc340eee56fa2f064f4106225960d63e3da9c303af2' });
    expect(learning.migrations).toEqual([{ version: 13, name: 'copilot_learning', sha256: '109be0d34ea5b21ae42b1fda2c4e7fe87254a21ef1264a8235d57e8f1823bfc0' }]);
    expect(sha256(await readFile(new URL('./fixtures/0013_copilot_learning.sql', import.meta.url), 'utf8'))).toBe(learning.migrations[0]!.sha256);
    const head = SHIPPED_MIGRATIONS.at(-1)!;
    expect(SHIPPED_MIGRATIONS.length >= 13 || JSON.stringify(head) === JSON.stringify(learning.base)).toBe(true);
    // The v12 build serves exactly the certified v13 ledger; anything else newer is refused, and without this certificate v13 is refused too.
    const v12 = SHIPPED_MIGRATIONS.slice(0, 12), v13 = learning.migrations[0]!;
    expect(schemaCompatibility([...v12, v13], v12)).toEqual({ version: 13, application: 12, forward: [v13] });
    for (const applied of [[...v12, edit(v13, { sha256: 'f'.repeat(64) })], [...v12, edit(v13, { name: 'copilot_learning_v2' })], [...v12, v13, { version: 14, name: 'later', sha256: 'e'.repeat(64) }],
      [...v12.slice(0, 11), edit(v13, { version: 12 })]])
      expect(code(() => schemaCompatibility(applied, v12))).toEqual({ error: 'MIGRATION_HISTORY_MISMATCH' });
    expect(code(() => schemaCompatibility([...v12, v13], v12, CERTIFIED_FORWARD_MIGRATIONS.filter(c => c !== learning)))).toEqual({ error: 'MIGRATION_HISTORY_MISMATCH' });
    // The v11 build's certificate names 0012 only: a v13 database is not certified for it.
    expect(code(() => schemaCompatibility([...v12, v13], v12.slice(0, 11)))).toEqual({ error: 'MIGRATION_HISTORY_MISMATCH' });
  });

  it('BUILD-CHAT-LEARNING-002: certifies the exact 0014 for the v13 build; every later build ships or certifies it', async () => {
    const automatic = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.migrations.some(m => m.name === 'learning_automatic'))!;
    expect(automatic.base).toEqual({ version: 13, name: 'copilot_learning', sha256: '109be0d34ea5b21ae42b1fda2c4e7fe87254a21ef1264a8235d57e8f1823bfc0' });
    expect(automatic.migrations).toEqual([{ version: 14, name: 'learning_automatic', sha256: '624884d98407383c7093f6a56885ec13001614ddb9e2dcc2ac203451b519314e' }]);
    expect(sha256(await readFile(new URL('./fixtures/0014_learning_automatic.sql', import.meta.url), 'utf8'))).toBe(automatic.migrations[0]!.sha256);
    const head = SHIPPED_MIGRATIONS.at(-1)!;
    expect(SHIPPED_MIGRATIONS.length >= 14 || JSON.stringify(head) === JSON.stringify(automatic.base)).toBe(true);
    // The v13 build serves exactly the certified v14 ledger; anything else newer is refused, and without this certificate v14 is refused too.
    const v13 = SHIPPED_MIGRATIONS.slice(0, 13), v14 = automatic.migrations[0]!;
    expect(schemaCompatibility([...v13, v14], v13)).toEqual({ version: 14, application: 13, forward: [v14] });
    for (const applied of [[...v13, edit(v14, { sha256: 'f'.repeat(64) })], [...v13, edit(v14, { name: 'learning_automatic_v2' })],
      [...v13, v14, { version: 15, name: 'later', sha256: 'e'.repeat(64) }], [...v13.slice(0, 12), edit(v14, { version: 13 })]])
      expect(code(() => schemaCompatibility(applied, v13))).toEqual({ error: 'MIGRATION_HISTORY_MISMATCH' });
    expect(code(() => schemaCompatibility([...v13, v14], v13, CERTIFIED_FORWARD_MIGRATIONS.filter(c => c !== automatic)))).toEqual({ error: 'MIGRATION_HISTORY_MISMATCH' });
    // The v12 build's certificate names 0013 only: a v14 database is not certified for it.
    expect(code(() => schemaCompatibility([...v13, v14], v13.slice(0, 12)))).toEqual({ error: 'MIGRATION_HISTORY_MISMATCH' });
  });

  it('BUILD-CHAT-E2E-001: certifies the exact 0015 for the v14 build; every later build ships or certifies it', async () => {
    const runs = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.migrations.some(m => m.name === 'workflow_runs'))!;
    expect(runs.base).toEqual({ version: 14, name: 'learning_automatic', sha256: '624884d98407383c7093f6a56885ec13001614ddb9e2dcc2ac203451b519314e' });
    expect(runs.migrations).toEqual([{ version: 15, name: 'workflow_runs', sha256: '5dfefcf7465d874da5880ae5a082f7f47e28ede51adfdef46dbbe3e3f7ba945f' }]);
    expect(sha256(await readFile(new URL('./fixtures/0015_workflow_runs.sql', import.meta.url), 'utf8'))).toBe(runs.migrations[0]!.sha256);
    const head = SHIPPED_MIGRATIONS.at(-1)!;
    expect(SHIPPED_MIGRATIONS.length >= 15 || JSON.stringify(head) === JSON.stringify(runs.base)).toBe(true);
    // The v14 build serves exactly the certified v15 ledger; anything else newer is refused, and without this certificate v15 is refused too.
    const v14 = SHIPPED_MIGRATIONS.slice(0, 14), v15 = runs.migrations[0]!;
    expect(schemaCompatibility([...v14, v15], v14)).toEqual({ version: 15, application: 14, forward: [v15] });
    for (const applied of [[...v14, edit(v15, { sha256: 'f'.repeat(64) })], [...v14, edit(v15, { name: 'workflow_runs_v2' })],
      [...v14, v15, { version: 16, name: 'later', sha256: 'e'.repeat(64) }], [...v14.slice(0, 13), edit(v15, { version: 14 })]])
      expect(code(() => schemaCompatibility(applied, v14))).toEqual({ error: 'MIGRATION_HISTORY_MISMATCH' });
    expect(code(() => schemaCompatibility([...v14, v15], v14, CERTIFIED_FORWARD_MIGRATIONS.filter(c => c !== runs)))).toEqual({ error: 'MIGRATION_HISTORY_MISMATCH' });
    // The v13 build's certificate names 0014 only: a v15 database is not certified for it.
    expect(code(() => schemaCompatibility([...v14, v15], v14.slice(0, 13)))).toEqual({ error: 'MIGRATION_HISTORY_MISMATCH' });
  });

  it('the vendored unpatched module is the released fa7816b file, byte for byte', async () => {
    const vendored = await readFile(new URL('./baseline/migrations-fa7816b.ts', import.meta.url), 'utf8');
    const header = vendored.split('\n').slice(1, 4).join('\n') + '\n';
    expect(header).toMatch(/^\/\/ BUILD-DB-COMPAT-001 test fixture: the UNPATCHED/);
    const released = vendored.replace(header, '').replace("import type { Database } from '../../src/db.js';", "import type { Database } from './db.js';");
    expect(sha256(released)).toBe('8223d76d97442e1c8dc5157b284a24f68e787272a1a79ccdabe5798b956bf79f');
  });
});

describe('BUILD-DB-COMPAT-001 schema decision rule', () => {
  it('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the base-28 certificate is extended, never edited — its released identities stay pinned', () => {
    const certificate = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
    expect(certificate.migrations).toEqual([
      { version: 29, name: 'finops_ledger', sha256: '9c04f837b7409622b6b485a21facafb25ce1d579ea2bd492ae859e71795c8de7' },
      { version: 30, name: 'finops_sync', sha256: '63b3c6ca82f69787fcb1d5527b7e3fe28b93b01cc8f5af0df85cc8efd597508b' },
      { version: 31, name: 'position_history_purge', sha256: 'c7d4a08223df2a3d5f32d70902d1d5b2efd5ec961b67f146ea20c2a4afeb898d' },
      { version: 32, name: 'single_step_runs', sha256: '1f388788b8e788fcc412585b38569260acea1e1cb24ec2cab3f2208270e5d14c' },
      // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): extended again with 0033, the owner's guarded purge of an attempt that
      // provably never reached a chain (certificate-0033.pg.test.ts).
      { version: 33, name: 'workflow_run_purge', sha256: '26b8a6dbf15dddbca24924e10bf8748748691c400fcb0c70e1d63038607be2c2' },
      { version: 34, name: 'developer_project_ownership', sha256: '7c698ed7779703abdd6110b39802aa0dad50c74798d6b1eb11a5e35bb4ea1485' },
      { version: 35, name: 'studio_integrations', sha256: '50d4b1c5f08af4ea0ab59e58cdab9e873c00110c9851e8ed1ddd4ff4714e19fb' },
      { version: 36, name: 'studio_certification', sha256: '47d9ab5d5c1736cdfcd2b1110433e5caba9055ec2e90dfd313b7ed1a4e429aa3' }]);
  });
  it('classifies each FinOps-era certificate prefix and keeps the legacy refusal messages', async () => {
    const shipped = SHIPPED_MIGRATIONS.slice(0, 28);
    const certificate = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
    expect(certificate.migrations.map(m => m.version)).toEqual([29, 30, 31, 32, 33, 34, 35, 36]);
    expect(schemaCompatibilityState(shipped, shipped)).toBe('exact');
    for (const [index, migration] of certificate.migrations.entries()) {
      const ahead = [...shipped, ...certificate.migrations.slice(0, index + 1)];
      expect(schemaCompatibilityState(ahead, shipped)).toBe('certified-ahead');
      await expect(assertSchemaCompatible(fakeLedger(ahead), shipped)).resolves.toMatchObject({ version: migration.version, application: 28 });
    }
    const ahead = [...shipped, ...certificate.migrations];
    const last = ahead.at(-1)!;
    const cases = [
      { ledger: shipped.slice(0, -1), state: 'behind', message: 'SCHEMA_NOT_MIGRATED' },
      { ledger: [...ahead, { version: 37, name: 'new_migration', sha256: 'a'.repeat(64) }], state: 'uncertified-ahead', message: 'MIGRATION_HISTORY_MISMATCH' },
      { ledger: [...ahead.slice(0, -1), edit(last, { sha256: 'a'.repeat(64) })], state: 'uncertified-ahead', message: 'MIGRATION_HISTORY_MISMATCH' },
      { ledger: [edit(shipped[0]!, { name: 'edited' }), ...ahead.slice(1)], state: 'invalid-history', message: 'MIGRATION_HISTORY_MISMATCH' },
      { ledger: [...shipped, last], state: 'invalid-history', message: 'MIGRATION_HISTORY_MISMATCH' },
    ] as const;
    for (const { ledger, state, message } of cases) {
      expect(schemaCompatibilityState(ledger, shipped)).toBe(state);
      await expect(assertSchemaCompatible(fakeLedger(ledger), shipped)).rejects.toMatchObject({ message, state });
    }
  });

  it('distinguishes a missing ledger from a database outage without replacing the legacy error or cause', async () => {
    for (const [pgCode, state] of [['42P01', 'behind'], ['57P01', 'unavailable']] as const) {
      const cause = Object.assign(new Error('database probe failed'), { code: pgCode });
      const db = { query: async () => { throw cause; } };
      await expect(assertSchemaCompatible(db, SHIPPED_MIGRATIONS)).rejects.toMatchObject({ message: 'SCHEMA_NOT_MIGRATED', state, cause });
    }
  });

  it('accepts the exact history and a certified newer one; refuses behind, tampered, unknown and inconsistent histories', () => {
    expect(schemaCompatibility(PREVIOUS, PREVIOUS)).toEqual({ version: 11, application: 11, forward: [] });
    expect(schemaCompatibility([...PREVIOUS, V12], PREVIOUS)).toEqual({ version: 12, application: 11, forward: [V12] });
    const refused: Array<[string, readonly MigrationIdentity[], readonly MigrationIdentity[]]> = [
      ['SCHEMA_NOT_MIGRATED', [], PREVIOUS],
      ['SCHEMA_NOT_MIGRATED', PREVIOUS.slice(0, 10), PREVIOUS],                                              // v10 database, v11 build
      ['MIGRATION_HISTORY_MISMATCH', [...PREVIOUS, edit(V12, { sha256: 'f'.repeat(64) })], PREVIOUS],       // edited 0012
      ['MIGRATION_HISTORY_MISMATCH', [...PREVIOUS, edit(V12, { name: 'admin_control_plane_v2' })], PREVIOUS],
      ['MIGRATION_HISTORY_MISMATCH', [...PREVIOUS, edit(V12, { version: 13 })], PREVIOUS],                  // a gap where 0012 belongs
      ['MIGRATION_HISTORY_MISMATCH', [...PREVIOUS, V12, { version: 13, name: 'later', sha256: 'e'.repeat(64) }], PREVIOUS],
      ['MIGRATION_HISTORY_MISMATCH', [...PREVIOUS, { version: 12, name: 'something_else', sha256: 'e'.repeat(64) }], PREVIOUS],
      ['MIGRATION_HISTORY_MISMATCH', [...PREVIOUS.map((m, i) => i === 4 ? edit(m, { sha256: '0'.repeat(64) }) : m), V12], PREVIOUS],
      ['MIGRATION_HISTORY_MISMATCH', PREVIOUS.map((m, i) => i === 4 ? edit(m, { sha256: '0'.repeat(64) }) : m).slice(0, 9), PREVIOUS],
      ['MIGRATION_HISTORY_MISMATCH', [...PREVIOUS.filter(m => m.version !== 6), V12], PREVIOUS],            // a missing historical row
      ['MIGRATION_HISTORY_MISMATCH', [...PREVIOUS.slice(0, 10), V12], PREVIOUS],                            // 0012 without 0011
      ['MIGRATION_HISTORY_MISMATCH', [...PREVIOUS, V12], PREVIOUS.slice(0, 10)],                            // a v10 build is not certified
    ];
    for (const [expected, applied, shipped] of refused) expect(code(() => schemaCompatibility(applied, shipped))).toEqual({ error: expected });
    // The certificate is the only thing that admits 0012: without it, the v11 build refuses exactly as before.
    expect(code(() => schemaCompatibility([...PREVIOUS, V12], PREVIOUS, []))).toEqual({ error: 'MIGRATION_HISTORY_MISMATCH' });
  });

  it('the new build (0012 shipped) needs exactly its schema; a later migration is admitted only by its own certificate for that build', () => {
    const next = [...PREVIOUS, V12], v13 = { version: 13, name: 'later_change', sha256: 'd'.repeat(64) };
    expect(schemaCompatibility(next, next)).toEqual({ version: 12, application: 12, forward: [] });
    expect(code(() => schemaCompatibility(PREVIOUS, next))).toEqual({ error: 'SCHEMA_NOT_MIGRATED' });
    // The v11 build's certificate says nothing about the v12 build, nor about 0013.
    expect(code(() => schemaCompatibility([...next, v13], next))).toEqual({ error: 'MIGRATION_HISTORY_MISMATCH' });
    // (BUILD-CHAT-LEARNING-001 added the real v12 certificate for its 0013: the synthetic one replaces it here — one certificate per build.)
    const for12: ForwardCompatibilityCertificate = { base: V12, migrations: [v13], assessment: 'test' };
    const others = CERTIFIED_FORWARD_MIGRATIONS.filter(c => JSON.stringify(c.base) !== JSON.stringify(V12));
    expect(schemaCompatibility([...next, v13], next, [...others, for12])).toEqual({ version: 13, application: 12, forward: [v13] });
    expect(code(() => schemaCompatibility([...next, v13], PREVIOUS, [...others, for12]))).toEqual({ error: 'MIGRATION_HISTORY_MISMATCH' });
    expect(code(() => schemaCompatibility([...next, v13], next, [...CERTIFIED_FORWARD_MIGRATIONS, for12]))).toEqual({ error: 'MIGRATION_CERTIFICATE_INVALID' });
    // A chain certified for the v11 build admits a prefix of it, never more.
    const chain: ForwardCompatibilityCertificate = { base: ADMIN.base, migrations: [V12, v13], assessment: 'test' };
    expect(schemaCompatibility([...next, v13], PREVIOUS, [chain]).forward).toEqual([V12, v13]);
    expect(schemaCompatibility(next, PREVIOUS, [chain]).forward).toEqual([V12]);
  });

  it('a malformed or ambiguous manifest fails closed whenever the database is ahead', () => {
    const ahead = [...PREVIOUS, V12];
    const invalid: ForwardCompatibilityCertificate[][] = [
      [ADMIN, { ...ADMIN }],                                                                  // two certificates for one build
      [{ ...ADMIN, migrations: [] }],
      [{ ...ADMIN, migrations: [edit(V12, { version: 13 })] }],                               // not contiguous with its base
      [{ ...ADMIN, migrations: [edit(V12, { sha256: 'NOT-HEX'.padEnd(64, '0') })] }],
      [{ ...ADMIN, migrations: [edit(V12, { name: 'Admin Control' })] }],
    ];
    for (const certificates of invalid) expect(code(() => schemaCompatibility(ahead, PREVIOUS, certificates))).toEqual({ error: 'MIGRATION_CERTIFICATE_INVALID' });
    // A base that is not a real migration identity (version 0) is refused as well.
    const zero = edit(ADMIN.base, { version: 0 });
    expect(code(() => schemaCompatibility([zero, edit(V12, { version: 1 })], [zero], [{ ...ADMIN, base: zero, migrations: [edit(V12, { version: 1 })] }])))
      .toEqual({ error: 'MIGRATION_CERTIFICATE_INVALID' });
    // A manifest problem never matters to a database at exactly this build's schema.
    expect(schemaCompatibility(PREVIOUS, PREVIOUS, invalid[0]).forward).toEqual([]);
  });

  it('without a certificate it decides exactly what the released strict check decides, for every ledger shape', async () => {
    const shipped = PREVIOUS, ledgers: MigrationIdentity[][] = [[], [...shipped], [...shipped, V12], [...shipped, V12, { version: 13, name: 'x', sha256: 'a'.repeat(64) }]];
    for (let length = 0; length <= shipped.length; length++) {
      ledgers.push(shipped.slice(0, length));
      for (let at = 0; at < length; at++) {
        ledgers.push(shipped.slice(0, length).map((m, i) => i === at ? edit(m, { sha256: 'b'.repeat(64) }) : m));
        ledgers.push(shipped.slice(0, length).map((m, i) => i === at ? edit(m, { name: 'renamed' }) : m));
        ledgers.push(shipped.slice(0, length).filter((_, i) => i !== at));
      }
    }
    for (const ledger of ledgers) {
      const released = await baseline.assertSchemaCurrent(fakeLedger(ledger), shipped).then(value => ({ value }), (e: Error) => ({ error: e.message }));
      const strict = await assertSchemaCurrent(fakeLedger(ledger), shipped).then(value => ({ value }), (e: Error) => ({ error: e.message }));
      const rule = code(() => schemaCompatibility(ledger, shipped, []).version);
      expect([strict, rule]).toEqual([released, released]);
    }
    expect(ledgers.length).toBeGreaterThan(200);
  });
});
