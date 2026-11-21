# FloFi: History deletion of single-card attempts that never reached a chain (BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001; migration 0033)

Status: **prepared and certified in this build, not applied anywhere.** Nothing in this build migrates a database to 0033: the ordinary deployment
migration (`migrate`, Railway API pre-deploy, Vercel preview bootstrap) still ships schema 28, and only the operator command below, run by the owner,
can apply 0033. **No production, preview or Neon database is changed by this build.**

## Purpose

Owner requirement: a single Editor card runs as a one-step USER_FUNDED workflow run (0032, [RELEASE-SINGLE-STEP-RUNS-0032.md](./RELEASE-SINGLE-STEP-RUNS-0032.md)).
Workflow-run records are append-only (0015/0023 no-delete triggers), so an attempt the owner abandoned before anything was sent could only be
archived. 0033 lets the **owner** delete, from History, exactly such an attempt — and nothing else. The database decides, under the run's row lock,
from the run's whole append-only history (`purge_unsubmitted_workflow_run`); the application only calls it.

The application starts single-card runs only where both 0032 and 0033 are active (`singleStepRunsSupported` in
`apps/reference-dapp/src/workflow-runs/pg-store.ts`), and owner history calls the procedure only when the ledger holds exactly this 0033 identity
(`packages/cloud-runtime/src/owner-history.ts`). Until 0033 is applied, deleting any workflow run answers `RUN_DELETE_REFUSED` (kept, as today);
archiving works.

## Identities

| | Version | Name | SHA-256 |
| --- | --- | --- | --- |
| Shipped by this build (unchanged) | 28 | `saved_recipients` | `ee73e909b6747c47c0bca877c8621d55229348177f0e7c6d68e47000a8fca64f` |
| Certified earlier (FinOps, optional) | 29 | `finops_ledger` | `9c04f837b7409622b6b485a21facafb25ce1d579ea2bd492ae859e71795c8de7` |
| Certified earlier (FinOps, optional) | 30 | `finops_sync` | `63b3c6ca82f69787fcb1d5527b7e3fe28b93b01cc8f5af0df85cc8efd597508b` |
| Certified earlier (position-history purge) | 31 | `position_history_purge` | `c7d4a08223df2a3d5f32d70902d1d5b2efd5ec961b67f146ea20c2a4afeb898d` |
| Certified earlier (single-step runs) | 32 | `single_step_runs` | `1f388788b8e788fcc412585b38569260acea1e1cb24ec2cab3f2208270e5d14c` |
| **Certified by this build** | 33 | `workflow_run_purge` | `26b8a6dbf15dddbca24924e10bf8748748691c400fcb0c70e1d63038607be2c2` |

Exact bytes: `packages/cloud-runtime/test/fixtures/0033_workflow_run_purge.sql`. Assessment:
[SCHEMA-COMPATIBILITY.md §25](./SCHEMA-COMPATIBILITY.md#25-certificate-0033_workflow_run_purge). Emergency reversal:
[RELEASE-WORKFLOW-RUN-PURGE-0033.reversal.sql](./RELEASE-WORKFLOW-RUN-PURGE-0033.reversal.sql). Migrations 0015, 0016 and 0023 are immutable and
unchanged. **Numbering:** 0029–0032 are certified ahead of the shipped history, so this change is 0033 and can only follow them; the 0033 command
never applies them and refuses any schema below 32 (`WORKFLOW_RUN_PURGE_REQUIRES_SCHEMA_32`).

## What 0033 allows, and what it never allows

Deletable (owner request, through the existing authenticated History action), only a one-step Editor run (`EDITOR_SESSION`) of an EVM owner, never
authorized or completed, whose approval handoff is that owner's own Editor claim, in one of two shapes:

- **`NO_WALLET_REQUEST`** — it ended (cancelled, failed or expired) before any wallet request existed: no group was ever prepared, authorized,
  submitted or reconciled.
- **`WALLET_REJECTED_VERIFIED`** — it was ended after the owner's wallet **rejected** its one wallet batch, and the server proved from the chain,
  after the batch's on-chain deadline, that the batch was never sent: the owner's latest and pending nonce still equal the nonce recorded at
  preparation, and no token Transfer/Approval or ERC-4337 user operation of the owner exists since the preparation block
  (`apps/reference-dapp/src/user-funded/decline-proof.ts`). Batches with native value or a sponsorship are never proven, and a group prepared more
  than once never qualifies.

Both are checked against a **closed allowlist** of the exact events the run store writes for them; any other event, code or detail refuses.

Always kept (Archive only): anything authorized, signed, submitted, broadcast, pending, uncertain or of unknown outcome, partially or fully
executed, completed, halted or still open; Circle permits and user operations; delegated authorizations or executions; developer approvals;
multi-step runs and every requester other than the Editor; anything under an active legal hold or with a Support text about it; anything a worker
holds (a LEASED work item) or another open work item names; a handoff with a live approval signing session; anything of another owner or tenant
(`RUN_NOT_FOUND`).

A deletion removes the run, its steps, groups and events, its approval handoff (the approval link can never be claimed again, and no run can be
created for it again), its own advance work items and its History archive marker, in one transaction, and leaves an **immutable tombstone**
(`workflow_run_purge_audit`: tenant, run id, handoff id, owner, shape, final state, the run's creation time, the number of events deleted, when — no
strategy, amount, recipient, hash, code or signature). A repeat answers `DELETED`; History shows it deleted. Privacy access and erasure still find
Support texts written later about a deleted attempt through the tombstone.

## Preconditions (all required before production activation)

1. **This certificate is deployed to every database consumer**: Vercel Production, the Railway API and the Railway worker, plus any preview that
   shares the database. Confirm each deployment's commit. A build carrying only the previous certificate (0029–0032) refuses schema 33
   (`MIGRATION_HISTORY_MISMATCH`), so a consumer left behind would stop serving the moment 0033 is applied.
2. **The database is at exactly schema 32**: 0029, 0030, 0031 and 0032 already applied by their own owner-run procedures (`finops-migrate`,
   `finops-sync-migrate`, `position-purge-migrate`, `single-step-runs-migrate`; see RELEASE-SINGLE-STEP-RUNS-0032.md). The command refuses anything
   below 32 and, on 33, applies nothing.
3. **Retention basis approved (owner / legal)** for the records single-card runs keep (every attempt that is not one of the two deletable shapes)
   and for the tombstone of a deleted attempt (precondition 3 of RELEASE-SINGLE-STEP-RUNS-0032.md). The tombstone (`workflow_run_purge_audit`:
   run and handoff ids, the owner's public wallet address, shape, final state, created and deleted times) and the owner-history `DELETED` event are
   **permanent**: no procedure erases them, privacy erasure included (it reports them as retained). Legal either accepts that indefinite retention
   or requires a later certified tombstone-retention migration. Record the decision's reference.
4. **The public privacy notice describes it** (`/privacy`, "Execution history and deletion" / "Histórico de execuções e exclusão", EN and PT,
   shipped with this build): what is kept, the narrow deletion scope, the permanent tombstone and the backup window.
5. **Irreversibility accepted.** After the first owner deletion, 0033 can no longer be reversed (a deletion cannot be undone; its tombstone is
   permanent), and because the 0032 reversal refuses unless 0032 is the newest migration, 0032 — and with it 0031, 0030 and 0029 — cannot be reversed
   either. A one-step run, which already makes 0032 irreversible, can only disappear through this guarded deletion, which makes 0033 irreversible.
6. The owner explicitly approves the activation. Implementation approval of this build is not that approval. Record the approval's reference
   (who, when, where) with the activation, together with the retention decision of precondition 3.

## Staged rollout

1. **Release (this pull request, after the owner merges it).** Ships the certificate, the fixture, the `workflow-run-purge-migrate` operator command
   and the application code that calls the procedure only under this exact ledger identity. `SHIPPED_MIGRATIONS` stays at 28; deploying applies
   nothing (`migrate.applied versions=none`).
2. **Every database consumer runs this release** (precondition 1).
3. **Rehearsal on a dedicated disposable Neon branch first** (never a Preview database shared with other branches: until this certificate is on
   `main`, every other preview build refuses schema 33). From the reviewed, built checkout, with a direct `DATABASE_MIGRATION_URL` for that branch
   set in the operator shell only (never committed, never pasted into chat or logs):
   - if the branch is below 32, bring it to 32 exactly as their procedures describe (`finops-migrate`, `finops-sync-migrate`,
     `position-purge-migrate`, `single-step-runs-migrate`);
   - record the verification values below **before** 0033 on that branch;
   - `node apps/reference-dapp/backend/admin-cli.ts workflow-run-purge-migrate --preview-branch <branch>` → `{ "applied": [33] }`; a rerun →
     `{ "applied": [] }`;
   - verify with the queries below; restart the API and worker against the branch and confirm they start (schema compatible);
   - on that branch only, with test funds the owner controls: start one single card and end it before confirming in the wallet, then delete it from
     History (expect `DELETED`); reject one in the wallet, end it once the batch has expired on chain and delete it (expect `DELETED`); confirm one,
     let it complete, and confirm Delete answers `RUN_DELETE_REFUSED` while Archive works.
4. **Production activation (owner decision, not authorized by this build).** Take a Neon restore point or branch **immediately before**
   activation. It exists only to undo a failed activation **before any traffic writes on schema 33**: single-card runs can start the moment 0033
   commits (`singleStepRunsSupported` reads the ledger on every call), so restoring it later would lose real financial evidence, and after an owner
   deletion it would bring back personal data and identities owners deleted (and tombstoned). Delete that branch, and every rehearsal branch made
   from production (each is a copy of production data), once activation is verified; never use them as backups. Neon point-in-time history keeps a
   deleted attempt's content (strategy, amounts, recipients, wallets) until its history window passes. Then, from the
   reviewed checkout with the direct production `DATABASE_MIGRATION_URL`:

   ```sh
   node apps/reference-dapp/backend/admin-cli.ts workflow-run-purge-migrate --tenant default
   ```

   Expected output: `{ "tenantId": "default", "applied": [33] }`; a rerun prints `"applied": []`. The command checks schema compatibility, refuses
   below schema 32, verifies the fixture's SHA-256 against the certificate (`WORKFLOW_RUN_PURGE_MIGRATION_DIGEST_MISMATCH`,
   `WORKFLOW_RUN_PURGE_MIGRATION_NOT_CERTIFIED`), takes the standard migration advisory lock, verifies the whole ledger and applies only 0033 in one
   transaction. Its only table lock is the short SHARE ROW EXCLUSIVE on `tenants` the tombstone's foreign key needs; on its 5 s lock timeout (a
   long transaction writing `tenants`) it rolls back completely and can be retried in a quieter moment.

## Verification (read-only, except the rolled-back probe)

```sql
SELECT version, name, sha256 FROM schema_migrations WHERE version >= 28 ORDER BY version;
SELECT md5(pg_get_functiondef('workflow_run_append_only()'::regprocedure));
SELECT to_regclass('workflow_run_purge_audit') AS tombstones, to_regclass('workflow_run_purge_permits') AS permits;
SELECT (SELECT count(*) FROM workflow_run_purge_audit) AS deleted, (SELECT count(*) FROM workflow_run_purge_permits) AS open_permits,
  has_function_privilege('public', 'purge_unsubmitted_workflow_run(text,text,text)', 'EXECUTE') AS public_execute,
  has_function_privilege(current_user, 'purge_unsubmitted_workflow_run(text,text,text)', 'EXECUTE') AS runtime_execute,
  has_table_privilege(current_user, 'workflow_run_purge_audit', 'SELECT') AS runtime_reads_tombstones;
-- Run the last query as the role the API and the web tier connect with: both runtime_* columns must be true (EXECUTE and SELECT are revoked
-- from PUBLIC, so the runtime role must own these objects, as it owns 0016's).
-- On a database with at least one workflow run: a plain DELETE is still refused with 0015's error, and nothing changes.
BEGIN;
DELETE FROM workflow_run_events WHERE event_id = (SELECT min(event_id) FROM workflow_run_events);
ROLLBACK;
```

Expected: the ledger ends with `33 | workflow_run_purge | 26b8a6dbf15dddbca24924e10bf8748748691c400fcb0c70e1d63038607be2c2`; `md5(...)` is
`e0fddfad32606d18b69a69b2202a0c29` before 0033 (0015's function) and `91282e520832e7cb272f132bafa61251` after, on disposable PostgreSQL 16.15
(`pg_get_functiondef` is regenerated by the server, so record the rehearsal's own two values on the Neon version and compare production against
those); both tables exist; `deleted = 0`, `open_permits = 0`, `public_execute = false` right after activation; the probe fails with
`WORKFLOW_RUN_RECORD_APPEND_ONLY` (SQLSTATE 23000) and the `ROLLBACK` leaves everything as it was. Any other difference stops the activation.

## Rollback

- **Before activation:** any build is a rollback target exactly as before (schema unchanged).
- **After activation, application rollback (code level): nothing to do in the database.** Only a build carrying this certificate (0029–0033)
  serves schema 33; a build carrying only the previous certificate (0029–0032) refuses it and must not be deployed. Financial observation and
  reconciliation continue throughout.
- **Stop new deletions without touching the schema:** set the existing `FLOFI_OWNER_HISTORY=read-only` wherever owner history is served
  (deletions and archives answer `HISTORY_READ_ONLY`; no record changes). This build changes no environment variable; this is the existing switch.
- **Emergency reversal (owner decision, last resort), only before any deletion:** run
  [RELEASE-WORKFLOW-RUN-PURGE-0033.reversal.sql](./RELEASE-WORKFLOW-RUN-PURGE-0033.reversal.sql) in one session with the migration connection
  (`psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f docs/deploy/RELEASE-WORKFLOW-RUN-PURGE-0033.reversal.sql`). It takes the migration runner's
  advisory lock, refuses unless 0033 (exact identity) is the newest migration (`NOT_CERTIFIED_0033_HEAD`), locks the tombstone table, refuses once any
  attempt was deleted (`WORKFLOW_RUN_PURGES_PRESENT`), restores 0015's `workflow_run_append_only` byte for byte, drops only what 0033 added and removes
  only the 0033 ledger row; on any refusal or error the transaction aborts and nothing changes. Afterwards the previous certificate (0029–0032) serves
  the database again and the 0032 reversal becomes possible again under its own conditions. Proven on disposable PostgreSQL by
  `packages/cloud-runtime/test/certificate-0033.pg.test.ts`, which runs this exact file.
- **After the first deletion** the reversal refuses: keep 0033, use the code-level rollback above, and `FLOFI_OWNER_HISTORY=read-only` if deletions
  must stop. **Never restore a restore point or branch that predates owner deletions** (it would resurrect data the owner deleted), never delete
  workflow runs by hand, edit the tombstones or the ledger, or run other ad hoc DDL.

## Evidence and limits

Local evidence only: disposable loopback PostgreSQL 16 (CI runs PostgreSQL 18 in the certification pipeline).
`packages/cloud-runtime/test/certificate-0033.pg.test.ts`, `apps/reference-dapp/backend/owner-history.pg.test.ts` and
`apps/reference-dapp/backend/workflow-run-purge-migrate.pg.test.ts` (see SCHEMA-COMPATIBILITY.md §25). The rejected-batch proof is the
application's (`decline-proof.ts`, exercised on MOCKED chains); the database trusts the verification event, which only the application writes, and
does not read the chain. No production, preview or Neon database was touched; no migration was applied outside disposable test databases; no
environment variable, gate or fee policy changed.

## Notes

- **Legal holds per subject.** A RUN hold names one run (or its handoff) and a TENANT hold covers every owner; there is no hold for one subject's
  future attempts. To keep one person's future attempts, place RUN holds as they appear, or a TENANT hold.
- **FinOps.** Deleted attempts leave the single-card counts, including for closed periods (stated in the report's limitations); completed runs
  and costs are unaffected.
- **Data-subject requests.** Access reports the subject's workflow runs (by state and step count) and the tombstones of deleted attempts;
  erasure reports both as retained (`workflowRunRecordsNotInScope`, `deletedAttemptTombstonesRetained`).
