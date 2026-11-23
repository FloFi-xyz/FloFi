# BUILD-FLOFI-DATABASE-LEAST-PRIVILEGE-001

This procedure applies to the certified FloFi schema through 0036 on PostgreSQL
18. It changes access control and row policies in the target database. All 36
migration files, checksums and ledger rows are preserved. The owner activates
the database policy separately from reviewing and merging the application PR.

## Connections and consumers

| Database login | Server-only connection | Consumers |
| --- | --- | --- |
| `flofi_runtime` | `DATABASE_URL` | Railway API, worker and Vercel product server. Shared grants cover execution journals, projections, reconciliation, evidence, queue leases, accounts and wallets, Chat, Editor, Canvas, History, OAuth, MCP and Telegram, Developer API, Studio authoring, Flight and Automations. |
| `flofi_admin_web` | `DATABASE_ADMIN_URL` | Vercel admin console. Reads admin principals and creates/revokes sessions. Writes settings, support notes and audit events, records financial sync requests, reviews Studio and reads operational dashboards. |
| `flofi_admin_operations` | `DATABASE_ADMIN_OPERATIONS_URL` | Trusted operator shell for `admin-cli.ts`, `developer-admin.ts` and `flight-admin.ts`. Includes admin provisioning, privacy requests, retention activation and execution, legal holds, and existing Developer and Flight operations. |
| `flofi_finops_worker` | `DATABASE_FINOPS_WORKER_URL` | Railway worker's optional FinOps loop. Claims and writes billing sync jobs, processes provider snapshots and appends sync evidence. |
| `flofi_owner` | `DATABASE_MIGRATION_URL` | Direct connection in the trusted operator environment. Owns the database and migration objects, runs the existing certified migration commands and applies this policy. Railway pre-deploy uses `check-schema` via `DATABASE_URL`. |

Vercel admin and public requests use separate connection pools in the same
deployment. The optional FinOps loop and the standard worker also use separate
pools in the same process. The policy limits the SQL authority of each login.
Access to the process or its secret store can expose credentials for both pools.
Each deployment keeps its existing tenant selection and application authorization.
Shared runtime SQL privileges cover the union of the product consumers. The DB
logins do not establish row isolation between unrelated tenants by themselves.

## Privilege matrix and audit

[The policy matrix](database-privileges/policy.sql) enumerates all 115 public
tables on version 36 and the necessary privileges for each login. Blank cells
mean no table-level access. The column rows specify narrower INSERT and UPDATE
permissions, including columns needed for authorized row locks and upserts.
Table INSERT into a generated identity column's table uses the identity without
granting direct sequence access.

The handoff snapshot found owner defaults granting runtime SELECT, INSERT,
UPDATE and DELETE on new tables. It measured 111 writable tables before the
ledger correction and expected 110 after it. The 0016 and 0033 tombstones are
read-only and their permit tables are private. Run the catalog comparison below
for the current per-table permissions. It reports effective table and column
access, grant options, role membership and ownership, schema rights, sequences,
routine execution, default ACLs, foreign keys, row policies and triggers.
The snapshot includes metadata and ledger identity and does not include customer rows.

| Boundary | Required access |
| --- | --- |
| Schemas and defaults | Each login has CONNECT and public USAGE. CREATE on persistent schemas is reserved for authorized owners. Owner defaults grant no table, sequence or routine privileges to service logins or PUBLIC. |
| Migration ledger | Each login reads the ledger to verify compatibility. The owner retains migration writes. |
| History and evidence | The runtime maintains live projections and appends history. It reads both purge tombstones and invokes the two existing checked purge functions. Direct DELETE or TRUNCATE on protected history and all direct permit access are denied. Identity and evidence linkage columns on the execution projections remain fixed by the grants. |
| Privacy and support | Admin web appends support text and audit records. The operator manages legal holds and approved retention, requests and erasure. Existing database triggers enforce legal holds and immutable audit records. |
| Shared operational data | Existing account, OAuth, Flight, automation and queue cleanup stays available. MCP handoff cleanup is limited to its existing 30-day retention window. Learning cleanup preserves operator decisions. Runtime audit inserts are limited to account and Developer Console events. |
| Public functions and sequences | The two checked purge routines are the only application routine EXECUTE grants. Installed triggers still fire. All current sequences are generated identities and direct access is denied. |

## Prepare and activate on Neon

1. Rehearse the full sequence on a disposable PostgreSQL 18 instance and an
   isolated Neon environment with matching roles, ownership and schema. Confirm
   the Neon project, branch and database in the owner console before selecting
   the direct endpoint. The handoff names project `wandering-mode-28938220`,
   production branch `br-fragrant-wildflower-b4ulvm7a`, database `flofi`.
   Confirm a restorable point and keep the catalog reports with the release record.
2. Using the direct owner endpoint and a trusted secret mechanism such as
   `PGSERVICE` and a protected passfile, run the read-only audit below. Confirm
   `existing_protections_intact=true`, 36 ledger entries and the expected owner.
   Check the role attributes and direct memberships. The activation requires
   login roles with no parent roles and no elevated attributes or owned objects.
   Investigate catalog drift before changing grants. The prior 0016 and ledger
   corrections should already be present.
3. Create missing logins using SQL on the intended Neon branch. Neon roles created
   in the Console, CLI or API receive membership in `neon_superuser`. Use SQL
   roles, set unique passwords through a trusted provisioning path and supply
   only the connection secrets to their intended consumers. If the existing
   runtime role fails the topology checks, resolve its memberships and ownership
   in the rehearsal before production cutover. [Neon role management](https://neon.com/docs/manage/roles)
4. Run `stage` with the owner connection. It provisions the dedicated logins
   while the current runtime and PUBLIC ACLs keep serving existing deployments.
   Set the admin web URL on the matching Vercel environment and the FinOps URL
   on the worker if the billing loop is enabled. Confirm the DB and tenant are
   the same for all connections within that environment. Keep the operations
   and migration URLs in operator-only environments.
5. Deploy the reviewed application revision and verify it before the ACL cut.
   Confirm Railway pre-deploy reports `schema.compatible` and `/readyz` succeeds.
   Confirm the worker claims/reconciles work and the FinOps loop starts when
   configured. Verify the console can sign in, read analytics and use Support.
   Use read-only operations such as the CLI's `list`, `retention-report`,
   Developer delivery listing and Flight status to verify operator access.
   Verify the preview bootstrap and its branch-derived tenant separately.
   Drain old instances before applying the final privileges.
6. Remove the owner connection secret from Railway service and shared variables
   after the new pre-deploy hook is in use. Retire obsolete deployments and rotate
   the previous owner secret through the normal operator procedure. Verify
   active service variables by name and target role without exporting values.
7. Capture a fresh read-only audit, then run `enforce` as a single transaction.
   The script verifies the exact ledger and expected public tables, checks role
   isolation, replaces grants explicitly and removes owner defaults in both
   global and public-schema scopes. It acquires the migration advisory lock
   and uses a bounded lock timeout. The subsequent assertion runs before commit.
8. Repeat the independent read-only `enforce` verification. Compare the ledger
   with the preflight and repeat the release smoke checks for each login.
   Confirm app metrics and logs show no permission errors or disabled consumers.
   Use approved fixtures for destructive privacy and History tests on the isolated
   environment. Production functional checks can use normal user operations
   that require no wallet transaction.

### Commands

Create only the missing logins using the owner session as authorized. Set each
password with the interactive `psql` password command or through the approved
secret provisioner.

```sql
CREATE ROLE flofi_admin_web LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE flofi_admin_operations LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE flofi_finops_worker LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
```

The statements below use the shell's configured direct owner service. Keep
credentials out of the command line and reports. PostgreSQL 18 and a matching
`psql` client are expected. The optional role settings in `policy.sql` allow
randomized equivalent names in disposable tests.

```sh
# Run from the repository root. To export a report, redirect stdout to a protected file.
acl_dir=docs/deploy/database-privileges
psql -X -P expanded=on -v ON_ERROR_STOP=1 --single-transaction \
  -c "SET TRANSACTION READ ONLY" -c "SET LOCAL flofi_acl.mode = 'audit'" \
  -f "$acl_dir/policy.sql" -f "$acl_dir/verify.sql"

# First use stage. Use enforce only at the authorized cutover after step 6.
acl_mode=stage
psql -X -v ON_ERROR_STOP=1 --single-transaction \
  -c "SET LOCAL flofi_acl.mode = '$acl_mode'" \
  -f "$acl_dir/policy.sql" -f "$acl_dir/apply.sql" -f "$acl_dir/verify.sql"

psql -X -v ON_ERROR_STOP=1 --single-transaction \
  -c "SET TRANSACTION READ ONLY" -c "SET LOCAL flofi_acl.mode = 'enforce'" \
  -f "$acl_dir/policy.sql" -f "$acl_dir/verify.sql"
```

### Recovery and future releases

- Before enforcement, the previous application deployment can still use its
  legacy runtime grants. Keep the legacy protections for the ledger and both
  purge implementations throughout.
- A failed SQL application or verification rolls back the whole transaction.
  Inspect the reported ACL, schema, role or lock discrepancy and retry after
  resolving it. A lock timeout may be caused by an in-flight migration or
  transaction. Let it finish before retrying.
- After enforcement, recover with a release compatible with dedicated logins
  and the current schema, or amend the policy with a reviewed grant for the
  missing operation. Repeat audits and tests. Preserve the protected objects,
  narrow administrative roles and explicit defaults. Re-enabling broad
  defaults, using the owner for a hosted service, or reverting to a binary
  that needs a single privileged runtime connection would undo the isolation.
- A future migration remains an operator one-shot using the direct owner
  connection. Review its ACL changes with the migration and add explicit
  grants for any new object before the feature needs it. The stage/enforce
  application is pinned to the version 36 ledger and rejects inventory drift.
  Compatibility of app rollout and migration ordering remains governed by
  [Schema compatibility](SCHEMA-COMPATIBILITY.md).
