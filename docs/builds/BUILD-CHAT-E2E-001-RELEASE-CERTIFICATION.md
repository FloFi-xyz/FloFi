# BUILD-CHAT-E2E-001 — Migration 0015 release certification

Pre-production certification of the Release A → Release B rollout of `0015_workflow_runs`, prepared on 2026-10-22 while Railway was
unavailable to this session.

Nothing was pushed, opened as a PR, merged, deployed or promoted, and no production setting was changed. Production was only *read*:
- Vercel project, environment-variable and deployment metadata, through the API (no values);
- the public API `/readyz`.

All database work used a disposable loopback PostgreSQL with synthetic data. No paid cloud job was run.

See the [build report](BUILD-CHAT-E2E-001-REPORT.md) and the assessment the certificate points to,
[SCHEMA-COMPATIBILITY.md §9](../deploy/SCHEMA-COMPATIBILITY.md#9-certificate-0015_workflow_runs).

## 1. Recommendation

| Decision | Verdict |
| --- | --- |
| Submit **Release A** for review (a PR to `main` from `8fee11c`) | **GO** |
| Submit **Release B** for review, after Release A or stacked on it | **GO**. Its Vercel Preview runs against the production database (§6) and fails closed there until 0015 exists, writing nothing |
| **Promote** either release to production | **NO-GO until the blockers in §9 are cleared**: Railway verification, CI on both PRs, owner decisions. Promotion then follows §8 exactly |

Why GO for review:
- every Phase 2 compatibility requirement passed on the real Release A and Release B trees;
- 0015 is fast at the measured sizes (164 ms at 100,000 delegated lineages);
- it fails closed and rolls back completely on a lock timeout or any error;
- it is reversible;
- the v14 build serves it without behaviour change. Its full PostgreSQL suite passed on the v15 schema except three fixture assumptions (§4.2).

## 2. Repository verification

| Check | Result |
| --- | --- |
| Base | `origin/main` = `7a844d2`, unchanged (re-checked with `git fetch --dry-run`) |
| Reported head | `7c16759`. The certification added three commits, then reordered the history (below) |
| Migrations 0001–0014 | Byte-identical to `main`: equal git blob ids for all 14 files |
| 0015 identity | `15 workflow_runs`, SHA-256 `5dfefcf7465d874da5880ae5a082f7f47e28ede51adfdef46dbbe3e3f7ba945f`, identical in the migration file, the byte-identical fixture, Release A's certificate and Release B's shipped manifest |
| Release A content | Only the certificate entry in `migrations.ts`, the fixture, tests, a test-harness option and the §9 assessment. `apps/` and every other package are identical to `main` |
| 0015 placement | `packages/cloud-runtime/migrations/0015_workflow_runs.sql` first appears in `66ee42f`, the first Release B commit. Release A ships v14 and only certifies v15 |

**The history was reordered.** The certificate commit `d69b4bd` had been made on top of the Release B commits: its parent `8551a30` already
contained 0015, so merging it would have shipped Release B too.

The branch was rebuilt on `7a844d2` with the Release A commits first and the Release B commits after them, in their original order. Before the
branch moved, the new tip's tree was proven byte-identical to the previous head's (`3b42f7d1…`). The previous head `9dde8c7` remains in the
reflog. Nothing had been pushed.

## 3. The two releases

### Release A — `7a844d2..8fee11c` (3 commits)

| Commit | Content |
| --- | --- |
| `4bc96e6` | The certificate: the `CERTIFIED_FORWARD_MIGRATIONS` entry, the SHA-pinned fixture, §9 and its tests (formerly `d69b4bd`) |
| `8607311` | Release certification tests: delegated lineages, concurrent runners, lock-timeout and late-failure rollback, foreign identities, the scale measurement, and the opt-in certified-ahead harness |
| `8fee11c` | §9 with the measured durations, failure behaviour and rollout order |

Changed files:

```
M  docs/deploy/SCHEMA-COMPATIBILITY.md
M  packages/cloud-runtime/src/migrations.ts                       (one CERTIFIED_FORWARD_MIGRATIONS entry; no shipped migration)
A  packages/cloud-runtime/test/fixtures/0015_workflow_runs.sql
M  packages/cloud-runtime/test/forward-compatibility.pg.test.ts
M  packages/cloud-runtime/test/forward-compatibility.test.ts
A  packages/cloud-runtime/test/migration-0015-scale.pg.test.ts
M  packages/cloud-runtime/test/pg-harness.ts                      (FLOFI_TEST_CERTIFIED_AHEAD, opt-in, never set in CI)
```

### Release B — `8fee11c..` the branch head

Release B is the migration, the BUILD-CHAT-E2E-001 runtime (off by default), its tests, the new browser profile and the documentation. Its
commits are listed in the [build report §12](BUILD-CHAT-E2E-001-REPORT.md#12-commits).

Changed files (89: 32 added, 57 modified; none deleted):

```
M  apps/reference-dapp/backend/main.ts
A  apps/reference-dapp/backend/workflow-run-worker.ts
A  apps/reference-dapp/e2e/approve-workflow-run.spec.ts
M  apps/reference-dapp/src/app/approve-action.ts
M  apps/reference-dapp/src/app/globals.css
M  apps/reference-dapp/src/channels/core/approval.ts
M  apps/reference-dapp/src/channels/core/conversation.ts
M  apps/reference-dapp/src/channels/core/copy.ts
M  apps/reference-dapp/src/channels/core/dispatch.pg.test.ts
M  apps/reference-dapp/src/channels/core/notify.ts
M  apps/reference-dapp/src/channels/core/service.ts
M  apps/reference-dapp/src/channels/core/status.ts
M  apps/reference-dapp/src/channels/core/strategy.ts
A  apps/reference-dapp/src/channels/core/workflow.test.ts
M  apps/reference-dapp/src/channels/runtime.ts
A  apps/reference-dapp/src/channels/telegram/workflow.pg.test.ts
M  apps/reference-dapp/src/channels/visual.pg.test.ts
M  apps/reference-dapp/src/channels/whatsapp/channel.pg.test.ts
M  apps/reference-dapp/src/channels/whatsapp/journey.pg.test.ts
M  apps/reference-dapp/src/components/app-shell.tsx
M  apps/reference-dapp/src/components/approval-handoff.tsx
M  apps/reference-dapp/src/components/docs/content.ts
A  apps/reference-dapp/src/components/workflow-run-panel.test.tsx
A  apps/reference-dapp/src/components/workflow-run-panel.tsx
M  apps/reference-dapp/src/delegation/executor-runtime.ts
M  apps/reference-dapp/src/delegation/executor.pg.test.ts
M  apps/reference-dapp/src/delegation/executor.ts
M  apps/reference-dapp/src/delegation/pg-store.ts
A  apps/reference-dapp/src/delegation/run-source.ts
M  apps/reference-dapp/src/delegation/runtime.ts
M  apps/reference-dapp/src/delegation/service.ts
M  apps/reference-dapp/src/delegation/steps.ts
M  apps/reference-dapp/src/delegation/views.ts
M  apps/reference-dapp/src/developer/engine.pg.test.ts
M  apps/reference-dapp/src/developer/errors.ts
M  apps/reference-dapp/src/engine/robinhood-composition.test.ts
M  apps/reference-dapp/src/engine/strategy-engine.ts
M  apps/reference-dapp/src/engine/strategy-spec.ts
A  apps/reference-dapp/src/engine/workflow-bindings.test.ts
A  apps/reference-dapp/src/engine/workflow-bindings.ts
A  apps/reference-dapp/src/i18n/pt-workflow-runs.ts
M  apps/reference-dapp/src/i18n/pt.ts
M  apps/reference-dapp/src/mcp/execution.ts
M  apps/reference-dapp/src/mcp/handoff/handoff.pg.test.ts
A  apps/reference-dapp/src/mcp/handoff/workflow.pg.test.ts
M  apps/reference-dapp/src/mcp/oauth/state.ts
M  apps/reference-dapp/src/mcp/runtime.ts
M  apps/reference-dapp/src/mcp/step-list.test.ts
M  apps/reference-dapp/src/mcp/tools.ts
M  apps/reference-dapp/src/platform/approvals.ts
M  apps/reference-dapp/src/platform/approve.ts
M  apps/reference-dapp/src/platform/boundary.test.ts
M  apps/reference-dapp/src/platform/handoff-store.ts
M  apps/reference-dapp/src/platform/index.ts
M  apps/reference-dapp/src/platform/strategy.ts
A  apps/reference-dapp/src/platform/workflow-run-approvals.ts
M  apps/reference-dapp/src/platform/workflow-visual-layout.ts
M  apps/reference-dapp/src/platform/workflow-visual.test.ts
M  apps/reference-dapp/src/platform/workflow-visual.ts
M  apps/reference-dapp/src/server/approval-surface.ts
A  apps/reference-dapp/src/server/workflow-run-surface.ts
A  apps/reference-dapp/src/workflow-runs/authorization-plan.test.ts
A  apps/reference-dapp/src/workflow-runs/authorization-plan.ts
A  apps/reference-dapp/src/workflow-runs/confirm-run.pg.test.ts
A  apps/reference-dapp/src/workflow-runs/delegated-run.pg.test.ts
A  apps/reference-dapp/src/workflow-runs/facts.ts
A  apps/reference-dapp/src/workflow-runs/migration.pg.test.ts
A  apps/reference-dapp/src/workflow-runs/observe.ts
A  apps/reference-dapp/src/workflow-runs/pg-store.ts
A  apps/reference-dapp/src/workflow-runs/runner.ts
A  apps/reference-dapp/src/workflow-runs/service.ts
A  apps/reference-dapp/src/workflow-runs/state-machine.ts
A  apps/reference-dapp/src/workflow-runs/worker.ts
A  apps/reference-dapp/src/workflow-runs/workflow-run.test-harness.ts
M  docs/STATUS.md
A  docs/builds/BUILD-CHAT-E2E-001-MIGRATION-0015-MEASUREMENTS.json
A  docs/builds/BUILD-CHAT-E2E-001-PLAN.md
A  docs/builds/BUILD-CHAT-E2E-001-RELEASE-CERTIFICATION.md
A  docs/builds/BUILD-CHAT-E2E-001-REPORT.md
M  docs/deploy/MCP.md
A  docs/deploy/WORKFLOW-RUNS.md
M  docs/developer/API.md
M  docs/developer/QUICKSTART.md
M  docs/developer/openapi.json
A  packages/cloud-runtime/migrations/0015_workflow_runs.sql
M  packages/cloud-runtime/src/migrations.ts
M  scripts/guarded-release-browser.mjs
M  scripts/test_ci_gcp_orchestration.py
M  scripts/test_ci_optimization.py
```

## 4. Migration 0015 compatibility results

### 4.1 Requirements

| Requirement | Evidence | Result |
| --- | --- | --- |
| v14 → v15 | `forward-compatibility.pg.test.ts`: the catalog diff lists every changed and new object | PASS |
| Existing rows preserved | The same test (every table's digest), the delegated-lineage test, and row digests at 0 / 10,000 / 100,000 lineages | PASS |
| Foreign keys and constraints | After 0015 no constraint is `NOT VALID` (`pg_constraint.convalidated`), and v14-shaped inserts satisfy the new source checks | PASS |
| Existing delegated authorizations | Unchanged rows. `PENDING_SIGNATURE → REVOKED` still works, and a new rule-sourced authorization is accepted | PASS |
| Existing delegated executions | Execution `QUEUED → … → SETTLED` and budget `RESERVED → SPENT` work after 0015, and a whole new v14 lineage is accepted | PASS |
| Forward compatibility of Release A | The v14 build serves v15 (`forward: [15]`). The strict check and a build without the certificate refuse it. A v14 runner never changes it | PASS |
| Different identity or checksum | A different name, checksum or version for 15 is refused (`MIGRATION_HISTORY_MISMATCH`) by the v14 build, the v14 runner and the Release B runner. Nothing changes | PASS |
| Concurrent migrations | Two Release B runners, a v14 runner and four v14 cold starts racing: 0015 applied exactly once, one ledger row, the catalog equal to a clean v15 | PASS |
| Failure and rollback | A lock held past the 5 s `lock_timeout` gives `55P03` and a complete rollback while v14 serves. A late failure (`42723`) undoes the earlier `ALTER`s. Both are applied by a later run | PASS |
| Documented reversal (§9.3) | It restores the exact v14 catalog and refuses, changing nothing, a tampered or non-newest 0015 or delegated workflow runs. Also timed at 10,000 and 100,000 | PASS |
| v14 services on v15 | Release A's whole PostgreSQL suite on v15 databases: 455/458 (§4.2). Release A's `backend/schema-compatibility.pg.test.ts`: the API and worker keep serving through 0015, and cold starts work on it | PASS, with 3 classified exceptions |
| No accidental workflow execution | v14 has no workflow-run code. Release B's worker loads the runner only with `FLOFI_WORKFLOW_RUNS=enabled`, and sequences are refused with `WORKFLOW_RUNS_NOT_ENABLED` while it is unset. Vercel has no such variable (checked); Railway was not checked (§9) | PASS for code. Railway configuration unverified |

### 4.2 The v14 suite on the certified v15 schema

The run used `FLOFI_TEST_CERTIFIED_AHEAD=1` on the Release A tree: 71 files, **455 passed, 3 failed**. None of the failures is a functional
incompatibility:

| Test | Why it fails on v15 | Classification |
| --- | --- | --- |
| `packages/cloud-runtime/test/tenancy.pg.test.ts` — shipped manifest verifies a migrated schema | Calls the strict `assertSchemaCurrent`, which by design accepts only the exact shipped history. No production code calls it (checked in both releases) | Test assumes the harness head is the build head |
| `apps/reference-dapp/src/platform/state-host.pg.test.ts` — fails closed on a behind schema | It fabricates "behind" by deleting the build's last ledger row. On v15 that leaves a gap, so it gets `MIGRATION_HISTORY_MISMATCH` instead of `SCHEMA_NOT_MIGRATED`. The platform still refuses and creates no tenant | Test fixture assumption |
| `apps/reference-dapp/backend/admin-analytics.pg.test.ts` — health report | It asserts `appliedMigrations === shippedMigrations` (14). The report truthfully says 15 applied, 14 shipped, `ok: true` | Test fixture assumption, **plus an operator-facing finding**: Admin → Health shows the Schema row as not OK, "15 of 14 shipped migrations", while Release A serves v15. Expected during the window; see §6 and §9 |

The same tree without the option: **458/458**.

### 4.3 Gate results

| Tree | Gate | Result |
| --- | --- | --- |
| Release A `8fee11c` (exported, no worktree) | Full PostgreSQL suite (`vitest run .pg.test.ts`, 2 workers) | **458 passed**, 0 skipped. The certificate block runs here |
| Release A `8fee11c` | The same with `FLOFI_TEST_CERTIFIED_AHEAD=1` | 455 passed, 3 failed as classified in §4.2 |
| Release A `8fee11c` | Unit suite (CI's `pnpm test` command) | **4,761 passed**, 2 skipped (pre-existing `skipIf`) |
| Release B head | `pnpm typecheck` / `pnpm lint` / `pnpm schemas:check` | **PASS**: typecheck 16/16 tasks; lint clean; 11 schema exports verified |
| Release B head | `pnpm test:postgres` | **474 passed**, 3 skipped (the certificate block, which runs only on Release A), 0 failed; 76 files |
| Release B head | `pnpm test` | **4,779 passed**, 2 skipped (pre-existing), 0 failed |
| Release B application code | Build and 54 browser tests in 9 profiles (build report §7) | PASS on `6e2ce2d`'s identical application code. Since then only `cloud-runtime` tests, the harness and documents changed |
| Both | `governance_lite.py`, its unit tests, `test_ci_*.py`, `git diff --check` | **PASS** on both. Release B: governance-lite (2,144 text files), 19 governance and 54 CI unit tests, no whitespace errors. Release A: governance-lite (2,112 files), 54 CI unit tests, no whitespace errors |

PostgreSQL ran on `postgres:18.6-bookworm@sha256:3725f4e2…`, CI's pinned image.

## 5. PostgreSQL lock and performance assessment

The figures come from `migration-0015-scale.pg.test.ts` with default durability on a WSL2 workstation. They are recorded in
[BUILD-CHAT-E2E-001-MIGRATION-0015-MEASUREMENTS.json](BUILD-CHAT-E2E-001-MIGRATION-0015-MEASUREMENTS.json).

| Lineages | Delegated tables | Total | New tables | Delegated `ALTER`s | Commit | Handoff/tenant writes blocked | Delegated reads/writes blocked | Lock wait | Reversal | Re-apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 80 KB | 28.2 ms | 12.4 ms | 3.6 ms | 4.5 ms | 21.0 ms | 8.6 ms | 0 ms | 10.7 ms | 20.5 ms |
| 10,000 | 13 MB | 39.7 ms | 11.8 ms | 16.8 ms | 3.7 ms | 32.8 ms | 21.1 ms | 0 ms | 17.6 ms | 40.0 ms |
| 100,000 | 140 MB | 164.3 ms | 11.9 ms | 132.2 ms | 12.5 ms | 157.2 ms | 145.2 ms | 0 ms | 89.9 ms | 188.3 ms |

A lineage is a delegated rule, occurrence, authorization, revision, execution and budget entry, so 100,000 lineages means 600,000 rows. The
cost grows linearly in the two delegated tables: validating the new checks and foreign keys, and building the two unique indexes.

**Lock modes held until commit.** These are identical at every size:

| Table | Modes |
| --- | --- |
| `delegated_authorizations`, `delegated_executions` | `AccessExclusiveLock`, `ShareRowExclusiveLock`, `ShareLock`, `AccessShareLock` |
| `mcp_handoffs`, `tenants` | `ShareRowExclusiveLock`, `AccessShareLock` |
| `schema_migrations` | `RowExclusiveLock`, `AccessShareLock` |

**Blocked while it is open.** Probed with a 300 ms lock timeout at every size:

| Waits | Does not wait |
| --- | --- |
| Delegated authorization and execution reads and writes; approval-handoff writes; tenant writes | Delegated budget entries; automation rules; handoff and tenant reads; execution runs; the work queue |

**Lock timeout.** Behind a session holding `delegated_executions` past 5 s, 0015 failed with `55P03` after 5,026 / 5,029 / 5,093 ms at the
three sizes and rolled back completely: ledger 14, identical rows and shape. Handoff writes and delegated reads issued 0.5 s in waited about
4.5 s, then proceeded. Run writes took about 7 ms.

Each lock wait is bounded separately. In theory several consecutive waits could each approach 5 s; only one occurred here.

**Cost.** All three sizes ran locally in 90 seconds, with no cloud resources. 100,000 lineages took 47 s to seed and 140 MB of delegated
tables.

**Caveat.** Production hardware and concurrency differ. Delegation is off by default, so the production delegated tables are expected to be
small. Read their counts before promotion (§8, step 5).

## 6. Risk assessment for existing services

| Service | Before 0015 (Release A) | During 0015 | After 0015, before every service runs Release B | Risk |
| --- | --- | --- | --- | --- |
| Railway `flofi-api` | Release A on v14: pre-deploy `migrate` is a no-op | Its Release B deploy runs 0015 in pre-deploy. If it fails, the previous deployment keeps serving | Release B on v15 | Low. Verify its commit and schema (§9) |
| Railway `flofi-worker` | Release A on v14 | Keeps running. Its work never waits: runs, queue and journals are unaffected | Release A serves v15 under the certificate. A Release B worker started before 0015 exits `SCHEMA_NOT_MIGRATED` and restarts until 0015 lands | Medium if both services deploy from one push and 0015 fails: the worker crash-loops until rolled back to Release A. Mitigated by §8's order |
| Vercel Production (flofi.xyz, `616598f` on 2026-10-22) | Must be replaced by Release A first: `616598f` is certified only up to 0014 | Approval-handoff writes and new tenants wait at most the migration's duration (0.16 s at 100,000 lineages), or up to about 5 s behind a lock it cannot get | Release A serves v15. Admin → Health shows "15 of 14 shipped migrations" as not OK (cosmetic) | High if Release A is not promoted first, because flofi.xyz would refuse the database. Low otherwise |
| Vercel Previews | `DATABASE_URL` is shared with Production (Preview + Production targets; checked 2026-10-22) and Previews run the embedded backend, so every Preview reads and writes production data. This is a **pre-existing** exposure | Same as Production | Previews of builds older than Release A refuse the database and fail closed. Release B Previews behave as Release B | Pre-existing, unchanged by this build. Pushing Release B before 0015 creates a Preview that refuses the database (`SCHEMA_NOT_MIGRATED`) and writes nothing |
| Operator CLIs (`admin-cli`, `developer-admin`) | Use `assertSchemaCompatible` | — | Versions older than Release A refuse v15 | Low. Use Release A or later |
| MCP, channels, Developer API, automations | Unchanged code (Release A) | Handoff creations and claims wait as above | Unchanged. Release B refuses sequences while `FLOFI_WORKFLOW_RUNS` is unset | Low |
| Delegated execution (BUILD-AUTOMATION-002) | Off by default; no hosted signer | Delegated reads and writes wait for the migration | v14 lineages keep working (tested). Workflow-run sources need Release B, `FLOFI_DELEGATION` and a signer | Low. Do not enable delegated workflow runs before every process runs Release B |

## 7. Rollback and recovery

| Situation | Procedure |
| --- | --- |
| Before 0015 | Roll back any service to Release A or later. Never below Release A once 0015 might run |
| 0015 fails to apply (`55P03` or any error) | Nothing changed (one transaction, tested). The API keeps its previous deployment. Keep, or roll back, the worker and Vercel on Release A. Find the blocking session (`pg_stat_activity` where `wait_event_type = 'Lock'`), let it end, then redeploy the API |
| 0015 applied; Release B misbehaves | Leave `FLOFI_WORKFLOW_RUNS` unset, or roll the affected service back to Release A, which serves v15. Do not roll back below Release A |
| 0015 must be removed | §9.3 reversal, last resort: only with Release A serving everywhere and no delegated workflow-run source. It refuses, changing nothing, otherwise. Measured at 90 ms on 100,000 lineages, then 0015 can be re-applied |

## 8. Promotion order

Each step is an owner action, and none was performed.

1. **Release A review.** Push `8fee11c` as its own branch (e.g. `git push origin 8fee11c:refs/heads/codex/build-chat-e2e-001-release-a`),
   open a PR to `main`, and let CircleCI and Vercel run. Merge after review.
2. **Release A on Railway.** Railway deploys `main` to `flofi-api` and `flofi-worker`. Confirm both run the Release A commit. The API's
   pre-deploy should log `migrate.applied versions=none` with schema version 14, and the worker should log `worker.starting` with schema 14.
3. **Release A on Vercel.** Promote the Production deployment of `main` to flofi.xyz; `autoAssignCustomDomains` is false. Confirm with
   `vercel inspect flofi.xyz` that it serves the Release A commit.
4. **Check for older builds.** No build older than Release A may serve the production database: operator CLIs, and other Production
   deployments. Older Previews will fail closed after 0015, which is acceptable.
5. **Read the production delegated row counts.** Read-only: `SELECT count(*) FROM delegated_authorizations` and the same for
   `delegated_executions`. Compare them with §5.
6. **Rebase Release B.** If Release A was squash-merged, run `git rebase --onto origin/main 8fee11c codex/build-chat-e2e-001`. The resulting
   tree must equal the current head's tree, and Release A's files must be unchanged. Then open the Release B PR and let CI run.
7. **Merge Release B, API first.** Railway's `flofi-api` deploy applies 0015 in pre-deploy (`migrate.applied versions=15`); then check
   `/readyz`. If Railway also deploys the worker from the same push, expect brief `SCHEMA_NOT_MIGRATED` restarts until 0015 lands. If 0015
   fails, follow §7.
8. **Release B on the worker.** It should log schema 15.
9. **Release B on Vercel.** Promote the Production deployment to flofi.xyz. Admin → Health then shows "15 of 15".
10. **Keep everything off.** `FLOFI_WORKFLOW_RUNS` stays unset and delegated production signing stays disabled. Enabling either is a
    separate owner decision.

## 9. Remaining blockers

| # | Blocker | Blocks |
| --- | --- | --- |
| 1 | Railway was unavailable to this session. Not verified: the commits running on `flofi-api` and `flofi-worker`; that the production schema is exactly v14; that `FLOFI_WORKFLOW_RUNS` and `FLOFI_DELEGATION` are unset on Railway; whether Railway deploys both services on a `main` push; the production delegated row counts | Promotion |
| 2 | No CI ran for either release: CircleCI needs a push; Cloud Build needs approval (§10). This includes the new `approve-workflow-run` browser profile and the full 46-profile plan | Promotion, and merging |
| 3 | Vercel Previews share the production `DATABASE_URL`. This is pre-existing; isolating the Preview database is a separate security task | Recommended before `FLOFI_WORKFLOW_RUNS` is ever enabled; not a review blocker |
| 4 | Admin → Health reports "15 of 14 shipped migrations" as not OK while Release A serves v15. It is cosmetic, and the same as the earlier certificates' windows. A certificate-aware health page would change application code, so it was kept out of Release A | Owner decision: accept and document (done here) or fix in a follow-up |
| 5 | Measurements come from a workstation, not production hardware | Informational |
| 6 | The build's own owner decisions: fee, KMS, enabling workflow runs (build report §11) | Enabling features; not this rollout |

## 10. Prepared CI commands (not executed)

**CircleCI.** It runs on the PR events after an owner push (step 1 and step 6 above). Pipelines trigger on `main` pushes and on PRs being
opened or synchronized.

**Google Cloud Build.** The established manual path from BUILD-SOLANA-TRANSFER-UX-001 is one sequential run on `E2_STANDARD_2` with a 3-hour
timeout. It needs a clean checkout of each release, and the source manifest is rewritten per snapshot.

Release A:

```sh
git worktree add --detach ../flofi-release-a 8fee11c            # an owner-approved separate checkout
cd ../flofi-release-a
SNAPSHOT=$(python3 scripts/gcp-source-snapshot.py create)       # rewrites cloudbuild-source-manifest.json for this tree
gcloud builds submit . --config=cloudbuild.yaml --project=celtic-volt-418819 --region=europe-west1 \
  --service-account=projects/celtic-volt-418819/serviceAccounts/flofi-ci-runner@celtic-volt-418819.iam.gserviceaccount.com \
  --gcs-source-staging-dir=gs://flofi-ci-source-547158547199-europe-west1/build-chat-e2e-001-release-a \
  --substitutions=_SNAPSHOT_SHA256=$SNAPSHOT,_SOURCE_BRANCH=codex/build-chat-e2e-001-release-a --async --quiet --format=json
```

Release B: the same commands in a checkout of the branch head, with `_SOURCE_BRANCH=codex/build-chat-e2e-001` and its own staging folder.

**Cost estimate.** These figures are to be confirmed in the project's billing:
- up to 180 build-minutes per run (the configured timeout); about 35 minutes were used by the last recorded attempt, which stopped early;
- at the published `e2-standard-2` Cloud Build rate of roughly US$0.006 per build-minute, about US$1.10 per run at most, before any free
  build-minutes;
- plus negligible storage for the source archive of about 115 MB.

The scale measurement itself needs no cloud resources.

## 11. Not claimed

- No production database, schema or row count was read.
- No CI system ran.
- No Railway setting or running commit was verified.
- The measurements are not from production hardware.
- Nothing here certifies a public-network execution.
- The 46-profile browser plan and the fork suite were not run for either release.
