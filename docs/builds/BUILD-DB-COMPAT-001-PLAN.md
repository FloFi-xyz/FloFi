# BUILD-DB-COMPAT-001 — zero-downtime schema compatibility (plan)

Baseline: `fa7816b` (`origin/main`). Branch: `claude/build-db-compat-001`. Local commits only: no push, PR, merge or deploy.
The BUILD-ADMIN-001 worktree (`claude/build-admin-001`, HEAD `53b1a8b`) is read-only input.

## Problem

Every FloFi process checks that the database has **exactly** the migrations its build ships (`assertSchemaCurrent`). A
migration that is additive and harmless to the previous build still makes every *cold start* of that build refuse the database
(`MIGRATION_HISTORY_MISMATCH`) from the moment it commits, until every service runs the new build. Warm instances keep working; any
restart, scale-out or serverless cold start fails. That window exists for the Railway API (pre-deploy migrates while old replicas
serve), the Railway worker (`restartPolicyType: ALWAYS`), and every Vercel function (MCP, Developer API, Channels, approvals, embedded
flows) until the new deployment is promoted.

## Callers (all production paths)

| Path | Services | Check today |
| --- | --- | --- |
| `backend/main.ts` `api` / `worker` startup | Railway API, Railway worker | `assertSchemaCurrent(db)` (files) |
| `backend/main.ts` `migrate` | Railway API pre-deploy, Vercel Preview opt-in build step | `migrate(db)` then `assertSchemaCurrent(db)` |
| `backend/main.ts` `import-journal` | operator | `assertSchemaCurrent(db)` |
| `src/server/flow-runtime.ts` `createEmbeddedRuntime` | Vercel embedded flows, MCP, readiness | `assertSchemaCurrent(db, SHIPPED_MIGRATIONS)` |
| `src/server/platform-state-host.ts` | MCP OAuth, Developer API, Channels, approvals, (Admin, later) | `assertSchemaCurrent(db, SHIPPED_MIGRATIONS)` |
| `backend/developer-admin.ts` | operator CLI | `assertSchemaCurrent(db, SHIPPED_MIGRATIONS)` |

## Migration 0012 identity (read-only from the Admin worktree)

`packages/cloud-runtime/migrations/0012_admin_control_plane.sql` at `53b1a8b`: 9,701 bytes, git blob `50c4c92c`, SHA-256
`25556fbfd8e45acf0e692fc340eee56fa2f064f4106225960d63e3da9c303af2` (raw bytes and the loader's UTF-8 text hash agree; working tree
equals the commit; Admin's own `SHIPPED_MIGRATIONS` entry agrees).

## Design

1. **Certificates, not inference.** `CERTIFIED_FORWARD_MIGRATIONS` in `@defi-workflow-engine/cloud-runtime`: each certificate names
   the exact identity of the newest migration of the build it was assessed for (`base`) and the exact identities (version, name,
   SHA-256) of the newer migrations that build may serve on. Nothing is inferred from SQL, version numbers or "additive-looking"
   names; an unknown, edited or reordered migration fails closed exactly as today.
2. **Application readiness** (`assertSchemaCompatible`): the known history must match exactly (prefix, checksums); behind →
   `SCHEMA_NOT_MIGRATED`; ahead → accepted only when the certificate for *this build's* head names every newer ledger row exactly,
   in order; otherwise `MIGRATION_HISTORY_MISMATCH`. Error codes are unchanged, so no UI, readiness or client mapping changes.
   `assertSchemaCurrent` stays as it is (strict, exact) for callers and tests that want exactness.
3. **Migration runner permission** (`migrate`): unchanged for a database at or behind the runner. A database *ahead* of the runner
   is never changed: certified → nothing applied, success (so a rollback to the compatibility release still passes Railway's
   pre-deploy); uncertified → `MIGRATION_HISTORY_MISMATCH`, as today. Same advisory lock, same transaction per migration,
   exactly-once.
4. **Lock-free cold starts.** `ensureTenant` reads before it inserts: an existing tenant never takes `ROW EXCLUSIVE` on `tenants`,
   which a migration adding a foreign key to `tenants` (0012 adds three) holds in `SHARE ROW EXCLUSIVE` until it commits.
5. **Scalable contract.** An old binary can only verify bytes it knew when it was built, so a migration that must apply under old
   code is certified one release *ahead* (expand/contract): Release A ships the certificate pinned to the exact bytes, Release B
   ships the migration. A unit test fails if a shipped migration differs from what an earlier release certified. Self-declared
   compatibility in the database, version ranges or environment allowlists were rejected: none lets an old build verify the
   migration's identity.

## Proof (tests)

The real 0012 bytes are a test fixture (`packages/cloud-runtime/test/fixtures/`, SHA-256-pinned to the certificate, not shipped);
the unpatched binary is the baseline `fa7816b` `migrations.ts`, vendored verbatim (one import path) and SHA-256-pinned.

| # | Scenario | Where |
| --- | --- | --- |
| 1–8, 10 | readiness/runner matrix: exact, certified ahead, unpatched strict, behind, tampered history, tampered certified, unknown v13, inconsistent ledger, runner when ahead | `packages/cloud-runtime/test/forward-compatibility*.test.ts` |
| — | catalog diff: 0012 removes or changes no pre-existing object; every addition listed | same (PostgreSQL) |
| — | `pg_locks`: what 0012 holds on pre-existing relations while open; which v11 operations wait | same (PostgreSQL) |
| 9 | concurrent runners (v12 ×3, patched v11) with v11 instances cold-starting and writing | same (PostgreSQL) |
| 11 | API (real HTTP server) + worker continuity across the transition: owner journeys, journal writes, reconciliation, recovery sweep, owner run/journal reads | `apps/reference-dapp/backend/schema-compatibility.pg.test.ts` |
| 12 | cold starts: real `node backend/main.ts migrate/api/worker` processes, the Developer CLI, Vercel embedded runtime, platform state, readiness; new-build check | same |

## Deliverables

Code (`cloud-runtime` migrations/queries, the six callers), tests above, `docs/deploy/SCHEMA-COMPATIBILITY.md` (contract, 0012
certificate assessment, how to certify a future migration, Release A/B runbook, rollback boundary), CLOUD.md pointer, report.

## Out of scope

No change to Canvas, chat, wallet onboarding, permissions, manifests, simulation/execution, reconciliation, fees, automation
authorization or the network catalog. No change to the Admin worktree; findings for it are reported as integration steps.
