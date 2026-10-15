// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-DB-COMPAT-001: the forward-compatibility manifest and the schema decision rule, without a database. The PostgreSQL behavior
 * (real ledgers, the real 0012, locks, runners, processes) is proven by `forward-compatibility.pg.test.ts` and the backend suite.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assertSchemaCurrent, CERTIFIED_FORWARD_MIGRATIONS, schemaCompatibility, SHIPPED_MIGRATIONS, type Database,
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
      // Until it ships, a certified migration's exact SQL is a test fixture, so the PostgreSQL suites prove the certificate on the real bytes.
      for (const m of certificate.migrations.filter(m => m.version > SHIPPED_MIGRATIONS.length)) {
        const fixture = new URL(`./fixtures/${String(m.version).padStart(4, '0')}_${m.name}.sql`, import.meta.url);
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

  it('the vendored unpatched module is the released fa7816b file, byte for byte', async () => {
    const vendored = await readFile(new URL('./baseline/migrations-fa7816b.ts', import.meta.url), 'utf8');
    const header = vendored.split('\n').slice(1, 4).join('\n') + '\n';
    expect(header).toMatch(/^\/\/ BUILD-DB-COMPAT-001 test fixture: the UNPATCHED/);
    const released = vendored.replace(header, '').replace("import type { Database } from '../../src/db.js';", "import type { Database } from './db.js';");
    expect(sha256(released)).toBe('8223d76d97442e1c8dc5157b284a24f68e787272a1a79ccdabe5798b956bf79f');
  });
});

describe('BUILD-DB-COMPAT-001 schema decision rule', () => {
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
    const for12: ForwardCompatibilityCertificate = { base: V12, migrations: [v13], assessment: 'test' };
    expect(schemaCompatibility([...next, v13], next, [...CERTIFIED_FORWARD_MIGRATIONS, for12])).toEqual({ version: 13, application: 12, forward: [v13] });
    expect(code(() => schemaCompatibility([...next, v13], PREVIOUS, [...CERTIFIED_FORWARD_MIGRATIONS, for12]))).toEqual({ error: 'MIGRATION_HISTORY_MISMATCH' });
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
