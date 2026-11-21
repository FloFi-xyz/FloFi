# FloFi: single-card, one-confirmation workflow runs (BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001; migration 0032)

Status: **prepared and certified in this build, not applied anywhere.** Nothing in this build migrates a database to 0032: the ordinary
deployment migration (`migrate`, Railway API pre-deploy, Vercel preview bootstrap) still ships schema 28, and only the operator command below, run
by the owner, can apply 0032. **No production, preview or Neon database is changed by this build.**

## Purpose

The owner decided that the Editor may run ONE financial card as a one-step USER_FUNDED workflow run: one Strategy Manifest Review, one owner
confirmation, one wallet batch that the owner's own wallet authorizes and pays for (FloFi never funds gas). Migration 0015 limited a workflow run to
2..8 steps (`workflow_runs_step_count_check`), so the database refuses a one-step run today. 0032 widens exactly that CHECK to 1..8 and changes
nothing else.

The application enables single-card runs **only** when the database ledger holds exactly this 0032 identity (version, name and SHA-256)
**and** the 0033 `workflow_run_purge` identity ([RELEASE-WORKFLOW-RUN-PURGE-0033.md](./RELEASE-WORKFLOW-RUN-PURGE-0033.md): the owner's deletion of
an attempt that provably never reached a chain): `singleStepRunsSupported` in `apps/reference-dapp/src/workflow-runs/pg-store.ts`. Until both are
applied, or if a ledger row differs in any way, or if the read fails, a single card keeps its existing flow and nothing offers a run the database
would refuse. Multi-card workflows are unchanged either way.

## Identities

| | Version | Name | SHA-256 |
| --- | --- | --- | --- |
| Shipped by this build (unchanged) | 28 | `saved_recipients` | `ee73e909b6747c47c0bca877c8621d55229348177f0e7c6d68e47000a8fca64f` |
| Certified earlier (FinOps, optional) | 29 | `finops_ledger` | `9c04f837b7409622b6b485a21facafb25ce1d579ea2bd492ae859e71795c8de7` |
| Certified earlier (FinOps, optional) | 30 | `finops_sync` | `63b3c6ca82f69787fcb1d5527b7e3fe28b93b01cc8f5af0df85cc8efd597508b` |
| Certified earlier (position-history purge, optional) | 31 | `position_history_purge` | `c7d4a08223df2a3d5f32d70902d1d5b2efd5ec961b67f146ea20c2a4afeb898d` |
| **Certified by this build** | 32 | `single_step_runs` | `1f388788b8e788fcc412585b38569260acea1e1cb24ec2cab3f2208270e5d14c` |

Exact bytes: `packages/cloud-runtime/test/fixtures/0032_single_step_runs.sql`. Assessment:
[SCHEMA-COMPATIBILITY.md §24](./SCHEMA-COMPATIBILITY.md#24-certificate-0032_single_step_runs). Migration 0015 is immutable and unchanged.

**Numbering.** Migration numbers are one linear history: 0029 and 0030 (FinOps, §21, §22) and 0031 (position-history purge, §23) are certified
ahead of the shipped history, so this change is 0032 and can only follow them. **Applying 0029, 0030 and 0031 is each the owner's own decision
with its own procedure**; the 0032 command never applies them and refuses any schema below 31 (`SINGLE_STEP_RUNS_REQUIRES_SCHEMA_31`).

## Preconditions (all required before production activation)

1. **This certificate is deployed to every database consumer**: Vercel Production, the Railway API and the Railway worker, plus any preview that
   shares the database. Confirm each deployment's commit. A build carrying only the previous certificate (0029–0031) refuses schema 32
   (`MIGRATION_HISTORY_MISMATCH`), so a consumer left behind would stop serving the moment 0032 is applied.
2. **The database is at exactly schema 31**: 0029, 0030 and 0031 already applied by their own owner-run procedures (`finops-migrate`,
   `finops-sync-migrate`, `position-purge-migrate`; see RELEASE-POSITION-PURGE-0031.md). The command refuses anything below 31.
3. **Retention basis approved (owner / legal).** After activation, a single card the owner authorizes in the Editor writes `workflow_runs`,
   `workflow_run_steps`, `workflow_run_groups` and `workflow_run_events`. These are append-only (0015/0023 no-delete triggers; privacy erasure
   leaves execution records out of scope). Today such a card writes `execution_runs`, whose unstarted runs an owner may delete (0016
   `purge_unstarted_execution`). The row is created at the owner's Authorize, never by a read-only Review. It holds the owner's wallets, the
   canonical strategy (assets, amounts, any recipient) and the FloFi account id, even when the wallet then declines. The reviewed deletion path is
   the certified 0033 ([RELEASE-WORKFLOW-RUN-PURGE-0033.md](./RELEASE-WORKFLOW-RUN-PURGE-0033.md)), which single-card runs require: the owner
   may delete, from History, only an attempt that ended before any wallet request existed, or whose one wallet batch the wallet rejected and the
   server proved from the chain was never sent; the deletion leaves an identity tombstone (ids, owner, shape, final state, times, event count).
   Every attempt that was authorized, signed, submitted, pending, uncertain, partially or fully executed stays (Archive only). The retention basis
   (LGPD/GDPR) for the retained records, and for the tombstone, must be accepted before activation.
4. **Irreversibility accepted.** Once one single-card run exists, 0032 can no longer be reversed (see Rollback). Because the 0031 reversal refuses
   unless 0031 is the newest migration, 0031, 0030 and 0029 then become irreversible too. 0033 sits on top of 0032 and is reversed first; once an
   owner deleted one attempt under 0033 (its tombstone is permanent), 0033 can no longer be reversed, and 0032 cannot either.
5. **The FinOps cohort stays multi-step.** The FinOps report counts only workflow runs with `step_count >= 2`. One-step single-card runs are
   single actions; they are excluded from workflow counts, average steps and cost per completed workflow, and named in the report's limitations.
   Single cards paid by a wallet batch no longer add `execution_runs` rows, so execution counts change at activation. Note the activation date
   for investor reporting.
6. The owner explicitly approves the activation. Implementation approval of this build is not that approval. Record the approval's reference
   (who, when, where) and the retention decision of precondition 3 with the activation.
7. **The public privacy notice describes these records** (`/privacy`, "Execution history and deletion", EN and PT, shipped with this build).

## Staged rollout

1. **Release (this pull request, after the owner merges it).** Ships the certificate, the fixture and the `single-step-runs-migrate` operator command.
   `SHIPPED_MIGRATIONS` stays at 28; deploying applies nothing (`migrate.applied versions=none`).
2. **Every database consumer runs this release** (precondition 1).
3. **Rehearsal on a dedicated disposable Neon branch first** (never a Preview database shared with other branches: until this certificate is on
   `main`, every other preview build refuses schema 32). From the reviewed, built checkout, with a direct `DATABASE_MIGRATION_URL` for that branch
   set in the operator shell only (never committed, never pasted into chat or logs):
   - if the branch is below 31, bring it to 31 exactly as §21–§23 describe (`finops-migrate`, `finops-sync-migrate`, `position-purge-migrate`);
   - `node apps/reference-dapp/backend/admin-cli.ts single-step-runs-migrate --preview-branch <branch>` → `{ "applied": [32] }`; a rerun →
     `{ "applied": [] }`;
   - verify with the read-only queries below; restart the API and worker against the branch and confirm they start (schema compatible);
   - on that branch only, run one single-card workflow end to end from the Editor with test funds the owner controls, and confirm a multi-card
     workflow still runs as before.
4. **Production activation (owner decision, not authorized by this build).** Take a Neon restore point or branch, then from the reviewed checkout
   with the direct production `DATABASE_MIGRATION_URL`:

   ```sh
   node apps/reference-dapp/backend/admin-cli.ts single-step-runs-migrate --tenant default
   ```

   Expected output: `{ "tenantId": "default", "applied": [32] }`; a rerun prints `"applied": []`. The command checks schema compatibility, refuses
   below schema 31, verifies the fixture's SHA-256 against the certificate (`SINGLE_STEP_RUNS_MIGRATION_DIGEST_MISMATCH`,
   `SINGLE_STEP_RUNS_MIGRATION_NOT_CERTIFIED`), takes the standard migration advisory lock, verifies the whole ledger and applies only 0032 in one
   transaction. On its 5 s lock timeout (a long transaction holding `workflow_runs`) it rolls back completely and can be retried in a quieter moment.

## Verification (read-only)

```sql
SELECT version, name, sha256 FROM schema_migrations WHERE version >= 28 ORDER BY version;
SELECT pg_get_constraintdef(oid) FROM pg_constraint
  WHERE conrelid = 'workflow_runs'::regclass AND conname = 'workflow_runs_step_count_check';
SELECT count(*) FROM pg_constraint WHERE conrelid = 'workflow_runs'::regclass;
```

Expected: the ledger ends with `32 | single_step_runs | 1f388788b8e788fcc412585b38569260acea1e1cb24ec2cab3f2208270e5d14c`; the constraint reads
`CHECK (((step_count >= 2) AND (step_count <= 8)))` before 0032 and `CHECK (((step_count >= 1) AND (step_count <= 8)))` after (disposable
PostgreSQL 16.15). The constraint count must be the **same before and after on the target database**: record it before activation and compare.
Do not compare it with a fixed number. PostgreSQL 18 (Neon, CI) also records NOT NULL constraints in `pg_constraint`, so its count differs from
PostgreSQL 16; filter with `AND contype <> 'n'` to compare across versions. Any other difference stops the activation.

## Rollback

- **Before activation:** any build is a rollback target exactly as before (schema unchanged).
- **After activation, application rollback (code level): nothing to do in the database.** Any build carrying this certificate keeps serving schema
  32; a build carrying only the previous certificate (0029–0031) refuses it and must not be deployed. Once 0033 is active too, only a build
  carrying the 0029–0033 certificate serves the database. A rollback target that predates the
  single-card feature never creates a one-step run (its claim path refuses fewer than two steps, `WORKFLOW_RUN_NOT_SEQUENTIAL`). How such a
  build presents a one-step run created before the rollback is application behaviour, not proven by this build's database suites: prefer a
  rollback target that carries both this certificate and the single-card feature, and let open single-card runs settle first. Financial
  observation and reconciliation continue throughout.
- **Emergency reversal (owner decision, last resort):** valid **only while 0032 is the newest migration and no `workflow_runs` row has
  `step_count = 1`**. With 0033 applied, reverse 0033 first ([RELEASE-WORKFLOW-RUN-PURGE-0033.md](./RELEASE-WORKFLOW-RUN-PURGE-0033.md); possible
  only while no attempt was ever deleted): the block below refuses while 0033 is the newest migration. A one-step run can disappear only through
  0033's guarded deletion, whose permanent tombstone makes 0033 (and so this reversal) impossible, so after the first single-card run the reversal
  is no longer possible and the code-level rollback above is the only path; from then on 0031–0029 cannot be reversed either. One-step Editor approvals issued while 0032 was active are refused at their claim with the closed code
  `WORKFLOW_RUN_SINGLE_STEP_NOT_ENABLED` after a reversal. Let open ones expire (15 minutes) before relying on that. Run the
  block below in one session with the migration connection (for example `psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f <file>`). It takes
  the migration runner's advisory lock, refuses unless 0032 (exact identity) is the newest migration (`NOT_CERTIFIED_0032_HEAD`), locks
  `workflow_runs`, refuses if any one-step run exists (`SINGLE_STEP_RUNS_PRESENT`), restores the exact schema-31 constraint and removes only the
  0032 ledger row; on any refusal or error the transaction aborts and nothing changes. Afterwards the previous certificate serves the database
  again. Proven on disposable PostgreSQL by `packages/cloud-runtime/test/certificate-0032.pg.test.ts`, which runs this exact block.

```sql
-- Emergency reversal of 0032_single_step_runs (owner decision only; see RELEASE-SINGLE-STEP-RUNS-0032.md). One transaction with the migration
-- connection. Valid only while no workflow run has exactly one step; restores 0015's 2..8 step-count CHECK and removes only the 0032 ledger row.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- The migration runner's own advisory lock: no concurrent runner can add a migration between the check below and the ledger change.
SELECT pg_advisory_xact_lock(7340032001);
DO $$ BEGIN
  IF (SELECT max(version) FROM schema_migrations) <> 32 OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 32 AND name = 'single_step_runs'
    AND sha256 = '1f388788b8e788fcc412585b38569260acea1e1cb24ec2cab3f2208270e5d14c') THEN RAISE EXCEPTION 'NOT_CERTIFIED_0032_HEAD'; END IF;
END $$;
-- No one-step run can be created between the check below and the constraint change.
LOCK TABLE workflow_runs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM workflow_runs WHERE step_count = 1) THEN RAISE EXCEPTION 'SINGLE_STEP_RUNS_PRESENT'; END IF;
END $$;
ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_step_count_check, ADD CONSTRAINT workflow_runs_step_count_check CHECK (step_count BETWEEN 2 AND 8);
DELETE FROM schema_migrations WHERE version = 32 AND name = 'single_step_runs' AND sha256 = '1f388788b8e788fcc412585b38569260acea1e1cb24ec2cab3f2208270e5d14c';
COMMIT;
```

- Never delete workflow runs by hand (only an owner, through 0033's guarded procedure from History), edit the ledger by hand, or run other ad hoc
  DDL.

## Evidence and limits

Local evidence only: disposable loopback PostgreSQL 16 (CI runs PostgreSQL 18 in the certification pipeline).
`packages/cloud-runtime/test/certificate-0032.pg.test.ts` and `apps/reference-dapp/backend/single-step-runs-migrate.pg.test.ts` (see §24). No
production, preview or Neon database was touched; no migration was applied outside disposable test databases; no environment variable, gate or
fee policy changed.
