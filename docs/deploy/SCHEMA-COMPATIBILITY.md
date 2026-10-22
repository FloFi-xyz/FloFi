# Schema compatibility during rolling deployments (BUILD-DB-COMPAT-001)

FloFi's services deploy independently — the Railway API (whose pre-deploy step migrates), the Railway worker, and Vercel (embedded
flows, MCP, Developer API, Channels, approvals, Admin) — so for a while the database and a serving build disagree. Until this build,
every process accepted only the **exact** migration set its build ships: once a migration committed, every cold start of the previous
build (a restart, a scale-out, every new serverless instance) refused the database with `MIGRATION_HISTORY_MISMATCH`, however harmless
the migration was.

From BUILD-DB-COMPAT-001 on, a build also serves a **newer** schema when, and only when, the newer migrations are named — by exact
identity — in a reviewed **forward-compatibility certificate** that the build itself carries. Nothing is inferred.

## 1. The contract

| Database (ledger `schema_migrations`) | Application readiness (`assertSchemaCompatible`) | Migration runner (`migrate`) |
| --- | --- | --- |
| exactly this build's history | serves | nothing to apply |
| this build's history, behind | refuses `SCHEMA_NOT_MIGRATED` | applies the pending migrations, one transaction each |
| this build's history, then only migrations this build's certificate names, exactly and in order | **serves** (logs the newer migrations) | **applies nothing, changes nothing, succeeds** |
| any other newer migration (unknown, edited, renamed, out of sequence) | refuses `MIGRATION_HISTORY_MISMATCH` | refuses `MIGRATION_HISTORY_MISMATCH`, changes nothing |
| a known migration edited, missing, renamed or reordered | refuses `MIGRATION_HISTORY_MISMATCH` | refuses `MIGRATION_HISTORY_MISMATCH`, changes nothing |

* **Readiness and permission are separate.** A build may *serve* a certified newer schema; a runner never *changes* a database that is
  ahead of it — not to downgrade, not to "repair", not to re-record. It only ever applies its own pending migrations, under the same
  transaction-scoped advisory lock, one transaction per migration, recorded with its SHA-256 (exactly once, as before).
* **The certificate is the build's, not the database's.** A certificate applies only to a build whose newest shipped migration is the
  certificate's `base` (version, name and SHA-256). A v11 certificate says nothing about the v12 build. An old build can only verify
  bytes it knew when it was built, so the certificate pins every newer migration to its exact SHA-256.
* **Error codes are unchanged** (`SCHEMA_NOT_MIGRATED`, `MIGRATION_HISTORY_MISMATCH`), so readiness, the web's classified errors and
  every client keep their existing behavior. `MIGRATION_CERTIFICATE_INVALID` only appears for a malformed manifest, which the unit
  suite rejects before a build exists.
* **No migration during a user request.** Applications only read the ledger; migrations run only through `main.ts migrate` (Railway
  pre-deploy, the opt-in Vercel Preview build step).
* `assertSchemaCurrent` (strict, exact) is unchanged and still exported; no production path uses it any more.

Where the check runs:

| Path | Services |
| --- | --- |
| `backend/main.ts` `api`, `worker`, `import-journal` | Railway API, Railway worker, operator import |
| `backend/main.ts migrate` | Railway API pre-deploy; Vercel Preview `FLOFI_MIGRATE_ON_BUILD=preview` |
| `src/server/flow-runtime.ts` (embedded runtime) | Vercel embedded flows, MCP tools, `/api/readiness` |
| `src/server/platform-state-host.ts` | MCP OAuth, Developer API, Channels, approvals, Admin (BUILD-ADMIN-001) |
| `backend/developer-admin.ts`, `backend/admin-cli.ts` | Developer and Admin operator CLIs |

**Observability.** On a certified newer schema `main.ts` logs, on `migrate.applied`, `api.starting` and `worker.starting`:
`schema_version` (the database's), `application_schema_version` (the build's) and `forward_migrations` (e.g. `12_admin_control_plane`).
On an exact schema only `schema_version` appears, as before. The web readiness reports the database's `schemaVersion`.

**Tenant registration never waits for a migration.** `ensureTenant` (every Vercel cold start, platform state, the Developer CLI) only
reads an existing tenant. Its previous `INSERT … ON CONFLICT DO NOTHING` took `ROW EXCLUSIVE` on `tenants`, which waits for any
migration adding a foreign key to `tenants` (`SHARE ROW EXCLUSIVE` until that migration commits). Only the first request of a brand-new
tenant (e.g. a new Preview branch) still inserts.

## 2. Certificates

`CERTIFIED_FORWARD_MIGRATIONS` in `packages/cloud-runtime/src/migrations.ts`:

```ts
{ base: { version: 11, name: 'delegated_execution', sha256: '0c6572af…' },              // the build assessed
  migrations: [{ version: 12, name: 'admin_control_plane', sha256: '25556fbf…' }],        // what it may serve on
  assessment: 'docs/deploy/SCHEMA-COMPATIBILITY.md#3-certificate-0012_admin_control_plane' }
```

Rules, enforced by `packages/cloud-runtime/test/forward-compatibility.test.ts`:

* the base is a migration this repository shipped, byte for byte; at most one certificate per base; newer migrations are contiguous
  from `base.version + 1`, with valid names and SHA-256s; the `assessment` anchor exists;
* until a certified migration ships, its exact SQL is a test fixture (`packages/cloud-runtime/test/fixtures/NNNN_name.sql`) whose
  SHA-256 equals the certificate, so the PostgreSQL suites prove the certificate on the real bytes;
* once it ships, the shipped identity must equal the certified one — otherwise every build deployed with that certificate would refuse
  the database the moment the migration is applied;
* certificates are never removed: they are the record of what earlier releases were told to accept.

**Why not a version range, an "additive" flag or a database-side declaration?** A `>=` check, or any rule an old build evaluates on a
migration it has never seen (its name, a flag in the ledger, an environment allowlist), lets an unreviewed change reach code that was
never assessed against it. The only thing an old binary can verify is an identity it already holds, so certification is one release
*ahead*: that is the scalable contract (expand/contract), not a per-migration exception.

### Certifying a future migration (checklist)

1. Write the migration so the previous build's code keeps its meaning: expand only (new tables/columns with defaults, new indexes,
   new triggers on new tables). Never drop, rename, re-type, tighten a constraint the previous build writes against, add a trigger
   or rule to a table it writes, or rewrite data it reads. Bound its locks (`SET LOCAL lock_timeout`), as 0012 does.
2. Freeze its bytes. Add its SQL as `packages/cloud-runtime/test/fixtures/NNNN_name.sql` and a certificate whose `base` is the
   current newest shipped migration — in a release that ships **before** the migration (Release A).
3. Assess it against the previous build, in a section of this document: every object it creates or changes, every query/write of the
   previous build that touches what it changes, the locks it holds and what waits for them. Extend
   `forward-compatibility.pg.test.ts` with its catalog diff (nothing removed or redefined; additions listed) and lock list.
4. `apps/reference-dapp/backend/schema-compatibility.pg.test.ts` then runs automatically for the new certificate: the API and worker
   across the migration, real `main.ts` and CLI cold starts, and every Vercel path on the newer schema.
5. Deploy Release A everywhere, then ship the migration (Release B). If the migration must change after Release A, it needs a new
   certificate and a new Release A: the unit suite fails the migration's PR until the shipped bytes match a deployed certificate.

A change that cannot be expand-only (a rename, a drop, a tightened constraint) is split: expand + dual-write in one release, contract in a
later one once no build depends on the old shape — or deployed with an announced window under the exact rule.

## 3. Certificate 0012_admin_control_plane

**Identity.** `packages/cloud-runtime/migrations/0012_admin_control_plane.sql` of BUILD-ADMIN-001 at `53b1a8b` (read-only input):
9,701 bytes, git blob `50c4c92c`, SHA-256 `25556fbfd8e45acf0e692fc340eee56fa2f064f4106225960d63e3da9c303af2` (raw bytes and the loader's
UTF-8 text hash agree). Fixture: `packages/cloud-runtime/test/fixtures/0012_admin_control_plane.sql`. Assessed against the v11 build at
`fa7816b` (`base`: `11 delegated_execution 0c6572af…`).

**What it creates** (all proven by the catalog diff in `forward-compatibility.pg.test.ts`; nothing pre-existing is removed or
redefined, and no existing row changes):

* tables `admin_principals`, `admin_sessions`, `admin_audit_events` (+ identity sequence), `admin_settings_versions`, `admin_run_facts`,
  with their keys, checks, indexes and transition/append-only triggers (the existing `reject_append_only_mutation()` is referenced,
  not changed);
* functions `admin_principal_transition()`, `admin_session_transition()`, `admin_settings_gapless()`;
* on pre-existing relations, exactly: index `automation_evaluations_at ON automation_evaluations (tenant_id, at)`, and the six internal
  foreign-key triggers PostgreSQL adds on `tenants` for `admin_principals`, `admin_audit_events` and `admin_settings_versions`
  (`RI_FKey_noaction_del/upd`: they fire only when a tenant row is updated or deleted).

**Why the v11 build is unaffected.**

* v11 code never names an `admin_*` object or the new index, runs no DDL at runtime, and enumerates no catalog (its only catalog reads
  are `to_regclass` checks of its own tables).
* `tenants` is only ever inserted (`ensureTenant`); no v11 code updates or deletes a tenant, so the new foreign-key triggers never fire
  for it.
* `automation_evaluations` gains a read index only: no constraint, trigger or default changes; v11 writes and reads keep their meaning
  (query plans may change; results cannot).
* Authentication is unchanged: wallet sessions are stateless sealed cookies; MCP OAuth, Developer keys and approval handoffs live in
  untouched tables; admin sessions are separate tables behind a separate cookie.

**Locks while it is open** (observed with `pg_locks` in `forward-compatibility.pg.test.ts`): `tenants` `SHARE ROW EXCLUSIVE` (the three
foreign keys), `automation_evaluations` `SHARE` (the index build), `AccessShare` on `tenants_pkey`, plus its own new objects and the
ledger row. Nothing else. While it is open, from the same suite:

* never wait: cold-start schema checks, `ensureTenant` of an existing tenant, run writes, journal writes, the work queue, the sweep,
  automation rule updates, evaluation reads — and, by the lock list, every other v11 table (MCP, Developer, Channels, approvals,
  delegated execution);
* wait until it commits: creating a brand-new tenant, every `automation_evaluations` insert/delete — the worker's evaluations, the
  retention delete, **and API owner routes** (automation create/state change/rebind, delegated authorization activate/revoke write an
  evaluation in the same transaction). On a pre-compatibility build, also every cold start (`ensureTenant`'s insert).
* Its own waits are bounded by `SET LOCAL lock_timeout = '5s'`: a long writer on either table makes it fail and roll back whole (the
  Railway pre-deploy fails; the previous deployment keeps serving; redeploy to retry).

**Duration.** See §6 (measured on loopback PostgreSQL 18.6 with a large evaluation history).

**Evidence.** `packages/cloud-runtime/test/forward-compatibility.test.ts` (manifest, fixture identity, decision rule — equal to the
released strict rule when no certificate applies, over 200+ ledger shapes), `packages/cloud-runtime/test/forward-compatibility.pg.test.ts`
(real ledgers, runners, the released `fa7816b` module, catalog diff, lock window, concurrency) and
`apps/reference-dapp/backend/schema-compatibility.pg.test.ts` (API/worker continuity, real process cold starts, Vercel paths).

**Notes for BUILD-ADMIN-001** (read-only findings, nothing changed there): the 0012 header and `docs/deploy/ADMIN.md` §7 say the index
build holds only worker evaluation writes; API owner automation/delegation routes also wait (bounded, see above). Correct `ADMIN.md`,
not the SQL: the comment is part of the certified bytes, and any edit to 0012 needs a new certificate and a new Release A. With this build
deployed, `ADMIN.md` §7's "a pre-0012 build refuses the newer schema on every cold start" applies only to builds older than this one,
and `src/admin/rollout.pg.test.ts`'s "previous build refuses on a cold start" checks the strict `assertSchemaCurrent` (still true), not
what a deployed compatibility build does. (Addressed when BUILD-ADMIN-001 was rebased onto this build: `ADMIN.md` §7.2 lists the API
owner routes, §7.4 the rollback rule, and `rollout.pg.test.ts` asserts that the certified build serves and cold-starts after 0012.)

## 4. Rollout

### Release A — this build (database stays at 0011)

1. Owner merges BUILD-DB-COMPAT-001. Railway `flofi-api` pre-deploy logs `migrate.applied versions=none schema_version=11`; API and
   worker log `*.starting schema_version=11`. Vercel builds and serves as usual. Nothing user-facing changes.
2. Make sure **every** process that can reach the production database runs Release A (or later) before 0012 is applied:
   * Railway: the active `flofi-api` and `flofi-worker` deployments are at (or descend from) the Release A merge commit, and no
     older deployment is still draining;
   * Vercel: the Production deployment's commit (`/api/readiness` → `deployment.commit`) descends from Release A. Older production
     deployments stay reachable by their own URLs and are not patched: don't use them after 0012. Any Preview or other environment
     whose `DATABASE_URL` is the production database must be rebuilt from Release A or later (or will refuse after 0012, as today);
   * operator CLIs (`developer-admin.ts`, `admin-cli.ts`, `import-journal`) are run from a Release A (or later) checkout.
3. Soak: readiness `READY`, API `/readyz`, normal traffic. Keep the database at 0011 throughout Release A.

### Release B — BUILD-ADMIN-001

1. Rebase BUILD-ADMIN-001 onto `main` with Release A. `forward-compatibility.test.ts` proves its shipped 0012 is the certified one
   (if it is not, stop: re-certify in a new Release A first). Run the combined gates (`pnpm check`, `pnpm test:postgres`, browser
   `admin-console`, governance). `schema-compatibility.pg.test.ts` skips itself in the combined build (no certificate for v12 yet).
   If Preview builds migrate (`FLOFI_MIGRATE_ON_BUILD=preview`), the PR's own Preview build applies 0012 to the shared Preview
   database as soon as it builds: Previews of branches without Release A then refuse platform state on cold starts — rebase them.
   From BUILD-ADMIN-001 on, a Preview build refuses, changing nothing, to migrate a database holding non-Preview state
   (`PREVIEW_DATABASE_NOT_DEDICATED`, `ADMIN.md` §7.5), so a Preview pointed at Production's database by mistake cannot apply 0012 there.
2. Prepare without exposing: Vercel Production env per `ADMIN.md` §2; turn off *Auto-assign Custom Production Domains* (or deploy with
   `vercel deploy --prod --skip-domain`) so the merge builds a staged deployment. Recommended: turn off auto-deploy on `flofi-worker`
   for this release so the new worker starts after the migration (otherwise it exits `SCHEMA_NOT_MIGRATED` and restarts until 0012 is
   in — durable work waits, nothing is lost).
3. Owner merges. Railway `flofi-api` pre-deploy applies 0012 (`migrate.applied versions=12 schema_version=12`). From this commit on, the
   Release A API replicas, worker and Vercel production keep serving and cold-starting (`forward_migrations=12_admin_control_plane`
   in Railway logs; readiness `schemaVersion: 12`). If the pre-deploy fails with `55P03`, a long transaction held `tenants` or
   `automation_evaluations`: the migration rolled back whole; redeploy.
4. The new API starts (`api.starting schema_version=12`); deploy `flofi-worker` (`worker.starting schema_version=12`).
5. Promote the staged Vercel deployment (`vercel promote <url>`). Re-enable auto-assignment / worker auto-deploy if desired.
6. Validate: `/readyz`, `/api/readiness` (`READY`, schema 12), an owner run (Simulate → Review → wallet → reconciled), worker
   reconciliation and evidence, Channels (Telegram/WhatsApp message → approval link), Developer API, MCP OAuth + approval, `/approve`.
7. Enable and administer the console per `ADMIN.md` §3–§5.

## 5. Recovery and rollback

| Situation | Safe action |
| --- | --- |
| Before 0012 is applied | Any rollback is safe (every build accepts exactly 0011). |
| 0012 applied; Release B misbehaves | Roll the application back to **Release A** (Railway redeploy of the Release A image — its pre-deploy `migrate` succeeds with `versions=none`; Vercel promote/rollback to the Release A deployment). Release A serves on 0012. Disable the console with `FLOFI_ADMIN` unset. |
| 0012 applied; a build **older than Release A** | **Unsafe.** It refuses the database on every cold start. Railway refuses to deploy it (its pre-deploy fails `MIGRATION_HISTORY_MISMATCH`, the current deployment keeps serving); a Vercel rollback to it would make every new function instance refuse platform state and embedded flows. |
| 0012 applied; 0012 itself must go (last resort) | §5.1, only with Release A serving everywhere. |

**The point of no return for unpatched binaries is the commit of migration 0012** (its `schema_migrations` row). From that instant
only builds carrying the 0012 certificate (Release A and every later build) can cold-start. The same holds for each later certified
migration and the builds certified for it. A schema is never rolled back by the runner.

### 5.1 Emergency reversal of 0012 (last resort)

Destroys every admin grant, session, audit event, settings version and analytics fact. Preconditions: every process runs Release A
(which serves on both 0011 and 0012 — never run this while a Release B process serves); owner decision; a backup. One transaction with
bounded locks, run with `psql -v ON_ERROR_STOP=1 -f <file>` on the direct (unpooled) URL; it refuses — changing nothing — unless 0012 is
the newest migration and exactly the certified one:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF (SELECT count(*) FROM schema_migrations WHERE version >= 12) <> 1 THEN
    RAISE EXCEPTION 'REVERSAL_REFUSED: 0012 is not the newest migration';
  END IF;
  DELETE FROM schema_migrations WHERE version = 12 AND name = 'admin_control_plane'
    AND sha256 = '25556fbfd8e45acf0e692fc340eee56fa2f064f4106225960d63e3da9c303af2';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVERSAL_REFUSED: not the certified 0012';
  END IF;
END $$;
DROP TABLE admin_sessions, admin_principals, admin_audit_events, admin_settings_versions, admin_run_facts;
DROP FUNCTION admin_principal_transition(), admin_session_transition(), admin_settings_gapless();
DROP INDEX automation_evaluations_at;
COMMIT;
```

`forward-compatibility.pg.test.ts` runs exactly this block (read from this document): on 0012 it restores the v11 catalog exactly, the
v11 build then sees its exact schema, and 0012 can be applied again; on a tampered or later ledger it refuses and changes nothing.

## 6. Measurements and limits

0012 with the real runner on loopback PostgreSQL 18.6 (CI image), while four probe loops ran: a compatibility-build cold start
(`assertSchemaCompatible` + `ensureTenant`), the released `ensureTenant` insert, a run-table write and an evaluation write. Only the
evaluation history's size matters (the index build); nothing else 0012 touches holds data.

| `automation_evaluations` | 0012 applied in | cold start (this build), max | released `ensureTenant`, max | run write, max | evaluation write, max |
| --- | --- | --- | --- | --- | --- |
| 400,000 rows (86 MB) | 288 ms | 4 ms | 275 ms | 14 ms | 270 ms |
| 2,000,000 rows (431 MB) | 1,636 ms | 4 ms | 1,618 ms | 56 ms | 1,611 ms |

Before Release B, size the history on production (read-only): `SELECT count(*), pg_size_pretty(pg_total_relation_size('automation_evaluations')) FROM automation_evaluations;`.
The runner's 30 s per-statement timeout bounds the index build: a history too large to index within it makes 0012 fail and roll back
whole (no partial schema), which would need a separate decision (e.g. building the index `CONCURRENTLY` beforehand).

**Not covered by the mechanism** (unchanged from before): a ledger row forged by hand passes (the ledger is the record the runner
writes); objects created outside migrations are invisible to the check; query-plan changes from a new index are performance, not
correctness. Zero downtime is demonstrated on loopback PostgreSQL for the API, worker, process cold starts and Vercel code paths; it is
not a measurement of Railway's or Vercel's deployment orchestration, Neon's pooler, or production data volumes.

## 7. Certificate 0013_copilot_learning

The second certificate, written by BUILD-CHAT-LEARNING-001 one release ahead of its migration. **Release A** is the certificate alone (no
feature, no schema change); **Release B** ships the migration and the Copilot learning feature.

**Identity.** `packages/cloud-runtime/migrations/0013_copilot_learning.sql` of BUILD-CHAT-LEARNING-001 (Release B): 12,076 bytes, git blob
`13cbc1e5`, SHA-256 `109be0d34ea5b21ae42b1fda2c4e7fe87254a21ef1264a8235d57e8f1823bfc0`. Fixture: `packages/cloud-runtime/test/fixtures/0013_copilot_learning.sql`.
Assessed against the v12 build at `c46b563` (`base`: `12 admin_control_plane 25556fbf…`, BUILD-ADMIN-001 as merged).

**What it creates** (proven by the catalog diff in `forward-compatibility.pg.test.ts`; nothing pre-existing is removed, redefined or added to):

* tables `learning_subjects`, `learning_memories`, `learning_feedback_events` (+ identity sequence), `learning_candidates`, `learning_candidate_support`,
  `learning_evaluations` (+ identity sequence), `learning_knowledge_versions`, with their keys, checks, indexes and foreign keys **among themselves only**;
* functions `learning_candidate_transition()`, `learning_knowledge_admission()`, and triggers on the new tables only; the existing
  `reject_append_only_mutation()` is referenced by three of them, not changed;
* **nothing on a pre-existing relation**: no foreign key to `tenants` (the tenant id is checked by a `CHECK` instead, so no trigger is added to
  `tenants`), no index, trigger, column or constraint on any existing table.

**Why the v12 build is unaffected.**

* v12 code never names a `learning_*` object, runs no DDL at runtime and enumerates no catalog (its only catalog reads are `to_regclass` checks of
  its own tables).
* No existing table, index, trigger, function or row changes, so every v12 read and write keeps its meaning and its plan.
* Authentication, approvals, executions, Channels, Developer, MCP and Admin state live in untouched tables.

**Locks while it is open** (observed with `pg_locks` in `forward-compatibility.pg.test.ts`): on committed relations, only the ledger
(`schema_migrations`), plus the migration runner's advisory lock and its own new objects. **Nothing waits for it**: v12 cold starts,
`ensureTenant` of an existing **or a brand-new** tenant, run, journal, queue, evaluation, automation and admin writes all proceed while it is open
(unlike 0012, it adds no foreign key to `tenants` and no index on an existing table). Its own waits are bounded by `SET LOCAL lock_timeout = '5s'`.

**Duration.** 21–23 ms with the real runner on loopback PostgreSQL 18.6 (five runs, a v12 database with 400,000 evaluation rows): it creates
empty tables only, so the size of existing data does not matter.

**Evidence.** `forward-compatibility.test.ts` (manifest, fixture identity, decision rule for v12/v13 ledgers),
`forward-compatibility.pg.test.ts` (real ledgers and runners, catalog and data diff, lock window, the reversal below) and
`apps/reference-dapp/backend/schema-compatibility.pg.test.ts`, which runs automatically for this certificate in Release A: API/worker continuity,
real `main.ts` and CLI cold starts and the Vercel paths on the v13 schema.

### 7.1 Rollout

**Release A — this certificate (database stays at 0012).** Owner merges; Railway `flofi-api` pre-deploy logs `migrate.applied versions=none
schema_version=12`; API, worker and Vercel serve as before. Make sure every process that can reach the production database runs Release A or later
before 0013 is applied (Railway `flofi-api` and `flofi-worker` deployments; the Vercel Production deployment, `/api/flofi/readiness` →
`deployment.commit`; any Preview whose `DATABASE_URL` is production's — rebuild it from Release A or later; operator CLIs from a Release A
checkout). Soak with readiness `READY`.

**Release B — BUILD-CHAT-LEARNING-001.** Rebased on Release A, `forward-compatibility.test.ts` proves the shipped 0013 is the certified one.
Railway's pre-deploy applies 0013 (`migrate.applied versions=13 schema_version=13`); from that commit on, Release A processes keep serving and
cold-starting (`forward_migrations=13_copilot_learning`). Learning stays **off** until the owner sets `FLOFI_LEARNING=enabled` and a dedicated
`FLOFI_LEARNING_SECRET` on Vercel (`docs/deploy/LEARNING.md`, Release B).

### 7.2 Recovery and rollback

| Situation | Safe action |
| --- | --- |
| Before 0013 is applied | Any rollback to Release A or later is safe. |
| 0013 applied; Release B misbehaves | Turn learning off (`FLOFI_LEARNING` unset: no memory, glossary or feedback; the Copilot as before), or roll the application back to **Release A** (it serves on 0013; its pre-deploy `migrate` succeeds with `versions=none`). |
| 0013 applied; a build **older than Release A** | **Unsafe**: it refuses the database on every cold start (`MIGRATION_HISTORY_MISMATCH`). |
| 0013 applied; 0013 itself must go (last resort) | §7.3, only with Release A (or a later build without learning) serving everywhere. |

### 7.3 Emergency reversal of 0013 (last resort)

Destroys every learning subject, private memory, feedback event, candidate, evaluation and glossary version. Preconditions: every process runs
Release A (which serves on both 0012 and 0013 — never run this while a Release B process serves); owner decision; a backup. One transaction with
bounded locks, run with `psql -v ON_ERROR_STOP=1 -f <file>` on the direct (unpooled) URL; it refuses — changing nothing — unless 0013 is the newest
migration and exactly the certified one:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF (SELECT count(*) FROM schema_migrations WHERE version >= 13) <> 1 THEN
    RAISE EXCEPTION 'REVERSAL_REFUSED: 0013 is not the newest migration';
  END IF;
  DELETE FROM schema_migrations WHERE version = 13 AND name = 'copilot_learning'
    AND sha256 = '109be0d34ea5b21ae42b1fda2c4e7fe87254a21ef1264a8235d57e8f1823bfc0';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVERSAL_REFUSED: not the certified 0013';
  END IF;
END $$;
DROP TABLE learning_knowledge_versions, learning_evaluations, learning_candidate_support, learning_candidates, learning_feedback_events,
  learning_memories, learning_subjects;
DROP FUNCTION learning_candidate_transition(), learning_knowledge_admission();
COMMIT;
```

`forward-compatibility.pg.test.ts` runs exactly this block (read from this document): on 0013 it restores the v12 catalog exactly, the v12 build
then sees its exact schema, and 0013 can be applied again; on a tampered or later ledger it refuses and changes nothing.

## 8. Certificate 0014_learning_automatic

The third certificate, written by BUILD-CHAT-LEARNING-002 one release ahead of its migration. **Release A** is the certificate alone (no feature,
no schema change); **Release B** ships the migration and invisible Copilot learning (persistent automatic learning off by default).

**Identity.** `packages/cloud-runtime/migrations/0014_learning_automatic.sql` of BUILD-CHAT-LEARNING-002 (Release B): 3,642 bytes, git blob
`a5652964`, SHA-256 `624884d98407383c7093f6a56885ec13001614ddb9e2dcc2ac203451b519314e`. Fixture: `packages/cloud-runtime/test/fixtures/0014_learning_automatic.sql`.
Assessed against the v13 build at `4f377df` (`base`: `13 copilot_learning 109be0d3…`, BUILD-CHAT-LEARNING-001 as merged).

**What it creates** (proven by the catalog diff in `forward-compatibility.pg.test.ts`; nothing pre-existing is removed or redefined):

* tables `learning_automatic_settings` (each verified identity's choice about automatic learning, with the legal basis and notice version it was
  recorded under) and `learning_evidence` (bounded counters of what the identity's own interaction showed about a word), with their keys, checks
  and one index;
* **one addition to an existing relation**: each table has a foreign key `(tenant_id, subject_id) → learning_subjects` with `ON DELETE CASCADE`, which
  adds PostgreSQL's internal referential triggers on `learning_subjects` (four: cascade-delete and no-action-update, per key). No column, index,
  constraint or function of `learning_subjects` changes. The cascade is deliberate: every erasure of a subject — including a v13 process's plain
  `DELETE` on STOP or "delete all" — also erases its 0014 rows.

**Why the v13 build is unaffected.**

* v13 code never names a 0014 object, runs no DDL at runtime and enumerates no catalog.
* Its reads and writes of `learning_subjects` keep their meaning; a `DELETE` now also removes the subject's 0014 rows (its intent: erasure). Its
  retention purge may delete an idle subject that only holds a choice about automatic learning — the same 30-day rule it already applies to subjects
  without consent; the v14 build keeps such subjects (an objection must be honoured), so the window is limited to processes still on Release A.
* Authentication, approvals, executions, Channels, Developer, MCP, Admin and BUILD-CHAT-LEARNING-001 state are untouched.

**Locks while it is open** (observed with `pg_locks` in `forward-compatibility.pg.test.ts`): on committed relations, the ledger (`schema_migrations`)
and `learning_subjects` in `AccessShareLock` and `ShareRowExclusiveLock` (taken by `CREATE TABLE … REFERENCES`). So, for the migration's transaction only, **v13 writes
that create or change a learning subject wait** (an `INSERT`/`UPDATE`/`DELETE` of `learning_subjects`: a first "Remember", a settings change,
`last_seen_at` refresh, an erasure) and proceed when it commits; v13 learning is fail-soft, so a wait is at worst a slower request. Everything else
proceeds while it is open: v13 cold starts, `ensureTenant` (existing or new), runs, journals, the queue, evaluations, admin writes, reading learning
contexts, saving a meaning of an existing subject (its foreign-key check takes a compatible row lock) and feedback events. Its own waits are bounded by
`SET LOCAL lock_timeout = '5s'`.

**Duration.** 12.0–12.6 ms with the real runner on loopback PostgreSQL 18.6 (five runs, a v13 database with 20,000 learning subjects): it creates two
empty tables and their foreign keys (validating a new, empty referencing table does not scan `learning_subjects`), so the size of existing data does
not matter — and it is also the longest a learning-subject write waits.

**Evidence.** `forward-compatibility.test.ts` (manifest, fixture identity, decision rule for v13/v14 ledgers), `forward-compatibility.pg.test.ts` (real
ledgers and runners, catalog and data diff, the cascade under a v13 erasure, lock window, the reversal below) and
`apps/reference-dapp/backend/schema-compatibility.pg.test.ts`, which runs automatically for this certificate in Release A: API/worker continuity, real
`main.ts` and CLI cold starts and the Vercel paths on the v14 schema.

### 8.1 Rollout

**Release A — this certificate (database stays at 0013).** Owner merges; Railway `flofi-api` pre-deploy logs `migrate.applied versions=none
schema_version=13`; API, worker and Vercel serve as before. Make sure every process that can reach the production database runs Release A or later
before 0014 is applied (Railway `flofi-api` and `flofi-worker`; the Vercel Production deployment, `/api/flofi/readiness` → `deployment.commit`; any
Preview whose `DATABASE_URL` is production's — rebuild it from Release A or later; operator CLIs from a Release A checkout). Soak with readiness `READY`.

**Release B — BUILD-CHAT-LEARNING-002.** Rebased on Release A, `forward-compatibility.test.ts` proves the shipped 0014 is the certified one. Railway's
pre-deploy applies 0014 (`migrate.applied versions=14 schema_version=14`); from that commit on, Release A processes keep serving and cold-starting
(`forward_migrations=14_learning_automatic`). Persistent automatic learning stays **off** until the owner sets `FLOFI_LEARNING_AUTOMATIC` after the
legal decision (`docs/deploy/LEARNING.md`).

### 8.2 Recovery and rollback

| Situation | Safe action |
| --- | --- |
| Before 0014 is applied | Any rollback to Release A or later is safe. |
| 0014 applied; Release B misbehaves | Unset `FLOFI_LEARNING_AUTOMATIC` (nothing more is stored) or `FLOFI_LEARNING` (the Copilot as before), or roll the application back to **Release A** (it serves on 0014; its pre-deploy `migrate` succeeds with `versions=none`). |
| 0014 applied; a build **older than Release A** | **Unsafe**: it refuses the database on every cold start (`MIGRATION_HISTORY_MISMATCH`). |
| 0014 applied; 0014 itself must go (last resort) | §8.3, only with Release A (or a later build without automatic learning) serving everywhere. |

### 8.3 Emergency reversal of 0014 (last resort)

Destroys every automatic-learning choice and all evidence (BUILD-CHAT-LEARNING-001's memories, subjects, glossary and history stay; meanings that were
learned automatically remain as saved meanings — erase them first in `/admin/ai-learning` with *Erase automatic-learning data the current basis does
not cover* under `FLOFI_LEARNING_AUTOMATIC=off` if they must go too). Preconditions: every process runs Release A (which serves on 0013 and 0014 —
never run this while a Release B process serves); owner decision; a backup. One transaction with bounded locks, run with
`psql -v ON_ERROR_STOP=1 -f <file>` on the direct (unpooled) URL; it refuses — changing nothing — unless 0014 is the newest migration and exactly the
certified one:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF (SELECT count(*) FROM schema_migrations WHERE version >= 14) <> 1 THEN
    RAISE EXCEPTION 'REVERSAL_REFUSED: 0014 is not the newest migration';
  END IF;
  DELETE FROM schema_migrations WHERE version = 14 AND name = 'learning_automatic'
    AND sha256 = '624884d98407383c7093f6a56885ec13001614ddb9e2dcc2ac203451b519314e';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVERSAL_REFUSED: not the certified 0014';
  END IF;
END $$;
DROP TABLE learning_evidence, learning_automatic_settings;
COMMIT;
```

`forward-compatibility.pg.test.ts` runs exactly this block (read from this document): on 0014 it restores the v13 catalog exactly (the referential
triggers on `learning_subjects` go with the tables), the v13 build then sees its exact schema, and 0014 can be applied again; on a tampered or later
ledger it refuses and changes nothing.

## 9. Certificate 0015_workflow_runs

Written by BUILD-CHAT-E2E-001 one release ahead of its migration. **Release A** is the certificate alone (the `CERTIFIED_FORWARD_MIGRATIONS` entry, the
fixture `packages/cloud-runtime/test/fixtures/0015_workflow_runs.sql`, this section and the `forward-compatibility` tests); **Release B** ships the
migration and workflow runs (off by default: `FLOFI_WORKFLOW_RUNS`).

**Identity.** `packages/cloud-runtime/migrations/0015_workflow_runs.sql`: 14,967 bytes, git blob `818bc3ef`, SHA-256
`5dfefcf7465d874da5880ae5a082f7f47e28ede51adfdef46dbbe3e3f7ba945f`. Assessed against the v14 build (`base`: `14 learning_automatic 624884d9…`).

**What it creates and changes** (the catalog diff in `forward-compatibility.pg.test.ts` lists every item):

* new tables `workflow_runs`, `workflow_run_steps`, `workflow_run_events` with their checks, indexes, forward-only triggers and functions;
* **changes to pre-existing relations** (unlike 0012–0014): `delegated_authorizations.rule_id`, `delegated_executions.rule_id` and
  `delegated_executions.occurrence_id` become nullable; each table gains a nullable `workflow_run_id`, an exclusive-source check, a foreign key to
  `workflow_runs`, a uniqueness rule and a column-scoped trigger that fires only when `workflow_run_id` itself is written; the foreign keys of
  `workflow_runs` add PostgreSQL's internal referential triggers on `tenants` and `mcp_handoffs`. No pre-existing function, trigger or index is redefined.

**Why the v14 build is unaffected.** v14 code never names a 0015 object. Every row it writes has a rule (and occurrence) and a null
`workflow_run_id`, so it satisfies every new check; it never updates `workflow_run_id`, so the new trigger never fires for it. A v14 process could
only read a row with a null rule if a Release B process created a delegated workflow run, which needs `FLOFI_DELEGATION` and a signer provider —
off in standard production. **Do not enable delegated workflow runs until every process runs Release B.**

**Locks while it is open** (observed with `pg_locks`): `delegated_authorizations` and `delegated_executions` in `AccessExclusiveLock` (every delegated
read or write waits), `mcp_handoffs` and `tenants` in `ShareRowExclusiveLock` (approval-handoff writes and a brand-new tenant wait). Cold starts,
runs, journals, the queue and handoff reads proceed. Its own waits are bounded by `SET LOCAL lock_timeout = '5s'`.

**Duration** (`migration-0015-scale.pg.test.ts`, 2026-10-22). Measured on loopback PostgreSQL 18.6 (the CI-pinned image) on a WSL2 workstation,
with default durability. Each database held N synthetic v14 delegated lineages: delegated rule → occurrence → authorization → revision →
execution → budget entry. "Blocked" is how long each lock is held, from acquisition to commit:

| Lineages | Delegated tables | Total | Delegated `ALTER`s | Handoff/tenant writes blocked | Delegated reads/writes blocked | §9.3 reversal | Re-application |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 80 KB | 28 ms | 4 ms | 21 ms | 9 ms | 11 ms | 21 ms |
| 10,000 | 13 MB | 40 ms | 17 ms | 33 ms | 21 ms | 18 ms | 40 ms |
| 100,000 | 140 MB | 164 ms | 132 ms | 157 ms | 145 ms | 90 ms | 188 ms |

The cost is the validation scans of the new checks and foreign keys and the build of the two new unique indexes, all linear in the delegated
tables. With no competing session, the migrator never waited on a lock: 0 ms longest observed wait, sampled about 800 times per run.

Production hardware differs, so read these as orders of magnitude. Before Release B, read the production row counts
(`SELECT count(*) FROM delegated_authorizations` and the same for `delegated_executions`). Delegation is off by default, and hosted deployments
have no signer provider.

**When it cannot get a lock.** Each lock wait is bounded by `SET LOCAL lock_timeout = '5s'`. Behind a session that holds a delegated table
longer than that, 0015 fails with `55P03` after about 5.0 s, at every size measured. It rolls back completely: the v14 catalog, ledger and rows
are unchanged.

While it waits, it keeps the locks it already took. Approval-handoff writes, a new tenant, and delegated reads and writes queue behind it for
up to that wait (about 4.5 s in the measurement). Runs, journals, the queue and handoff reads do not wait.

A failure anywhere in the script also rolls back every earlier `ALTER`, because it is one transaction. Concurrent runners serialize on the
runner's advisory lock and apply it exactly once. All of this is in `forward-compatibility.pg.test.ts`.

### 9.1 Rollout

Preconditions:

- **The production schema is exactly v14 (`14 learning_automatic`).** Read it from the API's `api.starting` or `migrate.applied` log.
- **No running build is older than Release A.** On 2026-10-22, flofi.xyz served `616598f`. Its `cloud-runtime` is identical to `7a844d2`,
  certified up to 0014 only, so it refuses a v15 database.

Order:

1. **Release A everywhere.** Railway `flofi-api` (its pre-deploy `migrate` changes nothing at v14), Railway `flofi-worker`, the Vercel
   Production deployment promoted to flofi.xyz, and operator CLIs.
2. **Apply 0015 while Release A serves.** Deploy Release B to Railway `flofi-api` first. Its pre-deploy logs `migrate.applied versions=15`, then
   check `/readyz`. The worker and Vercel keep running Release A, which serves v15 under this certificate.
3. **Release B on `flofi-worker`.** If Railway deploys both services from one `main` push, a Release B worker that starts before the
   migration exits with `SCHEMA_NOT_MIGRATED` and is restarted (`restartPolicyType: ALWAYS`) until 0015 lands. If 0015 fails, roll the worker
   back to Release A.
4. **Promote Release B on Vercel Production.** The project has `autoAssignCustomDomains: false`, so building from `main` does not change
   flofi.xyz.
5. **Keep workflow runs off.** `FLOFI_WORKFLOW_RUNS` stays unset until the owner enables it.

**Previews share the production database.** On 2026-10-22 Vercel's `DATABASE_URL` targeted Preview and Production together, and Previews have
no `API_BASE_URL`, so they run the embedded backend on production data. A Release B Preview created before 0015 fails closed:
`SCHEMA_NOT_MIGRATED`, writing nothing; only the Copilot-settings fallback reads. After 0015:

- Previews of builds older than Release A refuse the database (`MIGRATION_HISTORY_MISMATCH`);
- Release B Previews read and write production data, as every Preview already does. With `FLOFI_WORKFLOW_RUNS` unset they refuse sequences.

Isolating the Preview database is a separate security task.

The Vercel build migrates only with `FLOFI_MIGRATE_ON_BUILD=preview`, which is set only for two old branches, and this branch's build refuses
a non-dedicated database (`PREVIEW_DATABASE_NOT_DEDICATED`). An older runner never changes a newer database: it is a no-op under its
certificate and fails closed without one.

### 9.2 Recovery and rollback

| Situation | Safe action |
| --- | --- |
| Before 0015 is applied | Any rollback to Release A or later is safe. |
| 0015 fails to apply (lock timeout, error) | Nothing changed (one transaction). The API keeps its previous deployment, because the pre-deploy failed. Keep, or roll back, the worker and Vercel on Release A, since Release B refuses v14. Redeploy the API once the blocking session ends. |
| 0015 applied; Release B misbehaves | Unset `FLOFI_WORKFLOW_RUNS`, or roll back to Release A (it serves on 0015). |
| 0015 applied; a build **older than Release A** | **Unsafe**: it refuses the database (`MIGRATION_HISTORY_MISMATCH`). |
| 0015 itself must go (last resort) | §9.3, only with Release A serving everywhere and no delegated workflow-run authorization. |

### 9.3 Emergency reversal of 0015 (last resort)

Destroys every workflow run. Refuses — changing nothing — unless 0015 is the newest, certified migration and no delegated authorization or execution
has a workflow run as its source:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF (SELECT count(*) FROM schema_migrations WHERE version >= 15) <> 1 THEN
    RAISE EXCEPTION 'REVERSAL_REFUSED: 0015 is not the newest migration';
  END IF;
  DELETE FROM schema_migrations WHERE version = 15 AND name = 'workflow_runs'
    AND sha256 = '5dfefcf7465d874da5880ae5a082f7f47e28ede51adfdef46dbbe3e3f7ba945f';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVERSAL_REFUSED: not the certified 0015';
  END IF;
  IF EXISTS (SELECT 1 FROM delegated_authorizations WHERE workflow_run_id IS NOT NULL) OR EXISTS (SELECT 1 FROM delegated_executions WHERE workflow_run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'REVERSAL_REFUSED: delegated workflow runs exist';
  END IF;
END $$;
DROP TRIGGER delegated_executions_source_immutable ON delegated_executions;
DROP TRIGGER delegated_authorizations_source_immutable ON delegated_authorizations;
DROP FUNCTION delegated_workflow_run_source_immutable();
DROP INDEX delegated_executions_one_per_run;
ALTER TABLE delegated_executions DROP CONSTRAINT delegated_executions_workflow_run, DROP CONSTRAINT delegated_executions_source, DROP COLUMN workflow_run_id,
  ALTER COLUMN occurrence_id SET NOT NULL, ALTER COLUMN rule_id SET NOT NULL;
ALTER TABLE delegated_authorizations DROP CONSTRAINT delegated_authorizations_workflow_run_owner, DROP CONSTRAINT delegated_authorizations_workflow_run,
  DROP CONSTRAINT delegated_authorizations_source, DROP COLUMN workflow_run_id, ALTER COLUMN rule_id SET NOT NULL;
DROP TABLE workflow_run_events, workflow_run_steps, workflow_runs;
DROP FUNCTION workflow_run_transition(), workflow_run_step_transition(), workflow_run_append_only();
COMMIT;
```
