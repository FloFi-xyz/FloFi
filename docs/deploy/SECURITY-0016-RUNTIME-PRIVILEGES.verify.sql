-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001 (P0): READ-ONLY verification of 0016's runtime-role privileges, before and after
-- docs/deploy/SECURITY-0016-RUNTIME-PRIVILEGES.sql. Only SELECTs and SET LOCALs inside a READ ONLY transaction: it changes nothing, writes no row,
-- takes no lock beyond ordinary reads and prints no secret (role names, ACLs and counts only; no run, owner, address or byte).
--   psql "$DATABASE_MIGRATION_URL" -X -v ON_ERROR_STOP=1 -v runtime_role=<runtime role> -f docs/deploy/SECURITY-0016-RUNTIME-PRIVILEGES.verify.sql
-- Expected after the remediation: `runtime_reads_tombstones = t`, `runtime_writes_tombstones = f`, `runtime_touches_permits = f`,
-- `runtime_column_writes = f`, `runtime_member_writes = f`, `runtime_creates_in_public = f`, `runtime_execute = t`, `public_execute = f`,
-- `public_touches_tables = f`, and every row of the effective-privilege table false except execution_purge_audit/SELECT (MAINTAIN rows are empty
-- on PostgreSQL 16, which has no such privilege). Before it, where the runtime role holds the owner's default table privileges,
-- `runtime_writes_tombstones`, `runtime_touches_permits` and `runtime_column_writes` are `t` (the exposure). On PostgreSQL 17+ MAINTAIN counts as
-- a write in this summary exactly as in the remediation's own check.
-- The integrity section reads 0 in every column except `tombstones` (legitimate owner deletions) on a database where only the checked procedure
-- ever deleted execution history: a permit that outlived its transaction, a tombstone without the owner's History event, a tombstone whose run
-- or log still exists, an execution log with a missing segment, log bytes that no longer match their recorded digests or length, or a journal
-- with a missing entry is not produced by the procedure and is investigated first.
-- These are heuristics, not proof, and the list of what they cannot see is not exhaustive: any forgery that also restores every invariant
-- counted here is invisible. Examples: deleting a whole log no run references (an INTENT log) under a permit that names an existing tombstone;
-- rewriting a log's bytes and updating its recorded length and digest; a forged tombstone written with a forged History event, for a run that
-- was then deleted completely or for an identity that never existed. Only the database's own history (point-in-time restore, logs) can rule
-- those out.
BEGIN TRANSACTION READ ONLY;
-- Only pg_catalog resolves an unqualified name (no object in `public` can stand in for a check); every table is schema-qualified.
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
-- 1. Identity: 0016 exactly as certified, and the ledger head.
SELECT version, name, sha256, sha256 = 'a3c258cadd9d7865ad9d36d63ec0921fc47455bb3651c201074f3b0486b4be6f' AS certified,
  (SELECT max(version) FROM public.schema_migrations) AS ledger_head
FROM public.schema_migrations WHERE version = 16;
-- 2. The runtime role, its attributes and every role it belongs to (an inherited role's grants count as its own).
SELECT r.rolname, r.rolsuper, r.rolinherit, r.rolbypassrls, r.rolcanlogin,
  coalesce((SELECT string_agg(g.rolname, ', ' ORDER BY g.rolname) FROM pg_roles g WHERE g.oid <> r.oid AND pg_has_role(r.oid, g.oid, 'MEMBER')), '') AS member_of
FROM pg_roles r WHERE r.rolname = :'runtime_role';
-- 3. Owners and raw ACLs of the objects concerned (0016's private tables and its procedure).
SELECT 'table' AS kind, c.relname AS object, pg_get_userbyid(c.relowner) AS owner, coalesce(c.relacl::text, '(default)') AS acl,
  coalesce((SELECT string_agg(a.attname || '=' || a.attacl::text, '; ') FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL), '') AS column_acl
FROM pg_class c WHERE c.oid IN ('public.execution_purge_permits'::regclass, 'public.execution_purge_audit'::regclass)
UNION ALL
SELECT 'function', p.proname, pg_get_userbyid(p.proowner), coalesce(p.proacl::text, '(default)'), CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE '' END
FROM pg_proc p WHERE p.oid = 'public.purge_unstarted_execution(text,text,text)'::regprocedure
ORDER BY 1, 2;
-- 4. Effective privileges of the runtime role and of PUBLIC (direct, PUBLIC, inherited, predefined roles), one row per table and privilege.
SELECT t.object, p.privilege,
  CASE WHEN p.privilege <> 'MAINTAIN' OR current_setting('server_version_num')::int >= 170000 THEN has_table_privilege(:'runtime_role', 'public.' || t.object, p.privilege) END AS runtime,
  CASE WHEN p.privilege <> 'MAINTAIN' OR current_setting('server_version_num')::int >= 170000 THEN has_table_privilege('public', 'public.' || t.object, p.privilege) END AS public
FROM (VALUES ('execution_purge_audit'), ('execution_purge_permits')) t(object)
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p(privilege)
ORDER BY 1, 2;
-- 5. Summary (the same columns the remediation prints before COMMIT, plus PUBLIC on the tables).
SELECT has_table_privilege(:'runtime_role', 'public.execution_purge_audit', 'SELECT') AS runtime_reads_tombstones,
  has_table_privilege(:'runtime_role', 'public.execution_purge_audit', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ',MAINTAIN' ELSE '' END) AS runtime_writes_tombstones,
  has_table_privilege(:'runtime_role', 'public.execution_purge_permits', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ',MAINTAIN' ELSE '' END) AS runtime_touches_permits,
  has_any_column_privilege(:'runtime_role', 'public.execution_purge_permits', 'SELECT,INSERT,UPDATE,REFERENCES')
    OR has_any_column_privilege(:'runtime_role', 'public.execution_purge_audit', 'INSERT,UPDATE,REFERENCES') AS runtime_column_writes,
  EXISTS (SELECT 1 FROM pg_roles r, (VALUES ('public.execution_purge_permits'), ('public.execution_purge_audit')) t(object)
    WHERE r.rolname <> :'runtime_role' AND pg_has_role(:'runtime_role', r.oid, 'MEMBER')
      AND (has_table_privilege(r.oid, t.object, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ',MAINTAIN' ELSE '' END)
        OR has_any_column_privilege(r.oid, t.object, 'INSERT,UPDATE,REFERENCES')
        OR has_schema_privilege(r.oid, 'public', 'CREATE'))) AS runtime_member_writes,
  has_schema_privilege(:'runtime_role', 'public', 'CREATE') AS runtime_creates_in_public,
  has_function_privilege(:'runtime_role', 'public.purge_unstarted_execution(text,text,text)', 'EXECUTE') AS runtime_execute,
  has_function_privilege('public', 'public.purge_unstarted_execution(text,text,text)', 'EXECUTE') AS public_execute,
  has_table_privilege('public', 'public.execution_purge_permits', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_table_privilege('public', 'public.execution_purge_audit', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS public_touches_tables;
-- 6. Default privileges (they are why tables created later reach the runtime role; this remediation does not change them).
SELECT pg_get_userbyid(d.defaclrole) AS grantor, CASE WHEN d.defaclnamespace = 0 THEN '(all schemas)' ELSE d.defaclnamespace::regnamespace::text END AS schema,
  d.defaclobjtype::text AS type,
  d.defaclacl::text AS acl
FROM pg_default_acl d ORDER BY 1, 2, 3;
-- 7. Integrity at rest (counts only). Every column but `tombstones` is 0 where only the checked procedure ever deleted execution history (see
--    the header for what no count can see; that list is not exhaustive).
SELECT (SELECT count(*) FROM public.execution_purge_permits) AS open_permits,
  (SELECT count(*) FROM public.execution_purge_audit) AS tombstones,
  (SELECT count(*) FROM public.execution_purge_audit a WHERE NOT EXISTS (SELECT 1 FROM public.owner_history_events e WHERE e.tenant_id = a.tenant_id
    AND e.owner_account = a.owner_account AND e.kind = 'EXECUTION_RUN' AND e.record_id = a.run_id AND e.action = 'DELETED')) AS tombstones_without_history_event,
  (SELECT count(*) FROM public.execution_purge_audit a WHERE EXISTS (SELECT 1 FROM public.execution_runs r WHERE r.tenant_id = a.tenant_id AND r.run_id = a.run_id)
    OR EXISTS (SELECT 1 FROM public.journal_entries j WHERE j.tenant_id = a.tenant_id AND j.run_id = a.run_id)
    OR EXISTS (SELECT 1 FROM public.execution_logs l WHERE l.tenant_id = a.tenant_id AND l.namespace = a.namespace AND l.name = a.log_name)) AS tombstones_with_live_records,
  (SELECT count(*) FROM public.execution_logs l WHERE (SELECT count(*) FROM public.execution_log_segments s WHERE s.tenant_id = l.tenant_id AND s.namespace = l.namespace
    AND s.name = l.name) <> l.segment_count) AS logs_missing_segments,
  -- Data-privacy review: log bytes rewritten without updating their recorded digest or length (a run's log is its financial evidence).
  (SELECT count(*) FROM public.execution_logs l WHERE encode(sha256(coalesce((SELECT string_agg(s.bytes, ''::bytea ORDER BY s.seq) FROM public.execution_log_segments s
    WHERE s.tenant_id = l.tenant_id AND s.namespace = l.namespace AND s.name = l.name), ''::bytea)), 'hex') <> l.content_sha256
    OR (SELECT coalesce(sum(octet_length(s.bytes)), 0) FROM public.execution_log_segments s WHERE s.tenant_id = l.tenant_id AND s.namespace = l.namespace
      AND s.name = l.name) <> l.byte_length) AS logs_with_digest_mismatch,
  (SELECT count(*) FROM public.execution_log_segments s WHERE encode(sha256(s.bytes), 'hex') <> s.segment_sha256) AS segments_with_digest_mismatch,
  (SELECT count(*) FROM (SELECT 1 FROM public.journal_entries GROUP BY tenant_id, run_id HAVING count(*) <> max(sequence) + 1 OR min(sequence) <> 0) j) AS journals_with_gaps;
COMMIT;
