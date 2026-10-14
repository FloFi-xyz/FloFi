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
| `src/server/platform-state-host.ts` | MCP OAuth, Developer API, Channels, approvals (and Admin, once it ships) |
| `backend/developer-admin.ts` | Developer operator CLI |

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
build holds only worker evaluation writes; API owner automation/delegation routes also wait (bounded, see above). With this build
deployed, `ADMIN.md` §7's "a pre-0012 build refuses the newer schema on every cold start" applies only to builds older than this one,
and `src/admin/rollout.pg.test.ts`'s "previous build refuses on a cold start" checks the strict `assertSchemaCurrent` (still true), not
what a deployed compatibility build does.

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
