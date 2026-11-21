-- SPDX-License-Identifier: AGPL-3.0-only
-- Emergency reversal of 0033_workflow_run_purge (BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001; owner decision only; see
-- RELEASE-WORKFLOW-RUN-PURGE-0033.md). One transaction with the migration connection, for example:
--   psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f docs/deploy/RELEASE-WORKFLOW-RUN-PURGE-0033.reversal.sql
-- Valid only while 0033 (exact identity) is the newest migration AND no attempt was ever deleted (no tombstone): a deletion cannot be undone,
-- so once one exists this script refuses and changes nothing. It restores 0015's exact `workflow_run_append_only`, drops only what 0033 added
-- and removes only the 0033 ledger row. On any refusal or error the transaction aborts and nothing changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- The migration runner's own advisory lock: no concurrent runner can add a migration between the check below and the ledger change.
SELECT pg_advisory_xact_lock(7340032001);
DO $$ BEGIN
  IF (SELECT max(version) FROM schema_migrations) <> 33 OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 33 AND name = 'workflow_run_purge'
    AND sha256 = '26b8a6dbf15dddbca24924e10bf8748748691c400fcb0c70e1d63038607be2c2') THEN RAISE EXCEPTION 'NOT_CERTIFIED_0033_HEAD'; END IF;
END $$;
-- No deletion can start or commit between the check below and the drops (a running one holds the tombstone table and is waited for, up to 5 s).
LOCK TABLE workflow_run_purge_audit IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM workflow_run_purge_audit) THEN RAISE EXCEPTION 'WORKFLOW_RUN_PURGES_PRESENT'; END IF;
END $$;
-- 0015's function, byte for byte: every DELETE and UPDATE of a workflow-run record is refused again, with the same error.
CREATE OR REPLACE FUNCTION workflow_run_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WORKFLOW_RUN_RECORD_APPEND_ONLY' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
DROP FUNCTION purge_unsubmitted_workflow_run(text, text, text);
DROP TABLE workflow_run_purge_permits;
DROP TABLE workflow_run_purge_audit;
DELETE FROM schema_migrations WHERE version = 33 AND name = 'workflow_run_purge' AND sha256 = '26b8a6dbf15dddbca24924e10bf8748748691c400fcb0c70e1d63038607be2c2';
COMMIT;
