-- SPDX-License-Identifier: AGPL-3.0-only
-- Load policy.sql first. Works in a READ ONLY transaction and reads only the ledger and catalogs.
SET LOCAL search_path = pg_catalog, pg_temp;

WITH
policy AS (SELECT current_setting('flofi_acl.policy')::jsonb AS spec),
roles AS (
  SELECT x.key, x.value AS name, r.*
  FROM policy CROSS JOIN LATERAL jsonb_each_text(spec->'roles') AS x
  LEFT JOIN pg_roles r ON r.rolname = x.value
),
rels AS (
  SELECT c.* FROM pg_class c WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p','v','m','f','S')
),
routines AS (
  SELECT p.* FROM pg_proc p WHERE pronamespace = 'public'::regnamespace
),
columns AS (
  SELECT x.role, x."table", x.privilege, col.name
  FROM policy CROSS JOIN LATERAL jsonb_to_recordset(spec->'columns')
    AS x(role text, "table" text, privilege text, columns jsonb)
  CROSS JOIN LATERAL jsonb_array_elements_text(x.columns) AS col(name)
),
table_privs AS (
  SELECT r.key, c.relname, p.priv,
    has_table_privilege(r.oid, c.oid, p.priv) AS actual,
    coalesce(strpos(spec->'tables'->c.relname->>r.key, p.flag) > 0, false) AS expected,
    has_table_privilege(r.oid, c.oid, p.priv || ' WITH GRANT OPTION') AS grantable
  FROM roles r CROSS JOIN rels c CROSS JOIN policy
  CROSS JOIN (VALUES ('SELECT','S'), ('INSERT','I'), ('UPDATE','U'), ('DELETE','D'), ('TRUNCATE','T'),
                     ('REFERENCES','R'), ('TRIGGER','G'), ('MAINTAIN','M')) AS p(priv, flag)
  WHERE c.relkind <> 'S'
),
column_drift AS (
  SELECT r.key, c.relname, a.attname, p.priv, access.actual, access.required,
    has_column_privilege(r.oid, c.oid, a.attnum, p.priv || ' WITH GRANT OPTION') AS grantable
  FROM roles r CROSS JOIN rels c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(priv)
  JOIN table_privs t ON t.key = r.key AND t.relname = c.relname AND t.priv = p.priv
  CROSS JOIN LATERAL (
    SELECT has_column_privilege(r.oid, c.oid, a.attnum, p.priv) AS actual, t.expected OR EXISTS (
      SELECT 1 FROM columns x WHERE x.role = r.key AND x."table" = c.relname AND x.name = a.attname AND x.privilege = p.priv
    ) AS required
  ) AS access
  WHERE c.relkind <> 'S' AND (access.actual IS DISTINCT FROM access.required
    OR has_column_privilege(r.oid, c.oid, a.attnum, p.priv || ' WITH GRANT OPTION'))
),
sequence_privs AS (
  SELECT r.key, c.relname, p.priv,
    has_sequence_privilege(r.oid, c.oid, p.priv) AS actual
  FROM roles r CROSS JOIN rels c CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS p(priv)
  WHERE c.relkind = 'S'
),
routine_privs AS (
  SELECT r.key, replace(p.oid::regprocedure::text, 'public.', '') AS signature,
    has_function_privilege(r.oid, p.oid, 'EXECUTE') AS actual,
    r.key = 'runtime' AND spec->'purges' ? replace(p.oid::regprocedure::text, 'public.', '') AS expected,
    has_function_privilege(r.oid, p.oid, 'EXECUTE WITH GRANT OPTION') AS grantable
  FROM roles r CROSS JOIN routines p CROSS JOIN policy
),
default_acls AS (
  SELECT d.defaclrole::regrole::text AS owner, n.nspname AS schema, d.defaclobjtype AS kind, a.*
  FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclobjtype IN ('r','S','f') AND (n.nspname IS NULL OR n.nspname = 'public')
  UNION ALL
  SELECT spec->>'owner', NULL, 'f'::"char", a.*
  FROM policy JOIN pg_roles r ON r.rolname = spec->>'owner'
  CROSS JOIN LATERAL aclexplode(acldefault('f', r.oid)) a
  WHERE NOT EXISTS (SELECT 1 FROM pg_default_acl WHERE defaclrole = r.oid AND defaclnamespace = 0 AND defaclobjtype = 'f')
),
public_access AS (
  SELECT 'relation' AS kind, c.relname AS object, p.privilege_type
  FROM rels c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,
    acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) p WHERE p.grantee = 0
  UNION ALL
  SELECT 'column', c.relname || '.' || a.attname, p.privilege_type
  FROM rels c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  CROSS JOIN LATERAL aclexplode(a.attacl) p WHERE p.grantee = 0
  UNION ALL
  SELECT 'routine', f.oid::regprocedure::text, p.privilege_type
  FROM routines f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) p WHERE p.grantee = 0
),
role_status AS (
  SELECT r.key, r.name, r.oid IS NOT NULL AS exists, r.rolcanlogin,
    coalesce(rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls, false) AS elevated,
    ARRAY(SELECT roleid::regrole::text FROM pg_auth_members WHERE member = r.oid ORDER BY roleid) AS memberships,
    EXISTS (SELECT 1 FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid
      AND d.deptype = 'o' AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))) AS owns_objects,
    has_database_privilege(r.oid, current_database(), 'CONNECT') AS can_connect,
    has_database_privilege(r.oid, current_database(), 'CREATE') AS can_create_schema,
    has_schema_privilege(r.oid, 'public', 'USAGE') AS public_usage,
    ARRAY(SELECT nspname FROM pg_namespace n WHERE nspname !~ '^pg_(temp|toast_temp)_[0-9]+$'
      AND has_schema_privilege(r.oid, n.oid, 'CREATE') ORDER BY nspname) AS writable_schemas
  FROM roles r
),
ledger AS (
  SELECT count(*) AS entries, max(version) AS version,
    encode(sha256(convert_to(string_agg(version || ':' || name || ':' || sha256, E'\n' ORDER BY version), 'UTF8')), 'hex') AS digest,
    has_table_privilege(spec->>'owner', 'public.schema_migrations', 'SELECT')
      AND has_table_privilege(spec->>'owner', 'public.schema_migrations', 'INSERT')
      AND has_table_privilege(spec->>'owner', 'public.schema_migrations', 'UPDATE')
      AND has_table_privilege(spec->>'owner', 'public.schema_migrations', 'DELETE')
      AND (SELECT tableowner = spec->>'owner' FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations') AS owner_controls_ledger
  FROM public.schema_migrations CROSS JOIN policy GROUP BY spec
),
legacy_protections AS (
  SELECT NOT EXISTS (
    SELECT 1 FROM table_privs p WHERE key = 'runtime'
      AND relname IN ('schema_migrations','execution_purge_audit','workflow_run_purge_audit','execution_purge_permits','workflow_run_purge_permits')
      AND (actual IS DISTINCT FROM expected OR grantable)
  ) AND NOT EXISTS (
    SELECT 1 FROM column_drift d WHERE key = 'runtime'
      AND relname IN ('schema_migrations','execution_purge_audit','workflow_run_purge_audit','execution_purge_permits','workflow_run_purge_permits')
  ) AND NOT EXISTS (
    SELECT 1 FROM routine_privs WHERE key = 'runtime' AND expected AND (actual IS DISTINCT FROM true OR grantable)
  ) AND NOT EXISTS (
    SELECT 1 FROM policy, public_access WHERE kind = 'routine' AND spec->'purges' ? replace(object, 'public.', '')
  ) AND EXISTS (
    SELECT 1 FROM role_status WHERE key = 'runtime' AND exists AND rolcanlogin AND NOT elevated
      AND cardinality(memberships) = 0 AND NOT owns_objects AND NOT ('public' = ANY(writable_schemas))
  ) AS intact
),
table_report AS (
  SELECT relname, key,
    coalesce(array_agg(priv ORDER BY priv) FILTER (WHERE actual), ARRAY[]::text[]) AS current,
    coalesce(array_agg(priv ORDER BY priv) FILTER (WHERE expected), ARRAY[]::text[]) AS required,
    coalesce(array_agg(priv ORDER BY priv) FILTER (WHERE grantable), ARRAY[]::text[]) AS grant_options
  FROM table_privs GROUP BY relname, key
),
row_policy_checks AS (
  SELECT p.polname, c.relname, p.polcmd::text, p.polpermissive,
    ARRAY(SELECT coalesce(r.key, 'unknown:' || a.oid::regrole::text)
      FROM unnest(p.polroles) AS a(oid) LEFT JOIN roles r ON r.oid = a.oid ORDER BY coalesce(r.key, 'unknown:' || a.oid::regrole::text) COLLATE "C") AS role_keys,
    pg_get_expr(p.polqual, p.polrelid) AS predicate, pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression
  FROM pg_policy p JOIN rels c ON c.oid = p.polrelid
),
row_policy_fingerprint AS (
  SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) ORDER BY relname COLLATE "C", polname COLLATE "C")::text, '[]'), 'UTF8')), 'hex') AS digest
  FROM row_policy_checks p
),
history_guard_fingerprint AS (
  SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(guards) ORDER BY kind COLLATE "C", name COLLATE "C")::text, 'UTF8')), 'hex') AS digest
  FROM (
    SELECT 'routine' AS kind, p.oid::regprocedure::text AS name, pg_get_functiondef(p.oid) AS definition
    FROM routines p WHERE p.prokind IN ('f','p') AND p.prosecdef
    UNION ALL
    SELECT 'trigger' AS kind, c.relname || '.' || t.tgname, t.tgenabled::text || ' ' || pg_get_triggerdef(t.oid)
    FROM rels c JOIN pg_trigger t ON t.tgrelid = c.oid
    WHERE NOT t.tgisinternal AND t.tgfoid IN (SELECT oid FROM routines WHERE prosecdef)
  ) AS guards
),
issues AS (
  SELECT 'ledger identity or ownership' AS issue FROM policy
    WHERE NOT EXISTS (SELECT 1 FROM ledger WHERE digest = spec->>'ledger_sha256' AND owner_controls_ledger)
  UNION ALL SELECT 'role ' || key FROM role_status
    WHERE NOT exists OR NOT rolcanlogin OR elevated OR cardinality(memberships) > 0 OR owns_objects
      OR (key <> 'runtime' OR current_setting('flofi_acl.mode', true) = 'enforce')
         AND (NOT can_connect OR can_create_schema OR NOT public_usage OR cardinality(writable_schemas) > 0)
  UNION ALL SELECT 'table ' || key || '/' || relname || '/' || priv FROM table_privs
    WHERE (key <> 'runtime' OR current_setting('flofi_acl.mode', true) = 'enforce')
      AND (actual IS DISTINCT FROM expected OR grantable)
  UNION ALL SELECT 'column ' || key || '/' || relname || '.' || attname || '/' || priv FROM column_drift
    WHERE key <> 'runtime' OR current_setting('flofi_acl.mode', true) = 'enforce'
  UNION ALL SELECT 'sequence ' || key || '/' || relname || '/' || priv FROM sequence_privs
    WHERE actual AND (key <> 'runtime' OR current_setting('flofi_acl.mode', true) = 'enforce')
  UNION ALL SELECT 'routine ' || key || '/' || signature FROM routine_privs
    WHERE current_setting('flofi_acl.mode', true) = 'enforce' AND (actual IS DISTINCT FROM expected OR grantable)
  UNION ALL SELECT 'PUBLIC ' || kind || '/' || object || '/' || privilege_type FROM public_access
    WHERE current_setting('flofi_acl.mode', true) = 'enforce'
  UNION ALL SELECT 'default ACL ' || kind::text || '/' || coalesce(schema, '*') || '/' || grantee::text
    FROM default_acls d CROSS JOIN policy WHERE owner = spec->>'owner' AND (
      (current_setting('flofi_acl.mode', true) = 'enforce' AND d.grantee = 0)
      OR EXISTS (SELECT 1 FROM roles WHERE oid = d.grantee AND
        (key <> 'runtime' OR current_setting('flofi_acl.mode', true) = 'enforce'))
    )
  UNION ALL SELECT 'missing table ' || t.name FROM policy CROSS JOIN LATERAL jsonb_object_keys(spec->'tables') AS t(name)
    WHERE NOT EXISTS (SELECT 1 FROM rels WHERE relname = t.name AND relkind = 'r')
  UNION ALL SELECT 'purge function ' || x.signature FROM policy CROSS JOIN LATERAL jsonb_array_elements_text(spec->'purges') AS x(signature)
    WHERE NOT EXISTS (SELECT 1 FROM routines p WHERE replace(p.oid::regprocedure::text, 'public.', '') = x.signature
      AND prosecdef AND proowner::regrole::text = spec->>'owner'
      AND EXISTS (SELECT 1 FROM unnest(proconfig) AS config WHERE regexp_replace(config, '\s+', '', 'g') = 'search_path=pg_catalog,public,pg_temp'))
  UNION ALL SELECT 'row policy definitions' FROM policy CROSS JOIN row_policy_fingerprint
    WHERE current_setting('flofi_acl.mode', true) = 'enforce' AND digest IS DISTINCT FROM spec->>'row_policy_sha256'
  UNION ALL SELECT 'history guard definitions' FROM policy CROSS JOIN history_guard_fingerprint
    WHERE digest IS DISTINCT FROM spec->>'history_guard_sha256'
  UNION ALL SELECT 'row policies ' || t.name FROM policy
    CROSS JOIN LATERAL jsonb_each(spec->'managed_policies') AS t(name, policies)
    WHERE current_setting('flofi_acl.mode', true) = 'enforce' AND (
      NOT EXISTS (SELECT 1 FROM rels WHERE relname = t.name AND relrowsecurity AND NOT relforcerowsecurity)
      OR (SELECT array_agg(policyname::text ORDER BY policyname::text) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = t.name) IS DISTINCT FROM
         (SELECT array_agg(name ORDER BY name) FROM jsonb_array_elements_text(t.policies) AS p(name))
    )
  UNION ALL SELECT 'legacy protections' FROM legacy_protections WHERE NOT intact
),
report AS (SELECT coalesce(jsonb_agg(issue ORDER BY issue), '[]'::jsonb) AS findings FROM issues)
SELECT pg_catalog.set_config('flofi_acl.issues', findings::text, true) IS NOT NULL AS evaluated,
  findings AS issues,
  current_database() AS database,
  (SELECT to_jsonb(ledger) FROM ledger) AS migration_ledger,
  (SELECT intact FROM legacy_protections) AS existing_protections_intact,
  (SELECT digest FROM history_guard_fingerprint) AS history_guard_fingerprint,
  (SELECT digest FROM row_policy_fingerprint) AS row_policy_fingerprint,
  (SELECT jsonb_agg(to_jsonb(role_status) ORDER BY key) FROM role_status) AS roles,
  (SELECT jsonb_agg(to_jsonb(table_report) ORDER BY relname, key) FROM table_report) AS tables,
  (SELECT jsonb_agg(to_jsonb(column_drift) ORDER BY relname, key, attname, priv) FROM column_drift) AS column_drift,
  (SELECT jsonb_agg(to_jsonb(sequence_privs) ORDER BY relname, key, priv) FROM sequence_privs) AS sequences,
  (SELECT jsonb_agg(to_jsonb(routine_privs) ORDER BY signature, key) FROM routine_privs) AS routines,
  (SELECT jsonb_agg(to_jsonb(default_acls) ORDER BY owner, schema, kind, grantee, privilege_type) FROM default_acls) AS default_acls,
  (SELECT jsonb_agg(to_jsonb(public_access) ORDER BY kind, object, privilege_type) FROM public_access) AS public_access,
  (SELECT jsonb_agg(jsonb_build_object('table', c.relname, 'reference', pg_get_constraintdef(k.oid)) ORDER BY c.relname, k.conname)
    FROM rels c JOIN pg_constraint k ON k.conrelid = c.oid WHERE k.contype = 'f') AS foreign_keys,
  (SELECT jsonb_agg(to_jsonb(pg_policies) ORDER BY tablename, policyname) FROM pg_policies WHERE schemaname = 'public') AS row_policies,
  (SELECT jsonb_agg(jsonb_build_object('table', c.relname, 'trigger', t.tgname, 'enabled', t.tgenabled,
    'definition', pg_get_triggerdef(t.oid)) ORDER BY c.relname, t.tgname)
    FROM rels c JOIN pg_trigger t ON t.tgrelid = c.oid WHERE NOT t.tgisinternal) AS triggers,
  (SELECT jsonb_agg(jsonb_build_object('schema', nspname, 'owner', nspowner::regrole::text, 'acl', nspacl)
    ORDER BY nspname) FROM pg_namespace) AS schemas
FROM report;

DO $verify$
DECLARE
  issues jsonb := current_setting('flofi_acl.issues')::jsonb;
BEGIN
  IF current_setting('flofi_acl.mode', true) IN ('stage', 'enforce') AND issues <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FLOFI_ACL_VERIFICATION_FAILED: %', issues;
  END IF;
END
$verify$;
