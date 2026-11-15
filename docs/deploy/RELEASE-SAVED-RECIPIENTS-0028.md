# FloFi: release of Saved Recipients (BUILD-FLOFI-UNIFIED-COPILOT-001; migration 0028)

Status (2026-11-15): **Release A is in review (this pull request); nothing has been deployed or migrated.** No production database, Railway
service or Vercel project was touched during engineering. Release B has not been prepared; its steps are below for the owner to run later.

**Saved recipients stay unavailable in production until Release B applies 0028.** Release A ships the feature's code, but every saved-recipient
action answers `RECIPIENTS_UNAVAILABLE` until `schema_migrations` holds the exact certified 0028, and Credentials → Saved recipients shows
"Saved recipients are not available on this deployment yet." Nothing creates the table at runtime.

## Identities

| | Version | Name | SHA-256 |
| --- | --- | --- | --- |
| Base (current `main`) | 27 | `reconciliation_privacy` | `6edd545c5f7076aa85468c52e79a198df187af71001793695675527f5f96c069` |
| Certified by Release A, shipped by Release B | 28 | `saved_recipients` | `ee73e909b6747c47c0bca877c8621d55229348177f0e7c6d68e47000a8fca64f` |

Assessment: [SCHEMA-COMPATIBILITY.md §20](./SCHEMA-COMPATIBILITY.md#20-certificate-0028_saved_recipients). Additive: one new table,
`flofi_account_recipients` (an account's saved names for PUBLIC addresses), with a foreign key to `flofi_accounts ON DELETE CASCADE`; nothing
pre-existing changes. The exact bytes are `packages/cloud-runtime/test/fixtures/0028_saved_recipients.sql`.

What a saved recipient is: a name and a public address, scoped to one account and tenant. It is never a key, a delegation, an allowlist entry
or proof of ownership; its "Your account wallet" / "Connected" status is derived at read time from verified wallets. Review shows the full
bound address and, display only, the saved name beside it. Deleting the account deletes its saved recipients (cascade).

## Configuration

**No variable is required** in either release.

## Release A — this pull request (certificate; no migration)

Contents: the certificate `{ base: 0027 reconciliation_privacy, migrations: [0028 saved_recipients] }` in
`packages/cloud-runtime/src/migrations.ts`, the fixture with the exact bytes, `packages/cloud-runtime/test/certificate-0028.pg.test.ts`,
SCHEMA-COMPATIBILITY §20, and the saved-recipient code (store, server actions, in-memory client store, Credentials section, Review name tag)
that stays dark until 0028 exists. `SHIPPED_MIGRATIONS` stays at 27, and `packages/cloud-runtime/migrations/` is unchanged.

1. Merge and deploy normally. Railway API, Railway worker and Vercel Production deploy from `main`; the API pre-deploy
   (`node apps/reference-dapp/backend/main.ts migrate`) is a no-op (`migrate.applied versions=none schema_version=27`).
2. Verify (read-only), before any Release B work: the exact Release A commit is actively serving in **every** consumer (Vercel Production,
   Railway API, Railway worker); the API's `/readyz` is healthy and the worker processes work (deploy and startup logs); the schema is still 27
   (`SELECT max(version) FROM schema_migrations` → 27); signed in, Credentials → Saved recipients shows the "not available on this deployment
   yet" note and nothing else.

A build that ships 0028 on a database at 27 refuses every database-backed feature (`SCHEMA_NOT_MIGRATED`), and a build without this
certificate refuses a database at 28 (`MIGRATION_HISTORY_MISMATCH`). So Release B must not start until step 2 holds everywhere.

## Release B — later, owner-run (ships 0028)

### Prepare the Release B pull request

1. Copy the certified bytes unchanged:
   `cp packages/cloud-runtime/test/fixtures/0028_saved_recipients.sql packages/cloud-runtime/migrations/0028_saved_recipients.sql`, then
   `sha256sum packages/cloud-runtime/migrations/0028_saved_recipients.sql` must print `ee73e909b6747c47c0bca877c8621d55229348177f0e7c6d68e47000a8fca64f`.
   Keep the fixture (certificates and their fixtures are never removed). If the SQL must change, stop: it needs a new certificate and a new
   Release A.
2. Append to `SHIPPED_MIGRATIONS` in `packages/cloud-runtime/src/migrations.ts`:
   `{ version: 28, name: 'saved_recipients', sha256: 'ee73e909b6747c47c0bca877c8621d55229348177f0e7c6d68e47000a8fca64f' }` (with a one-line
   comment). Leave the certificate as it is. `migration-manifest.test.ts` and `forward-compatibility.test.ts` then check the file, the shipped
   entry and the certificate agree byte for byte.
3. Add `packages/cloud-runtime/test/saved-recipients-migration.pg.test.ts`, modelled on `reconciliation-privacy-migration.pg.test.ts`: the
   shipped bytes equal the fixture; from v27, `migrate` applies `[28]` once; catalog diff (only the new table, its constraints and indexes);
   every earlier row survives; `assertSchemaCompatible(SHIPPED_MIGRATIONS)` reports `{ version: 28, application: 28, forward: [] }`; the v27
   build serves 28 only by certificate; account deletion cascades; the lock-timeout rollback.
4. Slice the suites that assume the head is 27 to the v27 history: in `reconciliation-privacy-migration.pg.test.ts`, `migrate(t.db, all)` (lines
   ~62 and ~116) becomes `migrate(t.db, all.slice(0, 27))`, and the check at line ~75 uses `SHIPPED_MIGRATIONS.slice(0, 27)`. Search the other
   `*.pg.test.ts` for `SHIPPED_MIGRATIONS.at(-1)`, `toEqual([27])` and unsliced `loadMigrations()` that assume head 27, and slice them likewise.
   `certificate-0028.pg.test.ts` already handles both releases.
5. Map the new migration file and test in `docs/engineering/coverage.json` (module `cloud-runtime--data-privacy` owns 0027 today) and run
   `python3 scripts/agent_guard.py check`.
6. Update this document's status and §20's release note; run `pnpm check`, `pnpm test:postgres` (loopback PostgreSQL) and
   `python3 scripts/governance_lite.py`. `apps/reference-dapp/backend/schema-compatibility.pg.test.ts` skips on the v28 head until a 0029
   certificate exists.

### Order: Neon, Railway API, Railway worker, Vercel

Railway API, Railway worker and Vercel Production deploy automatically and concurrently from `main`, and a worker can go live before the API's
pre-deploy has migrated. Use the controlled procedure that 0027 used: **apply 0028 to Neon before merging Release B**, while every consumer
still runs Release A (which serves schema 28 by certificate), then merge.

1. **Neon (before the merge).** Take a Neon branch/snapshot first. Then, in one transaction from an operator shell (never paste the database
   URL into chat or a file in the repository), mirror `migrate()` exactly:

   ```sql
   BEGIN;
   SELECT pg_advisory_xact_lock(7340032001);
   DO $$ BEGIN
     IF (SELECT count(*) FROM schema_migrations) <> 27 OR (SELECT max(version) FROM schema_migrations) <> 27
       OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 27 AND name = 'reconciliation_privacy'
         AND sha256 = '6edd545c5f7076aa85468c52e79a198df187af71001793695675527f5f96c069')
     THEN RAISE EXCEPTION 'LEDGER_NOT_EXACTLY_V27'; END IF;
   END $$;
   -- \i packages/cloud-runtime/migrations/0028_saved_recipients.sql   (its own SET LOCAL lock_timeout = '5s' comes first)
   INSERT INTO schema_migrations (version, name, sha256)
     VALUES (28, 'saved_recipients', 'ee73e909b6747c47c0bca877c8621d55229348177f0e7c6d68e47000a8fca64f');
   COMMIT;
   ```

   Rehearse it on disposable PostgreSQL first (a schema dump must equal applying the file with `migrate`, and a second run must stop at the
   guard). Equivalently, run the Release B branch's own runner (`node apps/reference-dapp/backend/main.ts migrate` with the migration database
   URL in the operator's environment), which applies exactly 0028 under the same advisory lock. If the lock cannot be taken within 5 s (an open
   write on `flofi_accounts`), the transaction rolls back completely and schema 27 keeps serving; retry in a quieter moment.
2. **Verify on Release A (schema 28 by certificate):** `/readyz` healthy on the API; worker logs normal; `SELECT version, name, sha256 FROM
   schema_migrations WHERE version = 28` returns the identity above. Within 30 s, Credentials → Saved recipients becomes available on the
   Release A build (its code is already there).
3. **Merge Release B.** Each consumer then starts on schema 28 in any order; the API pre-deploy is a no-op
   (`migrate.applied versions=none schema_version=28`). Generic order if the controlled procedure is not used: Railway API first (its
   pre-deploy applies 0028 once; check `migrate.applied versions=28`), then the Railway worker, then Vercel Production.

### Verification after Release B (read-only, then one signed-in check)

- `/readyz` healthy on the API; worker startup and processing logs normal; Vercel Production READY on the Release B commit.
- Signed in on a test account: add an EVM and a Solana recipient, rename one, try the same address again (RECIPIENT_EXISTS shows the
  existing name; nothing changes), remove one. A Review whose destination equals a saved address shows " · <name>" after the full address.
- Another account does not see them; signed out, the section offers only sign-in.

### Rollback

- **Application rollback** (any time): redeploy Release A on Railway API, worker and Vercel. It serves schema 28 by certificate and keeps saved
  recipients working (the code is in Release A). Nothing is lost.
- **Do not** roll back to a build older than Release A once 0028 is applied: it refuses schema 28 (`MIGRATION_HISTORY_MISMATCH`).
- **Emergency reversal of 0028** (last resort, owner decision, after every consumer has been rolled back to Release A): it
  **deletes every saved recipient of every account**. Export first if they must be kept
  (`COPY (SELECT * FROM flofi_account_recipients) TO STDOUT WITH CSV HEADER` to a protected location, then delete that export when no longer
  needed). Only when 0028 is the newest row of `schema_migrations`. In one transaction:

  ```sql
  BEGIN;
  SET LOCAL lock_timeout = '5s';
  DO $$ BEGIN
    IF (SELECT max(version) FROM schema_migrations) <> 28 OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 28 AND name = 'saved_recipients'
      AND sha256 = 'ee73e909b6747c47c0bca877c8621d55229348177f0e7c6d68e47000a8fca64f') THEN RAISE EXCEPTION 'NOT_CERTIFIED_0028_HEAD'; END IF;
  END $$;
  DROP TABLE flofi_account_recipients;
  DELETE FROM schema_migrations WHERE version = 28 AND name = 'saved_recipients'
    AND sha256 = 'ee73e909b6747c47c0bca877c8621d55229348177f0e7c6d68e47000a8fca64f';
  COMMIT;
  ```

  `certificate-0028.pg.test.ts` proves this restores the exact v27 catalog and ledger and refuses, unchanged, when anything newer than 0028 is
  applied. After it, Release A answers RECIPIENTS_UNAVAILABLE again (within 30 s), and a Release B build would refuse the database
  (`SCHEMA_NOT_MIGRATED`): run Release A everywhere before reversing.
