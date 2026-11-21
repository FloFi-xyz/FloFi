-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: runtime-role provisioning for 0033_workflow_run_purge (environment step, not a migration).
--
-- Migrations are role-agnostic: 0033 revokes its objects from PUBLIC and names no role. A database whose objects are owned by a migration role
-- while the API, worker and web tier connect as a separate runtime role (FloFi production: `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT,
-- UPDATE, DELETE ON TABLES TO <runtime role>`) needs this file right after 0033, because there
--   * the runtime role cannot EXECUTE `purge_unsubmitted_workflow_run`, so History's Delete of a deletable attempt fails closed; and
--   * the default privileges give the runtime role INSERT/UPDATE/DELETE on the PRIVATE permit table and on the tombstone, so it could forge a
--     tombstone and a permit and delete ANY run's append-only rows (a completed run's too) without the checked procedure.
-- This file closes both: the runtime role keeps only SELECT on the tombstone (History and privacy reports read it) and EXECUTE on the checked
-- procedure, and loses every privilege on the permit table, which only that procedure (SECURITY DEFINER, owned by the migration role) and 0015's
-- redefined trigger function (SECURITY DEFINER) ever touch. Nothing else changes: no row, no other object, no other role.
--
-- Run it with the migration connection, in the same session immediately after 0033 (or in the same transaction), naming the runtime role:
--   psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -v runtime_role=<runtime role> -f docs/deploy/RELEASE-WORKFLOW-RUN-PURGE-0033.runtime-privileges.sql
-- It is idempotent, takes the migration runner's advisory lock and refuses unless 0033 (exact identity) is applied (WORKFLOW_RUN_PURGE_NOT_ACTIVE).
-- A database where one role owns the objects and also serves the runtime (the test harness) does not need it. The documented 0033 reversal
-- drops these objects and with them these grants. Proven by packages/cloud-runtime/test/certificate-0033.pg.test.ts, which runs this exact file.
BEGIN;
SELECT pg_advisory_xact_lock(7340032001);
SET LOCAL lock_timeout = '5s';
DO $guard$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 33 AND name = 'workflow_run_purge'
      AND sha256 = '26b8a6dbf15dddbca24924e10bf8748748691c400fcb0c70e1d63038607be2c2') THEN
    RAISE EXCEPTION 'WORKFLOW_RUN_PURGE_NOT_ACTIVE';
  END IF;
END $guard$;
REVOKE ALL ON workflow_run_purge_permits FROM :"runtime_role";
REVOKE ALL ON workflow_run_purge_audit FROM :"runtime_role";
GRANT SELECT ON workflow_run_purge_audit TO :"runtime_role";
GRANT EXECUTE ON FUNCTION purge_unsubmitted_workflow_run(text, text, text) TO :"runtime_role";
COMMIT;
