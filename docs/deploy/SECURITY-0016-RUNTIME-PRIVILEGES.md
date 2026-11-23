# FloFi: 0016 runtime-role privilege remediation (BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001, P0)

Status: **prepared and certified in this build; NOT applied to production.** Applying it is a separate owner action that needs its own explicit
approval (who, when, where), recorded with the evidence below. Merging or deploying this build changes no database privilege: Vercel and
Railway deployments run no part of it.

## The exposure

Migration 0016 (`owner_history_purge`, SHA-256 `a3c258cadd9d7865ad9d36d63ec0921fc47455bb3651c201074f3b0486b4be6f`, immutable and unchanged) lets the
owner delete, from History, an execution run that provably never reached execution, through the checked procedure
`purge_unstarted_execution(text,text,text)` (SECURITY DEFINER). The procedure inserts an immutable tombstone (`execution_purge_audit`) and a
transaction-scoped permit (`execution_purge_permits`); `protect_execution_history()` lets a DELETE of `journal_entries`, `execution_log_segments`,
`execution_runs` or `execution_logs` through only while a permit of the same transaction names that run or log.

0016 names no role and revokes both tables from PUBLIC only. In FloFi production the objects belong to the migration role and the runtime role
receives table rights through `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES`, so the runtime role also holds INSERT,
UPDATE and DELETE on both private tables. With them, the runtime role (any code or credential that connects as it) can, without the procedure:

- **forge a whole deletion**: insert a tombstone and a permit for any run, a completed one included, then delete its journal, log bytes, run and
  log in the same transaction;
- **delete another run's log bytes with no new tombstone**: insert a permit that names an existing legitimate tombstone but another run's log (the
  trigger matches logs by namespace and name), then delete that log's segments;
- **block an identity forever**: insert a tombstone for a run that does not exist yet (`EXECUTION_DELETED` on creation).

The application never writes either table directly (only the procedure and the trigger function, both owned by the migration role, do).
Owner History and privacy reports READ the tombstone. All three shapes are reproduced, and then refused, by
`packages/cloud-runtime/test/security-0016-runtime-privileges.pg.test.ts` on a disposable PostgreSQL that reproduces production's model.

## Production state (read-only catalog inspection, 2026-11-23, Neon project `Flofi`, branch `production`, PostgreSQL 18.6)

No privilege, row or setting was changed; only catalog and count queries ran, as the database owner.

| Fact | Value |
| --- | --- |
| Ledger | head 36; version 16 = `owner_history_purge` with the certified SHA-256 |
| Login roles | `flofi_owner` (owns every object, member of `neon_superuser`) and `flofi_runtime` (not superuser, `INHERIT`, member of no role) |
| `execution_purge_permits` ACL | `flofi_owner=arwdDxtm`, **`flofi_runtime=arwd`** |
| `execution_purge_audit` ACL | `flofi_owner=arwdDxtm`, **`flofi_runtime=arwd`** |
| `purge_unstarted_execution` | owner `flofi_owner`, SECURITY DEFINER, EXECUTE `flofi_owner`, `flofi_runtime`; PUBLIC none |
| Default privileges | `flofi_owner` in `public`: tables `flofi_runtime=arwd`, sequences `flofi_runtime=rwU` (plus Neon's own `cloud_admin` → `neon_superuser`) |
| PUBLIC on the two tables | none |
| 0033's `workflow_run_purge_*` | already closed (runtime: SELECT on the tombstone only, nothing on permits) |
| Connections observed | `flofi_runtime` as `flofi-worker`; no consumer seen as `flofi_owner` (the one owner session was this inspection) |
| Exposure | **active**: `runtime_writes_tombstones = t`, `runtime_touches_permits = t` |
| Integrity at rest | `open_permits 0`, `tombstones 9`, `tombstones_without_history_event 0`, `logs_missing_segments 0`, `runs_without_log 0`, `journals_with_gaps 0` (167 runs, 283 logs, 207 journal entries) |

No sign of exploitation was found, which is not proof: a careful forger could also have written the History event. The API and the web tier
were not connected at the instant of inspection. Production has exactly two login roles, and the 0033 activation records that the API, worker and
web tier connect as the runtime role. Before applying, confirm the role in each consumer's `DATABASE_URL` without printing the URL (for example
the user part only). A consumer connecting as `flofi_owner` would keep every right by ownership; no REVOKE can constrain the owner, and that
would be a separate finding.

## What the remediation changes

[SECURITY-0016-RUNTIME-PRIVILEGES.sql](./SECURITY-0016-RUNTIME-PRIVILEGES.sql), one transaction:

- `REVOKE ALL ON execution_purge_permits FROM <runtime role>` (and from PUBLIC, as 0016 already declares);
- `REVOKE ALL ON execution_purge_audit FROM <runtime role>` then `GRANT SELECT` back: INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and,
  on PostgreSQL 17+, MAINTAIN are gone, column-level grants included; SELECT stays for History and privacy;
- `GRANT EXECUTE ON FUNCTION purge_unstarted_execution(text,text,text) TO <runtime role>`: already held in production, granted again so the
  legitimate Delete is guaranteed after the change.

Nothing else: no row, no other table, function, trigger, role, membership or default privilege; 0016's bytes and ledger row are untouched; 0033's
objects are not named. Safeguards: the migration runner's advisory lock (`7340032001`), `lock_timeout 5s` (also for the advisory lock),
`statement_timeout 60s`, and refusals before any change:

- `OWNER_HISTORY_PURGE_0016_NOT_CERTIFIED`: 0016 is missing or not this exact identity;
- `RUNTIME_ROLE_NOT_FOUND`;
- `RUNTIME_ROLE_IS_SUPERUSER`;
- `RUNTIME_ROLE_IS_OWNER`: the role is the owner or a member of it, so no REVOKE could bind it;
- `MIGRATION_ROLE_REQUIRED`: the connection cannot change the owner's grants.

Before COMMIT it checks the effective result: direct grants, PUBLIC, inherited memberships and predefined roles such as `pg_write_all_data`. On
any residual privilege it refuses with `OWNER_HISTORY_PURGE_RUNTIME_PRIVILEGES_OPEN: <what>` and rolls the REVOKEs back. Any error, timeout or
lost connection rolls everything back. A rerun changes nothing.

Default privileges are deliberately unchanged: every table the migration role creates later still reaches the runtime role with `arwd`. A future
private table must revoke the runtime role in its own provisioning step, as 0033's did and this file does for 0016.

## Procedure (owner-approved intervention only)

From a reviewed checkout of `main` that contains this build, with the direct (unpooled) production `DATABASE_MIGRATION_URL` set in the operator
shell only (never committed, pasted into chat, or written to logs), and `RUNTIME_ROLE=flofi_runtime` after confirming the consumers' role:

1. **Pre-check (read-only):**

   ```sh
   psql "$DATABASE_MIGRATION_URL" -X -v ON_ERROR_STOP=1 -v runtime_role="$RUNTIME_ROLE" -f docs/deploy/SECURITY-0016-RUNTIME-PRIVILEGES.verify.sql > 0016-before.txt
   ```

   Expected now: section 1 certified `t`; section 5 `runtime_writes_tombstones t`, `runtime_touches_permits t`, `runtime_execute t`,
   `public_execute f`; section 7 as in the table above. **Stop** on any other identity, or if section 7 shows anything but legitimate tombstones,
   and investigate first.
2. **Apply:**

   ```sh
   psql "$DATABASE_MIGRATION_URL" -X -v ON_ERROR_STOP=1 -v runtime_role="$RUNTIME_ROLE" -f docs/deploy/SECURITY-0016-RUNTIME-PRIVILEGES.sql
   ```

   Expected: `REVOKE ×4`, `GRANT ×2`, `DO`, one row `t | f | f | t | f`, `COMMIT`. On `canceling statement due to lock timeout` (a migration or
   long transaction holds the lock) nothing changed: retry later. Any other refusal changed nothing; record it and stop.
3. **Post-check (read-only):** the same command as step 1, writing `0016-after.txt`. Expected:
   - section 5: `t | f | f | f | t | f | f`;
   - section 4: every `runtime` value `f` except `execution_purge_audit / SELECT`, and every `public` value `f` (MAINTAIN is empty on PostgreSQL
     16 and `f` on 18);
   - section 3: `execution_purge_audit` shows `flofi_runtime=r/flofi_owner`, and `execution_purge_permits` no `flofi_runtime`;
   - section 7 unchanged.
4. **Functional check:** History lists runs and shows deleted ones as deleted. A Delete of an eligible simulated run answers `DELETED`, and one
   of a submitted run answers `RUN_DELETE_REFUSED`; use the owner's own runs, and only if the owner wants one deleted. Over the following hour,
   API, worker and Vercel logs show no `permission denied for table execution_purge_*`.
5. **Evidence to keep with the approval reference:** both verification outputs (they hold role names, ACLs and counts only), the apply output,
   time and operator. Never the connection URL.

## Recovery

- **During application:** nothing to do. The file is one transaction, and every refusal, timeout or disconnect leaves the database exactly as
  before. No Neon restore point is needed or recommended: restoring one would also discard every financial write since it was taken.
- **After application:** no legitimate code path is expected to break (proven: History's Delete, its tombstone read and privacy's reads work as
  the runtime role). If an unexpected `permission denied for table execution_purge_*` appears in a legitimate path, first set
  `FLOFI_OWNER_HISTORY=read-only` (the existing switch: no deletion runs). Only if the owner then decides to restore the exact previous ACL,
  knowingly reopening the exposure:
  `GRANT SELECT, INSERT, UPDATE, DELETE ON execution_purge_permits, execution_purge_audit TO flofi_runtime;`
  Record that decision and re-run step 3 to show the reopened state.
- **After a 0033 reversal or re-application:** nothing changes here. 0016's objects are never dropped or recreated, so this remediation stays in
  force. 0033's own provisioning file remains required after every application of 0033.

## Evidence

- `packages/cloud-runtime/test/security-0016-runtime-privileges.pg.test.ts` (disposable loopback PostgreSQL; CI runs PostgreSQL 18.6, and
  development also ran it on 16.15). The test reproduces production's role model:
  - a non-superuser migration role owns the database and applies 0001–0036 itself;
  - the runtime role has the owner's default privileges and the explicit EXECUTE;
  - 0033's provisioning file is applied;
  - the owner administers the runtime role without inheriting it.

  It proves:
  - every exposure shape before the remediation;
  - an exact ACL-only diff, with all rows identical;
  - idempotency;
  - 0033's documented verification unchanged;
  - after the remediation, every forgery, tamper, truncate and permit read refused for the runtime role, while plain deletes keep 0016's
    `APPEND_ONLY_VIOLATION`;
  - History's legitimate Delete still deleting only an eligible run, still refusing completed and submitting runs, and still refusing another
    owner;
  - each refusal (0016 absent, unknown or owning role, runtime-role connection, inherited write after the REVOKEs, 5 s lock timeout) changing
    nothing;
  - the integrity section detecting both forgery shapes once committed.
- The same two files were also run with the real `psql -v runtime_role=…` on a production-model database (pre-check, apply, rerun, post-check).
- Not proven here: the application on Neon production (pending approval), and that no consumer connects as `flofi_owner` (confirm before
  applying).
