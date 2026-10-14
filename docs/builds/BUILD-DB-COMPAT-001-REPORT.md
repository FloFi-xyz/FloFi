# BUILD-DB-COMPAT-001 — zero-downtime schema compatibility (report)

Baseline `fa7816b` (`origin/main`). Branch `claude/build-db-compat-001`, local commits only: nothing pushed, no PR, merge or deploy,
no production infrastructure touched. The BUILD-ADMIN-001 worktree (`53b1a8b`) was read only (its branch, files, commits and database
are unchanged). Contract, 0012 assessment and runbook: [`docs/deploy/SCHEMA-COMPATIBILITY.md`](../deploy/SCHEMA-COMPATIBILITY.md).
Plan: [`BUILD-DB-COMPAT-001-PLAN.md`](BUILD-DB-COMPAT-001-PLAN.md).

## Outcome

* **The v11 application can safely operate on the actual v12 schema** — once it carries this build. 0012 (SHA-256
  `25556fbfd8e45acf0e692fc340eee56fa2f064f4106225960d63e3da9c303af2`, BUILD-ADMIN-001 at `53b1a8b`) is purely additive: the catalog diff
  shows nothing removed or redefined and no row changed; v11 code names none of its objects, never updates or deletes a tenant (the only
  thing its new foreign-key triggers react to), and keeps every query's meaning. It is certified for the v11 build by exact identity.
* **The released (unpatched) v11 build cannot**: it refuses 0012 on every cold start (`MIGRATION_HISTORY_MISMATCH`), proven against the
  vendored `fa7816b` module. Hence the order: Release A (this build) everywhere, then Release B (Admin + 0012).
* **Explicit, not inferred.** No `>=` rule: a newer migration is served only when the build's own certificate names it by version,
  name and SHA-256. A scalable contract exists and is implemented — certify one release ahead (expand/contract) — because an old binary
  can verify only identities it already holds; the unit suite enforces the rules (fixture until shipped, shipped equals certified).
* **Runner vs. readiness.** `migrate` never changes a database that is ahead of it (certified: no-op success, so a rollback to Release A
  still passes Railway's pre-deploy; otherwise it fails closed). Advisory lock, one transaction per migration, exactly-once unchanged.
* **Point of no return for unpatched binaries: the commit of 0012.** After it, only Release A and later builds can cold-start.

## Changes

| File | Change |
| --- | --- |
| `packages/cloud-runtime/src/migrations.ts` | `CERTIFIED_FORWARD_MIGRATIONS` (0012 for the v11 build), `schemaCompatibility`, `assertSchemaCompatible`; `migrate` leaves a certified-ahead database untouched and refuses any other ahead state; `assertSchemaCurrent` unchanged |
| `packages/cloud-runtime/src/queries.ts` | `ensureTenant` reads an existing tenant instead of inserting (no `ROW EXCLUSIVE` on `tenants` behind a migration's FK lock) |
| `apps/reference-dapp/backend/main.ts` | `api`/`worker`/`migrate`/`import-journal` use the compatible check; logs `schema_version`, and on a newer schema `application_schema_version` + `forward_migrations` |
| `apps/reference-dapp/src/server/flow-runtime.ts`, `platform-state-host.ts`, `backend/developer-admin.ts` | compatible check (Vercel embedded flows/MCP/readiness, MCP OAuth/Developer/Channels/approvals, Developer CLI) |
| `packages/cloud-runtime/test/forward-compatibility.test.ts` | manifest rules, 0012 identity, decision rule, equivalence with the released strict check |
| `packages/cloud-runtime/test/forward-compatibility.pg.test.ts` | scenarios 1–10, catalog diff, lock window, concurrency, emergency reversal |
| `apps/reference-dapp/backend/schema-compatibility.pg.test.ts` | scenarios 11–12: API/worker continuity, real process cold starts, Vercel paths |
| `packages/cloud-runtime/test/fixtures/0012_admin_control_plane.sql` | the exact 0012 bytes (test fixture, not shipped) |
| `packages/cloud-runtime/test/baseline/migrations-fa7816b.ts` | the released `migrations.ts` (one import path changed; SHA-256-pinned) as the unpatched build |
| `docs/deploy/SCHEMA-COMPATIBILITY.md`, `docs/deploy/CLOUD.md`, `docs/builds/BUILD-DB-COMPAT-001-*.md` | contract, certificate, runbook, rollback; pointer; plan and report |

No UI, wallet, permission, manifest, simulation/execution, reconciliation, fee, automation-authorization or network-catalog change; no
dependency or lockfile change; no new environment variable.

## Required scenarios

| # | Scenario | Result | Test |
| --- | --- | --- | --- |
| 1 | v11 app, v11 database | PASS | `forward-compatibility.pg` “1–4”; backend “11”, “12” |
| 2 | patched v11 app, certified v12 database | PASS (`{version 12, application 11, forward [0012]}`) | same; real `main.ts` processes |
| 3 | unpatched v11 app, v12 database | refuses `MIGRATION_HISTORY_MISMATCH` (released `fa7816b` code) | “1–4”, “10”, backend |
| 4 | v10 database, v11 app | refuses `SCHEMA_NOT_MIGRATED` (patched and released) | “1–4”; real processes exit 1 |
| 5 | edited historical checksum | refused by checks and runners, nothing changed | “5–8” |
| 6 | edited (or renamed) certified 0012 | refused, nothing changed | “5–8” |
| 7 | unknown 0013 | refused unless a certificate names it (shown with a test certificate) | “5–8”; unit rule tests |
| 8 | inconsistent ledger (missing row, 0012 without 0011, out of sequence, hand-downgraded, partially created objects) | refused / runner fails closed atomically | “5–8” |
| 9 | concurrent instances during migration | 3 v12 + 1 v11 runner: 0012 applied exactly once; 4 patched instances cold-starting and writing: 0 failures; unpatched instance refuses after commit | “9” |
| 10 | runner when schema is ahead | certified: `[]`, catalog and ledger unchanged; released/uncertified/v10 runner: refuses, unchanged | “10”; real `main.ts migrate` |
| 11 | API/worker continuity across the transition | 0 failed requests; in-flight transfers (reported and unknown) reconciled; recovery sweep; evidence; owner-only reads | backend “11” |
| 12 | cold starts, old and new versions | `main.ts migrate/api/worker`, Developer CLI, embedded runtime, readiness, platform state, Developer API + approvals, MCP OAuth + tools; the next build only after its migration | backend “12” ×2 |

Workloads are real code on real PostgreSQL: owner journeys through the HTTP API (simulate, review, begin, handoff, report), journal
writes, worker reconciliation and evidence archiving, recovery sweep, owner/wallet-principal run and journal reads, Developer
strategies/approvals and approval claims, MCP OAuth sign-in and tools. Chains are MOCKED in-process (the owner wallet is the test calling
`MOCK_submit`); no public network, no transaction.

## Verification (local, PostgreSQL 18.6 CI image on loopback, Node 24.21.0, pnpm 11.22.0)

| Check | Result |
| --- | --- |
| `pnpm check` (typecheck, lint, build, schemas:check, unit) | PASS — 370 files / 4,234 tests passed; 2 skipped, both pre-existing `skipIf` (`composition-service`, `mode-b-service`) |
| `pnpm test:postgres` | PASS — 57 files / 360 tests |
| New PostgreSQL suites, repeated | 12/12 consecutive runs after fixing a cleanup-hook timeout (all tests had passed; the end-of-file drop of ~13 databases exceeded the 10 s default hook timeout about 1 run in 10) |
| Mutation: certificates ignored | 7 of 9 new PostgreSQL tests fail (the 2 others are designed to pass either way) |
| Mutation: released `ensureTenant` | lock-window test fails (`TIMEOUT` inside the migration) |
| Browser (guarded profiles, exact CI env) | `workflow-acceptance` 5/5, `execution-continuity` 9/9, `cloud-provenance` 1/1 (embedded runtime on PostgreSQL; Anvil 1.8.3 SHA-256-verified) |
| Governance | `test_governance_lite` 19 OK, `test_ci_*` 22 OK, `governance_lite.py` passed (1,903 files); `git diff --check` clean (tree, `HEAD^1..HEAD`, `fa7816b..HEAD`) |
| Trial integration with BUILD-ADMIN-001 | disposable detached worktree of `53b1a8b` + this branch (removed afterwards): clean merge; `pnpm typecheck` PASS; 15 files / 82 tests passed (manifest + 0012 certificate, both new PostgreSQL suites, Admin migration/rollout/settings/http/analytics, migration and platform-state suites), 1 file / 3 tests skipped by design (no certificate for the v12 head); an edited 0012 makes the certificate test fail as intended |

**Not run:** the full guarded browser `product` (24 profiles) and `composition` phases, fork suites (`test:fork`), MCP browser suites,
`pnpm audit`/SBOM/`bootstrap-ci --verify-dependencies` (no dependency change), `cloud-preview-smoke.mjs` (needs a deployed URL), live and
remote suites, and anything against Railway, Vercel or Neon. Local evidence does not prove production behavior.

## 0012 duration (loopback, real runner)

| `automation_evaluations` | applied in | cold start (this build), max | released `ensureTenant`, max | run write, max | evaluation write, max |
| --- | --- | --- | --- | --- | --- |
| 400,000 rows (86 MB) | 288 ms | 4 ms | 275 ms | 14 ms | 270 ms |
| 2,000,000 rows (431 MB) | 1,636 ms | 4 ms | 1,618 ms | 56 ms | 1,611 ms |

## Remaining risks

1. A certificate is a reviewed judgment; the tests prove additivity at the catalog, data and lock level and run v11 workloads, but not
   every v11 query plan (the new index can change plans on `automation_evaluations`; results cannot change).
2. While 0012 is open (≈ 0.3–1.6 s above), new tenants and every evaluation write wait — including **API owner routes** (automation
   create/state/rebind, delegated authorization activate/revoke), which 0012's header and `ADMIN.md` describe as worker-only. Its own lock
   waits are capped at 5 s (then it rolls back whole).
3. Anything not on Release A when 0012 commits refuses on cold start: older Vercel deployments reachable by URL, Previews or other
   environments sharing the production database, operator CLIs run from older checkouts. With `FLOFI_MIGRATE_ON_BUILD=preview`, the
   Admin PR's Preview build migrates the shared Preview database when it builds.
4. A forged ledger row, or objects created outside migrations, are invisible to the check (unchanged from before).
5. `migrate` succeeding with `versions=none` on an ahead database is intended for rollbacks; a misrouted deploy of an old image would
   also "succeed" — check `migrate.applied` shows `versions=12` for Release B.
6. Zero downtime is demonstrated for the application code paths on loopback PostgreSQL, not for Railway/Vercel orchestration, Neon's
   pooler or production volumes (size `automation_evaluations` before Release B; the runner's 30 s statement timeout bounds the index).

## Integration steps for BUILD-ADMIN-001

1. After Release A is merged and deployed everywhere, rebase BUILD-ADMIN-001 onto `main` (the trial merge was conflict-free).
2. Keep `0012_admin_control_plane.sql` byte-identical (`25556fbf…`). Any edit — even its header comment — needs a new certificate and a
   new Release A; `forward-compatibility.test.ts` fails the combined build otherwise.
3. Correct `ADMIN.md` §7 (and the rollout narrative): API owner automation/delegation routes also wait for the index build; a
   compatibility build serves on 0012, so only pre-Release-A builds are unsafe to roll back to; point to `SCHEMA-COMPATIBILITY.md` §4–§5.
   `src/admin/rollout.pg.test.ts` still passes (it checks the strict function); optionally assert there that `assertSchemaCompatible`
   with the v11 history serves after 0012.
4. Keep `server/copilot-settings-source.ts`: the new build still refuses a database that is behind it, and a later migration until a
   certificate for the v12 build exists.
5. Run the combined gates (`pnpm check`, `pnpm test:postgres`, browser `admin-console`, governance). `schema-compatibility.pg.test.ts`
   skips itself there until a future migration is certified for the v12 build.

## Safe rollout sequence

1. **Release A:** owner merges BUILD-DB-COMPAT-001; Railway API/worker and Vercel deploy normally (database stays at 0011; logs
   `schema_version=11`). Confirm every process reaching the production database (both Railway services, the Vercel production
   deployment, Previews sharing it, operator CLIs) runs Release A or later; soak.
2. **Release B:** rebase and verify Admin; stage the Vercel production deployment (auto-assign off / `--skip-domain`); optionally pause
   `flofi-worker` auto-deploy; owner merges; the Railway API pre-deploy applies 0012 (`versions=12`; `55P03` → rolled back, redeploy);
   the Release A processes keep serving (`forward_migrations=12_admin_control_plane`); the new API starts, then the worker; promote the
   staged Vercel deployment; validate API, worker, Channels, approvals, Developer, MCP and an owner run; enable the console per
   `ADMIN.md`.
3. **Recovery:** after 0012, roll back to Release A (never earlier); the documented emergency reversal of 0012 is a last resort with
   every process on Release A.
