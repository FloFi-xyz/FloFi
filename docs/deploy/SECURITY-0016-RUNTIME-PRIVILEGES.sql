-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001 (P0): runtime-role privilege remediation for 0016_owner_history_purge (environment step, not a
-- migration; 0016 itself is immutable and its ledger SHA-256 is unchanged).
--
-- 0016 names no role. Where the objects belong to a migration role while the API, worker and web tier connect as a separate runtime role whose
-- table rights come from `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO <runtime role>` (FloFi production), that
-- runtime role also received INSERT/UPDATE/DELETE on 0016's two PRIVATE tables:
--   * `execution_purge_permits`, the transaction-scoped capability that `protect_execution_history()` accepts as the only exception to the
--     append-only triggers of execution_runs, execution_logs, execution_log_segments and journal_entries; and
--   * `execution_purge_audit`, the immutable identity tombstone a permit must reference.
-- With them the runtime role could insert a tombstone and a permit naming ANY run (or any log, through an existing tombstone) inside its own
-- transaction and delete that run's append-only rows, a completed run's included, without the checked procedure `purge_unstarted_execution`.
-- The application never writes either table directly: only `purge_unstarted_execution` and `protect_execution_history` (both SECURITY DEFINER,
-- owned by the migration role) touch the permit table, and only the procedure writes the tombstone.
--
-- This file closes it and changes nothing else:
--   * the runtime role loses every privilege on `execution_purge_permits`;
--   * the runtime role keeps only SELECT on `execution_purge_audit` (owner History and privacy reports read the tombstone); INSERT, UPDATE,
--     DELETE, TRUNCATE, REFERENCES, TRIGGER (and MAINTAIN on PostgreSQL 17+) are revoked, column-level grants included;
--   * PUBLIC holds nothing on either table (0016's own `REVOKE ALL ... FROM PUBLIC`, asserted again);
--   * the runtime role keeps EXECUTE on `purge_unstarted_execution(text,text,text)` (granted again, idempotently: History's legitimate Delete),
--     and PUBLIC still cannot execute it.
-- No row is inserted, updated or deleted (the only row read is 0016's own ledger entry); no other table, function, role, membership or default
-- privilege changes; the 0033 objects (`workflow_run_purge_*`) are not touched.
--
-- Run it with the MIGRATION connection (the role that owns 0016's objects), naming the runtime role:
--   psql "$DATABASE_MIGRATION_URL" -X -v ON_ERROR_STOP=1 -v runtime_role=<runtime role> -f docs/deploy/SECURITY-0016-RUNTIME-PRIVILEGES.sql
-- One transaction. It takes the migration runner's advisory lock, bounds every lock wait (5 s) and the whole statement time (60 s), refuses unless
-- 0016 is applied with its exact certified identity (OWNER_HISTORY_PURGE_0016_NOT_CERTIFIED), refuses an unknown, superuser or owning runtime role
-- and a connection that cannot change the owner's grants, and verifies the result before COMMIT
-- (OWNER_HISTORY_PURGE_RUNTIME_PRIVILEGES_OPEN): no write left to the runtime role directly, through PUBLIC, through any role it belongs to
-- (inherited OR only reachable by SET ROLE) or a predefined role, and no CREATE in schema public (where an object could shadow a pg_catalog
-- function the SECURITY DEFINER procedure calls). Any refusal, error, lock timeout or lost connection rolls everything back: nothing changes.
-- Idempotent: a rerun changes nothing. Read-only pre/post verification: docs/deploy/SECURITY-0016-RUNTIME-PRIVILEGES.verify.sql. Runbook:
-- docs/deploy/SECURITY-0016-RUNTIME-PRIVILEGES.md. Proven on disposable PostgreSQL by
-- packages/cloud-runtime/test/security-0016-runtime-privileges.pg.test.ts, which runs this exact file.
BEGIN;
-- Security review: only pg_catalog resolves an unqualified name here, so no object planted in `public` can stand in for a check below.
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(7340032001);
SELECT set_config('flofi.runtime_role', :'runtime_role', true) IS NOT NULL AS runtime_role_named;
DO $guard$
DECLARE
  v_role text := current_setting('flofi.runtime_role');
  v_runtime oid;
  v_owner oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = 16 AND name = 'owner_history_purge'
      AND sha256 = 'a3c258cadd9d7865ad9d36d63ec0921fc47455bb3651c201074f3b0486b4be6f')
    OR to_regclass('public.execution_purge_permits') IS NULL OR to_regclass('public.execution_purge_audit') IS NULL
    OR to_regprocedure('public.purge_unstarted_execution(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'OWNER_HISTORY_PURGE_0016_NOT_CERTIFIED';
  END IF;
  SELECT oid INTO v_runtime FROM pg_roles WHERE rolname = v_role;
  IF v_runtime IS NULL THEN RAISE EXCEPTION 'RUNTIME_ROLE_NOT_FOUND'; END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE oid = v_runtime) THEN RAISE EXCEPTION 'RUNTIME_ROLE_IS_SUPERUSER'; END IF;
  FOR v_owner IN SELECT relowner FROM pg_class WHERE oid IN ('public.execution_purge_permits'::regclass, 'public.execution_purge_audit'::regclass)
      UNION SELECT proowner FROM pg_proc WHERE oid = 'public.purge_unstarted_execution(text,text,text)'::regprocedure LOOP
    -- A runtime role that is (or is a member of) the owner keeps the owner's rights whatever is revoked: this file cannot close that.
    IF pg_has_role(v_runtime, v_owner, 'MEMBER') THEN RAISE EXCEPTION 'RUNTIME_ROLE_IS_OWNER'; END IF;
    -- Only the owner (or a member that inherits its rights, or a superuser) changes the owner's grants; anything else would silently revoke nothing.
    IF NOT pg_has_role(current_user, v_owner, 'USAGE') AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      RAISE EXCEPTION 'MIGRATION_ROLE_REQUIRED';
    END IF;
  END LOOP;
  -- Security review: the owner of schema public (on PostgreSQL 15+ the database owner, through pg_database_owner) could drop and recreate
  -- the private tables whatever their grants say.
  IF pg_has_role(v_runtime, (SELECT nspowner FROM pg_namespace WHERE nspname = 'public'), 'MEMBER') THEN RAISE EXCEPTION 'RUNTIME_ROLE_OWNS_SCHEMA'; END IF;
END $guard$;
REVOKE ALL ON TABLE public.execution_purge_permits FROM PUBLIC;
REVOKE ALL ON TABLE public.execution_purge_audit FROM PUBLIC;
REVOKE ALL ON TABLE public.execution_purge_permits FROM :"runtime_role";
REVOKE ALL ON TABLE public.execution_purge_audit FROM :"runtime_role";
GRANT SELECT ON TABLE public.execution_purge_audit TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.purge_unstarted_execution(text, text, text) TO :"runtime_role";
DO $verify$
DECLARE
  v_role text := current_setting('flofi.runtime_role');
  v_privileges text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
    || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END;
  v_writes text := 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
    || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ', MAINTAIN' ELSE '' END;
  v_table text;
  v_privilege text;
  v_member record;
  v_open text[] := ARRAY[]::text[];
BEGIN
  -- has_*_privilege counts direct grants, PUBLIC, inherited memberships and predefined roles such as pg_write_all_data.
  FOREACH v_table IN ARRAY ARRAY['execution_purge_permits', 'execution_purge_audit'] LOOP
    FOREACH v_privilege IN ARRAY v_privileges LOOP
      IF has_table_privilege('public', 'public.' || v_table, v_privilege) THEN v_open := v_open || ('PUBLIC:' || v_table || ':' || v_privilege); END IF;
      CONTINUE WHEN v_table = 'execution_purge_audit' AND v_privilege = 'SELECT';
      IF has_table_privilege(v_role, 'public.' || v_table, v_privilege) THEN v_open := v_open || (v_table || ':' || v_privilege); END IF;
    END LOOP;
    IF has_any_column_privilege(v_role, 'public.' || v_table, CASE WHEN v_table = 'execution_purge_audit' THEN 'INSERT, UPDATE, REFERENCES'
        ELSE 'SELECT, INSERT, UPDATE, REFERENCES' END) THEN v_open := v_open || (v_table || ':COLUMN'); END IF;
  END LOOP;
  -- Security review: a role the runtime role belongs to without inheriting it (NOINHERIT, or a membership it can only SET ROLE to) still
  -- lets it write after SET ROLE: every role it is a member of, predefined ones included, must hold no write on either table.
  FOR v_member IN SELECT r.oid, r.rolname FROM pg_roles r WHERE r.rolname <> v_role AND pg_has_role(v_role, r.oid, 'MEMBER') LOOP
    FOREACH v_table IN ARRAY ARRAY['execution_purge_permits', 'execution_purge_audit'] LOOP
      IF has_table_privilege(v_member.oid, 'public.' || v_table, v_writes) THEN v_open := v_open || ('MEMBER:' || v_member.rolname || ':' || v_table); END IF;
    END LOOP;
  END LOOP;
  -- An object the runtime role could create in `public` could shadow a pg_catalog function the SECURITY DEFINER procedure calls
  -- (`SET search_path = pg_catalog,public,pg_temp` resolves an exact-signature public function first).
  IF has_schema_privilege(v_role, 'public', 'CREATE') THEN v_open := v_open || 'SCHEMA_PUBLIC:CREATE'::text; END IF;
  IF NOT has_table_privilege(v_role, 'public.execution_purge_audit', 'SELECT') THEN v_open := v_open || 'execution_purge_audit:SELECT_MISSING'::text; END IF;
  IF NOT has_function_privilege(v_role, 'public.purge_unstarted_execution(text,text,text)', 'EXECUTE') THEN
    v_open := v_open || 'purge_unstarted_execution:EXECUTE_MISSING'::text;
  END IF;
  IF has_function_privilege('public', 'public.purge_unstarted_execution(text,text,text)', 'EXECUTE') THEN
    v_open := v_open || 'PUBLIC:purge_unstarted_execution:EXECUTE'::text;
  END IF;
  IF cardinality(v_open) > 0 THEN RAISE EXCEPTION 'OWNER_HISTORY_PURGE_RUNTIME_PRIVILEGES_OPEN: %', array_to_string(v_open, ', '); END IF;
END $verify$;
SELECT has_table_privilege(:'runtime_role', 'public.execution_purge_audit', 'SELECT') AS runtime_reads_tombstones,
  has_table_privilege(:'runtime_role', 'public.execution_purge_audit', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS runtime_writes_tombstones,
  has_table_privilege(:'runtime_role', 'public.execution_purge_permits', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS runtime_touches_permits,
  has_function_privilege(:'runtime_role', 'public.purge_unstarted_execution(text,text,text)', 'EXECUTE') AS runtime_execute,
  has_function_privilege('public', 'public.purge_unstarted_execution(text,text,text)', 'EXECUTE') AS public_execute;
COMMIT;
