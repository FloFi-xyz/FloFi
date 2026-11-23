-- SPDX-License-Identifier: AGPL-3.0-only
-- Run after policy.sql and before verify.sql in one transaction (see the build runbook).
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(7340032001);

DO $apply$
DECLARE
  policy constant jsonb := current_setting('flofi_acl.policy')::jsonb;
  mode constant text := current_setting('flofi_acl.mode');
  owner_role constant text := policy->>'owner';
  runtime_role constant text := policy->'roles'->>'runtime';
  actor record;
  relation record;
  rule record;
  object_type text;
  role_sql text;
  grants text;
  routine text;
BEGIN
  IF mode NOT IN ('stage', 'enforce') OR current_user <> owner_role OR session_user <> owner_role
     OR NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = current_user::regrole)
     OR NOT has_schema_privilege(current_user, 'public', 'CREATE WITH GRANT OPTION') THEN
    RAISE EXCEPTION 'FLOFI_ACL_EXPECTED_DATABASE_OWNER_AND_MODE';
  END IF;

  IF (SELECT encode(sha256(convert_to(string_agg(version || ':' || name || ':' || sha256, E'\n' ORDER BY version), 'UTF8')), 'hex')
        FROM public.schema_migrations) IS DISTINCT FROM policy->>'ledger_sha256' THEN
    RAISE EXCEPTION 'FLOFI_ACL_SCHEMA_HISTORY_MISMATCH';
  END IF;

  IF (SELECT count(DISTINCT value) FROM jsonb_each_text(policy->'roles')) <> 4 THEN
    RAISE EXCEPTION 'FLOFI_ACL_DUPLICATE_ROLES';
  END IF;
  FOR actor IN SELECT key, value AS name FROM jsonb_each_text(policy->'roles') LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE rolname = actor.name AND rolname <> owner_role AND rolcanlogin
        AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass
          AND d.refobjid = r.oid AND d.deptype = 'o' AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database())))
    ) THEN
      RAISE EXCEPTION 'FLOFI_ACL_UNSAFE_ROLE: %', actor.key;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_class c WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p','v','m','f','S')
      AND (relowner <> current_user::regrole OR (relkind <> 'S' AND NOT (policy->'tables' ? relname)))
  ) OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(policy->'tables') AS t(name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE relnamespace = 'public'::regnamespace AND relname = t.name AND relkind = 'r')
  ) OR EXISTS (
    SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proowner <> current_user::regrole
  ) THEN
    RAISE EXCEPTION 'FLOFI_ACL_PUBLIC_INVENTORY_MISMATCH';
  END IF;

  -- Both phases preserve the protection already activated on the legacy runtime.
  IF has_schema_privilege(runtime_role, 'public', 'CREATE')
    OR EXISTS (
      SELECT 1 FROM (VALUES ('schema_migrations'), ('execution_purge_audit'), ('workflow_run_purge_audit'),
                           ('execution_purge_permits'), ('workflow_run_purge_permits')) AS t(name)
      CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('TRIGGER'), ('REFERENCES'), ('MAINTAIN')) AS p(priv)
      WHERE has_table_privilege(runtime_role, format('public.%I', t.name), p.priv)
         OR CASE WHEN p.priv IN ('INSERT', 'UPDATE', 'REFERENCES')
                 THEN has_any_column_privilege(runtime_role, format('public.%I', t.name), p.priv) ELSE false END
    ) OR has_any_column_privilege(runtime_role, 'public.execution_purge_permits', 'SELECT')
      OR has_any_column_privilege(runtime_role, 'public.workflow_run_purge_permits', 'SELECT') THEN
    RAISE EXCEPTION 'FLOFI_ACL_EXISTING_PROTECTIONS_REQUIRED';
  END IF;

  -- In the staged phase only new logins are touched. The legacy role and PUBLIC keep their existing grants.
  FOR actor IN
    SELECT key, value AS name, format('%I', value) AS grantee FROM jsonb_each_text(policy->'roles')
      WHERE mode = 'enforce' OR key <> 'runtime'
    UNION ALL SELECT NULL, NULL, 'PUBLIC' WHERE mode = 'enforce'
  LOOP
    role_sql := actor.grantee;
    EXECUTE format('REVOKE CREATE ON DATABASE %I FROM %s', current_database(), role_sql);
    EXECUTE format('REVOKE ALL ON SCHEMA public FROM %s', role_sql);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %s', role_sql);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %s', role_sql);
    EXECUTE format('REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM %s', role_sql);
    FOR relation IN
      SELECT c.relname, string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) AS cols
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m','f')
        AND a.attacl IS NOT NULL
      GROUP BY c.relname
    LOOP
      EXECUTE format('REVOKE ALL (%s) ON TABLE public.%I FROM %s', relation.cols, relation.relname, role_sql);
    END LOOP;
    -- Per-schema ACLs add to global defaults. Reset both scopes for owner-created relations and routines.
    FOREACH object_type IN ARRAY ARRAY['TABLES', 'SEQUENCES', 'ROUTINES'] LOOP
      EXECUTE format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON %s FROM %s', object_type, role_sql);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON %s FROM %s', object_type, role_sql);
    END LOOP;

    IF actor.key IS NOT NULL THEN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %s', current_database(), role_sql);
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %s', role_sql);
      FOR relation IN SELECT key AS name, value->>actor.key AS flags FROM jsonb_each(policy->'tables') LOOP
        SELECT string_agg(priv, ', ') INTO grants
        FROM (VALUES ('S', 'SELECT'), ('I','INSERT'), ('U','UPDATE'), ('D','DELETE')) AS p(flag, priv)
        WHERE strpos(relation.flags, flag) > 0;
        IF grants IS NOT NULL THEN
          EXECUTE format('GRANT %s ON TABLE public.%I TO %s', grants, relation.name, role_sql);
        END IF;
      END LOOP;
      FOR rule IN SELECT * FROM jsonb_array_elements(policy->'columns') AS item(value) WHERE value->>'role' = actor.key LOOP
        SELECT string_agg(quote_ident(c), ', ') INTO grants FROM jsonb_array_elements_text(rule.value->'columns') AS c;
        EXECUTE format('GRANT %s (%s) ON TABLE public.%I TO %s', rule.value->>'privilege', grants, rule.value->>'table', role_sql);
      END LOOP;
    END IF;
  END LOOP;

  IF mode = 'enforce' THEN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policy->'managed_policies' ? tablename
      AND NOT (policy->'managed_policies'->tablename ? policyname)) THEN
      RAISE EXCEPTION 'FLOFI_ACL_UNEXPECTED_ROW_POLICY';
    END IF;

    FOR routine IN SELECT jsonb_array_elements_text(policy->'purges') LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO %I', routine, runtime_role);
    END LOOP;

    -- Runtime telemetry retains its original kinds. Only the separate operator and admin web logins write admin events.
    SELECT string_agg(quote_literal(kind), ', ') INTO grants FROM jsonb_array_elements_text(policy->'runtime_audit_kinds') AS kind;
    DROP POLICY IF EXISTS flofi_runtime_audit_insert ON public.admin_audit_events;
    EXECUTE format('CREATE POLICY flofi_runtime_audit_insert ON public.admin_audit_events FOR INSERT TO %I WITH CHECK (actor = ''anonymous'' AND kind IN (%s))',
      runtime_role, grants);
    DROP POLICY IF EXISTS flofi_admin_audit_select ON public.admin_audit_events;
    EXECUTE format('CREATE POLICY flofi_admin_audit_select ON public.admin_audit_events FOR SELECT TO %I, %I, %I USING (true)',
      policy->'roles'->>'admin_web', policy->'roles'->>'admin_operations', policy->'roles'->>'finops_worker');
    DROP POLICY IF EXISTS flofi_admin_audit_insert ON public.admin_audit_events;
    EXECUTE format('CREATE POLICY flofi_admin_audit_insert ON public.admin_audit_events FOR INSERT TO %I, %I WITH CHECK (true)',
      policy->'roles'->>'admin_web', policy->'roles'->>'admin_operations');
    DROP POLICY IF EXISTS flofi_finops_audit_insert ON public.admin_audit_events;
    EXECUTE format('CREATE POLICY flofi_finops_audit_insert ON public.admin_audit_events FOR INSERT TO %I WITH CHECK (actor = ''cli'' AND kind = ''ADMIN_FINOPS_SYNC'')',
      policy->'roles'->>'finops_worker');
    ALTER TABLE public.admin_audit_events ENABLE ROW LEVEL SECURITY;

    -- Retention remains available on expired handoffs. Ordinary sessions cannot remove newer approvals through the FK cascade.
    DROP POLICY IF EXISTS flofi_handoff_read ON public.mcp_handoffs;
    EXECUTE format('CREATE POLICY flofi_handoff_read ON public.mcp_handoffs FOR SELECT TO %I, %I, %I USING (true)',
      runtime_role, policy->'roles'->>'admin_web', policy->'roles'->>'admin_operations');
    DROP POLICY IF EXISTS flofi_handoff_insert ON public.mcp_handoffs;
    EXECUTE format('CREATE POLICY flofi_handoff_insert ON public.mcp_handoffs FOR INSERT TO %I WITH CHECK (true)', runtime_role);
    DROP POLICY IF EXISTS flofi_handoff_update ON public.mcp_handoffs;
    EXECUTE format('CREATE POLICY flofi_handoff_update ON public.mcp_handoffs FOR UPDATE TO %I, %I USING (true)',
      runtime_role, policy->'roles'->>'admin_operations');
    DROP POLICY IF EXISTS flofi_handoff_retention ON public.mcp_handoffs;
    EXECUTE format('CREATE POLICY flofi_handoff_retention ON public.mcp_handoffs FOR DELETE TO %I USING (created_at < clock_timestamp() - interval ''30 days'')', runtime_role);
    ALTER TABLE public.mcp_handoffs ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS flofi_learning_read ON public.learning_candidates;
    EXECUTE format('CREATE POLICY flofi_learning_read ON public.learning_candidates FOR SELECT TO %I, %I USING (true)',
      runtime_role, policy->'roles'->>'admin_web');
    DROP POLICY IF EXISTS flofi_learning_insert ON public.learning_candidates;
    EXECUTE format('CREATE POLICY flofi_learning_insert ON public.learning_candidates FOR INSERT TO %I, %I WITH CHECK (true)',
      runtime_role, policy->'roles'->>'admin_web');
    DROP POLICY IF EXISTS flofi_learning_update ON public.learning_candidates;
    EXECUTE format('CREATE POLICY flofi_learning_update ON public.learning_candidates FOR UPDATE TO %I, %I USING (true)',
      runtime_role, policy->'roles'->>'admin_web');
    DROP POLICY IF EXISTS flofi_learning_retention ON public.learning_candidates;
    EXECUTE format('CREATE POLICY flofi_learning_retention ON public.learning_candidates FOR DELETE TO %I USING (state = ''PENDING'' AND origin = ''CONTRIBUTION'')',
      runtime_role);
    ALTER TABLE public.learning_candidates ENABLE ROW LEVEL SECURITY;
  END IF;
END
$apply$;
