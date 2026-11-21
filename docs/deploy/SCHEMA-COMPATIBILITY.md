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

`CERTIFIED_FORWARD_MIGRATIONS` in `packages/cloud-runtime/src/migrations.ts`. While a build still ships the same base, a later forward migration
**extends** that base's certificate (contiguously) and never edits or removes an identity already certified: 0030, 0031, 0032 and 0033 extended
the base-28 certificate this way, and `forward-compatibility.test.ts` pins the released identities.

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

## 10. Certificate 0016_owner_history_purge

Release A for PR #127 ships migrations through 0015 and explicitly accepts **only** the following additive migration. This certificate does
not apply to the production binary predating #127, which refuses schema 16. Install Release A on every database consumer before applying 0016.

| Base | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0015 `workflow_runs` | 0016 `owner_history_purge` | `a3c258cadd9d7865ad9d36d63ec0921fc47455bb3651c201074f3b0486b4be6f` |

The exact SQL is tested as a fixture in Release A; Release B (#128) ships those same bytes. Migration 0016 adds owner history masks, an immutable
purge audit, conservative transactional purge functions and guards against resurrecting deleted identities. Existing run/log bytes and ordinary
append behavior remain compatible. An old writer attempting to recreate a purged identity is deliberately refused (`EXECUTION_DELETED`).
No new runtime privilege or authorization is granted by this certificate. Schema 16 does not itself delete, archive or authorize anything.

`owner-history-compatibility.pg.test.ts` uses real disposable PostgreSQL to verify 15 → 16, a second Release A process starting on 16, old log
append behavior, actual safe deletion and resurrection refusal. It also injects a migration error and verifies the ledger, DDL and append-only
trigger roll back together. Builds without this certificate and strict schema-15 checks continue to refuse schema 16. The forward-compatibility
suite additionally exercises application behavior against the certified schema ahead.

Rollout and rollback follow [RELEASE-127-128.md](./RELEASE-127-128.md). Before any history mutation, Release A is a schema-compatible rollback
target without dropping 0016. After any archive or deletion, keep the schema-16 history reader/tombstone protections from Release B and set
`FLOFI_OWNER_HISTORY=read-only` to stop new history mutations. Do not roll the frontend or history reader back to an artifact that could expose
archived runs. Do not remove the immutable audit, restore deleted runs or execute a downmigration. Financial observation and reconciliation
must continue during rollback. Changes to the SQL require a new compatibility assessment and hash; this certificate cannot be reused.

## 11. Certificate 0017_copilot_metrics

| Base | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0016 `owner_history_purge` | 0017 `copilot_metrics` | `c20a07de7bb504cbb8d95776796a0e6b412a1130c0539aee3449ceb6f89c45bf` |

Migration 0017 adds one tenant-scoped daily aggregate table. It changes no execution, approval, wallet or existing telemetry table.
Counters contain no transcript, wallet, request/workflow identifier, asset, financial amount or tool arguments. Server interpretation
measurements and untrusted browser turn reports have separate provenance; live and replay records are queried separately. The query
window is at most 90 UTC days; older counters are deleted on accepted writes and Admin reads. This is operational telemetry, not proof
of transaction success. An unavailable telemetry database cannot grant financial authority or interrupt reconciliation.

`copilot-metrics-migration.pg.test.ts` checks exact migration bytes, atomic rollback and a version-16 reader carrying this certificate
starting on schema 17. `copilot-metrics-store.pg.test.ts` checks concurrent increments, tenant isolation, retention and provenance.

Release order remains certificate first: every version-16 database consumer must receive this exact forward certificate before 0017
is applied. The already deployed version-16 artifact does not gain that certificate from a PR. This PR supplies the schema-17 code and
assessment; promotion requires a reviewed certificate-bearing version-16 release followed by the migration-bearing release. No production
migration or release was performed during engineering. Rollback must retain the certificate or use a schema-17 compatible artifact;
do not drop the telemetry table or loosen schema validation to accommodate an older binary.

## 12. Certificate 0018_flofi_accounts

| Base | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0017 `copilot_metrics` | 0018 `flofi_accounts` | `0919a57a5af80a1376ada213bb00ac5db79c434ab7a9ff0ebea50e6a9664ae75` |

Migration 0018 (BUILD-FLOFI-AUTH-WALLETS-001) adds six tenant-scoped tables: `flofi_accounts`, `flofi_account_identities`,
`flofi_account_sessions`, `flofi_account_wallets`, `flofi_account_email_challenges` (attempt counting and throttling; never the code)
and `flofi_account_used_proofs` (SHA-256 digests of accepted ID tokens, for single use). It changes no execution, approval, owner-history, wallet-session, delegation,
automation, saved-workflow or telemetry relation, and defines no function or trigger. The tables hold account identifiers, sign-in
identity subjects (OIDC `sub`, a verified email address or a proven wallet address), revocable session records and public wallet
metadata. CHECK constraints admit no secret: wallet rows hold an address, a provider name, the provider's non-secret resource id and
an export capability; no column can hold a key, seed phrase, OTP, OAuth/OIDC token or password. A version-17 build never reads these
tables, so it runs unchanged on schema 18.

`flofi-accounts-migration.pg.test.ts` checks exact migration bytes, unchanged pre-existing columns, atomic rollback, the
secret-free constraints and a version-17 reader carrying this certificate starting on schema 18. `account-store.pg.test.ts` checks
tenant and account isolation, identity uniqueness (no implicit merge), session revocation and wallet ownership.

Release order remains certificate first: every version-17 database consumer must receive this exact forward certificate before 0018
is applied. This PR supplies the schema-18 code and assessment; promotion requires a reviewed certificate-bearing version-17 release
followed by the migration-bearing release. No production migration or release was performed during engineering. Rollback must
retain the certificate or use a schema-18 compatible artifact; do not drop the account tables or loosen schema validation to
accommodate an older binary. The exact Release A contents, deployment order and rollback table are in
[RELEASE-AUTH-WALLETS-0018.md](./RELEASE-AUTH-WALLETS-0018.md).

## 13. Certificate 0019_privy_accounts

| Base | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0018 `flofi_accounts` | 0019 `privy_accounts` | `aea36e602ba918a195d4bd110fda3b29459816fb76c25e0ddfdd29099847cab6` |

Migration 0019 (BUILD-FLOFI-PRIVY-UX-001) widens four CHECK constraints of two 0018 tables and does nothing else: no table, column,
index, function, trigger or row is added, changed or removed.

- `flofi_account_identities_kind_check` and `flofi_account_identities_check` also admit kind `PRIVY` with a Privy user id
  (`did:privy:` followed by 8–64 letters and digits): the person's Privy user, verified by FloFi's server from a Privy access token.
- `flofi_account_wallets_check2` and `flofi_account_wallets_check3` also admit Privy-managed wallets (`provider = 'privy'`, generated or
  imported), whose export capability is the private key and whose Privy wallet id is optional. The Turnkey rules are unchanged: a
  Turnkey-managed wallet still needs its resource id, and a Turnkey-generated wallet still exports a recovery phrase.

Every row valid under 0018 is valid under 0019 unchanged, so the `ADD CONSTRAINT` validation scans cannot fail on existing data; the
four constraints are replaced in two statements, inside the migration's single transaction, under `lock_timeout = '5s'` (both tables are
small and touched only by account traffic). Still no column can hold a key, seed phrase, OTP, OAuth/OIDC or Privy token or password.

A version-18 build runs unchanged on schema 19, including on rows written by a version-19 build:
- its wallet reader drops a `privy` wallet row (its strict `readAccountWallet` accepts only `turnkey` as a managed provider), so
  such a wallet is neither shown nor offered for signing or export by an old build, and `walletHolder` still refuses to give its address
  to another account;
- a `PRIVY` identity is listed with no kind (its label is the DID); it is never the method of a session (version 19 records sessions
  with the 0018 methods only) and never a FloFi Wallet unlock method, so an old build can neither sign it in nor unlock with it;
- nothing a version-18 build writes can violate a 0019 constraint (the constraints only widened).

`privy-accounts-migration.pg.test.ts` checks the exact bytes, a Turnkey-era account surviving byte for byte with unchanged columns, the
new Privy rows, the 0018 safety rules still refusing unsafe rows, atomic rollback, and a version-18 reader carrying this certificate
starting on schema 19 (and refusing it without the certificate).

Release order is certificate first, as for 0018: every version-18 database consumer must run a build carrying this certificate before
0019 is applied. No production migration or release was performed during engineering. The release steps are in
[RELEASE-PRIVY-0019.md](./RELEASE-PRIVY-0019.md).

## 14. Certificate 0020_flight_flofi

| Base | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0019 `privy_accounts` | 0020 `flight_flofi` | `a7ce1f42753017de90eede9784a205bcd3b6fa0134b26eecb530dc2e505b2892` |

Migration 0020 (BUILD-FLOFI-FLIGHT-001, the Flight FloFi launch campaign at `/board`) adds eight tenant-scoped tables and nothing else:
`flight_batches` (boarding groups and their opening time), `flight_list_entries` (the beta list and the next flight's list: a lower-cased
email, its language and the notice version shown), `flight_join_attempts` (a keyed digest of a client's network, never the address, for
the list form's rate limit; one day), `flight_passes` (one boarding pass per account; Founding seats 1..100, unique), `flight_invites`
(single-use invite codes), `flight_issuance` (per tenant, the boarding numbers and Founding seats ever issued, at most 100 Founding; a
number freed by a deleted account is never reissued), `flight_simulations` (two-hour evidence that an account completed a server-side
simulation: the run and the route the server projected, never an amount) and `flight_daily_events` (content-free daily counters with
closed codes). No pre-existing table, column, constraint, function, trigger, rule, index or row is created, changed or removed.

Objects that reference what exists: the new tables reference `tenants (tenant_id)` and `flofi_accounts (tenant_id, account_id)` by
foreign key (`ON DELETE CASCADE` for an account's pass and simulation evidence; `ON DELETE SET NULL (redeemed_by)` for a redeemed
invite and `SET NULL (issuer_pass_id)` for the invites a deleted pass gave out — the column-list form needs PostgreSQL 15 or later:
production Neon runs 18, CI 18.6). Creating them takes a `SHARE ROW EXCLUSIVE` lock on `tenants` and `flofi_accounts` held until the
migration's transaction commits (milliseconds: the transaction creates empty tables only), under `lock_timeout = '5s'`; meanwhile a
version-19 write to those two tables (a new tenant, a new account, onboarding or organisation updates, an account deletion) waits.
PostgreSQL implements the foreign keys with internal triggers on the referenced tables; these change no result of any statement a
version-19 build runs, except that deleting a FloFi account (the version-19 account deletion) now also deletes that account's Flight
pass and evidence and unlinks its invites, which is the intended erasure. No version-19 query reads or writes a `flight_*` table, so a
version-19 build runs unchanged on schema 20.

Evidence. Release A carries the certificate's unit gate (`forward-compatibility.test.ts`: base identity, fixture digest, this anchor) and
re-activates `backend/schema-compatibility.pg.test.ts` (API and worker across 0020 with live traffic, on the fixture). Release B adds
`flight-flofi-migration.pg.test.ts`, which checks the exact bytes, every pre-existing column, account row, relation, index, trigger and rule
unchanged, the eight new tables, a version-19 reader carrying this certificate starting on schema 20 (and refusing it without the
certificate), a version-19 account deletion succeeding on schema 20 with Flight rows present (pass and evidence deleted, invites
unlinked), and atomic rollback. `apps/reference-dapp/src/flight/store.pg.test.ts` checks the campaign rules on the real tables, including
260 concurrent pass requests for 130 accounts producing exactly 100 Founding seats, a deleted holder's seat never reissued, retention and
tenant isolation.

Release order is certificate first, as for 0018 and 0019: every version-19 database consumer (Vercel production, the Railway API and
worker) must run a build carrying this certificate (Release A) before 0020 is applied by the Railway pre-deploy migration (Release B).
No production migration or release was performed during engineering. Rollback keeps the certificate; do not drop the `flight_*` tables
to accommodate an older binary.

## 15. Certificate 0021_workflow_grants

| Base | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0020 `flight_flofi` (`a7ce1f42…2892`) | 0021 `workflow_grants` | `07a789dc1b6fb10c2fe46430342845946fbc1f06e176cbbab78102d66ed044a7` |

Migration 0021 (BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001) is additive and changes no row:
- `credential_grants.passkey_id` drops NOT NULL, under a new CHECK `credential_grants_passkey_or_workflow_grant`. A grant may lack a passkey
  only when it is an EVM workflow grant (`scope->>'kind' = 'WORKFLOW'`). Every existing grant has a passkey, so the validation scan cannot fail.
  The 0011 passkey foreign key still applies whenever a passkey is present (MATCH SIMPLE).
- The 0011 revision CHECK requiring a passkey for a signed revision is found by its definition and replaced by
  `delegated_authorization_revisions_signed`. That constraint admits exactly the previous rows plus a revision whose envelope and assertion are both of
  kind `WALLET_WORKFLOW` (the run's authorization is the wallet signature of its workflow grants). A missing definition aborts the migration
  (`MIGRATION_0021_REVISION_CHECK_NOT_FOUND`).

A build without 0021 runs unchanged on schema 21:
- It never writes a grant without a passkey or a WALLET_WORKFLOW revision.
- Reading such rows:
  - its grant mapper turns a NULL `passkey_id` into a string, which its passkey checks never match (`GRANT_PASSKEY_MISMATCH`, fail closed);
  - its executor refuses a revision without a passkey (`AUTHORIZATION_NOT_ACTIVE`).

**Locks.** `SET LOCAL lock_timeout = '5s'`. `DROP NOT NULL` and the two `ADD CONSTRAINT`s take short ACCESS EXCLUSIVE locks on `credential_grants`
and `delegated_authorization_revisions`. The CHECK validation scans each table once; both are small and touched only by delegated execution. A
concurrent long transaction makes the migration fail after 5 s and retry; it never makes delegated reads wait longer.

**Release order (one certificate for 0021 and 0022).** This build ships 0021 and 0022 together, and `migrate` applies every pending migration in one
pre-deploy. So Release A is one certificate, `{ base: 0020 flight_flofi, migrations: [0021 workflow_grants, 0022 editor_requester] }`, with the exact
bytes of both. It goes into a release from main whose newest shipped migration is 0020, and that release is deployed to every database consumer
before this build migrates. Without Release A there is no application rollback once 0021/0022 are applied: the previous commit refuses schema 22.

## 16. Certificate 0022_editor_requester

| Base | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0021 `workflow_grants` (`07a789dc…44a7`) | 0022 `editor_requester` | `f5b05c8bd32bf70bfa95e2b6ecc075b909f604334a13188c1651c2bd31e16d43` |

Migration 0022 (BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001) widens two CHECK constraints and does nothing else: no table, column, index,
function, trigger or row is added, changed or removed.

- `mcp_handoffs_requester_kind_check` (0006, widened once by 0010) and `workflow_runs_requester_kind_check` (0015's column check) also admit
  `EDITOR_SESSION`: the signed-in FloFi account handing its own Canvas workflow to the shared workflow-run flow. Its `requester_id` is the
  account id (`acct_` + 32 hex, within 0006's `requester_id` pattern) and, like every non-MCP requester, it carries no MCP account or grant:
  `mcp_handoffs_requester_identity` (0006) applies unchanged.

Every row valid under the previous schema is valid under 0022 unchanged, so the `ADD CONSTRAINT` validation scans cannot fail on existing data.
Each constraint is dropped and re-added in one `ALTER TABLE` statement, inside the migration's single transaction, under `lock_timeout = '5s'`
(exactly the shape 0010 used for the first constraint): approval and workflow-run writes wait at most for that short transaction.

A build without 0022 runs unchanged on schema 22, including on rows written by a build with it:
- it never writes `EDITOR_SESSION` (its `APPROVAL_REQUESTER_KINDS` has no such kind), so nothing it writes can violate a widened constraint;
- an `EDITOR_SESSION` handoff is resolvable only through the Editor's own link scheme (`flofi_edhs_`), which an older build does not register: its
  `/approve` answers `HANDOFF_NOT_FOUND` for such a link, and a requester-scoped read of another kind never matches the row;
- a workflow run of an `EDITOR_SESSION` handoff is re-gated with the requester kind's policy, which an older build does not have: its
  `policyFor` falls back to the closed policy (`MCP_HANDOFF_POLICY_INVALID`), so it loads no further step of such a run (fail closed). Status
  reads by the run's proven owner still work.

`editor-requester-migration.pg.test.ts` checks the exact bytes, every earlier row and column surviving unchanged, the widened definitions, the new
rows, the 0006 identity rule and 0015's immutability still refusing unsafe rows, and atomic rollback. The exact SQL is also kept as
`packages/cloud-runtime/test/fixtures/0022_editor_requester.sql`.

**Release order.** Covered by the single certificate of §15 (0021 and 0022 together, base 0020). No production migration or release was performed during engineering.

## 17. Certificate 0023_user_funded_groups

| Base | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0022 `editor_requester` (`f5b05c8b…6d43`) | 0023 `user_funded_groups` | `aea46318eee01184af97a814bb88a19dd0a1ad60e9b64b6079de39d7a6b7594e` |

Migration 0023 (BUILD-FLOFI-UNIVERSAL-WORKFLOW-002) is additive and changes no row:
- `workflow_runs_mode_check` (0015's column check) also admits `USER_FUNDED`: a run whose execution groups the owner's own wallet authorizes
  and pays for (invariant S1: FloFi never funds user gas).
- `workflow_runs_check3` (0015's mode/authorization co-constraint, verified by name and definition on the production catalog before release)
  also admits `mode = 'USER_FUNDED' AND authorization_id IS NULL`: nothing is delegated to FloFi in that mode, so it has no delegated authorization.
- New table `workflow_run_groups` (FK to `workflow_runs`), its index `workflow_run_groups_due`, two new functions with their triggers
  (`workflow_run_group_insert`: the run must be USER_FUNDED and every group's `fee_payer` must equal the run's own wallet of that namespace,
  else `GAS_PAYER_NOT_OWNER`; `workflow_run_group_transition`: identity, fee payer and step range frozen, what the owner signed frozen once
  authorized and in every later state — a group holding an owner authorization is never planned again — a submission written once, closed
  transitions) and the existing 0015 `workflow_run_append_only()` reused as its no-delete trigger. Group codes use 0015's code grammar.
- Grouped steps reuse 0015's existing step state `DELEGATED` and its existing transitions. `workflow_run_steps`, its trigger and every other
  pre-existing function, trigger and index are unchanged.

Every row valid under 0022 is valid under 0023 unchanged, so the two `ADD CONSTRAINT` validation scans cannot fail on existing data.

A build without 0023 (v22) runs unchanged on schema 23, including on rows written by a build with it:
- it never writes `USER_FUNDED` and never reads `workflow_run_groups`, so nothing it writes can violate a widened constraint;
- its runner treats a `USER_FUNDED` run like confirm mode: a grouped step (state `DELEGATED`) falls through its `default` branch (no move), and
  its `currentStep` loads a step only for `CONFIRM_EACH_STEP` runs. So a v22 build never loads, signs, relays or submits anything of a
  user-funded run: the run waits (fail closed) until a build with 0023 serves it again;
- its cancellation refuses a run with a `DELEGATED` step (`WORKFLOW_RUN_STEP_IN_FLIGHT`), so it cannot end a run whose group may be in flight.
- Status reads by the run's proven owner still work (`mode` is shown as stored).

**Locks.** `SET LOCAL lock_timeout = '5s'`. Each constraint is dropped and re-added in one `ALTER TABLE` statement inside the migration's single
transaction (the shape 0010/0022 used): a short ACCESS EXCLUSIVE lock on `workflow_runs`, one validation scan of a small table. The new table is
created empty.

`user-funded-groups-migration.pg.test.ts` checks the exact bytes, every earlier row surviving unchanged, the widened definitions, a USER_FUNDED run
with groups, the fee-payer rule refusing any wallet but the run's own, the group transition and immutability rules, and atomic rollback. The exact
SQL is also kept as `packages/cloud-runtime/test/fixtures/0023_user_funded_groups.sql`.

**Release order.** Release A is the certificate `{ base: 0022 editor_requester, migrations: [0023 user_funded_groups] }` with the exact bytes,
released from main (newest shipped migration 0022) and deployed to every database consumer (Vercel, Railway API, Railway worker) before this build
migrates. It is two commits of this build's branch, `RELEASE A: schema 0023 compatibility certificate` and `RELEASE A (amended): …` (the reviewed
0023 bytes), which touch only the certificate, its fixture and this section, so they can be cherry-picked on their own, in order. Without Release A there is no application rollback
once 0023 is applied: the previous commit refuses schema 23 (`MIGRATION_HISTORY_MISMATCH`). No production migration or release was performed
during engineering.

## 18. Certificate 0024_flight_launch

| Base | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0023 `user_funded_groups` (`aea46318…594e`) | 0024 `flight_launch` | `a9def02ddd0ec6ccd89181dc51d9f7f50a20b9265feec8b236abd9e4a3fa7bc0` |

Migration 0024 (BUILD-FLOFI-FLIGHT-LAUNCH-001, the Flight FloFi launch completion) is additive and changes no row:
- `flight_passes` gains two nullable columns, `public_id` (12 base32 letters, the card's public link id) and `removed_at` (takedown), and a
  partial unique index `flight_passes_public_id (tenant_id, public_id) WHERE public_id IS NOT NULL`.
- `flight_invites` gains one nullable column `recipient` (the lower-cased address a team invite was emailed to) and a partial unique index
  `flight_invites_recipient (tenant_id, recipient) WHERE recipient IS NOT NULL`.
- Seven new tables: `flight_access_tokens`, `flight_access_sessions`, `flight_access_claims`, `flight_access_attempts`, `flight_emails` (the
  email outbox), `flight_email_suppressions`, `flight_email_control`, with their own indexes. Foreign keys reference `tenants`,
  `flight_list_entries`, `flight_passes`, `flight_invites` and `flofi_accounts` (cascading deletes from the referenced rows only).
- No function, trigger, CHECK or index of any pre-existing relation changes.

A build without 0024 (v23) runs unchanged on schema 24, including on rows written by a build with it:
- every v23 `INSERT` into `flight_passes` and `flight_invites` names its columns and omits the new nullable ones (they stay NULL); its `SELECT`s
  name their columns; so nothing it reads or writes depends on them;
- it never reads the new tables. Its account deletion (a plain `DELETE` of `flofi_accounts`) cascades into `flight_access_claims`, and its
  `erase-email` / `purge-lists` (deleting `flight_list_entries`) cascade into tokens, sessions, claims and the outbox rows linked to those
  entries only: card emails (linked by pass), creator-invite emails and `flight_invites.recipient` keep the address, and a v23 build never
  prunes the new tables. **Run erasure and pruning with the v24 `flight-admin.ts`, even while a web deployment is rolled back to v23**;
- a v23 page has public counters and issues invites to invited Founding seats (the rules this build changes); nothing in the schema forces
  either, so a rollback to v23 restores those behaviors but cannot break the database.

**Locks.** `SET LOCAL lock_timeout = '5s'`. `ALTER TABLE … ADD COLUMN` of nullable columns without defaults rewrites nothing (short ACCESS
EXCLUSIVE lock; their CHECK constraints do one validation scan of each small table). The two `CREATE UNIQUE INDEX` statements take a SHARE lock on two small campaign tables (`flight_passes`,
`flight_invites`: at most a few thousand rows) for the duration of one index build inside the migration's transaction. Every new table is
created empty.

`flight-launch-migration.pg.test.ts` checks the exact bytes (also kept as `packages/cloud-runtime/test/fixtures/0024_flight_launch.sql`), every
earlier row surviving unchanged, v23-style inserts on schema 24, the new constraints, the certificate, cascades and atomic rollback.

**Release order.** Release A is the certificate `{ base: 0023 user_funded_groups, migrations: [0024 flight_launch] }` with the exact bytes,
deployed from a build whose newest shipped migration is 0023 to **every** database consumer (Vercel Production, Railway API, Railway worker)
before any build that ships 0024 migrates. It is the commit `RELEASE A: schema 0024 compatibility certificate` of this build's branch, which
touches only the certificate, its fixture and this section, so it can be cherry-picked on its own. Release B (this build) then migrates from
the Railway API pre-deploy. See [RELEASE-FLIGHT-LAUNCH-0024.md](./RELEASE-FLIGHT-LAUNCH-0024.md). Without Release A there is no application
rollback once 0024 is applied: the previous build refuses schema 24 (`MIGRATION_HISTORY_MISMATCH`). No production migration or release was
performed during engineering.

## 19. Certificate 0027_reconciliation_privacy

| Base | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0026 `flight_early_list` (`51fc9c31…10c8`) | 0027 `reconciliation_privacy` | `6edd545c5f7076aa85468c52e79a198df187af71001793695675527f5f96c069` |

Migration 0027 (BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001) is additive and changes no row. It creates six empty tables, each with its own
functions, triggers and indexes:

- `execution_nonce_conflicts` — the worker's read-only nonce-conflict investigations (a diagnostic cache; no flow reads it). Foreign key to
  `execution_runs (tenant_id, run_id) ON DELETE CASCADE`, so the v26 owner-history purge still deletes a run (its diagnostic row goes with it).
- `admin_support_texts` (immutable bodies; deletion refused under a legal hold), `admin_lookup_keys` (wrapped quarter keys; never deleted, only
  destroyed; destruction refused under a hold), `privacy_legal_holds`, `privacy_requests`, `privacy_retention_activations` — each with a
  transition trigger and foreign keys to `tenants`, and a statement trigger refusing `TRUNCATE` on the five privacy tables.
- No tenant-deletion path exists, so the new `REFERENCES tenants` keys (no cascade) block nothing a v26 build does.
- No function, trigger, CHECK, column or index of any pre-existing relation changes. `admin_audit_events` keeps its append-only trigger and
  every row as written.

A build without 0027 (v26) runs unchanged on schema 27, including on rows written by a build with it:
- it never reads or writes the new tables; its `admin_audit_events` inserts and reads are unchanged. Support events written by the new build
  carry `textRef`/`reasonRef` (and lookups `fpv`, `period`, `kid`) instead of inline text: a v26 Admin skips such notes in its note lists
  (its `listNotes` requires `detail.text`) and shows such reasons as "—" (it reads `detail.reason`), never an error — a display difference only
  during a rollback window. While rolled back, a v26 Admin writes new notes and reasons inline again (outside the new controls);
- its purge path (`purge_unstarted_execution`, 0016) deletes `execution_runs`, which cascades into `execution_nonce_conflicts`; nothing else
  references a pre-existing row.

**Locks.** `SET LOCAL lock_timeout = '5s'`. Creating the foreign keys takes a SHARE ROW EXCLUSIVE lock on `execution_runs` and `tenants` for
the remainder of the migration's (short) transaction: concurrent writes to those two tables wait for it (milliseconds — every new table is
empty, so nothing is scanned). A lock that cannot be taken within 5 s fails the migration, which rolls back completely (proven:
`reconciliation-privacy-migration.pg.test.ts`), and the previous deployment keeps serving.

Release A's `packages/cloud-runtime/test/certificate-0027.pg.test.ts` applies the certified bytes (kept as
`packages/cloud-runtime/test/fixtures/0027_reconciliation_privacy.sql`) under the v26 build and checks: schema 26 served unchanged; schema 27
served only through the certificate (the strict check refuses it); the catalog diff (nothing pre-existing removed, redefined or added to);
every earlier row surviving; v26 audit writes, the append-only guard and the 0016 purge mechanism (with the cascade) still working; the v26
runner never changing a database ahead of it; and the lock-timeout rollback. `apps/reference-dapp/backend/schema-compatibility.pg.test.ts`
runs the v26 API, worker, `main.ts`/CLI cold starts and Vercel paths across the new certificate. Release B adds
`reconciliation-privacy-migration.pg.test.ts` for the shipped migration.

**Release order.** Release A is the certificate `{ base: 0026 flight_early_list, migrations: [0027 reconciliation_privacy] }` with the exact
bytes, deployed from a build whose newest shipped migration is 0026 to **every** database consumer (Vercel Production, Railway API, Railway
worker) before any build that ships 0027 migrates. It is the commit `RELEASE A: schema 0027 compatibility certificate` of this build's branch,
which touches only the certificate, its fixture, its test and this section (the manifest test `forward-compatibility.test.ts` also checks
the fixture's bytes and this anchor), so it can be merged and deployed on its own. Release B (this build) then
migrates from the Railway API pre-deploy; Release B adds the step-by-step release document `RELEASE-RECONCILIATION-PRIVACY-0027.md`. Without
Release A there is no application rollback once 0027 is applied. No production migration or release was performed during engineering.

## 20. Certificate 0028_saved_recipients

| Base | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0027 `reconciliation_privacy` (`6edd545c…c069`) | 0028 `saved_recipients` | `ee73e909b6747c47c0bca877c8621d55229348177f0e7c6d68e47000a8fca64f` |

Migration 0028 (BUILD-FLOFI-UNIFIED-COPILOT-001, Saved Recipients) is additive and changes no row. It creates one empty table,
`flofi_account_recipients` — an account's saved recipients: a name and a PUBLIC address, nothing else — with only the indexes of its own keys:

- columns `tenant_id`, `account_id`, `recipient_id` (`^rcp_[a-z2-7]{26}$`), `ecosystem` (`EVM` | `SOLANA`), `address` (EVM lower-case `0x` + 40
  hex, never the zero address; Solana base58 of 32–44 characters, never the System Program), `label` (1–40 characters, no C0/C1 control
  character), `label_key` (the application's folded comparison key, 1–160 characters), `created_at`, `updated_at`;
- primary key `(tenant_id, account_id, recipient_id)`; `UNIQUE (tenant_id, account_id, ecosystem, address)` (one record per address and account —
  per account, not per tenant, because saving an address is not ownership) and `UNIQUE (tenant_id, account_id, label_key)` (a name is never
  ambiguous: "Maria" and "María" are the same name);
- foreign key `(tenant_id, account_id) REFERENCES flofi_accounts ON DELETE CASCADE`, so account deletion removes every saved recipient.
- No function, trigger, CHECK, column or index of any pre-existing relation changes.

A build without 0028 (v27) runs unchanged on schema 28:
- a v27 build before Release A never reads or writes the new table. The Release A build (still v27) carries the saved-recipient code, which
  first checks `schema_migrations` for the exact certified 0028 identity (answer cached for at most 30 s per process) and, until 0028 is
  applied, answers RECIPIENTS_UNAVAILABLE without touching any other table; it never creates the table at runtime;
- its only interaction is through `flofi_accounts`: deleting an account (`DELETE FROM flofi_accounts`, account self-deletion) now also deletes
  that account's saved recipients through the cascade — the documented and intended behavior. Nothing in a v27 build truncates
  `flofi_accounts` (only test suites, with `CASCADE`), so the new reference blocks nothing;
- a v27 sign-in that locks its account row (`SELECT … FOR UPDATE`, Privy sign-in) and a recipient write that holds the same row
  `FOR NO KEY UPDATE` wait for each other for the length of one short transaction; foreign-key checks (`FOR KEY SHARE`) never wait for either.

**Locks.** `SET LOCAL lock_timeout = '5s'`. Creating the foreign key takes a SHARE ROW EXCLUSIVE lock on `flofi_accounts` for the remainder of
the migration's (short) transaction: concurrent writes to `flofi_accounts` (a first sign-in, onboarding, account deletion) wait for it —
milliseconds, because the new table is empty and nothing is scanned. Reads are never blocked. A write transaction already open on
`flofi_accounts` makes 0028 wait for its lock; if it cannot be taken within 5 s, the migration fails and rolls back completely, and the
previous deployment keeps serving (proven: `certificate-0028.pg.test.ts`). Retry it in a quieter moment.

Release A's `packages/cloud-runtime/test/certificate-0028.pg.test.ts` applies the certified bytes (kept as
`packages/cloud-runtime/test/fixtures/0028_saved_recipients.sql`) under the v27 build and checks: schema 27 served unchanged; schema 28 served
only through the certificate (the strict check refuses it); the catalog diff (nothing pre-existing removed, redefined or added to — the
only new objects are the table, its constraints and their indexes); every earlier row surviving; v27 account writes and account deletion (with
the cascade) still working; the v27 runner never changing a database ahead of it; the lock-timeout rollback; and the documented emergency
reversal restoring the exact v27 catalog. `apps/reference-dapp/src/accounts/recipient-store.pg.test.ts` runs the store against the same
bytes. `apps/reference-dapp/backend/schema-compatibility.pg.test.ts` runs the v27 API, worker, `main.ts`/CLI cold starts and Vercel paths
across the new certificate.

**Rollback.** Application rollback after Release B: redeploy Release A (it serves schema 28 by certificate and keeps saved recipients
working, because Release A already contains the saved-recipient code). Never roll back to a build older than Release A once 0028 is
applied: it refuses schema 28 (`MIGRATION_HISTORY_MISMATCH`). The emergency reversal of 0028 (owner decision, after every consumer runs
Release A) deletes every saved recipient; it is in [RELEASE-SAVED-RECIPIENTS-0028.md](./RELEASE-SAVED-RECIPIENTS-0028.md).

**Release order.** Release A is the certificate `{ base: 0027 reconciliation_privacy, migrations: [0028 saved_recipients] }` with the exact
bytes, deployed from a build whose newest shipped migration is 0027 to **every** database consumer (Vercel Production, Railway API, Railway
worker) before any build that ships 0028 migrates. Release B then ships `packages/cloud-runtime/migrations/0028_saved_recipients.sql` (the
fixture's bytes, unchanged) and its `SHIPPED_MIGRATIONS` entry and migrates from the Railway API pre-deploy. Until Release B, saved recipients
are unavailable in production (RECIPIENTS_UNAVAILABLE; the Credentials section says so). See
[RELEASE-SAVED-RECIPIENTS-0028.md](./RELEASE-SAVED-RECIPIENTS-0028.md). No production migration or release was performed during engineering.

**Release note (2026-11-15).** Release A was deployed as `67f4e84` (schema 27 in production). Release B ships
`packages/cloud-runtime/migrations/0028_saved_recipients.sql` (byte-identical to the fixture, SHA-256 `ee73e909…a64f`) and its
`SHIPPED_MIGRATIONS` entry. `packages/cloud-runtime/test/saved-recipients-migration.pg.test.ts` proves 27 → 28 and rehearses the documented
controlled Neon procedure. Suites that assumed head 27 now use the v27 history. Neon is migrated by the owner before Release B merges.

## 21 Certificate 0029_finops_ledger

Migration 0029 creates one tenant-scoped, append-only cost ledger with two indexes and a trigger using the existing append-only
function. It does not alter existing data, tables, indexes, or execution semantics. The FinOps console works on schema 28 with
billing data and mutations unavailable, and reads the ledger on schema 29. No public request reads the ledger. The optional aggregate AI usage table is also additive and has no user identity fields. The SQL in
`packages/cloud-runtime/test/fixtures/0029_finops_ledger.sql` is the certificate-pinned migration.

This release continues to ship schema 28 for normal Railway pre-deploy and Vercel preview bootstrap. An operator can apply 0029
after all database consumers use the certificate-bearing release. From its reviewed, built source checkout, point the admin CLI
at the intended database using the existing server-only `DATABASE_URL` and run
`node apps/reference-dapp/backend/admin-cli.ts finops-migrate --tenant default` for the default tenant. For an isolated preview,
use the existing preview database and pass `--preview-branch <branch>` instead. The command verifies the certificate digest and uses
the standard migration runner, lock and ledger; reruns are safe. Earlier builds without the certificate refuse schema 29, so any
rollback after applying 0029 must retain the certificate. Leave the ledger in place.


## 22. Certificate 0030_finops_sync

| Base history | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0028 `saved_recipients` plus certified 0029 `finops_ledger` | 0030 `finops_sync` | `63b3c6ca82f69787fcb1d5527b7e3fe28b93b01cc8f5af0df85cc8efd597508b` |

0030 adds two empty, tenant-scoped tables for provider schedules, fenced leases, checkpoint state, and normalized billing period coverage and usage snapshots. The financial ledger remains append-only. No existing column, row, index, trigger function, or public execution path is altered. The new foreign key to `tenants` takes a short SHARE ROW EXCLUSIVE lock during activation. Writes to existing tenants and ordinary execution tables continue. A conflicting tenant write can delay activation by up to five seconds, at which point the migration transaction rolls back.

The application still ships 0028 for the ordinary deployment migration. Its exact forward certificate accepts 0029, then 0030. On schema 29, existing ledger reports, imports and legacy billing sync continue, and automatic sync returns unavailable. The worker has an opt-in loop and one dedicated connection, outside the execution queue and its pool.

1. On a dedicated disposable Neon branch (never a Preview database shared with other branches: until this certificate is on `main`, every other preview build refuses schema 30 with `MIGRATION_HISTORY_MISMATCH`), apply and verify the pinned 0029 and 0030 bytes. Test the admin and worker cold starts and restart the worker while a billing job has a nonempty checkpoint. Existing provider and telemetry data stays in place.
2. Before activating 0030, verify that each database consumer and restart path runs the certificate-bearing release. Keep a build with this exact certificate available for rollback. Confirm the intended database and tenant out of band.
3. From that reviewed checkout, with a direct `DATABASE_MIGRATION_URL` set in the operator environment, run `node apps/reference-dapp/backend/admin-cli.ts finops-sync-migrate --tenant default`. For an isolated preview, pass `--preview-branch <branch>` instead. The command requires exact existing schema 29, validates both SQL digests and the history, and applies only the missing certified migration. A successful repeat applies nothing. Do not edit the ledger or issue ad hoc DDL.
4. Configure dedicated billing credentials and enable `FLOFI_FINOPS_SYNC=enabled` on the existing worker only after activation. Set the matching `FLOFI_FINOPS_BILLING_TENANT`. The default cadence is 24 hours and `FLOFI_FINOPS_SYNC_HOURS` accepts whole hours from 6 through 168. On the first activation, verify provider scope and currency using the Admin coverage and an independently obtained billing extract.
5. To stop collection, disable the sync flag on the worker. To roll back the application after activation, use a build carrying the exact 0030 certificate with collection disabled and leave the tables and existing ledger intact. Once 0031 (§23) is also active, only a build carrying the §23 certificate (0029–0031) is a rollback target; once 0032 (§24) is active, only a build carrying the §24 certificate (0029–0032); once 0033 (§25) is active, only a build carrying the §25 certificate (0029–0033). Builds predating that certificate reject schema 30. Before activation, the schema-29-compatible production release is also a rollback target.

## 23. Certificate 0031_position_history_purge

| Base history | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0028 `saved_recipients` plus certified 0029 `finops_ledger` and 0030 `finops_sync` | 0031 `position_history_purge` | `c7d4a08223df2a3d5f32d70902d1d5b2efd5ec961b67f146ea20c2a4afeb898d` |

BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 adds Uniswap v3 position-management runs (`flofi.uniswap-position-run.v1`: collect, partial withdrawal, exit,
close). 0016's owner-history purge retains every snapshot shape it does not know, so an owner cannot delete even a never-authorized position
simulation today (`RUN_DELETE_REFUSED`, fail-safe). 0031 closes that gap and changes nothing else:

- It **redefines only `disposable_execution_snapshot(jsonb,text,text)`** (`CREATE OR REPLACE`, same signature, `IMMUTABLE`, still no `PUBLIC`
  privilege): 0016's body byte for byte, plus one branch for `flofi.uniswap-position-run.v1` that requires all and only that record's keys
  (`format`, `id`, `provenance`, `workflow`, `owner`, `request`, `review`, `authorization`, `attempts`, `result`, `evidence`, `verdict`, `error`; a
  snapshot lacking one is retained), and `result` added to the values that must be null (a test proves the body equals 0016's plus exactly these). Every historic snapshot of the run must still pass: no authorization (an authorized-then-invalidated run
  is kept), no attempt, no observed result, no evidence, verdict `PENDING`, and none of 0016's signature/submission/receipt keys anywhere.
- Every other check of `purge_unstarted_execution` is unchanged and still applies: tenant and owner, run status, `has_evidence`,
  `needs_observation`, `attention_required`, recovery links, attempts, evidence objects, live leases, queued or shared work items, idempotency,
  MCP handoffs, workflow-run steps, automations, delegated steps, **any INTENT log naming the run** (a position run's `.unipm-position` claim and
  `.unilp-intent` owner-nonce reservation are INTENT logs, written only from `begin`), and journals. Tombstones, the immutable audit, the
  append-only protections and the resurrection guards are untouched.
- Migration 0016 itself is immutable and unchanged; no table, column, index, trigger, row or privilege changes. `SET LOCAL lock_timeout = '5s'`:
  replacing the function waits at most 5 s for a session altering it, then the migration rolls back completely (proven).

**Compatibility.** A v28 build carrying this certificate serves schema 31; a build carrying only the previous certificate (0029–0030, i.e. `main`
before this build) refuses it with `MIGRATION_HISTORY_MISMATCH`, so this build must serve every database consumer before 0031 is applied.
Builds before this one never create position runs, and for every other format the predicate is byte-identical, so their purge behaviour does
not change. The v28 runner never changes a database ahead of it, and the ordinary deployment migration still ships schema 28.

**Evidence** (disposable PostgreSQL 16 locally; CI runs PostgreSQL 18): `packages/cloud-runtime/test/certificate-0031.pg.test.ts` — exact bytes and
certificate, schema 31 served only through it, a catalog diff of exactly one redefined function with unchanged privileges, rows and log bytes
surviving, which synthetic snapshots become deletable (an unstarted or refreshed position simulation) and which stay protected (authorized,
invalidated after authorization, prepared, submitted, uncertain, reconciled, result- or evidence-bearing, divergent, signed, receipt-bearing,
tampered, wrong id or owner, other tenant, observed or evidenced projections, a live lease, an INTENT naming the run, a queued work item), a
deletion racing an authorization (never both), a failing 0031 and a lock timeout rolling back completely, and the emergency reversal restoring the
exact schema-30 catalog. `apps/reference-dapp/backend/uniswap-position-purge.pg.test.ts` — real position runs from the production runtime on the
backend's PostgreSQL storage: refused before 0031, the operator command refusing schemas below 30 and never applying 0029/0030 itself, then only the
never-authorized simulation deleted through the authenticated owner-history route; authorized-then-invalidated, prepared and reconciled runs kept.
`FLOFI_TEST_CERTIFIED_AHEAD=1` runs the owner-history, position-purge and liquidity cloud suites on schema 31.

**Activation, rollout and rollback**: [RELEASE-POSITION-PURGE-0031.md](./RELEASE-POSITION-PURGE-0031.md). Not applied anywhere by this build.
Once 0031 is active, a build carrying only the §22 certificate (0029–0030) refuses the database: §22's rollback targets become builds carrying this
certificate. Once 0032 (§24) is also active, a build carrying only this section's certificate (0029–0031) refuses the database too: the rollback
targets then become builds carrying the §24 certificate (0029–0032), and once 0033 (§25) is active, builds carrying the §25 certificate (0029–0033).

## 24. Certificate 0032_single_step_runs

| Base history | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0028 `saved_recipients` plus certified 0029 `finops_ledger`, 0030 `finops_sync` and 0031 `position_history_purge` | 0032 `single_step_runs` | `1f388788b8e788fcc412585b38569260acea1e1cb24ec2cab3f2208270e5d14c` |

BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 lets the Editor run ONE financial card as a one-step USER_FUNDED workflow run (one owner confirmation,
one wallet batch the owner's own wallet authorizes and pays for). 0015's column check limits a run to 2..8 steps, so the database refuses a one-step
run today. 0032 widens that check and changes nothing else:

- It **widens only `workflow_runs_step_count_check`** (0015's column check, verified by name and definition on a migrated schema-31 database) from
  `step_count BETWEEN 2 AND 8` to `step_count BETWEEN 1 AND 8`, dropping and re-adding it under the same name in one `ALTER TABLE` statement —
  the shape 0010/0022/0023 used. No table, column, index, function, trigger, privilege or row is added, changed or removed; every other constraint
  is byte-identical (proven by a catalog diff).
- 0015's `workflow_run_transition` trigger is unchanged and already bounds a one-step run: `current_step` starts at 0 and can never reach
  `step_count` (`NEW.current_step >= OLD.step_count` refuses 1), and `step_count` stays immutable. 0023's group rules (USER_FUNDED only, the
  owner's own wallet as fee payer) apply unchanged to the single group covering step 0. `workflow_run_steps` (0..7) is unchanged.
- Every row valid under 0031 is valid under 0032 unchanged, so the `ADD CONSTRAINT` validation scan cannot fail on existing data.
  `SET LOCAL lock_timeout = '5s'`: the short ACCESS EXCLUSIVE lock on `workflow_runs` waits at most 5 s for an open transaction holding the table,
  then the migration rolls back completely (proven). While it holds the lock, every read of `workflow_runs` (status polls, owner history, the FinOps
  report) and every insert into `workflow_run_steps` / `workflow_run_groups` / `workflow_run_events` (their foreign keys need `workflow_runs`) waits
  for that short transaction and its validation scan. Approval-handoff writes do not.

**Compatibility.** A v28 build carrying this certificate serves schema 32; a build carrying only the previous certificate (0029–0031, i.e. `main`
before this build) refuses it with `MIGRATION_HISTORY_MISMATCH`, so this build must serve every database consumer before 0032 is applied.
Builds before this one never create one-step runs: their claim path refuses fewer than two steps (`WORKFLOW_RUN_NOT_SEQUENTIAL`), so nothing they
write depends on the widened bound. The application enables single-card runs only when the ledger holds exactly this 0032 identity
(`singleStepRunsSupported`). The v28 runner never changes a database ahead of it, and the ordinary deployment migration still ships schema 28.

**Cold starts on schema 32.** `apps/reference-dapp/backend/schema-compatibility.pg.test.ts` applies the extended certificate (0029–0032). It runs the Railway API, the worker, the real `main.ts` / CLI cold starts and the Vercel paths (embedded runtime, platform state, Developer API, MCP OAuth) on schema 32 (3/3 locally).

**Evidence** (disposable PostgreSQL 16 locally; CI runs PostgreSQL 18): `packages/cloud-runtime/test/certificate-0032.pg.test.ts` — exact bytes and
certificate (one `ALTER TABLE` and the lock timeout, nothing else), schema 32 served for the v28 build only through it (the previous certificate,
the empty certificate set and the strict check refuse it; the v28 runner and an edited 0032 change nothing), a catalog diff of exactly one changed
constraint (columns, other constraints, indexes, functions, triggers and privileges identical), existing 2-, 3- and 8-step runs, steps and groups
surviving unchanged, a one-step run refused at schema 31 and accepted at schema 32 and driven through 0015's unchanged trigger to COMPLETED,
0, 9 and −1 steps still refused, a failing 0032 and a lock timeout (a reader holding `workflow_runs`) rolling back completely, and the documented
emergency reversal restoring the exact schema-31 catalog while no one-step run exists and refusing otherwise. `certificate-0031.pg.test.ts` keeps
its proofs on the extended certificate. `apps/reference-dapp/backend/single-step-runs-migrate.pg.test.ts` — the operator command refusing
schemas below 31 (never applying 0029–0031 itself), applying only 0032 on exact schema 31, a rerun applying nothing, and the 0029, 0030 and 0031
commands applying nothing on schema 32.

**Activation, rollout and rollback**: [RELEASE-SINGLE-STEP-RUNS-0032.md](./RELEASE-SINGLE-STEP-RUNS-0032.md). Not applied anywhere by this build.
Once 0033 (§25) is also active, a build carrying only this section's certificate (0029–0032) refuses the database: the rollback targets then become
builds carrying the §25 certificate (0029–0033), and the 0032 emergency reversal refuses while 0033 is the newest migration (0033 is reversed first,
and only while no attempt was ever deleted).

## 25. Certificate 0033_workflow_run_purge

| Base history | Certified forward migration | SHA-256 |
| --- | --- | --- |
| 0028 `saved_recipients` plus certified 0029 `finops_ledger`, 0030 `finops_sync`, 0031 `position_history_purge` and 0032 `single_step_runs` | 0033 `workflow_run_purge` | `26b8a6dbf15dddbca24924e10bf8748748691c400fcb0c70e1d63038607be2c2` |

BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (owner requirement): a single Editor card runs as a one-step USER_FUNDED workflow run (§24), whose
records 0015/0023 keep append-only, so an attempt the owner abandoned before anything was sent could only be archived. 0033 lets the **owner** delete
exactly such an attempt from History, decided by the database under the run's row lock, and changes nothing else:

- **Two new tables.** `workflow_run_purge_audit`, the identity tombstone (tenant, run id, handoff id, the EVM owner, the shape, the final state,
  the run's creation time, the number of events deleted, when; no strategy, amount, recipient, hash, code or signature), immutable through the
  existing `reject_append_only_mutation()` (one new trigger on it). `workflow_run_purge_permits`, a transaction-scoped private capability with a
  foreign key to the tombstone. `REVOKE ALL … FROM PUBLIC` on both. The tombstone's foreign key to `tenants` takes a short SHARE ROW EXCLUSIVE lock
  during activation, as §22's did; a conflicting tenant write can delay activation by up to five seconds, then the migration rolls back (proven).
- **One redefined function body: `workflow_run_append_only()`** (0015). `CREATE OR REPLACE`, same signature, same EXECUTE privilege (a trigger
  function cannot be called directly), now `SECURITY DEFINER` with `SET search_path = pg_catalog, public, pg_temp` so the private permit table is
  read whoever deletes. It keeps 0015's exact refusal — `WORKFLOW_RUN_RECORD_APPEND_ONLY`, SQLSTATE `23000` — for every UPDATE and every DELETE,
  except a DELETE of a row of exactly the run a permit names inside the very transaction holding that permit (`txid_current()`). Its four triggers
  (0015's three, 0023's one) are untouched. This is 0031's precedent (a redefined body behind an unchanged signature): **compatible with the v28
  build**, because no v28 code path ever deletes or updates a workflow-run record — every such statement fails before and after 0033 with the same
  message and SQLSTATE (proven for each of the four tables and for UPDATE of an event), and a v28 build never creates a permit.
- **One new function: `purge_unsubmitted_workflow_run(tenant, owner, id) RETURNS jsonb`**, `SECURITY DEFINER`, the same `search_path`, EXECUTE revoked
  from PUBLIC (the owner role only). It locks the run (as every run-store write), its steps and groups (as cancellation), the approval handoff, the
  run's `workflow-run.advance` work items, then the tenant's privacy lock (as legal-hold placement and erasure), and answers a closed result:
  `{"ok":true,"disposition":"DELETED"}` (also on an idempotent repeat: the tombstone), `{"ok":false,"code":"RUN_NOT_FOUND"}` (no such run of this
  owner in this tenant), or `{"ok":false,"code":"RUN_DELETE_REFUSED"}` with reason `EXECUTION_ACTIVITY`, `AUTHORIZATION`, `DEPENDENCY` or none
  (operator records: a legal hold, a Support text; open or structurally ineligible runs). Deletable are only a one-step `EDITOR_SESSION` run of an
  EVM owner, never authorized or completed, whose handoff is this owner's own Editor claim (SEQUENTIAL, no bound execution runs), in one of two
  shapes, each checked against the run's **whole** append-only history through a closed allowlist of the exact event forms the run store writes
  (kind, step index, code and detail keys; anything else refuses):
  - `NO_WALLET_REQUEST` — CANCELLED, FAILED or EXPIRED before any wallet request existed: mode none or USER_FUNDED, at most one EVM wallet-batch
    group that was never prepared, authorized, submitted or reconciled (BLOCKED or SKIPPED, no artifact), events only `RUN_CREATED`, `MODE_CHOSEN`,
    `GROUP_STATE` BLOCKED/SKIPPED, `STEP_STATE` BLOCKED/SKIPPED, `RUN_STATE` HALTED/FAILED/EXPIRED and `RUN_CANCELLED`, consistent with the final state;
  - `WALLET_REJECTED_VERIFIED` — CANCELLED after the owner's wallet rejected the one wallet batch: the group SKIPPED `WALLET_REQUEST_REJECTED` with an
    unsponsored artifact prepared once (no `superseded`, no sponsorship, 1–16 calls none with native value, the owner's recorded nonce and block),
    no answer, submission or outcome; the step SKIPPED `WALLET_REQUEST_REJECTED`; events exactly `RUN_CREATED`, `MODE_CHOSEN`, one `GROUP_STATE`
    PREPARED, one or more `GROUP_WALLET_DECLINED` and exactly one `GROUP_DECLINE_VERIFIED` (both naming that artifact's request id and preparation
    time; the verification also its recorded nonce and block, and a later or equal end block), `GROUP_STATE` and `STEP_STATE` SKIPPED
    `WALLET_REQUEST_REJECTED`, and `RUN_CANCELLED`, in that order. The application writes `GROUP_DECLINE_VERIFIED` only after its own chain reads
    proved the batch was never sent (`apps/reference-dapp/src/user-funded/decline-proof.ts`); the database trusts that event (only the application
    writes events) and does not read the chain.
  It also refuses when a delegated authorization or execution, a developer approval, a bound execution run, a LEASED advance item, any other open
  work item naming the run, a live approval signing session, an active legal hold (TENANT, or RUN naming the run or its handoff) or a Support text
  about the run exists. On success it writes the tombstone and the permit, deletes the run's events, groups, steps and run, the permit, then the
  approval handoff (after the run: its foreign key), the run's READY/DONE/DEAD advance items and its History archive marker, in one transaction;
  a foreign-key violation from a concurrent dependency rolls all of it back into a generic refusal. Deleting the handoff makes the approval link
  unclaimable (`HANDOFF_NOT_FOUND`) and any re-creation of a run for it fail its foreign key; the tombstone makes a repeat idempotent.
- Migrations 0015, 0016 and 0023 are immutable and unchanged; no existing table, column, constraint, index, trigger, privilege or row changes
  (proven by a catalog diff). `SET LOCAL lock_timeout = '5s'`.

**Compatibility.** A v28 build carrying this certificate serves schema 33; a build carrying only the previous certificate (0029–0032) refuses it
with `MIGRATION_HISTORY_MISMATCH`, so this build must serve every database consumer before 0033 is applied. Owner history calls the procedure only
when the ledger holds exactly this 0033 identity (`packages/cloud-runtime/src/owner-history.ts`); without it a workflow run keeps today's refusal.
The application starts single-card runs only where both 0032 and this 0033 are active (`singleStepRunsSupported`), so an attempt the wallet
rejected is always deletable where one can exist. Privacy access and erasure find Support texts about a deleted attempt through the tombstone
(`apps/reference-dapp/src/admin/privacy-ops.ts`). The v28 runner never changes a database ahead of it, and the ordinary deployment migration
still ships schema 28.

**Cold starts on schema 33.** `apps/reference-dapp/backend/schema-compatibility.pg.test.ts` applies the extended certificate (0029–0033) and runs
the Railway API, the worker, the real `main.ts` / CLI cold starts and the Vercel paths on schema 33 (3/3 locally).

**Evidence** (disposable PostgreSQL 16 locally; CI runs PostgreSQL 18): `packages/cloud-runtime/test/certificate-0033.pg.test.ts` — exact bytes,
top-level statements and certificate; schema 33 served for the v28 build only through it (the previous certificate, no certificate and the strict
check refuse it; the v28 runner and an edited 0033 change nothing); the catalog diff (two tables with exactly their columns, constraints and
indexes, one trigger on the tombstone, one new function without PUBLIC EXECUTE, one redefined function, nothing removed or otherwise changed);
rows surviving; plain DELETE on each workflow-run table and UPDATE of an event refused with 0015's error after 0033; a permit of another
transaction or for another run unlocking nothing, UPDATE refused even inside a permitted transaction, the tombstone immutable, no permit left
behind; a failing 0033 and a lock timeout (a writer holding `tenants`) rolling back completely; and the documented reversal restoring the exact
schema-32 catalog (`md5(pg_get_functiondef('workflow_run_append_only()'))` included) only while no attempt was deleted and only on 0033 as head,
with the 0032 reversal refusing while 0033 is head. `apps/reference-dapp/backend/owner-history.pg.test.ts` — records written by the real workflow-run
store: both shapes deleted through owner history and the authenticated route; every refusal of the shared contract; the deletion complete (rows,
handoff, work items, archive marker), idempotent, visible as DELETED and unarchivable; concurrent deletions; a deletion racing a cancellation and
a group transition; schema 32 without 0033 still refusing; privacy access and erasure through the tombstone.
`apps/reference-dapp/backend/workflow-run-purge-migrate.pg.test.ts` — the operator command.

**Activation, rollout and rollback**: [RELEASE-WORKFLOW-RUN-PURGE-0033.md](./RELEASE-WORKFLOW-RUN-PURGE-0033.md). Not applied anywhere by this build.
