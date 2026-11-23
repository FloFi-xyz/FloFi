# FloFi: 0016 runtime-role privilege remediation (BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001, P0)

**Status: prepared and certified in this build. Not applied to production.**

- Applying it is a separate owner action. It needs its own explicit approval (who, when, where), recorded with the evidence below.
- Merging or deploying this build changes no database privilege: no Vercel or Railway deployment runs any part of it.

## The exposure

Migration 0016 (`owner_history_purge`) lets the owner delete, from History, an execution run that provably never reached execution. Its
SHA-256 is `a3c258cadd9d7865ad9d36d63ec0921fc47455bb3651c201074f3b0486b4be6f`, and the migration is immutable and unchanged.

How the deletion works:

- The owner's request goes through the checked procedure `purge_unstarted_execution(text,text,text)` (SECURITY DEFINER).
- The procedure inserts an immutable tombstone (`execution_purge_audit`) and a transaction-scoped permit (`execution_purge_permits`).
- `protect_execution_history()` lets a DELETE of `journal_entries`, `execution_log_segments`, `execution_runs` or `execution_logs` through only
  while a permit of the same transaction names that run or log.

0016 names no role and revokes both tables from PUBLIC only. Where the objects belong to a migration role and the services connect as a separate
runtime role whose table rights come from `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES`, that runtime role
also holds INSERT, UPDATE and DELETE on both private tables. This is FloFi production's model; the 0033 release document records it.

With those rights, the runtime role (any code or credential that connects as it) can do the following without the procedure:

- **Forge a whole deletion.** Insert a tombstone and a permit for any run, a completed one included, then delete its journal, log bytes, run
  and log in the same transaction.
- **Delete another log's bytes with no new tombstone.** Insert a permit that names an existing legitimate tombstone but another log (the
  trigger matches logs by namespace and name), then delete that log's segments, or the whole log.
- **Block an identity forever.** Insert a tombstone for a run that does not exist yet, so its creation answers `EXECUTION_DELETED`.

The application never writes either table directly: only the procedure and the trigger function, both owned by the migration role, do. Owner
History and privacy reports READ the tombstone. All three shapes are reproduced, and then refused, by
`packages/cloud-runtime/test/security-0016-runtime-privileges.pg.test.ts`. That test runs on a disposable PostgreSQL that reproduces the
production model.

**Production state.** The owner's production database was inspected read-only on 2026-11-23 (catalog and count queries only, nothing
changed). Its result (roles, ACLs, counts) belongs in the owner's approval record, not in this repository. The integrity counts are
heuristics: see the blind spots under step 1.

## What the remediation changes

[SECURITY-0016-RUNTIME-PRIVILEGES.sql](./SECURITY-0016-RUNTIME-PRIVILEGES.sql) runs as one transaction and makes these changes:

- `REVOKE ALL ON execution_purge_permits FROM <runtime role>`, and from PUBLIC, as 0016 already declares.
- `REVOKE ALL ON execution_purge_audit FROM <runtime role>`, then `GRANT SELECT` back:
  - removed: INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and, on PostgreSQL 17+, MAINTAIN;
  - column-level grants are removed too;
  - SELECT stays, for History and privacy.
- `GRANT EXECUTE ON FUNCTION purge_unstarted_execution(text,text,text) TO <runtime role>`. Production already grants it; granting it again
  guarantees the legitimate Delete after the change.

Nothing else changes:

- no row is inserted, updated or deleted; the only row read is 0016's ledger entry;
- no other table, function, trigger, role, membership or default privilege changes;
- 0016's bytes and ledger row are untouched;
- 0033's objects are not named.

**Safeguards:**

- `search_path` limited to `pg_catalog, pg_temp`, and every object schema-qualified, so nothing planted in `public` can stand in for a check;
- the migration runner's advisory lock (`7340032001`);
- `lock_timeout 5s`, which also covers the advisory lock;
- `statement_timeout 60s`.

**Refusals before any change:**

- `OWNER_HISTORY_PURGE_0016_NOT_CERTIFIED`: 0016 is missing or is not this exact identity.
- `RUNTIME_ROLE_NOT_FOUND`.
- `RUNTIME_ROLE_IS_SUPERUSER`.
- `RUNTIME_ROLE_IS_OWNER`: the role is the owner or a member of it, so no REVOKE could bind it.
- `RUNTIME_ROLE_OWNS_SCHEMA`: the role owns schema `public` (on PostgreSQL 15+, by owning the database), so it could drop and recreate the
  private tables.
- `MIGRATION_ROLE_REQUIRED`: the connection cannot change the owner's grants.

**Effective-privilege check before COMMIT.** It refuses with `OWNER_HISTORY_PURGE_RUNTIME_PRIVILEGES_OPEN: <what>` and rolls the REVOKEs back
if any of these can still write either table:

- direct grants;
- PUBLIC;
- any role the runtime role belongs to, whether inherited or reachable only by `SET ROLE`, including predefined roles such as
  `pg_write_all_data`.

It also refuses (`SCHEMA_PUBLIC:CREATE`) if the runtime role, or any role it belongs to, can CREATE in schema `public`. A function there whose
argument types match a call more closely would take precedence over the `pg_catalog` function that the SECURITY DEFINER procedure calls.
PostgreSQL 15+ denies it by default. Column-level writes reached through any membership count as writes.

Any error, timeout or lost connection rolls everything back. A rerun changes nothing.

**Default privileges are deliberately unchanged.** Every table the migration role creates later still reaches the runtime role with
INSERT/UPDATE/DELETE. So:

- run this file again on any new environment with a separate runtime role once it is at schema 16 or above (a new project, a rebuild, a
  preview with its own role);
- run it again after any `GRANT … ON ALL TABLES IN SCHEMA public TO <runtime role>`;
- run it again on any Neon branch or restore taken from before the remediation: it carries the previous ACLs;
- a future private table must revoke the runtime role in its own provisioning step, as 0033's did.

## Procedure (owner-approved intervention only)

Preparation:

- Use a reviewed checkout of `main` that contains this build, and run every command from the repository root.
- Run from a single-user operator host: the connection URL appears in psql's process arguments (or use a `PGPASSFILE` / service file).
- Set the direct (unpooled) production `DATABASE_MIGRATION_URL` in the operator shell only. Never commit it, paste it into chat or write it to
  logs.
- Set `RUNTIME_ROLE` to the role the API, worker and web tier connect as. Confirm it from each consumer's `DATABASE_URL` user name, without
  printing the URL.
- **Stop** if any consumer connects as the owner of the objects. No REVOKE can constrain the owner; that is a separate finding.
- Keep the evidence files outside the checkout, for example under `$HOME`.

### 1. Pre-check (read-only)

```sh
psql "$DATABASE_MIGRATION_URL" -X -v ON_ERROR_STOP=1 -v runtime_role="$RUNTIME_ROLE" -f docs/deploy/SECURITY-0016-RUNTIME-PRIVILEGES.verify.sql > "$HOME/0016-before.txt"; echo "exit $?"
```

A non-zero exit (psql answers 3 when a statement fails) means the output file is incomplete: stop.

Expected:

- Section 1: certified `t`.
- Section 5:
  - `runtime_writes_tombstones t`, `runtime_touches_permits t` and `runtime_column_writes t` (the exposure; a table-level write is also a
    column-level one);
  - `runtime_member_writes f`;
  - `runtime_creates_in_public f`;
  - `runtime_execute t`;
  - `public_execute f`.
- Section 7: every count 0 except `tombstones`.

**Stop and investigate first** if any of these holds:

- the identity is different;
- `runtime_member_writes` or `runtime_creates_in_public` is `t`: the file would refuse, and the cause needs its own decision;
- section 7 shows anything but legitimate tombstones.

The counts cannot see every forgery, and this list is not exhaustive (see the verification header): any forgery that also restores every
invariant counted is invisible. Among them:

- deleting a whole log that no run references, under a permit naming an existing tombstone;
- rewriting a log's bytes and updating its recorded length and digest;
- a forged tombstone written together with a forged History event, for a run whose run, log and journal were then deleted completely, or
  for an identity that never existed.

Only the database's own history (point-in-time restore, logs) can rule those out.

### 2. Apply

```sh
psql "$DATABASE_MIGRATION_URL" -X -v ON_ERROR_STOP=1 -v runtime_role="$RUNTIME_ROLE" -L "$HOME/0016-apply.log" -f docs/deploy/SECURITY-0016-RUNTIME-PRIVILEGES.sql; echo "exit $?"
```

`-L` keeps the statements and their results as the apply evidence. Exit 0 with `COMMIT` is the only success.

Expected output, in order:

- `BEGIN`, `SET`, `SET`, `SET` (search path, lock timeout, statement timeout);
- one `pg_advisory_xact_lock` row;
- one `runtime_role_named` row (`t`);
- `DO`;
- `REVOKE` ×4, `GRANT` ×2;
- `DO`;
- one row `t | f | f | t | f`;
- `COMMIT`.

On `canceling statement due to lock timeout`, a migration or a long transaction holds the lock. Nothing changed; retry later. Any other
refusal also changed nothing: record it and stop.

### 3. Post-check (read-only)

Run the same command as step 1, writing `"$HOME/0016-after.txt"`. Expected:

- Section 5: `t | f | f | f | f | f | t | f | f`.
- Section 4:
  - every `runtime` value is `f` except `execution_purge_audit / SELECT`;
  - every `public` value is `f`;
  - MAINTAIN rows are empty on PostgreSQL 16 and `f` on 17 and later.
- Section 3: `execution_purge_audit` shows `<runtime role>=r/<owner>`, and `execution_purge_permits` does not mention the runtime role.
- Section 7: unchanged.

### 4. Functional check

- History lists runs and shows deleted ones as deleted.
- Only on the owner's own runs, and only if the owner wants one deleted:
  - a Delete of an eligible simulated run answers `DELETED`;
  - a Delete of a submitted run answers `RUN_DELETE_REFUSED`.
- For the following hour, the API, worker and Vercel logs show no `permission denied for table execution_purge_*`.

### 5. Evidence

Keep these with the approval reference:

- both verification outputs (role names, ACLs and counts only);
- the apply output and `0016-apply.log`;
- the time and the operator.

Never keep the connection URL.

## Recovery

**During application:** nothing to do.

- The file is one transaction; any refusal, timeout or disconnect leaves the database exactly as before.
- No Neon restore point is needed or recommended. Restoring one would also discard every financial write made since it was taken.

**After application:** no legitimate code path is expected to break.

- The test exercises History's Delete and its tombstone read as the runtime role.
- Privacy access and erasure read the same table with the same plain SELECT, which stays granted. They are not run in the test.

If an unexpected `permission denied for table execution_purge_*` appears in a legitimate path:

1. Set `FLOFI_OWNER_HISTORY=read-only`, the existing switch, so no deletion runs.
2. Only if the owner then decides to restore the previous ACL, knowingly reopening the exposure, run on the migration connection the grants
   that section 3 of `0016-before.txt` shows for the runtime role. With FloFi's default privileges that is
   `GRANT SELECT, INSERT, UPDATE, DELETE ON public.execution_purge_permits, public.execution_purge_audit TO <runtime role>;`
3. Record that decision, and re-run step 3 to show the reopened state.

**After a 0033 reversal or re-application:** nothing changes here.

- 0016's objects are never dropped or recreated, so this remediation stays in force.
- 0033's own provisioning file is still required after every application of 0033.

## Evidence

**`packages/cloud-runtime/test/security-0016-runtime-privileges.pg.test.ts`.** It runs on disposable loopback PostgreSQL 16.15 in development
and on PostgreSQL 18.6 in CI (CircleCI's result for this build is the 18 evidence).

Production model it reproduces:

- a non-superuser migration role owns the database and applies 0001–0036 itself;
- the runtime role has the owner's default privileges and the explicit EXECUTE;
- 0033's provisioning file is applied;
- the owner administers the runtime role without inheriting it.

It proves:

- every exposure shape before the remediation;
- an exact ACL-only diff, with all rows identical;
- idempotency;
- 0033's documented verification unchanged;
- as the runtime role after the remediation:
  - every forgery, tamper, truncate and permit read is refused;
  - plain deletes keep 0016's `APPEND_ONLY_VIOLATION`;
  - History's legitimate Delete still deletes only an eligible run, and still refuses completed and submitting runs and another owner;
- each refusal changes nothing:
  - 0016 absent;
  - an unknown or owning role, and a role that owns schema `public`;
  - a runtime-role connection;
  - an inherited write after the REVOKEs;
  - a table- or column-level write, or CREATE, reachable only by `SET ROLE`, and `pg_write_all_data`;
  - CREATE in `public`, and functions planted in `public` to fake the checks;
  - a 5 s lock timeout;
- the integrity section detects four forgery shapes once committed (a whole run, a log's bytes deleted, a forged tombstone over a live run,
  a log's bytes rewritten without updating its digest).

**Real `psql -v runtime_role=…` run.** During development the two files were also run with real psql on a local production-model database
(pre-check, apply, rerun, post-check); that run is not recorded as an artifact. The test itself substitutes psql's quoting textually.

**Not proven here:**

- the application on Neon production, which is pending the owner's approval;
- that no consumer connects as the owner of the objects (confirm before applying);
- privacy access and erasure run as the runtime role.
